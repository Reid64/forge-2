// FORGE 2.0 Learning Engine — Five Learning Loops
// CRITICAL: FORGE evolves configuration and knowledge, NEVER its own source code.
import { getConnection, getMachineId } from './database.js';
import {
  savePromptScore, getForgeMemory, saveToForgeMemory, updateForgeMemory,
  getFixPattern, registerError as registerErrorQuery, getGovernanceRules,
  getRelevantSkills, getPendingEvolutions, updateEvolutionStatus
} from './queries.js';
import { getErrorFingerprint } from './fingerprint.js';
import type { FixPattern, GovernanceRule, PendingEvolution, SkillEntry, BuildOutcome } from './types.js';

// ─── LOOP 1: Prompt Effectiveness Scoring ──────────────────────────────────────
// Fires: PostToolUse (after every prompt execution)
// Purpose: Record how well each prompt performed across 4 dimensions

export function scorePromptExecution(execution: {
  templateHash: string;
  taskType: string;
  techStackTags: string[];
  firstPassSuccess: boolean;
  retryCount: number;
  tokensConsumed: number;
  gatePassRate: number;
  driftScore: number;
  projectName: string;
  buildId: string;
}, dbPath?: string): string {
  try {
    return savePromptScore({
      prompt_template_hash: execution.templateHash,
      task_type: execution.taskType,
      tech_stack_tags: execution.techStackTags,
      first_pass_success: execution.firstPassSuccess,
      retry_count: execution.retryCount,
      tokens_consumed: execution.tokensConsumed,
      gate_pass_rate: execution.gatePassRate,
      drift_score: execution.driftScore,
      project_name: execution.projectName,
      build_id: execution.buildId,
    }, dbPath);
  } catch (err) {
    console.error('[FORGE Learning] Loop 1 scoring failed:', err);
    return '';
  }
}

// ─── LOOP 2: Fix Pattern Indexing ─────────────────────────────────────────────
// Fires: PostToolUse when errors occur
// Purpose: Build a knowledge base of errors and their fixes

export function captureError(error: {
  errorCode: string;
  filePath: string;
  errorMessage: string;
  errorCategory: string;
  techStack: string[];
}, dbPath?: string): { fingerprint: string; isKnown: boolean; knownFix?: FixPattern } {
  try {
    const result = registerErrorQuery(error, dbPath);
    return {
      fingerprint: result.fingerprint,
      isKnown: result.isKnown,
      knownFix: result.existingFix || undefined,
    };
  } catch (err) {
    console.error('[FORGE Learning] Loop 2 capture failed:', err);
    const fingerprint = getErrorFingerprint({
      errorCode: error.errorCode,
      filePath: error.filePath,
      errorMessage: error.errorMessage,
      techStack: error.techStack,
    });
    return { fingerprint, isKnown: false };
  }
}

/**
 * The compounding mechanism (Session 4 — Intelligence & Observability, Task 1.2): once a
 * recurring error pattern has a proven fix (occurrence_count >= 3, resolution success_rate >=
 * 0.7), auto-elevate it to a `governance_rules` row so `handlePreToolUse` injects it into every
 * future matching prompt — no human has to notice the pattern and write the rule by hand.
 *
 * Scope: GLOBAL when the pattern is stack-agnostic (`tech_stack_tags` empty — the fix applies
 * everywhere); PROJECT_SPECIFIC (tied to `projectName`) when it carries specific stack tags,
 * since a stack-specific fix (e.g. a Next.js App Router quirk) shouldn't be asserted globally.
 */
export function checkAutoElevation(
  fingerprint: string,
  projectName?: string,
  dbPath?: string,
): GovernanceRule | null {
  try {
    const pattern = getFixPattern(fingerprint, dbPath);
    if (!pattern) return null;
    if (pattern.occurrence_count < 3) return null;
    if (!pattern.fix_description) return null;
    if (pattern.success_rate < 0.7) return null;
    if (pattern.governance_rule_id) return null; // already has a rule

    let tags: string[] = [];
    try {
      tags = JSON.parse(pattern.tech_stack_tags) as string[];
    } catch {
      // malformed tags — treat as stack-agnostic
    }
    const stackAgnostic = tags.length === 0;

    // Create a governance rule from this recurring pattern
    const ruleId = saveToForgeMemory('governance_rules', {
      rule_text: `Auto-elevated from error pattern (${pattern.occurrence_count}x, ${(pattern.success_rate * 100).toFixed(0)}% fix success): ${pattern.error_message}. Known fix: ${pattern.fix_description}`,
      rule_short_name: `auto-${fingerprint.substring(0, 8)}`,
      source: 'AUTO_ELEVATED',
      source_error_fingerprint: fingerprint,
      tech_stack_tags: pattern.tech_stack_tags,
      scope: stackAgnostic ? 'GLOBAL' : 'PROJECT_SPECIFIC',
      project_name: stackAgnostic ? null : (projectName ?? null),
      active: 1,
      enforcement_count: 0,
    }, dbPath);

    // Link rule back to the fix pattern
    updateForgeMemory('fix_patterns', pattern.id, {
      governance_rule_id: ruleId,
      auto_governance_rule: `Auto-elevated to governance rule ${ruleId}`,
    }, dbPath);

    // Return the created rule
    const rules = getForgeMemory('governance_rules', {
      where: 'id = ?',
      params: [ruleId],
    }, dbPath);
    return rules[0] as GovernanceRule || null;
  } catch (err) {
    console.error('[FORGE Learning] Loop 2 auto-elevation failed:', err);
    return null;
  }
}

// ─── LOOP 3: Architecture Decision Weighting ───────────────────────────────────
// Fires: SessionEnd
// Purpose: Track which architectural decisions lead to better outcomes

export function updateDecisionWeights(buildId: string, dbPath?: string): void {
  try {
    const db = getConnection(dbPath);
    const decisions = db.prepare(
      'SELECT * FROM decision_weights WHERE build_id = ?'
    ).all(buildId) as any[];

    for (const decision of decisions) {
      // Get all prompt scores created after this decision
      const downstreamScores = db.prepare(
        'SELECT first_pass_success, retry_count FROM prompt_scores WHERE build_id = ? AND created_at > ?'
      ).all(buildId, decision.created_at) as any[];

      if (downstreamScores.length === 0) continue;

      const totalPrompts = downstreamScores.length;
      const failedPrompts = downstreamScores.filter((s: any) => s.first_pass_success === 0).length;
      const totalRetries = downstreamScores.reduce((sum: number, s: any) => sum + s.retry_count, 0);

      const errorRate = failedPrompts / totalPrompts;
      const retryRate = totalRetries / totalPrompts;

      db.prepare(
        'UPDATE decision_weights SET downstream_error_rate = ?, downstream_retry_rate = ?, downstream_prompts = ?, downstream_errors = ?, downstream_retries = ? WHERE id = ?'
      ).run(errorRate, retryRate, totalPrompts, failedPrompts, totalRetries, decision.id);
    }
  } catch (err) {
    console.error('[FORGE Learning] Loop 3 decision weights failed:', err);
  }
}

// ─── LOOP 4: Cross-Project Knowledge Transfer ──────────────────────────────────
// Fires: SessionStart
// Purpose: Load everything FORGE has learned that's relevant to this build

export function loadCrossProjectKnowledge(
  techStackTags: string[],
  projectName: string,
  dbPath?: string
): {
  rules: GovernanceRule[];
  skills: SkillEntry[];
  fixPatterns: FixPattern[];
  outcomes: BuildOutcome[];
  evolutions: PendingEvolution[];
} {
  try {
    const rules = getGovernanceRules(techStackTags, projectName, dbPath) as GovernanceRule[];
    const skills = getRelevantSkills(techStackTags, dbPath) as SkillEntry[];
    const evolutions = getPendingEvolutions(dbPath) as PendingEvolution[];

    // Get high-frequency fix patterns (2+ occurrences)
    const fixPatterns = getForgeMemory('fix_patterns', {
      where: 'occurrence_count >= ?',
      params: [2],
      orderBy: 'occurrence_count DESC',
      limit: 50,
    }, dbPath) as FixPattern[];

    // Get recent build outcomes
    const outcomes = getForgeMemory('build_outcomes', {
      orderBy: 'created_at DESC',
      limit: 10,
    }, dbPath) as BuildOutcome[];

    console.log(`[FORGE Learning] Loaded: ${rules.length} rules, ${skills.length} skills, ${fixPatterns.length} fix patterns, ${outcomes.length} outcomes, ${evolutions.length} evolutions`);

    return { rules, skills, fixPatterns, outcomes, evolutions };
  } catch (err) {
    console.error('[FORGE Learning] Loop 4 knowledge loading failed:', err);
    return { rules: [], skills: [], fixPatterns: [], outcomes: [], evolutions: [] };
  }
}

// ─── LOOP 5: Self-Modification with Guardrails ─────────────────────────────────
// Fires: SessionEnd
// Purpose: Analyze the run and propose improvements (configuration only, NEVER source code)

export function analyzeForEvolutions(buildId: string, dbPath?: string): PendingEvolution[] {
  const proposals: PendingEvolution[] = [];
  try {
    const db = getConnection(dbPath);
    getMachineId(dbPath);

    // Analysis A: Templates with low pass rate over 3+ samples
    const weakTemplates = db.prepare(`
      SELECT prompt_template_hash,
             AVG(first_pass_success) as avg_pass,
             COUNT(*) as sample_count,
             AVG(retry_count) as avg_retries
      FROM prompt_scores
      WHERE build_id = ?
      GROUP BY prompt_template_hash
      HAVING COUNT(*) >= 3 AND AVG(first_pass_success) < 0.5
    `).all(buildId) as any[];

    for (const tmpl of weakTemplates) {
      const id = saveToForgeMemory('pending_evolutions', {
        evolution_type: 'TEMPLATE',
        proposed_change: `Rewrite prompt template ${tmpl.prompt_template_hash.substring(0, 8)}`,
        change_detail: JSON.stringify({
          template_hash: tmpl.prompt_template_hash,
          current_pass_rate: tmpl.avg_pass,
          current_avg_retries: tmpl.avg_retries,
          sample_count: tmpl.sample_count,
        }),
        evidence: JSON.stringify({ source: 'prompt_scores', build_id: buildId, metric: 'first_pass_success < 0.5' }),
        estimated_impact: `Improving pass rate from ${(tmpl.avg_pass * 100).toFixed(0)}% could save ${Math.round(tmpl.avg_retries * tmpl.sample_count)} retries`,
        confidence: 0.7,
        status: 'PENDING',
      }, dbPath);
      const created = getForgeMemory('pending_evolutions', { where: 'id = ?', params: [id] }, dbPath);
      if (created[0]) proposals.push(created[0] as PendingEvolution);
    }

    // Analysis B: Error patterns at 3+ occurrences without a governance rule
    const ungoverned = db.prepare(`
      SELECT * FROM fix_patterns
      WHERE occurrence_count >= 3
        AND (governance_rule_id IS NULL OR governance_rule_id = '')
    `).all() as any[];

    for (const pattern of ungoverned) {
      const id = saveToForgeMemory('pending_evolutions', {
        evolution_type: 'RULE',
        proposed_change: `Create governance rule for recurring error: ${pattern.error_message.substring(0, 80)}`,
        change_detail: JSON.stringify({
          error_fingerprint: pattern.error_fingerprint,
          error_category: pattern.error_category,
          occurrence_count: pattern.occurrence_count,
          fix_available: !!pattern.fix_description,
        }),
        evidence: JSON.stringify({ source: 'fix_patterns', occurrences: pattern.occurrence_count }),
        estimated_impact: `Preventing ${pattern.occurrence_count} known error occurrences per build`,
        confidence: 0.8,
        status: 'PENDING',
      }, dbPath);
      const created = getForgeMemory('pending_evolutions', { where: 'id = ?', params: [id] }, dbPath);
      if (created[0]) proposals.push(created[0] as PendingEvolution);
    }

    // Analysis C: Task types averaging > 2 retries
    const retryHeavy = db.prepare(`
      SELECT task_type,
             AVG(retry_count) as avg_retries,
             COUNT(*) as sample_count
      FROM prompt_scores
      WHERE build_id = ?
      GROUP BY task_type
      HAVING AVG(retry_count) > 2 AND COUNT(*) >= 2
    `).all(buildId) as any[];

    for (const taskInfo of retryHeavy) {
      const id = saveToForgeMemory('pending_evolutions', {
        evolution_type: 'GATE',
        proposed_change: `Adjust gate thresholds for ${taskInfo.task_type} tasks (avg ${taskInfo.avg_retries.toFixed(1)} retries)`,
        change_detail: JSON.stringify({
          task_type: taskInfo.task_type,
          avg_retries: taskInfo.avg_retries,
          sample_count: taskInfo.sample_count,
        }),
        evidence: JSON.stringify({ source: 'prompt_scores', build_id: buildId, metric: 'retry_count > 2' }),
        estimated_impact: `Reducing retry overhead for ${taskInfo.task_type} prompts`,
        confidence: 0.6,
        status: 'PENDING',
      }, dbPath);
      const created = getForgeMemory('pending_evolutions', { where: 'id = ?', params: [id] }, dbPath);
      if (created[0]) proposals.push(created[0] as PendingEvolution);
    }

    if (proposals.length > 0) {
      console.log(`[FORGE Learning] Loop 5 generated ${proposals.length} evolution proposals`);
    }

    return proposals;
  } catch (err) {
    console.error('[FORGE Learning] Loop 5 analysis failed:', err);
    return proposals;
  }
}

export function presentEvolutions(dbPath?: string): PendingEvolution[] {
  try {
    return getPendingEvolutions(dbPath) as PendingEvolution[];
  } catch (err) {
    console.error('[FORGE Learning] presentEvolutions failed:', err);
    return [];
  }
}

export function applyEvolution(
  evolutionId: string,
  approved: boolean,
  reviewNote?: string,
  dbPath?: string
): void {
  try {
    updateEvolutionStatus(
      evolutionId,
      approved ? 'APPROVED' : 'REJECTED',
      reviewNote,
      dbPath
    );
  } catch (err) {
    console.error('[FORGE Learning] applyEvolution failed:', err);
  }
}
