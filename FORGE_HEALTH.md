# FORGE 2.0 — Health Report

Generated: 2026-07-06T00:19:30.744Z

## Build Memory

- Database: `C:\Users\manag\.forge\forge_memory.db`
- Schema version: `2.0.0`
- Machine ID: `089851cda1351217`

| Table | Exists | Rows | Most recent created_at |
|---|---|---|---|
| build_runs | yes | 0 | — |
| prompt_executions | yes | 0 | — |
| error_patterns | yes | 0 | — |
| resolutions | yes | 0 | — |
| governance_versions | yes | 0 | — |
| self_created_agents | yes | 0 | — |
| cross_project_insights | yes | 0 | — |
| production_telemetry | yes | 0 | — |
| stack_profiles | yes | 0 | — |
| design_patterns | yes | 0 | — |
| brand_identities | yes | 0 | — |
| scheduled_tasks | yes | 0 | — |
| prompt_scores | yes | 0 | — |
| fix_patterns | yes | 0 | — |
| decision_weights | yes | 0 | — |
| governance_rules | yes | 0 | — |
| pending_evolutions | yes | 0 | — |
| build_outcomes | yes | 14 | 2026-06-30T18:32:46.327Z |
| skill_library | yes | 0 | — |
| reconcile_decisions | yes | 0 | — |
| scan_reports | yes | 0 | — |
| hook_execution_log | yes | 7 | 2026-06-30 18:32:46 |
| compact_snapshots | yes | 0 | — |
| build_fingerprints | yes | 0 | — |
| adversary_findings | yes | 0 | — |

## UI/UX Pro Max skill

- search.py: found at `C:\Users\manag\Documents\forge-2\.claude\skills\ui-ux-pro-max\scripts\search.py`
- Python interpreter: responds (`python` → Python 3.14.0)

## Skills directory (.claude/skills/)

- ui-ux-pro-max (SKILL.md present)

## Environment

- ANTHROPIC_API_KEY: present

## Wiring status

| Capability | Status | Detail |
|---|---|---|
| design-system generation | WIRED | src/phases/phase1b-architect.ts calls generateDesignSystem() during Phase 1B. |
| skill injection | WIRED | src/phases/phase3-executor.ts reads queue entry `skills:` via loadSkillContent(). |
| brands storage | NEVER-INVOKED | brand_identities has 0 row(s). |
| learning hooks | WIRED | hook_execution_log has 7 row(s). |
| codebase RAG | WIRED | src/phases/phase3-executor.ts imports CodebaseRag from src/tools/codebase-rag.ts. |
