// FORGE 2.0 — Enterprise Test Suite: CROSS_BROWSER runner (Chromium/Firefox/WebKit compatibility).
//
// "Live preview URL" mechanism: reuses idempotency-runner.ts's/chaos-runner.ts's own-throwaway-
// dev-server convention verbatim (own dedicated port, `pnpm dev --port <port>`, poll until ready,
// always kill afterward) — see chaos-runner.ts's module doc comment for why there is no existing
// preview-URL-injection mechanism anywhere in this codebase to reuse instead. Next free port after
// idempotency's 3100/concurrency's 3101: this runner uses 3102.
//
// SIMPLIFYING ASSUMPTIONS (T1 — never fabricate a check the target project didn't declare):
//   1. Every existing Playwright driver in this codebase (screenshotter.ts, visual-regression.ts,
//      accessibility-auditor.ts, seo-validator.ts, live-preview-gate.ts, six-laws-verifier.ts) only
//      ever launches Chromium — none exercise Firefox/WebKit. This is the first runner to do so.
//   2. What is checkable without app-specific knowledge: does the app's root route ('/') load and
//      render WITHOUT a page crash or an uncaught JS exception in each of the three engines. This
//      is a real, meaningful cross-browser compatibility signal (a component using a
//      Chromium-only API, for instance, throws a `pageerror` in Firefox/WebKit but not Chromium) —
//      it is not full visual-parity checking (that's visual-regression.ts's job, Chromium-only by
//      design) or feature-level behavioral testing (that's e2e-runner.ts's job).
//   3. No routes discovered/declared beyond '/' are probed — inventing a route list here would
//      violate T1 the same way idempotency-runner.ts's write-endpoint discovery is scoped to avoid.
//
// Outcome policy:
//   - No package.json / no `pnpm dev` script -> SKIPPED (nothing to boot).
//   - Dev server never becomes ready -> SKIPPED (T1 — cannot probe what isn't reachable).
//   - `playwright` not installed, or a given engine's browser binary is missing -> that engine is
//     recorded as skipped-per-engine; if ALL THREE engines are unavailable, the whole runner SKIPs.
//   - Any engine that loads '/' with a non-2xx/3xx final response, throws a `pageerror`, or crashes
//     -> FAILED, naming the engine(s) that failed.
//   - All available engines load cleanly -> PASSED.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

const CROSS_BROWSER_DEV_PORT = 3102;
const DEV_SERVER_READY_TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 15_000;

const ENGINES = ['chromium', 'firefox', 'webkit'] as const;
type EngineName = (typeof ENGINES)[number];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mirrors idempotency-runner.ts's/chaos-runner.ts's own (non-exported) `waitForDevServer`. */
async function waitForDevServer(url: string, timeoutMs: number, log: (m: string) => void): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const POLL_MS = 1000;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.status < 500) return true;
    } catch {
      // Not ready yet — swallow and poll again.
    }
    await sleep(POLL_MS);
    log(`cross-browser: waiting for dev server at ${url}…`);
  }
  return false;
}

function killChildProcess(proc: ChildProcess | null, log: (m: string) => void): void {
  if (!proc) return;
  try {
    if (!proc.killed) proc.kill('SIGTERM');
  } catch (err) {
    log(`WARNING: cross-browser-runner — could not kill dev server (${err instanceof Error ? err.message : String(err)})`);
  }
}

interface EngineResult {
  engine: EngineName;
  outcome: 'passed' | 'failed' | 'unavailable';
  detail: string;
}

async function probeEngine(pw: typeof import('playwright'), engine: EngineName, url: string): Promise<EngineResult> {
  const launcher = pw[engine];
  let browser: import('playwright').Browser;
  try {
    browser = await launcher.launch({ headless: true });
  } catch (err) {
    return { engine, outcome: 'unavailable', detail: `${engine} browser binary unavailable (${err instanceof Error ? err.message : String(err)})` };
  }
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    let response: import('playwright').Response | null = null;
    try {
      response = await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'load' });
    } catch (err) {
      return { engine, outcome: 'failed', detail: `navigation failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!response || !response.ok()) {
      return { engine, outcome: 'failed', detail: `final response ${response?.status() ?? 'none'} for ${url}` };
    }
    if (pageErrors.length > 0) {
      return { engine, outcome: 'failed', detail: `uncaught page error(s): ${pageErrors.slice(0, 3).join(' | ')}` };
    }
    return { engine, outcome: 'passed', detail: `${url} loaded cleanly (${response.status()})` };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  const runner = 'cross-browser';
  const devUrl = `http://localhost:${CROSS_BROWSER_DEV_PORT}`;

  if (!existsSync(join(input.projectPath, 'package.json'))) {
    return skippedOutcome(runner, 'no package.json in target project — nothing to boot — cross-browser runner SKIPPED');
  }

  let pw: typeof import('playwright');
  try {
    pw = await import('playwright');
  } catch {
    return skippedOutcome(runner, "'playwright' is not installed in the target project — cross-browser runner SKIPPED");
  }

  let devServer: ChildProcess | null = null;
  try {
    devServer = spawn('pnpm', ['dev', '--port', String(CROSS_BROWSER_DEV_PORT)], {
      cwd: input.projectPath,
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  } catch (err) {
    return skippedOutcome(runner, `dev server could not be spawned (${err instanceof Error ? err.message : String(err)}) — cross-browser runner SKIPPED`);
  }

  try {
    input.log(`cross-browser: starting dev server on port ${CROSS_BROWSER_DEV_PORT}`);
    const ready = await waitForDevServer(devUrl, DEV_SERVER_READY_TIMEOUT_MS, input.log);
    if (!ready) {
      return skippedOutcome(runner, `dev server on port ${CROSS_BROWSER_DEV_PORT} did not become ready within ${DEV_SERVER_READY_TIMEOUT_MS}ms — cross-browser runner SKIPPED`);
    }

    const results: EngineResult[] = [];
    for (const engine of ENGINES) {
      input.log(`cross-browser: probing ${engine}`);
      results.push(await probeEngine(pw, engine, devUrl));
    }

    const durationMs = Date.now() - started;
    const available = results.filter((r) => r.outcome !== 'unavailable');
    if (available.length === 0) {
      return skippedOutcome(runner, `no engine binaries available (${results.map((r) => r.detail).join('; ')}) — run 'npx playwright install' — cross-browser runner SKIPPED`);
    }

    const failed = available.filter((r) => r.outcome === 'failed');
    const failures: RunnerFailure[] = failed.map((r) => ({ name: r.engine, message: r.detail, file: '/' }));
    const status: RunnerOutcome['status'] = failed.length > 0 ? 'failed' : 'passed';
    return {
      runner,
      status,
      testsTotal: available.length,
      testsPassed: available.length - failed.length,
      testsFailed: failed.length,
      testsSkipped: results.length - available.length,
      durationMs,
      failures,
      reportPath: null,
      exitCode: null,
      detail:
        status === 'passed'
          ? `${available.map((r) => r.engine).join(', ')} all loaded '/' cleanly`
          : `${failed.map((r) => `${r.engine}: ${r.detail}`).join(' | ')}`,
      coverage: null,
    };
  } catch (error) {
    return errorOutcome(runner, `cross-browser probe threw: ${error instanceof Error ? error.message : String(error)}`, Date.now() - started);
  } finally {
    killChildProcess(devServer, input.log);
  }
}
