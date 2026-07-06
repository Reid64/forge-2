/**
 * FORGE 2.0 — Build Memory: brand_identities CRUD.
 *
 * Persistent design tokens per brand/project. See src/learning/database.ts ›
 * BUILD_MEMORY_SCHEMA_SQL › brand_identities.
 */

import type { BrandIdentity } from '../types/index.js';
import { fromJsonText, newId, nowIso, runQuery, toJsonText } from './client.js';

const TABLE = 'brand_identities';

/** Fields required to record a brand identity (NOT NULL, no DB default). */
export type NewBrandIdentity = Pick<
  BrandIdentity,
  'project_name' | 'brand_name' | 'design_tokens'
> &
  Partial<
    Omit<
      BrandIdentity,
      | 'id'
      | 'created_at'
      | 'updated_at'
      | 'project_name'
      | 'brand_name'
      | 'design_tokens'
    >
  >;

/** Mutable columns of a brand identity (keyed/updated by project_name). */
export type BrandIdentityUpdate = Partial<
  Omit<BrandIdentity, 'id' | 'created_at' | 'updated_at' | 'project_name'>
>;

interface BrandIdentityRow {
  id: string;
  project_name: string;
  brand_name: string;
  design_tokens: string;
  component_styles: string;
  created_at: string;
  updated_at: string;
}

function rowToBrandIdentity(row: BrandIdentityRow): BrandIdentity {
  return {
    id: row.id,
    project_name: row.project_name,
    brand_name: row.brand_name,
    design_tokens: fromJsonText(row.design_tokens, {}),
    component_styles: fromJsonText(row.component_styles, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Insert a new brand_identity row. Returns the created row, or null. */
export function createBrand(
  input: NewBrandIdentity
): Promise<BrandIdentity | null> {
  return runQuery<BrandIdentity>(TABLE + '.createBrand', (db) => {
    const id = newId();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO brand_identities (id, project_name, brand_name, design_tokens, component_styles, created_at, updated_at)
       VALUES (@id, @project_name, @brand_name, @design_tokens, @component_styles, @ts, @ts)`
    ).run({
      id,
      project_name: input.project_name,
      brand_name: input.brand_name,
      design_tokens: toJsonText(input.design_tokens),
      component_styles: toJsonText(input.component_styles ?? {}),
      ts,
    });
    const row = db.prepare('SELECT * FROM brand_identities WHERE id = ?').get(id) as BrandIdentityRow;
    return rowToBrandIdentity(row);
  });
}

/** Fetch a brand_identity by its unique project_name. Returns null if none or on failure. */
export function getBrandByProject(
  projectName: string
): Promise<BrandIdentity | null> {
  return runQuery<BrandIdentity>(TABLE + '.getBrandByProject', (db) => {
    const row = db
      .prepare('SELECT * FROM brand_identities WHERE project_name = ?')
      .get(projectName) as BrandIdentityRow | undefined;
    return row ? rowToBrandIdentity(row) : null;
  });
}

/**
 * Patch a brand_identity by project_name and refresh updated_at. Returns the
 * updated row, or null on failure.
 */
export function updateBrand(
  projectName: string,
  patch: BrandIdentityUpdate
): Promise<BrandIdentity | null> {
  return runQuery<BrandIdentity>(TABLE + '.updateBrand', (db) => {
    const keys = Object.keys(patch) as Array<keyof BrandIdentityUpdate>;
    const ts = nowIso();
    const params: Record<string, unknown> = { project_name: projectName, updated_at: ts };
    const setParts = ['updated_at = @updated_at'];
    for (const k of keys) {
      const value = (patch as Record<string, unknown>)[k as string];
      params[k as string] = k === 'design_tokens' || k === 'component_styles' ? toJsonText(value) : value;
      setParts.push(`${String(k)} = @${String(k)}`);
    }
    const result = db
      .prepare(`UPDATE brand_identities SET ${setParts.join(', ')} WHERE project_name = @project_name`)
      .run(params);
    if (result.changes === 0) return null;
    const row = db
      .prepare('SELECT * FROM brand_identities WHERE project_name = ?')
      .get(projectName) as BrandIdentityRow;
    return rowToBrandIdentity(row);
  });
}
