/**
 * FORGE 2.0 — Phase 1C: Current State Ingestion (orchestrator).
 *
 * Phase 1C runs only for PARTIAL builds (an existing codebase FORGE is extending,
 * not a greenfield project). It composes the two Phase 1 reading tools — the
 * Codebase Reader (s3-p01) and the Schema Extractor (s3-p02) — and distills their
 * raw snapshots into a single `ConstraintManifest`: the set of decisions that are
 * already made and must be treated as IMMUTABLE, the places where new code may be
 * added (EXTENSIBLE), and the anti-patterns a human should review (FLAGGED).
 *
 * Sequence (per queue.yaml s3-p03):
 *   1. Run the Codebase Reader on the project        → readCodebase(projectPath)
 *   2. Run the Schema Extractor on the project        → extractSchema({ projectPath, … })
 *   3. Classify every component: immutable (keep) / extensible (can add to) /
 *      flagged (anti-pattern)
 *   4. Assemble a ConstraintManifest with:
 *        - Existing schema tables          (immutable)
 *        - Existing routes                 (immutable)
 *        - Existing components             (immutable — the exported public surface)
 *        - Existing design tokens          (immutable — colors/fonts/spacing/radii/shadows)
 *        - Available extension points      (where new code can be added)
 *        - Flagged patterns                (potential issues for human review)
 *
 * The manifest is the bridge into Phase 1B (s3-p05): when an architect is given a
 * ConstraintManifest it treats the immutable items as fixed and designs only the
 * extensions (queue.yaml s3-p05: "treats immutable items as fixed and designs only
 * extensions"). Phase 1C therefore never proposes changes — it only describes what
 * exists and judges it.
 *
 * Like its underlying tools (codebase-reader, schema-extractor), this orchestrator
 * is best-effort and NON-FATAL: every file read is guarded, missing/unreadable
 * inputs are skipped, and a partial manifest is a valid result. `runPhase1cIngest`
 * never throws — the worst case is an almost-empty manifest with `partialBuild:
 * false` (nothing existed to constrain) plus warnings.
 *
 * Design-token extraction is intentionally LIGHTWEIGHT and heuristic (CSS custom
 * properties and a best-effort scan of `tailwind.config.*` theme blocks), not a
 * full CSS/JS parse — it is a constraint catalog for an intelligence engine, not a
 * style compiler.
 *
 * SECURITY: only structural/design metadata is read (table/route/symbol names,
 * design-token names + values). No `.env*` secret values are touched here — the
 * live database connection, if any, is supplied by the caller (never harvested).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  readCodebase,
  type CodebaseSnapshot,
  type CodebaseReaderOptions,
  type CodeSymbolKind,
  type FileTreeNode,
  type RouteRouter,
  type RouteKind,
} from '../tools/codebase-reader.js';
import {
  extractSchema,
  type SchemaSnapshot,
  type SchemaExtractorOptions,
  type SqlExecutor,
} from '../tools/schema-extractor.js';
import { nowIso } from '../memory/index.js';
import { logLine } from '../tools/forge-logger.js';

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

/** How a single component is classified relative to the planned build. */
export type Classification = 'immutable' | 'extensible' | 'flagged';

/** An existing database table — an immutable constraint Phase 1B must preserve. */
export interface ImmutableTable {
  /** Table name without schema prefix (e.g. `build_runs`). */
  name: string;
  /** Containing schema (almost always `public`). */
  schema: string;
  /** Columns reduced to the fields a planner needs (name, type, nullability). */
  columns: Array<{ name: string; type: string; nullable: boolean }>;
  /** Primary-key column names, in order. */
  primaryKey: string[];
  /** Whether row-level security is enabled on the table. */
  rlsEnabled: boolean;
  /** Migration file that declares it, or `null` if only known from a live DB. */
  file: string | null;
}

/** An existing route — an immutable constraint (the URL surface is fixed). */
export interface ImmutableRoute {
  /** URL path with dynamic segments normalized (`[id]`→`:id`). */
  route: string;
  router: RouteRouter;
  kind: RouteKind;
  dynamic: boolean;
  /** Project-relative POSIX path of the route file. */
  file: string;
}

/** An existing exported code symbol — part of the immutable public surface. */
export interface ImmutableComponent {
  name: string;
  kind: CodeSymbolKind;
  /** Project-relative POSIX path of the declaring file. */
  file: string;
  /** 1-based declaration line. */
  line: number;
  /** One-line signature for callables, or `null`. */
  signature: string | null;
}

/**
 * Design tokens reconstructed from the project's styles — an immutable brand
 * constraint. Buckets are best-effort; `cssVariables` is the raw set of CSS custom
 * properties (a superset, before bucketing) for downstream consumers that want it.
 */
export interface DesignTokens {
  colors: Record<string, string>;
  fonts: Record<string, string>;
  spacing: Record<string, string>;
  radii: Record<string, string>;
  shadows: Record<string, string>;
  /** Every `--name: value` CSS custom property found (raw, un-bucketed). */
  cssVariables: Record<string, string>;
  /** Project-relative files tokens were extracted from. */
  sources: string[];
}

/** The category of a place where FORGE may safely add new code. */
export type ExtensionPointKind =
  | 'route-root'
  | 'api-root'
  | 'components-dir'
  | 'lib-dir'
  | 'migrations-dir'
  | 'styles';

/** A location where new code can be added without violating an immutable constraint. */
export interface ExtensionPoint {
  kind: ExtensionPointKind;
  /** Project-relative POSIX directory path. */
  path: string;
  description: string;
}

/** Severity of a flagged anti-pattern. */
export type FlagSeverity = 'warning' | 'critical';

/** A potential issue surfaced for human review (never auto-fixed in Phase 1C). */
export interface FlaggedPattern {
  /** Stable detector id (e.g. `table_missing_rls`). */
  id: string;
  severity: FlagSeverity;
  /** Human-readable subject (table / route / file). */
  subject: string;
  /** Stable key cross-referenced by `classifications` (e.g. `table:build_runs`). */
  subjectKey: string;
  /** Project-relative file the issue lives in, or `null`. */
  file: string | null;
  detail: string;
  /** The governance rule / seed pattern that motivates the flag. */
  governanceRef: string;
}

/** A single classified component — the flat "classify each component" output. */
export interface ClassifiedComponent {
  kind: 'table' | 'route' | 'component' | 'directory' | 'file';
  name: string;
  file: string | null;
  classification: Classification;
  reason: string;
}

/** Aggregate classification + inventory counts for the manifest. */
export interface ConstraintSummary {
  /** Components classified `immutable`. */
  immutableCount: number;
  /** Components classified `extensible`. */
  extensibleCount: number;
  /** Flagged anti-patterns (= `flaggedPatterns.length`). */
  flaggedCount: number;
  totalTables: number;
  totalRoutes: number;
  /** All top-level declarations found (not just the exported surface). */
  totalComponents: number;
  /** Distinct design tokens across all buckets. */
  totalDesignTokens: number;
}

/** The complete constraint manifest produced by {@link runPhase1cIngest}. */
export interface ConstraintManifest {
  projectPath: string;
  generatedAt: string;
  /**
   * Whether the project actually contains prior work to constrain. `false` for an
   * essentially empty directory (no source files and no schema) — Phase 1B then
   * treats the build as greenfield and ignores the (empty) immutable sets.
   */
  partialBuild: boolean;
  /** Decisions already made — Phase 1B must preserve these unchanged. */
  immutable: {
    schemaTables: ImmutableTable[];
    routes: ImmutableRoute[];
    components: ImmutableComponent[];
    designTokens: DesignTokens;
  };
  /** Where new code can be added. */
  extensionPoints: ExtensionPoint[];
  /** Anti-patterns for human review. */
  flaggedPatterns: FlaggedPattern[];
  /** Flat per-component classification (immutable / extensible / flagged). */
  classifications: ClassifiedComponent[];
  summary: ConstraintSummary;
  /** Non-fatal observations (unreadable file, no schema source, parse skip, …). */
  warnings: string[];
  /** The raw snapshots this manifest was derived from (for downstream consumers). */
  codebase: CodebaseSnapshot;
  schema: SchemaSnapshot;
}

/** Options for {@link runPhase1cIngest}. */
export interface Phase1cOptions {
  /** Directory names to prune from the codebase walk (forwarded to the reader). */
  ignoreDirs?: readonly string[];
  /** Live SQL executor for schema introspection (forwarded to the extractor). */
  sql?: SqlExecutor;
  /** Supabase client for schema introspection (forwarded to the extractor). */
  supabase?: SupabaseClient;
  /** Cap on style files read for design-token extraction. Default 200. */
  maxStyleFiles?: number;
  /** Progress reporter. Default logs to the console with a [FORGE:phase1c] prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Column names that mark a table as tenant/company scoped (Six Laws Law 1). */
const TENANT_SCOPE_COLUMNS: ReadonlySet<string> = new Set([
  'company_id',
  'tenant_id',
  'organization_id',
  'org_id',
  'account_id',
  'workspace_id',
]);

/** Conventional Next.js router roots checked as route extension points. */
const ROUTE_ROOT_DIRS: readonly string[] = ['app', 'pages', 'src/app', 'src/pages'];
/** Conventional API route roots. */
const API_ROOT_DIRS: readonly string[] = ['app/api', 'src/app/api', 'pages/api', 'src/pages/api'];
/** Conventional component directories. */
const COMPONENTS_DIRS: readonly string[] = ['components', 'src/components', 'app/components', 'src/app/components'];
/** Conventional shared-library directories. */
const LIB_DIRS: readonly string[] = ['lib', 'src/lib', 'utils', 'src/utils'];
/** Conventional migration directories. */
const MIGRATION_DIRS: readonly string[] = ['migrations', 'supabase/migrations', 'db/migrations'];

/** Style file extensions read for design-token extraction. */
const STYLE_EXTS: ReadonlySet<string> = new Set(['css', 'scss', 'sass', 'less']);

/** Tailwind config basenames (any extension) read for theme tokens. */
const TAILWIND_CONFIG_RE = /^tailwind\.config\.(?:js|cjs|mjs|ts|cts|mts)$/i;

/** Per-style-file read cap (512 KB) — large generated CSS is skipped, not fatal. */
const MAX_STYLE_BYTES = 512_000;

/** Basenames that mark a file as mock/placeholder data (Iron Law 8). */
const MOCK_NAME_RE = /(?:^|[-_.])(mocks?|placeholder|dummy|stub|fixtures?|fake|sample-data)(?:[-_.]|$)/i;

// ---------------------------------------------------------------------------
// Low-level helpers (all guarded — never throw)
// ---------------------------------------------------------------------------

/** Read a UTF-8 text file, returning `null` if it cannot be read. */
async function readTextSafe(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** POSIX base name of a project-relative path. */
function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Does a value look like a CSS color (hex / rgb / hsl / oklch)? */
function isColorValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  return /^#[0-9a-f]{3,8}$/.test(v) || /^(?:rgb|rgba|hsl|hsla|oklch|lab|lch|color)\s*\(/.test(v);
}

// ---------------------------------------------------------------------------
// File-tree flattening
// ---------------------------------------------------------------------------

/** Flat view of the codebase tree: files (with ext) and the set of directory paths. */
interface FlatTree {
  files: Array<{ path: string; ext: string }>;
  dirs: Set<string>;
}

/** Flatten a {@link FileTreeNode} into files + directory paths (root excluded from dirs). */
function flattenTree(root: FileTreeNode): FlatTree {
  const files: Array<{ path: string; ext: string }> = [];
  const dirs = new Set<string>();
  const visit = (node: FileTreeNode): void => {
    if (node.type === 'directory') {
      if (node.path !== '.') dirs.add(node.path);
      for (const child of node.children ?? []) visit(child);
    } else {
      files.push({ path: node.path, ext: node.ext ?? '' });
    }
  };
  visit(root);
  return { files, dirs };
}

// ---------------------------------------------------------------------------
// Object-literal leaf extraction (for tailwind.config theme blocks)
// ---------------------------------------------------------------------------

/** Read a quoted string starting at `s[0]` (a quote), returning its value + length. */
function readQuoted(s: string): { value: string; length: number } | null {
  const q = s[0];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  let i = 1;
  let value = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const nxt = s[i + 1];
      if (nxt !== undefined) {
        value += nxt;
        i += 2;
        continue;
      }
    }
    if (c === q) return { value, length: i + 1 };
    value += c ?? '';
    i++;
  }
  return null;
}

/**
 * Read a balanced `open … close` group starting at `s[0]` (must be `open`), aware
 * of quoted strings. Returns the inner text (without the delimiters) and the total
 * length consumed, or `null` if unbalanced within `s`.
 */
function readBalanced(
  s: string,
  open: string,
  close: string
): { inner: string; length: number } | null {
  if (s[0] !== open) return null;
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      const str = readQuoted(s.slice(i));
      if (str) {
        i += str.length;
        continue;
      }
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { inner: s.slice(1, i), length: i + 1 };
    }
    i++;
  }
  return null;
}

/**
 * Walk a JS object-literal body, recording every string/array/scalar LEAF value
 * keyed by its dashed key path into `out`. Nested objects recurse with a `parent-`
 * prefix; arrays (e.g. `fontFamily`) are joined into a comma-separated string. This
 * is a heuristic for reading static tailwind theme blocks, not a JS evaluator.
 */
function collectObjectLeaves(src: string, out: Record<string, string>, prefix: string): void {
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === undefined) break;
    if (/\s|,|;/.test(ch)) {
      i++;
      continue;
    }
    // A spread or unexpected closer — skip it.
    if (ch === '}' || ch === '.') {
      i++;
      continue;
    }

    // --- read the key (quoted, identifier, or numeric) ---
    const slice = src.slice(i);
    const keyMatch = /^(['"`])((?:\\.|(?!\1).)*)\1|^([A-Za-z_$][\w$-]*)|^(\d[\w.]*)/.exec(slice);
    if (!keyMatch) {
      i++;
      continue;
    }
    const key = keyMatch[2] ?? keyMatch[3] ?? keyMatch[4] ?? '';
    i += (keyMatch[0] ?? '').length;

    // --- expect ':' ---
    while (i < n && /\s/.test(src[i] ?? '')) i++;
    if (src[i] !== ':') continue; // not a key/value pair (e.g. a bare method) — resync
    i++;
    while (i < n && /\s/.test(src[i] ?? '')) i++;

    const fullKey = prefix ? `${prefix}-${key}` : key;
    const v = src[i];

    if (v === '{') {
      const grp = readBalanced(src.slice(i), '{', '}');
      if (grp) {
        collectObjectLeaves(grp.inner, out, fullKey);
        i += grp.length;
      } else i++;
    } else if (v === '[') {
      const grp = readBalanced(src.slice(i), '[', ']');
      if (grp) {
        const items: string[] = [];
        const itemRe = /(['"`])((?:\\.|(?!\1).)*)\1/g;
        let m: RegExpExecArray | null;
        while ((m = itemRe.exec(grp.inner)) !== null) {
          if (m[2] !== undefined && m[2] !== '') items.push(m[2]);
        }
        if (fullKey !== '' && items.length > 0) out[fullKey] = items.join(', ');
        i += grp.length;
      } else i++;
    } else if (v === "'" || v === '"' || v === '`') {
      const str = readQuoted(src.slice(i));
      if (str) {
        if (fullKey !== '' && str.value !== '') out[fullKey] = str.value;
        i += str.length;
      } else i++;
    } else {
      // Unquoted scalar/expression — read to the next top-level comma or brace.
      let j = i;
      let depth = 0;
      while (j < n) {
        const c = src[j];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
          if (depth === 0) break;
          depth--;
        } else if (c === ',' && depth === 0) break;
        j++;
      }
      const raw = src.slice(i, j).trim();
      if (fullKey !== '' && raw !== '') out[fullKey] = raw;
      i = j;
    }
  }
}

// ---------------------------------------------------------------------------
// Design-token extraction
// ---------------------------------------------------------------------------

/** Create an empty design-token set. */
function emptyDesignTokens(): DesignTokens {
  return { colors: {}, fonts: {}, spacing: {}, radii: {}, shadows: {}, cssVariables: {}, sources: [] };
}

/** Route a CSS custom property into the right token bucket by name + value heuristics. */
function bucketCssVariable(name: string, value: string, tokens: DesignTokens): void {
  const n = name.toLowerCase();
  const v = value.trim();
  if (/(color|background|foreground|border|ring|accent|primary|secondary|muted|destructive|fill|stroke|surface|brand)/.test(n) || isColorValue(v)) {
    tokens.colors[name] = v;
  } else if (/(font|family|leading|tracking|^text-|-text)/.test(n)) {
    tokens.fonts[name] = v;
  } else if (/(radius|rounded)/.test(n)) {
    tokens.radii[name] = v;
  } else if (/shadow/.test(n)) {
    tokens.shadows[name] = v;
  } else if (/(space|spacing|gap|size|width|height|margin|padding|inset)/.test(n)) {
    tokens.spacing[name] = v;
  }
  // Otherwise it stays only in `cssVariables` (already recorded by the caller).
}

/** Extract `--name: value` custom properties from a CSS/SCSS file's text. */
function extractCssTokens(text: string, tokens: DesignTokens): void {
  const re = /--([A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const rawValue = m[2];
    if (name === undefined || rawValue === undefined) continue;
    const value = rawValue.trim();
    if (value === '') continue;
    const key = `--${name}`;
    tokens.cssVariables[key] = value;
    bucketCssVariable(name, value, tokens);
  }
}

/** Extract theme tokens (colors/fontFamily/spacing/borderRadius/boxShadow) from a tailwind config. */
function extractTailwindTokens(text: string, tokens: DesignTokens): void {
  // Strip comments so stray `{`/`}` inside them don't confuse the brace walker.
  const src = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const blockToBucket: Record<string, keyof Pick<DesignTokens, 'colors' | 'fonts' | 'spacing' | 'radii' | 'shadows'>> = {
    colors: 'colors',
    fontFamily: 'fonts',
    spacing: 'spacing',
    borderRadius: 'radii',
    boxShadow: 'shadows',
  };

  const headRe = /\b(colors|fontFamily|spacing|borderRadius|boxShadow)\s*:\s*\{/g;
  let head: RegExpExecArray | null;
  while ((head = headRe.exec(src)) !== null) {
    const blockName = head[1];
    if (blockName === undefined) continue;
    // Re-include the opening brace for the balanced reader.
    const open = head.index + (head[0] ?? '').length - 1;
    const grp = readBalanced(src.slice(open), '{', '}');
    if (!grp) continue;
    const leaves: Record<string, string> = {};
    collectObjectLeaves(grp.inner, leaves, '');
    const bucketKey = blockToBucket[blockName];
    if (bucketKey === undefined) continue;
    const bucket = tokens[bucketKey];
    for (const [k, val] of Object.entries(leaves)) bucket[k] = val;
  }
}

/** Read the project's style + tailwind files and assemble its design tokens. */
async function extractDesignTokens(
  projectPath: string,
  files: ReadonlyArray<{ path: string; ext: string }>,
  maxStyleFiles: number,
  warnings: string[]
): Promise<DesignTokens> {
  const tokens = emptyDesignTokens();
  const targets = files
    .filter((f) => STYLE_EXTS.has(f.ext) || TAILWIND_CONFIG_RE.test(baseName(f.path)))
    .slice(0, maxStyleFiles);

  for (const file of targets) {
    const text = await readTextSafe(join(projectPath, file.path));
    if (text === null) {
      warnings.push(`Could not read style file ${file.path} for design tokens`);
      continue;
    }
    if (text.length > MAX_STYLE_BYTES) continue; // skip large generated CSS, not fatal
    const before = countTokens(tokens);
    if (TAILWIND_CONFIG_RE.test(baseName(file.path))) extractTailwindTokens(text, tokens);
    else extractCssTokens(text, tokens);
    if (countTokens(tokens) > before && !tokens.sources.includes(file.path)) {
      tokens.sources.push(file.path);
    }
  }
  tokens.sources.sort();
  return tokens;
}

/** Distinct token count across the five buckets (cssVariables is supplementary). */
function countTokens(tokens: DesignTokens): number {
  return (
    Object.keys(tokens.colors).length +
    Object.keys(tokens.fonts).length +
    Object.keys(tokens.spacing).length +
    Object.keys(tokens.radii).length +
    Object.keys(tokens.shadows).length
  );
}

// ---------------------------------------------------------------------------
// Immutable inventory
// ---------------------------------------------------------------------------

/** Build the immutable table list, attaching the declaring migration file when known. */
function buildImmutableTables(
  schema: SchemaSnapshot,
  codebase: CodebaseSnapshot
): ImmutableTable[] {
  // Map table name → migration file from the codebase reader's SQL catalog.
  const fileByTable = new Map<string, string>();
  for (const t of codebase.schema) if (!fileByTable.has(t.name)) fileByTable.set(t.name, t.file);

  return schema.tables
    .map((t) => ({
      name: t.name,
      schema: t.schema,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable })),
      primaryKey: [...t.primaryKey],
      rlsEnabled: t.rlsEnabled,
      file: fileByTable.get(t.name) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Build the immutable route list from the codebase snapshot. */
function buildImmutableRoutes(codebase: CodebaseSnapshot): ImmutableRoute[] {
  return codebase.routes
    .map((r) => ({ route: r.route, router: r.router, kind: r.kind, dynamic: r.dynamic, file: r.file }))
    .sort((a, b) => a.route.localeCompare(b.route) || a.file.localeCompare(b.file));
}

/** Build the immutable component surface (exported top-level symbols only). */
function buildImmutableComponents(codebase: CodebaseSnapshot): ImmutableComponent[] {
  return codebase.components
    .filter((s) => s.exported)
    .map((s) => ({ name: s.name, kind: s.kind, file: s.file, line: s.line, signature: s.signature }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// ---------------------------------------------------------------------------
// Extension points
// ---------------------------------------------------------------------------

/** Derive the directories where new code can be added from the directory set. */
function deriveExtensionPoints(dirs: ReadonlySet<string>): ExtensionPoint[] {
  const points: ExtensionPoint[] = [];
  const add = (kind: ExtensionPointKind, path: string, description: string): void => {
    points.push({ kind, path, description });
  };

  for (const d of ROUTE_ROOT_DIRS) if (dirs.has(d)) add('route-root', d, `Add new pages/routes under ${d}/ (existing routes are immutable).`);
  for (const d of API_ROOT_DIRS) if (dirs.has(d)) add('api-root', d, `Add new API route handlers under ${d}/.`);
  for (const d of COMPONENTS_DIRS) if (dirs.has(d)) add('components-dir', d, `Add new UI components under ${d}/.`);
  for (const d of LIB_DIRS) if (dirs.has(d)) add('lib-dir', d, `Add new shared helpers under ${d}/.`);
  for (const d of MIGRATION_DIRS) if (dirs.has(d)) add('migrations-dir', d, `Add new migrations under ${d}/ — new tables/columns only; existing tables are immutable.`);

  return points;
}

// ---------------------------------------------------------------------------
// Flagged-pattern detection (anti-patterns for human review)
// ---------------------------------------------------------------------------

/** Run every flagged-pattern detector over the snapshots. */
function detectFlaggedPatterns(
  schema: SchemaSnapshot,
  codebase: CodebaseSnapshot,
  flat: FlatTree,
  designTokens: DesignTokens
): FlaggedPattern[] {
  const flags: FlaggedPattern[] = [];
  const knownTables = new Set(schema.tables.map((t) => t.name));

  // --- Schema: missing PK, missing RLS on tenant-scoped tables, dangling FKs ---
  for (const table of schema.tables) {
    if (table.primaryKey.length === 0) {
      flags.push({
        id: 'table_no_primary_key',
        severity: 'warning',
        subject: `table ${table.name}`,
        subjectKey: `table:${table.name}`,
        file: null,
        detail: `Table '${table.name}' has no primary key — Phase 1B cannot safely add relationships to it.`,
        governanceRef: 'SCHEMA_REGISTRY.md (every table declares a primary key)',
      });
    }

    const tenantCol = table.columns.find((c) => TENANT_SCOPE_COLUMNS.has(c.name.toLowerCase()));
    if (tenantCol && !table.rlsEnabled) {
      flags.push({
        id: 'table_missing_rls',
        severity: 'critical',
        subject: `table ${table.name}`,
        subjectKey: `table:${table.name}`,
        file: null,
        detail: `Table '${table.name}' has tenant-scoping column '${tenantCol.name}' but row-level security is NOT enabled — company-scoped isolation is unenforced.`,
        governanceRef: 'BEHAVIORAL_CONTRACTS Six Laws Law 1 / seed pattern supabase_rls_blocks',
      });
    }

    for (const fk of table.foreignKeys) {
      if (!knownTables.has(fk.referencesTable)) {
        flags.push({
          id: 'dangling_foreign_key',
          severity: 'warning',
          subject: `table ${table.name}`,
          subjectKey: `table:${table.name}`,
          file: null,
          detail: `Foreign key on '${table.name}' (${fk.columns.join(', ')}) references table '${fk.referencesTable}', which was not found in the extracted schema.`,
          governanceRef: 'SCHEMA_REGISTRY.md (foreign keys reference existing tables)',
        });
      }
    }
  }

  // --- Dashboard HTML served straight from public/ (seeds html_assumed_rendered, vercel_cdn_stale) ---
  for (const file of flat.files) {
    if (file.ext !== 'html') continue;
    if (/(^|\/)public\//.test(file.path)) {
      flags.push({
        id: 'dashboard_html_in_public',
        severity: 'critical',
        subject: file.path,
        subjectKey: `file:${file.path}`,
        file: file.path,
        detail: `HTML file under public/ ('${file.path}') may be served directly and cached stale — dashboards must render via no-cache API routes, not static public/ HTML.`,
        governanceRef: 'CLAUDE.md Iron Law 5/6; seeds html_assumed_rendered, vercel_cdn_stale',
      });
    }
  }

  // --- Mock/placeholder data files under source (Iron Law 8) ---
  for (const file of flat.files) {
    const name = baseName(file.path);
    if (!MOCK_NAME_RE.test(name)) continue;
    // Only flag inside likely production source trees, not test/spec dirs.
    if (/(^|\/)(tests?|__tests__|e2e|spec|specs|\.storybook)\//.test(file.path)) continue;
    if (!/\.(?:tsx?|jsx?|mjs|cjs|json)$/i.test(name)) continue;
    flags.push({
      id: 'mock_in_source',
      severity: 'warning',
      subject: file.path,
      subjectKey: `file:${file.path}`,
      file: file.path,
      detail: `File '${file.path}' looks like mock/placeholder data in the source tree — production code must use real API calls to real tables.`,
      governanceRef: 'CLAUDE.md Iron Law 8 (no mocks/placeholder data in production)',
    });
  }

  // --- Duplicate route definitions (two files resolving to the same URL) ---
  const routeOwners = new Map<string, string[]>();
  for (const r of codebase.routes) {
    if (r.kind !== 'page' && r.kind !== 'api') continue;
    const key = `${r.router}:${r.route}`;
    const owners = routeOwners.get(key) ?? [];
    owners.push(r.file);
    routeOwners.set(key, owners);
  }
  for (const [key, owners] of routeOwners) {
    if (owners.length > 1) {
      const route = key.slice(key.indexOf(':') + 1);
      flags.push({
        id: 'duplicate_route',
        severity: 'warning',
        subject: `route ${route}`,
        subjectKey: `route:${key}`,
        file: owners[0] ?? null,
        detail: `Route '${route}' is defined by ${owners.length} files (${owners.join(', ')}) — ambiguous resolution.`,
        governanceRef: 'BEHAVIORAL_CONTRACTS Contract 18 (deterministic wiring)',
      });
    }
  }

  // --- No design tokens despite a styled frontend (brand drift risk) ---
  const hasFrontend = codebase.routes.length > 0 || flat.files.some((f) => f.ext === 'tsx' || f.ext === 'jsx');
  if (hasFrontend && countTokens(designTokens) === 0) {
    flags.push({
      id: 'no_design_tokens',
      severity: 'warning',
      subject: 'design tokens',
      subjectKey: 'design-tokens',
      file: null,
      detail: 'A frontend exists but no design tokens (CSS custom properties or tailwind theme) were found — new UI has no brand constraints to inherit.',
      governanceRef: 'SCHEMA_REGISTRY brand_identities / BEHAVIORAL_CONTRACTS Contract 18',
    });
  }

  return flags.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id));
}

/** Numeric rank so `critical` sorts before `warning`. */
function severityRank(s: FlagSeverity): number {
  return s === 'critical' ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Flat classification (immutable / extensible / flagged)
// ---------------------------------------------------------------------------

/**
 * Produce the flat "classify each component" list. Existing assets are `immutable`
 * unless a flag references them (then `flagged`); extension points are `extensible`;
 * flagged files contribute their own `flagged` rows.
 */
function buildClassifications(
  tables: readonly ImmutableTable[],
  routes: readonly ImmutableRoute[],
  components: readonly ImmutableComponent[],
  extensionPoints: readonly ExtensionPoint[],
  flags: readonly FlaggedPattern[]
): ClassifiedComponent[] {
  const flaggedKeys = new Set(flags.map((f) => f.subjectKey));
  const flaggedFiles = new Set(flags.filter((f) => f.file !== null).map((f) => f.file as string));
  const out: ClassifiedComponent[] = [];

  for (const t of tables) {
    const key = `table:${t.name}`;
    const flagged = flaggedKeys.has(key);
    out.push({
      kind: 'table',
      name: t.name,
      file: t.file,
      classification: flagged ? 'flagged' : 'immutable',
      reason: flagged ? 'Existing table with a flagged issue (see flaggedPatterns).' : 'Existing table — schema is fixed; add new tables/columns only.',
    });
  }

  for (const r of routes) {
    const key = `route:${r.router}:${r.route}`;
    const flagged = flaggedKeys.has(key);
    out.push({
      kind: 'route',
      name: r.route,
      file: r.file,
      classification: flagged ? 'flagged' : 'immutable',
      reason: flagged ? 'Existing route with a flagged issue (see flaggedPatterns).' : 'Existing route — URL surface is fixed.',
    });
  }

  for (const c of components) {
    const flagged = flaggedFiles.has(c.file);
    out.push({
      kind: 'component',
      name: c.name,
      file: c.file,
      classification: flagged ? 'flagged' : 'immutable',
      reason: flagged ? 'Exported symbol in a flagged file (see flaggedPatterns).' : 'Existing exported symbol — public surface is fixed.',
    });
  }

  for (const p of extensionPoints) {
    out.push({
      kind: 'directory',
      name: p.path,
      file: p.path,
      classification: 'extensible',
      reason: p.description,
    });
  }

  // Flagged files that are not already represented as a component/table/route row.
  const represented = new Set(out.map((c) => `${c.kind}:${c.file}:${c.name}`));
  for (const f of flags) {
    if (f.file === null || !f.file.includes('.')) continue;
    const name = baseName(f.file);
    const probe = `file:${f.file}:${name}`;
    if (represented.has(probe)) continue;
    represented.add(probe);
    if (out.some((c) => c.file === f.file)) continue; // already classified via component row
    out.push({
      kind: 'file',
      name,
      file: f.file,
      classification: 'flagged',
      reason: f.detail,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Markdown rendering (operator-facing; no file is written by Phase 1C)
// ---------------------------------------------------------------------------

/** Render a human-readable summary of a {@link ConstraintManifest}. */
export function renderConstraintManifestMarkdown(manifest: ConstraintManifest): string {
  const lines: string[] = [];
  const m = manifest;
  lines.push('# CONSTRAINT_MANIFEST — Phase 1C Current State Ingestion');
  lines.push('');
  lines.push(`- **Project:** ${m.projectPath}`);
  lines.push(`- **Generated:** ${m.generatedAt}`);
  lines.push(`- **Partial build:** ${m.partialBuild ? 'yes' : 'no (greenfield — nothing to constrain)'}`);
  lines.push(
    `- **Classified:** ${m.summary.immutableCount} immutable · ${m.summary.extensibleCount} extensible · ${m.summary.flaggedCount} flagged`
  );
  lines.push('');

  lines.push(`## Immutable Schema Tables (${m.immutable.schemaTables.length})`);
  for (const t of m.immutable.schemaTables) {
    lines.push(`- \`${t.name}\` — ${t.columns.length} cols, PK [${t.primaryKey.join(', ') || '—'}], RLS ${t.rlsEnabled ? 'on' : 'off'}`);
  }
  lines.push('');

  lines.push(`## Immutable Routes (${m.immutable.routes.length})`);
  for (const r of m.immutable.routes) lines.push(`- \`${r.route}\` (${r.router}/${r.kind}) — ${r.file}`);
  lines.push('');

  lines.push(`## Immutable Components (${m.immutable.components.length} exported)`);
  lines.push('');

  lines.push(`## Design Tokens (${m.summary.totalDesignTokens})`);
  lines.push(
    `- colors ${Object.keys(m.immutable.designTokens.colors).length} · fonts ${Object.keys(m.immutable.designTokens.fonts).length} · spacing ${Object.keys(m.immutable.designTokens.spacing).length} · radii ${Object.keys(m.immutable.designTokens.radii).length} · shadows ${Object.keys(m.immutable.designTokens.shadows).length}`
  );
  if (m.immutable.designTokens.sources.length > 0) lines.push(`- sources: ${m.immutable.designTokens.sources.join(', ')}`);
  lines.push('');

  lines.push(`## Extension Points (${m.extensionPoints.length})`);
  for (const p of m.extensionPoints) lines.push(`- \`${p.path}\` — ${p.description}`);
  lines.push('');

  lines.push(`## Flagged Patterns (${m.flaggedPatterns.length})`);
  for (const f of m.flaggedPatterns) {
    lines.push(`- ${f.severity === 'critical' ? '❌' : '⚠️'} **${f.id}** (${f.subject}) — ${f.detail} [${f.governanceRef}]`);
  }
  lines.push('');

  if (m.warnings.length > 0) {
    lines.push('## Warnings');
    for (const w of m.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 1C ingestion against `projectPath`, producing a {@link ConstraintManifest}.
 *
 * Always resolves (never rejects). For an empty/greenfield directory the manifest's
 * immutable sets are empty and `partialBuild` is false; the caller (Phase 1B) then
 * designs from scratch. When a live `sql`/`supabase` connection is supplied it is
 * forwarded to the Schema Extractor so the manifest reflects real database state.
 */
export async function runPhase1cIngest(
  projectPath: string,
  options: Phase1cOptions = {}
): Promise<ConstraintManifest> {
  const log = options.log ?? logLine('phase1c');
  const maxStyleFiles = options.maxStyleFiles ?? 200;
  const warnings: string[] = [];

  // 1. Run the Codebase Reader ----------------------------------------------
  log(`reading codebase at ${projectPath}`);
  const readerOptions: CodebaseReaderOptions = {};
  if (options.ignoreDirs) readerOptions.ignoreDirs = options.ignoreDirs;
  const codebase = await readCodebase(projectPath, readerOptions);
  log(
    `codebase: ${codebase.stats.totalFiles} files, ${codebase.components.length} symbols, ` +
      `${codebase.routes.length} routes, ${codebase.schema.length} sql tables`
  );

  // 2. Run the Schema Extractor (migrations + optional live DB) --------------
  log('extracting schema');
  const schemaOptions: SchemaExtractorOptions = { projectPath };
  if (options.sql) schemaOptions.sql = options.sql;
  if (options.supabase) schemaOptions.supabase = options.supabase;
  const schema = await extractSchema(schemaOptions);
  warnings.push(...schema.warnings);
  log(`schema: ${schema.tables.length} tables (source=${schema.source}), ${schema.rlsPolicies.length} RLS policies`);

  // 3. Flatten the tree + extract design tokens -----------------------------
  const flat = flattenTree(codebase.fileTree);
  const designTokens = await extractDesignTokens(projectPath, flat.files, maxStyleFiles, warnings);
  log(`design tokens: ${countTokens(designTokens)} across ${designTokens.sources.length} file(s)`);

  // 4. Build the immutable inventory ----------------------------------------
  const schemaTables = buildImmutableTables(schema, codebase);
  const routes = buildImmutableRoutes(codebase);
  const components = buildImmutableComponents(codebase);

  // 5. Extension points + flagged patterns ----------------------------------
  const extensionPoints = deriveExtensionPoints(flat.dirs);
  const flaggedPatterns = detectFlaggedPatterns(schema, codebase, flat, designTokens);
  log(`extension points: ${extensionPoints.length}; flagged patterns: ${flaggedPatterns.length}`);

  // 6. Flat per-component classification -------------------------------------
  const classifications = buildClassifications(
    schemaTables,
    routes,
    components,
    extensionPoints,
    flaggedPatterns
  );

  const immutableCount = classifications.filter((c) => c.classification === 'immutable').length;
  const extensibleCount = classifications.filter((c) => c.classification === 'extensible').length;
  const partialBuild = codebase.stats.sourceFiles > 0 || schema.tables.length > 0;

  const manifest: ConstraintManifest = {
    projectPath,
    generatedAt: nowIso(),
    partialBuild,
    immutable: { schemaTables, routes, components, designTokens },
    extensionPoints,
    flaggedPatterns,
    classifications,
    summary: {
      immutableCount,
      extensibleCount,
      flaggedCount: flaggedPatterns.length,
      totalTables: schema.tables.length,
      totalRoutes: codebase.routes.length,
      totalComponents: codebase.components.length,
      totalDesignTokens: countTokens(designTokens),
    },
    warnings,
    codebase,
    schema,
  };

  log(
    partialBuild
      ? `Phase 1C: partial build — ${immutableCount} immutable, ${extensibleCount} extensible, ${flaggedPatterns.length} flagged`
      : 'Phase 1C: no prior work found — greenfield build (immutable sets empty)'
  );
  return manifest;
}

export default runPhase1cIngest;
