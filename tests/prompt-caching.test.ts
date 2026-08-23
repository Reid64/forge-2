/**
 * FORGE 2.0 — Anthropic prompt-caching unit test (Provider Router direct path).
 *
 * `callAnthropicDirect` (src/engine/provider-router.ts) is the only place in FORGE that
 * constructs a real Anthropic Messages API request payload — the Phase 3 build queue instead
 * pipes a flat string to the Claude Code CLI over stdin, which has no JSON request FORGE builds
 * and so no `cache_control` surface. This test mocks the Anthropic API and exercises exactly the
 * caching contract that path supports: a stable `system` prompt (e.g. governance/instruction
 * context a caller assembled) is sent with `cache_control: { type: 'ephemeral' }` on its content
 * block, the first call reports `cache_creation_input_tokens` (a cache WRITE), and a second call
 * reusing the same system text reports `cache_read_input_tokens` with NO `cache_creation_input_tokens`
 * (a cache HIT, not a fresh write).
 *
 * HOW TO RUN
 *     node --import tsx --test tests/prompt-caching.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProviderRouter, type FetchLike } from '../src/engine/provider-router.js';
import type { ModelRequest } from '../src/phases/phase1a-prd.js';

const GOVERNANCE_SYSTEM_PROMPT =
  '## Governance (authoritative)\n\n### BLUEPRINT.md\n\nFORGE default stack...\n\n' +
  '### SCHEMA_REGISTRY.md\n\nusers table...';

function makeRequest(user: string): ModelRequest {
  return { model: 'claude-sonnet-4-6', maxTokens: 512, system: GOVERNANCE_SYSTEM_PROMPT, user, apiKey: '' };
}

/** A scripted fetch that returns a cache WRITE on the first call and a cache READ on the second. */
function makeCachingFetch(): { fetchImpl: FetchLike; calls: Array<{ url: string; body: any }> } {
  const calls: Array<{ url: string; body: any }> = [];
  let callCount = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    callCount += 1;
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const usage =
      callCount === 1
        ? { input_tokens: 12, output_tokens: 20, cache_creation_input_tokens: 340 }
        : { input_tokens: 12, output_tokens: 18, cache_read_input_tokens: 340 };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ content: [{ type: 'text', text: `reply ${callCount}` }], usage }),
      json: async () => ({ content: [{ type: 'text', text: `reply ${callCount}` }], usage }),
    };
  };
  return { fetchImpl, calls };
}

function allKeys(): (name: string) => string | undefined {
  return (n) => (n === 'ANTHROPIC_API_KEY' ? 'sk-ant' : undefined);
}

test('prompt caching: system prompt is sent as a cache_control-marked content block', async () => {
  const { fetchImpl, calls } = makeCachingFetch();
  const router = new ProviderRouter({
    fetchImpl,
    getEnv: allKeys(),
    routes: { validation: ['anthropic'] },
  });

  await router.route('validation', makeRequest('first prompt'));

  const sentSystem = calls[0]?.body?.system;
  assert.ok(Array.isArray(sentSystem), 'system should be sent as content blocks, not a plain string');
  assert.equal(sentSystem.length, 1);
  assert.equal(sentSystem[0].type, 'text');
  assert.equal(sentSystem[0].text, GOVERNANCE_SYSTEM_PROMPT);
  assert.deepEqual(sentSystem[0].cache_control, { type: 'ephemeral' });
});

test('prompt caching: first call creates the cache, second call reads it (no re-creation)', async () => {
  const { fetchImpl } = makeCachingFetch();
  const router = new ProviderRouter({
    fetchImpl,
    getEnv: allKeys(),
    routes: { validation: ['anthropic'] },
  });

  const first = await router.route('validation', makeRequest('first prompt'));
  assert.equal(first.cacheCreationTokens, 340, 'first call should report a cache write');
  assert.equal(first.cacheReadTokens, 0, 'first call must not report a cache read');

  const second = await router.route('validation', makeRequest('second prompt, same governance docs'));
  assert.equal(second.cacheReadTokens, 340, 'second call should report a cache hit');
  assert.equal(second.cacheCreationTokens, 0, 'second call must NOT report cache_creation — it was a cache read');
  assert.ok(second.cacheSavedUsd > 0, 'a cache hit should have a positive estimated dollar saving');

  const summary = router.usageTracker.summary();
  assert.equal(summary.totalCacheCreationTokens, 340);
  assert.equal(summary.totalCacheReadTokens, 340);
  assert.ok(summary.totalCacheSavedUsd > 0);
});

test('prompt caching: enablePromptCaching=false sends a plain string system prompt', async () => {
  // No cache_control was sent, so a real Anthropic response would carry no cache usage fields.
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const payload = { content: [{ type: 'text', text: 'reply' }], usage: { input_tokens: 12, output_tokens: 20 } };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    };
  };
  const router = new ProviderRouter({
    fetchImpl,
    getEnv: allKeys(),
    routes: { validation: ['anthropic'] },
    enablePromptCaching: false,
  });

  const result = await router.route('validation', makeRequest('first prompt'));

  assert.equal(typeof calls[0]?.body?.system, 'string', 'caching disabled — system should stay a plain string');
  assert.equal(calls[0]?.body?.system, GOVERNANCE_SYSTEM_PROMPT);
  assert.equal(result.cacheCreationTokens, 0);
  assert.equal(result.cacheReadTokens, 0);
});
