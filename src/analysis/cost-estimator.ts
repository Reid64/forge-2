/**
 * FORGE 2.0 — Cost Estimator (Phase 5 / F17, queue.yaml s6-p02).
 *
 * Before FORGE commits to a build (or inside Dry Run Mode, F11), the operator wants to know:
 * how many prompts, how many tokens, how many dollars, how long, and how many failures should
 * I expect? This module answers — GROUNDED in Build Memory's actual history rather than a
 * static guess. Given a stack fingerprint and a feature list it predicts, with confidence
 * intervals, the five quantities the spec names:
 *   - Total prompts needed        — derived from the feature list via the standard build order.
 *   - Total tokens                — per-prompt-type averages from `prompt_executions` history.
 *   - Total dollar cost           — per-prompt-type average `cost_usd` history (else token×price).
 *   - Total execution time        — per-prompt-type average duration history.
 *   - Predicted failure count     — the failure-predictor's probability per type × that type's
 *                                   prompt count (REUSING `predictFailure`, so the estimate and
 *                                   the per-prompt Contract-8 gate agree).
 *
 * Output: a {@link BuildEstimate} carrying every prediction with a low/high band and a
 * qualitative confidence keyed to how much real history backed it.
 *
 * CONFIDENCE INTERVALS: each per-type metric's band width comes from its historical sample —
 * many consistent samples ⇒ a tight band + 'high' confidence; few/none ⇒ a wide band + 'low'
 * confidence (and the type's value falls back to a documented default, mirroring the Queue
 * Generator's `BASE_TOKENS`). The aggregate band is the sum of the per-type bands; the overall
 * confidence reflects the fraction of prompts backed by real history.
 *
 * PRICING: the DOLLAR estimate prefers each type's recorded `cost_usd`. Only when a type has no
 * cost history does it fall back to a token×price model whose per-million-token rates are
 * Sonnet-class DEFAULTS (input {@link DEFAULT_INPUT_PRICE_PER_MTOK} / output
 * {@link DEFAULT_OUTPUT_PRICE_PER_MTOK}) — deliberately coarse and OVERRIDABLE via
 * `options.pricing`; they are a fallback, not an authoritative price list (documented per
 * Iron Law 3 rather than presented as fact).
 *
 * ASSUMES SEQUENTIAL execution (the FORGE default — Contract 10 parallelism is "Phase 2 of
 * usage"), so the time estimate SUMS per-prompt durations; a parallel run would be faster and
 * that caveat is surfaced as a warning.
 *
 * DETERMINISTIC + NON-FATAL (Contract 4): the math is pure; every Build Memory read is
 * injectable and guarded — a cold/unreachable Build Memory degrades to the documented defaults
 * with 'low' confidence and a warning, never an error. `estimateBuildCost` never rejects.
 *
 * BOUNDARY: reads `build_runs` / `prompt_executions` / `error_patterns` (the last two via the
 * reused predictor). Writes nothing. Touches no governance file and no target project.
 */

import { classifyPromptType } from './pattern-extractor.js';
import { predictFailure } from '../engine/failure-predictor.js';
import type {
  FailurePrediction,
  FailurePredictionInput,
} from '../engine/failure-predictor.js';
import type { PromptType } from '../engine/queue-generator.js';
import type { StackFingerprint } from '../tools/stack-detector.js';
import { logLine } from '../tools/forge-logger.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import type { JsonObject, PromptExecution } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Confidence in a prediction, keyed to the size of the backing historical sample. */
export type Confidence = 'low' | 'medium' | 'high';

/** A point estimate with a low/high confidence band. */
export interface MetricEstimate {
  estimate: number;
  low: number;
  high: number;
}

/** A described feature to build — a bare name, or a name with explicit entity counts. */
export interface FeatureSpec {
  name: string;
  /** Database tables this feature introduces (else a per-feature default is assumed). */
  tables?: number;
  /** API routes this feature needs (else a per-feature default is assumed). */
  apiRoutes?: number;
  /** UI pages this feature renders (else 1 is assumed). */
  pages?: number;
  /** Background agents this feature requires (else 0). */
  agents?: number;
}

/** Per-million-token prices for the dollar fallback (overridable). */
export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Inputs to {@link estimateBuildCost}. */
export interface CostEstimateInput {
  /** The target stack (scopes the failure prediction; echoed in the estimate). */
  stackFingerprint?: StackFingerprint | null;
  /** The features to build — strings or {@link FeatureSpec}s. */
  features: Array<FeatureSpec | string>;
  /** Override the derived total table count (else summed from features). */
  tableCount?: number;
  /** Override the derived total API-route count (else summed from features). */
  apiRouteCount?: number;
  /** Override the derived total page count (else one per feature). */
  pageCount?: number;
  /** Override the derived total agent count (else summed from features). */
  agentCount?: number;
}

/** Per-prompt-type breakdown for one metric. */
export interface CostEstimateByType {
  promptType: PromptType;
  promptCount: number;
  /** Historical samples that informed this type (0 ⇒ a default was used). */
  samples: number;
  confidence: Confidence;
  tokens: MetricEstimate;
  costUsd: MetricEstimate;
  timeMs: MetricEstimate;
  predictedFailures: number;
}

/** The complete build estimate (the s6-p02 / F17 output contract). */
export interface BuildEstimate {
  stackFingerprint: JsonObject | null;
  /** Prompt count per type, derived from the feature list. */
  promptsByType: Record<PromptType, number>;
  totalPrompts: number;
  /** Total tokens (input + output) with a band. */
  tokens: MetricEstimate & { input: number; output: number };
  /** Total dollar cost with a band. */
  costUsd: MetricEstimate;
  /** Total wall-clock time (sequential) with a band, plus a human-readable estimate. */
  executionTime: MetricEstimate & { human: string };
  /** Predicted failing prompts across the build, with a band. */
  predictedFailures: MetricEstimate;
  /** Per-prompt-type breakdown. */
  byType: CostEstimateByType[];
  confidence: {
    overall: Confidence;
    /** Fraction of prompts whose token estimate came from real history, in [0, 1]. */
    historicalCoverage: number;
    /** Total historical prompt_executions analyzed. */
    historicalPromptsAnalyzed: number;
    /** Builds on this stack that scoped the failure prediction. */
    buildsOnStack: number;
  };
  /** Prompt types that fell back to defaults (no usable history). */
  usedDefaultsFor: PromptType[];
  /** The pricing used for any token×price fallback. */
  pricing: Pricing;
  warnings: string[];
  generatedAt: string;
}

/** Options for {@link estimateBuildCost} — injectable Build Memory I/O + overrides (tests). */
export interface CostEstimatorOptions {
  /** How many recent builds to scan for historical averages. Default 200. */
  buildScanLimit?: number;
  /** Per-million-token fallback prices. Default Sonnet-class (3 / 15). */
  pricing?: Partial<Pricing>;
  /**
   * Fetch the historical executions to average. Default: recent builds'
   * `prompt_executions` via Build Memory (→ []). Must never throw (degrade to []).
   */
  fetchExecutions?: () => Promise<PromptExecution[]>;
  /**
   * Map an execution to its prompt type. Default `classifyPromptType(prompt_name)`. Supply the
   * approved queue `entries` indirectly by overriding this when an exact map is available.
   */
  typeOf?: (ex: PromptExecution) => PromptType;
  /** Predict per-type failure probability. Default `predictFailure` (Contract 8). Never throws. */
  predict?: (input: FailurePredictionInput) => Promise<FailurePrediction>;
  /** Progress reporter. Default logs to the console with a `[FORGE:cost]` prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Every prompt type — iteration order for the per-type records. */
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

/** Default recent-build scan window for historical averaging. */
const DEFAULT_BUILD_SCAN_LIMIT = 200;

/** Sonnet-class fallback prices per million tokens (coarse, overridable — see module note). */
export const DEFAULT_INPUT_PRICE_PER_MTOK = 3;
export const DEFAULT_OUTPUT_PRICE_PER_MTOK = 15;

/**
 * Default total tokens per prompt type when Build Memory has no history — MIRRORS the Queue
 * Generator's `BASE_TOKENS` so estimates agree with the queue's own `estimated_tokens`.
 */
const DEFAULT_TOKENS_PER_TYPE: Record<PromptType, number> = {
  schema: 4000,
  auth: 5000,
  api: 4000,
  ui: 5000,
  feature: 6000,
  agent: 7000,
  test: 4000,
  deploy: 3000,
};

/** Default input:output token split when only a total default is known. */
const DEFAULT_INPUT_RATIO = 0.5;

/** Default per-prompt wall-clock seconds per type when Build Memory has no timing history. */
const DEFAULT_SECONDS_PER_TYPE: Record<PromptType, number> = {
  schema: 120,
  auth: 150,
  api: 120,
  ui: 150,
  feature: 240,
  agent: 300,
  test: 180,
  deploy: 120,
};

/** Per-feature default entity counts when the feature does not specify them. */
const DEFAULT_TABLES_PER_FEATURE = 1;
const DEFAULT_ROUTES_PER_FEATURE = 2;
const DEFAULT_PAGES_PER_FEATURE = 1;

/** Sample-count thresholds that set per-type confidence. */
const HIGH_CONFIDENCE_SAMPLES = 8;
const MEDIUM_CONFIDENCE_SAMPLES = 3;

/** Relative band half-widths (fraction of the estimate) by confidence tier. */
const RELWIDTH_LOW = 0.5;
const RELWIDTH_MEDIUM = 0.3;
/** For 'high' confidence the band comes from the sample's own coefficient of variation, clamped. */
const RELWIDTH_HIGH_FLOOR = 0.1;
const RELWIDTH_HIGH_CAP = 0.3;

// ---------------------------------------------------------------------------
// Numeric helpers (pure)
// ---------------------------------------------------------------------------

/** Clamp a number into [lo, hi]; map non-finite to lo. */
function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/** Round to a fixed number of decimals. */
function round(n: number, decimals = 4): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** Arithmetic mean of a list (0 for empty). */
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (0 for < 2 samples). */
function sampleStdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/** Render an unknown thrown value as a short string for logging. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A coarse human-readable duration from milliseconds. */
function humanDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Step 1 — derive prompt counts from the feature list (pure)
// ---------------------------------------------------------------------------

/** Normalize a feature input (string or spec) to a {@link FeatureSpec}. */
function normalizeFeature(f: FeatureSpec | string): FeatureSpec {
  return typeof f === 'string' ? { name: f } : f;
}

/** The derived entity totals that drive the prompt counts. */
export interface DerivedScope {
  tableCount: number;
  apiRouteCount: number;
  pageCount: number;
  agentCount: number;
  featureCount: number;
}

/** Sum entity counts across the feature list, honoring explicit overrides. */
function deriveScope(input: CostEstimateInput): DerivedScope {
  const features = input.features.map(normalizeFeature);
  const sum = (pick: (f: FeatureSpec) => number | undefined, dflt: number): number =>
    features.reduce((acc, f) => acc + (pick(f) ?? dflt), 0);

  return {
    featureCount: features.length,
    tableCount: input.tableCount ?? sum((f) => f.tables, DEFAULT_TABLES_PER_FEATURE),
    apiRouteCount: input.apiRouteCount ?? sum((f) => f.apiRoutes, DEFAULT_ROUTES_PER_FEATURE),
    pageCount: input.pageCount ?? sum((f) => f.pages, DEFAULT_PAGES_PER_FEATURE),
    agentCount: input.agentCount ?? sum((f) => f.agents, 0),
  };
}

/**
 * Map the derived scope to a prompt count per type, following the Queue Generator's standard
 * build order (schema → auth → api → ui → features → agents → tests → deploy, with verify
 * folded into the test type as `classifyPromptType` does).
 */
export function derivePromptCounts(scope: DerivedScope): Record<PromptType, number> {
  return {
    schema: 1 + Math.floor(scope.tableCount / 10),
    auth: 1,
    api: Math.max(1, Math.ceil(scope.apiRouteCount / 3)),
    ui: 1,
    feature: Math.max(0, scope.pageCount),
    agent: Math.max(0, scope.agentCount),
    // tests-e2e + tests-api + verify-six-laws (verify classifies as 'test').
    test: 3,
    deploy: 1,
  };
}

// ---------------------------------------------------------------------------
// Step 2 — per-type historical statistics (pure)
// ---------------------------------------------------------------------------

/** Averaged statistics for one prompt type, drawn from historical executions. */
interface TypeStats {
  /** Number of historical executions that informed this type (max over the metrics). */
  samples: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanCostUsd: number;
  meanDurationMs: number;
  /** Coefficient of variation of total tokens (σ/μ), for the high-confidence band. */
  tokenCv: number;
  /** Whether a cost history existed (else the dollar fallback applies). */
  hasCostHistory: boolean;
  /** Whether a timing history existed (else the duration default applies). */
  hasTimeHistory: boolean;
}

/** Measurable execution time (ms), or null. */
function durationMs(ex: PromptExecution): number | null {
  if (!ex.started_at || !ex.completed_at) return null;
  const s = Date.parse(ex.started_at);
  const e = Date.parse(ex.completed_at);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  const d = e - s;
  return d >= 0 ? d : null;
}

/** Compute per-type statistics from the historical executions. */
function computeTypeStats(
  executions: PromptExecution[],
  typeOf: (ex: PromptExecution) => PromptType
): Map<PromptType, TypeStats> {
  const byType = new Map<PromptType, PromptExecution[]>();
  for (const ex of executions) {
    const t = typeOf(ex);
    const list = byType.get(t);
    if (list) list.push(ex);
    else byType.set(t, [ex]);
  }

  const stats = new Map<PromptType, TypeStats>();
  for (const [type, list] of byType) {
    const inputs = list.map((ex) => ex.tokens_input ?? 0).filter((n) => n > 0);
    const outputs = list.map((ex) => ex.tokens_output ?? 0).filter((n) => n > 0);
    const totals = list
      .map((ex) => (ex.tokens_input ?? 0) + (ex.tokens_output ?? 0))
      .filter((n) => n > 0);
    const costs = list.map((ex) => ex.cost_usd ?? 0).filter((n) => n > 0);
    const durations = list
      .map(durationMs)
      .filter((n): n is number => n !== null && n > 0);

    const meanTotal = mean(totals);
    const tokenCv = meanTotal > 0 ? sampleStdDev(totals) / meanTotal : 0;

    stats.set(type, {
      samples: Math.max(inputs.length, outputs.length, costs.length, durations.length),
      meanInputTokens: mean(inputs),
      meanOutputTokens: mean(outputs),
      meanCostUsd: mean(costs),
      meanDurationMs: mean(durations),
      tokenCv,
      hasCostHistory: costs.length > 0,
      hasTimeHistory: durations.length > 0,
    });
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Step 3 — band + confidence helpers (pure)
// ---------------------------------------------------------------------------

/** Confidence tier from a sample count. */
function confidenceFor(samples: number): Confidence {
  if (samples >= HIGH_CONFIDENCE_SAMPLES) return 'high';
  if (samples >= MEDIUM_CONFIDENCE_SAMPLES) return 'medium';
  return 'low';
}

/** Relative band half-width for a per-type metric, from its sample count + variability. */
function relWidthFor(samples: number, cv: number): number {
  if (samples >= HIGH_CONFIDENCE_SAMPLES) {
    return clamp(cv, RELWIDTH_HIGH_FLOOR, RELWIDTH_HIGH_CAP);
  }
  if (samples >= MEDIUM_CONFIDENCE_SAMPLES) return RELWIDTH_MEDIUM;
  return RELWIDTH_LOW;
}

/** A point estimate widened into a band by a relative half-width (low floored at 0). */
function band(estimate: number, relWidth: number): MetricEstimate {
  return {
    estimate: round(estimate, 2),
    low: round(Math.max(0, estimate * (1 - relWidth)), 2),
    high: round(estimate * (1 + relWidth), 2),
  };
}

/** Sum a list of bands into one aggregate band. */
function sumBands(bands: MetricEstimate[]): MetricEstimate {
  return bands.reduce<MetricEstimate>(
    (acc, b) => ({
      estimate: round(acc.estimate + b.estimate, 2),
      low: round(acc.low + b.low, 2),
      high: round(acc.high + b.high, 2),
    }),
    { estimate: 0, low: 0, high: 0 }
  );
}

// ---------------------------------------------------------------------------
// Defaults (Build Memory reads — degrade to [] per Contract 4)
// ---------------------------------------------------------------------------

function defaultFetchExecutions(limit: number): () => Promise<PromptExecution[]> {
  return async () => {
    const builds = (await BuildMemory.builds.listBuilds(limit)) ?? [];
    const all: PromptExecution[] = [];
    for (const b of builds) {
      const rows = await BuildMemory.prompts.getPromptsByBuild(b.id);
      if (rows) all.push(...rows);
    }
    return all;
  };
}

/** Cast a stack fingerprint to a plain jsonb object for the output (deep-cloned). */
function stackToJson(stack: StackFingerprint | null | undefined): JsonObject | null {
  if (!stack) return null;
  return JSON.parse(JSON.stringify(stack)) as JsonObject;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Estimate the cost of building `input.features` on `input.stackFingerprint` (queue.yaml
 * s6-p02 / F17). Derives prompt counts from the feature list, averages tokens/cost/time per
 * prompt type from Build Memory history (defaulting where history is thin), predicts failures
 * via the reused failure-predictor, and returns a {@link BuildEstimate} with confidence bands.
 *
 * Always resolves (never rejects): every Build Memory read is guarded and degrades to the
 * documented defaults with 'low' confidence (Contract 4).
 */
export async function estimateBuildCost(
  input: CostEstimateInput,
  options: CostEstimatorOptions = {}
): Promise<BuildEstimate> {
  const log = options.log ?? logLine('cost');
  const buildScanLimit = options.buildScanLimit ?? DEFAULT_BUILD_SCAN_LIMIT;
  const pricing: Pricing = {
    inputPerMTok: options.pricing?.inputPerMTok ?? DEFAULT_INPUT_PRICE_PER_MTOK,
    outputPerMTok: options.pricing?.outputPerMTok ?? DEFAULT_OUTPUT_PRICE_PER_MTOK,
  };
  const fetchExecutions = options.fetchExecutions ?? defaultFetchExecutions(buildScanLimit);
  const typeOf = options.typeOf ?? ((ex: PromptExecution) => classifyPromptType(ex.prompt_name));
  const predict = options.predict ?? ((i: FailurePredictionInput) => predictFailure(i));
  const stack = input.stackFingerprint ?? null;

  const warnings: string[] = [];

  // 1. Prompt counts from the feature list.
  const scope = deriveScope(input);
  const promptsByType = derivePromptCounts(scope);
  const totalPrompts = ALL_PROMPT_TYPES.reduce((acc, t) => acc + promptsByType[t], 0);

  // 2. Historical per-type stats (guarded → empty on failure).
  let executions: PromptExecution[] = [];
  try {
    executions = await fetchExecutions();
  } catch (error) {
    warnings.push(`Could not load historical prompt_executions (${describe(error)}).`);
    log(`WARNING: fetchExecutions degraded (${describe(error)})`);
    executions = [];
  }
  const typeStats = computeTypeStats(executions, typeOf);

  // 3. Per-type estimates + bands.
  const usedDefaultsFor: PromptType[] = [];
  let promptsWithHistory = 0;
  let buildsOnStack = 0;
  const byType: CostEstimateByType[] = [];

  for (const type of ALL_PROMPT_TYPES) {
    const count = promptsByType[type];
    const stats = typeStats.get(type);
    const samples = stats?.samples ?? 0;
    const hasTokenHistory = !!stats && (stats.meanInputTokens > 0 || stats.meanOutputTokens > 0);

    // Tokens (input/output) — history if present, else the documented default split.
    let perInput: number;
    let perOutput: number;
    if (hasTokenHistory && stats) {
      perInput = stats.meanInputTokens;
      perOutput = stats.meanOutputTokens;
    } else {
      const dflt = DEFAULT_TOKENS_PER_TYPE[type];
      perInput = dflt * DEFAULT_INPUT_RATIO;
      perOutput = dflt * (1 - DEFAULT_INPUT_RATIO);
      if (count > 0) usedDefaultsFor.push(type);
    }
    const perTotal = perInput + perOutput;
    if (hasTokenHistory) promptsWithHistory += count;

    const relWidth = relWidthFor(samples, stats?.tokenCv ?? 0);
    const tokenBand = band(perTotal * count, relWidth);

    // Cost — recorded cost_usd if present, else token×price fallback.
    const perCost =
      stats?.hasCostHistory && stats
        ? stats.meanCostUsd
        : (perInput / 1_000_000) * pricing.inputPerMTok +
          (perOutput / 1_000_000) * pricing.outputPerMTok;
    const costBand = band(perCost * count, relWidth);

    // Time — recorded duration if present, else the per-type default seconds.
    const perTimeMs =
      stats?.hasTimeHistory && stats
        ? stats.meanDurationMs
        : DEFAULT_SECONDS_PER_TYPE[type] * 1000;
    const timeBand = band(perTimeMs * count, relWidth);

    // Failures — predictor probability × this type's prompt count (guarded).
    let probability = 0;
    if (count > 0) {
      try {
        const prediction = await predict({ promptType: type, stackFingerprint: stack });
        probability = prediction.probability;
        buildsOnStack = Math.max(buildsOnStack, prediction.totalBuildsWithStack);
      } catch (error) {
        warnings.push(`Failure prediction for '${type}' degraded (${describe(error)}).`);
        probability = 0;
      }
    }
    const predictedFailures = round(probability * count, 2);

    byType.push({
      promptType: type,
      promptCount: count,
      samples,
      confidence: confidenceFor(samples),
      tokens: tokenBand,
      costUsd: costBand,
      timeMs: timeBand,
      predictedFailures,
    });
  }

  // 4. Aggregate the per-type bands.
  const tokenAgg = sumBands(byType.map((b) => b.tokens));
  const costAgg = sumBands(byType.map((b) => b.costUsd));
  const timeAgg = sumBands(byType.map((b) => b.timeMs));

  // Split aggregate tokens into input/output for visibility.
  let totalInput = 0;
  let totalOutput = 0;
  for (const type of ALL_PROMPT_TYPES) {
    const count = promptsByType[type];
    const stats = typeStats.get(type);
    const hasTokenHistory = !!stats && (stats.meanInputTokens > 0 || stats.meanOutputTokens > 0);
    if (hasTokenHistory && stats) {
      totalInput += stats.meanInputTokens * count;
      totalOutput += stats.meanOutputTokens * count;
    } else {
      const dflt = DEFAULT_TOKENS_PER_TYPE[type];
      totalInput += dflt * DEFAULT_INPUT_RATIO * count;
      totalOutput += dflt * (1 - DEFAULT_INPUT_RATIO) * count;
    }
  }

  // Failures aggregate — band widened by how many builds scoped the prediction (fewer ⇒ wider).
  const failuresEstimate = round(
    byType.reduce((acc, b) => acc + b.predictedFailures, 0),
    2
  );
  const failureRelWidth = clamp(1 / Math.sqrt(Math.max(buildsOnStack, 1)), 0.2, 0.75);
  const failuresAgg = band(failuresEstimate, failureRelWidth);

  // 5. Confidence.
  const historicalCoverage = totalPrompts > 0 ? round(promptsWithHistory / totalPrompts) : 0;
  const overall: Confidence =
    historicalCoverage >= 0.75 ? 'high' : historicalCoverage >= 0.34 ? 'medium' : 'low';

  if (executions.length === 0) {
    warnings.push(
      'No historical prompt_executions — all estimates use documented defaults (low confidence).'
    );
  }
  warnings.push(
    'Execution time assumes SEQUENTIAL execution (the FORGE default); a parallel run would be faster.'
  );

  log(
    `estimate: ${totalPrompts} prompt(s), ~${Math.round(tokenAgg.estimate)} tokens, ` +
      `~$${costAgg.estimate}, ~${humanDuration(timeAgg.estimate)}, ` +
      `~${failuresEstimate} predicted failure(s); coverage ${historicalCoverage} (${overall}).`
  );

  return {
    stackFingerprint: stackToJson(stack),
    promptsByType,
    totalPrompts,
    tokens: {
      estimate: round(tokenAgg.estimate, 0),
      low: round(tokenAgg.low, 0),
      high: round(tokenAgg.high, 0),
      input: round(totalInput, 0),
      output: round(totalOutput, 0),
    },
    costUsd: costAgg,
    executionTime: { ...timeAgg, human: humanDuration(timeAgg.estimate) },
    predictedFailures: failuresAgg,
    byType,
    confidence: {
      overall,
      historicalCoverage,
      historicalPromptsAnalyzed: executions.length,
      buildsOnStack,
    },
    usedDefaultsFor,
    pricing,
    warnings,
    generatedAt: nowIso(),
  };
}

export default estimateBuildCost;
