// FORGE 2.0 — Enterprise Test Suite: runner contract (TESTING_BLUEPRINT.md § Runner adapters).
//
// Every module under src/testing/runners/ exports `run(input): Promise<RunnerOutcome>` in the
// same injectable, never-throws house style as Sentinel's optional checks: a missing tool/config
// in the target project is a `skipped` outcome with a reason, never a fabricated pass (T1).

/** What a runner needs to execute against the target project. */
export interface RunnerInput {
  /** The target project's root — NEVER FORGE's own directory (Contract 6). */
  projectPath: string;
  /** Progress logger (wired to the caller's log sink). */
  log: (message: string) => void;
  /** Optional timeout override (ms). Runners fall back to their own sane default. */
  timeoutMs?: number;
  /**
   * Optional target base URL for runners that hit a live server (API/E2E). When set — e.g. an
   * ephemeral Vercel preview URL, `src/deploy/ephemeral-preview.ts` — the URL-aware runners
   * (api-runner.ts, e2e-runner.ts, via vitest-shared.ts's `runVitestSuite`) export it to the
   * spawned test process as `BASE_URL` (and, for Playwright, `PLAYWRIGHT_TEST_BASE_URL`) so the
   * target project's own test config can point at it. Absent by default: every runner that does
   * not care about a target URL (UNIT, SECURITY, DEPENDENCY, ...) simply ignores this field, so
   * omitting it is a complete no-op — exactly today's behavior.
   */
  baseUrl?: string;
}

/** One failed assertion/finding, normalized across every tool's native output shape. */
export interface RunnerFailure {
  name: string;
  message: string;
  file: string;
}

/** Coverage-v8 summary (UNIT/INTEGRATION only — the sole source of test_coverage_snapshots). */
export interface CoverageSummary {
  line: number;
  branch: number;
  function: number;
  statement: number;
  linesTotal: number;
  linesCovered: number;
  filesBelowThreshold: Array<{ file: string; pct: number }>;
}

/** A runner's normalized result — maps 1:1 onto a test_run_results row (T1/T4). */
export interface RunnerOutcome {
  /** The concrete tool that produced this result (e.g. 'vitest', 'playwright', 'pnpm-audit'). */
  runner: string;
  /** 'skipped' when the tool/config is absent; 'error' when the runner itself malfunctioned. */
  status: 'passed' | 'failed' | 'skipped' | 'error';
  testsTotal: number;
  testsPassed: number;
  testsFailed: number;
  testsSkipped: number;
  durationMs: number;
  failures: RunnerFailure[];
  /** Project-relative path to the full report artifact, or null (in-process / no artifact). */
  reportPath: string | null;
  /** The underlying process exit code, or null for in-process/skipped runs. */
  exitCode: number | null;
  /** One-line human summary for the FORGE-1.0-style log line. */
  detail: string;
  /** Only set by UNIT/INTEGRATION when coverage-v8 output was produced. */
  coverage?: CoverageSummary | null;
}

/** A `skipped` outcome — the shared shape every runner uses when its tool/config is absent. */
export function skippedOutcome(runner: string, detail: string): RunnerOutcome {
  return {
    runner,
    status: 'skipped',
    testsTotal: 0,
    testsPassed: 0,
    testsFailed: 0,
    testsSkipped: 0,
    durationMs: 0,
    failures: [],
    reportPath: null,
    exitCode: null,
    detail,
    coverage: null,
  };
}

/** An `error` outcome — the runner ran but could not be evaluated (crash, unparsable output). */
export function errorOutcome(
  runner: string,
  detail: string,
  durationMs: number,
  exitCode: number | null = null
): RunnerOutcome {
  return {
    runner,
    status: 'error',
    testsTotal: 0,
    testsPassed: 0,
    testsFailed: 0,
    testsSkipped: 0,
    durationMs,
    failures: [],
    reportPath: null,
    exitCode,
    detail,
    coverage: null,
  };
}
