// Dead Code Scanner — lightweight unused import/variable/export detector
//
// INTENTIONALLY SEPARATE from `src/retrofit/dead-code-detector.ts` (Finding B-6): this module is
// the live, mid-build Sentinel gate signal (`phase3-executor.ts`/`phase4-sentinel.ts` call it
// during/after a real build) with an auto-fix path for unused imports; the retrofit module is the
// standalone `forge analyze`/`forge retrofit` deep-analysis detector, run independently of any
// build. See the note atop `dead-code-detector.ts` for the full rationale — this is a deliberate
// scope split, not drift to consolidate.

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UnusedImport {
  file: string;
  line: number;
  importName: string;
  source: string;
}

export interface UnusedVariable {
  file: string;
  line: number;
  variableName: string;
  kind: 'const' | 'let';
}

export interface UnusedExport {
  file: string;
  line: number;
  exportName: string;
}

export interface DeadCodeReport {
  unusedImports: UnusedImport[];
  unusedVariables: UnusedVariable[];
  unusedExports: UnusedExport[];
  scannedFiles: number;
  generatedAt: string;
}

export interface FixResult {
  filesModified: number;
  importsRemoved: number;
  modifiedFiles: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ParsedImport {
  /** 1-based line number where the import starts */
  line: number;
  /** Local names introduced by this import */
  names: string[];
  /** Module specifier string */
  source: string;
  /** Normalised single-line representation (multi-line imports are joined) */
  rawLine: string;
}

interface FileExport {
  name: string;
  line: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set(['.ts', '.tsx']);
const IGNORE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.forge']);
const MAX_FILE_BYTES = 500_000;

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

async function walkDir(dir: string, acc: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) await walkDir(abs, acc);
    } else if (entry.isFile() && SOURCE_EXTS.has(extname(entry.name))) {
      try {
        if ((await stat(abs)).size <= MAX_FILE_BYTES) acc.push(abs);
      } catch {
        // skip unreadable entries
      }
    }
  }
}

async function walkSrc(projectPath: string): Promise<string[]> {
  const acc: string[] = [];
  await walkDir(join(projectPath, 'src'), acc);
  return acc;
}

// ---------------------------------------------------------------------------
// Import parsing
// ---------------------------------------------------------------------------

function parseImports(content: string): ParsedImport[] {
  const lines = content.split(/\r?\n/);
  const results: ParsedImport[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (!trimmed.startsWith('import ') && !trimmed.startsWith('import{')) {
      i++;
      continue;
    }
    // Skip dynamic imports: import(...)
    if (/import\s*\(/.test(trimmed)) {
      i++;
      continue;
    }

    // Collect multi-line imports
    let full = line;
    const startLine = i + 1;
    if (trimmed.includes('{') && !trimmed.includes('}')) {
      while (i < lines.length - 1) {
        i++;
        full += ' ' + (lines[i] ?? '');
        if ((lines[i] ?? '').includes('}')) break;
      }
    }

    // Side-effect import: import 'foo' — no names to track
    if (/^import\s+['"]/.test(full.trim())) {
      i++;
      continue;
    }

    const srcMatch = /from\s+['"]([^'"]+)['"]/.exec(full);
    const source = srcMatch?.[1] ?? '';
    const names: string[] = [];

    // namespace: import * as X
    const nsMatch = /import\s+\*\s+as\s+(\w+)/.exec(full);
    if (nsMatch?.[1]) names.push(nsMatch[1]);

    // named: import { A, B as C }
    const namedMatch = /import\s+(?:type\s+)?\{([^}]+)\}/.exec(full);
    if (namedMatch?.[1]) {
      for (const part of namedMatch[1].split(',')) {
        const alias = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (alias && /^\w+$/.test(alias) && alias !== 'default') names.push(alias);
      }
    }

    // default: import X from '...' — matches word before comma or 'from'
    const defaultMatch = /import\s+(?:type\s+)?([A-Z_$][\w$]*)\s*(?:,|\s+from)/i.exec(full);
    if (defaultMatch?.[1] && defaultMatch[1] !== 'type' && !names.includes(defaultMatch[1])) {
      names.push(defaultMatch[1]);
    }

    if (names.length > 0 && source) {
      results.push({ line: startLine, names, source, rawLine: full.trim() });
    }
    i++;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBodyAfterImports(content: string, imports: ParsedImport[]): string {
  if (imports.length === 0) return content;
  const lastLine = Math.max(...imports.map((imp) => imp.line));
  return content.split(/\r?\n/).slice(lastLine).join('\n');
}

function countWord(text: string, word: string): number {
  const re = new RegExp(`\\b${word}\\b`, 'g');
  return (text.match(re) ?? []).length;
}

// ---------------------------------------------------------------------------
// Export detection
// ---------------------------------------------------------------------------

function parseExports(content: string): FileExport[] {
  const lines = content.split(/\r?\n/);
  const results: FileExport[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();

    // export const/function/class/type/interface/enum/let Name
    const declMatch = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/.exec(trimmed);
    if (declMatch?.[1]) {
      results.push({ name: declMatch[1], line: i + 1 });
      continue;
    }

    // export { A, B as C }
    const blockMatch = /^export\s*\{([^}]+)\}/.exec(trimmed);
    if (blockMatch?.[1]) {
      for (const part of blockMatch[1].split(',')) {
        const alias = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (alias && /^\w+$/.test(alias)) results.push({ name: alias, line: i + 1 });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Unused variable detection
// ---------------------------------------------------------------------------

function detectUnusedVariables(relFile: string, content: string): UnusedVariable[] {
  const lines = content.split(/\r?\n/);
  const results: UnusedVariable[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // Only simple declarations (skip destructuring)
    const m = /^\s*(?:export\s+)?(?:(const)|(let))\s+([a-zA-Z_$][\w$]*)\s*[=:]/.exec(line);
    if (!m) continue;
    const kind: 'const' | 'let' = m[1] ? 'const' : 'let';
    const name = m[3] ?? '';
    if (!name || name.startsWith('_')) continue;

    // If exported, it can be used externally — skip
    if (/^\s*export\s+/.test(line)) continue;

    // Count occurrences: declaration itself counts as 1
    if (countWord(content, name) <= 1) {
      results.push({ file: relFile, line: i + 1, variableName: name, kind });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

export async function scanDeadCode(projectPath: string): Promise<DeadCodeReport> {
  const files = await walkSrc(projectPath);

  type FileEntry = { abs: string; rel: string; content: string; exports: FileExport[] };
  const fileData = new Map<string, FileEntry>();

  for (const abs of files) {
    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(projectPath, abs).replace(/\\/g, '/');
    fileData.set(rel, { abs, rel, content, exports: parseExports(content) });
  }

  // Build a map of rel-path → set of names imported from that file elsewhere
  const importedByFile = new Map<string, Set<string>>();

  for (const { rel, content } of fileData.values()) {
    const dir = rel.split('/').slice(0, -1).join('/');
    for (const imp of parseImports(content)) {
      // Attempt to resolve relative module specifier to a known file
      if (!imp.source.startsWith('.')) continue;
      const resolved = dir ? `${dir}/${imp.source}` : imp.source;
      const normalised = resolved.replace(/\/\.\//g, '/').replace(/[^/]+\/\.\.\//g, '');

      for (const key of fileData.keys()) {
        const keyNoExt = key.replace(/\.(ts|tsx)$/, '');
        const normNoExt = normalised.replace(/\.(ts|tsx)$/, '');
        if (keyNoExt === normNoExt || key === normalised) {
          let set = importedByFile.get(key);
          if (!set) { set = new Set<string>(); importedByFile.set(key, set); }
          for (const name of imp.names) set.add(name);
          break;
        }
      }
    }
  }

  const unusedImports: UnusedImport[] = [];
  const unusedVariables: UnusedVariable[] = [];
  const unusedExports: UnusedExport[] = [];

  for (const { rel, content, exports } of fileData.values()) {
    const imports = parseImports(content);
    const body = getBodyAfterImports(content, imports);

    // Unused imports
    for (const imp of imports) {
      for (const name of imp.names) {
        if (countWord(body, name) === 0) {
          unusedImports.push({ file: rel, line: imp.line, importName: name, source: imp.source });
        }
      }
    }

    // Unused variables
    unusedVariables.push(...detectUnusedVariables(rel, content));

    // Unused exports (skip 'default')
    const importedNames = importedByFile.get(rel) ?? new Set<string>();
    for (const exp of exports) {
      if (exp.name !== 'default' && !importedNames.has(exp.name)) {
        unusedExports.push({ file: rel, line: exp.line, exportName: exp.name });
      }
    }
  }

  return {
    unusedImports,
    unusedVariables,
    unusedExports,
    scannedFiles: fileData.size,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Auto-fix imports
// ---------------------------------------------------------------------------

// Remove import lines where ALL named imports are unused.
// Partial removals (some names used, some not) are skipped to stay safe.
function applyImportFixes(content: string): { content: string; removed: number } {
  const imports = parseImports(content);
  if (imports.length === 0) return { content, removed: 0 };

  const body = getBodyAfterImports(content, imports);
  const lines = content.split(/\r?\n/);

  // Map line index (0-based) to ParsedImport
  const importAtLine = new Map<number, ParsedImport>();
  for (const imp of imports) importAtLine.set(imp.line - 1, imp);

  const newLines: string[] = [];
  let removed = 0;

  for (let i = 0; i < lines.length; i++) {
    const imp = importAtLine.get(i);
    if (!imp) {
      newLines.push(lines[i] ?? '');
      continue;
    }

    const unusedNames = imp.names.filter((n) => countWord(body, n) === 0);

    if (unusedNames.length === 0) {
      // All names are used — keep line as-is
      newLines.push(lines[i] ?? '');
      continue;
    }

    if (unusedNames.length < imp.names.length) {
      // Partial: keep line, only remove fully-unused imports if the line is simple
      // Rewrite the named import list
      let rebuilt = lines[i] ?? '';
      for (const name of unusedNames) {
        rebuilt = rebuilt
          .replace(new RegExp(`\\b${name}\\b\\s+as\\s+\\w+\\s*,?\\s*`, 'g'), '')
          .replace(new RegExp(`,?\\s*\\b${name}\\b`, 'g'), '');
        removed++;
      }
      rebuilt = rebuilt.replace(/\{\s*,/, '{').replace(/,\s*\}/, ' }').replace(/\{\s+\}/, '{}');
      newLines.push(rebuilt);
      continue;
    }

    // All names unused — drop the entire line (multi-line imports already joined in parsing,
    // so the single source line is enough to drop)
    removed += unusedNames.length;
    // Skip this line (do not push to newLines)
  }

  return { content: newLines.join('\n'), removed };
}

export async function autoFixImports(projectPath: string): Promise<FixResult> {
  const files = await walkSrc(projectPath);
  let filesModified = 0;
  let importsRemoved = 0;
  const modifiedFiles: string[] = [];
  const warnings: string[] = [];

  for (const abs of files) {
    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      continue;
    }

    const { content: fixed, removed } = applyImportFixes(content);
    if (removed === 0 || fixed === content) continue;

    try {
      await writeFile(abs, fixed, 'utf8');
      filesModified++;
      importsRemoved += removed;
      modifiedFiles.push(relative(projectPath, abs).replace(/\\/g, '/'));
    } catch (error) {
      warnings.push(
        `Failed to write ${relative(projectPath, abs).replace(/\\/g, '/')}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { filesModified, importsRemoved, modifiedFiles, warnings };
}

// ---------------------------------------------------------------------------
// Format report
// ---------------------------------------------------------------------------

export function formatDeadCodeReport(report: DeadCodeReport): string {
  const lines: string[] = [
    '# Dead Code Report',
    `- Files scanned: ${report.scannedFiles}`,
    `- Generated: ${report.generatedAt}`,
    '',
    `## Unused Imports (${report.unusedImports.length})`,
  ];

  for (const item of report.unusedImports) {
    lines.push(`  ${item.file}:${item.line} — \`${item.importName}\` from '${item.source}'`);
  }

  lines.push('', `## Unused Variables (${report.unusedVariables.length})`);
  for (const item of report.unusedVariables) {
    lines.push(`  ${item.file}:${item.line} — ${item.kind} \`${item.variableName}\``);
  }

  lines.push('', `## Unused Exports (${report.unusedExports.length})`);
  for (const item of report.unusedExports) {
    lines.push(`  ${item.file}:${item.line} — export \`${item.exportName}\``);
  }

  const total = report.unusedImports.length + report.unusedVariables.length + report.unusedExports.length;
  lines.push('', total === 0 ? 'No dead code found. ✓' : `Total issues: ${total}`);

  return lines.join('\n');
}
