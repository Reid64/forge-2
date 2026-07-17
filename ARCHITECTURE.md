# forge-2 -- ARCHITECTURE (FORGE Phase 1B)

- **Generated:** 2026-07-17T00:22:27.222Z
- **Mode:** greenfield
- **Model:** claude-sonnet-4-6
- **Design system:** generated -> C:\Users\manag\Documents\forge-2\governance\DESIGN_SYSTEM.md (injected into UI prompts)

> Gate 2: the build HALTS here until a human approves this architecture (Contract 2).

---

## Database Architecture -- System 1: Resurrection and Gap Intelligence Engine

### Overview

System 1 persists all audit state to a **local SQLite file** at `~/.forge/forge_memory.db` (Build Memory). This is a single-operator, single-tenant store -- there is no hosted Postgres, no RLS, and no tenant scoping. Every row carries `machine_id` to satisfy Iron Law R6 (Contract 4/20) and to support future multi-machine correlation without a schema change. Schema version advances from `2.2.1` to `2.3.0` (shared across Systems 1-3 per SCHEMA_ADDITIONS.md).

Two tables are introduced:

| Table | Rows | Primary Key |
|---|---|---|
| `gap_audit_runs` | One per `forge audit` invocation | `id` (UUID TEXT, set by caller) |
| `artifact_health_scores` | Nine per audit run (one per governance artifact) | `id` (AUTOINCREMENT INTEGER) |

---

### Table: `gap_audit_runs`

**Purpose.** Master record for a single GapAuditor invocation. Captures scope, trigger, lifecycle status, aggregate gap counts, project-level health scores before and after regeneration, the reconstructed halt-point JSON, the continuation plan consumed by `forge resurrect --resume`, and elapsed duration.

**Key columns:**

- `id` -- Caller-assigned UUID (TEXT). Matches the `build_run_id` convention used in Build Memory for correlating rows across tables.
- `machine_id` -- Identifies the local machine; required on every insert (R6).
- `project_path` -- Absolute filesystem path to the audited project.
- `audit_trigger` -- One of `halt_recovery`, `scheduled`, `manual`, `pre_resume`. A `halt_recovery` audit must produce a non-null `halt_point_reference` (US-1).
- `audit_scope` -- One of `FULL`, `TARGETED`, `CODE_ONLY`, `GOVERNANCE_ONLY`. `TARGETED` is the scope used for sub-90-second halt-recovery runs (Success Metrics).
- `status` -- Lifecycle: `running` on insert, updated to `completed`, `failed`, or `halted_for_human`. `halted_for_human` is set when any CRITICAL gap or HUMAN_GATE-band artifact is encountered in `--non-interactive` mode (F23/US-5).
- `artifacts_audited` -- Count of governance artifacts processed (max 9).
- `gaps_found_total`, `gaps_minor`, `gaps_major`, `gaps_critical` -- Gap counts by severity as defined in the Gap Severity Model.
- `gaps_auto_regenerated` -- Count of artifacts regenerated autonomously by RegenerationEngine (F22).
- `gaps_human_gated` -- Count of artifacts routed to HumanGateEvaluator (F23).
- `health_score_before` -- Mean of the nine artifacts' `composite_score` at audit start (US-7). `NULL` if audit failed before scoring.
- `health_score_after` -- Mean after regeneration completes. Used to verify `health_score_after > health_score_before` (US-4).
- `halt_point_reference` -- JSON TEXT blob, non-null only for `audit_trigger = 'halt_recovery'`. Shape: `{ "buildRunId": string, "featureBranch": string, "promptIndex": number, "promptName": string, "failingCheck": string, "subStepIndex": number|null, "subStepName": string|null }`. The `subStepIndex` field extends the shape documented in SCHEMA_ADDITIONS.md without adding a new column (Open Questions). All values come from Build Memory or the preserved branch -- never invented (R2).
- `continuation_plan` -- JSON TEXT blob. Ordered array of next-action objects consumed by the Phase 3 executor. First action always targets `promptIndex` from `halt_point_reference`, never index 1 (R7/US-2).
- `scan_report_path` -- Path to the `.forge/scan_report.json` written by `runScan` (US-6). Confirms R5 compliance -- a single shared scan output.
- `build_run_id` -- The build this audit is associated with (nullable; set for halt-recovery audits, may be null for governance-only audits).
- `phase_at_audit` -- Integer phase number (1-3) at the time of audit. If `phase_at_audit = 3`, RegenerationEngine refuses to write any file and records a Contract 3 / R3 refusal message.
- `resume_eligible` -- Boolean (0/1). Set to 1 only when `health_score_after >= 0.70` AND `gaps_critical = 0` (R8/US-8).
- `resume_blocked_reason` -- Plain-language explanation when `resume_eligible = 0` (US-8 reporting requirement).
- `error_message` -- Non-null only when `status = 'failed'`. Iron Law 3 -- records the real error, never a fabricated one.
- `duration_ms` -- Wall-clock milliseconds from audit start to final status write. Target < 90,000 for `TARGETED` halt-recovery audits (Success Metrics).
- `created_at`, `completed_at` -- ISO-8601 UTC timestamps.

---

### Table: `artifact_health_scores`

**Purpose.** One row per governance artifact per audit run. Produced by ArtifactHealthScorer after gap detection (F21). Persists all three component scores, the composite score, per-severity gap counts, drift metadata, and full regeneration lifecycle state including the human gate decision.

**Nine canonical artifact names** (enforced by CHECK constraint): `PRD`, `SCHEMA_REGISTRY`, `AGENTS`, `BEHAVIORAL_CONTRACTS`, `BLUEPRINT`, `TOOLCHAIN`, `SESSION_STATE`, `STATE_OF_THE_BUILD`, `TESTING`.

**Key columns:**

- `audit_run_id` -- Foreign key to `gap_audit_runs.id`, CASCADE on delete.
- `machine_id` -- Required on every insert (R6).
- `artifact_name` -- One of the nine canonical artifact names.
- `artifact_path` -- Absolute path to the doc on disk. Null when `exists_on_disk = 0`.
- `exists_on_disk` -- 0/1. When 0, the artifact is completely absent -- a CRITICAL gap (condition 2).
- `last_modified_days` -- Age in fractional days at audit time, sourced from `GovernanceDocEntry` in the ForgeRetrofit ScanReport. Feeds `freshness_score`.
- `completeness_score` -- [0.0, 1.0]. Fraction of required sections present, penalized by `placeholder_count`. Weight in composite: 0.40.
- `freshness_score` -- [0.0, 1.0]. Derived from `last_modified_days` and staleness vs. Build Memory last-completed-prompt timestamp. Weight: 0.30.
- `consistency_score` -- [0.0, 1.0]. Cross-document contradiction score; 1.0 = no contradictions, 0.0 = one or more CRITICAL contradictions detected. Weight: 0.30.
- `composite_score` -- Weighted sum: `0.40 * completeness_score + 0.30 * freshness_score + 0.30 * consistency_score`. Must equal the documented formula within ±0.001 (US-7).
- `gaps_minor`, `gaps_major`, `gaps_critical` -- Gap counts for this artifact.
- `missing_sections` -- JSON array of section name strings absent from the artifact. Used by RegenerationEngine in SECTION_SCOPED mode and surfaced in US-3 acceptance criteria.
- `placeholder_count` -- Integer count of `TBD`/`TODO`/`{{...}}` occurrences in the raw artifact text (US-3).
- `drift_detected` -- 1 when any drift entry exists (US-3). Specifically, set to 1 when a table appears in `ScanReport.schemaAudit` but is absent from `SCHEMA_REGISTRY.md`.
- `drift_detail` -- JSON array of drift entry objects, each with `{ type, description, severity }`. Feeds CRITICAL condition 1 and 3 detection.
- `regeneration_tier` -- `NONE` (no action), `AUTO` (RegenerationEngine acts autonomously), or `HUMAN_GATE` (HumanGateEvaluator required). HUMAN_GATE is set when `gaps_critical > 0` OR `composite_score` is in the HUMAN_GATE band AND no CRITICAL gap is absent. MINOR-only artifacts always resolve to AUTO, never HUMAN_GATE (US-7 human intervention rate metric).
- `regeneration_mode` -- `FULL_FILE` (SESSION_STATE, STATE_OF_THE_BUILD, TOOLCHAIN) or `SECTION_SCOPED` (all others). NULL when `regeneration_tier = 'NONE'`.
- `health_score_before` -- Snapshot of `composite_score` before regeneration. Equal to `composite_score` at row creation.
- `health_score_after` -- Updated after RegenerationEngine completes. Must be strictly greater than `health_score_before` for any row where regeneration ran (US-4).
- `regenerated_at` -- ISO-8601 UTC timestamp of RegenerationEngine write. NULL if not regenerated.
- `gate_status` -- `pending` when routed to HumanGateEvaluator; `approved`/`declined` after interactive resolution; `deferred` in `--non-interactive` mode (US-5). NULL when `regeneration_tier != 'HUMAN_GATE'`.
- `gate_presented_at`, `gate_resolved_at` -- Timestamps bracketing human gate interaction.
- `gate_prompt_text` -- Plain-language gate prompt shown to the operator: artifact name, specific gap description, and what regeneration would change (US-5 acceptance criteria).
- `created_at` -- ISO-8601 UTC timestamp.

---

### Composite Score Formula

```
composite_score = (0.40 × completeness_score)
               + (0.30 × freshness_score)
               + (0.30 × consistency_score)
```

All three component scores are in [0.0, 1.0]. The computed value must match within ±0.001 (US-7). ArtifactHealthScorer writes both the components and the composite; no downstream consumer recomputes it.

---

### Regeneration Tier Decision Table

| gaps_critical | composite_score band | regeneration_tier |
|---|---|---|
| > 0 | any | HUMAN_GATE |
| 0 | < 0.50 (HUMAN_GATE band) | HUMAN_GATE |
| 0 | 0.50-0.79 (AUTO band) | AUTO |
| 0 | ≥ 0.80 | NONE (healthy, no action) |

MINOR-only artifacts are always AUTO regardless of band, provided `gaps_critical = 0`.

---

### Resume Eligibility Gate (R8)

`gap_audit_runs.resume_eligible` is set to 1 if and only if:
- `AVG(artifact_health_scores.composite_score) >= 0.70` across all nine artifacts for the run, AND
- `gap_audit_runs.gaps_critical = 0`

`forge resurrect --resume` reads this column before handing off to the Phase 3 executor. If `resume_eligible = 0`, the command reports `resume_blocked_reason` and exits without executing any prompt.

---

### Halt-Point Reference JSON Shape

For `audit_trigger = 'halt_recovery'`, `halt_point_reference` stores:

```json
{
  "buildRunId": "3736ff33-7ca2-4595-b304-b47badf28ac6",
  "featureBranch": "forge/3736ff33-.../prompt-5-ui-shell-layouts-design-tokens",
  "promptIndex": 5,
  "promptName": "ui-shell",
  "failingCheck": "file_delta",
  "subStepIndex": 1,
  "subStepName": "Ground the design in the subject matter"
}
```

All values sourced from Build Memory or the preserved feature branch (R2). Any value not recoverable is stored as `null`, not fabricated.

---

### Indexes

| Index | Table | Columns | Unique | Notes |
|---|---|---|---|---|
| idx_gap_audit_runs_machine_id | gap_audit_runs | machine_id | No | Multi-machine reporting |
| idx_gap_audit_runs_build_run_id | gap_audit_runs | build_run_id | No | Partial WHERE build_run_id IS NOT NULL |
| idx_gap_audit_runs_project_path | gap_audit_runs | project_path | No | Per-project history |
| idx_gap_audit_runs_status | gap_audit_runs | status | No | Pending/halted queries |
| idx_gap_audit_runs_audit_trigger | gap_audit_runs | audit_trigger | No | halt_recovery filter |
| idx_gap_audit_runs_created_at | gap_audit_runs | created_at | No | Chronological ordering |
| idx_artifact_health_scores_audit_run_id | artifact_health_scores | audit_run_id | No | Join with parent |
| idx_artifact_health_scores_machine_id | artifact_health_scores | machine_id | No | R6 compliance queries |
| idx_artifact_health_scores_artifact_name | artifact_health_scores | artifact_name | No | Per-artifact history |
| idx_artifact_health_scores_run_artifact | artifact_health_scores | (audit_run_id, artifact_name) | **Yes** | Enforces one row per artifact per run |
| idx_artifact_health_scores_regeneration_tier | artifact_health_scores | regeneration_tier | No | AUTO/HUMAN_GATE queue |
| idx_artifact_health_scores_drift_detected | artifact_health_scores | drift_detected | No | Partial WHERE drift_detected = 1 |
| idx_artifact_health_scores_composite_score | artifact_health_scores | composite_score | No | Floor enforcement queries |

---

### Migrations

| File | Description |
|---|---|
| `001_create_gap_audit_runs.sql` | Creates `gap_audit_runs` with all columns, CHECK constraints, and defaults. Bumps schema version to 2.3.0. |
| `002_create_artifact_health_scores.sql` | Creates `artifact_health_scores` with all columns, CHECK constraints, UNIQUE (audit_run_id, artifact_name), and FK to gap_audit_runs CASCADE. |
| `003_create_indexes.sql` | Creates all 13 indexes listed above. |

All migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). Migrations run at `forge` CLI startup against `~/.forge/forge_memory.db` via ForgeLearning's existing migration runner.

---

### Non-Goals Enforced by Schema

- No `company_id`, `tenant_id`, or organization column exists on any table (single-operator, single-tenant per PRD).
- No Supabase RLS policies -- this is a local SQLite file, not hosted Postgres.
- No `user_id` or auth column -- filesystem permissions on `~/.forge/forge_memory.db` are the access control boundary.

---

# API Architecture -- System 1: Resurrection and Gap Intelligence Engine

## Overview

System 1 exposes seven HTTP API routes implemented as Next.js 14 App Router Route Handlers. All routes are authenticated via Supabase Auth server-side session. The underlying data store for audit and health records is the **Build Memory SQLite file** at `~/.forge/forge_memory.db` (accessed via `ForgeLearning/database.ts`), not Supabase Postgres. This is a single-operator, single-machine system -- no multi-tenancy, no `company_id`, no RLS.

Every database write includes `machine_id`, derived server-side from the host environment and never accepted from the client.

---

## Route Reference

### `POST /api/audit/run`
**Purpose:** Initiate a full deep governance audit.

**Auth:** Required (`operator` role)

**Request body:**
```typescript
{
  projectPath: string;          // Absolute path to the project on disk
  auditScope: 'FULL' | 'TARGETED' | 'CODE_ONLY';
  auditTrigger: 'manual' | 'halt_recovery' | 'pre_resume' | 'scheduled';
  haltRecovery?: { buildRunId: string }; // Required when auditTrigger === 'halt_recovery'
  nonInteractive: boolean;      // If true, CRITICAL gaps defer rather than prompt
}
```

**Response (202 Accepted):**
```typescript
{
  auditRunId: string;
  status: 'running';
  healthScoreBefore: number | null;
  healthScoreAfter: number | null;
  artifactsAudited: number;
  gapsFoundTotal: number;
  gapsMinor: number;
  gapsMajor: number;
  gapsCritical: number;
  gapsAutoRegenerated: number;
  gapsHumanGated: number;
  haltPointReference: HaltPointReference | null;
  continuationPlan: ContinuationPlan | null;
  artifactScores: ArtifactScoreSummary[];
  durationMs: number;
}
```

**Behavior:**
1. Validates `projectPath` is readable on disk.
2. Checks for an existing `running` row in `gap_audit_runs` for this `projectPath` + `machine_id`; returns `409 AUDIT_ALREADY_RUNNING` if found.
3. Inserts a `gap_audit_runs` row with `status = 'running'`.
4. Launches the GapAuditor pipeline asynchronously (HTTP responds immediately with `status: 'running'` and `auditRunId`).
5. **GapAuditor pipeline steps:**
   - Calls `runScan` (14 SCAN ops -> `ScanReport`) -- no new filesystem-walk code (R5).
   - Calls `generateArchitectureHealthReport`, `buildGovernanceReconciliationReport`, `buildEnterprisePatternsGapReport`.
   - Runs F1.2 content-level gap detection on all nine governance artifacts.
   - Scores each artifact (completeness × 0.5 + freshness × 0.25 + consistency × 0.25) and inserts `artifact_health_scores` rows.
   - For `halt_recovery` trigger: reconstructs the five halt-point facts from Build Memory and the preserved feature branch; populates `halt_point_reference` JSON (R2 -- null for unknown facts, never fabricated).
   - Checks Phase 3 status before any regeneration; refuses with `422 PHASE3_ACTIVE_REGENERATION_REFUSED` if active (R3).
   - Runs `RegenerationEngine` for all `AUTO`-tier artifacts with no CRITICAL gap.
   - Routes CRITICAL and HUMAN_GATE-tier artifacts to `HumanGateEvaluator`.
   - In `nonInteractive = true` mode, CRITICAL gaps are deferred and `status` becomes `halted_for_human`.
   - Updates `gap_audit_runs` row to `completed`, `failed`, or `halted_for_human`.
6. All `artifact_health_scores` rows carry `machine_id`.

**DB Reads:** `gap_audit_runs`, `artifact_health_scores`
**DB Writes:** `gap_audit_runs`, `artifact_health_scores`

**Errors:**
| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_PROJECT_PATH` | projectPath does not exist or is not readable |
| 400 | `INVALID_AUDIT_SCOPE` | auditScope not in allowed enum |
| 400 | `HALT_RECOVERY_MISSING_BUILD_ID` | auditTrigger is halt_recovery but buildRunId absent |
| 409 | `AUDIT_ALREADY_RUNNING` | Running audit exists for this path + machine_id |
| 422 | `PHASE3_ACTIVE_REGENERATION_REFUSED` | Project is in Phase 3; regeneration refused |
| 500 | `SCAN_PIPELINE_FAILED` | ForgeRetrofit runScan returned fatal error |

---

### `GET /api/audit/run/:auditRunId`
**Purpose:** Retrieve the full result of a completed or in-progress audit run.

**Auth:** Required (`operator` role)

**Path params:** `auditRunId: string`

**Response (200 OK):** Full `gap_audit_runs` row plus all associated `artifact_health_scores` rows.

**DB Reads:** `gap_audit_runs`, `artifact_health_scores`

**Errors:**
| Status | Code | Description |
|--------|------|-------------|
| 404 | `AUDIT_RUN_NOT_FOUND` | No row for auditRunId |
| 403 | `MACHINE_ID_MISMATCH` | machine_id on row does not match request |

---

### `GET /api/audit/runs`
**Purpose:** List audit runs for this machine with optional filters and pagination.

**Auth:** Required (`operator` role)

**Query params:**
```
projectPath?: string
status?: 'running' | 'completed' | 'failed' | 'halted_for_human'
auditTrigger?: string
limit?: number   (default 20, max 100)
offset?: number  (default 0)
```

**Response (200 OK):**
```typescript
{
  total: number;
  limit: number;
  offset: number;
  runs: AuditRunSummary[];
}
```

**DB Reads:** `gap_audit_runs`

**Errors:**
| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_STATUS_FILTER` | status not in allowed enum |
| 400 | `INVALID_PAGINATION` | limit or offset out of range |

---

### `POST /api/audit/run/:auditRunId/gate`
**Purpose:** Submit a human gate decision (approve/decline) for a CRITICAL or HUMAN_GATE-tier artifact gap. Non-bypassable -- no flag or env var can skip this for CRITICAL gaps (F23, R4).

**Auth:** Required (`operator` role)

**Request body:**
```typescript
{
  artifactHealthScoreId: string;
  decision: 'approve' | 'decline';
  operatorNote?: string;
}
```

**Response (200 OK):**
```typescript
{
  artifactHealthScoreId: string;
  artifactName: string;
  decision: 'approve' | 'decline';
  regenerationTriggered: boolean;
  healthScoreAfter: number | null;
  auditStatus: 'halted_for_human' | 'completed';
  remainingGatedItems: number;
}
```

**Behavior:**
- `approve`: triggers `RegenerationEngine` for that artifact (unless Phase 3 is active -> `422`).
- `decline`: records declination, artifact remains as-is.
- If `remainingGatedItems === 0` after this decision, `gap_audit_runs.status` transitions to `completed`.
- Gate is **structural and non-configurable** -- no environment variable or request flag bypasses it.

**DB Reads:** `gap_audit_runs`, `artifact_health_scores`
**DB Writes:** `gap_audit_runs`, `artifact_health_scores`

**Errors:**
| Status | Code | Description |
|--------|------|-------------|
| 404 | `ARTIFACT_SCORE_NOT_FOUND` | No artifact_health_scores row for artifactHealthScoreId |
| 409 | `GATE_ALREADY_DECIDED` | Gate decision already recorded for this artifact in this run |
| 409 | `AUDIT_NOT_HALTED_FOR_HUMAN` | Parent audit is not in halted_for_human status |
| 422 | `PHASE3_ACTIVE_REGENERATION_REFUSED` | Phase 3 active; regeneration blocked even after approval |
| 403 | `MACHINE_ID_MISMATCH` | machine_id mismatch |

---

### `POST /api/resurrect/resume`
**Purpose:** Initiate a build resumption from the halt point identified in a completed audit run. Enforces the health floor gate (R8): mean `composite_score >= 0.70` AND `gaps_critical = 0` are required or resumption is refused.

**Auth:** Required (`operator` role)

**Request body:**
```typescript
{
  auditRunId: string;
  buildRunId: string;
  dryRun?: boolean; // default false -- if true, validates and returns plan without executing
}
```

**Response (200 OK):**
```typescript
{
  resumable: boolean;
  refusalReasons: string[];         // Empty when resumable === true
  buildRunId: string;
  featureBranch: string | null;
  startAtPromptIndex: number | null;
  promptName: string | null;
  failingCheck: string | null;
  subStepIndex: number | null;
  continuationPlan: ContinuationPlan | null;
  skippedPromptIndices: number[];   // Prompts marked completed in Build Memory
  meanCompositeScore: number;
  gapsCritical: number;
}
```

**Behavior:**
1. Loads `gap_audit_runs` row for `auditRunId`; requires `status = 'completed'`.
2. Computes mean `composite_score` from associated `artifact_health_scores`.
3. Checks `gaps_critical = 0` from the `gap_audit_runs` row.
4. If either floor is not met: `resumable = false`, populates `refusalReasons`, returns `422 HEALTH_FLOOR_NOT_MET`.
5. Reads `halt_point_reference` JSON; if null or build has no completed prompts in Build Memory: returns `422 NO_RESUMABLE_STATE`.
6. Identifies all prompts for the build already marked `completed` in Build Memory -> `skippedPromptIndices`.
7. Sets `startAtPromptIndex` to `halt_point_reference.promptIndex`.
8. Hands the resume payload to the Phase 3 executor (the executor will receive `--start-at = startAtPromptIndex`).
9. Records `resumeInitiatedAt` timestamp in the `gap_audit_runs` row (no new row created).

**DB Reads:** `gap_audit_runs`, `artifact_health_scores`
**DB Writes:** `gap_audit_runs`

**Errors:**
| Status | Code | Description |
|--------|------|-------------|
| 404 | `AUDIT_RUN_NOT_FOUND` | No gap_audit_runs row for auditRunId |
| 404 | `BUILD_RUN_NOT_FOUND` | No Build Memory record for buildRunId |
| 409 | `AUDIT_NOT_COMPLETED` | Audit not in completed status |
| 422 | `HEALTH_FLOOR_NOT_MET` | mean composite_score < 0.70 or gaps_critical > 0 |
| 422 | `NO_RESUMABLE_STATE` | halt_point_reference null or no completed prompts; use forge resurrect (F10) |
| 403 | `MACHINE_ID_MISMATCH` | machine_id mismatch |

---

### `GET /api/health/governance`
**Purpose:** Return current governance health summary for a project -- latest artifact scores, mean composite score, gap counts, table row counts. Powers `forge health` CLI reporting (US-7).

**Auth:** Required (`operator` role)

**Query params:**
```
projectPath: string  (required)
buildRunId?: string
```

**Response (200 OK):**
```typescript
{
  projectPath: string;
  latestAuditRunId: string | null;
  latestAuditStatus: string | null;
  meanCompositeScore: number | null;
  gapsCritical: number;
  gapsHumanGated: number;
  gapsAutoRegenerated: number;
  resumable: boolean;   // true iff meanCompositeScore >= 0.70 && gapsCritical === 0
  artifactScores: ArtifactHealthSummary[];
  tableCounts: { gap_audit_runs: number; artifact_health_scores: number };
}
```

**DB Reads:** `gap_audit_runs`, `artifact_health_scores`

**Errors:**
| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_PROJECT_PATH` | projectPath missing or empty |
| 404 | `NO_AUDIT_HISTORY` | No gap_audit_runs rows for this path + machine_id |

---

### `GET /api/audit/artifact-scores`
**Purpose:** Query `artifact_health_scores` rows across audit runs for metric reporting (US-7 success metrics table).

**Auth:** Required (`operator` role)

**Query params:**
```
auditRunId?: string
projectPath?: string
artifactName?: string
regenerationTier?: 'AUTO' | 'HUMAN_GATE' | 'NONE'
limit?: number  (default 50, max 200)
offset?: number (default 0)
```

**Note:** At least one of `auditRunId` or `projectPath` must be provided.

**Response (200 OK):**
```typescript
{
  total: number;
  limit: number;
  offset: number;
  scores: ArtifactHealthScore[];
}
```

**DB Reads:** `artifact_health_scores`, `gap_audit_runs`

**Errors:**
| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REGENERATION_TIER_FILTER` | regenerationTier not in allowed enum |
| 400 | `MISSING_FILTER` | Neither auditRunId nor projectPath provided |
| 400 | `INVALID_PAGINATION` | limit or offset out of range |

---

## Shared Types

Defined in `src/types/resurrection.ts`:

```typescript
interface HaltPointReference {
  buildRunId: string;
  featureBranch: string | null;
  promptIndex: number | null;
  promptName: string | null;
  failingCheck: string | null;
  subStepIndex: number | null;
  subStepName: string | null;
}

interface ContinuationPlan {
  startAtPromptIndex: number;
  actions: {
    order: number;
    type: string;
    description: string;
    promptIndex: number | null;
  }[];
}

interface ArtifactScoreSummary {
  artifactName: string;
  compositeScore: number;
  regenerationTier: 'AUTO' | 'HUMAN_GATE' | 'NONE';
  gapSeverities: ('MINOR' | 'MAJOR' | 'CRITICAL')[];
}

interface ArtifactHealthScore {
  artifactHealthScoreId: string;
  auditRunId: string;
  artifactName: string;
  existsOnDisk: boolean;
  completenessScore: number;
  freshnessScore: number;
  consistencyScore: number;
  compositeScore: number;   // = completenessScore*0.5 + freshnessScore*0.25 + consistencyScore*0.25
  missingSections: string[];
  placeholderCount: number;
  driftDetected: boolean;
  driftDetail: string | null;
  regenerationTier: 'AUTO' | 'HUMAN_GATE' | 'NONE';
  healthScoreBefore: number | null;
  healthScoreAfter: number | null;
  machineId: string;
  createdAt: string;
}
```

---

## Key Invariants

| Invariant | Enforcement |
|-----------|-------------|
| `machine_id` on every DB write | Server-side derivation in all route handlers; never client-supplied |
| No CRITICAL gap auto-regenerated | `RegenerationEngine` checks `gapSeverities` before writing; CRITICAL -> `HumanGateEvaluator` (R4) |
| No regeneration during Phase 3 | Phase 3 check runs before every `RegenerationEngine` invocation (R3) |
| No new filesystem scanning | All codebase facts come from `runScan`/`ScanReport` (R5) |
| Health floor enforced in code | `POST /api/resurrect/resume` refuses if `meanCompositeScore < 0.70` or `gaps_critical > 0` (R8) |
| Halt facts never fabricated | Unknown facts stored `null`; no invented values (R2) |
| Gate non-bypassable | `POST /api/audit/run/:auditRunId/gate` has no skip flag; no env var overrides it (F23) |
| No company_id / tenant_id | No column, no filter, no RLS -- single-operator system |
| `composite_score` formula | `cs*0.5 + fs*0.25 + consistency*0.25`, ±0.001 tolerance, computed server-side before insert |
| `health_score_before` | Arithmetic mean of nine artifacts' `composite_score` at audit start (null if no prior data) |

---

# Frontend Architecture -- forge-2 Resurrection and Gap Intelligence Engine

## Overview

The forge-2 frontend is a Next.js 14 App Router application that provides a single-operator web dashboard for the Resurrection and Gap Intelligence Engine. It surfaces governance health scores, audit run history, human gate decisions, and build resumption controls. The UI is strictly read-display-and-act: it never duplicates server-side scanning logic, and all codebase facts are fetched from the API layer which wraps the ForgeRetrofit/Build Memory backend.

---

## Layout System

### AppShellLayout
Applied to all pages except the human gate. Renders:
- **TopBar** (64px sticky, full width): forge-2 wordmark + gate alert badge
- **NavigationSidebar** (240px fixed, collapses to 56px icon-only on mobile): primary nav links + machine_id display
- **Main content area** (flex-1, 24px side padding, max-width 1280px centered)

Background: `#F8FAFC` (`--color-background`).

### GateFocusLayout
Applied exclusively to `/gate/:auditRunId`. Removes the NavigationSidebar and centers gate decision content (max-width 600px) vertically and horizontally. Designed to minimize distraction during architectural gate decisions, consistent with F23's non-bypassable gate requirement.

---

## Pages

### `/` -- DashboardPage
**Purpose:** Primary governance health overview and entry point for all actions.

**Key sections:**
1. `OpenGatesAlert` -- amber banner when any audit has `status = 'halted_for_human'`
2. `GovernanceHealthBanner` -- mean `composite_score` with color-coded bar and resume-safe indicator
3. `QuickActionPanel` -- Run New Audit / Resume Build / Review Gates action cards
4. `ArtifactHealthGrid` -- 3-column grid of per-artifact health cards
5. `RecentAuditRunsTable` -- last 5 audit runs

**Empty state:** `EmptyAuditState` when no audits exist.

**API calls:** `GET /api/health/governance`, `GET /api/audit/runs`, `GET /api/audit/artifact-scores`

---

### `/audit/new` -- NewAuditPage
**Purpose:** Configure and launch a gap audit run.

**Form fields:**
- `project_path` (text input, required)
- `audit_scope` (radio: FULL / CODE_ONLY / GOVERNANCE_ONLY / TARGETED)
- `halt_recovery` (checkbox; forces scope to TARGETED when enabled; reveals optional `build_run_id` input)

**Behavior:** On submit, POSTs to `POST /api/audit/run` and redirects to `/audit/runs/:auditRunId` on success. Displays `FormValidationSummary` for client-side errors. `AuditSubmitButton` shows loading spinner during in-flight request.

**API calls:** `POST /api/audit/run`

---

### `/audit/runs` -- AuditRunsListPage
**Purpose:** Paginated history of all `gap_audit_runs` records.

**Table columns:** Audit ID, Trigger badge, Status badge, Score Before, Score After, Gaps (minor/major/critical chips), Duration, Created At.

**Filters:** Status multi-select, Trigger select, Date range picker.

**Empty state:** `EmptyAuditRunsState` (message adapts to active filters).

**API calls:** `GET /api/audit/runs`

---

### `/audit/runs/:auditRunId` -- AuditRunDetailPage
**Purpose:** Full detail for a single audit run including artifact scores, gaps, halt point, continuation plan, and gate actions.

**Key sections:**
1. `AuditRunHeader` -- run ID, status, trigger, duration, machine_id
2. `GapSeverityBreakdown` -- minor/major/critical/auto-regenerated/human-gated stats
3. `ArtifactHealthScoresTable` -- all nine artifact rows; rows below 0.70 amber-highlighted
4. `HaltPointCard` -- rendered when `halt_point_reference` is non-null; shows all 5 halt facts + feature branch
5. `ContinuationPlanPanel` -- ordered next-action steps from `continuation_plan`
6. `RegenerationLogAccordion` -- list of auto-regenerated artifacts with before/after score delta
7. `HumanGateReviewPanel` -- list of gated items with Approve/Decline/Defer controls

**Empty state:** `EmptyGapsState` when `gaps_found_total = 0`.

**API calls:** `GET /api/audit/run/:auditRunId`, `GET /api/audit/artifact-scores`, `POST /api/audit/run/:auditRunId/gate`

---

### `/resurrect` -- ResurrectPage
**Purpose:** Operator-facing build resumption interface.

**Key sections:**
1. `HaltPointSummaryCard` -- resolved halt point (buildRunId, promptIndex, promptName, failingCheck, subStepIndex, feature branch)
2. `HealthFloorCheckPanel` -- two pass/fail checks: mean composite_score >= 0.70, gaps_critical = 0
3. `ResumeBuildButton` -- enabled only when both floor checks pass; calls `POST /api/resurrect/resume`
4. `ResumptionRefusalAlert` -- shown when floor not met; lists failing artifacts and open gates

**Empty state:** `EmptyResurrectState` when no halted build found in Build Memory.

**API calls:** `GET /api/health/governance`, `GET /api/audit/runs`, `POST /api/resurrect/resume`

---

### `/health` -- GovernanceHealthPage
**Purpose:** Detailed per-artifact governance health breakdown.

**Key sections:**
1. `ArtifactHealthGrid` -- visual gauge cards for all nine artifacts
2. `ArtifactScoresDetailTable` -- sortable table with completeness/freshness/consistency/composite columns
3. `HealthFloorIndicator` -- global pass/fail for the 0.70 floor
4. Per-artifact `ArtifactDriftDetail`, `MissingSectionsList`, `PlaceholderCountBadge`

**Empty state:** `EmptyHealthState` when no scores exist.

**API calls:** `GET /api/health/governance`, `GET /api/audit/artifact-scores`

---

### `/gate/:auditRunId` -- HumanGatePage
**Purpose:** Focused, distraction-free interface for structural gate decisions (F23). Uses `GateFocusLayout`.

**Key sections:**
1. `GateProgressIndicator` -- 'Gate X of N'
2. `GateDecisionCard` -- artifact name, gap description (plain language), severity label
3. `GapPlainLanguageSummary` -- non-technical explanation of the gap
4. `RegenerationImpactPreview` -- collapsible diff of what regeneration would change
5. `ApproveDeclineActions` -- Approve (primary), Decline (secondary), DeferGateButton (tertiary)

**Gate rules enforced in UI:**
- Gate cannot be bypassed by any flag or env var (the Approve/Decline buttons are the only path forward)
- In non-interactive/API mode, deferred items set audit status to `halted_for_human`
- CRITICAL gaps always route here regardless of composite_score

**API calls:** `GET /api/audit/run/:auditRunId`, `POST /api/audit/run/:auditRunId/gate`

---

## Component Inventory

### Navigation
- `NavigationSidebar` -- fixed left nav with collapse behavior
- `TopBar` -- sticky header with wordmark and gate badge
- `PaginationControls` -- page navigation for tables

### Display / Data
- `GovernanceHealthBanner` -- mean score + resume-safe status
- `AuditRunHeader` -- audit run metadata header
- `AuditStatusBadge` -- colored status pill (running/completed/failed/halted_for_human)
- `ArtifactHealthGrid` -- responsive grid of ArtifactHealthCard
- `ArtifactHealthCard` -- per-artifact summary card
- `ScoreGauge` -- SVG arc gauge for 0.00-1.00 scores
- `ArtifactHealthScoresTable` -- nine-row artifact detail table
- `GapSeverityBreakdown` -- minor/major/critical stat panel
- `HaltPointCard` -- five halt facts + feature branch display
- `HaltPointSummaryCard` -- compact halt point on Resurrect page
- `ContinuationPlanPanel` -- ordered resumption steps accordion
- `RegenerationLogAccordion` -- auto-regen log with score deltas
- `ArtifactDriftDetail` -- expandable drift items list
- `MissingSectionsList` -- required sections present/absent list
- `PlaceholderCountBadge` -- TBD/TODO count pill
- `BranchNameDisplay` -- monospace branch name with copy
- `PromptIndexIndicator` -- large prompt index badge
- `FailingCheckDetail` -- check name chip + sub-step info
- `ArtifactSeverityLabel` -- MINOR/MAJOR/CRITICAL label with icon
- `GateProgressIndicator` -- gate step dots
- `GapPlainLanguageSummary` -- plain-language gap prose
- `RegenerationImpactPreview` -- collapsible diff preview
- `HealthFloorCheckPanel` -- two pass/fail floor checks
- `OpenGatesAlert` -- amber banner for open gates

### Interactive
- `QuickActionPanel` -- dashboard action cards
- `ResumeBuildButton` -- health-floor-gated resume CTA
- `HumanGateReviewPanel` -- inline gate actions on audit detail
- `GateDecisionCard` -- full gate decision card
- `ApproveDeclineActions` -- Approve/Decline/Defer button row
- `DeferGateButton` -- tertiary defer action

### Forms
- `AuditConfigForm` -- new audit configuration form
- `ScopeSelector` -- audit scope radio group
- `HaltRecoveryToggle` -- halt recovery checkbox with build_run_id reveal
- `AuditRunFilterBar` -- status/trigger/date filters for runs list
- `FormValidationSummary` -- validation error list
- `AuditSubmitButton` -- submit with loading state

### Empty States
- `EmptyAuditState` -- dashboard, no audits
- `EmptyAuditRunsState` -- runs list, no records
- `EmptyGapsState` -- audit detail, no gaps
- `EmptyResurrectState` -- resurrect page, no halted build
- `EmptyHealthState` -- health page, no scores
- `ResumptionRefusalAlert` -- resume blocked alert

---

## Design Token Application

| Token | Value | Primary Usage |
|---|---|---|
| `--color-primary` | `#2563EB` | Links, active nav, primary buttons (non-CTA), score gauges (safe) |
| `--color-secondary` | `#3B82F6` | Secondary accents, hover states |
| `--color-cta` | `#F97316` | Primary action buttons, critical/blocked states |
| `--color-background` | `#F8FAFC` | Page background, card backgrounds |
| `--color-text` | `#1E293B` | All body text |
| `--color-success` | `#16A34A` | Score gauge fill >= 0.70, pass indicators |
| `--color-warning` | `#D97706` | Score gauge fill 0.50-0.69, MAJOR gap labels, amber alerts |
| `--color-danger` | `#DC2626` | Score gauge fill < 0.50, CRITICAL gap labels, refusal alerts |
| `--color-muted` | `#64748B` | Secondary labels, timestamps, machine_id display |
| `--color-border` | `#E2E8F0` | Input borders, table dividers |
| `--color-code-bg` | `#F1F5F9` | Monospace code blocks, branch name display |

All interactive elements carry `cursor: pointer`. All transitions are 200ms ease. Focus states use `box-shadow: 0 0 0 3px #2563EB20`. `prefers-reduced-motion` disables all transforms and transitions.

---

## Responsive Strategy

Mobile-first. Tailwind CSS breakpoints:
- **Default (320px+):** Single-column layout, sidebar as bottom sheet
- **sm (640px+):** Sidebar drawer, 1-column grid
- **md (768px+):** NavigationSidebar visible (collapsed, 56px), 2-column grid
- **lg (1024px+):** NavigationSidebar expanded (240px), 3-column grid
- **xl (1280px+):** Max content width 1280px centered

All tables horizontally scrollable on mobile. Minimum tap target 44×44px. No horizontal scroll at any breakpoint. Tested at 375px, 768px, 1024px, 1440px.

---

## Anti-Patterns (Enforced)

- No emojis as icons -- Lucide React SVG icons exclusively
- No hidden filters -- all filter controls visible
- `cursor: pointer` on all clickable elements
- No layout-shifting hovers (translateY(-2px) max, no scale)
- 4.5:1 minimum contrast ratio on all text
- All state changes use 150-300ms transitions
- Visible focus states on all interactive elements
- `prefers-reduced-motion` respected globally

---

## API Route Mapping

| Page / Action | API Route |
|---|---|
| Dashboard health banner | `GET /api/health/governance` |
| Dashboard recent runs | `GET /api/audit/runs` |
| Dashboard artifact grid | `GET /api/audit/artifact-scores` |
| Run new audit | `POST /api/audit/run` |
| Audit runs list | `GET /api/audit/runs` |
| Audit run detail | `GET /api/audit/run/:auditRunId` |
| Artifact scores for run | `GET /api/audit/artifact-scores` |
| Gate approve/decline/defer | `POST /api/audit/run/:auditRunId/gate` |
| Resume build | `POST /api/resurrect/resume` |
| Governance health page | `GET /api/health/governance` |
| Health artifact scores | `GET /api/audit/artifact-scores` |

---

# Interaction Maps -- forge-2 Resurrection and Gap Intelligence Engine

## Overview

This document specifies every interactive element across all pages and features of the forge-2 application. Each map describes a single user action, the frontend reaction, the API call (if any), backend processing, database write, side effects, and success/error handling. All UI conforms to the forge-2 design system: Inter font, `#2563EB` primary, `#F97316` CTA/accent, `#F8FAFC` background, `#1E293B` text, 8px border-radius on inputs, 12px on cards, 200ms transitions, Lucide/Heroicons SVG icons only.

---

## Feature F20: Deep Codebase Audit

### Pages: `/audit/new`, `/audit/runs`, `/audit/runs/:auditRunId`, `/` (homepage widget)

#### IM-F20-01: Navigate to New Audit
- **Element:** 'New Audit' navbar button
- **User Action:** Click
- **Frontend:** Router -> `/audit/new`; form renders empty
- **API:** none
- **DB Write:** none
- **Event:** `nav_audit_new_clicked`

#### IM-F20-02: Project Path Input
- **Element:** `<input type="text">` for absolute filesystem path
- **User Action:** Type/paste path
- **Frontend:** Real-time validation; green checkmark if starts with `/`; amber warning if relative
- **API:** none
- **DB Write:** none
- **Event:** `audit_path_input_changed`

#### IM-F20-03: Audit Scope Selector
- **Element:** `<select>` -- FULL | GOVERNANCE_ONLY | CODE_ONLY | TARGETED
- **User Action:** Select option
- **Frontend:** Shows/hides conditional fields (TARGETED -> artifact multi-select; GOVERNANCE_ONLY -> hides halt-recovery option)
- **API:** none
- **DB Write:** none
- **Event:** `audit_scope_selected`

#### IM-F20-04: Audit Trigger Type Selector
- **Element:** `<select>` -- manual | halt_recovery | scheduled | pre_resume
- **User Action:** Select option
- **Frontend:** Shows Build Run ID input when `halt_recovery` selected
- **API:** none
- **DB Write:** none
- **Event:** `audit_trigger_type_selected`

#### IM-F20-05: Build Run ID Input (halt_recovery mode)
- **Element:** `<input type="text">` visible only when trigger=halt_recovery
- **User Action:** Type/paste UUID
- **Frontend:** UUID regex validation inline; green/red indicator
- **API:** none
- **DB Write:** none
- **Event:** `audit_build_run_id_entered`

#### IM-F20-06: Non-Interactive Mode Toggle
- **Element:** Toggle switch
- **User Action:** Toggle on/off
- **Frontend:** Shows/hides notice banner about deferral behavior
- **API:** none
- **DB Write:** none
- **Event:** `audit_non_interactive_toggled`

#### IM-F20-07: Run Audit Submit
- **Element:** Primary CTA button 'Run Audit' (`.btn-primary`, `#F97316`)
- **User Action:** Click
- **Frontend:** Loading spinner; form disabled; optimistic 'Audit starting...' card; redirect to `/audit/runs/:auditRunId`
- **API:** `POST /api/audit/run`
- **Backend:** Insert `gap_audit_runs` row (status=running, machine_id, created_at); dispatch async audit job (runScan -> DIAGNOSE -> GapAuditor); return `auditRunId` immediately
- **DB Write:** `gap_audit_runs`
- **Side Effects:** Async audit job queued; if halt_recovery, Build Memory queried
- **Success:** HTTP 202 `{auditRunId, status:'running', createdAt}`
- **Error:** HTTP 400/422/500 -> toast error; form re-enabled
- **Event:** `audit_run_submitted`

#### IM-F20-08: Audit Status Auto-Poll
- **Element:** Auto-refresh on `/audit/runs/:auditRunId` while status=running
- **User Action:** Page auto-polls every 3 seconds
- **Frontend:** Progress bar advances (scan 0-40%, diagnose 40-70%, gap-detect 70-90%, score 90-100%); status badge; artifacts_audited counter updates
- **API:** `GET /api/audit/run/:auditRunId`
- **Backend:** Read `gap_audit_runs` row; return current status, progress, partial scores
- **DB Write:** none
- **Success:** HTTP 200 audit status object; UI updates
- **Error:** HTTP 404 -> polling stops; error banner
- **Event:** `audit_status_polled`

#### IM-F20-09: Audit Detail Page -- Summary Card
- **Element:** Summary card on `/audit/runs/:auditRunId`
- **User Action:** View completed audit
- **Frontend:** Composite health score gauge, gap counts (total/minor/major/critical), auto-regenerated count, human-gated count, duration, trigger badge, status badge
- **API:** `GET /api/audit/run/:auditRunId`
- **Backend:** JOIN `gap_audit_runs` + `artifact_health_scores`; return full detail
- **DB Write:** none
- **Event:** `audit_detail_page_viewed`

#### IM-F20-10: Audit Runs List Table
- **Element:** Table on `/audit/runs`
- **User Action:** View list
- **Frontend:** Rows: auditRunId, path, trigger badge, status badge (green/amber/red/blue), composite score, gap counts, relative timestamp; rows clickable
- **API:** `GET /api/audit/runs`
- **Backend:** SELECT gap_audit_runs ORDER BY created_at DESC LIMIT 50
- **DB Write:** none
- **Event:** `audit_runs_list_viewed`

#### IM-F20-11: Audit Run Row Click
- **Element:** Table row on `/audit/runs`
- **User Action:** Click row
- **Frontend:** Row hover: `#EFF6FF` background, cursor-pointer, 200ms transition; click -> `/audit/runs/:auditRunId`
- **API:** none
- **DB Write:** none
- **Event:** `audit_run_row_clicked`

#### IM-F20-12: Audit Runs Filter Bar
- **Element:** Status + trigger type dropdowns on `/audit/runs`
- **User Action:** Select filter value
- **Frontend:** Client-side filter on loaded data; URL query params updated
- **API:** none (client-side)
- **DB Write:** none
- **Event:** `audit_runs_filtered`

#### IM-F20-13: Homepage Quick Status Widget
- **Element:** Hero section on `/`
- **User Action:** Land on homepage
- **Frontend:** Last audit status card, composite score, quick-link cards; onboarding card if no audits
- **API:** `GET /api/health/governance`
- **Backend:** Return last audit summary and mean composite score
- **DB Write:** none
- **Event:** `homepage_viewed`

#### IM-F20-14: Sidebar Navigation Active State
- **Element:** Sidebar nav items
- **User Action:** Click nav item
- **Frontend:** Active item: `#2563EB` left border, `#EFF6FF` background; 200ms transition; cursor-pointer on all items
- **API:** none
- **DB Write:** none
- **Event:** `sidebar_nav_item_clicked`

---

## Feature F21: Governance Doc Gap Detection

### Pages: `/audit/runs/:auditRunId` (scores section), `/health`

#### IM-F21-01: Artifact Health Scores Table
- **Element:** 9-row scores table on audit detail page
- **User Action:** Scroll to scores section
- **Frontend:** One row per artifact: name, exists_on_disk indicator, score bars (completeness/freshness/consistency), composite_score (bold), regeneration_tier badge, drift_detected flag, missing_sections count, placeholder_count
- **API:** `GET /api/audit/artifact-scores`
- **Backend:** SELECT artifact_health_scores WHERE audit_run_id=:auditRunId ORDER BY composite_score ASC
- **DB Write:** none
- **Event:** `artifact_scores_table_viewed`

#### IM-F21-02: Artifact Gap Detail Drawer
- **Element:** Expandable drawer on artifact row click
- **User Action:** Click artifact row
- **Frontend:** Inline drawer expands (200ms); shows missing_sections pills, drift_detail key-value pairs, placeholder_count, cross-doc contradictions; collapse on second click
- **API:** none (uses cached data)
- **DB Write:** none
- **Event:** `artifact_gap_drawer_opened`

#### IM-F21-03: Drift Detected Badge
- **Element:** Red badge on artifact row when drift_detected=1
- **User Action:** Hover badge
- **Frontend:** Badge: red `#EF4444`, Lucide AlertTriangle icon; hover tooltip: 'This artifact's content does not match the current codebase'
- **API:** none
- **DB Write:** none
- **Event:** `drift_badge_hovered`

#### IM-F21-04: Governance Health Page
- **Element:** `/health` page
- **User Action:** Navigate to /health
- **Frontend:** Project composite score gauge, 9-artifact table with latest scores, last audit date, 'Run New Audit' CTA, open gates list
- **API:** `GET /api/health/governance`
- **Backend:** Most recent completed gap_audit_runs JOIN artifact_health_scores; mean composite_score
- **DB Write:** none
- **Event:** `health_page_viewed`

#### IM-F21-05: Missing Sections Pills
- **Element:** Pill list in artifact gap drawer
- **User Action:** View drawer
- **Frontend:** Red pills with XCircle icon per missing section; green 'All required sections present' if empty
- **API:** none
- **DB Write:** none
- **Event:** `missing_sections_viewed`

#### IM-F21-06: Placeholder Count Display
- **Element:** Placeholder count row in artifact gap drawer
- **User Action:** View drawer
- **Frontend:** Amber AlertTriangle + count if > 0; green CheckCircle 'No placeholders' if 0
- **API:** none
- **DB Write:** none
- **Event:** `placeholder_count_viewed`

---

## Feature F22: Autonomous Artifact Regeneration

### Pages: `/audit/runs/:auditRunId`

#### IM-F22-01: Regeneration Status Indicator
- **Element:** Artifact row badge after AUTO regeneration
- **User Action:** View scores table post-audit
- **Frontend:** Green 'Auto-Regenerated' badge with CheckCircle; score delta 'X.XX -> Y.YY' with upward arrow; regeneration timestamp
- **API:** none
- **DB Write:** none
- **Event:** `regeneration_badge_viewed`

#### IM-F22-02: Regeneration Tier Badge
- **Element:** Tier badge on artifact row
- **User Action:** View scores table
- **Frontend:** AUTO -> green `#16A34A` + Zap icon; HUMAN_GATE -> red `#DC2626` + Lock icon; HEALTHY -> blue `#2563EB` + CheckCircle
- **API:** none
- **DB Write:** none
- **Event:** `regeneration_tier_badge_viewed`

#### IM-F22-03: Auto-Regeneration Count Card
- **Element:** Metric tile in audit summary card
- **User Action:** View audit detail
- **Frontend:** Green tile showing gaps_auto_regenerated; amber tile showing gaps_human_gated
- **API:** none
- **DB Write:** none
- **Event:** `regeneration_summary_viewed`

#### IM-F22-04: Phase 3 Regeneration Refusal Banner
- **Element:** Amber banner on audit detail when Phase 3 active
- **User Action:** View audit detail during Phase 3
- **Frontend:** Amber banner with Lucide Lock: 'Regeneration refused -- build is currently in Phase 3. Governance files are read-only during active builds.' Regeneration action buttons hidden.
- **API:** none
- **DB Write:** none
- **Event:** `phase3_regeneration_refusal_shown`

---

## Feature F23: Human Gate on Major Architectural Gaps

### Pages: `/gate/:auditRunId`

#### IM-F23-01: Gate Review Page
- **Element:** `/gate/:auditRunId` page
- **User Action:** Navigate to gate page
- **Frontend:** List of gated gap cards: artifact name, CRITICAL badge (red), plain-language description, 'What will change' section, Approve and Decline buttons
- **API:** `GET /api/audit/run/:auditRunId`
- **Backend:** Return audit detail with artifact_health_scores WHERE regeneration_tier='HUMAN_GATE'
- **DB Write:** none
- **Event:** `gate_review_page_viewed`

#### IM-F23-02: Gap Detail Card
- **Element:** Gate gap card on `/gate/:auditRunId`
- **User Action:** Read card
- **Frontend:** Artifact heading, severity badge, plain-language gap description, 'What will change' section, last modified date
- **API:** none
- **DB Write:** none
- **Event:** `gate_gap_card_viewed`

#### IM-F23-03: Approve Regeneration Button
- **Element:** Primary 'Approve Regeneration' button (`#F97316`) on gap card
- **User Action:** Click
- **Frontend:** Loading spinner; confirmation modal opens
- **API:** none (pre-confirmation)
- **DB Write:** none
- **Event:** `gate_approve_clicked`

#### IM-F23-04: Approval Confirmation Modal -- Confirm
- **Element:** 'Confirm' button in approval modal
- **User Action:** Click Confirm
- **Frontend:** Modal closes; loading overlay on card; card -> 'Approved -- regeneration queued'; gap count decrements
- **API:** `POST /api/audit/run/:auditRunId/gate`
- **Backend:** Record gate decision approved in artifact_health_scores; queue RegenerationEngine job; update gap_audit_runs if all gates resolved
- **DB Write:** `artifact_health_scores`
- **Side Effects:** RegenerationEngine job queued; governance doc written to disk; health_score_after updated; audit status updated if all gates resolved
- **Success:** HTTP 200 `{decision:'approved', artifactName, regenerationQueued:true}`
- **Error:** HTTP 404/409/403 -> toast error
- **Event:** `gate_approved_confirmed`

#### IM-F23-05: Approval Confirmation Modal -- Cancel
- **Element:** 'Cancel' button in approval modal
- **User Action:** Click Cancel
- **Frontend:** Modal closes with 200ms fade; gap card unchanged
- **API:** none
- **DB Write:** none
- **Event:** `gate_approve_cancelled`

#### IM-F23-06: Decline Button
- **Element:** Secondary 'Decline / Keep As-Is' button on gap card
- **User Action:** Click
- **Frontend:** Inline confirmation appears: 'Keep current file unchanged?' with 'Yes, decline' and 'Cancel' links
- **API:** none
- **DB Write:** none
- **Event:** `gate_decline_clicked`

#### IM-F23-07: Decline Inline Confirmation -- Yes, Decline
- **Element:** 'Yes, decline' link in inline confirmation
- **User Action:** Click
- **Frontend:** Card -> 'Declined -- artifact unchanged' grey badge; card moves to bottom; gap count decrements
- **API:** `POST /api/audit/run/:auditRunId/gate`
- **Backend:** Record gate decision declined; NO regeneration queued; update gap_audit_runs
- **DB Write:** `artifact_health_scores`
- **Side Effects:** No governance doc written; gap_audit_runs updated
- **Success:** HTTP 200 `{decision:'declined', artifactName, regenerationQueued:false}`
- **Error:** HTTP 404/409 -> toast error
- **Event:** `gate_declined_confirmed`

#### IM-F23-08: Halted For Human Banner
- **Element:** Amber banner on audit detail page when status=halted_for_human
- **User Action:** View audit detail
- **Frontend:** Amber full-width banner: 'This audit is waiting for your review. N critical gap(s) require your decision before regeneration can proceed.' 'Review Gates' button -> `/gate/:auditRunId`
- **API:** none
- **DB Write:** none
- **Event:** `halted_for_human_banner_viewed`

#### IM-F23-09: Non-Interactive Mode Deferral Notice
- **Element:** Red banner on audit detail for non-interactive audit with critical gap
- **User Action:** View audit detail
- **Frontend:** Red banner: 'Audit halted in non-interactive mode. N critical gap(s) were deferred -- not auto-approved. Visit /gate/:auditRunId to resolve manually.' No auto-approve button present.
- **API:** none
- **DB Write:** none
- **Event:** `non_interactive_deferral_banner_viewed`

#### IM-F23-10: All Gates Resolved State
- **Element:** Gate page success state
- **User Action:** Resolve last gated gap
- **Frontend:** Green banner 'All gates resolved. The audit can now finalize.' Summary: N approved, M declined. 'View Audit Results' -> `/audit/runs/:auditRunId`
- **API:** none (triggered by last POST gate response)
- **DB Write:** none
- **Event:** `all_gates_resolved`

---

## Feature F24: Continuation from Exact Halt Point

### Pages: `/resurrect`

#### IM-F24-01: Resurrect Page -- Build Lookup Form
- **Element:** Build lookup form on `/resurrect`
- **User Action:** Navigate to /resurrect
- **Frontend:** Manual Build Run ID text input + 'Recent halted builds' dropdown populated from API
- **API:** `GET /api/audit/runs`
- **Backend:** Return gap_audit_runs WHERE halt_point_reference IS NOT NULL ORDER BY created_at DESC LIMIT 20
- **DB Write:** none
- **Event:** `resurrect_page_viewed`

#### IM-F24-02: Recent Halted Builds Dropdown
- **Element:** `<select>` dropdown on `/resurrect`
- **User Action:** Select halted build
- **Frontend:** Each option: '[truncated buildRunId] -- halted at prompt N (name) -- [relative date]'; selection populates Build Run ID field and shows halt point preview card
- **API:** none (data from initial load)
- **DB Write:** none
- **Event:** `halted_build_selected_from_dropdown`

#### IM-F24-03: Halt Point Preview Card
- **Element:** Facts card on `/resurrect` after build selection
- **User Action:** View after selecting build
- **Frontend:** 5 fact rows with Lucide icons: Build Run ID (Copy), Prompt Index (Hash), Prompt Name (Tag), Failing Check (AlertCircle), Sub-step Index (ListOrdered); Feature Branch (GitBranch); monospace values; null -> 'Not recorded' grey italic; 'Verify in Build Memory' link
- **API:** none
- **DB Write:** none
- **Event:** `halt_point_preview_viewed`

#### IM-F24-04: Resume Build Button
- **Element:** Primary 'Resume Build' CTA (`#F97316`) on `/resurrect`
- **User Action:** Click
- **Frontend:** Loading spinner; 'Generating continuation plan...'; on success -> continuation plan accordion
- **API:** `POST /api/resurrect/resume`
- **Backend:** Validate buildRunId; query gap_audit_runs halt_point_reference; verify composite_score >= 0.70 and gaps_critical=0; read 5 halt facts + featureBranch; build continuation_plan (ordered actions starting at halted promptIndex, skip completed prompts); write to gap_audit_runs.continuation_plan; return plan
- **DB Write:** `gap_audit_runs`
- **Side Effects:** continuation_plan populated; Phase 3 executor signaled with --start-at=promptIndex
- **Success:** HTTP 200 `{continuationPlan:{startAtPromptIndex, featureBranch, actions:[...]}, haltPoint:{...5 facts...}}`
- **Error:** HTTP 400 health floor not met (belowFloor list, openGates count) | HTTP 404 no resumable state | HTTP 409 build already completed -> error cards
- **Event:** `resurrect_resume_submitted`

#### IM-F24-05: Continuation Plan Accordion
- **Element:** Accordion on `/resurrect` post-resume
- **User Action:** View generated plan
- **Frontend:** Step 1: 'Resume from prompt N (name) on branch [featureBranch]'; expandable steps; completed prompts greyed 'Already complete'; failing check highlighted amber: 'Address failing check: [failingCheck] at sub-step [subStepIndex]'; copy CLI command button
- **API:** none
- **DB Write:** none
- **Event:** `continuation_plan_viewed`

#### IM-F24-06: Copy CLI Command Button
- **Element:** Copy button next to generated CLI command
- **User Action:** Click copy
- **Frontend:** Copies 'forge resurrect --resume --build-id=... --start-at=N' to clipboard; icon switches CheckCircle for 2s then reverts; toast 'Command copied to clipboard'; fallback: selectable text block if clipboard API unavailable
- **API:** none
- **DB Write:** none
- **Side Effects:** navigator.clipboard.writeText called
- **Event:** `resume_command_copied`

#### IM-F24-07: Health Floor Refusal Card
- **Element:** Error card on `/resurrect` when floor not met
- **User Action:** View after failed resume attempt
- **Frontend:** Red card: 'Cannot resume -- governance health floor not met.' Lists artifacts below 0.70 with scores; open gates count; CTAs: 'Run New Audit' (-> /audit/new pre-filled) and 'Review Open Gates' (-> /gate/:auditRunId)
- **API:** none (from POST 400 response)
- **DB Write:** none
- **Event:** `health_floor_refusal_shown`

#### IM-F24-08: No Resumable State Message
- **Element:** Info card on `/resurrect` when no Build Memory state found
- **User Action:** View after 404 resume response
- **Frontend:** Amber card: 'No resumable build state found for this Build Run ID. Use forge resurrect (full reconstruction path) instead.' F10 documentation link; 'Start Fresh Audit' -> /audit/new
- **API:** none (from POST 404 response)
- **DB Write:** none
- **Event:** `no_resumable_state_shown`

#### IM-F24-09: Dialtest Attempt 5 Verification Badge
- **Element:** Verification badge on audit detail for halt_recovery audit matching buildRunId=3736ff33-7ca2-4595-b304-b47badf28ac6
- **User Action:** View audit detail
- **Frontend:** Green badge 'Dialtest Attempt 5 -- All 5 halt facts reconstructed'; halt_point_reference card shows: buildRunId=3736ff33-7ca2-4595-b304-b47badf28ac6, promptIndex=5, promptName=ui-shell, failingCheck=file_delta, subStepIndex=1, featureBranch=forge/3736ff33-.../prompt-5-ui-shell-layouts-design-tokens
- **API:** none
- **DB Write:** none
- **Event:** `dialtest_halt_point_verified`

---

## Design System Compliance Notes

- **Colors:** All interactive elements use `#2563EB` (primary), `#F97316` (CTA buttons), `#F8FAFC` (backgrounds), `#1E293B` (text). Status colors: green `#16A34A`, amber `#D97706`, red `#DC2626`.
- **Typography:** Inter throughout; headings 600-weight; body 400-weight; monospace for IDs, branch names, CLI commands.
- **Spacing:** `--space-md` (16px) standard padding; `--space-lg` (24px) section padding; `--space-xl` (32px) large gaps.
- **Shadows:** Cards use `--shadow-md`; modals use `--shadow-xl`.
- **Transitions:** All hover/state changes 200ms ease. No instant state changes.
- **Icons:** Lucide React exclusively -- no emojis.
- **Accessibility:** `cursor-pointer` on all clickable elements; visible focus states (3px `#2563EB20` ring on inputs); 4.5:1 minimum contrast.
- **Responsive:** All pages functional at 375px, 768px, 1024px, 1440px. No horizontal scroll on mobile.
- **Forbidden:** No emojis as icons; no hidden filters; no layout-shifting hovers; no low-contrast text; no invisible focus states.

---

## API Route -> Interaction Coverage Matrix

| Route | Interactions |
|---|---|
| `POST /api/audit/run` | IM-F20-07 |
| `GET /api/audit/run/:auditRunId` | IM-F20-08, IM-F20-09, IM-F23-01 |
| `GET /api/audit/runs` | IM-F20-10, IM-F24-01 |
| `POST /api/audit/run/:auditRunId/gate` | IM-F23-04, IM-F23-07 |
| `POST /api/resurrect/resume` | IM-F24-04 |
| `GET /api/health/governance` | IM-F20-13, IM-F21-04 |
| `GET /api/audit/artifact-scores` | IM-F21-01 |

## Database Table -> Interaction Coverage Matrix

| Table | Written By |
|---|---|
| `gap_audit_runs` | IM-F20-07 (INSERT on audit start), IM-F24-04 (UPDATE continuation_plan) |
| `artifact_health_scores` | IM-F23-04 (UPDATE gate decision approved), IM-F23-07 (UPDATE gate decision declined) |

All read-only interactions use `dbWrite: none`. No interaction writes to a table not in the DATABASE state.

---

# Auth Architecture

## Overview

Forge-2 is a **single-tenant** application serving exactly one operator on one local machine. There is no multi-user model, no team hierarchy, and no tenant scoping. Authentication is handled by **Supabase Auth** (email + password). Authorization is a flat **single-role model**: every authenticated user is an `operator` with full access to all features.

This document specifies the middleware behavior, role model, session flows, and permission enforcement patterns for all five features (F20-F24).

---

## Roles

### `operator`

The sole application role. Assigned automatically on signup via a `profiles` table trigger. Holds all permissions in the system.

**Permissions:**
- All audit API routes: `POST /api/audit/run`, `GET /api/audit/run/:auditRunId`, `GET /api/audit/runs`, `GET /api/audit/artifact-scores`
- Gate API route: `POST /api/audit/run/:auditRunId/gate`
- Resurrection API route: `POST /api/resurrect/resume`
- Health API route: `GET /api/health/governance`
- Full read/write access to `gap_audit_runs` and `artifact_health_scores`
- Authority to approve or decline human gate decisions (F23)
- Authority to trigger `forge resurrect --resume` (F24)

No other role exists. There is no `viewer`, `admin`, or `guest` role.

---

## Profiles Table

```sql
CREATE TABLE profiles (
  id          uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text        NOT NULL DEFAULT 'operator',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Auto-create profile on new auth user
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, role) VALUES (NEW.id, 'operator');
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE handle_new_user();
```

---

## Middleware (`src/middleware.ts`)

Next.js middleware intercepts every request before it reaches a page or API route.

### Public paths (bypass all checks)
- `/login`
- `/api/auth/*`
- `/_next/static/*`
- `/_next/image/*`
- `/favicon.ico`

### Page routes (non-/api, non-public)

1. Instantiate Supabase SSR client using `createServerClient` from `@supabase/ssr` with `cookies()` from `next/headers`.
2. Call `supabase.auth.getSession()`.
3. **On null or invalid session:** `NextResponse.redirect('/login?next=<encoded-pathname>')` -- **never render a default or wrong-role page (Iron Law 4)**.
4. On valid session: query `profiles` table for `role` where `id = session.user.id`.
5. **On any fetch error or missing/null role:** `NextResponse.redirect('/login')` -- **never infer a default role**.
6. On valid role: attach `x-user-role: operator` to the request headers and call `NextResponse.next()`.

### API routes (`/api/*`)

1. Instantiate Supabase SSR client (same as above).
2. Call `supabase.auth.getSession()`.
3. **On null or invalid session:** return `NextResponse.json({ error: 'Unauthorized' }, { status: 401 })` -- **no redirect** (API contract).
4. On valid session: query `profiles.role`.
5. **On fetch error or missing role:** return `NextResponse.json({ error: 'Unauthorized' }, { status: 401 })`.
6. On valid role: attach `x-user-role` header and call `NextResponse.next()`.

### Iron Law 4 Compliance

> On ANY role-fetch failure, redirect to `/login` ONLY -- never render a default or wrong-role page.

This is enforced unconditionally. There is no fallback role. There is no silent downgrade to a read-only view. Any ambiguity in session or role state results in a `/login` redirect (pages) or a `401` response (API).

---

## Row-Level Security (RLS)

Single-tenant RLS policies scope data to the authenticated user.

### `gap_audit_runs`

```sql
ALTER TABLE gap_audit_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY gap_audit_runs_self
  ON gap_audit_runs
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

### `artifact_health_scores`

```sql
ALTER TABLE artifact_health_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY artifact_health_scores_self
  ON artifact_health_scores
  FOR ALL
  USING (
    auth.uid() = (
      SELECT user_id FROM gap_audit_runs WHERE id = artifact_health_scores.audit_run_id
    )
  )
  WITH CHECK (
    auth.uid() = (
      SELECT user_id FROM gap_audit_runs WHERE id = artifact_health_scores.audit_run_id
    )
  );
```

### `profiles`

```sql
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_self
  ON profiles
  FOR ALL
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);
```

---

## Session Lifecycle

### Login
1. User POSTs credentials to `/api/auth/callback` (Supabase Auth email+password flow).
2. Supabase sets a secure, httpOnly session cookie.
3. Server reads `profiles.role` for the new session.
4. On role-fetch failure: redirect to `/login`.
5. On success: redirect to `/` (dashboard).

### Token Refresh
- The Supabase SSR client automatically refreshes the access token using the refresh token when it detects expiry.
- On refresh failure: middleware detects invalid session on next navigation and redirects to `/login` (pages) or returns `401` (API).

### Logout
- Client calls `supabase.auth.signOut()`.
- Session cookie is cleared.
- User is redirected to `/login`.

---

## API-Level Permission Enforcement

Middleware attaches `x-user-role` to requests, but **API route handlers never trust the header alone**. Every write endpoint re-verifies the session and role directly from Supabase before executing:

```typescript
// Pattern used in all write API routes
const supabase = createRouteHandlerClient({ cookies });
const { data: { session } } = await supabase.auth.getSession();
if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
if (!profile || profile.role !== 'operator') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
```

This double-verification applies to:
- `POST /api/audit/run` -- triggers GapAuditor
- `POST /api/audit/run/:auditRunId/gate` -- records human gate decision (F23)
- `POST /api/resurrect/resume` -- triggers Phase 3 continuation (F24)

---

## Human Gate Security (F23)

The human gate (`POST /api/audit/run/:auditRunId/gate`) enforces the following additional checks beyond role verification:

1. The `auditRunId` must exist in `gap_audit_runs` and belong to the authenticated user (enforced by RLS + explicit `user_id` check).
2. The gate decision must be `{ decision: 'approve' | 'decline', gapId: string }`.
3. In `--non-interactive` mode the endpoint returns `409 Conflict` with `{ status: 'halted_for_human' }` -- it does **not** auto-approve.
4. The gate cannot be disabled by any flag or environment variable (structural gate per F23 / Contract 2 philosophy).

---

## Resume Security (F24)

The resume endpoint (`POST /api/resurrect/resume`) enforces:

1. Operator role verified (double-verification pattern above).
2. The referenced `auditRunId` must have `status = 'completed'` and a non-null `halt_point_reference`.
3. Health floor enforced in code: mean `composite_score >= 0.70` AND `gaps_critical = 0` (Iron Law R8). On failure: `409 Conflict` listing blocking artifacts.
4. Prompts already recorded `completed` in Build Memory for the `buildRunId` are excluded from the continuation plan (Iron Law R7).

---

## Multi-Tenancy Statement

This application is **explicitly single-tenant** (PRD §Target User, §Non-Goals). There is:
- No `companies` or `organizations` table.
- No `tenant_id` or `company_id` column on any table.
- No tenant-scoped RLS policies.
- No invite or team-member flow.

Data is scoped by `user_id` (the single Supabase Auth user) and `machine_id` (identifying the local machine per SCHEMA_ADDITIONS §0 / Iron Law R6). `machine_id` is a read-only provenance tag, not an access-control boundary.

---

## Protected Routes Summary

| Route | Role Required | Auth Failure Behavior |
|---|---|---|
| `/` | operator | Redirect to /login |
| `/audit/new` | operator | Redirect to /login |
| `/audit/runs` | operator | Redirect to /login |
| `/audit/runs/:auditRunId` | operator | Redirect to /login |
| `/resurrect` | operator | Redirect to /login |
| `/health` | operator | Redirect to /login |
| `/gate/:auditRunId` | operator | Redirect to /login |
| `POST /api/audit/run` | operator | 401 JSON |
| `GET /api/audit/run/:auditRunId` | operator | 401 JSON |
| `GET /api/audit/runs` | operator | 401 JSON |
| `POST /api/audit/run/:auditRunId/gate` | operator | 401/403 JSON |
| `POST /api/resurrect/resume` | operator | 401/403 JSON |
| `GET /api/health/governance` | operator | 401 JSON |
| `GET /api/audit/artifact-scores` | operator | 401 JSON |
| `/login` | public | -- |
| `/api/auth/*` | public | -- |

---

## Agent Architecture

### Decision: Zero Autonomous Agents

System 1 (Resurrection and Gap Intelligence Engine) requires **no autonomous background agents**.

All five features (F20-F24) are operator-initiated and complete within a bounded, synchronous-or-short-async pipeline:

| Feature | Trigger | Execution model |
|---|---|---|
| F20: Deep Codebase Audit | `forge audit <path>` CLI / POST /api/audit/run | Operator waits; pipeline runs to completion or halts for human gate |
| F21: Governance Doc Gap Detection | Sub-step of F20 audit pipeline | Synchronous in-process step |
| F22: Autonomous Artifact Regeneration | Sub-step of F20 audit pipeline, post-scoring | Synchronous in-process step; never scheduled |
| F23: Human Gate | Sub-step of F20 audit pipeline when CRITICAL gap found | Blocks on operator input; defers in --non-interactive mode |
| F24: Halt-Point Continuation | `forge resurrect --resume` CLI / POST /api/resurrect/resume | Operator-initiated, reads pre-written continuation plan |

None of these operations run unattended, on a schedule, or in response to an external event without a human initiating the command. There is no queue, no cron, no webhook consumer, and no background worker in this system.

### In-Process Orchestration Pipeline (not an agent)

The audit pipeline is a sequential in-process orchestration with the following stages:

```
forge audit <path> [--halt-recovery] [--non-interactive]
  -
  -- 1. Write gap_audit_runs row (status = 'running')
  -- 2. GapAuditor.runScan() -> ScanReport                     [R5: reuse ForgeRetrofit]
  -- 3. GapAuditor.runDiagnose() -> 3 DIAGNOSE reports
  -- 4. GapDetector.detectGaps(ScanReport, 9 artifacts)       [F21]
  -       -- Per artifact: missing_sections, placeholder_count, drift_detail, contradictions
  -       -- Classify each gap: MINOR | MAJOR | CRITICAL
  -- 5. ArtifactHealthScorer.score(9 artifacts)               [F21]
  -       -- completeness_score, freshness_score, consistency_score -> composite_score
  -       -- Write 9 artifact_health_scores rows
  -- 6. Update gap_audit_runs.health_score_before = mean(composite_scores)
  -- 7. [If halt-recovery] HaltPointReconstructor.reconstruct()  [F24]
  -       -- Read Build Memory -> buildRunId, featureBranch, promptIndex,
  -          failingCheck, subStepIndex
  -       -- Write halt_point_reference + continuation_plan JSON
  -- 8. HumanGateEvaluator.evaluate(gaps)                     [F23]
  -       -- CRITICAL gaps -> gate prompt (or defer if --non-interactive)
  -       -- If any deferred -> status = 'halted_for_human', stop
  -- 9. RegenerationEngine.regenerate(AUTO artifacts)         [F22]
  -       -- Refuse if Phase 3 is active (Contract 3 / R3)
  -       -- Full-file regen: SESSION_STATE, STATE_OF_THE_BUILD, TOOLCHAIN
  -       -- Section-scoped patch: PRD, BLUEPRINT, BEHAVIORAL_CONTRACTS,
  -          SCHEMA_REGISTRY, AGENTS, TESTING
  -       -- Update artifact_health_scores.health_score_after
  -- 10. Update gap_audit_runs (status = 'completed', health_score_after,
  -       gaps_minor, gaps_major, gaps_critical, gaps_auto_regenerated,
  -       gaps_human_gated, gaps_found_total, duration_ms)
  -- 11. Return audit result to caller
```

### Why No Agents

Per FORGE Phase 1B Session 5 finding #9: a simple app (a CRUD tool, a dashboard, a form-driven workflow) has ZERO agents. An autonomous agent requires recurring, unattended, scheduled, or event-triggered work with no human in the loop. System 1 is a **command-driven audit tool**. Every operation is:

- **Operator-initiated** -- the operator types `forge audit` or `forge resurrect --resume`
- **Operator-awaited** -- the result is returned before the command exits (< 90 seconds per Success Metrics)
- **Not recurring** -- no schedule, no cron, no periodic re-run
- **Not event-triggered** -- no webhooks, no queue messages, no filesystem watchers

The `RegenerationEngine` writes files autonomously within the pipeline, but it is not an agent -- it runs synchronously as a pipeline step under direct operator invocation, with the operator waiting for the result.

### Resurrection Iron Laws Governing This Architecture

- **R1**: `GapAuditor`, `ArtifactHealthScorer`, gap detectors -- strictly read-only. Only `RegenerationEngine` writes.
- **R3**: No governance write during Phase 3. `RegenerationEngine` checks phase before any write.
- **R4**: CRITICAL gaps route to `HumanGateEvaluator`, never auto-regenerated.
- **R5**: All codebase facts from `runScan`/`ScanReport`. No second scanner.
- **R6**: Every `gap_audit_runs` and `artifact_health_scores` insert includes `machine_id`.
- **R8**: Health floor (`composite_score >= 0.70`, `gaps_critical = 0`) enforced in code before resume.

---

# Infrastructure Architecture

## Overview

forge-2 (Resurrection and Gap Intelligence Engine) deploys on the FORGE default stack: **Next.js 14 (App Router) + Supabase (Postgres + Auth) + Vercel**, managed with **pnpm** and written in **TypeScript strict**. The system is single-tenant and single-operator; there is no multi-tenancy, no company/tenant scoping, and no tenant-scoped RLS. Build Memory (`~/.forge/forge_memory.db`) is a local SQLite file that never leaves the operator's machine.

---

## Environments

### Development

Runs on the operator's local machine. Next.js dev server (`pnpm dev`) serves the App Router. Supabase runs locally via `supabase start` (Docker). Build Memory SQLite is at the path set by `FORGE_MEMORY_DB_PATH` (defaults to `~/.forge/forge_memory.db`). ForgeRetrofit scanner runs in-process. All API routes execute in Node.js (not Edge).

**Environment variables (names only):**

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (public) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-only) |
| `SUPABASE_DB_URL` | Postgres direct connection URL for migrations |
| `FORGE_MEMORY_DB_PATH` | Absolute path to `forge_memory.db` |
| `FORGE_MACHINE_ID` | Stable machine identifier (R6 / Contract 20) |
| `FORGE_PROJECT_ROOT` | Default project path for audits |
| `FORGE_SCAN_TIMEOUT_MS` | ForgeRetrofit scan timeout |
| `FORGE_AUDIT_REGEN_THRESHOLD` | composite_score threshold for AUTO tier |
| `FORGE_HEALTH_FLOOR_SCORE` | Minimum mean composite_score to allow resume (0.70) |
| `OPENAI_API_KEY` | LLM key for RegenerationEngine |
| `OPENAI_MODEL` | Model name for regeneration calls |
| `OPENAI_MAX_TOKENS` | Token cap for regeneration calls |
| `FORGE_LOG_LEVEL` | pino log level (debug/info/warn/error) |
| `FORGE_NON_INTERACTIVE` | Forces non-interactive mode (gate defers, never auto-approves) |
| `NODE_ENV` | `development` |

### Production

Deployed to Vercel. Supabase hosted project in the same AWS region (us-east-1 / iad1). Build Memory SQLite remains on the operator's local machine and is **never uploaded to any remote**. Audit results (scores, halt-point, continuation plan) are persisted to the Supabase `gap_audit_runs` and `artifact_health_scores` tables for dashboard display.

**Additional production-only variables:**

| Variable | Purpose |
|---|---|
| `VERCEL_URL` | Auto-injected canonical deployment URL |
| `VERCEL_ENV` | `production` / `preview` / `development` |
| `VERCEL_REGION` | Serverless function region (default `iad1`) |
| `FORGE_WEBHOOK_SECRET` | HMAC secret for webhook authenticity on gate callbacks |
| `FORGE_AUDIT_MAX_DURATION_MS` | Hard ceiling on audit duration before forced `failed` status |
| `SENTRY_DSN` | Sentry ingest URL |
| `SENTRY_AUTH_TOKEN` | Sentry source-map upload token |
| `SENTRY_ORG` | Sentry organization slug |
| `SENTRY_PROJECT` | Sentry project slug |
| `NODE_ENV` | `production` |

---

## Deployment Configuration

### Platform

- **Host:** Vercel
- **Framework preset:** Next.js 14 (App Router auto-detected)
- **Package manager:** pnpm
- **Node runtime:** 20.x
- **Build command:** `pnpm build`
- **Install command:** `pnpm install --frozen-lockfile`
- **Output directory:** `.next`

### Serverless Function Routing

All API routes run in the **Node.js runtime** (not Edge). Edge runtime is explicitly excluded because audit routes require `fs`, `child_process`, and `better-sqlite3`.

| Route | Max Duration | Reason |
|---|---|---|
| `POST /api/audit/run` | 300 s | Full ForgeRetrofit scan + 9-artifact analysis |
| `POST /api/resurrect/resume` | 300 s | Halt-point reconstruction + continuation plan write |
| `POST /api/audit/run/:auditRunId/gate` | 10 s | Human gate decision write |
| All other API routes | 10 s | CRUD / read |

Default Vercel region: `iad1` (us-east-1). Matches Supabase hosted project region.

### Static / ISR Pages

| Page | Strategy | Revalidate |
|---|---|---|
| `/` | ISR | 60 s |
| `/health` | ISR | 60 s |
| `/audit/runs` | ISR | 60 s |
| `/audit/new` | Static | -- |
| `/audit/runs/:auditRunId` | SSR (dynamic) | -- |
| `/resurrect` | SSR (dynamic) | -- |
| `/gate/:auditRunId` | SSR (dynamic) | -- |

### Database Migrations

Migrations managed via Supabase CLI (`supabase db push`). Migrations run in CI **before** Vercel deploy step. Schema version bumps from `2.2.1` to `2.3.0` adding `gap_audit_runs` and `artifact_health_scores` tables (per `SCHEMA_ADDITIONS.md`). No tenant scoping; no `company_id`/`tenant_id` column. Every row carries `machine_id` (R6).

### CI Pipeline

1. `pnpm install --frozen-lockfile`
2. `tsc --noEmit` (TypeScript strict)
3. `pnpm lint`
4. `pnpm test`
5. `supabase db push` (migration)
6. Vercel deploy

### Preview Deployments

Enabled for all branches. `FORGE_NON_INTERACTIVE=true` forced on all preview deployments (gate never auto-approves in CI; defers and records `halted_for_human`).

---

## Monitoring and Telemetry

### Error Tracking -- Sentry

- Next.js SDK installed; captures all unhandled API route exceptions and React error boundaries.
- Source maps uploaded at build time via `SENTRY_AUTH_TOKEN`.
- Alert rule: error rate > 5/min on `POST /api/audit/run` triggers Sentry notification.
- Alert rule: function timeout approaching 280 s on any audit route triggers warning.

### Performance Monitoring -- Vercel Analytics

- Web Vitals (LCP, CLS, INP) collected on all frontend pages.
- Real-user measurements; no synthetic polling.

### Structured Logging -- pino

- JSON logs to stdout; Vercel log drain forwards to Vercel dashboard.
- Every audit-related log entry includes structured fields:
  - `audit_run_id`, `machine_id`, `duration_ms`
  - `gaps_found_total`, `gaps_auto_regenerated`, `gaps_human_gated`, `gaps_critical`
  - `health_score_before`, `health_score_after`, `status`
- Iron Law 3: all metric values are read from Build Memory / Supabase rows, never self-reported.

### Supabase Dashboard

- Monitors: Postgres connection pool utilization; query latency p50/p95 on `gap_audit_runs` and `artifact_health_scores`.
- Read replica: not required at single-operator scale.

### Health Endpoint

`GET /api/health/governance` returns HTTP 200 with:
```json
{
  "gap_audit_runs_count": <integer>,
  "artifact_health_scores_count": <integer>,
  "mean_composite_score": <float>,
  "last_audit_status": <string>
}
```
Used as Vercel deployment health check URL.

---

## Performance Budgets

| Metric | Target |
|---|---|
| TARGETED halt-recovery audit end-to-end (start -> continuation_plan written) | < 90,000 ms (90 s) -- `gap_audit_runs.duration_ms` |
| Full audit (all 9 artifacts, full ScanReport) | < 240,000 ms (4 min) -- `gap_audit_runs.duration_ms` |
| `GET /api/audit/runs` p95 response time | < 800 ms |
| `GET /api/audit/run/:auditRunId` p95 response time | < 600 ms |
| `GET /api/health/governance` p95 response time | < 400 ms |
| `POST /api/audit/run/:auditRunId/gate` p95 response time | < 500 ms |
| LCP on `/audit/runs/:auditRunId` | < 2,500 ms (Core Web Vitals Good) |
| CLS on all pages | < 0.1 |
| INP on `/gate/:auditRunId` | < 200 ms |
| Initial JS bundle size (gzipped) | < 200 KB |
| Supabase insert latency p95 (`gap_audit_runs`, `artifact_health_scores`) | < 100 ms |
| Serverless function cold-start on `/api/audit/run` | < 3,000 ms |
| Halt-point reconstruction accuracy (all 5 facts) | 100% on any build with preserved feature branch + Build Memory rows |
| Auto-regenerated share of gaps (first 10 audits) | ≥ 70% (`sum(gaps_auto_regenerated) / sum(gaps_found_total)`) |

---

## Architecture Notes

### Single-Tenant Design

This product is single-tenant and single-operator. There is no `company_id`, no `tenant_id`, no organizations table, and no tenant-scoped RLS. Access control is enforced by Supabase Auth (single `operator` role) and filesystem permissions on `~/.forge/forge_memory.db`. All rows carry `machine_id` per R6 / Contract 20 for provenance, not for tenancy.

### Build Memory Isolation

`~/.forge/forge_memory.db` (SQLite, managed by `src/learning/database.ts`) is a local file. It is never synced to Supabase, never uploaded to Vercel, and never accessible via any API route. Audit results reference Build Memory row IDs but the file itself stays local.

### ForgeRetrofit Reuse (R5)

All codebase facts flow from `runScan` / `ScanReport` and the three DIAGNOSE report builders. No new filesystem-walk code exists under `src/resurrection/`. The shared `.forge/scan_report.json` cache written by `runScan` is the single source of truth for scan output; the audit route reads it; it is never written a second time by System 1.

### Phase 3 Write Guard (R3)

The `RegenerationEngine` checks the current build phase before writing any governance doc. If the phase is Phase 3, it refuses with a Contract 3 message and records the refusal in the audit run row. This check is in-process and non-configurable; no environment variable can bypass it.

### Gate Non-Bypassability (R4 / F23)

The `HumanGateEvaluator` gate for CRITICAL gaps has no `--force`, `--skip-gate`, or environment-variable bypass. In `--non-interactive` mode it defers the gated item and sets `status = 'halted_for_human'`. This is enforced structurally in code, not by convention.

---

# Testing Strategy -- FORGE 2.0 System 1: Resurrection and Gap Intelligence Engine

## Overview

This document defines the complete testing strategy for the Resurrection and Gap Intelligence Engine (System 1, Features F20-F24). It covers Playwright end-to-end specs for all key user flows, API-level test cases for every route, and a concrete Six Laws verification plan. All tests must pass in CI before any deployment to production.

---

## 1. Playwright End-to-End Specs

All specs live under `tests/e2e/` and run against a local Next.js dev server seeded with fixture data (`tests/fixtures/`). The dialtest attempt 5 fixture (`tests/fixtures/dialtest-attempt-5/`) is the canonical halt-recovery test input.

| Spec File | Feature | Key Assertions |
|---|---|---|
| `audit-new.spec.ts` | F20 | Form submission -> redirect -> status polling -> 9 artifact rows |
| `audit-halt-recovery.spec.ts` | F24 | Halt point panel with all 5 facts; dialtest fixture values exact |
| `audit-runs-list.spec.ts` | F20 | Paginated table; row click navigates to detail |
| `audit-detail-scores.spec.ts` | F21 | Exactly 9 artifact rows; all score columns present |
| `human-gate.spec.ts` | F23 | Decline -> halted_for_human; Approve -> regeneration fires |
| `resurrect-resume.spec.ts` | F24 | First action = promptIndex 5; prompts 1-4 skipped |
| `resurrect-floor.spec.ts` | F24/R8 | Resume blocked; warning lists below-floor artifacts |
| `health-dashboard.spec.ts` | F20 | Mean score, gap counts, per-artifact breakdown |
| `home.spec.ts` | All | Navigation; no 404s; no console errors |
| `auto-regeneration.spec.ts` | F22 | health_score_after > health_score_before; no gate for MINOR |

### Playwright Configuration

```typescript
// playwright.config.ts
export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://localhost:3000',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm dev:test',
    port: 3000,
    reuseExistingServer: !process.env.CI,
  },
});
```

---

## 2. API Test Cases

All API tests run via Vitest + supertest against a Next.js test server with an in-memory SQLite fixture. Run with `pnpm test:api`.

### POST /api/audit/run
- Returns 202 + auditRunId (UUID) + status='running' on valid input
- Returns 400 when projectPath missing
- Returns 400 when auditTrigger not in allowed enum
- Sets audit_trigger='halt_recovery' when haltRecovery=true
- Writes gap_audit_runs row with machine_id non-null before returning
- Returns 409 if a 'running' audit exists for the same projectPath
- Accepts scope parameter ('FULL','CODE_ONLY','GOVERNANCE_ONLY')
- In non-interactive mode: CRITICAL gaps -> status='halted_for_human'

### GET /api/audit/run/:auditRunId
- Returns 200 with all documented fields
- Returns 404 for unknown auditRunId
- Returns 400 for non-UUID auditRunId
- halt_point_reference is valid JSON with 5 keys for halt_recovery audits
- halt_point_reference is null for manual audits without halt
- continuation_plan is non-null ordered array when halt point present
- status='completed' + non-null health_score_after after successful completion
- status='halted_for_human' + gaps_human_gated > 0 for CRITICAL gaps in non-interactive mode

### GET /api/audit/runs
- Returns 200 with array ordered by created_at DESC
- Supports ?limit, ?offset pagination
- Supports ?status and ?auditTrigger filters
- Returns empty array (not 404) when no runs exist
- Each item has required summary fields
- Returns 400 for non-positive-integer limit
- Returns total count in response envelope

### POST /api/audit/run/:auditRunId/gate
- Returns 200 on approve; regeneration_tier updates to 'AUTO_APPROVED'
- Returns 200 on decline; artifact not modified; status='halted_for_human'
- Returns 404 for unknown auditRunId
- Returns 400 when decision missing or invalid
- Returns 400 when artifactName missing
- Returns 409 when gap not in HUMAN_GATE tier
- Increments gaps_human_gated on decline
- Decline is idempotent
- Approve triggers regeneration; health_score_after > health_score_before
- Returns 403 when audit status='completed'

### POST /api/resurrect/resume
- Returns 200 with continuation plan when floor met and halt point present
- Returns 409 with artifact list when mean composite_score < 0.70
- Returns 409 with gap list when gaps_critical > 0
- Returns 404 for unknown auditRunId
- Returns 400 when auditRunId missing
- Returns 409 with F10 autopsy pointer when halt_point_reference is null
- Continuation plan first action targets halted promptIndex, not 1
- Completed prompts excluded from continuation plan
- Returns 409 + Contract 3 message when project in Phase 3
- Response includes featureBranchName

### GET /api/health/governance
- Returns 200 with meanCompositeScore, totalGapsMinor/Major/Critical, lastAuditAt, artifactsAudited
- meanCompositeScore=null when no audits exist
- Per-artifact breakdown array present
- Each entry has artifactName, latestCompositeScore, regeneration_tier, drift_detected, exists_on_disk
- Correct row counts for both tables
- resumable=false when floor not met; resumable=true when floor met

### GET /api/audit/artifact-scores
- Returns 200 with artifact score rows when auditRunId param provided
- Exactly 9 rows for a completed audit
- Returns 400 when auditRunId missing
- Returns 404 for unknown auditRunId
- Each row has all documented fields
- composite_score = (0.4×completeness + 0.3×freshness + 0.3×consistency) ±0.001
- drift_detected=1 when ScanReport table absent from SCHEMA_REGISTRY content
- placeholder_count matches actual TBD/TODO/{{...}} count in file

---

## 3. Six Laws Verification Plan

### Law 1 -- Schema
**Status: Automated**

A dedicated Vitest migration verification suite (`tests/schema/schema.verify.test.ts`) opens `~/.forge/forge_memory.db` (or the CI fixture path) after all migrations run and verifies:

- `gap_audit_runs` columns, types, constraints, and CHECK clauses match the design exactly:
  - `id` TEXT PRIMARY KEY
  - `machine_id` TEXT NOT NULL
  - `project_path` TEXT NOT NULL
  - `audit_trigger` TEXT NOT NULL CHECK IN ('manual','halt_recovery','scheduled','targeted')
  - `status` TEXT NOT NULL CHECK IN ('running','completed','failed','halted_for_human')
  - `scope` TEXT (nullable)
  - `artifacts_audited` INTEGER
  - `health_score_before` REAL, `health_score_after` REAL
  - `gaps_found_total` INTEGER DEFAULT 0
  - `gaps_minor` INTEGER DEFAULT 0, `gaps_major` INTEGER DEFAULT 0, `gaps_critical` INTEGER DEFAULT 0
  - `gaps_auto_regenerated` INTEGER DEFAULT 0, `gaps_human_gated` INTEGER DEFAULT 0
  - `halt_point_reference` TEXT (nullable JSON)
  - `continuation_plan` TEXT (nullable)
  - `duration_ms` INTEGER
  - `created_at` TEXT NOT NULL, `updated_at` TEXT NOT NULL

- `artifact_health_scores` columns, types, constraints:
  - `id` TEXT PRIMARY KEY
  - `audit_run_id` TEXT NOT NULL REFERENCES gap_audit_runs(id)
  - `machine_id` TEXT NOT NULL
  - `artifact_name` TEXT NOT NULL CHECK IN ('PRD','SCHEMA_REGISTRY','AGENTS','BEHAVIORAL_CONTRACTS','BLUEPRINT','TOOLCHAIN','SESSION_STATE','STATE_OF_THE_BUILD','TESTING')
  - `exists_on_disk` INTEGER NOT NULL DEFAULT 0
  - `completeness_score` REAL, `freshness_score` REAL, `consistency_score` REAL, `composite_score` REAL
  - `missing_sections` TEXT (nullable JSON array)
  - `placeholder_count` INTEGER DEFAULT 0
  - `drift_detected` INTEGER NOT NULL DEFAULT 0
  - `drift_detail` TEXT (nullable)
  - `regeneration_tier` TEXT CHECK IN ('AUTO','HUMAN_GATE','AUTO_APPROVED')
  - `health_score_before` REAL, `health_score_after` REAL
  - `created_at` TEXT NOT NULL, `updated_at` TEXT NOT NULL
  - UNIQUE constraint on (audit_run_id, artifact_name)

- Schema version '2.3.0' recorded in build_memory_meta table
- **NO** company_id, tenant_id, or org_id columns (single-tenant; file-permission isolation)
- **NO** RLS policies (SQLite, not Postgres)
- machine_id NOT NULL enforced on both tables

Run: `pnpm test:schema`

---

### Law 2 -- API
**Status: Automated**

Vitest + supertest integration tests (`tests/api/`) against a Next.js test server with seeded SQLite fixture. All 7 routes covered. Key invariants:

- All routes return `Content-Type: application/json`
- Missing required fields -> 400 `{error: string, field: string}`
- Unknown IDs -> 404
- Conflict states -> 409
- CRITICAL gap in non-interactive mode -> `halted_for_human` (never auto-approve)
- Contract 3 enforcement: Phase 3 -> 409 with 'Contract 3' in message
- Operator session cookie required; missing -> 401
- Gate endpoint: approve on MINOR tier -> 409 (cannot gate non-critical)
- Gate endpoint: approve triggers regeneration; score improves
- Resume endpoint: below-floor -> 409 listing specific failing artifacts

Run: `pnpm test:api`

---

### Law 3 -- UI
**Status: Automated**

All 10 Playwright specs run in CI. Additional static checks:

- `pnpm build` completes with zero TypeScript errors across all 7 pages
- axe-core accessibility scan on every page: zero critical violations
- Resume button on /resurrect: `aria-disabled=true` + no click handler when floor not met
- Gate prompt on /gate/:auditRunId: artifact name, gap description, change description in plain English
- Nine artifact rows on /audit/runs/:auditRunId detail page (asserted via locator count)
- Halt Point panel on /audit/runs/:auditRunId shows all 5 facts when audit_trigger='halt_recovery'
- No console errors on page load for any route

Run: `pnpm test:e2e`

---

### Law 4 -- Data
**Status: Automated**

Vitest integration tests (`tests/integration/data-flow.test.ts`):

1. Insert gap_audit_runs row -> GET /api/audit/run/:id -> assert every field matches byte-for-byte
2. Insert 9 artifact_health_scores rows -> GET /api/audit/artifact-scores -> assert all 9 returned; composite_score = (0.4×completeness + 0.3×freshness + 0.3×consistency) ±0.001
3. Read fixture governance file; count TBD/TODO/{{...}} occurrences; assert placeholder_count in DB row matches
4. Fixture ScanReport lists table absent from SCHEMA_REGISTRY.md content -> assert drift_detected=1 for SCHEMA_REGISTRY row
5. Dialtest fixture: halt_point_reference JSON contains all 5 keys (buildRunId, promptIndex, promptName, failingCheck, subStepIndex) with correct values
6. machine_id on every inserted row equals os.hostname() output
7. health_score_after > health_score_before after AUTO regeneration on TOOLCHAIN fixture
8. No data is fabricated: if a halt-point fact cannot be read from Build Memory, the field is null in the response (R2)

Run: `pnpm test:integration`

---

### Law 5 -- Wiring
**Status: Automated**

1. `pnpm tsc --noEmit` -- zero TypeScript strict errors across `src/resurrection/`, `src/retrofit/`, `src/learning/database.ts`, and `src/tools/project-autopsy.ts` integration points
2. GapAuditor unit test: verify `runScan` called exactly once per audit; no filesystem-walk import from `src/resurrection/`
3. RegenerationEngine unit test: only writes files when `regeneration_tier='AUTO'` or gate decision='approve'; reads from GapAuditor output, not runScan directly
4. HumanGateEvaluator unit test: invoked for every CRITICAL gap; in non-interactive mode refuses without decision; cannot be disabled by any flag
5. ArtifactHealthScorer unit test: produces exactly 9 rows per audit; composite_score formula matches spec
6. Env var propagation test: FORGE_MACHINE_ID (or os.hostname() fallback) defined and present in every DB insert
7. `madge --circular src/` -- zero circular dependencies
8. `forge health` CLI command calls GET /api/health/governance and prints correct row counts
9. Import of `runScan` / `runRetrofitPipeline` from `src/retrofit/` resolves without error in all `src/resurrection/` modules

Run: `pnpm test:unit && pnpm tsc --noEmit && pnpm run check:circular`

---

### Law 6 -- Verification (Human Gate)
**Status: Manual -- required before production sign-off**

Reid Whitesides or designated operator performs the following session in sequence:

1. **Halt reconstruction** -- Run `forge audit <dialtest-fixture-path> --halt-recovery`. Confirm terminal output displays all 5 halt-point facts without any manual lookup:
   - `buildRunId = 3736ff33-7ca2-4595-b304-b47badf28ac6`
   - `promptIndex = 5`
   - `promptName = ui-shell`
   - `failingCheck = file_delta`
   - `subStepIndex = 1`
   - Branch: `forge/3736ff33-.../prompt-5-ui-shell-layouts-design-tokens`

2. **Browser verification** -- Navigate to `/audit/runs/:auditRunId`. Confirm the Halt Point panel matches CLI output. Confirm 9 artifact rows with human-readable labels (not raw keys).

3. **CRITICAL gap gate** -- Delete one table reference from SCHEMA_REGISTRY.md in the fixture. Run `forge audit`. Navigate to `/gate/:auditRunId`. Confirm gate prompt describes the gap and its impact in plain English (no TypeScript jargon).

4. **Gate decline** -- Click Decline. Confirm audit status shows 'halted_for_human' in the UI. Confirm the governance file is unchanged on disk (`git diff` shows no changes).

5. **Floor enforcement** -- Run `forge resurrect --resume` with composite_score < 0.70. Confirm CLI refuses with a message that names the specific below-floor artifacts.

6. **Successful resume** -- After scores reach ≥ 0.70 and gaps_critical=0, run `forge resurrect --resume`. Confirm continuation plan starts at promptIndex=5 and lists prompts 1-4 as 'already completed'.

7. **Timing** -- Confirm entire halt-recovery flow (step 1 -> continuation plan written) completes in under 90 seconds (wall-clock, measured by operator).

**Sign-off** -- Record operator name, date, and pass/fail for each step in `FORGE_HANDOFF.md` under a new '## Law 6 Verification Sign-off' section before any production deployment.

---

## 4. CI Pipeline Integration

```yaml
# .github/workflows/test.yml (relevant jobs)
jobs:
  schema:
    run: pnpm test:schema
  unit:
    run: pnpm test:unit && pnpm tsc --noEmit && pnpm run check:circular
  api:
    run: pnpm test:api
  integration:
    run: pnpm test:integration
  e2e:
    run: pnpm test:e2e
```

All automated jobs must pass before merge to main. Law 6 (human verification) is a deploy gate, not a merge gate.

---

## 5. Fixture Data Requirements

| Fixture | Purpose | Location |
|---|---|---|
| `dialtest-attempt-5/` | Canonical halt-recovery test (US-1/US-2) | `tests/fixtures/dialtest-attempt-5/` |
| `drifted-schema-registry/` | SCHEMA_REGISTRY drift detection (US-3) | `tests/fixtures/drifted-schema-registry/` |
| `minor-gap-toolchain/` | MINOR AUTO regeneration (US-4) | `tests/fixtures/minor-gap-toolchain/` |
| `critical-gap-absent-doc/` | CRITICAL gate enforcement (US-5) | `tests/fixtures/critical-gap-absent-doc/` |
| `below-floor-scores/` | Floor enforcement (US-8) | `tests/fixtures/below-floor-scores/` |
| `seeded.db` | Pre-populated SQLite for API/integration tests | `tests/fixtures/seeded.db` |

All fixtures are committed to the repository. Fixture governance files contain controlled, documented gaps that match the test assertions exactly. No fixture may contain real customer data.

---

## 6. Key Invariants (Cross-Cutting)

- **R1 (Read-only auditor):** GapAuditor, ArtifactHealthScorer, and gap detectors never write files. Verified by unit test mocking `fs.writeFile` and asserting it is never called from these modules.
- **R2 (No fabrication):** Unresolvable halt-point facts -> null in DB, never a guessed value. Verified by data-flow test with incomplete Build Memory fixture.
- **R3 (No Phase 3 writes):** RegenerationEngine refuses when phase=3. Verified by API test returning 409 + Contract 3 message.
- **R4 (Architectural gaps gated):** CRITICAL gaps -> HumanGateEvaluator always. Verified by unit test asserting no path from CRITICAL gap to RegenerationEngine.write() without a gate decision.
- **R5 (Reuse scanner):** No `fs.readdirSync`/`glob`/`walk` in `src/resurrection/`. Verified by `madge` import graph analysis.
- **R6 (machine_id on every write):** Verified by schema test (NOT NULL constraint) and data-flow test.
- **R7 (No prompt re-run):** Continuation plan excludes completed prompts. Verified by resume API test with seeded completed prompt rows.
- **R8 (Health floor is a gate):** Resume API returns 409 below floor. Verified by API test and Playwright resurrect-floor spec.

---

## Cross-Validation (7 issue(s))
- [WARN] **interaction_unknown_route** [frontend_interaction] (F23: Human Gate on Major Architectural Gaps / Approve Regeneration button on gate gap card) -- Interaction map calls API 'none (pre-confirmation)', which is not defined in APIArchitecture.
- [WARN] **interaction_unknown_route** [frontend_interaction] (F23: Human Gate on Major Architectural Gaps / Decline / Keep As-Is button on gate gap card) -- Interaction map calls API 'none (pre-confirmation)', which is not defined in APIArchitecture.
- [WARN] **interaction_unknown_route** [frontend_interaction] (F24: Continuation from Halt Point / Recent halted builds dropdown (/resurrect)) -- Interaction map calls API 'none (data from initial GET /api/audit/runs load)', which is not defined in APIArchitecture.
- [WARN] **interaction_unknown_route** [frontend_interaction] (F24: Continuation from Halt Point / Health floor refusal card (/resurrect)) -- Interaction map calls API 'none (data from POST /api/resurrect/resume 400 response)', which is not defined in APIArchitecture.
- [WARN] **interaction_unknown_route** [frontend_interaction] (F24: Continuation from Halt Point / No resumable state message (/resurrect)) -- Interaction map calls API 'none (data from POST /api/resurrect/resume 404 response)', which is not defined in APIArchitecture.
- [WARN] **interaction_unknown_route** [frontend_interaction] (F23: Human Gate on Major Architectural Gaps / Gate page -- all gates resolved state) -- Interaction map calls API 'none (triggered by last gate POST response)', which is not defined in APIArchitecture.
- [WARN] **interaction_unknown_route** [frontend_interaction] (F20: Deep Codebase Audit / Audit run filter bar (/audit/runs)) -- Interaction map calls API 'none (filter applied client-side on already-loaded GET /api/audit/runs data)', which is not defined in APIArchitecture.
