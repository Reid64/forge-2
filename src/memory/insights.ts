/**
 * FORGE 2.0 — Build Memory: cross_project_insights CRUD.
 *
 * Learnings transferable between projects. See SCHEMA_REGISTRY.md ›
 * cross_project_insights.
 */

import type { CrossProjectInsight, JsonObject } from '../types/index.js';
import { runQuery } from './client.js';

const TABLE = 'cross_project_insights';

/** Fields required to record an insight (NOT NULL, no DB default). */
export type NewCrossProjectInsight = Pick<
  CrossProjectInsight,
  'insight_type' | 'source_project' | 'description' | 'evidence'
> &
  Partial<
    Omit<
      CrossProjectInsight,
      | 'id'
      | 'created_at'
      | 'insight_type'
      | 'source_project'
      | 'description'
      | 'evidence'
    >
  >;

/** Insert a new cross_project_insight row. Returns the created row, or null. */
export function createInsight(
  input: NewCrossProjectInsight
): Promise<CrossProjectInsight | null> {
  return runQuery<CrossProjectInsight>('createInsight', async (c) =>
    c.from(TABLE).insert(input).select().single()
  );
}

/**
 * Find insights whose `applicable_fingerprints` contains the given stack
 * fingerprint. With no fingerprint, returns all insights (newest first).
 * Returns null on failure.
 */
export function findApplicableInsights(
  fingerprint?: JsonObject
): Promise<CrossProjectInsight[] | null> {
  return runQuery<CrossProjectInsight[]>('findApplicableInsights', async (c) => {
    const base = c.from(TABLE).select('*');
    const filtered =
      fingerprint !== undefined
        ? base.contains('applicable_fingerprints', [fingerprint])
        : base;
    return filtered.order('created_at', { ascending: false });
  });
}

/**
 * Increment applied_count for an insight (read-then-write, single-operator/local).
 * Returns the updated row, or null on failure.
 */
export async function incrementApplied(
  id: string
): Promise<CrossProjectInsight | null> {
  const current = await runQuery<CrossProjectInsight>(
    'incrementApplied.read',
    async (c) => c.from(TABLE).select('*').eq('id', id).maybeSingle()
  );
  if (!current) return null;

  return runQuery<CrossProjectInsight>('incrementApplied.write', async (c) =>
    c
      .from(TABLE)
      .update({ applied_count: current.applied_count + 1 })
      .eq('id', id)
      .select()
      .single()
  );
}
