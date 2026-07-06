/**
 * FORGE 2.0 — Core TypeScript interfaces.
 *
 * Each interface mirrors a table in SCHEMA_REGISTRY.md exactly: one field per
 * column, in column order. Type mapping conventions:
 *   uuid / text        -> string
 *   int                -> number
 *   numeric(p,s)       -> number
 *   boolean            -> boolean
 *   timestamptz        -> string (ISO 8601)
 *   jsonb (object)     -> Json / Record<string, unknown>
 *   jsonb (array)      -> Json[] / typed array
 *
 * NOT NULL columns are required. Nullable columns are typed `T | null`.
 * These interfaces describe a full database ROW (all columns present on read).
 */

/** A JSON-serializable value, as stored in a Postgres `jsonb` column. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/** Convenience alias for a `jsonb` object column. */
export type JsonObject = { [key: string]: Json };

// ---------------------------------------------------------------------------
// build_runs
// ---------------------------------------------------------------------------

export type BuildStatus = 'queued' | 'running' | 'completed' | 'failed' | 'halted';

/** Table: build_runs — tracks every autonomous build FORGE executes. */
export interface BuildRun {
  id: string;
  project_name: string;
  project_path: string;
  stack_fingerprint: JsonObject;
  status: BuildStatus;
  started_at: string | null;
  completed_at: string | null;
  total_prompts: number;
  completed_prompts: number;
  failed_prompts: number;
  total_errors: number;
  total_tokens: number;
  total_cost_usd: number;
  machine_id: string;
  toolchain_manifest: JsonObject;
  governance_hash: string | null;
  /** Short (8-char) sha256 hash of the queue.yaml this build ran against (Session 5.1 hotfix). */
  queue_hash: string | null;
  sentinel_interventions: number;
  autonomous_recovery_mode: boolean;
  parallel_prompts_used: boolean;
  dry_run: boolean;
  created_at: string;
}

// ---------------------------------------------------------------------------
// prompt_executions
// ---------------------------------------------------------------------------

export type PromptExecutionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

/** Table: prompt_executions — tracks individual prompt execution within a build. */
export interface PromptExecution {
  id: string;
  build_run_id: string;
  prompt_index: number;
  prompt_name: string;
  prompt_hash: string;
  prompt_content: string;
  status: PromptExecutionStatus;
  started_at: string | null;
  completed_at: string | null;
  /** Wall-clock duration of this prompt's execution, in ms (Session 5 finding #12 / #7). */
  duration_ms: number | null;
  tokens_input: number;
  tokens_output: number;
  cost_usd: number;
  error_output: string | null;
  resolution_applied: string | null;
  was_rewritten: boolean;
  original_prompt_hash: string | null;
  rewrite_reason: string | null;
  failure_prediction_score: number | null;
  branch_name: string | null;
  sentinel_passed: boolean | null;
  sentinel_details: JsonObject | null;
  files_created: string[];
  files_modified: string[];
  files_deleted: string[];
  created_at: string;
}

// ---------------------------------------------------------------------------
// error_patterns
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | 'type_error'
  | 'build_failure'
  | 'runtime'
  | 'schema'
  | 'auth'
  | 'dependency'
  | 'config';

/** Table: error_patterns — generalized error patterns extracted across builds. */
export interface ErrorPattern {
  id: string;
  error_signature: string;
  error_category: ErrorCategory;
  error_message_sample: string;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  first_seen_project: string;
  stack_fingerprints: JsonObject[];
  trigger_phase: string | null;
  trigger_prompt_pattern: string | null;
  resolution_id: string | null;
  prevention_rule: string | null;
  success_rate: number;
  auto_resolve_eligible: boolean;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// resolutions
// ---------------------------------------------------------------------------

export type ResolutionType =
  | 'prompt_rewrite'
  | 'config_change'
  | 'dependency_fix'
  | 'code_patch'
  | 'manual';

/** Table: resolutions — proven fixes for error patterns. */
export interface Resolution {
  id: string;
  error_pattern_id: string;
  resolution_type: ResolutionType;
  resolution_description: string;
  resolution_steps: Json;
  times_applied: number;
  times_succeeded: number;
  times_failed: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// governance_versions
// ---------------------------------------------------------------------------

export type GovernanceChangeSource =
  | 'manual'
  | 'recursive_learner'
  | 'error_prevention';

/** Table: governance_versions — version history of FORGE governance templates. */
export interface GovernanceVersion {
  id: string;
  template_name: string;
  version_number: number;
  content_hash: string;
  content_snapshot: string;
  changes_description: string | null;
  change_source: GovernanceChangeSource;
  effectiveness_score: number | null;
  builds_used_in: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// self_created_agents
// ---------------------------------------------------------------------------

export type SelfCreatedAgentStatus =
  | 'proposed'
  | 'approved'
  | 'active'
  | 'deprecated';

/** Table: self_created_agents — agents FORGE creates through recursive learning. */
export interface SelfCreatedAgent {
  id: string;
  name: string;
  purpose: string;
  trigger_conditions: JsonObject;
  input_contract: JsonObject;
  output_contract: JsonObject;
  implementation_code: string;
  source_pattern_description: string;
  test_results: JsonObject;
  status: SelfCreatedAgentStatus;
  approved_at: string | null;
  builds_used_in: number;
  effectiveness_score: number | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// cross_project_insights
// ---------------------------------------------------------------------------

export type InsightType =
  | 'pattern'
  | 'prevention'
  | 'optimization'
  | 'template_change';

/** Table: cross_project_insights — learnings transferable between projects. */
export interface CrossProjectInsight {
  id: string;
  insight_type: InsightType;
  source_project: string;
  source_build_id: string | null;
  applicable_fingerprints: JsonObject[];
  description: string;
  evidence: JsonObject;
  applied_count: number;
  effectiveness_score: number | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// production_telemetry
// ---------------------------------------------------------------------------

export type TelemetryEventType = 'error' | 'performance' | 'usage' | 'feedback';
export type TelemetrySeverity = 'critical' | 'warning' | 'info';

/** Table: production_telemetry — runtime data from deployed applications. */
export interface ProductionTelemetry {
  id: string;
  project_name: string;
  build_run_id: string | null;
  event_type: TelemetryEventType;
  event_data: JsonObject;
  severity: TelemetrySeverity | null;
  captured_at: string;
  fed_back_to_build: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// stack_profiles
// ---------------------------------------------------------------------------

/** Table: stack_profiles — reusable technology stack definitions. */
export interface StackProfile {
  id: string;
  name: string;
  description: string;
  stack_definition: JsonObject;
  toolchain_requirements: JsonObject;
  governance_template_set: string;
  sentinel_checks: JsonObject;
  build_commands: JsonObject;
  builds_completed: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// design_patterns
// ---------------------------------------------------------------------------

export type DesignPatternType =
  | 'ui_component'
  | 'auth_flow'
  | 'schema_pattern'
  | 'api_pattern';

/** Table: design_patterns — reusable UI/UX and architectural patterns. */
export interface DesignPattern {
  id: string;
  pattern_type: DesignPatternType;
  name: string;
  description: string;
  source_project: string;
  specification: JsonObject;
  usage_count: number;
  effectiveness_score: number | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// brand_identities
// ---------------------------------------------------------------------------

/** Table: brand_identities — persistent design tokens per brand/project. */
export interface BrandIdentity {
  id: string;
  project_name: string;
  brand_name: string;
  design_tokens: JsonObject;
  component_styles: JsonObject;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// scheduled_tasks
// ---------------------------------------------------------------------------

/**
 * The kinds of recurring work FORGE schedules for itself and the apps it builds.
 * Each maps to a built-in handler in `src/tools/task-scheduler.ts` (all overridable):
 *   research_agent — recurring research-agent runs
 *   memory_cleanup — prune aged Build Memory rows
 *   log_rotation   — gzip idle JSON-lines logs into archive/
 *   health_check   — production health probe over telemetry
 *   deadline_scan  — surface halted/overdue builds
 *   quota_reset    — track free-tier quota reset boundaries
 */
export type ScheduledTaskType =
  | 'research_agent'
  | 'memory_cleanup'
  | 'log_rotation'
  | 'health_check'
  | 'deadline_scan'
  | 'quota_reset';

/** Outcome of the most recent run of a scheduled task. */
export type ScheduledTaskResult = 'success' | 'failure' | 'skipped';

/**
 * Table: scheduled_tasks — a cron-scheduled recurring task whose schedule persists
 * in Build Memory so it survives FORGE restarts. See SCHEMA_REGISTRY.md (addendum).
 */
export interface ScheduledTask {
  id: string;
  name: string;
  description: string | null;
  task_type: ScheduledTaskType;
  /** Standard 5-field cron expression (minute hour day-of-month month day-of-week). */
  cron_expression: string;
  enabled: boolean;
  /** Machine that owns this schedule (Contract 20 multi-machine coordination). */
  machine_id: string | null;
  /** Free-form per-task config (retention windows, research targets, …). */
  metadata: JsonObject;
  last_run_at: string | null;
  next_run_at: string | null;
  last_result: ScheduledTaskResult | null;
  last_error: string | null;
  last_duration_ms: number | null;
  run_count: number;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// hook-manager (lifecycle hook system)
// ---------------------------------------------------------------------------

export type HookEvent =
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'session_start'
  | 'session_end'
  | 'pre_compact'
  | 'pre_file_write'
  | 'post_file_write'
  | 'pre_build'
  | 'post_build'
  | 'pre_prompt'
  | 'post_prompt';

export interface Hook {
  id: string;
  event: HookEvent;
  script: string;
  enabled: boolean;
  priority: number;
  description: string;
}

export interface HookResult {
  action: 'allow' | 'deny' | 'modify';
  reason?: string;
  additionalContext?: string;
}

// ---------------------------------------------------------------------------
// agent-shield (AgentShield security scanning)
// ---------------------------------------------------------------------------

export type SecurityGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export type AgentShieldCategory =
  | 'secrets'
  | 'permissions'
  | 'hook_injection'
  | 'mcp_risk'
  | 'insecure_defaults';

export interface SecurityFinding {
  category: AgentShieldCategory;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  file: string;
  line?: number;
  message: string;
  recommendation: string;
}

export interface SecurityReport {
  grade: SecurityGrade;
  findings: SecurityFinding[];
  recommendations: string[];
  scannedPaths: string[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// instincts (automated learning — extracted by instinct-extractor.ts)
// ---------------------------------------------------------------------------

/**
 * A learned rule distilled from observed build failures and their resolutions.
 * Stored as objects inside cross_project_insights.evidence.instincts arrays;
 * not a top-level database table.
 */
export interface Instinct {
  id: string;
  pattern: string;
  fix: string;
  confidence: number;
  source_project: string;
  times_applied: number;
  times_succeeded: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// governance-gate (pre-commit governance enforcement)
// ---------------------------------------------------------------------------

/** Result of a governance compliance check on a single file write. */
export interface GovernanceCheckResult {
  /** Whether the write is permitted. */
  allowed: boolean;
  /** Violations that caused a denial (empty when allowed). */
  violations: string[];
  /** Actionable suggestions for fixing the violations. */
  suggestions: string[];
}

// ---------------------------------------------------------------------------
// session-hooks (session lifecycle memory persistence)
// ---------------------------------------------------------------------------

/** An error encountered during a FORGE session, for error_patterns extraction. */
export interface SessionError {
  signature: string;
  category: ErrorCategory;
  message: string;
}

/** Context hydrated at session_start and injected into prompts to prevent context rot. */
export interface SessionContext {
  lastBuildRun: BuildRun | null;
  activeErrorPatterns: ErrorPattern[];
  applicableInsights: CrossProjectInsight[];
  promptInjection: string;
}

/** Metrics accumulated during a FORGE session, persisted at session_end. */
export interface SessionMetrics {
  buildRunId: string;
  promptsExecuted: number;
  passCount: number;
  failCount: number;
  errorsEncountered: SessionError[];
  patternsDiscovered: string[];
  totalTokens: number;
  totalCostUsd: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// repair-command
// ---------------------------------------------------------------------------

/** Categories of TypeScript compile errors addressed by repair mode. */
export type RepairErrorCategory =
  | 'missing_module'   // TS2307, TS7016 — cannot find module / no declaration file
  | 'missing_import'   // TS2304, TS2305, TS2306 — cannot find name / no exported member
  | 'type_mismatch'    // TS2322, TS2345, TS2339 — type assignability / property access
  | 'undefined_var'    // TS2532, TS2533, TS18047 — possibly null or undefined
  | 'enum_mismatch'    // TS2551, TS2361 — enum value / property mismatch
  | 'other';

/** A single TypeScript compiler error parsed from `pnpm tsc --noEmit` output. */
export interface TscError {
  /** Project-relative file path. */
  filePath: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  col: number;
  /** TypeScript error code, e.g. "TS2345". */
  code: string;
  /** Human-readable error message. */
  message: string;
  /** Classified repair category. */
  category: RepairErrorCategory;
}

/** A group of related TypeScript errors addressed by a single repair prompt. */
export interface RepairCluster {
  /** Stable id used as the queue entry id. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Primary error category for all errors in this cluster. */
  category: RepairErrorCategory;
  /** Project-relative paths of files touched by errors in this cluster. */
  files: string[];
  errors: TscError[];
  /** Repair priority (lower = fixed first). */
  priority: number;
}

/** Outcome of a compile or build gate check run after repair. */
export interface RepairGateResult {
  gate: 'compile' | 'build';
  passed: boolean;
  output: string;
  errorCount: number;
}

/** Minimal summary of Phase 3 execution embedded in RepairResult (avoids a circular dep on phase3-executor). */
export interface RepairExecutionSummary {
  buildRunId: string | null;
  status: string;
  completedPrompts: number;
  failedPrompts: number;
  skippedPrompts: number;
  haltReason: string | null;
  warnings: string[];
}

/** Options for {@link runRepairMode}. */
export interface RepairConfig {
  /** Path to write the generated repair queue.yaml. Defaults to `<projectPath>/repair-queue.yaml`. */
  repairQueuePath?: string;
  /** Execute the repair queue through Phase 3. Defaults to true. */
  executeRepairs?: boolean;
  /** Enable Autonomous Recovery Mode (Contract 14) during repair execution. Defaults to false. */
  autonomousRecovery?: boolean;
  /** Maximum repair clusters to generate; clusters beyond this are dropped with a warning. Defaults to 20. */
  maxClusters?: number;
  /** Progress reporter (same contract as other phase `log` callbacks). */
  log?: (message: string) => void;
}

/** Overall result of a {@link runRepairMode} run. */
export interface RepairResult {
  projectPath: string;
  status: 'success' | 'partial' | 'failed' | 'no_errors';
  /** TypeScript errors found before repair. */
  errorsFound: number;
  /** TypeScript errors remaining after repair (0 on success). */
  errorsAfterRepair: number;
  clusters: RepairCluster[];
  /** Path of the generated repair queue.yaml, or null if none was written. */
  repairQueuePath: string | null;
  /** Phase 3 execution summary, or null when execution was skipped. */
  executionResult: RepairExecutionSummary | null;
  gateResults: RepairGateResult[];
  warnings: string[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// six-laws-verifier (re-exported for external consumers)
// ---------------------------------------------------------------------------

/** The five automated laws, in order. */
export type LawName = 'SCHEMA' | 'API' | 'UI' | 'DATA' | 'WIRING';

/** A single observation made while verifying a law. */
export interface LawFinding {
  severity: 'pass' | 'warn' | 'fail';
  subject: string;
  detail: string;
}

/** The result of verifying one law. */
export interface LawResult {
  law: 1 | 2 | 3 | 4 | 5;
  name: LawName;
  passed: boolean;
  skipped: boolean;
  detail: string;
  findings: LawFinding[];
  durationMs: number;
}

/** The full Six Laws verification result (Contract 19 output). */
export interface SixLawsResult {
  passed: boolean;
  laws: LawResult[];
  law6: { name: 'VERIFICATION'; automated: false; detail: string };
  report: string;
  baseUrl: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// incremental-tester
// ---------------------------------------------------------------------------

/** The result for one test file (or one named check in a smoke suite). */
export interface TestFileResult {
  /** Absolute path of the test file, or a synthetic label like `compile:tsc --noEmit`. */
  file: string;
  passed: boolean;
  /** Wall-clock time in milliseconds. */
  duration: number;
  /** Combined stdout + stderr from the test runner. */
  output: string;
  /** Human-readable failure reason, or null on pass. */
  error: string | null;
}

/** The aggregate result returned by {@link runIncrementalTests} and {@link runSmokeTests}. */
export interface TestResult {
  /** False iff at least one file/check failed. */
  passed: boolean;
  totalFiles: number;
  passedFiles: number;
  failedFiles: number;
  /** Files/checks that were not evaluated (no matching test file found). */
  skippedFiles: number;
  results: TestFileResult[];
  /** Total wall-clock time in milliseconds. */
  duration: number;
  generatedAt: string;
}
