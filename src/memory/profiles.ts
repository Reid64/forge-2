/**
 * FORGE 2.0 — Build Memory: stack_profiles CRUD.
 *
 * Reusable technology stack definitions. See SCHEMA_REGISTRY.md › stack_profiles.
 */

import type { StackProfile } from '../types/index.js';
import { runQuery } from './client.js';

const TABLE = 'stack_profiles';

/** Fields required to record a stack profile (NOT NULL, no DB default). */
export type NewStackProfile = Pick<
  StackProfile,
  | 'name'
  | 'description'
  | 'stack_definition'
  | 'toolchain_requirements'
  | 'governance_template_set'
  | 'sentinel_checks'
  | 'build_commands'
> &
  Partial<
    Omit<
      StackProfile,
      | 'id'
      | 'created_at'
      | 'name'
      | 'description'
      | 'stack_definition'
      | 'toolchain_requirements'
      | 'governance_template_set'
      | 'sentinel_checks'
      | 'build_commands'
    >
  >;

/** Insert a new stack_profile row. Returns the created row, or null. */
export function createProfile(
  input: NewStackProfile
): Promise<StackProfile | null> {
  return runQuery<StackProfile>('createProfile', async (c) =>
    c.from(TABLE).insert(input).select().single()
  );
}

/** Fetch a stack_profile by its unique name. Returns null if none or on failure. */
export function getProfile(name: string): Promise<StackProfile | null> {
  return runQuery<StackProfile>('getProfile', async (c) =>
    c.from(TABLE).select('*').eq('name', name).maybeSingle()
  );
}

/** List all stack_profiles, alphabetically by name. Returns null on failure. */
export function listProfiles(): Promise<StackProfile[] | null> {
  return runQuery<StackProfile[]>('listProfiles', async (c) =>
    c.from(TABLE).select('*').order('name', { ascending: true })
  );
}
