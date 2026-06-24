// FORGE 2.0 Learning Engine — Integration Bridge
// Connects learning engine to existing executor. All operations are non-critical:
// if any learning call fails, log and continue. Never crash the build.
import { initializeForgeMemory, getMachineId } from './database.js';
import { saveToForgeMemory } from './queries.js';
import { scorePromptExecution, captureError, checkAutoElevation, updateDecisionWeights, loadCrossProjectKnowledge, analyzeForEvolutions, presentEvolutions } from './loops.js';
import { syncForgeMemory, loadSyncConfig } from './sync.js';
import { testCrashRecovery, setForgeLock, removeForgeLock, resumeForgeSession, exportSessionState, exportSessionHandoff } from './session.js';
import type { GovernanceRule, SkillEntry, FixPattern } from './types.js';

/**
 * Called once at the start of a FORGE build run.
 * Initializes learning, checks for crashes, loads knowledge.
 * Returns loaded knowledge for the executor to use.
 */
export async function onRunStart(
  projectPath: string,
  buildId: string,
  techStackTags: string[],
  projectName: string,
  dbPath?: string
): Promise<{
  knowledge: {
    rules: GovernanceRule[];
    skills: SkillEntry[];
    fixPatterns: FixPattern[];
    outcomes: any[];
    evolutions: any[];
  };
  resumeState: any | null;
}> {
  const emptyKnowledge = { rules: [], skills: [], fixPatterns: [], outcomes: [], evolutions: [] };
  try {
    // 1. Initialize the learning database (creates if not exists)
    initializeForgeMemory(dbPath);
    console.log('[FORGE Learning] Database initialized');

    // 2. Check for crash recovery (stale lock from prior crashed run)
    const crashCheck = testCrashRecovery(projectPath, dbPath);
    if (crashCheck.crashed) {
      console.warn('[FORGE Learning] Crash detected from prior run. Recovery point available:', !!crashCheck.recoveryPoint);
    }

    // 3. Set the running lock for this build
    setForgeLock(projectPath, buildId);

    // 4. Sync pull from master (graceful if master unavailable)
    try {
      const syncConfig = loadSyncConfig();
      if (syncConfig.master_path) {
        const localDb = dbPath || (await import('./database.js')).getForgeDbPath();
        const masterDb = syncConfig.master_path;
        const machineId = getMachineId(dbPath);
        const result = syncForgeMemory('pull', localDb, masterDb, machineId);
        if (result.synced > 0) {
          console.log(`[FORGE Learning] Pulled ${result.synced} records from master`);
        }
      }
    } catch { /* sync is non-critical */ }

    // 5. Load cross-project knowledge
    const knowledge = loadCrossProjectKnowledge(techStackTags, projectName, dbPath);

    // 6. Present pending evolutions
    const evolutions = presentEvolutions(dbPath);
    if (evolutions.length > 0) {
      console.log(`[FORGE Learning] ${evolutions.length} pending evolution proposals:`);
      for (const evo of evolutions.slice(0, 5)) {
        console.log(`  [${evo.evolution_type}] ${evo.proposed_change} (confidence: ${evo.confidence})`);
      }
    }

    // 7. Check for session resumption
    let resumeState = null;
    try {
      const resumeCheck = resumeForgeSession(projectPath, dbPath);
      if (resumeCheck.canResume) {
        resumeState = resumeCheck.state;
        console.log(`[FORGE Learning] Prior session found. Fingerprint match: ${resumeCheck.fingerprintMatch}`);
      }
    } catch { /* resume check is non-critical */ }

    // 8. Record build start
    try {
      saveToForgeMemory('build_outcomes', {
        project_name: projectName,
        mode: 'RETROFIT',
        start_time: new Date().toISOString(),
        total_prompts_planned: 0,
        total_prompts_executed: 0,
        prompts_passed: 0,
        prompts_retried: 0,
        prompts_failed: 0,
        total_tokens: 0,
      }, dbPath);
    } catch { /* non-critical */ }

    return { knowledge, resumeState };
  } catch (err) {
    console.error('[FORGE Learning] onRunStart failed (non-critical):', err);
    return { knowledge: emptyKnowledge, resumeState: null };
  }
}

/**
 * Called after each prompt completes (pass or fail).
 * Records the result in the learning database.
 */
export function onPromptComplete(result: {
  promptId: string;
  success: boolean;
  retryCount: number;
  tokensConsumed: number;
  gatePassRate: number;
  errorOutput?: string;
  buildId: string;
  projectName: string;
  taskType: string;
  techStackTags: string[];
  templateHash: string;
}, dbPath?: string): void {
  try {
    // Loop 1: Score the prompt execution
    scorePromptExecution({
      templateHash: result.templateHash,
      taskType: result.taskType,
      techStackTags: result.techStackTags,
      firstPassSuccess: result.success,
      retryCount: result.retryCount,
      tokensConsumed: result.tokensConsumed,
      gatePassRate: result.gatePassRate,
      driftScore: 0, // computed elsewhere if needed
      projectName: result.projectName,
      buildId: result.buildId,
    }, dbPath);

    // Loop 2: If failed, capture the error pattern
    if (!result.success && result.errorOutput) {
      // Parse error output for error code, file path, message
      const errorLines = result.errorOutput.split('\n').filter(l => l.trim());
      for (const line of errorLines.slice(0, 5)) { // Process up to 5 errors per prompt
        const tsMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)/);
        if (tsMatch) {
          const [, filePath, , , errorCode, errorMessage] = tsMatch;
          const captured = captureError({
            errorCode: errorCode ?? '',
            filePath: filePath ?? '',
            errorMessage: errorMessage ?? '',
            errorCategory: 'COMPILE',
            techStack: result.techStackTags,
          }, dbPath);

          // Check if this error should be elevated to a governance rule
          if (captured.isKnown) {
            checkAutoElevation(captured.fingerprint, dbPath);
          }
        }
      }
    }
  } catch (err) {
    // Learning failures must NEVER crash the build
    console.error('[FORGE Learning] onPromptComplete failed (non-critical):', err);
  }
}

/**
 * Called once at the end of a FORGE build run.
 * Saves state, analyzes for improvements, syncs to master.
 * Lock is ALWAYS released, even on error.
 */
export async function onRunEnd(
  buildId: string,
  projectPath: string,
  runStats: {
    promptsExecuted: number;
    promptsPassed: number;
    promptsFailed: number;
    totalTokens: number;
    startTime: string;
  },
  dbPath?: string
): Promise<void> {
  try {
    // 1. Export session state
    try {
      exportSessionState({
        projectPath,
        buildId,
        lastPromptExecuted: runStats.promptsExecuted,
        endReason: runStats.promptsFailed > 0 ? 'FAILED' : 'COMPLETED',
        runStats: {
          promptsExecuted: runStats.promptsExecuted,
          promptsPassed: runStats.promptsPassed,
          promptsFailed: runStats.promptsFailed,
          totalTokens: runStats.totalTokens,
          durationMinutes: Math.round((Date.now() - new Date(runStats.startTime).getTime()) / 60000),
        },
        queueStatus: { total: runStats.promptsExecuted, completed: runStats.promptsPassed },
      });
    } catch (err) { console.error('[FORGE Learning] Session state export failed:', err); }

    // 2. Loop 3: Update decision weights
    try { updateDecisionWeights(buildId, dbPath); } catch { /* non-critical */ }

    // 3. Loop 5: Analyze for evolutions
    try {
      const proposals = analyzeForEvolutions(buildId, dbPath);
      if (proposals.length > 0) {
        console.log(`[FORGE Learning] Generated ${proposals.length} evolution proposals for review`);
      }
    } catch { /* non-critical */ }

    // 4. Generate session handoff document
    try {
      const state = { buildId, projectPath, runStats, timestamp: new Date().toISOString() };
      exportSessionHandoff(projectPath, state);
      console.log('[FORGE Learning] Session handoff generated');
    } catch { /* non-critical */ }

    // 5. Sync push to master
    try {
      const syncConfig = loadSyncConfig();
      if (syncConfig.master_path) {
        const localDb = dbPath || (await import('./database.js')).getForgeDbPath();
        const machineId = getMachineId(dbPath);
        const result = syncForgeMemory('push', localDb, syncConfig.master_path, machineId);
        if (result.synced > 0) {
          console.log(`[FORGE Learning] Pushed ${result.synced} records to master`);
        }
      }
    } catch { /* sync is non-critical */ }
  } finally {
    // 6. ALWAYS remove the running lock — even if everything above failed
    removeForgeLock(projectPath);
  }
}

export { handlePreToolUse } from './hooks-enhanced.js';
export { detectStaleLock, checkCrashRecovery } from './session-lifecycle.js';
export { setForgeLock as setForgeLockV2, removeForgeLock as removeForgeLockV2 } from './session-lifecycle.js';
export type { LockFileContent, CrashRecoveryResult, RunStartResult, RunEndOptions } from './session-lifecycle.js';
export { generateSessionHandoff } from './handoff-generator.js';
export type { HandoffOptions } from './handoff-generator.js';
