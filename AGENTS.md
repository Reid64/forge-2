# FORGE 2.0 — Agents Registry

**Last Updated:** 2026-06-24
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
