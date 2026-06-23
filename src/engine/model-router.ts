/**
 * FORGE 2.0 — Model Router (Phase 3 Build Executor engine).
 *
 * Not every build prompt deserves the same model. Designing a database schema or a whole
 * feature (with interaction-level granularity, Contract 18) is reasoning-heavy and benefits
 * from the strongest model; emitting a standard CRUD API route or a boilerplate UI shell is
 * routine and a mid-tier model handles it at a fraction of the cost; a one-line fix, a
 * formatting pass, or a Contract-14 Autonomous-Recovery re-run is cheap work where the
 * fastest/cheapest model is the right call. The Model Router encodes that policy: given a
 * queue entry's `prompt_type` (and whether this is a recovery attempt) it selects the Claude
 * model to run the prompt on, and a {@link ModelCostTracker} logs the ESTIMATED token cost
 * per model per prompt so the operator can see where the build's dollars go.
 *
 * ROUTING POLICY (the three tiers the spec names):
 *   - architecture/design  → claude-opus-4-6            : `schema`, `feature`, `agent`
 *   - standard CRUD/boilerplate → claude-sonnet-4-6     : `api`, `ui`, `auth`, `test`
 *   - simple fix/format/recovery → claude-haiku-4-5-20251001 : `deploy`, AND any prompt
 *                                                          re-run during Autonomous Recovery
 *                                                          (regardless of its `prompt_type`).
 *
 * The `isRecovery` flag OVERRIDES the per-type mapping to the Haiku (simple) tier — a recovery
 * attempt is, by construction, a small targeted fix on top of work the stronger model already
 * did, so it routes cheap (Contract 14 caps recovery at 2 attempts before human escalation,
 * so this never burns the expensive model on a retry loop).
 *
 * COST TRACKER: {@link estimateModelCost} prices an (input, output) token pair against the
 * selected model's per-million-token rates ({@link MODEL_PRICING}); {@link ModelCostTracker}
 * accumulates one {@link ModelCostEntry} per recorded prompt and rolls them up per model and
 * for the whole build. The prices mirror the Cost Estimator's Sonnet-class defaults (input 3 /
 * output 15) for the Sonnet tier and are documented coarse list rates for the others — they are
 * an ESTIMATE for telemetry/budgeting, not an authoritative invoice (Iron Law 3), and every
 * rate is overridable.
 *
 * DETERMINISTIC + PURE + NON-FATAL: selection and pricing are pure functions of their inputs
 * (the same entry always routes to the same model); nothing here performs I/O, calls a model,
 * or touches a governance file or the target project. `selectModel`/`estimateModelCost` never
 * throw. The tracker is an in-memory accumulator with no external dependency.
 *
 * BOUNDARY: this module decides WHICH model and what a run is ESTIMATED to cost. It does NOT
 * spawn Claude — that is the Claude Runner's sole job (Contract 5); the runner's CLI does not
 * currently accept a per-invocation model over its interface, so the selected model is recorded
 * for telemetry/cost and is the wiring point for when it does. The Prompt Assembler consumes
 * {@link selectModel} so model selection is automatic at assembly time.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { PromptType, QueueEntry } from './queue-generator.js';
import { nowIso } from '../memory/index.js';
import { logLine } from '../tools/forge-logger.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The Claude models FORGE routes build prompts to (most → least capable). */
export type ClaudeModel =
  | 'claude-opus-4-6'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5-20251001';

/** The work tier a prompt falls into — drives the model choice. */
export type ModelTier = 'architecture' | 'standard' | 'simple';

/** Per-million-token prices for a model (USD). Overridable — see module note. */
export interface ModelPricing {
  /** Dollars per 1,000,000 input tokens. */
  inputPerMTok: number;
  /** Dollars per 1,000,000 output tokens. */
  outputPerMTok: number;
}

/** The outcome of routing one prompt to a model. */
export interface ModelSelection {
  /** The selected Claude model id (what the runner should be told to use). */
  model: ClaudeModel;
  /** The tier the prompt was placed in. */
  tier: ModelTier;
  /** The prompt type that drove the (non-recovery) routing. */
  promptType: PromptType;
  /** Whether the simple-tier override fired because this is a recovery attempt. */
  isRecovery: boolean;
  /** Human-readable justification (logged + surfaced in telemetry). */
  reason: string;
  /** The pricing used for this model (for downstream cost estimation). */
  pricing: ModelPricing;
}

/** Inputs to {@link selectModel}. */
export interface SelectModelInput {
  /** The queue entry's prompt type (the routing key). */
  promptType: PromptType;
  /**
   * True when this is a Contract-14 Autonomous-Recovery re-run (or any targeted fix/format
   * pass). Forces the simple (Haiku) tier regardless of `promptType`. Default false.
   */
  isRecovery?: boolean;
}

/** Options for {@link selectModel} — overridable policy tables (tests / tuning). */
export interface ModelRouterOptions {
  /** Override the prompt-type → tier mapping. Merged over {@link DEFAULT_TYPE_TIER}. */
  typeTier?: Partial<Record<PromptType, ModelTier>>;
  /** Override the tier → model mapping. Merged over {@link DEFAULT_TIER_MODEL}. */
  tierModel?: Partial<Record<ModelTier, ClaudeModel>>;
  /** Override the per-model pricing. Merged (per model) over {@link MODEL_PRICING}. */
  pricing?: Partial<Record<ClaudeModel, Partial<ModelPricing>>>;
}

// ---------------------------------------------------------------------------
// Policy tables (the routing decision, in one place)
// ---------------------------------------------------------------------------

/**
 * Prompt type → work tier. Schema/feature/agent are the design-heavy, reasoning-intensive
 * prompts (database design, full-feature interaction maps, new-agent code generation);
 * api/ui/auth/test are standard implementation/boilerplate; deploy is simple config work.
 */
export const DEFAULT_TYPE_TIER: Record<PromptType, ModelTier> = {
  schema: 'architecture',
  feature: 'architecture',
  agent: 'architecture',
  api: 'standard',
  ui: 'standard',
  auth: 'standard',
  test: 'standard',
  deploy: 'simple',
};

/** Work tier → Claude model (the spec's three-tier mapping). */
export const DEFAULT_TIER_MODEL: Record<ModelTier, ClaudeModel> = {
  architecture: 'claude-sonnet-4-6' /* was opus */,
  standard: 'claude-sonnet-4-6',
  simple: 'claude-haiku-4-5-20251001',
};

/**
 * Per-model list prices (USD per million tokens). Sonnet mirrors the Cost Estimator's
 * documented defaults (3 / 15); Opus and Haiku are the standard published rates for their
 * class. Coarse + overridable — an estimate, not an invoice (Iron Law 3 / module note).
 */
export const MODEL_PRICING: Record<ClaudeModel, ModelPricing> = {
  'claude-opus-4-6': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5 },
};

// ---------------------------------------------------------------------------
// Selection (pure)
// ---------------------------------------------------------------------------

/** Resolve the pricing for a model, applying any per-model overrides. */
function resolvePricing(
  model: ClaudeModel,
  overrides: ModelRouterOptions['pricing']
): ModelPricing {
  const base = MODEL_PRICING[model];
  const over = overrides?.[model];
  return {
    inputPerMTok: over?.inputPerMTok ?? base.inputPerMTok,
    outputPerMTok: over?.outputPerMTok ?? base.outputPerMTok,
  };
}

/**
 * Select the Claude model for a prompt (pure). A recovery attempt always routes to the simple
 * (Haiku) tier; otherwise the prompt's type maps to a tier and the tier maps to a model. Never
 * throws — an unknown prompt type (should be impossible given the union) falls back to the
 * standard tier with a noted reason.
 */
export function selectModel(
  input: SelectModelInput,
  options: ModelRouterOptions = {}
): ModelSelection {
  const { promptType } = input;
  const isRecovery = input.isRecovery ?? false;
  const tierModel = { ...DEFAULT_TIER_MODEL, ...options.tierModel };

  let tier: ModelTier;
  let reason: string;
  if (isRecovery) {
    tier = 'simple';
    reason = `Recovery attempt for a '${promptType}' prompt — routed to the simple tier (cheap, fast targeted fix; Contract 14).`;
  } else {
    const typeTier: Record<PromptType, ModelTier> = { ...DEFAULT_TYPE_TIER, ...options.typeTier };
    const mapped: ModelTier | undefined = typeTier[promptType];
    tier = mapped ?? 'standard';
    reason =
      mapped === undefined
        ? `Unknown prompt type '${promptType}' — defaulted to the standard tier.`
        : tier === 'architecture'
          ? `'${promptType}' is design/architecture work — routed to the architecture tier.`
          : tier === 'standard'
            ? `'${promptType}' is standard implementation/boilerplate — routed to the standard tier.`
            : `'${promptType}' is simple/config work — routed to the simple tier.`;
  }

  const model = tierModel[tier] ?? DEFAULT_TIER_MODEL[tier];
  return {
    model,
    tier,
    promptType,
    isRecovery,
    reason,
    pricing: resolvePricing(model, options.pricing),
  };
}

/** Convenience: route a {@link QueueEntry} directly (reads its `prompt_type`). */
export function selectModelForEntry(
  entry: QueueEntry,
  opts: { isRecovery?: boolean } & ModelRouterOptions = {}
): ModelSelection {
  const { isRecovery, ...routerOptions } = opts;
  return selectModel(
    { promptType: entry.prompt_type, isRecovery: isRecovery ?? false },
    routerOptions
  );
}

// ---------------------------------------------------------------------------
// Cost estimation (pure)
// ---------------------------------------------------------------------------

/**
 * Estimate the USD cost of an (input, output) token pair on a model. Negative / non-finite
 * token counts are treated as zero. Rounded to 6 decimals (sub-cent precision). Never throws.
 */
export function estimateModelCost(
  model: ClaudeModel,
  inputTokens: number,
  outputTokens: number,
  pricingOverride?: Partial<ModelPricing>
): number {
  const base = MODEL_PRICING[model];
  const inPrice = pricingOverride?.inputPerMTok ?? base.inputPerMTok;
  const outPrice = pricingOverride?.outputPerMTok ?? base.outputPerMTok;
  const safeIn = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const safeOut = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  const cost = (safeIn / 1_000_000) * inPrice + (safeOut / 1_000_000) * outPrice;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Estimate the cost of a prompt from a SINGLE total-token budget (e.g. a queue entry's
 * `estimated_tokens`), splitting it into input/output by `inputRatio` (default 0.5). Useful at
 * assembly time, before the real output is known. Never throws.
 */
export function estimateModelCostFromBudget(
  model: ClaudeModel,
  totalTokens: number,
  inputRatio = 0.5,
  pricingOverride?: Partial<ModelPricing>
): { inputTokens: number; outputTokens: number; costUsd: number } {
  const total = Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : 0;
  const ratio = Number.isFinite(inputRatio) ? Math.min(1, Math.max(0, inputRatio)) : 0.5;
  const inputTokens = Math.round(total * ratio);
  const outputTokens = Math.round(total - inputTokens);
  return {
    inputTokens,
    outputTokens,
    costUsd: estimateModelCost(model, inputTokens, outputTokens, pricingOverride),
  };
}

// ---------------------------------------------------------------------------
// Cost tracker
// ---------------------------------------------------------------------------

/** One logged cost estimate — a single prompt's run on a single model. */
export interface ModelCostEntry {
  /** Descriptive prompt name (from the queue entry), if known. */
  promptName?: string;
  /** 1-based queue index, if known. */
  promptIndex?: number;
  /** The model the prompt ran on. */
  model: ClaudeModel;
  /** The tier that selected the model. */
  tier: ModelTier;
  /** The prompt type. */
  promptType: PromptType;
  /** Estimated input tokens. */
  inputTokens: number;
  /** Estimated output tokens. */
  outputTokens: number;
  /** Estimated dollar cost (input + output). */
  costUsd: number;
  /** Whether this run was a recovery attempt. */
  isRecovery: boolean;
  /** ISO timestamp the entry was recorded. */
  at: string;
}

/** What to log into a {@link ModelCostTracker}. */
export interface RecordCostInput {
  selection: ModelSelection;
  inputTokens: number;
  outputTokens: number;
  promptName?: string;
  promptIndex?: number;
}

/** Per-model rollup. */
export interface ModelCostRollup {
  model: ClaudeModel;
  prompts: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** The tracker's full summary. */
export interface ModelCostSummary {
  totalPrompts: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byModel: ModelCostRollup[];
}

/**
 * In-memory accumulator of per-prompt cost ESTIMATES, grouped per model. Holds no external
 * state, performs no I/O — the executor (or the assembler) records one entry per prompt and
 * reads back {@link ModelCostTracker.summary} for the build report. Pure + non-fatal: a
 * non-finite token count is coerced to 0 rather than corrupting the totals.
 */
export class ModelCostTracker {
  private readonly _entries: ModelCostEntry[] = [];

  /** Optional progress reporter (default: a `[FORGE:model-router]`-prefixed console line). */
  constructor(private readonly log: (message: string) => void = logLine('model-router')) {}

  /** Record a prompt's estimated cost. Returns the stored entry. */
  record(input: RecordCostInput): ModelCostEntry {
    const { selection } = input;
    const inputTokens = Number.isFinite(input.inputTokens) && input.inputTokens > 0 ? input.inputTokens : 0;
    const outputTokens = Number.isFinite(input.outputTokens) && input.outputTokens > 0 ? input.outputTokens : 0;
    const costUsd = estimateModelCost(selection.model, inputTokens, outputTokens, selection.pricing);
    const entry: ModelCostEntry = {
      ...(input.promptName !== undefined ? { promptName: input.promptName } : {}),
      ...(input.promptIndex !== undefined ? { promptIndex: input.promptIndex } : {}),
      model: selection.model,
      tier: selection.tier,
      promptType: selection.promptType,
      inputTokens,
      outputTokens,
      costUsd,
      isRecovery: selection.isRecovery,
      at: nowIso(),
    };
    this._entries.push(entry);
    this.log(
      `${entry.promptName ?? entry.promptType}${entry.promptIndex !== undefined ? ` (#${entry.promptIndex})` : ''} → ` +
        `${entry.model} [${entry.tier}${entry.isRecovery ? ', recovery' : ''}] ` +
        `~${inputTokens}+${outputTokens} tok ≈ $${costUsd.toFixed(4)}`
    );
    return entry;
  }

  /** All recorded entries, in record order (a defensive copy). */
  get entries(): ModelCostEntry[] {
    return [...this._entries];
  }

  /** Total estimated dollar cost across every recorded prompt. */
  totalCostUsd(): number {
    const sum = this._entries.reduce((acc, e) => acc + e.costUsd, 0);
    return Math.round(sum * 1_000_000) / 1_000_000;
  }

  /** Roll the entries up per model and across the whole build. */
  summary(): ModelCostSummary {
    const byModel = new Map<ClaudeModel, ModelCostRollup>();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const e of this._entries) {
      totalInputTokens += e.inputTokens;
      totalOutputTokens += e.outputTokens;
      const roll = byModel.get(e.model) ?? {
        model: e.model,
        prompts: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      roll.prompts += 1;
      roll.inputTokens += e.inputTokens;
      roll.outputTokens += e.outputTokens;
      roll.costUsd = Math.round((roll.costUsd + e.costUsd) * 1_000_000) / 1_000_000;
      byModel.set(e.model, roll);
    }
    return {
      totalPrompts: this._entries.length,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd: this.totalCostUsd(),
      byModel: [...byModel.values()],
    };
  }

  /** Clear all recorded entries (e.g. between builds). */
  reset(): void {
    this._entries.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Intelligent cost optimization: prompt complexity classification
// ---------------------------------------------------------------------------

/** Coarse complexity bucket for a free-form prompt string. */
export type PromptComplexity = 'simple' | 'moderate' | 'complex';

const COMPLEX_KEYWORDS = [
  'architecture', 'multi-file', 'refactor', 'security review', 'governance',
  'schema design', 'restructure', 'audit', 'overhaul', 'migration',
];
const SIMPLE_KEYWORDS = [
  'scaffold', 'boilerplate', 'format', 'lint', 'linting', 'rename',
  'typo', 'whitespace', 'indent', 'formatting', 'fix import',
];

/**
 * Classify a free-form prompt into a complexity bucket.
 * - simple: scaffolding, boilerplate, formatting, linting
 * - moderate: single-feature implementation, bug fixes, test writing
 * - complex: architecture decisions, multi-file refactors, security reviews
 */
export function classifyPromptComplexity(prompt: string): PromptComplexity {
  const lower = prompt.toLowerCase();
  if (COMPLEX_KEYWORDS.some(kw => lower.includes(kw))) return 'complex';
  if (SIMPLE_KEYWORDS.some(kw => lower.includes(kw))) return 'simple';
  return 'moderate';
}

// ---------------------------------------------------------------------------
// Complexity-based model routing
// ---------------------------------------------------------------------------

/** Configuration for {@link routeToModel} — all fields optional. */
export interface ModelRouterConfig {
  /** Force a specific model regardless of complexity. */
  forceModel?: ClaudeModel;
  /** Per-complexity overrides for the default tier mapping. */
  complexityOverrides?: Partial<Record<PromptComplexity, ClaudeModel>>;
}

const COMPLEXITY_MODEL_MAP: Record<PromptComplexity, ClaudeModel> = {
  simple: 'claude-haiku-4-5-20251001',
  moderate: 'claude-sonnet-4-6',
  complex: 'claude-opus-4-6',
};

/**
 * Route a complexity string to a Claude model id.
 * Config overrides (forceModel or complexityOverrides) take precedence.
 */
export function routeToModel(complexity: string, config: ModelRouterConfig = {}): string {
  if (config.forceModel) return config.forceModel;
  const c: PromptComplexity =
    complexity === 'simple' || complexity === 'moderate' || complexity === 'complex'
      ? complexity
      : 'moderate';
  return config.complexityOverrides?.[c] ?? COMPLEXITY_MODEL_MAP[c];
}

// ---------------------------------------------------------------------------
// Prompt-level cost estimation
// ---------------------------------------------------------------------------

/** Cost estimate derived from a prompt string and a model id. */
export interface CostEstimate {
  /** Estimated input tokens (~4 chars per token). */
  inputTokens: number;
  /** Estimated output tokens (3× input for code-generation workloads). */
  outputTokens: number;
  /** Estimated dollar cost (input + output). */
  costUsd: number;
  /** The model id used for pricing. */
  model: string;
}

/**
 * Estimate the cost of running `prompt` on `model`.
 * Input tokens ≈ prompt.length / 4; output ≈ 3× that.
 * Falls back to Sonnet pricing if `model` is not in {@link MODEL_PRICING}.
 */
export function estimateCost(prompt: string, model: string): CostEstimate {
  const inputTokens = Math.max(1, Math.ceil(prompt.length / 4));
  const outputTokens = inputTokens * 3;
  const safeModel: ClaudeModel =
    model in MODEL_PRICING ? (model as ClaudeModel) : 'claude-sonnet-4-6';
  const costUsd = estimateModelCost(safeModel, inputTokens, outputTokens);
  return { inputTokens, outputTokens, costUsd, model };
}

// ---------------------------------------------------------------------------
// Skill hot-loading
// ---------------------------------------------------------------------------

/**
 * Load the contents of SKILL.md files under `skillsDir` that are relevant to `prompt`.
 * Relevance is determined by keyword overlap: words > 3 chars in the prompt that appear
 * in the skill file name or content. Returns an empty array when `skillsDir` is unreadable.
 */
export function loadRelevantSkills(prompt: string, skillsDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }

  const words = new Set(
    prompt
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 3)
  );

  const results: string[] = [];
  for (const entry of entries) {
    if (!entry.toUpperCase().includes('SKILL')) continue;
    const filePath = join(skillsDir, entry);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const contentLower = content.toLowerCase();
    const entryLower = entry.toLowerCase();
    const isRelevant = [...words].some(
      word => entryLower.includes(word) || contentLower.includes(word)
    );
    if (isRelevant) results.push(content);
  }
  return results;
}

export default selectModel;



