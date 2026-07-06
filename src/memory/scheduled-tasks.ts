/**
 * FORGE 2.0 — Build Memory: scheduled_tasks CRUD.
 *
 * Persistence for the Task Scheduler (`src/tools/task-scheduler.ts`). A scheduled
 * task's cron schedule, last/next run, and last result live here so the schedule
 * survives FORGE restarts (BLUEPRINT canonical rule 9; the scheduler reloads from
 * this table on startup). See src/learning/database.ts › BUILD_MEMORY_SCHEMA_SQL ›
 * scheduled_tasks.
 *
 * Per BEHAVIORAL_CONTRACTS.md Contract 4: every helper degrades gracefully — when
 * Build Memory is unreachable they log a warning and return null, and the scheduler
 * falls back to its in-memory schedule (stateless mode).
 */

import type { ScheduledTask } from '../types/index.js';
import { fromJsonText, fromSqliteBool, newId, nowIso, runQuery, toJsonText, toSqliteBool } from './client.js';

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

interface ScheduledTaskRow {
  id: string;
  name: string;
  description: string | null;
  task_type: string;
  cron_expression: string;
  enabled: number;
  machine_id: string | null;
  metadata: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_result: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  run_count: number;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    task_type: row.task_type as ScheduledTask['task_type'],
    cron_expression: row.cron_expression,
    enabled: fromSqliteBool(row.enabled),
    machine_id: row.machine_id,
    metadata: fromJsonText(row.metadata, {}),
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    last_result: row.last_result as ScheduledTask['last_result'],
    last_error: row.last_error,
    last_duration_ms: row.last_duration_ms,
    run_count: row.run_count,
    failure_count: row.failure_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const UPSERT_TRANSFORMS: Partial<Record<keyof NewScheduledTask, (v: unknown) => unknown>> = {
  enabled: (v) => toSqliteBool(v as boolean),
  metadata: (v) => toJsonText(v),
};

/**
 * Insert or update a scheduled task, keyed by its unique `name` (idempotent
 * registration — re-adding a task by the same name updates its schedule rather
 * than erroring). Returns the persisted row, or null on failure.
 */
export function upsertTask(input: NewScheduledTask): Promise<ScheduledTask | null> {
  return runQuery<ScheduledTask>(TABLE + '.upsertTask', (db) => {
    const existing = db.prepare('SELECT id FROM scheduled_tasks WHERE name = ?').get(input.name) as
      | { id: string }
      | undefined;
    const ts = nowIso();
    const id = existing?.id ?? newId();

    const fields: Record<string, unknown> = {
      description: input.description ?? null,
      enabled: input.enabled ?? true,
      machine_id: input.machine_id ?? null,
      metadata: input.metadata ?? {},
      last_run_at: input.last_run_at ?? null,
      next_run_at: input.next_run_at ?? null,
      last_result: input.last_result ?? null,
      last_error: input.last_error ?? null,
      last_duration_ms: input.last_duration_ms ?? null,
      run_count: input.run_count ?? 0,
      failure_count: input.failure_count ?? 0,
    };
    for (const [k, transform] of Object.entries(UPSERT_TRANSFORMS)) {
      fields[k] = transform!(fields[k]);
    }

    if (existing) {
      db.prepare(
        `UPDATE scheduled_tasks SET
          task_type = @task_type, cron_expression = @cron_expression, description = @description,
          enabled = @enabled, machine_id = @machine_id, metadata = @metadata,
          last_run_at = @last_run_at, next_run_at = @next_run_at, last_result = @last_result,
          last_error = @last_error, last_duration_ms = @last_duration_ms, run_count = @run_count,
          failure_count = @failure_count, updated_at = @updated_at
        WHERE id = @id`
      ).run({
        id,
        task_type: input.task_type,
        cron_expression: input.cron_expression,
        updated_at: ts,
        ...fields,
      });
    } else {
      db.prepare(
        `INSERT INTO scheduled_tasks (
          id, name, description, task_type, cron_expression, enabled, machine_id, metadata,
          last_run_at, next_run_at, last_result, last_error, last_duration_ms, run_count,
          failure_count, created_at, updated_at
        ) VALUES (
          @id, @name, @description, @task_type, @cron_expression, @enabled, @machine_id, @metadata,
          @last_run_at, @next_run_at, @last_result, @last_error, @last_duration_ms, @run_count,
          @failure_count, @created_at, @updated_at
        )`
      ).run({
        id,
        name: input.name,
        task_type: input.task_type,
        cron_expression: input.cron_expression,
        created_at: ts,
        updated_at: ts,
        ...fields,
      });
    }

    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTaskRow;
    return rowToTask(row);
  });
}

const UPDATE_TRANSFORMS: Partial<Record<keyof ScheduledTaskUpdate, (v: unknown) => unknown>> = {
  enabled: (v) => toSqliteBool(v as boolean),
  metadata: (v) => toJsonText(v),
};

/**
 * Patch an existing scheduled task by name (used to record a run's outcome and the
 * next-run time). `updated_at` is stamped automatically. Returns the updated row,
 * or null.
 */
export function updateTaskByName(
  name: string,
  patch: ScheduledTaskUpdate
): Promise<ScheduledTask | null> {
  return runQuery<ScheduledTask>(TABLE + '.updateTaskByName', (db) => {
    const ts = nowIso();
    const keys = Object.keys(patch) as Array<keyof ScheduledTaskUpdate>;
    const params: Record<string, unknown> = { name, updated_at: ts };
    const setParts = ['updated_at = @updated_at'];
    for (const k of keys) {
      const transform = UPDATE_TRANSFORMS[k];
      const value = (patch as Record<string, unknown>)[k as string];
      params[k as string] = transform ? transform(value) : value;
      setParts.push(`${String(k)} = @${String(k)}`);
    }
    const result = db
      .prepare(`UPDATE scheduled_tasks SET ${setParts.join(', ')} WHERE name = @name`)
      .run(params);
    if (result.changes === 0) return null;
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE name = ?').get(name) as ScheduledTaskRow;
    return rowToTask(row);
  });
}

/** Fetch a single scheduled task by name. Returns null if not found or on failure. */
export function getTaskByName(name: string): Promise<ScheduledTask | null> {
  return runQuery<ScheduledTask>(TABLE + '.getTaskByName', (db) => {
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE name = ?').get(name) as
      | ScheduledTaskRow
      | undefined;
    return row ? rowToTask(row) : null;
  });
}

/** List all scheduled tasks, most recently created first. Returns null on failure. */
export function listTasks(): Promise<ScheduledTask[] | null> {
  return runQuery<ScheduledTask[]>(TABLE + '.listTasks', (db) => {
    const rows = db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTaskRow[];
    return rows.map(rowToTask);
  });
}

/**
 * Delete a scheduled task by name. Returns the deleted rows (so the caller can tell
 * whether anything matched), or null on failure.
 */
export function deleteTaskByName(name: string): Promise<ScheduledTask[] | null> {
  return runQuery<ScheduledTask[]>(TABLE + '.deleteTaskByName', (db) => {
    const rows = db.prepare('SELECT * FROM scheduled_tasks WHERE name = ?').all(name) as ScheduledTaskRow[];
    if (rows.length === 0) return [];
    db.prepare('DELETE FROM scheduled_tasks WHERE name = ?').run(name);
    return rows.map(rowToTask);
  });
}
