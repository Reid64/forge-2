/**
 * FORGE 2.0 — Ephemeral Preview Environments unit test (`src/deploy/ephemeral-preview.ts`).
 *
 * Pure `node:test` — NO real network call, ever. `VERCEL_TOKEN` is deliberately never set to a
 * real-looking value without an injected `deployer` mock replacing every method that would
 * otherwise call Vercel's REST API (`VercelDeployer.deploy`/`deleteDeployment`, both fetch-based —
 * see `src/autonomy/vercel-deployer.ts`). Every test restores `process.env.VERCEL_TOKEN` to its
 * original value afterward so this file never leaks env state to any other test.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/ephemeral-preview.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPreview,
  teardownPreview,
  runPostPromptTestsAgainstPreview,
  runEphemeralPreviewStep,
  type EphemeralPreviewDeployer,
} from '../src/deploy/ephemeral-preview.js';
import type { DeploymentResult } from '../src/autonomy/vercel-deployer.js';
import { RunnerType, TriggerType, type TestOrchestratorOptions, type TestRunResult } from '../src/testing/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Run `fn` with `process.env.VERCEL_TOKEN` set/unset, always restoring the original value after. */
async function withVercelToken<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const original = process.env.VERCEL_TOKEN;
  if (value === undefined) delete process.env.VERCEL_TOKEN;
  else process.env.VERCEL_TOKEN = value;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.VERCEL_TOKEN;
    else process.env.VERCEL_TOKEN = original;
  }
}

/** A mock deployer that NEVER touches the network — records calls and returns canned results. */
function mockDeployer(over: {
  deploy?: DeploymentResult;
  deleteOk?: boolean;
} = {}): EphemeralPreviewDeployer & { deployCalls: Array<[string, string, string | undefined]>; deleteCalls: Array<[string, string]> } {
  const deployCalls: Array<[string, string, string | undefined]> = [];
  const deleteCalls: Array<[string, string]> = [];
  return {
    deployCalls,
    deleteCalls,
    async deploy(projectPath, buildRunId, environment) {
      deployCalls.push([projectPath, buildRunId, environment]);
      return (
        over.deploy ?? {
          deploymentId: 'dpl_123',
          deploymentUrl: 'https://demo-preview.vercel.app',
          status: 'ready',
          readyAt: '2026-08-22T00:00:00.000Z',
          error: null,
        }
      );
    },
    async deleteDeployment(projectPath, deploymentId) {
      deleteCalls.push([projectPath, deploymentId]);
      return over.deleteOk ?? true;
    },
  };
}

function fakeTestResult(over: Partial<TestRunResult> = {}): TestRunResult {
  return {
    id: over.id ?? 'tr-1',
    buildRunId: over.buildRunId ?? null,
    promptId: over.promptId ?? null,
    runnerType: over.runnerType ?? RunnerType.API,
    testSuite: over.testSuite ?? 'api',
    passed: over.passed ?? 3,
    failed: over.failed ?? 0,
    skipped: over.skipped ?? 0,
    durationMs: over.durationMs ?? 10,
    coveragePercent: over.coveragePercent ?? null,
    errors: over.errors ?? [],
    createdAt: over.createdAt ?? '2026-08-22T00:00:00.000Z',
    status: over.status ?? 'passed',
    runner: over.runner ?? 'vitest',
    reportPath: over.reportPath ?? null,
    exitCode: over.exitCode ?? 0,
  };
}

// ===========================================================================
// createPreview
// ===========================================================================

test('createPreview: VERCEL_TOKEN absent — clean SKIP, deployer never invoked', async () => {
  await withVercelToken(undefined, async () => {
    const deployer = mockDeployer();
    const result = await createPreview({ projectPath: '/tmp/proj', buildRunId: 'build-1', deployer });
    assert.equal(result.status, 'skipped');
    assert.equal(result.url, null);
    assert.equal(result.deploymentId, null);
    assert.ok(result.reason?.includes('VERCEL_TOKEN'));
    assert.equal(deployer.deployCalls.length, 0, 'deployer.deploy must never be called without a token');
  });
});

test('createPreview: VERCEL_TOKEN present — attempts the real flow via the injected deployer (never a real network call)', async () => {
  await withVercelToken('fake-test-token-not-real', async () => {
    const deployer = mockDeployer();
    const result = await createPreview({ projectPath: '/tmp/proj', buildRunId: 'build-1', deployer });
    assert.equal(result.status, 'ready');
    assert.equal(result.url, 'https://demo-preview.vercel.app');
    assert.equal(result.deploymentId, 'dpl_123');
    assert.equal(result.reason, null);
    assert.deepEqual(deployer.deployCalls, [['/tmp/proj', 'build-1', 'preview']]);
  });
});

test('createPreview: VERCEL_TOKEN present but deployment never reaches ready — failed, never thrown', async () => {
  await withVercelToken('fake-test-token-not-real', async () => {
    const deployer = mockDeployer({
      deploy: { deploymentId: 'dpl_999', deploymentUrl: null, status: 'error', readyAt: null, error: 'build failed on Vercel' },
    });
    const result = await createPreview({ projectPath: '/tmp/proj', buildRunId: 'build-1', deployer });
    assert.equal(result.status, 'failed');
    assert.equal(result.url, null);
    assert.equal(result.deploymentId, 'dpl_999');
    assert.equal(result.reason, 'build failed on Vercel');
  });
});

// ===========================================================================
// teardownPreview
// ===========================================================================

test('teardownPreview: VERCEL_TOKEN absent — clean SKIP, deployer never invoked', async () => {
  await withVercelToken(undefined, async () => {
    const deployer = mockDeployer();
    const result = await teardownPreview({ projectPath: '/tmp/proj', deploymentId: 'dpl_123', deployer });
    assert.equal(result.status, 'skipped');
    assert.equal(deployer.deleteCalls.length, 0);
  });
});

test('teardownPreview: no deploymentId — SKIP even with a token present (nothing was ever created)', async () => {
  await withVercelToken('fake-test-token-not-real', async () => {
    const deployer = mockDeployer();
    const result = await teardownPreview({ projectPath: '/tmp/proj', deploymentId: null, deployer });
    assert.equal(result.status, 'skipped');
    assert.equal(deployer.deleteCalls.length, 0);
  });
});

test('teardownPreview: VERCEL_TOKEN + deploymentId present — deletes via the injected deployer', async () => {
  await withVercelToken('fake-test-token-not-real', async () => {
    const deployer = mockDeployer({ deleteOk: true });
    const result = await teardownPreview({ projectPath: '/tmp/proj', deploymentId: 'dpl_123', deployer });
    assert.equal(result.status, 'deleted');
    assert.deepEqual(deployer.deleteCalls, [['/tmp/proj', 'dpl_123']]);
  });
});

test('teardownPreview: deployer reports failure — failed, never thrown', async () => {
  await withVercelToken('fake-test-token-not-real', async () => {
    const deployer = mockDeployer({ deleteOk: false });
    const result = await teardownPreview({ projectPath: '/tmp/proj', deploymentId: 'dpl_123', deployer });
    assert.equal(result.status, 'failed');
  });
});

// ===========================================================================
// runPostPromptTestsAgainstPreview
// ===========================================================================

test('runPostPromptTestsAgainstPreview: forwards POST_PROMPT trigger + API/E2E runners + baseUrl to runTests', async () => {
  let captured: TestOrchestratorOptions | null = null;
  const runTestsImpl = async (opts: TestOrchestratorOptions): Promise<TestRunResult[]> => {
    captured = opts;
    return [fakeTestResult({ testSuite: 'api' }), fakeTestResult({ testSuite: 'e2e', runnerType: RunnerType.E2E })];
  };

  const results = await runPostPromptTestsAgainstPreview({
    projectPath: '/tmp/proj',
    buildRunId: 'build-1',
    promptId: 'prompt-1',
    previewUrl: 'https://demo-preview.vercel.app',
    runTestsImpl,
  });

  assert.equal(results.length, 2);
  assert.ok(captured);
  assert.deepEqual(captured!.triggers, [TriggerType.POST_PROMPT]);
  assert.deepEqual(captured!.runners, [RunnerType.API, RunnerType.E2E]);
  assert.equal(captured!.baseUrl, 'https://demo-preview.vercel.app');
  assert.equal(captured!.projectPath, '/tmp/proj');
  assert.equal(captured!.buildRunId, 'build-1');
  assert.equal(captured!.promptId, 'prompt-1');
});

// ===========================================================================
// runEphemeralPreviewStep (the full opt-in step phase3-executor.ts calls)
// ===========================================================================

test('runEphemeralPreviewStep: VERCEL_TOKEN absent — attempted false, no tests run, no teardown attempted', async () => {
  await withVercelToken(undefined, async () => {
    const deployer = mockDeployer();
    let testsCalled = false;
    const runTestsImpl = async (): Promise<TestRunResult[]> => {
      testsCalled = true;
      return [];
    };

    const result = await runEphemeralPreviewStep({
      projectPath: '/tmp/proj',
      buildRunId: 'build-1',
      promptId: 'prompt-1',
      deployer,
      runTestsImpl,
    });

    assert.equal(result.attempted, false);
    assert.equal(result.preview.status, 'skipped');
    assert.deepEqual(result.testResults, []);
    assert.equal(result.teardown, null);
    assert.equal(testsCalled, false, 'POST_PROMPT tests must never run when there is no preview URL');
    assert.equal(deployer.deployCalls.length, 0);
    assert.equal(deployer.deleteCalls.length, 0);
  });
});

test('runEphemeralPreviewStep: VERCEL_TOKEN present — creates preview, tests it, tears it down', async () => {
  await withVercelToken('fake-test-token-not-real', async () => {
    const deployer = mockDeployer();
    let capturedBaseUrl: string | undefined;
    const runTestsImpl = async (opts: TestOrchestratorOptions): Promise<TestRunResult[]> => {
      capturedBaseUrl = opts.baseUrl;
      return [fakeTestResult()];
    };

    const result = await runEphemeralPreviewStep({
      projectPath: '/tmp/proj',
      buildRunId: 'build-1',
      promptId: 'prompt-1',
      deployer,
      runTestsImpl,
    });

    assert.equal(result.attempted, true);
    assert.equal(result.preview.status, 'ready');
    assert.equal(result.testResults.length, 1);
    assert.equal(capturedBaseUrl, 'https://demo-preview.vercel.app');
    assert.equal(result.teardown?.status, 'deleted');
    assert.deepEqual(deployer.deployCalls, [['/tmp/proj', 'build-1', 'preview']]);
    assert.deepEqual(deployer.deleteCalls, [['/tmp/proj', 'dpl_123']]);
  });
});
