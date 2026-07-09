/**
 * FORGE 2.0 — `forge health` diagnostic command.
 *
 * Reports, from LIVE data only (never hardcoded): Build Memory's db path, schema
 * version, and per-table row counts across both table families; the machine id;
 * whether the UI/UX Pro Max skill's `search.py` resolves and a Python interpreter
 * responds; which skill folders are installed; whether `ANTHROPIC_API_KEY` is set
 * (never printing the value); and, per capability, whether it is WIRED (its code
 * path is actually referenced by the phase that would invoke it, or its Build
 * Memory table has rows) or NEVER-INVOKED.
 *
 * Writes the same report to `FORGE_HEALTH.md` at the FORGE install root, so a
 * silent-stateless FORGE is now impossible to miss — the file is regenerated
 * every time this command runs.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import chalk from 'chalk';

import {
  getAllTableHealth,
  getConnection,
  getForgeDbPath,
  getMachineId,
  getSchemaVersion,
  type TableHealth,
} from '../learning/database.js';
import { DEFAULT_PYTHON_CANDIDATES, resolveScriptPath } from '../tools/design-system-generator.js';
import type { QueueVersionRow } from '../tools/queue-versioning.js';

/** Resolve the FORGE install root (this repo's root), independent of the caller's cwd. */
function resolveForgeRoot(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // dist/cli
    return join(here, '..', '..');
  } catch {
    return process.cwd();
  }
}

/** Read a FORGE-root-relative source file, or `null` if it cannot be read. */
function readForgeSource(forgeRoot: string, relPath: string): string | null {
  try {
    return readFileSync(join(forgeRoot, relPath), 'utf8');
  } catch {
    return null;
  }
}

/** A capability is WIRED when the given needle string appears in the given source file. */
function isReferencedIn(forgeRoot: string, relPath: string, needle: string): boolean {
  const content = readForgeSource(forgeRoot, relPath);
  return content !== null && content.includes(needle);
}

/** Try each Python candidate with `--version`; return the first that responds, or null. */
function detectPython(candidates: readonly string[]): { command: string; version: string } | null {
  for (const cmd of candidates) {
    try {
      const result = spawnSync(cmd, ['--version'], { timeout: 5000, encoding: 'utf8' });
      if (result.error) continue;
      if (result.status === 0 || result.status === null) {
        const version = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
        if (version) return { command: cmd, version };
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** One skill folder found under `.claude/skills/` (the corpus) or `skills/` (Phase 3's `skillsDir`). */
interface SkillFolder {
  /** e.g. `.claude/skills/ui-ux-pro-max` or `skills/frontend-design`. */
  name: string;
  hasSkillMd: boolean;
}

/** List every skill sub-folder under `<forgeRoot>/<relDir>`, labelled `<relDir>/<name>`. */
function listSkillFoldersIn(forgeRoot: string, relDir: string): SkillFolder[] {
  const skillsDir = join(forgeRoot, ...relDir.split('/'));
  if (!existsSync(skillsDir)) return [];
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({
        name: `${relDir}/${e.name}`,
        hasSkillMd: existsSync(join(skillsDir, e.name, 'SKILL.md')),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * List every skill folder FORGE knows about: the `.claude/skills/` corpus (the UI/UX Pro Max
 * design-intelligence source `src/tools/design-system-generator.ts` queries) AND the
 * `skills/` directory beside the FORGE root that Phase 3's `skillsDir` resolves for
 * queue-declared `skills:` injection (`src/phases/phase3-executor.ts` → `loadSkillContent`).
 */
function listSkillFolders(forgeRoot: string): SkillFolder[] {
  return [...listSkillFoldersIn(forgeRoot, '.claude/skills'), ...listSkillFoldersIn(forgeRoot, 'skills')];
}

/** The most recent `queue_versions` row across every project, or `null` if none exist yet. */
function latestQueueVersion(): QueueVersionRow | null {
  try {
    const db = getConnection();
    const row = db.prepare('SELECT * FROM queue_versions ORDER BY created_at DESC LIMIT 1').get() as
      | QueueVersionRow
      | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

interface WiringStatus {
  capability: string;
  wired: boolean;
  detail: string;
}

export interface HealthReport {
  generatedAt: string;
  dbPath: string;
  schemaVersion: string;
  tables: TableHealth[];
  machineId: string;
  uiUxProMax: {
    scriptPath: string | null;
    found: boolean;
    python: { command: string; version: string } | null;
  };
  skillFolders: SkillFolder[];
  anthropicApiKeyPresent: boolean;
  /** Total `queue_versions` rows + the most recent snapshot across every project (Session 3 — Autonomy). */
  promptLibrary: { totalSnapshots: number; latest: QueueVersionRow | null };
  /** Learning-loop table row counts + last-write timestamps (Session 4 — Intelligence & Observability). */
  learning: Array<{ table: string; rowCount: number; lastWrite: string | null }>;
  wiring: WiringStatus[];
}

/** Gather the full health report from live data. Never throws. */
export async function gatherHealthReport(): Promise<HealthReport> {
  const forgeRoot = resolveForgeRoot();
  const dbPath = getForgeDbPath();
  const schemaVersion = getSchemaVersion();
  const tables = getAllTableHealth();
  const machineId = getMachineId();

  const scriptPath = await resolveScriptPath();
  const python = detectPython(DEFAULT_PYTHON_CANDIDATES);
  const skillFolders = listSkillFolders(forgeRoot);
  const anthropicApiKeyPresent = Boolean(process.env['ANTHROPIC_API_KEY']?.trim());

  const tableRowCount = (name: string): number => tables.find((t) => t.table === name)?.rowCount ?? 0;

  const brandsRows = tableRowCount('brand_identities');
  const brandsSourceWired = isReferencedIn(forgeRoot, 'src/phases/phase1b-architect.ts', 'createBrand') &&
    isReferencedIn(forgeRoot, 'src/phases/phase1b-architect.ts', 'updateBrand');

  const wiring: WiringStatus[] = [
    {
      capability: 'design-system generation',
      wired: isReferencedIn(forgeRoot, 'src/phases/phase1b-architect.ts', 'generateDesignSystem'),
      detail: 'src/phases/phase1b-architect.ts calls generateDesignSystem() during Phase 1B.',
    },
    {
      capability: 'skill injection',
      wired: isReferencedIn(forgeRoot, 'src/phases/phase3-executor.ts', 'loadSkillContent'),
      detail: 'src/phases/phase3-executor.ts reads queue entry `skills:` via loadSkillContent().',
    },
    {
      capability: 'ui skill declarations',
      wired: isReferencedIn(forgeRoot, 'src/engine/queue-generator.ts', 'frontend-design'),
      detail: 'src/engine/queue-generator.ts declares skills: [frontend-design, ui-ux-pro-max] on every UI-producing entry.',
    },
    {
      capability: 'design-doc injection',
      wired: isReferencedIn(forgeRoot, 'src/phases/phase3-executor.ts', 'DESIGN_SYSTEM.md'),
      detail: 'src/phases/phase3-executor.ts GOVERNANCE_DOC_NAMES includes DESIGN_SYSTEM.md.',
    },
    {
      capability: 'brands storage',
      wired: brandsSourceWired || brandsRows > 0,
      detail: `src/phases/phase1b-architect.ts ${brandsSourceWired ? 'calls' : 'does NOT call'} createBrand/updateBrand; brand_identities has ${brandsRows} row(s).`,
    },
    {
      capability: 'learning hooks',
      wired: tableRowCount('hook_execution_log') > 0,
      detail: `hook_execution_log has ${tableRowCount('hook_execution_log')} row(s).`,
    },
    {
      capability: 'codebase RAG',
      wired: isReferencedIn(forgeRoot, 'src/phases/phase3-executor.ts', 'CodebaseRag'),
      detail: 'src/phases/phase3-executor.ts imports CodebaseRag from src/tools/codebase-rag.ts.',
    },
    {
      capability: 'forge compile',
      wired: isReferencedIn(forgeRoot, 'src/cli/index.ts', "command('compile')"),
      detail: 'src/cli/index.ts registers the `compile` command (src/cli/compile-command.ts).',
    },
    {
      capability: 'auto-resume',
      wired: isReferencedIn(forgeRoot, 'src/cli/index.ts', '--auto-resume'),
      detail: 'src/cli/index.ts declares --auto-resume on `forge build`, wired to src/engine/auto-resume.ts.',
    },
    {
      capability: 're-anchor injection',
      wired: isReferencedIn(forgeRoot, 'src/cli/compile-command.ts', 'REANCHOR_INTERVAL'),
      detail: 'src/cli/compile-command.ts injects a re-anchor entry every REANCHOR_INTERVAL (15) real prompts.',
    },
    {
      capability: 'error-pattern writes',
      wired:
        isReferencedIn(forgeRoot, 'src/phases/phase3-executor.ts', 'recordFailureObserved') &&
        isReferencedIn(forgeRoot, 'src/phases/phase3-executor.ts', 'recordRecoveryOutcome'),
      detail: 'src/phases/phase3-executor.ts calls recordFailureObserved/recordRecoveryOutcome (src/engine/learning-writeback.ts) on every Sentinel failure/recovery.',
    },
    {
      capability: 'auto-elevation',
      wired: isReferencedIn(forgeRoot, 'src/engine/learning-writeback.ts', 'checkAutoElevation'),
      detail: 'src/engine/learning-writeback.ts calls checkAutoElevation (src/learning/loops.ts) after every recovery outcome.',
    },
    {
      capability: 'build brain',
      wired: isReferencedIn(forgeRoot, 'src/phases/phase3-executor.ts', 'analyzeSentinelFailure'),
      detail: 'src/phases/phase3-executor.ts calls analyzeSentinelFailure (src/engine/build-brain.ts) on every Sentinel failure.',
    },
    {
      capability: 'live status',
      wired: isReferencedIn(forgeRoot, 'src/phases/phase3-executor.ts', 'LiveStatusWriter'),
      detail: 'src/phases/phase3-executor.ts writes .forge/live-status.json (src/tools/live-status.ts) at every prompt lifecycle point.',
    },
    {
      capability: 'design-model pinning',
      wired: isReferencedIn(forgeRoot, 'src/engine/provider-router.ts', "complex_reasoning: ['anthropic']"),
      detail: "src/engine/provider-router.ts pins DEFAULT_ROUTES.complex_reasoning to ['anthropic'] only (Phase 1A/1B/adversarial review never route to a non-Claude provider).",
    },
    {
      capability: 'death forensics',
      wired:
        isReferencedIn(forgeRoot, 'src/phases/phase3-executor.ts', 'installDeathForensics') &&
        isReferencedIn(forgeRoot, 'src/phases/phase3-executor.ts', 'checkStaleLock'),
      detail: 'src/phases/phase3-executor.ts installs process-death handlers (src/tools/death-forensics.ts) and checks for a stale forge_running.lock at startup.',
    },
    {
      capability: 'git-init on greenfield',
      wired: isReferencedIn(forgeRoot, 'src/phases/phase0-scout.ts', 'ensureGitRepo'),
      detail: 'src/phases/phase0-scout.ts runs git init + an initial commit when the target project has no .git (Contract 10/11/12 never silently no-op on a greenfield project).',
    },
    {
      capability: 'spawn-cwd pinning (Windows shim resolution)',
      wired: isReferencedIn(forgeRoot, 'src/engine/claude-runner.ts', 'resolveWindowsClaudeExecutable'),
      detail: 'src/engine/claude-runner.ts resolves the real claude.exe directly on Windows and never combines shell:true with detached:true (Session 5.2 — that combination silently broke every claude invocation).',
    },
    {
      capability: 'file-delta law',
      wired: isReferencedIn(forgeRoot, 'src/phases/phase4-sentinel.ts', 'evaluateFileDelta'),
      detail: 'src/phases/phase4-sentinel.ts FAILs a non-exempt prompt whose git diff (main...HEAD) shows no added/modified files and whose expected output is not already on disk ("no work product").',
    },
  ];

  const queueVersionsCount = tableRowCount('queue_versions');
  const promptLibrary = { totalSnapshots: queueVersionsCount, latest: latestQueueVersion() };

  const LEARNING_TABLES = ['error_patterns', 'fix_patterns', 'governance_rules', 'cross_project_insights', 'prompt_scores'] as const;
  const learning = LEARNING_TABLES.map((table) => {
    const t = tables.find((x) => x.table === table);
    return { table, rowCount: t?.rowCount ?? 0, lastWrite: t?.mostRecentCreatedAt ?? null };
  });

  return {
    generatedAt: new Date().toISOString(),
    dbPath,
    schemaVersion,
    tables,
    machineId,
    uiUxProMax: { scriptPath, found: scriptPath !== null, python },
    skillFolders,
    anthropicApiKeyPresent,
    promptLibrary,
    learning,
    wiring,
  };
}

/** Render the report as Markdown (used for both the console-adjacent file and FORGE_HEALTH.md). */
export function renderHealthReportMarkdown(report: HealthReport): string {
  const lines: string[] = [];
  lines.push('# FORGE 2.0 — Health Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('## Build Memory');
  lines.push('');
  lines.push(`- Database: \`${report.dbPath}\``);
  lines.push(`- Schema version: \`${report.schemaVersion}\``);
  lines.push(`- Machine ID: \`${report.machineId}\``);
  lines.push('');
  lines.push('| Table | Exists | Rows | Most recent created_at |');
  lines.push('|---|---|---|---|');
  for (const t of report.tables) {
    lines.push(`| ${t.table} | ${t.exists ? 'yes' : 'MISSING'} | ${t.rowCount} | ${t.mostRecentCreatedAt ?? '—'} |`);
  }
  lines.push('');
  lines.push('## UI/UX Pro Max skill');
  lines.push('');
  lines.push(`- search.py: ${report.uiUxProMax.found ? `found at \`${report.uiUxProMax.scriptPath}\`` : 'MISSING'}`);
  lines.push(
    `- Python interpreter: ${
      report.uiUxProMax.python
        ? `responds (\`${report.uiUxProMax.python.command}\` → ${report.uiUxProMax.python.version})`
        : 'NOT FOUND (tried: ' + DEFAULT_PYTHON_CANDIDATES.join(', ') + ')'
    }`
  );
  lines.push('');
  lines.push('## Skills directories (.claude/skills/ + skills/)');
  lines.push('');
  if (report.skillFolders.length === 0) {
    lines.push('- (none found)');
  } else {
    for (const s of report.skillFolders) {
      lines.push(`- ${s.name} ${s.hasSkillMd ? '(SKILL.md present)' : '(MISSING SKILL.md)'}`);
    }
  }
  lines.push('');
  lines.push('## Prompt library (Session 3 — Autonomy)');
  lines.push('');
  lines.push(`- Snapshots (\`queue_versions\` rows): ${report.promptLibrary.totalSnapshots}`);
  if (report.promptLibrary.latest) {
    const l = report.promptLibrary.latest;
    lines.push(`- Latest: \`${l.project_name}\` — hash \`${l.queue_hash}\`, ${l.entry_count} entries, ${l.created_at}`);
    lines.push(`  - \`${l.snapshot_path}\``);
  } else {
    lines.push('- Latest: (none yet — run `forge compile`)');
  }
  lines.push('');
  lines.push('## Learning (Session 4 — Intelligence & Observability)');
  lines.push('');
  lines.push('| Table | Rows | Last write |');
  lines.push('|---|---|---|');
  for (const l of report.learning) {
    lines.push(`| ${l.table} | ${l.rowCount} | ${l.lastWrite ?? '—'} |`);
  }
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  lines.push(`- ANTHROPIC_API_KEY: ${report.anthropicApiKeyPresent ? 'present' : 'ABSENT'}`);
  lines.push('');
  lines.push('## Wiring status');
  lines.push('');
  lines.push('| Capability | Status | Detail |');
  lines.push('|---|---|---|');
  for (const w of report.wiring) {
    lines.push(`| ${w.capability} | ${w.wired ? 'WIRED' : 'NEVER-INVOKED'} | ${w.detail} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Render the report for the console (colorized, terser than the Markdown file). */
function renderHealthReportConsole(report: HealthReport): string {
  const lines: string[] = [];
  lines.push(chalk.bold('\nFORGE 2.0 — Health Report') + chalk.dim(`  (${report.generatedAt})`));

  lines.push(chalk.bold('\nBuild Memory'));
  lines.push(`  db:       ${report.dbPath}`);
  lines.push(`  schema:   ${report.schemaVersion}`);
  lines.push(`  machine:  ${report.machineId}`);
  const missingTables = report.tables.filter((t) => !t.exists);
  const totalRows = report.tables.reduce((s, t) => s + t.rowCount, 0);
  lines.push(
    `  tables:   ${report.tables.length} known (${chalk.red(String(missingTables.length) + ' missing')}), ${totalRows} total row(s)`
  );
  for (const t of report.tables) {
    const label = t.exists ? String(t.rowCount).padStart(6, ' ') : chalk.red('MISSING');
    lines.push(`    ${t.table.padEnd(24, ' ')} ${label}  ${chalk.dim(t.mostRecentCreatedAt ?? '—')}`);
  }

  lines.push(chalk.bold('\nUI/UX Pro Max'));
  lines.push(
    `  search.py: ${report.uiUxProMax.found ? chalk.green(report.uiUxProMax.scriptPath ?? '') : chalk.red('MISSING')}`
  );
  lines.push(
    `  python:    ${
      report.uiUxProMax.python
        ? chalk.green(`${report.uiUxProMax.python.command} (${report.uiUxProMax.python.version})`)
        : chalk.red('not found')
    }`
  );

  lines.push(chalk.bold('\nSkills directories'));
  if (report.skillFolders.length === 0) {
    lines.push(chalk.yellow('  (none found)'));
  } else {
    for (const s of report.skillFolders) {
      lines.push(`  ${s.name} ${s.hasSkillMd ? chalk.green('✔ SKILL.md') : chalk.red('✖ missing SKILL.md')}`);
    }
  }

  lines.push(chalk.bold('\nPrompt library'));
  lines.push(`  snapshots: ${report.promptLibrary.totalSnapshots}`);
  if (report.promptLibrary.latest) {
    const l = report.promptLibrary.latest;
    lines.push(`  latest:    ${l.project_name} — ${l.queue_hash} (${l.entry_count} entries, ${chalk.dim(l.created_at)})`);
  } else {
    lines.push(chalk.dim('  latest:    (none yet — run `forge compile`)'));
  }

  lines.push(chalk.bold('\nLearning'));
  for (const l of report.learning) {
    lines.push(`  ${l.table.padEnd(24, ' ')} ${String(l.rowCount).padStart(6, ' ')}  ${chalk.dim(l.lastWrite ?? '—')}`);
  }

  lines.push(chalk.bold('\nEnvironment'));
  lines.push(`  ANTHROPIC_API_KEY: ${report.anthropicApiKeyPresent ? chalk.green('present') : chalk.red('ABSENT')}`);

  lines.push(chalk.bold('\nWiring status'));
  for (const w of report.wiring) {
    const status = w.wired ? chalk.green('WIRED') : chalk.yellow('NEVER-INVOKED');
    lines.push(`  ${w.capability.padEnd(26, ' ')} ${status}  ${chalk.dim(w.detail)}`);
  }

  return lines.join('\n');
}

/** `forge health` — run the full diagnostic, print it, and write FORGE_HEALTH.md. */
export async function cmdHealth(): Promise<void> {
  const report = await gatherHealthReport();
  console.log(renderHealthReportConsole(report));

  const forgeRoot = resolveForgeRoot();
  const outPath = join(forgeRoot, 'FORGE_HEALTH.md');
  try {
    writeFileSync(outPath, renderHealthReportMarkdown(report), 'utf8');
    console.log(chalk.dim(`\nWrote ${outPath}`));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(chalk.yellow(`\nCould not write ${outPath}: ${detail}`));
  }
}
