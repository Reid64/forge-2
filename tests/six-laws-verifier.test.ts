/**
 * FORGE 2.0 — Six Laws Verifier unit test (Sprint 7, s7-p01).
 *
 * The verifier's laws are all driven through INJECTABLE collaborators — schema extraction, the HTTP
 * requester, and the browser driver — so this suite exercises every law entirely in-process with no
 * Docker Supabase, no running server, and no Playwright/Chromium. It asserts the F13 / Contract 19
 * contract:
 *   - parseRoutesFromContracts + selectorForElement (pure helpers).
 *   - Law 1 SCHEMA — table/column/RLS verification against an injected schema snapshot.
 *   - Law 2 API — status + safety semantics against an injected HTTP requester (incl. all-unreachable
 *     → SKIP).
 *   - Laws 3-5 — UI/DATA/WIRING against an injected fake PageDriver (placeholder text, hardcoded
 *     data, and an unauthenticated render of a protected route all FAIL; clean pages PASS).
 *   - No-pages → SKIP; Law 6 always reported as the manual gate.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/six-laws-verifier.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  verifySixLaws,
  parseRoutesFromContracts,
  selectorForElement,
  type PageDriver,
  type PageProbe,
  type PageProbeRequest,
  type HttpResponseLite,
} from '../src/analysis/six-laws-verifier.js';
import type { RegistryTable } from '../src/phases/phase4-sentinel.js';
import type { SchemaSnapshot, TableSchema, RlsPolicy } from '../src/tools/schema-extractor.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function registryTable(name: string, cols: Record<string, string>): RegistryTable {
  return { name, columns: new Map(Object.entries(cols)) };
}

function tableSchema(name: string, cols: Record<string, string>, rlsEnabled: boolean): TableSchema {
  return {
    name,
    schema: 'public',
    columns: Object.entries(cols).map(([cn, ct]) => ({
      name: cn,
      type: ct,
      nullable: true,
      default: null,
      constraints: [],
    })),
    primaryKey: ['id'],
    foreignKeys: [],
    rlsEnabled,
  };
}

function policy(table: string): RlsPolicy {
  return { name: `${table}_policy`, table, command: 'ALL', roles: ['authenticated'], permissive: true, using: null, withCheck: null };
}

function snapshot(tables: TableSchema[], policies: RlsPolicy[]): SchemaSnapshot {
  return { tables, relationships: [], indexes: [], rlsPolicies: policies, source: 'live', migrationFiles: [], warnings: [] };
}

function httpRes(over: Partial<HttpResponseLite>): HttpResponseLite {
  return { status: 200, ok: true, headers: { 'content-type': 'application/json' }, bodyText: '[]', url: 'http://x', redirected: false, ...over };
}

function probeOf(over: Partial<PageProbe>): PageProbe {
  return {
    url: 'http://localhost:3000/',
    finalUrl: 'http://localhost:3000/',
    ok: true,
    status: 200,
    bodyText: 'Dashboard',
    consoleErrors: [],
    pageErrors: [],
    requests: [],
    presentSelectors: {},
    links: [],
    error: null,
    ...over,
  };
}

/** A fake driver that returns a canned probe per request, keyed by a matcher function. */
function fakeDriver(handler: (req: PageProbeRequest) => PageProbe): PageDriver {
  return {
    probe: async (req) => handler(req),
    close: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('parseRoutesFromContracts extracts, dedupes, and skips non-API paths', () => {
  const md = `
    The API exposes GET /api/leads and POST /api/leads. Also GET /api/leads again.
    Source lives at GET /src/server.ts (should be ignored).
  `;
  const routes = parseRoutesFromContracts(md);
  const keys = routes.map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(keys, ['GET /api/leads', 'POST /api/leads']);
});

test('selectorForElement maps element descriptions to selectors', () => {
  assert.match(selectorForElement('Save button'), /button/);
  assert.match(selectorForElement('role dropdown'), /select/);
  assert.match(selectorForElement('email field'), /input/);
  assert.match(selectorForElement('Create form'), /form/);
});

// ---------------------------------------------------------------------------
// Law 1 — SCHEMA
// ---------------------------------------------------------------------------

test('Law 1 passes when tables, columns, and RLS all match', async () => {
  const expected = [registryTable('leads', { id: 'uuid', company_id: 'uuid', name: 'text' })];
  const actual = snapshot([tableSchema('leads', { id: 'uuid', company_id: 'uuid', name: 'text' }, true)], [policy('leads')]);

  const result = await verifySixLaws(
    { expectedTables: expected, apiRoutes: [], pages: [] },
    { extractActualSchema: async () => actual, log: () => {} }
  );
  const law1 = result.laws[0];
  assert.ok(law1);
  assert.equal(law1.name, 'SCHEMA');
  assert.equal(law1.passed, true);
  assert.equal(law1.skipped, false);
});

test('Law 1 fails when a table has no RLS', async () => {
  const expected = [registryTable('leads', { id: 'uuid' })];
  const actual = snapshot([tableSchema('leads', { id: 'uuid' }, false)], []); // RLS off, no policy

  const result = await verifySixLaws(
    { expectedTables: expected, pages: [] },
    { extractActualSchema: async () => actual, log: () => {} }
  );
  const law1 = result.laws[0];
  assert.ok(law1);
  assert.equal(law1.passed, false);
  assert.ok(law1.findings.some((f) => f.severity === 'fail' && /RLS/i.test(f.detail)));
});

test('Law 1 fails when an expected table is missing', async () => {
  const expected = [registryTable('leads', { id: 'uuid' }), registryTable('deals', { id: 'uuid' })];
  const actual = snapshot([tableSchema('leads', { id: 'uuid' }, true)], [policy('leads')]); // no 'deals'

  const result = await verifySixLaws(
    { expectedTables: expected, pages: [] },
    { extractActualSchema: async () => actual, log: () => {} }
  );
  const law1 = result.laws[0];
  assert.ok(law1);
  assert.equal(law1.passed, false);
  assert.ok(law1.findings.some((f) => f.severity === 'fail' && /deals/.test(f.detail)));
});

// ---------------------------------------------------------------------------
// Law 2 — API
// ---------------------------------------------------------------------------

test('Law 2: GET 200 passes, 404 fails, mutating-rejected passes (safety), all-unreachable skips', async () => {
  const result = await verifySixLaws(
    {
      pages: [],
      apiRoutes: [
        { path: '/api/leads', method: 'GET', expectStatus: 200 },
        { path: '/api/missing', method: 'GET' },
        { path: '/api/leads', method: 'POST', authRequired: true },
      ],
    },
    {
      log: () => {},
      httpRequest: async (req) => {
        if (req.url.endsWith('/api/missing')) return httpRes({ status: 404, ok: false });
        if (req.method === 'POST') return httpRes({ status: 401, ok: false }); // rejected unauthenticated probe
        return httpRes({ status: 200, ok: true, bodyText: '[]' });
      },
    }
  );
  const law2 = result.laws[1];
  assert.ok(law2);
  assert.equal(law2.passed, false); // the 404 fails the law
  assert.ok(law2.findings.some((f) => f.severity === 'fail' && /404/.test(f.detail)));
  assert.ok(law2.findings.some((f) => f.severity === 'pass' && /GET \/api\/leads/.test(f.subject)));
  assert.ok(law2.findings.some((f) => f.severity === 'pass' && /POST \/api\/leads/.test(f.subject)));
});

test('Law 2 SKIPS when the target app is unreachable', async () => {
  const result = await verifySixLaws(
    { pages: [], apiRoutes: [{ path: '/api/leads', method: 'GET' }] },
    {
      log: () => {},
      httpRequest: async () => {
        throw new Error('ECONNREFUSED');
      },
    }
  );
  const law2 = result.laws[1];
  assert.ok(law2);
  assert.equal(law2.skipped, true);
});

// ---------------------------------------------------------------------------
// Laws 3-5 — UI / DATA / WIRING (fake driver)
// ---------------------------------------------------------------------------

test('Laws 3/4: placeholder text fails UI; missing data requests fail DATA', async () => {
  const driver = fakeDriver((req) =>
    probeOf({
      url: req.url,
      finalUrl: req.url,
      bodyText: 'Coming soon — dashboard placeholder',
      presentSelectors: Object.fromEntries((req.selectors ?? []).map((s) => [s, true])),
      requests: [], // no API calls
    })
  );

  const result = await verifySixLaws(
    { apiRoutes: [], pages: [{ path: '/dashboard', name: 'Dashboard', expectsData: true }] },
    { driver, log: () => {} }
  );
  const [, , law3, law4] = result.laws;
  assert.ok(law3 && law4);
  assert.equal(law3.passed, false);
  assert.ok(law3.findings.some((f) => f.severity === 'fail' && /placeholder|coming soon/i.test(f.detail)));
  assert.equal(law4.passed, false);
  assert.ok(law4.findings.some((f) => f.severity === 'fail' && /hardcoded/i.test(f.detail)));
});

test('Laws 3/4 pass for a clean page that issues real API calls', async () => {
  const driver = fakeDriver((req) =>
    probeOf({
      url: req.url,
      finalUrl: req.url,
      bodyText: 'Leads table with rows',
      presentSelectors: Object.fromEntries((req.selectors ?? []).map((s) => [s, true])),
      requests: [{ method: 'GET', url: 'http://localhost:3000/api/leads', resourceType: 'fetch' }],
    })
  );

  const result = await verifySixLaws(
    { apiRoutes: [{ path: '/api/leads', method: 'GET' }], pages: [{ path: '/leads', name: 'Leads', expectsData: true }] },
    { driver, log: () => {} }
  );
  const [, , law3, law4] = result.laws;
  assert.ok(law3 && law4);
  assert.equal(law3.passed, true);
  assert.equal(law4.passed, true);
});

test('Law 5 fails when a protected route renders for an unauthenticated visitor', async () => {
  const driver = fakeDriver((req) => {
    // The unauthenticated role-gating probe renders the page (gate missing).
    if (req.unauthenticated) {
      return probeOf({ url: req.url, finalUrl: req.url, ok: true, status: 200, bodyText: 'Secret admin panel' });
    }
    return probeOf({
      url: req.url,
      finalUrl: req.url,
      presentSelectors: Object.fromEntries((req.selectors ?? []).map((s) => [s, true])),
      requests: [{ method: 'GET', url: 'http://localhost:3000/api/admin', resourceType: 'fetch' }],
    });
  });

  const result = await verifySixLaws(
    { pages: [{ path: '/admin', name: 'Admin', authRequired: true, roles: ['admin'] }] },
    { driver, log: () => {} }
  );
  const law5 = result.laws[4];
  assert.ok(law5);
  assert.equal(law5.passed, false);
  assert.ok(law5.findings.some((f) => f.severity === 'fail' && /UNAUTHENTICATED/i.test(f.detail)));
});

test('Law 5 passes when a protected route redirects an anonymous visitor to /login', async () => {
  const driver = fakeDriver((req) => {
    if (req.unauthenticated) {
      return probeOf({ url: req.url, finalUrl: 'http://localhost:3000/login', ok: false, status: 200, bodyText: 'Sign in' });
    }
    return probeOf({
      url: req.url,
      finalUrl: req.url,
      presentSelectors: Object.fromEntries((req.selectors ?? []).map((s) => [s, true])),
      requests: [{ method: 'GET', url: 'http://localhost:3000/api/admin', resourceType: 'fetch' }],
    });
  });

  const result = await verifySixLaws(
    { pages: [{ path: '/admin', name: 'Admin', authRequired: true }] },
    { driver, log: () => {} }
  );
  const law5 = result.laws[4];
  assert.ok(law5);
  assert.ok(law5.findings.some((f) => f.severity === 'pass' && /redirected|blocked/i.test(f.detail)));
});

// ---------------------------------------------------------------------------
// Skips + Law 6
// ---------------------------------------------------------------------------

test('Laws 3-5 SKIP when no pages are supplied; Law 6 is always the manual gate', async () => {
  const result = await verifySixLaws({ expectedTables: [], pages: [] }, { log: () => {} });
  const [, , law3, law4, law5] = result.laws;
  assert.ok(law3 && law4 && law5);
  assert.equal(law3.skipped, true);
  assert.equal(law4.skipped, true);
  assert.equal(law5.skipped, true);
  assert.equal(result.law6.automated, false);
  assert.equal(result.law6.name, 'VERIFICATION');
  assert.match(result.report, /Six Laws Verification/);
});
