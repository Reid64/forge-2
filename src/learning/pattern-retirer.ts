/**
 * FORGE 2.0 — Learning Engine: PatternRetirer.
 *
 * Weekly sweep (see src/engine/scheduler.ts) that retires dead-weight `error_patterns` rows —
 * stale (`last_seen_at` older than 30 days), zero recorded success (`success_rate = 0`), and
 * with no `resolutions` row that ever actually succeeded — into `pattern_retirement_log`.
 * See `upgrades/LEARNING_BLUEPRINT.md` § Agent: PatternRetirer and
 * `upgrades/SCHEMA_ADDITIONS.md` §4 for the schema this writes.
 *
 * `error_patterns` carries no `active` column (SCHEMA_ADDITIONS §4), so retirement there is
 * SOFT_RETIRE only: writing the `pattern_retirement_log` row IS the retirement — every
 * consuming query site anti-joins against that log (`src/learning/retirement-filter.ts`), so
 * there is no separate source-row mutation to perform ("marking a pattern retired" = the log
 * write itself). There is no `retirement_confirmed` column on `pattern_retirement_log` — it is
 * append-only, so a logged row already IS the confirmation (L3: write the log BEFORE any other
 * effect — here that log write is the only effect).
 */

import { newId, nowIso, logMemoryWarning, type MemoryDb } from '../memory/client.js';
import { getMachineId } from './database.js';
import { filterRetiredPatterns } from './retirement-filter.js';
import type { ErrorPattern } from '../types/index.js';

/** Patterns unseen this many days or longer are stale enough to consider for retirement. */
const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One `pattern_retirement_log` row PatternRetirer wrote during a sweep. */
export interface RetirementResult {
  patternId: string;
  patternFingerprint: string;
  retirementReason: 'ZERO_SUCCESS_RATE';
  actionTaken: 'SOFT_RETIRE';
  logId: string;
}

interface RetirementCandidateRow {
  id: string;
  error_signature: string;
  occurrence_count: number;
  last_seen_at: string;
  success_rate: number;
}

/**
 * Retire stale, zero-success `error_patterns` rows. A candidate qualifies when
 * `last_seen_at` is older than {@link RETENTION_DAYS} days, `success_rate = 0`, and no
 * `resolutions` row for it has ever recorded `times_succeeded > 0` (L4 — nonzero success is
 * sacred, so this is a belt-and-suspenders check against `success_rate` drifting stale).
 *
 * Already-retired candidates are dropped via {@link filterRetiredPatterns} before any log write,
 * so a re-run of this weekly sweep never double-logs the same pattern (idempotent).
 *
 * Never throws — degrades to an empty result on failure (Contract 4 / BEHAVIORAL_CONTRACTS.md).
 */
export function retirePatterns(db: MemoryDb): RetirementResult[] {
  const results: RetirementResult[] = [];
  try {
    const cutoffIso = new Date(Date.now() - RETENTION_DAYS * DAY_MS).toISOString();
    const candidates = db
      .prepare(
        `SELECT ep.id, ep.error_signature, ep.occurrence_count, ep.last_seen_at, ep.success_rate
         FROM error_patterns ep
         WHERE ep.last_seen_at < ?
           AND ep.success_rate = 0
           AND NOT EXISTS (
             SELECT 1 FROM resolutions r
             WHERE r.error_pattern_id = ep.id AND r.times_succeeded > 0
           )`
      )
      .all(cutoffIso) as RetirementCandidateRow[];

    if (candidates.length === 0) return results;

    // Anti-join against pattern_retirement_log (retirement-filter.ts) so a pattern this sweep
    // already retired in a prior run is never logged twice.
    const asPatterns = candidates.map(
      (c) => ({ id: c.id, error_signature: c.error_signature }) as unknown as ErrorPattern
    );
    const survivingIds = new Set(filterRetiredPatterns(asPatterns, db).map((p) => p.id));
    if (survivingIds.size === 0) return results;

    const machineId = getMachineId();
    const insert = db.prepare(
      `INSERT INTO pattern_retirement_log (
        id, pattern_table, pattern_id, pattern_fingerprint, retirement_reason,
        times_applied_before_retirement, times_succeeded_before_retirement,
        success_rate_at_retirement, last_seen_before_retirement, superseded_by_pattern_id,
        action_taken, retired_at, machine_id, created_at
      ) VALUES (
        @id, 'error_patterns', @pattern_id, @pattern_fingerprint, 'ZERO_SUCCESS_RATE',
        @times_applied_before_retirement, 0, @success_rate_at_retirement,
        @last_seen_before_retirement, NULL, 'SOFT_RETIRE', @retired_at, @machine_id, @created_at
      )`
    );

    for (const candidate of candidates) {
      if (!survivingIds.has(candidate.id)) continue; // already retired — skip (idempotent)

      const ts = nowIso();
      const logId = newId();
      // Write pattern_retirement_log BEFORE any other effect (L3). For error_patterns (no
      // `active` column) this log write IS the retirement — "mark pattern retired" has no
      // further source-row mutation to perform.
      insert.run({
        id: logId,
        pattern_id: candidate.id,
        pattern_fingerprint: candidate.error_signature,
        times_applied_before_retirement: candidate.occurrence_count,
        success_rate_at_retirement: candidate.success_rate,
        last_seen_before_retirement: candidate.last_seen_at,
        retired_at: ts,
        machine_id: machineId,
        created_at: ts,
      });

      results.push({
        patternId: candidate.id,
        patternFingerprint: candidate.error_signature,
        retirementReason: 'ZERO_SUCCESS_RATE',
        actionTaken: 'SOFT_RETIRE',
        logId,
      });
    }
  } catch (err) {
    logMemoryWarning('pattern-retirer.retirePatterns', err);
  }
  return results;
}
