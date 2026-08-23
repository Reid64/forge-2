// FORGE 2.0 — Enterprise Test Suite: flaky-test detection.
//
// NOT a `RunnerType`/`TestSuiteDb`-registered runner (see the reasoning block below the exports) —
// it is a pure analysis utility that flags PASS/FAIL inconsistency, i.e. individual test names
// whose failed/not-failed membership flips across a sequence of runs that are known (by
// construction, not inference) to share the same code — "no code change in between" (TASK BRIEF).
//
// DATA AVAILABILITY (grounds every design decision below — T1: never invent data this schema
// doesn't actually carry):
//   `test_run_results` (src/memory/test-results.ts) stores, per run, only AGGREGATE counts
//   (tests_total/passed/failed/skipped) plus `failure_summary`: the NAMES of the tests that FAILED
//   in that run (capped at 20 — persist.ts's `capFailureSummary`). It does NOT store the names of
//   tests that PASSED. That means per-INDIVIDUAL-test flake detection is only possible by treating
//   "named in this run's failure_summary" as the one fact we know for certain, and "same test
//   suite/runner, not named as failed" as the inferred-passed complement — which is only a safe
//   inference when we also know the same set of tests actually ran both times (true within one
//   project+suite+runner in the common case; not a schema-enforced guarantee). This module states
//   that assumption plainly rather than quietly relying on it.
//
// TWO INPUT MODES, matching the task brief's own (a)/(b) split:
//   (a) `detectFlakyTests(runs)` — the PURE, primary function. Given >=2 runs of THE SAME suite that
//       the CALLER guarantees involved no code change in between (e.g. the same suite executed N
//       times back-to-back in one process, or N historical rows sharing one `build_run_id` — one
//       build_run_id is this schema's own "same code snapshot" boundary), returns every test name
//       whose failed-membership is not constant across the sequence. No I/O, no Build Memory
//       dependency, trivially unit-testable.
//   (b) `detectFlakyTestsFromHistory(projectName, testSuite, opts)` — a convenience async wrapper
//       around (a) that fetches history via the ONE new Build Memory read function this task added
//       (`listTestRunResultHistory` in src/memory/test-results.ts — reusing rather than duplicating
//       `listLatestTestRunResults`'s existing query style), optionally narrowed to rows sharing one
//       `build_run_id` for the "no code change" guarantee, and feeds the mapped rows into (a).
//
// WHY THIS IS NOT A `RunnerType`/`TestSuiteDb` ENTRY (explicit design choice, per the task brief's
// own invitation to use judgment here):
//   Every existing `RunnerType` represents "invoke one external tool/probe against the target
//   project, normalize its result into exactly one `RunnerOutcome`, persist exactly one
//   `test_run_results` row" (orchestrator.ts's dispatch loop, persist.ts's 1:1 TEST_SUITE_DB map).
//   `detectFlakyTests` does not fit that shape on any axis: it does not invoke an external tool, it
//   does not probe the target project at all, and its natural output is a LIST of findings ACROSS
//   already-persisted runs, not a single pass/fail verdict for one run. Forcing it into the
//   RunnerType enum would mean either (a) it always requires a fresh probe to have "a runner to
//   register", which it doesn't need, or (b) it writes a synthetic `test_run_results` row that
//   doesn't represent a real test execution, which would violate T1 (never fabricate a run). It is
//   instead exported as a standalone utility other code can call directly — a future CLI command
//   (`forge test flaky-report`), or a dead-loop/regression-detection system — without forcing a
//   schema/tier-gating shape that doesn't describe what it does.

import { listTestRunResultHistory, type TestRunResultRow, type TestSuiteDb } from '../../memory/test-results.js';

/** One run's contribution to a flaky-test analysis: which tests (by name) failed in this run.
 *  `label` is a caller-supplied identifier for the run (a run id, an index, a timestamp — purely
 *  for reporting, never interpreted). Runs with `status` outside `'passed'`/`'failed'` (i.e.
 *  `'skipped'`/`'error'`/`'running'`) are excluded by the caller-facing wrappers below because
 *  neither state supports the "did each named test actually pass or fail" inference this module
 *  relies on. */
export interface FlakyCheckRun {
  label: string;
  failedTestNames: string[];
}

export interface FlakyTestFinding {
  testName: string;
  /** Number of adjacent runs (in the order given) where this test's failed/not-failed state
   *  differs from the previous run — >=1 means "flipped at least once across this run sequence". */
  flipCount: number;
  /** Per-run failed/not-failed state, in the same order `runs` was given, for reporting. */
  history: Array<{ label: string; failed: boolean }>;
}

/** PURE — mode (a). `runs` must already be known (by the caller) to share the same code, e.g.
 *  repeated back-to-back executions of the same suite, or rows sharing one `build_run_id`. Flags
 *  every test name that appears as failed in at least one run and NOT failed in at least one other
 *  run within the given sequence (see the module doc comment for the "absence = inferred pass"
 *  assumption this relies on). Returns findings sorted by flip count, descending. */
export function detectFlakyTests(runs: FlakyCheckRun[]): FlakyTestFinding[] {
  if (runs.length < 2) return [];

  const allNames = new Set<string>();
  for (const run of runs) {
    for (const name of run.failedTestNames) allNames.add(name);
  }

  const findings: FlakyTestFinding[] = [];
  for (const testName of allNames) {
    const history = runs.map((run) => ({ label: run.label, failed: run.failedTestNames.includes(testName) }));
    let flipCount = 0;
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];
      if (prev && curr && prev.failed !== curr.failed) flipCount++;
    }
    if (flipCount > 0) findings.push({ testName, flipCount, history });
  }

  return findings.sort((a, b) => b.flipCount - a.flipCount);
}

export interface FlakyHistoryOptions {
  /** Narrow history to rows sharing this exact `build_run_id` — the one schema-native guarantee
   *  of "same code snapshot" (T1: without this, "no code change in between" is a best-effort
   *  assumption, not a fact the schema enforces, and the finding detail says so). */
  buildRunId?: string | null;
  /** How many recent rows to fetch before filtering (default 20 — `listTestRunResultHistory`'s
   *  own default). */
  limit?: number;
}

export interface FlakyHistoryResult {
  findings: FlakyTestFinding[];
  runsConsidered: number;
  /** True when `buildRunId` was supplied and honored — findings are backed by the schema's own
   *  same-code-snapshot guarantee. False means the "no code change in between" property is only a
   *  best-effort assumption over recent history for this project+suite. */
  sameCodeSnapshotGuaranteed: boolean;
}

/** Mode (b) — convenience async wrapper around `detectFlakyTests` sourced from Build Memory. Reuses
 *  `listTestRunResultHistory` (the one new read function this task added) rather than inventing a
 *  second query path. Returns null when Build Memory is unreachable (degrades honestly, same
 *  convention as every `src/memory/*.ts` read — never fabricates a finding). */
export async function detectFlakyTestsFromHistory(
  projectName: string,
  testSuite: TestSuiteDb,
  opts: FlakyHistoryOptions = {}
): Promise<FlakyHistoryResult | null> {
  const rows = await listTestRunResultHistory(projectName, testSuite, opts.limit ?? 20);
  if (rows === null) return null;

  const scoped: TestRunResultRow[] = opts.buildRunId
    ? rows.filter((r) => r.build_run_id === opts.buildRunId)
    : rows;

  const comparable = scoped.filter((r) => r.status === 'passed' || r.status === 'failed');
  const runs: FlakyCheckRun[] = comparable.map((r) => ({
    label: r.id || r.created_at,
    failedTestNames: (r.failure_summary ?? []).map((f) => f.name),
  }));

  return {
    findings: detectFlakyTests(runs),
    runsConsidered: runs.length,
    sameCodeSnapshotGuaranteed: Boolean(opts.buildRunId),
  };
}
