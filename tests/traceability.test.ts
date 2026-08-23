/**
 * FORGE 2.0 — Requirements Traceability Engine + Governance Ontology tests
 * (`src/governance/traceability.ts`, `src/governance/ontology.ts`).
 *
 * No test existed for `traceability.ts` before this file (it predates this task). Exercises the
 * NEW behavior added alongside `ontology.ts`:
 *   1. bidirectional trace — `traceRequirement` now also reports upstream `adrEvidence`/
 *      `riskEvidence` (which ADR/risk rows appear to have motivated a requirement), not just the
 *      original downstream PLANNED→DEPLOYED stage pipeline.
 *   2. `traceReverse` — given a downstream identifier (commit hash, queue entry id, test suite
 *      name), find which REQ-NNN id(s) trace back to it.
 *   3. `findUntestedRequirements` — list requirements/features with zero recorded test evidence.
 *   4. a light pass over `ontology.ts`'s real Build Memory-backed accessors, proving they
 *      cross-reference the SAME rows this file seeds (no separate storage of their own).
 *
 * Same convention as `tests/design-pipeline-extras.test.ts`: a real scratch project directory on
 * disk (governance docs + queue.yaml + an actual git repo) plus fixture rows written directly into
 * the LIVE local Build Memory SQLite db (`~/.forge/forge_memory.db`) via `getClient()`, all
 * namespaced under one random project name and deleted in `after`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { getClient, resetClient } from '../src/memory/client.js';
import { createAdr } from '../src/memory/adr.js';
import { createRisk } from '../src/memory/risks.js';
import { insertTestRunResult } from '../src/memory/test-results.js';
import {
  traceRequirement,
  traceReverse,
  findUntestedRequirements,
  formatTraceResult,
  formatReverseTraceResult,
  formatUntestedResult,
} from '../src/governance/traceability.js';
import {
  listRequirements,
  listFeatures,
  listDecisions,
  listRiskEntities,
  listTests,
  BACKED_ONTOLOGY_KINDS,
  PLACEHOLDER_ONTOLOGY_KINDS,
} from '../src/governance/ontology.js';

const RUN_ID = `${Date.now()}`;
const projectPath = join(tmpdir(), `forge-trace-selftest-${RUN_ID}`);
const projectName = basename(projectPath);

let commitHash = '';

describe('traceability + ontology (live scratch project + live Build Memory)', () => {
  before(async () => {
    // --- scratch project on disk: governance docs, queue.yaml, a real git repo ---
    mkdirSync(projectPath, { recursive: true });

    writeFileSync(
      join(projectPath, 'PRD.md'),
      '# PRD\n\nREQ-100: a user can log in.\nREQ-101: a user can log out.\n',
      'utf8'
    );
    writeFileSync(join(projectPath, 'BLUEPRINT.md'), '# Blueprint\n\nNo additional requirement ids here.\n', 'utf8');
    writeFileSync(
      join(projectPath, 'queue.yaml'),
      [
        '- id: q-feature-100',
        '  prompt_type: feature',
        '  name: Login feature',
        '  description: Implements REQ-100 login flow.',
        '- id: q-feature-logout',
        '  prompt_type: feature',
        '  name: Logout feature',
        '  description: Implements REQ-101 logout flow.',
        '- id: q-schema-users',
        '  prompt_type: schema',
        '  name: users table',
        '  description: Creates the users table.',
        '',
      ].join('\n'),
      'utf8'
    );

    execFileSync('git', ['init'], { cwd: projectPath, stdio: 'pipe' });
    execFileSync('git', ['add', '.'], { cwd: projectPath, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.email=selftest@forge.local', '-c', 'user.name=FORGE Selftest', 'commit', '-m', 'feat: implement REQ-100 login flow'],
      { cwd: projectPath, stdio: 'pipe' }
    );
    commitHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectPath, encoding: 'utf8' }).trim();

    // --- Build Memory fixtures: an ADR and a risk that motivated REQ-100, plus test evidence ---
    // Written through the real CRUD modules (src/memory/adr.ts, risks.ts, test-results.ts) —
    // the same functions src/governance/provenance-ledgers.ts and TestOrchestrator use in
    // production — rather than hand-rolled SQL, so the fixtures are exactly what a real build
    // would have persisted.
    resetClient();
    const db = getClient();
    assert.ok(db, 'Build Memory client is null — ~/.forge must be writable for this test.');

    const adr = await createAdr({
      project_name: projectName,
      project_path: projectPath,
      adr_number: 1,
      title: 'Adopt session-based auth',
      status: 'accepted',
      context: 'REQ-100 requires users to log in; sessions are the simplest mechanism.',
      decision: 'Use server-side sessions for REQ-100.',
      decided_by: 'selftest',
    });
    assert.ok(adr, 'createAdr returned null — Build Memory write failed');

    const risk = await createRisk({
      project_name: projectName,
      project_path: projectPath,
      title: 'Credential stuffing against REQ-100 login',
      description: 'If REQ-100 login has no rate limiting, credential stuffing is possible.',
      category: 'security',
      probability: 3,
      impact: 4,
      severity_score: 12,
    });
    assert.ok(risk, 'createRisk returned null — Build Memory write failed');

    // UNIT test evidence for REQ-100 (report_path mentions the requirement id).
    const unitRun = await insertTestRunResult({
      build_run_id: null,
      project_name: projectName,
      trigger: 'MANUAL',
      test_suite: 'UNIT',
      runner: 'vitest',
      status: 'passed',
      prompt_index: null,
      tests_total: 5,
      tests_passed: 5,
      tests_failed: 0,
      tests_skipped: 0,
      duration_ms: 100,
      failure_summary: null,
      report_path: 'reports/REQ-100-login.json',
      exit_code: 0,
      machine_id: 'selftest-machine',
    });
    assert.ok(unitRun, 'insertTestRunResult (UNIT) returned null — Build Memory write failed');

    // E2E test evidence for the `q-feature-100` queue entry (report_path mentions the entry id).
    const e2eRun = await insertTestRunResult({
      build_run_id: null,
      project_name: projectName,
      trigger: 'MANUAL',
      test_suite: 'E2E',
      runner: 'playwright',
      status: 'passed',
      prompt_index: null,
      tests_total: 2,
      tests_passed: 2,
      tests_failed: 0,
      tests_skipped: 0,
      duration_ms: 500,
      failure_summary: null,
      report_path: 'reports/q-feature-100-login.e2e.json',
      exit_code: 0,
      machine_id: 'selftest-machine',
    });
    assert.ok(e2eRun, 'insertTestRunResult (E2E) returned null — Build Memory write failed');
  });

  after(() => {
    rmSync(projectPath, { recursive: true, force: true });
    const db = getClient();
    if (!db) return;
    db.prepare('DELETE FROM adr_records WHERE project_name = ?').run(projectName);
    db.prepare('DELETE FROM risks WHERE project_name = ?').run(projectName);
    db.prepare('DELETE FROM test_run_results WHERE project_name = ?').run(projectName);
  });

  // -------------------------------------------------------------------------
  // Bidirectional trace
  // -------------------------------------------------------------------------

  test('traceRequirement: REQ-100 reaches TESTED downstream, with real upstream ADR/risk evidence', async () => {
    const result = await traceRequirement('REQ-100', projectPath);
    assert.equal(result.reqId, 'REQ-100');
    assert.equal(result.stage, 'tested', `expected TESTED, got ${result.stage}`);
    assert.equal(result.deployed, false, 'no build/deployment fixture exists — must not fabricate DEPLOYED');

    assert.equal(result.queueEvidence.length, 1);
    assert.equal(result.queueEvidence[0]!.entryId, 'q-feature-100');

    assert.equal(result.commitEvidence.length, 1);
    assert.equal(result.commitEvidence[0]!.hash, commitHash);

    assert.equal(result.testEvidence.length, 1);
    assert.equal(result.testEvidence[0]!.testSuite, 'UNIT');

    assert.equal(result.adrEvidence.length, 1, 'REQ-100 should trace upstream to the seeded ADR');
    assert.equal(result.adrEvidence[0]!.title, 'Adopt session-based auth');

    assert.equal(result.riskEvidence.length, 1, 'REQ-100 should trace upstream to the seeded risk');
    assert.equal(result.riskEvidence[0]!.title, 'Credential stuffing against REQ-100 login');

    const formatted = formatTraceResult(result);
    assert.match(formatted, /upstream decisions \(ADR\): ADR-001 Adopt session-based auth/);
    assert.match(formatted, /upstream risks: Credential stuffing against REQ-100 login/);
  });

  test('traceRequirement: REQ-101 (planned via the logout feature, never implemented/tested) has no upstream evidence', async () => {
    const result = await traceRequirement('REQ-101', projectPath);
    // The logout feature's description mentions REQ-101, so it IS planned — but no commit
    // implements it and no test references it, so it must not progress past PLANNED, and it
    // must not fabricate an ADR/risk motivation that was never recorded.
    assert.equal(result.stage, 'planned', `expected PLANNED, got ${result.stage}`);
    assert.equal(result.queueEvidence.length, 1);
    assert.equal(result.queueEvidence[0]!.entryId, 'q-feature-logout');
    assert.deepEqual(result.commitEvidence, []);
    assert.deepEqual(result.testEvidence, []);
    assert.deepEqual(result.adrEvidence, []);
    assert.deepEqual(result.riskEvidence, []);
  });

  // -------------------------------------------------------------------------
  // Reverse trace
  // -------------------------------------------------------------------------

  test('traceReverse: a commit hash traces back to REQ-100', async () => {
    const result = await traceReverse(commitHash, projectPath);
    assert.deepEqual(result.matchedRequirementIds, ['REQ-100']);
    assert.match(formatReverseTraceResult(result), /REQ-100 — stage: TESTED/);
  });

  test('traceReverse: a queue entry id traces back to REQ-100', async () => {
    const result = await traceReverse('q-feature-100', projectPath);
    assert.deepEqual(result.matchedRequirementIds, ['REQ-100']);
  });

  test('traceReverse: a test suite name traces back to REQ-100', async () => {
    const result = await traceReverse('UNIT', projectPath);
    assert.deepEqual(result.matchedRequirementIds, ['REQ-100']);
  });

  test('traceReverse: an unrelated identifier traces back to nothing', async () => {
    const result = await traceReverse('no-such-thing-anywhere', projectPath);
    assert.deepEqual(result.matchedRequirementIds, []);
    assert.match(formatReverseTraceResult(result), /no requirement id traces back/);
  });

  // -------------------------------------------------------------------------
  // Untested requirements/features
  // -------------------------------------------------------------------------

  test('findUntestedRequirements: REQ-101 and the logout feature are untested; REQ-100 and the login feature are not', async () => {
    const result = await findUntestedRequirements(projectPath);
    assert.deepEqual(result.untestedRequirements, ['REQ-101']);

    const untestedIds = result.untestedFeatures.map((f) => f.entryId).sort();
    assert.deepEqual(untestedIds, ['q-feature-logout']);

    const formatted = formatUntestedResult(result);
    assert.match(formatted, /Untested requirements \(1\): REQ-101/);
    assert.match(formatted, /Untested features \(1\): q-feature-logout/);
  });

  // -------------------------------------------------------------------------
  // Ontology — real accessors cross-reference the SAME fixtures, no new storage
  // -------------------------------------------------------------------------

  test('ontology: BACKED/PLACEHOLDER kind lists are disjoint and cover all 19 entities', () => {
    const all = [...BACKED_ONTOLOGY_KINDS, ...PLACEHOLDER_ONTOLOGY_KINDS];
    assert.equal(all.length, 19);
    assert.equal(new Set(all).size, 19, 'no kind should appear in both lists');
  });

  test('ontology: listRequirements/listFeatures read the same PRD.md/queue.yaml this file wrote', async () => {
    const requirements = await listRequirements(projectPath);
    assert.deepEqual(
      requirements.map((r) => r.id).sort(),
      ['REQ-100', 'REQ-101']
    );

    const features = await listFeatures(projectPath);
    assert.deepEqual(
      features.map((f) => f.id).sort(),
      ['q-feature-100', 'q-feature-logout']
    );
  });

  test('ontology: listDecisions/listRiskEntities read the same adr_records/risks rows this file seeded', async () => {
    const decisions = await listDecisions(projectName);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.title, 'Adopt session-based auth');

    const risks = await listRiskEntities(projectName);
    assert.equal(risks.length, 1);
    assert.equal(risks[0]!.title, 'Credential stuffing against REQ-100 login');
  });

  test('ontology: listTests reads the same test_run_results rows this file seeded', async () => {
    const tests = await listTests(projectName);
    const suites = tests.map((t) => t.suite).sort();
    assert.deepEqual(suites, ['E2E', 'UNIT']);
  });
});
