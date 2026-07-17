# FORGE 2.0 — SCHEMA ADDITIONS (Systems 1–3 Governance Package)

> Addendum to `SCHEMA_REGISTRY.md`. **Read this before either.** `SCHEMA_REGISTRY.md` and
> `SCHEMA.md` at the repo root describe FORGE's original self-hosted-Supabase design and are
> STALE — as of Session 1 (`d878693`), FORGE's Build Memory runs on **SQLite via
> `better-sqlite3`**, single file at `~/.forge/forge_memory.db` (`src/learning/database.ts`,
> `getForgeDbPath()`). Every table below is written in that file's exact style — the
> `BUILD_MEMORY_SCHEMA_SQL` / `initializeForgeMemory()` idiom — because that is the file every one
> of these tables actually gets created in. Do not generate Postgres/Supabase DDL for these six
> tables. `@supabase/supabase-js` remains a dependency only because FORGE inspects and migrates
> **generated projects'** Supabase databases (`src/tools/schema-extractor.ts`,
> `schema-validator.ts`, `migration-safety.ts`) — that is a target-project concern, unrelated to
> FORGE's own Build Memory.
>
> This document defines the **only** six new tables required across all three systems
> (`RESURRECTION_BLUEPRINT.md`, `LEARNING_BLUEPRINT.md`, `TESTING_BLUEPRINT.md`). Those three
> documents MUST reference these table and column names verbatim — no blueprint may invent a
> column or table not defined here, and no column defined here may go unused by a blueprint. If a
> blueprint needs a field this document doesn't have, this document is wrong and must be revised
> first; never patch the drift silently in code.

---

## 0. Conventions (inherited from `src/learning/database.ts`, non-negotiable)

| Postgres/JSONB concept (legacy docs) | SQLite reality (this document) |
|---|---|
| `uuid` PK | `TEXT PRIMARY KEY` — a `crypto.randomUUID()` string, generated in application code (SQLite has no `gen_random_uuid()`) |
| `jsonb` | `TEXT` column, `JSON.stringify()`'d on write, `JSON.parse()`'d on read by the CRUD module — never queried with JSON operators |
| `boolean` | `INTEGER` with `CHECK(col IN (0,1))`, default `0` |
| `timestamptz` | `TEXT`, ISO-8601, `DEFAULT (datetime('now'))` for insert-time columns, nullable free-text for others |
| `numeric(p,s)` | `REAL` |
| Enum constraint | `TEXT NOT NULL CHECK(col IN ('A','B',...))` — never a separate lookup table |
| `RLS ON table ...` | **N/A.** FORGE Build Memory is a single-operator local file (see §7). No table in this document carries a Postgres RLS policy. |

Every table:
- Is created with `CREATE TABLE IF NOT EXISTS` (idempotent — safe to re-run `initializeForgeMemory()` against a live populated db, matching every existing table).
- Carries `machine_id TEXT NOT NULL` (multi-machine attribution, BEHAVIORAL_CONTRACTS Contract 4/20 — no exceptions).
- Carries `created_at TEXT NOT NULL DEFAULT (datetime('now'))`.
- Is added to `ALL_FORGE_TABLES` in `src/learning/database.ts` (used by `forge health` row-count reporting — a table missing from this array is invisible to `forge health` and is treated as a defect).
- Ships as a new, additive `CREATE TABLE IF NOT EXISTS` block appended inside `initializeForgeMemory()` — never a destructive `ALTER`/`DROP`. A column added to an *existing* table (none are needed here) would use the guarded `ALTER TABLE ... ADD COLUMN` idiom from the `2.2.0 → 2.2.1` `queue_hash` addition; this document requires no such change.
- Bumps `CURRENT_SCHEMA_VERSION` in `src/learning/database.ts`. This package (all six tables, all three systems) ships as ONE schema bump: **`2.2.1` → `2.3.0`** (minor version — additive tables only, no breaking change to any existing table/column).

---

## 1. Table: `gap_audit_runs`

**System:** 1 — Resurrection and Gap Intelligence Engine
**Written by:** `GapAuditor` agent (one row per audit invocation)
**Read by:** `RegenerationEngine`, `HumanGateEvaluator`, `forge resurrect` CLI status output, `forge health`

Tracks one end-to-end gap-audit pass: a `GapAuditor` invocation against a project, from
`audit_trigger` through to a completed/halted/failed terminal state. Analogous to `build_runs`
but scoped to an audit rather than a full build — an audit MAY run standalone (project not
currently mid-build) or as a sub-phase of RETROFIT/`forge resurrect`.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | TEXT | PK | Audit run identifier (uuid) |
| `project_name` | TEXT | NOT NULL | Project under audit |
| `project_path` | TEXT | NOT NULL | Filesystem path at audit time |
| `build_run_id` | TEXT | FK → `build_runs(id)`, nullable | Parent build if triggered mid-build; NULL for standalone/scheduled audits |
| `audit_trigger` | TEXT | NOT NULL, CHECK IN (`'manual'`,`'scheduled'`,`'retrofit_entry'`,`'halt_recovery'`,`'post_build'`) | What caused this audit to run |
| `scope` | TEXT | NOT NULL, CHECK IN (`'FULL'`,`'GOVERNANCE_ONLY'`,`'CODE_ONLY'`,`'TARGETED'`) | Audit breadth — `TARGETED` pairs with `halt_point_reference` |
| `status` | TEXT | NOT NULL, DEFAULT `'running'`, CHECK IN (`'running'`,`'completed'`,`'failed'`,`'halted_for_human'`) | Terminal state |
| `started_at` | TEXT | NOT NULL, DEFAULT `datetime('now')` | Audit start |
| `completed_at` | TEXT | nullable | Audit end |
| `duration_ms` | INTEGER | nullable | Wall-clock duration |
| `artifacts_audited` | TEXT | NOT NULL, DEFAULT `'[]'` | JSON array of artifact names covered — subset of `PRD`,`SCHEMA_REGISTRY`,`AGENTS`,`BEHAVIORAL_CONTRACTS`,`BLUEPRINT`,`TOOLCHAIN`,`SESSION_STATE`,`STATE_OF_THE_BUILD`,`TESTING` |
| `gaps_found_total` | INTEGER | NOT NULL, DEFAULT 0 | Sum of all gap severities found |
| `gaps_minor` | INTEGER | NOT NULL, DEFAULT 0 | Minor gaps (see RESURRECTION_PRD §Gap Severity) |
| `gaps_major` | INTEGER | NOT NULL, DEFAULT 0 | Major gaps |
| `gaps_critical` | INTEGER | NOT NULL, DEFAULT 0 | Critical/architectural gaps (always human-gated) |
| `gaps_auto_regenerated` | INTEGER | NOT NULL, DEFAULT 0 | Gaps `RegenerationEngine` resolved without a human gate |
| `gaps_human_gated` | INTEGER | NOT NULL, DEFAULT 0 | Gaps routed to `HumanGateEvaluator` for approval |
| `halt_point_reference` | TEXT | nullable | JSON: `{buildRunId, promptIndex, promptName, failingCheck, subStepIndex, subStepName}` — the exact point a prior build halted, when this audit exists to diagnose a halt. `subStepIndex`/`subStepName` are nullable within the JSON (present only when the halted prompt had decomposed into sub-prompts, e.g. `prompt-decomposer.ts` output) — see RESURRECTION_PRD.md §Feature F24 / US-1 for the dialtest attempt 5 worked example this shape must reconstruct exactly |
| `continuation_plan` | TEXT | nullable | JSON: ordered array of next-action steps produced for `forge resurrect --resume` |
| `health_score_before` | REAL | nullable | Aggregate `artifact_health_scores.composite_score` mean, pre-regeneration |
| `health_score_after` | REAL | nullable | Same, post-regeneration (NULL until regeneration completes) |
| `report_path` | TEXT | nullable | Path to the written `.forge/gap_audit_report.md` |
| `machine_id` | TEXT | NOT NULL | Executing machine |
| `created_at` | TEXT | NOT NULL, DEFAULT `datetime('now')` | Record creation |

### Indexes
```sql
CREATE INDEX IF NOT EXISTS idx_gap_audit_runs_project ON gap_audit_runs(project_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gap_audit_runs_status ON gap_audit_runs(status);
CREATE INDEX IF NOT EXISTS idx_gap_audit_runs_build ON gap_audit_runs(build_run_id);
```

### Access Control
No RLS (§7). `project_path` is local-filesystem-scoped by definition; no cross-project read path exists in the CRUD layer (`src/memory/gap-audits.ts`, to be added) other than an explicit `project_name` filter.

### DDL
```sql
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
  gaps_found_total        INTEGER NOT NULL DEFAULT 0,
  gaps_minor              INTEGER NOT NULL DEFAULT 0,
  gaps_major               INTEGER NOT NULL DEFAULT 0,
  gaps_critical             INTEGER NOT NULL DEFAULT 0,
  gaps_auto_regenerated     INTEGER NOT NULL DEFAULT 0,
  gaps_human_gated          INTEGER NOT NULL DEFAULT 0,
  halt_point_reference       TEXT,
  continuation_plan          TEXT,
  health_score_before         REAL,
  health_score_after          REAL,
  report_path                TEXT,
  machine_id                 TEXT NOT NULL,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gap_audit_runs_project ON gap_audit_runs(project_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gap_audit_runs_status ON gap_audit_runs(status);
CREATE INDEX IF NOT EXISTS idx_gap_audit_runs_build ON gap_audit_runs(build_run_id);
```

---

## 2. Table: `artifact_health_scores`

**System:** 1 — Resurrection and Gap Intelligence Engine
**Written by:** `ArtifactHealthScorer` agent (one row per artifact, per audit)
**Read by:** `RegenerationEngine` (regeneration triage), `HumanGateEvaluator`, `forge health`

One row per governance artifact per `gap_audit_runs` row — the scored breakdown that rolls up
into that audit's `health_score_before`/`health_score_after`.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | TEXT | PK | Score record identifier (uuid) |
| `gap_audit_run_id` | TEXT | NOT NULL, FK → `gap_audit_runs(id)` | Parent audit |
| `artifact_name` | TEXT | NOT NULL, CHECK IN (`'PRD'`,`'SCHEMA_REGISTRY'`,`'AGENTS'`,`'BEHAVIORAL_CONTRACTS'`,`'BLUEPRINT'`,`'TOOLCHAIN'`,`'SESSION_STATE'`,`'STATE_OF_THE_BUILD'`,`'TESTING'`) | Which governance doc this row scores |
| `exists_on_disk` | INTEGER | NOT NULL, DEFAULT 0, CHECK IN (0,1) | Whether the file was found at all |
| `completeness_score` | REAL | NOT NULL, DEFAULT 0, CHECK BETWEEN 0 AND 1 | Fraction of required sections present and non-placeholder |
| `freshness_score` | REAL | NOT NULL, DEFAULT 0, CHECK BETWEEN 0 AND 1 | Inverse of drift vs. actual codebase state (1 = perfectly current) |
| `consistency_score` | REAL | NOT NULL, DEFAULT 0, CHECK BETWEEN 0 AND 1 | Inverse of cross-document contradictions found |
| `composite_score` | REAL | NOT NULL, DEFAULT 0, CHECK BETWEEN 0 AND 1 | Weighted roll-up (RESURRECTION_BLUEPRINT §ArtifactHealthScorer defines the weights) |
| `drift_detected` | INTEGER | NOT NULL, DEFAULT 0, CHECK IN (0,1) | Whether freshness scoring found actual drift |
| `drift_detail` | TEXT | nullable | JSON array of `{section, docSays, codeShows}` drift entries |
| `missing_sections` | TEXT | NOT NULL, DEFAULT `'[]'` | JSON array of required section headers absent from the doc |
| `placeholder_count` | INTEGER | NOT NULL, DEFAULT 0 | Count of `TBD`/`TODO`/`{{...}}`/placeholder occurrences found |
| `regeneration_recommended` | INTEGER | NOT NULL, DEFAULT 0, CHECK IN (0,1) | Whether `composite_score` fell below the regeneration threshold |
| `regeneration_tier` | TEXT | nullable, CHECK IN (`'AUTO'`,`'HUMAN_GATE'`) OR NULL | Which path regeneration would take, if recommended |
| `scored_at` | TEXT | NOT NULL, DEFAULT `datetime('now')` | Scoring timestamp |
| `machine_id` | TEXT | NOT NULL | Executing machine |

### Indexes
```sql
CREATE INDEX IF NOT EXISTS idx_artifact_health_audit ON artifact_health_scores(gap_audit_run_id);
CREATE INDEX IF NOT EXISTS idx_artifact_health_name ON artifact_health_scores(artifact_name);
CREATE INDEX IF NOT EXISTS idx_artifact_health_score ON artifact_health_scores(composite_score ASC);
```

### Access Control
No RLS (§7). Scoped to its parent `gap_audit_run_id`; no direct project-name filter needed since every row traces back to exactly one audited project through its parent.

### DDL
```sql
CREATE TABLE IF NOT EXISTS artifact_health_scores (
  id                        TEXT PRIMARY KEY,
  gap_audit_run_id           TEXT NOT NULL,
  artifact_name               TEXT NOT NULL CHECK(artifact_name IN ('PRD','SCHEMA_REGISTRY','AGENTS','BEHAVIORAL_CONTRACTS','BLUEPRINT','TOOLCHAIN','SESSION_STATE','STATE_OF_THE_BUILD','TESTING')),
  exists_on_disk               INTEGER NOT NULL DEFAULT 0 CHECK(exists_on_disk IN (0,1)),
  completeness_score            REAL NOT NULL DEFAULT 0 CHECK(completeness_score >= 0.0 AND completeness_score <= 1.0),
  freshness_score               REAL NOT NULL DEFAULT 0 CHECK(freshness_score >= 0.0 AND freshness_score <= 1.0),
  consistency_score             REAL NOT NULL DEFAULT 0 CHECK(consistency_score >= 0.0 AND consistency_score <= 1.0),
  composite_score               REAL NOT NULL DEFAULT 0 CHECK(composite_score >= 0.0 AND composite_score <= 1.0),
  drift_detected                INTEGER NOT NULL DEFAULT 0 CHECK(drift_detected IN (0,1)),
  drift_detail                  TEXT,
  missing_sections              TEXT NOT NULL DEFAULT '[]',
  placeholder_count              INTEGER NOT NULL DEFAULT 0,
  regeneration_recommended       INTEGER NOT NULL DEFAULT 0 CHECK(regeneration_recommended IN (0,1)),
  regeneration_tier              TEXT CHECK(regeneration_tier IN ('AUTO','HUMAN_GATE') OR regeneration_tier IS NULL),
  scored_at                     TEXT NOT NULL DEFAULT (datetime('now')),
  machine_id                    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_health_audit ON artifact_health_scores(gap_audit_run_id);
CREATE INDEX IF NOT EXISTS idx_artifact_health_name ON artifact_health_scores(artifact_name);
CREATE INDEX IF NOT EXISTS idx_artifact_health_score ON artifact_health_scores(composite_score ASC);
```

---

## 3. Table: `evolution_promotions`

**System:** 2 — Recursive Enterprise Learning Engine
**Written by:** `EvolutionPromoter` agent
**Read by:** `BuildBrainEvolver` (rollback monitoring), `forge health`, `forge learning status`

Tracks every promotion decision made against a `pending_evolutions` row — auto-promoted above
confidence threshold, human-approved, or human-rejected. This is the audit trail Contract 16
("Template Evolution... become active ONLY after human approval") requires when promotion is
automated: every AUTO promotion must be traceable to the confidence score and evidence volume
that justified skipping the human gate.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | TEXT | PK | Promotion record identifier (uuid) |
| `pending_evolution_id` | TEXT | NOT NULL, FK → `pending_evolutions(id)` | The evolution being promoted |
| `evolution_type` | TEXT | NOT NULL, CHECK IN (`'HOOK'`,`'TEMPLATE'`,`'RULE'`,`'THRESHOLD'`,`'CONFIG'`,`'GATE'`) | Denormalized copy of `pending_evolutions.evolution_type` at promotion time (survives if the source row's type is ever amended) |
| `confidence_at_promotion` | REAL | NOT NULL, CHECK BETWEEN 0 AND 1 | `pending_evolutions.confidence` value read at promotion time |
| `confidence_threshold_applied` | REAL | NOT NULL, CHECK BETWEEN 0 AND 1 | The threshold in force when this decision was made (thresholds are versioned in `forge_meta`, see LEARNING_BLUEPRINT §EvolutionPromoter) |
| `promotion_method` | TEXT | NOT NULL, CHECK IN (`'AUTO'`,`'HUMAN_APPROVED'`,`'HUMAN_OVERRIDE_REJECTED'`) | How the row reached its terminal state |
| `evidence_build_count` | INTEGER | NOT NULL, DEFAULT 0 | Number of distinct builds the promoted evidence was drawn from |
| `pre_promotion_success_rate` | REAL | nullable | Success rate of the pattern/rule in the builds preceding promotion |
| `post_promotion_success_rate` | REAL | nullable | Backfilled by the monitoring window (NULL until `monitoring_window_builds` builds have elapsed) |
| `monitoring_window_builds` | INTEGER | NOT NULL, DEFAULT 10 | How many subsequent builds `BuildBrainEvolver` watches before the promotion is considered validated |
| `rollback_triggered` | INTEGER | NOT NULL, DEFAULT 0, CHECK IN (0,1) | Whether the monitoring window detected regression and reverted the promotion |
| `rollback_reason` | TEXT | nullable | Human-readable reason if `rollback_triggered = 1` |
| `promoted_at` | TEXT | NOT NULL, DEFAULT `datetime('now')` | When the promotion decision was made |
| `reviewed_at` | TEXT | nullable | When a human reviewed an AUTO promotion after the fact (AUTO promotions are always retroactively reviewable, never silently permanent) |
| `machine_id` | TEXT | NOT NULL | Executing machine |
| `created_at` | TEXT | NOT NULL, DEFAULT `datetime('now')` | Record creation |

### Indexes
```sql
CREATE INDEX IF NOT EXISTS idx_evolution_promotions_pending ON evolution_promotions(pending_evolution_id);
CREATE INDEX IF NOT EXISTS idx_evolution_promotions_method ON evolution_promotions(promotion_method);
CREATE INDEX IF NOT EXISTS idx_evolution_promotions_rollback ON evolution_promotions(rollback_triggered) WHERE rollback_triggered = 1;
```

### Access Control
No RLS (§7). `pending_evolution_id` FK is the only join key; single-operator scope applies.

### DDL
```sql
CREATE TABLE IF NOT EXISTS evolution_promotions (
  id                            TEXT PRIMARY KEY,
  pending_evolution_id           TEXT NOT NULL,
  evolution_type                  TEXT NOT NULL CHECK(evolution_type IN ('HOOK','TEMPLATE','RULE','THRESHOLD','CONFIG','GATE')),
  confidence_at_promotion          REAL NOT NULL CHECK(confidence_at_promotion >= 0.0 AND confidence_at_promotion <= 1.0),
  confidence_threshold_applied      REAL NOT NULL CHECK(confidence_threshold_applied >= 0.0 AND confidence_threshold_applied <= 1.0),
  promotion_method                 TEXT NOT NULL CHECK(promotion_method IN ('AUTO','HUMAN_APPROVED','HUMAN_OVERRIDE_REJECTED')),
  evidence_build_count              INTEGER NOT NULL DEFAULT 0,
  pre_promotion_success_rate         REAL,
  post_promotion_success_rate        REAL,
  monitoring_window_builds           INTEGER NOT NULL DEFAULT 10,
  rollback_triggered                INTEGER NOT NULL DEFAULT 0 CHECK(rollback_triggered IN (0,1)),
  rollback_reason                   TEXT,
  promoted_at                       TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at                       TEXT,
  machine_id                        TEXT NOT NULL,
  created_at                        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evolution_promotions_pending ON evolution_promotions(pending_evolution_id);
CREATE INDEX IF NOT EXISTS idx_evolution_promotions_method ON evolution_promotions(promotion_method);
CREATE INDEX IF NOT EXISTS idx_evolution_promotions_rollback ON evolution_promotions(rollback_triggered) WHERE rollback_triggered = 1;
```

---

## 4. Table: `pattern_retirement_log`

**System:** 2 — Recursive Enterprise Learning Engine
**Written by:** `PatternRetirer` agent
**Read by:** `CrossProjectKnowledgeTransfer` (must not transfer a retired pattern), `forge health`

Append-only retirement audit trail. `PatternRetirer` never hard-deletes a row from
`fix_patterns`/`error_patterns`/`skill_library`/`design_patterns`/`governance_rules` without
first writing the retired state here — a SOFT_RETIRE flips the source row inactive (where the
table has an `active`/equivalent flag, e.g. `governance_rules.active`) or marks it via a
retirement marker; a HARD_DELETE removes the source row but this log entry is the only
remaining record it ever existed. See LEARNING_BLUEPRINT §PatternRetirer for the exact
per-table mechanics (`fix_patterns`, `error_patterns`, `design_patterns` have no `active`
column, so retirement there is soft via `retired_at`-style handling described there, not a new
column added by this document).

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | TEXT | PK | Retirement record identifier (uuid) |
| `pattern_table` | TEXT | NOT NULL, CHECK IN (`'fix_patterns'`,`'error_patterns'`,`'skill_library'`,`'design_patterns'`,`'governance_rules'`) | Which existing table the retired row belonged to |
| `pattern_id` | TEXT | NOT NULL | The retired row's `id` in its source table |
| `pattern_fingerprint` | TEXT | NOT NULL | The row's natural key at time of retirement (`error_fingerprint`, `error_signature`, `skill_name`, pattern `name`, or `rule_short_name`) — preserved so the pattern is identifiable even after a HARD_DELETE |
| `retirement_reason` | TEXT | NOT NULL, CHECK IN (`'ZERO_SUCCESS_RATE'`,`'STALE_UNUSED'`,`'SUPERSEDED'`,`'CONTRADICTS_NEWER_PATTERN'`,`'MANUAL'`) | Why this pattern was retired |
| `times_applied_before_retirement` | INTEGER | NOT NULL, DEFAULT 0 | Snapshot of the source row's application count |
| `times_succeeded_before_retirement` | INTEGER | NOT NULL, DEFAULT 0 | Snapshot of the source row's success count |
| `success_rate_at_retirement` | REAL | NOT NULL, DEFAULT 0 | Snapshot of the source row's success rate |
| `last_seen_before_retirement` | TEXT | nullable | Snapshot of the source row's `last_seen`/`last_enforced` timestamp |
| `superseded_by_pattern_id` | TEXT | nullable | If `retirement_reason = 'SUPERSEDED'`, the `id` (same `pattern_table`) of the replacement pattern |
| `action_taken` | TEXT | NOT NULL, DEFAULT `'SOFT_RETIRE'`, CHECK IN (`'SOFT_RETIRE'`,`'HARD_DELETE'`) | Whether the source row was deactivated or removed |
| `retired_at` | TEXT | NOT NULL, DEFAULT `datetime('now')` | Retirement timestamp |
| `machine_id` | TEXT | NOT NULL | Executing machine |
| `created_at` | TEXT | NOT NULL, DEFAULT `datetime('now')` | Record creation |

### Indexes
```sql
CREATE INDEX IF NOT EXISTS idx_pattern_retirement_table_id ON pattern_retirement_log(pattern_table, pattern_id);
CREATE INDEX IF NOT EXISTS idx_pattern_retirement_reason ON pattern_retirement_log(retirement_reason);
CREATE INDEX IF NOT EXISTS idx_pattern_retirement_fingerprint ON pattern_retirement_log(pattern_fingerprint);
```

### Access Control
No RLS (§7). Append-only by convention (enforced in application code, not a DB trigger — matches FORGE's existing house style of no triggers anywhere in the schema).

### DDL
```sql
CREATE TABLE IF NOT EXISTS pattern_retirement_log (
  id                                 TEXT PRIMARY KEY,
  pattern_table                       TEXT NOT NULL CHECK(pattern_table IN ('fix_patterns','error_patterns','skill_library','design_patterns','governance_rules')),
  pattern_id                          TEXT NOT NULL,
  pattern_fingerprint                  TEXT NOT NULL,
  retirement_reason                    TEXT NOT NULL CHECK(retirement_reason IN ('ZERO_SUCCESS_RATE','STALE_UNUSED','SUPERSEDED','CONTRADICTS_NEWER_PATTERN','MANUAL')),
  times_applied_before_retirement        INTEGER NOT NULL DEFAULT 0,
  times_succeeded_before_retirement       INTEGER NOT NULL DEFAULT 0,
  success_rate_at_retirement              REAL NOT NULL DEFAULT 0,
  last_seen_before_retirement             TEXT,
  superseded_by_pattern_id                TEXT,
  action_taken                           TEXT NOT NULL DEFAULT 'SOFT_RETIRE' CHECK(action_taken IN ('SOFT_RETIRE','HARD_DELETE')),
  retired_at                             TEXT NOT NULL DEFAULT (datetime('now')),
  machine_id                             TEXT NOT NULL,
  created_at                             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pattern_retirement_table_id ON pattern_retirement_log(pattern_table, pattern_id);
CREATE INDEX IF NOT EXISTS idx_pattern_retirement_reason ON pattern_retirement_log(retirement_reason);
CREATE INDEX IF NOT EXISTS idx_pattern_retirement_fingerprint ON pattern_retirement_log(pattern_fingerprint);
```

---

## 5. Table: `test_run_results`

**System:** 3 — Enterprise Test Suite
**Written by:** `TestOrchestrator` agent (one row per suite invocation)
**Read by:** Sentinel (Ring 3 gate consults latest `E2E`/`UNIT` rows), `forge health`, `forge test status`

One row per test-suite run (a single Vitest project/config invocation, or an equivalent
non-Vitest tool run for suites Vitest doesn't natively cover — see TESTING_BLUEPRINT
§Runner Configurations for which suites run under which tool).

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | TEXT | PK | Run identifier (uuid) |
| `build_run_id` | TEXT | FK → `build_runs(id)`, nullable | Parent build if triggered by Phase 3; NULL for scheduled/manual runs |
| `project_name` | TEXT | NOT NULL | Project under test |
| `trigger` | TEXT | NOT NULL, CHECK IN (`'POST_PROMPT'`,`'SCHEDULED'`,`'MANUAL'`,`'PRE_DEPLOY'`,`'CI'`) | What caused this run |
| `test_suite` | TEXT | NOT NULL, CHECK IN (`'UNIT'`,`'INTEGRATION'`,`'API'`,`'E2E'`,`'VISUAL_REGRESSION'`,`'PERFORMANCE'`,`'LOAD'`,`'STRESS'`,`'SOAK'`,`'SECURITY'`,`'ACCESSIBILITY'`,`'CHAOS'`,`'DISASTER_RECOVERY'`,`'BACKUP_RESTORE'`,`'DEPENDENCY_SCAN'`,`'STATIC_ANALYSIS'`,`'DYNAMIC_ANALYSIS'`,`'CROSS_BROWSER'`,`'CROSS_DEVICE'`) | Which of the 19 suite types this row reports |
| `runner` | TEXT | NOT NULL, DEFAULT `'vitest'` | Tool that executed the suite (`vitest`, `playwright`, `k6`, `zap`, `axe-core`, `trivy`, etc. — see TESTING_BLUEPRINT) |
| `status` | TEXT | NOT NULL, CHECK IN (`'running'`,`'passed'`,`'failed'`,`'partial'`,`'skipped'`,`'error'`) | Terminal state |
| `prompt_index` | INTEGER | nullable | Phase 3 prompt index that triggered this run, when `trigger = 'POST_PROMPT'` |
| `tests_total` | INTEGER | NOT NULL, DEFAULT 0 | Total test cases in this run |
| `tests_passed` | INTEGER | NOT NULL, DEFAULT 0 | Passed count |
| `tests_failed` | INTEGER | NOT NULL, DEFAULT 0 | Failed count |
| `tests_skipped` | INTEGER | NOT NULL, DEFAULT 0 | Skipped count |
| `duration_ms` | INTEGER | NOT NULL, DEFAULT 0 | Wall-clock run duration |
| `failure_summary` | TEXT | nullable | JSON array of `{name, message, file}` for failed cases (capped — see TESTING_BLUEPRINT for the cap) |
| `report_path` | TEXT | nullable | Path to the written report artifact (Vitest JSON/HTML reporter output, Playwright trace, etc.) |
| `exit_code` | INTEGER | nullable | Process exit code of the runner |
| `started_at` | TEXT | NOT NULL, DEFAULT `datetime('now')` | Run start |
| `completed_at` | TEXT | nullable | Run end |
| `machine_id` | TEXT | NOT NULL | Executing machine |
| `created_at` | TEXT | NOT NULL, DEFAULT `datetime('now')` | Record creation |

### Indexes
```sql
CREATE INDEX IF NOT EXISTS idx_test_run_results_build ON test_run_results(build_run_id);
CREATE INDEX IF NOT EXISTS idx_test_run_results_suite ON test_run_results(test_suite, status);
CREATE INDEX IF NOT EXISTS idx_test_run_results_project ON test_run_results(project_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_run_results_status ON test_run_results(status);
```

### Access Control
No RLS (§7).

### DDL
```sql
CREATE TABLE IF NOT EXISTS test_run_results (
  id                    TEXT PRIMARY KEY,
  build_run_id           TEXT,
  project_name            TEXT NOT NULL,
  trigger                TEXT NOT NULL CHECK(trigger IN ('POST_PROMPT','SCHEDULED','MANUAL','PRE_DEPLOY','CI')),
  test_suite              TEXT NOT NULL CHECK(test_suite IN ('UNIT','INTEGRATION','API','E2E','VISUAL_REGRESSION','PERFORMANCE','LOAD','STRESS','SOAK','SECURITY','ACCESSIBILITY','CHAOS','DISASTER_RECOVERY','BACKUP_RESTORE','DEPENDENCY_SCAN','STATIC_ANALYSIS','DYNAMIC_ANALYSIS','CROSS_BROWSER','CROSS_DEVICE')),
  runner                  TEXT NOT NULL DEFAULT 'vitest',
  status                  TEXT NOT NULL CHECK(status IN ('running','passed','failed','partial','skipped','error')),
  prompt_index             INTEGER,
  tests_total               INTEGER NOT NULL DEFAULT 0,
  tests_passed               INTEGER NOT NULL DEFAULT 0,
  tests_failed                INTEGER NOT NULL DEFAULT 0,
  tests_skipped                INTEGER NOT NULL DEFAULT 0,
  duration_ms                  INTEGER NOT NULL DEFAULT 0,
  failure_summary               TEXT,
  report_path                   TEXT,
  exit_code                     INTEGER,
  started_at                    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at                  TEXT,
  machine_id                    TEXT NOT NULL,
  created_at                    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_test_run_results_build ON test_run_results(build_run_id);
CREATE INDEX IF NOT EXISTS idx_test_run_results_suite ON test_run_results(test_suite, status);
CREATE INDEX IF NOT EXISTS idx_test_run_results_project ON test_run_results(project_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_run_results_status ON test_run_results(status);
```

---

## 6. Table: `test_coverage_snapshots`

**System:** 3 — Enterprise Test Suite
**Written by:** `TestOrchestrator` agent (one row per coverage dimension, per `UNIT`/`INTEGRATION` run)
**Read by:** `forge test coverage`, Sentinel Ring 3 gate, `TemplateEvolver` (coverage trend as a signal — LEARNING_BLUEPRINT cross-reference)

Coverage percentage tracked over time, per project, per coverage dimension. Distinct from
`test_run_results` because a single `UNIT` run produces up to four coverage rows (line, branch,
function, statement) via Vitest's `@vitest/coverage-v8` reporter.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | TEXT | PK | Snapshot identifier (uuid) |
| `build_run_id` | TEXT | FK → `build_runs(id)`, nullable | Parent build, if applicable |
| `project_name` | TEXT | NOT NULL | Project measured |
| `test_run_result_id` | TEXT | NOT NULL, FK → `test_run_results(id)` | The `UNIT`/`INTEGRATION` run this snapshot was captured from |
| `coverage_type` | TEXT | NOT NULL, CHECK IN (`'LINE'`,`'BRANCH'`,`'FUNCTION'`,`'STATEMENT'`) | Coverage dimension |
| `coverage_pct` | REAL | NOT NULL, CHECK BETWEEN 0 AND 100 | Coverage percentage for this dimension |
| `lines_total` | INTEGER | NOT NULL, DEFAULT 0 | Total countable units (lines/branches/functions/statements per `coverage_type`) |
| `lines_covered` | INTEGER | NOT NULL, DEFAULT 0 | Covered units |
| `files_below_threshold` | TEXT | NOT NULL, DEFAULT `'[]'` | JSON array of `{file, pct}` for files under `threshold_required` |
| `threshold_required` | REAL | NOT NULL, DEFAULT 0.80, CHECK BETWEEN 0 AND 1 | Configured minimum (TESTING_PRD defines the default; per-project override lives in TOOLCHAIN.md) |
| `threshold_met` | INTEGER | NOT NULL, DEFAULT 0, CHECK IN (0,1) | Whether `coverage_pct/100 >= threshold_required` |
| `delta_vs_previous` | REAL | nullable | `coverage_pct` minus the immediately preceding snapshot of the same `project_name` + `coverage_type` |
| `captured_at` | TEXT | NOT NULL, DEFAULT `datetime('now')` | Capture timestamp |
| `machine_id` | TEXT | NOT NULL | Executing machine |

### Indexes
```sql
CREATE INDEX IF NOT EXISTS idx_test_coverage_project ON test_coverage_snapshots(project_name, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_coverage_run ON test_coverage_snapshots(test_run_result_id);
CREATE INDEX IF NOT EXISTS idx_test_coverage_type ON test_coverage_snapshots(coverage_type);
```

### Access Control
No RLS (§7).

### DDL
```sql
CREATE TABLE IF NOT EXISTS test_coverage_snapshots (
  id                       TEXT PRIMARY KEY,
  build_run_id              TEXT,
  project_name               TEXT NOT NULL,
  test_run_result_id          TEXT NOT NULL,
  coverage_type                TEXT NOT NULL CHECK(coverage_type IN ('LINE','BRANCH','FUNCTION','STATEMENT')),
  coverage_pct                  REAL NOT NULL CHECK(coverage_pct >= 0.0 AND coverage_pct <= 100.0),
  lines_total                    INTEGER NOT NULL DEFAULT 0,
  lines_covered                   INTEGER NOT NULL DEFAULT 0,
  files_below_threshold             TEXT NOT NULL DEFAULT '[]',
  threshold_required                 REAL NOT NULL DEFAULT 0.80 CHECK(threshold_required >= 0.0 AND threshold_required <= 1.0),
  threshold_met                      INTEGER NOT NULL DEFAULT 0 CHECK(threshold_met IN (0,1)),
  delta_vs_previous                   REAL,
  captured_at                         TEXT NOT NULL DEFAULT (datetime('now')),
  machine_id                          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_coverage_project ON test_coverage_snapshots(project_name, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_coverage_run ON test_coverage_snapshots(test_run_result_id);
CREATE INDEX IF NOT EXISTS idx_test_coverage_type ON test_coverage_snapshots(coverage_type);
```

---

## 7. Access Control Model (why there is no RLS)

FORGE's Build Memory is a **single-operator local SQLite file** (`~/.forge/forge_memory.db`),
not a hosted multi-tenant Postgres database — this has been true since the Session 1 migration
off self-hosted Supabase (`d878693`). Row Level Security is a Postgres/Supabase policy
mechanism; SQLite has no equivalent concept, and every existing table in the live schema
(`build_runs` through `scheduled_tasks`) already documents this identically (precedent:
`SCHEMA_REGISTRY.md`'s `build_runs` entry — *"RLS: None (FORGE is single-operator, local
database)"*). The six tables in this document follow the same rule and are marked "No RLS (§7)"
individually above rather than repeating this paragraph six times.

The operative access-control boundary for these six tables is **`machine_id`** (multi-machine
attribution, Contract 4/20) plus filesystem permissions on `~/.forge/forge_memory.db` itself —
identical to every other table. If a future FORGE mode re-introduces a hosted, multi-tenant
Postgres Build Memory (e.g. a team/SaaS deployment sharing one instance across operators), the
equivalent policy for each table would scope rows by `machine_id` (or a to-be-added `owner_id`)
using the same pattern as any hosted-Supabase RLS policy elsewhere in the org's stack — but that
is out of scope for this package; FORGE's actual deployment target for these three systems is the
existing single-operator SQLite file, and no code in `RESURRECTION_BLUEPRINT.md`,
`LEARNING_BLUEPRINT.md`, or `TESTING_BLUEPRINT.md` may assume otherwise.

---

## 8. `src/learning/database.ts` integration checklist

Implementers must make exactly these changes (no others) to ship this schema addition:

1. Append all six `CREATE TABLE IF NOT EXISTS` blocks (§1–§6 DDL) inside the `initializeForgeMemory()` function body, after the existing `hook_execution_log`/`compact_snapshots`/`build_fingerprints`/`adversary_findings` blocks (same function, same style — these six are additive, not a new SQL constant, matching how `build_fingerprints` etc. were added directly inline rather than as a new `_SCHEMA_SQL` constant).
2. Add all six table names to the `ALL_FORGE_TABLES` array:
   ```ts
   'gap_audit_runs',
   'artifact_health_scores',
   'evolution_promotions',
   'pattern_retirement_log',
   'test_run_results',
   'test_coverage_snapshots',
   ```
3. Bump `CURRENT_SCHEMA_VERSION` from `'2.2.1'` to `'2.3.0'`.
4. Add a `src/memory/gap-audits.ts`, `src/memory/evolutions.ts` (extending the existing `pending_evolutions` CRUD if `src/memory/` already has one — verify before creating a duplicate), and `src/memory/test-results.ts` CRUD module per the standard pattern (`src/memory/builds.ts` is the reference shape: typed insert/get/list functions wrapping prepared statements, no raw SQL outside these modules).
5. Update `AGENTS.md` with the four new/extended agent entries this package introduces (`GapAuditor`, `RegenerationEngine`, `ArtifactHealthScorer`, `HumanGateEvaluator`, `EvolutionPromoter`, `PatternRetirer`, `CrossProjectKnowledgeTransfer`, `BuildBrainEvolver`, `TestOrchestrator`) in the same table format as the existing entries — this document does not do that; it is done when each system is actually implemented, per its own blueprint.
6. Run `forge health` after migration and confirm all six tables report `0 rows, table exists` — the existing wiring-check convention (BLUEPRINT.md Canonical Rule 9 / the 19-check pattern referenced in `FORGE_HANDOFF.md`).

No table in this document requires a foreign-key `ON DELETE` behavior beyond SQLite's default
(no action) — none of these six tables' parent rows (`build_runs`, `pending_evolutions`,
`test_run_results`, `gap_audit_runs`) are ever hard-deleted by any existing FORGE code path, so
orphan handling is out of scope. `PRAGMA foreign_keys = ON` is already set globally in
`getConnection()` (`src/learning/database.ts` line 41); FK columns above are enforced by SQLite
at the connection level, not merely documented as convention.
