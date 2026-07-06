/**
 * FORGE 2.0 — Build Memory: SQLite transport.
 *
 * Single point of initialization for Build Memory. Shares the same on-disk
 * database and connection cache as the learning engine (`src/learning/database.ts`)
 * so both table families (build_runs/error_patterns/… and prompt_scores/
 * fix_patterns/…) live in one file: `~/.forge/forge_memory.db`.
 *
 * Per BEHAVIORAL_CONTRACTS.md Contract 4: failure to reach Build Memory is NOT a
 * halting error. Every helper here degrades gracefully — if the database cannot be
 * opened or a query throws, we log a warning and return `null`. No memory
 * operation may ever crash FORGE. The only failure mode now is disk-level (a
 * locked/corrupt file, an unwritable `~/.forge` directory) — there is no
 * configuration to get wrong.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import { getConnection, initializeForgeMemory } from '../learning/database.js';
import { getLogger } from '../tools/forge-logger.js';

/** The SQLite handle every Build Memory CRUD module reads/writes through. */
export type MemoryDb = BetterSqlite3.Database;

/**
 * Cached database handle. `undefined` = not yet initialized; `null` = initialization
 * was attempted and failed (stateless mode); otherwise the live, schema-migrated
 * connection.
 */
let cachedDb: MemoryDb | null | undefined;

/** Emit a non-fatal Build Memory warning. Never throws. */
export function logMemoryWarning(scope: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  getLogger('memory').warn(`${scope} — ${detail}`);
}

/**
 * Get the shared Build Memory database handle, or `null` if it is unavailable.
 *
 * Opens (or reuses) the shared `~/.forge/forge_memory.db` connection and runs the
 * schema migration guard. A disk-level failure (unwritable directory, locked file,
 * corrupt database) returns `null` once (logging a single warning); all CRUD
 * helpers then no-op for the remainder of the process.
 */
export function getClient(): MemoryDb | null {
  if (cachedDb !== undefined) return cachedDb;

  try {
    initializeForgeMemory();
    cachedDb = getConnection();
  } catch (error) {
    logMemoryWarning(
      'getClient',
      error instanceof Error ? error : `Build Memory unavailable — ${String(error)}`
    );
    cachedDb = null;
  }

  return cachedDb;
}

/**
 * Reset the cached database handle. Intended for tests / re-initializing after a
 * config change; not used during a normal build.
 */
export function resetClient(): void {
  cachedDb = undefined;
}

/**
 * Optional post-read validator for {@link runQuery}. Returns a list of clear issue
 * strings ('' / empty = valid). Deliberately a plain function (not a Zod schema)
 * so this dependency-light memory layer stays Zod-free — `src/tools/schema-validator.ts`
 * provides `rowValidator(schema)` to adapt a schema into this shape. Never throws.
 */
export type ResultValidator = (data: unknown) => readonly string[];

/**
 * Run a Build Memory operation inside the standard guard rails:
 *   - returns `null` if Build Memory is unavailable,
 *   - returns `null` (and logs) if `fn` throws,
 *   - otherwise returns whatever `fn` returns (already the desired shape `T`).
 *
 * `fn` is a synchronous callback operating on prepared statements against the
 * shared database handle; `runQuery` wraps it in a resolved Promise so every CRUD
 * helper keeps its existing `Promise<T | null>` signature.
 *
 * When `validate` is supplied, the returned data is checked against it and any
 * issues are logged as a non-fatal `<scope>:validation` warning — the data is
 * still returned (Contract 4 — degrade, don't drop). Validation problems never
 * crash a read/write.
 *
 * `scope` is a short label used in warning logs (typically the calling function).
 */
export async function runQuery<T>(
  scope: string,
  fn: (db: MemoryDb) => T | null,
  validate?: ResultValidator
): Promise<T | null> {
  const db = getClient();
  if (!db) return null;

  try {
    const data = fn(db);
    if (validate && data !== null && data !== undefined) {
      try {
        const issues = validate(data);
        if (issues.length > 0) {
          logMemoryWarning(`${scope}:validation`, issues.join('; '));
        }
      } catch (validationError) {
        // A misbehaving validator must never break a Build Memory operation.
        logMemoryWarning(`${scope}:validation`, validationError);
      }
    }
    return data ?? null;
  } catch (error) {
    logMemoryWarning(scope, error);
    return null;
  }
}

/** Current timestamp as an ISO 8601 string, for `*_at` columns. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Generate a new row id (SQLite has no server-side `uuid` default). */
export function newId(): string {
  return randomUUID();
}

/** Serialize a value for a `jsonb`-equivalent `TEXT` column. `undefined` → `'null'`. */
export function toJsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Parse a `jsonb`-equivalent `TEXT` column, falling back when absent/invalid. */
export function fromJsonText<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Convert a stored SQLite `0`/`1` (or `null`) integer flag to a boolean. */
export function fromSqliteBool(value: unknown): boolean {
  return value === 1 || value === true;
}

/** Convert a boolean to the `0`/`1` integer SQLite stores for a flag column. */
export function toSqliteBool(value: boolean | null | undefined): number {
  return value ? 1 : 0;
}
