/**
 * FORGE 2.0 — Build Memory: adr_records CRUD.
 *
 * Persistence for the ADR (Architecture Decision Record) provenance log. See
 * src/learning/database.ts › GOVERNANCE_LEDGERS_SCHEMA_SQL › adr_records and
 * `src/governance/provenance-ledgers.ts` for the higher-level numbering/supersede-chain logic.
 *
 * Per BEHAVIORAL_CONTRACTS.md Contract 4: every helper degrades gracefully — when Build Memory
 * is unreachable they log a warning and return null.
 */

import type { AdrRecord, AdrStatus } from '../types/index.js';
import { fromJsonText, newId, nowIso, runQuery, toJsonText } from './client.js';

const TABLE = 'adr_records';

/** Fields required to record a new ADR. `adr_number` is assigned by the caller (see provenance-ledgers.ts). */
export type NewAdrRecord = Pick<
  AdrRecord,
  'project_name' | 'project_path' | 'adr_number' | 'title' | 'context' | 'decision' | 'decided_by'
> &
  Partial<
    Omit<
      AdrRecord,
      'id' | 'created_at' | 'updated_at' | 'project_name' | 'project_path' | 'adr_number' | 'title' | 'context' | 'decision' | 'decided_by'
    >
  >;

/** Mutable columns of an adr_record (everything except identity/creation). */
export type AdrRecordUpdate = Partial<Omit<AdrRecord, 'id' | 'project_name' | 'project_path' | 'adr_number' | 'created_at'>>;

interface AdrRecordRow {
  id: string;
  project_name: string;
  project_path: string;
  adr_number: number;
  title: string;
  status: string;
  context: string;
  decision: string;
  consequences: string | null;
  alternatives_considered: string;
  decided_by: string;
  source: string | null;
  related_files: string;
  supersedes: string | null;
  superseded_by: string | null;
  build_run_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToAdr(row: AdrRecordRow): AdrRecord {
  return {
    id: row.id,
    project_name: row.project_name,
    project_path: row.project_path,
    adr_number: row.adr_number,
    title: row.title,
    status: row.status as AdrStatus,
    context: row.context,
    decision: row.decision,
    consequences: row.consequences,
    alternatives_considered: fromJsonText(row.alternatives_considered, []),
    decided_by: row.decided_by,
    source: row.source,
    related_files: fromJsonText(row.related_files, []),
    supersedes: row.supersedes,
    superseded_by: row.superseded_by,
    build_run_id: row.build_run_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The highest `adr_number` recorded for `projectName`, or 0 if none exist yet / Build Memory is unreachable. */
export async function getMaxAdrNumber(projectName: string): Promise<number> {
  const max = await runQuery<number>(TABLE + '.getMaxAdrNumber', (db) => {
    const row = db
      .prepare('SELECT MAX(adr_number) as m FROM adr_records WHERE project_name = ?')
      .get(projectName) as { m: number | null };
    return row.m ?? 0;
  });
  return max ?? 0;
}

/** Insert a new ADR record. Returns the created row, or null on failure. */
export async function createAdr(input: NewAdrRecord): Promise<AdrRecord | null> {
  return runQuery<AdrRecord>(TABLE + '.createAdr', (db) => {
    const id = newId();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO adr_records (
        id, project_name, project_path, adr_number, title, status, context, decision,
        consequences, alternatives_considered, decided_by, source, related_files,
        supersedes, superseded_by, build_run_id, created_at, updated_at
      ) VALUES (
        @id, @project_name, @project_path, @adr_number, @title, @status, @context, @decision,
        @consequences, @alternatives_considered, @decided_by, @source, @related_files,
        @supersedes, @superseded_by, @build_run_id, @created_at, @updated_at
      )`
    ).run({
      id,
      project_name: input.project_name,
      project_path: input.project_path,
      adr_number: input.adr_number,
      title: input.title,
      status: input.status ?? 'proposed',
      context: input.context,
      decision: input.decision,
      consequences: input.consequences ?? null,
      alternatives_considered: toJsonText(input.alternatives_considered ?? []),
      decided_by: input.decided_by,
      source: input.source ?? null,
      related_files: toJsonText(input.related_files ?? []),
      supersedes: input.supersedes ?? null,
      superseded_by: input.superseded_by ?? null,
      build_run_id: input.build_run_id ?? null,
      created_at: ts,
      updated_at: ts,
    });
    const row = db.prepare('SELECT * FROM adr_records WHERE id = ?').get(id) as AdrRecordRow;
    return rowToAdr(row);
  });
}

/** Patch an existing ADR by id. `updated_at` is stamped automatically. Returns the updated row, or null. */
export function updateAdr(id: string, patch: AdrRecordUpdate): Promise<AdrRecord | null> {
  return runQuery<AdrRecord>(TABLE + '.updateAdr', (db) => {
    const ts = nowIso();
    const params: Record<string, unknown> = { id, updated_at: ts };
    const setParts = ['updated_at = @updated_at'];
    const jsonCols = new Set(['alternatives_considered', 'related_files']);
    for (const [k, v] of Object.entries(patch)) {
      params[k] = jsonCols.has(k) ? toJsonText(v) : v;
      setParts.push(`${k} = @${k}`);
    }
    const result = db.prepare(`UPDATE adr_records SET ${setParts.join(', ')} WHERE id = @id`).run(params);
    if (result.changes === 0) return null;
    const row = db.prepare('SELECT * FROM adr_records WHERE id = ?').get(id) as AdrRecordRow;
    return rowToAdr(row);
  });
}

/** Fetch a single ADR by id. Returns null if not found or on failure. */
export function getAdrById(id: string): Promise<AdrRecord | null> {
  return runQuery<AdrRecord>(TABLE + '.getAdrById', (db) => {
    const row = db.prepare('SELECT * FROM adr_records WHERE id = ?').get(id) as AdrRecordRow | undefined;
    return row ? rowToAdr(row) : null;
  });
}

/** List every ADR for a project, oldest (ADR-001) first. Returns null on failure. */
export function listAdrsByProject(projectName: string): Promise<AdrRecord[] | null> {
  return runQuery<AdrRecord[]>(TABLE + '.listAdrsByProject', (db) => {
    const rows = db
      .prepare('SELECT * FROM adr_records WHERE project_name = ? ORDER BY adr_number ASC')
      .all(projectName) as AdrRecordRow[];
    return rows.map(rowToAdr);
  });
}
