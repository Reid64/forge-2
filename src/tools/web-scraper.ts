/**
 * FORGE 2.0 — Web Scraper (`src/tools/web-scraper.ts`).
 *
 * The PRODUCTION web-scraping engine for FORGE itself (Phase 1B research, browser tasks, telemetry
 * back-channels) AND a reusable, dependency-injected library that any FORGE-built project can import
 * to scrape the web safely. It is built on **Crawlee** (https://crawlee.dev) — the maintained
 * successor to Apify SDK — which supplies request-queue management, concurrency control, automatic
 * retries, header generation and browser fingerprinting out of the box.
 *
 * THREE SCRAPING MODES (each exposed both as a class and via the `mode` config field):
 *   - {@link StaticScraper}  — `CheerioCrawler`: fast HTTP + server-side HTML parsing. No browser.
 *                              Right for static / server-rendered pages. Cheapest and fastest.
 *   - {@link DynamicScraper} — `PlaywrightCrawler`: a real Chromium renders the page, so
 *                              JavaScript-built DOM and client-side data are captured.
 *   - {@link AdaptiveScraper}— probes each URL with the static engine first and, when the returned
 *                              HTML looks like an un-hydrated SPA shell (see {@link needsDynamicRendering}),
 *                              automatically re-fetches just those URLs with the dynamic engine.
 *
 * BUILT-IN CAPABILITIES (all configurable through one reusable {@link ScrapingConfig}):
 *   - Anti-detection: automatic realistic-header generation + TLS/browser fingerprint mimicking.
 *     The static engine leans on Crawlee/got-scraping's header generator + ja3 TLS mimicking; the
 *     dynamic engine uses Crawlee's fingerprint-injecting browser pool. {@link generateHeaders} is the
 *     pure fallback header generator (and the source of the custom user-agent pool).
 *   - Proxy support with automatic rotation driven by per-proxy SUCCESS RATE ({@link ProxyPool}):
 *     unhealthy proxies (success rate below a floor after a minimum sample) drop out of rotation.
 *   - CAPTCHA detection ({@link detectCaptcha}) that, on a hit, PAUSES the crawl and fires an alert
 *     callback rather than hammering a challenge wall.
 *   - Request-queue management with concurrency control + automatic retry with exponential backoff
 *     ({@link backoffDelay}).
 *   - Standardized {@link ScrapedResult} output objects, and a run-level {@link ScrapeRunResult}.
 *   - Results stored in Build Memory (`production_telemetry`, `forge-web-scraper` bucket — Contract 4).
 *
 * HOUSE STYLE (matches `security-scanner`, `accessibility-auditor`, `visual-regression`): NON-FATAL and
 * never throws (Iron Law 3). A precondition that cannot be met — Crawlee not installed, a browser that
 * won't launch, a URL that won't load — is reported as a `skipped`/`failed` {@link ScrapedResult} with a
 * note, NEVER a fabricated success. Crawlee is a RUNTIME-OPTIONAL dependency, imported through an
 * indirect specifier so the project type-checks/builds before `pnpm add crawlee` (the scrape then SKIPs).
 * Every external collaborator — the crawler engine, the Build-Memory store, the clock, the RNG — is
 * injectable, so the orchestrator and all pure helpers unit-test with no network and no browser.
 *
 * BOUNDARY (Iron Law 1): reads remote pages only; writes NOTHING to the target filesystem and never
 * touches a governance file. Proxy credentials and headers are passed through but never logged.
 */

import { BuildMemory, nowIso } from '../memory/index.js';
import { logLine } from './forge-logger.js';
import type { JsonObject, TelemetryEventType, TelemetrySeverity } from '../types/index.js';

// ===========================================================================
// Public contract — the reusable scraping configuration
// ===========================================================================

/** Which engine drives a scrape. `adaptive` auto-selects per URL. */
export type ScrapeMode = 'static' | 'dynamic' | 'adaptive';

/** The concrete engine that actually fetched a page (`adaptive` resolves to one of these per URL). */
export type ResolvedMode = 'static' | 'dynamic';

/** Anti-detection knobs: header generation + TLS/browser fingerprint mimicking. */
export interface AntiDetectionConfig {
  /** Master switch. Default true. */
  enabled?: boolean;
  /** Generate realistic per-request headers (UA, Accept, Accept-Language, …). Default true. */
  generateHeaders?: boolean;
  /** Mimic a real browser's TLS (ja3) + HTTP/2 fingerprint (static engine) / inject a browser
   *  fingerprint (dynamic engine). Default true. */
  tlsFingerprintMimic?: boolean;
  /** Browsers the fingerprint generator may imitate. Default chrome + firefox + safari. */
  browsers?: Array<'chrome' | 'firefox' | 'safari' | 'edge'>;
  /** Devices the fingerprint generator may imitate. Default desktop. */
  devices?: Array<'desktop' | 'mobile'>;
  /** Locales advertised in `Accept-Language`. Default `['en-US']`. */
  locales?: string[];
  /** Optional custom user-agent pool (overrides the built-in pool for {@link generateHeaders}). */
  userAgents?: string[];
}

/** Proxy pool + success-rate-driven rotation policy. */
export interface ProxyConfig {
  /** Proxy URLs (e.g. `http://user:pass@host:port`). Empty / omitted ⇒ no proxy. */
  urls?: string[];
  /** Rotate to a different proxy after a failed request. Default true. */
  rotateOnFailure?: boolean;
  /** Drop a proxy from healthy rotation once its success rate falls below this (0–1). Default 0.3. */
  minSuccessRate?: number;
  /** Minimum attempts on a proxy before its success rate is trusted enough to bench it. Default 5. */
  minSamples?: number;
}

/** A CAPTCHA / bot-wall detection hit. */
export interface CaptchaHit {
  /** Whether a challenge was detected. */
  detected: boolean;
  /** The signature that matched (provider name / token), or null. */
  signature: string | null;
  /** What surfaced it. */
  source: 'status' | 'body' | null;
}

/** An alert payload delivered to {@link CaptchaConfig.onDetected}. */
export interface CaptchaEvent {
  url: string;
  signature: string | null;
  source: 'status' | 'body' | null;
  httpStatus: number | null;
  detectedAt: string;
}

/** CAPTCHA detection + pause/alert policy. */
export interface CaptchaConfig {
  /** Master switch. Default true. */
  enabled?: boolean;
  /** PAUSE the crawl (stop dispatching new requests) on the first CAPTCHA. Default true. */
  pauseOnDetection?: boolean;
  /** Extra case-insensitive body signatures to treat as a challenge, on top of the built-ins. */
  signatures?: string[];
  /** Alert sink invoked once per detected CAPTCHA. Never awaited destructively (errors are swallowed). */
  onDetected?: (event: CaptchaEvent) => void | Promise<void>;
}

/**
 * The reusable scraping configuration — the single object any FORGE-built project passes to scrape the
 * web. Every field is optional; {@link resolveScrapingConfig} fills defaults.
 */
export interface ScrapingConfig {
  /** Engine selection. Default `adaptive`. */
  mode?: ScrapeMode;
  /** Max concurrent requests (queue concurrency control). Default 10. */
  maxConcurrency?: number;
  /** Hard cap on total requests processed in one run (queue guard). Default: unbounded. */
  maxRequestsPerCrawl?: number;
  /** Retries per request before it is marked failed. Default 3. */
  maxRetries?: number;
  /** Exponential-backoff base delay (ms) for the first retry. Default 1000. */
  minRetryDelayMs?: number;
  /** Exponential-backoff ceiling (ms). Default 30000. */
  maxRetryDelayMs?: number;
  /** Per-request timeout (ms). Default 30000. */
  requestTimeoutMs?: number;
  /** Per-navigation timeout for the dynamic engine (ms). Default 30000. */
  navigationTimeoutMs?: number;
  /** Run the dynamic engine's browser headless. Default true. */
  headless?: boolean;
  /** Follow + enqueue same-origin links discovered on each page (bounded by `maxRequestsPerCrawl`). Default false. */
  followLinks?: boolean;
  /** Max characters of raw HTML retained on each {@link ScrapedResult}. Default 500000. */
  maxHtmlChars?: number;
  /** Max characters of extracted text retained on each {@link ScrapedResult}. Default 100000. */
  maxTextChars?: number;
  /** Anti-detection policy. */
  antiDetection?: AntiDetectionConfig;
  /** Proxy policy. */
  proxy?: ProxyConfig;
  /** CAPTCHA policy. */
  captcha?: CaptchaConfig;
}

/** A fully-defaulted {@link ScrapingConfig} (every field present). */
export interface ResolvedScrapingConfig {
  mode: ScrapeMode;
  maxConcurrency: number;
  maxRequestsPerCrawl: number | null;
  maxRetries: number;
  minRetryDelayMs: number;
  maxRetryDelayMs: number;
  requestTimeoutMs: number;
  navigationTimeoutMs: number;
  headless: boolean;
  followLinks: boolean;
  maxHtmlChars: number;
  maxTextChars: number;
  antiDetection: Required<Omit<AntiDetectionConfig, 'userAgents'>> & { userAgents: string[] };
  proxy: Required<Omit<ProxyConfig, 'urls'>> & { urls: string[] };
  captcha: Required<Omit<CaptchaConfig, 'onDetected' | 'signatures'>> & {
    signatures: string[];
    onDetected: ((event: CaptchaEvent) => void | Promise<void>) | null;
  };
}

// ===========================================================================
// Public contract — results
// ===========================================================================

/** Outcome of scraping one URL. */
export type ScrapeStatus = 'success' | 'failed' | 'captcha' | 'skipped';

/** The STANDARDIZED per-URL output object. */
export interface ScrapedResult {
  /** The requested URL. */
  url: string;
  /** The final URL after redirects (equals `url` when none / unknown). */
  finalUrl: string;
  /** Overall status for this URL. */
  status: ScrapeStatus;
  /** HTTP status code, or null when the request never completed. */
  httpStatus: number | null;
  /** The engine that actually fetched the page, or null when skipped before fetch. */
  mode: ResolvedMode | null;
  /** `<title>` text, or null. */
  title: string | null;
  /** Raw HTML (truncated to `maxHtmlChars`), or null. */
  html: string | null;
  /** Visible text extracted from the HTML (truncated to `maxTextChars`), or null. */
  text: string | null;
  /** Structured data extracted from the page (currently `{ jsonLd: [...] }`); extensible per project. */
  data: JsonObject;
  /** Absolute links discovered on the page (deduped). */
  links: string[];
  /** True when a CAPTCHA / bot wall was detected for this URL. */
  captchaDetected: boolean;
  /** The matched CAPTCHA signature, or null. */
  captchaSignature: string | null;
  /** Proxy URL used for the (last) attempt, or null. */
  proxyUsed: string | null;
  /** Number of attempts made (1 + retries). */
  attempts: number;
  /** Error detail when `status` is `failed`/`skipped`, else null. */
  error: string | null;
  /** ISO timestamp when this result was finalized. */
  scrapedAt: string;
}

/** Per-proxy health snapshot. */
export interface ProxyStat {
  url: string;
  attempts: number;
  successes: number;
  failures: number;
  /** successes / attempts (0 when no attempts). */
  successRate: number;
  /** Whether the proxy is still in healthy rotation. */
  healthy: boolean;
}

/** The run-level result for a whole scrape job. */
export interface ScrapeRunResult {
  /** True when no URL ended in `failed` and the crawl was not paused by a CAPTCHA. */
  passed: boolean;
  /** Configured mode for the run. */
  mode: ScrapeMode;
  /** Standardized per-URL results, in request order. */
  results: ScrapedResult[];
  totalRequested: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** How many URLs hit a CAPTCHA. */
  captchaCount: number;
  /** True when the crawl was paused after a CAPTCHA (per {@link CaptchaConfig.pauseOnDetection}). */
  paused: boolean;
  /** Per-proxy health at the end of the run. */
  proxyStats: ProxyStat[];
  /** Human-readable markdown report. */
  report: string;
  /** ISO timestamp of completion. */
  generatedAt: string;
}

// ===========================================================================
// Public contract — input + injectable collaborators
// ===========================================================================

/** Input to {@link runWebScrape}. */
export interface WebScrapeInput {
  /** URLs to scrape (the crawl's start requests). */
  urls: string[];
  /** Scraping configuration (defaults applied by {@link resolveScrapingConfig}). */
  config?: ScrapingConfig;
  /** Project the results belong to (for the Build-Memory record). Default `forge`. */
  projectName?: string;
  /** Owning build run id (Build-Memory FK), or null. */
  buildRunId?: string | null;
}

/** A normalized fetch outcome produced by a {@link ScrapeEngine}, before extraction/standardization. */
export interface RawScrape {
  url: string;
  finalUrl: string;
  httpStatus: number | null;
  /** Raw HTML body (un-truncated), or null when the fetch failed before a body. */
  body: string | null;
  /** Engine that produced this. */
  mode: ResolvedMode;
  proxyUsed: string | null;
  attempts: number;
  error: string | null;
}

/** Callbacks a {@link ScrapeEngine} uses to drive proxy rotation + CAPTCHA pausing during a crawl. */
export interface EngineHooks {
  /** Pick the proxy URL for the next request (success-rate weighted), or null when none configured. */
  pickProxy(): string | null;
  /** Record a request's outcome against the proxy it used (drives rotation health). */
  recordProxyResult(proxyUrl: string | null, ok: boolean): void;
  /** Inspect a fetched page for a CAPTCHA / bot wall. */
  inspectForCaptcha(body: string | null, httpStatus: number | null): CaptchaHit;
  /** Report a detected CAPTCHA (fires the alert + may request a pause). */
  notifyCaptcha(hit: CaptchaHit, url: string, httpStatus: number | null): void;
  /** True once a pause has been requested — the engine should stop dispatching new requests. */
  isPaused(): boolean;
  /** A jitter sample in [0,1) for exponential-backoff de-correlation (wraps the injected RNG). */
  nextJitter(): number;
  log(message: string): void;
}

/** An engine that fetches a batch of URLs. The default is Crawlee; tests inject a fake. */
export interface ScrapeEngine {
  readonly mode: ResolvedMode;
  /** Fetch every URL (queue + concurrency + retries are the engine's responsibility). */
  run(urls: string[]): Promise<RawScrape[]>;
  /** Release resources (browser / pool). */
  close(): Promise<void>;
}

/**
 * Build an engine for `mode`, or null when the engine is unavailable (e.g. Crawlee not installed) — the
 * run then SKIPs every URL for that engine rather than failing.
 */
export type ScrapeEngineFactory = (
  mode: ResolvedMode,
  config: ResolvedScrapingConfig,
  hooks: EngineHooks
) => Promise<ScrapeEngine | null>;

/** The record persisted to Build Memory. */
export interface ScrapeStoredRecord {
  projectName: string;
  buildRunId: string | null;
  mode: ScrapeMode;
  totalRequested: number;
  succeeded: number;
  failed: number;
  skipped: number;
  captchaCount: number;
  paused: boolean;
  proxyStats: ProxyStat[];
  perUrl: Array<{ url: string; status: ScrapeStatus; httpStatus: number | null; mode: ResolvedMode | null }>;
  generatedAt: string;
}

/** Injectable collaborators for {@link runWebScrape}. */
export interface WebScraperOptions {
  /** Override the engine factory (default: the Crawlee factory). */
  engineFactory?: ScrapeEngineFactory;
  /** Override the Build-Memory sink (default: a guarded `production_telemetry` write). */
  store?: (record: ScrapeStoredRecord) => Promise<void>;
  /** Clock (default {@link nowIso}). */
  now?: () => string;
  /** Deterministic RNG in [0,1) for backoff jitter (default `Math.random`). */
  random?: () => number;
  /** Logger (default: FORGE's structured logger, `forge-logger`, tagged `scraper`). */
  log?: (message: string) => void;
}

// ===========================================================================
// Defaults + config resolution
// ===========================================================================

/** A small pool of realistic, current desktop user agents (used when no custom pool is supplied). */
export const DEFAULT_USER_AGENTS: readonly string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

/** Built-in CAPTCHA / bot-wall body signatures (case-insensitive substrings). */
export const DEFAULT_CAPTCHA_SIGNATURES: readonly string[] = [
  'g-recaptcha',
  'recaptcha/api.js',
  'grecaptcha',
  'h-captcha',
  'hcaptcha.com',
  'data-sitekey',
  'cf-challenge',
  'cf-turnstile',
  'challenges.cloudflare.com',
  '/cdn-cgi/challenge-platform',
  'px-captcha',
  '_px',
  'datadome',
  'are you a robot',
  'are you a human',
  'unusual traffic',
  'verify you are human',
  'please enable javascript and cookies',
  'access denied',
];

/** Fill every {@link ScrapingConfig} default, producing a {@link ResolvedScrapingConfig}. */
export function resolveScrapingConfig(config: ScrapingConfig = {}): ResolvedScrapingConfig {
  const ad = config.antiDetection ?? {};
  const px = config.proxy ?? {};
  const cap = config.captcha ?? {};
  const userAgents = ad.userAgents && ad.userAgents.length > 0 ? [...ad.userAgents] : [...DEFAULT_USER_AGENTS];

  return {
    mode: config.mode ?? 'adaptive',
    maxConcurrency: positive(config.maxConcurrency, 10),
    maxRequestsPerCrawl:
      typeof config.maxRequestsPerCrawl === 'number' && config.maxRequestsPerCrawl > 0
        ? Math.floor(config.maxRequestsPerCrawl)
        : null,
    maxRetries: nonNegative(config.maxRetries, 3),
    minRetryDelayMs: positive(config.minRetryDelayMs, 1000),
    maxRetryDelayMs: positive(config.maxRetryDelayMs, 30000),
    requestTimeoutMs: positive(config.requestTimeoutMs, 30000),
    navigationTimeoutMs: positive(config.navigationTimeoutMs, 30000),
    headless: config.headless ?? true,
    followLinks: config.followLinks ?? false,
    maxHtmlChars: positive(config.maxHtmlChars, 500000),
    maxTextChars: positive(config.maxTextChars, 100000),
    antiDetection: {
      enabled: ad.enabled ?? true,
      generateHeaders: ad.generateHeaders ?? true,
      tlsFingerprintMimic: ad.tlsFingerprintMimic ?? true,
      browsers: ad.browsers && ad.browsers.length > 0 ? [...ad.browsers] : ['chrome', 'firefox', 'safari'],
      devices: ad.devices && ad.devices.length > 0 ? [...ad.devices] : ['desktop'],
      locales: ad.locales && ad.locales.length > 0 ? [...ad.locales] : ['en-US'],
      userAgents,
    },
    proxy: {
      urls: px.urls ? [...px.urls] : [],
      rotateOnFailure: px.rotateOnFailure ?? true,
      minSuccessRate: clamp01(px.minSuccessRate ?? 0.3),
      minSamples: nonNegative(px.minSamples, 5),
    },
    captcha: {
      enabled: cap.enabled ?? true,
      pauseOnDetection: cap.pauseOnDetection ?? true,
      signatures: dedupeLower([...DEFAULT_CAPTCHA_SIGNATURES, ...(cap.signatures ?? [])]),
      onDetected: cap.onDetected ?? null,
    },
  };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function dedupeLower(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase().trim();
    if (k === '' || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

// ===========================================================================
// Pure helper — exponential backoff
// ===========================================================================

/**
 * Exponential backoff with optional full jitter. `attempt` is the 1-based retry number. The base delay
 * doubles each attempt, capped at `capMs`. When `jitter` is supplied (an RNG in [0,1)), the result is
 * uniformly sampled in `[0, delay]` (full-jitter) to de-correlate concurrent retries.
 */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  capMs: number,
  jitter?: () => number
): number {
  const safeAttempt = attempt < 1 ? 1 : Math.floor(attempt);
  const exp = baseMs * Math.pow(2, safeAttempt - 1);
  const capped = Math.min(capMs, exp);
  if (!jitter) return Math.round(capped);
  const r = jitter();
  const factor = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 1;
  return Math.round(capped * factor);
}

// ===========================================================================
// Pure helper — CAPTCHA detection
// ===========================================================================

/**
 * Detect a CAPTCHA / bot wall from a response. A 403/429 status OR any configured body signature counts.
 * Pure and case-insensitive; `signatures` defaults to {@link DEFAULT_CAPTCHA_SIGNATURES}.
 */
export function detectCaptcha(
  body: string | null,
  httpStatus: number | null,
  signatures: readonly string[] = DEFAULT_CAPTCHA_SIGNATURES
): CaptchaHit {
  const hay = (body ?? '').toLowerCase();
  for (const sig of signatures) {
    const needle = sig.toLowerCase().trim();
    if (needle !== '' && hay.includes(needle)) {
      return { detected: true, signature: sig, source: 'body' };
    }
  }
  if (httpStatus === 403 || httpStatus === 429) {
    return { detected: true, signature: `http_${httpStatus}`, source: 'status' };
  }
  return { detected: false, signature: null, source: null };
}

// ===========================================================================
// Pure helper — adaptive mode detection
// ===========================================================================

/** Tunables for {@link needsDynamicRendering}. */
export interface DynamicHeuristicOptions {
  /** Below this many visible-text characters the page is "thin". Default 200. */
  minTextChars?: number;
  /** With this many `<script>` tags a thin page is treated as a JS app. Default 3. */
  minScriptTags?: number;
}

/**
 * Heuristic: does this HTML need a real browser to render? True when the body is empty, advertises a
 * "please enable JavaScript" notice, exposes a well-known empty SPA mount point, or is thin on visible
 * text while heavy on `<script>` tags. Conservative — server-rendered pages (which carry real text)
 * return false, so adaptive mode only escalates to the costly dynamic engine when it is likely needed.
 */
export function needsDynamicRendering(
  html: string | null,
  options: DynamicHeuristicOptions = {}
): boolean {
  if (html === null || html.trim() === '') return true;
  const minText = options.minTextChars ?? 200;
  const minScripts = options.minScriptTags ?? 3;
  const lower = html.toLowerCase();

  if (/<noscript[^>]*>[^<]*(enable|turn on)\s+javascript/i.test(html)) return true;

  // Empty SPA mount points emitted by common frameworks before hydration.
  const emptyMount =
    /<div[^>]+id=["'](?:root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(html) ||
    /<(app-root|ng-component)[^>]*>\s*<\/\1>/i.test(html);
  if (emptyMount) return true;

  const text = extractText(html);
  const scriptCount = (lower.match(/<script\b/g) ?? []).length;
  return text.length < minText && scriptCount >= minScripts;
}

// ===========================================================================
// Pure helpers — extraction
// ===========================================================================

/** Extract `<title>` text (decoded, trimmed), or null. */
export function extractTitle(html: string | null): string | null {
  if (!html) return null;
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m || m[1] === undefined) return null;
  const title = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  return title === '' ? null : title;
}

/** Strip scripts/styles/tags and collapse whitespace to recover visible text. */
export function extractText(html: string | null): string {
  if (!html) return '';
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const withoutTags = withoutBlocks.replace(/<[^>]+>/g, ' ');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

/** Extract absolute, deduped links from `<a href>` resolved against `baseUrl`. */
export function extractLinks(html: string | null, baseUrl: string): string[] {
  if (!html) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[2] ?? '').trim();
    if (raw === '' || raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw)) continue;
    const abs = absolutize(raw, baseUrl);
    if (abs && !seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

/** Extract JSON-LD structured-data blocks (`<script type="application/ld+json">`). */
export function extractJsonLd(html: string | null): JsonObject[] {
  if (!html) return [];
  const out: JsonObject[] = [];
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] ?? '').trim();
    if (raw === '') continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as JsonObject);
      } else if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object' && !Array.isArray(item)) out.push(item as JsonObject);
        }
      }
    } catch {
      /* malformed JSON-LD is ignored, never fatal */
    }
  }
  return out;
}

function absolutize(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase();
    const named = NAMED_ENTITIES[key];
    if (named !== undefined) return named;
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
    }
    return whole;
  });
}

// ===========================================================================
// Pure helper — anti-detection header generation
// ===========================================================================

/** A generated request-header set. */
export interface GeneratedHeaders {
  'User-Agent': string;
  Accept: string;
  'Accept-Language': string;
  'Accept-Encoding': string;
  'Upgrade-Insecure-Requests': string;
  [header: string]: string;
}

/**
 * Generate a realistic header set. `pick` selects a user agent from the pool (default: first). This is
 * the deterministic fallback FORGE injects when not relying on Crawlee/got-scraping's own header
 * generator; it advertises a believable Accept / Accept-Language / Sec-Fetch profile.
 */
export function generateHeaders(
  userAgents: readonly string[],
  locales: readonly string[],
  pick: (poolSize: number) => number = () => 0
): GeneratedHeaders {
  const pool = userAgents.length > 0 ? userAgents : DEFAULT_USER_AGENTS;
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(pick(pool.length))));
  const ua = pool[idx] ?? (DEFAULT_USER_AGENTS[0] as string);
  const langs = (locales.length > 0 ? locales : ['en-US']).slice(0, 4);
  const acceptLanguage = langs
    .map((l, i) => (i === 0 ? l : `${l};q=${(1 - i * 0.1).toFixed(1)}`))
    .join(',');
  return {
    'User-Agent': ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': acceptLanguage,
    'Accept-Encoding': 'gzip, deflate, br',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
  };
}

// ===========================================================================
// ProxyPool — success-rate-driven rotation
// ===========================================================================

interface ProxyState {
  url: string;
  attempts: number;
  successes: number;
  /** Round-robin tie-breaker: requests dispatched on this proxy. */
  dispatched: number;
}

/**
 * A pool of proxies that rotates based on success rate. {@link pick} prefers the healthiest proxy (and
 * round-robins among ties); a proxy whose success rate falls below `minSuccessRate` after at least
 * `minSamples` attempts is benched — unless every proxy is benched, in which case the least-bad one is
 * still used (FORGE degrades, it does not stall). Pure and synchronous; safe to unit-test directly.
 */
export class ProxyPool {
  private readonly states: ProxyState[];
  private readonly minSuccessRate: number;
  private readonly minSamples: number;

  constructor(urls: readonly string[], policy: { minSuccessRate?: number; minSamples?: number } = {}) {
    const seen = new Set<string>();
    this.states = [];
    for (const url of urls) {
      const u = url.trim();
      if (u === '' || seen.has(u)) continue;
      seen.add(u);
      this.states.push({ url: u, attempts: 0, successes: 0, dispatched: 0 });
    }
    this.minSuccessRate = clamp01(policy.minSuccessRate ?? 0.3);
    this.minSamples = policy.minSamples ?? 5;
  }

  /** Number of proxies configured. */
  get size(): number {
    return this.states.length;
  }

  private rate(s: ProxyState): number {
    return s.attempts === 0 ? 1 : s.successes / s.attempts;
  }

  private isHealthy(s: ProxyState): boolean {
    return s.attempts < this.minSamples || this.rate(s) >= this.minSuccessRate;
  }

  /** Pick the next proxy URL, or null when none are configured. */
  pick(): string | null {
    if (this.states.length === 0) return null;
    const healthy = this.states.filter((s) => this.isHealthy(s));
    const candidates = healthy.length > 0 ? healthy : this.states;
    // Highest success rate first; round-robin (fewest dispatched) breaks ties.
    let best = candidates[0] as ProxyState;
    for (const s of candidates) {
      const dr = this.rate(s) - this.rate(best);
      if (dr > 1e-9 || (Math.abs(dr) <= 1e-9 && s.dispatched < best.dispatched)) {
        best = s;
      }
    }
    best.dispatched++;
    return best.url;
  }

  /** Record the outcome of a request made through `url`. */
  record(url: string | null, ok: boolean): void {
    if (!url) return;
    const s = this.states.find((x) => x.url === url);
    if (!s) return;
    s.attempts++;
    if (ok) s.successes++;
  }

  /** Health snapshot for the report. */
  stats(): ProxyStat[] {
    return this.states.map((s) => ({
      url: s.url,
      attempts: s.attempts,
      successes: s.successes,
      failures: s.attempts - s.successes,
      successRate: s.attempts === 0 ? 0 : round4(s.successes / s.attempts),
      healthy: this.isHealthy(s),
    }));
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ===========================================================================
// Orchestrator
// ===========================================================================

/**
 * Scrape every URL per `input.config` and return a {@link ScrapeRunResult}. NON-FATAL — always resolves,
 * never throws (Iron Law 3). When the engine for a mode is unavailable, those URLs come back `skipped`
 * with a note (never a fabricated success). The default Crawlee engine is used unless an
 * {@link WebScraperOptions.engineFactory} override is injected.
 */
export async function runWebScrape(
  input: WebScrapeInput,
  options: WebScraperOptions = {}
): Promise<ScrapeRunResult> {
  const log = options.log ?? logLine('scraper');
  const now = options.now ?? nowIso;
  const random = options.random ?? Math.random;
  const config = resolveScrapingConfig(input.config);
  const engineFactory = options.engineFactory ?? createCrawleeEngine;
  const store = options.store ?? ((r: ScrapeStoredRecord) => defaultStore(r, log));

  const urls = dedupeUrls(input.urls);
  const projectName = input.projectName ?? 'forge';
  const buildRunId = input.buildRunId ?? null;

  if (urls.length === 0) {
    log('no URLs supplied — nothing to scrape');
    return emptyRun(config.mode, now());
  }

  // Shared cross-engine state: proxy health + CAPTCHA pause flag.
  const proxyPool = new ProxyPool(config.proxy.urls, {
    minSuccessRate: config.proxy.minSuccessRate,
    minSamples: config.proxy.minSamples,
  });
  let paused = false;
  const captchaUrls = new Set<string>();

  const hooks: EngineHooks = {
    pickProxy: () => proxyPool.pick(),
    recordProxyResult: (url, ok) => proxyPool.record(url, ok),
    inspectForCaptcha: (body, httpStatus) =>
      config.captcha.enabled
        ? detectCaptcha(body, httpStatus, config.captcha.signatures)
        : { detected: false, signature: null, source: null },
    notifyCaptcha: (hit, url, httpStatus) => {
      if (!hit.detected) return;
      captchaUrls.add(url);
      log(`⚠️ CAPTCHA detected at ${url} (${hit.signature ?? 'unknown'}, via ${hit.source ?? '?'})`);
      if (config.captcha.onDetected) {
        void Promise.resolve(
          config.captcha.onDetected({
            url,
            signature: hit.signature,
            source: hit.source,
            httpStatus,
            detectedAt: now(),
          })
        ).catch((e) => log(`captcha alert sink threw (${describe(e)}) — ignored`));
      }
      if (config.captcha.pauseOnDetection) {
        paused = true;
        log('crawl PAUSED after CAPTCHA — no further requests will be dispatched');
      }
    },
    isPaused: () => paused,
    nextJitter: () => random(),
    log,
  };

  // Run the configured mode. The backoff jitter RNG reaches the engine through `hooks.nextJitter`.
  const raws =
    config.mode === 'adaptive'
      ? await runAdaptive(urls, config, hooks, engineFactory, log)
      : await runSingle(config.mode === 'dynamic' ? 'dynamic' : 'static', urls, config, hooks, engineFactory, log);

  // Standardize → ScrapedResult, preserving request order.
  const byUrl = new Map<string, RawScrape>();
  for (const r of raws) if (!byUrl.has(r.url)) byUrl.set(r.url, r);

  const results: ScrapedResult[] = urls.map((url) => {
    const raw = byUrl.get(url);
    if (!raw) {
      const reason = paused
        ? 'not fetched — crawl was paused after a CAPTCHA'
        : 'not fetched — engine unavailable (run `pnpm add crawlee`)';
      return skippedResult(url, reason, now());
    }
    return standardize(raw, config, now());
  });

  const summary = summarize(results);
  const generatedAt = now();
  const proxyStats = proxyPool.stats();
  const report = renderReport(config.mode, results, summary, proxyStats, paused);

  // Persist to Build Memory (guarded — Contract 4).
  await store({
    projectName,
    buildRunId,
    mode: config.mode,
    totalRequested: urls.length,
    succeeded: summary.succeeded,
    failed: summary.failed,
    skipped: summary.skipped,
    captchaCount: summary.captchaCount,
    paused,
    proxyStats,
    perUrl: results.slice(0, 200).map((r) => ({
      url: r.url,
      status: r.status,
      httpStatus: r.httpStatus,
      mode: r.mode,
    })),
    generatedAt,
  }).catch((e) => log(`store failed (${describe(e)}) — results not persisted`));

  log(
    `done — ${summary.succeeded}/${urls.length} ok, ${summary.failed} failed, ${summary.skipped} skipped` +
      (summary.captchaCount > 0 ? `, ${summary.captchaCount} captcha` : '') +
      (paused ? ' [PAUSED]' : '')
  );

  return {
    passed: summary.failed === 0 && !paused,
    mode: config.mode,
    results,
    totalRequested: urls.length,
    succeeded: summary.succeeded,
    failed: summary.failed,
    skipped: summary.skipped,
    captchaCount: summary.captchaCount,
    paused,
    proxyStats,
    report,
    generatedAt,
  };
}

/** Run one engine over the given URLs. Returns `[]` (caller maps to skips) when the engine is unavailable. */
async function runSingle(
  mode: ResolvedMode,
  urls: string[],
  config: ResolvedScrapingConfig,
  hooks: EngineHooks,
  factory: ScrapeEngineFactory,
  log: (m: string) => void
): Promise<RawScrape[]> {
  let engine: ScrapeEngine | null = null;
  try {
    engine = await factory(mode, config, hooks);
  } catch (error) {
    log(`${mode} engine failed to initialize (${describe(error)}) — URLs will be skipped`);
    return [];
  }
  if (!engine) {
    log(`${mode} engine unavailable — URLs will be skipped`);
    return [];
  }
  try {
    return await engine.run(urls);
  } catch (error) {
    log(`${mode} crawl errored (${describe(error)})`);
    return urls.map((url) => failedRaw(url, mode, describe(error)));
  } finally {
    await engine.close().catch(() => {});
  }
}

/**
 * Adaptive: fetch with the static engine, then re-fetch only the URLs whose HTML looks like an
 * un-hydrated SPA shell using the dynamic engine. A CAPTCHA pause skips the dynamic phase entirely.
 */
async function runAdaptive(
  urls: string[],
  config: ResolvedScrapingConfig,
  hooks: EngineHooks,
  factory: ScrapeEngineFactory,
  log: (m: string) => void
): Promise<RawScrape[]> {
  const staticRaws = await runSingle('static', urls, config, hooks, factory, log);
  const byUrl = new Map<string, RawScrape>();
  for (const r of staticRaws) if (!byUrl.has(r.url)) byUrl.set(r.url, r);

  if (hooks.isPaused()) {
    log('adaptive: paused after CAPTCHA — skipping dynamic escalation');
    return [...byUrl.values()];
  }

  const escalate = urls.filter((url) => {
    const r = byUrl.get(url);
    if (!r) return true; // never fetched statically → try a browser
    if (r.error) return true;
    const hit = config.captcha.enabled ? detectCaptcha(r.body, r.httpStatus, config.captcha.signatures) : { detected: false };
    if (hit.detected) return false; // a challenge won't be solved by a headless browser either
    return needsDynamicRendering(r.body);
  });

  if (escalate.length === 0) {
    log('adaptive: all pages rendered statically — no dynamic escalation needed');
    return [...byUrl.values()];
  }

  log(`adaptive: ${escalate.length}/${urls.length} page(s) need a browser — escalating to dynamic`);
  const dynamicRaws = await runSingle('dynamic', escalate, config, hooks, factory, log);
  for (const r of dynamicRaws) {
    // The dynamic capture is authoritative for an escalated URL only when it actually produced a body.
    if (r.body !== null || !byUrl.has(r.url)) byUrl.set(r.url, r);
  }
  return urls.map((url) => byUrl.get(url)).filter((r): r is RawScrape => r !== undefined);
}

// ---------------------------------------------------------------------------
// Standardization + summary
// ---------------------------------------------------------------------------

function standardize(raw: RawScrape, config: ResolvedScrapingConfig, at: string): ScrapedResult {
  const hit = config.captcha.enabled
    ? detectCaptcha(raw.body, raw.httpStatus, config.captcha.signatures)
    : { detected: false, signature: null, source: null as 'status' | 'body' | null };

  const html = raw.body !== null ? truncate(raw.body, config.maxHtmlChars) : null;
  const text = raw.body !== null ? truncate(extractText(raw.body), config.maxTextChars) : null;
  const jsonLd = extractJsonLd(raw.body);

  let status: ScrapeStatus;
  if (hit.detected) status = 'captcha';
  else if (raw.error) status = 'failed';
  else if (raw.httpStatus !== null && raw.httpStatus >= 400) status = 'failed';
  else if (raw.body === null) status = 'failed';
  else status = 'success';

  return {
    url: raw.url,
    finalUrl: raw.finalUrl || raw.url,
    status,
    httpStatus: raw.httpStatus,
    mode: raw.mode,
    title: extractTitle(raw.body),
    html,
    text,
    data: { jsonLd: jsonLd as unknown as JsonObject[] } as JsonObject,
    links: extractLinks(raw.body, raw.finalUrl || raw.url),
    captchaDetected: hit.detected,
    captchaSignature: hit.signature,
    proxyUsed: raw.proxyUsed,
    attempts: raw.attempts,
    error: status === 'failed' ? raw.error ?? `HTTP ${raw.httpStatus ?? 'error'}` : null,
    scrapedAt: at,
  };
}

interface RunSummary {
  succeeded: number;
  failed: number;
  skipped: number;
  captchaCount: number;
}

function summarize(results: readonly ScrapedResult[]): RunSummary {
  const s: RunSummary = { succeeded: 0, failed: 0, skipped: 0, captchaCount: 0 };
  for (const r of results) {
    if (r.captchaDetected) s.captchaCount++;
    switch (r.status) {
      case 'success':
        s.succeeded++;
        break;
      case 'failed':
        s.failed++;
        break;
      case 'skipped':
        s.skipped++;
        break;
      case 'captcha':
        // a captcha is neither a clean success nor a transport failure
        break;
      default:
        break;
    }
  }
  return s;
}

function skippedResult(url: string, reason: string, at: string): ScrapedResult {
  return {
    url,
    finalUrl: url,
    status: 'skipped',
    httpStatus: null,
    mode: null,
    title: null,
    html: null,
    text: null,
    data: {},
    links: [],
    captchaDetected: false,
    captchaSignature: null,
    proxyUsed: null,
    attempts: 0,
    error: reason,
    scrapedAt: at,
  };
}

function failedRaw(url: string, mode: ResolvedMode, error: string): RawScrape {
  return { url, finalUrl: url, httpStatus: null, body: null, mode, proxyUsed: null, attempts: 1, error };
}

function emptyRun(mode: ScrapeMode, at: string): ScrapeRunResult {
  return {
    passed: true,
    mode,
    results: [],
    totalRequested: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    captchaCount: 0,
    paused: false,
    proxyStats: [],
    report: '# FORGE — Web Scraper\n\nNo URLs supplied.',
    generatedAt: at,
  };
}

function dedupeUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const t = (u ?? '').trim();
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ===========================================================================
// Report
// ===========================================================================

function statusIcon(s: ScrapeStatus): string {
  switch (s) {
    case 'success':
      return '✅';
    case 'failed':
      return '❌';
    case 'captcha':
      return '🤖';
    case 'skipped':
      return '⊘';
    default:
      return '•';
  }
}

function renderReport(
  mode: ScrapeMode,
  results: readonly ScrapedResult[],
  summary: RunSummary,
  proxyStats: readonly ProxyStat[],
  paused: boolean
): string {
  const lines: string[] = [];
  lines.push('# FORGE — Web Scraper');
  lines.push('');
  lines.push(`- **Mode:** ${mode}`);
  lines.push(
    `- **Verdict:** ${
      paused ? '⏸️ PAUSED (CAPTCHA)' : summary.failed === 0 ? '✅ PASS' : `❌ ${summary.failed} failed`
    }`
  );
  lines.push(
    `- **Results:** ${results.length} URL(s) — ✅ ${summary.succeeded} ok, ❌ ${summary.failed} failed, ⊘ ${summary.skipped} skipped, 🤖 ${summary.captchaCount} captcha`
  );
  if (proxyStats.length > 0) {
    const healthy = proxyStats.filter((p) => p.healthy).length;
    lines.push(`- **Proxies:** ${proxyStats.length} configured, ${healthy} healthy`);
  }
  lines.push('');

  if (results.length > 0) {
    lines.push('| Status | HTTP | Engine | URL | Detail |');
    lines.push('|--------|------|--------|-----|--------|');
    for (const r of results.slice(0, 100)) {
      const detail = r.error
        ? r.error.replace(/\|/g, '\\|')
        : r.captchaDetected
          ? `captcha: ${r.captchaSignature ?? '?'}`
          : `${r.title ? r.title.slice(0, 60).replace(/\|/g, '\\|') : ''}`;
      lines.push(
        `| ${statusIcon(r.status)} ${r.status} | ${r.httpStatus ?? '—'} | ${r.mode ?? '—'} | ${truncate(
          r.url,
          80
        )} | ${detail} |`
      );
    }
    if (results.length > 100) lines.push(`| … | | | _${results.length - 100} more_ | |`);
    lines.push('');
  }

  if (proxyStats.length > 0) {
    lines.push('## Proxy health');
    lines.push('');
    lines.push('| Proxy | Attempts | Success rate | Healthy |');
    lines.push('|-------|----------|--------------|---------|');
    for (const p of proxyStats) {
      lines.push(
        `| ${redactProxy(p.url)} | ${p.attempts} | ${(p.successRate * 100).toFixed(0)}% | ${p.healthy ? '✅' : '⛔'} |`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Hide credentials embedded in a proxy URL before it reaches a report/log. */
export function redactProxy(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//***@');
}

// ===========================================================================
// Default Build-Memory store (production_telemetry, guarded — Contract 4)
// ===========================================================================

async function defaultStore(record: ScrapeStoredRecord, log: (m: string) => void): Promise<void> {
  const eventType: TelemetryEventType = record.paused || record.failed > 0 ? 'error' : 'usage';
  const severity: TelemetrySeverity = record.paused
    ? 'critical'
    : record.failed > 0 || record.captchaCount > 0
      ? 'warning'
      : 'info';
  const eventData: JsonObject = {
    bucket: 'forge-web-scraper',
    kind: 'web_scrape',
    machine_id: process.env.FORGE_MACHINE_ID ?? 'unknown',
    mode: record.mode,
    totalRequested: record.totalRequested,
    succeeded: record.succeeded,
    failed: record.failed,
    skipped: record.skipped,
    captchaCount: record.captchaCount,
    paused: record.paused,
    proxyStats: record.proxyStats.map((p) => ({
      url: redactProxy(p.url),
      attempts: p.attempts,
      successRate: p.successRate,
      healthy: p.healthy,
    })) as unknown as JsonObject[],
    perUrl: record.perUrl as unknown as JsonObject[],
    generatedAt: record.generatedAt,
  };
  try {
    await BuildMemory.telemetry.createEvent({
      project_name: record.projectName,
      build_run_id: record.buildRunId,
      event_type: eventType,
      event_data: eventData,
      severity,
      captured_at: record.generatedAt,
    });
  } catch (error) {
    log(`WARNING: Build Memory store degraded (${describe(error)}) — scrape result not persisted`);
  }
}

// ===========================================================================
// Default Crawlee engine (runtime-optional dependency)
// ===========================================================================

/** Minimal shape of the lazily-imported `crawlee` module (only the members we touch). */
interface CrawleeModuleLike {
  CheerioCrawler: new (opts: Record<string, unknown>) => CrawlerLike;
  PlaywrightCrawler: new (opts: Record<string, unknown>) => CrawlerLike;
  ProxyConfiguration: new (opts: Record<string, unknown>) => unknown;
}

interface CrawlerLike {
  run(requests?: unknown): Promise<unknown>;
  teardown?(): Promise<void>;
  autoscaledPool?: { abort?(): Promise<void> | void } | null;
}

interface CrawleeRequestLike {
  url: string;
  loadedUrl?: string | null;
  retryCount?: number;
}

interface CrawleeResponseLike {
  statusCode?: number;
  status?: number;
}

interface CheerioContextLike {
  request: CrawleeRequestLike;
  response?: CrawleeResponseLike | null;
  body?: string | Buffer | null;
  proxyInfo?: { url?: string } | null;
  enqueueLinks?: (opts?: Record<string, unknown>) => Promise<unknown>;
}

interface PlaywrightContextLike {
  request: CrawleeRequestLike;
  response?: CrawleeResponseLike | null;
  page: { content(): Promise<string>; url(): string };
  proxyInfo?: { url?: string } | null;
  enqueueLinks?: (opts?: Record<string, unknown>) => Promise<unknown>;
}

function statusOf(response: CrawleeResponseLike | null | undefined): number | null {
  if (!response) return null;
  if (typeof response.statusCode === 'number') return response.statusCode;
  if (typeof response.status === 'number') return response.status;
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The production engine factory: lazily imports Crawlee (indirect specifier so the project builds before
 * `pnpm add crawlee`) and constructs a `CheerioCrawler` (static) or `PlaywrightCrawler` (dynamic) wired
 * with concurrency, retries+exponential backoff, success-rate proxy rotation, anti-detection
 * header/fingerprint options, link enqueueing, and CAPTCHA-pause hooks. Returns null when Crawlee is not
 * installed — the run then skips. Never throws.
 */
export const createCrawleeEngine: ScrapeEngineFactory = async (mode, config, hooks) => {
  let crawlee: CrawleeModuleLike;
  try {
    const specifier = 'crawlee';
    crawlee = (await import(specifier)) as unknown as CrawleeModuleLike;
  } catch (error) {
    hooks.log(`crawlee unavailable (${describe(error)}) — run \`pnpm add crawlee\` to enable web scraping`);
    return null;
  }

  const results = new Map<string, RawScrape>();
  const ad = config.antiDetection;

  // Success-rate proxy rotation: Crawlee asks for a URL per request; we answer from the pool.
  let proxyConfiguration: unknown;
  if (config.proxy.urls.length > 0) {
    try {
      proxyConfiguration = new crawlee.ProxyConfiguration({
        newUrlFunction: () => hooks.pickProxy() ?? undefined,
      });
    } catch (error) {
      hooks.log(`proxy configuration failed (${describe(error)}) — continuing without proxies`);
    }
  }

  // Exponential-backoff between retries, and proxy-failure accounting, on every error.
  const errorHandler = async (ctx: { request: CrawleeRequestLike; proxyInfo?: { url?: string } | null }): Promise<void> => {
    const attempt = (ctx.request.retryCount ?? 0) + 1;
    hooks.recordProxyResult(ctx.proxyInfo?.url ?? null, false);
    const delay = backoffDelay(attempt, config.minRetryDelayMs, config.maxRetryDelayMs, hooks.nextJitter);
    if (delay > 0) await sleep(delay);
  };

  const failedRequestHandler = async (
    ctx: { request: CrawleeRequestLike; response?: CrawleeResponseLike | null; proxyInfo?: { url?: string } | null },
    error: unknown
  ): Promise<void> => {
    const url = ctx.request.url;
    hooks.recordProxyResult(ctx.proxyInfo?.url ?? null, false);
    results.set(url, {
      url,
      finalUrl: ctx.request.loadedUrl ?? url,
      httpStatus: statusOf(ctx.response),
      body: null,
      mode,
      proxyUsed: ctx.proxyInfo?.url ?? null,
      attempts: (ctx.request.retryCount ?? 0) + 1,
      error: describe(error),
    });
  };

  const handleBody = async (
    url: string,
    finalUrl: string,
    httpStatus: number | null,
    body: string | null,
    proxyUsed: string | null,
    attempts: number,
    enqueue?: (opts?: Record<string, unknown>) => Promise<unknown>
  ): Promise<void> => {
    hooks.recordProxyResult(proxyUsed, httpStatus === null || httpStatus < 400);
    const hit = hooks.inspectForCaptcha(body, httpStatus);
    if (hit.detected) hooks.notifyCaptcha(hit, url, httpStatus);
    results.set(url, { url, finalUrl, httpStatus, body, mode, proxyUsed, attempts, error: null });
    if (config.followLinks && !hit.detected && !hooks.isPaused() && enqueue) {
      await enqueue({ strategy: 'same-origin' }).catch(() => {});
    }
  };

  const commonOptions: Record<string, unknown> = {
    maxConcurrency: config.maxConcurrency,
    maxRequestRetries: config.maxRetries,
    requestHandlerTimeoutSecs: Math.ceil(config.requestTimeoutMs / 1000),
    errorHandler,
    failedRequestHandler,
    ...(proxyConfiguration ? { proxyConfiguration } : {}),
    ...(config.maxRequestsPerCrawl ? { maxRequestsPerCrawl: config.maxRequestsPerCrawl } : {}),
  };

  let crawler: CrawlerLike;
  if (mode === 'static') {
    crawler = new crawlee.CheerioCrawler({
      ...commonOptions,
      // got-scraping performs header generation + TLS(ja3)/HTTP2 fingerprint mimicking by default; the
      // session pool keeps a per-session fingerprint stable across its requests.
      useSessionPool: ad.enabled,
      persistCookiesPerSession: ad.enabled,
      additionalHttpHeaders:
        ad.generateHeaders && ad.userAgents.length > 0
          ? generateHeaders(ad.userAgents, ad.locales)
          : undefined,
      async requestHandler(ctx: CheerioContextLike): Promise<void> {
        if (hooks.isPaused()) return;
        const url = ctx.request.url;
        const body = ctx.body === undefined || ctx.body === null ? null : typeof ctx.body === 'string' ? ctx.body : ctx.body.toString('utf8');
        await handleBody(
          url,
          ctx.request.loadedUrl ?? url,
          statusOf(ctx.response),
          body,
          ctx.proxyInfo?.url ?? null,
          (ctx.request.retryCount ?? 0) + 1,
          ctx.enqueueLinks
        );
      },
    });
  } else {
    crawler = new crawlee.PlaywrightCrawler({
      ...commonOptions,
      headless: config.headless,
      navigationTimeoutSecs: Math.ceil(config.navigationTimeoutMs / 1000),
      // Crawlee's browser pool injects a generated browser fingerprint (TLS/canvas/UA) when enabled.
      browserPoolOptions: { useFingerprints: ad.enabled && ad.tlsFingerprintMimic },
      async requestHandler(ctx: PlaywrightContextLike): Promise<void> {
        if (hooks.isPaused()) return;
        const url = ctx.request.url;
        let body: string | null = null;
        try {
          body = await ctx.page.content();
        } catch (error) {
          hooks.log(`page.content() failed for ${url} (${describe(error)})`);
        }
        const finalUrl = (() => {
          try {
            return ctx.page.url();
          } catch {
            return ctx.request.loadedUrl ?? url;
          }
        })();
        await handleBody(
          url,
          finalUrl,
          statusOf(ctx.response),
          body,
          ctx.proxyInfo?.url ?? null,
          (ctx.request.retryCount ?? 0) + 1,
          ctx.enqueueLinks
        );
      },
    });
  }

  return {
    mode,
    async run(urls: string[]): Promise<RawScrape[]> {
      try {
        await crawler.run(urls);
      } catch (error) {
        hooks.log(`${mode} crawler.run threw (${describe(error)})`);
      }
      // Any URL Crawlee never reported (e.g. paused mid-crawl) comes back as skipped-by-absence upstream.
      return urls.map((u) => results.get(u)).filter((r): r is RawScrape => r !== undefined);
    },
    async close(): Promise<void> {
      if (crawler.teardown) await crawler.teardown().catch(() => {});
    },
  };
};

// ===========================================================================
// Mode classes — StaticScraper / DynamicScraper / AdaptiveScraper
// ===========================================================================

/** Shared metadata accepted by the mode-class `scrape()` methods. */
export interface ScrapeMeta {
  projectName?: string;
  buildRunId?: string | null;
}

abstract class BaseScraper {
  protected abstract readonly forcedMode: ScrapeMode;
  constructor(
    protected readonly config: ScrapingConfig = {},
    protected readonly options: WebScraperOptions = {}
  ) {}

  /** Scrape `urls` with this scraper's fixed mode. */
  scrape(urls: string[], meta: ScrapeMeta = {}): Promise<ScrapeRunResult> {
    return runWebScrape(
      {
        urls,
        config: { ...this.config, mode: this.forcedMode },
        ...(meta.projectName !== undefined ? { projectName: meta.projectName } : {}),
        ...(meta.buildRunId !== undefined ? { buildRunId: meta.buildRunId } : {}),
      },
      this.options
    );
  }
}

/** Fast HTML-only scraping (`CheerioCrawler`). For static / server-rendered pages. */
export class StaticScraper extends BaseScraper {
  protected readonly forcedMode: ScrapeMode = 'static';
}

/** JavaScript-rendered scraping (`PlaywrightCrawler`). For SPA / client-rendered pages. */
export class DynamicScraper extends BaseScraper {
  protected readonly forcedMode: ScrapeMode = 'dynamic';
}

/** Auto-detecting scraper: static first, dynamic only where the page needs a browser. */
export class AdaptiveScraper extends BaseScraper {
  protected readonly forcedMode: ScrapeMode = 'adaptive';
}

// ===========================================================================
// Misc
// ===========================================================================

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default runWebScrape;
