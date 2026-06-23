/**
 * FORGE 2.0 — Provider Router (multi-provider LLM routing layer).
 *
 * FORGE makes two KINDS of model call. The first is the autonomous BUILD itself — that goes
 * through the Claude Code CLI and is the Claude Runner's sole job (Contract 5); this module does
 * NOT touch it. The second is every OTHER model call FORGE makes for its OWN reasoning: the PRD
 * generator (Phase 1A), the Architecture Engine (Phase 1B) and the self-evolving Agent Creator
 * (Phase 5) all POST to a chat model directly. Until now those three each defaulted to a single
 * hard-wired Anthropic Messages call (`defaultCallModel`). This module replaces that single
 * vendor path with a governed, multi-provider ROUTER so the right task goes to the right (and
 * cheapest-capable) provider, a rate-limited or down provider FAILS OVER automatically, every
 * call's dollar cost is tracked per provider, and a provider's free tier is respected (FORGE
 * stops routing to it once the day's free quota is spent).
 *
 * PROVIDERS (each keyed from its own env var — a missing key just drops that provider from
 * routing, never crashes):
 *   - anthropic : Claude (claude-sonnet-4-6)      — PRIMARY complex reasoning. `ANTHROPIC_API_KEY`
 *   - openai    : GPT-4o-mini                      — validation + simple analysis. `OPENAI_API_KEY`
 *   - gemini    : Gemini 1.5 Flash                 — documentation + research verification.
 *                                                    `GEMINI_API_KEY` (or `GOOGLE_API_KEY`)
 *   - deepseek  : DeepSeek Chat                    — code review + pattern matching. `DEEPSEEK_API_KEY`
 *
 * INTELLIGENT ROUTING: a {@link ForgeTaskType} maps to an ORDERED list of providers — the first
 * is the preferred provider for that kind of work, the rest are the failover chain. The router
 * walks that list, SKIPPING any provider that has no key, is in rate-limit cooldown, or has
 * exhausted its free tier for the day, and calls the first eligible one. On a 429 (rate limit)
 * or 5xx / network error it records a cooldown and advances to the next provider; a 401/403/400
 * drops that provider for the attempt (bad key / bad request) and advances. If the whole chain is
 * exhausted it throws ONE aggregated error — and because every caller already wraps its model
 * call in a guarded try/catch with a deterministic fallback (e.g. Phase 1A's template PRD), a
 * total provider outage degrades gracefully rather than halting the pipeline.
 *
 * LITELLM AS THE ROUTING LAYER: the production way to put LiteLLM in front of a Node app is its
 * OpenAI-compatible PROXY (a separate `litellm`-served gateway), NOT an in-process Python import.
 * When `FORGE_LITELLM_PROXY_URL` is set, EVERY provider call is sent OpenAI-style to that proxy
 * with a LiteLLM model string (`anthropic/claude-sonnet-4-6`, `openai/gpt-4o-mini`,
 * `gemini/gemini-2.5-flash-lite`, `deepseek/deepseek-chat`) and LiteLLM performs the actual vendor
 * dispatch, key management and its own failover/cost accounting — this router's task→provider
 * preference still chooses WHICH model string to ask for. With no proxy URL set the router calls
 * each provider's native HTTPS endpoint directly (Anthropic Messages shape for Claude, OpenAI
 * Chat Completions shape for the other three — Gemini via its OpenAI-compatible endpoint), so
 * FORGE works with or without the proxy. (`litellm` is declared in package.json for the proxy.)
 *
 * COST + FREE-TIER TRACKING: {@link ProviderUsageTracker} is an in-memory ledger keyed by
 * provider AND day (YYYY-MM-DD from {@link nowIso}). Every successful call records input/output
 * tokens and an ESTIMATED dollar cost (per-provider list rates — an estimate for budgeting, not
 * an invoice; Iron Law 3). A provider with a configured free-tier daily ceiling (calls and/or
 * tokens) is reported EXHAUSTED once the day's usage crosses it, and the router skips it for the
 * rest of that day — failing over to a paid provider instead.
 *
 * HOUSE RULES (mirrored from the rest of FORGE): never throws except the deliberate
 * all-providers-exhausted error the callers expect and catch; the network client (`fetch`), the
 * usage ledger, the clock and the day stamp are all INJECTABLE for tests; no governance file or
 * target-project file is touched; secret VALUES are never logged.
 *
 * BOUNDARY: this module decides WHICH provider answers a non-Claude-Code call and performs it. It
 * is the drop-in replacement for `defaultCallModel` in Phases 1A/1B and the Agent Creator —
 * {@link ProviderRouter.callModelFor} returns a {@link CallModel} those modules use unchanged.
 */

import { nowIso } from '../memory/index.js';
import type { CallModel, ModelRequest, ModelResponse } from '../phases/phase1a-prd.js';
import {
  validateApiResponse,
  AnthropicMessagesResponseSchema,
  OpenAIChatResponseSchema,
} from '../tools/schema-validator.js';
import { logLine } from '../tools/forge-logger.js';

// ---------------------------------------------------------------------------
// Public contract — providers, task types, pricing
// ---------------------------------------------------------------------------

/** The non-Claude-Code providers FORGE can route a reasoning call to. */
export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'deepseek';

/**
 * The KIND of work a call represents — the routing key. Each maps (via {@link DEFAULT_ROUTES})
 * to a preferred provider plus a failover chain. The buckets mirror the provider roles:
 * complex reasoning → Claude; validation/simple analysis → GPT-4o-mini; documentation/research
 * verification → Gemini Flash; code review/pattern matching → DeepSeek.
 */
export type ForgeTaskType =
  | 'complex_reasoning'
  | 'validation'
  | 'simple_analysis'
  | 'documentation'
  | 'research_verification'
  | 'code_review'
  | 'pattern_matching';

/** The wire protocol a provider speaks when called DIRECTLY (no LiteLLM proxy). */
export type ProviderProtocol = 'anthropic' | 'openai';

/** Per-million-token list price for a provider (USD). An estimate — see module note. */
export interface ProviderPricing {
  /** Dollars per 1,000,000 input tokens. */
  inputPerMTok: number;
  /** Dollars per 1,000,000 output tokens. */
  outputPerMTok: number;
}

/** A provider's free-tier daily ceiling. `null` on a field = no limit on that dimension. */
export interface FreeTierLimit {
  /** Max free calls per day, or null if usage isn't call-capped. */
  dailyCalls: number | null;
  /** Max free (input+output) tokens per day, or null if not token-capped. */
  dailyTokens: number | null;
}

/** Full configuration for one provider. Every field is overridable via {@link ProviderRouterOptions}. */
export interface ProviderConfig {
  /** Provider id. */
  name: ProviderName;
  /** Env var holding this provider's API key (first non-empty of `apiKeyEnvs` wins). */
  apiKeyEnvs: string[];
  /** Default model id used when the caller doesn't pin one for this provider. */
  defaultModel: string;
  /** Native HTTPS endpoint for DIRECT calls (ignored when the LiteLLM proxy is configured). */
  endpoint: string;
  /** Request/response shape for DIRECT calls. */
  protocol: ProviderProtocol;
  /** LiteLLM model-string prefix (e.g. `gemini/`), used to build the proxy model id. */
  litellmPrefix: string;
  /** Estimated list price for cost tracking. */
  pricing: ProviderPricing;
  /** Free-tier daily ceiling, or null if the provider has no free tier (always paid). */
  freeTier: FreeTierLimit | null;
}

// ---------------------------------------------------------------------------
// Default policy tables (the routing decision, in one place)
// ---------------------------------------------------------------------------

/**
 * Default per-provider configuration. Prices are coarse published list rates (USD / 1M tokens)
 * for budgeting only (Iron Law 3). Gemini is called via its OpenAI-COMPATIBLE endpoint so the
 * direct path is a single `openai`-shaped client for three of the four providers.
 */
export const DEFAULT_PROVIDERS: Record<ProviderName, ProviderConfig> = {
  anthropic: {
    name: 'anthropic',
    apiKeyEnvs: ['ANTHROPIC_API_KEY'],
    defaultModel: 'claude-sonnet-4-6',
    endpoint: 'https://api.anthropic.com/v1/messages',
    protocol: 'anthropic',
    litellmPrefix: 'anthropic/',
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    freeTier: null,
  },
  openai: {
    name: 'openai',
    apiKeyEnvs: ['OPENAI_API_KEY'],
    defaultModel: 'gpt-4o-mini',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    protocol: 'openai',
    litellmPrefix: 'openai/',
    pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 },
    freeTier: null,
  },
  gemini: {
    name: 'gemini',
    apiKeyEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    defaultModel: 'gemini-2.5-flash-lite',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    protocol: 'openai',
    litellmPrefix: 'gemini/',
    pricing: { inputPerMTok: 0.075, outputPerMTok: 0.3 },
    // Gemini's free tier is request-capped per day; FORGE stops routing here once spent.
    freeTier: { dailyCalls: 1500, dailyTokens: null },
  },
  deepseek: {
    name: 'deepseek',
    apiKeyEnvs: ['DEEPSEEK_API_KEY'],
    defaultModel: 'deepseek-chat',
    endpoint: 'https://api.deepseek.com/chat/completions',
    protocol: 'openai',
    litellmPrefix: 'deepseek/',
    pricing: { inputPerMTok: 0.14, outputPerMTok: 0.28 },
    freeTier: null,
  },
};

/**
 * Task type → ordered provider preference (preferred first, then the failover chain). The first
 * entry encodes the spec's role for each provider; the tail keeps FORGE working when the
 * preferred provider has no key / is rate-limited / has spent its free tier.
 */
export const DEFAULT_ROUTES: Record<ForgeTaskType, ProviderName[]> = {
  complex_reasoning: ['gemini', 'deepseek', 'openai', 'anthropic'],
  validation: ['openai', 'gemini', 'anthropic', 'deepseek'],
  simple_analysis: ['openai', 'gemini', 'deepseek', 'anthropic'],
  documentation: ['gemini', 'openai', 'anthropic', 'deepseek'],
  research_verification: ['gemini', 'openai', 'anthropic', 'deepseek'],
  code_review: ['deepseek', 'anthropic', 'openai', 'gemini'],
  pattern_matching: ['deepseek', 'openai', 'gemini', 'anthropic'],
};

/** Default rate-limit cooldown after a 429 / 5xx, in ms (a provider is skipped until it elapses). */
export const DEFAULT_COOLDOWN_MS = 10_000;

/** Default per-request network timeout (10 minutes — long generations stream slowly). */
export const DEFAULT_TIMEOUT_MS = 600_000;

/** Anthropic Messages API version pinned for the direct path. */
const ANTHROPIC_VERSION = '2023-06-01';

// ---------------------------------------------------------------------------
// Usage + cost ledger (free-tier awareness)
// ---------------------------------------------------------------------------

/** One day's usage for one provider. */
export interface ProviderDayUsage {
  provider: ProviderName;
  /** YYYY-MM-DD. */
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** A per-provider rollup across the ledger's whole lifetime. */
export interface ProviderUsageRollup {
  provider: ProviderName;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** The ledger's full summary. */
export interface ProviderUsageSummary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byProvider: ProviderUsageRollup[];
}

/** What {@link ProviderUsageTracker.record} stores. */
export interface RecordUsageInput {
  provider: ProviderName;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
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
 * In-memory, day-bucketed ledger of provider usage and ESTIMATED cost. Holds no external state
 * and performs no I/O — the router records one entry per successful call and reads back
 * {@link summary} for the build report and {@link isFreeTierExhausted} for routing. A single
 * shared instance can be passed across phases via {@link ProviderRouterOptions.usage}.
 */
export class ProviderUsageTracker {
  /** keyed by `${provider}@${day}`. */
  private readonly _days = new Map<string, ProviderDayUsage>();

  private key(provider: ProviderName, day: string): string {
    return `${provider}@${day}`;
  }

  /** Record one successful call's tokens + estimated cost against (provider, day). */
  record(input: RecordUsageInput, day: string): ProviderDayUsage {
    const k = this.key(input.provider, day);
    const current = this._days.get(k) ?? {
      provider: input.provider,
      day,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    current.calls += 1;
    current.inputTokens += safeTokens(input.inputTokens);
    current.outputTokens += safeTokens(input.outputTokens);
    current.costUsd = round6(current.costUsd + (Number.isFinite(input.costUsd) ? input.costUsd : 0));
    this._days.set(k, current);
    return current;
  }

  /** Usage for one provider on one day (zeros if none recorded). */
  usageFor(provider: ProviderName, day: string): ProviderDayUsage {
    return (
      this._days.get(this.key(provider, day)) ?? {
        provider,
        day,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      }
    );
  }

  /**
   * True when `provider` has crossed `freeTier`'s daily call OR token ceiling for `day`. A null
   * `freeTier` (paid provider) is never exhausted; a null dimension is not counted.
   */
  isFreeTierExhausted(provider: ProviderName, freeTier: FreeTierLimit | null, day: string): boolean {
    if (freeTier === null) return false;
    const used = this.usageFor(provider, day);
    if (freeTier.dailyCalls !== null && used.calls >= freeTier.dailyCalls) return true;
    if (freeTier.dailyTokens !== null && used.inputTokens + used.outputTokens >= freeTier.dailyTokens) {
      return true;
    }
    return false;
  }

  /** All recorded day-buckets (a defensive copy). */
  days(): ProviderDayUsage[] {
    return [...this._days.values()];
  }

  /** Roll usage up per provider and across the whole ledger. */
  summary(): ProviderUsageSummary {
    const byProvider = new Map<ProviderName, ProviderUsageRollup>();
    let totalCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const d of this._days.values()) {
      totalCalls += d.calls;
      totalInputTokens += d.inputTokens;
      totalOutputTokens += d.outputTokens;
      const roll = byProvider.get(d.provider) ?? {
        provider: d.provider,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      roll.calls += d.calls;
      roll.inputTokens += d.inputTokens;
      roll.outputTokens += d.outputTokens;
      roll.costUsd = round6(roll.costUsd + d.costUsd);
      byProvider.set(d.provider, roll);
    }
    const rollups = [...byProvider.values()];
    return {
      totalCalls,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd: round6(rollups.reduce((a, r) => a + r.costUsd, 0)),
      byProvider: rollups,
    };
  }

  /** Clear the ledger (e.g. between builds). */
  reset(): void {
    this._days.clear();
  }
}

/** Estimate the USD cost of an (input, output) token pair at a provider's list price. */
export function estimateProviderCost(
  pricing: ProviderPricing,
  inputTokens: number,
  outputTokens: number
): number {
  const inTok = safeTokens(inputTokens);
  const outTok = safeTokens(outputTokens);
  const cost = (inTok / 1_000_000) * pricing.inputPerMTok + (outTok / 1_000_000) * pricing.outputPerMTok;
  return round6(cost);
}

// ---------------------------------------------------------------------------
// Router options + results
// ---------------------------------------------------------------------------

/** The minimal `fetch` surface the router uses (so a test fake needs only this). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

/** Options for {@link ProviderRouter} — everything is overridable / injectable. */
export interface ProviderRouterOptions {
  /** Per-provider config overrides, merged over {@link DEFAULT_PROVIDERS}. */
  providers?: Partial<Record<ProviderName, Partial<ProviderConfig>>>;
  /** Task → provider-preference overrides, merged over {@link DEFAULT_ROUTES}. */
  routes?: Partial<Record<ForgeTaskType, ProviderName[]>>;
  /**
   * Optional chain reorderer applied to a task's provider preference before routing. The
   * Free-Tier Manager supplies one (via `freeTierRouterOptions`) to push providers with free
   * capacity remaining today to the front so every routing decision tries free options first.
   * It must PRESERVE the chain's membership (reorder only) so failover still works. Default:
   * identity (no reordering).
   */
  prioritizeChain?: (chain: ProviderName[], day: string) => ProviderName[];
  /** LiteLLM proxy base URL. Default `FORGE_LITELLM_PROXY_URL` / `LITELLM_PROXY_URL` env. */
  litellmProxyUrl?: string;
  /** LiteLLM proxy key (Bearer). Default `FORGE_LITELLM_PROXY_KEY` / `LITELLM_PROXY_KEY` env. */
  litellmProxyKey?: string;
  /** Injected HTTP client (tests / SDK swap). Default the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Shared usage + cost ledger. Default a fresh {@link ProviderUsageTracker}. */
  usage?: ProviderUsageTracker;
  /** Rate-limit cooldown ms after a 429 / 5xx. Default {@link DEFAULT_COOLDOWN_MS}. */
  cooldownMs?: number;
  /** Per-request timeout ms. Default {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Monotonic clock (ms) for cooldowns. Default `Date.now`. */
  now?: () => number;
  /** Current day stamp `YYYY-MM-DD`. Default the date half of {@link nowIso}. */
  today?: () => string;
  /** Read an env var. Default `process.env`. Injected so routing is testable without the shell. */
  getEnv?: (name: string) => string | undefined;
  /** Progress reporter. Default a `[FORGE:provider-router]`-prefixed console line. */
  log?: (message: string) => void;
}

/** One attempt the router made (for diagnostics / telemetry). */
export interface RouteAttempt {
  provider: ProviderName;
  /** Why it was skipped, or 'called' if attempted. */
  outcome: 'no_key' | 'cooldown' | 'free_tier_exhausted' | 'called';
  /** HTTP status (when called), else undefined. */
  status?: number;
  /** Error detail (when a called attempt failed). */
  error?: string;
}

/** A successful routed response — {@link ModelResponse} plus which provider answered. */
export interface RoutedResponse extends ModelResponse {
  /** The provider that produced the response. */
  provider: ProviderName;
  /** The model id actually requested. */
  model: string;
  /** Estimated USD cost of this call. */
  costUsd: number;
  /** Whether the call went through the LiteLLM proxy (vs a direct provider endpoint). */
  usedProxy: boolean;
  /** Every attempt made to satisfy this call, in order. */
  attempts: RouteAttempt[];
}

/** Thrown when no provider in a task's chain could satisfy the call (callers catch + fall back). */
export class AllProvidersExhaustedError extends Error {
  constructor(
    public readonly taskType: ForgeTaskType,
    public readonly attempts: RouteAttempt[]
  ) {
    const detail = attempts
      .map((a) => `${a.provider}:${a.outcome}${a.status ? `(${a.status})` : ''}`)
      .join(', ');
    super(`All providers exhausted for '${taskType}' [${detail || 'no eligible providers'}]`);
    this.name = 'AllProvidersExhaustedError';
  }
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/** Internal parsed body shapes (only the fields the router reads). */
interface AnthropicBody {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}
interface OpenAIBody {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Merge a partial provider override over its default config. */
function mergeProvider(base: ProviderConfig, over: Partial<ProviderConfig> | undefined): ProviderConfig {
  if (!over) return base;
  return {
    ...base,
    ...over,
    pricing: { ...base.pricing, ...(over.pricing ?? {}) },
    freeTier:
      over.freeTier === undefined ? base.freeTier : over.freeTier === null ? null : { ...over.freeTier },
    apiKeyEnvs: over.apiKeyEnvs ?? base.apiKeyEnvs,
  };
}

/**
 * The multi-provider router. Construct once (optionally with a shared ledger) and either call
 * {@link route} directly or hand {@link callModelFor} to a phase as its {@link CallModel}.
 */
export class ProviderRouter {
  private readonly providers: Record<ProviderName, ProviderConfig>;
  private readonly routes: Record<ForgeTaskType, ProviderName[]>;
  private readonly proxyUrl: string | null;
  private readonly proxyKey: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly usage: ProviderUsageTracker;
  private readonly cooldownMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly today: () => string;
  private readonly getEnv: (name: string) => string | undefined;
  private readonly log: (message: string) => void;
  /** Optional free-first (or other) chain reorderer; null = identity. */
  private readonly prioritizeChain: ((chain: ProviderName[], day: string) => ProviderName[]) | null;
  /** provider → epoch-ms until which it is in rate-limit cooldown. */
  private readonly cooldownUntil = new Map<ProviderName, number>();

  constructor(options: ProviderRouterOptions = {}) {
    const getEnv = options.getEnv ?? ((n: string) => process.env[n]);
    this.getEnv = getEnv;

    const names: ProviderName[] = ['anthropic', 'openai', 'gemini', 'deepseek'];
    const providers = {} as Record<ProviderName, ProviderConfig>;
    for (const name of names) {
      providers[name] = mergeProvider(DEFAULT_PROVIDERS[name], options.providers?.[name]);
    }
    this.providers = providers;

    this.routes = { ...DEFAULT_ROUTES, ...(options.routes ?? {}) };
    this.proxyUrl =
      options.litellmProxyUrl ??
      getEnv('FORGE_LITELLM_PROXY_URL') ??
      getEnv('LITELLM_PROXY_URL') ??
      null;
    this.proxyKey =
      options.litellmProxyKey ??
      getEnv('FORGE_LITELLM_PROXY_KEY') ??
      getEnv('LITELLM_PROXY_KEY') ??
      null;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.usage = options.usage ?? new ProviderUsageTracker();
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.today = options.today ?? (() => nowIso().slice(0, 10));
    this.log = options.log ?? logLine('provider-router');
    this.prioritizeChain = options.prioritizeChain ?? null;
  }

  /** The shared usage/cost ledger (read {@link ProviderUsageTracker.summary} for the report). */
  get usageTracker(): ProviderUsageTracker {
    return this.usage;
  }

  /** First non-empty API key across a provider's candidate env vars, or null. */
  private apiKeyFor(cfg: ProviderConfig): string | null {
    for (const envName of cfg.apiKeyEnvs) {
      const v = this.getEnv(envName);
      if (v !== undefined && v.trim() !== '') return v;
    }
    return null;
  }

  /** True while a provider is inside its rate-limit cooldown window. */
  private inCooldown(name: ProviderName): boolean {
    const until = this.cooldownUntil.get(name);
    return until !== undefined && this.now() < until;
  }

  /** Put a provider into cooldown (after a 429 / 5xx / network error). */
  private startCooldown(name: ProviderName): void {
    this.cooldownUntil.set(name, this.now() + this.cooldownMs);
  }

  /**
   * Route + perform a single reasoning call for `taskType`. Walks the task's provider chain,
   * skipping ineligible providers, and returns the first success. Throws
   * {@link AllProvidersExhaustedError} only when the whole chain is unavailable.
   */
  async route(taskType: ForgeTaskType, request: ModelRequest): Promise<RoutedResponse> {
    const baseChain = this.routes[taskType] ?? this.routes.complex_reasoning ?? ['anthropic'];
    const day = this.today();
    // Apply the optional free-first reorderer; identity when none is configured. The reorderer
    // only permutes the chain, so failover semantics are unchanged.
    const chain = this.prioritizeChain ? this.prioritizeChain(baseChain, day) : baseChain;
    const attempts: RouteAttempt[] = [];

    for (const name of chain) {
      const cfg = this.providers[name];
      const key = this.apiKeyFor(cfg);

      // Direct calls need the provider's own key; proxy calls authenticate to the proxy instead.
      if (!this.proxyUrl && key === null) {
        attempts.push({ provider: name, outcome: 'no_key' });
        continue;
      }
      if (this.inCooldown(name)) {
        attempts.push({ provider: name, outcome: 'cooldown' });
        continue;
      }
      if (this.usage.isFreeTierExhausted(name, cfg.freeTier, day)) {
        attempts.push({ provider: name, outcome: 'free_tier_exhausted' });
        this.log(`${name} free tier exhausted for ${day} — skipping`);
        continue;
      }

      try {
        const result = await this.callProvider(cfg, key, request);
        const costUsd = estimateProviderCost(cfg.pricing, result.tokensInput, result.tokensOutput);
        this.usage.record(
          { provider: name, inputTokens: result.tokensInput, outputTokens: result.tokensOutput, costUsd },
          day
        );
        attempts.push({ provider: name, outcome: 'called', status: 200 });
        this.log(
          `${taskType} → ${name}/${result.model}${this.proxyUrl ? ' (proxy)' : ''} ` +
            `~${result.tokensInput}+${result.tokensOutput} tok ≈ $${costUsd.toFixed(4)}`
        );
        return {
          text: result.text,
          tokensInput: result.tokensInput,
          tokensOutput: result.tokensOutput,
          provider: name,
          model: result.model,
          costUsd,
          usedProxy: this.proxyUrl !== null,
          attempts,
        };
      } catch (error) {
        const status = error instanceof ProviderHttpError ? error.status : undefined;
        const detail = error instanceof Error ? error.message : String(error);
        attempts.push({ provider: name, outcome: 'called', ...(status ? { status } : {}), error: detail });
        // 429 / 5xx / network = transient → cooldown + failover. 401/403/400 = drop + failover.
        if (status === undefined || status === 429 || status >= 500) {
          this.startCooldown(name);
          this.log(`${name} unavailable (${status ?? 'network'}) — cooling down, failing over`);
        } else {
          this.log(`${name} rejected the call (${status}) — failing over`);
        }
      }
    }

    throw new AllProvidersExhaustedError(taskType, attempts);
  }

  /**
   * Return a {@link CallModel} bound to `taskType` — the drop-in the phases inject in place of
   * `defaultCallModel`. The returned closure adapts a {@link RoutedResponse} down to the plain
   * {@link ModelResponse} the existing callers expect.
   */
  callModelFor(taskType: ForgeTaskType): CallModel {
    return async (request: ModelRequest): Promise<ModelResponse> => {
      const routed = await this.route(taskType, request);
      return { text: routed.text, tokensInput: routed.tokensInput, tokensOutput: routed.tokensOutput };
    };
  }

  /** Snapshot the usage/cost summary across every provider seen this run. */
  usageSummary(): ProviderUsageSummary {
    return this.usage.summary();
  }

  // -------------------------------------------------------------------------
  // Single-provider HTTP (direct endpoint or LiteLLM proxy)
  // -------------------------------------------------------------------------

  /** Perform ONE call to a specific provider, via the proxy when configured else its native API. */
  private async callProvider(
    cfg: ProviderConfig,
    apiKey: string | null,
    request: ModelRequest
  ): Promise<ModelResponse & { model: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      if (this.proxyUrl) {
        return await this.callViaProxy(cfg, request, controller.signal);
      }
      if (cfg.protocol === 'anthropic') {
        return await this.callAnthropicDirect(cfg, apiKey as string, request, controller.signal);
      }
      return await this.callOpenAiDirect(cfg, apiKey as string, request, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The model id to ask for: the caller's pin if set, else the provider default. */
  private modelIdFor(cfg: ProviderConfig, request: ModelRequest): string {
    const pinned = request.model.trim();
    // A caller pin is honoured only for the provider it names (Claude ids → anthropic); otherwise
    // each provider uses its own default model so a Claude id never leaks to OpenAI/DeepSeek/Gemini.
    if (cfg.protocol === 'anthropic' && pinned !== '') return pinned;
    return cfg.defaultModel;
  }

  /** Direct Anthropic Messages API call (Claude). */
  private async callAnthropicDirect(
    cfg: ProviderConfig,
    apiKey: string,
    request: ModelRequest,
    signal: AbortSignal
  ): Promise<ModelResponse & { model: string }> {
    const model = this.modelIdFor(cfg, request);
    const res = await this.fetchImpl(cfg.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      }),
      signal,
    });
    if (!res.ok) throw await ProviderHttpError.from(cfg.name, res);
    const raw = await res.json();
    // Validate the external API response before reading it (Iron Law 8). Non-blocking:
    // a shape mismatch is logged to the `forge-validation` channel; the tolerant read
    // below still runs so a sparse-but-valid body is never rejected.
    validateApiResponse(AnthropicMessagesResponseSchema, raw, {
      context: `provider-router:${cfg.name}`,
      target: 'anthropic-messages',
    });
    const body = (raw ?? {}) as AnthropicBody;
    const text = (body.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text ?? '')
      .join('');
    if (text.trim() === '') throw new ProviderHttpError(cfg.name, 200, 'Anthropic returned no text content');
    return {
      text,
      tokensInput: body.usage?.input_tokens ?? 0,
      tokensOutput: body.usage?.output_tokens ?? 0,
      model,
    };
  }

  /** Direct OpenAI-Chat-Completions call (GPT-4o-mini, DeepSeek, Gemini OpenAI-compat endpoint). */
  private async callOpenAiDirect(
    cfg: ProviderConfig,
    apiKey: string,
    request: ModelRequest,
    signal: AbortSignal
  ): Promise<ModelResponse & { model: string }> {
    const model = this.modelIdFor(cfg, request);
    const res = await this.fetchImpl(cfg.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: request.maxTokens,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }),
      signal,
    });
    if (!res.ok) throw await ProviderHttpError.from(cfg.name, res);
    return this.readOpenAiBody(cfg, model, await res.json());
  }

  /** LiteLLM proxy call (OpenAI-compatible, model = `${prefix}${model}`). */
  private async callViaProxy(
    cfg: ProviderConfig,
    request: ModelRequest,
    signal: AbortSignal
  ): Promise<ModelResponse & { model: string }> {
    const url = normalizeProxyUrl(this.proxyUrl as string);
    const bareModel = this.modelIdFor(cfg, request);
    const litellmModel = `${cfg.litellmPrefix}${bareModel}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.proxyKey) headers['authorization'] = `Bearer ${this.proxyKey}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: litellmModel,
        max_tokens: request.maxTokens,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }),
      signal,
    });
    if (!res.ok) throw await ProviderHttpError.from(cfg.name, res);
    return this.readOpenAiBody(cfg, litellmModel, await res.json());
  }

  /** Parse an OpenAI-shaped success body into a {@link ModelResponse}. */
  private readOpenAiBody(
    cfg: ProviderConfig,
    model: string,
    raw: unknown
  ): ModelResponse & { model: string } {
    // Validate the external API response before reading it (Iron Law 8). Non-blocking
    // (logs shape drift to `forge-validation`); the tolerant read below still runs.
    validateApiResponse(OpenAIChatResponseSchema, raw, {
      context: `provider-router:${cfg.name}`,
      target: 'openai-chat',
    });
    const body = (raw ?? {}) as OpenAIBody;
    const first = body.choices?.[0];
    const text = first?.message?.content ?? '';
    if (typeof text !== 'string' || text.trim() === '') {
      throw new ProviderHttpError(cfg.name, 200, `${cfg.name} returned no message content`);
    }
    return {
      text,
      tokensInput: body.usage?.prompt_tokens ?? 0,
      tokensOutput: body.usage?.completion_tokens ?? 0,
      model,
    };
  }
}

/** A non-2xx (or empty-body) provider response — carries the status for cooldown/failover policy. */
export class ProviderHttpError extends Error {
  constructor(
    public readonly provider: ProviderName,
    public readonly status: number,
    message: string
  ) {
    super(`${provider} HTTP ${status}: ${message}`);
    this.name = 'ProviderHttpError';
  }

  /** Build one from a non-ok response, reading a truncated body for context. */
  static async from(
    provider: ProviderName,
    res: { status: number; statusText: string; text: () => Promise<string> }
  ): Promise<ProviderHttpError> {
    const detail = (await res.text().catch(() => '')).slice(0, 500);
    return new ProviderHttpError(provider, res.status, `${res.statusText} ${detail}`.trim());
  }
}

/** Ensure a LiteLLM proxy base URL points at its chat-completions endpoint. */
function normalizeProxyUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

// ---------------------------------------------------------------------------
// Module-level convenience (shared router + ledger across phases)
// ---------------------------------------------------------------------------

/** A process-wide default router so the three reasoning phases share one usage/cost ledger. */
let sharedRouter: ProviderRouter | null = null;

/** Get (or lazily create) the shared {@link ProviderRouter}. */
export function getProviderRouter(options?: ProviderRouterOptions): ProviderRouter {
  if (sharedRouter === null) sharedRouter = new ProviderRouter(options);
  return sharedRouter;
}

/** Replace the shared router (tests / reconfiguration). Pass null to clear it. */
export function setProviderRouter(router: ProviderRouter | null): void {
  sharedRouter = router;
}

/**
 * Convenience {@link CallModel} for a task type, bound to the shared router — the exact drop-in
 * the phases use in place of `defaultCallModel`:
 *   `const callModel = options.callModel ?? providerCallModel('complex_reasoning');`
 */
export function providerCallModel(taskType: ForgeTaskType, options?: ProviderRouterOptions): CallModel {
  return getProviderRouter(options).callModelFor(taskType);
}

export default ProviderRouter;



