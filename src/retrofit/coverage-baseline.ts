// FORGE 2.0 — RETROFIT: Coverage Baseline
//
// Regex-based (not AST-based) scan of a target project's src/lib/**/*.ts and
// src/components/**/*.tsx — the testable units, excluding Next.js framework entry
// points (page.tsx, route.ts, layout.tsx) which are exercised through routing and
// integration tests rather than unit tests. For every testable file, checks whether
// a co-located test file exists ({file}.test.ts, {file}.test.tsx, {file}.spec.ts, or
// __tests__/{filename}.test.ts), counts the file's exported functions/classes/
// constants, and — when a test file exists — counts its it()/test() calls as a rough
// proxy for how many of those exported symbols are actually exercised. Read-only
// against the target project; this module performs no writes of any kind.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

export interface CoverageBaselineFinding {
  filePath: string;
  hasTestFile: boolean;
  testFilePath: string | null;
  exportedSymbols: number;
  coveredSymbols: number;
  coveragePercent: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
}

interface CoverageSummary {
  totalFiles: number;
  filesWithTests: number;
  filesWithoutTests: number;
  estimatedCoveragePercent: number;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage',
  '.forge', '.claude', '.vercel', '__tests__',
]);
const LIB_FILE_RE = /\.ts$/;
const COMPONENT_FILE_RE = /\.tsx$/;
const TEST_OR_SPEC_RE = /\.(test|spec)\.tsx?$/;

// Next.js framework entry points — exercised via routing/integration tests, not unit tests.
const EXCLUDED_BASENAMES = new Set(['page.tsx', 'route.ts', 'layout.tsx']);

/** Recursively collects every file matching `fileRe` under `rootDir`, fs.readdirSync-based. */
function walkFiles(rootDir: string, fileRe: RegExp): string[] {
  const acc: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable or absent directory — skip, never throw
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
      if (!fileRe.test(entry)) continue;
      if (entry.endsWith('.d.ts')) continue;
      if (TEST_OR_SPEC_RE.test(entry)) continue; // test/spec files are not testable units themselves
      if (EXCLUDED_BASENAMES.has(entry)) continue;
      acc.push(fullPath);
    }
  }

  walk(rootDir);
  return acc;
}

function toProjectRelative(projectPath: string, absPath: string): string {
  return relative(projectPath, absPath).replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Test file resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the co-located test file for `absPath`, checking (in order):
 * {file}.test.ts, {file}.test.tsx, {file}.spec.ts, __tests__/{filename}.test.ts.
 * Returns the absolute path of the first candidate that exists on disk, or `null`.
 */
function findTestFile(absPath: string): string | null {
  const dir = dirname(absPath);
  const name = basename(absPath).replace(/\.tsx?$/, '');

  const candidates = [
    join(dir, `${name}.test.ts`),
    join(dir, `${name}.test.tsx`),
    join(dir, `${name}.spec.ts`),
    join(dir, '__tests__', `${name}.test.ts`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exported symbol counting (functions, classes, constants)
// ---------------------------------------------------------------------------

const EXPORTED_SYMBOL_PATTERNS: RegExp[] = [
  /^export\s+default\s+(?:async\s+)?function\b/,
  /^export\s+(?:async\s+)?function\s+\w+/,
  /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+\w+/,
  /^export\s+const\s+\w+/,
];

/** Counts exported functions/classes/constants declared at the top level of `content`, line by line. */
function countExportedSymbols(content: string): number {
  const lines = content.split(/\r?\n/);
  let count = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    for (const pattern of EXPORTED_SYMBOL_PATTERNS) {
      if (pattern.test(trimmed)) {
        count++;
        break; // a line matches at most one pattern — avoid double counting
      }
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Test-case counting (it()/test() calls, as a proxy for covered symbols)
// ---------------------------------------------------------------------------

const IT_CALL_RE = /\bit(?:\.(?:only|skip|each\([^)]*\)))?\s*\(/g;
const TEST_CALL_RE = /\btest(?:\.(?:only|skip|each\([^)]*\)))?\s*\(/g;

/** Counts it()/test() (incl. common .only/.skip/.each variants) calls in a test file's content. */
function countTestCases(content: string): number {
  let count = 0;
  for (const re of [IT_CALL_RE, TEST_CALL_RE]) {
    re.lastIndex = 0;
    while (re.exec(content)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Coverage percent + priority classification
// ---------------------------------------------------------------------------

/**
 * Estimated coverage percent from the it()/test() proxy: covered symbols divided by exported
 * symbols. `coveredSymbols` is expected to already be capped at `exportedSymbols` by the caller
 * (a file cannot be covered more than it has surface area). A file with zero exported symbols is
 * treated as fully covered when a test file exists (nothing to miss) and uncovered otherwise.
 */
function computeCoveragePercent(exportedSymbols: number, coveredSymbols: number, hasTestFile: boolean): number {
  if (exportedSymbols <= 0) return hasTestFile ? 100 : 0;
  const percent = (coveredSymbols / exportedSymbols) * 100;
  return Math.round(percent * 100) / 100;
}

const LIB_CORE_OR_UTILS_RE = /^src\/lib\/(core|utils)(\/|$)/;
const LIB_RE = /^src\/lib\//;
const COMPONENTS_RE = /^src\/components\//;
const LOW_COVERAGE_THRESHOLD = 50;

/**
 * critical: src/lib/core or src/lib/utils with no test file.
 * high: any other src/lib/* file with no test file.
 * medium: src/components/* with no test file.
 * low: a test file exists but estimated coverage is below the 50% threshold.
 * A file that has a test file AND coverage at/above 50% is adequately covered and
 * returns `null` — none of the four priority tiers describe "no action needed", so
 * the caller excludes such a file from the findings list entirely rather than
 * misclassifying it into a tier that implies a problem.
 */
function classifyPriority(
  relPath: string,
  hasTestFile: boolean,
  coveragePercent: number
): CoverageBaselineFinding['priority'] | null {
  if (!hasTestFile) {
    if (LIB_CORE_OR_UTILS_RE.test(relPath)) return 'critical';
    if (LIB_RE.test(relPath)) return 'high';
    if (COMPONENTS_RE.test(relPath)) return 'medium';
    return 'medium'; // unreachable given the two scan roots below — kept as a safe default
  }
  return coveragePercent < LOW_COVERAGE_THRESHOLD ? 'low' : null;
}

// ---------------------------------------------------------------------------
// Coverage summary
// ---------------------------------------------------------------------------

/** One scanned testable unit's full stats, whether or not it ends up flagged as a finding. */
interface ScannedFile {
  filePath: string;
  hasTestFile: boolean;
  testFilePath: string | null;
  exportedSymbols: number;
  coveredSymbols: number;
  coveragePercent: number;
  priority: CoverageBaselineFinding['priority'] | null;
}

/**
 * Aggregate stats across EVERY scanned testable unit, not only the ones flagged as findings —
 * total files scanned, how many have a co-located test file, how many don't, and an estimated
 * overall coverage percent (the mean of every scanned file's `coveragePercent`, including
 * adequately-covered files the findings list omits).
 */
function computeSummary(entries: ScannedFile[]): CoverageSummary {
  const totalFiles = entries.length;
  const filesWithTests = entries.filter((f) => f.hasTestFile).length;
  const filesWithoutTests = totalFiles - filesWithTests;

  const estimatedCoveragePercent =
    totalFiles === 0
      ? 0
      : Math.round((entries.reduce((sum, f) => sum + f.coveragePercent, 0) / totalFiles) * 100) / 100;

  return { totalFiles, filesWithTests, filesWithoutTests, estimatedCoveragePercent };
}

function logCoverageSummary(summary: CoverageSummary): void {
  console.log(
    `[coverage-baseline] ${summary.totalFiles} testable files — ${summary.filesWithTests} with tests, ` +
      `${summary.filesWithoutTests} without — estimated coverage ${summary.estimatedCoveragePercent}%`
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<CoverageBaselineFinding['priority'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export class CoverageBaseline {
  /**
   * Scans `<projectPath>/src/lib/**\/*.ts` and `<projectPath>/src/components/**\/*.tsx`
   * (excluding page.tsx/route.ts/layout.tsx — Next.js framework entry points exercised
   * through routing/integration tests rather than unit tests) and reports, for every
   * testable file, whether a co-located test file exists, how many of its top-level
   * functions/classes/constants are exported, and — using it()/test() call counts in
   * the test file as a rough coverage proxy — an estimated coverage percent and a
   * remediation priority. Read-only against the project; findings are returned sorted
   * by priority (critical first), then by file path.
   */
  async analyze(projectPath: string): Promise<CoverageBaselineFinding[]> {
    const libFiles = walkFiles(join(projectPath, 'src', 'lib'), LIB_FILE_RE);
    const componentFiles = walkFiles(join(projectPath, 'src', 'components'), COMPONENT_FILE_RE);
    const allFiles = [...libFiles, ...componentFiles];

    const allEntries: ScannedFile[] = [];

    for (const absPath of allFiles) {
      let content: string;
      try {
        content = readFileSync(absPath, 'utf8');
      } catch {
        continue; // unreadable file — skip, never throw
      }

      const relPath = toProjectRelative(projectPath, absPath);
      const testFileAbsPath = findTestFile(absPath);
      const hasTestFile = testFileAbsPath !== null;
      const testFilePath = testFileAbsPath ? toProjectRelative(projectPath, testFileAbsPath) : null;

      const exportedSymbols = countExportedSymbols(content);

      let coveredSymbols = 0;
      if (testFileAbsPath) {
        try {
          const rawTestCases = countTestCases(readFileSync(testFileAbsPath, 'utf8'));
          // A file's covered-symbol count can never exceed its exported-symbol count — cap it here
          // so the field means "how many exported symbols are covered", not "how many test cases exist".
          coveredSymbols = Math.min(rawTestCases, exportedSymbols);
        } catch {
          coveredSymbols = 0; // unreadable test file — treat as zero coverage, never throw
        }
      }

      const coveragePercent = computeCoveragePercent(exportedSymbols, coveredSymbols, hasTestFile);
      const priority = classifyPriority(relPath, hasTestFile, coveragePercent);

      allEntries.push({
        filePath: relPath,
        hasTestFile,
        testFilePath,
        exportedSymbols,
        coveredSymbols,
        coveragePercent,
        priority,
      });
    }

    const findings: CoverageBaselineFinding[] = [];
    for (const entry of allEntries) {
      if (entry.priority === null) continue; // adequately covered — not a finding
      findings.push({ ...entry, priority: entry.priority });
    }

    findings.sort(
      (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.filePath.localeCompare(b.filePath)
    );

    logCoverageSummary(computeSummary(allEntries));

    return findings;
  }
}

export function createCoverageBaseline(): CoverageBaseline {
  return new CoverageBaseline();
}
