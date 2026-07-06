/**
 * FORGE 2.0 — Build Memory: prompt_executions CRUD.
 *
 * Tracks individual prompt execution within a build. See src/learning/database.ts ›
 * BUILD_MEMORY_SCHEMA_SQL › prompt_executions.
 */

import type { PromptExecution } from '../types/index.js';
import { fromJsonText, fromSqliteBool, newId, runQuery, toJsonText, toSqliteBool } from './client.js';

const TABLE = 'prompt_executions';

/** Fields required to record a prompt execution (NOT NULL, no DB default). */
export type NewPromptExecution = Pick<
  PromptExecution,
  | 'build_run_id'
  | 'prompt_index'
  | 'prompt_name'
  | 'prompt_hash'
  | 'prompt_content'
> &
  Partial<
    Omit<
      PromptExecution,
      | 'id'
      | 'created_at'
      | 'build_run_id'
      | 'prompt_index'
      | 'prompt_name'
      | 'prompt_hash'
      | 'prompt_content'
    >
  >;

/** Mutable columns of a prompt_execution. */
export type PromptExecutionUpdate = Partial<
  Omit<PromptExecution, 'id' | 'created_at'>
>;

interface PromptExecutionRow {
  id: string;
  build_run_id: string;
  prompt_index: number;
  prompt_name: string;
  prompt_hash: string;
  prompt_content: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  tokens_input: number;
  tokens_output: number;
  cost_usd: number;
  error_output: string | null;
  resolution_applied: string | null;
  was_rewritten: number;
  original_prompt_hash: string | null;
  rewrite_reason: string | null;
  failure_prediction_score: number | null;
  branch_name: string | null;
  sentinel_passed: number | null;
  sentinel_details: string | null;
  files_created: string;
  files_modified: string;
  files_deleted: string;
  created_at: string;
}

function rowToPromptExecution(row: PromptExecutionRow): PromptExecution {
  return {
    id: row.id,
    build_run_id: row.build_run_id,
    prompt_index: row.prompt_index,
    prompt_name: row.prompt_name,
    prompt_hash: row.prompt_hash,
    prompt_content: row.prompt_content,
    status: row.status as PromptExecution['status'],
    started_at: row.started_at,
    completed_at: row.completed_at,
    duration_ms: row.duration_ms,
    tokens_input: row.tokens_input,
    tokens_output: row.tokens_output,
    cost_usd: row.cost_usd,
    error_output: row.error_output,
    resolution_applied: row.resolution_applied,
    was_rewritten: fromSqliteBool(row.was_rewritten),
    original_prompt_hash: row.original_prompt_hash,
    rewrite_reason: row.rewrite_reason,
    failure_prediction_score: row.failure_prediction_score,
    branch_name: row.branch_name,
    sentinel_passed: row.sentinel_passed === null ? null : fromSqliteBool(row.sentinel_passed),
    sentinel_details: fromJsonText(row.sentinel_details, null),
    files_created: fromJsonText(row.files_created, []),
    files_modified: fromJsonText(row.files_modified, []),
    files_deleted: fromJsonText(row.files_deleted, []),
    created_at: row.created_at,
  };
}

/** Insert a new prompt_execution row. Returns the created row, or null. */
export function createPromptExecution(
  input: NewPromptExecution
): Promise<PromptExecution | null> {
  return runQuery<PromptExecution>(TABLE + '.createPromptExecution', (db) => {
    const id = newId();
    db.prepare(
      `INSERT INTO prompt_executions (
        id, build_run_id, prompt_index, prompt_name, prompt_hash, prompt_content, status,
        started_at, completed_at, duration_ms, tokens_input, tokens_output, cost_usd, error_output,
        resolution_applied, was_rewritten, original_prompt_hash, rewrite_reason,
        failure_prediction_score, branch_name, sentinel_passed, sentinel_details,
        files_created, files_modified, files_deleted
      ) VALUES (
        @id, @build_run_id, @prompt_index, @prompt_name, @prompt_hash, @prompt_content, @status,
        @started_at, @completed_at, @duration_ms, @tokens_input, @tokens_output, @cost_usd, @error_output,
        @resolution_applied, @was_rewritten, @original_prompt_hash, @rewrite_reason,
        @failure_prediction_score, @branch_name, @sentinel_passed, @sentinel_details,
        @files_created, @files_modified, @files_deleted
      )`
    ).run({
      id,
      build_run_id: input.build_run_id,
      prompt_index: input.prompt_index,
      prompt_name: input.prompt_name,
      prompt_hash: input.prompt_hash,
      prompt_content: input.prompt_content,
      status: input.status ?? 'pending',
      started_at: input.started_at ?? null,
      completed_at: input.completed_at ?? null,
      duration_ms: input.duration_ms ?? null,
      tokens_input: input.tokens_input ?? 0,
      tokens_output: input.tokens_output ?? 0,
      cost_usd: input.cost_usd ?? 0,
      error_output: input.error_output ?? null,
      resolution_applied: input.resolution_applied ?? null,
      was_rewritten: toSqliteBool(input.was_rewritten ?? false),
      original_prompt_hash: input.original_prompt_hash ?? null,
      rewrite_reason: input.rewrite_reason ?? null,
      failure_prediction_score: input.failure_prediction_score ?? null,
      branch_name: input.branch_name ?? null,
      sentinel_passed: input.sentinel_passed === undefined || input.sentinel_passed === null ? null : toSqliteBool(input.sentinel_passed),
      sentinel_details: toJsonText(input.sentinel_details ?? null),
      files_created: toJsonText(input.files_created ?? []),
      files_modified: toJsonText(input.files_modified ?? []),
      files_deleted: toJsonText(input.files_deleted ?? []),
    });
    const row = db.prepare('SELECT * FROM prompt_executions WHERE id = ?').get(id) as PromptExecutionRow;
    return rowToPromptExecution(row);
  });
}

const UPDATE_TRANSFORMS: Partial<Record<keyof PromptExecutionUpdate, (v: unknown) => unknown>> = {
  was_rewritten: (v) => toSqliteBool(v as boolean),
  sentinel_passed: (v) => (v === null || v === undefined ? null : toSqliteBool(v as boolean)),
  sentinel_details: (v) => toJsonText(v),
  files_created: (v) => toJsonText(v),
  files_modified: (v) => toJsonText(v),
  files_deleted: (v) => toJsonText(v),
};

/** Patch an existing prompt_execution by id. Returns the updated row, or null. */
export function updatePromptExecution(
  id: string,
  patch: PromptExecutionUpdate
): Promise<PromptExecution | null> {
  return runQuery<PromptExecution>(TABLE + '.updatePromptExecution', (db) => {
    const keys = Object.keys(patch) as Array<keyof PromptExecutionUpdate>;
    if (keys.length === 0) {
      const row = db.prepare('SELECT * FROM prompt_executions WHERE id = ?').get(id) as
        | PromptExecutionRow
        | undefined;
      return row ? rowToPromptExecution(row) : null;
    }
    const setClause = keys.map((k) => `${String(k)} = @${String(k)}`).join(', ');
    const params: Record<string, unknown> = { id };
    for (const k of keys) {
      const transform = UPDATE_TRANSFORMS[k];
      const value = (patch as Record<string, unknown>)[k as string];
      params[k as string] = transform ? transform(value) : value;
    }
    const result = db.prepare(`UPDATE prompt_executions SET ${setClause} WHERE id = @id`).run(params);
    if (result.changes === 0) return null;
    const row = db.prepare('SELECT * FROM prompt_executions WHERE id = ?').get(id) as PromptExecutionRow;
    return rowToPromptExecution(row);
  });
}

/** List all prompt_executions for a build, in queue order. Returns null on failure. */
export function getPromptsByBuild(
  buildRunId: string
): Promise<PromptExecution[] | null> {
  return runQuery<PromptExecution[]>(TABLE + '.getPromptsByBuild', (db) => {
    const rows = db
      .prepare('SELECT * FROM prompt_executions WHERE build_run_id = ? ORDER BY prompt_index ASC')
      .all(buildRunId) as PromptExecutionRow[];
    return rows.map(rowToPromptExecution);
  });
}
