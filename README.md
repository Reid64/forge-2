# FORGE 2.0 -- Factory for Orchestrated Replicable Governed Execution

**Version:** 2.0.0  
**Package:** forge-2  
**Description:** A self-learning autonomous software factory CLI.

---

## What Is FORGE 2.0?

FORGE 2.0 is an autonomous software factory — a CLI that builds production-grade applications from governance documents and prompt queues with zero human intervention during execution. It manages a six-phase pipeline from environment scouting through code generation, quality enforcement, deployment, and recursive learning.

FORGE records every error fingerprint, fix pattern, and architectural decision in a local SQLite learning database (`~/.forge/forge_memory.db`). Each build makes the next build cheaper and more reliable.

---

## Three Build Modes

### Mode 1: Greenfield (`forge build --idea`)

Start from a raw product idea. FORGE runs the full pipeline:

1. **Phase 0 — Scout:** Detects the tech stack, package manager, and framework. Installs missing toolchain. Blocks on unresolvable environment issues.
2. **Phase 1A — PRD Generator:** Converts the idea into a structured product requirements document.
3. **Phase 1B — Architecture Engine:** Produces database schema, API routes, frontend pages, and auth flows from the PRD.
4. **Phase 2 — Governance Generator:** Writes governance documents and generates `queue.yaml`.
5. **Phase 3 — Build Executor:** Executes each queued prompt via Claude, with per-prompt Sentinel quality checks (Phase 4 runs inline).
6. **Phase 5 — Recursive Learner:** Scores every prompt, indexes fix patterns, and proposes self-modification evolutions.

```
forge build ./my-project --idea "A multi-tenant SaaS CRM with Stripe billing"
```

### Mode 2: RETROFIT (`forge retrofit`)

Scan an existing codebase that was abandoned mid-build or drifted from governance. FORGE runs four pipeline stages:

1. **SCAN** — 14 analysis operations: directory tree, dependency graph, broken imports, dead files, route inventory, env audit, schema extraction, git history, package audit, governance inventory, TypeScript check, test execution, dynamic route testing, Vercel analysis.
2. **DIAGNOSE** — Architecture Health Report with adversarial Claude review, Governance Reconciliation Report, Enterprise Patterns Gap Report.
3. **RECONCILE** — Presents each gap as BUILD / DEFER / ABANDON; persists decisions to the learning database.
4. **QUEUE** — Generates a tier-ordered `queue.yaml` for autonomous continuation.

```
forge retrofit ./my-project --scope C
```

Scopes: `A` (codebase only), `B` (+ database), `C` (+ Vercel deployment).

### Mode 3: PRD Import (`forge build --prd` or `forge sequence`)

When you already have a PRD or a directory of spec documents:

```
forge build ./my-project --prd ./PRD.md
forge sequence ./specs/ ./my-project
```

`forge sequence` handles enterprise builds (40+ documents): it loads all spec files, creates a dependency-ordered sequence plan, and runs the Composer once per document in order.

---

## Quick Start

```bash
# Install dependencies
pnpm install

# Build the TypeScript CLI
pnpm build

# Initialize the learning database
node dist/cli/index.js learn init

# Run a greenfield build (dry-run first to see the plan and cost)
node dist/cli/index.js build ./my-project --idea "your idea" --dry-run

# Run for real
node dist/cli/index.js build ./my-project --idea "your idea"
```

Configure FORGE in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
FORGE_SUPABASE_URL=https://...
FORGE_SUPABASE_SERVICE_KEY=...
```

---

## CLI Commands

All commands are available as `node dist/cli/index.js <command>` or as `forge <command>` after `pnpm link`.

### Build Pipeline

| Command | Description |
|---------|-------------|
| `build <path>` | Full pipeline: Phase 0 -> 1 -> 2 -> 3 -> 4 -> 5 |
| `scout <path>` | Phase 0 only -- scan and lock the environment |
| `design <path>` | Phase 0 + 1 -- PRD + Architecture, stops at Gate 2 |
| `resume <build-id>` | Resume a halted build from its last checkpoint |
| `replay <build-id> --from <n>` | Replay from a specific checkpoint (1-based prompt index) |

**`build` options:**

| Option | Description |
|--------|-------------|
| `--idea <text>` | Raw product idea -- generates the PRD |
| `--prd <path>` | Use an existing PRD file instead |
| `--autonomous-recovery` | Enable Autonomous Recovery Mode (Contract 14) |
| `--dry-run` | Simulate: plan + cost only, no execution |
| `--skip-design` | Skip Phase 1A+1B and use existing governance docs |

### Observation

| Command | Description |
|---------|-------------|
| `status [build-id]` | Build status from Build Memory (defaults to most recent) |
| `history` | List past builds (`--project <name>` to filter) |
| `patterns` | Known error patterns and success rates |
| `agents` | Self-created agents and their status |
| `config` | Show the resolved FORGE configuration |

### Specialist Commands

| Command | Description |
|---------|-------------|
| `estimate <path>` | Cost/time estimate without building |
| `resurrect <path>` | Autopsy a failed project and rebuild from the report |
| `repair <path>` | Diagnose -> cluster -> queue -> execute -> verify TypeScript repairs |
| `retrofit <path>` | SCAN -> DIAGNOSE -> RECONCILE -> QUEUE an existing codebase |
| `sentinel <path>` | Run the Sentinel quality pipeline (Ring 1/2/3 or all) |
| `compose <path>` | Compose a FORGE queue from governance documents |
| `sequence <specs-dir> <path>` | Process multiple spec docs in dependency order |
| `deploy <path>` | Deploy and inject post-deploy monitoring snippet |

**`retrofit` options:**

| Option | Description |
|--------|-------------|
| `--scope <A\|B\|C>` | Analysis scope (default `C`) |
| `--skip-dynamic` | Skip dynamic route testing |
| `--resume` | Resume from a prior SCAN checkpoint |
| `--non-interactive` | Auto-approve all RECONCILE decisions |
| `--queue-output <path>` | Override the QUEUE output directory |
| `--api-key <key>` | Anthropic API key for adversarial review |

**`repair` options:**

| Option | Description |
|--------|-------------|
| `--generate-only` | Write the repair queue but skip Phase 3 execution |
| `--autonomous-recovery` | Enable Autonomous Recovery Mode during repairs |
| `--max-clusters <n>` | Cap the number of repair prompt clusters (default 20) |
| `--queue-path <path>` | Custom path to write `repair-queue.yaml` |

### Scheduled Tasks

```
forge schedule list [--json]
forge schedule add <name> --type <type> --cron "<expr>"
forge schedule remove <name>
forge schedule trigger <name>
```

Valid task types: `research_agent`, `memory_cleanup`, `log_rotation`, `health_check`, `deadline_scan`, `quota_reset`.

---

## Composer Engine

The Composer (`forge compose`, `forge sequence`) transforms governance documents into dependency-ordered, atomic execution queues.

**Source files in `src/composer/`:**

| File | Purpose |
|------|---------|
| `index.ts` | Composer entry point -- orchestrates all stages |
| `task-extractor.ts` | Extracts build tasks from governance docs via Claude |
| `gap-detector.ts` | Detects governance gaps and missing features |
| `prompt-assembler.ts` | Assembles the 7-section prompt format per task |
| `queue-writer.ts` | Writes `queue-run*.yaml` files |
| `document-sequencer.ts` | Orders multiple spec documents by dependency |
| `recomposer.ts` | Recomposes a queue after human review or mid-run halt |
| `adversary-tracker.ts` | Tracks adversarial review findings for resolution |

**`compose` options:**

| Option | Description |
|--------|-------------|
| `--mode <GREENFIELD\|RETROFIT>` | Build mode (default `GREENFIELD`) |
| `--api-key <key>` | Anthropic API key |
| `--non-interactive` | Auto-proceed despite blockers |
| `--prompts-per-run <n>` | Max prompts per queue file (default 45) |
| `--output <path>` | Output directory for queue files |

**`sequence` options:**

| Option | Description |
|--------|-------------|
| `--api-key <key>` | Anthropic API key |
| `--non-interactive` | Auto-proceed despite warnings |
| `--dry-run` | Show the sequence plan without generating queues |

---

## Learning Engine

The Learning Engine (`src/learning/`) is a local SQLite knowledge base at `~/.forge/forge_memory.db`. Every build feeds it; every future build queries it.

**Source files:**

| File | Purpose |
|------|---------|
| `database.ts` | SQLite init, 14 tables, connection management, machine identity |
| `queries.ts` | Read/write query functions |
| `loops.ts` | 5 learning loops (prompt scoring, fix patterns, decision weighting, skill extraction, evolution proposals) |
| `hooks-enhanced.ts` | 24 default hooks, hook execution engine |
| `sync.ts` | Cross-machine sync (pull/push to master drive) |
| `session.ts` | Session state serialization and resumption |
| `session-lifecycle.ts` | SessionStart/SessionEnd lifecycle |
| `session-hooks.ts` | Hook bindings for session events |
| `fingerprint.ts` | Error fingerprinting (generalized, machine-agnostic) |
| `integration.ts` | Wiring between executor and learning engine |
| `handoff-generator.ts` | Generates SESSION_HANDOFF.md between runs |
| `precompact.ts` | PreCompact hook -- saves context before Claude compaction |
| `types.ts` | All Learning Engine type definitions |

**`learn` subcommands:**

| Command | Description |
|---------|-------------|
| `learn init` | Initialize `~/.forge/forge_memory.db` |
| `learn status` | DB stats: prompts scored, fix patterns, active rules |
| `learn patterns [--limit n]` | Top fix patterns by success rate |
| `learn sync [--pull\|--push]` | Cross-machine sync to/from master drive |
| `learn evolutions` | Pending self-modification proposals |
| `learn rules` | Active governance rules from the learning engine |

---

## Architecture

The build pipeline is implemented as a sequence of phase modules in `src/phases/`:

| File | Phase | Purpose |
|------|-------|---------|
| `phase0-scout.ts` | Phase 0 | Toolchain Scout -- environment detection, auto-install, stack fingerprint |
| `phase1a-prd.ts` | Phase 1A | PRD Generator -- converts idea to structured requirements |
| `phase1b-architect.ts` | Phase 1B | Architecture Engine -- database, API, frontend, auth design |
| `phase1c-ingest.ts` | Phase 1C | Document ingestion for PRD-import mode |
| `phase2-governance.ts` | Phase 2 | Governance Generator + queue.yaml generation |
| `phase3-executor.ts` | Phase 3 | Build Executor -- runs each queued prompt via Claude |
| `phase4-sentinel.ts` | Phase 4 | Sentinel quality pipeline (Ring 1/2/3) |
| `phase5-learner.ts` | Phase 5 | Recursive Learner -- scores, indexes, proposes evolutions |
| `phase-chain.ts` | -- | Phase chain utilities |

The RETROFIT pipeline lives in `src/retrofit/` (scan-ops-1-4.ts, scan-ops-5-8.ts, scan-ops-9-14.ts, scan.ts, diagnose.ts, reconcile.ts, pipeline.ts, preflight.ts, types.ts, index.ts).

Additional support in `src/tools/`, `src/engine/`, `src/analysis/`, and `src/memory/` provides stack detection, security scanning, cost estimation, dead code scanning, accessibility auditing, git management, model routing, governance enforcement, and Build Memory (Supabase).

---

## Configuration

`forge_config.json` at the project root controls FORGE's behavior:

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

Environment variables (`.env`):

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Required for Claude prompt execution |
| `FORGE_SUPABASE_URL` | Build Memory (optional -- stateless mode if absent) |
| `FORGE_SUPABASE_SERVICE_KEY` | Build Memory service role key |

Run `forge config` to see the resolved configuration with all secrets masked.

---

## Development

```bash
# Install dependencies
pnpm install

# Type check
pnpm typecheck

# Build TypeScript to dist/
pnpm build

# Run tests
pnpm test
```

**Tech stack:**

| Technology | Version | Purpose |
|-----------|---------|---------|
| Node.js | >=20 | Runtime |
| TypeScript | ^5.7.2 | Language (strict mode) |
| commander | ^12.1.0 | CLI framework |
| chalk | ^5.4.1 | Terminal color output |
| ora | ^8.1.1 | Spinner animations |
| better-sqlite3 | ^9.6.0 | Local learning database |
| @supabase/supabase-js | ^2.47.10 | Build Memory (remote) |
| js-yaml | ^4.1.0 | Queue file parsing |
| playwright | ^1.49.1 | Browser automation (Sentinel Ring 3) |
| zod | ^3.23.8 | Schema validation |
