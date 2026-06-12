/**
 * FORGE 2.0 — Live Preview Gate tests (pure `node:test`; no `pnpm`, no server, no browser, no disk).
 *
 * Covers: the `.tsx`/`.css` UI-change trigger (`hasUiFileChanges`), dynamic-segment substitution
 * (`concreteUrlPath`), `routeSlug`, the `runLivePreviewGate` lifecycle (all-pass → blank/console/non-200
 * fails → dynamic-route best-effort skip → dev-server-not-ready skip → no-driver skip → no-UI-change
 * no-op) driven with an injected dev-server starter + fake browser driver + in-memory fs (asserting the
 * server is always stopped), and the Phase 4 Sentinel integration (the optional seventh check, opt-in,
 * with an injected live-preview runner).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runLivePreviewGate,
  hasUiFileChanges,
  concreteUrlPath,
  routeSlug,
  type PreviewDriver,
  type PreviewProbe,
  type PreviewProbeRequest,
  type PreviewRouteSpec,
  type PreviewServerHandle,
  type DevServerStarter,
  type PreviewFs,
} from '../src/tools/live-preview-gate.js';
import { runSentinel, type CommandResult } from '../src/phases/phase4-sentinel.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A PreviewProbe with sensible defaults, overridable per field. */
function probe(overrides: Partial<PreviewProbe>): PreviewProbe {
  return {
    ok: true,
    status: 200,
    finalUrl: 'http://localhost:3000/',
    bodyTextLength: 500,
    consoleErrors: [],
    pageErrors: [],
    screenshot: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    error: null,
    ...overrides,
  };
}

/** A fake driver: maps url path → probe; records which urls were visited and whether it closed. */
function fakeDriver(byPath: Record<string, PreviewProbe>): PreviewDriver & { visited: string[]; closed: boolean } {
  const state = { visited: [] as string[], closed: false };
  return {
    visited: state.visited,
    get closed() {
      return state.closed;
    },
    async probe(req: PreviewProbeRequest): Promise<PreviewProbe> {
      state.visited.push(req.url);
      const path = new URL(req.url).pathname;
      return byPath[path] ?? probe({ status: 404, ok: false, bodyTextLength: 0 });
    },
    async close() {
      state.closed = true;
    },
  };
}

/** A starter that reports the server ready and records a stop() call. */
function readyStarter(stopFlag: { stopped: boolean }): DevServerStarter {
  return async () => {
    const handle: PreviewServerHandle = {
      async stop() {
        stopFlag.stopped = true;
      },
    };
    return { ready: true, handle, detail: 'ready (fake)' };
  };
}

/** An in-memory PreviewFs. */
function memFs(): PreviewFs & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  return {
    store,
    async writeFile(path, data) {
      store.set(path, Buffer.from(data));
      return true;
    },
  };
}

const silent = (): void => {};
const ROUTES: PreviewRouteSpec[] = [
  { path: '/', name: 'home' },
  { path: '/dashboard', name: 'dashboard' },
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('hasUiFileChanges detects .tsx/.css and ignores others', () => {
  assert.equal(hasUiFileChanges(['src/app/page.tsx']), true);
  assert.equal(hasUiFileChanges(['styles/globals.css']), true);
  assert.equal(hasUiFileChanges(['src\\app\\Page.TSX']), true); // win sep + case-insensitive
  assert.equal(hasUiFileChanges(['src/lib/util.ts', 'README.md']), false);
  assert.equal(hasUiFileChanges([]), false);
  assert.equal(hasUiFileChanges(undefined), false);
});

test('concreteUrlPath substitutes dynamic/catch-all segments', () => {
  assert.equal(concreteUrlPath('/dashboard'), '/dashboard');
  assert.equal(concreteUrlPath('/users/:id'), '/users/1');
  assert.equal(concreteUrlPath('/blog/*slug'), '/blog/sample');
});

test('routeSlug is filesystem-safe and maps root to "root"', () => {
  assert.equal(routeSlug('/'), 'root');
  assert.equal(routeSlug('/dashboard/users'), 'dashboard-users');
  assert.equal(routeSlug('/users/:id'), 'users-id');
});

// ---------------------------------------------------------------------------
// runLivePreviewGate lifecycle
// ---------------------------------------------------------------------------

test('all routes render → PASS, screenshots written, server + browser closed', async () => {
  const stop = { stopped: false };
  const fs = memFs();
  const driver = fakeDriver({
    '/': probe({ bodyTextLength: 300 }),
    '/dashboard': probe({ bodyTextLength: 1200 }),
  });
  const result = await runLivePreviewGate(
    { projectPath: '/proj', routes: ROUTES },
    { driver, fs, startDevServer: readyStarter(stop), log: silent }
  );

  assert.equal(result.passed, true);
  assert.equal(result.ran, true);
  assert.equal(result.devServerStarted, true);
  assert.equal(result.passedPages, 2);
  assert.equal(result.failedPages, 0);
  assert.equal(result.pages.every((p) => p.status === 'pass'), true);
  assert.equal(fs.store.size, 2); // one screenshot per route
  assert.equal(stop.stopped, true); // dev server killed
  assert.equal(driver.closed, true);
});

test('blank page, console error, and non-200 each FAIL the gate', async () => {
  const stop = { stopped: false };
  const driver = fakeDriver({
    '/': probe({ bodyTextLength: 10 }), // blank (≤ 50)
    '/dashboard': probe({ consoleErrors: ['Uncaught TypeError: x is not a function'] }),
    '/settings': probe({ status: 500, ok: false }),
  });
  const routes: PreviewRouteSpec[] = [{ path: '/' }, { path: '/dashboard' }, { path: '/settings' }];
  const result = await runLivePreviewGate(
    { projectPath: '/proj', routes },
    { driver, fs: memFs(), startDevServer: readyStarter(stop), log: silent }
  );

  assert.equal(result.passed, false);
  assert.equal(result.failedPages, 3);
  const blank = result.pages.find((p) => p.path === '/');
  assert.match(blank?.detail ?? '', /blank page/);
  const errs = result.pages.find((p) => p.path === '/dashboard');
  assert.match(errs?.detail ?? '', /console\/page error/);
  const status = result.pages.find((p) => p.path === '/settings');
  assert.match(status?.detail ?? '', /HTTP 500/);
  assert.equal(stop.stopped, true);
});

test('dynamic route returning non-200 is SKIPPED (sample param), not failed', async () => {
  const driver = fakeDriver({
    '/users/1': probe({ status: 404, ok: false, bodyTextLength: 800 }),
  });
  const result = await runLivePreviewGate(
    { projectPath: '/proj', routes: [{ path: '/users/:id', dynamic: true }] },
    { driver, fs: memFs(), startDevServer: readyStarter({ stopped: false }), log: silent }
  );
  assert.equal(result.passed, true); // a dynamic 404 does not fail the gate
  assert.equal(result.pages[0]?.status, 'skipped');
  assert.equal(driver.visited[0], 'http://localhost:3000/users/1');
});

test('dynamic route with console error STILL fails (a real defect)', async () => {
  const driver = fakeDriver({ '/users/1': probe({ consoleErrors: ['boom'] }) });
  const result = await runLivePreviewGate(
    { projectPath: '/proj', routes: [{ path: '/users/:id', dynamic: true }] },
    { driver, fs: memFs(), startDevServer: readyStarter({ stopped: false }), log: silent }
  );
  assert.equal(result.passed, false);
  assert.equal(result.pages[0]?.status, 'fail');
});

test('dev server never ready → every route SKIPPED, not failed', async () => {
  const notReady: DevServerStarter = async () => ({ ready: false, handle: { async stop() {} }, detail: 'timeout' });
  const result = await runLivePreviewGate(
    { projectPath: '/proj', routes: ROUTES },
    { driver: fakeDriver({}), fs: memFs(), startDevServer: notReady, log: silent }
  );
  assert.equal(result.passed, true);
  assert.equal(result.ran, false);
  assert.equal(result.devServerStarted, false);
  assert.equal(result.skippedPages, 2);
  assert.equal(result.pages.every((p) => p.status === 'skipped'), true);
});

test('no browser driver → every route SKIPPED and server stopped', async () => {
  const stop = { stopped: false };
  const result = await runLivePreviewGate(
    { projectPath: '/proj', routes: ROUTES },
    { createDriver: async () => null, fs: memFs(), startDevServer: readyStarter(stop), log: silent }
  );
  assert.equal(result.driverAvailable, false);
  assert.equal(result.devServerStarted, true);
  assert.equal(result.skippedPages, 2);
  assert.equal(stop.stopped, true);
});

test('changedFiles without a UI file → no-op (gate not triggered)', async () => {
  let started = false;
  const result = await runLivePreviewGate(
    { projectPath: '/proj', routes: ROUTES, changedFiles: ['src/lib/db.ts', 'queue.yaml'] },
    {
      driver: fakeDriver({}),
      fs: memFs(),
      startDevServer: async () => {
        started = true;
        return { ready: true, handle: { async stop() {} }, detail: '' };
      },
      log: silent,
    }
  );
  assert.equal(result.ran, false);
  assert.equal(result.pages.length, 0);
  assert.equal(started, false); // never even booted the server
});

test('discovers routes via injected discoverRoutes when none supplied', async () => {
  const driver = fakeDriver({ '/': probe({}) });
  const result = await runLivePreviewGate(
    { projectPath: '/proj' },
    {
      discoverRoutes: async () => [{ path: '/', name: 'app/page.tsx' }],
      driver,
      fs: memFs(),
      startDevServer: readyStarter({ stopped: false }),
      log: silent,
    }
  );
  assert.equal(result.ran, true);
  assert.equal(result.pages.length, 1);
  assert.equal(result.passedPages, 1);
});

// ---------------------------------------------------------------------------
// Phase 4 Sentinel integration (optional seventh check)
// ---------------------------------------------------------------------------

/** A command runner that passes tsc + build (so the gate reaches the optional checks). */
const passingRun = async (): Promise<CommandResult> => ({ ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false });

test('Sentinel: no livePreview config → exactly the five Contract-13 checks', async () => {
  const result = await runSentinel({
    projectPath: '/proj',
    runCommand: passingRun,
    getFileChanges: async () => [{ status: 'M', path: 'src/app/page.tsx' }],
    log: silent,
  });
  assert.equal(result.checks.length, 5);
  assert.equal(result.checks.some((c) => c.name === 'live_preview'), false);
});

test('Sentinel: livePreview runs after a .tsx change and a failing preview fails the gate', async () => {
  const result = await runSentinel({
    projectPath: '/proj',
    runCommand: passingRun,
    getFileChanges: async () => [{ status: 'M', path: 'src/app/dashboard/page.tsx' }],
    livePreview: { routes: [{ path: '/dashboard' }] },
    uiPromptJustRan: true,
    runLivePreviewCheck: async () => ({
      passed: false,
      ran: true,
      devServerStarted: true,
      driverAvailable: true,
      failures: [
        {
          path: '/dashboard',
          url: 'http://localhost:3000/dashboard',
          status: 'fail',
          passed: false,
          httpStatus: 200,
          bodyTextLength: 4,
          consoleErrors: [],
          screenshotPath: null,
          dynamic: false,
          detail: 'blank page (body innerText length 4 ≤ 50)',
        },
      ],
      pages: [
        {
          path: '/dashboard',
          url: 'http://localhost:3000/dashboard',
          status: 'fail',
          passed: false,
          httpStatus: 200,
          bodyTextLength: 4,
          consoleErrors: [],
          screenshotPath: null,
          dynamic: false,
          detail: 'blank page (body innerText length 4 ≤ 50)',
        },
      ],
      passedPages: 0,
      failedPages: 1,
      skippedPages: 0,
      baseUrl: 'http://localhost:3000',
      screenshotDir: '/proj/.forge/preview',
      report: '',
      generatedAt: '2026-06-11T00:00:00.000Z',
    }),
    log: silent,
  });

  const lp = result.checks.find((c) => c.name === 'live_preview');
  assert.ok(lp, 'live_preview check present');
  assert.equal(lp?.passed, false);
  assert.equal(result.passed, false);
  assert.equal(result.failedCheck, 'live_preview');
});

test('Sentinel: livePreview NOT triggered when no .tsx/.css changed', async () => {
  let ran = false;
  const result = await runSentinel({
    projectPath: '/proj',
    runCommand: passingRun,
    getFileChanges: async () => [{ status: 'M', path: 'src/lib/util.ts' }],
    livePreview: { routes: [{ path: '/' }] },
    uiPromptJustRan: true,
    runLivePreviewCheck: async () => {
      ran = true;
      throw new Error('should not be called');
    },
    log: silent,
  });
  assert.equal(ran, false);
  assert.equal(result.checks.some((c) => c.name === 'live_preview'), false);
});
