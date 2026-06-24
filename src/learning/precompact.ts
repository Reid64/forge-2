// FORGE 2.0 Learning Engine — PreCompact Context Preservation
import { execSync } from 'node:child_process';
import { getConnection } from './database.js';
import { saveToForgeMemory } from './queries.js';

export function shouldPreCompact(promptIndex: number, totalPrompts: number): boolean {
  if (totalPrompts > 0 && promptIndex / totalPrompts >= 0.8) return true;
  if (promptIndex > 30 && promptIndex % 10 === 0) return true;
  return false;
}

interface PreCompactContext {
  buildId: string;
  promptIndex: number;
  phase: string;
  projectPath: string;
  techStackTags: string[];
  acceptanceCriteria: string;
  queueStatus: { total: number; completed: number; pending: number };
}

interface ActiveError {
  id: string;
  error_message: string;
  error_category: string;
  occurrence_count: number;
}

interface ActiveRule {
  id: string;
  rule_short_name: string;
  rule_text: string;
}

interface SnapshotState extends PreCompactContext {
  activeErrors: ActiveError[];
  governanceRules: ActiveRule[];
  gitStatus: string;
}

export function invokePreCompactSave(context: PreCompactContext, dbPath?: string): string {
  const db = getConnection(dbPath);

  const activeErrors = db
    .prepare(
      `SELECT id, error_message, error_category, occurrence_count
       FROM fix_patterns
       WHERE occurrence_count > 0 AND fix_diff IS NULL
       ORDER BY occurrence_count DESC LIMIT 20`,
    )
    .all() as ActiveError[];

  const governanceRules = db
    .prepare(
      `SELECT id, rule_short_name, rule_text
       FROM governance_rules
       WHERE active = 1 LIMIT 30`,
    )
    .all() as ActiveRule[];

  let gitStatus = '';
  try {
    gitStatus = execSync('git status --porcelain', {
      cwd: context.projectPath,
      encoding: 'utf8',
    }).trim();
  } catch {
    gitStatus = '(git status unavailable)';
  }

  const state: SnapshotState = { ...context, activeErrors, governanceRules, gitStatus };

  return saveToForgeMemory(
    'compact_snapshots',
    {
      build_id: context.buildId,
      prompt_index: context.promptIndex,
      state_json: JSON.stringify(state),
    },
    dbPath,
  );
}

export function restoreCompactedContext(buildId: string, dbPath?: string): string | null {
  const db = getConnection(dbPath);

  const row = db
    .prepare(
      `SELECT state_json FROM compact_snapshots
       WHERE build_id = ? ORDER BY prompt_index DESC LIMIT 1`,
    )
    .get(buildId) as { state_json: string } | undefined;

  if (!row) return null;

  let state: SnapshotState;
  try {
    state = JSON.parse(row.state_json) as SnapshotState;
  } catch {
    return null;
  }

  const errorCount = state.activeErrors.length;
  const errorDetails = state.activeErrors
    .map((e) => `  [${e.error_category}] ${e.error_message} (x${e.occurrence_count})`)
    .join('\n');

  const ruleCount = state.governanceRules.length;
  const ruleSummaries = state.governanceRules
    .map((r) => `  - ${r.rule_short_name}: ${r.rule_text.substring(0, 80)}`)
    .join('\n');

  return [
    '=== FORGE CONTEXT RECOVERY ===',
    `Phase: ${state.phase}`,
    `Prompt: ${state.promptIndex}/${state.queueStatus.total}`,
    `Active errors: ${errorCount}`,
    errorDetails,
    `Governance rules: ${ruleCount}`,
    ruleSummaries,
    `Acceptance criteria: ${state.acceptanceCriteria}`,
    '=== END RECOVERY ===',
  ].join('\n');
}
