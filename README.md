# FORGE 2.0 — Factory for Orchestrated Replicable Governed Execution

> **v2.0.0** · TypeScript · Node >=20 · SQLite learning engine · Claude Sonnet 4.6

FORGE 2.0 is a self-learning autonomous software factory CLI. It takes a raw product idea or an
existing codebase and drives it through a governed, quality-gated build pipeline — with zero
human intervention during execution.

---

## What Is FORGE 2.0?

FORGE 2.0 orchestrates the full lifecycle of a software build:

- **Phase 0 — Toolchain Scout:** Scans the target environment; detects framework, database, and
  package manager; installs missing tools; writes a locked `TOOLCHAIN.md` manifest.
- **Phase 1A — PRD Generator:** Converts a raw product idea into a structured Product Requirements
  Document.
- **Phase 1B — Architecture Engine:** Derives tables, routes, components, auth flows, and agents
  from the PRD.
- **Phase 2 — Governance Generator + Queue:** Writes governance docs and a dependency-ordered
  `queue.yaml` of atomic build prompts.
- **Phase 3 — Build Executor:** Executes prompts against the Claude API sequentially, with
  git snapshots before every prompt.
- **Phase 4 — Sentinel:** Runs after every Phase 3 prompt; mandatory checks are `typescript`,
  `eslint`, `build`, `file_integrity`, `schema_drift`, `dependencies`.
- **Phase 5 — Recursive Learner:** Indexes prompt scores, fix patterns, and governance rules into
  the local SQLite learning database after every build.
- **RETROFIT:** Scans, diagnoses, reconciles, and re-queues any existing codebase — the core
  recovery mode for abandoned or broken projects.

---

## Quick Start

Build from source first:

```bash
pnpm install
pnpm build            # tsc → dist/
```

Run the CLI:

```bash
# via npm script (from package.json)
pnpm forge -- build ./my-project --idea "a multi-tenant SaaS for X"

# or directly after build
node dist/cli/index.js build ./my-project --idea "a multi-tenant SaaS for X"
```

---

## CLI Commands

All commands print the FORGE banner and config warnings before executing.

| Command | Description |
|---------|-------------|
| `forge build <path>` | Full autonomous build pipeline: Phase 0 → 1 → 2 → 3 → 4 → 5 |
| `forge scout <path>` | Phase 0 only — scan + lock the environment |
| `forge design <path>` | Phase 0 + 1 only — PRD + Architecture; stops at Gate 2 |
| `forge resume <build-id>` | Resume a halted build from its last checkpoint |
| `forge replay <build-id> --from <n>` | Re-execute a build from prompt index `n` (F12) |
| `forge status [build-id]` | Build status from Build Memory (defaults to most recent) |
| `forge history` | List past builds; filter with `--project <name>` |
| `forge patterns` | Known error patterns and their auto-resolve success rates |
| `forge agents` | Self-created agents and their status |
| `forge resurrect <path>` | Autopsy a failed project and rebuild from the report (skips Phase 1A/1B) |
| `forge estimate <path>` | Cost/time estimate without building (F17) |
| `forge repair <path>` | Diagnose → cluster → queue → execute → verify TypeScript errors |
| `forge retrofit <path>` | SCAN → DIAGNOSE → RECONCILE → QUEUE an existing codebase |
| `forge sentinel <path>` | Run the Sentinel quality pipeline manually |
| `forge schedule list` | Scheduler dashboard: all tasks with next/last run + result |
| `forge schedule add <name>` | Register a recurring cron task in Build Memory |
| `forge schedule remove <name>` | Remove a scheduled task |
| `forge schedule trigger <name>` | Run a scheduled task once now |
| `forge learn init` | Initialize the learning database at `~/.forge/forge_memory.db` |
| `forge learn status` | Learning DB stats: prompts scored, fix patterns, active rules |
| `forge config` | Show the resolved FORGE configuration (secret-safe) |

### `forge build` flags

| Flag | Default | Description |
|------|---------|-------------|
| `--idea <text>` | — | Raw product idea — generates the PRD |
| `--prd <path>` | — | Use an existing PRD file instead |
| `--autonomous-recovery` | false | Enable Autonomous Recovery Mode (Contract 14) |
| `--dry-run` | false | Simulate the build — plan + cost only, no execution |
| `--skip-design` | false | Skip Phase 1A+1B and use existing governance docs |

---

## RETROFIT

`forge retrofit <project-path>` runs the four-phase recovery pipeline against an existing codebase:

**SCAN (14 operations):** directory tree, dependency graph, broken imports, dead files, route
inventory, env-var audit, database schema extraction, git history analysis, package audit,
governance inventory, TypeScript compilation check, existing test execution, dynamic route
testing (GET-only), Vercel deployment analysis.

**DIAGNOSE (3 reports):** Architecture Health Report (with adversarial Claude review),
Governance Reconciliation Report, Enterprise Patterns Gap Report.

**RECONCILE:** Presents BUILD / DEFER / ABANDON decisions; persists every choice to SQLite.

**QUEUE:** Emits a tier-ordered `queue.yaml` compatible with `forge build`.

### Retrofit source files (`src/retrofit/`)

| File | Purpose |
|------|---------|
| `preflight.ts` | 8 pre-flight environment checks |
| `scan-ops-1-4.ts` | Directory tree, dependency graph, broken imports, dead files |
| `scan-ops-5-8.ts` | Route inventory, env audit, schema extraction, git history |
| `scan-ops-9-14.ts` | Package audit, governance inventory, TSC check, tests, dynamic routes, Vercel |
| `scan.ts` | Orchestrates all 14 scan ops; writes `.forge/scan_report.json` |
| `diagnose.ts` | Produces all 3 diagnostic reports |
| `reconcile.ts` | Interactive RECONCILE engine + `generateRetrofitQueue` |
| `pipeline.ts` | End-to-end SCAN → DIAGNOSE → RECONCILE → QUEUE orchestrator |
| `types.ts` | `ScanReport` and all sub-types |
| `index.ts` | Public exports + `RETROFIT_VERSION = '2.0.0'` |

### Retrofit options

| Option | Default | Description |
|--------|---------|-------------|
| `--scope <A\|B\|C>` | `C` | A = codebase only, B = + database, C = + Vercel |
| `--skip-dynamic` | false | Skip dynamic route testing |
| `--resume` | false | Resume from a prior SCAN checkpoint |
| `--non-interactive` | false | Auto-approve all RECONCILE decisions |
| `--queue-output <path>` | — | Override the QUEUE output directory |
| `--api-key <key>` | — | Anthropic API key for adversarial review |

---

## Architecture

The build pipeline is split into discrete phase modules under `src/phases/`:

| File | Phase |
|------|-------|
| `phase0-scout.ts` | Toolchain Scout — environment pre-flight + TOOLCHAIN.md |
| `phase1a-prd.ts` | PRD Generator — idea → structured PRD |
| `phase1b-architect.ts` | Architecture Engine — PRD → tables, routes, components |
| `phase1c-ingest.ts` | Ingest — existing project context injection |
| `phase2-governance.ts` | Governance Generator — writes governance docs |
| `phase3-executor.ts` | Build Executor — executes queue.yaml prompt-by-prompt |
| `phase4-sentinel.ts` | Sentinel — post-prompt health gate |
| `phase5-learner.ts` | Recursive Learner — indexes outcomes into SQLite |

Additional engine modules under `src/engine/`:

- `claude-runner.ts` — Claude API client (injectable for tests)
- `git-manager.ts` — Git snapshot, checkpoint tags, diff extraction
- `queue-generator.ts` — Topological sort + YAML emission
- `prompt-assembler.ts` — Injects governance context into prompts
- `governance-gate.ts` — Six-Laws verifier
- `failure-predictor.ts` — Predicts which prompts will need retries
- `hook-manager.ts` — Lifecycle hook execution (PreToolUse / PostToolUse)
- `model-router.ts` / `provider-router.ts` — Multi-model routing

---

## Learning Engine

The learning engine (`src/learning/`) stores prompt outcomes, error fingerprints, fix patterns,
and governance rules in a local SQLite database at `~/.forge/forge_memory.db`.

| File | Purpose |
|------|---------|
| `database.ts` | Schema init (14 tables), connection management, machine identity |
| `queries.ts` | Read/write query functions for all 14 tables |
| `loops.ts` | 5 learning loops (prompt scoring, fix indexing, decision weighting, …) |
| `hooks-enhanced.ts` | 24 default lifecycle hooks; hook execution engine |
| `sync.ts` | Cross-machine sync (append-only pull/push to a master copy) |
| `session.ts` | Session serialization, fingerprinting, crash recovery, handoff docs |
| `session-lifecycle.ts` | SessionStart / SessionEnd orchestration |
| `handoff-generator.ts` | Generates `SESSION_HANDOFF.md` at run end |
| `integration.ts` | Wires the learning engine into the Phase 3 executor |
| `fingerprint.ts` | Error fingerprinting — normalizes messages for dedup |
| `precompact.ts` | PreCompact hook — saves state before Claude context compaction |

Initialize with:

```bash
forge learn init
forge learn status
```

---

## Sentinel Quality Pipeline

Phase 4 Sentinel (`src/phases/phase4-sentinel.ts`) runs after every Phase 3 prompt.
The mandatory Contract-13 checks always run in this order:

1. `typescript` — `pnpm tsc --noEmit` (zero errors required)
2. `eslint` — ESLint with `next/core-web-vitals` config
3. `build` — `pnpm run build` (warnings OK; errors FAIL)
4. `file_integrity` — Immutable governance docs must not change; no unexpected deletions
5. `schema_drift` — Schema vs SCHEMA_REGISTRY.md (only when schema prompts have run)
6. `dependencies` — New packages not in TOOLCHAIN.md baseline FAIL

Additional opt-in checks (triggered by configuration or file type):

`security_scan`, `visual_regression`, `live_preview`, `accessibility`, `seo`,
`architecture`, `consensus_validation`, `agent_shield`, `live_schema_drift`, `dead_code`,
`six_laws`, `playwright`, `vitest`, `semgrep`, `knip`, `trivy`, `gitleaks`, `lighthouse`

Ring trigger schedule (from `forge_config.json`):

- **Ring 1** — `typescript`, `eslint`, `build`, `file_integrity` — every prompt
- **Ring 2** — extended checks — every 10th prompt
- **Ring 3** — full suite including security + accessibility — end of run

---

## Configuration

`forge_config.json` at the project root (actual content):

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

Environment variables (set in `.env`):

- `FORGE_SUPABASE_URL` + `FORGE_SUPABASE_SERVICE_KEY` — enable Build Memory (Supabase)
- `ANTHROPIC_API_KEY` — required for all build / design / retrofit / sentinel commands
- `FORGE_MACHINE_ID` — per-machine identity for multi-machine coordination

---

## Development

Scripts from `package.json`:

| Script | Command |
|--------|---------|
| `pnpm build` | `tsc` — compile TypeScript to `dist/` |
| `pnpm typecheck` | `tsc --noEmit` — type-check only |
| `pnpm forge` | `node dist/cli/index.js` — run the built CLI |
| `pnpm test` | Run learning engine unit tests via Node test runner |
| `pnpm test:memory` | Run Build Memory integration tests |

Key runtime dependencies: `commander`, `chalk`, `ora`, `better-sqlite3`, `js-yaml`, `zod`,
`playwright`, `pino`, `crawlee`, `@supabase/supabase-js`.

Current build progress: [`STATE_OF_THE_BUILD.md`](./STATE_OF_THE_BUILD.md).
