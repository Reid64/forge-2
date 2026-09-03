// FORGE 2.0 - Composer: Adversary Accuracy Tracker
//
// ORPHANED (Finding G-1, 2026-09-02 audit): evaluateAdversaryAccuracy is called nowhere in src/.
// Kept as-is — the fix-vs-dismiss accuracy tracking is real and complete; it just has no caller
// wiring it into the consensus/adversary review flow yet.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

export interface AdversaryAccuracyReport {
  buildId: string;
  totalFindings: number;
  fixed: number;
  dismissed: number;
  accuracyRate: number;
  falsePositiveRate: number;
  proposedEvolution: boolean;
}

export function evaluateAdversaryAccuracy(buildId: string, dbPath?: string): AdversaryAccuracyReport {
  const resolved = dbPath ?? join(homedir(), '.forge', 'forge_memory.db');
  const empty: AdversaryAccuracyReport = {
    buildId,
    totalFindings: 0,
    fixed: 0,
    dismissed: 0,
    accuracyRate: 0,
    falsePositiveRate: 0,
    proposedEvolution: false,
  };
  if (!existsSync(resolved)) return empty;
  try {
    const safeId = buildId.replace(/'/g, "''");
    const rows = execSync(
      'sqlite3 "' + resolved + '" "SELECT resolution, COUNT(*) FROM adversary_findings WHERE build_id = \'' + safeId + '\' GROUP BY resolution"',
      { stdio: 'pipe' }
    )
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);

    let fixed = 0;
    let dismissed = 0;
    for (const row of rows) {
      const [r, c] = row.split('|');
      if (r === 'FIXED') fixed = parseInt(c ?? '0', 10);
      else if (r === 'DISMISSED') dismissed = parseInt(c ?? '0', 10);
    }

    const total = fixed + dismissed;
    if (total === 0) return empty;

    const falsePositiveRate = dismissed / total;
    let proposedEvolution = false;
    if (falsePositiveRate > 0.4 && total >= 5) {
      try {
        const safeBuildId = buildId.replace(/'/g, '');
        const pct = Math.round(falsePositiveRate * 100);
        execSync(
          'sqlite3 "' +
            resolved +
            '" "INSERT OR IGNORE INTO pending_evolutions (id,evolution_type,proposed_change,change_detail,evidence,estimated_impact,confidence,status,machine_id,created_at) VALUES (hex(randomblob(16)),\'TEMPLATE\',\'Adversary false positive rate ' +
            pct +
            '% in build ' +
            safeBuildId +
            '\',\'Refine adversary prompt specificity\',\'' +
            dismissed +
            '/' +
            total +
            ' dismissed\',\'Reduce wasted fix effort\',0.8,\'PENDING\',\'unknown\',datetime(\'now\'))"',
          { stdio: 'pipe' }
        );
        proposedEvolution = true;
      } catch {
        /* non-fatal */
      }
    }

    return {
      buildId,
      totalFindings: total,
      fixed,
      dismissed,
      accuracyRate: fixed / total,
      falsePositiveRate,
      proposedEvolution,
    };
  } catch {
    return empty;
  }
}

export function recordAdversaryFinding(
  buildId: string,
  phase: string,
  severity: 'BLOCKER' | 'SIGNIFICANT' | 'MINOR',
  vector: string,
  issue: string,
  fix: string,
  dbPath?: string
): void {
  const resolved = dbPath ?? join(homedir(), '.forge', 'forge_memory.db');
  if (!existsSync(resolved)) return;
  const s = (v: string): string => v.replace(/'/g, "''").substring(0, 500);
  try {
    execSync(
      'sqlite3 "' +
        resolved +
        '" "INSERT OR IGNORE INTO adversary_findings (id,build_id,phase,severity,vector,issue,fix,machine_id) VALUES (hex(randomblob(16)),\'' +
        s(buildId) +
        '\',\'' +
        s(phase) +
        '\',\'' +
        s(severity) +
        '\',\'' +
        s(vector) +
        '\',\'' +
        s(issue) +
        '\',\'' +
        s(fix) +
        '\',\'unknown\')"',
      { stdio: 'pipe' }
    );
  } catch {
    /* non-fatal */
  }
}

export function resolveAdversaryFinding(
  findingId: string,
  resolution: 'FIXED' | 'DISMISSED' | 'DEFERRED',
  dbPath?: string
): void {
  const resolved = dbPath ?? join(homedir(), '.forge', 'forge_memory.db');
  if (!existsSync(resolved)) return;
  try {
    execSync(
      'sqlite3 "' +
        resolved +
        '" "UPDATE adversary_findings SET resolution = \'' +
        resolution +
        '\', resolved_at = datetime(\'now\') WHERE id = \'' +
        findingId.replace(/'/g, "''") +
        '\'"',
      { stdio: 'pipe' }
    );
  } catch {
    /* non-fatal */
  }
}
