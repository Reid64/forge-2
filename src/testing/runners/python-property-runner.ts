// FORGE 2.0 — Enterprise Test Suite: Python property-based testing runner (pytest + Hypothesis).
//
// Follows iac-runner.ts's exact "own CLI invocation + own output parsing" pattern (no equivalent
// Ring-3 Sentinel check to reuse from). Unlike iac-runner — which leans entirely on checkov's own
// `resource_count` to decide applicability — pytest has no single built-in "is this even a Python
// project" signal, so applicability is decided the way the task brief prescribes: a cheap check for
// pytest configuration (pytest.ini / setup.cfg [tool:pytest] / pyproject.toml
// [tool.pytest.ini_options]), falling back to a bounded recursive scan for any `*.py` file (which
// also covers a plain `tests/*.py` layout pytest auto-discovers with no config at all). pytest's own
// "no tests collected" signal (exit code 5) is kept as a defensive second SKIP path, mirroring
// iac-runner's "trust the tool's own detection" philosophy as a backstop rather than the primary
// gate — a project can satisfy the file/config heuristic yet still legitimately collect zero tests.
//
// This runner does not pre-filter to files that `import hypothesis` (unlike fastcheck-runner.ts's
// deliberately narrow scoping): the task asks it to run "against any Python test files in the
// project", i.e. it is this project's pytest runner in general, with Hypothesis available as a
// dependency for whichever of those tests use it. If pytest collects tests that import an
// uninstalled `hypothesis`, that surfaces as a SKIP (see notInstalled handling below), never a
// fabricated pass (T1).

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { defaultShellRunner, firstLine } from './exec.js';
import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

const DEFAULT_PYTEST_TIMEOUT_MS = 5 * 60 * 1000;
const REPORT_FILE = '.forge/test-reports/python-property.xml';
const MAX_FILES_SCANNED = 4000;
const MAX_FAILURES = 20;

const CONFIG_FILES = ['pytest.ini', 'setup.cfg', 'pyproject.toml', 'tox.ini'];
const PYTEST_CONFIG_SECTION_RE = /\[tool:pytest\]|\[pytest\]|\[tool\.pytest\.ini_options\]/;

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.forge',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
]);

/** pytest.ini / setup.cfg / pyproject.toml / tox.ini carrying a recognized pytest config section. */
async function hasPytestConfig(projectPath: string): Promise<boolean> {
  for (const name of CONFIG_FILES) {
    const path = join(projectPath, name);
    if (!existsSync(path)) continue;
    try {
      const content = await readFile(path, 'utf8');
      if (PYTEST_CONFIG_SECTION_RE.test(content)) return true;
    } catch {
      /* unreadable — treat as absent, fall through to the file-based scan */
    }
  }
  return false;
}

/** Bounded recursive scan (MAX_FILES_SCANNED files visited) for any `*.py` file — covers a
 *  `tests/*.py` layout with no explicit pytest config. */
async function anyPythonFileExists(projectPath: string): Promise<boolean> {
  let scanned = 0;

  async function walk(dir: string): Promise<boolean> {
    if (scanned >= MAX_FILES_SCANNED) return false;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (scanned >= MAX_FILES_SCANNED) return false;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (await walk(join(dir, entry.name))) return true;
        continue;
      }
      if (entry.isFile()) {
        scanned++;
        if (entry.name.endsWith('.py')) return true;
      }
    }
    return false;
  }

  return walk(projectPath);
}

async function hasPythonTestSurface(projectPath: string): Promise<boolean> {
  if (await hasPytestConfig(projectPath)) return true;
  return anyPythonFileExists(projectPath);
}

interface JUnitTotals {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
}

function extractIntAttr(tag: string, name: string): number {
  const m = new RegExp(`\\b${name}="([0-9]+)"`).exec(tag);
  return m ? parseInt(m[1] ?? '0', 10) : 0;
}

/** pytest emits one or more `<testsuite ...>` elements (optionally wrapped in `<testsuites>`) — sum
 *  their `tests`/`failures`/`errors`/`skipped` attributes across all of them. */
function parseJUnitTotals(xml: string): JUnitTotals | null {
  const tagMatches = xml.match(/<testsuite\b[^>]*>/g);
  if (!tagMatches || tagMatches.length === 0) return null;
  const totals: JUnitTotals = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const tag of tagMatches) {
    totals.tests += extractIntAttr(tag, 'tests');
    totals.failures += extractIntAttr(tag, 'failures');
    totals.errors += extractIntAttr(tag, 'errors');
    totals.skipped += extractIntAttr(tag, 'skipped');
  }
  return totals;
}

/** Walk every `<testcase>` element and surface the ones carrying a `<failure>`/`<error>` child,
 *  capped at MAX_FAILURES (same cap style as every other runner's failures list). */
function parseJUnitFailures(xml: string): RunnerFailure[] {
  const failures: RunnerFailure[] = [];
  const testcaseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = testcaseRe.exec(xml)) && failures.length < MAX_FAILURES) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    if (!/<failure\b|<error\b/.test(body)) continue;
    const nameMatch = /\bname="([^"]*)"/.exec(attrs);
    const classnameMatch = /\bclassname="([^"]*)"/.exec(attrs);
    const messageMatch = /<(?:failure|error)\b[^>]*\bmessage="([^"]*)"/.exec(body);
    failures.push({
      name: nameMatch?.[1] ?? 'unnamed test',
      message: (messageMatch?.[1] ?? 'pytest failure').slice(0, 500),
      file: classnameMatch?.[1] ?? '',
    });
  }
  return failures;
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();

  if (!(await hasPythonTestSurface(input.projectPath))) {
    return skippedOutcome('pytest', 'no Python files or pytest configuration found in project — SKIP');
  }

  const pythonExe = process.platform === 'win32' ? 'python' : 'python3';
  const command = `${pythonExe} -m pytest -q --junitxml=${REPORT_FILE}`;
  input.log(`pytest (hypothesis): ${command}`);
  const result = await defaultShellRunner(command, input.projectPath, input.timeoutMs ?? DEFAULT_PYTEST_TIMEOUT_MS);
  const durationMs = Date.now() - started;

  const combined = [result.stdout, result.stderr].filter((s) => s.trim() !== '').join('\n');
  const notInstalled = /not recognized|command not found|No module named ['"]?pytest|ENOENT/i.test(combined);
  if (notInstalled) {
    return skippedOutcome('pytest', 'pytest not installed in the target Python environment — SKIP (T1, never faked)');
  }
  if (/No module named ['"]?hypothesis/i.test(combined)) {
    return skippedOutcome('pytest', 'hypothesis not installed in the target Python environment — SKIP');
  }
  if (result.exitCode === 5) {
    return skippedOutcome('pytest', 'pytest collected zero tests — SKIP');
  }

  let raw: string | null = null;
  try {
    raw = await readFile(join(input.projectPath, REPORT_FILE), 'utf8');
  } catch {
    raw = null;
  }
  if (raw === null) {
    return errorOutcome(
      'pytest',
      result.timedOut ? 'pytest run timed out' : `pytest produced no JUnit XML report (${firstLine(combined)})`,
      durationMs,
      result.exitCode
    );
  }

  const totals = parseJUnitTotals(raw);
  if (totals === null) {
    return errorOutcome('pytest', 'pytest JUnit XML report was unparsable', durationMs, result.exitCode);
  }

  const failed = totals.failures + totals.errors;
  const passed = Math.max(totals.tests - failed - totals.skipped, 0);
  const status: RunnerOutcome['status'] = failed > 0 ? 'failed' : totals.tests > 0 ? 'passed' : 'skipped';
  const detail =
    status === 'passed'
      ? `${passed}/${totals.tests} pytest test(s) passed`
      : status === 'failed'
        ? `${failed}/${totals.tests} pytest test(s) failed`
        : 'pytest ran with zero tests collected';

  return {
    runner: 'pytest-hypothesis',
    status,
    testsTotal: totals.tests,
    testsPassed: passed,
    testsFailed: failed,
    testsSkipped: totals.skipped,
    durationMs,
    failures: parseJUnitFailures(raw),
    reportPath: REPORT_FILE,
    exitCode: result.exitCode,
    detail,
    coverage: null,
  };
}
