/**
 * FORGE 2.0 — Native Orchestrator — GovernanceSync.
 *
 * Implements DIRECTIVE-016 natively: before a queue run, every `*.md` governance
 * document at the root of the project's own repo is synced into the FORGE project
 * folder Phase 3 reads governance from. Previously this was a PowerShell step
 * external to FORGE; this module makes it a first-class, in-process orchestrator
 * concern with no shell dependency.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import type { OrchestratorOptions } from './types.js';

export interface SyncResult {
  filesSynced: string[];
  filesSkipped: string[];
  errors: string[];
}

function twoDigit(n: number): string {
  return String(n).padStart(2, '0');
}

/** `[yyyy-MM-dd HH:mm:ss] [LEVEL] message`, matching Phase 3's `renderProgress` format. */
function renderProgress(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  const now = new Date();
  const ts = `${now.getFullYear()}-${twoDigit(now.getMonth() + 1)}-${twoDigit(now.getDate())} ${twoDigit(now.getHours())}:${twoDigit(now.getMinutes())}:${twoDigit(now.getSeconds())}`;
  process.stdout.write(`[${ts}] [${level}] ${message}\n`);
}

/** Extract a human-readable message from any thrown value. */
function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copy every `*.md` file at the root of `projectRepoPath` into `forgeProjectPath`.
 * A file is skipped (not an error) when a same-named file already exists at the
 * destination and is not older than the source — i.e. only a strictly newer source
 * file is re-synced. Never throws: any per-file failure is collected into
 * `errors` and the sync continues with the remaining files.
 */
export function syncGovernanceDocs(projectRepoPath: string, forgeProjectPath: string): SyncResult {
  const result: SyncResult = { filesSynced: [], filesSkipped: [], errors: [] };

  let mdFiles: string[];
  try {
    mdFiles = readdirSync(projectRepoPath).filter((name) => extname(name).toLowerCase() === '.md');
  } catch (error) {
    result.errors.push(`syncGovernanceDocs: cannot read directory "${projectRepoPath}" — ${errMsg(error)}`);
    return result;
  }

  try {
    if (!existsSync(forgeProjectPath)) {
      mkdirSync(forgeProjectPath, { recursive: true });
    }
  } catch (error) {
    result.errors.push(`syncGovernanceDocs: cannot create directory "${forgeProjectPath}" — ${errMsg(error)}`);
    return result;
  }

  for (const fileName of mdFiles) {
    const sourcePath = join(projectRepoPath, fileName);
    const destPath = join(forgeProjectPath, fileName);

    try {
      if (existsSync(destPath)) {
        const sourceMtime = statSync(sourcePath).mtimeMs;
        const destMtime = statSync(destPath).mtimeMs;
        if (sourceMtime <= destMtime) {
          result.filesSkipped.push(fileName);
          continue;
        }
      }

      copyFileSync(sourcePath, destPath);
      result.filesSynced.push(fileName);
      renderProgress('INFO', `[GOVERNANCE] Synced ${fileName} to forge projects folder`);
    } catch (error) {
      result.errors.push(`syncGovernanceDocs: failed to sync "${fileName}" — ${errMsg(error)}`);
    }
  }

  return result;
}

/**
 * Sync a project's governance docs (`options.governanceSyncPath`) into its FORGE
 * project folder (`options.projectPath`) before a queue run, then log a summary.
 */
export function syncBeforeQueueRun(options: OrchestratorOptions): SyncResult {
  const result = syncGovernanceDocs(options.governanceSyncPath, options.projectPath);
  renderProgress('INFO', `[GOVERNANCE] ${result.filesSynced.length} docs synced to ${options.projectPath}`);
  return result;
}

/** Return every doc in `requiredDocs` that is missing from `forgeProjectPath`. */
export function verifyGovernancePresent(forgeProjectPath: string, requiredDocs: string[]): string[] {
  return requiredDocs.filter((doc) => !existsSync(join(forgeProjectPath, doc)));
}
