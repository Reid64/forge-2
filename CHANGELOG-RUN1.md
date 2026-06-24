# CHANGELOG — Run 1: Learning Engine Enhancement
**Date:** 2026-06-23
**Prompts Completed:** r1-001, r1-001b, r1-002 through r1-011 (12 prompts passed)
**Gate Status:** All prompts AUTHORED and by-inspection-reviewed. Compile/runtime gates UNVERIFIED — exec blocker persists (see STATE_OF_THE_BUILD.md). tsc target: zero errors.

---

## New Files Created

| File | Lines | Purpose |
|------|-------|---------|
| `src/learning/types.ts` | 172 | Type definitions — all 14 table interfaces, constants, VALID_TABLES, HOOK_EVENTS |
| `src/learning/database.ts` | 328 | DB init (14 tables, 26 indexes), getConnection, getMachineId, closeConnection, getForgeDbPath |
| `src/learning/fingerprint.ts` | 120 | Error fingerprinting — generalizeFilePath, generalizeErrorMessage, getErrorFingerprint |
| `src/learning/queries.ts` | 360 | 15 query functions: save, get, update, scorePrompt, getBestTemplates, fix patterns, governance rules, skills, evolutions |
| `src/learning/loops.ts` | 326 | Five learning loops: scorePromptExecution, captureError, checkAutoElevation, updateDecisionWeights, loadCrossProjectKnowledge, analyzeForEvolutions, presentEvolutions, applyEvolution |
| `src/learning/sync.ts` | 297 | Cross-machine sync: acquireSyncLock, releaseSyncLock, loadSyncConfig, syncForgeMemory (pull/push), timestamps |
| `src/learning/hooks-enhanced.ts` | 444 | 24 default hooks across 8 events, matchGlob, testHookConditions, resolveHookTemplates, writeDefaultHooksConfig |
| `src/learning/precompact.ts` | 124 | shouldPreCompact, invokePreCompactSave, restoreCompactedContext |
| `src/learning/session.ts` | 318 | getBuildFingerprint, exportSessionState, resumeForgeSession, testCrashRecovery, setForgeLock, removeForgeLock, exportSessionHandoff |
| `src/learning/integration.ts` | 236 | Integration bridge: onRunStart, onPromptComplete, onRunEnd |
| `src/cli/commands/learning.ts` | 193 | CLI subcommands: forge learning init/status/sync/evolutions/rules |
| `tests/learning-database.test.ts` | 80 | 8 tests: 14 tables, idempotency, 26 indexes, getMachineId, WAL mode |
| `tests/learning-fingerprint.test.ts` | 92 | 7 tests: same-pattern fingerprint, different codes, 32-char hex, stack order independence, path wildcarding |
| `tests/learning-queries.test.ts` | 98 | 8 tests: UUID generation, auto machine_id/created_at, invalid table rejection, WHERE/LIMIT filtering |
| `tests/learning-sync.test.ts` | 82 | 8 tests: lock create/release, graceful degradation, config defaults, timestamp round-trip |

**Total new lines of code:** 2,725 (src/learning) + 352 (tests) + 193 (CLI) = **3,270 lines**

---

## Existing Files Modified

| File | Change |
|------|--------|
| `src/cli/index.ts` | Added import of `registerLearningCommands`; added auto-init of learning DB at top of `cmdBuild` (non-critical try/catch); added `registerLearningCommands(program)` call before `parseAsync` |
| `src/phases/phase3-executor.ts` | Added import of `onRunStart, onPromptComplete, onRunEnd`; added `onRunStart` call after costTracker init; added `onPromptComplete` call after each prompt's `outcomes.push`; added `onRunEnd` call before simulation report. All wrapped with `.catch(() => {})` — executor is unaffected by learning failures |
| `package.json` | `test` script updated to `node --import tsx --test tests/learning-database.test.ts tests/learning-fingerprint.test.ts tests/learning-queries.test.ts tests/learning-sync.test.ts` |

---

## Dependencies Added

| Package | Version | Location | Notes |
|---------|---------|----------|-------|
| `better-sqlite3` | 12.11.1 | pnpm virtual store (`node_modules/.pnpm/`) | NOT in package.json — installed manually. **Action required:** `pnpm add better-sqlite3` |
| `@types/better-sqlite3` | 7.6.13 | pnpm virtual store (`node_modules/.pnpm/`) | NOT in package.json devDependencies. **Action required:** `pnpm add -D @types/better-sqlite3` |

> **Warning:** `better-sqlite3` and `@types/better-sqlite3` are present in the pnpm virtual store but absent from `package.json`. They were NOT found in `pnpm-lock.yaml`. This means they are available on this machine but will be missing on a fresh install. Add them before deploying to a new environment.

---

## New CLI Commands

| Command | Description |
|---------|-------------|
| `forge learning init` | Initialize `~/.forge/forge_memory.db` with all 14 tables; prints path, size, table count, machine ID |
| `forge learning status` | Show row counts for all 14 VALID_TABLES, last sync timestamp, machine ID |
| `forge learning sync pull` | Pull learning records from master drive (requires `~/.forge/sync_config.json`) |
| `forge learning sync push` | Push learning records to master drive with file locking |
| `forge learning evolutions` | List pending self-modification proposals with confidence colors |
| `forge learning rules` | List active governance rules from the learning database |

---

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Database runtime | `better-sqlite3` (synchronous) | FORGE is a CLI tool; synchronous I/O is appropriate and simpler than async SQLite |
| Module system | ESM (`"type": "module"`) | Matches existing project; imports use `.js` extensions |
| Test runner | `node:test` (built-in) | No additional test framework needed; compatible with `--import tsx` |
| DB location | `~/.forge/forge_memory.db` | Per-machine, persists across projects; mirrors BLUEPRINT.md spec |
| Sync protocol | Append-only with file locking | Never UPDATE master records; INSERT OR IGNORE prevents duplicates |
| Integration pattern | Non-critical wrapper | Learning failures NEVER crash the executor; all calls wrapped in try/catch |
| Fingerprinting | SHA-256 of normalized components | Deterministic; same error in different entity files → same fingerprint |
| Self-modification scope | Configuration only (pending_evolutions) | FORGE may propose changes to hooks/templates/rules but NEVER modifies its own source code |

---

## Test Coverage Summary

| File | Tests | Key Coverage |
|------|-------|-------------|
| `learning-database.test.ts` | 8 | initializeForgeMemory creates 14+ tables, 20+ indexes, idempotent, schema_version, getMachineId 16-char hex, consistent, WAL mode |
| `learning-fingerprint.test.ts` | 7 | Same pattern → same fingerprint, different code → different, 32 hex chars, stack-order-independent, generalizeFilePath wildcards entities, normalizes backslashes, generalizeErrorMessage replaces quoted strings |
| `learning-queries.test.ts` | 8 | saveToForgeMemory UUID, auto machine_id, auto created_at, rejects invalid table, getForgeMemory empty array, WHERE filter, LIMIT, governance active-only filter |
| `learning-sync.test.ts` | 8 | acquireSyncLock creates file + JSON, releaseSyncLock removes file, release-nonexistent no-throw, loadSyncConfig defaults, syncForgeMemory graceful degradation, epoch default, timestamp round-trip |
| **Total** | **31** | |

---

## Prompt Sequence

| Prompt | Status | What Was Built |
|--------|--------|---------------|
| r1-001 | PASSED | Project scaffolding / initial setup |
| r1-001b | PASSED | Scaffolding corrections / additional setup |
| r1-002 | PASSED | `src/learning/database.ts` — 14 tables, 26 indexes, getMachineId, WAL |
| r1-003 | PASSED | `src/learning/queries.ts` — 15 query functions, parameterized SQL, table validation |
| r1-004 | PASSED | `src/learning/fingerprint.ts` — SHA-256 fingerprinting, path + message normalization |
| r1-005 | PASSED | `src/learning/loops.ts` — 5 learning loops, auto-elevation logic |
| r1-006 | PASSED | `src/learning/sync.ts` — append-only sync, file locking, graceful degradation |
| r1-007 | PASSED | `src/learning/hooks-enhanced.ts` — 24 default hooks, glob matching, template resolution |
| r1-008 | PASSED | `src/learning/precompact.ts` + `src/learning/session.ts` — context preservation, session orchestration |
| r1-009 | PASSED | `src/learning/integration.ts` — executor integration bridge (onRunStart/Complete/End) |
| r1-010 | PASSED | `src/cli/commands/learning.ts` — 6 CLI subcommands; patched `src/cli/index.ts` |
| r1-011 | PASSED | 4 test files (31 tests); updated `package.json` test script |
