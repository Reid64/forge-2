/**
 * FORGE 2.0 — Project Registry (cross-build project index).
 *
 * ORPHANED (Finding G-1, 2026-09-02 audit): nothing registers to it or reads from it anywhere
 * in src/. The index-maintenance logic is real and complete; no command currently calls it after
 * a build or reads `~/.forge/projects.json` back for any decision.
 *
 * Maintains a small JSON index at `~/.forge/projects.json` mapping each project
 * path FORGE has operated on to:
 *   - the `.env` file FORGE resolved for it (so a later run can reuse it),
 *   - the date FORGE last ran against it,
 *   - the last known build status.
 *
 * This is a convenience index for the CLI (e.g. "which projects has FORGE touched,
 * and where do their secrets live?"), NOT a source of truth — Build Memory remains
 * authoritative for build history. It therefore follows the same degrade-don't-halt
 * house style as the rest of FORGE: every filesystem op is guarded and NOTHING here
 * throws. A missing/corrupt index reads as an empty registry; a failed write is a
 * silent no-op (best-effort) so registration can never break a build.
 *
 * Paths are normalized (resolved to an absolute path) so the same project keys
 * consistently regardless of how it was passed on the command line.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The last build outcome FORGE recorded for a project (free-form, set by callers). */
export type ProjectBuildStatus =
  | 'unknown'
  | 'scouted'
  | 'designed'
  | 'building'
  | 'completed'
  | 'halted'
  | 'failed'
  | 'resurrected'
  | 'repaired';

/** One project's registry entry. */
export interface ProjectRecord {
  /** Absolute, normalized project path (also the map key). */
  path: string;
  /** Absolute path of the `.env` file FORGE resolved for this project, or null. */
  envPath: string | null;
  /** ISO-8601 timestamp of the last FORGE run against this project, or null. */
  lastRunAt: string | null;
  /** The last known build status. */
  buildStatus: ProjectBuildStatus;
}

/** The on-disk shape of `~/.forge/projects.json`: path → record. */
type ProjectRegistryFile = Record<string, ProjectRecord>;

// ---------------------------------------------------------------------------
// Location helpers
// ---------------------------------------------------------------------------

/** Directory that holds FORGE's per-user state: `~/.forge`. */
function forgeHomeDir(): string {
  return join(homedir(), '.forge');
}

/** Absolute path of the registry file: `~/.forge/projects.json`. */
export function registryPath(): string {
  return join(forgeHomeDir(), 'projects.json');
}

/** Normalize a project path to an absolute path so keys are stable. */
function normalizePath(projectPath: string): string {
  return resolve(projectPath);
}

// ---------------------------------------------------------------------------
// Load / save (guarded — never throw)
// ---------------------------------------------------------------------------

/** Read the registry file. A missing/corrupt file reads as an empty registry. */
async function loadRegistry(): Promise<ProjectRegistryFile> {
  let text: string;
  try {
    text = await readFile(registryPath(), 'utf8');
  } catch {
    return {}; // no file yet → empty registry
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as ProjectRegistryFile;
  } catch {
    return {}; // corrupt JSON → treat as empty rather than crashing a build
  }
}

/** Write the registry file (creating `~/.forge` if needed). Best-effort; never throws. */
async function saveRegistry(registry: ProjectRegistryFile): Promise<boolean> {
  try {
    await mkdir(forgeHomeDir(), { recursive: true });
    await writeFile(registryPath(), JSON.stringify(registry, null, 2), 'utf8');
    return true;
  } catch {
    return false; // best-effort — registration must never break a build
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register (or update) a project's `.env` location, stamping the run time. Returns
 * the stored {@link ProjectRecord}, or `null` if the registry could not be written
 * (degraded mode — the caller proceeds regardless).
 *
 * An existing record's `buildStatus` is preserved unless `status` is supplied, so a
 * plain re-registration does not clobber a previously recorded outcome.
 */
export async function registerProject(
  projectPath: string,
  envPath: string | null,
  status?: ProjectBuildStatus
): Promise<ProjectRecord | null> {
  const key = normalizePath(projectPath);
  const registry = await loadRegistry();
  const previous = registry[key];

  const record: ProjectRecord = {
    path: key,
    envPath: envPath !== null ? resolve(envPath) : null,
    lastRunAt: new Date().toISOString(),
    buildStatus: status ?? previous?.buildStatus ?? 'unknown',
  };

  registry[key] = record;
  const ok = await saveRegistry(registry);
  return ok ? record : null;
}

/**
 * Look up a project's registry record by path. Returns `null` when the project has
 * not been registered (or the registry is unreadable).
 */
export async function lookupProject(projectPath: string): Promise<ProjectRecord | null> {
  const key = normalizePath(projectPath);
  const registry = await loadRegistry();
  return registry[key] ?? null;
}

/** List every registered project (most-recently-run first). */
export async function listProjects(): Promise<ProjectRecord[]> {
  const registry = await loadRegistry();
  return Object.values(registry).sort((a, b) => (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? ''));
}
