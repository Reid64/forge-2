/**
 * FORGE 2.0 — Phase 3 Build Executor + Parallel Scheduler unit test (Sprint 5, s5-p05).
 *
 * Pure `node:test` — NO database, NO `claude` install, NO real git repo:
 *   - the parallel-scheduler is a pure function (topological order / waves / parallel groups /
 *     cycle + unknown-dependency detection), exercised directly;
 *   - `parseQueueYaml` is round-tripped against the Queue Generator's `serializeQueue`;
 *   - the executor loop is driven with EVERY collaborator injected (predict / assemble / rewrite
 *     / claude / Sentinel / recovery / Build Memory CRUD) and a real `GitManager` wired to a
 *     recording `execImpl` (so the git sequence is verified without touching a repo). The
 *     `GitManager` cwd is an `os.tmpdir()` mkdtemp dir because `commitAll` writes/removes a real
 *     temp commit-message file there.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/executor.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeSchedule } from '../src/engine/parallel-scheduler.js';
import { runPhase3Executor, parseQueueYaml, type Phase3Options } from '../src/phases/phase3-executor.js';
import { serializeQueue, type QueueEntry, type QueueStats } from '../src/engine/queue-generator.js';
import { GitManager, type ExecSyncFn } from '../src/engine/git-manager.js';
import type { FailurePrediction } from '../src/engine/failure-predictor.js';
import type { ClaudeRunResult } from '../src/engine/claude-runner.js';
import type { SentinelResult, AutoRecoveryResult } from '../src/phases/phase4-sentinel.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function entry(over: Partial<QueueEntry> & { id: string }): QueueEntry {
  return {
    id: over.id,
    name: over.name ?? over.id,
    prompt_type: over.prompt_type ?? 'feature',
    dependencies: over.dependencies ?? [],
    governance_refs: over.governance_refs ?? [],
    estimated_tokens: over.estimated_tokens ?? 3000,
    context_injection: over.context_injection ?? { schemaSections: [], behavioralSections: [], interactionMaps: [] },
    description: over.description ?? `Build ${over.id}.`,
    ...(over.parallel_group !== undefined ? { parallel_group: over.parallel_group } : {}),
  };
}

function prediction(over: Partial<FailurePrediction> = {}): FailurePrediction {
  return {
    probability: over.probability ?? 0,
    matchingPatterns: over.matchingPatterns ?? [],
    recommendation: over.recommendation ?? '',
    shouldRewrite: over.shouldRewrite ?? false,
    matchingOccurrences: over.matchingOccurrences ?? 0,
    totalBuildsWithStack: over.totalBuildsWithStack ?? 0,
  };
}

function claudeOk(): ClaudeRunResult {
  return {
    stdout: 'done',
    stderr: '',
    exitCode: 0,
    durationMs: 1,
    tokensEstimated: 100,
    timedOut: false,
    signal: null,
    success: true,
  };
}

function passSentinel(): SentinelResult {
  return { passed: true, checks: [], failedCheck: null, diagnosticReport: 'PASS' };
}

function failSentinel(): SentinelResult {
  return {
    passed: false,
    checks: [{ name: 'typescript', passed: false, skipped: false, detail: 'tsc failed', output: 'TS1005', durationMs: 1 }],
    failedCheck: 'typescript',
    diagnosticReport: 'FAIL: typescript',
  };
}

/** A real GitManager backed by a recording fake exec (no repo touched). */
function fakeGit(cwd: string): { git: GitManager; commands: string[] } {
  const commands: string[] = [];
  let currentBranch = 'main';
  const execImpl: ExecSyncFn = (command: string) => {
    commands.push(command);
    const checkoutB = /checkout -b (\S+)/.exec(command);
    if (checkoutB && checkoutB[1]) {
      currentBranch = checkoutB[1];
      return '';
    }
    if (command.includes('rev-parse')) return `${currentBranch}\n`;
    const checkout = /checkout (\S+)/.exec(command);
    if (checkout && checkout[1]) {
      currentBranch = checkout[1];
      return '';
    }
    return '';
  };
  return { git: new GitManager({ cwd, execImpl }), commands };
}

/** In-memory Build Memory fakes capturing every write. */
function memFakes() {
  const buildInserts: unknown[] = [];
  const buildPatches: Array<{ id: string; patch: unknown }> = [];
  const promptInserts: unknown[] = [];
  const promptPatches: Array<{ id: string; patch: unknown }> = [];
  let pid = 0;
  return {
    buildInserts,
    buildPatches,
    promptInserts,
    promptPatches,
    createBuild: async (input: unknown) => {
      buildInserts.push(input);
      return { id: 'build-1' };
    },
    updateBuild: async (id: string, patch: unknown) => {
      buildPatches.push({ id, patch });
      return { id };
    },
    createPromptExecution: async (input: unknown) => {
      promptInserts.push(input);
      return { id: `pe-${++pid}` };
    },
    updatePromptExecution: async (id: string, patch: unknown) => {
      promptPatches.push({ id, patch });
      return { id };
    },
  };
}

/** Base executor options with all collaborators injected; override per test. */
function baseOptions(cwd: string, entries: QueueEntry[], over: Partial<Phase3Options> = {}): Phase3Options {
  const mem = memFakes();
  const { git } = fakeGit(cwd);
  return {
    projectPath: cwd,
    entries,
    gitManager: git,
    predictImpl: async () => prediction(),
    assembleImpl: async ({ entry: e }) => ({
      prompt: `PROMPT ${e.id}`,
      hash: `hash-${e.id}`,
      governanceDocsUsed: [],
      governanceDocsMissing: [],
      warningsInjected: 0,
      model: 'claude-sonnet-4-6' as const,
      modelSelection: {
        model: 'claude-sonnet-4-6' as const,
        tier: 'standard' as const,
        promptType: e.prompt_type,
        isRecovery: false,
        reason: 'test stub',
        pricing: { inputPerMTok: 3, outputPerMTok: 15 },
      },
      estimatedCostUsd: 0,
    }),
    rewriteImpl: async ({ prompt }) => ({
      rewrittenPrompt: `REWRITTEN ${prompt}`,
      reason: 'high-risk rewrite',
      originalHash: 'orig-hash',
      rewrittenHash: 'rewritten-hash',
    }),
    runClaudeImpl: async () => claudeOk(),
    runSentinelImpl: async () => passSentinel(),
    loadGovernanceDocs: async () => ({}),
    updateStateProgress: async () => {},
    writeHaltReport: async () => {},
    createBuild: mem.createBuild,
    updateBuild: mem.updateBuild,
    createPromptExecution: mem.createPromptExecution,
    updatePromptExecution: mem.updatePromptExecution,
    log: () => {},
    ...over,
  };
}

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'forge-exec-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ===========================================================================
// Parallel Scheduler
// ===========================================================================

test('analyzeSchedule: topological order + dependency waves', () => {
  const entries = [
    entry({ id: 'a' }),
    entry({ id: 'b', dependencies: ['a'] }),
    entry({ id: 'c', dependencies: ['a'] }),
    entry({ id: 'd', dependencies: ['b', 'c'] }),
  ];
  const s = analyzeSchedule(entries, { log: () => {} });

  // Order respects dependencies (each dep appears before its dependent).
  const pos = new Map(s.order.map((e, i) => [e.id, i]));
  assert.ok((pos.get('a') ?? 0) < (pos.get('b') ?? 0));
  assert.ok((pos.get('a') ?? 0) < (pos.get('c') ?? 0));
  assert.ok((pos.get('b') ?? 0) < (pos.get('d') ?? 0));
  assert.ok((pos.get('c') ?? 0) < (pos.get('d') ?? 0));

  // Three waves: [a], [b, c], [d].
  assert.equal(s.waves.length, 3);
  assert.deepEqual(s.waves[0]?.entries.map((e) => e.id), ['a']);
  assert.deepEqual(s.waves[1]?.entries.map((e) => e.id).sort(), ['b', 'c']);
  assert.deepEqual(s.waves[2]?.entries.map((e) => e.id), ['d']);
  assert.equal(s.maxParallelism, 2); // wave [b, c]
  assert.equal(s.longestChain, 3);
  assert.equal(s.cycles.length, 0);
  assert.equal(s.unknownDependencies.length, 0);
});

test('analyzeSchedule: surfaces queue-declared parallel groups', () => {
  const entries = [
    entry({ id: 'api-x', prompt_type: 'api', parallel_group: 'api-routes' }),
    entry({ id: 'api-y', prompt_type: 'api', parallel_group: 'api-routes' }),
    entry({ id: 'solo', prompt_type: 'schema' }),
  ];
  const s = analyzeSchedule(entries, { log: () => {} });
  assert.deepEqual(s.parallelGroups.get('api-routes')?.map((e) => e.id), ['api-x', 'api-y']);
  assert.equal(s.parallelGroups.has('solo'), false);
});

test('analyzeSchedule: reports unknown dependencies (and still schedules the rest)', () => {
  const entries = [entry({ id: 'a', dependencies: ['ghost'] }), entry({ id: 'b', dependencies: ['a'] })];
  const s = analyzeSchedule(entries, { log: () => {} });
  assert.equal(s.unknownDependencies.length, 1);
  assert.equal(s.unknownDependencies[0]?.id, 'a');
  assert.deepEqual(s.unknownDependencies[0]?.missing, ['ghost']);
  // 'ghost' is dropped, so 'a' becomes a root and the queue still schedules fully.
  assert.equal(s.order.length, 2);
  assert.equal(s.cycles.length, 0);
});

test('analyzeSchedule: detects a dependency cycle without throwing', () => {
  const entries = [
    entry({ id: 'x', dependencies: ['z'] }),
    entry({ id: 'y', dependencies: ['x'] }),
    entry({ id: 'z', dependencies: ['y'] }),
  ];
  const s = analyzeSchedule(entries, { log: () => {} });
  assert.ok(s.cycles.length >= 1);
  assert.deepEqual(s.cycles[0]?.slice().sort(), ['x', 'y', 'z']);
  // Every entry is still surfaced (cyclic leftovers appended after the acyclic waves).
  assert.equal(s.order.length, 3);
});

// ===========================================================================
// parseQueueYaml (round-trip against the Queue Generator's serializer)
// ===========================================================================

test('parseQueueYaml: round-trips serializeQueue output (snake_case → camelCase)', () => {
  const entries: QueueEntry[] = [
    entry({
      id: 'schema-migrations',
      name: 'Database schema',
      prompt_type: 'schema',
      governance_refs: ['SCHEMA_REGISTRY.md', 'BLUEPRINT.md'],
      context_injection: { schemaSections: ['projects', 'companies'], behavioralSections: [], interactionMaps: [] },
    }),
    entry({
      id: 'api-projects',
      name: 'API: projects',
      prompt_type: 'api',
      dependencies: ['schema-migrations'],
      parallel_group: 'api-routes',
      governance_refs: ['BEHAVIORAL_CONTRACTS.md'],
      context_injection: { schemaSections: ['projects'], behavioralSections: ['API Contracts'], interactionMaps: [] },
    }),
  ];
  const stats: QueueStats = {
    totalPrompts: 2,
    byType: { schema: 1, auth: 0, api: 1, ui: 0, feature: 0, agent: 0, test: 0, deploy: 0 },
    parallelGroups: 1,
    totalEstimatedTokens: 6000,
    longestChain: 2,
  };
  const yaml = serializeQueue(entries, { projectName: 'demo', projectPath: '/tmp/demo', generatedAt: '2026-01-01', stats });

  const { entries: parsed, warnings } = parseQueueYaml(yaml);
  assert.equal(warnings.length, 0);
  assert.equal(parsed.length, 2);

  const api = parsed.find((e) => e.id === 'api-projects');
  assert.ok(api);
  assert.equal(api?.prompt_type, 'api');
  assert.deepEqual(api?.dependencies, ['schema-migrations']);
  assert.equal(api?.parallel_group, 'api-routes');
  assert.deepEqual(api?.context_injection.schemaSections, ['projects']);
  assert.deepEqual(api?.context_injection.behavioralSections, ['API Contracts']);
});

test('parseQueueYaml: skips malformed entries with a warning, never throws', () => {
  const yaml = ['- name: no id here', '  prompt_type: schema', '- id: ok', '  prompt_type: schema'].join('\n');
  const { entries: parsed, warnings } = parseQueueYaml(yaml);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.id, 'ok');
  assert.ok(warnings.some((w) => w.includes('no id')));
});

// ===========================================================================
// Executor loop
// ===========================================================================

test('runPhase3Executor: sequential happy path — all prompts pass, merge + checkpoint', async () => {
  await withTmp(async (dir) => {
    const entries = [entry({ id: 'a', prompt_type: 'schema' }), entry({ id: 'b', dependencies: ['a'] })];
    const { git, commands } = fakeGit(dir);
    const result = await runPhase3Executor(baseOptions(dir, entries, { gitManager: git }));

    assert.equal(result.status, 'completed');
    assert.equal(result.completedPrompts, 2);
    assert.equal(result.failedPrompts, 0);
    assert.equal(result.buildRunId, 'build-1');
    assert.deepEqual(result.outcomes.map((o) => o.disposition), ['completed', 'completed']);

    // Each prompt branched, merged (--no-ff), and tagged a checkpoint (Contracts 10/11).
    assert.ok(commands.some((c) => c.includes('checkout -b forge/build-1/prompt-1-a')));
    assert.ok(commands.some((c) => c.includes('merge --no-ff')));
    assert.ok(commands.some((c) => c.includes('tag forge-checkpoint-build-1-1')));
  });
});

test('runPhase3Executor: Sentinel failure with no recovery halts the build (Contract 13)', async () => {
  await withTmp(async (dir) => {
    const entries = [entry({ id: 'a', prompt_type: 'schema' }), entry({ id: 'b', dependencies: ['a'] })];
    let haltReport = '';
    const result = await runPhase3Executor(
      baseOptions(dir, entries, {
        runSentinelImpl: async () => failSentinel(),
        writeHaltReport: async (r) => {
          haltReport = r;
        },
      })
    );

    assert.equal(result.status, 'halted');
    assert.equal(result.completedPrompts, 0);
    assert.equal(result.haltedAt?.index, 1);
    assert.equal(result.haltedAt?.id, 'a');
    // The loop breaks at the first failure — the second prompt never executes.
    assert.equal(result.outcomes.length, 1);
    assert.equal(result.outcomes[0]?.disposition, 'failed');
    assert.ok(haltReport.includes('HALT'));
  });
});

test('runPhase3Executor: Autonomous Recovery restores green → completed', async () => {
  await withTmp(async (dir) => {
    const entries = [entry({ id: 'a', prompt_type: 'schema' })];
    const recovery: AutoRecoveryResult = {
      enabled: true,
      attempted: true,
      recovered: true,
      escalated: false,
      attempts: [],
      finalSentinel: passSentinel(),
      reason: 'Recovered on attempt 1.',
    };
    const result = await runPhase3Executor(
      baseOptions(dir, entries, {
        autonomousRecoveryMode: true,
        runSentinelImpl: async () => failSentinel(),
        runRecoveryImpl: async () => recovery,
      })
    );

    assert.equal(result.status, 'completed');
    assert.equal(result.completedPrompts, 1);
    assert.equal(result.outcomes[0]?.disposition, 'completed');
    assert.equal(result.outcomes[0]?.recovery?.recovered, true);
  });
});

test('runPhase3Executor: high failure probability triggers a rewrite (Contract 9)', async () => {
  await withTmp(async (dir) => {
    const entries = [entry({ id: 'a', prompt_type: 'schema' })];
    let executedPrompt = '';
    const result = await runPhase3Executor(
      baseOptions(dir, entries, {
        predictImpl: async () => prediction({ probability: 0.8, shouldRewrite: true }),
        runClaudeImpl: async (prompt) => {
          executedPrompt = prompt;
          return claudeOk();
        },
      })
    );
    assert.equal(result.outcomes[0]?.wasRewritten, true);
    assert.equal(result.outcomes[0]?.promptHash, 'rewritten-hash');
    assert.ok(executedPrompt.startsWith('REWRITTEN '));
  });
});

test('runPhase3Executor: dry run assembles + predicts but executes nothing', async () => {
  await withTmp(async (dir) => {
    const entries = [entry({ id: 'a', prompt_type: 'schema' }), entry({ id: 'b', dependencies: ['a'] })];
    let claudeCalled = false;
    const result = await runPhase3Executor(
      baseOptions(dir, entries, {
        dryRun: true,
        runClaudeImpl: async () => {
          claudeCalled = true;
          return claudeOk();
        },
      })
    );
    assert.equal(result.status, 'dry_run');
    assert.equal(claudeCalled, false);
    assert.equal(result.outcomes.length, 2);
    assert.deepEqual(result.outcomes.map((o) => o.disposition), ['skipped', 'skipped']);
    assert.ok(result.outcomes.every((o) => o.failureProbability !== null));
  });
});

test('runPhase3Executor: replay carries pre-resume prompts, rolls back, links to the original', async () => {
  await withTmp(async (dir) => {
    const entries = [
      entry({ id: 'a', prompt_type: 'schema' }),
      entry({ id: 'b', dependencies: ['a'] }),
      entry({ id: 'c', dependencies: ['b'] }),
    ];
    const { git, commands } = fakeGit(dir);
    const buildInserts: Array<Record<string, unknown>> = [];
    const executed: string[] = [];
    const result = await runPhase3Executor(
      baseOptions(dir, entries, {
        gitManager: git,
        replay: {
          originalBuildRunId: 'orig-1',
          fromCheckpointTag: 'forge-checkpoint-orig-1-2',
          fromPromptIndex: 2,
        },
        createBuild: async (input) => {
          buildInserts.push(input as Record<string, unknown>);
          return { id: 'build-2' };
        },
        runClaudeImpl: async (prompt) => {
          executed.push(prompt);
          return claudeOk();
        },
      })
    );

    assert.equal(result.status, 'completed');
    // Prompt 1 ('a') is carried from the checkpoint (skipped), 2 + 3 re-execute.
    assert.deepEqual(result.outcomes.map((o) => o.disposition), ['skipped', 'completed', 'completed']);
    assert.ok(result.outcomes[0]?.note.includes('carried from checkpoint'));
    assert.equal(executed.length, 2); // only 'b' and 'c' ran through claude

    // Step 2: main was hard-reset to the original build's checkpoint tag.
    assert.ok(commands.some((c) => c.includes('reset --hard forge-checkpoint-orig-1-2')));

    // New branches/tags use the NEW build id (no collision with the original).
    assert.ok(commands.some((c) => c.includes('checkout -b forge/build-2/prompt-2-b')));

    // Linked to the original via toolchain_manifest._forge_replay + result.replayOf.
    const manifest = buildInserts[0]?.toolchain_manifest as Record<string, unknown> | undefined;
    const link = manifest?._forge_replay as Record<string, unknown> | undefined;
    assert.equal(link?.replay_of, 'orig-1');
    assert.equal(link?.from_prompt_index, 2);
    assert.equal(result.replayOf?.originalBuildRunId, 'orig-1');
    assert.equal(result.replayOf?.fromPromptIndex, 2);
  });
});

test('runPhase3Executor: dry run produces a simulation report (cost estimate + predicted errors)', async () => {
  await withTmp(async (dir) => {
    const entries = [
      entry({ id: 'a', prompt_type: 'schema' }),
      entry({ id: 'b', prompt_type: 'feature', dependencies: ['a'] }),
    ];
    const fakeEstimate = {
      costUsd: { estimate: 12.5, low: 9, high: 16 },
      executionTime: { estimate: 600000, low: 400000, high: 800000, human: '10m' },
    } as unknown as Awaited<ReturnType<NonNullable<Phase3Options['estimateCostImpl']>>>;

    const result = await runPhase3Executor(
      baseOptions(dir, entries, {
        dryRun: true,
        // 'b' is high-risk → predicted error in the report.
        predictImpl: async ({ promptType }) =>
          promptType === 'feature' ? prediction({ probability: 0.8, shouldRewrite: true }) : prediction(),
        estimateCostImpl: async () => fakeEstimate,
      })
    );

    assert.equal(result.status, 'dry_run');
    assert.ok(result.simulation);
    assert.equal(result.simulation?.totalPrompts, 2);
    assert.equal(result.simulation?.prompts.length, 2);
    assert.equal(result.simulation?.predictedCostUsd?.estimate, 12.5);
    assert.equal(result.simulation?.predictedTimeMs?.human, '10m');
    // 'b' (p=0.8 > 0.4) is flagged as a predicted error; 'a' (p=0) is not.
    assert.deepEqual(result.simulation?.predictedErrors.map((e) => e.id), ['b']);
    assert.ok((result.simulation?.expectedFailureCount ?? 0) >= 0.8);
  });
});

test('runPhase3Executor: degrades to stateless when Build Memory is unreachable', async () => {
  await withTmp(async (dir) => {
    const entries = [entry({ id: 'a', prompt_type: 'schema' })];
    const result = await runPhase3Executor(
      baseOptions(dir, entries, {
        createBuild: async () => null, // stateless
        createPromptExecution: async () => null,
      })
    );
    assert.equal(result.buildRunId, null);
    assert.equal(result.status, 'completed');
    assert.ok(result.warnings.some((w) => w.includes('stateless')));
  });
});
