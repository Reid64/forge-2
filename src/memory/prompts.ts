/**
 * FORGE 2.0 — Build Memory: prompt_executions CRUD.
 *
 * Tracks individual prompt execution within a build. See SCHEMA_REGISTRY.md ›
 * prompt_executions.
 */

import type { PromptExecution } from '../types/index.js';
import { runQuery } from './client.js';

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

/** Insert a new prompt_execution row. Returns the created row, or null. */
export function createPromptExecution(
  input: NewPromptExecution
): Promise<PromptExecution | null> {
  return runQuery<PromptExecution>('createPromptExecution', async (c) =>
    c.from(TABLE).insert(input).select().single()
  );
}

/** Patch an existing prompt_execution by id. Returns the updated row, or null. */
export function updatePromptExecution(
  id: string,
  patch: PromptExecutionUpdate
): Promise<PromptExecution | null> {
  return runQuery<PromptExecution>('updatePromptExecution', async (c) =>
    c.from(TABLE).update(patch).eq('id', id).select().single()
  );
}

/** List all prompt_executions for a build, in queue order. Returns null on failure. */
export function getPromptsByBuild(
  buildRunId: string
): Promise<PromptExecution[] | null> {
  return runQuery<PromptExecution[]>('getPromptsByBuild', async (c) =>
    c
      .from(TABLE)
      .select('*')
      .eq('build_run_id', buildRunId)
      .order('prompt_index', { ascending: true })
  );
}
