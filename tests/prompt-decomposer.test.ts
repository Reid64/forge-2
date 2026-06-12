/**
 * FORGE 2.0 — Prompt Decomposer unit test (Phase 3 engine).
 *
 * Pure `node:test` — NO `claude`, NO git, NO database. The splitter is a pure function exercised
 * directly; the sequential executor is driven with EVERY collaborator injected (a scripted claude
 * runner, a scripted Sentinel runner, recording commit + recordDecomposition sinks), so the
 * sequencing, the retry-in-isolation behaviour, and the Build-Memory record are verified with no
 * external process.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/prompt-decomposer.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldDecompose,
  decompose,
  runDecomposedPrompt,
  DECOMPOSITION_THRESHOLD,
  type DecompositionParent,
  type DecompositionDeps,
  type DecompositionRecord,
} from '../src/engine/prompt-decomposer.js';
import type { ClaudeRunResult } from '../src/engine/claude-runner.js';
import type { SentinelResult } from '../src/phases/phase4-sentinel.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSEMBLED = 'ASSEMBLED CONTEXT (governance + warnings + previous Sentinel).';

const LIST_DESC = [
  'Build the following in order:',
  '- Create the users table with RLS policies and company_id scoping.',
  '- Create the UserCard component that renders a user name and avatar.',
  '- Create the GET /api/users route returning company-scoped users.',
].join('\n');

function parent(over: Partial<DecompositionParent> = {}): DecompositionParent {
  return {
    id: over.id ?? 'p1',
    name: over.name ?? 'Users feature',
    promptType: over.promptType ?? 'feature',
    index: over.index ?? 1,
    description: over.description ?? LIST_DESC,
  };
}

function claudeOk(): ClaudeRunResult {
  return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, tokensEstimated: 10, timedOut: false, signal: null, success: true };
}

function passSentinel(): SentinelResult {
  return { passed: true, checks: [], failedCheck: null, diagnosticReport: 'PASS' };
}

function failSentinel(): SentinelResult {
  return { passed: false, checks: [], failedCheck: 'typescript', diagnosticReport: 'FAIL: typescript' };
}

/** A recording deps bundle: scripted Sentinel sequence (clamped), always-ok claude, captured writes. */
function deps(sentinelSeq: SentinelResult[]): {
  deps: DecompositionDeps;
  claudeCalls: { count: number };
  sentinelCalls: { count: number };
  commits: string[];
  records: DecompositionRecord[];
} {
  const claudeCalls = { count: 0 };
  const sentinelCalls = { count: 0 };
  const commits: string[] = [];
  const records: DecompositionRecord[] = [];
  let s = 0;
  return {
    claudeCalls,
    sentinelCalls,
    commits,
    records,
    deps: {
      runClaude: async () => {
        claudeCalls.count += 1;
        return claudeOk();
      },
      runSentinel: async () => {
        sentinelCalls.count += 1;
        const next = sentinelSeq[Math.min(s, sentinelSeq.length - 1)] ?? passSentinel();
        s += 1;
        return next;
      },
      commit: (message: string) => commits.push(message),
      recordDecomposition: (record: DecompositionRecord) => {
        records.push(record);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// shouldDecompose
// ---------------------------------------------------------------------------

test('shouldDecompose triggers strictly above the threshold', () => {
  assert.equal(shouldDecompose('x'.repeat(DECOMPOSITION_THRESHOLD)), false); // exactly 1500 → no
  assert.equal(shouldDecompose('x'.repeat(DECOMPOSITION_THRESHOLD + 1)), true); // 1501 → yes
  assert.equal(shouldDecompose('short'), false);
  assert.equal(shouldDecompose('x'.repeat(50), 40), true); // custom threshold
});

// ---------------------------------------------------------------------------
// decompose (pure split)
// ---------------------------------------------------------------------------

test('decompose splits an explicit list into atomic, kind-tagged sub-prompts', () => {
  const subs = decompose(parent(), ASSEMBLED);
  assert.equal(subs.length, 3);
  assert.deepEqual(subs.map((s) => s.kind), ['table', 'component', 'route']);
  // Each sub-prompt carries the full shared context + its own focus footer.
  subs.forEach((s, i) => {
    assert.ok(s.promptText.includes(ASSEMBLED), 'shared context preserved');
    assert.ok(s.promptText.includes(`SUB-STEP ${i + 1} OF 3`), 'focus footer present');
    assert.equal(s.index, i + 1);
    assert.ok(s.hash.length === 64, 'sha-256 hash');
  });
  // The other sub-tasks must NOT leak into a sub-prompt's action (only its own task text).
  assert.ok(!(subs[0]?.promptText ?? '').includes('UserCard'));
});

test('decompose falls back to paragraphs, then sentence packing', () => {
  const paras = decompose(parent({ description: 'First paragraph about the schema.\n\nSecond paragraph about the API route.' }), ASSEMBLED);
  assert.equal(paras.length, 2);

  const longProse =
    'Create a dashboard page that shows revenue. ' +
    'It must query the orders table for the current company. ' +
    'Add a filter component for the date range. ' +
    'Wire a settings button that opens a modal. '.repeat(24);
  const packed = decompose(parent({ description: longProse }), ASSEMBLED);
  assert.ok(packed.length >= 2, 'long unstructured prose packs into multiple chunks');
});

test('decompose returns a single, context-only unit when it cannot split', () => {
  const subs = decompose(parent({ description: 'Create one users table.' }), ASSEMBLED);
  assert.equal(subs.length, 1);
  assert.equal(subs[0]?.promptText, ASSEMBLED, 'no focus footer — runs as the plain assembled prompt');
});

// ---------------------------------------------------------------------------
// runDecomposedPrompt (sequential execution)
// ---------------------------------------------------------------------------

test('runDecomposedPrompt runs every sub-prompt sequentially when all pass', async () => {
  const d = deps([passSentinel(), passSentinel(), passSentinel()]);
  const result = await runDecomposedPrompt(parent(), ASSEMBLED, d.deps);

  assert.equal(result.decomposed, true);
  assert.equal(result.subPrompts.length, 3);
  assert.ok(result.subPrompts.every((s) => s.status === 'completed'));
  assert.equal(result.aggregateRun.success, true);
  assert.equal(result.finalSentinel?.passed, true);
  assert.equal(d.claudeCalls.count, 3, 'one claude run per sub-prompt');
  assert.equal(d.sentinelCalls.count, 3, 'Sentinel between each sub-prompt');
  assert.equal(d.commits.length, 3, 'each sub-step committed');
  assert.equal(d.records.length, 1, 'one decomposition record written');
  assert.equal(d.records[0]?.subPromptCount, 3);
  assert.equal(d.records[0]?.succeeded, 3);
  assert.equal(d.records[0]?.totalRetries, 0);
});

test('a failing sub-prompt retries IN ISOLATION, not the whole prompt', async () => {
  // sub1 pass; sub2 fails then passes on retry; sub3 pass.
  const d = deps([passSentinel(), failSentinel(), passSentinel(), passSentinel()]);
  const result = await runDecomposedPrompt(parent(), ASSEMBLED, d.deps);

  assert.equal(result.aggregateRun.success, true);
  assert.ok(result.subPrompts.every((s) => s.status === 'completed'));
  assert.equal(result.subPrompts[1]?.attempts, 2, 'only sub-step 2 retried');
  assert.equal(result.subPrompts[0]?.attempts, 1);
  assert.equal(result.subPrompts[2]?.attempts, 1);
  assert.equal(d.claudeCalls.count, 4, 'sub2 ran twice; the other two once each');
  assert.equal(d.records[0]?.totalRetries, 1);
});

test('exhausted retries stop the sequence and report the failure', async () => {
  // sub1 pass; sub2 fails on all three attempts (1 + 2 retries) → halt; sub3 never runs.
  const d = deps([passSentinel(), failSentinel(), failSentinel(), failSentinel()]);
  const result = await runDecomposedPrompt(parent(), ASSEMBLED, d.deps);

  assert.equal(result.decomposed, true);
  assert.equal(result.aggregateRun.success, false);
  assert.equal(result.finalSentinel?.passed, false);
  assert.equal(result.subPrompts.length, 2, 'sub-step 3 was never reached');
  assert.equal(result.subPrompts[1]?.status, 'failed');
  assert.equal(result.subPrompts[1]?.attempts, 3);
  assert.equal(d.claudeCalls.count, 4, '1 (sub1) + 3 (sub2 attempts)');
  assert.equal(d.records[0]?.succeeded, 1);
  assert.equal(d.records[0]?.failed, 1);
});

test('an unsplittable description runs once and writes no decomposition record', async () => {
  const d = deps([passSentinel()]);
  const result = await runDecomposedPrompt(parent({ description: 'Create one users table.' }), ASSEMBLED, d.deps);

  assert.equal(result.decomposed, false);
  assert.equal(result.subPrompts.length, 1);
  assert.equal(result.finalSentinel, null, 'the executor runs the gate Sentinel itself for a single prompt');
  assert.equal(result.record, null);
  assert.equal(d.claudeCalls.count, 1);
  assert.equal(d.sentinelCalls.count, 0, 'no inter-step Sentinel when there is only one step');
  assert.equal(d.records.length, 0);
});
