# Systems 5-9 Gap Matrix

Classifies every requirement in the five FORGE 2.0→3.0 spec documents (`upgrades/CAPABILITIES_MEMO.md`, `upgrades/QA_TESTING_FRAMEWORK.md`, `upgrades/DESIGN_INTELLIGENCE.md`, `upgrades/GOVERNANCE_FRAMEWORK.md`, `upgrades/ENGINEERING_COMPLETENESS.md`) as **EXISTS / PARTIAL / MISSING** against the actual source tree, with file:line evidence for every non-MISSING claim.

**Process note:** `upgrades/RETROFIT-MASTER-INSTRUCTION.md` does not exist. Per the fallback rule, this run classifies requirements only — it writes no implementation code and generates no build queue. Systems 1-4 (`src/resurrection`, `src/learning`, `src/testing/orchestrator.ts` + `src/testing/runners/*-runner.ts`, `src/integration/bus.ts`) were treated as out of scope and not modified or re-audited beyond where they surface as evidence for Systems 5-9 requirements.

**Method:** six parallel research passes (governance-file mapping, consensus/tool-invocation audit, QA-framework 50-item audit, Design Intelligence 26-component audit, Engineering Completeness 30-item audit, Capabilities Memo 8-system audit), each grepping `src/` broadly under multiple naming variants before declaring MISSING, then reading the hit files in full to confirm scope. Findings below are those agents' verified evidence, cross-checked against the spec text already read in full.

---

## 1. Governance Framework (`GOVERNANCE_FRAMEWORK.md`)

### 1.1 Required root governance files — resolved by content equivalence, not name matching

| Required file | Purpose | Status | Evidence |
|---|---|---|---|
| **FORGE.md** | Supreme operating contract: mission, autonomy boundaries, completion criteria, authoritative docs | **PARTIAL** | Split across `BLUEPRINT.md:1-11` (identity/purpose/stack) + `BLUEPRINT.md:143-153` (10 non-negotiable rules) + `PRD.md:3-78` (overview/requirements/success criteria). No single file combines all four elements. `governance/FORGE_CANONICAL_INSTRUCTIONS.md:1-40` is the best single-document match in purpose ("the authoritative instruction manual for Claude") but lives in `governance/`, not root. |
| **RULES.md** | Hard engineering rules agents cannot override | **EXISTS** | `BEHAVIORAL_CONTRACTS.md:1-738` — 20 numbered contracts plus 12 lettered series (R-, SP-, ORC-, RET-, SKL-, AUT-, TOK-, UI-, AG-, ESKU-, DP-), each a MUST/MUST NOT with no override path, e.g. Contract 3 governance immutability (`:19-22`), Contract 14 recovery limits (`:112-117`). Direct match. |
| **TOOLS.md** | Approved tools/MCP servers/APIs/CLIs and permissions, standing policy | **PARTIAL** | `TOOLCHAIN.md:1-75` lists tool versions and a Skill Manifest but is explicitly "regenerated on every Phase 0 run" (`TOOLCHAIN.md:3`) — a per-build detected snapshot, not a curated standing approval policy. |
| **MODEL-ROUTING.md** | Which LLM handles which task type | **MISSING** | No root doc maps task type → model. `ARCHITECTURE.md:5` records one generation-run metadata line, not a routing policy. Code references to "model routing" (`src/engine/governance-router.ts`) route governance-doc *sections* into prompts by relevance, not LLM selection. |
| **CONTEXT.md** | Stable project context every agent should know | **PARTIAL** | `BLUEPRINT.md:12-141` (architecture overview, components, structure tree, tech decisions, env vars) is stable agent-facing context, but it's the same file already covering FORGE.md's role — no dedicated separation. |
| **NOW.md** | Current active state, milestone, blockers, next work | **EXISTS** | `FORGE_HANDOFF.md:1-11` (designed to be pasted as session-opening message), `:439-472` (§3 current halt state), `:474-495` (§4 numbered next actions). Reinforced by `SESSION_STATE.md:1300` (Last Completed Prompt) and `:1313` (Active Blockers). Strongest EXISTS match of the eight. |
| **SOURCE-OF-TRUTH.md** | Which doc is authoritative for which subject, at project root | **MISSING at root** | Real equivalent exists but in the wrong location: `governance/FORGE_CANONICAL_INSTRUCTIONS.md:166-177` §7 "Governance Documents — Source of Truth" maps STATE_OF_THE_BUILD.md/SESSION_STATE.md/BLUEPRINT.md/SCHEMA_REGISTRY.md/AGENTS.md/BEHAVIORAL_CONTRACTS.md/LESSONS_LEARNED.md to subjects — but it's under `governance/`, not root, so the framework's own "at project root" requirement is unmet. |
| **manifest.yaml** | Machine-readable project identity/autonomy/approval-gate config | **MISSING** | No `manifest.yaml` at root (glob-confirmed). Root `.yaml` files are `queue.yaml`/`providers.yaml` (build config, not identity). `src/orchestrator/manifest-resolver.ts` operates on a per-target-project `library-manifest.yaml` under `library/<project>/`, not a FORGE-self-describing manifest. |

**Score: 2 EXISTS / 4 PARTIAL / 2 MISSING (of 8).**

### 1.2 Authority-precedence hierarchy

**MISSING.** Repo-wide grep for "precedence"/"authority"/"hierarchy"/"source of truth"/"model routing" across all `.md` files found no document defining a ranked authority order over doc types (human approval > FORGE.md > governance > security > architecture/ADRs > RULES.md > manifest > workflow > queue YAML > skill > model-specific file > prompt > agent suggestion, per spec). The only "hierarchy" hits are an unrelated RBAC role hierarchy in a *built child project* (`projects/tarritrix/AGENTS.md:76-78,511-566`) and unrelated visual-hierarchy language in `upgrades/DESIGN_INTELLIGENCE.md`. `BEHAVIORAL_CONTRACTS.md` establishes individual contracts as non-bypassable but never a general document-precedence ladder.

### 1.3 Directory structure

**PARTIAL/MISSING.** Required root artifact directories per the spec: `design/`, `testing/`, `memory/`, `skills/`, `workflows/`, `queues/`, `runs/`, `scripts/`. Only `scripts/` and `skills/` exist at root. `design/`, `testing/`, `memory/`, `workflows/`, `queues/`, `runs/` do not exist at root — FORGE has `src/testing/`, `src/memory/`, `src/design-pipeline/` as *source-code modules* nested under `src/`, not the artifact/output directories the framework specifies. No precedence rules for these directories exist anywhere.

### 1.4 The two placeholder files (contents, as requested)

**`FORGE2-COMPLETE-PLACEHOLDER.md`** — 3 lines total:
```
# FORGE 2.0 Build Complete
Date: 2026-06-25
All runs complete. See .forge/FINAL-HANDOFF.md for full verification.
```
A stale, one-shot completion stamp from 2026-06-25, contradicted by every later governance doc (`FORGE_HANDOFF.md`, `SESSION_STATE.md`, `STATE_OF_THE_BUILD.md` all show continued work through 2026-08-13+). **Do not treat as authoritative; safe to archive/delete once confirmed superseded, but out of scope for this run.**

**`FORGE_2_0_Run_Plan (1).md`** — 117 lines, dated 2026-06-23, "FORGE Enhancement — Complete Build Run Plan." An "Enhance, Not Rebuild" plan across 5-6 runs (~78-100 prompts: Learning Engine Foundation → RETROFIT SCAN/DIAGNOSE → Sentinel ring pipeline → Composer/Architect/Deploy → Integration Testing/Hardening). Per current governance docs, this entire scope is now marked COMPLETE and superseded by far more (Systems 1-5, Autonomy, Design Pipeline). **A stale early-June planning artifact — consistent with the known "stale task briefs" failure mode (see memory: `forge2-stale-task-briefs`); must not be re-applied without checking against what's already on disk at a higher version.**

---

## 2. Capabilities Memo (`CAPABILITIES_MEMO.md`) — the 8 systems, minus 1-4 (verified complete, out of scope)

| System | Status | Evidence |
|---|---|---|
| **A. FORGE Control Plane** (unified startup decision layer + bordered startup banner + dynamic PowerShell window title) | **MISSING** | No `control-plane`/`ControlPlane` module (glob confirms). `src/cli/index.ts` `printHeader()` (`:165-167`) writes one line to `.forge/build.log`, not a bordered stdout banner. No `process.title`/window-title code found anywhere. Mode/budget/provider/MCP/escalation/stop-condition decisions are scattered across CLI flags rather than unified. |
| **B. Observability & Run Telemetry** (per-run `.forge/runs/<ts>/{run.json,events.jsonl,prompts.jsonl,tests.jsonl,llm-consensus.jsonl,failures.jsonl,remediation.jsonl,metrics.json,final-report.md}`; orange/purple/green/yellow/red/gray/cyan console scheme; strict ASCII) | **MISSING as specced** | None of the nine named files/paths exist anywhere (grep-confirmed). Logging exists (`src/tools/forge-logger.ts`, pino-based → `.forge/build.log`; SQLite Build Memory in `src/memory/`) but not this per-run JSONL set. Console coloring uses chalk green/red/yellow/dim/cyan (`src/cli/index.ts:289-310`) but no orange-name/purple-"PROMPT X OF Y" scheme, and output uses Unicode symbols (✖/⚠/✔ at `:212,289`) rather than strict ASCII. |
| **C. Three explicit Operating Modes as CLI entry paths** (NEW BUILD / CONTINUE BUILD / RESURRECT) | **PARTIAL** | `forge build <path>` (`index.ts:~3135`) = new-build pipeline. `forge resurrect <path>` (`index.ts:~3318`, autopsy-driven queue `:1311-1417`) = real, explicit RESURRECT entry point into verified-complete `src/resurrection`. No explicit CONTINUE-BUILD mode: `forge analyze` subcommands (dead-code/routes/schema/deps/coverage/ci, `index.ts:3633-3761`) are diagnostic reporting tools, not wired as a build-continuation entry path that examines root/README/git-history/migrations/TODOs and reconstructs a roadmap. |
| **D. Multi-LLM Consensus Engine** | See §5 below (resolves question 2). |
| **E. Autonomous Queue Factory** (architecture→WBS→DAG→queue YAML, with real concurrent execution of independent tasks) | **PARTIAL** | Queue auto-generation from architecture EXISTS: `src/engine/queue-generator.ts` `generateQueue()` (`:31-46`) produces an ordered, `parallel_group`-tagged stage list. DAG dependency analysis EXISTS: `src/engine/parallel-scheduler.ts` `analyzeSchedule()` (`:50-88`) computes topological waves, not a flat list. But **concurrent execution is not implemented** — the module's own comment (`:9-13`) states parallel execution is explicitly deferred ("Phase 2... not Sprint 1... Sequential execution is the default"), and `phase3-executor.ts:920-921` only passes `parallel_group` through without spawning concurrent branches (no `Promise.all`/worktree fan-out found). |
| **F. Explicit tool/validation invocation event emission** | **EXISTS** | `src/phases/phase4-sentinel.ts` emits a timestamped `log('check N: <name>')` line per validation subsystem — e.g. Security Scan (`:3652`), Visual Regression (`:3686`), Accessibility (`:3752`), Consensus Validation (`:3857`), AgentShield (`:3890`), full Playwright suite (`:4068`) — via `src/tools/forge-logger.ts` (pino, timestamped, build/project/prompt context mixed in, `:39-80`). |
| **G. Readiness-Level Engine** (9 formal tiers gating Definition of Done) | **MISSING** | No occurrence of the PROTOTYPE→HYPERSCALE tier vocabulary or a level-driven validation-requirement policy anywhere in `src/`. All "readiness" hits are unrelated dev-server/health-check polling. |
| **H. Recursive Improvement Engine** (EXECUTE→MEASURE→CRITIQUE→…→PROMOTE→VERSION→STORE→REUSE with evidence-gated promotion and rollback) | **EXISTS — already in System 2 (Learning), not newly missing** | `src/learning/evolution-promoter.ts` (`PROMOTION_THRESHOLD=0.9`, `MONITORING_WINDOW_BUILDS=15`, `ROLLBACK_REGRESSION_POINTS`) implements measure→promote→version→monitor→auto-rollback. `src/learning/loops.ts` `analyzeForEvolutions()` (`:233`) / `presentEvolutions()` (`:336`) generate/surface evidence+confidence-scored `pending_evolutions`. `database.ts:205` tracks `change_source`. Matches the spec's evidence-before-promotion + rollback requirement. |
| **I. FORGE-MANIFEST.yaml** (per-project immutable identity/mode/readiness/mission/autonomy file) | **MISSING** | No file or field set (`readiness_target`, `run_window_hours`, `authoritative_docs`, autonomy flags) found anywhere. `src/orchestrator/manifest-resolver.ts`'s `library-manifest.yaml` (`:25-42`) is a queue-library tracking manifest (queues/status/dependsOn), not per-project identity metadata. |

---

## 3. QA Testing, Security & Validation Framework (`QA_TESTING_FRAMEWORK.md`)

**Structural finding first:** the gap here is mostly *wiring*, not *capability*. `src/testing/` (`TestOrchestrator` + `RunnerType`, `src/testing/types.ts:11-19`) wires exactly **7 runner types** (Vitest×3, Playwright, security-scanner, k6, pnpm-audit). But `src/memory/test-results.ts:17-36` defines a 19-value `TestSuiteDb` enum — meaning 12 categories were schema-planned but never got a runner (`persist.ts:27-35` only maps 7 of the 19). Separately, real integrations for several spec'd tools exist entirely **outside** `src/testing/`, inside `phase4-sentinel.ts`'s Ring 1-3 checks and standalone `src/tools/*.ts` — working, but invisible to `TestOrchestrator` and never written to `test_run_results`.

| Category | Status | Evidence |
|---|---|---|
| TypeScript `tsc --noEmit` | PARTIAL (unwired) | `phase4-sentinel.ts:2561-2591` (Ring1a), `src/tools/incremental-tester.ts:11-13` |
| ESLint | PARTIAL (unwired) | `phase4-sentinel.ts:2640-2705` (Ring1b), `:2807-2841` (Lint Gate) |
| Vitest (unit/component/service) | EXISTS | `src/testing/runners/unit-runner.ts:6-11`, `integration-runner.ts:6-12`, `api-runner.ts:6-12`, `vitest-shared.ts:120-195` |
| Playwright (browser/E2E) | EXISTS | `src/testing/runners/e2e-runner.ts:55-111` |
| Schemathesis (API contract) | MISSING | No match in `src/`; `api-runner.ts` only wraps Vitest+fetch, no schema-driven tests |
| axe-core (accessibility) | PARTIAL (unwired) | `src/tools/accessibility-auditor.ts:1-90`, `src/ui-engine/accessibility-checker.ts`, `phase4-sentinel.ts:1445,3144` |
| k6 (load) | EXISTS | `src/testing/runners/performance-runner.ts:1-99` |
| k6 stress/spike/soak/breakpoint/perf-regression | MISSING | `performance-runner.ts` runs one generic `k6/performance.js` (`:54,63`); no scenario differentiation; `TestSuiteDb` LOAD/STRESS/SOAK never written |
| Semgrep CE (SAST) | PARTIAL/MISSING | `security-runner.ts:9-51` calls `src/tools/security-scanner.ts` — a hand-rolled regex scanner (categories at `:21-29`), **not Semgrep**; no "semgrep" match anywhere in repo |
| OWASP ZAP (DAST) | MISSING | No match anywhere |
| Trivy (deps/containers/IaC) | PARTIAL (unwired, deps-only) | `phase4-sentinel.ts:2109-2202` (Ring3a, `trivy fs --severity CRITICAL,HIGH`); `src/testing/dependency-runner.ts` only runs `pnpm audit` (`:44-46`), no container/IaC scan |
| Checkov / Terrascan | MISSING | No match |
| SBOM generation | MISSING | No match |
| License auditing | MISSING | No match |
| Gitleaks (secrets) | PARTIAL (unwired) | `phase4-sentinel.ts:2219-2295` (Ring3b), `src/learning/hooks-enhanced.ts:262-264` |
| pytest / pytest-cov | MISSING | No Python test invocation anywhere |
| Hypothesis (Python property-based) | MISSING | No genuine match |
| fast-check (JS/TS property-based) | MISSING | No match; not in `package.json` |
| Stryker Mutator | MISSING | No match; not in `package.json` |
| Lighthouse | PARTIAL (unwired) | `phase4-sentinel.ts:2352-2498` (Ring3c, threshold 90 across 4 categories) |
| Smoke testing | PARTIAL (unwired) | `src/tools/incremental-tester.ts` `runSmokeTests` (`:11-13`: tsc + build + 3 page-load probes) |
| Sanity testing | MISSING | No match |
| Auto-generated regression tests from fixed bugs | MISSING | `incremental-tester.ts` only maps changed files → existing tests by naming convention; nothing generates new tests from bug fixes |
| Database migration testing | PARTIAL (unwired) | `src/tools/migration-safety.ts`, mapped `phase4-sentinel.ts:1682` |
| Database integrity testing | MISSING | No dedicated integrity checker beyond migration-safety.ts |
| Visual regression testing | PARTIAL (unwired) | `src/tools/visual-regression.ts:1-39` (full Playwright+pixel-diff), mapped `phase4-sentinel.ts:1374`; `TestSuiteDb.VISUAL_REGRESSION` never written |
| Responsive testing (multi-viewport) | PARTIAL | Viewport logic exists in `src/design-pipeline/screenshotter.ts` and others (13 files), but no distinct responsive gate in `src/testing/` |
| Cross-browser testing (Chromium/Firefox/WebKit) | MISSING | `e2e-runner.ts:62` runs a single browser project, no matrix; `TestSuiteDb` CROSS_BROWSER/CROSS_DEVICE unused |
| SEO technical audits | PARTIAL (unwired) | `src/tools/seo-validator.ts:16-18`, mapped `phase4-sentinel.ts:1501` |
| Broken-link testing | PARTIAL (unwired) | `seo-validator.ts:454,777,858-959` |
| Structured-data (JSON-LD) testing | PARTIAL (unwired) | `seo-validator.ts:16,76` |
| API health checking | MISSING | No dedicated health-check runner |
| Chaos testing | MISSING | `TestSuiteDb.CHAOS` defined, never implemented |
| Recovery testing | MISSING | `TestSuiteDb.DISASTER_RECOVERY` defined, never implemented |
| Backup restoration testing | MISSING | `TestSuiteDb.BACKUP_RESTORE` defined, never implemented |
| Idempotency testing | MISSING | No match |
| Concurrency/race-condition testing | MISSING | No match |
| Memory/resource leak testing | MISSING | No match |
| Flaky-test detection | MISSING | No match |
| Test-order-dependency detection | MISSING | No match |
| Progressive-gate system (PROMPT/FEATURE/QUEUE/MILESTONE/PRE-DEPLOY/ENTERPRISE tiers) | PARTIAL | `src/testing/types.ts:3-9` `TriggerType` has only 5 values (POST_PROMPT/PRE_DEPLOY/POST_DEPLOY/SCHEDULED/MANUAL); no auto-escalating tool-set-per-tier logic anywhere |

`package.json` cross-check: `dependencies` (`:25-44`) list only `axe-core` and `playwright` among named spec tools; no `vitest`/`eslint`/`semgrep`/`k6`/`stryker`/`fast-check`/`gitleaks`/`lighthouse`/`trivy` package — every one of those is shelled out to as an external binary (`src/testing/runners/exec.ts`'s `defaultShellRunner`, or `phase4-sentinel.ts`'s `run`), so dependency-listing alone is not diagnostic for this stack.

---

## 4. Design Intelligence (`DESIGN_INTELLIGENCE.md`) — resolves question 4

**Confirmed: Design Intelligence components are NOT all absent** — a real, working pipeline exists at `src/design-pipeline/` (untracked, 5 files: `index.ts`, `penpot-integration.ts`, `review-gate.ts`, `screenshotter.ts`, `storage-config.ts`), wired live into `src/phases/phase3-executor.ts:170,1466,2600-2630` (runs after Sentinel passes for `.tsx`-touching prompts; rejection triggers one feedback-guided retry, not a hard deploy block).

| # | Component | Status | Evidence |
|---|---|---|---|
| 01 | App Profiler | MISSING | No `app-profiler`/`AppProfiler` anywhere |
| 02 | Interface Classifier | MISSING | No match |
| 03 | Brand Intelligence Engine | MISSING | No match |
| 04 | User/Persona Profiler | MISSING | No match |
| 05 | Design Capability Registry | MISSING | No match |
| 06 | Design Tool Router (weighted scoring formula) | MISSING | No router, no taste-skill/Impeccable/Awesome-Design/img2threejs references anywhere |
| 07 | Aesthetic Reference Engine | MISSING | No match |
| 08 | Design Strategy Generator | PARTIAL | `src/tools/design-system-generator.ts:1-79` generates one fixed pre-build `DESIGN_SYSTEM.md` via the UI/UX Pro Max skill — not a per-interface strategy feeding variance/tournament |
| 09 | Design Variance Controller | MISSING | No variant-diffing/minimum-variance logic |
| 10 | Design Tournament Engine | MISSING | No multi-variant competing-implementation scoring |
| 11 | Component Generator | EXISTS (single-variant only) | `src/ui-engine/component-generator.ts:275-370` generates exactly one implementation per spec, no tournament awareness |
| 12 | img2threejs Geometry Engine | MISSING | Zero references anywhere |
| 13 | Browser Render Engine | EXISTS (narrow) | `screenshotter.ts:462-517` launches headless Chromium, exists only as a screenshot means |
| 14 | Playwright Screenshot Engine | EXISTS | `screenshotter.ts:444-519` |
| 15 | Responsive Screenshot Engine | EXISTS | `screenshotter.ts:113` (`DEFAULT_VIEWPORTS` desktop/laptop/tablet/mobile), loop `:479-513` — the one component fully built as specced |
| 16 | Impeccable Audit Engine | MISSING | No "Impeccable" integration anywhere |
| 17 | Accessibility Audit | EXISTS | `src/tools/accessibility-auditor.ts:1-46+` (full axe-core WCAG 2.1 AA, build-blocking); `screenshotter.ts:322-332` also folds in a lighter static score |
| 18 | Visual Regression Engine | EXISTS | `src/tools/visual-regression.ts:1-130+` (Playwright + pixel-diff vs `.forge/baselines/`, wired `phase4-sentinel.ts:3688-3703`) — fully separate from `screenshotter.ts` |
| 19 | Design Scoring Engine (9-dim, 100-pt rubric) | MISSING | `review-gate.ts:114-119,268-315` only compares one accessibility score to a single threshold (default 70, `:95`); no weighted rubric |
| 20 | Human Visual Approval Gate | PARTIAL/EXISTS | `review-gate.ts:223-262,322-381` — real interactive Approve/Reject/Skip gate, persists to `design_reviews` (`database.ts:695-708`); gates one prompt's merge, not deployment, and doesn't match the spec's `design_governance.deployment_gate` schema |
| 21 | Composite Design Builder | MISSING | No mix-and-match logic (consistent with #09/#10 also missing) |
| 22 | Design Memory (cross-project prefers/rejects) | MISSING | No match |
| 23 | Approval History | PARTIAL | `design_reviews` table persists every review (`database.ts:695-708`) but no querying/reporting surface built on it |
| 24 | Design-System Extractor | MISSING | `design-system-generator.ts` generates from a skill search, doesn't extract from existing design/code |
| 25 | Component/Token Consolidator | MISSING | `src/ui-engine/design-token-manager.ts:44-50+` writes one fixed token set once, no consolidation |
| 26 | Deployment Design Gate | MISSING | Zero design-related references in `src/autonomy/vercel-deployer.ts` (grep-confirmed); the review gate (#20) never reaches the deploy step |

**Summary:** 16 of 26 components (01-07, 09-10, 12, 16, 21-22, 24-26) are entirely absent from the codebase. The 5 that exist or partially exist (screenshot capture, responsive viewports, accessibility audit, visual regression, human approval gate) form a working "capture → audit → approve-or-retry" loop with **no intelligence layer**: no profiling, no routing, no tournament, no scoring, no memory.

---

## 5. Engineering Completeness (`ENGINEERING_COMPLETENESS.md`) — resolves question 5

**Confirmed: not a blanket absence.** Of the 30 priority items checked, roughly 13 are genuinely MISSING with zero evidence, 4 are EXISTS/near-EXISTS, and 13 are PARTIAL — real, narrower, differently-named mechanisms exist that a grep-only pass against the spec's exact vocabulary would miss. `src/learning/` (confidence scoring, evolution promotion, rollback-on-regression) and `src/resurrection/` + `src/retrofit/diagnose.ts` (governance-artifact drift auditing) are the strongest counter-evidence sources.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Project ontology (REQ-042→FEATURE-017 IDs) | MISSING | No `ontology`/`entity model`/`REQ-\d`/`FEATURE-\d` matches |
| 2 | Requirements traceability engine | MISSING | No matches beyond an unrelated log-echo use of "traceability" (`failure-predictor.ts:29`) |
| 3 | Invariant engine (machine-enforced cross-tenant/deploy rules) | MISSING | "invariant" appears only as doc-comment prose in `architecture-guard.ts`/`prompt-rewriter.ts`, not a rule engine |
| 4 | Formal state machine (CONCEPT→…→OPTIMIZATION; task states) | MISSING | No named-vocabulary match; only `pending_evolutions.status` enum (`learning/types.ts:69`) is a distant relative |
| 5 | Dependency graph intelligence | PARTIAL | `src/engine/parallel-scheduler.ts` `analyzeSchedule()` — real wave-based topological analysis + cycle detection; no invalidation-cascade logic |
| 6 | Change-impact / blast-radius analysis | MISSING | No match; `dead-code-scanner.ts` finds unused exports but not forward change impact |
| 7 | Architecture drift detection | PARTIAL | `src/retrofit/diagnose.ts:57` `buildGovernanceReconciliationReport` compares STATE_OF_THE_BUILD.md/AGENTS.md claims against actual route inventory — narrow, regex-based |
| 8 | Documentation drift detection | PARTIAL | Same evidence as #7 |
| 9 | Decision provenance / ADR system | MISSING | No `ADR`/alternatives-rejected match; `sentinel-prime/decision-validator.ts` grades post-hoc intent-fulfillment, not a forward decision log |
| 10 | Confidence scoring on AI decisions | **EXISTS** | `src/sentinel-prime/confidence-scorer.ts` `scoreConfidence()` — weighted composite (execution 0.35/validation 0.40/governance 0.25), `HALT_COMPOSITE_THRESHOLD=0.4`; also `learning/database.ts:794` `prompt_scores`, `:839` `decision_weights` |
| 11 | Uncertainty management | PARTIAL | `decision-validator.ts` `fallbackResult` (`:310`) degrades to an explicit `{score:0.5, confidence:0}` uncertain state, but only in this one subsystem |
| 12 | Assumption registry (ASM-###) | MISSING | No match |
| 13 | Risk register (RISK-###) | MISSING | No match |
| 14 | Technical debt ledger (DEBT-###) | MISSING | No match; not among the 44 tables in `learning/database.ts` |
| 15 | Architectural fitness functions | PARTIAL | `src/tools/architecture-guard.ts` — real circular-dependency DFS, god-component thresholds, N+1 detection; HIGH severity **blocks the build**. No coupling/latency-threshold metrics |
| 16 | Contract-first development | MISSING | No OpenAPI/AsyncAPI/JSON-Schema-before-code match |
| 17 | Formal agent contracts | MISSING | No `toolsAllowed`/`toolsProhibited`/structured-contract match; `agent-creator.ts` generates prompts, not contracts |
| 18 | Agent identity / least-privilege permissions | MISSING | No match; `agent-shield.ts` is a generic guard, not per-agent identity |
| 19 | Sandboxed execution | PARTIAL | `src/engine/git-manager.ts` provides branch-level isolation + `rollbackToCheckpoint` (git-level sandbox); no db/container-level sandbox |
| 20 | Ephemeral preview environments | MISSING | No match |
| 21 | Automatic rollback tracking | **EXISTS** | `git-manager.ts:98,382` `rollbackToCheckpoint()`; `evolution-promoter.ts:16-17,30-31` auto-rolls back learning changes on >15-point regression |
| 22 | Canary deployment (traffic ramping) | PARTIAL | `src/cli/config.ts:255,264` has `canaryEnabled`/`rollbackOnFailure` flags and an adversarial-review prompt template (`adversarial-review.ts:44`), but no 5%→25%→50%→100% ramping implementation |
| 23 | Feature flags system | MISSING (in FORGE itself) | Only hits are skill *templates* (`skills/templates/feature-flags.skill.md`) handed to built projects, not a system inside FORGE |
| 24 | Cost/budget intelligence engine | MISSING as described | `free-tier-manager.ts` returns zero budget-term matches; `analysis/cost-estimator.ts` exists but not confirmed as cross-provider per-run budget enforcement |
| 25 | Benchmark suite for FORGE itself | MISSING | No match |
| 26 | Shadow-mode self-improvement evaluation | PARTIAL | `evolution-promoter.ts` does post-hoc A/B comparison over a 15-build window — not true shadow-mode (unpromoted-parallel-to-production) |
| 27 | Promotion pipeline (EXPERIMENTAL→…→ACTIVE) | PARTIAL | `learning/types.ts:69` real promotion pipeline exists (`PENDING/APPROVED/REJECTED/SUPERSEDED`, evolution types, 0.9 confidence bar) but with coarser/different stage names than the spec |
| 28 | Failure taxonomy classification | MISSING | No classification match; `death-forensics.ts` captures raw crash data but doesn't categorize; `error_patterns` table lacks a full taxonomy (gap noted in-code at `failure-predictor.ts:29-31`) |
| 29 | Dead-loop / stagnation detection | MISSING | No match |
| 30 | Formal machine-verifiable Definition of Done | MISSING | No `definition.?of.?done`/DoD match; Sentinel gates act as an implicit but unexposed completion gate |

---

## Resolution of the five specific questions

**(1) Do the root governance files satisfy GOVERNANCE_FRAMEWORK.md's file list?** No — partially. 2 of 8 required files (RULES.md → `BEHAVIORAL_CONTRACTS.md`; NOW.md → `FORGE_HANDOFF.md`) are satisfied by content equivalence. 4 are PARTIAL (content exists but split/misplaced/wrong-freshness: FORGE.md, TOOLS.md, CONTEXT.md, and SOURCE-OF-TRUTH.md — the last of which exists in full but under `governance/`, not root). 2 are fully MISSING: MODEL-ROUTING.md and manifest.yaml. The authority-precedence hierarchy and the root-level artifact directory structure (`design/`, `testing/`, `memory/`, `workflows/`, `queues/`, `runs/`) are also MISSING. See §1.1-1.3.

**(2) Does `consensus-validator.ts` implement the multi-LLM consensus pipeline, or only post-hoc validation?** **Post-hoc validation of a single artifact, not multi-proposal consensus.** `src/tools/consensus-validator.ts` genuinely calls 2-3 providers in parallel (`runConsensusValidation()`, `:914`, `Promise.all` at `:939`), does real contradiction/agreement clustering (`clusterIssues()`, `:654`) and synthesis (`computeVerdict()`, `:727`; `computeClaimConsensus()`, `:735-763`, capturing dissent) — this machinery is real, not mocked. But per the file's own header (`:5-10`), it sends **one already-generated output** from a single primary provider to validators; there is no independent-parallel-proposal-generation step (each LLM producing its own draft), and validators explicitly never see each other's judgments (`:9`, no critique round). Perplexity is absent from the 4-provider list (`:157-162`, only anthropic/openai/gemini/deepseek). **Classification: PARTIAL** — the critique/contradiction/synthesis machinery exists and is real, but it validates rather than generates-and-reconciles independent proposals as CAPABILITIES_MEMO.md specifies.

**(3) Do `performance-runner.ts` / `dependency-runner.ts` invoke real tools or hand-rolled substitutes?** Mixed. `performance-runner.ts` **EXISTS as real k6 integration** — it preflight-checks `k6 version` (`:30`) and executes `k6 run --summary-export=... k6/performance.js` (`:63`) via `defaultShellRunner`, parsing real JSON output; it SKIPs rather than fakes a pass if k6/script are absent (`:56-61`). `dependency-runner.ts` is **PARTIAL** — it does shell out to a real tool, `pnpm audit --json` (`:44-46`), but that is not Trivy, OSV-Scanner, or `npm audit` as specced; no Trivy/OSV-Scanner reference exists in the file. For comparison, `security-runner.ts` is confirmed **hand-rolled** (per the user's prior belief): it delegates to `src/tools/security-scanner.ts`, which does only regex/`RegExp.exec()` pattern matching (lines 274, 289, 376, 419, 548) with no Semgrep/Gitleaks/ZAP subprocess call.

**(4) Confirm zero existence of Design Intelligence components in `src/`?** **False — not zero.** A real, wired pipeline exists at `src/design-pipeline/` (5 EXISTS/PARTIAL components: screenshot capture, responsive viewports, accessibility audit, visual regression, human approval gate), but it has no intelligence layer. 16 of 26 spec'd components (profiling, routing, scoring, tournament, variance control, memory, composite building, deployment gating) are genuinely absent. See §4 for the full per-component table.

**(5) Confirm zero existence of Engineering Completeness components in `src/`?** **False — not zero.** 13 of 30 audited items are genuinely MISSING with no evidence (ontology, traceability, invariant engine, formal state machine, blast-radius analysis, ADR/decision-provenance, assumption registry, risk register, tech-debt ledger, contract-first dev, formal agent contracts, agent-identity permissions, ephemeral previews, benchmark suite, dead-loop detection, formal DoD — more than 30 counted since several spec items collapse together). 4 are EXISTS or near-EXISTS (confidence scoring, git-level automatic rollback). 13 are PARTIAL — real underlying mechanisms exist under different names/narrower scope (dependency-wave scheduling, governance-reconciliation drift detection, architecture-guard fitness functions, git-branch sandboxing, canary config flags, evolution-promotion pipeline with rollback, uncertainty fallback in one subsystem). See §5 for the full table.

---

## Dependency-ordered build sequence for MISSING items

Per the retrofit-process fallback rule, governance comes first. This is a sequencing recommendation only — **no implementation code or queue YAML was generated this run.**

1. **Governance foundation** (blocks everything else — agents can't reliably reason about "what's authoritative" without it)
   - Write root `SOURCE-OF-TRUTH.md` (promote/adapt `governance/FORGE_CANONICAL_INSTRUCTIONS.md` §7 to root)
   - Write root `manifest.yaml` (machine-readable identity/autonomy/approval-gate config)
   - Write `MODEL-ROUTING.md`
   - Consolidate the FORGE.md/CONTEXT.md/TOOLS.md split (`BLUEPRINT.md` + `PRD.md` + `TOOLCHAIN.md`) into dedicated files or formally declare the existing split as the intended structure and document the mapping in SOURCE-OF-TRUTH.md
   - Publish the authority-precedence hierarchy as an explicit document

2. **Definition of Done + Readiness-Level Engine** (everything downstream needs to know what tier it's building to and what "complete" means)
   - Formal machine-verifiable DoD (item E-30 / Capabilities G)
   - 9-tier Readiness-Level policy gating validation requirements

3. **Testing framework wiring** (highest ROI — most of the raw capability already exists, it's disconnected)
   - Wire the already-working `phase4-sentinel.ts` Ring 1-3 tools (Trivy, Gitleaks, Lighthouse, axe-core, SEO/broken-link, visual-regression, migration-safety) into `TestOrchestrator`/`RunnerType`/`test_run_results` so the 19-value `TestSuiteDb` enum stops being 63% dead schema
   - Add genuinely-missing tools: Semgrep (replacing/augmenting the regex `security-scanner.ts`), OWASP ZAP, Schemathesis, pytest/Hypothesis, fast-check, Stryker Mutator
   - Build the progressive-gate tier system (PROMPT/FEATURE/QUEUE/MILESTONE/PRE-DEPLOY/ENTERPRISE) on top of the now-complete tool set
   - Add the behavioral test categories with zero tooling dependency (idempotency, concurrency/race, flaky-test detection, test-order-dependency, chaos, recovery, backup-restore)

4. **Engineering Completeness primitives** (needed before Control Plane/Queue Factory can reason safely about scope and risk)
   - Project ontology + requirements traceability engine
   - Invariant engine
   - Change-impact/blast-radius analysis
   - Risk register + assumption registry + technical debt ledger
   - Failure taxonomy + dead-loop/stagnation detection

5. **Control Plane + Observability** (the operational shell around everything above)
   - Unified FORGE Control Plane module (currently decisions are scattered across CLI flags)
   - `.forge/runs/<ts>/*.jsonl` structured telemetry + startup banner + color scheme
   - CONTINUE-BUILD mode as an explicit first-class entry path (NEW BUILD and RESURRECT already exist)

6. **Consensus Engine upgrade** (from post-hoc validation to true independent-proposal generation)
   - Add an independent-parallel-proposal-generation stage ahead of the existing validator/critique/synthesis machinery in `consensus-validator.ts`
   - Add Perplexity/research provider to the panel

7. **Autonomous Queue Factory — concurrency** (the DAG analysis already exists; only execution is missing)
   - Implement the deferred concurrent-execution phase in `parallel-scheduler.ts`/`phase3-executor.ts`

8. **Design Intelligence layer** (the capture/audit/approve mechanics already exist; build the intelligence on top)
   - App/Interface/Persona profiling → Design Tool Router with the weighted scoring formula
   - Design Variance Controller + Design Tournament Engine (multi-variant generation)
   - Design Scoring Engine (9-dimension rubric) on top of the existing single-threshold `review-gate.ts`
   - Design Memory (cross-project prefers/rejects) + Composite Design Builder
   - Deployment Design Gate wired into `vercel-deployer.ts` (currently the review gate stops at merge, not deploy)

9. **Recursive self-improvement promotion-pipeline rename/extension** (lowest priority — the mechanism already works in `src/learning/`)
   - Extend `evolution-promoter.ts`'s stage names/shadow-mode fidelity to match the spec's EXPERIMENTAL→CANDIDATE→BENCHMARKED→CANARY→APPROVED→ACTIVE ladder if stricter staging is desired; not urgent since evidence-gated promotion + rollback already function.
