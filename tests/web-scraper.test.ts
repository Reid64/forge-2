/**
 * FORGE 2.0 — Web Scraper tests (pure `node:test`; no network, no browser, no DB).
 *
 * Covers the reusable-config resolver (`resolveScrapingConfig`), the pure helpers (`backoffDelay`,
 * `detectCaptcha`, `needsDynamicRendering`, `extractTitle`/`extractText`/`extractLinks`/`extractJsonLd`,
 * `generateHeaders`, `redactProxy`), the success-rate `ProxyPool`, and the `runWebScrape` orchestrator
 * over an INJECTED fake engine + capturing store + fixed clock/RNG: static success, adaptive escalation
 * (static SPA shell → dynamic re-fetch), CAPTCHA detection → pause → subsequent URLs skipped, the
 * engine-unavailable SKIP, proxy rotation wiring, the Build-Memory record, and the three mode classes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runWebScrape,
  resolveScrapingConfig,
  backoffDelay,
  detectCaptcha,
  needsDynamicRendering,
  extractTitle,
  extractText,
  extractLinks,
  extractJsonLd,
  generateHeaders,
  redactProxy,
  ProxyPool,
  StaticScraper,
  DynamicScraper,
  AdaptiveScraper,
  DEFAULT_USER_AGENTS,
  type ScrapeEngineFactory,
  type RawScrape,
  type ScrapeStoredRecord,
  type ResolvedMode,
} from '../src/tools/web-scraper.js';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const AT = '2026-06-11T00:00:00.000Z';

interface Fixture {
  body?: string | null;
  status?: number | null;
  error?: string;
}

/** A fake engine factory scripted per-mode by URL → fixture. Drives the real hooks (proxy + captcha). */
function fakeFactory(
  byMode: { static?: Record<string, Fixture>; dynamic?: Record<string, Fixture> },
  opts: { available?: boolean } = {}
): ScrapeEngineFactory {
  return async (mode: ResolvedMode, _config, hooks) => {
    if (opts.available === false) return null;
    const table = (mode === 'static' ? byMode.static : byMode.dynamic) ?? {};
    return {
      mode,
      async run(urls: string[]): Promise<RawScrape[]> {
        const out: RawScrape[] = [];
        for (const url of urls) {
          if (hooks.isPaused()) break;
          const proxy = hooks.pickProxy();
          const fx: Fixture = table[url] ?? {
            body: `<html><head><title>${url}</title></head><body>ok ${url}</body></html>`,
            status: 200,
          };
          const status = fx.status === undefined ? 200 : fx.status;
          const body = fx.error ? null : fx.body === undefined ? '<html></html>' : fx.body;
          hooks.recordProxyResult(proxy, !fx.error && (status === null || status < 400));
          const hit = hooks.inspectForCaptcha(body, status);
          if (hit.detected) hooks.notifyCaptcha(hit, url, status);
          out.push({
            url,
            finalUrl: url,
            httpStatus: status,
            body,
            mode,
            proxyUsed: proxy,
            attempts: 1,
            error: fx.error ?? null,
          });
        }
        return out;
      },
      async close(): Promise<void> {},
    };
  };
}

function capturingStore(): { records: ScrapeStoredRecord[]; store: (r: ScrapeStoredRecord) => Promise<void> } {
  const records: ScrapeStoredRecord[] = [];
  return { records, store: async (r) => void records.push(r) };
}

function baseOptions(factory: ScrapeEngineFactory, store: (r: ScrapeStoredRecord) => Promise<void>) {
  return { engineFactory: factory, store, now: () => AT, random: () => 0, log: () => {} };
}

// ---------------------------------------------------------------------------
// resolveScrapingConfig
// ---------------------------------------------------------------------------

test('resolveScrapingConfig fills sensible defaults', () => {
  const c = resolveScrapingConfig();
  assert.equal(c.mode, 'adaptive');
  assert.equal(c.maxConcurrency, 10);
  assert.equal(c.maxRetries, 3);
  assert.equal(c.minRetryDelayMs, 1000);
  assert.equal(c.maxRetryDelayMs, 30000);
  assert.equal(c.maxRequestsPerCrawl, null);
  assert.equal(c.antiDetection.enabled, true);
  assert.equal(c.antiDetection.generateHeaders, true);
  assert.equal(c.antiDetection.tlsFingerprintMimic, true);
  assert.deepEqual(c.antiDetection.userAgents, [...DEFAULT_USER_AGENTS]);
  assert.equal(c.captcha.enabled, true);
  assert.equal(c.captcha.pauseOnDetection, true);
  assert.ok(c.captcha.signatures.includes('g-recaptcha'));
  assert.deepEqual(c.proxy.urls, []);
  assert.equal(c.proxy.minSuccessRate, 0.3);
});

test('resolveScrapingConfig respects overrides + clamps', () => {
  const c = resolveScrapingConfig({
    mode: 'static',
    maxConcurrency: 4,
    maxRequestsPerCrawl: 50,
    proxy: { urls: ['http://p'], minSuccessRate: 2 /* clamps to 1 */ },
    antiDetection: { userAgents: ['UA/1'], browsers: ['edge'] },
    captcha: { signatures: ['my-wall'] },
  });
  assert.equal(c.mode, 'static');
  assert.equal(c.maxConcurrency, 4);
  assert.equal(c.maxRequestsPerCrawl, 50);
  assert.equal(c.proxy.minSuccessRate, 1);
  assert.deepEqual(c.antiDetection.userAgents, ['UA/1']);
  assert.deepEqual(c.antiDetection.browsers, ['edge']);
  assert.ok(c.captcha.signatures.includes('my-wall'));
});

// ---------------------------------------------------------------------------
// backoffDelay
// ---------------------------------------------------------------------------

test('backoffDelay doubles per attempt and caps', () => {
  assert.equal(backoffDelay(1, 1000, 30000), 1000);
  assert.equal(backoffDelay(2, 1000, 30000), 2000);
  assert.equal(backoffDelay(3, 1000, 30000), 4000);
  assert.equal(backoffDelay(10, 1000, 30000), 30000); // capped
  assert.equal(backoffDelay(0, 1000, 30000), 1000); // floored to attempt 1
});

test('backoffDelay applies full jitter from the RNG', () => {
  assert.equal(backoffDelay(3, 1000, 30000, () => 0), 0);
  assert.equal(backoffDelay(3, 1000, 30000, () => 0.5), 2000);
  assert.equal(backoffDelay(3, 1000, 30000, () => 1), 4000);
});

// ---------------------------------------------------------------------------
// detectCaptcha
// ---------------------------------------------------------------------------

test('detectCaptcha matches body signatures, status, and custom signatures', () => {
  assert.equal(detectCaptcha('<div class="g-recaptcha"></div>', 200).detected, true);
  assert.equal(detectCaptcha('hello world', 200).detected, false);
  const byStatus = detectCaptcha('hello', 429);
  assert.equal(byStatus.detected, true);
  assert.equal(byStatus.source, 'status');
  assert.equal(detectCaptcha('hello', 403).detected, true);
  // custom signature list (built-ins not included → plain 200 page is clean)
  assert.equal(detectCaptcha('please solve the WALL', 200, ['wall']).detected, true);
  assert.equal(detectCaptcha('<div class="g-recaptcha">', 200, ['wall']).detected, false);
});

// ---------------------------------------------------------------------------
// needsDynamicRendering
// ---------------------------------------------------------------------------

test('needsDynamicRendering distinguishes SPA shells from server-rendered pages', () => {
  assert.equal(needsDynamicRendering(null), true);
  assert.equal(needsDynamicRendering(''), true);
  assert.equal(needsDynamicRendering('<html><body><div id="root"></div></body></html>'), true);
  assert.equal(needsDynamicRendering('<html><body><app-root></app-root></body></html>'), true);
  const thin = '<html><body><div id="x"></div><script></script><script></script><script></script></body></html>';
  assert.equal(needsDynamicRendering(thin), true);
  const rich = `<html><body><article>${'word '.repeat(80)}</article></body></html>`;
  assert.equal(needsDynamicRendering(rich), false);
});

// ---------------------------------------------------------------------------
// extraction helpers
// ---------------------------------------------------------------------------

test('extractTitle / extractText decode entities and strip markup', () => {
  assert.equal(extractTitle('<title>Hello &amp; World</title>'), 'Hello & World');
  assert.equal(extractTitle('<p>no title</p>'), null);
  const text = extractText('<style>.a{}</style><script>var x=1</script><h1>Hi&nbsp;there</h1>');
  assert.equal(text, 'Hi there');
});

test('extractLinks absolutizes, dedupes, and skips non-navigational hrefs', () => {
  const html =
    '<a href="/a">A</a><a href="https://x.com/b">B</a><a href="#frag">F</a>' +
    '<a href="mailto:x@y.com">M</a><a href="/a">dup</a>';
  const links = extractLinks(html, 'https://site.test/page');
  assert.deepEqual(links, ['https://site.test/a', 'https://x.com/b']);
});

test('extractJsonLd parses object and array LD blocks, ignores malformed', () => {
  const html =
    '<script type="application/ld+json">{"@type":"Org","name":"X"}</script>' +
    '<script type="application/ld+json">[{"a":1},{"b":2}]</script>' +
    '<script type="application/ld+json">{bad json}</script>';
  const ld = extractJsonLd(html);
  assert.equal(ld.length, 3);
  assert.equal(ld[0]?.['name'], 'X');
});

test('generateHeaders builds a believable header set', () => {
  const h = generateHeaders(['UA/9'], ['en-US', 'fr']);
  assert.equal(h['User-Agent'], 'UA/9');
  assert.equal(h['Accept-Language'], 'en-US,fr;q=0.9');
  assert.ok(h['Accept'].includes('text/html'));
});

test('redactProxy hides credentials', () => {
  assert.equal(redactProxy('http://user:pass@host:8080'), 'http://***@host:8080');
  assert.equal(redactProxy('http://host:8080'), 'http://host:8080');
});

// ---------------------------------------------------------------------------
// ProxyPool
// ---------------------------------------------------------------------------

test('ProxyPool benches a low-success proxy and prefers the healthy one', () => {
  const pool = new ProxyPool(['http://good', 'http://bad'], { minSuccessRate: 0.5, minSamples: 4 });
  // Make "bad" demonstrably unhealthy: 4 attempts, 0 success.
  for (let i = 0; i < 4; i++) pool.record('http://bad', false);
  // "good" healthy: 4 attempts, all success.
  for (let i = 0; i < 4; i++) pool.record('http://good', true);
  for (let i = 0; i < 5; i++) assert.equal(pool.pick(), 'http://good');
  const stats = pool.stats();
  const bad = stats.find((s) => s.url === 'http://bad');
  assert.equal(bad?.healthy, false);
  assert.equal(bad?.successRate, 0);
});

test('ProxyPool returns null when empty and round-robins fresh proxies', () => {
  assert.equal(new ProxyPool([]).pick(), null);
  const pool = new ProxyPool(['http://a', 'http://b']);
  const picks = [pool.pick(), pool.pick()];
  assert.deepEqual(new Set(picks), new Set(['http://a', 'http://b']));
});

// ---------------------------------------------------------------------------
// runWebScrape — orchestration
// ---------------------------------------------------------------------------

test('runWebScrape: static mode returns standardized success results', async () => {
  const { records, store } = capturingStore();
  const factory = fakeFactory({
    static: { 'https://a.test': { body: '<head><title>A</title></head><body>hello world</body>', status: 200 } },
  });
  const res = await runWebScrape(
    { urls: ['https://a.test'], config: { mode: 'static' }, projectName: 'proj' },
    baseOptions(factory, store)
  );
  assert.equal(res.passed, true);
  assert.equal(res.succeeded, 1);
  assert.equal(res.results.length, 1);
  const r = res.results[0];
  assert.equal(r?.status, 'success');
  assert.equal(r?.mode, 'static');
  assert.equal(r?.title, 'A');
  assert.match(r?.text ?? '', /hello world/);
  assert.equal(r?.scrapedAt, AT);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.succeeded, 1);
  assert.equal(records[0]?.projectName, 'proj');
});

test('runWebScrape: adaptive escalates only SPA shells to the dynamic engine', async () => {
  const { store } = capturingStore();
  const richStatic = `<html><body><article>${'word '.repeat(80)}</article><title>Static</title></html>`;
  const factory = fakeFactory({
    static: {
      'https://spa.test': { body: '<html><body><div id="root"></div></body></html>', status: 200 },
      'https://srv.test': { body: richStatic, status: 200 },
    },
    dynamic: {
      'https://spa.test': { body: '<html><head><title>Rendered</title></head><body>app content</body></html>', status: 200 },
    },
  });
  const res = await runWebScrape(
    { urls: ['https://spa.test', 'https://srv.test'], config: { mode: 'adaptive' } },
    baseOptions(factory, store)
  );
  const spa = res.results.find((r) => r.url === 'https://spa.test');
  const srv = res.results.find((r) => r.url === 'https://srv.test');
  assert.equal(spa?.mode, 'dynamic');
  assert.equal(spa?.title, 'Rendered');
  assert.equal(srv?.mode, 'static');
  assert.equal(res.succeeded, 2);
});

test('runWebScrape: CAPTCHA pauses the crawl, alerts, and skips remaining URLs', async () => {
  const { store } = capturingStore();
  const alerts: string[] = [];
  const factory = fakeFactory({
    static: {
      'https://wall.test': { body: '<div class="g-recaptcha"></div>', status: 200 },
      'https://next.test': { body: '<title>Next</title>', status: 200 },
    },
  });
  const res = await runWebScrape(
    {
      urls: ['https://wall.test', 'https://next.test'],
      config: { mode: 'static', captcha: { onDetected: (e) => void alerts.push(e.url) } },
    },
    baseOptions(factory, store)
  );
  assert.equal(res.paused, true);
  assert.equal(res.passed, false);
  assert.equal(res.captchaCount, 1);
  const wall = res.results.find((r) => r.url === 'https://wall.test');
  const next = res.results.find((r) => r.url === 'https://next.test');
  assert.equal(wall?.status, 'captcha');
  assert.equal(wall?.captchaDetected, true);
  assert.equal(next?.status, 'skipped');
  assert.match(next?.error ?? '', /paused/i);
  assert.deepEqual(alerts, ['https://wall.test']);
});

test('runWebScrape: engine-unavailable yields skipped results, never a fabricated success', async () => {
  const { store } = capturingStore();
  const factory = fakeFactory({}, { available: false });
  const res = await runWebScrape(
    { urls: ['https://a.test'], config: { mode: 'dynamic' } },
    baseOptions(factory, store)
  );
  assert.equal(res.succeeded, 0);
  assert.equal(res.skipped, 1);
  assert.equal(res.results[0]?.status, 'skipped');
  assert.match(res.results[0]?.error ?? '', /unavailable/i);
});

test('runWebScrape: proxy pool is exercised and reported', async () => {
  const { store } = capturingStore();
  const factory = fakeFactory({ static: {} });
  const res = await runWebScrape(
    { urls: ['https://a.test', 'https://b.test'], config: { mode: 'static', proxy: { urls: ['http://p1', 'http://p2'] } } },
    baseOptions(factory, store)
  );
  const totalAttempts = res.proxyStats.reduce((n, p) => n + p.attempts, 0);
  assert.equal(totalAttempts, 2);
  assert.ok(res.proxyStats.every((p) => p.healthy));
});

test('runWebScrape: empty URL list is a no-op pass', async () => {
  const { store } = capturingStore();
  const res = await runWebScrape({ urls: [] }, baseOptions(fakeFactory({}), store));
  assert.equal(res.passed, true);
  assert.equal(res.totalRequested, 0);
});

// ---------------------------------------------------------------------------
// Mode classes
// ---------------------------------------------------------------------------

test('mode classes force their engine mode', async () => {
  const { store } = capturingStore();
  const factory = fakeFactory({
    static: { 'https://s.test': { body: '<title>S</title>', status: 200 } },
    dynamic: { 'https://d.test': { body: '<title>D</title>', status: 200 } },
  });
  const opts = baseOptions(factory, store);

  const s = await new StaticScraper({}, opts).scrape(['https://s.test']);
  assert.equal(s.results[0]?.mode, 'static');

  const d = await new DynamicScraper({}, opts).scrape(['https://d.test']);
  assert.equal(d.results[0]?.mode, 'dynamic');

  const a = new AdaptiveScraper({}, opts);
  const r = await a.scrape(['https://s.test']);
  assert.equal(r.mode, 'adaptive');
});
