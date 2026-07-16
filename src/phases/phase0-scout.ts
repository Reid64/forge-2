/**
 * FORGE 2.0 — Phase 0: Toolchain Scout (orchestrator).
 *
 * Phase 0 is the environment gate that runs before any build. It composes the two
 * Phase 0 helpers — the Stack Detector (s2-p01) and the Environment Auditor
 * (s2-p02) — then performs best-effort remediation, locks the result into a
 * TOOLCHAIN.md manifest, and returns a pass/fail gate for the rest of FORGE.
 *
 * Sequence (per queue.yaml s2-p03):
 *   1. Detect the target project's stack          → detectStack(projectPath)
 *   2. Audit the live machine against that stack   → auditEnvironment(...)
 *   3. Query Build Memory for a cached config / prior registration on this machine
 *   4. Auto-install missing npm-global CLI tools   (pnpm/npm -g)
 *   5. Auto-fix known issues                       (PowerShell execution policy, Node PATH)
 *   6. Re-audit (if anything was remediated) and lock a TOOLCHAIN manifest
 *   7. Resolve + register the machine_id in Build Memory
 *   8. Return a Phase0Result { stackFingerprint, environmentAudit,
 *      toolchainManifest, passed, blockers[] }
 *
 * GATE: any required CLI tool or env var still missing after remediation is a
 * blocker. `passed` is true only when `blockers` is empty; when it is false the
 * caller (the build pipeline) MUST halt — per CLAUDE.md Iron Law 10 / BLUEPRINT
 * canonical rule 1 (no build without a clean Phase 0).
 *
 * Like its helpers, this orchestrator is NON-FATAL: every external command, file
 * write, and Build Memory call is guarded and never throws. A machine missing
 * everything yields `passed: false` with a full blocker list, not an exception.
 * Build Memory being unreachable is degraded-not-fatal (BEHAVIORAL_CONTRACTS
 * Contract 4): the scout still runs and locks a manifest in stateless mode.
 *
 * Auto-install / auto-fix are real side-effecting commands; they run ONLY when
 * this function is called with the corresponding options enabled (both default
 * on). Authoring this file performs no installs.
 */

import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

import { detectStack, type StackFingerprint } from '../tools/stack-detector.js';
import { writeGovernanceFile } from '../tools/governance-text.js';
import {
  auditEnvironment,
  type EnvironmentAudit,
  type DockerStatus,
} from '../tools/env-auditor.js';
import { runQuery, nowIso, getClient, telemetry } from '../memory/index.js';
import { logLine } from '../tools/forge-logger.js';
import { scanProjectSecurity } from '../tools/agent-shield.js';
import { detectSchemaDrift } from '../tools/schema-validator.js';
import { HookManager } from '../engine/hook-manager.js';
import { onSessionStart } from '../memory/session-hooks.js';
import type { SecurityReport, SessionContext } from '../types/index.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single tool's locked state in the TOOLCHAIN manifest. */
export interface ToolLock {
  /** Tool name (node, pnpm, git, …). */
  name: string;
  /** Whether the detected stack requires this tool. */
  required: boolean;
  /** `present` (already installed), `installed` (installed by this scout run), or `missing`. */
  status: 'present' | 'installed' | 'missing';
  /** Captured version / path string, or null when missing. */
  version: string | null;
}

/** A single environment-variable requirement's state in the manifest. */
export interface EnvCheck {
  /** The env var key that satisfied (or would satisfy) this requirement. */
  name: string;
  /** Whether the detected stack requires it. */
  required: boolean;
  /** Whether a non-empty value is present (in process.env or a project .env file). */
  present: boolean;
  /** Masked value (present) or a remediation hint (missing). */
  detail: string;
}

/** A remediation the scout attempted (auto-install or auto-fix). */
export interface RemediationAction {
  kind: 'auto-install' | 'auto-fix';
  /** What was targeted (tool name / fix id). */
  target: string;
  /** The command that was run (constant strings only — never user input). */
  command: string;
  /** Whether the command succeeded. */
  success: boolean;
  /** Short human-readable outcome / error summary. */
  detail: string;
}

/**
 * The locked toolchain manifest produced by Phase 0. Serialized to TOOLCHAIN.md
 * and (later, in Phase 3) persisted to build_runs.toolchain_manifest.
 */
export interface ToolchainManifest {
  generatedAt: string;
  machineId: string;
  /** True if Build Memory already had a record (a prior build_run) for this machine. */
  machineRegistered: boolean;
  platform: string;
  nodeVersion: string;
  stack: StackFingerprint;
  /** Locked tool versions (sorted by name). */
  tools: ToolLock[];
  /** Required/optional env vars and whether each is set. */
  envChecklist: EnvCheck[];
  /** Capability slugs FORGE can perform given the present tools + stack. */
  skillManifest: string[];
  /** Remediations attempted this run. */
  remediations: RemediationAction[];
  /** Docker / FORGE Build Memory runtime status (from the final audit). */
  dockerStatus: DockerStatus;
  /** True when this Phase 0 run had to `git init` the project (Session 5 finding #3: greenfield). */
  gitInitialized: boolean;
  /** Non-fatal observations carried over from the environment audit. */
  warnings: string[];
}

/** The Phase 0 gate result returned to the build pipeline. */
export interface Phase0Result {
  stackFingerprint: StackFingerprint;
  environmentAudit: EnvironmentAudit;
  toolchainManifest: ToolchainManifest;
  /** True iff `blockers` is empty. When false, FORGE must halt. */
  passed: boolean;
  /** Critical missing tools / env vars or security failures that block the build. */
  blockers: string[];
  /** AgentShield security report (null if scan errored out). */
  securityReport: SecurityReport | null;
  /** Initialized hook manager with built-in + project hooks loaded (null if init errored). */
  hookManager: HookManager | null;
  /** Restored session context from Build Memory (null if unavailable or stateless). */
  sessionContext: SessionContext | null;
}

/** Options controlling the scout's side effects (all default to the safe build behavior). */
export interface Phase0Options {
  /** Override the machine id (defaults to FORGE_MACHINE_ID, else a generated UUID). */
  machineId?: string;
  /** Attempt `pnpm add -g` / `npm install -g` for missing npm-global tools. Default true. */
  autoInstall?: boolean;
  /** Attempt known auto-fixes (PowerShell execution policy, Node PATH). Default true. */
  autoFix?: boolean;
  /** Write TOOLCHAIN.md to the project's governance directory. Default true. */
  writeToolchainFile?: boolean;
  /**
   * Skip the step 9 AgentShield security scan entirely (and add no AgentShield
   * blockers). Default false — the scan runs as part of the gate.
   */
  skipSecurityGate?: boolean;
  /** Name of the governance subdirectory under projectPath. Default 'governance'. */
  governanceDirName?: string;
  /** Progress reporter. Default logs to the console with a [FORGE:phase0] prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Remediation knowledge
// ---------------------------------------------------------------------------

/**
 * Missing CLI tools FORGE can install from the npm registry. node, git and docker
 * are deliberately ABSENT — they are not npm packages and remain hard blockers
 * when missing (they require an OS-level installer).
 */
const NPM_INSTALLABLE: Readonly<Record<string, string>> = {
  pnpm: 'pnpm',
  vercel: 'vercel',
  supabase: 'supabase',
  playwright: 'playwright',
  claude: '@anthropic-ai/claude-code',
};

/** Default Windows install location for Node.js (the PATH auto-fix candidate). */
const WINDOWS_NODE_DIR = 'C:\\Program Files\\nodejs';

// ---------------------------------------------------------------------------
// Low-level helpers (all guarded — never throw)
// ---------------------------------------------------------------------------

/** Result of a guarded shell command. */
interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run a shell command with a timeout, capturing output and never throwing. Used
 * only with trusted, constant command strings (fixed installers + fixed flags).
 */
async function run(command: string, timeoutMs: number): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  } catch (error) {
    const e = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const stderr = String(e.stderr ?? '') || String(e.message ?? '');
    return { ok: false, stdout: String(e.stdout ?? ''), stderr };
  }
}

/** First non-empty line of a command's output, trimmed (for terse log/detail strings). */
function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  );
}

/** True if a filesystem path exists (guarded — never throws). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True if `projectPath` is a FORGE installation itself (not just a project FORGE
 * is building). Detected by the presence of phase3-executor.ts or a package.json
 * whose name contains "forge". Used to exempt FORGE's own .claude/skills from the
 * AgentShield scan, which would otherwise flag FORGE's operator-facing skill docs
 * as untrusted third-party content.
 */
async function isForgeInstallation(projectPath: string): Promise<boolean> {
  if (await pathExists(join(projectPath, 'src', 'phases', 'phase3-executor.ts'))) return true;
  try {
    const raw = await readFile(join(projectPath, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { name?: unknown };
    return typeof pkg.name === 'string' && pkg.name.toLowerCase().includes('forge');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Greenfield git init (Session 5 finding #3)
// ---------------------------------------------------------------------------

/** The outcome of {@link ensureGitRepo}. */
export interface EnsureGitRepoResult {
  /** True when this call actually ran `git init` (the project had no `.git`). */
  initialized: boolean;
  /** Non-fatal problem encountered while initializing, or null. */
  warning: string | null;
}

/**
 * Greenfield git init (Session 5 finding #3): if `projectPath` has no `.git`, run `git init` +
 * an initial commit on a `main` branch BEFORE anything else touches the project. Without this,
 * Contract 10 (branch isolation), Contract 11 (checkpoint tags), and Contract 12 (rollback) all
 * silently no-op for the whole build — GitManager's commands just fail one-by-one with no gate
 * ever catching it. Guarded — never throws; a failed init degrades to a warning (the same
 * non-fatal posture as the rest of Phase 0), and Sentinel's file_integrity check (Phase 4) WARNS
 * loudly rather than at INFO level when git is still absent by the time a prompt runs.
 */
export async function ensureGitRepo(
  projectPath: string,
  log: (message: string) => void
): Promise<EnsureGitRepoResult> {
  if (await pathExists(join(projectPath, '.git'))) {
    return { initialized: false, warning: null };
  }

  log(`No .git found at ${projectPath} — initializing a repository (Contract 10/11/12 require one).`);
  const opts = { cwd: projectPath, windowsHide: true, maxBuffer: 1024 * 1024 } as const;
  const runIn = async (command: string, timeoutMs: number): Promise<CommandResult> => {
    try {
      const { stdout, stderr } = await execAsync(command, { ...opts, timeout: timeoutMs });
      return { ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
    } catch (error) {
      const e = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
      return { ok: false, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') || String(e.message ?? '') };
    }
  };

  const initRes = await runIn('git init', 15000);
  if (!initRes.ok) {
    const warning = `git init failed at ${projectPath} (${firstLine(initRes.stderr) || 'unknown error'}) — branch/checkpoint/rollback (Contract 10/11/12) will no-op for this build.`;
    log(`WARNING: ${warning}`);
    return { initialized: false, warning };
  }

  // Land on a `main` branch regardless of the local/global `init.defaultBranch` setting.
  await runIn('git symbolic-ref HEAD refs/heads/main', 10000);

  // Set a commit identity ONLY if none is already configured (never override the user's own).
  const nameSet = await runIn('git config user.name', 5000);
  if (!nameSet.ok || nameSet.stdout.trim() === '') await runIn('git config user.name "FORGE"', 5000);
  const emailSet = await runIn('git config user.email', 5000);
  if (!emailSet.ok || emailSet.stdout.trim() === '') await runIn('git config user.email "forge@localhost"', 5000);

  const addRes = await runIn('git add -A', 60000);
  if (!addRes.ok) {
    const warning = `git add failed after git init at ${projectPath} (${firstLine(addRes.stderr) || 'unknown error'}).`;
    log(`WARNING: ${warning}`);
    return { initialized: true, warning };
  }

  const commitRes = await runIn('git commit --allow-empty -m "FORGE: initial commit (greenfield git init)"', 30000);
  if (!commitRes.ok) {
    const warning = `initial commit failed after git init at ${projectPath} (${firstLine(commitRes.stderr) || 'unknown error'}).`;
    log(`WARNING: ${warning}`);
    return { initialized: true, warning };
  }

  log(`git initialized at ${projectPath}: 'main' branch created with an initial commit.`);
  return { initialized: true, warning: null };
}

// ---------------------------------------------------------------------------
// Build Memory: cached config + machine registration
// ---------------------------------------------------------------------------

/**
 * Look up the most recent build_run for this machine. Its presence tells us the
 * machine is already "registered" (FORGE has built here before) and carries the
 * last locked toolchain we can reference. Returns a stateless-safe result when
 * Build Memory is unreachable (Contract 4).
 */
async function loadCachedConfig(
  machineId: string
): Promise<{ registered: boolean; lastBuiltAt: string | null }> {
  const rows = await runQuery<Array<{ id: string; created_at: string }>>(
    'phase0:loadCachedConfig',
    (db) =>
      db
        .prepare('SELECT id, created_at FROM build_runs WHERE machine_id = ? ORDER BY created_at DESC LIMIT 1')
        .all(machineId) as Array<{ id: string; created_at: string }>
  );

  const latest = rows && rows.length > 0 ? rows[0] : undefined;
  if (latest) return { registered: true, lastBuiltAt: latest.created_at };
  return { registered: false, lastBuiltAt: null };
}

// ---------------------------------------------------------------------------
// Remediation
// ---------------------------------------------------------------------------

/**
 * Attempt to repair the issues an initial audit surfaced. Returns the actions
 * taken and whether anything changed (so the caller knows to re-audit). Never
 * throws; a failed remediation is recorded with `success: false`.
 */
async function remediate(
  audit: EnvironmentAudit,
  options: Required<Pick<Phase0Options, 'autoInstall' | 'autoFix'>>,
  log: (m: string) => void
): Promise<{ remediations: RemediationAction[]; installed: Set<string>; changed: boolean }> {
  const remediations: RemediationAction[] = [];
  const installed = new Set<string>();
  let changed = false;

  const presentCli = new Set(
    audit.present.filter((i) => i.kind === 'cli').map((i) => i.name)
  );
  const missingCli = audit.missing.filter((i) => i.kind === 'cli');
  const isWindows = process.platform === 'win32';

  // --- Auto-fix 1: PowerShell execution policy (seed: powershell_execution_policy)
  // Idempotent and safe; FORGE relies on running .ps1 scripts (docker/start-forge-db.ps1, etc.).
  if (options.autoFix && isWindows) {
    log('auto-fix: setting PowerShell execution policy (CurrentUser → RemoteSigned)');
    const cmd =
      'powershell -NoProfile -Command "Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force"';
    const res = await run(cmd, 30000);
    remediations.push({
      kind: 'auto-fix',
      target: 'powershell-execution-policy',
      command: cmd,
      success: res.ok,
      detail: res.ok ? 'CurrentUser policy set to RemoteSigned' : firstLine(res.stderr),
    });
    if (res.ok) changed = true;
  }

  // --- Auto-fix 2: Node PATH (seed: node_path_missing) ---------------------
  // If Node is required-but-missing and the default install dir exists, prepend it
  // to PATH for this process so the re-audit (and the rest of the build) finds it.
  if (
    options.autoFix &&
    isWindows &&
    missingCli.some((i) => i.name === 'node') &&
    (await pathExists(join(WINDOWS_NODE_DIR, 'node.exe')))
  ) {
    log(`auto-fix: prepending ${WINDOWS_NODE_DIR} to PATH for this process`);
    const previous = process.env.PATH ?? '';
    process.env.PATH = previous ? `${WINDOWS_NODE_DIR};${previous}` : WINDOWS_NODE_DIR;
    remediations.push({
      kind: 'auto-fix',
      target: 'node-path',
      command: `PATH := ${WINDOWS_NODE_DIR};$PATH`,
      success: true,
      detail: `Prepended ${WINDOWS_NODE_DIR} (node.exe found there)`,
    });
    changed = true;
  }

  // --- Auto-install: npm-global CLI tools ----------------------------------
  if (options.autoInstall) {
    for (const item of missingCli) {
      const pkg = NPM_INSTALLABLE[item.name];
      if (!pkg) continue; // node/git/docker → not installable from npm; left as blockers.

      // Prefer FORGE's locked package manager (pnpm) when it is available;
      // fall back to npm (always present with Node) — notably when installing pnpm itself.
      const usePnpm = presentCli.has('pnpm') && item.name !== 'pnpm';
      const cmd = usePnpm ? `pnpm add -g ${pkg}` : `npm install -g ${pkg}`;

      log(`auto-install: ${item.name} → ${cmd}`);
      const res = await run(cmd, 180000);
      remediations.push({
        kind: 'auto-install',
        target: item.name,
        command: cmd,
        success: res.ok,
        detail: res.ok ? `installed ${pkg}` : firstLine(res.stderr) || `failed to install ${pkg}`,
      });
      if (res.ok) {
        installed.add(item.name);
        changed = true;
      }
    }
  }

  return { remediations, installed, changed };
}

// ---------------------------------------------------------------------------
// Manifest assembly + rendering
// ---------------------------------------------------------------------------

/** Best-effort Node.js version (`process.version`, e.g. "v20.20.2"). */
function nodeVersion(): string {
  return typeof process.version === 'string' && process.version !== '' ? process.version : 'unknown';
}

/** Derive the FORGE capability slugs available given the present tools + stack. */
function deriveSkillManifest(
  presentCli: ReadonlySet<string>,
  fingerprint: StackFingerprint,
  docker: DockerStatus
): string[] {
  const skills = new Set<string>();
  if (presentCli.has('node')) skills.add('runtime:node');
  if (presentCli.has('pnpm')) skills.add('package-management:pnpm');
  if (presentCli.has('git')) skills.add('version-control:git');
  if (presentCli.has('claude')) skills.add('ai-execution:claude-code');
  if (presentCli.has('vercel')) skills.add('deploy:vercel');
  if (presentCli.has('docker')) skills.add('containers:docker');
  if (presentCli.has('playwright')) {
    skills.add('browser-automation:playwright');
    skills.add('six-laws-verification');
  }
  if (presentCli.has('supabase') || docker.forgeSupabaseUp) {
    skills.add('build-memory:supabase');
  }
  if (fingerprint.framework) skills.add(`framework:${fingerprint.framework}`);
  return [...skills].sort();
}

/** Build the locked ToolLock list from a (final) audit, marking tools installed this run. */
function buildToolLocks(audit: EnvironmentAudit, installed: ReadonlySet<string>): ToolLock[] {
  const tools: ToolLock[] = [];
  for (const item of audit.present) {
    if (item.kind !== 'cli') continue;
    tools.push({
      name: item.name,
      required: item.required,
      status: installed.has(item.name) ? 'installed' : 'present',
      version: item.detail,
    });
  }
  for (const item of audit.missing) {
    if (item.kind !== 'cli') continue;
    tools.push({ name: item.name, required: item.required, status: 'missing', version: null });
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

/** Build the env-var checklist from a (final) audit. */
function buildEnvChecklist(audit: EnvironmentAudit): EnvCheck[] {
  const checks: EnvCheck[] = [];
  for (const item of audit.present) {
    if (item.kind !== 'env') continue;
    checks.push({ name: item.name, required: item.required, present: true, detail: item.detail });
  }
  for (const item of audit.missing) {
    if (item.kind !== 'env') continue;
    checks.push({ name: item.name, required: item.required, present: false, detail: item.detail });
  }
  return checks.sort((a, b) => a.name.localeCompare(b.name));
}

/** Compute the blocker list: every required item still missing after remediation. */
function computeBlockers(audit: EnvironmentAudit): string[] {
  const blockers: string[] = [];
  for (const item of audit.missing) {
    if (item.kind === 'cli') {
      blockers.push(`Missing required CLI tool '${item.name}': ${item.detail}`);
    } else {
      blockers.push(`Missing required env var '${item.name}': ${item.detail}`);
    }
  }
  return blockers;
}

/** Render TOOLCHAIN.md from a locked manifest + the computed gate. */
export function renderToolchainMarkdown(
  manifest: ToolchainManifest,
  passed: boolean,
  blockers: string[]
): string {
  const lines: string[] = [];
  const tick = (b: boolean) => (b ? '✅' : '❌');

  lines.push('# TOOLCHAIN.md — Locked Toolchain Manifest');
  lines.push('');
  lines.push('> Generated by FORGE 2.0 Phase 0 (Toolchain Scout). Do not edit by hand —');
  lines.push('> this file is regenerated on every Phase 0 run.');
  lines.push('');
  lines.push(`- **Phase 0 gate:** ${passed ? 'PASS ✅' : 'FAIL ❌'}`);
  lines.push(`- **Generated:** ${manifest.generatedAt}`);
  lines.push(`- **Machine ID:** ${manifest.machineId}`);
  lines.push(`- **Machine registered in Build Memory:** ${manifest.machineRegistered ? 'yes' : 'no (first build here)'}`);
  lines.push(`- **Git initialized this run:** ${manifest.gitInitialized ? 'yes (greenfield — git init + initial commit on main)' : 'no (repository already existed)'}`);
  lines.push(`- **Platform:** ${manifest.platform}`);
  lines.push(`- **Node.js:** ${manifest.nodeVersion}`);
  lines.push('');

  // Detected stack
  const s = manifest.stack;
  lines.push('## Detected Stack');
  lines.push('');
  lines.push('| Aspect | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Framework | ${s.framework ?? '—'} |`);
  lines.push(`| Language | ${s.language ?? '—'} |`);
  lines.push(`| Database | ${s.database ?? '—'} |`);
  lines.push(`| Deployment | ${s.deployment ?? '—'} |`);
  lines.push(`| Package manager | ${s.packageManager ?? '—'} |`);
  lines.push(`| Services | ${s.services.length ? s.services.join(', ') : '—'} |`);
  lines.push('');

  // Locked tool versions
  lines.push('## Locked Tool Versions');
  lines.push('');
  lines.push('| Tool | Required | Status | Version / Path |');
  lines.push('|------|----------|--------|----------------|');
  for (const t of manifest.tools) {
    lines.push(
      `| ${t.name} | ${t.required ? 'yes' : 'no'} | ${t.status} | ${t.version ?? '—'} |`
    );
  }
  lines.push('');

  // Skill manifest
  lines.push('## Skill Manifest');
  lines.push('');
  lines.push('Capabilities FORGE can perform on this machine for this stack:');
  lines.push('');
  if (manifest.skillManifest.length === 0) {
    lines.push('- _(none detected)_');
  } else {
    for (const skill of manifest.skillManifest) lines.push(`- ${skill}`);
  }
  lines.push('');

  // Env checklist
  lines.push('## Environment Variable Checklist');
  lines.push('');
  lines.push('| Variable | Required | Present | Detail |');
  lines.push('|----------|----------|---------|--------|');
  if (manifest.envChecklist.length === 0) {
    lines.push('| _(none required)_ | — | — | — |');
  } else {
    for (const e of manifest.envChecklist) {
      lines.push(`| ${e.name} | ${e.required ? 'yes' : 'no'} | ${tick(e.present)} | ${e.detail} |`);
    }
  }
  lines.push('');

  // Docker / Build Memory
  const d = manifest.dockerStatus;
  lines.push('## Docker / Build Memory');
  lines.push('');
  lines.push(`- Docker CLI installed: ${tick(d.installed)}`);
  lines.push(`- Docker daemon running: ${tick(d.running)}`);
  lines.push(`- FORGE Supabase (Build Memory) up: ${tick(d.forgeSupabaseUp)}`);
  if (d.runningContainers.length > 0) {
    lines.push(`- Running containers: ${d.runningContainers.join(', ')}`);
  }
  lines.push('');

  // Remediations
  lines.push('## Remediations Attempted');
  lines.push('');
  if (manifest.remediations.length === 0) {
    lines.push('- _(none needed)_');
  } else {
    for (const r of manifest.remediations) {
      lines.push(`- ${tick(r.success)} **${r.kind}** \`${r.target}\` — ${r.detail}`);
    }
  }
  lines.push('');

  // Warnings
  if (manifest.warnings.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    for (const w of manifest.warnings) lines.push(`- ⚠️ ${w}`);
    lines.push('');
  }

  // Blockers
  lines.push('## Blockers');
  lines.push('');
  if (blockers.length === 0) {
    lines.push('- _(none — Phase 0 gate PASSED)_');
  } else {
    for (const b of blockers) lines.push(`- ❌ ${b}`);
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the full Phase 0 Toolchain Scout against `projectPath`.
 *
 * Always resolves (never rejects). Returns a `Phase0Result` whose `passed` flag
 * is the build gate: when false, the caller must halt and surface `blockers`.
 */
export async function runPhase0Scout(
  projectPath: string,
  options: Phase0Options = {}
): Promise<Phase0Result> {
  const autoInstall = options.autoInstall ?? true;
  const autoFix = options.autoFix ?? true;
  const writeToolchainFile = options.writeToolchainFile ?? true;
  const skipSecurityGate = options.skipSecurityGate ?? false;
  const governanceDirName = options.governanceDirName ?? 'governance';
  const log = options.log ?? logLine('phase0');

  // 0. Greenfield git init (Session 5 finding #3) — before anything else touches the project.
  const gitInit = await ensureGitRepo(projectPath, log);

  // 1. Detect the project's stack ------------------------------------------
  log(`scanning stack at ${projectPath}`);
  const stackFingerprint = await detectStack(projectPath);
  log(
    `stack: framework=${stackFingerprint.framework ?? '—'} ` +
      `db=${stackFingerprint.database ?? '—'} pm=${stackFingerprint.packageManager ?? '—'} ` +
      `tools=[${stackFingerprint.cliTools.join(', ')}]`
  );

  // 2. Audit the live machine against that stack ---------------------------
  log('auditing environment (CLI tools, env vars, Docker)');
  let audit = await auditEnvironment(stackFingerprint, projectPath);
  log(`audit: ${audit.present.length} present, ${audit.missing.length} missing, ${audit.warnings.length} warnings`);

  // 3. Build Memory: cached config + prior registration on this machine ----
  const machineId = options.machineId ?? process.env.FORGE_MACHINE_ID ?? randomUUID();
  const cached = await loadCachedConfig(machineId);
  if (cached.registered) {
    log(`machine ${machineId} already registered (last build ${cached.lastBuiltAt ?? 'unknown'})`);
  } else {
    log(`machine ${machineId} not yet registered in Build Memory (first build here)`);
  }

  // 4 + 5. Remediate (auto-install missing npm tools, auto-fix known issues)
  const { remediations, installed, changed } = await remediate(
    audit,
    { autoInstall, autoFix },
    log
  );

  // 6. Re-audit if anything changed, then lock the manifest ----------------
  if (changed) {
    log('re-auditing after remediation');
    audit = await auditEnvironment(stackFingerprint, projectPath);
    log(`re-audit: ${audit.present.length} present, ${audit.missing.length} missing`);
  }

  const presentCli = new Set(
    audit.present.filter((i) => i.kind === 'cli').map((i) => i.name)
  );

  const toolchainManifest: ToolchainManifest = {
    generatedAt: nowIso(),
    machineId,
    // 7. Registration: Build Memory has no dedicated machines table — a machine is
    // "registered" once its first build_run lands in Phase 3. Here we record whether
    // that has happened so the manifest / gate is honest about it (Contract 4).
    machineRegistered: cached.registered,
    platform: process.platform,
    nodeVersion: nodeVersion(),
    stack: stackFingerprint,
    tools: buildToolLocks(audit, installed),
    envChecklist: buildEnvChecklist(audit),
    skillManifest: deriveSkillManifest(presentCli, stackFingerprint, audit.dockerStatus),
    remediations,
    dockerStatus: audit.dockerStatus,
    gitInitialized: gitInit.initialized,
    warnings: gitInit.warning ? [...audit.warnings, gitInit.warning] : audit.warnings,
  };

  // 8. Compute the gate -----------------------------------------------------
  const blockers = computeBlockers(audit);
  const passed = blockers.length === 0;
  log(passed ? 'Phase 0 gate: PASS' : `Phase 0 gate: FAIL (${blockers.length} blocker(s))`);

  // Write TOOLCHAIN.md to the target project's governance directory ---------
  if (writeToolchainFile) {
    const markdown = renderToolchainMarkdown(toolchainManifest, passed, blockers);
    const governanceDir = join(projectPath, governanceDirName);
    const toolchainPath = join(governanceDir, 'TOOLCHAIN.md');
    try {
      await mkdir(governanceDir, { recursive: true });
      await writeGovernanceFile(toolchainPath, markdown);
      log(`wrote ${toolchainPath}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`WARNING: could not write TOOLCHAIN.md (${detail})`);
      toolchainManifest.warnings.push(`Failed to write TOOLCHAIN.md: ${detail}`);
    }
  }

  // -------------------------------------------------------------------------
  // Step 9: AgentShield security scan — must pass grade D (A or B) to proceed
  // -------------------------------------------------------------------------
  let securityReport: SecurityReport | null = null;
  if (skipSecurityGate) {
    log('step 9: AgentShield security scan skipped (--skip-security-gate)');
  } else {
    log('step 9: AgentShield security scan');
    try {
      const excludePaths = (await isForgeInstallation(projectPath))
        ? [join(projectPath, '.claude', 'skills')]
        : [];
      securityReport = await scanProjectSecurity(projectPath, { excludePaths });
      const { grade, findings } = securityReport;
      log(`AgentShield: grade=${grade} | ${findings.length} finding(s) | ${securityReport.scannedPaths.length} artifact(s) scanned`);
      for (const f of findings) {
        log(`  [${f.severity}] ${f.category}: ${f.message}`);
      }
      // Log findings to build memory (non-blocking — degraded-not-fatal per Contract 4)
      try {
        const hasCritical = findings.some((f) => f.severity === 'critical');
        const hasHigh = findings.some((f) => f.severity === 'high');
        await telemetry.createEvent({
          project_name: projectPath.split(/[\\/]/).filter(Boolean).pop() ?? 'unknown',
          event_type: 'feedback',
          event_data: {
            source: 'agent-shield',
            grade,
            findingCount: findings.length,
            findings: findings.map((f) => ({
              severity: f.severity,
              category: f.category,
              message: f.message,
              file: f.file,
              ...(f.line !== undefined ? { line: f.line } : {}),
            })),
            recommendations: securityReport.recommendations,
          },
          severity: hasCritical ? 'critical' : hasHigh ? 'warning' : 'info',
        });
      } catch {
        // Non-fatal; Build Memory unavailable is degraded-not-fatal (Contract 4)
      }
      // Grade B+ means A or B; C / D / F fall below the required threshold
      if (grade !== 'A' && grade !== 'B') {
        const criticalHighCount = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
        blockers.push(
          `AgentShield security grade ${grade} is below required B — ` +
            `${criticalHighCount} critical/high finding(s) must be resolved before proceeding`
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`WARNING: AgentShield scan error — ${detail}`);
      toolchainManifest.warnings.push(`AgentShield scan error: ${detail}`);
    }
  }

  // -------------------------------------------------------------------------
  // Step 10: Schema drift detection — non-blocking (some drift expected pre-build)
  // -------------------------------------------------------------------------
  log('step 10: schema drift detection');
  try {
    const sbUrl =
      process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? process.env['FORGE_SUPABASE_URL'] ?? '';
    const sbKey =
      process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? process.env['FORGE_SUPABASE_SERVICE_KEY'] ?? '';
    if (sbUrl && sbKey) {
      const typesPath = join(projectPath, 'src', 'types', 'database.ts');
      const driftReport = await detectSchemaDrift(sbUrl, sbKey, typesPath);
      if (driftReport.hasDrift) {
        const errorCount = driftReport.issues.filter((i) => i.severity === 'error').length;
        const warnCount = driftReport.issues.filter((i) => i.severity === 'warning').length;
        const msg = `Schema drift detected: ${driftReport.issues.length} issue(s) (${errorCount} error(s), ${warnCount} warning(s))`;
        log(`WARNING: ${msg}`);
        toolchainManifest.warnings.push(msg);
        for (const issue of driftReport.issues.slice(0, 5)) {
          log(`  [${issue.severity}] ${issue.issueType}: ${issue.message}`);
        }
      } else {
        log('schema drift: none detected');
      }
    } else {
      log('schema drift: skipped (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set)');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`WARNING: schema drift detection error — ${detail}`);
    toolchainManifest.warnings.push(`Schema drift detection error: ${detail}`);
  }

  // -------------------------------------------------------------------------
  // Step 11: Hook system initialization — load hooks.json + register built-ins
  // -------------------------------------------------------------------------
  log('step 11: initializing hook system');
  let hookManager: HookManager | null = null;
  try {
    hookManager = new HookManager();
    hookManager.loadHooks(projectPath);
    const registeredHooks = hookManager.getHooks();
    log(`hook system ready: ${registeredHooks.length} hook(s) registered`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`WARNING: hook system initialization error — ${detail}`);
    toolchainManifest.warnings.push(`Hook system initialization error: ${detail}`);
  }

  // -------------------------------------------------------------------------
  // Step 12: Load session context from Build Memory
  // -------------------------------------------------------------------------
  log('step 12: loading session context from Build Memory');
  let sessionContext: SessionContext | null = null;
  try {
    const memoryClient = getClient();
    if (memoryClient) {
      sessionContext = await onSessionStart(projectPath, memoryClient);
      log(
        `session context loaded: ${sessionContext.activeErrorPatterns.length} error pattern(s), ` +
          `${sessionContext.applicableInsights.length} applicable insight(s)`
      );
    } else {
      log('session context: skipping (Build Memory unavailable — stateless mode)');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`WARNING: session context load error — ${detail}`);
    toolchainManifest.warnings.push(`Session context load error: ${detail}`);
  }

  // Recompute passed — AgentShield (step 9) may have added blockers after the
  // initial environment-only gate was logged and written to TOOLCHAIN.md.
  const finalPassed = blockers.length === 0;
  if (finalPassed !== passed) {
    log(
      finalPassed
        ? 'Phase 0 gate (final): PASS'
        : `Phase 0 gate (final): FAIL (${blockers.length} blocker(s))`
    );
  }

  return {
    stackFingerprint,
    environmentAudit: audit,
    toolchainManifest,
    passed: finalPassed,
    blockers,
    securityReport,
    hookManager,
    sessionContext,
  };
}

export default runPhase0Scout;



