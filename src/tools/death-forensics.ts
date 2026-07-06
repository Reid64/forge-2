/**
 * FORGE 2.0 — Death forensics + stale-lock recovery (Session 5 — Field Hardening, finding #13).
 *
 * The dialtest run died silently ~8 times with zero forensics — the only record was console
 * history, which is gone the moment the terminal closes. This module gives every FORGE build a
 * last-words file: `process.on('exit'/'uncaughtException'/'unhandledRejection')` handlers write
 * `<project>/.forge/death-report.md` (timestamp, the prompt that was running, the exit reason,
 * and the last 50 log lines) before the process goes down. It also maintains
 * `<project>/.forge/forge_running.lock` so the NEXT build can detect that a prior run died
 * without ever reaching its own finally block, and recover instead of silently ignoring it.
 *
 * NON-FATAL house style: every write here is best-effort (sync, guarded) — forensics must never
 * be the reason a shutdown hangs or a build fails.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toAsciiGovernanceText } from './governance-text.js';

// ---------------------------------------------------------------------------
// Recent-log ring buffer (feeds the death report's "last 50 log lines")
// ---------------------------------------------------------------------------

const MAX_LOG_LINES = 50;
let recentLogLines: string[] = [];

/** Feed a log line into the ring buffer death reports draw from. Never throws. */
export function recordLogLine(line: string): void {
  recentLogLines.push(line);
  if (recentLogLines.length > MAX_LOG_LINES) {
    recentLogLines = recentLogLines.slice(-MAX_LOG_LINES);
  }
}

/** Current ring-buffer snapshot (most recent last), for tests / diagnostics. */
export function getRecentLogLines(): string[] {
  return [...recentLogLines];
}

/** Reset the ring buffer (tests only). */
export function clearRecentLogLines(): void {
  recentLogLines = [];
}

// ---------------------------------------------------------------------------
// forge_running.lock
// ---------------------------------------------------------------------------

interface RunLockContent {
  pid: number;
  buildRunId: string | null;
  startedAt: string;
}

function lockPath(projectPath: string): string {
  return join(projectPath, '.forge', 'forge_running.lock');
}

/** Write `forge_running.lock` for this process. Best-effort — a write failure is swallowed. */
export function acquireRunLock(projectPath: string, buildRunId: string | null): void {
  try {
    const dir = join(projectPath, '.forge');
    mkdirSync(dir, { recursive: true });
    const content: RunLockContent = { pid: process.pid, buildRunId, startedAt: new Date().toISOString() };
    writeFileSync(lockPath(projectPath), JSON.stringify(content, null, 2), 'utf8');
  } catch {
    /* best-effort — a missing lock just means the next build's stale check finds nothing */
  }
}

/** Remove `forge_running.lock`. Best-effort. */
export function releaseRunLock(projectPath: string): void {
  try {
    rmSync(lockPath(projectPath), { force: true });
  } catch {
    /* best-effort */
  }
}

/** True when a process with this pid is currently alive (POSIX signal-0 probe / Windows equivalent). */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StaleLockCheck {
  /** Whether a lock file was present at all. */
  found: boolean;
  /** True when a lock was found AND its pid is not alive (or the file was corrupt) — a prior silent death. */
  stale: boolean;
  pid: number | null;
  buildRunId: string | null;
  startedAt: string | null;
}

/**
 * Check for a stale `forge_running.lock` at build startup. A lock whose pid is no longer running
 * means a PRIOR FORGE run died before reaching its own cleanup (Session 5 finding #13) — log it,
 * clear the lock, and let the caller continue (never block a new build on a dead one's leftovers).
 */
export function checkStaleLock(projectPath: string, log: (message: string) => void): StaleLockCheck {
  const path = lockPath(projectPath);
  if (!existsSync(path)) {
    return { found: false, stale: false, pid: null, buildRunId: null, startedAt: null };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunLockContent>;
    const pid = typeof raw.pid === 'number' ? raw.pid : null;
    const buildRunId = raw.buildRunId ?? null;
    const startedAt = raw.startedAt ?? null;
    const alive = pid !== null && isPidAlive(pid);
    if (alive) {
      return { found: true, stale: false, pid, buildRunId, startedAt };
    }
    log(
      `WARNING: stale forge_running.lock found (pid ${pid ?? '?'} is not running; build ${buildRunId ?? '(unknown)'}, ` +
        `started ${startedAt ?? '(unknown)'}) — a prior FORGE run died silently without cleaning up. Clearing lock and continuing.`
    );
    rmSync(path, { force: true });
    return { found: true, stale: true, pid, buildRunId, startedAt };
  } catch {
    log('WARNING: forge_running.lock is unreadable/corrupt — treating as stale, clearing it and continuing.');
    try {
      rmSync(path, { force: true });
    } catch {
      /* best-effort */
    }
    return { found: true, stale: true, pid: null, buildRunId: null, startedAt: null };
  }
}

// ---------------------------------------------------------------------------
// Process-level exit forensics
// ---------------------------------------------------------------------------

export interface DeathStateSnapshot {
  buildRunId: string | null;
  currentPromptIndex: number | null;
  currentPromptId: string | null;
}

export interface InstallDeathForensicsOptions {
  projectPath: string;
  /** Read the CURRENT build/prompt state at the moment of death (called synchronously). */
  getState: () => DeathStateSnapshot;
  /**
   * Best-effort async finalize of the build_run row once a death is observed. Given the
   * `build_runs.status` CHECK constraint (queued/running/completed/failed/halted — no
   * 'interrupted' value; changing it would require a live-data table rebuild, which this
   * hardening pass deliberately avoids) this sets `status: 'halted'` and folds a
   * `_forge_interrupted` marker into `toolchain_manifest` (the same jsonb-note pattern already
   * used for Build Replay linkage) so a silent death is still distinguishable from a real
   * Sentinel halt when reading the row back.
   */
  finalizeBuildAsInterrupted: (buildRunId: string, reason: string) => Promise<void>;
}

// Module-level so the `process.on` listeners (installed exactly once per process) always read
// the ACTIVE build's state — re-installing (e.g. a verify script running several builds in one
// process) just repoints these refs rather than stacking duplicate listeners.
let active: InstallDeathForensicsOptions | null = null;
let listenersInstalled = false;

/** Render + write `<project>/.forge/death-report.md`. Synchronous and guarded — never throws. Exported for direct testing (verify-hardening.mjs) without touching process.on/process.exit. */
export function writeDeathReport(projectPath: string, state: DeathStateSnapshot, reason: string): void {
  try {
    const dir = join(projectPath, '.forge');
    mkdirSync(dir, { recursive: true });
    const lines = [
      '# FORGE death report',
      '',
      '> Written automatically by src/tools/death-forensics.ts when the FORGE process went down',
      '> unexpectedly. This is the forensic record a crashed run used to leave nothing behind.',
      '',
      `- Timestamp: ${new Date().toISOString()}`,
      `- Build run: ${state.buildRunId ?? '(stateless)'}`,
      `- Current prompt: ${state.currentPromptIndex ?? '(none)'} '${state.currentPromptId ?? '(none)'}'`,
      `- Exit reason: ${reason}`,
      '',
      '## Last log lines (up to 50)',
      '',
      '```',
      ...(getRecentLogLines().length > 0 ? getRecentLogLines() : ['(no log lines captured before death)']),
      '```',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'death-report.md'), toAsciiGovernanceText(lines), 'utf8');
  } catch {
    /* best-effort — forensics must never throw during a crash */
  }
}

/**
 * Install the process-wide death handlers (idempotent — safe to call once per build; only the
 * FIRST call in a process registers the actual `process.on` listeners). Call again for each new
 * build within the same process to repoint the active state/finalize callbacks.
 */
export function installDeathForensics(options: InstallDeathForensicsOptions): void {
  active = options;
  if (listenersInstalled) return;
  listenersInstalled = true;

  const handleFatal = (reason: string): void => {
    const current = active;
    if (!current) return;
    const state = current.getState();
    writeDeathReport(current.projectPath, state, reason);
    if (state.buildRunId) {
      current
        .finalizeBuildAsInterrupted(state.buildRunId, reason)
        .catch(() => {})
        .finally(() => process.exit(1));
    } else {
      process.exit(1);
    }
  };

  process.on('uncaughtException', (error) => {
    handleFatal(`uncaughtException: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  });
  process.on('unhandledRejection', (reason) => {
    // Node does not crash the process on an unhandled rejection by default — record it as
    // forensic evidence but do not force an exit (matches the runtime's own default posture).
    const current = active;
    if (!current) return;
    writeDeathReport(
      current.projectPath,
      current.getState(),
      `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`
    );
  });
  process.on('exit', (code) => {
    const current = active;
    if (current) {
      if (code !== 0) writeDeathReport(current.projectPath, current.getState(), `process exit code ${code}`);
      releaseRunLock(current.projectPath);
    }
  });
}

/** Clear the active build's state after a NORMAL completion, so a later crash in the same process (a different build) never misattributes itself to the finished one. */
export function clearDeathForensicsState(): void {
  active = null;
}
