/**
 * FORGE 2.0 — Consensus Validator (multi-model cross-check of a primary generation).
 *
 * Every time FORGE's primary model produces an artifact (a PRD, an architecture doc, a CRUD
 * route, a research result, …), a SINGLE model is a single point of failure: a confident
 * hallucination, a missed requirement, or a fabricated fact sails straight through. This tool
 * closes that gap by sending the generated output to 2–3 INDEPENDENT validator models — each on
 * a DIFFERENT provider than the one that generated it — and scoring their verdicts into a
 * consensus. The validators never see each other's answers, so agreement is real signal rather
 * than an echo.
 *
 * HOW IT WORKS
 *   1. Pick the validator providers: every provider FORGE can route to EXCEPT `primaryProvider`
 *      (Contract — "validators must be different providers than the primary generator"), capped at
 *      `validatorCount` (default 3, minimum 2). Each validator is called through the existing
 *      {@link ProviderRouter} so cost/free-tier/failover accounting stays unified (Iron Law 3).
 *   2. Each validator receives the ORIGINAL prompt plus the GENERATED output and answers, in strict
 *      JSON: does the output correctly fulfill the prompt's requirements, with what confidence, and
 *      what specific issues exist (severity + description). For RESEARCH results it ALSO independently
 *      verifies each supplied claim — the existence of an opportunity and the accuracy of its
 *      eligibility requirements, deadlines, and dollar amounts.
 *   3. Consensus scoring over the USABLE judgments (a validator whose JSON cannot be parsed abstains
 *      and is excluded — never a false failure):
 *        - ALL validators approve            → VALIDATED
 *        - a MAJORITY approve (but not all)   → VALIDATED_WITH_CONCERNS
 *        - a majority FLAG issues             → FAILED
 *   4. Per-`prompt_type` REQUIREMENT level decides whether the generation actually PASSES the gate
 *      (the authoritative pass/fail, distinct from the descriptive verdict above). The defaults
 *      mirror the spec — `architecture` requires 3-of-3, `crud` requires 2-of-3, `documentation`
 *      requires 1-of-3 — and scale to however many validators were actually reachable. A generation
 *      PASSES when `approvals >= requiredApprovals`; otherwise the gate BLOCKS.
 *
 * VALIDATOR EFFECTIVENESS TRACKING: an issue is treated as REAL when it is corroborated by ≥2
 * validators (independent models converging on the same defect). Per run, each validator is credited
 * with the real issues it caught; the rollup is stored in Build Memory so that, across builds,
 * {@link getValidatorEffectiveness} can rank which validator models catch the most real issues — and
 * an operator can re-weight the panel toward them.
 *
 * STORAGE: every validation's full result is persisted to Build Memory (`production_telemetry`,
 * guarded — Contract 4) with the verdict, counts, per-validator scoreboard, and (for research) the
 * per-claim verification, so the consensus history is queryable and degrades to stateless mode when
 * the DB is unreachable rather than blocking the build.
 *
 * HOUSE RULES (mirrored from the rest of FORGE): NON-FATAL — always resolves, never throws (Iron
 * Law 3); an un-reachable validator panel (<2 usable judgments) SKIPs rather than fabricating a
 * failure; the router, the clock, the Build-Memory writer and the per-provider caller are all
 * INJECTABLE so the tool unit-tests with no network and no database; no governance or target-project
 * file is touched; secret values are never logged.
 *
 * BOUNDARY: this module decides whether a primary generation has multi-model consensus. It is wired
 * into {@link runSentinel} (phase4-sentinel) as an OPTIONAL post-generation check the executor
 * configures with the prompt + output; a blocked consensus fails the Sentinel gate exactly like a
 * critical security finding.
 */

import {
  ProviderRouter,
  getProviderRouter,
  type ProviderName,
} from '../engine/provider-router.js';
import type { ModelRequest } from '../phases/phase1a-prd.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import { logLine } from './forge-logger.js';
import type {
  Json,
  JsonObject,
  TelemetryEventType,
  TelemetrySeverity,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Public contract — verdicts, issues, claims, requirements
// ---------------------------------------------------------------------------

/** The descriptive consensus verdict (distinct from the per-prompt_type pass/fail). */
export type ConsensusVerdict = 'VALIDATED' | 'VALIDATED_WITH_CONCERNS' | 'FAILED';

/** Severity of a single issue a validator raised against the generated output. */
export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low';

/** One issue a validator raised about the generated output. */
export interface ValidationIssue {
  severity: IssueSeverity;
  /** What is wrong (the validator's words, trimmed). */
  description: string;
}

/** The KIND of fact a research claim asserts (validators verify each independently). */
export type ResearchClaimKind =
  | 'opportunity_existence'
  | 'eligibility'
  | 'deadline'
  | 'dollar_amount'
  | 'other';

/** A single verifiable claim extracted from a research result. */
export interface ResearchClaim {
  /** Stable id so each validator's verification can be matched back to the claim. */
  id: string;
  kind: ResearchClaimKind;
  /** The asserted fact, e.g. "Grant X has a deadline of 2026-03-01" or "awards up to $50,000". */
  statement: string;
}

/** One validator's verification of one research claim. */
export interface ClaimVerification {
  id: string;
  /** Whether this validator believes the claim is accurate / the opportunity exists. */
  verified: boolean;
  /** The validator's note on the claim (e.g. "deadline is actually 2026-03-15"). */
  note: string;
}

/**
 * The minimum agreement a `prompt_type` requires to PASS, expressed as a fraction `required/of` so
 * it scales when fewer validators are reachable. `architecture` = 3/3 (unanimous), `crud` = 2/3,
 * `documentation` = 1/3.
 */
export interface ConsensusRequirement {
  /** Approving validators required (numerator), at the reference panel size `of`. */
  required: number;
  /** Reference panel size the requirement was authored against (denominator). */
  of: number;
}

// ---------------------------------------------------------------------------
// Default policy — per-prompt_type consensus requirement levels
// ---------------------------------------------------------------------------

/**
 * Default consensus requirement per `prompt_type`. The three spec keys (`architecture`, `crud`,
 * `documentation`) are authoritative; FORGE's own queue prompt types (schema/auth/api/ui/…) get
 * sensible defaults by risk (schema/auth/agent/deploy are unanimous; api/ui/feature are 2/3; test
 * is 1/3). Unknown types fall back to {@link DEFAULT_CONSENSUS_LEVEL}. Override via options.
 */
export const DEFAULT_CONSENSUS_LEVELS: Readonly<Record<string, ConsensusRequirement>> = {
  // Spec-mandated keys.
  architecture: { required: 3, of: 3 },
  crud: { required: 2, of: 3 },
  documentation: { required: 1, of: 3 },
  // FORGE queue.yaml prompt types (engine/queue-generator PromptType).
  schema: { required: 3, of: 3 },
  auth: { required: 3, of: 3 },
  agent: { required: 3, of: 3 },
  deploy: { required: 3, of: 3 },
  api: { required: 2, of: 3 },
  ui: { required: 2, of: 3 },
  feature: { required: 2, of: 3 },
  research: { required: 2, of: 3 },
  test: { required: 1, of: 3 },
};

/** Requirement for a `prompt_type` not present in the level map (a safe majority). */
export const DEFAULT_CONSENSUS_LEVEL: ConsensusRequirement = { required: 2, of: 3 };

/** Default order in which providers are recruited as validators (primary is removed at runtime). */
export const DEFAULT_VALIDATOR_ORDER: readonly ProviderName[] = [
  'anthropic',
  'openai',
  'gemini',
  'deepseek',
];

/** Default number of validators to recruit. */
export const DEFAULT_VALIDATOR_COUNT = 3;
/** Minimum usable judgments for a consensus to be meaningful (else the check SKIPs). */
export const MIN_VALIDATORS = 2;
/** Validators needed to flag the same issue before it counts as a REAL (corroborated) issue. */
export const CORROBORATION_THRESHOLD = 2;
/** Default max_tokens for a validator response. */
export const DEFAULT_VALIDATOR_MAX_TOKENS = 1500;

// ---------------------------------------------------------------------------
// Public contract — judgments + result
// ---------------------------------------------------------------------------

/** One validator model's full judgment of the generated output. */
export interface ValidatorJudgment {
  /** The provider that produced this judgment. */
  provider: ProviderName;
  /** The model id that actually answered. */
  model: string;
  /** Whether the validator's JSON could be parsed (an un-parsable validator ABSTAINS). */
  usable: boolean;
  /** Whether the validator judged the output to correctly fulfill the prompt. */
  approves: boolean;
  /** The validator's self-reported confidence in [0, 1]. */
  confidence: number;
  /** Specific issues the validator raised (empty when it approves cleanly). */
  issues: ValidationIssue[];
  /** Per-claim verifications (research mode only; empty otherwise). */
  claimVerifications: ClaimVerification[];
  /** The validator's one-line summary. */
  summary: string;
  /** Estimated USD cost of this validator call. */
  costUsd: number;
  /** A note when the validator was unusable (parse failure / unreachable). */
  error?: string;
}

/** Per-validator effectiveness for one run (feeds the cross-build scoreboard). */
export interface ValidatorScore {
  provider: ProviderName;
  model: string;
  /** Total issues this validator raised. */
  issuesRaised: number;
  /** Of those, how many were corroborated by ≥1 other validator (i.e. REAL). */
  realIssuesCaught: number;
  /** Whether this validator approved the output. */
  approved: boolean;
  /** Whether this validator's judgment was usable. */
  usable: boolean;
}

/** A cluster of equivalent issues raised by ≥1 validator (corroboration unit). */
export interface IssueCluster {
  /** Normalized key the cluster groups on. */
  key: string;
  /** Worst severity reported across the cluster. */
  severity: IssueSeverity;
  /** A representative description (the longest one seen). */
  description: string;
  /** Providers that raised an issue in this cluster. */
  providers: ProviderName[];
  /** True when ≥{@link CORROBORATION_THRESHOLD} distinct providers flagged it. */
  corroborated: boolean;
}

/** Per-claim consensus across the validator panel (research mode). */
export interface ClaimConsensus {
  id: string;
  kind: ResearchClaimKind;
  statement: string;
  /** Validators that verified the claim as accurate. */
  verifiedBy: number;
  /** Validators that disputed it. */
  disputedBy: number;
  /** True when a majority of usable validators verified the claim. */
  verified: boolean;
  /** Disputing validators' notes (why the claim may be wrong). */
  notes: string[];
}

/** The full result of one consensus validation run (the s5-p04 post-generation contract). */
export interface ConsensusValidationResult {
  /** The AUTHORITATIVE gate result: approvals met the prompt_type requirement. */
  passed: boolean;
  /** Whether the gate BLOCKS the build (`!passed` — surfaced for symmetry with the other checks). */
  blocked: boolean;
  /** The descriptive consensus verdict. */
  verdict: ConsensusVerdict;
  /** The prompt_type that selected the requirement. */
  promptType: string;
  /** Resolved approvals required at the actual panel size. */
  requiredApprovals: number;
  /** Validators that approved. */
  approvals: number;
  /** Usable judgments (the consensus denominator). */
  usableValidators: number;
  /** Validators recruited (including any that abstained). */
  totalValidators: number;
  /** Each validator's judgment, in recruitment order. */
  judgments: ValidatorJudgment[];
  /** Issue clusters across the panel (corroborated ones are REAL). */
  issueClusters: IssueCluster[];
  /** Per-validator effectiveness for this run. */
  scoreboard: ValidatorScore[];
  /** Per-claim consensus (research mode; empty otherwise). */
  claimConsensus: ClaimConsensus[];
  /** Total estimated USD cost of the validator panel. */
  costUsd: number;
  /** Full markdown report. */
  report: string;
  /** ISO timestamp the result was produced. */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Public contract — input + injectable collaborators
// ---------------------------------------------------------------------------

/** What to validate. */
export interface ConsensusValidationInput {
  /** The ORIGINAL prompt the primary model was given (the requirements to check against). */
  originalPrompt: string;
  /** The output the primary model generated. */
  generatedOutput: string;
  /** The provider that produced `generatedOutput` — EXCLUDED from the validator panel. */
  primaryProvider: ProviderName;
  /** The model id that produced the output (recorded; optional). */
  primaryModel?: string;
  /** The prompt's type — selects the consensus requirement level. */
  promptType: string;
  /**
   * Research claims to independently verify (existence of an opportunity; accuracy of eligibility
   * requirements, deadlines, dollar amounts). When present the validators run in research mode.
   */
  researchClaims?: ResearchClaim[];
  /** Project name for the Build Memory record. Default 'unknown'. */
  projectName?: string;
  /** build_runs.id to associate the stored result with. */
  buildRunId?: string | null;
  /** prompt_executions.id to associate the stored result with. */
  promptExecutionId?: string | null;
}

/** The minimal result the tool needs back from one validator call. */
export interface ValidatorCallResult {
  provider: ProviderName;
  model: string;
  text: string;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
}

/**
 * Call ONE specific provider as a validator. Returns null when that provider is unreachable (no
 * key / cooldown / free tier spent / network) — the caller records an abstention, never throws.
 */
export type ValidatorCaller = (
  provider: ProviderName,
  request: ModelRequest
) => Promise<ValidatorCallResult | null>;

/** The record handed to the Build-Memory store. */
export interface ConsensusStoredRecord {
  projectName: string;
  buildRunId: string | null;
  promptExecutionId: string | null;
  promptType: string;
  primaryProvider: ProviderName;
  primaryModel: string | null;
  verdict: ConsensusVerdict;
  passed: boolean;
  blocked: boolean;
  requiredApprovals: number;
  approvals: number;
  usableValidators: number;
  totalValidators: number;
  scoreboard: ValidatorScore[];
  realIssues: number;
  claimConsensus: ClaimConsensus[];
  costUsd: number;
  generatedAt: string;
}

/** Persist a consensus result to Build Memory. Default: a guarded `production_telemetry` write. */
export type ConsensusResultStore = (
  record: ConsensusStoredRecord,
  log: (m: string) => void
) => Promise<void>;

/** Options controlling a consensus validation run — everything is injectable. */
export interface ConsensusValidatorOptions {
  /** The provider router used to call validators. Default: the shared {@link getProviderRouter}. */
  router?: ProviderRouter;
  /** Per-prompt_type requirement overrides, merged over {@link DEFAULT_CONSENSUS_LEVELS}. */
  consensusLevels?: Record<string, ConsensusRequirement>;
  /** Requirement for an unmapped prompt_type. Default {@link DEFAULT_CONSENSUS_LEVEL}. */
  defaultLevel?: ConsensusRequirement;
  /** Explicit validator providers (still filtered to exclude the primary). Default: derived. */
  validatorProviders?: ProviderName[];
  /** Recruitment order when `validatorProviders` is not given. Default {@link DEFAULT_VALIDATOR_ORDER}. */
  validatorOrder?: readonly ProviderName[];
  /** How many validators to recruit. Default {@link DEFAULT_VALIDATOR_COUNT} (3). */
  validatorCount?: number;
  /** max_tokens for each validator response. Default {@link DEFAULT_VALIDATOR_MAX_TOKENS}. */
  maxTokens?: number;
  /** Override the per-provider validator call (tests). Default: a router-backed caller. */
  callValidator?: ValidatorCaller;
  /** Override the Build-Memory writer (tests). Default: a guarded `production_telemetry` write. */
  storeResult?: ConsensusResultStore;
  /** Clock for the `generatedAt` stamp. Default {@link nowIso}. */
  now?: () => string;
  /** Progress reporter. Default a `[FORGE:consensus]`-prefixed console line. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Prompt assembly (what each validator is asked)
// ---------------------------------------------------------------------------

/** The system prompt that frames a validator as an independent, skeptical cross-checker. */
function buildValidatorSystemPrompt(researchMode: boolean): string {
  const base =
    'You are an INDEPENDENT validation model on a multi-model consensus panel. You did NOT write ' +
    'the output under review and you cannot see the other validators. Your job is to judge, strictly ' +
    "and skeptically, whether the GENERATED OUTPUT correctly and completely fulfills the ORIGINAL " +
    "PROMPT's requirements, and to name every specific issue you find. Do not be agreeable — if a " +
    'requirement is unmet, a fact looks fabricated, or the output is incomplete, say so. Reply with ' +
    'ONE JSON object and nothing else.';
  const research = researchMode
    ? ' This output is a RESEARCH RESULT. For EACH listed claim, independently assess whether the ' +
      'opportunity genuinely exists and whether its eligibility requirements, deadlines, and dollar ' +
      'amounts are accurate. Treat any claim you cannot corroborate as NOT verified.'
    : '';
  return base + research;
}

/** The JSON shape requested from every validator (kept in the prompt and in the parser). */
const VALIDATOR_JSON_SHAPE =
  '{"fulfills": <true|false>, "confidence": <0..1>, ' +
  '"issues": [{"severity": "critical|high|medium|low", "description": "<specific issue>"}], ' +
  '"claimVerifications": [{"id": "<claim id>", "verified": <true|false>, "note": "<why>"}], ' +
  '"summary": "<one sentence>"}';

/** Truncate very large text so a single validator call stays within budget. */
function clipForPrompt(text: string, max = 24000): string {
  const t = text ?? '';
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…[${t.length - max} chars truncated]`;
}

/** Assemble the user message: original prompt + generated output (+ claims in research mode). */
function buildValidatorUserPrompt(input: ConsensusValidationInput): string {
  const parts: string[] = [];
  parts.push(`PROMPT TYPE: ${input.promptType}`);
  parts.push('');
  parts.push('=== ORIGINAL PROMPT (the requirements) ===');
  parts.push(clipForPrompt(input.originalPrompt));
  parts.push('');
  parts.push('=== GENERATED OUTPUT (under review) ===');
  parts.push(clipForPrompt(input.generatedOutput));
  parts.push('');
  if (input.researchClaims && input.researchClaims.length > 0) {
    parts.push('=== CLAIMS TO INDEPENDENTLY VERIFY ===');
    for (const c of input.researchClaims) {
      parts.push(`- [${c.id}] (${c.kind}) ${c.statement}`);
    }
    parts.push('');
  }
  parts.push(
    'Respond with exactly one JSON object of this shape (omit claimVerifications if there were no claims):'
  );
  parts.push(VALIDATOR_JSON_SHAPE);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Validator response parsing (tolerant, guarded — an unreadable answer abstains)
// ---------------------------------------------------------------------------

/** The fields the parser reads out of a validator's JSON. */
interface ParsedValidatorAnswer {
  approves: boolean;
  confidence: number;
  issues: ValidationIssue[];
  claimVerifications: ClaimVerification[];
  summary: string;
}

/** Extract the first balanced top-level JSON object from arbitrary model text, or null. */
export function extractJsonObject(text: string): string | null {
  const s = text ?? '';
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Coerce an unknown severity into a valid {@link IssueSeverity} (default 'medium'). */
function coerceSeverity(raw: unknown): IssueSeverity {
  const s = String(raw ?? '').toLowerCase().trim();
  if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low') return s;
  if (s === 'blocker' || s === 'severe') return 'critical';
  if (s === 'major') return 'high';
  if (s === 'minor' || s === 'nit' || s === 'info') return 'low';
  return 'medium';
}

/** Clamp a confidence-ish value into [0, 1] (tolerating a 0–100 scale). */
function clampConfidence(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0.5;
  if (n <= 0) return 0;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return 1;
}

/**
 * Parse a validator's raw text into a structured answer, or null when no JSON object is present
 * (the validator then ABSTAINS — never a false failure). Tolerant of extra prose around the JSON.
 */
export function parseValidatorAnswer(text: string): ParsedValidatorAnswer | null {
  const jsonText = extractJsonObject(text);
  if (jsonText === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const fulfillsRaw = obj.fulfills ?? obj.valid ?? obj.correct ?? obj.passes;
  const approves =
    fulfillsRaw === true ||
    String(fulfillsRaw ?? '').toLowerCase().trim() === 'true' ||
    String(fulfillsRaw ?? '').toLowerCase().trim() === 'yes';

  const issues: ValidationIssue[] = [];
  if (Array.isArray(obj.issues)) {
    for (const it of obj.issues) {
      if (it && typeof it === 'object' && !Array.isArray(it)) {
        const o = it as Record<string, unknown>;
        const description = String(o.description ?? o.issue ?? o.message ?? '').trim();
        if (description !== '') issues.push({ severity: coerceSeverity(o.severity), description });
      } else if (typeof it === 'string' && it.trim() !== '') {
        issues.push({ severity: 'medium', description: it.trim() });
      }
    }
  }

  const claimVerifications: ClaimVerification[] = [];
  if (Array.isArray(obj.claimVerifications ?? obj.claims)) {
    const arr = (obj.claimVerifications ?? obj.claims) as unknown[];
    for (const cv of arr) {
      if (cv && typeof cv === 'object' && !Array.isArray(cv)) {
        const o = cv as Record<string, unknown>;
        const id = String(o.id ?? '').trim();
        if (id === '') continue;
        const verified =
          o.verified === true ||
          String(o.verified ?? '').toLowerCase().trim() === 'true' ||
          String(o.verified ?? '').toLowerCase().trim() === 'yes';
        claimVerifications.push({ id, verified, note: String(o.note ?? o.reason ?? '').trim() });
      }
    }
  }

  return {
    approves,
    confidence: clampConfidence(obj.confidence),
    issues,
    claimVerifications,
    summary: String(obj.summary ?? '').trim(),
  };
}

// ---------------------------------------------------------------------------
// Validator selection + the default router-backed caller
// ---------------------------------------------------------------------------

/** Recruit the validator providers: the configured/derived order minus the primary, capped. */
export function selectValidatorProviders(
  primary: ProviderName,
  options: Pick<ConsensusValidatorOptions, 'validatorProviders' | 'validatorOrder' | 'validatorCount'>
): ProviderName[] {
  const order = options.validatorProviders ?? options.validatorOrder ?? DEFAULT_VALIDATOR_ORDER;
  const count = options.validatorCount ?? DEFAULT_VALIDATOR_COUNT;
  const seen = new Set<ProviderName>();
  const picked: ProviderName[] = [];
  for (const p of order) {
    if (p === primary || seen.has(p)) continue;
    seen.add(p);
    picked.push(p);
    if (picked.length >= count) break;
  }
  return picked;
}

/**
 * Build the default {@link ValidatorCaller}: call a SPECIFIC provider through a router that shares
 * the parent router's usage/cost ledger (so the consensus panel's spend rolls into the build total),
 * pinning the validation route to exactly that provider. Returns null on any provider error so the
 * panel degrades to whoever is reachable.
 */
export function makeRouterValidatorCaller(router: ProviderRouter): ValidatorCaller {
  const usage = router.usageTracker;
  // One pinned sub-router per provider, lazily created, sharing the parent ledger.
  const pinned = new Map<ProviderName, ProviderRouter>();
  const routerFor = (provider: ProviderName): ProviderRouter => {
    let r = pinned.get(provider);
    if (!r) {
      r = new ProviderRouter({ routes: { validation: [provider] }, usage });
      pinned.set(provider, r);
    }
    return r;
  };
  return async (provider, request) => {
    try {
      const routed = await routerFor(provider).route('validation', request);
      return {
        provider,
        model: routed.model,
        text: routed.text,
        tokensInput: routed.tokensInput,
        tokensOutput: routed.tokensOutput,
        costUsd: routed.costUsd,
      };
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Consensus scoring
// ---------------------------------------------------------------------------

/** Resolve a prompt_type to its requirement, merging overrides over the defaults. */
export function resolveRequirement(
  promptType: string,
  levels: Record<string, ConsensusRequirement>,
  fallback: ConsensusRequirement
): ConsensusRequirement {
  return levels[promptType] ?? levels[promptType.toLowerCase()] ?? fallback;
}

/** Scale a `required/of` requirement to the actual usable panel size (clamped to [1, n]). */
export function scaleRequiredApprovals(req: ConsensusRequirement, panelSize: number): number {
  if (panelSize <= 0) return 0;
  const ratio = req.of > 0 ? req.required / req.of : 1;
  const scaled = Math.ceil(ratio * panelSize);
  return Math.min(panelSize, Math.max(1, scaled));
}

/** Normalize an issue description into a clustering key (lowercased, alphanumerics only, capped). */
export function normalizeIssueKey(description: string): string {
  return (description ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 2)
    .slice(0, 8)
    .join(' ');
}

const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Cluster issues across validators by normalized key; a cluster of ≥2 providers is corroborated. */
export function clusterIssues(judgments: ValidatorJudgment[]): IssueCluster[] {
  const map = new Map<string, IssueCluster & { _providerSet: Set<ProviderName> }>();
  for (const j of judgments) {
    if (!j.usable) continue;
    // De-duplicate a single validator's own repeated keys so it only counts once per cluster.
    const ownKeys = new Set<string>();
    for (const issue of j.issues) {
      const key = normalizeIssueKey(issue.description) || issue.description.toLowerCase().slice(0, 24);
      if (ownKeys.has(key)) continue;
      ownKeys.add(key);
      let cluster = map.get(key);
      if (!cluster) {
        cluster = {
          key,
          severity: issue.severity,
          description: issue.description,
          providers: [],
          corroborated: false,
          _providerSet: new Set<ProviderName>(),
        };
        map.set(key, cluster);
      }
      cluster._providerSet.add(j.provider);
      if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[cluster.severity]) cluster.severity = issue.severity;
      if (issue.description.length > cluster.description.length) cluster.description = issue.description;
    }
  }
  const clusters: IssueCluster[] = [];
  for (const c of map.values()) {
    const providers = [...c._providerSet];
    clusters.push({
      key: c.key,
      severity: c.severity,
      description: c.description,
      providers,
      corroborated: providers.length >= CORROBORATION_THRESHOLD,
    });
  }
  // Corroborated + worst severity first.
  clusters.sort(
    (a, b) =>
      Number(b.corroborated) - Number(a.corroborated) ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.providers.length - a.providers.length
  );
  return clusters;
}

/** Score each validator: issues raised vs. real (corroborated) issues it caught. */
export function scoreValidators(
  judgments: ValidatorJudgment[],
  clusters: IssueCluster[]
): ValidatorScore[] {
  const corroboratedByProvider = new Map<ProviderName, Set<string>>();
  for (const c of clusters) {
    if (!c.corroborated) continue;
    for (const p of c.providers) {
      const set = corroboratedByProvider.get(p) ?? new Set<string>();
      set.add(c.key);
      corroboratedByProvider.set(p, set);
    }
  }
  return judgments.map((j) => ({
    provider: j.provider,
    model: j.model,
    issuesRaised: j.issues.length,
    realIssuesCaught: corroboratedByProvider.get(j.provider)?.size ?? 0,
    approved: j.approves,
    usable: j.usable,
  }));
}

/** The descriptive verdict from approvals over the usable panel. */
export function computeVerdict(approvals: number, usable: number): ConsensusVerdict {
  if (usable === 0) return 'FAILED';
  if (approvals === usable) return 'VALIDATED';
  if (approvals > usable / 2) return 'VALIDATED_WITH_CONCERNS';
  return 'FAILED';
}

/** Build per-claim consensus from the validators' per-claim verifications. */
export function computeClaimConsensus(
  claims: ResearchClaim[],
  judgments: ValidatorJudgment[]
): ClaimConsensus[] {
  const usable = judgments.filter((j) => j.usable);
  return claims.map((claim) => {
    let verifiedBy = 0;
    let disputedBy = 0;
    const notes: string[] = [];
    for (const j of usable) {
      const cv = j.claimVerifications.find((v) => v.id === claim.id);
      if (!cv) continue;
      if (cv.verified) verifiedBy++;
      else {
        disputedBy++;
        if (cv.note) notes.push(`${j.provider}: ${cv.note}`);
      }
    }
    return {
      id: claim.id,
      kind: claim.kind,
      statement: claim.statement,
      verifiedBy,
      disputedBy,
      verified: verifiedBy > disputedBy && verifiedBy > 0,
      notes,
    };
  });
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

const VERDICT_ICON: Record<ConsensusVerdict, string> = {
  VALIDATED: '✅',
  VALIDATED_WITH_CONCERNS: '⚠️',
  FAILED: '❌',
};

/** Render the full markdown consensus report. */
function renderReport(r: Omit<ConsensusValidationResult, 'report'>, input: ConsensusValidationInput): string {
  const lines: string[] = [];
  lines.push('# FORGE Consensus Validator — Report');
  lines.push('');
  lines.push(`- **Verdict:** ${VERDICT_ICON[r.verdict]} ${r.verdict}`);
  lines.push(`- **Gate:** ${r.passed ? 'PASS ✅' : 'BLOCK ❌'} (${r.approvals}/${r.usableValidators} approved; ` +
    `requires ${r.requiredApprovals} for prompt_type \`${r.promptType}\`)`);
  lines.push(`- **Primary generator:** ${input.primaryProvider}${input.primaryModel ? ` / ${input.primaryModel}` : ''} (excluded from panel)`);
  lines.push(`- **Panel:** ${r.judgments.map((j) => j.provider).join(', ') || '(none reachable)'}`);
  lines.push(`- **Estimated cost:** $${r.costUsd.toFixed(4)}`);
  lines.push('');

  lines.push('## Validator Verdicts');
  lines.push('');
  lines.push('| Validator | Model | Approves | Confidence | Issues | Real | Usable |');
  lines.push('|-----------|-------|----------|------------|--------|------|--------|');
  for (const s of r.scoreboard) {
    const j = r.judgments.find((x) => x.provider === s.provider);
    lines.push(
      `| ${s.provider} | ${s.model || '—'} | ${s.usable ? (s.approved ? 'yes' : 'NO') : '—'} | ` +
        `${j ? j.confidence.toFixed(2) : '—'} | ${s.issuesRaised} | ${s.realIssuesCaught} | ${s.usable ? 'yes' : 'ABSTAIN'} |`
    );
  }
  lines.push('');

  const corroborated = r.issueClusters.filter((c) => c.corroborated);
  if (corroborated.length > 0) {
    lines.push('## Corroborated Issues (flagged by ≥2 validators — REAL)');
    lines.push('');
    for (const c of corroborated) {
      lines.push(`- **[${c.severity}]** ${c.description}  _(${c.providers.join(', ')})_`);
    }
    lines.push('');
  }

  const singletons = r.issueClusters.filter((c) => !c.corroborated);
  if (singletons.length > 0) {
    lines.push('## Single-Validator Issues (uncorroborated — surfaced, not weighted)');
    lines.push('');
    for (const c of singletons.slice(0, 20)) {
      lines.push(`- [${c.severity}] ${c.description}  _(${c.providers.join(', ')})_`);
    }
    lines.push('');
  }

  if (r.claimConsensus.length > 0) {
    lines.push('## Research Claim Verification');
    lines.push('');
    lines.push('| Claim | Kind | Verified | Disputed | Consensus |');
    lines.push('|-------|------|----------|----------|-----------|');
    for (const c of r.claimConsensus) {
      lines.push(
        `| ${c.statement.replace(/\|/g, '\\|').slice(0, 80)} | ${c.kind} | ${c.verifiedBy} | ${c.disputedBy} | ${c.verified ? '✅ verified' : '❌ unverified'} |`
      );
    }
    const disputed = r.claimConsensus.filter((c) => !c.verified && c.notes.length > 0);
    if (disputed.length > 0) {
      lines.push('');
      lines.push('### Disputed claim notes');
      for (const c of disputed) {
        lines.push(`- **${c.statement.slice(0, 80)}**`);
        for (const n of c.notes.slice(0, 4)) lines.push(`  - ${n}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Default Build-Memory store (production_telemetry, guarded — Contract 4)
// ---------------------------------------------------------------------------

async function defaultStoreResult(record: ConsensusStoredRecord, log: (m: string) => void): Promise<void> {
  const eventType: TelemetryEventType = record.blocked ? 'error' : 'usage';
  const severity: TelemetrySeverity = record.blocked
    ? 'critical'
    : record.verdict === 'VALIDATED_WITH_CONCERNS'
      ? 'warning'
      : 'info';
  const eventData: JsonObject = {
    kind: 'consensus_validator',
    promptType: record.promptType,
    primaryProvider: record.primaryProvider,
    primaryModel: record.primaryModel,
    verdict: record.verdict,
    passed: record.passed,
    blocked: record.blocked,
    requiredApprovals: record.requiredApprovals,
    approvals: record.approvals,
    usableValidators: record.usableValidators,
    totalValidators: record.totalValidators,
    realIssues: record.realIssues,
    promptExecutionId: record.promptExecutionId,
    // Per-validator scoreboard — the cross-build "who catches the most real issues" signal.
    scoreboard: record.scoreboard.map((s) => ({
      provider: s.provider,
      model: s.model,
      issuesRaised: s.issuesRaised,
      realIssuesCaught: s.realIssuesCaught,
      approved: s.approved,
      usable: s.usable,
    })) as Json,
    claimConsensus: record.claimConsensus.map((c) => ({
      id: c.id,
      kind: c.kind,
      verified: c.verified,
      verifiedBy: c.verifiedBy,
      disputedBy: c.disputedBy,
    })) as Json,
    costUsd: record.costUsd,
    generatedAt: record.generatedAt,
  };
  try {
    await BuildMemory.telemetry.createEvent({
      project_name: record.projectName,
      build_run_id: record.buildRunId,
      event_type: eventType,
      event_data: eventData,
      severity,
      captured_at: record.generatedAt,
    });
  } catch (error) {
    log(`WARNING: Build Memory store degraded (${describe(error)}) — result not persisted`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point — runConsensusValidation
// ---------------------------------------------------------------------------

/**
 * Validate a primary generation against an independent multi-model consensus panel and return a
 * {@link ConsensusValidationResult}. NON-FATAL — always resolves, never throws (Iron Law 3); a panel
 * with fewer than {@link MIN_VALIDATORS} usable judgments yields `passed: true` with a SKIP-style
 * verdict note (never a false block), exactly like the other un-evaluable Sentinel checks.
 */
export async function runConsensusValidation(
  input: ConsensusValidationInput,
  options: ConsensusValidatorOptions = {}
): Promise<ConsensusValidationResult> {
  const log = options.log ?? logLine('consensus');
  const now = options.now ?? nowIso;
  const generatedAt = now();
  const router = options.router ?? getProviderRouter();
  const callValidator = options.callValidator ?? makeRouterValidatorCaller(router);
  const levels = { ...DEFAULT_CONSENSUS_LEVELS, ...(options.consensusLevels ?? {}) };
  const fallback = options.defaultLevel ?? DEFAULT_CONSENSUS_LEVEL;
  const maxTokens = options.maxTokens ?? DEFAULT_VALIDATOR_MAX_TOKENS;
  const claims = input.researchClaims ?? [];
  const researchMode = claims.length > 0;

  const providers = selectValidatorProviders(input.primaryProvider, options);
  log(
    `validating ${input.promptType} output (primary=${input.primaryProvider}) ` +
      `against [${providers.join(', ') || 'no eligible providers'}]${researchMode ? ` + ${claims.length} claim(s)` : ''}`
  );

  const system = buildValidatorSystemPrompt(researchMode);
  const user = buildValidatorUserPrompt(input);

  // Call every validator concurrently; an unreachable / unreadable one ABSTAINS (usable: false).
  const judgments = await Promise.all(
    providers.map(async (provider): Promise<ValidatorJudgment> => {
      const request: ModelRequest = { model: '', maxTokens, system, user, apiKey: '' };
      let call: ValidatorCallResult | null = null;
      try {
        call = await callValidator(provider, request);
      } catch (error) {
        log(`validator ${provider} threw (${describe(error)}) — abstaining`);
        call = null;
      }
      if (call === null) {
        return emptyJudgment(provider, '', false, 'validator unreachable (no key / cooldown / network)');
      }
      const parsed = parseValidatorAnswer(call.text);
      if (parsed === null) {
        log(`validator ${provider}/${call.model} returned unparsable output — abstaining`);
        return {
          ...emptyJudgment(provider, call.model, false, 'validator returned no parsable JSON verdict'),
          costUsd: call.costUsd,
        };
      }
      return {
        provider,
        model: call.model,
        usable: true,
        approves: parsed.approves,
        confidence: parsed.confidence,
        issues: parsed.issues,
        claimVerifications: parsed.claimVerifications,
        summary: parsed.summary,
        costUsd: call.costUsd,
      };
    })
  );

  const usableJudgments = judgments.filter((j) => j.usable);
  const usableValidators = usableJudgments.length;
  const approvals = usableJudgments.filter((j) => j.approves).length;
  const costUsd = round4(judgments.reduce((a, j) => a + (j.costUsd || 0), 0));
  const issueClusters = clusterIssues(judgments);
  const scoreboard = scoreValidators(judgments, issueClusters);
  const claimConsensus = computeClaimConsensus(claims, judgments);
  const realIssues = issueClusters.filter((c) => c.corroborated).length;

  // Too few usable judgments → SKIP semantics: do not block the build on an unreachable panel.
  if (usableValidators < MIN_VALIDATORS) {
    log(`only ${usableValidators} usable validator(s) (<${MIN_VALIDATORS}) — consensus not evaluated (pass-through)`);
    const skeleton: Omit<ConsensusValidationResult, 'report'> = {
      passed: true,
      blocked: false,
      verdict: 'VALIDATED_WITH_CONCERNS',
      promptType: input.promptType,
      requiredApprovals: 0,
      approvals,
      usableValidators,
      totalValidators: judgments.length,
      judgments,
      issueClusters,
      scoreboard,
      claimConsensus,
      costUsd,
      generatedAt,
    };
    const report =
      `# FORGE Consensus Validator — Report\n\n` +
      `- **Verdict:** ⊘ SKIP — only ${usableValidators} of ${judgments.length} validator(s) were usable ` +
      `(need ≥${MIN_VALIDATORS}). Consensus not evaluated; build not blocked.\n` +
      `- **Primary generator:** ${input.primaryProvider} (excluded)\n`;
    await persist(input, { ...skeleton, report }, realIssues, options.storeResult ?? defaultStoreResult, log);
    return { ...skeleton, report };
  }

  const requirement = resolveRequirement(input.promptType, levels, fallback);
  const requiredApprovals = scaleRequiredApprovals(requirement, usableValidators);
  const verdict = computeVerdict(approvals, usableValidators);
  const passed = approvals >= requiredApprovals;
  const blocked = !passed;

  const partial: Omit<ConsensusValidationResult, 'report'> = {
    passed,
    blocked,
    verdict,
    promptType: input.promptType,
    requiredApprovals,
    approvals,
    usableValidators,
    totalValidators: judgments.length,
    judgments,
    issueClusters,
    scoreboard,
    claimConsensus,
    costUsd,
    generatedAt,
  };
  const report = renderReport(partial, input);
  const result: ConsensusValidationResult = { ...partial, report };

  log(
    `${VERDICT_ICON[verdict]} ${verdict} — ${approvals}/${usableValidators} approved ` +
      `(require ${requiredApprovals}); ${passed ? 'PASS' : 'BLOCK'}; ${realIssues} real issue(s)`
  );

  await persist(input, result, realIssues, options.storeResult ?? defaultStoreResult, log);
  return result;
}

/** Persist a result to Build Memory via the configured store (guarded). */
async function persist(
  input: ConsensusValidationInput,
  result: ConsensusValidationResult,
  realIssues: number,
  store: ConsensusResultStore,
  log: (m: string) => void
): Promise<void> {
  try {
    await store(
      {
        projectName: input.projectName ?? 'unknown',
        buildRunId: input.buildRunId ?? null,
        promptExecutionId: input.promptExecutionId ?? null,
        promptType: input.promptType,
        primaryProvider: input.primaryProvider,
        primaryModel: input.primaryModel ?? null,
        verdict: result.verdict,
        passed: result.passed,
        blocked: result.blocked,
        requiredApprovals: result.requiredApprovals,
        approvals: result.approvals,
        usableValidators: result.usableValidators,
        totalValidators: result.totalValidators,
        scoreboard: result.scoreboard,
        realIssues,
        claimConsensus: result.claimConsensus,
        costUsd: result.costUsd,
        generatedAt: result.generatedAt,
      },
      log
    );
  } catch (error) {
    log(`WARNING: consensus store threw (${describe(error)}) — ignored`);
  }
}

// ---------------------------------------------------------------------------
// Cross-build validator effectiveness (which validator catches the most real issues)
// ---------------------------------------------------------------------------

/** A provider's aggregated effectiveness across stored consensus runs. */
export interface ValidatorEffectiveness {
  provider: ProviderName;
  /** Consensus runs this provider participated in (usable). */
  runs: number;
  /** Total issues it raised. */
  issuesRaised: number;
  /** Total REAL (corroborated) issues it caught. */
  realIssuesCaught: number;
  /** realIssuesCaught / issuesRaised in [0, 1] (precision proxy). */
  precision: number;
}

/** Pull consensus-validator scoreboards out of stored telemetry events (guarded). */
export type ConsensusEventReader = (projectName?: string) => Promise<JsonObject[]>;

/** Default reader: read `production_telemetry` and keep only `consensus_validator` events. */
const defaultConsensusEventReader: ConsensusEventReader = async (projectName) => {
  try {
    const rows = projectName
      ? await BuildMemory.telemetry.getEventsByProject(projectName)
      : await BuildMemory.telemetry.getCriticalEvents();
    if (!rows) return [];
    return rows
      .map((r) => r.event_data)
      .filter(
        (d): d is JsonObject =>
          !!d && typeof d === 'object' && !Array.isArray(d) && (d as JsonObject).kind === 'consensus_validator'
      );
  } catch {
    return [];
  }
};

/**
 * Aggregate stored consensus scoreboards into a per-provider effectiveness ranking — the answer to
 * "which validator models catch the most real issues". NON-FATAL: returns [] when Build Memory is
 * unreachable. Pass a `projectName` to scope to one project (else only critical events are read; a
 * custom `read` can broaden this).
 */
export async function getValidatorEffectiveness(
  options: { projectName?: string; read?: ConsensusEventReader } = {}
): Promise<ValidatorEffectiveness[]> {
  const read = options.read ?? defaultConsensusEventReader;
  const events = await read(options.projectName);
  const acc = new Map<ProviderName, ValidatorEffectiveness>();
  for (const ev of events) {
    const board = ev.scoreboard;
    if (!Array.isArray(board)) continue;
    for (const entry of board) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      const provider = e.provider as ProviderName | undefined;
      if (!provider || e.usable === false) continue;
      const cur = acc.get(provider) ?? {
        provider,
        runs: 0,
        issuesRaised: 0,
        realIssuesCaught: 0,
        precision: 0,
      };
      cur.runs += 1;
      cur.issuesRaised += toInt(e.issuesRaised);
      cur.realIssuesCaught += toInt(e.realIssuesCaught);
      acc.set(provider, cur);
    }
  }
  const ranked = [...acc.values()].map((v) => ({
    ...v,
    precision: v.issuesRaised > 0 ? round4(v.realIssuesCaught / v.issuesRaised) : 0,
  }));
  // Most real issues first, then precision.
  ranked.sort((a, b) => b.realIssuesCaught - a.realIssuesCaught || b.precision - a.precision);
  return ranked;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A non-usable / empty judgment for an abstaining validator. */
function emptyJudgment(
  provider: ProviderName,
  model: string,
  usable: boolean,
  error: string
): ValidatorJudgment {
  return {
    provider,
    model,
    usable,
    approves: false,
    confidence: 0,
    issues: [],
    claimVerifications: [],
    summary: '',
    costUsd: 0,
    error,
  };
}

/** Round a dollar figure to 4 decimals. */
function round4(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 10000) / 10000;
}

/** Coerce an unknown to a non-negative integer. */
function toInt(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/** Render an unknown thrown value as a short string for logging. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default runConsensusValidation;
