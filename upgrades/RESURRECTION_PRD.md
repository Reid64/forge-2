# FORGE 2.0 — PRODUCT REQUIREMENTS DOCUMENT

## System 1: Resurrection and Gap Intelligence Engine

> **Scope of this document.** This PRD specifies **System 1 of the Systems 1–3 governance
> package** (see `upgrades/SCHEMA_ADDITIONS.md`). System 1 EXTENDS the root PRD's **F10:
> Project Autopsy + Resurrection** — it does not replace it. F10 (and its implementing tool
> `src/tools/project-autopsy.ts`) handles the *fully abandoned* project: read a dead codebase,
> extract intent, feed a reconstruction PRD into Phase 1A. System 1 handles the *in-progress or
> halted* build: a project that was mid-flight, whose governance docs have drifted from its
> code, and which must resume from an exact halt point rather than be reconstructed from scratch.
> The two share the read-only, non-fabricating philosophy of the existing ForgeRetrofit pipeline
> and reuse its scanning; System 1 adds the governance-completeness, autonomous-regeneration, and
> halt-point-continuation layers that neither ForgeRetrofit nor `project-autopsy.ts` provides.

---

## Product Overview

The Resurrection and Gap Intelligence Engine is the governance layer that lets FORGE resume any
build — its own or another operator's — without a human reconstructing context by hand. It
audits a project's nine governance artifacts against the project's actual code, scores each
artifact's health, autonomously regenerates the artifacts that are safe to regenerate, routes
the ones that encode an architectural decision to a human gate, and reconstructs the exact point
a prior build halted so `forge resurrect --resume` can continue from that point rather than
restart. It is a Node.js orchestration layer that wraps the existing ForgeRetrofit SCAN/DIAGNOSE
pipeline; it never re-implements codebase scanning.

## Target User

Reid Whitesides — non-technical founder operating multiple businesses, building software using
the Visual AI Method. He does not read TypeScript, does not diff governance docs by hand, and
cannot reconstruct "where was build `3736ff33` when it stopped and why" from a UTF-16 log file.
For him, resurrection must be a single command that either resumes autonomously or presents a
plain-language gate decision. Future: any founder, agency, or developer resuming an
autonomously-built project. This system assumes a **single operator on a local machine** (Build
Memory is the single-operator SQLite file `~/.forge/forge_memory.db`); it introduces no
team/enterprise/multi-tenant persona.

## Problem Statement

FORGE builds halt. Sessions end. Governance docs drift from code. Today, every one of these
events forces a human to manually reconstruct context before work can continue — and that
reconstruction is slow, error-prone, and often wrong.

This is not hypothetical. It is the documented, recurring failure mode captured in
`FORGE_HANDOFF.md`:

- **Dialtest attempt 5**, build `3736ff33-7ca2-4595-b304-b47badf28ac6`, halted at **prompt 5
  'ui-shell'** on Sentinel's **`file_delta`** law. The prompt had decomposed into 16 atomic
  sub-prompts; **sub-step 1/16** ("Ground the design in the subject matter") ran three times,
  each exiting cleanly, each writing zero files, exhausting retries and halting Phase 3. The
  feature branch `forge/3736ff33-.../prompt-5-ui-shell-layouts-design-tokens` is preserved on
  disk. Prompts 1–4 are genuinely complete.
- To resume that build correctly, a human had to reconstruct, by hand, five separate facts:
  the **build_run_id**, the **feature branch name**, the **prompt index (5)**, the **failing
  check name (`file_delta`)**, and the **sub-step index (1 of 16)** — and only then decide
  whether to resume or fix. `FORGE_HANDOFF.md` §5 records that the tooling did not even surface
  which Sentinel check failed, and generated a resume command pointing at the wrong (FORGE 1.0)
  path.

Separately, governance docs rot silently. ForgeRetrofit's SCAN op 10 (`inventoryGovernanceDocs`)
only checks a governance file's **presence and staleness by mtime** (`GovernanceDocEntry`:
`exists`, `lastModifiedDays`, `staleness`). It cannot tell that `SCHEMA_REGISTRY.md` is present
and recently touched but is missing three tables the code already queries, or that
`BEHAVIORAL_CONTRACTS.md` still promises behavior the code no longer implements. A build that
resumes against a drifted governance doc resumes against a lie.

System 1 exists to make halt-recovery a command instead of an afternoon, and to make governance
drift a scored, auto-corrected or human-gated event instead of a silent one.

## Core Requirement

Given a project path (halted, in-progress, or simply stale), System 1 must:

1. Run a deep, read-only audit of the codebase by reusing ForgeRetrofit's SCAN and DIAGNOSE — never re-scanning from scratch.
2. Detect governance-doc gaps at the **content** level (missing sections, drift vs. code, cross-doc contradictions), across all nine artifacts, beyond ForgeRetrofit's presence/staleness stub.
3. Score every governance artifact on completeness, freshness, and consistency, and roll those into one `composite_score` per artifact.
4. Autonomously regenerate the artifacts that fall below the regeneration threshold **and** carry no critical/architectural gap.
5. Route every critical/architectural gap through a new, non-bypassable human gate.
6. Reconstruct the exact halt point of a prior build and write a continuation plan that `forge resurrect --resume` / the Phase 3 executor can consume.
7. Persist every audit, every score, and every decision to Build Memory (`gap_audit_runs`, `artifact_health_scores`) with `machine_id` on every row.

## Scope Boundaries (Non-Goals)

System 1 is deliberately narrow. It is **NOT**:

- **NOT a replacement for ForgeRetrofit's SCAN operations.** System 1 *calls* `runScan` /
  `runRetrofitPipeline`. It adds zero new filesystem-scanning primitives. If a fact about the
  codebase is needed, it comes from the `ScanReport`, not from new scanning code.
- **NOT a replacement for `src/tools/project-autopsy.ts` (F10) or the full-abandonment path.**
  `project-autopsy.ts` owns the *dead project* case (extract intent → resurrection PRD → Phase
  1A → 1B → 2 → 3). System 1 owns the *halted/in-progress/drifted* case (audit → score →
  regenerate/gate → resume from halt point). When a project has no salvageable build state at
  all, System 1 hands off to the F10 autopsy path and does not attempt halt-point continuation.
- **NOT a governance editor that acts without authority.** System 1 modifies a governance doc
  **only** when the artifact clears the AUTO regeneration threshold (§Feature F1.3) **or** a
  human clears its gate (§Feature F1.4). It never patches a governance doc silently, and never
  during Phase 3 (Contract 3 / Iron Law 1).
- **NOT a code editor.** System 1 regenerates *governance documents* only. It never edits
  application source, never runs migrations, never touches the target project's runtime. Fixing
  the code the docs describe is the job of the resumed build (Phase 3), not of the auditor.
- **NOT a bypass for the four existing human gates (Contract 2).** System 1 adds a fifth,
  additional, structural gate; it removes none.
- **NOT multi-tenant.** No hosted Postgres, no RLS, no owner scoping beyond `machine_id` and
  filesystem permissions on `~/.forge/forge_memory.db` (SCHEMA_ADDITIONS §7).

## Gap Severity Model

Every gap the audit finds is classified into exactly one of three severities. This taxonomy is
the contract between the scorer, the regeneration engine, and the human gate; the counts roll up
into `gap_audit_runs.gaps_minor` / `gaps_major` / `gaps_critical`.

- **MINOR** — cosmetic or low-risk drift that never changes an architectural decision. Examples:
  a stale "Last Updated" timestamp; a missing minor subsection; a `TOOLCHAIN.md` tool-version
  drift (documented `pnpm@9.1` vs. installed `pnpm@9.3`); one or two `TBD`/`TODO` placeholders
  in a non-load-bearing section. **Always auto-regenerated** (never gated).
- **MAJOR** — a real content deficiency that degrades trust in the doc but does not, by itself,
  contradict an architectural decision. Examples: a required section entirely absent from an
  otherwise-present doc; moderate drift where the doc describes 8 of 10 real routes; an artifact
  present but substantially incomplete. **Auto-regenerated when the artifact's `composite_score`
  is in the AUTO band and the artifact carries no critical gap; otherwise human-gated.**
- **CRITICAL (architectural)** — a gap that encodes or contradicts an architectural decision, or
  that removes a governance doc entirely. **Always human-gated**, regardless of `composite_score`.
  A gap is CRITICAL if and only if it matches one of these concrete conditions:
  1. A schema **table referenced in code** (present in the `ScanReport.schemaAudit` /
     `extractDatabaseSchema` output) is **absent from `SCHEMA_REGISTRY.md`** and has **no
     migration file** on disk that creates it.
  2. A **governance doc is completely absent** (`artifact_health_scores.exists_on_disk = 0`)
     from the artifact set enumerated in `SCHEMA_ADDITIONS.md`.
  3. A **contradiction between `BEHAVIORAL_CONTRACTS.md` and actual code behavior** on a numbered
     Contract 1–20 item (e.g. the doc states Contract 10 branch naming is
     `forge/{build-id}/prompt-{index}-{name}` but the code creates a different pattern; the doc
     promises a gate the code does not enforce).

## Feature Requirements

> Feature numbering continues the root PRD's `### F#: Name` convention. Root PRD ends at F19;
> System 1's five features are **F20–F24**, and each carries an internal `F1.x` short-name used
> by the Blueprint's agent contracts for cross-reference.

### F20: Deep Codebase Audit (F1.1)
A read-only, whole-project audit invoked by the `GapAuditor` agent. It **wraps**, and never
duplicates, ForgeRetrofit: it calls `runScan` (14 SCAN ops → `ScanReport`) and the three
DIAGNOSE report builders (`generateArchitectureHealthReport`,
`buildGovernanceReconciliationReport`, `buildEnterprisePatternsGapReport`), then layers
governance-content analysis on top of the raw `ScanReport`. One invocation writes exactly one
`gap_audit_runs` row (status `running` → `completed`/`failed`/`halted_for_human`), records
`artifacts_audited`, and — for a halt-recovery audit — populates `halt_point_reference`. The
audit is NON-FATAL and NEVER throws (Iron Law 3): a missing input yields a partial `ScanReport`
and a lower score, never a crash.

### F21: Governance Doc Gap Detection (F1.2)
Content-level gap detection across all **nine** governance artifacts:
`PRD`, `SCHEMA_REGISTRY`, `AGENTS`, `BEHAVIORAL_CONTRACTS`, `BLUEPRINT`, `TOOLCHAIN`,
`SESSION_STATE`, `STATE_OF_THE_BUILD`, `TESTING`. For each artifact the detector produces the
inputs the `ArtifactHealthScorer` needs: the set of **required sections present vs. absent**
(→ `missing_sections`), the **placeholder count** (`TBD`/`TODO`/`{{...}}` occurrences →
`placeholder_count`), the **drift entries** vs. the `ScanReport` (→ `drift_detail`,
`drift_detected`), and the **cross-document contradictions** feeding the consistency score.
This is the layer that goes strictly beyond ForgeRetrofit's `inventoryGovernanceDocs`, which only
knows presence and mtime staleness (`GovernanceDocEntry`).

Per-artifact required-section and drift definitions (each is a concrete, checkable rule):
- **PRD** — must contain `Target User`, `Core Requirement`, `Feature Requirements`,
  `Success Criteria`. Drift: a feature `F#` referenced in `STATE_OF_THE_BUILD.md` or in code but
  absent from the PRD's feature list.
- **SCHEMA_REGISTRY** — must enumerate every table found by `extractDatabaseSchema`. Drift: a
  table in `ScanReport.schemaAudit` absent from the doc (feeds CRITICAL condition 1).
- **AGENTS** — must contain one entry per agent module under `src/`. Drift: an agent directory
  present in the file tree with no `## Agent:` entry.
- **BEHAVIORAL_CONTRACTS** — must contain numbered `### Contract N:` entries. Drift: a
  doc-vs-code contradiction on a Contract 1–20 item (feeds CRITICAL condition 3).
- **BLUEPRINT** — must contain `System Identity`, `Architecture Overview`, `Core Components`,
  `Project Structure`, `Technology Decisions`, `Environment Variables`, `Canonical Rules`. Drift:
  a `src/` top-level directory absent from `Project Structure`.
- **TOOLCHAIN** — must pin each tool the project uses. Drift: `packageAudit` version vs.
  documented version (MINOR).
- **SESSION_STATE / STATE_OF_THE_BUILD** — must reflect the last completed prompt index. Drift:
  doc's "current prompt" vs. Build Memory's last completed prompt for the build.
- **TESTING** — must enumerate the test suites in use. Drift: `testAudit.testFilesFound` > 0 but
  no suite documented.

### F22: Autonomous Artifact Regeneration (F1.3)
The `RegenerationEngine` regenerates every artifact whose `artifact_health_scores.regeneration_tier`
is `AUTO`. Regeneration produces a corrected governance doc on disk and records the count in
`gap_audit_runs.gaps_auto_regenerated`. It runs **only between builds/phases — never during Phase
3** (Contract 3). Regeneration is full-file for docs FORGE fully owns the format of
(`SESSION_STATE.md`, `STATE_OF_THE_BUILD.md`, `TOOLCHAIN.md`) and section-scoped (patch the
specific `missing_sections`/drift region, preserve human prose elsewhere) for the narrative docs
(`PRD.md`, `BLUEPRINT.md`, `BEHAVIORAL_CONTRACTS.md`, `SCHEMA_REGISTRY.md`, `AGENTS.md`,
`TESTING.md`). No artifact is ever regenerated while it carries a CRITICAL gap — that always
routes to F23.

### F23: Human Gate on Major Architectural Gaps (F1.4)
A **new, fifth, structural** human gate (in addition to Contract 2's four), evaluated by
`HumanGateEvaluator`. It is structural, not configurable: it cannot be flag-disabled. Any gap
meeting the CRITICAL definition (§Gap Severity Model), or any MAJOR gap on an artifact whose
`composite_score` sits in the HUMAN_GATE band, is presented to the operator for an
approve/decline decision before any regeneration touches that artifact. In non-interactive mode
the gate does **not** auto-approve; it defers the gated item and halts the audit with status
`halted_for_human` (contrast with ForgeRetrofit's WARN-tier auto-approve, which is allowed
because WARNs are not architectural). The count routes to `gap_audit_runs.gaps_human_gated`.

### F24: Continuation from Exact Halt Point (F1.5)
For a halt-recovery audit, System 1 reconstructs the five load-bearing facts of a halt from Build
Memory and the preserved feature branch — **build_run_id, feature branch name, prompt index,
failing check name, sub-step index** — and writes them, plus an ordered next-action plan, to
`gap_audit_runs.halt_point_reference` and `gap_audit_runs.continuation_plan`. `forge resurrect
--resume` reads that plan and hands the resume point to the Phase 3 executor, which continues
from the halted prompt rather than restarting from prompt 1. The dialtest attempt 5 halt is the
canonical target this feature must reconstruct exactly.

## User Stories

### US-1 → F24
**As** a founder whose build just halted, **I want** a single command that tells me exactly which
build, branch, prompt, check, and sub-step it stopped on, **so that** I never again reconstruct
that by hand from a UTF-16 log.
**Acceptance criteria:**
- [ ] `forge audit <path> --halt-recovery` writes a `gap_audit_runs` row with `audit_trigger = 'halt_recovery'` and a non-null `halt_point_reference`.
- [ ] `halt_point_reference` JSON contains `buildRunId`, `promptIndex`, `promptName`, `failingCheck`, and `subStepIndex` (the last non-null when the halted prompt decomposed into sub-steps).
- [ ] Run against the dialtest attempt 5 fixture, the values are exactly `buildRunId=3736ff33-7ca2-4595-b304-b47badf28ac6`, `promptIndex=5`, `promptName=ui-shell`, `failingCheck=file_delta`, `subStepIndex=1`.
- [ ] The report names the preserved feature branch `forge/3736ff33-.../prompt-5-ui-shell-layouts-design-tokens`.

### US-2 → F24
**As** a founder, **I want** `forge resurrect --resume` to continue from the halted prompt, **so
that** completed prompts 1–4 are never re-run.
**Acceptance criteria:**
- [ ] The continuation plan's first action targets `promptIndex` from `halt_point_reference`, not index 1.
- [ ] The Phase 3 executor receives a `--start-at` equal to the halted prompt index.
- [ ] Prompts already recorded `completed` in Build Memory for that build are not re-executed.
- [ ] If no resumable build state exists, the command reports that and points to `forge resurrect` (F10 full path) instead of guessing.

### US-3 → F21
**As** a founder, **I want** FORGE to notice when a governance doc no longer matches the code,
**so that** I don't resume a build against a doc that lies.
**Acceptance criteria:**
- [ ] Every one of the nine artifacts produces exactly one `artifact_health_scores` row per audit.
- [ ] A table present in `ScanReport.schemaAudit` but absent from `SCHEMA_REGISTRY.md` appears in that artifact's `missing_sections`/`drift_detail` and sets `drift_detected = 1`.
- [ ] `placeholder_count` reflects the real count of `TBD`/`TODO`/`{{...}}` occurrences in the doc.

### US-4 → F22
**As** a founder, **I want** FORGE to fix the low-risk doc problems itself, **so that** I only
review the ones that matter.
**Acceptance criteria:**
- [ ] An artifact with `regeneration_tier = 'AUTO'` and no CRITICAL gap is rewritten on disk and counted in `gaps_auto_regenerated`.
- [ ] A MINOR gap (stale timestamp, tool-version drift, missing minor subsection) always auto-regenerates and is never gated.
- [ ] `health_score_after` for the artifact is strictly greater than `health_score_before` after a successful AUTO regeneration.
- [ ] No governance file is modified if the current phase is Phase 3 (the run refuses with a Contract 3 message).

### US-5 → F23
**As** a founder, **I want** FORGE to stop and ask me before it changes anything architectural,
**so that** it never rewrites a decision I made without my say-so.
**Acceptance criteria:**
- [ ] Any gap matching a CRITICAL condition sets `regeneration_tier = 'HUMAN_GATE'` and increments `gaps_critical` and `gaps_human_gated`.
- [ ] The gate prompt states the artifact, the specific gap, and what regeneration would change, in plain language.
- [ ] In `--non-interactive` mode the gated item is deferred (not auto-approved) and the audit ends with `status = 'halted_for_human'`.
- [ ] The gate cannot be disabled by any flag or environment variable.

### US-6 → F20
**As** a founder, **I want** the audit to reuse FORGE's existing scanner, **so that** it stays
consistent with `forge retrofit` and I never maintain two scanners.
**Acceptance criteria:**
- [ ] The audit obtains all codebase facts from `runScan`/`ScanReport`; no new filesystem-walk code is added under `src/resurrection/`.
- [ ] `forge audit --scope CODE_ONLY` and `forge retrofit --scope A` produce the same underlying `ScanReport` for the same project.
- [ ] The audit writes `.forge/scan_report.json` via the existing `runScan` path (not a second copy).

### US-7 → F20/F21
**As** a founder, **I want** one health number per doc and one for the project, **so that** I know
at a glance whether it's safe to resume.
**Acceptance criteria:**
- [ ] Each `artifact_health_scores` row carries `completeness_score`, `freshness_score`, `consistency_score`, and a `composite_score` that equals the documented weighted formula (Blueprint §ArtifactHealthScorer) within ±0.001.
- [ ] `gap_audit_runs.health_score_before` equals the mean of the nine artifacts' `composite_score` at audit start.
- [ ] `forge health` reports both new tables with correct row counts after an audit.

### US-8 → F22/F24
**As** a founder, **I want** resumption blocked until the docs are healthy enough, **so that** a
resumed build never proceeds on a broken governance base.
**Acceptance criteria:**
- [ ] A build may proceed to resume only when mean `composite_score >= 0.70` **and** `gaps_critical = 0`.
- [ ] If that floor is not met, `forge resurrect --resume` refuses and reports which artifacts are below floor and which gates are open.

## Success Metrics

All metrics are measured against Build Memory rows (`gap_audit_runs`, `artifact_health_scores`),
never self-reported (Iron Law 3).

| Metric | Target | Source |
|---|---|---|
| Time-to-resume after a halt (command start → continuation plan written) | < 90 seconds for a `TARGETED` halt-recovery audit | `gap_audit_runs.duration_ms` |
| Halt-point reconstruction accuracy (all 5 facts correct) | 100% on any build with a preserved feature branch and Build Memory rows | US-1 acceptance run |
| Share of gaps auto-regenerated vs. human-gated | ≥ 70% of all gaps resolved AUTO across the first 10 audits | `sum(gaps_auto_regenerated) / sum(gaps_found_total)` |
| Governance drift caught that ForgeRetrofit's stub misses | ≥ 1 content-level gap per audit on any drifted project (presence/staleness alone would report 0) | `drift_detected` rows where `exists_on_disk = 1` |
| Artifact health score floor enforced before resume | Zero resumes proceed with mean `composite_score < 0.70` or `gaps_critical > 0` | refusal count vs. proceed count |
| Post-regeneration improvement | `health_score_after > health_score_before` on every audit that regenerated ≥ 1 artifact | `gap_audit_runs` |
| Human intervention rate on non-architectural gaps | 0 — no MINOR gap ever reaches a human | `gaps_human_gated` should never include a MINOR-only artifact |

## Resurrection Iron Laws

> FORGE uses an ambient, informally-numbered "Iron Law N" convention scattered through source
> comments (Iron Law 1 = governance docs read-only; Iron Law 2 = a CRITICAL finding blocks the
> build; Iron Law 3 = never fabricate an outcome, report only real results; Iron Law 4 =
> full-file replacement, never patch middleware; Iron Law 5 = no placeholder HTML; Iron Law 8 =
> no mocks, validate boundary data). There is no canonical numbered-list file, so these
> resurrection-specific laws are numbered **independently as R1…R8** to avoid colliding with any
> ambient global law. Where a global law genuinely applies it is cross-referenced by number.

- **R1: The auditor never modifies a file, ever.** `GapAuditor`, `ArtifactHealthScorer`, and the
  gap detectors are strictly read-only — consistent with Iron Law 1. The *only* component that
  writes to a governance doc is `RegenerationEngine`, and only under R3/R4.
- **R2: Report only reconstructed facts, never guessed ones.** Every value in
  `halt_point_reference` must come from Build Memory or the preserved branch. If a fact cannot be
  read, it is recorded `null`, never invented (Iron Law 3). A partial halt-point is a valid
  result; a fabricated one is a defect.
- **R3: No governance write during Phase 3.** Regeneration runs only between builds/phases. If a
  build is currently in Phase 3, regeneration refuses and the audit records the refusal (Contract
  3 / Iron Law 1). This is non-negotiable and non-configurable.
- **R4: Architectural gaps are gated, not guessed.** Any gap matching a CRITICAL condition routes
  to `HumanGateEvaluator` and is never auto-regenerated — no matter how confident the scorer is.
  The gate is structural (§F23), matching Contract 2's philosophy.
- **R5: Reuse ForgeRetrofit, never re-scan.** All codebase facts come from `runScan`/`ScanReport`
  and the DIAGNOSE builders. System 1 adds no second scanner. Duplicated scanning is a defect.
- **R6: Every write carries `machine_id`.** Every `gap_audit_runs` and `artifact_health_scores`
  insert includes `machine_id` (Contract 4/20; SCHEMA_ADDITIONS §0).
- **R7: A resume never re-runs a completed prompt.** Continuation starts at the halted prompt
  index; prompts marked `completed` in Build Memory are skipped. Restarting from prompt 1 when a
  resumable state exists is a defect.
- **R8: The health floor is a gate, not a suggestion.** A build may not resume unless mean
  `composite_score >= 0.70` and `gaps_critical = 0`. The floor is enforced in code, not left to
  operator judgment (Iron Law 2 — a critical gap blocks).

## Dependencies

- **ForgeRetrofit** (`src/retrofit/`) — `runScan`, `runRetrofitPipeline`, and the three DIAGNOSE
  report builders. Reused wholesale (R5).
- **ForgeLearning** (`src/learning/database.ts`) — Build Memory. Adds `gap_audit_runs` and
  `artifact_health_scores` per `SCHEMA_ADDITIONS.md`; schema bump `2.2.1 → 2.3.0` (shared across
  Systems 1–3).
- **`src/tools/project-autopsy.ts`** (F10) — the hand-off target for fully-abandoned projects.
- **Phase 3 executor / `forge resurrect` / `forge resume`** — the consumer of the continuation
  plan.

## Open Questions

- The `gap_audit_runs.halt_point_reference` column is documented in `SCHEMA_ADDITIONS.md` as JSON
  `{buildRunId, promptIndex, promptName, failingCheck}`. This PRD requires a fifth fact,
  **`subStepIndex`**, to reconstruct sub-step-level halts like dialtest attempt 5. Because the
  column is a free-form JSON `TEXT` blob (not a typed column), storing `subStepIndex` (and
  `subStepName`) inside that JSON introduces **no new column** and does not violate the schema
  contract. This is noted here rather than silently assumed; if the schema owner prefers the JSON
  shape be documented explicitly in `SCHEMA_ADDITIONS.md`, that document should be amended first
  (per its own §"never patch the drift silently in code" rule). No code change is blocked by this
  — the JSON already accommodates the field.
