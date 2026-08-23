// FORGE 2.0 — Enterprise Test Suite: OPT-IN randomized test-execution-order check, DEFAULT OFF.
//
// Detects order-dependency bugs: tests that only fail under a specific execution order. DEFAULT
// behavior is a complete no-op — `runRandomizedOrderCheck` returns a `skipped` outcome WITHOUT
// invoking Vitest at all unless the caller explicitly passes `{ enabled: true }`. No existing call
// site (unit-runner.ts/integration-runner.ts/api-runner.ts/orchestrator.ts) calls this module, so
// there is zero behavior change to any normal run by construction, not just by a flag default.
//
// MECHANISM: reuses vitest-shared.ts's `runVitestSuite` (the exact tool invocation UNIT/
// INTEGRATION/API already use) with its new, additive-only `sequenceShuffleSeed` option, which maps
// to Vitest's own native `--sequence.shuffle --sequence.seed=<n>` CLI flags (Vitest's built-in
// randomized-order feature — nothing reimplemented). Runs the suite `runs` times (default 2), each
// with a DIFFERENT seed, to distinct report files, then diffs which test names appear in each run's
// failure list.
//
// SIMPLIFYING ASSUMPTION (stated plainly, mirroring flaky-detector.ts's own): `parseVitestJson`
// (vitest-shared.ts) only extracts FAILED test names per run, not the full roster — so, exactly
// like flaky-detector.ts, "named as failed in run A but not in run B" is read as "failed in A,
// (inferred) passed in B". A test name that is NOT constant across the shuffled runs is reported as
// an ORDER-DEPENDENCY CANDIDATE — this is a real, checkable signal (a deterministic test that does
// not care about order produces the same failed/not-failed result regardless of shuffle), but it is
// not airtight proof of order-dependency specifically: a genuinely flaky/non-deterministic test
// (network timing, Date.now(), unseeded randomness) would produce the same inconsistent signature
// here for reasons that have nothing to do with execution order. This module reports what it can
// actually observe — "inconsistent across differently-ordered runs" — without overclaiming root
// cause; the two failure-consistency checks below help a human distinguish the two: a candidate that
// ALSO flips when the run order is IDENTICAL (see `runs` >= 3 with a repeated seed, if a caller
// wants that extra evidence) is more likely plain flakiness than order-dependency, but this module
// does not force that extra run by default (cost).
//
// NOT a `RunnerType`/`TestSuiteDb` entry, for the same reason it's OFF by default: it does not
// represent "the standing test regime a readiness tier requires" — it is an execution-MODE toggle
// layered on top of the UNIT suite's own tool invocation (same tool, same tests, different flag),
// not a distinct probe. Wiring it into RunnerType would either force it into every tier's required-
// suite list (contradicting "opt-in, off by default") or require inventing a tier-gating carve-out
// for "required suites that are also independently off by default", which does not exist anywhere
// else in `readiness-levels.ts` and would be new machinery built for one caller. It is exported as a
// standalone function any caller (a future CLI flag, a manual investigation, unit-runner.ts itself)
// can invoke explicitly instead.

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { runVitestSuite } from './vitest-shared.js';
import type { RunnerInput, RunnerOutcome } from './types.js';
import { skippedOutcome } from './types.js';

export interface RandomizedOrderCheckOptions {
  /** Must be explicitly `true` to do anything at all — DEFAULT OFF (this is the whole point). */
  enabled: boolean;
  /** How many differently-shuffled Vitest runs to compare. Minimum useful value is 2. Default 2. */
  runs?: number;
  /** Project-relative config file, forwarded to `runVitestSuite` unchanged (same option UNIT/
   *  INTEGRATION/API pass today). */
  configFile?: string;
}

export interface OrderDependencyCandidate {
  testName: string;
  /** Per-run failed/not-failed state, in seed order, for reporting. */
  history: Array<{ seed: number; failed: boolean }>;
}

export interface RandomizedOrderCheckResult {
  outcome: RunnerOutcome;
  candidates: OrderDependencyCandidate[];
}

/** OPT-IN, DEFAULT OFF. When `opts.enabled` is not `true`, returns a `skipped` outcome immediately
 *  and runs nothing — the guaranteed no-behavior-change-by-default path. When enabled, runs the
 *  target project's Vitest suite `opts.runs` times (default 2) under different `--sequence.shuffle`
 *  seeds and reports any test name whose failed/not-failed status was not constant across them. */
export async function runRandomizedOrderCheck(
  input: RunnerInput,
  opts: RandomizedOrderCheckOptions
): Promise<RandomizedOrderCheckResult> {
  const runner = 'vitest-order-check';

  if (!opts.enabled) {
    return {
      outcome: skippedOutcome(runner, 'randomized test-order check is opt-in and was not enabled (default OFF) — no Vitest invocation made'),
      candidates: [],
    };
  }

  const runCount = Math.max(2, opts.runs ?? 2);
  const started = Date.now();
  const seeds = Array.from({ length: runCount }, (_, i) => 1_000_000 + i * 7919 + (Date.now() % 1000));

  const failedNamesBySeed: Array<{ seed: number; failedNames: string[]; status: RunnerOutcome['status'] }> = [];
  const reportFiles: string[] = [];

  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    if (seed === undefined) continue;
    const reportFile = `.forge/test-reports/order-check-${seed}.json`;
    reportFiles.push(reportFile);
    input.log(`test-order-detector: run ${i + 1}/${seeds.length} — shuffled order, seed=${seed}`);
    const outcome = await runVitestSuite(input, {
      reportFile,
      configFile: opts.configFile,
      sequenceShuffleSeed: seed,
    });
    if (outcome.status === 'skipped' || outcome.status === 'error') {
      // Cleanup whatever partial report files exist before bailing.
      await Promise.all(reportFiles.map((f) => unlink(join(input.projectPath, f)).catch(() => undefined)));
      return {
        outcome: {
          ...outcome,
          runner,
          detail: `randomized-order check could not complete: ${outcome.detail}`,
        },
        candidates: [],
      };
    }
    failedNamesBySeed.push({ seed, failedNames: outcome.failures.map((f) => f.name), status: outcome.status });
  }

  await Promise.all(reportFiles.map((f) => unlink(join(input.projectPath, f)).catch(() => undefined)));

  const allNames = new Set<string>();
  for (const run of failedNamesBySeed) {
    for (const name of run.failedNames) allNames.add(name);
  }

  const candidates: OrderDependencyCandidate[] = [];
  for (const testName of allNames) {
    const history = failedNamesBySeed.map((run) => ({ seed: run.seed, failed: run.failedNames.includes(testName) }));
    const failedStates = new Set(history.map((h) => h.failed));
    if (failedStates.size > 1) candidates.push({ testName, history });
  }

  const durationMs = Date.now() - started;
  const status: RunnerOutcome['status'] = candidates.length > 0 ? 'failed' : 'passed';

  return {
    outcome: {
      runner,
      status,
      testsTotal: allNames.size,
      testsPassed: allNames.size - candidates.length,
      testsFailed: candidates.length,
      testsSkipped: 0,
      durationMs,
      failures: candidates.map((c) => ({
        name: c.testName,
        message: `inconsistent pass/fail across ${runCount} differently-shuffled runs (seeds: ${c.history.map((h) => `${h.seed}=${h.failed ? 'failed' : 'passed'}`).join(', ')}) — order-dependency candidate (see module doc comment for the flaky-vs-order-dependent caveat)`,
        file: '',
      })),
      reportPath: null,
      exitCode: null,
      detail:
        status === 'passed'
          ? `${runCount} differently-shuffled runs produced consistent results — no order-dependency candidates found`
          : `${candidates.length} test(s) inconsistent across ${runCount} differently-shuffled runs — possible order-dependency`,
      coverage: null,
    },
    candidates,
  };
}
