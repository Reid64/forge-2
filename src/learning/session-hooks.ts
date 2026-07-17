// FORGE 2.0 - Session Hook Implementations: SessionStart and SessionEnd
import { existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getConnection } from './database.js';

// stdout during a Phase 3 build is reserved for renderProgress output only (Session 5 hardening) —
// every diagnostic line this module emits goes to the build log file instead of console.
function logToBuildFile(...args: unknown[]): void {
  try {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    appendFileSync('.forge/build.log', `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

export interface SessionStartResult {
  governanceRulesLoaded: number;
  fixPatternsAvailable: number;
  skillsLoaded: number;
  priorSessionRecovered: boolean;
  fingerprintMatch: boolean;
  contextBlock: string;
}

export interface SessionEndResult {
  stateSaved: boolean;
  handoffPath: string | null;
  decisionWeightsUpdated: boolean;
  evolutionsAnalyzed: boolean;
  syncAttempted: boolean;
}

export async function handleSessionStart(
  buildId: string,
  _projectPath: string,
  projectName: string,
  dbPath?: string
): Promise<SessionStartResult> {
  const resolvedPath = dbPath ?? join(homedir(), '.forge', 'forge_memory.db');
  const result: SessionStartResult = {
    governanceRulesLoaded: 0,
    fixPatternsAvailable: 0,
    skillsLoaded: 0,
    priorSessionRecovered: false,
    fingerprintMatch: true,
    contextBlock: '',
  };

  if (!existsSync(resolvedPath)) return result;

  try {
    const db = getConnection(resolvedPath);

    // Count available resources
    result.governanceRulesLoaded = (db.prepare('SELECT COUNT(*) as n FROM governance_rules WHERE active = 1').get() as { n: number }).n;
    result.fixPatternsAvailable = (db.prepare('SELECT COUNT(*) as n FROM fix_patterns WHERE success_rate > 0.5').get() as { n: number }).n;
    try { result.skillsLoaded = (db.prepare('SELECT COUNT(*) as n FROM skill_library WHERE active = 1').get() as { n: number }).n; } catch { /* table may not exist */ }

    // Check for prior session to recover
    try {
      const lastSession = db.prepare(
        "SELECT id, end_reason, total_prompts_executed FROM build_outcomes WHERE project_name = ? ORDER BY created_at DESC LIMIT 1"
      ).get(projectName) as { id: string; end_reason: string; total_prompts_executed: number } | undefined;

      if (lastSession && lastSession.end_reason === 'INTERRUPTED') {
        result.priorSessionRecovered = true;
        logToBuildFile(`[SESSION] Recovering from interrupted session: ${lastSession.id}`);
      }
    } catch { /* non-fatal */ }

    // Build context block
    const lines: string[] = ['[SESSION] Learning engine loaded:'];
    lines.push(`  Governance rules: ${result.governanceRulesLoaded} active`);
    lines.push(`  Fix patterns: ${result.fixPatternsAvailable} with >50% success`);
    if (result.skillsLoaded > 0) lines.push(`  Skills: ${result.skillsLoaded} available`);
    if (result.priorSessionRecovered) lines.push('  Prior interrupted session detected - reviewing recovery point');
    result.contextBlock = lines.join('\n');

    logToBuildFile(result.contextBlock);

    // Log session start
    try {
      db.prepare(`
        INSERT OR IGNORE INTO hook_execution_log
          (id, hook_name, event, status, duration_ms, output, build_id, machine_id, created_at)
        VALUES (?, 'session-start', 'SessionStart', 'PASS', 0, ?, ?, 'unknown', datetime('now'))
      `).run(randomUUID(), JSON.stringify({ governanceRulesLoaded: result.governanceRulesLoaded, fixPatternsAvailable: result.fixPatternsAvailable }), buildId);
    } catch { /* non-fatal */ }

  } catch { /* non-fatal */ }

  return result;
}

export async function handleSessionEnd(
  opts: {
    buildId: string;
    projectPath: string;
    projectName: string;
    promptsExecuted: number;
    promptsPassed: number;
    promptsFailed: number;
    endReason: 'COMPLETED' | 'PAUSED' | 'FAILED' | 'INTERRUPTED';
    startTime: Date;
    dbPath?: string;
    apiKey?: string;
  }
): Promise<SessionEndResult> {
  const result: SessionEndResult = {
    stateSaved: false,
    handoffPath: null,
    decisionWeightsUpdated: false,
    evolutionsAnalyzed: false,
    syncAttempted: false,
  };

  try {
    // Save session state
    const { onRunEnd } = await import('./session-lifecycle.js');
    onRunEnd({
      projectPath: opts.projectPath,
      buildId: opts.buildId,
      runNumber: 1,
      lastPromptExecuted: opts.promptsExecuted,
      promptsExecuted: opts.promptsExecuted,
      promptsPassed: opts.promptsPassed,
      promptsFailed: opts.promptsFailed,
      endReason: opts.endReason,
      startTime: opts.startTime,
    });
    result.stateSaved = true;
  } catch { /* non-fatal */ }

  try {
    // Generate handoff
    const { generateSessionHandoff } = await import('./handoff-generator.js');
    result.handoffPath = await generateSessionHandoff({
      projectPath: opts.projectPath,
      buildId: opts.buildId,
      runNumber: 1,
      projectName: opts.projectName,
      endReason: opts.endReason,
      promptsExecuted: opts.promptsExecuted,
      promptsPassed: opts.promptsPassed,
      promptsFailed: opts.promptsFailed,
      firstPassRate: opts.promptsExecuted > 0 ? opts.promptsPassed / opts.promptsExecuted : 0,
      durationMinutes: Math.round((Date.now() - opts.startTime.getTime()) / 60_000 * 10) / 10,
      startTime: opts.startTime,
      lastPromptExecuted: opts.promptsExecuted,
      queueTotal: opts.promptsExecuted,
      queueRemaining: 0,
      activeBlockers: [],
      filesModifiedThisRun: [],
      gitCommitSha: null,
      gitDirty: false,
      buildFingerprint: '',
      apiKey: opts.apiKey,
    });
  } catch { /* non-fatal */ }

  try {
    // Update decision weights
    const { updateDecisionWeights } = await import('./loops.js');
    updateDecisionWeights(opts.buildId, opts.dbPath);
    result.decisionWeightsUpdated = true;
  } catch { /* non-fatal */ }

  try {
    // Analyze evolutions
    const { analyzeForEvolutions } = await import('./loops.js');
    analyzeForEvolutions(opts.buildId, opts.dbPath);
    result.evolutionsAnalyzed = true;
  } catch { /* non-fatal */ }

  return result;
}
