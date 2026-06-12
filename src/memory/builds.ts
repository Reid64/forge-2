/**
 * FORGE 2.0 — Build Memory: build_runs CRUD.
 *
 * Tracks every autonomous build FORGE executes. See SCHEMA_REGISTRY.md › build_runs.
 */

import type { BuildRun } from '../types/index.js';
import { runQuery } from './client.js';

const TABLE = 'build_runs';

/**
 * Fields required to start a build (the NOT NULL columns without a DB default).
 * Everything else is supplied by the database (defaults) or optional at insert.
 */
export type NewBuildRun = Pick<
  BuildRun,
  'project_name' | 'project_path' | 'machine_id'
> &
  Partial<
    Omit<BuildRun, 'id' | 'created_at' | 'project_name' | 'project_path' | 'machine_id'>
  >;

/** Mutable columns of a build_run (everything except identity/creation). */
export type BuildRunUpdate = Partial<Omit<BuildRun, 'id' | 'created_at'>>;

/** Insert a new build_run row. Returns the created row, or null on failure. */
export function createBuild(input: NewBuildRun): Promise<BuildRun | null> {
  return runQuery<BuildRun>('createBuild', async (c) =>
    c.from(TABLE).insert(input).select().single()
  );
}

/** Patch an existing build_run by id. Returns the updated row, or null. */
export function updateBuild(
  id: string,
  patch: BuildRunUpdate
): Promise<BuildRun | null> {
  return runQuery<BuildRun>('updateBuild', async (c) =>
    c.from(TABLE).update(patch).eq('id', id).select().single()
  );
}

/** Fetch a single build_run by id. Returns null if not found or on failure. */
export function getBuild(id: string): Promise<BuildRun | null> {
  return runQuery<BuildRun>('getBuild', async (c) =>
    c.from(TABLE).select('*').eq('id', id).maybeSingle()
  );
}

/** List recent build_runs, newest first. Returns null on failure. */
export function listBuilds(limit = 50): Promise<BuildRun[] | null> {
  return runQuery<BuildRun[]>('listBuilds', async (c) =>
    c.from(TABLE).select('*').order('created_at', { ascending: false }).limit(limit)
  );
}

/** List all build_runs for a project, newest first. Returns null on failure. */
export function getBuildsByProject(
  projectName: string
): Promise<BuildRun[] | null> {
  return runQuery<BuildRun[]>('getBuildsByProject', async (c) =>
    c
      .from(TABLE)
      .select('*')
      .eq('project_name', projectName)
      .order('created_at', { ascending: false })
  );
}
