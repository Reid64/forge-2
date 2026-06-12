/**
 * FORGE 2.0 — Schema Validator tests (post-queue session #45).
 *
 * Pure `node:test` — no network, no Build Memory. The failure sink (store) and the
 * clock are injected, so every assertion is deterministic and offline.
 *
 * HOW TO RUN (from a permitted session):
 *   pnpm add zod            # zod is statically imported — required for compile + run
 *   node --import tsx --test tests/schema-validator.test.ts
 *
 * Node 20 cannot execute TypeScript natively and src/ uses NodeNext `.js` import
 * specifiers that resolve to `.ts` sources — the `tsx` loader handles both.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validate,
  validateAndReport,
  validateApiResponse,
  validateConfigFile,
  validateMemoryWrite,
  validateMemoryRow,
  rowValidator,
  formatIssues,
  summarizeIssues,
  ValidationReport,
  BuildRunSchema,
  ProductionTelemetrySchema,
  JsonSchema,
  JsonObjectSchema,
  MEMORY_TABLE_SCHEMAS,
  MEMORY_INSERT_SCHEMAS,
  z,
  type ValidationFailureRecord,
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
  sentinel_interventions: 0,
  autonomous_recovery_mode: false,
  parallel_prompts_used: false,
  dry_run: false,
  created_at: '2026-06-11T00:00:00.000Z',
};

/** Capturing store + clock for deterministic failure assertions. */
function makeStore(): {
  store: (r: ValidationFailureRecord) => Promise<void>;
  records: ValidationFailureRecord[];
} {
  const records: ValidationFailureRecord[] = [];
  return {
    records,
    store: async (r: ValidationFailureRecord): Promise<void> => {
      records.push(r);
    },
  };
}

/** Let the fire-and-forget store microtask/macrotask settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const fixedClock = (): string => '2026-06-11T12:00:00.000Z';

// --- validate(): core -------------------------------------------------------

test('validate() accepts a well-formed row', () => {
  const result = validate(BuildRunSchema, validBuildRun);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.project_name, 'tarritrix');
    assert.deepEqual(result.issues, []);
  }
});

test('validate() rejects a wrong-typed field with a clear, path-pointed issue', () => {
  const bad = { ...validBuildRun, total_prompts: 'thirty' };
  const result = validate(BuildRunSchema, bad);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === 'total_prompts'));
    assert.match(result.error, /total_prompts/);
  }
});

test('validate() rejects an out-of-set enum value', () => {
  const bad = { ...validBuildRun, status: 'in_progress' };
  const result = validate(BuildRunSchema, bad);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === 'status'));
  }
});

test('validate() rejects a missing required field', () => {
  const { machine_id, ...withoutMachine } = validBuildRun;
  void machine_id;
  const result = validate(BuildRunSchema, withoutMachine);
  assert.equal(result.ok, false);
});

test('validate() never throws on non-object input', () => {
  for (const input of [null, undefined, 42, 'x', []]) {
    const result = validate(BuildRunSchema, input);
    assert.equal(result.ok, false);
  }
});

// --- Json / JsonObject recursion -------------------------------------------

test('JsonSchema accepts deeply nested JSON and rejects non-JSON', () => {
  assert.equal(validate(JsonSchema, { a: [1, 'two', { b: null }, false] }).ok, true);
  assert.equal(validate(JsonSchema, 'plain string').ok, true);
  assert.equal(validate(JsonSchema, () => 1).ok, false);
  assert.equal(validate(JsonSchema, undefined).ok, false);
});

test('JsonObjectSchema requires an object, not an array or scalar', () => {
  assert.equal(validate(JsonObjectSchema, { k: 1 }).ok, true);
  assert.equal(validate(JsonObjectSchema, [1, 2]).ok, false);
  assert.equal(validate(JsonObjectSchema, 'x').ok, false);
});

// --- issue formatting -------------------------------------------------------

test('formatIssues marks the root path as (root) and joins nested paths with dots', () => {
  const scalar = JsonObjectSchema.safeParse('not an object');
  assert.equal(scalar.success, false);
  if (!scalar.success) {
    assert.equal(formatIssues(scalar.error)[0]?.path, '(root)');
  }

  const nested = z.object({ outer: z.object({ inner: z.number() }) }).safeParse({
    outer: { inner: 'no' },
  });
  assert.equal(nested.success, false);
  if (!nested.success) {
    assert.equal(formatIssues(nested.error)[0]?.path, 'outer.inner');
  }
});

test('summarizeIssues caps the list and reports an overflow count', () => {
  const issues = Array.from({ length: 8 }, (_unused, i) => ({
    path: `f${i}`,
    code: 'invalid_type',
    message: 'bad',
  }));
  const summary = summarizeIssues(issues);
  assert.match(summary, /8 validation error/);
  assert.match(summary, /\+3 more/);
  assert.equal(summarizeIssues([]), 'valid');
});

// --- external API response (integration point 1) ----------------------------

test('validateApiResponse logs a failure to the injected store, fire-and-forget', async () => {
  const { store, records } = makeStore();
  const result = validateApiResponse(BuildRunSchema, { id: 'x' }, {
    context: 'unit:api',
    target: 'fake-service',
    store,
    clock: fixedClock,
  });
  assert.equal(result.ok, false);
  await tick();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.source, 'api_response');
  assert.equal(records[0]?.target, 'fake-service');
  assert.equal(records[0]?.occurredAt, '2026-06-11T12:00:00.000Z');
  assert.ok((records[0]?.issueCount ?? 0) > 0);
});

test('validateApiResponse does NOT log when the response is valid', async () => {
  const { store, records } = makeStore();
  const result = validateApiResponse(BuildRunSchema, validBuildRun, {
    context: 'unit:api',
    store,
  });
  assert.equal(result.ok, true);
  await tick();
  assert.equal(records.length, 0);
});

test('report:false suppresses logging even on failure', async () => {
  const { store, records } = makeStore();
  validateAndReport('internal', BuildRunSchema, {}, {
    context: 'unit:silent',
    store,
    report: false,
  });
  await tick();
  assert.equal(records.length, 0);
});

// --- config file (integration point 2) --------------------------------------

test('validateConfigFile returns a clear operator-facing message', async () => {
  const ConfigSchema = z.object({
    port: z.number(),
    name: z.string(),
  });
  const { store, records } = makeStore();
  const result = validateConfigFile(ConfigSchema, { port: 'nope', name: 7 }, {
    context: 'providers.yaml',
    store,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /port/);
  }
  await tick();
  assert.equal(records[0]?.source, 'config_file');
});

// --- Build Memory write (integration point 3) -------------------------------

test('validateMemoryWrite accepts a legitimately-partial insert payload', async () => {
  const { store, records } = makeStore();
  // A telemetry insert omits id/created_at (DB defaults) — must still validate.
  const result = validateMemoryWrite(
    'production_telemetry',
    { project_name: 'forge', event_type: 'usage', event_data: { k: 1 } },
    { store }
  );
  assert.equal(result.ok, true);
  await tick();
  assert.equal(records.length, 0);
});

test('validateMemoryWrite rejects a wrong-typed present field', async () => {
  const { store, records } = makeStore();
  const result = validateMemoryWrite(
    'build_runs',
    { project_name: 'forge', total_prompts: 'lots' },
    { store }
  );
  assert.equal(result.ok, false);
  await tick();
  assert.equal(records[0]?.source, 'memory_write');
  assert.equal(records[0]?.target, 'build_runs');
});

test('validateMemoryRow validates a full row against its table schema', () => {
  assert.equal(validateMemoryRow('build_runs', validBuildRun).ok, true);
  assert.equal(validateMemoryRow('build_runs', { id: 'only' }).ok, false);
});

test('every table has both a full-row and an insert schema', () => {
  const tables = Object.keys(MEMORY_TABLE_SCHEMAS);
  assert.equal(tables.length, 11);
  for (const t of tables) {
    assert.ok(MEMORY_INSERT_SCHEMAS[t as keyof typeof MEMORY_INSERT_SCHEMAS]);
  }
});

// --- rowValidator (memory/client.ts seam) -----------------------------------

test('rowValidator returns [] when valid and clear strings when not', () => {
  const check = rowValidator(ProductionTelemetrySchema);
  assert.deepEqual(
    check({
      id: 't1',
      project_name: 'forge',
      build_run_id: null,
      event_type: 'usage',
      event_data: {},
      severity: null,
      captured_at: 'now',
      fed_back_to_build: null,
      created_at: 'now',
    }),
    []
  );
  const issues = check({ id: 't1' });
  assert.ok(issues.length > 0);
  assert.ok(issues.every((s) => typeof s === 'string' && s.includes(':')));
});

// --- ValidationReport -------------------------------------------------------

test('ValidationReport aggregates checks, awaits the store, and summarizes', async () => {
  const { store, records } = makeStore();
  const report = new ValidationReport(store, fixedClock);

  await report.check('api_response', BuildRunSchema, validBuildRun, {
    context: 'c1',
    target: 'build_runs',
  });
  await report.check('memory_write', BuildRunSchema, { id: 'bad' }, {
    context: 'c2',
    target: 'build_runs',
  });

  assert.equal(report.totalChecks, 2);
  assert.equal(report.failureCount, 1);
  assert.equal(report.passed, false);
  assert.equal(records.length, 1); // store is awaited inside check()
  assert.equal(records[0]?.occurredAt, '2026-06-11T12:00:00.000Z');
  assert.match(report.summary(), /2 validation\(s\) — 1 failed/);
});

test('ValidationReport with no failures reports all passed', async () => {
  const report = new ValidationReport(makeStore().store);
  await report.check('memory_read', BuildRunSchema, validBuildRun, { context: 'ok' });
  assert.equal(report.passed, true);
  assert.match(report.summary(), /all passed/);
});
