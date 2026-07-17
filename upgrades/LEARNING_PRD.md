# FORGE 2.0 — LEARNING PRODUCT REQUIREMENTS DOCUMENT

## System 2: Recursive Enterprise Learning Engine

> **Read `upgrades/SCHEMA_ADDITIONS.md` first.** This PRD is bound by that document's two new
> tables (`evolution_promotions`, `pattern_retirement_log`) and by the existing learning schema in
> `src/learning/database.ts` / `src/learning/types.ts`. No requirement here invents a table or
> column not defined in one of those files. Where a field appears to be missing, it is recorded as
> an **Open Question** (see final section) rather than silently assumed.

---

## Product Overview

System 2 is an **extension** of FORGE's existing Phase 5 Recursive Learner
(`src/phases/phase5-learner.ts`, PRD F9), not a replacement for it. Phase 5 today reads a completed
build and *proposes* intelligence — it writes `error_patterns`, `cross_project_insights`,
`governance_versions` proposals (Contract 16), and `self_created_agents` proposals (Contract 17),
and it strictly **only ever proposes**: it never promotes, activates, retires, or transfers
anything. Every one of those actions is currently a manual, human-performed step.

System 2 adds the missing **autonomous action layer** on top of that proposal layer, within tight,
auditable, numerically-bounded limits: it auto-promotes high-confidence proposals, retires
dead-weight patterns, actively pushes proven insights into new projects, and lets FORGE's
prompt-rewrite strategy itself evolve based on measured outcomes. It introduces four new agents —
**EvolutionPromoter**, **PatternRetirer**, **CrossProjectKnowledgeTransfer**, **BuildBrainEvolver**
— whose full architecture is specified in `upgrades/LEARNING_BLUEPRINT.md`.

---

## Problem Statement

FORGE accumulates learning data on every build but **nothing acts on it autonomously**. Concretely,
against the live SQLite Build Memory (`~/.forge/forge_memory.db`):

1. **Proposals rot in a queue.** `pending_evolutions` rows are written by Phase 5's Template Evolver
   and Agent Creator with a computed `confidence` (a REAL 0.0–1.0 column that already exists —
   `PendingEvolution.confidence`, `src/learning/types.ts`). A row can carry `confidence = 0.97` with
   strong evidence across a dozen builds and still sit at `status = 'PENDING'` indefinitely, because
   the *only* path to `APPROVED` is a human reading the proposal and manually flipping it. Every
   improvement FORGE discovers about itself is gated behind operator attention that does not scale.

2. **Dead patterns accumulate forever.** `fix_patterns` and `error_patterns` rows are created the
   first time an error is seen (Contract 15) and their `success_rate` / `times_fix_applied` /
   `times_fix_succeeded` counters update on every application — but **nothing ever removes a row that
   has failed every time it was tried**. A `fix_patterns` row with `occurrence_count = 8`,
   `times_fix_applied = 8`, `times_fix_succeeded = 0`, `success_rate = 0.0` stays in the table,
   keeps matching new errors via `idx_fix_patterns_fingerprint`, and keeps getting injected into
   prompts by the Composer (`src/composer/`) and the Prompt Rewriter
   (`src/engine/prompt-rewriter.ts`) as if it were useful. Bad advice is never pruned.

3. **Cross-project insight is passive.** `cross_project_insights` is written by Phase 5 with an
   `applicable_fingerprints` list and an `applied_count`, but it is **storage only**. Nothing reads
   an insight from Project A and proactively applies it when Project B — running a compatible stack —
   starts building. The knowledge exists; it just never travels on its own.

4. **The rewrite brain is static.** `src/engine/prompt-rewriter.ts` selects a canonical per-task-type
   approach that is fixed in code. It records outcomes into `prompt_scores`
   (`prompt_template_hash`, `first_pass_success`, `gate_pass_rate`, `drift_score`) and
   `decision_weights` (`downstream_error_rate`), but it never uses that accumulated evidence to
   change *which* strategy it selects. FORGE measures which rewrite approaches work and then ignores
   the measurement.

The net effect: FORGE is a factory that writes excellent notes to itself and then never reads them
back into action. System 2 closes that loop — autonomously, but only inside gates the operator can
audit and reverse.

---

## Target User

**Reid Whitesides** — non-technical founder operating multiple businesses, building software using
the Visual AI Method (per root `PRD.md` Target User). FORGE's Build Memory is a **single-operator
local SQLite file**; there is exactly one human in the loop. System 2's entire value proposition is
reducing the number of routine, high-confidence decisions that require that single operator's
attention, while keeping every autonomous decision cheap to inspect and cheap to undo. The operator
must always be able to answer "what did FORGE change about itself, why, and how do I revert it?" from
Build Memory alone.

---

## Success Metrics

All metrics are measured against `~/.forge/forge_memory.db` and reported by `forge learning status`
(new subcommand) and `forge health`.

| # | Metric | Definition | Target |
|---|--------|-----------|--------|
| M1 | Auto-promotion rate | Fraction of `pending_evolutions` rows reaching `confidence >= 0.90` that are auto-promoted (an `evolution_promotions` row with `promotion_method = 'AUTO'`) within 3 subsequent builds of the proposal's `created_at`, without any human review | ≥ 80% |
| M2 | Human-review load reduction | Count of `pending_evolutions` rows a human must manually action per 10 builds, versus the pre-System-2 baseline (100% manual) | ≤ 30% of baseline |
| M3 | Promotion safety | Fraction of AUTO promotions that survive their monitoring window without `rollback_triggered = 1` | ≥ 90% |
| M4 | Dead-pattern reduction | Count of `fix_patterns` + `error_patterns` rows with `success_rate = 0.0` AND `times_fix_applied >= 5` (or `occurrence_count >= 5`), after 30 days of PatternRetirer operation, versus before | reduced by ≥ 90% |
| M5 | Cross-project application rate | Fraction of new builds whose stack fingerprint matches ≥ 1 non-retired `cross_project_insights` row that receive that insight injected into Phase 1B/2 assembly (measured as `applied_count` increments attributable to CrossProjectKnowledgeTransfer) | ≥ 75% of eligible builds |
| M6 | Rewrite first-pass improvement | Mean `prompt_scores.first_pass_success` for task types whose rewrite strategy BuildBrainEvolver has evolved, over the 20 builds following the evolution, versus the 20 builds preceding it | +10 percentage points, and never negative |
| M7 | Auditability | Fraction of autonomous learning actions (promotion, retirement, transfer) that have a corresponding row in `evolution_promotions` or `pattern_retirement_log` | 100% (hard requirement, no exceptions) |

---

## Scope Boundaries

### In scope
- Auto-promotion of already-proposed, already-evidence-backed `pending_evolutions` rows whose
  `confidence` and evidence volume clear the numeric bars in F1.
- Conservative, logged, reversible-in-spirit retirement of zero-success patterns (F2).
- Active push of stack-compatible `cross_project_insights` into new builds (F3).
- Outcome-driven evolution of the prompt-rewrite strategy, routed back through EvolutionPromoter (F4).
- Auto-creation of first-class `governance_rules` rows from proven fix-pattern prevention rules (F5).

### Explicit non-goals
- **N1 — Does NOT touch Contract 2's four structural build gates.** Gate 1 (post-PRD), Gate 2
  (post-Architecture), Gate 3 (post-Governance+queue), and Gate 4 (Sentinel escalation on novel
  errors) remain "structural, not configurable" with "no mechanism to bypass" (Contract 2).
  EvolutionPromoter automates a **different, narrower** decision — "should this specific
  already-proposed, already-evidence-backed template/rule/hook/threshold/config proposal go live" —
  and never the build-halting gates. It also **never** auto-promotes an evolution of
  `evolution_type = 'GATE'`, regardless of confidence (Learning Iron Law L2).
- **N2 — Does NOT auto-promote anything below the confidence bar**, no matter how old the proposal.
  Age never substitutes for confidence or evidence. A `confidence = 0.70` proposal from a year ago is
  never promoted.
- **N3 — Does NOT retire a pattern with any nonzero success rate.** A single recorded success
  (`success_rate > 0.0`, or `times_fix_succeeded >= 1`, or `times_prevented_error >= 1`) permanently
  disqualifies a row from retirement under the ZERO_SUCCESS_RATE reason.
- **N4 — Does NOT transfer insights across incompatible stack fingerprints.** A Next.js/Supabase
  insight is never pushed into a Python/FastAPI build. The fingerprint-matching rule (F3) is a hard
  filter, not a heuristic hint.
- **N5 — Does NOT let any component silently self-modify.** BuildBrainEvolver never edits
  `src/engine/prompt-rewriter.ts` or mutates a live strategy directly; every change it wants routes
  through a `pending_evolutions` proposal and the EvolutionPromoter audit trail.
- **N6 — Does NOT bypass Contract 16/17 evidence requirements.** EvolutionPromoter consumes what
  Template Evolver and Agent Creator produce. It never fabricates evidence, never lowers the evidence
  bar, and only automates the **human step** — and only when the evidence bar is already exceeded.
- **N7 — Does NOT run on Postgres/Supabase.** All logic targets the single-operator SQLite Build
  Memory. No requirement here assumes RLS, multi-tenancy, or a hosted database.

---

## Feature Requirements

### F20: Auto-Promotion of Pending Evolutions Above Confidence Threshold

**Core Requirement.** A new **EvolutionPromoter** agent evaluates every `pending_evolutions` row with
`status = 'PENDING'` and decides whether it may go live without human review. A row is auto-promoted
**only when all of these hold**:

- `confidence >= 0.90` (reads the existing `PendingEvolution.confidence` REAL column — F20 adds the
  *decision logic*, not the field), AND
- the promotion's `evidence_build_count >= 5` (the number of distinct builds the underlying evidence
  was drawn from, derived from the proposal's `evidence` payload), AND
- `evolution_type != 'GATE'` (GATE evolutions are always human-gated — non-goal N1 / L2).

The active `confidence` threshold is `0.90`, stored and **versioned** in `forge_meta` under key
`learning.promotion.confidence_threshold` (with an append-only history key
`learning.promotion.confidence_threshold.history` recording every prior value and its change time),
so the threshold in force at any promotion is reconstructable. Every promotion decision — AUTO,
HUMAN_APPROVED, or HUMAN_OVERRIDE_REJECTED — writes exactly one `evolution_promotions` row capturing
`confidence_at_promotion`, `confidence_threshold_applied`, `evidence_build_count`, and
`pre_promotion_success_rate`, and flips the source `pending_evolutions.status` to `APPROVED` (or
`REJECTED`). An AUTO promotion sets a **monitoring window** of `monitoring_window_builds = 10`
(schema default) subsequent builds during which the promoted change's effect is watched; if its
success rate regresses more than **15 percentage points** below `pre_promotion_success_rate` within
that window, the promotion is automatically rolled back (`rollback_triggered = 1`, `rollback_reason`
set, source change deactivated) — see F4/BuildBrainEvolver for the monitoring mechanic and
LEARNING_BLUEPRINT §EvolutionPromoter for the exact rollback path per `evolution_type`.

**Success Criteria.**
- Given a `PENDING` row with `confidence = 0.94`, `evolution_type = 'RULE'`, evidence spanning 6
  builds, and no human interaction, the row reaches `status = 'APPROVED'`, an `evolution_promotions`
  row with `promotion_method = 'AUTO'` exists, and the change is live for the next build.
- Given a `PENDING` row with `confidence = 0.88`, no `evolution_promotions` row is created and the
  row remains `PENDING`.
- Given a `PENDING` row with `evolution_type = 'GATE'` and `confidence = 0.99`, no AUTO promotion
  occurs; the row remains `PENDING` awaiting a human.
- `forge learning promote --dry-run` reports exactly which rows *would* be promoted and why, writing
  nothing.

### F21: Pattern Retirement for Zero-Success Patterns

**Core Requirement.** A new **PatternRetirer** agent sweeps `fix_patterns`, `error_patterns`,
`skill_library`, `design_patterns`, and `governance_rules` for dead-weight rows and retires them,
conservatively and reversibly-in-spirit. Two retirement actions exist, each with a **numeric bar**:

- **SOFT_RETIRE** (`pattern_retirement_log.action_taken = 'SOFT_RETIRE'`, the default): the row is
  excluded from all consuming queries but not deleted. Bar: `occurrence_count >= 5`
  (or, for `skill_library`, `times_injected >= 5`) **AND** `success_rate = 0.0`
  (or `effectiveness_rate = 0.0` for skills, `times_prevented_error = 0`) **AND** the row's
  `last_seen` / `last_seen_at` / `last_enforced` is older than **30 days**. Retirement reason is
  `ZERO_SUCCESS_RATE` or `STALE_UNUSED`.
- **HARD_DELETE** (`action_taken = 'HARD_DELETE'`, stricter): the source row is removed from its
  table; the `pattern_retirement_log` row is the only surviving record it ever existed. Bar:
  `times_fix_applied >= 10` (or `times_injected >= 10`) **AND** `times_fix_succeeded = 0` (never
  once succeeded) **AND** a superseding pattern is already active
  (`superseded_by_pattern_id` set, `retirement_reason = 'SUPERSEDED'` or `CONTRADICTS_NEWER_PATTERN`).

For tables **without** an `active` column (`fix_patterns`, `error_patterns`, `skill_library`,
`design_patterns` — only `governance_rules` has `active INTEGER`), SOFT_RETIRE is enforced by an
**anti-join against `pattern_retirement_log`** at every consuming query site: a row whose
`(pattern_table, pattern_id)` appears in `pattern_retirement_log` with `action_taken = 'SOFT_RETIRE'`
is treated as retired. Every `pattern_retirement_log` row snapshots the source counters
(`times_applied_before_retirement`, `times_succeeded_before_retirement`, `success_rate_at_retirement`,
`last_seen_before_retirement`) and `pattern_fingerprint`, so a retirement is fully auditable and a
SOFT_RETIRE is reversible (delete the log row) even after the source counters move on. For
`governance_rules`, SOFT_RETIRE additionally sets `active = 0`.

**Success Criteria.**
- A `fix_patterns` row with `occurrence_count = 6`, `success_rate = 0.0`, `last_seen` 40 days old is
  SOFT_RETIREd: a `pattern_retirement_log` row exists with `action_taken = 'SOFT_RETIRE'`,
  `retirement_reason = 'ZERO_SUCCESS_RATE'`, and the row no longer appears in Composer / Prompt
  Rewriter injection.
- A `fix_patterns` row with `success_rate = 0.02` (one success in 50) is **never** retired under
  ZERO_SUCCESS_RATE (non-goal N3).
- A HARD_DELETE only occurs when a superseding pattern id is recorded; the log row preserves the
  deleted row's `pattern_fingerprint`.
- `forge learning retire --dry-run` lists every candidate and its bar without writing.

### F22: Cross-Project Knowledge Transfer

**Core Requirement.** A new **CrossProjectKnowledgeTransfer** agent converts
`cross_project_insights` from passive storage into an **active push**. At the start of a new build's
Phase 1B/Phase 2, it selects every `cross_project_insights` row whose `applicable_fingerprints`
matches the target build's `stack_fingerprint` (from `build_runs`) under the exact matching rule
below, excludes any insight derived from a retired pattern (anti-join against
`pattern_retirement_log`), and injects the surviving insights into the prompt assembly for that
build, incrementing each applied insight's `applied_count`.

**Fingerprint matching rule (hard filter, non-goal N4).** `stack_fingerprint` and each entry of
`applicable_fingerprints` are normalized to a `{ language, framework, database }` triple (lowercased,
version-stripped). An insight is applicable **iff** at least one entry of its
`applicable_fingerprints` shares the target's exact `language` **and** exact `framework` **and**
(when both specify one) exact `database`. A differing `language` is an absolute disqualifier —
a Python/FastAPI insight is never applicable to a TypeScript/Next.js build, and vice versa.

**Push vs. pull decision.** This feature is **push**: the transfer runs automatically at build start
and injects matching insights without the build opting in. Justification — a single-operator factory
gains nothing from requiring the operator to remember to opt each new build into learning it already
paid to acquire; the whole point (Problem Statement §3) is that insights should travel *without*
human prompting. Safety comes not from opt-in but from (a) the hard fingerprint filter, (b) the
retired-pattern anti-join, and (c) the fact that injected insights are *context*, not
auto-applied code changes — they inform the build's prompts, they do not mutate its governance.

**Success Criteria.**
- A build on `{typescript, nextjs, supabase}` receives every non-retired insight whose
  `applicable_fingerprints` includes a matching triple; each such insight's `applied_count`
  increments by 1.
- A build on `{python, fastapi, postgres}` receives **zero** insights whose only fingerprints are
  `{typescript, nextjs, *}`.
- An insight whose source pattern was SOFT_RETIREd or HARD_DELETEd (present in
  `pattern_retirement_log`) is **never** transferred.
- `forge learning transfer <project> --dry-run` lists the insights that would be injected.

### F23: Build Brain Evolution of Rewrite Strategies

**Core Requirement.** A new **BuildBrainEvolver** agent makes `src/engine/prompt-rewriter.ts`'s
template selection *evolve* based on measured outcomes, without ever mutating the rewriter directly
(non-goal N5). A "rewrite strategy" is represented as a distinct
`prompt_scores.prompt_template_hash` per task type; its track record accumulates in `prompt_scores`
(`first_pass_success`, `gate_pass_rate`, `drift_score`) and `decision_weights`
(`downstream_error_rate`). BuildBrainEvolver periodically computes, per `task_type`, which
`prompt_template_hash` has the best outcome profile over a minimum sample, and when a challenger
strategy beats the incumbent by a material margin over sufficient evidence, it **emits a
`pending_evolutions` proposal** (`evolution_type = 'TEMPLATE'` or `'CONFIG'`) recommending the
rewriter adopt the challenger. That proposal is then subject to F20 — EvolutionPromoter evaluates its
confidence and either auto-promotes it (activating the new strategy for the next build) or leaves it
for a human. BuildBrainEvolver also runs the F20 **monitoring window** bookkeeping: it backfills
`evolution_promotions.post_promotion_success_rate` after `monitoring_window_builds` elapse and
triggers rollback when the 15-percentage-point regression condition is met.

**Success Criteria.**
- When a challenger `prompt_template_hash` for `task_type = 'SCHEMA'` shows a higher
  `first_pass_success` mean over ≥ 5 builds than the incumbent, a `pending_evolutions` row proposing
  the switch exists — and BuildBrainEvolver has written **no** change to `prompt-rewriter.ts`.
- No strategy switch ever goes live except via an `evolution_promotions` row (audit trail intact,
  M7).
- After a promoted strategy's monitoring window, its `evolution_promotions.post_promotion_success_rate`
  is populated; if it regressed > 15 points below `pre_promotion_success_rate`,
  `rollback_triggered = 1` and the incumbent strategy is restored.

### F24: Governance Rule Auto-Generation from Recurring Failures

**Core Requirement.** Contract 15 already generates `prevention_rule` **text** on an `error_patterns`
row at 3+ occurrences, and a `fix_patterns` row carries an `auto_governance_rule` text field. F24's
addition is auto-**creating a first-class `governance_rules` row** — not merely a text field — when a
fix pattern's prevention rule has *proven itself*. EvolutionPromoter is the agent that performs this
elevation, using the existing `governance_rules.source = 'AUTO_ELEVATED'` enum value, which exists in
the schema for exactly this purpose. A `fix_patterns` row is elevated to a `governance_rules` row
**iff**: it carries a non-null `auto_governance_rule` (prevention text), `success_rate >= 0.90`,
`times_fix_applied >= 5`, and it does not already have a `governance_rule_id` set. On elevation,
EvolutionPromoter inserts a `governance_rules` row with `source = 'AUTO_ELEVATED'`, `active = 1`,
`rule_text` from `auto_governance_rule`, `rule_short_name` derived from `error_fingerprint`,
`source_error_fingerprint = fix_patterns.error_fingerprint`, and `tech_stack_tags` copied from the
fix pattern; it back-links the new rule's id into `fix_patterns.governance_rule_id`; and it records
the action as an `evolution_promotions` row (`evolution_type = 'RULE'`, `promotion_method = 'AUTO'`).
This keeps every autonomous rule creation inside the same audit trail as every other promotion (M7).

**Success Criteria.**
- A `fix_patterns` row with `auto_governance_rule` text, `success_rate = 0.93`,
  `times_fix_applied = 7`, `governance_rule_id = NULL` results in a new `governance_rules` row with
  `source = 'AUTO_ELEVATED'`, `active = 1`, and the fix pattern's `governance_rule_id` now populated.
- The elevation is traceable via an `evolution_promotions` row.
- A `fix_patterns` row with `success_rate = 0.80` is **not** elevated (below the 0.90 bar).
- Re-running the sweep does not create a duplicate rule (the `governance_rule_id` back-link makes it
  idempotent).

---

## User Stories

**US1 → F20.** *As Reid, I want FORGE to automatically promote a template/rule proposal it is highly
confident about, so that I do not have to manually review and approve improvements FORGE has already
proven across multiple builds.*

**US2 → F20/F23.** *As Reid, I want every auto-promotion to be watched for a fixed number of builds
and automatically rolled back if it makes things worse, so that autonomy never permanently degrades
my factory behind my back.*

**US3 → F21.** *As Reid, I want FORGE to retire fix patterns that have never once worked, so that bad
advice stops being injected into my builds and my Build Memory stays a source of good signal.*

**US4 → F21.** *As Reid, I want pattern retirement to be logged and reversible-in-spirit rather than a
silent hard delete, so that I can see exactly what was retired and why, and undo a soft retirement if
FORGE was wrong.*

**US5 → F22.** *As Reid, I want a lesson learned building one project to be automatically applied to
the next compatible project, so that I stop paying to re-learn the same thing on every new build.*

**US6 → F22.** *As Reid, I want cross-project transfer to refuse to push a lesson into an incompatible
stack, so that a Next.js trick never corrupts a Python build.*

**US7 → F23.** *As Reid, I want FORGE's prompt-rewrite strategy to get better as it learns which
approaches actually succeed, so that my first-pass success rate climbs over time without me tuning
anything.*

**US8 → F24.** *As Reid, I want a fix pattern that has reliably prevented an error to be promoted into
a real, enforced governance rule, so that the prevention becomes a first-class part of how FORGE
builds rather than a note buried in a fix-pattern row.*

## Acceptance Criteria (per user story, testable/observable)

**US1**
- [ ] Running EvolutionPromoter against a DB with a `PENDING`, `confidence >= 0.90`,
      `evidence_build_count >= 5`, non-GATE row results in that row at `status = 'APPROVED'`.
- [ ] Exactly one `evolution_promotions` row with `promotion_method = 'AUTO'` is written for it.
- [ ] The change is reflected in the next build (e.g. an `AUTO_ELEVATED` `governance_rules` row is
      active, or the promoted threshold/config value is live in `forge_meta`).
- [ ] `confidence_threshold_applied` on the row equals the current `forge_meta` threshold (0.90).

**US2**
- [ ] Each AUTO `evolution_promotions` row has `monitoring_window_builds = 10` and
      `post_promotion_success_rate = NULL` until 10 builds elapse.
- [ ] After 10 builds, `post_promotion_success_rate` is populated.
- [ ] If `post_promotion_success_rate < pre_promotion_success_rate - 0.15`, `rollback_triggered = 1`,
      `rollback_reason` is non-null, and the promoted change is deactivated.

**US3**
- [ ] A `fix_patterns`/`error_patterns` row meeting the SOFT_RETIRE bar produces a
      `pattern_retirement_log` row with `action_taken = 'SOFT_RETIRE'`.
- [ ] The retired row no longer appears in Composer / Prompt Rewriter injection (verified by the
      anti-join at those query sites).

**US4**
- [ ] No source row is HARD_DELETEd unless `superseded_by_pattern_id` is set and the stricter bar is
      met.
- [ ] Every retirement (soft or hard) has a `pattern_retirement_log` row snapshotting the counters and
      `pattern_fingerprint`.
- [ ] Deleting a SOFT_RETIRE log row restores the source row to consuming queries.

**US5**
- [ ] A new build on a matching stack fingerprint has each applicable non-retired insight injected and
      its `applied_count` incremented by 1.
- [ ] `forge learning transfer <project> --dry-run` reports the same insight set without incrementing.

**US6**
- [ ] A build whose `language` differs from an insight's fingerprints receives zero of that insight.
- [ ] An insight whose source pattern is in `pattern_retirement_log` is never transferred.

**US7**
- [ ] A materially better challenger strategy produces a `pending_evolutions` proposal, never a direct
      edit to `prompt-rewriter.ts`.
- [ ] A strategy switch only goes live through an `evolution_promotions` row.

**US8**
- [ ] A `fix_patterns` row meeting the F24 bar produces a `governance_rules` row with
      `source = 'AUTO_ELEVATED'`, `active = 1`, and a populated `governance_rule_id` back-link.
- [ ] Re-running the sweep does not duplicate the rule.

---

## Learning Iron Laws

FORGE uses an ambient, informally-numbered "Iron Law N" convention across `src/` (e.g. Iron Law 1 =
governance docs read-only; Iron Law 3 = never fabricate an outcome; Iron Law 4 = full-file-replacement
edits; Iron Law 8 = no mocks/placeholder data). There is no canonical numbered list file, so to avoid
colliding with a global number not seen here, System 2's learning-specific laws are numbered
independently as **L1, L2, L3…**. These are binding on all four System 2 agents.

- **L1 — No retroactive threshold-lowering.** EvolutionPromoter never promotes a proposal it did not
  itself see cross the numeric threshold in force at decision time. The threshold is read from
  `forge_meta` at the start of each sweep and recorded in `evolution_promotions.confidence_threshold_applied`;
  a later lowering of the threshold never justifies an already-made decision, and never
  retroactively promotes a row that was below the bar when last evaluated.

- **L2 — GATE evolutions are never auto-promoted.** No `pending_evolutions` row with
  `evolution_type = 'GATE'` is ever auto-promoted, regardless of confidence, because Contract 2's four
  build-halting gates are structural and unbypassable. GATE proposals always await a human.

- **L3 — Every autonomous action is logged before it takes effect.** No promotion activates a change
  before its `evolution_promotions` row is written; no retirement removes or hides a row before its
  `pattern_retirement_log` row is written. The audit record precedes the effect, never trails it
  (satisfies M7, 100% auditability).

- **L4 — Nonzero success is sacred.** No pattern with any recorded success (`success_rate > 0.0`,
  `times_fix_succeeded >= 1`, `times_prevented_error >= 1`, or `effectiveness_rate > 0.0`) is ever
  retired under a zero-success reason. Retirement of a formerly-successful row is only ever
  `SUPERSEDED` / `CONTRADICTS_NEWER_PATTERN` / `MANUAL`, never `ZERO_SUCCESS_RATE`.

- **L5 — No component self-modifies without the promotion trail.** BuildBrainEvolver (and any future
  self-tuning component) proposes via `pending_evolutions` and lets EvolutionPromoter decide. Editing
  `src/engine/prompt-rewriter.ts` or any strategy store directly, outside the `evolution_promotions`
  trail, is prohibited (extends Canonical Rule 3's "never auto-deploy without approval" to
  self-tuning).

- **L6 — Confidence is read, never written, by the promoter.** EvolutionPromoter treats
  `pending_evolutions.confidence` as read-only input. It never edits a proposal's confidence to make
  it promotable (that would be fabricating the basis for its own decision — a violation of the spirit
  of Iron Law 3). Confidence is set only by the proposing agent (Template Evolver, Agent Creator,
  BuildBrainEvolver) from real evidence.

- **L7 — Fingerprint mismatch is a hard stop, never a soft preference.** CrossProjectKnowledgeTransfer
  treats a `language`/`framework` mismatch as a refusal, not a down-weighting. There is no "transfer
  anyway with lower confidence" path across incompatible stacks.

- **L8 — Rollback is not optional.** An AUTO promotion that regresses past its numeric threshold
  within the monitoring window is rolled back automatically. A promotion is never left live "pending
  a human's decision to revert" once the regression condition is objectively met.

---

## Open Questions

These are recorded here rather than resolved by silently inventing schema, per SCHEMA_ADDITIONS.md's
"if a blueprint needs a field this document doesn't have, this document is wrong and must be revised
first."

- **OQ1 — Scheduling a standalone promotion sweep as a `scheduled_tasks` row.** The
  `scheduled_tasks.task_type` CHECK enum
  (`'research_agent','memory_cleanup','log_rotation','health_check','deadline_scan','quota_reset'`)
  has no value for a learning-promotion sweep. System 2 therefore runs EvolutionPromoter **in-process
  after Phase 5** (not as a scheduled_tasks row) and runs PatternRetirer under the existing
  `'memory_cleanup'` type (a natural fit). If a future release wants an independent cron-scheduled
  promotion sweep as a first-class `scheduled_tasks` row, a `'learning_sweep'` enum value would need
  to be added to `scheduled_tasks.task_type` — a change to an existing table that SCHEMA_ADDITIONS.md
  explicitly does not authorize. Deferred to a schema revision, not invented here.
- **OQ2 — `evidence_build_count` source of truth.** `evolution_promotions.evidence_build_count`
  exists, but `pending_evolutions` has no dedicated numeric build-count column — the count is parsed
  from the free-text `evidence` field written by Template Evolver / Agent Creator. If that parse is
  unreliable in practice, a structured build-count field on `pending_evolutions` would be the correct
  fix, again via a schema revision rather than an inline invention.
