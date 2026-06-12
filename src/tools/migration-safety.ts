/**
 * FORGE 2.0 — Migration Safety (`src/tools/migration-safety.ts`).
 *
 * A PRE-MIGRATION gate: before any database migration is applied to a Supabase/Postgres project,
 * analyze the migration SQL for DESTRUCTIVE operations, refuse to proceed unless each one is
 * explicitly confirmed, and produce the safety artifacts an operator needs to apply it without
 * losing data. Where the Sentinel's Schema-Drift check (Contract 13 step 4) catches drift AFTER a
 * prompt has already mutated the schema, this gate runs BEFORE the migration touches the database.
 *
 * It does five things ({@link analyzeMigration} → {@link MigrationSafetyReport}):
 *
 *   1. DETECT DESTRUCTIVE OPERATIONS — statement-level parse of the migration SQL for the five
 *      data-losing operations: `DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN … TYPE` (a type change
 *      that can truncate/lose data), `TRUNCATE`, and `DELETE` with NO `WHERE` clause.
 *   2. REQUIRE EXPLICIT CONFIRMATION — every destructive operation must be confirmed, either by an
 *      inline `-- forge:confirm[ <op|table|table.column>]` marker in the migration, or by a
 *      `confirmations` entry supplied "in the prompt" (an op type, a table name, a `table.column`,
 *      or `all`). An UNCONFIRMED destructive operation BLOCKS the gate (`passed = false`).
 *   3. GENERATE A ROLLBACK MIGRATION — an automatic inverse migration (statements reversed):
 *      `CREATE TABLE` ⇄ `DROP TABLE`, `ADD COLUMN` ⇄ `DROP COLUMN`, `ADD CONSTRAINT` ⇄ `DROP
 *      CONSTRAINT`, `CREATE INDEX` ⇄ `DROP INDEX`, and — for drops/retypes — reconstructed from the
 *      CURRENT production schema (a dropped table/column is recreated from its live definition).
 *      Pure data operations (`TRUNCATE`/`DELETE`) cannot be inverted as SQL, so the rollback points
 *      at the backup JSON (see 4) with a clear comment.
 *   4. CREATE A DATA-BACKUP SCRIPT — a runnable Node script that `SELECT *`s every AFFECTED table
 *      (the tables a destructive op touches) and writes each to a timestamped JSON file BEFORE the
 *      migration runs, so a `TRUNCATE`/`DELETE`/`DROP` is recoverable.
 *   5. DIFF vs PRODUCTION + FLAG BREAKAGES — introspect the CURRENT production schema via
 *      `information_schema` (reusing {@link extractSchema}'s live executor), compute exactly what the
 *      migration changes (tables/columns added·dropped·retyped, indexes/policies/constraints ±), and
 *      FLAG any migration that would break an existing RLS policy (a policy ON, or whose USING/CHECK
 *      expression references, a dropped table/column) or a foreign-key relationship (a dropped
 *      table/column that is an FK endpoint). Un-acknowledged breakages BLOCK the gate.
 *
 * Wired into {@link runSentinel} as the optional pre-migration `migration_safety` check.
 * History of every analysis is stored in Build Memory (`production_telemetry`, guarded — Contract 4).
 *
 * HOUSE STYLE (matches `schema-extractor`, `security-scanner`, `architecture-guard`,
 * `phase4-sentinel`): NON-FATAL and never throws (Iron Law 3 — never fabricate a "safe"); READ-ONLY
 * with respect to the target (it ANALYZES SQL and reads `information_schema` metadata — it never
 * applies the migration, never writes the target filesystem, never reads table DATA, and only writes
 * a Build-Memory summary row). Every external collaborator (the live SQL executor, the Build-Memory
 * writer, the clock) is injectable, so it unit-tests with no database. ZERO new npm dependency.
 */

import { basename } from 'node:path';

import {
  extractSchema,
  createSupabaseExecutor,
  type SqlExecutor,
  type SchemaSnapshot,
  type SchemaSource,
  type TableSchema,
  type ColumnSchema,
  type RlsPolicy,
  type Relationship,
} from './schema-extractor.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import type { JsonObject, TelemetryEventType, TelemetrySeverity } from '../types/index.js';
import { logLine } from './forge-logger.js';

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Public contract — destructive operations
// ---------------------------------------------------------------------------

/** The five destructive operation kinds the gate detects. */
export type DestructiveOpType =
  | 'drop_table'
  | 'drop_column'
  | 'alter_column_type'
  | 'truncate'
  | 'delete_without_where';

/** A single destructive operation found in the migration. */
export interface DestructiveOperation {
  /** Which destructive operation this is. */
  type: DestructiveOpType;
  /** Stable rule id (e.g. `migration.drop_table`). */
  rule: string;
  /** 1-based index of the statement within the migration. */
  statementIndex: number;
  /** Target table (schema prefix stripped), or null if it could not be parsed. */
  table: string | null;
  /** Target column for `drop_column` / `alter_column_type`, else null. */
  column: string | null;
  /** The new type for an `alter_column_type`, else null. */
  newType: string | null;
  /** True when the change is (heuristically) clearly data-losing, vs merely potentially-losing. */
  clearlyLossy: boolean;
  /** The migration statement (clipped) that triggered the finding. */
  statement: string;
  /** One-line human-readable summary. */
  message: string;
  /** True once an inline marker or a `confirmations` entry has confirmed this operation. */
  confirmed: boolean;
  /** How it was confirmed (`marker` | `option`), or null when unconfirmed. */
  confirmedBy: 'marker' | 'option' | null;
}

// ---------------------------------------------------------------------------
// Public contract — breakages (RLS / FK)
// ---------------------------------------------------------------------------

/** What kind of existing object the migration would break. */
export type BreakageKind = 'rls_policy' | 'foreign_key';

/** A flagged breakage: a migration change that invalidates an existing RLS policy or FK. */
export interface BreakageFinding {
  kind: BreakageKind;
  /** Stable rule id (e.g. `migration.breaks_rls`). */
  rule: string;
  /** The migration operation that causes it. */
  cause: { type: DestructiveOpType; table: string | null; column: string | null };
  /** Name of the existing object that breaks (policy name / FK constraint name). */
  objectName: string;
  /** Table the broken object lives on. */
  objectTable: string;
  /** One-line human-readable summary. */
  message: string;
  /** True once acknowledged via a `confirmations` entry (`rls`/`fk`/`all`/the object/table name). */
  acknowledged: boolean;
}

// ---------------------------------------------------------------------------
// Public contract — schema diff
// ---------------------------------------------------------------------------

/** A single column add/drop/retype the migration performs, cross-referenced with production. */
export interface ColumnChange {
  table: string;
  column: string;
  /** New type (for `add`/`retype`), else null. */
  type: string | null;
  /** Production type before the change (for `drop`/`retype`), when known. */
  fromType: string | null;
  /** True when the column exists in the current production schema. */
  existsInProduction: boolean;
}

/** The structured diff of the migration against the current production schema. */
export interface SchemaDiff {
  tablesAdded: string[];
  tablesDropped: string[];
  columnsAdded: ColumnChange[];
  columnsDropped: ColumnChange[];
  columnsRetyped: ColumnChange[];
  indexesAdded: string[];
  indexesDropped: string[];
  policiesAdded: string[];
  policiesDropped: string[];
  constraintsAdded: string[];
  constraintsDropped: string[];
  /** Statements the parser could not classify (informational). */
  unclassifiedStatements: number;
}

// ---------------------------------------------------------------------------
// Public contract — backup script
// ---------------------------------------------------------------------------

/** The generated data-backup artifact. */
export interface BackupScript {
  /** Tables a destructive operation touches (these are exported before the migration runs). */
  affectedTables: string[];
  /** The script language. */
  language: 'node';
  /** Suggested filename for the script. */
  filename: string;
  /** The runnable script text (empty when there are no affected tables). */
  script: string;
}

// ---------------------------------------------------------------------------
// Public contract — report
// ---------------------------------------------------------------------------

/** The full migration-safety report (the gate's output contract). */
export interface MigrationSafetyReport {
  /** True iff the migration is safe to apply: no UNCONFIRMED destructive op and no UN-acknowledged breakage. */
  passed: boolean;
  /** True iff `!passed` — the migration is blocked. */
  blocked: boolean;
  /** Every destructive operation found (confirmed and unconfirmed). */
  destructiveOperations: DestructiveOperation[];
  /** The blocking subset — destructive operations still awaiting confirmation. */
  unconfirmed: DestructiveOperation[];
  /** RLS policies the migration would break. */
  rlsBreakages: BreakageFinding[];
  /** Foreign-key relationships the migration would break. */
  fkBreakages: BreakageFinding[];
  /** Structured diff against the current production schema. */
  diff: SchemaDiff;
  /** Human-readable markdown diff report (the "exactly what changes" view). */
  diffReport: string;
  /** Auto-generated inverse migration (SQL text). */
  rollbackMigration: string;
  /** Generated data-backup script + the affected-table list. */
  backupScript: BackupScript;
  /** Where the production schema was introspected from (`live`/`migrations`/`merged`/`none`). */
  productionSchemaSource: SchemaSource;
  /** Number of statements parsed from the migration. */
  statementCount: number;
  /** Full markdown report (summary + destructive ops + breakages + diff). */
  report: string;
  /** Non-fatal observations (unreachable DB, unparsable statement, …). */
  warnings: string[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Public contract — input + injectable collaborators
// ---------------------------------------------------------------------------

/** What to analyze. */
export interface MigrationSafetyInput {
  /** The migration SQL to analyze (required). */
  sql: string;
  /** Migration name/id (used in the rollback header + backup filenames). Default `'migration'`. */
  migrationName?: string;
  /** Project name for the Build-Memory record. Default: basename of `projectPath`, else `'unknown'`. */
  projectName?: string;
  /** Target project root (used only to default `projectName` and as a migrations source for the diff). */
  projectPath?: string;
  /** Optional `build_runs.id` to associate the stored history row with. */
  buildRunId?: string;
  /** Live read-only SQL executor for `information_schema` introspection of the production schema. */
  schemaSql?: SqlExecutor;
  /** Convenience: a Supabase client (an executor is derived from it when `schemaSql` is absent). */
  supabase?: SupabaseClient;
  /**
   * Pre-fetched production schema. When supplied, live introspection is SKIPPED and this snapshot is
   * used for the diff / breakage analysis / rollback reconstruction (the test seam).
   */
  productionSchema?: SchemaSnapshot;
  /**
   * Confirmations supplied "in the prompt": each entry confirms a destructive op or acknowledges a
   * breakage. Accepts a {@link DestructiveOpType}, a table name, a `table.column`, the keywords
   * `rls` / `fk` to acknowledge breakages, or `all` / `*` to confirm everything. Case-insensitive.
   */
  confirmations?: string[];
  /** Database schema to introspect / treat as default. Default `'public'`. */
  schema?: string;
}

/** Persist the analysis summary to Build Memory (guarded, non-fatal). */
export type MigrationHistoryStore = (
  record: MigrationStoredRecord,
  log: (m: string) => void
) => Promise<void>;

/** The summary row persisted to Build Memory (`production_telemetry`). */
export interface MigrationStoredRecord {
  projectName: string;
  buildRunId: string | null;
  migrationName: string;
  passed: boolean;
  blocked: boolean;
  destructiveCount: number;
  unconfirmedCount: number;
  rlsBreakageCount: number;
  fkBreakageCount: number;
  affectedTables: string[];
  diffSummary: {
    tablesAdded: number;
    tablesDropped: number;
    columnsAdded: number;
    columnsDropped: number;
    columnsRetyped: number;
  };
  productionSchemaSource: SchemaSource;
  generatedAt: string;
}

/** Options controlling a migration-safety analysis. */
export interface MigrationSafetyOptions {
  /** RPC function name used to run SQL through a Supabase client. Default `'exec_sql'`. */
  supabaseRpc?: string;
  /** Parameter name the RPC expects the SQL string under. Default `'query'`. */
  supabaseRpcParam?: string;
  /**
   * Treat EVERY `ALTER COLUMN … TYPE` as destructive (the default, conservative — a type change can
   * always lose data). Set false to flag only changes heuristically known to be lossy.
   */
  flagAllTypeChanges?: boolean;
  /** Override the Build-Memory writer (tests). Default: a guarded `production_telemetry` insert. */
  storeHistory?: MigrationHistoryStore;
  /** Clock (tests). Default {@link nowIso}. */
  now?: () => string;
  /** Progress reporter. Default logs with a `[FORGE:migration]` prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cap on a statement rendered into the report / a finding. */
const MAX_STATEMENT_CHARS = 600;

/**
 * Postgres type families whose target is clearly NARROWER than common sources — an `ALTER COLUMN …
 * TYPE` into one of these from a wider family is flagged `clearlyLossy`. Heuristic, conservative.
 */
const NARROWING_TARGETS: readonly string[] = [
  'boolean',
  'integer',
  'smallint',
  'date',
  'time',
  'uuid',
];

// ---------------------------------------------------------------------------
// Generic SQL text helpers (all guarded — never throw)
// ---------------------------------------------------------------------------

/** Collapse runs of whitespace (incl. newlines) to single spaces and trim. */
function collapse(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Strip a schema prefix and surrounding quotes from an identifier. */
function cleanIdent(raw: string): string {
  const unquoted = (raw ?? '').replace(/["`]/g, '').trim();
  const dot = unquoted.lastIndexOf('.');
  return dot >= 0 ? unquoted.slice(dot + 1) : unquoted;
}

/** Clip a statement for display, noting elision. */
function clipStatement(s: string): string {
  const t = collapse(s);
  return t.length <= MAX_STATEMENT_CHARS ? t : `${t.slice(0, MAX_STATEMENT_CHARS)} …`;
}

/** Render an unknown thrown value as a short string for logging. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One parsed statement, with the comment lines that immediately precede it. */
export interface ParsedStatement {
  /** The SQL text (comments stripped, whitespace collapsed). */
  sql: string;
  /** Raw comment text attached to this statement (the lines just before it + trailing `-- …`). */
  comments: string;
  /** 1-based index within the migration. */
  index: number;
}

/**
 * Split a SQL migration into statements on top-level semicolons — correctly skipping line/block
 * comments and respecting single-quoted strings, double-quoted identifiers, and dollar-quoted
 * blocks (`$$ … $$` / `$tag$ … $tag$`) — while CAPTURING the comments attached to each statement so
 * an inline `-- forge:confirm` marker can be matched to the destructive operation it confirms.
 * Best-effort and tolerant; never throws.
 */
export function splitStatementsWithComments(sql: string): ParsedStatement[] {
  const out: ParsedStatement[] = [];
  let body = '';
  let comments = '';
  let i = 0;
  const n = (sql ?? '').length;

  const push = (): void => {
    const trimmed = collapse(body);
    if (trimmed !== '') {
      out.push({ sql: trimmed, comments: comments.trim(), index: out.length + 1 });
    }
    body = '';
    comments = '';
  };

  while (i < n) {
    const c = sql[i] ?? '';
    const next = sql[i + 1] ?? '';

    // -- line comment (kept in the comment buffer; not part of the statement body).
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      comments += `${sql.slice(i, end)}\n`;
      i = end;
      continue;
    }
    // /* block comment */
    if (c === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      comments += `${sql.slice(i, end)}\n`;
      i = end;
      continue;
    }
    // single-quoted string literal
    if (c === "'") {
      const end = scanString(sql, i);
      body += sql.slice(i, end);
      i = end;
      continue;
    }
    // double-quoted identifier
    if (c === '"') {
      const end = scanQuotedIdent(sql, i);
      body += sql.slice(i, end);
      i = end;
      continue;
    }
    // dollar-quoted block
    if (c === '$') {
      const tag = matchDollarTag(sql, i);
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        const stop = close === -1 ? n : close + tag.length;
        body += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    // statement terminator
    if (c === ';') {
      push();
      i++;
      continue;
    }
    body += c;
    i++;
  }
  push();
  return out;
}

/** Index just past a single-quoted string literal starting at `start` (a `'`). */
function scanString(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      if (sql[i + 1] === "'") i += 2;
      else return i + 1;
    } else {
      i++;
    }
  }
  return sql.length;
}

/** Index just past a double-quoted identifier starting at `start` (a `"`). */
function scanQuotedIdent(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '"') {
      if (sql[i + 1] === '"') i += 2;
      else return i + 1;
    } else {
      i++;
    }
  }
  return sql.length;
}

/** If a dollar-quote tag (`$$` or `$name$`) starts at `pos`, return it; else `null`. */
function matchDollarTag(sql: string, pos: number): string | null {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(pos, pos + 64));
  return m && m[0] ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Confirmation markers
// ---------------------------------------------------------------------------

/**
 * Extract `forge:confirm` qualifiers from a statement's attached comments. A marker is
 * `forge:confirm` (or `@forge-confirm`) optionally followed by a qualifier token (an op type, a
 * table, or a `table.column`). A bare marker yields the qualifier `'*'` (confirms anything on the
 * statement). Returns the lower-cased qualifiers found.
 */
export function parseConfirmMarkers(comments: string): string[] {
  const quals: string[] = [];
  const re = /(?:forge:confirm(?:-destructive)?|@forge-confirm)\s*[:=]?\s*([A-Za-z0-9_.\-*]*)/gi;
  for (const m of (comments ?? '').matchAll(re)) {
    const q = (m[1] ?? '').trim().toLowerCase();
    quals.push(q === '' ? '*' : q);
  }
  return quals;
}

/** True when a qualifier set confirms a destructive op on `table`/`column` of `type`. */
function qualifiersConfirm(
  quals: readonly string[],
  type: DestructiveOpType,
  table: string | null,
  column: string | null
): boolean {
  const t = (table ?? '').toLowerCase();
  const col = (column ?? '').toLowerCase();
  const tc = t && col ? `${t}.${col}` : '';
  for (const q of quals) {
    if (q === '*' || q === 'all') return true;
    if (q === type) return true;
    if (t && q === t) return true;
    if (tc && q === tc) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Destructive-operation detection
// ---------------------------------------------------------------------------

/** Detect every destructive operation across the parsed statements. */
export function detectDestructiveOperations(
  statements: readonly ParsedStatement[],
  confirmations: readonly string[],
  flagAllTypeChanges: boolean
): DestructiveOperation[] {
  const globalConfirms = confirmations.map((c) => c.trim().toLowerCase()).filter((c) => c !== '');
  const ops: DestructiveOperation[] = [];

  for (const stmt of statements) {
    const detected = detectInStatement(stmt, flagAllTypeChanges);
    for (const partial of detected) {
      const markerQuals = parseConfirmMarkers(stmt.comments);
      const byMarker = qualifiersConfirm(markerQuals, partial.type, partial.table, partial.column);
      const byOption = qualifiersConfirm(globalConfirms, partial.type, partial.table, partial.column);
      ops.push({
        ...partial,
        confirmed: byMarker || byOption,
        confirmedBy: byMarker ? 'marker' : byOption ? 'option' : null,
      });
    }
  }
  return ops;
}

/** A destructive op before confirmation is resolved. */
type PendingOp = Omit<DestructiveOperation, 'confirmed' | 'confirmedBy'>;

/** Detect destructive operations within a single statement (a statement may yield more than one). */
function detectInStatement(stmt: ParsedStatement, flagAllTypeChanges: boolean): PendingOp[] {
  const sql = stmt.sql;
  const lead = sql.slice(0, 16).toLowerCase();
  const found: PendingOp[] = [];
  const clip = clipStatement(sql);

  // DROP TABLE [IF EXISTS] name [, name] [CASCADE]
  const dropTable = /^drop\s+table\s+(?:if\s+exists\s+)?([\s\S]+?)(?:\s+cascade|\s+restrict)?$/i.exec(sql);
  if (dropTable && dropTable[1]) {
    for (const raw of dropTable[1].split(',')) {
      const table = cleanIdent(raw);
      if (table === '') continue;
      found.push({
        type: 'drop_table',
        rule: 'migration.drop_table',
        statementIndex: stmt.index,
        table,
        column: null,
        newType: null,
        clearlyLossy: true,
        statement: clip,
        message: `DROP TABLE '${table}' destroys the table and ALL its rows`,
      });
    }
    return found;
  }

  // TRUNCATE [TABLE] name [, name]
  const truncate = /^truncate\s+(?:table\s+)?([\s\S]+?)(?:\s+(?:restart|continue)\s+identity)?(?:\s+cascade|\s+restrict)?$/i.exec(sql);
  if (lead.startsWith('truncate') && truncate && truncate[1]) {
    for (const raw of truncate[1].split(',')) {
      const table = cleanIdent(raw);
      if (table === '') continue;
      found.push({
        type: 'truncate',
        rule: 'migration.truncate',
        statementIndex: stmt.index,
        table,
        column: null,
        newType: null,
        clearlyLossy: true,
        statement: clip,
        message: `TRUNCATE '${table}' deletes every row in the table`,
      });
    }
    return found;
  }

  // DELETE FROM name [WHERE …]  — destructive only when there is NO WHERE clause.
  const del = /^delete\s+from\s+(?:only\s+)?([A-Za-z0-9_."`]+)\b([\s\S]*)$/i.exec(sql);
  if (lead.startsWith('delete') && del && del[1]) {
    const rest = del[2] ?? '';
    if (!/\bwhere\b/i.test(rest)) {
      const table = cleanIdent(del[1]);
      found.push({
        type: 'delete_without_where',
        rule: 'migration.delete_without_where',
        statementIndex: stmt.index,
        table,
        column: null,
        newType: null,
        clearlyLossy: true,
        statement: clip,
        message: `DELETE FROM '${table}' has no WHERE clause — it removes every row`,
      });
    }
    return found;
  }

  // ALTER TABLE name <action>[, <action>]  — DROP COLUMN and ALTER COLUMN … TYPE.
  const alter = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([A-Za-z0-9_."`]+)\s+([\s\S]+)$/i.exec(sql);
  if (lead.startsWith('alter table') && alter && alter[1] && alter[2]) {
    const table = cleanIdent(alter[1]);
    for (const action of splitTopLevelCommas(alter[2])) {
      const a = action.trim();

      // DROP COLUMN [IF EXISTS] col   (also bare `DROP col`, but NOT `DROP CONSTRAINT/CONSTRAINT/DEFAULT/…`).
      const dropCol = /^drop\s+(?:column\s+)?(?:if\s+exists\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)\b/i.exec(a);
      if (dropCol && dropCol[1] && !/^drop\s+(constraint|default|not\s+null|identity)\b/i.test(a)) {
        const column = cleanIdent(dropCol[1]);
        found.push({
          type: 'drop_column',
          rule: 'migration.drop_column',
          statementIndex: stmt.index,
          table,
          column,
          newType: null,
          clearlyLossy: true,
          statement: clip,
          message: `DROP COLUMN '${table}.${column}' destroys the column and its data`,
        });
        continue;
      }

      // ALTER COLUMN col TYPE newtype   (also `SET DATA TYPE newtype`).
      const alterType =
        /^alter\s+(?:column\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)\s+(?:set\s+data\s+)?type\s+([A-Za-z0-9_ ().,'\[\]]+?)(?:\s+using\b|\s+collate\b|$)/i.exec(
          a
        );
      if (alterType && alterType[1] && alterType[2]) {
        const column = cleanIdent(alterType[1]);
        const newType = collapse(alterType[2]);
        const lossy = isClearlyLossyType(newType);
        if (flagAllTypeChanges || lossy) {
          found.push({
            type: 'alter_column_type',
            rule: 'migration.alter_column_type',
            statementIndex: stmt.index,
            table,
            column,
            newType,
            clearlyLossy: lossy,
            statement: clip,
            message:
              `ALTER COLUMN '${table}.${column}' TYPE ${newType}` +
              (lossy ? ' — narrowing type change can truncate/lose data' : ' — type change may lose data'),
          });
        }
      }
    }
  }

  return found;
}

/** Heuristic: is a target type clearly narrowing (and so clearly data-losing)? */
function isClearlyLossyType(newType: string): boolean {
  const base = newType.toLowerCase().replace(/\(.*\)/g, '').trim().split(/\s/)[0] ?? '';
  // A length-bounded varchar/char target can truncate text.
  if (/(varchar|character varying|char)\s*\(/.test(newType.toLowerCase())) return true;
  return NARROWING_TARGETS.includes(base);
}

/** Split an ALTER body on top-level commas (commas inside parens/strings preserved). */
function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i] ?? '';
    if (inString) {
      current += c;
      if (c === "'") {
        if (body[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (c === "'") {
      inString = true;
      current += c;
    } else if (c === '(') {
      depth++;
      current += c;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      current += c;
    } else if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

// ---------------------------------------------------------------------------
// Migration intent (what the migration changes) — for the diff + rollback
// ---------------------------------------------------------------------------

/** A coarse classification of one migration statement, used for the diff and rollback. */
export interface StatementIntent {
  index: number;
  kind:
    | 'create_table'
    | 'drop_table'
    | 'add_column'
    | 'drop_column'
    | 'alter_column_type'
    | 'create_index'
    | 'drop_index'
    | 'add_constraint'
    | 'drop_constraint'
    | 'truncate'
    | 'delete'
    | 'other';
  table: string | null;
  object: string | null; // column / index / constraint name
  detail: string | null; // new type / index def / constraint def
  sql: string;
}

/** Classify each statement's structural intent (best-effort). */
export function classifyStatements(statements: readonly ParsedStatement[]): StatementIntent[] {
  const out: StatementIntent[] = [];
  for (const stmt of statements) {
    out.push(...classifyOne(stmt));
  }
  return out;
}

function classifyOne(stmt: ParsedStatement): StatementIntent[] {
  const sql = stmt.sql;
  const lead = sql.slice(0, 24).toLowerCase();
  const base = (kind: StatementIntent['kind'], table: string | null, object: string | null, detail: string | null): StatementIntent => ({
    index: stmt.index,
    kind,
    table,
    object,
    detail,
    sql: clipStatement(sql),
  });

  if (/^create\s+(?:unlogged\s+|temporary\s+|temp\s+)*table\b/i.test(sql)) {
    const m = /table\s+(?:if\s+not\s+exists\s+)?([A-Za-z0-9_."`]+)/i.exec(sql);
    return [base('create_table', m && m[1] ? cleanIdent(m[1]) : null, null, null)];
  }
  if (lead.startsWith('drop table')) {
    const m = /drop\s+table\s+(?:if\s+exists\s+)?([A-Za-z0-9_."`]+)/i.exec(sql);
    return [base('drop_table', m && m[1] ? cleanIdent(m[1]) : null, null, null)];
  }
  if (/^create\s+(?:unique\s+)?index\b/i.test(sql)) {
    const m = /index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([A-Za-z0-9_."`]+)/i.exec(sql);
    return [base('create_index', null, m && m[1] ? cleanIdent(m[1]) : null, null)];
  }
  if (lead.startsWith('drop index')) {
    const m = /drop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?([A-Za-z0-9_."`]+)/i.exec(sql);
    return [base('drop_index', null, m && m[1] ? cleanIdent(m[1]) : null, null)];
  }
  if (lead.startsWith('truncate')) {
    const m = /truncate\s+(?:table\s+)?([A-Za-z0-9_."`]+)/i.exec(sql);
    return [base('truncate', m && m[1] ? cleanIdent(m[1]) : null, null, null)];
  }
  if (lead.startsWith('delete')) {
    const m = /delete\s+from\s+(?:only\s+)?([A-Za-z0-9_."`]+)/i.exec(sql);
    return [base('delete', m && m[1] ? cleanIdent(m[1]) : null, null, null)];
  }

  if (lead.startsWith('alter table')) {
    const alter = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([A-Za-z0-9_."`]+)\s+([\s\S]+)$/i.exec(sql);
    if (!alter || !alter[1] || !alter[2]) return [base('other', null, null, null)];
    const table = cleanIdent(alter[1]);
    const results: StatementIntent[] = [];
    for (const action of splitTopLevelCommas(alter[2])) {
      const a = action.trim();
      const addCol = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)\s+([\s\S]+)$/i.exec(a);
      if (addCol && addCol[1] && addCol[2] && !/^add\s+(constraint|primary\s+key|foreign\s+key|unique|check)\b/i.test(a)) {
        results.push(base('add_column', table, cleanIdent(addCol[1]), collapse(addCol[2])));
        continue;
      }
      const dropCol = /^drop\s+(?:column\s+)?(?:if\s+exists\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)\b/i.exec(a);
      if (dropCol && dropCol[1] && !/^drop\s+(constraint|default|not\s+null|identity)\b/i.test(a)) {
        results.push(base('drop_column', table, cleanIdent(dropCol[1]), null));
        continue;
      }
      const alterType =
        /^alter\s+(?:column\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)\s+(?:set\s+data\s+)?type\s+([A-Za-z0-9_ ().,'\[\]]+?)(?:\s+using\b|\s+collate\b|$)/i.exec(a);
      if (alterType && alterType[1] && alterType[2]) {
        results.push(base('alter_column_type', table, cleanIdent(alterType[1]), collapse(alterType[2])));
        continue;
      }
      const addConstraint = /^add\s+constraint\s+("?[A-Za-z0-9_]+"?)\b/i.exec(a);
      if (addConstraint && addConstraint[1]) {
        results.push(base('add_constraint', table, cleanIdent(addConstraint[1]), collapse(a)));
        continue;
      }
      const dropConstraint = /^drop\s+constraint\s+(?:if\s+exists\s+)?("?[A-Za-z0-9_]+"?)\b/i.exec(a);
      if (dropConstraint && dropConstraint[1]) {
        results.push(base('drop_constraint', table, cleanIdent(dropConstraint[1]), null));
        continue;
      }
    }
    if (results.length === 0) results.push(base('other', table, null, null));
    return results;
  }

  if (/^create\s+policy\b/i.test(sql)) {
    const m = /create\s+policy\s+("?[A-Za-z0-9_ ]+"?)/i.exec(sql);
    return [base('add_constraint', null, m && m[1] ? m[1].replace(/"/g, '').trim() : null, 'policy')];
  }
  if (/^drop\s+policy\b/i.test(sql)) {
    const m = /drop\s+policy\s+(?:if\s+exists\s+)?("?[A-Za-z0-9_ ]+"?)\s+on\s+([A-Za-z0-9_."`]+)/i.exec(sql);
    return [base('drop_constraint', m && m[2] ? cleanIdent(m[2]) : null, m && m[1] ? m[1].replace(/"/g, '').trim() : null, 'policy')];
  }

  return [base('other', null, null, null)];
}

// ---------------------------------------------------------------------------
// Diff against the current production schema
// ---------------------------------------------------------------------------

/** Compute the structured diff of the migration's intents against the production snapshot. */
export function computeDiff(intents: readonly StatementIntent[], production: SchemaSnapshot): SchemaDiff {
  const prodTables = new Map(production.tables.map((t) => [t.name.toLowerCase(), t]));
  const colType = (table: string | null, column: string | null): string | null => {
    if (!table || !column) return null;
    const t = prodTables.get(table.toLowerCase());
    const c = t?.columns.find((x) => x.name.toLowerCase() === column.toLowerCase());
    return c ? c.type : null;
  };
  const diff: SchemaDiff = {
    tablesAdded: [],
    tablesDropped: [],
    columnsAdded: [],
    columnsDropped: [],
    columnsRetyped: [],
    indexesAdded: [],
    indexesDropped: [],
    policiesAdded: [],
    policiesDropped: [],
    constraintsAdded: [],
    constraintsDropped: [],
    unclassifiedStatements: 0,
  };

  for (const it of intents) {
    switch (it.kind) {
      case 'create_table':
        if (it.table) diff.tablesAdded.push(it.table);
        break;
      case 'drop_table':
        if (it.table) diff.tablesDropped.push(it.table);
        break;
      case 'add_column':
        if (it.table && it.object)
          diff.columnsAdded.push({ table: it.table, column: it.object, type: it.detail, fromType: null, existsInProduction: false });
        break;
      case 'drop_column':
        if (it.table && it.object)
          diff.columnsDropped.push({
            table: it.table,
            column: it.object,
            type: null,
            fromType: colType(it.table, it.object),
            existsInProduction: colType(it.table, it.object) !== null,
          });
        break;
      case 'alter_column_type':
        if (it.table && it.object)
          diff.columnsRetyped.push({
            table: it.table,
            column: it.object,
            type: it.detail,
            fromType: colType(it.table, it.object),
            existsInProduction: colType(it.table, it.object) !== null,
          });
        break;
      case 'create_index':
        if (it.object) diff.indexesAdded.push(it.object);
        break;
      case 'drop_index':
        if (it.object) diff.indexesDropped.push(it.object);
        break;
      case 'add_constraint':
        if (it.object) (it.detail === 'policy' ? diff.policiesAdded : diff.constraintsAdded).push(it.object);
        break;
      case 'drop_constraint':
        if (it.object) (it.detail === 'policy' ? diff.policiesDropped : diff.constraintsDropped).push(it.object);
        break;
      case 'truncate':
      case 'delete':
        break;
      default:
        diff.unclassifiedStatements++;
    }
  }

  // Annotate add_column existence (a re-add of an existing column is a conflict, surfaced in the report).
  for (const ch of diff.columnsAdded) {
    ch.existsInProduction = colType(ch.table, ch.column) !== null;
  }

  return diff;
}

/** Render the markdown "exactly what changes" diff report. */
export function renderDiffReport(diff: SchemaDiff, production: SchemaSnapshot): string {
  const lines: string[] = [];
  lines.push('## Schema Diff vs Production');
  lines.push('');
  lines.push(`- Production schema source: \`${production.source}\` (${production.tables.length} table(s) known).`);
  lines.push('');

  const section = (title: string, items: string[]): void => {
    lines.push(`**${title}:** ${items.length === 0 ? '_none_' : ''}`);
    for (const i of items) lines.push(`- ${i}`);
    lines.push('');
  };

  section('Tables added', diff.tablesAdded);
  section('Tables dropped', diff.tablesDropped);
  section(
    'Columns added',
    diff.columnsAdded.map((c) => `${c.table}.${c.column}${c.type ? ` (${c.type})` : ''}${c.existsInProduction ? ' ⚠ already exists in production' : ''}`)
  );
  section(
    'Columns dropped',
    diff.columnsDropped.map((c) => `${c.table}.${c.column}${c.fromType ? ` (was ${c.fromType})` : ''}${c.existsInProduction ? '' : ' ⚠ not present in production (no-op?)'}`)
  );
  section(
    'Columns retyped',
    diff.columnsRetyped.map((c) => `${c.table}.${c.column}: ${c.fromType ?? '?'} → ${c.type ?? '?'}`)
  );
  section('Indexes added', diff.indexesAdded);
  section('Indexes dropped', diff.indexesDropped);
  section('Policies added', diff.policiesAdded);
  section('Policies dropped', diff.policiesDropped);
  section('Constraints added', diff.constraintsAdded);
  section('Constraints dropped', diff.constraintsDropped);
  if (diff.unclassifiedStatements > 0) {
    lines.push(`_${diff.unclassifiedStatements} statement(s) not classified for the diff (informational)._`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// RLS / FK breakage detection
// ---------------------------------------------------------------------------

/** True when a normalized policy expression references `column` of `table`. */
function expressionReferencesColumn(expr: string | null, column: string): boolean {
  if (!expr) return false;
  const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(column.toLowerCase())}([^A-Za-z0-9_]|$)`);
  return re.test(expr.toLowerCase());
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Flag RLS policies and foreign keys the destructive operations would break, given the current
 * production schema. A dropped TABLE breaks every policy ON it and every FK touching it; a dropped
 * COLUMN breaks any policy whose USING/WITH CHECK references it and any FK it participates in.
 */
export function detectBreakages(
  ops: readonly DestructiveOperation[],
  production: SchemaSnapshot,
  confirmations: readonly string[]
): { rls: BreakageFinding[]; fk: BreakageFinding[] } {
  const globalConfirms = confirmations.map((c) => c.trim().toLowerCase());
  const ack = (kind: BreakageKind, objectName: string, table: string): boolean => {
    const want = [kind === 'rls_policy' ? 'rls' : 'fk', 'all', '*', objectName.toLowerCase(), table.toLowerCase()];
    return globalConfirms.some((c) => want.includes(c));
  };

  const rls: BreakageFinding[] = [];
  const fk: BreakageFinding[] = [];

  const droppedTables = new Set(
    ops.filter((o) => o.type === 'drop_table' && o.table).map((o) => (o.table as string).toLowerCase())
  );
  const droppedColumns = ops
    .filter((o) => o.type === 'drop_column' && o.table && o.column)
    .map((o) => ({ table: (o.table as string).toLowerCase(), column: (o.column as string).toLowerCase(), op: o }));

  // RLS policies.
  for (const policy of production.rlsPolicies) {
    const policyTable = policy.table.toLowerCase();
    if (droppedTables.has(policyTable)) {
      rls.push(rlsBreakage(policy, { type: 'drop_table', table: policy.table, column: null }, `dropping table '${policy.table}' removes RLS policy '${policy.name}'`, ack));
      continue;
    }
    for (const dc of droppedColumns) {
      if (dc.table !== policyTable) continue;
      if (expressionReferencesColumn(policy.using, dc.column) || expressionReferencesColumn(policy.withCheck, dc.column)) {
        rls.push(rlsBreakage(policy, { type: 'drop_column', table: dc.op.table, column: dc.op.column }, `dropping column '${dc.table}.${dc.column}' breaks RLS policy '${policy.name}' (its USING/CHECK expression references it)`, ack));
      }
    }
  }

  // Foreign keys (every relationship, both directions).
  for (const rel of production.relationships) {
    const from = rel.fromTable.toLowerCase();
    const to = rel.toTable.toLowerCase();
    const name = rel.constraintName ?? `${rel.fromTable}→${rel.toTable}`;
    if (droppedTables.has(from) || droppedTables.has(to)) {
      const dropped = droppedTables.has(from) ? rel.fromTable : rel.toTable;
      fk.push(fkBreakage(rel, name, { type: 'drop_table', table: dropped, column: null }, `dropping table '${dropped}' breaks foreign key '${name}' (${rel.fromTable}.${rel.fromColumns.join(',')} → ${rel.toTable}.${rel.toColumns.join(',')})`, ack));
      continue;
    }
    for (const dc of droppedColumns) {
      const onFrom = dc.table === from && rel.fromColumns.some((c) => c.toLowerCase() === dc.column);
      const onTo = dc.table === to && rel.toColumns.some((c) => c.toLowerCase() === dc.column);
      if (onFrom || onTo) {
        fk.push(fkBreakage(rel, name, { type: 'drop_column', table: dc.op.table, column: dc.op.column }, `dropping column '${dc.table}.${dc.column}' breaks foreign key '${name}' (${rel.fromTable}.${rel.fromColumns.join(',')} → ${rel.toTable}.${rel.toColumns.join(',')})`, ack));
      }
    }
  }

  return { rls, fk };
}

function rlsBreakage(
  policy: RlsPolicy,
  cause: BreakageFinding['cause'],
  message: string,
  ack: (kind: BreakageKind, objectName: string, table: string) => boolean
): BreakageFinding {
  return {
    kind: 'rls_policy',
    rule: 'migration.breaks_rls',
    cause,
    objectName: policy.name,
    objectTable: policy.table,
    message,
    acknowledged: ack('rls_policy', policy.name, policy.table),
  };
}

function fkBreakage(
  rel: Relationship,
  name: string,
  cause: BreakageFinding['cause'],
  message: string,
  ack: (kind: BreakageKind, objectName: string, table: string) => boolean
): BreakageFinding {
  return {
    kind: 'foreign_key',
    rule: 'migration.breaks_fk',
    cause,
    objectName: name,
    objectTable: rel.fromTable,
    message,
    acknowledged: ack('foreign_key', name, rel.fromTable),
  };
}

// ---------------------------------------------------------------------------
// Rollback generation
// ---------------------------------------------------------------------------

/** Render a column definition (`name type [not null] [default x]`) from a production column. */
export function renderColumnDef(col: ColumnSchema): string {
  const parts = [col.name, col.type];
  if (!col.nullable) parts.push('not null');
  if (col.default !== null && col.default !== '') parts.push(`default ${col.default}`);
  return parts.join(' ');
}

/** Render a best-effort `CREATE TABLE` from a production table snapshot (for rollback). */
export function renderCreateTable(table: TableSchema): string {
  const cols = table.columns.map((c) => `  ${renderColumnDef(c)}`);
  if (table.primaryKey.length > 0) cols.push(`  primary key (${table.primaryKey.join(', ')})`);
  for (const fk of table.foreignKeys) {
    const ref = `${fk.referencesTable}${fk.referencesColumns.length ? `(${fk.referencesColumns.join(', ')})` : ''}`;
    const onDel = fk.onDelete ? ` on delete ${fk.onDelete}` : '';
    cols.push(`  foreign key (${fk.columns.join(', ')}) references ${ref}${onDel}`);
  }
  const schemaPrefix = table.schema && table.schema !== 'public' ? `${table.schema}.` : '';
  return `create table ${schemaPrefix}${table.name} (\n${cols.join(',\n')}\n);`;
}

/**
 * Generate an inverse migration for the classified statements (reversed order), reconstructing
 * dropped tables/columns/retypes from the current production schema. Statements that cannot be
 * inverted as SQL (TRUNCATE/DELETE, plain data) become commented restore-from-backup pointers.
 */
export function generateRollback(
  intents: readonly StatementIntent[],
  production: SchemaSnapshot,
  migrationName: string,
  backupFilename: string
): string {
  const prodTables = new Map(production.tables.map((t) => [t.name.toLowerCase(), t]));
  const lines: string[] = [];
  lines.push(`-- FORGE auto-generated ROLLBACK for migration: ${migrationName}`);
  lines.push('-- Apply this to revert the migration. Statements are the inverse, in reverse order.');
  lines.push(`-- Data dropped/truncated/deleted is NOT recoverable from SQL — restore it from the backup: ${backupFilename}`);
  lines.push('');

  // Reverse order so the inverse undoes the most recent change first.
  for (const it of [...intents].reverse()) {
    switch (it.kind) {
      case 'create_table':
        lines.push(it.table ? `drop table if exists ${it.table};` : `-- (could not parse created table name)`);
        break;
      case 'drop_table': {
        const t = it.table ? prodTables.get(it.table.toLowerCase()) : undefined;
        if (t) {
          lines.push(`-- recreate dropped table '${it.table}' from its production definition (data restored from backup):`);
          lines.push(renderCreateTable(t));
        } else {
          lines.push(`-- cannot auto-recreate dropped table '${it.table ?? '?'}' — its definition was not in the production schema snapshot.`);
        }
        break;
      }
      case 'add_column':
        lines.push(it.table && it.object ? `alter table ${it.table} drop column if exists ${it.object};` : `-- (could not parse added column)`);
        break;
      case 'drop_column': {
        const t = it.table ? prodTables.get(it.table.toLowerCase()) : undefined;
        const col = t?.columns.find((c) => c.name.toLowerCase() === (it.object ?? '').toLowerCase());
        if (it.table && col) {
          lines.push(`alter table ${it.table} add column ${renderColumnDef(col)}; -- data restored from backup`);
        } else {
          lines.push(`-- cannot auto-restore dropped column '${it.table ?? '?'}.${it.object ?? '?'}' — not in the production schema snapshot.`);
        }
        break;
      }
      case 'alter_column_type': {
        const t = it.table ? prodTables.get(it.table.toLowerCase()) : undefined;
        const col = t?.columns.find((c) => c.name.toLowerCase() === (it.object ?? '').toLowerCase());
        if (it.table && it.object && col) {
          lines.push(`alter table ${it.table} alter column ${it.object} type ${col.type}; -- revert to the production type`);
        } else {
          lines.push(`-- cannot auto-revert type of '${it.table ?? '?'}.${it.object ?? '?'}' — original type unknown from the production schema snapshot.`);
        }
        break;
      }
      case 'create_index':
        lines.push(it.object ? `drop index if exists ${it.object};` : `-- (could not parse created index)`);
        break;
      case 'drop_index':
        lines.push(`-- cannot auto-recreate dropped index '${it.object ?? '?'}' — re-add it from its original definition.`);
        break;
      case 'add_constraint':
        if (it.detail === 'policy') {
          lines.push(`-- drop policy '${it.object ?? '?'}'${it.table ? ` on ${it.table}` : ''}; -- (added by the migration)`);
        } else {
          lines.push(it.table && it.object ? `alter table ${it.table} drop constraint if exists ${it.object};` : `-- (could not parse added constraint)`);
        }
        break;
      case 'drop_constraint':
        lines.push(`-- cannot auto-recreate dropped ${it.detail === 'policy' ? 'policy' : 'constraint'} '${it.object ?? '?'}'${it.table ? ` on ${it.table}` : ''} — re-add it from its original definition.`);
        break;
      case 'truncate':
        lines.push(`-- TRUNCATE of '${it.table ?? '?'}' is irreversible in SQL — restore rows from the backup: ${backupFilename}`);
        break;
      case 'delete':
        lines.push(`-- DELETE on '${it.table ?? '?'}' is irreversible in SQL — restore rows from the backup: ${backupFilename}`);
        break;
      default:
        lines.push(`-- no automatic inverse for: ${it.sql}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Backup-script generation
// ---------------------------------------------------------------------------

/** Compute the affected tables (those a destructive op touches), de-duplicated and sorted. */
export function affectedTablesOf(ops: readonly DestructiveOperation[]): string[] {
  const set = new Set<string>();
  for (const op of ops) if (op.table) set.add(op.table);
  return [...set].sort();
}

/**
 * Generate a runnable Node backup script that exports every affected table to a timestamped JSON
 * file BEFORE the migration runs. Uses `@supabase/supabase-js` (already a project dependency) and
 * reads its connection from the standard FORGE env vars. Returns an empty script when no table is
 * affected (a purely additive migration needs no backup).
 */
export function generateBackupScript(affectedTables: readonly string[], migrationName: string): BackupScript {
  const safeName = (migrationName || 'migration').replace(/[^A-Za-z0-9_.-]/g, '_');
  const filename = `backup-${safeName}.mjs`;
  if (affectedTables.length === 0) {
    return { affectedTables: [], language: 'node', filename, script: '' };
  }
  const tablesLiteral = JSON.stringify(affectedTables);
  const script = `#!/usr/bin/env node
// FORGE auto-generated DATA BACKUP for migration: ${migrationName}
// Run this BEFORE applying the migration. It exports every affected table to JSON
// under ./backups/ so a DROP/TRUNCATE/DELETE remains recoverable.
//   node ${filename}
import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const url = process.env.FORGE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const key = process.env.FORGE_SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('Missing FORGE_SUPABASE_URL / FORGE_SUPABASE_SERVICE_KEY — cannot back up.');
  process.exit(1);
}

const TABLES = ${tablesLiteral};
const supabase = createClient(url, key, { auth: { persistSession: false } });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = join('backups', '${safeName}-' + stamp);

await mkdir(dir, { recursive: true });
let failures = 0;
for (const table of TABLES) {
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  // Page through the whole table so large tables are fully captured.
  for (;;) {
    const { data, error } = await supabase.from(table).select('*').range(from, from + pageSize - 1);
    if (error) {
      console.error('Backup FAILED for ' + table + ': ' + error.message);
      failures++;
      break;
    }
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  const out = join(dir, table + '.json');
  await writeFile(out, JSON.stringify(rows, null, 2), 'utf8');
  console.log('Backed up ' + rows.length + ' row(s) from ' + table + ' -> ' + out);
}
if (failures > 0) {
  console.error(failures + ' table(s) failed to back up — DO NOT apply the migration.');
  process.exit(1);
}
console.log('Backup complete: ' + dir);
`;
  return { affectedTables: [...affectedTables], language: 'node', filename, script };
}

// ---------------------------------------------------------------------------
// Full report rendering
// ---------------------------------------------------------------------------

/** Render the full markdown migration-safety report. */
function renderReport(
  report: Omit<MigrationSafetyReport, 'report'>,
  migrationName: string
): string {
  const lines: string[] = [];
  lines.push('# FORGE Migration Safety — Pre-Migration Gate');
  lines.push('');
  lines.push(`- **Migration:** ${migrationName}`);
  lines.push(`- **Verdict:** ${report.passed ? 'SAFE ✅ (gate may proceed)' : 'BLOCKED ❌ (do not apply)'}`);
  lines.push(`- **Statements analyzed:** ${report.statementCount}`);
  lines.push(`- **Production schema source:** \`${report.productionSchemaSource}\``);
  lines.push('');

  // Destructive operations.
  lines.push('## Destructive Operations');
  lines.push('');
  if (report.destructiveOperations.length === 0) {
    lines.push('_None detected — the migration performs no DROP TABLE / DROP COLUMN / lossy ALTER COLUMN / TRUNCATE / unqualified DELETE._');
  } else {
    lines.push('| Stmt | Type | Target | Confirmed | Detail |');
    lines.push('|------|------|--------|-----------|--------|');
    for (const op of report.destructiveOperations) {
      const target = [op.table, op.column].filter(Boolean).join('.') || '?';
      const conf = op.confirmed ? `yes (${op.confirmedBy})` : '**NO**';
      lines.push(`| ${op.statementIndex} | ${op.type} | ${target} | ${conf} | ${op.message.replace(/\|/g, '\\|')} |`);
    }
    if (report.unconfirmed.length > 0) {
      lines.push('');
      lines.push(`> ❌ ${report.unconfirmed.length} destructive operation(s) are UNCONFIRMED. Add an inline \`-- forge:confirm <op|table>\` marker or pass a \`confirmations\` entry for each before applying.`);
    }
  }
  lines.push('');

  // Breakages.
  lines.push('## Breakage Flags (RLS / Foreign Keys)');
  lines.push('');
  const allBreakages = [...report.rlsBreakages, ...report.fkBreakages];
  if (allBreakages.length === 0) {
    lines.push('_No existing RLS policy or foreign-key relationship would be broken._');
  } else {
    for (const b of allBreakages) {
      lines.push(`- ${b.acknowledged ? '⚠ (acknowledged)' : '❌'} [${b.kind}] ${b.message}`);
    }
  }
  lines.push('');

  // Diff.
  lines.push(report.diffReport);
  lines.push('');

  // Artifacts.
  lines.push('## Generated Artifacts');
  lines.push('');
  lines.push(`- **Rollback migration:** auto-generated (${report.rollbackMigration.split('\n').length} lines).`);
  lines.push(
    report.backupScript.affectedTables.length > 0
      ? `- **Data backup script:** \`${report.backupScript.filename}\` — exports ${report.backupScript.affectedTables.length} affected table(s): ${report.backupScript.affectedTables.join(', ')}.`
      : '- **Data backup script:** not needed (no table loses data).'
  );
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('## Warnings');
    lines.push('');
    for (const w of report.warnings) lines.push(`- ${w}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Default Build-Memory store (production_telemetry, guarded — Contract 4)
// ---------------------------------------------------------------------------

async function defaultStoreHistory(record: MigrationStoredRecord, log: (m: string) => void): Promise<void> {
  const eventType: TelemetryEventType = record.blocked ? 'error' : 'usage';
  const severity: TelemetrySeverity = record.blocked
    ? 'critical'
    : record.destructiveCount > 0
      ? 'warning'
      : 'info';
  const eventData: JsonObject = {
    kind: 'migration_safety',
    migrationName: record.migrationName,
    passed: record.passed,
    blocked: record.blocked,
    destructiveCount: record.destructiveCount,
    unconfirmedCount: record.unconfirmedCount,
    rlsBreakageCount: record.rlsBreakageCount,
    fkBreakageCount: record.fkBreakageCount,
    affectedTables: [...record.affectedTables],
    diffSummary: { ...record.diffSummary },
    productionSchemaSource: record.productionSchemaSource,
    generatedAt: record.generatedAt,
  };
  try {
    await BuildMemory.telemetry.createEvent({
      project_name: record.projectName,
      build_run_id: record.buildRunId,
      event_type: eventType,
      event_data: eventData,
      severity,
      captured_at: record.generatedAt,
    });
  } catch (error) {
    log(`WARNING: Build Memory store degraded (${describe(error)}) — migration history not persisted`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point — analyzeMigration
// ---------------------------------------------------------------------------

/**
 * Analyze a migration's SQL for safety BEFORE it is applied, and return a {@link MigrationSafetyReport}
 * with the destructive operations, RLS/FK breakages, production diff, auto-generated rollback, and data
 * backup script. NON-FATAL — always resolves, never throws (Iron Law 3); an unreachable production
 * database degrades the diff/breakage/rollback analysis (warnings recorded) but still reports the
 * destructive operations parsed straight from the SQL. The migration is `passed` (safe) only when every
 * destructive operation is confirmed AND no un-acknowledged RLS/FK breakage exists.
 */
export async function analyzeMigration(
  input: MigrationSafetyInput,
  options: MigrationSafetyOptions = {}
): Promise<MigrationSafetyReport> {
  const log = options.log ?? logLine('migration');
  const now = options.now ?? nowIso;
  const generatedAt = now();
  const migrationName = input.migrationName ?? 'migration';
  const projectName = input.projectName ?? (input.projectPath ? basename(input.projectPath) : 'unknown');
  const confirmations = input.confirmations ?? [];
  const flagAllTypeChanges = options.flagAllTypeChanges ?? true;
  const warnings: string[] = [];

  log(`analyzing migration '${migrationName}'`);

  // 1. Parse + detect destructive operations (always available — no DB needed).
  const statements = splitStatementsWithComments(input.sql);
  const destructiveOperations = detectDestructiveOperations(statements, confirmations, flagAllTypeChanges);
  const unconfirmed = destructiveOperations.filter((o) => !o.confirmed);

  // 2. Resolve the current production schema (live introspection / supplied snapshot / migrations).
  const production = await resolveProductionSchema(input, options, warnings, log);

  // 3. Classify statements → diff + breakages + rollback.
  const intents = classifyStatements(statements);
  const diff = computeDiff(intents, production);
  const diffReport = renderDiffReport(diff, production);
  const { rls, fk } = detectBreakages(destructiveOperations, production, confirmations);

  // 4. Artifacts: backup script (affected tables) + rollback migration.
  const affectedTables = affectedTablesOf(destructiveOperations);
  const backupScript = generateBackupScript(affectedTables, migrationName);
  const rollbackMigration = generateRollback(intents, production, migrationName, backupScript.filename || 'backup');

  // 5. Verdict: safe only when nothing destructive is unconfirmed AND no un-acknowledged breakage.
  const unacknowledgedBreakages = [...rls, ...fk].filter((b) => !b.acknowledged);
  const passed = unconfirmed.length === 0 && unacknowledgedBreakages.length === 0;

  const partial: Omit<MigrationSafetyReport, 'report'> = {
    passed,
    blocked: !passed,
    destructiveOperations,
    unconfirmed,
    rlsBreakages: rls,
    fkBreakages: fk,
    diff,
    diffReport,
    rollbackMigration,
    backupScript,
    productionSchemaSource: production.source,
    statementCount: statements.length,
    warnings,
    generatedAt,
  };
  const report = renderReport(partial, migrationName);
  const full: MigrationSafetyReport = { ...partial, report };

  // 6. Store migration history in Build Memory (guarded — Contract 4).
  const store = options.storeHistory ?? defaultStoreHistory;
  await store(
    {
      projectName,
      buildRunId: input.buildRunId ?? null,
      migrationName,
      passed,
      blocked: !passed,
      destructiveCount: destructiveOperations.length,
      unconfirmedCount: unconfirmed.length,
      rlsBreakageCount: rls.length,
      fkBreakageCount: fk.length,
      affectedTables,
      diffSummary: {
        tablesAdded: diff.tablesAdded.length,
        tablesDropped: diff.tablesDropped.length,
        columnsAdded: diff.columnsAdded.length,
        columnsDropped: diff.columnsDropped.length,
        columnsRetyped: diff.columnsRetyped.length,
      },
      productionSchemaSource: production.source,
      generatedAt,
    },
    log
  );

  log(passed ? 'migration safety: SAFE ✅' : `migration safety: BLOCKED ❌ (${unconfirmed.length} unconfirmed, ${unacknowledgedBreakages.length} breakage(s))`);
  return full;
}

/** Resolve the production schema from a supplied snapshot, a live executor, or migration files. */
async function resolveProductionSchema(
  input: MigrationSafetyInput,
  options: MigrationSafetyOptions,
  warnings: string[],
  log: (m: string) => void
): Promise<SchemaSnapshot> {
  if (input.productionSchema) return input.productionSchema;

  const schema = input.schema ?? 'public';
  let executor: SqlExecutor | null = input.schemaSql ?? null;
  if (!executor && input.supabase) {
    const rpcOpts: { rpc?: string; param?: string } = {};
    if (options.supabaseRpc) rpcOpts.rpc = options.supabaseRpc;
    if (options.supabaseRpcParam) rpcOpts.param = options.supabaseRpcParam;
    executor = createSupabaseExecutor(input.supabase, rpcOpts);
  }

  if (!executor && !input.projectPath) {
    warnings.push(
      'No production schema available (no live connection, no Supabase client, no projectPath) — diff, breakage analysis, and rollback reconstruction are limited to what the migration SQL itself reveals.'
    );
    return { tables: [], relationships: [], indexes: [], rlsPolicies: [], source: 'none', migrationFiles: [], warnings: [] };
  }

  try {
    const snap = await extractSchema({
      ...(input.projectPath ? { projectPath: input.projectPath } : {}),
      ...(executor ? { sql: executor } : {}),
      schema,
    });
    if (snap.tables.length === 0) {
      warnings.push(`Production schema introspection returned no tables (source: ${snap.source}) — breakage/diff analysis limited.`);
    }
    for (const w of snap.warnings) warnings.push(`schema: ${w}`);
    return snap;
  } catch (error) {
    warnings.push(`Production schema introspection failed (${describe(error)}) — diff/breakage analysis limited.`);
    log(`WARNING: production schema introspection failed (${describe(error)})`);
    return { tables: [], relationships: [], indexes: [], rlsPolicies: [], source: 'none', migrationFiles: [], warnings: [] };
  }
}

export default analyzeMigration;
