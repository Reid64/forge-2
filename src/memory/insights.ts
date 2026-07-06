/**
 * FORGE 2.0 — Build Memory: cross_project_insights CRUD.
 *
 * Learnings transferable between projects. See src/learning/database.ts ›
 * BUILD_MEMORY_SCHEMA_SQL › cross_project_insights.
 */

import type { CrossProjectInsight, JsonObject } from '../types/index.js';
import { fromJsonText, newId, nowIso, runQuery, toJsonText } from './client.js';

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

interface CrossProjectInsightRow {
  id: string;
  insight_type: string;
  source_project: string;
  source_build_id: string | null;
  applicable_fingerprints: string;
  description: string;
  evidence: string;
  applied_count: number;
  effectiveness_score: number | null;
  created_at: string;
}

function rowToInsight(row: CrossProjectInsightRow): CrossProjectInsight {
  return {
    id: row.id,
    insight_type: row.insight_type as CrossProjectInsight['insight_type'],
    source_project: row.source_project,
    source_build_id: row.source_build_id,
    applicable_fingerprints: fromJsonText(row.applicable_fingerprints, []),
    description: row.description,
    evidence: fromJsonText(row.evidence, {}),
    applied_count: row.applied_count,
    effectiveness_score: row.effectiveness_score,
    created_at: row.created_at,
  };
}

/** Insert a new cross_project_insight row. Returns the created row, or null. */
export function createInsight(
  input: NewCrossProjectInsight
): Promise<CrossProjectInsight | null> {
  return runQuery<CrossProjectInsight>(TABLE + '.createInsight', (db) => {
    const id = newId();
    db.prepare(
      `INSERT INTO cross_project_insights (
        id, insight_type, source_project, source_build_id, applicable_fingerprints,
        description, evidence, applied_count, effectiveness_score, created_at
      ) VALUES (
        @id, @insight_type, @source_project, @source_build_id, @applicable_fingerprints,
        @description, @evidence, @applied_count, @effectiveness_score, @created_at
      )`
    ).run({
      id,
      insight_type: input.insight_type,
      source_project: input.source_project,
      source_build_id: input.source_build_id ?? null,
      applicable_fingerprints: toJsonText(input.applicable_fingerprints ?? []),
      description: input.description,
      evidence: toJsonText(input.evidence),
      applied_count: input.applied_count ?? 0,
      effectiveness_score: input.effectiveness_score ?? null,
      created_at: nowIso(),
    });
    const row = db.prepare('SELECT * FROM cross_project_insights WHERE id = ?').get(id) as CrossProjectInsightRow;
    return rowToInsight(row);
  });
}

/**
 * Find insights whose `applicable_fingerprints` contains the given stack
 * fingerprint. With no fingerprint, returns all insights (newest first).
 * Returns null on failure.
 */
export function findApplicableInsights(
  fingerprint?: JsonObject
): Promise<CrossProjectInsight[] | null> {
  return runQuery<CrossProjectInsight[]>(TABLE + '.findApplicableInsights', (db) => {
    const rows = db
      .prepare('SELECT * FROM cross_project_insights ORDER BY created_at DESC')
      .all() as CrossProjectInsightRow[];
    const insights = rows.map(rowToInsight);
    if (fingerprint === undefined) return insights;
    const needle = JSON.stringify(fingerprint);
    return insights.filter((i) => i.applicable_fingerprints.some((fp) => JSON.stringify(fp) === needle));
  });
}

/**
 * Increment applied_count for an insight (read-then-write, single-operator/local).
 * Returns the updated row, or null on failure.
 */
export async function incrementApplied(
  id: string
): Promise<CrossProjectInsight | null> {
  return runQuery<CrossProjectInsight>(TABLE + '.incrementApplied', (db) => {
    const current = db.prepare('SELECT * FROM cross_project_insights WHERE id = ?').get(id) as
      | CrossProjectInsightRow
      | undefined;
    if (!current) return null;
    db.prepare('UPDATE cross_project_insights SET applied_count = ? WHERE id = ?').run(
      current.applied_count + 1,
      id
    );
    const row = db.prepare('SELECT * FROM cross_project_insights WHERE id = ?').get(id) as CrossProjectInsightRow;
    return rowToInsight(row);
  });
}
