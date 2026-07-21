# FORGE 2.0 — Agents Registry

**Last Updated:** 2026-07-21
**Maintained by:** FORGE build system (auto-updated each run)

---

## Agent: ForgeRetrofit (src/retrofit/)

- **Purpose:** RETROFIT pipeline — scan an existing codebase, produce structured diagnostics, reconcile governance gaps, and generate a tier-ordered continuation queue. Primary mode for resurrecting abandoned builds.
- **Status:** COMPLETE (Run 2 — all 13 prompts PASSED)
- **CLI:** `forge retrofit <project-path> [options]` — wired in `src/cli/index.ts` line 1246
- **CLI Options:** `--scope A|B|C` (default C), `--skip-dynamic`, `--resume`, `--non-interactive`, `--queue-output <path>`, `--api-key <key>`
- **Entry Point:** `src/retrofit/index.ts` → re-exports `runRetrofitPipeline` from `reconcile.ts`
- **Dependencies:** ForgeLearning (SQLite via sqlite3 CLI for reconcile_decisions persistence)
- **Database tables:** `reconcile_decisions` (write — via sqlite3 CLI in reconcile.ts), `governance_rules` (read)

### Files

| File | Purpose |
|------|---------|
| `src/retrofit/types.ts` | All ScanReport, DiagnoseReport, ReconcileDecision, QueueEntry type definitions |
| `src/retrofit/preflight.ts` | 8 pre-flight checks before SCAN begins |
| `src/retrofit/scan-ops-1-4.ts` | SCAN ops 1–4: directory tree, dependency graph, broken imports, dead files |
| `src/retrofit/scan-ops-5-8.ts` | SCAN ops 5–8: route inventory, env audit, schema extraction, git history |
| `src/retrofit/scan-ops-9-14.ts` | SCAN ops 9–14: package audit, governance inventory, TSC check, tests, dynamic routes, Vercel |
| `src/retrofit/scan.ts` | SCAN orchestrator — wires all 14 ops, writes `.forge/scan_report.json` |
| `src/retrofit/diagnose.ts` | DIAGNOSE — 3 reports: Architecture Health, Governance Reconciliation, Enterprise Patterns Gap |
| `src/retrofit/reconcile.ts` | RECONCILE (Model C hybrid) + QUEUE generator + `runRetrofitPipeline` orchestrator |
| `src/retrofit/pipeline.ts` | Thin shim re-exporting `runRetrofitPipeline` for backwards compat |
| `src/retrofit/index.ts` | Public API — re-exports `runRetrofitPipeline`, `runReconcile`, `generateRetrofitQueue` |

### SCAN Operations (14 total)

| # | Operation | Output |
|---|-----------|--------|
| 1 | Directory tree enumeration | File list, size totals, directory structure |
| 2 | Dependency graph mapping | Import graph, circular dependency detection |
| 3 | Broken import detection | Missing modules, wrong extensions, unresolved paths |
| 4 | Dead file detection | Files with no importers outside entry points |
| 5 | Route inventory | Next.js/Express route catalog with methods |
| 6 | Environment variable audit | Required vs present vs documented |
| 7 | Database schema extraction | Tables, columns, RLS policies from Supabase |
| 8 | Git history analysis | Recent commits, authors, churn hotspots |
| 9 | Package audit | Outdated, deprecated, security-flagged deps |
| 10 | Governance document inventory | BLUEPRINT, SCHEMA_REGISTRY, BEHAVIORAL_CONTRACTS presence |
| 11 | TypeScript compilation check | `tsc --noEmit` error count and categories |
| 12 | Existing test execution | Playwright/Jest pass rate |
| 13 | Dynamic route testing | GET-only health probes against live dev server |
| 14 | Vercel deployment analysis | Production deployment health, edge function status |

### DIAGNOSE Reports (3 total)

| # | Report | Contents |
|---|--------|---------|
| 1 | Architecture Health Report | Structural soundness + Claude API adversarial review |
| 2 | Governance Reconciliation Report | Six Laws gaps, missing contracts, enforcement status |
| 3 | Enterprise Patterns Gap Report | Security, observability, scalability, performance gaps |

### RECONCILE Model C (Hybrid Interactive)

- Presents CRITICAL issues for human review with auto-approve override
- Auto-applies WARN-level fixes (configurable via `--non-interactive`)
- Persists all decisions to SQLite `reconcile_decisions` table before executing
- ABANDONED features removed from governance content (not by deleting files)

### QUEUE Tier Ordering

Generated `queue.yaml` is ordered by dependency tier:
1. **T0 — Foundation:** Schema migrations, env setup, auth
2. **T1 — Core:** Primary CRUD, API routes
3. **T2 — Integration:** Third-party services, webhooks
4. **T3 — UI:** Frontend components, forms
5. **T4 — Verification:** Playwright tests, E2E flows

---

## Agent: ForgeLearning (src/learning/)

- **Purpose:** SQLite learning database — 14 tables, 15 query functions, 5 learning loops, 24 default hooks.
- **Status:** COMPLETE (Run 1)
- **Files:** `types.ts`, `database.ts`, `queries.ts`, `loops.ts`, `hooks-enhanced.ts`, `sync.ts`, `session.ts`, `integration.ts`, `fingerprint.ts`, `precompact.ts`

---

## Agent: ForgeSentinel (src/phases/phase4-sentinel.ts)

- **Purpose:** 18-tool quality pipeline across 3 rings (Ring 1 every-prompt, Ring 2 every-10th, Ring 3 end-of-run).
- **Status:** COMPLETE (Run 3)
- **CLI:** `forge sentinel <project-path> [--ring 1|2|3|all] [--prompt-number <n>] [--final]`

---

## Agent: ForgeComposer (src/engine/)

- **Purpose:** DAG-based prompt queue generator with topological sort and token forecasting.
- **Status:** COMPLETE (Run 3)
- **CLI:** integrated into `forge build` pipeline

---

## Agent: ForgeArchitect (src/phases/phase0-scout.ts, phase1a-prd.ts, phase1b-architect.ts)

- **Purpose:** SCOUT + PRD generation + four-pass refinement + governance suite generation.
- **Status:** COMPLETE (Run 3)
- **CLI:** `forge scout <path>`, `forge build <path>`, `forge design <path>`

---

## Agent: ForgeComposerEngine (src/composer/index.ts)

- **Purpose:** Main Composer orchestrator. Reads governance docs, detects schema/contract gaps, extracts DAGNodes from task descriptions, builds a dependency graph, topologically sorts the graph, assembles 7-section prompts with learning context (fix_patterns + governance_rules injected), and writes FORGE-compatible queue.yaml files with gates on every prompt. Supports GREENFIELD and RETROFIT modes.
- **Status:** COMPLETE (r9-002)
- **CLI:** `forge compose <project-path> [--mode GREENFIELD|RETROFIT] [--specs-dir <dir>] [--output <path>] [--api-key <key>]`
- **Entry Point:** `src/composer/index.ts`
- **Exports:** `runComposer`, `ComposeOptions`, `ComposeResult`
- **Dependencies:** ForgeLearning (fix_patterns + governance_rules via SQLite), ForgeDAG (src/engine/queue-generator.ts)
- **Database tables:** `fix_patterns` (read), `governance_rules` (read), `skill_library` (read)

### Files

| File | Purpose |
|------|---------|
| `src/composer/index.ts` | Main orchestrator: gap check → extract → DAG → sort → assemble → write |
| `src/composer/task-extractor.ts` | Loads governance suite, extracts tables/agents, calls Claude for task decomposition |
| `src/composer/gap-detector.ts` | Schema gap detection, RLS audit, behavioral contract gap finder |
| `src/composer/prompt-assembler.ts` | 7-section prompt assembly, task splitting, injects learning context |
| `src/composer/queue-writer.ts` | YAML queue writer, run file splitting (45 prompts/run max) |
| `src/composer/adversary-tracker.ts` | Adversary accuracy evaluator, finding recorder/resolver |

---

## Agent: ForgeDocumentSequencer (src/composer/document-sequencer.ts)

- **Purpose:** Processes 40+ spec documents in dependency order for enterprise builds. Categorizes specs by FOUNDATION / SCHEMA / AUTH / API / UI / INTEGRATION / TESTING / DEPLOY. Generates a sequence plan with estimated prompt count, run count, and cost. Writes sequence plan summary to `.forge/sequence_plan.md`.
- **Status:** COMPLETE (r9-002)
- **CLI:** `forge sequence <specs-dir> <project-path> [--output <path>] [--api-key <key>]`
- **Entry Point:** `src/composer/document-sequencer.ts`
- **Exports:** `loadSpecDocuments`, `createSequencePlan`, `writeSequencePlanSummary`
- **Dependencies:** ForgeLearning (read), ForgeComposerEngine (for per-spec queue generation)
- **Database tables:** `prompt_scores` (read — for cost estimation per category)

---

## Agent: ForgePhaseBuildChain (src/phases/phase-chain.ts)

- **Purpose:** End-to-end build pipeline. Chains Scout → PRD → Architect → Compose → Execute in a single invocation. Supports three modes: GREENFIELD (idea → production), RETROFIT (abandoned build resurrection), PRD_IMPORT (existing specs → production). Writes `.forge/BUILD_READY.md` with the launch command for the generated queue.
- **Status:** COMPLETE (r9-005)
- **CLI:** `forge build <path> [--idea <text>|--prd <file>|--specs <dir>] [--mode GREENFIELD|RETROFIT|PRD_IMPORT] [--api-key <key>]`
- **Entry Point:** `src/phases/phase-chain.ts`
- **Exports:** `runForgeBuild`, `BuildOptions`, `BuildResult`
- **Dependencies:** ForgeArchitect (phase0-scout, phase1a-prd, phase1b-architect), ForgeComposerEngine
- **Database tables:** `build_outcomes` (write), `decision_weights` (write)

---

## Agent: ForgeQueueRecomposer (src/composer/recomposer.ts)

- **Purpose:** After each run, identifies failed prompts from gate output, queries `fix_patterns` for known fixes, re-queues failed prompts with fix context injected into the prompt body, and removes prompts made unnecessary by prior output (deduplication). Writes a `-recomposed.yaml` alongside the original queue file and generates a recomposition report.
- **Status:** COMPLETE (r9-007)
- **Entry Point:** `src/composer/recomposer.ts`
- **Exports:** `loadRunResults`, `recomposeQueue`, `generateRecompositionReport`
- **Dependencies:** ForgeLearning (fix_patterns read via SQLite)
- **Database tables:** `fix_patterns` (read), `prompt_scores` (read)

---

## Agent: ForgeABTester (src/composer/ab-tester.ts)

- **Purpose:** For prompts with less than 50% historical first-pass rate (queried from `prompt_scores`), generates two template variations — standard vs. step-by-step — and runs both against the gate sequence. Compares pass rates, stores the winning template in `skill_library` for automatic injection into all future prompts of the same task_type. Prevents repeated first-pass failures by learning optimal prompt structure per task class.
- **Status:** NOT_STARTED
- **Entry Point:** `src/composer/ab-tester.ts`
- **Exports:** `shouldRunABTest`, `generateVariantB`, `storeWinningTemplate`, `runABTestDecision`
- **Dependencies:** ForgeLearning (prompt_scores read, skill_library write)
- **Database tables:** `prompt_scores` (read), `skill_library` (write)

---

## Agent: ForgeDeploy (src/phases/)

- **Purpose:** Deploy pipeline — canary, env parity, migration sequencing, rollback.
- **Status:** NOT_STARTED (Run 4-5)

---

## Agent: ForgeSession (src/learning/session.ts)

- **Purpose:** Multi-run session orchestration — state serialization, fingerprinting, crash recovery, handoff docs.
- **Status:** COMPLETE (Run 1)

---

## Agent: ForgeSync (src/learning/sync.ts)

- **Purpose:** Cross-machine SQLite sync via append-only protocol with file locking.
- **Status:** COMPLETE (Run 1)

---

## Agent: ForgeHooks (src/learning/hooks-enhanced.ts)

- **Purpose:** Hook lifecycle execution — 24 default hooks, condition evaluation, PreCompact handler.
- **Status:** COMPLETE (Run 1)

---

## Agent: GapAuditor (src/resurrection/gap-auditor.ts)

- **Purpose:** System 1 (Resurrection and Gap Intelligence Engine) orchestrator. Wraps ForgeRetrofit's SCAN + DIAGNOSE, runs the nine governance gap detectors, drives ArtifactHealthScorer, dispatches AUTO gaps to RegenerationEngine and CRITICAL/HUMAN_GATE gaps to HumanGateEvaluator, reconstructs the halt point, writes the continuation plan, and persists one `gap_audit_runs` row per invocation. Strictly read-only itself (Contract R-1) — it never writes to a governance file; only RegenerationEngine does.
- **Status:** COMPLETE
- **CLI:** `forge audit <project-path> [--scope FULL|GOVERNANCE_ONLY|CODE_ONLY|TARGETED] [--halt-recovery] [--non-interactive] [--api-key <key>]`
- **Entry Point:** `src/resurrection/gap-auditor.ts` → `runGapAudit(options: GapAuditOptions): Promise<GapAuditResult>`
- **Exports:** `runGapAudit`, `GapAuditOptions`, `GapAuditResult`
- **Dependencies:** ForgeRetrofit (`runScan`, `generateArchitectureHealthReport`, `buildGovernanceReconciliationReport`, `buildEnterprisePatternsGapReport`, `runRetrofitPipeline`), `src/resurrection/governance-gaps.ts`, `artifact-scorer.ts`, `regeneration-engine.ts`, `human-gate.ts`, `halt-reconstructor.ts`, `continuation-planner.ts`, `src/memory/gap-audits.ts` (CRUD), `src/learning/database.ts` (`getForgeDbPath`, `machine_id`)
- **Database tables:** `gap_audit_runs` (write), `artifact_health_scores` (write, delegated to ArtifactHealthScorer), `scan_reports`/`reconcile_decisions` (read, via ForgeRetrofit), `build_runs`/`prompt_executions` (read, halt reconstruction)

### Files

| File | Purpose |
|------|---------|
| `src/resurrection/gap-auditor.ts` | Orchestrator: scan → detect → score → regen/gate → plan → persist |
| `src/resurrection/governance-gaps.ts` | Nine per-artifact content gap detectors (F21) |
| `src/resurrection/types.ts` | All System 1 type definitions |
| `src/resurrection/halt-reconstructor.ts` | F24 — reads Build Memory + preserved branch → `HaltPoint` |
| `src/resurrection/continuation-planner.ts` | Builds `ContinuationStep[]` → `gap_audit_runs.continuation_plan` |
| `src/resurrection/index.ts` | Public API — re-exports `runGapAudit`, `runResurrectResume` |
| `src/memory/gap-audits.ts` | CRUD for `gap_audit_runs` + `artifact_health_scores` (better-sqlite3) |

---

## Agent: ArtifactHealthScorer (src/resurrection/artifact-scorer.ts)

- **Purpose:** Scores each of the nine governance artifacts on completeness, freshness, and consistency, rolls them into one `composite_score` (`0.45*completeness + 0.35*freshness + 0.20*consistency`), and decides whether regeneration is recommended and, if so, into which tier (AUTO vs. HUMAN_GATE per `REGEN_THRESHOLDS = { AUTO_BELOW: 0.5, GATE_BELOW: 0.3, RESUME_FLOOR: 0.7 }`). Writes one `artifact_health_scores` row per artifact per audit. Read-only (Contract R-1).
- **Status:** COMPLETE
- **CLI:** none (invoked by GapAuditor; results visible via `forge health` and the audit report)
- **Entry Point:** `src/resurrection/artifact-scorer.ts` → `scoreArtifact(...)`, `scoreAll(...)`
- **Exports:** `scoreArtifact`, `scoreAll`, `ArtifactScore`, `COMPOSITE_WEIGHTS`, `REGEN_THRESHOLDS`
- **Dependencies:** `governance-gaps.ts` (`Gap[]` per artifact), `ScanReport` (drift refs), `src/memory/gap-audits.ts` (write)
- **Database tables:** `artifact_health_scores` (write), `gap_audit_runs` (read — parent id)

---

## Agent: RegenerationEngine (src/resurrection/regeneration-engine.ts)

- **Purpose:** Regenerates every artifact whose `artifact_health_scores.regeneration_tier = 'AUTO'`, writing a corrected governance doc to disk and incrementing `gap_audit_runs.gaps_auto_regenerated`. The only System 1 component that writes to a governance file. Wholesale rewrite for `SESSION_STATE`/`STATE_OF_THE_BUILD`/`TOOLCHAIN`; section-scoped patching (preserving human prose) for `PRD`/`BLUEPRINT`/`BEHAVIORAL_CONTRACTS`/`SCHEMA_REGISTRY`/`AGENTS`/`TESTING`. Refuses to write during an in-flight Phase 3 build (Contract R-2).
- **Status:** COMPLETE
- **CLI:** none (invoked by GapAuditor)
- **Entry Point:** `src/resurrection/regeneration-engine.ts` → `regenerate(artifact, score, scanReport, gaps): Promise<RegenResult>`
- **Exports:** `regenerate`, `regenerateAll`, `RegenResult`, `WHOLESALE_ARTIFACTS`, `SECTION_SCOPED_ARTIFACTS`
- **Dependencies:** `src/engine/claude-runner.ts` (draft content), `ScanReport` (ground truth), `src/memory/gap-audits.ts` (update counts)
- **Database tables:** `artifact_health_scores` (read — `regeneration_tier`, `missing_sections`, `drift_detail`), `gap_audit_runs` (read/write — `gaps_auto_regenerated`, `health_score_after`)

---

## Agent: HumanGateEvaluator (src/resurrection/human-gate.ts)

- **Purpose:** The fifth, structural human gate (in addition to Contract 2's four). Presents every CRITICAL/HUMAN_GATE-tier gap to the operator for an approve/decline decision before any regeneration touches that artifact; in non-interactive mode, defers and halts for human (Contract R-3). Routes counts to `gap_audit_runs.gaps_human_gated`. Cannot be disabled by any flag or environment variable.
- **Status:** COMPLETE
- **CLI:** none directly — the interactive layer of `forge audit`/`forge resurrect`; reads the same `--non-interactive` flag those commands pass through
- **Entry Point:** `src/resurrection/human-gate.ts` → `evaluateGates(gates: Gap[], opts): Promise<GateOutcome>`
- **Exports:** `evaluateGates`, `GateOutcome`, `isArchitecturalGap`
- **Dependencies:** `readline` (interactive prompt, `reconcile.ts` pattern), `src/memory/gap-audits.ts`
- **Database tables:** `artifact_health_scores` (read — `regeneration_tier = 'HUMAN_GATE'` rows), `gap_audit_runs` (write — `gaps_human_gated`, `status = 'halted_for_human'`)

---

## Agent: ExecutionMonitor (src/sentinel-prime/execution-monitor.ts)

- **Purpose:** System 5 (Sentinel Prime) real-time observer for a single Phase 3 prompt's subprocess execution. A caller feeds it stdout chunks and shell commands AS they happen (one instance per prompt, held live for the duration of the subprocess), so an out-of-scope write or a destructive command can be observed immediately rather than only reconstructed after the fact. The prompt's only permitted write scope is the `projectPath` recorded at `start()`; ExecutionMonitor observes and records violations — it cannot kill the subprocess itself. `finish()` compiles everything recorded into an `ExecutionMonitorResult`; `passed` is false when any CRITICAL or HALT-severity event was recorded, regardless of exit code.
- **Status:** COMPLETE
- **CLI:** none directly — invoked by `SentinelPrime.runFullObservation` via the `executionMonitorSingleton` registry
- **Entry Point:** `src/sentinel-prime/execution-monitor.ts` → `ExecutionMonitor` class, `createExecutionMonitor()` factory
- **Exports:** `ExecutionMonitor`, `createExecutionMonitor`, `executionMonitorSingleton` (a `Map<buildRunId, ExecutionMonitor>` cross-module registry)
- **Dependencies:** `src/sentinel-prime/types.ts` (`ObservationEventType`, `EventSeverity`, `ExecutionMonitorResult`, `ObservationEvent`)
- **Database tables:** none directly — its `ExecutionMonitorResult` is folded into `sentinel_prime_runs`/`validation_events` by `ConfidenceScorer.persistSentinelRun`

---

## Agent: DecisionValidator (src/sentinel-prime/decision-validator.ts)

- **Purpose:** System 5 (Sentinel Prime) independent critic pass over a completed Phase 3 prompt — reasons about WHAT the prompt actually produced (does the `git diff` genuinely fulfill the prompt intent, or is it a stub/partial implementation/empty diff that still exits 0), as opposed to HOW the subprocess ran. Runs as a SEPARATE Claude Code CLI invocation (`runClaude`) from the one that did the build — a fresh subprocess with no memory of building the feature, deliberately never the same model call that produced the code (a builder grading its own work is a known blind spot). `intentActuallyFulfilled` is true only when the critic's `intentFulfillmentScore >= INTENT_FULFILLMENT_THRESHOLD` (0.75). Advisory, not a hard gate on its own — a low score on a prompt whose mandatory gates already passed logs a pointed WARN rather than flipping the prompt to halted; the caller (`SentinelPrime`'s composite scorer) decides how much weight it carries. Never throws: a CLI failure, timeout, or unparseable response degrades to a documented fallback (`intentFulfillmentScore: 0.5, confidence: 0`, reason recorded in `gaps`).
- **Status:** COMPLETE
- **CLI:** none directly — invoked by `SentinelPrime.runFullObservation`; its persisted result is readable via `forge sentinel report --build-run-id <id>`
- **Entry Point:** `src/sentinel-prime/decision-validator.ts` → `DecisionValidator` class, `createDecisionValidator()` factory
- **Exports:** `DecisionValidator`, `createDecisionValidator`, `buildCriticPrompt`, `parseCriticResponse`, `CRITIC_SYSTEM_PROMPT`, `INTENT_FULFILLMENT_THRESHOLD`, `newDecisionValidatorRunId`
- **Dependencies:** `src/engine/claude-runner.ts` (`runClaude`, `ClaudeRunResult` — Contract 5, zero incremental cost via the Max-subscription CLI path, never the metered `api.anthropic.com` endpoint), `src/tools/json-extraction.ts` (`extractJsonObject`)
- **Database tables:** none directly — its `ValidationResult` is folded into `sentinel_prime_runs` by `ConfidenceScorer.persistSentinelRun`

---

## Agent: GovernanceEnforcer (src/sentinel-prime/governance-enforcer.ts)

- **Purpose:** System 5 (Sentinel Prime) post-prompt contract scanner. Where Contract 3 already halts a build the instant a prompt tries to EDIT a governance document, GovernanceEnforcer catches the quieter case: a prompt that never touches `BEHAVIORAL_CONTRACTS.md` at all but writes code that contradicts what the document promises. Parses every `### Contract N: Title` heading out of `BEHAVIORAL_CONTRACTS.md` (`parseContracts`), matches contracts to modified `.ts`/`.tsx` files by keyword overlap (a cheap, dependency-free relevance proxy), then runs a small fixed library of four named contradiction scanners: an unguarded build-state write during an active build (Contract R-2), a silent auto-approve reintroducing the Session 5.1 `--auto-approve-gates`/`--accept-blockers` conflation, a self-modifying write under `src/`, and a stray reference to the metered `api.anthropic.com` endpoint where Contract 5 promises a $0-incremental-cost CLI path. Every contradiction becomes a CRITICAL, non-auto-resolvable `DriftReport`; a prompt that touched `src/` but left `STATE_OF_THE_BUILD.md`/`SESSION_STATE.md` untouched becomes a WARN, auto-resolvable one instead. Read-only and never throws — a missing governance doc or unreadable file degrades to a logged WARN and a smaller scan.
- **Status:** COMPLETE
- **CLI:** none directly — invoked by `SentinelPrime.runFullObservation`; its persisted result (contract violations) is readable via `forge sentinel report --build-run-id <id>`
- **Entry Point:** `src/sentinel-prime/governance-enforcer.ts` → `GovernanceEnforcer` class, `createGovernanceEnforcer()` factory
- **Exports:** `GovernanceEnforcer`, `createGovernanceEnforcer`, `parseContracts`, `ParsedContract`
- **Dependencies:** `src/resurrection/governance-gaps.ts` (`findGovernanceDoc` — reused from System 1, so a project keeping governance under `governance/` or `docs/` is still found)
- **Database tables:** none directly — its `GovernanceEnforcerResult` is folded into `sentinel_prime_runs` by `ConfidenceScorer.persistSentinelRun`

---

## Agent: ConfidenceScorer (src/sentinel-prime/confidence-scorer.ts)

- **Purpose:** System 5 (Sentinel Prime) — combines the three independent signals above (ExecutionMonitor, DecisionValidator, GovernanceEnforcer) into one weighted composite confidence score (`scoreConfidence`: execution 0.35 + validation 0.40 + governance 0.25) and turns that score into a concrete halt/continue decision (`decideHalt`: halt when composite < 0.4, OR any HALT-severity execution violation, OR any governance contract violation — any one alone is sufficient; auto-recoverable only when composite >= 0.3 AND neither hard signal fired). Persists the full run to `sentinel_prime_runs` plus one `validation_events` row per recorded violation (`persistSentinelRun`), guarded per Contract 4 — a database failure is logged and swallowed, never thrown. Pure arithmetic over already-resolved inputs, so it never throws on its own.
- **Status:** COMPLETE
- **CLI:** none directly — its output (`composite_confidence`, `halt_triggered`, `halt_reason`) is readable via `forge sentinel report --build-run-id <id>`, `forge sentinel history --project <path>`; the halt threshold is readable/settable via `forge sentinel threshold [--set <value>]` (persists to `forge_meta`, not yet read back by this module — flagged in `STATE_OF_THE_BUILD.md`)
- **Entry Point:** `src/sentinel-prime/confidence-scorer.ts` → `scoreConfidence(...)`, `decideHalt(...)`, `persistSentinelRun(...)`
- **Exports:** `scoreConfidence`, `decideHalt`, `persistSentinelRun`, `SENTINEL_WEIGHTS`
- **Dependencies:** `src/memory/client.ts` (`getClient`, `logMemoryWarning`, `toJsonText`, `toSqliteBool`)
- **Database tables:** `sentinel_prime_runs` (write), `validation_events` (write)

---

## Agent: OrchestratorEngine (src/orchestrator/engine.ts)

- **Purpose:** The Native Orchestrator's master loop — replaces `forge-orchestrator.ps1` (Layer 2 of FORGE's three-layer architecture: `forge.ps1`/`forge build` runs one `queue.yaml`; the orchestrator runs an entire project's `library-manifest.yaml` to completion in dependency order; `library/<project>/*.yaml` is the fuel depot). Given a project name, loads its manifest, resolves the dependency-ordered runnable frontier via `ManifestResolver`, runs each queue to completion via `QueueRunner`, and loops until nothing more can run — either every queue reached a terminal state, or a failure severed the remaining dependency chain (cascading a `SKIPPED` status to every downstream dependent via `skipDependentsOf`). Supports `--dry-run` (prints the full simulated execution plan, mutates nothing), `--only <id>` (bypasses dependency resolution), `--skip-to <id>` (marks everything before the target `SKIPPED`, for resuming), `--reset` (re-run a COMPLETE queue). Degrades gracefully on an out-of-memory-flavored failure (`isOutOfMemoryError`/`handleOutOfMemory`): saves manifest state, marks the Build Memory row PAUSED (not FAILED), logs the exact `--skip-to` command to resume. Never fabricates a result (Iron Law 3) — a queue's `success` is exactly what `QueueRunner.run` reported.
- **Status:** COMPLETE
- **CLI:** `forge orchestrate <project> [--library-path <path>] [--project-path <path>] [--dry-run] [--skip-to <queue-id>] [--only <queue-id>] [--reset]`
- **Entry Point:** `src/orchestrator/engine.ts` → `OrchestratorEngine` class, `createOrchestratorEngine()` factory, `.run(options: OrchestratorOptions): Promise<OrchestratorResult>`
- **Exports:** `OrchestratorEngine`, `createOrchestratorEngine`
- **Dependencies:** `ManifestResolver` (`src/orchestrator/manifest-resolver.ts`), `QueueRunner` (`src/orchestrator/queue-runner.ts`), `src/memory/client.ts` (`getClient`, `logMemoryWarning`, `newId`, `nowIso`)
- **Database tables:** `orchestrator_manifests` (write — best-effort mirror; the on-disk manifest YAML is the actual source of truth, per Contract 4)

### Files (Native Orchestrator, src/orchestrator/)

| File | Purpose |
|------|---------|
| `src/orchestrator/engine.ts` | `OrchestratorEngine` — the master sequencing loop |
| `src/orchestrator/manifest-resolver.ts` | `ManifestResolver` — manifest load/validate/save, runnable frontier, cycle detection, Build Memory mirror |
| `src/orchestrator/queue-runner.ts` | `QueueRunner` — runs ONE queue end-to-end (governance sync, stage, spawn `forge build`, Sentinel Prime readback) |
| `src/orchestrator/library-manager.ts` | `LibraryManager` — `library/<project>/` directory bookkeeping, `validateQueueYaml` |
| `src/orchestrator/governance-sync.ts` | `syncGovernanceDocs`/`syncBeforeQueueRun` — DIRECTIVE-016, native `*.md` sync |
| `src/orchestrator/types.ts` | `QueueStatus`, `ManifestStatus`, `QueueEntry`, `LibraryManifest`, `OrchestratorOptions`, `OrchestratorResult`, `QueueTransitionEvent` |
| `src/orchestrator/index.ts` | Barrel export — re-exports every module's factory function |
