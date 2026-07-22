/**
 * FORGE 2.0 — Schema validation seam (`schema-validator`).
 *
 * Iron Law 8: validate external/boundary data before acting on it. Every wrapper here is a THIN
 * adapter over a Zod `safeParse` — it never throws and never blocks. A shape mismatch is reported
 * as structured drift on the `forge-validation` log channel (or, for config, returned to the
 * caller), while the caller's existing tolerant read still runs. This keeps validation a
 * non-blocking guard rail, not a gate.
 *
 * The module re-exports {@link z} so callers declare their schemas from a single Zod instance, and
 * ships the two external wire contracts ({@link AnthropicMessagesResponseSchema},
 * {@link OpenAIChatResponseSchema}) the provider router validates — deliberately lenient (all
 * fields optional) so a sparse-but-valid body is never rejected.
 *
 * BOUNDARY: this module reaches OUT to the logger only; it imports no memory/CRUD module, so it
 * introduces no import cycle.
 */

import { readFile, writeFile } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';
import { getLogger } from './forge-logger.js';

const execAsync = promisify(exec);

export { z };

/** A single field-level validation problem. */
export interface ValidationIssue {
  path: string;
  message: string;
}

/** Result of a non-throwing validation. `issues` is empty when `ok` is true. */
export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** Reporting context shared by the boundary validators. */
export interface ValidateOptions {
  /** Where the validation happened — e.g. `provider-router:anthropic`. */
  context: string;
  /** What was being validated — e.g. `anthropic-messages`, `.env`. */
  target?: string;
  /**
   * When true (default) drift is logged to the `forge-validation` channel. Set false to suppress
   * logging and rely solely on the returned `issues` (config load does this — Build Memory may not
   * be reachable yet).
   */
  report?: boolean;
}

function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}

/** Run a schema against a value without throwing, returning a flat `{ ok, issues }` result. */
function check<T>(schema: z.ZodType<T>, value: unknown): ValidationResult {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, issues: [] };
  return { ok: false, issues: toIssues(parsed.error) };
}

/** Emit validation drift to the dedicated `forge-validation` channel. Never throws. */
function reportDrift(result: ValidationResult, options: ValidateOptions): void {
  if (result.ok || options.report === false) return;
  const summary = result.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
  getLogger('forge-validation').warn(
    { context: options.context, target: options.target, issues: result.issues },
    `validation drift in ${options.target ?? 'payload'} (${options.context}) — ${summary}`
  );
}

/**
 * Validate a parsed config object. NON-BLOCKING: returns `{ ok, issues }` for the caller to surface
 * as warnings; with `report: false` it does not touch the log channel.
 */
export function validateConfigFile<T>(
  schema: z.ZodType<T>,
  value: unknown,
  options: ValidateOptions
): ValidationResult {
  const result = check(schema, value);
  reportDrift(result, options);
  return result;
}

/**
 * Validate an external API response body before reading it. NON-BLOCKING: logs drift to
 * `forge-validation` and returns the result; the caller's tolerant read runs regardless.
 */
export function validateApiResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  options: ValidateOptions
): ValidationResult {
  const result = check(schema, value);
  reportDrift(result, options);
  return result;
}

/**
 * Validate a row about to be written to Build Memory. NON-BLOCKING: logs drift to `forge-validation`
 * and returns the result; the write proceeds regardless (a learning-store write never halts the
 * pipeline).
 */
export function validateMemoryWrite(
  table: string,
  record: unknown,
  options: Omit<ValidateOptions, 'target'>
): ValidationResult {
  // No per-table schema is registered here (the CRUD layer owns row shapes — wiring them in would
  // close an import cycle). We assert the record is a non-null object and report anything else as
  // drift, which is the seam Build Memory's caller-side `validateMemoryWrite` is meant to provide.
  const result = check(z.object({}).passthrough(), record);
  reportDrift(result, { ...options, target: table });
  return result;
}

// ---------------------------------------------------------------------------
// Domain schemas
// ---------------------------------------------------------------------------

/** Full-row schema for the `build_runs` table (migration 001). */
export const BuildRunSchema = z.object({
  id: z.string(),
  project_name: z.string(),
  project_path: z.string(),
  stack_fingerprint: z.record(z.unknown()),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'halted']),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  total_prompts: z.number(),
  completed_prompts: z.number(),
  failed_prompts: z.number(),
  total_errors: z.number(),
  total_tokens: z.number(),
  total_cost_usd: z.number(),
  machine_id: z.string(),
  toolchain_manifest: z.record(z.unknown()),
  governance_hash: z.string().nullable(),
  queue_hash: z.string().nullable(),
  bundle_sizes: z.record(z.unknown()).nullable(),
  sentinel_interventions: z.number(),
  autonomous_recovery_mode: z.boolean(),
  parallel_prompts_used: z.boolean(),
  dry_run: z.boolean(),
  created_at: z.string(),
});

// ---------------------------------------------------------------------------
// External wire contracts — deliberately lenient (all fields optional) so a sparse-but-valid body
// is accepted. They assert SHAPE, not completeness; the tolerant reads downstream handle absence.
// ---------------------------------------------------------------------------

/** Anthropic Messages API response shape (partial — only the fields FORGE reads). */
export const AnthropicMessagesResponseSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    role: z.string().optional(),
    model: z.string().optional(),
    stop_reason: z.string().nullable().optional(),
    content: z
      .array(
        z
          .object({
            type: z.string().optional(),
            text: z.string().optional(),
          })
          .passthrough()
      )
      .optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** OpenAI Chat Completions response shape (partial — covers the OpenAI-compatible providers too). */
export const OpenAIChatResponseSchema = z
  .object({
    id: z.string().optional(),
    object: z.string().optional(),
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            index: z.number().optional(),
            finish_reason: z.string().nullable().optional(),
            message: z
              .object({
                role: z.string().optional(),
                content: z.string().nullable().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
      )
      .optional(),
    usage: z
      .object({
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
        total_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Live schema drift detection
// ---------------------------------------------------------------------------

export interface LiveSchemaColumn {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  columnDefault: string | null;
}

export interface LiveSchemaTable {
  tableName: string;
  columns: LiveSchemaColumn[];
}

export interface LiveSchemaEnum {
  typeName: string;
  values: string[];
}

export interface LiveSchema {
  tables: LiveSchemaTable[];
  enums: LiveSchemaEnum[];
}

export interface ExpectedSchemaColumn {
  columnName: string;
  type: string;
}

export interface ExpectedSchemaTable {
  tableName: string;
  columns: ExpectedSchemaColumn[];
}

export interface ExpectedSchema {
  tables: ExpectedSchemaTable[];
}

export type SchemaDriftSeverity = 'error' | 'warning' | 'info';

export type SchemaDriftIssueType =
  | 'missing_table'
  | 'extra_table'
  | 'missing_column'
  | 'extra_column'
  | 'type_mismatch';

export interface SchemaDriftIssue {
  severity: SchemaDriftSeverity;
  issueType: SchemaDriftIssueType;
  table: string;
  column?: string;
  message: string;
}

export interface SchemaDriftReport {
  hasDrift: boolean;
  issues: SchemaDriftIssue[];
  checkedAt: string;
}

// Internal raw shapes returned by PostgREST queries

interface RawColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

interface RawEnumRow {
  typname: string;
  enumlabels: string[];
}

async function fetchLiveSchema(supabaseUrl: string, serviceKey: string): Promise<LiveSchema> {
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    'Content-Type': 'application/json',
  };

  const columnsRes = await fetch(
    `${supabaseUrl}/rest/v1/columns?table_schema=eq.public` +
      `&select=table_name,column_name,data_type,is_nullable,column_default` +
      `&order=table_name,ordinal_position`,
    { headers: { ...baseHeaders, 'Accept-Profile': 'information_schema' } }
  );

  if (!columnsRes.ok) {
    throw new Error(`Failed to fetch live schema columns: ${columnsRes.status}`);
  }

  const rawColumns = (await columnsRes.json()) as RawColumnRow[];

  const tableMap = new Map<string, LiveSchemaColumn[]>();
  for (const row of rawColumns) {
    const cols = tableMap.get(row.table_name) ?? [];
    cols.push({
      columnName: row.column_name,
      dataType: row.data_type,
      isNullable: row.is_nullable === 'YES',
      columnDefault: row.column_default,
    });
    tableMap.set(row.table_name, cols);
  }

  const tables: LiveSchemaTable[] = Array.from(tableMap.entries()).map(
    ([tableName, columns]) => ({ tableName, columns })
  );

  let enums: LiveSchemaEnum[] = [];
  try {
    const enumsRes = await fetch(`${supabaseUrl}/rest/v1/rpc/get_custom_enums`, {
      method: 'POST',
      headers: baseHeaders,
      body: '{}',
    });
    if (enumsRes.ok) {
      const rawEnums = (await enumsRes.json()) as RawEnumRow[];
      enums = rawEnums.map((r) => ({ typeName: r.typname, values: r.enumlabels }));
    }
  } catch {
    // RPC not available; enum data omitted
  }

  return { tables, enums };
}

async function parseTypescriptTypes(typesPath: string): Promise<ExpectedSchema> {
  const source = await readFile(typesPath, 'utf-8');
  const tables: ExpectedSchemaTable[] = [];

  // Walk lines with a depth counter to locate the Tables: { ... } block, then each
  // table's Row: { ... } block within it.  Brace counts in string/comment content
  // are tolerated because Supabase-generated files use simple scalar types.
  const lines = source.split('\n');
  let depth = 0;
  let inTables = false;
  let tablesDepth = 0;
  let currentTable: { name: string; columns: ExpectedSchemaColumn[] } | null = null;
  let inRow = false;
  let rowExitDepth = 0;

  for (const line of lines) {
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;

    if (!inTables) {
      depth += opens - closes;
      if (/\bTables\s*:\s*\{/.test(line)) {
        inTables = true;
        tablesDepth = depth;
      }
      continue;
    }

    depth += opens - closes;

    if (depth < tablesDepth) {
      inTables = false;
      if (currentTable !== null) {
        tables.push({ tableName: currentTable.name, columns: currentTable.columns });
        currentTable = null;
      }
      continue;
    }

    if (inRow) {
      if (depth < rowExitDepth) {
        inRow = false;
        if (currentTable !== null) {
          tables.push({ tableName: currentTable.name, columns: currentTable.columns });
          currentTable = null;
        }
      } else {
        const colMatch = /^\s+(\w+)\??:\s*(.+?)[,;]?\s*$/.exec(line);
        if (colMatch !== null && colMatch[1] !== undefined && colMatch[2] !== undefined) {
          const colType = colMatch[2].trim();
          if (colType.length > 0 && !colType.startsWith('//')) {
            currentTable?.columns.push({ columnName: colMatch[1], type: colType });
          }
        }
      }
      continue;
    }

    // Detect a new table name one level inside the Tables block
    if (depth === tablesDepth + 1 && opens > 0) {
      const tableMatch = /^\s+(\w+)\s*:\s*\{/.exec(line);
      if (tableMatch !== null && tableMatch[1] !== undefined) {
        currentTable = { name: tableMatch[1], columns: [] };
      }
    }

    // Enter the Row: { block
    if (currentTable !== null && /\bRow\s*:\s*\{/.test(line)) {
      inRow = true;
      rowExitDepth = depth;
    }
  }

  return { tables };
}

export async function detectSchemaDrift(
  supabaseUrl: string,
  serviceKey: string,
  typesPath: string
): Promise<SchemaDriftReport> {
  const [live, expected] = await Promise.all([
    fetchLiveSchema(supabaseUrl, serviceKey),
    parseTypescriptTypes(typesPath),
  ]);

  const issues: SchemaDriftIssue[] = [];

  const liveTableMap = new Map(live.tables.map((t) => [t.tableName, t]));
  const expectedTableMap = new Map(expected.tables.map((t) => [t.tableName, t]));

  for (const [tableName] of liveTableMap) {
    if (!expectedTableMap.has(tableName)) {
      issues.push({
        severity: 'error',
        issueType: 'missing_table',
        table: tableName,
        message: `Table "${tableName}" exists in the live DB but has no TypeScript type definition.`,
      });
    }
  }

  for (const [tableName] of expectedTableMap) {
    if (!liveTableMap.has(tableName)) {
      issues.push({
        severity: 'warning',
        issueType: 'extra_table',
        table: tableName,
        message: `Table "${tableName}" is defined in TypeScript types but does not exist in the live DB.`,
      });
    }
  }

  for (const [tableName, liveTable] of liveTableMap) {
    const expectedTable = expectedTableMap.get(tableName);
    if (expectedTable === undefined) continue;

    const liveColSet = new Set(liveTable.columns.map((c) => c.columnName));
    const expectedColSet = new Set(expectedTable.columns.map((c) => c.columnName));

    for (const colName of liveColSet) {
      if (!expectedColSet.has(colName)) {
        issues.push({
          severity: 'error',
          issueType: 'missing_column',
          table: tableName,
          column: colName,
          message: `Column "${tableName}.${colName}" exists in the live DB but is missing from TypeScript types.`,
        });
      }
    }

    for (const colName of expectedColSet) {
      if (!liveColSet.has(colName)) {
        issues.push({
          severity: 'warning',
          issueType: 'extra_column',
          table: tableName,
          column: colName,
          message: `Column "${tableName}.${colName}" is in TypeScript types but does not exist in the live DB.`,
        });
      }
    }
  }

  return {
    hasDrift: issues.length > 0,
    issues,
    checkedAt: new Date().toISOString(),
  };
}

export async function autoRegenerateTypes(projectPath: string): Promise<void> {
  let projectRef = '';
  try {
    const configSource = await readFile(`${projectPath}/supabase/config.toml`, 'utf-8');
    const refMatch = /project_id\s*=\s*"([^"]+)"/.exec(configSource);
    projectRef = refMatch?.[1] ?? '';
  } catch {
    // config.toml not found; fall through to error below
  }

  if (projectRef.length === 0) {
    throw new Error('Cannot determine Supabase project ref from supabase/config.toml');
  }

  const { stdout } = await execAsync(
    `npx supabase gen types typescript --project-id ${projectRef}`,
    { cwd: projectPath }
  );

  await writeFile(`${projectPath}/src/types/database.ts`, stdout, 'utf-8');
}
