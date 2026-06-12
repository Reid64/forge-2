/**
 * FORGE 2.0 — SEO Validator (`src/tools/seo-validator.ts`).
 *
 * After any Phase 3 prompt that MODIFIES UI files (`.tsx`/`.css` — see {@link hasUiFileChanges}),
 * boot the built target app and drive Playwright to load EVERY page route, then validate each rendered
 * page for search-engine readiness. Where the Live Preview Gate proves a route *renders*, Visual
 * Regression proves it *still looks the same*, and the Accessibility Auditor proves it is *usable by
 * everyone*, this validator proves the rendered page is *discoverable and indexable* — the SEO
 * counterpart a `tsc`/`build`/screenshot pass cannot give.
 *
 * WHAT IT CHECKS (the task contract — per-page unless noted SITE-WIDE):
 *   - unique title tags, no duplicates across routes  → `title` (SITE-WIDE duplicate cross-check)
 *   - meta description present and under 160 chars     → `meta_description`
 *   - canonical URL set                                → `canonical`
 *   - Open Graph tags present                          → `open_graph` (og:title/description/image/url/type)
 *   - structured data JSON-LD present and valid        → `structured_data` (parsed; invalid = critical)
 *   - robots meta appropriate per page type            → `robots` (public≠noindex, private should noindex)
 *   - sitemap.xml generation and validity              → `sitemap` (SITE-WIDE; fetched from the app)
 *   - internal link structure: no orphans, no broken   → `internal_links` (SITE-WIDE graph analysis)
 *   - heading hierarchy: single H1, logical H2-H6       → `heading_hierarchy`
 *   - image optimization: WebP, lazy, width/height      → `image_optimization`
 *
 * SCORING: every page receives a 0–100 SEO score (start at 100, deduct per issue by severity —
 * {@link SEVERITY_WEIGHT}). A site-wide `siteScore` is the mean of the audited pages' scores. Issues are
 * graded on the same severity scale the Accessibility and Security checks use (`critical` / `serious` /
 * `moderate` / `minor`); **CRITICAL issues BLOCK the build** (`blocked = critical > 0`, `passed = !blocked`)
 * — lesser issues are surfaced but non-blocking. The output is an {@link SEOAuditResult} with per-page
 * scores + a site rollup, stored in Build Memory (`production_telemetry`, guarded — Contract 4).
 *
 * SITE-WIDE analysis (cannot be done page-at-a-time) runs in {@link analyzeSeo}, a PURE function over the
 * collected page data: duplicate `<title>` detection across routes, the internal-link graph (a discovered
 * static route nothing links to is an ORPHAN; an internal link resolving to no known route is BROKEN), and
 * the fetched `sitemap.xml` (well-formedness + that the discovered static routes appear in it). Because the
 * heavy logic is a pure function, the validator unit-tests with no browser and no server at all.
 *
 * HOUSE STYLE (matches `accessibility-auditor`, `live-preview-gate`, `visual-regression`, `security-scanner`,
 * `phase4-sentinel`): NON-FATAL and never throws, never fabricates a pass. A precondition that cannot be
 * evaluated — the dev server never boots, Playwright is unavailable, a route won't load — is reported as
 * `skipped`/`error` on that route (or the whole run) with a note, NEVER a false pass and NEVER a false fail
 * (Iron Law 3). Every external collaborator (the dev-server starter, the browser driver, route discovery,
 * the sitemap/robots fetcher, and the Build-Memory writer) is injectable.
 *
 * BOUNDARY (Iron Law 1): writes nothing to the target's filesystem — it runs the app and reads its rendered
 * pages + `sitemap.xml`/`robots.txt`, then writes ONLY a summary row to Build Memory. Never reads source,
 * governance, or secrets. ZERO new npm dependency (Playwright is already a dependency; `fetch` is built-in).
 */

import { basename } from 'node:path';

import { readCodebase } from './codebase-reader.js';
import type { RouteInfo } from './codebase-reader.js';
import { logLine } from './forge-logger.js';
import {
  defaultStartDevServer,
  hasUiFileChanges,
  concreteUrlPath,
  type DevServerStarter,
  type DevServerStart,
} from './live-preview-gate.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import type { JsonObject, TelemetryEventType, TelemetrySeverity } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public contract — severities, checks, issues
// ---------------------------------------------------------------------------

/** Issue severity — same scale as the Accessibility/Security checks. `critical` blocks the build. */
export type SeoSeverity = 'critical' | 'serious' | 'moderate' | 'minor';

/** The ten SEO check categories (the task contract). */
export type SeoCheck =
  | 'title'
  | 'meta_description'
  | 'canonical'
  | 'open_graph'
  | 'structured_data'
  | 'robots'
  | 'sitemap'
  | 'internal_links'
  | 'heading_hierarchy'
  | 'image_optimization';

/** Count of issues at each severity. */
export interface SeoSeverityCounts {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
}

/** A single SEO issue on one page (or, for site-wide checks, on the run). */
export interface SeoIssue {
  /** Which of the ten checks raised this. */
  check: SeoCheck;
  /** Mapped severity. */
  severity: SeoSeverity;
  /** Human-readable description of what's wrong + how to fix. */
  message: string;
}

// ---------------------------------------------------------------------------
// Public contract — input
// ---------------------------------------------------------------------------

/** A single route to validate. */
export interface SeoRouteSpec {
  /** Route path with dynamic segments as `:seg`/`*seg` (joined onto `baseUrl`). */
  path: string;
  /** Friendly name (for the report). */
  name?: string;
  /** Whether the route carries a dynamic/catch-all segment (validated best-effort, never hard-fails). */
  dynamic?: boolean;
}

/** What to validate — the project to boot + the routes to visit. */
export interface SeoAuditInput {
  /** Target project root. The dev server runs here. */
  projectPath: string;
  /** Project name for the Build-Memory record. Default: basename of `projectPath`. */
  projectName?: string;
  /** Optional `build_runs.id` to associate the stored result with. */
  buildRunId?: string;
  /**
   * Routes to validate. When omitted, they are DISCOVERED from the app directory via `readCodebase`
   * (`kind: 'page'` routes). An empty discovery → the run is a no-op (`pages: []`, passed).
   */
  routes?: SeoRouteSpec[];
  /** Running app base URL. Default `http://localhost:3000`. */
  baseUrl?: string;
  /**
   * Whether to boot the dev server (`pnpm dev`) before validating. Default true. Set false when the app
   * is already running at `baseUrl` (e.g. a prior Sentinel check already booted it).
   */
  startServer?: boolean;
  /** Dev-server command. Default `pnpm` (BLUEPRINT TECH STACK — never npm/yarn). */
  devCommand?: string;
  /** Dev-server args. Default `['dev']`. */
  devArgs?: string[];
  /** Max length a meta description may reach before it is flagged (task: "under 160 chars"). Default 160. */
  maxMetaDescriptionLength?: number;
  /** How long to wait for the dev server to answer HTTP before giving up (ms). Default 90000. */
  startupTimeoutMs?: number;
  /** Readiness poll interval while waiting for the dev server (ms). Default 1000. */
  pollIntervalMs?: number;
  /** Per-navigation timeout (ms). Default 20000. */
  navTimeoutMs?: number;
  /**
   * Changed files from the prompt that just ran. When supplied, the audit ONLY runs if at least one is
   * a UI file (`.tsx`/`.css` — see {@link hasUiFileChanges}); otherwise it returns a no-op run. When
   * omitted, the audit assumes it was invoked deliberately and runs.
   */
  changedFiles?: string[];
}

// ---------------------------------------------------------------------------
// Public contract — raw page data (what the driver extracts from each page)
// ---------------------------------------------------------------------------

/** One `<img>` observed on a page (the SEO-relevant attributes). */
export interface RawSeoImage {
  /** `src` (or `currentSrc`) of the image. */
  src: string;
  /** `srcset` value, if any (used to detect a WebP candidate). */
  srcset: string;
  /** `loading` attribute value (`lazy` is the optimized value). */
  loading: string;
  /** Whether an explicit `width` attribute is present (prevents layout shift). */
  hasWidth: boolean;
  /** Whether an explicit `height` attribute is present (prevents layout shift). */
  hasHeight: boolean;
}

/** One heading observed on a page, in document order. */
export interface RawSeoHeading {
  /** 1–6. */
  level: number;
  /** Trimmed, clipped heading text (for the report). */
  text: string;
}

/** Everything the in-page extractor pulls from a single rendered document. */
export interface RawSeoData {
  /** `document.title` (empty string when absent). */
  title: string;
  /** `meta[name=description]` content, or null when the tag is absent. */
  metaDescription: string | null;
  /** `link[rel=canonical]` href, or null when absent. */
  canonical: string | null;
  /** `meta[name=robots]` content, or null when absent. */
  robots: string | null;
  /** All `meta[property^="og:"]` as `{ 'og:title': '…', … }`. */
  ogTags: Record<string, string>;
  /** Raw textContent of every `script[type="application/ld+json"]` block. */
  jsonLd: string[];
  /** Every `h1`–`h6` in document order. */
  headings: RawSeoHeading[];
  /** Every `<img>` on the page. */
  images: RawSeoImage[];
  /** Same-origin link targets, as pathnames (for the internal-link graph). */
  internalLinks: string[];
}

// ---------------------------------------------------------------------------
// Public contract — results
// ---------------------------------------------------------------------------

/** Per-route outcome. */
export type SeoPageStatus =
  | 'pass' //     validated, zero issues
  | 'fail' //     validated, ≥1 issue (build-blocking only when a critical is present)
  | 'error' //    could not navigate/validate at all — neither pass nor fail (un-evaluable)
  | 'skipped'; // not evaluated (dynamic route best-effort, server/browser unavailable)

/** The validation result for one route, including its SEO score. */
export interface SeoPageResult {
  path: string;
  name?: string;
  /** Full URL validated (with any synthetic dynamic-segment substitution). */
  url: string;
  status: SeoPageStatus;
  /** True only for `pass`. */
  passed: boolean;
  /** HTTP status of the navigation, or null when no response was received. */
  httpStatus: number | null;
  /** 0–100 SEO score (100 minus severity-weighted deductions; null for error/skipped). */
  score: number | null;
  /** The page's `<title>` (for the report / duplicate cross-check), or null. */
  title: string | null;
  /** Issues found on this page, sorted most-severe-first. */
  issues: SeoIssue[];
  /** Per-severity counts for this page. */
  counts: SeoSeverityCounts;
  /** Whether this route carries a dynamic/catch-all segment (validated best-effort). */
  dynamic: boolean;
  /** One-line human-readable detail. */
  detail: string;
}

/** Two or more routes that render the same `<title>` (an SEO defect). */
export interface DuplicateTitleGroup {
  title: string;
  paths: string[];
}

/** An internal link that resolves to no known route. */
export interface BrokenLink {
  /** The page the link was found on. */
  from: string;
  /** The link target pathname that matched no route. */
  to: string;
}

/** The fetched-and-parsed `sitemap.xml` summary. */
export interface SitemapResult {
  /** Whether `/sitemap.xml` was served (HTTP 200, non-empty). */
  found: boolean;
  /** Whether it parsed as a well-formed urlset/sitemapindex with ≥1 `<loc>`. */
  valid: boolean;
  /** Number of `<loc>` entries found. */
  urlCount: number;
  /** Discovered static routes that are ABSENT from the sitemap. */
  missingRoutes: string[];
  /** One-line human-readable detail. */
  detail: string;
}

/** The fetched `robots.txt` summary. */
export interface RobotsTxtResult {
  /** Whether `/robots.txt` was served (HTTP 200, non-empty). */
  found: boolean;
  /** Whether it references a `Sitemap:` directive. */
  declaresSitemap: boolean;
  /** One-line human-readable detail. */
  detail: string;
}

/** The full SEO audit result (the validator's output contract — `SEOAuditResult`). */
export interface SEOAuditResult {
  /** False iff at least one CRITICAL issue exists (i.e. `!blocked`). */
  passed: boolean;
  /** True iff ≥1 CRITICAL issue — the build is blocked (the task contract). */
  blocked: boolean;
  /** Whether the audit actually evaluated routes (false ⇒ no UI change / server down / no routes). */
  ran: boolean;
  /** Whether the dev server became ready (or was assumed running when `startServer:false`). */
  devServerStarted: boolean;
  /** Whether a browser driver was available at all (false ⇒ every route skipped). */
  driverAvailable: boolean;
  /** Routes with ≥1 issue (subset of `pages`). */
  failures: SeoPageResult[];
  pages: SeoPageResult[];
  /** Site-wide issues not tied to a single page (sitemap, robots). Folded into `counts`/`blocked`. */
  siteIssues: SeoIssue[];
  /** Build-wide severity rollup across every page + the site-wide issues. */
  counts: SeoSeverityCounts;
  /** Total issues across all pages + site-wide. */
  totalIssues: number;
  /** Mean SEO score across the audited pages (0–100), or null when nothing was audited. */
  siteScore: number | null;
  /** Count of routes actually validated (status pass|fail). */
  auditedPages: number;
  /** Count of routes not evaluated (skipped/error). */
  skippedPages: number;
  /** Duplicate-title groups across routes. */
  duplicateTitles: DuplicateTitleGroup[];
  /** Static routes nothing links to (orphans). */
  orphanPages: string[];
  /** Internal links resolving to no known route. */
  brokenLinks: BrokenLink[];
  /** The `sitemap.xml` summary. */
  sitemap: SitemapResult;
  /** The `robots.txt` summary. */
  robots: RobotsTxtResult;
  baseUrl: string;
  /** Full markdown report. */
  report: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Public contract — injectable collaborators
// ---------------------------------------------------------------------------

/** A request to load one URL and extract its SEO data. */
export interface SeoProbeRequest {
  url: string;
  navTimeoutMs: number;
}

/** The observations from loading one page. */
export interface SeoProbe {
  /** True when the page navigated to a non-error (<400) status. */
  ok: boolean;
  /** HTTP status of the navigation, or null. */
  status: number | null;
  /** URL after redirects. */
  finalUrl: string;
  /** Extracted SEO data (null when the navigation/extraction failed). */
  data: RawSeoData | null;
  /** Set when the navigation/extraction itself failed (unreachable, timeout, …). */
  error: string | null;
}

/** A browser driver the validator uses. The default is Playwright/Chromium; tests inject a fake. */
export interface SeoDriver {
  audit(req: SeoProbeRequest): Promise<SeoProbe>;
  close(): Promise<void>;
}

/** The result of fetching a text resource (`sitemap.xml` / `robots.txt`). */
export interface FetchResult {
  ok: boolean;
  status: number | null;
  body: string;
  contentType: string | null;
}

/** Fetches a URL's raw text. Default: built-in `fetch`. Injectable for tests. */
export type ResourceFetcher = (url: string) => Promise<FetchResult>;

/** A guarded Build-Memory writer for the audit summary (injectable for tests). */
export type SeoResultStore = (record: SeoStoredRecord) => Promise<void>;

/** The summary persisted to Build Memory. */
export interface SeoStoredRecord {
  projectName: string;
  buildRunId: string | null;
  blocked: boolean;
  counts: SeoSeverityCounts;
  totalIssues: number;
  siteScore: number | null;
  auditedPages: number;
  skippedPages: number;
  baseUrl: string;
  generatedAt: string;
  /** Per-page score + issue counts (for the event payload). */
  pages: Array<{ path: string; status: SeoPageStatus; score: number | null; counts: SeoSeverityCounts }>;
}

/** Options — injectable collaborators + tuning (none required). */
export interface SeoValidatorOptions {
  /** Override route discovery (tests). Default: `readCodebase(projectPath)` page routes. */
  discoverRoutes?: (projectPath: string) => Promise<SeoRouteSpec[]>;
  /** Inject a ready browser driver. Default: a lazily-created Playwright driver. */
  driver?: SeoDriver;
  /** Override how the default driver is created (tests). Returns null when unavailable. */
  createDriver?: (opts: {
    headless: boolean;
    viewport: { width: number; height: number };
    log: (m: string) => void;
  }) => Promise<SeoDriver | null>;
  /** Override the dev-server starter (tests). Default: {@link defaultStartDevServer}. */
  startDevServer?: DevServerStarter;
  /** Override the sitemap/robots fetcher (tests). Default: a guarded built-in `fetch`. */
  fetchResource?: ResourceFetcher;
  /** Override the Build-Memory writer (tests). Default: a guarded `production_telemetry` insert. */
  storeResult?: SeoResultStore;
  /** Run the browser headless. Default true. */
  headless?: boolean;
  /** Deterministic viewport for the audit. Default 1280×800. */
  viewport?: { width: number; height: number };
  /** Override the timestamp source (tests). Default: `nowIso`. */
  now?: () => string;
  /** Progress reporter. Default logs with a `[FORGE:seo]` prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_DEV_COMMAND = 'pnpm';
const DEFAULT_DEV_ARGS: readonly string[] = ['dev'];
const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_NAV_TIMEOUT_MS = 20_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
/** Task contract: a meta description must stay UNDER this many characters. */
export const DEFAULT_MAX_META_DESCRIPTION = 160;
/** The Open Graph tags considered REQUIRED for a shareable page. */
export const REQUIRED_OG_TAGS: readonly string[] = ['og:title', 'og:description', 'og:image'];
/** The Open Graph tags considered RECOMMENDED (missing ⇒ minor, not moderate). */
export const RECOMMENDED_OG_TAGS: readonly string[] = ['og:url', 'og:type'];
/** Path prefixes that SHOULD carry a `noindex` robots directive (private/app areas). */
export const PRIVATE_PATH_PREFIXES: readonly string[] = [
  '/login',
  '/signup',
  '/register',
  '/signin',
  '/sign-in',
  '/sign-up',
  '/logout',
  '/admin',
  '/dashboard',
  '/account',
  '/settings',
  '/billing',
  '/profile',
  '/api',
  '/auth',
];

/** Score deduction per issue severity (a 100-point page starts losing points per issue). */
export const SEVERITY_WEIGHT: Record<SeoSeverity, number> = {
  critical: 30,
  serious: 15,
  moderate: 7,
  minor: 3,
};

const SEVERITY_RANK: Record<SeoSeverity, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };

/** Cap on how many broken links / per-criterion image issues a single page reports. */
const MAX_REPORTED_PER_PAGE = 10;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Render an unknown thrown value as a short string. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Join a base URL and a path, tolerating leading/trailing slashes. */
function joinUrl(baseUrl: string, path: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

/** Normalize a pathname for comparison: strip query/hash, collapse a trailing slash (except root). */
export function normalizePath(path: string): string {
  let p = (path ?? '').trim();
  const q = p.search(/[?#]/);
  if (q >= 0) p = p.slice(0, q);
  if (p === '') p = '/';
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

/** Tally per-severity counts over a set of issues. */
export function countSeverities(issues: readonly SeoIssue[]): SeoSeverityCounts {
  const counts: SeoSeverityCounts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const i of issues) counts[i.severity]++;
  return counts;
}

/** Add two severity-count maps. */
function addCounts(a: SeoSeverityCounts, b: SeoSeverityCounts): SeoSeverityCounts {
  return {
    critical: a.critical + b.critical,
    serious: a.serious + b.serious,
    moderate: a.moderate + b.moderate,
    minor: a.minor + b.minor,
  };
}

/** Compute a 0–100 score from a set of issues (100 minus severity-weighted deductions, floored at 0). */
export function scoreFromIssues(issues: readonly SeoIssue[]): number {
  let score = 100;
  for (const i of issues) score -= SEVERITY_WEIGHT[i.severity];
  return Math.max(0, Math.round(score));
}

/** Sort issues most-severe-first, then by check for a stable report. */
function sortIssues(issues: SeoIssue[]): SeoIssue[] {
  return [...issues].sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    return a.check < b.check ? -1 : a.check > b.check ? 1 : 0;
  });
}

/** Classify a route as a private/app area (should be `noindex`) vs a public/indexable page. */
export function inferPageType(path: string): 'public' | 'private' {
  const p = normalizePath(path).toLowerCase();
  return PRIVATE_PATH_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`)) ? 'private' : 'public';
}

// ---------------------------------------------------------------------------
// Per-page checks (PURE — each returns the issues for one check)
// ---------------------------------------------------------------------------

/** `title` (the per-page part — duplicate detection is site-wide in {@link analyzeSeo}). */
export function evaluateTitle(data: RawSeoData): SeoIssue[] {
  const title = (data.title ?? '').trim();
  if (title === '') {
    return [{ check: 'title', severity: 'critical', message: 'page has no <title> tag (or it is empty)' }];
  }
  const issues: SeoIssue[] = [];
  if (title.length > 60) {
    issues.push({
      check: 'title',
      severity: 'minor',
      message: `title is ${title.length} chars (>60) — likely truncated in search results`,
    });
  }
  return issues;
}

/** `meta_description` — present and under `maxLen` chars. */
export function evaluateMetaDescription(data: RawSeoData, maxLen = DEFAULT_MAX_META_DESCRIPTION): SeoIssue[] {
  const md = data.metaDescription;
  if (md === null || md.trim() === '') {
    return [{ check: 'meta_description', severity: 'serious', message: 'missing meta description' }];
  }
  if (md.length >= maxLen) {
    return [
      {
        check: 'meta_description',
        severity: 'serious',
        message: `meta description is ${md.length} chars — must be under ${maxLen}`,
      },
    ];
  }
  return [];
}

/** `canonical` — a canonical URL must be set. */
export function evaluateCanonical(data: RawSeoData): SeoIssue[] {
  if (data.canonical === null || data.canonical.trim() === '') {
    return [{ check: 'canonical', severity: 'serious', message: 'missing <link rel="canonical">' }];
  }
  return [];
}

/** `open_graph` — required OG tags present; recommended ones noted. */
export function evaluateOpenGraph(data: RawSeoData): SeoIssue[] {
  const present = new Set(
    Object.entries(data.ogTags)
      .filter(([, v]) => (v ?? '').trim() !== '')
      .map(([k]) => k.toLowerCase())
  );
  const issues: SeoIssue[] = [];
  const missingRequired = REQUIRED_OG_TAGS.filter((t) => !present.has(t));
  if (missingRequired.length > 0) {
    issues.push({
      check: 'open_graph',
      severity: 'moderate',
      message: `missing required Open Graph tag(s): ${missingRequired.join(', ')}`,
    });
  }
  const missingRecommended = RECOMMENDED_OG_TAGS.filter((t) => !present.has(t));
  if (missingRecommended.length > 0) {
    issues.push({
      check: 'open_graph',
      severity: 'minor',
      message: `missing recommended Open Graph tag(s): ${missingRecommended.join(', ')}`,
    });
  }
  return issues;
}

/** `structured_data` — JSON-LD present and valid (parses, has `@context`/`@type`). */
export function evaluateJsonLd(data: RawSeoData): SeoIssue[] {
  const blocks = data.jsonLd.filter((b) => (b ?? '').trim() !== '');
  if (blocks.length === 0) {
    return [
      {
        check: 'structured_data',
        severity: 'moderate',
        message: 'no JSON-LD structured data (<script type="application/ld+json">) found',
      },
    ];
  }
  const issues: SeoIssue[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const raw = blocks[i] ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      issues.push({
        check: 'structured_data',
        severity: 'critical',
        message: `JSON-LD block #${i + 1} is invalid JSON (${describe(error)})`,
      });
      continue;
    }
    // A block may be a single object or an array / @graph of objects.
    const nodes = collectJsonLdNodes(parsed);
    const missing = nodes.some((n) => !hasOwn(n, '@type'));
    const noContext = nodes.length > 0 && !nodes.some((n) => hasOwn(n, '@context')) && !hasOwn(asObject(parsed), '@context');
    if (nodes.length === 0) {
      issues.push({
        check: 'structured_data',
        severity: 'serious',
        message: `JSON-LD block #${i + 1} parsed but declares no schema object`,
      });
    } else if (missing) {
      issues.push({
        check: 'structured_data',
        severity: 'serious',
        message: `JSON-LD block #${i + 1} is missing an @type on one or more nodes`,
      });
    } else if (noContext) {
      issues.push({
        check: 'structured_data',
        severity: 'moderate',
        message: `JSON-LD block #${i + 1} is missing an @context`,
      });
    }
  }
  return issues;
}

/** Narrow an unknown JSON value to a plain object (else an empty object). */
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Whether a record owns a key (guarded). */
function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Flatten a parsed JSON-LD value into the schema nodes it declares (handles array + `@graph`). */
function collectJsonLdNodes(parsed: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const obj = asObject(v);
    if (Object.keys(obj).length === 0) return;
    const graph = obj['@graph'];
    if (Array.isArray(graph)) {
      for (const item of graph) visit(item);
      // a wrapper with only @context + @graph is not itself a node
      if (!hasOwn(obj, '@type')) return;
    }
    out.push(obj);
  };
  visit(parsed);
  return out;
}

/** `robots` — the meta robots directive should match the route's page type. */
export function evaluateRobots(data: RawSeoData, path: string): SeoIssue[] {
  const robots = (data.robots ?? '').toLowerCase();
  const noindex = /\bnoindex\b/.test(robots);
  const type = inferPageType(path);
  if (type === 'public' && noindex) {
    return [
      {
        check: 'robots',
        severity: 'serious',
        message: `public route is marked noindex ("${data.robots}") — it will be excluded from search`,
      },
    ];
  }
  if (type === 'private' && !noindex) {
    return [
      {
        check: 'robots',
        severity: 'moderate',
        message: 'private/app route is indexable — add a noindex robots meta tag',
      },
    ];
  }
  return [];
}

/** `heading_hierarchy` — exactly one H1, and no skipped heading levels. */
export function evaluateHeadings(data: RawSeoData): SeoIssue[] {
  const headings = data.headings.filter((h) => h.level >= 1 && h.level <= 6);
  const h1 = headings.filter((h) => h.level === 1).length;
  const issues: SeoIssue[] = [];
  if (h1 === 0) {
    issues.push({ check: 'heading_hierarchy', severity: 'critical', message: 'page has no <h1>' });
  } else if (h1 > 1) {
    issues.push({ check: 'heading_hierarchy', severity: 'critical', message: `page has ${h1} <h1> elements — there must be exactly one` });
  }
  // Detect a skipped level (e.g. h2 → h4 without an h3 between them).
  let prev = 0;
  for (const h of headings) {
    if (prev > 0 && h.level > prev + 1) {
      issues.push({
        check: 'heading_hierarchy',
        severity: 'moderate',
        message: `heading level skips from h${prev} to h${h.level} — keep the hierarchy contiguous`,
      });
      break; // one skip finding per page is enough signal
    }
    prev = h.level;
  }
  return issues;
}

/** Whether an image references a WebP (or other modern) format via `src` or `srcset`. */
export function isModernImageFormat(img: RawSeoImage): boolean {
  const hay = `${img.src} ${img.srcset}`.toLowerCase();
  if (/\.(webp|avif)(\?|#|\s|$)/.test(hay) || /\b(webp|avif)\b/.test(hay)) return true;
  // Next.js `/_next/image?url=…` optimization endpoint serves modern formats via content negotiation.
  if (hay.includes('/_next/image')) return true;
  // Data URIs / SVGs are not raster formats this check applies to.
  if (img.src.startsWith('data:') || /\.svg(\?|#|\s|$)/.test(hay)) return true;
  return false;
}

/** `image_optimization` — WebP format, lazy loading, explicit width/height (aggregated counts). */
export function evaluateImages(data: RawSeoData): SeoIssue[] {
  const imgs = data.images.filter((i) => (i.src ?? '').trim() !== '');
  if (imgs.length === 0) return [];
  const notModern = imgs.filter((i) => !isModernImageFormat(i)).length;
  const notLazy = imgs.filter((i) => (i.loading ?? '').toLowerCase() !== 'lazy').length;
  const noDims = imgs.filter((i) => !i.hasWidth || !i.hasHeight).length;
  const issues: SeoIssue[] = [];
  if (notModern > 0) {
    issues.push({
      check: 'image_optimization',
      severity: 'minor',
      message: `${notModern} of ${imgs.length} image(s) are not served as WebP/AVIF`,
    });
  }
  if (notLazy > 0) {
    issues.push({
      check: 'image_optimization',
      severity: 'minor',
      message: `${notLazy} of ${imgs.length} image(s) lack loading="lazy"`,
    });
  }
  if (noDims > 0) {
    issues.push({
      check: 'image_optimization',
      severity: 'minor',
      message: `${noDims} of ${imgs.length} image(s) are missing explicit width/height attributes`,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Site-wide route matching (for orphan / broken-link analysis)
// ---------------------------------------------------------------------------

/** Build a predicate that matches a concrete pathname against a route spec (static or dynamic). */
export function routeMatcher(route: SeoRouteSpec): (path: string) => boolean {
  const segments = normalizePath(route.path).split('/');
  // Static route → exact normalized equality.
  if (!segments.some((s) => s.startsWith(':') || s.startsWith('*'))) {
    const exact = normalizePath(route.path);
    return (p) => normalizePath(p) === exact;
  }
  // Dynamic → translate `:seg` → one segment, `*seg` → the rest.
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.startsWith('*')) parts.push('.+');
    else if (seg.startsWith(':')) parts.push('[^/]+');
    else parts.push(seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  const re = new RegExp(`^${parts.join('/')}$`);
  return (p) => re.test(normalizePath(p));
}

/** Whether any route in the set matches the given concrete pathname. */
export function matchesAnyRoute(path: string, matchers: ReadonlyArray<(p: string) => boolean>): boolean {
  return matchers.some((m) => m(path));
}

/** A link target that points at a static asset (has a file extension we should not treat as a route). */
function looksLikeAsset(path: string): boolean {
  return /\.[a-z0-9]{1,5}$/i.test(normalizePath(path)) && !/\.html?$/i.test(normalizePath(path));
}

// ---------------------------------------------------------------------------
// Sitemap parsing
// ---------------------------------------------------------------------------

/** Extract every `<loc>` URL from a sitemap.xml body (regex — no XML dependency). */
export function parseSitemapLocs(xml: string): string[] {
  const locs: string[] = [];
  for (const m of (xml ?? '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    if (m[1]) locs.push(m[1].trim());
  }
  return locs;
}

// ---------------------------------------------------------------------------
// Core analysis (PURE — the testable heart of the validator)
// ---------------------------------------------------------------------------

/** A probed route + its raw observations (the input to {@link analyzeSeo}). */
export interface PageProbeResult {
  route: SeoRouteSpec;
  probe: SeoProbe;
}

/** Inputs to {@link analyzeSeo}. */
export interface SeoAnalysisInput {
  pages: PageProbeResult[];
  routes: SeoRouteSpec[];
  baseUrl: string;
  /** Raw `/sitemap.xml` fetch (null when not fetched, e.g. server down). */
  sitemap: FetchResult | null;
  /** Raw `/robots.txt` fetch (null when not fetched). */
  robots: FetchResult | null;
  /** Meta-description length ceiling. Default {@link DEFAULT_MAX_META_DESCRIPTION}. */
  maxMetaDescriptionLength?: number;
}

/** The product of {@link analyzeSeo} (everything except the rendered markdown report). */
export interface SeoAnalysis {
  pages: SeoPageResult[];
  siteIssues: SeoIssue[];
  duplicateTitles: DuplicateTitleGroup[];
  orphanPages: string[];
  brokenLinks: BrokenLink[];
  sitemap: SitemapResult;
  robots: RobotsTxtResult;
}

/**
 * Turn the per-route probes + the fetched sitemap/robots into per-page SEO results (with scores) and the
 * site-wide findings (duplicate titles, orphan pages, broken links, sitemap validity). PURE — no browser,
 * no network, no clock — so the whole judgement is unit-testable in isolation.
 */
export function analyzeSeo(input: SeoAnalysisInput): SeoAnalysis {
  const maxLen = input.maxMetaDescriptionLength ?? DEFAULT_MAX_META_DESCRIPTION;
  const matchers = input.routes.map(routeMatcher);

  // 1. Per-page base issues (the eight per-page checks).
  const base = new Map<SeoRouteSpec, { result: SeoPageResult; data: RawSeoData | null }>();
  for (const { route, probe } of input.pages) {
    const dynamic = route.dynamic ?? false;
    const url = joinUrl(input.baseUrl, concreteUrlPath(route.path));
    const result: SeoPageResult = {
      path: route.path,
      ...(route.name !== undefined ? { name: route.name } : {}),
      url,
      status: 'skipped',
      passed: false,
      httpStatus: probe.status,
      score: null,
      title: null,
      issues: [],
      counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
      dynamic,
      detail: '',
    };

    if (probe.error || !probe.ok || probe.data === null) {
      result.status = dynamic ? 'skipped' : 'error';
      result.detail = probe.error
        ? `could not validate (${probe.error})`
        : `page did not render (HTTP ${probe.status ?? 'none'}) — SEO audit skipped`;
      base.set(route, { result, data: null });
      continue;
    }

    const data = probe.data;
    result.title = (data.title ?? '').trim() || null;
    const issues: SeoIssue[] = [
      ...evaluateTitle(data),
      ...evaluateMetaDescription(data, maxLen),
      ...evaluateCanonical(data),
      ...evaluateOpenGraph(data),
      ...evaluateJsonLd(data),
      ...evaluateRobots(data, route.path),
      ...evaluateHeadings(data),
      ...evaluateImages(data),
    ];
    result.issues = issues;
    base.set(route, { result, data });
  }

  // 2. Site-wide: duplicate titles across the audited routes.
  const audited = [...base.values()].filter((b) => b.data !== null);
  const byTitle = new Map<string, string[]>();
  for (const b of audited) {
    const t = (b.result.title ?? '').trim();
    if (t === '') continue;
    const key = t.toLowerCase();
    const arr = byTitle.get(key) ?? [];
    arr.push(b.result.path);
    byTitle.set(key, arr);
  }
  const duplicateTitles: DuplicateTitleGroup[] = [];
  for (const [, paths] of byTitle) {
    if (paths.length > 1) {
      duplicateTitles.push({ title: titleForPaths(audited, paths), paths });
      // Attach a critical issue to every page sharing the duplicate title.
      for (const b of audited) {
        if (paths.includes(b.result.path)) {
          b.result.issues.push({
            check: 'title',
            severity: 'critical',
            message: `duplicate <title> shared with ${paths.filter((p) => p !== b.result.path).join(', ')}`,
          });
        }
      }
    }
  }

  // 3. Site-wide: internal-link graph → broken links + orphan pages.
  const incoming = new Set<string>();
  const brokenLinks: BrokenLink[] = [];
  for (const b of audited) {
    if (!b.data) continue;
    const seenBroken = new Set<string>();
    const pageBroken: BrokenLink[] = [];
    for (const rawLink of b.data.internalLinks) {
      const to = normalizePath(rawLink);
      incoming.add(to);
      if (looksLikeAsset(to)) continue;
      if (!matchesAnyRoute(to, matchers) && !seenBroken.has(to)) {
        seenBroken.add(to);
        pageBroken.push({ from: b.result.path, to });
      }
    }
    for (const bl of pageBroken.slice(0, MAX_REPORTED_PER_PAGE)) {
      brokenLinks.push(bl);
      b.result.issues.push({
        check: 'internal_links',
        severity: 'serious',
        message: `internal link to "${bl.to}" resolves to no known route (broken link)`,
      });
    }
  }

  // Orphan pages: a static, non-root audited route that NO page links to.
  const orphanPages: string[] = [];
  for (const b of audited) {
    const path = normalizePath(b.result.path);
    if (path === '/') continue;
    if (b.result.dynamic) continue; // dynamic routes can't be enumerated for incoming links
    const linked = [...incoming].some((to) => matchesAnyRoute(to, [routeMatcher(b.result)]) || normalizePath(to) === path);
    if (!linked) {
      orphanPages.push(b.result.path);
      b.result.issues.push({
        check: 'internal_links',
        severity: 'moderate',
        message: 'orphan page — no other page links to this route',
      });
    }
  }

  // 4. Site-wide: sitemap.xml + robots.txt.
  const staticRoutes = input.routes
    .filter((r) => !(r.dynamic ?? false))
    .map((r) => normalizePath(r.path));
  const sitemap = evaluateSitemap(input.sitemap, input.baseUrl, staticRoutes);
  const robots = evaluateRobots_txt(input.robots);

  const siteIssues: SeoIssue[] = [...sitemapIssues(sitemap), ...robotsIssues(robots)];

  // 5. Finalize each page: sort issues, tally counts, score, status, detail.
  const pages: SeoPageResult[] = [];
  for (const { route } of input.pages) {
    const b = base.get(route);
    if (!b) continue;
    const r = b.result;
    if (b.data === null) {
      pages.push(r); // error/skipped — already finalized
      continue;
    }
    r.issues = sortIssues(r.issues);
    r.counts = countSeverities(r.issues);
    r.score = scoreFromIssues(r.issues);
    if (r.issues.length === 0) {
      r.status = 'pass';
      r.passed = true;
      r.detail = `SEO clean — score ${r.score}/100 (HTTP ${r.httpStatus ?? 200})`;
    } else {
      r.status = 'fail';
      r.detail =
        `score ${r.score}/100 — ${r.issues.length} issue(s): ` +
        `${r.counts.critical} critical, ${r.counts.serious} serious, ${r.counts.moderate} moderate, ${r.counts.minor} minor`;
    }
    pages.push(r);
  }

  return { pages, siteIssues, duplicateTitles, orphanPages, brokenLinks, sitemap, robots };
}

/** Best original-cased title for a duplicate group. */
function titleForPaths(audited: Array<{ result: SeoPageResult }>, paths: string[]): string {
  const first = audited.find((b) => paths.includes(b.result.path));
  return first?.result.title ?? '';
}

/** Evaluate the fetched sitemap.xml. */
function evaluateSitemap(fetched: FetchResult | null, baseUrl: string, staticRoutes: string[]): SitemapResult {
  if (fetched === null) {
    return { found: false, valid: false, urlCount: 0, missingRoutes: [], detail: 'sitemap.xml not fetched (server unavailable)' };
  }
  if (!fetched.ok || fetched.body.trim() === '') {
    return {
      found: false,
      valid: false,
      urlCount: 0,
      missingRoutes: [],
      detail: `sitemap.xml not served (HTTP ${fetched.status ?? 'none'})`,
    };
  }
  const body = fetched.body;
  const wellFormed = /<urlset[\s>]/i.test(body) || /<sitemapindex[\s>]/i.test(body);
  const locs = parseSitemapLocs(body);
  if (!wellFormed || locs.length === 0) {
    return {
      found: true,
      valid: false,
      urlCount: locs.length,
      missingRoutes: [],
      detail: !wellFormed
        ? 'sitemap.xml is not a well-formed <urlset>/<sitemapindex>'
        : 'sitemap.xml contains no <loc> entries',
    };
  }
  // Which discovered static routes are absent from the sitemap?
  const locPaths = new Set(
    locs.map((u) => {
      try {
        return normalizePath(new URL(u, baseUrl).pathname);
      } catch {
        return normalizePath(u);
      }
    })
  );
  const missingRoutes = staticRoutes.filter((r) => !locPaths.has(r));
  return {
    found: true,
    valid: true,
    urlCount: locs.length,
    missingRoutes,
    detail:
      `valid sitemap with ${locs.length} URL(s)` +
      (missingRoutes.length > 0 ? `; ${missingRoutes.length} discovered route(s) absent` : ''),
  };
}

/** Site-wide issues derived from the sitemap evaluation. */
function sitemapIssues(sitemap: SitemapResult): SeoIssue[] {
  if (!sitemap.found) {
    return [{ check: 'sitemap', severity: 'serious', message: `no sitemap.xml served — ${sitemap.detail}` }];
  }
  if (!sitemap.valid) {
    return [{ check: 'sitemap', severity: 'serious', message: `invalid sitemap.xml — ${sitemap.detail}` }];
  }
  if (sitemap.missingRoutes.length > 0) {
    return [
      {
        check: 'sitemap',
        severity: 'moderate',
        message: `sitemap.xml is missing ${sitemap.missingRoutes.length} discovered route(s): ${sitemap.missingRoutes.slice(0, 10).join(', ')}`,
      },
    ];
  }
  return [];
}

/** Evaluate the fetched robots.txt. */
function evaluateRobots_txt(fetched: FetchResult | null): RobotsTxtResult {
  if (fetched === null) {
    return { found: false, declaresSitemap: false, detail: 'robots.txt not fetched (server unavailable)' };
  }
  if (!fetched.ok || fetched.body.trim() === '') {
    return { found: false, declaresSitemap: false, detail: `robots.txt not served (HTTP ${fetched.status ?? 'none'})` };
  }
  const declaresSitemap = /^\s*sitemap\s*:/im.test(fetched.body);
  return {
    found: true,
    declaresSitemap,
    detail: declaresSitemap ? 'robots.txt served and references a Sitemap' : 'robots.txt served (no Sitemap directive)',
  };
}

/** Site-wide issues derived from the robots.txt evaluation. */
function robotsIssues(robots: RobotsTxtResult): SeoIssue[] {
  if (!robots.found) {
    return [{ check: 'robots', severity: 'moderate', message: `no robots.txt served — ${robots.detail}` }];
  }
  if (!robots.declaresSitemap) {
    return [{ check: 'robots', severity: 'minor', message: 'robots.txt does not declare a Sitemap: directive' }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Route discovery (default) — reuse the codebase-reader route extractor
// ---------------------------------------------------------------------------

/** Map a `readCodebase` {@link RouteInfo} to an {@link SeoRouteSpec}. */
function routeInfoToSpec(r: RouteInfo): SeoRouteSpec {
  return { path: r.route, name: r.file, dynamic: r.dynamic };
}

/** Default route discovery: every `kind: 'page'` route in the app/pages directory, deduped by path. */
async function defaultDiscoverRoutes(projectPath: string): Promise<SeoRouteSpec[]> {
  let routes: RouteInfo[] = [];
  try {
    const snapshot = await readCodebase(projectPath);
    routes = snapshot.routes;
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const specs: SeoRouteSpec[] = [];
  for (const r of routes) {
    if (r.kind !== 'page') continue;
    if (seen.has(r.route)) continue;
    seen.add(r.route);
    specs.push(routeInfoToSpec(r));
  }
  specs.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  return specs;
}

// ---------------------------------------------------------------------------
// Default Playwright driver + built-in fetch
// ---------------------------------------------------------------------------

/**
 * Build the in-page extraction script (a STRING — kept as a string so the ES2022-only tsconfig `lib`
 * never sees a DOM global) that pulls the SEO-relevant data out of the loaded document.
 */
export function buildSeoExtractScript(): string {
  return `(() => {
    function arr(nodeList) { return Array.prototype.slice.call(nodeList); }
    var title = document.title || '';
    var mdEl = document.querySelector('meta[name="description"]');
    var canonicalEl = document.querySelector('link[rel="canonical"]');
    var robotsEl = document.querySelector('meta[name="robots"]');
    var og = {};
    arr(document.querySelectorAll('meta[property^="og:"]')).forEach(function (m) {
      var p = m.getAttribute('property');
      if (p) og[p.toLowerCase()] = m.getAttribute('content') || '';
    });
    var jsonLd = arr(document.querySelectorAll('script[type="application/ld+json"]')).map(function (s) {
      return s.textContent || '';
    });
    var headings = arr(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(function (h) {
      return { level: parseInt(h.tagName.substring(1), 10), text: (h.textContent || '').trim().slice(0, 120) };
    });
    var images = arr(document.querySelectorAll('img')).map(function (im) {
      return {
        src: im.getAttribute('src') || im.currentSrc || '',
        srcset: im.getAttribute('srcset') || '',
        loading: im.getAttribute('loading') || '',
        hasWidth: im.hasAttribute('width'),
        hasHeight: im.hasAttribute('height'),
      };
    });
    var origin = location.origin;
    var internalLinks = arr(document.querySelectorAll('a[href]'))
      .map(function (a) { return a.getAttribute('href') || ''; })
      .map(function (href) {
        try { var u = new URL(href, origin); return u.origin === origin ? (u.pathname + u.search) : ''; }
        catch (e) { return ''; }
      })
      .filter(function (p) { return p; });
    return {
      title: title,
      metaDescription: mdEl ? (mdEl.getAttribute('content') || '') : null,
      canonical: canonicalEl ? (canonicalEl.getAttribute('href') || '') : null,
      robots: robotsEl ? (robotsEl.getAttribute('content') || '') : null,
      ogTags: og,
      jsonLd: jsonLd,
      headings: headings,
      images: images,
      internalLinks: internalLinks,
    };
  })()`;
}

/**
 * Create the default Playwright driver. Lazily imports `playwright`; for each audit it opens a fresh
 * context, navigates, and runs {@link buildSeoExtractScript} in the page. Returns `null` (every route
 * then skips) when Playwright is unavailable or Chromium cannot launch — never throws.
 */
export async function createPlaywrightSeoDriver(options: {
  headless?: boolean;
  viewport?: { width: number; height: number };
  log?: (m: string) => void;
}): Promise<SeoDriver | null> {
  const log = options.log ?? (() => {});
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;

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

  const audit = async (req: SeoProbeRequest): Promise<SeoProbe> => {
    const result: SeoProbe = { ok: false, status: null, finalUrl: req.url, data: null, error: null };
    let context: import('playwright').BrowserContext | null = null;
    try {
      context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const resp = await page.goto(req.url, { waitUntil: 'load', timeout: req.navTimeoutMs });
      await page.waitForLoadState('networkidle', { timeout: Math.min(5_000, req.navTimeoutMs) }).catch(() => {});
      result.status = resp ? resp.status() : null;
      result.finalUrl = page.url();
      result.ok = resp ? resp.status() < 400 : false;
      if (result.ok) {
        const raw: unknown = await page.evaluate(buildSeoExtractScript());
        result.data = raw && typeof raw === 'object' ? (raw as RawSeoData) : null;
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

  return { audit, close };
}

/** Default {@link ResourceFetcher}: built-in `fetch` (Node 20+), guarded — never throws. */
async function defaultFetchResource(url: string): Promise<FetchResult> {
  const f = (globalThis as { fetch?: (input: string, init?: unknown) => Promise<unknown> }).fetch;
  if (typeof f !== 'function') {
    return { ok: false, status: null, body: '', contentType: null };
  }
  try {
    const res = (await f(url, { redirect: 'follow' })) as {
      ok: boolean;
      status: number;
      text: () => Promise<string>;
      headers: { get: (k: string) => string | null };
    };
    const body = await res.text();
    return { ok: res.ok, status: res.status, body, contentType: res.headers.get('content-type') };
  } catch {
    return { ok: false, status: null, body: '', contentType: null };
  }
}

// ---------------------------------------------------------------------------
// Default Build-Memory store (production_telemetry, guarded — Contract 4)
// ---------------------------------------------------------------------------

/**
 * Default {@link SeoResultStore}: persist the audit summary as a `production_telemetry` event
 * (`event_type: 'error'` when blocked, else `'usage'`; severity critical/warning/info). Guarded and
 * NON-FATAL — a stateless / unreachable Build Memory logs a warning and is ignored (Contract 4).
 */
async function defaultStoreResult(record: SeoStoredRecord, log: (m: string) => void): Promise<void> {
  const eventType: TelemetryEventType = record.blocked ? 'error' : 'usage';
  const severity: TelemetrySeverity = record.blocked ? 'critical' : record.totalIssues > 0 ? 'warning' : 'info';
  const eventData: JsonObject = {
    kind: 'seo_audit',
    blocked: record.blocked,
    baseUrl: record.baseUrl,
    siteScore: record.siteScore,
    totalIssues: record.totalIssues,
    auditedPages: record.auditedPages,
    skippedPages: record.skippedPages,
    counts: { ...record.counts },
    pages: record.pages.map((p) => ({ path: p.path, status: p.status, score: p.score, counts: { ...p.counts } })),
    generatedAt: record.generatedAt,
  };
  try {
    await BuildMemory.telemetry.createEvent({
      project_name: record.projectName,
      build_run_id: record.buildRunId,
      event_type: eventType,
      event_data: eventData,
      severity,
      captured_at: record.generatedAt,
    });
  } catch (error) {
    log(`WARNING: Build Memory store degraded (${describe(error)}) — result not persisted`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function statusIcon(s: SeoPageStatus): string {
  switch (s) {
    case 'pass':
      return '✅ PASS';
    case 'fail':
      return '❌ FAIL';
    case 'error':
      return '⚠️ ERROR';
    default:
      return '⊘ SKIP';
  }
}

const SEVERITY_ICON: Record<SeoSeverity, string> = {
  critical: '🔴',
  serious: '🟠',
  moderate: '🟡',
  minor: '⚪',
};

/** Render the full markdown report. */
function renderReport(result: Omit<SEOAuditResult, 'report'>): string {
  const c = result.counts;
  const lines: string[] = [];
  lines.push('# FORGE — SEO Audit');
  lines.push('');
  lines.push(`- **Target:** ${result.baseUrl}`);
  lines.push(
    `- **Overall:** ${
      !result.ran
        ? '⊘ NOT RUN'
        : result.blocked
          ? '❌ BLOCKED (critical issue)'
          : result.totalIssues > 0
            ? '⚠️ PASS WITH ISSUES'
            : '✅ CLEAN'
    }`
  );
  lines.push(`- **Site score:** ${result.siteScore === null ? 'n/a' : `${result.siteScore}/100`}`);
  lines.push(
    `- **Issues:** ${result.totalIssues} (🔴 ${c.critical} critical, 🟠 ${c.serious} serious, 🟡 ${c.moderate} moderate, ⚪ ${c.minor} minor)`
  );
  lines.push(`- **Routes:** ${result.auditedPages} audited, ${result.skippedPages} skipped/error`);
  lines.push(`- **Sitemap:** ${result.sitemap.detail}`);
  lines.push(`- **robots.txt:** ${result.robots.detail}`);
  if (result.duplicateTitles.length > 0) {
    lines.push(`- **Duplicate titles:** ${result.duplicateTitles.map((d) => `"${d.title}" (${d.paths.join(', ')})`).join('; ')}`);
  }
  if (result.orphanPages.length > 0) lines.push(`- **Orphan pages:** ${result.orphanPages.join(', ')}`);
  if (result.brokenLinks.length > 0) {
    lines.push(`- **Broken links:** ${result.brokenLinks.slice(0, 10).map((b) => `${b.from}→${b.to}`).join('; ')}`);
  }
  lines.push(`- **Generated:** ${result.generatedAt}`);
  lines.push('');

  if (result.pages.length > 0) {
    lines.push('| Route | Result | Score | 🔴 | 🟠 | 🟡 | ⚪ | Detail |');
    lines.push('|-------|--------|-------|----|----|----|----|--------|');
    for (const p of result.pages) {
      lines.push(
        `| ${p.path} | ${statusIcon(p.status)} | ${p.score === null ? '—' : p.score} | ${p.counts.critical} | ${p.counts.serious} | ${p.counts.moderate} | ${p.counts.minor} | ${p.detail.replace(/\|/g, '\\|')} |`
      );
    }
    lines.push('');
  }

  if (result.siteIssues.length > 0) {
    lines.push('## Site-wide issues');
    lines.push('');
    for (const i of result.siteIssues) {
      lines.push(`- ${SEVERITY_ICON[i.severity]} **${i.severity}** \`${i.check}\`: ${i.message.replace(/\|/g, '\\|')}`);
    }
    lines.push('');
  }

  if (result.failures.length > 0) {
    lines.push('## Issues by route');
    lines.push('');
    for (const p of result.failures) {
      lines.push(`### ${p.path} — score ${p.score ?? 0}/100`);
      lines.push('');
      for (const i of p.issues) {
        lines.push(`- ${SEVERITY_ICON[i.severity]} **${i.severity}** \`${i.check}\`: ${i.message.replace(/\|/g, '\\|')}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Audit every page route of the target app for SEO readiness, producing per-page scores and a site
 * rollup. CRITICAL issues block the build (`blocked`/`passed`). Boots the dev server when needed,
 * validates each route, fetches `sitemap.xml`/`robots.txt`, runs the site-wide analysis, stops the
 * server, and stores the summary in Build Memory. Always resolves — never throws, never fabricates a
 * pass; un-evaluable routes/runs SKIP with a note.
 */
export async function runSeoAudit(input: SeoAuditInput, options: SeoValidatorOptions = {}): Promise<SEOAuditResult> {
  const log = options.log ?? logLine('seo');
  const now = options.now ?? nowIso;
  const projectPath = input.projectPath;
  const projectName = input.projectName || basename(projectPath) || 'unknown';
  const buildRunId = input.buildRunId ?? null;
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const navTimeoutMs = input.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  const startupTimeoutMs = input.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxMetaDescriptionLength = input.maxMetaDescriptionLength ?? DEFAULT_MAX_META_DESCRIPTION;
  const startServer = input.startServer ?? true;
  const storeResult = options.storeResult ?? ((r: SeoStoredRecord) => defaultStoreResult(r, log));
  const fetchResource = options.fetchResource ?? defaultFetchResource;

  const emptySitemap: SitemapResult = { found: false, valid: false, urlCount: 0, missingRoutes: [], detail: 'not evaluated' };
  const emptyRobots: RobotsTxtResult = { found: false, declaresSitemap: false, detail: 'not evaluated' };

  const base = (): Omit<SEOAuditResult, 'report'> => ({
    passed: true,
    blocked: false,
    ran: false,
    devServerStarted: false,
    driverAvailable: true,
    failures: [],
    pages: [],
    siteIssues: [],
    counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    totalIssues: 0,
    siteScore: null,
    auditedPages: 0,
    skippedPages: 0,
    duplicateTitles: [],
    orphanPages: [],
    brokenLinks: [],
    sitemap: emptySitemap,
    robots: emptyRobots,
    baseUrl,
    generatedAt: now(),
  });

  const done = (partial: Omit<SEOAuditResult, 'report'>): SEOAuditResult => ({ ...partial, report: renderReport(partial) });

  // Trigger guard: when changedFiles is supplied, only run if a UI file (.tsx/.css) changed.
  if (input.changedFiles !== undefined && !hasUiFileChanges(input.changedFiles)) {
    log('no UI files (.tsx/.css) changed — SEO audit not triggered');
    return done(base());
  }

  // 1. Discover routes.
  const discover = options.discoverRoutes ?? defaultDiscoverRoutes;
  let routes: SeoRouteSpec[];
  try {
    routes = input.routes ?? (await discover(projectPath));
  } catch (error) {
    log(`WARNING: route discovery failed (${describe(error)})`);
    routes = [];
  }
  if (routes.length === 0) {
    log('no page routes discovered in the app directory — nothing to audit');
    return done(base());
  }
  log(`discovered ${routes.length} page route(s) to audit for SEO`);

  // 2. Start the dev server (unless the caller says the app is already running).
  let serverHandle: DevServerStart['handle'] = null;
  let devServerStarted = false;
  if (startServer) {
    const startDevServer = options.startDevServer ?? defaultStartDevServer;
    let start: DevServerStart;
    try {
      start = await startDevServer({
        projectPath,
        command: input.devCommand ?? DEFAULT_DEV_COMMAND,
        args: [...(input.devArgs ?? DEFAULT_DEV_ARGS)],
        baseUrl,
        startupTimeoutMs,
        pollIntervalMs,
        log,
      });
    } catch (error) {
      log(`WARNING: dev server start threw (${describe(error)})`);
      start = { ready: false, handle: null, detail: describe(error) };
    }
    serverHandle = start.handle;
    devServerStarted = start.ready;
    if (!start.ready) {
      if (start.handle) await start.handle.stop().catch(() => {});
      const pages = routes.map((r) => skippedPage(r, baseUrl, `dev server not ready — ${start.detail}`));
      log(`dev server not ready (${start.detail}) — all ${pages.length} route(s) skipped`);
      return done({ ...base(), pages, skippedPages: pages.length, devServerStarted: false });
    }
  } else {
    devServerStarted = true; // assumed running by the caller
    log(`assuming app already running at ${baseUrl} (startServer:false)`);
  }

  // 3. Acquire a browser driver. Null ⇒ every route skips (after stopping the server).
  let driver: SeoDriver | null = options.driver ?? null;
  let ownsDriver = false;
  if (!driver) {
    const create = options.createDriver ?? ((o) => createPlaywrightSeoDriver(o));
    try {
      driver = await create({ headless: options.headless ?? true, viewport: options.viewport ?? DEFAULT_VIEWPORT, log });
    } catch (error) {
      log(`WARNING: driver creation failed (${describe(error)})`);
      driver = null;
    }
    ownsDriver = driver !== null;
  }

  if (!driver) {
    if (serverHandle) await serverHandle.stop().catch(() => {});
    const pages = routes.map((r) => skippedPage(r, baseUrl, 'browser unavailable (Playwright not installed / failed to launch)'));
    log('browser unavailable — all route(s) skipped');
    return done({ ...base(), driverAvailable: false, devServerStarted, pages, skippedPages: pages.length });
  }

  // 4. Probe every route + fetch sitemap/robots, then ALWAYS stop the server + browser.
  const probes: PageProbeResult[] = [];
  let sitemap: FetchResult | null = null;
  let robots: FetchResult | null = null;
  try {
    for (const route of routes) {
      const url = joinUrl(baseUrl, concreteUrlPath(route.path));
      const probe = await driver.audit({ url, navTimeoutMs });
      probes.push({ route, probe });
    }
    sitemap = await fetchResource(joinUrl(baseUrl, 'sitemap.xml')).catch(() => null);
    robots = await fetchResource(joinUrl(baseUrl, 'robots.txt')).catch(() => null);
  } finally {
    if (ownsDriver) await driver.close().catch(() => {});
    if (serverHandle) await serverHandle.stop().catch(() => {});
  }

  // 5. Analyze (pure).
  const analysis = analyzeSeo({ pages: probes, routes, baseUrl, sitemap, robots, maxMetaDescriptionLength });

  // 6. Roll up.
  const pages = analysis.pages;
  const audited = pages.filter((p) => p.status === 'pass' || p.status === 'fail');
  const failures = pages.filter((p) => p.status === 'fail');
  const skippedPages = pages.filter((p) => p.status === 'skipped' || p.status === 'error').length;
  const pageCounts = pages.reduce<SeoSeverityCounts>((acc, p) => addCounts(acc, p.counts), {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
  });
  const counts = addCounts(pageCounts, countSeverities(analysis.siteIssues));
  const totalIssues = counts.critical + counts.serious + counts.moderate + counts.minor;
  const blocked = counts.critical > 0;
  const siteScore =
    audited.length > 0
      ? Math.round(audited.reduce((sum, p) => sum + (p.score ?? 0), 0) / audited.length)
      : null;

  const partial: Omit<SEOAuditResult, 'report'> = {
    ...base(),
    passed: !blocked,
    blocked,
    ran: true,
    devServerStarted,
    failures,
    pages,
    siteIssues: analysis.siteIssues,
    counts,
    totalIssues,
    siteScore,
    auditedPages: audited.length,
    skippedPages,
    duplicateTitles: analysis.duplicateTitles,
    orphanPages: analysis.orphanPages,
    brokenLinks: analysis.brokenLinks,
    sitemap: analysis.sitemap,
    robots: analysis.robots,
  };

  // 7. Store the summary in Build Memory (guarded; only when something was actually audited).
  if (audited.length > 0) {
    await storeResult({
      projectName,
      buildRunId,
      blocked,
      counts,
      totalIssues,
      siteScore,
      auditedPages: audited.length,
      skippedPages,
      baseUrl,
      generatedAt: partial.generatedAt,
      pages: pages.map((p) => ({ path: p.path, status: p.status, score: p.score, counts: p.counts })),
    });
  }

  log(
    blocked
      ? `seo: BLOCKED ❌ — ${counts.critical} critical issue(s) across ${audited.length} route(s) (site score ${siteScore ?? 'n/a'})`
      : `seo: ${totalIssues > 0 ? '⚠️ PASS WITH ISSUES' : 'PASS ✅'} — ${totalIssues} issue(s), site score ${siteScore ?? 'n/a'}, ${audited.length} audited, ${skippedPages} skipped`
  );
  return done(partial);
}

/** Build a `skipped` page result with a note (shared by the unreachable-server / no-driver paths). */
function skippedPage(route: SeoRouteSpec, baseUrl: string, detail: string): SeoPageResult {
  return {
    path: route.path,
    ...(route.name !== undefined ? { name: route.name } : {}),
    url: joinUrl(baseUrl, concreteUrlPath(route.path)),
    status: 'skipped',
    passed: false,
    httpStatus: null,
    score: null,
    title: null,
    issues: [],
    counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    dynamic: route.dynamic ?? false,
    detail,
  };
}

export default runSeoAudit;
