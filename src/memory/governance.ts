/**
 * FORGE 2.0 — Build Memory: governance_versions CRUD.
 *
 * Version history of FORGE governance templates. See src/learning/database.ts ›
 * BUILD_MEMORY_SCHEMA_SQL › governance_versions and BEHAVIORAL_CONTRACTS.md
 * Contract 16 (Template Evolution).
 */

import type { GovernanceVersion } from '../types/index.js';
import { newId, nowIso, runQuery } from './client.js';

const TABLE = 'governance_versions';

/**
 * Fields required to record a governance version. `version_number` is optional:
 * when omitted, createVersion derives the next sequential number for the template.
 */
export type NewGovernanceVersion = Pick<
  GovernanceVersion,
  'template_name' | 'content_hash' | 'content_snapshot' | 'change_source'
> &
  Partial<
    Omit<
      GovernanceVersion,
      | 'id'
      | 'created_at'
      | 'template_name'
      | 'content_hash'
      | 'content_snapshot'
      | 'change_source'
    >
  >;

interface GovernanceVersionRow {
  id: string;
  template_name: string;
  version_number: number;
  content_hash: string;
  content_snapshot: string;
  changes_description: string | null;
  change_source: string;
  effectiveness_score: number | null;
  builds_used_in: number;
  created_at: string;
}

function rowToVersion(row: GovernanceVersionRow): GovernanceVersion {
  return {
    id: row.id,
    template_name: row.template_name,
    version_number: row.version_number,
    content_hash: row.content_hash,
    content_snapshot: row.content_snapshot,
    changes_description: row.changes_description,
    change_source: row.change_source as GovernanceVersion['change_source'],
    effectiveness_score: row.effectiveness_score,
    builds_used_in: row.builds_used_in,
    created_at: row.created_at,
  };
}

/**
 * Insert a new governance_versions row. If `version_number` is not provided, the
 * next sequential version for the template is computed from the latest existing
 * row (starting at 1). Returns the created row, or null on failure.
 */
export async function createVersion(
  input: NewGovernanceVersion
): Promise<GovernanceVersion | null> {
  let versionNumber = input.version_number;
  if (versionNumber === undefined) {
    const latest = await getLatestVersion(input.template_name);
    versionNumber = latest ? latest.version_number + 1 : 1;
  }

  return runQuery<GovernanceVersion>(TABLE + '.createVersion', (db) => {
    const id = newId();
    db.prepare(
      `INSERT INTO governance_versions (
        id, template_name, version_number, content_hash, content_snapshot,
        changes_description, change_source, effectiveness_score, builds_used_in, created_at
      ) VALUES (
        @id, @template_name, @version_number, @content_hash, @content_snapshot,
        @changes_description, @change_source, @effectiveness_score, @builds_used_in, @created_at
      )`
    ).run({
      id,
      template_name: input.template_name,
      version_number: versionNumber,
      content_hash: input.content_hash,
      content_snapshot: input.content_snapshot,
      changes_description: input.changes_description ?? null,
      change_source: input.change_source,
      effectiveness_score: input.effectiveness_score ?? null,
      builds_used_in: input.builds_used_in ?? 0,
      created_at: nowIso(),
    });
    const row = db.prepare('SELECT * FROM governance_versions WHERE id = ?').get(id) as GovernanceVersionRow;
    return rowToVersion(row);
  });
}

/**
 * Get the highest-numbered version of a template. Returns null if none or on
 * failure.
 */
export function getLatestVersion(
  templateName: string
): Promise<GovernanceVersion | null> {
  return runQuery<GovernanceVersion>(TABLE + '.getLatestVersion', (db) => {
    const row = db
      .prepare(
        'SELECT * FROM governance_versions WHERE template_name = ? ORDER BY version_number DESC LIMIT 1'
      )
      .get(templateName) as GovernanceVersionRow | undefined;
    return row ? rowToVersion(row) : null;
  });
}

/**
 * Get the full version history of a template, newest first. Returns null on
 * failure.
 */
export function getVersionHistory(
  templateName: string
): Promise<GovernanceVersion[] | null> {
  return runQuery<GovernanceVersion[]>(TABLE + '.getVersionHistory', (db) => {
    const rows = db
      .prepare('SELECT * FROM governance_versions WHERE template_name = ? ORDER BY version_number DESC')
      .all(templateName) as GovernanceVersionRow[];
    return rows.map(rowToVersion);
  });
}

/**
 * List EVERY governance version across all templates, ordered by template then
 * ascending version number (so callers see each template's evolution in order).
 * Used by the Recursive Learner's Template Evolver (s6-p02) to analyse template
 * effectiveness trends. Returns null on failure (degrade to stateless, Contract 4).
 */
export function listAllVersions(): Promise<GovernanceVersion[] | null> {
  return runQuery<GovernanceVersion[]>(TABLE + '.listAllVersions', (db) => {
    const rows = db
      .prepare('SELECT * FROM governance_versions ORDER BY template_name ASC, version_number ASC')
      .all() as GovernanceVersionRow[];
    return rows.map(rowToVersion);
  });
}
