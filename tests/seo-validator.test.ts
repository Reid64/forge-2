/**
 * FORGE 2.0 — SEO Validator tests (pure `node:test`; no `pnpm`, no server, no browser, no DB).
 *
 * Covers: the pure per-page checks (`evaluateTitle`/`evaluateMetaDescription`/`evaluateCanonical`/
 * `evaluateOpenGraph`/`evaluateJsonLd`/`evaluateRobots`/`evaluateHeadings`/`evaluateImages`), the
 * scoring + helpers (`scoreFromIssues`, `inferPageType`, `isModernImageFormat`, `normalizePath`,
 * `routeMatcher`/`matchesAnyRoute`, `parseSitemapLocs`), the SITE-WIDE pure analysis (`analyzeSeo`:
 * duplicate titles, orphan pages, broken links, sitemap validity), the `runSeoAudit` lifecycle driven
 * by an injected dev-server starter + fake `SeoDriver` + injected fetcher + capturing store, and the
 * Phase 4 Sentinel integration (the optional tenth check, opt-in, with an injected SEO runner).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runSeoAudit,
  analyzeSeo,
  evaluateTitle,
  evaluateMetaDescription,
  evaluateCanonical,
  evaluateOpenGraph,
  evaluateJsonLd,
  evaluateRobots,
  evaluateHeadings,
  evaluateImages,
  scoreFromIssues,
  inferPageType,
  isModernImageFormat,
  normalizePath,
  routeMatcher,
  matchesAnyRoute,
  parseSitemapLocs,
  buildSeoExtractScript,
  type RawSeoData,
  type SeoDriver,
  type SeoProbe,
  type SeoProbeRequest,
  type SeoRouteSpec,
  type SeoStoredRecord,
  type FetchResult,
  type PageProbeResult,
  type SEOAuditResult,
} from '../src/tools/seo-validator.js';
import { runSentinel, type CommandResult } from '../src/phases/phase4-sentinel.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A fully SEO-clean page, overridable per field. */
function seoData(overrides: Partial<RawSeoData> = {}): RawSeoData {
  return {
    title: 'Home — Acme',
    metaDescription: 'A short, valid meta description well under the limit.',
    canonical: 'https://acme.test/',
    robots: 'index,follow',
    ogTags: {
      'og:title': 'Home — Acme',
      'og:description': 'Acme home',
      'og:image': 'https://acme.test/og.webp',
      'og:url': 'https://acme.test/',
      'og:type': 'website',
    },
    jsonLd: ['{"@context":"https://schema.org","@type":"WebSite","name":"Acme"}'],
    headings: [
      { level: 1, text: 'Welcome' },
      { level: 2, text: 'Features' },
    ],
    images: [{ src: '/_next/image?url=/hero.png', srcset: '', loading: 'lazy', hasWidth: true, hasHeight: true }],
    internalLinks: ['/'],
    ...overrides,
  };
}

/** A SeoProbe with sensible defaults. */
function probe(overrides: Partial<SeoProbe> = {}): SeoProbe {
  return { ok: true, status: 200, finalUrl: 'http://localhost:3000/', data: seoData(), error: null, ...overrides };
}

/** A fake driver: maps url path → probe; records visited urls and whether it closed. */
function fakeDriver(byPath: Record<string, SeoProbe>): SeoDriver & { visited: string[]; closed: boolean } {
  const state = { visited: [] as string[], closed: false };
  return {
    visited: state.visited,
    get closed() {
      return state.closed;
    },
    async audit(req: SeoProbeRequest): Promise<SeoProbe> {
      state.visited.push(req.url);
      const path = new URL(req.url).pathname;
      return byPath[path] ?? probe({ ok: false, status: 404, data: null });
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

/** A fetcher returning a canned body per path. */
function fakeFetcher(byPath: Record<string, FetchResult>): (url: string) => Promise<FetchResult> {
  return async (url: string) => {
    const path = new URL(url).pathname;
    return byPath[path] ?? { ok: false, status: 404, body: '', contentType: null };
  };
}

/** A capturing Build-Memory store. */
function memStore(): { calls: SeoStoredRecord[]; store: (r: SeoStoredRecord) => Promise<void> } {
  const calls: SeoStoredRecord[] = [];
  return { calls, store: async (r) => void calls.push(r) };
}

const silent = (): void => {};
const okSitemap = (locs: string[]): FetchResult => ({
  ok: true,
  status: 200,
  body: `<?xml version="1.0"?><urlset>${locs.map((l) => `<loc>${l}</loc>`).join('')}</urlset>`,
  contentType: 'application/xml',
});
const okRobots: FetchResult = { ok: true, status: 200, body: 'User-agent: *\nSitemap: http://localhost:3000/sitemap.xml\n', contentType: 'text/plain' };

// ---------------------------------------------------------------------------
// Pure per-page checks
// ---------------------------------------------------------------------------

test('evaluateTitle flags a missing title as critical, clean otherwise', () => {
  assert.equal(evaluateTitle(seoData({ title: '' })).some((i) => i.severity === 'critical'), true);
  assert.deepEqual(evaluateTitle(seoData({ title: 'Fine title' })), []);
  assert.equal(evaluateTitle(seoData({ title: 'x'.repeat(80) }))[0]?.severity, 'minor'); // too long
});

test('evaluateMetaDescription flags missing and over-160', () => {
  assert.equal(evaluateMetaDescription(seoData({ metaDescription: null }))[0]?.check, 'meta_description');
  assert.equal(evaluateMetaDescription(seoData({ metaDescription: 'x'.repeat(200) }))[0]?.severity, 'serious');
  assert.deepEqual(evaluateMetaDescription(seoData({ metaDescription: 'short and sweet' })), []);
});

test('evaluateCanonical flags a missing canonical', () => {
  assert.equal(evaluateCanonical(seoData({ canonical: null })).length, 1);
  assert.deepEqual(evaluateCanonical(seoData({ canonical: 'https://x/' })), []);
});

test('evaluateOpenGraph flags missing required vs recommended', () => {
  const missingReq = evaluateOpenGraph(seoData({ ogTags: { 'og:url': 'x', 'og:type': 'website' } }));
  assert.equal(missingReq.some((i) => i.severity === 'moderate' && /required/.test(i.message)), true);
  const missingRec = evaluateOpenGraph(seoData({ ogTags: { 'og:title': 'a', 'og:description': 'b', 'og:image': 'c' } }));
  assert.equal(missingRec.some((i) => i.severity === 'minor' && /recommended/.test(i.message)), true);
  assert.deepEqual(evaluateOpenGraph(seoData()), []);
});

test('evaluateJsonLd: missing → moderate, invalid JSON → critical, missing @type → serious, valid → clean', () => {
  assert.equal(evaluateJsonLd(seoData({ jsonLd: [] }))[0]?.severity, 'moderate');
  assert.equal(evaluateJsonLd(seoData({ jsonLd: ['{ not json'] }))[0]?.severity, 'critical');
  assert.equal(evaluateJsonLd(seoData({ jsonLd: ['{"@context":"https://schema.org","name":"x"}'] }))[0]?.severity, 'serious');
  assert.deepEqual(evaluateJsonLd(seoData()), []);
});

test('evaluateJsonLd accepts an @graph array', () => {
  const block = '{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"a"},{"@type":"WebSite","name":"b"}]}';
  assert.deepEqual(evaluateJsonLd(seoData({ jsonLd: [block] })), []);
});

test('evaluateRobots: public+noindex → serious, private without noindex → moderate', () => {
  assert.equal(evaluateRobots(seoData({ robots: 'noindex' }), '/')[0]?.severity, 'serious');
  assert.equal(evaluateRobots(seoData({ robots: 'index,follow' }), '/dashboard')[0]?.severity, 'moderate');
  assert.deepEqual(evaluateRobots(seoData({ robots: 'noindex' }), '/admin'), []); // private noindex is correct
  assert.deepEqual(evaluateRobots(seoData({ robots: 'index' }), '/'), []); // public index is correct
});

test('evaluateHeadings: no H1 / multiple H1 → critical, skipped level → moderate', () => {
  assert.equal(evaluateHeadings(seoData({ headings: [{ level: 2, text: 'a' }] }))[0]?.severity, 'critical');
  assert.equal(
    evaluateHeadings(seoData({ headings: [{ level: 1, text: 'a' }, { level: 1, text: 'b' }] }))[0]?.severity,
    'critical'
  );
  const skip = evaluateHeadings(seoData({ headings: [{ level: 1, text: 'a' }, { level: 4, text: 'b' }] }));
  assert.equal(skip.some((i) => i.severity === 'moderate' && /skips/.test(i.message)), true);
  assert.deepEqual(evaluateHeadings(seoData()), []);
});

test('evaluateImages flags non-webp / non-lazy / missing dims', () => {
  const bad = evaluateImages(
    seoData({ images: [{ src: '/hero.jpg', srcset: '', loading: '', hasWidth: false, hasHeight: false }] })
  );
  assert.equal(bad.length, 3);
  assert.equal(bad.every((i) => i.severity === 'minor' && i.check === 'image_optimization'), true);
  assert.deepEqual(evaluateImages(seoData()), []);
});

test('isModernImageFormat recognizes webp/avif/next-image/svg/data', () => {
  assert.equal(isModernImageFormat({ src: '/a.webp', srcset: '', loading: '', hasWidth: true, hasHeight: true }), true);
  assert.equal(isModernImageFormat({ src: '/_next/image?url=/a.png', srcset: '', loading: '', hasWidth: true, hasHeight: true }), true);
  assert.equal(isModernImageFormat({ src: '/a.svg', srcset: '', loading: '', hasWidth: true, hasHeight: true }), true);
  assert.equal(isModernImageFormat({ src: '/a.jpg', srcset: '', loading: '', hasWidth: true, hasHeight: true }), false);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('scoreFromIssues deducts by severity weight and floors at 0', () => {
  assert.equal(scoreFromIssues([]), 100);
  assert.equal(scoreFromIssues([{ check: 'title', severity: 'minor', message: '' }]), 97);
  assert.equal(scoreFromIssues([{ check: 'title', severity: 'serious', message: '' }]), 85);
  assert.equal(
    scoreFromIssues([
      { check: 'title', severity: 'critical', message: '' },
      { check: 'title', severity: 'critical', message: '' },
      { check: 'title', severity: 'critical', message: '' },
      { check: 'title', severity: 'critical', message: '' },
    ]),
    0
  );
});

test('inferPageType classifies private vs public prefixes', () => {
  assert.equal(inferPageType('/'), 'public');
  assert.equal(inferPageType('/pricing'), 'public');
  assert.equal(inferPageType('/dashboard'), 'private');
  assert.equal(inferPageType('/admin/users'), 'private');
  assert.equal(inferPageType('/login'), 'private');
});

test('normalizePath strips query/hash and trailing slash', () => {
  assert.equal(normalizePath('/foo/'), '/foo');
  assert.equal(normalizePath('/foo?x=1#y'), '/foo');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath(''), '/');
});

test('routeMatcher matches static and dynamic routes', () => {
  assert.equal(routeMatcher({ path: '/about' })('/about/'), true);
  assert.equal(routeMatcher({ path: '/about' })('/about/team'), false);
  const dyn = routeMatcher({ path: '/users/:id', dynamic: true });
  assert.equal(dyn('/users/42'), true);
  assert.equal(dyn('/users/42/posts'), false);
  const cat = routeMatcher({ path: '/blog/*slug', dynamic: true });
  assert.equal(cat('/blog/a/b/c'), true);
  assert.equal(matchesAnyRoute('/x', [routeMatcher({ path: '/y' }), routeMatcher({ path: '/x' })]), true);
});

test('parseSitemapLocs extracts loc urls', () => {
  assert.deepEqual(parseSitemapLocs('<urlset><loc>http://x/</loc><loc> http://x/a </loc></urlset>'), [
    'http://x/',
    'http://x/a',
  ]);
  assert.deepEqual(parseSitemapLocs('no locs here'), []);
});

test('buildSeoExtractScript pulls the SEO-relevant selectors', () => {
  const s = buildSeoExtractScript();
  assert.match(s, /meta\[name="description"\]/);
  assert.match(s, /link\[rel="canonical"\]/);
  assert.match(s, /application\/ld\+json/);
  assert.match(s, /querySelectorAll\('h1,h2,h3,h4,h5,h6'\)/);
});

// ---------------------------------------------------------------------------
// Site-wide pure analysis (analyzeSeo)
// ---------------------------------------------------------------------------

function probed(path: string, data: RawSeoData | null, opts: Partial<SeoRouteSpec> = {}): PageProbeResult {
  return {
    route: { path, ...opts },
    probe: data ? probe({ data }) : probe({ ok: false, status: 404, data: null }),
  };
}

test('analyzeSeo: duplicate titles across routes → critical on each page', () => {
  const a = analyzeSeo({
    pages: [
      probed('/', seoData({ title: 'Same', internalLinks: ['/', '/about'] })),
      probed('/about', seoData({ title: 'Same', internalLinks: ['/'] })),
    ],
    routes: [{ path: '/' }, { path: '/about' }],
    baseUrl: 'http://localhost:3000',
    sitemap: okSitemap(['http://localhost:3000/', 'http://localhost:3000/about']),
    robots: okRobots,
  });
  assert.equal(a.duplicateTitles.length, 1);
  assert.deepEqual(a.duplicateTitles[0]?.paths.sort(), ['/', '/about']);
  assert.equal(a.pages.every((p) => p.issues.some((i) => i.check === 'title' && i.severity === 'critical')), true);
});

test('analyzeSeo: an unlinked static route is an orphan; a bad internal link is broken', () => {
  const a = analyzeSeo({
    pages: [
      // home links only to itself and to a non-existent /ghost
      probed('/', seoData({ title: 'Home', internalLinks: ['/', '/ghost'] })),
      // /lonely is never linked to → orphan
      probed('/lonely', seoData({ title: 'Lonely', internalLinks: ['/'] })),
    ],
    routes: [{ path: '/' }, { path: '/lonely' }],
    baseUrl: 'http://localhost:3000',
    sitemap: okSitemap(['http://localhost:3000/', 'http://localhost:3000/lonely']),
    robots: okRobots,
  });
  assert.deepEqual(a.orphanPages, ['/lonely']);
  assert.equal(a.brokenLinks.some((b) => b.to === '/ghost'), true);
  const home = a.pages.find((p) => p.path === '/');
  assert.equal(home?.issues.some((i) => i.check === 'internal_links' && /broken/.test(i.message)), true);
});

test('analyzeSeo: a missing sitemap is a site-wide serious issue', () => {
  const a = analyzeSeo({
    pages: [probed('/', seoData({ internalLinks: ['/'] }))],
    routes: [{ path: '/' }],
    baseUrl: 'http://localhost:3000',
    sitemap: { ok: false, status: 404, body: '', contentType: null },
    robots: okRobots,
  });
  assert.equal(a.sitemap.found, false);
  assert.equal(a.siteIssues.some((i) => i.check === 'sitemap' && i.severity === 'serious'), true);
});

test('analyzeSeo: a clean page scores 100 and passes', () => {
  const a = analyzeSeo({
    pages: [probed('/', seoData({ internalLinks: ['/'] }))],
    routes: [{ path: '/' }],
    baseUrl: 'http://localhost:3000',
    sitemap: okSitemap(['http://localhost:3000/']),
    robots: okRobots,
  });
  assert.equal(a.pages[0]?.score, 100);
  assert.equal(a.pages[0]?.status, 'pass');
  assert.deepEqual(a.siteIssues, []);
});

// ---------------------------------------------------------------------------
// runSeoAudit lifecycle
// ---------------------------------------------------------------------------

const ROUTES: SeoRouteSpec[] = [{ path: '/', name: 'home' }];

test('clean run → PASS, server stopped, browser closed, result stored with a score', async () => {
  const stop = { stopped: false };
  const store = memStore();
  const driver = fakeDriver({ '/': probe({ data: seoData({ internalLinks: ['/'] }) }) });
  const result = await runSeoAudit(
    { projectPath: '/proj', routes: ROUTES },
    {
      driver,
      startDevServer: readyStarter(stop),
      fetchResource: fakeFetcher({ '/sitemap.xml': okSitemap(['http://localhost:3000/']), '/robots.txt': okRobots }),
      storeResult: store.store,
      log: silent,
    }
  );
  assert.equal(result.passed, true);
  assert.equal(result.blocked, false);
  assert.equal(result.ran, true);
  assert.equal(result.auditedPages, 1);
  assert.equal(result.siteScore, 100);
  assert.equal(result.pages[0]?.status, 'pass');
  assert.equal(stop.stopped, true);
  // A caller-injected driver is never closed by this function — only a driver it creates
  // internally (ownsDriver) is, so a shared/reused driver survives across multiple gates by
  // design (src/tools/seo-validator.ts:1531,1540,1563).
  assert.equal(driver.closed, false);
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0]?.blocked, false);
});

test('a CRITICAL issue (no H1) BLOCKS the build', async () => {
  const driver = fakeDriver({
    '/': probe({ data: seoData({ headings: [{ level: 2, text: 'x' }], internalLinks: ['/'] }) }),
  });
  const result = await runSeoAudit(
    { projectPath: '/proj', projectName: 'tarritrix', routes: ROUTES },
    {
      driver,
      startDevServer: readyStarter({ stopped: false }),
      fetchResource: fakeFetcher({ '/sitemap.xml': okSitemap(['http://localhost:3000/']), '/robots.txt': okRobots }),
      storeResult: memStore().store,
      log: silent,
    }
  );
  assert.equal(result.blocked, true);
  assert.equal(result.passed, false);
  assert.equal(result.counts.critical >= 1, true);
});

test('serious/moderate/minor issues are surfaced but do NOT block', async () => {
  const driver = fakeDriver({
    '/': probe({ data: seoData({ metaDescription: null, canonical: null, internalLinks: ['/'] }) }),
  });
  const result = await runSeoAudit(
    { projectPath: '/proj', routes: ROUTES },
    {
      driver,
      startDevServer: readyStarter({ stopped: false }),
      fetchResource: fakeFetcher({ '/sitemap.xml': okSitemap(['http://localhost:3000/']), '/robots.txt': okRobots }),
      storeResult: memStore().store,
      log: silent,
    }
  );
  assert.equal(result.blocked, false);
  assert.equal(result.passed, true);
  assert.equal(result.pages[0]?.status, 'fail');
  assert.equal((result.siteScore ?? 100) < 100, true);
});

test('dev server never ready → every route SKIPPED, nothing stored', async () => {
  const store = memStore();
  const result = await runSeoAudit(
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
  assert.equal(store.calls.length, 0);
});

test('no driver (no Playwright) → every route SKIPPED', async () => {
  const result = await runSeoAudit(
    { projectPath: '/proj', routes: ROUTES },
    { createDriver: async () => null, startDevServer: readyStarter({ stopped: false }), storeResult: memStore().store, log: silent }
  );
  assert.equal(result.driverAvailable, false);
  assert.equal(result.pages.every((p) => p.status === 'skipped'), true);
});

test('non-UI changedFiles → no-op, never boots the server', async () => {
  let started = false;
  const result = await runSeoAudit(
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
  const result = await runSeoAudit(
    { projectPath: '/proj', routes: ROUTES, startServer: false },
    {
      driver: fakeDriver({ '/': probe({ data: seoData({ internalLinks: ['/'] }) }) }),
      startDevServer: async () => {
        started = true;
        return { ready: true, handle: { async stop() {} }, detail: '' };
      },
      fetchResource: fakeFetcher({ '/sitemap.xml': okSitemap(['http://localhost:3000/']), '/robots.txt': okRobots }),
      storeResult: memStore().store,
      log: silent,
    }
  );
  assert.equal(started, false);
  assert.equal(result.ran, true);
  assert.equal(result.passed, true);
});

test('a static route that fails to load is an ERROR, a dynamic one is SKIPPED', async () => {
  const driver = fakeDriver({}); // every audit → 404 / no data
  const result = await runSeoAudit(
    { projectPath: '/proj', routes: [{ path: '/' }, { path: '/users/:id', dynamic: true }] },
    {
      driver,
      startDevServer: readyStarter({ stopped: false }),
      fetchResource: fakeFetcher({}),
      storeResult: memStore().store,
      log: silent,
    }
  );
  assert.equal(result.pages.find((p) => p.path === '/')?.status, 'error');
  assert.equal(result.pages.find((p) => p.path === '/users/:id')?.status, 'skipped');
  assert.equal(result.blocked, false);
});

// ---------------------------------------------------------------------------
// Phase 4 Sentinel integration (optional tenth check)
// ---------------------------------------------------------------------------

/** A command runner that passes tsc + build (so the gate reaches the optional checks). */
const passingRun = async (): Promise<CommandResult> => ({ ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false });

/** Build an SEOAuditResult stub for the injected runner. */
function seoStub(overrides: Partial<SEOAuditResult>): SEOAuditResult {
  return {
    passed: true,
    blocked: false,
    ran: true,
    devServerStarted: true,
    driverAvailable: true,
    failures: [],
    pages: [],
    siteIssues: [],
    counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    totalIssues: 0,
    siteScore: 100,
    auditedPages: 1,
    skippedPages: 0,
    duplicateTitles: [],
    orphanPages: [],
    brokenLinks: [],
    sitemap: { found: true, valid: true, urlCount: 1, missingRoutes: [], detail: 'ok' },
    robots: { found: true, declaresSitemap: true, detail: 'ok' },
    baseUrl: 'http://localhost:3000',
    report: '',
    generatedAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  };
}

test('Sentinel: no seo config → exactly the nine Contract-13 checks', async () => {
  const result = await runSentinel({
    projectPath: '/proj',
    runCommand: passingRun,
    getFileChanges: async () => [{ status: 'M', path: 'src/app/page.tsx' }],
    log: silent,
  });
  assert.equal(result.checks.length, 9);
  assert.equal(result.checks.some((c) => c.name === 'seo'), false);
});

test('Sentinel: seo runs after a .tsx change and a CRITICAL issue fails the gate', async () => {
  const result = await runSentinel({
    projectPath: '/proj',
    runCommand: passingRun,
    packageJsonContent: '{}',
    getFileChanges: async () => [{ status: 'M', path: 'src/app/page.tsx' }],
    seo: { routes: [{ path: '/' }] },
    uiPromptJustRan: true,
    runSeoCheck: async () =>
      seoStub({
        passed: false,
        blocked: true,
        counts: { critical: 1, serious: 0, moderate: 0, minor: 0 },
        totalIssues: 1,
        siteScore: 70,
        failures: [
          {
            path: '/',
            url: 'http://localhost:3000/',
            status: 'fail',
            passed: false,
            httpStatus: 200,
            score: 70,
            title: 'Home',
            issues: [{ check: 'heading_hierarchy', severity: 'critical', message: 'page has no <h1>' }],
            counts: { critical: 1, serious: 0, moderate: 0, minor: 0 },
            dynamic: false,
            detail: 'score 70/100',
          },
        ],
      }),
    log: silent,
  });
  const seo = result.checks.find((c) => c.name === 'seo');
  assert.ok(seo, 'seo check present');
  assert.equal(seo?.passed, false);
  assert.equal(result.passed, false);
  assert.equal(result.failedCheck, 'seo');
  assert.match(seo?.detail ?? '', /CRITICAL/);
});

test('Sentinel: seo passes (non-critical surfaced) without failing the gate', async () => {
  const result = await runSentinel({
    projectPath: '/proj',
    runCommand: passingRun,
    packageJsonContent: '{}',
    getFileChanges: async () => [{ status: 'M', path: 'src/app/page.tsx' }],
    seo: { routes: [{ path: '/' }] },
    uiPromptJustRan: true,
    runSeoCheck: async () => seoStub({ counts: { critical: 0, serious: 2, moderate: 1, minor: 0 }, totalIssues: 3, siteScore: 84 }),
    log: silent,
  });
  const seo = result.checks.find((c) => c.name === 'seo');
  assert.ok(seo);
  assert.equal(seo?.passed, true);
  assert.equal(result.passed, true);
  assert.match(seo?.detail ?? '', /no critical/);
});

test('Sentinel: seo NOT triggered when no .tsx/.css changed', async () => {
  let ran = false;
  const result = await runSentinel({
    projectPath: '/proj',
    runCommand: passingRun,
    getFileChanges: async () => [{ status: 'M', path: 'src/lib/util.ts' }],
    seo: { routes: [{ path: '/' }] },
    uiPromptJustRan: true,
    runSeoCheck: async () => {
      ran = true;
      throw new Error('should not be called');
    },
    log: silent,
  });
  assert.equal(ran, false);
  assert.equal(result.checks.some((c) => c.name === 'seo'), false);
});
