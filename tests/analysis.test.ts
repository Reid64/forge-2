/**
 * FORGE 2.0 — Pattern Extractor unit test (Sprint 6, s6-p01).
 *
 * The extractor's analysis is PURE and deterministic (no model calls), and every Build Memory
 * read/write is injectable — so this suite exercises it entirely in-process against hand-built
 * `BuildRun` + `PromptExecution` fixtures with recording stub writers. It does NOT require the
 * Docker Supabase stack, `claude`, or git.
 *
 * It asserts the s6-p01 contract:
 *   1. ERROR patterns — errored prompts grouped by NORMALIZED signature (paths/lines stripped),
 *      with occurrence count, category, trigger prompt types + index range.
 *   2. TIMING patterns — per-type average/median/std-dev, and the complexity↔time correlation.
 *   3. SUCCESS patterns — per-type success rate + the rewrite improvement; governance correlation.
 *   4. COST patterns — per-type token/dollar averages + the build-cost-by-complexity summary.
 *   5. STORAGE — error_patterns create-or-increment (Contract 15) + cross_project_insights writes,
 *      and stateless degrade when Build Memory is unreachable (Contract 4).
 *   6. classifyPromptType — recovers prompt_type from the Queue Generator's prompt names.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/analysis.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzePatterns,
  extractPatterns,
  classifyPromptType,
  type ExtractPatternsInput,
} from '../src/analysis/pattern-extractor.js';
import { analyzeTemplates, evolveTemplates } from '../src/analysis/template-evolver.js';
import { estimateBuildCost, derivePromptCounts } from '../src/analysis/cost-estimator.js';
import type { NewErrorPattern } from '../src/memory/errors.js';
import type { NewCrossProjectInsight } from '../src/memory/insights.js';
import type { NewGovernanceVersion } from '../src/memory/governance.js';
import type {
  BuildRun,
  ErrorPattern,
  GovernanceVersion,
  PromptExecution,
} from '../src/types/index.js';
import type { QueueEntry } from '../src/engine/queue-generator.js';
import type {
  FailurePrediction,
  FailurePredictionInput,
} from '../src/engine/failure-predictor.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;
function pe(over: Partial<PromptExecution> = {}): PromptExecution {
  seq += 1;
  const base: PromptExecution = {
    id: `pe-${seq}`,
    build_run_id: 'build-1',
    prompt_index: seq,
    prompt_name: 'Feature: thing',
    prompt_hash: 'h',
    prompt_content: 'content',
    status: 'completed',
    started_at: null,
    completed_at: null,
    tokens_input: 0,
    tokens_output: 0,
    cost_usd: 0,
    error_output: null,
    resolution_applied: null,
    was_rewritten: false,
    original_prompt_hash: null,
    rewrite_reason: null,
    failure_prediction_score: null,
    branch_name: null,
    sentinel_passed: null,
    sentinel_details: null,
    files_created: [],
    files_modified: [],
    files_deleted: [],
    created_at: '2026-06-11T00:00:00.000Z',
  };
  return { ...base, ...over };
}

function makeBuild(over: Partial<BuildRun> = {}): BuildRun {
  return {
    id: 'build-1',
    project_name: 'acme',
    project_path: '/tmp/acme',
    stack_fingerprint: { framework: 'nextjs', language: 'typescript' },
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
    created_at: '2026-06-11T00:00:00.000Z',
    ...over,
  };
}

/** Two ISO timestamps `ms` apart (for a measurable duration). */
function span(ms: number): { started_at: string; completed_at: string } {
  const start = Date.parse('2026-06-11T00:00:00.000Z');
  return {
    started_at: new Date(start).toISOString(),
    completed_at: new Date(start + ms).toISOString(),
  };
}

const input: ExtractPatternsInput = { buildRunId: 'build-1' };

// ---------------------------------------------------------------------------
// 1. Error patterns — normalized-signature grouping (Contract 15)
// ---------------------------------------------------------------------------

test('error patterns group by normalized signature across differing paths/lines', () => {
  const executions = [
    pe({
      prompt_index: 3,
      prompt_name: 'API: users',
      status: 'failed',
      error_output: "Type error in C:\\proj\\a.ts:10:5: Type 'X' is not assignable to type 'Y'.",
    }),
    pe({
      prompt_index: 5,
      prompt_name: 'API: orders',
      status: 'failed',
      error_output: "Type error in C:\\proj\\b.ts:22:9: Type 'Q' is not assignable to type 'Y'.",
    }),
    pe({ prompt_index: 1, prompt_name: 'Database schema & migrations', status: 'completed' }),
  ];

  const patterns = analyzePatterns(makeBuild(), executions, input);
  assert.equal(patterns.error_patterns.length, 1, 'the two type errors share one normalized signature');
  const ep = patterns.error_patterns[0];
  assert.ok(ep);
  assert.equal(ep.occurrenceCount, 2);
  assert.equal(ep.errorCategory, 'type_error');
  assert.deepEqual(ep.triggerPromptTypes, ['api']);
  assert.deepEqual(ep.triggerPromptIndexRange, { min: 3, max: 5 });
  assert.equal(ep.triggerPhase, 'phase3');
  assert.equal(ep.occurrenceRateByStack.length, 1);
  assert.equal(ep.occurrenceRateByStack[0]?.occurrences, 2);
  // 2 errored of 3 analyzed prompts.
  assert.equal(ep.occurrenceRateByStack[0]?.rate, 0.6667);
});

// ---------------------------------------------------------------------------
// 2. Timing patterns — per-type stats + complexity↔time correlation
// ---------------------------------------------------------------------------

test('timing patterns compute per-type stats and a positive complexity/time correlation', () => {
  const executions = [
    pe({ prompt_name: 'API: a', prompt_content: 'x'.repeat(100), ...span(200) }),
    pe({ prompt_name: 'API: b', prompt_content: 'x'.repeat(1000), ...span(2000) }),
  ];
  const patterns = analyzePatterns(makeBuild(), executions, input);
  const api = patterns.timing_patterns.find((t) => t.promptType === 'api');
  assert.ok(api, 'an api timing finding exists');
  assert.equal(api.sampleCount, 2);
  assert.equal(api.averageMs, 1100);
  assert.equal(api.medianMs, 1100);
  assert.equal(api.minMs, 200);
  assert.equal(api.maxMs, 2000);
  // longer prompt → longer time → perfect positive correlation across two points.
  assert.equal(api.complexityTimeCorrelation, 1);
  assert.ok(Array.isArray(api.outliers));
});

test('timing patterns flag a high outlier beyond mean + 2σ', () => {
  const executions: PromptExecution[] = [];
  for (let i = 0; i < 9; i++) executions.push(pe({ prompt_name: 'API: normal', ...span(100) }));
  executions.push(pe({ prompt_index: 99, prompt_name: 'API: spike', ...span(1000) }));
  const patterns = analyzePatterns(makeBuild(), executions, input);
  const api = patterns.timing_patterns.find((t) => t.promptType === 'api');
  assert.ok(api);
  assert.equal(api.sampleCount, 10);
  assert.equal(api.outliers.length, 1);
  assert.equal(api.outliers[0]?.promptIndex, 99);
  assert.equal(api.outliers[0]?.durationMs, 1000);
});

// ---------------------------------------------------------------------------
// 3. Success patterns — per-type success rate + rewrite improvement + governance
// ---------------------------------------------------------------------------

test('success patterns compute success rate and the rewrite improvement', () => {
  const executions = [
    pe({ prompt_name: 'API: a', status: 'completed', was_rewritten: true }),
    pe({ prompt_name: 'API: b', status: 'failed', was_rewritten: true, error_output: 'boom' }),
    pe({ prompt_name: 'API: c', status: 'failed', was_rewritten: false, error_output: 'boom' }),
    pe({ prompt_name: 'API: d', status: 'failed', was_rewritten: false, error_output: 'boom' }),
  ];
  const patterns = analyzePatterns(makeBuild(), executions, input);
  const api = patterns.success_patterns.find((s) => s.promptType === 'api');
  assert.ok(api);
  assert.equal(api.total, 4);
  assert.equal(api.succeeded, 1);
  assert.equal(api.successRate, 0.25);
  assert.equal(api.rewrite.rewrittenSuccessRate, 0.5);
  assert.equal(api.rewrite.nonRewrittenSuccessRate, 0);
  assert.equal(api.rewrite.improvement, 0.5);
});

test('governance correlation compares error rate with vs without an injected doc', () => {
  const executions = [
    // Schema prompts that referenced SCHEMA_REGISTRY.md and all succeeded.
    pe({ prompt_name: 'Database schema & migrations', prompt_content: 'see SCHEMA_REGISTRY.md', status: 'completed' }),
    pe({ prompt_name: 'API: x', prompt_content: 'see SCHEMA_REGISTRY.md', status: 'completed' }),
    // Prompts that did NOT reference it and erred.
    pe({ prompt_name: 'UI shell, layouts & design tokens', prompt_content: 'no ref', status: 'failed', error_output: 'boom' }),
    pe({ prompt_name: 'Deploy to production', prompt_content: 'no ref', status: 'failed', error_output: 'boom' }),
  ];
  const patterns = analyzePatterns(makeBuild(), executions, input);
  const gov = patterns.governance_correlations.find((g) => g.governanceDoc === 'SCHEMA_REGISTRY.md');
  assert.ok(gov);
  assert.equal(gov.withDocTotal, 2);
  assert.equal(gov.withDocErrorRate, 0);
  assert.equal(gov.withoutDocTotal, 2);
  assert.equal(gov.withoutDocErrorRate, 1);
  assert.equal(gov.errorRateDelta, 1);
});

// ---------------------------------------------------------------------------
// 4. Cost patterns — per-type averages + build-cost-by-complexity
// ---------------------------------------------------------------------------

test('cost patterns average tokens/cost per type and summarize build cost by complexity', () => {
  const executions = [
    pe({ prompt_name: 'API: a', tokens_input: 1000, tokens_output: 500, cost_usd: 0.1 }),
    pe({ prompt_name: 'API: b', tokens_input: 3000, tokens_output: 1500, cost_usd: 0.3 }),
    pe({ prompt_name: 'Feature: dashboard widget', tokens_input: 2000, tokens_output: 1000, cost_usd: 0.2 }),
  ];
  const entries: QueueEntry[] = [
    {
      id: 'schema-migrations',
      name: 'Database schema & migrations',
      prompt_type: 'schema',
      dependencies: [],
      governance_refs: [],
      estimated_tokens: 0,
      context_injection: { schemaSections: ['companies', 'projects', 'tasks'], behavioralSections: [], interactionMaps: [] },
      description: '',
    },
  ];
  const patterns = analyzePatterns(makeBuild(), executions, { ...input, entries });

  const apiCost = patterns.cost_patterns.find((c) => c.promptType === 'api');
  assert.ok(apiCost);
  assert.equal(apiCost.sampleCount, 2);
  assert.equal(apiCost.averageTokens, 3000); // (1500 + 4500) / 2
  assert.equal(apiCost.averageCostUsd, 0.2);
  assert.equal(apiCost.totalCostUsd, 0.4);

  assert.equal(patterns.build_cost.complexity.tableCount, 3);
  assert.equal(patterns.build_cost.complexity.featureCount, 1);
  assert.equal(patterns.build_cost.complexity.apiCount, 2);
  assert.equal(patterns.build_cost.totalCostUsd, 0.6);
  assert.equal(patterns.build_cost.costPerTable, 0.2);
  assert.equal(patterns.build_cost.costPerFeature, 0.6);
});

// ---------------------------------------------------------------------------
// 5. Storage — create-or-increment error_patterns + insights; stateless degrade
// ---------------------------------------------------------------------------

test('extractPatterns stores a NEW error pattern and the dimension insights', async () => {
  const created: NewErrorPattern[] = [];
  const insights: NewCrossProjectInsight[] = [];
  const updated: string[] = [];

  const executions = [
    pe({ prompt_name: 'API: a', status: 'failed', error_output: 'Cannot find module foo', ...span(100), tokens_output: 10 }),
    pe({ prompt_name: 'API: b', status: 'completed', ...span(120), tokens_output: 12 }),
  ];

  const result = await extractPatterns(
    { buildRunId: 'build-1', build: makeBuild(), executions },
    {
      findMatchingPattern: async () => null, // signature not seen before → create
      createErrorPattern: async (i) => {
        created.push(i);
        return { id: 'new-pat' } as ErrorPattern;
      },
      updateOccurrenceCount: async (id) => {
        updated.push(id);
        return { id } as ErrorPattern;
      },
      createInsight: async (i) => {
        insights.push(i);
        return { id: `ins-${insights.length}` } as never;
      },
      log: () => {},
    }
  );

  assert.equal(created.length, 1, 'one new error pattern created');
  assert.equal(created[0]?.error_signature, 'cannot find module foo');
  assert.equal(created[0]?.error_category, 'dependency');
  assert.equal(created[0]?.first_seen_project, 'acme');
  assert.equal(updated.length, 0, 'no increment when the signature is new');
  assert.ok(insights.length >= 2, 'timing/success/cost insights stored');
  assert.equal(result.storage.errorPatternsCreated, 1);
  assert.equal(result.storage.stateless, false);
});

test('extractPatterns increments an EXISTING error pattern (Contract 15)', async () => {
  const updated: string[] = [];
  const executions = [
    pe({ prompt_name: 'API: a', status: 'failed', error_output: 'Cannot find module foo', ...span(100) }),
  ];
  await extractPatterns(
    { buildRunId: 'build-1', build: makeBuild(), executions, entries: [] },
    {
      findMatchingPattern: async () => ({ id: 'existing-pat' } as ErrorPattern),
      createErrorPattern: async () => {
        throw new Error('should not create when a match exists');
      },
      updateOccurrenceCount: async (id) => {
        updated.push(id);
        return { id } as ErrorPattern;
      },
      createInsight: async () => ({ id: 'x' } as never),
      log: () => {},
    }
  );
  assert.deepEqual(updated, ['existing-pat']);
});

test('extractPatterns degrades to stateless when Build Memory is unreachable', async () => {
  const executions = [
    pe({ prompt_name: 'API: a', status: 'failed', error_output: 'boom', ...span(100) }),
  ];
  const result = await extractPatterns(
    { buildRunId: 'build-1', build: makeBuild(), executions },
    {
      findMatchingPattern: async () => null,
      createErrorPattern: async () => null, // all writes fail → unreachable
      updateOccurrenceCount: async () => null,
      createInsight: async () => null,
      log: () => {},
    }
  );
  assert.equal(result.storage.stateless, true);
  assert.equal(result.storage.errorPatternsCreated, 0);
  assert.equal(result.storage.insightsCreated, 0);
  // The analysis itself still succeeded.
  assert.ok(result.patterns.error_patterns.length >= 1);
});

test('extractPatterns with store:false analyzes without any Build Memory writes', async () => {
  let wrote = false;
  const result = await extractPatterns(
    { buildRunId: 'build-1', build: makeBuild(), executions: [pe({ prompt_name: 'API: a', ...span(50) })] },
    {
      store: false,
      createErrorPattern: async () => {
        wrote = true;
        return null;
      },
      createInsight: async () => {
        wrote = true;
        return null;
      },
      log: () => {},
    }
  );
  assert.equal(wrote, false);
  assert.equal(result.storage.insightsCreated, 0);
  assert.ok(result.patterns.timing_patterns.length >= 1);
});

// ---------------------------------------------------------------------------
// 6. classifyPromptType — recover prompt_type from Queue Generator names
// ---------------------------------------------------------------------------

test('classifyPromptType recovers the prompt type from the queue-generator names', () => {
  assert.equal(classifyPromptType('Database schema & migrations'), 'schema');
  assert.equal(classifyPromptType('Authentication & authorization'), 'auth');
  assert.equal(classifyPromptType('API: users (3 routes)'), 'api');
  assert.equal(classifyPromptType('UI shell, layouts & design tokens'), 'ui');
  assert.equal(classifyPromptType('Agent: reminder-bot'), 'agent');
  assert.equal(classifyPromptType('End-to-end (Playwright) tests'), 'test');
  assert.equal(classifyPromptType('Six Laws verification'), 'test');
  assert.equal(classifyPromptType('Deploy to production'), 'deploy');
  assert.equal(classifyPromptType('Feature: Task board'), 'feature');
  assert.equal(classifyPromptType('Dashboard: Overview'), 'feature');
  assert.equal(classifyPromptType('something unrecognized'), 'feature');
});

// ---------------------------------------------------------------------------
// 7. Empty build — no executions still yields a valid report + a warning
// ---------------------------------------------------------------------------

test('an empty build yields a valid, warned report and stores nothing', async () => {
  const result = await extractPatterns(
    { buildRunId: 'build-1', build: makeBuild(), executions: [] },
    {
      findMatchingPattern: async () => null,
      createErrorPattern: async () => null,
      updateOccurrenceCount: async () => null,
      createInsight: async () => null,
      log: () => {},
    }
  );
  assert.equal(result.patterns.analyzedPrompts, 0);
  assert.equal(result.patterns.error_patterns.length, 0);
  assert.ok(result.patterns.warnings.some((w) => w.includes('No prompt_executions')));
  assert.equal(result.storage.stateless, false, 'nothing to store ≠ unreachable');
});

// ===========================================================================
// TEMPLATE EVOLVER (s6-p02)
// ===========================================================================

let gseq = 0;
function gv(over: Partial<GovernanceVersion> = {}): GovernanceVersion {
  gseq += 1;
  const base: GovernanceVersion = {
    id: `gv-${gseq}`,
    template_name: 'BLUEPRINT.md',
    version_number: 1,
    content_hash: 'h',
    content_snapshot: '# Doc\n\n## Section A\nbody\n',
    changes_description: null,
    change_source: 'manual',
    effectiveness_score: null,
    builds_used_in: 0,
    created_at: '2026-06-11T00:00:00.000Z',
  };
  return { ...base, ...over };
}

test('template evolver flags declining effectiveness + correlates build success', async () => {
  const versions: GovernanceVersion[] = [
    gv({
      template_name: 'BLUEPRINT.md',
      version_number: 1,
      effectiveness_score: 0.9,
      builds_used_in: 1,
      content_snapshot: '# B\n\n## Architecture\nv1\n',
    }),
    gv({
      template_name: 'BLUEPRINT.md',
      version_number: 2,
      effectiveness_score: 0.6,
      builds_used_in: 5,
      content_snapshot: '# B\n\n## Architecture\nv2\n',
    }),
  ];
  const builds: BuildRun[] = [
    makeBuild({ status: 'completed', total_prompts: 10, completed_prompts: 9 }),
    makeBuild({ id: 'b2', status: 'failed', total_prompts: 10, completed_prompts: 4 }),
  ];
  const executions: PromptExecution[] = [
    pe({ prompt_content: 'Build per BLUEPRINT.md — the ## Architecture section governs this.' }),
  ];

  const report = analyzeTemplates(versions, builds, executions);
  const trend = report.trends.find((t) => t.templateName === 'BLUEPRINT.md');
  assert.ok(trend && trend.declining, 'BLUEPRINT trend should be declining');
  assert.equal(trend?.lastDelta, -0.3);
  assert.equal(trend?.bestScore, 0.9);
  assert.equal(report.correlation.buildSuccessRate, 0.5);
  assert.equal(report.correlation.promptSuccessRate, 0.65);
  // score↓ while adoption↑ ⇒ negative effectiveness↔adoption correlation.
  assert.ok((report.correlation.effectivenessAdoptionCorrelation ?? 0) < 0);

  const decline = report.proposals.find((p) => p.kind === 'declining_effectiveness');
  assert.ok(decline, 'a declining proposal should be generated');
  assert.equal(decline?.expectedImprovement, 0.3, 'recover to the best score');
  assert.ok(decline?.newText.includes('<!-- FORGE recursive_learner'));

  // Storage: persisted as a recursive_learner version (Contract 16).
  let captured: NewGovernanceVersion | null = null;
  const result = await evolveTemplates(
    { versions, builds, executions },
    {
      createVersion: async (i) => {
        captured = i;
        return gv();
      },
      log: () => {},
    }
  );
  assert.equal(result.storage.proposalsStored >= 1, true);
  assert.ok(captured, 'createVersion should be called');
  assert.equal((captured as unknown as NewGovernanceVersion).change_source, 'recursive_learner');
  assert.equal((captured as unknown as NewGovernanceVersion).version_number, 3);
  assert.ok(
    ((captured as unknown as NewGovernanceVersion).changes_description ?? '').startsWith('PROPOSED')
  );
});

test('template evolver flags an unreferenced section', () => {
  const versions: GovernanceVersion[] = [
    gv({
      template_name: 'SCHEMA_REGISTRY.md',
      version_number: 1,
      content_snapshot: '# Schema\n\n## Telemetry Receiver\nbody1\n\n## Orphan Widgets\nbody2\n',
    }),
  ];
  // The prompt injects SCHEMA_REGISTRY.md + the Telemetry Receiver section, never Orphan Widgets.
  const executions: PromptExecution[] = [
    pe({ prompt_content: 'Context: SCHEMA_REGISTRY.md → Telemetry Receiver columns.' }),
  ];

  const report = analyzeTemplates(versions, [], executions);
  const orphan = report.references.find((r) => r.section === 'Orphan Widgets');
  assert.ok(orphan && orphan.unreferenced, 'Orphan Widgets should be unreferenced');
  const used = report.references.find((r) => r.section === 'Telemetry Receiver');
  assert.equal(used?.unreferenced, false);

  const proposal = report.proposals.find(
    (p) => p.kind === 'unreferenced_section' && p.section === 'Orphan Widgets'
  );
  assert.ok(proposal, 'an unreferenced-section proposal should be generated');
  assert.ok(proposal?.newText.includes('<!-- FORGE recursive_learner'));
});

test('template evolver degrades to stateless when the write fails', async () => {
  const versions: GovernanceVersion[] = [
    gv({ template_name: 'BLUEPRINT.md', version_number: 1, effectiveness_score: 0.8 }),
    gv({ template_name: 'BLUEPRINT.md', version_number: 2, effectiveness_score: 0.5 }),
  ];
  const result = await evolveTemplates(
    { versions, builds: [], executions: [] },
    { createVersion: async () => null, log: () => {} }
  );
  assert.ok(result.report.proposals.length >= 1);
  assert.equal(result.storage.proposalsStored, 0);
  assert.equal(result.storage.stateless, true);
});

// ===========================================================================
// COST ESTIMATOR (s6-p02 / F17)
// ===========================================================================

/** A canned failure prediction for injection. */
function fp(probability: number, totalBuilds = 0): FailurePrediction {
  return {
    probability,
    matchingPatterns: [],
    recommendation: '',
    shouldRewrite: false,
    matchingOccurrences: 0,
    totalBuildsWithStack: totalBuilds,
  };
}

test('derivePromptCounts maps scope to per-type prompt counts', () => {
  const counts = derivePromptCounts({
    featureCount: 4,
    tableCount: 20,
    apiRouteCount: 9,
    pageCount: 4,
    agentCount: 2,
  });
  assert.equal(counts.schema, 3); // 1 + floor(20/10)
  assert.equal(counts.auth, 1);
  assert.equal(counts.api, 3); // ceil(9/3)
  assert.equal(counts.ui, 1);
  assert.equal(counts.feature, 4);
  assert.equal(counts.agent, 2);
  assert.equal(counts.test, 3);
  assert.equal(counts.deploy, 1);
});

test('cost estimator uses Build Memory history with confidence + predicted failures', async () => {
  // 8 consistent 'feature' executions ⇒ high confidence for that type.
  const history: PromptExecution[] = Array.from({ length: 8 }, () =>
    pe({
      prompt_name: 'Feature: x',
      tokens_input: 1000,
      tokens_output: 500,
      cost_usd: 0.02,
      ...span(60_000),
    })
  );

  const estimate = await estimateBuildCost(
    { stackFingerprint: { framework: 'nextjs' } as never, features: ['Task board'] },
    {
      fetchExecutions: async () => history,
      typeOf: () => 'feature',
      predict: async (_i: FailurePredictionInput) => fp(0.1, 10),
      log: () => {},
    }
  );

  assert.equal(estimate.totalPrompts, 9); // schema1+auth1+api1+ui1+feature1+agent0+test3+deploy1
  const feat = estimate.byType.find((b) => b.promptType === 'feature');
  assert.equal(feat?.samples, 8);
  assert.equal(feat?.confidence, 'high');
  assert.equal(feat?.tokens.estimate, 1500); // (1000+500) × 1 prompt
  assert.equal(feat?.costUsd.estimate, 0.02);
  assert.equal(feat?.timeMs.estimate, 60_000);

  assert.equal(estimate.predictedFailures.estimate, 0.9); // 0.1 × 9 prompts
  assert.equal(estimate.confidence.buildsOnStack, 10);
  // feature has history; the other counted types fell back to defaults.
  assert.ok(estimate.usedDefaultsFor.includes('schema'));
  assert.ok(!estimate.usedDefaultsFor.includes('feature'));
  assert.equal(estimate.confidence.overall, 'low'); // only 1/9 prompts backed by history
  assert.equal(typeof estimate.executionTime.human, 'string');
});

test('cost estimator degrades to documented defaults on a cold Build Memory', async () => {
  const estimate = await estimateBuildCost(
    { features: ['Alpha', 'Beta'] },
    {
      fetchExecutions: async () => [],
      predict: async () => fp(0, 0),
      log: () => {},
    }
  );
  assert.ok(estimate.totalPrompts > 0);
  assert.equal(estimate.confidence.overall, 'low');
  assert.equal(estimate.predictedFailures.estimate, 0);
  assert.ok(estimate.tokens.estimate > 0, 'defaults still yield a positive token estimate');
  assert.ok(estimate.warnings.some((w) => w.includes('No historical')));
  assert.equal(estimate.pricing.inputPerMTok, 3);
});
