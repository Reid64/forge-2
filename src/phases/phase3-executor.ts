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
import { analyzeSchedule, executeSchedule, type ScheduleAnalysis } from '../engine/parallel-scheduler.js';
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
  type CheckResult,
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
import { RunRecorder, setActiveRunRecorder, getActiveRunRecorder } from '../telemetry/run-recorder.js';
import { scanDeadCode } from '../tools/dead-code-scanner.js';
import { onRunStart, onPromptComplete, onRunEnd } from '../learning/integration.js';
import { observeRewriteOutcome } from '../learning/build-brain-evolver.js';
import { onSentinelFailure, onSentinelPrimeHalt } from '../integration/bus.js';
import { SentinelPrime } from '../sentinel-prime/index.js';
import { createExecutionMonitor, executionMonitorSingleton } from '../sentinel-prime/execution-monitor.js';
import { detectRequiredComponents, ensureComponentsInstalled } from '../ui-engine/shadcn-installer.js';
import { ensureDesignTokens } from '../ui-engine/design-token-manager.js';
import { checkComponentAccessibility, type AccessibilityReport } from '../ui-engine/accessibility-checker.js';
import { stripSharedPreambleDuplicates } from '../engine/shared-preamble.js';
import { createSupabaseMigrator, type MigrationResult } from '../autonomy/supabase-migrator.js';
import { BuildHealthMonitor } from '../autonomy/health-monitor.js';
import {
  ArchitectureGuardian,
  createArchitectureGuardian,
  classifyPrompt,
  type GuardianValidation,
  type PromptClassification,
  type OutputValidation,
} from '../architecture-guardian/index.js';
import { DesignPipeline, createDesignPipeline, type DesignReviewResult } from '../design-pipeline/index.js';
import { getClient, logMemoryWarning, newId } from '../memory/client.js';
import { checkAllInvariants, type InvariantResult } from '../governance/invariants.js';
import { analyzeBlastRadius } from '../governance/blast-radius.js';
import { deriveTaskState } from '../governance/build-state-machine.js';
import {
  detectDeadLoop,
  DEAD_LOOP_ERROR_FAMILY_THRESHOLD,
  DEAD_LOOP_REMEDIATION_CLASS_THRESHOLD,
  type DeadLoopVerdict,
} from '../governance/dead-loop-detection.js';
import { detectStagnation, type StagnationVerdict } from '../governance/stagnation-detection.js';

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
  /**
   * Sentinel Prime's composite confidence score (0-1) for this prompt, when Sentinel Prime ran.
   * null/absent for skipped, dry-run, and error-path outcomes -- BuildHealthMonitor
   * falls back to a pass/fail proxy (1/0) in that case (src/autonomy/health-monitor.ts).
   */
  confidenceScore?: number | null;
  /**
   * UI Engine (Task 3/4): count of static WCAG 2.1 AA issues `checkComponentAccessibility` found
   * across this prompt's modified/created `.tsx` files. `null`/absent when the check did not run
   * (not a component/page prompt, or the prompt did not pass all Sentinel gates). Warn-only —
   * never affects `disposition`.
   */
  accessibilityIssueCount?: number | null;
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
   * Max prompts run concurrently WITHIN one dependency wave (parallel-scheduler.ts's deferred
   * `executeSchedule` capability, now enabled). `1` (the default) preserves the exact classic
   * SEQUENTIAL path (`schedule.order` walked one prompt at a time) with zero behavioural change.
   * `> 1` fans a wave's dependency-satisfied prompts out onto isolated git worktrees (Contract 10:
   * still one branch per prompt) and runs their claude-runner calls concurrently, merging each to
   * `mainBranch` independently as soon as ITS Sentinel gate passes — never waiting on wave-mates.
   * Default: `options.maxConcurrency`, else `forge_config.json`'s `build.parallelism`, else `1`.
   * Ignored for a dry run (nothing executes) and for a Build Replay carry prefix (unaffected).
   */
  maxConcurrency?: number;
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
  /**
   * Architecture Guardian instance (pre-prompt enterprise-standards enforcement + post-prompt
   * output validation, `src/architecture-guardian/index.ts`). Default: a fresh
   * {@link createArchitectureGuardian}. Injectable so tests can substitute a fake/spy.
   */
  architectureGuardian?: ArchitectureGuardian;
  /**
   * Design Pipeline instance (screenshot capture + optional Penpot push + visual review gate,
   * `src/design-pipeline/index.ts`). Default: a fresh {@link createDesignPipeline}. Injectable so
   * tests can substitute a fake/spy.
   */
  designPipeline?: DesignPipeline;
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
  'STATE_OF_THE_BUILD.md',
  'CLAUDE.md',
];

// ---------------------------------------------------------------------------
// Per-prompt-type timeout budgets (Session 5 finding #14)
// ---------------------------------------------------------------------------

/** Prompt types whose work is inherently slower than average generation (a full test/deploy run). */
const LONG_TIMEOUT_PROMPT_TYPES: ReadonlySet<PromptType> = new Set<PromptType>(['test', 'deploy']);

/**
 * Prompt types the ShadcnInstaller (`src/ui-engine/shadcn-installer.ts`) scans for required
 * components. FORGE's `PromptType` union has no `component`/`page` member (queue entries are
 * typed `schema`/`auth`/`api`/`ui`/`feature`/`agent`/`test`/`deploy`), so `ui`/`feature` are the
 * real UI-producing analogs — the same mapping Enhanced Retrofit's RET-3 bundle-size gate uses.
 */
const SHADCN_INSTALL_PROMPT_TYPES: ReadonlySet<PromptType> = new Set<PromptType>(['ui', 'feature']);

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
 * Read `<projectPath>/forge_config.json`'s `build.parallelism` (falling back to `1` — the
 * classic sequential default — for a missing file/field/non-positive value; never throws).
 * `Phase3Options.maxConcurrency` overrides this when explicitly supplied.
 */
async function loadParallelismConfig(projectPath: string): Promise<number> {
  try {
    const raw = await readFile(join(projectPath, 'forge_config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { build?: { parallelism?: unknown } };
    const parallelism = parsed.build?.parallelism;
    return typeof parallelism === 'number' && Number.isFinite(parallelism) && parallelism >= 1 ? Math.floor(parallelism) : 1;
  } catch {
    return 1;
  }
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
// Architecture Guardian wiring
// ---------------------------------------------------------------------------

/**
 * Persist one prompt's Architecture Guardian pass (pre-prompt {@link GuardianValidation} +
 * post-prompt {@link OutputValidation}) to Build Memory's `autonomy_actions` table (schema
 * 2.9.0 — `src/learning/database.ts`) for audit trail, mirroring
 * `src/autonomy/supabase-migrator.ts`'s `persistAutonomyAction` pattern exactly: best-effort
 * (Contract 4), never throws, a missing/unreachable Build Memory connection is a silent no-op.
 */
function persistGuardianAudit(
  ctx: LoopContext,
  entry: QueueEntry,
  index: number,
  guardianValidation: GuardianValidation,
  outputValidation: OutputValidation
): void {
  const db = getClient();
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO autonomy_actions (id, build_run_id, action_type, target, status, result, error, created_at)
       VALUES (@id, @build_run_id, 'architecture_guardian', @target, @status, @result, @error, @created_at)`
    ).run({
      id: newId(),
      build_run_id: ctx.buildRunId ?? '',
      target: `prompt-${index}-${entry.id}`,
      status: outputValidation.passed ? 'passed' : 'failed',
      result: JSON.stringify({
        guardianValidation: {
          approved: guardianValidation.approved,
          enforcementsApplied: guardianValidation.enforcementsApplied,
          rejectionReason: guardianValidation.rejectionReason,
          estimatedOutputLines: guardianValidation.estimatedOutputLines,
        },
        outputValidation: {
          passed: outputValidation.passed,
          qualityScore: outputValidation.qualityScore,
          filesChecked: outputValidation.filesChecked,
          violations: outputValidation.violations,
          recommendation: outputValidation.recommendation,
        },
      }),
      error: null,
      created_at: nowIso(),
    });
  } catch (error) {
    logMemoryWarning('phase3-executor.persistGuardianAudit', error);
  }
}

/**
 * Architecture Guardian's post-output gate: runs AFTER claude has produced its diff (and FORGE has
 * committed it) and BEFORE the Contract-13 Sentinel gate. Scans every file this prompt actually
 * touched for the failure modes `EnterpriseEnforcer`'s pre-prompt instructions were trying to
 * prevent (`prePrompt`, called earlier for this same prompt).
 *
 * When the output has a CRITICAL violation, or its quality score falls below the pass floor, the
 * (potentially slow) Sentinel run below is skipped entirely — a synthetic failed {@link SentinelResult}
 * is returned instead, so the prompt "triggers autonomous recovery immediately without waiting for
 * [the] Sentinel gate": the existing Sentinel-failure/Autonomous-Recovery path (the disposition
 * switch further down `executePrompt`) treats it exactly like any other Sentinel failure. Returns
 * `null` when Guardian found nothing severe enough to skip Sentinel — the caller then runs Sentinel
 * normally. Never throws (Contract 4): a `postPrompt` failure degrades to `null` (proceed normally).
 */
async function runGuardianPostCheck(
  ctx: LoopContext,
  entry: QueueEntry,
  index: number,
  guardianClassification: PromptClassification,
  guardianValidation: GuardianValidation
): Promise<SentinelResult | null> {
  const changed = filesChanged(ctx);
  const modifiedFiles = [...changed.created, ...changed.modified];

  let outputValidation: OutputValidation;
  try {
    outputValidation = await ctx.guardian.postPrompt(ctx.projectPath, modifiedFiles, guardianClassification);
  } catch (error) {
    ctx.log(`prompt ${index} '${entry.id}': [GUARDIAN] postPrompt non-fatal â€” ${describe(error)}`);
    return null;
  }

  const criticalViolations = outputValidation.violations.filter((v) => v.severity === 'critical');
  if (!outputValidation.passed && criticalViolations.length > 0) {
    ctx.log(
      `[GUARDIAN] CRITICAL VIOLATIONS FOUND in ${entry.id}: ` +
        criticalViolations.map((v) => `${v.violationType} @ ${v.filePath} â€” ${v.description}`).join(' | ')
    );
  }
  if (outputValidation.qualityScore < 60) {
    ctx.log(`[GUARDIAN] Quality score ${outputValidation.qualityScore}/100 â€” triggering recovery`);
  }
  ctx.log(
    `[GUARDIAN] Quality: ${outputValidation.qualityScore}/100 â€” ${guardianValidation.enforcementsApplied.length} enforcements applied`
  );

  persistGuardianAudit(ctx, entry, index, guardianValidation, outputValidation);

  const shouldForceFailure =
    (!outputValidation.passed && criticalViolations.length > 0) || outputValidation.qualityScore < 60;
  if (!shouldForceFailure) return null;

  const violationLines = outputValidation.violations
    .map((v) => `[${v.severity.toUpperCase()}] ${v.violationType} ${v.filePath}: ${v.description}`)
    .join('\n');
  const check: CheckResult = {
    name: 'architecture',
    passed: false,
    skipped: false,
    detail: `Architecture Guardian: quality ${outputValidation.qualityScore}/100, ${criticalViolations.length} critical violation(s)`,
    output: violationLines || outputValidation.recommendation,
    durationMs: 0,
  };
  return {
    passed: false,
    checks: [check],
    failedCheck: 'architecture',
    diagnosticReport:
      `Architecture Guardian forced prompt ${index} '${entry.id}' to fail before the Sentinel gate ran.\n\n` +
      `${violationLines || outputValidation.recommendation}`,
  };
}

// ---------------------------------------------------------------------------
// Design Pipeline wiring
// ---------------------------------------------------------------------------

/**
 * Runs the Design Pipeline (`src/design-pipeline/index.ts`) for one COMPLETED prompt of a
 * component/page prompt type (`SHADCN_INSTALL_PROMPT_TYPES` — the real `ui`/`feature`
 * `PromptType` analogs already established for the shadcn installer/accessibility check above).
 * Called only once the Contract-13 Sentinel gate has already passed (no point screenshotting
 * code that doesn't build) and strictly BEFORE the merge decision below, so a design-rejected
 * prompt is never merged to main on the strength of a green Sentinel alone. Non-fatal (Contract
 * 4): a Design Pipeline failure degrades to `null` (proceed as if no review ran) rather than
 * aborting the prompt.
 */
async function runDesignPipelineCheck(
  ctx: LoopContext,
  entry: QueueEntry,
  index: number,
  changed: { created: string[]; modified: string[]; deleted: string[] }
): Promise<DesignReviewResult | null> {
  try {
    const modifiedFiles = [...changed.created, ...changed.modified];
    const result = await ctx.designPipeline.run(
      { id: entry.id, name: entry.name, prompt_type: entry.prompt_type },
      ctx.projectPath,
      buildIdOf(ctx),
      modifiedFiles,
      // Phase 3 is fully autonomous (BLUEPRINT "AUTONOMOUS OPERATION RULES" — never wait for
      // human approval mid-build), so the review gate always runs non-interactively here.
      true,
      ctx.queueEntries?.map((e) => ({ id: e.id, name: e.name, description: e.description, prompt_type: e.prompt_type }))
    );
    ctx.log(
      `[DESIGN PIPELINE] Screenshots: ${result.screenshotPaths.length} viewports and ` +
        `Review: ${result.approved ? 'approved' : 'rejected'}`
    );
    return result;
  } catch (error) {
    ctx.log(`prompt ${index} '${entry.id}': [DESIGN PIPELINE] non-fatal — ${describe(error)}`);
    return null;
  }
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
    // Queue runner (token efficiency): strip any queue.yaml-authored restatement of the
    // universal build/commit/never-guess/scope rules — the assembler injects those exactly
    // once via shared-preamble.ts, so a per-entry copy is dead weight, not a safeguard.
    description: stripSharedPreambleDuplicates(asString(o.description)),
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
  // Control Plane run telemetry: mirror this same line to .forge/runs/<run-id>/events.jsonl,
  // never replacing the console output above â€” a no-op outside a live (non-dry-run) Phase 3 build.
  getActiveRunRecorder()?.recordEvent(level, message);
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
  const governanceDirName = options.governanceDirName ?? '.';
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

  // Control Plane run telemetry (upgrades/CAPABILITIES_MEMO.md observability section): one
  // .forge/runs/<run-id>/ directory for this build, mirroring the console output below into
  // structured JSONL/JSON alongside it. buildRunId falls back to the timestamp when Build Memory
  // is unreachable (stateless mode) so telemetry never depends on a live database. Cleared in the
  // top-level `finally` below so it never leaks into a later, unrelated build in this process.
  if (!dryRun) {
    try {
      setActiveRunRecorder(new RunRecorder(buildRunId ?? generatedAt.replace(/[:.]/g, '-'), projectPath));
    } catch (error) {
      log(`WARNING: RunRecorder init degraded (${describe(error)}) â€” continuing without run telemetry`);
    }
  }

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
  const architectureGuardian = options.architectureGuardian ?? createArchitectureGuardian();
  const designPipeline = options.designPipeline ?? createDesignPipeline();
  const timeoutBudgetConfig = await loadTimeoutBudgetConfig(projectPath);
  const timeoutBudgetMsFor = makeTimeoutBudgetResolver(timeoutBudgetConfig);
  log(
    `timeout budgets: default ${timeoutBudgetConfig.timeoutMinutes}m, ` +
      `test/deploy ${timeoutBudgetConfig.longTimeoutMinutes}m` +
      (options.claudeTimeoutMs !== undefined ? ` (overridden uniformly to ${Math.round(options.claudeTimeoutMs / 60_000)}m by claudeTimeoutMs)` : '')
  );
  const maxConcurrency =
    options.maxConcurrency !== undefined && options.maxConcurrency >= 1
      ? Math.floor(options.maxConcurrency)
      : await loadParallelismConfig(projectPath);
  if (maxConcurrency > 1) log(`concurrency: up to ${maxConcurrency} prompt(s) per dependency wave (git-worktree fan-out).`);
  const liveStatus = new LiveStatusWriter(projectPath, projectName, buildRunId, schedule.order.length);

  // Build-wide health monitoring (Autonomy: BuildHealthMonitor â€” src/autonomy/health-monitor.ts):
  // a third layer above the per-prompt Contract-13 gate and Sentinel Prime, watching consecutive
  // failures, a rolling confidence average, and process memory across the WHOLE run, with the
  // ability to auto-pause on a CRITICAL read. Skipped for dry runs â€” nothing executes to monitor.
  const healthMonitor = new BuildHealthMonitor(projectPath, (m) => log(`health: ${m}`));
  if (!dryRun) healthMonitor.start(schedule.order.length);

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
    stagnationWarned: { warned: false },
    liveStatus,
    healthMonitor,
    log,
    hookManager,
    instincts,
    costTracker,
    guardian: architectureGuardian,
    designPipeline,
    queueEntries: schedule.order,
  };

  const outcomes: PromptOutcome[] = [];
  const completedIds = new Set<string>();
  let previousSentinel: PreviousSentinelStatus | null = null;
  let schemaPromptsHaveRun = false;
  let halted = false;
  let haltReason: string | null = null;
  let haltedAt: { index: number; id: string } | null = null;

  // UI ENGINE (Task 1): ensure a consistent design-token baseline (tailwind.config.ts +
  // globals.css) exists before the FIRST prompt of every real build run. Never overwrites a
  // project's own tokens if either file already exists (design-token-manager.ts's own guard) â€”
  // this is a one-time-per-build baseline, not a per-prompt operation. Skipped for dry runs
  // (nothing executes; a simulation must never touch the target project's files). Guarded/non-
  // fatal (Contract 4 posture): a failure here degrades to a warning, never blocks the build.
  if (!dryRun) {
    try {
      await ensureDesignTokens(ctx.projectPath);
      log('[UI ENGINE] Design tokens configured');
    } catch (error) {
      log(`[UI ENGINE] design token setup non-fatal â€” ${describe(error)}`);
    }
  }

  if (maxConcurrency <= 1) {
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

    // Build-wide health check (Autonomy: BuildHealthMonitor): record this prompt's outcome, then
    // pause (report + 2-minute cooldown, handled entirely inside shouldPause()) if the build has
    // gone CRITICAL. Falls back to a pass/fail proxy when Sentinel Prime did not produce a
    // composite confidence score for this outcome (skipped/dry-run/error-path outcomes never
    // reach this branch, but the fallback keeps the call site correct regardless).
    healthMonitor.recordPromptResult(
      outcome.disposition === 'completed',
      outcome.confidenceScore ?? (outcome.disposition === 'completed' ? 1 : 0)
    );
    await healthMonitor.shouldPause();

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
  } else {
    // Deferred concurrent execution (parallel-scheduler.ts's `executeSchedule`, now enabled):
    // fan each dependency-satisfied wave out onto isolated git worktrees instead of walking
    // `schedule.order` one prompt at a time. See `runPromptsConcurrently` for the full contract.
    const concurrent = await runPromptsConcurrently(ctx, schedule, entries, {
      replay,
      startAt,
      skillsDir,
      maxConcurrency,
      previousSentinel,
      schemaPromptsHaveRun,
    });
    outcomes.push(...concurrent.outcomes);
    halted = concurrent.halted;
    haltedAt = concurrent.haltedAt;
    haltReason = concurrent.haltReason;
    schemaPromptsHaveRun = concurrent.schemaPromptsHaveRun;
    previousSentinel = concurrent.previousSentinel;
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

    // Autonomous Supabase migration (Contract 4 — best-effort, non-fatal): once every prompt has
    // cleared its Sentinel gates and the build_run itself is finalized as 'completed', apply any
    // pending supabase/migrations/*.sql files directly via the Management API. Never runs on a
    // 'failed'/'halted' build — a build that never went green has no business pushing schema
    // changes to a live database. A migration failure here is logged and swallowed; it never
    // reopens or fails an already-finalized build_run.
    if (status === 'completed') {
      try {
        const migrator = createSupabaseMigrator();
        if (process.env['SUPABASE_ACCESS_TOKEN'] && (await migrator.isConfigured(projectPath))) {
          const migrationResults = await migrator.applyPendingMigrations(projectPath, buildRunId);
          for (const r of migrationResults) {
            log(`SupabaseMigrator: ${r.migrationFile} — ${r.status}${r.error ? `: ${r.error}` : ''} (${r.durationMs}ms)`);
          }
          const failedMigrations = migrationResults.filter((r) => r.status === 'failed');
          if (failedMigrations.length > 0) {
            log(
              `SupabaseMigrator: ${failedMigrations.length}/${migrationResults.length} migration(s) FAILED — ` +
                'build already completed and is NOT being halted for this (Contract 4); writing a BLOCKER to ' +
                'STATE_OF_THE_BUILD.md for human follow-up.'
            );
            await appendMigrationBlocker(governanceDir, buildRunId, failedMigrations);
          } else if (migrationResults.some((r) => r.status === 'applied')) {
            log(
              `SupabaseMigrator: applied ${migrationResults.filter((r) => r.status === 'applied').length} migration(s), ` +
                `skipped ${migrationResults.filter((r) => r.status === 'skipped').length}.`
            );
          }
        }
      } catch (error) {
        log(`SupabaseMigrator non-fatal — ${describe(error)}`);
      }
    }
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
    getActiveRunRecorder()?.writeMetrics({
      totalPrompts: schedule.order.length,
      completedPrompts,
      failedPrompts,
      skippedPrompts,
      totalTokens,
      status,
      halted,
      durationMs: Date.now() - Date.parse(generatedAt),
      generatedAt,
    });
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

    // Build-wide health monitoring: stop the memory-sampling interval and log the final snapshot.
    // Always runs (including on an unexpected throw), matching the run-lock cleanup above.
    if (!dryRun) healthMonitor.stop();

    // Restore stdout LAST â€” handleSessionEnd (above) still has more [SESSION]/[FORGE Learning]
    // console output to emit, and it must land in the log file too, not on stdout.
    releaseStdoutQuietMode();
    // Clear the ambient run-telemetry recorder so it never leaks into a later, unrelated build
    // running in this same process (e.g. a test harness driving multiple builds sequentially).
    setActiveRunRecorder(null);
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
  /**
   * Set once `detectStagnation` (`src/governance/stagnation-detection.ts`) trips for this build,
   * so the STATE_OF_THE_BUILD.md stagnation WARNING is appended exactly once per build rather than
   * once per remaining prompt.
   */
  stagnationWarned: { warned: boolean };
  /** Live build-status writer (Task 3 â€” Session 4). Always present; a disk failure just no-ops. */
  liveStatus: LiveStatusWriter;
  /** Build-wide health monitor (Autonomy: BuildHealthMonitor) â€” read for the Sentinel Prime halt record. */
  healthMonitor: BuildHealthMonitor;
  log: (message: string) => void;
  /** Hook manager for pre_prompt / post_prompt lifecycle events. */
  hookManager: HookManager;
  /** Learned instinct rules applied to each prompt before execution. */
  instincts: Instinct[];
  /** Accumulates per-prompt model cost estimates across the build. */
  costTracker: ModelCostTracker;
  /** Architecture Guardian (pre-prompt enforcement + post-prompt output validation). */
  guardian: ArchitectureGuardian;
  /** Design Pipeline (screenshot capture + optional Penpot push + visual review gate). */
  designPipeline: DesignPipeline;
  /**
   * The full ordered queue (`schedule.order`) â€” threaded through to `designPipeline.run()` so
   * `app-profiler.ts` profiles the WHOLE project's corpus rather than one prompt at a time.
   * Optional so a test/caller constructing a `LoopContext` by hand (without a full schedule)
   * still compiles; `runDesignPipelineCheck` falls back to a single-entry corpus when absent.
   */
  queueEntries?: QueueEntry[];
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
    // Bundle Size gate (RET-3 / Contract RET-3): supplied unconditionally â€” the gate itself
    // auto-skips for any prompt type other than feature/ui and for a non-Next.js project (no
    // next.config.*), so it is always safe to hand it a projectPath here.
    bundleSize: { projectPath: ctx.projectPath },
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
  getActiveRunRecorder()?.recordPromptStart({ index, id: entry.id, name: entry.name, promptType: entry.prompt_type });
  await ctx.liveStatus.promptPhase({ index, id: entry.id, name: entry.name, type: entry.prompt_type, phase: 'start' });

  // Sentinel Prime (System 5): start the ExecutionMonitor singleton for this prompt BEFORE any
  // claude-runner call, so it observes the subprocess's stdout/commands as they happen. Reused
  // across the whole build (keyed by buildRunId), reset per-prompt via start().
  const executionMonitor = executionMonitorSingleton.get(buildIdOf(ctx)) ?? createExecutionMonitor();
  executionMonitorSingleton.set(buildIdOf(ctx), executionMonitor);
  executionMonitor.start(buildIdOf(ctx), entry.id, index, ctx.projectPath);

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

    // b2.5. SKILLS LIBRARY â€” auto-detect the target project's stack (package.json deps) and
    // prepend any matching skill templates as engineering standards, independent of whichever
    // skills (if any) the queue entry itself declared via `skills:` (see loadSkillContent above,
    // which is entry-opt-in; this is stack-detected and applies to every prompt automatically).
    try {
      const withSkillsContext = promptText;
      if (withSkillsContext !== promptText) {
        log(`prompt ${index} '${entry.id}': skills library context prepended (+${withSkillsContext.length - promptText.length} chars)`);
        promptText = withSkillsContext;
      }
    } catch {
      /* best-effort â€” Contract 4 posture: skill injection never blocks execution */
    }

    // b2.6. SHADCN INSTALLER â€” for component/page/feature prompt types (FORGE's `PromptType`
    // union has no dedicated `component`/`page` member; `ui`/`feature` are the real UI-producing
    // analogs, the same mapping RET-3's bundle-size gate uses), scan the assembled prompt text
    // for shadcn/ui component keywords and install anything missing in the target project BEFORE
    // claude runs, so it never has to stop mid-build to run the shadcn/ui CLI itself.
    if (SHADCN_INSTALL_PROMPT_TYPES.has(entry.prompt_type)) {
      try {
        const requiredComponents = detectRequiredComponents(promptText);
        if (requiredComponents.length > 0) {
          const newlyInstalled = await ensureComponentsInstalled(ctx.projectPath, requiredComponents);
          if (newlyInstalled.length > 0) {
            log(`[UI ENGINE] Installed ${newlyInstalled.length} shadcn components: ${newlyInstalled.join(', ')}`);
          }
        }
      } catch {
        /* best-effort â€” Contract 4 posture: component auto-install never blocks execution */
      }
    }

    // b2.7. ARCHITECTURE GUARDIAN (pre-prompt) â€” classify this prompt's build target and enforce
    // enterprise-grade standards against it (`src/architecture-guardian/index.ts`), replacing
    // `promptText` with the enhanced version before it reaches claude. Runs after every other
    // prompt-text-shaping step above (skills library, shadcn installer) so the enhanced prompt
    // reflects everything already added, and before model routing (b3) so complexity/cost are
    // estimated from the final text. Never blocks (`approved` is always true â€” see enforcer.ts).
    const guardianValidation = ctx.guardian.prePrompt(
      { id: entry.id, promptType: entry.prompt_type, promptText },
      ctx.projectPath
    );
    if (guardianValidation.enhancedPrompt !== promptText) {
      promptText = guardianValidation.enhancedPrompt;
    }
    for (const enforcement of guardianValidation.enforcementsApplied) {
      log(`[GUARDIAN] Enforced: ${enforcement} on ${entry.id}`);
    }
    const guardianClassification: PromptClassification =
      ctx.guardian.getLastClassification() ?? classifyPrompt(promptText, entry.prompt_type);

    // b2.8. INVARIANT ENGINE (pre-write) â€” before this prompt's changes are written, confirm the
    // build's machine-checked invariants (`src/governance/invariants.ts`, each a restatement of an
    // existing BEHAVIORAL_CONTRACTS.md contract) still hold from every prompt executed so far this
    // build. Observational only, per the same non-blocking posture already established for
    // BuildHealthMonitor (Contract AUT-6: "observes and pauses; MUST NOT itself halt a build") â€”
    // this is a NEW starter capability, not a sixth Sentinel check, so it logs a failure for human
    // visibility rather than introducing an undocumented new halt path.
    try {
      const invariantResults = await checkAllInvariants(ctx.projectPath);
      const violated = invariantResults.filter((r: InvariantResult) => r.status === 'fail');
      for (const violation of violated) {
        log(`[INVARIANTS] VIOLATED before prompt ${index} '${entry.id}': ${violation.id} (${violation.contract}) â€” ${violation.detail}`);
      }
    } catch (error) {
      log(`[INVARIANTS] pre-write check degraded (${describe(error)})`);
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
      // ARCHITECTURE GUARDIAN (post-prompt) â€” after claude's work is committed, before this
      // prompt's gating Sentinel result is settled. A CRITICAL violation / sub-60 quality score
      // overrides the decomposer's own final Sentinel with a forced failure (see
      // runGuardianPostCheck's doc comment).
      const guardianForcedSentinel = await runGuardianPostCheck(ctx, entry, index, guardianClassification, guardianValidation);
      // Reuse the decomposer's between-sub-steps Sentinel as THIS prompt's gate (avoids a redundant
      // whole-prompt re-run); fall back only if it executed nothing (never, for a >threshold prompt).
      sentinel = guardianForcedSentinel ?? decomposition.finalSentinel ?? (await ctx.runSentinelImpl(sentinelOptions));
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
      // Guard against a backgrounded claude task (run_in_background Bash / background Agent) still
      // writing to the working tree after `claude -p` itself has exited â€” see waitForGitQuiescence's
      // doc comment. Runs before commitAll so the snapshot it stages reflects the finished work,
      // not a partial write caught mid-flight.
      await waitForGitQuiescence(ctx, index);

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

      // ARCHITECTURE GUARDIAN (post-prompt) â€” after claude's work is committed, BEFORE the
      // Contract-13 Sentinel gate (h). A CRITICAL violation / sub-60 quality score short-circuits
      // the Sentinel run below entirely, so autonomous recovery fires immediately rather than
      // waiting on tsc/build to independently discover the same problem.
      const guardianForcedSentinel = await runGuardianPostCheck(ctx, entry, index, guardianClassification, guardianValidation);

      // h. Run the Phase 4 Sentinel (the five Contract-13 checks) â€” skipped when Guardian already
      // forced a failure above.
      sentinel = guardianForcedSentinel ?? (await ctx.runSentinelImpl(sentinelOptions));
    }

    renderProgress('GATE', `Sentinel â€” ${sentinel.checks.length} check(s)`);
    for (const check of sentinel.checks) {
      const verdict = check.skipped ? 'SKIP' : check.passed ? 'PASS' : 'FAIL';
      renderProgress(
        check.skipped ? 'WARN' : check.passed ? 'PASS' : 'FAIL',
        `  ${check.name} â€” ${verdict}${verdict === 'FAIL' ? ` (${check.detail})` : ''}`
      );
      getActiveRunRecorder()?.recordGateCheck({
        index,
        id: entry.id,
        checkName: check.name,
        passed: check.passed,
        skipped: check.skipped,
        detail: check.skipped || !check.passed ? check.detail : null,
      });
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

    // Sentinel Prime (System 5): a second, independent observation pass over this SAME completed
    // prompt, run in addition to (never in place of) the mandatory Contract-13 gate above â€”
    // ExecutionMonitor (how the subprocess ran) + DecisionValidator (an independent critic pass on
    // the diff) + GovernanceEnforcer (contract-contradiction scan) combined into one composite
    // confidence score and halt decision.
    const gitDiffNamesOnly = gitDiffAgainstMain(ctx, ['diff', `${ctx.mainBranch}..HEAD`, '--name-only'], entry, index);
    const gitDiffFull = gitDiffAgainstMain(ctx, ['diff', `${ctx.mainBranch}..HEAD`], entry, index);
    const sentinelPrimeModifiedFiles = gitDiffNamesOnly
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter(Boolean);

    const sentinelPrimeResult = await new SentinelPrime().runFullObservation({
      buildRunId: buildIdOf(ctx),
      promptEntry: { id: entry.id, prompt: promptText, prompt_type: entry.prompt_type },
      promptIndex: index,
      projectPath: ctx.projectPath,
      gatesPassed: sentinel.passed,
      modifiedFiles: sentinelPrimeModifiedFiles,
      gitDiff: gitDiffFull,
      // Token-cost gate (System 5): only pay for DecisionValidator's full critic pass when the
      // build hasn't been consistently confident over roughly its last 5 prompts.
      recentAverageConfidence: ctx.healthMonitor.getRecentAverageConfidence(5),
    });

    renderProgress(
      'INFO',
      `[SENTINEL PRIME] Confidence: ${sentinelPrimeResult.confidenceScore.composite.toFixed(2)}`
    );

    if (sentinelPrimeResult.haltDecision.shouldHalt && !sentinelPrimeResult.haltDecision.autoRecoverable) {
      renderProgress(
        'FAIL',
        `[SENTINEL PRIME] HALT â€” ${sentinelPrimeResult.haltDecision.reason ?? 'unknown reason'}`
      );
      try {
        await onSentinelPrimeHalt(sentinelPrimeResult.id, ctx.projectPath, ctx.healthMonitor.getHealth());
      } catch (error) {
        log(`integration bus onSentinelPrimeHalt failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw new Error(`Sentinel Prime HALT: ${sentinelPrimeResult.haltDecision.reason ?? 'unknown reason'}`);
    } else if (sentinelPrimeResult.haltDecision.shouldHalt && sentinelPrimeResult.haltDecision.autoRecoverable) {
      renderProgress(
        'WARN',
        `[SENTINEL PRIME] WARN â€” ${sentinelPrimeResult.haltDecision.reason ?? 'unknown reason'}`
      );
    }

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
    // DEAD-LOOP DETECTION (src/governance/dead-loop-detection.ts, ENGINEERING_COMPLETENESS.md
    // section 38): populated below once recordFailureObserved has upserted this failure's
    // error_patterns/resolutions rows. When tripped, both the Build Brain targeted-fix attempt
    // and the Contract 14 autonomous-recovery re-run are skipped for this prompt (the spec's
    // literal "STOP RETRYING") in favor of immediate escalation.
    let deadLoopVerdict: DeadLoopVerdict | null = null;

    if (wasFailingInitially) {
      await recordFailureObserved({
        errorText: initialErrorText,
        failedCheck: initialFailedCheck,
        promptType: entry.prompt_type,
        projectName: ctx.projectName,
        stackFingerprint: ctx.stackFingerprint,
      }).catch((err) => log(`prompt ${index} '${entry.id}': recordFailureObserved non-fatal â€” ${describe(err)}`));

      try {
        deadLoopVerdict = await detectDeadLoop(initialErrorText);
        if (deadLoopVerdict.isDeadLoop) {
          log(
            `prompt ${index} '${entry.id}': [DEAD-LOOP DETECTION] ${deadLoopVerdict.reason} -- ` +
              `STOP RETRYING; recommended: ${deadLoopVerdict.recommendedActions.join(', ')}.`
          );
          await appendDeadLoopBlocker(join(ctx.projectPath, ctx.governanceDirName), ctx.buildRunId, entry, index, deadLoopVerdict);
        }
      } catch (error) {
        log(`prompt ${index} '${entry.id}': detectDeadLoop non-fatal -- ${describe(error)}`);
        deadLoopVerdict = null;
      }

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

      if (brainDiagnosis && !brainDiagnosis.escalate && brainDiagnosis.knownFix && !deadLoopVerdict?.isDeadLoop) {
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

    // DESIGN PIPELINE (component/page prompt types only): runs after Architecture Guardian and
    // the Contract-13 Sentinel gate, but strictly BEFORE the merge decision below â€” a passing
    // Sentinel result proves the code compiles/builds, it says nothing about whether a UI
    // prompt's output actually looks right, so a design-rejected prompt must never merge to main
    // on the strength of a green Sentinel alone. Runs only once Sentinel has already passed (no
    // point screenshotting code that doesn't build).
    const designReview: DesignReviewResult | null =
      sentinel.passed === true && SHADCN_INSTALL_PROMPT_TYPES.has(entry.prompt_type)
        ? await runDesignPipelineCheck(ctx, entry, index, changed)
        : null;
    const designRejected = designReview !== null && !designReview.approved;

    // BULLETPROOF GUARD (unconditional): if the most recently produced Sentinel result already
    // passed AND the design review (when it ran) did not reject this prompt, this prompt is done
    // â€” full stop. Recovery (Contract 14) exists ONLY to rescue a FAILING Sentinel; it must be
    // structurally unreachable whenever `sentinel.passed === true`. This check is repeated at
    // every point below where `sentinel` could feed a recovery call, so no future refactor of the
    // branches beneath it can accidentally route a green Sentinel into `runRecoveryImpl`.
    if (sentinel.passed === true && !designRejected) {
      // i. Merge to main + lightweight checkpoint tag (Contracts 10/11).
      mergeAndTag(ctx, index);
      disposition = 'completed';
      note = 'Sentinel passed â€” merged to main and checkpointed.';
    } else if (designRejected) {
      // Sentinel is green here (that is the only way `designRejected` can be true) â€” the sole
      // reason this prompt is not merging is the design review, so this does NOT go through
      // Contract 14's pattern-matched Sentinel recovery (`runRecoveryImpl`), which would
      // immediately escalate a never-before-seen "design review rejected" signature per its own
      // "novel error â†’ always escalate" rule. Instead: one direct re-run with the reviewer's
      // feedback appended (`DesignReviewResult.feedback`, already formatted as `DESIGN FEEDBACK:
      // ...` by `DesignPipeline.run`), mirroring Build Brain's targeted-fix pattern above, gated
      // on Autonomous Recovery being enabled â€” never merged before this resolves either way.
      const feedback = designReview?.feedback ?? 'DESIGN FEEDBACK: visual review did not approve this component.';
      if (ctx.autonomousRecoveryMode) {
        log(`prompt ${index} '${entry.id}': [DESIGN PIPELINE] rejected â€” retrying once with design feedback`);
        await ctx.liveStatus.promptPhase(
          { index, id: entry.id, name: entry.name, type: entry.prompt_type, phase: 'recovering' },
          'Design review rejected â€” re-running with reviewer feedback'
        );
        const designFixRun = await ctx.runClaudeImpl(`${promptText}\n\n${feedback}`, ctx.projectPath, timeoutMs);
        let designRecovered = false;
        if (designFixRun.success) {
          ctx.git.commitAll(
            `[FORGE] design-feedback-fix: ${entry.name}\n\nPrompt ${index} (${entry.id}) re-run with design review feedback.`
          );
          const designFixSentinel = await ctx.runSentinelImpl(sentinelOptions);
          designRecovered = designFixSentinel.passed;
          if (designRecovered) {
            sentinel = designFixSentinel;
            run = designFixRun;
          }
        } else {
          log(`prompt ${index} '${entry.id}': [DESIGN PIPELINE] feedback re-run claude call failed`);
        }
        if (designRecovered) {
          mergeAndTag(ctx, index);
          disposition = 'completed';
          note = 'Design review rejected, then recovered after a feedback re-run â€” merged to main and checkpointed.';
        } else {
          disposition = 'failed';
          note = `Design review rejected; feedback re-run did not restore approval: ${feedback}`;
        }
      } else {
        disposition = 'failed';
        note = `Design review rejected (Autonomous Recovery disabled): ${feedback}`;
      }
    } else if (ctx.autonomousRecoveryMode && !deadLoopVerdict?.isDeadLoop) {
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
    } else if (deadLoopVerdict?.isDeadLoop) {
      // DEAD-LOOP DETECTION tripped above: neither the Build Brain fix nor Contract 14's
      // autonomous-recovery re-run were attempted for this prompt (both gated on
      // `!deadLoopVerdict.isDeadLoop`) -- escalate immediately instead of burning another attempt.
      disposition = 'failed';
      note =
        `Dead loop detected -- STOP RETRYING (${deadLoopVerdict.reason}). ` +
        `Recommended: ${deadLoopVerdict.recommendedActions.join(', ')}.`;
    } else {
      disposition = 'failed';
      note = `Sentinel failed (${sentinel.failedCheck ?? 'unknown'}) â€” Autonomous Recovery disabled, escalating (Contract 14).`;
    }

    // UI ENGINE (Task 3/4): once this prompt has passed all Sentinel gates (`disposition ===
    // 'completed'`) AND is a component/page prompt (`ui`/`feature` are the real `PromptType`
    // analogs â€” see SHADCN_INSTALL_PROMPT_TYPES), statically scan every `.tsx` file this prompt
    // touched for WCAG 2.1 AA issues. Warn-only: never touches `disposition` (Contract 4 posture)
    // â€” a real accessibility defect is surfaced to the operator, not a reason to fail a build that
    // already passed every mandatory gate.
    let accessibilityIssueCount: number | null = null;
    if (disposition === 'completed' && SHADCN_INSTALL_PROMPT_TYPES.has(entry.prompt_type)) {
      accessibilityIssueCount = 0;
      const tsxFiles = [...changed.created, ...changed.modified].filter((f) => f.endsWith('.tsx'));
      for (const relativeFile of tsxFiles) {
        try {
          const code = await readFile(join(ctx.projectPath, relativeFile), 'utf8');
          const report = checkComponentAccessibility(relativeFile, code);
          if (report.issues.length > 0) {
            accessibilityIssueCount += report.issues.length;
            log(`[UI ENGINE] ACCESSIBILITY: ${report.issues.length} issues found in ${relativeFile}`);
            await appendAccessibilityReport(
              join(ctx.projectPath, ctx.governanceDirName),
              ctx.buildRunId,
              entry,
              index,
              relativeFile,
              report
            );
          }
        } catch (error) {
          log(`[UI ENGINE] accessibility check non-fatal for ${relativeFile} â€” ${describe(error)}`);
        }
      }
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

    // STATE MACHINE (observational) â€” log this prompt's derived TaskState
    // (`src/governance/build-state-machine.ts`), a pure function over the same outcome just
    // persisted above. Never blocks; matches the Invariant Engine's log-only posture (b2.8).
    const derivedTaskState = deriveTaskState({
      status: disposition === 'completed' ? 'completed' : 'failed',
      sentinel_passed: sentinel.passed,
      resolution_applied: recovery && recovery.attempted ? recovery.reason : null,
    });
    log(`[STATE MACHINE] prompt ${index} '${entry.id}': task state -> ${derivedTaskState}`);

    // STAGNATION DETECTION (observational, non-fatal) -- `src/governance/stagnation-detection.ts`,
    // ENGINEERING_COMPLETENESS.md section 39: "Even if tasks technically 'pass,' FORGE should
    // detect when progress stalls." Re-evaluated after every prompt from real build_runs +
    // prompt_executions rows; never blocks disposition. Appended to STATE_OF_THE_BUILD.md exactly
    // once per build (`ctx.stagnationWarned`), since the underlying condition persists across
    // every remaining prompt once tripped.
    if (ctx.buildRunId && !ctx.stagnationWarned.warned) {
      try {
        const stagnation = await detectStagnation(ctx.buildRunId);
        if (stagnation?.isStagnant) {
          ctx.stagnationWarned.warned = true;
          log(`prompt ${index} '${entry.id}': [STAGNATION DETECTION] ${stagnation.reason} Recommended: ${stagnation.recommendedAction}.`);
          await appendStagnationWarning(join(ctx.projectPath, ctx.governanceDirName), stagnation);
        }
      } catch (error) {
        log(`prompt ${index} '${entry.id}': detectStagnation non-fatal -- ${describe(error)}`);
      }
    }

    // BLAST RADIUS ANALYSIS (observational, non-fatal) â€” ENGINEERING_COMPLETENESS.md Â§ "Every
    // modification should trigger the question: 'What else could this affect?'". Reuses
    // Architecture Guardian's own import-graph machinery (`src/tools/architecture-guard.ts`),
    // inverted to reverse-dependency direction, to find every file that transitively imports a
    // file this prompt touched. Fire-and-forget, matching the dead-code-scan block immediately
    // below â€” a slow/failed analysis never delays or fails the prompt.
    const blastRadiusPaths = [...changed.created, ...changed.modified, ...changed.deleted];
    if (blastRadiusPaths.length > 0) {
      analyzeBlastRadius(ctx.projectPath, blastRadiusPaths)
        .then((radius) => {
          if (radius.transitivelyImpacted.length > 0) {
            log(
              `[BLAST RADIUS] prompt ${index} '${entry.id}': ${blastRadiusPaths.length} file(s) changed -> ` +
                `${radius.transitivelyImpacted.length} file(s) potentially impacted ` +
                `(${radius.impactedTestFiles.length} test file(s), ${radius.impactedApiRoutes.length} API route(s)).`
            );
          }
        })
        .catch((error) => log(`[BLAST RADIUS] analysis non-fatal for prompt ${index} '${entry.id}' â€” ${describe(error)}`));
    }

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
    const accessibilitySummarySuffix =
      accessibilityIssueCount !== null ? `, ${accessibilityIssueCount} accessibility issue(s)` : '';
    log(`prompt ${index} '${entry.id}': ${disposition} â€” ${note} (${humanDuration(durationMs)})${accessibilitySummarySuffix}`);
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
    getActiveRunRecorder()?.recordPromptEnd({
      index,
      id: entry.id,
      name: entry.name,
      disposition,
      durationMs,
      commitHash,
      failedCheck: disposition === 'completed' ? null : (sentinel.failedCheck ?? 'unknown check'),
    });
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
      confidenceScore: sentinelPrimeResult.confidenceScore.composite,
      accessibilityIssueCount,
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

/**
 * Deferred concurrent execution (parallel-scheduler.ts's `executeSchedule`, now enabled): the
 * `maxConcurrency > 1` counterpart to the classic sequential `for` loop in {@link runPhase3Executor}.
 * Walks the SAME dependency waves `executeSchedule` computes, but fans every dependency-satisfied
 * entry within a wave out onto its own linked git worktree (Contract 10: still one branch per
 * prompt, just isolated in its own working directory so N concurrent claude-runner calls never
 * collide on file writes or branch checkouts) and runs each through the SAME `executePrompt` the
 * sequential path uses, unmodified. Never starts wave N+1 until wave N has fully settled (a later
 * wave's entries may depend on an earlier wave's) â€” the concurrency is strictly INTRA-wave.
 *
 * Design choices specific to concurrency (recorded here since they are genuine judgment calls
 * about an inherently sequential-shaped contract, not bugs):
 *   - Every entry in a wave reads `schemaPromptsHaveRun`/`previousSentinel` as they stood at the
 *     START of the wave (intra-wave entries have, by construction, no dependency on one another,
 *     so none of them could legitimately need a wave-mate's OWN output). Snapshotted synchronously
 *     before the first `await` in each entry's execute callback so no sibling can race the read
 *     (Node is single-threaded and `GitManager` is execSync-based, so the synchronous prefix of
 *     every concurrently-kicked-off callback runs to completion, in order, before any of them
 *     resumes past its first await â€” see `runWithConcurrency` in parallel-scheduler.ts).
 *   - After a wave settles, `schemaPromptsHaveRun` becomes true if ANY entry the wave actually ran
 *     (not carried/skipped) was prompt_type 'schema'; `previousSentinel` becomes the Sentinel
 *     result of the highest-index entry the wave actually ran (a deterministic tie-break — "the
 *     last one in queue order" — among several concurrent siblings with no other ordering).
 *   - On a Sentinel failure, main is rolled back ONCE per halted wave (not once per failed entry,
 *     since concurrent siblings can fail together) to the highest prompt index THIS run has itself
 *     successfully merged + checkpointed (or the replay/--start-at carry boundary if nothing has
 *     merged yet) â€” the concurrent generalisation of the sequential path's `rollbackAndReport`'s
 *     `index - 1` rule, which only held because the immediately-preceding index was always the
 *     last completed entry in a strictly sequential walk.
 */
async function runPromptsConcurrently(
  ctx: LoopContext,
  schedule: ScheduleAnalysis,
  entries: readonly QueueEntry[],
  opts: {
    replay: ReplayOptions | null;
    startAt: number | undefined;
    skillsDir: string;
    maxConcurrency: number;
    previousSentinel: PreviousSentinelStatus | null;
    schemaPromptsHaveRun: boolean;
  }
): Promise<{
  outcomes: PromptOutcome[];
  halted: boolean;
  haltedAt: { index: number; id: string } | null;
  haltReason: string | null;
  schemaPromptsHaveRun: boolean;
  previousSentinel: PreviousSentinelStatus | null;
}> {
  const { log } = ctx;
  const orderIndex = new Map<string, number>(schedule.order.map((e, i) => [e.id, i + 1] as const));

  // Dry run: concurrency is meaningless (nothing executes) â€” assemble + predict every entry
  // sequentially, exactly as the sequential loop's own dry-run branch does.
  if (ctx.dryRun) {
    const outcomes: PromptOutcome[] = [];
    const previousSentinel = opts.previousSentinel;
    for (const entry of schedule.order) {
      const index = orderIndex.get(entry.id) ?? 0;
      const outcome = await runWithBuildContext({ promptId: entry.id }, () => dryRunPrompt(ctx, entry, index, previousSentinel));
      outcomes.push(outcome);
    }
    return { outcomes, halted: false, haltedAt: null, haltReason: null, schemaPromptsHaveRun: opts.schemaPromptsHaveRun, previousSentinel };
  }

  // Best-effort hygiene: drop stale linked-worktree metadata a prior crashed/interrupted concurrent
  // run left behind, so a reused worktree directory name never collides.
  try {
    ctx.git.pruneWorktrees();
  } catch {
    /* non-fatal */
  }

  const outcomes: PromptOutcome[] = [];
  const recordedIds = new Set<string>(); // ids already given a real PromptOutcome (carried/executed)
  let schemaPromptsHaveRun = opts.schemaPromptsHaveRun;
  let previousSentinel = opts.previousSentinel;
  let halted = false;
  let haltReason: string | null = null;
  let haltedAt: { index: number; id: string } | null = null;
  // The concurrent generalisation of "index - 1's checkpoint" â€” the highest prompt index this run
  // has itself successfully merged + checkpointed, seeded from wherever the replay / --start-at
  // carry boundary left off (mirrors the sequential path's `index > 1` rollback guard).
  let lastGoodIndex = Math.max((opts.replay?.fromPromptIndex ?? 1) - 1, (opts.startAt ?? 1) - 1, 0);

  const summary = await executeSchedule(entries, {
    log,
    maxConcurrency: opts.maxConcurrency,
    haltOnFailure: true,
    execute: async (entry, { wave: waveIndex }) => {
      const index = orderIndex.get(entry.id) ?? 0;

      // Replay carry / --start-at skip (F12 / start-at): identical semantics to the sequential
      // loop's own a0/a1 steps, just reached via the scheduler's execute callback instead of a
      // `for` loop. Recorded as a real PromptOutcome here (the post-loop reconciliation below only
      // synthesizes outcomes for entries `executeSchedule` itself skipped).
      if (opts.replay && index < opts.replay.fromPromptIndex) {
        const note = `Replay â€” carried from checkpoint (prompt ${index} < resume index ${opts.replay.fromPromptIndex}), not re-executed.`;
        outcomes.push(skippedOutcome(entry, index, note));
        recordedIds.add(entry.id);
        if (entry.prompt_type === 'schema') schemaPromptsHaveRun = true;
        log(`prompt ${index}/${schedule.order.length} '${entry.id}': ${note}`);
        return { success: true, note };
      }
      if (opts.startAt !== undefined && index < opts.startAt) {
        const note = `Skipped â€” --start-at ${opts.startAt}: prompt ${index} is before the requested start index.`;
        outcomes.push(skippedOutcome(entry, index, note));
        recordedIds.add(entry.id);
        if (entry.prompt_type === 'schema') schemaPromptsHaveRun = true;
        log(`[--start-at] skipping prompt ${index}/${schedule.order.length} '${entry.id}'`);
        return { success: true, note };
      }

      // Snapshot the wave-start shared state BEFORE any `await` (see doc comment above) so every
      // sibling in this wave reads the identical previousSentinel/schemaPromptsHaveRun value.
      const waveSchema = schemaPromptsHaveRun;
      const wavePrevious = previousSentinel;

      // Skill injection (identical to the sequential loop's own step).
      let entryForExec = entry;
      if (entry.skills && entry.skills.length > 0) {
        const skillContent = await loadSkillContent(entry.skills, opts.skillsDir, log);
        if (skillContent) {
          entryForExec = { ...entry, description: `${skillContent}\n\n---\n\n${entry.description}` };
          log(`prompt ${index} '${entry.id}': prepended ${entry.skills.length} skill(s) (${entry.skills.join(', ')})`);
        }
      }

      // Contract-10 fan-out: one linked git worktree per concurrent entry, checked out detached at
      // main's current tip; the entry then creates its OWN feature branch inside it exactly as the
      // sequential path does (via `executePrompt`'s own `ctx.git.createBranch` call, unmodified).
      const worktree = ctx.git.createWorktree(buildIdOf(ctx), index, entry.name);
      if (!worktree.success) {
        const note = `Concurrent worktree creation failed for prompt ${index} '${entry.id}': ${worktree.error ?? 'unknown git error'}`;
        log(`ERROR: ${note}`);
        const failedOutcome: PromptOutcome = {
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
          durationMs: 0,
          sentinel: null,
          recovery: null,
          note,
        };
        outcomes.push(failedOutcome);
        recordedIds.add(entry.id);
        return { success: false, note };
      }

      const entryGit = new GitManager({
        cwd: worktree.worktreePath,
        mainBranch: ctx.mainBranch,
        log: (m) => log(`git[wt ${index}]: ${m}`),
        mergeDelegate: (branchName) => ctx.git.mergeBranchToMain(branchName),
        tagDelegate: (buildId, promptIndex) => ctx.git.tagCheckpoint(buildId, promptIndex),
      });
      const entryCtx: LoopContext = { ...ctx, projectPath: worktree.worktreePath, git: entryGit };

      const outcome = await runWithBuildContext({ promptId: entry.id }, () =>
        executePrompt(entryCtx, entryForExec, index, wavePrevious, waveSchema)
      );
      outcomes.push(outcome);
      recordedIds.add(entry.id);

      // Post-execution bookkeeping mirrored from the sequential loop's own step (learning engine,
      // cost/health telemetry, live status) â€” see runPhase3Executor's `for` loop for the sequential
      // twin of every call below.
      const realTechStackTags = deriveStackTags(ctx.stackFingerprint);
      const changedThisPrompt = filesChanged(entryCtx);
      onPromptComplete({
        promptId: entry.id,
        success: outcome.disposition === 'completed',
        retryCount: outcome.recovery?.attempted ? 1 : 0,
        tokensConsumed: outcome.tokensEstimated,
        gatePassRate: outcome.sentinel?.passed ? 1.0 : 0.0,
        errorOutput: outcome.sentinel?.diagnosticReport ?? undefined,
        buildId: ctx.buildRunId ?? '',
        projectName: ctx.projectName,
        taskType: mapPromptTypeToTaskType(entry.prompt_type),
        techStackTags: realTechStackTags.length > 0 ? realTechStackTags : ['typescript'],
        templateHash: outcome.promptHash,
      });

      try {
        const memoryClient = BuildMemory.getClient();
        if (memoryClient && outcome.sentinel) {
          observeRewriteOutcome(entry.id, outcome.wasRewritten, outcome.sentinel.passed, memoryClient);
        }
      } catch {
        /* non-fatal â€” Contract 4 */
      }

      try {
        const { handlePostToolUse } = await import('../learning/hooks-enhanced.js');
        await handlePostToolUse({
          buildId: ctx.buildRunId ?? '',
          promptId: entry.id,
          taskType: mapPromptTypeToTaskType(entry.prompt_type),
          techStackTags: realTechStackTags.length > 0 ? realTechStackTags : ['typescript', 'nextjs'],
          firstPassSuccess: outcome.disposition === 'completed',
          retryCount: outcome.recovery?.attempted ? 1 : 0,
          tokensConsumed: outcome.tokensEstimated,
          gatPassRate: outcome.disposition === 'completed' ? 1 : 0,
          errorOutput: outcome.sentinel?.diagnosticReport ?? '',
          filesModified: [...changedThisPrompt.created, ...changedThisPrompt.modified],
          projectName: ctx.projectName,
        });
      } catch {
        /* non-fatal */
      }

      const completedSoFar = outcomes.filter((o) => o.disposition === 'completed').length;
      const failedSoFar = outcomes.filter((o) => o.disposition === 'failed').length;
      const totalElapsedMs = outcomes.reduce((sum, o) => sum + o.durationMs, 0);
      log(
        `prompt ${index} '${entry.id}' (wave ${waveIndex}): ${humanDuration(outcome.durationMs)} this prompt, ` +
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

      ctx.healthMonitor.recordPromptResult(
        outcome.disposition === 'completed',
        outcome.confidenceScore ?? (outcome.disposition === 'completed' ? 1 : 0)
      );
      await ctx.healthMonitor.shouldPause();

      if (entry.prompt_type === 'schema') schemaPromptsHaveRun = true;
      if (outcome.sentinel) previousSentinel = toPreviousSentinelStatus(outcome.sentinel, entry.name, index);

      if (outcome.disposition === 'completed') {
        lastGoodIndex = Math.max(lastGoodIndex, index);
      } else if (outcome.disposition === 'failed') {
        try {
          await onSentinelFailure(outcome.sentinel?.failedCheck ?? 'unknown', entry.id, ctx.buildRunId ?? '', ctx.projectPath);
        } catch (error) {
          log(`integration bus onSentinelFailure failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Best-effort worktree cleanup â€” run from the PRIMARY (never from inside the worktree being
      // removed). A failure here never affects this entry's own disposition (Contract 4 posture).
      try {
        ctx.git.removeWorktree(worktree.worktreePath);
      } catch {
        /* non-fatal */
      }

      return { success: outcome.disposition === 'completed', note: outcome.note };
    },
  });

  // Reconcile entries `executeSchedule` itself skipped (unmet dependency, or an earlier wave in
  // this same run halted) â€” these never reached the execute callback above, so they have no
  // PromptOutcome yet. Entries already recorded above (carried/--start-at/executed) are left alone.
  for (const o of summary.outcomes) {
    if (o.status !== 'skipped' || recordedIds.has(o.entry.id)) continue;
    const index = orderIndex.get(o.entry.id) ?? 0;
    outcomes.push(skippedOutcome(o.entry, index, o.note));
    recordedIds.add(o.entry.id);
    log(`prompt ${index}/${schedule.order.length} '${o.entry.id}': ${o.note}`);
  }
  outcomes.sort((a, b) => a.index - b.index);

  // Halt handling (Contract 13): find the halted wave's failed entries (there may be more than one
  // â€” concurrent siblings can fail together), roll main back ONCE, and report the halt using the
  // lowest-index failure as the representative (generalises the sequential path's single-failure
  // halt report to "first in queue order" when several fail at once).
  if (summary.halted) {
    const failedThisWave = outcomes
      .filter((o) => o.disposition === 'failed')
      .filter((o) => {
        const wave = schedule.waves.find((w) => w.entries.some((e) => e.id === o.id));
        return wave?.index === summary.haltedAtWave;
      })
      .sort((a, b) => a.index - b.index);
    const primary = failedThisWave[0] ?? outcomes.filter((o) => o.disposition === 'failed').sort((a, b) => a.index - b.index)[0] ?? null;

    halted = true;
    if (primary) {
      haltedAt = { index: primary.index, id: primary.id };
      haltReason =
        primary.recovery?.reason ??
        `Sentinel failed at prompt ${primary.index} '${primary.id}' (${primary.sentinel?.failedCheck ?? 'unknown'}) ` +
          `and was not auto-recovered${failedThisWave.length > 1 ? ` (${failedThisWave.length} entries failed in wave ${summary.haltedAtWave})` : ''}.`;

      // Roll main back to the last checkpoint THIS run actually created (or the replay/--start-at
      // carry boundary if nothing has merged yet) â€” see the concurrency doc comment above for why
      // this differs from the sequential path's plain `index - 1`.
      if (lastGoodIndex >= 1) {
        const tag = checkpointTagName(buildIdOf(ctx), lastGoodIndex);
        const rollback = ctx.git.rollbackToCheckpoint(tag);
        if (!rollback.success) {
          log(`halt: rollback to ${tag} failed â€” ${rollback.error ?? 'unknown'} (feature branch(es) preserved regardless)`);
        } else {
          log(`halt: main reset to last checkpoint ${tag}; feature branch(es) preserved`);
        }
      }

      const report = [
        '# FORGE Phase 3 â€” HALT (concurrent execution)',
        '',
        `- **Halted at:** wave ${summary.haltedAtWave ?? 'unknown'}, prompt ${primary.index} '${primary.id}' (${primary.promptType})`,
        `- **Reason:** ${haltReason}`,
        `- **Feature branch (preserved):** ${primary.branchName ?? '(none)'}`,
        failedThisWave.length > 1
          ? `- **Other failures this wave:** ${failedThisWave
              .slice(1)
              .map((o) => `${o.id} (branch ${o.branchName ?? '(none)'})`)
              .join(', ')}`
          : null,
        `- **When:** ${nowIso()}`,
        '',
        '## Sentinel diagnostic',
        '',
        primary.sentinel?.diagnosticReport ?? '(no Sentinel report captured)',
      ]
        .filter((line): line is string => line !== null)
        .join('\n');

      await ctx.writeHaltReport(report);
      try {
        await ctx.updateStateProgress(
          `[FORGE Phase 3] HALTED at wave ${summary.haltedAtWave ?? 'unknown'}, prompt ${primary.index} '${primary.id}': ${haltReason}`
        );
      } catch {
        /* state update is non-fatal */
      }
    } else {
      haltReason = `Concurrent execution halted (wave ${summary.haltedAtWave ?? 'unknown'}) but the specific failing entry could not be resolved.`;
    }
  }

  return { outcomes, halted, haltedAt, haltReason, schemaPromptsHaveRun, previousSentinel };
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

/**
 * Read the files this branch changed relative to main (for the prompt_execution record and
 * CHANGESET.md). Falls back to the branch's own latest commit (`HEAD~1..HEAD`) when the
 * three-dot diff against main shows nothing productive (e.g. the feature branch has already
 * converged with main) â€” the same fallback `phase4-sentinel.ts`'s file_delta check already
 * applies; without it, a prompt that did real, committed work could still be recorded here as
 * having changed no files at all.
 */
function filesChanged(ctx: LoopContext): { created: string[]; modified: string[]; deleted: string[] } {
  const bucket = (files: readonly { path: string; status: string }[]): { created: string[]; modified: string[]; deleted: string[] } => {
    const created: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const f of files) {
      const kind = classifyChange(f.status);
      if (kind === 'created') created.push(f.path);
      else if (kind === 'modified') modified.push(f.path);
      else if (kind === 'deleted') deleted.push(f.path);
    }
    return { created, modified, deleted };
  };

  const diff = ctx.git.getBranchDiff();
  if (diff.success && diff.files.length > 0) return bucket(diff.files);

  const headDiff = ctx.git.getHeadDiff();
  if (headDiff.success && headDiff.files.length > 0) return bucket(headDiff.files);

  return { created: [], modified: [], deleted: [] };
}

/** Poll interval for the post-run git quiescence check. */
const QUIESCENCE_POLL_INTERVAL_MS = 2000;
/** Max time to wait for the working tree to settle before giving up and committing anyway. */
const QUIESCENCE_MAX_WAIT_MS = 30000;
/** Consecutive identical `git status --porcelain` reads required to call the tree quiescent. */
const QUIESCENCE_STABLE_READS = 3;

/**
 * Guard against claude backgrounding work (a `run_in_background` Bash call, or a background
 * Agent/subagent) that outlives the `claude -p` process's own exit. `runClaudeImpl` only awaits
 * the top-level process's `close` event â€” it has no visibility into a detached grandchild still
 * writing to the working tree. Poll `git status --porcelain` until it reads identical for
 * QUIESCENCE_STABLE_READS consecutive samples (or the max wait elapses) so commitAll never
 * snapshots a tree that's still being written to. Best-effort (Iron Law 3 posture, matching the
 * rest of this file's degrade-gracefully checks): on timeout this logs a warning and proceeds
 * rather than hanging the build forever.
 */
async function waitForGitQuiescence(ctx: LoopContext, index: number): Promise<void> {
  const startedAt = Date.now();
  let lastStatus: string | null = null;
  let stableCount = 0;

  while (Date.now() - startedAt < QUIESCENCE_MAX_WAIT_MS) {
    const status = ctx.git.statusPorcelain();
    const current: string = status.success ? status.stdout : (lastStatus ?? '');
    stableCount = current === lastStatus ? stableCount + 1 : 1;
    lastStatus = current;

    if (stableCount >= QUIESCENCE_STABLE_READS) {
      ctx.log(
        `prompt ${index}: working tree quiescent after ${Math.round((Date.now() - startedAt) / 1000)}s`
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, QUIESCENCE_POLL_INTERVAL_MS));
  }

  ctx.log(
    `prompt ${index}: WARNING â€” working tree did not settle within ` +
      `${Math.round(QUIESCENCE_MAX_WAIT_MS / 1000)}s (possible backgrounded claude task still ` +
      `writing) â€” proceeding with commit anyway`
  );
}

/**
 * Run one `git diff` variant against the configured main branch, for Sentinel Prime's (System 5)
 * post-gate observation pass. Never throws (Iron Law 3) â€” a failure (e.g. no commits yet on this
 * branch) is logged and degrades to an empty string rather than aborting the prompt.
 */
function gitDiffAgainstMain(ctx: LoopContext, args: readonly string[], entry: QueueEntry, index: number): string {
  try {
    return execSync(`git ${args.join(' ')}`, {
      cwd: ctx.projectPath,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    ctx.log(`prompt ${index} '${entry.id}': git ${args.join(' ')} failed â€” ${describe(error)}`);
    return '';
  }
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
 * Autonomous Supabase migration failures happen AFTER the build_run is already finalized
 * 'completed' â€” they must never reopen or fail that build (Contract 4), but a failed migration
 * against a live database is exactly the kind of thing a human needs to see. Appends a BLOCKER
 * entry to STATE_OF_THE_BUILD.md (deliberately outside Sentinel's protected doc set, same
 * convention as `onSentinelPrimeHalt`'s SESSION_STATE.md blocker in src/integration/bus.ts).
 * Guarded â€” a write failure here must never affect an already-finalized build.
 */
async function appendMigrationBlocker(
  governanceDir: string,
  buildRunId: string | null,
  failed: readonly MigrationResult[]
): Promise<void> {
  try {
    const block = [
      '',
      '## [FORGE Phase 3] BLOCKER — SupabaseMigrator',
      `- Build: ${buildRunId ?? '(stateless)'}`,
      ...failed.map((f) => `- Migration FAILED: ${f.migrationFile} — ${f.error ?? 'unknown error'}`),
      `- Timestamp: ${nowIso()}`,
      '',
    ].join('\n');
    await mkdir(governanceDir, { recursive: true });
    await appendFile(join(governanceDir, 'STATE_OF_THE_BUILD.md'), toAsciiGovernanceText(block), 'utf8');
  } catch {
    /* non-fatal â€” a blocker write failure must never affect an already-finalized build */
  }
}

/**
 * UI ENGINE (Task 3): append a non-blocking accessibility WARNING to STATE_OF_THE_BUILD.md's
 * build report, mirroring {@link appendMigrationBlocker}'s precedent for a different non-fatal,
 * report-worthy condition â€” except this is a WARNING section, never a BLOCKER, since accessibility
 * issues never fail the build (warn-only).
 */
async function appendAccessibilityReport(
  governanceDir: string,
  buildRunId: string | null,
  entry: QueueEntry,
  index: number,
  filePath: string,
  report: AccessibilityReport
): Promise<void> {
  try {
    const block = [
      '',
      '## [FORGE Phase 3] WARNING â€” UI Engine accessibility',
      `- Build: ${buildRunId ?? '(stateless)'}`,
      `- Prompt ${index} '${entry.id}' (${entry.prompt_type}): ${filePath}`,
      ...report.issues.map((i) => `- [${i.severity}] ${i.rule}: ${i.description} Fix: ${i.fix}`),
      `- Score: ${report.score}/100`,
      `- Timestamp: ${nowIso()}`,
      '',
    ].join('\n');
    await mkdir(governanceDir, { recursive: true });
    await appendFile(join(governanceDir, 'STATE_OF_THE_BUILD.md'), toAsciiGovernanceText(block), 'utf8');
  } catch {
    /* non-fatal â€” an accessibility-report write failure must never affect the build's disposition */
  }
}

/**
 * DEAD-LOOP DETECTION: append a BLOCKER entry to STATE_OF_THE_BUILD.md the moment a prompt's
 * failure signature is confirmed a dead loop, mirroring {@link appendMigrationBlocker}'s
 * precedent -- a real BLOCKER (not a WARNING), since this prompt's disposition is genuinely
 * failing/escalating as a direct result, not merely something worth flagging alongside a pass.
 * Guarded -- a write failure here must never affect the prompt's already-decided disposition.
 */
async function appendDeadLoopBlocker(
  governanceDir: string,
  buildRunId: string | null,
  entry: QueueEntry,
  index: number,
  verdict: DeadLoopVerdict
): Promise<void> {
  try {
    const block = [
      '',
      '## [FORGE Phase 3] BLOCKER -- Dead-Loop Detection',
      `- Build: ${buildRunId ?? '(stateless)'}`,
      `- Prompt ${index} '${entry.id}' (${entry.prompt_type})`,
      `- Error family occurrences: ${verdict.errorFamilyOccurrences} (threshold ${DEAD_LOOP_ERROR_FAMILY_THRESHOLD})`,
      `- Remediation class '${verdict.remediationClassType ?? 'unknown'}' attempts: ${verdict.remediationClassAttempts} (threshold ${DEAD_LOOP_REMEDIATION_CLASS_THRESHOLD})`,
      `- Recommended: ${verdict.recommendedActions.join(', ')}`,
      `- Timestamp: ${nowIso()}`,
      '',
    ].join('\n');
    await mkdir(governanceDir, { recursive: true });
    await appendFile(join(governanceDir, 'STATE_OF_THE_BUILD.md'), toAsciiGovernanceText(block), 'utf8');
  } catch {
    /* non-fatal -- a blocker write failure must never affect the prompt's already-decided disposition */
  }
}

/**
 * STAGNATION DETECTION: append a WARNING (not a BLOCKER -- individual prompts may still be
 * passing; this is an observational signal about the build's overall trajectory, never a reason
 * to fail a prompt) to STATE_OF_THE_BUILD.md the first time a build is judged stalled. Guarded --
 * a write failure here must never affect any prompt's disposition.
 */
async function appendStagnationWarning(governanceDir: string, verdict: StagnationVerdict): Promise<void> {
  try {
    const block = [
      '',
      '## [FORGE Phase 3] WARNING -- Stagnation Detection',
      `- Build: ${verdict.buildRunId}`,
      `- Elapsed: ${verdict.elapsedHours.toFixed(1)}h, attempts made: ${verdict.attemptsMade}`,
      `- Progress: ${verdict.completedCount}/${verdict.totalPrompts} prompts completed (${(verdict.progressRatio * 100).toFixed(1)}%)`,
      `- Recommended: ${verdict.recommendedAction}`,
      `- Timestamp: ${nowIso()}`,
      '',
    ].join('\n');
    await mkdir(governanceDir, { recursive: true });
    await appendFile(join(governanceDir, 'STATE_OF_THE_BUILD.md'), toAsciiGovernanceText(block), 'utf8');
  } catch {
    /* non-fatal -- a warning write failure must never affect any prompt's disposition */
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


