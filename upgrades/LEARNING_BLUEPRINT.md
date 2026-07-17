# FORGE 2.0 — LEARNING BLUEPRINT

## System 2: Recursive Enterprise Learning Engine — Architecture

> **Read `upgrades/SCHEMA_ADDITIONS.md` and `upgrades/LEARNING_PRD.md` first.** This document
> specifies the architecture for the four new agents defined in the PRD (F20–F24). It references the
> two new tables `evolution_promotions` and `pattern_retirement_log` **verbatim** from
> SCHEMA_ADDITIONS.md (§3, §4) and does **not** redefine them. Every existing table it reads or writes
> is a real table in `src/learning/database.ts`; every existing field it names matches
> `src/learning/types.ts` exactly. All DDL is SQLite (`better-sqlite3`, `~/.forge/forge_memory.db`) —
> never Postgres.

---

## System Identity

- **Name:** Recursive Enterprise Learning Engine (FORGE System 2)
- **Purpose:** The autonomous **action layer** on top of Phase 5's existing proposal layer — promote,
  retire, transfer, and evolve, within numerically-bounded, fully-audited limits.
- **Relationship to Phase 5:** Extension, not replacement. Phase 5 (`src/phases/phase5-learner.ts`)
  still runs its existing 10-step sequence and still **only proposes**. System 2 adds the components
  that act on those proposals.
- **Storage:** SQLite via `better-sqlite3`, single file `~/.forge/forge_memory.db`
  (`getForgeDbPath()`). No RLS (SCHEMA_ADDITIONS §7). `machine_id` on every row (Contract 4/20).
- **Schema version:** ships within the one `2.2.1 → 2.3.0` bump that SCHEMA_ADDITIONS.md defines for
  all six new tables across Systems 1–3.

---

## Architecture Overview

System 2 is four cooperating agents plus one CLI namespace (`forge learning …`). None of them is a
web service; all are in-process TypeScript invoked either by the Phase 5 orchestrator, by `node-cron`
scheduled tasks, or by the CLI.

### Core Components

1. **EvolutionPromoter** (`src/learning-engine/evolution-promoter.ts`) — evaluates `pending_evolutions`
   and either auto-promotes (above the confidence bar), records a human decision, or leaves the row
   pending. Writes `evolution_promotions`, flips `pending_evolutions.status`, activates the promoted
   change per `evolution_type`, and performs F24 governance-rule auto-elevation. **The first FORGE
   component permitted to cross the propose→activate line — and only within the L1–L8 bounds.**
2. **PatternRetirer** (`src/learning-engine/pattern-retirer.ts`) — sweeps the five pattern tables,
   SOFT_RETIREs or HARD_DELETEs dead rows, writing `pattern_retirement_log`.
3. **CrossProjectKnowledgeTransfer** (`src/learning-engine/cross-project-transfer.ts`) — at new-build
   start, pushes stack-compatible, non-retired `cross_project_insights` into prompt assembly.
4. **BuildBrainEvolver** (`src/learning-engine/build-brain-evolver.ts`) — observes rewrite-strategy
   outcomes in `prompt_scores` / `decision_weights`, proposes strategy switches via
   `pending_evolutions` (never editing the rewriter), and runs the promotion monitoring window.

### Project Structure (additions)

```
forge-2/
├── src/
│   ├── learning-engine/                 # NEW — System 2 agents
│   │   ├── evolution-promoter.ts        # EvolutionPromoter (F20, F24)
│   │   ├── pattern-retirer.ts           # PatternRetirer (F21)
│   │   ├── cross-project-transfer.ts    # CrossProjectKnowledgeTransfer (F22)
│   │   ├── build-brain-evolver.ts       # BuildBrainEvolver (F23)
│   │   ├── retirement-filter.ts         # Shared anti-join helper (used by every consuming query site)
│   │   └── index.ts                     # Barrel exports + runLearningEngineSweep()
│   ├── memory/
│   │   ├── evolutions.ts                # pending_evolutions + evolution_promotions CRUD (extend if present)
│   │   └── retirements.ts               # pattern_retirement_log CRUD
│   └── cli/commands/
│       └── learning.ts                  # forge learning promote|retire|transfer|status
```

`src/memory/evolutions.ts` and `src/memory/retirements.ts` follow the existing `src/memory/builds.ts`
reference shape: typed insert/get/list functions wrapping prepared statements, no raw SQL outside
these modules (SCHEMA_ADDITIONS §8.4).

### Technology Decisions

- **better-sqlite3** — synchronous, matches all existing learning code.
- **node-cron** — already a dependency (see `scheduled_tasks`); used only for the PatternRetirer sweep
  cadence (see Integration Points). EvolutionPromoter runs in-process after Phase 5, not on cron
  (OQ1). No new dependency is introduced by System 2.
- **crypto.randomUUID()** for all PKs (SQLite has no `gen_random_uuid()`).
- **No self-modification of source files.** BuildBrainEvolver proposes; it never writes to
  `src/engine/prompt-rewriter.ts` (Canonical Rule 3 / Learning Iron Law L5).

---

## Agent Contracts

### Agent: EvolutionPromoter (src/learning-engine/)

- **Purpose:** Decide, for each `pending_evolutions` row, whether it may go live without human review;
  auto-promote above the confidence bar; record every decision in `evolution_promotions`; activate the
  promoted change per `evolution_type`; and auto-elevate proven fix-pattern prevention rules into
  first-class `governance_rules` rows (F24). The **only** FORGE component allowed to cross the
  propose→activate line, and only within Learning Iron Laws L1–L8.
- **Status:** NOT_STARTED
- **CLI:** `forge learning promote [--dry-run] [--threshold <0-1>] [--project <name>]`
  - `--dry-run`: report what would be promoted, write nothing.
  - `--threshold <0-1>`: override the active confidence threshold for **this invocation only** (logged
    into `evolution_promotions.confidence_threshold_applied`); does not rewrite the `forge_meta`
    default. Per L1, an override *below* a value that already rejected a row does not retroactively
    promote it — only rows evaluated under this invocation are affected.
- **Entry Point:** `src/learning-engine/evolution-promoter.ts` → `promoteEvolutions(opts)`
- **Exports:** `promoteEvolutions`, `PromoteOptions`, `PromotionResult`, `evaluatePromotability`
- **Dependencies:** `pending_evolutions` (read + `status` update), `self_created_agents` (read — a
  proposal that references a self-created agent must confirm its Contract 17 test-validation status
  before promotion), `governance_rules` (write for RULE promotions and F24 elevation), `forge_meta`
  (read/write the versioned threshold), BuildMemory client.
- **Database tables:**
  - `evolution_promotions` — **write** (one row per decision).
  - `pending_evolutions` — **read** + **status update** (`PENDING → APPROVED | REJECTED`).
  - `governance_rules` — **write** (RULE promotions, F24 `AUTO_ELEVATED` elevation) + back-link update.
  - `fix_patterns` — **read** + `governance_rule_id` back-link **update** (F24).
  - `forge_meta` — **read/write** (`learning.promotion.confidence_threshold` + `.history`).

**Promotion decision (`evaluatePromotability`).** For each `PENDING` row:
1. Read the active threshold `T` from `forge_meta` (`learning.promotion.confidence_threshold`, default
   `0.90`). Record `T` as `confidence_threshold_applied` on any row written (L1).
2. Compute `evidence_build_count` from the proposal's `evidence` payload (OQ2).
3. **AUTO-promote iff** `confidence >= T` **AND** `evidence_build_count >= 5` **AND**
   `evolution_type != 'GATE'` (L2). If the proposal references a self-created agent, additionally
   require that agent's `self_created_agents.status` is at least `'proposed'` with a passing
   `test_results` payload (Contract 17c) — a proposal whose agent failed test validation is never
   auto-promoted.
4. Otherwise leave `PENDING` (no `evolution_promotions` row is written for a non-decision).

**Activation per `evolution_type`** (only after the `evolution_promotions` row is written — L3):
- `RULE` → insert `governance_rules` (`source = 'AUTO_ELEVATED'`, `active = 1`, `rule_text` /
  `rule_short_name` / `tech_stack_tags` / `scope` from the proposal's `change_detail`).
- `THRESHOLD` / `CONFIG` → write the new value to `forge_meta` under the versioned key named in the
  proposal's `change_detail`, appending the prior value to that key's `.history`. Effective next build.
- `TEMPLATE` → mark the corresponding `governance_versions` proposal (the `recursive_learner` row
  Template Evolver wrote) as the active version by clearing its `PROPOSED:` `changes_description`
  prefix and setting its `effectiveness_score` baseline; the new template text takes effect at the
  **next** build's Phase 2 assembly — never mid-build (Contract 3 preserved).
- `HOOK` → set the hook's `enabled = true` in its definition store (`HookDefinition.enabled`) and
  record the change; effective next build's hook load.
- `GATE` → **unreachable via AUTO** (L2); only `HUMAN_APPROVED` promotions may carry `evolution_type =
  'GATE'`, and even then EvolutionPromoter only records the human's decision, it does not weaken any
  Contract 2 gate.

**F24 governance-rule auto-elevation (separate sweep within the same agent).** For each `fix_patterns`
row with `auto_governance_rule IS NOT NULL` AND `success_rate >= 0.90` AND `times_fix_applied >= 5`
AND `governance_rule_id IS NULL`: insert an `AUTO_ELEVATED` `governance_rules` row (`rule_text =
auto_governance_rule`, `source_error_fingerprint = error_fingerprint`, `tech_stack_tags` copied,
`active = 1`), set `fix_patterns.governance_rule_id` to the new id (idempotency back-link), and write
an `evolution_promotions` row (`evolution_type = 'RULE'`, `promotion_method = 'AUTO'`,
`confidence_at_promotion = success_rate`, `evidence_build_count = times_fix_applied`).

**Monitoring window / rollback (executed by BuildBrainEvolver, recorded on this table).** Each AUTO
`evolution_promotions` row carries `monitoring_window_builds = 10` (schema default) and
`pre_promotion_success_rate`. After 10 subsequent builds elapse, `post_promotion_success_rate` is
backfilled. **Rollback trigger (exact):** if
`post_promotion_success_rate < (pre_promotion_success_rate - 0.15)` — i.e. a drop of more than 15
percentage points — set `rollback_triggered = 1`, set `rollback_reason`, and reverse the activation
(deactivate the `AUTO_ELEVATED` rule via `governance_rules.active = 0`; restore the prior `forge_meta`
value from `.history` for THRESHOLD/CONFIG; re-prefix the `governance_versions` row for TEMPLATE;
`enabled = false` for HOOK). Rollback is not optional once the condition holds (L8).

---

### Agent: PatternRetirer (src/learning-engine/)

- **Purpose:** Retire dead-weight rows from the five pattern tables — conservatively (SOFT_RETIRE by
  default), reversibly-in-spirit (log snapshot preserves everything), and only above numeric bars —
  writing an append-only `pattern_retirement_log` entry before any row is hidden or deleted (L3).
- **Status:** NOT_STARTED
- **CLI:** `forge learning retire [--dry-run] [--table <name>] [--hard]`
  - `--dry-run`: list every candidate and its qualifying bar, write nothing.
  - `--table <name>`: restrict the sweep to one of the five tables.
  - `--hard`: permit HARD_DELETE for rows meeting the stricter bar (default is SOFT_RETIRE only).
- **Entry Point:** `src/learning-engine/pattern-retirer.ts` → `retirePatterns(opts)`
- **Exports:** `retirePatterns`, `RetireOptions`, `RetirementResult`, `evaluateRetirement`
- **Dependencies:** the five pattern tables, `pattern_retirement_log` (write), BuildMemory client.
- **Database tables:**
  - `pattern_retirement_log` — **write** (one row per retirement).
  - `fix_patterns`, `error_patterns`, `skill_library`, `design_patterns` — **read**; on HARD_DELETE,
    row **delete**; SOFT_RETIRE writes no source-row change (enforced by anti-join).
  - `governance_rules` — **read** + `active = 0` **update** on SOFT_RETIRE (this is the only table with
    an `active` column).

**Per-table retirement mechanic.** SOFT_RETIRE means "excluded from every consuming query" — for the
four tables without an `active` column, exclusion is enforced by an **anti-join against
`pattern_retirement_log`** (via `src/learning-engine/retirement-filter.ts`, a shared helper returning
`WHERE NOT EXISTS (SELECT 1 FROM pattern_retirement_log r WHERE r.pattern_table = ? AND r.pattern_id =
<table>.id AND r.action_taken = 'SOFT_RETIRE')`). The `pattern_fingerprint` column stores each row's
natural key at retirement so it survives a HARD_DELETE.

| Source table | Natural key → `pattern_fingerprint` | SOFT_RETIRE bar (`ZERO_SUCCESS_RATE` / `STALE_UNUSED`) | HARD_DELETE bar (stricter) | Mechanic |
|---|---|---|---|---|
| `fix_patterns` | `error_fingerprint` | `occurrence_count >= 5` AND `success_rate = 0.0` AND `last_seen` > 30 days old | `times_fix_applied >= 10` AND `times_fix_succeeded = 0` AND superseding pattern active | Anti-join; HARD deletes row |
| `error_patterns` | `error_signature` | `occurrence_count >= 5` AND `success_rate = 0.0` AND `last_seen_at` > 30 days old | `occurrence_count >= 10` AND `success_rate = 0.0` AND a superseding `error_patterns` row active | Anti-join; HARD deletes row |
| `skill_library` | `skill_name` | `times_injected >= 5` AND `times_prevented_error = 0` AND `effectiveness_rate = 0.0` AND `created_at` > 30 days old | `times_injected >= 10` AND `times_prevented_error = 0` AND superseding skill active | Anti-join; HARD deletes row |
| `design_patterns` | `name` | `usage_count >= 5` AND (`effectiveness_score` IS NULL OR `effectiveness_score = 0.0`) AND `created_at` > 30 days old | `usage_count >= 10` AND `effectiveness_score = 0.0` AND superseding pattern active | Anti-join; HARD deletes row |
| `governance_rules` | `rule_short_name` | `enforcement_count = 0` AND `last_enforced` IS NULL AND `created_at` > 30 days old | (rare) contradicted by a newer active rule with same `source_error_fingerprint` | Set `active = 0`; HARD deletes row |

**Nonzero success is sacred (L4).** Any row with a recorded success (`success_rate > 0.0`,
`times_fix_succeeded >= 1`, `times_prevented_error >= 1`, `effectiveness_rate > 0.0`,
`effectiveness_score > 0.0`) is never retired under `ZERO_SUCCESS_RATE`; a formerly-successful row is
only retired as `SUPERSEDED` / `CONTRADICTS_NEWER_PATTERN` / `MANUAL`.

**Consuming query sites that MUST apply the anti-join** (via `retirement-filter.ts`) so retirement is
respected everywhere a pattern is read for injection or matching:
- `src/composer/` — every `fix_patterns` / `governance_rules` / `skill_library` read that injects
  learning context into assembled prompts (see AGENTS.md ForgeComposerEngine: "Database tables:
  `fix_patterns` (read), `governance_rules` (read), `skill_library` (read)").
- `src/engine/prompt-rewriter.ts` — its Build Memory query for highest-success `prompt_rewrite`
  resolutions and its "inject prevention rules from the matching error patterns" step (steps 1 and 4
  of the rewriter header).
- `src/engine/prompt-assembler.ts` — Contract 7 context injection of Build Memory warnings /
  governance excerpts.
- `src/learning-engine/cross-project-transfer.ts` — CrossProjectKnowledgeTransfer's own selection
  (an insight derived from a retired pattern is excluded — see below).
- Any `error_patterns` match path used by Contract 8 failure prediction / Contract 14 auto-recovery so
  a zero-success pattern can never be selected for auto-resolution.

---

### Agent: CrossProjectKnowledgeTransfer (src/learning-engine/)

- **Purpose:** Turn `cross_project_insights` from passive storage into an active push — at new-build
  start, inject every stack-compatible, non-retired insight into that build's prompt assembly.
- **Status:** NOT_STARTED
- **CLI:** `forge learning transfer <project-path> [--dry-run] [--build-id <id>]`
- **Entry Point:** `src/learning-engine/cross-project-transfer.ts` → `transferInsights(opts)`
- **Exports:** `transferInsights`, `TransferOptions`, `TransferResult`, `matchFingerprint`
- **Dependencies:** `cross_project_insights` (read + `applied_count` update), `build_runs` (read
  `stack_fingerprint`), `pattern_retirement_log` (read — anti-join), the prompt-assembler injection
  point, BuildMemory client.
- **Database tables:**
  - `cross_project_insights` — **read** + `applied_count` increment **update**.
  - `build_runs` — **read** (`stack_fingerprint` of the target build).
  - `pattern_retirement_log` — **read** (exclude insights derived from retired patterns).

**Matching algorithm (`matchFingerprint`).**
1. Load the target build's `build_runs.stack_fingerprint` (JSON `TEXT`, `JSON.parse`'d) and normalize
   to a `{ language, framework, database }` triple (lowercased, version-stripped).
2. For each `cross_project_insights` row, `JSON.parse` `applicable_fingerprints` (a JSON array) and
   normalize each entry to the same triple.
3. The insight **matches iff** at least one entry shares the target's exact `language` AND exact
   `framework` AND (when both specify one) exact `database`. A differing `language` or `framework` is
   an absolute disqualifier (L7 — hard stop, never a soft down-weight).
4. **Anti-join exclusion:** drop any matching insight whose `source_build_id` or whose evidence
   references a pattern present in `pattern_retirement_log` (a retired pattern's lesson is never
   re-transferred). Matched via the insight's `evidence` payload pattern ids against
   `pattern_retirement_log(pattern_table, pattern_id)`.

**Push vs. pull — decided: PUSH.** Transfer runs automatically at the start of a new build (no opt-in).
Justification: a single-operator factory (root PRD Target User) gains nothing from requiring the
operator to opt each build into learning FORGE already paid to acquire; the Problem Statement's whole
point is that insight should travel without human prompting. Safety is structural, not opt-in: (a) the
hard fingerprint filter (L7), (b) the retired-pattern anti-join, and (c) injected insights are
**context for prompts, not auto-applied code** — they never mutate the build's governance and never
bypass a Contract 2 gate. Each successfully injected insight's `applied_count` is incremented by 1
(the only write this agent makes to `cross_project_insights`).

---

### Agent: BuildBrainEvolver (src/learning-engine/)

- **Purpose:** Make `src/engine/prompt-rewriter.ts`'s template selection evolve from measured outcomes —
  without ever editing the rewriter (L5). Proposes strategy switches via `pending_evolutions`, and runs
  the promotion monitoring window / rollback bookkeeping on `evolution_promotions`.
- **Status:** NOT_STARTED
- **CLI:** `forge learning evolve [--dry-run] [--task-type <SCAFFOLD|CRUD|INTEGRATION|AI_PIPELINE|CONFIG|TEST|FIX>]`
- **Entry Point:** `src/learning-engine/build-brain-evolver.ts` → `evolveBuildBrain(opts)`
- **Exports:** `evolveBuildBrain`, `EvolveOptions`, `EvolveResult`, `rankStrategies`,
  `runMonitoringWindows`
- **Dependencies:** `prompt_scores` (read), `decision_weights` (read), `pending_evolutions` (write —
  proposals only), `evolution_promotions` (read + `post_promotion_success_rate` / `rollback_triggered`
  update), BuildMemory client. **Never writes to `src/engine/prompt-rewriter.ts`.**
- **Database tables:**
  - `prompt_scores` — **read** (`prompt_template_hash`, `task_type`, `first_pass_success`,
    `gate_pass_rate`, `drift_score`).
  - `decision_weights` — **read** (`downstream_error_rate` per strategy).
  - `pending_evolutions` — **write** (strategy-switch proposals; never promotes them itself).
  - `evolution_promotions` — **read** + **update** (`post_promotion_success_rate`,
    `rollback_triggered`, `rollback_reason` during the monitoring window).

**How a "rewrite strategy" is represented — decided: a `prompt_scores.prompt_template_hash` variant per
task type.** Justification: this is the identifier the rewriter's outcomes are *already* recorded
against (`prompt_scores.prompt_template_hash` + `task_type`), so it needs no new column and no new
table. Each distinct rewrite approach for a `task_type` is one `prompt_template_hash`; its track record
is the set of `prompt_scores` rows carrying that hash, cross-referenced with `decision_weights`
downstream error rate. (A skill-library entry was rejected as the representation: `skill_library` is
error→prevention content, not a rewrite-approach identity, and using it would blur two concepts.)

**Ranking (`rankStrategies`).** Per `task_type`, over a minimum sample of **10** `prompt_scores` rows
per candidate `prompt_template_hash`, score each candidate by mean `first_pass_success` (primary),
mean `gate_pass_rate` (secondary), and inverse mean `decision_weights.downstream_error_rate` (tie-break).
A challenger beats the incumbent when its mean `first_pass_success` exceeds the incumbent's by **≥ 0.10
(10 percentage points)** over that sample.

**Proposal routing (L5).** When a challenger wins, BuildBrainEvolver writes a `pending_evolutions` row
(`evolution_type = 'TEMPLATE'` for a template-body change, or `'CONFIG'` for a selection-mapping
change), with `evidence` citing the two candidates' `prompt_template_hash`es, their sample sizes, and
their first-pass means, and a `confidence` equal to the observed win margin capped at `[0,1]`. It then
**stops** — EvolutionPromoter (F20) decides whether that proposal auto-promotes. BuildBrainEvolver
never mutates the rewriter or any live selection directly.

**Monitoring window (`runMonitoringWindows`).** For each `evolution_promotions` row with
`promotion_method = 'AUTO'` and `post_promotion_success_rate IS NULL`, count builds since `promoted_at`;
once `monitoring_window_builds` have elapsed, compute the promoted change's success rate over those
builds, write it to `post_promotion_success_rate`, and if
`post_promotion_success_rate < (pre_promotion_success_rate - 0.15)`, set `rollback_triggered = 1` +
`rollback_reason` and invoke the type-specific reversal described under EvolutionPromoter (L8).

---

## Schema Additions Needed

System 2 needs **exactly the two new tables defined in `SCHEMA_ADDITIONS.md`** — this document
references them, it does not redefine them:

- **`evolution_promotions`** (SCHEMA_ADDITIONS §3) — written by EvolutionPromoter, read by
  BuildBrainEvolver (rollback monitoring), `forge health`, `forge learning status`.
- **`pattern_retirement_log`** (SCHEMA_ADDITIONS §4) — written by PatternRetirer, read by
  CrossProjectKnowledgeTransfer and every consuming query site's anti-join.

No other new table and no new column on any existing table is required or permitted (SCHEMA_ADDITIONS
§8; open items are OQ1/OQ2 in the PRD, deferred to a schema revision rather than invented). Both tables
ship inside the single `2.2.1 → 2.3.0` bump and are added to `ALL_FORGE_TABLES`.

### Existing tables gaining new READ/WRITE relationships

| Existing table | New relationship | By which agent |
|---|---|---|
| `pending_evolutions` | read + `status` update (→ APPROVED/REJECTED) | EvolutionPromoter; **write** (new proposals) by BuildBrainEvolver |
| `fix_patterns` | read + `governance_rule_id` back-link update (F24); read + HARD delete (F21) | EvolutionPromoter; PatternRetirer |
| `error_patterns` | read; HARD delete; anti-join on read | PatternRetirer; consuming sites |
| `governance_rules` | write (`AUTO_ELEVATED` rows); `active = 0` on retire | EvolutionPromoter; PatternRetirer |
| `skill_library` | read; HARD delete; anti-join on read | PatternRetirer; consuming sites |
| `design_patterns` | read; HARD delete; anti-join on read | PatternRetirer; consuming sites |
| `cross_project_insights` | read + `applied_count` increment | CrossProjectKnowledgeTransfer |
| `prompt_scores` | read (strategy outcomes) | BuildBrainEvolver |
| `decision_weights` | read (downstream error rate) | BuildBrainEvolver |
| `self_created_agents` | read (Contract 17 test-validation check before promoting an agent proposal) | EvolutionPromoter |
| `forge_meta` | read/write (versioned confidence threshold + `.history`; THRESHOLD/CONFIG values + `.history`) | EvolutionPromoter |
| `build_runs` | read (`stack_fingerprint`) | CrossProjectKnowledgeTransfer |

---

## Data Flow

```
Phase 5 completes (src/phases/phase5-learner.ts, steps 1–10, UNCHANGED — still PROPOSE-only)
   │  Template Evolver → governance_versions proposals (Contract 16)
   │  Agent Creator    → self_created_agents 'proposed' (Contract 17)
   │  (System 2 assumes proposals also land as pending_evolutions rows with a confidence)
   ▼
[NEW Step 11 — in-process, decoupled] EvolutionPromoter.promoteEvolutions()
   │  for each PENDING row:
   │    read forge_meta threshold T (default 0.90)  ── L1 record T
   │    evidence_build_count = parse(evidence)      ── OQ2
   │    AUTO iff confidence >= T AND evidence_build_count >= 5 AND type != GATE  ── L2
   │       ├─ write evolution_promotions (method=AUTO, pre_promotion_success_rate)   ── L3 (log first)
   │       ├─ flip pending_evolutions.status = APPROVED
   │       └─ ACTIVATE per type (RULE→governance_rules AUTO_ELEVATED / THRESHOLD·CONFIG→forge_meta /
   │                             TEMPLATE→governance_versions / HOOK→enabled)  ── effective NEXT build
   │    else: leave PENDING (no row written)
   │  F24 sweep: fix_patterns with proven prevention → AUTO_ELEVATED governance_rules + back-link
   ▼
[monitoring window] over the next `monitoring_window_builds` (=10) builds, BuildBrainEvolver
   backfills evolution_promotions.post_promotion_success_rate; if it drops > 0.15 below
   pre_promotion_success_rate → rollback_triggered=1 + reverse activation  ── L8
   ▼
[NEW scheduled sweep — node-cron, task_type='memory_cleanup'] PatternRetirer.retirePatterns()
   │  SOFT_RETIRE (default) / HARD_DELETE (stricter bar) per table
   │  write pattern_retirement_log FIRST (L3), then hide/delete source row
   ▼
[START of a NEW build — Phase 1B/Phase 2] CrossProjectKnowledgeTransfer.transferInsights()
   │  match build_runs.stack_fingerprint against cross_project_insights.applicable_fingerprints (L7)
   │  anti-join out insights derived from pattern_retirement_log rows
   │  inject matches into prompt assembly, increment applied_count  ── PUSH, context-only
   ▼
[CONTINUOUS across Phase 3 prompt executions] BuildBrainEvolver observes prompt_scores/decision_weights
   │  rankStrategies per task_type; challenger beats incumbent by ≥ 0.10 first-pass
   └─ write pending_evolutions proposal (type TEMPLATE/CONFIG)  ── routes back to EvolutionPromoter (L5)
      (never edits src/engine/prompt-rewriter.ts)
```

---

## Integration Points

### Where these agents hook into `src/phases/phase5-learner.ts` — decided

Phase 5's existing 10-step sequence is **unchanged** (it still only proposes). System 2 hooks in as
follows, justified per component:

- **EvolutionPromoter — NEW Step 11, appended in-process after Step 10.** Justification: promotion must
  see the freshest `pending_evolutions` just written earlier in the *same* Phase 5 pass (Template
  Evolver/Agent Creator/BuildBrainEvolver proposals). Running it inline immediately after the summary
  report guarantees that freshness and keeps promotion co-located with the learning it acts on. It runs
  under the same NON-FATAL house style as every other Phase 5 step (Contract 4 / phase5-learner header):
  a promotion failure degrades to a warning and never halts. It is **also** independently invokable via
  `forge learning promote`. It is **not** a `scheduled_tasks` row (OQ1 — no matching `task_type` enum
  value exists, and inventing one is a schema change SCHEMA_ADDITIONS.md forbids).
- **PatternRetirer — separate `node-cron` scheduled sweep, decoupled from Phase 5.** Justification:
  retirement is time-based ("`last_seen` > 30 days"), not build-triggered — coupling it to Phase 5
  would make it fire far more often than needed and never fire for a stale project that has not built
  recently. It is registered as a `scheduled_tasks` row with `task_type = 'memory_cleanup'` (an exact
  fit for the existing enum) and cron expression `'0 3 * * 0'` (weekly, Sunday 03:00). `node-cron` (the
  existing dependency behind `scheduled_tasks`) triggers `retirePatterns()`; the row's
  `last_run_at`/`last_result`/`run_count` are updated per the existing scheduled-task convention.
- **CrossProjectKnowledgeTransfer — at the START of a new build (Phase 1B/Phase 2), not in Phase 5.**
  Justification: transfer is a build-*entry* concern (inject prior learning into the new build), the
  temporal opposite of Phase 5 (which runs at build *exit*). It is invoked by the Phase 1B/2
  orchestrator during prompt assembly, and independently via `forge learning transfer`.
- **BuildBrainEvolver — continuous across Phase 3, plus a proposal emission at Phase 5 and monitoring
  bookkeeping.** Justification: it observes per-prompt rewrite outcomes as they are recorded in Phase 3,
  but it only *emits* proposals and runs monitoring-window bookkeeping at a natural batch boundary
  (end of Phase 5, right before Step 11), so its fresh proposals are available to EvolutionPromoter in
  the same pass.

### node-cron cadence

- **PatternRetirer:** `scheduled_tasks` row, `task_type = 'memory_cleanup'`, cron `'0 3 * * 0'`
  (weekly). Weekly is conservative — retirement is intentionally slow and reversible-in-spirit, so a
  frequent sweep buys nothing and a weekly sweep bounds the window in which dead patterns can be
  injected.
- **EvolutionPromoter:** in-process after Phase 5 (OQ1); no cron row. A future `'learning_sweep'`
  `task_type` enum value (schema revision) would let it also run on an independent cron, but that is
  out of scope and explicitly not invented here.
- **BuildBrainEvolver monitoring:** runs inside the Phase 5 pass (per build), so its cadence is "once
  per build" — the natural unit for a "builds elapsed" monitoring window; no separate cron is needed.

---

## Canonical Rules (System 2 Specific)

1. EvolutionPromoter NEVER promotes an `evolution_type = 'GATE'` row automatically (L2 / Contract 2).
2. Every autonomous action writes its audit row (`evolution_promotions` / `pattern_retirement_log`)
   **before** the effect takes hold (L3).
3. No pattern with any recorded success is ever retired under a zero-success reason (L4).
4. No component self-modifies outside the promotion trail; BuildBrainEvolver proposes, EvolutionPromoter
   decides (L5 / Canonical Rule 3).
5. Cross-project transfer refuses incompatible stacks as a hard stop, never a soft preference (L7).
6. Every AUTO promotion carries a monitoring window and is auto-rolled-back on the 15-point regression
   condition (L8).
7. All new tables/writes carry `machine_id` (Contract 4/20) and target the SQLite Build Memory only —
   never Postgres/Supabase (SCHEMA_ADDITIONS §0, §7).
8. Retirement is respected everywhere via the shared `retirement-filter.ts` anti-join — a retired
   pattern must not reappear in Composer, Prompt Rewriter, Prompt Assembler, failure prediction, or
   cross-project transfer.
