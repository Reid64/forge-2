/**
 * FORGE 2.0 — Build Memory: stack_profiles CRUD.
 *
 * Reusable technology stack definitions. See src/learning/database.ts ›
 * BUILD_MEMORY_SCHEMA_SQL › stack_profiles.
 */

import type { StackProfile } from '../types/index.js';
import { fromJsonText, newId, nowIso, runQuery, toJsonText } from './client.js';

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

interface StackProfileRow {
  id: string;
  name: string;
  description: string;
  stack_definition: string;
  toolchain_requirements: string;
  governance_template_set: string;
  sentinel_checks: string;
  build_commands: string;
  builds_completed: number;
  created_at: string;
}

function rowToProfile(row: StackProfileRow): StackProfile {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    stack_definition: fromJsonText(row.stack_definition, {}),
    toolchain_requirements: fromJsonText(row.toolchain_requirements, {}),
    governance_template_set: row.governance_template_set,
    sentinel_checks: fromJsonText(row.sentinel_checks, {}),
    build_commands: fromJsonText(row.build_commands, {}),
    builds_completed: row.builds_completed,
    created_at: row.created_at,
  };
}

/** Insert a new stack_profile row. Returns the created row, or null. */
export function createProfile(
  input: NewStackProfile
): Promise<StackProfile | null> {
  return runQuery<StackProfile>(TABLE + '.createProfile', (db) => {
    const id = newId();
    db.prepare(
      `INSERT INTO stack_profiles (
        id, name, description, stack_definition, toolchain_requirements,
        governance_template_set, sentinel_checks, build_commands, builds_completed, created_at
      ) VALUES (
        @id, @name, @description, @stack_definition, @toolchain_requirements,
        @governance_template_set, @sentinel_checks, @build_commands, @builds_completed, @created_at
      )`
    ).run({
      id,
      name: input.name,
      description: input.description,
      stack_definition: toJsonText(input.stack_definition),
      toolchain_requirements: toJsonText(input.toolchain_requirements),
      governance_template_set: input.governance_template_set,
      sentinel_checks: toJsonText(input.sentinel_checks),
      build_commands: toJsonText(input.build_commands),
      builds_completed: input.builds_completed ?? 0,
      created_at: nowIso(),
    });
    const row = db.prepare('SELECT * FROM stack_profiles WHERE id = ?').get(id) as StackProfileRow;
    return rowToProfile(row);
  });
}

/** Fetch a stack_profile by its unique name. Returns null if none or on failure. */
export function getProfile(name: string): Promise<StackProfile | null> {
  return runQuery<StackProfile>(TABLE + '.getProfile', (db) => {
    const row = db.prepare('SELECT * FROM stack_profiles WHERE name = ?').get(name) as
      | StackProfileRow
      | undefined;
    return row ? rowToProfile(row) : null;
  });
}

/** List all stack_profiles, alphabetically by name. Returns null on failure. */
export function listProfiles(): Promise<StackProfile[] | null> {
  return runQuery<StackProfile[]>(TABLE + '.listProfiles', (db) => {
    const rows = db.prepare('SELECT * FROM stack_profiles ORDER BY name ASC').all() as StackProfileRow[];
    return rows.map(rowToProfile);
  });
}
