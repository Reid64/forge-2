/**
 * FORGE 2.0 — Accessibility Auditor (`src/tools/accessibility-auditor.ts`).
 *
 * After any Phase 3 prompt that MODIFIES UI files (`.tsx`/`.css` — see {@link hasUiFileChanges}),
 * drive Playwright to load EVERY page route of the built target app and run **axe-core** in the page
 * to audit it for WCAG 2.1 AA compliance. Where the Live Preview Gate proves a route *renders* and
 * Visual Regression proves it *still looks the same*, this proves the rendered page is *usable by
 * everyone* — the accessibility counterpart that a `tsc`/`build`/screenshot pass cannot give.
 *
 * WHAT IT CHECKS (the task contract — each maps to one or more axe rules, plus one synthetic check):
 *   - missing alt text on images          → `image-alt` / `input-image-alt` / `area-alt` / `role-img-alt`
 *   - insufficient colour contrast ratios  → `color-contrast` (and `color-contrast-enhanced`)
 *   - missing form labels                  → `label` / `select-name` / `form-field-multiple-labels`
 *   - missing ARIA on interactive elements → `button-name` / `link-name` / `aria-required-attr` /
 *                                            `aria-allowed-attr` / `aria-valid-attr[-value]` / `aria-*-name`
 *   - keyboard navigation traps            → axe `focus-order-semantics`/`tabindex`/`scrollable-region-
 *                                            focusable` PLUS a SYNTHETIC positive-`tabindex` scan (axe
 *                                            cannot fully automate trap detection — see the note below)
 *   - missing skip navigation links        → `bypass` / `skip-link` / `region` / `landmark-one-main`
 *   - improper heading hierarchy           → `heading-order` / `empty-heading` / `page-has-heading-one`
 *   - missing `lang` attribute             → `html-has-lang` / `html-lang-valid` / `valid-lang`
 *
 * KEYBOARD-TRAP NOTE: a true keyboard trap can only be proven by actually tabbing through the page,
 * which axe (a static-DOM auditor) does not do. We surface axe's focus-order signals AND add one
 * deterministic heuristic — any element with a POSITIVE `tabindex` (a well-known anti-pattern that
 * overrides the natural focus order and is a common source of traps) is reported as a `serious`
 * keyboard finding. This is documented as a heuristic, never claimed as exhaustive (Iron Law 3).
 *
 * OUTPUT: an {@link AccessibilityReport} `{ passed, blocked, pages: PageAccessibilityResult[], counts, … }`.
 * Violations are grouped by SEVERITY (axe `impact`: critical / serious / moderate / minor) per page and
 * in a build-wide rollup. **CRITICAL violations BLOCK the build** (`blocked = critical > 0`,
 * `passed = !blocked`) — serious/moderate/minor are surfaced but non-blocking, mirroring the Security
 * Scanner. Results are stored in Build Memory (`production_telemetry`, guarded — Contract 4).
 *
 * HOUSE STYLE (matches `live-preview-gate`, `visual-regression`, `security-scanner`, `phase4-sentinel`):
 * NON-FATAL and never throws, never fabricates a pass. A precondition that cannot be evaluated — the dev
 * server never boots, Playwright or axe-core is unavailable, a route won't load — is reported as
 * `skipped`/`error` on that route (or the whole run) with a note, NEVER a false pass and NEVER a false
 * fail. Every external collaborator (the dev-server starter, the browser+axe driver, route discovery,
 * and the Build-Memory writer) is injectable, so the auditor unit-tests with no `pnpm`, no browser, no
 * axe-core, and no database.
 *
 * BOUNDARY (Iron Law 1): writes nothing to the target's filesystem — it runs the app and reads its
 * rendered pages, then writes ONLY a summary row to Build Memory. Never reads source, governance, or
 * secrets. ZERO new RUNTIME npm dependency beyond `axe-core` (lazily imported; absent ⇒ SKIP).
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
// Public contract — severities, categories, violations
// ---------------------------------------------------------------------------

/** Violation severity — axe-core's `impact` scale. `critical` blocks the build. */
export type A11ySeverity = 'critical' | 'serious' | 'moderate' | 'minor';

/** Count of violations at each severity. */
export interface SeverityCounts {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
}

/** A single offending DOM node for a violation (axe `nodes[]`, trimmed). */
export interface A11yViolationNode {
  /** CSS selector path(s) to the element. */
  target: string[];
  /** The element's outer HTML (clipped). */
  html: string;
  /** axe's human-readable summary of why this node failed. */
  failureSummary: string;
}

/** One accessibility violation on one page (an axe rule, or the synthetic keyboard check). */
export interface A11yViolation {
  /** axe rule id (e.g. `image-alt`, `color-contrast`) or `keyboard-trap-tabindex`. */
  rule: string;
  /** Human grouping for the task's eight required checks (e.g. `missing alt text`). */
  category: string;
  /** Mapped severity (axe `impact`). */
  severity: A11ySeverity;
  /** axe `description` (what the rule checks). */
  description: string;
  /** axe `help` (how to fix). */
  help: string;
  /** axe `helpUrl` (deep-dive link), or empty. */
  helpUrl: string;
  /** WCAG / best-practice tags from axe (e.g. `wcag2aa`, `wcag111`). */
  wcagTags: string[];
  /** Offending nodes (capped for the report). */
  nodes: A11yViolationNode[];
}

// ---------------------------------------------------------------------------
// Public contract — input
// ---------------------------------------------------------------------------

/** A single route to audit. */
export interface A11yRouteSpec {
  /** Route path with dynamic segments as `:seg`/`*seg` (joined onto `baseUrl`). */
  path: string;
  /** Friendly name (for the report). */
  name?: string;
  /** Whether the route carries a dynamic/catch-all segment (audited best-effort, never hard-fails). */
  dynamic?: boolean;
}

/** What to audit — the project to boot + the routes to visit. */
export interface AccessibilityAuditInput {
  /** Target project root. The dev server runs here. */
  projectPath: string;
  /** Project name for the Build-Memory record. Default: basename of `projectPath`. */
  projectName?: string;
  /** Optional `build_runs.id` to associate the stored result with. */
  buildRunId?: string;
  /**
   * Routes to audit. When omitted, they are DISCOVERED from the app directory via `readCodebase`
   * (`kind: 'page'` routes). An empty discovery → the run is a no-op (`pages: []`, passed).
   */
  routes?: A11yRouteSpec[];
  /** Running app base URL. Default `http://localhost:3000`. */
  baseUrl?: string;
  /**
   * Whether to boot the dev server (`pnpm dev`) before auditing. Default true. Set false when the app
   * is already running at `baseUrl` (e.g. a prior Sentinel check already booted it).
   */
  startServer?: boolean;
  /** Dev-server command. Default `pnpm` (BLUEPRINT TECH STACK — never npm/yarn). */
  devCommand?: string;
  /** Dev-server args. Default `['dev']`. */
  devArgs?: string[];
  /**
   * WCAG tag set passed to `axe.run({ runOnly: { type: 'tag', values } })`. Default the WCAG 2.1 AA
   * set: `['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']`.
   */
  wcagTags?: string[];
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
// Public contract — results
// ---------------------------------------------------------------------------

/** Per-route outcome. */
export type PageA11yStatus =
  | 'pass' //     audited, zero violations
  | 'fail' //     audited, ≥1 violation (build-blocking only when a critical is present)
  | 'error' //    could not navigate/audit at all — neither pass nor fail (un-evaluable)
  | 'skipped'; // not evaluated (dynamic route best-effort, server/browser/axe unavailable)

/** The audit result for one route. */
export interface PageAccessibilityResult {
  path: string;
  name?: string;
  /** Full URL audited (with any synthetic dynamic-segment substitution). */
  url: string;
  status: PageA11yStatus;
  /** True only for `pass`. */
  passed: boolean;
  /** HTTP status of the navigation, or null when no response was received. */
  httpStatus: number | null;
  /** Violations found on this page, sorted most-severe-first. */
  violations: A11yViolation[];
  /** Per-severity counts for this page. */
  counts: SeverityCounts;
  /** Whether this route carries a dynamic/catch-all segment (audited best-effort). */
  dynamic: boolean;
  /** One-line human-readable detail. */
  detail: string;
}

/** The full accessibility report (the auditor's output contract). */
export interface AccessibilityReport {
  /** False iff at least one CRITICAL violation exists (i.e. `!blocked`). */
  passed: boolean;
  /** True iff ≥1 CRITICAL violation — the build is blocked (the task contract). */
  blocked: boolean;
  /** Whether the audit actually evaluated routes (false ⇒ no UI change / server down / no routes). */
  ran: boolean;
  /** Whether the dev server became ready (or was assumed running when `startServer:false`). */
  devServerStarted: boolean;
  /** Whether a browser+axe driver was available at all (false ⇒ every route skipped). */
  driverAvailable: boolean;
  /** Routes with ≥1 violation (subset of `pages`). */
  failures: PageAccessibilityResult[];
  pages: PageAccessibilityResult[];
  /** Build-wide severity rollup across every audited page. */
  counts: SeverityCounts;
  /** Total violations across all pages. */
  totalViolations: number;
  /** Count of routes actually audited (status pass|fail). */
  auditedPages: number;
  /** Count of routes not evaluated (skipped/error). */
  skippedPages: number;
  /** The WCAG tag set used. */
  wcagTags: string[];
  baseUrl: string;
  /** Full markdown report. */
  report: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Public contract — injectable collaborators
// ---------------------------------------------------------------------------

/** A request to load one URL and run axe against it. */
export interface A11yProbeRequest {
  url: string;
  navTimeoutMs: number;
  wcagTags: string[];
}

/** The raw axe-core violation shape (the subset we consume). */
export interface RawAxeViolation {
  id: string;
  impact: string | null;
  description: string;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: Array<{ target: string[]; html: string; failureSummary: string }>;
}

/** The observations from auditing one page. */
export interface A11yProbe {
  /** True when the page navigated to a non-error (<400) status. */
  ok: boolean;
  /** HTTP status of the navigation, or null. */
  status: number | null;
  /** URL after redirects. */
  finalUrl: string;
  /** axe-core violations (empty when clean). */
  violations: RawAxeViolation[];
  /** Set when the navigation/audit itself failed (unreachable, timeout, axe injection failed, …). */
  error: string | null;
}

/** A browser+axe driver the auditor uses. The default is Playwright/Chromium + axe-core; tests inject a fake. */
export interface A11yDriver {
  audit(req: A11yProbeRequest): Promise<A11yProbe>;
  close(): Promise<void>;
}

/** A guarded Build-Memory writer for the audit summary (injectable for tests). */
export type A11yResultStore = (record: A11yStoredRecord) => Promise<void>;

/** The summary persisted to Build Memory. */
export interface A11yStoredRecord {
  projectName: string;
  buildRunId: string | null;
  blocked: boolean;
  counts: SeverityCounts;
  totalViolations: number;
  auditedPages: number;
  skippedPages: number;
  baseUrl: string;
  generatedAt: string;
  /** Per-page violation counts (for the event payload). */
  pages: Array<{ path: string; status: PageA11yStatus; counts: SeverityCounts }>;
}

/** Options — injectable collaborators + tuning (none required). */
export interface AccessibilityAuditorOptions {
  /** Override route discovery (tests). Default: `readCodebase(projectPath)` page routes. */
  discoverRoutes?: (projectPath: string) => Promise<A11yRouteSpec[]>;
  /** Inject a ready browser+axe driver. Default: a lazily-created Playwright + axe-core driver. */
  driver?: A11yDriver;
  /** Override how the default driver is created (tests). Returns null when unavailable. */
  createDriver?: (opts: {
    headless: boolean;
    viewport: { width: number; height: number };
    log: (m: string) => void;
  }) => Promise<A11yDriver | null>;
  /** Override the dev-server starter (tests). Default: {@link defaultStartDevServer}. */
  startDevServer?: DevServerStarter;
  /** Override the Build-Memory writer (tests). Default: a guarded `production_telemetry` insert. */
  storeResult?: A11yResultStore;
  /** Run the browser headless. Default true. */
  headless?: boolean;
  /** Deterministic viewport for the audit. Default 1280×800. */
  viewport?: { width: number; height: number };
  /** Override the timestamp source (tests). Default: `nowIso`. */
  now?: () => string;
  /** Progress reporter. Default logs with a `[FORGE:a11y]` prefix. */
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
/** WCAG 2.1 AA tag set (axe `runOnly` values). */
export const WCAG_21_AA_TAGS: readonly string[] = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
/** Cap on nodes rendered per violation (keeps the report bounded). */
const MAX_NODES_PER_VIOLATION = 5;
/** Cap on a node's HTML snippet. */
const MAX_HTML_CHARS = 200;
/** The synthetic positive-`tabindex` keyboard finding's rule id. */
export const KEYBOARD_TABINDEX_RULE = 'keyboard-trap-tabindex';

const SEVERITY_RANK: Record<A11ySeverity, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };

/**
 * Map an axe rule id (and our synthetic rule) to one of the task's eight required check categories.
 * A rule not in the table falls back to a generic `other (WCAG 2.1 AA)` bucket — it is still reported.
 */
export const RULE_CATEGORY: Readonly<Record<string, string>> = {
  // missing alt text on images
  'image-alt': 'missing alt text',
  'input-image-alt': 'missing alt text',
  'area-alt': 'missing alt text',
  'role-img-alt': 'missing alt text',
  'image-redundant-alt': 'missing alt text',
  // insufficient colour contrast
  'color-contrast': 'insufficient colour contrast',
  'color-contrast-enhanced': 'insufficient colour contrast',
  'link-in-text-block': 'insufficient colour contrast',
  // missing form labels
  label: 'missing form label',
  'label-title-only': 'missing form label',
  'form-field-multiple-labels': 'missing form label',
  'select-name': 'missing form label',
  'aria-input-field-name': 'missing form label',
  // missing/invalid ARIA on interactive elements
  'button-name': 'missing ARIA on interactive element',
  'link-name': 'missing ARIA on interactive element',
  'aria-required-attr': 'missing ARIA on interactive element',
  'aria-allowed-attr': 'missing ARIA on interactive element',
  'aria-required-children': 'missing ARIA on interactive element',
  'aria-required-parent': 'missing ARIA on interactive element',
  'aria-roles': 'missing ARIA on interactive element',
  'aria-valid-attr': 'missing ARIA on interactive element',
  'aria-valid-attr-value': 'missing ARIA on interactive element',
  'aria-command-name': 'missing ARIA on interactive element',
  'aria-toggle-field-name': 'missing ARIA on interactive element',
  'aria-tooltip-name': 'missing ARIA on interactive element',
  'aria-meter-name': 'missing ARIA on interactive element',
  'aria-progressbar-name': 'missing ARIA on interactive element',
  // keyboard navigation traps / focus
  'focus-order-semantics': 'keyboard navigation / focus trap',
  tabindex: 'keyboard navigation / focus trap',
  'scrollable-region-focusable': 'keyboard navigation / focus trap',
  [KEYBOARD_TABINDEX_RULE]: 'keyboard navigation / focus trap',
  // missing skip navigation / landmarks
  bypass: 'missing skip navigation link',
  'skip-link': 'missing skip navigation link',
  region: 'missing skip navigation link',
  'landmark-one-main': 'missing skip navigation link',
  'landmark-unique': 'missing skip navigation link',
  // improper heading hierarchy
  'heading-order': 'improper heading hierarchy',
  'empty-heading': 'improper heading hierarchy',
  'page-has-heading-one': 'improper heading hierarchy',
  // missing/invalid lang attribute
  'html-has-lang': 'missing lang attribute',
  'html-lang-valid': 'missing lang attribute',
  'html-xml-lang-mismatch': 'missing lang attribute',
  'valid-lang': 'missing lang attribute',
};

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

/** Clip a string to `max` chars, appending an ellipsis when truncated. */
function clip(text: string, max: number): string {
  const t = (text ?? '').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** Map an axe `impact` (possibly null) to our severity scale (null ⇒ moderate, the axe default). */
export function mapImpact(impact: string | null | undefined): A11ySeverity {
  switch ((impact ?? '').toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'serious':
      return 'serious';
    case 'minor':
      return 'minor';
    case 'moderate':
      return 'moderate';
    default:
      return 'moderate';
  }
}

/** Human category for a rule id (falls back to a generic bucket — never drops the finding). */
export function categoryForRule(rule: string): string {
  return RULE_CATEGORY[rule] ?? 'other (WCAG 2.1 AA)';
}

/** Convert a raw axe violation into our normalized {@link A11yViolation}. */
export function normalizeViolation(raw: RawAxeViolation): A11yViolation {
  const nodes = (raw.nodes ?? []).slice(0, MAX_NODES_PER_VIOLATION).map((n) => ({
    target: Array.isArray(n.target) ? n.target.map((t) => String(t)) : [],
    html: clip(String(n.html ?? ''), MAX_HTML_CHARS),
    failureSummary: clip(String(n.failureSummary ?? ''), 400),
  }));
  return {
    rule: raw.id,
    category: categoryForRule(raw.id),
    severity: mapImpact(raw.impact),
    description: raw.description ?? '',
    help: raw.help ?? '',
    helpUrl: raw.helpUrl ?? '',
    wcagTags: Array.isArray(raw.tags) ? raw.tags.filter((t) => /^wcag/i.test(t)) : [],
    nodes,
  };
}

/** Tally per-severity counts over a set of violations. */
export function countSeverities(violations: readonly A11yViolation[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of violations) counts[v.severity]++;
  return counts;
}

/** Add two severity-count maps. */
function addCounts(a: SeverityCounts, b: SeverityCounts): SeverityCounts {
  return {
    critical: a.critical + b.critical,
    serious: a.serious + b.serious,
    moderate: a.moderate + b.moderate,
    minor: a.minor + b.minor,
  };
}

/** Sort violations most-severe-first, then by rule for a stable report. */
function sortViolations(violations: A11yViolation[]): A11yViolation[] {
  return [...violations].sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Route discovery (default) — reuse the codebase-reader route extractor
// ---------------------------------------------------------------------------

/** Map a `readCodebase` {@link RouteInfo} to an {@link A11yRouteSpec}. */
function routeInfoToSpec(r: RouteInfo): A11yRouteSpec {
  return { path: r.route, name: r.file, dynamic: r.dynamic };
}

/** Default route discovery: every `kind: 'page'` route in the app/pages directory, deduped by path. */
async function defaultDiscoverRoutes(projectPath: string): Promise<A11yRouteSpec[]> {
  let routes: RouteInfo[] = [];
  try {
    const snapshot = await readCodebase(projectPath);
    routes = snapshot.routes;
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const specs: A11yRouteSpec[] = [];
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
// Default Playwright + axe-core driver
// ---------------------------------------------------------------------------

/** The shape of the lazily-imported axe-core module (we only need its bundled `source`). */
interface AxeModuleLike {
  source: string;
}

/**
 * Build the in-page script (a STRING — kept as a string so the ES2022-only tsconfig `lib` never sees
 * a DOM global) that runs axe against the loaded document for the given WCAG tags and returns the
 * trimmed violations plus the synthetic positive-`tabindex` keyboard finding.
 */
export function buildAxeRunScript(wcagTags: string[]): string {
  const tags = JSON.stringify(wcagTags);
  return `(async () => {
    const out = [];
    try {
      const res = await window.axe.run(document, {
        runOnly: { type: 'tag', values: ${tags} },
        resultTypes: ['violations'],
      });
      for (const v of (res.violations || [])) {
        out.push({
          id: v.id, impact: v.impact || null, description: v.description || '',
          help: v.help || '', helpUrl: v.helpUrl || '', tags: v.tags || [],
          nodes: (v.nodes || []).map(function (n) {
            return { target: n.target || [], html: n.html || '', failureSummary: n.failureSummary || '' };
          }),
        });
      }
    } catch (e) { /* surfaced by the caller as an empty audit + error */ throw e; }
    // Synthetic keyboard-trap heuristic: positive tabindex overrides natural focus order.
    try {
      const bad = Array.prototype.slice.call(document.querySelectorAll('[tabindex]')).filter(function (el) {
        var t = parseInt(el.getAttribute('tabindex') || '0', 10);
        return t > 0;
      });
      if (bad.length > 0) {
        out.push({
          id: '${KEYBOARD_TABINDEX_RULE}', impact: 'serious',
          description: 'Elements use a positive tabindex, which overrides the natural DOM focus order.',
          help: 'Remove positive tabindex values; use tabindex="0"/"-1" and source order so keyboard focus is predictable and cannot be trapped.',
          helpUrl: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/tabindex',
          tags: ['wcag2a', 'wcag211', 'keyboard'],
          nodes: bad.slice(0, ${MAX_NODES_PER_VIOLATION}).map(function (el) {
            return {
              target: [el.tagName ? el.tagName.toLowerCase() : 'element'],
              html: (el.outerHTML || '').slice(0, ${MAX_HTML_CHARS}),
              failureSummary: 'Positive tabindex (' + (el.getAttribute('tabindex') || '') + ') can create a keyboard navigation trap.',
            };
          }),
        });
      }
    } catch (e) { /* heuristic is best-effort; ignore */ }
    return out;
  })()`;
}

/**
 * Create the default Playwright + axe-core driver. Lazily imports BOTH `playwright` and `axe-core`;
 * for each audit it opens a fresh context, navigates, injects axe's bundled `source` into the page, and
 * runs {@link buildAxeRunScript}. Returns `null` (every route then skips) when EITHER dependency is
 * unavailable or Chromium cannot launch — never throws. Mirrors the Live Preview / Visual Regression
 * drivers (Locator/string-eval APIs only — the tsconfig `lib` is ES2022, no DOM globals in this file).
 */
export async function createPlaywrightAxeDriver(options: {
  headless?: boolean;
  viewport?: { width: number; height: number };
  log?: (m: string) => void;
}): Promise<A11yDriver | null> {
  const log = options.log ?? (() => {});
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;

  let pw: typeof import('playwright');
  try {
    pw = await import('playwright');
  } catch (error) {
    log(`Playwright unavailable (${describe(error)})`);
    return null;
  }

  // axe-core is an OPTIONAL dependency: imported via an indirect specifier so the project still
  // type-checks/builds when it is not yet installed (then this driver simply returns null → SKIP).
  let axeSource: string;
  try {
    const specifier = 'axe-core';
    const axeMod = (await import(specifier)) as AxeModuleLike & { default?: AxeModuleLike };
    axeSource = axeMod.source ?? axeMod.default?.source ?? '';
    if (axeSource === '') {
      log('axe-core imported but exposed no `source` — cannot inject; skipping');
      return null;
    }
  } catch (error) {
    log(`axe-core unavailable (${describe(error)}) — run \`pnpm add axe-core\` to enable accessibility audits`);
    return null;
  }

  let browser: import('playwright').Browser;
  try {
    browser = await pw.chromium.launch({ headless: options.headless ?? true });
  } catch (error) {
    log(`Chromium failed to launch (${describe(error)})`);
    return null;
  }

  const audit = async (req: A11yProbeRequest): Promise<A11yProbe> => {
    const result: A11yProbe = { ok: false, status: null, finalUrl: req.url, violations: [], error: null };
    let context: import('playwright').BrowserContext | null = null;
    try {
      context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const resp = await page.goto(req.url, { waitUntil: 'load', timeout: req.navTimeoutMs });
      await page.waitForLoadState('networkidle', { timeout: Math.min(5_000, req.navTimeoutMs) }).catch(() => {});
      result.status = resp ? resp.status() : null;
      result.finalUrl = page.url();
      result.ok = resp ? resp.status() < 400 : false;

      if (result.ok) {
        // Inject axe's bundled library, then run it. Both are string evals → no DOM globals in TS.
        await page.addScriptTag({ content: axeSource });
        const raw: unknown = await page.evaluate(buildAxeRunScript(req.wcagTags));
        result.violations = Array.isArray(raw) ? (raw as RawAxeViolation[]) : [];
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

// ---------------------------------------------------------------------------
// Per-route audit
// ---------------------------------------------------------------------------

/** Parameters threaded into {@link auditRoute}. */
interface AuditRouteDeps {
  driver: A11yDriver;
  baseUrl: string;
  navTimeoutMs: number;
  wcagTags: string[];
}

/** Audit one route and classify it. Never throws. */
async function auditRoute(route: A11yRouteSpec, deps: AuditRouteDeps): Promise<PageAccessibilityResult> {
  const dynamic = route.dynamic ?? false;
  const url = joinUrl(deps.baseUrl, concreteUrlPath(route.path));

  const result: PageAccessibilityResult = {
    path: route.path,
    ...(route.name !== undefined ? { name: route.name } : {}),
    url,
    status: 'skipped',
    passed: false,
    httpStatus: null,
    violations: [],
    counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    dynamic,
    detail: '',
  };

  const probe = await deps.driver.audit({ url, navTimeoutMs: deps.navTimeoutMs, wcagTags: deps.wcagTags });
  result.httpStatus = probe.status;

  // Navigation/audit failed entirely — could not evaluate. A dynamic route is a SKIP (the sample
  // param may simply not resolve); a static route is an `error` (un-evaluable).
  if (probe.error || !probe.ok) {
    result.status = dynamic ? 'skipped' : 'error';
    result.detail = probe.error
      ? `could not audit (${probe.error})`
      : `page did not render (HTTP ${probe.status ?? 'none'}) — audit skipped`;
    return result;
  }

  const violations = sortViolations(probe.violations.map(normalizeViolation));
  const counts = countSeverities(violations);
  result.violations = violations;
  result.counts = counts;

  if (violations.length === 0) {
    result.status = 'pass';
    result.passed = true;
    result.detail = `no WCAG 2.1 AA violations (HTTP ${probe.status ?? 200})`;
    return result;
  }

  result.status = 'fail';
  result.detail =
    `${violations.length} violation(s): ${counts.critical} critical, ${counts.serious} serious, ` +
    `${counts.moderate} moderate, ${counts.minor} minor`;
  return result;
}

// ---------------------------------------------------------------------------
// Default Build-Memory store (production_telemetry, guarded — Contract 4)
// ---------------------------------------------------------------------------

/**
 * Default {@link A11yResultStore}: persist the audit summary as a `production_telemetry` event
 * (`event_type: 'error'` when blocked, else `'usage'`; severity critical/warning/info). Guarded and
 * NON-FATAL — a stateless / unreachable Build Memory logs a warning and is ignored (Contract 4).
 */
async function defaultStoreResult(record: A11yStoredRecord, log: (m: string) => void): Promise<void> {
  const eventType: TelemetryEventType = record.blocked ? 'error' : 'usage';
  const severity: TelemetrySeverity = record.blocked
    ? 'critical'
    : record.totalViolations > 0
      ? 'warning'
      : 'info';
  const eventData: JsonObject = {
    kind: 'accessibility_audit',
    blocked: record.blocked,
    baseUrl: record.baseUrl,
    wcag: 'WCAG 2.1 AA',
    totalViolations: record.totalViolations,
    auditedPages: record.auditedPages,
    skippedPages: record.skippedPages,
    counts: { ...record.counts },
    pages: record.pages.map((p) => ({ path: p.path, status: p.status, counts: { ...p.counts } })),
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

function statusIcon(s: PageA11yStatus): string {
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

const SEVERITY_ICON: Record<A11ySeverity, string> = {
  critical: '🔴',
  serious: '🟠',
  moderate: '🟡',
  minor: '⚪',
};

/** Render the full markdown report. */
function renderReport(result: Omit<AccessibilityReport, 'report'>): string {
  const c = result.counts;
  const lines: string[] = [];
  lines.push('# FORGE — Accessibility Audit (WCAG 2.1 AA)');
  lines.push('');
  lines.push(`- **Target:** ${result.baseUrl}`);
  lines.push(
    `- **Overall:** ${
      !result.ran ? '⊘ NOT RUN' : result.blocked ? '❌ BLOCKED (critical violation)' : result.totalViolations > 0 ? '⚠️ PASS WITH VIOLATIONS' : '✅ CLEAN'
    }`
  );
  lines.push(
    `- **Violations:** ${result.totalViolations} (🔴 ${c.critical} critical, 🟠 ${c.serious} serious, 🟡 ${c.moderate} moderate, ⚪ ${c.minor} minor)`
  );
  lines.push(`- **Routes:** ${result.auditedPages} audited, ${result.skippedPages} skipped/error`);
  lines.push(`- **WCAG tags:** ${result.wcagTags.join(', ')}`);
  lines.push(`- **Generated:** ${result.generatedAt}`);
  lines.push('');

  if (result.pages.length > 0) {
    lines.push('| Route | Result | 🔴 | 🟠 | 🟡 | ⚪ | Detail |');
    lines.push('|-------|--------|----|----|----|----|--------|');
    for (const p of result.pages) {
      lines.push(
        `| ${p.path} | ${statusIcon(p.status)} | ${p.counts.critical} | ${p.counts.serious} | ${p.counts.moderate} | ${p.counts.minor} | ${p.detail.replace(/\|/g, '\\|')} |`
      );
    }
    lines.push('');
  }

  if (result.failures.length > 0) {
    lines.push('## Violations by route');
    lines.push('');
    for (const p of result.failures) {
      lines.push(`### ${p.path}`);
      lines.push('');
      for (const v of p.violations) {
        lines.push(
          `- ${SEVERITY_ICON[v.severity]} **${v.severity}** \`${v.rule}\` — _${v.category}_: ${v.description.replace(/\|/g, '\\|')}` +
            (v.nodes.length > 0 ? ` (${v.nodes.length} node${v.nodes.length === 1 ? '' : 's'})` : '') +
            (v.helpUrl ? ` — [fix](${v.helpUrl})` : '')
        );
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
 * Audit every page route of the target app for WCAG 2.1 AA compliance with axe-core, grouping
 * violations by severity. CRITICAL violations block the build (`blocked`/`passed`). Boots the dev
 * server when needed, audits each route, stops the server, and stores the summary in Build Memory.
 * Always resolves — never throws, never fabricates a pass; un-evaluable routes/runs SKIP with a note.
 */
export async function runAccessibilityAudit(
  input: AccessibilityAuditInput,
  options: AccessibilityAuditorOptions = {}
): Promise<AccessibilityReport> {
  const log = options.log ?? logLine('a11y');
  const now = options.now ?? nowIso;
  const projectPath = input.projectPath;
  const projectName = input.projectName || basename(projectPath) || 'unknown';
  const buildRunId = input.buildRunId ?? null;
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const navTimeoutMs = input.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  const startupTimeoutMs = input.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const wcagTags = input.wcagTags && input.wcagTags.length > 0 ? input.wcagTags : [...WCAG_21_AA_TAGS];
  const startServer = input.startServer ?? true;
  const storeResult = options.storeResult ?? ((r: A11yStoredRecord) => defaultStoreResult(r, log));

  const base = (): Omit<AccessibilityReport, 'report'> => ({
    passed: true,
    blocked: false,
    ran: false,
    devServerStarted: false,
    driverAvailable: true,
    failures: [],
    pages: [],
    counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    totalViolations: 0,
    auditedPages: 0,
    skippedPages: 0,
    wcagTags,
    baseUrl,
    generatedAt: now(),
  });

  const done = (partial: Omit<AccessibilityReport, 'report'>): AccessibilityReport => ({
    ...partial,
    report: renderReport(partial),
  });

  // Trigger guard: when changedFiles is supplied, only run if a UI file (.tsx/.css) changed.
  if (input.changedFiles !== undefined && !hasUiFileChanges(input.changedFiles)) {
    log('no UI files (.tsx/.css) changed — accessibility audit not triggered');
    return done(base());
  }

  // 1. Discover routes.
  const discover = options.discoverRoutes ?? defaultDiscoverRoutes;
  let routes: A11yRouteSpec[];
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
  log(`discovered ${routes.length} page route(s) to audit for WCAG 2.1 AA`);

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

  // 3. Acquire a browser+axe driver. Null ⇒ every route skips (after stopping the server).
  let driver: A11yDriver | null = options.driver ?? null;
  let ownsDriver = false;
  if (!driver) {
    const create = options.createDriver ?? ((o) => createPlaywrightAxeDriver(o));
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
    const pages = routes.map((r) =>
      skippedPage(r, baseUrl, 'browser/axe unavailable (Playwright or axe-core not installed / failed to launch)')
    );
    log('browser or axe-core unavailable — all route(s) skipped');
    return done({ ...base(), driverAvailable: false, devServerStarted, pages, skippedPages: pages.length });
  }

  // 4. Audit every route, then ALWAYS stop the server + browser.
  const pages: PageAccessibilityResult[] = [];
  try {
    for (const route of routes) {
      pages.push(await auditRoute(route, { driver, baseUrl, navTimeoutMs, wcagTags }));
    }
  } finally {
    if (ownsDriver) await driver.close().catch(() => {});
    if (serverHandle) await serverHandle.stop().catch(() => {});
  }

  // 5. Roll up.
  const audited = pages.filter((p) => p.status === 'pass' || p.status === 'fail');
  const failures = pages.filter((p) => p.status === 'fail');
  const skippedPages = pages.filter((p) => p.status === 'skipped' || p.status === 'error').length;
  const counts = pages.reduce<SeverityCounts>((acc, p) => addCounts(acc, p.counts), {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
  });
  const totalViolations = counts.critical + counts.serious + counts.moderate + counts.minor;
  const blocked = counts.critical > 0;

  const partial: Omit<AccessibilityReport, 'report'> = {
    ...base(),
    passed: !blocked,
    blocked,
    ran: true,
    devServerStarted,
    failures,
    pages,
    counts,
    totalViolations,
    auditedPages: audited.length,
    skippedPages,
  };

  // 6. Store the summary in Build Memory (guarded; only when something was actually audited).
  if (audited.length > 0) {
    await storeResult({
      projectName,
      buildRunId,
      blocked,
      counts,
      totalViolations,
      auditedPages: audited.length,
      skippedPages,
      baseUrl,
      generatedAt: partial.generatedAt,
      pages: pages.map((p) => ({ path: p.path, status: p.status, counts: p.counts })),
    });
  }

  log(
    blocked
      ? `accessibility: BLOCKED ❌ — ${counts.critical} critical violation(s) across ${audited.length} route(s)`
      : `accessibility: ${totalViolations > 0 ? '⚠️ PASS WITH VIOLATIONS' : 'PASS ✅'} — ${totalViolations} violation(s), ${audited.length} audited, ${skippedPages} skipped`
  );
  return done(partial);
}

/** Build a `skipped` page result with a note (shared by the unreachable-server / no-driver paths). */
function skippedPage(route: A11yRouteSpec, baseUrl: string, detail: string): PageAccessibilityResult {
  return {
    path: route.path,
    ...(route.name !== undefined ? { name: route.name } : {}),
    url: joinUrl(baseUrl, concreteUrlPath(route.path)),
    status: 'skipped',
    passed: false,
    httpStatus: null,
    violations: [],
    counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    dynamic: route.dynamic ?? false,
    detail,
  };
}

export default runAccessibilityAudit;
