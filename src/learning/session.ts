// FORGE 2.0 Learning Engine — Session Orchestration
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { getMachineId } from './database.js';
import { saveToForgeMemory, getForgeMemory } from './queries.js';

const EXCLUDED_TOP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'coverage',
]);

function collectFiles(dir: string, baseDir: string, results: string[]): void {
  const entries: Dirent[] = (() => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  })();

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (EXCLUDED_TOP_DIRS.has(entry.name)) continue;
      if (relPath === '.forge/session_state' || relPath.startsWith('.forge/session_state/')) continue;
      collectFiles(fullPath, baseDir, results);
    } else {
      if (relPath === '.forge/session_state.json') continue;
      results.push(relPath);
    }
  }
}

export function getBuildFingerprint(projectPath: string): string {
  const files: string[] = [];
  collectFiles(projectPath, projectPath, files);
  files.sort();

  const hasher = createHash('sha256');
  for (const relPath of files) {
    try {
      const content = readFileSync(join(projectPath, relPath));
      const fileHash = createHash('sha256').update(content).digest('hex');
      hasher.update(`${relPath}|${fileHash}\n`);
    } catch {
      // skip unreadable files
    }
  }
  return hasher.digest('hex');
}

interface SessionStateParams {
  projectPath: string;
  buildId: string;
  lastPromptExecuted: number;
  endReason: 'COMPLETED' | 'PAUSED' | 'FAILED' | 'INTERRUPTED';
  runStats: {
    promptsExecuted: number;
    promptsPassed: number;
    promptsFailed: number;
    totalTokens: number;
    durationMinutes: number;
  };
  queueStatus: {
    total: number;
    completed: number;
  };
}

export function exportSessionState(params: SessionStateParams): void {
  const forgeDir = join(params.projectPath, '.forge');
  if (!existsSync(forgeDir)) {
    mkdirSync(forgeDir, { recursive: true });
  }

  let gitBranch = 'unknown';
  let gitCommit = 'unknown';
  let gitDirty = false;
  try {
    gitBranch = execSync('git branch --show-current', {
      cwd: params.projectPath,
      encoding: 'utf8',
    }).trim();
    gitCommit = execSync('git rev-parse HEAD', {
      cwd: params.projectPath,
      encoding: 'utf8',
    }).trim();
    const gitStatusOut = execSync('git status --porcelain', {
      cwd: params.projectPath,
      encoding: 'utf8',
    }).trim();
    gitDirty = gitStatusOut.length > 0;
  } catch {
    // git not available
  }

  const fingerprint = getBuildFingerprint(params.projectPath);
  const endTime = new Date();
  const firstPassRate =
    params.runStats.promptsExecuted > 0
      ? params.runStats.promptsPassed / params.runStats.promptsExecuted
      : null;

  const sessionState = {
    build_id: params.buildId,
    project_path: params.projectPath,
    project_name: basename(params.projectPath),
    last_prompt_executed: params.lastPromptExecuted,
    end_reason: params.endReason,
    end_time: endTime.toISOString(),
    git: { branch: gitBranch, commit: gitCommit, dirty: gitDirty },
    fingerprint,
    queue_status: params.queueStatus,
    run_stats: { ...params.runStats, first_pass_rate: firstPassRate },
  };

  writeFileSync(
    join(forgeDir, 'session_state.json'),
    JSON.stringify(sessionState, null, 2),
    'utf8',
  );

  const startTime = new Date(endTime.getTime() - params.runStats.durationMinutes * 60000);
  saveToForgeMemory('build_outcomes', {
    project_name: sessionState.project_name,
    mode: 'GREENFIELD',
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    end_reason: params.endReason,
    total_prompts_planned: params.queueStatus.total,
    total_prompts_executed: params.runStats.promptsExecuted,
    prompts_passed: params.runStats.promptsPassed,
    prompts_retried: 0,
    prompts_failed: params.runStats.promptsFailed,
    total_tokens: params.runStats.totalTokens,
    architecture_decisions: '[]',
    first_pass_rate: firstPassRate,
  });
}

export function resumeForgeSession(
  projectPath: string,
  _dbPath?: string,
): { canResume: boolean; state?: unknown; fingerprintMatch?: boolean } {
  const sessionStatePath = join(projectPath, '.forge', 'session_state.json');
  if (!existsSync(sessionStatePath)) {
    return { canResume: false };
  }

  let state: unknown;
  try {
    const raw = readFileSync(sessionStatePath, 'utf8');
    state = JSON.parse(raw) as unknown;
  } catch {
    return { canResume: false };
  }

  const storedFingerprint = (state as Record<string, unknown>)['fingerprint'] as
    | string
    | undefined;
  const currentFingerprint = getBuildFingerprint(projectPath);
  const fingerprintMatch = storedFingerprint === currentFingerprint;

  return { canResume: true, state, fingerprintMatch };
}

export function testCrashRecovery(
  projectPath: string,
  dbPath?: string,
): { crashed: boolean; recoveryPoint?: unknown } {
  const lockPath = join(projectPath, '.forge', 'forge_running.lock');
  if (!existsSync(lockPath)) {
    return { crashed: false };
  }

  const lockStat = statSync(lockPath);
  const ageMs = Date.now() - lockStat.mtimeMs;
  const FIVE_MINUTES_MS = 5 * 60 * 1000;

  if (ageMs <= FIVE_MINUTES_MS) {
    return { crashed: false };
  }

  let buildId: string | undefined;
  try {
    const lockData = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    buildId = lockData['build_id'] as string | undefined;
  } catch {
    // malformed lock file
  }

  let recoveryPoint: unknown;
  if (buildId) {
    const snapshots = getForgeMemory(
      'compact_snapshots',
      { where: 'build_id = ?', params: [buildId], orderBy: 'prompt_index DESC', limit: 1 },
      dbPath,
    );
    const snapshot = snapshots[0];
    if (snapshot !== undefined) {
      recoveryPoint = snapshot;
    }
  }

  return { crashed: true, recoveryPoint };
}

export function setForgeLock(projectPath: string, buildId: string): void {
  const forgeDir = join(projectPath, '.forge');
  if (!existsSync(forgeDir)) {
    mkdirSync(forgeDir, { recursive: true });
  }
  const lockData = {
    build_id: buildId,
    machine_id: getMachineId(),
    started_at: new Date().toISOString(),
    pid: process.pid,
  };
  writeFileSync(
    join(forgeDir, 'forge_running.lock'),
    JSON.stringify(lockData, null, 2),
    'utf8',
  );
}

export function removeForgeLock(projectPath: string): void {
  const lockPath = join(projectPath, '.forge', 'forge_running.lock');
  try {
    unlinkSync(lockPath);
  } catch {
    // lock doesn't exist or already removed — that's fine
  }
}

export function exportSessionHandoff(projectPath: string, sessionState: unknown): void {
  const forgeDir = join(projectPath, '.forge');
  if (!existsSync(forgeDir)) {
    mkdirSync(forgeDir, { recursive: true });
  }

  const s = sessionState as Record<string, unknown>;
  const runStats = (s['run_stats'] ?? {}) as Record<string, unknown>;
  const queueStatus = (s['queue_status'] ?? {}) as Record<string, unknown>;
  const git = (s['git'] ?? {}) as Record<string, unknown>;
  const buildId = (s['build_id'] as string | undefined) ?? 'unknown';
  const endReason = (s['end_reason'] as string | undefined) ?? 'UNKNOWN';
  const lastPrompt = (s['last_prompt_executed'] as number | undefined) ?? 0;
  const endTime = (s['end_time'] as string | undefined) ?? 'unknown';
  const projectPath_ = (s['project_path'] as string | undefined) ?? projectPath;
  const totalPrompts = (queueStatus['total'] as number | undefined) ?? 0;
  const completedPrompts = (queueStatus['completed'] as number | undefined) ?? 0;

  const lines: string[] = [
    '# FORGE Session Handoff',
    '',
    '## Build Summary',
    `- **Build ID:** ${buildId}`,
    `- **End Reason:** ${endReason}`,
    `- **End Time:** ${endTime}`,
    `- **Last Prompt Executed:** ${lastPrompt}`,
    `- **Git Branch:** ${(git['branch'] as string | undefined) ?? 'unknown'}`,
    `- **Git Commit:** ${(git['commit'] as string | undefined) ?? 'unknown'}`,
    `- **Dirty Working Tree:** ${String(git['dirty'] ?? false)}`,
    '',
    '## Completed This Run',
    `- Prompts executed: ${String(runStats['promptsExecuted'] ?? 0)}`,
    `- Prompts passed: ${String(runStats['promptsPassed'] ?? 0)}`,
    `- First pass rate: ${String(runStats['first_pass_rate'] ?? 'N/A')}`,
    `- Tokens consumed: ${String(runStats['totalTokens'] ?? 0)}`,
    `- Duration: ${String(runStats['durationMinutes'] ?? 0)} minutes`,
    '',
    '## Failed This Run',
    `- Prompts failed: ${String(runStats['promptsFailed'] ?? 0)}`,
    '',
    '## Active Blockers',
    '- None recorded. Check state/halt-reason.md if a halt occurred.',
    '',
    '## Queue Status',
    `- Total prompts: ${totalPrompts}`,
    `- Completed: ${completedPrompts}`,
    `- Remaining: ${totalPrompts - completedPrompts}`,
    '',
    '## Next Run Plan',
    `- Resume from prompt ${lastPrompt + 1}`,
    '- Run quality gates (tsc, lint, build) before beginning',
    '- Verify no stale lock at .forge/forge_running.lock',
    '- Pull latest from forge_memory master before starting',
    '',
    '## Environment Notes',
    `- Project path: ${projectPath_}`,
    '- Ensure node_modules is installed (pnpm install)',
    '- Verify .env.local is present and correct',
    '',
    '## Learning Highlights',
    '- Consult forge_memory.db fix_patterns for error patterns logged this run',
    '- Review pending_evolutions table for proposed FORGE self-improvements',
    '- Update decision_weights manually if architectural choices were made',
  ];

  writeFileSync(join(forgeDir, 'SESSION_HANDOFF.md'), lines.join('\n'), 'utf8');
}
