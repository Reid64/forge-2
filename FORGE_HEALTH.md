# FORGE 2.0 — Health Report

Generated: 2026-07-07T02:21:47.376Z

## Build Memory

- Database: `C:\Users\manag\.forge\forge_memory.db`
- Schema version: `2.2.1`
- Machine ID: `089851cda1351217`

| Table | Exists | Rows | Most recent created_at |
|---|---|---|---|
| build_runs | yes | 13 | 2026-07-06 22:59:38 |
| prompt_executions | yes | 43 | 2026-07-06 23:19:16 |
| error_patterns | yes | 15 | 2026-07-07T02:02:12.363Z |
| resolutions | yes | 1 | 2026-07-07T02:02:12.663Z |
| governance_versions | yes | 31 | 2026-07-06T23:19:54.245Z |
| self_created_agents | yes | 1 | 2026-07-06T18:23:50.675Z |
| cross_project_insights | yes | 18 | 2026-07-07T02:02:21.382Z |
| production_telemetry | yes | 18 | 2026-07-06T22:59:38.390Z |
| stack_profiles | yes | 0 | — |
| design_patterns | yes | 0 | — |
| brand_identities | yes | 1 | 2026-07-06T02:31:21.944Z |
| scheduled_tasks | yes | 0 | — |
| queue_versions | yes | 0 | — |
| prompt_scores | yes | 112 | 2026-07-07T02:02:39.182Z |
| fix_patterns | yes | 16 | 2026-07-07T02:02:12.365Z |
| decision_weights | yes | 0 | — |
| governance_rules | yes | 1 | 2026-07-07T02:02:21.364Z |
| pending_evolutions | yes | 18 | 2026-07-07T02:02:39.412Z |
| build_outcomes | yes | 77 | 2026-07-07T02:02:39.226Z |
| skill_library | yes | 0 | — |
| reconcile_decisions | yes | 0 | — |
| scan_reports | yes | 0 | — |
| hook_execution_log | yes | 44 | 2026-07-07 02:02:39 |
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

## Learning (Session 4 — Intelligence & Observability)

| Table | Rows | Last write |
|---|---|---|
| error_patterns | 15 | 2026-07-07T02:02:12.363Z |
| fix_patterns | 16 | 2026-07-07T02:02:12.365Z |
| governance_rules | 1 | 2026-07-07T02:02:21.364Z |
| cross_project_insights | 18 | 2026-07-07T02:02:21.382Z |
| prompt_scores | 112 | 2026-07-07T02:02:39.182Z |

## Environment

- ANTHROPIC_API_KEY: present

## Wiring status

| Capability | Status | Detail |
|---|---|---|
| design-system generation | WIRED | src/phases/phase1b-architect.ts calls generateDesignSystem() during Phase 1B. |
| skill injection | WIRED | src/phases/phase3-executor.ts reads queue entry `skills:` via loadSkillContent(). |
| ui skill declarations | WIRED | src/engine/queue-generator.ts declares skills: [frontend-design, ui-ux-pro-max] on every UI-producing entry. |
| design-doc injection | WIRED | src/phases/phase3-executor.ts GOVERNANCE_DOC_NAMES includes DESIGN_SYSTEM.md. |
| brands storage | WIRED | src/phases/phase1b-architect.ts calls createBrand/updateBrand; brand_identities has 1 row(s). |
| learning hooks | WIRED | hook_execution_log has 44 row(s). |
| codebase RAG | WIRED | src/phases/phase3-executor.ts imports CodebaseRag from src/tools/codebase-rag.ts. |
| forge compile | WIRED | src/cli/index.ts registers the `compile` command (src/cli/compile-command.ts). |
| auto-resume | WIRED | src/cli/index.ts declares --auto-resume on `forge build`, wired to src/engine/auto-resume.ts. |
| re-anchor injection | WIRED | src/cli/compile-command.ts injects a re-anchor entry every REANCHOR_INTERVAL (15) real prompts. |
| error-pattern writes | WIRED | src/phases/phase3-executor.ts calls recordFailureObserved/recordRecoveryOutcome (src/engine/learning-writeback.ts) on every Sentinel failure/recovery. |
| auto-elevation | WIRED | src/engine/learning-writeback.ts calls checkAutoElevation (src/learning/loops.ts) after every recovery outcome. |
| build brain | WIRED | src/phases/phase3-executor.ts calls analyzeSentinelFailure (src/engine/build-brain.ts) on every Sentinel failure. |
| live status | WIRED | src/phases/phase3-executor.ts writes .forge/live-status.json (src/tools/live-status.ts) at every prompt lifecycle point. |
| design-model pinning | WIRED | src/engine/provider-router.ts pins DEFAULT_ROUTES.complex_reasoning to ['anthropic'] only (Phase 1A/1B/adversarial review never route to a non-Claude provider). |
| death forensics | WIRED | src/phases/phase3-executor.ts installs process-death handlers (src/tools/death-forensics.ts) and checks for a stale forge_running.lock at startup. |
| git-init on greenfield | WIRED | src/phases/phase0-scout.ts runs git init + an initial commit when the target project has no .git (Contract 10/11/12 never silently no-op on a greenfield project). |
| spawn-cwd pinning (Windows shim resolution) | WIRED | src/engine/claude-runner.ts resolves the real claude.exe directly on Windows and never combines shell:true with detached:true (Session 5.2 — that combination silently broke every claude invocation). |
| file-delta law | WIRED | src/phases/phase4-sentinel.ts FAILs a non-exempt prompt with zero file-count delta ("no work product"); src/phases/phase3-executor.ts snapshots the before-count on every prompt (Session 5.2). |
