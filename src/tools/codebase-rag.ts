/**
 * FORGE 2.0 — Codebase RAG (Phase 3 Build Executor context-injection helper).
 *
 * Gives the build loop *spatial awareness of what already exists* so each prompt does NOT
 * recreate, shadow, or conflict with code already in the target project. On build start it
 * indexes the ENTIRE target codebase into an in-memory vector store; before each prompt fires
 * it retrieves the 10 files most relevant to that prompt's task and injects compact summaries
 * of them into the prompt context; after each SUCCESSFUL prompt it rebuilds the index so the
 * next retrieval reflects the files the prompt just wrote (queue.yaml extension to Contract 7
 * Context Injection — this is a fourth, codebase-grounded context source alongside governance,
 * Build Memory warnings, and the previous Sentinel status).
 *
 * WHAT IS INDEXED — one document per source file (.ts/.tsx/.js/.jsx/.mjs/.cjs). Each document's
 * embeddable text is a structural SUMMARY, never the file body:
 *   - file path           (the strongest locality signal — boosted)
 *   - exported symbols    (what the file offers other modules — boosted)
 *   - component names      (React components, PascalCase — boosted)
 *   - function signatures  (name + params + return, from the symbol catalogue)
 *   - import specifiers    (what the file already depends on)
 * The symbol catalogue is reused verbatim from {@link readCodebase} (the Phase 1C reader) so the
 * heuristic top-level parser lives in exactly one place; this module only adds import extraction.
 *
 * THE EMBEDDING IS LOCAL, DETERMINISTIC, AND DEPENDENCY-FREE — a hashed TF-IDF bag-of-words
 * vector with cosine similarity. This is a deliberate stack choice, not a placeholder:
 *   - Anthropic exposes NO embeddings endpoint (text embeddings are a separate-vendor concern,
 *     e.g. Voyage AI); .env.example provisions no embeddings provider and BLUEPRINT mandates the
 *     Build Memory layer be "zero recurring cost".
 *   - FORGE indexes on every build start AND after every successful prompt — calling a paid,
 *     networked embeddings API on that cadence would add latency, cost, and a failure surface to
 *     the hot path, for a retrieval task where lexical overlap of identifiers/paths is exactly the
 *     signal we want.
 *   - Determinism matters: the same codebase + the same task must retrieve the same files (Build
 *     Replay, dry runs, and tests all depend on it). A hashed TF-IDF vector is fully deterministic.
 * Identifiers are split on camelCase / snake_case / path boundaries before hashing, so `getUserById`,
 * `get_user_by_id`, and `users/[id]` all share the tokens `user`/`id` and match a "fetch a user by
 * id" task. IDF (computed across the indexed corpus) down-weights boilerplate that appears in every
 * file and up-weights the distinctive identifiers that actually locate a file.
 *
 * NON-FATAL HOUSE STYLE (matches stack-detector / codebase-reader / the executor collaborators):
 * every file read is guarded, a missing/unreadable file is skipped, and an empty codebase yields an
 * empty index that retrieves nothing. {@link buildCodebaseIndex} never rejects; {@link CodebaseIndex.query}
 * never throws. RAG is an ENRICHMENT — if it degrades, the prompt is simply assembled without the
 * "existing files" section, never blocked (the same posture Contract 4 takes for Build Memory).
 *
 * SECURITY: only structural metadata is embedded (paths, declaration names, signatures, import
 * specifiers). File bodies are read solely to extract import lines and are never stored, returned,
 * or embedded. No `.env` values are read here (that is the stack-detector's concern).
 *
 * BOUNDARY: this reads the TARGET project (`projectPath`) — never FORGE's own governance files.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  readCodebase,
  type CodebaseReaderOptions,
  type CodebaseSnapshot,
  type CodeSymbol,
  type FileTreeNode,
} from './codebase-reader.js';
import { logLine } from './forge-logger.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The structural summary + embedding for one indexed source file. */
export interface FileDocument {
  /** Project-relative POSIX path (the document's identity, e.g. `src/memory/client.ts`). */
  path: string;
  /** Lower-cased extension without the dot (e.g. `ts`). */
  ext: string;
  /** Names of exported declarations (functions, components, types, constants, re-exports). */
  exports: string[];
  /** One-line callable signatures (`name(params): ret`) for functions/components in the file. */
  functions: string[];
  /** React component names (PascalCase functions/classes in `.tsx`/`.jsx`). */
  components: string[];
  /** Module specifiers the file imports / re-exports / requires (e.g. `./client`, `node:fs`). */
  imports: string[];
  /** Compact human/LLM-readable summary — what is injected into the prompt for this file. */
  summary: string;
  /** L2-normalized hashed TF-IDF embedding (bucket → weight). Empty for a contentless file. */
  vector: SparseVector;
}

/** A sparse embedding vector: hash bucket → weight. Normalized vectors have unit L2 norm. */
export type SparseVector = Map<number, number>;

/** One retrieval hit: the matched file document and its cosine-similarity score in [0, 1]. */
export interface RagMatch {
  document: FileDocument;
  /** Cosine similarity between the task query and the document (0 = unrelated, 1 = identical). */
  score: number;
}

/** Options for {@link buildCodebaseIndex} / {@link CodebaseRag.create}. */
export interface CodebaseIndexOptions {
  /** Embedding dimensionality (hash buckets). Larger = fewer collisions. Default 4096. */
  dimensions?: number;
  /** Directory names to prune from the walk. Defaults to the codebase-reader's set. */
  ignoreDirs?: readonly string[];
  /** Files larger than this are not read for imports. Default: the codebase-reader's cap. */
  maxFileBytes?: number;
  /**
   * Override the codebase scan (tests / a pre-built snapshot). Default: {@link readCodebase}.
   * The returned snapshot supplies the file tree + symbol catalogue; imports are read separately.
   */
  readCodebaseImpl?: (projectPath: string) => Promise<CodebaseSnapshot>;
  /** Progress reporter. Default logs to the console with a `[FORGE:rag]` prefix. */
  log?: (message: string) => void;
}

/** Options for {@link renderRelevantFiles} (the prompt-injection block). */
export interface RenderOptions {
  /** Max files to render. Default 10. */
  maxFiles?: number;
  /** Max exports/functions/imports listed per file before eliding the rest. Default 12. */
  maxItemsPerFile?: number;
  /** Drop matches scoring at or below this cosine threshold. Default 0 (keep any overlap). */
  minScore?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of hash buckets in an embedding vector. */
const DEFAULT_DIMENSIONS = 4096;

/** Default number of relevant files retrieved per prompt (per the task spec). */
export const DEFAULT_TOP_K = 10;

/** Source extensions that become indexed documents (mirrors the codebase-reader's source set). */
const SOURCE_EXTS: ReadonlySet<string> = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);

/** Field boosts: how many times a field's tokens are added to a document's bag (raises their TF). */
const FIELD_BOOST = {
  path: 3,
  exportName: 3,
  componentName: 3,
  functionSignature: 2,
  importSpecifier: 1,
} as const;

/**
 * Tokens too generic to locate a file — dropped before hashing. Kept deliberately SMALL: IDF already
 * down-weights anything that appears in most files, so this only needs to remove language keywords
 * and articles that survive identifier-splitting and would otherwise add collision noise.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'from', 'this', 'that', 'with', 'into', 'out', 'via',
  'import', 'export', 'default', 'const', 'let', 'var', 'function', 'return',
  'type', 'interface', 'class', 'enum', 'async', 'await', 'new', 'extends',
  'string', 'number', 'boolean', 'void', 'null', 'undefined', 'any', 'unknown',
  'true', 'false', 'public', 'private', 'readonly', 'static', 'index', 'node',
]);

// ---------------------------------------------------------------------------
// Tokenization (deterministic, identifier-aware)
// ---------------------------------------------------------------------------

/**
 * Split free text / identifiers into lower-cased tokens, breaking on camelCase, acronym, and
 * non-alphanumeric (incl. path `/`, `_`, `-`, `.`) boundaries. `getUserById`, `get_user_by_id`,
 * and `users/[id].tsx` all yield `user`/`id`. Stopwords and 1-char tokens are dropped.
 */
export function tokenize(text: string): string[] {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary: getUser → get User
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2'); // acronym boundary: HTTPServer → HTTP Server
  const out: string[] = [];
  for (const raw of spaced.split(/[^A-Za-z0-9]+/)) {
    const tok = raw.toLowerCase();
    if (tok.length >= 2 && !STOPWORDS.has(tok)) out.push(tok);
  }
  return out;
}

/** FNV-1a 32-bit hash of a token → a stable, well-distributed unsigned integer. */
function fnv1a(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Import extraction (line/regex based — never throws)
// ---------------------------------------------------------------------------

/**
 * Extract the module specifiers a file imports / re-exports / requires. Captures:
 *   - `import x from 'm'` / `import { a } from 'm'` / `import * as n from 'm'`
 *   - `import 'm'` (side-effect)
 *   - `export … from 'm'` (re-export)
 *   - `require('m')` and dynamic `import('m')`
 * Returns a de-duplicated, sorted list. Heuristic and tolerant — never throws.
 */
export function extractImports(text: string): string[] {
  const specs = new Set<string>();
  const re =
    /(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec !== undefined && spec.trim() !== '') specs.add(spec.trim());
  }
  return [...specs].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Snapshot → per-file structural fields
// ---------------------------------------------------------------------------

/** The structural fields gathered for one file before it is embedded. */
interface FileFields {
  path: string;
  ext: string;
  exports: string[];
  functions: string[];
  components: string[];
  imports: string[];
}

/** Flatten a {@link FileTreeNode} into the list of leaf files (path + ext). */
function flattenFiles(node: FileTreeNode, out: Array<{ path: string; ext: string }>): void {
  if (node.type === 'file') {
    out.push({ path: node.path, ext: node.ext ?? '' });
    return;
  }
  for (const child of node.children ?? []) flattenFiles(child, out);
}

/** Group the snapshot's flat symbol catalogue by declaring file path. */
function symbolsByFile(symbols: readonly CodeSymbol[]): Map<string, CodeSymbol[]> {
  const map = new Map<string, CodeSymbol[]>();
  for (const sym of symbols) {
    const list = map.get(sym.file);
    if (list) list.push(sym);
    else map.set(sym.file, [sym]);
  }
  return map;
}

/** Derive a file's exports / functions / components lists from its symbols. */
function fieldsFromSymbols(symbols: readonly CodeSymbol[]): {
  exports: string[];
  functions: string[];
  components: string[];
} {
  const exports: string[] = [];
  const functions: string[] = [];
  const components: string[] = [];
  for (const sym of symbols) {
    if (sym.name === '' || sym.name === 'default') {
      // Anonymous default — no useful identifier to embed; the signature, if any, still helps.
    } else if (sym.exported) {
      exports.push(sym.name);
    }
    if (sym.kind === 'component') components.push(sym.name);
    if (sym.signature && sym.signature.trim() !== '') functions.push(sym.signature.trim());
    else if (sym.kind === 'function' && sym.name !== 'default') functions.push(`${sym.name}()`);
  }
  return {
    exports: dedupeSorted(exports),
    functions: dedupeSorted(functions),
    components: dedupeSorted(components),
  };
}

/** De-duplicate and sort a string list (stable, locale-aware). */
function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Embedding (hashed TF-IDF bag-of-words → cosine)
// ---------------------------------------------------------------------------

/** Build a file's weighted token bag (field boosts applied by repetition → higher TF). */
function buildBag(fields: FileFields): string[] {
  const bag: string[] = [];
  const push = (text: string, weight: number): void => {
    for (const token of tokenize(text)) {
      for (let i = 0; i < weight; i++) bag.push(token);
    }
  };

  // Path carries the strongest locality signal — split it on '/' first, drop the extension.
  const pathNoExt = fields.path.replace(/\.[^./]+$/, '').replace(/\//g, ' ');
  push(pathNoExt, FIELD_BOOST.path);
  for (const name of fields.exports) push(name, FIELD_BOOST.exportName);
  for (const name of fields.components) push(name, FIELD_BOOST.componentName);
  for (const sig of fields.functions) push(sig, FIELD_BOOST.functionSignature);
  for (const spec of fields.imports) push(spec, FIELD_BOOST.importSpecifier);
  return bag;
}

/** Count term frequencies from a token bag. */
function termFrequencies(tokens: readonly string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

/**
 * Embed a term-frequency map into a normalized sparse vector using sublinear TF (`1 + ln(tf)`)
 * weighted by `idf` (default `unseenIdf` for terms not in the corpus, so a rare query term still
 * counts). The result is L2-normalized so cosine similarity reduces to a dot product.
 */
function embed(
  tf: Map<string, number>,
  idf: Map<string, number>,
  unseenIdf: number,
  dimensions: number
): SparseVector {
  const vec: SparseVector = new Map();
  for (const [term, freq] of tf) {
    const weight = (1 + Math.log(freq)) * (idf.get(term) ?? unseenIdf);
    if (weight === 0) continue;
    const bucket = fnv1a(term) % dimensions;
    vec.set(bucket, (vec.get(bucket) ?? 0) + weight);
  }
  return normalize(vec);
}

/** L2-normalize a sparse vector in place and return it (a zero vector is left empty). */
function normalize(vec: SparseVector): SparseVector {
  let sumSquares = 0;
  for (const value of vec.values()) sumSquares += value * value;
  if (sumSquares === 0) return vec;
  const norm = Math.sqrt(sumSquares);
  for (const [bucket, value] of vec) vec.set(bucket, value / norm);
  return vec;
}

/**
 * Cosine similarity of two L2-normalized sparse vectors (= their dot product). Iterates the
 * smaller map for efficiency. Returns 0 when either is empty.
 */
export function cosineSimilarity(a: SparseVector, b: SparseVector): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [bucket, value] of small) {
    const other = large.get(bucket);
    if (other !== undefined) dot += value * other;
  }
  // Guard against tiny floating-point overshoot beyond the [0, 1] cosine range.
  return dot < 0 ? 0 : dot > 1 ? 1 : dot;
}

// ---------------------------------------------------------------------------
// The in-memory vector store
// ---------------------------------------------------------------------------

/**
 * An in-memory vector store over a project's source files. Built by {@link buildCodebaseIndex};
 * query it with a task description to retrieve the most relevant existing files.
 */
export class CodebaseIndex {
  /** Absolute path that was indexed. */
  readonly projectPath: string;
  /** The indexed file documents, in path order. */
  readonly documents: readonly FileDocument[];
  /** Embedding dimensionality (hash buckets). */
  readonly dimensions: number;

  /** Inverse document frequency per corpus term (for embedding queries consistently). */
  private readonly idf: Map<string, number>;
  /** IDF assigned to a query term absent from the corpus (rarest → highest weight). */
  private readonly unseenIdf: number;

  constructor(init: {
    projectPath: string;
    documents: FileDocument[];
    dimensions: number;
    idf: Map<string, number>;
    unseenIdf: number;
  }) {
    this.projectPath = init.projectPath;
    this.documents = init.documents;
    this.dimensions = init.dimensions;
    this.idf = init.idf;
    this.unseenIdf = init.unseenIdf;
  }

  /** Number of files in the index. */
  get size(): number {
    return this.documents.length;
  }

  /** Embed a free-text task description into the same vector space as the documents. */
  embedQuery(taskText: string): SparseVector {
    return embed(termFrequencies(tokenize(taskText)), this.idf, this.unseenIdf, this.dimensions);
  }

  /**
   * Retrieve the `topK` files most relevant to `taskText` by cosine similarity, highest first.
   * Files with zero overlap are excluded. Ties break by path for deterministic output. Never throws.
   */
  query(taskText: string, topK: number = DEFAULT_TOP_K): RagMatch[] {
    if (this.documents.length === 0 || topK <= 0) return [];
    const queryVec = this.embedQuery(taskText);
    if (queryVec.size === 0) return [];

    const scored: RagMatch[] = [];
    for (const document of this.documents) {
      const score = cosineSimilarity(queryVec, document.vector);
      if (score > 0) scored.push({ document, score });
    }
    scored.sort((a, b) => b.score - a.score || a.document.path.localeCompare(b.document.path));
    return scored.slice(0, topK);
  }
}

// ---------------------------------------------------------------------------
// Index construction
// ---------------------------------------------------------------------------

/**
 * Index the entire codebase at `projectPath` into an in-memory {@link CodebaseIndex}.
 *
 * Scans the project (reusing {@link readCodebase} for the file tree + symbol catalogue), reads each
 * source file once to extract its imports, builds a hashed TF-IDF embedding per file, and returns
 * the queryable store. Call this on build start and again after each successful prompt to rebuild.
 *
 * Always resolves (never rejects). A path that cannot be scanned yields an empty index.
 */
export async function buildCodebaseIndex(
  projectPath: string,
  options: CodebaseIndexOptions = {}
): Promise<CodebaseIndex> {
  const log = options.log ?? logLine('rag');
  const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
  const scan = options.readCodebaseImpl ?? ((p: string) => readCodebase(p, readerOptions(options)));

  // 1. Scan the codebase (guarded — a scan failure degrades to an empty snapshot).
  let snapshot: CodebaseSnapshot;
  try {
    snapshot = await scan(projectPath);
  } catch (error) {
    log(`WARNING: codebase scan degraded (${describe(error)}) — empty index`);
    return emptyIndex(projectPath, dimensions);
  }

  // 2. Per-file structural fields: symbols from the snapshot, imports from a single guarded re-read.
  const symbolMap = symbolsByFile(snapshot.components);
  const leaves: Array<{ path: string; ext: string }> = [];
  flattenFiles(snapshot.fileTree, leaves);

  const fieldsList: FileFields[] = [];
  for (const leaf of leaves) {
    if (!SOURCE_EXTS.has(leaf.ext)) continue;
    const symbols = symbolMap.get(leaf.path) ?? [];
    const { exports, functions, components } = fieldsFromSymbols(symbols);
    const text = await readFile(join(projectPath, leaf.path), 'utf8').catch(() => null);
    const imports = text === null ? [] : extractImports(text);
    fieldsList.push({ path: leaf.path, ext: leaf.ext, exports, functions, components, imports });
  }

  if (fieldsList.length === 0) {
    log(`indexed 0 source files under "${projectPath}" — empty index`);
    return emptyIndex(projectPath, dimensions);
  }

  // 3. Build each file's token bag, then the corpus IDF (terms seen in fewer files weigh more).
  const bags = fieldsList.map((fields) => buildBag(fields));
  const docFreq = new Map<string, number>();
  for (const bag of bags) {
    for (const term of new Set(bag)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }
  const n = fieldsList.length;
  const idf = new Map<string, number>();
  for (const [term, df] of docFreq) idf.set(term, Math.log((n + 1) / (df + 1)) + 1);
  const unseenIdf = Math.log(n + 1) + 1; // a query term absent from the corpus is maximally rare

  // 4. Embed each file and build its injectable summary.
  const documents: FileDocument[] = fieldsList.map((fields, i) => {
    const tf = termFrequencies(bags[i] ?? []);
    const vector = embed(tf, idf, unseenIdf, dimensions);
    return {
      path: fields.path,
      ext: fields.ext,
      exports: fields.exports,
      functions: fields.functions,
      components: fields.components,
      imports: fields.imports,
      summary: summarizeFile(fields),
      vector,
    };
  });
  documents.sort((a, b) => a.path.localeCompare(b.path));

  log(`indexed ${documents.length} source file(s) under "${projectPath}" (${dimensions}-dim TF-IDF)`);
  return new CodebaseIndex({ projectPath, documents, dimensions, idf, unseenIdf });
}

/** Translate the index options into codebase-reader options (only the fields it accepts). */
function readerOptions(options: CodebaseIndexOptions): CodebaseReaderOptions {
  const opts: CodebaseReaderOptions = {};
  if (options.ignoreDirs !== undefined) opts.ignoreDirs = options.ignoreDirs;
  if (options.maxFileBytes !== undefined) opts.maxFileBytes = options.maxFileBytes;
  return opts;
}

/** An empty index (no documents) for a path that could not be scanned or has no source files. */
function emptyIndex(projectPath: string, dimensions: number): CodebaseIndex {
  return new CodebaseIndex({
    projectPath,
    documents: [],
    dimensions,
    idf: new Map(),
    unseenIdf: 1,
  });
}

/** Build the compact, multi-line summary embedded + injected for a file. */
function summarizeFile(fields: FileFields): string {
  const lines = [`File: ${fields.path}`];
  if (fields.exports.length > 0) lines.push(`Exports: ${fields.exports.join(', ')}`);
  if (fields.components.length > 0) lines.push(`Components: ${fields.components.join(', ')}`);
  if (fields.functions.length > 0) lines.push(`Functions: ${fields.functions.join('; ')}`);
  if (fields.imports.length > 0) lines.push(`Imports: ${fields.imports.join(', ')}`);
  return lines.join('\n');
}

/** Render an unknown thrown value as a short string for logging. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Prompt-injection rendering
// ---------------------------------------------------------------------------

/**
 * Render retrieved matches as a markdown "existing files" section ready to inject into a Phase 3
 * prompt (the assembler appends this so Claude knows what already exists and avoids duplicating
 * code or creating conflicts). Returns `''` when there is nothing relevant to inject.
 */
export function renderRelevantFiles(matches: readonly RagMatch[], options: RenderOptions = {}): string {
  const maxFiles = options.maxFiles ?? DEFAULT_TOP_K;
  const maxItems = options.maxItemsPerFile ?? 12;
  const minScore = options.minScore ?? 0;

  const kept = matches.filter((m) => m.score > minScore).slice(0, maxFiles);
  if (kept.length === 0) return '';

  const blocks = kept.map((match, i) => {
    const d = match.document;
    const lines = [`${i + 1}. ${d.path} (relevance ${match.score.toFixed(3)})`];
    if (d.exports.length > 0) lines.push(`   - Exports: ${elide(d.exports, maxItems)}`);
    if (d.components.length > 0) lines.push(`   - Components: ${elide(d.components, maxItems)}`);
    if (d.functions.length > 0) lines.push(`   - Functions: ${elide(d.functions, maxItems, '; ')}`);
    if (d.imports.length > 0) lines.push(`   - Imports: ${elide(d.imports, maxItems)}`);
    return lines.join('\n');
  });

  return (
    '## Existing project files relevant to this task (FORGE codebase RAG)\n\n' +
    'These files ALREADY EXIST in the target project. Reuse their exports, extend them in place, and ' +
    'import from them rather than recreating equivalent code — do not introduce duplicate or ' +
    'conflicting modules, types, or functions.\n\n' +
    blocks.join('\n')
  );
}

/** Join up to `max` items, appending a `(+N more)` note when the list is longer. */
function elide(items: readonly string[], max: number, sep = ', '): string {
  if (items.length <= max) return items.join(sep);
  return `${items.slice(0, max).join(sep)}${sep}(+${items.length - max} more)`;
}

// ---------------------------------------------------------------------------
// Lifecycle orchestrator
// ---------------------------------------------------------------------------

/**
 * Manages the codebase index across a build's lifetime (the shape the Phase 3 executor uses):
 *
 *   const rag = await CodebaseRag.create(projectPath);   // index on build start
 *   const { block } = rag.contextBlock(entry.description); // before each prompt — inject `block`
 *   ...
 *   await rag.rebuild();                                  // after each SUCCESSFUL prompt
 *
 * Every method is non-fatal: a degraded rebuild keeps the previous index and logs a warning rather
 * than throwing, so a transient scan failure never aborts the build.
 */
export class CodebaseRag {
  private index: CodebaseIndex;
  private readonly projectPath: string;
  private readonly options: CodebaseIndexOptions;
  private readonly log: (message: string) => void;

  private constructor(index: CodebaseIndex, options: CodebaseIndexOptions) {
    this.index = index;
    this.projectPath = index.projectPath;
    this.options = options;
    this.log = options.log ?? logLine('rag');
  }

  /** Build the initial index for `projectPath` (call once on build start). */
  static async create(projectPath: string, options: CodebaseIndexOptions = {}): Promise<CodebaseRag> {
    const index = await buildCodebaseIndex(projectPath, options);
    return new CodebaseRag(index, options);
  }

  /** The current underlying index (e.g. for inspection / tests). */
  get currentIndex(): CodebaseIndex {
    return this.index;
  }

  /** Number of files currently indexed. */
  get fileCount(): number {
    return this.index.size;
  }

  /** Retrieve the `topK` files most relevant to a task description. */
  query(taskText: string, topK: number = DEFAULT_TOP_K): RagMatch[] {
    return this.index.query(taskText, topK);
  }

  /**
   * Retrieve the relevant files for a task AND render them as an injectable prompt block in one
   * call. Returns the matches plus the markdown `block` (`''` when nothing is relevant).
   */
  contextBlock(
    taskText: string,
    options: { topK?: number; render?: RenderOptions } = {}
  ): { block: string; matches: RagMatch[] } {
    const topK = options.topK ?? DEFAULT_TOP_K;
    const matches = this.query(taskText, topK);
    const block = renderRelevantFiles(matches, { maxFiles: topK, ...options.render });
    return { block, matches };
  }

  /**
   * Rebuild the index from current disk state (call after each successful prompt so the next
   * retrieval reflects newly written files). Non-fatal — on failure the previous index is retained.
   */
  async rebuild(): Promise<void> {
    try {
      const rebuilt = await buildCodebaseIndex(this.projectPath, this.options);
      this.index = rebuilt;
      this.log(`index rebuilt — ${rebuilt.size} file(s)`);
    } catch (error) {
      this.log(`WARNING: index rebuild degraded (${describe(error)}) — keeping previous index`);
    }
  }
}

export default buildCodebaseIndex;
