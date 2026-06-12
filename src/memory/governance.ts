/**
 * FORGE 2.0 — Build Memory: governance_versions CRUD.
 *
 * Version history of FORGE governance templates. See SCHEMA_REGISTRY.md ›
 * governance_versions and BEHAVIORAL_CONTRACTS.md Contract 16 (Template Evolution).
 */

import type { GovernanceVersion } from '../types/index.js';
import { runQuery } from './client.js';

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

  const payload = { ...input, version_number: versionNumber };
  return runQuery<GovernanceVersion>('createVersion', async (c) =>
    c.from(TABLE).insert(payload).select().single()
  );
}

/**
 * Get the highest-numbered version of a template. Returns null if none or on
 * failure.
 */
export function getLatestVersion(
  templateName: string
): Promise<GovernanceVersion | null> {
  return runQuery<GovernanceVersion>('getLatestVersion', async (c) =>
    c
      .from(TABLE)
      .select('*')
      .eq('template_name', templateName)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle()
  );
}

/**
 * Get the full version history of a template, newest first. Returns null on
 * failure.
 */
export function getVersionHistory(
  templateName: string
): Promise<GovernanceVersion[] | null> {
  return runQuery<GovernanceVersion[]>('getVersionHistory', async (c) =>
    c
      .from(TABLE)
      .select('*')
      .eq('template_name', templateName)
      .order('version_number', { ascending: false })
  );
}

/**
 * List EVERY governance version across all templates, ordered by template then
 * ascending version number (so callers see each template's evolution in order).
 * Used by the Recursive Learner's Template Evolver (s6-p02) to analyse template
 * effectiveness trends. Returns null on failure (degrade to stateless, Contract 4).
 */
export function listAllVersions(): Promise<GovernanceVersion[] | null> {
  return runQuery<GovernanceVersion[]>('listAllVersions', async (c) =>
    c
      .from(TABLE)
      .select('*')
      .order('template_name', { ascending: true })
      .order('version_number', { ascending: true })
  );
}
