// FORGE 2.0 - PreCompact Hook: Context State Preservation
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getConnection } from './database.js';

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
    const snapshotId = randomUUID();

    db.prepare(`
      INSERT INTO compact_snapshots (id, build_id, prompt_index, state_json, machine_id, created_at)
      VALUES (?, ?, ?, ?, 'unknown', datetime('now'))
    `).run(
      snapshotId,
      state.buildId,
      state.promptIndex,
      JSON.stringify(state)
    );

    console.log(`[PRECOMPACT] Context snapshot saved: prompt ${state.promptIndex}, ${state.activeErrors.length} active errors, ${state.activeGovernanceRules.length} rules`);
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
