/**
 * FORGE 2.0 — Build Memory: resolutions CRUD.
 *
 * Proven fixes for error patterns. See SCHEMA_REGISTRY.md › resolutions.
 */

import type { Resolution } from '../types/index.js';
import { runQuery } from './client.js';

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

/** Insert a new resolution row. Returns the created row, or null. */
export function createResolution(
  input: NewResolution
): Promise<Resolution | null> {
  return runQuery<Resolution>('createResolution', async (c) =>
    c.from(TABLE).insert(input).select().single()
  );
}

/**
 * Get the most recent resolution for an error pattern. Returns null if none or
 * on failure.
 */
export function getResolutionForPattern(
  errorPatternId: string
): Promise<Resolution | null> {
  return runQuery<Resolution>('getResolutionForPattern', async (c) =>
    c
      .from(TABLE)
      .select('*')
      .eq('error_pattern_id', errorPatternId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  );
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
  const current = await runQuery<Resolution>('incrementApplied.read', async (c) =>
    c.from(TABLE).select('*').eq('id', id).maybeSingle()
  );
  if (!current) return null;

  return runQuery<Resolution>('incrementApplied.write', async (c) =>
    c
      .from(TABLE)
      .update({
        times_applied: current.times_applied + 1,
        times_succeeded: current.times_succeeded + (succeeded ? 1 : 0),
        times_failed: current.times_failed + (succeeded ? 0 : 1),
      })
      .eq('id', id)
      .select()
      .single()
  );
}
