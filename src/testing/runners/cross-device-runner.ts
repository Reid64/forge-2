// FORGE 2.0 — Enterprise Test Suite: CROSS_DEVICE runner (mobile/tablet viewport compatibility).
//
// "Live preview URL" mechanism: reuses idempotency-runner.ts's/cross-browser-runner.ts's own-
// throwaway-dev-server convention verbatim (own dedicated port, `pnpm dev --port <port>`, poll
// until ready, always kill afterward). Next free port after cross-browser's 3102: this runner
// uses 3103.
//
// SIMPLIFYING ASSUMPTIONS (T1 — never fabricate a check the target project didn't declare):
//   1. Device emulation uses Playwright's own built-in device-descriptor registry (`devices`) —
//      the same descriptors (viewport, user-agent, device-scale-factor, touch support) Playwright
//      ships and maintains, not FORGE-invented values. No existing driver in this codebase uses
//      Playwright's `devices` registry (only cross-browser-runner.ts's multi-ENGINE probe is a
//      sibling; every other driver — screenshotter.ts, visual-regression.ts, etc. — is a single
//      fixed desktop Chromium viewport).
//   2. What is checkable without app-specific knowledge: does the app's root route ('/') load
//      cleanly on each device profile, AND does it avoid horizontal overflow — `scrollWidth`
//      exceeding the device's own viewport `clientWidth` is a well-known, purely structural
//      responsive-design defect signal (a fixed-width element breaking out of a narrow viewport),
//      checkable with zero knowledge of the target app's actual content or intended layout.
//   3. Three representative profiles are probed — one phone, one tablet, one small laptop — rather
//      than every device Playwright knows about, to keep this a fast per-prompt-scale check rather
//      than an exhaustive device farm.
//
// Outcome policy:
//   - No package.json / no `pnpm dev` script -> SKIPPED (nothing to boot).
//   - Dev server never becomes ready -> SKIPPED (T1 — cannot probe what isn't reachable).
//   - `playwright` not installed -> SKIPPED.
//   - Any profile that fails to load '/' cleanly, or shows horizontal overflow -> FAILED, naming
//     the profile(s) that failed.
//   - All profiles load cleanly with no horizontal overflow -> PASSED.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

const CROSS_DEVICE_DEV_PORT = 3103;
const DEV_SERVER_READY_TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 15_000;

/** Playwright's own built-in device-descriptor names — one phone, one tablet, one small laptop. */
const DEVICE_PROFILES = ['iPhone 13', 'iPad (gen 7)', 'Pixel 5'] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mirrors idempotency-runner.ts's/cross-browser-runner.ts's own (non-exported) `waitForDevServer`. */
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
    log(`cross-device: waiting for dev server at ${url}…`);
  }
  return false;
}

function killChildProcess(proc: ChildProcess | null, log: (m: string) => void): void {
  if (!proc) return;
  try {
    if (!proc.killed) proc.kill('SIGTERM');
  } catch (err) {
    log(`WARNING: cross-device-runner — could not kill dev server (${err instanceof Error ? err.message : String(err)})`);
  }
}

interface ProfileResult {
  profile: string;
  outcome: 'passed' | 'failed';
  detail: string;
}

async function probeProfile(
  browser: import('playwright').Browser,
  deviceDescriptor: Record<string, unknown>,
  profile: string,
  url: string
): Promise<ProfileResult> {
  const context = await browser.newContext({ ...deviceDescriptor });
  try {
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    let response: import('playwright').Response | null = null;
    try {
      response = await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'load' });
    } catch (err) {
      return { profile, outcome: 'failed', detail: `navigation failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!response || !response.ok()) {
      return { profile, outcome: 'failed', detail: `final response ${response?.status() ?? 'none'} for ${url}` };
    }
    if (pageErrors.length > 0) {
      return { profile, outcome: 'failed', detail: `uncaught page error(s): ${pageErrors.slice(0, 3).join(' | ')}` };
    }
    // A string, not a typed closure: this runs inside the browser page (Playwright serializes and
    // executes it there), where `document` is real — but this file compiles under Node's `lib`
    // (no DOM), so a typed arrow function referencing `document` would not type-check. Same
    // convention as seo-validator.ts's in-page extractor script.
    const overflow = (await page.evaluate(
      'JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })'
    )) as string;
    const { scrollWidth, clientWidth } = JSON.parse(overflow) as { scrollWidth: number; clientWidth: number };
    if (scrollWidth > clientWidth + 1) {
      return {
        profile,
        outcome: 'failed',
        detail: `horizontal overflow: content ${scrollWidth}px wide vs. ${clientWidth}px viewport`,
      };
    }
    return { profile, outcome: 'passed', detail: `${url} loaded cleanly, no horizontal overflow (${clientWidth}px viewport)` };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  const runner = 'cross-device';
  const devUrl = `http://localhost:${CROSS_DEVICE_DEV_PORT}`;

  if (!existsSync(join(input.projectPath, 'package.json'))) {
    return skippedOutcome(runner, 'no package.json in target project — nothing to boot — cross-device runner SKIPPED');
  }

  let pw: typeof import('playwright');
  try {
    pw = await import('playwright');
  } catch {
    return skippedOutcome(runner, "'playwright' is not installed in the target project — cross-device runner SKIPPED");
  }

  let devServer: ChildProcess | null = null;
  try {
    devServer = spawn('pnpm', ['dev', '--port', String(CROSS_DEVICE_DEV_PORT)], {
      cwd: input.projectPath,
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  } catch (err) {
    return skippedOutcome(runner, `dev server could not be spawned (${err instanceof Error ? err.message : String(err)}) — cross-device runner SKIPPED`);
  }

  let browser: import('playwright').Browser | null = null;
  try {
    input.log(`cross-device: starting dev server on port ${CROSS_DEVICE_DEV_PORT}`);
    const ready = await waitForDevServer(devUrl, DEV_SERVER_READY_TIMEOUT_MS, input.log);
    if (!ready) {
      return skippedOutcome(runner, `dev server on port ${CROSS_DEVICE_DEV_PORT} did not become ready within ${DEV_SERVER_READY_TIMEOUT_MS}ms — cross-device runner SKIPPED`);
    }

    try {
      browser = await pw.chromium.launch({ headless: true });
    } catch (err) {
      return skippedOutcome(runner, `chromium browser binary unavailable (${err instanceof Error ? err.message : String(err)}) — run 'npx playwright install' — cross-device runner SKIPPED`);
    }

    const results: ProfileResult[] = [];
    for (const profile of DEVICE_PROFILES) {
      const descriptor = pw.devices[profile];
      if (!descriptor) {
        input.log(`cross-device: WARNING — Playwright has no device descriptor named '${profile}' in this version, skipping it`);
        continue;
      }
      input.log(`cross-device: probing ${profile}`);
      results.push(await probeProfile(browser, descriptor, profile, devUrl));
    }

    const durationMs = Date.now() - started;
    if (results.length === 0) {
      return skippedOutcome(runner, 'none of the configured device profiles exist in this Playwright version — cross-device runner SKIPPED');
    }

    const failed = results.filter((r) => r.outcome === 'failed');
    const failures: RunnerFailure[] = failed.map((r) => ({ name: r.profile, message: r.detail, file: '/' }));
    const status: RunnerOutcome['status'] = failed.length > 0 ? 'failed' : 'passed';
    return {
      runner,
      status,
      testsTotal: results.length,
      testsPassed: results.length - failed.length,
      testsFailed: failed.length,
      testsSkipped: 0,
      durationMs,
      failures,
      reportPath: null,
      exitCode: null,
      detail:
        status === 'passed'
          ? `${results.map((r) => r.profile).join(', ')} all loaded '/' cleanly with no horizontal overflow`
          : `${failed.map((r) => `${r.profile}: ${r.detail}`).join(' | ')}`,
      coverage: null,
    };
  } catch (error) {
    return errorOutcome(runner, `cross-device probe threw: ${error instanceof Error ? error.message : String(error)}`, Date.now() - started);
  } finally {
    await browser?.close().catch(() => {});
    killChildProcess(devServer, input.log);
  }
}
