# FORGE 2.0 — Factory for Orchestrated Replicable Governed Execution

> Version 2.0.0 · TypeScript/Node.js · `bin: forge`

---

## What Is FORGE 2.0?

FORGE 2.0 is a **self-learning autonomous software factory CLI** (from `package.json` description
field). It builds production-grade applications from governance documents and prompt queues with zero
human intervention during execution. The pipeline runs idea → PRD → architecture → code generation →
Sentinel quality gates → recursive learning, recording every error and fix pattern in a local SQLite
knowledge base so future builds improve automatically.

Key properties derived from `forge_config.json` and `src/cli/index.ts`:

- Model: `claude-sonnet-4-6` · max retries per prompt: `3` · max prompts per run: `45`
- Autonomous Recovery Mode available on every build (Contract 14)
- Build Memory backed by Supabase (stateless-mode fallback when unreachable)
- Learning database at `~/.forge/forge_memory.db` (SQLite, cross-machine sync supported)

---

## Quick Start

Install dependencies and compile (from `package.json` scripts):

```bash
pnpm install
pnpm run build          # tsc → dist/
```

Run any command:

```bash
node dist/cli/index.js <command> [options]
# or via the package.json alias:
pnpm forge <command> [options]
```

Run the test suite:

```bash
pnpm test               # learning-database, learning-fingerprint, learning-queries, learning-sync
pnpm run test:memory    # memory integration tests
```

Type-check without emitting:

```bash
pnpm run typecheck      # tsc --noEmit
```

---

## CLI Commands

Sourced from `src/cli/index.ts` (commander wiring, lines 1103–1302).

| Command | Arguments | Description |
|---|---|---|
| `build` | `<path>` | Full autonomous build pipeline: Phase 0 → 1 → 2 → 3 → 4 → 5 |
| `scout` | `<path>` | Phase 0 only — Toolchain Scout: scan + lock the environment |
| `design` | `<path>` | Phase 0 + 1 only — PRD + Architecture. Stops at the Gate 2 review. |
| `resume` | `<build-id>` | Resume a halted build from its last checkpoint |
| `replay` | `<build-id>` | Replay a build from a checkpoint (F12) |
| `status` | `[build-id]` | Show build status from Build Memory (defaults to most recent build) |
| `history` | — | List past builds (optionally filter with `--project <name>`) |
| `patterns` | — | Show known error patterns and success rates |
| `agents` | — | List self-created agents and their status |
| `resurrect` | `<path>` | Autopsy a failed project and rebuild it straight from the report (skips Phase 1A/1B) |
| `estimate` | `<path>` | Cost/time estimate without building (F17) |
| `repair` | `<path>` | Repair a broken TypeScript repo: diagnose → cluster → queue → execute → verify |
| `sentinel` | `<project-path>` | Run FORGE Sentinel quality pipeline against a project |
| `retrofit` | `<project-path>` | Scan, diagnose, reconcile governance, and generate a continuation queue |
| `learn` | `<subcommand>` | Manage the FORGE learning engine (SQLite knowledge base) |
| `schedule` | `<subcommand>` | Manage cron-scheduled recurring tasks (list / add / remove / trigger) |
| `config` | — | Show the resolved FORGE configuration (secret-safe) |

### `build` flags

```
--idea <text>           Raw product idea (generates the PRD)
--prd <path>            Use an existing PRD file instead of generating one
--autonomous-recovery   Enable Autonomous Recovery Mode (Contract 14)
--dry-run               Simulate the build: plan + cost, no execution
--skip-design           Skip Phase 1A+1B and use existing governance docs
```

---

## RETROFIT

Sourced from `src/cli/index.ts` retrofit command wiring and `src/retrofit/` directory listing.

RETROFIT scans an existing codebase, diagnoses structural issues, reconciles governance docs, and
generates a FORGE-compatible continuation queue so an abandoned build can resume autonomously.

```bash
node dist/cli/index.js retrofit <project-path> [options]
```

### RETROFIT Options

```
--scope <scope>         Analysis scope: A (codebase only), B (+ database), C (+ Vercel)  [default: C]
--skip-dynamic          Skip dynamic route testing
--resume                Resume from a prior SCAN checkpoint
--non-interactive       Auto-approve all RECONCILE decisions
--queue-output <path>   Override the QUEUE output directory
--api-key <key>         Anthropic API key for adversarial review
```

### RETROFIT Source Files (`src/retrofit/`)

| File | Purpose |
|---|---|
| `preflight.ts` | 8 pre-flight environment checks before any SCAN |
| `types.ts` | All ScanReport, DiagnoseReport, ReconcileDecision type definitions |
| `scan-ops-1-4.ts` | SCAN ops 1–4: directory tree, dependency graph, broken imports, dead files |
| `scan-ops-5-8.ts` | SCAN ops 5–8: route inventory, env audit, schema extraction, git history |
| `scan-ops-9-14.ts` | SCAN ops 9–14: package audit, governance inventory, tsc check, tests, dynamic routes, Vercel |
| `scan.ts` | SCAN orchestrator: wires all 14 ops, writes `.forge/scan_report.json` |
| `diagnose.ts` | DIAGNOSE: Architecture Health Report + Claude API adversarial review |
| `reconcile.ts` | RECONCILE: hybrid interactive model, SQLite decision persistence |
| `pipeline.ts` | Top-level SCAN → DIAGNOSE → RECONCILE → QUEUE pipeline |
| `index.ts` | `runRetrofitPipeline()` — entry point called by the CLI |

### RETROFIT Pipeline Stages

```
SCAN (14 ops)  →  DIAGNOSE  →  RECONCILE  →  QUEUE
```

1. **SCAN** — reads the project without modifying any file. Runs 14 analysis operations covering code
   structure, dependencies, schemas, environment variables, git history, test coverage, and Vercel
   deployment state.
2. **DIAGNOSE** — produces three reports: Architecture Health, Governance Reconciliation, and
   Enterprise Patterns Gap. Adversarial Claude review runs on every Architecture Health Report.
3. **RECONCILE** — presents BUILD / DEFER / ABANDON choices for every unbuilt item. Persists all
   decisions to the learning database before applying any change.
4. **QUEUE** — emits a tier-ordered YAML prompt queue compatible with `forge build --skip-design`.

---

## Architecture

Phase modules sourced from `src/phases/` directory listing.

| File | Phase | Description |
|---|---|---|
| `phase0-scout.ts` | Phase 0 | Toolchain Scout — environment gate, stack fingerprint, TOOLCHAIN.md |
| `phase1a-prd.ts` | Phase 1A | PRD Generator — feature/table/agent scope from raw idea |
| `phase1b-architect.ts` | Phase 1B | Architecture Engine — database schema, API routes, frontend pages |
| `phase1c-ingest.ts` | Phase 1C | Governance ingestion — existing docs absorbed into the design context |
| `phase2-governance.ts` | Phase 2 | Governance Generator — writes BLUEPRINT, SCHEMA, queue.yaml |
| `phase3-executor.ts` | Phase 3 | Build Executor — runs prompts against Claude, triggers Phase 4 per-prompt |
| `phase4-sentinel.ts` | Phase 4 | Sentinel — 25-check quality gate; Autonomous Recovery on eligible failures |
| `phase5-learner.ts` | Phase 5 | Recursive Learner — scores prompts, updates fix patterns, proposes evolutions |

Full pipeline: `Phase 0 → 1A → 1B → 2 → [3 + 4 per-prompt] → 5`

---

## Learning Engine

Source files sourced from `src/learning/` directory listing.

| File | Purpose |
|---|---|
| `types.ts` | All Learning Engine type definitions, `VALID_TABLES` constant |
| `database.ts` | SQLite init, 14 tables, connection management, machine identity |
| `queries.ts` | 15 read/write query functions (governance rules, fix patterns, prompt scores) |
| `loops.ts` | 5 learning loops (prompt scoring, fix indexing, decision weighting, instinct extraction, self-evolution) |
| `hooks-enhanced.ts` | 24 default hooks, execution engine, hook priority ordering |
| `fingerprint.ts` | Error fingerprinting — produces stable hashes across different files |
| `precompact.ts` | PreCompact hook — saves critical context to SQLite before context compaction |
| `session.ts` | Session orchestration — state serialization, fingerprinting, resumption |
| `session-lifecycle.ts` | SessionStart / SessionEnd lifecycle coordination |
| `handoff-generator.ts` | Generates SESSION_HANDOFF.md between runs |
| `sync.ts` | Cross-machine sync — pull/push between local DB and master copy |
| `integration.ts` | Executor wiring — integrates the learning engine into the build pipeline |

### `forge learn` Subcommands

Sourced from `src/cli/commands/learning.ts`:

| Subcommand | Description |
|---|---|
| `learn init` | Initialize the learning database at `~/.forge/forge_memory.db` |
| `learn status` | Show DB stats: prompts scored, fix patterns, governance rules active, per-table row counts |
| `learn patterns` | List top fix patterns sorted by success rate (with `--limit <n>` option) |
| `learn sync` | Cross-machine sync (bidirectional by default; `--pull` / `--push` to select direction) |

---

## Sentinel Quality Pipeline

Check names sourced from `SentinelCheckName` type in `src/phases/phase4-sentinel.ts` (lines 126–151).

Sentinel runs after **every** Phase 3 prompt. The first five checks are the mandatory Contract-13
suite executed in order; remaining checks are conditional or opt-in.

| Check | Ring | When |
|---|---|---|
| `typescript` | Ring 1 | Every prompt — `pnpm tsc --noEmit`, zero errors required |
| `eslint` | Ring 1 | Every prompt — lint gate |
| `build` | Ring 1 | Every prompt — `pnpm run build`, warnings ok, errors fail |
| `file_integrity` | Ring 1 | Every prompt — immutable governance docs unchanged, no unexpected deletions |
| `schema_drift` | Ring 1 | Every prompt (when schema prompts ran) — additions ok, modifications/deletions fail |
| `dependencies` | Ring 1 | Every prompt — no new dep outside the locked TOOLCHAIN.md manifest |
| `migration_safety` | Ring 1 | When migration files changed |
| `security_scan` | Ring 2 | Every 10th prompt |
| `dead_code` | Ring 2 | Every 10th prompt |
| `six_laws` | Ring 2 | Every 10th prompt |
| `agent_shield` | Ring 2 | Every 10th prompt |
| `live_schema_drift` | Ring 2 | Every 10th prompt |
| `architecture` | Ring 2 | Every 10th prompt |
| `consensus_validation` | Ring 2 | Every 10th prompt |
| `playwright` | Ring 3 | End of run |
| `vitest` | Ring 3 | End of run |
| `semgrep` | Ring 3 | End of run |
| `knip` | Ring 3 | End of run |
| `trivy` | Ring 3 | End of run |
| `gitleaks` | Ring 3 | End of run |
| `lighthouse` | Ring 3 | End of run |
| `visual_regression` | Opt-in | When UI files changed and configured |
| `live_preview` | Opt-in | When UI files changed and configured |
| `accessibility` | Opt-in | When UI files changed and configured |
| `seo` | Opt-in | When UI files changed and configured |

Autonomous Recovery (Contract 14): on a Sentinel failure, if `autonomousRecoveryMode` is enabled and
the error matches a `fix_patterns` row with `success_rate > 0.90`, FORGE auto-applies the fix and
re-runs the prompt (max 2 attempts per prompt before escalating to a human).

---

## Configuration

From `forge_config.json` at the project root:

```json
{
  "version": "2.0",
  "build": {
    "model": "claude-sonnet-4-6",
    "maxRetries": 3,
    "maxPromptsPerRun": 45,
    "parallelism": 1,
    "timeoutMinutes": 15
  },
  "sentinel": {
    "ring1OnEveryPrompt": true,
    "ring2EveryNthPrompt": 10,
    "ring3OnRunEnd": true,
    "eslintConfig": "next/core-web-vitals",
    "coverageThreshold": 60
  },
  "learning": {
    "dbPath": "~/.forge/forge_memory.db",
    "syncEnabled": false,
    "syncMasterPath": null,
    "adversarialReview": true,
    "selfModification": true
  },
  "deploy": {
    "provider": "vercel",
    "canaryEnabled": true,
    "rollbackOnFailure": true,
    "healthCheckPath": "/api/health"
  },
  "providers": {
    "primary": "anthropic",
    "fallback": null,
    "anthropicApiKey": null,
    "openaiApiKey": null
  }
}
```

Environment variables (read at startup by `src/cli/config.ts`):

```
FORGE_SUPABASE_URL          Enable Build Memory (history, patterns, agents)
FORGE_SUPABASE_SERVICE_KEY  Required alongside FORGE_SUPABASE_URL
ANTHROPIC_API_KEY           Required for all build/design/retrofit commands
FORGE_MACHINE_ID            Optional machine identity override (defaults to generated ID)
```

---

## Development

Scripts from `package.json`:

```bash
pnpm run build          # tsc — compile src/ → dist/
pnpm run typecheck      # tsc --noEmit — type-check without emitting
pnpm forge <cmd>        # node dist/cli/index.js <cmd>
pnpm test               # node tests: learning-database, fingerprint, queries, sync
pnpm run test:memory    # node tests: memory integration
```

Runtime requirement (from `package.json` `engines` field): **Node.js >= 20**.

Package manager: **pnpm** (never npm or yarn).
