# FORGE 2.0 — Agents Registry

**Last Updated:** 2026-07-22
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

---

## Agent: DeadCodeDetector (src/retrofit/dead-code-detector.ts)

- **Purpose:** Enhanced Retrofit deep-analysis detector — a regex-based (not AST-based) scan of a target project's `src/**/*.ts(x)` tree for exported symbols with zero cross-file imports, plus three same-file signals: local functions defined but never called, local variables assigned but never read, and imports never used in the importing file. Excludes test/story files and Next.js framework entry points (`page.tsx`, `route.ts`, `index.ts`, etc. — a symbol only "used" by the framework's own routing convention is not dead). One instance of the RETROFIT pipeline's second, deeper analysis layer (`runDeepAnalysis`), purpose-built for existing/legacy codebases rather than greenfield builds. Read-only against the target project; the only write is a best-effort `dead_code_findings` persistence step that never throws (Contract 4).
- **Status:** COMPLETE
- **CLI:** `forge analyze dead-code <project-path>` (standalone); also runs as part of `forge analyze <project-path>` and every `forge retrofit` invocation (via `runRetrofitPipeline` → `runDeepAnalysis`, RET-1)
- **Entry Point:** `src/retrofit/dead-code-detector.ts` → `DeadCodeDetector` class, `createDeadCodeDetector()` factory, `.detect(projectPath: string): Promise<DeadCodeFinding[]>`
- **Exports:** `DeadCodeDetector`, `createDeadCodeDetector`, `DeadCodeFinding`
- **Dependencies:** `src/memory/client.ts` (`getClient`, `logMemoryWarning`, `newId`, `nowIso`)
- **Database tables:** `dead_code_findings` (write, best-effort)

---

## Agent: OrphanedRouteDetector (src/retrofit/orphaned-route-detector.ts)

- **Purpose:** Enhanced Retrofit deep-analysis detector — enumerates every Next.js API route under `src/app/api/**/route.ts` and its exported HTTP methods, then cross-references every non-route `.ts(x)` file in `src/**` for `fetch()`/`axios()`/Supabase-client string literals that reference an API path. A route with zero frontend callers anywhere in the codebase is flagged orphaned, except for a small allowlist of routes legitimately called from outside the frontend (health checks, webhook receivers, auth-library internals). Regex-based, not AST-based. Read-only; the only write is a best-effort `orphaned_routes` persistence step that never throws (Contract 4).
- **Status:** COMPLETE
- **CLI:** `forge analyze routes <project-path>` (standalone); also runs as part of `forge analyze <project-path>` and every `forge retrofit` invocation (RET-1)
- **Entry Point:** `src/retrofit/orphaned-route-detector.ts` → `OrphanedRouteDetector` class, `createOrphanedRouteDetector()` factory, `.detect(projectPath: string): Promise<OrphanedRouteFinding[]>`
- **Exports:** `OrphanedRouteDetector`, `createOrphanedRouteDetector`, `OrphanedRouteFinding`
- **Dependencies:** `src/memory/client.ts` (`getClient`, `logMemoryWarning`, `newId`, `nowIso`)
- **Database tables:** `orphaned_routes` (write, best-effort)

---

## Agent: SchemaDriftDetector (src/retrofit/schema-drift-detector.ts)

- **Purpose:** Enhanced Retrofit deep-analysis detector — regex-based comparison of a target project's `supabase/migrations/*.sql` files (parsed chronologically into a resolved schema map via `buildResolvedSchema`) against its TypeScript interfaces/types that map to DB tables by naming convention (`buildTsTypeMap`). Flags tables with no corresponding TS type (`table_missing_type`), TS types with no corresponding migration table (`type_missing_table`), column-level mismatches, and obvious SQL/TS type mismatches, each rated `critical`/`major`/`minor`. The findings this module produces are what RET-5 requires be folded into every retrofit queue prompt's context. Read-only; the only write is a best-effort `schema_drift_findings` persistence step that never throws (Contract 4).
- **Status:** COMPLETE
- **CLI:** `forge analyze schema <project-path>` (standalone); also runs as part of `forge analyze <project-path>` and every `forge retrofit` invocation (RET-1, RET-5)
- **Entry Point:** `src/retrofit/schema-drift-detector.ts` → `SchemaDriftDetector` class, `createSchemaDriftDetector()` factory, `.detect(projectPath: string): Promise<SchemaDriftFinding[]>`
- **Exports:** `SchemaDriftDetector`, `createSchemaDriftDetector`, `buildResolvedSchema`, `buildTsTypeMap`, `SchemaDriftFinding`, `ResolvedSchema`, `TsTypeMap`
- **Dependencies:** `src/memory/client.ts` (`getClient`, `logMemoryWarning`, `newId`, `nowIso`)
- **Database tables:** `schema_drift_findings` (write, best-effort)

---

## Agent: DependencyAuditor (src/retrofit/dependency-auditor.ts)

- **Purpose:** Enhanced Retrofit deep-analysis detector — regex-based audit of a target project's `package.json` dependencies against what is actually imported under `src/**/*.ts(x)`, plus root config files (`next.config.*`, `tailwind.config.*`, `vitest.config.*`) and `scripts/**`. Flags packages declared but never imported (`unused` — error-weight for `dependencies`, warning-weight for `devDependencies`), packages imported in `src/` but never declared (`missing` — likely a transitive dependency imported directly), packages declared in BOTH `dependencies` and `devDependencies` (`duplicate`), and packages with a major-version update available per `pnpm outdated --json` (`outdated_major` — best-effort, silently skipped when pnpm is unavailable). Read-only; the only write is a best-effort `dependency_audit_findings` persistence step that never throws (Contract 4).
- **Status:** COMPLETE
- **CLI:** `forge analyze deps <project-path>` (standalone); also runs as part of `forge analyze <project-path>` and every `forge retrofit` invocation (RET-1)
- **Entry Point:** `src/retrofit/dependency-auditor.ts` → `DependencyAuditor` class, `createDependencyAuditor()` factory, `.audit(projectPath: string): Promise<DependencyFinding[]>`
- **Exports:** `DependencyAuditor`, `createDependencyAuditor`, `DependencyFinding`
- **Dependencies:** `node:child_process` (`execSync`, for `pnpm outdated --json`), `src/memory/client.ts` (`getClient`, `logMemoryWarning`, `newId`, `nowIso`)
- **Database tables:** `dependency_audit_findings` (write, best-effort)

---

## Agent: CoverageBaseline (src/retrofit/coverage-baseline.ts)

- **Purpose:** Enhanced Retrofit deep-analysis detector — regex-based scan of a target project's `src/lib/**/*.ts` and `src/components/**/*.tsx` (the testable units, deliberately excluding Next.js framework entry points — `page.tsx`, `route.ts`, `layout.tsx` — which are exercised through routing/integration tests rather than unit tests). For every testable file, checks whether a co-located test file exists (`{file}.test.ts(x)`, `{file}.spec.ts`, or `__tests__/{filename}.test.ts`), counts the file's exported functions/classes/constants, and — when a test file exists — counts its `it()`/`test()` calls as a rough proxy for how many of those exported symbols are actually exercised, prioritizing gaps `critical`/`high`/`medium`/`low`. The only one of the five deep-analysis detectors with **zero** Build Memory writes of any kind — stated explicitly in the module's own doc comment, not an oversight; no `coverage_baseline`-shaped table exists in the schema.
- **Status:** COMPLETE
- **CLI:** `forge analyze coverage <project-path>` (standalone); also runs as part of `forge analyze <project-path>` and every `forge retrofit` invocation (RET-1)
- **Entry Point:** `src/retrofit/coverage-baseline.ts` → `CoverageBaseline` class, `createCoverageBaseline()` factory, `.analyze(projectPath: string): Promise<CoverageBaselineFinding[]>`
- **Exports:** `CoverageBaseline`, `createCoverageBaseline`, `CoverageBaselineFinding`
- **Dependencies:** none beyond `node:fs`/`node:path` — no Build Memory client import, by design
- **Database tables:** none

---

## Agent: GitHubActionsGenerator (src/retrofit/github-actions-generator.ts)

- **Purpose:** Enhanced Retrofit CI/CD generator — detects a target project's build/test/deploy shape (package manager, Node version, whether a real test script exists, whether E2E tooling is present, whether the project deploys to Vercel) purely from files already on disk (`package.json`, `.nvmrc`, lockfiles, `vercel.json`/`.vercel`), and from that generates a minimal, correct GitHub Actions CI/CD pipeline: a `ci.yml` that always runs (typecheck, lint-if-configured, test-if-configured, build) plus, only when a Vercel deploy target is detected, a `deploy.yml` (push-to-main Vercel deploy + `forge verify`) and a `forge-verify.yml` (deployment_status-triggered HTTP health check). Wired into Phase 0 (`src/phases/phase0-scout.ts` step 13, RET-4): `ensureGitHubActions` runs when the project already has a `.git` directory (branch/checkpoint/rollback — Contracts 10/11/12 — need one) and does not yet have a `.github/workflows` directory, so an operator's existing CI setup is never overwritten. Read-only detection; the only writes are the workflow YAML files themselves, under `<projectPath>/.github/workflows/`, and only when called.
- **Status:** COMPLETE
- **CLI:** `forge analyze ci <project-path>` (standalone, generate/refresh on demand); also runs automatically at Phase 0 of every `forge build` when `.git` exists and `.github/workflows` does not (RET-4)
- **Entry Point:** `src/retrofit/github-actions-generator.ts` → `ensureGitHubActions(projectPath: string): Promise<string[]>` (returns the workflow file paths written)
- **Exports:** `ensureGitHubActions`, `detectWorkflowConfig`, `generateCIWorkflow`, `generateVercelDeployWorkflow`, `generateForgeVerifyWorkflow`, `WorkflowConfig`
- **Dependencies:** `src/tools/forge-logger.ts` (`getLogger`)
- **Database tables:** none

---

## Agent: SkillsLibraryLoader (src/skills/index.ts)

- **Purpose:** project-wide, stack-detected engineering-standards injection layer — distinct from the queue.yaml-declared `skills: [name]` mechanism already wired into `phase3-executor.ts` (which reads `<skillsDir>/<name>/SKILL.md` only for the skills a queue entry explicitly opts into, via `loadSkillContent`). `SkillsLibraryLoader` instead auto-DETECTS the target project's tech stack by reading its `package.json` dependencies/devDependencies against 9 `STACK_DETECTORS` (nextjs, supabase, tailwind, twilio, stripe, prisma, drizzle, vitest, playwright — `detectProjectStack`), loads every `*.skill.md` file directly under a skills directory (non-recursive, flat, each a YAML-frontmatter header over a Markdown template body — `loadSkillsLibrary`), and prepends every skill whose `tags` intersect the detected stack to the prompt text as one Markdown block headed `## ENGINEERING STANDARDS AND PATTERNS FOR THIS BUILD` (`injectIntoContext`/`buildSkillsContext`). Runs automatically for every Phase 3 prompt with no per-entry opt-in — complementary to, not a replacement for, the existing queue-level mechanism. House style: every operation is guarded — a missing directory, an unreadable file, a malformed frontmatter, or a missing/unparseable `package.json` degrades to "skip it"/`[]` rather than throwing (skill injection is a quality-of-life layer, never a build blocker, matching Contract 4's non-blocking posture). Known gap: `STACK_DETECTORS` has no `typescript`/`agents` entry, so the `typescript-strict` and `agent-architecture` templates (tagged `typescript`/`agents`) can never match via the auto-detected path — flagged in `STATE_OF_THE_BUILD.md` § Skills Library, not silently accepted.
- **Status:** COMPLETE
- **CLI:** `forge skills list <project-path>` (detect stack, list what would be injected), `forge skills show <skill-id>` (print one skill's full template), `forge skills inject <project-path> <prompt-text>` (show the full assembled prompt, for debugging), `forge skills add <skill-file>` (validate then copy a candidate `*.skill.md` into the library)
- **Entry Point:** `src/skills/index.ts` → `buildSkillsContext(projectPath: string, promptText: string): string` (the single call Phase 3 makes — detect stack, load library, inject, guarded end-to-end)
- **Exports:** `loadSkillsLibrary`, `detectProjectStack`, `buildSkillsContext`, `defaultSkillsLibraryDir`, `validateSkillFile`, `SKILLS_CONTEXT_HEADER`, `Skill`, `SkillsLibrary`
- **Dependencies:** `js-yaml` (`load`, frontmatter parsing), `node:fs`/`node:path`/`node:url` only — no Build Memory client import
- **Database tables:** none — reads `*.skill.md` files directly off disk; zero Build Memory writes

### Files (Skills Library, src/skills/)

| File | Purpose |
|------|---------|
| `src/skills/index.ts` | `SkillsLibraryLoader` — types, frontmatter parser, loader, query API, stack detector, context injector, validator |
| `src/skills/templates/nextjs-app-router.skill.md` | tags: nextjs, react, typescript — route handlers, server components, error shape, loading states, metadata |
| `src/skills/templates/supabase.skill.md` | tags: supabase, postgres, rls |
| `src/skills/templates/stripe.skill.md` | tags: stripe, billing, payments |
| `src/skills/templates/twilio.skill.md` | tags: twilio, telephony, sms, voice |
| `src/skills/templates/typescript-strict.skill.md` | tags: typescript (currently unreachable via auto-detection — see gap above) |
| `src/skills/templates/testing.skill.md` | tags: vitest, playwright, testing |
| `src/skills/templates/api-patterns.skill.md` | tags: nextjs, api, rest |
| `src/skills/templates/observability.skill.md` | tags: sentry, logging, monitoring |
| `src/skills/templates/agent-architecture.skill.md` | tags: agents, typescript, async (currently unreachable via auto-detection — see gap above) |
| `src/skills/templates/ui-components.skill.md` | tags: react, tailwind, shadcn, typescript |

---

## Agent: EnvValidator (src/autonomy/env-validator.ts)

- **Purpose:** Phase 0's literal first action, before `ensureGitRepo` or anything else touches the target project — confirms every environment variable a build genuinely cannot proceed without is actually resolvable. Merges two catalogs: `FORGE_ENV_REQUIREMENTS` (18 of FORGE's own operational vars, all `required: false` — each already has a documented Contract-4 degrade path elsewhere in the codebase, e.g. SQLite Build Memory instead of Supabase, a deterministic PRD skeleton instead of a live model call) and `detectProjectEnvRequirements` (the target project's own `.env.example`, where a declared key with NO default value — `KEY=` with nothing after the `=` — is the project author's own signal that `required: true`). Resolves every requirement against, in order, `process.env` → `<projectPath>/.env.local` → CredentialVault, and validates a present value's declared `format` regex when one exists (reported `invalid`, distinct from `missing`). Never halts by itself — `EnvValidationResult.allRequired === false` is folded into Phase 0's existing `blockers` array exactly like every other Phase 0 gate (AgentShield, the toolchain audit, …).
- **Status:** COMPLETE
- **CLI:** `forge env check <project-path>` (standalone, on-demand); also runs automatically as Phase 0 step 0 of every `forge build`
- **Entry Point:** `src/autonomy/env-validator.ts` → `validateEnv(projectPath: string): Promise<EnvValidationResult>`
- **Exports:** `validateEnv`, `printEnvReport`, `detectProjectEnvRequirements`, `FORGE_ENV_REQUIREMENTS`, `EnvRequirement`, `EnvValidationResult`, `InvalidEnvEntry`
- **Dependencies:** `src/autonomy/credential-vault.ts` (`createCredentialVault`, consulted as the third resolution source), `src/tools/forge-logger.ts` (`getLogger`)
- **Database tables:** none directly — reads `process.env`/`.env.local`/`.env.example` off disk and (read-only) the `project_credentials` table via CredentialVault

---

## Agent: CredentialVault (src/autonomy/credential-vault.ts)

- **Purpose:** per-project, AES-256-GCM-encrypted-at-rest local credential store, backing every other autonomy module's token/secret lookups (EnvValidator's third resolution source, SupabaseMigrator's/VercelDeployer's token fallback when no environment variable is set). The AES key is never persisted: derived from `FORGE_VAULT_KEY` (SHA-256-hashed to 32 bytes, any operator-supplied value) when set, else `SHA-256(hostname|OS username)` — a deliberate "local-first" posture (a vault populated on one machine cannot be decrypted on another, or by a different OS user, unless `FORGE_VAULT_KEY` is set explicitly and shared out of band) matching Contract 4's "degrade, never leak" philosophy. `injectIntoEnv` only ever appends genuinely-new `KEY=value` lines to `<projectPath>/.env.local` — a key already declared there (even empty) is left completely untouched. Every public method degrades gracefully: a Build Memory failure, a key mismatch, or a corrupted stored value returns a safe empty/null/false result, never throws.
- **Status:** COMPLETE
- **CLI:** `forge vault set <project-path> <key> <value>`, `forge vault get <project-path> <key>`, `forge vault list <project-path>`, `forge vault inject <project-path>`, `forge vault delete <project-path> <key>`; also invoked automatically as Phase 0 step 14 (`injectIntoEnv`) of every `forge build`
- **Entry Point:** `src/autonomy/credential-vault.ts` → `class CredentialVault` / `createCredentialVault(key?: Buffer): CredentialVault`
- **Exports:** `CredentialVault`, `createCredentialVault`, `deriveVaultKey`, `CredentialKeyInfo`, `credentialVaultLogger`
- **Dependencies:** `node:crypto` (AES-256-GCM), `src/memory/client.ts` (`getClient`, `logMemoryWarning`), `src/tools/forge-logger.ts`
- **Database tables:** `project_credentials` (schema 2.9.0 — read/write)

---

## Agent: SupabaseMigrator (src/autonomy/supabase-migrator.ts)

- **Purpose:** applies a project's `supabase/migrations/*.sql` files to its live Supabase project directly via the Supabase Management API — no `supabase` CLI subprocess, no interactive `supabase login`. Credential resolution mirrors VercelDeployer's exactly: `SUPABASE_ACCESS_TOKEN`/`SUPABASE_PROJECT_ID` environment variables first, else the project's CredentialVault entry. Flow: list `*.sql` files under `supabase/migrations/` sorted chronologically by their leading `<timestamp>_<name>.sql` filename convention → fetch already-applied versions via `GET /v1/projects/{ref}/database/migrations` → apply every pending file's SQL via `POST /v1/projects/{ref}/database/query`, in order, halting the whole batch at the first failure (later migrations routinely depend on an earlier one, so continuing onto a known-broken schema risks compounding the damage). Every attempt (applied/skipped/failed) is persisted to `autonomy_actions`. `validateMigrations` is a separate, static, read-only sweep (filename convention, balanced parentheses, chronological ordering) that never calls the Management API and never requires configuration.
- **Status:** COMPLETE
- **CLI:** `forge migrate <project-path>` (apply pending migrations), `forge migrate validate <project-path>` (static sweep only); also invoked automatically by `phase3-executor.ts` immediately after a build finalizes `status: 'completed'`, gated on `SUPABASE_ACCESS_TOKEN` being set AND `migrator.isConfigured(projectPath)` — never on a `failed`/`halted` build, and a migration failure never reopens the already-finalized build (it appends a BLOCKER to STATE_OF_THE_BUILD.md instead)
- **Entry Point:** `src/autonomy/supabase-migrator.ts` → `class SupabaseMigrator` / `createSupabaseMigrator(vault?): SupabaseMigrator`
- **Exports:** `SupabaseMigrator`, `createSupabaseMigrator`, `extractMigrationVersion`, `MigrationResult`, `MigrationStatus`, `MigrationValidationResult`
- **Dependencies:** `src/autonomy/credential-vault.ts` (token/ref fallback), `src/memory/client.ts` (`getClient`, `newId`, `nowIso`, `logMemoryWarning`), `src/tools/forge-logger.ts`, `fetch` (Supabase Management API — `https://api.supabase.com`)
- **Database tables:** `autonomy_actions` (schema 2.9.0 — write); `project_credentials` (read, via CredentialVault)

---

## Agent: VercelDeployer (src/autonomy/vercel-deployer.ts)

- **Purpose:** deploys a FORGE-built project to Vercel directly via the Vercel REST API — no `vercel` CLI subprocess, no interactive `vercel login`. Token resolution: `VERCEL_TOKEN` environment variable first, else the project's CredentialVault entry. Flow mirrors what `vercel deploy` does under the hood: walk the project directory (excluding `node_modules`/`.git`/`.next`/`.vercel`/`.forge`/`dist`/`build`/`coverage`/`.turbo`), SHA-1-hash and upload every file's raw bytes to `PUT /v2/files` (Vercel dedupes by digest — a 409 on an already-known digest counts as success), `POST /v13/deployments` referencing the uploaded files, then poll `GET /v13/deployments/{id}` every 10 seconds until a terminal `readyState` or a 10-minute ceiling. Every outcome is persisted to `deployment_history`. Also exposes `getProductionUrl` (current assigned domain) and `rollback` (revert live traffic to a prior successful deployment via `POST /v9/projects/{id}/rollback`).
- **Status:** COMPLETE
- **CLI:** `forge deploy auto <project-path> --env production|preview` (deploy, then run `forge verify` against the result); also invoked automatically as Phase 5 step 12 of every `forge build` when both a resolvable `VERCEL_TOKEN` and an existing `vercel.json` are present
- **Entry Point:** `src/autonomy/vercel-deployer.ts` → `class VercelDeployer` / `createVercelDeployer(vault?): VercelDeployer`
- **Exports:** `VercelDeployer`, `createVercelDeployer`, `DeploymentResult`, `DeploymentStatus`
- **Dependencies:** `src/autonomy/credential-vault.ts` (token fallback), `src/memory/client.ts` (`getClient`, `newId`, `nowIso`, `logMemoryWarning`), `src/tools/forge-logger.ts`, `src/deploy/verify-runner.ts` (`runDeployVerification`, invoked by the Phase 5 wiring and by `forge deploy auto` after a ready deployment), `fetch` (Vercel REST API — `https://api.vercel.com`)
- **Database tables:** `deployment_history` (schema 2.9.0 — write); `project_credentials` (read, via CredentialVault)

---

## Agent: AutonomousGateResolver (src/autonomy/gate-resolver.ts)

- **Purpose:** sits between ArtifactHealthScorer's scoring step and HumanGateEvaluator in the System 1 `GapAuditor` pipeline (`src/resurrection/gap-auditor.ts`'s `runGapAudit`, immediately after `scoreAll`, before `evaluateGates`). Where `isArchitecturalGap` only decides which gaps are architectural, `AutonomousGateResolver` goes one step further for every gap that is NOT architectural: it actually invokes `RegenerationEngine` to resolve it, then re-scores the artifact and escalates to human if the re-score did not actually improve — never fabricating a resolution the code did not verify (Iron Law 3). Rules, strictly enforced: CRITICAL always requires human, never auto-resolved, no flag overrides this (Contract R-3's fifth structural gate); MAJOR requires human when the artifact's `composite_score` is below `REGEN_THRESHOLDS.GATE_BELOW` (0.3), else auto-resolves; MINOR always attempts auto-resolution. Resolver-auto-resolved artifacts are excluded from the pre-existing tier-based `regenerateAll` pass in the same `runGapAudit` call to avoid writing the same governance file twice.
- **Status:** COMPLETE
- **CLI:** none standalone — runs automatically inside every `runGapAudit` call (`forge audit`/`forge resurrect --resume`/RETROFIT-mode `phase-chain.ts` entry points that invoke it)
- **Entry Point:** `src/autonomy/gate-resolver.ts` → `class AutonomousGateResolver` / `createAutonomousGateResolver(): AutonomousGateResolver` → `resolveGaps(gaps, options): Promise<GateResolutionResult[]>`
- **Exports:** `AutonomousGateResolver`, `createAutonomousGateResolver`, `computeGapId`, `partitionResolutions`, `summarizeResolutions`, `GateResolutionResult`, `ResolveGapsOptions`
- **Dependencies:** `src/resurrection/regeneration-engine.ts` (`regenerate`), `src/resurrection/types.ts` (`REGEN_THRESHOLDS`, `ArtifactName`, `ArtifactScore`, `Gap`, `GapSeverity`), `src/learning/database.ts` (`getMachineId`), `src/retrofit/types.ts` (`ScanReport`)
- **Database tables:** none directly — a successful auto-resolution rides on System 1's existing `gap_audit_runs`/`artifact_health_scores` tables via `RegenerationEngine`; a deferral-to-human decision is not currently persisted anywhere beyond a console log line (known gap, see `STATE_OF_THE_BUILD.md` § Autonomy Upgrades)

---

## Agent: BuildHealthMonitor (src/autonomy/health-monitor.ts)

- **Purpose:** a third, build-wide observation layer sitting above both the mandatory per-prompt Contract 13 gate and Sentinel Prime (System 5) — neither of which judges more than one prompt at a time, so neither notices a build that is repeatedly limping through recovery, whose Sentinel Prime confidence is trending down prompt over prompt, or whose Node process is slowly leaking memory across a multi-hour run. Tracks consecutive Sentinel-failed prompts, a rolling 10-prompt confidence average, and process RSS memory across the whole run via a 60-second background sampling interval. `getHealth()` computes a `healthy`/`degraded`/`critical` status: CRITICAL on ANY of `consecutiveFailures >= 3`, `averageConfidence < 0.3`, or `memoryUsageMb > 6000`; DEGRADED (checked only once CRITICAL is ruled out) on ANY of `consecutiveFailures >= 1`, `averageConfidence < 0.5`, or `memoryUsageMb > 4000`. `shouldPause()` is the one method with a side effect beyond bookkeeping: on a CRITICAL read it writes `<projectPath>/.forge/health-{timestamp}.json`, logs the pause, and waits out a 2-minute in-process cooldown before returning — the caller does not implement the wait itself. BuildHealthMonitor OBSERVES; it never gates — Contract 13's five checks and Sentinel Prime's `HaltDecision` remain the only things that can actually halt a build.
- **Status:** COMPLETE
- **CLI:** none standalone — one instance per `runPhase3Executor` call, started before the prompt loop and stopped in the `finally` block; its final `BuildHealth` snapshot is also passed into `onSentinelPrimeHalt` (Integration Bus) when a Sentinel Prime halt occurs mid-build
- **Entry Point:** `src/autonomy/health-monitor.ts` → `class BuildHealthMonitor` / `createBuildHealthMonitor(projectPath, log?): BuildHealthMonitor`
- **Exports:** `BuildHealthMonitor`, `createBuildHealthMonitor`, `BuildHealth`, `BuildHealthStatus`
- **Dependencies:** `node:fs` (`.forge/health-*.json` report writes), `node:process` (`process.memoryUsage().rss`) — no Build Memory client import
- **Database tables:** none — health reports are written to `<projectPath>/.forge/health-*.json` on disk only (known gap, see `STATE_OF_THE_BUILD.md` § Autonomy Upgrades)

### Files (Autonomy Upgrades, src/autonomy/)

| File | Purpose |
|------|---------|
| `src/autonomy/index.ts` | Barrel export — re-exports all six modules below |
| `src/autonomy/env-validator.ts` | EnvValidator — Phase 0 step 0, merges FORGE's + the target project's env requirement catalogs |
| `src/autonomy/credential-vault.ts` | CredentialVault — AES-256-GCM per-project credential store (`project_credentials`) |
| `src/autonomy/supabase-migrator.ts` | SupabaseMigrator — applies `supabase/migrations/*.sql` via the Management API (`autonomy_actions`) |
| `src/autonomy/vercel-deployer.ts` | VercelDeployer — deploys via the Vercel REST API (`deployment_history`) |
| `src/autonomy/gate-resolver.ts` | AutonomousGateResolver — auto-resolves non-CRITICAL governance gaps via RegenerationEngine |
| `src/autonomy/health-monitor.ts` | BuildHealthMonitor — build-wide consecutive-failure/confidence/memory monitor with auto-pause |

---

## Agent: ShadcnInstaller (src/ui-engine/shadcn-installer.ts)

- **Purpose:** deterministic shadcn/ui component installer for a FORGE-built project. `SHADCN_COMPONENTS` is a static catalog (component name → its own declared dependencies, e.g. `dialog` depending on `button`); `detectInstalledComponents` reads which are already present under the project's shadcn install path, `installComponent` writes a component (and recursively ensures its dependencies) if missing, and `ensureComponentsInstalled` is the batch entry point Phase 3 calls before a `ui`/`feature` prompt executes. `detectRequiredComponents` is a keyword scan of the assembled prompt text for shadcn/ui component names, so the installer only ever installs what a given prompt is actually about to need — never the whole catalog speculatively.
- **Status:** COMPLETE
- **CLI:** `forge design install-shadcn <project-path> <component-names...>`; also invoked automatically inside Phase 3 (`SHADCN_INSTALL_PROMPT_TYPES = {'ui','feature'}`) immediately before claude executes a matching prompt
- **Entry Point:** `src/ui-engine/shadcn-installer.ts` → `ensureComponentsInstalled(projectPath: string, componentNames: string[]): Promise<string[]>` (returns newly-installed component names)
- **Exports:** `SHADCN_COMPONENTS`, `detectInstalledComponents`, `installComponent`, `ensureComponentsInstalled`, `detectRequiredComponents`, `ShadcnComponent`
- **Dependencies:** `node:fs`/`node:path` only — no Build Memory client import
- **Database tables:** none

---

## Agent: UIComponentGenerator (src/ui-engine/component-generator.ts)

- **Purpose:** generates one production-grade UI component from a `ComponentSpec` (name, description, props, data source, interactions, accessibility requirements) — skill-informed and shadcn-aware, instructed to use Tailwind `dark:` prefix classes on every color/background/border utility (UI-4) so every generated component is dark-mode-aware by construction. Persists the generated code, alongside its `build_run_id`/`prompt_id` provenance, to the new `design_artifacts` table (schema 3.0.0) for reuse/audit. Per UI-5, calls `generateStory` (StorybookGenerator) at generation time so a matching `.stories.tsx` is written alongside every component, not as a separate opt-in step.
- **Status:** COMPLETE
- **CLI:** `forge design component <project-path> <component-name> --description "<text>" --props <comma-list>`
- **Entry Point:** `src/ui-engine/component-generator.ts` → `class UIComponentGenerator` → `generate(spec: ComponentSpec, projectPath: string, buildRunId: string, promptId: string): Promise<GeneratedComponent>`
- **Exports:** `UIComponentGenerator`, `createUIComponentGenerator`, `ComponentSpec`, `GeneratedComponent`
- **Dependencies:** `src/ui-engine/storybook-generator.ts` (`generateStory`), `src/memory/client.ts` (`getClient`, `newId`, `nowIso`) for the `design_artifacts` write, `node:fs`/`node:path`
- **Database tables:** `design_artifacts` (schema 3.0.0 — write)

---

## Agent: DesignTokenManager (src/ui-engine/design-token-manager.ts)

- **Purpose:** establishes and maintains a project's design-token baseline — `DEFAULT_DESIGN_TOKENS` (colors, typography, spacing, radii, shadows), `detectProjectTokens` (reads any existing Tailwind config to avoid clobbering an operator's own palette), `generateTailwindConfig`/`generateGlobalsCss` (dark-mode-aware from the first write — UI-4), and `ensureDesignTokens`, the guarded entry point Phase 3 calls once before the first prompt of every build (UI-1). Never overwrites an existing `tailwind.config.*`/`globals.css` — checked before/after so `forge design tokens` can report whether a file was newly written or left untouched.
- **Status:** COMPLETE
- **CLI:** `forge design tokens <project-path>`; also invoked automatically as the first step of every non-dry-run Phase 3 build, before prompt 1
- **Entry Point:** `src/ui-engine/design-token-manager.ts` → `ensureDesignTokens(projectPath: string): Promise<void>`
- **Exports:** `DEFAULT_DESIGN_TOKENS`, `detectProjectTokens`, `generateTailwindConfig`, `generateGlobalsCss`, `ensureDesignTokens`, `DesignTokens`
- **Dependencies:** `node:fs`/`node:path` only — no Build Memory client import
- **Database tables:** none

---

## Agent: StorybookGenerator (src/ui-engine/storybook-generator.ts)

- **Purpose:** scaffolds and generates Storybook stories for a project's components. `detectStorybookInstalled` checks for an existing Storybook setup; `generateStory` writes one component's `.stories.tsx` (called directly by UIComponentGenerator at generation time, per UI-5); `generateStoriesForProject` sweeps every component under a project for one missing a story (skipping any that already has one) — the retroactive path for components generated before UI Engine existed, or by a route other than UIComponentGenerator; `generateStorybookIndex` writes the project-level Storybook index.
- **Status:** COMPLETE
- **CLI:** `forge design storybook <project-path>` (runs `generateStoriesForProject`, reports generated vs. skipped)
- **Entry Point:** `src/ui-engine/storybook-generator.ts` → `generateStoriesForProject(projectPath: string): Promise<{ generated: string[]; skipped: string[] }>`
- **Exports:** `detectStorybookInstalled`, `generateStory`, `generateStoriesForProject`, `generateStorybookIndex`
- **Dependencies:** `node:fs`/`node:path` only — no Build Memory client import
- **Database tables:** none

---

## Agent: AccessibilityChecker (src/ui-engine/accessibility-checker.ts)

- **Purpose:** static WCAG 2.1 AA source scan over React/TSX component code — no headless browser, no `axe-core` runtime dependency. `checkComponentAccessibility` evaluates a single file's source against a rule catalog (missing `alt` text, missing form labels, non-semantic interactive elements, missing `dark:` variants per UI-4, and more), producing per-issue `severity`/`rule`/`description`/`fix` plus a per-file `score`/`passed`; `checkProjectAccessibility` sweeps every `.tsx` under `src/components/`. Backs two independent call sites (UI-3): a warn-only Phase 3 post-prompt scan (`phase3-executor.ts`, never flips `disposition`) and the real, failing Sentinel `component_accessibility` gate (`phase4-sentinel.ts`'s `runComponentAccessibilityGate`, `COMPONENT_ACCESSIBILITY_GATE_PROMPT_TYPES = {'feature','ui'}`).
- **Status:** COMPLETE
- **CLI:** `forge design audit <project-path>` (runs `checkProjectAccessibility`, prints per-component score/issues/fixes, non-zero exit on any failing component); also invoked automatically after every `ui`/`feature` prompt in Phase 3 (warn-only) and as a genuine Sentinel gate in Phase 4
- **Entry Point:** `src/ui-engine/accessibility-checker.ts` → `checkProjectAccessibility(projectPath: string): Promise<AccessibilityReport[]>`
- **Exports:** `checkComponentAccessibility`, `checkProjectAccessibility`, `AccessibilityIssue`, `AccessibilityReport`
- **Dependencies:** `node:fs`/`node:path` only — no Build Memory client import
- **Database tables:** none

### Files (UI Engine, src/ui-engine/)

| File | Purpose |
|------|---------|
| `src/ui-engine/index.ts` | Barrel export — re-exports all five modules' public surface |
| `src/ui-engine/shadcn-installer.ts` | ShadcnInstaller — component catalog, detect/install, prompt-text keyword scan |
| `src/ui-engine/component-generator.ts` | UIComponentGenerator — generates a component, persists to `design_artifacts`, calls StorybookGenerator |
| `src/ui-engine/design-token-manager.ts` | DesignTokenManager — Tailwind config + globals.css baseline, dark-mode-aware |
| `src/ui-engine/storybook-generator.ts` | StorybookGenerator — per-component and whole-project Storybook story generation |
| `src/ui-engine/accessibility-checker.ts` | AccessibilityChecker — static WCAG 2.1 AA source scan, backs both the Phase 3 warn-only check and the Sentinel gate |
