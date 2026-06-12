/**
 * FORGE 2.0 — Failure Predictor (Phase 3 Build Executor engine, queue.yaml s5-p02).
 *
 * Before each Phase 3 prompt fires, the executor (s5-p05) asks: how likely is THIS prompt
 * to fail? This module answers. Per BEHAVIORAL_CONTRACTS.md Contract 8 (Failure Prediction),
 * FORGE queries Build Memory `error_patterns` for the patterns whose trigger conditions
 * match the prompt about to run — its `prompt_type`, the build's `stack_fingerprint`, and
 * (for context) its 1-based `prompt_index` — and computes a probability. When that
 * probability exceeds {@link REWRITE_THRESHOLD} (0.4) the executor hands the prompt to the
 * prompt-rewriter (s5-p02 sibling) before assembly.
 *
 * PROBABILITY (per the s5-p02 spec, verbatim):
 *
 *     probability = matching_pattern_occurrences / total_builds_with_this_stack_and_type
 *
 *   - `matching_pattern_occurrences` — the sum of `occurrence_count` across every
 *     `error_patterns` row that matches this prompt type AND this stack.
 *   - `total_builds_with_this_stack_and_type` — the number of `build_runs` whose
 *     `stack_fingerprint` matches this stack. (`build_runs` carry no prompt-type column —
 *     a build is not type-scoped — so "and type" collapses to the stack match; the type
 *     scoping lives entirely on the pattern side, via `trigger_prompt_pattern`.)
 *
 *   The ratio is clamped to [0, 1]. The denominator floors at 1 (standard divide-by-zero
 *   guard): with a COLD Build Memory (no recorded builds yet) any matching pattern
 *   occurrence therefore yields a high, rewrite-triggering probability — the conservative
 *   default for a stack FORGE has no track record on.
 *
 * PROMPT INDEX: accepted because the executor passes it and Contract 8 names it, and it is
 * echoed in the recommendation for traceability. The `error_patterns` schema records no
 * per-index granularity (only `trigger_phase`), so the index does NOT currently narrow the
 * candidate set — documented here rather than silently implied (Iron Law 3).
 *
 * NON-FATAL (Contract 4): both Build Memory reads degrade to an empty list on failure, so a
 * DB outage yields probability 0 (no evidence) and a clear recommendation — never an error.
 * Both reads are injectable so the predictor unit-tests without a database. `predictFailure`
 * never throws.
 */

import type { PromptType } from './queue-generator.js';
import type { StackFingerprint } from '../tools/stack-detector.js';
import type { BuildRun, ErrorPattern, JsonObject } from '../types/index.js';
import { BuildMemory } from '../memory/index.js';
import { logLine } from '../tools/forge-logger.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * The probability above which Contract 8 mandates a prompt rewrite. A prediction whose
 * `probability` is strictly greater than this triggers the prompt-rewriter (s5-p05 step c).
 */
export const REWRITE_THRESHOLD = 0.4;

/** How many recent `build_runs` to scan when computing the denominator. */
const BUILD_SCAN_LIMIT = 500;

/** Inputs to {@link predictFailure}. */
export interface FailurePredictionInput {
  /** The kind of prompt about to run — matched against `error_patterns.trigger_prompt_pattern`. */
  promptType: PromptType;
  /** The build's stack fingerprint, used to scope both the patterns and the build count. */
  stackFingerprint?: StackFingerprint | null;
  /** 1-based position of the prompt in the queue (context/logging only — see module note). */
  promptIndex?: number;
}

/** The result of {@link predictFailure} (the s5-p02 return contract + diagnostics). */
export interface FailurePrediction {
  /** Estimated failure probability in [0, 1]. */
  probability: number;
  /** The `error_patterns` rows that matched this prompt type + stack, most-frequent first. */
  matchingPatterns: ErrorPattern[];
  /** Human-readable guidance for the executor / operator. */
  recommendation: string;
  /** Whether `probability` exceeds {@link REWRITE_THRESHOLD} (Contract 8 → rewrite). */
  shouldRewrite: boolean;
  /** Sum of `occurrence_count` across the matching patterns (the formula's numerator). */
  matchingOccurrences: number;
  /** Builds matching this stack that formed the denominator (before the floor-at-1 guard). */
  totalBuildsWithStack: number;
}

/** Options for {@link predictFailure}. */
export interface FailurePredictorOptions {
  /**
   * Override the error-pattern fetch (tests / pre-filtered sets). Given the prompt type,
   * returns candidate patterns (stack filtering is applied here, by the predictor). Default:
   * query `error_patterns` by `trigger_prompt_pattern`. Must never throw (degrade to []).
   */
  fetchPatterns?: (promptType: PromptType) => Promise<ErrorPattern[]>;
  /**
   * Override the build fetch (tests). Returns the recent builds whose stacks form the
   * denominator. Default: `BuildMemory.builds.listBuilds`. Must never throw (degrade to []).
   */
  fetchBuilds?: () => Promise<BuildRun[]>;
  /** Progress reporter. Default logs to the console with a `[FORGE:predictor]` prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Stack matching (shared shape with the prompt-assembler's warning scoping)
// ---------------------------------------------------------------------------

/** The scalar stack keys compared when deciding whether two stacks are "the same". */
const STACK_SCALARS: Array<keyof StackFingerprint> = [
  'framework',
  'language',
  'database',
  'deployment',
  'packageManager',
];

/** Read a jsonb scalar as a lowercased non-empty string, or `null`. */
function jsonScalar(fp: JsonObject, key: string): string | null {
  const v = fp[key];
  return typeof v === 'string' && v.trim() !== '' ? v.toLowerCase() : null;
}

/**
 * True when an error pattern's recorded stacks are relevant to the build's stack. A pattern
 * with no recorded stacks is stack-agnostic (applies broadly); when there is no target stack
 * to scope by, every pattern is kept. Otherwise the pattern matches if ANY recorded
 * fingerprint shares ANY scalar value with the target — the same liberal scoping the
 * prompt-assembler uses for warnings, so the predictor and the injected warnings agree.
 */
function patternMatchesStack(pattern: ErrorPattern, stack: StackFingerprint | null): boolean {
  if (!Array.isArray(pattern.stack_fingerprints) || pattern.stack_fingerprints.length === 0) {
    return true;
  }
  if (!stack) return true;
  const targetScalars = STACK_SCALARS.map((k) => stack[k])
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.toLowerCase());
  if (targetScalars.length === 0) return true;
  for (const raw of pattern.stack_fingerprints) {
    const fp: unknown = raw; // jsonb element — guard at runtime before reading
    if (fp === null || typeof fp !== 'object' || Array.isArray(fp)) continue;
    for (const value of Object.values(fp)) {
      if (typeof value === 'string' && targetScalars.includes(value.toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * True when a build's `stack_fingerprint` matches the target stack: every scalar the target
 * SPECIFIES (non-empty) must equal the build's value for that key. A target that specifies
 * no scalars (or a null target) matches every build.
 */
function buildMatchesStack(buildStack: JsonObject, stack: StackFingerprint | null): boolean {
  if (!stack) return true;
  for (const key of STACK_SCALARS) {
    const want = stack[key];
    if (typeof want !== 'string' || want.trim() === '') continue;
    if (jsonScalar(buildStack, key) !== want.toLowerCase()) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Defaults (Build Memory reads — both degrade to [] per Contract 4)
// ---------------------------------------------------------------------------

async function defaultFetchPatterns(promptType: PromptType): Promise<ErrorPattern[]> {
  const patterns = await BuildMemory.errors.findPatternsByPromptType(promptType);
  return patterns ?? [];
}

async function defaultFetchBuilds(): Promise<BuildRun[]> {
  const builds = await BuildMemory.builds.listBuilds(BUILD_SCAN_LIMIT);
  return builds ?? [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamp a number into [0, 1]; map NaN/Infinity to 0. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Build the human-readable recommendation string. */
function buildRecommendation(
  promptType: PromptType,
  promptIndex: number | undefined,
  probability: number,
  matching: ErrorPattern[],
  occurrences: number,
  totalBuilds: number
): string {
  const where =
    promptIndex !== undefined ? `prompt #${promptIndex} (type '${promptType}')` : `prompt type '${promptType}'`;
  const pct = `${(probability * 100).toFixed(0)}%`;

  if (matching.length === 0) {
    return (
      `No matching error patterns for ${where} on this stack — predicted failure ${pct}. ` +
      'Proceed without a rewrite.'
    );
  }

  const sigs = matching
    .slice(0, 5)
    .map((p) => p.error_signature)
    .join(', ');
  const more = matching.length > 5 ? ` (+${matching.length - 5} more)` : '';
  const base =
    `Predicted failure ${pct} for ${where} — ${occurrences} occurrence(s) across ` +
    `${matching.length} matching pattern(s) over ${totalBuilds} build(s) on this stack. ` +
    `Patterns: ${sigs}${more}.`;

  if (probability > REWRITE_THRESHOLD) {
    const rules = matching
      .map((p) => p.prevention_rule?.trim())
      .filter((r): r is string => !!r && r !== '');
    const prevention =
      rules.length > 0
        ? ` Rewrite the prompt (Contract 8) and apply prevention rules: ${rules.slice(0, 3).join(' | ')}.`
        : ' Rewrite the prompt (Contract 8) using the highest-success-rate precedents for this task type.';
    return `${base} Above the ${REWRITE_THRESHOLD} threshold.${prevention}`;
  }

  return (
    `${base} At or below the ${REWRITE_THRESHOLD} threshold — proceed; prevention guidance is ` +
    'already injected as prompt warnings.'
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Predict the failure probability of the prompt described by `input` and recommend whether
 * to rewrite it (queue.yaml s5-p02). Queries Build Memory `error_patterns` matching the
 * prompt type + stack, divides their summed occurrences by the count of builds on this
 * stack (denominator floored at 1), clamps to [0, 1], and returns the score, the matching
 * patterns, and a recommendation.
 *
 * Never rejects: both Build Memory reads degrade to an empty list on failure (Contract 4).
 */
export async function predictFailure(
  input: FailurePredictionInput,
  options: FailurePredictorOptions = {}
): Promise<FailurePrediction> {
  const log = options.log ?? logLine('predictor');
  const fetchPatterns = options.fetchPatterns ?? defaultFetchPatterns;
  const fetchBuilds = options.fetchBuilds ?? defaultFetchBuilds;
  const stack = input.stackFingerprint ?? null;

  // 1. Candidate patterns for this prompt type, scoped to this stack (guarded).
  let candidates: ErrorPattern[] = [];
  try {
    candidates = await fetchPatterns(input.promptType);
  } catch (error) {
    log(`WARNING: pattern fetch failed (${describe(error)}) — treating as zero patterns`);
    candidates = [];
  }
  const matchingPatterns = candidates
    .filter((p) => patternMatchesStack(p, stack))
    .sort((a, b) => b.occurrence_count - a.occurrence_count);

  const matchingOccurrences = matchingPatterns.reduce((sum, p) => sum + (p.occurrence_count ?? 0), 0);

  // 2. Denominator: builds on this stack (guarded).
  let builds: BuildRun[] = [];
  try {
    builds = await fetchBuilds();
  } catch (error) {
    log(`WARNING: build fetch failed (${describe(error)}) — treating as zero builds`);
    builds = [];
  }
  const totalBuildsWithStack = builds.filter((b) => buildMatchesStack(b.stack_fingerprint, stack)).length;

  // 3. probability = occurrences / max(totalBuilds, 1), clamped to [0, 1].
  const probability = clamp01(matchingOccurrences / Math.max(totalBuildsWithStack, 1));
  const shouldRewrite = probability > REWRITE_THRESHOLD;

  const recommendation = buildRecommendation(
    input.promptType,
    input.promptIndex,
    probability,
    matchingPatterns,
    matchingOccurrences,
    totalBuildsWithStack
  );

  log(
    `${input.promptType}${input.promptIndex !== undefined ? ` #${input.promptIndex}` : ''}: ` +
      `p=${probability.toFixed(4)} (${matchingOccurrences} occ / ${totalBuildsWithStack} builds), ` +
      `${matchingPatterns.length} pattern(s), rewrite=${shouldRewrite}`
  );

  return {
    probability,
    matchingPatterns,
    recommendation,
    shouldRewrite,
    matchingOccurrences,
    totalBuildsWithStack,
  };
}

/** Render an unknown thrown value as a short string for logging. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default predictFailure;
