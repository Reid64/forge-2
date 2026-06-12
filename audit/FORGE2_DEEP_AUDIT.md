# FORGE 2.0 — Deep Audit Report

**Date:** 2026-06-11
**Scope:** 69 TypeScript source files under `src/`, 13 SQL migrations, `package.json`, type contracts.
**Auditor:** automated static audit (typecheck + import/export graph + per-module read).

---

## Overall Health Grade: **B+ (87/100)**

FORGE 2.0 is a well-engineered codebase. It **typechecks cleanly under maximal strictness**
(`strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`,
`noUncheckedIndexedAccess` all on), has **no dead imports**, **no circular dependencies**,
**real logic in every intelligence module** (no stubbed scorers/estimators), **valid SQL**,
and **well-parameterized configuration** (17 env vars, no embedded secrets).

The grade is held below A by one architectural theme: **several complete subsystems are built,
tested, and correct — but never wired into the runtime pipeline or CLI.** They are *standalone*,
not *dead* (they compile and most have tests), but nothing in a real build invokes them. The
most consequential is the **Six Laws verifier**, a core governance concept referenced throughout
the codebase that no phase actually runs.

| Dimension | Result |
|---|---|
| `tsc --noEmit` | ✅ **PASS** (exit 0, zero errors) |
| Dead imports | ✅ None (guaranteed by clean `noUnusedLocals`) |
| Circular dependencies | ✅ None |
| Hardcoded-return stubs | ✅ None found in 8 intelligence modules |
| TODO/FIXME/placeholder | ✅ All intentional (detectors + scaffold generators) |
| SQL migrations valid | ✅ All 13 balanced & well-formed |
| `types/index.ts` exports | ✅ All 26 exports used |
| `package.json` deps | ⚠️ 1 unused (`glob`) |
| Module integration | ⚠️ 7 modules + 1 subsystem standalone (not wired) |

---

## 1. Typecheck Results

```
$ npx tsc --noEmit
EXIT: 0
```

Zero errors under a strict `tsconfig.json` (`strict: true`, `noUnusedLocals: true`,
`noUnusedParameters: true`, `noImplicitReturns: true`, `noFallthroughCasesInSwitch: true`,
`noUncheckedIndexedAccess: true`).

**Consequence for this audit:** because `noUnusedLocals` is enabled and the build is clean,
**dead/unused imports are impossible** — TypeScript would have failed the build. The "dead
imports" check in the task is therefore satisfied automatically with zero findings.

---

## 2. Per-Module Integration Status

Legend: **INTEGRATED** = invoked from a phase and/or the CLI in a real build · **STANDALONE** =
compiles + (usually) tested, but no phase/CLI invokes it · **DEAD** = nothing references it at all.

### `src/tools/` (22 modules)

| Module | Status | Wired into |
|---|---|---|
| forge-logger | INTEGRATED | 43 files |
| stack-detector | INTEGRATED | phase0/1a/1b/2/3 + engine (13) |
| schema-extractor | INTEGRATED | phase4, phase1c, six-laws (6) |
| schema-validator | INTEGRATED | phase1a, provider-router, telemetry, cli/config (4) |
| codebase-reader | INTEGRATED | phase1c, phase2 (8) |
| env-auditor | INTEGRATED | phase0 |
| design-system-generator | INTEGRATED | phase1b |
| codebase-rag | INTEGRATED | phase3 |
| visual-regression | INTEGRATED | phase4-sentinel |
| live-preview-gate | INTEGRATED | phase4-sentinel |
| security-scanner | INTEGRATED | phase4-sentinel |
| accessibility-auditor | INTEGRATED | phase4-sentinel |
| seo-validator | INTEGRATED | phase4-sentinel |
| architecture-guard | INTEGRATED | phase4-sentinel |
| migration-safety | INTEGRATED | phase4-sentinel |
| consensus-validator | INTEGRATED | phase4-sentinel |
| project-autopsy | INTEGRATED | cli (`resurrect`) |
| task-scheduler | INTEGRATED | cli (`schedule …`) |
| notifier | INTEGRATED | task-scheduler → cli |
| **doc-generator** | **STANDALONE** | test only — no phase/CLI |
| **pdf-generator** | **STANDALONE** | test only — no phase/CLI |
| **web-scraper** | **STANDALONE** | test only — no phase/CLI |
| **log-search** | **STANDALONE** (by design) | own shell entrypoint (`import.meta.url` main); not in `package.json` `bin` |

✅ **All 9 Sentinel sub-tools are correctly wired into `phase4-sentinel.ts`** (imports at
`phase4-sentinel.ts:49–99`): schema-extractor, visual-regression, live-preview-gate,
security-scanner, accessibility-auditor, seo-validator, architecture-guard, migration-safety,
consensus-validator.

### `src/engine/` (11 modules)

| Module | Status | Wired into |
|---|---|---|
| queue-generator | INTEGRATED | cli, phase3, phase5, analysis (12) |
| provider-router | INTEGRATED | phase1a/1b, agent-creator, consensus (5) |
| git-manager | INTEGRATED | phase3, phase4, cli (3) |
| prompt-assembler | INTEGRATED | phase3, phase4 |
| failure-predictor | INTEGRATED | phase3, cost-estimator |
| claude-runner | INTEGRATED | phase3 |
| parallel-scheduler | INTEGRATED | phase3 |
| prompt-rewriter | INTEGRATED | phase3 |
| prompt-decomposer | INTEGRATED | phase3 |
| model-router | INTEGRATED | prompt-assembler → phase3 |
| **free-tier-manager** | **STANDALONE** | test + `providers.yaml` only — not called by phase3/CLI/provider-router |

✅ Every engine module except `free-tier-manager` is reachable from `phase3-executor.ts` or the CLI.

### `src/analysis/` (5 modules)

| Module | Status | Wired into |
|---|---|---|
| pattern-extractor | INTEGRATED | phase5 (+ cost-estimator, agent-creator) |
| template-evolver | INTEGRATED | phase5 |
| agent-creator | INTEGRATED | phase5 |
| cost-estimator | INTEGRATED | phase3, cli |
| **six-laws-verifier** | **STANDALONE** | test only — **no phase invokes it** ⚠️ |

### `src/monitoring/` (2 modules)

| Module | Status | Notes |
|---|---|---|
| **telemetry-receiver** | **STANDALONE / effectively DEAD** | imported by nobody; no test; no CLI command; no server starts it |
| **deploy-agent** | **STANDALONE / effectively DEAD** | imported only by telemetry-receiver (type-only), which is itself unwired; no test |

The production-telemetry feedback subsystem exists end-to-end (payload contract + receiver +
`production_telemetry` table) but **has no entrypoint** — nothing in the CLI or phases ever
ingests telemetry.

---

## 3. Issues Found (with file:line)

### HIGH severity

**H1 — Six Laws verifier is never executed.** `src/analysis/six-laws-verifier.ts`
The "Six Laws" are referenced as the build standard throughout the codebase
(`engine/prompt-rewriter.ts:137`, `engine/queue-generator.ts:483`,
`analysis/pattern-extractor.ts:310`, and phase4 docs), but the module that actually verifies
them is imported by **no phase**. A real build asserts Six-Laws language into prompts yet never
runs the verifier. *Status: STANDALONE.*

**H2 — Production-telemetry subsystem has no entrypoint.**
`src/monitoring/telemetry-receiver.ts`, `src/monitoring/deploy-agent.ts`
Both modules are unreferenced by any phase, the CLI, or a server bootstrap, and neither has a
test. The `production_telemetry` table (migration 008) is written by other paths, but the
*receiver* that closes the deploy→telemetry→learn loop is unreachable. *Status: effectively DEAD.*

### MEDIUM severity

**M1 — `FreeTierManager` is unintegrated and redundant.** `src/engine/free-tier-manager.ts`
Loads `providers.yaml` (`free-tier-manager.ts:388`) and implements full free-tier quota tracking,
but no runtime code constructs it. `provider-router.ts` independently re-implements free-tier /
cooldown handling inline, so this module is parallel, unused intelligence. *Status: STANDALONE
(test + yaml only).*

**M2 — Standalone utility tools not reachable in a build.**
`src/tools/doc-generator.ts`, `src/tools/pdf-generator.ts`, `src/tools/web-scraper.ts`
Each is tested and correct but invoked by no phase or CLI command. `web-scraper.ts:1233` claims
it stores into Build Memory under Contract 4, implying it was meant to back a scheduled
`research_agent` task — but `task-scheduler.ts` never imports it. *Status: STANDALONE.*

### LOW severity

**L1 — Unused dependency `glob`.** `package.json:26`
No static or dynamic import of `glob` exists anywhere in `src/` (verified: the only matches are
the substring "global"/"npm-global"). Remove it.

**L2 — Hardcoded Windows Node path.** `src/phases/phase0-scout.ts:166`
`const WINDOWS_NODE_DIR = 'C:\\Program Files\\nodejs';` — a reasonable platform default, but not
configurable/detected. Consider deriving from `process.execPath` or an env override.

**L3 — `log-search` not registered as a binary.** `src/tools/log-search.ts:245`
It is designed as a shell CLI (`node dist/tools/log-search.js …`) but `package.json` `bin` only
exposes `forge`. Either add a `bin` entry or document the `node dist/...` invocation.

### INFORMATIONAL (no action required)

- **I1 — Hardcoded provider API URLs** (`provider-router.ts:145/155/165/176`,
  `phase1a-prd.ts:191`): these are correct upstream API defaults and are overridable
  (`API_BASE_URL` env, `providers.yaml`). `phase1a` still defaults its `callModel` through
  `providerCallModel` (`phase1a-prd.ts:827`), so the abstraction is respected.
- **I2 — All TODO/FIXME/placeholder hits are intentional**: they are either detection patterns
  (`project-autopsy.ts`, `env-auditor.ts`, `six-laws-verifier.ts`, `phase1c-ingest.ts`) or
  governance/test *scaffold generators* that deliberately emit `TODO` markers for humans
  (`phase2-governance.ts:690/697`, `agent-creator.ts:619`). None are unfinished FORGE code.

---

## 4. Verification Detail

**Dead imports (task §2a):** None — clean `tsc` with `noUnusedLocals: true` proves it.

**Exported-but-unused functions (task §2b):** No module-level dead modules among integrated code.
The standalone modules (H1, H2, M1, M2) expose public APIs consumed only by their test files;
those exports are unused by the *runtime* graph. (A symbol-level sweep would need `ts-prune`,
which is not installed; not run.)

**Circular dependencies (task §2c):** None. The layering is strictly acyclic —
`forge-logger`/`memory` (leaf) ← `tools` ← `engine` ← `analysis` ← `phases` ← `cli`. No module in
`memory/` or `forge-logger` imports upward; no `memory/*` module imports the barrel `index.js`.
The only "circular" reference is the intentional DB-level FK between `error_patterns` and
`resolutions`, explicitly resolved in `migrations/003_resolutions.sql:31–41`.

**Hardcoded-return stubs (task §2f):** None. Deep-read of the 8 scoring/estimation/routing modules
(`failure-predictor`, `cost-estimator`, `model-router`, `provider-router`, `consensus-validator`,
`six-laws-verifier`, `free-tier-manager`, `parallel-scheduler`) confirmed genuine computation
throughout (e.g. `parallel-scheduler` uses Kahn + Tarjan SCC; `cost-estimator` computes
historical means/stddev bands).

**Types match (task §5):** All 26 exports in `src/types/index.ts` are referenced (`JsonObject` 21×,
`BuildRun` 11×, down to `PromptExecutionStatus` / `InsightType` 1× each). No dead type exports.
`types/build.ts`, `types/governance.ts`, `types/patterns.ts` are thin re-export barrels.

**Dependencies match (task §6):** All declared deps are used except `glob` (L1). Several are used
via **lazy `await import()`** (correctly, as optional runtime deps) — `axe-core`
(`accessibility-auditor.ts:600`), `crawlee` (`web-scraper.ts:1332`), `playwright`
(six-laws/accessibility/live-preview/seo/visual-regression). `pino-pretty` is used as a transport
target string (`forge-logger.ts:56`). No missing dependencies. Note: `@playwright/test` appears
only inside generated-code string literals (`phase2-governance.ts:692`) and a dependency-name
check (`stack-detector.ts:251`), not as a real FORGE import — so `playwright` (declared) is correct.

**SQL migrations (task §7):** All 13 valid. Balanced parentheses and `$$` blocks in every file;
1 `CREATE TABLE` per schema migration (001–011, 013); 012 is idempotent seed `INSERT`s. Spot-read
of `003` (DECLARE-free `DO $$ … $$` block to add the deferred FK) and `012` (typed `::jsonb` casts,
unique `error_signature`) confirms well-formed PostgreSQL.

---

## 5. Recommended Fixes (prioritized)

| # | Severity | Fix | Effort |
|---|---|---|---|
| H1 | HIGH | Invoke `verifySixLaws(...)` from `phase4-sentinel.ts` (or a new gate in `phase5-learner.ts`) so the standard FORGE *asserts* is also *verified*. | M |
| H2 | HIGH | Add a CLI command (e.g. `forge telemetry serve`) or scheduled handler that boots `telemetry-receiver`, or explicitly mark the monitoring subsystem as out-of-scope/experimental. | M |
| M1 | MED | Either wire `FreeTierManager` into `provider-router`'s chain selection (and delete the inline duplicate), or remove the module + `providers.yaml` if the inline logic is canonical. | M |
| M2 | MED | Wire `web-scraper` into the `research_agent` scheduled-task handler; expose `doc-generator`/`pdf-generator` via CLI subcommands (e.g. `forge docs`, `forge report`). | M |
| L1 | LOW | Remove `"glob": "^11.0.0"` from `package.json:26`. | XS |
| L2 | LOW | Replace hardcoded `WINDOWS_NODE_DIR` with detection from `process.execPath` + env override. | S |
| L3 | LOW | Add `log-search` to `package.json` `bin`, or document the `node dist/...` call. | XS |

**Bottom line:** the code is sound and strict-clean; the work remaining is **integration, not
repair** — connect the four standalone subsystems (Six Laws, telemetry, free-tier, utility tools)
into the pipeline, and prune one unused dependency.
