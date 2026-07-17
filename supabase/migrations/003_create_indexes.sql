-- 003_create_indexes.sql
-- All 13 indexes for gap_audit_runs and artifact_health_scores, including the
-- partial index on build_run_id, the unique composite index enforcing one row
-- per artifact per audit run, and the partial index on drift_detected.
--
-- Target: FORGE Build Memory (SQLite, ~/.forge/forge_memory.db) — see
-- src/learning/database.ts. Depends on 001_create_gap_audit_runs.sql and
-- 002_create_artifact_health_scores.sql. Index set is authoritative per
-- governance/SCHEMA_REGISTRY.md.

CREATE INDEX IF NOT EXISTS idx_gap_audit_runs_machine_id ON gap_audit_runs(machine_id);
CREATE INDEX IF NOT EXISTS idx_gap_audit_runs_build_run_id ON gap_audit_runs(build_run_id) WHERE build_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gap_audit_runs_project_path ON gap_audit_runs(project_path);
CREATE INDEX IF NOT EXISTS idx_gap_audit_runs_status ON gap_audit_runs(status);
CREATE INDEX IF NOT EXISTS idx_gap_audit_runs_audit_trigger ON gap_audit_runs(audit_trigger);
CREATE INDEX IF NOT EXISTS idx_gap_audit_runs_created_at ON gap_audit_runs(created_at);

CREATE INDEX IF NOT EXISTS idx_artifact_health_scores_audit_run_id ON artifact_health_scores(audit_run_id);
CREATE INDEX IF NOT EXISTS idx_artifact_health_scores_machine_id ON artifact_health_scores(machine_id);
CREATE INDEX IF NOT EXISTS idx_artifact_health_scores_artifact_name ON artifact_health_scores(artifact_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_health_scores_run_artifact ON artifact_health_scores(audit_run_id, artifact_name);
CREATE INDEX IF NOT EXISTS idx_artifact_health_scores_regeneration_tier ON artifact_health_scores(regeneration_tier);
CREATE INDEX IF NOT EXISTS idx_artifact_health_scores_drift_detected ON artifact_health_scores(drift_detected) WHERE drift_detected = 1;
CREATE INDEX IF NOT EXISTS idx_artifact_health_scores_composite_score ON artifact_health_scores(composite_score);
