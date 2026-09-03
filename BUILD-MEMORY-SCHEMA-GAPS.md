# Build Memory — Zero-Row Table Audit (Finding C-1, 2026-09-02)

`forge health` reports 22 Build Memory tables with 0 rows despite an active, long-running build
history (25,870 total rows elsewhere, `build_runs` reaching back to 2026-07). Investigated each
individually — most have a real writer that has simply never been exercised yet; only a handful
have no writer implementation at all.

## Has a real writer — never yet exercised in a real run/command

These tables' writer code exists and is correct; the 0-row count reflects that the feature behind
it hasn't been used yet, not a wiring gap:

| Table | Writer | Why still empty |
|---|---|---|
| `stack_profiles` | `src/memory/profiles.ts` | No caller has recorded a profile yet. |
| `design_patterns` | `src/memory/patterns.ts` | No caller has recorded a pattern yet. |
| `scheduled_tasks` | `src/memory/scheduled-tasks.ts` | Ties to `src/engine/scheduler.ts`, itself orphaned — see that file's header comment (Finding G-1). |
| `queue_versions` | `src/tools/queue-versioning.ts` | No caller has versioned a queue yet. |
| `evolution_promotions` | `src/learning/evolution-promoter.ts` | No evolution has been promoted yet on this install. |
| `pattern_retirement_log` | `src/learning/pattern-retirer.ts` | Ties to `src/engine/scheduler.ts`'s never-armed weekly sweep — see that file's header comment (Finding G-1). |
| `test_coverage_snapshots` | `src/memory/test-results.ts` | No caller has snapshotted coverage yet. |
| `validation_events` | `src/sentinel-prime/confidence-scorer.ts` | No caller has recorded a validation event yet. |
| `orchestrator_manifests` | `src/orchestrator/engine.ts`, `manifest-resolver.ts` | `forge orchestrate` (non-dry-run) hasn't run against this install yet. |
| `orchestrator_queue_runs` | `src/orchestrator/manifest-resolver.ts` | Same as above. |
| `project_credentials` | `src/autonomy/credential-vault.ts` | No project has stored a credential yet. |
| `deployment_history` | `src/autonomy/vercel-deployer.ts` | No real deploy has run yet. |
| `adr_records` | `src/memory/adr.ts` | `forge adr add` hasn't been run for real yet. |
| `assumptions` | `src/memory/assumptions.ts` | `forge assumption add` hasn't been run for real yet. |
| `risks` | `src/memory/risks.ts` | `forge risk add` hasn't been run for real yet. |
| `tech_debt_items` | `src/memory/tech-debt.ts` | `forge techdebt add` hasn't been run for real yet. |
| `reconcile_decisions` | `src/retrofit/reconcile.ts` | `forge retrofit`'s interactive reconcile step hasn't been run for real yet. |
| `compact_snapshots` | `src/learning/precompact.ts` | `handlePreCompact` is never called — see that file's header comment (Finding J-1). |

## No writer exists anywhere

These 5 have no `INSERT INTO`/writer module at all (confirmed by repo-wide search). Each is
referenced only as a schema/type definition, not backed by any implementation:

- `decision_weights`
- `skill_library`
- `scan_reports`
- `build_fingerprints`
- `adversary_findings`

**Decision:** documented as reserved, not wired in this pass. Each would need its own scoped
design (what writes to it, on what trigger, with what shape) — five independent feature designs
are out of scope for an audit-fix pass. Flagging here so a future task treats these as "needs a
writer designed," not "already covered, just unexercised" like the table above.
