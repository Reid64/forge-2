/**
 * FORGE 2.0 — Pattern Extractor (Phase 5 Recursive Learner, queue.yaml s6-p01).
 *
 * The FIRST analysis module. After a build completes, the Recursive Learner (Phase 5) reads
 * everything the build recorded and distills it into reusable intelligence. This module is the
 * extraction step: given a completed `build_runs` row and all its `prompt_executions`, it produces
 * an {@link ExtractedPatterns} report across four dimensions and then persists the findings to
 * Build Memory (BLUEPRINT Phase 5 "Writes error_patterns … cross_project_insights").
 *
 *   ERROR PATTERNS (Contract 15 — Error Pattern Generalization):
 *     - group every errored prompt by its NORMALIZED error signature (paths / line:col /
 *       timestamps / hashes / quoted literals stripped — REUSING the Sentinel's
 *       `normalizeErrorSignature` so signatures are byte-identical to what Autonomous Recovery
 *       matched against);
 *     - categorize each (`categorizeError`, also reused) into the Contract-15 categories;
 *     - occurrence rate per stack fingerprint (this build carries one stack — the rate is the
 *       group's share of the build's analyzed prompts, tagged with the build's fingerprint);
 *     - trigger conditions: which prompt TYPES triggered it and the prompt-index RANGE.
 *
 *   TIMING PATTERNS: per prompt type — average / median execution time (`completed_at` −
 *     `started_at`), population variance + std-dev, the high outliers (> mean + 2·σ), and the
 *     Pearson correlation between prompt complexity (assembled `prompt_content` length) and time.
 *
 *   SUCCESS PATTERNS: per prompt type — the success rate of that prompt "structure", and the
 *     effect of a Contract-9 rewrite (rewritten vs non-rewritten success rate + the improvement).
 *     Plus governance-section correlation: for each injected governance doc, the executed-prompt
 *     error rate WITH vs WITHOUT that doc, surfacing which sections correlate with fewer errors.
 *
 *   COST PATTERNS: per prompt type — average token cost (input + output) and dollar cost; plus a
 *     whole-build cost summary keyed to project complexity (table count, feature count).
 *
 * Per the Six Laws of feature completion and BEHAVIORAL_CONTRACTS, `prompt_executions` records no
 * `prompt_type` column — only `prompt_name`. So the prompt type is recovered from the name: if the
 * approved queue `entries` are supplied we map `name → prompt_type` EXACTLY (the executor writes
 * `prompt_name = entry.name`); otherwise we classify the name against the Queue Generator's naming
 * scheme (`classifyPromptType`). Documented rather than silently assumed (Iron Law 3).
 *
 * NON-FATAL house style (Contract 4): the analysis is PURE and deterministic, and every Build
 * Memory read/write is injectable and guarded — a DB outage degrades to stateless (the report is
 * still returned; nothing is stored) and never throws. `extractPatterns` never rejects.
 *
 * BOUNDARY: this module only READS `build_runs` / `prompt_executions` and WRITES `error_patterns`
 * / `cross_project_insights`. It touches no governance file (Iron Law 1) and no target project.
 */

import type { PromptType, QueueEntry } from '../engine/queue-generator.js';
import { normalizeErrorSignature, categorizeError } from '../phases/phase4-sentinel.js';
import { logLine } from '../tools/forge-logger.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import type { NewErrorPattern } from '../memory/errors.js';
import type { NewCrossProjectInsight } from '../memory/insights.js';
import type {
  BuildRun,
  PromptExecution,
  ErrorPattern,
  ErrorCategory,
  CrossProjectInsight,
  JsonObject,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Public contract — the four pattern dimensions + the report envelope
// ---------------------------------------------------------------------------

/** Occurrence rate of an error on a particular stack fingerprint. */
export interface StackOccurrenceRate {
  /** The stack fingerprint the rate is measured on (this build's stack). */
  stackFingerprint: JsonObject;
  /** How many errored prompts in the build carried this signature. */
  occurrences: number;
  /** `occurrences / analyzedPrompts` for the build — the signature's share of all prompts. */
  rate: number;
}

/** A generalized error pattern distilled from the build's errored prompts (Contract 15). */
export interface ErrorPatternFinding {
  /** Normalized, stable signature (paths/lines/timestamps/hashes/literals stripped). */
  errorSignature: string;
  /** Contract-15 category (type_error, build_failure, runtime, schema, auth, dependency, config). */
  errorCategory: ErrorCategory;
  /** A representative RAW error message for this signature (truncated). */
  errorMessageSample: string;
  /** Times this signature appeared across the build's prompts. */
  occurrenceCount: number;
  /** Occurrence rate per stack fingerprint (this build → a single entry). */
  occurrenceRateByStack: StackOccurrenceRate[];
  /** The prompt TYPES whose execution produced this error (trigger condition). */
  triggerPromptTypes: PromptType[];
  /** The 1-based prompt-index range that produced this error, or null if unknown. */
  triggerPromptIndexRange: { min: number; max: number } | null;
  /** The build phase that produced these errors — always 'phase3' here (the executor). */
  triggerPhase: string;
}

/** A high-outlier execution within a timing group. */
export interface TimingOutlier {
  promptIndex: number;
  promptName: string;
  durationMs: number;
}

/** Timing statistics for one prompt type. */
export interface TimingPatternFinding {
  promptType: PromptType;
  /** Number of prompts of this type with a measurable duration. */
  sampleCount: number;
  averageMs: number;
  medianMs: number;
  /** Population variance of the durations (ms²). */
  varianceMs: number;
  /** Population standard deviation of the durations (ms). */
  stdDevMs: number;
  minMs: number;
  maxMs: number;
  /** Durations beyond mean + 2·σ (only when sampleCount ≥ 3). */
  outliers: TimingOutlier[];
  /**
   * Pearson correlation in [-1, 1] between prompt complexity (assembled prompt_content length)
   * and execution time, or null when it cannot be computed (< 2 samples / zero variance).
   */
  complexityTimeCorrelation: number | null;
}

/** The effect of dynamic rewriting (Contract 9) on a prompt type's outcomes. */
export interface RewriteEffect {
  rewrittenTotal: number;
  rewrittenSucceeded: number;
  rewrittenSuccessRate: number | null;
  nonRewrittenTotal: number;
  nonRewrittenSucceeded: number;
  nonRewrittenSuccessRate: number | null;
  /** rewrittenSuccessRate − nonRewrittenSuccessRate (positive = rewriting helped), or null. */
  improvement: number | null;
}

/** Success statistics for one prompt "structure" (prompt type). */
export interface SuccessPatternFinding {
  promptType: PromptType;
  /** Executed prompts of this type (completed + failed). */
  total: number;
  succeeded: number;
  /** succeeded / total in [0, 1], or null when nothing of this type executed. */
  successRate: number | null;
  /** How rewriting changed this type's outcomes (Contract 9). */
  rewrite: RewriteEffect;
}

/** Correlation between an injected governance document and a lower error rate. */
export interface GovernanceCorrelationFinding {
  /** Governance document name (e.g. SCHEMA_REGISTRY.md). */
  governanceDoc: string;
  withDocTotal: number;
  withDocErrorRate: number;
  withoutDocTotal: number;
  withoutDocErrorRate: number;
  /** withoutDocErrorRate − withDocErrorRate (positive = the doc correlated with fewer errors). */
  errorRateDelta: number;
}

/** Token/dollar cost statistics for one prompt type. */
export interface CostPatternFinding {
  promptType: PromptType;
  sampleCount: number;
  averageTokens: number;
  averageInputTokens: number;
  averageOutputTokens: number;
  averageCostUsd: number;
  totalTokens: number;
  totalCostUsd: number;
}

/** Whole-build cost keyed to a coarse project-complexity profile. */
export interface BuildCostSummary {
  totalTokens: number;
  totalCostUsd: number;
  complexity: {
    /** Distinct schema sections across the queue (≈ table count), or null when no queue supplied. */
    tableCount: number | null;
    /** Number of feature-type prompts. */
    featureCount: number;
    /** Number of api-type prompts. */
    apiCount: number;
    /** Total prompts analyzed. */
    promptCount: number;
  };
  /** totalCostUsd / tableCount, or null. */
  costPerTable: number | null;
  /** totalCostUsd / featureCount, or null. */
  costPerFeature: number | null;
}

/** The complete extraction report (the s6-p01 output contract). */
export interface ExtractedPatterns {
  buildRunId: string | null;
  projectName: string;
  stackFingerprint: JsonObject;
  /** Total prompt_executions considered. */
  analyzedPrompts: number;
  error_patterns: ErrorPatternFinding[];
  timing_patterns: TimingPatternFinding[];
  success_patterns: SuccessPatternFinding[];
  cost_patterns: CostPatternFinding[];
  /** Governance-section correlations (the "fewer errors" sub-analysis of success patterns). */
  governance_correlations: GovernanceCorrelationFinding[];
  /** Whole-build cost-by-complexity summary (the build-level cost pattern). */
  build_cost: BuildCostSummary;
  /** Non-fatal observations (no executions, stateless degrade, …). */
  warnings: string[];
  generatedAt: string;
}

/** What got persisted to Build Memory. */
export interface PatternStorageResult {
  /** error_patterns rows created (newly seen signatures). */
  errorPatternsCreated: number;
  /** error_patterns rows whose occurrence_count was incremented (already-seen signatures). */
  errorPatternsUpdated: number;
  /** cross_project_insights rows created (timing / success / cost). */
  insightsCreated: number;
  /** True when Build Memory was unreachable and nothing could be stored. */
  stateless: boolean;
  warnings: string[];
}

/** The full result of {@link extractPatterns}. */
export interface PatternExtractionResult {
  patterns: ExtractedPatterns;
  storage: PatternStorageResult;
}

/** Inputs to {@link extractPatterns}. */
export interface ExtractPatternsInput {
  /** The completed build to analyze. */
  buildRunId: string;
  /** The build_runs row (else fetched from Build Memory). */
  build?: BuildRun | null;
  /** The build's prompt_executions (else fetched from Build Memory). */
  executions?: PromptExecution[];
  /** The approved queue, used to map prompt_name → prompt_type EXACTLY (else name classification). */
  entries?: QueueEntry[];
  /** Stack fingerprint override (else the build's `stack_fingerprint`). */
  stackFingerprint?: JsonObject;
  /** Project name override (else the build's `project_name`). */
  projectName?: string;
}

/** Options for {@link extractPatterns} — store toggle + injectable Build Memory I/O (tests). */
export interface PatternExtractorOptions {
  /** Persist the findings to Build Memory. Default true (set false for a pure analysis). */
  store?: boolean;
  /** Fetch the build_run. Default `BuildMemory.builds.getBuild`. */
  fetchBuild?: (id: string) => Promise<BuildRun | null>;
  /** Fetch the prompt_executions. Default `BuildMemory.prompts.getPromptsByBuild` (→ []). */
  fetchExecutions?: (id: string) => Promise<PromptExecution[]>;
  /** Find an existing error_pattern by normalized signature. Default `BuildMemory.errors.findMatchingPattern`. */
  findMatchingPattern?: (signature: string) => Promise<ErrorPattern | null>;
  /** Create an error_pattern. Default `BuildMemory.errors.createErrorPattern`. */
  createErrorPattern?: (input: NewErrorPattern) => Promise<ErrorPattern | null>;
  /** Increment an error_pattern's occurrence_count. Default `BuildMemory.errors.updateOccurrenceCount`. */
  updateOccurrenceCount?: (id: string) => Promise<ErrorPattern | null>;
  /** Create a cross_project_insight. Default `BuildMemory.insights.createInsight`. */
  createInsight?: (input: NewCrossProjectInsight) => Promise<CrossProjectInsight | null>;
  /** Progress reporter. Default logs to the console with a `[FORGE:patterns]` prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Every prompt type — iteration order for the per-type groupings. */
const ALL_PROMPT_TYPES: readonly PromptType[] = [
  'schema',
  'auth',
  'api',
  'ui',
  'feature',
  'agent',
  'test',
  'deploy',
] as const;

/** Governance documents the prompt-assembler may inject (Contract 7) — scanned in prompt_content. */
const GOVERNANCE_DOCS: readonly string[] = [
  'BLUEPRINT.md',
  'SCHEMA_REGISTRY.md',
  'BEHAVIORAL_CONTRACTS.md',
  'INTERACTION_MAPS.md',
  'AGENTS.md',
  'TESTING.md',
] as const;

/** Statuses that count as "executed" (the denominator for success/error rates). */
const EXECUTED_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed']);

// ---------------------------------------------------------------------------
// Prompt-type recovery (prompt_executions has no prompt_type column)
// ---------------------------------------------------------------------------

/**
 * Classify a `prompt_name` into its {@link PromptType} using the Queue Generator's naming scheme
 * ("Database schema & migrations", "API: …", "Feature/Dashboard/Settings: …", "Agent: …", the
 * test/deploy/verify names). Falls back to 'feature' (the Queue Generator's own default).
 */
export function classifyPromptType(promptName: string): PromptType {
  const n = (promptName ?? '').trim().toLowerCase();
  if (/(^|\b)(database schema|schema|migration)/.test(n)) return 'schema';
  if (/(^|\b)(authentication|authorization|auth)\b/.test(n)) return 'auth';
  // Test indicators win over the 'api' prefix so "API tests" classifies as a test, not an api route.
  if (/(playwright|e2e|end-to-end|six laws|verif|\btests?\b)/.test(n)) return 'test';
  if (/^api[:\s]/.test(n)) return 'api';
  if (/(ui shell|design token|layout)/.test(n)) return 'ui';
  if (/^agent[:\s]/.test(n)) return 'agent';
  if (/^deploy/.test(n)) return 'deploy';
  if (/^(feature|dashboard|settings)[:\s]/.test(n)) return 'feature';
  return 'feature';
}

// ---------------------------------------------------------------------------
// Numeric helpers (pure)
// ---------------------------------------------------------------------------

/** Clamp a number into [lo, hi]; map non-finite to lo. */
function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/** Round to a fixed number of decimals (keeps the JSON compact + comparable in tests). */
function round(n: number, decimals = 4): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** Arithmetic mean of a non-empty list (0 for an empty list). */
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Median of a list (0 for empty). */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Population variance of a list (0 for < 2 samples). */
function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / xs.length;
}

/**
 * Pearson correlation of paired samples in [-1, 1], or null when undefined (< 2 pairs or one
 * variable has zero variance).
 */
function pearson(pairs: Array<[number, number]>): number | null {
  const n = pairs.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pairs) {
    sx += x;
    sy += y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    const dx = x - mx;
    const dy = y - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return clamp(sxy / Math.sqrt(sxx * syy), -1, 1);
}

// ---------------------------------------------------------------------------
// Execution helpers (pure)
// ---------------------------------------------------------------------------

/** Measurable execution time (ms) from started_at/completed_at, or null when unavailable. */
function durationMs(ex: PromptExecution): number | null {
  if (!ex.started_at || !ex.completed_at) return null;
  const s = Date.parse(ex.started_at);
  const e = Date.parse(ex.completed_at);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  const d = e - s;
  return d >= 0 ? d : null;
}

/** True when an execution actually ran (its success/error counts toward the rates). */
function wasExecuted(ex: PromptExecution): boolean {
  return EXECUTED_STATUSES.has(ex.status);
}

/** True when an execution succeeded (completed). */
function succeeded(ex: PromptExecution): boolean {
  return ex.status === 'completed';
}

/** Non-empty error output for this execution, or null. */
function errorText(ex: PromptExecution): string | null {
  const t = ex.error_output;
  return typeof t === 'string' && t.trim() !== '' ? t : null;
}

/** True when an execution is considered errored (failed status, Sentinel red, or error output). */
function isErrored(ex: PromptExecution): boolean {
  return ex.status === 'failed' || ex.sentinel_passed === false || errorText(ex) !== null;
}

/** Cast an arbitrary serializable value to a Build-Memory `jsonb` object (deep-cloned to plain JSON). */
function jsonClone(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/** Render an unknown thrown value as a short string for logging. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Dimension analyzers (pure)
// ---------------------------------------------------------------------------

/** Group executions by recovered prompt type. */
function groupByType(
  executions: PromptExecution[],
  typeOf: (ex: PromptExecution) => PromptType
): Map<PromptType, PromptExecution[]> {
  const groups = new Map<PromptType, PromptExecution[]>();
  for (const ex of executions) {
    const t = typeOf(ex);
    const list = groups.get(t);
    if (list) list.push(ex);
    else groups.set(t, [ex]);
  }
  return groups;
}

/** ERROR PATTERNS — group errored prompts by normalized signature (Contract 15). */
function extractErrorPatterns(
  executions: PromptExecution[],
  typeOf: (ex: PromptExecution) => PromptType,
  stack: JsonObject,
  analyzedPrompts: number
): ErrorPatternFinding[] {
  interface Acc {
    signature: string;
    sample: string;
    category: ErrorCategory;
    count: number;
    types: Set<PromptType>;
    minIndex: number;
    maxIndex: number;
  }
  const bySignature = new Map<string, Acc>();

  for (const ex of executions) {
    const raw = errorText(ex);
    if (raw === null) continue;
    const signature = normalizeErrorSignature(raw);
    if (signature === '') continue;
    const existing = bySignature.get(signature);
    if (existing) {
      existing.count += 1;
      existing.types.add(typeOf(ex));
      existing.minIndex = Math.min(existing.minIndex, ex.prompt_index);
      existing.maxIndex = Math.max(existing.maxIndex, ex.prompt_index);
    } else {
      bySignature.set(signature, {
        signature,
        sample: raw.trim().slice(0, 500),
        category: categorizeError(null, raw),
        count: 1,
        types: new Set<PromptType>([typeOf(ex)]),
        minIndex: ex.prompt_index,
        maxIndex: ex.prompt_index,
      });
    }
  }

  const findings: ErrorPatternFinding[] = [];
  for (const acc of bySignature.values()) {
    findings.push({
      errorSignature: acc.signature,
      errorCategory: acc.category,
      errorMessageSample: acc.sample,
      occurrenceCount: acc.count,
      occurrenceRateByStack: [
        {
          stackFingerprint: stack,
          occurrences: acc.count,
          rate: analyzedPrompts > 0 ? round(acc.count / analyzedPrompts) : 0,
        },
      ],
      triggerPromptTypes: [...acc.types].sort(),
      triggerPromptIndexRange: { min: acc.minIndex, max: acc.maxIndex },
      triggerPhase: 'phase3',
    });
  }
  // Most-frequent first, then by signature for a stable order.
  findings.sort((a, b) => b.occurrenceCount - a.occurrenceCount || a.errorSignature.localeCompare(b.errorSignature));
  return findings;
}

/** TIMING PATTERNS — per-type duration stats, outliers, and complexity↔time correlation. */
function extractTimingPatterns(
  groups: Map<PromptType, PromptExecution[]>
): TimingPatternFinding[] {
  const findings: TimingPatternFinding[] = [];
  for (const type of ALL_PROMPT_TYPES) {
    const list = groups.get(type);
    if (!list || list.length === 0) continue;

    const timed = list
      .map((ex) => ({ ex, ms: durationMs(ex) }))
      .filter((x): x is { ex: PromptExecution; ms: number } => x.ms !== null);
    if (timed.length === 0) continue;

    const durations = timed.map((x) => x.ms);
    const avg = mean(durations);
    const varv = variance(durations);
    const std = Math.sqrt(varv);

    // High outliers beyond mean + 2·σ (only meaningful with ≥ 3 samples and a non-zero spread).
    const outliers: TimingOutlier[] = [];
    if (timed.length >= 3 && std > 0) {
      const threshold = avg + 2 * std;
      for (const { ex, ms } of timed) {
        if (ms > threshold) {
          outliers.push({ promptIndex: ex.prompt_index, promptName: ex.prompt_name, durationMs: Math.round(ms) });
        }
      }
    }

    // Correlate prompt complexity (assembled prompt_content length) with execution time.
    const pairs: Array<[number, number]> = timed.map((x): [number, number] => [
      x.ex.prompt_content.length,
      x.ms,
    ]);
    const correlation = pearson(pairs);

    findings.push({
      promptType: type,
      sampleCount: timed.length,
      averageMs: Math.round(avg),
      medianMs: Math.round(median(durations)),
      varianceMs: round(varv, 2),
      stdDevMs: round(std, 2),
      minMs: Math.round(Math.min(...durations)),
      maxMs: Math.round(Math.max(...durations)),
      outliers,
      complexityTimeCorrelation: correlation === null ? null : round(correlation),
    });
  }
  return findings;
}

/** SUCCESS PATTERNS — per-type success rate + the rewrite effect (Contract 9). */
function extractSuccessPatterns(
  groups: Map<PromptType, PromptExecution[]>
): SuccessPatternFinding[] {
  const findings: SuccessPatternFinding[] = [];
  for (const type of ALL_PROMPT_TYPES) {
    const list = groups.get(type);
    if (!list || list.length === 0) continue;

    const executed = list.filter(wasExecuted);
    const total = executed.length;
    const succ = executed.filter(succeeded).length;

    const rewritten = executed.filter((ex) => ex.was_rewritten === true);
    const nonRewritten = executed.filter((ex) => ex.was_rewritten !== true);
    const rwSucc = rewritten.filter(succeeded).length;
    const nrSucc = nonRewritten.filter(succeeded).length;
    const rewrittenRate = rewritten.length > 0 ? rwSucc / rewritten.length : null;
    const nonRewrittenRate = nonRewritten.length > 0 ? nrSucc / nonRewritten.length : null;

    findings.push({
      promptType: type,
      total,
      succeeded: succ,
      successRate: total > 0 ? round(succ / total) : null,
      rewrite: {
        rewrittenTotal: rewritten.length,
        rewrittenSucceeded: rwSucc,
        rewrittenSuccessRate: rewrittenRate === null ? null : round(rewrittenRate),
        nonRewrittenTotal: nonRewritten.length,
        nonRewrittenSucceeded: nrSucc,
        nonRewrittenSuccessRate: nonRewrittenRate === null ? null : round(nonRewrittenRate),
        improvement:
          rewrittenRate === null || nonRewrittenRate === null ? null : round(rewrittenRate - nonRewrittenRate),
      },
    });
  }
  // Highest success rate first (null rates last), then by type for stability.
  findings.sort((a, b) => (b.successRate ?? -1) - (a.successRate ?? -1) || a.promptType.localeCompare(b.promptType));
  return findings;
}

/** SUCCESS PATTERNS (governance sub-analysis) — error rate WITH vs WITHOUT each injected doc. */
function extractGovernanceCorrelations(executions: PromptExecution[]): GovernanceCorrelationFinding[] {
  const executed = executions.filter(wasExecuted);
  const findings: GovernanceCorrelationFinding[] = [];
  if (executed.length === 0) return findings;

  for (const doc of GOVERNANCE_DOCS) {
    const withDoc = executed.filter((ex) => ex.prompt_content.includes(doc));
    const withoutDoc = executed.filter((ex) => !ex.prompt_content.includes(doc));
    // Only meaningful when BOTH sides have samples to compare.
    if (withDoc.length === 0 || withoutDoc.length === 0) continue;

    const withRate = withDoc.filter(isErrored).length / withDoc.length;
    const withoutRate = withoutDoc.filter(isErrored).length / withoutDoc.length;
    findings.push({
      governanceDoc: doc,
      withDocTotal: withDoc.length,
      withDocErrorRate: round(withRate),
      withoutDocTotal: withoutDoc.length,
      withoutDocErrorRate: round(withoutRate),
      errorRateDelta: round(withoutRate - withRate),
    });
  }
  // Largest positive delta (doc correlated with the biggest error-rate reduction) first.
  findings.sort((a, b) => b.errorRateDelta - a.errorRateDelta || a.governanceDoc.localeCompare(b.governanceDoc));
  return findings;
}

/** COST PATTERNS — per-type token/dollar averages. */
function extractCostPatterns(groups: Map<PromptType, PromptExecution[]>): CostPatternFinding[] {
  const findings: CostPatternFinding[] = [];
  for (const type of ALL_PROMPT_TYPES) {
    const list = groups.get(type);
    if (!list || list.length === 0) continue;

    const n = list.length;
    let totalIn = 0;
    let totalOut = 0;
    let totalCost = 0;
    for (const ex of list) {
      totalIn += ex.tokens_input ?? 0;
      totalOut += ex.tokens_output ?? 0;
      totalCost += ex.cost_usd ?? 0;
    }
    const totalTokens = totalIn + totalOut;
    findings.push({
      promptType: type,
      sampleCount: n,
      averageTokens: Math.round(totalTokens / n),
      averageInputTokens: Math.round(totalIn / n),
      averageOutputTokens: Math.round(totalOut / n),
      averageCostUsd: round(totalCost / n),
      totalTokens,
      totalCostUsd: round(totalCost),
    });
  }
  return findings;
}

/** Build-level cost keyed to a coarse complexity profile (table count, feature count). */
function summarizeBuildCost(
  executions: PromptExecution[],
  groups: Map<PromptType, PromptExecution[]>,
  build: BuildRun | null,
  entries: QueueEntry[] | undefined
): BuildCostSummary {
  let execTokens = 0;
  let execCost = 0;
  for (const ex of executions) {
    execTokens += (ex.tokens_input ?? 0) + (ex.tokens_output ?? 0);
    execCost += ex.cost_usd ?? 0;
  }
  // Prefer the per-prompt sums; fall back to the build_run aggregate when the rows carry none.
  const totalTokens = execTokens > 0 ? execTokens : build?.total_tokens ?? 0;
  const totalCostUsd = round(execCost > 0 ? execCost : build?.total_cost_usd ?? 0);

  const featureCount = groups.get('feature')?.length ?? 0;
  const apiCount = groups.get('api')?.length ?? 0;
  const promptCount = executions.length;

  // Table count ≈ distinct schema sections across the queue (only when the queue is supplied).
  let tableCount: number | null = null;
  if (entries && entries.length > 0) {
    const tables = new Set<string>();
    for (const e of entries) {
      for (const s of e.context_injection.schemaSections) {
        const t = s.trim().toLowerCase();
        if (t !== '') tables.add(t);
      }
    }
    tableCount = tables.size;
  }

  return {
    totalTokens,
    totalCostUsd,
    complexity: { tableCount, featureCount, apiCount, promptCount },
    costPerTable: tableCount && tableCount > 0 ? round(totalCostUsd / tableCount) : null,
    costPerFeature: featureCount > 0 ? round(totalCostUsd / featureCount) : null,
  };
}

// ---------------------------------------------------------------------------
// Pure analysis entry point (no I/O)
// ---------------------------------------------------------------------------

/**
 * Analyze a build's `prompt_executions` into an {@link ExtractedPatterns} report. PURE and
 * deterministic — no database, no clock beyond the supplied/derived timestamp string. Exposed
 * separately so it can be unit-tested in isolation and reused without storage.
 */
export function analyzePatterns(
  build: BuildRun | null,
  executions: PromptExecution[],
  input: ExtractPatternsInput,
  warnings: string[] = []
): ExtractedPatterns {
  const projectName = input.projectName ?? build?.project_name ?? 'unknown';
  const stack: JsonObject = input.stackFingerprint ?? build?.stack_fingerprint ?? {};

  // Recover prompt_type per execution: exact map from the queue when available, else classify.
  const nameToType = new Map<string, PromptType>();
  if (input.entries) for (const e of input.entries) nameToType.set(e.name, e.prompt_type);
  const typeOf = (ex: PromptExecution): PromptType =>
    nameToType.get(ex.prompt_name) ?? classifyPromptType(ex.prompt_name);

  const groups = groupByType(executions, typeOf);

  if (executions.length === 0) {
    warnings.push('No prompt_executions to analyze — the build recorded nothing (Build Memory empty or unreachable).');
  }

  return {
    buildRunId: input.buildRunId,
    projectName,
    stackFingerprint: stack,
    analyzedPrompts: executions.length,
    error_patterns: extractErrorPatterns(executions, typeOf, stack, executions.length),
    timing_patterns: extractTimingPatterns(groups),
    success_patterns: extractSuccessPatterns(groups),
    cost_patterns: extractCostPatterns(groups),
    governance_correlations: extractGovernanceCorrelations(executions),
    build_cost: summarizeBuildCost(executions, groups, build, input.entries),
    warnings,
    generatedAt: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Build Memory persistence
// ---------------------------------------------------------------------------

/**
 * Persist the report to Build Memory (BLUEPRINT Phase 5):
 *   - error_patterns: per Contract 15, an EXISTING normalized signature has its occurrence_count
 *     incremented (the pattern recurred in this build); a new signature is created with this
 *     build's occurrence count, category, stack, trigger phase + dominant trigger prompt type.
 *   - cross_project_insights: one row each for the timing / success / cost dimensions, carrying
 *     the structured findings as `evidence` so a future build can apply them.
 *
 * Every write is guarded and degrades to stateless (Contract 4) — this never throws.
 */
async function storePatterns(
  patterns: ExtractedPatterns,
  opts: Required<
    Pick<
      PatternExtractorOptions,
      'findMatchingPattern' | 'createErrorPattern' | 'updateOccurrenceCount' | 'createInsight' | 'log'
    >
  >
): Promise<PatternStorageResult> {
  const result: PatternStorageResult = {
    errorPatternsCreated: 0,
    errorPatternsUpdated: 0,
    insightsCreated: 0,
    stateless: false,
    warnings: [],
  };
  let reachedMemory = false;

  // --- error_patterns (Contract 15: create-or-increment by normalized signature) ---
  for (const finding of patterns.error_patterns) {
    try {
      const existing = await opts.findMatchingPattern(finding.errorSignature);
      if (existing) {
        const updated = await opts.updateOccurrenceCount(existing.id);
        if (updated) {
          reachedMemory = true;
          result.errorPatternsUpdated += 1;
        }
        continue;
      }
      const dominantType =
        finding.triggerPromptTypes.length > 0 ? finding.triggerPromptTypes[0] : null;
      const created = await opts.createErrorPattern({
        error_signature: finding.errorSignature,
        error_category: finding.errorCategory,
        error_message_sample: finding.errorMessageSample,
        first_seen_project: patterns.projectName,
        occurrence_count: finding.occurrenceCount,
        stack_fingerprints: [patterns.stackFingerprint],
        trigger_phase: 'phase3',
        ...(dominantType ? { trigger_prompt_pattern: dominantType } : {}),
      });
      if (created) {
        reachedMemory = true;
        result.errorPatternsCreated += 1;
      }
    } catch (error) {
      result.warnings.push(`error_pattern "${finding.errorSignature}" not stored (${describe(error)}).`);
    }
  }

  // --- cross_project_insights (timing / success / cost) ---
  const insights: NewCrossProjectInsight[] = [];
  if (patterns.timing_patterns.length > 0) {
    insights.push({
      insight_type: 'optimization',
      source_project: patterns.projectName,
      source_build_id: patterns.buildRunId,
      applicable_fingerprints: [patterns.stackFingerprint],
      description:
        `Timing patterns for ${patterns.projectName}: per-prompt-type average/median execution time, ` +
        `variance, high outliers, and the complexity↔time correlation across ${patterns.analyzedPrompts} prompt(s).`,
      evidence: jsonClone({ timing_patterns: patterns.timing_patterns }),
    });
  }
  if (patterns.success_patterns.length > 0 || patterns.governance_correlations.length > 0) {
    insights.push({
      insight_type: 'pattern',
      source_project: patterns.projectName,
      source_build_id: patterns.buildRunId,
      applicable_fingerprints: [patterns.stackFingerprint],
      description:
        `Success patterns for ${patterns.projectName}: per-prompt-type success rates, the effect of ` +
        `dynamic rewriting, and governance documents correlated with fewer errors.`,
      evidence: jsonClone({
        success_patterns: patterns.success_patterns,
        governance_correlations: patterns.governance_correlations,
      }),
    });
  }
  if (patterns.cost_patterns.length > 0) {
    insights.push({
      insight_type: 'optimization',
      source_project: patterns.projectName,
      source_build_id: patterns.buildRunId,
      applicable_fingerprints: [patterns.stackFingerprint],
      description:
        `Cost patterns for ${patterns.projectName}: per-prompt-type token/dollar averages and total ` +
        `build cost by complexity (${patterns.build_cost.complexity.tableCount ?? '?'} table(s), ` +
        `${patterns.build_cost.complexity.featureCount} feature(s)).`,
      evidence: jsonClone({ cost_patterns: patterns.cost_patterns, build_cost: patterns.build_cost }),
    });
  }

  for (const insight of insights) {
    try {
      const created = await opts.createInsight(insight);
      if (created) {
        reachedMemory = true;
        result.insightsCreated += 1;
      }
    } catch (error) {
      result.warnings.push(`insight "${insight.description.slice(0, 60)}…" not stored (${describe(error)}).`);
    }
  }

  // If we had findings to store but nothing landed, Build Memory is unreachable (Contract 4).
  const hadSomethingToStore =
    patterns.error_patterns.length > 0 || insights.length > 0;
  if (hadSomethingToStore && !reachedMemory) {
    result.stateless = true;
    result.warnings.push('Build Memory unreachable — patterns analyzed but not persisted (stateless mode, Contract 4).');
    opts.log('WARNING: Build Memory unreachable — patterns not persisted (stateless mode).');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Extract the four pattern dimensions from a completed build and persist them to Build Memory
 * (queue.yaml s6-p01). Fetches the build_run + its prompt_executions (unless supplied), runs the
 * pure {@link analyzePatterns}, and stores the findings (unless `store:false`).
 *
 * Always resolves (never rejects): every Build Memory read/write is guarded and degrades to
 * stateless (Contract 4); the analysis itself is pure and total.
 */
export async function extractPatterns(
  input: ExtractPatternsInput,
  options: PatternExtractorOptions = {}
): Promise<PatternExtractionResult> {
  const log = options.log ?? logLine('patterns');
  const store = options.store ?? true;
  const fetchBuild = options.fetchBuild ?? ((id: string) => BuildMemory.builds.getBuild(id));
  const fetchExecutions =
    options.fetchExecutions ??
    (async (id: string): Promise<PromptExecution[]> => (await BuildMemory.prompts.getPromptsByBuild(id)) ?? []);
  const findMatchingPattern =
    options.findMatchingPattern ?? ((sig: string) => BuildMemory.errors.findMatchingPattern(sig));
  const createErrorPattern =
    options.createErrorPattern ?? ((i: NewErrorPattern) => BuildMemory.errors.createErrorPattern(i));
  const updateOccurrenceCount =
    options.updateOccurrenceCount ?? ((id: string) => BuildMemory.errors.updateOccurrenceCount(id));
  const createInsight =
    options.createInsight ?? ((i: NewCrossProjectInsight) => BuildMemory.insights.createInsight(i));

  const warnings: string[] = [];

  // 1. Resolve the build (guarded — degrade to null/stateless).
  let build: BuildRun | null = input.build ?? null;
  if (build === null) {
    try {
      build = await fetchBuild(input.buildRunId);
    } catch (error) {
      warnings.push(`Could not load build ${input.buildRunId} (${describe(error)}).`);
      log(`WARNING: fetchBuild degraded (${describe(error)})`);
    }
  }

  // 2. Resolve the executions (guarded).
  let executions: PromptExecution[] = input.executions ?? [];
  if (input.executions === undefined) {
    try {
      executions = await fetchExecutions(input.buildRunId);
    } catch (error) {
      warnings.push(`Could not load prompt_executions for ${input.buildRunId} (${describe(error)}).`);
      log(`WARNING: fetchExecutions degraded (${describe(error)})`);
      executions = [];
    }
  }

  log(`analyzing build ${input.buildRunId}: ${executions.length} prompt execution(s)`);

  // 3. Pure analysis.
  const patterns = analyzePatterns(build, executions, input, warnings);
  log(
    `extracted: ${patterns.error_patterns.length} error pattern(s), ${patterns.timing_patterns.length} timing, ` +
      `${patterns.success_patterns.length} success, ${patterns.cost_patterns.length} cost, ` +
      `${patterns.governance_correlations.length} governance correlation(s).`
  );

  // 4. Persist (unless disabled).
  let storage: PatternStorageResult;
  if (store) {
    storage = await storePatterns(patterns, {
      findMatchingPattern,
      createErrorPattern,
      updateOccurrenceCount,
      createInsight,
      log,
    });
    log(
      `stored: ${storage.errorPatternsCreated} new + ${storage.errorPatternsUpdated} updated error pattern(s), ` +
        `${storage.insightsCreated} insight(s)${storage.stateless ? ' (STATELESS — nothing persisted)' : ''}.`
    );
  } else {
    storage = {
      errorPatternsCreated: 0,
      errorPatternsUpdated: 0,
      insightsCreated: 0,
      stateless: false,
      warnings: [],
    };
  }

  return { patterns, storage };
}

export default extractPatterns;
