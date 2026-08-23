/**
 * FORGE 2.0 — Design Pipeline: DesignSystemExtractor (`src/design-pipeline/design-system-extractor.ts`).
 *
 * `upgrades/DESIGN_INTELLIGENCE.md`'s "implicit design system" idea: most projects accumulate an
 * UNDOCUMENTED design system by repetition — the same blue hex shows up in six components, the same
 * `p-4`/`16px` spacing shows up everywhere, the same font-size keeps recurring — long before anyone
 * writes a tokens file. This module is the REAL static-analysis scan that surfaces that seed data:
 * {@link extractDesignSystem} walks a target project's actual `.tsx`/`.jsx`/`.css`/`.scss` files,
 * regex-extracts color/spacing/typography literals, and tallies which literal values repeat across
 * MULTIPLE DISTINCT FILES (never a fabricated inference — every finding is a real, counted,
 * file-attributed occurrence). `token-consolidator.ts` is the next stage: it dedupes this module's
 * raw near-identical values (`#3B82F6` vs `rgb(59,130,246)`, `16px` vs `1rem`) into a consolidated
 * token set — this module deliberately does NOT normalize anything itself, so its raw output stays
 * a faithful record of what was literally found on disk.
 *
 * PARSING APPROACH: regex-based, not AST-based — matching this codebase's own established
 * lightweight-parsing convention for source scans (`src/retrofit/dead-code-detector.ts`'s
 * line-by-line `export ...` pattern matching, `src/testing/runners/dependency-runner.ts`/
 * `license-runner.ts`'s shell-out-and-parse-text style). No AST-parsing dependency
 * (`typescript`'s compiler API, `@babel/parser`, etc.) is already a project dependency worth reusing
 * for this scope, so a full parse would be new infrastructure for a seed-data scan that regex
 * already covers adequately. `EXCLUDE_DIRS`/directory-walking mirrors `dead-code-detector.ts`'s own
 * `walkSourceFiles` exactly, for the same reason (never re-derive file-walking rules twice).
 *
 * House style, matching every sibling `src/design-pipeline/` module: {@link extractDesignSystem}
 * never throws — an unreadable file/directory is skipped, never a halting error; a project with no
 * scannable files degrades to an empty findings array, never a fabricated result.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type DesignTokenCategory = 'color' | 'spacing' | 'typography';

/** One literal value that repeats across at least `minFileCount` distinct files. */
export interface RawTokenFinding {
  /** The literal value exactly as found in source, e.g. `'#3B82F6'`, `'p-4'`, `'16px'`, `'Inter, sans-serif'`. */
  value: string;
  category: DesignTokenCategory;
  /** Total hit count across every scanned file (including repeats within the same file). */
  occurrences: number;
  /** Distinct project-relative file paths this value was found in, sorted. */
  files: string[];
  fileCount: number;
}

export interface DesignSystemExtractionResult {
  projectPath: string;
  filesScanned: number;
  /** Every value that repeats across >= `minFileCount` distinct files — the seed data for an implicit design system. */
  findings: RawTokenFinding[];
  /** Sum of ALL raw occurrences found (including values that didn't meet `minFileCount` and are not in `findings`). */
  totalRawOccurrences: number;
}

export interface ExtractDesignSystemOptions {
  /** A value must repeat across at least this many DISTINCT files to be reported as a finding. Default 2. */
  minFileCount?: number;
  /** Subdirectory to scan under `projectPath`. Default `'src'`. */
  srcSubdir?: string;
}

// ---------------------------------------------------------------------------
// File discovery (mirrors `dead-code-detector.ts`'s `walkSourceFiles`)
// ---------------------------------------------------------------------------

const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.forge', '.claude', '.vercel']);
const SCANNABLE_FILE_RE = /\.(tsx|jsx|css|scss)$/;
const DEFAULT_MIN_FILE_COUNT = 2;
const DEFAULT_SRC_SUBDIR = 'src';

function walkScannableFiles(rootDir: string): string[] {
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
      if (SCANNABLE_FILE_RE.test(entry)) acc.push(fullPath);
    }
  }

  walk(rootDir);
  return acc;
}

// ---------------------------------------------------------------------------
// Extraction patterns
// ---------------------------------------------------------------------------

const COLOR_HEX_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
const COLOR_RGB_RE = /rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*[\d.]+\s*)?\)/g;

/** Tailwind's own spacing-utility prefix vocabulary (padding/margin/gap/space shorthand + per-side). */
const SPACING_PREFIXES = [
  'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr',
  'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr',
  'gap', 'gap-x', 'gap-y', 'space-x', 'space-y',
];
const SPACING_CLASS_RE = new RegExp(`\\b(?:${SPACING_PREFIXES.join('|')})-(?:px|\\d+(?:\\.\\d+)?)\\b`, 'g');
const SPACING_CSS_DECL_RE = /\b(?:padding|margin|gap)(?:-(?:top|right|bottom|left))?\s*:\s*([^;{}]+);/gi;
const NUMERIC_LENGTH_RE = /(\d+(?:\.\d+)?(?:px|rem|em|%))/g;

const FONT_SIZE_TW_RE = /\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/g;
const FONT_FAMILY_TW_RE = /\bfont-(?:sans|serif|mono)\b/g;
const FONT_SIZE_CSS_RE = /font-size\s*:\s*([\d.]+(?:px|rem|em|%))/gi;
const FONT_FAMILY_CSS_RE = /font-family\s*:\s*([^;{}]+);/gi;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface Occurrence {
  value: string;
  category: DesignTokenCategory;
}

/** Run one global regex over `content`, pushing an `Occurrence` per match. `transform` extracts the value from the match (default: the whole match). */
function collectMatches(
  content: string,
  re: RegExp,
  category: DesignTokenCategory,
  out: Occurrence[],
  transform?: (m: RegExpExecArray) => string | null
): void {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const raw = transform ? transform(match) : match[0];
    const value = raw?.trim();
    if (value) out.push({ value, category });
    if (match[0].length === 0) re.lastIndex++; // guard against a zero-length match looping forever
  }
}

function extractOccurrences(content: string): Occurrence[] {
  const occurrences: Occurrence[] = [];

  collectMatches(content, COLOR_HEX_RE, 'color', occurrences);
  collectMatches(content, COLOR_RGB_RE, 'color', occurrences);

  collectMatches(content, SPACING_CLASS_RE, 'spacing', occurrences);

  collectMatches(content, FONT_SIZE_TW_RE, 'typography', occurrences);
  collectMatches(content, FONT_FAMILY_TW_RE, 'typography', occurrences);
  collectMatches(content, FONT_SIZE_CSS_RE, 'typography', occurrences, (m) => m[1] ?? null);
  collectMatches(content, FONT_FAMILY_CSS_RE, 'typography', occurrences, (m) => m[1] ?? null);

  // CSS padding/margin/gap declarations may carry multiple lengths in one value (e.g. `16px 24px`) —
  // pull each numeric length out of the captured declaration value separately.
  SPACING_CSS_DECL_RE.lastIndex = 0;
  let declMatch: RegExpExecArray | null;
  while ((declMatch = SPACING_CSS_DECL_RE.exec(content)) !== null) {
    const valuePart = declMatch[1] ?? '';
    NUMERIC_LENGTH_RE.lastIndex = 0;
    let lenMatch: RegExpExecArray | null;
    while ((lenMatch = NUMERIC_LENGTH_RE.exec(valuePart)) !== null) {
      if (lenMatch[1]) occurrences.push({ value: lenMatch[1], category: 'spacing' });
    }
  }

  return occurrences;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface TallyEntry {
  category: DesignTokenCategory;
  value: string;
  occurrences: number;
  files: Set<string>;
}

/**
 * Scan `<projectPath>/<srcSubdir>` for real color/spacing/typography VALUES repeated across
 * multiple `.tsx`/`.jsx`/`.css`/`.scss` files — the seed data for detecting an implicit,
 * undocumented design system. Never throws; an unreadable directory/file is skipped, and a project
 * with no scannable files or no repeated values returns an empty `findings` array (never a
 * fabricated result, per Iron Law 3).
 */
export function extractDesignSystem(projectPath: string, options: ExtractDesignSystemOptions = {}): DesignSystemExtractionResult {
  const minFileCount = options.minFileCount ?? DEFAULT_MIN_FILE_COUNT;
  const srcSubdir = options.srcSubdir ?? DEFAULT_SRC_SUBDIR;
  const rootDir = join(projectPath, srcSubdir);
  const files = walkScannableFiles(rootDir);

  const tally = new Map<string, TallyEntry>();

  for (const filePath of files) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue; // unreadable file — skip
    }
    const relPath = relative(projectPath, filePath).split('\\').join('/');

    for (const occ of extractOccurrences(content)) {
      const key = `${occ.category}::${occ.value}`;
      let entry = tally.get(key);
      if (!entry) {
        entry = { category: occ.category, value: occ.value, occurrences: 0, files: new Set() };
        tally.set(key, entry);
      }
      entry.occurrences++;
      entry.files.add(relPath);
    }
  }

  let totalRawOccurrences = 0;
  const findings: RawTokenFinding[] = [];
  for (const entry of tally.values()) {
    totalRawOccurrences += entry.occurrences;
    if (entry.files.size >= minFileCount) {
      findings.push({
        value: entry.value,
        category: entry.category,
        occurrences: entry.occurrences,
        files: [...entry.files].sort(),
        fileCount: entry.files.size,
      });
    }
  }

  findings.sort((a, b) => b.fileCount - a.fileCount || b.occurrences - a.occurrences || a.value.localeCompare(b.value));

  return { projectPath, filesScanned: files.length, findings, totalRawOccurrences };
}

export default extractDesignSystem;
