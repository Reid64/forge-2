/**
 * FORGE 2.0 — Build Memory integration test.
 *
 * Rewritten against the real local SQLite transport (Finding A-2 / audit item 3): Build Memory
 * migrated off the old self-hosted-Supabase stack to `better-sqlite3` (`src/memory/client.ts`) a
 * while ago, but this file was never updated — it still called Supabase's chained
 * `client.from('table').select(...)` query builder, which a `better-sqlite3` `Database` handle
 * has no method for at all (`client.from is not a function`), so every test here failed 100% of
 * the time regardless of environment.
 *
 * This version exercises the same CRUD surface (build_runs/prompt_executions/error_patterns/
 * resolutions) through the real `src/memory/*.ts` modules and raw `db.prepare(...)` statements
 * for the connectivity probe / cleanup, against an ISOLATED database: `USERPROFILE`/`HOME` are
 * pointed at a fresh temp directory BEFORE any FORGE module is imported (module-level code
 * resolves `~/.forge/forge_memory.db` from `os.homedir()` at import time), so this suite never
 * touches the operator's real `~/.forge/forge_memory.db`.
 *
 * The two "seed data" tests from the Supabase era (10 pre-loaded `forge-bootstrap` error
 * patterns) are dropped, not just renamed: `git grep -n "forge-bootstrap"` across `src/` finds
 * nothing — that migration-012 seed step was never ported to the SQLite schema
 * (`src/learning/database.ts`), so the feature those two tests exercised no longer exists. The
 * `getAutoResolvable` CRUD function itself is real and still tested here, against
 * freshly-created rows instead of removed seed data.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/memory.test.ts
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must happen BEFORE any FORGE module import: `src/learning/database.ts` resolves
// `~/.forge/forge_memory.db` from `os.homedir()` at module-load time.
const tmpHome = mkdtempSync(join(tmpdir(), 'forge-memory-test-'));
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const { builds, prompts, errors, resolutions, getClient, resetClient } = await import('../src/memory/index.js');
const { closeConnection } = await import('../src/learning/database.js');

// Unique per-run markers (harmless now that the DB itself is isolated, kept for readability).
const RUN_ID = `${Date.now()}`;
const TEST_PROJECT = `forge-selftest-${RUN_ID}`;
const ERROR_SIGNATURE = `selftest: synthetic signature ${RUN_ID}`;

// IDs captured across the ordered tests, for linking and for cleanup.
let buildId: string | null = null;
let promptId: string | null = null;
let errorPatternId: string | null = null;
let resolutionId: string | null = null;

before(() => {
  resetClient();
  const client = getClient();
  assert.ok(client, 'Build Memory client is null — could not open the isolated test database.');

  const row = client.prepare('SELECT id FROM build_runs LIMIT 1').all();
  assert.ok(Array.isArray(row), 'Cannot query the build_runs table on the isolated test database.');
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

test('error_patterns: getAutoResolvable returns only auto_resolve_eligible rows, sorted desc', async () => {
  const suffix = `${RUN_ID}-autoresolve`;
  const high = await errors.createErrorPattern({
    error_signature: `selftest: high ${suffix}`,
    error_category: 'type_error',
    error_message_sample: 'sample',
    first_seen_project: TEST_PROJECT,
    success_rate: 0.97,
    auto_resolve_eligible: true,
  });
  const mid = await errors.createErrorPattern({
    error_signature: `selftest: mid ${suffix}`,
    error_category: 'type_error',
    error_message_sample: 'sample',
    first_seen_project: TEST_PROJECT,
    success_rate: 0.92,
    auto_resolve_eligible: true,
  });
  const ineligible = await errors.createErrorPattern({
    error_signature: `selftest: ineligible ${suffix}`,
    error_category: 'type_error',
    error_message_sample: 'sample',
    first_seen_project: TEST_PROJECT,
    success_rate: 0.99,
    auto_resolve_eligible: false,
  });
  assert.ok(high && mid && ineligible, 'setup rows failed to create');

  const list = await errors.getAutoResolvable();
  assert.ok(list, 'getAutoResolvable returned null');

  const ids = new Set([high.id, mid.id, ineligible.id]);
  const scoped = list.filter((p) => ids.has(p.id));
  assert.equal(scoped.length, 2, 'expected exactly the 2 auto_resolve_eligible rows from this test');
  assert.equal(scoped[0]?.id, high.id, 'higher success_rate should sort first');
  assert.equal(scoped[1]?.id, mid.id);
  assert.ok(!scoped.some((p) => p.id === ineligible.id), 'auto_resolve_eligible=false row must be excluded');
});

after(() => {
  const client = getClient();
  try {
    if (buildId) {
      client?.prepare('DELETE FROM prompt_executions WHERE build_run_id = ?').run(buildId);
      client?.prepare('DELETE FROM build_runs WHERE id = ?').run(buildId);
    }
    if (resolutionId) {
      client?.prepare('DELETE FROM resolutions WHERE id = ?').run(resolutionId);
    }
    client?.prepare('DELETE FROM error_patterns WHERE first_seen_project = ?').run(TEST_PROJECT);
  } finally {
    closeConnection();
    resetClient();
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
