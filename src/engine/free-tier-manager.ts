/**
 * FORGE 2.0 — Free-Tier Manager (provider quota governor for the Provider Router).
 *
 * Several of the providers FORGE routes its OWN reasoning calls through (see
 * `provider-router.ts`) ship a FREE tier with a daily ceiling — Google Gemini's 1500
 * requests/day is the canonical example. FORGE wants to spend that free capacity FIRST and
 * only pay when it is gone. The Provider Router already knows how to SKIP a provider whose
 * free tier is spent (its in-memory {@link ProviderUsageTracker}), but that knowledge dies
 * with the process and the router never REORDERS its task chain to prefer a free provider.
 * This module supplies the three missing pieces:
 *
 *   1. PERSISTENCE — daily usage counts per provider are written to Build Memory (the
 *      `production_telemetry` `usage` channel, one row per call, scoped to a usage bucket) and
 *      reloaded on startup, so a provider's free quota is tracked ACROSS restarts within the
 *      same UTC day rather than resetting every time FORGE relaunches.
 *
 *   2. FREE-FIRST PRIORITY — {@link FreeTierManager.prioritize} reorders a task's provider
 *      chain so every provider with free capacity remaining today leads, and the paid /
 *      exhausted / rate-limited providers become the fall-back tail. Wired into the router via
 *      its `prioritizeChain` hook, EVERY routing decision then tries free options first and
 *      falls back to paid only when all free options are exhausted.
 *
 *   3. CONFIG + REPORTING — per-provider free-tier ceilings AND short-term rate limits
 *      (requests/minute, tokens/minute) load from a `providers.yaml` config file, and a daily
 *      cost report shows calls routed free vs paid with the ESTIMATED dollars saved (Iron Law
 *      3: an estimate from list rates, not an invoice).
 *
 * MIDNIGHT UTC RESET: quotas are keyed by the UTC date (`YYYY-MM-DD`). A provider marked
 * exhausted is unavailable only for the current UTC day; when the clock crosses 00:00 UTC the
 * day key changes, the persisted counts for the new day are zero, and the provider is free
 * again — no explicit reset job is needed. {@link FreeTierManager.nextResetIso} reports when
 * that happens for a given provider.
 *
 * INTEGRATION: {@link freeTierRouterOptions} returns the exact `ProviderRouterOptions` subset
 * (provider config overrides from yaml, the persistent usage tracker, the `prioritizeChain`
 * reorderer, and a shared `today` stamp) to spread into `new ProviderRouter({...})`, so the
 * router's free-tier accounting and FORGE's persisted/prioritised view are one and the same.
 *
 * HOUSE RULES (mirrored from the rest of FORGE): never throws (a missing config file or an
 * unreachable Build Memory degrades to defaults / stateless, never a halt — Contract 4); the
 * Build-Memory store, clock, day stamp and provider settings are all INJECTABLE for tests; no
 * governance file or target-project file is touched; secret VALUES are never read or logged
 * (this module only sees token counts and dollar estimates).
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';

import { nowIso } from '../memory/index.js';
import BuildMemory from '../memory/index.js';
import {
  DEFAULT_PROVIDERS,
  ProviderUsageTracker,
  type FreeTierLimit,
  type ProviderConfig,
  type ProviderName,
  type ProviderPricing,
  type ProviderRouterOptions,
  type RecordUsageInput,
  type ProviderDayUsage,
} from './provider-router.js';
import { logLine } from '../tools/forge-logger.js';

// ---------------------------------------------------------------------------
// Public contract — per-provider settings
// ---------------------------------------------------------------------------

/** The four providers the Free-Tier Manager governs (mirrors the router). */
export const PROVIDER_NAMES: ProviderName[] = ['anthropic', 'openai', 'gemini', 'deepseek'];

/** A provider's short-term rate limit. `null` on a field = that dimension is unconstrained. */
export interface RateLimit {
  /** Max requests in any rolling 60-second window, or null. */
  requestsPerMinute: number | null;
  /** Max (input+output) tokens in any rolling 60-second window, or null. */
  tokensPerMinute: number | null;
}

/** Fully-resolved free-tier / rate-limit / pricing settings for one provider. */
export interface ResolvedProviderSettings {
  /** Provider id. */
  name: ProviderName;
  /** Whether the provider has a PAID tier to fall back to (true) or is free-only (false). */
  paid: boolean;
  /** Preference among free-tier providers — LOWER is tried first. */
  priority: number;
  /** Daily free-tier ceiling, or null if the provider has no free tier (always paid). */
  freeTier: FreeTierLimit | null;
  /** Short-term rate limit, or null if unconstrained. */
  rateLimit: RateLimit | null;
  /** List price (USD / 1M tokens) — used to estimate the dollars a free call SAVED. */
  pricing: ProviderPricing;
}

/**
 * Default per-provider settings, derived from the router's {@link DEFAULT_PROVIDERS} so the
 * manager works with NO `providers.yaml` present. Only Gemini ships a free tier by default
 * (its 1500 req/day, plus a coarse 15 req/min rate limit); the priority numbers put the
 * free/cheap providers ahead of the expensive ones when nothing else discriminates them.
 */
export const DEFAULT_PROVIDER_SETTINGS: Record<ProviderName, ResolvedProviderSettings> = {
  gemini: {
    name: 'gemini',
    paid: true,
    priority: 10,
    freeTier: DEFAULT_PROVIDERS.gemini.freeTier,
    rateLimit: { requestsPerMinute: 15, tokensPerMinute: 1_000_000 },
    pricing: DEFAULT_PROVIDERS.gemini.pricing,
  },
  openai: {
    name: 'openai',
    paid: true,
    priority: 30,
    freeTier: DEFAULT_PROVIDERS.openai.freeTier,
    rateLimit: null,
    pricing: DEFAULT_PROVIDERS.openai.pricing,
  },
  deepseek: {
    name: 'deepseek',
    paid: true,
    priority: 40,
    freeTier: DEFAULT_PROVIDERS.deepseek.freeTier,
    rateLimit: null,
    pricing: DEFAULT_PROVIDERS.deepseek.pricing,
  },
  anthropic: {
    name: 'anthropic',
    paid: true,
    priority: 50,
    freeTier: DEFAULT_PROVIDERS.anthropic.freeTier,
    rateLimit: null,
    pricing: DEFAULT_PROVIDERS.anthropic.pricing,
  },
};

// ---------------------------------------------------------------------------
// Persistence (Build Memory) — daily usage rows
// ---------------------------------------------------------------------------

/** The `production_telemetry.event_data.kind` discriminator for a persisted usage row. */
export const FREE_TIER_EVENT_KIND = 'forge_provider_usage' as const;

/** Default Build Memory bucket (`production_telemetry.project_name`) for usage rows. */
export const DEFAULT_USAGE_SCOPE = 'forge-provider-usage';

/** One persisted call — the unit appended to / loaded from Build Memory. */
export interface PersistedUsageEntry {
  provider: ProviderName;
  /** YYYY-MM-DD (UTC). */
  day: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated list-price value of the call (avoided dollars if `tier` is free). */
  costUsd: number;
  /** Which tier the call was served on. */
  tier: 'free' | 'paid';
  /** ISO timestamp the call was recorded. */
  at: string;
}

/**
 * Where daily usage is persisted. Injectable so tests run with an in-memory fake and the
 * default talks to Build Memory. Both methods are non-fatal — they never throw (Contract 4).
 */
export interface FreeTierStore {
  /** Load every persisted call for `scope` on UTC `day` (empty array if none / unavailable). */
  loadDay(scope: string, day: string): Promise<PersistedUsageEntry[]>;
  /** Append one call. Best-effort: a Build-Memory failure is swallowed, never thrown. */
  append(scope: string, entry: PersistedUsageEntry): Promise<void>;
}

/** Narrow an unknown to a {@link ProviderName}. */
function isProviderName(v: unknown): v is ProviderName {
  return typeof v === 'string' && (PROVIDER_NAMES as string[]).includes(v);
}

/** A finite, non-negative number, else 0. */
function num0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Round a dollar figure to 6 decimals (sub-cent precision). */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** Coerce a token count to a non-negative finite integer. */
function safeTokens(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * The default {@link FreeTierStore}, backed by Build Memory's `production_telemetry` `usage`
 * channel. Each call is one row; the day's usage is reconstructed by summing the rows whose
 * `event_data.day` matches. Every operation is guarded — Build Memory being unreachable yields
 * an empty load and a no-op append, exactly the Contract-4 stateless degrade.
 */
export function buildMemoryFreeTierStore(getEnv: (n: string) => string | undefined = (n) => process.env[n]): FreeTierStore {
  return {
    async loadDay(scope, day) {
      let events: Awaited<ReturnType<typeof BuildMemory.telemetry.getEventsByProject>> = null;
      try {
        events = await BuildMemory.telemetry.getEventsByProject(scope);
      } catch {
        events = null;
      }
      if (!events) return [];
      const out: PersistedUsageEntry[] = [];
      for (const ev of events) {
        const d = ev.event_data;
        if (!d || typeof d !== 'object') continue;
        if (d['kind'] !== FREE_TIER_EVENT_KIND) continue;
        if (d['day'] !== day) continue;
        const provider = d['provider'];
        if (!isProviderName(provider)) continue;
        out.push({
          provider,
          day,
          inputTokens: num0(d['inputTokens']),
          outputTokens: num0(d['outputTokens']),
          costUsd: num0(d['costUsd']),
          tier: d['tier'] === 'free' ? 'free' : 'paid',
          at: typeof d['at'] === 'string' ? d['at'] : nowIso(),
        });
      }
      return out;
    },
    async append(scope, entry) {
      try {
        await BuildMemory.telemetry.createEvent({
          project_name: scope,
          event_type: 'usage',
          severity: 'info',
          event_data: {
            kind: FREE_TIER_EVENT_KIND,
            provider: entry.provider,
            day: entry.day,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            costUsd: entry.costUsd,
            tier: entry.tier,
            at: entry.at,
            // Contract 4: every Build Memory write carries the machine id.
            machine_id: getEnv('FORGE_MACHINE_ID') ?? 'unknown',
          },
        });
      } catch {
        /* non-fatal — Build Memory degrades to stateless (Contract 4). */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// providers.yaml loading
// ---------------------------------------------------------------------------

/** Result of reading `providers.yaml`: resolved setting overrides + the file that was used. */
export interface ProvidersConfig {
  /** Per-provider partial overrides to merge over {@link DEFAULT_PROVIDER_SETTINGS}. */
  settings: Partial<Record<ProviderName, Partial<ResolvedProviderSettings>>>;
  /** Absolute path of the file that was parsed, or null when none was found. */
  filePath: string | null;
  /** Non-fatal observations (no file, parse issue, unknown provider key, …). */
  warnings: string[];
}

/** Read a number field that may legitimately be `null` (meaning "no limit"). */
function readNullableNumber(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

/** Parse one provider's YAML block into a partial settings override. */
function parseProviderBlock(raw: unknown, warnings: string[], name: ProviderName): Partial<ResolvedProviderSettings> {
  const over: Partial<ResolvedProviderSettings> = {};
  if (!raw || typeof raw !== 'object') return over;
  const obj = raw as Record<string, unknown>;

  if (typeof obj['paid'] === 'boolean') over.paid = obj['paid'];
  if (typeof obj['priority'] === 'number' && Number.isFinite(obj['priority'])) over.priority = obj['priority'];

  // freeTier: an object { dailyCalls, dailyTokens } or the literal null ("no free tier").
  if ('freeTier' in obj || 'free_tier' in obj) {
    const ft = ('freeTier' in obj ? obj['freeTier'] : obj['free_tier']) as unknown;
    if (ft === null) {
      over.freeTier = null;
    } else if (ft && typeof ft === 'object') {
      const f = ft as Record<string, unknown>;
      const dailyCalls = readNullableNumber(f['dailyCalls'] ?? f['daily_calls']);
      const dailyTokens = readNullableNumber(f['dailyTokens'] ?? f['daily_tokens']);
      over.freeTier = {
        dailyCalls: dailyCalls === undefined ? null : dailyCalls,
        dailyTokens: dailyTokens === undefined ? null : dailyTokens,
      };
    } else {
      warnings.push(`providers.yaml: '${name}.freeTier' is not an object or null — ignored.`);
    }
  }

  // rateLimit: { requestsPerMinute, tokensPerMinute } or null.
  if ('rateLimit' in obj || 'rate_limit' in obj) {
    const rl = ('rateLimit' in obj ? obj['rateLimit'] : obj['rate_limit']) as unknown;
    if (rl === null) {
      over.rateLimit = null;
    } else if (rl && typeof rl === 'object') {
      const r = rl as Record<string, unknown>;
      const rpm = readNullableNumber(r['requestsPerMinute'] ?? r['requests_per_minute']);
      const tpm = readNullableNumber(r['tokensPerMinute'] ?? r['tokens_per_minute']);
      over.rateLimit = {
        requestsPerMinute: rpm === undefined ? null : rpm,
        tokensPerMinute: tpm === undefined ? null : tpm,
      };
    } else {
      warnings.push(`providers.yaml: '${name}.rateLimit' is not an object or null — ignored.`);
    }
  }

  // pricing: { inputPerMTok, outputPerMTok } (partial allowed).
  if (obj['pricing'] && typeof obj['pricing'] === 'object') {
    const p = obj['pricing'] as Record<string, unknown>;
    const input = p['inputPerMTok'] ?? p['input_per_mtok'];
    const output = p['outputPerMTok'] ?? p['output_per_mtok'];
    const base = DEFAULT_PROVIDER_SETTINGS[name].pricing;
    over.pricing = {
      inputPerMTok: typeof input === 'number' && Number.isFinite(input) ? input : base.inputPerMTok,
      outputPerMTok: typeof output === 'number' && Number.isFinite(output) ? output : base.outputPerMTok,
    };
  }

  return over;
}

/**
 * Parse a raw, already-loaded YAML/JSON object into provider setting overrides (pure — no I/O).
 * Tolerant: a non-object input, unknown provider keys, and malformed fields are skipped with a
 * warning rather than throwing. Recognised shape:
 *
 *   providers:
 *     gemini:
 *       paid: true
 *       priority: 10
 *       freeTier: { dailyCalls: 1500, dailyTokens: null }
 *       rateLimit: { requestsPerMinute: 15, tokensPerMinute: 1000000 }
 *       pricing: { inputPerMTok: 0.075, outputPerMTok: 0.3 }
 */
export function parseProvidersConfig(raw: unknown): {
  settings: Partial<Record<ProviderName, Partial<ResolvedProviderSettings>>>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const settings: Partial<Record<ProviderName, Partial<ResolvedProviderSettings>>> = {};
  if (!raw || typeof raw !== 'object') {
    return { settings, warnings };
  }
  const root = raw as Record<string, unknown>;
  const providers = root['providers'];
  if (!providers || typeof providers !== 'object') {
    warnings.push("providers.yaml: no 'providers:' map found — using defaults.");
    return { settings, warnings };
  }
  for (const [key, block] of Object.entries(providers as Record<string, unknown>)) {
    if (!isProviderName(key)) {
      warnings.push(`providers.yaml: unknown provider '${key}' — ignored.`);
      continue;
    }
    settings[key] = parseProviderBlock(block, warnings, key);
  }
  return { settings, warnings };
}

/**
 * Resolve which `providers.yaml` to read. Preference: an explicit path argument, then
 * `FORGE_PROVIDERS_FILE`, then `<cwd>/providers.yaml`, then `<forge-root>/providers.yaml`
 * (two dirs up from this compiled module). Returns the first that exists, else null.
 */
export function locateProvidersFile(explicit?: string, getEnv: (n: string) => string | undefined = (n) => process.env[n]): string | null {
  if (explicit && existsSync(explicit)) return resolve(explicit);
  const fromEnv = getEnv('FORGE_PROVIDERS_FILE');
  if (fromEnv && existsSync(fromEnv)) return resolve(fromEnv);
  const cwdFile = join(process.cwd(), 'providers.yaml');
  if (existsSync(cwdFile)) return cwdFile;
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // dist/engine
    const rootFile = resolve(here, '..', '..', 'providers.yaml'); // repo root
    if (existsSync(rootFile)) return rootFile;
  } catch {
    /* import.meta.url unavailable — ignore. */
  }
  return null;
}

/**
 * Load `providers.yaml` from disk (or the resolved default path). Never throws: a missing or
 * unparseable file yields empty overrides plus a warning, so the manager falls back cleanly to
 * {@link DEFAULT_PROVIDER_SETTINGS}.
 */
export async function loadProvidersYaml(
  options: { path?: string; getEnv?: (n: string) => string | undefined } = {}
): Promise<ProvidersConfig> {
  const getEnv = options.getEnv ?? ((n: string) => process.env[n]);
  const filePath = locateProvidersFile(options.path, getEnv);
  if (!filePath) {
    return {
      settings: {},
      filePath: null,
      warnings: ['No providers.yaml found — using built-in default provider settings.'],
    };
  }
  try {
    const text = await readFile(filePath, 'utf8');
    const raw = parseYaml(text);
    const { settings, warnings } = parseProvidersConfig(raw);
    return { settings, filePath, warnings };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      settings: {},
      filePath,
      warnings: [`Could not read/parse providers.yaml at ${filePath} (${detail}); using defaults.`],
    };
  }
}

/** Merge a partial override over a provider's default settings. */
function mergeSettings(base: ResolvedProviderSettings, over: Partial<ResolvedProviderSettings> | undefined): ResolvedProviderSettings {
  if (!over) return base;
  return {
    name: base.name,
    paid: over.paid ?? base.paid,
    priority: over.priority ?? base.priority,
    freeTier: over.freeTier !== undefined ? over.freeTier : base.freeTier,
    rateLimit: over.rateLimit !== undefined ? over.rateLimit : base.rateLimit,
    pricing: { ...base.pricing, ...(over.pricing ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Availability + report shapes
// ---------------------------------------------------------------------------

/** A point-in-time availability verdict for one provider on one UTC day. */
export interface ProviderAvailability {
  provider: ProviderName;
  /** The UTC day the verdict is for (YYYY-MM-DD). */
  day: string;
  /** Whether this provider has a free tier configured at all. */
  freeTierConfigured: boolean;
  /** True when the provider has free-tier capacity left today (and a free tier exists). */
  freeTierAvailable: boolean;
  /** True when the day's free-tier quota (calls or tokens) is spent. */
  freeTierExhausted: boolean;
  /** True when the provider is inside a short-term rate-limit window right now. */
  rateLimited: boolean;
  /** Remaining free calls today, or null when not call-capped. */
  remainingCalls: number | null;
  /** Remaining free tokens today, or null when not token-capped. */
  remainingTokens: number | null;
  /** ISO instant the free quota resets (next 00:00 UTC). */
  resetAtUtc: string;
  /** Human-readable summary (logged / surfaced in the report). */
  reason: string;
}

/** Per-provider line of the daily cost report. */
export interface ProviderCostLine {
  provider: ProviderName;
  freeCalls: number;
  paidCalls: number;
  totalCalls: number;
  freeInputTokens: number;
  freeOutputTokens: number;
  paidInputTokens: number;
  paidOutputTokens: number;
  /** Actual estimated dollars spent on PAID calls. */
  paidCostUsd: number;
  /** Estimated dollars SAVED by serving the free calls (their list-price value). */
  savingsUsd: number;
}

/** The whole-day cost report. */
export interface DailyCostReport {
  day: string;
  providers: ProviderCostLine[];
  totalCalls: number;
  totalFreeCalls: number;
  totalPaidCalls: number;
  /** Total estimated dollars actually spent (paid calls only). */
  totalPaidCostUsd: number;
  /** Total estimated dollars saved by the free tiers. */
  totalSavingsUsd: number;
}

/** Internal mutable per-(provider,day) breakdown the manager accumulates. */
interface ProviderDayBreakdown {
  provider: ProviderName;
  day: string;
  freeCalls: number;
  paidCalls: number;
  freeInputTokens: number;
  freeOutputTokens: number;
  paidInputTokens: number;
  paidOutputTokens: number;
  paidCostUsd: number;
  savingsUsd: number;
}

function freshBreakdown(provider: ProviderName, day: string): ProviderDayBreakdown {
  return {
    provider,
    day,
    freeCalls: 0,
    paidCalls: 0,
    freeInputTokens: 0,
    freeOutputTokens: 0,
    paidInputTokens: 0,
    paidOutputTokens: 0,
    paidCostUsd: 0,
    savingsUsd: 0,
  };
}

/** Next 00:00 UTC strictly after `ms`, as an ISO string. */
export function nextUtcMidnightIso(ms: number): string {
  const d = new Date(ms);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return new Date(next).toISOString();
}

// ---------------------------------------------------------------------------
// Persistent usage tracker (extends the router's in-memory ledger)
// ---------------------------------------------------------------------------

/**
 * A {@link ProviderUsageTracker} that ALSO splits each recorded call into free vs paid, feeds
 * the owning {@link FreeTierManager}'s rate-limit window, and persists the call to Build
 * Memory. It is the object handed to the Provider Router as its `usage` ledger, so the router's
 * existing free-tier-exhaustion skip and FORGE's persisted/prioritised view share one source of
 * truth. {@link seed} replays a persisted call WITHOUT re-persisting (used during hydration).
 */
export class PersistentUsageTracker extends ProviderUsageTracker {
  constructor(private readonly manager: FreeTierManager) {
    super();
  }

  /** Live record: classify tier (pre-increment), tally counters, update window + persist. */
  override record(input: RecordUsageInput, day: string): ProviderDayUsage {
    const tier = this.manager.classifyTier(input.provider, day);
    const result = super.record(input, day);
    this.manager.applyBreakdown(input, day, tier);
    this.manager.onLiveRecord(input, day, tier);
    return result;
  }

  /** Replay a persisted call into the base counters + breakdown, with NO re-persist. */
  seed(input: RecordUsageInput, day: string, tier: 'free' | 'paid'): void {
    super.record(input, day);
    this.manager.applyBreakdown(input, day, tier);
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Construction options for {@link FreeTierManager} — everything is injectable. */
export interface FreeTierManagerOptions {
  /** Per-provider setting overrides (merged over {@link DEFAULT_PROVIDER_SETTINGS}). */
  settings?: Partial<Record<ProviderName, Partial<ResolvedProviderSettings>>>;
  /** Persistence backend. Default {@link buildMemoryFreeTierStore}. */
  store?: FreeTierStore;
  /** Build Memory bucket for usage rows. Default {@link DEFAULT_USAGE_SCOPE}. */
  scope?: string;
  /** Monotonic clock (ms) for rate-limit windows + reset stamps. Default `Date.now`. */
  now?: () => number;
  /** Current UTC day stamp `YYYY-MM-DD`. Default the date half of {@link nowIso}. */
  today?: () => string;
  /** Progress reporter. Default a `[FORGE:free-tier]`-prefixed console line. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

/** One timestamped entry in a provider's rolling rate-limit window. */
interface WindowEntry {
  t: number;
  tokens: number;
}

/** A rolling 60-second window. */
const RATE_WINDOW_MS = 60_000;

/**
 * Tracks free-tier quotas for every configured provider, persists daily usage to Build Memory,
 * decides availability (free capacity + rate limits), reorders provider chains free-first, and
 * reports daily savings. Construct via {@link FreeTierManager.create} (loads `providers.yaml`
 * and hydrates today's usage) or {@link FreeTierManager.fromConfig} (settings supplied inline).
 */
export class FreeTierManager {
  private readonly _settings: Record<ProviderName, ResolvedProviderSettings>;
  private readonly store: FreeTierStore;
  private readonly scope: string;
  private readonly now: () => number;
  private readonly today: () => string;
  private readonly log: (message: string) => void;
  private readonly usage: PersistentUsageTracker;
  /** keyed `${provider}@${day}`. */
  private readonly dayStats = new Map<string, ProviderDayBreakdown>();
  /** provider → rolling rate-limit window. */
  private readonly windows = new Map<ProviderName, WindowEntry[]>();
  /** providers.yaml warnings (config provenance), surfaced for diagnostics. */
  readonly warnings: string[] = [];
  /** The providers.yaml that configured this manager, or null. */
  readonly configFile: string | null;

  constructor(options: FreeTierManagerOptions = {}, configFile: string | null = null, warnings: string[] = []) {
    const resolved = {} as Record<ProviderName, ResolvedProviderSettings>;
    for (const name of PROVIDER_NAMES) {
      resolved[name] = mergeSettings(DEFAULT_PROVIDER_SETTINGS[name], options.settings?.[name]);
    }
    this._settings = resolved;
    this.store = options.store ?? buildMemoryFreeTierStore();
    this.scope = options.scope ?? DEFAULT_USAGE_SCOPE;
    this.now = options.now ?? (() => Date.now());
    this.today = options.today ?? (() => nowIso().slice(0, 10));
    this.log = options.log ?? logLine('free-tier');
    this.configFile = configFile;
    this.warnings = warnings;
    this.usage = new PersistentUsageTracker(this);
  }

  /**
   * Build a manager from `providers.yaml` (resolved from `configPath` / env / default) and
   * hydrate today's usage from Build Memory. Never throws.
   */
  static async create(options: FreeTierManagerOptions & { configPath?: string } = {}): Promise<FreeTierManager> {
    const { configPath, ...rest } = options;
    const config = await loadProvidersYaml({ path: configPath });
    const merged: Partial<Record<ProviderName, Partial<ResolvedProviderSettings>>> = {
      ...config.settings,
      ...(rest.settings ?? {}),
    };
    const manager = new FreeTierManager({ ...rest, settings: merged }, config.filePath, config.warnings);
    await manager.hydrate();
    return manager;
  }

  /** Build a manager from inline settings (no file read) and hydrate. Never throws. */
  static async fromConfig(options: FreeTierManagerOptions = {}): Promise<FreeTierManager> {
    const manager = new FreeTierManager(options);
    await manager.hydrate();
    return manager;
  }

  /** Load today's persisted usage from Build Memory into the live counters. */
  async hydrate(): Promise<void> {
    const day = this.today();
    let entries: PersistedUsageEntry[] = [];
    try {
      entries = await this.store.loadDay(this.scope, day);
    } catch {
      entries = [];
    }
    for (const e of entries) {
      this.usage.seed(
        { provider: e.provider, inputTokens: e.inputTokens, outputTokens: e.outputTokens, costUsd: e.costUsd },
        e.day,
        e.tier
      );
    }
    if (entries.length > 0) this.log(`hydrated ${entries.length} persisted call(s) for ${day}`);
  }

  /** The persistent usage ledger to hand the Provider Router as its `usage` option. */
  get usageTracker(): ProviderUsageTracker {
    return this.usage;
  }

  /** Resolved settings for one provider. */
  settingsFor(provider: ProviderName): ResolvedProviderSettings {
    return this._settings[provider];
  }

  /** All resolved provider settings (a defensive copy). */
  allSettings(): ResolvedProviderSettings[] {
    return PROVIDER_NAMES.map((n) => this._settings[n]);
  }

  // -------------------------------------------------------------------------
  // Recording hooks (called by the PersistentUsageTracker)
  // -------------------------------------------------------------------------

  /** Classify a call's tier from the PRE-increment daily usage. Free iff a non-exhausted free tier exists. */
  classifyTier(provider: ProviderName, day: string): 'free' | 'paid' {
    const s = this._settings[provider];
    if (s.freeTier === null) return 'paid';
    return this.usage.isFreeTierExhausted(provider, s.freeTier, day) ? 'paid' : 'free';
  }

  /** Accumulate one call into the free/paid breakdown for (provider, day). */
  applyBreakdown(input: RecordUsageInput, day: string, tier: 'free' | 'paid'): void {
    const key = `${input.provider}@${day}`;
    const b = this.dayStats.get(key) ?? freshBreakdown(input.provider, day);
    const inTok = safeTokens(input.inputTokens);
    const outTok = safeTokens(input.outputTokens);
    const cost = Number.isFinite(input.costUsd) && input.costUsd > 0 ? input.costUsd : 0;
    if (tier === 'free') {
      b.freeCalls += 1;
      b.freeInputTokens += inTok;
      b.freeOutputTokens += outTok;
      b.savingsUsd = round6(b.savingsUsd + cost);
    } else {
      b.paidCalls += 1;
      b.paidInputTokens += inTok;
      b.paidOutputTokens += outTok;
      b.paidCostUsd = round6(b.paidCostUsd + cost);
    }
    this.dayStats.set(key, b);
  }

  /** Update the rolling rate-limit window and persist a LIVE call (best-effort). */
  onLiveRecord(input: RecordUsageInput, day: string, tier: 'free' | 'paid'): void {
    const inTok = safeTokens(input.inputTokens);
    const outTok = safeTokens(input.outputTokens);
    const win = this.windows.get(input.provider) ?? [];
    win.push({ t: this.now(), tokens: inTok + outTok });
    this.windows.set(input.provider, win);
    const entry: PersistedUsageEntry = {
      provider: input.provider,
      day,
      inputTokens: inTok,
      outputTokens: outTok,
      costUsd: Number.isFinite(input.costUsd) && input.costUsd > 0 ? input.costUsd : 0,
      tier,
      at: nowIso(),
    };
    void Promise.resolve(this.store.append(this.scope, entry)).catch(() => {
      /* non-fatal persistence (Contract 4). */
    });
  }

  // -------------------------------------------------------------------------
  // Availability + rate limits
  // -------------------------------------------------------------------------

  /** Prune a provider's rate window to the last {@link RATE_WINDOW_MS} and return it. */
  private prunedWindow(provider: ProviderName): WindowEntry[] {
    const cutoff = this.now() - RATE_WINDOW_MS;
    const win = (this.windows.get(provider) ?? []).filter((e) => e.t > cutoff);
    this.windows.set(provider, win);
    return win;
  }

  /** True when a provider is currently inside its short-term rate-limit window. */
  isRateLimited(provider: ProviderName): boolean {
    const s = this._settings[provider];
    if (!s.rateLimit) return false;
    const win = this.prunedWindow(provider);
    if (s.rateLimit.requestsPerMinute !== null && win.length >= s.rateLimit.requestsPerMinute) return true;
    if (s.rateLimit.tokensPerMinute !== null) {
      const tok = win.reduce((a, e) => a + e.tokens, 0);
      if (tok >= s.rateLimit.tokensPerMinute) return true;
    }
    return false;
  }

  /** When `provider`'s free quota next resets (next 00:00 UTC). */
  nextResetIso(): string {
    return nextUtcMidnightIso(this.now());
  }

  /** Full availability verdict for `provider` on `day` (defaults to today, UTC). */
  availability(provider: ProviderName, day: string = this.today()): ProviderAvailability {
    const s = this._settings[provider];
    const used = this.usage.usageFor(provider, day);
    const freeTierConfigured = s.freeTier !== null;
    const exhausted = freeTierConfigured && this.usage.isFreeTierExhausted(provider, s.freeTier, day);
    const rateLimited = this.isRateLimited(provider);
    const remainingCalls =
      s.freeTier && s.freeTier.dailyCalls !== null ? Math.max(0, s.freeTier.dailyCalls - used.calls) : null;
    const remainingTokens =
      s.freeTier && s.freeTier.dailyTokens !== null
        ? Math.max(0, s.freeTier.dailyTokens - (used.inputTokens + used.outputTokens))
        : null;
    const freeTierAvailable = freeTierConfigured && !exhausted;
    const reason = !freeTierConfigured
      ? 'paid-only provider (no free tier configured)'
      : exhausted
        ? `free tier exhausted for ${day} — resets ${nextUtcMidnightIso(this.now())}`
        : rateLimited
          ? 'free tier available but rate-limited right now'
          : `free tier available (${remainingCalls ?? '∞'} calls / ${remainingTokens ?? '∞'} tokens left)`;
    return {
      provider,
      day,
      freeTierConfigured,
      freeTierAvailable,
      freeTierExhausted: exhausted,
      rateLimited,
      remainingCalls,
      remainingTokens,
      resetAtUtc: nextUtcMidnightIso(this.now()),
      reason,
    };
  }

  // -------------------------------------------------------------------------
  // Free-first chain prioritisation (the Provider Router hook)
  // -------------------------------------------------------------------------

  /**
   * Reorder a task's provider chain so providers with free capacity remaining today (and not
   * rate-limited) lead — ordered by configured priority, ties broken by the original chain
   * order — and the paid / exhausted / rate-limited providers follow as the fall-back tail in
   * their original order. The chain's MEMBERSHIP is preserved (nothing is dropped) so the
   * router's own failover still works when every free option is gone.
   */
  prioritize(chain: ProviderName[], day: string = this.today()): ProviderName[] {
    const freeUsable: Array<{ name: ProviderName; idx: number; priority: number }> = [];
    const fallback: ProviderName[] = [];
    chain.forEach((name, idx) => {
      if (!isProviderName(name)) return;
      const avail = this.availability(name, day);
      if (avail.freeTierAvailable && !avail.rateLimited) {
        freeUsable.push({ name, idx, priority: this._settings[name].priority });
      } else {
        fallback.push(name);
      }
    });
    freeUsable.sort((a, b) => a.priority - b.priority || a.idx - b.idx);
    return [...freeUsable.map((x) => x.name), ...fallback];
  }

  /** The `prioritizeChain` closure to spread into {@link ProviderRouterOptions}. */
  prioritizeChain(): (chain: ProviderName[], day: string) => ProviderName[] {
    return (chain, day) => this.prioritize(chain, day);
  }

  /**
   * Provider-config overrides (free-tier ceilings + pricing) to spread into the router's
   * `providers` option, so the router's own `isFreeTierExhausted` check uses the SAME ceilings
   * this manager enforces.
   */
  providerOverrides(): Partial<Record<ProviderName, Partial<ProviderConfig>>> {
    const out: Partial<Record<ProviderName, Partial<ProviderConfig>>> = {};
    for (const name of PROVIDER_NAMES) {
      const s = this._settings[name];
      out[name] = { freeTier: s.freeTier, pricing: s.pricing };
    }
    return out;
  }

  /** Expose the shared UTC day stamp (so the router and manager agree on "today"). */
  todayStamp(): string {
    return this.today();
  }

  // -------------------------------------------------------------------------
  // Daily cost report
  // -------------------------------------------------------------------------

  /** Build the free-vs-paid cost report for `day` (defaults to today, UTC). */
  dailyCostReport(day: string = this.today()): DailyCostReport {
    const providers: ProviderCostLine[] = [];
    let totalCalls = 0;
    let totalFreeCalls = 0;
    let totalPaidCalls = 0;
    let totalPaidCostUsd = 0;
    let totalSavingsUsd = 0;
    for (const name of PROVIDER_NAMES) {
      const b = this.dayStats.get(`${name}@${day}`);
      if (!b) continue;
      const line: ProviderCostLine = {
        provider: name,
        freeCalls: b.freeCalls,
        paidCalls: b.paidCalls,
        totalCalls: b.freeCalls + b.paidCalls,
        freeInputTokens: b.freeInputTokens,
        freeOutputTokens: b.freeOutputTokens,
        paidInputTokens: b.paidInputTokens,
        paidOutputTokens: b.paidOutputTokens,
        paidCostUsd: round6(b.paidCostUsd),
        savingsUsd: round6(b.savingsUsd),
      };
      providers.push(line);
      totalCalls += line.totalCalls;
      totalFreeCalls += line.freeCalls;
      totalPaidCalls += line.paidCalls;
      totalPaidCostUsd = round6(totalPaidCostUsd + line.paidCostUsd);
      totalSavingsUsd = round6(totalSavingsUsd + line.savingsUsd);
    }
    return {
      day,
      providers,
      totalCalls,
      totalFreeCalls,
      totalPaidCalls,
      totalPaidCostUsd,
      totalSavingsUsd,
    };
  }
}

/** Render a {@link DailyCostReport} as a human-readable block (for `forge status` / logs). */
export function renderDailyCostReport(report: DailyCostReport): string {
  const lines: string[] = [];
  lines.push(`FORGE free-tier cost report — ${report.day} (UTC)`);
  lines.push('─'.repeat(60));
  if (report.providers.length === 0) {
    lines.push('  (no provider calls recorded today)');
  } else {
    for (const p of report.providers) {
      lines.push(
        `  ${p.provider.padEnd(10)} ${String(p.totalCalls).padStart(5)} calls  ` +
          `free=${String(p.freeCalls).padStart(4)}  paid=${String(p.paidCalls).padStart(4)}  ` +
          `spent=$${p.paidCostUsd.toFixed(4)}  saved=$${p.savingsUsd.toFixed(4)}`
      );
    }
  }
  lines.push('─'.repeat(60));
  lines.push(
    `  TOTAL ${String(report.totalCalls).padStart(8)} calls  ` +
      `free=${report.totalFreeCalls}  paid=${report.totalPaidCalls}  ` +
      `spent=$${report.totalPaidCostUsd.toFixed(4)}  saved≈$${report.totalSavingsUsd.toFixed(4)}`
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Provider Router integration
// ---------------------------------------------------------------------------

/**
 * The exact {@link ProviderRouterOptions} subset to spread into `new ProviderRouter({...})` so
 * every routing decision factors in free-tier availability:
 *
 *   const ftm = await FreeTierManager.create();
 *   const router = new ProviderRouter({ ...freeTierRouterOptions(ftm), routes, fetchImpl });
 *
 * It wires the persistent usage ledger (so the router's free-tier skip + this manager's
 * persisted/prioritised view are one), the free-tier/pricing ceilings from `providers.yaml`,
 * the free-first chain reorderer, and the shared UTC day stamp.
 */
export function freeTierRouterOptions(
  manager: FreeTierManager
): Pick<ProviderRouterOptions, 'providers' | 'usage' | 'prioritizeChain' | 'today'> {
  return {
    providers: manager.providerOverrides(),
    usage: manager.usageTracker,
    prioritizeChain: manager.prioritizeChain(),
    today: manager.todayStamp.bind(manager),
  };
}

export default FreeTierManager;
