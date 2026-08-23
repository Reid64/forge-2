// FORGE 2.0 Learning Engine — Database Initialization
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_DB_DIR = join(homedir(), '.forge');
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, 'forge_memory.db');

/**
 * The schema version `initializeForgeMemory` migrates every database to. Single source of
 * truth — bump this (and add a schema block + migration step) when the schema changes; nothing
 * else, including tests, should hardcode a version literal.
 */
export const CURRENT_SCHEMA_VERSION = '3.4.0';

let cachedMachineId: string | null = null;
const connectionCache = new Map<string, Database.Database>();

export function getForgeDbPath(): string {
  if (!existsSync(DEFAULT_DB_DIR)) {
    mkdirSync(DEFAULT_DB_DIR, { recursive: true });
  }
  return DEFAULT_DB_PATH;
}

export function getConnection(dbPath?: string): Database.Database {
  const resolvedPath = dbPath || getForgeDbPath();
  if (connectionCache.has(resolvedPath)) {
    return connectionCache.get(resolvedPath)!;
  }
  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  connectionCache.set(resolvedPath, db);
  return db;
}

export function closeConnection(dbPath?: string): void {
  const resolvedPath = dbPath || getForgeDbPath();
  const db = connectionCache.get(resolvedPath);
  if (db) {
    db.close();
    connectionCache.delete(resolvedPath);
  }
}

export function getMachineId(dbPath?: string): string {
  if (cachedMachineId) return cachedMachineId;

  const db = getConnection(dbPath);

  // Try reading from forge_meta first
  try {
    const row = db.prepare("SELECT value FROM forge_meta WHERE key = 'machine_id'").get() as { value: string } | undefined;
    if (row && row.value && row.value.length === 16) {
      cachedMachineId = row.value;
      return cachedMachineId;
    }
  } catch { /* table might not exist yet */ }

  // Generate from hostname + MAC
  const host = hostname();
  const nets = networkInterfaces();
  let mac = '00:00:00:00:00:00';
  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        mac = iface.mac;
        break;
      }
    }
    if (mac !== '00:00:00:00:00:00') break;
  }

  const raw = `${host}|${mac}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  cachedMachineId = hash.substring(0, 16);

  // Store in forge_meta
  try {
    db.prepare("INSERT OR REPLACE INTO forge_meta (key, value) VALUES ('machine_id', ?)").run(cachedMachineId);
  } catch { /* table might not exist yet — will be stored after init */ }

  return cachedMachineId;
}

/**
 * Build Memory tables (`src/memory/` CRUD layer — build_runs, error_patterns, …),
 * unified into the same database file as the learning-engine tables above.
 * Column shapes mirror `src/types/index.ts` exactly: uuid/text -> TEXT, int ->
 * INTEGER, numeric -> REAL, boolean -> INTEGER (0/1), timestamptz -> TEXT (ISO
 * 8601), jsonb -> TEXT (JSON.stringify'd; parsed on read by the CRUD modules).
 */
const BUILD_MEMORY_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS build_runs (
      id                        TEXT PRIMARY KEY,
      project_name              TEXT NOT NULL,
      project_path               TEXT NOT NULL,
      stack_fingerprint          TEXT NOT NULL DEFAULT '{}',
      status                     TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','halted')),
      started_at                 TEXT,
      completed_at                TEXT,
      total_prompts               INTEGER NOT NULL DEFAULT 0,
      completed_prompts           INTEGER NOT NULL DEFAULT 0,
      failed_prompts              INTEGER NOT NULL DEFAULT 0,
      total_errors                INTEGER NOT NULL DEFAULT 0,
      total_tokens                 INTEGER NOT NULL DEFAULT 0,
      total_cost_usd               REAL NOT NULL DEFAULT 0,
      machine_id                   TEXT NOT NULL,
      toolchain_manifest           TEXT NOT NULL DEFAULT '{}',
      governance_hash              TEXT,
      sentinel_interventions        INTEGER NOT NULL DEFAULT 0,
      autonomous_recovery_mode      INTEGER NOT NULL DEFAULT 0,
      parallel_prompts_used         INTEGER NOT NULL DEFAULT 0,
      dry_run                      INTEGER NOT NULL DEFAULT 0,
      session_snapshots             TEXT,
      created_at                   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_build_runs_project ON build_runs(project_name);
    CREATE INDEX IF NOT EXISTS idx_build_runs_status ON build_runs(status);
    CREATE INDEX IF NOT EXISTS idx_build_runs_created ON build_runs(created_at DESC);

    CREATE TABLE IF NOT EXISTS prompt_executions (
      id                        TEXT PRIMARY KEY,
      build_run_id               TEXT NOT NULL,
      prompt_index                INTEGER NOT NULL,
      prompt_name                 TEXT NOT NULL,
      prompt_hash                 TEXT NOT NULL,
      prompt_content               TEXT NOT NULL,
      status                     TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','skipped')),
      started_at                 TEXT,
      completed_at                TEXT,
      duration_ms                 INTEGER,
      tokens_input                 INTEGER NOT NULL DEFAULT 0,
      tokens_output                INTEGER NOT NULL DEFAULT 0,
      cost_usd                    REAL NOT NULL DEFAULT 0,
      error_output                 TEXT,
      resolution_applied            TEXT,
      was_rewritten                INTEGER NOT NULL DEFAULT 0,
      original_prompt_hash          TEXT,
      rewrite_reason                TEXT,
      failure_prediction_score      REAL,
      branch_name                  TEXT,
      sentinel_passed              INTEGER,
      sentinel_details              TEXT,
      files_created                TEXT NOT NULL DEFAULT '[]',
      files_modified                TEXT NOT NULL DEFAULT '[]',
      files_deleted                 TEXT NOT NULL DEFAULT '[]',
      created_at                   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_executions_build ON prompt_executions(build_run_id, prompt_index);

    CREATE TABLE IF NOT EXISTS error_patterns (
      id                        TEXT PRIMARY KEY,
      error_signature             TEXT NOT NULL,
      error_category               TEXT NOT NULL CHECK(error_category IN ('type_error','build_failure','runtime','schema','auth','dependency','config')),
      error_message_sample          TEXT NOT NULL,
      occurrence_count             INTEGER NOT NULL DEFAULT 1,
      first_seen_at                TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at                 TEXT NOT NULL DEFAULT (datetime('now')),
      first_seen_project            TEXT NOT NULL,
      stack_fingerprints            TEXT NOT NULL DEFAULT '[]',
      trigger_phase                 TEXT,
      trigger_prompt_pattern         TEXT,
      resolution_id                 TEXT,
      prevention_rule                TEXT,
      success_rate                 REAL NOT NULL DEFAULT 0,
      auto_resolve_eligible          INTEGER NOT NULL DEFAULT 0,
      created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_error_patterns_signature ON error_patterns(error_signature);
    CREATE INDEX IF NOT EXISTS idx_error_patterns_prompt_type ON error_patterns(trigger_prompt_pattern);
    CREATE INDEX IF NOT EXISTS idx_error_patterns_occurrence ON error_patterns(occurrence_count DESC);

    CREATE TABLE IF NOT EXISTS resolutions (
      id                        TEXT PRIMARY KEY,
      error_pattern_id             TEXT NOT NULL,
      resolution_type               TEXT NOT NULL CHECK(resolution_type IN ('prompt_rewrite','config_change','dependency_fix','code_patch','manual')),
      resolution_description        TEXT NOT NULL,
      resolution_steps              TEXT NOT NULL DEFAULT '[]',
      times_applied                 INTEGER NOT NULL DEFAULT 0,
      times_succeeded               INTEGER NOT NULL DEFAULT 0,
      times_failed                  INTEGER NOT NULL DEFAULT 0,
      created_at                   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_resolutions_error_pattern ON resolutions(error_pattern_id);

    CREATE TABLE IF NOT EXISTS governance_versions (
      id                        TEXT PRIMARY KEY,
      template_name                TEXT NOT NULL,
      version_number                INTEGER NOT NULL,
      content_hash                 TEXT NOT NULL,
      content_snapshot              TEXT NOT NULL,
      changes_description           TEXT,
      change_source                 TEXT NOT NULL CHECK(change_source IN ('manual','recursive_learner','error_prevention')),
      effectiveness_score           REAL,
      builds_used_in                INTEGER NOT NULL DEFAULT 0,
      created_at                   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_governance_versions_template_version ON governance_versions(template_name, version_number);

    CREATE TABLE IF NOT EXISTS self_created_agents (
      id                        TEXT PRIMARY KEY,
      name                       TEXT NOT NULL,
      purpose                    TEXT NOT NULL,
      trigger_conditions            TEXT NOT NULL DEFAULT '{}',
      input_contract                TEXT NOT NULL DEFAULT '{}',
      output_contract               TEXT NOT NULL DEFAULT '{}',
      implementation_code           TEXT NOT NULL,
      source_pattern_description     TEXT NOT NULL,
      test_results                 TEXT NOT NULL DEFAULT '{}',
      status                     TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','approved','active','deprecated')),
      approved_at                  TEXT,
      builds_used_in                INTEGER NOT NULL DEFAULT 0,
      effectiveness_score           REAL,
      created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_self_created_agents_status ON self_created_agents(status);

    CREATE TABLE IF NOT EXISTS cross_project_insights (
      id                        TEXT PRIMARY KEY,
      insight_type                 TEXT NOT NULL CHECK(insight_type IN ('pattern','prevention','optimization','template_change')),
      source_project                TEXT NOT NULL,
      source_build_id               TEXT,
      applicable_fingerprints        TEXT NOT NULL DEFAULT '[]',
      description                  TEXT NOT NULL,
      evidence                    TEXT NOT NULL DEFAULT '{}',
      applied_count                 INTEGER NOT NULL DEFAULT 0,
      effectiveness_score           REAL,
      created_at                   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cross_project_insights_project ON cross_project_insights(source_project, created_at DESC);

    CREATE TABLE IF NOT EXISTS production_telemetry (
      id                        TEXT PRIMARY KEY,
      project_name                 TEXT NOT NULL,
      build_run_id                 TEXT,
      event_type                   TEXT NOT NULL CHECK(event_type IN ('error','performance','usage','feedback')),
      event_data                   TEXT NOT NULL DEFAULT '{}',
      severity                    TEXT CHECK(severity IN ('critical','warning','info') OR severity IS NULL),
      captured_at                  TEXT NOT NULL DEFAULT (datetime('now')),
      fed_back_to_build              TEXT,
      created_at                   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_production_telemetry_project ON production_telemetry(project_name, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_production_telemetry_severity ON production_telemetry(severity, captured_at DESC);

    CREATE TABLE IF NOT EXISTS stack_profiles (
      id                        TEXT PRIMARY KEY,
      name                       TEXT NOT NULL,
      description                  TEXT NOT NULL,
      stack_definition               TEXT NOT NULL DEFAULT '{}',
      toolchain_requirements          TEXT NOT NULL DEFAULT '{}',
      governance_template_set         TEXT NOT NULL,
      sentinel_checks               TEXT NOT NULL DEFAULT '{}',
      build_commands                TEXT NOT NULL DEFAULT '{}',
      builds_completed              INTEGER NOT NULL DEFAULT 0,
      created_at                   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stack_profiles_name ON stack_profiles(name);

    CREATE TABLE IF NOT EXISTS design_patterns (
      id                        TEXT PRIMARY KEY,
      pattern_type                 TEXT NOT NULL CHECK(pattern_type IN ('ui_component','auth_flow','schema_pattern','api_pattern')),
      name                       TEXT NOT NULL,
      description                  TEXT NOT NULL,
      source_project                TEXT NOT NULL,
      specification                 TEXT NOT NULL DEFAULT '{}',
      usage_count                  INTEGER NOT NULL DEFAULT 0,
      effectiveness_score           REAL,
      created_at                   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_design_patterns_type ON design_patterns(pattern_type, usage_count DESC);

    CREATE TABLE IF NOT EXISTS brand_identities (
      id                        TEXT PRIMARY KEY,
      project_name                 TEXT NOT NULL,
      brand_name                   TEXT NOT NULL,
      design_tokens                 TEXT NOT NULL DEFAULT '{}',
      component_styles              TEXT NOT NULL DEFAULT '{}',
      created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_identities_project ON brand_identities(project_name);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id                        TEXT PRIMARY KEY,
      name                       TEXT NOT NULL,
      description                  TEXT,
      task_type                    TEXT NOT NULL CHECK(task_type IN ('research_agent','memory_cleanup','log_rotation','health_check','deadline_scan','quota_reset')),
      cron_expression                TEXT NOT NULL,
      enabled                     INTEGER NOT NULL DEFAULT 1,
      machine_id                   TEXT,
      metadata                    TEXT NOT NULL DEFAULT '{}',
      last_run_at                  TEXT,
      next_run_at                  TEXT,
      last_result                  TEXT CHECK(last_result IN ('success','failure','skipped') OR last_result IS NULL),
      last_error                   TEXT,
      last_duration_ms               INTEGER,
      run_count                    INTEGER NOT NULL DEFAULT 0,
      failure_count                 INTEGER NOT NULL DEFAULT 0,
      created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tasks_name ON scheduled_tasks(name);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_type ON scheduled_tasks(task_type, enabled);
`;

/**
 * Prompt-library versioning (Session 3 — Autonomy). Every successful `forge compile` snapshots
 * the written queue.yaml under `<project>/.forge/queue-history/` and records one row here — see
 * `src/tools/queue-versioning.ts`. Schema bump 2.0.0 -> 2.1.0.
 */
const QUEUE_VERSIONING_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS queue_versions (
      id             TEXT PRIMARY KEY,
      project_name   TEXT NOT NULL,
      queue_hash     TEXT NOT NULL,
      entry_count    INTEGER NOT NULL DEFAULT 0,
      snapshot_path  TEXT NOT NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_queue_versions_project ON queue_versions(project_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_queue_versions_hash ON queue_versions(queue_hash);
`;

/**
 * Systems 1-3 tables (schema bump 2.2.1 -> 2.3.0). Column/index/CHECK definitions are
 * copied VERBATIM from `upgrades/SCHEMA_ADDITIONS.md` §1-§6 — that document is the
 * authoritative schema contract for these six tables; no column here may drift from it.
 */
const SYSTEMS_1_3_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS gap_audit_runs (
      id                     TEXT PRIMARY KEY,
      project_name           TEXT NOT NULL,
      project_path           TEXT NOT NULL,
      build_run_id           TEXT,
      audit_trigger          TEXT NOT NULL CHECK(audit_trigger IN ('manual','scheduled','retrofit_entry','halt_recovery','post_build')),
      scope                  TEXT NOT NULL CHECK(scope IN ('FULL','GOVERNANCE_ONLY','CODE_ONLY','TARGETED')),
      status                 TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','halted_for_human')),
      started_at             TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at           TEXT,
      duration_ms            INTEGER,
      artifacts_audited      TEXT NOT NULL DEFAULT '[]',
      gaps_found_total       INTEGER NOT NULL DEFAULT 0,
      gaps_minor             INTEGER NOT NULL DEFAULT 0,
      gaps_major             INTEGER NOT NULL DEFAULT 0,
      gaps_critical          INTEGER NOT NULL DEFAULT 0,
      gaps_auto_regenerated  INTEGER NOT NULL DEFAULT 0,
      gaps_human_gated       INTEGER NOT NULL DEFAULT 0,
      halt_point_reference   TEXT,
      continuation_plan      TEXT,
      health_score_before    REAL,
      health_score_after     REAL,
      report_path            TEXT,
      machine_id             TEXT NOT NULL,
      created_at             TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gap_audit_runs_project ON gap_audit_runs(project_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gap_audit_runs_status ON gap_audit_runs(status);
    CREATE INDEX IF NOT EXISTS idx_gap_audit_runs_build ON gap_audit_runs(build_run_id);

    CREATE TABLE IF NOT EXISTS artifact_health_scores (
      id                        TEXT PRIMARY KEY,
      gap_audit_run_id          TEXT NOT NULL,
      artifact_name             TEXT NOT NULL CHECK(artifact_name IN ('PRD','SCHEMA_REGISTRY','AGENTS','BEHAVIORAL_CONTRACTS','BLUEPRINT','TOOLCHAIN','SESSION_STATE','STATE_OF_THE_BUILD','TESTING')),
      exists_on_disk            INTEGER NOT NULL DEFAULT 0 CHECK(exists_on_disk IN (0,1)),
      completeness_score        REAL NOT NULL DEFAULT 0 CHECK(completeness_score >= 0.0 AND completeness_score <= 1.0),
      freshness_score           REAL NOT NULL DEFAULT 0 CHECK(freshness_score >= 0.0 AND freshness_score <= 1.0),
      consistency_score         REAL NOT NULL DEFAULT 0 CHECK(consistency_score >= 0.0 AND consistency_score <= 1.0),
      composite_score           REAL NOT NULL DEFAULT 0 CHECK(composite_score >= 0.0 AND composite_score <= 1.0),
      drift_detected            INTEGER NOT NULL DEFAULT 0 CHECK(drift_detected IN (0,1)),
      drift_detail              TEXT,
      missing_sections          TEXT NOT NULL DEFAULT '[]',
      placeholder_count         INTEGER NOT NULL DEFAULT 0,
      regeneration_recommended  INTEGER NOT NULL DEFAULT 0 CHECK(regeneration_recommended IN (0,1)),
      regeneration_tier         TEXT CHECK(regeneration_tier IN ('AUTO','HUMAN_GATE') OR regeneration_tier IS NULL),
      scored_at                 TEXT NOT NULL DEFAULT (datetime('now')),
      machine_id                TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_health_audit ON artifact_health_scores(gap_audit_run_id);
    CREATE INDEX IF NOT EXISTS idx_artifact_health_name ON artifact_health_scores(artifact_name);
    CREATE INDEX IF NOT EXISTS idx_artifact_health_score ON artifact_health_scores(composite_score ASC);

    CREATE TABLE IF NOT EXISTS evolution_promotions (
      id                            TEXT PRIMARY KEY,
      pending_evolution_id          TEXT NOT NULL,
      evolution_type                TEXT NOT NULL CHECK(evolution_type IN ('HOOK','TEMPLATE','RULE','THRESHOLD','CONFIG','GATE')),
      confidence_at_promotion       REAL NOT NULL CHECK(confidence_at_promotion >= 0.0 AND confidence_at_promotion <= 1.0),
      confidence_threshold_applied  REAL NOT NULL CHECK(confidence_threshold_applied >= 0.0 AND confidence_threshold_applied <= 1.0),
      promotion_method              TEXT NOT NULL CHECK(promotion_method IN ('AUTO','HUMAN_APPROVED','HUMAN_OVERRIDE_REJECTED')),
      evidence_build_count          INTEGER NOT NULL DEFAULT 0,
      pre_promotion_success_rate    REAL,
      post_promotion_success_rate   REAL,
      monitoring_window_builds      INTEGER NOT NULL DEFAULT 10,
      rollback_triggered            INTEGER NOT NULL DEFAULT 0 CHECK(rollback_triggered IN (0,1)),
      rollback_reason               TEXT,
      promoted_at                   TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at                   TEXT,
      machine_id                    TEXT NOT NULL,
      created_at                    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_promotions_pending ON evolution_promotions(pending_evolution_id);
    CREATE INDEX IF NOT EXISTS idx_evolution_promotions_method ON evolution_promotions(promotion_method);
    CREATE INDEX IF NOT EXISTS idx_evolution_promotions_rollback ON evolution_promotions(rollback_triggered) WHERE rollback_triggered = 1;

    CREATE TABLE IF NOT EXISTS pattern_retirement_log (
      id                                  TEXT PRIMARY KEY,
      pattern_table                       TEXT NOT NULL CHECK(pattern_table IN ('fix_patterns','error_patterns','skill_library','design_patterns','governance_rules')),
      pattern_id                          TEXT NOT NULL,
      pattern_fingerprint                 TEXT NOT NULL,
      retirement_reason                   TEXT NOT NULL CHECK(retirement_reason IN ('ZERO_SUCCESS_RATE','STALE_UNUSED','SUPERSEDED','CONTRADICTS_NEWER_PATTERN','MANUAL')),
      times_applied_before_retirement      INTEGER NOT NULL DEFAULT 0,
      times_succeeded_before_retirement    INTEGER NOT NULL DEFAULT 0,
      success_rate_at_retirement           REAL NOT NULL DEFAULT 0,
      last_seen_before_retirement          TEXT,
      superseded_by_pattern_id             TEXT,
      action_taken                        TEXT NOT NULL DEFAULT 'SOFT_RETIRE' CHECK(action_taken IN ('SOFT_RETIRE','HARD_DELETE')),
      retired_at                          TEXT NOT NULL DEFAULT (datetime('now')),
      machine_id                          TEXT NOT NULL,
      created_at                          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pattern_retirement_table_id ON pattern_retirement_log(pattern_table, pattern_id);
    CREATE INDEX IF NOT EXISTS idx_pattern_retirement_reason ON pattern_retirement_log(retirement_reason);
    CREATE INDEX IF NOT EXISTS idx_pattern_retirement_fingerprint ON pattern_retirement_log(pattern_fingerprint);

    CREATE TABLE IF NOT EXISTS test_run_results (
      id                    TEXT PRIMARY KEY,
      build_run_id          TEXT,
      project_name          TEXT NOT NULL,
      trigger               TEXT NOT NULL CHECK(trigger IN ('POST_PROMPT','SCHEDULED','MANUAL','PRE_DEPLOY','CI')),
      test_suite            TEXT NOT NULL CHECK(test_suite IN ('UNIT','INTEGRATION','API','E2E','VISUAL_REGRESSION','PERFORMANCE','LOAD','STRESS','SOAK','SECURITY','ACCESSIBILITY','CHAOS','DISASTER_RECOVERY','BACKUP_RESTORE','DEPENDENCY_SCAN','STATIC_ANALYSIS','DYNAMIC_ANALYSIS','CROSS_BROWSER','CROSS_DEVICE','IAC','SBOM','LICENSE')),
      runner                TEXT NOT NULL DEFAULT 'vitest',
      status                TEXT NOT NULL CHECK(status IN ('running','passed','failed','partial','skipped','error')),
      prompt_index          INTEGER,
      tests_total           INTEGER NOT NULL DEFAULT 0,
      tests_passed          INTEGER NOT NULL DEFAULT 0,
      tests_failed          INTEGER NOT NULL DEFAULT 0,
      tests_skipped         INTEGER NOT NULL DEFAULT 0,
      duration_ms           INTEGER NOT NULL DEFAULT 0,
      failure_summary       TEXT,
      report_path           TEXT,
      exit_code             INTEGER,
      started_at            TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at          TEXT,
      machine_id            TEXT NOT NULL,
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_test_run_results_build ON test_run_results(build_run_id);
    CREATE INDEX IF NOT EXISTS idx_test_run_results_suite ON test_run_results(test_suite, status);
    CREATE INDEX IF NOT EXISTS idx_test_run_results_project ON test_run_results(project_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_test_run_results_status ON test_run_results(status);

    CREATE TABLE IF NOT EXISTS test_coverage_snapshots (
      id                     TEXT PRIMARY KEY,
      build_run_id           TEXT,
      project_name           TEXT NOT NULL,
      test_run_result_id     TEXT NOT NULL,
      coverage_type          TEXT NOT NULL CHECK(coverage_type IN ('LINE','BRANCH','FUNCTION','STATEMENT')),
      coverage_pct           REAL NOT NULL CHECK(coverage_pct >= 0.0 AND coverage_pct <= 100.0),
      lines_total            INTEGER NOT NULL DEFAULT 0,
      lines_covered          INTEGER NOT NULL DEFAULT 0,
      files_below_threshold  TEXT NOT NULL DEFAULT '[]',
      threshold_required     REAL NOT NULL DEFAULT 0.80 CHECK(threshold_required >= 0.0 AND threshold_required <= 1.0),
      threshold_met          INTEGER NOT NULL DEFAULT 0 CHECK(threshold_met IN (0,1)),
      delta_vs_previous      REAL,
      captured_at            TEXT NOT NULL DEFAULT (datetime('now')),
      machine_id             TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_test_coverage_project ON test_coverage_snapshots(project_name, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_test_coverage_run ON test_coverage_snapshots(test_run_result_id);
    CREATE INDEX IF NOT EXISTS idx_test_coverage_type ON test_coverage_snapshots(coverage_type);
`;

/**
 * System 5 (Sentinel Prime) + Orchestrator tables (schema bump 2.3.0 -> 2.5.0).
 */
const SYSTEM_5_ORCHESTRATOR_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS sentinel_prime_runs (
      id                          TEXT PRIMARY KEY,
      build_run_id                TEXT NOT NULL,
      prompt_id                   TEXT NOT NULL,
      prompt_index                INTEGER NOT NULL,
      execution_monitor_result    TEXT NOT NULL,
      decision_validator_result   TEXT NOT NULL,
      governance_enforcer_result  TEXT NOT NULL,
      composite_confidence        REAL NOT NULL,
      halt_triggered              INTEGER NOT NULL DEFAULT 0,
      halt_reason                 TEXT,
      out_of_scope_writes         TEXT,
      contract_violations         TEXT,
      intent_fulfillment_score    REAL,
      gate_pass_score             REAL,
      created_at                  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sentinel_prime_runs_build ON sentinel_prime_runs(build_run_id);
    CREATE INDEX IF NOT EXISTS idx_sentinel_prime_runs_prompt ON sentinel_prime_runs(prompt_id);
    CREATE INDEX IF NOT EXISTS idx_sentinel_prime_runs_halt ON sentinel_prime_runs(halt_triggered);

    CREATE TABLE IF NOT EXISTS validation_events (
      id                TEXT PRIMARY KEY,
      sentinel_run_id   TEXT NOT NULL,
      event_type        TEXT NOT NULL,
      severity          TEXT NOT NULL,
      artifact          TEXT,
      description       TEXT NOT NULL,
      auto_resolved     INTEGER NOT NULL DEFAULT 0,
      resolution        TEXT,
      created_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_validation_events_run ON validation_events(sentinel_run_id);
    CREATE INDEX IF NOT EXISTS idx_validation_events_severity ON validation_events(severity);

    CREATE TABLE IF NOT EXISTS orchestrator_manifests (
      id               TEXT PRIMARY KEY,
      project          TEXT NOT NULL,
      manifest_path    TEXT NOT NULL,
      version          TEXT NOT NULL,
      description      TEXT,
      status           TEXT NOT NULL DEFAULT 'idle',
      queues_total     INTEGER NOT NULL DEFAULT 0,
      queues_complete  INTEGER NOT NULL DEFAULT 0,
      queues_failed    INTEGER NOT NULL DEFAULT 0,
      started_at       TEXT,
      completed_at     TEXT,
      created_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orchestrator_manifests_project ON orchestrator_manifests(project);
    CREATE INDEX IF NOT EXISTS idx_orchestrator_manifests_status ON orchestrator_manifests(status);

    CREATE TABLE IF NOT EXISTS orchestrator_queue_runs (
      id                          TEXT PRIMARY KEY,
      manifest_id                 TEXT NOT NULL,
      queue_id                    TEXT NOT NULL,
      queue_file                  TEXT NOT NULL,
      status                      TEXT NOT NULL DEFAULT 'pending',
      depends_on                  TEXT,
      priority                    INTEGER NOT NULL DEFAULT 1,
      prompt_count                INTEGER,
      started_at                  TEXT,
      completed_at                TEXT,
      sentinel_prime_checkpoint   TEXT,
      error                       TEXT,
      created_at                  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orchestrator_queue_runs_manifest ON orchestrator_queue_runs(manifest_id);
    CREATE INDEX IF NOT EXISTS idx_orchestrator_queue_runs_status ON orchestrator_queue_runs(status);
`;

/**
 * Deep analysis tables (schema bump 2.5.0 -> 2.7.0): dead code findings, orphaned routes,
 * schema drift findings, and dependency audit findings.
 */
const DEEP_ANALYSIS_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS dead_code_findings (
      id             TEXT PRIMARY KEY,
      build_run_id   TEXT NOT NULL,
      project_path   TEXT NOT NULL,
      file_path      TEXT NOT NULL,
      symbol_name    TEXT NOT NULL,
      symbol_type    TEXT NOT NULL,
      reason         TEXT NOT NULL,
      line_number    INTEGER,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dead_code_findings_build ON dead_code_findings(build_run_id);
    CREATE INDEX IF NOT EXISTS idx_dead_code_findings_path ON dead_code_findings(project_path);

    CREATE TABLE IF NOT EXISTS orphaned_routes (
      id             TEXT PRIMARY KEY,
      build_run_id   TEXT NOT NULL,
      project_path   TEXT NOT NULL,
      route_path     TEXT NOT NULL,
      http_methods   TEXT NOT NULL,
      reason         TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orphaned_routes_build ON orphaned_routes(build_run_id);
    CREATE INDEX IF NOT EXISTS idx_orphaned_routes_path ON orphaned_routes(project_path);

    CREATE TABLE IF NOT EXISTS schema_drift_findings (
      id             TEXT PRIMARY KEY,
      build_run_id   TEXT NOT NULL,
      project_path   TEXT NOT NULL,
      finding_type   TEXT NOT NULL,
      table_name     TEXT NOT NULL,
      detail         TEXT NOT NULL,
      severity       TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_schema_drift_findings_build ON schema_drift_findings(build_run_id);
    CREATE INDEX IF NOT EXISTS idx_schema_drift_findings_severity ON schema_drift_findings(severity);

    CREATE TABLE IF NOT EXISTS dependency_audit_findings (
      id             TEXT PRIMARY KEY,
      build_run_id   TEXT NOT NULL,
      project_path   TEXT NOT NULL,
      package_name   TEXT NOT NULL,
      finding_type   TEXT NOT NULL,
      detail         TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dependency_audit_findings_build ON dependency_audit_findings(build_run_id);
    CREATE INDEX IF NOT EXISTS idx_dependency_audit_findings_package ON dependency_audit_findings(package_name);
`;

/**
 * Autonomy tables (schema bump 2.8.0 -> 2.9.0): per-project local credential storage, a log of
 * autonomous actions taken during a build, and deployment history.
 */
const AUTONOMY_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS project_credentials (
      id                TEXT PRIMARY KEY,
      project_path      TEXT NOT NULL,
      credential_key    TEXT NOT NULL,
      credential_value  TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      UNIQUE(project_path, credential_key)
    );
    CREATE INDEX IF NOT EXISTS idx_project_credentials_path ON project_credentials(project_path);

    CREATE TABLE IF NOT EXISTS autonomy_actions (
      id             TEXT PRIMARY KEY,
      build_run_id   TEXT NOT NULL,
      action_type    TEXT NOT NULL,
      target         TEXT NOT NULL,
      status         TEXT NOT NULL,
      result         TEXT,
      error          TEXT,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_autonomy_actions_build ON autonomy_actions(build_run_id);
    CREATE INDEX IF NOT EXISTS idx_autonomy_actions_status ON autonomy_actions(status);

    CREATE TABLE IF NOT EXISTS deployment_history (
      id              TEXT PRIMARY KEY,
      build_run_id    TEXT NOT NULL,
      project_path    TEXT NOT NULL,
      platform        TEXT NOT NULL,
      deployment_id   TEXT,
      deployment_url  TEXT,
      status          TEXT NOT NULL,
      deployed_at     TEXT,
      verified_at     TEXT,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deployment_history_build ON deployment_history(build_run_id);
    CREATE INDEX IF NOT EXISTS idx_deployment_history_project ON deployment_history(project_path);
`;

/**
 * Design artifacts table (schema bump 2.9.0 -> 3.0.0): generated UI component code emitted by
 * the design-intelligence pipeline, kept alongside its prompt/build provenance for reuse.
 */
const DESIGN_ARTIFACTS_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS design_artifacts (
      id               TEXT PRIMARY KEY,
      build_run_id     TEXT NOT NULL,
      prompt_id        TEXT NOT NULL,
      component_name   TEXT NOT NULL,
      description      TEXT NOT NULL,
      generated_code   TEXT NOT NULL,
      framework        TEXT NOT NULL DEFAULT 'react',
      styling          TEXT NOT NULL DEFAULT 'tailwind',
      file_path        TEXT,
      applied          INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_design_artifacts_build ON design_artifacts(build_run_id);
    CREATE INDEX IF NOT EXISTS idx_design_artifacts_prompt ON design_artifacts(prompt_id);
`;

/**
 * Design review + screenshot pipeline tables (schema bump 3.0.0 -> 3.1.0). Note: the task
 * brief for this addition named schema version 2.9.0 — that value was already consumed by the
 * Autonomy tables bump (2.8.0 -> 2.9.0) that landed before Design Artifacts (2.9.0 -> 3.0.0), so
 * assigning 2.9.0 here would be a downgrade that collides with and contradicts existing migration
 * history. 3.1.0 is the actual next version in sequence and is what CURRENT_SCHEMA_VERSION and
 * this comment record, per the same "record the real next version, not a stale brief number"
 * precedent already established throughout this file's history (see the Enhanced Retrofit /
 * UI Engine sessions in STATE_OF_THE_BUILD.md).
 */
const DESIGN_REVIEWS_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS design_reviews (
      id                TEXT PRIMARY KEY,
      build_run_id      TEXT NOT NULL,
      prompt_id         TEXT NOT NULL,
      component_name    TEXT NOT NULL,
      screenshot_path   TEXT,
      penpot_file_id    TEXT,
      human_approved    INTEGER DEFAULT 0,
      human_feedback    TEXT,
      auto_approved     INTEGER DEFAULT 0,
      created_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_design_reviews_build ON design_reviews(build_run_id);
    CREATE INDEX IF NOT EXISTS idx_design_reviews_prompt ON design_reviews(prompt_id);

    CREATE TABLE IF NOT EXISTS design_screenshots (
      id             TEXT PRIMARY KEY,
      build_run_id   TEXT NOT NULL,
      prompt_id      TEXT NOT NULL,
      file_path      TEXT NOT NULL,
      url            TEXT,
      viewport       TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_design_screenshots_build ON design_screenshots(build_run_id);
    CREATE INDEX IF NOT EXISTS idx_design_screenshots_prompt ON design_screenshots(prompt_id);
`;

/**
 * Governance provenance ledgers (schema bump 3.1.0 -> 3.2.0): the ADR provenance log, assumption
 * registry, risk register, and tech-debt ledger. Same posture as the sibling `src/governance/`
 * modules (traceability, invariants, blast-radius, build-state-machine) — real, persisted rows
 * written by CLI/phase callers, never fabricated. `tech_debt_items.source`/`source_finding_id`
 * let entries be seeded from findings FORGE already records (`dead_code_findings`,
 * `schema_drift_findings`, `dependency_audit_findings`, `adversary_findings`) with a dedup key,
 * as well as accept manual entries.
 */
const GOVERNANCE_LEDGERS_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS adr_records (
      id                       TEXT PRIMARY KEY,
      project_name             TEXT NOT NULL,
      project_path             TEXT NOT NULL,
      adr_number                INTEGER NOT NULL,
      title                    TEXT NOT NULL,
      status                   TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','accepted','rejected','deprecated','superseded')),
      context                  TEXT NOT NULL,
      decision                 TEXT NOT NULL,
      consequences              TEXT,
      alternatives_considered    TEXT NOT NULL DEFAULT '[]',
      decided_by                TEXT NOT NULL,
      source                   TEXT,
      related_files              TEXT NOT NULL DEFAULT '[]',
      supersedes                TEXT,
      superseded_by              TEXT,
      build_run_id               TEXT,
      created_at                TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_adr_records_project_number ON adr_records(project_name, adr_number);
    CREATE INDEX IF NOT EXISTS idx_adr_records_status ON adr_records(project_name, status);

    CREATE TABLE IF NOT EXISTS assumptions (
      id                      TEXT PRIMARY KEY,
      project_name            TEXT NOT NULL,
      project_path            TEXT NOT NULL,
      statement                TEXT NOT NULL,
      category                 TEXT NOT NULL CHECK(category IN ('technical','business','user','infra','data','security')),
      status                   TEXT NOT NULL DEFAULT 'unvalidated' CHECK(status IN ('unvalidated','validated','invalidated','stale')),
      confidence                REAL CHECK(confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
      impact_if_wrong            TEXT NOT NULL,
      owner                    TEXT,
      related_adr_id             TEXT,
      validation_method          TEXT,
      validation_evidence        TEXT,
      validated_at               TEXT,
      build_run_id               TEXT,
      created_at                TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_assumptions_project ON assumptions(project_name, status);
    CREATE INDEX IF NOT EXISTS idx_assumptions_adr ON assumptions(related_adr_id);

    CREATE TABLE IF NOT EXISTS risks (
      id                       TEXT PRIMARY KEY,
      project_name             TEXT NOT NULL,
      project_path             TEXT NOT NULL,
      title                    TEXT NOT NULL,
      description               TEXT NOT NULL,
      category                  TEXT NOT NULL CHECK(category IN ('technical','schedule','security','operational','compliance','financial','vendor')),
      probability                INTEGER NOT NULL CHECK(probability BETWEEN 1 AND 5),
      impact                    INTEGER NOT NULL CHECK(impact BETWEEN 1 AND 5),
      severity_score              INTEGER NOT NULL,
      status                    TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','mitigating','accepted','closed','realized')),
      mitigation_plan             TEXT,
      owner                     TEXT,
      related_adr_id              TEXT,
      related_assumption_id        TEXT,
      build_run_id                TEXT,
      closed_at                  TEXT,
      created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_risks_project ON risks(project_name, status);
    CREATE INDEX IF NOT EXISTS idx_risks_severity ON risks(severity_score DESC);

    CREATE TABLE IF NOT EXISTS tech_debt_items (
      id                       TEXT PRIMARY KEY,
      project_name             TEXT NOT NULL,
      project_path             TEXT NOT NULL,
      title                    TEXT NOT NULL,
      description               TEXT NOT NULL,
      category                  TEXT NOT NULL CHECK(category IN ('code_quality','architecture','test_coverage','security','performance','documentation','dependency','dead_code','schema_drift')),
      severity                  TEXT NOT NULL CHECK(severity IN ('low','medium','high','critical')),
      effort_estimate             TEXT NOT NULL DEFAULT 'unknown' CHECK(effort_estimate IN ('trivial','small','medium','large','unknown')),
      status                    TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','wont_fix')),
      file_path                  TEXT,
      source                    TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','dead_code_findings','schema_drift_findings','dependency_audit_findings','adversary_findings')),
      source_finding_id            TEXT,
      introduced_build_id          TEXT,
      resolved_build_id           TEXT,
      resolved_at                TEXT,
      created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tech_debt_dedup ON tech_debt_items(project_name, source, source_finding_id) WHERE source_finding_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tech_debt_project ON tech_debt_items(project_name, status);
    CREATE INDEX IF NOT EXISTS idx_tech_debt_severity ON tech_debt_items(severity);
`;

/**
 * Design Intelligence tables (schema bump 3.2.0 -> 3.3.0): App Profiler, Design Router, Design
 * Tournament, and Design Memory — the four `upgrades/DESIGN_INTELLIGENCE.md` components this
 * session builds on top of the existing capture/audit/approve pipeline
 * (`design_reviews`/`design_screenshots`, schema 3.1.0). Same posture as every other
 * `src/design-pipeline/` table: real rows written by real callers (`app-profiler.ts`/
 * `design-router.ts`/`design-tournament.ts`/`design-memory.ts`), never fabricated.
 *
 * `app_design_profiles` — one row per project (upserted), the {@link AppDesignProfile} App
 * Profiler derives from a project's queue-entry corpus + `package.json`.
 * `design_router_decisions` — one row per routing decision, carrying every tool's computed
 * weighted score for explainability, plus an `outcome` column the design-pipeline review result
 * updates after the fact so `historical_success` has real data to read on the next decision.
 * `design_preferences` — Design Memory's cross-project prefer/reject tag ledger, upserted by
 * `(tag, polarity)` so repeated signals accumulate weight instead of duplicating rows.
 * `design_tournament_runs`/`design_tournament_variants` — one run + N variant rows per Design
 * Tournament invocation, carrying each variant's structural direction parameters and whatever
 * automated-evaluator scores were actually computed (never a fabricated number for a dimension
 * with no evaluator — see `design-tournament.ts`'s `dimensions_scored` column).
 */
const DESIGN_INTELLIGENCE_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS app_design_profiles (
      id                         TEXT PRIMARY KEY,
      project_name               TEXT NOT NULL,
      application_type_primary   TEXT NOT NULL,
      application_type_secondary TEXT NOT NULL DEFAULT '[]',
      interface_types            TEXT NOT NULL DEFAULT '[]',
      brand_tone                 TEXT NOT NULL DEFAULT '[]',
      brand_avoid                TEXT NOT NULL DEFAULT '[]',
      visual_complexity          TEXT NOT NULL CHECK(visual_complexity IN ('low','medium','high')),
      motion_requirement         TEXT NOT NULL CHECK(motion_requirement IN ('none','minimal','moderate','high')),
      three_d_requirement        TEXT NOT NULL CHECK(three_d_requirement IN ('none','low','medium','high')),
      data_density                TEXT NOT NULL DEFAULT '{}',
      target_users                TEXT NOT NULL DEFAULT '[]',
      source_summary              TEXT NOT NULL DEFAULT '',
      created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_app_design_profiles_project ON app_design_profiles(project_name);

    CREATE TABLE IF NOT EXISTS design_router_decisions (
      id                TEXT PRIMARY KEY,
      project_name      TEXT NOT NULL,
      build_run_id      TEXT,
      prompt_id         TEXT,
      interface_type    TEXT NOT NULL,
      tool_scores       TEXT NOT NULL DEFAULT '{}',
      primary_tool      TEXT NOT NULL,
      secondary_tool    TEXT,
      validation_tool   TEXT NOT NULL DEFAULT 'playwright',
      not_selected      TEXT NOT NULL DEFAULT '[]',
      reasons           TEXT NOT NULL DEFAULT '[]',
      confidence        REAL NOT NULL DEFAULT 0,
      outcome           TEXT CHECK(outcome IN ('approved','rejected') OR outcome IS NULL),
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_design_router_decisions_project ON design_router_decisions(project_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_design_router_decisions_tool ON design_router_decisions(primary_tool, outcome);

    CREATE TABLE IF NOT EXISTS design_preferences (
      id             TEXT PRIMARY KEY,
      tag            TEXT NOT NULL,
      polarity       TEXT NOT NULL CHECK(polarity IN ('prefer','reject')),
      weight         REAL NOT NULL DEFAULT 1,
      occurrences    INTEGER NOT NULL DEFAULT 1,
      last_project   TEXT,
      last_source    TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_design_preferences_tag_polarity ON design_preferences(tag, polarity);
    CREATE INDEX IF NOT EXISTS idx_design_preferences_weight ON design_preferences(polarity, weight DESC);

    CREATE TABLE IF NOT EXISTS design_tournament_runs (
      id                 TEXT PRIMARY KEY,
      project_name       TEXT NOT NULL,
      build_run_id       TEXT,
      prompt_id          TEXT,
      component_name     TEXT NOT NULL,
      variant_count      INTEGER NOT NULL,
      status             TEXT NOT NULL DEFAULT 'awaiting_approval' CHECK(status IN ('awaiting_approval','approved','rejected')),
      winning_variant_id TEXT,
      recommendation     TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_design_tournament_runs_project ON design_tournament_runs(project_name, created_at DESC);

    CREATE TABLE IF NOT EXISTS design_tournament_variants (
      id                 TEXT PRIMARY KEY,
      run_id             TEXT NOT NULL REFERENCES design_tournament_runs(id),
      direction_id       TEXT NOT NULL,
      direction_name     TEXT NOT NULL,
      design_variance    REAL NOT NULL,
      motion_intensity   REAL NOT NULL,
      density            TEXT NOT NULL,
      structural_tags    TEXT NOT NULL DEFAULT '[]',
      file_path          TEXT,
      screenshot_paths   TEXT NOT NULL DEFAULT '[]',
      scores             TEXT NOT NULL DEFAULT '{}',
      total_score        REAL,
      dimensions_scored  INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_design_tournament_variants_run ON design_tournament_variants(run_id);
`;

/** Every Build Memory + learning-engine table name, for `forge health` row-count reporting. */
export const ALL_FORGE_TABLES: readonly string[] = [
  // Build Memory (src/memory/ CRUD layer)
  'build_runs',
  'prompt_executions',
  'error_patterns',
  'resolutions',
  'governance_versions',
  'self_created_agents',
  'cross_project_insights',
  'production_telemetry',
  'stack_profiles',
  'design_patterns',
  'brand_identities',
  'scheduled_tasks',
  // Prompt-library versioning (Session 3 — Autonomy)
  'queue_versions',
  // Systems 1-3 (schema 2.3.0) — SCHEMA_ADDITIONS.md §1-§6
  'gap_audit_runs',
  'artifact_health_scores',
  'evolution_promotions',
  'pattern_retirement_log',
  'test_run_results',
  'test_coverage_snapshots',
  // System 5 (Sentinel Prime) + Orchestrator (schema 2.5.0)
  'sentinel_prime_runs',
  'validation_events',
  'orchestrator_manifests',
  'orchestrator_queue_runs',
  // Deep analysis tables (schema 2.7.0)
  'dead_code_findings',
  'orphaned_routes',
  'schema_drift_findings',
  'dependency_audit_findings',
  // Autonomy tables (schema 2.9.0)
  'project_credentials',
  'autonomy_actions',
  'deployment_history',
  // Design artifacts (schema 3.0.0)
  'design_artifacts',
  // Design review + screenshot pipeline (schema 3.1.0)
  'design_reviews',
  'design_screenshots',
  // Governance provenance ledgers (schema 3.2.0)
  'adr_records',
  'assumptions',
  'risks',
  'tech_debt_items',
  // Design Intelligence: App Profiler, Design Router, Design Tournament, Design Memory (schema 3.3.0)
  'app_design_profiles',
  'design_router_decisions',
  'design_preferences',
  'design_tournament_runs',
  'design_tournament_variants',
  // Learning engine (pre-existing, untouched)
  'prompt_scores',
  'fix_patterns',
  'decision_weights',
  'governance_rules',
  'pending_evolutions',
  'build_outcomes',
  'skill_library',
  'reconcile_decisions',
  'scan_reports',
  'hook_execution_log',
  'compact_snapshots',
  'build_fingerprints',
  'adversary_findings',
];

export function initializeForgeMemory(dbPath?: string): void {
  const db = getConnection(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS forge_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO forge_meta (key, value) VALUES ('schema_version', '1.0.0');
    INSERT OR IGNORE INTO forge_meta (key, value) VALUES ('created_at', datetime('now'));

    CREATE TABLE IF NOT EXISTS prompt_scores (
      id                   TEXT PRIMARY KEY,
      prompt_template_hash TEXT NOT NULL,
      task_type            TEXT NOT NULL CHECK(task_type IN ('SCAFFOLD','CRUD','INTEGRATION','AI_PIPELINE','CONFIG','TEST','FIX')),
      tech_stack_tags      TEXT NOT NULL DEFAULT '[]',
      first_pass_success   INTEGER NOT NULL CHECK(first_pass_success IN (0, 1)),
      retry_count          INTEGER NOT NULL DEFAULT 0,
      tokens_consumed      INTEGER NOT NULL DEFAULT 0,
      gate_pass_rate       REAL NOT NULL DEFAULT 0.0 CHECK(gate_pass_rate >= 0.0 AND gate_pass_rate <= 1.0),
      drift_score          REAL NOT NULL DEFAULT 0.0 CHECK(drift_score >= 0.0 AND drift_score <= 1.0),
      project_name         TEXT NOT NULL,
      build_id             TEXT NOT NULL,
      machine_id           TEXT NOT NULL,
      created_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_scores_task_type ON prompt_scores(task_type);
    CREATE INDEX IF NOT EXISTS idx_prompt_scores_template_hash ON prompt_scores(prompt_template_hash);
    CREATE INDEX IF NOT EXISTS idx_prompt_scores_project ON prompt_scores(project_name);
    CREATE INDEX IF NOT EXISTS idx_prompt_scores_created ON prompt_scores(created_at);

    CREATE TABLE IF NOT EXISTS fix_patterns (
      id                    TEXT PRIMARY KEY,
      error_fingerprint     TEXT NOT NULL,
      error_message         TEXT NOT NULL,
      error_category        TEXT NOT NULL CHECK(error_category IN ('COMPILE','RUNTIME','TEST','LINT','SECURITY','SCHEMA','DEPLOY')),
      file_path_pattern     TEXT NOT NULL,
      fix_diff              TEXT,
      fix_description       TEXT,
      fix_files_modified    TEXT DEFAULT '[]',
      tech_stack_tags       TEXT NOT NULL DEFAULT '[]',
      occurrence_count      INTEGER NOT NULL DEFAULT 1,
      success_rate          REAL NOT NULL DEFAULT 0.0,
      times_fix_applied     INTEGER NOT NULL DEFAULT 0,
      times_fix_succeeded   INTEGER NOT NULL DEFAULT 0,
      auto_governance_rule  TEXT,
      governance_rule_id    TEXT,
      last_seen             TEXT NOT NULL DEFAULT (datetime('now')),
      machine_id            TEXT NOT NULL,
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fix_patterns_fingerprint ON fix_patterns(error_fingerprint);
    CREATE INDEX IF NOT EXISTS idx_fix_patterns_category ON fix_patterns(error_category);
    CREATE INDEX IF NOT EXISTS idx_fix_patterns_stack ON fix_patterns(tech_stack_tags);
    CREATE INDEX IF NOT EXISTS idx_fix_patterns_count ON fix_patterns(occurrence_count DESC);

    CREATE TABLE IF NOT EXISTS decision_weights (
      id                    TEXT PRIMARY KEY,
      decision_type         TEXT NOT NULL,
      option_chosen         TEXT NOT NULL,
      downstream_error_rate REAL NOT NULL DEFAULT 0.0,
      downstream_retry_rate REAL NOT NULL DEFAULT 0.0,
      downstream_prompts    INTEGER NOT NULL DEFAULT 0,
      downstream_errors     INTEGER NOT NULL DEFAULT 0,
      downstream_retries    INTEGER NOT NULL DEFAULT 0,
      sample_size           INTEGER NOT NULL DEFAULT 1,
      project_name          TEXT NOT NULL,
      build_id              TEXT NOT NULL,
      machine_id            TEXT NOT NULL,
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decision_weights_type ON decision_weights(decision_type, option_chosen);
    CREATE INDEX IF NOT EXISTS idx_decision_weights_error_rate ON decision_weights(downstream_error_rate ASC);

    CREATE TABLE IF NOT EXISTS governance_rules (
      id                       TEXT PRIMARY KEY,
      rule_text                TEXT NOT NULL,
      rule_short_name          TEXT NOT NULL,
      source                   TEXT NOT NULL CHECK(source IN ('MANUAL','AUTO_ELEVATED','INSTINCT','RETROFIT')),
      source_error_fingerprint TEXT,
      tech_stack_tags          TEXT NOT NULL DEFAULT '[]',
      scope                    TEXT NOT NULL CHECK(scope IN ('GLOBAL','PROJECT_SPECIFIC')),
      project_name             TEXT,
      active                   INTEGER NOT NULL DEFAULT 1,
      enforcement_count        INTEGER NOT NULL DEFAULT 0,
      last_enforced            TEXT,
      machine_id               TEXT NOT NULL,
      created_at               TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_governance_rules_active ON governance_rules(active, scope);
    CREATE INDEX IF NOT EXISTS idx_governance_rules_stack ON governance_rules(tech_stack_tags);

    CREATE TABLE IF NOT EXISTS pending_evolutions (
      id                TEXT PRIMARY KEY,
      evolution_type    TEXT NOT NULL CHECK(evolution_type IN ('HOOK','TEMPLATE','RULE','THRESHOLD','CONFIG','GATE')),
      proposed_change   TEXT NOT NULL,
      change_detail     TEXT NOT NULL,
      evidence          TEXT NOT NULL,
      estimated_impact  TEXT NOT NULL,
      confidence        REAL NOT NULL CHECK(confidence >= 0.0 AND confidence <= 1.0),
      status            TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED')),
      reviewed_at       TEXT,
      review_note       TEXT,
      machine_id        TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pending_evolutions_status ON pending_evolutions(status);

    CREATE TABLE IF NOT EXISTS build_outcomes (
      id                     TEXT PRIMARY KEY,
      project_name           TEXT NOT NULL,
      mode                   TEXT NOT NULL CHECK(mode IN ('GREENFIELD','RETROFIT')),
      start_time             TEXT NOT NULL,
      end_time               TEXT,
      end_reason             TEXT CHECK(end_reason IN ('COMPLETED','PAUSED','FAILED','INTERRUPTED') OR end_reason IS NULL),
      total_prompts_planned  INTEGER NOT NULL DEFAULT 0,
      total_prompts_executed INTEGER NOT NULL DEFAULT 0,
      prompts_passed         INTEGER NOT NULL DEFAULT 0,
      prompts_retried        INTEGER NOT NULL DEFAULT 0,
      prompts_failed         INTEGER NOT NULL DEFAULT 0,
      total_tokens           INTEGER NOT NULL DEFAULT 0,
      architecture_decisions TEXT DEFAULT '[]',
      maturity_stage         TEXT CHECK(maturity_stage IN ('FOUNDATION','GROWTH','ENTERPRISE') OR maturity_stage IS NULL),
      first_pass_rate        REAL,
      machine_id             TEXT NOT NULL,
      created_at             TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_build_outcomes_project ON build_outcomes(project_name);
    CREATE INDEX IF NOT EXISTS idx_build_outcomes_created ON build_outcomes(created_at DESC);

    CREATE TABLE IF NOT EXISTS skill_library (
      id                       TEXT PRIMARY KEY,
      skill_name               TEXT NOT NULL,
      content                  TEXT NOT NULL,
      tech_stack_tags          TEXT NOT NULL DEFAULT '[]',
      source_error_fingerprint TEXT,
      source_build_id          TEXT,
      trigger_context          TEXT,
      usage_count              INTEGER NOT NULL DEFAULT 0,
      effectiveness_rate       REAL NOT NULL DEFAULT 0.0,
      times_injected           INTEGER NOT NULL DEFAULT 0,
      times_prevented_error    INTEGER NOT NULL DEFAULT 0,
      machine_id               TEXT NOT NULL,
      created_at               TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_skill_library_stack ON skill_library(tech_stack_tags);
    CREATE INDEX IF NOT EXISTS idx_skill_library_fingerprint ON skill_library(source_error_fingerprint);

    CREATE TABLE IF NOT EXISTS reconcile_decisions (
      id            TEXT PRIMARY KEY,
      project_name  TEXT NOT NULL,
      feature_id    TEXT NOT NULL,
      feature_name  TEXT NOT NULL,
      decision      TEXT NOT NULL CHECK(decision IN ('BUILD','DEFER','ABANDON','APPROVED','SKIPPED','FIX','IGNORE','INJECT','SKIP')),
      category      TEXT NOT NULL,
      severity      TEXT,
      rationale     TEXT,
      machine_id    TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reconcile_project ON reconcile_decisions(project_name, created_at DESC);

    CREATE TABLE IF NOT EXISTS scan_reports (
      id              TEXT PRIMARY KEY,
      project_name    TEXT NOT NULL,
      scan_scope      TEXT NOT NULL CHECK(scan_scope IN ('A','B','C')),
      critical_count  INTEGER NOT NULL DEFAULT 0,
      warn_count      INTEGER NOT NULL DEFAULT 0,
      info_count      INTEGER NOT NULL DEFAULT 0,
      broken_imports  INTEGER NOT NULL DEFAULT 0,
      dead_files      INTEGER NOT NULL DEFAULT 0,
      schema_drift    INTEGER NOT NULL DEFAULT 0,
      tsc_errors      INTEGER NOT NULL DEFAULT 0,
      test_pass_rate  REAL,
      report_json     TEXT NOT NULL,
      machine_id      TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_scan_reports_project ON scan_reports(project_name, created_at DESC);

    CREATE TABLE IF NOT EXISTS hook_execution_log (
      id              TEXT PRIMARY KEY,
      hook_name       TEXT NOT NULL,
      event           TEXT NOT NULL,
      status          TEXT NOT NULL CHECK(status IN ('PASS','FAIL','TIMEOUT','SKIP')),
      duration_ms     INTEGER NOT NULL,
      output          TEXT,
      build_id        TEXT NOT NULL,
      prompt_number   INTEGER,
      machine_id      TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hook_log_build ON hook_execution_log(build_id);
    CREATE INDEX IF NOT EXISTS idx_hook_log_name ON hook_execution_log(hook_name, status);
    CREATE INDEX IF NOT EXISTS idx_hook_log_duration ON hook_execution_log(duration_ms DESC);

    CREATE TABLE IF NOT EXISTS compact_snapshots (
      id              TEXT PRIMARY KEY,
      build_id        TEXT NOT NULL,
      prompt_index    INTEGER NOT NULL,
      state_json      TEXT NOT NULL,
      machine_id      TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_compact_build ON compact_snapshots(build_id, prompt_index DESC);

    CREATE TABLE IF NOT EXISTS build_fingerprints (
      id              TEXT PRIMARY KEY,
      build_id        TEXT NOT NULL,
      prompt_number   INTEGER NOT NULL,
      fingerprint     TEXT NOT NULL,
      file_count      INTEGER NOT NULL,
      total_size_kb   INTEGER NOT NULL,
      machine_id      TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fingerprints_build ON build_fingerprints(build_id, prompt_number);

    CREATE TABLE IF NOT EXISTS adversary_findings (
      id          TEXT PRIMARY KEY,
      build_id    TEXT NOT NULL,
      phase       TEXT NOT NULL,
      severity    TEXT NOT NULL CHECK(severity IN ('BLOCKER','SIGNIFICANT','MINOR','DISMISSED')),
      vector      TEXT,
      issue       TEXT NOT NULL,
      fix         TEXT,
      resolution  TEXT DEFAULT 'PENDING' CHECK(resolution IN ('PENDING','FIXED','DISMISSED','DEFERRED')),
      resolved_at TEXT,
      machine_id  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_adversary_build ON adversary_findings(build_id);
    CREATE INDEX IF NOT EXISTS idx_adversary_severity ON adversary_findings(severity);
  `);

  // Schema migration guard: every step's CREATE TABLE/INDEX is idempotent (IF NOT EXISTS), so
  // they always run in full — this heals a partially-initialized db from an interrupted prior
  // run — and `schema_version` is simply advanced to the current target once at the end.
  // Existing data (build_outcomes, hook_execution_log, brand_identities, …) is never touched.
  const versionRow = db
    .prepare("SELECT value FROM forge_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  const currentVersion = versionRow?.value ?? '1.0.0';
  const targetVersion = CURRENT_SCHEMA_VERSION;

  // 1.0.0 -> 2.0.0 (Session 1 — Memory Consolidation): the src/memory/ CRUD layer's tables.
  db.exec(BUILD_MEMORY_SCHEMA_SQL);
  // 2.0.0 -> 2.1.0 (Session 3 — Autonomy): prompt-library versioning.
  db.exec(QUEUE_VERSIONING_SCHEMA_SQL);
  // 2.1.0 -> 2.2.0 (Session 5 — Field Hardening): per-prompt duration tracking for the cost
  // estimator. ALTER TABLE ADD COLUMN (unlike a CHECK-constraint change) is safe to run against a
  // live db with data; guarded because SQLite errors if the column already exists.
  try {
    db.exec('ALTER TABLE prompt_executions ADD COLUMN duration_ms INTEGER');
  } catch {
    /* column already present — idempotent across repeated init calls */
  }
  // 2.2.0 -> 2.2.1 (Session 5.1 hotfix): persist the queue.yaml short hash on build_runs at
  // Phase 3 start, so a resumed build can confirm it belongs to the SAME queue rather than
  // trusting stale Build Memory / state-file markers against a wiped-and-regenerated project
  // (`src/engine/auto-resume.ts` › computeResumeStartAt).
  try {
    db.exec('ALTER TABLE build_runs ADD COLUMN queue_hash TEXT');
  } catch {
    /* column already present — idempotent across repeated init calls */
  }
  // 2.2.1 -> 2.3.0 (Systems 1-3): gap_audit_runs, artifact_health_scores,
  // evolution_promotions, pattern_retirement_log, test_run_results,
  // test_coverage_snapshots — SCHEMA_ADDITIONS.md §1-§6, verbatim.
  //
  // Column-set correction: two earlier drafts of gap_audit_runs/artifact_health_scores
  // (before SCHEMA_ADDITIONS.md finalized them) shipped different column names
  // (audit_scope instead of scope, audit_run_id instead of gap_audit_run_id, no
  // project_name, ...). Both tables are runtime-only — rows are written by GapAuditor,
  // which hasn't shipped yet — so a drop-and-recreate against a draft schema is safe
  // (no data-loss risk).
  const gapAuditCols = db.pragma('table_info(gap_audit_runs)') as Array<{ name: string }>;
  if (gapAuditCols.length > 0 && !gapAuditCols.some((c) => c.name === 'project_name')) {
    db.exec('DROP TABLE IF EXISTS artifact_health_scores');
    db.exec('DROP TABLE IF EXISTS gap_audit_runs');
  }
  // 3.3.0 -> 3.4.0 (IaC/SBOM/License runners): test_run_results.test_suite's CHECK constraint
  // gains 'IAC','SBOM','LICENSE'. Unlike the ALTER TABLE ADD COLUMN cases above (safe against a
  // live db with data), SQLite has no ALTER TABLE ... MODIFY CHECK — a CHECK constraint can only
  // be changed by rebuilding the table. test_run_results is NOT a draft/runtime-only table like
  // gap_audit_runs above (it has held real data since schema 2.3.0), so a drop-and-recreate would
  // be a data-loss bug — instead: detect the old-shape table by checking sqlite_master.sql for the
  // new 'IAC' literal; if absent, create a same-column table under the new CHECK, copy every row
  // across unchanged (every existing test_suite value is a strict subset of the new 22-value set,
  // so every row already satisfies the new CHECK), drop the old table, and rename. No data is
  // lost. A freshly-created db never enters this branch — SYSTEMS_1_3_SCHEMA_SQL's own
  // `CREATE TABLE IF NOT EXISTS` immediately below already carries the updated CHECK.
  const testRunResultsRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'test_run_results'")
    .get() as { sql: string } | undefined;
  if (testRunResultsRow && !testRunResultsRow.sql.includes("'IAC'")) {
    db.exec(`
      CREATE TABLE test_run_results__migrating_3_4_0 (
        id                    TEXT PRIMARY KEY,
        build_run_id          TEXT,
        project_name          TEXT NOT NULL,
        trigger               TEXT NOT NULL CHECK(trigger IN ('POST_PROMPT','SCHEDULED','MANUAL','PRE_DEPLOY','CI')),
        test_suite            TEXT NOT NULL CHECK(test_suite IN ('UNIT','INTEGRATION','API','E2E','VISUAL_REGRESSION','PERFORMANCE','LOAD','STRESS','SOAK','SECURITY','ACCESSIBILITY','CHAOS','DISASTER_RECOVERY','BACKUP_RESTORE','DEPENDENCY_SCAN','STATIC_ANALYSIS','DYNAMIC_ANALYSIS','CROSS_BROWSER','CROSS_DEVICE','IAC','SBOM','LICENSE')),
        runner                TEXT NOT NULL DEFAULT 'vitest',
        status                TEXT NOT NULL CHECK(status IN ('running','passed','failed','partial','skipped','error')),
        prompt_index          INTEGER,
        tests_total           INTEGER NOT NULL DEFAULT 0,
        tests_passed          INTEGER NOT NULL DEFAULT 0,
        tests_failed          INTEGER NOT NULL DEFAULT 0,
        tests_skipped         INTEGER NOT NULL DEFAULT 0,
        duration_ms           INTEGER NOT NULL DEFAULT 0,
        failure_summary       TEXT,
        report_path           TEXT,
        exit_code             INTEGER,
        started_at            TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at          TEXT,
        machine_id            TEXT NOT NULL,
        created_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO test_run_results__migrating_3_4_0 SELECT * FROM test_run_results;
      DROP TABLE test_run_results;
      ALTER TABLE test_run_results__migrating_3_4_0 RENAME TO test_run_results;
    `);
  }
  db.exec(SYSTEMS_1_3_SCHEMA_SQL);
  // 2.3.0 -> 2.5.0 (System 5 — Sentinel Prime — and the Orchestrator): sentinel_prime_runs,
  // validation_events, orchestrator_manifests, orchestrator_queue_runs.
  db.exec(SYSTEM_5_ORCHESTRATOR_SCHEMA_SQL);
  // 2.5.0 -> 2.7.0 (Deep Analysis): dead_code_findings, orphaned_routes,
  // schema_drift_findings, dependency_audit_findings.
  db.exec(DEEP_ANALYSIS_SCHEMA_SQL);
  // 2.7.0 -> 2.8.0 (Bundle Size Gate): per-page Next.js bundle-size baseline, stored as a JSON
  // map (route -> bytes) on the latest build_runs row for a project_path. ALTER TABLE ADD COLUMN
  // is safe against a live db with data; guarded because SQLite errors if the column already
  // exists.
  try {
    db.exec('ALTER TABLE build_runs ADD COLUMN bundle_sizes TEXT');
  } catch {
    /* column already present — idempotent across repeated init calls */
  }
  // 2.8.0 -> 2.9.0 (Autonomy): project_credentials, autonomy_actions, deployment_history.
  db.exec(AUTONOMY_SCHEMA_SQL);
  // 2.9.0 -> 3.0.0 (Design Artifacts): generated UI component code + provenance.
  db.exec(DESIGN_ARTIFACTS_SCHEMA_SQL);
  // 3.0.0 -> 3.1.0 (Design Review Pipeline): design_reviews, design_screenshots.
  db.exec(DESIGN_REVIEWS_SCHEMA_SQL);
  // 3.1.0 -> 3.2.0 (Governance Provenance Ledgers): adr_records, assumptions, risks,
  // tech_debt_items.
  db.exec(GOVERNANCE_LEDGERS_SCHEMA_SQL);
  // 3.2.0 -> 3.3.0 (Design Intelligence): app_design_profiles, design_router_decisions,
  // design_preferences, design_tournament_runs, design_tournament_variants.
  db.exec(DESIGN_INTELLIGENCE_SCHEMA_SQL);
  // 3.3.0 -> 3.4.0 (IaC/SBOM/License runners): test_run_results.test_suite CHECK gains
  // 'IAC','SBOM','LICENSE' — see the table-rebuild migration above (CHECK constraints can't be
  // ALTERed in SQLite) and SYSTEMS_1_3_SCHEMA_SQL's CREATE TABLE just below for the new CHECK.

  if (currentVersion !== targetVersion) {
    db.prepare("INSERT OR REPLACE INTO forge_meta (key, value) VALUES ('schema_version', ?)").run(targetVersion);
  }

  // Store machine ID now that table exists
  const machineId = getMachineId(dbPath);
  db.prepare("INSERT OR REPLACE INTO forge_meta (key, value) VALUES ('machine_id', ?)").run(machineId);
}

/** Read the current `schema_version` from `forge_meta` (assumes the db is initialized). */
export function getSchemaVersion(dbPath?: string): string {
  const db = getConnection(dbPath);
  const row = db.prepare("SELECT value FROM forge_meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return row?.value ?? 'unknown';
}

/** Per-table diagnostic row for `forge health`. */
export interface TableHealth {
  table: string;
  exists: boolean;
  rowCount: number;
  mostRecentCreatedAt: string | null;
}

/**
 * Report row counts + most recent `created_at` for every table in {@link ALL_FORGE_TABLES}.
 * A table that does not exist (e.g. a stale db from an interrupted migration) is reported
 * with `exists: false` rather than throwing.
 */
export function getAllTableHealth(dbPath?: string): TableHealth[] {
  const db = getConnection(dbPath);
  const existing = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (r) => r.name
    )
  );

  return ALL_FORGE_TABLES.map((table) => {
    if (!existing.has(table)) {
      return { table, exists: false, rowCount: 0, mostRecentCreatedAt: null };
    }
    const countRow = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
    let mostRecentCreatedAt: string | null = null;
    try {
      const recentRow = db.prepare(`SELECT created_at FROM "${table}" ORDER BY created_at DESC LIMIT 1`).get() as
        | { created_at: string }
        | undefined;
      mostRecentCreatedAt = recentRow?.created_at ?? null;
    } catch {
      // Table has no created_at column — leave null.
    }
    return { table, exists: true, rowCount: countRow.n, mostRecentCreatedAt };
  });
}
