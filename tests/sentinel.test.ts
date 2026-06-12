/**
 * FORGE 2.0 — Phase 4 Sentinel + Autonomous Recovery unit test (Sprint 5, s5-p04).
 *
 * Pure `node:test` suite — NO `pnpm`, NO git repo, NO database. Every Sentinel collaborator
 * (the shell runner, the git diff, the schema extractor, the governance-doc contents, and the
 * package.json content) is injected, and the recovery loop's Build Memory reads / prompt re-run /
 * Sentinel re-run are all injected too. Build Memory WRITES inside recovery degrade to no-ops
 * because no FORGE_SUPABASE_* env vars are set (stateless mode, Contract 4) — so the suite runs
 * fully offline.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/sentinel.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runSentinel,
  runAutonomousRecovery,
  toPreviousSentinelStatus,
  parseSchemaRegistry,
  diffSchema,
  parsePackageDependencies,
  parseToolchainDependencies,
  normalizeErrorSignature,
  signatureSimilarity,
  categorizeError,
  type CommandResult,
  type SentinelOptions,
  type SentinelResult,
  type SchemaDriftFinding,
} from '../src/phases/phase4-sentinel.js';
import type { GitFileChange } from '../src/engine/git-manager.js';
import type { SchemaSnapshot, TableSchema } from '../src/tools/schema-extractor.js';
import type { ErrorPattern, Resolution } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCHEMA_REGISTRY_MD = [
  '# FORGE 2.0 — SCHEMA REGISTRY',
  '',
  '## Table: build_runs',
  'Tracks every build.',
  '',
  '| Column | Type | Constraints | Purpose |',
  '|--------|------|-------------|---------|',
  '| id | uuid | PK | Build identifier |',
  '| project_name | text | NOT NULL | Project name |',
  '| total_cost_usd | numeric(10,4) | NOT NULL | Dollar cost |',
  '',
  '## Table: prompt_executions',
  'Per-prompt tracking.',
  '',
  '| Column | Type | Constraints | Purpose |',
  '|--------|------|-------------|---------|',
  '| id | uuid | PK | Execution id |',
  '| prompt_index | int | NOT NULL | Position |',
  '',
  '## Seed Data',
  'Some prose, not a table.',
].join('\n');

const TOOLCHAIN_MD = [
  '# TOOLCHAIN.md',
  '',
  '## Locked Tool Versions',
  '| Tool | Version |',
  '|------|---------|',
  '| node | v20 |',
  '',
  '## Dependencies',
  'Locked npm packages:',
  '- `@supabase/supabase-js`',
  '- `commander`',
  '- `js-yaml`',
].join('\n');

const PACKAGE_JSON = JSON.stringify({
  name: 'demo',
  dependencies: { '@supabase/supabase-js': '^2', commander: '^12' },
  devDependencies: { typescript: '^5' },
});

function makeColumn(name: string, type: string): TableSchema['columns'][number] {
  return { name, type, nullable: true, default: null, constraints: [] };
}

function makeTable(name: string, columns: Array<[string, string]>): TableSchema {
  return {
    name,
    schema: 'public',
    columns: columns.map(([n, t]) => makeColumn(n, t)),
    primaryKey: ['id'],
    foreignKeys: [],
    rlsEnabled: false,
  };
}

function makeSnapshot(tables: TableSchema[]): SchemaSnapshot {
  return { tables, relationships: [], indexes: [], rlsPolicies: [], source: 'live', migrationFiles: [], warnings: [] };
}

/** A snapshot matching the registry exactly (plus one harmless extra column = addition). */
function matchingSnapshot(): SchemaSnapshot {
  return makeSnapshot([
    makeTable('build_runs', [
      ['id', 'uuid'],
      ['project_name', 'text'],
      ['total_cost_usd', 'numeric'],
      ['created_at', 'timestamptz'], // extra → addition (ok)
    ]),
    makeTable('prompt_executions', [
      ['id', 'uuid'],
      ['prompt_index', 'integer'], // int vs integer → normalized equal, NOT a modification
    ]),
  ]);
}

const okCommand: CommandResult = { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false };

/** A Sentinel option set where every collaborator is injected and everything passes. */
function passingOptions(over: Partial<SentinelOptions> = {}): SentinelOptions {
  return {
    projectPath: 'C:/demo',
    schemaPromptsHaveRun: true,
    runCommand: async () => okCommand,
    getFileChanges: async () => [{ status: 'A', path: 'src/new.ts' }],
    extractActualSchema: async () => matchingSnapshot(),
    schemaRegistryContent: SCHEMA_REGISTRY_MD,
    toolchainContent: TOOLCHAIN_MD,
    packageJsonContent: PACKAGE_JSON,
    // Default baseline covers every package.json dep so the Dependency check passes by default;
    // the dependency-specific tests below override it (or set it undefined to exercise parsing).
    baselineDependencies: ['@supabase/supabase-js', 'commander', 'typescript', 'js-yaml'],
    log: () => {},
    ...over,
  };
}

/** The error text runAutonomousRecovery derives from a failing Sentinel result. */
function failingErrorText(r: SentinelResult = failingResult()): string {
  const c = r.checks.find((x) => !x.passed && !x.skipped);
  return c ? `${c.detail}\n${c.output}` : r.diagnosticReport;
}

function makePattern(over: Partial<ErrorPattern>): ErrorPattern {
  return {
    id: 'pat-1',
    error_signature: 'pnpm tsc noemit type error ts<n>',
    error_category: 'type_error',
    error_message_sample: 'error TS2322: Type X is not assignable',
    occurrence_count: 9,
    first_seen_at: '2026-01-01T00:00:00.000Z',
    last_seen_at: '2026-01-01T00:00:00.000Z',
    first_seen_project: 'forge',
    stack_fingerprints: [],
    trigger_phase: 'phase4',
    trigger_prompt_pattern: 'schema',
    resolution_id: 'res-1',
    prevention_rule: 'Add explicit type annotations.',
    success_rate: 0.95,
    auto_resolve_eligible: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function makeResolution(over: Partial<Resolution> = {}): Resolution {
  return {
    id: 'res-1',
    error_pattern_id: 'pat-1',
    resolution_type: 'code_patch',
    resolution_description: 'Apply the known type fix',
    resolution_steps: { commands: [] },
    times_applied: 10,
    times_succeeded: 10,
    times_failed: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function failingResult(failedCheck: SentinelResult['failedCheck'] = 'typescript'): SentinelResult {
  return {
    passed: false,
    failedCheck,
    checks: [
      { name: 'typescript', passed: false, skipped: false, detail: 'pnpm tsc --noEmit failed', output: 'error TS2322: Type string is not assignable to type number', durationMs: 1 },
    ],
    diagnosticReport: '# report',
  };
}

function passingResult(): SentinelResult {
  return { passed: true, failedCheck: null, checks: [], diagnosticReport: '# ok' };
}

// ---------------------------------------------------------------------------
// runSentinel — happy path
// ---------------------------------------------------------------------------

test('runSentinel: all five checks pass with injected collaborators', async () => {
  const result = await runSentinel(passingOptions());
  assert.equal(result.passed, true);
  assert.equal(result.failedCheck, null);
  assert.equal(result.checks.length, 5);
  for (const c of result.checks) {
    assert.equal(c.passed || c.skipped, true, `${c.name} should pass or skip, got fail`);
  }
  // Schema drift evaluated (not skipped) because schemaPromptsHaveRun=true and both sides present.
  const drift = result.checks.find((c) => c.name === 'schema_drift');
  assert.ok(drift && !drift.skipped && drift.passed);
  assert.match(result.diagnosticReport, /PASS/);
});

test('runSentinel: tsc failure fails the gate and short-circuits the rest (stopOnFirstFailure)', async () => {
  const result = await runSentinel(
    passingOptions({
      runCommand: async (cmd) =>
        cmd.includes('tsc')
          ? { ok: false, exitCode: 2, stdout: '', stderr: 'src/x.ts(3,5): error TS2322: Type mismatch', timedOut: false }
          : okCommand,
    })
  );
  assert.equal(result.passed, false);
  assert.equal(result.failedCheck, 'typescript');
  // build + everything after tsc are skipped.
  const build = result.checks.find((c) => c.name === 'build');
  assert.ok(build && build.skipped);
  assert.match(result.diagnosticReport, /FAIL/);
  assert.match(result.diagnosticReport, /TS2322/);
});

test('runSentinel: build failure is reported with full output', async () => {
  const result = await runSentinel(
    passingOptions({
      runCommand: async (cmd) =>
        cmd.includes('run build')
          ? { ok: false, exitCode: 1, stdout: 'Compiling…', stderr: 'Build failed: webpack error', timedOut: false }
          : okCommand,
    })
  );
  assert.equal(result.passed, false);
  assert.equal(result.failedCheck, 'build');
  assert.match(result.diagnosticReport, /webpack error/);
});

test('runSentinel: a timed-out command fails with a TIMEOUT detail', async () => {
  const result = await runSentinel(
    passingOptions({
      runCommand: async (cmd) =>
        cmd.includes('tsc') ? { ok: false, exitCode: null, stdout: '', stderr: '', timedOut: true } : okCommand,
    })
  );
  assert.equal(result.failedCheck, 'typescript');
  const tsc = result.checks.find((c) => c.name === 'typescript');
  assert.match(tsc?.detail ?? '', /TIMED OUT/);
});

// ---------------------------------------------------------------------------
// File Integrity
// ---------------------------------------------------------------------------

test('file integrity: a modified protected governance doc fails', async () => {
  const result = await runSentinel(
    passingOptions({
      stopOnFirstFailure: false,
      getFileChanges: async () => [{ status: 'M', path: 'governance/SCHEMA_REGISTRY.md' }],
    })
  );
  const fi = result.checks.find((c) => c.name === 'file_integrity');
  assert.ok(fi && !fi.passed && !fi.skipped);
  assert.match(fi.output, /protected governance file changed/);
  assert.equal(result.passed, false);
});

test('file integrity: an unexpected deletion fails; an allowed deletion passes', async () => {
  const del = async (): Promise<GitFileChange[]> => [{ status: 'D', path: 'src/old.ts' }];

  const failed = await runSentinel(passingOptions({ stopOnFirstFailure: false, getFileChanges: del }));
  const fi1 = failed.checks.find((c) => c.name === 'file_integrity');
  assert.ok(fi1 && !fi1.passed && !fi1.skipped);
  assert.match(fi1.output, /unexpected deletion/);

  const allowed = await runSentinel(
    passingOptions({ stopOnFirstFailure: false, getFileChanges: del, allowedDeletions: ['old.ts'] })
  );
  const fi2 = allowed.checks.find((c) => c.name === 'file_integrity');
  assert.ok(fi2 && fi2.passed);
});

test('file integrity: STATE_OF_THE_BUILD.md / SESSION_STATE.md changes are allowed (not protected)', async () => {
  const result = await runSentinel(
    passingOptions({
      getFileChanges: async () => [
        { status: 'M', path: 'governance/STATE_OF_THE_BUILD.md' },
        { status: 'M', path: 'governance/SESSION_STATE.md' },
      ],
    })
  );
  assert.equal(result.passed, true);
});

test('file integrity: a null diff (no repo) is SKIPPED, not failed', async () => {
  const result = await runSentinel(passingOptions({ getFileChanges: async () => null }));
  const fi = result.checks.find((c) => c.name === 'file_integrity');
  assert.ok(fi && fi.skipped);
  assert.equal(result.passed, true); // skip doesn't fail the gate
});

// ---------------------------------------------------------------------------
// Schema Drift
// ---------------------------------------------------------------------------

test('schema drift: skipped when no schema prompts have run', async () => {
  const result = await runSentinel(passingOptions({ schemaPromptsHaveRun: false }));
  const drift = result.checks.find((c) => c.name === 'schema_drift');
  assert.ok(drift && drift.skipped);
  assert.match(drift.detail, /no schema prompts/);
});

test('schema drift: a missing table (deletion) fails', async () => {
  const result = await runSentinel(
    passingOptions({
      stopOnFirstFailure: false,
      extractActualSchema: async () =>
        makeSnapshot([makeTable('build_runs', [['id', 'uuid'], ['project_name', 'text'], ['total_cost_usd', 'numeric']])]),
      // prompt_executions table is absent → deletion → fail
    })
  );
  const drift = result.checks.find((c) => c.name === 'schema_drift');
  assert.ok(drift && !drift.passed && !drift.skipped);
  assert.match(drift.output, /prompt_executions.*missing/);
});

test('schema drift: empty actual schema is SKIPPED (cannot compare), not failed', async () => {
  const result = await runSentinel(passingOptions({ extractActualSchema: async () => makeSnapshot([]) }));
  const drift = result.checks.find((c) => c.name === 'schema_drift');
  assert.ok(drift && drift.skipped);
});

test('diffSchema: type modification is flagged; additions are not breaking', () => {
  const expected = parseSchemaRegistry(SCHEMA_REGISTRY_MD);
  const actual = makeSnapshot([
    makeTable('build_runs', [['id', 'uuid'], ['project_name', 'boolean'], ['total_cost_usd', 'numeric']]),
    makeTable('prompt_executions', [['id', 'uuid'], ['prompt_index', 'integer'], ['extra_col', 'text']]),
  ]);
  const findings: SchemaDriftFinding[] = diffSchema(expected, actual);
  const mods = findings.filter((f) => f.kind === 'modification');
  const adds = findings.filter((f) => f.kind === 'addition');
  assert.equal(mods.length, 1); // project_name text → boolean
  assert.match(mods[0]?.detail ?? '', /project_name/);
  assert.ok(adds.some((f) => /extra_col/.test(f.detail)));
});

// ---------------------------------------------------------------------------
// Dependency Check
// ---------------------------------------------------------------------------

test('dependency check: a new dep not in the manifest fails', async () => {
  const pkg = JSON.stringify({ dependencies: { '@supabase/supabase-js': '^2', commander: '^12', leftpad: '^1' } });
  const result = await runSentinel(
    passingOptions({ stopOnFirstFailure: false, packageJsonContent: pkg, baselineDependencies: ['@supabase/supabase-js', 'commander', 'js-yaml'] })
  );
  const dep = result.checks.find((c) => c.name === 'dependencies');
  assert.ok(dep && !dep.passed && !dep.skipped);
  assert.match(dep.detail, /leftpad/);
});

test('dependency check: baseline parsed from TOOLCHAIN.md flags an unmanifested dep', async () => {
  // PACKAGE_JSON deps: @supabase/supabase-js, commander, typescript(dev).
  // TOOLCHAIN baseline: @supabase/supabase-js, commander, js-yaml → typescript is NEW → fail.
  const result = await runSentinel(passingOptions({ stopOnFirstFailure: false, baselineDependencies: undefined }));
  const dep = result.checks.find((c) => c.name === 'dependencies');
  assert.ok(dep && !dep.skipped);
  assert.match(dep.detail, /typescript/); // typescript not in TOOLCHAIN baseline
});

test('dependency check: skipped when no baseline is available', async () => {
  const result = await runSentinel(passingOptions({ baselineDependencies: undefined, toolchainContent: '# TOOLCHAIN\nNo deps section here.' }));
  const dep = result.checks.find((c) => c.name === 'dependencies');
  assert.ok(dep && dep.skipped);
});

test('parsePackageDependencies / parseToolchainDependencies parse the expected names', () => {
  assert.deepEqual(parsePackageDependencies(PACKAGE_JSON), ['@supabase/supabase-js', 'commander', 'typescript']);
  assert.deepEqual(parseToolchainDependencies(TOOLCHAIN_MD), ['@supabase/supabase-js', 'commander', 'js-yaml']);
});

// ---------------------------------------------------------------------------
// parseSchemaRegistry
// ---------------------------------------------------------------------------

test('parseSchemaRegistry: extracts tables and their columns, ignoring prose sections', () => {
  const tables = parseSchemaRegistry(SCHEMA_REGISTRY_MD);
  const names = tables.map((t) => t.name);
  assert.deepEqual(names, ['build_runs', 'prompt_executions', 'seed_data'].filter((n) => names.includes(n)));
  const build = tables.find((t) => t.name === 'build_runs');
  assert.ok(build);
  assert.deepEqual([...build.columns.keys()], ['id', 'project_name', 'total_cost_usd']);
  assert.equal(build.columns.get('total_cost_usd'), 'numeric(10,4)');
  // The "Seed Data" prose section yields no columns.
  const seed = tables.find((t) => t.name === 'seed_data');
  assert.ok(!seed || seed.columns.size === 0);
});

// ---------------------------------------------------------------------------
// Error normalization helpers
// ---------------------------------------------------------------------------

test('normalizeErrorSignature: strips paths / numbers / quotes deterministically', () => {
  const a = normalizeErrorSignature("C:\\proj\\src\\x.ts(12,3): error TS2322: Type 'string' is not assignable");
  const b = normalizeErrorSignature("C:\\other\\y.ts(99,1): error TS2322: Type 'number' is not assignable");
  assert.equal(a, b); // same class of error → identical signature
  assert.match(a, /<path>: error ts2322: type <str> is not assignable/);
});

test('signatureSimilarity: identical strings → 1, disjoint → 0', () => {
  assert.equal(signatureSimilarity('cannot find module foo', 'cannot find module foo'), 1);
  assert.equal(signatureSimilarity('alpha beta', 'gamma delta'), 0);
  assert.ok(signatureSimilarity('cannot find module foo', 'cannot find module bar') > 0.4);
});

test('categorizeError: maps each failing check to its category', () => {
  assert.equal(categorizeError('typescript', ''), 'type_error');
  assert.equal(categorizeError('build', ''), 'build_failure');
  assert.equal(categorizeError('schema_drift', ''), 'schema');
  assert.equal(categorizeError('dependencies', ''), 'dependency');
  assert.equal(categorizeError(null, 'Cannot find module x'), 'dependency');
});

// ---------------------------------------------------------------------------
// toPreviousSentinelStatus
// ---------------------------------------------------------------------------

test('toPreviousSentinelStatus: surfaces failed-check descriptions for the next prompt', () => {
  const status = toPreviousSentinelStatus(failingResult('typescript'), 'Schema migrations', 4);
  assert.equal(status.passed, false);
  assert.equal(status.promptName, 'Schema migrations');
  assert.equal(status.promptIndex, 4);
  assert.ok(status.failures && status.failures.some((f) => /typescript/.test(f)));
});

// ---------------------------------------------------------------------------
// Autonomous Recovery (Contract 14)
// ---------------------------------------------------------------------------

test('recovery: disabled mode escalates without attempting', async () => {
  const result = await runAutonomousRecovery(failingResult(), {
    autonomousRecoveryMode: false,
    rerunPrompt: async () => ({ success: true, output: '' }),
    rerunSentinel: async () => passingResult(),
    log: () => {},
  });
  assert.equal(result.enabled, false);
  assert.equal(result.attempted, false);
  assert.equal(result.escalated, true);
  assert.match(result.reason, /disabled/);
});

test('recovery: a novel error (no eligible pattern) escalates to human', async () => {
  const result = await runAutonomousRecovery(failingResult(), {
    autonomousRecoveryMode: true,
    rerunPrompt: async () => ({ success: true, output: '' }),
    rerunSentinel: async () => passingResult(),
    fetchAutoResolvable: async () => [], // nothing matches
    log: () => {},
  });
  assert.equal(result.attempted, true);
  assert.equal(result.recovered, false);
  assert.equal(result.escalated, true);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]?.matchedPattern, null);
  assert.match(result.reason, /[Nn]ovel/);
});

test('recovery: a pattern with success_rate > 0.90 is applied, prompt re-run, Sentinel green → recovered', async () => {
  let appliedResolution = false;
  let promptReran = false;
  const result = await runAutonomousRecovery(failingResult('typescript'), {
    autonomousRecoveryMode: true,
    fetchAutoResolvable: async () => [makePattern({ error_signature: normalizeErrorSignature(failingErrorText()) })],
    fetchResolution: async () => makeResolution(),
    applyResolution: async () => {
      appliedResolution = true;
      return true;
    },
    rerunPrompt: async () => {
      promptReran = true;
      return { success: true, output: 'fixed' };
    },
    rerunSentinel: async () => passingResult(),
    promptExecutionId: null,
    log: () => {},
  });
  assert.equal(appliedResolution, true);
  assert.equal(promptReran, true);
  assert.equal(result.recovered, true);
  assert.equal(result.escalated, false);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]?.matchedPattern?.id, 'pat-1');
  assert.equal(result.finalSentinel.passed, true);
});

test('recovery: a pattern at exactly 0.90 is NOT eligible (strictly greater required)', async () => {
  const result = await runAutonomousRecovery(failingResult(), {
    autonomousRecoveryMode: true,
    fetchAutoResolvable: async () => [
      makePattern({ success_rate: 0.9, error_signature: normalizeErrorSignature(failingErrorText()) }),
    ],
    rerunPrompt: async () => ({ success: true, output: '' }),
    rerunSentinel: async () => passingResult(),
    log: () => {},
  });
  assert.equal(result.recovered, false);
  assert.equal(result.escalated, true); // treated as novel (no eligible pattern)
});

test('recovery: still-failing Sentinel exhausts the 2-attempt cap, then escalates', async () => {
  let attempts = 0;
  const result = await runAutonomousRecovery(failingResult(), {
    autonomousRecoveryMode: true,
    fetchAutoResolvable: async () => [makePattern({ error_signature: normalizeErrorSignature(failingErrorText()) })],
    fetchResolution: async () => makeResolution(),
    applyResolution: async () => true,
    rerunPrompt: async () => {
      attempts++;
      return { success: false, output: 'still broken' };
    },
    rerunSentinel: async () => failingResult(), // never recovers
    log: () => {},
  });
  assert.equal(attempts, 2);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.recovered, false);
  assert.equal(result.escalated, true);
  assert.match(result.reason, /Exhausted 2/);
});

test('recovery: an already-passing Sentinel is a no-op', async () => {
  const result = await runAutonomousRecovery(passingResult(), {
    autonomousRecoveryMode: true,
    rerunPrompt: async () => ({ success: true, output: '' }),
    rerunSentinel: async () => passingResult(),
    log: () => {},
  });
  assert.equal(result.attempted, false);
  assert.equal(result.recovered, true);
  assert.equal(result.escalated, false);
});
