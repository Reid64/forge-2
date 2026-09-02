/**
 * FORGE 2.0 — Schema Validator tests.
 *
 * Rewritten against the real `src/tools/schema-validator.ts` API (Finding A-2 / audit item 2):
 * the previous version of this file imported 12 names — `validate`, `JsonObjectSchema`,
 * `MEMORY_TABLE_SCHEMAS`, `ValidationReport`, `rowValidator`, etc. — that never existed anywhere
 * in the module (confirmed via `git log --follow`: no commit ever removed them). The module
 * shipped a narrower, purpose-built API instead: three non-throwing boundary validators
 * (`validateConfigFile`/`validateApiResponse`/`validateMemoryWrite`), a handful of domain Zod
 * schemas, and a separate live-vs-TypeScript schema-drift detector. This file tests that real API.
 *
 * Pure `node:test` — no network for the validator wrappers (they never throw and never touch the
 * network); `detectSchemaDrift` is exercised with a monkey-patched `globalThis.fetch` and a real
 * temp file (it has no injectable fetch/fs seam, unlike every other collaborator in this codebase).
 *
 * HOW TO RUN
 *     node --import tsx --test tests/schema-validator.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  z,
  validateConfigFile,
  validateApiResponse,
  validateMemoryWrite,
  BuildRunSchema,
  AnthropicMessagesResponseSchema,
  OpenAIChatResponseSchema,
  detectSchemaDrift,
  type ValidationResult,
} from '../src/tools/schema-validator.js';

// --- fixtures ---------------------------------------------------------------

const validBuildRun = {
  id: 'b1',
  project_name: 'tarritrix',
  project_path: 'D:/projects/tarritrix',
  stack_fingerprint: { framework: 'next', db: 'supabase' },
  status: 'queued',
  started_at: null,
  completed_at: null,
  total_prompts: 30,
  completed_prompts: 0,
  failed_prompts: 0,
  total_errors: 0,
  total_tokens: 0,
  total_cost_usd: 0,
  machine_id: 'machine-x',
  toolchain_manifest: {},
  governance_hash: null,
  queue_hash: null,
  bundle_sizes: null,
  sentinel_interventions: 0,
  autonomous_recovery_mode: false,
  parallel_prompts_used: false,
  dry_run: false,
  created_at: '2026-06-11T00:00:00.000Z',
};

// --- validateConfigFile -------------------------------------------------------

test('validateConfigFile accepts a well-formed value', () => {
  const result = validateConfigFile(BuildRunSchema, validBuildRun, { context: 'unit:config', report: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('validateConfigFile rejects a wrong-typed field with a path-pointed issue', () => {
  const bad = { ...validBuildRun, total_prompts: 'thirty' };
  const result = validateConfigFile(BuildRunSchema, bad, { context: 'unit:config', report: false });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === 'total_prompts'));
});

test('validateConfigFile rejects an out-of-set enum value', () => {
  const bad = { ...validBuildRun, status: 'in_progress' };
  const result = validateConfigFile(BuildRunSchema, bad, { context: 'unit:config', report: false });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === 'status'));
});

test('validateConfigFile rejects a missing required field', () => {
  const { machine_id, ...withoutMachine } = validBuildRun;
  void machine_id;
  const result = validateConfigFile(BuildRunSchema, withoutMachine, { context: 'unit:config', report: false });
  assert.equal(result.ok, false);
});

test('validateConfigFile never throws on non-object input', () => {
  for (const input of [null, undefined, 42, 'x', []]) {
    const result = validateConfigFile(BuildRunSchema, input, { context: 'unit:config', report: false });
    assert.equal(result.ok, false);
  }
});

test('validateConfigFile marks the root path as (root) for a top-level type mismatch', () => {
  const ConfigSchema = z.object({ port: z.number() });
  const result = validateConfigFile(ConfigSchema, 'not an object', { context: 'unit:config', report: false });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0]?.path, '(root)');
});

test('validateConfigFile joins nested paths with dots', () => {
  const NestedSchema = z.object({ outer: z.object({ inner: z.number() }) });
  const result = validateConfigFile(NestedSchema, { outer: { inner: 'no' } }, { context: 'unit:config', report: false });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0]?.path, 'outer.inner');
});

test('validateConfigFile with report unset (default true) still returns the result without throwing', () => {
  // report defaults to true — this exercises the real logger.warn() code path, not just the
  // report:false short-circuit every other test in this file uses to keep output quiet.
  const result: ValidationResult = validateConfigFile(BuildRunSchema, { id: 'x' }, { context: 'unit:config-default' });
  assert.equal(result.ok, false);
  assert.ok(result.issues.length > 0);
});

// --- validateApiResponse ------------------------------------------------------

test('validateApiResponse reports issues for a malformed body', () => {
  const result = validateApiResponse(BuildRunSchema, { id: 'x' }, {
    context: 'unit:api',
    target: 'fake-service',
    report: false,
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.length > 0);
});

test('validateApiResponse accepts a well-formed body', () => {
  const result = validateApiResponse(BuildRunSchema, validBuildRun, { context: 'unit:api', report: false });
  assert.equal(result.ok, true);
});

test('validateApiResponse: AnthropicMessagesResponseSchema is deliberately lenient (sparse body still valid)', () => {
  const sparse = { id: 'msg_1' };
  const result = validateApiResponse(AnthropicMessagesResponseSchema, sparse, { context: 'unit:anthropic', report: false });
  assert.equal(result.ok, true);
});

test('validateApiResponse: AnthropicMessagesResponseSchema still rejects a wrong-typed known field', () => {
  const bad = { usage: { input_tokens: 'lots' } };
  const result = validateApiResponse(AnthropicMessagesResponseSchema, bad, { context: 'unit:anthropic', report: false });
  assert.equal(result.ok, false);
});

test('validateApiResponse: OpenAIChatResponseSchema is deliberately lenient (sparse body still valid)', () => {
  const sparse = { id: 'chatcmpl_1' };
  const result = validateApiResponse(OpenAIChatResponseSchema, sparse, { context: 'unit:openai', report: false });
  assert.equal(result.ok, true);
});

test('validateApiResponse: OpenAIChatResponseSchema still rejects a wrong-typed known field', () => {
  const bad = { choices: [{ index: 'zero' }] };
  const result = validateApiResponse(OpenAIChatResponseSchema, bad, { context: 'unit:openai', report: false });
  assert.equal(result.ok, false);
});

// --- validateMemoryWrite -------------------------------------------------------

test('validateMemoryWrite accepts any non-null object (no per-table schema is registered here)', () => {
  // Per the module's own doc comment: the CRUD layer owns row shapes; this seam only asserts
  // "is this a plausible record at all" to avoid an import cycle back into memory/.
  const result = validateMemoryWrite('production_telemetry', { project_name: 'forge', event_type: 'usage' }, { context: 'unit:memory', report: false });
  assert.equal(result.ok, true);
});

test('validateMemoryWrite rejects non-object input', () => {
  for (const input of [null, undefined, 42, 'x', []]) {
    const result = validateMemoryWrite('build_runs', input, { context: 'unit:memory', report: false });
    assert.equal(result.ok, false);
  }
});

// --- BuildRunSchema domain shape ----------------------------------------------

test('BuildRunSchema round-trips a real build_runs row via safeParse', () => {
  const parsed = BuildRunSchema.safeParse(validBuildRun);
  assert.equal(parsed.success, true);
});

// --- detectSchemaDrift / autoRegenerateTypes (live schema vs TS types) --------

test('detectSchemaDrift: missing/extra tables and columns are reported with correct severity', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'forge-schema-drift-'));
  const typesPath = join(tmpDir, 'database.ts');
  // A minimal Supabase-generated-shape types file: `users` table with `id`/`name`; the live DB
  // (mocked below) also has a `posts` table this file never declares, and is missing `email`.
  writeFileSync(
    typesPath,
    [
      'export interface Database {',
      '  public: {',
      '    Tables: {',
      '      users: {',
      '        Row: {',
      '          id: string;',
      '          name: string;',
      '          email: string;',
      '        };',
      '      };',
      '    };',
      '  };',
      '}',
      '',
    ].join('\n')
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/rpc/get_custom_enums')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    // columns query — `users` matches TS exactly except missing `email`; `posts` has no TS type.
    const rows = [
      { table_name: 'users', column_name: 'id', data_type: 'text', is_nullable: 'NO', column_default: null },
      { table_name: 'users', column_name: 'name', data_type: 'text', is_nullable: 'NO', column_default: null },
      { table_name: 'posts', column_name: 'id', data_type: 'text', is_nullable: 'NO', column_default: null },
    ];
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;

  try {
    const report = await detectSchemaDrift('https://fake.supabase.co', 'fake-key', typesPath);
    assert.equal(report.hasDrift, true);

    const missingTable = report.issues.find((i) => i.issueType === 'missing_table' && i.table === 'posts');
    assert.ok(missingTable, 'posts (live-only table) reported as missing_table');
    assert.equal(missingTable?.severity, 'error');

    const extraTable = report.issues.find((i) => i.issueType === 'extra_table' && i.table === 'users');
    assert.equal(extraTable, undefined, 'users exists live too, so it is not an extra_table');

    const extraColumn = report.issues.find((i) => i.issueType === 'extra_column' && i.column === 'email');
    assert.ok(extraColumn, 'email (TS-only column) reported as extra_column');
    assert.equal(extraColumn?.severity, 'warning');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('detectSchemaDrift: identical live schema and TS types report no drift', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'forge-schema-drift-'));
  const typesPath = join(tmpDir, 'database.ts');
  writeFileSync(
    typesPath,
    ['export interface Database {', '  public: {', '    Tables: {', '      users: {', '        Row: {', '          id: string;', '        };', '      };', '    };', '  };', '}', ''].join('\n')
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/rpc/get_custom_enums')) return new Response(JSON.stringify([]), { status: 200 });
    return new Response(
      JSON.stringify([{ table_name: 'users', column_name: 'id', data_type: 'text', is_nullable: 'NO', column_default: null }]),
      { status: 200 }
    );
  }) as typeof fetch;

  try {
    const report = await detectSchemaDrift('https://fake.supabase.co', 'fake-key', typesPath);
    assert.equal(report.hasDrift, false);
    assert.deepEqual(report.issues, []);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('autoRegenerateTypes throws a clear error when supabase/config.toml is absent', async () => {
  const { autoRegenerateTypes } = await import('../src/tools/schema-validator.js');
  const tmpDir = mkdtempSync(join(tmpdir(), 'forge-autoregen-'));
  try {
    await assert.rejects(() => autoRegenerateTypes(tmpDir), /Cannot determine Supabase project ref/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
