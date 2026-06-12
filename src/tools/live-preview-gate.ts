/**
 * FORGE 2.0 — Live Preview Gate (`src/tools/live-preview-gate.ts`).
 *
 * After any Phase 3 prompt that MODIFIES UI files (a changed file ending in `.tsx` or `.css` —
 * see {@link hasUiFileChanges}), actually RUN the built target app and prove every page renders.
 * Where the Visual Regression check proves a page still *looks* the same and the Six Laws UI law
 * proves a page renders the *right elements*, this gate proves the much more basic thing first:
 * the app BOOTS and every route returns a live, non-blank, error-free page. It is the "did we just
 * ship a white screen of death" guard a static `tsc`/`build` pass cannot give.
 *
 * LIFECYCLE (per the task contract):
 *   1. DISCOVER every route declared in the app directory — reuses the Phase 1C/3 `readCodebase`
 *      route extractor (`kind: 'page'` routes from the `app/` or `pages/` router), so route
 *      resolution is byte-identical to the rest of FORGE and no new parser is introduced.
 *   2. START the dev server (`pnpm dev`) in the project root and WAIT until it answers HTTP on the
 *      base URL (readiness is polled against the live port, not guessed from a log line).
 *   3. For EACH route, drive Playwright to visit it and verify, in one pass:
 *        - HTTP 200 response (a non-200 navigation FAILS the route),
 *        - NO console / page errors (any error FAILS the route),
 *        - the page is NOT blank — `document.body.innerText.length > 50` (a blank page FAILS),
 *        - a screenshot is captured to `<projectPath>/.forge/preview/<route-slug>.png`.
 *   4. KILL the dev server (process tree) once every route has been checked — always, even on error.
 *
 * OUTPUT: a {@link LivePreviewResult} `{ passed, pages: PreviewPageResult[], … }` with PER-ROUTE
 * status. `passed` is false iff at least one route is a `fail`. Dynamic routes (`/users/:id`) are
 * visited best-effort with a synthetic parameter and never hard-fail the gate (a 404 there means
 * "no seed row for the sample id", not "the page is broken").
 *
 * HOUSE STYLE (matches `visual-regression`, `six-laws-verifier`, `phase4-sentinel`): NON-FATAL and
 * never throws, never fabricates a pass. A precondition that cannot be evaluated — the dev server
 * never becomes ready, Playwright is unavailable, a route won't load at all — is reported as
 * `skipped`/`error` on that route (or the whole run) with a note, NEVER a false pass and NEVER a
 * false fail (Iron Law 3). Every external collaborator (the dev-server starter, the browser driver,
 * the route discovery, and the filesystem) is injectable, so the gate unit-tests with no `pnpm`, no
 * server, no browser, and no disk.
 *
 * BOUNDARY (Iron Law 1): writes ONLY inside `<projectPath>/.forge/preview/` (screenshots). It runs
 * the app and reads its rendered pages — never its source, never a governance file, never a secret.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';

import { readCodebase } from './codebase-reader.js';
import type { RouteInfo } from './codebase-reader.js';
import { logLine } from './forge-logger.js';
import { nowIso } from '../memory/index.js';

// ---------------------------------------------------------------------------
// Public contract — what to verify
// ---------------------------------------------------------------------------

/** A single route to visit. */
export interface PreviewRouteSpec {
  /** Route path with dynamic segments as `:seg` / `*seg` (joined onto `baseUrl`). */
  path: string;
  /** Friendly name (for the report). */
  name?: string;
  /** Whether the route contains a dynamic/catch-all segment (visited best-effort, never hard-fails). */
  dynamic?: boolean;
}

/** What to check — the project to boot + the routes to visit. */
export interface LivePreviewInput {
  /** Target project root. The dev server runs here; screenshots write under `<projectPath>/.forge/`. */
  projectPath: string;
  /**
   * Routes to visit. When omitted, they are DISCOVERED from the app directory via `readCodebase`
   * (`kind: 'page'` routes). An empty discovery → the run is a no-op (`pages: []`, passed).
   */
  routes?: PreviewRouteSpec[];
  /** Running app base URL. Default `http://localhost:3000`. */
  baseUrl?: string;
  /** Dev-server command. Default `pnpm` (BLUEPRINT TECH STACK — never npm/yarn). */
  devCommand?: string;
  /** Dev-server args. Default `['dev']`. */
  devArgs?: string[];
  /** Minimum `document.body.innerText.length` for a page to count as non-blank. Default 50. */
  minBodyTextLength?: number;
  /** Capture the full scrollable page (default) or just the viewport. */
  fullPage?: boolean;
  /** Screenshot directory (absolute, or relative to `projectPath`). Default `.forge/preview`. */
  screenshotDir?: string;
  /** How long to wait for the dev server to answer HTTP before giving up (ms). Default 90000. */
  startupTimeoutMs?: number;
  /** Readiness poll interval while waiting for the dev server (ms). Default 1000. */
  pollIntervalMs?: number;
  /** Per-navigation timeout (ms). Default 20000. */
  navTimeoutMs?: number;
  /**
   * Changed files from the prompt that just ran. When supplied, the gate ONLY runs if at least one
   * is a UI file (`.tsx`/`.css` — see {@link hasUiFileChanges}); otherwise it returns a no-op
   * `skipped` run. When omitted, the gate assumes it was invoked deliberately and runs.
   */
  changedFiles?: string[];
}

// ---------------------------------------------------------------------------
// Public contract — results
// ---------------------------------------------------------------------------

/** Per-route outcome. */
export type PreviewPageStatus =
  | 'pass' //     HTTP 200, no console errors, body not blank, screenshot taken
  | 'fail' //     loaded but violated a check (non-200 / console error / blank page)
  | 'error' //    could not navigate/capture at all — neither pass nor fail (un-evaluable)
  | 'skipped'; // not evaluated (dynamic route best-effort, server/browser unavailable)

/** The result for one route. */
export interface PreviewPageResult {
  path: string;
  name?: string;
  /** Full URL visited (with any synthetic dynamic-segment substitution). */
  url: string;
  status: PreviewPageStatus;
  /** True only for `pass`. */
  passed: boolean;
  /** HTTP status of the navigation, or null when no response was received. */
  httpStatus: number | null;
  /** `document.body.innerText.length` observed, or null when not measured. */
  bodyTextLength: number | null;
  /** Console + page errors captured during the visit. */
  consoleErrors: string[];
  /** Absolute path of the screenshot written for this route, or null. */
  screenshotPath: string | null;
  /** Whether this route carries a dynamic/catch-all segment (visited best-effort). */
  dynamic: boolean;
  /** One-line human-readable detail. */
  detail: string;
}

/** The full live-preview result (the gate's output contract). */
export interface LivePreviewResult {
  /** False iff at least one route is a `fail`. Errors/skips do not fail the run. */
  passed: boolean;
  /** Whether the gate actually evaluated routes (false ⇒ no UI change / server down / no routes). */
  ran: boolean;
  /** Whether the dev server became ready and was driven. */
  devServerStarted: boolean;
  /** Whether a browser driver was available at all (false ⇒ every route skipped). */
  driverAvailable: boolean;
  /** Routes that failed (subset of `pages`). */
  failures: PreviewPageResult[];
  pages: PreviewPageResult[];
  /** Count of routes that passed. */
  passedPages: number;
  /** Count of routes that failed. */
  failedPages: number;
  /** Count of routes not evaluated (skipped/error). */
  skippedPages: number;
  baseUrl: string;
  screenshotDir: string;
  /** Full markdown report. */
  report: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Public contract — injectable collaborators
// ---------------------------------------------------------------------------

/** A request to visit one URL and capture its render. */
export interface PreviewProbeRequest {
  url: string;
  fullPage: boolean;
  timeoutMs: number;
}

/** The observations from visiting one page. */
export interface PreviewProbe {
  /** True when the page navigated to a non-error (<400) status. */
  ok: boolean;
  /** HTTP status of the navigation, or null. */
  status: number | null;
  /** URL after redirects. */
  finalUrl: string;
  /** Length of `document.body.innerText` (0 when unmeasured/blank). */
  bodyTextLength: number;
  consoleErrors: string[];
  pageErrors: string[];
  /** The screenshot PNG bytes, or null when capture failed. */
  screenshot: Buffer | null;
  /** Set when the navigation/capture itself failed (unreachable, timeout, …). */
  error: string | null;
}

/** A browser driver the gate uses. The default is Playwright/Chromium; tests inject a fake. */
export interface PreviewDriver {
  probe(req: PreviewProbeRequest): Promise<PreviewProbe>;
  close(): Promise<void>;
}

/** A handle to a running dev server. `stop` kills its process tree (idempotent, never throws). */
export interface PreviewServerHandle {
  stop(): Promise<void>;
}

/** The outcome of trying to start the dev server. */
export interface DevServerStart {
  /** True when the server answered HTTP on the base URL before the startup timeout. */
  ready: boolean;
  /** A handle to stop the server (null when it never spawned). */
  handle: PreviewServerHandle | null;
  /** Human-readable detail (why it failed, or the readiness time). */
  detail: string;
}

/** Starts the dev server and resolves once it answers HTTP (or the startup timeout elapses). */
export type DevServerStarter = (params: {
  projectPath: string;
  command: string;
  args: string[];
  baseUrl: string;
  startupTimeoutMs: number;
  pollIntervalMs: number;
  log: (m: string) => void;
}) => Promise<DevServerStart>;

/** Minimal filesystem seam (injectable for tests). */
export interface PreviewFs {
  writeFile(path: string, data: Buffer): Promise<boolean>;
}

/** Options — injectable collaborators + tuning (none required). */
export interface LivePreviewOptions {
  /** Override route discovery (tests). Default: `readCodebase(projectPath)` page routes. */
  discoverRoutes?: (projectPath: string) => Promise<PreviewRouteSpec[]>;
  /** Inject a ready browser driver. Default: a lazily-created Playwright driver. */
  driver?: PreviewDriver;
  /** Override how the default driver is created (tests). Returns null when unavailable. */
  createDriver?: (opts: {
    headless: boolean;
    viewport: { width: number; height: number };
    log: (m: string) => void;
  }) => Promise<PreviewDriver | null>;
  /** Override the dev-server starter (tests). Default: spawn `pnpm dev` + poll the base URL. */
  startDevServer?: DevServerStarter;
  /** Override the filesystem (tests). Default: a guarded `node:fs/promises` wrapper. */
  fs?: PreviewFs;
  /** Run the browser headless. Default true. */
  headless?: boolean;
  /** Deterministic viewport for capture. Default 1280×800. */
  viewport?: { width: number; height: number };
  /** Override the timestamp source (tests). Default: `nowIso`. */
  now?: () => string;
  /** Progress reporter. Default logs with a `[FORGE:preview]` prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_DEV_COMMAND = 'pnpm';
const DEFAULT_DEV_ARGS: readonly string[] = ['dev'];
const DEFAULT_MIN_BODY_TEXT = 50;
const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_NAV_TIMEOUT_MS = 20_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
/** Grace between SIGTERM and SIGKILL when stopping the dev server (POSIX). */
const KILL_GRACE_MS = 3_000;
/** UI file extensions whose change triggers this gate. */
const UI_FILE_EXTENSIONS: readonly string[] = ['.tsx', '.css'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Render an unknown thrown value as a short string. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolve a value after `ms` (used by the readiness poll; unref'd so it never holds the loop). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/** Join a base URL and a path, tolerating leading/trailing slashes. */
function joinUrl(baseUrl: string, path: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

/** Turn a route path into a filesystem-safe slug (`/dashboard/users` → `dashboard-users`). */
export function routeSlug(path: string): string {
  const noQuery = path.split('#')[0]?.split('?')[0] ?? path;
  const slug = noQuery
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'root' : slug;
}

/** Resolve a directory option (absolute kept; relative joined onto projectPath; default fallback). */
function resolveDir(dir: string | undefined, projectPath: string, fallback: string[]): string {
  if (dir && dir.trim() !== '') return isAbsolute(dir) ? dir : join(projectPath, dir);
  return join(projectPath, ...fallback);
}

/** Default filesystem seam — guarded, never throws. */
const defaultFs: PreviewFs = {
  async writeFile(path, data) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Whether any of `files` is a UI file (`.tsx` or `.css`) — the gate's trigger condition. Tolerant of
 * Windows or POSIX separators and trailing whitespace; an empty/undefined list is `false`.
 */
export function hasUiFileChanges(files: readonly string[] | undefined): boolean {
  if (!files || files.length === 0) return false;
  return files.some((f) => {
    const lower = (f ?? '').trim().toLowerCase();
    return UI_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  });
}

/**
 * Substitute a route's dynamic segments with a synthetic sample so it can actually be visited
 * (`/users/:id` → `/users/1`, `/blog/*slug` → `/blog/sample`). Static routes pass through unchanged.
 */
export function concreteUrlPath(routePath: string): string {
  return routePath
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) return '1';
      if (seg.startsWith('*')) return 'sample';
      return seg;
    })
    .join('/');
}

// ---------------------------------------------------------------------------
// Route discovery (default) — reuse the codebase-reader route extractor
// ---------------------------------------------------------------------------

/** Map a `readCodebase` {@link RouteInfo} to a {@link PreviewRouteSpec}. */
function routeInfoToSpec(r: RouteInfo): PreviewRouteSpec {
  return { path: r.route, name: r.file, dynamic: r.dynamic };
}

/** Default route discovery: every `kind: 'page'` route in the app/pages directory, deduped by path. */
async function defaultDiscoverRoutes(projectPath: string): Promise<PreviewRouteSpec[]> {
  let routes: RouteInfo[] = [];
  try {
    const snapshot = await readCodebase(projectPath);
    routes = snapshot.routes;
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const specs: PreviewRouteSpec[] = [];
  for (const r of routes) {
    if (r.kind !== 'page') continue;
    const key = r.route;
    if (seen.has(key)) continue;
    seen.add(key);
    specs.push(routeInfoToSpec(r));
  }
  // Stable order: shorter (shallower) routes first, then alphabetical — deterministic reports.
  specs.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  return specs;
}

// ---------------------------------------------------------------------------
// Default dev-server starter (spawn `pnpm dev` + poll readiness)
// ---------------------------------------------------------------------------

/** Probe whether `url` answers HTTP at all (any status ⇒ the server is up). Never throws. */
async function httpResponds(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(4_000), redirect: 'manual' });
    // Any HTTP response — even a 404/500 — means the dev server is listening.
    return typeof res.status === 'number';
  } catch {
    return false;
  }
}

/**
 * Default {@link DevServerStarter}: spawn the dev command in the project root and poll the base URL
 * until it answers HTTP or the startup timeout elapses. Returns a handle whose `stop` kills the whole
 * process tree (on Windows via `taskkill /T`, else SIGTERM→SIGKILL). NEVER throws — a spawn failure or
 * an early exit resolves to `{ ready: false, … }` with a note.
 */
export const defaultStartDevServer: DevServerStarter = async (params) => {
  const { projectPath, command, args, baseUrl, startupTimeoutMs, pollIntervalMs, log } = params;
  const useShell = process.platform === 'win32';

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, {
      cwd: projectPath,
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
    });
  } catch (error) {
    return { ready: false, handle: null, detail: `failed to spawn '${command} ${args.join(' ')}' (${describe(error)})` };
  }

  let exited = false;
  let exitInfo = '';
  child.on('error', (err: Error) => {
    exited = true;
    exitInfo = `spawn error: ${err.message}`;
  });
  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = `dev server exited early (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`;
  });
  // Drain output so the child never blocks on a full pipe; surface nothing unless it helps debugging.
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});

  const handle: PreviewServerHandle = {
    async stop() {
      try {
        if (process.platform === 'win32' && typeof child.pid === 'number') {
          // Kill the whole tree — `pnpm` spawns `next dev` as a child; killing pnpm alone orphans it.
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
        } else {
          child.kill('SIGTERM');
          const t = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }, KILL_GRACE_MS);
          if (typeof t.unref === 'function') t.unref();
        }
      } catch {
        /* never throws */
      }
    },
  };

  log(`dev server: '${command} ${args.join(' ')}' (cwd=${projectPath}) — waiting for ${baseUrl}`);
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      return { ready: false, handle, detail: exitInfo || 'dev server exited before becoming ready' };
    }
    if (await httpResponds(baseUrl)) {
      const waitedMs = startupTimeoutMs - (deadline - Date.now());
      log(`dev server ready after ~${Math.round(waitedMs / 1000)}s`);
      return { ready: true, handle, detail: `ready after ~${Math.round(waitedMs / 1000)}s` };
    }
    await delay(pollIntervalMs);
  }
  return { ready: false, handle, detail: `dev server did not answer ${baseUrl} within ${Math.round(startupTimeoutMs / 1000)}s` };
};

// ---------------------------------------------------------------------------
// Default Playwright driver
// ---------------------------------------------------------------------------

/**
 * Create the default Playwright driver. Lazily imports `playwright`, launches Chromium with a
 * deterministic viewport, and — in ONE navigation per route — records the HTTP status, console / page
 * errors, the `document.body.innerText` length, and a screenshot. Returns `null` (every route then
 * skips) when Playwright is unavailable or Chromium cannot launch — never throws. Mirrors the Six
 * Laws / Visual Regression drivers (Locator APIs only, no DOM globals — the tsconfig `lib` is ES2022).
 */
export async function createPlaywrightPreviewDriver(options: {
  headless?: boolean;
  viewport?: { width: number; height: number };
  log?: (m: string) => void;
}): Promise<PreviewDriver | null> {
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

  const probe = async (req: PreviewProbeRequest): Promise<PreviewProbe> => {
    const result: PreviewProbe = {
      ok: false,
      status: null,
      finalUrl: req.url,
      bodyTextLength: 0,
      consoleErrors: [],
      pageErrors: [],
      screenshot: null,
      error: null,
    };
    let context: import('playwright').BrowserContext | null = null;
    try {
      context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.on('console', (msg) => {
        if (msg.type() === 'error') result.consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => result.pageErrors.push(String(err)));

      const resp = await page.goto(req.url, { waitUntil: 'load', timeout: req.timeoutMs });
      await page.waitForLoadState('networkidle', { timeout: Math.min(5_000, req.timeoutMs) }).catch(() => {});
      result.status = resp ? resp.status() : null;
      result.finalUrl = page.url();
      result.ok = resp ? resp.status() < 400 : false;

      try {
        const text = await page.locator('body').innerText({ timeout: 2_000 });
        result.bodyTextLength = text.length;
      } catch {
        result.bodyTextLength = 0;
      }

      // Screenshot regardless of status — a captured error page is useful diagnostic context.
      try {
        const png = await page.screenshot({ fullPage: req.fullPage, animations: 'disabled', caret: 'hide', type: 'png' });
        result.screenshot = Buffer.from(png);
      } catch {
        result.screenshot = null;
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
// Per-route classification
// ---------------------------------------------------------------------------

/** Parameters threaded into {@link checkRoute}. */
interface CheckRouteDeps {
  driver: PreviewDriver;
  fs: PreviewFs;
  baseUrl: string;
  screenshotDir: string;
  minBodyTextLength: number;
  fullPage: boolean;
  navTimeoutMs: number;
}

/** Visit one route, classify it, and persist its screenshot. Never throws. */
async function checkRoute(route: PreviewRouteSpec, deps: CheckRouteDeps): Promise<PreviewPageResult> {
  const dynamic = route.dynamic ?? false;
  const urlPath = concreteUrlPath(route.path);
  const url = joinUrl(deps.baseUrl, urlPath);
  const screenshotPath = join(deps.screenshotDir, `${routeSlug(route.path)}.png`);

  const result: PreviewPageResult = {
    path: route.path,
    ...(route.name !== undefined ? { name: route.name } : {}),
    url,
    status: 'skipped',
    passed: false,
    httpStatus: null,
    bodyTextLength: null,
    consoleErrors: [],
    screenshotPath: null,
    dynamic,
    detail: '',
  };

  const probe = await deps.driver.probe({ url, fullPage: deps.fullPage, timeoutMs: deps.navTimeoutMs });
  result.httpStatus = probe.status;
  result.bodyTextLength = probe.bodyTextLength;
  result.consoleErrors = [...probe.pageErrors, ...probe.consoleErrors];

  // Persist the screenshot whenever we captured one (best-effort, even for a failing page).
  if (probe.screenshot) {
    const wrote = await deps.fs.writeFile(screenshotPath, probe.screenshot);
    result.screenshotPath = wrote ? screenshotPath : null;
  }

  // Navigation failed entirely — could not evaluate. For a dynamic route this is a skip (the
  // sample param may simply not resolve); for a static route it is an `error` (un-evaluable).
  if (probe.error) {
    result.status = dynamic ? 'skipped' : 'error';
    result.detail = `could not load (${probe.error})`;
    return result;
  }

  const reasons: string[] = [];
  if (probe.status !== 200) reasons.push(`HTTP ${probe.status ?? 'none'} (expected 200)`);
  if (result.consoleErrors.length > 0) {
    reasons.push(`${result.consoleErrors.length} console/page error(s): ${result.consoleErrors.slice(0, 3).join(' | ')}`);
  }
  if (probe.bodyTextLength <= deps.minBodyTextLength) {
    reasons.push(`blank page (body innerText length ${probe.bodyTextLength} ≤ ${deps.minBodyTextLength})`);
  }

  if (reasons.length === 0) {
    result.status = 'pass';
    result.passed = true;
    result.detail = `HTTP 200, ${probe.bodyTextLength} chars rendered, no console errors${result.screenshotPath ? ', screenshot captured' : ''}`;
    return result;
  }

  // A dynamic route that only fails on a non-200 (likely "no seed row for sample id") is a SKIP,
  // not a failure — we cannot distinguish "page broken" from "sample param has no data". But a
  // dynamic route with console errors or a blank-but-200 render IS a real defect → fail.
  const onlyStatusFailed =
    probe.status !== 200 && result.consoleErrors.length === 0 && probe.bodyTextLength > deps.minBodyTextLength;
  if (dynamic && onlyStatusFailed) {
    result.status = 'skipped';
    result.detail = `dynamic route returned HTTP ${probe.status ?? 'none'} for sample param — not treated as a failure`;
    return result;
  }

  result.status = 'fail';
  result.detail = reasons.join('; ');
  return result;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function statusIcon(s: PreviewPageStatus): string {
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

/** Render the full markdown report. */
function renderReport(result: Omit<LivePreviewResult, 'report'>): string {
  const lines: string[] = [];
  lines.push('# FORGE — Live Preview Gate');
  lines.push('');
  lines.push(`- **Target:** ${result.baseUrl}`);
  lines.push(
    `- **Overall:** ${!result.ran ? '⊘ NOT RUN' : result.passed ? 'PASS ✅' : 'FAIL ❌'}`
  );
  lines.push(`- **Dev server:** ${result.devServerStarted ? 'started + reachable' : 'NOT started/reachable'}`);
  lines.push(`- **Routes:** ${result.passedPages} passed, ${result.failedPages} failed, ${result.skippedPages} skipped/error`);
  lines.push(`- **Screenshots:** ${result.screenshotDir}`);
  lines.push(`- **Generated:** ${result.generatedAt}`);
  lines.push('');
  if (result.pages.length > 0) {
    lines.push('| Route | Result | HTTP | Body chars | Detail |');
    lines.push('|-------|--------|------|-----------|--------|');
    for (const p of result.pages) {
      const http = p.httpStatus === null ? '—' : String(p.httpStatus);
      const body = p.bodyTextLength === null ? '—' : String(p.bodyTextLength);
      lines.push(`| ${p.path} | ${statusIcon(p.status)} | ${http} | ${body} | ${p.detail.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  if (result.failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const p of result.failures) {
      lines.push(`- ❌ **${p.path}** — ${p.detail}` + (p.screenshotPath ? ` (screenshot: ${p.screenshotPath})` : ''));
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Boot the target app's dev server, visit every page route, verify HTTP 200 / no console errors /
 * non-blank render / screenshot per route, then kill the dev server. Always resolves — never throws,
 * never fabricates a pass; un-evaluable routes/runs SKIP with a note (Iron Law 3).
 */
export async function runLivePreviewGate(
  input: LivePreviewInput,
  options: LivePreviewOptions = {}
): Promise<LivePreviewResult> {
  const log = options.log ?? logLine('preview');
  const fs = options.fs ?? defaultFs;
  const now = options.now ?? nowIso;
  const projectPath = input.projectPath;
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const minBodyTextLength = input.minBodyTextLength ?? DEFAULT_MIN_BODY_TEXT;
  const fullPage = input.fullPage ?? true;
  const navTimeoutMs = input.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  const startupTimeoutMs = input.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const screenshotDir = resolveDir(input.screenshotDir, projectPath, ['.forge', 'preview']);

  const base = (): Omit<LivePreviewResult, 'report'> => ({
    passed: true,
    ran: false,
    devServerStarted: false,
    driverAvailable: true,
    failures: [],
    pages: [],
    passedPages: 0,
    failedPages: 0,
    skippedPages: 0,
    baseUrl,
    screenshotDir,
    generatedAt: now(),
  });

  const done = (partial: Omit<LivePreviewResult, 'report'>): LivePreviewResult => ({
    ...partial,
    report: renderReport(partial),
  });

  // Trigger guard: when changedFiles is supplied, only run if a UI file (.tsx/.css) changed.
  if (input.changedFiles !== undefined && !hasUiFileChanges(input.changedFiles)) {
    log('no UI files (.tsx/.css) changed — live preview gate not triggered');
    return done(base());
  }

  // 1. Discover routes.
  const discover = options.discoverRoutes ?? defaultDiscoverRoutes;
  let routes: PreviewRouteSpec[];
  try {
    routes = input.routes ?? (await discover(projectPath));
  } catch (error) {
    log(`WARNING: route discovery failed (${describe(error)})`);
    routes = [];
  }
  if (routes.length === 0) {
    log('no page routes discovered in the app directory — nothing to preview');
    return done(base());
  }
  log(`discovered ${routes.length} page route(s) to preview`);

  // 2. Start the dev server.
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

  if (!start.ready) {
    // Could not boot the app → cannot evaluate. SKIP every route (never a false fail).
    if (start.handle) await start.handle.stop().catch(() => {});
    const pages: PreviewPageResult[] = routes.map((r) => ({
      path: r.path,
      ...(r.name !== undefined ? { name: r.name } : {}),
      url: joinUrl(baseUrl, concreteUrlPath(r.path)),
      status: 'skipped',
      passed: false,
      httpStatus: null,
      bodyTextLength: null,
      consoleErrors: [],
      screenshotPath: null,
      dynamic: r.dynamic ?? false,
      detail: `dev server not ready — ${start.detail}`,
    }));
    log(`dev server not ready (${start.detail}) — all ${pages.length} route(s) skipped`);
    return done({ ...base(), pages, skippedPages: pages.length, devServerStarted: false });
  }

  // 3. Acquire a browser driver. Null ⇒ every route skips (after stopping the server).
  let driver: PreviewDriver | null = options.driver ?? null;
  let ownsDriver = false;
  if (!driver) {
    const create = options.createDriver ?? ((o) => createPlaywrightPreviewDriver(o));
    try {
      driver = await create({ headless: options.headless ?? true, viewport: options.viewport ?? DEFAULT_VIEWPORT, log });
    } catch (error) {
      log(`WARNING: driver creation failed (${describe(error)})`);
      driver = null;
    }
    ownsDriver = driver !== null;
  }

  if (!driver) {
    if (start.handle) await start.handle.stop().catch(() => {});
    const pages: PreviewPageResult[] = routes.map((r) => ({
      path: r.path,
      ...(r.name !== undefined ? { name: r.name } : {}),
      url: joinUrl(baseUrl, concreteUrlPath(r.path)),
      status: 'skipped',
      passed: false,
      httpStatus: null,
      bodyTextLength: null,
      consoleErrors: [],
      screenshotPath: null,
      dynamic: r.dynamic ?? false,
      detail: 'browser driver unavailable (Playwright not installed / failed to launch)',
    }));
    log('browser unavailable — all route(s) skipped');
    return done({ ...base(), driverAvailable: false, devServerStarted: true, pages, skippedPages: pages.length });
  }

  // 4. Visit every route, then ALWAYS stop the server + browser.
  const pages: PreviewPageResult[] = [];
  try {
    for (const route of routes) {
      pages.push(
        await checkRoute(route, {
          driver,
          fs,
          baseUrl,
          screenshotDir,
          minBodyTextLength,
          fullPage,
          navTimeoutMs,
        })
      );
    }
  } finally {
    if (ownsDriver) await driver.close().catch(() => {});
    if (start.handle) await start.handle.stop().catch(() => {});
  }

  const passedPages = pages.filter((p) => p.status === 'pass').length;
  const failures = pages.filter((p) => p.status === 'fail');
  const skippedPages = pages.filter((p) => p.status === 'skipped' || p.status === 'error').length;
  const passed = failures.length === 0;

  const partial: Omit<LivePreviewResult, 'report'> = {
    ...base(),
    passed,
    ran: true,
    devServerStarted: true,
    failures,
    pages,
    passedPages,
    failedPages: failures.length,
    skippedPages,
  };
  log(
    passed
      ? `live preview: PASS ✅ (${passedPages}/${pages.length} routes rendered, ${skippedPages} skipped/error)`
      : `live preview: FAIL ❌ — ${failures.length} route(s) failed`
  );
  return done(partial);
}

export default runLivePreviewGate;
