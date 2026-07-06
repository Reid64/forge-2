/**
 * FORGE 2.0 — Build Memory: build_runs CRUD.
 *
 * Tracks every autonomous build FORGE executes. See src/learning/database.ts ›
 * BUILD_MEMORY_SCHEMA_SQL › build_runs.
 */

import type { BuildRun } from '../types/index.js';
import { fromJsonText, fromSqliteBool, newId, runQuery, toJsonText, toSqliteBool } from './client.js';

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

interface BuildRunRow {
  id: string;
  project_name: string;
  project_path: string;
  stack_fingerprint: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  total_prompts: number;
  completed_prompts: number;
  failed_prompts: number;
  total_errors: number;
  total_tokens: number;
  total_cost_usd: number;
  machine_id: string;
  toolchain_manifest: string;
  governance_hash: string | null;
  sentinel_interventions: number;
  autonomous_recovery_mode: number;
  parallel_prompts_used: number;
  dry_run: number;
  created_at: string;
}

function rowToBuildRun(row: BuildRunRow): BuildRun {
  return {
    id: row.id,
    project_name: row.project_name,
    project_path: row.project_path,
    stack_fingerprint: fromJsonText(row.stack_fingerprint, {}),
    status: row.status as BuildRun['status'],
    started_at: row.started_at,
    completed_at: row.completed_at,
    total_prompts: row.total_prompts,
    completed_prompts: row.completed_prompts,
    failed_prompts: row.failed_prompts,
    total_errors: row.total_errors,
    total_tokens: row.total_tokens,
    total_cost_usd: row.total_cost_usd,
    machine_id: row.machine_id,
    toolchain_manifest: fromJsonText(row.toolchain_manifest, {}),
    governance_hash: row.governance_hash,
    sentinel_interventions: row.sentinel_interventions,
    autonomous_recovery_mode: fromSqliteBool(row.autonomous_recovery_mode),
    parallel_prompts_used: fromSqliteBool(row.parallel_prompts_used),
    dry_run: fromSqliteBool(row.dry_run),
    created_at: row.created_at,
  };
}

/** Insert a new build_run row. Returns the created row, or null on failure. */
export function createBuild(input: NewBuildRun): Promise<BuildRun | null> {
  return runQuery<BuildRun>(TABLE + '.createBuild', (db) => {
    const id = newId();
    db.prepare(
      `INSERT INTO build_runs (
        id, project_name, project_path, stack_fingerprint, status, started_at, completed_at,
        total_prompts, completed_prompts, failed_prompts, total_errors, total_tokens, total_cost_usd,
        machine_id, toolchain_manifest, governance_hash, sentinel_interventions,
        autonomous_recovery_mode, parallel_prompts_used, dry_run
      ) VALUES (
        @id, @project_name, @project_path, @stack_fingerprint, @status, @started_at, @completed_at,
        @total_prompts, @completed_prompts, @failed_prompts, @total_errors, @total_tokens, @total_cost_usd,
        @machine_id, @toolchain_manifest, @governance_hash, @sentinel_interventions,
        @autonomous_recovery_mode, @parallel_prompts_used, @dry_run
      )`
    ).run({
      id,
      project_name: input.project_name,
      project_path: input.project_path,
      stack_fingerprint: toJsonText(input.stack_fingerprint ?? {}),
      status: input.status ?? 'queued',
      started_at: input.started_at ?? null,
      completed_at: input.completed_at ?? null,
      total_prompts: input.total_prompts ?? 0,
      completed_prompts: input.completed_prompts ?? 0,
      failed_prompts: input.failed_prompts ?? 0,
      total_errors: input.total_errors ?? 0,
      total_tokens: input.total_tokens ?? 0,
      total_cost_usd: input.total_cost_usd ?? 0,
      machine_id: input.machine_id,
      toolchain_manifest: toJsonText(input.toolchain_manifest ?? {}),
      governance_hash: input.governance_hash ?? null,
      sentinel_interventions: input.sentinel_interventions ?? 0,
      autonomous_recovery_mode: toSqliteBool(input.autonomous_recovery_mode ?? false),
      parallel_prompts_used: toSqliteBool(input.parallel_prompts_used ?? false),
      dry_run: toSqliteBool(input.dry_run ?? false),
    });
    const row = db.prepare('SELECT * FROM build_runs WHERE id = ?').get(id) as BuildRunRow;
    return rowToBuildRun(row);
  });
}

/** Column-name -> SQLite-value transform for the mutable build_run columns. */
const UPDATE_TRANSFORMS: Partial<Record<keyof BuildRunUpdate, (v: unknown) => unknown>> = {
  stack_fingerprint: (v) => toJsonText(v),
  toolchain_manifest: (v) => toJsonText(v),
  autonomous_recovery_mode: (v) => toSqliteBool(v as boolean),
  parallel_prompts_used: (v) => toSqliteBool(v as boolean),
  dry_run: (v) => toSqliteBool(v as boolean),
};

/** Patch an existing build_run by id. Returns the updated row, or null. */
export function updateBuild(
  id: string,
  patch: BuildRunUpdate
): Promise<BuildRun | null> {
  return runQuery<BuildRun>(TABLE + '.updateBuild', (db) => {
    const keys = Object.keys(patch) as Array<keyof BuildRunUpdate>;
    if (keys.length === 0) {
      const row = db.prepare('SELECT * FROM build_runs WHERE id = ?').get(id) as BuildRunRow | undefined;
      return row ? rowToBuildRun(row) : null;
    }
    const setClause = keys.map((k) => `${String(k)} = @${String(k)}`).join(', ');
    const params: Record<string, unknown> = { id };
    for (const k of keys) {
      const transform = UPDATE_TRANSFORMS[k];
      const value = (patch as Record<string, unknown>)[k as string];
      params[k as string] = transform ? transform(value) : value;
    }
    const result = db.prepare(`UPDATE build_runs SET ${setClause} WHERE id = @id`).run(params);
    if (result.changes === 0) return null;
    const row = db.prepare('SELECT * FROM build_runs WHERE id = ?').get(id) as BuildRunRow;
    return rowToBuildRun(row);
  });
}

/** Fetch a single build_run by id. Returns null if not found or on failure. */
export function getBuild(id: string): Promise<BuildRun | null> {
  return runQuery<BuildRun>(TABLE + '.getBuild', (db) => {
    const row = db.prepare('SELECT * FROM build_runs WHERE id = ?').get(id) as BuildRunRow | undefined;
    return row ? rowToBuildRun(row) : null;
  });
}

/** List recent build_runs, newest first. Returns null on failure. */
export function listBuilds(limit = 50): Promise<BuildRun[] | null> {
  return runQuery<BuildRun[]>(TABLE + '.listBuilds', (db) => {
    const rows = db
      .prepare('SELECT * FROM build_runs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as BuildRunRow[];
    return rows.map(rowToBuildRun);
  });
}

/** List all build_runs for a project, newest first. Returns null on failure. */
export function getBuildsByProject(
  projectName: string
): Promise<BuildRun[] | null> {
  return runQuery<BuildRun[]>(TABLE + '.getBuildsByProject', (db) => {
    const rows = db
      .prepare('SELECT * FROM build_runs WHERE project_name = ? ORDER BY created_at DESC')
      .all(projectName) as BuildRunRow[];
    return rows.map(rowToBuildRun);
  });
}
