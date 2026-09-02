// FORGE 2.0 — RETROFIT: Dependency Auditor
//
// Regex-based (not AST-based) audit of a target project's package.json dependencies against what
// is actually imported under src/**/*.ts(x), plus root config files (next.config.*, tailwind.config.*,
// vitest.config.*) and scripts/**. Flags packages declared but never imported (unused — error for
// `dependencies`, warning for `devDependencies`), packages imported in src/ but never declared
// (missing — likely a transitive dependency being imported directly), packages declared in BOTH
// `dependencies` and `devDependencies` (duplicate), and packages with a major-version update
// available per `pnpm outdated --json` (outdated_major — best-effort, silently skipped when pnpm
// is unavailable). Read-only against the target project — the only write this module performs is
// the best-effort Build Memory persistence step (`dependency_audit_findings`), which never throws
// (Contract 4 — a Build Memory failure degrades to stateless mode, it does not halt the caller).

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getClient, logMemoryWarning, newId, nowIso } from '../memory/client.js';

export interface DependencyFinding {
  packageName: string;
  findingType: 'unused' | 'missing' | 'duplicate' | 'outdated_major';
  detail: string;
}

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.forge', '.claude', '.vercel']);
const SRC_FILE_RE = /\.(ts|tsx)$/;
const SCRIPT_FILE_RE = /\.(js|mjs|cjs|ts)$/;

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
      acc.push(fullPath);
    }
  }

  walk(rootDir);
  return acc;
}

/** Root-level config file basenames whose imports count toward "used", per the exclusion list. */
const CONFIG_FILE_BASENAMES = [
  'next.config.ts',
  'next.config.js',
  'next.config.mjs',
  'tailwind.config.ts',
  'tailwind.config.js',
  'tailwind.config.mjs',
  'vitest.config.ts',
  'vitest.config.js',
];

/** Root-level config files (from `CONFIG_FILE_BASENAMES`) that actually exist in this project. */
function findConfigFiles(projectPath: string): string[] {
  return CONFIG_FILE_BASENAMES.map((name) => join(projectPath, name)).filter((path) => existsSync(path));
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

function readPackageJson(projectPath: string): PackageJsonShape | null {
  const pkgPath = join(projectPath, 'package.json');
  let raw: string;
  try {
    raw = readFileSync(pkgPath, 'utf8');
  } catch {
    return null; // no package.json — nothing to audit
  }

  try {
    const parsed = JSON.parse(raw) as PackageJsonShape;
    return {
      dependencies: parsed.dependencies ?? {},
      devDependencies: parsed.devDependencies ?? {},
    };
  } catch {
    return null; // malformed package.json — skip, never throw
  }
}

// ---------------------------------------------------------------------------
// Import-specifier extraction
// ---------------------------------------------------------------------------

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'domain', 'events',
  'fs', 'http', 'http2', 'https', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url',
  'util', 'v8', 'vm', 'worker_threads', 'zlib', 'module', 'inspector', 'async_hooks',
]);

// Matched independently over the whole file (not line-by-line) so multi-line `import { ... } from`
// statements are still captured without needing to track brace balance.
const FROM_SPECIFIER_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /\bimport\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * True if `line[0..index)` leaves us inside an open `'`/`"`/`` ` `` string literal at `index` — a
 * simple single-line string-state scanner (handles `\`-escapes), not a full tokenizer (does not
 * track a template literal that itself spans multiple lines, or comments). Used to reject a regex
 * match that only "looks like" an import/require because it sits inside a string/template literal
 * in the scanned file's own source — e.g. a string containing the literal text `'import '`
 * (`dead-code-detector.ts`'s own `trimmed.startsWith('import ')` check), or a template literal
 * like `` `import "${x}" from '${y}'` `` (an error-message string, not a real import statement) —
 * both of which previously produced fabricated "missing dependency" findings for package names
 * like `) && !trimmed.startsWith(` or `${imp.source}` (Finding B-4).
 */
function isInsideStringLiteral(line: string, index: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < index; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') {
        i++; // skip the escaped character, it can't close/toggle the string
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    }
  }
  return quote !== null;
}

/** Extracts every raw (unresolved) import-specifier string referenced anywhere in `content`,
 *  skipping any match that sits inside a string/template literal rather than a real statement. */
function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const re of [FROM_SPECIFIER_RE, SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content))) {
      if (!match[1]) continue;
      const lineStart = content.lastIndexOf('\n', match.index) + 1;
      const lineEndIdx = content.indexOf('\n', match.index);
      const line = content.slice(lineStart, lineEndIdx === -1 ? content.length : lineEndIdx);
      if (isInsideStringLiteral(line, match.index - lineStart)) continue;
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/**
 * Resolves a raw import specifier to an npm package name, or `null` when it is a relative import,
 * an absolute path, a `@/`-style tsconfig path alias, or a Node.js builtin. Scoped packages
 * (`@scope/name`) keep both segments; everything else keeps only the first path segment
 * (`next/link` -> `next`, `react-dom/client` -> `react-dom`).
 */
function resolvePackageName(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('@/') || specifier.startsWith('~/')) return null; // path alias, not a package
  if (specifier.startsWith('node:')) return null;

  const firstSegment = specifier.split('/')[0] ?? '';
  if (NODE_BUILTINS.has(firstSegment)) return null;

  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    const scope = parts[0];
    const name = parts[1];
    if (!scope || scope === '@' || !name) return null;
    return `${scope}/${name}`;
  }

  return firstSegment || null;
}

/** Scans one file's content and returns the set of resolved package names it imports. */
function extractPackageNamesFromFile(content: string): Set<string> {
  const names = new Set<string>();
  for (const specifier of extractImportSpecifiers(content)) {
    const resolved = resolvePackageName(specifier);
    if (resolved) names.add(resolved);
  }
  return names;
}

/** Reads and scans every file at `filePaths`, merging their resolved package names into one set. */
function collectPackageNames(filePaths: string[]): Set<string> {
  const names = new Set<string>();
  for (const filePath of filePaths) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue; // unreadable file — skip, never throw
    }
    for (const name of extractPackageNamesFromFile(content)) names.add(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// `pnpm outdated --json` (best-effort — never throws, degrades to "no data")
// ---------------------------------------------------------------------------

interface PnpmOutdatedEntry {
  current?: string;
  latest?: string;
  wanted?: string;
}

/**
 * Runs `pnpm outdated --json` and parses its output. `pnpm outdated` exits non-zero when outdated
 * packages ARE found (the common case), so a thrown `execSync` error's own `.stdout` is checked
 * before giving up — only a missing pnpm binary or genuinely empty output returns `null`.
 */
function runPnpmOutdated(projectPath: string): Record<string, PnpmOutdatedEntry> | null {
  try {
    const raw = execSync('pnpm outdated --json', { cwd: projectPath, stdio: 'pipe' }).toString();
    return JSON.parse(raw) as Record<string, PnpmOutdatedEntry>;
  } catch (error) {
    const stdout = (error as { stdout?: Buffer | string } | undefined)?.stdout;
    if (!stdout) return null; // pnpm not installed / not available — degrade, never throw
    try {
      return JSON.parse(stdout.toString()) as Record<string, PnpmOutdatedEntry>;
    } catch {
      return null; // malformed/empty JSON — degrade, never throw
    }
  }
}

/** Extracts the leading major-version integer from a semver-ish string (`^5.4.1` -> 5), or `null`. */
function parseMajorVersion(version: string | undefined): number | null {
  if (!version) return null;
  const match = /(\d+)/.exec(version);
  if (!match) return null;
  const digits = match[1];
  if (!digits) return null;
  const parsed = Number.parseInt(digits, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function detectOutdatedMajor(projectPath: string): DependencyFinding[] {
  const outdated = runPnpmOutdated(projectPath);
  if (!outdated) return [];

  const findings: DependencyFinding[] = [];
  for (const [packageName, entry] of Object.entries(outdated)) {
    const currentMajor = parseMajorVersion(entry.current);
    const latestMajor = parseMajorVersion(entry.latest);
    if (currentMajor === null || latestMajor === null) continue;
    if (latestMajor <= currentMajor) continue;

    findings.push({
      packageName,
      findingType: 'outdated_major',
      detail: `"${packageName}" is on major version ${currentMajor} (${entry.current}) — a new major ${latestMajor} (${entry.latest}) is available per pnpm outdated`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// unused / missing / duplicate detection
// ---------------------------------------------------------------------------

/**
 * Declared packages with zero usage anywhere in `usedPackages` (src/ imports plus the config-file
 * and scripts/ exclusions). `dependencies` misses are reported as errors, `devDependencies` misses
 * as warnings (severity encoded in `detail` since the finding shape has no dedicated field).
 * `@types/*` packages are always excluded — they are consumed implicitly by the compiler, never
 * imported directly.
 */
function detectUnused(
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
  usedPackages: Set<string>
): DependencyFinding[] {
  const findings: DependencyFinding[] = [];

  for (const packageName of Object.keys(dependencies)) {
    if (packageName.startsWith('@types/')) continue;
    if (usedPackages.has(packageName)) continue;
    findings.push({
      packageName,
      findingType: 'unused',
      detail: `[error] "${packageName}" is listed in dependencies but is never imported under src/, a recognized config file, or scripts/`,
    });
  }

  for (const packageName of Object.keys(devDependencies)) {
    if (packageName.startsWith('@types/')) continue;
    if (usedPackages.has(packageName)) continue;
    findings.push({
      packageName,
      findingType: 'unused',
      detail: `[warning] "${packageName}" is listed in devDependencies but is never imported under src/, a recognized config file, or scripts/`,
    });
  }

  return findings;
}

/** Packages imported under src/ but declared nowhere in package.json — likely transitive. */
function detectMissing(
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
  srcImportedPackages: Set<string>
): DependencyFinding[] {
  const findings: DependencyFinding[] = [];

  for (const packageName of srcImportedPackages) {
    if (packageName in dependencies || packageName in devDependencies) continue;
    findings.push({
      packageName,
      findingType: 'missing',
      detail: `"${packageName}" is imported under src/ but is not declared in package.json — likely a transitive dependency being imported directly`,
    });
  }

  return findings;
}

/** Packages declared in both `dependencies` and `devDependencies`. */
function detectDuplicates(
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>
): DependencyFinding[] {
  const findings: DependencyFinding[] = [];

  for (const packageName of Object.keys(dependencies)) {
    if (!(packageName in devDependencies)) continue;
    findings.push({
      packageName,
      findingType: 'duplicate',
      detail: `"${packageName}" is declared in both dependencies (${dependencies[packageName] ?? 'unknown'}) and devDependencies (${devDependencies[packageName] ?? 'unknown'})`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Build Memory persistence (Contract 4 — best-effort, never throws)
// ---------------------------------------------------------------------------

function persistFindings(runId: string, projectPath: string, findings: DependencyFinding[]): void {
  if (findings.length === 0) return;

  const db = getClient();
  if (!db) return; // Build Memory unavailable — degrade to stateless mode

  try {
    const insert = db.prepare(
      `INSERT INTO dependency_audit_findings
         (id, build_run_id, project_path, package_name, finding_type, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAll = db.transaction((rows: DependencyFinding[]) => {
      for (const row of rows) {
        insert.run(newId(), runId, projectPath, row.packageName, row.findingType, row.detail, nowIso());
      }
    });
    insertAll(findings);
  } catch (error) {
    logMemoryWarning('dependency-auditor:persist', error);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const FINDING_TYPE_ORDER: Record<DependencyFinding['findingType'], number> = {
  missing: 0,
  duplicate: 1,
  unused: 2,
  outdated_major: 3,
};

export class DependencyAuditor {
  /**
   * Audits `<projectPath>/package.json` dependencies/devDependencies against actual usage:
   * unused (declared but never imported under src/, a recognized root config file, or scripts/ —
   * error for `dependencies`, warning for `devDependencies`), missing (imported under src/ but
   * never declared — likely a transitive dependency imported directly), duplicate (declared in
   * both dependencies and devDependencies), and outdated_major (a major-version update is
   * available per `pnpm outdated --json`, best-effort — silently skipped when pnpm is
   * unavailable). Read-only against the project. Findings are persisted to
   * `dependency_audit_findings` (best-effort) and returned sorted by finding type then package name.
   */
  async audit(projectPath: string): Promise<DependencyFinding[]> {
    const runId = newId();

    const pkgJson = readPackageJson(projectPath);
    if (!pkgJson) return [];

    const dependencies = pkgJson.dependencies ?? {};
    const devDependencies = pkgJson.devDependencies ?? {};

    const srcFiles = walkFiles(join(projectPath, 'src'), SRC_FILE_RE);
    const scriptFiles = walkFiles(join(projectPath, 'scripts'), SCRIPT_FILE_RE);
    const configFiles = findConfigFiles(projectPath);

    const srcImportedPackages = collectPackageNames(srcFiles);
    const usedPackages = new Set<string>(srcImportedPackages);
    for (const name of collectPackageNames(scriptFiles)) usedPackages.add(name);
    for (const name of collectPackageNames(configFiles)) usedPackages.add(name);

    const findings: DependencyFinding[] = [
      ...detectMissing(dependencies, devDependencies, srcImportedPackages),
      ...detectDuplicates(dependencies, devDependencies),
      ...detectUnused(dependencies, devDependencies, usedPackages),
      ...detectOutdatedMajor(projectPath),
    ];

    findings.sort(
      (a, b) =>
        FINDING_TYPE_ORDER[a.findingType] - FINDING_TYPE_ORDER[b.findingType] ||
        a.packageName.localeCompare(b.packageName)
    );

    persistFindings(runId, projectPath, findings);

    return findings;
  }
}

export function createDependencyAuditor(): DependencyAuditor {
  return new DependencyAuditor();
}
