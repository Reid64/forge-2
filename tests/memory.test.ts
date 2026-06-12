/**
 * FORGE 2.0 — Build Memory integration test (Sprint 1, s1-p05).
 *
 * Exercises every Build Memory CRUD module against the LIVE local self-hosted
 * Supabase (docker/docker-compose.yml). Per the task, it:
 *   1. creates a build_run,
 *   2. creates prompt_executions linked to it,
 *   3. creates an error_pattern,
 *   4. creates a resolution linked to it,
 *   5. queries matching patterns,
 *   6. verifies the 10 pre-loaded seed error patterns exist.
 *
 * It additionally round-trips the update/list helpers so the whole CRUD surface
 * named in queue.yaml s1-p04 is covered.
 *
 * HOW TO RUN
 * ----------
 * Use tests/run-tests.ps1, which (a) verifies the Docker Supabase stack is up,
 * (b) loads FORGE_SUPABASE_URL / FORGE_SUPABASE_SERVICE_KEY from docker/.env,
 * (c) runs the `pnpm tsc --noEmit` gate, then (d) runs this file.
 *
 * Node 20 cannot execute TypeScript natively (type stripping is Node >= 22.6),
 * and src/ uses NodeNext `.js` import specifiers that resolve to `.ts` sources.
 * Both are handled by the `tsx` loader, so the runner invokes:
 *     node --import tsx --test tests/memory.test.ts
 *
 * PREREQUISITES (run-tests.ps1 checks the first; the operator does 2–3 once):
 *   1. Supabase stack running:   .\docker\start-forge-db.ps1
 *   2. Migrations applied:       .\migrations\apply-migrations.ps1   (incl. 012 seed)
 *   3. tsx installed:            pnpm install   (tsx is in devDependencies)
 *
 * Test rows are namespaced with a per-run id and deleted in `after`, so repeated
 * runs leave the database clean and never collide on the UNIQUE error_signature.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  builds,
  prompts,
  errors,
  resolutions,
  getClient,
  resetClient,
} from '../src/memory/index.js';

// Unique per-run markers so concurrent/repeat runs never collide.
const RUN_ID = `${Date.now()}`;
const TEST_PROJECT = `forge-selftest-${RUN_ID}`;
const ERROR_SIGNATURE = `selftest: synthetic signature ${RUN_ID}`;

// IDs captured across the ordered tests, for linking and for cleanup.
let buildId: string | null = null;
let promptId: string | null = null;
let errorPatternId: string | null = null;
let resolutionId: string | null = null;

before(async () => {
  // Re-read env (run-tests.ps1 exports the credentials before launching node).
  resetClient();
  const client = getClient();
  assert.ok(
    client,
    'Build Memory client is null. Set FORGE_SUPABASE_URL and FORGE_SUPABASE_SERVICE_KEY ' +
      '(run-tests.ps1 loads them from docker/.env) and ensure the Supabase stack is up.'
  );

  // Live connectivity probe. Every CRUD helper returns null on failure
  // (BEHAVIORAL_CONTRACTS Contract 4), so we confirm reachability up front to
  // distinguish "database is down" from "a CRUD function is broken".
  const { error } = await client.from('build_runs').select('id').limit(1);
  assert.ok(
    !error,
    `Cannot reach the build_runs table — is the stack up and are migrations applied? ${
      error ? `(${error.message})` : ''
    }`
  );
});

test('build_runs: createBuild inserts and returns the row', async () => {
  const row = await builds.createBuild({
    project_name: TEST_PROJECT,
    project_path: `C:\\tmp\\${TEST_PROJECT}`,
    machine_id: 'selftest-machine',
    status: 'running',
    total_prompts: 2,
  });
  assert.ok(row, 'createBuild returned null');
  assert.equal(row.project_name, TEST_PROJECT);
  assert.equal(row.machine_id, 'selftest-machine');
  assert.equal(row.status, 'running');
  assert.equal(row.total_prompts, 2);
  assert.ok(row.id, 'created build_run is missing an id');
  buildId = row.id;
});

test('build_runs: getBuild, updateBuild, getBuildsByProject round-trip', async () => {
  assert.ok(buildId, 'no buildId from the create test');

  const fetched = await builds.getBuild(buildId);
  assert.ok(fetched, 'getBuild returned null');
  assert.equal(fetched.id, buildId);

  const updated = await builds.updateBuild(buildId, {
    status: 'completed',
    completed_prompts: 2,
  });
  assert.ok(updated, 'updateBuild returned null');
  assert.equal(updated.status, 'completed');
  assert.equal(updated.completed_prompts, 2);

  const byProject = await builds.getBuildsByProject(TEST_PROJECT);
  assert.ok(byProject, 'getBuildsByProject returned null');
  assert.equal(byProject.length, 1, 'expected exactly one build for the test project');
  assert.equal(byProject[0]?.id, buildId);
});

test('prompt_executions: createPromptExecution linked to the build', async () => {
  assert.ok(buildId, 'no buildId');

  const p1 = await prompts.createPromptExecution({
    build_run_id: buildId,
    prompt_index: 1,
    prompt_name: 'selftest-prompt-1',
    prompt_hash: `hash-1-${RUN_ID}`,
    prompt_content: 'first synthetic prompt',
    status: 'completed',
  });
  assert.ok(p1, 'createPromptExecution #1 returned null');
  assert.equal(p1.build_run_id, buildId, 'prompt_execution not linked to the build');
  assert.equal(p1.prompt_index, 1);
  promptId = p1.id;

  const p2 = await prompts.createPromptExecution({
    build_run_id: buildId,
    prompt_index: 2,
    prompt_name: 'selftest-prompt-2',
    prompt_hash: `hash-2-${RUN_ID}`,
    prompt_content: 'second synthetic prompt',
  });
  assert.ok(p2, 'createPromptExecution #2 returned null');
  assert.equal(p2.build_run_id, buildId);
});

test('prompt_executions: updatePromptExecution + getPromptsByBuild (ordered)', async () => {
  assert.ok(promptId, 'no promptId');

  const updated = await prompts.updatePromptExecution(promptId, {
    sentinel_passed: true,
    tokens_input: 100,
    tokens_output: 250,
  });
  assert.ok(updated, 'updatePromptExecution returned null');
  assert.equal(updated.sentinel_passed, true);
  assert.equal(updated.tokens_output, 250);

  assert.ok(buildId, 'no buildId');
  const list = await prompts.getPromptsByBuild(buildId);
  assert.ok(list, 'getPromptsByBuild returned null');
  assert.equal(list.length, 2, 'expected 2 prompt_executions for the build');
  assert.equal(list[0]?.prompt_index, 1, 'prompts not ordered by prompt_index ascending');
  assert.equal(list[1]?.prompt_index, 2, 'prompts not ordered by prompt_index ascending');
});

test('error_patterns: createErrorPattern inserts and returns the row', async () => {
  const row = await errors.createErrorPattern({
    error_signature: ERROR_SIGNATURE,
    error_category: 'type_error',
    error_message_sample: 'error TS2304: Cannot find name "synthetic".',
    first_seen_project: TEST_PROJECT,
    success_rate: 0.5,
  });
  assert.ok(row, 'createErrorPattern returned null');
  assert.equal(row.error_signature, ERROR_SIGNATURE);
  assert.equal(row.error_category, 'type_error');
  assert.equal(row.occurrence_count, 1, 'occurrence_count should default to 1');
  assert.ok(row.id, 'created error_pattern is missing an id');
  errorPatternId = row.id;
});

test('error_patterns: findMatchingPattern returns the created pattern', async () => {
  const found = await errors.findMatchingPattern(ERROR_SIGNATURE);
  assert.ok(found, 'findMatchingPattern returned null for a known signature');
  assert.equal(found.id, errorPatternId);
  assert.equal(found.error_signature, ERROR_SIGNATURE);
});

test('error_patterns: updateOccurrenceCount increments and refreshes last_seen_at', async () => {
  assert.ok(errorPatternId, 'no errorPatternId');
  const updated = await errors.updateOccurrenceCount(errorPatternId);
  assert.ok(updated, 'updateOccurrenceCount returned null');
  assert.equal(updated.occurrence_count, 2, 'occurrence_count should be 2 after one increment');
});

test('resolutions: createResolution linked to the error pattern', async () => {
  assert.ok(errorPatternId, 'no errorPatternId');
  const row = await resolutions.createResolution({
    error_pattern_id: errorPatternId,
    resolution_type: 'prompt_rewrite',
    resolution_description: 'Add the missing type import for the undefined symbol.',
    resolution_steps: { steps: ['identify the missing symbol', 'add the import', 're-run tsc'] },
  });
  assert.ok(row, 'createResolution returned null');
  assert.equal(row.error_pattern_id, errorPatternId, 'resolution not linked to the error pattern');
  assert.equal(row.resolution_type, 'prompt_rewrite');
  assert.equal(row.times_applied, 0, 'times_applied should default to 0');
  resolutionId = row.id;
});

test('resolutions: getResolutionForPattern + incrementApplied', async () => {
  assert.ok(errorPatternId, 'no errorPatternId');
  const latest = await resolutions.getResolutionForPattern(errorPatternId);
  assert.ok(latest, 'getResolutionForPattern returned null');
  assert.equal(latest.id, resolutionId);

  assert.ok(resolutionId, 'no resolutionId');
  const applied = await resolutions.incrementApplied(resolutionId, true);
  assert.ok(applied, 'incrementApplied returned null');
  assert.equal(applied.times_applied, 1);
  assert.equal(applied.times_succeeded, 1);
  assert.equal(applied.times_failed, 0);

  const failed = await resolutions.incrementApplied(resolutionId, false);
  assert.ok(failed, 'incrementApplied (failure) returned null');
  assert.equal(failed.times_applied, 2);
  assert.equal(failed.times_succeeded, 1);
  assert.equal(failed.times_failed, 1);
});

test('seed data: exactly the 10 pre-loaded error patterns exist', async () => {
  const client = getClient();
  assert.ok(client, 'client is null');

  // All 10 seeds use first_seen_project = 'forge-bootstrap' (migration 012),
  // which isolates them from the synthetic row this test created.
  const { data, error } = await client
    .from('error_patterns')
    .select('error_signature')
    .eq('first_seen_project', 'forge-bootstrap');

  assert.ok(!error, `seed query failed: ${error ? error.message : ''}`);
  assert.ok(data, 'seed query returned null data');
  assert.equal(
    data.length,
    10,
    `expected 10 seeded error patterns, found ${data.length} — run migrations/apply-migrations.ps1`
  );
});

test('seed data: getAutoResolvable returns the 8 auto-eligible seeds, sorted desc', async () => {
  const list = await errors.getAutoResolvable();
  assert.ok(list, 'getAutoResolvable returned null');

  // 8 of the 10 seeds have success_rate > 0.90 (html_assumed_rendered=0.90 and
  // supabase_rls_blocks=0.85 are NOT auto-eligible; the synthetic pattern at 0.5
  // is also excluded). Results are ordered by success_rate descending.
  const seeds = list.filter((p) => p.first_seen_project === 'forge-bootstrap');
  assert.equal(seeds.length, 8, `expected 8 auto-resolvable seeds, found ${seeds.length}`);
  for (let i = 1; i < seeds.length; i++) {
    const prev = seeds[i - 1]?.success_rate ?? 0;
    const cur = seeds[i]?.success_rate ?? 0;
    assert.ok(prev >= cur, 'getAutoResolvable is not sorted by success_rate descending');
  }
});

after(async () => {
  // Remove everything this run created. FK order: children before parents.
  const client = getClient();
  if (!client) return;

  if (buildId) {
    await client.from('prompt_executions').delete().eq('build_run_id', buildId);
    await client.from('build_runs').delete().eq('id', buildId);
  }
  if (resolutionId) {
    await client.from('resolutions').delete().eq('id', resolutionId);
  }
  if (errorPatternId) {
    await client.from('error_patterns').delete().eq('id', errorPatternId);
  }
});
