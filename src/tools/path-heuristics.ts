/**
 * FORGE 2.0 — Path-vs-id heuristics (Session 5 finding #7).
 *
 * `forge status <path>` used to silently misparse a project path as a `build_runs.id` UUID
 * ("No build ./my-project found."). Extracted here (rather than left inline in
 * `src/cli/index.ts`, which runs the whole CLI at import time) so it can be tested directly.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * True when `value` looks like a project PATH rather than a `build_runs.id` UUID — either it
 * contains a path separator, or it resolves to an existing directory on disk. Guarded — a
 * filesystem error degrades to `false` (treat it as a plain id, the historical behavior).
 */
export function looksLikeProjectPath(value: string): boolean {
  if (/[\\/]/.test(value)) return true;
  try {
    const resolved = resolve(value);
    return existsSync(resolved) && statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}
