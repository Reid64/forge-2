// FORGE 2.0 Learning Engine — Database Initialization
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_DB_DIR = join(homedir(), '.forge');
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, 'forge_memory.db');

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

  // Store machine ID now that table exists
  const machineId = getMachineId(dbPath);
  db.prepare("INSERT OR REPLACE INTO forge_meta (key, value) VALUES ('machine_id', ?)").run(machineId);
}
