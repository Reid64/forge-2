/**
 * FORGE 2.0 — Architecture Guard (`src/tools/architecture-guard.ts`).
 *
 * After EVERY Phase 3 prompt, statically analyze the WHOLE target codebase for architectural
 * anti-patterns — the structural problems that compile cleanly and pass tests but rot a project over
 * time. Where the Security Scanner proves the code is *safe* and the Sentinel's tsc/build prove it
 * *compiles*, this proves the code is *well-structured*. It detects nine anti-patterns:
 *
 *   1. CIRCULAR DEPENDENCIES — parse every `import`/`export … from`/`import()`/`require()`, RESOLVE
 *      relative specifiers to internal files, build a module dependency graph, and DFS it for cycles
 *      (`findCycles`). A cycle is the one definitively architectural breakage here → HIGH severity.
 *   2. GOD COMPONENTS — any source file over `godComponentMaxLines` (default 500) lines.
 *   3. DUPLICATE LOGIC — the same normalized N-line code block recurring across ≥2 files.
 *   4. N+1 QUERY PATTERNS — a database call `await`ed inside a loop in an API route (should be a
 *      single set-based JOIN / `WHERE … IN (…)`). HIGH severity (a real perf/correctness bug).
 *   5. MISSING ERROR BOUNDARIES — a React component tree with no error boundary / app-router
 *      `error.tsx` anywhere (an uncaught render error blanks the whole UI).
 *   6. HARDCODED VALUES — URLs / connection strings that belong in environment variables.
 *   7. INCONSISTENT NAMING — a file whose case style breaks its directory's dominant convention.
 *   8. DEAD CODE — an exported function/class no other module ever imports (and not a framework
 *      entry point).
 *   9. TYPESCRIPT STRICT-MODE VIOLATIONS — `as any` / explicit `: any` / `@ts-ignore` / `@ts-nocheck`
 *      that defeat the strict checker the BLUEPRINT mandates.
 *
 * OUTPUT: an {@link ArchitectureReport} `{ passed, blocked, violations, counts, cycles,
 * dependencyGraph, … }`. Each {@link ArchitectureViolation} carries an exact `file:line`, a `message`,
 * and an `autoFix` suggestion. Violations are graded HIGH / MEDIUM / LOW; **HIGH-severity violations
 * BLOCK the build** (`blocked = high > 0`, `passed = !blocked`) — medium/low are surfaced but
 * non-blocking, mirroring the Security Scanner / Accessibility Auditor. By default only circular
 * dependencies and N+1 query patterns are HIGH; every type's severity is configurable via
 * `severityOverrides` so an operator can escalate (e.g. block on god components). Results are stored
 * in Build Memory (`production_telemetry`, guarded — Contract 4).
 *
 * HOUSE STYLE (matches `security-scanner`, `accessibility-auditor`, `seo-validator`, `phase4-sentinel`):
 * NON-FATAL and never throws, never fabricates a finding. READ-ONLY (Iron Law 1 — reads source, writes
 * only a Build-Memory summary row; never touches the target filesystem or governance). Every external
 * collaborator (the filesystem walker, the Build-Memory writer, the clock) is injectable, so the guard
 * unit-tests with no disk and no database. ZERO new npm dependency — pure string/graph analysis. An
 * unwalkable / empty project yields zero violations, never a false block.
 */

import { basename, isAbsolute, join, posix, relative } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';

import { BuildMemory, nowIso } from '../memory/index.js';
import { logLine } from './forge-logger.js';
import type { JsonObject, TelemetryEventType, TelemetrySeverity } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public contract — severities, types, violations
// ---------------------------------------------------------------------------

/** Violation severity. `high` blocks the build; `medium`/`low` are surfaced but non-blocking. */
export type ArchitectureSeverity = 'high' | 'medium' | 'low';

/** The nine architectural anti-pattern categories. */
export type ArchitectureViolationType =
  | 'circular_dependency'
  | 'god_component'
  | 'duplicate_logic'
  | 'n_plus_one_query'
  | 'missing_error_boundary'
  | 'hardcoded_value'
  | 'inconsistent_naming'
  | 'dead_code'
  | 'strict_mode_violation';

/** A single architectural violation, with an exact location and an auto-fix suggestion. */
export interface ArchitectureViolation {
  /** Which anti-pattern this is. */
  type: ArchitectureViolationType;
  /** Severity (high blocks the build). */
  severity: ArchitectureSeverity;
  /** Stable rule id (e.g. `arch.circular_dependency`). */
  rule: string;
  /** Primary offending file (project-relative, posix). */
  file: string;
  /** 1-based line, or 0 when the finding is file/graph-level (not a single line). */
  line: number;
  /** One-line human-readable summary. */
  message: string;
  /** Fuller context (the cycle path, the duplicate locations, etc.). */
  detail: string;
  /** Concrete suggested fix. */
  autoFix: string;
  /** Other files involved (cycles / duplicates), when applicable. */
  relatedFiles?: string[];
}

/** Count of violations at each severity. */
export interface ArchitectureSeverityCounts {
  high: number;
  medium: number;
  low: number;
}

/** The full architecture report (the guard's output contract). */
export interface ArchitectureReport {
  /** False iff at least one HIGH-severity violation exists (i.e. `!blocked`). */
  passed: boolean;
  /** True iff ≥1 HIGH-severity violation — the build is blocked. */
  blocked: boolean;
  /** Every violation, sorted most-severe-first. */
  violations: ArchitectureViolation[];
  /** Per-severity rollup. */
  counts: ArchitectureSeverityCounts;
  /** Number of source files actually parsed. */
  scannedFiles: number;
  /** The internal module dependency graph (relPath → [relPath]) — useful for visualization. */
  dependencyGraph: Record<string, string[]>;
  /** The dependency cycles found (each a list of relPaths forming the loop). */
  cycles: string[][];
  /** Full markdown report. */
  report: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Public contract — input + injectable collaborators
// ---------------------------------------------------------------------------

/** What to analyze. */
export interface ArchitectureGuardInput {
  /** Target project root. */
  projectPath: string;
  /** Project name for the Build-Memory record. Default: basename of `projectPath`. */
  projectName?: string;
  /** Optional `build_runs.id` to associate the stored result with. */
  buildRunId?: string;
  /**
   * Explicit file set to analyze (absolute or project-relative). Default: a full source walk. NOTE:
   * cycle/dead-code detection needs the WHOLE graph, so a full walk is normal even after one prompt —
   * `files` is mainly a test seam.
   */
  files?: string[];
  /** Changed files from the prompt that just ran (context only — the guard always analyzes the whole project). */
  changedFiles?: string[];
}

/** A guarded filesystem the guard reads through (injectable for tests). */
export interface GuardFs {
  /** List candidate source files under `root` (absolute paths). */
  listFiles(root: string): Promise<string[]>;
  /** Read a file as UTF-8, or null if unreadable. */
  readFile(absPath: string): Promise<string | null>;
}

/** The summary row persisted to Build Memory. */
export interface ArchStoredRecord {
  projectName: string;
  buildRunId: string | null;
  blocked: boolean;
  counts: ArchitectureSeverityCounts;
  totalViolations: number;
  scannedFiles: number;
  cycleCount: number;
  /** violation count keyed by type. */
  byType: Record<string, number>;
  generatedAt: string;
}

/** Persist the run summary to Build Memory (guarded, non-fatal). */
export type ArchResultStore = (record: ArchStoredRecord, log: (m: string) => void) => Promise<void>;

/** Options controlling an architecture-guard run. */
export interface ArchitectureGuardOptions {
  /** Override the filesystem (tests). Default: a guarded source walk of the project. */
  fs?: GuardFs;
  /** Line threshold above which a file is a "god component". Default 500. */
  godComponentMaxLines?: number;
  /** Minimum identical normalized lines to count as duplicated logic. Default 6. */
  duplicateMinBlockLines?: number;
  /** Minimum DISTINCT files a block must appear in to flag duplication. Default 2. */
  duplicateMinOccurrences?: number;
  /** Directory names to skip while walking. Default {@link DEFAULT_IGNORE_DIRS}. */
  ignoreDirs?: readonly string[];
  /** Per-type severity overrides (e.g. `{ god_component: 'high' }` to block on them). */
  severityOverrides?: Partial<Record<ArchitectureViolationType, ArchitectureSeverity>>;
  /** Skip files larger than this many bytes. Default 2_000_000. */
  maxFileBytes?: number;
  /** Override the Build-Memory writer (tests). Default: a guarded `production_telemetry` write. */
  storeResult?: ArchResultStore;
  /** Clock (tests). Default {@link nowIso}. */
  now?: () => string;
  /** Progress reporter. Default logs with a `[FORGE:arch]` prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directories never walked. */
export const DEFAULT_IGNORE_DIRS: readonly string[] = [
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.forge', '.turbo', '.vercel',
];

const SOURCE_EXTS: ReadonlySet<string> = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);

const DEFAULT_MAX_FILE_BYTES = 2_000_000;
const DEFAULT_GOD_MAX_LINES = 500;
const DEFAULT_DUP_MIN_BLOCK = 6;
const DEFAULT_DUP_MIN_OCC = 2;

/** Default severity per anti-pattern. Only circular deps + N+1 block the build by default. */
export const DEFAULT_SEVERITY: Record<ArchitectureViolationType, ArchitectureSeverity> = {
  circular_dependency: 'high',
  n_plus_one_query: 'high',
  god_component: 'medium',
  missing_error_boundary: 'medium',
  hardcoded_value: 'medium',
  strict_mode_violation: 'medium',
  duplicate_logic: 'low',
  inconsistent_naming: 'low',
  dead_code: 'low',
};

const SEVERITY_RANK: Record<ArchitectureSeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Exported names that are framework entry points (Next.js route handlers, metadata, etc.) — these are
 * "imported" by the framework at runtime, not by source, so they are NEVER dead code.
 */
const FRAMEWORK_EXPORT_NAMES: ReadonlySet<string> = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD',
  'metadata', 'generateMetadata', 'generateStaticParams', 'generateViewport', 'viewport',
  'loader', 'action', 'middleware', 'config', 'default', 'register',
  'runtime', 'dynamic', 'revalidate', 'fetchCache', 'preferredRegion',
]);

/** Cap on findings per per-file detector (keeps a pathological file from flooding the report). */
const PER_DETECTOR_CAP = 50;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function relPath(projectPath: string, absPath: string): string {
  const rel = relative(projectPath, absPath);
  return toPosix(rel === '' ? absPath : rel);
}

function clip(text: string, max = 160): string {
  const t = (text ?? '').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** 1-based line number for a character index into `content`. */
function lineOfIndex(content: string, index: number): number {
  let line = 1;
  const end = Math.min(index, content.length);
  for (let i = 0; i < end; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// File parsing (imports + exports)
// ---------------------------------------------------------------------------

/** One import/require/re-export reference in a file. */
export interface ImportRef {
  /** The raw module specifier (e.g. `./foo.js`, `react`). */
  specifier: string;
  /** 1-based line of the statement. */
  line: number;
  /** Imported original names (before any `as` alias). `['*']` for `export *`. */
  names: string[];
  /** True for `import * as ns` / `export *` (namespace use — treats the target's exports as all used). */
  namespace: boolean;
}

/** One top-level export declaration in a file. */
export interface ExportRef {
  name: string;
  line: number;
  kind: 'function' | 'class' | 'const' | 'other';
  isDefault: boolean;
}

/** A parsed source file. */
export interface ParsedFile {
  rel: string;
  content: string;
  lines: string[];
  lineCount: number;
  ext: string;
  imports: ImportRef[];
  exports: ExportRef[];
}

/** Parse the named identifiers out of a `{ a, b as c }` list. */
export function parseNamedList(inner: string): string[] {
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== 'type')
    .map((tok) => {
      const cleaned = tok.replace(/^type\s+/, '');
      const asM = /^(\w+)\s+as\s+\w+/.exec(cleaned);
      if (asM && asM[1]) return asM[1];
      const idM = /^(\w+)/.exec(cleaned);
      return idM && idM[1] ? idM[1] : '';
    })
    .filter((s) => s !== '');
}

/** Parse the clause between `import` and `from` (default / namespace / named). */
function parseImportClause(clause: string): { names: string[]; namespace: boolean } {
  const c = clause.trim();
  const names: string[] = [];
  let namespace = false;
  if (/\*\s+as\s+\w+/.test(c)) namespace = true;
  const braceM = /\{([\s\S]*?)\}/.exec(c);
  if (braceM) names.push(...parseNamedList(braceM[1] ?? ''));
  // Default import: a leading identifier (not `{` and not `*`).
  if (!c.startsWith('{') && !c.startsWith('*')) {
    const defM = /^(\w+)/.exec(c);
    if (defM && defM[1]) names.push(defM[1]);
  }
  return { names, namespace };
}

/** Parse every import/require/re-export in a file's content. */
export function parseImports(content: string): ImportRef[] {
  const refs: ImportRef[] = [];
  let m: RegExpExecArray | null;

  // import <clause> from '<spec>'
  const fromRe = /import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  while ((m = fromRe.exec(content)) !== null) {
    const { names, namespace } = parseImportClause(m[1] ?? '');
    refs.push({ specifier: m[2] ?? '', line: lineOfIndex(content, m.index), names, namespace });
  }

  // side-effect: import '<spec>'
  const sideRe = /import\s*['"]([^'"]+)['"]/g;
  while ((m = sideRe.exec(content)) !== null) {
    refs.push({ specifier: m[1] ?? '', line: lineOfIndex(content, m.index), names: [], namespace: false });
  }

  // re-export: export * [as ns] from '<spec>'  |  export { … } from '<spec>'
  const reexpRe = /export\s+(\*(?:\s+as\s+\w+)?|\{[\s\S]*?\})\s+from\s*['"]([^'"]+)['"]/g;
  while ((m = reexpRe.exec(content)) !== null) {
    const clause = (m[1] ?? '').trim();
    const star = clause.startsWith('*');
    const braceM = /\{([\s\S]*?)\}/.exec(clause);
    const names = star ? ['*'] : braceM ? parseNamedList(braceM[1] ?? '') : [];
    refs.push({ specifier: m[2] ?? '', line: lineOfIndex(content, m.index), names, namespace: star });
  }

  // dynamic import('<spec>') / require('<spec>')
  const dynRe = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(content)) !== null) {
    refs.push({ specifier: m[1] ?? '', line: lineOfIndex(content, m.index), names: [], namespace: false });
  }

  return refs;
}

/** Parse top-level export declarations (functions/classes/const/type) from a file's lines. */
export function parseExports(lines: string[]): ExportRef[] {
  const out: ExportRef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    const ln = i + 1;

    let mm = /^export\s+default\s+(?:async\s+)?function\s+(\w+)/.exec(line);
    if (mm && mm[1]) { out.push({ name: mm[1], line: ln, kind: 'function', isDefault: true }); continue; }
    if (/^export\s+default\b/.test(line)) { out.push({ name: 'default', line: ln, kind: 'other', isDefault: true }); continue; }

    mm = /^export\s+(?:async\s+)?function\s+(\w+)/.exec(line);
    if (mm && mm[1]) { out.push({ name: mm[1], line: ln, kind: 'function', isDefault: false }); continue; }

    mm = /^export\s+(?:abstract\s+)?class\s+(\w+)/.exec(line);
    if (mm && mm[1]) { out.push({ name: mm[1], line: ln, kind: 'class', isDefault: false }); continue; }

    // export const x = (…) => …  /  export const x = async (…) => …  → an arrow function
    mm = /^export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/.exec(line);
    if (mm && mm[1]) { out.push({ name: mm[1], line: ln, kind: 'function', isDefault: false }); continue; }

    mm = /^export\s+const\s+(\w+)/.exec(line);
    if (mm && mm[1]) { out.push({ name: mm[1], line: ln, kind: 'const', isDefault: false }); continue; }

    mm = /^export\s+(?:type|interface|enum)\s+(\w+)/.exec(line);
    if (mm && mm[1]) { out.push({ name: mm[1], line: ln, kind: 'other', isDefault: false }); continue; }
  }
  return out;
}

function parseFile(rel: string, content: string): ParsedFile {
  const lines = content.split(/\r?\n/);
  return {
    rel,
    content,
    lines,
    lineCount: lines.length,
    ext: extensionOf(rel),
    imports: parseImports(content),
    exports: parseExports(lines),
  };
}

// ---------------------------------------------------------------------------
// Dependency graph + cycle detection
// ---------------------------------------------------------------------------

/** Resolve a relative specifier to an internal file (matched against `relSet`), or null. */
export function resolveSpecifier(fromRel: string, spec: string, relSet: ReadonlySet<string>): string | null {
  if (!spec.startsWith('.')) return null; // external package
  const dir = posix.dirname(toPosix(fromRel));
  const joined = posix.normalize(posix.join(dir, spec));
  const noExt = joined.replace(/\.(js|jsx|mjs|cjs|ts|tsx)$/, '');
  for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']) {
    const cand = `${noExt}.${ext}`;
    if (relSet.has(cand)) return cand;
  }
  for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']) {
    const cand = `${noExt}/index.${ext}`;
    if (relSet.has(cand)) return cand;
  }
  return null;
}

/** Build the internal module dependency graph (relPath → resolved internal imports). */
export function buildDependencyGraph(
  files: readonly ParsedFile[],
  relSet: ReadonlySet<string>
): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const f of files) {
    const deps = new Set<string>();
    for (const imp of f.imports) {
      const target = resolveSpecifier(f.rel, imp.specifier, relSet);
      if (target && target !== f.rel) deps.add(target);
    }
    graph.set(f.rel, [...deps]);
  }
  return graph;
}

/** A stable key for a cycle (rotation-invariant) so the same loop is reported once. */
function cycleKey(cycle: readonly string[]): string {
  if (cycle.length === 0) return '';
  let min = 0;
  for (let i = 1; i < cycle.length; i++) {
    if ((cycle[i] ?? '') < (cycle[min] ?? '')) min = i;
  }
  return [...cycle.slice(min), ...cycle.slice(0, min)].join('>');
}

/** Find dependency cycles via DFS back-edge detection. Returns each distinct cycle once. */
export function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const dfs = (node: string): void => {
    visited.add(node);
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (onStack.has(next)) {
        const idx = stack.indexOf(next);
        if (idx >= 0) {
          const cyc = stack.slice(idx);
          const key = cycleKey(cyc);
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push([...cyc]);
          }
        }
      } else if (!visited.has(next)) {
        dfs(next);
      }
    }
    stack.pop();
    onStack.delete(node);
  };

  for (const node of graph.keys()) {
    if (!visited.has(node)) dfs(node);
  }
  return cycles;
}

function cycleViolation(cycle: string[], severity: ArchitectureSeverity): ArchitectureViolation {
  const head = cycle[0] ?? '';
  const tail = cycle[cycle.length - 1] ?? '';
  const path = [...cycle, head].join(' → ');
  return {
    type: 'circular_dependency',
    severity,
    rule: 'arch.circular_dependency',
    file: head,
    line: 0,
    message: `Circular dependency among ${cycle.length} module(s): ${path}`,
    detail:
      `These modules import each other in a cycle: ${path}. Cyclic imports cause fragile module ` +
      `init order, undefined-at-import-time bugs, untestable coupling, and bundler hazards.`,
    autoFix:
      `Break the cycle: extract the shared types/logic both modules need into a separate leaf module ` +
      `they each import, or invert one edge (pass the value in / dependency injection). The simplest ` +
      `cut is to remove the import in "${tail}" that closes the loop back to "${head}".`,
    relatedFiles: [...cycle],
  };
}

// ---------------------------------------------------------------------------
// Detector: god components / oversized modules
// ---------------------------------------------------------------------------

function detectGodComponent(f: ParsedFile, maxLines: number, severity: ArchitectureSeverity): ArchitectureViolation[] {
  if (f.lineCount <= maxLines) return [];
  const isComponent = f.ext === 'tsx' || f.ext === 'jsx';
  return [{
    type: 'god_component',
    severity,
    rule: isComponent ? 'arch.god_component' : 'arch.god_module',
    file: f.rel,
    line: 1,
    message: `${isComponent ? 'God component' : 'Oversized module'} — ${f.lineCount} lines (> ${maxLines})`,
    detail:
      `${f.rel} has ${f.lineCount} lines, exceeding the ${maxLines}-line threshold. Large ` +
      `${isComponent ? 'components' : 'modules'} concentrate too many responsibilities, are hard to ` +
      `test, and slow every review of the file.`,
    autoFix: isComponent
      ? `Split it: extract sub-views into their own components, stateful logic into custom hooks (use…), ` +
        `and pure helpers into sibling files; keep each component focused on one responsibility.`
      : `Split this module by responsibility into smaller single-concern files and re-export from a barrel if needed.`,
  }];
}

// ---------------------------------------------------------------------------
// Detector: N+1 query patterns (DB call awaited inside a loop, in API routes)
// ---------------------------------------------------------------------------

/** App-router `route.ts` / `pages/api/*` / `app/api/*` files. */
export function isApiRouteFile(rel: string): boolean {
  const p = toPosix(rel).toLowerCase();
  if (/(^|\/)app\/.*\/route\.(t|j)sx?$/.test(p)) return true;
  if (/(^|\/)pages\/api\//.test(p)) return true;
  if (/(^|\/)app\/api\//.test(p) && /\.(t|j)sx?$/.test(p)) return true;
  return false;
}

const LOOP_OPENER = /\b(for|while)\s*\(|\.(forEach|map|flatMap|filter|reduce)\s*\(/;
const DB_QUERY =
  /\.(from|select|insert|update|delete|upsert|query|execute|rpc|single|maybeSingle|findUnique|findFirst|findMany|findOne|aggregate|count)\s*\(/;

/** Find the line index where the loop body's brace block closes, starting at `start`. */
function bodySpanEnd(lines: string[], start: number): number {
  let depth = 0;
  let started = false;
  for (let j = start; j < lines.length; j++) {
    const l = lines[j] ?? '';
    for (const ch of l) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; }
    }
    if (started && depth <= 0) return j;
    // No brace block within a few lines → a single-expression loop (e.g. `.map(x => q(x))`).
    if (!started && j - start >= 3) return start;
  }
  return started ? lines.length - 1 : start;
}

function detectNPlusOne(f: ParsedFile, severity: ArchitectureSeverity): ArchitectureViolation[] {
  if (!isApiRouteFile(f.rel)) return [];
  const out: ArchitectureViolation[] = [];
  const lines = f.lines;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!LOOP_OPENER.test(line)) continue;
    const end = bodySpanEnd(lines, i);
    let queryLine = 0;
    for (let j = i; j <= end && j < lines.length; j++) {
      const bl = lines[j] ?? '';
      if (/\bawait\b/.test(bl) && DB_QUERY.test(bl)) { queryLine = j + 1; break; }
    }
    if (queryLine > 0) {
      out.push({
        type: 'n_plus_one_query',
        severity,
        rule: 'arch.n_plus_one',
        file: f.rel,
        line: i + 1,
        message: 'Possible N+1 query — a database call is awaited inside a loop',
        detail:
          `A query is awaited inside a loop starting at line ${i + 1} (query near line ${queryLine}). ` +
          `One round-trip per iteration scales linearly with the data and dominates latency; a single ` +
          `set-based query is almost always correct.`,
        autoFix:
          `Hoist the query out of the loop: collect the keys first, then fetch all rows in ONE query ` +
          `(e.g. \`.in('id', ids)\` or a JOIN) and join them in memory.`,
      });
      i = end; // skip this loop body to avoid duplicate flags
      if (out.length >= PER_DETECTOR_CAP) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detector: hardcoded values that belong in env vars
// ---------------------------------------------------------------------------

const URL_LITERAL = /['"](https?:\/\/[^'"\s]+)['"]/g;
const CONN_LITERAL = /['"]((?:postgres(?:ql)?|mongodb(?:\+srv)?|rediss?|mysql|amqps?):\/\/[^'"\s]+)['"]/g;
const URL_ALLOWLIST = /localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(?:com|org)|placeholder|\$\{|\{\{|schema\.org|w3\.org/i;

function detectHardcodedValues(f: ParsedFile, severity: ArchitectureSeverity): ArchitectureViolation[] {
  const out: ArchitectureViolation[] = [];
  const lines = f.lines;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (/process\.env|import\.meta\.env/.test(raw)) continue;

    let m: RegExpExecArray | null;
    CONN_LITERAL.lastIndex = 0;
    while ((m = CONN_LITERAL.exec(raw)) !== null) {
      out.push({
        type: 'hardcoded_value', severity, rule: 'arch.hardcoded_connection_string', file: f.rel, line: i + 1,
        message: `Hardcoded connection string (${clip(m[1] ?? '', 60)})`,
        detail: `A database/broker connection string is committed at ${f.rel}:${i + 1}. Endpoints and credentials must not be hardcoded.`,
        autoFix: `Move it to an environment variable (e.g. \`process.env.DATABASE_URL\`) and read it there; never commit infrastructure endpoints.`,
      });
      if (out.length >= PER_DETECTOR_CAP) return out;
    }

    URL_LITERAL.lastIndex = 0;
    while ((m = URL_LITERAL.exec(raw)) !== null) {
      const url = m[1] ?? '';
      if (URL_ALLOWLIST.test(url)) continue;
      out.push({
        type: 'hardcoded_value', severity, rule: 'arch.hardcoded_url', file: f.rel, line: i + 1,
        message: `Hardcoded URL "${clip(url, 80)}"`,
        detail: `A hardcoded URL at ${f.rel}:${i + 1} cannot vary per environment (dev/staging/prod) and is brittle.`,
        autoFix: `Extract the base URL to an environment variable (\`process.env.API_BASE_URL\`, or a \`NEXT_PUBLIC_\`-prefixed one for client use).`,
      });
      if (out.length >= PER_DETECTOR_CAP) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detector: TypeScript strict-mode violations
// ---------------------------------------------------------------------------

function detectStrictModeViolations(f: ParsedFile, severity: ArchitectureSeverity): ArchitectureViolation[] {
  if (f.ext !== 'ts' && f.ext !== 'tsx') return [];
  const out: ArchitectureViolation[] = [];
  const lines = f.lines;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    const ln = i + 1;

    if (/@ts-nocheck/.test(raw)) {
      out.push({
        type: 'strict_mode_violation', severity, rule: 'arch.ts_nocheck', file: f.rel, line: ln,
        message: '`@ts-nocheck` disables type-checking for the entire file',
        detail: `${f.rel}:${ln} turns the type-checker off for the whole file — the strictest possible escape hatch.`,
        autoFix: 'Remove `@ts-nocheck` and fix the underlying type errors; never silence the checker for an entire file.',
      });
      continue;
    }
    if (/@ts-ignore/.test(raw)) {
      out.push({
        type: 'strict_mode_violation', severity, rule: 'arch.ts_ignore', file: f.rel, line: ln,
        message: '`@ts-ignore` suppresses a type error',
        detail: `${f.rel}:${ln} silences the next line's type error without explanation.`,
        autoFix: 'Fix the root type error; if a suppression is truly unavoidable use `@ts-expect-error` WITH a comment explaining why.',
      });
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (/\bas\s+any\b/.test(raw)) {
      out.push({
        type: 'strict_mode_violation', severity, rule: 'arch.as_any', file: f.rel, line: ln,
        message: '`as any` cast defeats type safety',
        detail: `${f.rel}:${ln} casts through \`any\`, erasing all type information past this point.`,
        autoFix: 'Cast to the precise type, or to `unknown` and then narrow with a type guard; avoid `as any`.',
      });
    } else if (/:\s*any\b/.test(raw)) {
      out.push({
        type: 'strict_mode_violation', severity, rule: 'arch.explicit_any', file: f.rel, line: ln,
        message: 'Explicit `any` type annotation',
        detail: `${f.rel}:${ln} annotates a value as \`any\`, opting it out of strict checking.`,
        autoFix: 'Replace `any` with a precise type, a generic parameter, or `unknown` + narrowing.',
      });
    }
    if (out.length >= PER_DETECTOR_CAP) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detector: duplicate logic (identical normalized N-line blocks across files)
// ---------------------------------------------------------------------------

/** Normalize a file to significant lines (strip comments, imports, trivial punctuation). */
export function normalizeForDup(content: string): { text: string; line: number }[] {
  const noBlock = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = noBlock.split(/\r?\n/);
  const out: { text: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    let l = (lines[i] ?? '').replace(/\/\/.*$/, '').trim();
    if (l === '') continue;
    if (/^(import|export)\b/.test(l)) continue;
    if (l.length <= 3) continue;
    if (/^[{}()[\];,]+$/.test(l)) continue;
    l = l.replace(/\s+/g, ' ');
    out.push({ text: l, line: i + 1 });
  }
  return out;
}

function detectDuplicateLogic(
  files: readonly ParsedFile[],
  minBlock: number,
  minOcc: number,
  severity: ArchitectureSeverity
): ArchitectureViolation[] {
  const index = new Map<string, { file: string; line: number }[]>();
  for (const f of files) {
    if (!SOURCE_EXTS.has(f.ext)) continue;
    const norm = normalizeForDup(f.content);
    for (let i = 0; i + minBlock <= norm.length; i++) {
      const block = norm.slice(i, i + minBlock).map((x) => x.text).join('\n');
      const arr = index.get(block) ?? [];
      arr.push({ file: f.rel, line: norm[i]?.line ?? 1 });
      index.set(block, arr);
    }
  }

  const out: ArchitectureViolation[] = [];
  const reported: { file: string; line: number }[] = [];
  for (const locs of index.values()) {
    const distinctFiles = new Set(locs.map((l) => l.file));
    if (distinctFiles.size < minOcc) continue;
    const first = locs[0];
    if (!first) continue;
    // Skip overlapping windows of an already-reported duplicate in the same anchor file.
    if (reported.some((r) => r.file === first.file && Math.abs(r.line - first.line) < minBlock)) continue;
    reported.push(first);
    const where = locs.slice(0, 6).map((l) => `${l.file}:${l.line}`).join(', ');
    out.push({
      type: 'duplicate_logic',
      severity,
      rule: 'arch.duplicate_logic',
      file: first.file,
      line: first.line,
      message: `Duplicated logic — a ${minBlock}-line block recurs across ${distinctFiles.size} files`,
      detail: `An identical ${minBlock}-line block appears at: ${where}. Copies drift out of sync and multiply the bug surface.`,
      autoFix: 'Extract the shared block into a single reusable function/module and import it everywhere it is needed.',
      relatedFiles: [...distinctFiles],
    });
    if (out.length >= 25) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detector: dead code (exported function/class never imported anywhere)
// ---------------------------------------------------------------------------

function isFrameworkEntry(rel: string): boolean {
  const p = toPosix(rel);
  const base = basename(p);
  if (/(^|\/)(app|pages)\//.test(p)) return true;
  if (/^(route|page|layout|loading|error|global-error|not-found|template|default|middleware|sitemap|robots|opengraph-image|icon|apple-icon|manifest|head)\.(t|j)sx?$/.test(base)) return true;
  if (/\.config\.(t|j)s$/.test(base)) return true;
  if (/(^|\/)cli\/index\.(t|j)s$/.test(p)) return true;
  if (base === 'index.ts' || base === 'index.tsx' || base === 'index.js' || base === 'index.jsx') return true;
  if (/\.d\.ts$/.test(base)) return true;
  return false;
}

function detectDeadCode(
  files: readonly ParsedFile[],
  relSet: ReadonlySet<string>,
  severity: ArchitectureSeverity
): ArchitectureViolation[] {
  if (files.length < 2) return []; // a single file in isolation looks entirely "dead"
  const used = new Set<string>();
  const nsTargets = new Set<string>();
  for (const f of files) {
    for (const imp of f.imports) {
      for (const n of imp.names) if (n && n !== '*') used.add(n);
      if (imp.namespace || imp.names.includes('*')) {
        const t = resolveSpecifier(f.rel, imp.specifier, relSet);
        if (t) nsTargets.add(t);
      }
    }
  }

  const out: ArchitectureViolation[] = [];
  for (const f of files) {
    if (isFrameworkEntry(f.rel)) continue;
    if (nsTargets.has(f.rel)) continue; // a `import *` / `export *` consumer treats all exports as used
    for (const ex of f.exports) {
      if (ex.isDefault) continue;
      if (ex.kind !== 'function' && ex.kind !== 'class') continue;
      if (FRAMEWORK_EXPORT_NAMES.has(ex.name)) continue;
      if (used.has(ex.name)) continue;
      out.push({
        type: 'dead_code',
        severity,
        rule: 'arch.dead_code',
        file: f.rel,
        line: ex.line,
        message: `Dead code — exported ${ex.kind} \`${ex.name}\` is never imported anywhere`,
        detail: `\`${ex.name}\` is exported from ${f.rel} but no other module imports it (and it is not a framework entry point).`,
        autoFix: `If it is truly unused, delete \`${ex.name}\` and its tests. If it is internal-only, drop the \`export\` keyword. If it is intended public API, document it.`,
      });
      if (out.length >= PER_DETECTOR_CAP) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detector: inconsistent file naming within a directory
// ---------------------------------------------------------------------------

/** A file-basename case style. `lower`/`other` are treated as ambiguous (not flagged). */
export type CaseStyle = 'kebab' | 'camel' | 'pascal' | 'snake' | 'lower' | 'other';

export function caseStyleOf(base: string): CaseStyle {
  if (/^[a-z][a-z0-9]*$/.test(base)) return 'lower';
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(base)) return 'kebab';
  if (/_/.test(base)) return 'snake';
  if (/^[A-Z][a-zA-Z0-9]*$/.test(base)) return 'pascal';
  if (/^[a-z][a-zA-Z0-9]*$/.test(base) && /[A-Z]/.test(base)) return 'camel';
  return 'other';
}

function detectInconsistentNaming(files: readonly ParsedFile[], severity: ArchitectureSeverity): ArchitectureViolation[] {
  // Group by (directory + component-vs-module) so PascalCase components and kebab utils don't clash.
  const groups = new Map<string, { rel: string; style: CaseStyle }[]>();
  for (const f of files) {
    const base = basename(f.rel).replace(/\.(test|spec|d)\./, '.').replace(/\.[^.]+$/, '');
    if (base === '' || base === 'index') continue;
    const style = caseStyleOf(base);
    if (style === 'lower' || style === 'other') continue; // ambiguous — both kebab and camel accept it
    const comp = f.ext === 'tsx' || f.ext === 'jsx' ? 'C' : 'M';
    const key = `${posix.dirname(toPosix(f.rel))}::${comp}`;
    const arr = groups.get(key) ?? [];
    arr.push({ rel: f.rel, style });
    groups.set(key, arr);
  }

  const out: ArchitectureViolation[] = [];
  for (const items of groups.values()) {
    if (items.length < 3) continue;
    const tally = new Map<CaseStyle, number>();
    for (const it of items) tally.set(it.style, (tally.get(it.style) ?? 0) + 1);
    let dom: CaseStyle = 'other';
    let domN = 0;
    for (const [s, n] of tally) if (n > domN) { dom = s; domN = n; }
    if (domN / items.length < 0.6) continue; // no clear convention to enforce
    for (const it of items) {
      if (it.style === dom) continue;
      out.push({
        type: 'inconsistent_naming',
        severity,
        rule: 'arch.inconsistent_file_naming',
        file: it.rel,
        line: 0,
        message: `Inconsistent file naming — \`${basename(it.rel)}\` is ${it.style}-case but its directory predominantly uses ${dom}-case`,
        detail: `In ${posix.dirname(it.rel)}, ${domN}/${items.length} sibling files use ${dom}-case; \`${basename(it.rel)}\` breaks the convention.`,
        autoFix: `Rename \`${basename(it.rel)}\` to ${dom}-case to match its siblings, and update the imports that reference it.`,
      });
      if (out.length >= 30) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detector: missing error boundary in the React component tree
// ---------------------------------------------------------------------------

const ERROR_BOUNDARY_SIGNAL = /getDerivedStateFromError|componentDidCatch|<ErrorBoundary|ErrorBoundary>|react-error-boundary|errorElement/;

function detectMissingErrorBoundaries(files: readonly ParsedFile[], severity: ArchitectureSeverity): ArchitectureViolation[] {
  const tsx = files.filter((f) => f.ext === 'tsx' || f.ext === 'jsx');
  if (tsx.length === 0) return [];

  const hasComponents = tsx.some(
    (f) =>
      /(^|\/)(page|layout)\.(t|j)sx$/.test(basename(f.rel)) ||
      /export\s+default/.test(f.content) ||
      /return\s*\(?\s*</.test(f.content)
  );
  if (!hasComponents) return [];

  const hasErrorFile = files.some((f) => /^(error|global-error)\.(t|j)sx$/.test(basename(f.rel)));
  const hasBoundary = hasErrorFile || tsx.some((f) => ERROR_BOUNDARY_SIGNAL.test(f.content));
  if (hasBoundary) return [];

  const anchor =
    tsx.find((f) => /layout\.(t|j)sx$/.test(basename(f.rel))) ??
    tsx.find((f) => /page\.(t|j)sx$/.test(basename(f.rel))) ??
    tsx[0];
  if (!anchor) return [];

  return [{
    type: 'missing_error_boundary',
    severity,
    rule: 'arch.missing_error_boundary',
    file: anchor.rel,
    line: 0,
    message: 'No error boundary found anywhere in the React component tree',
    detail:
      `None of the ${tsx.length} component file(s) define an error boundary ` +
      `(getDerivedStateFromError / componentDidCatch / <ErrorBoundary>) and there is no app-router ` +
      `error.tsx. An uncaught render error will blank the entire UI with no fallback.`,
    autoFix:
      `Add an error boundary: in the Next.js App Router create an \`error.tsx\` (and a top-level ` +
      `\`global-error.tsx\`) segment, or wrap the tree in a React error-boundary component ` +
      `(e.g. react-error-boundary's \`<ErrorBoundary fallback={…}>\`).`,
  }];
}

// ---------------------------------------------------------------------------
// Counts, sorting, report
// ---------------------------------------------------------------------------

export function countBySeverity(violations: readonly ArchitectureViolation[]): ArchitectureSeverityCounts {
  const counts: ArchitectureSeverityCounts = { high: 0, medium: 0, low: 0 };
  for (const v of violations) counts[v.severity]++;
  return counts;
}

function sortViolations(violations: readonly ArchitectureViolation[]): ArchitectureViolation[] {
  return [...violations].sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
}

function countByType(violations: readonly ArchitectureViolation[]): Record<string, number> {
  const byType: Record<string, number> = {};
  for (const v of violations) byType[v.type] = (byType[v.type] ?? 0) + 1;
  return byType;
}

/** Render the full markdown report. */
export function renderArchitectureReport(
  violations: readonly ArchitectureViolation[],
  counts: ArchitectureSeverityCounts,
  scannedFiles: number,
  cycles: readonly string[][],
  blocked: boolean
): string {
  const icon: Record<ArchitectureSeverity, string> = { high: '🔴', medium: '🟠', low: '⚪' };
  const lines: string[] = [];

  lines.push('# FORGE Architecture Guard — Report');
  lines.push('');
  lines.push(
    `- **Verdict:** ${
      blocked ? '❌ BLOCKED (high-severity violation)' : counts.medium + counts.low > 0 ? '⚠️ PASS WITH WARNINGS' : '✅ CLEAN'
    }`
  );
  lines.push(`- **Violations:** ${violations.length} (🔴 ${counts.high} high, 🟠 ${counts.medium} medium, ⚪ ${counts.low} low)`);
  lines.push(`- **Files analyzed:** ${scannedFiles}`);
  lines.push(`- **Dependency cycles:** ${cycles.length}`);
  lines.push('');

  if (violations.length === 0) {
    lines.push('No architectural anti-patterns detected. ✅');
    return lines.join('\n');
  }

  lines.push('| Severity | Type | Location | Finding |');
  lines.push('|----------|------|----------|---------|');
  for (const v of violations) {
    const loc = v.line > 0 ? `${v.file}:${v.line}` : v.file;
    lines.push(`| ${icon[v.severity]} ${v.severity} | ${v.type} | \`${loc}\` | ${v.message.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');

  const highs = violations.filter((v) => v.severity === 'high');
  if (highs.length > 0) {
    lines.push('## 🔴 High-severity violations (build blocked)');
    lines.push('');
    for (const v of highs) {
      const loc = v.line > 0 ? `${v.file}:${v.line}` : v.file;
      lines.push(`### ${v.rule} — \`${loc}\``);
      lines.push(`- ${v.detail}`);
      lines.push(`- **Fix:** ${v.autoFix}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Default filesystem walker
// ---------------------------------------------------------------------------

function defaultFs(ignoreDirs: ReadonlySet<string>, maxFileBytes: number): GuardFs {
  async function walk(dir: string, acc: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        await walk(abs, acc);
      } else if (entry.isFile()) {
        if (!SOURCE_EXTS.has(extensionOf(entry.name))) continue;
        try {
          if ((await stat(abs)).size > maxFileBytes) continue;
        } catch {
          continue;
        }
        acc.push(abs);
      }
    }
  }
  return {
    async listFiles(root: string): Promise<string[]> {
      const acc: string[] = [];
      await walk(root, acc);
      return acc;
    },
    async readFile(absPath: string): Promise<string | null> {
      try {
        return await readFile(absPath, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default Build-Memory store (production_telemetry, guarded — Contract 4)
// ---------------------------------------------------------------------------

async function defaultStoreResult(record: ArchStoredRecord, log: (m: string) => void): Promise<void> {
  const eventType: TelemetryEventType = record.blocked ? 'error' : 'usage';
  const severity: TelemetrySeverity = record.blocked ? 'critical' : record.totalViolations > 0 ? 'warning' : 'info';
  const eventData: JsonObject = {
    kind: 'architecture_guard',
    blocked: record.blocked,
    totalViolations: record.totalViolations,
    scannedFiles: record.scannedFiles,
    cycleCount: record.cycleCount,
    counts: { high: record.counts.high, medium: record.counts.medium, low: record.counts.low },
    byType: { ...record.byType },
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
    log(`WARNING: Build Memory store degraded (${describe(error)}) — result not persisted`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point — runArchitectureGuard
// ---------------------------------------------------------------------------

/**
 * Analyze `projectPath` for architectural anti-patterns and return an {@link ArchitectureReport}.
 * NON-FATAL — always resolves, never throws (Iron Law 3); an unwalkable/empty project yields zero
 * violations (never a false block). HIGH-severity violations set `blocked` (the build halts).
 */
export async function runArchitectureGuard(
  input: ArchitectureGuardInput,
  options: ArchitectureGuardOptions = {}
): Promise<ArchitectureReport> {
  const projectPath = input.projectPath;
  const log = options.log ?? logLine('arch');
  const now = options.now ?? nowIso;
  const ignoreDirs = new Set(options.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const fs = options.fs ?? defaultFs(ignoreDirs, maxFileBytes);
  const godMax = options.godComponentMaxLines ?? DEFAULT_GOD_MAX_LINES;
  const dupMin = options.duplicateMinBlockLines ?? DEFAULT_DUP_MIN_BLOCK;
  const dupOcc = options.duplicateMinOccurrences ?? DEFAULT_DUP_MIN_OCC;
  const severityOf = (t: ArchitectureViolationType): ArchitectureSeverity =>
    options.severityOverrides?.[t] ?? DEFAULT_SEVERITY[t];
  const generatedAt = now();

  log(`analyzing ${projectPath}${input.files ? ` (${input.files.length} explicit file(s))` : ''}`);

  // Resolve the file list (explicit subset, or a full walk).
  let absFiles: string[];
  if (input.files && input.files.length > 0) {
    absFiles = input.files
      .map((f) => (isAbsolute(f) ? f : join(projectPath, f)))
      .filter((f) => SOURCE_EXTS.has(extensionOf(f)));
  } else {
    absFiles = await fs.listFiles(projectPath);
  }

  // Read + parse.
  const parsed: ParsedFile[] = [];
  for (const abs of absFiles) {
    const content = await fs.readFile(abs);
    if (content === null) continue;
    try {
      parsed.push(parseFile(relPath(projectPath, abs), content));
    } catch (error) {
      log(`WARNING: parse failed for ${abs} (${describe(error)}) — skipped`);
    }
  }
  const scannedFiles = parsed.length;
  const relSet = new Set(parsed.map((p) => p.rel));

  const violations: ArchitectureViolation[] = [];

  // Cross-file: dependency graph + cycles.
  const graph = buildDependencyGraph(parsed, relSet);
  const cycles = findCycles(graph);
  for (const cyc of cycles) violations.push(cycleViolation(cyc, severityOf('circular_dependency')));

  // Per-file detectors (each guarded — a bad file never aborts the run).
  for (const f of parsed) {
    try {
      violations.push(...detectGodComponent(f, godMax, severityOf('god_component')));
      violations.push(...detectNPlusOne(f, severityOf('n_plus_one_query')));
      violations.push(...detectHardcodedValues(f, severityOf('hardcoded_value')));
      violations.push(...detectStrictModeViolations(f, severityOf('strict_mode_violation')));
    } catch (error) {
      log(`WARNING: detector failed for ${f.rel} (${describe(error)}) — skipped`);
    }
  }

  // Cross-file detectors.
  const safe = (fn: () => ArchitectureViolation[], label: string): void => {
    try {
      violations.push(...fn());
    } catch (error) {
      log(`WARNING: ${label} detector failed (${describe(error)}) — skipped`);
    }
  };
  safe(() => detectDuplicateLogic(parsed, dupMin, dupOcc, severityOf('duplicate_logic')), 'duplicate-logic');
  safe(() => detectDeadCode(parsed, relSet, severityOf('dead_code')), 'dead-code');
  safe(() => detectInconsistentNaming(parsed, severityOf('inconsistent_naming')), 'inconsistent-naming');
  safe(() => detectMissingErrorBoundaries(parsed, severityOf('missing_error_boundary')), 'missing-error-boundary');

  const sorted = sortViolations(violations);
  const counts = countBySeverity(sorted);
  const blocked = counts.high > 0;
  const report = renderArchitectureReport(sorted, counts, scannedFiles, cycles, blocked);

  // Persist a summary to Build Memory (guarded — degrades to stateless mode, Contract 4).
  const store = options.storeResult ?? defaultStoreResult;
  try {
    await store(
      {
        projectName: input.projectName ?? basename(projectPath),
        buildRunId: input.buildRunId ?? null,
        blocked,
        counts,
        totalViolations: sorted.length,
        scannedFiles,
        cycleCount: cycles.length,
        byType: countByType(sorted),
        generatedAt,
      },
      log
    );
  } catch (error) {
    log(`WARNING: store threw (${describe(error)}) — ignored`);
  }

  log(
    blocked
      ? `BLOCKED ❌ — ${counts.high} high-severity violation(s)`
      : `PASS ${counts.medium + counts.low > 0 ? '⚠️' : '✅'} — ${sorted.length} violation(s)`
  );

  return {
    passed: !blocked,
    blocked,
    violations: sorted,
    counts,
    scannedFiles,
    dependencyGraph: Object.fromEntries(graph),
    cycles,
    report,
    generatedAt,
  };
}

export default runArchitectureGuard;
