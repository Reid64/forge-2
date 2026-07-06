/**
 * FORGE 2.0 — Build Memory: resolutions CRUD.
 *
 * Proven fixes for error patterns. See src/learning/database.ts ›
 * BUILD_MEMORY_SCHEMA_SQL › resolutions.
 */

import type { Resolution } from '../types/index.js';
import { fromJsonText, newId, nowIso, runQuery, toJsonText } from './client.js';

const TABLE = 'resolutions';

/** Fields required to record a resolution (NOT NULL, no DB default). */
export type NewResolution = Pick<
  Resolution,
  | 'error_pattern_id'
  | 'resolution_type'
  | 'resolution_description'
  | 'resolution_steps'
> &
  Partial<
    Omit<
      Resolution,
      | 'id'
      | 'created_at'
      | 'error_pattern_id'
      | 'resolution_type'
      | 'resolution_description'
      | 'resolution_steps'
    >
  >;

interface ResolutionRow {
  id: string;
  error_pattern_id: string;
  resolution_type: string;
  resolution_description: string;
  resolution_steps: string;
  times_applied: number;
  times_succeeded: number;
  times_failed: number;
  created_at: string;
}

function rowToResolution(row: ResolutionRow): Resolution {
  return {
    id: row.id,
    error_pattern_id: row.error_pattern_id,
    resolution_type: row.resolution_type as Resolution['resolution_type'],
    resolution_description: row.resolution_description,
    resolution_steps: fromJsonText(row.resolution_steps, []),
    times_applied: row.times_applied,
    times_succeeded: row.times_succeeded,
    times_failed: row.times_failed,
    created_at: row.created_at,
  };
}

/** Insert a new resolution row. Returns the created row, or null. */
export function createResolution(
  input: NewResolution
): Promise<Resolution | null> {
  return runQuery<Resolution>(TABLE + '.createResolution', (db) => {
    const id = newId();
    db.prepare(
      `INSERT INTO resolutions (
        id, error_pattern_id, resolution_type, resolution_description, resolution_steps,
        times_applied, times_succeeded, times_failed, created_at
      ) VALUES (
        @id, @error_pattern_id, @resolution_type, @resolution_description, @resolution_steps,
        @times_applied, @times_succeeded, @times_failed, @created_at
      )`
    ).run({
      id,
      error_pattern_id: input.error_pattern_id,
      resolution_type: input.resolution_type,
      resolution_description: input.resolution_description,
      resolution_steps: toJsonText(input.resolution_steps),
      times_applied: input.times_applied ?? 0,
      times_succeeded: input.times_succeeded ?? 0,
      times_failed: input.times_failed ?? 0,
      created_at: nowIso(),
    });
    const row = db.prepare('SELECT * FROM resolutions WHERE id = ?').get(id) as ResolutionRow;
    return rowToResolution(row);
  });
}

/**
 * Get the most recent resolution for an error pattern. Returns null if none or
 * on failure.
 */
export function getResolutionForPattern(
  errorPatternId: string
): Promise<Resolution | null> {
  return runQuery<Resolution>(TABLE + '.getResolutionForPattern', (db) => {
    const row = db
      .prepare(
        'SELECT * FROM resolutions WHERE error_pattern_id = ? ORDER BY created_at DESC LIMIT 1'
      )
      .get(errorPatternId) as ResolutionRow | undefined;
    return row ? rowToResolution(row) : null;
  });
}

/**
 * Record an application of a resolution: always increments times_applied, and
 * increments times_succeeded or times_failed based on `succeeded`.
 *
 * Read-then-write (single-operator/local). Returns the updated row, or null.
 */
export async function incrementApplied(
  id: string,
  succeeded = true
): Promise<Resolution | null> {
  return runQuery<Resolution>(TABLE + '.incrementApplied', (db) => {
    const current = db.prepare('SELECT * FROM resolutions WHERE id = ?').get(id) as
      | ResolutionRow
      | undefined;
    if (!current) return null;
    db.prepare(
      'UPDATE resolutions SET times_applied = ?, times_succeeded = ?, times_failed = ? WHERE id = ?'
    ).run(
      current.times_applied + 1,
      current.times_succeeded + (succeeded ? 1 : 0),
      current.times_failed + (succeeded ? 0 : 1),
      id
    );
    const row = db.prepare('SELECT * FROM resolutions WHERE id = ?').get(id) as ResolutionRow;
    return rowToResolution(row);
  });
}
