# FORGE 2.0 — Section 1 Changelog

**Date:** 2026-06-24
**Prompts:** r3-001 through r3-014 (14 prompts)
**Status:** COMPLETE — exec gate UNVERIFIED (pnpm commands require operator approval)

---

## Files Created or Modified

### src/learning/ (Run 1 artifacts — 10 files, 2723 total lines)

| File | Lines | Action | Notes |
|------|-------|--------|-------|
| src/learning/types.ts | 170 | CREATED | All Learning Engine type definitions |
| src/learning/database.ts | 328 | CREATED | SQLite init, 14 tables, connection management, machine identity |
| src/learning/queries.ts | 360 | CREATED | 15 read/write query functions |
| src/learning/loops.ts | 326 | CREATED | 5 learning loops |
| src/learning/hooks-enhanced.ts | 444 | CREATED | 24 default hooks, execution engine |
| src/learning/sync.ts | 297 | CREATED | Cross-machine sync |
| src/learning/session.ts | 318 | CREATED | Session orchestration |
| src/learning/integration.ts | 236 | CREATED | Executor wiring |
| src/learning/fingerprint.ts | 120 | MODIFIED (r3-001) | Unicode → ASCII fix (TS1127/TS1161) |
| src/learning/precompact.ts | 124 | CREATED | PreCompact handler |

### src/retrofit/ (Run 2/Section 1 — 10 files, 812 total lines)

| File | Lines | Action | Notes |
|------|-------|--------|-------|
| src/retrofit/types.ts | 148 | CREATED | ScanReport types, ReconcileDecision, DiagnoseFinding, ScanScope |
| src/retrofit/preflight.ts | 69 | CREATED | 8 pre-flight checks before scan |
| src/retrofit/scan-ops-1-4.ts | 96 | CREATED | Directory tree, dependency graph, broken imports, dead files |
| src/retrofit/scan-ops-5-8.ts | 121 | CREATED | Route inventory, env audit, schema extraction, git history |
| src/retrofit/scan-ops-9-14.ts | 88 | CREATED | Package audit, governance inventory, TSC check, tests, dynamic routes, Vercel |
| src/retrofit/scan.ts | 64 | CREATED | Orchestrates all 14 scan ops, writes .forge/scan_report.json |
| src/retrofit/diagnose.ts | 93 | CREATED | Architecture Health, Governance Reconciliation, Enterprise Patterns Gap reports |
| src/retrofit/reconcile.ts | 117 | CREATED | Hybrid interactive Model C, SQLite decision persistence, queue generator, renderer, pipeline |
| src/retrofit/pipeline.ts | 3 | CREATED | Re-export shim: `export { runRetrofitPipeline } from './reconcile.js'` |
| src/retrofit/index.ts | 13 | CREATED | Package barrel exports |

### src/phases/phase4-sentinel.ts (3638 lines)

| Action | Lines | Notes |
|--------|-------|-------|
| Ring 1 (mandatory) | ~1000 | TSC check, ESLint JSON parse, Schema Drift detection |
| Ring 2 (every 10th or final) | ~500 | Vitest, Semgrep, Knip dead-code scan |
| Ring 3 (pre-deploy / --final) | ~600 | Trivy container scan, Gitleaks secret scan, Lighthouse perf |
| `runSentinelRing` export | Lines 3621–3636 | CLI-callable wrapper: ring number → SentinelOptions |
| `shouldFireRing2` export | Line 1744 | Guard: `promptNumber % 10 === 0 or isFinalPrompt` |
| `shouldFireRing3` export | Line 1756 | Guard: `isFinalPrompt or forceRun` |

### src/cli/index.ts

| Change | Line | Action |
|--------|------|--------|
| `forge retrofit <path>` command | 1246 | ADDED — `--scope`, `--db`, `--skip-dynamic`, `--yes` flags; calls `runRetrofitPipeline` |
| `forge sentinel <path>` command | 1269 | ADDED — `--ring`, `--prompt-number`, `--final` flags; calls `runSentinelRing` |
| `registerLearningCommands` import | 61 | ADDED |
| `registerLearningCommands(program)` call | ~1300 | ADDED — registers `forge learn` command tree |

### src/cli/commands/learning.ts (new file, r3-014)

| Command | Status |
|---------|--------|
| `forge learn init` | DB initialization |
| `forge learn status` | DB metrics + all table row counts |
| `forge learn patterns` | Top fix patterns sorted by success_rate (ADDED r3-014) |
| `forge learn sync [--pull] [--push]` | Bidirectional sync (refactored r3-014) |
| `forge learn evolutions` | Pending self-modification proposals |
| `forge learn rules` | Active governance rules |

---

## New CLI Commands Added in Section 1

```
forge retrofit <project-path>         # Full RETROFIT pipeline (SCAN → DIAGNOSE → RECONCILE → QUEUE)
forge sentinel <project-path>         # Run Sentinel rings (--ring 1|2|3|all, --prompt-number, --final)
forge learn                           # Learning engine management
forge learn init                      # Initialize SQLite DB at ~/.forge/forge_memory.db
forge learn status                    # DB health + metrics
forge learn patterns [--limit <n>]    # Top error-fix patterns by success rate
forge learn sync [--pull] [--push]    # Cross-machine sync (bidirectional by default)
forge learn evolutions                # Pending evolution proposals
forge learn rules                     # Active governance rules
```

---

## Architecture Decisions

1. **Sentinel in phases/, not sentinel/**: `phase4-sentinel.ts` houses all three rings in one 3638-line file rather than a separate `src/sentinel/` directory. Ring selection is by `SentinelOptions` shape, not file separation.

2. **RETROFIT pipeline.ts as shim**: `reconcile.ts` contains the full pipeline (RECONCILE + QUEUE + RENDERER + orchestrator). `pipeline.ts` is a 3-line re-export shim so the CLI import path `../retrofit/pipeline.js` resolves cleanly without restructuring.

3. **Learning CLI as separate command module**: `src/cli/commands/learning.ts` registered via `registerLearningCommands(program)` keeps the 1300-line `index.ts` from growing further.

4. **Exec gate caveat**: All 14 prompts in Section 1 were completed with the exec gate blocked. TypeScript correctness verified by inspection. `dist/` from a prior successful build is present. Operator must run `pnpm tsc --noEmit && pnpm build` before Section 2.

---

## Prompt-by-Prompt Summary

| Prompt | Task | Outcome |
|--------|------|---------|
| r3-001 | fingerprint.ts Unicode corruption fix | PASS (inspection) |
| r3-002 | RETROFIT types.ts + preflight.ts | PASS (inspection) |
| r3-003 | RETROFIT scan-ops-1-4.ts | PASS (inspection) |
| r3-004 | RETROFIT scan-ops-5-8.ts | PASS (inspection) |
| r3-005 | RETROFIT scan-ops-9-14.ts | PASS (inspection) |
| r3-006 | RETROFIT scan.ts orchestrator | PASS (inspection) |
| r3-007 | RETROFIT diagnose.ts | PASS (inspection) |
| r3-008 | RETROFIT reconcile.ts | PASS (inspection) |
| r3-009 | RETROFIT queue generator + renderer | PASS (inspection) |
| r3-010 | RETROFIT pipeline.ts shim + index.ts | PASS (inspection) |
| r3-011 | Sentinel Ring 1 (TSC/ESLint/Schema Drift) | PASS (inspection) |
| r3-012 | Sentinel Ring 2/3 (Vitest/Semgrep/Knip/Trivy/Gitleaks/Lighthouse) | PASS (inspection) |
| r3-013 | CLI: forge sentinel command + runSentinelRing export | PASS (inspection) |
| r3-014 | CLI: forge learn commands (patterns added, sync refactored) | PASS (inspection) |
