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
 *   verify <url>      Post-deploy HTTP health check: GET every src/app/api route against a live URL (F9)
 *   analyze <path>    Deep analysis: dead code, orphaned routes, schema drift, deps, coverage, CI (see subcommands)
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
import { appendFileSync, mkdirSync, existsSync, readFileSync, copyFileSync, statfsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { dump as dumpYaml, load as parseYaml } from 'js-yaml';

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
import type { AdversaryResult } from '../analysis/adversarial-review.js';
import type { DeepAnalysisReport } from '../retrofit/index.js';
import { checkAdversaryBlockers as checkAdversaryBlockersCore, resolveAcceptBlockers } from './adversary-gate.js';
import type { ReadinessTierId } from '../governance/readiness-levels.js';
import { looksLikeProjectPath } from '../tools/path-heuristics.js';
import { runRepairMode } from './repair-command.js';
import { checkpointTagFor } from '../engine/git-manager.js';
import { cmdHealth } from './health-command.js';
import { cmdCompile } from './compile-command.js';
import { cmdGeneratePrompts } from './generate-prompts-command.js';
import { tryRenderLiveStatus } from './status-command.js';
import { runDashboard } from './dashboard-command.js';
import { diffQueueEntries, getQueueVersion, loadQueueEntriesFromFile } from '../tools/queue-versioning.js';
import { runGapAudit, type AuditScope } from '../resurrection/index.js';
import { createOrchestratorEngine } from '../orchestrator/engine.js';
import { createManifestResolver } from '../orchestrator/manifest-resolver.js';
import { createLibraryManager, DEFAULT_LIBRARY_BASE_PATH } from '../orchestrator/library-manager.js';
import {
  QueueStatus,
  type LibraryManifest,
  type OrchestratorOptions,
  type OrchestratorResult,
} from '../orchestrator/types.js';
import { fromJsonText, fromSqliteBool } from '../memory/client.js';
import type {
  ExecutionMonitorResult,
  GovernanceEnforcerResult,
  ValidationResult,
} from '../sentinel-prime/types.js';
import {
  detectProjectStack,
  loadSkillsLibrary,
  buildSkillsContext,
  defaultSkillsLibraryDir,
  validateSkillFile,
} from '../skills/index.js';
import {
  createCredentialVault,
  createVercelDeployer,
  createSupabaseMigrator,
  validateEnv,
} from '../autonomy/index.js';
import {
  UIComponentGenerator,
  ensureDesignTokens,
  generateStoriesForProject,
  checkProjectAccessibility,
  ensureComponentsInstalled,
  type ComponentSpec,
} from '../ui-engine/index.js';
import { createDesignPipeline, type DesignPipelinePromptEntry } from '../design-pipeline/index.js';
import { createPlaywrightScreenshotter } from '../design-pipeline/screenshotter.js';
import { getDesignStoragePath, ensureStorageDirectories, getScreenshotPath } from '../design-pipeline/storage-config.js';

import { BuildMemory, nowIso } from '../memory/index.js';
import { registerLearningCommands } from './commands/learning.js';
import { registerAgentCommands } from './commands/agent.js';
import { getLogger, beginQuietLogging } from '../tools/forge-logger.js';
import { getForgeDbPath, getSchemaVersion, initializeForgeMemory } from '../learning/database.js';
import { deriveBrandFromBaseline, type DesignTokenSet } from '../tools/brand-inheritance.js';
import {
  createTaskScheduler,
  getSchedulerDashboard,
  type SchedulerDashboardRow,
} from '../tools/task-scheduler.js';
import type {
  AdrStatus,
  Assumption,
  AssumptionCategory,
  BuildRun,
  JsonObject,
  PromptExecution,
  RepairConfig,
  RiskCategory,
  RiskStatus,
  ScheduledTaskType,
  SelfCreatedAgent,
  TechDebtCategory,
  TechDebtItem,
  TechDebtSeverity,
} from '../types/index.js';
import type { StackFingerprint } from '../tools/stack-detector.js';

/** Default per-route latency budget for `forge verify` (F9), in milliseconds. */
const DEFAULT_VERIFY_LATENCY_BUDGET_MS = 3000;

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

/**
 * Append a line to `.forge/build.log` instead of stdout (best-effort — never throws). stdout is
 * reserved for `renderProgress`'s `[yyyy-MM-dd HH:mm:ss] [LEVEL]` lines during a build (FORGE 1.0
 * parity); everything else, including this banner, is diagnostic and belongs in the log file.
 */
function logToBuildFile(line: string): void {
  try {
    mkdirSync('.forge', { recursive: true });
    appendFileSync('.forge/build.log', `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

/** Log the FORGE banner once at startup (kept off stdout — see {@link logToBuildFile}). */
function printHeader(): void {
  logToBuildFile('FORGE 2.0 — autonomous software factory');
}

/** Print the config's non-fatal warnings (e.g. no .env, generated machine id). */
function printConfigWarnings(config: EnvConfig): void {
  for (const w of config.warnings) console.log(chalk.dim(`  • ${w}`));
}

function twoDigit(n: number): string {
  return String(n).padStart(2, '0');
}

/** `[yyyy-MM-dd HH:mm:ss] [LEVEL]` prefix — matches phase3-executor's renderProgress (FORGE 1.0 format). */
function tsPrefix(level: 'INFO' | 'WARN' | 'PASS' | 'FAIL'): string {
  const now = new Date();
  const ts = `${now.getFullYear()}-${twoDigit(now.getMonth() + 1)}-${twoDigit(now.getDate())} ${twoDigit(now.getHours())}:${twoDigit(now.getMinutes())}:${twoDigit(now.getSeconds())}`;
  return `[${ts}] [${level}]`;
}

/**
 * Run an async unit of work, reporting its progress as `[yyyy-MM-dd HH:mm:ss] [LEVEL]` lines on
 * stdout — matching `phase3-executor`'s `renderProgress` (FORGE 1.0 parity). Previously this used
 * an `ora` spinner, whose checkmark/dash frames write to stderr; under PowerShell that gets
 * wrapped as a NativeCommandError and interleaves garbled lines ahead of the real output. The work
 * functions never throw, but we still report failure defensively.
 */
async function withSpinner<T>(
  title: string,
  fn: (log: (message: string) => void) => Promise<T>
): Promise<T> {
  process.stdout.write(`${tsPrefix('INFO')} ${title}\n`);
  try {
    const result = await fn((message) => {
      process.stdout.write(`${tsPrefix('INFO')} ${title} — ${message}\n`);
    });
    process.stdout.write(`${tsPrefix('PASS')} ${title}\n`);
    return result;
  } catch (error) {
    process.stdout.write(`${tsPrefix('FAIL')} ${title}\n`);
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

/**
 * Session 5 finding #2: any adversarial-review BLOCKER halts the pipeline — even in autonomous
 * mode — writing the blocker list to `<project>/state/halt-reason.md`. `--accept-blockers` is
 * the explicit human override (separate from `--autonomous-recovery`, which is Contract 14
 * self-heal ONLY and never bypasses a gate). Console-wired wrapper around the extracted, testable
 * {@link checkAdversaryBlockersCore} (src/cli/adversary-gate.ts).
 */
async function checkAdversaryBlockers(
  projectPath: string,
  phaseLabel: string,
  review: AdversaryResult | null,
  acceptBlockers: boolean
): Promise<boolean> {
  return checkAdversaryBlockersCore(projectPath, phaseLabel, review, acceptBlockers, {
    onOverride: (m) => console.log(chalk.yellow(`  ⚠ ${m}`)),
    onHalt: (m) => {
      if (m.startsWith('  [')) console.log(chalk.red(`  ${m.trim()}`));
      else fail(m);
    },
  });
}

/** Print a list of warnings under a heading, if any. */
function printWarnings(warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  console.log(chalk.yellow(`  ${warnings.length} warning(s):`));
  for (const w of warnings) console.log(chalk.dim(`    • ${w}`));
}

/** One category's findings under a bold heading, capped at 10 with a "+N more" note (`forge analyze`). */
function printFindingList(heading: string, lines: readonly string[]): void {
  console.log(chalk.bold(`\n  ${heading}:`));
  if (lines.length === 0) {
    console.log(chalk.dim('    none found'));
    return;
  }
  for (const line of lines.slice(0, 10)) console.log(`    ${line}`);
  if (lines.length > 10) console.log(chalk.dim(`    … and ${lines.length - 10} more`));
}

/**
 * Renders a full {@link DeepAnalysisReport} to the console (`forge analyze`): per-category
 * totals, the top 10 most critical findings in each category, and the overall health score.
 */
function printDeepAnalysisReport(report: DeepAnalysisReport): void {
  const coverageGaps = report.coverage.filter((f) => f.priority !== 'low').length;
  console.log(
    chalk.dim(
      `  dead code: ${report.deadCode.length}    orphaned routes: ${report.orphanedRoutes.length}    ` +
        `schema drift: ${report.schemaDrift.length}    dependency issues: ${report.dependencies.length}    ` +
        `coverage gaps: ${coverageGaps}`
    )
  );

  printFindingList('Dead Code — top 10', report.deadCode.map((f) => `${f.filePath}:${f.lineNumber} — ${f.reason}`));
  printFindingList('Orphaned Routes — top 10', report.orphanedRoutes.map((f) => `${f.routePath} (${f.filePath}) — ${f.reason}`));
  printFindingList('Schema Drift — top 10', report.schemaDrift.map((f) => `[${f.severity}] ${f.tableName} — ${f.detail}`));
  printFindingList('Dependency Issues — top 10', report.dependencies.map((f) => `[${f.findingType}] ${f.packageName} — ${f.detail}`));
  printFindingList(
    'Coverage Baseline — top 10',
    report.coverage.map((f) => `[${f.priority}] ${f.filePath} — ${f.coveragePercent}%${f.hasTestFile ? '' : ' — NO TEST FILE'}`)
  );

  const scoreColor = report.healthScore >= 70 ? chalk.green : report.healthScore >= 40 ? chalk.yellow : chalk.red;
  console.log(`\n  ${chalk.bold('Overall health score:')} ${scoreColor(`${report.healthScore}/100`)}`);
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
async function cmdDesign(
  pathArg: string,
  opts: { idea?: string; prd?: string; skipSecurityGate?: boolean; acceptBlockers?: boolean }
): Promise<ArchitectureDesign | null> {
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
    const prdOk = await checkAdversaryBlockers(
      projectPath,
      'Phase 1A — PRD adversarial review',
      prdResult.passes.pass2.adversarialReview,
      opts.acceptBlockers ?? false
    );
    if (!prdOk) return null;
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
  const designOk = await checkAdversaryBlockers(
    projectPath,
    'Phase 1B — Architecture adversarial review',
    design.adversaryReview,
    opts.acceptBlockers ?? false
  );
  if (!designOk) return null;
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
    acceptBlockers?: boolean;
    autoApproveGates?: boolean;
    allowHeadless?: boolean;
    maxBudgetUsd?: string;
  }
): Promise<void> {
  beginQuietLogging('.forge/build.log');
  const autoResume = opts.autoResume ?? false;
  // Session 5 finding #2/#3 (and the Session 5.1 hotfix): adversary-review BLOCKERs are a SEPARATE
  // concern from both Contract 14 self-heal (--autonomous-recovery) and the human-gate bypass
  // (--auto-approve-gates). Only --accept-blockers, passed explicitly, overrides a BLOCKER halt —
  // see resolveAcceptBlockers() for why --auto-approve-gates must NOT also flow into this.
  opts = { ...opts, acceptBlockers: resolveAcceptBlockers(opts) };
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
    process.stdout.write(`${tsPrefix('INFO')} ${chalk.cyan(`--start-at ${startAt}: prompts 1–${startAt - 1} will be skipped.`)}\n`);
  }
  // --max-budget-usd: parse and validate early, same posture as --start-at above.
  let maxBudgetUsd: number | undefined;
  if (opts.maxBudgetUsd !== undefined) {
    maxBudgetUsd = Number.parseFloat(opts.maxBudgetUsd);
    if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
      fail('--max-budget-usd must be a positive number.');
      return;
    }
    process.stdout.write(`${tsPrefix('INFO')} ${chalk.cyan(`--max-budget-usd $${maxBudgetUsd.toFixed(2)}: Phase 3 halts cleanly between prompts once its cost estimate reaches this cap.`)}\n`);
  }

  const projectPath = resolveProjectPath(pathArg);
  const projectName = basename(projectPath) || 'project';
  process.stdout.write(`\n${tsPrefix('INFO')} ${chalk.bold(`Building ${projectName} at ${projectPath}`)}\n`);
  if (opts.dryRun) process.stdout.write(`${tsPrefix('INFO')} ${chalk.cyan('DRY RUN — no claude/git/Sentinel execution; plan + cost only.')}\n`);

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
    process.stdout.write(
      `${tsPrefix('WARN')} ${chalk.yellow('--use-existing-queue: skipping Phase 1 (design) and Phase 2 (governance + queue generation).')}\n`
    );
    process.stdout.write(`${tsPrefix('INFO')} ${chalk.dim(`queue: ${queuePath}`)}\n`);

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
          allowHeadless: opts.allowHeadless ?? false,
          maxBudgetUsd,
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
      process.stdout.write(`\n${tsPrefix('INFO')} ${chalk.cyan('Dry run complete — nothing was executed.')}\n`);
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
      process.stdout.write(`\n${tsPrefix('PASS')} ${chalk.green('✔ Build pipeline complete.')}\n`);
    } else {
      process.stdout.write(`\n${tsPrefix('WARN')} ${chalk.yellow('Build finished, but Build Memory was unavailable — Phase 5 learning skipped (stateless mode).')}\n`);
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
      process.stdout.write(
        `${tsPrefix('INFO')} ${chalk.dim(`auto-context: prepending ${gov.sources.length} governance doc(s) — ${gov.sources.join(', ')}`)}\n`
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
          allowHeadless: opts.allowHeadless ?? false,
          maxBudgetUsd,
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
  process.stdout.write(`${tsPrefix('INFO')} ${chalk.dim(`queue: ${queue.stats.totalPrompts} prompt(s) → ${queue.queuePath ?? '(not written)'}`)}\n`);
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
        allowHeadless: opts.allowHeadless ?? false,
        maxBudgetUsd,
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
    process.stdout.write(`\n${tsPrefix('INFO')} ${chalk.cyan('Dry run complete — nothing was executed.')}\n`);
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
    process.stdout.write(`\n${tsPrefix('PASS')} ${chalk.green('✔ Build pipeline complete.')}\n`);
  } else {
    process.stdout.write(`\n${tsPrefix('WARN')} ${chalk.yellow('Build finished, but Build Memory was unavailable — Phase 5 learning skipped (stateless mode).')}\n`);
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
async function cmdStatus(
  buildId: string | undefined,
  config: EnvConfig,
  opts: { project?: string; watch?: boolean } = {}
): Promise<void> {
  // Session 5 finding #7: `forge status <path>` (no --project) used to silently misparse the
  // path as a build-id UUID ("No build ./my-project found."). Detect a path-shaped positional
  // argument and route it to --project instead.
  if (buildId && !opts.project && looksLikeProjectPath(buildId)) {
    opts = { ...opts, project: buildId };
    buildId = undefined;
  }

  // Live observability (Session 4 — Task 3): when --watch is requested, or no explicit build-id
  // was given and a live-status.json exists, show the REAL-TIME dashboard instead of (or before
  // falling back to) the historical Build Memory query below.
  if (opts.watch || !buildId) {
    const rendered = await tryRenderLiveStatus({ project: opts.project, watch: opts.watch });
    if (rendered) return;
  }

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

/**
 * `forge dashboard [project-path]` — read-only, live-updating view of the current/most recent
 * build run's Control Plane telemetry (`.forge/runs/<run-id>/*.jsonl`,
 * `src/telemetry/run-recorder.ts`), plus the same running cost total `forge status` shows (from
 * `.forge/live-status.json`). See `src/cli/dashboard-command.ts` for the full implementation —
 * this wrapper only resolves the path.
 */
async function cmdDashboard(pathArg: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  await runDashboard(projectPath);
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
async function cmdResurrect(
  pathArg: string,
  opts: { autonomousRecovery?: boolean; resume?: boolean; nonInteractive?: boolean }
): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  const projectName = basename(projectPath) || 'project';

  if (opts.resume) {
    await cmdResurrectResume(projectPath, projectName, { nonInteractive: opts.nonInteractive });
    return;
  }

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

/**
 * `forge resurrect <path> --resume` — halt-recovery audit + resume from the exact halt point
 * (RESURRECTION_BLUEPRINT.md §Integration Points › `src/cli/index.ts`). Runs a TARGETED gap
 * audit to reconstruct the halt point and score governance health, enforces the resume floor in
 * code (mean composite_score >= 0.70 and zero CRITICAL gaps — Contract R-5), then hands the
 * reconstructed prompt index to the existing replay machinery so completed prompts 1..N are
 * never re-run (R7).
 */
async function cmdResurrectResume(
  projectPath: string,
  projectName: string,
  opts: { nonInteractive?: boolean }
): Promise<void> {
  console.log(chalk.bold(`\nResuming ${projectName} at ${projectPath} via halt-recovery audit`));

  const audit = await runGapAudit({
    projectPath,
    scope: 'TARGETED',
    trigger: 'halt_recovery',
    haltRecovery: true,
    nonInteractive: opts.nonInteractive ?? false,
  });

  console.log(
    `  health: ${audit.healthScoreBefore?.toFixed(2) ?? 'n/a'} → ${audit.healthScoreAfter?.toFixed(2) ?? 'n/a'}  ` +
      `resume eligible: ${audit.resumeEligible ? chalk.green('yes') : chalk.red('no')}`
  );
  if (audit.reportPath) console.log(chalk.dim(`  audit report: ${audit.reportPath}`));

  if (!audit.resumeEligible) {
    const criticalCount = audit.gaps.filter((g) => g.severity === 'CRITICAL').length;
    fail(
      `Resume blocked — the resume floor was not met (mean composite_score >= 0.70 and zero CRITICAL gaps required; ` +
        `got ${(audit.healthScoreAfter ?? audit.healthScoreBefore ?? 0).toFixed(2)} with ${criticalCount} CRITICAL gap(s)). ` +
        'Re-run `forge audit --halt-recovery` interactively (without --non-interactive) to clear any human gates.'
    );
    return;
  }

  const haltPoint = audit.haltPoint;
  if (!haltPoint || haltPoint.buildRunId === null || haltPoint.promptIndex === null) {
    fail('Resume blocked — the gap audit could not reconstruct a halt point (no halted/non-terminal build found for this project in Build Memory).');
    return;
  }

  const build = await BuildMemory.builds.getBuild(haltPoint.buildRunId);
  if (!build) {
    fail(`Resume blocked — build ${haltPoint.buildRunId} referenced by the reconstructed halt point was not found in Build Memory.`);
    return;
  }

  const fromPromptIndex = haltPoint.promptIndex;
  const checkpointTag = checkpointTagFor(build.id, fromPromptIndex - 1);
  console.log(
    chalk.bold(
      `  resuming build ${build.id} at prompt ${fromPromptIndex}` +
        (haltPoint.promptName ? ` ('${haltPoint.promptName}')` : '')
    ) + (haltPoint.failingCheck ? chalk.dim(`, which failed check "${haltPoint.failingCheck}"`) : '')
  );

  await runReplay(build, { originalBuildRunId: build.id, fromCheckpointTag: checkpointTag, fromPromptIndex });
}

/**
 * `forge audit <project-path>` — governance-vs-code gap audit (System 1: GapAuditor). Wraps
 * ForgeRetrofit's scan + DIAGNOSE, scores each governance artifact, regenerates AUTO-tier gaps,
 * and gates architectural (CRITICAL/HUMAN_GATE) gaps for human approval.
 */
async function cmdAudit(
  pathArg: string,
  opts: { scope?: string; haltRecovery?: boolean; nonInteractive?: boolean; apiKey?: string }
): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  const projectName = basename(projectPath) || 'project';
  const scope = (opts.scope as AuditScope | undefined) ?? 'FULL';
  console.log(chalk.bold(`\nAuditing ${projectName} at ${projectPath}`) + chalk.dim(`  (scope: ${scope})`));

  const result = await runGapAudit({
    projectPath,
    scope,
    trigger: 'manual',
    haltRecovery: opts.haltRecovery ?? false,
    nonInteractive: opts.nonInteractive ?? false,
    apiKey: opts.apiKey,
  });

  const critical = result.gaps.filter((g) => g.severity === 'CRITICAL').length;
  const major = result.gaps.filter((g) => g.severity === 'MAJOR').length;
  const minor = result.gaps.filter((g) => g.severity === 'MINOR').length;
  console.log(
    `  gaps: ${chalk.bold(String(result.gaps.length))} total ` +
      `(${chalk.red(String(critical) + ' critical')}, ${chalk.yellow(String(major) + ' major')}, ${chalk.dim(String(minor) + ' minor')})`
  );
  console.log(
    `  health: ${result.healthScoreBefore?.toFixed(2) ?? 'n/a'} → ${result.healthScoreAfter?.toFixed(2) ?? 'n/a'}  ` +
      `resume eligible: ${result.resumeEligible ? chalk.green('yes') : chalk.red('no')}`
  );
  if (result.haltPoint?.buildRunId) {
    console.log(
      chalk.dim(
        `  halt point: build ${result.haltPoint.buildRunId} prompt ${result.haltPoint.promptIndex ?? '?'} ` +
          `(${result.haltPoint.promptName ?? 'unnamed'}${result.haltPoint.failingCheck ? `, failed "${result.haltPoint.failingCheck}"` : ''})`
      )
    );
  }
  if (result.reportPath) console.log(chalk.dim(`  report: ${result.reportPath}`));

  if (result.status === 'halted_for_human') {
    fail('Audit halted for human — architectural gaps await approval (re-run `forge audit` interactively, without --non-interactive, to clear the gate).');
    return;
  }
}

/**
 * `forge readiness <path> [--tier <id>]` — the Readiness-Level Engine (`src/governance/
 * readiness-levels.ts`). With `--tier`, also evaluates the machine-verifiable Definition of Done
 * (`src/governance/definition-of-done.ts`) against that tier and reports the current gap.
 */
async function cmdReadiness(pathArg: string, opts: { tier?: string }): Promise<void> {
  const { READINESS_TIERS, parseReadinessTierId } = await import('../governance/readiness-levels.js');
  const projectPath = resolveProjectPath(pathArg);
  const projectName = basename(projectPath) || 'project';

  if (!opts.tier) {
    console.log(chalk.bold(`\nFORGE Readiness-Level Engine\n`));
    for (const tier of READINESS_TIERS) {
      console.log(`  ${chalk.bold(String(tier.level))}. ${chalk.cyan(tier.id)} — ${tier.label}`);
      console.log(chalk.dim(`     ${tier.description}`));
      console.log(
        chalk.dim(
          `     governance: ${tier.requiredGovernanceArtifacts.join(', ')} | ` +
            `tests: ${tier.requiredTestSuites.join(', ')}`
        )
      );
    }
    console.log(chalk.dim('\nRun with --tier <id> to evaluate the Definition of Done for a specific tier against this project.'));
    return;
  }

  const targetTier = parseReadinessTierId(opts.tier);
  if (!targetTier) {
    fail(`Unknown --tier "${opts.tier}". Expected one of: ${READINESS_TIERS.map((t) => t.id).join(', ')}.`);
    return;
  }

  const { evaluateDoD } = await import('../governance/definition-of-done.js');
  console.log(chalk.bold(`\nEvaluating Definition of Done for ${projectName} — target tier ${targetTier}\n`));
  const result = await evaluateDoD(projectPath, targetTier);
  for (const check of result.checks) {
    const marker = check.passed ? chalk.green('[PASS]') : chalk.red('[FAIL]');
    console.log(`  ${marker} ${check.name}: ${check.detail}`);
  }
  console.log('');
  if (result.passed) {
    console.log(chalk.green.bold(`Definition of Done PASSED for target tier ${targetTier}.`));
  } else {
    fail(`Definition of Done FAILED for target tier ${targetTier} — see the failed check(s) above.`);
  }
}

/**
 * `forge trace <req-id> [project-path]` — the Requirements Traceability Engine
 * (`src/governance/traceability.ts`). Reports how far a `REQ-NNN` id has progressed: PLANNED
 * (referenced in queue.yaml), IMPLEMENTED (referenced in a git commit), TESTED (referenced in
 * recorded test evidence), or DEPLOYED (the project's latest build completed and shipped) —
 * plus, bidirectionally, which `adr_records`/`risks` rows appear to have motivated it.
 *
 * `--reverse <identifier>` inverts the lookup: given a downstream identifier (a queue entry
 * id/name, a commit hash, a test suite name), it reports which `REQ-NNN` id(s) trace back to it.
 * `--untested` lists every requirement/feature with zero recorded test evidence. Both flags are
 * mutually exclusive with the default id-forward trace and with each other.
 */
async function cmdTrace(
  identifierArg: string | undefined,
  pathArg: string | undefined,
  opts: { reverse?: boolean; untested?: boolean }
): Promise<void> {
  const { traceRequirement, formatTraceResult, traceReverse, formatReverseTraceResult, findUntestedRequirements, formatUntestedResult } =
    await import('../governance/traceability.js');

  if (opts.untested) {
    const projectPath = resolveProjectPath(identifierArg ?? pathArg ?? '.');
    const result = await findUntestedRequirements(projectPath);
    console.log(chalk.bold(`\nFORGE Requirements Traceability — untested requirements/features for ${result.projectName}\n`));
    console.log(formatUntestedResult(result));
    console.log('');
    if (result.untestedRequirements.length === 0 && result.untestedFeatures.length === 0) {
      console.log(chalk.green.bold('Every declared requirement and feature has recorded test evidence.'));
    } else {
      fail(`${result.untestedRequirements.length} requirement(s) and ${result.untestedFeatures.length} feature(s) have no recorded test evidence.`);
    }
    return;
  }

  if (opts.reverse) {
    if (!identifierArg) {
      fail('forge trace --reverse requires an identifier (a queue entry id/name, commit hash, or test suite name) to trace backward.');
      return;
    }
    const projectPath = resolveProjectPath(pathArg ?? '.');
    const result = await traceReverse(identifierArg, projectPath);
    console.log(chalk.bold(`\nFORGE Requirements Traceability — reverse trace for ${result.projectName}\n`));
    console.log(formatReverseTraceResult(result));
    console.log('');
    if (result.matchedRequirementIds.length === 0) {
      fail(`No REQ-NNN requirement id traces back to "${identifierArg}" for ${projectPath}.`);
    } else {
      console.log(chalk.green.bold(`Traces back to: ${result.matchedRequirementIds.join(', ')}`));
    }
    return;
  }

  if (!identifierArg) {
    fail('forge trace requires a REQ-NNN requirement id (or --reverse <identifier> / --untested).');
    return;
  }
  const projectPath = resolveProjectPath(pathArg ?? '.');
  const result = await traceRequirement(identifierArg, projectPath);

  console.log(chalk.bold(`\nFORGE Requirements Traceability — ${result.projectName}\n`));
  console.log(formatTraceResult(result));
  console.log('');

  if (result.stage === 'unreferenced') {
    fail(`${result.reqId} was not found in queue.yaml, git history, or recorded test evidence for ${projectPath}.`);
  } else {
    console.log(chalk.green.bold(`${result.reqId} — stage: ${result.stage.toUpperCase()}`));
  }
}

/**
 * `forge state <path> [--tier <id>]` — the formal Build State Machine
 * (`src/governance/build-state-machine.ts`). Infers the project's current lifecycle state from
 * real signals (governance files on disk, `build_runs`, `gap_audit_runs`, `deployment_history`,
 * and — with `--tier` — the Definition of Done) and prints the legal next state(s).
 */
async function cmdState(pathArg: string, opts: { tier?: string }): Promise<void> {
  const { deriveProjectState, formatProjectStateResult } = await import('../governance/build-state-machine.js');
  const { parseReadinessTierId, READINESS_TIERS } = await import('../governance/readiness-levels.js');
  const projectPath = resolveProjectPath(pathArg);

  let targetTier: ReadinessTierId | undefined;
  if (opts.tier) {
    targetTier = parseReadinessTierId(opts.tier) ?? undefined;
    if (!targetTier) {
      fail(`Unknown --tier "${opts.tier}". Expected one of: ${READINESS_TIERS.map((t) => t.id).join(', ')}.`);
      return;
    }
  }

  const result = await deriveProjectState(projectPath, { targetTier });
  console.log(chalk.bold(`\nFORGE Build State Machine — ${result.projectName}\n`));
  console.log(formatProjectStateResult(result));
  console.log('');
  console.log(chalk.green.bold(`state: ${result.state}`));
}

/**
 * `forge blast-radius <path> [files...]` — Change-Impact / Blast-Radius Analysis
 * (`src/governance/blast-radius.ts`). With explicit files, analyzes exactly those; otherwise
 * auto-detects changed files from real git state (`git diff` + untracked files).
 */
async function cmdBlastRadius(pathArg: string, files: string[]): Promise<void> {
  const { analyzeBlastRadius, formatBlastRadiusResult, getGitChangedFiles } = await import('../governance/blast-radius.js');
  const projectPath = resolveProjectPath(pathArg);
  const changedFiles = files.length > 0 ? files : getGitChangedFiles(projectPath);

  if (changedFiles.length === 0) {
    console.log(chalk.dim(`No changed files given and none detected via git in ${projectPath}.`));
    return;
  }

  console.log(chalk.bold(`\nFORGE Blast-Radius Analysis — ${basename(projectPath)}\n`));
  const result = await analyzeBlastRadius(projectPath, changedFiles);
  console.log(formatBlastRadiusResult(result));
  console.log('');
  console.log(
    chalk.green.bold(
      `minimum safe validation set: ${result.impactedTestFiles.length} test file(s), ${result.impactedApiRoutes.length} API route(s)`
    )
  );
}

/**
 * `forge deadloop` — Dead-Loop Detection (`src/governance/dead-loop-detection.ts`). Scans every
 * `error_patterns` row (dead loops are a property of the error, not of one project — the same
 * scope `findMatchingPattern` already looks up in) and prints the ones currently tripped.
 */
async function cmdDeadLoop(): Promise<void> {
  const { listDeadLoopCandidates, formatDeadLoopVerdict } = await import('../governance/dead-loop-detection.js');
  const candidates = await listDeadLoopCandidates();
  console.log(chalk.bold('\nFORGE Dead-Loop Detection\n'));
  if (candidates.length === 0) {
    console.log(chalk.green('No error signature currently exceeds the dead-loop thresholds.'));
    return;
  }
  console.log(chalk.red.bold(`${candidates.length} dead-loop candidate(s):\n`));
  for (const v of candidates) {
    console.log(formatDeadLoopVerdict(v));
    console.log('');
  }
}

/**
 * `forge stagnation <path> [--build <id>]` — Stagnation Detection
 * (`src/governance/stagnation-detection.ts`). Evaluates the given build, or the project's most
 * recent build when `--build` is omitted.
 */
async function cmdStagnation(pathArg: string, opts: { build?: string }): Promise<void> {
  const { detectStagnation, formatStagnationVerdict } = await import('../governance/stagnation-detection.js');
  const projectPath = resolveProjectPath(pathArg);
  const projectName = basename(projectPath);

  let buildId = opts.build;
  if (!buildId) {
    const builds = await BuildMemory.builds.getBuildsByProject(projectName);
    if (!builds || builds.length === 0) {
      fail(`No builds recorded for project "${projectName}" — pass --build <id> explicitly, or run a build first.`);
      return;
    }
    buildId = builds[0]!.id;
  }

  const result = await detectStagnation(buildId);
  if (!result) {
    fail(`Could not evaluate build ${buildId} — unknown build id, or Build Memory is unreachable.`);
    return;
  }
  console.log(chalk.bold(`\nFORGE Stagnation Detection — ${projectName}\n`));
  console.log(formatStagnationVerdict(result));
  console.log('');
  console.log(result.isStagnant ? chalk.red.bold('STAGNANT — replanning recommended') : chalk.green.bold('not stagnant'));
}

/**
 * `forge adr` — the ADR (Architecture Decision Record) provenance log
 * (`src/governance/provenance-ledgers.ts`). `add` records a decision with automatic sequential
 * numbering and an optional supersede chain; `list` prints the full log for a project.
 */
async function cmdAdrAdd(
  pathArg: string,
  opts: { title?: string; context?: string; decision?: string; decidedBy?: string; status?: string; consequences?: string; alternatives?: string; source?: string; supersedes?: string }
): Promise<void> {
  if (!opts.title || !opts.context || !opts.decision || !opts.decidedBy) {
    fail('adr add requires --title, --context, --decision, and --decided-by.');
    return;
  }
  const { recordAdr } = await import('../governance/provenance-ledgers.js');
  const projectPath = resolveProjectPath(pathArg);
  let alternativesConsidered: string[] | undefined;
  if (opts.alternatives) {
    try {
      const parsed: unknown = JSON.parse(opts.alternatives);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      alternativesConsidered = parsed as string[];
    } catch {
      fail('--alternatives must be a JSON array of strings.');
      return;
    }
  }
  const record = await recordAdr(projectPath, {
    title: opts.title,
    context: opts.context,
    decision: opts.decision,
    decidedBy: opts.decidedBy,
    status: opts.status as AdrStatus | undefined,
    consequences: opts.consequences,
    alternativesConsidered,
    source: opts.source,
    supersedes: opts.supersedes,
  });
  if (!record) {
    fail('could not record ADR — Build Memory is unreachable.');
    return;
  }
  console.log(chalk.green(`\n✓ recorded ADR-${String(record.adr_number).padStart(3, '0')}: ${record.title}`));
}

async function cmdAdrList(pathArg: string): Promise<void> {
  const { listAdrs, formatAdrLog } = await import('../governance/provenance-ledgers.js');
  const projectPath = resolveProjectPath(pathArg);
  const records = await listAdrs(projectPath);
  console.log(chalk.bold(`\nFORGE ADR Log — ${basename(projectPath)}\n`));
  console.log(formatAdrLog(records ?? []));
  console.log('');
}

/**
 * `forge assumption` — the assumption registry (`src/governance/provenance-ledgers.ts`). `add`
 * records an assumption (starts `unvalidated`); `validate` records the outcome of independently
 * checking one; `list` prints the registry for a project.
 */
async function cmdAssumptionAdd(
  pathArg: string,
  opts: { statement?: string; category?: string; impact?: string; confidence?: string; owner?: string; adr?: string }
): Promise<void> {
  const categories = ['technical', 'business', 'user', 'infra', 'data', 'security'];
  if (!opts.statement || !opts.category || !opts.impact) {
    fail('assumption add requires --statement, --category, and --impact.');
    return;
  }
  if (!categories.includes(opts.category)) {
    fail(`--category must be one of: ${categories.join(', ')}`);
    return;
  }
  let confidence: number | undefined;
  if (opts.confidence !== undefined) {
    confidence = Number(opts.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      fail('--confidence must be a number between 0 and 1.');
      return;
    }
  }
  const { recordAssumption } = await import('../governance/provenance-ledgers.js');
  const projectPath = resolveProjectPath(pathArg);
  const created = await recordAssumption(projectPath, {
    statement: opts.statement,
    category: opts.category as AssumptionCategory,
    impactIfWrong: opts.impact,
    confidence,
    owner: opts.owner,
    relatedAdrId: opts.adr,
  });
  if (!created) {
    fail('could not record assumption — Build Memory is unreachable.');
    return;
  }
  console.log(chalk.green(`\n✓ recorded assumption: ${created.statement}`));
}

async function cmdAssumptionList(pathArg: string, opts: { status?: string }): Promise<void> {
  const { listAssumptions, formatAssumptionRegistry } = await import('../governance/provenance-ledgers.js');
  const projectPath = resolveProjectPath(pathArg);
  const list = await listAssumptions(projectPath, opts.status as Assumption['status'] | undefined);
  console.log(chalk.bold(`\nFORGE Assumption Registry — ${basename(projectPath)}\n`));
  console.log(formatAssumptionRegistry(list ?? []));
  console.log('');
}

async function cmdAssumptionValidate(
  id: string,
  opts: { outcome?: string; method?: string; evidence?: string }
): Promise<void> {
  if (opts.outcome !== 'validated' && opts.outcome !== 'invalidated') {
    fail('assumption validate requires --outcome validated|invalidated.');
    return;
  }
  if (!opts.method || !opts.evidence) {
    fail('assumption validate requires --method and --evidence.');
    return;
  }
  const { validateAssumption } = await import('../governance/provenance-ledgers.js');
  const updated = await validateAssumption(id, opts.outcome, opts.method, opts.evidence);
  if (!updated) {
    fail(`no assumption found with id '${id}', or Build Memory is unreachable.`);
    return;
  }
  console.log(chalk.green(`\n✓ assumption ${id} marked ${updated.status}`));
}

/**
 * `forge risk` — the risk register (`src/governance/provenance-ledgers.ts`). `add` records a risk
 * with a derived severity score (probability × impact); `status` transitions it; `list` prints
 * the register sorted by severity.
 */
async function cmdRiskAdd(
  pathArg: string,
  opts: { title?: string; description?: string; category?: string; probability?: string; impact?: string; mitigation?: string; owner?: string }
): Promise<void> {
  const categories = ['technical', 'schedule', 'security', 'operational', 'compliance', 'financial', 'vendor'];
  if (!opts.title || !opts.description || !opts.category || !opts.probability || !opts.impact) {
    fail('risk add requires --title, --description, --category, --probability, and --impact.');
    return;
  }
  if (!categories.includes(opts.category)) {
    fail(`--category must be one of: ${categories.join(', ')}`);
    return;
  }
  const probability = Number(opts.probability);
  const impact = Number(opts.impact);
  if (!Number.isInteger(probability) || probability < 1 || probability > 5 || !Number.isInteger(impact) || impact < 1 || impact > 5) {
    fail('--probability and --impact must be integers between 1 and 5.');
    return;
  }
  const { recordRisk } = await import('../governance/provenance-ledgers.js');
  const projectPath = resolveProjectPath(pathArg);
  const created = await recordRisk(projectPath, {
    title: opts.title,
    description: opts.description,
    category: opts.category as RiskCategory,
    probability,
    impact,
    mitigationPlan: opts.mitigation,
    owner: opts.owner,
  });
  if (!created) {
    fail('could not record risk — Build Memory is unreachable.');
    return;
  }
  console.log(chalk.green(`\n✓ recorded risk (severity ${created.severity_score}): ${created.title}`));
}

async function cmdRiskList(pathArg: string, opts: { status?: string }): Promise<void> {
  const { listRisks, formatRiskRegister } = await import('../governance/provenance-ledgers.js');
  const projectPath = resolveProjectPath(pathArg);
  const list = await listRisks(projectPath, opts.status as RiskStatus | undefined);
  console.log(chalk.bold(`\nFORGE Risk Register — ${basename(projectPath)}\n`));
  console.log(formatRiskRegister(list ?? []));
  console.log('');
}

async function cmdRiskStatus(id: string, opts: { status?: string }): Promise<void> {
  const statuses = ['open', 'mitigating', 'accepted', 'closed', 'realized'];
  if (!opts.status || !statuses.includes(opts.status)) {
    fail(`risk status requires --status <${statuses.join('|')}>.`);
    return;
  }
  const { updateRiskStatus } = await import('../governance/provenance-ledgers.js');
  const updated = await updateRiskStatus(id, opts.status as RiskStatus);
  if (!updated) {
    fail(`no risk found with id '${id}', or Build Memory is unreachable.`);
    return;
  }
  console.log(chalk.green(`\n✓ risk ${id} marked ${updated.status}`));
}

/**
 * `forge techdebt` — the tech-debt ledger (`src/governance/provenance-ledgers.ts`). `add` records
 * a manual item; `seed` populates it from real findings FORGE already recorded (dead code, schema
 * drift, dependency audit, adversary review); `resolve` closes an item; `list` prints the ledger.
 */
async function cmdTechDebtAdd(
  pathArg: string,
  opts: { title?: string; description?: string; category?: string; severity?: string; effort?: string; file?: string }
): Promise<void> {
  const categories = ['code_quality', 'architecture', 'test_coverage', 'security', 'performance', 'documentation', 'dependency', 'dead_code', 'schema_drift'];
  const severities = ['low', 'medium', 'high', 'critical'];
  if (!opts.title || !opts.description || !opts.category || !opts.severity) {
    fail('techdebt add requires --title, --description, --category, and --severity.');
    return;
  }
  if (!categories.includes(opts.category)) {
    fail(`--category must be one of: ${categories.join(', ')}`);
    return;
  }
  if (!severities.includes(opts.severity)) {
    fail(`--severity must be one of: ${severities.join(', ')}`);
    return;
  }
  const { recordTechDebtItem } = await import('../governance/provenance-ledgers.js');
  const projectPath = resolveProjectPath(pathArg);
  const created = await recordTechDebtItem(projectPath, {
    title: opts.title,
    description: opts.description,
    category: opts.category as TechDebtCategory,
    severity: opts.severity as TechDebtSeverity,
    effortEstimate: opts.effort as TechDebtItem['effort_estimate'] | undefined,
    filePath: opts.file,
  });
  if (!created) {
    fail('could not record tech-debt item — Build Memory is unreachable.');
    return;
  }
  console.log(chalk.green(`\n✓ recorded tech debt [${created.severity}]: ${created.title}`));
}

async function cmdTechDebtList(pathArg: string, opts: { status?: string }): Promise<void> {
  const { listTechDebt, formatTechDebtLedger } = await import('../governance/provenance-ledgers.js');
  const projectPath = resolveProjectPath(pathArg);
  const list = await listTechDebt(projectPath, opts.status as TechDebtItem['status'] | undefined);
  console.log(chalk.bold(`\nFORGE Tech-Debt Ledger — ${basename(projectPath)}\n`));
  console.log(formatTechDebtLedger(list ?? []));
  console.log('');
}

async function cmdTechDebtResolve(id: string, opts: { build?: string }): Promise<void> {
  const { resolveTechDebtItem } = await import('../governance/provenance-ledgers.js');
  const updated = await resolveTechDebtItem(id, opts.build);
  if (!updated) {
    fail(`no tech-debt item found with id '${id}', or Build Memory is unreachable.`);
    return;
  }
  console.log(chalk.green(`\n✓ tech debt ${id} marked resolved`));
}

async function cmdTechDebtSeed(pathArg: string): Promise<void> {
  const { seedTechDebtFromFindings } = await import('../governance/provenance-ledgers.js');
  const projectPath = resolveProjectPath(pathArg);
  const result = await seedTechDebtFromFindings(projectPath);
  console.log(chalk.bold(`\nSeeding tech-debt ledger from recorded findings — ${basename(projectPath)}\n`));
  console.log(`  scanned: ${result.scanned}  ·  newly seeded: ${result.seeded}  ·  already ledgered: ${result.alreadyLedgered}`);
  for (const [source, count] of Object.entries(result.bySource)) {
    if (count > 0) console.log(chalk.dim(`    ${source}: ${count}`));
  }
  console.log('');
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
// `forge orchestrate <project>` — native TS multi-queue orchestrator
// ---------------------------------------------------------------------------

/**
 * `forge orchestrate <project>` — run a project's full `library-manifest.yaml` to completion (or
 * as far as it can go) via {@link OrchestratorEngine}. Layer 2 of the three-layer architecture
 * (`library/<project>/*.yaml` → manifest → `forge build --use-existing-queue` per queue).
 */
async function cmdOrchestrate(
  project: string,
  opts: {
    libraryPath?: string;
    projectPath?: string;
    dryRun?: boolean;
    skipTo?: string;
    only?: string;
    reset?: boolean;
  }
): Promise<void> {
  const forgeBase = resolve(opts.libraryPath ?? DEFAULT_LIBRARY_BASE_PATH);
  const libraryPath = join(forgeBase, 'library');
  const projectPath = join(forgeBase, 'projects', project);
  // --project-path is the project's OWN repo (governance *.md docs are synced FROM here into
  // the FORGE projects folder before every queue run — DIRECTIVE-016). It must never equal
  // `projectPath` (the FORGE-side sync destination) — a self-copy of every .md file would be
  // wasted work at best and a same-path copy error at worst — so an omitted flag falls back to
  // cwd (with a loud warning) rather than silently reusing the destination as the source.
  let governanceSyncPath: string;
  if (opts.projectPath) {
    governanceSyncPath = resolve(opts.projectPath);
  } else {
    governanceSyncPath = process.cwd();
    process.stdout.write(
      `${tsPrefix('WARN')} ${chalk.yellow(`--project-path not given — defaulting governance sync source to cwd (${governanceSyncPath}).`)}\n`
    );
  }

  const options: OrchestratorOptions = {
    project,
    libraryPath,
    projectPath,
    dryRun: opts.dryRun ?? false,
    skipTo: opts.skipTo ?? null,
    only: opts.only ?? null,
    resetStatus: opts.reset ?? false,
    governanceSyncPath,
  };

  const manifestPath = join(libraryPath, project, 'library-manifest.yaml');
  let manifest: LibraryManifest;
  try {
    manifest = createManifestResolver().load(manifestPath);
  } catch (error) {
    fail(`could not load manifest "${manifestPath}" — ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const estimatedHours = manifest.queues
    .filter((q) => q.status !== QueueStatus.COMPLETE && q.status !== QueueStatus.SKIPPED)
    .reduce((sum, q) => sum + q.estimatedHours, 0);
  process.stdout.write(
    `${tsPrefix('INFO')} [ORCHESTRATOR] project=${project} queuesFound=${manifest.queues.length} ` +
      `estimatedTotalHours=${estimatedHours}${opts.dryRun ? ' (dry run)' : ''}\n`
  );
  process.stdout.write(
    `${tsPrefix('INFO')} [ORCHESTRATOR] library=${libraryPath}  target=${projectPath}  governanceSync=${governanceSyncPath}\n`
  );

  const engine = createOrchestratorEngine();
  let result: OrchestratorResult;
  try {
    result = await engine.run(options);
  } catch (error) {
    fail(`orchestrator run failed — ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  console.log(
    `\n  manifest ${chalk.bold(result.manifestId)} — ` +
      `${chalk.green(String(result.queuesComplete) + ' complete')}, ` +
      `${chalk.red(String(result.queuesFailed) + ' failed')}, ${result.queuesRun} run — ` +
      `${(result.totalDurationMs / 1000).toFixed(1)}s`
  );
  if (result.queuesFailed > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// `forge library` — inspect/manage a project's queue library
// ---------------------------------------------------------------------------

/** `forge library list <project>` — every queue file in the library, with its manifest status if any. */
async function cmdLibraryList(project: string, opts: { libraryPath?: string }): Promise<void> {
  const baseDir = resolve(opts.libraryPath ?? DEFAULT_LIBRARY_BASE_PATH);
  const lm = createLibraryManager();
  const libPath = lm.getLibraryPath(baseDir, project);
  const files = lm.listQueues(libPath);

  if (files.length === 0) {
    console.log(chalk.yellow(`\nNo queue-*.yaml files found in ${libPath}.`));
    return;
  }

  let manifest: LibraryManifest | null = null;
  try {
    manifest = createManifestResolver().load(join(libPath, 'library-manifest.yaml'));
  } catch {
    manifest = null;
  }

  console.log(chalk.bold(`\n${files.length} queue file(s) in ${libPath}:`));
  for (const file of files) {
    const entry = manifest?.queues.find((q) => q.file === file);
    if (entry) {
      console.log(
        `  ${statusChip(entry.status).padEnd(20, ' ')} ${file}  ` +
          chalk.dim(`(${entry.id}, priority ${entry.priority}, depends on: ${entry.dependsOn.join(', ') || '(none)'})`)
      );
    } else {
      console.log(`  ${chalk.dim('(no manifest entry)').padEnd(29, ' ')} ${file}`);
    }
  }
  if (!manifest) {
    console.log(chalk.yellow(`\nNo library-manifest.yaml found — statuses unavailable. Run \`forge library scaffold ${project}\`.`));
  }
}

/** Count the `prompts:` entries in a queue YAML file. Best-effort — 0 on any read/parse failure. */
function countQueuePrompts(queueFilePath: string): number {
  try {
    const doc = parseYaml(readFileSync(queueFilePath, 'utf8')) as { prompts?: unknown[] } | null;
    return doc && Array.isArray(doc.prompts) ? doc.prompts.length : 0;
  } catch {
    return 0;
  }
}

/** `forge library add <project> <queue-file>` — validate a queue YAML, then register it in the manifest. */
async function cmdLibraryAdd(
  project: string,
  queueFile: string,
  opts: {
    libraryPath?: string;
    id?: string;
    description?: string;
    dependsOn?: string;
    estimatedHours?: string;
    priority?: string;
  }
): Promise<void> {
  const baseDir = resolve(opts.libraryPath ?? DEFAULT_LIBRARY_BASE_PATH);
  const lm = createLibraryManager();
  const libPath = lm.getLibraryPath(baseDir, project);
  lm.ensureLibraryExists(libPath);

  let resolvedQueuePath: string;
  try {
    resolvedQueuePath = lm.getQueueFilePath(libPath, queueFile);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const validationErrors = lm.validateQueueYaml(resolvedQueuePath);
  if (validationErrors.length > 0) {
    fail(`Queue YAML validation failed for "${queueFile}" — not added to the manifest:`);
    for (const e of validationErrors) console.error(chalk.red(`    • ${e}`));
    return;
  }

  const manifestPath = join(libPath, 'library-manifest.yaml');
  if (!existsSync(manifestPath)) {
    fail(`No library-manifest.yaml at ${manifestPath}. Run \`forge library scaffold ${project}\` first.`);
    return;
  }

  const id = opts.id ?? basename(queueFile).replace(/\.ya?ml$/i, '');
  const dependsOn = opts.dependsOn
    ? opts.dependsOn.split(',').map((s) => s.trim()).filter((s) => s !== '')
    : [];

  try {
    lm.addQueueToManifest(manifestPath, {
      id,
      file: basename(resolvedQueuePath),
      description: opts.description ?? `Queue ${id}`,
      status: QueueStatus.PENDING,
      dependsOn,
      promptCount: countQueuePrompts(resolvedQueuePath),
      estimatedHours: opts.estimatedHours ? Number.parseFloat(opts.estimatedHours) : 0,
      priority: opts.priority ? Number.parseInt(opts.priority, 10) : 1,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  console.log(chalk.green(`\n✔ added queue "${id}" (${basename(resolvedQueuePath)}) to ${manifestPath}`));
}

/** `forge library validate <project>` — run `validateQueueYaml` over every queue file, report errors. */
async function cmdLibraryValidate(project: string, opts: { libraryPath?: string }): Promise<void> {
  const baseDir = resolve(opts.libraryPath ?? DEFAULT_LIBRARY_BASE_PATH);
  const lm = createLibraryManager();
  const libPath = lm.getLibraryPath(baseDir, project);
  const files = lm.listQueues(libPath);

  if (files.length === 0) {
    console.log(chalk.yellow(`\nNo queue-*.yaml files found in ${libPath}.`));
    return;
  }

  console.log(chalk.bold(`\nValidating ${files.length} queue file(s) in ${libPath}:`));
  let totalErrors = 0;
  for (const file of files) {
    const errs = lm.validateQueueYaml(join(libPath, file));
    if (errs.length === 0) {
      console.log(`  ${chalk.green('✔')} ${file}`);
    } else {
      totalErrors += errs.length;
      console.log(`  ${chalk.red('✖')} ${file}`);
      for (const e of errs) console.log(chalk.red(`      • ${e}`));
    }
  }
  console.log(
    totalErrors === 0
      ? chalk.green(`\n✔ all ${files.length} queue file(s) valid.`)
      : chalk.red(`\n✖ ${totalErrors} problem(s) found.`)
  );
  if (totalErrors > 0) process.exitCode = 1;
}

/** `forge library scaffold <project>` — write a starter `library-manifest.yaml` (no-op if one exists). */
async function cmdLibraryScaffold(project: string, opts: { libraryPath?: string }): Promise<void> {
  const baseDir = resolve(opts.libraryPath ?? DEFAULT_LIBRARY_BASE_PATH);
  const lm = createLibraryManager();
  const libPath = lm.getLibraryPath(baseDir, project);
  const manifestPath = join(libPath, 'library-manifest.yaml');
  const existedBefore = existsSync(manifestPath);

  lm.scaffoldManifest(libPath, project);

  if (existedBefore) {
    console.log(chalk.yellow(`\nlibrary-manifest.yaml already exists at ${manifestPath} — left untouched.`));
  } else {
    console.log(chalk.green(`\n✔ scaffolded starter manifest for "${project}" at ${manifestPath}`));
  }
}

// ---------------------------------------------------------------------------
// `forge sentinel report|history|threshold` — System 5 (Sentinel Prime) diagnostics
// ---------------------------------------------------------------------------

/** Row shape read back from `sentinel_prime_runs` for the diagnostics commands below. */
interface SentinelPrimeRunRow {
  id: string;
  build_run_id: string;
  prompt_id: string;
  prompt_index: number;
  execution_monitor_result: string;
  decision_validator_result: string;
  governance_enforcer_result: string;
  composite_confidence: number;
  halt_triggered: number;
  halt_reason: string | null;
  created_at: string;
}

/** `forge sentinel report --build-run-id <id>` — full per-prompt diagnostic for one build. */
async function cmdSentinelReport(opts: { buildRunId?: string }): Promise<void> {
  if (!opts.buildRunId) {
    fail('--build-run-id is required.');
    return;
  }
  const db = BuildMemory.getClient();
  if (!db) {
    fail('Build Memory is unreachable — cannot read sentinel_prime_runs.');
    return;
  }

  const rows = db
    .prepare(
      `SELECT id, build_run_id, prompt_id, prompt_index, execution_monitor_result,
              decision_validator_result, governance_enforcer_result, composite_confidence,
              halt_triggered, halt_reason, created_at
       FROM sentinel_prime_runs
       WHERE build_run_id = ?
       ORDER BY prompt_index ASC, created_at ASC`
    )
    .all(opts.buildRunId) as SentinelPrimeRunRow[];

  if (rows.length === 0) {
    console.log(chalk.yellow(`\nNo sentinel_prime_runs found for build ${opts.buildRunId}.`));
    return;
  }

  console.log(chalk.bold(`\nSentinel Prime report — build ${opts.buildRunId} (${rows.length} run(s)):`));
  for (const row of rows) {
    const execResult = fromJsonText<ExecutionMonitorResult | null>(row.execution_monitor_result, null);
    const validationResult = fromJsonText<ValidationResult | null>(row.decision_validator_result, null);
    const governanceResult = fromJsonText<GovernanceEnforcerResult | null>(row.governance_enforcer_result, null);
    const halted = fromSqliteBool(row.halt_triggered);

    console.log(
      `\n  [prompt ${row.prompt_index}] ${row.prompt_id}  ` +
        `confidence=${chalk.cyan(row.composite_confidence.toFixed(2))}  halt=${halted ? chalk.red('true') : chalk.green('false')}`
    );
    if (halted && row.halt_reason) console.log(chalk.red(`    halt reason: ${row.halt_reason}`));
    if (execResult) {
      console.log(
        `    execution:  passed=${execResult.passed} violations=${execResult.violations.length} ` +
          `exitCode=${execResult.exitCode ?? '—'} durationMs=${execResult.durationMs}`
      );
      if (execResult.outOfScopeWrites.length > 0) {
        console.log(chalk.yellow(`      out-of-scope writes: ${execResult.outOfScopeWrites.join(', ')}`));
      }
      if (execResult.unexpectedDeletions.length > 0) {
        console.log(chalk.yellow(`      unexpected deletions: ${execResult.unexpectedDeletions.join(', ')}`));
      }
    }
    if (validationResult) {
      console.log(
        `    validation: intentFulfillmentScore=${validationResult.intentFulfillmentScore.toFixed(2)} ` +
          `gatePassed=${validationResult.gatePassed}`
      );
      if (validationResult.gaps.length > 0) console.log(chalk.yellow(`      gaps: ${validationResult.gaps.join('; ')}`));
    }
    if (governanceResult) {
      console.log(
        `    governance: passed=${governanceResult.passed} contractViolations=${governanceResult.contractViolations.length}`
      );
      if (governanceResult.contractViolations.length > 0) {
        console.log(chalk.red(`      violations: ${governanceResult.contractViolations.join('; ')}`));
      }
    }
    console.log(chalk.dim(`    created: ${row.created_at}`));
  }
}

/** `forge sentinel history --project <path> --limit <n>` — last N Sentinel Prime runs for a project. */
async function cmdSentinelHistory(opts: { project?: string; limit?: string }): Promise<void> {
  if (!opts.project) {
    fail('--project <path> is required.');
    return;
  }
  const projectPath = resolveProjectPath(opts.project);
  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : 20;
  if (!Number.isInteger(limit) || limit < 1) {
    fail('--limit must be a positive integer.');
    return;
  }

  const db = BuildMemory.getClient();
  if (!db) {
    fail('Build Memory is unreachable — cannot read sentinel_prime_runs.');
    return;
  }

  const rows = db
    .prepare(
      `SELECT spr.id, spr.build_run_id, spr.prompt_id, spr.prompt_index, spr.composite_confidence,
              spr.halt_triggered, spr.halt_reason, spr.created_at
       FROM sentinel_prime_runs spr
       JOIN build_runs br ON br.id = spr.build_run_id
       WHERE br.project_path = ?
       ORDER BY spr.created_at DESC
       LIMIT ?`
    )
    .all(projectPath, limit) as Array<{
    id: string;
    build_run_id: string;
    prompt_id: string;
    prompt_index: number;
    composite_confidence: number;
    halt_triggered: number;
    halt_reason: string | null;
    created_at: string;
  }>;

  if (rows.length === 0) {
    console.log(chalk.yellow(`\nNo sentinel_prime_runs found for project ${projectPath}.`));
    return;
  }

  console.log(chalk.bold(`\n${rows.length} Sentinel Prime run(s) for ${projectPath}:`));
  for (const row of rows) {
    const halted = fromSqliteBool(row.halt_triggered);
    console.log(
      `  ${chalk.dim(row.created_at.slice(0, 19).replace('T', ' '))}  ` +
        `build ${row.build_run_id.slice(0, 8)}  prompt ${String(row.prompt_index).padStart(3, ' ')}  ` +
        `confidence ${chalk.cyan(row.composite_confidence.toFixed(2))}  ` +
        `${halted ? chalk.red('HALT') : chalk.green('ok')}` +
        `${halted && row.halt_reason ? chalk.dim(` — ${row.halt_reason}`) : ''}`
    );
  }
}

/** Build Memory `forge_meta` key the Sentinel Prime halt threshold override is stored under. */
const SENTINEL_THRESHOLD_META_KEY = 'sentinel_halt_threshold';

/** `forge sentinel threshold [--set <value>]` — get, or persist, the halt threshold in Build Memory. */
async function cmdSentinelThreshold(opts: { set?: string }): Promise<void> {
  const db = BuildMemory.getClient();
  if (!db) {
    fail('Build Memory is unreachable — cannot read/write the sentinel halt threshold.');
    return;
  }

  if (opts.set === undefined) {
    const row = db.prepare('SELECT value FROM forge_meta WHERE key = ?').get(SENTINEL_THRESHOLD_META_KEY) as
      | { value: string }
      | undefined;
    console.log(
      row
        ? `\nSentinel Prime halt threshold override: ${chalk.cyan(row.value)}`
        : chalk.yellow('\nNo threshold override set — Sentinel Prime uses its built-in default (0.4).')
    );
    return;
  }

  const value = Number.parseFloat(opts.set);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail('--set must be a number between 0.0 and 1.0.');
    return;
  }

  db.prepare('INSERT OR REPLACE INTO forge_meta (key, value) VALUES (?, ?)').run(
    SENTINEL_THRESHOLD_META_KEY,
    String(value)
  );
  console.log(chalk.green(`\n✔ sentinel halt threshold set to ${value}`));
}

// ---------------------------------------------------------------------------
// `forge skills list|show|inject|add` — stack-detected skills library diagnostics
// ---------------------------------------------------------------------------

/**
 * Print one line in the `[yyyy-MM-dd HH:mm:ss] [LEVEL]` format (FORGE 1.0 parity, matching
 * {@link tsPrefix}/{@link withSpinner}) — every status/summary line `forge skills` prints uses
 * this, per the command's spec. Raw file/prompt CONTENT the subcommands display (a skill's
 * template body, an assembled prompt) is printed verbatim below a banner line instead, since
 * prefixing every line of that content would corrupt it for the debugging use case it exists for.
 */
function skillsLog(level: 'INFO' | 'WARN' | 'PASS' | 'FAIL', message: string): void {
  process.stdout.write(`${tsPrefix(level)} ${message}\n`);
}

/** Mark `forge skills` as failed: one `[FAIL]`-prefixed line, structured-logged, non-zero exit. */
function skillsFail(message: string): void {
  skillsLog('FAIL', message);
  getLogger('cli').error(message);
  process.exitCode = 1;
}

/** `forge skills list <project-path>` — detect the stack, list every skill that would be injected. */
async function cmdSkillsList(pathArg: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  skillsLog('INFO', `forge skills list — ${projectPath}`);

  const stack = detectProjectStack(projectPath);
  if (stack.length === 0) {
    skillsLog('WARN', 'no stack detected (missing/unreadable package.json, or no dependency matches a known technology) — no skills would be injected.');
    return;
  }
  skillsLog('INFO', `detected stack: ${stack.join(', ')}`);

  const skillsDir = defaultSkillsLibraryDir();
  const library = loadSkillsLibrary(skillsDir);
  if (library.skills.length === 0) {
    skillsLog('WARN', `no skill templates found under ${skillsDir} — nothing would be injected.`);
    return;
  }

  const matching = library.getByTags(stack);
  if (matching.length === 0) {
    skillsLog('WARN', `${library.skills.length} skill(s) loaded from ${skillsDir}, but none match this stack's tags.`);
    return;
  }

  skillsLog('PASS', `${matching.length}/${library.skills.length} skill(s) would be injected for this project:`);
  for (const s of matching) {
    skillsLog(
      'INFO',
      `  ${s.id}  (${s.domain})  tags=[${s.tags.join(', ')}]  applicablePromptTypes=[${s.applicablePromptTypes.join(', ') || 'any'}]`
    );
  }
}

/** `forge skills show <skill-id>` — print one skill's full template content. */
async function cmdSkillsShow(skillId: string): Promise<void> {
  const skillsDir = defaultSkillsLibraryDir();
  const library = loadSkillsLibrary(skillsDir);
  const skill = library.skills.find((s) => s.id === skillId);
  if (!skill) {
    const available = library.skills.map((s) => s.id).join(', ') || '(none loaded)';
    skillsFail(`no skill "${skillId}" found under ${skillsDir}. Available: ${available}`);
    return;
  }

  skillsLog('PASS', `${skill.id} — ${skill.name} (${skill.domain})`);
  skillsLog('INFO', `tags: ${skill.tags.join(', ') || '(none)'}`);
  skillsLog('INFO', `applicablePromptTypes: ${skill.applicablePromptTypes.join(', ') || '(any)'}`);
  console.log('\n--- BEGIN TEMPLATE CONTENT ---\n');
  console.log(skill.template);
  console.log('\n--- END TEMPLATE CONTENT ---');
}

/** `forge skills inject <project-path> <prompt-text>` — show the full prompt with skills injected, for debugging. */
async function cmdSkillsInject(pathArg: string, promptText: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  skillsLog('INFO', `forge skills inject — ${projectPath}`);

  const stack = detectProjectStack(projectPath);
  skillsLog(
    'INFO',
    stack.length > 0 ? `detected stack: ${stack.join(', ')}` : 'no stack detected — prompt will be sent unmodified.'
  );

  const injected = buildSkillsContext(projectPath, promptText);
  const wasInjected = injected !== promptText;
  skillsLog(
    wasInjected ? 'PASS' : 'WARN',
    wasInjected ? 'skills matched — full assembled prompt (as sent to Claude Code) follows:' : 'no skills matched — prompt is unmodified:'
  );
  console.log('\n--- BEGIN ASSEMBLED PROMPT ---\n');
  console.log(injected);
  console.log('\n--- END ASSEMBLED PROMPT ---');
}

/** `forge skills add <skill-file>` — validate a `*.skill.md` file, then copy it into the skills library. */
async function cmdSkillsAdd(skillFile: string): Promise<void> {
  const sourcePath = resolve(skillFile);
  let raw: string;
  try {
    raw = readFileSync(sourcePath, 'utf8');
  } catch (error) {
    skillsFail(`could not read "${sourcePath}": ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const fallbackId = basename(sourcePath).replace(/\.skill\.md$/i, '').replace(/\.md$/i, '');
  const validation = validateSkillFile(raw, fallbackId);
  if (!validation.valid || !validation.skill) {
    skillsFail(`"${sourcePath}" is not a valid skill template:`);
    for (const e of validation.errors) console.error(chalk.red(`    • ${e}`));
    return;
  }

  const skillsDir = defaultSkillsLibraryDir();
  const destPath = join(skillsDir, `${validation.skill.id}.skill.md`);
  const replacing = existsSync(destPath);

  try {
    mkdirSync(skillsDir, { recursive: true });
    copyFileSync(sourcePath, destPath);
  } catch (error) {
    skillsFail(`could not copy to "${destPath}": ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  skillsLog('PASS', `${replacing ? 'replaced' : 'added'} skill "${validation.skill.id}" → ${destPath}`);
  skillsLog(
    'INFO',
    `domain=${validation.skill.domain}  tags=[${validation.skill.tags.join(', ')}]  applicablePromptTypes=[${validation.skill.applicablePromptTypes.join(', ') || 'any'}]`
  );
}

// ---------------------------------------------------------------------------
// `forge design component|tokens|storybook|audit|install-shadcn` — UI Engine (src/ui-engine/)
// ---------------------------------------------------------------------------

/** `[yyyy-MM-dd HH:mm:ss] [LEVEL]`-prefixed line for the `forge design` command family (matches {@link skillsLog}). */
function designLog(level: 'INFO' | 'WARN' | 'PASS' | 'FAIL', message: string): void {
  process.stdout.write(`${tsPrefix(level)} ${message}\n`);
}

/** Mark `forge design` as failed: one `[FAIL]`-prefixed line, structured-logged, non-zero exit. */
function designFail(message: string): void {
  designLog('FAIL', message);
  getLogger('cli').error(message);
  process.exitCode = 1;
}

/**
 * `forge design component <project-path> <component-name> --description <text> --props <comma-list>`
 * — generates one production-grade component via {@link UIComponentGenerator} (skill-informed,
 * shadcn-aware install, matching story + test written alongside), tagged with fresh synthetic
 * `buildRunId`/`promptId` values since this command runs outside any real Phase 3 build.
 */
async function cmdDesignComponent(
  pathArg: string,
  componentName: string,
  opts: { description?: string; props?: string }
): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  const { description } = opts;
  if (!description) {
    designFail('forge design component requires --description "<text>".');
    return;
  }

  const props = (opts.props ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const spec: ComponentSpec = {
    name: componentName,
    description,
    props,
    dataSource: null,
    interactions: [],
    accessibility: [],
  };

  designLog('INFO', `forge design component — generating '${componentName}' in ${projectPath}`);
  const buildRunId = randomUUID();
  const promptId = randomUUID();

  try {
    const result = await withSpinner(`UI Engine — generate '${componentName}'`, () =>
      new UIComponentGenerator().generate(spec, projectPath, buildRunId, promptId)
    );
    designLog('PASS', `component '${componentName}' generated → ${result.filePath}`);
  } catch (error) {
    designFail(`forge design component failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * `forge design tokens <project-path>` — runs {@link ensureDesignTokens} and reports whether
 * tailwind.config.ts/globals.css were newly written or already present (checked before/after,
 * since `ensureDesignTokens` itself never overwrites an existing config).
 */
async function cmdDesignTokens(pathArg: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  designLog('INFO', `forge design tokens — ${projectPath}`);

  const tailwindConfigCandidates = [join(projectPath, 'tailwind.config.ts'), join(projectPath, 'tailwind.config.js')];
  const globalsCssCandidates = [
    join(projectPath, 'src', 'app', 'globals.css'),
    join(projectPath, 'app', 'globals.css'),
    join(projectPath, 'src', 'styles', 'globals.css'),
    join(projectPath, 'styles', 'globals.css'),
  ];
  const tailwindExistedBefore = tailwindConfigCandidates.some((p) => existsSync(p));
  const globalsExistedBefore = globalsCssCandidates.some((p) => existsSync(p));

  await withSpinner('UI Engine — design tokens', () => ensureDesignTokens(projectPath));

  const tailwindPath = tailwindConfigCandidates.find((p) => existsSync(p)) ?? tailwindConfigCandidates[0]!;
  const globalsPath = globalsCssCandidates.find((p) => existsSync(p)) ?? globalsCssCandidates[0]!;

  designLog(
    tailwindExistedBefore ? 'INFO' : 'PASS',
    tailwindExistedBefore
      ? `tailwind.config already present — left untouched (${tailwindPath})`
      : `tailwind.config.ts written → ${tailwindPath}`
  );
  designLog(
    globalsExistedBefore ? 'INFO' : 'PASS',
    globalsExistedBefore
      ? `globals.css already present — left untouched (${globalsPath})`
      : `globals.css written → ${globalsPath}`
  );
}

/**
 * `forge design storybook <project-path>` — runs {@link generateStoriesForProject} and prints how
 * many stories were generated vs. skipped (already had a story, or a per-component write failure).
 */
async function cmdDesignStorybook(pathArg: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  designLog('INFO', `forge design storybook — ${projectPath}`);

  const result = await withSpinner('UI Engine — generate Storybook stories', () =>
    generateStoriesForProject(projectPath)
  );

  designLog('PASS', `${result.generated.length} stor${result.generated.length === 1 ? 'y' : 'ies'} generated`);
  for (const f of result.generated) designLog('INFO', `  generated: ${f}`);
  if (result.skipped.length > 0) {
    designLog('INFO', `${result.skipped.length} skipped (story already exists, or generation failed):`);
    for (const f of result.skipped) designLog('INFO', `  skipped: ${f}`);
  }
}

/**
 * `forge design audit <project-path>` — runs {@link checkProjectAccessibility} over every
 * component and prints a per-component score, every issue with its fix, and an overall pass/fail
 * (fails the command's exit code, matching Contract 13's "any single failure" posture, when any
 * component's report did not pass).
 */
async function cmdDesignAudit(pathArg: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  designLog('INFO', `forge design audit — ${projectPath}`);

  const reports = await withSpinner('UI Engine — accessibility audit', () => checkProjectAccessibility(projectPath));

  if (reports.length === 0) {
    designLog('WARN', 'no components found under src/components/ — nothing to audit.');
    return;
  }

  let overallPass = true;
  for (const report of reports) {
    if (!report.passed) overallPass = false;
    designLog(
      report.passed ? 'PASS' : 'FAIL',
      `${report.filePath} — score ${report.score}/100 (${report.issues.length} issue(s))`
    );
    for (const issue of report.issues) {
      designLog(
        issue.severity === 'error' ? 'FAIL' : 'WARN',
        `  [${issue.rule}] ${issue.description}${issue.element ? ` — ${issue.element}` : ''}`
      );
      designLog('INFO', `    fix: ${issue.fix}`);
    }
  }

  const totalIssues = reports.reduce((sum, r) => sum + r.issues.length, 0);
  designLog(
    overallPass ? 'PASS' : 'FAIL',
    `overall: ${reports.length} component(s) audited, ${totalIssues} issue(s) — ${overallPass ? 'PASS' : 'FAIL'}`
  );
  if (!overallPass) process.exitCode = 1;
}

/**
 * `forge design install-shadcn <project-path> <component-names...>` — installs the listed
 * shadcn/ui components (plus each one's declared dependencies) via {@link ensureComponentsInstalled}.
 */
async function cmdDesignInstallShadcn(pathArg: string, componentNames: string[]): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  if (componentNames.length === 0) {
    designFail('forge design install-shadcn requires at least one component name.');
    return;
  }
  designLog('INFO', `forge design install-shadcn — ${projectPath} — ${componentNames.join(', ')}`);

  const installed = await withSpinner('UI Engine — install shadcn components', () =>
    ensureComponentsInstalled(projectPath, componentNames)
  );

  if (installed.length === 0) {
    designLog('INFO', 'no new components installed (all already present, or all installs failed — see warnings above).');
    return;
  }
  designLog('PASS', `${installed.length} component(s) installed: ${installed.join(', ')}`);
}

/**
 * `forge design screenshot <project-path>` — discovers every App Router route and captures it at
 * every default viewport via {@link PlaywrightScreenshotter.captureAllRoutes}, writing PNGs under
 * the resolved design-storage path ({@link getDesignStoragePath}, env override → external drive
 * with >100GB free → local fallback) and printing every file path captured. Runs outside any real
 * Phase 3 build, so `buildRunId`/`promptId` are fresh synthetic values (matching
 * {@link cmdDesignComponent}'s own precedent for a standalone `forge design` invocation).
 */
async function cmdDesignScreenshot(pathArg: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  designLog('INFO', `forge design screenshot — ${projectPath}`);

  const storageBasePath = getDesignStoragePath();
  ensureStorageDirectories(storageBasePath);

  const buildRunId = randomUUID();
  const promptId = randomUUID();
  const screenshotDir = getScreenshotPath(storageBasePath, buildRunId, promptId);

  const screenshotter = createPlaywrightScreenshotter({ log: (m) => designLog('INFO', m) });
  if (!(await screenshotter.isAvailable())) {
    designFail('forge design screenshot requires the "playwright" package — it is not installed/importable.');
    return;
  }

  const results = await withSpinner('UI Engine — capture all routes', () =>
    screenshotter.captureAllRoutes(projectPath, {
      projectPath,
      buildRunId,
      promptId,
      componentName: 'page',
      storageDir: screenshotDir,
    })
  );

  if (results.length === 0) {
    designLog('WARN', 'no routes captured — check that src/app has page.tsx files and the dev server can start.');
    return;
  }

  for (const shot of results) designLog('PASS', `[${shot.viewport}] ${shot.componentName} → ${shot.filePath}`);
  designLog('PASS', `${results.length} screenshot(s) captured → ${screenshotDir}`);
}

/**
 * `forge design review <project-path> [--non-interactive]` — runs the full {@link DesignPipeline}
 * (screenshot capture → optional Penpot upload → the visual approval gate) over the whole project.
 * `DesignPipeline.run` gates on "did this prompt modify a .tsx file" — there is no modified-files
 * list for a manual, whole-project review, so a synthetic marker is passed purely to satisfy that
 * check (it is never read for any other purpose by `run()`).
 */
async function cmdDesignReview(pathArg: string, opts: { nonInteractive?: boolean }): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  const projectName = basename(projectPath) || 'project';
  designLog('INFO', `forge design review — ${projectPath}`);

  const buildRunId = randomUUID();
  const promptEntry: DesignPipelinePromptEntry = { id: randomUUID(), name: projectName, prompt_type: 'ui' };
  const pipeline = createDesignPipeline({ log: (m) => designLog('INFO', m) });

  const result = await withSpinner('Design Pipeline — full review', () =>
    pipeline.run(promptEntry, projectPath, buildRunId, ['forge-design-review.tsx'], opts.nonInteractive ?? false)
  );

  designLog('INFO', `${result.screenshotPaths.length} screenshot(s) reviewed`);
  for (const p of result.screenshotPaths) designLog('INFO', `  ${p}`);
  if (result.penpotUrl) designLog('INFO', `Penpot: ${result.penpotUrl}`);

  if (result.approved) {
    designLog('PASS', `review APPROVED${result.autoApproved ? ' (auto-approved)' : ''}`);
  } else {
    designLog('FAIL', `review NOT approved${result.feedback ? ` — ${result.feedback}` : ''}`);
    process.exitCode = 1;
  }
}

/**
 * `forge design storage` — prints the resolved design-artifact storage path
 * ({@link getDesignStoragePath}) and its drive's free/total space.
 */
async function cmdDesignStorage(): Promise<void> {
  const storagePath = getDesignStoragePath();
  designLog('INFO', `design storage path: ${storagePath}`);

  const driveRootMatch = /^([A-Za-z]:\\)/.exec(storagePath);
  const root = driveRootMatch ? driveRootMatch[1]! : null;
  if (!root) {
    designLog('WARN', 'could not determine a drive root to check free space for this path.');
    return;
  }

  try {
    const stats = statfsSync(root);
    const freeBytes = stats.bavail * stats.bsize;
    const totalBytes = stats.blocks * stats.bsize;
    const freeGb = (freeBytes / (1024 * 1024 * 1024)).toFixed(1);
    const totalGb = (totalBytes / (1024 * 1024 * 1024)).toFixed(1);
    designLog('PASS', `drive ${root} — ${freeGb}GB free of ${totalGb}GB total`);
  } catch (error) {
    designLog(
      'WARN',
      `could not read free space for '${root}' (${error instanceof Error ? error.message : String(error)})`
    );
  }
}

/**
 * `forge design penpot-setup` — prints a Docker run command for a local Penpot instance (matching
 * `penpot-integration.ts`'s own default `http://localhost:9001`), volume-mounted to the same
 * auto-detected design-storage path ({@link getDesignStoragePath} — env override → external drive
 * with >100GB free → local fallback) every other design-pipeline artifact already uses, so
 * Penpot's persistent data lives alongside FORGE's own screenshots/exports rather than an
 * unconfigured anonymous volume.
 */
function cmdDesignPenpotSetup(): void {
  const storagePath = getDesignStoragePath();
  const dockerVolumePath = storagePath.replace(/\\+$/, '').replace(/\\/g, '/');
  designLog('INFO', `auto-detected design storage path: ${storagePath}`);
  designLog('PASS', 'Docker run command for a local Penpot instance:');
  console.log(
    `\n  docker run -d --name penpot-forge -p 9001:9001 \\\n` +
      `    -v "${dockerVolumePath}:/opt/data" \\\n` +
      `    -e PENPOT_PUBLIC_URI=http://localhost:9001 \\\n` +
      `    penpotapp/penpot-backend:latest\n`
  );
  designLog(
    'INFO',
    'set PENPOT_EMAIL / PENPOT_PASSWORD (env, or `forge vault set <project> PENPOT_EMAIL/PENPOT_PASSWORD`) once running.'
  );
}

/** Row shape read back from `design_reviews` for `forge design history`. */
interface DesignReviewRow {
  id: string;
  build_run_id: string;
  prompt_id: string;
  component_name: string;
  screenshot_path: string | null;
  penpot_file_id: string | null;
  human_approved: number;
  human_feedback: string | null;
  auto_approved: number;
  created_at: string;
}

/**
 * `forge design history <project-path> --limit <n>` — the last N `design_reviews` rows for a
 * project, joined on `build_runs.project_path` (the same join `cmdSentinelHistory` already uses
 * for `sentinel_prime_runs`) — so only reviews tied to a real, recorded build are listed.
 */
async function cmdDesignHistory(pathArg: string, opts: { limit?: string }): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : 20;
  if (!Number.isInteger(limit) || limit < 1) {
    designFail('--limit must be a positive integer.');
    return;
  }

  const db = BuildMemory.getClient();
  if (!db) {
    designFail('Build Memory is unreachable — cannot read design_reviews.');
    return;
  }

  const rows = db
    .prepare(
      `SELECT dr.id, dr.build_run_id, dr.prompt_id, dr.component_name, dr.screenshot_path,
              dr.penpot_file_id, dr.human_approved, dr.human_feedback, dr.auto_approved, dr.created_at
       FROM design_reviews dr
       JOIN build_runs br ON br.id = dr.build_run_id
       WHERE br.project_path = ?
       ORDER BY dr.created_at DESC
       LIMIT ?`
    )
    .all(projectPath, limit) as DesignReviewRow[];

  if (rows.length === 0) {
    designLog('WARN', `no design_reviews found for project ${projectPath}.`);
    return;
  }

  designLog('INFO', `${rows.length} design review(s) for ${projectPath}:`);
  for (const row of rows) {
    const approved = fromSqliteBool(row.human_approved);
    const auto = fromSqliteBool(row.auto_approved);
    designLog(
      approved ? 'PASS' : 'FAIL',
      `${row.created_at.slice(0, 19).replace('T', ' ')}  build ${row.build_run_id.slice(0, 8)}  ` +
        `${row.component_name}  ${approved ? 'approved' : 'not approved'}${auto ? ' (auto)' : ''}` +
        `${row.human_feedback ? ` — ${row.human_feedback}` : ''}`
    );
  }
}

// ---------------------------------------------------------------------------
// forge vault — per-project encrypted credential storage (src/autonomy/credential-vault.ts)
// ---------------------------------------------------------------------------

/** `[yyyy-MM-dd HH:mm:ss] [LEVEL]`-prefixed line for the `forge vault` command family. */
function vaultLog(level: 'INFO' | 'WARN' | 'PASS' | 'FAIL', message: string): void {
  process.stdout.write(`${tsPrefix(level)} ${message}\n`);
}

/** Mark `forge vault` as failed: one `[FAIL]`-prefixed line, structured-logged, non-zero exit. */
function vaultFail(message: string): void {
  vaultLog('FAIL', message);
  getLogger('cli').error(message);
  process.exitCode = 1;
}

/** `forge vault set <project-path> <key> <value>` — encrypt and store one credential. */
async function cmdVaultSet(pathArg: string, key: string, value: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  const ok = await createCredentialVault().set(projectPath, key, value);
  if (!ok) {
    vaultFail(`could not store "${key}" for ${projectPath} — Build Memory unavailable or the write failed.`);
    return;
  }
  vaultLog('PASS', `stored "${key}" for ${projectPath}`);
}

/** `forge vault get <project-path> <key>` — decrypt and print one credential's value. */
async function cmdVaultGet(pathArg: string, key: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  const value = await createCredentialVault().get(projectPath, key);
  if (value === null) {
    vaultFail(`no credential "${key}" found for ${projectPath} (or it could not be decrypted with the current vault key).`);
    return;
  }
  vaultLog('PASS', `${key}=${value}`);
}

/** `forge vault list <project-path>` — list stored credential key names, never values. */
async function cmdVaultList(pathArg: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  const keys = await createCredentialVault().listKeys(projectPath);
  if (keys.length === 0) {
    vaultLog('WARN', `no credentials stored for ${projectPath}`);
    return;
  }
  vaultLog('PASS', `${keys.length} credential(s) stored for ${projectPath}:`);
  for (const k of keys) vaultLog('INFO', `  ${k}`);
}

/** `forge vault inject <project-path>` — append every stored credential to .env.local (never overwrites). */
async function cmdVaultInject(pathArg: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  const count = await createCredentialVault().injectIntoEnv(projectPath);
  const envPath = join(projectPath, '.env.local');
  if (count === 0) {
    vaultLog('WARN', `nothing injected into ${envPath} — no stored credentials, or every stored key is already declared there.`);
    return;
  }
  vaultLog('PASS', `injected ${count} credential(s) into ${envPath}`);
}

/** `forge vault delete <project-path> <key>` — remove one stored credential. */
async function cmdVaultDelete(pathArg: string, key: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  const deleted = await createCredentialVault().delete(projectPath, key);
  if (!deleted) {
    vaultFail(`no credential "${key}" found for ${projectPath} — nothing deleted.`);
    return;
  }
  vaultLog('PASS', `deleted "${key}" for ${projectPath}`);
}

// ---------------------------------------------------------------------------
// forge deploy auto — VercelDeployer + forge verify (src/autonomy/vercel-deployer.ts)
// ---------------------------------------------------------------------------

/** `[yyyy-MM-dd HH:mm:ss] [LEVEL]`-prefixed line for `forge deploy auto`. */
function deployAutoLog(level: 'INFO' | 'WARN' | 'PASS' | 'FAIL', message: string): void {
  process.stdout.write(`${tsPrefix(level)} ${message}\n`);
}

/** Mark `forge deploy auto` as failed: one `[FAIL]`-prefixed line, structured-logged, non-zero exit. */
function deployAutoFail(message: string): void {
  deployAutoLog('FAIL', message);
  getLogger('cli').error(message);
  process.exitCode = 1;
}

/** `forge deploy auto <project-path> --env production|preview` — VercelDeployer.deploy, then forge verify. */
async function cmdDeployAuto(pathArg: string, opts: { env?: string }): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  const environment: 'production' | 'preview' = opts.env === 'production' ? 'production' : 'preview';
  deployAutoLog('INFO', `forge deploy auto — ${projectPath} (${environment})`);

  const deployer = createVercelDeployer();
  const configured = await deployer.isConfigured(projectPath);
  if (!configured) {
    deployAutoFail(
      `${projectPath} is not configured for autonomous Vercel deploy — no VERCEL_TOKEN (env or vault) or no ` +
        `.vercel link. Run \`vercel link\` once, then \`forge vault set ${projectPath} VERCEL_TOKEN <token>\`.`
    );
    return;
  }

  const buildRunId = randomUUID();
  deployAutoLog('INFO', 'uploading project files and creating the Vercel deployment...');
  const result = await deployer.deploy(projectPath, buildRunId, environment);
  if (result.status !== 'ready' || !result.deploymentUrl) {
    deployAutoFail(
      `Vercel deploy did not reach a ready state (status: ${result.status})${result.error ? ` — ${result.error}` : ''}`
    );
    return;
  }
  deployAutoLog('PASS', `Vercel deploy ready — ${result.deploymentUrl}`);

  deployAutoLog('INFO', `running forge verify against ${result.deploymentUrl}`);
  try {
    const { runDeployVerification } = await import('../deploy/verify-runner.js');
    const verifyResult = await runDeployVerification({
      projectPath,
      baseUrl: result.deploymentUrl,
      latencyBudgetMs: DEFAULT_VERIFY_LATENCY_BUDGET_MS,
    });
    for (const r of verifyResult.routes) {
      deployAutoLog(r.verdict === 'PASSED' ? 'PASS' : 'FAIL', `VERIFY: ${r.route} ${r.statusCode ?? 'ERR'} ${r.latencyMs}ms`);
    }
    if (verifyResult.passed) {
      deployAutoLog('PASS', 'post-deploy verification passed.');
    } else {
      deployAutoFail('post-deploy verification found failing routes.');
    }
  } catch (error) {
    deployAutoFail(`post-deploy verification failed to run: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// forge migrate — Supabase Management API migrations (src/autonomy/supabase-migrator.ts)
// ---------------------------------------------------------------------------

/** `[yyyy-MM-dd HH:mm:ss] [LEVEL]`-prefixed line for the `forge migrate` command family. */
function migrateLog(level: 'INFO' | 'WARN' | 'PASS' | 'FAIL', message: string): void {
  process.stdout.write(`${tsPrefix(level)} ${message}\n`);
}

/** Mark `forge migrate` as failed: one `[FAIL]`-prefixed line, structured-logged, non-zero exit. */
function migrateFail(message: string): void {
  migrateLog('FAIL', message);
  getLogger('cli').error(message);
  process.exitCode = 1;
}

/** `forge migrate <project-path>` — apply every pending supabase/migrations/*.sql file, in order. */
async function cmdMigrate(pathArg: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  const migrator = createSupabaseMigrator();
  const configured = await migrator.isConfigured(projectPath);
  if (!configured) {
    migrateFail(
      `${projectPath} is not configured for autonomous migrations — SUPABASE_ACCESS_TOKEN/SUPABASE_PROJECT_ID ` +
        'not resolvable from the environment or the credential vault.'
    );
    return;
  }

  migrateLog('INFO', `applying pending migrations for ${projectPath}`);
  const results = await migrator.applyPendingMigrations(projectPath);
  if (results.length === 0) {
    migrateLog('WARN', 'no migration files found under supabase/migrations/ (or nothing pending).');
    return;
  }

  for (const r of results) {
    const level: 'INFO' | 'PASS' | 'FAIL' = r.status === 'applied' ? 'PASS' : r.status === 'skipped' ? 'INFO' : 'FAIL';
    migrateLog(level, `${r.migrationFile} — ${r.status}${r.error ? `: ${r.error}` : ''} (${r.durationMs}ms)`);
  }

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    migrateFail(`${failed.length}/${results.length} migration(s) failed — later migrations were not attempted.`);
    return;
  }
  migrateLog('PASS', `${results.length} migration(s) processed.`);
}

/** `forge migrate validate <project-path>` — static sanity sweep, never calls the Management API. */
async function cmdMigrateValidate(pathArg: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  migrateLog('INFO', `validating migrations for ${projectPath}`);
  const result = await createSupabaseMigrator().validateMigrations(projectPath);
  migrateLog('INFO', `${result.migrationCount} migration file(s) found.`);
  if (result.valid) {
    migrateLog('PASS', 'all migrations valid.');
    return;
  }
  for (const e of result.errors) migrateLog('FAIL', e);
  migrateFail(`${result.errors.length} validation error(s) found.`);
}

// ---------------------------------------------------------------------------
// forge env check — environment variable validation (src/autonomy/env-validator.ts)
// ---------------------------------------------------------------------------

/** `[yyyy-MM-dd HH:mm:ss] [LEVEL]`-prefixed line for the `forge env` command family. */
function envCheckLog(level: 'INFO' | 'WARN' | 'PASS' | 'FAIL', message: string): void {
  process.stdout.write(`${tsPrefix(level)} ${message}\n`);
}

/** Mark `forge env check` as failed: one `[FAIL]`-prefixed line, structured-logged, non-zero exit. */
function envCheckFail(message: string): void {
  envCheckLog('FAIL', message);
  getLogger('cli').error(message);
  process.exitCode = 1;
}

/** `forge env check <project-path>` — resolve every required env var against process.env / .env.local / the vault, report gaps. */
async function cmdEnvCheck(pathArg: string): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  envCheckLog('INFO', `forge env check — ${projectPath}`);

  const result = await validateEnv(projectPath);
  for (const w of result.warnings) envCheckLog('WARN', w);

  for (const requirement of result.missing) {
    envCheckLog('FAIL', `MISSING: ${requirement.key} - ${requirement.description}`);
    envCheckLog(
      'INFO',
      requirement.canBeVaulted
        ? `  -> forge vault set ${projectPath} ${requirement.key} <value>`
        : `  -> set ${requirement.key} directly in your environment or .env.local`
    );
  }
  for (const entry of result.invalid) {
    envCheckLog('WARN', `INVALID: ${entry.key} - ${entry.reason} (${entry.description})`);
  }

  if (!result.allRequired) {
    envCheckFail(`${result.missing.length} required environment variable(s) missing.`);
    return;
  }
  envCheckLog(
    'PASS',
    result.invalid.length === 0
      ? 'all required environment variables are resolvable.'
      : 'all required environment variables resolvable (see format warnings above).'
  );
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
    logToBuildFile(`Build Memory: SQLite ready at ${getForgeDbPath()} (schema ${getSchemaVersion()})`);
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
    .option(
      '--autonomous-recovery',
      'enable Autonomous Recovery Mode (Contract 14) — self-heals Sentinel FAILURES during Phase 3 by re-running prompts. Does NOT bypass adversary-review BLOCKER findings (use --accept-blockers) or approval gates (use --auto-approve-gates) — those are separate, explicit overrides.',
      false
    )
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
    .option(
      '--accept-blockers',
      'the ONLY override for adversarial-review BLOCKER findings (Phase 1A/1B): proceed instead of halting (writes state/halt-reason.md). Separate from --autonomous-recovery and --auto-approve-gates — neither of those bypasses a BLOCKER halt.',
      false
    )
    .option(
      '--auto-approve-gates',
      'acknowledge the three human-approval gates (Contract 2) without pausing for review. FORGE already proceeds past these gates automatically in autonomous mode (they render as banners, never a real pause) — this flag exists for explicit, logged acknowledgment. Does NOT bypass adversarial-review BLOCKER findings; use --accept-blockers for that.',
      false
    )
    .option(
      '--allow-headless',
      'permit Phase 3 to start with a backgrounded/non-interactive terminal (process.stdout.isTTY false). Without this, FORGE refuses to start Phase 3 at all rather than run claude Code with silent output — a backgrounded run (e.g. Start-Job piping stdin to a spawned claude process) was found to hang for 15+ hours with zero visible output and no error. Pass this ONLY if you will monitor progress via .forge/runs/*.jsonl instead of the terminal.',
      false
    )
    .option(
      '--max-budget-usd <usd>',
      'optional run-wide dollar cap (opt-in). Checked before each Phase 3 prompt starts against the per-prompt cost-estimate tracker; once the accumulated estimate reaches this cap, the build halts cleanly BETWEEN prompts (already-completed work stays merged). Default: no cap.'
    )
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
          acceptBlockers?: boolean;
          autoApproveGates?: boolean;
          allowHeadless?: boolean;
          maxBudgetUsd?: string;
        }
      ) => cmdBuild(pathArg, opts)
    );

  program
    .command('scout')
    .description('Run Phase 0 only (Toolchain Scout): scan + lock the environment')
    .argument('<path>', 'target project directory')
    .action((pathArg: string) => cmdScout(pathArg));

  // `forge design <path> --idea` (Phase 0 + 1 architecture design) also carries the UI Engine
  // subcommand tree (component/tokens/storybook/audit/install-shadcn), matching the `analyze`
  // command's precedent of a parent argument+action alongside nested subcommands on the same
  // Command instance — Commander resolves a subcommand-name match before parsing the parent's
  // own positional argument, so `forge design ./proj --idea "..."` and `forge design component
  // ./proj Foo --description "..."` both route correctly.
  const design = program
    .command('design')
    .description(
      'Run Phase 0 + 1 only (PRD + Architecture; stops at Gate 2), or use a UI Engine / Design ' +
        'Pipeline subcommand (component / tokens / storybook / audit / install-shadcn / screenshot / ' +
        'review / storage / penpot-setup / history)'
    )
    .argument('<path>', 'target project directory')
    .option('--idea <text>', 'raw product idea (generates the PRD)')
    .option('--prd <path>', 'use an existing PRD file instead of generating one')
    .option('--accept-blockers', 'proceed past adversarial-review BLOCKER findings instead of halting', false)
    .action(async (pathArg: string, opts: { idea?: string; prd?: string; acceptBlockers?: boolean }) => {
      await cmdDesign(pathArg, opts);
    });

  design
    .command('component')
    .description("Generate a world-class UI component via the UI Engine (skill-informed, shadcn-aware, story + test)")
    .argument('<project-path>', 'target project directory')
    .argument('<component-name>', 'component name (PascalCase)')
    .requiredOption('--description <text>', 'what the component does and where it is used')
    .option('--props <comma-list>', 'comma-separated prop names', '')
    .action((pathArg: string, componentName: string, opts: { description?: string; props?: string }) =>
      cmdDesignComponent(pathArg, componentName, opts)
    );

  design
    .command('tokens')
    .description('Ensure the project has a world-class default design token set (tailwind.config.ts + globals.css)')
    .argument('<project-path>', 'target project directory')
    .action((pathArg: string) => cmdDesignTokens(pathArg));

  design
    .command('storybook')
    .description('Generate Storybook stories for every component under src/components/ that is missing one')
    .argument('<project-path>', 'target project directory')
    .action((pathArg: string) => cmdDesignStorybook(pathArg));

  design
    .command('audit')
    .description('Run the static WCAG 2.1 AA accessibility checker over every component')
    .argument('<project-path>', 'target project directory')
    .action((pathArg: string) => cmdDesignAudit(pathArg));

  design
    .command('install-shadcn')
    .description('Install the given shadcn/ui components (and their declared dependencies) into the project')
    .argument('<project-path>', 'target project directory')
    .argument('<component-names...>', 'shadcn/ui component names to install')
    .action((pathArg: string, componentNames: string[]) => cmdDesignInstallShadcn(pathArg, componentNames));

  design
    .command('screenshot')
    .description('Capture every discovered App Router route at every default viewport, saving to the design-storage path')
    .argument('<project-path>', 'target project directory')
    .action((pathArg: string) => cmdDesignScreenshot(pathArg));

  design
    .command('review')
    .description('Run the full design pipeline (screenshot capture → optional Penpot upload → review gate) for the whole project')
    .argument('<project-path>', 'target project directory')
    .option('--non-interactive', 'auto-decide via the accessibility-score threshold instead of prompting interactively', false)
    .action((pathArg: string, opts: { nonInteractive?: boolean }) => cmdDesignReview(pathArg, opts));

  design
    .command('storage')
    .description('Show the resolved design-artifact storage path and its available free space')
    .action(() => cmdDesignStorage());

  design
    .command('penpot-setup')
    .description('Print a Docker run command for a local Penpot instance, volume-mounted to the auto-detected design storage path')
    .action(() => cmdDesignPenpotSetup());

  design
    .command('history')
    .description('List the last N design reviews recorded for a project')
    .argument('<project-path>', 'target project directory')
    .option('--limit <n>', 'number of reviews to show', '20')
    .action((pathArg: string, opts: { limit?: string }) => cmdDesignHistory(pathArg, opts));

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
    .description('Show live build status (from .forge/live-status.json, while a build runs) or build history from Build Memory')
    .argument('[build-id]', 'a specific build_runs id (defaults to the most recent build, or the live build if one is running)')
    .option('--project <path>', 'project directory to look for .forge/live-status.json in (default cwd)')
    .option('--watch', 'poll every 2s and re-render (works while a build runs in another window)', false)
    .action((buildId: string | undefined, opts: { project?: string; watch?: boolean }) => cmdStatus(buildId, config, opts));

  program
    .command('dashboard')
    .description(
      'Live, read-only dashboard for the current/most recent build run: tails .forge/runs/<run-id>/{events,prompts,tests}.jsonl and shows the current prompt, elapsed time, gate status, running cost, and recent PASS/FAIL/HALT results. Never writes a file or signals a running build.'
    )
    .argument('[project-path]', 'target project directory', '.')
    .action((pathArg: string) => cmdDashboard(pathArg));

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
    .option('--resume', 'Halt-recovery audit + resume from the exact halt point of the last halted build, instead of a full autopsy rebuild', false)
    .option('--non-interactive', 'With --resume: defer human-gated gaps and halt for human instead of prompting interactively', false)
    .action((pathArg: string, opts: { autonomousRecovery?: boolean; resume?: boolean; nonInteractive?: boolean }) => cmdResurrect(pathArg, opts));

  program
    .command('audit')
    .description('Audit governance-vs-code gaps, score artifact health, regenerate safe gaps, gate architectural ones')
    .argument('<project-path>', 'Absolute path to the project to audit')
    .option('--scope <scope>', 'FULL | GOVERNANCE_ONLY | CODE_ONLY | TARGETED', 'FULL')
    .option('--halt-recovery', 'Reconstruct the exact halt point of the last halted build', false)
    .option('--non-interactive', 'Defer (never auto-approve) human-gated gaps and halt for human', false)
    .option('--api-key <key>', 'Anthropic API key for regeneration drafting')
    .action(
      (p: string, opts: { scope?: string; haltRecovery?: boolean; nonInteractive?: boolean; apiKey?: string }) =>
        cmdAudit(p, opts)
    );

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

  program
    .command('orchestrate')
    .description(
      "Run the native TS orchestrator across a project's full library-manifest.yaml (multi-queue autonomous build)"
    )
    .argument('<project>', 'project name — reads <library-path>/library/<project>/library-manifest.yaml')
    .option('--library-path <path>', 'FORGE base directory containing library/ and projects/ subfolders', DEFAULT_LIBRARY_BASE_PATH)
    .option(
      '--project-path <path>',
      "the project's own repo path — governance *.md docs are synced FROM here into the FORGE projects folder before every queue run (DIRECTIVE-016)"
    )
    .option('--dry-run', 'print the full dependency-resolved execution plan without running anything', false)
    .option('--skip-to <queue-id>', 'mark every queue before this id as SKIPPED, then resume from it')
    .option('--only <queue-id>', 'run exactly this one queue, bypassing dependency resolution')
    .option('--reset', 'reset every COMPLETE queue back to PENDING before running (full re-run)', false)
    .action(
      (
        project: string,
        opts: {
          libraryPath?: string;
          projectPath?: string;
          dryRun?: boolean;
          skipTo?: string;
          only?: string;
          reset?: boolean;
        }
      ) => cmdOrchestrate(project, opts)
    );

  const library = program
    .command('library')
    .description("Manage a project's queue library (list / add / validate / scaffold)");

  library
    .command('list')
    .description('List every queue file in the library, with its manifest status if a manifest exists')
    .argument('<project>', 'project name')
    .option('--library-path <path>', 'FORGE base directory containing the library/ subfolder', DEFAULT_LIBRARY_BASE_PATH)
    .action((project: string, opts: { libraryPath?: string }) => cmdLibraryList(project, opts));

  library
    .command('add')
    .description('Validate a queue YAML file, then register it as a new entry in the manifest')
    .argument('<project>', 'project name')
    .argument('<queue-file>', 'queue YAML file — a filename inside the library, or an absolute path')
    .option('--library-path <path>', 'FORGE base directory containing the library/ subfolder', DEFAULT_LIBRARY_BASE_PATH)
    .option('--id <id>', 'unique queue id (default: the filename without extension)')
    .option('--description <text>', 'human description of the queue')
    .option('--depends-on <ids>', 'comma-separated queue ids that must be COMPLETE before this one can run')
    .option('--estimated-hours <n>', 'estimated hours for display purposes', '0')
    .option('--priority <n>', 'lower runs first when multiple queues are runnable', '1')
    .action(
      (
        project: string,
        queueFile: string,
        opts: {
          libraryPath?: string;
          id?: string;
          description?: string;
          dependsOn?: string;
          estimatedHours?: string;
          priority?: string;
        }
      ) => cmdLibraryAdd(project, queueFile, opts)
    );

  library
    .command('validate')
    .description('Run validateQueueYaml over every queue file in the library and report every error found')
    .argument('<project>', 'project name')
    .option('--library-path <path>', 'FORGE base directory containing the library/ subfolder', DEFAULT_LIBRARY_BASE_PATH)
    .action((project: string, opts: { libraryPath?: string }) => cmdLibraryValidate(project, opts));

  library
    .command('scaffold')
    .description('Create a starter library-manifest.yaml for a new project (no-op if one already exists)')
    .argument('<project>', 'project name')
    .option('--library-path <path>', 'FORGE base directory containing the library/ subfolder', DEFAULT_LIBRARY_BASE_PATH)
    .action((project: string, opts: { libraryPath?: string }) => cmdLibraryScaffold(project, opts));

  const skills = program
    .command('skills')
    .description("Inspect and manage the stack-detected skills library (list / show / inject / add)");

  skills
    .command('list')
    .description("Detect a project's tech stack and list every skill that would be injected into its prompts")
    .argument('<project-path>', 'target project directory')
    .action((pathArg: string) => cmdSkillsList(pathArg));

  skills
    .command('show')
    .description('Print the full template content of one skill')
    .argument('<skill-id>', 'skill id (the frontmatter "id", or the filename without .skill.md)')
    .action((skillId: string) => cmdSkillsShow(skillId));

  skills
    .command('inject')
    .description('Show the full prompt that would be sent to Claude Code with matching skills injected, for debugging')
    .argument('<project-path>', 'target project directory')
    .argument('<prompt-text>', 'the prompt text to inject skills into')
    .action((pathArg: string, promptText: string) => cmdSkillsInject(pathArg, promptText));

  skills
    .command('add')
    .description('Validate a *.skill.md file and copy it into the skills library')
    .argument('<skill-file>', 'path to the skill template file to add')
    .action((skillFile: string) => cmdSkillsAdd(skillFile));

  const vault = program
    .command('vault')
    .description('Per-project AES-256-GCM encrypted credential storage (set / get / list / inject / delete)');

  vault
    .command('set')
    .description('Encrypt and store one credential for a project')
    .argument('<project-path>', 'target project directory')
    .argument('<key>', 'credential key, e.g. VERCEL_TOKEN')
    .argument('<value>', 'credential value to encrypt and store')
    .action((pathArg: string, key: string, value: string) => cmdVaultSet(pathArg, key, value));

  vault
    .command('get')
    .description("Decrypt and print one credential's value")
    .argument('<project-path>', 'target project directory')
    .argument('<key>', 'credential key')
    .action((pathArg: string, key: string) => cmdVaultGet(pathArg, key));

  vault
    .command('list')
    .description('List stored credential key names for a project (values are never printed)')
    .argument('<project-path>', 'target project directory')
    .action((pathArg: string) => cmdVaultList(pathArg));

  vault
    .command('inject')
    .description('Append every stored credential to <project-path>/.env.local — never overwrites an existing key')
    .argument('<project-path>', 'target project directory')
    .action((pathArg: string) => cmdVaultInject(pathArg));

  vault
    .command('delete')
    .description('Remove one stored credential')
    .argument('<project-path>', 'target project directory')
    .argument('<key>', 'credential key')
    .action((pathArg: string, key: string) => cmdVaultDelete(pathArg, key));

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
    .option('--accept-blockers', 'Skip the interactive RECONCILE review and auto-approve all findings without prompting', false)
    .option('--queue-output <path>', 'Override the QUEUE output directory')
    .option('--api-key <key>', 'Anthropic API key for adversarial review')
    .action(async (
      projectPath: string,
      opts: { scope?: string; skipDynamic?: boolean; resume?: boolean; nonInteractive?: boolean; acceptBlockers?: boolean; queueOutput?: string; apiKey?: string }
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
          acceptBlockers: opts.acceptBlockers ?? false,
          queueOutputPath: opts.queueOutput,
          apiKey: opts.apiKey,
        });
      } catch (err: unknown) {
        spinner.fail('RETROFIT failed');
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
    });

  const analyze = program
    .command('analyze')
    .description(
      'Deep analysis: dead code, orphaned routes, schema drift, dependency audit, coverage baseline, GitHub Actions CI'
    )
    .argument('[project-path]', 'Absolute path to the project to analyze — runs all five modules in sequence')
    .action(async (projectPathArg?: string) => {
      if (!projectPathArg) {
        analyze.help();
        return;
      }
      const projectPath = resolveProjectPath(projectPathArg);
      try {
        const { runDeepAnalysis, writeDeepAnalysisReport } = await import('../retrofit/index.js');
        process.stdout.write(`\n${tsPrefix('INFO')} ${chalk.bold(`Deep Analysis — ${projectPath}`)}\n`);
        const report = await withSpinner('Deep Analysis — all 5 modules', () => runDeepAnalysis(projectPath));
        printDeepAnalysisReport(report);
        const reportPath = await writeDeepAnalysisReport(report);
        process.stdout.write(`\n${tsPrefix('PASS')} ${chalk.green(`Full report written to ${reportPath}`)}\n`);
      } catch (err: unknown) {
        fail(`forge analyze failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  analyze
    .command('dead-code')
    .description('Run DeadCodeDetector only')
    .argument('<project-path>', 'Absolute path to the project')
    .action(async (projectPathArg: string) => {
      const projectPath = resolveProjectPath(projectPathArg);
      try {
        const { DeadCodeDetector } = await import('../retrofit/index.js');
        const findings = await withSpinner('Deep Analysis — Dead Code', () => new DeadCodeDetector().detect(projectPath));
        printFindingList(`${findings.length} dead code finding(s)`, findings.map((f) => `${f.filePath}:${f.lineNumber} — ${f.reason}`));
      } catch (err: unknown) {
        fail(`forge analyze dead-code failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  analyze
    .command('routes')
    .description('Run OrphanedRouteDetector only')
    .argument('<project-path>', 'Absolute path to the project')
    .action(async (projectPathArg: string) => {
      const projectPath = resolveProjectPath(projectPathArg);
      try {
        const { OrphanedRouteDetector } = await import('../retrofit/index.js');
        const findings = await withSpinner('Deep Analysis — Orphaned Routes', () => new OrphanedRouteDetector().detect(projectPath));
        printFindingList(
          `${findings.length} orphaned route finding(s)`,
          findings.map((f) => `${f.routePath} (${f.filePath}) — ${f.reason}`)
        );
      } catch (err: unknown) {
        fail(`forge analyze routes failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  analyze
    .command('schema')
    .description('Run SchemaDriftDetector only')
    .argument('<project-path>', 'Absolute path to the project')
    .action(async (projectPathArg: string) => {
      const projectPath = resolveProjectPath(projectPathArg);
      try {
        const { SchemaDriftDetector } = await import('../retrofit/index.js');
        const findings = await withSpinner('Deep Analysis — Schema Drift', () => new SchemaDriftDetector().detect(projectPath));
        printFindingList(`${findings.length} schema drift finding(s)`, findings.map((f) => `[${f.severity}] ${f.tableName} — ${f.detail}`));
      } catch (err: unknown) {
        fail(`forge analyze schema failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  analyze
    .command('deps')
    .description('Run DependencyAuditor only')
    .argument('<project-path>', 'Absolute path to the project')
    .action(async (projectPathArg: string) => {
      const projectPath = resolveProjectPath(projectPathArg);
      try {
        const { DependencyAuditor } = await import('../retrofit/index.js');
        const findings = await withSpinner('Deep Analysis — Dependency Audit', () => new DependencyAuditor().audit(projectPath));
        printFindingList(
          `${findings.length} dependency finding(s)`,
          findings.map((f) => `[${f.findingType}] ${f.packageName} — ${f.detail}`)
        );
      } catch (err: unknown) {
        fail(`forge analyze deps failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  analyze
    .command('coverage')
    .description('Run CoverageBaseline only')
    .argument('<project-path>', 'Absolute path to the project')
    .action(async (projectPathArg: string) => {
      const projectPath = resolveProjectPath(projectPathArg);
      try {
        const { CoverageBaseline } = await import('../retrofit/index.js');
        const findings = await withSpinner('Deep Analysis — Coverage Baseline', () => new CoverageBaseline().analyze(projectPath));
        printFindingList(
          `${findings.length} testable file(s) analyzed`,
          findings.map((f) => `[${f.priority}] ${f.filePath} — ${f.coveragePercent}%${f.hasTestFile ? '' : ' — NO TEST FILE'}`)
        );
      } catch (err: unknown) {
        fail(`forge analyze coverage failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  analyze
    .command('ci')
    .description('Run ensureGitHubActions only (generate/refresh GitHub Actions workflows)')
    .argument('<project-path>', 'Absolute path to the project')
    .action(async (projectPathArg: string) => {
      const projectPath = resolveProjectPath(projectPathArg);
      try {
        const { ensureGitHubActions } = await import('../retrofit/index.js');
        const created = await withSpinner('Deep Analysis — GitHub Actions CI', () => ensureGitHubActions(projectPath));
        if (created.length === 0) {
          console.log(chalk.yellow('\n  no workflow files were written.'));
          return;
        }
        console.log(chalk.bold(`\n  ${created.length} workflow file(s) written:`));
        for (const f of created) console.log(chalk.dim(`    ${f}`));
      } catch (err: unknown) {
        fail(`forge analyze ci failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  const sentinel = program
    .command('sentinel')
    .description('FORGE Sentinel quality pipeline (Ring runner) and System 5 (Sentinel Prime) diagnostics');

  sentinel
    .command('ring')
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

  sentinel
    .command('report')
    .description('Read sentinel_prime_runs for a build and print the full per-prompt diagnostic')
    .requiredOption('--build-run-id <id>', 'the build_runs id to report on')
    .action((opts: { buildRunId?: string }) => cmdSentinelReport(opts));

  sentinel
    .command('history')
    .description('List the last N Sentinel Prime runs for a project, with confidence scores')
    .requiredOption('--project <path>', 'project directory (matches build_runs.project_path)')
    .option('--limit <n>', 'number of runs to show', '20')
    .action((opts: { project?: string; limit?: string }) => cmdSentinelHistory(opts));

  sentinel
    .command('threshold')
    .description('Get, or persist to Build Memory, the Sentinel Prime halt-confidence threshold')
    .option('--set <value>', 'new halt threshold (0.0-1.0) to persist to Build Memory config')
    .action((opts: { set?: string }) => cmdSentinelThreshold(opts));

  const migrate = program
    .command('migrate')
    .description('Apply pending supabase/migrations/*.sql files to the live Supabase project via the Management API')
    .argument('<project-path>', 'target project directory')
    .action((pathArg: string) => cmdMigrate(pathArg));

  migrate
    .command('validate')
    .description('Static sanity sweep over supabase/migrations/*.sql — never calls the Management API')
    .argument('<project-path>', 'target project directory')
    .action((pathArg: string) => cmdMigrateValidate(pathArg));

  const env = program
    .command('env')
    .description("Validate a project's environment variables against FORGE's own catalog and its own .env.example");

  env
    .command('check')
    .description('Resolve every required env var against process.env / .env.local / the credential vault and report gaps')
    .argument('<project-path>', 'target project directory')
    .action((pathArg: string) => cmdEnvCheck(pathArg));

  program
    .command('test')
    .description('Run the FORGE Enterprise Test Suite (TestOrchestrator) against a project')
    .option('--project <path>', 'target project directory (default cwd)')
    .option('--trigger <trigger>', 'post-prompt|pre-deploy|scheduled|manual', 'manual')
    .option('--runners <list>', 'comma-separated: unit,integration,api,e2e,security,performance,dependency', 'unit,integration')
    .action(async (opts: { project?: string; trigger?: string; runners?: string }) => {
      try {
        const { runTests } = await import('../testing/orchestrator.js');
        const { RunnerType, TriggerType } = await import('../testing/types.js');
        const projectPath = resolve(opts.project ?? process.cwd());

        const triggerKey = (opts.trigger ?? 'manual').toUpperCase().replace(/-/g, '_');
        const trigger = (TriggerType as Record<string, string>)[triggerKey] as (typeof TriggerType)[keyof typeof TriggerType] | undefined;
        if (!trigger) {
          console.error(chalk.red(`✖ Unknown --trigger "${opts.trigger}". Expected one of: post-prompt, pre-deploy, scheduled, manual.`));
          process.exitCode = 1;
          return;
        }

        const runnerKeys = (opts.runners ?? 'unit,integration').split(',').map((r) => r.trim().toUpperCase()).filter((r) => r !== '');
        const runners: Array<(typeof RunnerType)[keyof typeof RunnerType]> = [];
        for (const key of runnerKeys) {
          const runner = (RunnerType as Record<string, string>)[key] as (typeof RunnerType)[keyof typeof RunnerType] | undefined;
          if (!runner) {
            console.error(chalk.red(`✖ Unknown runner "${key}". Expected one of: ${Object.keys(RunnerType).join(', ')}.`));
            process.exitCode = 1;
            return;
          }
          runners.push(runner);
        }

        console.log(chalk.bold(`\nFORGE TestOrchestrator — ${projectPath}\n`));
        const results = await runTests({
          projectPath,
          buildRunId: null,
          promptId: null,
          triggers: [trigger],
          runners,
        });

        const failedSuites = results.filter((r) => r.status === 'failed' || r.status === 'error');
        console.log('');
        console.log(`  ${results.length} suite(s) run — ${chalk.green(String(results.length - failedSuites.length))} ok, ${chalk.red(String(failedSuites.length))} failed`);
        if (failedSuites.length > 0) process.exitCode = 1;
      } catch (err: unknown) {
        console.error(chalk.red('✖ forge test failed:'), err instanceof Error ? err.message : err);
        process.exitCode = 1;
      }
    });

  program
    .command('readiness')
    .description('Show readiness-tier requirements, or evaluate the machine-verifiable Definition of Done against one tier (--tier)')
    .argument('<project-path>', 'target project directory')
    .option('--tier <id>', 'readiness tier to evaluate (e.g. MVP, ENTERPRISE_GRADE) — omit to list all tiers and their requirements')
    .action((pathArg: string, opts: { tier?: string }) => cmdReadiness(pathArg, opts));

  program
    .command('trace')
    .description(
      'Trace a REQ-NNN requirement id through queue.yaml, git history, and test evidence to its current stage (bidirectional: ' +
        'also reports which ADRs/risks motivated it). --reverse traces a downstream identifier back to its requirement id(s); ' +
        '--untested lists requirements/features with no recorded test evidence.'
    )
    .argument('[identifier]', 'requirement id (REQ-042), or with --reverse a downstream identifier (queue entry id/name, commit hash, test suite name); omit with --untested')
    .argument('[project-path]', 'target project directory', '.')
    .option('--reverse', 'reverse trace: given a downstream identifier, find which REQ-NNN id(s) it traces back to')
    .option('--untested', 'list requirements/features with no associated test evidence in Build Memory')
    .action((identifierArg: string | undefined, pathArg: string, opts: { reverse?: boolean; untested?: boolean }) => cmdTrace(identifierArg, pathArg, opts));

  program
    .command('state')
    .description('Infer the project\'s current formal build-lifecycle state (CONCEPT..OPTIMIZATION) from real signals')
    .argument('[project-path]', 'target project directory', '.')
    .option('--tier <id>', 'readiness tier to evaluate Definition of Done against, to resolve VALIDATION vs RELEASE_CANDIDATE')
    .action((pathArg: string, opts: { tier?: string }) => cmdState(pathArg, opts));

  program
    .command('blast-radius')
    .description('Compute the change-impact blast radius of changed files: what else could this affect?')
    .argument('[project-path]', 'target project directory', '.')
    .argument('[files...]', 'explicit changed files (relative or absolute) — omit to auto-detect from git')
    .action((pathArg: string, files: string[]) => cmdBlastRadius(pathArg, files));

  program
    .command('deadloop')
    .description('List error signatures currently past the dead-loop thresholds (same error family 4x, or one remediation class attempted 3x)')
    .action(() => cmdDeadLoop());

  program
    .command('stagnation')
    .description("Evaluate a build for stagnation (elapsed time vs. progress) and recommend replanning when stalled")
    .argument('[project-path]', 'target project directory', '.')
    .option('--build <id>', 'build_run id to evaluate — omit to use the project\'s most recent build')
    .action((pathArg: string, opts: { build?: string }) => cmdStagnation(pathArg, opts));

  const adrCmd = program
    .command('adr')
    .description('Manage the ADR (Architecture Decision Record) provenance log (add / list)');

  adrCmd
    .command('add')
    .description('Record a new architecture decision, auto-numbered sequentially')
    .argument('<project-path>', 'target project directory')
    .requiredOption('--title <text>', 'short decision title')
    .requiredOption('--context <text>', 'the situation that motivated the decision')
    .requiredOption('--decision <text>', 'what was decided')
    .requiredOption('--decided-by <who>', 'human name or agent/prompt identifier')
    .option('--status <status>', 'proposed | accepted | rejected | deprecated | superseded', 'proposed')
    .option('--consequences <text>', 'expected consequences, positive and negative')
    .option('--alternatives <json>', 'alternatives considered, as a JSON array of strings')
    .option('--source <text>', 'provenance — the prompt, build, or discussion that produced this decision')
    .option('--supersedes <adr-id>', 'id of a prior ADR this one supersedes')
    .action(
      (
        pathArg: string,
        opts: { title?: string; context?: string; decision?: string; decidedBy?: string; status?: string; consequences?: string; alternatives?: string; source?: string; supersedes?: string }
      ) => cmdAdrAdd(pathArg, opts)
    );

  adrCmd
    .command('list')
    .description('Print the full ADR log for a project, oldest first')
    .argument('[project-path]', 'target project directory', '.')
    .action((pathArg: string) => cmdAdrList(pathArg));

  const assumptionCmd = program
    .command('assumption')
    .description('Manage the assumption registry (add / list / validate)');

  assumptionCmd
    .command('add')
    .description('Record a new assumption (starts unvalidated)')
    .argument('<project-path>', 'target project directory')
    .requiredOption('--statement <text>', 'the assumption, stated as a claim')
    .requiredOption('--category <cat>', 'technical | business | user | infra | data | security')
    .requiredOption('--impact <text>', 'what breaks if this assumption is wrong')
    .option('--confidence <0-1>', 'confidence the assumption holds, 0.0-1.0')
    .option('--owner <name>', 'who owns validating this assumption')
    .option('--adr <adr-id>', 'id of the ADR this assumption underpins')
    .action(
      (pathArg: string, opts: { statement?: string; category?: string; impact?: string; confidence?: string; owner?: string; adr?: string }) =>
        cmdAssumptionAdd(pathArg, opts)
    );

  assumptionCmd
    .command('list')
    .description('Print the assumption registry for a project')
    .argument('[project-path]', 'target project directory', '.')
    .option('--status <status>', 'filter by unvalidated | validated | invalidated | stale')
    .action((pathArg: string, opts: { status?: string }) => cmdAssumptionList(pathArg, opts));

  assumptionCmd
    .command('validate')
    .description('Record the outcome of independently checking an assumption')
    .argument('<id>', 'assumption id')
    .requiredOption('--outcome <outcome>', 'validated | invalidated')
    .requiredOption('--method <text>', 'how it was checked')
    .requiredOption('--evidence <text>', 'the evidence that decided the outcome')
    .action((id: string, opts: { outcome?: string; method?: string; evidence?: string }) => cmdAssumptionValidate(id, opts));

  const riskCmd = program
    .command('risk')
    .description('Manage the risk register (add / list / status)');

  riskCmd
    .command('add')
    .description('Record a new risk with a derived severity score (probability x impact)')
    .argument('<project-path>', 'target project directory')
    .requiredOption('--title <text>', 'short risk title')
    .requiredOption('--description <text>', 'what the risk is')
    .requiredOption('--category <cat>', 'technical | schedule | security | operational | compliance | financial | vendor')
    .requiredOption('--probability <1-5>', 'likelihood, 1 (rare) - 5 (near-certain)')
    .requiredOption('--impact <1-5>', 'severity if realized, 1 (negligible) - 5 (severe)')
    .option('--mitigation <text>', 'mitigation plan')
    .option('--owner <name>', 'who owns this risk')
    .action(
      (
        pathArg: string,
        opts: { title?: string; description?: string; category?: string; probability?: string; impact?: string; mitigation?: string; owner?: string }
      ) => cmdRiskAdd(pathArg, opts)
    );

  riskCmd
    .command('list')
    .description('Print the risk register for a project, highest severity first')
    .argument('[project-path]', 'target project directory', '.')
    .option('--status <status>', 'filter by open | mitigating | accepted | closed | realized')
    .action((pathArg: string, opts: { status?: string }) => cmdRiskList(pathArg, opts));

  riskCmd
    .command('status')
    .description('Transition a risk\'s status')
    .argument('<id>', 'risk id')
    .requiredOption('--status <status>', 'open | mitigating | accepted | closed | realized')
    .action((id: string, opts: { status?: string }) => cmdRiskStatus(id, opts));

  const techDebtCmd = program
    .command('techdebt')
    .description('Manage the tech-debt ledger (add / list / resolve / seed from recorded findings)');

  techDebtCmd
    .command('add')
    .description('Record a manual tech-debt item')
    .argument('<project-path>', 'target project directory')
    .requiredOption('--title <text>', 'short title')
    .requiredOption('--description <text>', 'what the debt is')
    .requiredOption(
      '--category <cat>',
      'code_quality | architecture | test_coverage | security | performance | documentation | dependency | dead_code | schema_drift'
    )
    .requiredOption('--severity <sev>', 'low | medium | high | critical')
    .option('--effort <effort>', 'trivial | small | medium | large | unknown', 'unknown')
    .option('--file <path>', 'file the debt is located in')
    .action(
      (pathArg: string, opts: { title?: string; description?: string; category?: string; severity?: string; effort?: string; file?: string }) =>
        cmdTechDebtAdd(pathArg, opts)
    );

  techDebtCmd
    .command('list')
    .description('Print the tech-debt ledger for a project, most severe first')
    .argument('[project-path]', 'target project directory', '.')
    .option('--status <status>', 'filter by open | in_progress | resolved | wont_fix')
    .action((pathArg: string, opts: { status?: string }) => cmdTechDebtList(pathArg, opts));

  techDebtCmd
    .command('resolve')
    .description('Mark a tech-debt item resolved')
    .argument('<id>', 'tech-debt item id')
    .option('--build <build-run-id>', 'the build that resolved it')
    .action((id: string, opts: { build?: string }) => cmdTechDebtResolve(id, opts));

  techDebtCmd
    .command('seed')
    .description('Seed the ledger from findings FORGE already recorded (dead code, schema drift, dependency audit, adversary review)')
    .argument('[project-path]', 'target project directory', '.')
    .action((pathArg: string) => cmdTechDebtSeed(pathArg));

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

  const deploy = program
    .command('deploy')
    .description('Deploy a FORGE-built project and inject post-deploy monitoring snippet')
    .argument('<project-path>', 'Absolute path to the built project')
    .option('--endpoint <url>', 'Telemetry receiver URL for monitoring snippet injection')
    .option('--project-name <name>', 'Project name for telemetry (defaults to directory name)')
    .option('--slow-load-ms <ms>', 'Slow-load warning threshold in milliseconds', '3000')
    .option('--production', 'Deploy to the Vercel production environment (default: preview)')
    .option('--build-run-id <id>', 'Build Memory build_run id to associate this deployment with (default: a fresh id)')
    .option('--skip-vercel', 'Skip the autonomous Vercel deploy step even if the project is configured for it')
    .option('--skip-design-gate', 'Skip the design-approval pre-deploy check (for projects with no design-review workflow)')
    .action(async (projectPath: string, opts: { endpoint?: string; projectName?: string; slowLoadMs?: string; production?: boolean; buildRunId?: string; skipVercel?: boolean; skipDesignGate?: boolean }) => {
      const spinner = ora('Preparing deploy...').start();
      try {
        const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
        const resolved = resolve(projectPath);

        spinner.text = 'Running pre-deploy gate (build + lint + design approval)...';
        const { runPreDeployGate } = await import('../deploy/pre-deploy-gate.js');
        const gateResult = await runPreDeployGate(resolved, undefined, { requireDesignApproval: !opts.skipDesignGate });
        if (!gateResult.passed) {
          spinner.stop();
          console.log(chalk.red('[FAIL] PRE-DEPLOY GATE: blocked'));
          for (const check of gateResult.checks.filter((c) => c.exitCode !== 0)) {
            console.error(chalk.red(`  ${check.command} exited ${check.exitCode ?? 'unknown'}`));
          }
          console.error(chalk.yellow('See STATE_OF_THE_BUILD.md for the full BLOCKER report.'));
          process.exitCode = 1;
          return;
        }
        console.log(chalk.green('[PASS] PRE-DEPLOY GATE: clean'));

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

        // Autonomous Vercel deploy — replaces the operator manually running `vercel --prod`.
        // Only attempted when the project is actually configured for it (token + .vercel link);
        // otherwise this degrades to the manual-deploy instructions already printed above.
        if (!opts.skipVercel) {
          const { createVercelDeployer } = await import('../autonomy/vercel-deployer.js');
          const deployer = createVercelDeployer();
          const configured = await deployer.isConfigured(resolved);
          if (configured) {
            const buildRunId = opts.buildRunId ?? randomUUID();
            const environment = opts.production ? 'production' : 'preview';
            const vercelSpinner = ora(`Deploying to Vercel (${environment})...`).start();
            const deployResult = await deployer.deploy(resolved, buildRunId, environment);
            if (deployResult.status === 'ready' && deployResult.deploymentUrl) {
              vercelSpinner.succeed(`Vercel deploy ready: ${deployResult.deploymentUrl}`);
              console.log(chalk.green(`\n[PASS] VERCEL DEPLOY: ${deployResult.deploymentId ?? 'unknown'}`));

              // Post-deploy verification (F9) against the live deployment URL.
              const verifySpinner = ora('Running post-deploy verification...').start();
              try {
                const { runDeployVerification } = await import('../deploy/verify-runner.js');
                const verifyResult = await runDeployVerification({
                  projectPath: resolved,
                  baseUrl: deployResult.deploymentUrl,
                  latencyBudgetMs: DEFAULT_VERIFY_LATENCY_BUDGET_MS,
                });
                if (verifyResult.passed) {
                  verifySpinner.succeed(`Post-deploy verification passed (${verifyResult.routes.length} route(s))`);
                } else {
                  verifySpinner.warn('Post-deploy verification found failing routes');
                  for (const r of verifyResult.routes.filter((route) => route.verdict !== 'PASSED')) {
                    console.error(chalk.red(`  [FAIL] VERIFY: ${r.route} ${r.statusCode ?? 'ERR'} ${r.latencyMs}ms`));
                  }
                  process.exitCode = 1;
                }
              } catch (verifyErr: unknown) {
                verifySpinner.fail('Post-deploy verification failed to run');
                console.error(chalk.red(verifyErr instanceof Error ? verifyErr.message : String(verifyErr)));
              }
            } else {
              vercelSpinner.fail(`Vercel deploy did not become ready (status: ${deployResult.status})`);
              if (deployResult.error) console.error(chalk.red(`  ${deployResult.error}`));
              process.exitCode = 1;
            }
          } else {
            console.log(chalk.yellow('\nProject not configured for autonomous Vercel deploy (no VERCEL_TOKEN or no .vercel link).'));
            console.log('Run `vercel link` and store VERCEL_TOKEN (env or `forge credentials`) to enable it.');
          }
        }

        console.log(chalk.green('\nDeploy step complete. See .forge/BUILD_READY.md for launch instructions.'));
      } catch (err: unknown) {
        spinner.fail('DEPLOY failed');
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
    });

  deploy
    .command('auto')
    .description('Deploy via VercelDeployer (REST API, no CLI subprocess), then run forge verify against the result')
    .argument('<project-path>', 'target project directory')
    .option('--env <environment>', 'production or preview', 'preview')
    .action((pathArg: string, opts: { env?: string }) => cmdDeployAuto(pathArg, opts));

  program
    .command('verify')
    .description('Post-deploy HTTP health check (F9): GET every src/app/api route against a live preview/production URL')
    .argument('<preview-url>', 'base URL to verify routes against (e.g. a Vercel preview or production deployment)')
    .option('--project <path>', 'target project directory (default cwd)')
    .option('--latency-budget-ms <ms>', 'per-route response-time budget', String(DEFAULT_VERIFY_LATENCY_BUDGET_MS))
    .action(async (previewUrl: string, opts: { project?: string; latencyBudgetMs?: string }) => {
      const projectPath = resolve(opts.project ?? process.cwd());
      const latencyBudgetMs = Number.parseInt(opts.latencyBudgetMs ?? String(DEFAULT_VERIFY_LATENCY_BUDGET_MS), 10);
      console.log(chalk.bold(`\nforge verify — ${projectPath}`));
      console.log(chalk.dim(`  URL: ${previewUrl}`));
      try {
        const { runDeployVerification } = await import('../deploy/verify-runner.js');
        const result = await runDeployVerification({ projectPath, baseUrl: previewUrl, latencyBudgetMs });
        if (result.routes.length === 0) {
          console.log(chalk.yellow('  no API routes found under src/app/api — nothing to verify.'));
        }
        for (const r of result.routes) {
          if (r.verdict === 'PASSED') {
            console.log(chalk.green(`  [PASS] VERIFY: ${r.route} ${r.statusCode ?? '—'} ${r.latencyMs}ms`));
          } else {
            console.log(chalk.red(`  [FAIL] VERIFY: ${r.route} ${r.statusCode ?? 'ERR'} ${r.latencyMs}ms`));
          }
        }
        console.log('');
        if (result.passed) {
          console.log(chalk.green('✔ verification-passed'));
        } else {
          console.log(chalk.red('✖ verification-failed'));
          process.exitCode = 1;
        }
      } catch (err: unknown) {
        console.error(chalk.red('✖ forge verify failed:'), err instanceof Error ? err.message : err);
        process.exitCode = 1;
      }
    });

  registerLearningCommands(program);
  registerAgentCommands(program);

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  getLogger('cli').fatal(detail);
  console.error(chalk.red.bold('\n✖ FORGE CLI crashed:'));
  console.error(chalk.red(detail));
  process.exitCode = 1;
});


