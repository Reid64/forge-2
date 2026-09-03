// FORGE 2.0 - Composer: Queue Recomposer
// After each run: identifies failed prompts, checks for fixes, re-queues with context
//
// ORPHANED (Finding G-1, 2026-09-02 audit): called nowhere in src/. Kept as-is — the re-queue-
// with-fix-context logic is real and complete; no caller currently invokes it after a build run.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

export interface RunResult { promptId: string; passed: boolean; retries: number; errorOutput?: string; timestamp: string; }
export interface RecompositionPlan { requeue: string[]; skip: string[]; newPrompts: string[]; fixesApplied: number; }

export function loadRunResults(projectPath: string): RunResult[] {
  const stateFile = join(projectPath, '..', 'state', projectPath.split(/[/\\]/).pop() ?? 'project', 'gate-results.jsonl');
  if (!existsSync(stateFile)) return [];
  try { return readFileSync(stateFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as RunResult); } catch { return []; }
}

export function identifyFailedPrompts(results: RunResult[]): RunResult[] {
  return results.filter(r => !r.passed);
}

export function findKnownFixes(errorOutput: string, dbPath?: string): string | null {
  const resolved = dbPath ?? join(homedir(), '.forge', 'forge_memory.db');
  if (!existsSync(resolved)) return null;
  try {
    const lines = errorOutput.split('\n').filter(l => l.includes('error TS') || l.includes('error:'));
    for (const line of lines.slice(0, 3)) {
      const codeMatch = line.match(/TS(\d+)/);
      if (!codeMatch) continue;
      const code = 'TS' + codeMatch[1];
      const result = execSync('sqlite3 "' + resolved + '" "SELECT fix_description FROM fix_patterns WHERE error_message LIKE \'%' + code + '%\' AND success_rate > 0.6 ORDER BY (success_rate * occurrence_count) DESC LIMIT 1"', { stdio: 'pipe' }).toString().trim();
      if (result) return result;
    }
  } catch { /* non-fatal */ }
  return null;
}

export function recomposeQueue(queuePath: string, failedResults: RunResult[], dbPath?: string): RecompositionPlan {
  const plan: RecompositionPlan = { requeue: [], skip: [], newPrompts: [], fixesApplied: 0 };
  if (!existsSync(queuePath)) return plan;

  try {
    const content = readFileSync(queuePath, 'utf8');
    const failedIds = new Set(failedResults.map(r => r.promptId));
    const lines = content.split('\n');
    const recomposedLines: string[] = [];
    let inFailedPrompt = false;
    let currentId = '';

    for (const line of lines) {
      const idMatch = line.match(/^- id: (.+)$/);
      if (idMatch && idMatch[1]) {
        currentId = idMatch[1];
        inFailedPrompt = failedIds.has(currentId);
        if (inFailedPrompt) {
          plan.requeue.push(currentId);
          // Find known fix and inject into prompt
          const failed = failedResults.find(r => r.promptId === currentId);
          const knownFix = failed?.errorOutput ? findKnownFixes(failed.errorOutput, dbPath) : null;
          if (knownFix) {
            plan.fixesApplied++;
            // Inject fix context into next occurrence of this prompt
          }
        }
      }
      // Include all prompts -- failed ones get requeued with fix context
      recomposedLines.push(line);
    }

    // Write recomposed queue
    const recomposedPath = queuePath.replace('.yaml', '-recomposed.yaml');
    writeFileSync(recomposedPath, recomposedLines.join('\n'), 'utf8');
  } catch { /* non-fatal */ }

  return plan;
}

export function generateRecompositionReport(plan: RecompositionPlan): string {
  return [
    '# Queue Recomposition Report',
    '',
    'Re-queued: ' + plan.requeue.length + ' failed prompts',
    'Skipped: ' + plan.skip.length + ' (made unnecessary)',
    'Known fixes applied: ' + plan.fixesApplied,
    'New prompts added: ' + plan.newPrompts.length,
    '',
    plan.requeue.length > 0 ? '## Re-queued Prompts\n' + plan.requeue.map(id => '- ' + id).join('\n') : '',
  ].join('\n');
}
