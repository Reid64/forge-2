// FORGE 2.0 — Enterprise Test Suite: fast-check runner (JS/TS property-based tests via Vitest).
//
// Iron Law: this runner NEVER generates new fast-check tests or properties — it only discovers
// test files ALREADY present in the target project that import 'fast-check', then delegates to the
// project's own Vitest install to execute exactly those files. It reuses vitest-shared.ts's
// `vitestInstalled` check and `parseVitestJson` parser rather than duplicating them (the only
// difference from runVitestSuite is an explicit file-list invocation in place of a full suite run —
// UNIT/INTEGRATION already own the "run everything" path, so this module must stay scoped or it
// would just be a third, redundant full-suite runner under a different name).
//
// SKIPPED heuristic: a bounded recursive scan for *.test.*/*.spec.* files whose source imports
// 'fast-check' (via `from 'fast-check'` or `require('fast-check')`). Zero matches -> SKIPPED, never
// FAIL — mirrors vitest-shared's "tool/config absent is a skip, never a fabricated pass" rule (T1).

import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { defaultShellRunner } from './exec.js';
import { errorOutcome, skippedOutcome, type RunnerInput, type RunnerOutcome } from './types.js';
import { parseVitestJson, vitestInstalled } from './vitest-shared.js';

const DEFAULT_FASTCHECK_TIMEOUT_MS = 5 * 60 * 1000;
const REPORT_FILE = '.forge/test-reports/fastcheck.json';
/** Bounds on the discovery scan and the file list handed to Vitest — protects against a
 *  pathological project (huge tree, thousands of matching files) ever hanging or producing an
 *  unrunnable command line. */
const MAX_FILES_SCANNED = 8000;
const MAX_FILES_TO_RUN = 200;

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
]);

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const FAST_CHECK_IMPORT_RE = /(from\s+['"]fast-check['"]|require\(\s*['"]fast-check['"]\s*\))/;

/** Recursively collect project-relative paths of test files that import 'fast-check'. Bounded scan
 *  (MAX_FILES_SCANNED test-file reads) so a pathological project can never hang this runner. */
async function findFastCheckTestFiles(projectPath: string): Promise<string[]> {
  const matches: string[] = [];
  let scanned = 0;

  async function walk(dir: string): Promise<void> {
    if (scanned >= MAX_FILES_SCANNED) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= MAX_FILES_SCANNED) return;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !TEST_FILE_RE.test(entry.name)) continue;
      scanned++;
      const fullPath = join(dir, entry.name);
      try {
        const content = await readFile(fullPath, 'utf8');
        if (FAST_CHECK_IMPORT_RE.test(content)) {
          matches.push(relative(projectPath, fullPath).split(sep).join('/'));
        }
      } catch {
        /* unreadable file — skip it, never fail the whole scan for one bad file */
      }
    }
  }

  await walk(projectPath);
  return matches;
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();

  const files = await findFastCheckTestFiles(input.projectPath);
  if (files.length === 0) {
    return skippedOutcome(
      'fast-check',
      "no test files import 'fast-check' — SKIP (no existing property-based tests to run, none generated)"
    );
  }

  if (!vitestInstalled(input.projectPath)) {
    return skippedOutcome('fast-check', 'vitest not installed in target project — SKIP (T1, never faked)');
  }

  const scoped = files.slice(0, MAX_FILES_TO_RUN);
  const fileArgs = scoped.map((f) => `"${f}"`).join(' ');
  const command = `pnpm exec vitest run ${fileArgs} --reporter=json --outputFile=${REPORT_FILE}`;
  input.log(`fast-check: ${scoped.length} existing test file(s) importing fast-check`);

  const result = await defaultShellRunner(command, input.projectPath, input.timeoutMs ?? DEFAULT_FASTCHECK_TIMEOUT_MS);
  const durationMs = Date.now() - started;

  let raw: string | null = null;
  try {
    raw = await readFile(join(input.projectPath, REPORT_FILE), 'utf8');
  } catch {
    raw = null;
  }

  if (raw === null) {
    return errorOutcome(
      'fast-check',
      result.timedOut
        ? 'vitest run (fast-check scope) timed out'
        : `vitest produced no JSON report for the fast-check scope (${(result.stderr || result.stdout).trim().slice(0, 200)})`,
      durationMs,
      result.exitCode
    );
  }

  const parsed = parseVitestJson(raw);
  if (parsed === null) {
    return errorOutcome('fast-check', 'vitest JSON report (fast-check scope) was unparsable', durationMs, result.exitCode);
  }

  const status: RunnerOutcome['status'] = parsed.failed > 0 ? 'failed' : parsed.total > 0 ? 'passed' : 'skipped';
  const detail =
    status === 'passed'
      ? `${parsed.passed}/${parsed.total} fast-check test(s) passed across ${scoped.length} file(s)`
      : status === 'failed'
        ? `${parsed.failed}/${parsed.total} fast-check test(s) failed across ${scoped.length} file(s)`
        : 'vitest ran with zero tests collected across the fast-check scope';

  return {
    runner: 'fast-check',
    status,
    testsTotal: parsed.total,
    testsPassed: parsed.passed,
    testsFailed: parsed.failed,
    testsSkipped: parsed.skipped,
    durationMs,
    failures: parsed.failures,
    reportPath: REPORT_FILE,
    exitCode: result.exitCode,
    detail,
    coverage: null,
  };
}
