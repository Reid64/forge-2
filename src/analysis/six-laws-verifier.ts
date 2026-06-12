/**
 * FORGE 2.0 — Six Laws Automated Verifier (F13, BEHAVIORAL_CONTRACTS Contract 19, BLUEPRINT
 * `src/analysis/six-laws-verifier.ts`).
 *
 * A feature is only complete when ALL SIX Laws pass (CLAUDE.md). This module AUTOMATES the first
 * FIVE against a built, RUNNING target application; the sixth (VERIFICATION — a human confirms in
 * the browser) is structural and NOT automatable, so it is reported as a manual gate, never faked
 * (Contract 19: "Laws 1-5 must ALL pass before deployment. Law 6 is the final human gate.").
 *
 * THE FIVE AUTOMATED LAWS (Contract 19, verbatim mapping):
 *   Law 1 — SCHEMA:  introspect the live database (or, failing that, the migration SQL) and verify
 *                    every table declared in SCHEMA_REGISTRY.md exists with the correct columns and
 *                    base types, AND that every table carries at least one RLS policy / has RLS
 *                    enabled (company_id scoping is enforced at the policy layer). REUSES the Phase 4
 *                    Sentinel's `parseSchemaRegistry` + `diffSchema` and the Phase 1C
 *                    `extractSchema` so the registry parsing and type-family comparison are
 *                    byte-identical to the drift gate.
 *   Law 2 — API:     for every route in the contract (supplied `apiRoutes`, else parsed out of
 *                    BEHAVIORAL_CONTRACTS.md) send a real HTTP request and verify the status code
 *                    and (best-effort) the JSON response shape. SAFETY: only GET routes are
 *                    exercised normally; a mutating route (POST/PUT/PATCH/DELETE) is probed
 *                    UNAUTHENTICATED with no body to confirm it EXISTS and rejects (401/403/400/
 *                    405/422) rather than performing a destructive write — documented, not a faked
 *                    pass (Iron Law 3).
 *   Law 3 — UI:      drive Playwright to visit every page route and check (a) no placeholder text
 *                    ("coming soon", "placeholder", "TODO", "lorem ipsum", …), (b) the expected
 *                    interactive elements (buttons / forms / inputs / dropdowns / links) exist, and
 *                    (c) the page renders without console / page errors.
 *   Law 4 — DATA:    during the SAME Playwright visit, intercept network requests and verify the
 *                    page issues REAL API calls (to `/api/*`, a known route, or the Supabase REST
 *                    endpoint) rather than rendering hardcoded/mock data — a data-bearing page that
 *                    makes zero dynamic data requests fails.
 *   Law 5 — WIRING:  Playwright checks (a) every internal nav link resolves to a known route, (b)
 *                    pages with declared form interactions expose a form/submit control wired to a
 *                    contract endpoint, and (c) role-gated routes RESTRICT unauthorized access — an
 *                    unauthenticated visit to a protected route must redirect to /login (Iron Law 4)
 *                    or return 401/403, never render the protected content.
 *
 * OUTPUT: a {@link SixLawsResult} `{ passed, laws: LawResult[], law6, report, … }` — `passed` is
 * true only when every EVALUATED (non-skipped) law passed. Each {@link LawResult} carries per-
 * subject findings and a one-line detail; the `report` is a full markdown summary.
 *
 * NON-FATAL house style (Contract 4 / Iron Law 3): like every FORGE phase/analysis module the
 * verifier NEVER throws and never fabricates a pass. A precondition that cannot be evaluated — the
 * database is unreachable, the app is not running, Playwright is unavailable, no routes/pages were
 * supplied — yields a SKIPPED law with a note, NOT a false pass and NOT a false fail. Every external
 * collaborator (the schema extraction, the HTTP requester, and the browser driver) is injectable,
 * so the verifier and its pure helpers unit-test with no database, no server, and no browser.
 *
 * BOUNDARY: reads the target app's database (schema metadata only — never table DATA, never
 * secrets), its governance docs, and its running HTTP surface. It writes NOTHING to the target and
 * touches no governance file (Iron Law 1). The default Playwright driver only NAVIGATES and reads;
 * it never submits a form that would mutate data (live form submission is deferred to the Law 6
 * human gate, surfaced as a warning).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
// type-only — erased at emit, so importing the architecture artifacts couples nothing at runtime.
import type { ApiRoute, ArchPage, InteractionMap } from '../phases/phase1b-architect.js';

import { extractSchema, createSupabaseExecutor } from '../tools/schema-extractor.js';
import type { SchemaSnapshot, SqlExecutor } from '../tools/schema-extractor.js';
import { parseSchemaRegistry, diffSchema } from '../phases/phase4-sentinel.js';
import type { RegistryTable } from '../phases/phase4-sentinel.js';
import { logLine } from '../tools/forge-logger.js';
import { nowIso } from '../memory/index.js';

// ---------------------------------------------------------------------------
// Public contract — laws + findings
// ---------------------------------------------------------------------------

/** The five automated laws, in order. */
export type LawName = 'SCHEMA' | 'API' | 'UI' | 'DATA' | 'WIRING';

/** The fixed law number → name mapping (Contract 19). */
export const LAW_NAMES: Readonly<Record<1 | 2 | 3 | 4 | 5, LawName>> = {
  1: 'SCHEMA',
  2: 'API',
  3: 'UI',
  4: 'DATA',
  5: 'WIRING',
} as const;

/** A single observation made while verifying a law. */
export interface LawFinding {
  /** `fail` makes the law fail; `warn` is surfaced but does not fail; `pass` is a confirmation. */
  severity: 'pass' | 'warn' | 'fail';
  /** What the finding is about (a table, a route, a page path). */
  subject: string;
  /** Human-readable detail. */
  detail: string;
}

/** The result of verifying one law. */
export interface LawResult {
  law: 1 | 2 | 3 | 4 | 5;
  name: LawName;
  /** True when the law ran and no `fail` finding was recorded. A skipped law is NOT a pass. */
  passed: boolean;
  /** True when the law could not be evaluated (precondition absent) — neither pass nor fail. */
  skipped: boolean;
  /** One-line summary. */
  detail: string;
  /** Every finding recorded for this law. */
  findings: LawFinding[];
  /** Wall-clock duration of the law, in milliseconds. */
  durationMs: number;
}

/** The full Six Laws verification result (the F13 / Contract 19 output contract). */
export interface SixLawsResult {
  /** True iff every EVALUATED (non-skipped) law passed. */
  passed: boolean;
  /** Laws 1-5, in order. */
  laws: LawResult[];
  /** Law 6 is the human gate — never automated, always reported as pending. */
  law6: { name: 'VERIFICATION'; automated: false; detail: string };
  /** Full markdown report. */
  report: string;
  /** Base URL the HTTP/browser laws targeted. */
  baseUrl: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Public contract — what to verify (design specs)
// ---------------------------------------------------------------------------

/** A page/route to verify in Laws 3-5. */
export interface PageRouteSpec {
  /** Route path, e.g. `/dashboard` (joined onto `baseUrl`). */
  path: string;
  name?: string;
  /** Whether the route is behind auth (Law 5 role-gating). */
  authRequired?: boolean;
  /** Roles permitted (informational; presence ⇒ role-gated). */
  roles?: string[];
  /** CSS selectors that MUST be present (interactive elements). Default: any interactive element. */
  expectedElements?: string[];
  /** Whether this page is expected to load data via an API call (Law 4). Default: inferred. */
  expectsData?: boolean;
}

/** An API route to verify in Law 2. */
export interface ApiRouteSpec {
  /** Route path, e.g. `/api/leads` (joined onto `baseUrl`). */
  path: string;
  /** HTTP method. Default `GET`. */
  method?: string;
  /** Whether the route requires auth (an unauthenticated call must be rejected). */
  authRequired?: boolean;
  roles?: string[];
  /** Expected success status for a public GET. Default 200. */
  expectStatus?: number;
  /** Description / JSON of the expected response shape (best-effort top-level key check). */
  responseSchema?: string;
}

/** A declared interactive element (drives Law 3 element expectations + Law 5 form wiring). */
export interface InteractionSpec {
  feature: string;
  element: string;
  /** The API endpoint this element invokes, if any (Law 5 form wiring). */
  apiCall?: string;
  /** The page path this element lives on, if known. */
  page?: string;
}

/** What to verify — the target app + its design contract. */
export interface SixLawsInput {
  /** Target project root (for migration-based schema fallback + governance-doc reads). */
  projectPath?: string;
  /** Running app base URL. Default `http://localhost:3000`. */
  baseUrl?: string;
  /** SCHEMA_REGISTRY.md content (Law 1). Default: read from the project's governance dir. */
  schemaRegistryContent?: string;
  /** BEHAVIORAL_CONTRACTS.md content (Law 2 route parsing). Default: read from governance dir. */
  behavioralContractsContent?: string;
  /** Expected tables (Law 1). Default: parsed from `schemaRegistryContent`. */
  expectedTables?: RegistryTable[];
  /** API routes to verify (Law 2). Default: parsed from `behavioralContractsContent`. */
  apiRoutes?: ApiRouteSpec[];
  /** Page routes to verify (Laws 3-5). No default — Laws 3-5 SKIP when none are supplied. */
  pages?: PageRouteSpec[];
  /** Declared interactions (refines Law 3 element checks + Law 5 form wiring). */
  interactions?: InteractionSpec[];
  /** Whether Law 1 requires every table to have RLS. Default true. */
  requireRls?: boolean;
  /** Tables exempt from the RLS requirement (e.g. public reference tables). */
  tablesExemptFromRls?: string[];
}

// ---------------------------------------------------------------------------
// Public contract — injectable collaborators (options)
// ---------------------------------------------------------------------------

/** A minimal HTTP response (decoupled from `fetch`). */
export interface HttpResponseLite {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  bodyText: string;
  url: string;
  /** True when the status is a 3xx redirect. */
  redirected: boolean;
}

/** A function that performs one HTTP request (injectable for tests). Should not throw. */
export type HttpRequester = (req: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<HttpResponseLite>;

/** A single intercepted network request. */
export interface NetworkRequest {
  method: string;
  url: string;
  /** Playwright resource type (`document`, `xhr`, `fetch`, `script`, `image`, …). */
  resourceType: string;
}

/** A request to probe one page in the browser. */
export interface PageProbeRequest {
  url: string;
  /** CSS selectors whose presence to record. */
  selectors?: string[];
  /** Collect the page's anchor hrefs (Law 5 nav). */
  collectLinks?: boolean;
  /** Navigation timeout (ms). */
  timeoutMs?: number;
  /** Visit with a FRESH, signed-out context (Law 5 role-gating). Default false. */
  unauthenticated?: boolean;
}

/** The observations from probing one page. */
export interface PageProbe {
  url: string;
  /** URL after redirects. */
  finalUrl: string;
  /** Navigation succeeded with a non-error (<400) status. */
  ok: boolean;
  status: number | null;
  /** Visible body text (innerText), lower-cased downstream for matching. */
  bodyText: string;
  consoleErrors: string[];
  pageErrors: string[];
  requests: NetworkRequest[];
  /** Selector → whether at least one matching element was present. */
  presentSelectors: Record<string, boolean>;
  /** Anchor hrefs found on the page (when `collectLinks`). */
  links: string[];
  /** Set when the probe itself failed (navigation threw / browser error). */
  error: string | null;
}

/** A browser driver the page laws use. The default is Playwright; tests inject a fake. */
export interface PageDriver {
  probe(req: PageProbeRequest): Promise<PageProbe>;
  close(): Promise<void>;
}

/** Options — injectable collaborators + tuning (none required). */
export interface SixLawsOptions {
  /** Live SQL executor for Law 1 introspection (takes precedence over `supabase`). */
  sql?: SqlExecutor;
  /** Supabase client for Law 1 introspection (an executor is derived from it). */
  supabase?: SupabaseClient;
  /** Override the actual-schema extraction entirely (tests). */
  extractActualSchema?: () => Promise<SchemaSnapshot>;
  /** Override the HTTP requester (Law 2 + Law 5 role checks). Default: a guarded `fetch`. */
  httpRequest?: HttpRequester;
  /** Inject a ready browser driver (Laws 3-5). Default: a lazily-created Playwright driver. */
  driver?: PageDriver;
  /** Override how the default driver is created (tests). Returns null when unavailable. */
  createDriver?: () => Promise<PageDriver | null>;
  /** Run the browser headless. Default true. */
  headless?: boolean;
  /** Playwright storage-state (path or object) for AUTHENTICATED visits in Laws 3/4. */
  storageState?: string | Record<string, unknown>;
  /** Override the placeholder-text patterns (Law 3). */
  placeholderPatterns?: RegExp[];
  /** Per-navigation timeout (ms). Default 15000. */
  navTimeoutMs?: number;
  /** Cap on distinct links followed in Law 5 nav verification. Default 25. */
  maxNavLinks?: number;
  /** Progress reporter. Default logs with a `[FORGE:sixlaws]` prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_NAV_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_NAV_LINKS = 25;

/** Placeholder / unfinished-page markers (Law 3). Word-bounded so legit words don't false-flag. */
const DEFAULT_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\bcoming soon\b/i,
  /\bplaceholder\b/i,
  /\blorem ipsum\b/i,
  /\bunder construction\b/i,
  /\bto[\s-]?do\b/i,
  /\btbd\b/i,
  /\bfix ?me\b/i,
];

/** Statuses that constitute a valid "route exists but rejected the unauthenticated probe". */
const REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 405, 422]);

/** Methods that mutate — probed for existence only, never actually executed (safety). */
const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Status cap on captured output rendered into the report. */
const MAX_DETAIL_CHARS = 600;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Render an unknown thrown value as a short string. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Monotonic-ish millisecond clock (one place, easy to stub). */
function nowMs(): number {
  return Date.now();
}

/** Truncate text for the report. */
function clip(text: string, max = MAX_DETAIL_CHARS): string {
  const t = text ?? '';
  return t.length <= max ? t : `${t.slice(0, max)}… [${t.length - max} more]`;
}

/** Read a UTF-8 text file, returning `null` if it cannot be read (guarded). */
async function readTextSafe(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** Join a base URL and a path, tolerating leading/trailing slashes. */
function joinUrl(baseUrl: string, path: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

/** A finished law result with derived `passed` (false when any finding is a `fail`). */
function lawResult(
  law: 1 | 2 | 3 | 4 | 5,
  detail: string,
  findings: LawFinding[],
  durationMs: number
): LawResult {
  const passed = !findings.some((f) => f.severity === 'fail');
  return { law, name: LAW_NAMES[law], passed, skipped: false, detail, findings, durationMs };
}

/** A skipped law (precondition absent — neither pass nor fail). */
function lawSkip(law: 1 | 2 | 3 | 4 | 5, detail: string): LawResult {
  return { law, name: LAW_NAMES[law], passed: false, skipped: true, detail, findings: [], durationMs: 0 };
}

/** Does `text` look like a login/auth redirect or an auth-rejection? */
function isAuthGate(finalUrl: string, status: number | null): boolean {
  if (/\/(login|signin|sign-in|auth)\b/i.test(finalUrl)) return true;
  return status === 401 || status === 403;
}

// ---------------------------------------------------------------------------
// Law 2 — parse routes out of BEHAVIORAL_CONTRACTS.md (best-effort)
// ---------------------------------------------------------------------------

/** Recognised HTTP verbs for the route scanner. */
const HTTP_VERBS = '(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)';

/**
 * Scan a contracts/markdown document for `VERB /path` route declarations (in prose, code spans, or
 * tables). Deduplicated by method+path. Best-effort and tolerant — a doc with no routes yields `[]`.
 */
export function parseRoutesFromContracts(markdown: string): ApiRouteSpec[] {
  const found = new Map<string, ApiRouteSpec>();
  const re = new RegExp(`\\b${HTTP_VERBS}\\s+(\\/[A-Za-z0-9_\\-\\/:.{}\\[\\]]*)`, 'gi');
  for (const m of markdown.matchAll(re)) {
    const method = (m[1] ?? '').toUpperCase();
    const rawPath = (m[2] ?? '').replace(/[.,;:)]+$/, '');
    if (method === '' || rawPath === '') continue;
    // Skip obvious non-API paths picked up incidentally (e.g. file paths under src/).
    if (/^\/(src|dist|node_modules)\b/i.test(rawPath)) continue;
    const key = `${method} ${rawPath}`;
    if (!found.has(key)) {
      found.set(key, { path: rawPath, method, authRequired: /\/api\//i.test(rawPath) });
    }
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Law 1 — SCHEMA
// ---------------------------------------------------------------------------

/** Resolve the expected tables from explicit input, supplied content, or the governance file. */
async function resolveExpectedTables(
  input: SixLawsInput,
  warnings: string[]
): Promise<RegistryTable[]> {
  if (input.expectedTables && input.expectedTables.length > 0) return input.expectedTables;
  let content = input.schemaRegistryContent ?? null;
  if (content === null && input.projectPath) {
    content =
      (await readTextSafe(join(input.projectPath, 'governance', 'SCHEMA_REGISTRY.md'))) ??
      (await readTextSafe(join(input.projectPath, 'SCHEMA_REGISTRY.md')));
  }
  if (content === null) {
    warnings.push('SCHEMA_REGISTRY.md not supplied or found — cannot determine expected tables.');
    return [];
  }
  return parseSchemaRegistry(content);
}

/** Run Law 1 (SCHEMA). */
async function verifySchema(
  input: SixLawsInput,
  options: SixLawsOptions,
  log: (m: string) => void
): Promise<LawResult> {
  const startedAt = nowMs();
  const warnings: string[] = [];
  const expected = await resolveExpectedTables(input, warnings);

  if (expected.length === 0) {
    return lawSkip(1, warnings[0] ?? 'No expected tables to verify.');
  }

  // Resolve a live executor (explicit sql wins over a Supabase client) for ground-truth schema.
  let executor: SqlExecutor | null = options.sql ?? null;
  if (!executor && options.supabase) executor = createSupabaseExecutor(options.supabase);

  let actual: SchemaSnapshot;
  try {
    if (options.extractActualSchema) {
      actual = await options.extractActualSchema();
    } else if (executor) {
      actual = await extractSchema({ sql: executor, ...(input.projectPath ? { projectPath: input.projectPath } : {}) });
    } else if (input.projectPath) {
      actual = await extractSchema({ projectPath: input.projectPath });
    } else {
      return lawSkip(1, 'No live DB connection and no projectPath — cannot introspect the schema.');
    }
  } catch (error) {
    log(`WARNING: schema extraction failed (${describe(error)})`);
    return lawSkip(1, `Schema extraction failed: ${describe(error)}`);
  }

  if (actual.tables.length === 0) {
    return lawSkip(
      1,
      `No schema introspected (source: ${actual.source})` +
        (actual.warnings[0] ? ` — ${actual.warnings[0]}` : '') +
        ' — cannot verify Law 1.'
    );
  }

  const findings: LawFinding[] = [];

  // Tables + columns + types — reuse the Sentinel's drift diff (deletion = missing, modification =
  // type changed); additions in the live schema are fine for a completeness check.
  const drift = diffSchema(expected, actual);
  for (const f of drift) {
    if (f.kind === 'deletion') {
      findings.push({ severity: 'fail', subject: 'schema', detail: f.detail });
    } else if (f.kind === 'modification') {
      findings.push({ severity: 'fail', subject: 'schema', detail: f.detail });
    }
  }

  // RLS — every expected table that exists must carry ≥1 policy or have RLS enabled.
  const requireRls = input.requireRls ?? true;
  if (requireRls) {
    const exempt = new Set((input.tablesExemptFromRls ?? []).map((t) => t.toLowerCase()));
    const actualByName = new Map(actual.tables.map((t) => [t.name.toLowerCase(), t]));
    const policiesByTable = new Map<string, number>();
    for (const p of actual.rlsPolicies) {
      const k = p.table.toLowerCase();
      policiesByTable.set(k, (policiesByTable.get(k) ?? 0) + 1);
    }
    for (const exp of expected) {
      const name = exp.name.toLowerCase();
      if (exempt.has(name)) continue;
      const act = actualByName.get(name);
      if (!act) continue; // already reported as a deletion above
      const policyCount = policiesByTable.get(name) ?? 0;
      if (policyCount === 0 && !act.rlsEnabled) {
        findings.push({
          severity: 'fail',
          subject: exp.name,
          detail: `table '${exp.name}' has no RLS policy and RLS is not enabled (company_id scoping unenforced)`,
        });
      } else {
        findings.push({
          severity: 'pass',
          subject: exp.name,
          detail: `RLS present (${policyCount} policy(ies)${act.rlsEnabled ? ', enabled' : ''})`,
        });
      }
    }
  }

  const verifiedTables = expected.length;
  const fails = findings.filter((f) => f.severity === 'fail').length;
  const detail =
    fails === 0
      ? `${verifiedTables} table(s) verified against the live schema (source: ${actual.source})${requireRls ? ' incl. RLS' : ''}`
      : `${fails} schema/RLS violation(s) across ${verifiedTables} expected table(s) (source: ${actual.source})`;
  return lawResult(1, detail, findings, nowMs() - startedAt);
}

// ---------------------------------------------------------------------------
// Law 2 — API
// ---------------------------------------------------------------------------

/** Default HTTP requester via global `fetch` (Node ≥20). Throws only on a true connection error. */
const defaultHttpRequest: HttpRequester = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    redirect: 'manual',
    ...(req.headers ? { headers: req.headers } : {}),
    ...(req.body !== undefined ? { body: req.body } : {}),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    bodyText = '';
  }
  return {
    status: res.status,
    ok: res.ok,
    headers,
    bodyText,
    url: res.url || req.url,
    redirected: res.status >= 300 && res.status < 400,
  };
};

/** Resolve the API routes from explicit input, supplied content, or the governance file. */
async function resolveApiRoutes(input: SixLawsInput, warnings: string[]): Promise<ApiRouteSpec[]> {
  if (input.apiRoutes && input.apiRoutes.length > 0) return input.apiRoutes;
  let content = input.behavioralContractsContent ?? null;
  if (content === null && input.projectPath) {
    content =
      (await readTextSafe(join(input.projectPath, 'governance', 'BEHAVIORAL_CONTRACTS.md'))) ??
      (await readTextSafe(join(input.projectPath, 'BEHAVIORAL_CONTRACTS.md')));
  }
  if (content === null) {
    warnings.push('No apiRoutes supplied and BEHAVIORAL_CONTRACTS.md not found.');
    return [];
  }
  return parseRoutesFromContracts(content);
}

/** Best-effort check that a JSON body contains the top-level keys implied by a responseSchema. */
function responseShapeMatches(responseSchema: string | undefined, bodyText: string): boolean | null {
  if (!responseSchema || !/[{[]/.test(responseSchema)) return null;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return false; // schema implies JSON but the body was not JSON
  }
  let expectedKeys: string[] = [];
  try {
    const schema = JSON.parse(responseSchema) as unknown;
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
      expectedKeys = Object.keys(schema);
    }
  } catch {
    expectedKeys = [];
  }
  if (expectedKeys.length === 0) return true; // valid JSON, no explicit keys to require
  const target =
    Array.isArray(body) && body.length > 0 && typeof body[0] === 'object' && body[0] !== null
      ? (body[0] as Record<string, unknown>)
      : body && typeof body === 'object'
        ? (body as Record<string, unknown>)
        : null;
  if (!target) return false;
  return expectedKeys.every((k) => k in target);
}

/** Run Law 2 (API). */
async function verifyApi(
  input: SixLawsInput,
  options: SixLawsOptions,
  baseUrl: string,
  log: (m: string) => void
): Promise<LawResult> {
  const startedAt = nowMs();
  const warnings: string[] = [];
  const routes = await resolveApiRoutes(input, warnings);
  if (routes.length === 0) {
    return lawSkip(2, warnings[0] ?? 'No API routes to verify.');
  }

  const http = options.httpRequest ?? defaultHttpRequest;
  const findings: LawFinding[] = [];
  let unreachable = 0;

  for (const route of routes) {
    const method = (route.method ?? 'GET').toUpperCase();
    const url = joinUrl(baseUrl, route.path);
    const subject = `${method} ${route.path}`;
    const mutating = MUTATING_METHODS.has(method);

    let res: HttpResponseLite;
    try {
      res = await http({ method, url });
    } catch (error) {
      unreachable += 1;
      findings.push({ severity: 'warn', subject, detail: `request failed (${describe(error)})` });
      continue;
    }

    // A route that does not exist is always a failure (the contract declared it).
    if (res.status === 404) {
      findings.push({ severity: 'fail', subject, detail: 'route returns 404 — not implemented' });
      continue;
    }
    if (res.status >= 500) {
      findings.push({ severity: 'fail', subject, detail: `route returns ${res.status} (server error)` });
      continue;
    }

    if (mutating) {
      // Safety: probed unauthenticated with no body — it must EXIST and reject, not perform a write.
      if (REJECTION_STATUSES.has(res.status) || (res.redirected && isAuthGate(res.url, res.status))) {
        findings.push({
          severity: 'pass',
          subject,
          detail: `exists and rejected the unauthenticated/empty probe (${res.status}) — not exercised (safety)`,
        });
      } else {
        findings.push({
          severity: 'warn',
          subject,
          detail: `responded ${res.status} to an unauthenticated/empty ${method}; live mutation not exercised (Law 6 manual)`,
        });
      }
      continue;
    }

    // GET routes.
    if (route.authRequired) {
      if (REJECTION_STATUSES.has(res.status) || (res.redirected && isAuthGate(res.url, res.status))) {
        findings.push({ severity: 'pass', subject, detail: `auth-required route correctly rejected the anonymous call (${res.status})` });
      } else if (res.ok) {
        // Reachable but did not enforce auth — a wiring concern, surfaced (Law 5 covers gating).
        findings.push({ severity: 'warn', subject, detail: `auth-required route returned ${res.status} WITHOUT auth (verify gating)` });
      } else {
        findings.push({ severity: 'warn', subject, detail: `returned ${res.status}` });
      }
      continue;
    }

    const expectStatus = route.expectStatus ?? 200;
    if (res.status === expectStatus || (res.ok && route.expectStatus === undefined)) {
      const shape = responseShapeMatches(route.responseSchema, res.bodyText);
      const ct = res.headers['content-type'] ?? res.headers['Content-Type'] ?? '';
      if (shape === false) {
        findings.push({ severity: 'fail', subject, detail: `status ${res.status} ok but response shape did not match the contract` });
      } else if (route.responseSchema && /[{[]/.test(route.responseSchema) && !/json/i.test(ct)) {
        findings.push({ severity: 'warn', subject, detail: `status ${res.status} but content-type '${ct || 'unknown'}' is not JSON` });
      } else {
        findings.push({ severity: 'pass', subject, detail: `status ${res.status}${shape === true ? ', response shape matches' : ''}` });
      }
    } else {
      findings.push({ severity: 'fail', subject, detail: `expected ${expectStatus}, got ${res.status}` });
    }
  }

  // If EVERY route was unreachable, the app is not running — SKIP rather than fail wholesale.
  if (unreachable === routes.length) {
    return lawSkip(2, `Target app not reachable at ${baseUrl} — all ${routes.length} route probe(s) failed to connect.`);
  }
  log(`Law 2: probed ${routes.length} route(s)`);

  const fails = findings.filter((f) => f.severity === 'fail').length;
  const detail =
    fails === 0
      ? `${routes.length} route(s) verified (mutating routes probed for existence only — safety)`
      : `${fails} route violation(s) across ${routes.length} contract route(s)`;
  return lawResult(2, detail, findings, nowMs() - startedAt);
}

// ---------------------------------------------------------------------------
// Default Playwright driver (Laws 3-5)
// ---------------------------------------------------------------------------

/** Map an interaction element description to a representative CSS selector. */
export function selectorForElement(element: string): string {
  const e = element.toLowerCase();
  if (/\b(form|submit)\b/.test(e)) return 'form, button[type=submit], input[type=submit]';
  if (/\b(dropdown|select|combobox)\b/.test(e)) return 'select, [role=combobox], [role=listbox]';
  if (/\b(toggle|switch|checkbox)\b/.test(e)) return "input[type=checkbox], [role=switch]";
  if (/\b(tab)\b/.test(e)) return '[role=tab]';
  if (/\b(field|input|textbox|search)\b/.test(e)) return 'input, textarea';
  if (/\b(link|nav)\b/.test(e)) return 'a[href]';
  // Default: a button-like element.
  return 'button, [role=button], a[href], input[type=submit]';
}

/**
 * Create the default Playwright driver. Lazily imports `playwright` and launches Chromium. Returns
 * `null` (the laws then SKIP) when Playwright is unavailable or the browser cannot launch — never
 * throws.
 */
export async function createPlaywrightDriver(
  options: { headless?: boolean; storageState?: string | Record<string, unknown>; log?: (m: string) => void } = {}
): Promise<PageDriver | null> {
  const log = options.log ?? (() => {});
  let pw: typeof import('playwright');
  try {
    pw = await import('playwright');
  } catch (error) {
    log(`Playwright unavailable (${describe(error)})`);
    return null;
  }

  let browser: import('playwright').Browser;
  try {
    browser = await pw.chromium.launch({ headless: options.headless ?? true });
  } catch (error) {
    log(`Chromium failed to launch (${describe(error)})`);
    return null;
  }

  const probe = async (req: PageProbeRequest): Promise<PageProbe> => {
    const result: PageProbe = {
      url: req.url,
      finalUrl: req.url,
      ok: false,
      status: null,
      bodyText: '',
      consoleErrors: [],
      pageErrors: [],
      requests: [],
      presentSelectors: {},
      links: [],
      error: null,
    };

    // A fresh context per probe; for an unauthenticated probe, never apply storage state.
    const applyStorage = !req.unauthenticated && options.storageState !== undefined;
    const ctxArg: Parameters<typeof browser.newContext>[0] = applyStorage ? {} : undefined;
    if (applyStorage && ctxArg) {
      // storageState's Playwright type is narrower than our option; assign through an unknown view.
      (ctxArg as { storageState?: unknown }).storageState = options.storageState;
    }
    let context: import('playwright').BrowserContext | null = null;
    try {
      context = await browser.newContext(ctxArg);
      const page = await context.newPage();
      page.on('console', (msg) => {
        if (msg.type() === 'error') result.consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => result.pageErrors.push(String(err)));
      page.on('request', (r) =>
        result.requests.push({ method: r.method(), url: r.url(), resourceType: r.resourceType() })
      );

      const timeout = req.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
      const resp = await page.goto(req.url, { waitUntil: 'load', timeout });
      // Let outstanding XHR/fetch settle so Law 4 sees the data requests (swallow the timeout).
      await page.waitForLoadState('networkidle', { timeout: Math.min(5000, timeout) }).catch(() => {});

      result.status = resp ? resp.status() : null;
      result.finalUrl = page.url();
      result.ok = resp ? resp.status() < 400 : false;
      // Use Locator APIs (not page.evaluate) so no DOM globals are referenced — the tsconfig `lib`
      // is ES2022 only, with no DOM lib in scope for callback bodies.
      try {
        result.bodyText = await page.locator('body').innerText({ timeout: 2000 });
      } catch {
        result.bodyText = '';
      }

      for (const sel of req.selectors ?? []) {
        try {
          result.presentSelectors[sel] = (await page.locator(sel).count()) > 0;
        } catch {
          result.presentSelectors[sel] = false;
        }
      }

      if (req.collectLinks) {
        try {
          const anchors = page.locator('a[href]');
          const n = await anchors.count();
          const cap = Math.min(n, 200);
          for (let i = 0; i < cap; i++) {
            const href = await anchors.nth(i).getAttribute('href');
            if (href) result.links.push(href);
          }
        } catch {
          result.links = [];
        }
      }
    } catch (error) {
      result.error = describe(error);
    } finally {
      if (context) await context.close().catch(() => {});
    }
    return result;
  };

  const close = async (): Promise<void> => {
    await browser.close().catch(() => {});
  };

  return { probe, close };
}

// ---------------------------------------------------------------------------
// Laws 3-5 — page-driven (UI / DATA / WIRING)
// ---------------------------------------------------------------------------

/** Classify a request URL as an API/data call (vs a static asset). */
function isApiRequest(req: NetworkRequest, baseHost: string, knownApiPaths: ReadonlySet<string>): boolean {
  const rt = req.resourceType;
  if (rt === 'image' || rt === 'stylesheet' || rt === 'font' || rt === 'media') return false;
  const url = req.url.toLowerCase();
  if (/\/api\//.test(url)) return true;
  if (/\/rest\/v1\//.test(url) || /\/graphql\b/.test(url) || /supabase/.test(url)) return true; // Supabase REST/GraphQL
  for (const p of knownApiPaths) {
    if (url.includes(p.toLowerCase())) return true;
  }
  // An XHR/fetch to a different host is a data call too.
  if ((rt === 'xhr' || rt === 'fetch') && !url.includes(baseHost.toLowerCase())) return true;
  if (rt === 'xhr' || rt === 'fetch') return true;
  return false;
}

/** Expected interactive selectors for a page (explicit, else derived from interactions, else any). */
function expectedSelectorsFor(page: PageRouteSpec, interactions: InteractionSpec[]): string[] {
  if (page.expectedElements && page.expectedElements.length > 0) return page.expectedElements;
  const related = interactions.filter(
    (i) => i.page === page.path || (i.feature && (page.name ?? '').toLowerCase().includes(i.feature.toLowerCase()))
  );
  if (related.length > 0) {
    return [...new Set(related.map((i) => selectorForElement(i.element)))];
  }
  // Baseline: the page must render at least one interactive element.
  return ['a[href], button, input, select, textarea, form'];
}

/** Visit every page once and run Laws 3 + 4 together off the shared probe. */
async function verifyUiAndData(
  pages: PageRouteSpec[],
  interactions: InteractionSpec[],
  knownApiPaths: ReadonlySet<string>,
  baseUrl: string,
  placeholderPatterns: readonly RegExp[],
  driver: PageDriver,
  navTimeoutMs: number,
  log: (m: string) => void
): Promise<{ ui: LawResult; data: LawResult; probes: Map<string, PageProbe> }> {
  const uiStart = nowMs();
  const uiFindings: LawFinding[] = [];
  const dataFindings: LawFinding[] = [];
  const probes = new Map<string, PageProbe>();
  let baseHost = baseUrl;
  try {
    baseHost = new URL(baseUrl).host;
  } catch {
    baseHost = baseUrl;
  }

  for (const page of pages) {
    const url = joinUrl(baseUrl, page.path);
    const selectors = expectedSelectorsFor(page, interactions);
    const probe = await driver.probe({ url, selectors, collectLinks: true, timeoutMs: navTimeoutMs });
    probes.set(page.path, probe);

    if (probe.error) {
      uiFindings.push({ severity: 'warn', subject: page.path, detail: `could not load page (${probe.error})` });
      continue;
    }

    // A protected page that bounced to /login without an auth session can't be UI/DATA-verified here.
    const authBounced = isAuthGate(probe.finalUrl, probe.status) && (page.authRequired || (page.roles?.length ?? 0) > 0);
    if (authBounced) {
      uiFindings.push({ severity: 'warn', subject: page.path, detail: 'redirected to auth (no session) — UI not verified; provide storageState to check' });
      continue;
    }

    if (!probe.ok) {
      uiFindings.push({ severity: 'fail', subject: page.path, detail: `page did not render (status ${probe.status ?? 'none'})` });
      continue;
    }

    // --- Law 3a: placeholder text ---
    const lower = probe.bodyText.toLowerCase();
    const hits = placeholderPatterns.filter((re) => re.test(lower)).map((re) => re.source);
    if (hits.length > 0) {
      uiFindings.push({ severity: 'fail', subject: page.path, detail: `placeholder text present (${hits.join(', ')})` });
    }

    // --- Law 3b: interactive elements present ---
    const missing = selectors.filter((s) => !probe.presentSelectors[s]);
    if (missing.length > 0) {
      uiFindings.push({ severity: 'fail', subject: page.path, detail: `expected interactive element(s) missing: ${missing.join(' | ')}` });
    } else {
      uiFindings.push({ severity: 'pass', subject: page.path, detail: 'rendered with expected interactive elements' });
    }

    // --- Law 3c: console / page errors ---
    if (probe.consoleErrors.length > 0 || probe.pageErrors.length > 0) {
      const all = [...probe.pageErrors, ...probe.consoleErrors];
      uiFindings.push({ severity: 'fail', subject: page.path, detail: `${all.length} console/page error(s): ${clip(all.slice(0, 3).join(' | '))}` });
    }

    // --- Law 4: real API calls (not hardcoded/mock) ---
    const apiCalls = probe.requests.filter((r) => isApiRequest(r, baseHost, knownApiPaths));
    const expectsData = page.expectsData ?? selectors.some((s) => /table|list|card|select/.test(s)) ?? true;
    if (apiCalls.length > 0) {
      const mocky = apiCalls.filter((r) => /\b(mock|fixture|stub)\b/i.test(r.url));
      if (mocky.length > 0) {
        dataFindings.push({ severity: 'fail', subject: page.path, detail: `data appears mocked (${mocky.length} request(s) to mock endpoints)` });
      } else {
        dataFindings.push({ severity: 'pass', subject: page.path, detail: `${apiCalls.length} real API/data request(s)` });
      }
    } else if (expectsData) {
      dataFindings.push({ severity: 'fail', subject: page.path, detail: 'no API/data requests observed — data may be hardcoded' });
    } else {
      dataFindings.push({ severity: 'warn', subject: page.path, detail: 'no API requests (page may be static by design)' });
    }
  }

  log(`Laws 3-4: visited ${pages.length} page(s)`);
  const uiFails = uiFindings.filter((f) => f.severity === 'fail').length;
  const dataFails = dataFindings.filter((f) => f.severity === 'fail').length;
  const ui = lawResult(
    3,
    uiFails === 0 ? `${pages.length} page(s) rendered without placeholders/console errors` : `${uiFails} UI violation(s) across ${pages.length} page(s)`,
    uiFindings,
    nowMs() - uiStart
  );
  const data = lawResult(
    4,
    dataFails === 0 ? `pages issue real API/data calls (no hardcoded/mock data detected)` : `${dataFails} page(s) appear to use hardcoded/mock data`,
    dataFindings,
    0
  );
  return { ui, data, probes };
}

/** Run Law 5 (WIRING) — nav links, form wiring, and role-gating. */
async function verifyWiring(
  pages: PageRouteSpec[],
  interactions: InteractionSpec[],
  probes: Map<string, PageProbe>,
  baseUrl: string,
  driver: PageDriver,
  navTimeoutMs: number,
  maxNavLinks: number,
  log: (m: string) => void
): Promise<LawResult> {
  const startedAt = nowMs();
  const findings: LawFinding[] = [];
  const knownPaths = new Set(pages.map((p) => normalizePath(p.path)));

  // --- 5a: internal nav links resolve to known routes ---
  const internalLinks = new Set<string>();
  for (const probe of probes.values()) {
    for (const href of probe.links) {
      if (href.startsWith('/') && !href.startsWith('//')) internalLinks.add(normalizePath(href));
    }
  }
  let danglingNav = 0;
  for (const link of internalLinks) {
    if (!knownPaths.has(link)) {
      // A nav target outside the declared route set — verify it at least resolves (not 404).
      if (danglingNav < maxNavLinks) {
        const probe = await driver.probe({ url: joinUrl(baseUrl, link), timeoutMs: navTimeoutMs });
        if (probe.error || probe.status === 404 || (probe.status !== null && probe.status >= 500)) {
          findings.push({ severity: 'fail', subject: link, detail: `nav link target broken (status ${probe.status ?? 'unreachable'})` });
        } else {
          findings.push({ severity: 'warn', subject: link, detail: `nav link to a route not in the declared page set (status ${probe.status ?? 'ok'})` });
        }
      }
      danglingNav += 1;
    }
  }
  if (internalLinks.size > 0 && findings.every((f) => f.severity !== 'fail')) {
    findings.push({ severity: 'pass', subject: 'navigation', detail: `${internalLinks.size} internal nav link(s) resolve` });
  }

  // --- 5b: form interactions expose a wired form/submit control ---
  const formInteractions = interactions.filter((i) => i.apiCall && /\b(form|submit|save|create|update|button)\b/i.test(i.element));
  for (const interaction of formInteractions) {
    const pagePath = interaction.page;
    const probe = pagePath ? probes.get(pagePath) : undefined;
    const subject = `${interaction.feature}/${interaction.element}`;
    if (!probe) {
      findings.push({ severity: 'warn', subject, detail: `declared form→${interaction.apiCall ?? '?'} but its page was not visited` });
      continue;
    }
    const formSelector = selectorForElement(interaction.element);
    const hasForm = probe.presentSelectors[formSelector] === true;
    if (hasForm || probe.requests.some((r) => interaction.apiCall !== undefined && r.url.includes(interaction.apiCall))) {
      findings.push({ severity: 'pass', subject, detail: `form control present, wired to ${interaction.apiCall} (live submit deferred to Law 6 — safety)` });
    } else {
      findings.push({ severity: 'warn', subject, detail: `no obvious form/submit control found for ${interaction.apiCall} on ${pagePath}` });
    }
  }

  // --- 5c: role-based access restricts protected routes (Iron Law 4) ---
  const protectedPages = pages.filter((p) => p.authRequired || (p.roles?.length ?? 0) > 0);
  for (const page of protectedPages) {
    const probe = await driver.probe({ url: joinUrl(baseUrl, page.path), unauthenticated: true, timeoutMs: navTimeoutMs });
    if (probe.error) {
      findings.push({ severity: 'warn', subject: page.path, detail: `could not probe role-gating (${probe.error})` });
      continue;
    }
    if (isAuthGate(probe.finalUrl, probe.status)) {
      findings.push({ severity: 'pass', subject: page.path, detail: `protected route correctly redirected/blocked anonymous access (→ ${probe.finalUrl}, status ${probe.status ?? 'n/a'})` });
    } else if (probe.ok) {
      findings.push({ severity: 'fail', subject: page.path, detail: `protected route rendered for an UNAUTHENTICATED visitor (status ${probe.status}) — role gate missing` });
    } else {
      findings.push({ severity: 'warn', subject: page.path, detail: `protected route returned status ${probe.status ?? 'none'} unauthenticated (not a clear /login redirect)` });
    }
  }

  log(`Law 5: ${internalLinks.size} nav link(s), ${formInteractions.length} form(s), ${protectedPages.length} protected route(s)`);
  if (findings.length === 0) {
    return lawSkip(5, 'No nav links, form interactions, or protected routes to verify wiring against.');
  }
  const fails = findings.filter((f) => f.severity === 'fail').length;
  const detail = fails === 0 ? 'navigation, form wiring, and role-gating verified' : `${fails} wiring violation(s)`;
  return lawResult(5, detail, findings, nowMs() - startedAt);
}

/** Normalize a route path for comparison (strip trailing slash + query/hash). */
function normalizePath(path: string): string {
  const p = path.split('#')[0]?.split('?')[0] ?? path;
  const stripped = p.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Render the full markdown report. */
function renderReport(result: Omit<SixLawsResult, 'report'>): string {
  const lines: string[] = [];
  const tick = (l: LawResult): string => (l.skipped ? '⊘ SKIP' : l.passed ? '✅ PASS' : '❌ FAIL');

  lines.push('# FORGE — Six Laws Verification');
  lines.push('');
  lines.push(`- **Target:** ${result.baseUrl}`);
  lines.push(`- **Overall (Laws 1-5):** ${result.passed ? 'PASS ✅' : 'FAIL ❌'}`);
  lines.push(`- **Generated:** ${result.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Law | Name | Result | Detail |');
  lines.push('|-----|------|--------|--------|');
  for (const l of result.laws) {
    lines.push(`| ${l.law} | ${l.name} | ${tick(l)} | ${l.detail.replace(/\|/g, '\\|')} |`);
  }
  lines.push(`| 6 | VERIFICATION | ⏳ MANUAL | ${result.law6.detail.replace(/\|/g, '\\|')} |`);
  lines.push('');

  for (const l of result.laws) {
    const interesting = l.findings.filter((f) => f.severity !== 'pass');
    if (l.skipped) {
      lines.push(`### ⊘ Law ${l.law} — ${l.name} (skipped)`);
      lines.push('');
      lines.push(l.detail);
      lines.push('');
      continue;
    }
    if (interesting.length === 0) continue;
    lines.push(`### ${l.passed ? '⚠️' : '❌'} Law ${l.law} — ${l.name}`);
    lines.push('');
    for (const f of interesting) {
      const icon = f.severity === 'fail' ? '❌' : '⚠️';
      lines.push(`- ${icon} **${f.subject}** — ${f.detail}`);
    }
    lines.push('');
  }

  lines.push('## Law 6 — VERIFICATION (human gate)');
  lines.push('');
  lines.push(result.law6.detail);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run automated Six Laws verification (F13 / Contract 19) against a built, running target app.
 * Verifies Laws 1-5; Law 6 is reported as the pending human gate. Always resolves — never throws,
 * never fabricates a pass; unevaluable laws are SKIPPED with a note (Contract 4 / Iron Law 3).
 */
export async function verifySixLaws(
  input: SixLawsInput,
  options: SixLawsOptions = {}
): Promise<SixLawsResult> {
  const log = options.log ?? logLine('sixlaws');
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const navTimeoutMs = options.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  const maxNavLinks = options.maxNavLinks ?? DEFAULT_MAX_NAV_LINKS;
  const placeholderPatterns = options.placeholderPatterns ?? [...DEFAULT_PLACEHOLDER_PATTERNS];
  const interactions = input.interactions ?? [];

  log(`verifying Six Laws against ${baseUrl}`);

  // Laws 1 + 2 (no browser).
  const law1 = await verifySchema(input, options, log);
  const law2 = await verifyApi(input, options, baseUrl, log);

  // Laws 3-5 need page routes + a browser driver.
  const pages = input.pages ?? [];
  let law3: LawResult;
  let law4: LawResult;
  let law5: LawResult;

  if (pages.length === 0) {
    const note = 'No page routes supplied — page-driven laws not evaluated.';
    law3 = lawSkip(3, note);
    law4 = lawSkip(4, note);
    law5 = lawSkip(5, note);
  } else {
    let driver: PageDriver | null = options.driver ?? null;
    let ownsDriver = false;
    if (!driver) {
      const create =
        options.createDriver ??
        (() =>
          createPlaywrightDriver({
            headless: options.headless ?? true,
            ...(options.storageState !== undefined ? { storageState: options.storageState } : {}),
            log,
          }));
      try {
        driver = await create();
      } catch (error) {
        log(`WARNING: driver creation failed (${describe(error)})`);
        driver = null;
      }
      ownsDriver = driver !== null;
    }

    if (!driver) {
      const note = 'Browser driver unavailable (Playwright not installed / failed to launch) — page laws not evaluated.';
      law3 = lawSkip(3, note);
      law4 = lawSkip(4, note);
      law5 = lawSkip(5, note);
    } else {
      const knownApiPaths = new Set(
        (input.apiRoutes ?? []).map((r) => r.path).concat(interactions.map((i) => i.apiCall ?? '').filter((p) => p !== ''))
      );
      try {
        const { ui, data, probes } = await verifyUiAndData(
          pages,
          interactions,
          knownApiPaths,
          baseUrl,
          placeholderPatterns,
          driver,
          navTimeoutMs,
          log
        );
        law3 = ui;
        law4 = data;
        law5 = await verifyWiring(pages, interactions, probes, baseUrl, driver, navTimeoutMs, maxNavLinks, log);
      } catch (error) {
        // Defensive: a driver-level fault degrades the page laws to SKIP, never aborts the run.
        log(`WARNING: page-law verification degraded (${describe(error)})`);
        const note = `Page-law verification failed (${describe(error)}).`;
        law3 = lawSkip(3, note);
        law4 = lawSkip(4, note);
        law5 = lawSkip(5, note);
      } finally {
        if (ownsDriver) await driver.close().catch(() => {});
      }
    }
  }

  const laws = [law1, law2, law3, law4, law5];
  // `passed` = every EVALUATED law passed (a skipped law neither passes nor fails the gate).
  const passed = laws.every((l) => l.skipped || l.passed) && laws.some((l) => !l.skipped);

  const partial: Omit<SixLawsResult, 'report'> = {
    passed,
    laws,
    law6: {
      name: 'VERIFICATION',
      automated: false,
      detail:
        'Law 6 is the final HUMAN gate (Contract 19): a person must confirm the feature in the browser. ' +
        'It is intentionally NOT automated and is never reported as passed by this tool.',
    },
    baseUrl,
    generatedAt: nowIso(),
  };
  const report = renderReport(partial);

  const evaluated = laws.filter((l) => !l.skipped).length;
  log(passed ? `Six Laws: PASS ✅ (${evaluated}/5 evaluated)` : `Six Laws: FAIL ❌ (${evaluated}/5 evaluated)`);

  return { ...partial, report };
}

// ---------------------------------------------------------------------------
// Adapters — architecture artifacts → verifier specs (type-only arch import)
// ---------------------------------------------------------------------------

/** Convert Phase 1B `ArchPage[]` to {@link PageRouteSpec}s. */
export function archPagesToSpecs(pages: ReadonlyArray<ArchPage>): PageRouteSpec[] {
  return pages.map((p) => ({
    path: p.path,
    name: p.name,
    authRequired: p.authRequired,
    roles: p.roles,
    expectsData: p.apiCalls.length > 0,
  }));
}

/** Convert Phase 1B `ApiRoute[]` to {@link ApiRouteSpec}s. */
export function archRoutesToSpecs(routes: ReadonlyArray<ApiRoute>): ApiRouteSpec[] {
  return routes.map((r) => ({
    path: r.path,
    method: r.method,
    authRequired: r.authRequired,
    roles: r.roles,
    responseSchema: r.responseSchema,
  }));
}

/** Convert Phase 1B `InteractionMap[]` to {@link InteractionSpec}s. */
export function archInteractionsToSpecs(maps: ReadonlyArray<InteractionMap>): InteractionSpec[] {
  return maps.map((m) => ({
    feature: m.feature,
    element: m.element,
    ...(m.apiCall ? { apiCall: m.apiCall } : {}),
  }));
}

export default verifySixLaws;
