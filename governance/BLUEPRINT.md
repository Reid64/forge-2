# FORGE 2.0 — BLUEPRINT

## System Identity
- **Name:** FORGE 2.0 (Factory for Orchestrated Replicable Governed Execution)
- **Purpose:** Self-learning, self-evolving autonomous software factory
- **Repository:** Reid64/forge-2
- **Primary Stack:** Node.js, TypeScript (strict), Self-hosted Supabase (Docker), PowerShell (Windows)
- **Package Manager:** pnpm
- **Runtime:** Node.js 20+
- **Port:** 3333 (FORGE CLI/dashboard if applicable)

## Architecture Overview
FORGE 2.0 is a Node.js CLI application that orchestrates autonomous software builds via Claude Code CLI. It is NOT a web application. It is a command-line tool with a persistent Supabase database backend (self-hosted via Docker).

### Core Components
1. **forge-cli** — Main entry point. Parses commands, orchestrates phases.
2. **build-memory** — Supabase client wrapper for all database read/write operations.
3. **phase-0-scout** — Environment scanner, stack detector, toolchain locker.
4. **phase-1a-prd** — PRD generator from raw idea input.
5. **phase-1b-architect** — Architecture engine producing complete design artifacts.
6. **phase-1c-ingest** — Codebase reader for partial builds. Produces constraint manifest.
7. **phase-2-governance** — Converts design artifacts into governance documents + queue.yaml.
8. **phase-3-executor** — Enhanced prompt queue processor with context injection, failure prediction, dynamic rewriting, parallel execution.
9. **phase-4-sentinel** — Mid-build health checker (tsc, build, file integrity, schema drift).
10. **phase-5-learner** — Post-build analyzer, pattern extractor, template evolver, agent creator.
11. **monitoring-agent** — Lightweight telemetry agent deployed with built applications.
12. **browser-agent** — Playwright-based browser automation for web tasks.

### Project Structure
```
forge-2/
├── src/
│   ├── cli/
│   │   ├── index.ts              # CLI entry point
│   │   ├── commands/             # forge build, forge scout, forge replay, etc.
│   │   └── config.ts             # Global configuration
│   ├── memory/
│   │   ├── client.ts             # Supabase client wrapper
│   │   ├── builds.ts             # build_runs CRUD
│   │   ├── errors.ts             # error_patterns CRUD
│   │   ├── prompts.ts            # prompt_executions CRUD
│   │   ├── governance.ts         # governance_versions CRUD
│   │   ├── agents.ts             # self_created_agents CRUD
│   │   ├── insights.ts           # cross_project_insights CRUD
│   │   └── telemetry.ts          # production_telemetry CRUD
│   ├── phases/
│   │   ├── phase0-scout.ts       # Toolchain Scout
│   │   ├── phase1a-prd.ts        # PRD Generator
│   │   ├── phase1b-architect.ts  # Architecture Engine
│   │   ├── phase1c-ingest.ts     # Current State Ingestion
│   │   ├── phase2-governance.ts  # Governance Generator
│   │   ├── phase3-executor.ts    # Build Executor
│   │   ├── phase4-sentinel.ts    # Sentinel Monitor
│   │   └── phase5-learner.ts     # Recursive Learner
│   ├── engine/
│   │   ├── claude-runner.ts      # Claude Code CLI wrapper
│   │   ├── prompt-assembler.ts   # Context injection + prompt assembly
│   │   ├── prompt-rewriter.ts    # Dynamic prompt rewriting
│   │   ├── failure-predictor.ts  # Failure probability estimation
│   │   ├── parallel-scheduler.ts # Dependency analysis + parallel execution
│   │   └── git-manager.ts        # Branch automation, checkpoints, merges
│   ├── analysis/
│   │   ├── pattern-extractor.ts  # Extract error/success/timing patterns
│   │   ├── template-evolver.ts   # Propose governance template changes
│   │   ├── agent-creator.ts      # Design + generate new agents
│   │   ├── cost-estimator.ts     # Token/dollar cost prediction
│   │   └── six-laws-verifier.ts  # Automated Six Laws checks
│   ├── tools/
│   │   ├── codebase-reader.ts    # Read existing project structure
│   │   ├── schema-extractor.ts   # Extract DB schema from migrations/Supabase
│   │   ├── stack-detector.ts     # Identify project tech stack
│   │   ├── env-auditor.ts        # Verify environment variables
│   │   └── browser-agent.ts      # Playwright browser automation
│   ├── monitoring/
│   │   ├── deploy-agent.ts       # Generates monitoring snippet for built apps
│   │   └── telemetry-receiver.ts # Receives production data
│   └── types/
│       ├── index.ts              # All TypeScript interfaces
│       ├── build.ts              # Build-related types
│       ├── governance.ts         # Governance document types
│       └── patterns.ts           # Pattern/learning types
├── templates/
│   ├── governance/               # Governance document templates
│   │   ├── BLUEPRINT.template.md
│   │   ├── SCHEMA_REGISTRY.template.md
│   │   ├── AGENTS.template.md
│   │   ├── BEHAVIORAL_CONTRACTS.template.md
│   │   └── PRD.template.md
│   ├── prompts/                  # Prompt templates for Phase 3
│   │   ├── schema-creation.txt
│   │   ├── auth-setup.txt
│   │   ├── api-routes.txt
│   │   ├── ui-layout.txt
│   │   └── feature-page.txt
│   └── stack-profiles/           # Stack profile definitions
│       ├── nextjs-supabase.yaml
│       └── custom.yaml
├── migrations/
│   ├── 001_build_runs.sql
│   ├── 002_error_patterns.sql
│   ├── 003_prompt_executions.sql
│   ├── 004_governance_versions.sql
│   ├── 005_self_created_agents.sql
│   ├── 006_cross_project_insights.sql
│   ├── 007_production_telemetry.sql
│   └── 008_seed_error_patterns.sql
├── tests/
│   ├── memory.test.ts
│   ├── scout.test.ts
│   ├── executor.test.ts
│   ├── sentinel.test.ts
│   └── learner.test.ts
├── docker/
│   └── docker-compose.yml        # Self-hosted Supabase
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## Technology Decisions
- **No web framework.** FORGE is a CLI tool, not a web app.
- **Supabase JS client v2** for all database operations.
- **js-yaml** for queue.yaml parsing.
- **Playwright** for browser automation agent and Six Laws verification.
- **chalk + ora** for CLI output formatting.
- **commander** for CLI argument parsing.
- **glob** for file system scanning.
- **crypto** for content hashing (governance drift detection).
- **child_process** for Claude Code CLI execution.

## Environment Variables
```
FORGE_SUPABASE_URL=http://localhost:54321
FORGE_SUPABASE_ANON_KEY=<from docker-compose>
FORGE_SUPABASE_SERVICE_KEY=<from docker-compose>
ANTHROPIC_API_KEY=<existing key>
FORGE_MACHINE_ID=<auto-generated UUID per machine>
FORGE_DATA_DIR=<path to project archives, default: D:\forge-data>
FORGE_BACKUP_DIR=<path to backup drive, default: E:\forge-backups>
```

## Canonical Rules (FORGE 2.0 Specific)
1. FORGE NEVER executes a build without completing Phases 0, 1, and 2 first.
2. FORGE NEVER modifies governance documents during Phase 3 execution.
3. FORGE NEVER auto-deploys self-created agents without human approval.
4. FORGE NEVER proceeds past a failed Sentinel check without resolution.
5. All Build Memory writes include machine_id for multi-machine coordination.
6. All governance templates are version-controlled in Build Memory with content hashes.
7. Phase 3 prompts are assembled dynamically — never hardcoded.
8. Every git operation uses feature branches. Main never receives direct commits during builds.
9. STATE_OF_THE_BUILD.md and SESSION_STATE.md updated from actual codebase audit after every prompt — not assumptions.
10. Token consumption logged per-prompt for cost tracking.
