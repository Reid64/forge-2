/**
 * FORGE 2.0 — Design System Generator (UI/UX Pro Max integration).
 *
 * Bridges FORGE to the **UI/UX Pro Max** skill so every project FORGE designs gets a
 * complete, project-appropriate DESIGN SYSTEM (palette, typography, spacing tokens,
 * shadow depths, and component specs) BEFORE any UI is generated — then writes it to the
 * target project's governance as `DESIGN_SYSTEM.md` and feeds it into every UI prompt.
 *
 * HOW IT WORKS
 *   The skill ships a Python search engine (`scripts/search.py`) over a curated design
 *   corpus (styles, color palettes, font pairings, landing patterns, UX rules). Its
 *   `--design-system` mode runs five domain searches (product, style, color, landing,
 *   typography), applies the reasoning rules, and emits a complete recommendation. With
 *   `--persist` it writes a rich `design-system/<project-slug>/MASTER.md` (the variant
 *   that includes the spacing scale, shadow depths, and per-component CSS — i.e. the
 *   "colors + fonts + spacing + patterns" the task requires). This module:
 *     1. resolves the skill's `search.py` (bundled at `.claude/skills/ui-ux-pro-max/` or
 *        installed under `~/.claude/skills/`; overridable via env / options),
 *     2. derives a product-type query from the project name + PRD,
 *     3. runs `python search.py "<query>" --design-system --persist -p "<name>"
 *        -f markdown --output-dir <project>/.forge/uipro`,
 *     4. reads the generated MASTER.md, wraps it with a FORGE provenance header, and
 *        writes `<project>/<governance>/DESIGN_SYSTEM.md`,
 *     5. returns the document so callers (Phase 1B, Phase 3) can inject it into UI prompts.
 *
 * HOUSE STYLE (matching the sibling `src/tools/` modules — doc-generator, stack-detector,
 * visual-regression, live-preview-gate): best-effort and NON-FATAL. Every collaborator is
 * injectable (the script runner, the script-path resolver), every read/spawn is guarded,
 * and a missing Python / missing skill / non-zero exit degrades to `generated:false` plus
 * a warning rather than throwing. `generateDesignSystem` NEVER rejects. It writes only the
 * new `DESIGN_SYSTEM.md` (and scratch under `.forge/`) — never an immutable governance
 * file (Iron Law 1); `DESIGN_SYSTEM.md` is a generated OUTPUT artifact, not a FORGE input.
 *
 * The child process is spawned WITHOUT a shell with a static argument array, so the
 * free-text query and absolute script path (which may contain spaces) carry no injection
 * surface; no secrets are read or emitted.
 */

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { logLine } from './forge-logger.js';
import { nowIso } from '../memory/index.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The result of {@link generateDesignSystem}. */
export interface DesignSystemResult {
  /** Project name the design system was generated for. */
  projectName: string;
  /** The free-text product-type query handed to the UI/UX Pro Max search engine. */
  productType: string;
  /** True when the skill produced a design system (false = degraded; see `warnings`). */
  generated: boolean;
  /**
   * The full `DESIGN_SYSTEM.md` content (the skill's MASTER.md wrapped with a FORGE
   * provenance header). Empty string when `generated` is false.
   */
  markdown: string;
  /** Absolute path `DESIGN_SYSTEM.md` was written to, or `null` if not written. */
  designSystemPath: string | null;
  /** Project-relative output directory the document was (or would be) written to. */
  outputDir: string;
  /** Output file name (default `DESIGN_SYSTEM.md`). */
  fileName: string;
  /** Resolved absolute path of the skill's `search.py`, or `null` if it was not found. */
  scriptPath: string | null;
  /** The Python interpreter that ran the script, or `null` if none was available. */
  pythonCommand: string | null;
  /** Non-fatal observations (skill not found, no Python, non-zero exit, write failure, …). */
  warnings: string[];
  /** ISO 8601 timestamp the design system was generated. */
  generatedAt: string;
}

/** The outcome of one script invocation (never rejects). */
export interface ScriptRunResult {
  /** Captured standard output (UTF-8). */
  stdout: string;
  /** Captured standard error (UTF-8). */
  stderr: string;
  /** Process exit code, or `null` when killed / never started. */
  exitCode: number | null;
  /**
   * True when the interpreter actually started. `false` means the executable was missing
   * (ENOENT) — the caller should try the next Python candidate.
   */
  spawned: boolean;
  /** Spawn / runtime error message, or `null`. */
  errorMessage: string | null;
}

/** Context passed to a {@link ScriptRunner}. */
export interface ScriptRunContext {
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
}

/** Runs `python <args…>` and resolves to a {@link ScriptRunResult}. Injectable for tests. */
export type ScriptRunner = (
  pythonCommand: string,
  args: string[],
  context: ScriptRunContext
) => Promise<ScriptRunResult>;

/** Options for {@link generateDesignSystem}. */
export interface DesignSystemOptions {
  /** Project name (drives the output header + the persisted folder slug). Default: basename. */
  projectName?: string;
  /**
   * Explicit product-type query for the search engine (e.g. "fintech crypto dashboard").
   * Default: derived from `prd` + `projectName` via {@link deriveProductTypeQuery}.
   */
  productType?: string;
  /** PRD text used to derive the product-type query when `productType` is omitted. */
  prd?: string;
  /** Output directory relative to the project root. Default `'governance'`. */
  outputDir?: string;
  /** Output file name. Default `'DESIGN_SYSTEM.md'`. */
  fileName?: string;
  /** Write the document to disk. Default `true`; `false` returns content only. */
  write?: boolean;
  /** Absolute path to the skill's `search.py` (skips resolution). */
  scriptPath?: string;
  /** Skill directory (its `scripts/search.py` is used). */
  skillDir?: string;
  /** Explicit Python interpreter. Default: `FORGE_PYTHON` env, else the candidate list. */
  pythonCommand?: string;
  /** Python interpreter candidates to try in order. Default `['python','python3','py']`. */
  pythonCandidates?: string[];
  /** Per-invocation timeout in ms. Default 60000. */
  timeoutMs?: number;
  /** Environment for the child process. Default: inherit `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injected script runner (tests). Default spawns `python` via `node:child_process`. */
  runScript?: ScriptRunner;
  /** Injected script-path resolver (tests). Default: {@link resolveScriptPath}. */
  resolveScriptPath?: () => Promise<string | null>;
  /** Progress logger. Defaults to FORGE's structured logger (`forge-logger`, tagged `design-system`). */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Python interpreters tried, in order, when none is pinned. */
export const DEFAULT_PYTHON_CANDIDATES: readonly string[] = ['python', 'python3', 'py'];

/** Default per-invocation timeout (the search engine is fast, but corpus IO varies). */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Skill-relative path of the search entry point (used by the resolver + walk-up). */
const SKILL_SCRIPT_REL = join('.claude', 'skills', 'ui-ux-pro-max', 'scripts', 'search.py');

// ---------------------------------------------------------------------------
// Guarded helpers
// ---------------------------------------------------------------------------

/** Default progress logger. */
function defaultLog(message: string): void {
  logLine('design-system')(message);
}

/** Does a path exist (and is accessible)? */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Read a UTF-8 text file, returning `null` if it cannot be read. */
async function readTextSafe(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** Truncate a string for inclusion in a warning. */
function clip(s: string, max = 400): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** The persisted folder slug used by the skill: lower-cased, spaces → hyphens. */
function projectSlug(projectName: string): string {
  return projectName.toLowerCase().replace(/ /g, '-');
}

// ---------------------------------------------------------------------------
// Product-type query derivation (project name + PRD overview)
// ---------------------------------------------------------------------------

/** Collapse runs of whitespace to single spaces and trim. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** First non-empty paragraph under a `## Section` heading (best-effort). */
function sectionParagraph(markdown: string, heading: string): string | null {
  const re = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?:^##\\s|$)`, 'im');
  const m = re.exec(markdown);
  if (!m || m[1] === undefined) return null;
  for (const para of m[1].split(/\n\s*\n/)) {
    const text = collapse(para);
    if (text !== '' && !text.startsWith('#')) return text;
  }
  return null;
}

/** First non-empty, non-heading paragraph anywhere in the document. */
function firstParagraph(markdown: string): string | null {
  for (const para of markdown.split(/\n\s*\n/)) {
    const text = collapse(para);
    if (text !== '' && !text.startsWith('#') && !text.startsWith('-') && !text.startsWith('>')) {
      return text;
    }
  }
  return null;
}

/**
 * Derive a concise product-type search query from the project name and PRD. Prefers the
 * PRD's "Product Overview" / "Overview" paragraph, else the first real paragraph; caps the
 * length so the BM25 search stays focused. Falls back to the project name alone.
 */
export function deriveProductTypeQuery(prd: string, projectName?: string): string {
  const name = (projectName ?? '').trim();
  const text = prd ?? '';
  const overview =
    sectionParagraph(text, 'Product Overview') ??
    sectionParagraph(text, 'Overview') ??
    sectionParagraph(text, 'Product') ??
    firstParagraph(text);
  const words = (overview ?? '').split(/\s+/).filter((w) => w !== '').slice(0, 24).join(' ');
  const query = [name, words].filter((s) => s.trim() !== '').join(' ').trim();
  return query === '' ? name || 'web application' : query;
}

// ---------------------------------------------------------------------------
// Skill-script resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the UI/UX Pro Max `search.py`, checking (in order): explicit option, the
 * `FORGE_UIPRO_SCRIPT` / `FORGE_UIPRO_SKILL_DIR` env vars, the skill bundled inside the
 * FORGE install (walking up from this module to find `.claude/skills/ui-ux-pro-max/`), and
 * finally the per-user skill install under `~/.claude/skills/`. Returns the first that
 * exists, or `null`.
 */
export async function resolveScriptPath(options: DesignSystemOptions = {}): Promise<string | null> {
  const candidates: string[] = [];
  if (options.scriptPath) candidates.push(options.scriptPath);
  const envScript = process.env.FORGE_UIPRO_SCRIPT;
  if (envScript) candidates.push(envScript);
  if (options.skillDir) candidates.push(join(options.skillDir, 'scripts', 'search.py'));
  const envSkillDir = process.env.FORGE_UIPRO_SKILL_DIR;
  if (envSkillDir) candidates.push(join(envSkillDir, 'scripts', 'search.py'));

  // Walk up from this module's directory to find the bundled skill.
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
      candidates.push(join(dir, SKILL_SCRIPT_REL));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* import.meta unavailable (CJS interop) — rely on the other candidates. */
  }

  // The per-machine skill install.
  candidates.push(join(homedir(), SKILL_SCRIPT_REL));

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default script runner (spawn python, no shell, guarded)
// ---------------------------------------------------------------------------

/** Spawn `python <args…>` and capture stdout/stderr/exit. Never rejects. */
const defaultRunScript: ScriptRunner = (pythonCommand, args, ctx) =>
  new Promise<ScriptRunResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const finish = (r: ScriptRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(pythonCommand, args, {
        cwd: ctx.cwd,
        env: ctx.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // Synchronous spawn failure (rare) — resolve directly; `timer` isn't set yet.
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as NodeJS.ErrnoException).code ?? null;
      settled = true;
      resolve({ stdout: '', stderr: '', exitCode: null, spawned: code !== 'ENOENT', errorMessage: message });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      finish({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `${Buffer.concat(stderrChunks).toString('utf8')}\n(timed out after ${ctx.timeoutMs}ms)`.trim(),
        exitCode: null,
        spawned: true,
        errorMessage: 'timed out',
      });
    }, ctx.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (error: NodeJS.ErrnoException) => {
      // ENOENT = interpreter missing → not spawned → caller tries the next candidate.
      finish({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: null,
        spawned: error.code !== 'ENOENT',
        errorMessage: error.message,
      });
    });

    child.on('close', (code: number | null) => {
      finish({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: code,
        spawned: true,
        errorMessage: null,
      });
    });
  });

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Strip the trailing `===… persisted …===` confirmation banner from the script stdout. */
function stripPersistBanner(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  const i = lines.findIndex((l) => /^={10,}$/.test(l.trim()));
  return (i >= 0 ? lines.slice(0, i) : lines).join('\n').trim();
}

/** Wrap the skill's MASTER.md with a FORGE provenance header → `DESIGN_SYSTEM.md`. */
export function renderDesignSystemDoc(
  master: string,
  meta: { projectName: string; productType: string; generatedAt: string }
): string {
  return [
    `# ${meta.projectName} — DESIGN SYSTEM (FORGE × UI/UX Pro Max)`,
    '',
    `- **Generated:** ${meta.generatedAt}`,
    `- **Product-type query:** ${meta.productType}`,
    '- **Source:** UI/UX Pro Max design intelligence (`search.py --design-system --persist`)',
    '',
    '> Auto-generated design system. FORGE injects this document into EVERY UI prompt context',
    '> during Phase 1B (FrontendArchitecture + InteractionMaps) and Phase 3 UI prompts, so all',
    '> generated UI uses one consistent palette, type scale, spacing scale, shadow depths, and',
    '> component spec. Re-run the generator to refresh — do not hand-edit (it is overwritten).',
    '',
    '---',
    '',
    master.trim(),
    '',
  ].join('\n');
}

/**
 * Wrap a generated `DESIGN_SYSTEM.md` body as an authoritative block to append to a UI
 * prompt. Returns `''` for empty input (so callers can inject unconditionally).
 */
export function renderDesignSystemPromptBlock(markdown: string): string {
  if (markdown.trim() === '') return '';
  return [
    '## DESIGN SYSTEM — AUTHORITATIVE (every UI element MUST conform)',
    '',
    'A design system was generated for this project. Use these EXACT colors (hex), fonts,',
    'spacing tokens, shadow depths, and component specs for every page and component you design.',
    'Do NOT invent a different palette or type scale. Honor the listed anti-patterns.',
    '',
    markdown.trim(),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate a complete design system for the project at `projectPath` via the UI/UX Pro Max
 * skill, and (unless `write:false`) write it to `<outputDir>/<fileName>` (default
 * `governance/DESIGN_SYSTEM.md`).
 *
 * Always resolves (never rejects). A missing skill, a missing Python interpreter, or a
 * non-zero script exit yields `generated:false` plus a `warnings` entry — the caller (Phase
 * 1B) continues without injection rather than failing the build.
 */
export async function generateDesignSystem(
  projectPath: string,
  options: DesignSystemOptions = {}
): Promise<DesignSystemResult> {
  const log = options.log ?? defaultLog;
  const warnings: string[] = [];
  const generatedAt = nowIso();
  const projectName = (options.projectName ?? '').trim() || basename(projectPath) || 'Project';
  const productType =
    (options.productType ?? '').trim() || deriveProductTypeQuery(options.prd ?? '', projectName);
  const outputDir = options.outputDir ?? 'governance';
  const fileName = options.fileName ?? 'DESIGN_SYSTEM.md';
  const write = options.write ?? true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const runScript = options.runScript ?? defaultRunScript;

  const base: DesignSystemResult = {
    projectName,
    productType,
    generated: false,
    markdown: '',
    designSystemPath: null,
    outputDir,
    fileName,
    scriptPath: null,
    pythonCommand: null,
    warnings,
    generatedAt,
  };

  // 1. Resolve the skill's search.py.
  const scriptPath = options.resolveScriptPath
    ? await options.resolveScriptPath()
    : await resolveScriptPath(options);
  if (!scriptPath) {
    warnings.push(
      'UI/UX Pro Max skill not found (looked for .claude/skills/ui-ux-pro-max/scripts/search.py ' +
        'in the FORGE install and ~/.claude/skills). Install it or set FORGE_UIPRO_SKILL_DIR; ' +
        'skipping design-system generation.'
    );
    log('skill search.py not found — skipping (non-fatal)');
    return base;
  }
  base.scriptPath = scriptPath;

  // 2. Prepare the scratch output dir for the persisted MASTER.md.
  const workDir = join(projectPath, '.forge', 'uipro');
  try {
    await mkdir(workDir, { recursive: true });
  } catch (error) {
    warnings.push(`Could not create ${join('.forge', 'uipro')} (${error instanceof Error ? error.message : String(error)}).`);
  }
  const masterPath = join(workDir, 'design-system', projectSlug(projectName), 'MASTER.md');
  const args = [
    scriptPath,
    productType,
    '--design-system',
    '--persist',
    '-p',
    projectName,
    '-f',
    'markdown',
    '--output-dir',
    workDir,
  ];

  // 3. Run the script, trying each Python interpreter until one starts.
  const pinned = options.pythonCommand ?? process.env.FORGE_PYTHON;
  const candidates = pinned ? [pinned] : options.pythonCandidates ?? [...DEFAULT_PYTHON_CANDIDATES];
  let run: ScriptRunResult | null = null;
  let usedPython: string | null = null;
  for (const py of candidates) {
    log(`generating design system: ${py} search.py "${clip(productType, 80)}" --design-system --persist`);
    const r = await runScript(py, args, { cwd: projectPath, timeoutMs, env, log });
    if (!r.spawned) {
      log(`Python '${py}' not available (${r.errorMessage ?? 'not found'}); trying next candidate`);
      continue;
    }
    run = r;
    usedPython = py;
    break;
  }
  if (!run || !usedPython) {
    warnings.push(
      `No Python interpreter available (tried ${candidates.join(', ')}). Install Python 3 ` +
        '(UI/UX Pro Max prerequisite) or set FORGE_PYTHON; skipping design-system generation.'
    );
    log('no Python interpreter found — skipping (non-fatal)');
    return base;
  }
  base.pythonCommand = usedPython;

  if (run.exitCode !== 0) {
    warnings.push(
      `UI/UX Pro Max script exited with code ${run.exitCode ?? 'null'}: ${clip(run.stderr || run.errorMessage || 'no output')}`
    );
    log(`script failed (exit ${run.exitCode ?? 'null'}) — skipping (non-fatal)`);
    return base;
  }

  // 4. Read the persisted MASTER.md (richest output); fall back to the stdout markdown.
  let master = await readTextSafe(masterPath);
  if (master === null) {
    const fromStdout = stripPersistBanner(run.stdout);
    if (fromStdout === '') {
      warnings.push(`Script succeeded but no MASTER.md was found at ${masterPath} and stdout was empty.`);
      log('no MASTER.md and empty stdout — skipping (non-fatal)');
      return base;
    }
    warnings.push(`MASTER.md not found at ${masterPath}; used the (less detailed) stdout markdown.`);
    master = fromStdout;
  }

  const doc = renderDesignSystemDoc(master, { projectName, productType, generatedAt });

  // 5. Write DESIGN_SYSTEM.md to the target project's governance directory.
  let designSystemPath: string | null = null;
  if (write) {
    try {
      await mkdir(join(projectPath, outputDir), { recursive: true });
      const target = join(projectPath, outputDir, fileName);
      await writeFile(target, doc, 'utf8');
      designSystemPath = target;
      log(`wrote ${outputDir}/${fileName} (${Buffer.byteLength(doc, 'utf8')} bytes)`);
    } catch (error) {
      warnings.push(`Failed to write ${outputDir}/${fileName}: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  return {
    projectName,
    productType,
    generated: true,
    markdown: doc,
    designSystemPath,
    outputDir,
    fileName,
    scriptPath,
    pythonCommand: usedPython,
    warnings,
    generatedAt,
  };
}

export default generateDesignSystem;
