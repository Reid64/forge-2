/**
 * FORGE 2.0 — Build Memory: scheduled_tasks CRUD.
 *
 * Persistence for the Task Scheduler (`src/tools/task-scheduler.ts`). A scheduled
 * task's cron schedule, last/next run, and last result live here so the schedule
 * survives FORGE restarts (BLUEPRINT canonical rule 9; the scheduler reloads from
 * this table on startup). See SCHEMA_REGISTRY.md (addendum) › scheduled_tasks.
 *
 * Per BEHAVIORAL_CONTRACTS.md Contract 4: every helper degrades gracefully — when
 * Build Memory is unreachable they log a warning and return null, and the scheduler
 * falls back to its in-memory schedule (stateless mode).
 */

import type { ScheduledTask } from '../types/index.js';
import { nowIso, runQuery } from './client.js';

const TABLE = 'scheduled_tasks';

/**
 * Fields required to register a scheduled task. Everything else is supplied by the
 * database (defaults) or set later by the scheduler as it records runs.
 */
export type NewScheduledTask = Pick<
  ScheduledTask,
  'name' | 'task_type' | 'cron_expression'
> &
  Partial<
    Omit<
      ScheduledTask,
      'id' | 'created_at' | 'updated_at' | 'name' | 'task_type' | 'cron_expression'
    >
  >;

/** Mutable columns of a scheduled_task (everything except identity/creation). */
export type ScheduledTaskUpdate = Partial<
  Omit<ScheduledTask, 'id' | 'created_at' | 'name'>
>;

/**
 * Insert or update a scheduled task, keyed by its unique `name` (idempotent
 * registration — re-adding a task by the same name updates its schedule rather
 * than erroring). Returns the persisted row, or null on failure.
 */
export function upsertTask(input: NewScheduledTask): Promise<ScheduledTask | null> {
  const payload = { ...input, updated_at: nowIso() };
  return runQuery<ScheduledTask>('upsertTask', async (c) =>
    c.from(TABLE).upsert(payload, { onConflict: 'name' }).select().single()
  );
}

/**
 * Patch an existing scheduled task by name (used to record a run's outcome and the
 * next-run time). `updated_at` is stamped automatically. Returns the updated row,
 * or null.
 */
export function updateTaskByName(
  name: string,
  patch: ScheduledTaskUpdate
): Promise<ScheduledTask | null> {
  const payload = { ...patch, updated_at: nowIso() };
  return runQuery<ScheduledTask>('updateTaskByName', async (c) =>
    c.from(TABLE).update(payload).eq('name', name).select().single()
  );
}

/** Fetch a single scheduled task by name. Returns null if not found or on failure. */
export function getTaskByName(name: string): Promise<ScheduledTask | null> {
  return runQuery<ScheduledTask>('getTaskByName', async (c) =>
    c.from(TABLE).select('*').eq('name', name).maybeSingle()
  );
}

/** List all scheduled tasks, most recently created first. Returns null on failure. */
export function listTasks(): Promise<ScheduledTask[] | null> {
  return runQuery<ScheduledTask[]>('listTasks', async (c) =>
    c.from(TABLE).select('*').order('created_at', { ascending: false })
  );
}

/**
 * Delete a scheduled task by name. Returns the deleted rows (so the caller can tell
 * whether anything matched), or null on failure.
 */
export function deleteTaskByName(name: string): Promise<ScheduledTask[] | null> {
  return runQuery<ScheduledTask[]>('deleteTaskByName', async (c) =>
    c.from(TABLE).delete().eq('name', name).select()
  );
}
