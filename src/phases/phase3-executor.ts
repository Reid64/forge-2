/**
 * FORGE 2.0 — Phase 3: Build Executor (the main build loop, queue.yaml s5-p05).
 *
 * Phase 3 is where FORGE actually BUILDS. It consumes the approved `queue.yaml` (Queue
 * Generator s4-p02) and walks the prompts in dependency order, driving each one through the
 * engine pieces the prior s5 prompts authored. For EACH prompt (BEHAVIORAL_CONTRACTS Contract
 * 1 — Phase 4 runs after EVERY Phase 3 prompt), the loop performs the s5-p05 sequence:
 *
 *   a. Check the prompt's dependencies have completed (the schedule is topological, so they
 *      precede it — a missing/failed dependency SKIPS the dependent rather than mis-building).
 *   b. Run the failure-predictor (Contract 8) for `{ promptType, stackFingerprint, index }`.
 *   c. Assemble the prompt (Contract 7 — never hardcoded) via the prompt-assembler, injecting
 *      the relevant governance excerpts + Build Memory warnings + the PREVIOUS prompt's Sentinel
 *      status; then, if the predicted failure probability > 0.4, rewrite it (Contract 9) — the
 *      rewriter operates ON the assembled prompt (it prepends a restructured approach), so
 *      assembly necessarily precedes the rewrite even though the spec lists them c-then-d.
 *   d. Create the Contract-10 feature branch `forge/{build}/prompt-{i}-{name}` (git-manager).
 *   e. Execute the prompt through the claude-runner (`claude -p --dangerously-skip-permissions`,
 *      Contract 5) in the TARGET project root (Contract 6), then commit the work to the branch.
 *   f. Log a `prompt_executions` row to Build Memory (Contract 4 — guarded; never blocks).
 *   g. Run the Phase 4 Sentinel (the five Contract-13 health checks).
 *   h. PASS → merge the branch to main + lightweight checkpoint tag (Contracts 10/11). FAIL →
 *      if Autonomous Recovery Mode is on, run the Contract-14 self-heal loop; if it recovers,
 *      merge + tag; otherwise HALT the build (Contract 13) — the feature branch is preserved
 *      and main is rolled back to the last checkpoint (Contract 12), with a halt report written.
 *   i. Update STATE_OF_THE_BUILD.md from the live progress (BLUEPRINT Canonical Rule 9).
 *
 * On completion the `build_runs` row is finalized (`completed` / `failed` / `halted`) with the
 * aggregate counts and token estimate.
 *
 * SEQUENTIAL is the default (s5-p05): the executor walks the parallel-scheduler's topological
 * `order`. The scheduler also exposes the dependency WAVES + declared parallel groups for a
 * future parallel executor — but parallel fan-out is "Phase 2 of FORGE 2.0 usage", not built here.
 *
 * NON-FATAL house style: every collaborator (claude-runner, git-manager, Sentinel, the predictor,
 * the assembler, the rewriter, all Build Memory CRUD) already NEVER throws — they report failure
 * in their result. The loop additionally wraps each prompt so one unexpected error can never abort
 * the whole build uncaught (Iron Law 3 — report the real outcome, never fabricate a pass). Build
 * Memory being unreachable degrades to stateless mode (Contract 4), it does not block the build.
 * Every collaborator is INJECTABLE so the executor unit-tests with no `claude`, no git, and no DB.
 * `runPhase3Executor` never rejects.
 *
 * BOUNDARY: the executor operates on the TARGET project directory (`projectPath`) — claude runs
 * there, git runs there, Sentinel inspects it. It never touches FORGE's own governance files
 * (Iron Law 1); the only files it writes in the target are the work claude produces, the state
 * documents (Canonical Rule 9), and, on a halt, the halt report.
 *
 * REPLAY (F12 / BLUEPRINT Build Replay): set `options.replay` to re-execute an existing build
 * from a checkpoint forward. The executor (1) creates a NEW build_run linked back to the original
 * (the linkage rides in `toolchain_manifest._forge_replay`, since SCHEMA_REGISTRY's build_runs has
 * no dedicated parent column and the registry is read-only — Iron Law 1); (2) hard-resets main to
 * the supplied Contract-11 checkpoint tag (git-manager rollback); (3) reloads the governance
 * package from CURRENT disk (it may have been edited since the original build — the whole point of
 * a replay); (4) re-walks the queue, CARRYING every prompt before the resume index (those are
 * already present in the checkpoint — recorded as `skipped` with a replay note and treated as
 * satisfied dependencies) and re-executing the resume index forward exactly like a fresh build.
 * The new build's branches/tags use the NEW build id, so a replay never collides with the original.
 *
 * DRY RUN (F11 / Dry Run Mode): set `options.dryRun` to SIMULATE without executing. Phase 3 in dry
 * run assembles EVERY prompt (real assembler) and runs the failure-predictor on each, but never
 * touches claude/git/Sentinel — zero build-execution tokens are consumed. It then runs the
 * cost-estimator for the full build and emits a {@link SimulationReport} on the result: the
 * predicted prompt plan, the prompts predicted to error (probability > the rewrite threshold), the
 * predicted dollar cost + wall-clock time (with confidence bands), and the token estimate. Phases
 * 0/1/2 (the real environment check, design generation, and governance generation) run BEFORE
 * Phase 3 regardless — they are the executor's inputs (the queue + governance it consumes) and are
 * the orchestrator's responsibility; they are real in a dry run because they consume no build
 * tokens. The executor accepts the Phase 1 `features` (for the cost estimate) and, lacking them,
 * derives an approximate scope from the queue so the report is always complete (with a warning).
 */

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { load as parseYaml } from 'js-yaml';

import type { ContextInjection, PromptType, QueueEntry } from '../engine/queue-generator.js';
import { analyzeSchedule, type ScheduleAnalysis } from '../engine/parallel-scheduler.js';
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
import { runClaude, type ClaudeRunResult } from '../engine/claude-runner.js';
import { GitManager } from '../engine/git-manager.js';
import {
  runSentinel,
  runAutonomousRecovery,
  toPreviousSentinelStatus,
  normalizeErrorSignature,
  type SentinelResult,
  type SentinelOptions,
  type AutoRecoveryResult,
} from './phase4-sentinel.js';
import type { StackFingerprint } from '../tools/stack-detector.js';
import type { Instinct, JsonObject } from '../types/index.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import { CodebaseRag } from '../tools/codebase-rag.js';
import { logLine, setLogContext, clearLogContext, runWithBuildContext } from '../tools/forge-logger.js';
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

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Per-prompt disposition after the executor has handled it. */
export type PromptDisposition =
  | 'completed' // executed, Sentinel passed (or auto-recovered), merged + checkpointed
  | 'failed' // executed but Sentinel failed and could not be recovered (build then halts)
  | 'skipped' // a dependency did not complete, or dry-run
  | 'halted'; // not reached — an earlier prompt halted the build

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
  /** SHA-256 of the prompt actually executed (rewritten hash when rewritten). */
  promptHash: string;
  /** The `prompt_executions.id` Build Memory assigned, or null in stateless mode. */
  promptExecutionId: string | null;
  /** Coarse token estimate for this prompt (claude-runner heuristic). */
  tokensEstimated: number;
  /** The Sentinel result (null when not run — skipped/dry-run). */
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
  /** The `build_runs.id` of the build being replayed — the new build links back to it. */
  originalBuildRunId: string;
  /**
   * The Contract-11 lightweight checkpoint tag to hard-reset main to before re-executing
   * (e.g. `forge-checkpoint-<original-build-id>-3`). Use the ORIGINAL build's tag.
   */
  fromCheckpointTag: string;
  /**
   * 1-based position in the executed order to RESUME from. Every prompt before this index is
   * assumed already present in the checkpoint — it is carried (not re-executed) and counts as a
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
  /** Expected number of failing prompts = Σ per-prompt probability (the per-queue estimate). */
  expectedFailureCount: number;
  /** Token estimate summed from the assembled prompts (precise to this queue). */
  assembledTokenEstimate: number;
  /** The cost-estimator's full-build estimate (cost/time/tokens/failures with bands), or null. */
  costEstimate: BuildEstimate | null;
  /** Predicted dollar cost with a band (from the cost estimate), or null when it degraded. */
  predictedCostUsd: MetricEstimate | null;
  /** Predicted wall-clock time with a band + human string (from the cost estimate), or null. */
  predictedTimeMs: (MetricEstimate & { human: string }) | null;
  /** Non-fatal observations specific to the simulation (approximate scope, estimator degrade, …). */
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
  /** Non-fatal observations (queue parse warnings, stateless degrade, …). */
  warnings: string[];
  generatedAt: string;
}

/** A re-execution of the failed prompt for Autonomous Recovery (wraps claude + commit). */
export interface RerunPromptFn {
  (): Promise<{ success: boolean; output: string }>;
}

/** Options for {@link runPhase3Executor}. */
export interface Phase3Options {
  /** Target project root — claude runs here, git runs here, Sentinel inspects here (Contract 6). */
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
  /** Simulate only — assemble + predict, but do NOT run claude/git/Sentinel. Default false. */
  dryRun?: boolean;
  /**
   * Build Replay (F12): when set, this run resumes the {@link ReplayOptions.originalBuildRunId}
   * build from {@link ReplayOptions.fromCheckpointTag} / {@link ReplayOptions.fromPromptIndex}.
   */
  replay?: ReplayOptions;
  /**
   * The Phase 1 feature list, used by the dry-run cost estimate (F11). When omitted in a dry run
   * the executor derives an approximate scope from the queue (and warns). Ignored when not a dry run.
   */
  features?: Array<FeatureSpec | string>;
  /** The main branch merges target / rollback resets. Default `'main'`. */
  mainBranch?: string;
  /** Per-prompt claude timeout (ms). Default: claude-runner's 15 minutes. */
  claudeTimeoutMs?: number;

  // -- injectable collaborators (tests) -------------------------------------
  /** Override the claude execution. Default: {@link runClaude}. */
  runClaudeImpl?: (prompt: string, cwd: string) => Promise<ClaudeRunResult>;
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

/** The governance documents the assembler may inject — read into the doc map for assembly. */
const GOVERNANCE_DOC_NAMES: readonly string[] = [
  'BLUEPRINT.md',
  'SCHEMA_REGISTRY.md',
  'BEHAVIORAL_CONTRACTS.md',
  'INTERACTION_MAPS.md',
  'AGENTS.md',
  'TESTING.md',
];

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
 * Parse queue.yaml text into {@link QueueEntry}[]. Tolerant of the Queue Generator's emitted
 * shape (snake_case `context_injection`, flow-list dependencies, `|` block description). A
 * malformed entry is skipped with a warning rather than throwing. Returns the entries + warnings.
 */
export function parseQueueYaml(yamlText: string): { entries: QueueEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (error) {
    warnings.push(`queue.yaml is not valid YAML (${describe(error)}) — no prompts parsed.`);
    return { entries: [], warnings };
  }
  if (!Array.isArray(doc)) {
    warnings.push('queue.yaml did not parse to a list of prompts — no prompts parsed.');
    return { entries: [], warnings };
  }

  const entries: QueueEntry[] = [];
  doc.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push(`queue.yaml entry #${i + 1} is not a mapping — skipped.`);
      return;
    }
    const o = raw as Record<string, unknown>;
    const id = asString(o.id).trim();
    if (id === '') {
      warnings.push(`queue.yaml entry #${i + 1} has no id — skipped.`);
      return;
    }
    const rawType = asString(o.prompt_type).trim();
    const promptType = (PROMPT_TYPES.has(rawType) ? rawType : 'feature') as PromptType;
    if (!PROMPT_TYPES.has(rawType)) {
      warnings.push(`queue.yaml entry '${id}' has unknown prompt_type '${rawType}' — defaulted to 'feature'.`);
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
    entries.push(entry);
  });

  return { entries, warnings };
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
      /* missing doc — the assembler records it as a visible note (Contract 7). */
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

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 3 against `projectPath`: walk the build queue in dependency order, driving each
 * prompt through predict → assemble → (rewrite) → branch → claude → Sentinel → merge/checkpoint
 * or halt/auto-recover, logging to Build Memory throughout (queue.yaml s5-p05). Sequential is
 * the default. Always resolves — every collaborator is guarded and the loop never throws.
 */
export async function runPhase3Executor(options: Phase3Options): Promise<Phase3Result> {
  const log = options.log ?? logLine('phase3');
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

  // Collaborators (defaults wired to the real engine pieces; all injectable for tests). Each
  // const is explicitly annotated so the default arrow is contextually typed (params inferred)
  // and a `??` never synthesises a union-of-functions call site.
  const runClaudeImpl: NonNullable<Phase3Options['runClaudeImpl']> =
    options.runClaudeImpl ??
    ((prompt, cwd) =>
      runClaude(prompt, options.claudeTimeoutMs !== undefined ? { cwd, timeoutMs: options.claudeTimeoutMs } : { cwd }));
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
  if (options.entries === undefined) {
    const queuePath = options.queuePath ?? join(projectPath, 'queue.yaml');
    let yamlText: string | null = null;
    try {
      yamlText = await readFile(queuePath, 'utf8');
    } catch (error) {
      warnings.push(`Could not read queue.yaml at ${queuePath} (${describe(error)}) — nothing to execute.`);
      log(`WARNING: could not read ${queuePath} (${describe(error)})`);
    }
    if (yamlText !== null) {
      const parsed = parseQueueYaml(yamlText);
      entries = parsed.entries;
      warnings.push(...parsed.warnings);
    }
  }

  // 1b. Dependency analysis (topological order + waves + parallel groups). Sequential = `order`.
  const schedule = analyzeSchedule(entries, { log: (m) => log(`scheduler: ${m}`) });
  warnings.push(...schedule.warnings);

  log(
    `Phase 3 ${dryRun ? '(DRY RUN) ' : ''}${replay ? '(REPLAY) ' : ''}on "${projectName}": ` +
      `${schedule.order.length} prompt(s), ${schedule.longestChain} wave(s), ` +
      `max parallelism ${schedule.maxParallelism}. Sequential execution.` +
      (replay ? ` Resuming build ${replay.originalBuildRunId} from prompt ${replay.fromPromptIndex} (${replay.fromCheckpointTag}).` : '')
  );

  // 2. Create the build_run (status running). Guarded — degrades to stateless (Contract 4). For a
  //    replay the new build links back to the original via a `_forge_replay` block in the
  //    toolchain_manifest jsonb (build_runs has no dedicated parent column and SCHEMA_REGISTRY is
  //    read-only — Iron Law 1), so the lineage is queryable without a schema change.
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
      autonomous_recovery_mode: options.autonomousRecoveryMode ?? false,
      dry_run: dryRun,
      parallel_prompts_used: false,
    });
    buildRunId = created?.id ?? null;
  } catch (error) {
    log(`WARNING: createBuild degraded (${describe(error)}) — running stateless`);
  }
  if (buildRunId === null) warnings.push('Build Memory unreachable — running in stateless mode (Contract 4).');

  // Tag every log line emitted for the rest of this build with the build id + project, so any
  // module FORGE drives (assembler, sentinel, claude-runner, …) carries `build_run_id`/`project`
  // automatically (forge-logger mixin). Per-prompt `prompt_id` is layered on at each call site
  // below via runWithBuildContext, and the whole context is cleared before returning.
  setLogContext({ ...(buildRunId ? { buildRunId } : {}), project: projectName });

  // 2b. Replay rollback (F12, step 2): hard-reset main to the original build's checkpoint BEFORE
  //     reloading governance, so the repo is at the resume point and governance is read fresh from
  //     current disk (step 3 — it may have been edited since the original build). Non-fatal: a
  //     failed rollback replays from the current HEAD with a warning (Iron Law 3 — real outcome).
  if (replay && !dryRun) {
    const rollback = git.rollbackToCheckpoint(replay.fromCheckpointTag);
    if (rollback.success) {
      log(`Replay: ${mainBranch} reset to checkpoint '${replay.fromCheckpointTag}'.`);
    } else {
      const note = `Replay: rollback to checkpoint '${replay.fromCheckpointTag}' failed (${rollback.error ?? 'unknown'}) — replaying from current HEAD.`;
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
  // most relevant existing files and inject their structural summaries — grounding Claude in what
  // already exists so it does not duplicate or conflict with it. Rebuilt after each SUCCESSFUL
  // prompt (below) so the next retrieval reflects the files that prompt just wrote. Non-fatal: a
  // degraded index simply injects nothing (Contract 4 posture). Skipped in a dry run — nothing is
  // executed or rebuilt, and injecting RAG would perturb the simulation's prompt hashes/tokens.
  const rag = dryRun ? null : await CodebaseRag.create(projectPath, { log: (m) => log(`rag: ${m}`) });
  if (rag) log(`Codebase RAG indexed ${rag.fileCount} existing source file(s) for context injection.`);

  // Decomposition record sink (pattern learning) — wired here so the default closes over the now-known
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

  // Learning engine — non-critical, failures are caught internally
  const _learningState = await onRunStart(projectPath, buildRunId ?? machineId, ['typescript', 'nextjs'], projectName).catch(() => ({ knowledge: { rules: [], skills: [], fixPatterns: [], outcomes: [], evolutions: [] }, resumeState: null }));

  // 3. Walk the prompts in dependency order.
  const ctx: LoopContext = {
    projectPath,
    governanceDirName,
    buildRunId,
    machineId,
    stackFingerprint: options.stackFingerprint ?? null,
    autonomousRecoveryMode: options.autonomousRecoveryMode ?? false,
    dryRun,
    governanceDocs,
    git,
    rag,
    runClaudeImpl,
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

    // a0. Replay carry (F12): prompts before the resume index are already present in the
    //     checkpoint — record them as carried (skipped, not re-executed) and treat them as
    //     satisfied dependencies so the resume index downstream resolves. A carried schema prompt
    //     means schema is live in the repo, so Sentinel's schema-drift check stays active.
    if (replay && index < replay.fromPromptIndex) {
      const note = `Replay — carried from checkpoint (prompt ${index} < resume index ${replay.fromPromptIndex}), not re-executed.`;
      outcomes.push(skippedOutcome(entry, index, note));
      completedIds.add(entry.id);
      if (entry.prompt_type === 'schema') schemaPromptsHaveRun = true;
      log(`prompt ${index}/${schedule.order.length} '${entry.id}': ${note}`);
      continue;
    }

    // a. Dependency gate — the order is topological, so an unmet dependency means it failed/skipped.
    const unmet = entry.dependencies.filter((d) => !completedIds.has(d) && entries.some((e) => e.id === d));
    if (unmet.length > 0) {
      const note = `Skipped — unmet dependency(ies): ${unmet.join(', ')} did not complete.`;
      outcomes.push(skippedOutcome(entry, index, note));
      log(`prompt ${index}/${schedule.order.length} '${entry.id}': ${note}`);
      continue;
    }

    // Dry run: assemble + predict for cost/plan visibility, but execute nothing.
    if (dryRun) {
      const outcome = await runWithBuildContext({ promptId: entry.id }, () =>
        dryRunPrompt(ctx, entry, index, previousSentinel)
      );
      outcomes.push(outcome);
      completedIds.add(entry.id); // a dry run does not block downstream planning
      continue;
    }

    const outcome = await runWithBuildContext({ promptId: entry.id }, () =>
      executePrompt(ctx, entry, index, previousSentinel, schemaPromptsHaveRun)
    );
    outcomes.push(outcome);
    onPromptComplete({
      promptId: entry.id,
      success: outcome.disposition === 'completed',
      retryCount: outcome.recovery?.attempted ? 1 : 0,
      tokensConsumed: outcome.tokensEstimated,
      gatePassRate: outcome.sentinel?.passed ? 1.0 : 0.0,
      errorOutput: outcome.sentinel?.diagnosticReport ?? undefined,
      buildId: buildRunId ?? '',
      projectName,
      taskType: entry.prompt_type,
      techStackTags: ['typescript'],
      templateHash: outcome.promptHash,
    });
    if (entry.prompt_type === 'schema') schemaPromptsHaveRun = true;

    // Carry this prompt's Sentinel status into the next prompt (Contract 13).
    if (outcome.sentinel) {
      previousSentinel = toPreviousSentinelStatus(outcome.sentinel, entry.name, index);
    }

    if (outcome.disposition === 'completed') {
      completedIds.add(entry.id);
    } else if (outcome.disposition === 'failed') {
      // h/j: Sentinel failed and recovery did not restore green → HALT (Contract 13).
      halted = true;
      haltedAt = { index, id: entry.id };
      haltReason =
        outcome.recovery?.reason ??
        `Sentinel failed at prompt ${index} '${entry.id}' (${outcome.sentinel?.failedCheck ?? 'unknown'}) ` +
          'and was not auto-recovered.';
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
  }

  await onRunEnd(buildRunId ?? '', projectPath, {
    promptsExecuted: completedPrompts + failedPrompts + skippedPrompts,
    promptsPassed: completedPrompts,
    promptsFailed: failedPrompts,
    totalTokens,
    startTime: generatedAt,
  }).catch(() => {});

  // 5. Dry Run Mode (F11): assemble the simulation report from the per-prompt dry-run pass + the
  //    cost-estimator. Only on a dry run — a real build executed and needs no simulation.
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
    `Phase 3 ${status.toUpperCase()} — ${completedPrompts} completed, ${failedPrompts} failed, ` +
      `${skippedPrompts} skipped of ${schedule.order.length}; ~${totalTokens} tokens.` +
      (halted ? ` HALTED at prompt ${haltedAt?.index} '${haltedAt?.id}'.` : '') +
      (simulation
        ? ` Simulation: ~$${simulation.predictedCostUsd?.estimate ?? '?'}, ` +
          `~${simulation.predictedTimeMs?.human ?? '?'}, ~${simulation.expectedFailureCount} predicted failure(s).`
        : '')
  );

  if (!dryRun && costTracker.entries.length > 0) {
    const costSummary = costTracker.summary();
    log(
      `Model cost estimate: $${costSummary.totalCostUsd.toFixed(4)} across ${costSummary.totalPrompts} prompt(s) ` +
        `(${costSummary.byModel.map((r) => `${r.model}: ${r.prompts} prompts $${r.costUsd.toFixed(4)}`).join(', ')})`
    );
  }

  // Build finished — drop the ambient build/prompt context so a later build (or a test running
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
}

// ---------------------------------------------------------------------------
// Per-prompt execution
// ---------------------------------------------------------------------------

/** Shared, immutable context threaded into the per-prompt helpers. */
interface LoopContext {
  projectPath: string;
  governanceDirName: string;
  buildRunId: string | null;
  machineId: string;
  stackFingerprint: StackFingerprint | null;
  autonomousRecoveryMode: boolean;
  dryRun: boolean;
  governanceDocs: Record<string, string>;
  git: GitManager;
  runClaudeImpl: (prompt: string, cwd: string) => Promise<ClaudeRunResult>;
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
  log: (message: string) => void;
  /** Hook manager for pre_prompt / post_prompt lifecycle events. */
  hookManager: HookManager;
  /** Learned instinct rules applied to each prompt before execution. */
  instincts: Instinct[];
  /** Accumulates per-prompt model cost estimates across the build. */
  costTracker: ModelCostTracker;
}

/** Build the Sentinel options for this build (shared by the main run + recovery re-runs). */
function sentinelOptionsFor(ctx: LoopContext, schemaPromptsHaveRun: boolean): SentinelOptions {
  return {
    projectPath: ctx.projectPath,
    governanceDirName: ctx.governanceDirName,
    schemaPromptsHaveRun,
  };
}

/**
 * Execute one prompt through the full s5-p05 loop (steps b–j) and return its {@link PromptOutcome}.
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
  log(`prompt ${index} '${entry.id}' (${entry.prompt_type}) — start`);

  try {
    // b. Failure prediction (Contract 8).
    const prediction = await ctx.predictImpl({
      promptType: entry.prompt_type,
      stackFingerprint: ctx.stackFingerprint,
      promptIndex: index,
    });

    // b1. PRE-PROMPT HOOK — fire before assembly so hooks can gate or annotate the prompt.
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
      log(`prompt ${index} '${entry.id}': pre_prompt hook denied — ${denyReason}; skipping`);
      return skippedOutcome(entry, index, `pre_prompt hook denied: ${denyReason}`);
    }

    // c0. Codebase RAG (Contract 7 extension): retrieve the 10 existing files most relevant to this
    //     task and render them as an injectable block, so the assembled prompt tells Claude what
    //     already exists (avoids duplicate/conflicting code). Empty when nothing is relevant or the
    //     index degraded — the assembler then injects nothing.
    const relevantFilesBlock = ctx.rag ? ctx.rag.contextBlock(entry.description).block : '';

    // c/d. Assemble (Contract 7), then rewrite if the predictor flags high risk (Contract 9).
    const assembled = await ctx.assembleImpl({
      entry,
      governanceDocs: ctx.governanceDocs,
      stackFingerprint: ctx.stackFingerprint,
      previousSentinel,
      relevantFilesBlock,
    });
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

    // b2. APPLY INSTINCTS — augment the (possibly rewritten) prompt with learned fix rules.
    // Relevant instincts (confidence ≥ 0.5, keyword overlap ≥ 2) are appended as a block.
    if (ctx.instincts.length > 0) {
      const augmented = applyInstincts(promptText, ctx.instincts);
      if (augmented !== promptText) {
        log(`prompt ${index} '${entry.id}': instincts applied (+${augmented.length - promptText.length} chars)`);
        promptText = augmented;
      }
    }

    // b3. MODEL ROUTING — classify prompt complexity, select the optimal Claude model,
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

    // e. Create the Contract-10 feature branch.
    const branch = ctx.git.createBranch(buildIdOf(ctx), index, entry.name);
    const branchName = branch.branchName;
    if (!branch.success) {
      log(`prompt ${index} '${entry.id}': branch create failed — ${branch.error ?? 'unknown'} (continuing on current branch)`);
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
    // atomic sub-steps — the same options drive those inter-step checks and the final gate.
    const sentinelOptions = sentinelOptionsFor(ctx, schemaPromptsHaveRun || entry.prompt_type === 'schema');

    // f. Execute via the claude-runner, then commit the work to the feature branch.
    //
    // f0. Prompt decomposition: when this prompt's description exceeds DECOMPOSITION_THRESHOLD, it is
    //     split into atomic sub-prompts (one table / component / route each) that execute SEQUENTIALLY
    //     with a Sentinel check between each; a failing sub-step retries IN ISOLATION rather than
    //     re-running the whole prompt. The decomposer commits each sub-step, returns an aggregate run
    //     + the final Sentinel result, and records the decomposition shape to Build Memory (pattern
    //     learning) — so the rest of this loop (final Sentinel gate, merge, record) is UNCHANGED. A
    //     description that does not split runs exactly as a single prompt (the decomposer is a no-op).
    let run: ClaudeRunResult;
    let sentinel: SentinelResult;
    let decomposition: DecompositionResult | null = null;
    if (shouldDecompose(entry.description)) {
      decomposition = await ctx.runDecomposedPrompt(
        { id: entry.id, name: entry.name, promptType: entry.prompt_type, index, description: entry.description },
        promptText,
        {
          runClaude: (p) => ctx.runClaudeImpl(p, ctx.projectPath),
          runSentinel: () => ctx.runSentinelImpl(sentinelOptions),
          commit: (message) => {
            const c = ctx.git.commitAll(message);
            if (!c.success) log(`prompt ${index} '${entry.id}': sub-step commit failed — ${c.error ?? 'unknown'}`);
          },
          recordDecomposition: (record) => ctx.recordDecomposition(record),
          log,
        }
      );
      run = decomposition.aggregateRun;
      // Reuse the decomposer's between-sub-steps Sentinel as THIS prompt's gate (avoids a redundant
      // whole-prompt re-run); fall back only if it executed nothing (never, for a >threshold prompt).
      sentinel = decomposition.finalSentinel ?? (await ctx.runSentinelImpl(sentinelOptions));
      if (!run.success) {
        log(`prompt ${index} '${entry.id}': decomposed run not green — ${decomposition.note}`);
      }
    } else {
      run = await ctx.runClaudeImpl(promptText, ctx.projectPath);
      const commit = ctx.git.commitAll(`[FORGE] ${entry.prompt_type}: ${entry.name}\n\nPrompt ${index} (${entry.id}).`);
      if (!commit.success) {
        log(`prompt ${index} '${entry.id}': commit failed — ${commit.error ?? 'unknown'}`);
      }
      if (!run.success) {
        log(`prompt ${index} '${entry.id}': claude exited ${run.exitCode ?? 'null'}${run.timedOut ? ' (TIMEOUT)' : ''}`);
      }

      // h. Run the Phase 4 Sentinel (the five Contract-13 checks).
      sentinel = await ctx.runSentinelImpl(sentinelOptions);
    }

    // e1. POST-PROMPT HOOK — fire after execution, before Sentinel. Non-fatal.
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

    // e2. COMMIT PROMPT CHANGES — structured commit tracking this prompt's output.
    // Non-fatal: if nothing was staged (prior commitAll already committed), this is a no-op.
    try {
      await ctx.git.commitPromptChanges(entry.id, entry.prompt_type, 'post-run');
    } catch (commitErr) {
      log(`prompt ${index} '${entry.id}': commitPromptChanges non-fatal — ${describe(commitErr)}`);
    }

    // Capture the files this branch changed (for the prompt_execution record).
    const changed = filesChanged(ctx);

    // h1. ERROR PATTERN FIX — when Sentinel fails, check the Build Memory error pattern database
    // for a known fix. If found, apply it via claude and re-run Sentinel. This retry does NOT count
    // against max_retries (it is a targeted known fix, not a generic retry). Non-fatal.
    if (!sentinel.passed) {
      const errorText = sentinel.diagnosticReport ?? '';
      const sig = normalizeErrorSignature(errorText);
      if (sig) {
        try {
          const knownPattern = await BuildMemory.errors.findMatchingPattern(sig);
          if (knownPattern) {
            const resolution = await BuildMemory.resolutions.getResolutionForPattern(knownPattern.id);
            if (resolution?.resolution_description) {
              log(`prompt ${index} '${entry.id}': known error pattern matched (sig=${sig.slice(0, 60)}…) — applying fix`);
              const fixSteps = Array.isArray(resolution.resolution_steps)
                ? resolution.resolution_steps.map(String).join('\n')
                : String(resolution.resolution_steps ?? '');
              const fixPrompt = fixSteps
                ? `${resolution.resolution_description}\n\nSteps:\n${fixSteps}`
                : resolution.resolution_description;
              const fixRun = await ctx.runClaudeImpl(fixPrompt, ctx.projectPath);
              if (fixRun.success) {
                ctx.git.commitAll(
                  `[FORGE] pattern-fix: ${entry.name}\n\nAuto-applied known resolution for prompt ${index} (${entry.id}).`
                );
                const fixedSentinel = await ctx.runSentinelImpl(sentinelOptions);
                if (fixedSentinel.passed) {
                  log(`prompt ${index} '${entry.id}': pattern fix succeeded — sentinel now green`);
                  sentinel = fixedSentinel;
                } else {
                  log(`prompt ${index} '${entry.id}': pattern fix applied but sentinel still failing — proceeding to normal recovery`);
                }
              } else {
                log(`prompt ${index} '${entry.id}': pattern fix claude run failed — proceeding to normal recovery`);
              }
            }
          }
        } catch (patternErr) {
          log(`prompt ${index} '${entry.id}': error pattern lookup non-fatal — ${describe(patternErr)}`);
        }
      }
    }

    let recovery: AutoRecoveryResult | null = null;
    let disposition: PromptDisposition;
    let note: string;

    if (sentinel.passed) {
      // i. Merge to main + lightweight checkpoint tag (Contracts 10/11).
      mergeAndTag(ctx, index);
      disposition = 'completed';
      note = 'Sentinel passed — merged to main and checkpointed.';
    } else if (ctx.autonomousRecoveryMode) {
      // j. Autonomous Recovery (Contract 14): re-run the prompt + Sentinel, up to 2 attempts.
      const rerunPrompt: RerunPromptFn = async () => {
        const r = await ctx.runClaudeImpl(promptText, ctx.projectPath);
        ctx.git.commitAll(`[FORGE] recovery ${entry.prompt_type}: ${entry.name}\n\nPrompt ${index} (${entry.id}) re-run.`);
        return { success: r.success, output: `${r.stdout}\n${r.stderr}` };
      };
      recovery = await ctx.runRecoveryImpl(sentinel, rerunPrompt, sentinelOptions, promptExecutionId);
      sentinel = recovery.finalSentinel;
      if (recovery.recovered) {
        mergeAndTag(ctx, index);
        disposition = 'completed';
        note = `Auto-recovered: ${recovery.reason}`;
      } else {
        disposition = 'failed';
        note = `Sentinel failed; auto-recovery did not restore green: ${recovery.reason}`;
      }
    } else {
      disposition = 'failed';
      note = `Sentinel failed (${sentinel.failedCheck ?? 'unknown'}) — Autonomous Recovery disabled, escalating (Contract 14).`;
    }

    // Finalize the prompt_execution record with the outcome.
    await finalizePromptExecution(ctx, promptExecutionId, {
      disposition,
      sentinel,
      tokens: run.tokensEstimated,
      errorOutput: sentinel.passed ? null : sentinel.diagnosticReport,
      changed,
      recovery,
    });

    // Post-finalization: dead code scan on changed files + every-10th smoke tests.

    // DEAD CODE SCAN — scan the whole src tree but report only findings in changed files.
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
              `prompt ${index} '${entry.id}': dead-code scan — ${total} issue(s) in changed files ` +
                `(imports: ${unusedImports.length}, vars: ${unusedVars.length}, exports: ${unusedExports.length})`
            );
          }
        })
        .catch((scanErr) => {
          log(`prompt ${index} '${entry.id}': dead-code scan non-fatal — ${describe(scanErr)}`);
        });
    }

    // SMOKE TESTS every 10th prompt — run after completion (regardless of pass/fail for visibility).
    // Uses shouldRunTests frequency guard and runSmokeTests (compile + build + 3 page probes).
    if (shouldRunTests(index)) {
      runSmokeTests(ctx.projectPath)
        .then((smokeResult) => {
          log(
            `prompt ${index} '${entry.id}': smoke tests ${smokeResult.passed ? 'PASS' : 'FAIL'} ` +
              `(${smokeResult.passedFiles}/${smokeResult.totalFiles} checks)`
          );
          if (!smokeResult.passed) {
            const failing = smokeResult.results.filter((r) => !r.passed).map((r) => r.file);
            log(`prompt ${index} '${entry.id}': smoke failures — ${failing.join(', ')}`);
          }
        })
        .catch((smokeErr) => {
          log(`prompt ${index} '${entry.id}': smoke tests non-fatal — ${describe(smokeErr)}`);
        });
    }

    // Rebuild the Codebase RAG index after a SUCCESSFUL prompt (Contract 7 extension), so the next
    // prompt's retrieval reflects the files this one just wrote/merged. Non-fatal — on failure the
    // previous index is kept (CodebaseRag.rebuild never throws).
    if (disposition === 'completed' && ctx.rag) {
      await ctx.rag.rebuild();
    }

    // k. Update STATE_OF_THE_BUILD.md from live progress (Canonical Rule 9).
    const decompSuffix = decomposition?.decomposed
      ? `, decomposed into ${decomposition.subPrompts.length} sub-prompt(s)`
      : '';
    await ctx.updateStateProgress(
      `[FORGE Phase 3] prompt ${index} '${entry.id}' (${entry.prompt_type}): ${disposition.toUpperCase()} — ` +
        `Sentinel ${sentinel.passed ? 'PASS' : `FAIL(${sentinel.failedCheck ?? '?'})`}${wasRewritten ? ', rewritten' : ''}${decompSuffix}.`
    );
    if (decomposition?.decomposed) note = `${note} (${decomposition.note})`;

    log(`prompt ${index} '${entry.id}': ${disposition} — ${note}`);
    return {
      index,
      id: entry.id,
      name: entry.name,
      promptType: entry.prompt_type,
      disposition,
      branchName,
      failureProbability: prediction.probability,
      wasRewritten,
      promptHash,
      promptExecutionId,
      tokensEstimated: run.tokensEstimated,
      sentinel,
      recovery,
      note,
    };
  } catch (error) {
    // Defensive: the collaborators never throw, but if one does, fail this prompt (don't crash).
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
      promptHash: '',
      promptExecutionId: null,
      tokensEstimated: 0,
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
    // Rough token estimate from the assembled prompt length (≈ chars / 4), else the queue figure.
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
    promptHash,
    promptExecutionId: null,
    tokensEstimated: tokens,
    sentinel: null,
    recovery: null,
    note: `Dry run — assembled + predicted (p=${probability === null ? 'n/a' : probability.toFixed(3)}), not executed.`,
  };
}

/** Every prompt type — used to seed the per-type count record. */
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
 * derived from the queue's per-type counts (with a warning). Never throws — a degraded estimate
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
    warnings.push('No Phase 1 feature list supplied — cost estimate derived approximately from the queue.');
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
    promptHash: '',
    promptExecutionId: null,
    tokensEstimated: 0,
    sentinel: null,
    recovery: null,
    note,
  };
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

/** The build id used in branch/tag names — the build_run id, else a stable fallback. */
function buildIdOf(ctx: LoopContext): string {
  return ctx.buildRunId ?? `local-${ctx.machineId}`;
}

/** Merge the current feature branch to main and create the Contract-11 checkpoint tag. */
function mergeAndTag(ctx: LoopContext, index: number): void {
  const merge = ctx.git.mergeToMain();
  if (!merge.success) {
    ctx.log(`prompt ${index}: merge to ${merge.targetBranch} failed — ${merge.error ?? 'unknown'}`);
    return;
  }
  const tag = ctx.git.tagCheckpoint(buildIdOf(ctx), index);
  if (!tag.success) ctx.log(`prompt ${index}: checkpoint tag failed — ${tag.error ?? 'unknown'}`);
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
      ctx.log(`halt: rollback to ${tag} failed — ${rollback.error ?? 'unknown'} (feature branch preserved regardless)`);
    } else {
      ctx.log(`halt: main reset to last checkpoint ${tag}; feature branch ${outcome.branchName ?? '(none)'} preserved`);
    }
  }

  const report = [
    '# FORGE Phase 3 — HALT',
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
// State + halt-report writers (defaults — injectable)
// ---------------------------------------------------------------------------

/**
 * Default STATE_OF_THE_BUILD.md progress update (Canonical Rule 9): append a timestamped
 * progress line under the governance dir. Guarded — a write failure is non-fatal (it never
 * blocks the build). STATE_OF_THE_BUILD.md is deliberately NOT in Sentinel's protected set.
 */
async function defaultUpdateStateProgress(governanceDir: string, line: string): Promise<void> {
  const target = join(governanceDir, 'STATE_OF_THE_BUILD.md');
  try {
    await appendFile(target, `\n> ${nowIso()} ${line}\n`, 'utf8');
  } catch {
    /* non-fatal — the state document update must never block the build */
  }
}

/**
 * Default decomposition-record sink: write the decomposition SHAPE to `cross_project_insights` as an
 * `optimization` insight (Phase 5 pattern learning — which prompt kinds need splitting, how reliably
 * the splits land). No-op in stateless mode (no build to attach to). Guarded/non-fatal (Contract 4 —
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
    /* non-fatal — Build Memory write must never block the build (Contract 4) */
  }
}

/** Default halt-report writer: `state/halt-reason.md` under the project (CLAUDE.md error protocol). */
async function defaultWriteHaltReport(projectPath: string, report: string): Promise<void> {
  const dir = join(projectPath, 'state');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'halt-reason.md'), report, 'utf8');
  } catch {
    /* non-fatal */
  }
}

/** Basename of a filesystem path (last non-empty segment), or `'project'`. */
function basenameOf(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last && last.trim() !== '' ? last : 'project';
}

export default runPhase3Executor;
