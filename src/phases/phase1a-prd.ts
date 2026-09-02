/**
 * FORGE 2.0 — Phase 1A: PRD Generator.
 *
 * Phase 1A is the first design phase. It takes a raw product idea (free text) and
 * produces a comprehensive Product Requirements Document, then HALTS for Gate 1
 * human approval (BEHAVIORAL_CONTRACTS Contract 2). The PRD it emits is the input
 * to Phase 1B (the Architecture Engine, s3-p05).
 *
 * Sequence (per queue.yaml s3-p04):
 *   1. Parse the idea for core concept, target users, key features, business model
 *      (done BY the model, guided by a structured system prompt).
 *   2. Query Build Memory for SIMILAR PRIOR PROJECTS by stack-fingerprint similarity
 *      — plus applicable cross-project insights and proven design patterns — and
 *      inject them as grounding context so the PRD reuses what already worked.
 *   3. Decompose every feature into granular capabilities (user action → system
 *      action → data change → feedback), at interaction-level detail (Contract 18).
 *   4. Generate edge cases for every feature.
 *   5. Assemble the structured PRD: executive summary, user personas, feature specs
 *      (interaction-level), data-model overview, integration requirements, success
 *      metrics, scope boundaries.
 *
 * Build Memory is used to FILL GAPS WITH PROVEN DEFAULTS: where the idea is silent
 * (stack, auth model, tenancy, success metrics) the prompt is seeded with the
 * defaults that recurring insights/patterns recommend, and the model is told to
 * apply them and flag the assumption rather than leave a TBD (Contract 18).
 *
 * MODEL: the Anthropic Messages API. The queue (s3-p04) names the model
 * `claude-sonnet-4-6-20250514`; the canonical current id for that model is
 * `claude-sonnet-4-6`, which is the {@link DEFAULT_MODEL} used here. It is
 * overridable via `options.model` or the `FORGE_PRD_MODEL` env var. We call the
 * REST endpoint directly with the global `fetch` (Node 20+) so FORGE takes on no
 * new package dependency; the call is fully injectable via `options.callModel`
 * for testing and for swapping in the official SDK later.
 *
 * NON-FATAL house style (matching the sibling phase orchestrators): every Build
 * Memory read is guarded (Contract 4 — degrade to stateless) and the model call is
 * wrapped so a failure never throws. If the model is unreachable, Phase 1A still
 * resolves with a deterministic fallback PRD assembled from the parsed idea +
 * Build Memory defaults, `usedFallback: true`, and a warning — so a PRD.md always
 * exists for the operator to review. `runPhase1aPrd` never rejects.
 *
 * SECURITY: the Anthropic API key is read from `options.apiKey` / `ANTHROPIC_API_KEY`
 * and sent only in the request header; it is never logged or returned. No secrets
 * from the target project are read here.
 */

import { writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

import type { StackFingerprint } from '../tools/stack-detector.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import { providerCallModel } from '../engine/provider-router.js';
import { z, validateApiResponse } from '../tools/schema-validator.js';
import { logLine } from '../tools/forge-logger.js';
import { runAdversarialReview, type AdversaryResult } from '../analysis/adversarial-review.js';
import type {
  BuildRun,
  CrossProjectInsight,
  DesignPattern,
  JsonObject,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Coarse build-size estimates derived from the generated PRD. */
export interface PrdMetadata {
  /** Number of top-level features specified in the PRD. */
  featureCount: number;
  /** Estimated number of database tables the build will need. */
  tableEstimate: number;
  /** Estimated number of autonomous agents the build will need. */
  agentEstimate: number;
}

/** A prior build surfaced as "similar" by stack-fingerprint similarity. */
export interface SimilarProject {
  buildRunId: string;
  projectName: string;
  /** Similarity score in [0, 1] against the target stack fingerprint. */
  similarity: number;
  status: BuildRun['status'];
  /** The prior build's normalized stack fingerprint. */
  fingerprint: StackFingerprint;
}

/** Gate 1 marker — Phase 1A always halts here for human approval (Contract 2). */
export interface GateStatus {
  name: 'Gate 1 — PRD Approval';
  /** Always `awaiting_human_approval`: there is no bypass (Contract 2). */
  status: 'awaiting_human_approval';
  detail: string;
}

// ---------------------------------------------------------------------------
// 4-pass PRD refinement result types
// ---------------------------------------------------------------------------

/** Pass 1 — completeness: every feature has the 4-part interaction decomposition. */
export interface Pass1Result {
  /** Feature names (from `### <name>` in Feature Specifications) that lack acceptance criteria. */
  featuresWithoutCriteria: string[];
  /** True when every feature specifies user action / system action / data change / feedback. */
  pass: boolean;
}

/** Pass 2 — adversarial PRD review via {@link runAdversarialReview} with phase ARCHITECT_PRD. */
export interface Pass2Result {
  adversarialReview: AdversaryResult;
  /** True when the adversarial review found no BLOCKER findings. */
  pass: boolean;
}

/** Pass 3 — schema completeness: every Data Model entity has columns, indexes, and RLS. */
export interface Pass3Result {
  entitiesMissingColumns: string[];
  entitiesMissingIndexes: string[];
  entitiesMissingRls: string[];
  /** True when every entity in the Data Model section specifies columns, indexes, and RLS. */
  pass: boolean;
}

/** Pass 4 — governance alignment against the key contracts in BEHAVIORAL_CONTRACTS.md. */
export interface Pass4Result {
  violations: Array<{ rule: string; detail: string }>;
  /** True when no governance contract violations are detected in the PRD. */
  pass: boolean;
}

/** Combined results of all four PRD refinement passes. */
export interface PrdPassResults {
  pass1: Pass1Result;
  pass2: Pass2Result;
  pass3: Pass3Result;
  pass4: Pass4Result;
  /** True when every individual pass resolves with `pass: true`. */
  allPassesClear: boolean;
}

/** The complete result of {@link runPhase1aPrd}. */
export interface Phase1aResult {
  /** The generated PRD as Markdown (the `prd` half of the s3-p04 contract). */
  prd: string;
  /** Build-size estimates (the `metadata` half of the s3-p04 contract). */
  metadata: PrdMetadata;
  /** Absolute path PRD.md was written to, or `null` if the write was skipped/failed. */
  prdPath: string | null;
  /** The target stack fingerprint used for similarity (provided or idea-derived). */
  stackFingerprint: StackFingerprint;
  /** Prior builds used as grounding context (highest similarity first). */
  similarProjects: SimilarProject[];
  /** Model id actually used. */
  model: string;
  /** Input/output token usage reported by the API (0 when using the fallback). */
  tokensInput: number;
  tokensOutput: number;
  /** True when the model call failed and a deterministic fallback PRD was used. */
  usedFallback: boolean;
  /** Non-fatal observations (memory unreachable, parse fallback, write failure, …). */
  warnings: string[];
  /** Gate 1 — the build halts here until a human approves the PRD. */
  gate: GateStatus;
  /** Results of all four PRD refinement passes. */
  passes: PrdPassResults;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Model client (Anthropic Messages API) — injectable
// ---------------------------------------------------------------------------

/** A minimal request to the Anthropic Messages API. */
export interface ModelRequest {
  model: string;
  maxTokens: number;
  system: string;
  /** The single user message (the idea + Build Memory context). */
  user: string;
  apiKey: string;
}

/** A minimal response from the Anthropic Messages API. */
export interface ModelResponse {
  /** Concatenated text content of the assistant message. */
  text: string;
  tokensInput: number;
  tokensOutput: number;
}

/** Pluggable model caller — defaults to {@link defaultCallModel}; override in tests. */
export type CallModel = (request: ModelRequest) => Promise<ModelResponse>;

/** Options for {@link runPhase1aPrd}. */
export interface Phase1aOptions {
  /**
   * The target project's stack fingerprint (typically from the Phase 0 scout). Used
   * for similarity ranking and injected into the prompt. When omitted, a soft
   * fingerprint is derived from the idea text over the FORGE default stack.
   */
  stackFingerprint?: StackFingerprint;
  /** Project name for context/labels. Default: the basename of `projectPath`. */
  projectName?: string;
  /** Model id. Default: `FORGE_PRD_MODEL` env, else {@link DEFAULT_MODEL}. */
  model?: string;
  /** Anthropic API key. Default: `ANTHROPIC_API_KEY` env. */
  apiKey?: string;
  /** max_tokens for the generation. Default {@link DEFAULT_MAX_TOKENS}. */
  maxTokens?: number;
  /** Injected model caller (for tests / SDK swap). Default {@link defaultCallModel}. */
  callModel?: CallModel;
  /** Write PRD.md to the target project. Default true. */
  writePrdFile?: boolean;
  /** PRD file name. Default 'PRD.md'. */
  prdFileName?: string;
  /** Max similar prior projects to surface as context. Default 5. */
  maxSimilarProjects?: number;
  /** Minimum similarity in [0,1] for a prior build to count as "similar". Default 0.35. */
  minSimilarity?: number;
  /** Progress reporter. Default logs to the console with a [FORGE:phase1a] prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Canonical model id for the generator. queue.yaml s3-p04 names it
 * `claude-sonnet-4-6-20250514`; `claude-sonnet-4-6` is the current canonical alias
 * for that model. Overridable via `options.model` / `FORGE_PRD_MODEL`.
 */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Default generation budget — a full PRD with interaction-level detail is long. */
export const DEFAULT_MAX_TOKENS = 8192;

/** Anthropic Messages API endpoint + version (the only network call this phase makes). */
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/** Network timeout for the generation call (10 minutes — long PRDs stream slowly). */
const MODEL_TIMEOUT_MS = 600_000;

/**
 * FORGE's default application stack (BLUEPRINT TECH STACK). Used as the baseline
 * target fingerprint when the caller supplies none, and to fill the stack gap with
 * a proven default when the idea is silent about technology.
 */
const FORGE_DEFAULT_STACK: StackFingerprint = {
  framework: 'nextjs',
  language: 'typescript',
  database: 'supabase',
  deployment: 'vercel',
  packageManager: 'pnpm',
  services: ['supabase'],
  cliTools: ['git', 'node', 'pnpm', 'supabase', 'vercel'],
};

/** Idea-keyword → service slug signals (used to enrich a derived fingerprint). */
const IDEA_SERVICE_SIGNALS: ReadonlyArray<[RegExp, string]> = [
  [/\bstripe|payment|checkout|subscription|billing\b/i, 'stripe'],
  [/\btwilio|sms|text message|phone call|telephony\b/i, 'twilio'],
  [/\bresend|sendgrid|email|transactional mail\b/i, 'resend'],
  [/\bmapbox|map|geospatial|location|directions\b/i, 'mapbox'],
  [/\banthropic|claude|\bai\b|llm|chatbot|assistant\b/i, 'anthropic'],
  [/\bopenai|gpt\b/i, 'openai'],
  [/\bsentry|error tracking\b/i, 'sentry'],
];

// ---------------------------------------------------------------------------
// Default model caller (global fetch — no SDK dependency)
// ---------------------------------------------------------------------------

/** Shape of the Anthropic Messages API success body we read. */
interface AnthropicBody {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Default {@link CallModel}: POSTs to the Anthropic Messages API with the global
 * `fetch`. Throws on a missing key / non-2xx / malformed body — the caller wraps
 * this so the phase never crashes (it falls back to a template PRD instead).
 */
export async function defaultCallModel(request: ModelRequest): Promise<ModelResponse> {
  if (!request.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set (pass options.apiKey or set the env var)');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': request.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw new Error(`Anthropic API ${response.status} ${response.statusText}: ${detail}`);
    }

    const body = (await response.json()) as AnthropicBody;
    const text = (body.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('');
    if (text.trim() === '') throw new Error('Anthropic API returned no text content');

    return {
      text,
      tokensInput: body.usage?.input_tokens ?? 0,
      tokensOutput: body.usage?.output_tokens ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Stack-fingerprint similarity (Build Memory similar-project search)
// ---------------------------------------------------------------------------

/** Coerce a `jsonb` value to a sorted, de-duplicated, lower-cased string array. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const v of value) if (typeof v === 'string' && v !== '') out.add(v.toLowerCase());
  return [...out].sort();
}

/** Coerce a `jsonb` scalar to a lower-cased string, or `null`. */
function toScalar(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value.toLowerCase() : null;
}

/** Normalize a stored `build_runs.stack_fingerprint` (jsonb) into a {@link StackFingerprint}. */
function fingerprintFromJson(obj: JsonObject): StackFingerprint {
  return {
    framework: toScalar(obj['framework']),
    language: toScalar(obj['language']),
    database: toScalar(obj['database']),
    deployment: toScalar(obj['deployment']),
    packageManager: toScalar(obj['packageManager']),
    services: toStringArray(obj['services']),
    cliTools: toStringArray(obj['cliTools']),
  };
}

/** Jaccard similarity of two string sets (1 when both empty). */
function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setB = new Set(b);
  let intersection = 0;
  for (const x of new Set(a)) if (setB.has(x)) intersection++;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Weighted similarity in [0, 1] between two stack fingerprints. Scalar fields score
 * their full weight on an exact match (and a small partial credit when one side is
 * unknown — an unknown field shouldn't tank similarity); the service/CLI sets score
 * by Jaccard overlap. Weights sum to 1.
 */
function fingerprintSimilarity(a: StackFingerprint, b: StackFingerprint): number {
  const scalarWeights: ReadonlyArray<[keyof StackFingerprint, number]> = [
    ['framework', 0.3],
    ['database', 0.25],
    ['language', 0.1],
    ['deployment', 0.08],
    ['packageManager', 0.05],
  ];

  let score = 0;
  for (const [field, weight] of scalarWeights) {
    const av = a[field] as string | null;
    const bv = b[field] as string | null;
    if (av !== null && bv !== null) score += av === bv ? weight : 0;
    else if (av === null && bv === null) score += weight; // both silent → agree
    else score += weight * 0.25; // one side unknown → partial credit
  }

  score += 0.15 * jaccard(a.services, b.services);
  score += 0.07 * jaccard(a.cliTools, b.cliTools);
  return Math.min(1, Math.round(score * 1000) / 1000);
}

/**
 * Derive a soft target fingerprint from the idea text when the caller supplies
 * none: the FORGE default stack, enriched with any service the idea clearly implies.
 */
function deriveFingerprintFromIdea(idea: string): StackFingerprint {
  const services = new Set(FORGE_DEFAULT_STACK.services);
  const cliTools = new Set(FORGE_DEFAULT_STACK.cliTools);
  for (const [pattern, service] of IDEA_SERVICE_SIGNALS) {
    if (pattern.test(idea)) {
      services.add(service);
      if (service === 'anthropic') cliTools.add('claude');
    }
  }
  return {
    ...FORGE_DEFAULT_STACK,
    services: [...services].sort(),
    cliTools: [...cliTools].sort(),
  };
}

/**
 * Query Build Memory for prior builds and rank them by stack-fingerprint similarity
 * to `target`. Degrades to an empty list when Build Memory is unreachable (Contract 4).
 */
async function findSimilarProjects(
  target: StackFingerprint,
  maxResults: number,
  minSimilarity: number
): Promise<SimilarProject[]> {
  const builds = await BuildMemory.builds.listBuilds(200);
  if (!builds || builds.length === 0) return [];

  return builds
    .map((b) => {
      const fingerprint = fingerprintFromJson(b.stack_fingerprint);
      return {
        buildRunId: b.id,
        projectName: b.project_name,
        similarity: fingerprintSimilarity(target, fingerprint),
        status: b.status,
        fingerprint,
      } satisfies SimilarProject;
    })
    .filter((p) => p.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Build Memory grounding context (proven defaults to fill gaps)
// ---------------------------------------------------------------------------

/** The grounding context assembled from Build Memory and injected into the prompt. */
interface MemoryContext {
  similarProjects: SimilarProject[];
  insights: CrossProjectInsight[];
  patterns: DesignPattern[];
}

/** Gather similar projects + applicable insights + proven design patterns. */
async function gatherMemoryContext(
  target: StackFingerprint,
  maxSimilar: number,
  minSimilarity: number
): Promise<MemoryContext> {
  const fingerprintJson: JsonObject = {
    framework: target.framework,
    language: target.language,
    database: target.database,
    deployment: target.deployment,
    packageManager: target.packageManager,
    services: target.services,
    cliTools: target.cliTools,
  };

  const [similarProjects, insights, patterns] = await Promise.all([
    findSimilarProjects(target, maxSimilar, minSimilarity),
    BuildMemory.insights.findApplicableInsights(fingerprintJson),
    BuildMemory.patterns.findPatterns(),
  ]);

  return {
    similarProjects,
    insights: (insights ?? []).slice(0, 10),
    patterns: (patterns ?? []).slice(0, 10),
  };
}

/** Render the Build Memory context as a compact Markdown block for the prompt. */
function renderMemoryContext(ctx: MemoryContext, target: StackFingerprint): string {
  const lines: string[] = [];

  lines.push('## Build Memory Context (proven precedents — prefer these defaults)');
  lines.push('');
  lines.push('### Target stack (apply when the idea is silent about technology)');
  lines.push(
    `- framework=${target.framework ?? '—'} · language=${target.language ?? '—'} · ` +
      `database=${target.database ?? '—'} · deployment=${target.deployment ?? '—'} · ` +
      `packageManager=${target.packageManager ?? '—'}`
  );
  lines.push(`- services: ${target.services.length ? target.services.join(', ') : '—'}`);
  lines.push('');

  lines.push('### Similar prior builds');
  if (ctx.similarProjects.length === 0) {
    lines.push('- _(none on record — this is a novel stack/idea)_');
  } else {
    for (const p of ctx.similarProjects) {
      lines.push(
        `- ${p.projectName} (similarity ${(p.similarity * 100).toFixed(0)}%, ${p.status}) — ` +
          `framework=${p.fingerprint.framework ?? '—'}, db=${p.fingerprint.database ?? '—'}, ` +
          `services=[${p.fingerprint.services.join(', ') || '—'}]`
      );
    }
  }
  lines.push('');

  lines.push('### Applicable cross-project insights');
  if (ctx.insights.length === 0) {
    lines.push('- _(none)_');
  } else {
    for (const i of ctx.insights) {
      lines.push(`- [${i.insight_type}] ${i.description}`);
    }
  }
  lines.push('');

  lines.push('### Proven design patterns');
  if (ctx.patterns.length === 0) {
    lines.push('- _(none)_');
  } else {
    for (const p of ctx.patterns) {
      lines.push(`- [${p.pattern_type}] ${p.name} — ${p.description}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/** The structured system prompt that drives PRD generation (steps 1–5 of s3-p04). */
function buildSystemPrompt(projectName: string): string {
  return [
    'You are FORGE Phase 1A, the PRD Generator inside an autonomous software factory.',
    `You transform a raw product idea into a comprehensive Product Requirements Document for the project "${projectName}".`,
    '',
    'Work through these steps internally, then emit the final PRD:',
    '1. PARSE the idea for: core concept, target users, key features, and business model.',
    '2. GROUND your design in the supplied Build Memory context (similar prior builds,',
    '   cross-project insights, proven design patterns). Reuse what already worked.',
    '3. DECOMPOSE every feature into granular capabilities. For each capability specify, at',
    '   interaction level: the USER ACTION, the SYSTEM ACTION (frontend + backend), the DATA',
    '   CHANGE (which table/columns are written or read), and the FEEDBACK the user receives',
    '   (success and error states). No element may be left as "TBD"/"TODO".',
    '4. GENERATE realistic EDGE CASES for every feature (empty states, permission denials,',
    '   concurrency, invalid input, network failure, rate limits).',
    '5. ASSEMBLE the PRD with EXACTLY these sections, in order:',
    '   - # Executive Summary',
    '   - ## User Personas',
    '   - ## Feature Specifications  (one ### per feature, each with the interaction-level',
    '     decomposition from step 3 and the edge cases from step 4)',
    '   - ## Data Model Overview      (the tables the build will need, with their purpose and',
    '     key columns, including company_id/tenant scoping where multi-tenant)',
    '   - ## Integration Requirements (third-party services: auth, payments, email, AI, etc.)',
    '   - ## Success Metrics',
    '   - ## Scope Boundaries         (explicitly in-scope vs out-of-scope; non-goals)',
    '',
    'Rules:',
    '- Where the idea is silent (stack, auth model, tenancy, metrics), APPLY the proven default',
    '  from the Build Memory context and FLAG the assumption inline as "(assumption: …)".',
    '- Be specific and buildable. Prefer the FORGE default stack (Next.js + Supabase +',
    '  Vercel, pnpm, TypeScript strict) unless the idea or context demands otherwise.',
    '- Enforce company-scoped data isolation for any multi-tenant feature.',
    '',
    'OUTPUT FORMAT — respond with a SINGLE JSON object and nothing else (no prose, no code',
    'fences). The schema is:',
    '{',
    '  "prd": "<the full PRD as a Markdown string>",',
    '  "featureCount": <integer: number of top-level features in the PRD>,',
    '  "tableEstimate": <integer: number of database tables the build will need>,',
    '  "agentEstimate": <integer: number of autonomous agents the build will need>',
    '}',
    'The "prd" value must be the complete Markdown document. Counts must reflect that document.',
  ].join('\n');
}

/** The user message: the raw idea plus the Build Memory grounding context. */
function buildUserPrompt(idea: string, memoryBlock: string): string {
  return [
    '# Raw product idea',
    '',
    idea.trim(),
    '',
    memoryBlock,
    'Now produce the JSON object described in your instructions.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Model-output parsing
// ---------------------------------------------------------------------------

/** Parsed model output: the PRD markdown plus the three estimates (when present). */
interface ParsedGeneration {
  prd: string;
  featureCount: number | null;
  tableEstimate: number | null;
  agentEstimate: number | null;
}

/** Extract the outermost `{ … }` JSON object from a model response, if any. */
function extractJsonObject(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const haystack = fenced && fenced[1] !== undefined ? fenced[1] : text;
  const start = haystack.indexOf('{');
  const end = haystack.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return haystack.slice(start, end + 1);
}

/** Coerce a parsed JSON value to a non-negative integer, or `null`. */
function toCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/**
 * Zod contract for the model's structured JSON response. Lenient (the counts may
 * arrive as a number or a numeric string, and may be absent — the caller coerces
 * via {@link toCount}); only `prd` is required. Used to VALIDATE the external API
 * response before FORGE processes it (Iron Law 8) — a mismatch is logged to Build
 * Memory's `forge-validation` channel, never thrown.
 */
const PrdGenerationResponseSchema = z.object({
  prd: z.string(),
  featureCount: z.union([z.number(), z.string()]).optional(),
  tableEstimate: z.union([z.number(), z.string()]).optional(),
  agentEstimate: z.union([z.number(), z.string()]).optional(),
});

/** Minimum length for a raw-text PRD fallback to be considered plausible content, not a stub. */
const MIN_PLAUSIBLE_PRD_LENGTH = 200;

/**
 * Structural sanity check for the raw-text PRD fallback (non-JSON model output): plausible PRD
 * markdown has real length and at least one `## ` section heading. Mirrors the already-correct
 * guarded pattern in `phase1b-architect.ts`'s `generateArtifact` (extractJson → null → an
 * explicit fallback skeleton, never raw prose treated as ground truth) — a bare confirmation
 * sentence like "I've written the PRD for you" would otherwise be accepted verbatim and written
 * to PRD.md, the root artifact the rest of the build treats as authoritative.
 */
function isPlausiblePrdText(text: string): boolean {
  return text.length >= MIN_PLAUSIBLE_PRD_LENGTH && /^##\s+/m.test(text);
}

/**
 * Parse a model response into a {@link ParsedGeneration}. Tries the structured JSON
 * contract first; if that fails, treats the whole response as the PRD markdown and
 * leaves the counts `null` (the caller fills them heuristically) — but only when that raw text
 * passes a structural plausibility check; otherwise throws so the caller's existing fallback-PRD
 * path (`buildFallbackPrd`) runs instead of writing unvalidated raw text as PRD.md.
 */
function parseGeneration(text: string): ParsedGeneration {
  const json = extractJsonObject(text);
  if (json !== null) {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      // Validate the external API response before acting on it (non-blocking —
      // logs shape drift to Build Memory; the tolerant coercion below still runs).
      validateApiResponse(PrdGenerationResponseSchema, parsed, {
        context: 'phase1a:prd-generation',
        target: 'anthropic-messages',
      });
      const prd = typeof parsed['prd'] === 'string' ? (parsed['prd'] as string) : '';
      if (prd.trim() !== '') {
        return {
          prd,
          featureCount: toCount(parsed['featureCount']),
          tableEstimate: toCount(parsed['tableEstimate']),
          agentEstimate: toCount(parsed['agentEstimate']),
        };
      }
    } catch {
      // fall through to treating the raw text as the PRD
    }
  }
  const raw = text.trim();
  if (!isPlausiblePrdText(raw)) {
    throw new Error(
      'Model output was neither the structured JSON contract nor a plausible PRD body ' +
        `(non-JSON, ${raw.length} chars, no "## " section heading found) — refusing to write it ` +
        'as PRD.md verbatim.'
    );
  }
  return { prd: raw, featureCount: null, tableEstimate: null, agentEstimate: null };
}

/** Count `## Feature Specifications` → `### …` subheadings as a feature-count heuristic. */
function countFeaturesHeuristic(prd: string): number {
  const lines = prd.split(/\r?\n/);
  let inFeatures = false;
  let count = 0;
  for (const line of lines) {
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      inFeatures = /feature/i.test(h2[1] ?? '');
      continue;
    }
    if (inFeatures && /^###\s+\S/.test(line)) count++;
  }
  // Fallback: any ### heading anywhere, if the section wasn't detected.
  if (count === 0) count = (prd.match(/^###\s+\S/gm) ?? []).length;
  return count;
}

/** Estimate table count from the Data Model section (table-looking bullet/heading lines). */
function countTablesHeuristic(prd: string): number {
  const lines = prd.split(/\r?\n/);
  let inData = false;
  const tables = new Set<string>();
  for (const line of lines) {
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      inData = /data model|schema|database/i.test(h2[1] ?? '');
      continue;
    }
    if (!inData) continue;
    // `- table_name —` / `### table_name` / `| table_name |` style references.
    const m =
      /^\s*[-*]\s*`?([a-z][a-z0-9_]{2,})`?/i.exec(line) ??
      /^###\s+`?([a-z][a-z0-9_]{2,})`?/i.exec(line);
    if (m && m[1]) tables.add(m[1].toLowerCase());
  }
  return tables.size;
}

/** Estimate agent count from any "Agents" section / mentions of an agent. */
function countAgentsHeuristic(prd: string): number {
  const matches = prd.match(/^\s*[-*#].*\bagent\b/gim) ?? [];
  // De-noise: cap the heuristic, since prose can mention "agent" loosely.
  return Math.min(matches.length, 12);
}

// ---------------------------------------------------------------------------
// Fallback PRD (deterministic — used only when the model is unreachable)
// ---------------------------------------------------------------------------

/** Naive feature extraction from the idea for the fallback PRD. */
function extractFeaturesFromIdea(idea: string): string[] {
  const chunks = idea
    .split(/[.;\n]|,?\s+and\s+|\s*,\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && /[a-z]/i.test(s));
  // De-duplicate while preserving order; cap to a sensible number.
  const seen = new Set<string>();
  const features: string[] = [];
  for (const c of chunks) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    features.push(c.charAt(0).toUpperCase() + c.slice(1));
    if (features.length >= 8) break;
  }
  return features.length > 0 ? features : ['Core capability (from idea)'];
}

/**
 * Derive the same {@link PrdMetadata} `buildFallbackPrd` computes, with zero model call — for
 * callers that only need the feature/table/agent scope (e.g. `forge estimate`), not a real
 * PRD.md. Extracted so a pure heuristic estimate no longer requires going through
 * `runPhase1aPrd`'s real `callModel` (Finding K-1 — `forge estimate` documented itself as
 * "without building" but unconditionally performed a real, billed LLM generation pass).
 */
export function deriveHeuristicPrdMetadata(idea: string, target: StackFingerprint): PrdMetadata {
  const features = extractFeaturesFromIdea(idea);
  return {
    featureCount: features.length,
    tableEstimate: Math.max(features.length, 3),
    agentEstimate: target.services.includes('anthropic') ? 1 : 0,
  };
}

/**
 * Build a deterministic, clearly-marked fallback PRD when the model call fails, so a
 * reviewable PRD.md always exists. This is intentionally a SKELETON for human
 * completion — not a substitute for the model-generated document.
 */
function buildFallbackPrd(
  projectName: string,
  idea: string,
  target: StackFingerprint,
  ctx: MemoryContext,
  failureReason: string
): { prd: string; metadata: PrdMetadata } {
  const features = extractFeaturesFromIdea(idea);
  const lines: string[] = [];

  lines.push(`# ${projectName} — PRODUCT REQUIREMENTS DOCUMENT (FALLBACK SKELETON)`);
  lines.push('');
  lines.push(
    '> ⚠️ This PRD was generated by FORGE Phase 1A in FALLBACK mode because the model call ' +
      `failed (${failureReason}). It is a deterministic skeleton from the raw idea + Build ` +
      'Memory defaults. A human must complete/replace it before Gate 1 approval, or re-run ' +
      'Phase 1A once the Anthropic API is reachable.'
  );
  lines.push('');

  lines.push('# Executive Summary');
  lines.push('');
  lines.push(idea.trim() || '_(no idea text supplied)_');
  lines.push('');

  lines.push('## User Personas');
  lines.push('');
  lines.push('- **Primary user** — (assumption: derived default; refine before approval).');
  lines.push('- **Administrator** — manages configuration and oversees other users.');
  lines.push('');

  lines.push('## Feature Specifications');
  lines.push('');
  for (const feature of features) {
    lines.push(`### ${feature}`);
    lines.push('- **User action:** (to be specified)');
    lines.push('- **System action:** (to be specified — frontend + backend)');
    lines.push('- **Data change:** (to be specified — table/columns)');
    lines.push('- **Feedback:** (success + error states to be specified)');
    lines.push('- **Edge cases:** empty state, permission denied, invalid input, network failure.');
    lines.push('');
  }

  lines.push('## Data Model Overview');
  lines.push('');
  lines.push(
    `- Default datastore: **${target.database ?? 'supabase'}** with company-scoped isolation ` +
      'on every tenant table (assumption: multi-tenant SaaS default).'
  );
  lines.push('- Tables to be derived in Phase 1B from the features above.');
  lines.push('');

  lines.push('## Integration Requirements');
  lines.push('');
  if (target.services.length > 0) {
    for (const s of target.services) lines.push(`- ${s}`);
  } else {
    lines.push('- _(none detected from the idea)_');
  }
  lines.push('');

  lines.push('## Success Metrics');
  lines.push('');
  lines.push('- (assumption: define activation, retention, and task-completion metrics before approval).');
  lines.push('');

  lines.push('## Scope Boundaries');
  lines.push('');
  lines.push('- **In scope:** the features listed above.');
  lines.push('- **Out of scope:** anything not explicitly listed (to be confirmed at Gate 1).');
  lines.push('');

  if (ctx.similarProjects.length > 0 || ctx.insights.length > 0) {
    lines.push('## Build Memory Precedents Considered');
    lines.push('');
    for (const p of ctx.similarProjects) {
      lines.push(`- Similar build: ${p.projectName} (${(p.similarity * 100).toFixed(0)}% similar).`);
    }
    for (const i of ctx.insights) lines.push(`- Insight: ${i.description}`);
    lines.push('');
  }

  const prd = lines.join('\n');
  return {
    prd,
    metadata: {
      featureCount: features.length,
      tableEstimate: Math.max(features.length, 3),
      agentEstimate: target.services.includes('anthropic') ? 1 : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Pass 1 — PRD completeness (interaction-level acceptance criteria)
// ---------------------------------------------------------------------------

/**
 * Scan the PRD for ### feature headings inside the Feature Specifications section
 * and verify each one contains at least one interaction-level acceptance criterion
 * marker (user action, system action, data change, or feedback).
 */
function runPass1(prd: string): Pass1Result {
  const lines = prd.split(/\r?\n/);
  let inFeatureSpec = false;
  let currentFeature: string | null = null;
  let currentFeatureHasCriteria = false;
  const featuresWithoutCriteria: string[] = [];

  const flushFeature = (): void => {
    if (currentFeature !== null && !currentFeatureHasCriteria) {
      featuresWithoutCriteria.push(currentFeature);
    }
  };

  for (const line of lines) {
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2 !== null) {
      flushFeature();
      currentFeature = null;
      currentFeatureHasCriteria = false;
      inFeatureSpec = /feature/i.test(h2[1] ?? '');
      continue;
    }
    if (!inFeatureSpec) continue;

    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3 !== null) {
      flushFeature();
      currentFeature = (h3[1] ?? '').trim();
      currentFeatureHasCriteria = false;
      continue;
    }

    if (currentFeature !== null) {
      if (
        /acceptance.criteria/i.test(line) ||
        /\*\*(?:ac|acceptance)\*\*/i.test(line) ||
        /- \[ \]/.test(line) ||
        /\*\*user action\*\*/i.test(line) ||
        /\*\*system action\*\*/i.test(line) ||
        /\*\*data change\*\*/i.test(line) ||
        /\*\*feedback\*\*/i.test(line) ||
        /user action:/i.test(line) ||
        /system action:/i.test(line) ||
        /data change:/i.test(line) ||
        /feedback:/i.test(line)
      ) {
        currentFeatureHasCriteria = true;
      }
    }
  }
  flushFeature();

  return { featuresWithoutCriteria, pass: featuresWithoutCriteria.length === 0 };
}

// ---------------------------------------------------------------------------
// Pass 2 — adversarial PRD review (runAdversarialReview with ARCHITECT_PRD)
// ---------------------------------------------------------------------------

async function runPass2(prd: string, apiKey: string): Promise<Pass2Result> {
  const review = await runAdversarialReview('ARCHITECT_PRD', prd, apiKey || undefined);
  return { adversarialReview: review, pass: review.canProceed };
}

// ---------------------------------------------------------------------------
// Pass 3 — schema entity completeness (columns, indexes, RLS per entity)
// ---------------------------------------------------------------------------

/**
 * Parse the Data Model Overview section, enumerate entities (via ### headings or
 * top-level bullet points), and check each for column definitions, at least one
 * index signal, and RLS / company_id scoping.
 */
function runPass3(prd: string): Pass3Result {
  const lines = prd.split(/\r?\n/);
  let inDataModel = false;
  let currentEntity: string | null = null;
  const entities: string[] = [];
  const entityContent = new Map<string, string>();

  for (const line of lines) {
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2 !== null) {
      inDataModel = /data model|schema|database/i.test(h2[1] ?? '');
      if (!inDataModel) currentEntity = null;
      continue;
    }
    if (!inDataModel) continue;

    const h3 = /^###\s+`?([a-zA-Z][a-zA-Z0-9_]*)`?/i.exec(line);
    if (h3 !== null) {
      currentEntity = (h3[1] ?? '').trim().toLowerCase();
      if (!entities.includes(currentEntity)) entities.push(currentEntity);
      entityContent.set(currentEntity, '');
      continue;
    }

    // Capture top-level bullet-style entity definitions (only outside a ### block).
    const bullet = /^\s*[-*]\s*\*?\*?`?([a-z][a-z0-9_]{2,})`?\*?\*?/i.exec(line);
    if (bullet !== null && currentEntity === null) {
      const name = (bullet[1] ?? '').toLowerCase();
      if (!entities.includes(name) && name.length >= 3) {
        entities.push(name);
        entityContent.set(name, line);
      }
    }

    if (currentEntity !== null) {
      const prev = entityContent.get(currentEntity) ?? '';
      entityContent.set(currentEntity, prev + '\n' + line);
    }
  }

  const entitiesMissingColumns: string[] = [];
  const entitiesMissingIndexes: string[] = [];
  const entitiesMissingRls: string[] = [];

  for (const entity of entities) {
    const content = (entityContent.get(entity) ?? '').toLowerCase();
    if (!/column|field|varchar|text|uuid|integer|boolean|timestamp|bigint|primary key/.test(content)) {
      entitiesMissingColumns.push(entity);
    }
    if (!/index|indexed|primary key|pk\b|foreign key|fk\b/.test(content)) {
      entitiesMissingIndexes.push(entity);
    }
    if (!/rls|row.level security|polic|company_id/.test(content)) {
      entitiesMissingRls.push(entity);
    }
  }

  return {
    entitiesMissingColumns,
    entitiesMissingIndexes,
    entitiesMissingRls,
    pass:
      entitiesMissingColumns.length === 0 &&
      entitiesMissingIndexes.length === 0 &&
      entitiesMissingRls.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Pass 4 — governance alignment (BEHAVIORAL_CONTRACTS.md key rules)
// ---------------------------------------------------------------------------

/**
 * Key governance rules extracted from BEHAVIORAL_CONTRACTS.md, embedded here so
 * the pass runs without a file-system dependency. Each check tests the PRD for a
 * concrete violation; a failing `test` produces a violation entry.
 */
const GOVERNANCE_CHECKS: ReadonlyArray<{
  rule: string;
  test: (prd: string) => boolean;
  detail: string;
}> = [
  {
    rule: 'Six Laws SCHEMA — company_id scoping on multi-tenant entities',
    test: (prd) => {
      // Session 5 finding #9: an EXPLICIT single-tenant declaration means Six Laws Law 1 (tenant
      // scoping) does not apply — without this, a PRD that says "single-tenant, no organizations"
      // was flagged as a violation because "tenant"/"organization" appear in the very sentence
      // DENYING multi-tenancy. Checked first so it always wins over the generic tenant-word match.
      if (/\b(single[\s-]?tenant|single[\s-]?organi[sz]ation|not multi[\s-]?tenant|no multi[\s-]?tenancy)\b/i.test(prd)) {
        return true;
      }
      const hasTenant = /\b(?:company|tenant|organization|workspace)\b/i.test(prd);
      const hasScope = /\bcompany_id\b|\btenant_id\b|\borg_id\b/i.test(prd);
      return !hasTenant || hasScope;
    },
    detail:
      'PRD references multi-tenant concepts (company/tenant/organization) but does not specify ' +
      'company_id column for data isolation (Six Laws SCHEMA, BEHAVIORAL_CONTRACTS §global).',
  },
  {
    rule: 'Six Laws API — company_id must be derived from session, never from request body',
    test: (prd) => !/request[\s_-]?body.*company_id|company_id.*request[\s_-]?body/i.test(prd),
    detail:
      'PRD specifies company_id from the request body, which is forbidden. It must be derived ' +
      'from the authenticated session only (Six Laws API, BEHAVIORAL_CONTRACTS §global).',
  },
  {
    rule: 'Iron Law 8 — No mocks or placeholder data in production code',
    test: (prd) => !/\b(?:mock|placeholder|fake data|dummy data|stub data)\b/i.test(prd),
    detail:
      'PRD references mock, placeholder, or dummy data. All data must come from real API calls ' +
      'to real tables. No mocks or placeholder data in production code (Iron Law 8).',
  },
  {
    rule: 'Contract 18 — No TBD/TODO/unresolved markers in PRD specifications',
    test: (prd) => !/\bTBD\b|\bTODO\b|\bto be determined\b/i.test(prd),
    detail:
      'PRD contains unresolved TBD/TODO markers. Every element must be fully specified before ' +
      'Gate 1 approval — no element may be left as "TBD" or "TODO" (Contract 18).',
  },
  {
    rule: 'PRD structure — ## Success Metrics section required',
    test: (prd) => /^##\s+success.metrics/im.test(prd),
    detail:
      'PRD is missing the required ## Success Metrics section ' +
      '(mandatory by the s3-p04 PRD structure contract).',
  },
  {
    rule: 'PRD structure — ## Scope Boundaries section required',
    test: (prd) => /^##\s+scope.boundar|out.of.scope|non.goal/im.test(prd),
    detail:
      'PRD is missing the required ## Scope Boundaries section with explicit in-scope / ' +
      'out-of-scope definitions (mandatory by the s3-p04 PRD structure contract).',
  },
  {
    rule: 'Six Laws UI — Empty states must be specified for every feature',
    test: (prd) => /empty.state|no results|zero.state|nothing.here/i.test(prd),
    detail:
      'PRD does not mention empty-state handling. Every feature must specify its empty / ' +
      'zero-state UI (Six Laws UI; adversarial-review ARCHITECT_PRD UX vector).',
  },
];

function runPass4(prd: string): Pass4Result {
  const violations: Array<{ rule: string; detail: string }> = [];
  for (const check of GOVERNANCE_CHECKS) {
    if (!check.test(prd)) {
      violations.push({ rule: check.rule, detail: check.detail });
    }
  }
  return { violations, pass: violations.length === 0 };
}

// ---------------------------------------------------------------------------
// 4-pass orchestrator
// ---------------------------------------------------------------------------

async function runAllPasses(prd: string, apiKey: string): Promise<PrdPassResults> {
  const pass1 = runPass1(prd);
  const pass3 = runPass3(prd);
  const pass4 = runPass4(prd);
  // Pass 2 is the only async pass (makes a model call).
  const pass2 = await runPass2(prd, apiKey);
  return {
    pass1,
    pass2,
    pass3,
    pass4,
    allPassesClear: pass1.pass && pass2.pass && pass3.pass && pass4.pass,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 1A against `projectPath`, generating a PRD from `idea`.
 *
 * Always resolves (never rejects). Writes `PRD.md` into the target project (unless
 * disabled) and returns the `{ prd, metadata }` contract plus the grounding context,
 * token usage, and the Gate 1 halt marker. On a model failure it returns a
 * deterministic fallback PRD with `usedFallback: true` rather than throwing.
 */
export async function runPhase1aPrd(
  projectPath: string,
  idea: string,
  options: Phase1aOptions = {}
): Promise<Phase1aResult> {
  const log = options.log ?? logLine('phase1a');
  const projectName = options.projectName ?? (basename(projectPath) || 'project');
  const model = options.model ?? process.env.FORGE_PRD_MODEL ?? DEFAULT_MODEL;
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  // PRD generation is the primary complex-reasoning task → route through the Provider Router
  // (Claude primary, automatic failover/cost/free-tier handling). `defaultCallModel` remains the
  // exported Anthropic adapter and an explicit `options.callModel` still overrides routing.
  const callModel = options.callModel ?? providerCallModel('complex_reasoning');
  const writePrdFile = options.writePrdFile ?? true;
  const prdFileName = options.prdFileName ?? 'PRD.md';
  const maxSimilar = options.maxSimilarProjects ?? 5;
  const minSimilarity = options.minSimilarity ?? 0.35;
  const warnings: string[] = [];

  // 1. Resolve the target stack fingerprint (Phase 0 supplied, else idea-derived).
  const stackFingerprint =
    options.stackFingerprint ?? deriveFingerprintFromIdea(idea);
  if (!options.stackFingerprint) {
    log('no stack fingerprint supplied — derived a soft fingerprint from the idea');
  }

  // 2. Gather Build Memory grounding context (similar projects + insights + patterns).
  log('querying Build Memory for similar projects, insights, and design patterns');
  const memoryContext = await gatherMemoryContext(stackFingerprint, maxSimilar, minSimilarity);
  log(
    `context: ${memoryContext.similarProjects.length} similar build(s), ` +
      `${memoryContext.insights.length} insight(s), ${memoryContext.patterns.length} pattern(s)`
  );

  // 3. Assemble the prompt.
  const memoryBlock = renderMemoryContext(memoryContext, stackFingerprint);
  const systemPrompt = buildSystemPrompt(projectName);
  const userPrompt = buildUserPrompt(idea, memoryBlock);

  // 4. Call the model (guarded — a failure falls back, never throws).
  let prd = '';
  let metadata: PrdMetadata;
  let tokensInput = 0;
  let tokensOutput = 0;
  let usedFallback = false;

  try {
    log(`generating PRD via ${model} (max_tokens=${maxTokens})`);
    const response = await callModel({ model, maxTokens, system: systemPrompt, user: userPrompt, apiKey });
    tokensInput = response.tokensInput;
    tokensOutput = response.tokensOutput;

    const parsed = parseGeneration(response.text);
    prd = parsed.prd;
    if (parsed.featureCount === null || parsed.tableEstimate === null || parsed.agentEstimate === null) {
      warnings.push('Model output was not the structured JSON contract; counts derived heuristically.');
    }
    metadata = {
      featureCount: parsed.featureCount ?? countFeaturesHeuristic(prd),
      tableEstimate: parsed.tableEstimate ?? countTablesHeuristic(prd),
      agentEstimate: parsed.agentEstimate ?? countAgentsHeuristic(prd),
    };
    log(
      `PRD generated: ${metadata.featureCount} feature(s), ~${metadata.tableEstimate} table(s), ` +
        `~${metadata.agentEstimate} agent(s); tokens in=${tokensInput} out=${tokensOutput}`
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(`Model call failed — used fallback PRD skeleton: ${reason}`);
    log(`WARNING: model call failed (${reason}); falling back to a deterministic PRD skeleton`);
    const fallback = buildFallbackPrd(projectName, idea, stackFingerprint, memoryContext, reason);
    prd = fallback.prd;
    metadata = fallback.metadata;
    usedFallback = true;
  }

  // 4b. Run the 4-pass PRD refinement pipeline.
  log('running 4-pass PRD refinement pipeline');
  const passes = await runAllPasses(prd, apiKey);
  if (!passes.pass1.pass) {
    const missing = passes.pass1.featuresWithoutCriteria.join(', ');
    warnings.push(
      `Pass 1 (completeness): ${passes.pass1.featuresWithoutCriteria.length} feature(s) missing acceptance criteria — ${missing}`
    );
  }
  if (!passes.pass2.pass) {
    warnings.push(
      `Pass 2 (adversarial): ${passes.pass2.adversarialReview.blockers.length} BLOCKER finding(s) — review passes.pass2.adversarialReview before Gate 1 approval`
    );
  }
  if (!passes.pass3.pass) {
    const schemaIssues: string[] = [
      ...passes.pass3.entitiesMissingColumns.map((e) => `${e}:no-columns`),
      ...passes.pass3.entitiesMissingIndexes.map((e) => `${e}:no-indexes`),
      ...passes.pass3.entitiesMissingRls.map((e) => `${e}:no-rls`),
    ];
    warnings.push(`Pass 3 (schema completeness): ${schemaIssues.join(', ')}`);
  }
  if (!passes.pass4.pass) {
    const rules = passes.pass4.violations.map((v) => v.rule).join('; ');
    warnings.push(
      `Pass 4 (governance): ${passes.pass4.violations.length} violation(s): ${rules}`
    );
  }
  log(
    `passes: 1=${passes.pass1.pass ? 'PASS' : 'FAIL'} ` +
      `2=${passes.pass2.pass ? 'PASS' : 'FAIL'} ` +
      `3=${passes.pass3.pass ? 'PASS' : 'FAIL'} ` +
      `4=${passes.pass4.pass ? 'PASS' : 'FAIL'}`
  );

  // 5. Write PRD.md to the target project.
  let prdPath: string | null = null;
  if (writePrdFile) {
    const target = join(projectPath, prdFileName);
    try {
      await writeFile(target, prd, 'utf8');
      prdPath = target;
      log(`wrote ${target}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to write ${prdFileName}: ${detail}`);
      log(`WARNING: could not write ${prdFileName} (${detail})`);
    }
  }

  // 6. Halt for Gate 1 (Contract 2 — no bypass).
  const gate: GateStatus = {
    name: 'Gate 1 — PRD Approval',
    status: 'awaiting_human_approval',
    detail:
      'Phase 1A complete. The build HALTS here until a human approves the PRD ' +
      '(BEHAVIORAL_CONTRACTS Contract 2). Phase 1B must not start before approval.',
  };
  log('Phase 1A complete — HALT for Gate 1 (human PRD approval required)');

  return {
    prd,
    metadata,
    prdPath,
    stackFingerprint,
    similarProjects: memoryContext.similarProjects,
    model,
    tokensInput,
    tokensOutput,
    usedFallback,
    warnings,
    gate,
    passes,
    generatedAt: nowIso(),
  };
}

export default runPhase1aPrd;
