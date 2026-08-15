/**
 * FORGE 2.0 — Build Memory: tech_debt_items CRUD.
 *
 * Persistence for the tech-debt ledger. See src/learning/database.ts ›
 * GOVERNANCE_LEDGERS_SCHEMA_SQL › tech_debt_items and `src/governance/provenance-ledgers.ts` for
 * seeding entries from real findings tables (`dead_code_findings`, `schema_drift_findings`,
 * `dependency_audit_findings`, `adversary_findings`).
 *
 * Per BEHAVIORAL_CONTRACTS.md Contract 4: every helper degrades gracefully — when Build Memory
 * is unreachable they log a warning and return null.
 */

import type { TechDebtItem, TechDebtStatus } from '../types/index.js';
import { newId, nowIso, runQuery } from './client.js';

const TABLE = 'tech_debt_items';

/** Fields required to record a new tech-debt item. */
export type NewTechDebtItem = Pick<TechDebtItem, 'project_name' | 'project_path' | 'title' | 'description' | 'category' | 'severity'> &
  Partial<
    Omit<TechDebtItem, 'id' | 'created_at' | 'updated_at' | 'project_name' | 'project_path' | 'title' | 'description' | 'category' | 'severity'>
  >;

/** Mutable columns of a tech-debt item (everything except identity/creation). */
export type TechDebtItemUpdate = Partial<Omit<TechDebtItem, 'id' | 'project_name' | 'project_path' | 'created_at'>>;

interface TechDebtItemRow {
  id: string;
  project_name: string;
  project_path: string;
  title: string;
  description: string;
  category: string;
  severity: string;
  effort_estimate: string;
  status: string;
  file_path: string | null;
  source: string;
  source_finding_id: string | null;
  introduced_build_id: string | null;
  resolved_build_id: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToItem(row: TechDebtItemRow): TechDebtItem {
  return {
    id: row.id,
    project_name: row.project_name,
    project_path: row.project_path,
    title: row.title,
    description: row.description,
    category: row.category as TechDebtItem['category'],
    severity: row.severity as TechDebtItem['severity'],
    effort_estimate: row.effort_estimate as TechDebtItem['effort_estimate'],
    status: row.status as TechDebtStatus,
    file_path: row.file_path,
    source: row.source as TechDebtItem['source'],
    source_finding_id: row.source_finding_id,
    introduced_build_id: row.introduced_build_id,
    resolved_build_id: row.resolved_build_id,
    resolved_at: row.resolved_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Insert a new tech-debt item, or return the existing row unchanged when one already exists for
 * the same `(project_name, source, source_finding_id)` — the dedup key `idx_tech_debt_dedup`
 * enforces (manual entries have `source_finding_id: null`, which is never deduped, matching the
 * partial-unique-index semantics). Returns null on failure.
 */
export function createTechDebtItem(input: NewTechDebtItem): Promise<TechDebtItem | null> {
  return runQuery<TechDebtItem>(TABLE + '.createTechDebtItem', (db) => {
    const source = input.source ?? 'manual';
    const sourceFindingId = input.source_finding_id ?? null;
    if (sourceFindingId !== null) {
      const existing = db
        .prepare('SELECT * FROM tech_debt_items WHERE project_name = ? AND source = ? AND source_finding_id = ?')
        .get(input.project_name, source, sourceFindingId) as TechDebtItemRow | undefined;
      if (existing) return rowToItem(existing);
    }

    const id = newId();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO tech_debt_items (
        id, project_name, project_path, title, description, category, severity, effort_estimate,
        status, file_path, source, source_finding_id, introduced_build_id, resolved_build_id,
        resolved_at, created_at, updated_at
      ) VALUES (
        @id, @project_name, @project_path, @title, @description, @category, @severity, @effort_estimate,
        @status, @file_path, @source, @source_finding_id, @introduced_build_id, @resolved_build_id,
        @resolved_at, @created_at, @updated_at
      )`
    ).run({
      id,
      project_name: input.project_name,
      project_path: input.project_path,
      title: input.title,
      description: input.description,
      category: input.category,
      severity: input.severity,
      effort_estimate: input.effort_estimate ?? 'unknown',
      status: input.status ?? 'open',
      file_path: input.file_path ?? null,
      source,
      source_finding_id: sourceFindingId,
      introduced_build_id: input.introduced_build_id ?? null,
      resolved_build_id: input.resolved_build_id ?? null,
      resolved_at: input.resolved_at ?? null,
      created_at: ts,
      updated_at: ts,
    });
    const row = db.prepare('SELECT * FROM tech_debt_items WHERE id = ?').get(id) as TechDebtItemRow;
    return rowToItem(row);
  });
}

/** Patch an existing tech-debt item by id. `updated_at` is stamped automatically. Returns the updated row, or null. */
export function updateTechDebtItem(id: string, patch: TechDebtItemUpdate): Promise<TechDebtItem | null> {
  return runQuery<TechDebtItem>(TABLE + '.updateTechDebtItem', (db) => {
    const ts = nowIso();
    const params: Record<string, unknown> = { id, updated_at: ts };
    const setParts = ['updated_at = @updated_at'];
    for (const [k, v] of Object.entries(patch)) {
      params[k] = v;
      setParts.push(`${k} = @${k}`);
    }
    const result = db.prepare(`UPDATE tech_debt_items SET ${setParts.join(', ')} WHERE id = @id`).run(params);
    if (result.changes === 0) return null;
    const row = db.prepare('SELECT * FROM tech_debt_items WHERE id = ?').get(id) as TechDebtItemRow;
    return rowToItem(row);
  });
}

/** Fetch a single tech-debt item by id. Returns null if not found or on failure. */
export function getTechDebtItemById(id: string): Promise<TechDebtItem | null> {
  return runQuery<TechDebtItem>(TABLE + '.getTechDebtItemById', (db) => {
    const row = db.prepare('SELECT * FROM tech_debt_items WHERE id = ?').get(id) as TechDebtItemRow | undefined;
    return row ? rowToItem(row) : null;
  });
}

/**
 * Fetch a tech-debt item by its dedup key (`project_name`, `source`, `source_finding_id`) — the
 * same key {@link createTechDebtItem} checks before inserting. Used by seeding callers to tell
 * "already ledgered" apart from "newly created" without relying on a synthetic row id. Returns
 * null if no row matches or on failure.
 */
export function getTechDebtItemBySource(
  projectName: string,
  source: TechDebtItem['source'],
  sourceFindingId: string
): Promise<TechDebtItem | null> {
  return runQuery<TechDebtItem>(TABLE + '.getTechDebtItemBySource', (db) => {
    const row = db
      .prepare('SELECT * FROM tech_debt_items WHERE project_name = ? AND source = ? AND source_finding_id = ?')
      .get(projectName, source, sourceFindingId) as TechDebtItemRow | undefined;
    return row ? rowToItem(row) : null;
  });
}

/**
 * List every tech-debt item for a project, most severe first (critical > high > medium > low,
 * then newest first within a severity). Optionally filter by status. Returns null on failure.
 */
export function listTechDebtByProject(projectName: string, status?: TechDebtStatus): Promise<TechDebtItem[] | null> {
  return runQuery<TechDebtItem[]>(TABLE + '.listTechDebtByProject', (db) => {
    const severityRank = `CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;
    const rows = status
      ? (db
          .prepare(`SELECT * FROM tech_debt_items WHERE project_name = ? AND status = ? ORDER BY ${severityRank} ASC, created_at DESC`)
          .all(projectName, status) as TechDebtItemRow[])
      : (db
          .prepare(`SELECT * FROM tech_debt_items WHERE project_name = ? ORDER BY ${severityRank} ASC, created_at DESC`)
          .all(projectName) as TechDebtItemRow[]);
    return rows.map(rowToItem);
  });
}
