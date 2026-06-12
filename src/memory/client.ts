/**
 * FORGE 2.0 — Build Memory: Supabase client wrapper.
 *
 * Single point of initialization for the self-hosted Supabase backend. Reads
 * `FORGE_SUPABASE_URL` and `FORGE_SUPABASE_SERVICE_KEY` from the environment and
 * lazily constructs one shared client (the service key is used because FORGE is a
 * trusted single-operator local tool with no RLS — see SCHEMA_REGISTRY.md).
 *
 * Per BEHAVIORAL_CONTRACTS.md Contract 4: failure to reach Build Memory is NOT a
 * halting error. Every helper here degrades gracefully — if the client is not
 * configured or a query throws, we log a warning and return `null`. No memory
 * operation may ever crash FORGE.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getLogger } from '../tools/forge-logger.js';

/**
 * Cached client. `undefined` = not yet initialized; `null` = initialization was
 * attempted and failed (stateless mode); otherwise the live client.
 */
let cachedClient: SupabaseClient | null | undefined;

/** Emit a non-fatal Build Memory warning. Never throws. */
export function logMemoryWarning(scope: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  getLogger('memory').warn(`${scope} — ${detail}`);
}

/**
 * Get the shared Supabase client, or `null` if Build Memory is unavailable.
 *
 * When the required env vars are absent FORGE runs in stateless mode: this
 * returns `null` once (logging a single warning) and all CRUD helpers no-op.
 */
export function getClient(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;

  const url = process.env.FORGE_SUPABASE_URL;
  const serviceKey = process.env.FORGE_SUPABASE_SERVICE_KEY;

  if (!url || !serviceKey) {
    logMemoryWarning(
      'getClient',
      'FORGE_SUPABASE_URL / FORGE_SUPABASE_SERVICE_KEY not set — Build Memory disabled (stateless mode)'
    );
    cachedClient = null;
    return cachedClient;
  }

  try {
    cachedClient = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (error) {
    logMemoryWarning('getClient', error);
    cachedClient = null;
  }

  return cachedClient;
}

/**
 * Reset the cached client. Intended for tests / re-reading env after a config
 * change; not used during a normal build.
 */
export function resetClient(): void {
  cachedClient = undefined;
}

/** The shape every Supabase query callback must resolve to. */
type QueryResult = { data: unknown; error: unknown };

/**
 * Optional post-read validator for {@link runQuery}. Returns a list of clear issue
 * strings ('' / empty = valid). Deliberately a plain function (not a Zod schema)
 * so this dependency-light memory layer stays Zod-free and the module graph stays
 * acyclic — `src/tools/schema-validator.ts` provides `rowValidator(schema)` to
 * adapt a schema into this shape. Never throws.
 */
export type ResultValidator = (data: unknown) => readonly string[];

/**
 * Run a Supabase query inside the standard guard rails:
 *   - returns `null` if Build Memory is unavailable,
 *   - returns `null` (and logs) if the query reports an error or throws,
 *   - otherwise returns the query's `data` cast to `T`.
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
  fn: (client: SupabaseClient) => Promise<QueryResult>,
  validate?: ResultValidator
): Promise<T | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await fn(client);
    if (error) {
      logMemoryWarning(scope, error);
      return null;
    }
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
    return (data as T) ?? null;
  } catch (error) {
    logMemoryWarning(scope, error);
    return null;
  }
}

/** Current timestamp as an ISO 8601 string, for `*_at` columns. */
export function nowIso(): string {
  return new Date().toISOString();
}
