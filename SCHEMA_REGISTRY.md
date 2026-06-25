# FORGE 2.0 — SCHEMA REGISTRY

## Database: Self-Hosted Supabase (Docker)
- **Host:** localhost:54321
- **Database:** postgres
- **Schema:** public (FORGE Build Memory)

---

## Table: build_runs
Tracks every autonomous build FORGE executes.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | uuid | PK, default gen_random_uuid() | Build identifier |
| project_name | text | NOT NULL | Project name (benavora, tarritrix, etc.) |
| project_path | text | NOT NULL | Filesystem path to project |
| stack_fingerprint | jsonb | NOT NULL, default '{}' | Normalized tech stack signature |
| status | text | NOT NULL, default 'queued' | queued, running, completed, failed, halted |
| started_at | timestamptz | | Build start time |
| completed_at | timestamptz | | Build end time |
| total_prompts | int | NOT NULL, default 0 | Prompts in queue |
| completed_prompts | int | NOT NULL, default 0 | Successfully executed |
| failed_prompts | int | NOT NULL, default 0 | Failed prompts |
| total_errors | int | NOT NULL, default 0 | Total errors encountered |
| total_tokens | int | NOT NULL, default 0 | Token consumption |
| total_cost_usd | numeric(10,4) | NOT NULL, default 0 | Dollar cost |
| machine_id | text | NOT NULL | Executing machine |
| toolchain_manifest | jsonb | NOT NULL, default '{}' | Locked toolchain from Phase 0 |
| governance_hash | text | | Hash of governance package at start |
| sentinel_interventions | int | NOT NULL, default 0 | Sentinel halt count |
| autonomous_recovery_mode | boolean | NOT NULL, default false | Whether auto-recovery enabled |
| parallel_prompts_used | boolean | NOT NULL, default false | Whether parallel execution used |
| dry_run | boolean | NOT NULL, default false | Simulation only |
| created_at | timestamptz | NOT NULL, default now() | Record creation |

### RLS: None (FORGE is single-operator, local database)

### Indexes:
- `idx_build_runs_project` ON (project_name)
- `idx_build_runs_status` ON (status)
- `idx_build_runs_stack` ON (stack_fingerprint) USING GIN
- `idx_build_runs_machine` ON (machine_id)

---

## Table: prompt_executions
Tracks individual prompt execution within a build.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | uuid | PK, default gen_random_uuid() | Execution identifier |
| build_run_id | uuid | FK -> build_runs(id), NOT NULL | Parent build |
| prompt_index | int | NOT NULL | Position in queue (1-based) |
| prompt_name | text | NOT NULL | Descriptive name from queue.yaml |
| prompt_hash | text | NOT NULL | SHA-256 of prompt content |
| prompt_content | text | NOT NULL | Full assembled prompt text |
| status | text | NOT NULL, default 'pending' | pending, running, completed, failed, skipped |
| started_at | timestamptz | | Execution start |
| completed_at | timestamptz | | Execution end |
| tokens_input | int | NOT NULL, default 0 | Input tokens |
| tokens_output | int | NOT NULL, default 0 | Output tokens |
| cost_usd | numeric(10,4) | NOT NULL, default 0 | Dollar cost |
| error_output | text | | Captured stderr/error |
| resolution_applied | text | | Fix applied if error |
| was_rewritten | boolean | NOT NULL, default false | Dynamic rewrite applied |
| original_prompt_hash | text | | Hash before rewrite |
| rewrite_reason | text | | Why rewrite was applied |
| failure_prediction_score | numeric(5,4) | | Pre-execution failure probability |
| branch_name | text | | Git branch for this prompt |
| sentinel_passed | boolean | | Post-prompt health check result |
| sentinel_details | jsonb | | Health check breakdown |
| files_created | jsonb | default '[]' | Files created by this prompt |
| files_modified | jsonb | default '[]' | Files modified |
| files_deleted | jsonb | default '[]' | Files deleted |
| created_at | timestamptz | NOT NULL, default now() | |

### Indexes:
- `idx_prompt_exec_build` ON (build_run_id)
- `idx_prompt_exec_status` ON (status)
- `idx_prompt_exec_hash` ON (prompt_hash)

---

## Table: error_patterns
Generalized error patterns extracted across all builds.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | uuid | PK, default gen_random_uuid() | Pattern identifier |
| error_signature | text | NOT NULL, UNIQUE | Normalized error string |
| error_category | text | NOT NULL | type_error, build_failure, runtime, schema, auth, dependency, config |
| error_message_sample | text | NOT NULL | Example error message |
| occurrence_count | int | NOT NULL, default 1 | Times seen |
| first_seen_at | timestamptz | NOT NULL, default now() | First occurrence |
| last_seen_at | timestamptz | NOT NULL, default now() | Most recent |
| first_seen_project | text | NOT NULL | Project that first encountered |
| stack_fingerprints | jsonb | NOT NULL, default '[]' | Stacks that trigger this |
| trigger_phase | text | | Phase that typically triggers (phase3, phase4) |
| trigger_prompt_pattern | text | | Prompt type that triggers (schema, auth, ui) |
| resolution_id | uuid | FK -> resolutions(id) | Linked resolution |
| prevention_rule | text | | Instruction to prevent recurrence |
| success_rate | numeric(5,4) | NOT NULL, default 0 | Resolution success % |
| auto_resolve_eligible | boolean | NOT NULL, default false | >90% success = eligible |
| created_at | timestamptz | NOT NULL, default now() | |
| updated_at | timestamptz | NOT NULL, default now() | |

### Indexes:
- `idx_error_sig` ON (error_signature)
- `idx_error_cat` ON (error_category)
- `idx_error_auto` ON (auto_resolve_eligible) WHERE auto_resolve_eligible = true

---

## Table: resolutions
Proven fixes for error patterns.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | uuid | PK, default gen_random_uuid() | Resolution identifier |
| error_pattern_id | uuid | FK -> error_patterns(id), NOT NULL | Linked error |
| resolution_type | text | NOT NULL | prompt_rewrite, config_change, dependency_fix, code_patch, manual |
| resolution_description | text | NOT NULL | Human-readable description |
| resolution_steps | jsonb | NOT NULL | Structured steps to apply |
| times_applied | int | NOT NULL, default 0 | Application count |
| times_succeeded | int | NOT NULL, default 0 | Success count |
| times_failed | int | NOT NULL, default 0 | Failure count |
| created_at | timestamptz | NOT NULL, default now() | |

---

## Table: governance_versions
Version history of FORGE governance templates.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | uuid | PK, default gen_random_uuid() | Version identifier |
| template_name | text | NOT NULL | BLUEPRINT.md, SCHEMA_REGISTRY.md, etc. |
| version_number | int | NOT NULL | Sequential version |
| content_hash | text | NOT NULL | SHA-256 of content |
| content_snapshot | text | NOT NULL | Full content at this version |
| changes_description | text | | What changed |
| change_source | text | NOT NULL | manual, recursive_learner, error_prevention |
| effectiveness_score | numeric(5,4) | | Scored by Phase 5 analysis |
| builds_used_in | int | NOT NULL, default 0 | Builds using this version |
| created_at | timestamptz | NOT NULL, default now() | |

### Indexes:
- `idx_gov_template` ON (template_name, version_number)

### Constraint:
- UNIQUE (template_name, version_number)

---

## Table: self_created_agents
Agents FORGE creates for itself through recursive learning.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | uuid | PK, default gen_random_uuid() | Agent identifier |
| name | text | NOT NULL, UNIQUE | Agent name |
| purpose | text | NOT NULL | What this agent does |
| trigger_conditions | jsonb | NOT NULL | When this agent activates |
| input_contract | jsonb | NOT NULL | Expected inputs |
| output_contract | jsonb | NOT NULL | Expected outputs |
| implementation_code | text | NOT NULL | Generated TypeScript source |
| source_pattern_description | text | NOT NULL | Pattern that motivated creation |
| test_results | jsonb | NOT NULL, default '{}' | Test outcomes |
| status | text | NOT NULL, default 'proposed' | proposed, approved, active, deprecated |
| approved_at | timestamptz | | When human approved |
| builds_used_in | int | NOT NULL, default 0 | Usage count |
| effectiveness_score | numeric(5,4) | | Performance rating |
| created_at | timestamptz | NOT NULL, default now() | |
| updated_at | timestamptz | NOT NULL, default now() | |

---

## Table: cross_project_insights
Learnings transferable between projects.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | uuid | PK, default gen_random_uuid() | Insight identifier |
| insight_type | text | NOT NULL | pattern, prevention, optimization, template_change |
| source_project | text | NOT NULL | Originating project |
| source_build_id | uuid | FK -> build_runs(id) | Originating build |
| applicable_fingerprints | jsonb | NOT NULL, default '[]' | Which stacks benefit |
| description | text | NOT NULL | Human-readable insight |
| evidence | jsonb | NOT NULL | Data supporting this insight |
| applied_count | int | NOT NULL, default 0 | Times used elsewhere |
| effectiveness_score | numeric(5,4) | | Effectiveness when applied |
| created_at | timestamptz | NOT NULL, default now() | |

---

## Table: production_telemetry
Runtime data from deployed applications.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | uuid | PK, default gen_random_uuid() | Event identifier |
| project_name | text | NOT NULL | Deployed app name |
| build_run_id | uuid | FK -> build_runs(id) | Build that produced this app |
| event_type | text | NOT NULL | error, performance, usage, feedback |
| event_data | jsonb | NOT NULL | Full event payload |
| severity | text | | critical, warning, info |
| captured_at | timestamptz | NOT NULL | When event occurred |
| fed_back_to_build | uuid | FK -> build_runs(id) | If informed subsequent build |
| created_at | timestamptz | NOT NULL, default now() | |

### Indexes:
- `idx_telemetry_project` ON (project_name)
- `idx_telemetry_type` ON (event_type)
- `idx_telemetry_severity` ON (severity) WHERE severity = 'critical'

---

## Table: stack_profiles
Reusable technology stack definitions.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | uuid | PK, default gen_random_uuid() | Profile identifier |
| name | text | NOT NULL, UNIQUE | Profile name (nextjs-supabase, python-fastapi) |
| description | text | NOT NULL | Human description |
| stack_definition | jsonb | NOT NULL | Framework, DB, deploy target, pkg manager, etc. |
| toolchain_requirements | jsonb | NOT NULL | Required CLIs and packages |
| governance_template_set | text | NOT NULL | Which template set to use |
| sentinel_checks | jsonb | NOT NULL | Phase 4 health check config |
| build_commands | jsonb | NOT NULL | Build/deploy command sequences |
| builds_completed | int | NOT NULL, default 0 | Projects built with this profile |
| created_at | timestamptz | NOT NULL, default now() | |

---

## Table: design_patterns
Reusable UI/UX and architectural patterns from successful builds.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | uuid | PK, default gen_random_uuid() | Pattern identifier |
| pattern_type | text | NOT NULL | ui_component, auth_flow, schema_pattern, api_pattern |
| name | text | NOT NULL | Human-readable name |
| description | text | NOT NULL | What this pattern does |
| source_project | text | NOT NULL | Where it was first used |
| specification | jsonb | NOT NULL | Full pattern definition |
| usage_count | int | NOT NULL, default 0 | Times reused |
| effectiveness_score | numeric(5,4) | | Quality rating |
| created_at | timestamptz | NOT NULL, default now() | |

---

## Table: brand_identities
Persistent design tokens per brand/project.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | uuid | PK, default gen_random_uuid() | Identity identifier |
| project_name | text | NOT NULL, UNIQUE | Project this belongs to |
| brand_name | text | NOT NULL | Display brand name |
| design_tokens | jsonb | NOT NULL | Colors, typography, spacing, shadows, radii |
| component_styles | jsonb | NOT NULL, default '{}' | Brand-specific component overrides |
| created_at | timestamptz | NOT NULL, default now() | |
| updated_at | timestamptz | NOT NULL, default now() | |

---

## Seed Data: Pre-loaded Error Patterns

The following error patterns are seeded into error_patterns on initialization:

1. **powershell_execution_policy** — PowerShell execution policy blocks script execution. Prevention: Phase 0 runs `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`. Success rate: 100%.

2. **typescript_baseurl_deprecated** — TypeScript 7.0 deprecates baseUrl in tsconfig.json. Prevention: Generate tsconfig without baseUrl, use paths with explicit prefixes. Success rate: 100%.

3. **jsyaml_temp_directory** — js-yaml fails when temp scripts write to $env:TEMP instead of working directory. Prevention: Enforce all file writes to project working directory in prompt text. Success rate: 95%.

4. **node_path_missing** — Node.js not found in PATH on new machine. Prevention: Phase 0 validates and prepends `C:\Program Files\nodejs` to $env:PATH. Success rate: 100%.

5. **middleware_role_default** — Middleware role fetch failure shows wrong role page instead of /login. Prevention: BEHAVIORAL_CONTRACTS mandates /login-only fallback on any role fetch failure. Success rate: 100%.

6. **html_assumed_rendered** — HTML files in public/ assumed to be the rendered output when actual render comes from .tsx components. Prevention: Every prompt includes Select-String verification across *.tsx,*.ts,*.html to confirm which file renders. Success rate: 90%.

7. **vercel_cdn_stale** — Vercel CDN caches stale dashboard HTML. Prevention: All dashboard HTML served via no-cache API routes, never directly from public/. Success rate: 100%.

8. **supabase_rls_blocks** — RLS policies block legitimate queries because testing didn't account for company_id context. Prevention: Test all RLS policies with seed data before building UI that depends on them. Success rate: 85%.

9. **missing_env_vars** — Application crashes at runtime due to missing environment variables. Prevention: Phase 0 verifies every required env var is present before build starts. Success rate: 100%.

10. **pnpm_lockfile_conflict** — pnpm lockfile conflicts when switching between machines. Prevention: Delete lockfile and run fresh pnpm install in Phase 0 on each machine. Success rate: 95%.

---

## SQLite Learning Database Tables (forge_memory.db)

The following tables live in `~/.forge/forge_memory.db` (local SQLite, not Supabase). Added in Run 4.

### Table: adversary_findings
Tracks adversarial review findings for resolution and accuracy measurement.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | UUID record identifier |
| build_id | TEXT | NOT NULL | Build that triggered the review |
| phase | TEXT | NOT NULL | Review phase (SCAN, DIAGNOSE, etc.) |
| severity | TEXT | NOT NULL, CHECK IN ('BLOCKER','SIGNIFICANT','MINOR','DISMISSED') | Finding severity |
| vector | TEXT | | Attack or failure vector (nullable) |
| issue | TEXT | NOT NULL | Description of the finding |
| fix | TEXT | | Proposed or applied fix (nullable) |
| resolution | TEXT | NOT NULL DEFAULT 'PENDING', CHECK IN ('PENDING','FIXED','DISMISSED','DEFERRED') | Current resolution status |
| resolved_at | TEXT | | ISO 8601 timestamp when resolved (nullable) |
| machine_id | TEXT | NOT NULL | Machine that generated the finding |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |

#### Indexes:
- `idx_adversary_build` ON (build_id)
- `idx_adversary_severity` ON (severity)

---

### Table: build_fingerprints
Tracks project state hashes for integrity verification between runs.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | UUID record identifier |
| build_id | TEXT | NOT NULL | Build run this fingerprint belongs to |
| project_name | TEXT | NOT NULL | Project being fingerprinted |
| fingerprint | TEXT | NOT NULL | SHA-256 hash of project file state |
| file_count | INTEGER | NOT NULL DEFAULT 0 | Number of files in the project |
| total_size_kb | REAL | NOT NULL DEFAULT 0 | Total project size in kilobytes |
| computed_at | TEXT | NOT NULL DEFAULT (datetime('now')) | When the fingerprint was computed |
| machine_id | TEXT | NOT NULL | Machine that computed the fingerprint |

#### Indexes:
- `idx_fingerprints_build` ON (build_id)
- `idx_fingerprints_project` ON (project_name)

---

### Table: hook_execution_log
Logs every hook execution for performance analysis and evolution proposals.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | UUID record identifier |
| hook_name | TEXT | NOT NULL | Name of the hook (e.g. PreToolUse, SessionStart) |
| event | TEXT | NOT NULL | Lifecycle event that triggered the hook |
| status | TEXT | NOT NULL, CHECK IN ('PASS','FAIL','TIMEOUT','SKIP') | Execution outcome |
| duration_ms | INTEGER | NOT NULL | Execution time in milliseconds |
| output | TEXT | | Captured hook output (nullable) |
| build_id | TEXT | NOT NULL | Build run this execution belongs to |
| prompt_number | INTEGER | | Prompt index within the build (nullable) |
| machine_id | TEXT | NOT NULL | Machine that executed the hook |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |

#### Indexes:
- `idx_hook_log_build` ON (build_id)
- `idx_hook_log_name` ON (hook_name, status)
- `idx_hook_log_duration` ON (duration_ms DESC)

---

### Table: compact_snapshots
PreCompact hook saves critical context here before Claude's context compaction so it can be re-injected on resume.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | UUID record identifier |
| build_id | TEXT | NOT NULL | Build run this snapshot belongs to |
| prompt_index | INTEGER | NOT NULL | Prompt position at the time of compaction |
| state_json | TEXT | NOT NULL | Full serialized session state as JSON |
| machine_id | TEXT | NOT NULL | Machine that created the snapshot |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |

#### Indexes:
- `idx_compact_build` ON (build_id, prompt_index DESC)

---

### Table: decision_weights
Tracks architectural decision outcomes for Loop 3 (Architecture Decision Weighting). The Architect queries this before recommending tech stack choices.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | UUID record identifier |
| decision_type | TEXT | NOT NULL | Category of decision (e.g. orm, auth, state-management) |
| option_chosen | TEXT | NOT NULL | The specific option selected (e.g. prisma, supabase-auth, zustand) |
| downstream_error_rate | REAL | NOT NULL DEFAULT 0.0 | Fraction of downstream prompts that errored |
| downstream_retry_rate | REAL | NOT NULL DEFAULT 0.0 | Fraction of downstream prompts that required retry |
| downstream_prompts | INTEGER | NOT NULL DEFAULT 0 | Total downstream prompts attributed to this decision |
| downstream_errors | INTEGER | NOT NULL DEFAULT 0 | Absolute error count after this decision |
| downstream_retries | INTEGER | NOT NULL DEFAULT 0 | Absolute retry count after this decision |
| sample_size | INTEGER | NOT NULL DEFAULT 1 | Number of builds where this decision was made |
| project_name | TEXT | NOT NULL | Project that made the decision |
| build_id | TEXT | NOT NULL | Build run where the decision was recorded |
| machine_id | TEXT | NOT NULL | Machine that recorded the decision |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |

#### Indexes:
- `idx_decision_weights_type` ON (decision_type, option_chosen)
- `idx_decision_weights_error_rate` ON (downstream_error_rate ASC)
