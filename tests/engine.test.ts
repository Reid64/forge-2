/**
 * FORGE 2.0 — Engine (Claude Runner + Prompt Assembler) unit test (Sprint 5, s5-p01).
 *
 * Both engine pieces are exercised in-process with NO database and NO `claude` install:
 *   - prompt-assembler is deterministic and its Build Memory warning fetch is injected,
 *     so it runs purely.
 *   - claude-runner is pointed at the local `node` binary (via `command`/`args`/`shell`
 *     overrides) instead of `claude`, so the spawn/stdin/capture/timeout machinery is
 *     verified without the real CLI.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/engine.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runClaude } from '../src/engine/claude-runner.js';
import {
  assemblePrompt,
  hashPrompt,
  STATE_AUDIT_FOOTER,
} from '../src/engine/prompt-assembler.js';
import { predictFailure, REWRITE_THRESHOLD } from '../src/engine/failure-predictor.js';
import { rewritePrompt } from '../src/engine/prompt-rewriter.js';
import {
  selectModel,
  selectModelForEntry,
  estimateModelCost,
  estimateModelCostFromBudget,
  ModelCostTracker,
  MODEL_PRICING,
} from '../src/engine/model-router.js';
import {
  GitManager,
  branchNameFor,
  checkpointTagFor,
  slugify,
  type ExecSyncFn,
} from '../src/engine/git-manager.js';
import type { QueueEntry } from '../src/engine/queue-generator.js';
import type { BuildRun, ErrorPattern, Resolution } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(): QueueEntry {
  return {
    id: 'schema-migrations',
    name: 'Database schema & migrations',
    prompt_type: 'schema',
    dependencies: [],
    governance_refs: ['SCHEMA_REGISTRY.md', 'BLUEPRINT.md'],
    estimated_tokens: 6000,
    context_injection: {
      schemaSections: ['projects'],
      behavioralSections: [],
      interactionMaps: [],
    },
    description: 'Create the database schema as migration files under supabase/migrations/.',
  };
}

const SCHEMA_DOC = [
  '# SCHEMA REGISTRY',
  '',
  '## Table: companies',
  'The tenant root table.',
  '',
  '## Table: projects',
  'Company projects.',
  '',
  '### Columns',
  '- id uuid pk',
  '- company_id uuid',
  '',
  '## Table: members',
  'Company members.',
].join('\n');

const BLUEPRINT_DOC = ['# BLUEPRINT', '', 'FORGE is a CLI tool.', '', '## Architecture', 'Details here.'].join('\n');

function makePattern(over: Partial<ErrorPattern>): ErrorPattern {
  return {
    id: 'p1',
    error_signature: 'supabase_rls_blocks',
    error_category: 'schema',
    error_message_sample: 'RLS policy blocked query',
    occurrence_count: 5,
    first_seen_at: '2026-01-01T00:00:00.000Z',
    last_seen_at: '2026-01-01T00:00:00.000Z',
    first_seen_project: 'forge-bootstrap',
    stack_fingerprints: [],
    trigger_phase: 'phase3',
    trigger_prompt_pattern: 'schema',
    resolution_id: null,
    prevention_rule: 'Test all RLS policies with seed data before building UI.',
    success_rate: 0.85,
    auto_resolve_eligible: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function makeBuild(stack: Record<string, string>): BuildRun {
  return {
    id: 'b1',
    project_name: 'demo',
    project_path: 'C:/demo',
    stack_fingerprint: stack,
    status: 'completed',
    started_at: null,
    completed_at: null,
    total_prompts: 0,
    completed_prompts: 0,
    failed_prompts: 0,
    total_errors: 0,
    total_tokens: 0,
    total_cost_usd: 0,
    machine_id: 'm1',
    toolchain_manifest: {},
    governance_hash: null,
    sentinel_interventions: 0,
    autonomous_recovery_mode: false,
    parallel_prompts_used: false,
    dry_run: false,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeResolution(over: Partial<Resolution>): Resolution {
  return {
    id: 'r1',
    error_pattern_id: 'p1',
    resolution_type: 'prompt_rewrite',
    resolution_description: 'Seed RLS test data before the UI is built.',
    resolution_steps: ['Insert seed rows scoped by company_id', 'Run the query as that company'],
    times_applied: 10,
    times_succeeded: 9,
    times_failed: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Prompt Assembler
// ---------------------------------------------------------------------------

test('assemblePrompt composes all four sources + mandatory footer, returns a stable hash', async () => {
  const result = await assemblePrompt(
    {
      entry: makeEntry(),
      governanceDocs: { 'SCHEMA_REGISTRY.md': SCHEMA_DOC, 'BLUEPRINT.md': BLUEPRINT_DOC },
      stackFingerprint: null,
      previousSentinel: { promptIndex: 1, promptName: 'prior', passed: true },
    },
    { fetchWarnings: async () => [makePattern({})], log: () => {} }
  );

  // 1. task description present.
  assert.match(result.prompt, /supabase\/migrations/);
  // 2. relevant governance excerpt: the matched "projects" table section is injected,
  //    and the non-matched "members" table is NOT.
  assert.match(result.prompt, /## Table: projects/);
  assert.match(result.prompt, /Company projects\./);
  assert.doesNotMatch(result.prompt, /Company members\./);
  // BLUEPRINT has no fine-grained markers → head overview fallback.
  assert.match(result.prompt, /FORGE is a CLI tool\./);
  assert.deepEqual(result.governanceDocsUsed.sort(), ['BLUEPRINT.md', 'SCHEMA_REGISTRY.md']);
  // 3. Build Memory warning injected.
  assert.match(result.prompt, /supabase_rls_blocks/);
  assert.match(result.prompt, /Test all RLS policies/);
  assert.equal(result.warningsInjected, 1);
  // 4. previous Sentinel status (passed).
  assert.match(result.prompt, /Previous Sentinel status/);
  assert.match(result.prompt, /PASSED all health checks/);
  // 5. mandatory footer, verbatim, at the very end.
  assert.ok(result.prompt.trimEnd().endsWith(STATE_AUDIT_FOOTER));

  // Hash is the SHA-256 of the prompt and is deterministic.
  assert.equal(result.hash, hashPrompt(result.prompt));
  assert.match(result.hash, /^[0-9a-f]{64}$/);

  // 6. Automatic model selection: a 'schema' prompt is architecture work → the architecture
  //    tier, which now routes to Sonnet (cost optimization — src/engine/model-router.ts:132,
  //    "was opus"), with a cost estimate.
  assert.equal(result.model, 'claude-sonnet-4-6');
  assert.equal(result.modelSelection.tier, 'architecture');
  assert.equal(result.modelSelection.isRecovery, false);
  assert.ok(result.estimatedCostUsd > 0, 'a non-empty prompt should have a positive cost estimate');

  const again = await assemblePrompt(
    {
      entry: makeEntry(),
      governanceDocs: { 'SCHEMA_REGISTRY.md': SCHEMA_DOC, 'BLUEPRINT.md': BLUEPRINT_DOC },
      stackFingerprint: null,
      previousSentinel: { promptIndex: 1, promptName: 'prior', passed: true },
    },
    { fetchWarnings: async () => [makePattern({})], log: () => {} }
  );
  assert.equal(again.hash, result.hash, 'same inputs must yield the same hash');
});

test('assemblePrompt notes missing governance, renders a failed Sentinel, and degrades on warning-fetch error', async () => {
  const result = await assemblePrompt(
    {
      entry: makeEntry(), // refs SCHEMA_REGISTRY.md + BLUEPRINT.md
      governanceDocs: { 'SCHEMA_REGISTRY.md': SCHEMA_DOC }, // BLUEPRINT.md absent
      previousSentinel: { passed: false, failures: ['tsc: 2 errors', 'build failed'] },
    },
    {
      fetchWarnings: async () => {
        throw new Error('db down');
      },
      log: () => {},
    }
  );

  assert.deepEqual(result.governanceDocsMissing, ['BLUEPRINT.md']);
  assert.match(result.prompt, /referenced governance not provided/);
  assert.match(result.prompt, /FAILED/);
  assert.match(result.prompt, /tsc: 2 errors/);
  // Warning fetch threw → zero warnings, never an exception.
  assert.equal(result.warningsInjected, 0);
  assert.ok(result.prompt.trimEnd().endsWith(STATE_AUDIT_FOOTER));
});

// ---------------------------------------------------------------------------
// Model Router
// ---------------------------------------------------------------------------

test('selectModel routes each prompt type to the correct tier/model', () => {
  // Architecture/design → the architecture tier, which routes to Sonnet (cost optimization).
  for (const t of ['schema', 'feature', 'agent'] as const) {
    const s = selectModel({ promptType: t });
    assert.equal(s.tier, 'architecture');
    assert.equal(s.model, 'claude-sonnet-4-6');
  }
  // Standard CRUD/boilerplate → Sonnet.
  for (const t of ['api', 'ui', 'auth', 'test'] as const) {
    const s = selectModel({ promptType: t });
    assert.equal(s.tier, 'standard');
    assert.equal(s.model, 'claude-sonnet-4-6');
  }
  // Simple/config → Haiku.
  const deploy = selectModel({ promptType: 'deploy' });
  assert.equal(deploy.tier, 'simple');
  assert.equal(deploy.model, 'claude-haiku-4-5-20251001');
});

test('selectModel: a recovery attempt forces the simple (Haiku) tier regardless of type', () => {
  const s = selectModel({ promptType: 'schema', isRecovery: true });
  assert.equal(s.isRecovery, true);
  assert.equal(s.tier, 'simple');
  assert.equal(s.model, 'claude-haiku-4-5-20251001');
  assert.match(s.reason, /Recovery/);
});

test('selectModelForEntry reads prompt_type; overrides are honored', () => {
  assert.equal(selectModelForEntry(makeEntry()).model, 'claude-sonnet-4-6');
  // Override the schema → tier mapping to standard.
  const overridden = selectModelForEntry(makeEntry(), { typeTier: { schema: 'standard' } });
  assert.equal(overridden.model, 'claude-sonnet-4-6');
});

test('estimateModelCost prices tokens against per-MTok rates and guards bad input', () => {
  // 1M input + 1M output on Sonnet = 3 + 15 = 18.
  assert.equal(estimateModelCost('claude-sonnet-4-6', 1_000_000, 1_000_000), 18);
  // Opus is pricier.
  assert.equal(estimateModelCost('claude-opus-4-6', 1_000_000, 0), MODEL_PRICING['claude-opus-4-6'].inputPerMTok);
  // Negative / NaN coerce to 0.
  assert.equal(estimateModelCost('claude-haiku-4-5-20251001', -5, Number.NaN), 0);
  // Budget split.
  const { inputTokens, outputTokens, costUsd } = estimateModelCostFromBudget('claude-sonnet-4-6', 1000, 0.5);
  assert.equal(inputTokens, 500);
  assert.equal(outputTokens, 500);
  assert.ok(costUsd > 0);
});

test('ModelCostTracker accumulates per model and across the build', () => {
  const tracker = new ModelCostTracker(() => {});
  tracker.record({ selection: selectModel({ promptType: 'schema' }), inputTokens: 1000, outputTokens: 2000, promptName: 'schema', promptIndex: 1 });
  tracker.record({ selection: selectModel({ promptType: 'api' }), inputTokens: 500, outputTokens: 500, promptName: 'api', promptIndex: 2 });
  tracker.record({ selection: selectModel({ promptType: 'schema', isRecovery: true }), inputTokens: 100, outputTokens: 100, promptName: 'recover', promptIndex: 3 });

  const summary = tracker.summary();
  assert.equal(summary.totalPrompts, 3);
  assert.equal(summary.totalInputTokens, 1600);
  assert.equal(summary.totalOutputTokens, 2600);
  assert.ok(summary.totalCostUsd > 0);
  // Two distinct models were used: sonnet (architecture tier 'schema' + standard tier 'api'
  // both route here — see src/engine/model-router.ts:132, "was opus") and haiku (recovery).
  assert.equal(summary.byModel.length, 2);
  const sonnet = summary.byModel.find((m) => m.model === 'claude-sonnet-4-6');
  assert.equal(sonnet?.prompts, 2);

  tracker.reset();
  assert.equal(tracker.summary().totalPrompts, 0);
});

test('assemblePrompt records the prompt cost into a supplied tracker', async () => {
  const tracker = new ModelCostTracker(() => {});
  await assemblePrompt(
    { entry: makeEntry(), governanceDocs: { 'SCHEMA_REGISTRY.md': SCHEMA_DOC }, stackFingerprint: null },
    { fetchWarnings: async () => [], log: () => {}, costTracker: tracker }
  );
  const summary = tracker.summary();
  assert.equal(summary.totalPrompts, 1);
  assert.equal(summary.byModel[0]?.model, 'claude-sonnet-4-6');
  assert.ok(summary.totalCostUsd > 0);
});

// ---------------------------------------------------------------------------
// Claude Runner (driven against `node` instead of the real `claude` CLI)
// ---------------------------------------------------------------------------

// A tiny Node program that echoes stdin to stdout, then exits 0.
const ECHO_SCRIPT =
  "let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{process.stdout.write(b);process.exit(0);});";
// A program that ignores stdin and never exits within the test window.
const HANG_SCRIPT = 'setInterval(()=>{},1000);';

test('runClaude pipes the prompt via stdin, captures stdout, and reports a clean exit', async () => {
  const prompt = 'hello forge';
  const result = await runClaude(prompt, {
    command: process.execPath,
    args: ['-e', ECHO_SCRIPT],
    shell: false,
    log: () => {},
  });

  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /hello forge/);
  assert.ok(result.durationMs >= 0);
  assert.ok(result.tokensEstimated > 0); // ≈ (prompt + stdout) / 4
});

test('runClaude kills a process that exceeds the timeout and reports failure', async () => {
  const result = await runClaude('ignored', {
    command: process.execPath,
    args: ['-e', HANG_SCRIPT],
    shell: false,
    timeoutMs: 250,
    log: () => {},
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.success, false);
});

test('runClaude reports a spawn failure instead of throwing', async () => {
  const result = await runClaude('x', {
    command: 'forge-nonexistent-binary-xyz',
    args: [],
    shell: false,
    log: () => {},
  });

  assert.equal(result.success, false);
  assert.equal(result.exitCode, null);
  assert.ok(result.stderr.length > 0);
});

// ---------------------------------------------------------------------------
// Failure Predictor
// ---------------------------------------------------------------------------

test('predictFailure computes occurrences / builds, scopes by stack, and recommends a rewrite', async () => {
  const result = await predictFailure(
    { promptType: 'schema', stackFingerprint: null, promptIndex: 3 },
    {
      // two matching patterns: 5 + 3 = 8 occurrences.
      fetchPatterns: async () => [
        makePattern({ id: 'p1', error_signature: 'supabase_rls_blocks', occurrence_count: 5 }),
        makePattern({ id: 'p2', error_signature: 'schema_drift', occurrence_count: 3 }),
      ],
      // 10 builds → 8 / 10 = 0.8.
      fetchBuilds: async () => Array.from({ length: 10 }, () => makeBuild({})),
      log: () => {},
    }
  );

  assert.equal(result.matchingOccurrences, 8);
  assert.equal(result.totalBuildsWithStack, 10);
  assert.ok(Math.abs(result.probability - 0.8) < 1e-9);
  assert.equal(result.shouldRewrite, true);
  assert.ok(result.probability > REWRITE_THRESHOLD);
  // patterns sorted most-frequent first.
  assert.equal(result.matchingPatterns[0]?.error_signature, 'supabase_rls_blocks');
  assert.match(result.recommendation, /Rewrite the prompt/);
});

test('predictFailure clamps to 1 and floors the denominator at 1 for a cold Build Memory', async () => {
  const result = await predictFailure(
    { promptType: 'auth' },
    {
      fetchPatterns: async () => [makePattern({ trigger_prompt_pattern: 'auth', occurrence_count: 4 })],
      fetchBuilds: async () => [], // no builds → denominator floors at 1 → 4/1 clamped to 1.
      log: () => {},
    }
  );

  assert.equal(result.totalBuildsWithStack, 0);
  assert.equal(result.probability, 1);
  assert.equal(result.shouldRewrite, true);
});

test('predictFailure filters patterns and builds by the stack fingerprint', async () => {
  const stack = {
    framework: 'nextjs',
    language: 'typescript',
    database: 'supabase',
    deployment: 'vercel',
    packageManager: 'pnpm',
    services: [],
    cliTools: [],
  };
  const result = await predictFailure(
    { promptType: 'schema', stackFingerprint: stack },
    {
      fetchPatterns: async () => [
        // matches: records a supabase fingerprint.
        makePattern({ id: 'p1', occurrence_count: 2, stack_fingerprints: [{ database: 'supabase' }] }),
        // excluded: records only a mongodb fingerprint.
        makePattern({ id: 'p2', occurrence_count: 9, stack_fingerprints: [{ database: 'mongodb' }] }),
      ],
      fetchBuilds: async () => [
        // matches every target scalar.
        makeBuild({
          framework: 'nextjs',
          language: 'typescript',
          database: 'supabase',
          deployment: 'vercel',
          packageManager: 'pnpm',
        }),
        // differs on framework/database/etc → excluded.
        makeBuild({
          framework: 'express',
          language: 'typescript',
          database: 'mongodb',
          deployment: 'docker',
          packageManager: 'npm',
        }),
      ],
      log: () => {},
    }
  );

  assert.equal(result.matchingPatterns.length, 1);
  assert.equal(result.matchingOccurrences, 2);
  assert.equal(result.totalBuildsWithStack, 1);
  assert.equal(result.probability, 1); // 2 occ / 1 build → clamped to 1
});

test('predictFailure degrades to probability 0 when no patterns match', async () => {
  const result = await predictFailure(
    { promptType: 'deploy' },
    { fetchPatterns: async () => [], fetchBuilds: async () => [makeBuild({})], log: () => {} }
  );
  assert.equal(result.probability, 0);
  assert.equal(result.shouldRewrite, false);
  assert.match(result.recommendation, /No matching error patterns/);
});

test('predictFailure never throws when a Build Memory read fails', async () => {
  const result = await predictFailure(
    { promptType: 'schema' },
    {
      fetchPatterns: async () => {
        throw new Error('db down');
      },
      fetchBuilds: async () => {
        throw new Error('db down');
      },
      log: () => {},
    }
  );
  assert.equal(result.probability, 0);
  assert.equal(result.matchingPatterns.length, 0);
});

// ---------------------------------------------------------------------------
// Prompt Rewriter
// ---------------------------------------------------------------------------

test('rewritePrompt preserves the original verbatim, prepends approach + prevention, and logs hashes', async () => {
  const original = [
    '# FORGE build task: schema',
    '',
    '## Task',
    'Create the database schema.',
    '',
    '## Governance (authoritative — follow exactly)',
    'SCHEMA_REGISTRY excerpt here.',
    '',
    STATE_AUDIT_FOOTER,
  ].join('\n');

  const result = await rewritePrompt(
    {
      prompt: original,
      promptType: 'schema',
      probability: 0.62,
      matchingPatterns: [
        makePattern({
          id: 'p1',
          error_signature: 'supabase_rls_blocks',
          occurrence_count: 5,
          prevention_rule: 'Test all RLS policies with seed data before building UI.',
        }),
      ],
    },
    {
      fetchResolution: async () => makeResolution({}),
      log: () => {},
    }
  );

  // Original preserved verbatim (the rewrite contains it unchanged) and the footer stays last.
  assert.ok(result.rewrittenPrompt.includes(original));
  assert.ok(result.rewrittenPrompt.trimEnd().endsWith(STATE_AUDIT_FOOTER));
  // Restructured approach + the matching pattern's prevention rule injected.
  assert.match(result.rewrittenPrompt, /Recommended approach/);
  assert.match(result.rewrittenPrompt, /Mandatory prevention rules/);
  assert.match(result.rewrittenPrompt, /Test all RLS policies/);
  // Precedent folded in (from the prompt_rewrite resolution).
  assert.match(result.rewrittenPrompt, /Seed RLS test data/);
  assert.equal(result.precedentsApplied, 1);
  assert.equal(result.preventionRulesInjected, 1);
  // Hashes: original matches the input; rewritten differs and is a SHA-256.
  assert.equal(result.originalHash, hashPrompt(original));
  assert.notEqual(result.rewrittenHash, result.originalHash);
  assert.match(result.rewrittenHash, /^[0-9a-f]{64}$/);
  assert.match(result.reason, /Contract 8/);
});

test('rewritePrompt applies the canonical approach even with no Build Memory precedents', async () => {
  const original = `## Task\nBuild the login flow.\n\n${STATE_AUDIT_FOOTER}`;
  const result = await rewritePrompt(
    { prompt: original, promptType: 'auth', matchingPatterns: [] },
    { fetchResolution: async () => null, log: () => {} }
  );

  assert.equal(result.precedentsApplied, 0);
  assert.equal(result.preventionRulesInjected, 0);
  // The canonical auth approach (Iron Law 4 /login fallback) is still present.
  assert.match(result.rewrittenPrompt, /\/login/);
  assert.ok(result.rewrittenPrompt.includes(original));
  assert.match(result.reason, /0 precedent\(s\)/);
});

test('rewritePrompt is deterministic — same inputs yield the same rewritten hash', async () => {
  const original = `## Task\nCreate API routes.\n\n${STATE_AUDIT_FOOTER}`;
  const opts = { fetchResolution: async () => null, log: () => {} };
  const a = await rewritePrompt({ prompt: original, promptType: 'api', matchingPatterns: [] }, opts);
  const b = await rewritePrompt({ prompt: original, promptType: 'api', matchingPatterns: [] }, opts);
  assert.equal(a.rewrittenHash, b.rewrittenHash);
});

// ---------------------------------------------------------------------------
// Git Manager (s5-p03) — driven via an INJECTED execImpl, so no real git/repo is needed.
// ---------------------------------------------------------------------------

/** A fake `execSync` that records every command string and delegates output to `handler`. */
function fakeExec(handler: (command: string) => string): { exec: ExecSyncFn; calls: string[] } {
  const calls: string[] = [];
  const exec: ExecSyncFn = (command) => {
    calls.push(command);
    return handler(command);
  };
  return { exec, calls };
}

test('branchNameFor / checkpointTagFor / slugify sanitise to git-ref-safe names', () => {
  assert.equal(slugify('Schema & Migrations!'), 'schema-migrations');
  assert.equal(slugify('   '), 'prompt');
  // spaces → dash, the forbidden `..` collapses to a single dot, edges trimmed.
  assert.equal(branchNameFor('b 1..2', 5, 'UI Layout'), 'forge/b-1.2/prompt-5-ui-layout');
  assert.equal(checkpointTagFor('build-9', 2), 'forge-checkpoint-build-9-2');
});

test('GitManager.createBranch creates+checks out the Contract-10 branch and never throws', () => {
  const { exec, calls } = fakeExec(() => '');
  const gm = new GitManager({ cwd: process.cwd(), execImpl: exec, log: () => {} });
  const r = gm.createBranch('build-123', 3, 'Schema & Migrations!');
  assert.equal(r.success, true);
  assert.equal(r.branchName, 'forge/build-123/prompt-3-schema-migrations');
  assert.match(calls[0] ?? '', /^git checkout -b forge\/build-123\/prompt-3-schema-migrations$/);
});

test('GitManager.commitAll stages all and commits via a temp -F message file (cleaned up)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-git-'));
  try {
    let messageFileExistedAtCommit = false;
    const { exec, calls } = fakeExec((command) => {
      if (command.includes('commit')) {
        messageFileExistedAtCommit = existsSync(join(dir, '.forge-commit-msg'));
      }
      return '';
    });
    const gm = new GitManager({ cwd: dir, execImpl: exec, log: () => {} });
    const r = gm.commitAll('multi\nline "quoted" message');
    assert.equal(r.success, true);
    assert.equal(r.nothingToCommit, false);
    assert.ok(calls.some((c) => c.startsWith('git add -A')));
    assert.ok(calls.some((c) => c.includes('commit -F')));
    assert.equal(messageFileExistedAtCommit, true);
    // The temp message file is always removed afterwards.
    assert.equal(existsSync(join(dir, '.forge-commit-msg')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GitManager.commitAll reports an empty index as a benign nothingToCommit success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-git-'));
  try {
    const { exec } = fakeExec((command) => {
      if (command.includes('commit')) {
        throw { status: 1, stdout: 'nothing to commit, working tree clean', stderr: '' };
      }
      return '';
    });
    const gm = new GitManager({ cwd: dir, execImpl: exec, log: () => {} });
    const r = gm.commitAll('msg');
    assert.equal(r.success, true);
    assert.equal(r.nothingToCommit, true);
    assert.equal(r.error, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GitManager.mergeToMain reads current branch, checks out main, merges --no-ff --no-edit', () => {
  const { exec, calls } = fakeExec((command) =>
    command.includes('rev-parse') ? 'forge/b/prompt-1-x\n' : ''
  );
  const gm = new GitManager({ cwd: process.cwd(), execImpl: exec, log: () => {} });
  const r = gm.mergeToMain();
  assert.equal(r.success, true);
  assert.equal(r.mergedBranch, 'forge/b/prompt-1-x');
  assert.equal(r.targetBranch, 'main');
  assert.ok(calls.some((c) => c === 'git checkout main'));
  assert.ok(calls.some((c) => c === 'git merge --no-ff --no-edit forge/b/prompt-1-x'));
});

test('GitManager.rollbackToCheckpoint checks out main then hard-resets to the tag', () => {
  const tag = checkpointTagFor('build-1', 4);
  const { exec, calls } = fakeExec(() => '');
  const gm = new GitManager({ cwd: process.cwd(), execImpl: exec, log: () => {} });
  const r = gm.rollbackToCheckpoint(tag);
  assert.equal(r.success, true);
  assert.equal(r.tag, tag);
  assert.ok(calls.some((c) => c === 'git checkout main'));
  assert.ok(calls.some((c) => c === `git reset --hard ${tag}`));
});

test('GitManager captures a git failure as success:false (never throws — Iron Law 3)', () => {
  const { exec } = fakeExec(() => {
    throw { status: 128, stdout: '', stderr: 'fatal: not a git repository' };
  });
  const gm = new GitManager({ cwd: process.cwd(), execImpl: exec, log: () => {} });
  const r = gm.getCurrentBranch();
  assert.equal(r.success, false);
  assert.equal(r.branch, null);
  assert.equal(r.exitCode, 128);
  assert.match(r.error ?? '', /not a git repository/);
});

test('GitManager.getBranchDiff parses --name-status output including renames', () => {
  const out = 'M\tsrc/a.ts\nA\tsrc/b.ts\nR100\tsrc/old.ts\tsrc/new.ts\n';
  const { exec, calls } = fakeExec((command) => (command.includes('diff') ? out : ''));
  const gm = new GitManager({ cwd: process.cwd(), execImpl: exec, log: () => {} });
  const r = gm.getBranchDiff();
  assert.equal(r.success, true);
  assert.deepEqual(r.files, [
    { status: 'M', path: 'src/a.ts' },
    { status: 'A', path: 'src/b.ts' },
    { status: 'R100', path: 'src/new.ts', oldPath: 'src/old.ts' },
  ]);
  assert.ok((calls[0] ?? '').includes('diff --name-status main...HEAD'));
});
