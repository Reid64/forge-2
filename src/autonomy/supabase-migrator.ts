/**
 * FORGE 2.0 — Autonomy: SupabaseMigrator.
 *
 * Applies a project's `supabase/migrations/*.sql` files to its live, self-hosted-or-cloud
 * Supabase project directly via the Supabase Management API — no `supabase` CLI subprocess, no
 * interactive `supabase login`. Every credential lookup goes through {@link CredentialVault} first
 * (per-project, encrypted at rest — see `src/autonomy/credential-vault.ts`), falling back to the
 * operator's own `SUPABASE_ACCESS_TOKEN`/`SUPABASE_PROJECT_ID` environment variables so a machine
 * that already has them set globally needs no extra setup. This mirrors {@link VercelDeployer}'s
 * token-resolution posture exactly (`src/autonomy/vercel-deployer.ts`).
 *
 * Migration flow:
 *   1. Read every `*.sql` file under `<projectPath>/supabase/migrations/`, sorted chronologically
 *      by the leading timestamp in each filename (the Supabase CLI's own naming convention —
 *      `<14-digit-timestamp>_<name>.sql`).
 *   2. Fetch the project's already-applied migration versions via
 *      `GET /v1/projects/{ref}/database/migrations`.
 *   3. For every migration file whose version is NOT in that applied set, run its SQL via
 *      `POST /v1/projects/{ref}/database/query` and record the outcome.
 *   4. A migration whose version IS already applied is reported `skipped`, not re-run — the
 *      Management API's query endpoint has no innate idempotency guarantee for arbitrary SQL
 *      (e.g. a bare `CREATE TABLE` with no `IF NOT EXISTS`), so re-running an already-applied file
 *      is never attempted.
 *   5. Every attempt (applied/skipped/failed) is persisted to Build Memory's `autonomy_actions`
 *      table (schema 2.9.0 — `src/learning/database.ts` › AUTONOMY_SCHEMA_SQL), the same table
 *      {@link CredentialVault}'s sibling `project_credentials`/`deployment_history` tables live in.
 *
 * Every public method degrades gracefully (Contract 4): a missing token/project ref, an unreadable
 * migrations directory, or a network failure never throws out to the caller — `isConfigured`
 * returns `false`, `getAppliedMigrations` returns `[]`, and `applyMigration`/`applyPendingMigrations`
 * return `MigrationResult`(s) with `status: 'failed'` and `error` populated. Build Memory writes are
 * best-effort, logged and swallowed on failure, exactly like every other autonomy module.
 *
 * A migration failure halts `applyPendingMigrations` — later migrations in the same directory
 * routinely depend on an earlier one (a table created two files back, a column added last week),
 * so applying them out of dependency order onto a known-broken schema state risks compounding the
 * damage rather than isolating it. The caller sees exactly how far the run got via the returned
 * `MigrationResult[]`.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getClient, logMemoryWarning, newId, nowIso } from '../memory/client.js';
import { getLogger } from '../tools/forge-logger.js';
import { CredentialVault, createCredentialVault } from './credential-vault.js';

const log = getLogger('autonomy:supabase-migrator');

const SUPABASE_MANAGEMENT_API_BASE = 'https://api.supabase.com';

/** `<timestamp>_<name>.sql` — the Supabase CLI's own migration filename convention. */
const MIGRATION_FILENAME_RE = /^\d{8,20}_[A-Za-z0-9_-]+\.sql$/;

/** Outcome of applying (or attempting to apply) one migration file. */
export type MigrationStatus = 'applied' | 'skipped' | 'failed';

/** The result of one migration attempt — always returned, never thrown. */
export interface MigrationResult {
  migrationFile: string;
  status: MigrationStatus;
  durationMs: number;
  error: string | null;
}

/** The result of a `validateMigrations` sweep — a report, not a gate; callers decide what to do with it. */
export interface MigrationValidationResult {
  valid: boolean;
  errors: string[];
  migrationCount: number;
}

/** Minimal shape of one row Supabase's `GET .../database/migrations` returns. */
interface SupabaseMigrationRecord {
  version?: string;
  name?: string;
}

/** Extra, additive options for {@link SupabaseMigrator.applyMigration} — never required. */
interface ApplyMigrationOptions {
  /** The `build_runs.id` this attempt should be attributed to in `autonomy_actions`. */
  buildRunId?: string;
  /** A pre-resolved Management API token, so a batch caller resolves it once, not per-file. */
  explicitToken?: string;
  /** A pre-fetched applied-versions set, so a batch caller fetches it once, not per-file. */
  appliedVersions?: readonly string[];
}

/**
 * Extract the leading version string from a migration filename (everything before the first `_`).
 * Falls back to the filename minus its `.sql` extension for a file that doesn't follow the
 * standard `<timestamp>_<name>.sql` convention — never throws, never returns an empty string for a
 * non-empty input.
 */
export function extractMigrationVersion(filename: string): string {
  const match = /^(\d+)_/.exec(filename);
  if (match?.[1]) return match[1];
  return filename.replace(/\.sql$/i, '');
}

/**
 * List every `*.sql` file directly under `<projectPath>/supabase/migrations/`, sorted
 * chronologically (numeric-aware string comparison — correct for both same-length timestamp
 * prefixes and any that differ in digit count). Returns `[]` (never throws) if the directory is
 * absent or unreadable.
 */
async function listMigrationFiles(projectPath: string): Promise<string[]> {
  const dir = join(projectPath, 'supabase', 'migrations');
  if (!existsSync(dir)) return [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.sql'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch (error) {
    logMemoryWarning('supabase-migrator.listMigrationFiles', error);
    return [];
  }
}

/**
 * A lightweight (regex/scan-based, not a real SQL parser — the same deliberate scope choice
 * documented on FORGE's other regex-based detectors, e.g. `src/retrofit/dead-code-detector.ts`)
 * check that a SQL file's parentheses balance, after stripping line comments, block comments, and
 * single-quoted string literals so a `(` or `)` inside a comment/string never causes a false
 * mismatch.
 */
function hasBalancedParens(sql: string): boolean {
  const stripped = sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, '');
  let depth = 0;
  for (const ch of stripped) {
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** Persist one migration attempt's outcome to `autonomy_actions`. Best-effort (Contract 4). */
function persistAutonomyAction(row: {
  buildRunId: string;
  target: string;
  status: MigrationStatus;
  result: string | null;
  error: string | null;
}): void {
  const db = getClient();
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO autonomy_actions (id, build_run_id, action_type, target, status, result, error, created_at)
       VALUES (@id, @build_run_id, 'supabase_migration', @target, @status, @result, @error, @created_at)`
    ).run({
      id: newId(),
      build_run_id: row.buildRunId,
      target: row.target,
      status: row.status,
      result: row.result,
      error: row.error,
      created_at: nowIso(),
    });
  } catch (error) {
    logMemoryWarning('supabase-migrator.persistAutonomyAction', error);
  }
}

/**
 * Applies `supabase/migrations/*.sql` files to a live Supabase project via its Management API. One
 * instance is stateless aside from the {@link CredentialVault} it wraps — safe to construct fresh
 * per call or reuse across a build, exactly like {@link VercelDeployer}.
 */
export class SupabaseMigrator {
  private readonly vault: CredentialVault;

  constructor(vault?: CredentialVault) {
    this.vault = vault ?? createCredentialVault();
  }

  /** Resolve the Management API token: `SUPABASE_ACCESS_TOKEN` env var first, else the project's vault entry. */
  private async resolveAccessToken(projectPath: string | null): Promise<string | null> {
    const envToken = process.env['SUPABASE_ACCESS_TOKEN'];
    if (envToken && envToken.length > 0) return envToken;
    if (!projectPath) return null;
    return this.vault.get(projectPath, 'SUPABASE_ACCESS_TOKEN');
  }

  /** Resolve the target project ref: `SUPABASE_PROJECT_ID` env var first, else the project's vault entry. */
  private async resolveProjectRef(projectPath: string | null): Promise<string | null> {
    const envRef = process.env['SUPABASE_PROJECT_ID'];
    if (envRef && envRef.length > 0) return envRef;
    if (!projectPath) return null;
    return this.vault.get(projectPath, 'SUPABASE_PROJECT_ID');
  }

  /**
   * True only when BOTH a Management API token (`SUPABASE_ACCESS_TOKEN`) AND a project ref
   * (`SUPABASE_PROJECT_ID`) are resolvable, from either the environment or this project's
   * credential vault entry. Never throws.
   */
  async isConfigured(projectPath: string): Promise<boolean> {
    try {
      const token = await this.resolveAccessToken(projectPath);
      const ref = await this.resolveProjectRef(projectPath);
      return Boolean(token) && Boolean(ref);
    } catch (error) {
      logMemoryWarning('supabase-migrator.isConfigured', error);
      return false;
    }
  }

  /**
   * Fetch the set of migration versions Supabase already considers applied for `projectRef`, via
   * `GET /v1/projects/{ref}/database/migrations`. `explicitToken` lets a batch caller
   * (`applyPendingMigrations`) pass a token it already resolved instead of re-resolving from the
   * environment on every call. Returns `[]` (never throws) on a missing token, a non-2xx response,
   * a malformed response body, or a network failure.
   */
  async getAppliedMigrations(projectRef: string, explicitToken?: string): Promise<string[]> {
    const token = explicitToken ?? (await this.resolveAccessToken(null));
    if (!token) {
      log.warn({ projectRef }, 'getAppliedMigrations: no SUPABASE_ACCESS_TOKEN available.');
      return [];
    }
    try {
      const res = await fetch(
        `${SUPABASE_MANAGEMENT_API_BASE}/v1/projects/${encodeURIComponent(projectRef)}/database/migrations`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log.warn(
          { projectRef, status: res.status, body },
          'getAppliedMigrations: Supabase Management API returned a non-2xx status.'
        );
        return [];
      }
      const data = (await res.json()) as SupabaseMigrationRecord[] | { migrations?: SupabaseMigrationRecord[] };
      const records: SupabaseMigrationRecord[] = Array.isArray(data) ? data : (data.migrations ?? []);
      return records
        .map((r) => r.version)
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
    } catch (error) {
      logMemoryWarning('supabase-migrator.getAppliedMigrations', error);
      return [];
    }
  }

  /**
   * Apply one migration file's SQL to `projectRef` via `POST /v1/projects/{ref}/database/query`.
   * Checks {@link getAppliedMigrations} first (unless `options.appliedVersions` is supplied) and
   * returns `status: 'skipped'` without ever calling the query endpoint when this file's version is
   * already applied. Every outcome — applied, skipped, or failed — is persisted to
   * `autonomy_actions`. Never throws; a missing token or an API error resolves to
   * `status: 'failed'` with `error` populated.
   */
  async applyMigration(
    projectRef: string,
    migrationFile: string,
    sql: string,
    options?: ApplyMigrationOptions
  ): Promise<MigrationResult> {
    const startedAt = Date.now();
    const buildRunId = options?.buildRunId ?? '';
    const version = extractMigrationVersion(migrationFile);

    const finalize = (status: MigrationStatus, error: string | null): MigrationResult => {
      const durationMs = Date.now() - startedAt;
      persistAutonomyAction({
        buildRunId,
        target: migrationFile,
        status,
        result: status === 'applied' ? `version=${version}` : null,
        error,
      });
      return { migrationFile, status, durationMs, error };
    };

    const token = options?.explicitToken ?? (await this.resolveAccessToken(null));
    if (!token) {
      return finalize('failed', 'No SUPABASE_ACCESS_TOKEN found in environment or credential vault.');
    }

    try {
      const applied = options?.appliedVersions ?? (await this.getAppliedMigrations(projectRef, token));
      if (applied.includes(version)) {
        return finalize('skipped', null);
      }

      const res = await fetch(
        `${SUPABASE_MANAGEMENT_API_BASE}/v1/projects/${encodeURIComponent(projectRef)}/database/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: sql }),
        }
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return finalize('failed', `Supabase Management API returned ${res.status} applying ${migrationFile}: ${body}`);
      }

      const result = finalize('applied', null);
      log.info({ migrationFile, durationMs: result.durationMs }, `[MIGRATION] Applied ${migrationFile} in ${result.durationMs}ms`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return finalize('failed', message);
    }
  }

  /**
   * Read every `supabase/migrations/*.sql` file under `projectPath` (chronological order), fetch
   * the applied-versions set once, and apply every pending (not-yet-applied) migration in order via
   * {@link applyMigration}. Stops at the first `failed` result — later migrations may depend on the
   * one that just failed, so applying them anyway risks compounding a broken schema state; the
   * caller sees exactly how far the run got in the returned array. Returns `[]` (never throws) when
   * the project is unconfigured or has no migrations directory.
   */
  async applyPendingMigrations(projectPath: string, buildRunId?: string): Promise<MigrationResult[]> {
    const results: MigrationResult[] = [];

    const token = await this.resolveAccessToken(projectPath);
    const projectRef = await this.resolveProjectRef(projectPath);
    if (!token || !projectRef) {
      log.warn({ projectPath }, 'applyPendingMigrations: SUPABASE_ACCESS_TOKEN/SUPABASE_PROJECT_ID not configured.');
      return results;
    }

    const files = await listMigrationFiles(projectPath);
    if (files.length === 0) return results;

    const appliedSet = new Set(await this.getAppliedMigrations(projectRef, token));

    for (const file of files) {
      let sql: string;
      try {
        sql = await readFile(join(projectPath, 'supabase', 'migrations', file), 'utf8');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        persistAutonomyAction({ buildRunId: buildRunId ?? '', target: file, status: 'failed', result: null, error: message });
        results.push({ migrationFile: file, status: 'failed', durationMs: 0, error: message });
        break;
      }

      const result = await this.applyMigration(projectRef, file, sql, {
        buildRunId: buildRunId ?? '',
        explicitToken: token,
        appliedVersions: [...appliedSet],
      });
      results.push(result);

      if (result.status === 'applied') {
        appliedSet.add(extractMigrationVersion(file));
      } else if (result.status === 'failed') {
        log.warn({ projectPath, migrationFile: file, error: result.error }, 'applyPendingMigrations: halting on first failure.');
        break;
      }
    }

    return results;
  }

  /**
   * Static, read-only sanity sweep over `supabase/migrations/*.sql` — never calls the Management
   * API, never requires `isConfigured` to be true. Checks, per file: the filename matches the
   * `<timestamp>_<name>.sql` convention, the file is non-empty with balanced parentheses (a
   * lightweight proxy for "not truncated/malformed," not a full SQL parse), and that files sort
   * into strictly ascending version order with no duplicate/out-of-order timestamp. Returns a
   * report the caller decides what to do with — this method never halts anything itself.
   */
  async validateMigrations(projectPath: string): Promise<MigrationValidationResult> {
    const errors: string[] = [];
    const files = await listMigrationFiles(projectPath);

    let previousVersion: string | null = null;
    for (const file of files) {
      if (!MIGRATION_FILENAME_RE.test(file)) {
        errors.push(`${file}: filename does not match the expected <timestamp>_<name>.sql format.`);
      }

      const version = extractMigrationVersion(file);
      if (previousVersion !== null && version <= previousVersion) {
        errors.push(`${file}: out of chronological order (version ${version} is not after ${previousVersion}).`);
      }
      previousVersion = version;

      try {
        const sql = await readFile(join(projectPath, 'supabase', 'migrations', file), 'utf8');
        if (sql.trim().length === 0) {
          errors.push(`${file}: file is empty.`);
        } else if (!hasBalancedParens(sql)) {
          errors.push(`${file}: unbalanced parentheses — likely truncated or malformed SQL.`);
        }
      } catch (error) {
        errors.push(`${file}: could not be read (${error instanceof Error ? error.message : String(error)}).`);
      }
    }

    return { valid: errors.length === 0, errors, migrationCount: files.length };
  }
}

/** Construct a {@link SupabaseMigrator}, optionally over an explicit {@link CredentialVault} (tests). */
export function createSupabaseMigrator(vault?: CredentialVault): SupabaseMigrator {
  return new SupabaseMigrator(vault);
}
