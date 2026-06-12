/**
 * FORGE 2.0 — Accessibility Auditor tests (pure `node:test`; no `pnpm`, no server, no browser, no
 * axe-core, no DB).
 *
 * Covers: the impact→severity map (`mapImpact`), the rule→category map (`categoryForRule`), violation
 * normalization + node/HTML clipping (`normalizeViolation`), severity tally (`countSeverities`), the
 * injected axe run-script (`buildAxeRunScript` carries the WCAG tags + the synthetic keyboard rule),
 * the `runAccessibilityAudit` lifecycle (clean → non-critical-surfaced → critical-blocks → dynamic-route
 * skip → server-not-ready skip → no-driver skip → no-UI-change no-op → startServer:false) driven with an
 * injected dev-server starter + fake axe driver + injected Build-Memory store (asserting the server is
 * always stopped and the result is stored only when something was audited), and the Phase 4 Sentinel
 * integration (the optional ninth check, opt-in, with an injected accessibility runner).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runAccessibilityAudit,
  mapImpact,
  categoryForRule,
  normalizeViolation,
  countSeverities,
  buildAxeRunScript,
  WCAG_21_AA_TAGS,
  KEYBOARD_TABINDEX_RULE,
  type A11yDriver,
  type A11yProbe,
  type A11yProbeRequest,
  type A11yRouteSpec,
  type A11yStoredRecord,
  type RawAxeViolation,
  type AccessibilityReport,
} from '../src/tools/accessibility-auditor.js';
import { runSentinel, type CommandResult } from '../src/phases/phase4-sentinel.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A raw axe violation with sensible defaults, overridable per field. */
function rawViolation(overrides: Partial<RawAxeViolation>): RawAxeViolation {
  return {
    id: 'image-alt',
    impact: 'critical',
    description: 'Images must have alternate text',
    help: 'Add an alt attribute',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/image-alt',
    tags: ['wcag2a', 'wcag111', 'cat.text-alternatives'],
    nodes: [{ target: ['img'], html: '<img src="x.png">', failureSummary: 'Element has no alt text' }],
    ...overrides,
  };
}

/** An A11yProbe with sensible defaults. */
function probe(overrides: Partial<A11yProbe>): A11yProbe {
  return {
    ok: true,
    status: 200,
    finalUrl: 'http://localhost:3000/',
    violations: [],
    error: null,
    ...overrides,
  };
}

/** A fake driver: maps url path → probe; records visited urls and whether it closed. */
function fakeDriver(byPath: Record<string, A11yProbe>): A11yDriver & { visited: string[]; closed: boolean } {
  const state = { visited: [] as string[], closed: false };
  return {
    visited: state.visited,
    get closed() {
      return state.closed;
    },
    async audit(req: A11yProbeRequest): Promise<A11yProbe> {
      state.visited.push(req.url);
      const path = new URL(req.url).pathname;
      return byPath[path] ?? probe({ ok: false, status: 404 });
    },
    async close() {
      state.closed = true;
    },
  };
}

/** A starter that reports the server ready and records a stop() call. */
function readyStarter(stopFlag: { stopped: boolean }) {
  return async () => ({
    ready: true,
    handle: {
      async stop() {
        stopFlag.stopped = true;
      },
    },
    detail: 'ready (fake)',
  });
}

/** A capturing Build-Memory store. */
function memStore(): { calls: A11yStoredRecord[]; store: (r: A11yStoredRecord) => Promise<void> } {
  const calls: A11yStoredRecord[] = [];
  return { calls, store: async (r) => void calls.push(r) };
}

const silent = (): void => {};
const ROUTES: A11yRouteSpec[] = [
  { path: '/', name: 'home' },
  { path: '/dashboard', name: 'dashboard' },
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('mapImpact maps the axe impact scale and defaults null→moderate', () => {
  assert.equal(mapImpact('critical'), 'critical');
  assert.equal(mapImpact('serious'), 'serious');
  assert.equal(mapImpact('moderate'), 'moderate');
  assert.equal(mapImpact('minor'), 'minor');
  assert.equal(mapImpact(null), 'moderate');
  assert.equal(mapImpact(undefined), 'moderate');
  assert.equal(mapImpact('weird'), 'moderate');
});

test('categoryForRule maps the eight required checks and buckets the rest', () => {
  assert.equal(categoryForRule('image-alt'), 'missing alt text');
  assert.equal(categoryForRule('color-contrast'), 'insufficient colour contrast');
  assert.equal(categoryForRule('label'), 'missing form label');
  assert.equal(categoryForRule('button-name'), 'missing ARIA on interactive element');
  assert.equal(categoryForRule('bypass'), 'missing skip navigation link');
  assert.equal(categoryForRule('heading-order'), 'improper heading hierarchy');
  assert.equal(categoryForRule('html-has-lang'), 'missing lang attribute');
  assert.equal(categoryForRule(KEYBOARD_TABINDEX_RULE), 'keyboard navigation / focus trap');
  assert.equal(categoryForRule('some-unknown-rule'), 'other (WCAG 2.1 AA)');
});

test('normalizeViolation maps fields, clips html, keeps only wcag tags, caps nodes', () => {
  const longHtml = '<div>' + 'x'.repeat(500) + '</div>';
  const nodes = Array.from({ length: 9 }, (_, i) => ({
    target: [`#n${i}`],
    html: longHtml,
    failureSummary: 'fail',
  }));
  const v = normalizeViolation(
    rawViolation({ id: 'color-contrast', impact: 'serious', tags: ['wcag2aa', 'wcag143', 'cat.color'], nodes })
  );
  assert.equal(v.rule, 'color-contrast');
  assert.equal(v.category, 'insufficient colour contrast');
  assert.equal(v.severity, 'serious');
  assert.deepEqual(v.wcagTags, ['wcag2aa', 'wcag143']); // non-wcag tags dropped
  assert.equal(v.nodes.length, 5); // capped at MAX_NODES_PER_VIOLATION
  assert.ok((v.nodes[0]?.html.length ?? 0) <= 201); // clipped (+ ellipsis)
});

test('countSeverities tallies per severity', () => {
  const vs = [
    normalizeViolation(rawViolation({ impact: 'critical' })),
    normalizeViolation(rawViolation({ impact: 'serious' })),
    normalizeViolation(rawViolation({ impact: 'serious' })),
    normalizeViolation(rawViolation({ impact: 'minor' })),
  ];
  assert.deepEqual(countSeverities(vs), { critical: 1, serious: 2, moderate: 0, minor: 1 });
});

test('buildAxeRunScript embeds the WCAG tags and the synthetic keyboard rule', () => {
  const script = buildAxeRunScript([...WCAG_21_AA_TAGS]);
  assert.match(script, /window\.axe\.run/);
  assert.match(script, /wcag21aa/);
  assert.match(script, new RegExp(KEYBOARD_TABINDEX_RULE));
  assert.match(script, /querySelectorAll\('\[tabindex\]'\)/);
});

// ---------------------------------------------------------------------------
// runAccessibilityAudit lifecycle
// ---------------------------------------------------------------------------

test('all routes clean → PASS, server stopped, browser closed, result stored', async () => {
  const stop = { stopped: false };
  const store = memStore();
  const driver = fakeDriver({ '/': probe({}), '/dashboard': probe({}) });
  const result = await runAccessibilityAudit(
    { projectPath: '/proj', routes: ROUTES },
    { driver, startDevServer: readyStarter(stop), storeResult: store.store, log: silent }
  );

  assert.equal(result.passed, true);
  assert.equal(result.blocked, false);
  assert.equal(result.ran, true);
  assert.equal(result.totalViolations, 0);
  assert.equal(result.auditedPages, 2);
  assert.equal(result.pages.every((p) => p.status === 'pass'), true);
  assert.equal(stop.stopped, true);
  assert.equal(driver.closed, true);
  assert.equal(store.calls.length, 1); // stored once
  assert.equal(store.calls[0]?.blocked, false);
});

test('serious/moderate/minor violations are surfaced but do NOT block', async () => {
  const driver = fakeDriver({
    '/': probe({
      violations: [
        rawViolation({ id: 'color-contrast', impact: 'serious' }),
        rawViolation({ id: 'heading-order', impact: 'moderate' }),
      ],
    }),
  });
  const result = await runAccessibilityAudit(
    { projectPath: '/proj', routes: [{ path: '/' }] },
    { driver, startDevServer: readyStarter({ stopped: false }), storeResult: memStore().store, log: silent }
  );
  assert.equal(result.blocked, false);
  assert.equal(result.passed, true); // non-critical → still passes
  assert.equal(result.pages[0]?.status, 'fail'); // page has violations
  assert.deepEqual(result.counts, { critical: 0, serious: 1, moderate: 1, minor: 0 });
});

test('a CRITICAL violation BLOCKS the build', async () => {
  const store = memStore();
  const driver = fakeDriver({
    '/': probe({ violations: [rawViolation({ id: 'image-alt', impact: 'critical' })] }),
  });
  const result = await runAccessibilityAudit(
    { projectPath: '/proj', projectName: 'tarritrix', routes: [{ path: '/' }] },
    { driver, startDevServer: readyStarter({ stopped: false }), storeResult: store.store, log: silent }
  );
  assert.equal(result.blocked, true);
  assert.equal(result.passed, false);
  assert.equal(result.counts.critical, 1);
  assert.equal(store.calls[0]?.projectName, 'tarritrix');
  assert.equal(store.calls[0]?.blocked, true);
});

test('dynamic route that fails to load is SKIPPED (sample param), not failed', async () => {
  const driver = fakeDriver({ '/users/1': probe({ ok: false, status: 404 }) });
  const result = await runAccessibilityAudit(
    { projectPath: '/proj', routes: [{ path: '/users/:id', dynamic: true }] },
    { driver, startDevServer: readyStarter({ stopped: false }), storeResult: memStore().store, log: silent }
  );
  assert.equal(result.passed, true); // a dynamic skip does not fail the gate
  assert.equal(result.pages[0]?.status, 'skipped');
  assert.equal(result.auditedPages, 0);
  assert.equal(driver.visited[0], 'http://localhost:3000/users/1');
});

test('static route that fails to load is an ERROR (un-evaluable), not a fail', async () => {
  const driver = fakeDriver({ '/': probe({ ok: false, status: 500 }) });
  const result = await runAccessibilityAudit(
    { projectPath: '/proj', routes: [{ path: '/' }] },
    { driver, startDevServer: readyStarter({ stopped: false }), storeResult: memStore().store, log: silent }
  );
  assert.equal(result.pages[0]?.status, 'error');
  assert.equal(result.blocked, false);
  assert.equal(result.skippedPages, 1);
});

test('dev server never ready → every route SKIPPED, nothing stored', async () => {
  const store = memStore();
  const result = await runAccessibilityAudit(
    { projectPath: '/proj', routes: ROUTES },
    {
      driver: fakeDriver({}),
      startDevServer: async () => ({ ready: false, handle: { async stop() {} }, detail: 'no answer' }),
      storeResult: store.store,
      log: silent,
    }
  );
  assert.equal(result.devServerStarted, false);
  assert.equal(result.pages.every((p) => p.status === 'skipped'), true);
  assert.equal(result.skippedPages, 2);
  assert.equal(store.calls.length, 0); // nothing audited → nothing stored
});

test('no driver (no Playwright/axe) → every route SKIPPED', async () => {
  const result = await runAccessibilityAudit(
    { projectPath: '/proj', routes: ROUTES },
    {
      createDriver: async () => null,
      startDevServer: readyStarter({ stopped: false }),
      storeResult: memStore().store,
      log: silent,
    }
  );
  assert.equal(result.driverAvailable, false);
  assert.equal(result.pages.every((p) => p.status === 'skipped'), true);
});

test('non-UI changedFiles → no-op, never boots the server', async () => {
  let started = false;
  const result = await runAccessibilityAudit(
    { projectPath: '/proj', routes: ROUTES, changedFiles: ['src/lib/util.ts'] },
    {
      driver: fakeDriver({ '/': probe({}) }),
      startDevServer: async () => {
        started = true;
        return { ready: true, handle: { async stop() {} }, detail: '' };
      },
      log: silent,
    }
  );
  assert.equal(result.ran, false);
  assert.equal(result.pages.length, 0);
  assert.equal(started, false);
});

test('startServer:false audits an already-running app without booting', async () => {
  let started = false;
  const driver = fakeDriver({ '/': probe({}) });
  const result = await runAccessibilityAudit(
    { projectPath: '/proj', routes: [{ path: '/' }], startServer: false },
    {
      driver,
      startDevServer: async () => {
        started = true;
        return { ready: true, handle: { async stop() {} }, detail: '' };
      },
      storeResult: memStore().store,
      log: silent,
    }
  );
  assert.equal(started, false); // never booted
  assert.equal(result.ran, true);
  assert.equal(result.devServerStarted, true);
  assert.equal(result.passed, true);
});

test('discovers routes via injected discoverRoutes when none supplied', async () => {
  const driver = fakeDriver({ '/': probe({}) });
  const result = await runAccessibilityAudit(
    { projectPath: '/proj' },
    {
      discoverRoutes: async () => [{ path: '/', name: 'app/page.tsx' }],
      driver,
      startDevServer: readyStarter({ stopped: false }),
      storeResult: memStore().store,
      log: silent,
    }
  );
  assert.equal(result.ran, true);
  assert.equal(result.auditedPages, 1);
});

// ---------------------------------------------------------------------------
// Phase 4 Sentinel integration (optional ninth check)
// ---------------------------------------------------------------------------

/** A command runner that passes tsc + build (so the gate reaches the optional checks). */
const passingRun = async (): Promise<CommandResult> => ({ ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false });

/** Build an AccessibilityReport stub for the injected runner. */
function reportStub(overrides: Partial<AccessibilityReport>): AccessibilityReport {
  return {
    passed: true,
    blocked: false,
    ran: true,
    devServerStarted: true,
    driverAvailable: true,
    failures: [],
    pages: [],
    counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    totalViolations: 0,
    auditedPages: 1,
    skippedPages: 0,
    wcagTags: [...WCAG_21_AA_TAGS],
    baseUrl: 'http://localhost:3000',
    report: '',
    generatedAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  };
}

test('Sentinel: no accessibility config → exactly the five Contract-13 checks', async () => {
  const result = await runSentinel({
    projectPath: '/proj',
    runCommand: passingRun,
    getFileChanges: async () => [{ status: 'M', path: 'src/app/page.tsx' }],
    log: silent,
  });
  assert.equal(result.checks.length, 5);
  assert.equal(result.checks.some((c) => c.name === 'accessibility'), false);
});

test('Sentinel: accessibility runs after a .tsx change and a CRITICAL violation fails the gate', async () => {
  const result = await runSentinel({
    projectPath: '/proj',
    runCommand: passingRun,
    getFileChanges: async () => [{ status: 'M', path: 'src/app/dashboard/page.tsx' }],
    accessibility: { routes: [{ path: '/dashboard' }] },
    uiPromptJustRan: true,
    runAccessibilityCheck: async () =>
      reportStub({
        passed: false,
        blocked: true,
        counts: { critical: 1, serious: 0, moderate: 0, minor: 0 },
        totalViolations: 1,
        failures: [
          {
            path: '/dashboard',
            url: 'http://localhost:3000/dashboard',
            status: 'fail',
            passed: false,
            httpStatus: 200,
            violations: [normalizeViolation(rawViolation({ id: 'image-alt', impact: 'critical' }))],
            counts: { critical: 1, serious: 0, moderate: 0, minor: 0 },
            dynamic: false,
            detail: '1 violation(s): 1 critical, 0 serious, 0 moderate, 0 minor',
          },
        ],
      }),
    log: silent,
  });

  const a11y = result.checks.find((c) => c.name === 'accessibility');
  assert.ok(a11y, 'accessibility check present');
  assert.equal(a11y?.passed, false);
  assert.equal(result.passed, false);
  assert.equal(result.failedCheck, 'accessibility');
  assert.match(a11y?.detail ?? '', /CRITICAL/);
});

test('Sentinel: accessibility passes (non-critical surfaced) without failing the gate', async () => {
  const result = await runSentinel({
    projectPath: '/proj',
    runCommand: passingRun,
    getFileChanges: async () => [{ status: 'M', path: 'src/app/page.tsx' }],
    accessibility: { routes: [{ path: '/' }] },
    uiPromptJustRan: true,
    runAccessibilityCheck: async () =>
      reportStub({ counts: { critical: 0, serious: 2, moderate: 1, minor: 0 }, totalViolations: 3 }),
    log: silent,
  });
  const a11y = result.checks.find((c) => c.name === 'accessibility');
  assert.ok(a11y);
  assert.equal(a11y?.passed, true);
  assert.equal(result.passed, true);
  assert.match(a11y?.detail ?? '', /no critical/);
});

test('Sentinel: accessibility NOT triggered when no .tsx/.css changed', async () => {
  let ran = false;
  const result = await runSentinel({
    projectPath: '/proj',
    runCommand: passingRun,
    getFileChanges: async () => [{ status: 'M', path: 'src/lib/util.ts' }],
    accessibility: { routes: [{ path: '/' }] },
    uiPromptJustRan: true,
    runAccessibilityCheck: async () => {
      ran = true;
      throw new Error('should not be called');
    },
    log: silent,
  });
  assert.equal(ran, false);
  assert.equal(result.checks.some((c) => c.name === 'accessibility'), false);
});
