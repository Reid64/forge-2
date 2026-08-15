/**
 * FORGE 2.0 — Stagnation Detection.
 *
 * `upgrades/ENGINEERING_COMPLETENESS.md` § "39. Stagnation detection": "Even if tasks technically
 * 'pass,' FORGE should detect when progress stalls. Example: 12 hours elapsed, 317 tasks
 * attempted, but only 3% reduction in remaining critical work. That should trigger replanning."
 * `upgrades/SYSTEMS-5-9-GAP-MATRIX.md` row 29 ("Dead-loop / stagnation detection") confirmed no
 * match existed anywhere in the codebase before this module. See the sibling
 * `dead-loop-detection.ts` for item 38 — that module answers "is FORGE stuck retrying the same
 * thing"; this one answers the different question "is FORGE still making net progress at all,
 * even while individual prompts keep passing."
 *
 * Grounded entirely in `build_runs` + `prompt_executions` columns FORGE already writes on every
 * prompt (no new table, no fabricated signal, matching every sibling `src/governance/` module):
 *   - "12 hours elapsed" -> `build_runs.started_at` (set at build creation — `phase3-executor.ts`
 *     passes `started_at: generatedAt` to `createBuild`, so it is live from the FIRST prompt, not
 *     only at completion) compared against wall-clock now.
 *   - "317 tasks attempted" -> `prompt_executions` rows for this `build_run_id` (one row per
 *     queue entry, live-inserted as `RUNNING` before each prompt executes — see
 *     `build-state-machine.ts`'s own doc comment for the same observation), PLUS every row that
 *     carries a real retry/rewrite signal (`resolution_applied !== null`, `was_rewritten`) — the
 *     closest real proxy to "attempts burned" the schema exposes without a dedicated per-attempt
 *     table. `build_runs.completed_prompts`/`failed_prompts`/`sentinel_interventions` are NOT
 *     usable here: they are only computed once, at build finalization
 *     (`phase3-executor.ts` around the `updateBuild(buildRunId, { completed_prompts, ... })`
 *     call), so mid-build they would silently read `0` — documented, not silently assumed live.
 *   - "only 3% reduction in remaining critical work" -> completed-prompt ratio against
 *     `build_runs.total_prompts` (planned at build start, so "remaining work" is well-defined
 *     throughout).
 *
 * The three thresholds below are a documented, spec-anchored heuristic (there is no single
 * "canonical" stagnation number in the source spec beyond its one worked example) — tuned so the
 * spec's own example (12h, 317 attempts, 3% progress) trips all three.
 */

import { BuildMemory } from '../memory/index.js';
import type { BuildRun, PromptExecution } from '../types/index.js';

/** "12 hours elapsed" — the spec example's elapsed-time floor. */
export const STAGNATION_ELAPSED_HOURS_THRESHOLD = 12;

/** A build must have burned at least this many prompt attempts before stagnation is judged (avoids flagging a young/small build as stalled). */
export const STAGNATION_MIN_ATTEMPTS_THRESHOLD = 20;

/** "only 3% reduction in remaining critical work" — progress below this ratio counts as stalled. */
export const STAGNATION_PROGRESS_RATIO_THRESHOLD = 0.05;

export interface StagnationVerdict {
  buildRunId: string;
  isStagnant: boolean;
  elapsedHours: number;
  /** prompt_executions row count for this build, plus every row carrying a real retry/rewrite signal. */
  attemptsMade: number;
  completedCount: number;
  totalPrompts: number;
  /** completedCount / totalPrompts (1 when totalPrompts is 0 — nothing was ever planned, so nothing can be "stalled"). */
  progressRatio: number;
  buildStatus: BuildRun['status'];
  reason: string;
  recommendedAction: 'trigger_replanning' | null;
}

/**
 * Evaluate stagnation for a live or completed build from real Build Memory rows. Never throws —
 * returns `null` when the build or its executions cannot be read (Build Memory unreachable, or
 * `buildRunId` unknown) rather than fabricating a verdict.
 */
export async function detectStagnation(buildRunId: string): Promise<StagnationVerdict | null> {
  let build: BuildRun | null = null;
  try {
    build = await BuildMemory.builds.getBuild(buildRunId);
  } catch {
    build = null;
  }
  if (!build || !build.started_at) return null;

  let executions: PromptExecution[] | null = null;
  try {
    executions = await BuildMemory.prompts.getPromptsByBuild(buildRunId);
  } catch {
    executions = null;
  }
  if (!executions) return null;

  const elapsedHours = (Date.now() - Date.parse(build.started_at)) / 3_600_000;
  const completedCount = executions.filter((e) => e.status === 'completed' && e.sentinel_passed === true).length;
  const retrySignals =
    executions.filter((e) => e.resolution_applied !== null).length + executions.filter((e) => e.was_rewritten).length;
  const attemptsMade = executions.length + retrySignals;
  const totalPrompts = build.total_prompts;
  const progressRatio = totalPrompts > 0 ? completedCount / totalPrompts : 1;

  const elapsedTripped = elapsedHours >= STAGNATION_ELAPSED_HOURS_THRESHOLD;
  const attemptsTripped = attemptsMade >= STAGNATION_MIN_ATTEMPTS_THRESHOLD;
  const progressTripped = progressRatio < STAGNATION_PROGRESS_RATIO_THRESHOLD;
  // Only a still-RUNNING build can be "stalled" — a build that has already finished (completed,
  // failed, halted) is a completed fact, not an in-progress one that replanning could rescue.
  const isStagnant = build.status === 'running' && elapsedTripped && attemptsTripped && progressTripped;

  const reason = isStagnant
    ? `${elapsedHours.toFixed(1)}h elapsed, ${attemptsMade} attempt(s) made, only ${(progressRatio * 100).toFixed(1)}% ` +
      `of ${totalPrompts} planned prompt(s) completed.`
    : `not stagnant (elapsed=${elapsedHours.toFixed(1)}h, attempts=${attemptsMade}, ` +
      `progress=${(progressRatio * 100).toFixed(1)}%, status=${build.status}).`;

  return {
    buildRunId,
    isStagnant,
    elapsedHours,
    attemptsMade,
    completedCount,
    totalPrompts,
    progressRatio,
    buildStatus: build.status,
    reason,
    recommendedAction: isStagnant ? 'trigger_replanning' : null,
  };
}

/** Render a `StagnationVerdict` as a human-readable line (used by `forge stagnation`). */
export function formatStagnationVerdict(v: StagnationVerdict): string {
  const header = `build ${v.buildRunId} (${v.buildStatus}) — ${v.completedCount}/${v.totalPrompts} completed, ${v.attemptsMade} attempt(s), ${v.elapsedHours.toFixed(1)}h elapsed`;
  if (!v.isStagnant) return `${header}\n  ${v.reason}`;
  return `${header}\n  STAGNANT: ${v.reason}\n  recommended: ${v.recommendedAction}`;
}
