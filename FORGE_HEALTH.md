# FORGE 2.0 — Health Report

Generated: 2026-07-16T15:59:26.663Z

## Build Memory

- Database: `C:\Users\manag\.forge\forge_memory.db`
- Schema version: `2.3.0`
- Machine ID: `089851cda1351217`

| Table | Exists | Rows | Most recent created_at |
|---|---|---|---|
| build_runs | yes | 37 | 2026-07-16 15:56:17 |
| prompt_executions | yes | 79 | 2026-07-16 15:56:19 |
| error_patterns | yes | 43 | 2026-07-16T15:56:04.593Z |
| resolutions | yes | 10 | 2026-07-09T02:27:51.596Z |
| governance_versions | yes | 63 | 2026-07-16T15:56:17.652Z |
| self_created_agents | yes | 1 | 2026-07-06T18:23:50.675Z |
| cross_project_insights | yes | 33 | 2026-07-09T05:42:18.703Z |
| production_telemetry | yes | 56 | 2026-07-16T15:56:07.416Z |
| stack_profiles | yes | 0 | — |
| design_patterns | yes | 0 | — |
| brand_identities | yes | 3 | 2026-07-16T15:28:45.545Z |
| scheduled_tasks | yes | 0 | — |
| queue_versions | yes | 0 | — |
| gap_audit_runs | yes | 0 | — |
| artifact_health_scores | yes | 0 | — |
| prompt_scores | yes | 228 | 2026-07-16T03:15:51.031Z |
| fix_patterns | yes | 49 | 2026-07-16T15:56:04.597Z |
| decision_weights | yes | 0 | — |
| governance_rules | yes | 3 | 2026-07-09T00:36:07.549Z |
| pending_evolutions | yes | 334 | 2026-07-16T03:15:59.423Z |
| build_outcomes | yes | 171 | 2026-07-16T15:56:18.895Z |
| skill_library | yes | 0 | — |
| reconcile_decisions | yes | 0 | — |
| scan_reports | yes | 0 | — |
| hook_execution_log | yes | 92 | 2026-07-16 15:56:18 |
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
| error_patterns | 43 | 2026-07-16T15:56:04.593Z |
| fix_patterns | 49 | 2026-07-16T15:56:04.597Z |
| governance_rules | 3 | 2026-07-09T00:36:07.549Z |
| cross_project_insights | 33 | 2026-07-09T05:42:18.703Z |
| prompt_scores | 228 | 2026-07-16T03:15:51.031Z |

## Environment

- ANTHROPIC_API_KEY: present

## Wiring status

| Capability | Status | Detail |
|---|---|---|
| design-system generation | WIRED | src/phases/phase1b-architect.ts calls generateDesignSystem() during Phase 1B. |
| skill injection | WIRED | src/phases/phase3-executor.ts reads queue entry `skills:` via loadSkillContent(). |
| ui skill declarations | WIRED | src/engine/queue-generator.ts declares skills: [frontend-design, ui-ux-pro-max] on every UI-producing entry. |
| design-doc injection | WIRED | src/phases/phase3-executor.ts GOVERNANCE_DOC_NAMES includes DESIGN_SYSTEM.md. |
| brands storage | WIRED | src/phases/phase1b-architect.ts calls createBrand/updateBrand; brand_identities has 3 row(s). |
| learning hooks | WIRED | hook_execution_log has 92 row(s). |
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
| file-delta law | WIRED | src/phases/phase4-sentinel.ts FAILs a non-exempt prompt whose git diff (main...HEAD) shows no added/modified files and whose expected output is not already on disk ("no work product"). |
