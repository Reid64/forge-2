/**
 * FORGE 2.0 — Build Memory: brand_identities CRUD.
 *
 * Persistent design tokens per brand/project. See SCHEMA_REGISTRY.md ›
 * brand_identities.
 */

import type { BrandIdentity } from '../types/index.js';
import { nowIso, runQuery } from './client.js';

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

/** Insert a new brand_identity row. Returns the created row, or null. */
export function createBrand(
  input: NewBrandIdentity
): Promise<BrandIdentity | null> {
  return runQuery<BrandIdentity>('createBrand', async (c) =>
    c.from(TABLE).insert(input).select().single()
  );
}

/** Fetch a brand_identity by its unique project_name. Returns null if none or on failure. */
export function getBrandByProject(
  projectName: string
): Promise<BrandIdentity | null> {
  return runQuery<BrandIdentity>('getBrandByProject', async (c) =>
    c.from(TABLE).select('*').eq('project_name', projectName).maybeSingle()
  );
}

/**
 * Patch a brand_identity by project_name and refresh updated_at. Returns the
 * updated row, or null on failure.
 */
export function updateBrand(
  projectName: string,
  patch: BrandIdentityUpdate
): Promise<BrandIdentity | null> {
  return runQuery<BrandIdentity>('updateBrand', async (c) =>
    c
      .from(TABLE)
      .update({ ...patch, updated_at: nowIso() })
      .eq('project_name', projectName)
      .select()
      .single()
  );
}
