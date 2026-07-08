/**
 * FORGE 2.0 — Prompt Rewriter (Phase 3 Build Executor engine, queue.yaml s5-p02).
 *
 * When the failure-predictor (s5-p02 sibling) scores a prompt above
 * {@link REWRITE_THRESHOLD} (0.4), the executor (s5-p05 step c) routes the assembled prompt
 * through this module BEFORE handing it to the claude-runner. Per BEHAVIORAL_CONTRACTS.md
 * Contract 9 (Dynamic Prompt Rewriting) the rewrite is strictly bounded:
 *
 *   - the task OBJECTIVE must remain identical,
 *   - the governance REFERENCES must remain identical,
 *   - only the instruction PHRASING / APPROACH may change,
 *   - the rewrite reason is logged (→ `prompt_executions.rewrite_reason`),
 *   - the original prompt hash is preserved (→ `prompt_executions.original_prompt_hash`).
 *
 * To honor those invariants the rewriter is NON-DESTRUCTIVE: it keeps the original assembled
 * prompt verbatim (its task description, governance excerpts, Build Memory warnings, and the
 * mandatory state-audit footer all stay exactly where they were — so the footer remains at
 * the very end) and PREPENDS a restructured execution preamble:
 *
 *   1. Query Build Memory for the highest-success-rate "prompt structures" for this task
 *      type — the `prompt_rewrite` resolutions linked to the matching error patterns,
 *      scored by their applied success rate.
 *   2. Preserve the task objective + governance references (the untouched original body).
 *   3. Restructure the instruction approach: a per-prompt-type canonical plan (rooted in the
 *      FORGE Six Laws / contracts) augmented with steps from those successful precedents.
 *   4. Inject prevention rules from the matching error patterns.
 *   5. Return the original hash, the rewritten hash, and the rewrite reason (logged here;
 *      persisted by the executor).
 *
 * DETERMINISTIC: given the same prompt + patterns + precedents the output (and therefore the
 * rewritten hash) is identical. The SHA-256 helper is reused from the prompt-assembler so
 * the hashing is byte-for-byte consistent with `prompt_executions.prompt_hash`.
 *
 * NON-FATAL (Contract 4): the precedent/resolution reads degrade to empty on failure, in
 * which case the rewrite still applies the canonical per-type approach (a meaningful
 * restructure with no Build Memory). Both reads are injectable for unit testing.
 * `rewritePrompt` never throws.
 */

import type { PromptType } from './queue-generator.js';
import type { StackFingerprint } from '../tools/stack-detector.js';
import type { ErrorPattern, Json, Resolution } from '../types/index.js';
import { BuildMemory } from '../memory/index.js';
import { hashPrompt } from './prompt-assembler.js';
import { logLine } from '../tools/forge-logger.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Mirror of the failure-predictor threshold — a rewrite is applied above this probability. */
export const REWRITE_THRESHOLD = 0.4;

/** Max prompt_rewrite precedents folded into the restructured approach (highest success first). */
const MAX_PRECEDENTS = 3;
/** Max prevention rules injected from matching patterns. */
const MAX_PREVENTION_RULES = 8;
/** Max matching patterns whose resolutions are fetched (most-frequent first). */
const MAX_PATTERNS_SCANNED = 8;

/** Inputs to {@link rewritePrompt}. */
export interface RewriteInput {
  /** The assembled prompt to rewrite (its task + governance are preserved verbatim). */
  prompt: string;
  /** The kind of prompt — selects the canonical approach and the precedent query. */
  promptType: PromptType;
  /**
   * The error patterns the failure-predictor matched. When omitted the rewriter fetches the
   * patterns for `promptType` itself (step 1). Passing the predictor's result avoids a
   * second query and keeps the two engines consistent.
   */
  matchingPatterns?: ErrorPattern[];
  /** The predicted probability, surfaced in the rewrite reason (optional). */
  probability?: number;
  /** The build's stack fingerprint — context for the reason only (optional). */
  stackFingerprint?: StackFingerprint | null;
}

/** The result of {@link rewritePrompt} (the s5-p02 return contract + diagnostics). */
export interface RewriteResult {
  /** The restructured prompt (approach preamble + the original prompt verbatim). */
  rewrittenPrompt: string;
  /** Human-readable explanation logged to `prompt_executions.rewrite_reason`. */
  reason: string;
  /** SHA-256 of the ORIGINAL prompt (→ `prompt_executions.original_prompt_hash`). */
  originalHash: string;
  /** SHA-256 of the rewritten prompt (→ `prompt_executions.prompt_hash`). */
  rewrittenHash: string;
  /** Number of Build Memory precedents folded into the approach. */
  precedentsApplied: number;
  /** Number of prevention rules injected. */
  preventionRulesInjected: number;
}

/** Options for {@link rewritePrompt}. */
export interface PromptRewriterOptions {
  /**
   * Override the matching-pattern fetch when `input.matchingPatterns` is not supplied
   * (tests). Default: query `error_patterns` by `trigger_prompt_pattern`. Never throws.
   */
  fetchPatterns?: (promptType: PromptType) => Promise<ErrorPattern[]>;
  /**
   * Override the resolution fetch per matching pattern (tests). Default:
   * `BuildMemory.resolutions.getResolutionForPattern`. Never throws (degrade to null).
   */
  fetchResolution?: (errorPatternId: string) => Promise<Resolution | null>;
  /** Progress reporter. Default logs to the console with a `[FORGE:rewriter]` prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Canonical per-type approach (the "successful precedents" baseline)
// ---------------------------------------------------------------------------

/**
 * The proven, deterministic approach for each prompt type, rooted in the FORGE Six Laws and
 * BEHAVIORAL_CONTRACTS. This is the baseline restructure applied even when Build Memory has
 * no recorded precedents; resolution-derived steps are appended to it.
 */
const CANONICAL_APPROACH: Record<PromptType, string[]> = {
  schema: [
    'Create the tables exactly as SCHEMA_REGISTRY.md defines them — names, columns, types, constraints.',
    'Apply RLS policies and enforce company_id (tenant) scoping on every tenant-owned table (Six Laws Law 1).',
    'Write idempotent migrations (create-if-not-exists) and verify each table exists in the real database.',
  ],
  auth: [
    'Derive identity from the session — never trust a client-supplied user/role/company id.',
    'On ANY role-fetch failure, middleware redirects to /login only (Iron Law 4 — full-file replacement, never a patch).',
    'Cover sign-in, sign-out, and role gating; confirm protected routes reject unauthenticated requests.',
  ],
  api: [
    'Authenticate the request first; derive company_id from the session, never from the request body (Six Laws Law 2).',
    'Read and write only real tables with company-scoped queries — zero mocks or placeholder data.',
    'Return explicit success and error responses with correct status codes; handle the empty result case.',
  ],
  ui: [
    'Render real components with real data from the API — no "coming soon"/placeholder text (Six Laws Law 3).',
    'Handle loading and empty states explicitly; serve any dashboard HTML via no-cache API routes (Iron Law 5).',
    'Wire every button/form to a real persisted action and reflect server state after it completes.',
  ],
  feature: [
    'Build the full feature end-to-end: schema, API, UI, data, and wiring (the Six Laws), no layer deferred.',
    'Link navigation and apply correct role gates; ensure every control saves to the database.',
    'Handle empty and error states; verify the real data round-trips through the real tables.',
  ],
  agent: [
    'Define explicit trigger conditions plus input and output contracts before the implementation.',
    'Keep the agent within all governance contracts; it starts status "proposed" and is never auto-deployed (Contract 17).',
    'Validate the agent against historical data and capture the test results.',
  ],
  test: [
    'Use Playwright; exercise real routes and intercept network calls to confirm real API data (no mocks).',
    'Cover the Six Laws end-to-end: schema, API, UI, data, wiring, and navigation/role access.',
    'Assert on observed browser behavior, not implementation details; make the run repeatable.',
  ],
  deploy: [
    'Run the gates strictly in order: tsc --noEmit → build → deploy → tests; abort on the first failure.',
    'Never force-push broken code; verify the deployment is reachable before declaring success.',
    'Confirm environment variables are present in the deploy target (Phase 0 manifest).',
  ],
};

// ---------------------------------------------------------------------------
// Build Memory precedent extraction
// ---------------------------------------------------------------------------

interface Precedent {
  signature: string;
  successScore: number;
  description: string;
  steps: string[];
}

/** Default matching-pattern fetch (used only when the caller did not pass patterns). */
async function defaultFetchPatterns(promptType: PromptType): Promise<ErrorPattern[]> {
  const patterns = await BuildMemory.errors.findPatternsByPromptType(promptType);
  return patterns ?? [];
}

/** Coerce a `resolution_steps` jsonb value into a clean list of step strings. */
function renderSteps(steps: Json): string[] {
  const out: string[] = [];
  const push = (v: Json): void => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (s !== '') out.push(s);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out.push(String(v));
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // A step object, e.g. { action, detail } — render its string fields compactly.
      const parts = Object.values(v)
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map((x) => x.trim());
      if (parts.length > 0) out.push(parts.join(' — '));
      else out.push(JSON.stringify(v));
    }
  };

  if (Array.isArray(steps)) {
    for (const step of steps) push(step);
  } else if (steps !== null && typeof steps === 'object') {
    const nested = (steps as { [k: string]: Json }).steps;
    if (Array.isArray(nested)) for (const step of nested) push(step);
    else push(steps);
  } else {
    push(steps);
  }
  return out;
}

/** A resolution's applied success rate, falling back to the parent pattern's success_rate. */
function successScore(resolution: Resolution, pattern: ErrorPattern): number {
  if (resolution.times_applied > 0) return resolution.times_succeeded / resolution.times_applied;
  return pattern.success_rate ?? 0;
}

/**
 * Gather the highest-success-rate `prompt_rewrite` precedents for the matching patterns
 * (step 1). Each matching pattern's most-recent resolution is fetched; only prompt_rewrite
 * resolutions are kept, scored, and sorted best-first. Guarded — degrades to [] (Contract 4).
 */
async function gatherPrecedents(
  patterns: ErrorPattern[],
  fetchResolution: (id: string) => Promise<Resolution | null>,
  log: (message: string) => void
): Promise<Precedent[]> {
  const scanned = patterns.slice(0, MAX_PATTERNS_SCANNED);
  const precedents: Precedent[] = [];
  for (const pattern of scanned) {
    let resolution: Resolution | null = null;
    try {
      resolution = await fetchResolution(pattern.id);
    } catch (error) {
      log(`WARNING: resolution fetch failed for ${pattern.error_signature} (${describe(error)})`);
      resolution = null;
    }
    if (!resolution || resolution.resolution_type !== 'prompt_rewrite') continue;
    precedents.push({
      signature: pattern.error_signature,
      successScore: successScore(resolution, pattern),
      description: resolution.resolution_description,
      steps: renderSteps(resolution.resolution_steps),
    });
  }
  precedents.sort((a, b) => b.successScore - a.successScore);
  return precedents.slice(0, MAX_PRECEDENTS);
}

// ---------------------------------------------------------------------------
// Preamble rendering
// ---------------------------------------------------------------------------

/** Render the restructured approach + prevention preamble that is prepended to the prompt. */
function renderPreamble(
  promptType: PromptType,
  probability: number | undefined,
  precedents: Precedent[],
  preventionRules: Array<{ signature: string; rule: string; successRate: number }>
): string {
  const pct = probability !== undefined ? `${(probability * 100).toFixed(0)}%` : 'above threshold';
  const banner = [
    `> FORGE PROMPT REWRITE — predicted failure ${pct} (> ${REWRITE_THRESHOLD}, Contract 8).`,
    '> The task objective and governance references below are UNCHANGED and remain authoritative',
    '> on WHAT to build. This preamble restructures only the APPROACH — follow it for HOW.',
  ].join('\n');

  // Restructured approach: canonical baseline + precedent-derived steps.
  const approachSteps: string[] = [...CANONICAL_APPROACH[promptType]];
  for (const p of precedents) {
    if (p.successScore === 0) continue;
    if (p.description.includes('escalated to human') || p.description.includes('Novel error')) continue;
    const pctText = `${(p.successScore * 100).toFixed(0)}%`;
    const head = `From a proven precedent for "${p.signature}" (${pctText} success): ${p.description.trim()}`;
    approachSteps.push(head);
    for (const step of p.steps) approachSteps.push(`  • ${step}`);
  }
  const approach = [
    `## Recommended approach (highest-success-rate precedents for '${promptType}')`,
    approachSteps.map((s, i) => (s.startsWith('  •') ? s : `${i + 1}. ${s}`)).join('\n'),
  ].join('\n\n');

  const sections = [banner, approach];

  if (preventionRules.length > 0) {
    const bullets = preventionRules
      .map((r) => `- [${r.signature}] ${r.rule} (resolution success ${(r.successRate * 100).toFixed(0)}%)`)
      .join('\n');
    sections.push(
      ['## Mandatory prevention rules (from matching error patterns)', bullets].join('\n\n')
    );
  }

  sections.push('---');
  return sections.join('\n\n');
}

/** Collect de-duplicated prevention rules from the matching patterns. */
function collectPreventionRules(
  patterns: ErrorPattern[]
): Array<{ signature: string; rule: string; successRate: number }> {
  const seen = new Set<string>();
  const rules: Array<{ signature: string; rule: string; successRate: number }> = [];
  for (const p of patterns) {
    const rule = p.prevention_rule?.trim();
    if (!rule || rule === '' || seen.has(rule)) continue;
    seen.add(rule);
    rules.push({ signature: p.error_signature, rule, successRate: p.success_rate ?? 0 });
    if (rules.length >= MAX_PREVENTION_RULES) break;
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Rewrite an assembled prompt that the failure-predictor flagged as high-risk (queue.yaml
 * s5-p02). Prepends a restructured execution approach — the canonical plan for `promptType`
 * augmented with the highest-success-rate Build Memory precedents — plus the prevention
 * rules from the matching patterns, leaving the original prompt (task objective, governance
 * references, mandatory footer) verbatim beneath it (Contract 9).
 *
 * Never rejects: the precedent/resolution reads degrade to empty on failure (Contract 4),
 * in which case the canonical per-type approach is still applied.
 */
export async function rewritePrompt(
  input: RewriteInput,
  options: PromptRewriterOptions = {}
): Promise<RewriteResult> {
  const log = options.log ?? logLine('rewriter');
  const fetchPatterns = options.fetchPatterns ?? defaultFetchPatterns;
  const fetchResolution = options.fetchResolution ?? BuildMemory.resolutions.getResolutionForPattern;

  const originalHash = hashPrompt(input.prompt);

  // Step 1: matching patterns (caller-supplied, else fetched by type). Guarded.
  let patterns: ErrorPattern[] = input.matchingPatterns ?? [];
  if (input.matchingPatterns === undefined) {
    try {
      patterns = await fetchPatterns(input.promptType);
    } catch (error) {
      log(`WARNING: pattern fetch failed (${describe(error)}) — proceeding with canonical approach only`);
      patterns = [];
    }
  }
  // Most-frequent first, so the highest-signal patterns drive precedents + prevention.
  const ordered = [...patterns].sort((a, b) => b.occurrence_count - a.occurrence_count);

  // Step 1 (cont.): highest-success-rate prompt-rewrite precedents for this task type.
  const precedents = await gatherPrecedents(ordered, fetchResolution, log);

  // Step 4: prevention rules from the matching patterns.
  const preventionRules = collectPreventionRules(ordered);

  // Steps 2 + 3: preserve the original (task objective + governance) verbatim, prepend the
  // restructured approach preamble.
  const preamble = renderPreamble(input.promptType, input.probability, precedents, preventionRules);
  const rewrittenPrompt = `${preamble}\n\n${input.prompt}`;
  const rewrittenHash = hashPrompt(rewrittenPrompt);

  // Step 5: reason + hash logging (persisted to prompt_executions by the executor).
  const pct = input.probability !== undefined ? `${(input.probability * 100).toFixed(0)}%` : '>40%';
  const reason =
    `Predicted failure ${pct} > ${REWRITE_THRESHOLD} (Contract 8). Restructured prompt type ` +
    `'${input.promptType}' using ${precedents.length} precedent(s) and injected ` +
    `${preventionRules.length} prevention rule(s); task objective + governance references preserved.`;

  log(`rewrote '${input.promptType}': ${originalHash.slice(0, 12)}… → ${rewrittenHash.slice(0, 12)}… (${reason})`);

  return {
    rewrittenPrompt,
    reason,
    originalHash,
    rewrittenHash,
    precedentsApplied: precedents.length,
    preventionRulesInjected: preventionRules.length,
  };
}

/** Render an unknown thrown value as a short string for logging. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default rewritePrompt;
