/**
 * FORGE 2.0 — Consensus Proposal Engine unit test.
 *
 * Exercises the independent-proposals + peer-critique-round flow with NO network and NO real
 * providers: the proposer caller, the critique runner, the clock and the Build-Memory store are
 * all injected, so proposer recruitment, Stage 1 drafting, Stage 2 critique/ranking, winner
 * selection, and the non-fatal SKIP/BLOCK paths are verified deterministically in-process.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/consensus-proposal.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runConsensusProposal,
  selectProposers,
  DEFAULT_PROPOSER_ORDER,
  MIN_PROPOSALS,
  type ConsensusProposalInput,
  type ConsensusProposalOptions,
  type ProposalCallResult,
  type ConsensusProposalStoredRecord,
} from '../src/tools/consensus-proposal.js';
import type {
  ConsensusValidationInput,
  ConsensusValidationResult,
  ConsensusValidatorOptions,
} from '../src/tools/consensus-validator.js';
import type { ProviderName } from '../src/engine/provider-router.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const INPUT: ConsensusProposalInput = {
  taskPrompt: 'Design a rate limiter for the public API.',
  promptType: 'feature',
  projectName: 'test-project',
};

const noopLog = (_m: string): void => {};

/** A scripted proposer caller: provider → text (or null to simulate unreachable/empty). */
function makeProposerCaller(
  answers: Record<string, { text: string; costUsd?: number } | null>
): (provider: ProviderName, request: unknown) => Promise<ProposalCallResult | null> {
  return async (provider) => {
    const a = answers[provider];
    if (!a) return null;
    return {
      provider,
      model: `${provider}-model`,
      text: a.text,
      tokensInput: 10,
      tokensOutput: 20,
      costUsd: a.costUsd ?? 0.01,
    };
  };
}

/** Build a full, valid ConsensusValidationResult (the critique-round return shape) with overrides. */
function fakeCritique(overrides: Partial<ConsensusValidationResult> = {}): ConsensusValidationResult {
  return {
    passed: true,
    blocked: false,
    verdict: 'VALIDATED',
    promptType: 'feature',
    requiredApprovals: 2,
    approvals: 2,
    usableValidators: 2,
    totalValidators: 2,
    judgments: [],
    issueClusters: [],
    scoreboard: [],
    claimConsensus: [],
    costUsd: 0.02,
    report: '# fake critique report',
    generatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A scripted critique runner: keyed by the primaryProvider being critiqued. */
function makeCritiqueRunner(
  byProvider: Record<string, ConsensusValidationResult | 'throw'>
): (input: ConsensusValidationInput, options?: ConsensusValidatorOptions) => Promise<ConsensusValidationResult> {
  return async (input) => {
    const scripted = byProvider[input.primaryProvider];
    if (scripted === 'throw') throw new Error(`critique boom for ${input.primaryProvider}`);
    if (!scripted) throw new Error(`no script for ${input.primaryProvider}`);
    return scripted;
  };
}

function baseOptions(overrides: Partial<ConsensusProposalOptions> = {}): ConsensusProposalOptions {
  return {
    log: noopLog,
    now: () => '2026-01-01T00:00:00.000Z',
    storeResult: async () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Proposer selection
// ---------------------------------------------------------------------------

test('selectProposers recruits the default order, capped at the default count', () => {
  const picked = selectProposers({});
  assert.deepEqual(picked, DEFAULT_PROPOSER_ORDER.slice(0, 3));
});

test('selectProposers honors an explicit order and count, deduping', () => {
  const picked = selectProposers({
    proposerOrder: ['deepseek', 'deepseek', 'perplexity', 'anthropic'],
    proposerCount: 2,
  });
  assert.deepEqual(picked, ['deepseek', 'perplexity']);
});

// ---------------------------------------------------------------------------
// Stage 1 — SKIP when too few usable proposals
// ---------------------------------------------------------------------------

test('SKIPs (passed: true, winner: null) when fewer than MIN_PROPOSALS are usable', async () => {
  const callProposer = makeProposerCaller({ anthropic: { text: 'only one draft' }, openai: null, gemini: null });
  const stored: ConsensusProposalStoredRecord[] = [];
  const result = await runConsensusProposal(
    INPUT,
    baseOptions({
      callProposer,
      proposerOrder: ['anthropic', 'openai', 'gemini'],
      proposerCount: 3,
      storeResult: async (r) => {
        stored.push(r);
      },
    })
  );

  assert.equal(result.passed, true);
  assert.equal(result.blocked, false);
  assert.equal(result.winner, null);
  assert.equal(result.usableProposals, 1);
  assert.equal(result.proposalsDrafted, 3);
  assert.match(result.report, /SKIP/);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.passed, true);
});

// ---------------------------------------------------------------------------
// Full round — winner selection + ranking
// ---------------------------------------------------------------------------

test('drafts independently, critiques via peers, and crowns the best PASSING proposal', async () => {
  const callProposer = makeProposerCaller({
    anthropic: { text: 'anthropic draft', costUsd: 0.01 },
    openai: { text: 'openai draft', costUsd: 0.02 },
    gemini: { text: 'gemini draft', costUsd: 0.015 },
  });

  const runCritique = makeCritiqueRunner({
    // anthropic passes with a narrow margin.
    anthropic: fakeCritique({ passed: true, verdict: 'VALIDATED_WITH_CONCERNS', approvals: 1, requiredApprovals: 1, usableValidators: 2 }),
    // openai passes with a wider margin and no corroborated issues — should rank #1.
    openai: fakeCritique({ passed: true, verdict: 'VALIDATED', approvals: 2, requiredApprovals: 1, usableValidators: 2 }),
    // gemini fails outright.
    gemini: fakeCritique({ passed: false, blocked: true, verdict: 'FAILED', approvals: 0, requiredApprovals: 1, usableValidators: 2 }),
  });

  const stored: ConsensusProposalStoredRecord[] = [];
  const result = await runConsensusProposal(
    INPUT,
    baseOptions({
      callProposer,
      runCritique,
      proposerOrder: ['anthropic', 'openai', 'gemini'],
      proposerCount: 3,
      storeResult: async (r) => {
        stored.push(r);
      },
    })
  );

  assert.equal(result.passed, true);
  assert.equal(result.blocked, false);
  assert.equal(result.proposalsDrafted, 3);
  assert.equal(result.usableProposals, 3);
  assert.equal(result.critiquedProposals, 3);
  assert.equal(result.winner?.proposal.provider, 'openai');
  assert.equal(result.proposals[0]?.proposal.provider, 'openai');
  assert.equal(result.proposals[0]?.rank, 1);
  assert.equal(result.proposals.at(-1)?.proposal.provider, 'gemini');
  assert.ok(result.totalCostUsd > 0);
  assert.match(result.report, /openai/);

  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.winnerProvider, 'openai');
  assert.equal(stored[0]?.ranking.length, 3);
});

// ---------------------------------------------------------------------------
// Blocked path — evaluated, but nobody passed
// ---------------------------------------------------------------------------

test('blocks (passed: false, blocked: true) when every critiqued proposal fails', async () => {
  const callProposer = makeProposerCaller({
    anthropic: { text: 'a' },
    openai: { text: 'b' },
  });
  const runCritique = makeCritiqueRunner({
    anthropic: fakeCritique({ passed: false, blocked: true, verdict: 'FAILED', approvals: 0 }),
    openai: fakeCritique({ passed: false, blocked: true, verdict: 'FAILED', approvals: 0 }),
  });

  const result = await runConsensusProposal(
    INPUT,
    baseOptions({ callProposer, runCritique, proposerOrder: ['anthropic', 'openai'], proposerCount: 2 })
  );

  assert.equal(result.passed, false);
  assert.equal(result.blocked, true);
  assert.equal(result.winner, null);
  assert.equal(result.critiquedProposals, 2);
});

// ---------------------------------------------------------------------------
// Resilience — an unreachable proposer and a throwing critique never crash the round
// ---------------------------------------------------------------------------

test('excludes an unreachable proposer from usable drafts without throwing', async () => {
  const callProposer = makeProposerCaller({
    anthropic: { text: 'a' },
    openai: { text: 'b' },
    gemini: null, // unreachable
  });
  const runCritique = makeCritiqueRunner({
    anthropic: fakeCritique({ passed: true }),
    openai: fakeCritique({ passed: false, blocked: true, verdict: 'FAILED' }),
  });

  const result = await runConsensusProposal(
    INPUT,
    baseOptions({ callProposer, runCritique, proposerOrder: ['anthropic', 'openai', 'gemini'], proposerCount: 3 })
  );

  assert.equal(result.proposalsDrafted, 3);
  assert.equal(result.usableProposals, 2);
  const gem = result.proposals.find((p) => p.proposal.provider === 'gemini');
  assert.equal(gem, undefined);
  assert.equal(result.winner?.proposal.provider, 'anthropic');
});

test('drops a proposal whose critique throws, without failing the whole round', async () => {
  const callProposer = makeProposerCaller({
    anthropic: { text: 'a' },
    openai: { text: 'b' },
  });
  const runCritique = makeCritiqueRunner({
    anthropic: fakeCritique({ passed: true, verdict: 'VALIDATED' }),
    openai: 'throw',
  });

  const result = await runConsensusProposal(
    INPUT,
    baseOptions({ callProposer, runCritique, proposerOrder: ['anthropic', 'openai'], proposerCount: 2 })
  );

  assert.equal(result.usableProposals, 2);
  assert.equal(result.critiquedProposals, 1);
  assert.equal(result.winner?.proposal.provider, 'anthropic');
});

// ---------------------------------------------------------------------------
// MIN_PROPOSALS constant sanity
// ---------------------------------------------------------------------------

test('MIN_PROPOSALS is at least 2 (a "consensus" of one is not a consensus)', () => {
  assert.ok(MIN_PROPOSALS >= 2);
});
