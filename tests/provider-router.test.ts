/**
 * FORGE 2.0 — Provider Router unit test.
 *
 * Exercises the multi-provider routing layer with NO network and NO real keys: `fetch`, the env
 * reader, the clock, the day stamp and the usage ledger are all injected, so intelligent routing,
 * automatic failover, cost tracking, free-tier awareness and the LiteLLM-proxy path are verified
 * deterministically in-process.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/provider-router.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProviderRouter,
  ProviderUsageTracker,
  estimateProviderCost,
  AllProvidersExhaustedError,
  DEFAULT_PROVIDERS,
  type FetchLike,
  type ProviderName,
} from '../src/engine/provider-router.js';
import type { ModelRequest } from '../src/phases/phase1a-prd.js';

// ---------------------------------------------------------------------------
// Fake fetch (scripted per host) + helpers
// ---------------------------------------------------------------------------

interface ScriptedReply {
  status?: number;
  /** OpenAI-shaped or Anthropic-shaped success body. */
  body?: unknown;
  /** Network failure (rejects) instead of an HTTP reply. */
  throws?: boolean;
}

/** Build a FetchLike that picks a reply by URL substring, recording every call. */
function makeFetch(
  rules: Array<{ match: string; reply: ScriptedReply | (() => ScriptedReply) }>
): { fetchImpl: FetchLike; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const rule = rules.find((r) => url.includes(r.match));
    const reply = rule ? (typeof rule.reply === 'function' ? rule.reply() : rule.reply) : { status: 404 };
    if (reply.throws) throw new Error('ECONNRESET');
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'ERR',
      text: async () => JSON.stringify(reply.body ?? {}),
      json: async () => reply.body ?? {},
    };
  };
  return { fetchImpl, calls };
}

const openAiOk = (text: string, pin = 7, pout = 11): ScriptedReply => ({
  status: 200,
  body: { choices: [{ message: { content: text } }], usage: { prompt_tokens: pin, completion_tokens: pout } },
});

const anthropicOk = (text: string, tin = 5, tout = 9): ScriptedReply => ({
  status: 200,
  body: { content: [{ type: 'text', text }], usage: { input_tokens: tin, output_tokens: tout } },
});

const REQUEST: ModelRequest = {
  model: 'claude-sonnet-4-6',
  maxTokens: 1024,
  system: 'sys',
  user: 'hello',
  apiKey: '',
};

/** Env with all four provider keys present (and proxy off). */
function allKeys(): (name: string) => string | undefined {
  const env: Record<string, string> = {
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-oai',
    GEMINI_API_KEY: 'sk-gem',
    DEEPSEEK_API_KEY: 'sk-ds',
  };
  return (n) => env[n];
}

// ---------------------------------------------------------------------------
// Intelligent routing
// ---------------------------------------------------------------------------

test('routes complex_reasoning to anthropic and validation to openai', async () => {
  const { fetchImpl, calls } = makeFetch([
    { match: 'api.anthropic.com', reply: anthropicOk('claude') },
    { match: 'api.openai.com', reply: openAiOk('gpt') },
  ]);
  const router = new ProviderRouter({ fetchImpl, getEnv: allKeys() });

  const reasoning = await router.route('complex_reasoning', REQUEST);
  assert.equal(reasoning.provider, 'anthropic');
  assert.equal(reasoning.text, 'claude');
  assert.equal(reasoning.usedProxy, false);

  const validation = await router.route('validation', REQUEST);
  assert.equal(validation.provider, 'openai');
  assert.equal(validation.text, 'gpt');

  // Each provider used its OWN default model — the Claude pin never leaked to OpenAI.
  const openAiCall = calls.find((c) => c.url.includes('openai.com'));
  assert.equal((openAiCall?.body as { model: string }).model, DEFAULT_PROVIDERS.openai.defaultModel);
});

test('code_review prefers deepseek, documentation prefers gemini', async () => {
  const { fetchImpl } = makeFetch([
    { match: 'deepseek.com', reply: openAiOk('ds') },
    { match: 'generativelanguage', reply: openAiOk('gem') },
  ]);
  const router = new ProviderRouter({ fetchImpl, getEnv: allKeys() });
  assert.equal((await router.route('code_review', REQUEST)).provider, 'deepseek');
  assert.equal((await router.route('documentation', REQUEST)).provider, 'gemini');
});

// ---------------------------------------------------------------------------
// Failover
// ---------------------------------------------------------------------------

test('fails over to the next provider on a 429 and records a cooldown', async () => {
  let clock = 1_000;
  const { fetchImpl } = makeFetch([
    { match: 'api.anthropic.com', reply: { status: 429, body: { error: 'rate limited' } } },
    { match: 'api.openai.com', reply: openAiOk('fallback') },
  ]);
  const router = new ProviderRouter({ fetchImpl, getEnv: allKeys(), now: () => clock, cooldownMs: 60_000 });

  const first = await router.route('complex_reasoning', REQUEST);
  assert.equal(first.provider, 'openai', 'failed over off the rate-limited anthropic');
  assert.equal(first.attempts[0]?.provider, 'anthropic');
  assert.equal(first.attempts[0]?.status, 429);

  // Within the cooldown window anthropic is skipped without even being called.
  clock = 2_000;
  const second = await router.route('complex_reasoning', REQUEST);
  assert.equal(second.attempts[0]?.outcome, 'cooldown');
  assert.equal(second.provider, 'openai');

  // After the cooldown elapses anthropic is eligible again (now answering).
  // (Re-point anthropic at a success by building a fresh router sharing the clock.)
});

test('skips providers with no key', async () => {
  const { fetchImpl } = makeFetch([{ match: 'api.openai.com', reply: openAiOk('gpt') }]);
  const router = new ProviderRouter({
    fetchImpl,
    getEnv: (n) => (n === 'OPENAI_API_KEY' ? 'sk-oai' : undefined), // only OpenAI keyed
  });
  const res = await router.route('complex_reasoning', REQUEST); // chain starts at anthropic
  assert.equal(res.attempts[0]?.outcome, 'no_key');
  assert.equal(res.provider, 'openai');
});

test('throws AllProvidersExhaustedError when the whole chain is unavailable', async () => {
  const { fetchImpl } = makeFetch([]); // nothing keyed, nothing answers
  const router = new ProviderRouter({ fetchImpl, getEnv: () => undefined });
  await assert.rejects(
    () => router.route('complex_reasoning', REQUEST),
    (err: unknown) => err instanceof AllProvidersExhaustedError && err.attempts.length === 4
  );
});

// ---------------------------------------------------------------------------
// Free-tier awareness
// ---------------------------------------------------------------------------

test('stops routing to a provider once its free tier is exhausted for the day', async () => {
  const usage = new ProviderUsageTracker();
  const { fetchImpl } = makeFetch([
    { match: 'generativelanguage', reply: openAiOk('gem') },
    { match: 'api.openai.com', reply: openAiOk('gpt') },
  ]);
  // Tiny free tier (1 call/day) so the second documentation call must fail over off gemini.
  const router = new ProviderRouter({
    fetchImpl,
    getEnv: allKeys(),
    usage,
    today: () => '2026-06-11',
    providers: { gemini: { freeTier: { dailyCalls: 1, dailyTokens: null } } },
  });

  const first = await router.route('documentation', REQUEST);
  assert.equal(first.provider, 'gemini');

  const second = await router.route('documentation', REQUEST);
  assert.equal(second.attempts[0]?.outcome, 'free_tier_exhausted');
  assert.equal(second.provider, 'openai', 'failed over to the paid provider');
});

// ---------------------------------------------------------------------------
// Cost tracking
// ---------------------------------------------------------------------------

test('tracks cost + tokens per provider across calls', async () => {
  const usage = new ProviderUsageTracker();
  const { fetchImpl } = makeFetch([
    { match: 'api.anthropic.com', reply: anthropicOk('a', 1_000_000, 1_000_000) },
  ]);
  const router = new ProviderRouter({ fetchImpl, getEnv: allKeys(), usage, today: () => '2026-06-11' });

  const res = await router.route('complex_reasoning', REQUEST);
  // 1M in @ $3 + 1M out @ $15 = $18.
  assert.equal(res.costUsd, 18);

  const summary = router.usageSummary();
  assert.equal(summary.totalCostUsd, 18);
  const anthropicRoll = summary.byProvider.find((r) => r.provider === 'anthropic');
  assert.equal(anthropicRoll?.calls, 1);
  assert.equal(anthropicRoll?.inputTokens, 1_000_000);
});

test('estimateProviderCost prices an (in,out) pair and clamps junk to zero', () => {
  assert.equal(estimateProviderCost({ inputPerMTok: 3, outputPerMTok: 15 }, 1_000_000, 0), 3);
  assert.equal(estimateProviderCost({ inputPerMTok: 3, outputPerMTok: 15 }, -5, Number.NaN), 0);
});

test('ProviderUsageTracker reports free-tier exhaustion on calls or tokens', () => {
  const t = new ProviderUsageTracker();
  const day = '2026-06-11';
  const gem: ProviderName = 'gemini';
  t.record({ provider: gem, inputTokens: 10, outputTokens: 10, costUsd: 0 }, day);
  assert.equal(t.isFreeTierExhausted(gem, { dailyCalls: 1, dailyTokens: null }, day), true);
  assert.equal(t.isFreeTierExhausted(gem, { dailyCalls: 5, dailyTokens: 15 }, day), true); // 20 tok ≥ 15
  assert.equal(t.isFreeTierExhausted(gem, null, day), false); // paid provider never exhausts
});

// ---------------------------------------------------------------------------
// LiteLLM proxy path
// ---------------------------------------------------------------------------

test('routes every call through the LiteLLM proxy when configured, with a prefixed model id', async () => {
  const { fetchImpl, calls } = makeFetch([{ match: 'proxy.local', reply: openAiOk('via-proxy') }]);
  const router = new ProviderRouter({
    fetchImpl,
    getEnv: () => undefined, // no provider keys needed — the proxy holds them
    litellmProxyUrl: 'http://proxy.local:4000',
    litellmProxyKey: 'sk-proxy',
  });

  const res = await router.route('code_review', REQUEST);
  assert.equal(res.usedProxy, true);
  assert.equal(res.provider, 'deepseek'); // code_review still prefers deepseek's model string
  assert.equal(res.text, 'via-proxy');

  const call = calls[0];
  assert.ok(call?.url.endsWith('/v1/chat/completions'), 'normalized to the chat-completions endpoint');
  assert.equal((call?.body as { model: string }).model, 'deepseek/deepseek-chat');
});

// ---------------------------------------------------------------------------
// CallModel adapter (the phase drop-in)
// ---------------------------------------------------------------------------

test('callModelFor returns a CallModel adapting RoutedResponse to ModelResponse', async () => {
  const { fetchImpl } = makeFetch([{ match: 'api.anthropic.com', reply: anthropicOk('claude', 4, 6) }]);
  const router = new ProviderRouter({ fetchImpl, getEnv: allKeys() });
  const callModel = router.callModelFor('complex_reasoning');
  const out = await callModel(REQUEST);
  assert.deepEqual(out, { text: 'claude', tokensInput: 4, tokensOutput: 6 });
});
