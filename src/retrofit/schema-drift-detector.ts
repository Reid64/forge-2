// FORGE 2.0 — RETROFIT: Schema Drift Detector
//
// Regex-based (not AST-based) comparison of a target project's `supabase/migrations/*.sql` files
// (parsed chronologically into a resolved schema map) against its TypeScript interfaces/types that
// map to DB tables by naming convention. Flags tables with no corresponding TS type, TS types with
// no corresponding migration table, column-level mismatches, and obvious SQL/TS type mismatches.
// Read-only against the target project — the only write this module performs is the best-effort
// Build Memory persistence step (`schema_drift_findings`), which never throws (Contract 4 — a
// Build Memory failure degrades to stateless mode, it does not halt the caller).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getClient, logMemoryWarning, newId, nowIso } from '../memory/client.js';

export interface SchemaDriftFinding {
  findingType: 'table_missing_type' | 'type_missing_table' | 'column_mismatch' | 'type_mismatch';
  tableName: string;
  detail: string;
  severity: 'critical' | 'major' | 'minor';
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.forge', '.claude', '.vercel']);
const SOURCE_FILE_RE = /\.(ts|tsx)$/;
const TEST_OR_STORY_RE = /\.(test|spec)\.tsx?$|\.stories\.tsx$/;

/** Lists `supabase/migrations/*.sql` in chronological (lexicographic — timestamp-prefixed) order. */
function listMigrationFiles(projectPath: string): string[] {
  const migrationsDir = join(projectPath, 'supabase', 'migrations');
  let entries: string[];
  try {
    entries = readdirSync(migrationsDir);
  } catch {
    return []; // no migrations directory — not a failure, just nothing to compare against
  }

  return entries
    .filter((entry) => entry.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => join(migrationsDir, entry));
}

/** Recursively collects every `src/**\/*.ts(x)` file, fs.readdirSync-based. */
function walkSourceFiles(projectPath: string): string[] {
  const acc: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable directory — skip, never throw
    }

    for (const entry of entries) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);

      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue; // unreadable entry — skip
      }

      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!SOURCE_FILE_RE.test(entry)) continue;
      if (entry.endsWith('.d.ts')) continue;
      if (TEST_OR_STORY_RE.test(entry)) continue;
      acc.push(fullPath);
    }
  }

  walk(join(projectPath, 'src'));
  return acc;
}

// ---------------------------------------------------------------------------
// Step 1 — parse migrations into a resolved schema map
// ---------------------------------------------------------------------------

export type ResolvedSchema = Map<string, Map<string, string>>;

/** Strips SQL line (`--`) and block (`/* ... *​/`) comments so they never confuse the parsers below. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');
}

function unquoteIdentifier(raw: string): string {
  return raw.trim().replace(/^["'`]|["'`]$/g, '');
}

const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([\w.]+)["'`]?\s*\(([\s\S]*?)\)\s*;/gi;
const ALTER_ADD_COLUMN_RE = /ALTER\s+TABLE\s+(?:ONLY\s+)?["'`]?([\w.]+)["'`]?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s+([\w()[\]\s]+?)(?:\s+(?:NOT\s+NULL|NULL|DEFAULT|REFERENCES|UNIQUE|PRIMARY|CHECK|CONSTRAINT|COLLATE|GENERATED)[\s\S]*?)?,?\s*;/gi;
const DROP_TABLE_RE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?([\w.]+)["'`]?/gi;

const SQL_CONSTRAINT_KEYWORDS = new Set([
  'primary',
  'foreign',
  'unique',
  'check',
  'constraint',
  'exclude',
  'like',
]);

/** Strips a schema-qualified table name (e.g. `public.users`) down to its bare table name. */
function bareTableName(qualified: string): string {
  const parts = qualified.split('.');
  return unquoteIdentifier(parts[parts.length - 1] ?? qualified);
}

/**
 * Splits a `CREATE TABLE (...)` column-list body on top-level commas only (parens from type
 * modifiers like `numeric(10,4)` and nested constraint expressions are respected).
 */
function splitColumnDefs(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current);

  return parts;
}

/** Parses one column-definition fragment into `{ name, sqlType }`, or null for a table-level constraint. */
function parseColumnDef(fragment: string): { name: string; sqlType: string } | null {
  const trimmed = fragment.trim();
  if (trimmed.length === 0) return null;

  const firstWord = (trimmed.split(/\s+/)[0] ?? '').toLowerCase().replace(/^["'`]|["'`]$/g, '');
  if (SQL_CONSTRAINT_KEYWORDS.has(firstWord)) return null;

  const match = /^["'`]?([\w]+)["'`]?\s+([\w()[\]\s]+?)(?:\s+(?:NOT\s+NULL|NULL|DEFAULT|REFERENCES|UNIQUE|PRIMARY|CHECK|CONSTRAINT|COLLATE|GENERATED)[\s\S]*)?$/i.exec(
    trimmed
  );
  if (!match) return null;
  const rawName = match[1];
  const rawType = match[2];
  if (!rawName || !rawType) return null;

  const name = unquoteIdentifier(rawName);
  const sqlType = rawType.trim().replace(/\s+/g, ' ');
  return { name, sqlType };
}

/**
 * Parses every migration file (in chronological order) and builds the final resolved schema:
 * `CREATE TABLE` seeds a table's columns, `ALTER TABLE ADD COLUMN` appends to it, and `DROP TABLE`
 * removes it entirely — later migrations always win, matching how Supabase actually applies them.
 */
export function buildResolvedSchema(migrationFiles: string[]): ResolvedSchema {
  const schema: ResolvedSchema = new Map();

  for (const filePath of migrationFiles) {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      continue; // unreadable migration — skip, never throw
    }
    const sql = stripSqlComments(raw);

    CREATE_TABLE_RE.lastIndex = 0;
    let createMatch: RegExpExecArray | null;
    while ((createMatch = CREATE_TABLE_RE.exec(sql))) {
      const tableName = bareTableName(createMatch[1] ?? '');
      const body = createMatch[2] ?? '';
      if (!tableName) continue;

      const columns = new Map<string, string>();
      for (const fragment of splitColumnDefs(body)) {
        const parsed = parseColumnDef(fragment);
        if (parsed) columns.set(parsed.name, parsed.sqlType);
      }
      schema.set(tableName, columns);
    }

    ALTER_ADD_COLUMN_RE.lastIndex = 0;
    let alterMatch: RegExpExecArray | null;
    while ((alterMatch = ALTER_ADD_COLUMN_RE.exec(sql))) {
      const tableName = bareTableName(alterMatch[1] ?? '');
      const columnName = alterMatch[2] ? unquoteIdentifier(alterMatch[2]) : '';
      const sqlType = alterMatch[3]?.trim().replace(/\s+/g, ' ');
      if (!tableName || !columnName || !sqlType) continue;

      const existing = schema.get(tableName) ?? new Map<string, string>();
      existing.set(columnName, sqlType);
      schema.set(tableName, existing);
    }

    DROP_TABLE_RE.lastIndex = 0;
    let dropMatch: RegExpExecArray | null;
    while ((dropMatch = DROP_TABLE_RE.exec(sql))) {
      const tableName = bareTableName(dropMatch[1] ?? '');
      if (tableName) schema.delete(tableName);
    }
  }

  return schema;
}

// ---------------------------------------------------------------------------
// Step 2 — parse TypeScript interfaces/types that map to DB tables
// ---------------------------------------------------------------------------

export type TsTypeMap = Map<string, Map<string, string>>;

const INTERFACE_HEADER_RE = /^export\s+interface\s+(\w+)\s*(?:extends\s+[\w<>,.\s]+)?\{/;
const TYPE_ALIAS_HEADER_RE = /^export\s+type\s+(\w+)\s*=\s*\{/;
// `type UserRow = Database['public']['Tables']['users']['Row'];` — a re-export alias, not a shape
// to scan property-by-property; captures the table name directly instead.
const DATABASE_TABLE_ALIAS_RE = /^export\s+type\s+(\w+)\s*=\s*Database\[['"]public['"]\]\[['"]Tables['"]\]\[['"](\w+)['"]\]\[['"](?:Row|Insert|Update)['"]\]\s*;?$/;

const ROW_SUFFIX_RE = /(Row|Table|Record|Entity)$/;

/**
 * Maps a type/interface name to a probable table name by naming convention: `User` -> `users`,
 * `UserRow` -> `users`, `CompanyRecord` -> `companies` (simple English pluralization: a trailing
 * `y` preceded by a consonant becomes `ies`, everything else just gets an `s`).
 */
function inferTableName(typeName: string): string {
  const base = typeName.replace(ROW_SUFFIX_RE, '');
  const lower = base.charAt(0).toLowerCase() + base.slice(1);

  if (/[^aeiou]y$/i.test(lower)) return lower.slice(0, -1) + 'ies';
  if (/s$/i.test(lower)) return lower; // already looks plural (e.g. `Settings` -> settings)
  return lower + 's';
}

/** Splits an interface/type body into top-level property fragments (nested `{}`/`<>` respected). */
function splitPropertyDefs(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of body) {
    if (ch === '{' || ch === '<' || ch === '(' || ch === '[') depth++;
    if (ch === '}' || ch === '>' || ch === ')' || ch === ']') depth--;
    if ((ch === ';' || ch === ',') && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current);

  return parts;
}

function parsePropertyDef(fragment: string): { name: string; tsType: string } | null {
  const trimmed = fragment.trim();
  if (trimmed.length === 0) return null;

  const match = /^(?:readonly\s+)?["'`]?([\w$]+)["'`]?\??\s*:\s*([\s\S]+)$/.exec(trimmed);
  if (!match) return null;
  const rawName = match[1];
  const rawType = match[2];
  if (!rawName || !rawType) return null;

  return { name: rawName, tsType: rawType.trim().replace(/\s+/g, ' ').replace(/;$/, '') };
}

/** Extracts the balanced `{ ... }` body starting at `openBraceIndex` (the opening brace itself). */
function extractBraceBody(content: string, openBraceIndex: number): string | null {
  let depth = 0;
  for (let i = openBraceIndex; i < content.length; i++) {
    if (content[i] === '{') depth++;
    if (content[i] === '}') {
      depth--;
      if (depth === 0) return content.slice(openBraceIndex + 1, i);
    }
  }
  return null; // unbalanced — malformed file, skip
}

/**
 * Scans one file's content for `export interface Name {...}`, `export type Name = {...}`, and the
 * `Database['public']['Tables']['x']['Row']` alias form. Populates `tsTypes` keyed by inferred (or
 * explicit, for the Database-alias form) table name.
 */
function extractTsTypes(content: string, tsTypes: TsTypeMap): void {
  const lines = content.split(/\r?\n/);
  let cursor = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const lineStart = cursor;
    cursor += line.length + 1;

    const dbAliasMatch = DATABASE_TABLE_ALIAS_RE.exec(trimmed);
    if (dbAliasMatch) {
      const aliasTableName = dbAliasMatch[2];
      if (aliasTableName) {
        if (!tsTypes.has(aliasTableName)) tsTypes.set(aliasTableName, new Map());
        continue;
      }
    }

    const interfaceMatch = INTERFACE_HEADER_RE.exec(trimmed);
    const typeAliasMatch = TYPE_ALIAS_HEADER_RE.exec(trimmed);
    const name = interfaceMatch?.[1] ?? typeAliasMatch?.[1];
    if (!name) continue;

    const braceOffsetInLine = line.indexOf('{');
    if (braceOffsetInLine === -1) continue;
    const body = extractBraceBody(content, lineStart + braceOffsetInLine);
    if (body === null) continue;

    const tableName = inferTableName(name);
    const properties = tsTypes.get(tableName) ?? new Map<string, string>();
    for (const fragment of splitPropertyDefs(body)) {
      const parsed = parsePropertyDef(fragment);
      if (parsed) properties.set(parsed.name, parsed.tsType);
    }
    tsTypes.set(tableName, properties);
  }
}

/** Scans every source file for TS types mapping to DB tables by naming convention. */
export function buildTsTypeMap(projectPath: string): TsTypeMap {
  const tsTypes: TsTypeMap = new Map();
  const files = walkSourceFiles(projectPath);

  for (const absPath of files) {
    let content: string;
    try {
      content = readFileSync(absPath, 'utf8');
    } catch {
      continue; // unreadable file — skip, never throw
    }
    extractTsTypes(content, tsTypes);
  }

  return tsTypes;
}

// ---------------------------------------------------------------------------
// Step 3 — compare schema map against TS type map
// ---------------------------------------------------------------------------

/** Normalizes a SQL type string to a coarse category for the type-mismatch heuristic below. */
function sqlTypeCategory(sqlType: string): 'string' | 'number' | 'boolean' | 'json' | 'date' | 'other' {
  const t = sqlType.toLowerCase();
  if (/^(text|varchar|character varying|char|uuid|citext)/.test(t)) return 'string';
  if (/^(int|integer|bigint|smallint|numeric|decimal|real|double precision|float|serial|bigserial)/.test(t)) return 'number';
  if (/^bool/.test(t)) return 'boolean';
  if (/^(json|jsonb)/.test(t)) return 'json';
  if (/^(timestamp|date|time)/.test(t)) return 'date';
  return 'other';
}

/** Normalizes a TS type string to the same coarse category, for direct comparison against SQL. */
function tsTypeCategory(tsType: string): 'string' | 'number' | 'boolean' | 'json' | 'date' | 'other' {
  const t = tsType.toLowerCase().replace(/\s*\|\s*(null|undefined)/g, '').trim();
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'date') return 'date';
  if (t.startsWith('{') || t.includes('record<') || t.startsWith('[') || t.endsWith('[]') || t.includes('json')) return 'json';
  return 'other';
}

/** True when a SQL/TS category pairing is an obvious, confident mismatch worth flagging. */
function isObviousTypeMismatch(sqlCategory: string, tsCat: string): boolean {
  if (sqlCategory === 'other' || tsCat === 'other') return false; // not confident enough to flag
  return sqlCategory !== tsCat;
}

function compareSchemas(sqlSchema: ResolvedSchema, tsTypes: TsTypeMap): SchemaDriftFinding[] {
  const findings: SchemaDriftFinding[] = [];

  for (const [tableName, columns] of sqlSchema) {
    const tsColumns = tsTypes.get(tableName);

    if (!tsColumns) {
      findings.push({
        findingType: 'table_missing_type',
        tableName,
        detail: `migration table "${tableName}" has no corresponding TypeScript interface/type (expected a name like the singular/plural form of "${tableName}")`,
        severity: 'major',
      });
      continue;
    }

    for (const [columnName, sqlType] of columns) {
      const tsType = tsColumns.get(columnName);

      if (tsType === undefined) {
        findings.push({
          findingType: 'column_mismatch',
          tableName,
          detail: `column "${columnName}" (${sqlType}) exists in the migration schema for "${tableName}" but has no matching property in its TypeScript type`,
          severity: 'minor',
        });
        continue;
      }

      const sqlCategory = sqlTypeCategory(sqlType);
      const tsCat = tsTypeCategory(tsType);
      if (isObviousTypeMismatch(sqlCategory, tsCat)) {
        findings.push({
          findingType: 'type_mismatch',
          tableName,
          detail: `column "${columnName}" on "${tableName}" is SQL type "${sqlType}" (${sqlCategory}) but the TypeScript property is typed "${tsType}" (${tsCat})`,
          severity: 'major',
        });
      }
    }
  }

  for (const tableName of tsTypes.keys()) {
    if (sqlSchema.has(tableName)) continue;
    findings.push({
      findingType: 'type_missing_table',
      tableName,
      detail: `a TypeScript interface/type maps to table "${tableName}" by naming convention, but no migration creates that table`,
      severity: 'major',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Build Memory persistence (Contract 4 — best-effort, never throws)
// ---------------------------------------------------------------------------

function persistFindings(runId: string, projectPath: string, findings: SchemaDriftFinding[]): void {
  if (findings.length === 0) return;

  const db = getClient();
  if (!db) return; // Build Memory unavailable — degrade to stateless mode

  try {
    const insert = db.prepare(
      `INSERT INTO schema_drift_findings
         (id, build_run_id, project_path, finding_type, table_name, detail, severity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAll = db.transaction((rows: SchemaDriftFinding[]) => {
      for (const row of rows) {
        insert.run(newId(), runId, projectPath, row.findingType, row.tableName, row.detail, row.severity, nowIso());
      }
    });
    insertAll(findings);
  } catch (error) {
    logMemoryWarning('schema-drift-detector:persist', error);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<SchemaDriftFinding['severity'], number> = { critical: 0, major: 1, minor: 2 };

export class SchemaDriftDetector {
  /**
   * Parses every `supabase/migrations/*.sql` file (chronological order) into a resolved schema
   * map, scans `src/**\/*.ts(x)` for TypeScript interfaces/types that map to DB tables by naming
   * convention (`User`, `UserRow`, `Database['public']['Tables']['users']['Row']`), and compares
   * the two: tables with no TS type, TS types with no migration table, columns present in one but
   * not the other, and obvious SQL/TS type-category mismatches. Read-only against the project.
   * Findings are persisted to `schema_drift_findings` (best-effort) and returned sorted by
   * severity (critical first) then table name.
   *
   * Short-circuits to `[]` when the project has zero `supabase/migrations/*.sql` files — a
   * project that hasn't reached its schema-authoring stage yet has no DB layer to drift from,
   * so every exported TS interface/type would otherwise be flagged `type_missing_table` (a
   * false flood, not a real finding). A migrations directory that exists but happens to define
   * zero tables is a different, still-meaningful case and is NOT short-circuited here.
   */
  async detect(projectPath: string): Promise<SchemaDriftFinding[]> {
    const runId = newId();

    const migrationFiles = listMigrationFiles(projectPath);
    if (migrationFiles.length === 0) return [];

    const sqlSchema = buildResolvedSchema(migrationFiles);
    const tsTypes = buildTsTypeMap(projectPath);

    const findings = compareSchemas(sqlSchema, tsTypes);
    findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.tableName.localeCompare(b.tableName));

    persistFindings(runId, projectPath, findings);

    return findings;
  }
}

export function createSchemaDriftDetector(): SchemaDriftDetector {
  return new SchemaDriftDetector();
}
