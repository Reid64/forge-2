/**
 * FORGE 2.0 — `--auto-resume`: automatic session resumption across Claude Code session resets.
 *
 * Phase 3 (`src/phases/phase3-executor.ts`) already appends a progress line to
 * `<governanceDir>/STATE_OF_THE_BUILD.md` after every prompt: `[FORGE Phase 3] prompt N 'id'
 * (type): COMPLETED — …`. This module reads that (and SESSION_STATE.md) back to determine the
 * last COMPLETED prompt index, cross-checks Build Memory's `prompt_executions` when rows exist
 * (the higher-fidelity source), and computes where a resumed build should `--start-at`.
 *
 * The RESUME LOOP re-fires `runPhase3Executor` after a claude-runner timeout/exit (session/cap
 * exhaustion) — but a genuine Sentinel HALT (the build is actually broken) stops the loop
 * immediately (Iron Law: report real outcomes, never steamroll a halted build). See
 * `PromptOutcome.timedOut` (`src/phases/phase3-executor.ts`) for how the two are told apart.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Phase3Result } from '../phases/phase3-executor.js';
import { BuildMemory, nowIso } from '../memory/index.js';

// ---------------------------------------------------------------------------
// State-file parsing (pure — no I/O; the exported wrapper below does the reading)
// ---------------------------------------------------------------------------

/**
 * Matches Phase 3's appended progress line:
 *   `[FORGE Phase 3] prompt 7 'users-schema' (schema): COMPLETED — Sentinel PASS.`
 * Tolerant of the disposition casing/wording drifting — only the numeric index and the
 * disposition keyword are read.
 */
const PROGRESS_LINE_RE = /\[FORGE Phase 3]\s+prompt\s+(\d+)\s+'[^']*'\s*\([^)]*\)\s*:\s*(COMPLETED|FAILED|SKIPPED|HALTED)/gi;

/**
 * Parse Phase 3's appended progress lines out of one or more state-document contents (typically
 * STATE_OF_THE_BUILD.md and SESSION_STATE.md) and return the HIGHEST 1-based prompt index marked
 * COMPLETED. Returns `null` when no COMPLETED line is found (empty content, unparseable content,
 * or a build that never completed a prompt) — never throws.
 */
export function parseLastCompletedFromStateContent(contents: readonly string[]): number | null {
  let maxCompleted: number | null = null;
  for (const content of contents) {
    if (!content) continue;
    PROGRESS_LINE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PROGRESS_LINE_RE.exec(content)) !== null) {
      const idx = Number.parseInt(m[1] ?? '', 10);
      const disposition = (m[2] ?? '').toUpperCase();
      if (Number.isFinite(idx) && disposition === 'COMPLETED') {
        maxCompleted = maxCompleted === null ? idx : Math.max(maxCompleted, idx);
      }
    }
  }
  return maxCompleted;
}

/** Read a text file, returning `null` (never throwing) if it cannot be read. */
async function readTextSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Query Build Memory for the last COMPLETED prompt index of a project's most recent build.
 * Returns `null` when Build Memory is unreachable, no build exists for the project, or it has
 * no completed prompts — the caller then falls back to the state-file parse (Contract 4).
 */
async function getDbLastCompleted(projectName: string): Promise<number | null> {
  try {
    const builds = await BuildMemory.builds.getBuildsByProject(projectName);
    const mostRecent = builds && builds.length > 0 ? builds[0] : null;
    if (!mostRecent) return null;
    const prompts = await BuildMemory.prompts.getPromptsByBuild(mostRecent.id);
    if (!prompts || prompts.length === 0) return null;
    const completedIndices = prompts.filter((p) => p.status === 'completed').map((p) => p.prompt_index);
    return completedIndices.length > 0 ? Math.max(...completedIndices) : null;
  } catch {
    return null;
  }
}

/**
 * Compute the 1-based prompt index a resumed build should `--start-at` (i.e. last completed + 1).
 * Trusts Build Memory's `prompt_executions` (the higher-fidelity source) when any rows exist for
 * the project's most recent build; otherwise falls back to parsing
 * `<projectPath>/<governanceDirName>/{STATE_OF_THE_BUILD.md,SESSION_STATE.md}`. When neither
 * source yields a completed-prompt marker, returns 1 (start from the top) and logs a notice.
 */
export async function computeResumeStartAt(
  projectPath: string,
  projectName: string,
  options: { governanceDirName?: string; log?: (message: string) => void } = {}
): Promise<number> {
  const log = options.log ?? (() => {});
  const governanceDir = join(projectPath, options.governanceDirName ?? 'governance');

  const dbLast = await getDbLastCompleted(projectName);
  if (dbLast !== null) {
    log(`auto-resume: Build Memory reports last completed prompt ${dbLast} for "${projectName}" (higher-fidelity source)`);
    return dbLast + 1;
  }

  const [stateOfBuild, sessionState] = await Promise.all([
    readTextSafe(join(governanceDir, 'STATE_OF_THE_BUILD.md')),
    readTextSafe(join(governanceDir, 'SESSION_STATE.md')),
  ]);
  const lastCompleted = parseLastCompletedFromStateContent(
    [stateOfBuild, sessionState].filter((c): c is string => c !== null)
  );
  if (lastCompleted === null) {
    log('auto-resume: no completed-prompt markers found in Build Memory or state files — starting at prompt 1.');
    return 1;
  }
  log(`auto-resume: state files report last completed prompt ${lastCompleted} for "${projectName}"`);
  return lastCompleted + 1;
}

// ---------------------------------------------------------------------------
// Resume-cycle bookkeeping
// ---------------------------------------------------------------------------

/**
 * True when `result` ended because the claude-runner subprocess itself timed out or exited
 * abnormally (session/cap exhaustion) on the prompt that halted the build — a RESUMABLE
 * condition — as opposed to Sentinel finding a genuine defect in code that finished running,
 * which is a real HALT the loop must never steamroll.
 */
export function isResumableTimeout(result: Phase3Result): boolean {
  if (result.status !== 'halted' && result.status !== 'failed') return false;
  const last = result.outcomes[result.outcomes.length - 1];
  return last?.disposition === 'failed' && last.timedOut === true;
}

/** Append one auto-resume cycle note to SESSION_STATE.md. Non-fatal on a write failure. */
async function appendResumeNote(
  projectPath: string,
  governanceDirName: string,
  cycle: number,
  resumedAtIndex: number,
  reason: string
): Promise<void> {
  const target = join(projectPath, governanceDirName, 'SESSION_STATE.md');
  try {
    await appendFile(
      target,
      `\n> ${nowIso()} [FORGE auto-resume] cycle ${cycle}: resumed at prompt ${resumedAtIndex} — reason: ${reason}\n`,
      'utf8'
    );
  } catch {
    // non-fatal — the state document update must never block the build
  }
}

/** Default real-time sleep (injectable for tests). */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The resume loop
// ---------------------------------------------------------------------------

export interface AutoResumeOptions {
  projectPath: string;
  projectName: string;
  governanceDirName?: string;
  /** Run Phase 3 once at the given `--start-at`. Typically `(startAt) => runPhase3Executor({ ...baseOptions, startAt })`. */
  runPhase3: (startAt: number) => Promise<Phase3Result>;
  /** Backoff between resume cycles, in minutes. Default 5. */
  resumeWaitMinutes?: number;
  /** Cap on total resume cycles. Default 20. */
  maxResumes?: number;
  /** Injected sleep (tests). Default a real `setTimeout`. */
  sleepImpl?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface AutoResumeResult {
  finalResult: Phase3Result;
  /** Number of resume cycles actually performed (0 = completed/halted on the first attempt). */
  cycles: number;
  /** The `--start-at` used on each attempt, in order (length = cycles + 1). */
  startAtHistory: number[];
}

/**
 * Drive `runPhase3` with automatic resumption: compute the initial `--start-at` from state,
 * run it, and — ONLY when the run ended in a resumable claude-runner timeout/exit rather than a
 * genuine Sentinel halt — wait `resumeWaitMinutes`, recompute `--start-at` from FRESH state, and
 * re-fire, up to `maxResumes` cycles. A genuine Sentinel HALT (or a clean completion) returns
 * immediately without looping.
 */
export async function runWithAutoResume(options: AutoResumeOptions): Promise<AutoResumeResult> {
  const log = options.log ?? (() => {});
  const governanceDirName = options.governanceDirName ?? 'governance';
  const resumeWaitMinutes = options.resumeWaitMinutes ?? 5;
  const maxResumes = options.maxResumes ?? 20;
  const sleep = options.sleepImpl ?? defaultSleep;

  const startAtHistory: number[] = [];
  let startAt = await computeResumeStartAt(options.projectPath, options.projectName, { governanceDirName, log });
  startAtHistory.push(startAt);

  let result = await options.runPhase3(startAt);
  let cycles = 0;

  while (isResumableTimeout(result) && cycles < maxResumes) {
    cycles += 1;
    const reason = 'claude-runner timeout/exit (session/cap exhaustion)';
    log(`auto-resume cycle ${cycles}/${maxResumes}: ${reason} — waiting ${resumeWaitMinutes}m before resuming`);
    await appendResumeNote(options.projectPath, governanceDirName, cycles, startAt, reason);
    await sleep(resumeWaitMinutes * 60_000);

    startAt = await computeResumeStartAt(options.projectPath, options.projectName, { governanceDirName, log });
    startAtHistory.push(startAt);
    log(`auto-resume cycle ${cycles}: resuming from prompt ${startAt}`);
    result = await options.runPhase3(startAt);
  }

  return { finalResult: result, cycles, startAtHistory };
}
