// FORGE 2.0 - Session Lifecycle: lock file, crash recovery, run start/end
import { existsSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { getBuildFingerprint } from './session.js';

export interface LockFileContent {
  buildId: string;
  pid: number;
  startedAt: string;
  projectPath: string;
  runNumber: number;
}

export interface CrashRecoveryResult {
  recovered: boolean;
  resumeFrom: number;
  snapshotTime: string | null;
  buildId: string | null;
}

export interface RunStartResult {
  fingerprintMismatch: boolean;
  previousFingerprint: string | null;
  currentFingerprint: string;
  resumeFrom: number;
}

export interface RunEndOptions {
  projectPath: string;
  buildId: string;
  runNumber: number;
  lastPromptExecuted: number;
  promptsExecuted: number;
  promptsPassed: number;
  promptsFailed: number;
  endReason: 'COMPLETED' | 'PAUSED' | 'FAILED' | 'INTERRUPTED';
  startTime: Date;
}

function forgeDirPath(projectPath: string): string {
  return join(projectPath, '.forge');
}

function lockFilePath(projectPath: string): string {
  return join(forgeDirPath(projectPath), 'forge_running.lock');
}

function sessionStateFilePath(projectPath: string): string {
  return join(forgeDirPath(projectPath), 'session_state.json');
}

function forgeDbPath(): string {
  return join(homedir(), '.forge', 'forge_memory.db');
}

export function setForgeLock(projectPath: string, buildId: string, runNumber: number): void {
  try {
    mkdirSync(forgeDirPath(projectPath), { recursive: true });
    const content: LockFileContent = {
      buildId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      projectPath,
      runNumber,
    };
    writeFileSync(lockFilePath(projectPath), JSON.stringify(content, null, 2), 'utf8');
  } catch { /* non-fatal */ }
}

export function removeForgeLock(projectPath: string): void {
  try {
    const lp = lockFilePath(projectPath);
    if (existsSync(lp)) rmSync(lp, { force: true });
  } catch { /* non-fatal */ }
}

export function detectStaleLock(projectPath: string): { stale: boolean; ageMinutes: number; content: LockFileContent | null } {
  const lp = lockFilePath(projectPath);
  if (!existsSync(lp)) return { stale: false, ageMinutes: 0, content: null };
  try {
    const content = JSON.parse(readFileSync(lp, 'utf8')) as LockFileContent;
    const ageMinutes = (Date.now() - new Date(content.startedAt).getTime()) / 60_000;
    return { stale: ageMinutes > 5, ageMinutes: Math.round(ageMinutes), content };
  } catch {
    return { stale: true, ageMinutes: 999, content: null };
  }
}

export function checkCrashRecovery(projectPath: string): CrashRecoveryResult {
  const { stale, content } = detectStaleLock(projectPath);
  if (!stale) return { recovered: false, resumeFrom: 0, snapshotTime: null, buildId: null };

  const dbPath = forgeDbPath();
  let resumeFrom = 0;
  let snapshotTime: string | null = null;

  if (existsSync(dbPath)) {
    try {
      const raw = execSync(
        `sqlite3 "${dbPath}" "SELECT prompt_index, created_at FROM compact_snapshots ORDER BY created_at DESC LIMIT 1"`,
        { stdio: 'pipe' }
      ).toString().trim();
      if (raw) {
        const parts = raw.split('|');
        resumeFrom = parseInt(parts[0] ?? '0', 10) || 0;
        snapshotTime = parts[1] ?? null;
      }
    } catch { /* no snapshot -- start from 0 */ }
  }

  removeForgeLock(projectPath);
  console.log(`[SESSION] Crash detected. Recovery point: prompt ${resumeFrom}`);
  return { recovered: true, resumeFrom, snapshotTime, buildId: content?.buildId ?? null };
}

export function onRunStart(projectPath: string, buildId: string, runNumber: number): RunStartResult {
  const recovery = checkCrashRecovery(projectPath);
  if (recovery.recovered) {
    console.log(`[SESSION] Resuming from crash at prompt ${recovery.resumeFrom}`);
  }
  setForgeLock(projectPath, buildId, runNumber);

  let currentFingerprint = '';
  let previousFingerprint: string | null = null;
  let fingerprintMismatch = false;

  try {
    currentFingerprint = getBuildFingerprint(projectPath);
    const statePath = sessionStateFilePath(projectPath);
    if (existsSync(statePath)) {
      const prev = JSON.parse(readFileSync(statePath, 'utf8')) as { buildFingerprint?: string };
      previousFingerprint = prev.buildFingerprint ?? null;
      if (previousFingerprint && previousFingerprint !== currentFingerprint) {
        fingerprintMismatch = true;
        console.warn('[SESSION] Fingerprint mismatch -- files changed between runs.');
      }
    }
  } catch { /* non-fatal */ }

  try {
    execSync(
      `git -C "${projectPath}" tag "FORGE-RUN-${runNumber}-START" 2>/dev/null || true`,
      { stdio: 'pipe' }
    );
  } catch { /* non-fatal */ }

  console.log(`[SESSION] Run ${runNumber} started. Build: ${buildId}`);
  return { fingerprintMismatch, previousFingerprint, currentFingerprint, resumeFrom: recovery.resumeFrom };
}

export function onRunEnd(opts: RunEndOptions): void {
  const { projectPath, buildId, runNumber, lastPromptExecuted, promptsExecuted, promptsPassed, promptsFailed, endReason, startTime } = opts;
  const durationMinutes = Math.round((Date.now() - startTime.getTime()) / 60_000 * 10) / 10;
  const firstPassRate = promptsExecuted > 0 ? Math.round((promptsPassed / promptsExecuted) * 1000) / 1000 : 0;

  try {
    mkdirSync(join(projectPath, '.forge'), { recursive: true });
    let currentFP = '';
    try {
      currentFP = getBuildFingerprint(projectPath);
    } catch { /* non-fatal */ }

    let gitBranch: string | null = null;
    let gitSha: string | null = null;
    let gitDirty = false;
    try { gitBranch = execSync(`git -C "${projectPath}" branch --show-current 2>/dev/null`, { stdio: 'pipe' }).toString().trim() || null; } catch { /* */ }
    try { gitSha = execSync(`git -C "${projectPath}" rev-parse HEAD 2>/dev/null`, { stdio: 'pipe' }).toString().trim() || null; } catch { /* */ }
    try { gitDirty = execSync(`git -C "${projectPath}" status --porcelain 2>/dev/null`, { stdio: 'pipe' }).toString().trim().length > 0; } catch { /* */ }

    const state = {
      buildId,
      projectName: projectPath.split(/[/\\]/).pop() ?? 'unknown',
      projectPath,
      serializedAt: new Date().toISOString(),
      endReason,
      lastPromptExecuted,
      currentPhase: 'EXECUTE',
      currentRunNumber: runNumber,
      gitBranch,
      gitCommitSha: gitSha,
      gitDirty,
      buildFingerprint: currentFP,
      runStats: { promptsExecuted, promptsPassed, promptsFailed, firstPassRate, durationMinutes, startTime: startTime.toISOString() },
    };
    writeFileSync(sessionStateFilePath(projectPath), JSON.stringify(state, null, 2), 'utf8');
  } catch { /* non-fatal */ }

  try {
    const dbPath = forgeDbPath();
    if (existsSync(dbPath)) {
      const pn = (projectPath.split(/[/\\]/).pop() ?? 'unknown').replace(/'/g, "''");
      const si = buildId.replace(/'/g, "''");
      const er = endReason.replace(/'/g, "''");
      const st = startTime.toISOString().replace(/'/g, "''");
      execSync(
        `sqlite3 "${dbPath}" "INSERT OR REPLACE INTO build_outcomes (id,project_name,mode,start_time,end_time,end_reason,total_prompts_executed,prompts_passed,prompts_failed,first_pass_rate,machine_id,created_at) VALUES ('${si}','${pn}','EXECUTE','${st}',datetime('now'),'${er}',${promptsExecuted},${promptsPassed},${promptsFailed},${firstPassRate},'unknown',datetime('now'))"`,
        { stdio: 'pipe' }
      );
    }
  } catch { /* non-fatal */ }

  try {
    execSync(`git -C "${projectPath}" add -A && git -C "${projectPath}" commit -m "FORGE-SESSION-END-RUN-${runNumber}-${endReason}" --allow-empty 2>/dev/null || true`, { stdio: 'pipe' });
    execSync(`git -C "${projectPath}" tag "FORGE-RUN-${runNumber}-END" 2>/dev/null || true`, { stdio: 'pipe' });
  } catch { /* non-fatal */ }

  removeForgeLock(projectPath);
  console.log(`[SESSION] Run ${runNumber} ended. Reason: ${endReason}`);
  console.log(`[SESSION] ${promptsExecuted} executed | ${promptsPassed} passed | ${promptsFailed} failed | ${durationMinutes}m | ${(firstPassRate * 100).toFixed(1)}% first-pass`);
}
