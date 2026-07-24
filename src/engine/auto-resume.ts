/**
 * FORGE 2.0 â€” `--auto-resume`: automatic session resumption across Claude Code session resets.
 *
 * Phase 3 (`src/phases/phase3-executor.ts`) already appends a progress line to
 * `<governanceDir>/STATE_OF_THE_BUILD.md` after every prompt: `[FORGE Phase 3] prompt N 'id'
 * (type): COMPLETED â€” â€¦`. This module reads that (and SESSION_STATE.md) back to determine the
 * last COMPLETED prompt index, cross-checks Build Memory's `prompt_executions` when rows exist
 * (the higher-fidelity source), and computes where a resumed build should `--start-at`.
 *
 * The RESUME LOOP re-fires `runPhase3Executor` after a claude-runner timeout/exit (session/cap
 * exhaustion) â€” but a genuine Sentinel HALT (the build is actually broken) stops the loop
 * immediately (Iron Law: report real outcomes, never steamroll a halted build). See
 * `PromptOutcome.timedOut` (`src/phases/phase3-executor.ts`) for how the two are told apart.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseQueueYaml, type Phase3Result } from '../phases/phase3-executor.js';
import { queueShortHash } from '../tools/queue-versioning.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import type { BuildRun } from '../types/index.js';

// ---------------------------------------------------------------------------
// State-file parsing (pure â€” no I/O; the exported wrapper below does the reading)
// ---------------------------------------------------------------------------

/**
 * Matches Phase 3's appended progress line:
 *   `[FORGE Phase 3] prompt 7 'users-schema' (schema): COMPLETED â€” Sentinel PASS.`
 * Tolerant of the disposition casing/wording drifting â€” only the numeric index and the
 * disposition keyword are read.
 */
const PROGRESS_LINE_RE = /\[FORGE Phase 3]\s+prompt\s+(\d+)\s+'[^']*'\s*\([^)]*\)\s*:\s*(COMPLETED|FAILED|SKIPPED|HALTED)/gi;

/**
 * Parse Phase 3's appended progress lines out of one or more state-document contents (typically
 * STATE_OF_THE_BUILD.md and SESSION_STATE.md) and return the HIGHEST 1-based prompt index marked
 * COMPLETED. Returns `null` when no COMPLETED line is found (empty content, unparseable content,
 * or a build that never completed a prompt) â€” never throws.
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

/** Fetch the most recent build_run for a project. Returns `null` on any failure or absence. */
async function getMostRecentBuild(projectName: string): Promise<BuildRun | null> {
  try {
    const builds = await BuildMemory.builds.getBuildsByProject(projectName);
    return builds && builds.length > 0 ? (builds[0] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Query Build Memory for the last COMPLETED prompt index of a specific build. Returns `null` when
 * Build Memory is unreachable or the build has no completed prompts â€” the caller then falls back
 * to the state-file parse (Contract 4).
 */
async function getDbLastCompleted(buildId: string): Promise<number | null> {
  try {
    const prompts = await BuildMemory.prompts.getPromptsByBuild(buildId);
    if (!prompts || prompts.length === 0) return null;
    const completedIndices = prompts.filter((p) => p.status === 'completed').map((p) => p.prompt_index);
    return completedIndices.length > 0 ? Math.max(...completedIndices) : null;
  } catch {
    return null;
  }
}

/** Read + hash the queue.yaml currently on disk at `projectPath`. `null` if absent/unreadable/unparseable. */
async function readCurrentQueueState(
  projectPath: string
): Promise<{ hash: string; entryCount: number } | null> {
  const text = await readTextSafe(join(projectPath, 'queue.yaml'));
  if (text === null) return null;
  try {
    const { entries } = parseQueueYaml(text);
    return { hash: queueShortHash(text), entryCount: entries.length };
  } catch {
    return null;
  }
}

/** Fall back to parsing `STATE_OF_THE_BUILD.md` / `SESSION_STATE.md` for the last completed prompt. */
async function computeStartAtFromStateFiles(
  governanceDir: string,
  projectName: string,
  log: (message: string) => void
): Promise<number> {
  const [stateOfBuild, sessionState] = await Promise.all([
    readTextSafe(join(governanceDir, 'STATE_OF_THE_BUILD.md')),
    readTextSafe(join(governanceDir, 'SESSION_STATE.md')),
  ]);
  const lastCompleted = parseLastCompletedFromStateContent(
    [stateOfBuild, sessionState].filter((c): c is string => c !== null)
  );
  if (lastCompleted === null) {
    log('auto-resume: no completed-prompt markers found in Build Memory or state files â€” starting at prompt 1.');
    return 1;
  }
  log(`auto-resume: state files report last completed prompt ${lastCompleted} for "${projectName}"`);
  return lastCompleted + 1;
}

/**
 * Compute the 1-based prompt index a resumed build should `--start-at` (i.e. last completed + 1).
 *
 * Session 5.1 hotfix: before trusting ANY resume source, confirms it belongs to the queue.yaml
 * that is actually on disk right now. A wiped project directory + surviving Build Memory used to
 * produce a `--start-at` computed against the OLD (larger) queue, which then exceeded the length
 * of a freshly regenerated (shorter) queue and made Phase 3 exit having executed zero prompts. Now:
 *   - no queue.yaml on disk yet, or the last recorded build has no `queue_hash` on file (a
 *     pre-hardening build), or its `queue_hash` does not match the current queue.yaml â€” this is
 *     treated as a FRESH build (`--start-at` 1), never a resume, and it is logged loudly.
 *   - otherwise, trusts Build Memory's `prompt_executions` (the higher-fidelity source) when rows
 *     exist for the matching build, else falls back to parsing
 *     `<projectPath>/<governanceDirName>/{STATE_OF_THE_BUILD.md,SESSION_STATE.md}`.
 *   - finally, clamps: if the computed index exceeds the current queue's prompt count, that is
 *     itself a sign the resume source is stale â€” clamp to 1 and log loudly rather than handing
 *     Phase 3 an out-of-range `--start-at` that would fail the build with zero prompts executed.
 */
export async function computeResumeStartAt(
  projectPath: string,
  projectName: string,
  options: { governanceDirName?: string; log?: (message: string) => void } = {}
): Promise<number> {
  const log = options.log ?? (() => {});
  const governanceDir = join(projectPath, options.governanceDirName ?? 'governance');

  const queueState = await readCurrentQueueState(projectPath);
  const mostRecentBuild = await getMostRecentBuild(projectName);

  if (mostRecentBuild && queueState) {
    if (!mostRecentBuild.queue_hash) {
      log(
        `auto-resume: the last recorded build for "${projectName}" has no queue hash on record ` +
          '(pre-hardening build) â€” cannot confirm it matches the current queue.yaml. Treating this as a FRESH build, starting at prompt 1.'
      );
      return 1;
    }
    if (mostRecentBuild.queue_hash !== queueState.hash) {
      log(
        `auto-resume: queue.yaml has changed since the last recorded build for "${projectName}" ` +
          `(recorded hash ${mostRecentBuild.queue_hash}, current hash ${queueState.hash}) â€” ` +
          'checking Build Memory before resetting.'
      );
      const dbLast = await getDbLastCompleted(mostRecentBuild.id);
      if (dbLast !== null && dbLast > 0) {
        const resumeAt = dbLast + 1;
        log("auto-resume: queue hash changed but " + dbLast + " prompt(s) completed — resuming at " + resumeAt);
        if (queueState && resumeAt > queueState.entryCount) return 1;
        return resumeAt;
      }
      log("auto-resume: queue hash changed, no DB completions — fresh build");
      return 1;
    }
  }

  let startAt: number;
  const dbLast = mostRecentBuild ? await getDbLastCompleted(mostRecentBuild.id) : null;
  if (dbLast !== null) {
    log(`auto-resume: Build Memory reports last completed prompt ${dbLast} for "${projectName}" (higher-fidelity source)`);
    startAt = dbLast + 1;
  } else {
    startAt = await computeStartAtFromStateFiles(governanceDir, projectName, log);
  }

  if (queueState && startAt > queueState.entryCount) {
    log(
      `auto-resume: computed start index ${startAt} exceeds the current queue's ${queueState.entryCount} prompt(s) ` +
        'â€” this resume source is stale. Clamping to prompt 1 (fresh build) rather than failing the build.'
    );
    return 1;
  }

  return startAt;
}

// ---------------------------------------------------------------------------
// Resume-cycle bookkeeping
// ---------------------------------------------------------------------------

/**
 * True when `result` ended because the claude-runner subprocess itself timed out or exited
 * abnormally (session/cap exhaustion) on the prompt that halted the build â€” a RESUMABLE
 * condition â€” as opposed to Sentinel finding a genuine defect in code that finished running,
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
      `\n> ${nowIso()} [FORGE auto-resume] cycle ${cycle}: resumed at prompt ${resumedAtIndex} â€” reason: ${reason}\n`,
      'utf8'
    );
  } catch {
    // non-fatal â€” the state document update must never block the build
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
 * run it, and â€” ONLY when the run ended in a resumable claude-runner timeout/exit rather than a
 * genuine Sentinel halt â€” wait `resumeWaitMinutes`, recompute `--start-at` from FRESH state, and
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
    log(`auto-resume cycle ${cycles}/${maxResumes}: ${reason} â€” waiting ${resumeWaitMinutes}m before resuming`);
    await appendResumeNote(options.projectPath, governanceDirName, cycles, startAt, reason);
    await sleep(resumeWaitMinutes * 60_000);

    startAt = await computeResumeStartAt(options.projectPath, options.projectName, { governanceDirName, log });
    startAtHistory.push(startAt);
    log(`auto-resume cycle ${cycles}: resuming from prompt ${startAt}`);
    result = await options.runPhase3(startAt);
  }

  return { finalResult: result, cycles, startAtHistory };
}

