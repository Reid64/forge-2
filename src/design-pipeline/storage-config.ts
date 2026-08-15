/**
 * FORGE 2.0 — Design Pipeline: storage configuration (`src/design-pipeline/storage-config.ts`).
 *
 * Design artifacts (screenshots, Penpot exports, design-review records, component specs) are
 * comparatively heavy and accumulate quickly across a long-running build — an operator with an
 * external drive attached would rather FORGE use it than silently fill up the `C:` system drive.
 * This module resolves ONE base storage path per process, in this priority order:
 *
 *   1. `FORGE_DESIGN_STORAGE` env var, when set — an explicit operator override always wins.
 *   2. The first drive letter `D:` through `Z:` that both exists and reports more than 100GB free
 *      — treated as an "external drive," even though Windows exposes no reliable removable-vs-
 *      fixed signal via `fs` alone; free space is the practical proxy this module uses.
 *   3. `C:\Users\manag\Documents\forge-design-artifacts\` — the sanctioned fallback when no env
 *      var is set and no other drive qualifies.
 *
 * House style, matching every other module under `src/design-pipeline/`
 * (`screenshotter.ts`/`penpot-integration.ts`/`review-gate.ts`/`index.ts`): every public function
 * is guarded — an unreadable drive, a `statfs` failure, or an unwritable directory degrades to a
 * logged warning and a safe fallback value, NEVER an uncaught exception. Resolving/creating
 * storage is a quality-of-life layer (Contract 4 posture), never a build blocker — a build must
 * still be able to run even when every drive letter is unreadable.
 *
 * NOT IN SCOPE (deliberately): this module does not clean up, rotate, or cap the size of anything
 * it writes into (that is a future retention-policy concern, not this one), and it does not
 * distinguish a genuine external/removable drive from a second internal fixed drive — Node's `fs`
 * has no portable API for that distinction on Windows, so free-space-over-100GB is the deliberate,
 * documented proxy this module uses instead.
 */

import { existsSync, mkdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

import { logLine } from '../tools/forge-logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Explicit operator override — when set, always wins over drive scanning. */
const STORAGE_ENV_VAR = 'FORGE_DESIGN_STORAGE';

/** A drive must report MORE than this many free bytes to qualify as the design-storage target. */
const MIN_FREE_BYTES_FOR_EXTERNAL_DRIVE = 100 * 1024 * 1024 * 1024; // 100GB

/** Sanctioned fallback when no env var is set and no drive D:-Z: qualifies. */
const FALLBACK_STORAGE_PATH = 'C:\\Users\\manag\\Documents\\forge-design-artifacts\\';

/** Drive letters scanned, in order, when no env override is present — D: through Z: (never C:). */
const CANDIDATE_DRIVE_LETTERS: readonly string[] = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** The fixed subdirectory set every design-storage base path is expected to have. */
const STORAGE_SUBDIRECTORIES: readonly string[] = [
  'screenshots',
  'penpot-exports',
  'design-reviews',
  'component-specs',
];

const log = logLine('design-storage');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Render an unknown thrown value as a short string. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The Windows root path for a single drive letter, e.g. `'D'` → `'D:\\'`. */
function driveRoot(letter: string): string {
  return `${letter}:\\`;
}

/** Ensure a base path ends with exactly one trailing backslash, matching the task's stated shape. */
function withTrailingBackslash(basePath: string): string {
  return basePath.endsWith('\\') ? basePath : `${basePath}\\`;
}

/**
 * Best-effort free-byte count for `root` via `fs.statfsSync`. Returns `null` (never throws) when
 * the path doesn't exist, isn't a mount point Node can statfs, or any other read failure occurs —
 * a drive FORGE can't measure is treated the same as a drive with too little free space.
 */
function getFreeBytes(root: string): number | null {
  try {
    const stats = statfsSync(root);
    return stats.bavail * stats.bsize;
  } catch (error) {
    log(`WARNING: could not read free space for '${root}' (${describeError(error)})`);
    return null;
  }
}

/**
 * Scan `D:` through `Z:`, in order, for the first drive that both exists and reports more than
 * {@link MIN_FREE_BYTES_FOR_EXTERNAL_DRIVE} free. Returns the fully-qualified
 * `<letter>:\forge-design-artifacts\` path for the first qualifying drive, or `null` when none
 * qualifies — never throws, an unreadable drive is simply skipped.
 */
function findExternalDriveWithSpace(): string | null {
  for (const letter of CANDIDATE_DRIVE_LETTERS) {
    const root = driveRoot(letter);

    let exists = false;
    try {
      exists = existsSync(root);
    } catch (error) {
      log(`WARNING: could not check drive '${root}' (${describeError(error)})`);
      exists = false;
    }
    if (!exists) continue;

    const freeBytes = getFreeBytes(root);
    if (freeBytes === null) continue;
    if (freeBytes <= MIN_FREE_BYTES_FOR_EXTERNAL_DRIVE) continue;

    const freeGb = Math.round(freeBytes / (1024 * 1024 * 1024));
    log(`found candidate drive '${root}' with ${freeGb}GB free`);
    return withTrailingBackslash(join(root, 'forge-design-artifacts'));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * Resolve the base directory design artifacts (screenshots, Penpot exports, design reviews,
 * component specs) should be written under, in priority order:
 *
 *   1. `FORGE_DESIGN_STORAGE` env var, when set to a non-empty value.
 *   2. The first of `D:` through `Z:` that exists and reports more than 100GB free.
 *   3. `C:\Users\manag\Documents\forge-design-artifacts\`.
 *
 * Always logs the resolved path (`[STORAGE] Design artifacts path: <path>`) before returning it.
 * Never throws — every drive-scan failure degrades to the next candidate, and the fallback path
 * is always a valid string even when every drive letter is unreadable.
 */
export function getDesignStoragePath(): string {
  const envPath = process.env[STORAGE_ENV_VAR]?.trim();
  if (envPath && envPath !== '') {
    const resolvedEnvPath = withTrailingBackslash(envPath);
    log(`[STORAGE] Design artifacts path: ${resolvedEnvPath}`);
    return resolvedEnvPath;
  }

  const externalPath = findExternalDriveWithSpace();
  const resolvedPath = externalPath ?? FALLBACK_STORAGE_PATH;
  log(`[STORAGE] Design artifacts path: ${resolvedPath}`);
  return resolvedPath;
}

/**
 * Create the fixed `screenshots\`, `penpot-exports\`, `design-reviews\`, `component-specs\`
 * subdirectories under `basePath` (recursive — creates `basePath` itself too, if missing). Every
 * subdirectory is created independently; a failure creating one is logged and does not prevent the
 * others from being attempted. Never throws (Contract 4 posture) — a storage-directory failure
 * must never block a build.
 */
export function ensureStorageDirectories(basePath: string): void {
  for (const subdir of STORAGE_SUBDIRECTORIES) {
    const fullPath = join(basePath, subdir);
    try {
      mkdirSync(fullPath, { recursive: true });
    } catch (error) {
      log(`WARNING: could not create storage directory '${fullPath}' (${describeError(error)})`);
    }
  }
}

/**
 * The per-prompt screenshot directory for `buildRunId`/`promptId` under `basePath` —
 * `<basePath>\screenshots\<buildRunId>\<promptId>\`. Pure path computation; does not touch disk
 * (call {@link ensureStorageDirectories}, or create this specific path yourself, before writing
 * into it).
 */
export function getScreenshotPath(basePath: string, buildRunId: string, promptId: string): string {
  return withTrailingBackslash(join(basePath, 'screenshots', buildRunId, promptId));
}

export default getDesignStoragePath;
