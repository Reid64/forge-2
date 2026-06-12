# FORGE 2.0

**Factory for Orchestrated Replicable Governed Execution**

A self-learning, self-evolving autonomous software factory. FORGE 2.0 is a
Node.js CLI tool that transforms raw product ideas into fully deployed,
production-ready applications through governed autonomous building via the
Claude Code CLI. It is **not** a web application.

## Stack

- **Runtime:** Node.js 20+ (ESM)
- **Language:** TypeScript (strict mode)
- **Package manager:** pnpm
- **Build Memory:** Self-hosted Supabase (PostgreSQL) via Docker
- **Browser automation / verification:** Playwright
- **CLI:** commander + chalk + ora

## Project Structure

```
forge-2/
├── src/
│   ├── cli/         # CLI entry point + commands
│   ├── memory/      # Supabase Build Memory client + CRUD modules
│   ├── phases/      # Phase 0–5 orchestrators
│   ├── engine/      # Claude runner, prompt assembly, git, scheduling
│   ├── analysis/    # Pattern extraction, template evolution, agents
│   ├── tools/       # Stack/env/codebase/schema readers, browser agent
│   ├── monitoring/  # Deploy telemetry agent + receiver
│   └── types/       # Shared TypeScript interfaces
├── templates/       # Governance / prompt / stack-profile templates
├── migrations/      # SQL migrations for Build Memory tables
├── tests/           # Node test runner + Playwright tests
└── docker/          # Self-hosted Supabase docker-compose
```

## Setup

```powershell
pnpm install
Copy-Item .env.example .env   # then fill in real values
pnpm build
```

## Environment

See `.env.example` for the full list. Key variables:

- `FORGE_SUPABASE_URL`, `FORGE_SUPABASE_SERVICE_KEY` — Build Memory backend
- `ANTHROPIC_API_KEY` — Claude API for Phase 1A/1B and agent generation
- `FORGE_MACHINE_ID` — per-machine identity for multi-machine coordination

## Build Status

This repository is built autonomously by FORGE 1.0 from the governance package
in `governance/`. Current progress is tracked in
[`STATE_OF_THE_BUILD.md`](./STATE_OF_THE_BUILD.md).
