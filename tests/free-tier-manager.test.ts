/**
 * FORGE 2.0 — Free-Tier Manager unit test.
 *
 * Exercises the provider free-tier governor with NO disk, NO network and NO Build Memory: the
 * store, clock, UTC day stamp and provider settings are all injected, so config parsing,
 * persistence + hydration, free-tier classification, free-first prioritisation, rate limiting,
 * the daily savings report, midnight-UTC reset and the Provider Router integration are all
 * verified deterministically in-process.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/free-tier-manager.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FreeTierManager,
  parseProvidersConfig,
  freeTierRouterOptions,
  nextUtcMidnightIso,
  renderDailyCostReport,
  type FreeTierStore,
  type PersistedUsageEntry,
} from '../src/engine/free-tier-manager.js';
import {
  ProviderRouter,
  type FetchLike,
  type ProviderName,
} from '../src/engine/provider-router.js';
import type { ModelRequest } from '../src/phases/phase1a-prd.js';

// ---------------------------------------------------------------------------
// In-memory store + helpers
// ---------------------------------------------------------------------------

function memStore(seed: PersistedUsageEntry[] = []): { store: FreeTierStore; rows: PersistedUsageEntry[] } {
  const rows: PersistedUsageEntry[] = [...seed];
  const store: FreeTierStore = {
    async loadDay(_scope, day) {
      return rows.filter((r) => r.day === day);
    },
    async append(_scope, entry) {
      rows.push(entry);
    },
  };
  return { store, rows };
}

const DAY = '2026-06-11';
const req: ModelRequest = { system: 's', user: 'u', model: 'claude-sonnet-4-6', maxTokens: 100, apiKey: '' };

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

test('parseProvidersConfig reads ceilings, rate limits, pricing and ignores unknown providers', () => {
  const { settings, warnings } = parseProvidersConfig({
    providers: {
      gemini: {
        paid: true,
        priority: 5,
        freeTier: { dailyCalls: 1500, dailyTokens: null },
        rateLimit: { requestsPerMinute: 15, tokensPerMinute: 1000000 },
        pricing: { inputPerMTok: 0.075, outputPerMTok: 0.3 },
      },
      anthropic: { freeTier: null },
      bogus: { paid: true },
    },
  });
  assert.equal(settings.gemini?.priority, 5);
  assert.deepEqual(settings.gemini?.freeTier, { dailyCalls: 1500, dailyTokens: null });
  assert.equal(settings.gemini?.rateLimit?.requestsPerMinute, 15);
  assert.equal(settings.anthropic?.freeTier, null);
  assert.ok(warnings.some((w) => w.includes('bogus')));
});

// ---------------------------------------------------------------------------
// Free-tier classification + exhaustion
// ---------------------------------------------------------------------------

test('calls within the free quota classify as free; the call that crosses it classifies paid', async () => {
  const { store } = memStore();
  const m = await FreeTierManager.fromConfig({
    store,
    today: () => DAY,
    now: () => 1_000_000,
    settings: { gemini: { freeTier: { dailyCalls: 2, dailyTokens: null } } },
  });
  const tracker = m.usageTracker;
  // 2 free calls allowed.
  assert.equal(m.classifyTier('gemini', DAY), 'free');
  tracker.record({ provider: 'gemini', inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, DAY);
  assert.equal(m.classifyTier('gemini', DAY), 'free');
  tracker.record({ provider: 'gemini', inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, DAY);
  // quota now spent → next call is paid.
  assert.equal(m.classifyTier('gemini', DAY), 'paid');
  const avail = m.availability('gemini', DAY);
  assert.equal(avail.freeTierExhausted, true);
  assert.equal(avail.freeTierAvailable, false);
  assert.equal(avail.remainingCalls, 0);
});

test('a paid-only provider always classifies paid and reports no free tier', async () => {
  const { store } = memStore();
  const m = await FreeTierManager.fromConfig({ store, today: () => DAY });
  assert.equal(m.classifyTier('anthropic', DAY), 'paid');
  assert.equal(m.availability('anthropic', DAY).freeTierConfigured, false);
});

// ---------------------------------------------------------------------------
// Persistence + hydration across "restarts"
// ---------------------------------------------------------------------------

test('usage persists to the store and rehydrates into a fresh manager', async () => {
  const { store, rows } = memStore();
  const m1 = await FreeTierManager.fromConfig({
    store,
    today: () => DAY,
    now: () => 5_000,
    settings: { gemini: { freeTier: { dailyCalls: 3, dailyTokens: null } } },
  });
  m1.usageTracker.record({ provider: 'gemini', inputTokens: 10, outputTokens: 5, costUsd: 0.02 }, DAY);
  m1.usageTracker.record({ provider: 'gemini', inputTokens: 10, outputTokens: 5, costUsd: 0.02 }, DAY);
  // allow the fire-and-forget append microtasks to settle
  await Promise.resolve();
  assert.equal(rows.length, 2);

  // New manager, same store → hydrates the 2 prior calls.
  const m2 = await FreeTierManager.fromConfig({
    store,
    today: () => DAY,
    now: () => 9_000,
    settings: { gemini: { freeTier: { dailyCalls: 3, dailyTokens: null } } },
  });
  assert.equal(m2.availability('gemini', DAY).remainingCalls, 1);
  assert.equal(m2.classifyTier('gemini', DAY), 'free');
});

// ---------------------------------------------------------------------------
// Free-first prioritisation
// ---------------------------------------------------------------------------

test('prioritize pushes free-capable providers to the front, paid/exhausted to the tail', async () => {
  const { store } = memStore();
  const m = await FreeTierManager.fromConfig({
    store,
    today: () => DAY,
    now: () => 1_000,
    settings: {
      gemini: { priority: 10, freeTier: { dailyCalls: 5, dailyTokens: null } },
      openai: { priority: 20, freeTier: { dailyCalls: 5, dailyTokens: null } },
      anthropic: { freeTier: null },
      deepseek: { freeTier: null },
    },
  });
  // anthropic first in chain, but gemini+openai have free tiers → they lead, by priority.
  const chain: ProviderName[] = ['anthropic', 'deepseek', 'openai', 'gemini'];
  assert.deepEqual(m.prioritize(chain, DAY), ['gemini', 'openai', 'anthropic', 'deepseek']);
});

test('an exhausted free provider drops to the fall-back tail', async () => {
  const { store } = memStore();
  const m = await FreeTierManager.fromConfig({
    store,
    today: () => DAY,
    now: () => 1_000,
    settings: { gemini: { priority: 10, freeTier: { dailyCalls: 1, dailyTokens: null } } },
  });
  m.usageTracker.record({ provider: 'gemini', inputTokens: 1, outputTokens: 1, costUsd: 0 }, DAY);
  // gemini exhausted → anthropic (paid) and gemini both go to the tail in chain order.
  assert.deepEqual(m.prioritize(['anthropic', 'gemini'], DAY), ['anthropic', 'gemini']);
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

test('a provider over its requests-per-minute is rate-limited and not prioritised free', async () => {
  const { store } = memStore();
  let clock = 0;
  const m = await FreeTierManager.fromConfig({
    store,
    today: () => DAY,
    now: () => clock,
    settings: {
      gemini: { freeTier: { dailyCalls: 100, dailyTokens: null }, rateLimit: { requestsPerMinute: 2, tokensPerMinute: null } },
    },
  });
  m.usageTracker.record({ provider: 'gemini', inputTokens: 1, outputTokens: 1, costUsd: 0 }, DAY);
  m.usageTracker.record({ provider: 'gemini', inputTokens: 1, outputTokens: 1, costUsd: 0 }, DAY);
  assert.equal(m.isRateLimited('gemini'), true);
  // gemini is rate-limited → falls to the tail despite free capacity.
  assert.deepEqual(m.prioritize(['gemini', 'anthropic'], DAY), ['anthropic', 'gemini']);
  // after the 60s window passes, it recovers.
  clock = 61_000;
  assert.equal(m.isRateLimited('gemini'), false);
});

// ---------------------------------------------------------------------------
// Daily cost report
// ---------------------------------------------------------------------------

test('daily cost report splits free vs paid and estimates savings', async () => {
  const { store } = memStore();
  const m = await FreeTierManager.fromConfig({
    store,
    today: () => DAY,
    now: () => 1_000,
    settings: { gemini: { freeTier: { dailyCalls: 1, dailyTokens: null } } },
  });
  // first call free (saved $0.05), second paid (spent $0.05)
  m.usageTracker.record({ provider: 'gemini', inputTokens: 100, outputTokens: 50, costUsd: 0.05 }, DAY);
  m.usageTracker.record({ provider: 'gemini', inputTokens: 100, outputTokens: 50, costUsd: 0.05 }, DAY);
  const report = m.dailyCostReport(DAY);
  assert.equal(report.totalFreeCalls, 1);
  assert.equal(report.totalPaidCalls, 1);
  assert.equal(report.totalSavingsUsd, 0.05);
  assert.equal(report.totalPaidCostUsd, 0.05);
  assert.ok(renderDailyCostReport(report).includes('gemini'));
});

// ---------------------------------------------------------------------------
// Midnight UTC reset
// ---------------------------------------------------------------------------

test('nextUtcMidnightIso returns the next 00:00 UTC', () => {
  const ms = Date.UTC(2026, 5, 11, 14, 30, 0); // 2026-06-11T14:30Z
  assert.equal(nextUtcMidnightIso(ms), '2026-06-12T00:00:00.000Z');
});

test('quota resets when the UTC day stamp rolls over', async () => {
  const { store, rows } = memStore();
  let day = DAY;
  const m = await FreeTierManager.fromConfig({
    store,
    today: () => day,
    now: () => 1_000,
    settings: { gemini: { freeTier: { dailyCalls: 1, dailyTokens: null } } },
  });
  m.usageTracker.record({ provider: 'gemini', inputTokens: 1, outputTokens: 1, costUsd: 0 }, day);
  assert.equal(m.classifyTier('gemini', day), 'paid'); // spent for 2026-06-11
  day = '2026-06-12';
  assert.equal(m.classifyTier('gemini', day), 'free'); // fresh quota for the new UTC day
  assert.ok(rows.length >= 1);
});

// ---------------------------------------------------------------------------
// Provider Router integration
// ---------------------------------------------------------------------------

test('freeTierRouterOptions makes the router try a free provider before a paid one', async () => {
  const { store } = memStore();
  const m = await FreeTierManager.fromConfig({
    store,
    today: () => DAY,
    now: () => 1_000,
    settings: {
      gemini: { priority: 10, freeTier: { dailyCalls: 100, dailyTokens: null } },
      anthropic: { freeTier: null },
    },
  });

  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{}',
      json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    };
  };

  const router = new ProviderRouter({
    ...freeTierRouterOptions(m),
    fetchImpl,
    // Every provider has a key, but NOT a LiteLLM proxy — a blanket `() => 'key'` would also
    // satisfy the router's `FORGE_LITELLM_PROXY_URL`/`LITELLM_PROXY_KEY` lookups, routing every
    // call through a (nonexistent) proxy instead of hitting each provider's own endpoint.
    getEnv: (n) => (n.includes('PROXY') ? undefined : 'key'),
    // complex_reasoning's default chain is anthropic-only; override it so gemini is a chain
    // member the reorderer can actually promote ahead of anthropic.
    routes: { complex_reasoning: ['anthropic', 'gemini'] },
    // Defensive only: if gemini is correctly promoted first and succeeds, anthropic's CLI leg is
    // never reached at all — but this test must never fall through to the real `claude` CLI.
    runClaudeCli: async () => {
      throw new Error('test bug: should never reach the Claude CLI — gemini should have been tried first');
    },
  });
  const res = await router.route('complex_reasoning', req);
  assert.equal(res.provider, 'gemini');
  assert.ok(calls[0]?.includes('generativelanguage')); // gemini endpoint hit first
  // and the call was recorded as free in the shared ledger / manager report.
  assert.equal(m.dailyCostReport(DAY).totalFreeCalls, 1);
});
