/**
 * FORGE 2.0 — Concurrent-session scratch lock (companion to `src/engine/path-classifier.ts`'s
 * scratch-write enforcement and `src/engine/scratch-promote.ts`'s `promote_scratch` gate).
 *
 * Two FORGE sessions running concurrently against the SAME project can both pick up a prompt that
 * declares a `shared_canonical` output (a governance/decision doc) at roughly the same time. The
 * scratch-write redirect already stops them from clobbering the CANONICAL file directly — each
 * session writes its own per-prompt scratch copy — but nothing stopped them from racing on the
 * eventual PROMOTION of that scratch content back onto the canonical path (`promote_scratch`),
 * which is exactly the collision the whole scratch-then-promote pattern exists to prevent. This
 * module is the lock that serializes that: before a `shared_canonical`-path prompt begins
 * execution, it must acquire a lock keyed on the canonical path; the lock is held for the
 * duration of the (single-session, single-process) scratch write and released the moment that
 * write completes — NOT when promotion later completes, since promotion may run in a different
 * prompt/entry entirely and must not be blocked waiting on a lock this session already holds.
 *
 * The lock file lives at `docs/_forge-scratch/.locks/{sha256(canonicalPath)}.lock` (the hash keeps
 * the filename filesystem-safe regardless of the canonical path's own characters/depth) and
 * carries `{ queue_id, prompt_id, pid, acquired_at }` — the same shape `src/tools/death-
 * forensics.ts`'s `forge_running.lock` uses for its own crash-recovery record. Unlike that lock,
 * whose staleness check is PID-liveness (valid only because it is always read on the SAME
 * machine), this lock's staleness check is TIME-based: a genuinely concurrent second FORGE
 * session may be running on a different machine entirely, where this machine's `isPidAlive` probe
 * on a foreign pid is meaningless. A lock older than the configurable staleness threshold
 * (default 30 minutes) is treated as abandoned — a crashed session's lock is reclaimed
 * automatically rather than deadlocking every future run against this canonical path forever.
 *
 * Acquisition is atomic (`fs.writeFileSync(..., { flag: 'wx' })`, which fails with `EEXIST` if the
 * file already exists) — two processes racing to create the same lock file can never both believe
 * they hold it, unlike an existsSync-then-write check/act pair.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { normalizePath } from './path-classifier.js';

/** Default staleness threshold (ms) before an unreleased lock is treated as abandoned and reclaimed. */
export const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000;
/** Default total time (ms) a caller waits/retries for a held, non-stale lock before giving up. */
export const DEFAULT_LOCK_MAX_WAIT_MS = 5 * 60 * 1000;
/** Default delay (ms) between acquisition retries while a lock is held and not yet stale. */
export const DEFAULT_LOCK_POLL_INTERVAL_MS = 5_000;

/** The persisted shape of one `.lock` file. */
export interface ScratchLockContent {
  queue_id: string;
  prompt_id: string;
  pid: number;
  /** ISO 8601 timestamp of acquisition. */
  acquired_at: string;
}

/** The directory every scratch lock file lives under, relative to the project root. */
export function scratchLocksDir(projectPath: string): string {
  return join(projectPath, 'docs', '_forge-scratch', '.locks');
}

/** The lock file path for one canonical path — `docs/_forge-scratch/.locks/{sha256(canonicalPath)}.lock`. */
export function scratchLockPath(projectPath: string, canonicalPath: string): string {
  const hash = createHash('sha256').update(normalizePath(canonicalPath)).digest('hex');
  return join(scratchLocksDir(projectPath), `${hash}.lock`);
}

/** Options for {@link acquireScratchLock}. */
export interface AcquireScratchLockOptions {
  projectPath: string;
  canonicalPath: string;
  queueId: string;
  promptId: string;
  /** Age (ms) after which an unreleased lock is reclaimed as abandoned. Default 30 minutes. */
  staleMs?: number;
  /** Total time (ms) to wait/retry for a held, non-stale lock before giving up. Default 5 minutes. */
  maxWaitMs?: number;
  /** Delay (ms) between retries. Default 5 seconds. */
  pollIntervalMs?: number;
  log?: (message: string) => void;
  /** Injectable sleep (tests). Default `setTimeout`-based. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable clock (tests). Default `Date.now`. */
  nowMs?: () => number;
}

/** The outcome of an {@link acquireScratchLock} call. */
export interface AcquireScratchLockResult {
  acquired: boolean;
  lockPath: string;
  /** Total time spent waiting/retrying before the final acquire attempt (0 when acquired immediately). */
  waitedMs: number;
  /** True when acquisition succeeded by reclaiming a prior session's stale lock. */
  reclaimedStale: boolean;
  /** Present when `acquired` is false — why the caller should not proceed. */
  reason?: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Read + parse a lock file. Returns `null` for a missing/corrupt/unreadable file (treated as reclaimable). */
function readLock(lockPath: string): ScratchLockContent | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<ScratchLockContent>;
    if (
      typeof raw.queue_id !== 'string' ||
      typeof raw.prompt_id !== 'string' ||
      typeof raw.pid !== 'number' ||
      typeof raw.acquired_at !== 'string'
    ) {
      return null;
    }
    return { queue_id: raw.queue_id, prompt_id: raw.prompt_id, pid: raw.pid, acquired_at: raw.acquired_at };
  } catch {
    return null;
  }
}

/** Attempt a single atomic create of the lock file. Returns `true` on success, `false` if it already exists. */
function tryCreateLock(lockPath: string, content: ScratchLockContent): boolean {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify(content, null, 2), { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') return false;
    // Any other failure (permissions, disk full, missing parent that mkdirSync itself couldn't
    // create, …) is surfaced the same way as "could not acquire" — the caller waits/retries and
    // eventually times out with a clear reason rather than crashing the build loop.
    return false;
  }
}

/**
 * Acquire the scratch lock for `canonicalPath`, waiting/retrying while it is held by a non-stale
 * lock, and reclaiming it immediately once it is stale. Never throws — a failure to acquire
 * within `maxWaitMs` is reported via `acquired: false`, never as an exception, so the caller can
 * degrade this ONE prompt to `skipped` rather than aborting the whole build.
 */
export async function acquireScratchLock(options: AcquireScratchLockOptions): Promise<AcquireScratchLockResult> {
  const {
    projectPath,
    canonicalPath,
    queueId,
    promptId,
    staleMs = DEFAULT_LOCK_STALE_MS,
    maxWaitMs = DEFAULT_LOCK_MAX_WAIT_MS,
    pollIntervalMs = DEFAULT_LOCK_POLL_INTERVAL_MS,
    log = () => {},
    sleepImpl = defaultSleep,
    nowMs = () => Date.now(),
  } = options;

  const lockPath = scratchLockPath(projectPath, canonicalPath);
  const startedAt = nowMs();
  let reclaimedStale = false;

  for (;;) {
    const content: ScratchLockContent = {
      queue_id: queueId,
      prompt_id: promptId,
      pid: process.pid,
      acquired_at: new Date(nowMs()).toISOString(),
    };
    if (tryCreateLock(lockPath, content)) {
      return { acquired: true, lockPath, waitedMs: nowMs() - startedAt, reclaimedStale };
    }

    const held = readLock(lockPath);
    if (held === null) {
      // Corrupt/unreadable lock file — treat as abandoned and reclaim it immediately.
      log(`scratch-lock: ${lockPath} is unreadable/corrupt — treating as stale and reclaiming.`);
      rmSync(lockPath, { force: true });
      reclaimedStale = true;
      continue;
    }

    const ageMs = nowMs() - Date.parse(held.acquired_at);
    if (!Number.isFinite(ageMs) || ageMs > staleMs) {
      log(
        `scratch-lock: ${lockPath} held by queue '${held.queue_id}' prompt '${held.prompt_id}' (pid ${held.pid}) ` +
          `is stale (age ${Math.round(ageMs / 1000)}s > threshold ${Math.round(staleMs / 1000)}s) — reclaiming.`
      );
      rmSync(lockPath, { force: true });
      reclaimedStale = true;
      continue;
    }

    const waitedMs = nowMs() - startedAt;
    if (waitedMs >= maxWaitMs) {
      return {
        acquired: false,
        lockPath,
        waitedMs,
        reclaimedStale,
        reason:
          `scratch lock for '${canonicalPath}' is held by queue '${held.queue_id}' prompt '${held.prompt_id}' ` +
          `(pid ${held.pid}, acquired ${held.acquired_at}) and did not become free/stale within ` +
          `${Math.round(maxWaitMs / 1000)}s.`,
      };
    }

    log(
      `scratch-lock: ${lockPath} held by queue '${held.queue_id}' prompt '${held.prompt_id}' — waiting ` +
        `${Math.round(pollIntervalMs / 1000)}s before retrying (${Math.round(waitedMs / 1000)}s / ${Math.round(maxWaitMs / 1000)}s elapsed).`
    );
    await sleepImpl(pollIntervalMs);
  }
}

/** Release the scratch lock for `canonicalPath`. Best-effort — a missing/already-released lock is a no-op. */
export function releaseScratchLock(projectPath: string, canonicalPath: string, log: (message: string) => void = () => {}): void {
  const lockPath = scratchLockPath(projectPath, canonicalPath);
  try {
    if (existsSync(lockPath)) rmSync(lockPath, { force: true });
  } catch (err) {
    log(`scratch-lock: release of ${lockPath} failed (best-effort, ignored) — ${err instanceof Error ? err.message : String(err)}`);
  }
}
