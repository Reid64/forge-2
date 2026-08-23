// FORGE 2.0 — Enterprise Test Suite: shared Vitest invocation + normalization.
//
// UNIT, INTEGRATION, and API all drive the same tool (Vitest's JSON reporter — TESTING_BLUEPRINT.md
// §§1-3) with only the config file / coverage flag differing, so the spawn + parse logic lives
// here once. Pure parsers (`parseVitestJson`/`parseCoverageSummary`) are exported for unit testing.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { defaultShellRunner, firstLine, type ShellRunner } from './exec.js';
import { errorOutcome, skippedOutcome, type CoverageSummary, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

const DEFAULT_VITEST_TIMEOUT_MS = 5 * 60 * 1000;
const COVERAGE_FILE_THRESHOLD_PCT = 80;
const MAX_FILES_BELOW_THRESHOLD = 20;

interface VitestAssertionResult {
  status?: string;
  title?: string;
  fullName?: string;
  failureMessages?: string[];
}

interface VitestTestFileResult {
  name?: string;
  assertionResults?: VitestAssertionResult[];
}

interface VitestJsonReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  testResults?: VitestTestFileResult[];
}

export interface ParsedVitestReport {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: RunnerFailure[];
}

/** Pure: Vitest's `--reporter=json` output → normalized counts + failures. Never throws. */
export function parseVitestJson(raw: string): ParsedVitestReport | null {
  try {
    const data = JSON.parse(raw) as VitestJsonReport;
    const failures: RunnerFailure[] = [];
    for (const file of data.testResults ?? []) {
      for (const assertion of file.assertionResults ?? []) {
        if (assertion.status === 'failed') {
          failures.push({
            name: assertion.fullName ?? assertion.title ?? 'unnamed test',
            message: (assertion.failureMessages ?? []).join('\n').slice(0, 500),
            file: file.name ?? '',
          });
        }
      }
    }
    return {
      total: data.numTotalTests ?? 0,
      passed: data.numPassedTests ?? 0,
      failed: data.numFailedTests ?? 0,
      skipped: data.numPendingTests ?? 0,
      failures,
    };
  } catch {
    return null;
  }
}

/** Pure: `@vitest/coverage-v8`'s `coverage-summary.json` → the four coverage-type percentages. */
export function parseCoverageSummary(raw: string): CoverageSummary | null {
  try {
    const data = JSON.parse(raw) as Record<string, { lines?: { pct?: number; total?: number; covered?: number }; branches?: { pct?: number }; functions?: { pct?: number }; statements?: { pct?: number } }>;
    const total = data['total'];
    if (!total) return null;
    const filesBelowThreshold: Array<{ file: string; pct: number }> = [];
    for (const [file, entry] of Object.entries(data)) {
      if (file === 'total') continue;
      const pct = entry.lines?.pct;
      if (typeof pct === 'number' && pct < COVERAGE_FILE_THRESHOLD_PCT) {
        filesBelowThreshold.push({ file, pct });
      }
    }
    return {
      line: total.lines?.pct ?? 0,
      branch: total.branches?.pct ?? 0,
      function: total.functions?.pct ?? 0,
      statement: total.statements?.pct ?? 0,
      linesTotal: total.lines?.total ?? 0,
      linesCovered: total.lines?.covered ?? 0,
      filesBelowThreshold: filesBelowThreshold.slice(0, MAX_FILES_BELOW_THRESHOLD),
    };
  } catch {
    return null;
  }
}

export interface RunVitestOptions {
  /** Project-relative config file (e.g. `vitest.integration.config.ts`). Omit for the default config. */
  configFile?: string;
  /** Project-relative path Vitest's JSON reporter writes to (`.forge/test-reports/<suite>.json`). */
  reportFile: string;
  /** Whether to pass `--coverage` and read `coverage-summary.json` afterward. */
  coverage?: boolean;
  /** OPT-IN, DEFAULT UNSET (= deterministic/default order — no behavior change for normal callers).
   *  When set, passes Vitest's own `--sequence.shuffle` flag plus `--sequence.seed=<n>` so a caller
   *  (test-order-detector.ts) can run the same suite multiple times in a different, but
   *  reproducible, order. Every existing call site (unit-runner.ts/integration-runner.ts/
   *  api-runner.ts) omits this — this option exists solely for test-order-detector.ts's opt-in mode. */
  sequenceShuffleSeed?: number;
  runner?: ShellRunner;
  timeoutMs?: number;
}

/** Detect whether Vitest is a resolvable dependency of the TARGET project (never FORGE's own).
 *  Exported for reuse by fastcheck-runner.ts, which needs the same check but drives its own
 *  file-scoped Vitest invocation rather than `runVitestSuite`'s full-suite one. */
export function vitestInstalled(projectPath: string): boolean {
  const bin = join(projectPath, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
  return existsSync(bin) || existsSync(join(projectPath, 'node_modules', 'vitest'));
}

/** Spawn Vitest against `input.projectPath`, then normalize its JSON (+ coverage) output. */
export async function runVitestSuite(input: RunnerInput, opts: RunVitestOptions): Promise<RunnerOutcome> {
  const started = Date.now();
  const run = opts.runner ?? defaultShellRunner;

  if (!vitestInstalled(input.projectPath)) {
    return skippedOutcome('vitest', 'vitest not installed in target project — SKIP (T1, never faked)');
  }
  if (opts.configFile && !existsSync(join(input.projectPath, opts.configFile))) {
    return skippedOutcome('vitest', `${opts.configFile} not found in target project — SKIP`);
  }

  const configArg = opts.configFile ? ` --config ${opts.configFile}` : '';
  const coverageArg = opts.coverage ? ' --coverage' : '';
  const shuffleArg =
    typeof opts.sequenceShuffleSeed === 'number' ? ` --sequence.shuffle --sequence.seed=${opts.sequenceShuffleSeed}` : '';
  const command = `pnpm exec vitest run${configArg}${coverageArg}${shuffleArg} --reporter=json --outputFile=${opts.reportFile}`;
  input.log(`vitest: ${command}`);

  const result = await run(command, input.projectPath, opts.timeoutMs ?? input.timeoutMs ?? DEFAULT_VITEST_TIMEOUT_MS);
  const durationMs = Date.now() - started;

  let raw: string | null = null;
  try {
    raw = await readFile(join(input.projectPath, opts.reportFile), 'utf8');
  } catch {
    raw = null;
  }

  if (raw === null) {
    return errorOutcome(
      'vitest',
      result.timedOut ? 'vitest run timed out' : `vitest produced no JSON report (${firstLine(result.stderr || result.stdout)})`,
      durationMs,
      result.exitCode
    );
  }

  const parsed = parseVitestJson(raw);
  if (parsed === null) {
    return errorOutcome('vitest', 'vitest JSON report was unparsable', durationMs, result.exitCode);
  }

  let coverage: CoverageSummary | null = null;
  if (opts.coverage) {
    try {
      const covRaw = await readFile(
        join(input.projectPath, '.forge', 'test-reports', 'coverage', 'coverage-summary.json'),
        'utf8'
      );
      coverage = parseCoverageSummary(covRaw);
    } catch {
      coverage = null;
    }
  }

  const status: RunnerOutcome['status'] = parsed.failed > 0 ? 'failed' : parsed.total > 0 ? 'passed' : 'skipped';
  const detail =
    status === 'passed'
      ? `${parsed.passed}/${parsed.total} tests passed`
      : status === 'failed'
        ? `${parsed.failed}/${parsed.total} tests failed`
        : 'vitest ran with zero tests collected';

  return {
    runner: 'vitest',
    status,
    testsTotal: parsed.total,
    testsPassed: parsed.passed,
    testsFailed: parsed.failed,
    testsSkipped: parsed.skipped,
    durationMs,
    failures: parsed.failures,
    reportPath: opts.reportFile,
    exitCode: result.exitCode,
    detail,
    coverage,
  };
}
