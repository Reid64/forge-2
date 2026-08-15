/**
 * FORGE 2.0 — Change-Impact / Blast-Radius Analysis.
 *
 * `upgrades/ENGINEERING_COMPLETENESS.md` § "6. Dependency graph intelligence" /
 * `upgrades/SYSTEMS-5-9-GAP-MATRIX.md` row 6: "Every modification should trigger the question:
 * 'What else could this affect?' FORGE should calculate a blast radius... Then FORGE determines
 * the minimum safe validation set. This saves tokens and time while improving safety."
 *
 * Built entirely on real, already-parsed project structure — no invented signal, no new table.
 * The reverse-dependency graph reuses Architecture Guardian's own import-graph machinery
 * (`src/tools/architecture-guard.ts` — `parseImports`/`parseExports`/`buildDependencyGraph`/
 * `resolveSpecifier`, the same parser its circular-dependency detector already runs against every
 * build), inverted from "what does file X import" to "what imports file X" and walked
 * breadth-first to find every file transitively affected by a change. "Changed files" is either
 * supplied explicitly (the exact files a Phase 3 prompt just wrote) or auto-detected from real git
 * state (`git diff` against HEAD + untracked files) — never guessed.
 *
 * NON-FATAL house style (matching the sibling `src/governance/` modules): an unreadable file, a
 * non-git directory, or a project with zero matching source files all degrade to an empty/partial
 * result rather than throwing. `analyzeBlastRadius` never throws.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, relative } from 'node:path';

import {
  buildDependencyGraph,
  DEFAULT_IGNORE_DIRS,
  parseExports,
  parseImports,
  type ParsedFile,
} from '../tools/architecture-guard.js';
import { nowIso } from '../memory/client.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface BlastRadiusResult {
  projectPath: string;
  /** Input changed-file paths successfully matched to a scanned source file, project-relative posix. */
  changedFiles: string[];
  /** Input changed-file paths that could not be matched (deleted/non-source/outside the scanned tree). */
  unresolvedChangedFiles: string[];
  /** Files that directly import a changed file (BFS distance 1). */
  directlyImpacted: string[];
  /** Every file reachable by walking "imported by" from a changed file (distance >= 1), sorted. */
  transitivelyImpacted: string[];
  /** `transitivelyImpacted` entries that look like test files — the minimum safe validation set's test half. */
  impactedTestFiles: string[];
  /** `transitivelyImpacted` entries that look like API route handlers. */
  impactedApiRoutes: string[];
  /** Total source files scanned to build the dependency graph. */
  scannedFiles: number;
  generatedAt: string;
}

/** Matches a Jest/Vitest/Playwright-style test file by name or location. */
const TEST_FILE_PATTERN = /(^|\/)(__tests__|e2e|tests|test)\/|\.(test|spec)\.[jt]sx?$/i;

/** Matches a Next.js App/Pages Router API handler, or a conventional Express-style routes file. */
const API_ROUTE_PATTERN = /(^|\/)api\/.*route\.[jt]sx?$|(^|\/)pages\/api\/|(^|\/)routes\/[^/]+\.[jt]sx?$/i;

const SOURCE_EXTS: ReadonlySet<string> = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);
const MAX_FILE_BYTES = 2_000_000;

/**
 * Analyze the blast radius of `changedFiles` (relative or absolute paths) within `projectPath`.
 * Never throws — an empty/all-unresolved `changedFiles`, an unwalkable project, or a parse failure
 * on any individual file all degrade the relevant part of the result rather than aborting.
 */
export async function analyzeBlastRadius(projectPath: string, changedFiles: string[]): Promise<BlastRadiusResult> {
  const generatedAt = nowIso();
  const scanned = await scanProjectFiles(projectPath);
  const relSet = new Set(scanned.map((f) => f.rel));
  const graph = buildDependencyGraph(scanned, relSet);
  const reverseGraph = invertGraph(graph);

  const changedFilesResolved: string[] = [];
  const unresolvedChangedFiles: string[] = [];
  for (const raw of changedFiles) {
    const rel = toRelPosix(projectPath, raw);
    if (rel !== null && relSet.has(rel)) {
      changedFilesResolved.push(rel);
    } else {
      unresolvedChangedFiles.push(raw);
    }
  }

  const distances = bfsReverseReachable(reverseGraph, changedFilesResolved);
  const changedSet = new Set(changedFilesResolved);

  const transitivelyImpacted = [...distances.keys()].filter((f) => !changedSet.has(f)).sort();
  const directlyImpacted = [...distances.entries()]
    .filter(([f, d]) => d === 1 && !changedSet.has(f))
    .map(([f]) => f)
    .sort();

  return {
    projectPath,
    changedFiles: changedFilesResolved,
    unresolvedChangedFiles,
    directlyImpacted,
    transitivelyImpacted,
    impactedTestFiles: transitivelyImpacted.filter((f) => TEST_FILE_PATTERN.test(f)),
    impactedApiRoutes: transitivelyImpacted.filter((f) => API_ROUTE_PATTERN.test(f)),
    scannedFiles: scanned.length,
    generatedAt,
  };
}

/** Render a `BlastRadiusResult` as human-readable Markdown-ish lines (used by `forge blast-radius`). */
export function formatBlastRadiusResult(result: BlastRadiusResult): string {
  const lines: string[] = [];
  lines.push(`Blast radius for ${result.changedFiles.length} changed file(s) (${result.scannedFiles} file(s) scanned):`);
  for (const f of result.changedFiles) lines.push(`  changed: ${f}`);
  if (result.unresolvedChangedFiles.length > 0) {
    lines.push(`  unresolved (not found in scanned tree): ${result.unresolvedChangedFiles.join(', ')}`);
  }
  lines.push(`  directly impacted (${result.directlyImpacted.length}): ${result.directlyImpacted.join(', ') || 'none'}`);
  lines.push(`  transitively impacted (${result.transitivelyImpacted.length}): ${result.transitivelyImpacted.join(', ') || 'none'}`);
  lines.push(`  impacted test files (${result.impactedTestFiles.length}): ${result.impactedTestFiles.join(', ') || 'none'}`);
  lines.push(`  impacted API routes (${result.impactedApiRoutes.length}): ${result.impactedApiRoutes.join(', ') || 'none'}`);
  return lines.join('\n');
}

/**
 * Real git-derived "what changed" — `git diff --name-only HEAD` (tracked + staged changes against
 * HEAD) unioned with `git ls-files --others --exclude-standard` (new untracked files). Degrades to
 * `[]` (never throws) when `projectPath` is not a git repository or has no commits yet.
 */
export function getGitChangedFiles(projectPath: string): string[] {
  if (!existsSync(join(projectPath, '.git'))) return [];
  const run = (args: string[]): string[] => {
    try {
      const stdout = execFileSync('git', args, {
        cwd: projectPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      return stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    } catch {
      return [];
    }
  };
  const tracked = run(['diff', '--name-only', 'HEAD']);
  const untracked = run(['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...tracked, ...untracked])];
}

// ---------------------------------------------------------------------------
// Internal — file walk, parse, graph inversion, BFS
// ---------------------------------------------------------------------------

async function walkDir(dir: string, ignoreDirs: ReadonlySet<string>, acc: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoreDirs.has(entry.name)) await walkDir(abs, ignoreDirs, acc);
    } else if (entry.isFile()) {
      const ext = entry.name.split('.').pop() ?? '';
      if (!SOURCE_EXTS.has(ext)) continue;
      try {
        if ((await stat(abs)).size <= MAX_FILE_BYTES) acc.push(abs);
      } catch {
        /* skip unreadable */
      }
    }
  }
}

async function scanProjectFiles(projectPath: string): Promise<ParsedFile[]> {
  const ignoreDirs = new Set(DEFAULT_IGNORE_DIRS);
  const absFiles: string[] = [];
  await walkDir(projectPath, ignoreDirs, absFiles);

  const parsed: ParsedFile[] = [];
  for (const abs of absFiles) {
    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const rel = toRelPosix(projectPath, abs);
    if (rel === null) continue;
    const lines = content.split(/\r?\n/);
    try {
      parsed.push({
        rel,
        content,
        lines,
        lineCount: lines.length,
        ext: rel.split('.').pop() ?? '',
        imports: parseImports(content),
        exports: parseExports(lines),
      });
    } catch {
      /* a single unparsable file never aborts the scan */
    }
  }
  return parsed;
}

/** Project-relative, posix-normalized path, or `null` when `raw` resolves outside `projectPath`. */
function toRelPosix(projectPath: string, raw: string): string | null {
  const abs = isAbsolute(raw) ? raw : join(projectPath, raw);
  const rel = relative(projectPath, abs).replace(/\\/g, '/');
  if (rel.startsWith('..')) return null;
  return rel;
}

/** Invert a "file → what it imports" graph into "file → what imports it". */
function invertGraph(graph: Map<string, string[]>): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [file, deps] of graph) {
    for (const dep of deps) {
      const list = reverse.get(dep);
      if (list) list.push(file);
      else reverse.set(dep, [file]);
    }
  }
  return reverse;
}

/** BFS over the reverse graph from every changed file; returns the shortest distance to each reached file. */
function bfsReverseReachable(reverseGraph: Map<string, string[]>, changedFiles: string[]): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: Array<{ file: string; distance: number }> = changedFiles.map((file) => ({ file, distance: 0 }));
  for (const f of changedFiles) distances.set(f, 0);

  while (queue.length > 0) {
    const { file, distance } = queue.shift()!;
    for (const dependent of reverseGraph.get(file) ?? []) {
      const next = distance + 1;
      if (!distances.has(dependent)) {
        distances.set(dependent, next);
        queue.push({ file: dependent, distance: next });
      }
    }
  }
  return distances;
}
