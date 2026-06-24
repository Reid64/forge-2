// FORGE 2.0 Learning Engine — Type Definitions

export interface ForgeMeta {
  key: string;
  value: string;
}

export interface PromptScore {
  id: string;
  prompt_template_hash: string;
  task_type: 'SCAFFOLD' | 'CRUD' | 'INTEGRATION' | 'AI_PIPELINE' | 'CONFIG' | 'TEST' | 'FIX';
  tech_stack_tags: string;
  first_pass_success: 0 | 1;
  retry_count: number;
  tokens_consumed: number;
  gate_pass_rate: number;
  drift_score: number;
  project_name: string;
  build_id: string;
  machine_id: string;
  created_at: string;
}

export interface FixPattern {
  id: string;
  error_fingerprint: string;
  error_message: string;
  error_category: 'COMPILE' | 'RUNTIME' | 'TEST' | 'LINT' | 'SECURITY' | 'SCHEMA' | 'DEPLOY';
  file_path_pattern: string;
  fix_diff: string | null;
  fix_description: string | null;
  fix_files_modified: string;
  tech_stack_tags: string;
  occurrence_count: number;
  success_rate: number;
  times_fix_applied: number;
  times_fix_succeeded: number;
  auto_governance_rule: string | null;
  governance_rule_id: string | null;
  last_seen: string;
  machine_id: string;
  created_at: string;
}

export interface GovernanceRule {
  id: string;
  rule_text: string;
  rule_short_name: string;
  source: 'MANUAL' | 'AUTO_ELEVATED' | 'INSTINCT' | 'RETROFIT';
  source_error_fingerprint: string | null;
  tech_stack_tags: string;
  scope: 'GLOBAL' | 'PROJECT_SPECIFIC';
  project_name: string | null;
  active: 0 | 1;
  enforcement_count: number;
  last_enforced: string | null;
  machine_id: string;
  created_at: string;
}

export interface PendingEvolution {
  id: string;
  evolution_type: 'HOOK' | 'TEMPLATE' | 'RULE' | 'THRESHOLD' | 'CONFIG' | 'GATE';
  proposed_change: string;
  change_detail: string;
  evidence: string;
  estimated_impact: string;
  confidence: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED';
  reviewed_at: string | null;
  review_note: string | null;
  machine_id: string;
  created_at: string;
}

export interface BuildOutcome {
  id: string;
  project_name: string;
  mode: 'GREENFIELD' | 'RETROFIT';
  start_time: string;
  end_time: string | null;
  end_reason: 'COMPLETED' | 'PAUSED' | 'FAILED' | 'INTERRUPTED' | null;
  total_prompts_planned: number;
  total_prompts_executed: number;
  prompts_passed: number;
  prompts_retried: number;
  prompts_failed: number;
  total_tokens: number;
  architecture_decisions: string;
  maturity_stage: 'FOUNDATION' | 'GROWTH' | 'ENTERPRISE' | null;
  first_pass_rate: number | null;
  machine_id: string;
  created_at: string;
}

export interface SkillEntry {
  id: string;
  skill_name: string;
  content: string;
  tech_stack_tags: string;
  source_error_fingerprint: string | null;
  source_build_id: string | null;
  trigger_context: string | null;
  usage_count: number;
  effectiveness_rate: number;
  times_injected: number;
  times_prevented_error: number;
  machine_id: string;
  created_at: string;
}

export interface SyncConfig {
  master_path: string;
  lock_file: string;
  max_wait_seconds: number;
  retry_interval_seconds: number;
}

export interface HookDefinition {
  name: string;
  event: 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'SessionEnd' | 'PreCompact' | 'PreCommit' | 'PreDeploy' | 'PostDeploy';
  action: string;
  script: string | null;
  blocking: boolean;
  timeout_seconds: number;
  enabled: boolean;
  on_failure?: 'BLOCK' | 'REVERT' | 'WARN';
  priority: number;
  description?: string;
  conditions?: HookConditions | null;
}

export interface HookConditions {
  file_pattern?: string;
  exclude_pattern?: string;
  task_types?: string[];
  min_prompt_number?: number;
  phases?: string[];
}

export interface HookContext {
  project_path: string;
  build_id: string;
  prompt_number: number;
  file?: string;
  files?: string;
  task_type?: string;
  phase?: string;
  last_commit?: string;
}

export interface HookResult {
  status: 'PASS' | 'FAIL' | 'TIMEOUT' | 'SKIP';
  output: string;
  hook_name: string;
  duration_ms: number;
}

export interface AdversaryFindingRecord {
  id: string;
  build_id: string;
  phase: string;
  severity: 'BLOCKER' | 'SIGNIFICANT' | 'MINOR' | 'DISMISSED';
  vector: string | null;
  issue: string;
  fix: string | null;
  resolution: 'PENDING' | 'FIXED' | 'DISMISSED' | 'DEFERRED';
  resolved_at: string | null;
  machine_id: string;
  created_at: string;
}

export interface BuildFingerprintRecord {
  id: string;
  build_id: string;
  project_name: string;
  fingerprint: string;
  file_count: number;
  total_size_kb: number;
  computed_at: string;
  machine_id: string;
}

export interface HookExecutionLog {
  id: string;
  hook_name: string;
  event: string;
  status: 'PASS' | 'FAIL' | 'TIMEOUT' | 'SKIP';
  duration_ms: number;
  output: string | null;
  build_id: string;
  prompt_number: number | null;
  machine_id: string;
  created_at: string;
}

export interface CompactSnapshot {
  id: string;
  build_id: string;
  prompt_index: number;
  state_json: string;
  machine_id: string;
  created_at: string;
}

export interface DecisionWeight {
  id: string;
  template_hash: string;
  task_type: string;
  downstream_error_rate: number;
  sample_count: number;
  updated_at: string | null;
  created_at: string;
}

export const VALID_TABLES = [
  'forge_meta', 'prompt_scores', 'fix_patterns', 'decision_weights',
  'governance_rules', 'pending_evolutions', 'build_outcomes', 'skill_library',
  'reconcile_decisions', 'scan_reports', 'hook_execution_log', 'compact_snapshots',
  'build_fingerprints', 'adversary_findings'
] as const;

export type ValidTable = typeof VALID_TABLES[number];

export const TASK_TYPES = ['SCAFFOLD', 'CRUD', 'INTEGRATION', 'AI_PIPELINE', 'CONFIG', 'TEST', 'FIX'] as const;
export const ERROR_CATEGORIES = ['COMPILE', 'RUNTIME', 'TEST', 'LINT', 'SECURITY', 'SCHEMA', 'DEPLOY'] as const;
export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'PreCompact', 'PreCommit', 'PreDeploy', 'PostDeploy'] as const;
