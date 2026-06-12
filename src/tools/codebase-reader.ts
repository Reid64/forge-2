/**
 * FORGE 2.0 — Codebase Reader (Phase 1C Current State Ingestion helper).
 *
 * Given a project path, read and catalog an existing codebase into a single
 * `CodebaseSnapshot` so Phase 1C (s3-p03) can treat the existing decisions as
 * immutable constraints and design only the remaining portions.
 *
 * What it catalogs (per the task spec, s3-p01):
 *   - fileTree      → the directory tree, EXCLUDING node_modules, .git and .next.
 *   - components[]  → for every .ts/.tsx/.js/.jsx file, the top-level declarations
 *                     (exports, React component names, function signatures, classes,
 *                     interfaces, types, enums, re-exports). One flat catalog; the
 *                     `kind` field distinguishes a React `component` from a plain
 *                     `function`, and `exported` records visibility.
 *   - routes[]      → Next.js route structure derived from a `pages/` or `app/`
 *                     directory (either at the root or under `src/`).
 *   - schema[]      → for every `.sql` (migration) file, the `create table` names
 *                     and their columns (name, type, nullability, PK, default).
 *   - dependencies[]→ package.json dependencies across all four dependency scopes.
 *   - governanceDocs[] → existing FORGE governance documents (root or governance/).
 *   - stats         → { totalFiles, totalLines } (+ a few useful extras).
 *
 * Like the other Phase 0/1 tools (stack-detector, env-auditor), this reader is
 * best-effort and NON-FATAL: every directory listing and file read is guarded,
 * missing/unreadable files are skipped, and a partial snapshot is a valid result.
 * `readCodebase` never throws — the worst case is an almost-empty snapshot.
 *
 * Source parsing is intentionally LIGHTWEIGHT and heuristic (line-based regex over
 * top-level declarations), not a full TypeScript parse. It is a catalog for an
 * intelligence engine, not a compiler — approximate signatures are acceptable and
 * a parse that cannot resolve a signature records the symbol with `signature: null`
 * rather than failing.
 *
 * SECURITY: file CONTENT is read only to count lines and extract structural symbols
 * (declaration names, signatures, table/column names). No secret values are parsed
 * out of `.env*` files here — that is the stack-detector's concern, and even there
 * only key names are read.
 */

import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

/** A node in the catalogued directory tree (ignored directories are pruned). */
export interface FileTreeNode {
  /** Base name of the file or directory. */
  name: string;
  /** Project-relative POSIX path ('.' for the root). */
  path: string;
  type: 'file' | 'directory';
  /** Files only: line count (0 for binary/unreadable/over-cap files). */
  lines?: number;
  /** Files only: byte size on disk. */
  sizeBytes?: number;
  /** Files only: lower-cased extension without the leading dot (e.g. 'ts'). */
  ext?: string;
  /** Directories only: children sorted directories-first, then alphabetically. */
  children?: FileTreeNode[];
}

/** Classification of a top-level source declaration. */
export type CodeSymbolKind =
  | 'component' // PascalCase function/class in a .tsx/.jsx file (a React component)
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'constant' // top-level const that is not a callable
  | 'variable' // top-level let/var (or default expression) that is not a callable
  | 'reexport'; // `export { ... }` / `export * from ...`

/**
 * A single top-level declaration found in a source file. The `components[]` array
 * of a snapshot is a flat catalog of these across every `.ts/.tsx/.js/.jsx` file —
 * it captures exports, component names AND function signatures in one place.
 */
export interface CodeSymbol {
  /** Declaration name; `'default'` for an anonymous default export. */
  name: string;
  kind: CodeSymbolKind;
  /** Project-relative POSIX path of the declaring file. */
  file: string;
  /** 1-based line of the declaration. */
  line: number;
  /** Whether the declaration is exported from its module. */
  exported: boolean;
  /** One-line signature for callables (`name(params): ret`); `null` otherwise. */
  signature: string | null;
}

/** Which Next.js router a route belongs to. */
export type RouteRouter = 'app' | 'pages';

/** The role a route file plays. */
export type RouteKind =
  | 'page'
  | 'layout'
  | 'api'
  | 'loading'
  | 'error'
  | 'template'
  | 'not-found'
  | 'default'
  | 'middleware';

/** A single Next.js route resolved from the pages/ or app/ directory. */
export interface RouteInfo {
  /** URL path with dynamic segments normalized (`[id]`→`:id`, `[...x]`→`*x`). */
  route: string;
  /** Project-relative POSIX path of the route file. */
  file: string;
  router: RouteRouter;
  kind: RouteKind;
  /** Whether the route contains at least one dynamic/catch-all segment. */
  dynamic: boolean;
}

/** A single column parsed from a `create table` statement. */
export interface ColumnInfo {
  name: string;
  /** Raw column type as written (e.g. `numeric(10,4)`, `timestamptz`). */
  type: string;
  /** Best-effort nullability (`false` when `not null` is present). */
  nullable: boolean;
  /** Whether the column is (part of) the primary key. */
  primaryKey: boolean;
  /** Default expression as written, or `null` if none. */
  default: string | null;
}

/** A table parsed from a migration/SQL file. */
export interface TableInfo {
  /** Table name without any schema prefix (e.g. `build_runs`, not `public.build_runs`). */
  name: string;
  /** Project-relative POSIX path of the SQL file that declares it. */
  file: string;
  columns: ColumnInfo[];
}

/** A package.json dependency entry. */
export interface DependencyInfo {
  name: string;
  /** Version range as written in package.json. */
  version: string;
  scope: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
}

/** An existing governance document found in the project. */
export interface GovernanceDoc {
  /** File name (e.g. `BLUEPRINT.md`). */
  name: string;
  /** Project-relative POSIX path. */
  path: string;
  sizeBytes: number;
  lines: number;
}

/** Aggregate counts for the catalogued codebase. */
export interface CodebaseStats {
  /** Total files in the tree (ignored directories excluded). */
  totalFiles: number;
  /** Total lines across all readable text files. */
  totalLines: number;
  /** Total directories in the tree (ignored directories excluded). */
  totalDirectories: number;
  /** Count of `.ts/.tsx/.js/.jsx` source files. */
  sourceFiles: number;
  /** Total bytes across all catalogued files. */
  totalBytes: number;
}

/** The complete catalogue produced by {@link readCodebase}. */
export interface CodebaseSnapshot {
  /** Absolute path that was scanned. */
  projectPath: string;
  fileTree: FileTreeNode;
  components: CodeSymbol[];
  routes: RouteInfo[];
  schema: TableInfo[];
  dependencies: DependencyInfo[];
  governanceDocs: GovernanceDoc[];
  stats: CodebaseStats;
}

/** Options for {@link readCodebase}. */
export interface CodebaseReaderOptions {
  /** Directory names to prune from the walk. Defaults to the spec set below. */
  ignoreDirs?: readonly string[];
  /** Files larger than this are tree-listed but not read for lines/symbols. */
  maxFileBytes?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directories excluded from the walk (per the task spec). */
const DEFAULT_IGNORE_DIRS: readonly string[] = ['node_modules', '.git', '.next'];

/** Default ceiling for reading a file's content (2 MB). */
const DEFAULT_MAX_FILE_BYTES = 2_000_000;

/** Source extensions whose top-level declarations are catalogued. */
const SOURCE_EXTS: ReadonlySet<string> = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);

/** Extensions treated as JSX-bearing (PascalCase declarations → React components). */
const JSX_EXTS: ReadonlySet<string> = new Set(['tsx', 'jsx']);

/** Extensions never read as text (line count 0; not parsed). */
const BINARY_EXTS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'svg', 'bmp', 'avif',
  'pdf', 'zip', 'gz', 'tar', 'tgz', 'rar', '7z',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'wav', 'ogg',
  'wasm', 'node', 'bin', 'exe', 'dll', 'so', 'dylib', 'lockb',
]);

/** Known FORGE governance document names looked up in root and governance/. */
const GOVERNANCE_DOC_NAMES: readonly string[] = [
  'BLUEPRINT.md',
  'SCHEMA_REGISTRY.md',
  'BEHAVIORAL_CONTRACTS.md',
  'AGENTS.md',
  'INTERACTION_MAPS.md',
  'PRD.md',
  'TESTING.md',
  'TOOLCHAIN.md',
  'CLAUDE.md',
  'STATE_OF_THE_BUILD.md',
  'SESSION_STATE.md',
  'queue.yaml',
];

/** Page-extension set for Next.js route files. */
const ROUTE_EXTS: ReadonlySet<string> = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs']);

// ---------------------------------------------------------------------------
// Low-level helpers (all guarded — never throw)
// ---------------------------------------------------------------------------

/** Normalize a path to POSIX separators for stable, OS-independent output. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Lower-cased extension without the dot, or '' if none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** Read a UTF-8 text file, returning `null` if it cannot be read. */
async function readTextSafe(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** List a directory's entries with file-type info, returning `[]` on any error. */
async function readDirSafe(absPath: string): Promise<Dirent[]> {
  try {
    return await readdir(absPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Stat a path for its byte size, returning `null` if it does not exist / can't be read. */
async function statSizeSafe(absPath: string): Promise<number | null> {
  try {
    return (await stat(absPath)).size;
  } catch {
    return null;
  }
}

/** Count lines the intuitive way: 0 for empty, else newline count (+1 for an unterminated last line). */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') newlines++;
  }
  // A file that does not end in a newline still has one final line.
  return text[text.length - 1] === '\n' ? newlines : newlines + 1;
}

/** Collapse runs of whitespace (incl. newlines) to single spaces and trim. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Truncate a signature to a sane catalogue length. */
function clampSignature(s: string): string {
  const max = 200;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Does an identifier look like a React component / class name (PascalCase)? */
function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

// ---------------------------------------------------------------------------
// Directory walk → file tree + flat file list
// ---------------------------------------------------------------------------

/** A flat record of one catalogued file, used by the analysis passes. */
interface FileRecord {
  /** Project-relative POSIX path. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  ext: string;
  sizeBytes: number;
  lines: number;
}

/** Mutable accumulator threaded through the recursive walk. */
interface WalkAccumulator {
  files: FileRecord[];
  totalFiles: number;
  totalDirectories: number;
  totalLines: number;
  totalBytes: number;
}

/**
 * Recursively walk `absPath` building a {@link FileTreeNode} and populating `acc`.
 * Pruned directory names are skipped entirely. Unreadable directories yield an
 * empty child list rather than an error.
 */
async function walkDir(
  absPath: string,
  relPath: string,
  name: string,
  ignore: ReadonlySet<string>,
  maxBytes: number,
  acc: WalkAccumulator
): Promise<FileTreeNode> {
  const node: FileTreeNode = { name, path: relPath === '' ? '.' : relPath, type: 'directory', children: [] };

  const entries = await readDirSafe(absPath); // unreadable directory → empty children
  const children: FileTreeNode[] = [];
  for (const entry of entries) {
    const childName = entry.name;
    const childAbs = join(absPath, childName);
    const childRel = relPath === '' ? childName : `${relPath}/${childName}`;

    if (entry.isDirectory()) {
      if (ignore.has(childName)) continue; // prune node_modules / .git / .next / …
      acc.totalDirectories++;
      children.push(await walkDir(childAbs, childRel, childName, ignore, maxBytes, acc));
    } else if (entry.isFile()) {
      children.push(await visitFile(childAbs, childRel, childName, maxBytes, acc));
    }
    // Symlinks and other entry types are intentionally ignored.
  }

  // Directories first, then files; each group sorted by name.
  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  node.children = children;
  return node;
}

/** Stat + (optionally) read a single file, updating `acc` and returning its tree node. */
async function visitFile(
  absPath: string,
  relPath: string,
  name: string,
  maxBytes: number,
  acc: WalkAccumulator
): Promise<FileTreeNode> {
  const ext = extensionOf(name);
  const sizeBytes = (await statSizeSafe(absPath)) ?? 0;

  let lines = 0;
  const readable = !BINARY_EXTS.has(ext) && sizeBytes <= maxBytes;
  if (readable) {
    const text = await readTextSafe(absPath);
    if (text !== null) lines = countLines(text);
  }

  acc.totalFiles++;
  acc.totalBytes += sizeBytes;
  acc.totalLines += lines;
  acc.files.push({ relPath, absPath, ext, sizeBytes, lines });

  return { name, path: relPath, type: 'file', ext, sizeBytes, lines };
}

// ---------------------------------------------------------------------------
// Source symbol extraction (heuristic, line-based, never throws)
// ---------------------------------------------------------------------------

/**
 * Extract top-level declarations from a source file's text.
 *
 * Only column-0 declarations are considered (indented lines are bodies and are
 * skipped), which keeps the heuristic robust without a real parser. Each match is
 * recorded once; callable signatures are reconstructed best-effort from a small
 * look-ahead buffer so multi-line parameter lists still resolve.
 */
function extractSymbols(relPath: string, ext: string, text: string): CodeSymbol[] {
  const jsx = JSX_EXTS.has(ext);
  const lines = text.split(/\r?\n/);
  const out: CodeSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // Top-level declarations begin at column 0. Skip indented (body) lines and blanks.
    if (line === '' || /^\s/.test(line)) continue;

    const exported = /^export\b/.test(line);
    const buffer = lines.slice(i, i + 6).join('\n');
    const lineNo = i + 1;

    // --- re-exports: export { a, b as c } [from '...'] -------------------
    const braceReexport = /^export\s+(?:type\s+)?\{/.exec(line);
    if (braceReexport) {
      const span = lines.slice(i, i + 30).join('\n');
      const inner = /\{([\s\S]*?)\}/.exec(span);
      if (inner && inner[1] !== undefined) {
        for (const piece of inner[1].split(',')) {
          const part = piece.trim();
          if (part === '' || part === 'type') continue;
          const asMatch = /(?:^|\s)as\s+([A-Za-z0-9_$]+)$/.exec(part);
          const first = part.split(/\s+/)[0] ?? '';
          const exportedName = asMatch && asMatch[1] ? asMatch[1] : first.replace(/^type\s+/, '');
          if (exportedName !== '') {
            out.push({ name: exportedName, kind: 'reexport', file: relPath, line: lineNo, exported: true, signature: null });
          }
        }
      }
      continue;
    }

    // --- export * [as ns] from '...' ------------------------------------
    const starReexport = /^export\s+\*\s+(?:as\s+([A-Za-z0-9_$]+)\s+)?from\b/.exec(line);
    if (starReexport) {
      out.push({ name: starReexport[1] ?? '*', kind: 'reexport', file: relPath, line: lineNo, exported: true, signature: null });
      continue;
    }

    // --- interface -------------------------------------------------------
    const iface = /^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/.exec(line);
    if (iface && iface[1]) {
      out.push({ name: iface[1], kind: 'interface', file: relPath, line: lineNo, exported, signature: null });
      continue;
    }

    // --- type alias ------------------------------------------------------
    const typeAlias = /^(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*[=<]/.exec(line);
    if (typeAlias && typeAlias[1]) {
      out.push({ name: typeAlias[1], kind: 'type', file: relPath, line: lineNo, exported, signature: null });
      continue;
    }

    // --- enum ------------------------------------------------------------
    const enumDecl = /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z0-9_$]+)/.exec(line);
    if (enumDecl && enumDecl[1]) {
      out.push({ name: enumDecl[1], kind: 'enum', file: relPath, line: lineNo, exported, signature: null });
      continue;
    }

    // --- class (incl. default / abstract) -------------------------------
    const classDecl = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)?/.exec(line);
    if (classDecl) {
      const name = classDecl[1] ?? 'default';
      const kind: CodeSymbolKind = jsx && name !== 'default' && isPascalCase(name) ? 'component' : 'class';
      out.push({ name, kind, file: relPath, line: lineNo, exported, signature: null });
      continue;
    }

    // --- function declaration (incl. default / async / generator) -------
    const fnDecl = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)?/.exec(line);
    if (fnDecl) {
      const name = fnDecl[1] ?? 'default';
      const kind: CodeSymbolKind = jsx && name !== 'default' && isPascalCase(name) ? 'component' : 'function';
      const after = name === 'default' ? buffer.slice(buffer.indexOf('function') + 8) : buffer.slice(buffer.indexOf(name) + name.length);
      const signature = name === 'default' ? null : buildSignature(name, after);
      out.push({ name, kind, file: relPath, line: lineNo, exported, signature });
      continue;
    }

    // --- const / let / var (possibly an arrow function / component) -----
    const binding = /^(?:export\s+)?(const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*([\s\S]*)$/.exec(buffer);
    if (binding && binding[1] && binding[2]) {
      const declKw = binding[1];
      const name = binding[2];
      const rhs = binding[3] ?? '';
      const arrow = parseArrowSignature(name, rhs);
      let kind: CodeSymbolKind;
      let signature: string | null;
      if (arrow) {
        kind = jsx && isPascalCase(name) ? 'component' : 'function';
        signature = arrow;
      } else {
        kind = declKw === 'const' ? 'constant' : 'variable';
        signature = null;
      }
      out.push({ name, kind, file: relPath, line: lineNo, exported, signature });
      continue;
    }

    // --- export default <identifier|expression> -------------------------
    const defaultExpr = /^export\s+default\s+([\s\S]*)$/.exec(buffer);
    if (defaultExpr && defaultExpr[1] !== undefined) {
      const rhs = defaultExpr[1].trim();
      const ident = /^([A-Za-z0-9_$]+)\s*;?\s*$/.exec(rhs);
      const name = ident && ident[1] ? ident[1] : 'default';
      const kind: CodeSymbolKind = jsx && name !== 'default' && isPascalCase(name) ? 'component' : 'variable';
      out.push({ name, kind, file: relPath, line: lineNo, exported: true, signature: null });
      continue;
    }
  }

  return out;
}

/**
 * Build a one-line signature for a `function`-keyword declaration. `after` is the
 * buffer text immediately following the function name (starting at the param list).
 */
function buildSignature(name: string, after: string): string | null {
  const params = readBalancedParens(after);
  if (!params) return null;
  const ret = readReturnType(params.rest);
  return clampSignature(`${name}${collapse(params.text)}${ret ? `: ${ret}` : ''}`);
}

/**
 * Build a one-line signature for a `const NAME = ...` arrow function, or return
 * `null` if the right-hand side is not a callable. `rhs` is the text after `=`.
 */
function parseArrowSignature(name: string, rhs: string): string | null {
  let s = rhs.replace(/^\s+/, '');
  // Strip a leading `async` and any leading generic parameter list.
  s = s.replace(/^async\s+/, '');
  s = s.replace(/^<[^>]*>\s*/, '');

  // Parenthesised parameter list: (a, b) => ...
  if (s.startsWith('(')) {
    const params = readBalancedParens(s);
    if (!params) return null;
    const rest = params.rest.replace(/^\s+/, '');
    const ret = readReturnType(params.rest);
    // Confirm it is actually an arrow (return-type or `=>` follows the params).
    if (!ret && !rest.startsWith('=>')) return null;
    return clampSignature(`${name}${collapse(params.text)}${ret ? `: ${ret}` : ''}`);
  }

  // Single bare-identifier parameter: x => ...
  const single = /^([A-Za-z0-9_$]+)\s*=>/.exec(s);
  if (single && single[1]) {
    return clampSignature(`${name}(${single[1]})`);
  }

  return null;
}

/**
 * Read a balanced parenthesised group at the start of `s` (ignoring leading
 * whitespace). Returns the group text (including the outer parens) and the
 * remainder after it, or `null` if no balanced group is present within `s`.
 */
function readBalancedParens(s: string): { text: string; rest: string } | null {
  let i = 0;
  while (i < s.length && /\s/.test(s[i] ?? '')) i++;
  if (s[i] !== '(') return null;
  const start = i;
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        i++;
        return { text: s.slice(start, i), rest: s.slice(i) };
      }
    }
  }
  return null; // unbalanced within the look-ahead buffer
}

/** Read a `: ReturnType` annotation from `rest`, up to the body / arrow / end. */
function readReturnType(rest: string): string | null {
  const s = rest.replace(/^\s+/, '');
  if (!s.startsWith(':')) return null;
  let body = s.slice(1);
  // Cut at the first body opener or arrow body, whichever comes first.
  for (const stop of ['=>', '{', ';', '\n']) {
    const idx = body.indexOf(stop);
    if (idx >= 0) body = body.slice(0, idx);
  }
  const ret = collapse(body);
  return ret === '' ? null : ret;
}

// ---------------------------------------------------------------------------
// Route extraction (Next.js pages/ and app/ routers)
// ---------------------------------------------------------------------------

/**
 * Derive Next.js routes from the flat file list. Supports both the `pages/` and
 * `app/` routers, rooted at the project root or under `src/`. Files outside a
 * recognized router root produce no routes.
 */
function extractRoutes(files: readonly FileRecord[]): RouteInfo[] {
  const routes: RouteInfo[] = [];

  for (const file of files) {
    if (!ROUTE_EXTS.has(file.ext)) continue;

    const pages = stripRouterRoot(file.relPath, 'pages');
    if (pages !== null) {
      const route = pagesRoute(pages);
      if (route) routes.push({ ...route, file: file.relPath, router: 'pages' });
      continue;
    }

    const app = stripRouterRoot(file.relPath, 'app');
    if (app !== null) {
      const route = appRoute(app);
      if (route) routes.push({ ...route, file: file.relPath, router: 'app' });
    }
  }

  routes.sort((a, b) => a.route.localeCompare(b.route) || a.file.localeCompare(b.file));
  return routes;
}

/** Return the path within `<root>/` (or `src/<root>/`), or `null` if not under it. */
function stripRouterRoot(relPath: string, root: string): string | null {
  if (relPath.startsWith(`${root}/`)) return relPath.slice(root.length + 1);
  if (relPath.startsWith(`src/${root}/`)) return relPath.slice(`src/${root}/`.length);
  return null;
}

/** Normalize one Next.js path segment; returns '' for segments that drop out of the URL. */
function normalizeSegment(seg: string): { text: string; dynamic: boolean } | null {
  // Route groups `(group)`, parallel `@slot`, and intercepting `(.)`/`(..)` segments
  // do not contribute to the URL path.
  if (seg.startsWith('(') && seg.endsWith(')')) return { text: '', dynamic: false };
  if (seg.startsWith('@')) return { text: '', dynamic: false };

  const catchAll = /^\[\.\.\.(.+)\]$/.exec(seg) ?? /^\[\[\.\.\.(.+)\]\]$/.exec(seg);
  if (catchAll && catchAll[1]) return { text: `*${catchAll[1]}`, dynamic: true };

  const dynamic = /^\[(.+)\]$/.exec(seg);
  if (dynamic && dynamic[1]) return { text: `:${dynamic[1]}`, dynamic: true };

  return { text: seg, dynamic: false };
}

/** Build a `/`-joined URL from already-normalized directory segments. */
function joinSegments(segments: readonly string[]): { route: string; dynamic: boolean } {
  const parts: string[] = [];
  let dynamic = false;
  for (const seg of segments) {
    if (seg === '') continue;
    const norm = normalizeSegment(seg);
    if (!norm || norm.text === '') {
      if (norm?.dynamic) dynamic = true;
      continue;
    }
    parts.push(norm.text);
    if (norm.dynamic) dynamic = true;
  }
  return { route: `/${parts.join('/')}`.replace(/\/+/g, '/'), dynamic };
}

/** Resolve a `pages/`-router file (each file is itself a route). */
function pagesRoute(inner: string): Omit<RouteInfo, 'file' | 'router'> | null {
  const dot = inner.lastIndexOf('.');
  const noExt = dot > 0 ? inner.slice(0, dot) : inner;
  const segments = noExt.split('/');
  const fileName = segments[segments.length - 1] ?? '';

  // `_app` and `_document` are framework wrappers, not routes.
  if (fileName === '_app' || fileName === '_document') return null;

  const isApi = segments[0] === 'api';
  // Drop a trailing `index` so `pages/index` → `/` and `pages/blog/index` → `/blog`.
  const urlSegments = fileName === 'index' ? segments.slice(0, -1) : segments;
  const { route, dynamic } = joinSegments(urlSegments);
  return { route, kind: isApi ? 'api' : 'page', dynamic };
}

/** Map an `app/`-router special filename to its route kind, or `null` if not special. */
function appFileKind(fileName: string): RouteKind | null {
  switch (fileName) {
    case 'page':
      return 'page';
    case 'route':
      return 'api';
    case 'layout':
      return 'layout';
    case 'loading':
      return 'loading';
    case 'error':
    case 'global-error':
      return 'error';
    case 'template':
      return 'template';
    case 'not-found':
      return 'not-found';
    case 'default':
      return 'default';
    default:
      return null;
  }
}

/** Resolve an `app/`-router file (only special filenames are routes; dir = URL). */
function appRoute(inner: string): Omit<RouteInfo, 'file' | 'router'> | null {
  const dot = inner.lastIndexOf('.');
  const noExt = dot > 0 ? inner.slice(0, dot) : inner;
  const segments = noExt.split('/');
  const fileName = segments[segments.length - 1] ?? '';

  const kind = appFileKind(fileName);
  if (kind === null) return null;

  const { route, dynamic } = joinSegments(segments.slice(0, -1));
  return { route, kind, dynamic };
}

// ---------------------------------------------------------------------------
// SQL schema extraction (create table → columns)
// ---------------------------------------------------------------------------

/** SQL keywords that, at the start of a body fragment, mark a table-level constraint. */
const TABLE_CONSTRAINT_KEYWORDS = /^(constraint|primary\s+key|foreign\s+key|unique|check|exclude|like|references)\b/i;

/** Tokens after a column type that begin a constraint clause (and so end the type). */
const COLUMN_TYPE_TERMINATORS = /\b(not\s+null|null|default|primary\s+key|references|unique|check|generated|collate|constraint)\b/i;

/** Extract every `create table` and its columns from one SQL file's text. */
function extractTables(relPath: string, text: string): TableInfo[] {
  const tables: TableInfo[] = [];
  // Strip line and block comments so they don't confuse the parser.
  const sql = text.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?([A-Za-z0-9_."]+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const rawName = match[1];
    if (!rawName) continue;
    const body = readBalancedParens(sql.slice(match.index + match[0].length - 1));
    if (!body) continue;
    // body.text includes the outer parens; drop them for the column list.
    const inner = body.text.slice(1, -1);
    tables.push({ name: cleanTableName(rawName), file: relPath, columns: parseColumns(inner) });
  }

  return tables;
}

/** Strip schema prefix and quotes from a table identifier. */
function cleanTableName(raw: string): string {
  const unquoted = raw.replace(/"/g, '');
  const dot = unquoted.lastIndexOf('.');
  return dot >= 0 ? unquoted.slice(dot + 1) : unquoted;
}

/** Parse a column list body into {@link ColumnInfo} entries (constraints skipped). */
function parseColumns(body: string): ColumnInfo[] {
  const columns: ColumnInfo[] = [];
  for (const fragment of splitTopLevel(body)) {
    const frag = fragment.trim();
    if (frag === '' || TABLE_CONSTRAINT_KEYWORDS.test(frag)) continue;

    const nameMatch = /^("?[A-Za-z_][A-Za-z0-9_]*"?)\s+([\s\S]+)$/.exec(frag);
    if (!nameMatch || !nameMatch[1] || !nameMatch[2]) continue;
    const name = nameMatch[1].replace(/"/g, '');
    const rest = nameMatch[2];

    const term = COLUMN_TYPE_TERMINATORS.exec(rest);
    const type = collapse(term ? rest.slice(0, term.index) : rest);

    const nullable = !/\bnot\s+null\b/i.test(rest);
    const primaryKey = /\bprimary\s+key\b/i.test(rest);
    const defaultMatch = /\bdefault\s+([\s\S]+?)(?:\s+(?:not\s+null|null|primary\s+key|references|unique|check|generated|collate|constraint)\b|$)/i.exec(rest);
    const def = defaultMatch && defaultMatch[1] ? collapse(defaultMatch[1]) : null;

    columns.push({ name, type, nullable, primaryKey, default: def });
  }
  return columns;
}

/** Split a SQL body on top-level commas (commas inside parentheses are preserved). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i] ?? '';
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
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
// package.json dependencies & governance documents
// ---------------------------------------------------------------------------

/** Read and flatten package.json dependencies across all four scopes. */
async function readDependencies(projectPath: string): Promise<DependencyInfo[]> {
  const text = await readTextSafe(join(projectPath, 'package.json'));
  if (text === null) return [];

  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  if (!pkg || typeof pkg !== 'object') return [];

  const scopes: DependencyInfo['scope'][] = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];

  const deps: DependencyInfo[] = [];
  for (const scope of scopes) {
    const section = (pkg as Record<string, unknown>)[scope];
    if (!section || typeof section !== 'object') continue;
    for (const [name, version] of Object.entries(section as Record<string, unknown>)) {
      deps.push({ name, version: typeof version === 'string' ? version : String(version), scope });
    }
  }
  deps.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
  return deps;
}

/** Locate existing FORGE governance documents in the root and governance/ dir. */
async function readGovernanceDocs(projectPath: string): Promise<GovernanceDoc[]> {
  const docs: GovernanceDoc[] = [];
  const seen = new Set<string>();

  for (const dir of ['', 'governance']) {
    for (const docName of GOVERNANCE_DOC_NAMES) {
      const rel = dir === '' ? docName : `${dir}/${docName}`;
      if (seen.has(rel)) continue;
      const abs = join(projectPath, dir, docName);
      const sizeBytes = await statSizeSafe(abs);
      if (sizeBytes === null) continue; // not present
      seen.add(rel);
      const text = await readTextSafe(abs);
      docs.push({ name: docName, path: rel, sizeBytes, lines: text === null ? 0 : countLines(text) });
    }
  }

  docs.sort((a, b) => a.path.localeCompare(b.path));
  return docs;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Read and catalog the codebase rooted at `projectPath` into a {@link CodebaseSnapshot}.
 *
 * Always resolves (never rejects). A path that cannot be listed yields a snapshot
 * with an empty tree and empty catalogs rather than throwing.
 */
export async function readCodebase(
  projectPath: string,
  options: CodebaseReaderOptions = {}
): Promise<CodebaseSnapshot> {
  const ignore = new Set<string>(options.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const acc: WalkAccumulator = {
    files: [],
    totalFiles: 0,
    totalDirectories: 0,
    totalLines: 0,
    totalBytes: 0,
  };

  const rootName = basename(projectPath) || toPosix(projectPath);
  const fileTree = await walkDir(projectPath, '', rootName, ignore, maxBytes, acc);

  // --- per-file source symbol + SQL schema extraction ---------------------
  const components: CodeSymbol[] = [];
  const schema: TableInfo[] = [];
  let sourceFiles = 0;

  for (const file of acc.files) {
    const isSource = SOURCE_EXTS.has(file.ext);
    const isSql = file.ext === 'sql';
    if (!isSource && !isSql) continue;
    if (file.sizeBytes > maxBytes) continue; // already tree-listed; skip heavy parse

    const text = await readTextSafe(file.absPath);
    if (text === null) continue;

    if (isSource) {
      sourceFiles++;
      components.push(...extractSymbols(file.relPath, file.ext, text));
    }
    if (isSql) {
      schema.push(...extractTables(file.relPath, text));
    }
  }

  const routes = extractRoutes(acc.files);
  const [dependencies, governanceDocs] = await Promise.all([
    readDependencies(projectPath),
    readGovernanceDocs(projectPath),
  ]);

  return {
    projectPath,
    fileTree,
    components,
    routes,
    schema,
    dependencies,
    governanceDocs,
    stats: {
      totalFiles: acc.totalFiles,
      totalLines: acc.totalLines,
      totalDirectories: acc.totalDirectories,
      sourceFiles,
      totalBytes: acc.totalBytes,
    },
  };
}

export default readCodebase;
