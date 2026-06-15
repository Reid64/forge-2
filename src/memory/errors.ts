/**
 * FORGE 2.0 — Build Memory: error_patterns CRUD.
 *
 * Generalized error patterns extracted across all builds. See SCHEMA_REGISTRY.md ›
 * error_patterns and BEHAVIORAL_CONTRACTS.md Contract 15 (Error Pattern
 * Generalization).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ErrorCategory, ErrorPattern } from '../types/index.js';
import { logMemoryWarning, nowIso, runQuery } from './client.js';

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

// ---------------------------------------------------------------------------
// Recursive learning — interfaces
// ---------------------------------------------------------------------------

/** Result returned by matchError when a known pattern is found. */
export interface ErrorMatch {
  pattern: ErrorPattern;
  /** The stored prevention rule / fix, or null if none recorded yet. */
  fix: string | null;
  /** True when occurrence_count >= 3 — candidate for governance rule creation. */
  flagForGovernance: boolean;
}

/** Input shape when recording a newly-observed error via recordError. */
export interface ErrorRecord {
  error_signature: string;
  error_category: ErrorCategory;
  error_message_sample: string;
  first_seen_project: string;
  trigger_phase?: string | null;
  trigger_prompt_pattern?: string | null;
}

// ---------------------------------------------------------------------------
// Recursive learning — functions
// ---------------------------------------------------------------------------

/**
 * Search error_patterns for a pattern whose signature or sample message
 * substring-matches errorText. Scores candidates by shared word count and
 * returns the best match, or null if none found.
 *
 * If the best match has a prevention_rule, that is returned as `fix`.
 * If its occurrence_count >= 3, `flagForGovernance` is set so the caller can
 * trigger automatic governance rule creation.
 */
export async function matchError(
  errorText: string,
  client: SupabaseClient
): Promise<ErrorMatch | null> {
  try {
    const snippet = errorText.slice(0, 50).replace(/[%_]/g, '\\$&');
    const { data, error } = await client
      .from(TABLE)
      .select('*')
      .or(
        `error_message_sample.ilike.%${snippet}%,error_signature.ilike.%${snippet}%`
      )
      .order('occurrence_count', { ascending: false })
      .limit(10);

    if (error || !data || (data as ErrorPattern[]).length === 0) return null;

    const target = errorText.toLowerCase();
    let best: ErrorPattern | null = null;
    let bestScore = 0;

    for (const row of data as ErrorPattern[]) {
      const sample = row.error_message_sample.toLowerCase();
      const score = sample
        .split(/\W+/)
        .filter((w) => w.length > 3 && target.includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }

    if (!best) return null;

    return {
      pattern: best,
      fix: best.prevention_rule,
      flagForGovernance: best.occurrence_count >= 3,
    };
  } catch (err) {
    logMemoryWarning('matchError', err);
    return null;
  }
}

/**
 * Record an observed error. If a row with the same error_signature already
 * exists, increment its occurrence_count and refresh last_seen_at. Otherwise
 * insert a new row. Never throws — logs warnings on failure.
 */
export async function recordError(
  error: ErrorRecord,
  client: SupabaseClient
): Promise<void> {
  try {
    const { data: existing, error: fetchErr } = await client
      .from(TABLE)
      .select('*')
      .eq('error_signature', error.error_signature)
      .maybeSingle();

    if (fetchErr) {
      logMemoryWarning('recordError.fetch', fetchErr);
      return;
    }

    if (existing) {
      const { error: updateErr } = await client
        .from(TABLE)
        .update({
          occurrence_count: (existing as ErrorPattern).occurrence_count + 1,
          last_seen_at: nowIso(),
          updated_at: nowIso(),
        })
        .eq('id', (existing as ErrorPattern).id);

      if (updateErr) logMemoryWarning('recordError.update', updateErr);
    } else {
      const { error: insertErr } = await client.from(TABLE).insert({
        ...error,
        occurrence_count: 1,
        first_seen_at: nowIso(),
        last_seen_at: nowIso(),
        stack_fingerprints: [],
        success_rate: 0,
        auto_resolve_eligible: false,
      });

      if (insertErr) logMemoryWarning('recordError.insert', insertErr);
    }
  } catch (err) {
    logMemoryWarning('recordError', err);
  }
}

/**
 * Attach a proven fix to an error pattern. Stores the fix text in
 * prevention_rule and updates updated_at. Never throws.
 */
export async function recordFix(
  errorId: string,
  fix: string,
  client: SupabaseClient
): Promise<void> {
  try {
    const { error } = await client
      .from(TABLE)
      .update({ prevention_rule: fix, updated_at: nowIso() })
      .eq('id', errorId);

    if (error) logMemoryWarning('recordFix', error);
  } catch (err) {
    logMemoryWarning('recordFix', err);
  }
}

/**
 * Return all error patterns whose occurrence_count meets or exceeds threshold,
 * ordered by frequency descending. Returns an empty array on failure (never
 * null — callers can map over the result directly).
 */
export async function getRecurringErrors(
  threshold: number,
  client: SupabaseClient
): Promise<ErrorPattern[]> {
  try {
    const { data, error } = await client
      .from(TABLE)
      .select('*')
      .gte('occurrence_count', threshold)
      .order('occurrence_count', { ascending: false });

    if (error) {
      logMemoryWarning('getRecurringErrors', error);
      return [];
    }

    return (data as ErrorPattern[]) ?? [];
  } catch (err) {
    logMemoryWarning('getRecurringErrors', err);
    return [];
  }
}

/**
 * Given a recurring error pattern with a known fix, generate a FORGE
 * governance preamble instruction. The output is ready to prepend to a build
 * prompt so future agents avoid the same failure.
 */
export function generateGovernanceRule(error: ErrorPattern): string {
  const fix = error.prevention_rule ?? 'Review the error and apply the known fix.';
  return [
    `GOVERNANCE RULE [auto-generated from error_patterns id=${error.id}]:`,
    `Category: ${error.error_category}`,
    `Pattern: ${error.error_signature}`,
    `Seen ${error.occurrence_count} time(s) across builds (last: ${error.last_seen_at}).`,
    `Prevention: ${fix}`,
    `When this error signature appears, apply the prevention rule before proceeding.`,
  ].join('\n');
}
