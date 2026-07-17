-- 001_create_gap_audit_runs.sql
-- One row per invocation of the GapAuditor. Records audit scope, trigger, status,
-- aggregate health scores, gap counts, halt-point reconstruction, and the
-- continuation plan for `forge resurrect --resume`.
--
-- Target: FORGE Build Memory (SQLite, ~/.forge/forge_memory.db) — see
-- src/learning/database.ts. Bumps Build Memory schema_version to 2.3.0.
-- Written in SQLite dialect to match the executable schema in database.ts exactly.
-- Column set is authoritative per governance/SCHEMA_REGISTRY.md.

CREATE TABLE IF NOT EXISTS gap_audit_runs (
  id                      TEXT PRIMARY KEY,
  machine_id              TEXT NOT NULL,
  project_path            TEXT NOT NULL,
  audit_trigger           TEXT NOT NULL CHECK (audit_trigger IN ('halt_recovery','scheduled','manual','pre_resume')),
  audit_scope             TEXT NOT NULL DEFAULT 'FULL' CHECK (audit_scope IN ('FULL','TARGETED','CODE_ONLY','GOVERNANCE_ONLY')),
  status                  TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','halted_for_human')),
  artifacts_audited       INTEGER NOT NULL DEFAULT 0,
  gaps_found_total        INTEGER NOT NULL DEFAULT 0,
  gaps_minor              INTEGER NOT NULL DEFAULT 0,
  gaps_major              INTEGER NOT NULL DEFAULT 0,
  gaps_critical           INTEGER NOT NULL DEFAULT 0,
  gaps_auto_regenerated   INTEGER NOT NULL DEFAULT 0,
  gaps_human_gated        INTEGER NOT NULL DEFAULT 0,
  health_score_before     REAL,
  health_score_after      REAL,
  halt_point_reference    TEXT,
  continuation_plan       TEXT,
  scan_report_path        TEXT,
  build_run_id            TEXT,
  phase_at_audit          INTEGER,
  resume_eligible         INTEGER NOT NULL DEFAULT 0 CHECK (resume_eligible IN (0,1)),
  resume_blocked_reason   TEXT,
  error_message           TEXT,
  duration_ms             INTEGER,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at            TEXT
);
