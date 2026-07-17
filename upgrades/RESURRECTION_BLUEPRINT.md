# FORGE 2.0 — BLUEPRINT

## System 1: Resurrection and Gap Intelligence Engine

> Companion to `upgrades/RESURRECTION_PRD.md`. Reads `upgrades/SCHEMA_ADDITIONS.md` as the
> authoritative schema contract: this system reads and writes exactly the columns of
> `gap_audit_runs` and `artifact_health_scores` defined there — no invented columns, no new
> tables. All Build Memory persistence targets the single-operator SQLite file
> `~/.forge/forge_memory.db` (`src/learning/database.ts`); there is no Postgres, no Supabase, no
> RLS anywhere in this system (SCHEMA_ADDITIONS §7).

## System Identity
- **Name:** Resurrection and Gap Intelligence Engine (FORGE System 1)
- **Purpose:** Audit a halted/in-progress/drifted project's governance against its code, score
  each artifact, auto-regenerate the safe gaps, human-gate the architectural ones, and
  reconstruct the exact halt point for resume.
- **Extends:** Root PRD **F10** (Project Autopsy + Resurrection) — the halted-build case, not the
  fully-abandoned case.
- **Repository:** Reid64/forge-2
- **Primary Stack:** Node.js, TypeScript (strict), better-sqlite3 Build Memory, PowerShell (Windows)
- **Package Manager:** pnpm
- **Runtime:** Node.js 20+
- **Reuse mandate (Iron Law 5 of the PRD, R5):** all codebase scanning is delegated to
  ForgeRetrofit (`src/retrofit/`). This system adds no second scanner.

## Architecture Overview

System 1 is a higher-level **orchestration layer** over ForgeRetrofit. ForgeRetrofit answers
"what does this codebase contain and where are its structural problems" (14 SCAN ops → 3 DIAGNOSE
reports → Model-C RECONCILE → tier-ordered queue). System 1 consumes ForgeRetrofit's
`ScanReport` and DIAGNOSE reports and answers three questions ForgeRetrofit does not:

1. **Content completeness of governance docs.** ForgeRetrofit's SCAN op 10
   (`inventoryGovernanceDocs`) only knows a doc's presence and mtime staleness
   (`GovernanceDocEntry`). System 1 scores completeness, freshness (drift vs. the `ScanReport`),
   and cross-doc consistency for all nine artifacts.
2. **Autonomous regeneration.** ForgeRetrofit only *detects* and *queues* fixes; it never
   rewrites a governance doc. System 1's `RegenerationEngine` writes corrected docs for AUTO-tier
   gaps, between phases only.
3. **Exact halt-point continuation.** ForgeRetrofit has no concept of "resume from where a build
   stopped." System 1 reconstructs `{buildRunId, promptIndex, promptName, failingCheck,
   subStepIndex}` and emits a continuation plan.

The four agents run as a strict pipeline: `GapAuditor` (orchestrator, read-only) →
`ArtifactHealthScorer` (read-only) → `RegenerationEngine` (writes AUTO docs) +
`HumanGateEvaluator` (gates CRITICAL/HUMAN_GATE) → continuation plan → hand back to
`forge resurrect --resume`.

### Core Components
1. **GapAuditor** — orchestrator. Wraps ForgeRetrofit's `runScan`/DIAGNOSE, runs governance gap
   detection, writes the `gap_audit_runs` row, reconstructs the halt point. Read-only (R1).
2. **ArtifactHealthScorer** — scores each of the nine artifacts; writes one
   `artifact_health_scores` row per artifact. Read-only (R1).
3. **RegenerationEngine** — regenerates AUTO-tier artifacts on disk, between phases only (R3).
4. **HumanGateEvaluator** — presents CRITICAL/HUMAN_GATE-tier gaps for approve/decline; halts for
   human in non-interactive mode (R4).
5. **Continuation planner** — a sub-module of `GapAuditor` that turns the halt point + gate/regen
   outcomes into the ordered `continuation_plan`.

### Project Structure

New files under `src/resurrection/`, following the existing `src/retrofit/` file-per-concern
pattern. Plus one new Build Memory CRUD module under `src/memory/`.

```
forge-2/
├── src/
│   ├── resurrection/
│   │   ├── index.ts               # Public API — re-exports runGapAudit, runResurrectResume
│   │   ├── types.ts               # GapAuditOptions, GapAuditResult, ArtifactScore, HaltPoint,
│   │   │                          #   ContinuationStep, Gap, GapSeverity, RegenerationTier
│   │   ├── gap-auditor.ts         # GapAuditor — orchestrator (Entry Point for `forge audit`)
│   │   ├── governance-gaps.ts     # F21 content gap detection: required-section, drift, placeholder,
│   │   │                          #   cross-doc consistency checks per artifact (nine detectors)
│   │   ├── artifact-scorer.ts     # ArtifactHealthScorer — the weighted composite_score formula
│   │   ├── regeneration-engine.ts # RegenerationEngine — AUTO-tier full-file/section regeneration
│   │   ├── human-gate.ts          # HumanGateEvaluator — CLI gate, non-interactive halt behavior
│   │   ├── halt-reconstructor.ts  # F24 — reads Build Memory + preserved branch → HaltPoint
│   │   └── continuation-planner.ts# Builds ContinuationStep[] → gap_audit_runs.continuation_plan
│   └── memory/
│       └── gap-audits.ts          # CRUD for gap_audit_runs + artifact_health_scores (better-sqlite3)
└── (existing tree unchanged)
```

## Technology Decisions
- **No new scanner.** `src/resurrection/` imports `runScan`, `runRetrofitPipeline`, and the
  DIAGNOSE builders from `src/retrofit/`. It never re-implements a filesystem walk (R5).
- **better-sqlite3 CRUD.** `src/memory/gap-audits.ts` follows the `src/memory/builds.ts` reference
  shape — typed insert/get/list functions wrapping prepared statements, no raw SQL outside the
  module (SCHEMA_ADDITIONS §8.4). JSON columns are `JSON.stringify`'d on write, `JSON.parse`'d on
  read (SCHEMA_ADDITIONS §0).
- **readline gate, matching reconcile.ts.** `HumanGateEvaluator`'s interactive gate reuses the
  `createInterface({ input: process.stdin, output: process.stdout })` + boxed-header pattern from
  `src/retrofit/reconcile.ts`, and honors `--non-interactive` — but with gate-halt semantics
  (§HumanGateEvaluator), not auto-approve.
- **Claude for regeneration content.** `RegenerationEngine` uses the existing Claude runner
  (`src/engine/claude-runner.ts`) to draft regenerated doc content, exactly as Phase 2 governance
  generation does; it never templates a placeholder doc (Iron Law 5/8 — no placeholder content).
- **crypto.randomUUID() PKs.** All row ids are generated in application code (SQLite has no
  `gen_random_uuid()`; SCHEMA_ADDITIONS §0).

## Environment Variables
No new environment variables. System 1 reuses the existing set (`FORGE_MACHINE_ID`,
`ANTHROPIC_API_KEY`, and the Build Memory path resolved by `getForgeDbPath()`). The Build Memory
file is `~/.forge/forge_memory.db`; no override variable is introduced.

---

## Agent: GapAuditor (src/resurrection/gap-auditor.ts)

- **Purpose:** Orchestrate a full gap audit. Wrap ForgeRetrofit's SCAN + DIAGNOSE, run the nine
  governance gap detectors, drive `ArtifactHealthScorer`, dispatch AUTO gaps to
  `RegenerationEngine` and CRITICAL/HUMAN_GATE gaps to `HumanGateEvaluator`, reconstruct the halt
  point, write the continuation plan, and persist one `gap_audit_runs` row for the whole pass.
  Strictly read-only itself (R1) — it never writes to a governance file; only `RegenerationEngine`
  does.
- **Status:** NOT_STARTED
- **CLI:** `forge audit <project-path> [--scope FULL|GOVERNANCE_ONLY|CODE_ONLY|TARGETED] [--halt-recovery] [--non-interactive] [--api-key <key>]`
- **Entry Point:** `src/resurrection/gap-auditor.ts` → `runGapAudit(options: GapAuditOptions): Promise<GapAuditResult>`
- **Exports:** `runGapAudit`, `GapAuditOptions`, `GapAuditResult`
- **Dependencies:**
  - ForgeRetrofit — `runScan` (`src/retrofit/scan.ts`), `generateArchitectureHealthReport`,
    `buildGovernanceReconciliationReport`, `buildEnterprisePatternsGapReport`
    (`src/retrofit/diagnose.ts`), and `runRetrofitPipeline` (`src/retrofit/reconcile.ts`) for the
    `retrofit_entry` trigger.
  - `src/resurrection/governance-gaps.ts`, `artifact-scorer.ts`, `regeneration-engine.ts`,
    `human-gate.ts`, `halt-reconstructor.ts`, `continuation-planner.ts`.
  - `src/memory/gap-audits.ts` (CRUD), `src/learning/database.ts` (`getForgeDbPath`, `machine_id`).
- **Database tables:**
  - `gap_audit_runs` — **write** (one row per invocation: insert `running`, update to
    `completed`/`failed`/`halted_for_human`).
  - `artifact_health_scores` — **write** (delegated to `ArtifactHealthScorer`, same audit id).
  - `scan_reports` / `reconcile_decisions` — **read** (via ForgeRetrofit's existing accessors;
    `.forge/scan_report.json` and the `reconcile_decisions` table).
  - `build_runs`, `prompt_executions` — **read** (halt reconstruction).

### Files

| File | Purpose |
|------|---------|
| `src/resurrection/gap-auditor.ts` | Orchestrator: scan → detect → score → regen/gate → plan → persist |
| `src/resurrection/governance-gaps.ts` | Nine per-artifact content gap detectors (F21) |
| `src/resurrection/types.ts` | All System 1 type definitions |

### CLI scope semantics

| `--scope` | ForgeRetrofit scan scope | Artifacts scored | Halt reconstruction |
|---|---|---|---|
| `FULL` | `C` (codebase + DB + Vercel) | all 9 | if `--halt-recovery` |
| `GOVERNANCE_ONLY` | `A` (codebase only, for drift refs) | all 9 | no |
| `CODE_ONLY` | `A` | none (audit is code-structural only) | no |
| `TARGETED` | `A` | only artifacts touched by the halt point | yes (implies `--halt-recovery`) |

### Orchestration algorithm (deterministic order)
1. `insert gap_audit_runs` with `status='running'`, `audit_trigger`, `scope`, `machine_id`.
2. Call `runScan({ projectPath, scope })` → `ScanReport` (also refreshes `.forge/scan_report.json`).
3. Call the three DIAGNOSE builders for the code-structural findings.
4. For each in-scope artifact, call the matching detector in `governance-gaps.ts` → `Gap[]`.
5. `ArtifactHealthScorer.scoreAll(...)` → one `artifact_health_scores` row per artifact; compute
   `health_score_before` = mean `composite_score`.
6. Partition gaps by `regeneration_tier`: AUTO → `RegenerationEngine`; HUMAN_GATE →
   `HumanGateEvaluator`.
7. If `--halt-recovery`: `haltReconstructor.reconstruct(buildRunId?)` → `HaltPoint`; set
   `halt_point_reference`.
8. `continuationPlanner.build(...)` → `continuation_plan`.
9. Re-score regenerated artifacts; set `health_score_after`.
10. Update `gap_audit_runs`: counts, `status`, `completed_at`, `duration_ms`, `report_path`
    (`.forge/gap_audit_report.md`).

---

## Agent: ArtifactHealthScorer (src/resurrection/artifact-scorer.ts)

- **Purpose:** Score each governance artifact on completeness, freshness, and consistency, roll
  them into one `composite_score`, decide whether regeneration is recommended and, if so, into
  which tier. Write one `artifact_health_scores` row per artifact per audit. Read-only (R1).
- **Status:** NOT_STARTED
- **CLI:** none (invoked by `GapAuditor`; results visible via `forge health` and the audit report).
- **Entry Point:** `src/resurrection/artifact-scorer.ts` → `scoreArtifact(...)`, `scoreAll(...)`
- **Exports:** `scoreArtifact`, `scoreAll`, `ArtifactScore`, `COMPOSITE_WEIGHTS`, `REGEN_THRESHOLDS`
- **Dependencies:** `governance-gaps.ts` (the `Gap[]` per artifact), `ScanReport` (drift refs),
  `src/memory/gap-audits.ts` (write).
- **Database tables:** `artifact_health_scores` — **write**; `gap_audit_runs` — **read** (parent id).

### The `composite_score` formula (exact, implementable)

```
composite_score = 0.45 * completeness_score
                + 0.35 * freshness_score
                + 0.20 * consistency_score
```

`COMPOSITE_WEIGHTS = { completeness: 0.45, freshness: 0.35, consistency: 0.20 }` — sums to
**1.0**. All three sub-scores and the composite are clamped to `[0.0, 1.0]` to satisfy the
`CHECK BETWEEN 0 AND 1` constraints on all four columns.

**Weight justification.**
- **Completeness 0.45 (highest).** A doc missing whole required sections cannot be trusted at
  all — you cannot resume against a `SCHEMA_REGISTRY.md` that omits tables the code uses. Absence
  of content is the most severe defect, so it carries the most weight.
- **Freshness 0.35 (second).** Drift vs. the actual codebase is the primary failure mode the PRD
  problem statement describes (docs drift from code). A present-but-stale doc is dangerous but at
  least structurally complete, so it ranks just below completeness.
- **Consistency 0.20 (lowest).** Cross-document contradictions are the rarest class and are
  frequently a downstream symptom of a completeness or freshness defect already captured above;
  weighting it lower avoids double-counting the same root cause.

### Sub-score definitions (each maps to a stored column)
- `completeness_score` = `(required_sections_present) / (required_sections_total)` for the
  artifact (per the F21 required-section lists), penalized by `placeholder_count` — subtract
  `0.05` per placeholder occurrence, floored at `0`. Missing sections populate `missing_sections`.
- `freshness_score` = `1 - (drift_entries / drift_checks_total)` for the artifact; `drift_detail`
  stores the `{section, docSays, codeShows}` entries; `drift_detected = 1` iff `drift_entries > 0`.
- `consistency_score` = `1 - (contradiction_count / consistency_checks_total)` across cross-doc
  checks (e.g. a table named in `SCHEMA_REGISTRY.md` but with no matching agent in `AGENTS.md`).
- `exists_on_disk = 0` forces `completeness_score = freshness_score = consistency_score =
  composite_score = 0` and marks the artifact CRITICAL (absent doc → gate).

### Regeneration thresholds (exact)

```
REGEN_THRESHOLDS = { AUTO_BELOW: 0.5, GATE_BELOW: 0.3, RESUME_FLOOR: 0.7 }
```

Decision, evaluated per artifact after `composite_score` is computed:
- `composite_score >= 0.5` and no CRITICAL gap → `regeneration_recommended = 0`,
  `regeneration_tier = NULL` (healthy; leave it alone).
- `0.3 <= composite_score < 0.5` and no CRITICAL gap → `regeneration_recommended = 1`,
  `regeneration_tier = 'AUTO'`.
- `composite_score < 0.3` **or** the artifact carries **any CRITICAL gap** →
  `regeneration_recommended = 1`, `regeneration_tier = 'HUMAN_GATE'`.
- Any MINOR-only gap on an otherwise-healthy doc → `AUTO` (MINOR is never gated, PRD Gap Severity).

The `RESUME_FLOOR = 0.7` is enforced by `GapAuditor`/`forge resurrect --resume`, not stored per
row: a build may resume only when mean `composite_score >= 0.70` and `gap_audit_runs.gaps_critical
= 0` (R8).

---

## Agent: RegenerationEngine (src/resurrection/regeneration-engine.ts)

- **Purpose:** Regenerate every artifact whose `artifact_health_scores.regeneration_tier = 'AUTO'`,
  writing a corrected governance doc to disk and incrementing
  `gap_audit_runs.gaps_auto_regenerated`. The **only** component in System 1 that writes to a
  governance file.
- **Status:** NOT_STARTED
- **CLI:** none (invoked by `GapAuditor`).
- **Entry Point:** `src/resurrection/regeneration-engine.ts` → `regenerate(artifact, score, scanReport, gaps): Promise<RegenResult>`
- **Exports:** `regenerate`, `regenerateAll`, `RegenResult`, `WHOLESALE_ARTIFACTS`, `SECTION_SCOPED_ARTIFACTS`
- **Dependencies:** `src/engine/claude-runner.ts` (draft content), `ScanReport` (ground truth for
  regenerated content), `src/memory/gap-audits.ts` (update counts).
- **Database tables:** `artifact_health_scores` — **read** (`regeneration_tier`, `missing_sections`,
  `drift_detail`); `gap_audit_runs` — **read/write** (`gaps_auto_regenerated`, `health_score_after`).

### AUTO vs. HUMAN_GATE decision
`RegenerationEngine` acts on an artifact **only** if its stored `regeneration_tier` is `'AUTO'`.
It never re-evaluates severity — that decision was made by `ArtifactHealthScorer` and is authoritative
(R4). A `'HUMAN_GATE'` artifact is skipped here and handled entirely by `HumanGateEvaluator`; only
after a human approves does that artifact's regeneration run through this same engine.

### What it writes back (per-artifact strategy)
- **Wholesale (full-file replacement)** — `WHOLESALE_ARTIFACTS = ['SESSION_STATE',
  'STATE_OF_THE_BUILD', 'TOOLCHAIN']`. FORGE fully owns these formats and derives them
  deterministically from Build Memory + the `ScanReport` (last completed prompt index, current
  file tree, installed tool versions). They are rewritten in full. This mirrors Iron Law 4's
  full-file-not-patch principle where FORGE owns the whole file.
- **Section-scoped (patch the drifted region, preserve human prose)** — `SECTION_SCOPED_ARTIFACTS
  = ['PRD', 'BLUEPRINT', 'BEHAVIORAL_CONTRACTS', 'SCHEMA_REGISTRY', 'AGENTS', 'TESTING']`. These
  contain human narrative and intent that must be preserved; the engine only rewrites the specific
  `missing_sections` and `drift_detail` regions, leaving the rest byte-for-byte intact. It never
  regenerates one of these wholesale.

### Contract 3 guard (R3, non-negotiable)
Before any write, `RegenerationEngine` checks whether the project is currently in Phase 3
(`build_runs` row for this project has an in-flight, non-terminal build). **If so, it writes
nothing**, records the refusal in the audit report, and leaves `gaps_auto_regenerated` unchanged
— governance docs are immutable during execution (Contract 3 / Iron Law 1). Regeneration is
permitted only between builds/phases. After each successful write, the artifact is re-scored and
`health_score_after` reflects the improvement (must be strictly greater than `health_score_before`
for that artifact, or the regeneration is reported as failed, not silently accepted — Iron Law 3).

---

## Agent: HumanGateEvaluator (src/resurrection/human-gate.ts)

- **Purpose:** The **fifth, structural** human gate (in addition to Contract 2's four). Present
  every CRITICAL/HUMAN_GATE-tier gap to the operator for an approve/decline decision before any
  regeneration touches that artifact; in non-interactive mode, defer and halt for human. Route
  counts to `gap_audit_runs.gaps_human_gated`.
- **Status:** NOT_STARTED
- **CLI:** none directly — it is the interactive layer of `forge audit`/`forge resurrect`; it
  reads the same `--non-interactive` flag the commands pass through.
- **Entry Point:** `src/resurrection/human-gate.ts` → `evaluateGates(gates: Gap[], opts): Promise<GateOutcome>`
- **Exports:** `evaluateGates`, `GateOutcome`, `isArchitecturalGap`
- **Dependencies:** `readline` (interactive prompt, reconcile.ts pattern), `src/memory/gap-audits.ts`.
- **Database tables:** `artifact_health_scores` — **read** (`regeneration_tier = 'HUMAN_GATE'`
  rows); `gap_audit_runs` — **write** (`gaps_human_gated`, `status = 'halted_for_human'`).

### Exactly what escalates (ties to the PRD's CRITICAL definition)
`isArchitecturalGap(gap)` returns true — and the gap is gated — iff it matches one of the three
concrete CRITICAL conditions:
1. A table in `ScanReport.schemaAudit` absent from `SCHEMA_REGISTRY.md` with no migration file.
2. A governance doc entirely absent (`exists_on_disk = 0`).
3. A `BEHAVIORAL_CONTRACTS.md`-vs-code contradiction on a Contract 1–20 item.

Additionally, any MAJOR gap on an artifact with `composite_score < 0.3` is gated (that artifact is
too degraded to auto-trust). MINOR gaps are **never** gated.

### Gate presentation (interactive)
Reuses the `reconcile.ts` boxed-header + `readline.question` idiom:

```
╔══════════════════════════════════════════════╗
  FORGE 2.0 — RESURRECTION HUMAN GATE (5th gate)
╚══════════════════════════════════════════════╝

  [ARCHITECTURAL GAP 1/3]  Artifact: SCHEMA_REGISTRY
  Gap: Table `payments` is queried in src/api/checkout.ts but is
       absent from SCHEMA_REGISTRY.md and has no migration file.
  If approved, FORGE will add a `payments` section to SCHEMA_REGISTRY.md
  reconstructed from the code's actual usage. It will NOT create the table.
  Approve regeneration of this section? (y/N) >
```

Each answer is recorded; `y` → the artifact's section is queued for `RegenerationEngine`; anything
else → declined and left untouched (the gap remains, reported in `.forge/gap_audit_report.md`).

### Non-interactive behavior (matches reconcile.ts's `--non-interactive`, with gate semantics)
Unlike `reconcile.ts`, which auto-**approves** WARN-tier fixes in `--non-interactive` mode, the
resurrection gate must never auto-approve an architectural change (that would defeat the gate's
purpose and violate its "structural, not configurable" nature). In `--non-interactive` mode
`HumanGateEvaluator` **defers** every gated gap, writes them to the continuation plan as
`REQUIRES_HUMAN` steps, sets `gap_audit_runs.status = 'halted_for_human'`, and returns without
regenerating any gated artifact. The operator re-runs `forge audit` interactively (or
`forge resurrect --resume` without `--non-interactive`) to clear the gate. The gate cannot be
disabled by any flag or environment variable (R4; Contract 2 philosophy).

---

## Data Flow

```
                          forge audit <path> [--halt-recovery]
                                        │
                                        ▼
   (1) GapAuditor: insert gap_audit_runs (status='running', machine_id, scope, trigger)
                                        │
                                        ▼
   (2) GapAuditor → ForgeRetrofit.runScan(scope)  ───────────►  ScanReport (+ .forge/scan_report.json)
        GapAuditor → DIAGNOSE builders (arch health / gov reconciliation / enterprise gaps)
                                        │
                                        ▼
   (3) governance-gaps.ts: 9 per-artifact detectors → Gap[]  (missing_sections, drift, placeholders,
                                        │                        cross-doc contradictions)
                                        ▼
   (4) ArtifactHealthScorer.scoreAll → 1 artifact_health_scores row / artifact
        composite = 0.45*completeness + 0.35*freshness + 0.20*consistency
        set regeneration_tier (AUTO | HUMAN_GATE | NULL);  health_score_before = mean(composite)
                                        │
                    ┌───────────────────┴───────────────────┐
                    ▼                                        ▼
   (5) RegenerationEngine (AUTO tier)              (6) HumanGateEvaluator (HUMAN_GATE tier)
        Contract-3 guard: skip if in Phase 3            isArchitecturalGap? → gate prompt
        wholesale | section-scoped write                interactive: y/N per gap
        gaps_auto_regenerated++                         non-interactive: defer + halt_for_human
                    │                                        │  gaps_human_gated++
                    └───────────────────┬───────────────────┘
                                        ▼
   (7) halt-reconstructor (if --halt-recovery): read build_runs + prompt_executions + preserved
        feature branch → HaltPoint {buildRunId, promptIndex, promptName, failingCheck, subStepIndex}
        → gap_audit_runs.halt_point_reference
                                        │
                                        ▼
   (8) continuation-planner: ordered ContinuationStep[] (resume prompt, deferred gates)
        → gap_audit_runs.continuation_plan;  re-score regenerated artifacts → health_score_after
                                        │
                                        ▼
   (9) GapAuditor: update gap_audit_runs (counts, status=completed|halted_for_human, duration_ms,
        report_path=.forge/gap_audit_report.md)
                                        │
                                        ▼
  (10) forge resurrect --resume: read continuation_plan → hand resume point (start-at = promptIndex)
        to Phase 3 executor  (only if mean composite >= 0.70 AND gaps_critical = 0)
```

## Halt-point reconstruction (F24 detail)

`halt-reconstructor.ts` reconstructs the five load-bearing facts entirely from real state (R2 —
never guessed):
- **build_run_id** — the halted `build_runs.id` (passed in, or the latest non-terminal build for
  the project).
- **feature branch name** — read from git (`git branch --list 'forge/<build-id>/*'`); the
  preserved branch, e.g. `forge/3736ff33-.../prompt-5-ui-shell-layouts-design-tokens`.
- **prompt index** — the last non-`completed` `prompt_executions` row for the build (e.g. 5).
- **failing check name** — the Sentinel check recorded on that prompt's failure (e.g. `file_delta`).
- **sub-step index** — when the halted prompt decomposed into sub-steps, the failing sub-step
  index (e.g. `1` of 16). Stored inside the `halt_point_reference` JSON blob (see Open Question).

Against the dialtest attempt 5 fixture this must yield exactly
`{buildRunId:'3736ff33-7ca2-4595-b304-b47badf28ac6', promptIndex:5, promptName:'ui-shell',
failingCheck:'file_delta', subStepIndex:1}`.

## Integration Points

### `src/phases/phase-chain.ts` (RETROFIT mode)
`phase-chain.ts` defines `BuildMode = 'GREENFIELD' | 'RETROFIT' | 'PRD_IMPORT'` (line 7) and
branches on mode (lines 61–102), calling `runComposer({ ..., mode: 'RETROFIT' })` for retrofits.
System 1 wires in **before** the RETROFIT-mode composer call: when
`mode === 'RETROFIT'`, `phase-chain.ts` first invokes `runGapAudit({ projectPath, scope: 'FULL',
trigger: 'retrofit_entry' })`. The audit's `health_score_before`/gate outcome gates whether the
retrofit proceeds: if `gaps_critical > 0` or mean `composite_score < 0.70`, the chain halts with
the gate report before composing a queue (R8). AUTO regeneration runs here, between phases, so the
composer reads corrected governance (Contract 3 is satisfied — this is pre-Phase-3).

### `src/cli/index.ts`
- **New `forge audit` command** — registered alongside the existing `retrofit` command (currently
  at `src/cli/index.ts` line 1929). Same argument/option shape family:
  ```
  program
    .command('audit')
    .description('Audit governance-vs-code gaps, score artifact health, regenerate safe gaps, gate architectural ones')
    .argument('<project-path>', 'Absolute path to the project to audit')
    .option('--scope <scope>', 'FULL | GOVERNANCE_ONLY | CODE_ONLY | TARGETED', 'FULL')
    .option('--halt-recovery', 'Reconstruct the exact halt point of the last halted build', false)
    .option('--non-interactive', 'Defer (never auto-approve) human-gated gaps and halt for human', false)
    .option('--api-key <key>', 'Anthropic API key for regeneration drafting')
    .action((p, opts) => cmdAudit(p, opts));
  ```
- **`forge resurrect --resume`** — the existing `resurrect` command (line 1812) gains a `--resume`
  flag. Today `cmdResurrect` runs the F10 autopsy→queue→Phase 3 path (skipping 1A/1B). With
  `--resume`, it instead: (a) runs `runGapAudit({ scope:'TARGETED', trigger:'halt_recovery',
  haltRecovery:true })`; (b) enforces the resume floor; (c) reads `continuation_plan` and calls
  the Phase 3 executor with `--start-at = promptIndex` (reusing the existing `forge resume`
  machinery at line 1775 / `src/engine/auto-resume.ts`), so completed prompts 1–4 are never re-run
  (R7). Without `--resume`, `cmdResurrect` behaves exactly as today (F10 full-abandonment path).
- **`forge health`** — the existing `health` command (line 1890) already row-counts
  `ALL_FORGE_TABLES`; adding `gap_audit_runs` and `artifact_health_scores` to that array
  (SCHEMA_ADDITIONS §8.2) makes them visible with zero code change to the command itself.

### Phase 3 executor / `forge resume`
The continuation plan's resume step is consumed by the existing resume machinery
(`src/engine/auto-resume.ts`, `forge resume <build-id>` at line 1775), which already computes a
`--start-at` from Build Memory. System 1 supplies the halt point; the executor already knows how
to start there. No change to Phase 3's per-prompt execution is required.

## CLI Additions (summary)

| Command | Flags | Purpose |
|---|---|---|
| `forge audit <path>` | `--scope FULL\|GOVERNANCE_ONLY\|CODE_ONLY\|TARGETED`, `--halt-recovery`, `--non-interactive`, `--api-key` | Run a gap audit; score, regenerate AUTO, gate architectural |
| `forge resurrect <path> --resume` | `--resume`, `--non-interactive`, `--autonomous-recovery` | Halt-recovery audit + resume from exact halt point |
| `forge health` | (existing) | Now also reports `gap_audit_runs`, `artifact_health_scores` row counts |

## Canonical Rules (System 1 Specific)
1. All codebase facts come from `runScan`/`ScanReport`; System 1 adds no second scanner (R5).
2. `GapAuditor`, `ArtifactHealthScorer`, and the gap detectors never write to any file (R1).
3. `RegenerationEngine` never writes during Phase 3 (Contract 3 / Iron Law 1 / R3).
4. Architectural (CRITICAL) gaps are always human-gated, never auto-regenerated (R4).
5. The fifth human gate cannot be disabled by any flag or environment variable.
6. Every `gap_audit_runs`/`artifact_health_scores` write carries `machine_id` (Contract 4/20).
7. A resume never re-runs a `completed` prompt; it starts at the reconstructed halt index (R7).
8. A build may resume only when mean `composite_score >= 0.70` and `gaps_critical = 0` (R8).
9. `composite_score = 0.45*completeness + 0.35*freshness + 0.20*consistency` — weights sum to 1.0.
10. Schema changes are limited to `SCHEMA_ADDITIONS.md`'s two tables; no invented columns.

## Behavioral Contract (resurrection-specific, prose style of BEHAVIORAL_CONTRACTS.md)

### Contract R-1: Read-Only Audit
`GapAuditor` and `ArtifactHealthScorer` are read-only. The audit may read any file in the target
project and any Build Memory row, but the only System 1 component that writes to a governance file
is `RegenerationEngine`, and only under Contract R-2. An audit that modifies a file is a defect.

### Contract R-2: Regeneration Only Between Phases
`RegenerationEngine` may write a governance doc only when the target project is not in an in-flight
Phase 3 build. During Phase 3, governance docs are immutable (Contract 3). Regeneration checks the
build state before every write and refuses if a build is in flight, recording the refusal — never
silently skipping and never silently writing.

### Contract R-3: Architectural Gaps Are Gated
Any gap matching a CRITICAL condition (schema table missing with no migration; absent governance
doc; `BEHAVIORAL_CONTRACTS`-vs-code contradiction on Contract 1–20) is routed to
`HumanGateEvaluator` and never auto-regenerated. In non-interactive mode the gate defers and halts
for human; it never auto-approves. This gate is structural and non-configurable, following
Contract 2's four-gate philosophy.

### Contract R-4: Honest Halt Reconstruction
Every field of `halt_point_reference` is read from Build Memory or the preserved git branch. A
field that cannot be read is stored `null`, never fabricated (Iron Law 3). A partial halt point is
a valid result; a fabricated one is a defect.

### Contract R-5: Resume Floor Enforced in Code
`forge resurrect --resume` and `phase-chain.ts` RETROFIT entry enforce the resume floor (mean
`composite_score >= 0.70` and `gaps_critical = 0`) in code before handing any resume point to the
Phase 3 executor. The floor is a gate, not operator advice.

## Build Memory integration checklist (per SCHEMA_ADDITIONS §8)
1. Append the `gap_audit_runs` and `artifact_health_scores` `CREATE TABLE IF NOT EXISTS` blocks
   (SCHEMA_ADDITIONS §1, §2 DDL) inside `initializeForgeMemory()`.
2. Add `'gap_audit_runs'` and `'artifact_health_scores'` to `ALL_FORGE_TABLES`.
3. Bump `CURRENT_SCHEMA_VERSION` `'2.2.1' → '2.3.0'` (shared package bump; ship all six tables of
   Systems 1–3 together).
4. Add `src/memory/gap-audits.ts` CRUD (reference shape: `src/memory/builds.ts`).
5. Add the four agent entries (`GapAuditor`, `ArtifactHealthScorer`, `RegenerationEngine`,
   `HumanGateEvaluator`) to `AGENTS.md` in the existing table format when implemented.
6. `forge health` must report both new tables `0 rows, table exists` post-migration.

## Open Questions
- **`subStepIndex` in `halt_point_reference`.** `SCHEMA_ADDITIONS.md` documents the
  `halt_point_reference` JSON as `{buildRunId, promptIndex, promptName, failingCheck}`. F24
  requires a fifth fact, `subStepIndex` (and optionally `subStepName`), to reconstruct sub-step
  halts like dialtest attempt 5. Because the column is a free-form JSON `TEXT` blob (not a typed
  column), storing `subStepIndex` inside it introduces **no new column and no schema violation**.
  This is raised here rather than silently assumed; if the schema owner wants the JSON shape stated
  explicitly, `SCHEMA_ADDITIONS.md` should be amended first per its own no-silent-drift rule. No
  code is blocked — the JSON already accommodates the field.
