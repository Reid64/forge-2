# FORGE 2.0 — Health Report

Generated: 2026-07-06T01:23:43.398Z

## Build Memory

- Database: `C:\Users\manag\.forge\forge_memory.db`
- Schema version: `2.1.0`
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
| queue_versions | yes | 0 | — |
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

## Skills directories (.claude/skills/ + skills/)

- .claude/skills/ui-ux-pro-max (SKILL.md present)
- skills/deploy-sequence (SKILL.md present)
- skills/frontend-design (SKILL.md present)
- skills/middleware-role-routing (SKILL.md present)
- skills/no-cache-dashboard-serving (SKILL.md present)
- skills/playwright-gate (SKILL.md present)
- skills/rls-company-scoping (SKILL.md present)
- skills/six-laws-gate (SKILL.md present)
- skills/ui-ux-pro-max (SKILL.md present)

## Prompt library (Session 3 — Autonomy)

- Snapshots (`queue_versions` rows): 0
- Latest: (none yet — run `forge compile`)

## Environment

- ANTHROPIC_API_KEY: present

## Wiring status

| Capability | Status | Detail |
|---|---|---|
| design-system generation | WIRED | src/phases/phase1b-architect.ts calls generateDesignSystem() during Phase 1B. |
| skill injection | WIRED | src/phases/phase3-executor.ts reads queue entry `skills:` via loadSkillContent(). |
| ui skill declarations | WIRED | src/engine/queue-generator.ts declares skills: [frontend-design, ui-ux-pro-max] on every UI-producing entry. |
| design-doc injection | WIRED | src/phases/phase3-executor.ts GOVERNANCE_DOC_NAMES includes DESIGN_SYSTEM.md. |
| brands storage | WIRED | src/phases/phase1b-architect.ts calls createBrand/updateBrand; brand_identities has 0 row(s). |
| learning hooks | WIRED | hook_execution_log has 7 row(s). |
| codebase RAG | WIRED | src/phases/phase3-executor.ts imports CodebaseRag from src/tools/codebase-rag.ts. |
| forge compile | WIRED | src/cli/index.ts registers the `compile` command (src/cli/compile-command.ts). |
| auto-resume | WIRED | src/cli/index.ts declares --auto-resume on `forge build`, wired to src/engine/auto-resume.ts. |
| re-anchor injection | WIRED | src/cli/compile-command.ts injects a re-anchor entry every REANCHOR_INTERVAL (15) real prompts. |
