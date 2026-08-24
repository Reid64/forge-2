/**
 * FORGE 2.0 — Design Pipeline: PlaywrightScreenshotter (`src/design-pipeline/screenshotter.ts`).
 *
 * Renders a generated component/page in a REAL headless browser and captures a screenshot at every
 * viewport FORGE cares about (desktop, laptop, tablet, mobile), so a design/UI prompt's output can be
 * visually inspected — by a human, by a future vision-capable review pass, or simply archived for
 * before/after diffing — instead of being judged purely by whether `tsc`/`build` succeeded. Where
 * `src/ui-engine/accessibility-checker.ts` proves a component's SOURCE CODE has no obvious WCAG 2.1 AA
 * structural defects (a static regex scan, zero browser), this module proves what the component
 * actually RENDERS AS, and folds that same accessibility-checker score into every capture it takes so
 * a screenshot and its accessibility verdict travel together.
 *
 * House style, matching `src/tools/live-preview-gate.ts`/`src/tools/accessibility-auditor.ts`/
 * `src/ui-engine/shadcn-installer.ts`: every public method is guarded — a missing Playwright
 * dependency, an unreachable dev server, a navigation timeout, or an unwritable storage directory
 * degrades to an empty result array (or `null` for a single value) and a logged warning, NEVER an
 * uncaught exception. Screenshotting is a quality-of-life/observability layer (Contract 4 posture),
 * never a build blocker — a build with no working browser must still be able to finish.
 *
 * WHAT IT DOES:
 *   1. `isAvailable()`        — confirms Playwright is actually installed before anything else tries
 *                                to use it (mirrors `createPlaywrightAxeDriver`'s lazy-import guard).
 *   2. `startDevServer()`     — spawns the target project's Next.js dev server (`pnpm dev`) and polls
 *                                its base URL for up to 30 seconds, returning the port once it answers
 *                                HTTP (or `null` if it never comes up in time).
 *   3. `captureComponent()`   — launches headless Chromium, navigates to a URL, waits for the network
 *                                to go idle, and takes one screenshot per requested viewport, writing
 *                                each PNG to disk and returning one {@link ScreenshotResult} per shot.
 *   4. `captureAllRoutes()`   — walks a Next.js App Router project's `src/app` tree for every
 *                                `page.tsx`, maps each to its URL route (handling route groups,
 *                                parallel-route slots, and dynamic segments), starts the dev server if
 *                                one isn't already running, and captures every discovered route.
 *   5. `stopDevServer()`      — kills whatever dev server process this instance started (idempotent,
 *                                cross-platform: `taskkill /T /F` on Windows, SIGTERM→SIGKILL on POSIX).
 *
 * NOT IN SCOPE (deliberately, matching every other regex/heuristic module in this codebase's stated
 * limitations): this module does not diff screenshots against a baseline (that is Visual Regression's
 * job, a separate tool), does not itself run axe-core against the rendered DOM (that is the
 * Accessibility Auditor's job), and does not judge whether the SCREENSHOT looks good — it only proves
 * the render happened and preserves the evidence.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { logLine } from '../tools/forge-logger.js';
import { checkComponentAccessibility, extractDeclaredColorTokens } from '../ui-engine/accessibility-checker.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** One screenshot capture — one entry per (component, viewport) pair. */
export interface ScreenshotResult {
  /** Absolute path to the written PNG file on disk. */
  filePath: string;
  /** The URL that was navigated to for this capture. */
  url: string;
  /** The viewport spec used (e.g. `'1920x1080'`), verbatim from the request. */
  viewport: string;
  /** The component/page name this capture belongs to. */
  componentName: string;
  /** ISO 8601 timestamp of when the capture was taken. */
  timestamp: string;
  /**
   * The matching component's {@link checkComponentAccessibility} score (0-100), when a source file
   * named after `componentName` could be found under `src/components/`. `null` when no matching
   * source file was found — never fabricated, per Iron Law 3.
   */
  accessibilityScore: number | null;
}

/** Input to {@link PlaywrightScreenshotter.captureComponent}/{@link PlaywrightScreenshotter.captureAllRoutes}. */
export interface ScreenshotOptions {
  /** Target project root (used to resolve the default storage directory and component lookup). */
  projectPath: string;
  /** Optional `build_runs.id` this capture belongs to (for provenance in a caller's own logging). */
  buildRunId?: string;
  /** Optional prompt id this capture was triggered by (for provenance). */
  promptId?: string;
  /** The component/page name being captured (used in the output file name and accessibility lookup). */
  componentName: string;
  /**
   * Directory screenshots are written to. Relative paths are resolved against `projectPath`.
   * Default: `<projectPath>/.forge/screenshots`.
   */
  storageDir?: string;
  /**
   * Viewport specs as `'<width>x<height>'` strings. Default: desktop, laptop, tablet, mobile —
   * `['1920x1080', '1280x720', '768x1024', '375x812']`.
   */
  viewports?: string[];
}

/** Options accepted by {@link PlaywrightScreenshotter.startDevServer}. */
export interface StartDevServerOptions {
  /** Dev-server command. Default `'pnpm'` (BLUEPRINT TECH STACK — never npm/yarn). */
  command?: string;
  /** Dev-server args. Default `['dev']`. */
  args?: string[];
  /** Port to request via the `PORT` env var and to poll. Default `3000`. */
  port?: number;
  /** How long to wait for the dev server to answer HTTP before giving up (ms). Default 30000 (30s). */
  startupTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Desktop, laptop, tablet, mobile — the default viewport sweep for every capture. */
export const DEFAULT_VIEWPORTS: readonly string[] = ['1920x1080', '1280x720', '768x1024', '375x812'];

const DEFAULT_DEV_COMMAND = 'pnpm';
const DEFAULT_DEV_ARGS: readonly string[] = ['dev'];
const DEFAULT_DEV_SERVER_PORT = 3000;
/** Task contract: wait up to 30 seconds for the dev server to become ready. */
const DEV_SERVER_STARTUP_TIMEOUT_MS = 30_000;
const DEV_SERVER_POLL_INTERVAL_MS = 1_000;
const NAV_TIMEOUT_MS = 20_000;
const NETWORKIDLE_TIMEOUT_MS = 5_000;
/** Grace between SIGTERM and SIGKILL when stopping the dev server (POSIX). */
const KILL_GRACE_MS = 3_000;
const DEFAULT_STORAGE_SUBDIR = join('.forge', 'screenshots');
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage']);
const PAGE_FILE_NAMES = new Set(['page.tsx', 'page.ts', 'page.jsx', 'page.js']);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Render an unknown thrown value as a short string. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve after `ms` (used by the readiness poll). Deliberately NOT `unref()`'d: this timer is
 * the only thing driving `startDevServer`'s poll loop forward, and once the spawned dev-server
 * child exits (e.g. no package.json — an immediate, common failure), its process handle stops
 * holding the event loop open. An unref'd timer at that point leaves Node with zero ref'd handles
 * mid-poll, so it exits the whole process right there instead of running this callback — the
 * `await delay(...)` (and everything awaiting `startDevServer`) never settles, and the caller
 * never sees the intended "dev server exited"/"timed out" warning. The loop is bounded (at most
 * `startupTimeoutMs`, default 30s) and always returns, so there is no runaway-timer risk in
 * keeping this ref'd.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Probe whether `url` answers HTTP at all (any status ⇒ the server is up). Never throws. */
async function httpResponds(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(4_000), redirect: 'manual' });
    return typeof res.status === 'number';
  } catch {
    return false;
  }
}

/** Join a base URL and a path, tolerating leading/trailing slashes. */
function joinUrl(baseUrl: string, path: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

/** Parse a `'<width>x<height>'` viewport spec; `null` when it does not match that shape. */
function parseViewportSpec(spec: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(spec.trim());
  if (!match || !match[1] || !match[2]) return null;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/** Filesystem-safe name fragment for a screenshot file name. */
function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'component' : cleaned;
}

/** ISO timestamps contain `:`/`.`, both illegal (or awkward) in a Windows file name. */
function sanitizeTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, '-');
}

/** Resolve the directory screenshots should be written to (relative paths join onto `projectPath`). */
function resolveStorageDir(options: ScreenshotOptions): string {
  const dir = options.storageDir;
  if (dir && dir.trim() !== '') {
    return isAbsolute(dir) ? dir : join(options.projectPath, dir);
  }
  return join(options.projectPath, DEFAULT_STORAGE_SUBDIR);
}

/** Turn a route path into a filesystem/report-safe slug (`/dashboard/users` → `dashboard-users`). */
function routeSlug(path: string): string {
  const slug = path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'root' : slug;
}

// ---------------------------------------------------------------------------
// App Router route discovery (self-contained — mirrors `codebase-reader.ts`'s segment rules)
// ---------------------------------------------------------------------------

/** One discovered `src/app/**\/page.tsx` route. */
interface AppRoute {
  /** URL path, e.g. `/dashboard/users/1`. */
  path: string;
  /** Filesystem/report-safe slug derived from `path`. */
  slug: string;
  /** Absolute path to the `page.tsx` file that produced this route. */
  filePath: string;
}

/**
 * Normalize one App Router folder segment into a URL segment. Returns `null` when the folder
 * contributes nothing to the URL — a route group `(marketing)` or a parallel-route slot `@modal`.
 * A dynamic segment (`[id]`) or catch-all (`[...slug]`) is replaced with a concrete sample value
 * so the resulting route is directly navigable rather than a literal, unroutable `[id]` path.
 */
function normalizeAppSegment(name: string): string | null {
  if (name.startsWith('(') && name.endsWith(')')) return null;
  if (name.startsWith('@')) return null;
  const catchAll = /^\[\.\.\.(.+)\]$/.exec(name);
  if (catchAll) return 'sample';
  const dynamic = /^\[(.+)\]$/.exec(name);
  if (dynamic) return '1';
  return name;
}

/**
 * Recursively walk `appDir` for every `page.(t|j)sx?` file and map it to its URL route. Degrades to
 * `[]` when `appDir` is absent or unreadable — a project with no App Router pages yet is not a
 * failure (Iron Law 3: never fabricate a result for work that never happened).
 */
function discoverAppRoutes(appDir: string): AppRoute[] {
  const routes: AppRoute[] = [];
  if (!existsSync(appDir)) return routes;

  function walk(current: string, segments: string[]): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return; // unreadable directory — skip, never throw
    }

    for (const entry of entries) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      const fullPath = join(current, entry);

      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue; // unreadable entry — skip
      }

      if (stats.isDirectory()) {
        const segment = normalizeAppSegment(entry);
        walk(fullPath, segment === null ? segments : [...segments, segment]);
      } else if (PAGE_FILE_NAMES.has(entry)) {
        const joined = `/${segments.join('/')}`.replace(/\/+/g, '/');
        const path = joined === '' ? '/' : joined;
        routes.push({ path, slug: routeSlug(path), filePath: fullPath });
      }
    }
  }

  walk(appDir, []);
  routes.sort((a, b) => a.path.localeCompare(b.path));
  return routes;
}

// ---------------------------------------------------------------------------
// Accessibility-score lookup (integrates AccessibilityChecker, never re-implements it)
// ---------------------------------------------------------------------------

/**
 * Best-effort search for a `.tsx` file under `src/components/` whose base name (case-insensitive)
 * matches `componentName`. Returns the first match, or `null` when none is found — a screenshot of a
 * page (rather than a named component) legitimately has no matching source file to score.
 */
function findComponentSourceFile(projectPath: string, componentName: string): string | null {
  const componentsDir = join(projectPath, 'src', 'components');
  let found: string | null = null;

  function walk(current: string): void {
    if (found) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found) return;
      if (EXCLUDE_DIRS.has(entry)) continue;
      const fullPath = join(current, entry);
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(fullPath);
      } else if (/\.tsx$/.test(entry) && entry.replace(/\.tsx$/, '').toLowerCase() === componentName.toLowerCase()) {
        found = fullPath;
      }
    }
  }

  walk(componentsDir);
  return found;
}

/**
 * Compute `componentName`'s {@link checkComponentAccessibility} score by locating and reading its
 * source file. Returns `null` (never throws, never fabricates a score) when no matching source file
 * exists or it can't be read — the same "skip, don't fake" posture every check in
 * `accessibility-checker.ts` itself follows.
 */
function computeAccessibilityScore(projectPath: string, componentName: string, log: (m: string) => void): number | null {
  const sourcePath = findComponentSourceFile(projectPath, componentName);
  if (!sourcePath) return null;
  try {
    const code = readFileSync(sourcePath, 'utf8');
    return checkComponentAccessibility(sourcePath, code, extractDeclaredColorTokens(projectPath)).score;
  } catch (error) {
    log(`WARNING: accessibility scoring skipped for '${componentName}' (${describeError(error)})`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// PlaywrightScreenshotter
// ---------------------------------------------------------------------------

/**
 * Drives a real headless Chromium instance (via Playwright) to render a URL and capture it at every
 * requested viewport, optionally managing the target project's own Next.js dev server across the
 * capture session. One instance owns at most one dev-server child process at a time; call
 * {@link stopDevServer} when done to avoid leaking it.
 */
export class PlaywrightScreenshotter {
  private readonly log: (message: string) => void;
  private devServerProcess: ChildProcess | null = null;
  private devServerPort: number | null = null;

  constructor(options: { log?: (message: string) => void } = {}) {
    this.log = options.log ?? logLine('screenshotter');
  }

  /** True iff the `playwright` package is installed and importable. Never throws. */
  async isAvailable(): Promise<boolean> {
    try {
      await import('playwright');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Spawn `<projectPath>`'s Next.js dev server and poll its base URL for up to 30 seconds (default
   * — see {@link StartDevServerOptions.startupTimeoutMs}) until it answers HTTP. Returns the port
   * once ready, or `null` on a spawn failure, an early exit, or a startup timeout — never throws.
   * A second call while a server this instance started is already running returns that same port
   * immediately rather than spawning a duplicate.
   */
  async startDevServer(projectPath: string, options: StartDevServerOptions = {}): Promise<number | null> {
    if (this.devServerProcess && this.devServerPort !== null) {
      this.log(`dev server already running on port ${this.devServerPort} — reusing it`);
      return this.devServerPort;
    }

    const command = options.command ?? DEFAULT_DEV_COMMAND;
    const args = options.args ?? [...DEFAULT_DEV_ARGS];
    const port = options.port ?? DEFAULT_DEV_SERVER_PORT;
    const startupTimeoutMs = options.startupTimeoutMs ?? DEV_SERVER_STARTUP_TIMEOUT_MS;
    const useShell = process.platform === 'win32';

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: projectPath,
        shell: useShell,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', PORT: String(port) },
      });
    } catch (error) {
      this.log(`WARNING: failed to spawn '${command} ${args.join(' ')}' (${describeError(error)})`);
      return null;
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
    // Drain output so the child never blocks on a full pipe.
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});

    this.devServerProcess = child;

    const baseUrl = `http://localhost:${port}`;
    this.log(
      `dev server: '${command} ${args.join(' ')}' (cwd=${projectPath}) — waiting up to ` +
        `${Math.round(startupTimeoutMs / 1000)}s for ${baseUrl}`
    );

    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) {
        this.log(`WARNING: ${exitInfo || 'dev server exited before becoming ready'}`);
        this.devServerProcess = null;
        return null;
      }
      if (await httpResponds(baseUrl)) {
        this.devServerPort = port;
        this.log(`dev server ready on port ${port}`);
        return port;
      }
      await delay(DEV_SERVER_POLL_INTERVAL_MS);
    }

    this.log(`WARNING: dev server did not respond within ${Math.round(startupTimeoutMs / 1000)}s — stopping it`);
    await this.stopDevServer();
    return null;
  }

  /**
   * Launch headless Chromium, navigate to `url`, wait for the page to load AND go network-idle,
   * then capture one full-page screenshot per viewport in `options.viewports` (default
   * {@link DEFAULT_VIEWPORTS}), writing each as `{componentName}-{viewport}-{timestamp}.png` under
   * the resolved storage directory. Returns one {@link ScreenshotResult} per successful capture —
   * a viewport that fails to navigate/capture is logged and skipped, never thrown.
   */
  async captureComponent(url: string, options: ScreenshotOptions): Promise<ScreenshotResult[]> {
    const results: ScreenshotResult[] = [];
    const viewportSpecs = options.viewports && options.viewports.length > 0 ? options.viewports : [...DEFAULT_VIEWPORTS];
    const storageDir = resolveStorageDir(options);

    if (!(await this.isAvailable())) {
      this.log(`WARNING: Playwright unavailable — skipping capture of '${options.componentName}'`);
      return results;
    }

    let pw: typeof import('playwright');
    try {
      pw = await import('playwright');
    } catch (error) {
      this.log(`WARNING: Playwright import failed (${describeError(error)})`);
      return results;
    }

    let browser: import('playwright').Browser;
    try {
      browser = await pw.chromium.launch({ headless: true });
    } catch (error) {
      this.log(`WARNING: Chromium failed to launch (${describeError(error)})`);
      return results;
    }

    try {
      mkdirSync(storageDir, { recursive: true });
    } catch (error) {
      this.log(`WARNING: could not create storage directory '${storageDir}' (${describeError(error)})`);
    }

    const accessibilityScore = computeAccessibilityScore(options.projectPath, options.componentName, this.log);

    try {
      for (const spec of viewportSpecs) {
        const viewport = parseViewportSpec(spec);
        if (!viewport) {
          this.log(`WARNING: skipping unparseable viewport spec '${spec}' (expected '<width>x<height>')`);
          continue;
        }

        let context: import('playwright').BrowserContext | null = null;
        try {
          context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
          const page = await context.newPage();
          await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
          await page.waitForLoadState('networkidle', { timeout: NETWORKIDLE_TIMEOUT_MS }).catch(() => {});

          const timestamp = new Date().toISOString();
          const fileName = `${sanitizeName(options.componentName)}-${spec}-${sanitizeTimestamp(timestamp)}.png`;
          const filePath = join(storageDir, fileName);
          const buffer = await page.screenshot({ fullPage: true });
          writeFileSync(filePath, buffer);

          results.push({
            filePath,
            url,
            viewport: spec,
            componentName: options.componentName,
            timestamp,
            accessibilityScore,
          });
          this.log(`captured '${options.componentName}' at ${spec} → ${filePath}`);
        } catch (error) {
          this.log(`WARNING: capture failed for '${options.componentName}' at ${spec} (${describeError(error)})`);
        } finally {
          if (context) await context.close().catch(() => {});
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }

    return results;
  }

  /**
   * Discover every `page.tsx` under `<projectPath>/src/app`, map each to its URL route (route
   * groups/parallel slots dropped, dynamic segments replaced with a sample value), ensure a dev
   * server is running (starting one via {@link startDevServer} when this instance doesn't already
   * own one), and {@link captureComponent} every route. If this call started the dev server itself,
   * it stops it again before returning; a dev server the caller started earlier (via a prior
   * `startDevServer` call on this same instance) is left running. Degrades to `[]` when no routes
   * are found or the dev server never becomes ready — never throws.
   */
  async captureAllRoutes(projectPath: string, options: ScreenshotOptions): Promise<ScreenshotResult[]> {
    const appDir = join(projectPath, 'src', 'app');
    const routes = discoverAppRoutes(appDir);
    if (routes.length === 0) {
      this.log(`no page.tsx files found under ${appDir} — nothing to capture`);
      return [];
    }
    this.log(`discovered ${routes.length} route(s) under ${appDir}`);

    const alreadyRunning = this.devServerPort !== null;
    const port = alreadyRunning ? this.devServerPort : await this.startDevServer(projectPath);
    if (port === null) {
      this.log('WARNING: dev server did not become ready — skipping route capture');
      return [];
    }

    const baseUrl = `http://localhost:${port}`;
    const allResults: ScreenshotResult[] = [];
    try {
      for (const route of routes) {
        const url = joinUrl(baseUrl, route.path);
        const perRoute = await this.captureComponent(url, { ...options, componentName: route.slug });
        allResults.push(...perRoute);
      }
    } finally {
      if (!alreadyRunning) await this.stopDevServer();
    }

    return allResults;
  }

  /**
   * Kill the dev server process this instance started (if any). Idempotent — safe to call whether
   * or not a server is running, and safe to call twice. On Windows, kills the whole process tree
   * via `taskkill /T /F` (killing `pnpm` alone would orphan the `next dev` child it spawns); on
   * POSIX, sends SIGTERM and escalates to SIGKILL after a grace period. Never throws.
   */
  async stopDevServer(): Promise<void> {
    const child = this.devServerProcess;
    this.devServerProcess = null;
    this.devServerPort = null;
    if (!child) return;

    try {
      if (process.platform === 'win32' && typeof child.pid === 'number') {
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
  }
}

/** Factory matching the house style of `createPlaywrightAxeDriver`/`createUIComponentGenerator`. */
export function createPlaywrightScreenshotter(options: { log?: (message: string) => void } = {}): PlaywrightScreenshotter {
  return new PlaywrightScreenshotter(options);
}

export default PlaywrightScreenshotter;
