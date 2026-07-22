// FORGE 2.0 — RETROFIT: Dead Code Detector
//
// Regex-based (not AST-based) scan of a target project's src/**/*.ts(x) tree for exported
// symbols with zero cross-file imports, plus three same-file signals: local functions defined
// but never called, local variables assigned but never read, and imports never used in the
// importing file. Read-only against the target project — the only write this module performs
// is the best-effort Build Memory persistence step (`dead_code_findings`), which never throws
// (Contract 4 — a Build Memory failure degrades to stateless mode, it does not halt the caller).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { getClient, logMemoryWarning, newId, nowIso } from '../memory/client.js';

export interface DeadCodeFinding {
  filePath: string;
  symbolName: string;
  symbolType: 'function' | 'class' | 'interface' | 'type' | 'const' | 'variable';
  reason: string;
  lineNumber: number;
}

interface ExportedSymbol {
  name: string;
  type: DeadCodeFinding['symbolType'];
  keyword: string;
  line: number;
}

interface LocalImportBinding {
  line: number;
  name: string;
  source: string;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.forge', '.claude', '.vercel']);
const SOURCE_FILE_RE = /\.(ts|tsx)$/;
const TEST_OR_STORY_RE = /\.(test|spec)\.tsx?$|\.stories\.tsx$/;
const ENTRY_POINT_BASENAMES = new Set(['page.tsx', 'page.ts', 'route.ts', 'route.tsx', 'index.ts', 'index.tsx']);

/** Recursively collects every src/**\/*.ts(x) file under `<projectPath>/src`, fs.readdirSync-based. */
function walkSourceFiles(projectPath: string): string[] {
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
      if (!SOURCE_FILE_RE.test(entry)) continue;
      if (entry.endsWith('.d.ts')) continue;
      if (TEST_OR_STORY_RE.test(entry)) continue; // *.test.ts / *.spec.ts / *.stories.tsx excluded per spec
      acc.push(fullPath);
    }
  }

  walk(join(projectPath, 'src'));
  return acc;
}

function toProjectRelative(projectPath: string, absPath: string): string {
  return relative(projectPath, absPath).replace(/\\/g, '/');
}

/** page.tsx/page.ts (Next.js route), route.ts/route.tsx (Next.js API), index.ts/index.tsx (re-export barrel). */
function isEntryPointFile(absPath: string): boolean {
  return ENTRY_POINT_BASENAMES.has(basename(absPath));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Pass 1 — exported symbols with zero cross-file imports
// ---------------------------------------------------------------------------

interface ExportPatternDef {
  re: RegExp;
  type: DeadCodeFinding['symbolType'];
  keyword: string;
}

const EXPORT_PATTERNS: ExportPatternDef[] = [
  { re: /^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/, type: 'function', keyword: 'function' },
  { re: /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/, type: 'class', keyword: 'class' },
  { re: /^export\s+interface\s+(\w+)/, type: 'interface', keyword: 'interface' },
  { re: /^export\s+type\s+(\w+)/, type: 'type', keyword: 'type' },
  { re: /^export\s+enum\s+(\w+)/, type: 'const', keyword: 'enum' },
  { re: /^export\s+const\s+(\w+)/, type: 'const', keyword: 'const' },
];

/** Parses `export function|const|class|interface|type|enum Name` declarations, line by line. */
function parseExportedSymbols(content: string): ExportedSymbol[] {
  const lines = content.split(/\r?\n/);
  const results: ExportedSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    for (const pattern of EXPORT_PATTERNS) {
      const match = pattern.re.exec(trimmed);
      if (match?.[1]) {
        results.push({ name: match[1], type: pattern.type, keyword: pattern.keyword, line: i + 1 });
        break;
      }
    }
  }

  return results;
}

/** Builds the set of regexes used to detect a static or dynamic import of `symbolName`. */
function buildImportSearchRegexes(symbolName: string): RegExp[] {
  const n = escapeRegExp(symbolName);
  return [
    // import { symbolName } from '...'  (also matches `import type { symbolName }`)
    new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\b${n}\\b[^}]*\\}\\s*from`, 'm'),
    // import symbolName from '...'  (default import re-using the same identifier name)
    new RegExp(`import\\s+(?:type\\s+)?${n}\\s*(?:,|\\s+from)`, 'm'),
    // import * as symbolName from '...'
    new RegExp(`import\\s*\\*\\s*as\\s+${n}\\b`, 'm'),
    // const { symbolName } = await import('...')
    new RegExp(`\\{[^}]*\\b${n}\\b[^}]*\\}\\s*=\\s*(?:await\\s+)?import\\(`, 'm'),
    // await import('...').then(({ symbolName }) => ...) / import('...') followed by a destructure
    new RegExp(`(?:await\\s+)?import\\([^)]*\\)[\\s\\S]{0,150}?\\{[^}]*\\b${n}\\b[^}]*\\}`, 'm'),
  ];
}

/** True if `symbolName` (exported from `ownFile`) is imported — statically or dynamically — anywhere else. */
function isSymbolImportedElsewhere(symbolName: string, ownFile: string, fileContents: Map<string, string>): boolean {
  const regexes = buildImportSearchRegexes(symbolName);
  for (const [file, content] of fileContents) {
    if (file === ownFile) continue;
    for (const re of regexes) {
      if (re.test(content)) return true;
    }
  }
  return false;
}

function detectDeadExports(projectPath: string, fileContents: Map<string, string>): DeadCodeFinding[] {
  const findings: DeadCodeFinding[] = [];

  for (const [absPath, content] of fileContents) {
    if (isEntryPointFile(absPath)) continue; // page.tsx / route.ts / index.ts — framework/barrel, never manually imported

    const relPath = toProjectRelative(projectPath, absPath);
    for (const symbol of parseExportedSymbols(content)) {
      if (isSymbolImportedElsewhere(symbol.name, absPath, fileContents)) continue;
      findings.push({
        filePath: relPath,
        symbolName: symbol.name,
        symbolType: symbol.type,
        reason: `exported ${symbol.keyword} "${symbol.name}" has zero imports anywhere else in the codebase`,
        lineNumber: symbol.line,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Pass 2a — local (non-exported) functions defined but never called within the same file
// ---------------------------------------------------------------------------

const LOCAL_FUNCTION_DECL_RE = /^(?:async\s+)?function\s+(\w+)\s*\(/;
const LOCAL_FUNCTION_EXPR_RE = /^(?:const|let)\s+(\w+)\s*(?::\s*[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|function\s*\()/;

function countCallsExcludingLine(content: string, name: string, excludeLineIndex: number): number {
  const callRe = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, 'g');
  const lines = content.split(/\r?\n/);
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i === excludeLineIndex) continue;
    const matches = (lines[i] ?? '').match(callRe);
    if (matches) count += matches.length;
  }
  return count;
}

function detectUncalledLocalFunctions(relPath: string, content: string): DeadCodeFinding[] {
  const lines = content.split(/\r?\n/);
  const findings: DeadCodeFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    if (/^export\s+/.test(trimmed)) continue; // exported functions are covered by detectDeadExports

    const declMatch = LOCAL_FUNCTION_DECL_RE.exec(trimmed);
    const exprMatch = LOCAL_FUNCTION_EXPR_RE.exec(trimmed);
    const name = declMatch?.[1] ?? exprMatch?.[1];
    if (!name || name.startsWith('_')) continue;

    if (countCallsExcludingLine(content, name, i) === 0) {
      findings.push({
        filePath: relPath,
        symbolName: name,
        symbolType: 'function',
        reason: `local function "${name}" is defined but never called within ${basename(relPath)}`,
        lineNumber: i + 1,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Pass 2b — local (non-exported) variables assigned but never read
// ---------------------------------------------------------------------------

const LOCAL_VAR_DECL_RE = /^(?:const|let)\s+([a-zA-Z_$][\w$]*)\s*[=:]/;

function detectUnreadLocalVariables(relPath: string, content: string): DeadCodeFinding[] {
  const lines = content.split(/\r?\n/);
  const findings: DeadCodeFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    if (/^export\s+/.test(trimmed)) continue;
    if (LOCAL_FUNCTION_EXPR_RE.test(trimmed)) continue; // arrow/function-expr — reported as a function above

    const match = LOCAL_VAR_DECL_RE.exec(trimmed);
    const name = match?.[1];
    if (!name || name.startsWith('_')) continue;

    const wordRe = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
    const totalOccurrences = (content.match(wordRe) ?? []).length;
    if (totalOccurrences <= 1) {
      findings.push({
        filePath: relPath,
        symbolName: name,
        symbolType: 'variable',
        reason: `local variable "${name}" is assigned but never read`,
        lineNumber: i + 1,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Pass 2c — imports never used in the importing file
// ---------------------------------------------------------------------------

function parseLocalImports(content: string): LocalImportBinding[] {
  const lines = content.split(/\r?\n/);
  const results: LocalImportBinding[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (!trimmed.startsWith('import ') && !trimmed.startsWith('import{')) {
      i++;
      continue;
    }
    if (/import\s*\(/.test(trimmed)) {
      i++; // dynamic import — not a static importing-file binding
      continue;
    }

    let full = line;
    const startLine = i + 1;
    if (trimmed.includes('{') && !trimmed.includes('}')) {
      while (i < lines.length - 1) {
        i++;
        full += ' ' + (lines[i] ?? '');
        if ((lines[i] ?? '').includes('}')) break;
      }
    }

    if (/^import\s+['"]/.test(full.trim())) {
      i++; // side-effect import — nothing to track
      continue;
    }

    const srcMatch = /from\s+['"]([^'"]+)['"]/.exec(full);
    const source = srcMatch?.[1] ?? '';

    const namedMatch = /import\s+(?:type\s+)?\{([^}]+)\}/.exec(full);
    if (namedMatch?.[1]) {
      for (const part of namedMatch[1].split(',')) {
        const alias = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (alias && /^\w+$/.test(alias) && alias !== 'default') {
          results.push({ line: startLine, name: alias, source });
        }
      }
    }

    const defaultMatch = /import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|\s+from)/.exec(full);
    if (defaultMatch?.[1] && defaultMatch[1] !== 'type') {
      results.push({ line: startLine, name: defaultMatch[1], source });
    }

    i++;
  }

  return results;
}

function detectUnusedLocalImports(relPath: string, content: string): DeadCodeFinding[] {
  const imports = parseLocalImports(content);
  if (imports.length === 0) return [];

  const lastImportLine = Math.max(...imports.map((imp) => imp.line));
  const body = content.split(/\r?\n/).slice(lastImportLine).join('\n');
  const findings: DeadCodeFinding[] = [];

  for (const imp of imports) {
    const wordRe = new RegExp(`\\b${escapeRegExp(imp.name)}\\b`, 'g');
    if (!wordRe.test(body)) {
      findings.push({
        filePath: relPath,
        symbolName: imp.name,
        symbolType: 'variable',
        reason: `import "${imp.name}" from '${imp.source}' is never used in this file`,
        lineNumber: imp.line,
      });
    }
  }

  return findings;
}

function detectSameFileDeadCode(projectPath: string, fileContents: Map<string, string>): DeadCodeFinding[] {
  const findings: DeadCodeFinding[] = [];

  for (const [absPath, content] of fileContents) {
    const relPath = toProjectRelative(projectPath, absPath);
    findings.push(...detectUncalledLocalFunctions(relPath, content));
    findings.push(...detectUnreadLocalVariables(relPath, content));
    findings.push(...detectUnusedLocalImports(relPath, content));
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Build Memory persistence (Contract 4 — best-effort, never throws)
// ---------------------------------------------------------------------------

function persistFindings(runId: string, projectPath: string, findings: DeadCodeFinding[]): void {
  if (findings.length === 0) return;

  const db = getClient();
  if (!db) return; // Build Memory unavailable — degrade to stateless mode

  try {
    const insert = db.prepare(
      `INSERT INTO dead_code_findings
         (id, build_run_id, project_path, file_path, symbol_name, symbol_type, reason, line_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAll = db.transaction((rows: DeadCodeFinding[]) => {
      for (const row of rows) {
        insert.run(newId(), runId, projectPath, row.filePath, row.symbolName, row.symbolType, row.reason, row.lineNumber, nowIso());
      }
    });
    insertAll(findings);
  } catch (error) {
    logMemoryWarning('dead-code-detector:persist', error);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class DeadCodeDetector {
  /**
   * Scans `<projectPath>/src/**\/*.ts(x)` for dead code: exported symbols with zero cross-file
   * imports, uncalled local functions, unread local variables, and unused local imports.
   * Read-only against the project. Findings are persisted to `dead_code_findings` (best-effort)
   * and returned sorted by file path (then line number).
   */
  async detect(projectPath: string): Promise<DeadCodeFinding[]> {
    const runId = newId();
    const files = walkSourceFiles(projectPath);
    const fileContents = new Map<string, string>();

    for (const absPath of files) {
      try {
        fileContents.set(absPath, readFileSync(absPath, 'utf8'));
      } catch {
        // unreadable file — skip, never throw
      }
    }

    const findings: DeadCodeFinding[] = [
      ...detectDeadExports(projectPath, fileContents),
      ...detectSameFileDeadCode(projectPath, fileContents),
    ];

    findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber);

    persistFindings(runId, projectPath, findings);

    return findings;
  }
}

export function createDeadCodeDetector(): DeadCodeDetector {
  return new DeadCodeDetector();
}
