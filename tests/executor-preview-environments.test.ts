/**
 * FORGE 2.0 — Phase 3 Build Executor: `previewEnvironments` opt-in wiring test
 * (`manifest.yaml`'s `previewEnvironments` field → `Phase3Options.previewEnvironments` →
 * `ctx.runEphemeralPreviewImpl`, called from `mergeAndTag` after a prompt's Sentinel-passed
 * branch merges — `src/phases/phase3-executor.ts`).
 *
 * Kept in its OWN file rather than appended to `tests/executor.test.ts`: running that file
 * unfiltered hits a known pre-existing hang (a Sentinel-FAIL scenario reaches
 * `src/resurrection/human-gate.ts`'s readline confirmation prompt, which blocks forever with no
 * stdin attached under `node --test`). Every scenario here stays on the Sentinel-PASS path (the
 * only path `previewEnvironments` is wired into), so this file runs standalone with no such risk
 * — confirmed by running it directly rather than via `tests/executor.test.ts`.
 *
 * NO REAL NETWORK CALL: scenario (c) below sets `VERCEL_TOKEN` to a fake value, but always pairs
 * it with an injected `runEphemeralPreviewImpl` whose own preview step is given a mock deployer
 * (`EphemeralPreviewDeployer`) — the same mock used in `tests/ephemeral-preview.test.ts` — so
 * `VercelDeployer`'s real fetch-based methods are never reached.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/executor-preview-environments.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPhase3Executor, type Phase3Options } from '../src/phases/phase3-executor.js';
import { runEphemeralPreviewStep, type EphemeralPreviewDeployer } from '../src/deploy/ephemeral-preview.js';
import type { QueueEntry } from '../src/engine/queue-generator.js';
import { GitManager, type ExecSyncFn } from '../src/engine/git-manager.js';
import type { FailurePrediction } from '../src/engine/failure-predictor.js';
import type { ClaudeRunResult } from '../src/engine/claude-runner.js';
import type { SentinelResult } from '../src/phases/phase4-sentinel.js';

// ---------------------------------------------------------------------------
// Fixtures (deliberately duplicated from tests/executor.test.ts rather than imported — that file
// exports nothing, and importing it would pull its own `test(...)` registrations into this run).
// ---------------------------------------------------------------------------

function entry(over: Partial<QueueEntry> & { id: string }): QueueEntry {
  return {
    id: over.id,
    name: over.name ?? over.id,
    prompt_type: over.prompt_type ?? 'feature',
    dependencies: over.dependencies ?? [],
    governance_refs: over.governance_refs ?? [],
    estimated_tokens: over.estimated_tokens ?? 3000,
    context_injection: over.context_injection ?? { schemaSections: [], behavioralSections: [], interactionMaps: [] },
    description: over.description ?? `Build ${over.id}.`,
    ...(over.parallel_group !== undefined ? { parallel_group: over.parallel_group } : {}),
  };
}

function prediction(): FailurePrediction {
  return { probability: 0, matchingPatterns: [], recommendation: '', shouldRewrite: false, matchingOccurrences: 0, totalBuildsWithStack: 0 };
}

function claudeOk(): ClaudeRunResult {
  return { stdout: 'done', stderr: '', exitCode: 0, durationMs: 1, tokensEstimated: 100, timedOut: false, signal: null, success: true };
}

function passSentinel(): SentinelResult {
  return { passed: true, checks: [], failedCheck: null, diagnosticReport: 'PASS' };
}

function fakeGit(cwd: string): { git: GitManager } {
  let currentBranch = 'main';
  const execImpl: ExecSyncFn = (command: string) => {
    const checkoutB = /checkout -b (\S+)/.exec(command);
    if (checkoutB && checkoutB[1]) {
      currentBranch = checkoutB[1];
      return '';
    }
    if (command.includes('rev-parse')) return `${currentBranch}\n`;
    const checkout = /checkout (\S+)/.exec(command);
    if (checkout && checkout[1]) {
      currentBranch = checkout[1];
      return '';
    }
    return '';
  };
  return { git: new GitManager({ cwd, execImpl }) };
}

function memFakes() {
  let pid = 0;
  return {
    createBuild: async () => ({ id: 'build-1' }),
    updateBuild: async () => ({}),
    createPromptExecution: async () => ({ id: `pe-${++pid}` }),
    updatePromptExecution: async () => ({}),
  };
}

function baseOptions(cwd: string, entries: QueueEntry[], over: Partial<Phase3Options> = {}): Phase3Options {
  const mem = memFakes();
  const { git } = fakeGit(cwd);
  return {
    projectPath: cwd,
    entries,
    gitManager: git,
    allowHeadless: true,
    predictImpl: async () => prediction(),
    assembleImpl: async ({ entry: e }) => ({
      prompt: `PROMPT ${e.id}`,
      hash: `hash-${e.id}`,
      governanceDocsUsed: [],
      governanceDocsMissing: [],
      warningsInjected: 0,
      model: 'claude-sonnet-4-6' as const,
      modelSelection: {
        model: 'claude-sonnet-4-6' as const,
        tier: 'standard' as const,
        promptType: e.prompt_type,
        isRecovery: false,
        reason: 'test stub',
        pricing: { inputPerMTok: 3, outputPerMTok: 15 },
      },
      estimatedCostUsd: 0,
    }),
    rewriteImpl: async ({ prompt }) => ({
      rewrittenPrompt: `REWRITTEN ${prompt}`,
      reason: 'high-risk rewrite',
      originalHash: 'orig-hash',
      rewrittenHash: 'rewritten-hash',
    }),
    runClaudeImpl: async () => claudeOk(),
    runSentinelImpl: async () => passSentinel(),
    // Non-empty stub content for the pre_build hook's built-in governance_check (Finding I-1 —
    // now actually fires, reading ctx.governanceDocs instead of the real filesystem): a real
    // build always has these files, so an empty map here would make every test hit a governance
    // denial unrelated to what each test actually exercises.
    loadGovernanceDocs: async () => ({
      'BLUEPRINT.md': '# Blueprint\n',
      'SCHEMA_REGISTRY.md': '# Schema Registry\n',
      'BEHAVIORAL_CONTRACTS.md': '# Behavioral Contracts\n',
      'CLAUDE.md': '# Claude\n',
    }),
    updateStateProgress: async () => {},
    writeHaltReport: async () => {},
    createBuild: mem.createBuild,
    updateBuild: mem.updateBuild,
    createPromptExecution: mem.createPromptExecution,
    updatePromptExecution: mem.updatePromptExecution,
    log: () => {},
    ...over,
  };
}

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'forge-preview-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A mock deployer that never touches the network (mirrors tests/ephemeral-preview.test.ts). */
function mockDeployer(): EphemeralPreviewDeployer & { deployCalls: number; deleteCalls: number } {
  const state = { deployCalls: 0, deleteCalls: 0 };
  return {
    get deployCalls() {
      return state.deployCalls;
    },
    get deleteCalls() {
      return state.deleteCalls;
    },
    async deploy() {
      state.deployCalls += 1;
      return {
        deploymentId: 'dpl_abc',
        deploymentUrl: 'https://demo-preview.vercel.app',
        status: 'ready' as const,
        readyAt: '2026-08-22T00:00:00.000Z',
        error: null,
      };
    },
    async deleteDeployment() {
      state.deleteCalls += 1;
      return true;
    },
  };
}

// ===========================================================================
// (a) previewEnvironments false/absent — complete no-op
// ===========================================================================

test('previewEnvironments absent (default false): complete no-op — the ephemeral-preview collaborator is never called', async () => {
  await withTmp(async (dir) => {
    const entries = [entry({ id: 'a', prompt_type: 'schema' })];
    let previewCalls = 0;
    const result = await runPhase3Executor(
      baseOptions(dir, entries, {
        runEphemeralPreviewImpl: async () => {
          previewCalls += 1;
          throw new Error('must never be called when previewEnvironments is false');
        },
      })
    );

    assert.equal(result.status, 'completed');
    assert.equal(result.completedPrompts, 1);
    assert.equal(previewCalls, 0, 'runEphemeralPreviewImpl must never be invoked when previewEnvironments is absent/false');
  });
});

test('previewEnvironments: false (explicit): same complete no-op as absent', async () => {
  await withTmp(async (dir) => {
    const entries = [entry({ id: 'a', prompt_type: 'schema' })];
    let previewCalls = 0;
    const result = await runPhase3Executor(
      baseOptions(dir, entries, {
        previewEnvironments: false,
        runEphemeralPreviewImpl: async () => {
          previewCalls += 1;
          throw new Error('must never be called');
        },
      })
    );
    assert.equal(result.status, 'completed');
    assert.equal(previewCalls, 0);
  });
});

// ===========================================================================
// (b) previewEnvironments: true + no VERCEL_TOKEN — clean SKIP (not an error)
// ===========================================================================

test('previewEnvironments: true, VERCEL_TOKEN absent — clean SKIP via the real ephemeral-preview step, never fails the prompt', async () => {
  const originalToken = process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TOKEN;
  try {
    await withTmp(async (dir) => {
      const entries = [entry({ id: 'a', prompt_type: 'schema' })];
      const logs: string[] = [];
      const result = await runPhase3Executor(
        baseOptions(dir, entries, {
          previewEnvironments: true,
          // No override: exercises the REAL default `runEphemeralPreviewStep`, which itself
          // checks `process.env.VERCEL_TOKEN` before ever constructing a real VercelDeployer —
          // so this reaches zero network code, exactly like the absent-token unit test in
          // tests/ephemeral-preview.test.ts.
          log: (m) => logs.push(m),
        })
      );

      assert.equal(result.status, 'completed');
      assert.equal(result.completedPrompts, 1);
      assert.equal(result.outcomes[0]?.disposition, 'completed');
      assert.ok(
        logs.some((l) => l.includes('ephemeral preview skipped') && l.includes('VERCEL_TOKEN')),
        `expected a clean-skip log line; got: ${JSON.stringify(logs.slice(-10))}`
      );
    });
  } finally {
    if (originalToken === undefined) delete process.env.VERCEL_TOKEN;
    else process.env.VERCEL_TOKEN = originalToken;
  }
});

// ===========================================================================
// (c) previewEnvironments: true + VERCEL_TOKEN present — attempts the real flow (mocked deployer)
// ===========================================================================

test('previewEnvironments: true, VERCEL_TOKEN present — createPreview attempts the real flow via an injected mock deployer (no real network call)', async () => {
  const originalToken = process.env.VERCEL_TOKEN;
  process.env.VERCEL_TOKEN = 'fake-test-token-not-real';
  try {
    await withTmp(async (dir) => {
      const entries = [entry({ id: 'a', prompt_type: 'schema' })];
      const deployer = mockDeployer();
      const calls: Array<{ projectPath: string; buildRunId: string; promptId: string | null }> = [];

      const result = await runPhase3Executor(
        baseOptions(dir, entries, {
          previewEnvironments: true,
          runEphemeralPreviewImpl: async (input) => {
            calls.push(input);
            // Delegate to the REAL step, but with a mock deployer standing in for VercelDeployer
            // — proves phase3-executor.ts's wiring reaches `runEphemeralPreviewStep` end to end
            // (create -> test -> teardown) without ever hitting Vercel's actual REST API.
            return runEphemeralPreviewStep({ ...input, deployer, runTestsImpl: async () => [] });
          },
        })
      );

      assert.equal(result.status, 'completed');
      assert.equal(result.completedPrompts, 1);
      assert.equal(calls.length, 1, 'the ephemeral-preview collaborator runs exactly once for the one merged prompt');
      assert.equal(calls[0]?.projectPath, dir);
      assert.equal(calls[0]?.buildRunId, 'build-1');
      assert.equal(deployer.deployCalls, 1, 'createPreview must attempt the real deploy flow via the injected deployer');
      assert.equal(deployer.deleteCalls, 1, 'teardownPreview must run after the (empty) POST_PROMPT test pass');
    });
  } finally {
    if (originalToken === undefined) delete process.env.VERCEL_TOKEN;
    else process.env.VERCEL_TOKEN = originalToken;
  }
});
