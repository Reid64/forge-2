import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getConnection } from './database.js';

export const HOOKS_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnhancedHookEvent =
  | 'SessionStart'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreCommit'
  | 'PreCompact'
  | 'PreDeploy'
  | 'PostDeploy'
  | 'SessionEnd';

export interface HookConditions {
  file_pattern?: string;
  exclude_pattern?: string;
  task_types?: string[];
  min_prompt_number?: number;
  phases?: string[];
}

export interface HookDefinition {
  name: string;
  event: EnhancedHookEvent;
  action: string;
  script: string | null;
  blocking: boolean;
  timeout_seconds: number;
  enabled: boolean;
  priority: number;
  description: string;
  conditions?: HookConditions;
}

export interface HookContext {
  project_path: string;
  build_id: string;
  prompt_number: number;
  file?: string;
  files?: string[];
  last_commit?: string;
  task_type?: string;
  phase?: string;
}

// ---------------------------------------------------------------------------
// matchGlob
// ---------------------------------------------------------------------------

function matchSingleSegment(pattern: string, segment: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = '^' + escaped.replace(/\*/g, '[^/]*') + '$';
  return new RegExp(regexStr).test(segment);
}

function matchSegments(patternSegs: string[], pathSegs: string[]): boolean {
  if (patternSegs.length === 0 && pathSegs.length === 0) return true;
  if (patternSegs.length === 0) return false;

  // Safe: length checked above
  const first = patternSegs[0] as string;
  const restPattern = patternSegs.slice(1);

  if (first === '**') {
    for (let i = 0; i <= pathSegs.length; i++) {
      if (matchSegments(restPattern, pathSegs.slice(i))) return true;
    }
    return false;
  }

  if (pathSegs.length === 0) return false;

  // Safe: length checked above
  const firstPath = pathSegs[0] as string;
  const restPath = pathSegs.slice(1);
  return matchSingleSegment(first, firstPath) && matchSegments(restPattern, restPath);
}

export function matchGlob(pattern: string, filePath: string): boolean {
  return matchSegments(pattern.split('/'), filePath.split('/'));
}

// ---------------------------------------------------------------------------
// testHookConditions
// ---------------------------------------------------------------------------

export function testHookConditions(hook: HookDefinition, context: HookContext): boolean {
  const { conditions } = hook;
  if (!conditions) return true;

  if (conditions.file_pattern !== undefined) {
    if (!context.file) return false;
    const file = context.file;
    const patterns = conditions.file_pattern.split(',').map((p) => p.trim());
    if (!patterns.some((p) => matchGlob(p, file))) return false;
  }

  if (conditions.exclude_pattern !== undefined && context.file) {
    const file = context.file;
    const patterns = conditions.exclude_pattern.split(',').map((p) => p.trim());
    if (patterns.some((p) => matchGlob(p, file))) return false;
  }

  if (conditions.task_types !== undefined) {
    if (!context.task_type || !conditions.task_types.includes(context.task_type)) return false;
  }

  if (conditions.min_prompt_number !== undefined) {
    if (context.prompt_number < conditions.min_prompt_number) return false;
  }

  if (conditions.phases !== undefined) {
    if (!context.phase || !conditions.phases.includes(context.phase)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// resolveHookTemplates
// ---------------------------------------------------------------------------

export function resolveHookTemplates(action: string, context: HookContext): string {
  const values: Record<string, string> = {
    file: context.file ?? '',
    files: context.files?.join(' ') ?? '',
    project_path: context.project_path ?? '',
    prompt_number: String(context.prompt_number),
    build_id: context.build_id ?? '',
    last_commit: context.last_commit ?? '',
    task_type: context.task_type ?? '',
    phase: context.phase ?? '',
  };

  return action.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] ?? '');
}

// ---------------------------------------------------------------------------
// generateDefaultHooksConfig — exactly 24 hooks
// ---------------------------------------------------------------------------

export function generateDefaultHooksConfig(_projectName: string): HookDefinition[] {
  return [
    // SessionStart (3)
    {
      name: 'sync-pull',
      event: 'SessionStart',
      action: 'typescript',
      script: 'syncPull',
      blocking: false,
      timeout_seconds: 60,
      enabled: true,
      priority: 1,
      description: 'Pull learning data from master drive',
    },
    {
      name: 'load-knowledge',
      event: 'SessionStart',
      action: 'typescript',
      script: 'loadKnowledge',
      blocking: false,
      timeout_seconds: 30,
      enabled: true,
      priority: 2,
      description: 'Load governance rules, skills, fix patterns',
    },
    {
      name: 'present-evolutions',
      event: 'SessionStart',
      action: 'typescript',
      script: 'presentEvolutions',
      blocking: false,
      timeout_seconds: 15,
      enabled: true,
      priority: 3,
      description: 'Show pending self-modification proposals',
    },

    // PreToolUse (2)
    {
      name: 'governance-check',
      event: 'PreToolUse',
      action: 'typescript',
      script: 'checkGovernance',
      blocking: true,
      timeout_seconds: 10,
      enabled: true,
      priority: 10,
      description: 'Inject matching governance rules into context',
    },
    {
      name: 'fix-pattern-check',
      event: 'PreToolUse',
      action: 'typescript',
      script: 'checkFixPatterns',
      blocking: false,
      timeout_seconds: 10,
      enabled: true,
      priority: 20,
      description: 'Inject known fixes as notes',
    },

    // PostToolUse (4)
    {
      name: 'tsc-check',
      event: 'PostToolUse',
      action: 'npx tsc --noEmit',
      script: null,
      blocking: true,
      timeout_seconds: 30,
      enabled: true,
      priority: 10,
      description: 'TypeScript compilation check',
      conditions: { file_pattern: '*.ts,*.tsx' },
    },
    {
      name: 'eslint-check',
      event: 'PostToolUse',
      action: 'npx eslint {{file}}',
      script: null,
      blocking: true,
      timeout_seconds: 30,
      enabled: true,
      priority: 20,
      description: 'ESLint check',
      conditions: { file_pattern: '*.ts,*.tsx', exclude_pattern: '*.config.*,*.d.ts' },
    },
    {
      name: 'schema-drift-inline',
      event: 'PostToolUse',
      action: 'typescript',
      script: 'checkSchemaDrift',
      blocking: true,
      timeout_seconds: 30,
      enabled: true,
      priority: 30,
      description: 'Schema drift check',
      conditions: { task_types: ['CRUD', 'INTEGRATION'] },
    },
    {
      name: 'score-prompt',
      event: 'PostToolUse',
      action: 'typescript',
      script: 'scorePrompt',
      blocking: false,
      timeout_seconds: 10,
      enabled: true,
      priority: 99,
      description: 'Record prompt execution score',
    },

    // PreCommit (3)
    {
      name: 'gitleaks-scan',
      event: 'PreCommit',
      action: 'gitleaks detect --source={{project_path}} --report-format json',
      script: null,
      blocking: true,
      timeout_seconds: 60,
      enabled: true,
      priority: 1,
      description: 'Scan for leaked secrets',
    },
    {
      name: 'schema-drift-commit',
      event: 'PreCommit',
      action: 'typescript',
      script: 'fullSchemaDriftCheck',
      blocking: true,
      timeout_seconds: 30,
      enabled: true,
      priority: 10,
      description: 'Full schema drift verification',
    },
    {
      name: 'governance-updated',
      event: 'PreCommit',
      action: 'typescript',
      script: 'verifyGovernanceUpdated',
      blocking: true,
      timeout_seconds: 15,
      enabled: true,
      priority: 20,
      description: 'Verify governance docs updated',
    },

    // PreCompact (1)
    {
      name: 'precompact-save',
      event: 'PreCompact',
      action: 'typescript',
      script: 'precompactSave',
      blocking: false,
      timeout_seconds: 10,
      enabled: true,
      priority: 1,
      description: 'Save critical context before compaction',
    },

    // PreDeploy (3)
    {
      name: 'sentinel-ring3',
      event: 'PreDeploy',
      action: 'typescript',
      script: 'sentinelRing3',
      blocking: true,
      timeout_seconds: 600,
      enabled: true,
      priority: 1,
      description: 'Full Ring 3 Sentinel pipeline',
    },
    {
      name: 'six-laws-check',
      event: 'PreDeploy',
      action: 'typescript',
      script: 'checkSixLaws',
      blocking: true,
      timeout_seconds: 30,
      enabled: true,
      priority: 10,
      description: 'Verify all Six Laws compliance',
    },
    {
      name: 'env-parity',
      event: 'PreDeploy',
      action: 'typescript',
      script: 'envParityCheck',
      blocking: true,
      timeout_seconds: 30,
      enabled: true,
      priority: 20,
      description: 'Compare local vs production env vars',
    },

    // PostDeploy (3)
    {
      name: 'health-check',
      event: 'PostDeploy',
      action: 'typescript',
      script: 'healthCheck',
      blocking: false,
      timeout_seconds: 30,
      enabled: true,
      priority: 1,
      description: 'HTTP 200 check on production URL',
    },
    {
      name: 'readme-update',
      event: 'PostDeploy',
      action: 'typescript',
      script: 'updateReadme',
      blocking: false,
      timeout_seconds: 30,
      enabled: true,
      priority: 10,
      description: 'Regenerate README from governance',
    },
    {
      name: 'deploy-summary',
      event: 'PostDeploy',
      action: 'typescript',
      script: 'deploySummary',
      blocking: false,
      timeout_seconds: 15,
      enabled: true,
      priority: 20,
      description: 'Log deploy summary to build_outcomes',
    },

    // SessionEnd (5)
    {
      name: 'sync-push',
      event: 'SessionEnd',
      action: 'typescript',
      script: 'syncPush',
      blocking: false,
      timeout_seconds: 60,
      enabled: true,
      priority: 1,
      description: 'Push learning data to master',
    },
    {
      name: 'update-weights',
      event: 'SessionEnd',
      action: 'typescript',
      script: 'updateWeights',
      blocking: false,
      timeout_seconds: 30,
      enabled: true,
      priority: 10,
      description: 'Compute downstream decision error rates',
    },
    {
      name: 'analyze-evolutions',
      event: 'SessionEnd',
      action: 'typescript',
      script: 'analyzeEvolutions',
      blocking: false,
      timeout_seconds: 30,
      enabled: true,
      priority: 20,
      description: 'Generate self-modification proposals',
    },
    {
      name: 'generate-handoff',
      event: 'SessionEnd',
      action: 'typescript',
      script: 'generateHandoff',
      blocking: false,
      timeout_seconds: 60,
      enabled: true,
      priority: 30,
      description: 'Produce SESSION_HANDOFF.md',
    },
    {
      name: 'git-push-end',
      event: 'SessionEnd',
      action: 'git add -A && git commit -m "FORGE-SESSION-END" && git push',
      script: null,
      blocking: false,
      timeout_seconds: 60,
      enabled: true,
      priority: 40,
      description: 'Final git commit and push',
    },
  ];
}

// ---------------------------------------------------------------------------
// writeDefaultHooksConfig
// ---------------------------------------------------------------------------

export function writeDefaultHooksConfig(projectPath: string, projectName: string): void {
  const forgeDir = join(projectPath, '.forge');
  mkdirSync(forgeDir, { recursive: true });
  const hooks = generateDefaultHooksConfig(projectName);
  writeFileSync(join(forgeDir, 'hooks.json'), JSON.stringify(hooks, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// handlePreToolUse — queries fix_patterns + governance_rules for context injection
// ---------------------------------------------------------------------------

export async function handlePreToolUse(
  taskType: string,
  techStackTags: string[],
  _promptNumber: number,
  dbPath?: string
): Promise<{ contextInjection: string; patternsFound: number; rulesFound: number }> {
  const resolvedPath = dbPath ?? join(homedir(), '.forge', 'forge_memory.db');

  if (!existsSync(resolvedPath)) {
    return { contextInjection: '', patternsFound: 0, rulesFound: 0 };
  }

  try {
    const db = getConnection(resolvedPath);

    // Query fix patterns with high success rate for this task type
    const patterns = db.prepare(`
      SELECT fix_description, fix_diff, error_category, success_rate, occurrence_count
      FROM fix_patterns
      WHERE (success_rate > 0.7 OR (success_rate > 0.5 AND occurrence_count >= 5))
        AND (tech_stack_tags LIKE ? OR tech_stack_tags = '[]' OR tech_stack_tags IS NULL)
      ORDER BY (success_rate * occurrence_count) DESC
      LIMIT 5
    `).all(`%${techStackTags[0] ?? 'typescript'}%`) as Array<{
      fix_description: string | null;
      fix_diff: string | null;
      error_category: string;
      success_rate: number;
      occurrence_count: number;
    }>;

    // Query active governance rules
    const rules = db.prepare(`
      SELECT rule_text, rule_short_name, enforcement_count
      FROM governance_rules
      WHERE active = 1
        AND (scope = 'GLOBAL' OR task_type = ? OR task_type IS NULL)
      ORDER BY enforcement_count DESC
      LIMIT 10
    `).all(taskType) as Array<{
      rule_text: string;
      rule_short_name: string;
      enforcement_count: number;
    }>;

    if (patterns.length === 0 && rules.length === 0) {
      return { contextInjection: '', patternsFound: 0, rulesFound: 0 };
    }

    const lines: string[] = [
      '=== FORGE LEARNING ENGINE CONTEXT ===',
    ];

    if (rules.length > 0) {
      lines.push('');
      lines.push('ACTIVE GOVERNANCE RULES (must be followed):');
      for (const r of rules) {
        lines.push(`  - ${r.rule_text}`);
      }
    }

    if (patterns.length > 0) {
      lines.push('');
      lines.push('KNOWN FIX PATTERNS (apply proactively):');
      for (const p of patterns) {
        const desc = p.fix_description ?? `Fix for ${p.error_category} errors`;
        const rate = (p.success_rate * 100).toFixed(0);
        lines.push(`  - [${p.error_category}] ${desc} (${rate}% success, ${p.occurrence_count} occurrences)`);
        if (p.fix_diff && p.fix_diff.length < 300) {
          lines.push(`    ${p.fix_diff}`);
        }
      }
    }

    lines.push('');
    lines.push('=== END LEARNING CONTEXT ===');
    lines.push('');

    // Update enforcement counts
    if (rules.length > 0) {
      const updateStmt = db.prepare(
        "UPDATE governance_rules SET enforcement_count = enforcement_count + 1, last_enforced = datetime('now') WHERE rule_short_name = ?"
      );
      for (const r of rules) {
        try { updateStmt.run(r.rule_short_name); } catch { /* non-fatal */ }
      }
    }

    return {
      contextInjection: lines.join('\n'),
      patternsFound: patterns.length,
      rulesFound: rules.length,
    };
  } catch {
    return { contextInjection: '', patternsFound: 0, rulesFound: 0 };
  }
}

// ---------------------------------------------------------------------------
// handlePostToolUse — records prompt scores and error fingerprints to DB
// ---------------------------------------------------------------------------

export async function handlePostToolUse(
  opts: {
    buildId: string;
    promptId: string;
    taskType: string;
    techStackTags: string[];
    firstPassSuccess: boolean;
    retryCount: number;
    tokensConsumed: number;
    gatPassRate: number;
    errorOutput: string;
    filesModified: string[];
    projectName: string;
    dbPath?: string;
  }
): Promise<void> {
  const resolvedPath = opts.dbPath ?? join(homedir(), '.forge', 'forge_memory.db');
  if (!existsSync(resolvedPath)) return;

  try {
    const db = getConnection(resolvedPath);
    const { randomUUID, createHash } = await import('node:crypto');

    // 1. Record prompt score
    const templateHash = createHash('sha256')
      .update(`${opts.taskType}:${opts.promptId}`)
      .digest('hex');

    db.prepare(`
      INSERT OR REPLACE INTO prompt_scores
        (id, prompt_template_hash, task_type, tech_stack_tags, first_pass_success,
         retry_count, tokens_consumed, gate_pass_rate, drift_score,
         project_name, build_id, machine_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'unknown', datetime('now'))
    `).run(
      randomUUID(),
      templateHash,
      opts.taskType,
      JSON.stringify(opts.techStackTags),
      opts.firstPassSuccess ? 1 : 0,
      opts.retryCount,
      opts.tokensConsumed,
      opts.gatPassRate,
      opts.projectName,
      opts.buildId
    );

    // 2. Register error fingerprints if failed
    if (!opts.firstPassSuccess && opts.errorOutput) {
      // Parse TypeScript errors from output
      const tscErrors = opts.errorOutput.matchAll(
        /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm
      );

      for (const m of tscErrors) {
        const [, filePath, , , errorCode, message] = m;
        if (!filePath || !errorCode || !message) continue;

        // Generalize file path to pattern
        const filePattern = (filePath ?? '')
          .replace(/\\/g, '/')
          .replace(/src\/[^/]+\//, 'src/*/')
          .replace(/\d+/g, 'N');

        const fingerprint = createHash('sha256')
          .update(`${errorCode}:${filePattern}:${(message ?? '').substring(0, 100)}`)
          .digest('hex')
          .substring(0, 32);

        // Upsert fix_pattern
        const existing = db.prepare(
          'SELECT id, occurrence_count FROM fix_patterns WHERE error_fingerprint = ?'
        ).get(fingerprint) as { id: string; occurrence_count: number } | undefined;

        if (existing) {
          db.prepare(
            "UPDATE fix_patterns SET occurrence_count = occurrence_count + 1, last_seen = datetime('now') WHERE error_fingerprint = ?"
          ).run(fingerprint);
        } else {
          db.prepare(`
            INSERT OR IGNORE INTO fix_patterns
              (id, error_fingerprint, error_message, error_category, file_path_pattern,
               fix_diff, fix_description, fix_files_modified, tech_stack_tags,
               occurrence_count, success_rate, times_fix_applied, times_fix_succeeded,
               last_seen, machine_id, created_at)
            VALUES (?, ?, ?, 'COMPILE', ?, null, null, '[]', ?, 1, 0, 0, 0, datetime('now'), 'unknown', datetime('now'))
          `).run(
            randomUUID(),
            fingerprint,
            `${errorCode}: ${(message ?? '').substring(0, 200)}`,
            filePattern,
            JSON.stringify(opts.techStackTags)
          );
        }
      }
    }

    // 3. Record files modified to hook_execution_log
    if (opts.filesModified.length > 0) {
      db.prepare(`
        INSERT INTO hook_execution_log
          (id, hook_name, event, status, duration_ms, output, build_id, machine_id, created_at)
        VALUES (?, 'files-modified', 'PostToolUse', 'PASS', 0, ?, ?, 'unknown', datetime('now'))
      `).run(
        randomUUID(),
        JSON.stringify(opts.filesModified),
        opts.buildId
      );
    }
  } catch { /* non-fatal */ }
}

