// FORGE 2.0 Learning Engine — Query Layer
import { randomUUID } from 'node:crypto';
import { getConnection, getMachineId } from './database.js';
import {
  VALID_TABLES,
  type FixPattern,
  type GovernanceRule,
  type PendingEvolution,
  type SkillEntry,
} from './types.js';
import { getErrorFingerprint } from './fingerprint.js';

export function generateId(): string {
  return randomUUID();
}

function validateTable(table: string): void {
  if (!(VALID_TABLES as readonly string[]).includes(table)) {
    throw new Error(
      `Invalid table: "${table}". Valid tables: ${(VALID_TABLES as readonly string[]).join(', ')}`,
    );
  }
}

export function saveToForgeMemory(
  table: string,
  data: Record<string, unknown>,
  dbPath?: string,
): string {
  validateTable(table);
  const db = getConnection(dbPath);

  const record: Record<string, unknown> = { ...data };
  if (record['id'] === undefined) record['id'] = generateId();
  if (record['machine_id'] === undefined) record['machine_id'] = getMachineId(dbPath);
  if (record['created_at'] === undefined) record['created_at'] = new Date().toISOString();

  const keys = Object.keys(record);
  const placeholders = keys.map(() => '?').join(', ');
  const cols = keys.join(', ');
  const values: unknown[] = keys.map((k) => record[k] as unknown);

  db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`).run(...values);
  return record['id'] as string;
}

export function getForgeMemory(
  table: string,
  opts?: { where?: string; params?: unknown[]; orderBy?: string; limit?: number },
  dbPath?: string,
): unknown[] {
  validateTable(table);
  const db = getConnection(dbPath);

  let sql = `SELECT * FROM ${table}`;
  const params: unknown[] = [];

  if (opts?.where) {
    sql += ` WHERE ${opts.where}`;
    const whereParams = opts.params ?? [];
    params.push(...whereParams);
  }
  if (opts?.orderBy) {
    sql += ` ORDER BY ${opts.orderBy}`;
  }
  if (opts?.limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(opts.limit);
  }

  try {
    return db.prepare(sql).all(...params) as unknown[];
  } catch (err) {
    console.error(`getForgeMemory error on "${table}":`, err);
    return [];
  }
}

export function updateForgeMemory(
  table: string,
  id: string,
  data: Record<string, unknown>,
  dbPath?: string,
): boolean {
  validateTable(table);
  const db = getConnection(dbPath);

  const keys = Object.keys(data);
  if (keys.length === 0) return false;

  const setClauses = keys.map((k) => `${k} = ?`).join(', ');
  const values: unknown[] = [...keys.map((k) => data[k] as unknown), id];

  try {
    const result = db.prepare(`UPDATE ${table} SET ${setClauses} WHERE id = ?`).run(...values);
    return result.changes > 0;
  } catch (err) {
    console.error(`updateForgeMemory error on "${table}":`, err);
    return false;
  }
}

export function savePromptScore(
  score: {
    prompt_template_hash: string;
    task_type: string;
    tech_stack_tags: string[];
    first_pass_success: boolean;
    retry_count: number;
    tokens_consumed: number;
    gate_pass_rate: number;
    drift_score: number;
    project_name: string;
    build_id: string;
  },
  dbPath?: string,
): string {
  return saveToForgeMemory(
    'prompt_scores',
    {
      prompt_template_hash: score.prompt_template_hash,
      task_type: score.task_type,
      tech_stack_tags: JSON.stringify(score.tech_stack_tags),
      first_pass_success: score.first_pass_success ? 1 : 0,
      retry_count: score.retry_count,
      tokens_consumed: score.tokens_consumed,
      gate_pass_rate: score.gate_pass_rate,
      drift_score: score.drift_score,
      project_name: score.project_name,
      build_id: score.build_id,
    },
    dbPath,
  );
}

export function getBestPromptTemplates(
  taskType: string,
  _techStackTags: string[],
  minSamples: number = 3,
  dbPath?: string,
): Array<{ template_hash: string; avg_pass_rate: number; avg_tokens: number; sample_count: number }> {
  const db = getConnection(dbPath);
  const sql = `
    SELECT prompt_template_hash, AVG(first_pass_success) as avg_pass_rate,
           AVG(tokens_consumed) as avg_tokens, COUNT(*) as sample_count
    FROM prompt_scores
    WHERE task_type = ?
    GROUP BY prompt_template_hash
    HAVING COUNT(*) >= ?
    ORDER BY avg_pass_rate DESC
    LIMIT 5
  `;
  try {
    const rows = db.prepare(sql).all(taskType, minSamples) as Array<{
      prompt_template_hash: string;
      avg_pass_rate: number;
      avg_tokens: number;
      sample_count: number;
    }>;
    return rows.map((r) => ({
      template_hash: r.prompt_template_hash,
      avg_pass_rate: r.avg_pass_rate,
      avg_tokens: r.avg_tokens,
      sample_count: r.sample_count,
    }));
  } catch (err) {
    console.error('getBestPromptTemplates error:', err);
    return [];
  }
}

export function getFixPattern(fingerprint: string, dbPath?: string): FixPattern | null {
  const db = getConnection(dbPath);
  try {
    const row = db
      .prepare('SELECT * FROM fix_patterns WHERE error_fingerprint = ?')
      .get(fingerprint);
    return row ? (row as FixPattern) : null;
  } catch (err) {
    console.error('getFixPattern error:', err);
    return null;
  }
}

export function registerError(
  error: {
    errorCode: string;
    filePath: string;
    errorMessage: string;
    errorCategory: string;
    techStack: string[];
  },
  dbPath?: string,
): { id: string; fingerprint: string; isKnown: boolean; existingFix?: FixPattern } {
  const fingerprint = getErrorFingerprint(error);
  const existing = getFixPattern(fingerprint, dbPath);

  if (existing) {
    const db = getConnection(dbPath);
    db.prepare(
      `UPDATE fix_patterns SET occurrence_count = occurrence_count + 1, last_seen = datetime('now') WHERE error_fingerprint = ?`,
    ).run(fingerprint);
    return { id: existing.id, fingerprint, isKnown: true, existingFix: existing };
  }

  const filePathPattern = error.filePath.replace(/\\/g, '/').replace(/:\d+:\d+$/, '');
  const id = saveToForgeMemory(
    'fix_patterns',
    {
      error_fingerprint: fingerprint,
      error_message: error.errorMessage,
      error_category: error.errorCategory,
      file_path_pattern: filePathPattern,
      fix_files_modified: '[]',
      tech_stack_tags: JSON.stringify(error.techStack),
      occurrence_count: 1,
      success_rate: 0.0,
      times_fix_applied: 0,
      times_fix_succeeded: 0,
    },
    dbPath,
  );
  return { id, fingerprint, isKnown: false };
}

export function registerFix(
  fingerprint: string,
  fix: { fixDiff?: string; fixDescription: string; filesModified: string[] },
  dbPath?: string,
): void {
  const db = getConnection(dbPath);
  db.prepare(
    `UPDATE fix_patterns SET fix_diff = ?, fix_description = ?, fix_files_modified = ?, times_fix_applied = times_fix_applied + 1 WHERE error_fingerprint = ?`,
  ).run(fix.fixDiff ?? null, fix.fixDescription, JSON.stringify(fix.filesModified), fingerprint);
  db.prepare(
    `UPDATE fix_patterns SET success_rate = CAST(times_fix_succeeded AS REAL) / CAST(times_fix_applied AS REAL) WHERE error_fingerprint = ?`,
  ).run(fingerprint);
}

export function getGovernanceRules(
  techStackTags: string[],
  projectName?: string,
  dbPath?: string,
): GovernanceRule[] {
  const db = getConnection(dbPath);
  let sql: string;
  let params: unknown[];

  if (projectName !== undefined) {
    sql = `SELECT * FROM governance_rules WHERE active = 1 AND (scope = 'GLOBAL' OR (scope = 'PROJECT_SPECIFIC' AND project_name = ?)) ORDER BY enforcement_count DESC`;
    params = [projectName];
  } else {
    sql = `SELECT * FROM governance_rules WHERE active = 1 AND scope = 'GLOBAL' ORDER BY enforcement_count DESC`;
    params = [];
  }

  try {
    const rows = db.prepare(sql).all(...params) as GovernanceRule[];
    if (techStackTags.length === 0) return rows;
    return rows.filter((rule) => {
      let ruleTags: string[] = [];
      try {
        ruleTags = JSON.parse(rule.tech_stack_tags) as string[];
      } catch {
        // Invalid JSON in tech_stack_tags; treat as no tag restriction
      }
      return ruleTags.length === 0 || ruleTags.some((t) => techStackTags.includes(t));
    });
  } catch (err) {
    console.error('getGovernanceRules error:', err);
    return [];
  }
}

export function incrementGovernanceEnforcement(ruleId: string, dbPath?: string): void {
  const db = getConnection(dbPath);
  db.prepare(
    `UPDATE governance_rules SET enforcement_count = enforcement_count + 1, last_enforced = datetime('now') WHERE id = ?`,
  ).run(ruleId);
}

export function getDecisionWeights(
  decisionType: string,
  minBuilds: number = 2,
  dbPath?: string,
): Array<{ option: string; avg_error_rate: number; avg_retry_rate: number; total_samples: number }> {
  const db = getConnection(dbPath);
  const sql = `
    SELECT option_chosen, AVG(downstream_error_rate) as avg_error_rate,
           AVG(downstream_retry_rate) as avg_retry_rate, SUM(sample_size) as total_samples
    FROM decision_weights
    WHERE decision_type = ?
    GROUP BY option_chosen
    HAVING SUM(sample_size) >= ?
    ORDER BY avg_error_rate ASC
  `;
  try {
    const rows = db.prepare(sql).all(decisionType, minBuilds) as Array<{
      option_chosen: string;
      avg_error_rate: number;
      avg_retry_rate: number;
      total_samples: number;
    }>;
    return rows.map((r) => ({
      option: r.option_chosen,
      avg_error_rate: r.avg_error_rate,
      avg_retry_rate: r.avg_retry_rate,
      total_samples: r.total_samples,
    }));
  } catch (err) {
    console.error('getDecisionWeights error:', err);
    return [];
  }
}

export function getRelevantSkills(techStackTags: string[], dbPath?: string): SkillEntry[] {
  const db = getConnection(dbPath);
  try {
    const rows = db
      .prepare('SELECT * FROM skill_library ORDER BY effectiveness_rate DESC LIMIT 20')
      .all() as SkillEntry[];
    if (techStackTags.length === 0) return rows;
    return rows.filter((skill) => {
      let skillTags: string[] = [];
      try {
        skillTags = JSON.parse(skill.tech_stack_tags) as string[];
      } catch {
        // Invalid JSON in tech_stack_tags; treat as no tag restriction
      }
      return skillTags.length === 0 || skillTags.some((t) => techStackTags.includes(t));
    });
  } catch (err) {
    console.error('getRelevantSkills error:', err);
    return [];
  }
}

export function getPendingEvolutions(dbPath?: string): PendingEvolution[] {
  const db = getConnection(dbPath);
  try {
    return db
      .prepare(`SELECT * FROM pending_evolutions WHERE status = 'PENDING' ORDER BY confidence DESC`)
      .all() as PendingEvolution[];
  } catch (err) {
    console.error('getPendingEvolutions error:', err);
    return [];
  }
}

export function updateEvolutionStatus(
  id: string,
  status: 'APPROVED' | 'REJECTED',
  reviewNote?: string,
  dbPath?: string,
): void {
  const db = getConnection(dbPath);
  db.prepare(
    `UPDATE pending_evolutions SET status = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?`,
  ).run(status, reviewNote ?? null, id);
}
