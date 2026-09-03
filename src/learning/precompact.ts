// FORGE 2.0 - PreCompact Hook: Context State Preservation
//
// NOT WIRED (Finding J-1, 2026-09-02 audit): handlePreCompact is only ever re-exported (via
// learning/integration.ts), never actually called anywhere in src/ — unlike its sibling
// session-hooks.ts's handleSessionStart/handleSessionEnd, which phase3-executor.ts calls directly
// at real build lifecycle points. `.forge/hooks.json` declares a PreCompact hook
// ("precompact-snapshot") whose action references a PowerShell function
// (`Invoke-PreCompactSnapshot`) that does not exist anywhere in this repo — that hook entry is
// disconnected from this TS module by name only, not by any real dispatch path. A real fix needs
// an actual PreCompact trigger to call this from: either a genuine Claude Code PreCompact hook
// invoking a small `forge internal precompact` CLI entry point that calls handlePreCompact, or
// dropping the `.forge/hooks.json` entry if PreCompact snapshotting is no longer wanted. This
// also explains `compact_snapshots` reading 0 rows in `forge health` (Finding C-1): nothing has
// ever called the function that would populate it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getConnection, getMachineId } from './database.js';
import type { FixPattern, GovernanceRule } from './types.js';

export interface PreCompactState {
  buildId: string;
  promptIndex: number;
  phase: string;
  activeErrors: string[];
  activeGovernanceRules: string[];
  queueStatus: { total: number; completed: number; remaining: number };
  pendingGitChanges: string[];
  currentAcceptanceCriteria: string[];
  activeBlockers: string[];
}

export async function handlePreCompact(
  state: PreCompactState,
  dbPath?: string
): Promise<{ saved: boolean; snapshotId: string | null }> {
  const resolvedPath = dbPath ?? join(homedir(), '.forge', 'forge_memory.db');

  if (!existsSync(resolvedPath)) {
    return { saved: false, snapshotId: null };
  }

  try {
    const db = getConnection(resolvedPath);

    // Fetch active errors from fix_patterns (recent, recurring errors)
    const fixPatternRows = db.prepare(`
      SELECT error_message, error_category, error_fingerprint, occurrence_count
      FROM fix_patterns
      WHERE occurrence_count > 0
      ORDER BY last_seen DESC
      LIMIT 20
    `).all() as Pick<FixPattern, 'error_message' | 'error_category' | 'error_fingerprint' | 'occurrence_count'>[];

    const dbErrors = fixPatternRows.map(
      (r) => `[${r.error_category}][x${r.occurrence_count}] ${r.error_message} (${r.error_fingerprint})`
    );

    // Fetch active governance rules from governance_rules
    const ruleRows = db.prepare(`
      SELECT rule_short_name, rule_text, scope, enforcement_count
      FROM governance_rules
      WHERE active = 1
      ORDER BY enforcement_count DESC
    `).all() as Pick<GovernanceRule, 'rule_short_name' | 'rule_text' | 'scope' | 'enforcement_count'>[];

    const dbRules = ruleRows.map(
      (r) => `[${r.scope}] ${r.rule_short_name}: ${r.rule_text}`
    );

    // Merge caller-supplied state with DB-sourced data (DB values supplement, not replace)
    const enrichedState: PreCompactState = {
      ...state,
      activeErrors: [...new Set([...state.activeErrors, ...dbErrors])],
      activeGovernanceRules: [...new Set([...state.activeGovernanceRules, ...dbRules])],
    };

    const snapshotId = randomUUID();
    const machineId = getMachineId(resolvedPath);

    db.prepare(`
      INSERT INTO compact_snapshots (id, build_id, prompt_index, state_json, machine_id, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(
      snapshotId,
      enrichedState.buildId,
      enrichedState.promptIndex,
      JSON.stringify(enrichedState),
      machineId
    );

    console.log(`[PRECOMPACT] Context snapshot saved: prompt ${enrichedState.promptIndex}, ${enrichedState.activeErrors.length} active errors (${dbErrors.length} from DB), ${enrichedState.activeGovernanceRules.length} rules (${dbRules.length} from DB)`);
    return { saved: true, snapshotId };
  } catch (e: unknown) {
    console.warn(`[PRECOMPACT] Failed to save snapshot: ${String(e)}`);
    return { saved: false, snapshotId: null };
  }
}

export async function loadLatestCompactSnapshot(
  buildId: string,
  dbPath?: string
): Promise<PreCompactState | null> {
  const resolvedPath = dbPath ?? join(homedir(), '.forge', 'forge_memory.db');
  if (!existsSync(resolvedPath)) return null;

  try {
    const db = getConnection(resolvedPath);
    const row = db.prepare(`
      SELECT state_json FROM compact_snapshots
      WHERE build_id = ?
      ORDER BY prompt_index DESC LIMIT 1
    `).get(buildId) as { state_json: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.state_json) as PreCompactState;
  } catch {
    return null;
  }
}

export function buildPreCompactContextBlock(state: PreCompactState): string {
  const lines: string[] = [
    '=== FORGE CONTEXT RESTORED FROM COMPACTION ===',
    `Build: ${state.buildId}`,
    `Prompt: ${state.promptIndex}`,
    `Phase: ${state.phase}`,
    '',
  ];

  if (state.activeErrors.length > 0) {
    lines.push('ACTIVE UNRESOLVED ERRORS:');
    for (const e of state.activeErrors) lines.push(`  - ${e}`);
    lines.push('');
  }

  if (state.activeGovernanceRules.length > 0) {
    lines.push('ACTIVE GOVERNANCE RULES:');
    for (const r of state.activeGovernanceRules) lines.push(`  - ${r}`);
    lines.push('');
  }

  if (state.currentAcceptanceCriteria.length > 0) {
    lines.push('CURRENT ACCEPTANCE CRITERIA:');
    for (const c of state.currentAcceptanceCriteria) lines.push(`  - ${c}`);
    lines.push('');
  }

  if (state.activeBlockers.length > 0) {
    lines.push('ACTIVE BLOCKERS:');
    for (const b of state.activeBlockers) lines.push(`  - ${b}`);
    lines.push('');
  }

  lines.push(`Queue: ${state.queueStatus.completed}/${state.queueStatus.total} complete, ${state.queueStatus.remaining} remaining`);
  lines.push('=== END RESTORED CONTEXT ===');
  lines.push('');

  return lines.join('\n');
}
