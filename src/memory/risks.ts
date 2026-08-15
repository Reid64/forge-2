/**
 * FORGE 2.0 — Build Memory: risks CRUD.
 *
 * Persistence for the risk register. See src/learning/database.ts ›
 * GOVERNANCE_LEDGERS_SCHEMA_SQL › risks and `src/governance/provenance-ledgers.ts` for
 * severity-score computation.
 *
 * Per BEHAVIORAL_CONTRACTS.md Contract 4: every helper degrades gracefully — when Build Memory
 * is unreachable they log a warning and return null.
 */

import type { Risk, RiskStatus } from '../types/index.js';
import { newId, nowIso, runQuery } from './client.js';

const TABLE = 'risks';

/** Fields required to record a new risk. `severity_score` is derived by the caller (probability * impact). */
export type NewRisk = Pick<Risk, 'project_name' | 'project_path' | 'title' | 'description' | 'category' | 'probability' | 'impact' | 'severity_score'> &
  Partial<
    Omit<Risk, 'id' | 'created_at' | 'updated_at' | 'project_name' | 'project_path' | 'title' | 'description' | 'category' | 'probability' | 'impact' | 'severity_score'>
  >;

/** Mutable columns of a risk (everything except identity/creation). */
export type RiskUpdate = Partial<Omit<Risk, 'id' | 'project_name' | 'project_path' | 'created_at'>>;

interface RiskRow {
  id: string;
  project_name: string;
  project_path: string;
  title: string;
  description: string;
  category: string;
  probability: number;
  impact: number;
  severity_score: number;
  status: string;
  mitigation_plan: string | null;
  owner: string | null;
  related_adr_id: string | null;
  related_assumption_id: string | null;
  build_run_id: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRisk(row: RiskRow): Risk {
  return {
    id: row.id,
    project_name: row.project_name,
    project_path: row.project_path,
    title: row.title,
    description: row.description,
    category: row.category as Risk['category'],
    probability: row.probability,
    impact: row.impact,
    severity_score: row.severity_score,
    status: row.status as RiskStatus,
    mitigation_plan: row.mitigation_plan,
    owner: row.owner,
    related_adr_id: row.related_adr_id,
    related_assumption_id: row.related_assumption_id,
    build_run_id: row.build_run_id,
    closed_at: row.closed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Insert a new risk. Returns the created row, or null on failure. */
export function createRisk(input: NewRisk): Promise<Risk | null> {
  return runQuery<Risk>(TABLE + '.createRisk', (db) => {
    const id = newId();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO risks (
        id, project_name, project_path, title, description, category, probability, impact,
        severity_score, status, mitigation_plan, owner, related_adr_id, related_assumption_id,
        build_run_id, closed_at, created_at, updated_at
      ) VALUES (
        @id, @project_name, @project_path, @title, @description, @category, @probability, @impact,
        @severity_score, @status, @mitigation_plan, @owner, @related_adr_id, @related_assumption_id,
        @build_run_id, @closed_at, @created_at, @updated_at
      )`
    ).run({
      id,
      project_name: input.project_name,
      project_path: input.project_path,
      title: input.title,
      description: input.description,
      category: input.category,
      probability: input.probability,
      impact: input.impact,
      severity_score: input.severity_score,
      status: input.status ?? 'open',
      mitigation_plan: input.mitigation_plan ?? null,
      owner: input.owner ?? null,
      related_adr_id: input.related_adr_id ?? null,
      related_assumption_id: input.related_assumption_id ?? null,
      build_run_id: input.build_run_id ?? null,
      closed_at: input.closed_at ?? null,
      created_at: ts,
      updated_at: ts,
    });
    const row = db.prepare('SELECT * FROM risks WHERE id = ?').get(id) as RiskRow;
    return rowToRisk(row);
  });
}

/** Patch an existing risk by id. `updated_at` is stamped automatically. Returns the updated row, or null. */
export function updateRisk(id: string, patch: RiskUpdate): Promise<Risk | null> {
  return runQuery<Risk>(TABLE + '.updateRisk', (db) => {
    const ts = nowIso();
    const params: Record<string, unknown> = { id, updated_at: ts };
    const setParts = ['updated_at = @updated_at'];
    for (const [k, v] of Object.entries(patch)) {
      params[k] = v;
      setParts.push(`${k} = @${k}`);
    }
    const result = db.prepare(`UPDATE risks SET ${setParts.join(', ')} WHERE id = @id`).run(params);
    if (result.changes === 0) return null;
    const row = db.prepare('SELECT * FROM risks WHERE id = ?').get(id) as RiskRow;
    return rowToRisk(row);
  });
}

/** Fetch a single risk by id. Returns null if not found or on failure. */
export function getRiskById(id: string): Promise<Risk | null> {
  return runQuery<Risk>(TABLE + '.getRiskById', (db) => {
    const row = db.prepare('SELECT * FROM risks WHERE id = ?').get(id) as RiskRow | undefined;
    return row ? rowToRisk(row) : null;
  });
}

/**
 * List every risk for a project, highest severity first. Optionally filter by status.
 * Returns null on failure.
 */
export function listRisksByProject(projectName: string, status?: RiskStatus): Promise<Risk[] | null> {
  return runQuery<Risk[]>(TABLE + '.listRisksByProject', (db) => {
    const rows = status
      ? (db
          .prepare('SELECT * FROM risks WHERE project_name = ? AND status = ? ORDER BY severity_score DESC, created_at DESC')
          .all(projectName, status) as RiskRow[])
      : (db
          .prepare('SELECT * FROM risks WHERE project_name = ? ORDER BY severity_score DESC, created_at DESC')
          .all(projectName) as RiskRow[]);
    return rows.map(rowToRisk);
  });
}
