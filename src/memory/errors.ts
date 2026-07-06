/**
 * FORGE 2.0 — Build Memory: error_patterns CRUD.
 *
 * Generalized error patterns extracted across all builds. See
 * src/learning/database.ts › BUILD_MEMORY_SCHEMA_SQL › error_patterns and
 * BEHAVIORAL_CONTRACTS.md Contract 15 (Error Pattern Generalization).
 */

import type { ErrorCategory, ErrorPattern } from '../types/index.js';
import {
  fromJsonText,
  fromSqliteBool,
  logMemoryWarning,
  newId,
  nowIso,
  runQuery,
  toJsonText,
  toSqliteBool,
  type MemoryDb,
} from './client.js';

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

interface ErrorPatternRow {
  id: string;
  error_signature: string;
  error_category: string;
  error_message_sample: string;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  first_seen_project: string;
  stack_fingerprints: string;
  trigger_phase: string | null;
  trigger_prompt_pattern: string | null;
  resolution_id: string | null;
  prevention_rule: string | null;
  success_rate: number;
  auto_resolve_eligible: number;
  created_at: string;
  updated_at: string;
}

function rowToErrorPattern(row: ErrorPatternRow): ErrorPattern {
  return {
    id: row.id,
    error_signature: row.error_signature,
    error_category: row.error_category as ErrorCategory,
    error_message_sample: row.error_message_sample,
    occurrence_count: row.occurrence_count,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    first_seen_project: row.first_seen_project,
    stack_fingerprints: fromJsonText(row.stack_fingerprints, []),
    trigger_phase: row.trigger_phase,
    trigger_prompt_pattern: row.trigger_prompt_pattern,
    resolution_id: row.resolution_id,
    prevention_rule: row.prevention_rule,
    success_rate: row.success_rate,
    auto_resolve_eligible: fromSqliteBool(row.auto_resolve_eligible),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Insert a new error_pattern row. Returns the created row, or null. */
export function createErrorPattern(
  input: NewErrorPattern
): Promise<ErrorPattern | null> {
  return runQuery<ErrorPattern>(TABLE + '.createErrorPattern', (db) => {
    const id = newId();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO error_patterns (
        id, error_signature, error_category, error_message_sample, occurrence_count,
        first_seen_at, last_seen_at, first_seen_project, stack_fingerprints, trigger_phase,
        trigger_prompt_pattern, resolution_id, prevention_rule, success_rate,
        auto_resolve_eligible, created_at, updated_at
      ) VALUES (
        @id, @error_signature, @error_category, @error_message_sample, @occurrence_count,
        @first_seen_at, @last_seen_at, @first_seen_project, @stack_fingerprints, @trigger_phase,
        @trigger_prompt_pattern, @resolution_id, @prevention_rule, @success_rate,
        @auto_resolve_eligible, @created_at, @updated_at
      )`
    ).run({
      id,
      error_signature: input.error_signature,
      error_category: input.error_category,
      error_message_sample: input.error_message_sample,
      occurrence_count: input.occurrence_count ?? 1,
      first_seen_at: input.first_seen_at ?? ts,
      last_seen_at: input.last_seen_at ?? ts,
      first_seen_project: input.first_seen_project,
      stack_fingerprints: toJsonText(input.stack_fingerprints ?? []),
      trigger_phase: input.trigger_phase ?? null,
      trigger_prompt_pattern: input.trigger_prompt_pattern ?? null,
      resolution_id: input.resolution_id ?? null,
      prevention_rule: input.prevention_rule ?? null,
      success_rate: input.success_rate ?? 0,
      auto_resolve_eligible: toSqliteBool(input.auto_resolve_eligible ?? false),
      created_at: ts,
      updated_at: ts,
    });
    const row = db.prepare('SELECT * FROM error_patterns WHERE id = ?').get(id) as ErrorPatternRow;
    return rowToErrorPattern(row);
  });
}

/**
 * Find an existing pattern by its normalized signature (exact match).
 * Signatures are normalized before lookup per Contract 15. Returns null if no
 * match or on failure.
 */
export function findMatchingPattern(
  errorSignature: string
): Promise<ErrorPattern | null> {
  return runQuery<ErrorPattern>(TABLE + '.findMatchingPattern', (db) => {
    const row = db
      .prepare('SELECT * FROM error_patterns WHERE error_signature = ?')
      .get(errorSignature) as ErrorPatternRow | undefined;
    return row ? rowToErrorPattern(row) : null;
  });
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
  return runQuery<ErrorPattern>(TABLE + '.updateOccurrenceCount', (db) => {
    const current = db.prepare('SELECT * FROM error_patterns WHERE id = ?').get(id) as
      | ErrorPatternRow
      | undefined;
    if (!current) return null;
    const ts = nowIso();
    db.prepare(
      'UPDATE error_patterns SET occurrence_count = ?, last_seen_at = ?, updated_at = ? WHERE id = ?'
    ).run(current.occurrence_count + 1, ts, ts, id);
    const row = db.prepare('SELECT * FROM error_patterns WHERE id = ?').get(id) as ErrorPatternRow;
    return rowToErrorPattern(row);
  });
}

/** Mutable columns of an error_pattern (everything except identity/creation/signature/category). */
export type ErrorPatternUpdate = Partial<
  Omit<ErrorPattern, 'id' | 'created_at' | 'error_signature' | 'error_category' | 'first_seen_project'>
>;

const ERROR_PATTERN_UPDATE_TRANSFORMS: Partial<Record<keyof ErrorPatternUpdate, (v: unknown) => unknown>> = {
  stack_fingerprints: (v) => toJsonText(v),
  auto_resolve_eligible: (v) => toSqliteBool(v as boolean),
};

/**
 * Patch an error_pattern by id (e.g. flip `auto_resolve_eligible` and set `success_rate`/
 * `prevention_rule`/`resolution_id` once a resolution proves reliable — Session 4's
 * write-loop closes this gap: `runAutonomousRecovery`'s auto-resolve matching requires
 * `auto_resolve_eligible = true` and `success_rate` above its threshold, but nothing previously
 * set either field after `createErrorPattern`). `updated_at` is stamped automatically. Returns
 * the updated row, or null on failure / missing id.
 */
export function updateErrorPattern(id: string, patch: ErrorPatternUpdate): Promise<ErrorPattern | null> {
  return runQuery<ErrorPattern>(TABLE + '.updateErrorPattern', (db) => {
    const keys = Object.keys(patch) as Array<keyof ErrorPatternUpdate>;
    if (keys.length === 0) {
      const row = db.prepare('SELECT * FROM error_patterns WHERE id = ?').get(id) as ErrorPatternRow | undefined;
      return row ? rowToErrorPattern(row) : null;
    }
    const ts = nowIso();
    const setParts = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { id, updated_at: ts };
    for (const k of keys) {
      const transform = ERROR_PATTERN_UPDATE_TRANSFORMS[k];
      const value = (patch as Record<string, unknown>)[k as string];
      params[k as string] = transform ? transform(value) : value;
      setParts.push(`${String(k)} = @${String(k)}`);
    }
    const result = db.prepare(`UPDATE error_patterns SET ${setParts.join(', ')} WHERE id = @id`).run(params);
    if (result.changes === 0) return null;
    const row = db.prepare('SELECT * FROM error_patterns WHERE id = ?').get(id) as ErrorPatternRow;
    return rowToErrorPattern(row);
  });
}

/**
 * List error patterns whose `trigger_prompt_pattern` matches a prompt type (e.g.
 * 'schema', 'auth', 'ui', 'api'), most-frequent first. Used by the prompt-assembler
 * (s5-p01) to inject prevention warnings into a prompt and by the failure-predictor
 * (s5-p02). Stack filtering (against `stack_fingerprints`) is left to the caller.
 * Returns null on failure.
 */
export function findPatternsByPromptType(
  promptPattern: string
): Promise<ErrorPattern[] | null> {
  return runQuery<ErrorPattern[]>(TABLE + '.findPatternsByPromptType', (db) => {
    const rows = db
      .prepare(
        'SELECT * FROM error_patterns WHERE trigger_prompt_pattern = ? ORDER BY occurrence_count DESC'
      )
      .all(promptPattern) as ErrorPatternRow[];
    return rows.map(rowToErrorPattern);
  });
}

/**
 * List patterns eligible for autonomous resolution (auto_resolve_eligible = true),
 * highest success_rate first. Returns null on failure.
 */
export function getAutoResolvable(): Promise<ErrorPattern[] | null> {
  return runQuery<ErrorPattern[]>(TABLE + '.getAutoResolvable', (db) => {
    const rows = db
      .prepare('SELECT * FROM error_patterns WHERE auto_resolve_eligible = 1 ORDER BY success_rate DESC')
      .all() as ErrorPatternRow[];
    return rows.map(rowToErrorPattern);
  });
}

/** List every error pattern, most-frequent first. Returns null on failure. */
export function listAllPatterns(): Promise<ErrorPattern[] | null> {
  return runQuery<ErrorPattern[]>(TABLE + '.listAllPatterns', (db) => {
    const rows = db
      .prepare('SELECT * FROM error_patterns ORDER BY occurrence_count DESC')
      .all() as ErrorPatternRow[];
    return rows.map(rowToErrorPattern);
  });
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
  client: MemoryDb
): Promise<ErrorMatch | null> {
  try {
    const snippet = `%${errorText.slice(0, 50)}%`;
    const rows = client
      .prepare(
        `SELECT * FROM error_patterns
         WHERE error_message_sample LIKE ? OR error_signature LIKE ?
         ORDER BY occurrence_count DESC LIMIT 10`
      )
      .all(snippet, snippet) as ErrorPatternRow[];

    if (rows.length === 0) return null;

    const target = errorText.toLowerCase();
    let best: ErrorPatternRow | null = null;
    let bestScore = 0;

    for (const row of rows) {
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

    const pattern = rowToErrorPattern(best);
    return {
      pattern,
      fix: pattern.prevention_rule,
      flagForGovernance: pattern.occurrence_count >= 3,
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
  client: MemoryDb
): Promise<void> {
  try {
    const existing = client
      .prepare('SELECT * FROM error_patterns WHERE error_signature = ?')
      .get(error.error_signature) as ErrorPatternRow | undefined;

    const ts = nowIso();
    if (existing) {
      client
        .prepare('UPDATE error_patterns SET occurrence_count = ?, last_seen_at = ?, updated_at = ? WHERE id = ?')
        .run(existing.occurrence_count + 1, ts, ts, existing.id);
    } else {
      client
        .prepare(
          `INSERT INTO error_patterns (
            id, error_signature, error_category, error_message_sample, occurrence_count,
            first_seen_at, last_seen_at, first_seen_project, stack_fingerprints, trigger_phase,
            trigger_prompt_pattern, success_rate, auto_resolve_eligible, created_at, updated_at
          ) VALUES (
            @id, @error_signature, @error_category, @error_message_sample, 1,
            @ts, @ts, @first_seen_project, '[]', @trigger_phase,
            @trigger_prompt_pattern, 0, 0, @ts, @ts
          )`
        )
        .run({
          id: newId(),
          error_signature: error.error_signature,
          error_category: error.error_category,
          error_message_sample: error.error_message_sample,
          first_seen_project: error.first_seen_project,
          trigger_phase: error.trigger_phase ?? null,
          trigger_prompt_pattern: error.trigger_prompt_pattern ?? null,
          ts,
        });
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
  client: MemoryDb
): Promise<void> {
  try {
    client
      .prepare('UPDATE error_patterns SET prevention_rule = ?, updated_at = ? WHERE id = ?')
      .run(fix, nowIso(), errorId);
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
  client: MemoryDb
): Promise<ErrorPattern[]> {
  try {
    const rows = client
      .prepare('SELECT * FROM error_patterns WHERE occurrence_count >= ? ORDER BY occurrence_count DESC')
      .all(threshold) as ErrorPatternRow[];
    return rows.map(rowToErrorPattern);
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
