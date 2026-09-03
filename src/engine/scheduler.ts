/**
 * FORGE 2.0 — Engine: PatternRetirer weekly sweep wiring.
 *
 * ORPHANED (Finding G-1, 2026-09-02 audit): nothing in `src/` imports or calls this module —
 * the weekly PatternRetirer sweep this file exists to arm never actually starts in any running
 * process. FORGE 2.0's CLI is invocation-based, not a long-running daemon, so there is currently
 * no natural process lifetime for a `node-cron` timer to live in; wiring this in requires either
 * a `forge daemon`-style long-running command or an external scheduler (cron/Task Scheduler)
 * invoking a one-shot `forge <sweep-command>` on a cadence instead of this module's in-process
 * timer. Kept as-is (not deleted) since the sweep logic itself is real and wanted — only the
 * "who calls this" question is unresolved. This also explains `pattern_retirement_log` reading
 * 0 rows in `forge health` (Finding C-1): the sweep this file arms has never run.
 *
 * Registers the PatternRetirer sweep as a `scheduled_tasks` row (`task_type = 'memory_cleanup'`
 * — the closest existing enum fit; SCHEMA_ADDITIONS.md forbids adding a new one) and arms its own
 * `node-cron` timer directly, per `upgrades/LEARNING_BLUEPRINT.md` § node-cron cadence: "separate
 * `node-cron` scheduled sweep, decoupled from Phase 5."
 *
 * This is deliberately NOT routed through `src/tools/task-scheduler.ts`'s `TaskScheduler` —
 * that scheduler already binds `task_type = 'memory_cleanup'` to `handleMemoryCleanup`
 * (`production_telemetry` pruning), one handler per type. PatternRetirer needs the same
 * `task_type` for `scheduled_tasks` persistence/dashboard visibility but different sweep logic,
 * so it owns a separate `node-cron` trigger here; the `scheduled_tasks` row it upserts is for
 * visibility only (it is not read back by `TaskScheduler`).
 */

import * as cron from 'node-cron';

import { getMachineId } from '../learning/database.js';
import { retirePatterns, type RetirementResult } from '../learning/pattern-retirer.js';
import BuildMemory from '../memory/index.js';
import { nextCronRun } from '../tools/task-scheduler.js';
import { logLine } from '../tools/forge-logger.js';

const log = logLine('scheduler');

export const PATTERN_RETIRER_TASK_NAME = 'pattern-retirer-sweep';
/** Weekly, Sunday 03:00 (upgrades/LEARNING_BLUEPRINT.md § node-cron cadence). */
export const PATTERN_RETIRER_CRON = '0 3 * * 0';

let armedHandle: ReturnType<typeof cron.schedule> | null = null;

/** Upsert the `scheduled_tasks` row PatternRetirer's sweep runs under. */
async function registerPatternRetirerTask(): Promise<void> {
  await BuildMemory.scheduledTasks.upsertTask({
    name: PATTERN_RETIRER_TASK_NAME,
    task_type: 'memory_cleanup',
    cron_expression: PATTERN_RETIRER_CRON,
    description:
      'PatternRetirer weekly sweep — retires stale, zero-success error_patterns into pattern_retirement_log',
    enabled: true,
    machine_id: getMachineId(),
  });
}

/**
 * Run the PatternRetirer sweep once and record the outcome on its `scheduled_tasks` row.
 * Never throws — a sweep failure is recorded as a `failure` result, not propagated.
 */
export async function runPatternRetirerSweep(): Promise<RetirementResult[]> {
  const startedAt = new Date();
  const task = await BuildMemory.scheduledTasks.getTaskByName(PATTERN_RETIRER_TASK_NAME);
  const db = BuildMemory.getClient();

  let results: RetirementResult[] = [];
  let outcome: 'success' | 'failure' = 'success';
  let errorDetail: string | null = null;
  try {
    results = db ? retirePatterns(db) : [];
  } catch (error) {
    outcome = 'failure';
    errorDetail = error instanceof Error ? error.message : String(error);
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  log(`PatternRetirer sweep -> ${outcome} (${results.length} pattern(s) retired) in ${durationMs}ms`);

  await BuildMemory.scheduledTasks.updateTaskByName(PATTERN_RETIRER_TASK_NAME, {
    last_run_at: startedAt.toISOString(),
    next_run_at: nextCronRun(PATTERN_RETIRER_CRON, finishedAt)?.toISOString() ?? null,
    last_result: outcome,
    last_error: errorDetail,
    last_duration_ms: durationMs,
    run_count: (task?.run_count ?? 0) + 1,
    failure_count: (task?.failure_count ?? 0) + (outcome === 'failure' ? 1 : 0),
  });

  return results;
}

/** Arm the PatternRetirer's `node-cron` timer and persist its schedule. Idempotent. */
export async function startPatternRetirerSchedule(): Promise<void> {
  if (armedHandle) return;
  await registerPatternRetirerTask();
  armedHandle = cron.schedule(PATTERN_RETIRER_CRON, () => {
    void runPatternRetirerSweep();
  });
  log(`PatternRetirer sweep armed — cron '${PATTERN_RETIRER_CRON}' (weekly, Sunday 03:00)`);
}

/** Cancel the PatternRetirer's `node-cron` timer, if armed. */
export function stopPatternRetirerSchedule(): void {
  if (!armedHandle) return;
  armedHandle.stop();
  armedHandle = null;
  log('PatternRetirer sweep timer stopped');
}
