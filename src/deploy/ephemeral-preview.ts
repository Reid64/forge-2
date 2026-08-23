/**
 * FORGE 2.0 — Deploy: Ephemeral Preview Environments (opt-in, `manifest.yaml`'s
 * `previewEnvironments` field — `src/orchestrator/types.ts`'s `LibraryManifest`).
 *
 * When enabled, Phase 3 (`src/phases/phase3-executor.ts`) deploys each merged prompt's project
 * state to a throwaway Vercel preview deployment, runs the POST_PROMPT test suite AGAINST that
 * live preview URL (instead of never running at all — Sentinel's own `postPromptTests` hook is
 * never wired to a target URL), and tears the preview down afterward. Every step is optional and
 * non-fatal (Contract 4 house style): a failure here is logged, never thrown, and never affects
 * the prompt's `disposition` (merge/checkpoint already happened before this runs).
 *
 * VERCEL API, NOT THE CLI: this module reuses `src/autonomy/vercel-deployer.ts`'s `VercelDeployer`
 * — the ONE place in this codebase that talks to Vercel, already fetch-based (`POST
 * /v13/deployments`, `GET /v13/deployments/{id}`, and now `DELETE /v13/deployments/{id}` for
 * teardown) with zero `vercel` CLI subprocess. `VercelDeployer.deploy(..., 'preview')` already
 * defaults to a PREVIEW deployment (not production), which is exactly what an ephemeral
 * environment needs — no second Vercel client is introduced here.
 *
 * TOKEN-GATED, SKIPPED CLEANLY: every exported function checks `process.env.VERCEL_TOKEN` FIRST,
 * before constructing/calling the deployer at all — deliberately NOT delegating to
 * `VercelDeployer`'s own env-or-vault token fallback, so a machine with a vault-stored token but
 * no `VERCEL_TOKEN` env var still SKIPS here (matches this module's own opt-in contract: "when
 * `VERCEL_TOKEN` is present"). Absent token → a `'skipped'` result, logged once, never an error.
 *
 * TESTABLE WITHOUT A REAL NETWORK CALL: every function accepts an injectable `deployer` (the
 * `EphemeralPreviewDeployer` shape below — the same two `VercelDeployer` methods this module
 * calls) and `runTestsImpl` (default `runTests`, `src/testing/orchestrator.ts`) — the same
 * injectable-collaborator house style `phase3-executor.ts`/`phase4-sentinel.ts` already use, so
 * tests substitute a mock deployer/test-runner instead of ever hitting Vercel or a live suite.
 */

import { createVercelDeployer, type DeploymentResult } from '../autonomy/vercel-deployer.js';
import { runTests as runTestsDefault } from '../testing/orchestrator.js';
import { RunnerType, TriggerType, type TestRunResult } from '../testing/types.js';

/** The two `VercelDeployer` methods this module needs — narrowed so tests can inject a plain mock. */
export interface EphemeralPreviewDeployer {
  deploy(projectPath: string, buildRunId: string, environment?: 'production' | 'preview'): Promise<DeploymentResult>;
  deleteDeployment(projectPath: string, deploymentId: string): Promise<boolean>;
}

export type EphemeralPreviewStatus = 'skipped' | 'ready' | 'failed';

export interface PreviewOutcome {
  status: EphemeralPreviewStatus;
  url: string | null;
  deploymentId: string | null;
  /** Why the deployment was skipped/failed. `null` when `status === 'ready'`. */
  reason: string | null;
}

export type TeardownStatus = 'skipped' | 'deleted' | 'failed';

export interface TeardownOutcome {
  status: TeardownStatus;
  reason: string | null;
}

export interface CreatePreviewOptions {
  /** The target project's root — NEVER FORGE's own directory (Contract 6). */
  projectPath: string;
  /** The build_run id (or a stable machine-scoped fallback — mirrors `phase3-executor.ts`'s `buildIdOf`). */
  buildRunId: string;
  /** Override the deployer (tests). Default: {@link createVercelDeployer}. */
  deployer?: EphemeralPreviewDeployer;
  /** Progress logger. Default: no-op. */
  log?: (message: string) => void;
}

/**
 * Trigger a Vercel PREVIEW deployment for `options.projectPath` when `process.env.VERCEL_TOKEN`
 * is present. Returns the preview URL on success (`status: 'ready'`). Cleanly `'skipped'` — not
 * an error, not a crash — when the token is absent; `'failed'` when the token is present but the
 * deployment itself did not reach a ready state (Vercel API error, upload failure, poll timeout).
 * Never throws (Contract 4).
 */
export async function createPreview(options: CreatePreviewOptions): Promise<PreviewOutcome> {
  const log = options.log ?? (() => {});

  if (!process.env.VERCEL_TOKEN) {
    log('ephemeral-preview: VERCEL_TOKEN not set — SKIPPED (no preview deployment attempted).');
    return { status: 'skipped', url: null, deploymentId: null, reason: 'VERCEL_TOKEN not set' };
  }

  const deployer = options.deployer ?? createVercelDeployer();
  let result: DeploymentResult;
  try {
    result = await deployer.deploy(options.projectPath, options.buildRunId, 'preview');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`ephemeral-preview: createPreview threw (${message}) — treated as failed, never thrown further.`);
    return { status: 'failed', url: null, deploymentId: null, reason: message };
  }

  if (result.status !== 'ready' || !result.deploymentUrl) {
    const reason = result.error ?? `deployment did not reach a ready state (status: ${result.status})`;
    log(`ephemeral-preview: preview deployment failed — ${reason}`);
    return { status: 'failed', url: null, deploymentId: result.deploymentId, reason };
  }

  log(`ephemeral-preview: preview ready at ${result.deploymentUrl}`);
  return { status: 'ready', url: result.deploymentUrl, deploymentId: result.deploymentId, reason: null };
}

export interface TeardownPreviewOptions {
  projectPath: string;
  /** The deployment id `createPreview` returned. `null`/absent → a no-op `'skipped'` result. */
  deploymentId: string | null;
  deployer?: EphemeralPreviewDeployer;
  log?: (message: string) => void;
}

/**
 * Delete the ephemeral preview deployment `createPreview` created. Cleanly `'skipped'` when
 * `VERCEL_TOKEN` is absent or there is no `deploymentId` to tear down (nothing was ever created).
 * Never throws.
 */
export async function teardownPreview(options: TeardownPreviewOptions): Promise<TeardownOutcome> {
  const log = options.log ?? (() => {});

  if (!process.env.VERCEL_TOKEN) {
    log('ephemeral-preview: VERCEL_TOKEN not set — teardown SKIPPED.');
    return { status: 'skipped', reason: 'VERCEL_TOKEN not set' };
  }
  if (!options.deploymentId) {
    return { status: 'skipped', reason: 'no deploymentId to tear down' };
  }

  const deployer = options.deployer ?? createVercelDeployer();
  try {
    const ok = await deployer.deleteDeployment(options.projectPath, options.deploymentId);
    if (!ok) {
      log(`ephemeral-preview: teardown of ${options.deploymentId} failed.`);
      return { status: 'failed', reason: 'VercelDeployer.deleteDeployment returned false' };
    }
    log(`ephemeral-preview: preview ${options.deploymentId} torn down.`);
    return { status: 'deleted', reason: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`ephemeral-preview: teardownPreview threw (${message}) — treated as failed, never thrown further.`);
    return { status: 'failed', reason: message };
  }
}

export interface RunPostPromptTestsAgainstPreviewOptions {
  projectPath: string;
  buildRunId: string | null;
  promptId: string | null;
  previewUrl: string;
  /** Override the runner set. Default: API + E2E — the two suites that actually hit a URL. */
  runners?: RunnerType[];
  /** Override the TestOrchestrator dispatcher (tests). Default: {@link runTestsDefault}. */
  runTestsImpl?: typeof runTestsDefault;
  log?: (message: string) => void;
}

/**
 * Run the POST_PROMPT test suite (`src/testing/orchestrator.ts`'s `runTests` — the SAME dispatcher
 * `phase4-sentinel.ts`'s post-PASS `postPromptTests` hook uses) targeted AT `previewUrl` instead
 * of localhost/nothing. Defaults to the API + E2E runners (`RunnerType.API`/`RunnerType.E2E`) —
 * the only two suites that read `RunnerInput.baseUrl` — rather than Sentinel's own hook's
 * UNIT/INTEGRATION pair, since a target URL is meaningless to unit/integration tests. Never
 * throws: `runTests` itself already never throws (a runner failure becomes an `'error'`
 * `TestRunResult`, not a rejection), so this is a thin, explicitly-named pass-through kept
 * separate for its own injectable default and doc comment.
 */
export async function runPostPromptTestsAgainstPreview(
  options: RunPostPromptTestsAgainstPreviewOptions
): Promise<TestRunResult[]> {
  const runTestsImpl = options.runTestsImpl ?? runTestsDefault;
  return runTestsImpl({
    projectPath: options.projectPath,
    buildRunId: options.buildRunId,
    promptId: options.promptId,
    triggers: [TriggerType.POST_PROMPT],
    runners: options.runners ?? [RunnerType.API, RunnerType.E2E],
    baseUrl: options.previewUrl,
  });
}

export interface EphemeralPreviewStepOptions {
  projectPath: string;
  buildRunId: string;
  promptId: string | null;
  deployer?: EphemeralPreviewDeployer;
  runTestsImpl?: typeof runTestsDefault;
  log?: (message: string) => void;
}

export interface EphemeralPreviewStepResult {
  /** False only when the whole step was a no-op (VERCEL_TOKEN absent) — the manifest-gated caller uses this for its own summary line. */
  attempted: boolean;
  preview: PreviewOutcome;
  testResults: TestRunResult[];
  teardown: TeardownOutcome | null;
}

/**
 * The full opt-in step: create a preview, run POST_PROMPT (API/E2E) tests against it if it came
 * up, then always tear it down. This is what `phase3-executor.ts` calls when `previewEnvironments`
 * is `true` — a SINGLE call site keeps the per-prompt loop's `manifest.yaml`-gated branch tiny.
 * Never throws; a create/test/teardown failure at any stage is logged and reflected in the
 * returned result, never surfaced as a rejection this build's merge/checkpoint decision could see.
 */
export async function runEphemeralPreviewStep(options: EphemeralPreviewStepOptions): Promise<EphemeralPreviewStepResult> {
  const log = options.log ?? (() => {});

  const preview = await createPreview({
    projectPath: options.projectPath,
    buildRunId: options.buildRunId,
    deployer: options.deployer,
    log,
  });

  if (preview.status !== 'ready' || !preview.url) {
    // Nothing to test or tear down — 'skipped' (no token) reads as `attempted: false`, 'failed'
    // (token present, deploy didn't come up) still counts as an attempt for the caller's summary.
    return { attempted: preview.status === 'failed', preview, testResults: [], teardown: null };
  }

  let testResults: TestRunResult[] = [];
  try {
    testResults = await runPostPromptTestsAgainstPreview({
      projectPath: options.projectPath,
      buildRunId: options.buildRunId,
      promptId: options.promptId,
      previewUrl: preview.url,
      runTestsImpl: options.runTestsImpl,
      log,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`ephemeral-preview: POST_PROMPT tests against the preview threw (${message}) — not evaluated.`);
  }

  const teardown = await teardownPreview({
    projectPath: options.projectPath,
    deploymentId: preview.deploymentId,
    deployer: options.deployer,
    log,
  });

  return { attempted: true, preview, testResults, teardown };
}
