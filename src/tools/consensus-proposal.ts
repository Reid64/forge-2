/**
 * FORGE 2.0 — Consensus Proposal Engine (independent proposals + peer critique round).
 *
 * {@link runConsensusValidation} (consensus-validator.ts) answers "does a SINGLE primary
 * generation hold up to independent cross-check?" This module answers a harder question up
 * front: "which of SEVERAL independently-drafted solutions should FORGE even generate from?" It
 * closes the anchoring gap a single-primary pipeline has — every downstream validator is judging
 * the ONE model that happened to go first, so a confident-but-wrong first draft can steer the
 * whole gate. Here nobody goes first: every proposer drafts blind, then every draft is put
 * through the SAME independent multi-model consensus panel used elsewhere in FORGE.
 *
 * HOW IT WORKS (two stages, non-fatal throughout — Iron Law 3):
 *   STAGE 1 — INDEPENDENT PROPOSALS: 2–3+ providers (default {@link DEFAULT_PROPOSER_ORDER},
 *     capped at {@link DEFAULT_PROPOSER_COUNT}) each receive ONLY the task prompt — never another
 *     provider's draft — and independently produce a complete, self-contained proposal. A
 *     provider that is unreachable or returns nothing simply produces no draft (never a false
 *     failure); fewer than {@link MIN_PROPOSALS} usable drafts SKIPs the round.
 *   STAGE 2 — CRITIQUE ROUND: each usable draft is run back through
 *     {@link runConsensusValidation} — the draft becomes the "generated output", its own author
 *     becomes the excluded `primaryProvider`, and the DEFAULT critique panel is the OTHER
 *     proposers (a true peer-review round: everyone who independently proposed also critiques
 *     everyone else's proposal). This reuses the existing issue-clustering, corroboration, and
 *     per-`prompt_type` requirement scoring wholesale rather than re-deriving it.
 *   RANKING: proposals are ordered by whether they PASSED their own critique's `prompt_type`
 *     requirement, then by approval margin, then by corroborated-issue severity (fewest/mildest
 *     first). The WINNER is the top-ranked proposal that actually passed — a proposal that merely
 *     ranks best among failures is never crowned a winner (Iron Law 2: never silently proceed on
 *     a generation that failed its own gate).
 *
 * PERPLEXITY: {@link DEFAULT_PROPOSER_ORDER} includes `perplexity` — the one provider in FORGE's
 * router with live web-search grounding — so a research-flavored proposal round can draft (and
 * critique) claims against the current web rather than training-data recall alone. See
 * provider-router.ts for the provider config and consensus-validator.ts for how the critique
 * panel additionally prioritizes `perplexity` when `researchClaims` are supplied.
 *
 * HOUSE RULES (mirrored from consensus-validator.ts and the rest of FORGE): NON-FATAL — always
 * resolves, never throws; every collaborator (the router, the proposal caller, the critique
 * runner, the Build-Memory writer, the clock) is INJECTABLE so this unit-tests with no network
 * and no database; no governance or target-project file is touched; secret values are never
 * logged.
 *
 * BOUNDARY: this module decides WHICH independently-drafted solution (if any) FORGE should carry
 * forward. It does not itself apply anything to a target project — the caller (a Phase 3 prompt
 * executor, or Sentinel via the optional `consensusProposal` check) decides what to do with
 * {@link ConsensusProposalResult.winner}.
 */

import {
  ProviderRouter,
  getProviderRouter,
  type ProviderName,
} from '../engine/provider-router.js';
import type { ModelRequest } from '../phases/phase1a-prd.js';
import {
  runConsensusValidation,
  makeRouterValidatorCaller,
  type ConsensusValidationInput,
  type ConsensusValidationResult,
  type ConsensusValidatorOptions,
  type ResearchClaim,
  type IssueSeverity,
  type ValidatorCaller,
  type ValidatorCallResult,
} from './consensus-validator.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import { logLine } from './forge-logger.js';
import type { Json, JsonObject, TelemetryEventType, TelemetrySeverity } from '../types/index.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default order in which providers are recruited as independent proposers. */
export const DEFAULT_PROPOSER_ORDER: readonly ProviderName[] = [
  'anthropic',
  'openai',
  'gemini',
  'deepseek',
  'perplexity',
];

/** Default number of independent proposals to draft. */
export const DEFAULT_PROPOSER_COUNT = 3;
/** Minimum usable proposals for a round to be meaningful (else SKIP — never a false block). */
export const MIN_PROPOSALS = 2;
/** Default max_tokens for one independent proposal. */
export const DEFAULT_PROPOSAL_MAX_TOKENS = 4000;

// ---------------------------------------------------------------------------
// Public contract — input + result
// ---------------------------------------------------------------------------

/** What to draft independent proposals for. */
export interface ConsensusProposalInput {
  /** The task every proposer independently solves (the requirements). */
  taskPrompt: string;
  /** The task's type — forwarded to the critique round's consensus requirement lookup. */
  promptType: string;
  /** Facts each proposal must address and each critique independently verifies (research mode). */
  researchClaims?: ResearchClaim[];
  /** Project name for the Build Memory record. Default 'unknown'. */
  projectName?: string;
  /** build_runs.id to associate the stored result with. */
  buildRunId?: string | null;
  /** prompt_executions.id to associate the stored result with. */
  promptExecutionId?: string | null;
}

/** One provider's independent draft (Stage 1). */
export interface ProposalDraft {
  provider: ProviderName;
  model: string;
  /** The provider's complete, self-contained proposal text. */
  text: string;
  /** Whether a usable proposal was produced (an unreachable/empty provider is excluded, not failed). */
  usable: boolean;
  costUsd: number;
  error?: string;
}

/** One proposal after Stage 2's peer critique round, ranked against its siblings. */
export interface CritiquedProposal {
  proposal: ProposalDraft;
  /** The full independent-panel critique of this proposal (its author is excluded from its own panel). */
  critique: ConsensusValidationResult;
  /** 1-based rank among critiqued proposals (best first). */
  rank: number;
}

/** The full result of one proposal + critique round. */
export interface ConsensusProposalResult {
  /** The AUTHORITATIVE gate result: some proposal passed its own critique's consensus requirement. */
  passed: boolean;
  /** Whether the gate BLOCKS (`!passed` AND at least one proposal was actually evaluated). */
  blocked: boolean;
  /** The prompt_type used for the critique round's requirement lookup. */
  promptType: string;
  /** Providers recruited to draft. */
  proposalsDrafted: number;
  /** Drafts that produced usable proposal text. */
  usableProposals: number;
  /** Usable proposals that received a critique (may be fewer than `usableProposals` if a critique errored). */
  critiquedProposals: number;
  /** The top-ranked PASSED proposal, or null when none passed (or none could be evaluated). */
  winner: CritiquedProposal | null;
  /** Every critiqued proposal, ranked best-first. */
  proposals: CritiquedProposal[];
  /** Total estimated USD cost across both stages. */
  totalCostUsd: number;
  /** Full markdown report. */
  report: string;
  /** ISO timestamp the result was produced. */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Public contract — injectable collaborators
// ---------------------------------------------------------------------------

/** The minimal result Stage 1 needs back from one proposer call. Identical shape to a validator call. */
export type ProposalCallResult = ValidatorCallResult;

/** Draft ONE proposal from a specific provider. Returns null when unreachable — never throws. */
export type ProposalCaller = ValidatorCaller;

/** The record handed to the Build-Memory store. */
export interface ConsensusProposalStoredRecord {
  projectName: string;
  buildRunId: string | null;
  promptExecutionId: string | null;
  promptType: string;
  proposalsDrafted: number;
  usableProposals: number;
  critiquedProposals: number;
  passed: boolean;
  blocked: boolean;
  winnerProvider: ProviderName | null;
  winnerModel: string | null;
  ranking: Array<{
    provider: ProviderName;
    rank: number;
    verdict: string;
    passed: boolean;
    approvals: number;
    requiredApprovals: number;
  }>;
  costUsd: number;
  generatedAt: string;
}

/** Persist a proposal-round result to Build Memory. Default: a guarded `production_telemetry` write. */
export type ConsensusProposalStore = (
  record: ConsensusProposalStoredRecord,
  log: (m: string) => void
) => Promise<void>;

/** Options controlling a proposal round — everything is injectable. */
export interface ConsensusProposalOptions {
  /** The provider router used for both stages. Default: the shared {@link getProviderRouter}. */
  router?: ProviderRouter;
  /** Explicit proposer providers. Default: derived from `proposerOrder`. */
  proposers?: ProviderName[];
  /** Recruitment order when `proposers` is not given. Default {@link DEFAULT_PROPOSER_ORDER}. */
  proposerOrder?: readonly ProviderName[];
  /** How many providers to recruit as proposers. Default {@link DEFAULT_PROPOSER_COUNT} (3). */
  proposerCount?: number;
  /** max_tokens for each proposal draft. Default {@link DEFAULT_PROPOSAL_MAX_TOKENS}. */
  maxTokens?: number;
  /** Override the per-provider proposal call (tests). Default: a router-backed caller. */
  callProposer?: ProposalCaller;
  /** Override the critique-round runner (tests). Default: {@link runConsensusValidation}. */
  runCritique?: (
    input: ConsensusValidationInput,
    options?: ConsensusValidatorOptions
  ) => Promise<ConsensusValidationResult>;
  /**
   * Options forwarded into EVERY per-proposal critique, merged over this module's peer-panel
   * defaults (`router` shared for one cost ledger; `validatorOrder` = the OTHER proposers;
   * `log` prefixed per-candidate). Set `validatorOrder`/`validatorProviders` here to critique
   * with a panel other than the proposers themselves (e.g. to always include Perplexity).
   */
  critiqueOptions?: ConsensusValidatorOptions;
  /** Override the Build-Memory writer (tests). Default: a guarded `production_telemetry` write. */
  storeResult?: ConsensusProposalStore;
  /** Clock for the `generatedAt` stamp. Default {@link nowIso}. */
  now?: () => string;
  /** Progress reporter. Default a `[FORGE:consensus-proposal]`-prefixed console line. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Proposer selection + prompt assembly
// ---------------------------------------------------------------------------

/** Recruit the proposer providers: the configured/derived order, deduped, capped at the count. */
export function selectProposers(
  options: Pick<ConsensusProposalOptions, 'proposers' | 'proposerOrder' | 'proposerCount'>
): ProviderName[] {
  const order = options.proposers ?? options.proposerOrder ?? DEFAULT_PROPOSER_ORDER;
  const count = options.proposerCount ?? DEFAULT_PROPOSER_COUNT;
  const seen = new Set<ProviderName>();
  const picked: ProviderName[] = [];
  for (const p of order) {
    if (seen.has(p)) continue;
    seen.add(p);
    picked.push(p);
    if (picked.length >= count) break;
  }
  return picked;
}

/** Truncate very large text so a single proposal call stays within budget. */
function clipForPrompt(text: string, max = 24000): string {
  const t = text ?? '';
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…[${t.length - max} chars truncated]`;
}

/** The system prompt that frames a proposer as independent and committed to one concrete answer. */
function buildProposerSystemPrompt(researchMode: boolean): string {
  const base =
    'You are one of several INDEPENDENT models being asked to solve the same task from scratch. ' +
    "You cannot see any other model's answer and must not assume one exists — produce your OWN " +
    'complete, self-contained solution to the TASK below. Do not hedge or present multiple options; ' +
    'commit to a single concrete proposal that fully satisfies the task. Your proposal will later be ' +
    'independently critiqued by other models, so be precise and avoid unsupported claims.';
  const research = researchMode
    ? ' Where you assert a fact (an opportunity\'s existence, an eligibility requirement, a deadline, ' +
      'a dollar amount), state it precisely — it will be independently fact-checked against each listed claim.'
    : '';
  return base + research;
}

/** Assemble the user message: the task, and any facts the proposal must address. */
function buildProposerUserPrompt(input: ConsensusProposalInput): string {
  const parts: string[] = [];
  parts.push(`PROMPT TYPE: ${input.promptType}`);
  parts.push('');
  parts.push('=== TASK ===');
  parts.push(clipForPrompt(input.taskPrompt));
  if (input.researchClaims && input.researchClaims.length > 0) {
    parts.push('');
    parts.push('=== FACTS YOUR PROPOSAL MUST ADDRESS ===');
    for (const c of input.researchClaims) {
      parts.push(`- [${c.id}] (${c.kind}) ${c.statement}`);
    }
  }
  parts.push('');
  parts.push('Produce your complete, self-contained proposal now.');
  return parts.join('\n');
}

/**
 * Build the default {@link ProposalCaller}: identical pinning behavior to
 * {@link makeRouterValidatorCaller} (call ONE specific provider through a sub-router sharing the
 * parent's usage ledger). Reused as-is — "pin this provider and call it" has nothing
 * validator-specific about it, so Stage 1 uses the very same helper Stage 2 uses per-validator.
 */
function defaultProposalCaller(router: ProviderRouter): ProposalCaller {
  return makeRouterValidatorCaller(router);
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHT: Record<IssueSeverity, number> = { critical: 4, high: 2, medium: 1, low: 0.5 };

/** Score one critique for ranking: passing beats failing; wider approval margin and fewer/milder corroborated issues rank higher. */
function scoreCritique(c: ConsensusValidationResult): number {
  const severityPenalty = c.issueClusters
    .filter((x) => x.corroborated)
    .reduce((sum, x) => sum + (SEVERITY_WEIGHT[x.severity] ?? 1), 0);
  const margin = c.approvals - c.requiredApprovals;
  return (c.passed ? 1000 : 0) + margin * 10 - severityPenalty;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function renderProposalReport(
  r: Omit<ConsensusProposalResult, 'report'>,
  drafts: ProposalDraft[]
): string {
  const lines: string[] = [];
  lines.push('# FORGE Consensus Proposal Engine — Report');
  lines.push('');
  lines.push(
    `- **Gate:** ${r.passed ? 'PASS ✅' : 'BLOCK ❌'} (${r.usableProposals}/${r.proposalsDrafted} proposal(s) drafted; ${r.critiquedProposals} critiqued)`
  );
  lines.push(
    `- **Winner:** ${
      r.winner
        ? `${r.winner.proposal.provider}${r.winner.proposal.model ? ` / ${r.winner.proposal.model}` : ''} (verdict ${r.winner.critique.verdict}, ${r.winner.critique.approvals}/${r.winner.critique.usableValidators} approved)`
        : 'none — no proposal met its consensus requirement'
    }`
  );
  lines.push(`- **Estimated cost:** $${r.totalCostUsd.toFixed(4)}`);
  lines.push('');

  lines.push('## Stage 1 — Independent Proposals');
  lines.push('');
  lines.push('| Provider | Model | Usable | Cost |');
  lines.push('|----------|-------|--------|------|');
  for (const d of drafts) {
    lines.push(
      `| ${d.provider} | ${d.model || '—'} | ${d.usable ? 'yes' : `NO (${d.error ?? 'unknown'})`} | $${d.costUsd.toFixed(4)} |`
    );
  }
  lines.push('');

  if (r.proposals.length > 0) {
    lines.push('## Stage 2 — Critique Round (ranked, best first)');
    lines.push('');
    lines.push('| Rank | Provider | Verdict | Approvals | Passed | Real Issues |');
    lines.push('|------|----------|---------|-----------|--------|-------------|');
    for (const c of r.proposals) {
      const realIssues = c.critique.issueClusters.filter((x) => x.corroborated).length;
      lines.push(
        `| ${c.rank} | ${c.proposal.provider} | ${c.critique.verdict} | ${c.critique.approvals}/${c.critique.usableValidators} | ${c.critique.passed ? 'yes' : 'no'} | ${realIssues} |`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Default Build-Memory store (production_telemetry, guarded — Contract 4)
// ---------------------------------------------------------------------------

async function defaultStoreProposalResult(
  record: ConsensusProposalStoredRecord,
  log: (m: string) => void
): Promise<void> {
  const eventType: TelemetryEventType = record.blocked ? 'error' : 'usage';
  const severity: TelemetrySeverity = record.blocked ? 'critical' : record.winnerProvider ? 'info' : 'warning';
  const eventData: JsonObject = {
    kind: 'consensus_proposal',
    promptType: record.promptType,
    proposalsDrafted: record.proposalsDrafted,
    usableProposals: record.usableProposals,
    critiquedProposals: record.critiquedProposals,
    passed: record.passed,
    blocked: record.blocked,
    winnerProvider: record.winnerProvider,
    winnerModel: record.winnerModel,
    ranking: record.ranking as unknown as Json,
    costUsd: record.costUsd,
    promptExecutionId: record.promptExecutionId,
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

/** Persist a result to Build Memory via the configured store (guarded). */
async function persist(
  input: ConsensusProposalInput,
  result: ConsensusProposalResult,
  store: ConsensusProposalStore,
  log: (m: string) => void
): Promise<void> {
  try {
    await store(
      {
        projectName: input.projectName ?? 'unknown',
        buildRunId: input.buildRunId ?? null,
        promptExecutionId: input.promptExecutionId ?? null,
        promptType: input.promptType,
        proposalsDrafted: result.proposalsDrafted,
        usableProposals: result.usableProposals,
        critiquedProposals: result.critiquedProposals,
        passed: result.passed,
        blocked: result.blocked,
        winnerProvider: result.winner?.proposal.provider ?? null,
        winnerModel: result.winner?.proposal.model ?? null,
        ranking: result.proposals.map((p) => ({
          provider: p.proposal.provider,
          rank: p.rank,
          verdict: p.critique.verdict,
          passed: p.critique.passed,
          approvals: p.critique.approvals,
          requiredApprovals: p.critique.requiredApprovals,
        })),
        costUsd: result.totalCostUsd,
        generatedAt: result.generatedAt,
      },
      log
    );
  } catch (error) {
    log(`WARNING: consensus-proposal store threw (${describe(error)}) — ignored`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point — runConsensusProposal
// ---------------------------------------------------------------------------

/**
 * Draft independent proposals from several providers, put each through the multi-model critique
 * panel (its peers), and return a ranked {@link ConsensusProposalResult}. NON-FATAL — always
 * resolves, never throws (Iron Law 3); fewer than {@link MIN_PROPOSALS} usable drafts yields
 * `passed: true` with a SKIP-style report (never a false block).
 */
export async function runConsensusProposal(
  input: ConsensusProposalInput,
  options: ConsensusProposalOptions = {}
): Promise<ConsensusProposalResult> {
  const log = options.log ?? logLine('consensus-proposal');
  const now = options.now ?? nowIso;
  const generatedAt = now();
  const router = options.router ?? getProviderRouter();
  const callProposer = options.callProposer ?? defaultProposalCaller(router);
  const maxTokens = options.maxTokens ?? DEFAULT_PROPOSAL_MAX_TOKENS;
  const claims = input.researchClaims ?? [];
  const researchMode = claims.length > 0;
  const storeResult = options.storeResult ?? defaultStoreProposalResult;

  const proposerList = selectProposers(options);
  log(
    `drafting ${input.promptType} proposals from [${proposerList.join(', ') || 'no eligible providers'}]` +
      `${researchMode ? ` (+${claims.length} claim(s) to address)` : ''}`
  );

  const system = buildProposerSystemPrompt(researchMode);
  const user = buildProposerUserPrompt(input);

  // Stage 1: draft every proposal concurrently; an unreachable/empty provider yields no draft.
  const drafts: ProposalDraft[] = await Promise.all(
    proposerList.map(async (provider): Promise<ProposalDraft> => {
      const request: ModelRequest = { model: '', maxTokens, system, user, apiKey: '' };
      let call: ProposalCallResult | null = null;
      try {
        call = await callProposer(provider, request);
      } catch (error) {
        log(`proposer ${provider} threw (${describe(error)}) — no proposal`);
        call = null;
      }
      if (call === null || call.text.trim() === '') {
        return {
          provider,
          model: call?.model ?? '',
          text: '',
          usable: false,
          costUsd: call?.costUsd ?? 0,
          error: 'proposer unreachable (no key / cooldown / network) or returned empty output',
        };
      }
      return { provider, model: call.model, text: call.text, usable: true, costUsd: call.costUsd };
    })
  );

  const usableDrafts = drafts.filter((d) => d.usable);
  const draftCost = round4(drafts.reduce((a, d) => a + (d.costUsd || 0), 0));

  // Too few usable proposals → SKIP semantics: never block the build on an unreachable panel.
  if (usableDrafts.length < MIN_PROPOSALS) {
    log(`only ${usableDrafts.length} usable proposal(s) (<${MIN_PROPOSALS}) — round not evaluated (pass-through)`);
    const skeleton: Omit<ConsensusProposalResult, 'report'> = {
      passed: true,
      blocked: false,
      promptType: input.promptType,
      proposalsDrafted: drafts.length,
      usableProposals: usableDrafts.length,
      critiquedProposals: 0,
      winner: null,
      proposals: [],
      totalCostUsd: draftCost,
      generatedAt,
    };
    const report =
      `# FORGE Consensus Proposal Engine — Report\n\n` +
      `- **Verdict:** ⊘ SKIP — only ${usableDrafts.length} of ${drafts.length} proposal(s) were usable ` +
      `(need ≥${MIN_PROPOSALS}). Round not evaluated; build not blocked.\n`;
    const result: ConsensusProposalResult = { ...skeleton, report };
    await persist(input, result, storeResult, log);
    return result;
  }

  // Stage 2: critique every usable draft concurrently — its own author excluded from its panel,
  // the DEFAULT panel being the OTHER proposers (a true peer-review round).
  const runCritique = options.runCritique ?? runConsensusValidation;
  const baseCritiqueOptions = options.critiqueOptions ?? {};
  const critiqued = (
    await Promise.all(
      usableDrafts.map(async (draft): Promise<CritiquedProposal | null> => {
        const cvInput: ConsensusValidationInput = {
          originalPrompt: input.taskPrompt,
          generatedOutput: draft.text,
          primaryProvider: draft.provider,
          primaryModel: draft.model,
          promptType: input.promptType,
          ...(claims.length > 0 ? { researchClaims: claims } : {}),
          projectName: input.projectName ?? 'unknown',
          buildRunId: input.buildRunId ?? null,
          promptExecutionId: input.promptExecutionId ?? null,
        };
        const cvOptions: ConsensusValidatorOptions = {
          router,
          validatorOrder: proposerList,
          ...baseCritiqueOptions,
          log: baseCritiqueOptions.log ?? ((m: string) => log(`critique[${draft.provider}]: ${m}`)),
        };
        try {
          const critique = await runCritique(cvInput, cvOptions);
          return { proposal: draft, critique, rank: 0 };
        } catch (error) {
          log(`critique of ${draft.provider}'s proposal threw (${describe(error)}) — proposal dropped`);
          return null;
        }
      })
    )
  ).filter((c): c is CritiquedProposal => c !== null);

  critiqued.sort((a, b) => scoreCritique(b.critique) - scoreCritique(a.critique));
  critiqued.forEach((c, i) => {
    c.rank = i + 1;
  });

  const totalCostUsd = round4(draftCost + critiqued.reduce((a, c) => a + (c.critique.costUsd || 0), 0));
  const winner = critiqued.find((c) => c.critique.passed) ?? null;
  const passed = winner !== null;
  const blocked = !passed && critiqued.length > 0;

  const partial: Omit<ConsensusProposalResult, 'report'> = {
    passed,
    blocked,
    promptType: input.promptType,
    proposalsDrafted: drafts.length,
    usableProposals: usableDrafts.length,
    critiquedProposals: critiqued.length,
    winner,
    proposals: critiqued,
    totalCostUsd,
    generatedAt,
  };
  const report = renderProposalReport(partial, drafts);
  const result: ConsensusProposalResult = { ...partial, report };

  log(
    winner
      ? `✅ winner: ${winner.proposal.provider} (verdict ${winner.critique.verdict}, ${winner.critique.approvals}/${winner.critique.usableValidators} approved)`
      : `❌ no proposal reached consensus (${critiqued.length} critiqued)`
  );

  await persist(input, result, storeResult, log);
  return result;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Round a dollar figure to 4 decimals. */
function round4(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 10000) / 10000;
}

/** Render an unknown thrown value as a short string for logging. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default runConsensusProposal;
