/**
 * FORGE 2.0 — Build Memory: error_patterns CRUD.
 *
 * Generalized error patterns extracted across all builds. See SCHEMA_REGISTRY.md ›
 * error_patterns and BEHAVIORAL_CONTRACTS.md Contract 15 (Error Pattern
 * Generalization).
 */

import type { ErrorPattern } from '../types/index.js';
import { nowIso, runQuery } from './client.js';

const TABLE = 'error_patterns';

/** Fields required to record an error pattern (NOT NULL, no DB default). */
export type NewErrorPattern = Pick<
  ErrorPattern,
  'error_signature' | 'error_category' | 'error_message_sample' | 'first_seen_project'
> &
  Partial<
    Omit<
      ErrorPattern,
      | 'id'
      | 'created_at'
      | 'updated_at'
      | 'error_signature'
      | 'error_category'
      | 'error_message_sample'
      | 'first_seen_project'
    >
  >;

/** Insert a new error_pattern row. Returns the created row, or null. */
export function createErrorPattern(
  input: NewErrorPattern
): Promise<ErrorPattern | null> {
  return runQuery<ErrorPattern>('createErrorPattern', async (c) =>
    c.from(TABLE).insert(input).select().single()
  );
}

/**
 * Find an existing pattern by its normalized signature (exact match).
 * Signatures are normalized before lookup per Contract 15. Returns null if no
 * match or on failure.
 */
export function findMatchingPattern(
  errorSignature: string
): Promise<ErrorPattern | null> {
  return runQuery<ErrorPattern>('findMatchingPattern', async (c) =>
    c.from(TABLE).select('*').eq('error_signature', errorSignature).maybeSingle()
  );
}

/**
 * Increment occurrence_count and refresh last_seen_at for a pattern.
 *
 * Read-then-write (FORGE is single-operator/local, so no atomicity concern).
 * Returns the updated row, or null on failure.
 */
export async function updateOccurrenceCount(
  id: string
): Promise<ErrorPattern | null> {
  const current = await runQuery<ErrorPattern>(
    'updateOccurrenceCount.read',
    async (c) => c.from(TABLE).select('*').eq('id', id).maybeSingle()
  );
  if (!current) return null;

  return runQuery<ErrorPattern>('updateOccurrenceCount.write', async (c) =>
    c
      .from(TABLE)
      .update({
        occurrence_count: current.occurrence_count + 1,
        last_seen_at: nowIso(),
        updated_at: nowIso(),
      })
      .eq('id', id)
      .select()
      .single()
  );
}

/**
 * List error patterns whose `trigger_prompt_pattern` matches a prompt type (e.g.
 * 'schema', 'auth', 'ui', 'api'), most-frequent first. Used by the prompt-assembler
 * (s5-p01) to inject prevention warnings into a prompt and by the failure-predictor
 * (s5-p02). Stack filtering (against `stack_fingerprints`) is left to the caller —
 * jsonb-array containment is awkward in PostgREST and the candidate set is small.
 * Returns null on failure.
 */
export function findPatternsByPromptType(
  promptPattern: string
): Promise<ErrorPattern[] | null> {
  return runQuery<ErrorPattern[]>('findPatternsByPromptType', async (c) =>
    c
      .from(TABLE)
      .select('*')
      .eq('trigger_prompt_pattern', promptPattern)
      .order('occurrence_count', { ascending: false })
  );
}

/**
 * List patterns eligible for autonomous resolution (auto_resolve_eligible = true),
 * highest success_rate first. Returns null on failure.
 */
export function getAutoResolvable(): Promise<ErrorPattern[] | null> {
  return runQuery<ErrorPattern[]>('getAutoResolvable', async (c) =>
    c
      .from(TABLE)
      .select('*')
      .eq('auto_resolve_eligible', true)
      .order('success_rate', { ascending: false })
  );
}
