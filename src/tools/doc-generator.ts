/**
 * FORGE 2.0 — Documentation Generator (Phase 5 / F16, queue.yaml s8-p03).
 *
 * After a build completes, auto-generate the four standard project documents from
 * the governance documents PLUS the actual codebase state, and write them to the
 * TARGET project's `docs/` directory:
 *
 *   1. README.md  — project name, description, tech stack, setup instructions,
 *                   environment variables, build commands, deployment steps.
 *   2. API.md     — every endpoint with method, path, auth requirements, a request
 *                   body example, a response example, and the error codes it returns.
 *   3. SCHEMA.md  — every table with columns, types, relationships, and its RLS
 *                   policies described in plain language.
 *   4. DEPLOY.md  — a step-by-step deployment guide, including `deploy.ps1` usage.
 *
 * SOURCES (both, merged — neither alone is authoritative):
 *   - GOVERNANCE DOCS (BLUEPRINT.md / PRD.md / SCHEMA_REGISTRY.md /
 *     BEHAVIORAL_CONTRACTS.md, read from the project root or its `governance/` dir):
 *     the project name, the human description, the tech-stack narrative, the declared
 *     environment variables, and the API routes spelled out in BEHAVIORAL_CONTRACTS.
 *   - ACTUAL CODEBASE STATE (via the sibling Phase-0/1 tools): `detectStack` →
 *     framework/database/deploy/package-manager; `readCodebase` → the real Next.js
 *     route files (→ endpoints) + `package.json` scripts/deps; `extractSchema` → the
 *     real tables/columns/relationships/indexes/RLS policies from migrations and/or a
 *     live database connection. The codebase is GROUND TRUTH where the two disagree.
 *
 * Like the sibling tools (codebase-reader, schema-extractor, stack-detector,
 * env-auditor, project-autopsy) this generator is best-effort and NON-FATAL: every
 * file read is guarded, every collaborator is injectable, missing inputs degrade to a
 * documented "not detected" note rather than a crash, and a partial document is a
 * valid result. `generateDocs` never throws — the worst case is a thin set of docs
 * plus warnings. Writing is opt-out (`write:false` returns the rendered content
 * without touching disk) and only ever writes inside the target's `docs/` directory.
 *
 * The request/response EXAMPLES in API.md are derived from the real schema (a route's
 * matching table's insertable columns), not invented — and are clearly labelled
 * illustrative where the shape cannot be determined. SECURITY: only structure and
 * declared env-var NAMES are read; no `.env*` secret VALUES are ever emitted into the
 * generated docs, and the live DB connection (if any) is supplied by the caller.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  readCodebase,
  type CodebaseSnapshot,
  type CodebaseReaderOptions,
  type RouteInfo,
} from './codebase-reader.js';
import {
  extractSchema,
  type SchemaSnapshot,
  type SchemaExtractorOptions,
  type SqlExecutor,
  type TableSchema,
  type ColumnSchema,
  type RlsPolicy,
} from './schema-extractor.js';
import { detectStack, type StackFingerprint } from './stack-detector.js';
import { logLine } from './forge-logger.js';
import { nowIso } from '../memory/index.js';

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

/** The canonical file names this generator produces (in `docs/`). */
export type GeneratedDocName = 'README.md' | 'API.md' | 'SCHEMA.md' | 'DEPLOY.md';

/** One generated document. */
export interface GeneratedDoc {
  /** File name within the output directory (e.g. `README.md`). */
  name: GeneratedDocName;
  /** Project-relative POSIX path it was (or would be) written to (e.g. `docs/README.md`). */
  path: string;
  /** Full Markdown content. */
  content: string;
  /** Byte length of {@link content} (UTF-8). */
  bytes: number;
  /** Whether the file was actually written to disk. */
  written: boolean;
}

/** The complete result of {@link generateDocs}. */
export interface DocGenerationResult {
  /** Resolved project name used across the docs. */
  projectName: string;
  /** The four generated documents, in canonical order. */
  documents: GeneratedDoc[];
  /** Directory (project-relative POSIX) the docs were written to. */
  outputDir: string;
  /** Detected tech-stack fingerprint that informed the docs. */
  stack: StackFingerprint;
  /** ISO 8601 timestamp the docs were generated. */
  generatedAt: string;
  /** Which governance docs were found and read (project-relative-ish names). */
  governanceSources: string[];
  /** Non-fatal observations (unreadable file, no schema, write failure, …). */
  warnings: string[];
}

/** A function that loads a sibling tool's snapshot — injectable for testing. */
export interface DocGeneratorCollaborators {
  /** Defaults to {@link readCodebase}. */
  readCodebaseImpl?: (path: string, options?: CodebaseReaderOptions) => Promise<CodebaseSnapshot>;
  /** Defaults to {@link extractSchema}. */
  extractSchemaImpl?: (input: SchemaExtractorOptions) => Promise<SchemaSnapshot>;
  /** Defaults to {@link detectStack}. */
  detectStackImpl?: (path: string) => Promise<StackFingerprint>;
}

/** Options for {@link generateDocs}. */
export interface DocGeneratorOptions extends DocGeneratorCollaborators {
  /** Output directory relative to the project root. Default `'docs'`. */
  outputDir?: string;
  /** Override the auto-detected project name. */
  projectName?: string;
  /** Write the files to disk. Default `true`; `false` returns content only. */
  write?: boolean;
  /** Live introspection executor passed through to {@link extractSchema}. */
  sql?: SqlExecutor;
  /** Convenience Supabase client passed through to {@link extractSchema}. */
  supabase?: SupabaseClient;
  /** Progress logger. Defaults to FORGE's structured logger (`forge-logger`, tagged `docs`). */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Governance documents read for narrative/declared content (root + governance/). */
const GOVERNANCE_DOC_NAMES = [
  'BLUEPRINT.md',
  'PRD.md',
  'SCHEMA_REGISTRY.md',
  'BEHAVIORAL_CONTRACTS.md',
] as const;

/** Directories searched for a governance document, in priority order. */
const GOVERNANCE_DIRS = ['', 'governance'] as const;

/** HTTP method handler names recognised in a Next.js App-Router `route` file. */
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** Methods that carry a request body (→ a body example is emitted). */
const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

/** Column names that are server-derived and excluded from request-body examples. */
const SERVER_DERIVED_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'company_id',
  'user_id',
  'created_at',
  'updated_at',
  'inserted_at',
  'deleted_at',
]);

// ---------------------------------------------------------------------------
// Guarded IO helpers (never throw)
// ---------------------------------------------------------------------------

/** Read a UTF-8 text file, returning `null` if it cannot be read. */
async function readTextSafe(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** Collapse runs of whitespace to single spaces and trim. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Governance document loading + narrative extraction
// ---------------------------------------------------------------------------

/** The governance documents that were located, by canonical name → content. */
interface GovernanceContent {
  docs: Map<string, string>;
  sources: string[];
}

/** Locate and read the narrative governance docs from root or `governance/`. */
async function loadGovernance(projectPath: string): Promise<GovernanceContent> {
  const docs = new Map<string, string>();
  const sources: string[] = [];
  for (const name of GOVERNANCE_DOC_NAMES) {
    for (const dir of GOVERNANCE_DIRS) {
      const rel = dir === '' ? name : `${dir}/${name}`;
      const text = await readTextSafe(join(projectPath, dir, name));
      if (text !== null) {
        docs.set(name, text);
        sources.push(rel);
        break; // first hit wins (root before governance/)
      }
    }
  }
  return { docs, sources };
}

/** Pull the value of a `- **Label:** value` / `**Label:** value` line from Markdown. */
function boldFieldValue(markdown: string, label: string): string | null {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i');
  const m = re.exec(markdown);
  if (!m || m[1] === undefined) return null;
  // Drop a trailing parenthetical acronym expansion and surrounding backticks.
  return collapse(m[1].replace(/\s*\([^)]*\)\s*$/, '').replace(/[`*]/g, '')) || null;
}

/** First level-1 Markdown heading (`# Title`), trimmed of trailing em-dash clauses. */
function firstHeading(markdown: string): string | null {
  const m = /^#\s+(.+)$/m.exec(markdown);
  if (!m || m[1] === undefined) return null;
  return collapse(m[1].split(/[—–-]{1,2}/)[0] ?? m[1]);
}

/** First non-empty paragraph under a `## Section` heading (best-effort). */
function sectionParagraph(markdown: string, heading: string): string | null {
  const re = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?:^##\\s|$)`, 'im');
  const m = re.exec(markdown);
  if (!m || m[1] === undefined) return null;
  for (const para of m[1].split(/\n\s*\n/)) {
    const text = collapse(para);
    if (text !== '' && !text.startsWith('#')) return text;
  }
  return null;
}

/** Resolve the project name from options → governance → package.json → path. */
function resolveProjectName(
  override: string | undefined,
  governance: Map<string, string>,
  pkgName: string | null,
  projectPath: string
): string {
  if (override && override.trim() !== '') return override.trim();
  const blueprint = governance.get('BLUEPRINT.md');
  if (blueprint) {
    const named = boldFieldValue(blueprint, 'Name') ?? firstHeading(blueprint);
    if (named) return named;
  }
  const prd = governance.get('PRD.md');
  if (prd) {
    const heading = firstHeading(prd);
    if (heading) return heading;
  }
  if (pkgName && pkgName.trim() !== '') return pkgName.trim();
  return basename(projectPath) || 'Project';
}

/** Resolve the human description from PRD overview → BLUEPRINT purpose → package.json. */
function resolveDescription(governance: Map<string, string>, pkgDescription: string | null): string {
  const prd = governance.get('PRD.md');
  if (prd) {
    const overview = sectionParagraph(prd, 'Product Overview') ?? sectionParagraph(prd, 'Overview');
    if (overview) return overview;
  }
  const blueprint = governance.get('BLUEPRINT.md');
  if (blueprint) {
    const purpose = boldFieldValue(blueprint, 'Purpose');
    if (purpose) return purpose;
  }
  if (pkgDescription && pkgDescription.trim() !== '') return pkgDescription.trim();
  return 'No description available — add one to PRD.md or package.json.';
}

// ---------------------------------------------------------------------------
// package.json + .env reading
// ---------------------------------------------------------------------------

/** Minimal package.json view used by the generator. */
interface PackageInfo {
  name: string | null;
  description: string | null;
  scripts: Array<{ name: string; command: string }>;
}

/** Read + parse package.json for name/description/scripts (guarded). */
async function readPackage(projectPath: string): Promise<PackageInfo> {
  const text = await readTextSafe(join(projectPath, 'package.json'));
  if (text === null) return { name: null, description: null, scripts: [] };
  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return { name: null, description: null, scripts: [] };
    pkg = parsed as Record<string, unknown>;
  } catch {
    return { name: null, description: null, scripts: [] };
  }
  const scripts: Array<{ name: string; command: string }> = [];
  const scriptSection = pkg['scripts'];
  if (scriptSection && typeof scriptSection === 'object') {
    for (const [name, command] of Object.entries(scriptSection as Record<string, unknown>)) {
      scripts.push({ name, command: typeof command === 'string' ? command : String(command) });
    }
  }
  return {
    name: typeof pkg['name'] === 'string' ? (pkg['name'] as string) : null,
    description: typeof pkg['description'] === 'string' ? (pkg['description'] as string) : null,
    scripts,
  };
}

/** A declared environment variable (NAME only — never a value). */
interface EnvVar {
  name: string;
  /** Inline/preceding comment, if any. */
  comment: string | null;
  /** Sample/placeholder on the RHS of `.env.example` (never a real secret). */
  sample: string | null;
}

/** Parse `.env.example` into declared variable NAMES (+ comments/placeholders). */
async function readEnvExample(projectPath: string): Promise<EnvVar[]> {
  const candidates = ['.env.example', '.env.sample', '.env.template'];
  let text: string | null = null;
  for (const file of candidates) {
    text = await readTextSafe(join(projectPath, file));
    if (text !== null) break;
  }
  if (text === null) return [];

  const vars: EnvVar[] = [];
  let pendingComment: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') {
      pendingComment = null;
      continue;
    }
    if (line.startsWith('#')) {
      pendingComment = collapse(line.replace(/^#+\s*/, '')) || null;
      continue;
    }
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && m[1]) {
      const inlineComment = /\s#\s*(.+)$/.exec(m[2] ?? '');
      const sampleRaw = (m[2] ?? '').replace(/\s#.*$/, '').trim().replace(/^["']|["']$/g, '');
      vars.push({
        name: m[1],
        comment: pendingComment ?? (inlineComment && inlineComment[1] ? collapse(inlineComment[1]) : null),
        sample: sampleRaw === '' ? null : sampleRaw,
      });
    }
    pendingComment = null;
  }
  return vars;
}

// ---------------------------------------------------------------------------
// API endpoint assembly (codebase routes ⊕ BEHAVIORAL_CONTRACTS)
// ---------------------------------------------------------------------------

/** A documented API endpoint, merged from the codebase and governance. */
interface Endpoint {
  method: string;
  path: string;
  /** Project-relative source file, if known. */
  file: string | null;
  /** `true` when an auth signal was detected (session/getUser/middleware/`/api/`). */
  authRequired: boolean;
  /** Table whose columns seed the request-body example, if one matches the path. */
  table: string | null;
}

/** Extract `METHOD /path` pairs declared in a BEHAVIORAL_CONTRACTS-style doc. */
function parseRoutesFromMarkdown(markdown: string): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const verbs = HTTP_METHODS.join('|');
  const re = new RegExp(`\\b(${verbs})\\s+(/[A-Za-z0-9_\\-:.{}\\[\\]/]*)`, 'gi');
  for (const m of markdown.matchAll(re)) {
    const method = (m[1] ?? '').toUpperCase();
    const path = (m[2] ?? '').replace(/[.,;:)]+$/, '');
    if (method === '' || path === '') continue;
    if (/^\/(src|dist|node_modules)\b/i.test(path)) continue;
    out.push({ method, path });
  }
  return out;
}

/** Detect the HTTP methods a Next.js App-Router `route` file exports. */
function detectRouteMethods(source: string): string[] {
  const found: string[] = [];
  for (const method of HTTP_METHODS) {
    const re = new RegExp(
      `export\\s+(?:async\\s+)?function\\s+${method}\\b|export\\s+const\\s+${method}\\s*=`,
      'm'
    );
    if (re.test(source)) found.push(method);
  }
  return found;
}

/** Does a route file's source contain a server-side auth signal? */
function hasAuthSignal(source: string): boolean {
  return /auth\.getUser|auth\.getSession|getServerSession|requireAuth|createServerClient|getUser\(|company_id/i.test(
    source
  );
}

/** Best-effort: map an API route path to a schema table name. */
function tableForPath(path: string, tableNames: ReadonlySet<string>): string | null {
  const segments = path.split('/').filter((s) => s !== '' && s !== 'api' && !s.startsWith('[') && !s.startsWith(':') && !s.startsWith('{'));
  // Prefer the last static segment; try exact, singular, and pluralised forms.
  for (const seg of [...segments].reverse()) {
    const lower = seg.toLowerCase();
    if (tableNames.has(lower)) return lower;
    if (tableNames.has(`${lower}s`)) return `${lower}s`;
    if (lower.endsWith('s') && tableNames.has(lower.slice(0, -1))) return lower.slice(0, -1);
    if (lower.endsWith('ies') && tableNames.has(`${lower.slice(0, -3)}y`)) return `${lower.slice(0, -3)}y`;
  }
  return null;
}

/**
 * Build the endpoint catalogue: every codebase API route (with its real exported
 * methods + auth signal) merged with every route declared in BEHAVIORAL_CONTRACTS.
 */
async function assembleEndpoints(
  projectPath: string,
  apiRoutes: readonly RouteInfo[],
  contractsMd: string | null,
  tableNames: ReadonlySet<string>
): Promise<Endpoint[]> {
  const byKey = new Map<string, Endpoint>();
  const add = (method: string, path: string, file: string | null, authRequired: boolean): void => {
    const key = `${method} ${path}`;
    const existing = byKey.get(key);
    if (existing) {
      if (file && !existing.file) existing.file = file;
      if (authRequired) existing.authRequired = true;
      return;
    }
    byKey.set(key, { method, path, file, authRequired, table: tableForPath(path, tableNames) });
  };

  for (const route of apiRoutes) {
    const source = await readTextSafe(join(projectPath, route.file));
    const methods = source ? detectRouteMethods(source) : [];
    const auth = source ? hasAuthSignal(source) : route.route.startsWith('/api');
    const list = methods.length > 0 ? methods : ['GET'];
    for (const method of list) add(method, route.route, route.file, auth);
  }

  if (contractsMd) {
    for (const { method, path } of parseRoutesFromMarkdown(contractsMd)) {
      add(method, path, null, /\/api\//i.test(path) || method !== 'GET');
    }
  }

  return [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

// ---------------------------------------------------------------------------
// JSON example construction (from real schema columns)
// ---------------------------------------------------------------------------

/** A placeholder JSON value for a column, chosen from its declared SQL type. */
function sampleForColumn(column: ColumnSchema): unknown {
  const t = column.type.toLowerCase();
  if (/\bbool/.test(t)) return false;
  if (/\b(int|serial|smallint|bigint|numeric|decimal|real|double|float)/.test(t)) return 0;
  if (/\bjson/.test(t)) return {};
  if (/\buuid/.test(t)) return '00000000-0000-0000-0000-000000000000';
  if (/\b(timestamp|date|time)/.test(t)) return '2026-01-01T00:00:00Z';
  if (/\[\]$/.test(t) || /\barray/.test(t)) return [];
  return `example_${column.name}`;
}

/** Build a request-body example object from a table's insertable columns. */
function requestBodyExample(table: TableSchema | undefined): Record<string, unknown> | null {
  if (!table) return null;
  const body: Record<string, unknown> = {};
  for (const column of table.columns) {
    if (SERVER_DERIVED_COLUMNS.has(column.name.toLowerCase())) continue;
    body[column.name] = sampleForColumn(column);
  }
  return Object.keys(body).length > 0 ? body : null;
}

/** Build a full-row response example from every column of a table. */
function responseRowExample(table: TableSchema | undefined): Record<string, unknown> | null {
  if (!table) return null;
  const row: Record<string, unknown> = {};
  for (const column of table.columns) row[column.name] = sampleForColumn(column);
  return Object.keys(row).length > 0 ? row : null;
}

/** Fenced JSON code block (2-space indented). */
function jsonBlock(value: unknown): string {
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

// ---------------------------------------------------------------------------
// Plain-language RLS description
// ---------------------------------------------------------------------------

/** Map an RLS command to a plain verb. */
function commandVerb(command: string): string {
  switch (command.toUpperCase()) {
    case 'SELECT':
      return 'read';
    case 'INSERT':
      return 'create';
    case 'UPDATE':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return 'read, create, update, or delete';
  }
}

/** Translate an RLS USING/CHECK expression into a plain-language clause (heuristic). */
function describeExpression(expr: string | null): string {
  if (!expr || expr.trim() === '') return 'all rows (no additional row filter)';
  const e = expr.toLowerCase();
  if (/company_id/.test(e)) return 'only rows belonging to the signed-in user’s company';
  if (/auth\.uid\(\)\s*=\s*user_id|user_id\s*=\s*auth\.uid\(\)/.test(e)) return 'only rows the signed-in user owns';
  if (/auth\.role\(\)|\brole\b/.test(e)) return 'rows permitted for the user’s role';
  if (/auth\.uid\(\)\s+is\s+not\s+null|authenticated/.test(e)) return 'any row, for any signed-in user';
  if (/true/.test(e.replace(/\s/g, ''))) return 'all rows (unrestricted)';
  return 'rows matching the policy condition';
}

/** Render one RLS policy as a plain-language sentence (with the raw expression). */
function describePolicy(policy: RlsPolicy): string {
  const verb = commandVerb(policy.command);
  const roles = policy.roles.length ? policy.roles.join(', ') : 'all roles';
  const clause = describeExpression(policy.using ?? policy.withCheck);
  const raw = policy.using ?? policy.withCheck;
  const rawNote = raw ? ` _(condition: \`${collapse(raw)}\`)_` : '';
  return `**${policy.name}** — lets **${roles}** ${verb} ${clause}.${rawNote}`;
}

// ---------------------------------------------------------------------------
// Document renderers (pure — given the assembled inputs)
// ---------------------------------------------------------------------------

/** Everything the renderers need, assembled once. */
interface RenderInputs {
  projectName: string;
  description: string;
  stack: StackFingerprint;
  pkg: PackageInfo;
  envVars: EnvVar[];
  endpoints: Endpoint[];
  schema: SchemaSnapshot;
  generatedAt: string;
  governanceSources: string[];
}

/** A footer noting provenance + generation time. */
function footer(inputs: RenderInputs): string {
  const sources = inputs.governanceSources.length
    ? inputs.governanceSources.join(', ')
    : 'codebase only (no governance docs found)';
  return [
    '---',
    '',
    `_Generated by FORGE 2.0 Documentation Generator on ${inputs.generatedAt} from ${sources} + live codebase audit. Do not edit by hand — re-run the generator._`,
  ].join('\n');
}

/** Render the package manager run-prefix (`pnpm`, `npm run`, …). */
function runPrefix(stack: StackFingerprint): string {
  const pm = stack.packageManager ?? 'pnpm';
  return pm === 'npm' ? 'npm run' : pm === 'yarn' ? 'yarn' : pm;
}

/** README.md */
function renderReadme(inputs: RenderInputs): string {
  const { projectName, description, stack, pkg, envVars } = inputs;
  const pm = stack.packageManager ?? 'pnpm';
  const run = runPrefix(stack);
  const lines: string[] = [];

  lines.push(`# ${projectName}`, '', description, '');

  lines.push('## Tech Stack', '');
  const stackRows: Array<[string, string | null]> = [
    ['Framework', stack.framework],
    ['Language', stack.language],
    ['Database', stack.database],
    ['Deployment', stack.deployment],
    ['Package manager', stack.packageManager],
  ];
  for (const [label, value] of stackRows) {
    if (value) lines.push(`- **${label}:** ${value}`);
  }
  if (stack.services.length) lines.push(`- **Integrations:** ${stack.services.join(', ')}`);
  lines.push('');

  lines.push('## Setup', '', '```bash', `# 1. Install dependencies`, `${pm} install`, '');
  if (envVars.length) {
    lines.push(`# 2. Configure environment`, `cp .env.example .env.local   # then fill in the values`, '');
  }
  const devScript = pkg.scripts.find((s) => s.name === 'dev');
  const startScript = pkg.scripts.find((s) => s.name === 'start');
  if (devScript) lines.push(`# 3. Start the dev server`, `${run} dev`);
  else if (startScript) lines.push(`# 3. Start`, `${run} start`);
  lines.push('```', '');

  lines.push('## Environment Variables', '');
  if (envVars.length) {
    lines.push('| Variable | Description |', '| --- | --- |');
    for (const v of envVars) {
      lines.push(`| \`${v.name}\` | ${v.comment ?? '—'} |`);
    }
    lines.push('', '> Values live in `.env.local` (never committed). `.env.example` lists every required key.');
  } else {
    lines.push('No `.env.example` was found — this project declares no environment variables, or they are documented elsewhere.');
  }
  lines.push('');

  lines.push('## Build Commands', '');
  if (pkg.scripts.length) {
    lines.push('| Command | Runs |', '| --- | --- |');
    for (const s of pkg.scripts) lines.push(`| \`${run} ${s.name}\` | \`${s.command}\` |`);
  } else {
    lines.push('No `package.json` scripts were found.');
  }
  lines.push('');

  lines.push(
    '## Deployment',
    '',
    `See [DEPLOY.md](./DEPLOY.md) for the full step-by-step guide (including \`deploy.ps1\` usage). API reference: [API.md](./API.md). Database schema: [SCHEMA.md](./SCHEMA.md).`,
    ''
  );

  lines.push(footer(inputs));
  return lines.join('\n');
}

/** API.md */
function renderApiDoc(inputs: RenderInputs): string {
  const { endpoints, schema } = inputs;
  const tableByName = new Map<string, TableSchema>(schema.tables.map((t): [string, TableSchema] => [t.name, t]));
  const lines: string[] = [];

  lines.push(`# ${inputs.projectName} — API Reference`, '');
  if (endpoints.length === 0) {
    lines.push(
      'No API endpoints were detected in the codebase or declared in BEHAVIORAL_CONTRACTS.md.',
      '',
      footer(inputs)
    );
    return lines.join('\n');
  }

  lines.push(
    `${endpoints.length} endpoint(s). Request/response examples are illustrative, derived from the matching database table where one was found.`,
    ''
  );

  for (const ep of endpoints) {
    lines.push(`## \`${ep.method} ${ep.path}\``, '');
    if (ep.file) lines.push(`Source: \`${ep.file}\``, '');
    lines.push(`- **Auth:** ${ep.authRequired ? 'Required — rejects unauthenticated requests (company_id derived from session, never the request body).' : 'Public — no authentication required.'}`);
    lines.push('');

    const table = ep.table ? tableByName.get(ep.table) : undefined;

    if (BODY_METHODS.has(ep.method)) {
      const body = requestBodyExample(table);
      lines.push('**Request body**', '');
      lines.push(body ? jsonBlock(body) : '_No schema match — body shape determined by the route handler._');
      lines.push('');
    }

    lines.push('**Response example**', '');
    if (ep.method === 'GET' && table) {
      const row = responseRowExample(table);
      lines.push(jsonBlock(ep.path.match(/[\[{:]/) ? row ?? {} : { data: [row ?? {}] }));
    } else {
      const row = responseRowExample(table);
      lines.push(jsonBlock(row ?? { ok: true }));
    }
    lines.push('');

    lines.push('**Error codes**', '');
    lines.push('| Code | Meaning |', '| --- | --- |');
    lines.push('| `400` | Invalid request body or parameters. |');
    if (ep.authRequired) {
      lines.push('| `401` | Not authenticated. |');
      lines.push('| `403` | Authenticated but not permitted (role/company scope). |');
    }
    lines.push('| `404` | Resource not found. |');
    lines.push('| `500` | Unexpected server error. |');
    lines.push('');
  }

  lines.push(footer(inputs));
  return lines.join('\n');
}

/** SCHEMA.md */
function renderSchemaDoc(inputs: RenderInputs): string {
  const { schema } = inputs;
  const lines: string[] = [];

  lines.push(`# ${inputs.projectName} — Database Schema`, '');
  if (schema.tables.length === 0) {
    lines.push(
      'No database tables were found (no migration `.sql` files and no live connection).',
      '',
      footer(inputs)
    );
    return lines.join('\n');
  }

  lines.push(
    `${schema.tables.length} table(s)${schema.source !== 'none' ? ` (source: ${schema.source})` : ''}.`,
    ''
  );

  for (const table of schema.tables) {
    lines.push(`## \`${table.name}\``, '');

    lines.push('| Column | Type | Nullable | Default | Constraints |', '| --- | --- | --- | --- | --- |');
    for (const col of table.columns) {
      const constraints = col.constraints.length ? col.constraints.join('; ') : '—';
      lines.push(
        `| \`${col.name}\` | \`${col.type}\` | ${col.nullable ? 'yes' : 'no'} | ${col.default ? `\`${col.default}\`` : '—'} | ${constraints} |`
      );
    }
    lines.push('');

    if (table.primaryKey.length) {
      lines.push(`**Primary key:** ${table.primaryKey.map((c) => `\`${c}\``).join(', ')}`, '');
    }

    const rels = schema.relationships.filter((r) => r.fromTable === table.name);
    if (rels.length) {
      lines.push('**Relationships:**');
      for (const r of rels) {
        const action = r.onDelete ? ` _(on delete ${r.onDelete})_` : '';
        lines.push(
          `- \`${r.fromColumns.join(', ')}\` → \`${r.toTable}(${r.toColumns.join(', ') || '…'})\`${action}`
        );
      }
      lines.push('');
    }

    const policies = schema.rlsPolicies.filter((p) => p.table === table.name);
    lines.push('**Row-Level Security:**');
    if (table.rlsEnabled || policies.length) {
      lines.push(`RLS is ${table.rlsEnabled ? 'enabled' : 'declared via policies'} on this table.`);
      if (policies.length) {
        for (const p of policies) lines.push(`- ${describePolicy(p)}`);
      } else {
        lines.push('- No explicit policies were found — with RLS enabled and no policy, the table denies all access by default.');
      }
    } else {
      lines.push('RLS is **not** enabled on this table — access is governed by grants alone.');
    }
    lines.push('');
  }

  lines.push(footer(inputs));
  return lines.join('\n');
}

/** DEPLOY.md */
function renderDeployDoc(inputs: RenderInputs): string {
  const { stack, pkg } = inputs;
  const pm = stack.packageManager ?? 'pnpm';
  const run = runPrefix(stack);
  const target = stack.deployment ?? 'vercel';
  const lines: string[] = [];

  lines.push(`# ${inputs.projectName} — Deployment Guide`, '');
  lines.push(`Deployment target: **${target}**. Package manager: **${pm}**.`, '');

  lines.push('## Prerequisites', '');
  const cliTools = stack.cliTools.length ? stack.cliTools : [pm, 'git'];
  for (const tool of cliTools) lines.push(`- \`${tool}\` installed and on \`PATH\``);
  lines.push('- All environment variables from `.env.example` configured in the deployment target', '');

  lines.push('## Manual deployment', '', '```bash');
  const buildScript = pkg.scripts.find((s) => s.name === 'build');
  lines.push('# 1. Install + type-check + build');
  lines.push(`${pm} install`);
  lines.push(`${run} typecheck   # or: ${pm} tsc --noEmit`);
  if (buildScript) lines.push(`${run} build`);
  const testScript = pkg.scripts.find((s) => s.name === 'test' || s.name.startsWith('test'));
  if (testScript) lines.push('', '# 2. Test', `${run} ${testScript.name}`);
  lines.push('', '# 3. Deploy');
  if (target === 'vercel') lines.push('vercel --prod');
  else if (target === 'netlify') lines.push('netlify deploy --prod');
  else if (target === 'docker') lines.push('docker compose up -d --build');
  else lines.push(`# deploy to ${target}`);
  lines.push('', '# 4. Commit + push');
  lines.push('git add -A', 'git commit -m "deploy: <description>"', 'git push');
  lines.push('```', '');

  lines.push('## One-shot deployment — `deploy.ps1`', '');
  lines.push(
    'On Windows, `deploy.ps1` runs the full FORGE deploy protocol in order and **aborts on the first failure** (never force-pushes broken code):',
    '',
    '```powershell',
    './deploy.ps1',
    '```',
    '',
    'It performs, in sequence:',
    '',
    `1. \`${pm} tsc --noEmit\` — type-check (must pass)`,
    `2. \`${run} build\` — production build (must pass)`,
    target === 'vercel'
      ? '3. `vercel --prod` — deploy (must succeed)'
      : target === 'netlify'
        ? '3. `netlify deploy --prod` — deploy (must succeed)'
        : `3. deploy to ${target} (must succeed)`,
    testScript ? `4. \`${run} ${testScript.name}\` — smoke/e2e tests (must pass)` : '4. tests (if present, must pass)',
    '5. `git add -A; git commit; git push` — only after every prior step succeeds',
    '',
    'If any step fails, the script stops and reports the failure — fix it and re-run.',
    ''
  );

  lines.push(footer(inputs));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** Default progress logger. */
function defaultLog(message: string): void {
  logLine('docs')(message);
}

/**
 * Generate README.md / API.md / SCHEMA.md / DEPLOY.md for the project at
 * `projectPath`, from its governance documents + actual codebase state, and (unless
 * `write:false`) write them into the project's `docs/` directory.
 *
 * Always resolves (never rejects). A bare or unreadable project yields a thin set of
 * documents plus warnings rather than throwing.
 */
export async function generateDocs(
  projectPath: string,
  options: DocGeneratorOptions = {}
): Promise<DocGenerationResult> {
  const warnings: string[] = [];
  const log = options.log ?? defaultLog;
  const write = options.write ?? true;
  const outputDir = options.outputDir ?? 'docs';

  const readCodebaseImpl = options.readCodebaseImpl ?? readCodebase;
  const extractSchemaImpl = options.extractSchemaImpl ?? extractSchema;
  const detectStackImpl = options.detectStackImpl ?? detectStack;

  // --- gather sources (all guarded) ---------------------------------------
  const [governance, pkg, envVars] = await Promise.all([
    loadGovernance(projectPath),
    readPackage(projectPath),
    readEnvExample(projectPath),
  ]);

  let codebase: CodebaseSnapshot | null = null;
  try {
    codebase = await readCodebaseImpl(projectPath);
  } catch (error) {
    warnings.push(`Codebase read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let schema: SchemaSnapshot;
  try {
    const schemaOptions: SchemaExtractorOptions = { projectPath };
    if (options.sql) schemaOptions.sql = options.sql;
    if (options.supabase) schemaOptions.supabase = options.supabase;
    schema = await extractSchemaImpl(schemaOptions);
    warnings.push(...schema.warnings);
  } catch (error) {
    warnings.push(`Schema extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    schema = { tables: [], relationships: [], indexes: [], rlsPolicies: [], source: 'none', migrationFiles: [], warnings: [] };
  }

  let stack: StackFingerprint;
  try {
    stack = await detectStackImpl(projectPath);
  } catch (error) {
    warnings.push(`Stack detection failed: ${error instanceof Error ? error.message : String(error)}`);
    stack = { framework: null, language: null, database: null, deployment: null, packageManager: null, services: [], cliTools: [] };
  }

  // --- resolve narrative + endpoints --------------------------------------
  const projectName = resolveProjectName(options.projectName, governance.docs, pkg.name, projectPath);
  const description = resolveDescription(governance.docs, pkg.description);

  const apiRoutes = (codebase?.routes ?? []).filter((r) => r.kind === 'api');
  const tableNames = new Set(schema.tables.map((t) => t.name));
  const endpoints = await assembleEndpoints(
    projectPath,
    apiRoutes,
    governance.docs.get('BEHAVIORAL_CONTRACTS.md') ?? null,
    tableNames
  );

  const inputs: RenderInputs = {
    projectName,
    description,
    stack,
    pkg,
    envVars,
    endpoints,
    schema,
    generatedAt: nowIso(),
    governanceSources: governance.sources,
  };

  // --- render -------------------------------------------------------------
  const rendered: Array<{ name: GeneratedDocName; content: string }> = [
    { name: 'README.md', content: renderReadme(inputs) },
    { name: 'API.md', content: renderApiDoc(inputs) },
    { name: 'SCHEMA.md', content: renderSchemaDoc(inputs) },
    { name: 'DEPLOY.md', content: renderDeployDoc(inputs) },
  ];

  // --- write --------------------------------------------------------------
  let canWrite = write;
  if (write) {
    try {
      await mkdir(join(projectPath, outputDir), { recursive: true });
    } catch (error) {
      canWrite = false;
      warnings.push(`Could not create ${outputDir}/ (${error instanceof Error ? error.message : String(error)}); returning content only.`);
    }
  }

  const documents: GeneratedDoc[] = [];
  for (const doc of rendered) {
    const relPath = `${outputDir}/${doc.name}`;
    const bytes = Buffer.byteLength(doc.content, 'utf8');
    let written = false;
    if (canWrite) {
      try {
        await writeFile(join(projectPath, outputDir, doc.name), doc.content, 'utf8');
        written = true;
        log(`wrote ${relPath} (${bytes} bytes)`);
      } catch (error) {
        warnings.push(`Failed to write ${relPath} (${error instanceof Error ? error.message : String(error)}).`);
      }
    }
    documents.push({ name: doc.name, path: relPath, content: doc.content, bytes, written });
  }

  return {
    projectName,
    documents,
    outputDir,
    stack,
    generatedAt: inputs.generatedAt,
    governanceSources: governance.sources,
    warnings,
  };
}

export default generateDocs;
