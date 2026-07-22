// FORGE 2.0 — RETROFIT: Orphaned Route Detector
//
// Regex-based (not AST-based) scan of a target project's src/app/api/**/route.ts tree to
// enumerate every Next.js API route and its exported HTTP methods, then cross-references every
// non-route .ts(x) file in src/** for fetch()/axios()/supabase-client string literals that
// reference an API path. A route with zero frontend callers anywhere in the codebase is flagged
// orphaned, except for a small allowlist of routes that are legitimately called from outside the
// frontend (health checks, webhook receivers, auth-library internals). Read-only against the
// target project — the only write this module performs is the best-effort Build Memory
// persistence step (`orphaned_routes`), which never throws (Contract 4 — a Build Memory failure
// degrades to stateless mode, it does not halt the caller).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { getClient, logMemoryWarning, newId, nowIso } from '../memory/client.js';

export interface OrphanedRouteFinding {
  routePath: string;
  httpMethods: string[];
  reason: string;
  filePath: string;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.forge', '.claude', '.vercel']);
const SOURCE_FILE_RE = /\.(ts|tsx)$/;
const TEST_OR_STORY_RE = /\.(test|spec)\.tsx?$|\.stories\.tsx$/;
const ROUTE_FILE_BASENAMES = new Set(['route.ts', 'route.tsx']);

/** Recursively collects every `src/app/api/**\/route.ts(x)` file, fs.readdirSync-based. */
function walkRouteFiles(projectPath: string): string[] {
  const acc: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable directory — skip, never throw
    }

    for (const entry of entries) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);

      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue; // unreadable entry — skip
      }

      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (ROUTE_FILE_BASENAMES.has(entry)) acc.push(fullPath);
    }
  }

  walk(join(projectPath, 'src', 'app', 'api'));
  return acc;
}

/** Recursively collects every `src/**\/*.ts(x)` file EXCLUDING route.ts(x)/test/story files. */
function walkFrontendFiles(projectPath: string): string[] {
  const acc: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);

      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!SOURCE_FILE_RE.test(entry)) continue;
      if (entry.endsWith('.d.ts')) continue;
      if (ROUTE_FILE_BASENAMES.has(entry)) continue; // route files are the target, not a caller
      if (TEST_OR_STORY_RE.test(entry)) continue;
      acc.push(fullPath);
    }
  }

  walk(join(projectPath, 'src'));
  return acc;
}

function toProjectRelative(projectPath: string, absPath: string): string {
  return relative(projectPath, absPath).replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Route path + HTTP method extraction
// ---------------------------------------------------------------------------

/**
 * Converts `<projectPath>/src/app/api/users/[id]/route.ts` into `/api/users/[id]`.
 * Route-group segments (folders wrapped in parens, e.g. `(v1)`) are organizational only in
 * Next.js and never appear in the resolved URL, so they are stripped.
 */
function computeRoutePath(projectPath: string, absPath: string): string {
  const appDir = join(projectPath, 'src', 'app');
  let rel = relative(appDir, absPath).replace(/\\/g, '/');
  rel = rel.replace(/\/route\.tsx?$/, '').replace(/^route\.tsx?$/, '');

  const segments = rel.split('/').filter((seg) => seg.length > 0 && !/^\(.*\)$/.test(seg));
  return '/' + segments.join('/');
}

const HTTP_METHOD_NAMES = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'] as const;

const EXPORTED_HANDLER_FUNCTION_RE = /^export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b/;
const EXPORTED_HANDLER_CONST_RE = /^export\s+const\s+(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b/;

/** Parses `export function GET(...)` / `export const POST = ...` handler declarations. */
function extractHttpMethods(content: string): string[] {
  const found = new Set<string>();
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    const fnMatch = EXPORTED_HANDLER_FUNCTION_RE.exec(trimmed);
    if (fnMatch?.[1]) {
      found.add(fnMatch[1]);
      continue;
    }
    const constMatch = EXPORTED_HANDLER_CONST_RE.exec(trimmed);
    if (constMatch?.[1]) found.add(constMatch[1]);
  }

  // Stable, canonical ordering rather than declaration order.
  return HTTP_METHOD_NAMES.filter((method) => found.has(method));
}

// ---------------------------------------------------------------------------
// Frontend caller extraction — fetch()/axios()/supabase-client string literals
// ---------------------------------------------------------------------------

// '/api/...' or "/api/..." — matches fetch('/api/x'), axios.post('/api/x', body), etc.
const API_QUOTED_LITERAL_RE = /'(\/api\/[^'\\]*)'|"(\/api\/[^"\\]*)"/g;
// `/api/...` — template literal; truncated at the first `${` since only the static prefix is
// known statically (fetch(`/api/users/${id}`) tells us the caller targets /api/users/<something>).
const API_TEMPLATE_LITERAL_RE = /`(\/api\/[^`]*)`/g;
// A string literal used as the right-hand side of concatenation, e.g. `fetch(API_URL + '/users')`
// — the literal itself doesn't start with /api/ (the base is a variable), so it is tracked
// separately and matched against the TAIL of a route path rather than the head.
const CONCAT_SUFFIX_LITERAL_RE = /\+\s*['"`](\/[^'"`]+)['"`]/g;

function normalizeCandidate(raw: string): string {
  let value = raw.trim();
  const queryIndex = value.indexOf('?');
  if (queryIndex !== -1) value = value.slice(0, queryIndex);
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

interface ApiCandidates {
  /** Full or statically-known-prefix API path strings, e.g. '/api/users', '/api/users/'. */
  exact: Set<string>;
  /** Path suffix literals from string concatenation whose base is a runtime variable. */
  suffixes: Set<string>;
}

/** Scans one frontend file's raw content for every fetch/axios/supabase-style API path literal. */
function extractApiCandidates(content: string): ApiCandidates {
  const exact = new Set<string>();
  const suffixes = new Set<string>();
  let match: RegExpExecArray | null;

  API_QUOTED_LITERAL_RE.lastIndex = 0;
  while ((match = API_QUOTED_LITERAL_RE.exec(content))) {
    const raw = match[1] ?? match[2];
    if (raw) exact.add(normalizeCandidate(raw));
  }

  API_TEMPLATE_LITERAL_RE.lastIndex = 0;
  while ((match = API_TEMPLATE_LITERAL_RE.exec(content))) {
    const raw = match[1];
    if (!raw) continue;
    const staticPrefix = raw.split('${')[0] ?? raw;
    if (staticPrefix) exact.add(normalizeCandidate(staticPrefix));
  }

  CONCAT_SUFFIX_LITERAL_RE.lastIndex = 0;
  while ((match = CONCAT_SUFFIX_LITERAL_RE.exec(content))) {
    const raw = match[1];
    if (raw) suffixes.add(normalizeCandidate(raw));
  }

  return { exact, suffixes };
}

/** Merges one file's candidates into the project-wide aggregate sets, in place. */
function mergeCandidates(target: ApiCandidates, source: ApiCandidates): void {
  for (const value of source.exact) target.exact.add(value);
  for (const value of source.suffixes) target.suffixes.add(value);
}

// ---------------------------------------------------------------------------
// Route <-> caller matching
// ---------------------------------------------------------------------------

interface RouteShape {
  hasDynamicSegment: boolean;
  /** Static path up to and including the trailing slash before the first dynamic segment. */
  staticPrefix: string;
}

function computeRouteShape(routePath: string): RouteShape {
  const segments = routePath.split('/').filter((seg) => seg.length > 0);
  const dynamicIndex = segments.findIndex((seg) => /^\[.*\]$/.test(seg));

  if (dynamicIndex === -1) {
    return { hasDynamicSegment: false, staticPrefix: routePath };
  }
  return {
    hasDynamicSegment: true,
    staticPrefix: '/' + segments.slice(0, dynamicIndex).join('/') + '/',
  };
}

/** True if any frontend-extracted candidate plausibly targets this API route. */
function routeHasFrontendCaller(routePath: string, shape: RouteShape, candidates: ApiCandidates): boolean {
  if (candidates.exact.has(routePath)) return true;

  if (shape.hasDynamicSegment) {
    for (const candidate of candidates.exact) {
      if (candidate.startsWith(shape.staticPrefix)) return true;
    }
  }

  for (const suffix of candidates.suffixes) {
    if (suffix.length > 1 && routePath.endsWith(suffix)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Exclusions — routes called from outside the frontend, never truly orphaned
// ---------------------------------------------------------------------------

const EXCLUDED_ROUTE_PATTERNS: RegExp[] = [
  /^\/api\/health$/, // liveness/readiness probe, called by infra not the frontend
  /^\/api\/webhooks(\/|$)/, // called by external services (Stripe, Twilio, etc.)
  /^\/api\/auth(\/|$)/, // called internally by the auth library, not app code
];

function isExcludedRoute(routePath: string): boolean {
  return EXCLUDED_ROUTE_PATTERNS.some((pattern) => pattern.test(routePath));
}

// ---------------------------------------------------------------------------
// Build Memory persistence (Contract 4 — best-effort, never throws)
// ---------------------------------------------------------------------------

function persistFindings(runId: string, projectPath: string, findings: OrphanedRouteFinding[]): void {
  if (findings.length === 0) return;

  const db = getClient();
  if (!db) return; // Build Memory unavailable — degrade to stateless mode

  try {
    const insert = db.prepare(
      `INSERT INTO orphaned_routes
         (id, build_run_id, project_path, route_path, http_methods, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAll = db.transaction((rows: OrphanedRouteFinding[]) => {
      for (const row of rows) {
        insert.run(newId(), runId, projectPath, row.routePath, JSON.stringify(row.httpMethods), row.reason, nowIso());
      }
    });
    insertAll(findings);
  } catch (error) {
    logMemoryWarning('orphaned-route-detector:persist', error);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class OrphanedRouteDetector {
  /**
   * Enumerates every `src/app/api/**\/route.ts(x)` file, extracts its route path + exported HTTP
   * methods, then scans every non-route `.ts(x)` file under `src/**` for fetch/axios/supabase
   * string literals referencing an API path. Routes with zero matching frontend callers are
   * flagged orphaned, excluding `/api/health`, `/api/webhooks/*`, and `/api/auth/*` (called from
   * outside the frontend by design). Read-only against the project. Findings are persisted to
   * `orphaned_routes` (best-effort) and returned sorted by route path.
   */
  async detect(projectPath: string): Promise<OrphanedRouteFinding[]> {
    const runId = newId();

    const routeFiles = walkRouteFiles(projectPath);
    const frontendFiles = walkFrontendFiles(projectPath);

    const candidates: ApiCandidates = { exact: new Set(), suffixes: new Set() };
    for (const absPath of frontendFiles) {
      let content: string;
      try {
        content = readFileSync(absPath, 'utf8');
      } catch {
        continue; // unreadable file — skip, never throw
      }
      mergeCandidates(candidates, extractApiCandidates(content));
    }

    const findings: OrphanedRouteFinding[] = [];

    for (const absPath of routeFiles) {
      let content: string;
      try {
        content = readFileSync(absPath, 'utf8');
      } catch {
        continue;
      }

      const routePath = computeRoutePath(projectPath, absPath);
      if (isExcludedRoute(routePath)) continue;

      const httpMethods = extractHttpMethods(content);
      const shape = computeRouteShape(routePath);

      if (routeHasFrontendCaller(routePath, shape, candidates)) continue;

      const methodsLabel = httpMethods.length > 0 ? httpMethods.join(', ') : 'no exported HTTP methods';
      findings.push({
        routePath,
        httpMethods,
        reason: `route "${routePath}" (${methodsLabel}) has zero frontend callers referencing this path`,
        filePath: toProjectRelative(projectPath, absPath),
      });
    }

    findings.sort((a, b) => a.routePath.localeCompare(b.routePath));

    persistFindings(runId, projectPath, findings);

    return findings;
  }
}

export function createOrphanedRouteDetector(): OrphanedRouteDetector {
  return new OrphanedRouteDetector();
}
