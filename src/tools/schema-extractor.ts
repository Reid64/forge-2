/**
 * FORGE 2.0 — Schema Extractor (Phase 1C Current State Ingestion helper).
 *
 * Given a project path AND/OR a live database connection, reconstruct the current
 * database schema into a single `SchemaSnapshot` so Phase 1C (s3-p03) can treat the
 * existing schema as immutable constraints and design only the remaining portions.
 *
 * Two independent sources, either or both of which may be supplied:
 *
 *   1. MIGRATION SQL FILES (always available from a `projectPath`). Every `.sql`
 *      file under the conventional migration directories is read and parsed for:
 *        - CREATE TABLE   → table name, columns (name, type, nullable, default,
 *                           constraints), primary key, foreign keys, inline + table
 *                           level constraints (PK / FK / UNIQUE / CHECK).
 *        - ALTER TABLE    → ADD [CONSTRAINT] PRIMARY KEY / FOREIGN KEY / UNIQUE,
 *                           ADD COLUMN, and ENABLE/DISABLE ROW LEVEL SECURITY. ALTER
 *                           statements wrapped inside a `do $$ … $$` block (the way
 *                           FORGE's own migration 003 closes a circular FK) are also
 *                           parsed by descending into the dollar-quoted body.
 *        - CREATE INDEX   → name, table, columns, uniqueness, method (btree/gin/…),
 *                           and partial-index predicate.
 *        - CREATE POLICY  → RLS policy name, table, command, roles, USING /
 *                           WITH CHECK expressions, permissive vs. restrictive.
 *
 *   2. LIVE SUPABASE / POSTGRES (when a `sql` executor or `supabase` client is
 *      supplied). Standard catalog introspection queries are run:
 *        - information_schema.columns                → tables + columns
 *        - information_schema.table_constraints (+ key_column_usage /
 *          constraint_column_usage / referential_constraints) → PK / FK / UNIQUE
 *        - pg_indexes                                → indexes (indexdef parsed)
 *        - pg_policies                               → RLS policies
 *        - pg_class.relrowsecurity                   → which tables have RLS enabled
 *      The live schema is GROUND TRUTH: when both sources are present it overrides
 *      the migration-derived schema on a per-table basis (a `merged` snapshot).
 *
 * Output contract (per queue.yaml s3-p02):
 *   SchemaSnapshot = { tables[], relationships[], indexes[], rlsPolicies[] }
 *   where each table = { name, columns[], primaryKey[], foreignKeys[] } and each
 *   column = { name, type, nullable, default, constraints[] }.
 *
 * Like the sibling Phase 0/1 tools (stack-detector, env-auditor, codebase-reader),
 * this extractor is best-effort and NON-FATAL: every file read and every database
 * query is guarded, missing files / unreachable databases are skipped, and a
 * partial snapshot is a valid result. `extractSchema` never throws — the worst case
 * is an empty snapshot plus a warning.
 *
 * SECURITY: only schema metadata (table/column/constraint/index/policy definitions)
 * is read. No table DATA is queried, and `.env*` secret values are never touched —
 * the live connection is supplied by the caller, never harvested here.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

/** A single column of a table. */
export interface ColumnSchema {
  name: string;
  /** Raw column type as written / reported (e.g. `numeric(10,4)`, `timestamptz`, `uuid`). */
  type: string;
  /** `false` when a `not null` constraint applies. */
  nullable: boolean;
  /** Default expression as written, or `null` if none. */
  default: string | null;
  /**
   * Normalized constraint clauses attached to this column, e.g.
   * `['not null', 'unique', 'references public.foo(id) on delete cascade']`.
   */
  constraints: string[];
}

/** A foreign-key relationship declared on a table. */
export interface ForeignKey {
  /** Constraint name, or `null` if anonymous / not captured. */
  name: string | null;
  /** Local column(s) the FK is defined on. */
  columns: string[];
  /** Referenced table (schema prefix stripped). */
  referencesTable: string;
  /** Referenced column(s); may be empty if the SQL omitted them. */
  referencesColumns: string[];
  /** `on delete` action, lower-cased (e.g. `cascade`, `set null`), or `null`. */
  onDelete: string | null;
  /** `on update` action, lower-cased, or `null`. */
  onUpdate: string | null;
}

/** A single table in the schema. */
export interface TableSchema {
  /** Table name without any schema prefix (e.g. `build_runs`). */
  name: string;
  /** Containing schema (almost always `public`). */
  schema: string;
  columns: ColumnSchema[];
  /** Column names that make up the primary key (in order). */
  primaryKey: string[];
  foreignKeys: ForeignKey[];
  /** Whether row-level security is enabled on this table. */
  rlsEnabled: boolean;
}

/** A FK-derived relationship between two tables (flat view of every foreign key). */
export interface Relationship {
  /** FK constraint name, or `null` if anonymous. */
  constraintName: string | null;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  onDelete: string | null;
  onUpdate: string | null;
}

/** A database index. */
export interface IndexSchema {
  name: string;
  table: string;
  /** Indexed column names / expressions (best-effort). */
  columns: string[];
  unique: boolean;
  /** Access method (`btree`, `gin`, `gist`, …), or `null` if not stated. */
  method: string | null;
  /** Partial-index predicate (`WHERE …`), or `null`. */
  predicate: string | null;
}

/** A row-level-security policy. */
export interface RlsPolicy {
  name: string;
  table: string;
  /** `ALL` | `SELECT` | `INSERT` | `UPDATE` | `DELETE`. */
  command: string;
  /** Roles the policy applies to (e.g. `['public']`, `['authenticated']`). */
  roles: string[];
  /** `true` for PERMISSIVE (default), `false` for RESTRICTIVE. */
  permissive: boolean;
  /** `USING (…)` expression, or `null`. */
  using: string | null;
  /** `WITH CHECK (…)` expression, or `null`. */
  withCheck: string | null;
}

/** Which source(s) produced a snapshot. */
export type SchemaSource = 'migrations' | 'live' | 'merged' | 'none';

/** The complete database-schema snapshot produced by {@link extractSchema}. */
export interface SchemaSnapshot {
  tables: TableSchema[];
  /** Flat list of every foreign-key relationship across all tables. */
  relationships: Relationship[];
  indexes: IndexSchema[];
  rlsPolicies: RlsPolicy[];
  /** Where the schema was reconstructed from. */
  source: SchemaSource;
  /** SQL migration files that were read (project-relative-ish paths). */
  migrationFiles: string[];
  /** Non-fatal observations (unreadable file, unreachable DB, parse skip, …). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * A function that runs a read-only SQL query and resolves to its result rows.
 * Supplying one enables LIVE introspection. The extractor only ever passes the
 * fixed catalog-introspection queries defined in this module (never user input).
 */
export type SqlExecutor = (sql: string) => Promise<Array<Record<string, unknown>>>;

/** Options for {@link extractSchema}. */
export interface SchemaExtractorOptions {
  /** Project root to scan for migration `.sql` files. */
  projectPath?: string;
  /**
   * Directories (relative to `projectPath`) to search for `.sql` migrations.
   * Defaults to the conventional set below.
   */
  migrationDirs?: readonly string[];
  /** Live introspection executor (takes precedence over migration data on conflict). */
  sql?: SqlExecutor;
  /**
   * Convenience: a Supabase client. When provided (and `sql` is not), an executor
   * is derived from it via {@link createSupabaseExecutor}.
   */
  supabase?: SupabaseClient;
  /** RPC function name used to run SQL through a Supabase client. Default `'exec_sql'`. */
  supabaseRpc?: string;
  /** Parameter name the RPC expects the SQL string under. Default `'query'`. */
  supabaseRpcParam?: string;
  /** Database schema to introspect. Default `'public'`. */
  schema?: string;
}

/** Default directories searched for migration SQL files. */
const DEFAULT_MIGRATION_DIRS: readonly string[] = [
  'migrations',
  'supabase/migrations',
  'db/migrations',
  'database/migrations',
  'prisma/migrations',
  '.',
];

// ---------------------------------------------------------------------------
// Generic SQL text helpers (all guarded — never throw)
// ---------------------------------------------------------------------------

/** Collapse runs of whitespace (incl. newlines) to single spaces and trim. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Strip a schema prefix and surrounding quotes from an identifier. */
function cleanIdent(raw: string): string {
  const unquoted = raw.replace(/["`]/g, '').trim();
  const dot = unquoted.lastIndexOf('.');
  return dot >= 0 ? unquoted.slice(dot + 1) : unquoted;
}

/**
 * Read a balanced parenthesised group at the start of `s` (ignoring leading
 * whitespace). Returns the inner text (without the outer parens) and the remainder
 * after the closing paren, or `null` if no balanced group is present. Parentheses
 * inside single-quoted string literals are ignored.
 */
function readBalancedParens(s: string): { inner: string; rest: string } | null {
  let i = 0;
  while (i < s.length && /\s/.test(s[i] ?? '')) i++;
  if (s[i] !== '(') return null;
  const start = i;
  let depth = 0;
  let inString = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "'") {
        // Doubled '' is an escaped quote inside the literal.
        if (s[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (c === "'") inString = true;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        return { inner: s.slice(start + 1, i), rest: s.slice(i + 1) };
      }
    }
  }
  return null; // unbalanced
}

/** Split a parenthesised body on top-level commas (commas inside parens/strings preserved). */
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

/**
 * Split a SQL script into individual statements on top-level semicolons, correctly
 * skipping line/block comments and respecting single-quoted strings, double-quoted
 * identifiers, and dollar-quoted blocks (`$$ … $$` / `$tag$ … $tag$`). Comments are
 * dropped from the returned statements.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i] ?? '';
    const next = sql[i + 1] ?? '';

    // -- line comment
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      current += ' ';
      continue;
    }
    // /* block comment */
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      current += ' ';
      continue;
    }
    // single-quoted string literal
    if (c === "'") {
      const end = scanString(sql, i);
      current += sql.slice(i, end);
      i = end;
      continue;
    }
    // double-quoted identifier
    if (c === '"') {
      const end = scanQuotedIdent(sql, i);
      current += sql.slice(i, end);
      i = end;
      continue;
    }
    // dollar-quoted block
    if (c === '$') {
      const tag = matchDollarTag(sql, i);
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    // statement terminator
    if (c === ';') {
      if (current.trim() !== '') statements.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += c;
    i++;
  }
  if (current.trim() !== '') statements.push(current.trim());
  return statements;
}

/** Index just past a single-quoted string literal starting at `start` (a `'`). */
function scanString(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      if (sql[i + 1] === "'") i += 2; // escaped quote
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
      if (sql[i + 1] === '"') i += 2; // escaped quote
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

/** Parse an `on delete` / `on update` referential action from text, lower-cased. */
function parseRefAction(text: string, kind: 'delete' | 'update'): string | null {
  const re = new RegExp(
    `on\\s+${kind}\\s+(cascade|restrict|no\\s+action|set\\s+null|set\\s+default)`,
    'i'
  );
  const m = re.exec(text);
  return m && m[1] ? collapse(m[1]).toLowerCase() : null;
}

/** Read a parenthesised, comma-separated identifier list from the start of `s`. */
function readIdentList(s: string): { columns: string[]; rest: string } | null {
  const parens = readBalancedParens(s);
  if (!parens) return null;
  const columns = splitTopLevelCommas(parens.inner)
    .map((part) => cleanIdent(firstToken(part)))
    .filter((c) => c !== '');
  return { columns, rest: parens.rest };
}

/** First whitespace-delimited token of a trimmed string. */
function firstToken(s: string): string {
  const t = s.trim();
  const sp = t.search(/\s/);
  return sp === -1 ? t : t.slice(0, sp);
}

// ---------------------------------------------------------------------------
// Mutable builder used while assembling tables from SQL statements
// ---------------------------------------------------------------------------

interface TableBuilder {
  name: string;
  schema: string;
  columns: ColumnSchema[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
  rlsEnabled: boolean;
}

function newTable(name: string, schema: string): TableBuilder {
  return { name, schema, columns: [], primaryKey: [], foreignKeys: [], rlsEnabled: false };
}

function finalizeTable(t: TableBuilder): TableSchema {
  return {
    name: t.name,
    schema: t.schema,
    columns: t.columns,
    primaryKey: [...t.primaryKey],
    foreignKeys: t.foreignKeys,
    rlsEnabled: t.rlsEnabled,
  };
}

// ---------------------------------------------------------------------------
// CREATE TABLE parsing
// ---------------------------------------------------------------------------

/** Keywords that, at the start of a body fragment, mark a TABLE-level constraint. */
const TABLE_CONSTRAINT_LEAD =
  /^(constraint|primary\s+key|foreign\s+key|unique|check|exclude|like|references)\b/i;

/** Tokens after a column type that begin a constraint clause (and so end the type). */
const COLUMN_TYPE_TERMINATOR =
  /\b(not\s+null|null|default|primary\s+key|references|unique|check|generated|collate|constraint)\b/i;

/** Parse a single `CREATE TABLE` statement into a {@link TableBuilder}, or `null`. */
function parseCreateTable(stmt: string): TableBuilder | null {
  const head =
    /^create\s+(?:unlogged\s+|temporary\s+|temp\s+|global\s+|local\s+)*table\s+(?:if\s+not\s+exists\s+)?([A-Za-z0-9_."`]+)\s*\(/is.exec(
      stmt
    );
  if (!head || !head[1]) return null;

  const whole = head[0] ?? '';
  const body = readBalancedParens(stmt.slice(head.index + whole.length - 1));
  if (!body) return null;

  const { schema, name } = splitSchemaTable(head[1]);
  const table = newTable(name, schema);

  for (const fragment of splitTopLevelCommas(body.inner)) {
    const frag = fragment.trim();
    if (frag === '') continue;
    if (TABLE_CONSTRAINT_LEAD.test(frag)) {
      applyTableConstraint(table, frag);
    } else {
      const column = parseColumn(table, frag);
      if (column) table.columns.push(column);
    }
  }
  return table;
}

/** Split a possibly schema-qualified identifier into `{ schema, name }`. */
function splitSchemaTable(raw: string): { schema: string; name: string } {
  const cleaned = raw.replace(/["`]/g, '').trim();
  const dot = cleaned.lastIndexOf('.');
  if (dot < 0) return { schema: 'public', name: cleaned };
  return { schema: cleaned.slice(0, dot) || 'public', name: cleaned.slice(dot + 1) };
}

/** Parse one column-definition fragment, recording inline constraints + FKs/PK. */
function parseColumn(table: TableBuilder, frag: string): ColumnSchema | null {
  const m = /^("?[A-Za-z_][A-Za-z0-9_]*"?)\s+([\s\S]+)$/.exec(frag);
  if (!m || !m[1] || !m[2]) return null;
  const name = cleanIdent(m[1]);
  const rest = m[2];

  const term = COLUMN_TYPE_TERMINATOR.exec(rest);
  const type = collapse(term ? rest.slice(0, term.index) : rest);

  const explicitNotNull = /\bnot\s+null\b/i.test(rest);
  const isPk = /\bprimary\s+key\b/i.test(rest);
  // A PRIMARY KEY column is implicitly NOT NULL even without the explicit clause.
  const nullable = !explicitNotNull && !isPk;

  const defMatch =
    /\bdefault\s+([\s\S]+?)(?:\s+(?:not\s+null|null|primary\s+key|references|unique|check|generated|collate|constraint)\b|$)/i.exec(
      rest
    );
  const def = defMatch && defMatch[1] ? collapse(defMatch[1]) : null;

  const constraints: string[] = [];
  if (explicitNotNull) constraints.push('not null');
  if (isPk) constraints.push('primary key');
  if (/\bunique\b/i.test(rest)) constraints.push('unique');
  if (def !== null) constraints.push(`default ${def}`);

  // Inline references → single-column foreign key.
  const refMatch = /\breferences\s+([A-Za-z0-9_."`]+)\s*(\([^)]*\))?/i.exec(rest);
  if (refMatch && refMatch[1]) {
    const refTable = cleanIdent(refMatch[1]);
    const refCols = refMatch[2]
      ? splitTopLevelCommas(refMatch[2].slice(1, -1)).map((c) => cleanIdent(firstToken(c)))
      : [];
    const onDelete = parseRefAction(rest, 'delete');
    const onUpdate = parseRefAction(rest, 'update');
    table.foreignKeys.push({
      name: null,
      columns: [name],
      referencesTable: refTable,
      referencesColumns: refCols,
      onDelete,
      onUpdate,
    });
    constraints.push(
      `references ${refTable}${refCols.length ? `(${refCols.join(', ')})` : ''}` +
        (onDelete ? ` on delete ${onDelete}` : '') +
        (onUpdate ? ` on update ${onUpdate}` : '')
    );
  }

  const checkMatch = /\bcheck\s*(\([\s\S]+)$/i.exec(rest);
  if (checkMatch && checkMatch[1]) {
    const parens = readBalancedParens(checkMatch[1]);
    if (parens) constraints.push(`check (${collapse(parens.inner)})`);
  }

  if (isPk && !table.primaryKey.includes(name)) table.primaryKey.push(name);

  return { name, type, nullable, default: def, constraints };
}

/** Apply a TABLE-level constraint fragment (PRIMARY KEY / FOREIGN KEY / UNIQUE / …). */
function applyTableConstraint(table: TableBuilder, frag: string): void {
  let text = frag;
  let constraintName: string | null = null;

  const named = /^constraint\s+("?[A-Za-z0-9_]+"?)\s+([\s\S]+)$/i.exec(text);
  if (named && named[1] && named[2]) {
    constraintName = cleanIdent(named[1]);
    text = named[2];
  }

  // PRIMARY KEY (cols)
  const pk = /^primary\s+key\s*(\([\s\S]*)$/i.exec(text);
  if (pk && pk[1]) {
    const list = readIdentList(pk[1]);
    if (list) for (const col of list.columns) if (!table.primaryKey.includes(col)) table.primaryKey.push(col);
    return;
  }

  // FOREIGN KEY (cols) REFERENCES tbl(cols) [actions]
  const fk = /^foreign\s+key\s*(\([\s\S]*)$/i.exec(text);
  if (fk && fk[1]) {
    const cols = readIdentList(fk[1]);
    if (!cols) return;
    const refMatch = /references\s+([A-Za-z0-9_."`]+)\s*(\([\s\S]*)?$/i.exec(cols.rest);
    if (!refMatch || !refMatch[1]) return;
    const refTable = cleanIdent(refMatch[1]);
    let refCols: string[] = [];
    if (refMatch[2]) {
      const refList = readIdentList(refMatch[2]);
      if (refList) refCols = refList.columns;
    }
    table.foreignKeys.push({
      name: constraintName,
      columns: cols.columns,
      referencesTable: refTable,
      referencesColumns: refCols,
      onDelete: parseRefAction(cols.rest, 'delete'),
      onUpdate: parseRefAction(cols.rest, 'update'),
    });
    return;
  }

  // UNIQUE / CHECK at table level are recorded only as informational column-free
  // constraints elsewhere; nothing to attach to a specific column here.
}

// ---------------------------------------------------------------------------
// ALTER TABLE parsing
// ---------------------------------------------------------------------------

/** Apply an `ALTER TABLE` statement to the table map (best-effort). */
function applyAlterTable(tables: Map<string, TableBuilder>, stmt: string): void {
  const head = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([A-Za-z0-9_."`]+)\s+([\s\S]+)$/i.exec(
    stmt
  );
  if (!head || !head[1] || !head[2]) return;
  const { schema, name } = splitSchemaTable(head[1]);
  const key = tableKey(schema, name);
  let table = tables.get(key);
  if (!table) {
    // ALTER referencing a table we never saw a CREATE for — register a stub so its
    // added constraints are still captured.
    table = newTable(name, schema);
    tables.set(key, table);
  }
  const action = head[2];

  // ENABLE / DISABLE / FORCE ROW LEVEL SECURITY
  if (/\benable\s+row\s+level\s+security\b/i.test(action)) {
    table.rlsEnabled = true;
    return;
  }
  if (/\bdisable\s+row\s+level\s+security\b/i.test(action)) {
    table.rlsEnabled = false;
    return;
  }

  // ADD [CONSTRAINT name] (PRIMARY KEY | FOREIGN KEY | UNIQUE …)
  const add = /^add\s+([\s\S]+)$/i.exec(action);
  if (add && add[1]) {
    const addColumn = /^column\s+(?:if\s+not\s+exists\s+)?([\s\S]+)$/i.exec(add[1]);
    if (addColumn && addColumn[1]) {
      const column = parseColumn(table, addColumn[1]);
      if (column) table.columns.push(column);
      return;
    }
    // Treat the rest as a (possibly named) table-level constraint.
    if (TABLE_CONSTRAINT_LEAD.test(add[1])) {
      applyTableConstraint(table, add[1]);
    }
  }
}

// ---------------------------------------------------------------------------
// CREATE INDEX parsing
// ---------------------------------------------------------------------------

/** Parse a `CREATE INDEX` statement into an {@link IndexSchema}, or `null`. */
function parseCreateIndex(stmt: string): IndexSchema | null {
  const head =
    /^create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([A-Za-z0-9_."`]+)\s+on\s+(?:only\s+)?([A-Za-z0-9_."`]+)\s*([\s\S]*)$/i.exec(
      stmt
    );
  if (!head || !head[2] || !head[3]) return null;

  const unique = Boolean(head[1]);
  const name = cleanIdent(head[2]);
  const table = cleanIdent(head[3]);
  let rest = head[4] ?? '';

  let method: string | null = null;
  const using = /^using\s+([A-Za-z0-9_]+)\s*([\s\S]*)$/i.exec(rest.trim());
  if (using && using[1]) {
    method = using[1].toLowerCase();
    rest = using[2] ?? '';
  }

  const parens = readBalancedParens(rest);
  let columns: string[] = [];
  let predicate: string | null = null;
  if (parens) {
    columns = splitTopLevelCommas(parens.inner)
      .map((c) => collapse(c).replace(/\s+(asc|desc)\b/i, '').replace(/\s+nulls\s+(first|last)\b/i, ''))
      .map((c) => c.trim())
      .filter((c) => c !== '');
    const where = /\bwhere\s+([\s\S]+)$/i.exec(parens.rest);
    if (where && where[1]) predicate = collapse(where[1]);
  }

  return { name, table, columns, unique, method, predicate };
}

// ---------------------------------------------------------------------------
// CREATE POLICY parsing
// ---------------------------------------------------------------------------

/** Parse a `CREATE POLICY` statement into an {@link RlsPolicy}, or `null`. */
function parseCreatePolicy(stmt: string): RlsPolicy | null {
  const head =
    /^create\s+policy\s+("?[A-Za-z0-9_ ]+"?)\s+on\s+([A-Za-z0-9_."`]+)\s*([\s\S]*)$/i.exec(stmt);
  if (!head || !head[1] || !head[2]) return null;

  const name = head[1].replace(/"/g, '').trim();
  const table = cleanIdent(head[2]);
  const rest = head[3] ?? '';

  let permissive = true;
  const asMatch = /\bas\s+(permissive|restrictive)\b/i.exec(rest);
  if (asMatch && asMatch[1]) permissive = asMatch[1].toLowerCase() === 'permissive';

  let command = 'ALL';
  const forMatch = /\bfor\s+(all|select|insert|update|delete)\b/i.exec(rest);
  if (forMatch && forMatch[1]) command = forMatch[1].toUpperCase();

  let roles: string[] = ['public'];
  const toMatch = /\bto\s+([A-Za-z0-9_,\s"]+?)(?:\s+(?:using|with\s+check)\b|$)/i.exec(rest);
  if (toMatch && toMatch[1]) {
    const parsed = toMatch[1]
      .split(',')
      .map((r) => r.replace(/"/g, '').trim())
      .filter((r) => r !== '');
    if (parsed.length) roles = parsed;
  }

  const using = extractParenClause(rest, /\busing\s*\(/i);
  const withCheck = extractParenClause(rest, /\bwith\s+check\s*\(/i);

  return { name, table, command, roles, permissive, using, withCheck };
}

/** Extract the balanced-paren clause that follows the first match of `lead`. */
function extractParenClause(text: string, lead: RegExp): string | null {
  const m = lead.exec(text);
  if (!m || !m[0]) return null;
  // Re-include the opening paren so readBalancedParens can balance it.
  const parens = readBalancedParens(text.slice(m.index + m[0].length - 1));
  return parens ? collapse(parens.inner) : null;
}

// ---------------------------------------------------------------------------
// Migration-file extraction
// ---------------------------------------------------------------------------

/** Read a UTF-8 text file, returning `null` if it cannot be read. */
async function readTextSafe(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** List `.sql` filenames directly inside `dir` (returns `[]` on any error). */
async function listSqlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.sql'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

interface ParsedSql {
  tables: Map<string, TableBuilder>;
  indexes: IndexSchema[];
  policies: RlsPolicy[];
}

/** Build a stable map key for a table. */
function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

/** Parse every statement in one SQL script into the shared accumulator. */
function parseSqlInto(sql: string, acc: ParsedSql): void {
  for (const stmt of splitStatements(sql)) {
    classifyStatement(stmt, acc);
  }
}

/** Route a single statement to the right parser (descending into do-blocks). */
function classifyStatement(stmt: string, acc: ParsedSql): void {
  const lead = stmt.slice(0, 24).toLowerCase();

  if (/^create\s+(?:unlogged\s+|temporary\s+|temp\s+|global\s+|local\s+)*table\b/i.test(stmt)) {
    const table = parseCreateTable(stmt);
    if (table) {
      const key = tableKey(table.schema, table.name);
      const existing = acc.tables.get(key);
      if (existing) {
        // Merge columns/constraints from a re-declaration (idempotent migrations).
        mergeTableBuilder(existing, table);
      } else {
        acc.tables.set(key, table);
      }
    }
    return;
  }

  if (lead.startsWith('alter table')) {
    applyAlterTable(acc.tables, stmt);
    return;
  }

  if (/^create\s+(?:unique\s+)?index\b/i.test(stmt)) {
    const idx = parseCreateIndex(stmt);
    if (idx) acc.indexes.push(idx);
    return;
  }

  if (lead.startsWith('create policy')) {
    const policy = parseCreatePolicy(stmt);
    if (policy) acc.policies.push(policy);
    return;
  }

  // do $$ … $$  →  parse the embedded body (FORGE migration 003 hides an
  // ALTER TABLE … ADD FOREIGN KEY inside a plpgsql `if … then … end if` block).
  if (lead.startsWith('do ') || lead.startsWith('do$')) {
    const body = extractDollarBody(stmt);
    if (body !== null) {
      for (const inner of splitStatements(body)) {
        classifyStatement(inner, acc);
        // plpgsql control flow (`begin … if … then alter table …`) leaves the DDL
        // mid-statement, so also rescue a DDL keyword that is not at position 0.
        rescueEmbeddedDdl(inner, acc);
      }
    }
  }
}

/** Reclassify a DDL statement embedded after plpgsql control keywords (index > 0). */
function rescueEmbeddedDdl(stmt: string, acc: ParsedSql): void {
  const m =
    /\b(alter\s+table|create\s+(?:unique\s+)?index|create\s+table|create\s+policy)\b/i.exec(stmt);
  if (m && m.index > 0) {
    classifyStatement(stmt.slice(m.index).trim(), acc);
  }
}

/** Pull the body out of a `do $tag$ … $tag$` statement. */
function extractDollarBody(stmt: string): string | null {
  const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(stmt);
  if (!open || !open[0]) return null;
  const tag = open[0];
  const start = open.index + tag.length;
  const end = stmt.indexOf(tag, start);
  return end === -1 ? stmt.slice(start) : stmt.slice(start, end);
}

/** Merge a re-declared table into an existing builder (additive, no duplicates). */
function mergeTableBuilder(into: TableBuilder, from: TableBuilder): void {
  const haveColumns = new Set(into.columns.map((c) => c.name));
  for (const col of from.columns) if (!haveColumns.has(col.name)) into.columns.push(col);
  for (const pk of from.primaryKey) if (!into.primaryKey.includes(pk)) into.primaryKey.push(pk);
  into.foreignKeys.push(...from.foreignKeys);
  if (from.rlsEnabled) into.rlsEnabled = true;
}

/**
 * Extract schema from migration `.sql` files under `projectPath`. Returns `null`
 * (no snapshot) when no SQL files were found at all.
 */
async function extractFromMigrations(
  projectPath: string,
  migrationDirs: readonly string[],
  warnings: string[]
): Promise<{ snapshot: SchemaSnapshot; fileCount: number }> {
  const acc: ParsedSql = { tables: new Map(), indexes: [], policies: [] };
  const files: string[] = [];
  const seen = new Set<string>();

  for (const dir of migrationDirs) {
    const absDir = join(projectPath, dir);
    for (const file of await listSqlFiles(absDir)) {
      const rel = dir === '.' ? file : `${dir}/${file}`;
      if (seen.has(rel)) continue;
      seen.add(rel);
      const text = await readTextSafe(join(absDir, file));
      if (text === null) {
        warnings.push(`Could not read migration file ${rel}`);
        continue;
      }
      files.push(rel);
      parseSqlInto(text, acc);
    }
  }

  files.sort();
  const snapshot = assembleSnapshot(acc, files.length > 0 ? 'migrations' : 'none', files, warnings);
  return { snapshot, fileCount: files.length };
}

// ---------------------------------------------------------------------------
// Live introspection
// ---------------------------------------------------------------------------

/** Build a {@link SqlExecutor} from a Supabase client via a SQL-running RPC. */
export function createSupabaseExecutor(
  client: SupabaseClient,
  options: { rpc?: string; param?: string } = {}
): SqlExecutor {
  const rpc = options.rpc ?? 'exec_sql';
  const param = options.param ?? 'query';
  return async (sql: string) => {
    const { data, error } = await client.rpc(rpc, { [param]: sql });
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  };
}

/** Coerce an unknown DB cell to a trimmed string, or `''`. */
function asStr(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** Parse a Postgres text[]/array cell (JS array OR `{a,b}` literal) to string[]. */
function parsePgArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => asStr(x)).filter((x) => x !== '');
  const s = asStr(v);
  if (s === '' || s === '{}') return [];
  if (s.startsWith('{') && s.endsWith('}')) {
    return s
      .slice(1, -1)
      .split(',')
      .map((x) => x.replace(/^"|"$/g, '').trim())
      .filter((x) => x !== '');
  }
  return [s];
}

/** Render a readable column type from an information_schema.columns row. */
function formatLiveType(row: Record<string, unknown>): string {
  const dataType = asStr(row['data_type']).toLowerCase();
  const udt = asStr(row['udt_name']);

  if (dataType === 'user-defined') return udt || 'user-defined';
  if (dataType === 'array') return `${udt.replace(/^_/, '')}[]`;
  if (dataType === 'character varying') {
    const len = row['character_maximum_length'];
    return len ? `varchar(${asStr(len)})` : 'varchar';
  }
  if (dataType === 'character') {
    const len = row['character_maximum_length'];
    return len ? `char(${asStr(len)})` : 'char';
  }
  if (dataType === 'numeric') {
    const p = row['numeric_precision'];
    const s = row['numeric_scale'];
    if (p) return `numeric(${asStr(p)}${s ? `,${asStr(s)}` : ''})`;
    return 'numeric';
  }
  if (dataType === 'timestamp with time zone') return 'timestamptz';
  if (dataType === 'timestamp without time zone') return 'timestamp';
  if (dataType === 'time with time zone') return 'timetz';
  return dataType || udt || 'unknown';
}

/** SQL queries used for live introspection (parameterised only by schema name). */
function liveQueries(schema: string): Record<'columns' | 'constraints' | 'indexes' | 'policies' | 'rls', string> {
  const s = schema.replace(/'/g, "''");
  return {
    columns: `select table_name, column_name, ordinal_position, data_type, udt_name,
        is_nullable, column_default, character_maximum_length, numeric_precision, numeric_scale
      from information_schema.columns
      where table_schema = '${s}'
      order by table_name, ordinal_position;`,
    constraints: `select tc.constraint_name, tc.table_name, tc.constraint_type,
        kcu.column_name, kcu.ordinal_position,
        ccu.table_name as referenced_table, ccu.column_name as referenced_column,
        rc.delete_rule, rc.update_rule
      from information_schema.table_constraints tc
      left join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name
       and kcu.constraint_schema = tc.constraint_schema
      left join information_schema.referential_constraints rc
        on rc.constraint_name = tc.constraint_name
       and rc.constraint_schema = tc.constraint_schema
      left join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = rc.unique_constraint_name
       and ccu.constraint_schema = rc.unique_constraint_schema
      where tc.table_schema = '${s}'
        and tc.constraint_type in ('PRIMARY KEY','FOREIGN KEY','UNIQUE')
      order by tc.table_name, tc.constraint_name, kcu.ordinal_position;`,
    indexes: `select tablename, indexname, indexdef
      from pg_indexes where schemaname = '${s}'
      order by tablename, indexname;`,
    policies: `select tablename, policyname, permissive, roles, cmd, qual, with_check
      from pg_policies where schemaname = '${s}'
      order by tablename, policyname;`,
    rls: `select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = '${s}' and c.relkind = 'r' and c.relrowsecurity;`,
  };
}

/** Run one introspection query, returning rows or `[]` (logging a warning on failure). */
async function runLive(
  sql: SqlExecutor,
  query: string,
  label: string,
  warnings: string[]
): Promise<Array<Record<string, unknown>>> {
  try {
    const rows = await sql(query);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warnings.push(`Live introspection (${label}) failed: ${detail}`);
    return [];
  }
}

/** Extract schema from a live database via the supplied executor. */
async function extractFromLive(
  sql: SqlExecutor,
  schema: string,
  warnings: string[]
): Promise<SchemaSnapshot> {
  const queries = liveQueries(schema);
  const [columnRows, constraintRows, indexRows, policyRows, rlsRows] = await Promise.all([
    runLive(sql, queries.columns, 'columns', warnings),
    runLive(sql, queries.constraints, 'constraints', warnings),
    runLive(sql, queries.indexes, 'indexes', warnings),
    runLive(sql, queries.policies, 'policies', warnings),
    runLive(sql, queries.rls, 'rls', warnings),
  ]);

  const tables = new Map<string, TableBuilder>();
  const ensure = (tableName: string): TableBuilder => {
    const key = tableKey(schema, tableName);
    let t = tables.get(key);
    if (!t) {
      t = newTable(tableName, schema);
      tables.set(key, t);
    }
    return t;
  };

  // Columns
  for (const row of columnRows) {
    const tableName = asStr(row['table_name']);
    const colName = asStr(row['column_name']);
    if (tableName === '' || colName === '') continue;
    const def = asStr(row['column_default']);
    const nullable = asStr(row['is_nullable']).toUpperCase() !== 'NO';
    const constraints: string[] = [];
    if (!nullable) constraints.push('not null');
    if (def !== '') constraints.push(`default ${def}`);
    ensure(tableName).columns.push({
      name: colName,
      type: formatLiveType(row),
      nullable,
      default: def === '' ? null : def,
      constraints,
    });
  }

  // Constraints (PK / FK / UNIQUE). Group multi-column constraints by name.
  interface ConstraintAgg {
    type: string;
    table: string;
    columns: string[];
    refTable: string;
    refColumns: string[];
    onDelete: string | null;
    onUpdate: string | null;
  }
  const byConstraint = new Map<string, ConstraintAgg>();
  for (const row of constraintRows) {
    const cname = asStr(row['constraint_name']);
    const ctype = asStr(row['constraint_type']).toUpperCase();
    const tableName = asStr(row['table_name']);
    if (cname === '' || tableName === '') continue;
    const key = `${tableName}.${cname}`;
    let agg = byConstraint.get(key);
    if (!agg) {
      agg = { type: ctype, table: tableName, columns: [], refTable: '', refColumns: [], onDelete: null, onUpdate: null };
      byConstraint.set(key, agg);
    }
    const col = asStr(row['column_name']);
    if (col !== '' && !agg.columns.includes(col)) agg.columns.push(col);
    const refTable = asStr(row['referenced_table']);
    if (refTable !== '') agg.refTable = refTable;
    const refCol = asStr(row['referenced_column']);
    if (refCol !== '' && !agg.refColumns.includes(refCol)) agg.refColumns.push(refCol);
    const del = asStr(row['delete_rule']);
    if (del !== '') agg.onDelete = del.toLowerCase();
    const upd = asStr(row['update_rule']);
    if (upd !== '') agg.onUpdate = upd.toLowerCase();
  }
  for (const [key, agg] of byConstraint) {
    const cname = key.slice(agg.table.length + 1);
    const table = ensure(agg.table);
    if (agg.type === 'PRIMARY KEY') {
      for (const c of agg.columns) if (!table.primaryKey.includes(c)) table.primaryKey.push(c);
    } else if (agg.type === 'FOREIGN KEY' && agg.refTable !== '') {
      table.foreignKeys.push({
        name: cname,
        columns: agg.columns,
        referencesTable: agg.refTable,
        referencesColumns: agg.refColumns,
        onDelete: agg.onDelete,
        onUpdate: agg.onUpdate,
      });
    }
  }

  // RLS enabled flag
  for (const row of rlsRows) {
    const tableName = asStr(row['relname']);
    if (tableName !== '') ensure(tableName).rlsEnabled = true;
  }

  // Indexes — parse the canonical indexdef when present, else use the columns we have.
  const indexes: IndexSchema[] = [];
  for (const row of indexRows) {
    const def = asStr(row['indexdef']);
    const parsed = def !== '' ? parseCreateIndex(def.replace(/;?\s*$/, '')) : null;
    if (parsed) {
      indexes.push(parsed);
    } else {
      const name = asStr(row['indexname']);
      const table = asStr(row['tablename']);
      if (name !== '' && table !== '') {
        indexes.push({ name, table, columns: [], unique: false, method: null, predicate: null });
      }
    }
  }

  // Policies
  const policies: RlsPolicy[] = [];
  for (const row of policyRows) {
    const name = asStr(row['policyname']);
    const table = asStr(row['tablename']);
    if (name === '' || table === '') continue;
    const permissiveRaw = asStr(row['permissive']).toLowerCase();
    const qual = asStr(row['qual']);
    const withCheck = asStr(row['with_check']);
    policies.push({
      name,
      table,
      command: asStr(row['cmd']).toUpperCase() || 'ALL',
      roles: parsePgArray(row['roles']),
      permissive: permissiveRaw === '' ? true : permissiveRaw === 'permissive' || permissiveRaw === 'true' || permissiveRaw === 't',
      using: qual === '' ? null : qual,
      withCheck: withCheck === '' ? null : withCheck,
    });
  }

  const acc: ParsedSql = { tables, indexes, policies };
  return assembleSnapshot(acc, 'live', [], warnings);
}

// ---------------------------------------------------------------------------
// Snapshot assembly + merge
// ---------------------------------------------------------------------------

/** Turn an accumulator into a finalized {@link SchemaSnapshot} (with derived relationships). */
function assembleSnapshot(
  acc: ParsedSql,
  source: SchemaSource,
  migrationFiles: string[],
  warnings: string[]
): SchemaSnapshot {
  const tables = [...acc.tables.values()]
    .map(finalizeTable)
    .sort((a, b) => a.name.localeCompare(b.name));

  const relationships = deriveRelationships(tables);
  const indexes = [...acc.indexes].sort(
    (a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name)
  );
  const rlsPolicies = [...acc.policies].sort(
    (a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name)
  );

  return { tables, relationships, indexes, rlsPolicies, source, migrationFiles, warnings };
}

/** Flatten every table's foreign keys into the relationships list. */
function deriveRelationships(tables: readonly TableSchema[]): Relationship[] {
  const relationships: Relationship[] = [];
  for (const table of tables) {
    for (const fk of table.foreignKeys) {
      relationships.push({
        constraintName: fk.name,
        fromTable: table.name,
        fromColumns: fk.columns,
        toTable: fk.referencesTable,
        toColumns: fk.referencesColumns,
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      });
    }
  }
  return relationships.sort(
    (a, b) => a.fromTable.localeCompare(b.fromTable) || a.toTable.localeCompare(b.toTable)
  );
}

/**
 * Merge a migration-derived snapshot with a live snapshot. The live schema is
 * ground truth: live tables replace migration tables of the same name, and live
 * indexes/policies replace migration ones sharing the same (table, name). Anything
 * only the migrations knew about is preserved.
 */
function mergeSnapshots(migrations: SchemaSnapshot, live: SchemaSnapshot): SchemaSnapshot {
  const tableByName = new Map<string, TableSchema>();
  for (const t of migrations.tables) tableByName.set(t.name, t);
  for (const t of live.tables) tableByName.set(t.name, t); // live wins

  const tables = [...tableByName.values()].sort((a, b) => a.name.localeCompare(b.name));

  const indexByKey = new Map<string, IndexSchema>();
  for (const i of migrations.indexes) indexByKey.set(`${i.table}.${i.name}`, i);
  for (const i of live.indexes) indexByKey.set(`${i.table}.${i.name}`, i);
  const indexes = [...indexByKey.values()].sort(
    (a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name)
  );

  const policyByKey = new Map<string, RlsPolicy>();
  for (const p of migrations.rlsPolicies) policyByKey.set(`${p.table}.${p.name}`, p);
  for (const p of live.rlsPolicies) policyByKey.set(`${p.table}.${p.name}`, p);
  const rlsPolicies = [...policyByKey.values()].sort(
    (a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name)
  );

  return {
    tables,
    relationships: deriveRelationships(tables),
    indexes,
    rlsPolicies,
    source: 'merged',
    migrationFiles: migrations.migrationFiles,
    warnings: [...migrations.warnings, ...live.warnings],
  };
}

/** An empty snapshot for the no-source / total-failure case. */
function emptySnapshot(warnings: string[]): SchemaSnapshot {
  return {
    tables: [],
    relationships: [],
    indexes: [],
    rlsPolicies: [],
    source: 'none',
    migrationFiles: [],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Extract the current database schema from migration SQL files and/or a live
 * database connection into a {@link SchemaSnapshot}.
 *
 * Accepts either a project-path string (shorthand for `{ projectPath }`) or a full
 * options object. Always resolves (never rejects): a project with no SQL and no
 * reachable database yields an empty snapshot plus warnings.
 */
export async function extractSchema(
  input: string | SchemaExtractorOptions = {}
): Promise<SchemaSnapshot> {
  const options: SchemaExtractorOptions = typeof input === 'string' ? { projectPath: input } : input;
  const warnings: string[] = [];
  const schema = options.schema ?? 'public';

  // Resolve a live executor (explicit `sql` wins over a Supabase client).
  let executor: SqlExecutor | null = options.sql ?? null;
  if (!executor && options.supabase) {
    const rpcOpts: { rpc?: string; param?: string } = {};
    if (options.supabaseRpc) rpcOpts.rpc = options.supabaseRpc;
    if (options.supabaseRpcParam) rpcOpts.param = options.supabaseRpcParam;
    executor = createSupabaseExecutor(options.supabase, rpcOpts);
  }

  // Source 1: migration files.
  let migrationsSnapshot: SchemaSnapshot | null = null;
  if (options.projectPath) {
    const dirs = options.migrationDirs ?? DEFAULT_MIGRATION_DIRS;
    const { snapshot, fileCount } = await extractFromMigrations(options.projectPath, dirs, warnings);
    if (fileCount > 0) migrationsSnapshot = snapshot;
    else warnings.push(`No migration .sql files found under ${options.projectPath}`);
  }

  // Source 2: live database.
  let liveSnapshot: SchemaSnapshot | null = null;
  if (executor) {
    liveSnapshot = await extractFromLive(executor, schema, warnings);
  }

  // Combine.
  if (migrationsSnapshot && liveSnapshot) {
    return mergeSnapshots(migrationsSnapshot, liveSnapshot);
  }
  if (liveSnapshot) {
    liveSnapshot.warnings = warnings;
    return liveSnapshot;
  }
  if (migrationsSnapshot) {
    migrationsSnapshot.warnings = warnings;
    return migrationsSnapshot;
  }

  if (!options.projectPath && !executor) {
    warnings.push('No projectPath and no live connection supplied — nothing to extract.');
  }
  return emptySnapshot(warnings);
}

export default extractSchema;
