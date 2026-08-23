/**
 * FORGE 2.0 — Learning Engine: Shadow Mode.
 *
 * See `upgrades/ENGINEERING_COMPLETENESS.md` §33 "Self-improvement evaluation harness" and §34
 * "Shadow mode". Before `EvolutionPromoter` (`src/learning/evolution-promoter.ts`) auto-promotes a
 * `pending_evolutions` row past its `PROMOTION_THRESHOLD` (0.90) confidence bar, this module runs
 * that row's proposed change ("candidate strategy") and production as it stands today ("existing
 * strategy") against the Task 16 self-benchmark suite (`benchmarks/benchmark-runner.ts`,
 * `runBenchmarkSuite`) WITHOUT letting either run touch production work, and reports whether the
 * candidate strictly outperforms the existing strategy with no completion-rate regression on any
 * scenario. §33: "Only promote the new strategy if it measurably performs better" — never let
 * FORGE conclude "I improved myself" on faith.
 *
 * WHAT "STRATEGY" MEANS HERE
 * ---------------------------------------------------------------------------------------------
 * `evolution-promoter.ts`'s only promotable unit is a `pending_evolutions` row: an
 * `evolution_type` (`'RULE' | 'THRESHOLD' | 'CONFIG' | 'TEMPLATE' | 'HOOK'`, `'GATE'` excluded —
 * never auto-promotable) plus a `change_detail` JSON payload, whose real activation is applied by
 * that file's `applyEffect` (a `governance_rules` row / a `forge_meta` key / a
 * `governance_versions` row, depending on type). That IS the "routing config / model-selection
 * strategy / prompt-generation strategy" this task's brief gestures at — no separate strategy
 * abstraction exists anywhere else in this codebase, so shadow-mode reuses this one rather than
 * inventing a new concept. "Candidate strategy" = a `pending_evolutions` row's proposed change;
 * "existing strategy" = production as it stands today, before that change is applied.
 *
 * HOW THIS REUSES `runBenchmarkSuite` WITHOUT BREAKING THE BUILD (TS6059)
 * ---------------------------------------------------------------------------------------------
 * `benchmarks/benchmark-runner.ts` lives OUTSIDE `src/` on purpose (disposable fixtures + manifest
 * belong beside it, not shipped in `dist/`) — `tsconfig.json`'s `rootDir` is `src/` and its
 * `include` is `src/**\/*.ts` only, so a static import of it (even `import type`) from anywhere
 * under `src/` pulls a file outside `rootDir` into the program and breaks `pnpm run build`
 * (TS6059: "File is not under 'rootDir'"). `forge benchmark` (`src/cli/index.ts`'s `cmdBenchmark`)
 * already solved this by spawning `node --import tsx benchmarks/benchmark-runner.ts --out <tmp>`
 * as a child process and parsing its JSON output against a locally-mirrored type (not a shared
 * import). This module does the exact same thing (`spawnBenchmarkSuite` below) — that IS "reusing
 * `runBenchmarkSuite` directly, not reimplementing scenario execution": the child process runs the
 * real function; nothing about scenario/fixture execution is reimplemented here.
 *
 * WHY THE TWO BENCHMARK RUNS CAN COME BACK IDENTICAL TODAY (a documented, deliberate limitation)
 * ---------------------------------------------------------------------------------------------
 * `runBenchmarkSuite` is, by its own module doc's design, fully deterministic and self-contained:
 * it stubs `runClaudeImpl`/`runSentinelImpl`/`assembleImpl`/`predictImpl` and hardcodes
 * `loadGovernanceDocs: async () => ({})`, so nothing about a scenario run currently reads
 * `governance_rules`, `forge_meta`, or any other table `applyEffect` writes to. Until a future
 * benchmark scenario or `Phase3Executor` collaborator is wired to actually consume one of those
 * tables, an "existing" run and a "candidate" run of the SAME deterministic suite will produce
 * numerically identical results for every `evolution_type` — which, under the strict-
 * outperformance rule below, is correctly scored as a TIE, not a win, and therefore BLOCKS
 * auto-promotion. That is the intended conservative failure mode, not a bug: no proof of
 * improvement available yet ⇒ no auto-promotion, full stop (§33/§35 — "never allow live
 * self-modification directly into the production orchestration layer" without measured proof).
 * A human can still promote such a candidate explicitly via `forge agent approve`
 * (`approveEvolution` in `evolution-promoter.ts`), which this gate does not touch.
 * Production callers get real signal the moment a benchmark scenario is wired to read the tables
 * `applyEffect` writes; until then, {@link ShadowModeOptions.runBenchmarkSuiteImpl} lets any
 * caller (every unit test in `tests/evolution-promoter.test.ts` included) inject two
 * distinguishable results directly, bypassing the spawn, to exercise both branches of the gate.
 *
 * STRICT-OUTPERFORMANCE DEFINITION (exact rule enforced by {@link candidateStrictlyOutperforms})
 * ---------------------------------------------------------------------------------------------
 * Given `existing` and `candidate` benchmark suite results over the SAME scenario set:
 *   1. NO PER-SCENARIO COMPLETION-RATE REGRESSION: for every scenario present in both runs,
 *      `candidate.completionRate >= existing.completionRate`. Checked scenario-by-scenario, not
 *      just on the suite mean — a candidate that improves the mean by winning big on one scenario
 *      while quietly regressing another is REJECTED. A scenario missing from either run also fails
 *      this check (can't prove no regression on data that doesn't exist).
 *   2. NO OVERALL METRIC REGRESSES: across the suite totals, none of the four §33 metrics this
 *      harness scores may move in the WORSE direction for the candidate:
 *        - meanCompletionRate: candidate must be >= existing (higher is better)
 *        - meanDefectRate:      candidate must be <= existing (lower is better)
 *        - totalCostUsd:        candidate must be <= existing (lower is better)
 *        - totalLatencyMs:      candidate must be <= existing (lower is better)
 *      A cost win that arrives with a defect-rate loss does NOT count as "strictly outperforms" —
 *      §33 lists completion rate, defect rate, cost, and latency together as the things that must
 *      "measurably perform better," not a single cherry-picked one.
 *   3. STRICTLY BETTER ON AT LEAST ONE OF THOSE FOUR METRICS (non-equal improvement) — otherwise a
 *      run that ties on everything would pass step 2 vacuously and count as "outperforming"
 *      nothing.
 * All three must hold for `outperforms: true`. Any failure is reported with a specific `reason`.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PendingEvolution } from './types.js';

// ---------------------------------------------------------------------------
// Benchmark result shape — mirrors `benchmarks/benchmark-runner.ts`'s `BenchmarkSuiteResult` /
// `BenchmarkScenarioResult` (JSON contract, not a shared import — see module doc above for why).
// Kept in sync manually with `src/cli/index.ts`'s own mirror of the same contract.
// ---------------------------------------------------------------------------

export interface BenchmarkScenarioResultShape {
  scenarioId: string;
  name: string;
  status: string;
  totalPrompts: number;
  completedPrompts: number;
  failedPrompts: number;
  skippedPrompts: number;
  completionRate: number;
  defectCount: number;
  defectRate: number;
  costUsd: number;
  latencyMs: number;
  warnings: string[];
  error: string | null;
}

export interface BenchmarkSuiteResultShape {
  generatedAt: string;
  scenarios: BenchmarkScenarioResultShape[];
  totals: {
    scenarioCount: number;
    meanCompletionRate: number;
    meanDefectRate: number;
    totalCostUsd: number;
    totalLatencyMs: number;
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The minimal shape of a `pending_evolutions` row shadow-mode needs (mirrors evolution-promoter.ts's private `EligiblePendingRow`). */
export interface ShadowModeCandidate {
  pendingEvolutionId: string;
  evolutionType: PendingEvolution['evolution_type'];
  /** Raw `change_detail` JSON TEXT, same column shadow-mode's caller read it from — informational only, not currently consumed (see module doc's "documented limitation"). */
  changeDetail: string;
}

/** Per-scenario completion-rate comparison — the precondition-1 evidence trail (see module doc). */
export interface ShadowScenarioComparison {
  scenarioId: string;
  existingCompletionRate: number | null;
  candidateCompletionRate: number | null;
  /** true when this scenario alone would block promotion (candidate < existing, or missing from one run). */
  regressed: boolean;
}

export interface ShadowComparisonResult {
  pendingEvolutionId: string;
  evolutionType: PendingEvolution['evolution_type'];
  /** `null` only when the existing-strategy benchmark run itself could not be completed (spawn/parse failure) — treated as a block, never a pass. */
  existing: BenchmarkSuiteResultShape | null;
  /** `null` only when the candidate-strategy benchmark run itself could not be completed. */
  candidate: BenchmarkSuiteResultShape | null;
  scenarioComparisons: ShadowScenarioComparison[];
  /** The gate's verdict — see module doc's "STRICT-OUTPERFORMANCE DEFINITION". */
  outperforms: boolean;
  /** Human-readable explanation of the verdict — always populated, pass or block. */
  reason: string;
}

export interface ShadowModeOptions {
  /** Restrict the benchmark run to these scenario ids (mirrors `BenchmarkOptions.scenarioIds`). Default: the full manifest. */
  scenarioIds?: string[];
  /** Progress reporter, mirrors `runBenchmarkSuite`'s `log`. Default: no-op. */
  log?: (message: string) => void;
  /**
   * Injectable stand-in for `spawnBenchmarkSuite` (the real "spawn benchmark-runner.ts, parse its
   * JSON" implementation). Defaults to the real spawn. Tests inject a cheap fake here instead of
   * spawning two real 5-scenario Phase3Executor runs per case, following the same `xImpl` DI
   * convention `tests/executor.test.ts`'s `baseOptions()` and `benchmarks/benchmark-runner.ts`
   * itself already use for expensive collaborators.
   */
  runBenchmarkSuiteImpl?: (label: 'existing' | 'candidate') => Promise<BenchmarkSuiteResultShape>;
}

// ---------------------------------------------------------------------------
// Real implementation: spawn `benchmarks/benchmark-runner.ts`, parse its JSON output.
// Mirrors `src/cli/index.ts`'s `cmdBenchmark` exactly (see that function's own module doc for why
// spawning, not importing, is required here).
// ---------------------------------------------------------------------------

async function spawnBenchmarkSuite(
  label: 'existing' | 'candidate',
  scenarioIds: string[] | undefined,
  log: (message: string) => void
): Promise<BenchmarkSuiteResultShape> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const runnerPath = join(repoRoot, 'benchmarks', 'benchmark-runner.ts');
  if (!existsSync(runnerPath)) {
    throw new Error(`benchmark runner not found at ${runnerPath} — is benchmarks/ present in this checkout?`);
  }

  const outFile = join(tmpdir(), `forge-shadow-${label}-${randomUUID()}.json`);
  const args = ['--import', 'tsx', runnerPath, '--out', outFile];
  for (const id of scenarioIds ?? []) args.push('--scenario', id);

  log(`shadow-mode: running ${label} strategy benchmark (spawn benchmark-runner.ts)...`);

  const exitCode = await new Promise<number>((resolvePromise) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (error) => {
      stderrTail += `\n${error.message}`;
      resolvePromise(1);
    });
    child.on('close', (code) => {
      if (code !== 0 && stderrTail.trim()) log(`shadow-mode: ${label} benchmark stderr: ${stderrTail.trim()}`);
      resolvePromise(code ?? 1);
    });
  });

  if (exitCode !== 0 || !existsSync(outFile)) {
    throw new Error(`${label} strategy benchmark suite did not complete cleanly (exit ${exitCode}).`);
  }

  try {
    const parsed = JSON.parse(await readFile(outFile, 'utf8')) as BenchmarkSuiteResultShape;
    return parsed;
  } finally {
    try {
      unlinkSync(outFile);
    } catch {
      /* best-effort cleanup */
    }
  }
}

// ---------------------------------------------------------------------------
// Comparison logic (pure — independently testable without spawning anything)
// ---------------------------------------------------------------------------

/**
 * Applies the exact "STRICT-OUTPERFORMANCE DEFINITION" documented at the top of this module to
 * two already-computed benchmark suite results. Pure and synchronous so it can be unit-tested
 * directly against hand-built `BenchmarkSuiteResultShape` fixtures, independent of
 * {@link runShadowComparison}'s spawn/injection plumbing.
 */
export function candidateStrictlyOutperforms(
  existing: BenchmarkSuiteResultShape,
  candidate: BenchmarkSuiteResultShape
): { outperforms: boolean; reason: string; scenarioComparisons: ShadowScenarioComparison[] } {
  // Precondition 1: no per-scenario completion-rate regression.
  const candidateByScenario = new Map(candidate.scenarios.map((s) => [s.scenarioId, s]));
  const scenarioComparisons: ShadowScenarioComparison[] = existing.scenarios.map((existingScenario) => {
    const candidateScenario = candidateByScenario.get(existingScenario.scenarioId);
    if (!candidateScenario) {
      return {
        scenarioId: existingScenario.scenarioId,
        existingCompletionRate: existingScenario.completionRate,
        candidateCompletionRate: null,
        regressed: true,
      };
    }
    return {
      scenarioId: existingScenario.scenarioId,
      existingCompletionRate: existingScenario.completionRate,
      candidateCompletionRate: candidateScenario.completionRate,
      regressed: candidateScenario.completionRate < existingScenario.completionRate,
    };
  });
  // A scenario present only in the candidate run (not the existing run) is also unproven — but a
  // scenario missing from the candidate run is caught above; the reverse case (extra candidate
  // scenario) does not affect the no-regression check, since existing.scenarios drives iteration.

  const regressedScenarios = scenarioComparisons.filter((c) => c.regressed);
  if (regressedScenarios.length > 0) {
    return {
      outperforms: false,
      reason:
        `completion-rate regression on ${regressedScenarios.length} scenario(s): ` +
        regressedScenarios.map((c) => c.scenarioId).join(', '),
      scenarioComparisons,
    };
  }

  // Precondition 2: no overall metric regresses (higher-is-better for completion, lower-is-better for the rest).
  const overallRegressions: string[] = [];
  if (candidate.totals.meanCompletionRate < existing.totals.meanCompletionRate) {
    overallRegressions.push(
      `meanCompletionRate ${candidate.totals.meanCompletionRate} < ${existing.totals.meanCompletionRate}`
    );
  }
  if (candidate.totals.meanDefectRate > existing.totals.meanDefectRate) {
    overallRegressions.push(`meanDefectRate ${candidate.totals.meanDefectRate} > ${existing.totals.meanDefectRate}`);
  }
  if (candidate.totals.totalCostUsd > existing.totals.totalCostUsd) {
    overallRegressions.push(`totalCostUsd ${candidate.totals.totalCostUsd} > ${existing.totals.totalCostUsd}`);
  }
  if (candidate.totals.totalLatencyMs > existing.totals.totalLatencyMs) {
    overallRegressions.push(`totalLatencyMs ${candidate.totals.totalLatencyMs} > ${existing.totals.totalLatencyMs}`);
  }
  if (overallRegressions.length > 0) {
    return {
      outperforms: false,
      reason: `overall metric regression(s): ${overallRegressions.join('; ')}`,
      scenarioComparisons,
    };
  }

  // Precondition 3: strictly better on at least one of the four overall metrics.
  const improvements: string[] = [];
  if (candidate.totals.meanCompletionRate > existing.totals.meanCompletionRate) {
    improvements.push(
      `meanCompletionRate ${existing.totals.meanCompletionRate} -> ${candidate.totals.meanCompletionRate}`
    );
  }
  if (candidate.totals.meanDefectRate < existing.totals.meanDefectRate) {
    improvements.push(`meanDefectRate ${existing.totals.meanDefectRate} -> ${candidate.totals.meanDefectRate}`);
  }
  if (candidate.totals.totalCostUsd < existing.totals.totalCostUsd) {
    improvements.push(`totalCostUsd ${existing.totals.totalCostUsd} -> ${candidate.totals.totalCostUsd}`);
  }
  if (candidate.totals.totalLatencyMs < existing.totals.totalLatencyMs) {
    improvements.push(`totalLatencyMs ${existing.totals.totalLatencyMs} -> ${candidate.totals.totalLatencyMs}`);
  }

  if (improvements.length === 0) {
    return {
      outperforms: false,
      reason: 'tie — no completion-rate regression and no overall regression, but no metric strictly improved either',
      scenarioComparisons,
    };
  }

  return {
    outperforms: true,
    reason: `strictly outperforms existing strategy: ${improvements.join('; ')}`,
    scenarioComparisons,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Runs the Task 16 self-benchmark suite once for the existing (currently-active) strategy and
 * once for the candidate strategy described by `candidate`, WITHOUT either run controlling
 * production work (§34 "Shadow mode" — `runBenchmarkSuite` always executes against disposable
 * `benchmarks/fixtures/` copies, never a real project), then reports whether the candidate
 * strictly outperforms the existing strategy per {@link candidateStrictlyOutperforms}.
 *
 * Never throws (matches every other `evolution-promoter.ts` helper's Contract-4 house style): a
 * spawn/parse failure on either run degrades to `outperforms: false` with a descriptive `reason`
 * — a broken shadow-mode check blocks promotion, it never silently waves one through.
 */
export async function runShadowComparison(
  candidate: ShadowModeCandidate,
  options: ShadowModeOptions = {}
): Promise<ShadowComparisonResult> {
  const log = options.log ?? (() => {});
  const runOne =
    options.runBenchmarkSuiteImpl ?? ((label: 'existing' | 'candidate') => spawnBenchmarkSuite(label, options.scenarioIds, log));

  let existing: BenchmarkSuiteResultShape | null = null;
  let candidateResult: BenchmarkSuiteResultShape | null = null;
  try {
    existing = await runOne('existing');
    candidateResult = await runOne('candidate');
  } catch (error) {
    return {
      pendingEvolutionId: candidate.pendingEvolutionId,
      evolutionType: candidate.evolutionType,
      existing,
      candidate: candidateResult,
      scenarioComparisons: [],
      outperforms: false,
      reason: `shadow comparison could not complete (${error instanceof Error ? error.message : String(error)}) — blocking promotion`,
    };
  }

  const verdict = candidateStrictlyOutperforms(existing, candidateResult);
  log(`shadow-mode: pending_evolution ${candidate.pendingEvolutionId} — ${verdict.outperforms ? 'PASS' : 'BLOCK'} (${verdict.reason})`);

  return {
    pendingEvolutionId: candidate.pendingEvolutionId,
    evolutionType: candidate.evolutionType,
    existing,
    candidate: candidateResult,
    scenarioComparisons: verdict.scenarioComparisons,
    outperforms: verdict.outperforms,
    reason: verdict.reason,
  };
}
