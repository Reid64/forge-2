/**
 * FORGE 2.0 — Visual Regression tests (pure `node:test`; no browser, no real disk).
 *
 * Covers: the self-contained PNG codec (encode→decode round-trip), the pixel comparator
 * (identical / changed / dimension-mismatch), `routeSlug`, the `runVisualRegression` lifecycle
 * (first-run baseline capture → pass → regression fail → forced update → driver-unavailable skip)
 * driven with an in-memory filesystem + a fake screenshot driver, and the Phase 4 Sentinel
 * integration (the optional tenth check, opt-in, with an injected visual runner).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runVisualRegression,
  compareImages,
  decodePng,
  encodePng,
  routeSlug,
  type DecodedImage,
  type ScreenshotDriver,
  type ScreenshotResult,
  type VisualFs,
  type VisualRegressionResult,
} from '../src/tools/visual-regression.js';
import { runSentinel } from '../src/phases/phase4-sentinel.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Build a solid-colour RGBA image. */
function solid(width: number, height: number, r: number, g: number, b: number, a = 255): DecodedImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return { width, height, data };
}

/** Paint a rectangular block of a different colour over a copy of `img`. */
function withBlock(img: DecodedImage, w: number, h: number, r: number, g: number, b: number): DecodedImage {
  const data = new Uint8Array(img.data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * img.width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width: img.width, height: img.height, data };
}

/** An in-memory VisualFs. */
function memFs(): VisualFs & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  return {
    store,
    async readFile(path) {
      return store.get(path) ?? null;
    },
    async writeFile(path, data) {
      store.set(path, Buffer.from(data));
      return true;
    },
    async exists(path) {
      return store.has(path);
    },
  };
}

/** A fake driver that returns a fixed PNG per URL (or a not-ok result). */
function fakeDriver(pngByPath: Map<string, Buffer | null>): ScreenshotDriver {
  return {
    async screenshot(req): Promise<ScreenshotResult> {
      // Match on the path suffix of the URL.
      const path = '/' + (req.url.split('/').slice(3).join('/'));
      const png = pngByPath.get(path);
      if (png === undefined) {
        return { ok: false, status: 404, png: null, finalUrl: req.url, error: null };
      }
      if (png === null) {
        return { ok: false, status: null, png: null, finalUrl: req.url, error: 'ECONNREFUSED' };
      }
      return { ok: true, status: 200, png, finalUrl: req.url, error: null };
    },
    async close() {},
  };
}

const PROJECT = '/proj';
const NOW = () => '2026-06-11T00:00:00.000Z';

// ---------------------------------------------------------------------------
// PNG codec
// ---------------------------------------------------------------------------

test('PNG codec: encode→decode round-trips RGBA exactly', () => {
  const img = withBlock(solid(8, 6, 10, 20, 30), 3, 2, 200, 100, 50);
  const decoded = decodePng(encodePng(img));
  assert.equal(decoded.width, 8);
  assert.equal(decoded.height, 6);
  assert.deepEqual(Array.from(decoded.data), Array.from(img.data));
});

test('PNG codec: decode rejects a non-PNG buffer', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')));
});

// ---------------------------------------------------------------------------
// Comparator
// ---------------------------------------------------------------------------

test('compareImages: identical images report zero diff', () => {
  const a = solid(20, 20, 120, 130, 140);
  const cmp = compareImages(a, solid(20, 20, 120, 130, 140));
  assert.equal(cmp.diffPixels, 0);
  assert.equal(cmp.totalPixels, 400);
  assert.equal(cmp.dimensionMismatch, false);
});

test('compareImages: counts changed pixels and paints them red', () => {
  const base = solid(20, 20, 255, 255, 255);
  const changed = withBlock(base, 4, 4, 0, 0, 0); // 16 black pixels of 400
  const cmp = compareImages(base, changed);
  assert.equal(cmp.diffPixels, 16);
  // Top-left pixel should be red in the diff image.
  assert.deepEqual(Array.from(cmp.diffImage.data.slice(0, 4)), [255, 0, 0, 255]);
});

test('compareImages: dimension mismatch is a full mismatch', () => {
  const cmp = compareImages(solid(10, 10, 0, 0, 0), solid(12, 10, 0, 0, 0));
  assert.equal(cmp.dimensionMismatch, true);
  assert.equal(cmp.diffPixels, cmp.totalPixels);
  assert.equal(cmp.totalPixels, 120); // current geometry (12×10)
});

test('routeSlug: filesystem-safe slugs', () => {
  assert.equal(routeSlug('/'), 'root');
  assert.equal(routeSlug('/dashboard/users'), 'dashboard-users');
  assert.equal(routeSlug('/leads?id=1#x'), 'leads');
});

// ---------------------------------------------------------------------------
// runVisualRegression lifecycle
// ---------------------------------------------------------------------------

test('runVisualRegression: first run captures baselines (pass, firstRun)', async () => {
  const fs = memFs();
  const home = encodePng(solid(30, 20, 50, 60, 70));
  const driver = fakeDriver(new Map([['/', home]]));
  const res = await runVisualRegression(
    { projectPath: PROJECT, pages: [{ path: '/' }] },
    { driver, fs, now: NOW }
  );
  assert.equal(res.firstRun, true);
  assert.equal(res.passed, true);
  assert.equal(res.capturedBaselines, 1);
  assert.equal(res.pages[0]?.status, 'baseline_created');
  assert.ok(fs.store.has('/proj/.forge/baselines/root.png'));
});

test('runVisualRegression: identical second run passes', async () => {
  const fs = memFs();
  const home = encodePng(solid(30, 20, 50, 60, 70));
  const driver = fakeDriver(new Map([['/', home]]));
  const opts = { driver, fs, now: NOW };
  await runVisualRegression({ projectPath: PROJECT, pages: [{ path: '/' }] }, opts); // capture
  const res = await runVisualRegression({ projectPath: PROJECT, pages: [{ path: '/' }] }, opts);
  assert.equal(res.firstRun, false);
  assert.equal(res.passed, true);
  assert.equal(res.comparedPages, 1);
  assert.equal(res.pages[0]?.status, 'pass');
  assert.equal(res.pages[0]?.diffPercentage, 0);
});

test('runVisualRegression: a >5% change is flagged as a regression', async () => {
  const fs = memFs();
  const base = solid(40, 40, 255, 255, 255); // 1600 px
  fs.store.set('/proj/.forge/baselines/dashboard.png', encodePng(base));
  // Change a 16×16 block (256 px = 16% > 5%).
  const changed = encodePng(withBlock(base, 16, 16, 0, 0, 0));
  const driver = fakeDriver(new Map([['/dashboard', changed]]));
  const res = await runVisualRegression(
    { projectPath: PROJECT, pages: [{ path: '/dashboard' }], thresholdPercent: 5 },
    { driver, fs, now: NOW }
  );
  assert.equal(res.passed, false);
  assert.equal(res.regressions.length, 1);
  const page = res.pages[0];
  assert.equal(page?.status, 'fail');
  assert.ok((page?.diffPercentage ?? 0) > 5);
  assert.ok(page?.diffImagePath && fs.store.has(page.diffImagePath));
});

test('runVisualRegression: updateBaselines re-captures instead of comparing', async () => {
  const fs = memFs();
  fs.store.set('/proj/.forge/baselines/dashboard.png', encodePng(solid(40, 40, 255, 255, 255)));
  const newShot = encodePng(solid(40, 40, 0, 0, 0)); // wildly different, but we force-update
  const driver = fakeDriver(new Map([['/dashboard', newShot]]));
  const res = await runVisualRegression(
    { projectPath: PROJECT, pages: [{ path: '/dashboard' }], updateBaselines: true },
    { driver, fs, now: NOW }
  );
  assert.equal(res.passed, true);
  assert.equal(res.pages[0]?.status, 'baseline_created');
  assert.deepEqual(fs.store.get('/proj/.forge/baselines/dashboard.png'), Buffer.from(newShot));
});

test('runVisualRegression: unreachable route is skipped, not failed', async () => {
  const fs = memFs();
  const driver = fakeDriver(new Map([['/', null]])); // connection refused
  const res = await runVisualRegression({ projectPath: PROJECT, pages: [{ path: '/' }] }, { driver, fs, now: NOW });
  assert.equal(res.passed, true); // a skip is not a regression
  assert.equal(res.pages[0]?.status, 'skipped');
  assert.equal(res.unreachablePages, 1);
});

test('runVisualRegression: no driver available → every page skipped', async () => {
  const res = await runVisualRegression(
    { projectPath: PROJECT, pages: [{ path: '/' }] },
    { createDriver: async () => null, fs: memFs(), now: NOW }
  );
  assert.equal(res.driverAvailable, false);
  assert.equal(res.pages[0]?.status, 'skipped');
});

// ---------------------------------------------------------------------------
// Phase 4 Sentinel integration (optional tenth check)
// ---------------------------------------------------------------------------

/** Minimal Sentinel options whose nine mandatory checks all pass or skip, so we can isolate check 10. */
function passingSentinelOptions(): Parameters<typeof runSentinel>[0] {
  return {
    projectPath: PROJECT,
    runCommand: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    // A productive change, so the mandatory File Delta check (the "produced a real work product"
    // signal) passes rather than falling through to a real git lookup against a fixture path.
    getFileChanges: async () => [{ status: 'A', path: 'src/new.ts' }],
    schemaPromptsHaveRun: false,
    packageJsonContent: '{"dependencies":{}}',
    baselineDependencies: [],
    log: () => {},
  };
}

test('Sentinel: no visualRegression config keeps exactly the nine mandatory checks', async () => {
  const result = await runSentinel(passingSentinelOptions());
  assert.equal(result.checks.length, 9);
  assert.equal(result.checks.find((c) => c.name === 'visual_regression'), undefined);
});

test('Sentinel: a visual regression fails the gate as the tenth check', async () => {
  const failing: VisualRegressionResult = {
    passed: false,
    firstRun: false,
    driverAvailable: true,
    regressions: [
      {
        path: '/dashboard',
        status: 'fail',
        passed: false,
        diffPercentage: 12.5,
        baselinePath: '/proj/.forge/baselines/dashboard.png',
        currentPath: '/proj/.forge/diffs/dashboard.current.png',
        diffImagePath: '/proj/.forge/diffs/dashboard.diff.png',
        width: 40,
        height: 40,
        diffPixels: 200,
        totalPixels: 1600,
        detail: '12.50% differing pixels exceeds 5% threshold',
      },
    ],
    pages: [],
    capturedBaselines: 0,
    comparedPages: 1,
    unreachablePages: 0,
    errorPages: 0,
    thresholdPercent: 5,
    baselineDir: '/proj/.forge/baselines',
    diffDir: '/proj/.forge/diffs',
    baseUrl: 'http://localhost:3000',
    report: '# vr',
    generatedAt: NOW(),
  };
  failing.pages = [...failing.regressions];

  const result = await runSentinel({
    ...passingSentinelOptions(),
    visualRegression: { pages: [{ path: '/dashboard' }] },
    uiPromptJustRan: true,
    runVisualCheck: async () => failing,
  });

  assert.equal(result.checks.length, 10);
  assert.equal(result.passed, false);
  assert.equal(result.failedCheck, 'visual_regression');
  assert.match(result.diagnosticReport, /UI regression/);
});

test('Sentinel: uiPromptJustRan=false suppresses the visual check', async () => {
  let called = false;
  const result = await runSentinel({
    ...passingSentinelOptions(),
    visualRegression: { pages: [{ path: '/dashboard' }] },
    uiPromptJustRan: false,
    runVisualCheck: async () => {
      called = true;
      throw new Error('should not be called');
    },
  });
  assert.equal(called, false);
  assert.equal(result.checks.length, 9);
  assert.equal(result.passed, true);
});
