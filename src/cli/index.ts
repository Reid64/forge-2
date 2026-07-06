#!/usr/bin/env node
/**
 * FORGE 2.0 — CLI entry point (queue.yaml s8-p01).
 *
 * The orchestrator the rest of FORGE was built to be driven by. Every phase module
 * (`runPhase0Scout`, `runPhase1aPrd`, `runPhase1bArchitect`, `runPhase2Governance` +
 * `generateQueue`, `runPhase3Executor`, `runPhase5Learner`) and the standalone tools
 * (`runProjectAutopsy`, `estimateBuildCost`) is a self-contained, never-throws unit;
 * this file wires them together behind a `commander` command surface and renders
 * their results with `chalk` + `ora`.
 *
 * Commands (BLUEPRINT F19):
 *   build <path>      Phase 0 → 1 → 2 → 3 → (4 per-prompt) → 5  (full autonomous pipeline)
 *   scout <path>      Phase 0 only (Toolchain Scout)
 *   design <path>     Phase 0 + 1 only (PRD + Architecture)
 *   resume <id>       Resume a halted build from its last checkpoint
 *   replay <id>       Re-execute a build from a checkpoint (F12)
 *   status [id]       Build status from Build Memory
 *   history           List past builds
 *   patterns          Known error patterns + success rates
 *   agents            Self-created agents + status
 *   resurrect <path>  Project Autopsy on a failed project (F10)
 *   estimate <path>   Cost/time estimate without building (F17)
 *   repair <path>     Repair a broken TypeScript repo (diagnose → cluster → queue → execute → verify)
 *
 * House style carried over from the phases: nothing here throws to the top level —
 * a failed command sets `process.exitCode` and prints a diagnostic. Build Memory
 * being unreachable is degraded-not-fatal (Contract 4): read commands say so rather
 * than crashing.
 *
 * NOTE on human gates (Contract 2): the design phases return Gate markers
 * (awaiting_human_approval). FORGE's IDENTITY is "ZERO human intervention during
 * execution", so `forge build` runs the pipeline end-to-end and surfaces each gate
 * as a prominent banner rather than blocking. Run `forge design` first when you want
 * to stop and review the PRD/Architecture before committing to a full build.
 */

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { dump as dumpYaml } from 'js-yaml';

import { loadConfig, describeConfig, type EnvConfig } from './config.js';

import { runPhase0Scout, type Phase0Result } from '../phases/phase0-scout.js';
import { runPhase1aPrd } from '../phases/phase1a-prd.js';
import { runPhase1bArchitect, type ArchitectureDesign } from '../phases/phase1b-architect.js';
import { runPhase2Governance } from '../phases/phase2-governance.js';
import { generateQueue, type QueueEntry } from '../engine/queue-generator.js';
import { runPhase3Executor, type Phase3Options, type Phase3Result } from '../phases/phase3-executor.js';
import { runPhase5Learner } from '../phases/phase5-learner.js';
import { runProjectAutopsy, renderAutopsyReportMarkdown, type AutopsyReport } from '../tools/project-autopsy.js';
import { estimateBuildCost, type FeatureSpec } from '../analysis/cost-estimator.js';
import { runRepairMode } from './repair-command.js';
import { checkpointTagFor } from '../engine/git-manager.js';
import { cmdHealth } from './health-command.js';
import { cmdCompile } from './compile-command.js';
import { cmdGeneratePrompts } from './generate-prompts-command.js';
import { diffQueueEntries, getQueueVersion, loadQueueEntriesFromFile } from '../tools/queue-versioning.js';

import { BuildMemory, nowIso } from '../memory/index.js';
import { registerLearningCommands } from './commands/learning.js';
import { getLogger } from '../tools/forge-logger.js';
import { getForgeDbPath, getSchemaVersion, initializeForgeMemory } from '../learning/database.js';
import { deriveBrandFromBaseline, type DesignTokenSet } from '../tools/brand-inheritance.js';
import {
  createTaskScheduler,
  getSchedulerDashboard,
  type SchedulerDashboardRow,
} from '../tools/task-scheduler.js';
import type {
  BuildRun,
  JsonObject,
  PromptExecution,
  RepairConfig,
  ScheduledTaskType,
  SelfCreatedAgent,
} from '../types/index.js';
import type { StackFingerprint } from '../tools/stack-detector.js';

/** The scheduler task types accepted by `forge schedule add --type`. */
const SCHEDULED_TASK_TYPES: readonly ScheduledTaskType[] = [
  'research_agent',
  'memory_cleanup',
  'log_rotation',
  'health_check',
  'deadline_scan',
  'quota_reset',
];

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Print the FORGE banner once at startup. */
function printHeader(): void {
  console.log(chalk.cyan.bold('FORGE 2.0') + chalk.dim(' — autonomous software factory'));
}

/** Print the config's non-fatal warnings (e.g. no .env, generated machine id). */
function printConfigWarnings(config: EnvConfig): void {
  for (const w of config.warnings) console.log(chalk.dim(`  • ${w}`));
}

/**
 * Run an async unit of work under an ora spinner, routing the work's progress
 * messages into the spinner's text (so the phases' verbose `log` output does not
 * scroll the terminal). The work functions never throw, but we still fail the
 * spinner defensively.
 */
async function withSpinner<T>(
  title: string,
  fn: (log: (message: string) => void) => Promise<T>
): Promise<T> {
  const spinner = ora({ text: title }).start();
  try {
    const result = await fn((message) => {
      spinner.text = `${title} ${chalk.dim('— ' + message)}`;
    });
    spinner.succeed(title);
    return result;
  } catch (error) {
    spinner.fail(title);
    throw error;
  }
}

/** Render a prominent human-gate banner (Contract 2). */
function gateBanner(name: string, detail: string): void {
  console.log('');
  console.log(chalk.yellow.bold(`⚠ HUMAN GATE — ${name}`));
  console.log(chalk.yellow(detail));
  console.log(chalk.dim('  (autonomous mode: FORGE proceeds — review the generated artifact when you can.)'));
  console.log('');
}

/** Print a list of warnings under a heading, if any. */
function printWarnings(warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  console.log(chalk.yellow(`  ${warnings.length} warning(s):`));
  for (const w of warnings) console.log(chalk.dim(`    • ${w}`));
}

/** Mark the current command as failed and print the reason. */
function fail(message: string): void {
  // Chalk line is the operator-facing presentation; the structured log captures it to the
  // per-build JSON file (and, at error level, feeds Build Memory error_patterns).
  console.error(chalk.red.bold('✖ ') + chalk.red(message));
  getLogger('cli').error(message);
  process.exitCode = 1;
}

/** A short status chip coloured by build/prompt state. */
function statusChip(status: string): string {
  switch (status) {
    case 'completed':
      return chalk.green(status);
    case 'running':
    case 'queued':
    case 'pending':
      return chalk.cyan(status);
    case 'failed':
    case 'halted':
      return chalk.red(status);
    case 'skipped':
      return chalk.dim(status);
    default:
      return status;
  }
}

/** Resolve + validate a project path argument to an absolute path. */
function resolveProjectPath(pathArg: string): string {
  return resolve(pathArg);
}

/** Cast a stored jsonb stack_fingerprint to the StackFingerprint shape (best-effort). */
function asStackFingerprint(json: JsonObject | null | undefined): StackFingerprint | null {
  if (!json || typeof json !== 'object') return null;
  return json as unknown as StackFingerprint;
}

// ---------------------------------------------------------------------------
// Phase 0 — Scout
// ---------------------------------------------------------------------------

/** Run Phase 0 with a spinner; return the result. Side effects per `options`. */
async function runScout(
  projectPath: string,
  options: { autoInstall?: boolean; autoFix?: boolean; writeToolchainFile?: boolean; skipSecurityGate?: boolean } = {}
): Promise<Phase0Result> {
  return withSpinner('Phase 0 — Toolchain Scout', (log) =>
    runPhase0Scout(projectPath, { ...options, log })
  );
}

/** Print the Phase 0 gate outcome. */
function reportScout(result: Phase0Result): void {
  const s = result.stackFingerprint;
  console.log(
    chalk.dim(
      `  stack: framework=${s.framework ?? '—'} db=${s.database ?? '—'} pm=${s.packageManager ?? '—'}`
    )
  );
  if (result.passed) {
    console.log(chalk.green('  ✔ Phase 0 gate PASSED — environment is ready.'));
  } else {
    console.log(chalk.red(`  ✖ Phase 0 gate FAILED — ${result.blockers.length} blocker(s):`));
    for (const b of result.blockers) console.log(chalk.red(`    • ${b}`));
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** `forge scout <path>` — Phase 0 only. */
async function cmdScout(pathArg: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  console.log(chalk.bold(`\nScouting ${projectPath}`));
  const result = await runScout(projectPath);
  reportScout(result);
  if (!result.passed) process.exitCode = 1;
}

/** `forge design <path> --idea` — Phase 0 + 1 (PRD + Architecture), stops at Gate 2. */
async function cmdDesign(pathArg: string, opts: { idea?: string; prd?: string; skipSecurityGate?: boolean }): Promise<ArchitectureDesign | null> {
  const projectPath = resolveProjectPath(pathArg);

  const scout = await runScout(projectPath, { skipSecurityGate: opts.skipSecurityGate });
  reportScout(scout);
  if (!scout.passed) {
    fail('Phase 0 did not pass — resolve the blockers above before designing.');
    return null;
  }

  // PRD: from --prd file, else generate via Phase 1A from --idea.
  let prd: string;
  if (opts.prd) {
    prd = await readFile(resolve(opts.prd), 'utf8');
    console.log(chalk.dim(`  using supplied PRD: ${resolve(opts.prd)}`));
  } else if (opts.idea) {
    const prdResult = await withSpinner('Phase 1A — PRD Generator', (log) =>
      runPhase1aPrd(projectPath, opts.idea ?? '', { stackFingerprint: scout.stackFingerprint, log })
    );
    prd = prdResult.prd;
    printWarnings(prdResult.warnings);
    if (prdResult.usedFallback) {
      console.log(chalk.yellow('  PRD used a deterministic fallback (model unreachable) — refine before approval.'));
    }
    console.log(chalk.dim(`  PRD: ${prdResult.metadata.featureCount} feature(s), ${prdResult.prdPath ?? '(not written)'}`));
    gateBanner(prdResult.gate.name, prdResult.gate.detail);
  } else {
    fail('design requires either --idea "<text>" or --prd <path>.');
    return null;
  }

  const design = await withSpinner('Phase 1B — Architecture Engine', (log) =>
    runPhase1bArchitect(projectPath, prd, { stackFingerprint: scout.stackFingerprint, log })
  );
  printWarnings(design.warnings);
  console.log(
    chalk.dim(
      `  architecture: ${design.database.tables.length} table(s), ${design.api.routes.length} route(s); ` +
        `${design.architecturePath ?? '(not written)'}`
    )
  );
  if (design.usedFallback) {
    console.log(chalk.yellow(`  ${design.fallbackArtifacts.length} artifact(s) used a fallback skeleton — refine before approval.`));
  }
  gateBanner(design.gate.name, design.gate.detail);
  return design;
}

/**
 * Governance/spec files FORGE auto-injects into the build idea when present in the
 * target project. These carry decisions a fresh PRD should HONOR rather than
 * re-derive (the blueprint, the data schema, the API registry, the live build state).
 */
const AUTO_GOVERNANCE_FILES: readonly string[] = [
  'BLUEPRINT.md',
  'governance/BLUEPRINT.md',
  'DIALSTARS_BLUEPRINT.md',
  'SCHEMA.md',
  'governance/SCHEMA_REGISTRY.md',
  'API_REGISTRY.md',
  'STATE_OF_THE_BUILD.md',
];

/**
 * Collect any governance/spec documents present in the target project — the
 * {@link AUTO_GOVERNANCE_FILES} at the project root plus every `.md` file under
 * `reports/` — so the build can prepend them to the raw idea. Returns the
 * concatenated Markdown (each doc under a labelled marker) and the list of source
 * paths. Guarded: a missing/unreadable file (or no `reports/` dir) is skipped, never
 * fatal; an empty project yields `{ text: '', sources: [] }`.
 */
async function gatherGovernanceContext(
  projectPath: string
): Promise<{ text: string; sources: string[] }> {
  const sources: string[] = [];
  const sections: string[] = [];

  const tryRead = async (relPath: string): Promise<void> => {
    try {
      const content = await readFile(join(projectPath, relPath), 'utf8');
      if (content.trim() === '') return;
      sources.push(relPath);
      sections.push(`<!-- FORGE auto-context: ${relPath} -->\n${content.trim()}`);
    } catch {
      // missing/unreadable — skip silently (best-effort).
    }
  };

  for (const name of AUTO_GOVERNANCE_FILES) await tryRead(name);

  // Every .md file in reports/ (e.g. an autopsy report, an audit, a design note).
  try {
    const entries = await readdir(join(projectPath, 'reports'), { withFileTypes: true });
    const mdFiles = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name)
      .sort();
    for (const name of mdFiles) await tryRead(join('reports', name));
  } catch {
    // no reports/ directory — skip.
  }

  return { text: sections.join('\n\n'), sources };
}

/**
 * Heuristic markdown parser for FORGE governance docs.
 *
 * When --skip-design is used on a project that has already completed Phase 1B,
 * the Queue Generator needs real structured data (tables, routes, pages, etc.)
 * to produce a full build queue.  This function reads ARCHITECTURE.md (the
 * richest source, written by Phase 1B) and extracts that data without making
 * any model calls — pure regex parsing of FORGE's own deterministic output
 * format.  Falls back to empty arrays on any read/parse failure so the
 * --skip-design path never crashes when the file is absent or in an unexpected
 * format.
 */
async function parseGovernanceDocs(projectPath: string): Promise<{
  tables: Array<{ name: string; schema: string; purpose: string; columns: []; primaryKey: string[]; foreignKeys: []; rlsEnabled: boolean; tenantScoped: boolean; immutable: boolean }>;
  indexes: Array<{ name: string; table: string; columns: string[]; unique: boolean; method: string | null; where: null }>;
  rlsPolicies: Array<{ name: string; table: string; command: string; roles: string[]; using: null; check: null }>;
  seeds: Array<{ table: string; description: string; rowCount: number | null }>;
  migrations: Array<{ filename: string; description: string }>;
  routes: Array<{ path: string; method: string; purpose: string; authRequired: boolean; roles: string[]; requestSchema: string; responseSchema: string; dbReads: string[]; dbWrites: []; errors: []; immutable: boolean }>;
  conventions: string[];
  pages: Array<{ name: string; path: string; purpose: string; components: string[]; apiCalls: string[]; authRequired: boolean; roles: []; immutable: boolean }>;
  components: Array<{ name: string; type: string; description: string }>;
  layouts: Array<{ name: string; description: string; appliesTo: string[] }>;
  authRoles: Array<{ name: string; description: string; permissions: [] }>;
  authFlows: [];
}> {
  const empty = {
    tables: [] as [], indexes: [] as [], rlsPolicies: [] as [], seeds: [] as [],
    migrations: [] as [], routes: [] as [], conventions: [] as string[],
    pages: [] as [], components: [] as [], layouts: [] as [],
    authRoles: [] as [], authFlows: [] as [],
  };
  try {
    const { existsSync, readFileSync } = await import('node:fs');
    const archPath = join(projectPath, 'ARCHITECTURE.md');
    if (!existsSync(archPath)) return empty as never;
    const text = readFileSync(archPath, 'utf8');

    // Return the text of the first h1 section whose title matches `keyword`.
    function h1Section(keyword: string): string {
      const re = new RegExp(`^#[^#][^\\n]*${keyword}[^\\n]*$`, 'im');
      const start = text.search(re);
      if (start === -1) return '';
      const next = text.indexOf('\n# ', start + 2);
      return text.slice(start, next === -1 ? text.length : next + 1);
    }

    // Return the slice of `section` that starts at the h2 containing `keyword`.
    function h2Slice(section: string, keyword: string): string {
      const lower = section.toLowerCase();
      const kIdx = lower.indexOf(keyword.toLowerCase());
      if (kIdx === -1) return '';
      const h2Start = section.lastIndexOf('\n##', kIdx);
      const from = h2Start === -1 ? kIdx : h2Start + 1;
      const next = section.indexOf('\n## ', from + 3);
      return section.slice(from, next === -1 ? section.length : next);
    }

    // ---- Database -----------------------------------------------------------
    const dbSec = h1Section('Database');

    const tables: Array<{ name: string; schema: string; purpose: string; columns: []; primaryKey: string[]; foreignKeys: []; rlsEnabled: boolean; tenantScoped: boolean; immutable: boolean }> = [];
    {
      const re = /^###\s+`public\.(\w+)`/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(dbSec)) !== null) {
        const name = m[1]!;
        const sStart = m.index;
        const nxt = dbSec.indexOf('\n###', sStart + 1);
        const sec = dbSec.slice(sStart, nxt === -1 ? dbSec.length : nxt);
        tables.push({
          name, schema: 'public', purpose: '', columns: [], primaryKey: ['id'], foreignKeys: [],
          rlsEnabled: /RLS Enabled[^\n]*Yes/i.test(sec),
          tenantScoped: /Tenant Scoped[^\n]*Yes/i.test(sec),
          immutable: false,
        });
      }
    }

    const indexes: Array<{ name: string; table: string; columns: string[]; unique: boolean; method: string | null; where: null }> = [];
    {
      const sec = h2Slice(dbSec, 'indexes');
      const re = /^\|\s+`([^`]+)`\s+\|\s+`([^`]+)`\s+\|\s+`([^`]+)`\s+\|\s+(Yes|No)\s+\|\s+(\w+)/gmi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sec)) !== null) {
        indexes.push({ name: m[1]!, table: m[2]!, columns: [m[3]!], unique: m[4]!.toLowerCase() === 'yes', method: m[5]!.toLowerCase(), where: null });
      }
    }

    const rlsPolicies: Array<{ name: string; table: string; command: string; roles: string[]; using: null; check: null }> = [];
    {
      const sec = h2Slice(dbSec, 'row-level security');
      const re = /^\|\s+`([^`]+)`\s+\|\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+\|/gmi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sec)) !== null) {
        rlsPolicies.push({ name: m[1]!, table: '', command: m[2]!.toLowerCase(), roles: ['authenticated'], using: null, check: null });
      }
    }

    const seeds: Array<{ table: string; description: string; rowCount: number | null }> = [];
    {
      const sec = h2Slice(dbSec, 'seed');
      const re = /^\|\s+`([^`]+)`\s+\|[^|]+\|\s+(\d+)/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sec)) !== null) {
        seeds.push({ table: m[1]!, description: '', rowCount: parseInt(m[2]!, 10) });
      }
    }

    const migrations: Array<{ filename: string; description: string }> = [];
    {
      const sec = h2Slice(dbSec, 'migration');
      const re = /^\|\s+`([^`|]+\.sql)`\s+\|\s+([^|\n]+)/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sec)) !== null) {
        migrations.push({ filename: m[1]!.trim(), description: m[2]!.trim() });
      }
    }

    // ---- API ----------------------------------------------------------------
    const apiSec = h1Section('API');

    const routes: Array<{ path: string; method: string; purpose: string; authRequired: boolean; roles: string[]; requestSchema: string; responseSchema: string; dbReads: string[]; dbWrites: []; errors: []; immutable: boolean }> = [];
    {
      const re = /^###\s+`(GET|POST|PUT|PATCH|DELETE|HEAD)\s+([^`]+)`/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(apiSec)) !== null) {
        const method = m[1]!;
        const path = m[2]!.trim();
        const sStart = m.index;
        const nxt = apiSec.indexOf('\n###', sStart + 1);
        const sec = apiSec.slice(sStart, nxt === -1 ? apiSec.length : nxt);
        const authRequired = /Auth Required[^\n|]*Yes/i.test(sec);
        const dbReadsM = sec.match(/DB Reads\s*\|\s*([^\n|]+)/i);
        const dbReads = dbReadsM
          ? dbReadsM[1]!.replace(/`/g, '').split(/[,\s]+/).map((s: string) => s.trim()).filter((t: string) => t && !/^(None|—|-)$/.test(t))
          : [];
        routes.push({ path, method, purpose: '', authRequired, roles: authRequired ? ['authenticated'] : [], requestSchema: '', responseSchema: '', dbReads, dbWrites: [], errors: [], immutable: false });
      }
    }

    const conventions: string[] = [];
    {
      const sec = h2Slice(apiSec, 'convention');
      const re = /^\d+\.\s+\*\*[^*]+\*\*[^\n]*/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sec)) !== null) conventions.push(m[0]!.replace(/^\d+\.\s+/, '').trim());
    }

    // ---- Frontend -----------------------------------------------------------
    const feSec = h1Section('Frontend');

    const pages: Array<{ name: string; path: string; purpose: string; components: string[]; apiCalls: string[]; authRequired: boolean; roles: []; immutable: boolean }> = [];
    {
      const pagesSec = h2Slice(feSec, 'pages');
      const re = /^###\s+`(\w+)`\s*(?:\(`([^`]*)`\))?/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(pagesSec)) !== null) {
        const name = m[1]!;
        const path = m[2] ?? `/${name.toLowerCase()}`;
        const sStart = m.index;
        const nxt = pagesSec.indexOf('\n###', sStart + 1);
        const sec = pagesSec.slice(sStart, nxt === -1 ? pagesSec.length : nxt);
        // Component names: `ComponentName`: …
        const compNames: string[] = [];
        const compRe = /`(\w+)`:/g;
        const compBlock = sec.match(/Components[^\n]*\n([\s\S]*?)(?=\n\s*\*\s+\*\*|\n##|$)/i)?.[0] ?? '';
        let cm: RegExpExecArray | null;
        while ((cm = compRe.exec(compBlock)) !== null) compNames.push(cm[1]!);
        // API call paths
        const apiCalls: string[] = [];
        const apiLine = sec.match(/API Calls[^\n]*:\s*([^\n]+)/i);
        if (apiLine && !/none|—|–|-\s*$/i.test(apiLine[1]!)) {
          const hits = apiLine[1]!.match(/`([^`]+)`/g) ?? [];
          apiCalls.push(...hits.map((h: string) => h.replace(/`/g, '')));
        }
        const authRequired = /Authentication Required[^\n]*true/i.test(sec);
        pages.push({ name, path, purpose: '', components: compNames, apiCalls, authRequired, roles: [], immutable: false });
      }
    }

    const components: Array<{ name: string; type: string; description: string }> = [];
    {
      const sec = h2Slice(feSec, '2. components');
      const re = /^###\s+`(\w+)`/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sec)) !== null) components.push({ name: m[1]!, type: 'component', description: '' });
    }

    const layouts: Array<{ name: string; description: string; appliesTo: string[] }> = [];
    {
      const sec = h2Slice(feSec, 'layout');
      const re = /^###\s+`(\w+)`/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sec)) !== null) layouts.push({ name: m[1]!, description: '', appliesTo: ['*'] });
    }

    // ---- Auth roles (derived from role CHECK constraints in the DB section) -
    const authRoles: Array<{ name: string; description: string; permissions: [] }> = [];
    {
      const roleValRe = /'(owner|admin|member|user|staff|viewer|superadmin|guest|moderator)'/g;
      const found = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = roleValRe.exec(dbSec)) !== null) found.add(m[1]!);
      for (const name of found) authRoles.push({ name, description: '', permissions: [] });
    }

    return { tables, indexes, rlsPolicies, seeds, migrations, routes, conventions, pages, components, layouts, authRoles, authFlows: [] };
  } catch {
    return empty as never;
  }
}

/** `forge build <path>` — the full autonomous pipeline (Phase 0 → 5). */
/**
 * Run Phase 3 once, or — when `autoResume` is set — drive it through
 * `runWithAutoResume` (`src/engine/auto-resume.ts`): compute `--start-at` from Build Memory /
 * state files, run, and re-fire after a claude-runner timeout/exit until the build completes,
 * a genuine Sentinel halt stops it, or `maxResumes` cycles are spent. `baseOptions` must NOT
 * set `startAt` when `autoResume` is on — auto-resume always computes it fresh, per cycle
 * (Session 3 — Autonomy: "on startup with --auto-resume … determine the last COMPLETED prompt
 * index"); a manually-supplied `--start-at` is honored only for the single non-auto-resume path.
 */
async function runPhase3MaybeAutoResume(
  baseOptions: Omit<Phase3Options, 'startAt'>,
  manualStartAt: number | undefined,
  autoResume: boolean,
  resumeWaitMinutes: number,
  maxResumes: number
): Promise<Phase3Result> {
  if (!autoResume) {
    return runPhase3Executor(manualStartAt !== undefined ? { ...baseOptions, startAt: manualStartAt } : baseOptions);
  }
  const { runWithAutoResume } = await import('../engine/auto-resume.js');
  const outcome = await runWithAutoResume({
    projectPath: baseOptions.projectPath,
    projectName: baseOptions.projectName ?? basename(baseOptions.projectPath),
    runPhase3: (startAt) => runPhase3Executor({ ...baseOptions, startAt }),
    resumeWaitMinutes,
    maxResumes,
    log: baseOptions.log ?? (() => {}),
  });
  if (outcome.cycles > 0) {
    baseOptions.log?.(
      `auto-resume: ${outcome.cycles} resume cycle(s) — start indices: ${outcome.startAtHistory.join(', ')}`
    );
  }
  return outcome.finalResult;
}

async function cmdBuild(
  pathArg: string,
  opts: {
    idea?: string;
    prd?: string;
    autonomousRecovery?: boolean;
    dryRun?: boolean;
    skipSecurityGate?: boolean;
    skipDesign?: boolean;
    useExistingQueue?: boolean;
    startAt?: string;
    autoResume?: boolean;
    resumeWaitMinutes?: string;
    maxResumes?: string;
  }
): Promise<void> {
  const autoResume = opts.autoResume ?? false;
  const resumeWaitMinutes = Number.parseInt(opts.resumeWaitMinutes ?? '5', 10);
  const maxResumes = Number.parseInt(opts.maxResumes ?? '20', 10);
  // --start-at: parse and validate early so bad input exits before Phase 0.
  let startAt: number | undefined;
  if (opts.startAt !== undefined) {
    startAt = Number.parseInt(opts.startAt, 10);
    if (!Number.isInteger(startAt) || startAt < 1) {
      fail('--start-at must be a positive integer >= 1 (the 1-based prompt index to start from).');
      return;
    }
    console.log(chalk.cyan(`  --start-at ${startAt}: prompts 1–${startAt - 1} will be skipped.`));
  }

  const projectPath = resolveProjectPath(pathArg);
  const projectName = basename(projectPath) || 'project';
  console.log(chalk.bold(`\nBuilding ${projectName} at ${projectPath}`));
  if (opts.dryRun) console.log(chalk.cyan('  DRY RUN — no claude/git/Sentinel execution; plan + cost only.'));

  // --use-existing-queue: skip Phase 1 (design) and Phase 2 (governance + queue generation)
  // entirely, and run Phase 3 directly against the queue.yaml already present in the target
  // project. Checked before any design/governance work so a missing queue fails fast.
  if (opts.useExistingQueue) {
    const queuePath = join(projectPath, 'queue.yaml');
    const { existsSync } = await import('node:fs');
    if (!existsSync(queuePath)) {
      fail(
        `--use-existing-queue requires an existing queue.yaml at ${queuePath} — ` +
          'run a normal build first (without --use-existing-queue) to generate one.'
      );
      return;
    }
    console.log(
      chalk.yellow('  --use-existing-queue: skipping Phase 1 (design) and Phase 2 (governance + queue generation).')
    );
    console.log(chalk.dim(`  queue: ${queuePath}`));

    const scout = await runScout(projectPath, { autoInstall: false, autoFix: false, writeToolchainFile: false });
    const exec = await withSpinner('Phase 3 — Build Executor', (log) =>
      runPhase3MaybeAutoResume(
        {
          projectPath,
          projectName,
          queuePath,
          stackFingerprint: scout.stackFingerprint,
          toolchainManifest: scout.toolchainManifest as unknown as JsonObject,
          autonomousRecoveryMode: opts.autonomousRecovery ?? false,
          dryRun: opts.dryRun ?? false,
          log,
        },
        startAt,
        autoResume,
        resumeWaitMinutes,
        maxResumes
      )
    );
    reportExecution(exec);

    if (opts.dryRun) {
      console.log(chalk.cyan('\nDry run complete — nothing was executed.'));
      return;
    }

    if (exec.status === 'halted' || exec.status === 'failed') {
      fail(`Build ${exec.status}${exec.haltReason ? ` — ${exec.haltReason}` : ''}.`);
      return;
    }

    if (exec.buildRunId) {
      const learn = await withSpinner('Phase 5 — Recursive Learner', (log) =>
        runPhase5Learner(exec.buildRunId as string, { log })
      );
      printWarnings(learn.warnings);
      console.log(chalk.green('\n✔ Build pipeline complete.'));
    } else {
      console.log(chalk.yellow('\nBuild finished, but Build Memory was unavailable — Phase 5 learning skipped (stateless mode).'));
    }
    return;
  }

  // Auto-governance: when building from a raw --idea, prepend any spec/governance docs
  // found in the target project (BLUEPRINT/SCHEMA/API_REGISTRY/state + reports/*.md) so
  // Phase 1A's PRD honors existing decisions rather than re-deriving them. (When --prd is
  // supplied Phase 1A is skipped entirely, so there is nothing to augment.)
  if (opts.idea) {
    const gov = await gatherGovernanceContext(projectPath);
    if (gov.sources.length > 0) {
      console.log(
        chalk.dim(`  auto-context: prepending ${gov.sources.length} governance doc(s) — ${gov.sources.join(', ')}`)
      );
      opts = { ...opts, idea: `${gov.text}\n\n---\n\n# Product idea\n\n${opts.idea}` };
    }
  }

  if (opts.skipDesign) {
    const { existsSync, readFileSync } = await import('node:fs');
    const bp = join(projectPath, 'governance', 'BLUEPRINT.md');
    const bpLegacy = join(projectPath, 'DIALSTARS_BLUEPRINT.md');
    const schemaReg = join(projectPath, 'governance', 'SCHEMA_REGISTRY.md');
    const sp = join(projectPath, 'SCHEMA.md');
    const doc = existsSync(bp) ? bp : existsSync(schemaReg) ? schemaReg : existsSync(bpLegacy) ? bpLegacy : existsSync(sp) ? sp : null;
    if (!doc) { fail('--skip-design requires governance/BLUEPRINT.md, governance/SCHEMA_REGISTRY.md, DIALSTARS_BLUEPRINT.md, or SCHEMA.md'); return; }
    const prd = readFileSync(doc, 'utf8');
    const parsed = await parseGovernanceDocs(projectPath);
    const sr = await runScout(projectPath, { autoInstall: false, autoFix: false, writeToolchainFile: false });
    const fd = {
      projectName,
      database: { tables: parsed.tables, indexes: parsed.indexes, rlsPolicies: parsed.rlsPolicies, seeds: parsed.seeds, migrations: parsed.migrations, markdown: prd },
      api: { routes: parsed.routes, conventions: parsed.conventions, markdown: '' },
      frontend: { pages: parsed.pages, components: parsed.components, layouts: parsed.layouts, designTokens: { colors: {}, typography: {}, spacing: {}, radii: {}, shadows: {} }, responsiveStrategy: '', markdown: '' },
      interactionMaps: { maps: [], markdown: '' },
      auth: { flows: parsed.authFlows, roles: parsed.authRoles, middleware: '', multiTenancy: '', permissionsModel: '', markdown: '' },
      agents: { agents: [], orchestration: '', markdown: '' },
      infra: { environments: [], deployConfig: '', monitoring: '', performanceBudgets: [], markdown: '' },
      testing: { playwrightSpecs: [], apiTests: [], sixLawsPlan: [], markdown: '' },
      crossValidation: [], constrained: false, designSystemGenerated: false, designSystemPath: null, architecturePath: null, model: 'existing-docs', tokensInput: 0, tokensOutput: 0, usedFallback: false, fallbackArtifacts: [], warnings: [],
      gate: { name: 'Gate 2', status: 'awaiting_human_approval' as const, detail: 'existing docs' },
      generatedAt: new Date().toISOString(),
    };
    const gov = await withSpinner('Phase 2 - Governance', (log) => runPhase2Governance(projectPath, fd as unknown as ArchitectureDesign, { stackFingerprint: sr.stackFingerprint, log }));
    printWarnings(gov.warnings);
    const q = await withSpinner('Phase 2 - Queue', (log) => generateQueue(projectPath, fd as unknown as ArchitectureDesign, { projectName, log }));
    printWarnings(q.warnings);
    const exec = await withSpinner('Phase 3 - Build Executor', (log) =>
      runPhase3MaybeAutoResume(
        {
          projectPath,
          projectName,
          stackFingerprint: sr.stackFingerprint,
          toolchainManifest: sr.toolchainManifest as unknown as JsonObject,
          autonomousRecoveryMode: opts.autonomousRecovery ?? false,
          dryRun: opts.dryRun ?? false,
          log,
        },
        startAt,
        autoResume,
        resumeWaitMinutes,
        maxResumes
      )
    );
    reportExecution(exec);
    return;
  }

  // Phase 0 + 1 (design). Reuses cmdDesign so the gates + reporting are identical.
  const design = await cmdDesign(pathArg, opts);
  if (!design) return; // cmdDesign already reported the failure.

  // Re-derive the Phase 0 fingerprint for downstream phases (cheap; no installs).
  const scout = await runScout(projectPath, { autoInstall: false, autoFix: false, writeToolchainFile: false });

  // Phase 2 — Governance documents + queue.yaml.
  const governance = await withSpinner('Phase 2 — Governance Generator', (log) =>
    runPhase2Governance(projectPath, design, { stackFingerprint: scout.stackFingerprint, log })
  );
  printWarnings(governance.warnings);
  const queue = await withSpinner('Phase 2 — Queue Generator', (log) =>
    generateQueue(projectPath, design, { projectName, log })
  );
  printWarnings(queue.warnings);
  console.log(chalk.dim(`  queue: ${queue.stats.totalPrompts} prompt(s) → ${queue.queuePath ?? '(not written)'}`));
  gateBanner(governance.gate.name, governance.gate.detail);

  // Phase 3 — Build Executor (runs Phase 4 Sentinel per-prompt internally).
  const exec = await withSpinner('Phase 3 — Build Executor', (log) =>
    runPhase3MaybeAutoResume(
      {
        projectPath,
        projectName,
        stackFingerprint: scout.stackFingerprint,
        toolchainManifest: scout.toolchainManifest as unknown as JsonObject,
        autonomousRecoveryMode: opts.autonomousRecovery ?? false,
        dryRun: opts.dryRun ?? false,
        log,
      },
      startAt,
      autoResume,
      resumeWaitMinutes,
      maxResumes
    )
  );
  reportExecution(exec);

  if (opts.dryRun) {
    console.log(chalk.cyan('\nDry run complete — nothing was executed.'));
    return;
  }

  if (exec.status === 'halted' || exec.status === 'failed') {
    fail(`Build ${exec.status}${exec.haltReason ? ` — ${exec.haltReason}` : ''}.`);
    return;
  }

  // Phase 5 — Recursive Learner (best-effort; never blocks).
  if (exec.buildRunId) {
    const learn = await withSpinner('Phase 5 — Recursive Learner', (log) =>
      runPhase5Learner(exec.buildRunId as string, { log })
    );
    printWarnings(learn.warnings);
    console.log(chalk.green('\n✔ Build pipeline complete.'));
  } else {
    console.log(chalk.yellow('\nBuild finished, but Build Memory was unavailable — Phase 5 learning skipped (stateless mode).'));
  }
}

/** Print the Phase 3 result summary. */
function reportExecution(exec: Phase3Result): void {
  console.log(
    `  build ${chalk.bold(exec.buildRunId ?? '(stateless)')} — status ${statusChip(exec.status)}: ` +
      `${chalk.green(String(exec.completedPrompts) + ' done')}, ` +
      `${chalk.red(String(exec.failedPrompts) + ' failed')}, ` +
      `${chalk.dim(String(exec.skippedPrompts) + ' skipped')}`
  );
  if (exec.haltedAt) {
    console.log(chalk.red(`  halted at prompt ${exec.haltedAt.index} (${exec.haltedAt.id})`));
  }
  if (exec.simulation) {
    const sim = exec.simulation;
    console.log(chalk.cyan(`  simulation: ${sim.totalPrompts} prompt(s), ~${sim.assembledTokenEstimate} tokens`));
    if (sim.predictedCostUsd) {
      console.log(chalk.cyan(`    predicted cost ≈ $${sim.predictedCostUsd.estimate} (${sim.predictedCostUsd.low}–${sim.predictedCostUsd.high})`));
    }
    if (sim.predictedTimeMs) console.log(chalk.cyan(`    predicted time ≈ ${sim.predictedTimeMs.human}`));
    if (sim.predictedErrors.length > 0) {
      console.log(chalk.yellow(`    ${sim.predictedErrors.length} prompt(s) predicted to need a rewrite.`));
    }
  }
  printWarnings(exec.warnings);
}

/** `forge resume <build-id>` — resume a halted build from its last checkpoint. */
async function cmdResume(buildId: string): Promise<void> {
  const build = await BuildMemory.builds.getBuild(buildId);
  if (!build) {
    fail(`No build ${buildId} found in Build Memory (or Build Memory is unreachable).`);
    return;
  }
  const lastGood = build.completed_prompts; // checkpoint index of the last passed prompt
  if (lastGood < 1) {
    fail(`Build ${buildId} has no completed prompts to resume from. Re-run \`forge build\` instead.`);
    return;
  }
  const fromPromptIndex = lastGood + 1;
  const checkpointTag = checkpointTagFor(buildId, lastGood);
  console.log(
    chalk.bold(`\nResuming build ${buildId} (${build.project_name}) from prompt ${fromPromptIndex} ` +
      `(checkpoint ${checkpointTag})`)
  );
  await runReplay(build, { originalBuildRunId: buildId, fromCheckpointTag: checkpointTag, fromPromptIndex });
}

/** `forge replay <build-id> --from <index>` — replay from an explicit checkpoint (F12). */
async function cmdReplay(buildId: string, opts: { from?: string }): Promise<void> {
  const build = await BuildMemory.builds.getBuild(buildId);
  if (!build) {
    fail(`No build ${buildId} found in Build Memory (or Build Memory is unreachable).`);
    return;
  }
  const fromPromptIndex = Number.parseInt(opts.from ?? '1', 10);
  if (!Number.isInteger(fromPromptIndex) || fromPromptIndex < 1) {
    fail('--from must be a positive integer (the 1-based prompt index to replay from).');
    return;
  }
  const checkpointTag = checkpointTagFor(buildId, fromPromptIndex - 1);
  console.log(
    chalk.bold(`\nReplaying build ${buildId} (${build.project_name}) from prompt ${fromPromptIndex} ` +
      `(checkpoint ${checkpointTag})`)
  );
  if (fromPromptIndex === 1) {
    console.log(chalk.dim('  (no prior checkpoint at index 0 — replay falls back to current HEAD if the tag is absent.)'));
  }
  await runReplay(build, { originalBuildRunId: buildId, fromCheckpointTag: checkpointTag, fromPromptIndex });
}

/** Shared replay execution for resume/replay (Phase 3 in replay mode). */
async function runReplay(
  build: BuildRun,
  replay: { originalBuildRunId: string; fromCheckpointTag: string; fromPromptIndex: number }
): Promise<void> {
  const projectPath = build.project_path;
  const exec = await withSpinner('Phase 3 — Build Executor (replay)', (log) =>
    runPhase3Executor({
      projectPath,
      projectName: build.project_name,
      stackFingerprint: asStackFingerprint(build.stack_fingerprint),
      autonomousRecoveryMode: build.autonomous_recovery_mode,
      replay,
      log,
    })
  );
  reportExecution(exec);
  if (exec.status === 'halted' || exec.status === 'failed') {
    fail(`Replay ${exec.status}${exec.haltReason ? ` — ${exec.haltReason}` : ''}.`);
    return;
  }
  if (exec.buildRunId) {
    const learn = await withSpinner('Phase 5 — Recursive Learner', (log) =>
      runPhase5Learner(exec.buildRunId as string, { log })
    );
    printWarnings(learn.warnings);
  }
  console.log(chalk.green('\n✔ Replay complete.'));
}

/** `forge status [build-id]` — build status from Build Memory. */
async function cmdStatus(buildId: string | undefined, config: EnvConfig): Promise<void> {
  if (!config.buildMemoryEnabled) {
    console.log(chalk.yellow('\nBuild Memory is disabled (stateless mode) — no build history is available.'));
    console.log(chalk.dim('Run `forge health` to diagnose why ~/.forge/forge_memory.db is unreachable.'));
    return;
  }

  let build: BuildRun | null;
  if (buildId) {
    build = await BuildMemory.builds.getBuild(buildId);
  } else {
    const recent = await BuildMemory.builds.listBuilds(1);
    build = recent && recent.length > 0 ? (recent[0] ?? null) : null;
  }

  if (!build) {
    console.log(chalk.yellow(buildId ? `\nNo build ${buildId} found.` : '\nNo builds recorded yet.'));
    return;
  }

  console.log(chalk.bold(`\nBuild ${build.id} — ${build.project_name}`));
  console.log(`  status:    ${statusChip(build.status)}`);
  console.log(chalk.dim(`  path:      ${build.project_path}`));
  console.log(chalk.dim(`  machine:   ${build.machine_id}`));
  console.log(
    `  prompts:   ${chalk.green(String(build.completed_prompts) + ' done')} / ` +
      `${build.total_prompts} total (${chalk.red(String(build.failed_prompts) + ' failed')})`
  );
  console.log(chalk.dim(`  tokens:    ${build.total_tokens}    cost: $${build.total_cost_usd}`));
  console.log(chalk.dim(`  started:   ${build.started_at ?? '—'}    completed: ${build.completed_at ?? '—'}`));
  if (build.sentinel_interventions > 0) {
    console.log(chalk.yellow(`  sentinel interventions: ${build.sentinel_interventions}`));
  }

  const prompts = await BuildMemory.prompts.getPromptsByBuild(build.id);
  if (prompts && prompts.length > 0) {
    console.log(chalk.bold('\n  Prompts:'));
    for (const p of prompts) printPromptLine(p);
  }
}

/** One prompt_execution line in the status table. */
function printPromptLine(p: PromptExecution): void {
  const idx = String(p.prompt_index).padStart(3, ' ');
  const flags = [
    p.was_rewritten ? chalk.magenta('rewritten') : '',
    p.sentinel_passed === false ? chalk.red('sentinel✖') : '',
  ]
    .filter((x) => x !== '')
    .join(' ');
  console.log(`    ${idx}. ${statusChip(p.status).padEnd(20, ' ')} ${p.prompt_name} ${flags}`);
}

/** `forge history [--project name]` — list past builds. */
async function cmdHistory(opts: { project?: string }, config: EnvConfig): Promise<void> {
  if (!config.buildMemoryEnabled) {
    console.log(chalk.yellow('\nBuild Memory is disabled (stateless mode) — no history available.'));
    return;
  }
  const builds = opts.project
    ? await BuildMemory.builds.getBuildsByProject(opts.project)
    : await BuildMemory.builds.listBuilds(50);

  if (!builds || builds.length === 0) {
    console.log(chalk.yellow(opts.project ? `\nNo builds for project "${opts.project}".` : '\nNo builds recorded yet.'));
    return;
  }

  console.log(chalk.bold(`\n${builds.length} build(s)${opts.project ? ` for "${opts.project}"` : ''}:`));
  for (const b of builds) {
    const when = b.created_at.slice(0, 19).replace('T', ' ');
    console.log(
      `  ${chalk.dim(when)}  ${statusChip(b.status).padEnd(20, ' ')} ` +
        `${chalk.bold(b.project_name.padEnd(18, ' '))} ` +
        `${b.completed_prompts}/${b.total_prompts} prompts  ${chalk.dim(b.id)}`
    );
  }
}

/** `forge patterns` — known error patterns + success rates. */
async function cmdPatterns(config: EnvConfig): Promise<void> {
  if (!config.buildMemoryEnabled) {
    console.log(chalk.yellow('\nBuild Memory is disabled (stateless mode) — no error patterns available.'));
    return;
  }
  const patterns = await BuildMemory.errors.listAllPatterns();

  if (!patterns || patterns.length === 0) {
    console.log(chalk.yellow('\nNo error patterns recorded yet.'));
    return;
  }

  console.log(chalk.bold(`\n${patterns.length} known error pattern(s):`));
  for (const p of patterns) {
    const rate = `${Math.round(p.success_rate * 100)}%`;
    const auto = p.auto_resolve_eligible ? chalk.green(' [auto-resolve]') : '';
    console.log(
      `  ${chalk.bold(p.error_signature)} ` +
        `${chalk.dim('(' + p.error_category + ')')}  ` +
        `×${p.occurrence_count}  success ${chalk.cyan(rate)}${auto}`
    );
    if (p.prevention_rule) console.log(chalk.dim(`      prevention: ${p.prevention_rule}`));
  }
}

/** `forge agents` — self-created agents + status. */
async function cmdAgents(config: EnvConfig): Promise<void> {
  if (!config.buildMemoryEnabled) {
    console.log(chalk.yellow('\nBuild Memory is disabled (stateless mode) — no agents available.'));
    return;
  }
  const agents = await BuildMemory.agents.listAgents();
  if (!agents || agents.length === 0) {
    console.log(chalk.yellow('\nNo self-created agents yet. FORGE proposes them after a task pattern recurs across 3+ builds (Contract 17).'));
    return;
  }

  console.log(chalk.bold(`\n${agents.length} self-created agent(s):`));
  for (const a of agents) printAgentLine(a);
}

/** One self_created_agents line. */
function printAgentLine(a: SelfCreatedAgent): void {
  const status = a.status === 'active' ? chalk.green(a.status) : a.status === 'proposed' ? chalk.yellow(a.status) : chalk.dim(a.status);
  console.log(`  ${chalk.bold(a.name)}  [${status}]  used in ${a.builds_used_in} build(s)`);
  console.log(chalk.dim(`      ${a.purpose}`));
}

/** An empty {@link ContextInjection} — resurrection prompts carry their context inline. */
function emptyInjection(): { schemaSections: string[]; behavioralSections: string[]; interactionMaps: string[] } {
  return { schemaSections: [], behavioralSections: [], interactionMaps: [] };
}

/**
 * Build a Phase 3 build queue DIRECTLY from an autopsy report. The resurrect path
 * SKIPS Phase 1A (PRD) and 1B (Architecture) — it reconstructs straight from the
 * report's preserve/redesign brief into a short, dependency-ordered queue:
 *   1. (optional) a schema prompt that PRESERVES the salvageable tables,
 *   2. one feature prompt per missing feature the autopsy found (capped),
 *   3. a final integration prompt that repairs broken integrations + wires it together.
 * Each prompt carries the full resurrection brief inline (no governance package exists,
 * since Phase 2 is skipped too), so `governance_refs` is empty.
 */
function buildResurrectionQueue(report: AutopsyReport): QueueEntry[] {
  const entries: QueueEntry[] = [];
  const recon = report.reconstructionInputs;
  let prevId: string | null = null;

  const tables = recon.preserve.schemaTables;
  if (tables.length > 0) {
    const id = 'resurrect-000-schema';
    entries.push({
      id,
      name: 'Preserve salvaged schema',
      prompt_type: 'schema',
      dependencies: [],
      governance_refs: [],
      estimated_tokens: Math.max(2000, tables.length * 300 + 2000),
      context_injection: emptyInjection(),
      description:
        'RESURRECTION — preserve the salvageable data model from the failed project.\n' +
        `Recreate/confirm these tables exactly (do NOT redesign them): ${tables.join(', ')}.\n\n` +
        recon.idea,
    });
    prevId = id;
  }

  const missing = recon.redesign.missingFeatures.slice(0, 12);
  missing.forEach((feature, i) => {
    const id = `resurrect-${String(i + 1).padStart(3, '0')}-feature`;
    entries.push({
      id,
      name: `Rebuild feature: ${feature}`.slice(0, 80),
      prompt_type: 'feature',
      dependencies: prevId ? [prevId] : [],
      governance_refs: [],
      estimated_tokens: 6000,
      context_injection: emptyInjection(),
      description:
        `RESURRECTION — implement the missing feature "${feature}" identified by the autopsy.\n` +
        `Preserve where relevant — routes: ${recon.preserve.routes.join(', ') || '—'}; ` +
        `components: ${recon.preserve.components.slice(0, 40).join(', ') || '—'}.\n\n` +
        recon.idea,
    });
    prevId = id;
  });

  const finalId = `resurrect-${String(missing.length + 1).padStart(3, '0')}-integrate`;
  entries.push({
    id: finalId,
    name: 'Integrate + repair broken integrations',
    prompt_type: 'feature',
    dependencies: prevId ? [prevId] : [],
    governance_refs: [],
    estimated_tokens: 6000,
    context_injection: emptyInjection(),
    description:
      'RESURRECTION — final integration pass.\n' +
      `Repair these broken integrations: ${recon.redesign.brokenIntegrations.join('; ') || '(none detected)'}.\n` +
      'Ensure the preserved schema, routes, and components work end-to-end.\n\n' +
      recon.idea,
  });

  return entries;
}

/** Find the most recent `AUTOPSY_*.md` in a project's `reports/` dir, or null. */
async function findLatestAutopsyReport(reportsDir: string): Promise<string | null> {
  try {
    const entries = await readdir(reportsDir, { withFileTypes: true });
    const reports = entries
      .filter((e) => e.isFile() && /^AUTOPSY_.*\.md$/i.test(e.name))
      .map((e) => e.name)
      .sort();
    const latest = reports[reports.length - 1];
    return latest ? join(reportsDir, latest) : null;
  } catch {
    return null;
  }
}

/**
 * `forge resurrect <path>` — autopsy a failed project, then rebuild it (F10).
 *
 * Unlike `forge build`, resurrection SKIPS Phase 1A/1B entirely and generates the
 * Phase 3 build queue directly from the autopsy report found in the project's
 * `reports/` directory, then executes it.
 */
async function cmdResurrect(pathArg: string, opts: { autonomousRecovery?: boolean }): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  const projectName = basename(projectPath) || 'project';
  console.log(chalk.bold(`\nResurrecting ${projectName} at ${projectPath}`));

  // Phase 0 — environment gate. Resurrection skips the AgentShield security scan
  // (the dead project's leftover config is not the resurrection's concern).
  const scout = await runScout(projectPath, { skipSecurityGate: true });
  reportScout(scout);
  if (!scout.passed) {
    fail('Phase 0 did not pass — resolve the blockers above before resurrecting.');
    return;
  }

  // Autopsy: produce the forensic report and persist it under reports/.
  const report = await withSpinner('Project Autopsy', (log) =>
    runProjectAutopsy(projectPath, { stackFingerprint: scout.stackFingerprint, log })
  );

  const s = report.salvageAssessment;
  console.log(
    `  salvageable: ${report.salvageable ? chalk.green('yes') : chalk.red('no')}  ` +
      `(${chalk.green(String(s.counts.keep) + ' keep')}, ` +
      `${chalk.yellow(String(s.counts.refactor) + ' refactor')}, ` +
      `${chalk.red(String(s.counts.discard) + ' discard')}; ratio ${(s.salvageRatio * 100).toFixed(0)}%)`
  );
  console.log(chalk.dim(`  intent: ${report.intent.inferredPurpose}`));
  console.log(chalk.dim(`  diagnosis: ${report.diagnosis.summary}`));

  // Persist the full Markdown report so the operator can act on it (and so it lands in reports/).
  const reportsDir = join(projectPath, 'reports');
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const reportPath = join(reportsDir, `AUTOPSY_${stamp}.md`);
  try {
    await mkdir(reportsDir, { recursive: true });
    await writeFile(reportPath, renderAutopsyReportMarkdown(report), 'utf8');
    console.log(chalk.dim(`  full report: ${reportPath}`));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(chalk.yellow(`  (could not write the autopsy report: ${detail})`));
  }
  printWarnings(report.warnings);

  // Confirm an autopsy report is present in reports/ — the source of the resurrection.
  const foundReport = await findLatestAutopsyReport(reportsDir);
  if (foundReport) console.log(chalk.dim(`  resurrecting from autopsy report: ${foundReport}`));

  // Skip Phase 1A (PRD) and 1B (Architecture): build the Phase 3 queue DIRECTLY from
  // the autopsy report's preserve/redesign brief, then execute it.
  console.log(chalk.yellow('  skipping Phase 1A/1B — building the queue directly from the autopsy report.'));
  const entries = buildResurrectionQueue(report);
  const queuePath = join(projectPath, 'resurrect-queue.yaml');
  try {
    await writeFile(queuePath, dumpYaml(entries, { lineWidth: 120 }), 'utf8');
    console.log(chalk.dim(`  resurrection queue: ${entries.length} prompt(s) → ${queuePath}`));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Could not write the resurrection queue: ${detail}`);
    return;
  }

  // Phase 3 — Build Executor straight from the resurrection queue.
  const exec = await withSpinner('Phase 3 — Build Executor (resurrect)', (log) =>
    runPhase3Executor({
      projectPath,
      projectName,
      stackFingerprint: scout.stackFingerprint,
      toolchainManifest: scout.toolchainManifest as unknown as JsonObject,
      queuePath,
      autonomousRecoveryMode: opts.autonomousRecovery ?? false,
      log,
    })
  );
  reportExecution(exec);

  if (exec.status === 'halted' || exec.status === 'failed') {
    fail(`Resurrection ${exec.status}${exec.haltReason ? ` — ${exec.haltReason}` : ''}.`);
    return;
  }

  // Phase 5 — Recursive Learner (best-effort; never blocks).
  if (exec.buildRunId) {
    const learn = await withSpinner('Phase 5 — Recursive Learner', (log) =>
      runPhase5Learner(exec.buildRunId as string, { log })
    );
    printWarnings(learn.warnings);
  }
  console.log(chalk.green('\n✔ Resurrection complete.'));
}

/** `forge estimate <path> --idea` — cost/time estimate without building (F17). */
async function cmdEstimate(pathArg: string, opts: { idea?: string; prd?: string }): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  if (!opts.idea && !opts.prd) {
    fail('estimate requires --idea "<text>" or --prd <path>.');
    return;
  }
  console.log(chalk.bold(`\nEstimating a build of ${basename(projectPath)}`));

  // Scout WITHOUT side effects (no installs / no TOOLCHAIN.md write) — we only need
  // the stack fingerprint to scope the prediction.
  const scout = await runScout(projectPath, { autoInstall: false, autoFix: false, writeToolchainFile: false });

  // A lightweight PRD pass derives the feature/table/agent scope (writes nothing).
  const idea = opts.prd ? await readFile(resolve(opts.prd), 'utf8') : opts.idea ?? '';
  const prd = await withSpinner('Phase 1A — PRD scope', (log) =>
    runPhase1aPrd(projectPath, idea, { stackFingerprint: scout.stackFingerprint, writePrdFile: false, log })
  );

  const featureCount = Math.max(prd.metadata.featureCount, 1);
  const features: FeatureSpec[] = Array.from({ length: featureCount }, (_, i) => ({ name: `feature-${i + 1}` }));

  const estimate = await withSpinner('Cost Estimator', (log) =>
    estimateBuildCost(
      { stackFingerprint: scout.stackFingerprint, features, tableCount: prd.metadata.tableEstimate, agentCount: prd.metadata.agentEstimate },
      { log }
    )
  );

  console.log(chalk.bold('\nEstimate:'));
  console.log(`  prompts:   ${estimate.totalPrompts}`);
  console.log(
    `  tokens:    ${estimate.tokens.estimate} ` +
      chalk.dim(`(${estimate.tokens.low}–${estimate.tokens.high}; in ${estimate.tokens.input} / out ${estimate.tokens.output})`)
  );
  console.log(`  cost:      ${chalk.cyan('$' + estimate.costUsd.estimate)} ` + chalk.dim(`($${estimate.costUsd.low}–$${estimate.costUsd.high})`));
  console.log(`  time:      ${chalk.cyan(estimate.executionTime.human)} ` + chalk.dim(`(sequential)`));
  console.log(`  failures:  ~${estimate.predictedFailures.estimate} prompt(s) predicted to need a retry`);
  console.log(chalk.dim(`  confidence: ${estimate.confidence.overall} (history coverage ${(estimate.confidence.historicalCoverage * 100).toFixed(0)}%)`));
  printWarnings(estimate.warnings);
}

// ---------------------------------------------------------------------------
// `forge schedule` — list / add / remove / trigger scheduled tasks
// ---------------------------------------------------------------------------

/** Colorize a last-result label. */
function resultLabel(result: SchedulerDashboardRow['lastResult']): string {
  if (result === 'success') return chalk.green('success');
  if (result === 'failure') return chalk.red('failure');
  if (result === 'skipped') return chalk.yellow('skipped');
  return chalk.dim('never run');
}

/** `forge schedule list` — the dashboard data: every task with next/last run + last result. */
async function cmdScheduleList(opts: { json?: boolean }): Promise<void> {
  const dashboard = await getSchedulerDashboard();

  if (opts.json) {
    console.log(JSON.stringify(dashboard, null, 2));
    return;
  }

  if (dashboard.tasks.length === 0) {
    console.log(chalk.yellow('\nNo scheduled tasks. Add one with `forge schedule add <name> --type <type> --cron "<expr>"`.'));
    return;
  }

  console.log(
    chalk.bold(`\n${dashboard.total} scheduled task(s)`) +
      chalk.dim(`  (${dashboard.enabled} enabled, ${dashboard.failing} failing)`)
  );
  for (const t of dashboard.tasks) {
    const state = t.enabled ? chalk.green('enabled') : chalk.dim('disabled');
    console.log(`  ${chalk.bold(t.name)} ${chalk.dim('[' + t.taskType + ']')}  ${state}  ${chalk.dim(t.cronExpression)}`);
    console.log(
      chalk.dim(
        `      next ${t.nextRunAt ?? '—'}  ·  last ${t.lastRunAt ?? '—'} → `
      ) + resultLabel(t.lastResult) + chalk.dim(`  ·  runs ${t.runCount} / fails ${t.failureCount}`)
    );
    if (t.lastError) console.log(chalk.red(`      last error: ${t.lastError}`));
  }
}

/** Parse the optional `--metadata <json>` flag into a JsonObject. Returns null on bad JSON. */
function parseMetadata(raw: string | undefined): JsonObject | null {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as JsonObject;
  } catch {
    return null;
  }
}

/** `forge schedule add <name>` — register a recurring task and persist it in Build Memory. */
async function cmdScheduleAdd(
  name: string,
  opts: { type?: string; cron?: string; description?: string; disabled?: boolean; metadata?: string }
): Promise<void> {
  if (!opts.type || !SCHEDULED_TASK_TYPES.includes(opts.type as ScheduledTaskType)) {
    fail(`--type must be one of: ${SCHEDULED_TASK_TYPES.join(', ')}`);
    return;
  }
  if (!opts.cron) {
    fail('add requires --cron "<5-field cron expression>".');
    return;
  }
  const metadata = parseMetadata(opts.metadata);
  if (metadata === null) {
    fail('--metadata must be a JSON object.');
    return;
  }

  const scheduler = await createTaskScheduler();
  const task = await scheduler.addTask({
    name,
    taskType: opts.type as ScheduledTaskType,
    cronExpression: opts.cron,
    description: opts.description,
    enabled: !opts.disabled,
    metadata,
  });

  if (!task) {
    fail(`could not add '${name}' — invalid cron expression '${opts.cron}'.`);
    return;
  }
  console.log(chalk.green(`\n✓ scheduled '${task.name}' (${task.task_type}) on '${task.cron_expression}'`));
  console.log(chalk.dim(`  next run: ${task.next_run_at ?? '—'}${task.enabled ? '' : '  (disabled)'}`));
  if (!BuildMemory.getClient()) {
    console.log(chalk.yellow('  note: Build Memory is disabled — this schedule will NOT persist across restarts.'));
  }
}

/** `forge schedule remove <name>` — delete a task and its persisted schedule. */
async function cmdScheduleRemove(name: string): Promise<void> {
  const scheduler = await createTaskScheduler();
  const removed = await scheduler.removeTask(name);
  if (removed) console.log(chalk.green(`\n✓ removed scheduled task '${name}'`));
  else fail(`no scheduled task named '${name}'.`);
}

/** `forge schedule trigger <name>` — run a task once now and report its outcome. */
async function cmdScheduleTrigger(name: string): Promise<void> {
  const scheduler = await createTaskScheduler();
  const outcome = await scheduler.triggerTask(name);
  if (!outcome) {
    fail(`no scheduled task named '${name}'.`);
    return;
  }
  const label = resultLabel(outcome.result);
  console.log(`\nran '${name}' → ${label}${outcome.detail ? chalk.dim(` (${outcome.detail})`) : ''}`);
  if (outcome.result === 'failure') process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// `forge brand-inherit <baseline-project> <new-project>` — cross-project design tokens
// ---------------------------------------------------------------------------

/** Parse the optional `--tokens <json>` flag into a `Partial<DesignTokenSet>`. Null on bad JSON/shape. */
function parseTokenOverrides(raw: string | undefined): Partial<DesignTokenSet> | null {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Partial<DesignTokenSet>;
  } catch {
    return null;
  }
}

/**
 * `forge brand-inherit <baseline-project> <new-project> [--tokens <json>]` — derive a new
 * project's design tokens from a proven baseline brand, persist them, and print the resulting
 * palette summary (Session 2 — Design Intelligence, cross-project token inheritance).
 */
async function cmdBrandInherit(
  baselineProject: string,
  newProject: string,
  opts: { tokens?: string }
): Promise<void> {
  const overrides = parseTokenOverrides(opts.tokens);
  if (overrides === null) {
    fail('--tokens must be a JSON object, e.g. \'{"colors":{"primary":"#123456"}}\'.');
    return;
  }

  const derived = await deriveBrandFromBaseline(baselineProject, newProject, overrides);
  if (!derived.baselineFound) {
    console.log(
      chalk.yellow(`\nNo brand found for baseline project "${baselineProject}" — deriving from overrides only.`)
    );
  }

  const designTokens: JsonObject = {
    markdown: derived.baselineMarkdown,
    productType: derived.baselineProductType,
    generatedAt: nowIso(),
    inheritedFrom: baselineProject,
    tokens: derived.tokens as unknown as JsonObject,
  };

  const existing = await BuildMemory.brands.getBrandByProject(newProject);
  const saved = existing
    ? await BuildMemory.brands.updateBrand(newProject, { design_tokens: designTokens })
    : await BuildMemory.brands.createBrand({
        project_name: newProject,
        brand_name: newProject,
        design_tokens: designTokens,
      });

  if (!saved) {
    fail('Could not persist the derived brand to Build Memory (see memory warnings above).');
    return;
  }

  console.log(
    chalk.bold(
      `\nDerived brand "${newProject}" from "${baselineProject}"` +
        (derived.baselineFound ? '' : ' (baseline not found — overrides only)')
    )
  );

  const colorEntries = Object.entries(derived.tokens.colors);
  console.log(chalk.bold('\nPalette:'));
  if (colorEntries.length === 0) {
    console.log(chalk.dim('  (no colors recorded)'));
  } else {
    for (const [name, hex] of colorEntries) console.log(`  ${name.padEnd(16, ' ')} ${chalk.cyan(hex)}`);
  }

  const typographyEntries = Object.entries(derived.tokens.typography);
  if (typographyEntries.length > 0) {
    console.log(chalk.bold('\nTypography:'));
    for (const [name, value] of typographyEntries) console.log(`  ${name.padEnd(16, ' ')} ${value}`);
  }

  console.log(chalk.dim(`\nPersisted to Build Memory as brand_identities.project_name = "${newProject}".`));
}

// ---------------------------------------------------------------------------
// `forge queue-diff` — entry-level diff of the current queue.yaml vs a prompt-library snapshot
// ---------------------------------------------------------------------------

/** `forge queue-diff [--project <path>] [--against <hash-or-'previous'>]`. */
async function cmdQueueDiff(opts: { project?: string; against?: string }): Promise<void> {
  const projectPath = resolveProjectPath(opts.project ?? '.');
  const projectName = basename(projectPath) || 'project';
  const currentPath = join(projectPath, 'queue.yaml');
  const { existsSync } = await import('node:fs');
  if (!existsSync(currentPath)) {
    fail(`No queue.yaml found at ${currentPath}.`);
    return;
  }

  const against = opts.against ?? 'previous';
  const snapshot = getQueueVersion(projectName, against);
  if (!snapshot) {
    fail(`No queue snapshot found for project "${projectName}" (against: "${against}"). Run \`forge compile\` first.`);
    return;
  }

  const [current, before] = await Promise.all([
    loadQueueEntriesFromFile(currentPath),
    loadQueueEntriesFromFile(snapshot.snapshot_path),
  ]);
  const diff = diffQueueEntries(before, current);

  console.log(
    chalk.bold(`\nQueue diff: current (${current.length} entries) vs snapshot ${snapshot.queue_hash} `) +
      chalk.dim(`(${snapshot.created_at}, ${before.length} entries)`)
  );

  console.log(chalk.bold(`\nAdded (${diff.added.length}):`));
  if (diff.added.length === 0) console.log(chalk.dim('  (none)'));
  else for (const id of diff.added) console.log(chalk.green(`  + ${id}`));

  console.log(chalk.bold(`\nRemoved (${diff.removed.length}):`));
  if (diff.removed.length === 0) console.log(chalk.dim('  (none)'));
  else for (const id of diff.removed) console.log(chalk.red(`  - ${id}`));

  console.log(chalk.bold(`\nModified (${diff.modified.length}):`));
  if (diff.modified.length === 0) console.log(chalk.dim('  (none)'));
  else for (const m of diff.modified) console.log(chalk.yellow(`  ~ ${m.id}`) + chalk.dim(`  (${m.changedFields.join(', ')})`));
}

// ---------------------------------------------------------------------------
// `forge repair <path>` — repair a broken TypeScript repository
// ---------------------------------------------------------------------------

/** `forge repair <path>` — diagnose, cluster, queue, execute, and verify repairs. */
async function cmdRepair(
  pathArg: string,
  opts: {
    generateOnly?: boolean;
    autonomousRecovery?: boolean;
    maxClusters?: string;
    queuePath?: string;
  }
): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  const projectName = basename(projectPath) || 'project';
  console.log(chalk.bold(`\nRepairing ${projectName} at ${projectPath}`));
  if (opts.generateOnly) console.log(chalk.cyan('  GENERATE ONLY — repair queue will be written but not executed.'));

  // Phase 0 — environment pre-flight (advisory for repair; skip the AgentShield security
  // gate — a broken repo's leftover config must not block its own repair). Blockers are
  // surfaced but never halt: repair's whole purpose is fixing an unhealthy project.
  const scout = await runScout(projectPath, { skipSecurityGate: true });
  if (!scout.passed) {
    console.log(chalk.yellow(`  Phase 0 found ${scout.blockers.length} blocker(s) — continuing with repair anyway:`));
    for (const b of scout.blockers) console.log(chalk.dim(`    • ${b}`));
  }

  const maxClusters = opts.maxClusters ? Number.parseInt(opts.maxClusters, 10) : undefined;
  if (opts.maxClusters !== undefined && (Number.isNaN(maxClusters) || (maxClusters ?? 0) < 1)) {
    fail('--max-clusters must be a positive integer.');
    return;
  }

  const repairConfig: RepairConfig = {
    repairQueuePath: opts.queuePath,
    executeRepairs: !opts.generateOnly,
    autonomousRecovery: opts.autonomousRecovery ?? false,
    maxClusters,
  };

  const result = await withSpinner('FORGE Repair Mode', (log) =>
    runRepairMode(projectPath, { ...repairConfig, log })
  );

  // Summary
  console.log(`\n  errors found:  ${chalk.yellow(String(result.errorsFound))}`);
  console.log(`  errors remain: ${result.errorsAfterRepair === 0 ? chalk.green('0') : chalk.red(String(result.errorsAfterRepair))}`);
  console.log(`  clusters:      ${result.clusters.length}`);
  if (result.repairQueuePath) {
    console.log(chalk.dim(`  queue:         ${result.repairQueuePath}`));
  }

  if (result.executionResult) {
    const er = result.executionResult;
    console.log(
      `  execution:     ${statusChip(er.status)} — ` +
        `${chalk.green(String(er.completedPrompts) + ' done')}, ` +
        `${chalk.red(String(er.failedPrompts) + ' failed')}, ` +
        `${chalk.dim(String(er.skippedPrompts) + ' skipped')}`
    );
  }

  for (const gate of result.gateResults) {
    const label = gate.passed ? chalk.green('PASS') : chalk.red('FAIL');
    console.log(`  gate [${gate.gate.padEnd(7, ' ')}]: ${label}${gate.passed ? '' : ` (${gate.errorCount} error(s))`}`);
  }

  printWarnings(result.warnings);

  if (result.status === 'no_errors') {
    console.log(chalk.green('\n✔ No TypeScript errors found — repository is already healthy.'));
  } else if (result.status === 'success') {
    console.log(chalk.green('\n✔ Repair complete — all gates PASS.'));
  } else if (result.status === 'partial') {
    console.log(chalk.yellow(`\n⚠ Partial repair — ${result.errorsAfterRepair} error(s) remain. Re-run to continue.`));
    process.exitCode = 1;
  } else {
    fail(`Repair ${result.status} — ${result.errorsAfterRepair} error(s) remain.`);
  }
}

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

/**
 * Initialize Build Memory before any command executes (Session 1 — Memory
 * Consolidation). Silent stateless operation is no longer possible: success and
 * failure are both logged loudly, never swallowed.
 */
function initBuildMemoryOrWarn(): void {
  try {
    initializeForgeMemory();
    console.log(chalk.dim(`Build Memory: SQLite ready at ${getForgeDbPath()} (schema ${getSchemaVersion()})`));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(chalk.red.bold('\n⚠ BUILD MEMORY UNAVAILABLE — FORGE is running STATELESS this session.'));
    console.error(chalk.red(`  Reason: ${detail}`));
    console.error(
      chalk.red(
        '  No build history, error patterns, brands, or learning will persist until this is resolved.\n' +
          '  Run `forge health` after fixing disk/permission issues to confirm recovery.'
      )
    );
  }
}

async function main(): Promise<void> {
  initBuildMemoryOrWarn();
  const config = loadConfig();
  const program = new Command();

  program
    .name('forge')
    .description('FORGE 2.0 — autonomous software factory CLI')
    .version('2.0.0')
    .hook('preAction', () => {
      printHeader();
      printConfigWarnings(config);
    });

  program
    .command('build')
    .description('Full autonomous build pipeline: Phase 0 → 1 → 2 → 3 → 4 → 5')
    .argument('<path>', 'target project directory')
    .option('--idea <text>', 'raw product idea (generates the PRD)')
    .option('--prd <path>', 'use an existing PRD file instead of generating one')
    .option('--autonomous-recovery', 'enable Autonomous Recovery Mode (Contract 14)', false)
    .option('--dry-run', 'simulate the build (plan + cost, no execution)', false)
    .option('--skip-design', 'skip Phase 1A+1B and use existing governance docs', false)
    .option('--use-existing-queue', 'skip Phase 1 (design) and Phase 2 (governance + queue generation); run Phase 3 directly against the existing queue.yaml', false)
    .option('--start-at <number>', 'skip all prompts before this 1-based index and resume from it')
    .option(
      '--auto-resume',
      'resume automatically from Build Memory / SESSION_STATE.md + STATE_OF_THE_BUILD.md after a claude-runner timeout/exit, looping until done, genuinely halted, or --max-resumes is spent',
      false
    )
    .option('--resume-wait-minutes <n>', 'backoff between --auto-resume cycles', '5')
    .option('--max-resumes <n>', 'cap on --auto-resume cycles', '20')
    .action(
      (
        pathArg: string,
        opts: {
          idea?: string;
          prd?: string;
          autonomousRecovery?: boolean;
          dryRun?: boolean;
          skipDesign?: boolean;
          useExistingQueue?: boolean;
          skipSecurityGate?: boolean;
          startAt?: string;
          autoResume?: boolean;
          resumeWaitMinutes?: string;
          maxResumes?: string;
        }
      ) => cmdBuild(pathArg, opts)
    );

  program
    .command('scout')
    .description('Run Phase 0 only (Toolchain Scout): scan + lock the environment')
    .argument('<path>', 'target project directory')
    .action((pathArg: string) => cmdScout(pathArg));

  program
    .command('design')
    .description('Run Phase 0 + 1 only (PRD + Architecture). Stops at the Gate 2 review.')
    .argument('<path>', 'target project directory')
    .option('--idea <text>', 'raw product idea (generates the PRD)')
    .option('--prd <path>', 'use an existing PRD file instead of generating one')
    .action(async (pathArg: string, opts: { idea?: string; prd?: string }) => {
      await cmdDesign(pathArg, opts);
    });

  program
    .command('resume')
    .description('Resume a halted build from its last checkpoint')
    .argument('<build-id>', 'the build_runs id to resume')
    .action((buildId: string) => cmdResume(buildId));

  program
    .command('replay')
    .description('Replay a build from a checkpoint (F12)')
    .argument('<build-id>', 'the build_runs id to replay')
    .requiredOption('--from <prompt-index>', '1-based prompt index to replay from')
    .action((buildId: string, opts: { from?: string }) => cmdReplay(buildId, opts));

  program
    .command('status')
    .description('Show build status from Build Memory')
    .argument('[build-id]', 'a specific build_runs id (defaults to the most recent build)')
    .action((buildId: string | undefined) => cmdStatus(buildId, config));

  program
    .command('history')
    .description('List past builds')
    .option('--project <name>', 'filter to one project')
    .action((opts: { project?: string }) => cmdHistory(opts, config));

  program
    .command('patterns')
    .description('Show known error patterns and success rates')
    .action(() => cmdPatterns(config));

  program
    .command('agents')
    .description('List self-created agents and their status')
    .action(() => cmdAgents(config));

  program
    .command('resurrect')
    .description('Autopsy a failed project and rebuild it straight from the report (skips Phase 1A/1B)')
    .argument('<path>', 'target project directory')
    .option('--autonomous-recovery', 'enable Autonomous Recovery Mode (Contract 14) during the rebuild', false)
    .action((pathArg: string, opts: { autonomousRecovery?: boolean }) => cmdResurrect(pathArg, opts));

  program
    .command('estimate')
    .description('Cost/time estimate without building (F17)')
    .argument('<path>', 'target project directory')
    .option('--idea <text>', 'raw product idea')
    .option('--prd <path>', 'use an existing PRD file instead of an idea')
    .action((pathArg: string, opts: { idea?: string; prd?: string }) => cmdEstimate(pathArg, opts));

  program
    .command('repair')
    .description('Repair a broken TypeScript repo: diagnose → cluster → queue → execute → verify')
    .argument('<path>', 'target project directory')
    .option('--generate-only', 'generate the repair queue but skip Phase 3 execution', false)
    .option('--autonomous-recovery', 'enable Autonomous Recovery Mode (Contract 14) during repairs', false)
    .option('--max-clusters <n>', 'cap the number of repair prompt clusters (default 20)')
    .option('--queue-path <path>', 'custom path to write the repair queue.yaml')
    .action(
      (
        pathArg: string,
        opts: {
          generateOnly?: boolean;
          autonomousRecovery?: boolean;
          maxClusters?: string;
          queuePath?: string;
        }
      ) => cmdRepair(pathArg, opts)
    );

  const schedule = program
    .command('schedule')
    .description('Manage cron-scheduled recurring tasks (list / add / remove / trigger)');

  schedule
    .command('list')
    .description('Scheduler dashboard: every task with next/last run time and last result')
    .option('--json', 'emit the raw dashboard JSON', false)
    .action((opts: { json?: boolean }) => cmdScheduleList(opts));

  schedule
    .command('add')
    .description('Add a recurring task and persist its schedule in Build Memory')
    .argument('<name>', 'unique task name')
    .requiredOption('--type <type>', `task type (${SCHEDULED_TASK_TYPES.join(' | ')})`)
    .requiredOption('--cron <expr>', 'standard 5-field cron expression, e.g. "0 3 * * *"')
    .option('--description <text>', 'human description')
    .option('--metadata <json>', 'per-task config as a JSON object (retention windows, targets, …)')
    .option('--disabled', 'register the task but do not arm it', false)
    .action((name: string, opts: { type?: string; cron?: string; description?: string; disabled?: boolean; metadata?: string }) =>
      cmdScheduleAdd(name, opts)
    );

  schedule
    .command('remove')
    .description('Remove a scheduled task and its persisted schedule')
    .argument('<name>', 'task name')
    .action((name: string) => cmdScheduleRemove(name));

  schedule
    .command('trigger')
    .description('Run a scheduled task once now and report its outcome')
    .argument('<name>', 'task name')
    .action((name: string) => cmdScheduleTrigger(name));

  program
    .command('config')
    .description('Show the resolved FORGE configuration (secret-safe)')
    .action(() => {
      printHeader();
      console.log('\n' + describeConfig(config));
    });

  program
    .command('health')
    .description('Diagnose Build Memory, the UI/UX Pro Max skill, and capability wiring; writes FORGE_HEALTH.md')
    .action(() => cmdHealth());

  program
    .command('compile')
    .description('Merge a prompts/ directory (one queue entry per file) into one master queue.yaml, with a mandatory context re-anchor every 15 prompts')
    .option('--prompts-dir <dir>', 'directory to scan for *.yaml prompt files (default <project>/prompts)')
    .option('--out <file>', 'where to write the merged queue.yaml (default <project>/queue.yaml)')
    .option('--project <path>', 'target project directory (default cwd)')
    .action((opts: { promptsDir?: string; out?: string; project?: string }) => cmdCompile(opts));

  program
    .command('generate-prompts')
    .description("Generate a prompts/ library from a governance package via the LLM (review it, then run `forge compile`)")
    .requiredOption('--docs <dir>', 'directory containing the governance package (BLUEPRINT.md, SCHEMA_REGISTRY.md, …)')
    .option('--out <dir>', 'output directory for the generated prompt library (default <project>/prompts)')
    .option('--project <path>', 'target project directory (default cwd)')
    .option('--max-prompts <n>', 'cap on the total number of prompts the plan may generate')
    .action((opts: { docs?: string; out?: string; project?: string; maxPrompts?: string }) => cmdGeneratePrompts(opts));

  program
    .command('queue-diff')
    .description('Diff the current queue.yaml against a prompt-library snapshot at the entry level (added / removed / modified)')
    .option('--project <path>', 'target project directory (default cwd)')
    .option('--against <hash-or-previous>', "snapshot to diff against — a queue_hash prefix, or 'previous' (default)", 'previous')
    .action((opts: { project?: string; against?: string }) => cmdQueueDiff(opts));

  program
    .command('brand-inherit')
    .description("Derive a new project's design tokens from a baseline project's brand and persist them")
    .argument('<baseline-project>', 'project name whose brand_identities row to inherit from')
    .argument('<new-project>', 'project name to persist the derived brand under')
    .option('--tokens <json>', 'token overrides as a JSON object (colors/typography/spacing/radii/shadows), merged over the baseline')
    .action((baselineProject: string, newProject: string, opts: { tokens?: string }) =>
      cmdBrandInherit(baselineProject, newProject, opts)
    );

  program
    .command('retrofit')
    .description('Scan an existing codebase, diagnose issues, reconcile governance, and generate a continuation queue')
    .argument('<project-path>', 'Absolute path to the project to retrofit')
    .option('--scope <scope>', 'Analysis scope: A (codebase only), B (+ database), C (+ Vercel)', 'C')
    .option('--skip-dynamic', 'Skip dynamic route testing', false)
    .option('--resume', 'Resume from a prior SCAN checkpoint', false)
    .option('--non-interactive', 'Auto-approve all RECONCILE decisions', false)
    .option('--queue-output <path>', 'Override the QUEUE output directory')
    .option('--api-key <key>', 'Anthropic API key for adversarial review')
    .action(async (
      projectPath: string,
      opts: { scope?: string; skipDynamic?: boolean; resume?: boolean; nonInteractive?: boolean; queueOutput?: string; apiKey?: string }
    ) => {
      const spinner = ora('Starting FORGE RETROFIT...').start();
      try {
        const { runRetrofitPipeline } = await import('../retrofit/index.js');
        spinner.stop();
        await runRetrofitPipeline({
          projectPath: resolve(projectPath),
          scope: (opts.scope as 'A' | 'B' | 'C') ?? 'C',
          skipDynamic: opts.skipDynamic ?? false,
          resume: opts.resume ?? false,
          nonInteractive: opts.nonInteractive ?? false,
          queueOutputPath: opts.queueOutput,
          apiKey: opts.apiKey,
        });
      } catch (err: unknown) {
        spinner.fail('RETROFIT failed');
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
    });

  program
    .command('sentinel')
    .description('Run FORGE Sentinel quality pipeline against a project')
    .argument('<project-path>', 'Absolute path to the project')
    .option('--ring <ring>', 'Ring to run: 1 (every-prompt), 2 (every-10th), 3 (end-of-run), all', 'all')
    .option('--prompt-number <n>', 'Current prompt number (for ring trigger logic)', '1')
    .option('--final', 'Mark this as the final prompt of the run (triggers Ring 3)', false)
    .action(async (projectPath: string, opts: Record<string, unknown>) => {
      const { runSentinelRing } = await import('../phases/phase4-sentinel.js');
      const ring = String(opts['ring'] ?? 'all');
      const promptNumber = parseInt(String(opts['promptNumber'] ?? '1'), 10);
      const isFinal = Boolean(opts['final']);
      const rings = ring === 'all' ? [1, 2, 3] : [parseInt(ring, 10)];
      for (const r of rings) {
        if (r === 2 && promptNumber % 10 !== 0 && !isFinal) { console.log(`Ring 2 skipped (prompt ${promptNumber} is not a multiple of 10)`); continue; }
        if (r === 3 && !isFinal) { console.log('Ring 3 skipped (not final prompt — use --final to force)'); continue; }
        console.log(`\nRunning Sentinel Ring ${r}...`);
        const result = await runSentinelRing(r, projectPath, promptNumber);
        console.log(result.passed ? `Ring ${r}: PASSED` : `Ring ${r}: FAILED`);
        if (!result.passed) process.exit(1);
      }
    });

  program
    .command('compose')
    .description('Compose a FORGE execution queue from governance documents (BLUEPRINT.md, SCHEMA_REGISTRY.md, AGENTS.md)')
    .argument('<project-path>', 'Absolute path to the project with governance docs')
    .option('--mode <mode>', 'GREENFIELD or RETROFIT', 'GREENFIELD')
    .option('--api-key <key>', 'Anthropic API key for Claude-assisted extraction and gap detection')
    .option('--non-interactive', 'Auto-proceed despite blockers', false)
    .option('--prompts-per-run <n>', 'Max prompts per queue file', '45')
    .option('--output <path>', 'Output directory for queue files')
    .action(async (projectPath: string, opts: { mode?: string; apiKey?: string; nonInteractive?: boolean; promptsPerRun?: string; output?: string }) => {
      const spinner = ora('Composing FORGE queue...').start();
      try {
        const { runComposer } = await import('../composer/index.js');
        spinner.stop();
        const result = await runComposer({ projectPath: resolve(projectPath), mode: (opts.mode as 'GREENFIELD' | 'RETROFIT') ?? 'GREENFIELD', apiKey: opts.apiKey ?? process.env['ANTHROPIC_API_KEY'], nonInteractive: opts.nonInteractive ?? false, promptsPerRun: parseInt(opts.promptsPerRun ?? '45', 10), outputPath: opts.output });
        if (result.success) {
          console.log(chalk.green('\nComposition complete!'));
          console.log('  Prompts: ' + result.totalPrompts + ' across ' + result.totalRuns + ' runs');
          console.log('  Estimated cost: $' + result.estimatedCostUSD.toFixed(2));
          console.log('  Summary: ' + result.summaryPath);
        } else {
          console.error(chalk.red('\nComposition failed.'));
          for (const b of result.blockers) console.error(chalk.red('  BLOCKER: ' + b));
          process.exitCode = 1;
        }
      } catch (err: unknown) { spinner.fail('COMPOSE failed'); console.error(chalk.red(err instanceof Error ? err.message : String(err))); process.exitCode = 1; }
    });

  program
    .command('sequence')
    .description('Process multiple spec documents in dependency order for enterprise builds (40+ documents)')
    .argument('<specs-dir>', 'Directory containing specification documents')
    .argument('<project-path>', 'Absolute path to the project being built')
    .option('--api-key <key>', 'Anthropic API key')
    .option('--non-interactive', 'Auto-proceed despite warnings', false)
    .option('--dry-run', 'Show sequence plan without generating queues', false)
    .action(async (specsDir: string, projectPath: string, opts: { apiKey?: string; nonInteractive?: boolean; dryRun?: boolean }) => {
      const spinner = ora('Loading specification documents...').start();
      try {
        const { loadSpecDocuments, createSequencePlan, writeSequencePlanSummary } = await import('../composer/document-sequencer.js');
        const { runComposer } = await import('../composer/index.js');
        const { writeFileSync } = await import('node:fs');
        const { join: pathJoin } = await import('node:path');
        const { basename } = await import('node:path');
        spinner.stop();
        const docs = loadSpecDocuments(resolve(specsDir));
        const plan = createSequencePlan(docs);
        console.log(chalk.bold('\nFORGE Document Sequencer'));
        console.log('Documents: ' + docs.length + ' | Prompts: ~' + plan.totalEstimatedPrompts + ' | Runs: ~' + plan.totalEstimatedRuns + ' | Cost: ~$' + ((plan.totalEstimatedPrompts * 25000 / 1_000_000) * 3).toFixed(2));
        for (const w of plan.warnings) console.warn(chalk.yellow('WARNING: ' + w));
        const summaryPath = writeSequencePlanSummary(plan, pathJoin(resolve(projectPath), '.forge'));
        console.log('Sequence plan: ' + chalk.cyan(summaryPath));
        if (opts.dryRun) { console.log(chalk.yellow('\nDry run -- no queues generated.')); return; }
        for (let i = 0; i < plan.documents.length; i++) {
          const doc = plan.documents[i]!;
          console.log('[' + (i + 1) + '/' + plan.documents.length + '] ' + doc.filename);
          writeFileSync(pathJoin(resolve(projectPath), 'PRD.md'), doc.content, 'utf8');
          const result = await runComposer({ projectPath: resolve(projectPath), projectName: basename(resolve(projectPath)), mode: 'GREENFIELD', apiKey: opts.apiKey ?? process.env['ANTHROPIC_API_KEY'], nonInteractive: opts.nonInteractive ?? false });
          if (!result.success && !opts.nonInteractive) { console.error(chalk.red('Failed on ' + doc.filename)); process.exitCode = 1; return; }
        }
        console.log(chalk.green('\nSequencing complete!'));
      } catch (err: unknown) { spinner.fail('SEQUENCE failed'); console.error(chalk.red(err instanceof Error ? err.message : String(err))); process.exitCode = 1; }
    });

  program
    .command('deploy')
    .description('Deploy a FORGE-built project and inject post-deploy monitoring snippet')
    .argument('<project-path>', 'Absolute path to the built project')
    .option('--endpoint <url>', 'Telemetry receiver URL for monitoring snippet injection')
    .option('--project-name <name>', 'Project name for telemetry (defaults to directory name)')
    .option('--slow-load-ms <ms>', 'Slow-load warning threshold in milliseconds', '3000')
    .action(async (projectPath: string, opts: { endpoint?: string; projectName?: string; slowLoadMs?: string }) => {
      const spinner = ora('Preparing deploy...').start();
      try {
        const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
        const resolved = resolve(projectPath);
        spinner.stop();
        const buildReadyPath = join(resolved, '.forge', 'BUILD_READY.md');
        if (existsSync(buildReadyPath)) {
          console.log(chalk.cyan('\nBuild manifest:'));
          console.log(readFileSync(buildReadyPath, 'utf8').split('\n').slice(0, 8).join('\n'));
        }
        if (opts.endpoint) {
          const { generateMonitoringSnippet } = await import('../monitoring/deploy-agent.js');
          const pName = opts.projectName ?? basename(resolved);
          const snippet = generateMonitoringSnippet({
            endpoint: opts.endpoint,
            projectName: pName,
            slowPageLoadMs: parseInt(opts.slowLoadMs ?? '3000', 10),
          });
          const snippetPath = join(resolved, '.forge', 'monitoring-snippet.js');
          writeFileSync(snippetPath, snippet, 'utf8');
          console.log(chalk.green('\nMonitoring snippet: ' + snippetPath));
          console.log(chalk.yellow('Inject into your app\'s HTML <head> before going live.'));
        } else {
          console.log(chalk.yellow('\nNo --endpoint given — skipping monitoring snippet.'));
          console.log('Re-run with --endpoint <url> to generate a monitoring snippet.');
        }
        console.log(chalk.green('\nDeploy step complete. See .forge/BUILD_READY.md for launch instructions.'));
      } catch (err: unknown) {
        spinner.fail('DEPLOY failed');
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
    });

  registerLearningCommands(program);

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  getLogger('cli').fatal(detail);
  console.error(chalk.red.bold('\n✖ FORGE CLI crashed:'));
  console.error(chalk.red(detail));
  process.exitCode = 1;
});


