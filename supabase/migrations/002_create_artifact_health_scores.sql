-- 002_create_artifact_health_scores.sql
-- One row per governance artifact per gap_audit_run. Stores completeness,
-- freshness, consistency, and composite scores; gap counts per severity; drift
-- and regeneration metadata; and the before/after health scores for regenerated
-- artifacts.
--
-- Target: FORGE Build Memory (SQLite, ~/.forge/forge_memory.db) — see
-- src/learning/database.ts. Depends on 001_create_gap_audit_runs.sql.
-- Column set is authoritative per governance/SCHEMA_REGISTRY.md.
--
-- Note: SQLite maps INTEGER PRIMARY KEY to an implicit rowid alias with
-- autoincrement-on-reuse semantics; AUTOINCREMENT below forces monotonic ids.

CREATE TABLE IF NOT EXISTS artifact_health_scores (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_run_id              TEXT NOT NULL,
  machine_id                TEXT NOT NULL,
  artifact_name             TEXT NOT NULL CHECK (artifact_name IN ('PRD','SCHEMA_REGISTRY','AGENTS','BEHAVIORAL_CONTRACTS','BLUEPRINT','TOOLCHAIN','SESSION_STATE','STATE_OF_THE_BUILD','TESTING')),
  artifact_path             TEXT,
  exists_on_disk            INTEGER NOT NULL DEFAULT 0 CHECK (exists_on_disk IN (0,1)),
  last_modified_days        REAL,
  completeness_score        REAL NOT NULL DEFAULT 0.0 CHECK (completeness_score >= 0.0 AND completeness_score <= 1.0),
  freshness_score           REAL NOT NULL DEFAULT 0.0 CHECK (freshness_score >= 0.0 AND freshness_score <= 1.0),
  consistency_score         REAL NOT NULL DEFAULT 0.0 CHECK (consistency_score >= 0.0 AND consistency_score <= 1.0),
  composite_score           REAL NOT NULL DEFAULT 0.0 CHECK (composite_score >= 0.0 AND composite_score <= 1.0),
  gaps_minor                INTEGER NOT NULL DEFAULT 0,
  gaps_major                INTEGER NOT NULL DEFAULT 0,
  gaps_critical             INTEGER NOT NULL DEFAULT 0,
  missing_sections          TEXT,
  placeholder_count         INTEGER NOT NULL DEFAULT 0,
  drift_detected            INTEGER NOT NULL DEFAULT 0 CHECK (drift_detected IN (0,1)),
  drift_detail              TEXT,
  regeneration_tier         TEXT NOT NULL DEFAULT 'NONE' CHECK (regeneration_tier IN ('NONE','AUTO','HUMAN_GATE')),
  regeneration_mode         TEXT CHECK (regeneration_mode IS NULL OR regeneration_mode IN ('FULL_FILE','SECTION_SCOPED')),
  health_score_before       REAL,
  health_score_after        REAL,
  regenerated_at            TEXT,
  gate_status               TEXT CHECK (gate_status IS NULL OR gate_status IN ('pending','approved','declined','deferred')),
  gate_presented_at         TEXT,
  gate_resolved_at          TEXT,
  gate_prompt_text          TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (audit_run_id) REFERENCES gap_audit_runs(id) ON DELETE CASCADE
);
