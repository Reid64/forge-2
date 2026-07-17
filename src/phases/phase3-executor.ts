/**
 * FORGE 2.0 â€” Phase 3: Build Executor (the main build loop, queue.yaml s5-p05).
 *
 * Phase 3 is where FORGE actually BUILDS. It consumes the approved `queue.yaml` (Queue
 * Generator s4-p02) and walks the prompts in dependency order, driving each one through the
 * engine pieces the prior s5 prompts authored. For EACH prompt (BEHAVIORAL_CONTRACTS Contract
 * 1 â€” Phase 4 runs after EVERY Phase 3 prompt), the loop performs the s5-p05 sequence:
 *
 *   a. Check the prompt's dependencies have completed (the schedule is topological, so they
 *      precede it â€” a missing/failed dependency SKIPS the dependent rather than mis-building).
 *   b. Run the failure-predictor (Contract 8) for `{ promptType, stackFingerprint, index }`.
 *   c. Assemble the prompt (Contract 7 â€” never hardcoded) via the prompt-assembler, injecting
 *      the relevant governance excerpts + Build Memory warnings + the PREVIOUS prompt's Sentinel
 *      status; then, if the predicted failure probability > 0.4, rewrite it (Contract 9) â€” the
 *      rewriter operates ON the assembled prompt (it prepends a restructured approach), so
 *      assembly necessarily precedes the rewrite even though the spec lists them c-then-d.
 *   d. Create the Contract-10 feature branch `forge/{build}/prompt-{i}-{name}` (git-manager).
 *   e. Execute the prompt through the claude-runner (`claude -p --dangerously-skip-permissions`,
 *      Contract 5) in the TARGET project root (Contract 6), then commit the work to the branch.
 *   f. Log a `prompt_executions` row to Build Memory (Contract 4 â€” guarded; never blocks).
 *   g. Run the Phase 4 Sentinel (the five Contract-13 health checks).
 *   h. PASS â†’ merge the branch to main + lightweight checkpoint tag (Contracts 10/11). FAIL â†’
 *      if Autonomous Recovery Mode is on, run the Contract-14 self-heal loop; if it recovers,
 *      merge + tag; otherwise HALT the build (Contract 13) â€” the feature branch is preserved
 *      and main is rolled back to the last checkpoint (Contract 12), with a halt report written.
 *   i. Update STATE_OF_THE_BUILD.md from the live progress (BLUEPRINT Canonical Rule 9).
 *
 * On completion the `build_runs` row is finalized (`completed` / `failed` / `halted`) with the
 * aggregate counts and token estimate.
 *
 * SEQUENTIAL is the default (s5-p05): the executor walks the parallel-scheduler's topological
 * `order`. The scheduler also exposes the dependency WAVES + declared parallel groups for a
 * future parallel executor â€” but parallel fan-out is "Phase 2 of FORGE 2.0 usage", not built here.
 *
 * NON-FATAL house style: every collaborator (claude-runner, git-manager, Sentinel, the predictor,
 * the assembler, the rewriter, all Build Memory CRUD) already NEVER throws â€” they report failure
 * in their result. The loop additionally wraps each prompt so one unexpected error can never abort
 * the whole build uncaught (Iron Law 3 â€” report the real outcome, never fabricate a pass). Build
 * Memory being unreachable degrades to stateless mode (Contract 4), it does not block the build.
 * Every collaborator is INJECTABLE so the executor unit-tests with no `claude`, no git, and no DB.
 * `runPhase3Executor` never rejects.
 *
 * BOUNDARY: the executor operates on the TARGET project directory (`projectPath`) â€” claude runs
 * there, git runs there, Sentinel inspects it. It never touches FORGE's own governance files
 * (Iron Law 1); the only files it writes in the target are the work claude produces, the state
 * documents (Canonical Rule 9), and, on a halt, the halt report.
 *
 * REPLAY (F12 / BLUEPRINT Build Replay): set `options.replay` to re-execute an existing build
 * from a checkpoint forward. The executor (1) creates a NEW build_run linked back to the original
 * (the linkage rides in `toolchain_manifest._forge_replay`, since SCHEMA_REGISTRY's build_runs has
 * no dedicated parent column and the registry is read-only â€” Iron Law 1); (2) hard-resets main to
 * the supplied Contract-11 checkpoint tag (git-manager rollback); (3) reloads the governance
 * package from CURRENT disk (it may have been edited since the original build â€” the whole point of
 * a replay); (4) re-walks the queue, CARRYING every prompt before the resume index (those are
 * already present in the checkpoint â€” recorded as `skipped` with a replay note and treated as
 * satisfied dependencies) and re-executing the resume index forward exactly like a fresh build.
 * The new build's branches/tags use the NEW build id, so a replay never collides with the original.
 *
 * DRY RUN (F11 / Dry Run Mode): set `options.dryRun` to SIMULATE without executing. Phase 3 in dry
 * run assembles EVERY prompt (real assembler) and runs the failure-predictor on each, but never
 * touches claude/git/Sentinel â€” zero build-execution tokens are consumed. It then runs the
 * cost-estimator for the full build and emits a {@link SimulationReport} on the result: the
 * predicted prompt plan, the prompts predicted to error (probability > the rewrite threshold), the
 * predicted dollar cost + wall-clock time (with confidence bands), and the token estimate. Phases
 * 0/1/2 (the real environment check, design generation, and governance generation) run BEFORE
 * Phase 3 regardless â€” they are the executor's inputs (the queue + governance it consumes) and are
 * the orchestrator's responsibility; they are real in a dry run because they consume no build
 * tokens. The executor accepts the Phase 1 `features` (for the cost estimate) and, lacking them,
 * derives an approximate scope from the queue so the report is always complete (with a warning).
 */

import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { load as parseYaml } from 'js-yaml';

import type { ContextInjection, PromptType, QueueEntry } from '../engine/queue-generator.js';
import { analyzeSchedule, type ScheduleAnalysis } from '../engine/parallel-scheduler.js';
import { queueShortHash } from '../tools/queue-versioning.js';
import { predictFailure, REWRITE_THRESHOLD, type FailurePrediction } from '../engine/failure-predictor.js';
import { rewritePrompt } from '../engine/prompt-rewriter.js';
import {
  shouldDecompose,
  runDecomposedPrompt,
  type DecompositionParent,
  type DecompositionDeps,
  type DecompositionResult,
  type DecompositionRecord,
} from '../engine/prompt-decomposer.js';
import {
  estimateBuildCost,
  type BuildEstimate,
  type CostEstimateInput,
  type CostEstimatorOptions,
  type FeatureSpec,
  type MetricEstimate,
} from '../analysis/cost-estimator.js';
import {
  assemblePrompt,
  type AssembledPrompt,
  type PreviousSentinelStatus,
} from '../engine/prompt-assembler.js';
import { runClaude, DEFAULT_TIMEOUT_MS, type ClaudeRunResult } from '../engine/claude-runner.js';
import { GitManager } from '../engine/git-manager.js';
import {
  runSentinel,
  runAutonomousRecovery,
  toPreviousSentinelStatus,
  type SentinelResult,
  type SentinelOptions,
  type AutoRecoveryResult,
} from './phase4-sentinel.js';
import { analyzeSentinelFailure, type BrainDiagnosis } from '../engine/build-brain.js';
import {
  deriveStackTags,
  mapPromptTypeToTaskType,
  recordFailureObserved,
  recordRecoveryOutcome,
  recordSmokeTestFailureObserved,
} from '../engine/learning-writeback.js';
import { LiveStatusWriter, readIdeStatus, syncIdeStatus } from '../tools/live-status.js';
import {
  acquireRunLock,
  checkStaleLock,
  clearDeathForensicsState,
  installDeathForensics,
  recordLogLine,
  releaseRunLock,
} from '../tools/death-forensics.js';
import { toAsciiGovernanceText, writeGovernanceFile } from '../tools/governance-text.js';
import type { StackFingerprint } from '../tools/stack-detector.js';
import type { Instinct, JsonObject } from '../types/index.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import { CodebaseRag } from '../tools/codebase-rag.js';
import { logLine, setLogContext, clearLogContext, runWithBuildContext, beginQuietLogging } from '../tools/forge-logger.js';
import { HookManager } from '../engine/hook-manager.js';
import { applyInstincts } from '../analysis/instinct-extractor.js';
import {
  selectModelForEntry,
  classifyPromptComplexity,
  routeToModel,
  estimateCost,
  ModelCostTracker,
} from '../engine/model-router.js';
import { runSmokeTests, shouldRunTests } from '../tools/incremental-tester.js';
import { scanDeadCode } from '../tools/dead-code-scanner.js';
import { onRunStart, onPromptComplete, onRunEnd } from '../learning/integration.js';
import { observeRewriteOutcome } from '../learning/build-brain-evolver.js';
import { onSentinelFailure } from '../integration/bus.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Per-prompt disposition after the executor has handled it. */
export type PromptDisposition =
  | 'completed' // executed, Sentinel passed (or auto-recovered), merged + checkpointed
  | 'failed' // executed but Sentinel failed and could not be recovered (build then halts)
  | 'skipped' // a dependency did not complete, or dry-run
  | 'halted'; // not reached â€” an earlier prompt halted the build

/** The outcome of a single prompt's pass through the loop. */
export interface PromptOutcome {
  /** 1-based position in the executed order. */
  index: number;
  /** The queue entry's id. */
  id: string;
  /** The queue entry's name. */
  name: string;
  /** The prompt type. */
  promptType: PromptType;
  /** Final disposition. */
  disposition: PromptDisposition;
  /** The Contract-10 feature branch created for this prompt (null when not branched). */
  branchName: string | null;
  /** Predicted failure probability (Contract 8), or null when prediction was skipped. */
  failureProbability: number | null;
  /** Whether the prompt was rewritten (Contract 9). */
  wasRewritten: boolean;
  /**
   * True when the claude-runner subprocess itself timed out or exited abnormally on this
   * prompt (session/cap exhaustion) â€” as opposed to Sentinel finding a genuine defect in
   * code that finished running. `--auto-resume` (`src/engine/auto-resume.ts`) uses this to
   * distinguish a resumable timeout from a real Sentinel HALT it must never steamroll.
   */
  timedOut: boolean;
  /** True when this prompt was split into atomic sub-prompts (Contract-decomposition, see prompt-decomposer.ts). */
  decomposed: boolean;
  /** SHA-256 of the prompt actually executed (rewritten hash when rewritten). */
  promptHash: string;
  /** The `prompt_executions.id` Build Memory assigned, or null in stateless mode. */
  promptExecutionId: string | null;
  /** Coarse token estimate for this prompt (claude-runner heuristic). */
  tokensEstimated: number;
  /** Wall-clock duration of this prompt, in ms (Session 5 finding #12/#7). */
  durationMs: number;
  /** The Sentinel result (null when not run â€” skipped/dry-run). */
  sentinel: SentinelResult | null;
  /** The Autonomous Recovery result, when recovery was attempted. */
  recovery: AutoRecoveryResult | null;
  /** Short human-readable note on what happened. */
  note: string;
}

/** Final status of the whole Phase 3 run. */
export type Phase3Status = 'completed' | 'failed' | 'halted' | 'dry_run';

/**
 * Build Replay (F12). Re-execute an existing build from a checkpoint forward, against (possibly)
 * reloaded governance. Supplied via {@link Phase3Options.replay}.
 */
export interface ReplayOptions {
  /** The `build_runs.id` of the build being replayed â€” the new build links back to it. */
  originalBuildRunId: string;
  /**
   * The Contract-11 lightweight checkpoint tag to hard-reset main to before re-executing
   * (e.g. `forge-checkpoint-<original-build-id>-3`). Use the ORIGINAL build's tag.
   */
  fromCheckpointTag: string;
  /**
   * 1-based position in the executed order to RESUME from. Every prompt before this index is
   * assumed already present in the checkpoint â€” it is carried (not re-executed) and counts as a
   * satisfied dependency. The resume index and everything after it execute as in a fresh build.
   */
  fromPromptIndex: number;
}

/** The replay linkage echoed on {@link Phase3Result.replayOf} when a run was a Build Replay. */
export interface ReplayLinkage {
  originalBuildRunId: string;
  fromCheckpointTag: string;
  fromPromptIndex: number;
}

/** One prompt's entry in the dry-run {@link SimulationReport} plan (no execution occurred). */
export interface SimulationPromptPlan {
  /** 1-based position in the executed order. */
  index: number;
  id: string;
  name: string;
  promptType: PromptType;
  /** SHA-256 of the assembled prompt (the real assembler ran; nothing was executed). */
  promptHash: string;
  /** Predicted failure probability (Contract 8), or null when prediction degraded. */
  failureProbability: number | null;
  /** Coarse token estimate for this prompt (assembled length, else the queue figure). */
  tokensEstimated: number;
  /** Whether the predictor would trigger a Contract-9 rewrite (probability > the threshold). */
  willRewrite: boolean;
}

/**
 * The Dry Run Mode simulation report (F11), populated only when `options.dryRun` is set. Combines
 * the precise per-prompt dry-run pass (the assembled prompt plan + per-prompt failure probability,
 * grounded in THIS queue) with the cost-estimator's Build-Memory-grounded dollar/time/failure bands.
 */
export interface SimulationReport {
  projectName: string;
  /** Total prompts the queue scheduled. */
  totalPrompts: number;
  /** Prompt count per type, from the scheduled queue. */
  promptsByType: Record<PromptType, number>;
  /** The full predicted prompt plan, in executed order. */
  prompts: SimulationPromptPlan[];
  /** The prompts predicted to error / be rewritten (probability > the rewrite threshold). */
  predictedErrors: Array<{ index: number; id: string; promptType: PromptType; probability: number }>;
  /** Expected number of failing prompts = Î£ per-prompt probability (the per-queue estimate). */
  expectedFailureCount: number;
  /** Token estimate summed from the assembled prompts (precise to this queue). */
  assembledTokenEstimate: number;
  /** The cost-estimator's full-build estimate (cost/time/tokens/failures with bands), or null. */
  costEstimate: BuildEstimate | null;
  /** Predicted dollar cost with a band (from the cost estimate), or null when it degraded. */
  predictedCostUsd: MetricEstimate | null;
  /** Predicted wall-clock time with a band + human string (from the cost estimate), or null. */
  predictedTimeMs: (MetricEstimate & { human: string }) | null;
  /** Non-fatal observations specific to the simulation (approximate scope, estimator degrade, â€¦). */
  warnings: string[];
  generatedAt: string;
}

/** The complete result of {@link runPhase3Executor}. */
export interface Phase3Result {
  projectName: string;
  /** The `build_runs.id` Build Memory assigned, or null in stateless mode. */
  buildRunId: string | null;
  /** Final status. */
  status: Phase3Status;
  /** The dependency analysis the executor walked (order / waves / parallel groups). */
  schedule: ScheduleAnalysis;
  /** Per-prompt outcomes, in executed order. */
  outcomes: PromptOutcome[];
  /** Count of prompts that completed (Sentinel passed / recovered). */
  completedPrompts: number;
  /** Count of prompts that failed (Sentinel failed, no recovery). */
  failedPrompts: number;
  /** Count of prompts skipped (unmet dependency / dry-run). */
  skippedPrompts: number;
  /** Sum of the coarse per-prompt token estimates. */
  totalTokens: number;
  /** The id/name of the prompt that halted the build, when halted. */
  haltedAt: { index: number; id: string } | null;
  /** The reason the build halted, when halted. */
  haltReason: string | null;
  /** When this run was a Build Replay (F12), the linkage back to the original build; else null. */
  replayOf: ReplayLinkage | null;
  /** The Dry Run Mode simulation report (F11), present only when `dryRun` was set; else null. */
  simulation: SimulationReport | null;
  /** Non-fatal observations (queue parse warnings, stateless degrade, â€¦). */
  warnings: string[];
  generatedAt: string;
}

/** A re-execution of the failed prompt for Autonomous Recovery (wraps claude + commit). */
export interface RerunPromptFn {
  (): Promise<{ success: boolean; output: string }>;
}

/** Options for {@link runPhase3Executor}. */
export interface Phase3Options {
  /** Target project root â€” claude runs here, git runs here, Sentinel inspects here (Contract 6). */
  projectPath: string;
  /**
   * The build queue. Supply `entries` directly (tests / a pre-parsed queue), else the executor
   * reads + parses `queue.yaml` from `queuePath` (default `<projectPath>/queue.yaml`).
   */
  entries?: QueueEntry[];
  /** Path to queue.yaml when `entries` is not supplied. Default `<projectPath>/queue.yaml`. */
  queuePath?: string;
  /** Governance directory name under the target project. Default `'governance'`. */
  governanceDirName?: string;
  /** Project name for the build_run + logging. Default: the basename of `projectPath`. */
  projectName?: string;
  /** Executing machine id (Contract 4/20). Default `FORGE_MACHINE_ID`, else a generated UUID. */
  machineId?: string;
  /** The build's stack fingerprint (Phase 0). Scopes prediction + warnings; stored on build_run. */
  stackFingerprint?: StackFingerprint | null;
  /** The locked toolchain manifest (Phase 0), stored on the build_run. */
  toolchainManifest?: JsonObject;
  /** Hash of the governance package at build start, stored on the build_run. */
  governanceHash?: string | null;
  /** Enable Contract-14 Autonomous Recovery (opt-in per build). Default false. */
  autonomousRecoveryMode?: boolean;
  /** Simulate only â€” assemble + predict, but do NOT run claude/git/Sentinel. Default false. */
  dryRun?: boolean;
  /**
   * Build Replay (F12): when set, this run resumes the {@link ReplayOptions.originalBuildRunId}
   * build from {@link ReplayOptions.fromCheckpointTag} / {@link ReplayOptions.fromPromptIndex}.
   */
  replay?: ReplayOptions;
  /**
   * 1-based prompt index to start execution from (the `--start-at` CLI flag). When supplied,
   * all prompts whose 1-based position is less than `startAt` are marked as satisfied
   * dependencies and skipped â€” no claude/git/Sentinel is invoked for them, and queue.yaml
   * and governance files are NOT modified. If `startAt` exceeds the total number of prompts,
   * the executor returns a failed result before executing anything.
   */
  startAt?: number;
  /**
   * The Phase 1 feature list, used by the dry-run cost estimate (F11). When omitted in a dry run
   * the executor derives an approximate scope from the queue (and warns). Ignored when not a dry run.
   */
  features?: Array<FeatureSpec | string>;
  /** The main branch merges target / rollback resets. Default `'main'`. */
  mainBranch?: string;
  /**
   * Per-prompt claude timeout (ms). Default: per-prompt-type budget from `forge_config.json`'s
   * `build.timeoutMinutes` / `build.longTimeoutMinutes` (Session 5 finding #14) â€” `test`/`deploy`
   * prompts get the long budget, everything else gets the default. Setting this OVERRIDES the
   * per-type budget uniformly for every prompt (kept for tests / a manual global override).
   */
  claudeTimeoutMs?: number;
  /**
   * Directory containing skill sub-folders (each with a SKILL.md file). When a queue entry
   * declares `skills: [name1, name2]`, the executor reads `<skillsDir>/<name>/SKILL.md` and
   * prepends the combined content before the entry's description text. Missing skill files are
   * skipped with a warning (non-fatal). Default: the `skills/` directory beside the FORGE root.
   */
  skillsDir?: string;

  // -- injectable collaborators (tests) -------------------------------------
  /**
   * Override the claude execution. Default: {@link runClaude}. The optional third argument is
   * the per-prompt-type timeout budget (ms) the loop computed (Session 5 finding #14) â€” an
   * injected override may ignore it (existing 2-arg fakes remain valid).
   */
  runClaudeImpl?: (prompt: string, cwd: string, timeoutMs?: number) => Promise<ClaudeRunResult>;
  /** Override the failure prediction. Default: {@link predictFailure}. */
  predictImpl?: (input: {
    promptType: PromptType;
    stackFingerprint?: StackFingerprint | null;
    promptIndex?: number;
  }) => Promise<FailurePrediction>;
  /** Override the prompt assembly. Default: {@link assemblePrompt}. */
  assembleImpl?: (input: {
    entry: QueueEntry;
    governanceDocs: Record<string, string>;
    stackFingerprint?: StackFingerprint | null;
    previousSentinel?: PreviousSentinelStatus | null;
    relevantFilesBlock?: string;
    projectPath?: string;
  }) => Promise<AssembledPrompt>;
  /** Override the prompt rewrite. Default: {@link rewritePrompt}. */
  rewriteImpl?: (input: {
    prompt: string;
    promptType: PromptType;
    matchingPatterns?: FailurePrediction['matchingPatterns'];
    probability?: number;
    stackFingerprint?: StackFingerprint | null;
  }) => Promise<{ rewrittenPrompt: string; reason: string; originalHash: string; rewrittenHash: string }>;
  /** Override the dry-run cost estimate (F11). Default: {@link estimateBuildCost}. */
  estimateCostImpl?: (input: CostEstimateInput, options?: CostEstimatorOptions) => Promise<BuildEstimate>;
  /** Override the Sentinel run. Default: {@link runSentinel}. */
  runSentinelImpl?: (options: SentinelOptions) => Promise<SentinelResult>;
  /** Override Autonomous Recovery. Default: {@link runAutonomousRecovery}. */
  runRecoveryImpl?: (
    failed: SentinelResult,
    rerunPrompt: RerunPromptFn,
    sentinelOptions: SentinelOptions,
    promptExecutionId: string | null
  ) => Promise<AutoRecoveryResult>;
  /** Provide the GitManager (tests inject a fake). Default: a real one bound to `projectPath`. */
  gitManager?: GitManager;
  /** Override governance-doc loading. Default: read the standard docs from the governance dir. */
  loadGovernanceDocs?: (governanceDir: string) => Promise<Record<string, string>>;
  /** Override the STATE_OF_THE_BUILD.md progress update (Canonical Rule 9). Default: append a line. */
  updateStateProgress?: (line: string) => Promise<void>;
  /** Override the halt-report write. Default: write `state/halt-reason.md` under the project. */
  writeHaltReport?: (report: string) => Promise<void>;

  // -- injectable Build Memory writes (tests / stateless) -------------------
  /** Create the build_run. Default: `BuildMemory.builds.createBuild`. */
  createBuild?: (input: Parameters<typeof BuildMemory.builds.createBuild>[0]) => Promise<{ id: string } | null>;
  /** Patch the build_run. Default: `BuildMemory.builds.updateBuild`. */
  updateBuild?: (id: string, patch: Parameters<typeof BuildMemory.builds.updateBuild>[1]) => Promise<unknown>;
  /** Create a prompt_execution. Default: `BuildMemory.prompts.createPromptExecution`. */
  createPromptExecution?: (
    input: Parameters<typeof BuildMemory.prompts.createPromptExecution>[0]
  ) => Promise<{ id: string } | null>;
  /** Patch a prompt_execution. Default: `BuildMemory.prompts.updatePromptExecution`. */
  updatePromptExecution?: (
    id: string,
    patch: Parameters<typeof BuildMemory.prompts.updatePromptExecution>[1]
  ) => Promise<unknown>;
  /** Override the prompt-decomposition execution (tests). Default: {@link runDecomposedPrompt}. */
  runDecomposedPromptImpl?: (
    parent: DecompositionParent,
    assembledPrompt: string,
    deps: DecompositionDeps
  ) => Promise<DecompositionResult>;
  /**
   * Persist a decomposition record to Build Memory for Phase 5 pattern learning. Default: a guarded
   * `cross_project_insights` write (no-op in stateless mode). Injectable for tests.
   */
  recordDecomposition?: (record: DecompositionRecord) => Promise<void>;

  /** Progress reporter. Default logs to the console with a `[FORGE:phase3]` prefix. */
  log?: (message: string) => void;

  // -- new capabilities (injectable for tests) --------------------------------
  /**
   * HookManager instance for pre/post prompt lifecycle events. Default: a new HookManager
   * with hooks loaded from `<projectPath>/hooks.json` (built-in hooks always active).
   */
  hookManager?: HookManager;
  /**
   * Known instinct rules (extracted from prior builds) to apply to each prompt before
   * execution. Default: empty (no instincts). Load via {@link extractInstincts} externally.
   */
  instincts?: Instinct[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The governance documents the assembler may inject â€” read into the doc map for assembly. */
export const GOVERNANCE_DOC_NAMES: readonly string[] = [
  'BLUEPRINT.md',
  'SCHEMA_REGISTRY.md',
  'BEHAVIORAL_CONTRACTS.md',
  'INTERACTION_MAPS.md',
  'AGENTS.md',
  'TESTING.md',
  'DESIGN_SYSTEM.md',
];

// ---------------------------------------------------------------------------
// Per-prompt-type timeout budgets (Session 5 finding #14)
// ---------------------------------------------------------------------------

/** Prompt types whose work is inherently slower than average generation (a full test/deploy run). */
const LONG_TIMEOUT_PROMPT_TYPES: ReadonlySet<PromptType> = new Set<PromptType>(['test', 'deploy']);

interface TimeoutBudgetConfig {
  timeoutMinutes: number;
  longTimeoutMinutes: number;
}

/** The built-in defaults, mirroring `DEFAULT_FORGE_CONFIG.build` in src/cli/config.ts. */
const DEFAULT_TIMEOUT_BUDGET_CONFIG: TimeoutBudgetConfig = { timeoutMinutes: 15, longTimeoutMinutes: 30 };

/**
 * Read `<projectPath>/forge_config.json`'s `build.timeoutMinutes` / `build.longTimeoutMinutes`
 * (falling back to the built-in defaults for a missing file/field â€” never throws). Read directly
 * rather than via `src/cli/config.ts` to keep phases free of a dependency on the cli layer.
 */
async function loadTimeoutBudgetConfig(projectPath: string): Promise<TimeoutBudgetConfig> {
  try {
    const raw = await readFile(join(projectPath, 'forge_config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { build?: { timeoutMinutes?: unknown; longTimeoutMinutes?: unknown } };
    const timeoutMinutes =
      typeof parsed.build?.timeoutMinutes === 'number' && parsed.build.timeoutMinutes > 0
        ? parsed.build.timeoutMinutes
        : DEFAULT_TIMEOUT_BUDGET_CONFIG.timeoutMinutes;
    const longTimeoutMinutes =
      typeof parsed.build?.longTimeoutMinutes === 'number' && parsed.build.longTimeoutMinutes > 0
        ? parsed.build.longTimeoutMinutes
        : DEFAULT_TIMEOUT_BUDGET_CONFIG.longTimeoutMinutes;
    return { timeoutMinutes, longTimeoutMinutes };
  } catch {
    return DEFAULT_TIMEOUT_BUDGET_CONFIG;
  }
}

/** Build a `promptType -> timeout budget (ms)` resolver bound to one build's config. */
function makeTimeoutBudgetResolver(config: TimeoutBudgetConfig): (promptType: PromptType) => number {
  return (promptType) =>
    (LONG_TIMEOUT_PROMPT_TYPES.has(promptType) ? config.longTimeoutMinutes : config.timeoutMinutes) * 60_000;
}

/**
 * Force a "silent timeout" (claude timed out, but Sentinel still reports PASS on whatever code
 * happened to exist) to read as a failure â€” Sentinel proves the code doesn't obviously break, not
 * that the prompt's work happened (Session 5 finding #14). A no-op when Sentinel already failed
 * for its own reason (that failure already stands on its own).
 */
function forceFailOnTimeout(
  sentinel: SentinelResult,
  timeoutMs: number,
  entry: QueueEntry,
  log: (message: string) => void,
  index: number
): SentinelResult {
  if (!sentinel.passed) return sentinel;
  // Unquoted "prompt type X" (not `'X'`) deliberately â€” normalizeErrorSignature strips quoted
  // literals, which would erase the prompt type and collapse every timeout onto one signature.
  // Session 5 finding #15 needs a signature that stays distinct PER prompt type (timeout+type).
  const timeoutNote =
    `claude-runner TIMEOUT after ${Math.round(timeoutMs / 1000)}s for prompt type ${entry.prompt_type} â€” ` +
    'Sentinel reported PASS, but a timed-out run proves nothing about whether the work completed.';
  log(`prompt ${index} '${entry.id}': ${timeoutNote}`);
  return {
    ...sentinel,
    passed: false,
    diagnosticReport: `${timeoutNote}\n\n--- Sentinel's checks (informational only â€” not authoritative given the timeout) ---\n${sentinel.diagnosticReport}`,
  };
}

/**
 * Force a Sentinel PASS to read as a FAILURE whenever the claude run itself did not succeed and it
 * wasn't a timeout ({@link forceFailOnTimeout} already handles that case with its own message).
 * Session 5.2 root cause: a claude run that exits non-zero, never spawns, or (per claude-runner's
 * updated contract) exits 0 with completely empty stdout produced NO real work â€” yet Sentinel could
 * still report PASS (validating a stale/wrong/empty project). A prompt whose own execution didn't
 * succeed must NEVER be allowed to merge on the back of a Sentinel PASS, no matter what Sentinel's
 * checks found. A no-op when Sentinel already failed for its own reason, or when the run succeeded.
 */
function forceFailOnClaudeFailure(
  sentinel: SentinelResult,
  run: ClaudeRunResult,
  entry: QueueEntry,
  log: (message: string) => void,
  index: number
): SentinelResult {
  if (!sentinel.passed) return sentinel;
  if (run.success || run.timedOut) return sentinel;
  const note =
    `claude did not complete prompt type ${entry.prompt_type} (exit ${run.exitCode ?? 'null'}` +
    `${run.stdout.trim() === '' ? ', empty stdout' : ''}) â€” Sentinel reported PASS, but a run that ` +
    'did not succeed proves nothing about whether the work happened.';
  log(`prompt ${index} '${entry.id}': ${note}`);
  return {
    ...sentinel,
    passed: false,
    diagnosticReport: `${note}\n\n--- Sentinel's checks (informational only â€” not authoritative given the failed run) ---\n${sentinel.diagnosticReport}`,
  };
}

/**
 * Best-effort project-boundary scan (Session 5.2 Task 3): claude's print-mode stdout is prose, not
 * a structured tool-call log, so this is a heuristic net over the ONE signal the runner exposes
 * today â€” it is NOT a guarantee every out-of-bounds write is caught. Flags absolute-looking paths
 * (Windows `C:\...` or POSIX `/...`, with a file extension to cut noise) that fall outside
 * `projectPath`; excludes URLs. A hit marks the prompt failed (Task 3: "violations log loudly and
 * mark the prompt failed").
 */
const OUT_OF_BOUNDS_PATH_PATTERN = /(?<![A-Za-z:])[A-Za-z]:[\\/][^\s"'`)]+|(?<![:/])\/[^\s"'`)]{2,}/g;

export function findOutOfBoundsPaths(stdout: string, projectPath: string): string[] {
  if (!stdout) return [];
  const normalizedRoot = projectPath.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const found = new Set<string>();
  // Strip whole URLs FIRST â€” otherwise the POSIX-path alternative can match a URL's path segment
  // (e.g. the `/docs.png` inside `https://example.com/docs.png`) as a false positive, since that
  // slash isn't preceded by `:` or `/` and so isn't caught by the pattern's own lookbehind.
  const withoutUrls = stdout.replace(/\b\w+:\/\/\S+/g, ' ');
  const matches = withoutUrls.match(OUT_OF_BOUNDS_PATH_PATTERN) ?? [];
  for (const raw of matches) {
    if (!/\.[a-zA-Z0-9]{1,10}$/.test(raw)) continue; // only path-shaped tokens (has an extension)
    const normalized = raw.replace(/\\/g, '/').toLowerCase();
    if (normalized.startsWith(normalizedRoot)) continue;
    found.add(raw);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// queue.yaml parsing
// ---------------------------------------------------------------------------

/** Coerce an unknown to a trimmed string, or `''`. */
function asString(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

/** Coerce an unknown to a string[] (dropping non-strings/empties). */
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
}

/** The valid prompt-type union (mirrors queue-generator's `PromptType`). */
const PROMPT_TYPES: ReadonlySet<string> = new Set<PromptType>([
  'schema',
  'auth',
  'api',
  'ui',
  'feature',
  'agent',
  'test',
  'deploy',
]);

/** Coerce a raw `context_injection` block (snake_case in YAML) into the camelCase shape. */
function asContextInjection(v: unknown): ContextInjection {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    schemaSections: asStringArray(o.schema_sections ?? o.schemaSections),
    behavioralSections: asStringArray(o.behavioral_sections ?? o.behavioralSections),
    interactionMaps: asStringArray(o.interaction_maps ?? o.interactionMaps),
  };
}

/**
 * Coerce a single raw YAML mapping into a {@link QueueEntry}. Tolerant of the Queue
 * Generator's emitted shape (snake_case `context_injection`, flow-list dependencies, `|`
 * block description). Returns `null` (with a warning) when `raw` isn't a mapping or has no
 * id â€” shared by {@link parseQueueYaml} (one queue.yaml = a list of these) and
 * {@link parseSingleQueueEntryYaml} (`forge compile`'s one-entry-per-file prompt library â€”
 * see `src/cli/compile-command.ts`), so the tolerant-coercion rules live in exactly one place.
 */
export function coerceQueueEntry(
  raw: unknown,
  label: string,
  warn: (message: string) => void
): QueueEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`${label} is not a mapping â€” skipped.`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const id = asString(o.id).trim();
  if (id === '') {
    warn(`${label} has no id â€” skipped.`);
    return null;
  }
  const rawType = asString(o.prompt_type).trim();
  const promptType = (PROMPT_TYPES.has(rawType) ? rawType : 'feature') as PromptType;
  if (!PROMPT_TYPES.has(rawType)) {
    warn(`${label} ('${id}') has unknown prompt_type '${rawType}' â€” defaulted to 'feature'.`);
  }
  const entry: QueueEntry = {
    id,
    name: asString(o.name).trim() || id,
    prompt_type: promptType,
    dependencies: asStringArray(o.dependencies),
    governance_refs: asStringArray(o.governance_refs),
    estimated_tokens: typeof o.estimated_tokens === 'number' ? o.estimated_tokens : 0,
    context_injection: asContextInjection(o.context_injection),
    description: asString(o.description),
  };
  const group = asString(o.parallel_group).trim();
  if (group !== '') entry.parallel_group = group;
  const skills = asStringArray(o.skills);
  if (skills.length > 0) entry.skills = skills;
  const infra = asString(o.infra).trim();
  if (infra === 'local' || infra === 'cloud') entry.infra = infra;
  return entry;
}

/**
 * The VS Code integration layer's build-level pre-run gate (checked ONCE before any prompt
 * executes â€” never per-prompt). Declared as a top-level `pre_run_checks:` block in queue.yaml
 * ALONGSIDE the prompt list (queue.yaml then becomes `{ prompts: [...], pre_run_checks: {...} }`
 * rather than a bare list â€” the classic bare-list shape keeps working with no `pre_run_checks`).
 */
export interface PreRunChecks {
  /** Require a running VS Code (`Code.exe`) process before the build starts. */
  vs_code_open?: boolean;
  /** Require SESSION_STATE.md's IDE STATUS block to show `CHANGESET.md reviewed: YES`. */
  changeset_reviewed?: boolean;
}

/** Coerce a raw `pre_run_checks` mapping into {@link PreRunChecks} (`null` when empty/absent). */
function asPreRunChecks(v: unknown): PreRunChecks | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const checks: PreRunChecks = {};
  if (typeof o.vs_code_open === 'boolean') checks.vs_code_open = o.vs_code_open;
  if (typeof o.changeset_reviewed === 'boolean') checks.changeset_reviewed = o.changeset_reviewed;
  return Object.keys(checks).length > 0 ? checks : null;
}

/**
 * Parse queue.yaml text into {@link QueueEntry}[]. Accepts either shape: the classic bare list of
 * prompts, or `{ prompts: [...], pre_run_checks: {...} }` (the VS Code integration layer's opt-in
 * pre-run gate). A malformed entry is skipped with a warning rather than throwing. Returns the
 * entries + warnings + the parsed `pre_run_checks` block (`null` when absent â€” the bare-list shape
 * never has one).
 */
export function parseQueueYaml(
  yamlText: string
): { entries: QueueEntry[]; warnings: string[]; preRunChecks: PreRunChecks | null } {
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (error) {
    warnings.push(`queue.yaml is not valid YAML (${describe(error)}) â€” no prompts parsed.`);
    return { entries: [], warnings, preRunChecks: null };
  }

  let rawEntries: unknown[];
  let preRunChecks: PreRunChecks | null = null;
  if (Array.isArray(doc)) {
    rawEntries = doc;
  } else if (doc && typeof doc === 'object' && Array.isArray((doc as Record<string, unknown>).prompts)) {
    const o = doc as Record<string, unknown>;
    rawEntries = o.prompts as unknown[];
    preRunChecks = asPreRunChecks(o.pre_run_checks);
  } else {
    warnings.push('queue.yaml did not parse to a list of prompts â€” no prompts parsed.');
    return { entries: [], warnings, preRunChecks: null };
  }

  const entries: QueueEntry[] = [];
  rawEntries.forEach((raw, i) => {
    const entry = coerceQueueEntry(raw, `queue.yaml entry #${i + 1}`, (m) => warnings.push(m));
    if (entry) entries.push(entry);
  });

  return { entries, warnings, preRunChecks };
}

/**
 * Parse a SINGLE-entry prompt-library YAML file (`forge compile`'s `prompts/**\/*.yaml` â€”
 * one queue entry per file, a plain mapping rather than a list) into a {@link QueueEntry}.
 * `label` (typically the file's path relative to the prompts directory) is used in warnings.
 * Returns `{ entry: null, warnings }` on malformed YAML / a non-mapping / a missing id.
 */
export function parseSingleQueueEntryYaml(
  yamlText: string,
  label: string
): { entry: QueueEntry | null; warnings: string[] } {
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (error) {
    warnings.push(`${label} is not valid YAML (${describe(error)}) â€” skipped.`);
    return { entry: null, warnings };
  }
  const entry = coerceQueueEntry(doc, label, (m) => warnings.push(m));
  return { entry, warnings };
}

// ---------------------------------------------------------------------------
// Defaults for the injectable collaborators
// ---------------------------------------------------------------------------

/** Default governance-doc loader: read the standard docs from the governance dir (guarded). */
async function defaultLoadGovernanceDocs(governanceDir: string): Promise<Record<string, string>> {
  const docs: Record<string, string> = {};
  for (const name of GOVERNANCE_DOC_NAMES) {
    try {
      docs[name] = await readFile(join(governanceDir, name), 'utf8');
    } catch {
      /* missing doc â€” the assembler records it as a visible note (Contract 7). */
    }
  }
  return docs;
}

/** Convert a StackFingerprint into a Build-Memory `jsonb` object (every field is JSON-safe). */
function fingerprintToJson(fp: StackFingerprint | null | undefined): JsonObject {
  if (!fp) return {};
  return {
    framework: fp.framework,
    language: fp.language,
    database: fp.database,
    deployment: fp.deployment,
    packageManager: fp.packageManager,
    services: [...fp.services],
    cliTools: [...fp.cliTools],
  };
}

/** Map a git `--name-status` letter to a created/modified/deleted bucket. */
function classifyChange(status: string): 'created' | 'modified' | 'deleted' | 'other' {
  const s = (status ?? '').toUpperCase();
  if (s.startsWith('A')) return 'created';
  if (s.startsWith('D')) return 'deleted';
  if (s.startsWith('M') || s.startsWith('R') || s.startsWith('C')) return 'modified';
  return 'other';
}

/** Render an unknown thrown value as a short string for logging. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Render a millisecond duration as a compact human string (`"12.3s"`, `"1m45s"`, `"2h03m"`). */
function humanDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return totalSeconds >= 10 ? `${totalSeconds}s` : `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Human-readable progress renderer (FORGE 1.0 forge.ps1 `Log` parity)
// ---------------------------------------------------------------------------

/** Progress levels, matching forge.ps1's `Log -level` switch. */
type ProgressLevel = 'INFO' | 'PASS' | 'FAIL' | 'ERROR' | 'WARN' | 'GATE';

const ANSI_RESET = '\x1b[0m';

/** forge.ps1's `Write-Host -ForegroundColor` switch, ported to ANSI SGR codes. */
const ANSI_COLOR: Record<ProgressLevel, string> = {
  ERROR: '\x1b[31m', // Red
  FAIL: '\x1b[31m', // Red
  WARN: '\x1b[33m', // Yellow
  PASS: '\x1b[32m', // Green
  GATE: '\x1b[36m', // Cyan
  INFO: '\x1b[37m', // White
};

function twoDigit(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Write one `[HH:mm:ss] [LEVEL] message` line to stdout, colorized to match forge.ps1's `Log`
 * function (green PASS, red FAIL/ERROR, cyan GATE, yellow WARN, white INFO). This is a distinct,
 * purpose-built console renderer for human operators watching a live build â€” separate from `log`
 * (Build Memory / death-forensics / pino), which every collaborator above already feeds.
 */
function renderProgress(level: ProgressLevel, message: string): void {
  const now = new Date();
  const ts = `${now.getFullYear()}-${twoDigit(now.getMonth()+1)}-${twoDigit(now.getDate())} ${twoDigit(now.getHours())}:${twoDigit(now.getMinutes())}:${twoDigit(now.getSeconds())}`;
  const color = ANSI_COLOR[level];
  process.stdout.write(`${color}[${ts}] [${level}] ${message}${ANSI_RESET}\n`);
}

/**
 * Redirect `console.log/warn/error` to `buildLogPath` for the duration of Phase 3. The learning
 * engine (`[FORGE Learning]`, `[SESSION]` lines) calls these directly rather than going through
 * `forge-logger`, so they'd otherwise interleave raw text with `renderProgress`'s
 * `[HH:mm:ss] [LEVEL]` lines â€” the only thing that belongs on stdout during a build. Returns a
 * restore function; callers must invoke it before every return out of Phase 3.
 */
function installQuietConsole(buildLogPath: string | null): () => void {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const redirect = (...args: unknown[]): void => {
    if (!buildLogPath) return;
    try {
      const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      appendFileSync(buildLogPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch {
      /* best-effort */
    }
  };
  console.log = redirect;
  console.warn = redirect;
  console.error = redirect;
  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 3 against `projectPath`: walk the build queue in dependency order, driving each
 * prompt through predict â†’ assemble â†’ (rewrite) â†’ branch â†’ claude â†’ Sentinel â†’ merge/checkpoint
 * or halt/auto-recover, logging to Build Memory throughout (queue.yaml s5-p05). Sequential is
 * the default. Always resolves â€” every collaborator is guarded and the loop never throws.
 */
export async function runPhase3Executor(options: Phase3Options): Promise<Phase3Result> {
  // stdout must carry ONLY renderProgress's `[HH:mm:ss] [LEVEL]` lines for the lifetime of this
  // call â€” every pino line any collaborator emits (this module included) is diverted to
  // `.forge/build.log` from the very first instruction, before any other code runs, so nothing
  // can slip a line onto stdout ahead of this gate going up. Restored in the `finally` below.
  const releaseQuietLogging = beginQuietLogging('.forge/build.log');
  const baseLog = options.log ?? logLine('phase3');
  const projectPath = options.projectPath;
  const governanceDirName = options.governanceDirName ?? 'governance';
  const governanceDir = join(projectPath, governanceDirName);
  const projectName = options.projectName ?? basenameOf(projectPath);
  const machineId = options.machineId ?? process.env.FORGE_MACHINE_ID ?? randomUUID();
  const dryRun = options.dryRun ?? false;
  const replay = options.replay ?? null;
  const mainBranch = options.mainBranch ?? 'main';
  const generatedAt = nowIso();
  const warnings: string[] = [];

  // Persistent log tee (Session 5 finding #12): the dialtest deaths left no forensics because
  // console history was the ONLY record. Every log line this build emits is also appended to
  // <project>/.forge/logs/build_<timestamp>.log â€” a real file that survives a closed terminal.
  // Skipped for dry runs (nothing executes; no build worth a persistent log).
  let buildLogPath: string | null = null;
  if (!dryRun) {
    try {
      const logsDir = join(projectPath, '.forge', 'logs');
      mkdirSync(logsDir, { recursive: true });
      buildLogPath = join(logsDir, `build_${generatedAt.replace(/[:.]/g, '-')}.log`);
    } catch {
      buildLogPath = null; // best-effort â€” a build must never fail because its log file couldn't open
    }
  }
  // Feed every Phase 3 progress line into the death-forensics ring buffer (Session 5 finding
  // #13) AND the persistent log file (finding #12) so a death report / post-mortem always has
  // the full story, not just whatever was left in a closed terminal.
  const log = (message: string): void => {
    recordLogLine(message);
    baseLog(message);
    if (buildLogPath) {
      try {
        appendFileSync(buildLogPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
      } catch {
        /* best-effort */
      }
    }
  };

  // stdout must carry ONLY renderProgress's `[HH:mm:ss] [LEVEL]` lines during a build (matching
  // FORGE 1.0's forge.ps1 output). Everything else this run's collaborators emit â€” pino JSON from
  // `log`/hook-manager/the predictor (diverted above, at function entry) and raw console.log from
  // the learning engine (diverted here) â€” is kept off stdout. Both restores MUST run before every
  // return out of this function.
  const restoreConsole = buildLogPath ? installQuietConsole(buildLogPath) : (() => {});
  const releaseStdoutQuietMode = (): void => {
    restoreConsole();
    releaseQuietLogging();
  };

  // Stale-lock recovery (Session 5 finding #13): a forge_running.lock left behind by a build
  // that died before reaching its own cleanup means a PRIOR run silently died. Detect it, log
  // it loudly, clear it, and continue â€” a dead lock must never block a new build. Skipped for
  // dry runs (they never acquire the lock in the first place).
  if (!dryRun) {
    const staleLock = checkStaleLock(projectPath, log);
    if (staleLock.stale) {
      warnings.push(
        `Recovered from a stale forge_running.lock (prior build ${staleLock.buildRunId ?? '(unknown)'}, ` +
          `pid ${staleLock.pid ?? '?'} not running) â€” a previous FORGE run died silently.`
      );
    }
  }

  const skillsDir =
    options.skillsDir ??
    (() => {
      try {
        return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
      } catch {
        return join(process.cwd(), 'skills');
      }
    })();

  // Collaborators (defaults wired to the real engine pieces; all injectable for tests). Each
  // const is explicitly annotated so the default arrow is contextually typed (params inferred)
  // and a `??` never synthesises a union-of-functions call site.
  const runClaudeImpl: NonNullable<Phase3Options['runClaudeImpl']> =
    options.runClaudeImpl ??
    ((prompt, cwd, timeoutMs) =>
      runClaude(prompt, { cwd, timeoutMs: options.claudeTimeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS }));
  const predictImpl: NonNullable<Phase3Options['predictImpl']> =
    options.predictImpl ?? ((input) => predictFailure(input));
  const assembleImpl: NonNullable<Phase3Options['assembleImpl']> =
    options.assembleImpl ?? ((input) => assemblePrompt(input));
  const rewriteImpl: NonNullable<Phase3Options['rewriteImpl']> =
    options.rewriteImpl ?? ((input) => rewritePrompt(input));
  const estimateCostImpl: NonNullable<Phase3Options['estimateCostImpl']> =
    options.estimateCostImpl ?? ((input, opts) => estimateBuildCost(input, opts));
  const runSentinelImpl: NonNullable<Phase3Options['runSentinelImpl']> =
    options.runSentinelImpl ?? ((opts) => runSentinel(opts));
  const runRecoveryImpl: NonNullable<Phase3Options['runRecoveryImpl']> =
    options.runRecoveryImpl ??
    ((failed, rerunPrompt, sentinelOptions, promptExecutionId) =>
      runAutonomousRecovery(failed, {
        autonomousRecoveryMode: true,
        rerunPrompt,
        sentinelOptions,
        promptExecutionId,
      }));
  const git = options.gitManager ?? new GitManager({ cwd: projectPath, mainBranch, log: (m) => log(`git: ${m}`) });
  const loadGovernanceDocs: NonNullable<Phase3Options['loadGovernanceDocs']> =
    options.loadGovernanceDocs ?? defaultLoadGovernanceDocs;
  const updateStateProgress: NonNullable<Phase3Options['updateStateProgress']> =
    options.updateStateProgress ?? ((line) => defaultUpdateStateProgress(governanceDir, line));
  const writeHaltReport: NonNullable<Phase3Options['writeHaltReport']> =
    options.writeHaltReport ?? ((report) => defaultWriteHaltReport(projectPath, report));
  const createBuild: NonNullable<Phase3Options['createBuild']> =
    options.createBuild ?? ((input) => BuildMemory.builds.createBuild(input));
  const updateBuild: NonNullable<Phase3Options['updateBuild']> =
    options.updateBuild ?? ((id, patch) => BuildMemory.builds.updateBuild(id, patch));
  const createPromptExecution: NonNullable<Phase3Options['createPromptExecution']> =
    options.createPromptExecution ?? ((input) => BuildMemory.prompts.createPromptExecution(input));
  const updatePromptExecution: NonNullable<Phase3Options['updatePromptExecution']> =
    options.updatePromptExecution ?? ((id, patch) => BuildMemory.prompts.updatePromptExecution(id, patch));
  const runDecomposedPromptImpl: NonNullable<Phase3Options['runDecomposedPromptImpl']> =
    options.runDecomposedPromptImpl ?? ((parent, assembledPrompt, deps) => runDecomposedPrompt(parent, assembledPrompt, deps));

  // 1. Resolve the queue (supplied entries, else parse queue.yaml).
  let entries: QueueEntry[] = options.entries ?? [];
  // Session 5.1 hotfix: hash of the queue.yaml this build actually ran against, persisted on the
  // build_run below so a later --auto-resume can confirm it's resuming against the SAME queue
  // (`src/engine/auto-resume.ts` â€º computeResumeStartAt). Only set when a real queue.yaml was
  // read from disk â€” a caller supplying `options.entries` directly (tests, in-memory queues) has
  // no on-disk file for a resume to compare against, so it stays null.
  let queueHashForBuild: string | null = null;
  // VS Code integration layer (queue.yaml pre-run gate): the optional `pre_run_checks` block,
  // present only when queue.yaml uses the `{ prompts, pre_run_checks }` shape.
  let preRunChecks: PreRunChecks | null = null;
  if (options.entries === undefined) {
    const queuePath = options.queuePath ?? join(projectPath, 'queue.yaml');
    let yamlText: string | null = null;
    try {
      yamlText = await readFile(queuePath, 'utf8');
    } catch (error) {
      warnings.push(`Could not read queue.yaml at ${queuePath} (${describe(error)}) â€” nothing to execute.`);
      log(`WARNING: could not read ${queuePath} (${describe(error)})`);
    }
    if (yamlText !== null) {
      const parsed = parseQueueYaml(yamlText);
      entries = parsed.entries;
      warnings.push(...parsed.warnings);
      queueHashForBuild = queueShortHash(yamlText);
      preRunChecks = parsed.preRunChecks;
    }
  }

  // 1b. Dependency analysis (topological order + waves + parallel groups). Sequential = `order`.
  const schedule = analyzeSchedule(entries, { log: (m) => log(`scheduler: ${m}`) });
  warnings.push(...schedule.warnings);

  // --start-at validation: run before the log header so the error is the first thing the user sees.
  const startAt = options.startAt;
  if (startAt !== undefined) {
    if (!Number.isInteger(startAt) || startAt < 1) {
      const msg = `--start-at must be a positive integer >= 1 (got ${startAt})`;
      log(`ERROR: ${msg}`);
      releaseStdoutQuietMode();
      return { projectName, buildRunId: null, status: 'failed', schedule, outcomes: [], completedPrompts: 0, failedPrompts: 0, skippedPrompts: 0, totalTokens: 0, haltedAt: null, haltReason: msg, replayOf: null, simulation: null, warnings: [...warnings, msg], generatedAt };
    }
    if (startAt > schedule.order.length) {
      const msg = `--start-at ${startAt} exceeds the total number of prompts in the queue (${schedule.order.length}). Nothing will be executed.`;
      log(`ERROR: ${msg}`);
      releaseStdoutQuietMode();
      return { projectName, buildRunId: null, status: 'failed', schedule, outcomes: [], completedPrompts: 0, failedPrompts: 0, skippedPrompts: 0, totalTokens: 0, haltedAt: null, haltReason: msg, replayOf: null, simulation: null, warnings: [...warnings, msg], generatedAt };
    }
  }

  // VS Code integration layer: queue.yaml's optional `pre_run_checks` gate â€” a build-level check
  // run ONCE before any prompt executes (never per-prompt). Skipped for dry runs (nothing executes)
  // and when the queue declares no `pre_run_checks` block.
  if (!dryRun && preRunChecks) {
    const gate = checkPreRunGates(preRunChecks, { governanceDir, log });
    if (!gate.passed) {
      const msg = gate.reason ?? 'queue.yaml pre_run_checks failed.';
      log(`ERROR: ${msg}`);
      releaseStdoutQuietMode();
      return { projectName, buildRunId: null, status: 'failed', schedule, outcomes: [], completedPrompts: 0, failedPrompts: 0, skippedPrompts: 0, totalTokens: 0, haltedAt: null, haltReason: msg, replayOf: null, simulation: null, warnings: [...warnings, msg], generatedAt };
    }
    log(`pre-run gate: queue.yaml pre_run_checks (${Object.keys(preRunChecks).join(', ')}) â€” all checks passed.`);
  }

  log(
    `Phase 3 ${dryRun ? '(DRY RUN) ' : ''}${replay ? '(REPLAY) ' : ''}${startAt !== undefined ? `(--start-at ${startAt}) ` : ''}on "${projectName}": ` +
      `${schedule.order.length} prompt(s), ${schedule.longestChain} wave(s), ` +
      `max parallelism ${schedule.maxParallelism}. Sequential execution.` +
      (replay ? ` Resuming build ${replay.originalBuildRunId} from prompt ${replay.fromPromptIndex} (${replay.fromCheckpointTag}).` : '') +
      (startAt !== undefined ? ` Skipping prompts 1â€“${startAt - 1}; execution begins at prompt ${startAt}.` : '')
  );

  // 2. Create the build_run (status running). Guarded â€” degrades to stateless (Contract 4). For a
  //    replay the new build links back to the original via a `_forge_replay` block in the
  //    toolchain_manifest jsonb (build_runs has no dedicated parent column and SCHEMA_REGISTRY is
  //    read-only â€” Iron Law 1), so the lineage is queryable without a schema change.
  const toolchainManifest: JsonObject = {
    ...(options.toolchainManifest ?? {}),
    ...(replay
      ? {
          _forge_replay: {
            replay_of: replay.originalBuildRunId,
            from_checkpoint: replay.fromCheckpointTag,
            from_prompt_index: replay.fromPromptIndex,
          },
        }
      : {}),
  };
  let buildRunId: string | null = null;
  try {
    const created = await createBuild({
      project_name: projectName,
      project_path: projectPath,
      machine_id: machineId,
      status: dryRun ? 'queued' : 'running',
      started_at: generatedAt,
      total_prompts: schedule.order.length,
      stack_fingerprint: fingerprintToJson(options.stackFingerprint),
      toolchain_manifest: toolchainManifest,
      governance_hash: options.governanceHash ?? null,
      queue_hash: queueHashForBuild,
      autonomous_recovery_mode: options.autonomousRecoveryMode ?? false,
      dry_run: dryRun,
      parallel_prompts_used: false,
    });
    buildRunId = created?.id ?? null;
  } catch (error) {
    log(`WARNING: createBuild degraded (${describe(error)}) â€” running stateless`);
  }
  if (buildRunId === null) warnings.push('Build Memory unreachable â€” running in stateless mode (Contract 4).');

  if (!dryRun) {
    renderProgress(
      'GATE',
      `FORGE PIPELINE STARTING : project "${projectName}" : build ${buildRunId ?? '(stateless)'} : ` +
        `${schedule.order.length} prompt(s) : started ${generatedAt}`
    );
  }

  // Tag every log line emitted for the rest of this build with the build id + project, so any
  // module FORGE drives (assembler, sentinel, claude-runner, â€¦) carries `build_run_id`/`project`
  // automatically (forge-logger mixin). Per-prompt `prompt_id` is layered on at each call site
  // below via runWithBuildContext, and the whole context is cleared before returning.
  setLogContext({ ...(buildRunId ? { buildRunId } : {}), project: projectName });

  // Death forensics + run lock (Session 5 finding #13): from this point on, an uncaught
  // exception / unhandled rejection / abnormal exit writes .forge/death-report.md (current
  // prompt + last 50 log lines) and best-effort finalizes this build_run so the NEXT run's
  // checkStaleLock() (above) finds a clean story instead of silence.
  const deathState = { currentPromptIndex: null as number | null, currentPromptId: null as string | null };
  if (!dryRun) {
    acquireRunLock(projectPath, buildRunId);
    installDeathForensics({
      projectPath,
      getState: () => ({ buildRunId, currentPromptIndex: deathState.currentPromptIndex, currentPromptId: deathState.currentPromptId }),
      finalizeBuildAsInterrupted: async (id, reason) => {
        try {
          await updateBuild(id, {
            status: 'halted',
            completed_at: nowIso(),
            toolchain_manifest: { ...toolchainManifest, _forge_interrupted: { reason, at: nowIso() } },
          });
        } catch {
          /* best-effort â€” this runs during process death */
        }
      },
    });
  }

  // 2b. Replay rollback (F12, step 2): hard-reset main to the original build's checkpoint BEFORE
  //     reloading governance, so the repo is at the resume point and governance is read fresh from
  //     current disk (step 3 â€” it may have been edited since the original build). Non-fatal: a
  //     failed rollback replays from the current HEAD with a warning (Iron Law 3 â€” real outcome).
  if (replay && !dryRun) {
    const rollback = git.rollbackToCheckpoint(replay.fromCheckpointTag);
    if (rollback.success) {
      log(`Replay: ${mainBranch} reset to checkpoint '${replay.fromCheckpointTag}'.`);
    } else {
      const note = `Replay: rollback to checkpoint '${replay.fromCheckpointTag}' failed (${rollback.error ?? 'unknown'}) â€” replaying from current HEAD.`;
      warnings.push(note);
      log(`WARNING: ${note}`);
    }
  }

  // Load the governance docs once (the assembler injects the relevant slices per prompt).
  const governanceDocs = await loadGovernanceDocs(governanceDir).catch((error) => {
    log(`WARNING: governance-doc load degraded (${describe(error)})`);
    return {} as Record<string, string>;
  });

  // Codebase RAG (queue.yaml extension to Contract 7): index the ENTIRE target codebase on build
  // start into an in-memory vector store, so before each prompt the executor can retrieve the 10
  // most relevant existing files and inject their structural summaries â€” grounding Claude in what
  // already exists so it does not duplicate or conflict with it. Rebuilt after each SUCCESSFUL
  // prompt (below) so the next retrieval reflects the files that prompt just wrote. Non-fatal: a
  // degraded index simply injects nothing (Contract 4 posture). Skipped in a dry run â€” nothing is
  // executed or rebuilt, and injecting RAG would perturb the simulation's prompt hashes/tokens.
  const rag = dryRun ? null : await CodebaseRag.create(projectPath, { log: (m) => log(`rag: ${m}`) });
  if (rag) log(`Codebase RAG indexed ${rag.fileCount} existing source file(s) for context injection.`);

  // Decomposition record sink (pattern learning) â€” wired here so the default closes over the now-known
  // buildRunId; no-op in stateless mode (Contract 4). Injectable via options.recordDecomposition.
  const recordDecomposition: NonNullable<Phase3Options['recordDecomposition']> =
    options.recordDecomposition ?? ((record) => defaultRecordDecomposition(projectName, machineId, buildRunId, record));

  // New capabilities: HookManager, instincts, and per-build cost tracker.
  // HookManager loads custom hooks from <projectPath>/hooks.json; built-in hooks are always active.
  const hookManager: HookManager = options.hookManager ?? (() => {
    const hm = new HookManager();
    if (!dryRun) hm.loadHooks(projectPath);
    return hm;
  })();
  const instincts: Instinct[] = options.instincts ?? [];
  const costTracker = new ModelCostTracker((m) => log(`cost: ${m}`));
  const timeoutBudgetConfig = await loadTimeoutBudgetConfig(projectPath);
  const timeoutBudgetMsFor = makeTimeoutBudgetResolver(timeoutBudgetConfig);
  log(
    `timeout budgets: default ${timeoutBudgetConfig.timeoutMinutes}m, ` +
      `test/deploy ${timeoutBudgetConfig.longTimeoutMinutes}m` +
      (options.claudeTimeoutMs !== undefined ? ` (overridden uniformly to ${Math.round(options.claudeTimeoutMs / 60_000)}m by claudeTimeoutMs)` : '')
  );
  const liveStatus = new LiveStatusWriter(projectPath, projectName, buildRunId, schedule.order.length);

  // Learning engine â€” non-critical, failures are caught internally
  await onRunStart(projectPath, buildRunId ?? machineId, ['typescript', 'nextjs'], projectName).catch(() => ({ knowledge: { rules: [], skills: [], fixPatterns: [], outcomes: [], evolutions: [] }, resumeState: null }));

  // Learning Engine: SessionStart hook
  try {
    const { handleSessionStart } = await import('../learning/session-hooks.js');
    const sessionStartResult = await handleSessionStart(buildRunId ?? machineId, projectPath, projectName);
    if (sessionStartResult.contextBlock) appendFileSync(buildLogPath ?? ".forge/build.log", sessionStartResult.contextBlock + "\n", "utf8");
  } catch { /* non-fatal -- learning engine is always optional */ }

  // 3. Walk the prompts in dependency order.
  const ctx: LoopContext = {
    projectPath,
    projectName,
    governanceDirName,
    totalPrompts: schedule.order.length,
    buildRunId,
    machineId,
    stackFingerprint: options.stackFingerprint ?? null,
    autonomousRecoveryMode: options.autonomousRecoveryMode ?? false,
    dryRun,
    governanceDocs,
    git,
    mainBranch,
    rag,
    runClaudeImpl,
    timeoutBudgetMsFor,
    predictImpl,
    assembleImpl,
    rewriteImpl,
    runSentinelImpl,
    runRecoveryImpl,
    runDecomposedPrompt: runDecomposedPromptImpl,
    recordDecomposition,
    createPromptExecution,
    updatePromptExecution,
    updateStateProgress,
    writeHaltReport,
    failedSignaturesThisBuild: new Set<string>(),
    brainInterventions: { count: 0 },
    elevatedRuleIds: new Set<string>(),
    liveStatus,
    log,
    hookManager,
    instincts,
    costTracker,
  };

  const outcomes: PromptOutcome[] = [];
  const completedIds = new Set<string>();
  let previousSentinel: PreviousSentinelStatus | null = null;
  let schemaPromptsHaveRun = false;
  let halted = false;
  let haltReason: string | null = null;
  let haltedAt: { index: number; id: string } | null = null;

  for (let i = 0; i < schedule.order.length; i++) {
    const entry = schedule.order[i];
    if (entry === undefined) continue;
    const index = i + 1;
    deathState.currentPromptIndex = index;
    deathState.currentPromptId = entry.id;

    // a0. Replay carry (F12): prompts before the resume index are already present in the
    //     checkpoint â€” record them as carried (skipped, not re-executed) and treat them as
    //     satisfied dependencies so the resume index downstream resolves. A carried schema prompt
    //     means schema is live in the repo, so Sentinel's schema-drift check stays active.
    if (replay && index < replay.fromPromptIndex) {
      const note = `Replay â€” carried from checkpoint (prompt ${index} < resume index ${replay.fromPromptIndex}), not re-executed.`;
      outcomes.push(skippedOutcome(entry, index, note));
      completedIds.add(entry.id);
      if (entry.prompt_type === 'schema') schemaPromptsHaveRun = true;
      log(`prompt ${index}/${schedule.order.length} '${entry.id}': ${note}`);
      continue;
    }

    // a1. --start-at skip: user explicitly requested execution to begin at `startAt`; all
    //     preceding prompts are marked as satisfied dependencies without touching claude,
    //     git, Sentinel, or any governance / queue files (contrast with replay carry which
    //     implies a checkpoint exists on disk).
    if (startAt !== undefined && index < startAt) {
      const note = `Skipped â€” --start-at ${startAt}: prompt ${index} is before the requested start index.`;
      outcomes.push(skippedOutcome(entry, index, note));
      completedIds.add(entry.id);
      if (entry.prompt_type === 'schema') schemaPromptsHaveRun = true;
      log(`[--start-at] skipping prompt ${index}/${schedule.order.length} '${entry.id}'`);
      continue;
    }
    if (startAt !== undefined && index === startAt) {
      log(`[--start-at] resuming execution at prompt ${index}/${schedule.order.length} '${entry.id}' (prompts 1â€“${startAt - 1} were skipped)`);
    }

    // a. Dependency gate â€” the order is topological, so an unmet dependency means it failed/skipped.
    const unmet = entry.dependencies.filter((d) => !completedIds.has(d) && entries.some((e) => e.id === d));
    if (unmet.length > 0) {
      const note = `Skipped â€” unmet dependency(ies): ${unmet.join(', ')} did not complete.`;
      outcomes.push(skippedOutcome(entry, index, note));
      log(`prompt ${index}/${schedule.order.length} '${entry.id}': ${note}`);
      continue;
    }

    // Skill injection: when the entry declares skills, read each <skillsDir>/<name>/SKILL.md and
    // prepend the combined content before the description so the assembled prompt carries them.
    let entryForExec = entry;
    if (entry.skills && entry.skills.length > 0) {
      const skillContent = await loadSkillContent(entry.skills, skillsDir, log);
      if (skillContent) {
        entryForExec = { ...entry, description: `${skillContent}\n\n---\n\n${entry.description}` };
        log(`prompt ${index} '${entry.id}': prepended ${entry.skills.length} skill(s) (${entry.skills.join(', ')})`);
      }
    }

    // Dry run: assemble + predict for cost/plan visibility, but execute nothing.
    if (dryRun) {
      const outcome = await runWithBuildContext({ promptId: entry.id }, () =>
        dryRunPrompt(ctx, entryForExec, index, previousSentinel)
      );
      outcomes.push(outcome);
      completedIds.add(entry.id); // a dry run does not block downstream planning
      continue;
    }

    const outcome = await runWithBuildContext({ promptId: entry.id }, () =>
      executePrompt(ctx, entryForExec, index, previousSentinel, schemaPromptsHaveRun)
    );
    outcomes.push(outcome);
    const realTechStackTags = deriveStackTags(ctx.stackFingerprint);
    const changedThisPrompt = filesChanged(ctx);
    onPromptComplete({
      promptId: entry.id,
      success: outcome.disposition === 'completed',
      retryCount: outcome.recovery?.attempted ? 1 : 0,
      tokensConsumed: outcome.tokensEstimated,
      gatePassRate: outcome.sentinel?.passed ? 1.0 : 0.0,
      errorOutput: outcome.sentinel?.diagnosticReport ?? undefined,
      buildId: buildRunId ?? '',
      projectName,
      taskType: mapPromptTypeToTaskType(entry.prompt_type),
      techStackTags: realTechStackTags.length > 0 ? realTechStackTags : ['typescript'],
      templateHash: outcome.promptHash,
    });

    // BuildBrainEvolver (LEARNING_BLUEPRINT.md Â§ Agent: BuildBrainEvolver) â€” post-Sentinel
    // rewrite-effectiveness observation, per Phase 3 prompt (Contract 1: Phase 4 runs after
    // EVERY Phase 3 prompt). Guarded â€” Build Memory unreachable degrades to a no-op; a
    // skipped/dry-run outcome never reaches here (both `continue` earlier in the loop), so
    // `outcome.sentinel` is always populated for a real execution.
    try {
      const memoryClient = BuildMemory.getClient();
      if (memoryClient && outcome.sentinel) {
        observeRewriteOutcome(entry.id, outcome.wasRewritten, outcome.sentinel.passed, memoryClient);
      }
    } catch { /* non-fatal â€” Contract 4 */ }

    // Learning Engine: PostToolUse hook
    try {
      const { handlePostToolUse } = await import('../learning/hooks-enhanced.js');
      await handlePostToolUse({
        buildId: buildRunId ?? '',
        promptId: entry.id,
        taskType: mapPromptTypeToTaskType(entry.prompt_type),
        techStackTags: realTechStackTags.length > 0 ? realTechStackTags : ['typescript', 'nextjs'],
        firstPassSuccess: outcome.disposition === 'completed',
        retryCount: outcome.recovery?.attempted ? 1 : 0,
        tokensConsumed: outcome.tokensEstimated,
        gatPassRate: outcome.disposition === 'completed' ? 1 : 0,
        errorOutput: outcome.sentinel?.diagnosticReport ?? '',
        filesModified: [...changedThisPrompt.created, ...changedThisPrompt.modified],
        projectName,
      });
    } catch { /* non-fatal */ }

    const completedSoFar = outcomes.filter((o) => o.disposition === 'completed').length;
    const failedSoFar = outcomes.filter((o) => o.disposition === 'failed').length;
    const totalElapsedMs = outcomes.reduce((sum, o) => sum + o.durationMs, 0);
    log(
      `prompt ${index} '${entry.id}': ${humanDuration(outcome.durationMs)} this prompt, ` +
        `${humanDuration(totalElapsedMs)} build total so far.`
    );
    await ctx.liveStatus.totals({
      completed: completedSoFar,
      failed: failedSoFar,
      remaining: Math.max(0, schedule.order.length - outcomes.length),
      tokensEstimated: outcomes.reduce((sum, o) => sum + o.tokensEstimated, 0),
      costEstimatedUsd: ctx.costTracker.totalCostUsd(),
      totalElapsedMs,
    });

    if (entry.prompt_type === 'schema') schemaPromptsHaveRun = true;

    // Carry this prompt's Sentinel status into the next prompt (Contract 13).
    if (outcome.sentinel) {
      previousSentinel = toPreviousSentinelStatus(outcome.sentinel, entry.name, index);
    }

    if (outcome.disposition === 'completed') {
      completedIds.add(entry.id);
    } else if (outcome.disposition === 'failed') {
      // h/j: Sentinel failed and recovery did not restore green â†’ HALT (Contract 13).
      halted = true;
      haltedAt = { index, id: entry.id };
      haltReason =
        outcome.recovery?.reason ??
        `Sentinel failed at prompt ${index} '${entry.id}' (${outcome.sentinel?.failedCheck ?? 'unknown'}) ` +
          'and was not auto-recovered.';
      // Integration Bus (System 4): recovery is exhausted â€” fan this failure out to System 1
      // (targeted gap audit), System 2 (rewrite-effectiveness observation), and System 3
      // (baseline test run). Non-fatal â€” bus.ts never throws, but wrapped defensively anyway.
      try {
        await onSentinelFailure(outcome.sentinel?.failedCheck ?? 'unknown', entry.id, buildRunId ?? '', projectPath);
      } catch (error) {
        log(`integration bus onSentinelFailure failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await rollbackAndReport(ctx, entry, index, outcome, haltReason);
      break;
    }
  }

  // 4. Finalize the build_run.
  const completedPrompts = outcomes.filter((o) => o.disposition === 'completed').length;
  const failedPrompts = outcomes.filter((o) => o.disposition === 'failed').length;
  const skippedPrompts = outcomes.filter((o) => o.disposition === 'skipped').length;
  const totalTokens = outcomes.reduce((sum, o) => sum + o.tokensEstimated, 0);

  const status: Phase3Status = dryRun ? 'dry_run' : halted ? 'halted' : failedPrompts > 0 ? 'failed' : 'completed';

  if (buildRunId !== null && !dryRun) {
    try {
      await updateBuild(buildRunId, {
        status: status === 'completed' ? 'completed' : status === 'halted' ? 'halted' : 'failed',
        completed_at: nowIso(),
        completed_prompts: completedPrompts,
        failed_prompts: failedPrompts,
        total_tokens: totalTokens,
        sentinel_interventions: outcomes.filter((o) => o.recovery?.attempted).length,
      });
    } catch (error) {
      log(`WARNING: final updateBuild degraded (${describe(error)})`);
    }

    await recordBuildCompletionInsights({
      projectName,
      buildRunId,
      stackFingerprint: options.stackFingerprint ?? null,
      outcomes,
      elevatedRuleIds: ctx.elevatedRuleIds,
      log,
    });
  }

  await onRunEnd(buildRunId ?? '', projectPath, {
    promptsExecuted: completedPrompts + failedPrompts + skippedPrompts,
    promptsPassed: completedPrompts,
    promptsFailed: failedPrompts,
    totalTokens,
    startTime: generatedAt,
  }).catch(() => {});

  // 5. Dry Run Mode (F11): assemble the simulation report from the per-prompt dry-run pass + the
  //    cost-estimator. Only on a dry run â€” a real build executed and needs no simulation.
  // handleSessionEnd fires in the finally block below so it always runs.
  try {
  let simulation: SimulationReport | null = null;
  if (dryRun) {
    simulation = await buildSimulationReport({
      projectName,
      schedule,
      outcomes,
      features: options.features,
      stackFingerprint: options.stackFingerprint ?? null,
      estimateCostImpl,
      generatedAt,
      log,
    });
  }

  const replayOf: ReplayLinkage | null = replay
    ? {
        originalBuildRunId: replay.originalBuildRunId,
        fromCheckpointTag: replay.fromCheckpointTag,
        fromPromptIndex: replay.fromPromptIndex,
      }
    : null;

  log(
    `Phase 3 ${status.toUpperCase()} â€” ${completedPrompts} completed, ${failedPrompts} failed, ` +
      `${skippedPrompts} skipped of ${schedule.order.length}; ~${totalTokens} tokens.` +
      (halted ? ` HALTED at prompt ${haltedAt?.index} '${haltedAt?.id}'.` : '') +
      (simulation
        ? ` Simulation: ~$${simulation.predictedCostUsd?.estimate ?? '?'}, ` +
          `~${simulation.predictedTimeMs?.human ?? '?'}, ~${simulation.expectedFailureCount} predicted failure(s).`
        : '')
  );

  if (!dryRun) {
    renderProgress(
      status === 'completed' ? 'PASS' : status === 'halted' ? 'FAIL' : status === 'failed' ? 'FAIL' : 'WARN',
      `Phase 3 ${status.toUpperCase()} â€” ${completedPrompts}/${schedule.order.length} completed, ` +
        `${failedPrompts} failed, ${skippedPrompts} skipped; ~${totalTokens} tokens.` +
        (halted ? ` HALTED at prompt ${haltedAt?.index} '${haltedAt?.id}'.` : '')
    );
  }

  if (!dryRun && costTracker.entries.length > 0) {
    const costSummary = costTracker.summary();
    log(
      `Model cost estimate: $${costSummary.totalCostUsd.toFixed(4)} across ${costSummary.totalPrompts} prompt(s) ` +
        `(${costSummary.byModel.map((r) => `${r.model}: ${r.prompts} prompts $${r.costUsd.toFixed(4)}`).join(', ')})`
    );
  }

  // Build finished â€” drop the ambient build/prompt context so a later build (or a test running
  // multiple builds in one process) starts clean.
  clearLogContext();

  return {
    projectName,
    buildRunId,
    status,
    schedule,
    outcomes,
    completedPrompts,
    failedPrompts,
    skippedPrompts,
    totalTokens,
    haltedAt,
    haltReason,
    replayOf,
    simulation,
    warnings,
    generatedAt,
  };
  } finally {
    // Learning Engine: SessionEnd â€” always fires (including on unexpected throw).
    try {
      const { handleSessionEnd } = await import('../learning/session-hooks.js');
      await handleSessionEnd({
        buildId: buildRunId ?? machineId,
        projectPath,
        projectName,
        promptsExecuted: completedPrompts + failedPrompts + skippedPrompts,
        promptsPassed: completedPrompts,
        promptsFailed: failedPrompts,
        endReason: halted ? 'FAILED' : 'COMPLETED',
        startTime: new Date(generatedAt),
      });
    } catch { /* non-fatal */ }

    // Build finished (normally or via a caught error) â€” release the run lock and stop
    // attributing process-level deaths to this build; the NEXT build re-installs its own state.
    if (!dryRun) {
      releaseRunLock(projectPath);
      clearDeathForensicsState();
    }

    // Restore stdout LAST â€” handleSessionEnd (above) still has more [SESSION]/[FORGE Learning]
    // console output to emit, and it must land in the log file too, not on stdout.
    releaseStdoutQuietMode();
  }
}

// ---------------------------------------------------------------------------
// Per-prompt execution
// ---------------------------------------------------------------------------

/** Shared, immutable context threaded into the per-prompt helpers. */
interface LoopContext {
  projectPath: string;
  projectName: string;
  governanceDirName: string;
  /** Total scheduled prompts (`schedule.order.length`) â€” the "N" in CHANGESET.md's "prompt i/N". */
  totalPrompts: number;
  buildRunId: string | null;
  machineId: string;
  stackFingerprint: StackFingerprint | null;
  autonomousRecoveryMode: boolean;
  dryRun: boolean;
  governanceDocs: Record<string, string>;
  git: GitManager;
  /** The configured main branch (Contract 10) â€” Claude must NEVER run while checked out on this. */
  mainBranch: string;
  runClaudeImpl: (prompt: string, cwd: string, timeoutMs?: number) => Promise<ClaudeRunResult>;
  /** Per-prompt-type timeout budget (ms) â€” `test`/`deploy` get the long budget (Session 5 finding #14). */
  timeoutBudgetMsFor: (promptType: PromptType) => number;
  predictImpl: (input: {
    promptType: PromptType;
    stackFingerprint?: StackFingerprint | null;
    promptIndex?: number;
  }) => Promise<FailurePrediction>;
  assembleImpl: (input: {
    entry: QueueEntry;
    governanceDocs: Record<string, string>;
    stackFingerprint?: StackFingerprint | null;
    previousSentinel?: PreviousSentinelStatus | null;
    relevantFilesBlock?: string;
    projectPath?: string;
  }) => Promise<AssembledPrompt>;
  /** The Codebase RAG index (Contract 7 extension), or null in a dry run / when degraded. */
  rag: CodebaseRag | null;
  rewriteImpl: (input: {
    prompt: string;
    promptType: PromptType;
    matchingPatterns?: FailurePrediction['matchingPatterns'];
    probability?: number;
    stackFingerprint?: StackFingerprint | null;
  }) => Promise<{ rewrittenPrompt: string; reason: string; originalHash: string; rewrittenHash: string }>;
  runSentinelImpl: (options: SentinelOptions) => Promise<SentinelResult>;
  runRecoveryImpl: (
    failed: SentinelResult,
    rerunPrompt: RerunPromptFn,
    sentinelOptions: SentinelOptions,
    promptExecutionId: string | null
  ) => Promise<AutoRecoveryResult>;
  /** Decompose + sequentially execute a >threshold prompt's atomic sub-prompts (Sentinel between each). */
  runDecomposedPrompt: (
    parent: DecompositionParent,
    assembledPrompt: string,
    deps: DecompositionDeps
  ) => Promise<DecompositionResult>;
  /** Persist a decomposition record to Build Memory (pattern learning); no-op in stateless mode. */
  recordDecomposition: (record: DecompositionRecord) => Promise<void>;
  createPromptExecution: (input: Parameters<typeof BuildMemory.prompts.createPromptExecution>[0]) => Promise<{ id: string } | null>;
  updatePromptExecution: (
    id: string,
    patch: Parameters<typeof BuildMemory.prompts.updatePromptExecution>[1]
  ) => Promise<unknown>;
  updateStateProgress: (line: string) => Promise<void>;
  writeHaltReport: (report: string) => Promise<void>;
  /**
   * Normalized failure signatures Build Brain has already tried (and failed) to recover this
   * build â€” shared/mutated across prompts so `analyzeSentinelFailure` never proposes the same
   * broken fix twice in one run (Task 2's "escalate when the same fix already failed this build").
   */
  failedSignaturesThisBuild: Set<string>;
  /** Count of Build Brain interventions attempted this build (live-status / health reporting). */
  brainInterventions: { count: number };
  /** governance_rules ids auto-elevated during this build (Task 1.3's build-completion insight). */
  elevatedRuleIds: Set<string>;
  /** Live build-status writer (Task 3 â€” Session 4). Always present; a disk failure just no-ops. */
  liveStatus: LiveStatusWriter;
  log: (message: string) => void;
  /** Hook manager for pre_prompt / post_prompt lifecycle events. */
  hookManager: HookManager;
  /** Learned instinct rules applied to each prompt before execution. */
  instincts: Instinct[];
  /** Accumulates per-prompt model cost estimates across the build. */
  costTracker: ModelCostTracker;
}

/** Build the Sentinel options for this build (shared by the main run + recovery re-runs). */
function sentinelOptionsFor(
  ctx: LoopContext,
  schemaPromptsHaveRun: boolean,
  promptType: PromptType
): SentinelOptions {
  return {
    projectPath: ctx.projectPath,
    governanceDirName: ctx.governanceDirName,
    schemaPromptsHaveRun,
    promptType,
  };
}

/**
 * Execute one prompt through the full s5-p05 loop (steps bâ€“j) and return its {@link PromptOutcome}.
 * Wrapped so an unexpected error in any collaborator never aborts the build (Iron Law 3).
 */
async function executePrompt(
  ctx: LoopContext,
  entry: QueueEntry,
  index: number,
  previousSentinel: PreviousSentinelStatus | null,
  schemaPromptsHaveRun: boolean
): Promise<PromptOutcome> {
  const { log } = ctx;
  // Session 5 finding #12/#7: per-prompt elapsed duration, for console/live-status/prompt_executions.
  const promptStartedAt = Date.now();
  log(`prompt ${index} '${entry.id}' (${entry.prompt_type}) â€” start`);
  renderProgress('INFO', `PROMPT ${index}/${ctx.totalPrompts} : ${entry.id}`);
  await ctx.liveStatus.promptPhase({ index, id: entry.id, name: entry.name, type: entry.prompt_type, phase: 'start' });

  try {
    // b. Failure prediction (Contract 8).
    const prediction = await ctx.predictImpl({
      promptType: entry.prompt_type,
      stackFingerprint: ctx.stackFingerprint,
      promptIndex: index,
    });

    // b1. PRE-PROMPT HOOK â€” fire before assembly so hooks can gate or annotate the prompt.
    // A 'deny' result skips the prompt (non-fatal: build continues to the next entry).
    const preHookResults = await ctx.hookManager
      .fireEvent('pre_prompt', {
        projectPath: ctx.projectPath,
        promptId: entry.id,
        promptIndex: index,
        promptType: entry.prompt_type,
        buildRunId: ctx.buildRunId,
      })
      .catch(() => [{ action: 'allow' as const }]);
    if (preHookResults[0]?.action === 'deny') {
      const denyReason = preHookResults[0]?.reason ?? 'no reason given';
      log(`prompt ${index} '${entry.id}': pre_prompt hook denied â€” ${denyReason}; skipping`);
      return skippedOutcome(entry, index, `pre_prompt hook denied: ${denyReason}`);
    }

    // c0. Codebase RAG (Contract 7 extension): retrieve the 10 existing files most relevant to this
    //     task and render them as an injectable block, so the assembled prompt tells Claude what
    //     already exists (avoids duplicate/conflicting code). Empty when nothing is relevant or the
    //     index degraded â€” the assembler then injects nothing.
    const relevantFilesBlock = ctx.rag ? ctx.rag.contextBlock(entry.description).block : '';

    // c/d. Assemble (Contract 7), then rewrite if the predictor flags high risk (Contract 9).
    // `projectPath` (Session 5.2 Task 3 â€” project-boundary guard) states the absolute root so the
    // assembled prompt tells claude explicitly where all file operations must stay confined.
    const assembled = await ctx.assembleImpl({
      entry,
      governanceDocs: ctx.governanceDocs,
      stackFingerprint: ctx.stackFingerprint,
      previousSentinel,
      relevantFilesBlock,
      projectPath: ctx.projectPath,
    });
    await ctx.liveStatus.promptPhase({ index, id: entry.id, name: entry.name, type: entry.prompt_type, phase: 'assembled' });
    let promptText = assembled.prompt;
    let promptHash = assembled.hash;
    let wasRewritten = false;
    let originalHash: string | null = null;
    let rewriteReason: string | null = null;
    if (prediction.shouldRewrite) {
      const rewrite = await ctx.rewriteImpl({
        prompt: assembled.prompt,
        promptType: entry.prompt_type,
        matchingPatterns: prediction.matchingPatterns,
        probability: prediction.probability,
        stackFingerprint: ctx.stackFingerprint,
      });
      promptText = rewrite.rewrittenPrompt;
      promptHash = rewrite.rewrittenHash;
      originalHash = rewrite.originalHash;
      rewriteReason = rewrite.reason;
      wasRewritten = true;
      log(`prompt ${index} '${entry.id}': rewritten (p=${prediction.probability.toFixed(3)} > 0.4)`);
    }

    // b2. APPLY INSTINCTS â€” augment the (possibly rewritten) prompt with learned fix rules.
    // Relevant instincts (confidence â‰¥ 0.5, keyword overlap â‰¥ 2) are appended as a block.
    if (ctx.instincts.length > 0) {
      const augmented = applyInstincts(promptText, ctx.instincts);
      if (augmented !== promptText) {
        log(`prompt ${index} '${entry.id}': instincts applied (+${augmented.length - promptText.length} chars)`);
        promptText = augmented;
      }
    }

    // b3. MODEL ROUTING â€” classify prompt complexity, select the optimal Claude model,
    // and record the estimated cost for this prompt (telemetry; never blocks execution).
    const modelSelection = selectModelForEntry(entry);
    const complexity = classifyPromptComplexity(promptText);
    const selectedModel = routeToModel(complexity);
    const promptCostEstimate = estimateCost(promptText, selectedModel);
    ctx.costTracker.record({
      selection: modelSelection,
      inputTokens: promptCostEstimate.inputTokens,
      outputTokens: promptCostEstimate.outputTokens,
      promptName: entry.name,
      promptIndex: index,
    });
    log(
      `prompt ${index} '${entry.id}': model=${selectedModel} tier=${modelSelection.tier} ` +
        `complexity=${complexity} ~$${promptCostEstimate.costUsd.toFixed(4)}`
    );

    // e. Create the Contract-10 feature branch. This is a hard requirement, not best-effort:
    // Claude must NEVER run against `main` directly, so a failed checkout (or one that silently
    // leaves HEAD on main) aborts this prompt immediately rather than "continuing on current branch".
    const branch = ctx.git.createBranch(buildIdOf(ctx), index, entry.name);
    const branchName = branch.branchName;
    if (!branch.success) {
      throw new Error(
        `feature branch creation failed â€” aborting prompt: git checkout -b ${branchName} failed ` +
          `(${branch.error ?? 'unknown error'})`
      );
    }
    // Verify the checkout actually landed on the feature branch â€” a `success: true` result with
    // exit 0 does not, by itself, prove HEAD moved off main (e.g. a branch that already existed).
    const currentBranch = ctx.git.getCurrentBranch();
    if (!currentBranch.success || currentBranch.branch === null) {
      throw new Error(
        `feature branch creation failed â€” aborting prompt: could not verify current branch after ` +
          `checkout (${currentBranch.error ?? 'unknown error'})`
      );
    }
    if (currentBranch.branch === ctx.mainBranch) {
      throw new Error(
        `feature branch creation failed â€” aborting prompt: still on '${ctx.mainBranch}' after ` +
          `checkout -b ${branchName} â€” refusing to run claude on ${ctx.mainBranch}`
      );
    }

    // g. Log the prompt_execution (status running). Done BEFORE Sentinel so recovery can annotate it.
    const promptExecutionId = await logPromptExecution(ctx, {
      entry,
      index,
      promptHash,
      promptText,
      branchName,
      wasRewritten,
      originalHash,
      rewriteReason,
      failureProbability: prediction.probability,
    });

    // The Sentinel options are built first because a DECOMPOSED prompt runs the Sentinel BETWEEN its
    // atomic sub-steps â€” the same options drive those inter-step checks and the final gate.
    const sentinelOptions = sentinelOptionsFor(
      ctx,
      schemaPromptsHaveRun || entry.prompt_type === 'schema',
      entry.prompt_type
    );

    // f. Execute via the claude-runner, then commit the work to the feature branch.
    //
    // f0. Prompt decomposition: when this prompt's description exceeds DECOMPOSITION_THRESHOLD, it is
    //     split into atomic sub-prompts (one table / component / route each) that execute SEQUENTIALLY
    //     with a Sentinel check between each; a failing sub-step retries IN ISOLATION rather than
    //     re-running the whole prompt. The decomposer commits each sub-step, returns an aggregate run
    //     + the final Sentinel result, and records the decomposition shape to Build Memory (pattern
    //     learning) â€” so the rest of this loop (final Sentinel gate, merge, record) is UNCHANGED. A
    //     description that does not split runs exactly as a single prompt (the decomposer is a no-op).
    let run: ClaudeRunResult;
    let sentinel: SentinelResult;
    let decomposition: DecompositionResult | null = null;
    // Session 5 finding #14: per-prompt-type timeout budget (test/deploy get the long budget).
    const timeoutMs = ctx.timeoutBudgetMsFor(entry.prompt_type);
    await ctx.liveStatus.promptPhase({ index, id: entry.id, name: entry.name, type: entry.prompt_type, phase: 'executing' });
    if (shouldDecompose(entry.description)) {
      decomposition = await ctx.runDecomposedPrompt(
        { id: entry.id, name: entry.name, promptType: entry.prompt_type, index, description: entry.description },
        promptText,
        {
          runClaude: async (p) => {
            renderProgress('INFO', `Claude exec start â€” timeout ${Math.round(timeoutMs / 1000)}s`);
            const execStartedAt = Date.now();
            const r = await ctx.runClaudeImpl(p, ctx.projectPath, timeoutMs);
            renderProgress(
              'INFO',
              `Claude exit ${r.exitCode ?? 'null'}${r.timedOut ? ' (TIMEOUT)' : ''} â€” ${((Date.now() - execStartedAt) / 1000).toFixed(1)}s`
            );
            return r;
          },
          runSentinel: () => ctx.runSentinelImpl(sentinelOptions),
          commit: (message) => {
            const c = ctx.git.commitAll(message);
            if (!c.success) log(`prompt ${index} '${entry.id}': sub-step commit failed â€” ${c.error ?? 'unknown'}`);
          },
          recordDecomposition: (record) => ctx.recordDecomposition(record),
          log,
        }
      );
      run = decomposition.aggregateRun;
      // VS Code integration layer: record this prompt's changeset before the gating Sentinel below.
      await appendChangeset(ctx, entry, index, filesChanged(ctx));
      // Reuse the decomposer's between-sub-steps Sentinel as THIS prompt's gate (avoids a redundant
      // whole-prompt re-run); fall back only if it executed nothing (never, for a >threshold prompt).
      sentinel = decomposition.finalSentinel ?? (await ctx.runSentinelImpl(sentinelOptions));
      if (!run.success) {
        log(`prompt ${index} '${entry.id}': decomposed run not green â€” ${decomposition.note}`);
      }
    } else {
      // Hard enforcement (not just verification): force HEAD onto the feature branch immediately
      // before handing control to claude, regardless of what branch is currently checked out.
      const preRunCheckout = ctx.git.checkout(branchName);
      if (!preRunCheckout.success) {
        throw new Error(
          `feature branch creation failed â€” aborting prompt: git checkout ${branchName} before claude ` +
            `run failed (${preRunCheckout.error ?? 'unknown error'})`
        );
      }
      renderProgress('INFO', `Claude exec start â€” timeout ${Math.round(timeoutMs / 1000)}s`);
      const execStartedAt = Date.now();
      run = await ctx.runClaudeImpl(promptText, ctx.projectPath, timeoutMs);
      renderProgress(
        'INFO',
        `Claude exit ${run.exitCode ?? 'null'}${run.timedOut ? ' (TIMEOUT)' : ''} â€” ${((Date.now() - execStartedAt) / 1000).toFixed(1)}s`
      );
      // Hard enforcement: force HEAD back onto the feature branch immediately after claude returns â€”
      // this catches any case where claude drifted HEAD back to main (e.g. a stray `git checkout main`)
      // before Sentinel runs, rather than merely detecting the drift.
      const postRunCheckout = ctx.git.checkout(branchName);
      if (!postRunCheckout.success) {
        throw new Error(
          `feature branch creation failed â€” aborting prompt: git checkout ${branchName} after claude ` +
            `run failed (${postRunCheckout.error ?? 'unknown error'})`
        );
      }
      // Verify claude's run didn't leave HEAD on main (e.g. via a stray `git checkout main`) before
      // committing â€” commitAll operates on whatever branch is currently checked out, so a drift back
      // to main here would otherwise land a direct commit on main in violation of Contract 10.
      const branchBeforeCommit = ctx.git.getCurrentBranch();
      if (!branchBeforeCommit.success || branchBeforeCommit.branch === null) {
        throw new Error(
          `feature branch creation failed â€” aborting prompt: could not verify current branch before ` +
            `commit (${branchBeforeCommit.error ?? 'unknown error'})`
        );
      }
      if (branchBeforeCommit.branch === ctx.mainBranch) {
        throw new Error(
          `feature branch creation failed â€” aborting prompt: HEAD drifted back to '${ctx.mainBranch}' ` +
            `before commit â€” refusing to commit claude's work directly to ${ctx.mainBranch}`
        );
      }
      // FORGE owns git add + commit after claude exits â€” claude never needs to commit anything
      // itself. `commitAll` runs `git add -A` then `git commit`; a clean tree (nothing staged) is
      // reported as `nothingToCommit: true` with `success: true`, so that case is skipped silently
      // rather than logged as a failure.
      const commit = ctx.git.commitAll(entry.name);
      if (!commit.success) {
        log(`prompt ${index} '${entry.id}': commit failed â€” ${commit.error ?? 'unknown'}`);
      }
      if (!run.success) {
        log(`prompt ${index} '${entry.id}': claude exited ${run.exitCode ?? 'null'}${run.timedOut ? ' (TIMEOUT)' : ''}`);
      }

      // VS Code integration layer: record this prompt's changeset before Sentinel runs.
      await appendChangeset(ctx, entry, index, filesChanged(ctx));

      // h. Run the Phase 4 Sentinel (the five Contract-13 checks).
      sentinel = await ctx.runSentinelImpl(sentinelOptions);
    }

    renderProgress('GATE', `Sentinel â€” ${sentinel.checks.length} check(s)`);
    for (const check of sentinel.checks) {
      const verdict = check.skipped ? 'SKIP' : check.passed ? 'PASS' : 'FAIL';
      renderProgress(
        check.skipped ? 'WARN' : check.passed ? 'PASS' : 'FAIL',
        `  ${check.name} â€” ${verdict}${verdict === 'FAIL' ? ` (${check.detail})` : ''}`
      );
    }

    // Session 5.2 Task 3: project-boundary guard â€” best-effort scan of claude's own stdout for
    // absolute paths outside the project root. A violation forces this run to read as failed,
    // which then cascades through forceFailOnClaudeFailure below exactly like any other failure.
    const outOfBounds = findOutOfBoundsPaths(run.stdout, ctx.projectPath);
    if (outOfBounds.length > 0) {
      log(
        `prompt ${index} '${entry.id}': PROJECT-BOUNDARY VIOLATION â€” claude's output references ` +
          `path(s) outside the project root (${ctx.projectPath}): ${outOfBounds.slice(0, 5).join(', ')}` +
          `${outOfBounds.length > 5 ? ` (+${outOfBounds.length - 5} more)` : ''}`
      );
      run = { ...run, success: false };
    }

    // Session 5 finding #14: a claude TIMEOUT is a failure regardless of what Sentinel finds â€”
    // Sentinel only proves the code that exists doesn't obviously break, not that the prompt's
    // work actually happened. A "silent" timeout (Sentinel reports PASS on a timed-out run) is
    // overridden to a failure so every downstream reader (live status, Build Brain, the learning
    // write-loop, the merge/recovery decision, the returned PromptOutcome) sees one consistent,
    // honest outcome instead of a misleading green.
    if (run.timedOut) sentinel = forceFailOnTimeout(sentinel, timeoutMs, entry, log, index);
    // Session 5.2: any other claude failure (bad exit code, spawn error, empty stdout, or the
    // project-boundary violation above) must ALSO force a passing Sentinel to read as a failure â€”
    // never let a prompt whose own execution didn't succeed merge on the back of a Sentinel PASS.
    sentinel = forceFailOnClaudeFailure(sentinel, run, entry, log, index);

    // One automatic retry at 2x the budget before failing outright (autonomous recovery only) â€”
    // a single timeout is often just an undersized budget for THIS prompt, not a real defect.
    if (run.timedOut && ctx.autonomousRecoveryMode) {
      const retryTimeoutMs = timeoutMs * 2;
      log(
        `prompt ${index} '${entry.id}': claude TIMEOUT â€” retrying once with 2x budget ` +
          `(${Math.round(retryTimeoutMs / 1000)}s) before failing (Session 5 finding #14)`
      );
      await ctx.liveStatus.promptPhase(
        { index, id: entry.id, name: entry.name, type: entry.prompt_type, phase: 'recovering' },
        `Timeout retry: re-running with 2x budget (${Math.round(retryTimeoutMs / 1000)}s)`
      );
      const retryRun = await ctx.runClaudeImpl(promptText, ctx.projectPath, retryTimeoutMs);
      const retryCommit = ctx.git.commitAll(
        `[FORGE] timeout-retry ${entry.prompt_type}: ${entry.name}\n\nPrompt ${index} (${entry.id}) re-run with 2x timeout budget.`
      );
      if (!retryCommit.success) {
        log(`prompt ${index} '${entry.id}': timeout-retry commit failed â€” ${retryCommit.error ?? 'unknown'}`);
      }
      let retrySentinel = await ctx.runSentinelImpl(sentinelOptions);
      if (retryRun.timedOut) retrySentinel = forceFailOnTimeout(retrySentinel, retryTimeoutMs, entry, log, index);
      retrySentinel = forceFailOnClaudeFailure(retrySentinel, retryRun, entry, log, index);
      run = retryRun;
      sentinel = retrySentinel;
      log(
        `prompt ${index} '${entry.id}': timeout retry ` +
          `${sentinel.passed ? 'succeeded â€” Sentinel green' : `still failing (${retryRun.timedOut ? 'timed out again' : sentinel.failedCheck ?? 'unknown'})`}.`
      );
    }

    await ctx.liveStatus.promptPhase({ index, id: entry.id, name: entry.name, type: entry.prompt_type, phase: 'sentinel' });
    await ctx.liveStatus.sentinelResult({ passed: sentinel.passed, failedCheck: sentinel.failedCheck });

    // e1. POST-PROMPT HOOK â€” fire after execution, before Sentinel. Non-fatal.
    await ctx.hookManager
      .fireEvent('post_prompt', {
        projectPath: ctx.projectPath,
        promptId: entry.id,
        promptIndex: index,
        promptType: entry.prompt_type,
        buildRunId: ctx.buildRunId,
        exitCode: run.exitCode ?? null,
        timedOut: run.timedOut ?? false,
      })
      .catch(() => {});

    // e2. COMMIT PROMPT CHANGES â€” structured commit tracking this prompt's output.
    // Non-fatal: if nothing was staged (prior commitAll already committed), this is a no-op.
    let commitHash: string | null = null;
    try {
      commitHash = await ctx.git.commitPromptChanges(entry.id, entry.prompt_type, 'post-run');
    } catch (commitErr) {
      log(`prompt ${index} '${entry.id}': commitPromptChanges non-fatal â€” ${describe(commitErr)}`);
    }

    // Capture the files this branch changed (for the prompt_execution record).
    const changed = filesChanged(ctx);

    // h1. BUILD BRAIN â€” when Sentinel fails, seed/update the learning tables (Task 1's write
    // loop â€” every failure is a signal, matched or not) then consult accumulated knowledge
    // (error_patterns, resolutions, fix_patterns, governance_rules) for a TARGETED recovery
    // prompt, rather than a generic retry. A successful brain fix is applied immediately and
    // does NOT count against autonomous-recovery's max_retries. Non-fatal throughout â€” Build
    // Brain unavailable/erroring falls back to the existing autonomous-recovery / escalation path.
    // `sentinel.passed` already reflects the finding-#14 timeout override above, so a plain
    // `!sentinel.passed` correctly covers both a genuine Sentinel failure and a silent timeout.
    const wasFailingInitially = !sentinel.passed;
    const initialErrorText = sentinel.diagnosticReport;
    const initialFailedCheck = sentinel.failedCheck;
    let brainDiagnosis: BrainDiagnosis | null = null;

    if (wasFailingInitially) {
      await recordFailureObserved({
        errorText: initialErrorText,
        failedCheck: initialFailedCheck,
        promptType: entry.prompt_type,
        projectName: ctx.projectName,
        stackFingerprint: ctx.stackFingerprint,
      }).catch((err) => log(`prompt ${index} '${entry.id}': recordFailureObserved non-fatal â€” ${describe(err)}`));

      try {
        brainDiagnosis = await analyzeSentinelFailure(sentinel, entry, {
          stackFingerprint: ctx.stackFingerprint,
          buildRunId: ctx.buildRunId,
          promptIndex: index,
          priorFailedSignaturesThisBuild: [...ctx.failedSignaturesThisBuild],
        });
      } catch (brainErr) {
        log(`prompt ${index} '${entry.id}': Build Brain unavailable â€” ${describe(brainErr)}`);
        brainDiagnosis = null;
      }

      if (brainDiagnosis && !brainDiagnosis.escalate && brainDiagnosis.knownFix) {
        ctx.brainInterventions.count += 1;
        await ctx.liveStatus.promptPhase(
          { index, id: entry.id, name: entry.name, type: entry.prompt_type, phase: 'recovering' },
          `Build Brain: applying targeted fix (confidence ${brainDiagnosis.confidence.toFixed(2)})`
        );
        await ctx.liveStatus.brainIntervention(
          `prompt ${index} '${entry.id}': Build Brain targeted recovery (confidence ${brainDiagnosis.confidence.toFixed(2)})`
        );
        log(
          `prompt ${index} '${entry.id}': Build Brain matched a known fix ` +
            `(confidence ${brainDiagnosis.confidence.toFixed(2)}) â€” applying targeted recovery`
        );
        const fixRun = await ctx.runClaudeImpl(brainDiagnosis.recoveryPrompt, ctx.projectPath, timeoutMs);
        let recovered = false;
        if (fixRun.success) {
          ctx.git.commitAll(
            `[FORGE] brain-fix: ${entry.name}\n\nBuild Brain targeted recovery for prompt ${index} (${entry.id}).`
          );
          const fixedSentinel = await ctx.runSentinelImpl(sentinelOptions);
          recovered = fixedSentinel.passed;
          if (recovered) {
            log(`prompt ${index} '${entry.id}': Build Brain fix succeeded â€” sentinel now green`);
            sentinel = fixedSentinel;
          } else {
            log(`prompt ${index} '${entry.id}': Build Brain fix applied but sentinel still failing â€” proceeding to normal recovery`);
          }
        } else {
          log(`prompt ${index} '${entry.id}': Build Brain fix claude run failed â€” proceeding to normal recovery`);
        }
        if (!recovered) ctx.failedSignaturesThisBuild.add(brainDiagnosis.signature);
        await recordRecoveryOutcome({
          errorText: initialErrorText,
          failedCheck: initialFailedCheck,
          promptType: entry.prompt_type,
          projectName: ctx.projectName,
          stackFingerprint: ctx.stackFingerprint,
          recovered,
          fixDescription: brainDiagnosis.knownFix.description,
          fixSteps: brainDiagnosis.knownFix.steps,
          filesModified: filesChanged(ctx).modified,
        })
          .then((r) => {
            if (r.elevatedRuleId) ctx.elevatedRuleIds.add(r.elevatedRuleId);
          })
          .catch((err) => log(`prompt ${index} '${entry.id}': recordRecoveryOutcome non-fatal â€” ${describe(err)}`));
      }
    }

    let recovery: AutoRecoveryResult | null = null;
    let disposition: PromptDisposition;
    let note: string;

    // BULLETPROOF GUARD (unconditional): if the most recently produced Sentinel result already
    // passed, this prompt is done â€” full stop. Recovery (Contract 14) exists ONLY to rescue a
    // FAILING Sentinel; it must be structurally unreachable whenever `sentinel.passed === true`.
    // This check is repeated at every point below where `sentinel` could feed a recovery call, so
    // no future refactor of the branches beneath it can accidentally route a green Sentinel into
    // `runRecoveryImpl`.
    if (sentinel.passed === true) {
      // i. Merge to main + lightweight checkpoint tag (Contracts 10/11).
      mergeAndTag(ctx, index);
      disposition = 'completed';
      note = 'Sentinel passed â€” merged to main and checkpointed.';
    } else if (ctx.autonomousRecoveryMode) {
      // j. Autonomous Recovery (Contract 14): re-run the prompt + Sentinel, up to 2 attempts. Uses
      // Build Brain's targeted recoveryPrompt instead of the identical original prompt when one is
      // available AND hasn't already failed this build (never repeat a fix that just failed).
      await ctx.liveStatus.promptPhase({ index, id: entry.id, name: entry.name, type: entry.prompt_type, phase: 'recovering' });
      const rerunPrompt: RerunPromptFn = async () => {
        const useBrainFix =
          brainDiagnosis !== null &&
          !brainDiagnosis.escalate &&
          !ctx.failedSignaturesThisBuild.has(brainDiagnosis.signature);
        const textToRun = useBrainFix ? (brainDiagnosis as BrainDiagnosis).recoveryPrompt : promptText;
        const r = await ctx.runClaudeImpl(textToRun, ctx.projectPath, timeoutMs);
        ctx.git.commitAll(`[FORGE] recovery ${entry.prompt_type}: ${entry.name}\n\nPrompt ${index} (${entry.id}) re-run.`);
        return { success: r.success, output: `${r.stdout}\n${r.stderr}` };
      };
      // Reaching `runRecoveryImpl` at all already requires the outer guard above to have found
      // `sentinel.passed === false` â€” the type system enforces that (TS proves the reverse check
      // here is unreachable), so this call site can never fire on a green Sentinel.
      recovery = await ctx.runRecoveryImpl(sentinel, rerunPrompt, sentinelOptions, promptExecutionId);
      sentinel = recovery.finalSentinel;
      // Second guard: the disposition is decided from `sentinel.passed` (the actual, current
      // Sentinel verdict recovery just produced), not merely from `recovery.recovered` â€” a passing
      // Sentinel result can never be reported as a failed prompt, regardless of what any other
      // field on the recovery result says.
      if (sentinel.passed === true) {
        mergeAndTag(ctx, index);
        disposition = 'completed';
        note = recovery.recovered
          ? `Auto-recovered: ${recovery.reason}`
          : 'Sentinel passed after recovery â€” merged to main and checkpointed.';
      } else {
        disposition = 'failed';
        note = `Sentinel failed; auto-recovery did not restore green: ${recovery.reason}`;
      }
      if (wasFailingInitially && recovery) {
        await recordRecoveryOutcome({
          errorText: initialErrorText,
          failedCheck: initialFailedCheck,
          promptType: entry.prompt_type,
          projectName: ctx.projectName,
          stackFingerprint: ctx.stackFingerprint,
          recovered: recovery.recovered,
          fixDescription: brainDiagnosis?.knownFix?.description ?? `Autonomous recovery re-run (Contract 14): ${recovery.reason}`,
          fixSteps: brainDiagnosis?.knownFix?.steps ?? [],
          filesModified: filesChanged(ctx).modified,
          resolutionType: 'prompt_rewrite',
        })
          .then((r) => {
            if (r.elevatedRuleId) ctx.elevatedRuleIds.add(r.elevatedRuleId);
          })
          .catch((err) => log(`prompt ${index} '${entry.id}': recordRecoveryOutcome non-fatal â€” ${describe(err)}`));
      }
    } else {
      disposition = 'failed';
      note = `Sentinel failed (${sentinel.failedCheck ?? 'unknown'}) â€” Autonomous Recovery disabled, escalating (Contract 14).`;
    }

    await ctx.liveStatus.promptPhase({
      index,
      id: entry.id,
      name: entry.name,
      type: entry.prompt_type,
      phase: disposition === 'completed' ? 'merged' : 'failed',
    });

    // Finalize the prompt_execution record with the outcome.
    await finalizePromptExecution(ctx, promptExecutionId, {
      disposition,
      sentinel,
      tokens: run.tokensEstimated,
      durationMs: Date.now() - promptStartedAt,
      errorOutput: sentinel.passed ? null : sentinel.diagnosticReport,
      changed,
      recovery,
    });

    // Post-finalization: dead code scan on changed files + every-10th smoke tests.

    // DEAD CODE SCAN â€” scan the whole src tree but report only findings in changed files.
    // Non-fatal: scan failures are logged and do not affect the prompt's disposition.
    const changedPaths = [...changed.created, ...changed.modified];
    if (changedPaths.length > 0) {
      scanDeadCode(ctx.projectPath)
        .then((deadReport) => {
          const changedSet = new Set(changedPaths.map((p) => p.replace(/\\/g, '/')));
          const unusedImports = deadReport.unusedImports.filter((i) => changedSet.has(i.file));
          const unusedVars = deadReport.unusedVariables.filter((v) => changedSet.has(v.file));
          const unusedExports = deadReport.unusedExports.filter((e) => changedSet.has(e.file));
          const total = unusedImports.length + unusedVars.length + unusedExports.length;
          if (total > 0) {
            log(
              `prompt ${index} '${entry.id}': dead-code scan â€” ${total} issue(s) in changed files ` +
                `(imports: ${unusedImports.length}, vars: ${unusedVars.length}, exports: ${unusedExports.length})`
            );
          }
        })
        .catch((scanErr) => {
          log(`prompt ${index} '${entry.id}': dead-code scan non-fatal â€” ${describe(scanErr)}`);
        });
    }

    // SMOKE TESTS every 10th prompt â€” run after completion (regardless of pass/fail for visibility).
    // Uses shouldRunTests frequency guard and runSmokeTests (compile + build + 3 page probes).
    if (shouldRunTests(index)) {
      runSmokeTests(ctx.projectPath)
        .then((smokeResult) => {
          log(
            `prompt ${index} '${entry.id}': smoke tests ${smokeResult.passed ? 'PASS' : 'FAIL'} ` +
              `(${smokeResult.passedFiles}/${smokeResult.totalFiles} checks)`
          );
          if (!smokeResult.passed) {
            const failing = smokeResult.results.filter((r) => !r.passed);
            log(`prompt ${index} '${entry.id}': smoke failures â€” ${failing.map((r) => r.file).join(', ')}`);
            // Session 5 finding #6: smoke-test failures are a learning signal too â€” one
            // error_patterns/fix_patterns row PER failing check, not just Sentinel failures.
            for (const r of failing) {
              recordSmokeTestFailureObserved({
                file: r.file,
                errorText: r.error ?? r.output ?? 'smoke check failed',
                projectName: ctx.projectName,
                stackFingerprint: ctx.stackFingerprint,
              }).catch((err) => log(`prompt ${index} '${entry.id}': recordSmokeTestFailureObserved non-fatal â€” ${describe(err)}`));
            }
          }
        })
        .catch((smokeErr) => {
          log(`prompt ${index} '${entry.id}': smoke tests non-fatal â€” ${describe(smokeErr)}`);
        });
    }

    // Rebuild the Codebase RAG index after a SUCCESSFUL prompt (Contract 7 extension), so the next
    // prompt's retrieval reflects the files this one just wrote/merged. Non-fatal â€” on failure the
    // previous index is kept (CodebaseRag.rebuild never throws).
    if (disposition === 'completed' && ctx.rag) {
      await ctx.rag.rebuild();
    }

    // k. Update STATE_OF_THE_BUILD.md from live progress (Canonical Rule 9).
    const decompSuffix = decomposition?.decomposed
      ? `, decomposed into ${decomposition.subPrompts.length} sub-prompt(s)`
      : '';
    await ctx.updateStateProgress(
      `[FORGE Phase 3] prompt ${index} '${entry.id}' (${entry.prompt_type}): ${disposition.toUpperCase()} â€” ` +
        `Sentinel ${sentinel.passed ? 'PASS' : `FAIL(${sentinel.failedCheck ?? '?'})`}${wasRewritten ? ', rewritten' : ''}${decompSuffix}.`
    );
    if (decomposition?.decomposed) note = `${note} (${decomposition.note})`;

    const durationMs = Date.now() - promptStartedAt;
    log(`prompt ${index} '${entry.id}': ${disposition} â€” ${note} (${humanDuration(durationMs)})`);
    if (disposition === 'completed') {
      renderProgress(
        'PASS',
        `Prompt ${index}/${ctx.totalPrompts} '${entry.name}' â€” PASS` +
          `${commitHash ? ` (${commitHash.slice(0, 7)})` : ''} â€” ${humanDuration(durationMs)}`
      );
    } else {
      renderProgress(
        'FAIL',
        `Prompt ${index}/${ctx.totalPrompts} '${entry.name}' â€” FAIL (${sentinel.failedCheck ?? 'unknown check'}) â€” ${humanDuration(durationMs)}`
      );
    }
    return {
      index,
      id: entry.id,
      name: entry.name,
      promptType: entry.prompt_type,
      disposition,
      branchName,
      failureProbability: prediction.probability,
      wasRewritten,
      timedOut: run.timedOut,
      decomposed: decomposition?.decomposed ?? false,
      promptHash,
      promptExecutionId,
      tokensEstimated: run.tokensEstimated,
      durationMs,
      sentinel,
      recovery,
      note,
    };
  } catch (error) {
    // Defensive: the collaborators never throw, but if one does, fail this prompt (don't crash).
    // Not a claude-runner timeout (the error happened in FORGE's own orchestration) â€” timedOut: false.
    const durationMs = Date.now() - promptStartedAt;
    const note = `Unexpected error executing prompt ${index} '${entry.id}': ${describe(error)}`;
    ctx.log(`ERROR: ${note}`);
    return {
      index,
      id: entry.id,
      name: entry.name,
      promptType: entry.prompt_type,
      disposition: 'failed',
      branchName: null,
      failureProbability: null,
      wasRewritten: false,
      timedOut: false,
      decomposed: false,
      promptHash: '',
      promptExecutionId: null,
      tokensEstimated: 0,
      durationMs,
      sentinel: null,
      recovery: null,
      note,
    };
  }
}

/** Assemble + predict only (no execution) for a dry-run prompt. */
async function dryRunPrompt(
  ctx: LoopContext,
  entry: QueueEntry,
  index: number,
  previousSentinel: PreviousSentinelStatus | null
): Promise<PromptOutcome> {
  let probability: number | null = null;
  let promptHash = '';
  let tokens = entry.estimated_tokens;
  try {
    const prediction = await ctx.predictImpl({
      promptType: entry.prompt_type,
      stackFingerprint: ctx.stackFingerprint,
      promptIndex: index,
    });
    probability = prediction.probability;
    const assembled = await ctx.assembleImpl({
      entry,
      governanceDocs: ctx.governanceDocs,
      stackFingerprint: ctx.stackFingerprint,
      previousSentinel,
    });
    promptHash = assembled.hash;
    // Rough token estimate from the assembled prompt length (â‰ˆ chars / 4), else the queue figure.
    tokens = Math.max(entry.estimated_tokens, Math.ceil(assembled.prompt.length / 4));
  } catch (error) {
    ctx.log(`dry-run prompt ${index} '${entry.id}': ${describe(error)}`);
  }
  return {
    index,
    id: entry.id,
    name: entry.name,
    promptType: entry.prompt_type,
    disposition: 'skipped',
    branchName: null,
    failureProbability: probability,
    wasRewritten: false,
    timedOut: false,
    decomposed: false,
    promptHash,
    promptExecutionId: null,
    tokensEstimated: tokens,
    durationMs: 0,
    sentinel: null,
    recovery: null,
    note: `Dry run â€” assembled + predicted (p=${probability === null ? 'n/a' : probability.toFixed(3)}), not executed.`,
  };
}

/** Every prompt type â€” used to seed the per-type count record. */
const ALL_PROMPT_TYPES: readonly PromptType[] = [
  'schema',
  'auth',
  'api',
  'ui',
  'feature',
  'agent',
  'test',
  'deploy',
];

/**
 * Build the Dry Run Mode simulation report (F11) from the completed dry-run pass + the
 * cost-estimator. The per-prompt plan + per-prompt failure probabilities come from THIS queue's
 * assembled prompts (precise); the dollar/time/failure bands come from `estimateBuildCost` grounded
 * in Build Memory history. When no Phase 1 `features` list is supplied, an approximate scope is
 * derived from the queue's per-type counts (with a warning). Never throws â€” a degraded estimate
 * leaves `costEstimate`/`predictedCostUsd`/`predictedTimeMs` null and records a warning.
 */
async function buildSimulationReport(input: {
  projectName: string;
  schedule: ScheduleAnalysis;
  outcomes: PromptOutcome[];
  features?: Array<FeatureSpec | string>;
  stackFingerprint: StackFingerprint | null;
  estimateCostImpl: (i: CostEstimateInput, o?: CostEstimatorOptions) => Promise<BuildEstimate>;
  generatedAt: string;
  log: (message: string) => void;
}): Promise<SimulationReport> {
  const { projectName, schedule, outcomes, generatedAt, log } = input;
  const warnings: string[] = [];

  // Per-type prompt counts from the scheduled queue.
  const promptsByType = Object.fromEntries(ALL_PROMPT_TYPES.map((t) => [t, 0])) as Record<PromptType, number>;
  for (const e of schedule.order) promptsByType[e.prompt_type] += 1;

  // The predicted prompt plan (in executed order) + the predicted-error subset + aggregates.
  const prompts: SimulationPromptPlan[] = outcomes.map((o) => ({
    index: o.index,
    id: o.id,
    name: o.name,
    promptType: o.promptType,
    promptHash: o.promptHash,
    failureProbability: o.failureProbability,
    tokensEstimated: o.tokensEstimated,
    willRewrite: o.failureProbability !== null && o.failureProbability > REWRITE_THRESHOLD,
  }));
  const predictedErrors = prompts
    .filter((p) => p.willRewrite)
    .map((p) => ({ index: p.index, id: p.id, promptType: p.promptType, probability: p.failureProbability ?? 0 }));
  const expectedFailureCount =
    Math.round(outcomes.reduce((sum, o) => sum + (o.failureProbability ?? 0), 0) * 100) / 100;
  const assembledTokenEstimate = outcomes.reduce((sum, o) => sum + o.tokensEstimated, 0);

  // The cost-estimator's full-build estimate. Prefer the supplied Phase 1 features; else derive an
  // approximate scope from the queue counts so the report is still complete.
  let costInput: CostEstimateInput;
  if (input.features && input.features.length > 0) {
    costInput = { stackFingerprint: input.stackFingerprint, features: input.features };
  } else {
    warnings.push('No Phase 1 feature list supplied â€” cost estimate derived approximately from the queue.');
    costInput = {
      stackFingerprint: input.stackFingerprint,
      features: [],
      // Invert derivePromptCounts so the estimator's per-type counts approximate the queue's.
      tableCount: Math.max(0, promptsByType.schema - 1) * 10,
      apiRouteCount: promptsByType.api * 3,
      pageCount: promptsByType.feature,
      agentCount: promptsByType.agent,
    };
  }

  let costEstimate: BuildEstimate | null = null;
  try {
    costEstimate = await input.estimateCostImpl(costInput, { log: (m) => log(`cost: ${m}`) });
  } catch (error) {
    const note = `Cost estimate degraded (${describe(error)}).`;
    warnings.push(note);
    log(`WARNING: ${note}`);
  }

  return {
    projectName,
    totalPrompts: schedule.order.length,
    promptsByType,
    prompts,
    predictedErrors,
    expectedFailureCount,
    assembledTokenEstimate,
    costEstimate,
    predictedCostUsd: costEstimate ? costEstimate.costUsd : null,
    predictedTimeMs: costEstimate ? costEstimate.executionTime : null,
    warnings,
    generatedAt,
  };
}

/** A SKIPPED outcome (unmet dependency). */
function skippedOutcome(entry: QueueEntry, index: number, note: string): PromptOutcome {
  return {
    index,
    id: entry.id,
    name: entry.name,
    promptType: entry.prompt_type,
    disposition: 'skipped',
    branchName: null,
    failureProbability: null,
    wasRewritten: false,
    timedOut: false,
    decomposed: false,
    promptHash: '',
    promptExecutionId: null,
    tokensEstimated: 0,
    durationMs: 0,
    sentinel: null,
    recovery: null,
    note,
  };
}

// ---------------------------------------------------------------------------
// VS Code integration layer: queue.yaml pre-run gate
// ---------------------------------------------------------------------------

/**
 * Whether a VS Code (`Code.exe`) process is currently running. Windows-only check (`tasklist`) â€”
 * on any other platform, or when the check itself errors, this degrades to `true` (never block a
 * build over an unsupported/unavailable check; that is a different failure than "VS Code isn't
 * open"). Only a tasklist run that actually completes and finds no `Code.exe` returns `false`.
 */
function isVsCodeRunning(log: (message: string) => void): boolean {
  if (process.platform !== 'win32') return true;
  try {
    const output = execSync('tasklist /FI "IMAGENAME eq Code.exe"', { encoding: 'utf8', windowsHide: true });
    return /Code\.exe/i.test(output);
  } catch (error) {
    log(`pre-run gate: tasklist check failed (${describe(error)}) â€” treating vs_code_open as satisfied`);
    return true;
  }
}

/** Evaluate queue.yaml's optional `pre_run_checks` block once, before any prompt executes. */
function checkPreRunGates(
  checks: PreRunChecks,
  input: { governanceDir: string; log: (message: string) => void }
): { passed: boolean; reason: string | null } {
  if (checks.vs_code_open === true && !isVsCodeRunning(input.log)) {
    return {
      passed: false,
      reason:
        "queue.yaml pre_run_checks.vs_code_open is true, but no running VS Code ('Code.exe') process " +
        'was found. Open VS Code on this project, then re-run the build.',
    };
  }
  if (checks.changeset_reviewed === true && !readIdeStatus(input.governanceDir).changesetReviewed) {
    return {
      passed: false,
      reason:
        "queue.yaml pre_run_checks.changeset_reviewed is true, but SESSION_STATE.md's IDE STATUS block " +
        "shows 'CHANGESET.md reviewed: NO'. Review CHANGESET.md, set that field to YES, then re-run the build.",
    };
  }
  return { passed: true, reason: null };
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

/** The build id used in branch/tag names â€” the build_run id, else a stable fallback. */
function buildIdOf(ctx: LoopContext): string {
  return ctx.buildRunId ?? `local-${ctx.machineId}`;
}

/** Merge the current feature branch to main and create the Contract-11 checkpoint tag. */
function mergeAndTag(ctx: LoopContext, index: number): void {
  const merge = ctx.git.mergeToMain();
  if (!merge.success) {
    ctx.log(`prompt ${index}: merge to ${merge.targetBranch} failed â€” ${merge.error ?? 'unknown'}`);
    return;
  }
  const tag = ctx.git.tagCheckpoint(buildIdOf(ctx), index);
  if (!tag.success) ctx.log(`prompt ${index}: checkpoint tag failed â€” ${tag.error ?? 'unknown'}`);
}

/** Read the files this branch changed relative to main (for the prompt_execution record). */
function filesChanged(ctx: LoopContext): { created: string[]; modified: string[]; deleted: string[] } {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const diff = ctx.git.getBranchDiff();
  if (diff.success) {
    for (const f of diff.files) {
      const bucket = classifyChange(f.status);
      if (bucket === 'created') created.push(f.path);
      else if (bucket === 'modified') modified.push(f.path);
      else if (bucket === 'deleted') deleted.push(f.path);
    }
  }
  return { created, modified, deleted };
}

/**
 * VS Code integration layer: append one prompt's structured entry to `<projectPath>/CHANGESET.md`
 * â€” created if absent, NEVER overwritten â€” right after that prompt's Claude Code run + commit and
 * before Sentinel evaluates it, so a reviewer always has a durable, human-readable record of
 * exactly what the run touched. Also refreshes SESSION_STATE.md's IDE STATUS "last changeset date"
 * field (via {@link syncIdeStatus}). Guarded â€” a write failure is logged and swallowed.
 */
async function appendChangeset(
  ctx: LoopContext,
  entry: QueueEntry,
  index: number,
  files: { created: string[]; modified: string[]; deleted: string[] }
): Promise<void> {
  const timestamp = nowIso();
  const section = (label: string, list: string[]): string =>
    [`### ${label}`, '', ...(list.length > 0 ? list.map((f) => `- ${f}`) : ['- (none)']), ''].join('\n');
  const entryText = [
    `## ${timestamp} â€” ${entry.name} (prompt ${index}/${ctx.totalPrompts})`,
    '',
    section('Files Created', files.created),
    section('Files Modified', files.modified),
    section('Files Deleted', files.deleted),
    '---',
    '',
  ].join('\n');
  try {
    await appendFile(join(ctx.projectPath, 'CHANGESET.md'), entryText, 'utf8');
  } catch (error) {
    ctx.log(`prompt ${index} '${entry.id}': CHANGESET.md write failed (${describe(error)})`);
    return;
  }
  await syncIdeStatus(join(ctx.projectPath, ctx.governanceDirName), { lastChangesetDate: timestamp, log: ctx.log });
}

/**
 * On build completion (Task 1.3 â€” Session 4), write cross_project_insights for the three
 * build-level compounding signals that don't fit a single prompt's `prompt_executions` row:
 * any decomposition that occurred, any prompt_type with >1 Sentinel failure this build, and any
 * governance rule the write loop auto-elevated this build. Guarded â€” never throws; a Build
 * Memory outage just means these insights are skipped (Contract 4).
 */
async function recordBuildCompletionInsights(input: {
  projectName: string;
  buildRunId: string;
  stackFingerprint: StackFingerprint | null;
  outcomes: PromptOutcome[];
  elevatedRuleIds: Set<string>;
  log: (message: string) => void;
}): Promise<void> {
  const fingerprints = input.stackFingerprint ? [input.stackFingerprint as unknown as JsonObject] : [];

  const decomposed = input.outcomes.filter((o) => o.decomposed);
  if (decomposed.length > 0) {
    try {
      await BuildMemory.insights.createInsight({
        insight_type: 'pattern',
        source_project: input.projectName,
        source_build_id: input.buildRunId,
        applicable_fingerprints: fingerprints,
        description: `${decomposed.length} prompt(s) were decomposed into atomic sub-prompts this build: ${decomposed
          .map((o) => o.id)
          .join(', ')}.`,
        evidence: { decomposedPromptIds: decomposed.map((o) => o.id) },
      });
    } catch (error) {
      input.log(`WARNING: decomposition insight degraded (${describe(error)})`);
    }
  }

  const failuresByType = new Map<PromptType, number>();
  for (const o of input.outcomes) {
    if (o.disposition === 'failed') failuresByType.set(o.promptType, (failuresByType.get(o.promptType) ?? 0) + 1);
  }
  const repeatedTypes = [...failuresByType.entries()].filter(([, n]) => n > 1);
  if (repeatedTypes.length > 0) {
    try {
      await BuildMemory.insights.createInsight({
        insight_type: 'prevention',
        source_project: input.projectName,
        source_build_id: input.buildRunId,
        applicable_fingerprints: fingerprints,
        description:
          `Prompt type(s) with repeated (>1) Sentinel failures this build: ` +
          `${repeatedTypes.map(([t, n]) => `${t}Ã—${n}`).join(', ')}. Consider reviewing that stage's governance/template.`,
        evidence: { failuresByType: Object.fromEntries(repeatedTypes) },
      });
    } catch (error) {
      input.log(`WARNING: repeated-failure insight degraded (${describe(error)})`);
    }
  }

  if (input.elevatedRuleIds.size > 0) {
    try {
      await BuildMemory.insights.createInsight({
        insight_type: 'prevention',
        source_project: input.projectName,
        source_build_id: input.buildRunId,
        applicable_fingerprints: fingerprints,
        description: `${input.elevatedRuleIds.size} governance rule(s) auto-elevated this build from recurring, ` +
          `now-proven error fixes (occurrence_count >= 3, resolution success_rate >= 0.7).`,
        evidence: { elevatedRuleIds: [...input.elevatedRuleIds] },
      });
    } catch (error) {
      input.log(`WARNING: auto-elevation insight degraded (${describe(error)})`);
    }
  }
}

/**
 * Contract-12 rollback on a halt: preserve the feature branch and reset main to the LAST good
 * checkpoint tag, then write the diagnostic halt report (Iron Law 3 / Tier-3 escalation).
 */
async function rollbackAndReport(
  ctx: LoopContext,
  entry: QueueEntry,
  index: number,
  outcome: PromptOutcome,
  haltReason: string
): Promise<void> {
  // Roll main back to the previous prompt's checkpoint (this prompt never merged).
  if (index > 1) {
    const tag = checkpointTagName(buildIdOf(ctx), index - 1);
    const rollback = ctx.git.rollbackToCheckpoint(tag);
    if (!rollback.success) {
      ctx.log(`halt: rollback to ${tag} failed â€” ${rollback.error ?? 'unknown'} (feature branch preserved regardless)`);
    } else {
      ctx.log(`halt: main reset to last checkpoint ${tag}; feature branch ${outcome.branchName ?? '(none)'} preserved`);
    }
  }

  const report = [
    '# FORGE Phase 3 â€” HALT',
    '',
    `- **Halted at:** prompt ${index} '${entry.id}' (${entry.prompt_type})`,
    `- **Reason:** ${haltReason}`,
    `- **Feature branch (preserved):** ${outcome.branchName ?? '(none)'}`,
    `- **When:** ${nowIso()}`,
    '',
    '## Sentinel diagnostic',
    '',
    outcome.sentinel?.diagnosticReport ?? '(no Sentinel report captured)',
  ].join('\n');

  await ctx.writeHaltReport(report);
  try {
    await ctx.updateStateProgress(`[FORGE Phase 3] HALTED at prompt ${index} '${entry.id}': ${haltReason}`);
  } catch {
    /* state update is non-fatal */
  }
}

/** Rebuild the checkpoint tag name (mirrors git-manager's `checkpointTagFor`, without importing it). */
function checkpointTagName(buildId: string, promptIndex: number): string {
  const safeId = String(buildId).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[.\-]+|[.\-]+$/g, '');
  return `forge-checkpoint-${safeId || 'x'}-${Number.isFinite(promptIndex) ? Math.trunc(promptIndex) : 0}`;
}

// ---------------------------------------------------------------------------
// Build Memory prompt_execution logging
// ---------------------------------------------------------------------------

/** Insert the prompt_execution row (status running) and return its id, or null in stateless mode. */
async function logPromptExecution(
  ctx: LoopContext,
  data: {
    entry: QueueEntry;
    index: number;
    promptHash: string;
    promptText: string;
    branchName: string | null;
    wasRewritten: boolean;
    originalHash: string | null;
    rewriteReason: string | null;
    failureProbability: number;
  }
): Promise<string | null> {
  if (ctx.buildRunId === null) return null;
  try {
    const row = await ctx.createPromptExecution({
      build_run_id: ctx.buildRunId,
      prompt_index: data.index,
      prompt_name: data.entry.name,
      prompt_hash: data.promptHash,
      prompt_content: data.promptText,
      status: 'running',
      started_at: nowIso(),
      branch_name: data.branchName,
      was_rewritten: data.wasRewritten,
      original_prompt_hash: data.originalHash,
      rewrite_reason: data.rewriteReason,
      failure_prediction_score: data.failureProbability,
    });
    return row?.id ?? null;
  } catch (error) {
    ctx.log(`WARNING: createPromptExecution degraded (${describe(error)})`);
    return null;
  }
}

/** Patch the prompt_execution row with the final outcome (status / Sentinel / files / tokens). */
async function finalizePromptExecution(
  ctx: LoopContext,
  promptExecutionId: string | null,
  data: {
    disposition: PromptDisposition;
    sentinel: SentinelResult;
    tokens: number;
    durationMs: number;
    errorOutput: string | null;
    changed: { created: string[]; modified: string[]; deleted: string[] };
    recovery: AutoRecoveryResult | null;
  }
): Promise<void> {
  if (promptExecutionId === null) return;
  const sentinelDetails: JsonObject = {
    passed: data.sentinel.passed,
    failedCheck: data.sentinel.failedCheck,
    checks: data.sentinel.checks.map((c) => ({ name: c.name, passed: c.passed, skipped: c.skipped, detail: c.detail })),
    ...(data.recovery ? { recovery: { attempted: data.recovery.attempted, recovered: data.recovery.recovered, escalated: data.recovery.escalated } } : {}),
  };
  try {
    await ctx.updatePromptExecution(promptExecutionId, {
      status: data.disposition === 'completed' ? 'completed' : 'failed',
      completed_at: nowIso(),
      duration_ms: data.durationMs,
      tokens_output: data.tokens,
      sentinel_passed: data.sentinel.passed,
      sentinel_details: sentinelDetails,
      error_output: data.errorOutput,
      files_created: data.changed.created,
      files_modified: data.changed.modified,
      files_deleted: data.changed.deleted,
      ...(data.recovery && data.recovery.attempted ? { resolution_applied: data.recovery.reason } : {}),
    });
  } catch (error) {
    ctx.log(`WARNING: updatePromptExecution degraded (${describe(error)})`);
  }
}

// ---------------------------------------------------------------------------
// State + halt-report writers (defaults â€” injectable)
// ---------------------------------------------------------------------------

/**
 * Default STATE_OF_THE_BUILD.md progress update (Canonical Rule 9): append a timestamped
 * progress line under the governance dir. Guarded â€” a write failure is non-fatal (it never
 * blocks the build). STATE_OF_THE_BUILD.md is deliberately NOT in Sentinel's protected set.
 */
async function defaultUpdateStateProgress(governanceDir: string, line: string): Promise<void> {
  const target = join(governanceDir, 'STATE_OF_THE_BUILD.md');
  try {
    await appendFile(target, toAsciiGovernanceText(`\n> ${nowIso()} ${line}\n`), 'utf8');
  } catch {
    /* non-fatal â€” the state document update must never block the build */
  }
}

/**
 * Default decomposition-record sink: write the decomposition SHAPE to `cross_project_insights` as an
 * `optimization` insight (Phase 5 pattern learning â€” which prompt kinds need splitting, how reliably
 * the splits land). No-op in stateless mode (no build to attach to). Guarded/non-fatal (Contract 4 â€”
 * a Build Memory write never blocks the build).
 */
async function defaultRecordDecomposition(
  projectName: string,
  machineId: string,
  buildRunId: string | null,
  record: DecompositionRecord
): Promise<void> {
  if (buildRunId === null) return;
  try {
    await BuildMemory.insights.createInsight({
      insight_type: 'optimization',
      source_project: projectName,
      source_build_id: buildRunId,
      description:
        `Prompt '${record.promptId}' (${record.promptType}, ${record.descriptionLength} chars) auto-decomposed into ` +
        `${record.subPromptCount} atomic sub-prompt(s) [${record.subPromptKinds.join(', ')}]: ` +
        `${record.succeeded} completed, ${record.failed} failed, ${record.totalRetries} retr${record.totalRetries === 1 ? 'y' : 'ies'}.`,
      evidence: {
        machine_id: machineId,
        prompt_id: record.promptId,
        prompt_name: record.promptName,
        prompt_type: record.promptType,
        description_length: record.descriptionLength,
        sub_prompt_count: record.subPromptCount,
        sub_prompt_kinds: record.subPromptKinds,
        succeeded: record.succeeded,
        failed: record.failed,
        total_retries: record.totalRetries,
      },
    });
  } catch {
    /* non-fatal â€” Build Memory write must never block the build (Contract 4) */
  }
}

/** Default halt-report writer: `state/halt-reason.md` under the project (CLAUDE.md error protocol). */
async function defaultWriteHaltReport(projectPath: string, report: string): Promise<void> {
  const dir = join(projectPath, 'state');
  try {
    await mkdir(dir, { recursive: true });
    await writeGovernanceFile(join(dir, 'halt-reason.md'), report);
  } catch {
    /* non-fatal */
  }
}

/**
 * Read and concatenate the SKILL.md files for the given skill names.
 * Missing skill files are skipped with a warning (non-fatal â€” Contract 4 posture).
 */
async function loadSkillContent(skills: string[], skillsDir: string, log: (m: string) => void): Promise<string> {
  const parts: string[] = [];
  for (const skill of skills) {
    const skillPath = join(skillsDir, skill, 'SKILL.md');
    try {
      const content = await readFile(skillPath, 'utf8');
      parts.push(content.trim());
    } catch (error) {
      log(`WARNING: skill '${skill}' not found at ${skillPath} (${describe(error)}) â€” skipped`);
    }
  }
  return parts.join('\n\n');
}

/** Basename of a filesystem path (last non-empty segment), or `'project'`. */
function basenameOf(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last && last.trim() !== '' ? last : 'project';
}

export default runPhase3Executor;


