/**
 * FORGE 2.0 — Project Autopsy + Resurrection (Phase 1A feeder tool, queue.yaml s7-p03).
 *
 * Given the path to a FAILED or ABANDONED project, perform a forensic read-only
 * autopsy and produce a single `AutopsyReport` that diagnoses what went wrong,
 * judges what can be salvaged, and assembles the inputs Phase 1A needs to generate
 * a resurrection PRD — one that PRESERVES the salvageable elements and REDESIGNS the
 * rest. The report feeds Phase 1A exactly where a raw idea string normally would
 * (see {@link autopsyToPhase1aInput}); from there the build flows normally into
 * Phase 1B → 2 → 3.
 *
 * Sequence (per the s7-p03 task spec):
 *   1. Run the Codebase Reader  → readCodebase(projectPath)   (catalog everything)
 *   2. Run the Schema Extractor → extractSchema({ projectPath, sql?, supabase? })
 *   3. Analyze code quality per source file — TODO/FIXME markers, placeholder text,
 *      empty functions, mock/placeholder data, commented-out code, and (heuristic)
 *      unused imports.
 *   4. Classify every file: KEEP (quality code), REFACTOR (concept ok, impl bad),
 *      or DISCARD (broken / stub / dead).
 *   5. Extract architectural INTENT from the file structure, naming, existing docs,
 *      detected stack, routes, and schema entities.
 *   6. Diagnose the FAILURE — missing features, broken integrations, incomplete
 *      implementations.
 *   7. Produce the `AutopsyReport`: { intent, diagnosis, salvageAssessment,
 *      reconstructionInputs }.
 *
 * INTEGRATION WITH PHASE 1A. `reconstructionInputs` carries a ready-to-use `idea`
 * brief (Markdown) plus the inferred `stackFingerprint` and the structured
 * preserve/redesign lists. The orchestrator calls Phase 1A with these instead of a
 * raw idea — `autopsyToPhase1aInput(report)` returns exactly the `{ idea,
 * stackFingerprint }` `runPhase1aPrd(projectPath, idea, { stackFingerprint })`
 * consumes — so a resurrected build reuses the proven Phase 1A → 1B → 2 → 3 path
 * with no change to those phases. This mirrors how Phase 1C produces a manifest the
 * architect consumes via adapters: the producer never reaches up into the consumer,
 * so this `tools/` module imports only sibling tools + memory + types (never a
 * `phases/` module), keeping the dependency direction clean.
 *
 * Like the sibling Phase 0/1 tools (codebase-reader, schema-extractor, stack-detector,
 * env-auditor) this autopsy is best-effort and NON-FATAL: every file read is guarded,
 * missing/unreadable inputs are skipped, and a partial report is a valid result.
 * `runProjectAutopsy` never throws — the worst case is a near-empty report flagged
 * `salvageable: false` (nothing to autopsy) plus warnings.
 *
 * The code-quality analysis is intentionally LIGHTWEIGHT and heuristic (line-based
 * scans, the same register as the codebase-reader's symbol extraction), not a real
 * TypeScript/ESLint pass — it is a triage signal for an intelligence engine, not a
 * linter. Counts are approximate by design; a missed marker degrades the verdict
 * gracefully rather than failing.
 *
 * SECURITY: only structural/quality metadata is read (declaration names, marker
 * counts, table/route names, env-var NAMES referenced in `process.env.*`). No `.env*`
 * secret VALUES are parsed, and the live database connection (if any) is supplied by
 * the caller, never harvested. Nothing is written to the target project.
 */

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  readCodebase,
  type CodebaseSnapshot,
  type CodebaseReaderOptions,
  type CodeSymbol,
  type FileTreeNode,
} from './codebase-reader.js';
import {
  extractSchema,
  type SchemaSnapshot,
  type SchemaExtractorOptions,
  type SqlExecutor,
} from './schema-extractor.js';
import { detectStack, type StackFingerprint } from './stack-detector.js';
import { logLine } from './forge-logger.js';
import { nowIso } from '../memory/index.js';

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

/** How a single file is judged for salvage. */
export type FileClassification = 'keep' | 'refactor' | 'discard';

/** Per-file code-quality metrics (all best-effort, line-based heuristics). */
export interface CodeQualityMetrics {
  /** Total lines in the file. */
  lines: number;
  /** Count of TODO / FIXME / XXX / HACK markers. */
  todos: number;
  /** Count of placeholder phrases (coming soon, lorem ipsum, placeholder, TBD, …). */
  placeholders: number;
  /** Count of empty function/arrow bodies + "not implemented" stubs. */
  emptyFunctions: number;
  /** Count of mock/dummy/fake/stub data references. */
  mockHits: number;
  /** Count of commented-out CODE lines (comments that look like statements). */
  commentedOutCode: number;
  /** Count of imported bindings that appear unused in the file (heuristic). */
  unusedImports: number;
  /** Number of top-level declarations (exported + internal) in the file. */
  symbols: number;
  /** Number of EXPORTED top-level declarations (the public surface). */
  exportedSymbols: number;
}

/** The salvage verdict for one file. */
export interface FileVerdict {
  /** Project-relative POSIX path. */
  file: string;
  /** Lower-cased extension without the dot (e.g. `ts`), or `''`. */
  ext: string;
  classification: FileClassification;
  /** Human-readable justification for the classification. */
  reason: string;
  /** Quality metrics for source files; `null` for non-source assets. */
  metrics: CodeQualityMetrics | null;
}

/** The architectural intent reconstructed from structure, naming, and docs. */
export interface ArchitecturalIntent {
  projectName: string;
  /** The stack the dead project was built on (detected, immutable evidence). */
  stack: StackFingerprint;
  /** Best-effort purpose statement pulled from README/PRD/docs, or `null`. */
  inferredPurpose: string | null;
  /** Feature labels derived from page routes + feature directories. */
  detectedFeatures: string[];
  /** Domain entities derived from schema tables (else model-like interfaces). */
  entities: string[];
  /** Existing documentation files found (name + project-relative path). */
  docs: Array<{ name: string; path: string }>;
  /** Short notes on how the intent was inferred / what was missing. */
  evidence: string[];
}

/** Severity of the overall failure diagnosis. */
export type DiagnosisSeverity = 'salvageable' | 'partial' | 'severe';

/** The failure diagnosis — what is missing, broken, or incomplete. */
export interface FailureDiagnosis {
  /** Features implied by docs/naming that have no implementation. */
  missingFeatures: string[];
  /** Third-party integrations that are declared/referenced but not wired. */
  brokenIntegrations: string[];
  /** Files/areas with incomplete implementation (top offenders, with detail). */
  incompleteImplementations: string[];
  /** One-paragraph human summary of the likely failure cause. */
  summary: string;
  severity: DiagnosisSeverity;
}

/** The salvage assessment — what can be kept and at what ratio. */
export interface SalvageAssessment {
  /** Per-file verdicts (sorted: discard, then refactor, then keep; then by path). */
  files: FileVerdict[];
  counts: { keep: number; refactor: number; discard: number };
  /** Existing schema tables (data layer is generally salvageable). */
  salvageableSchemaTables: string[];
  /** Routes living in keep/refactor files (the salvageable URL surface). */
  salvageableRoutes: string[];
  /** Exported components/symbols living in keep/refactor files. */
  salvageableComponents: string[];
  /** (keep + refactor) / total classified SOURCE files, in [0, 1]. */
  salvageRatio: number;
}

/** The inputs Phase 1A consumes to generate a resurrection PRD. */
export interface ReconstructionInputs {
  /** The assembled resurrection brief (Markdown) — passed where `idea` normally is. */
  idea: string;
  /** The inferred target stack fingerprint (carried into Phase 1A similarity). */
  stackFingerprint: StackFingerprint;
  /** Elements to PRESERVE in the redesign. */
  preserve: {
    schemaTables: string[];
    routes: string[];
    components: string[];
    /** The inferred purpose + detected features, as design intent to honor. */
    designIntent: string[];
  };
  /** Elements to REDESIGN / rebuild from scratch. */
  redesign: {
    discardedFiles: string[];
    missingFeatures: string[];
    brokenIntegrations: string[];
  };
  /** Assumptions Phase 1A should flag and a human should confirm. */
  assumptions: string[];
}

/** The complete autopsy produced by {@link runProjectAutopsy}. */
export interface AutopsyReport {
  projectPath: string;
  generatedAt: string;
  /**
   * Whether the project contains prior work worth resurrecting. `false` for an
   * essentially empty directory (no source files and no schema) — the caller then
   * treats the build as greenfield.
   */
  salvageable: boolean;
  intent: ArchitecturalIntent;
  diagnosis: FailureDiagnosis;
  salvageAssessment: SalvageAssessment;
  reconstructionInputs: ReconstructionInputs;
  /** Non-fatal observations (unreadable file, no schema source, parse skip, …). */
  warnings: string[];
  /** The raw snapshots this report was derived from (for downstream consumers). */
  codebase: CodebaseSnapshot;
  schema: SchemaSnapshot;
}

/** Options for {@link runProjectAutopsy}. */
export interface ProjectAutopsyOptions {
  /** Directory names to prune from the codebase walk (forwarded to the reader). */
  ignoreDirs?: readonly string[];
  /** Live SQL executor for schema introspection (forwarded to the extractor). */
  sql?: SqlExecutor;
  /** Supabase client for schema introspection (forwarded to the extractor). */
  supabase?: SupabaseClient;
  /** Files larger than this are catalogued but not read for quality. Default 1 MB. */
  maxFileBytes?: number;
  /** Cap on source files read for quality analysis. Default 4000. */
  maxFilesAnalyzed?: number;
  /** Override the detected stack (e.g. from Phase 0); skips re-detection when set. */
  stackFingerprint?: StackFingerprint;
  /** Progress reporter. Default logs to the console with a [FORGE:autopsy] prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Source extensions whose code quality is analyzed. */
const SOURCE_EXTS: ReadonlySet<string> = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);

/** Default ceiling for reading a file's content (1 MB). */
const DEFAULT_MAX_FILE_BYTES = 1_000_000;

/** Default cap on source files read for quality analysis. */
const DEFAULT_MAX_FILES_ANALYZED = 4000;

/** TODO-style markers (word-bounded, case-insensitive). */
const TODO_RE = /\b(?:todo|fixme|xxx|hack)\b/gi;

/** Placeholder phrases that signal unfinished UI/text. */
const PLACEHOLDER_RE = /\b(?:coming soon|under construction|lorem ipsum|placeholder|tbd)\b/gi;

/** Mock/placeholder DATA references (Iron Law 8). */
const MOCK_CONTENT_RE = /\b(?:mock[a-z]*|dummy[a-z]*|fakedata|faker|sampledata|stubbed)\b/gi;

/** Basenames that mark a file as mock/placeholder data (Iron Law 8). */
const MOCK_NAME_RE = /(?:^|[-_.])(?:mocks?|placeholder|dummy|stub|fixtures?|fake|sample-data)(?:[-_.]|$)/i;

/** Directories whose files are exempt from production quality penalties (tests, etc.). */
const NON_PRODUCTION_DIR_RE = /(?:^|\/)(?:tests?|__tests__|__mocks__|e2e|spec|specs|\.storybook|stories)\//i;

/** Known service integrations: package signatures + env-var-name signature. */
const SERVICE_SIGNATURES: ReadonlyArray<{
  service: string;
  packages: readonly string[];
  env: RegExp;
}> = [
  { service: 'stripe', packages: ['stripe', '@stripe/stripe-js'], env: /STRIPE/ },
  { service: 'twilio', packages: ['twilio'], env: /TWILIO/ },
  { service: 'resend', packages: ['resend'], env: /RESEND/ },
  { service: 'mapbox', packages: ['mapbox-gl', '@mapbox'], env: /MAPBOX/ },
  { service: 'anthropic', packages: ['@anthropic-ai/sdk'], env: /ANTHROPIC/ },
  { service: 'openai', packages: ['openai', '@openai'], env: /OPENAI/ },
  { service: 'supabase', packages: ['@supabase/supabase-js'], env: /SUPABASE/ },
  { service: 'sentry', packages: ['@sentry/node', '@sentry/nextjs'], env: /SENTRY/ },
];

/** Documentation files scanned for purpose/feature intent (root + governance/). */
const DOC_NAMES: readonly string[] = ['README.md', 'PRD.md', 'BLUEPRINT.md', 'ARCHITECTURE.md', 'DESIGN.md'];

// --- Classification thresholds (named so they read as policy, not magic numbers) ---

/** Commented-out-code ratio at/above which a file of meaningful size is broken. */
const DISCARD_COMMENTED_RATIO = 0.5;
/** Minimum line count for the commented-out-ratio discard rule to apply. */
const DISCARD_MIN_LINES = 8;
/** Issue score at/above which a file with real structure needs a refactor. */
const REFACTOR_ISSUE_SCORE = 4;
/** Issue-per-line density at/above which a file needs a refactor. */
const REFACTOR_DENSITY = 0.08;

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

/** Count occurrences of a global regex in `text` (resets lastIndex defensively). */
function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

/** A flat record of one catalogued file, used by the analysis passes. */
interface FlatFile {
  /** Project-relative POSIX path. */
  path: string;
  ext: string;
  lines: number;
}

/** Flatten a {@link FileTreeNode} into a flat list of files (with ext + line count). */
function flattenFiles(root: FileTreeNode): FlatFile[] {
  const files: FlatFile[] = [];
  const visit = (node: FileTreeNode): void => {
    if (node.type === 'directory') {
      for (const child of node.children ?? []) visit(child);
    } else {
      files.push({ path: node.path, ext: node.ext ?? '', lines: node.lines ?? 0 });
    }
  };
  visit(root);
  return files;
}

// ---------------------------------------------------------------------------
// Per-file code-quality analysis (heuristic, line-based, never throws)
// ---------------------------------------------------------------------------

/** Compute the code-quality metrics for one source file's text. */
function analyzeQuality(text: string, fileSymbols: readonly CodeSymbol[]): CodeQualityMetrics {
  const lines = text === '' ? 0 : text.split(/\r?\n/).length;
  const exportedSymbols = fileSymbols.filter((s) => s.exported).length;
  return {
    lines,
    todos: countMatches(text, TODO_RE),
    placeholders: countMatches(text, PLACEHOLDER_RE),
    emptyFunctions: countEmptyFunctions(text),
    mockHits: countMatches(text, MOCK_CONTENT_RE),
    commentedOutCode: countCommentedOutCode(text),
    unusedImports: countUnusedImports(text),
    symbols: fileSymbols.length,
    exportedSymbols,
  };
}

/** Count empty function/arrow bodies and explicit "not implemented" stubs. */
function countEmptyFunctions(text: string): number {
  let count = 0;
  count += countMatches(text, /=>\s*\{\s*\}/g); // arrow with empty body
  count += countMatches(text, /function\b[^(){};]*\([^)]*\)\s*(?::[^{;]+)?\{\s*\}/g); // fn keyword, empty body
  count += countMatches(text, /throw\s+new\s+\w*error\s*\(\s*['"][^'"]*not\s+implemented[^'"]*['"]/gi);
  return count;
}

/**
 * Count commented-out CODE lines — comment lines (line or block) whose body looks
 * like a statement rather than prose/JSDoc. Best-effort: prose and `@`-tag JSDoc
 * lines and bare URLs are excluded by the code-signal test.
 */
function countCommentedOutCode(text: string): number {
  const lines = text.split(/\r?\n/);
  const codeSignal = /(?:;\s*$|=>|\bfunction\b|\bconst\s|\blet\s|\bvar\s|\breturn\b|\bimport\s|^[}{]\s*$|\)\s*\{|=\s*[^=])/;
  let count = 0;
  let inBlock = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      const body = line.replace(/^\*+\/?/, '').replace(/\*\/.*$/, '').trim();
      if (body !== '' && !body.startsWith('@') && codeSignal.test(body)) count++;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      const body = line.replace(/^\/\*+/, '').replace(/\*\/.*$/, '').trim();
      if (body !== '' && !body.startsWith('@') && codeSignal.test(body)) count++;
      continue;
    }
    if (line.startsWith('//')) {
      const body = line.slice(2).trim();
      if (body !== '' && !/^https?:/.test(body) && codeSignal.test(body)) count++;
    }
  }
  return count;
}

/** Match every `import [type] <clause> from '...'` statement (clause in group 1). */
const IMPORT_CLAUSE_RE = /import\s+(?:type\s+)?([^;'"]*?)\s+from\s+['"][^'"]+['"]\s*;?/g;

/** Count imported bindings that never appear elsewhere in the file (heuristic). */
function countUnusedImports(text: string): number {
  const bindings: string[] = [];
  IMPORT_CLAUSE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_CLAUSE_RE.exec(text)) !== null) {
    const clause = m[1];
    if (clause === undefined) continue;
    bindings.push(...bindingsFromClause(clause));
  }
  if (bindings.length === 0) return 0;

  // Usage corpus: the file with all import statements stripped, tokenized.
  const stripped = text.replace(IMPORT_CLAUSE_RE, ' ');
  const used = new Set(stripped.match(/[A-Za-z_$][\w$]*/g) ?? []);

  let unused = 0;
  for (const name of bindings) if (!used.has(name)) unused++;
  return unused;
}

/** Extract bound identifier names from one import clause (default / named / namespace). */
function bindingsFromClause(clause: string): string[] {
  const names: string[] = [];
  const c = clause.trim();
  if (c === '') return names;

  // Namespace: `* as ns`
  const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(c);
  if (ns && ns[1]) {
    names.push(ns[1]);
    return names;
  }

  const braceIdx = c.indexOf('{');
  const defaultPart = (braceIdx >= 0 ? c.slice(0, braceIdx) : c).replace(/,\s*$/, '').trim();
  if (defaultPart !== '' && /^[A-Za-z_$][\w$]*$/.test(defaultPart)) names.push(defaultPart);

  if (braceIdx >= 0) {
    const close = c.indexOf('}', braceIdx);
    const inner = c.slice(braceIdx + 1, close < 0 ? c.length : close);
    for (const piece of inner.split(',')) {
      const p = piece.trim();
      if (p === '') continue;
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(p);
      const raw = asMatch && asMatch[1] ? asMatch[1] : (p.split(/\s+/)[0] ?? '');
      const clean = raw.replace(/^type\s+/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(clean)) names.push(clean);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// File classification (keep / refactor / discard)
// ---------------------------------------------------------------------------

/** Group a file's top-level symbols by their declaring file. */
function symbolsByFile(components: readonly CodeSymbol[]): Map<string, CodeSymbol[]> {
  const map = new Map<string, CodeSymbol[]>();
  for (const sym of components) {
    const list = map.get(sym.file);
    if (list) list.push(sym);
    else map.set(sym.file, [sym]);
  }
  return map;
}

/** Classify one source file from its metrics. */
function classifySourceFile(file: FlatFile, metrics: CodeQualityMetrics): FileVerdict {
  const { lines, todos, placeholders, emptyFunctions, mockHits, commentedOutCode, unusedImports } = metrics;
  const symbols = metrics.symbols;
  const isProduction = !NON_PRODUCTION_DIR_RE.test(file.path);
  const commentedRatio = lines > 0 ? commentedOutCode / lines : 0;

  // --- DISCARD: structurally broken / dead ---------------------------------
  if (commentedRatio >= DISCARD_COMMENTED_RATIO && lines >= DISCARD_MIN_LINES) {
    return verdict(file, 'discard', `Over half the file (${commentedOutCode}/${lines} lines) is commented-out code — dead.`, metrics);
  }
  if (symbols === 0 && lines >= 4 && (placeholders > 0 || todos > 0 || emptyFunctions > 0)) {
    return verdict(file, 'discard', 'No real declarations — only placeholders/TODOs/empty bodies (a stub).', metrics);
  }
  if (symbols > 0 && emptyFunctions >= symbols && emptyFunctions >= 2) {
    return verdict(file, 'discard', `Every declaration is an empty/unimplemented body (${emptyFunctions} of ${symbols}).`, metrics);
  }

  // --- REFACTOR: concept ok, implementation poor ---------------------------
  const issueScore =
    todos + placeholders * 2 + emptyFunctions * 2 + mockHits + Math.ceil(commentedOutCode / 2) + unusedImports;
  const density = lines > 0 ? issueScore / lines : issueScore;

  if (isProduction && mockHits > 0) {
    return verdict(file, 'refactor', `Uses mock/placeholder data (${mockHits} hit(s)) — must move to real data before reuse (Iron Law 8).`, metrics);
  }
  if (emptyFunctions > 0 && symbols > 0) {
    return verdict(file, 'refactor', `Has real structure but ${emptyFunctions} unimplemented function body(ies) to complete.`, metrics);
  }
  if (issueScore >= REFACTOR_ISSUE_SCORE || density >= REFACTOR_DENSITY) {
    const bits: string[] = [];
    if (todos > 0) bits.push(`${todos} TODO/FIXME`);
    if (placeholders > 0) bits.push(`${placeholders} placeholder(s)`);
    if (commentedOutCode > 0) bits.push(`${commentedOutCode} commented-out line(s)`);
    if (unusedImports > 0) bits.push(`${unusedImports} unused import(s)`);
    return verdict(file, 'refactor', `Salvageable concept with quality debt: ${bits.join(', ') || 'elevated issue density'}.`, metrics);
  }

  // --- KEEP: quality code --------------------------------------------------
  return verdict(file, 'keep', 'Quality code — low issue density; reuse as-is.', metrics);
}

/** Construct a {@link FileVerdict} (small helper to keep classification terse). */
function verdict(
  file: FlatFile,
  classification: FileClassification,
  reason: string,
  metrics: CodeQualityMetrics | null
): FileVerdict {
  return { file: file.path, ext: file.ext, classification, reason, metrics };
}

/** Classify a NON-source asset (config, json, css, md, sql, image, …). */
function classifyAsset(file: FlatFile): FileVerdict {
  const name = baseName(file.path);
  if (MOCK_NAME_RE.test(name) && !NON_PRODUCTION_DIR_RE.test(file.path)) {
    return verdict(file, 'discard', 'Mock/placeholder data file in the source tree (Iron Law 8).', null);
  }
  return verdict(file, 'keep', 'Non-source asset (not code-quality assessed).', null);
}

/** Numeric rank so verdicts sort discard → refactor → keep. */
function classificationRank(c: FileClassification): number {
  return c === 'discard' ? 0 : c === 'refactor' ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Architectural-intent extraction
// ---------------------------------------------------------------------------

/** Read the first documentation file found and pull a purpose statement from it. */
async function inferPurpose(
  projectPath: string,
  docs: ReadonlyArray<{ name: string; path: string }>
): Promise<string | null> {
  for (const doc of docs) {
    const text = await readTextSafe(join(projectPath, doc.path));
    if (text === null) continue;
    const purpose = firstParagraph(text);
    if (purpose !== null) return purpose;
  }
  return null;
}

/** Extract the first heading + first non-heading paragraph from a Markdown doc. */
function firstParagraph(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  let title: string | null = null;
  const para: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      if (para.length > 0) break;
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading && heading[1]) {
      if (title === null) title = heading[1].trim();
      continue;
    }
    if (line.startsWith('>') || line.startsWith('![') || line.startsWith('---')) continue;
    para.push(line);
  }
  const body = para.join(' ').replace(/\s+/g, ' ').trim();
  const combined = [title, body].filter((s): s is string => s !== null && s !== '').join(' — ');
  if (combined === '') return null;
  return combined.length > 400 ? `${combined.slice(0, 399)}…` : combined;
}

/**
 * Find documentation files anywhere in the catalogued tree, by basename. Uses the
 * flat file list (not the reader's `governanceDocs`, which is limited to FORGE's own
 * governance set and excludes README/ARCHITECTURE/etc.). Root-level docs sort first.
 */
function findDocs(flatFiles: readonly FlatFile[]): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  const seen = new Set<string>();
  for (const file of flatFiles) {
    const name = baseName(file.path);
    if (!DOC_NAMES.includes(name) || seen.has(file.path)) continue;
    seen.add(file.path);
    out.push({ name, path: file.path });
  }
  // Prefer shallow paths (root README over a nested one), then a stable name order.
  out.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  return out;
}

/** Derive feature labels from page routes (api routes excluded). */
function featuresFromRoutes(codebase: CodebaseSnapshot): string[] {
  const set = new Set<string>();
  for (const r of codebase.routes) {
    if (r.kind !== 'page') continue;
    const segs = r.route.split('/').filter((s) => s !== '' && !s.startsWith(':') && !s.startsWith('*'));
    set.add(segs.length > 0 ? segs.join(' › ') : 'home');
  }
  return [...set].sort();
}

/** Derive domain entities from schema tables, falling back to model-like interfaces. */
function deriveEntities(schema: SchemaSnapshot, codebase: CodebaseSnapshot): string[] {
  if (schema.tables.length > 0) {
    return schema.tables.map((t) => t.name).sort();
  }
  // No schema → guess from exported interfaces/types that look like models.
  const skip = /(props|options|result|state|config|context|params|input|output|response|request)$/i;
  const names = new Set<string>();
  for (const sym of codebase.components) {
    if (!sym.exported) continue;
    if (sym.kind !== 'interface' && sym.kind !== 'type') continue;
    if (/^[A-Z]/.test(sym.name) && !skip.test(sym.name)) names.add(sym.name);
  }
  return [...names].sort().slice(0, 20);
}

// ---------------------------------------------------------------------------
// Failure diagnosis
// ---------------------------------------------------------------------------

/** Collect imported package roots and referenced env-var names across source files. */
interface CodeSignals {
  /** Non-relative package roots imported anywhere (e.g. `stripe`, `@supabase/supabase-js`). */
  importedPackages: Set<string>;
  /** `process.env.NAME` names referenced anywhere. */
  envVars: Set<string>;
  /** Whether an `.env*` file exists in the project. */
  hasEnvFile: boolean;
}

/** Reduce an import specifier to its package root (`@scope/name` or `name`). */
function packageRoot(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null; // relative — not a package
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? specifier);
  }
  return parts[0] ?? specifier;
}

/** Scan a file's text for imported packages and referenced env vars (mutates `signals`). */
function collectSignals(text: string, signals: CodeSignals): void {
  const specRe = /(?:from|require\s*\()\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = specRe.exec(text)) !== null) {
    const spec = m[1];
    if (spec === undefined) continue;
    const root = packageRoot(spec);
    if (root !== null) signals.importedPackages.add(root.toLowerCase());
  }
  const envRe = /process\.env\.([A-Z0-9_]+)|process\.env\[\s*['"]([A-Z0-9_]+)['"]\s*\]/g;
  while ((m = envRe.exec(text)) !== null) {
    const name = m[1] ?? m[2];
    if (name) signals.envVars.add(name);
  }
}

/** Diagnose broken/unwired third-party integrations from deps + code signals. */
function diagnoseIntegrations(codebase: CodebaseSnapshot, schema: SchemaSnapshot, signals: CodeSignals): string[] {
  const out: string[] = [];
  const depNames = new Set(codebase.dependencies.map((d) => d.name.toLowerCase()));

  for (const sig of SERVICE_SIGNATURES) {
    const declared = sig.packages.some((p) => depNames.has(p.toLowerCase()));
    const imported = sig.packages.some((p) => signals.importedPackages.has(p.toLowerCase()));
    const envReferenced = [...signals.envVars].some((v) => sig.env.test(v));

    if (declared && !imported && !envReferenced) {
      out.push(`${sig.service}: dependency declared but never imported or configured — dead integration.`);
    } else if ((imported || envReferenced) && !signals.hasEnvFile) {
      out.push(`${sig.service}: referenced in code but no .env/.env.example was found — integration unconfigured.`);
    } else if (imported && !declared) {
      out.push(`${sig.service}: imported in code but missing from package.json dependencies — install will fail.`);
    }
  }

  // Dangling foreign keys are broken data-layer integrations.
  const knownTables = new Set(schema.tables.map((t) => t.name));
  for (const rel of schema.relationships) {
    if (!knownTables.has(rel.toTable)) {
      out.push(`schema: '${rel.fromTable}' has a foreign key to missing table '${rel.toTable}' — broken relationship.`);
    }
  }
  return [...new Set(out)];
}

/** Diagnose missing features: doc-implied features with no route/component/path match. */
async function diagnoseMissingFeatures(
  projectPath: string,
  docs: ReadonlyArray<{ name: string; path: string }>,
  codebase: CodebaseSnapshot
): Promise<string[]> {
  // Build a corpus of what the project implements (routes + symbols + file paths).
  const corpus = new Set<string>();
  for (const r of codebase.routes) for (const tok of tokenize(r.route)) corpus.add(tok);
  for (const s of codebase.components) for (const tok of tokenize(s.name)) corpus.add(tok);
  for (const node of flattenFiles(codebase.fileTree)) for (const tok of tokenize(node.path)) corpus.add(tok);

  const candidates = new Set<string>();
  for (const doc of docs) {
    const text = await readTextSafe(join(projectPath, doc.path));
    if (text === null) continue;
    for (const feature of candidateFeaturesFromDoc(text)) candidates.add(feature);
  }

  const missing: string[] = [];
  for (const feature of candidates) {
    const tokens = tokenize(feature).filter((t) => t.length >= 4);
    if (tokens.length === 0) continue;
    const implemented = tokens.some((t) => corpus.has(t));
    if (!implemented) missing.push(feature);
    if (missing.length >= 12) break;
  }
  return missing;
}

/** Lower-cased word tokens of length ≥ 3 from an arbitrary string. */
function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []);
}

/** Pull candidate feature phrases from a doc's bullet lines and sub-headings. */
function candidateFeaturesFromDoc(markdown: string): string[] {
  const out: string[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const bullet = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    const heading = /^#{2,4}\s+(.*)$/.exec(line);
    const captured = (bullet && bullet[1]) || (heading && heading[1]) || '';
    const clean = captured
      .replace(/^[A-Za-z]\d+[:.]\s*/, '') // strip "F1:" / "F3." feature prefixes
      .replace(/[`*_]/g, '')
      .replace(/[:.].*$/, '')
      .trim();
    if (clean.length >= 4 && clean.length <= 80 && /[a-z]/i.test(clean)) out.push(clean);
    if (out.length >= 60) break;
  }
  return out;
}

/** Assemble the incomplete-implementation list from the worst-offending files. */
function diagnoseIncomplete(verdicts: readonly FileVerdict[]): string[] {
  const offenders = verdicts
    .filter((v) => v.classification !== 'keep' && v.metrics !== null)
    .map((v) => ({ v, score: issueScoreOf(v.metrics as CodeQualityMetrics) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
  return offenders.map(({ v }) => `${v.file} — ${v.reason}`);
}

/** Aggregate issue score for a metrics record (mirrors the classifier weighting). */
function issueScoreOf(m: CodeQualityMetrics): number {
  return m.todos + m.placeholders * 2 + m.emptyFunctions * 2 + m.mockHits + Math.ceil(m.commentedOutCode / 2) + m.unusedImports;
}

// ---------------------------------------------------------------------------
// Reconstruction-input assembly (the Phase 1A brief)
// ---------------------------------------------------------------------------

/** Build the Markdown resurrection brief Phase 1A consumes in place of a raw idea. */
function buildResurrectionIdea(
  intent: ArchitecturalIntent,
  diagnosis: FailureDiagnosis,
  salvage: SalvageAssessment
): string {
  const lines: string[] = [];
  lines.push(`# Resurrection brief: ${intent.projectName}`);
  lines.push('');
  lines.push(
    'This is a RESURRECTION of a failed/abandoned project. Generate a PRD that PRESERVES the ' +
      'salvageable elements below and REDESIGNS the rest. Do not re-derive decisions that the ' +
      'preserved schema/routes/components already fix.'
  );
  lines.push('');

  lines.push('## Original intent');
  lines.push(intent.inferredPurpose ?? '_(no purpose statement recovered from docs — infer from the entities/features below)_');
  if (intent.detectedFeatures.length > 0) {
    lines.push('');
    lines.push('Detected features:');
    for (const f of intent.detectedFeatures) lines.push(`- ${f}`);
  }
  lines.push('');

  lines.push('## Preserve (salvageable — keep these decisions fixed)');
  lines.push(`- Schema tables: ${listOrNone(salvage.salvageableSchemaTables)}`);
  lines.push(`- Routes: ${listOrNone(salvage.salvageableRoutes)}`);
  lines.push(`- Components: ${listOrNone(salvage.salvageableComponents.slice(0, 40))}`);
  lines.push(`- Salvage ratio: ${(salvage.salvageRatio * 100).toFixed(0)}% of source files are keep/refactor.`);
  lines.push('');

  lines.push('## Redesign (rebuild from scratch)');
  lines.push(`- Missing features: ${listOrNone(diagnosis.missingFeatures)}`);
  lines.push(`- Broken integrations: ${listOrNone(diagnosis.brokenIntegrations)}`);
  lines.push(`- Discarded files: ${salvage.counts.discard} (broken/stub/dead — see the autopsy report).`);
  lines.push('');

  lines.push('## Known failure diagnosis');
  lines.push(`- Severity: ${diagnosis.severity}`);
  lines.push(diagnosis.summary);
  lines.push('');

  return lines.join('\n');
}

/** Render a comma list, or an em dash when empty. */
function listOrNone(items: readonly string[]): string {
  return items.length > 0 ? items.join(', ') : '—';
}

// ---------------------------------------------------------------------------
// Markdown rendering (operator-facing; no file is written by the autopsy)
// ---------------------------------------------------------------------------

/** Render a human-readable summary of an {@link AutopsyReport}. */
export function renderAutopsyReportMarkdown(report: AutopsyReport): string {
  const lines: string[] = [];
  const r = report;
  lines.push(`# PROJECT AUTOPSY — ${r.intent.projectName}`);
  lines.push('');
  lines.push(`- **Project:** ${r.projectPath}`);
  lines.push(`- **Generated:** ${r.generatedAt}`);
  lines.push(`- **Salvageable:** ${r.salvageable ? 'yes' : 'no (empty/greenfield — nothing to autopsy)'}`);
  lines.push(
    `- **Files:** ${r.salvageAssessment.counts.keep} keep · ${r.salvageAssessment.counts.refactor} refactor · ${r.salvageAssessment.counts.discard} discard ` +
      `(salvage ${(r.salvageAssessment.salvageRatio * 100).toFixed(0)}%)`
  );
  lines.push(`- **Diagnosis severity:** ${r.diagnosis.severity}`);
  lines.push('');

  lines.push('## Architectural Intent');
  lines.push(`- Purpose: ${r.intent.inferredPurpose ?? '_(not recovered)_'}`);
  lines.push(`- Stack: framework=${r.intent.stack.framework ?? '—'}, database=${r.intent.stack.database ?? '—'}, services=[${r.intent.stack.services.join(', ') || '—'}]`);
  lines.push(`- Entities: ${listOrNone(r.intent.entities)}`);
  lines.push(`- Features: ${listOrNone(r.intent.detectedFeatures)}`);
  lines.push('');

  lines.push('## Failure Diagnosis');
  lines.push(r.diagnosis.summary);
  lines.push(`- Missing features (${r.diagnosis.missingFeatures.length}):`);
  for (const f of r.diagnosis.missingFeatures) lines.push(`  - ${f}`);
  lines.push(`- Broken integrations (${r.diagnosis.brokenIntegrations.length}):`);
  for (const f of r.diagnosis.brokenIntegrations) lines.push(`  - ${f}`);
  lines.push(`- Incomplete implementations (${r.diagnosis.incompleteImplementations.length}):`);
  for (const f of r.diagnosis.incompleteImplementations) lines.push(`  - ${f}`);
  lines.push('');

  lines.push(`## Salvage Assessment (${r.salvageAssessment.files.length} files)`);
  for (const v of r.salvageAssessment.files) {
    const mark = v.classification === 'discard' ? '❌' : v.classification === 'refactor' ? '⚠️' : '✅';
    lines.push(`- ${mark} \`${v.file}\` [${v.classification}] — ${v.reason}`);
  }
  lines.push('');

  if (r.warnings.length > 0) {
    lines.push('## Warnings');
    for (const w of r.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Phase 1A integration adapter
// ---------------------------------------------------------------------------

/**
 * Adapt an {@link AutopsyReport} into the inputs Phase 1A consumes in place of a raw
 * idea string. The orchestrator calls:
 *
 *   const input = autopsyToPhase1aInput(report);
 *   await runPhase1aPrd(report.projectPath, input.idea, { stackFingerprint: input.stackFingerprint });
 *
 * so a resurrected build reuses the proven Phase 1A → 1B → 2 → 3 path unchanged. The
 * `idea` is the resurrection brief (preserve + redesign), and `stackFingerprint` is
 * the dead project's detected stack so Phase 1A's similarity search is grounded in it.
 */
export function autopsyToPhase1aInput(report: AutopsyReport): { idea: string; stackFingerprint: StackFingerprint } {
  return {
    idea: report.reconstructionInputs.idea,
    stackFingerprint: report.reconstructionInputs.stackFingerprint,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a forensic autopsy on the failed/abandoned project at `projectPath`, producing
 * an {@link AutopsyReport}.
 *
 * Always resolves (never rejects). For an empty/greenfield directory the report's
 * salvage sets are empty and `salvageable` is false; the caller then treats the build
 * as greenfield. When a live `sql`/`supabase` connection is supplied it is forwarded
 * to the Schema Extractor so the diagnosis reflects real database state. Nothing is
 * written to the target project.
 */
export async function runProjectAutopsy(
  projectPath: string,
  options: ProjectAutopsyOptions = {}
): Promise<AutopsyReport> {
  const log = options.log ?? logLine('autopsy');
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFilesAnalyzed = options.maxFilesAnalyzed ?? DEFAULT_MAX_FILES_ANALYZED;
  const warnings: string[] = [];

  // 1. Run the Codebase Reader ----------------------------------------------
  log(`reading codebase at ${projectPath}`);
  const readerOptions: CodebaseReaderOptions = { maxFileBytes };
  if (options.ignoreDirs) readerOptions.ignoreDirs = options.ignoreDirs;
  const codebase = await readCodebase(projectPath, readerOptions);
  log(`codebase: ${codebase.stats.totalFiles} files, ${codebase.components.length} symbols, ${codebase.routes.length} routes`);

  // 2. Run the Schema Extractor ---------------------------------------------
  log('extracting schema');
  const schemaOptions: SchemaExtractorOptions = { projectPath };
  if (options.sql) schemaOptions.sql = options.sql;
  if (options.supabase) schemaOptions.supabase = options.supabase;
  const schema = await extractSchema(schemaOptions);
  warnings.push(...schema.warnings);
  log(`schema: ${schema.tables.length} tables (source=${schema.source})`);

  // 3-4. Per-file code-quality analysis + classification --------------------
  const flatFiles = flattenFiles(codebase.fileTree);
  const symbolMap = symbolsByFile(codebase.components);
  const signals: CodeSignals = {
    importedPackages: new Set<string>(),
    envVars: new Set<string>(),
    hasEnvFile: flatFiles.some((f) => baseName(f.path).startsWith('.env')),
  };

  const verdicts: FileVerdict[] = [];
  let analyzed = 0;
  for (const file of flatFiles) {
    if (!SOURCE_EXTS.has(file.ext)) {
      verdicts.push(classifyAsset(file));
      continue;
    }
    if (analyzed >= maxFilesAnalyzed) {
      verdicts.push(verdict(file, 'keep', 'Source file beyond the analysis cap — not quality-assessed.', null));
      continue;
    }
    const text = await readTextSafe(join(projectPath, file.path));
    if (text === null) {
      warnings.push(`Could not read source file ${file.path} for quality analysis`);
      verdicts.push(verdict(file, 'refactor', 'Source file could not be read for quality analysis — review manually.', null));
      continue;
    }
    analyzed++;
    collectSignals(text, signals);
    const metrics = analyzeQuality(text, symbolMap.get(file.path) ?? []);
    verdicts.push(classifySourceFile(file, metrics));
  }
  verdicts.sort(
    (a, b) => classificationRank(a.classification) - classificationRank(b.classification) || a.file.localeCompare(b.file)
  );
  log(`analyzed ${analyzed} source file(s); ${flatFiles.length} files classified`);

  // 5. Architectural intent --------------------------------------------------
  const stack = options.stackFingerprint ?? (await detectStack(projectPath));
  const docs = findDocs(flatFiles);
  const intent: ArchitecturalIntent = {
    projectName: basename(projectPath) || 'project',
    stack,
    inferredPurpose: await inferPurpose(projectPath, docs),
    detectedFeatures: featuresFromRoutes(codebase),
    entities: deriveEntities(schema, codebase),
    docs,
    evidence: buildIntentEvidence(codebase, schema, docs),
  };

  // 6. Failure diagnosis -----------------------------------------------------
  const missingFeatures = await diagnoseMissingFeatures(projectPath, docs, codebase);
  const brokenIntegrations = diagnoseIntegrations(codebase, schema, signals);
  const incompleteImplementations = diagnoseIncomplete(verdicts);

  // 4 (cont.) Salvage assessment --------------------------------------------
  const salvageAssessment = buildSalvageAssessment(verdicts, schema, codebase);

  const diagnosis: FailureDiagnosis = {
    missingFeatures,
    brokenIntegrations,
    incompleteImplementations,
    severity: gradeSeverity(salvageAssessment, missingFeatures, brokenIntegrations),
    summary: buildDiagnosisSummary(salvageAssessment, missingFeatures, brokenIntegrations, incompleteImplementations),
  };

  // 7. Reconstruction inputs (the Phase 1A brief) ---------------------------
  const idea = buildResurrectionIdea(intent, diagnosis, salvageAssessment);
  const reconstructionInputs: ReconstructionInputs = {
    idea,
    stackFingerprint: stack,
    preserve: {
      schemaTables: salvageAssessment.salvageableSchemaTables,
      routes: salvageAssessment.salvageableRoutes,
      components: salvageAssessment.salvageableComponents,
      designIntent: [
        ...(intent.inferredPurpose ? [intent.inferredPurpose] : []),
        ...intent.detectedFeatures,
      ],
    },
    redesign: {
      discardedFiles: verdicts.filter((v) => v.classification === 'discard').map((v) => v.file),
      missingFeatures,
      brokenIntegrations,
    },
    assumptions: buildAssumptions(intent, salvageAssessment),
  };

  const salvageable = codebase.stats.sourceFiles > 0 || schema.tables.length > 0;

  log(
    salvageable
      ? `autopsy complete — ${salvageAssessment.counts.keep} keep / ${salvageAssessment.counts.refactor} refactor / ${salvageAssessment.counts.discard} discard; severity ${diagnosis.severity}`
      : 'autopsy complete — no prior work found (greenfield; nothing to salvage)'
  );

  return {
    projectPath,
    generatedAt: nowIso(),
    salvageable,
    intent,
    diagnosis,
    salvageAssessment,
    reconstructionInputs,
    warnings,
    codebase,
    schema,
  };
}

/** Build the per-component salvage assessment from the file verdicts. */
function buildSalvageAssessment(
  verdicts: readonly FileVerdict[],
  schema: SchemaSnapshot,
  codebase: CodebaseSnapshot
): SalvageAssessment {
  const counts = { keep: 0, refactor: 0, discard: 0 };
  const sourceVerdicts: FileVerdict[] = [];
  const salvageableFiles = new Set<string>();
  for (const v of verdicts) {
    if (SOURCE_EXTS.has(v.ext)) {
      counts[v.classification]++;
      sourceVerdicts.push(v);
    }
    if (v.classification !== 'discard') salvageableFiles.add(v.file);
  }

  const salvageableRoutes = codebase.routes
    .filter((r) => salvageableFiles.has(r.file))
    .map((r) => r.route);
  const salvageableComponents = codebase.components
    .filter((s) => s.exported && salvageableFiles.has(s.file))
    .map((s) => s.name);

  const totalSource = sourceVerdicts.length;
  const salvageRatio = totalSource > 0 ? (counts.keep + counts.refactor) / totalSource : 0;

  return {
    files: [...verdicts],
    counts,
    salvageableSchemaTables: schema.tables.map((t) => t.name).sort(),
    salvageableRoutes: [...new Set(salvageableRoutes)].sort(),
    salvageableComponents: [...new Set(salvageableComponents)].sort(),
    salvageRatio: Math.round(salvageRatio * 1000) / 1000,
  };
}

/** Grade overall diagnosis severity from the salvage ratio + failure counts. */
function gradeSeverity(
  salvage: SalvageAssessment,
  missing: readonly string[],
  broken: readonly string[]
): DiagnosisSeverity {
  const failures = missing.length + broken.length;
  if (salvage.salvageRatio >= 0.7 && failures <= 2) return 'salvageable';
  if (salvage.salvageRatio >= 0.4 || failures <= 6) return 'partial';
  return 'severe';
}

/** Compose the one-paragraph human diagnosis summary. */
function buildDiagnosisSummary(
  salvage: SalvageAssessment,
  missing: readonly string[],
  broken: readonly string[],
  incomplete: readonly string[]
): string {
  const total = salvage.counts.keep + salvage.counts.refactor + salvage.counts.discard;
  return (
    `Of ${total} source file(s), ${salvage.counts.keep} are reusable, ${salvage.counts.refactor} need ` +
    `refactoring, and ${salvage.counts.discard} are broken/dead (salvage ${(salvage.salvageRatio * 100).toFixed(0)}%). ` +
    `${missing.length} feature(s) appear unimplemented, ${broken.length} integration(s) are unwired, and ` +
    `${incomplete.length} file(s) carry incomplete implementations. The likely failure cause is ` +
    `${failureCause(salvage, missing, broken)}.`
  );
}

/** A short clause naming the most likely failure cause. */
function failureCause(salvage: SalvageAssessment, missing: readonly string[], broken: readonly string[]): string {
  if (salvage.counts.discard > salvage.counts.keep) return 'pervasive stubs/dead code (the build stalled before implementation)';
  if (broken.length > missing.length && broken.length > 0) return 'unwired third-party integrations';
  if (missing.length > 0) return 'unfinished feature scope (design outran implementation)';
  return 'accumulated quality debt rather than a single structural break';
}

/** Notes on how the intent was inferred / what evidence was thin. */
function buildIntentEvidence(
  codebase: CodebaseSnapshot,
  schema: SchemaSnapshot,
  docs: ReadonlyArray<{ name: string; path: string }>
): string[] {
  const evidence: string[] = [];
  evidence.push(docs.length > 0 ? `Purpose/features read from ${docs.map((d) => d.name).join(', ')}.` : 'No docs found — intent inferred from structure only.');
  evidence.push(`${schema.tables.length} schema table(s) define the data model.`);
  evidence.push(`${codebase.routes.length} route(s) and ${codebase.components.filter((s) => s.exported).length} exported symbol(s) define the surface.`);
  return evidence;
}

/** Assumptions Phase 1A should flag for human confirmation at Gate 1. */
function buildAssumptions(intent: ArchitecturalIntent, salvage: SalvageAssessment): string[] {
  const assumptions: string[] = [];
  if (intent.inferredPurpose === null) {
    assumptions.push('No purpose statement was recovered — the resurrection intent is inferred from entities/routes and must be confirmed.');
  }
  if (salvage.salvageableSchemaTables.length > 0) {
    assumptions.push('Existing schema tables are assumed correct and preserved as-is; verify columns/RLS before reuse.');
  }
  if (intent.stack.framework === null) {
    assumptions.push('The framework could not be detected with confidence — defaulting to the FORGE stack unless overridden.');
  }
  return assumptions;
}

export default runProjectAutopsy;
