/**
 * FORGE 2.0 — Build Memory: assumptions CRUD.
 *
 * Persistence for the assumption registry. See src/learning/database.ts ›
 * GOVERNANCE_LEDGERS_SCHEMA_SQL › assumptions and `src/governance/provenance-ledgers.ts` for
 * validation/staleness logic.
 *
 * Per BEHAVIORAL_CONTRACTS.md Contract 4: every helper degrades gracefully — when Build Memory
 * is unreachable they log a warning and return null.
 */

import type { Assumption, AssumptionStatus } from '../types/index.js';
import { newId, nowIso, runQuery } from './client.js';

const TABLE = 'assumptions';

/** Fields required to record a new assumption. */
export type NewAssumption = Pick<Assumption, 'project_name' | 'project_path' | 'statement' | 'category' | 'impact_if_wrong'> &
  Partial<
    Omit<Assumption, 'id' | 'created_at' | 'updated_at' | 'project_name' | 'project_path' | 'statement' | 'category' | 'impact_if_wrong'>
  >;

/** Mutable columns of an assumption (everything except identity/creation). */
export type AssumptionUpdate = Partial<Omit<Assumption, 'id' | 'project_name' | 'project_path' | 'created_at'>>;

interface AssumptionRow {
  id: string;
  project_name: string;
  project_path: string;
  statement: string;
  category: string;
  status: string;
  confidence: number | null;
  impact_if_wrong: string;
  owner: string | null;
  related_adr_id: string | null;
  validation_method: string | null;
  validation_evidence: string | null;
  validated_at: string | null;
  build_run_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToAssumption(row: AssumptionRow): Assumption {
  return {
    id: row.id,
    project_name: row.project_name,
    project_path: row.project_path,
    statement: row.statement,
    category: row.category as Assumption['category'],
    status: row.status as AssumptionStatus,
    confidence: row.confidence,
    impact_if_wrong: row.impact_if_wrong,
    owner: row.owner,
    related_adr_id: row.related_adr_id,
    validation_method: row.validation_method,
    validation_evidence: row.validation_evidence,
    validated_at: row.validated_at,
    build_run_id: row.build_run_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Insert a new assumption. Returns the created row, or null on failure. */
export function createAssumption(input: NewAssumption): Promise<Assumption | null> {
  return runQuery<Assumption>(TABLE + '.createAssumption', (db) => {
    const id = newId();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO assumptions (
        id, project_name, project_path, statement, category, status, confidence,
        impact_if_wrong, owner, related_adr_id, validation_method, validation_evidence,
        validated_at, build_run_id, created_at, updated_at
      ) VALUES (
        @id, @project_name, @project_path, @statement, @category, @status, @confidence,
        @impact_if_wrong, @owner, @related_adr_id, @validation_method, @validation_evidence,
        @validated_at, @build_run_id, @created_at, @updated_at
      )`
    ).run({
      id,
      project_name: input.project_name,
      project_path: input.project_path,
      statement: input.statement,
      category: input.category,
      status: input.status ?? 'unvalidated',
      confidence: input.confidence ?? null,
      impact_if_wrong: input.impact_if_wrong,
      owner: input.owner ?? null,
      related_adr_id: input.related_adr_id ?? null,
      validation_method: input.validation_method ?? null,
      validation_evidence: input.validation_evidence ?? null,
      validated_at: input.validated_at ?? null,
      build_run_id: input.build_run_id ?? null,
      created_at: ts,
      updated_at: ts,
    });
    const row = db.prepare('SELECT * FROM assumptions WHERE id = ?').get(id) as AssumptionRow;
    return rowToAssumption(row);
  });
}

/** Patch an existing assumption by id. `updated_at` is stamped automatically. Returns the updated row, or null. */
export function updateAssumption(id: string, patch: AssumptionUpdate): Promise<Assumption | null> {
  return runQuery<Assumption>(TABLE + '.updateAssumption', (db) => {
    const ts = nowIso();
    const params: Record<string, unknown> = { id, updated_at: ts };
    const setParts = ['updated_at = @updated_at'];
    for (const [k, v] of Object.entries(patch)) {
      params[k] = v;
      setParts.push(`${k} = @${k}`);
    }
    const result = db.prepare(`UPDATE assumptions SET ${setParts.join(', ')} WHERE id = @id`).run(params);
    if (result.changes === 0) return null;
    const row = db.prepare('SELECT * FROM assumptions WHERE id = ?').get(id) as AssumptionRow;
    return rowToAssumption(row);
  });
}

/** Fetch a single assumption by id. Returns null if not found or on failure. */
export function getAssumptionById(id: string): Promise<Assumption | null> {
  return runQuery<Assumption>(TABLE + '.getAssumptionById', (db) => {
    const row = db.prepare('SELECT * FROM assumptions WHERE id = ?').get(id) as AssumptionRow | undefined;
    return row ? rowToAssumption(row) : null;
  });
}

/** List every assumption for a project, newest first. Optionally filter by status. Returns null on failure. */
export function listAssumptionsByProject(projectName: string, status?: AssumptionStatus): Promise<Assumption[] | null> {
  return runQuery<Assumption[]>(TABLE + '.listAssumptionsByProject', (db) => {
    const rows = status
      ? (db
          .prepare('SELECT * FROM assumptions WHERE project_name = ? AND status = ? ORDER BY created_at DESC')
          .all(projectName, status) as AssumptionRow[])
      : (db.prepare('SELECT * FROM assumptions WHERE project_name = ? ORDER BY created_at DESC').all(projectName) as AssumptionRow[]);
    return rows.map(rowToAssumption);
  });
}
