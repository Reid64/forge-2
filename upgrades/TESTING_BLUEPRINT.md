# FORGE 2.0 — System 3: Enterprise Test Suite — BLUEPRINT

> Architecture for the PRD at `upgrades/TESTING_PRD.md`. Reads its schema contract from
> `upgrades/SCHEMA_ADDITIONS.md` (§5 `test_run_results`, §6 `test_coverage_snapshots`, §7 access
> control, §8 integration checklist) **verbatim** — no table or column here is invented. All
> persistence is FORGE's single-operator SQLite Build Memory (`~/.forge/forge_memory.db`,
> better-sqlite3). No Postgres/Supabase DDL for FORGE's own memory anywhere in this file.

## System Identity
- **Name:** System 3 — Enterprise Test Suite (agent: `TestOrchestrator`)
- **Purpose:** Run all 19 enterprise test dimensions against apps FORGE builds; normalize every
  tool's output into `test_run_results` / `test_coverage_snapshots`; gate the build loop and
  deploy on the results without slowing per-prompt execution.
- **Primary Stack:** Node.js 20+, TypeScript (strict), Vitest (primary runner), Playwright
  (browser/E2E), k6 (load), PowerShell on Windows (Contract 6).
- **Package Manager:** pnpm.
- **Status:** NOT_STARTED.
- **Schema version bump this system rides on:** `2.2.1 → 2.3.0` (shared with Systems 1 & 2 per
  SCHEMA_ADDITIONS §0/§8 — one bump for all six tables).

## Architecture Overview
`TestOrchestrator` is a non-fatal, injectable-collaborator agent in the exact house style of
`phase4-sentinel.ts` / `six-laws-verifier.ts`: it NEVER throws and NEVER fabricates a pass; every
shell spawn, file read, browser drive, and Build-Memory write is guarded and injectable so the
agent unit-tests with no k6, no browser, no database. It is a **dispatcher**: given a project
path, a trigger, and a suite selector, it resolves the set of suite types to run for that trigger
(the Cadence Policy from the PRD), invokes the concrete runner for each, parses that runner's raw
output through a per-runner **normalizer** into the common `TestRunResult` shape, writes one
`test_run_results` row per suite (plus four `test_coverage_snapshots` rows for UNIT/INTEGRATION),
and returns an aggregate `{ passed, results, gateFailures }` the caller (Sentinel Ring 3, the
deploy gate, or the CLI) acts on.

It **reuses, never re-implements** existing FORGE tools: `src/tools/security-scanner.ts`
(SECURITY fast layer), `src/tools/accessibility-auditor.ts` (ACCESSIBILITY), `src/tools/
visual-regression.ts` (VISUAL_REGRESSION baselines), and Sentinel's already-wired Semgrep/Trivy/
Gitleaks/Lighthouse/Vitest ring runners (SAST/CVE/secret/UI-score). New code is only the
orchestrator, the k6 harness, the CHAOS/DR/BACKUP_RESTORE harnesses, and the normalizers.

### Core Components
1. **`TestOrchestrator`** — dispatcher + cadence resolver + aggregate gate (`src/testing/
   test-orchestrator.ts`).
2. **Runner adapters** — one module per tool family under `src/testing/runners/`, each exporting a
   `run(input): Promise<TestRunResult>` in the injectable house style:
   `vitest-runner.ts` (UNIT/INTEGRATION/API + coverage), `playwright-runner.ts` (E2E/
   VISUAL_REGRESSION/CROSS_BROWSER/CROSS_DEVICE), `k6-runner.ts` (PERFORMANCE/LOAD/STRESS/SOAK),
   `security-runner.ts` (SECURITY — wraps existing scanner + Semgrep + optional ZAP),
   `accessibility-runner.ts` (ACCESSIBILITY — wraps existing auditor), `dependency-runner.ts`
   (DEPENDENCY_SCAN — pnpm audit + Trivy), `static-runner.ts` (STATIC_ANALYSIS — tsc + ESLint +
   Semgrep), `dynamic-runner.ts` (DYNAMIC_ANALYSIS — running-app error/leak capture + optional ZAP
   active), `chaos-runner.ts` (CHAOS), `continuity-runner.ts` (DISASTER_RECOVERY/BACKUP_RESTORE).
3. **Normalizers** — pure functions (`src/testing/normalize.ts`) converting each tool's raw JSON/
   text to `TestRunResult` and (for coverage) `CoverageSnapshot[]`. Pure = trivially unit-tested.
4. **Isolated-environment guard** — `src/testing/isolation-guard.ts`, a pure predicate over the
   resolved target (Supabase ref, connection string, base URL) that destructive runners must pass.
5. **CRUD** — `src/memory/test-results.ts` (typed insert/get/list wrapping prepared statements for
   both tables, per the `src/memory/builds.ts` reference shape — no raw SQL outside this module).
6. **ChangesetGate** (F7) — extends the existing `appendChangeset()` (`src/phases/
   phase3-executor.ts`) with a `changesetWritten` result flag that `mergeAndTag()` consults before
   it calls `ctx.git.mergeToMain()`. No new file; a control-flow addition to existing code.
7. **PreDeployBuildGate** (F8) — `src/deploy/pre-deploy-gate.ts` (new), spawns `next build`/
   `next lint` and gates `forge deploy` before its existing BUILD_READY/monitoring-snippet logic.
8. **DeployVerifier** (F9) — `src/deploy/verify-runner.ts` (new), issues real HTTP checks against
   every declared route on the live/preview base URL after a successful deploy.

F7–F9 are governance-artifact gates, not suite runners — they write to `CHANGESET.md`,
`STATE_OF_THE_BUILD.md`, and `SESSION_STATE.md` respectively and never touch Build Memory. See the
dedicated `## Governance & Deploy Gate Configurations (F7–F9)` section below for their tool/config/
invocation/cadence detail, matching the format used for the 19 suite runners.

### Project Structure
```
forge-2/
├── src/
│   ├── testing/
│   │   ├── test-orchestrator.ts        # dispatcher, cadence resolver, aggregate gate, forge test entry
│   │   ├── cadence.ts                  # trigger → suite-set resolution (POST_PROMPT/SCHEDULED/PRE_DEPLOY/MANUAL)
│   │   ├── normalize.ts                # pure: raw tool output → TestRunResult / CoverageSnapshot[]
│   │   ├── isolation-guard.ts          # pure: is this target a non-production, isolated environment?
│   │   ├── report-writer.ts            # writes <target>/.forge/test-reports/<suite>-<ts>.{json,html}
│   │   └── runners/
│   │       ├── vitest-runner.ts        # UNIT / INTEGRATION / API + coverage-v8
│   │       ├── playwright-runner.ts    # E2E / VISUAL_REGRESSION / CROSS_BROWSER / CROSS_DEVICE
│   │       ├── k6-runner.ts            # PERFORMANCE / LOAD / STRESS / SOAK
│   │       ├── security-runner.ts      # SECURITY (security-scanner + Semgrep + optional ZAP)
│   │       ├── accessibility-runner.ts # ACCESSIBILITY (accessibility-auditor / axe-core)
│   │       ├── dependency-runner.ts    # DEPENDENCY_SCAN (pnpm audit + Trivy)
│   │       ├── static-runner.ts        # STATIC_ANALYSIS (tsc + ESLint + Semgrep)
│   │       ├── dynamic-runner.ts       # DYNAMIC_ANALYSIS (running-app error/leak + optional ZAP active)
│   │       ├── chaos-runner.ts         # CHAOS (fault injection)
│   │       └── continuity-runner.ts    # DISASTER_RECOVERY / BACKUP_RESTORE
│   ├── memory/
│   │   └── test-results.ts             # test_run_results + test_coverage_snapshots CRUD
│   ├── learning/
│   │   └── database.ts                 # +2 CREATE TABLE blocks, +2 ALL_FORGE_TABLES, version 2.3.0
│   ├── deploy/
│   │   ├── pre-deploy-gate.ts          # F8: next build + next lint pre-flight, writes STATE_OF_THE_BUILD.md blockers
│   │   └── verify-runner.ts            # F9: forge verify — HTTP route checks vs. live/preview base URL, writes SESSION_STATE.md
│   └── phases/
│       ├── phase3-executor.ts          # F7: appendChangeset() (existing) + changesetWritten gate consulted by mergeAndTag()
│       └── phase4-sentinel.ts          # hook: POST_PROMPT subset call + Ring 3 full-sweep gate
├── templates/
│   └── governance/
│       └── TESTING.template.md         # expanded to the 19-suite structure (below)
└── tests/                              # FORGE's own tests, migrated node:test → vitest (import-swap)
```

## Agent Contract: TestOrchestrator
Registry entry in the AGENTS.md format:

## Agent: TestOrchestrator (src/testing/)

- **Purpose:** Enterprise Test Suite orchestrator. Runs any/all of the 19 `test_run_results.test_suite`
  dimensions against a FORGE-built target app, normalizes each runner's output into Build Memory,
  and returns an aggregate gate result for Sentinel Ring 3, the deploy gate, and the CLI.
- **Status:** NOT_STARTED
- **CLI:** `forge test <project-path> [--suite <TYPE>|all] [--trigger post-prompt|scheduled|manual|pre-deploy] [--allow-destructive] [--coverage-threshold <0..1>]`
  and `forge test status <project-path>` (latest row per suite), `forge test coverage <project-path>`
  (latest four coverage snapshots + deltas). Wired in `src/cli/index.ts`.
- **CLI Options:** `--suite` one of the 19 enum values (case-insensitive) or `all` (default `all`);
  `--trigger` maps to `test_run_results.trigger` (`post-prompt`→`POST_PROMPT`, etc.; default
  `manual`→`MANUAL`); `--allow-destructive` names an explicitly-isolated target so destructive
  suites may run; `--coverage-threshold` overrides `threshold_required` (default 0.80).
- **Entry Point:** `src/testing/test-orchestrator.ts` → `runTestSuite(input): Promise<TestOrchestratorResult>`.
- **Exports:** `runTestSuite`, `resolveSuiteSet` (cadence.ts), `normalizeRun` / `normalizeCoverage`
  (normalize.ts), `isIsolatedEnvironment` (isolation-guard.ts), `SUITE_TYPES` (the frozen array of
  the 19 enum values), and the `TestRunResult` / `CoverageSnapshot` / `TestOrchestratorResult` types.
- **Dependencies:** Vitest + `@vitest/coverage-v8` (UNIT/INTEGRATION/API + coverage), `@playwright/test`
  + Playwright (E2E/visual/cross-*), k6 (load family), existing `src/tools/security-scanner.ts`,
  `accessibility-auditor.ts`, `visual-regression.ts`; existing Sentinel Semgrep/Trivy/Gitleaks/
  Lighthouse runners; `node-cron` + `scheduled_tasks` (scheduled sweep); `src/memory/test-results.ts`;
  `src/learning/database.ts` (`initializeForgeMemory`, `getForgeDbPath`, `machineId`).
- **Database tables:** `test_run_results` (write — one row per suite run), `test_coverage_snapshots`
  (write — four rows per UNIT/INTEGRATION run), `build_runs` (read — FK `build_run_id` when triggered
  by Phase 3), `scheduled_tasks` (read/write — registers + records the sweep cron).

### Files

| File | Purpose |
|------|---------|
| `src/testing/test-orchestrator.ts` | Dispatcher, aggregate gate, `runTestSuite`, `forge test` handler |
| `src/testing/cadence.ts` | `resolveSuiteSet(trigger)` → the suite set for that trigger (Cadence Policy) |
| `src/testing/normalize.ts` | Pure normalizers: raw runner output → `TestRunResult` / `CoverageSnapshot[]` |
| `src/testing/isolation-guard.ts` | Pure `isIsolatedEnvironment(target)` predicate for destructive suites |
| `src/testing/report-writer.ts` | Persists per-run report artifacts under `<target>/.forge/test-reports/` |
| `src/testing/runners/vitest-runner.ts` | UNIT/INTEGRATION/API via Vitest + coverage-v8 |
| `src/testing/runners/playwright-runner.ts` | E2E/VISUAL_REGRESSION/CROSS_BROWSER/CROSS_DEVICE via `@playwright/test` |
| `src/testing/runners/k6-runner.ts` | PERFORMANCE/LOAD/STRESS/SOAK via k6 |
| `src/testing/runners/security-runner.ts` | SECURITY: security-scanner + Semgrep + optional ZAP baseline |
| `src/testing/runners/accessibility-runner.ts` | ACCESSIBILITY via existing accessibility-auditor (axe-core) |
| `src/testing/runners/dependency-runner.ts` | DEPENDENCY_SCAN: `pnpm audit --json` + Trivy `fs` |
| `src/testing/runners/static-runner.ts` | STATIC_ANALYSIS: tsc --noEmit + ESLint + Semgrep |
| `src/testing/runners/dynamic-runner.ts` | DYNAMIC_ANALYSIS: running-app error/leak capture + optional ZAP active |
| `src/testing/runners/chaos-runner.ts` | CHAOS: dependency fault injection + graceful-degradation assertion |
| `src/testing/runners/continuity-runner.ts` | DISASTER_RECOVERY / BACKUP_RESTORE round-trip |
| `src/memory/test-results.ts` | CRUD for both tables (prepared statements, `src/memory/builds.ts` shape) |
| `src/deploy/pre-deploy-gate.ts` | F8: `runPreDeployGate` — next build/lint pre-flight, blockers to STATE_OF_THE_BUILD.md |
| `src/deploy/verify-runner.ts` | F9: `runDeployVerification` — post-deploy HTTP route checks, results to SESSION_STATE.md |

## Agent Contract: ChangesetGate

- **Purpose:** Enforces F7 — confirms the per-prompt `CHANGESET.md` append (`appendChangeset()`)
  succeeded before that prompt's feature branch is allowed to merge to main.
- **Status:** PARTIAL — `appendChangeset()`/`syncIdeStatus()` already ship (`d5313ea`); the
  merge-blocking gate itself is NOT_STARTED.
- **CLI:** none — internal to `forge build`'s per-prompt loop; no standalone command.
- **Entry Point:** `src/phases/phase3-executor.ts` → `appendChangeset()` (existing, lines
  2475-2500) sets `changesetWritten`; `mergeAndTag()` (existing, line 2441) consults it before
  calling `ctx.git.mergeToMain()`.
- **Exports:** no new public exports — both functions are today (and remain) module-private to
  `phase3-executor.ts`; the gate is an internal control-flow change, not a new API surface.
- **Dependencies:** `node:fs/promises` (`appendFile`, existing), `ctx.git.mergeToMain()` /
  `ctx.git.tagCheckpoint()` (`src/engine/git-manager.ts`, existing), `syncIdeStatus()`
  (`src/tools/live-status.ts`, existing).
- **Database tables:** none — writes only to `<project>/CHANGESET.md` and
  `<project>/{governanceDir}/SESSION_STATE.md`'s IDE STATUS block (both file artifacts, never
  Build Memory).

## Agent Contract: PreDeployBuildGate

- **Purpose:** Enforces F8 — runs `next build`/`next lint` before `forge deploy` proceeds,
  recording blockers to `STATE_OF_THE_BUILD.md` on failure.
- **Status:** NOT_STARTED.
- **CLI:** no new command — wired as a mandatory first step inside the existing
  `forge deploy <project-path>` (`src/cli/index.ts`, `.command('deploy')`), before its current
  `BUILD_READY.md`/monitoring-snippet logic.
- **Entry Point:** `src/deploy/pre-deploy-gate.ts` → `runPreDeployGate(projectPath):
  Promise<PreDeployGateResult>`.
- **Exports:** `runPreDeployGate`, `PreDeployGateResult` (`{ passed: boolean; checks: Array<{
  command: string; exitCode: number | null; skipped: boolean; skipReason?: string; outputTail:
  string }> }`).
- **Dependencies:** `node:child_process` (`spawn`, `-NoProfile` PowerShell hardening — same
  pattern as `claude-runner.ts`/`phase4-sentinel.ts`), `node:fs` (`existsSync`/`readFileSync` to
  detect `next`/`next.config.*` presence and to append the blockers section).
- **Database tables:** none — writes only to `<project>/{governanceDir}/STATE_OF_THE_BUILD.md`.

## Agent Contract: DeployVerifier

- **Purpose:** Enforces F9 — issues real HTTP checks against every Phase-1B-declared API route on
  the live/preview base URL after a successful deploy, recording results to `SESSION_STATE.md` and
  blocking build completion on any failure.
- **Status:** NOT_STARTED.
- **CLI:** `forge verify <project-path> --base-url <url>` (new command, `src/cli/index.ts`), also
  auto-invoked as the final step of `forge deploy` once `PreDeployBuildGate` passes and a deploy
  actually completes.
- **CLI Options:** `--base-url` (or `FORGE_VERIFY_BASE_URL` env fallback); `--latency-budget-ms`
  (or `FORGE_VERIFY_LATENCY_BUDGET_MS`, default `2000`).
- **Entry Point:** `src/deploy/verify-runner.ts` → `runDeployVerification(input):
  Promise<VerifyResult>`.
- **Exports:** `runDeployVerification`, `VerifyResult` (`{ passed: boolean; routes: Array<{ route:
  string; statusCode: number | null; latencyMs: number; shapeOk: boolean; verdict: 'PASSED' |
  'BLOCKED' }> }`).
- **Dependencies:** Node's built-in `fetch`/`undici` (no new dependency, same choice as F1's API
  suite), Phase 1B's Architecture Engine route list (existing, already consumed by the Six Laws
  verifier).
- **Database tables:** none — writes only to `<project>/{governanceDir}/SESSION_STATE.md`'s new
  `## Post-Deploy Verification` section.

## Runner Configurations (all 19 suite types)
For each: **tool**, **new/existing dependency**, **config file (location/name)**, **invocation
command**, **cadence** (matching `test_run_results.trigger`), and **runner** value written to the
row. All commands are shown as invoked from **PowerShell on Windows without WSL**. Every runner is
spawned with the target project as cwd (Contract 6) and, where it shells into `pnpm`/`node`, uses
the same `-NoProfile` PowerShell hardening FORGE already applies in `claude-runner.ts`/
`phase4-sentinel.ts` (a user PowerShell profile must never hijack cwd or PATH — this repo has a
documented history of exactly that bug).

### 1. UNIT — Vitest
- Tool: **Vitest** + `@vitest/coverage-v8`. Dependency: **new** (`vitest`, `@vitest/coverage-v8`).
- Config: `vitest.config.ts` at target root (`test.include: ['**/*.{test,spec}.ts?(x)']`,
  `coverage.provider: 'v8'`, `coverage.reporter: ['json-summary','json']`, `coverage.reportsDirectory:
  './.forge/test-reports/coverage'`, `coverage.thresholds.lines/statements/functions: 80`,
  `coverage.thresholds.branches: 70`).
- Invocation: `pnpm exec vitest run --coverage --reporter=json --outputFile=.forge/test-reports/unit.json`
  (POST_PROMPT: append `--changed HEAD~1` to scope to touched files).
- Cadence: **POST_PROMPT** (touched-file scope) + **SCHEDULED** + **PRE_DEPLOY** (full). Runner: `vitest`.

### 2. INTEGRATION — Vitest (real wiring)
- Tool: **Vitest**. Dependency: **existing after F6 migration** (same `vitest`).
- Config: `vitest.integration.config.ts` (`test.include: ['**/*.integration.test.ts']`,
  `test.globalSetup: './tests/integration/setup.ts'` — spins a throwaway SQLite/Supabase test
  instance and tears it down; `test.sequence.concurrent: false`). Coverage same provider.
- Invocation: `pnpm exec vitest run --config vitest.integration.config.ts --coverage --reporter=json --outputFile=.forge/test-reports/integration.json`.
- Cadence: **SCHEDULED** + **PRE_DEPLOY** (and Sentinel Ring 2 every-10th, already wired). Runner: `vitest`.

### 3. API — Vitest + native fetch
- Tool: **Vitest** driving Node's built-in `fetch`/`undici` against a booted app (supertest-style;
  **no new dependency**). Dependency: existing (`vitest` + Node ≥ 20 global `fetch`).
- Config: `vitest.api.config.ts` (`test.include: ['**/*.api.test.ts']`, `test.globalSetup:
  './tests/api/boot.ts'` — starts the built app on an ephemeral port, exports its base URL via
  `globalThis`, stops it in teardown).
- Invocation: `pnpm exec vitest run --config vitest.api.config.ts --reporter=json --outputFile=.forge/test-reports/api.json`.
- Cadence: **SCHEDULED** + **PRE_DEPLOY**. Runner: `vitest`.

### 4. E2E — Playwright test runner
- Tool: **Playwright** via `@playwright/test`. Dependency: Playwright **existing**; `@playwright/test` **new**.
- Config: `playwright.config.ts` at target root (`testDir: './tests/e2e'`, `webServer` to boot the
  app, `reporter: [['json',{outputFile:'.forge/test-reports/e2e.json'}],['html',{outputFolder:'.forge/test-reports/e2e-html'}]]`,
  `projects: [{name:'chromium'}]` for E2E-only).
- Invocation: `pnpm exec playwright test --config playwright.config.ts`.
- Cadence: **SCHEDULED** + **PRE_DEPLOY**. Runner: `playwright`.

### 5. VISUAL_REGRESSION — Playwright screenshots (reuse existing tool)
- Tool: **Playwright** `toHaveScreenshot()`, reusing FORGE's `src/tools/visual-regression.ts` baseline
  mechanics. Dependency: **existing**.
- Config: `playwright.visual.config.ts` (`testDir: './tests/visual'`, `expect.toHaveScreenshot.maxDiffPixelRatio: 0.01`,
  `snapshotDir: './tests/visual/__screenshots__'`).
- Invocation: `pnpm exec playwright test --config playwright.visual.config.ts` (baseline refresh:
  `--update-snapshots`, on-demand only).
- Cadence: **SCHEDULED** + **PRE_DEPLOY**. Runner: `playwright`.

### 6. PERFORMANCE — k6 + Lighthouse
- Tool: **k6** (API latency budgets) + existing Ring-3 **Lighthouse** (UI score). Dependency: k6 **new
  (external binary, optional)**; Lighthouse **existing** (Sentinel Ring 3).
- Config: `k6/performance.js` (`export const options = { vus: 1, iterations: 50, thresholds: {
  http_req_duration: ['p(95)<300'] } }`).
- Invocation: `k6 run --summary-export=.forge/test-reports/perf-summary.json k6/performance.js`.
- Cadence: **SCHEDULED** + **PRE_DEPLOY**. Runner: `k6`.

### 7. LOAD — k6
- Tool: **k6**. Dependency: k6 (as above).
- Config: `k6/load.js` (`options = { stages: [{duration:'1m',target:200},{duration:'3m',target:200},
  {duration:'1m',target:0}], thresholds: { http_req_duration:['p(95)<500'], http_req_failed:['rate<0.01'] } }`).
- Invocation: `k6 run --summary-export=.forge/test-reports/load-summary.json k6/load.js`.
- Cadence: **SCHEDULED** + **PRE_DEPLOY**. Runner: `k6`.

### 8. STRESS — k6 (breakpoint)
- Tool: **k6** `ramping-arrival-rate`. Dependency: k6.
- Config: `k6/stress.js` (`options = { scenarios: { breakpoint: { executor:'ramping-arrival-rate',
  startRate:50, timeUnit:'1s', preAllocatedVUs:500, stages:[{duration:'2m',target:1000},{duration:'2m',target:2000}] } },
  thresholds: { http_req_failed:['rate<0.25'] } }` — asserts bounded failure, not a fixed latency).
- Invocation: `k6 run --summary-export=.forge/test-reports/stress-summary.json k6/stress.js`.
- Cadence: **PRE_DEPLOY** + **MANUAL** (behind isolation guard). Runner: `k6`.

### 9. SOAK — k6 (endurance)
- Tool: **k6** constant load, long duration. Dependency: k6.
- Config: `k6/soak.js` (`options = { vus: 100, duration: '30m', thresholds: { http_req_duration:['p(95)<600'],
  http_req_failed:['rate<0.02'] } }`; duration overridable via `K6_SOAK_DURATION`).
- Invocation: `k6 run --summary-export=.forge/test-reports/soak-summary.json k6/soak.js`.
- Cadence: **SCHEDULED (weekly)** + **PRE_DEPLOY (short)** + **MANUAL** (behind isolation guard). Runner: `k6`.

### 10. CHAOS — fault-injection harness (new)
- Tool: **TestOrchestrator `chaos-runner.ts`** — no external tool: Playwright route interception
  returns 500/timeout for the app's Supabase/API calls, and/or an env-toggled bad connection string,
  then asserts the app degrades gracefully (visible error state / retry / fallback; no white-screen,
  no unhandled rejection). Dependency: **existing** (Playwright). Mirrors Six Laws Law 3/4 runtime patterns.
- Config: `tests/chaos/scenarios.ts` (declares each fault: `{ target: 'supabase'|'api', mode:
  'error'|'timeout'|'disconnect', route, expectDegradation }`).
- Invocation: internal — `runChaos(target, scenarios)`; report to `.forge/test-reports/chaos.json`.
- Cadence: **PRE_DEPLOY** + **MANUAL** (behind isolation guard). Runner: `chaos-harness`.

### 11. DISASTER_RECOVERY — continuity harness (new) + Supabase CLI
- Tool: **`continuity-runner.ts`** driving the target's documented recovery runbook (point-in-time
  restore / failover) via the **Supabase CLI** (`supabase db ...`), then asserting data served within
  declared RTO/RPO. Dependency: Supabase CLI **existing** (TOOLCHAIN); harness **new**.
- Config: `tests/continuity/dr-runbook.ts` (declares the loss scenario, the runbook steps, and the
  RTO/RPO + seed assertions).
- Invocation: internal — `runDisasterRecovery(isolatedTarget)`; report to `.forge/test-reports/dr.json`.
- Cadence: **PRE_DEPLOY** + **MANUAL** (behind isolation guard). Runner: `continuity-harness`.

### 12. BACKUP_RESTORE — Supabase CLI round-trip (new harness)
- Tool: **`continuity-runner.ts`** + **Supabase CLI**: `supabase db dump` → wipe/recreate isolated
  target → `supabase db reset`/restore → assert a seed row round-trips byte-identically. Dependency:
  Supabase CLI **existing**; harness **new**.
- Config: `tests/continuity/backup-restore.ts` (dump command, restore command, seed row + assertion).
- Invocation: internal — `runBackupRestore(isolatedTarget)`; report to `.forge/test-reports/backup-restore.json`.
- Cadence: **SCHEDULED (weekly)** + **PRE_DEPLOY** (behind isolation guard). Runner: `continuity-harness`.

### 13. DEPENDENCY_SCAN — pnpm audit + Trivy
- Tool: **`pnpm audit --json`** (SCA on the lockfile) + existing Ring-3 **Trivy** `fs`. Dependency:
  pnpm **existing**; Trivy **existing (external binary, optional)**.
- Config: none required (`pnpm audit` reads `pnpm-lock.yaml`); Trivy invoked with severity filter.
- Invocation: `pnpm audit --json > .forge/test-reports/pnpm-audit.json` then
  `trivy fs --severity CRITICAL,HIGH --format json --quiet --output .forge/test-reports/trivy.json .`.
- Cadence: **SCHEDULED** + **PRE_DEPLOY** (and on dependency-manifest change). Runner: `pnpm-audit` (Trivy
  findings merged into the same row's `failure_summary`).

### 14. STATIC_ANALYSIS — tsc + ESLint + Semgrep (all existing)
- Tool: **`tsc --noEmit`** + **ESLint** + **Semgrep** — all already wired in Sentinel Ring 1/2.
  Dependency: **existing**.
- Config: target `tsconfig.json`, `.eslintrc`/`eslint.config.js`, Semgrep `--config=auto`.
- Invocation: `pnpm exec tsc --noEmit`, `pnpm exec eslint . --format json --output-file .forge/test-reports/eslint.json`,
  `npx semgrep --config=auto --json --output .forge/test-reports/semgrep.json`.
- Cadence: **POST_PROMPT** (this is the primary per-prompt suite) + SCHEDULED + PRE_DEPLOY. Runner:
  `static-analysis`.

### 15. DYNAMIC_ANALYSIS — running-app error/leak capture + optional ZAP active
- Tool: **`dynamic-runner.ts`** — Playwright-driven walkthrough of every route capturing unhandled
  exceptions + `console.error` + `pageerror`, with Node process RSS sampled across the walk to flag
  unbounded growth; optional **OWASP ZAP** active scan against the booted app for runtime vulns.
  Dependency: Playwright **existing**; ZAP **new (external, optional)**.
- Config: `tests/dynamic/walk.ts` (route list + memory-growth ceiling); `zap.conf` (optional).
- Invocation: internal `runDynamicAnalysis(target)`; if ZAP present:
  `zap.sh -cmd -quickurl <baseUrl> -quickout .forge/test-reports/zap.json` (on Windows: the
  bundled `zap.bat`, invoked via the same spawn path — noted below under Windows friction).
- Cadence: **SCHEDULED** + **PRE_DEPLOY**. Runner: `dynamic-analysis`.

### 16. CROSS_BROWSER — Playwright projects
- Tool: **`@playwright/test`** multi-project. Dependency: Playwright **existing** (+ `@playwright/test`).
- Config: `playwright.cross-browser.config.ts` (`projects: [{name:'chromium',use:devices['Desktop Chrome']},
  {name:'firefox',use:devices['Desktop Firefox']},{name:'webkit',use:devices['Desktop Safari']}]`, same E2E `testDir`).
- Invocation: `pnpm exec playwright test --config playwright.cross-browser.config.ts` (first run:
  `pnpm exec playwright install` fetches the three browser binaries — Windows-native, no WSL).
- Cadence: **SCHEDULED** + **PRE_DEPLOY**. Runner: `playwright`.

### 17. CROSS_DEVICE — Playwright device emulation
- Tool: **`@playwright/test`** device descriptors. Dependency: Playwright **existing**.
- Config: `playwright.cross-device.config.ts` (`projects: [{name:'iPhone 13',use:devices['iPhone 13']},
  {name:'Pixel 7',use:devices['Pixel 7']},{name:'iPad Pro 11',use:devices['iPad Pro 11']},
  {name:'desktop-1440',use:{viewport:{width:1440,height:900}}}]`).
- Invocation: `pnpm exec playwright test --config playwright.cross-device.config.ts`.
- Cadence: **SCHEDULED** + **PRE_DEPLOY**. Runner: `playwright`.

### 18. SECURITY — security-scanner + Semgrep + optional ZAP
- Tool: FORGE's existing **`src/tools/security-scanner.ts`** (fast heuristics: hardcoded-secret,
  SQL-injection, XSS, exposed-env, missing-auth, insecure-CORS, vulnerable-dep) + **Semgrep** (SAST) +
  optional **OWASP ZAP** baseline (passive DAST). Dependency: scanner **existing**; Semgrep **existing**
  (Ring 2); ZAP **new (external, optional)**.
- Config: none for the scanner; Semgrep `--config=auto`; ZAP baseline profile.
- Invocation: POST_PROMPT = `runSecurityScan(touchedFiles)` (in-process, existing tool); full =
  add Semgrep + `zap-baseline.py -t <baseUrl> -J .forge/test-reports/zap-baseline.json` (Windows: the
  `zap.bat -cmd` baseline equivalent).
- Cadence: **POST_PROMPT** (touched-file scanner only, lightweight) + **SCHEDULED** + **PRE_DEPLOY**
  (full). Runner: `security-scanner` (Semgrep/ZAP findings merged into `failure_summary`).

### 19. ACCESSIBILITY — accessibility-auditor / axe-core (reuse existing)
- Tool: FORGE's existing **`src/tools/accessibility-auditor.ts`** (Playwright + **axe-core**, WCAG 2.1 AA).
  Dependency: **existing** (`axe-core` + Playwright already present).
- Config: none (auditor discovers routes and runs axe in-page); critical impact blocks.
- Invocation: POST_PROMPT = `runAccessibilityAudit({ routes: [touchedRoute] })` only when
  `hasUiFileChanges` is true; full = all routes.
- Cadence: **POST_PROMPT** (touched UI route only) + **SCHEDULED** + **PRE_DEPLOY** (full). Runner: `axe-core`.

### Load-tool decision (LOAD/STRESS/SOAK/PERFORMANCE) — why k6 on Windows
**k6** is chosen as the load tool. It is a single self-contained **Go binary** with an official
Windows build and first-class installers (`winget install k6.k6`, `choco install k6`, or the signed
MSI), so it runs directly from PowerShell with **no WSL, no Docker, no Python** — the same
"optional external binary, SKIP gracefully if absent" model FORGE already uses for Trivy/Gitleaks in
Sentinel Ring 3. Its scripting is JS (`k6/*.js`), and its `stages` / `ramping-arrival-rate` /
`constant-vus` executors and built-in `thresholds` map exactly onto LOAD (sustained), STRESS
(ramp-to-breakpoint), SOAK (long-duration), and PERFORMANCE (single-user budget) without four
different tools. **Fallback:** because k6 is an external binary a machine may lack, `k6-runner.ts`
degrades to **`autocannon`** — a **pure-Node npm devDependency** (zero external binary, guaranteed
Windows-native) — for a reduced LOAD/PERFORMANCE run when the k6 binary is not on PATH, recording
`runner = 'autocannon'` and a note rather than a false skip of the whole dimension. STRESS/SOAK
require k6's executors and are recorded `skipped` (reason `k6_not_installed`) if k6 is absent —
never faked (T1).

## Governance & Deploy Gate Configurations (F7–F9)
Unlike the 19 suite runners above, F7–F9 write to governance files, not `test_run_results`/
`test_coverage_snapshots` — documented here in the same tool/config/invocation/cadence shape for
completeness.

### F7 — ChangesetGate
- Tool: internal (`appendChangeset()` + the new merge-gate check). Dependency: existing.
- Config: none — the entry format is fixed (timestamp / prompt name / index-of-total / Files
  Created / Files Modified / Files Deleted), matching the already-shipped format exactly.
- Invocation: internal, called automatically inside `forge build`'s per-prompt loop; no CLI flag.
- Cadence: every prompt, immediately after that prompt's commit and before Sentinel; the
  merge-block check fires immediately before `mergeAndTag()`.

### F8 — PreDeployBuildGate
- Tool: **`next build`** + **`next lint`** (Next.js CLI, already a devDependency once a target has
  been scaffolded with Next.js per Phase 2). Dependency: existing per-target — no FORGE-side new
  dependency.
- Config: none new — reads the target's own `next.config.*`/`package.json`.
- Invocation: `pnpm exec next build` then `pnpm exec next lint`, both cwd=target, `-NoProfile`
  PowerShell.
- Cadence: every `forge deploy` invocation, before any existing deploy logic.

### F9 — DeployVerifier
- Tool: internal (`runDeployVerification`) via Node's built-in `fetch`. Dependency: existing
  (Node ≥ 20 global fetch, same as F1's API suite).
- Config: `FORGE_VERIFY_BASE_URL`, `FORGE_VERIFY_LATENCY_BUDGET_MS` (env) or `--base-url`/
  `--latency-budget-ms` (CLI flags) — no file-based config.
- Invocation: `forge verify <path> --base-url <url>`, or auto-invoked at the end of a successful
  `forge deploy`.
- Cadence: once per successful deploy (after F8 clears).

## Reporting Pipeline (raw tool output → Build Memory)
Every runner returns a `TestRunResult`; `test-orchestrator.ts` writes it via
`src/memory/test-results.ts`. Normalization (`normalize.ts`, pure) maps each tool's native output:

- **Vitest JSON reporter** (`--reporter=json --outputFile`): `numTotalTests` → `tests_total`,
  `numPassedTests` → `tests_passed`, `numFailedTests` → `tests_failed`, `numPendingTests` →
  `tests_skipped`; `status` = `'passed'` iff `tests_failed === 0 && numTotalTests > 0`, else
  `'failed'`; each failed assertion → `{name, message, file}` in `failure_summary`.
- **Playwright JSON reporter**: `stats.expected`/`unexpected`/`skipped` → passed/failed/skipped;
  `report_path` → the HTML report folder; per-failure `{title, error.message, file}` → `failure_summary`;
  for CROSS_BROWSER/CROSS_DEVICE the project (browser/device) name is prefixed onto `name`.
- **k6 summary** (`--summary-export`): a threshold-crossing (`metrics.http_req_duration['p(95)'] >`
  budget, or `http_req_failed.rate >` ceiling) → `status = 'failed'`; `tests_total` = number of
  configured thresholds, `tests_passed`/`tests_failed` = thresholds met/crossed; the crossed
  thresholds → `failure_summary`.
- **pnpm audit JSON / Trivy JSON**: each advisory/CVE at or above the gate severity →
  `failure_summary` entry; `tests_total` = advisories scanned, `tests_failed` = count at/above gate;
  `status = 'failed'` iff any CRITICAL (DEPENDENCY_SCAN gate).
- **axe-core results** (via accessibility-auditor's `AccessibilityReport`): `counts.critical` >0 →
  `status = 'failed'`; violations → `failure_summary` `{rule(name), help(message), page(file)}`.
- **security-scanner `SecurityFinding[]`**: any `critical`/`high` → `status = 'failed'`; each finding
  → `{rule, message, file}`.
- **CHAOS / DR / BACKUP_RESTORE harnesses**: return `{assertionsTotal, assertionsPassed, failures}`
  directly in the `TestRunResult` shape; a failed degradation/round-trip/RTO assertion → `'failed'`.

`failure_summary` is a JSON array capped at **20 entries** (SCHEMA_ADDITIONS §5 defers the cap
here); when a runner produces more, the array holds the first 20 and a final synthetic entry
`{name:'…', message:'N additional failures truncated', file:''}`. `report_path` always points at
the full artifact under `<target>/.forge/test-reports/`. `exit_code` records the runner process
exit code (null for in-process harnesses). `duration_ms`, `started_at`, `completed_at`,
`machine_id`, and (when Phase-3-triggered) `build_run_id` + `prompt_index` are set by the
orchestrator, not the runner.

### Coverage snapshots (from `@vitest/coverage-v8` only, T8)
After a UNIT or INTEGRATION run, `normalizeCoverage` reads Vitest's
`coverage/coverage-summary.json` (`total.lines/branches/functions/statements` each `{total, covered,
pct}`) and emits **exactly four** `test_coverage_snapshots` rows — `coverage_type` ∈ `LINE`,
`BRANCH`, `FUNCTION`, `STATEMENT` — each with: `coverage_pct` = `pct`; `lines_total` = `total`;
`lines_covered` = `covered`; `test_run_result_id` = the UNIT/INTEGRATION row's id; `threshold_required`
= configured floor (0.80 default; 0.70 for BRANCH); `threshold_met` = `pct/100 >= threshold_required
? 1 : 0`; `files_below_threshold` = each per-file entry from the summary under floor as `{file, pct}`;
`delta_vs_previous` = `coverage_pct` minus the immediately preceding snapshot of the same
`project_name` + `coverage_type` (looked up via `idx_test_coverage_project`). No other suite writes
coverage rows.

## Sentinel Integration (exact hook points in `phase4-sentinel.ts`)
Sentinel already runs a three-ring pipeline; TestOrchestrator plugs in at two precise points and
adds nothing to Ring 1's mandatory sequence (which stays: tsc → ESLint → build → file-integrity →
`file_delta` → schema-drift → dependency-manifest):

- **POST_PROMPT fast subset — after Ring 1 passes, on EVERY prompt.** In the Sentinel run flow,
  immediately after the mandatory Ring 1 checks return `passed` and before Ring 2's every-10th
  gate, Sentinel calls `runTestSuite({ projectPath, trigger:'POST_PROMPT', buildRunId, promptIndex,
  touchedFiles })`. `cadence.ts` resolves this to `STATIC_ANALYSIS` (which Sentinel largely already
  did in Ring 1 — the orchestrator records the row rather than re-running tsc/ESLint), touched-file
  `UNIT`, touched-file `SECURITY`, and (only if `hasUiFileChanges`) touched-route `ACCESSIBILITY`.
  This is exposed as a new optional Sentinel input `postPromptTests?: { projectPath, touchedFiles }`
  in the exact style of the existing optional `ring2?`/`ring3?` inputs (injectable for tests, SKIPs
  cleanly when absent). A `failed` UNIT/SECURITY/ACCESSIBILITY result fails the Sentinel gate for
  that prompt exactly as a Ring-1 check would, feeding the existing Autonomous Recovery loop
  (Contract 14). The subset is time-boxed at 120 s (T6); on cap it returns `partial` and Sentinel
  treats `partial` as non-blocking-with-warning (not a fail, not a silent pass).
- **Ring 3 full-sweep gate — end-of-run.** Ring 3 already fires on the final prompt / `--ring 3`.
  A new Ring-3 step, sequenced after the existing Trivy/Gitleaks/Lighthouse checks, calls
  `runTestSuite({ projectPath, trigger:'PRE_DEPLOY', buildRunId })` (the full sweep incl. the
  destructive suites behind the isolation guard) OR, when no isolated env is available, consults the
  **latest** persisted rows: it reads the most recent `test_run_results` row per suite for the
  project (`idx_test_run_results_project` / `idx_test_run_results_suite`) and the latest
  `test_coverage_snapshots`, and **gates** on: UNIT/INTEGRATION/API/E2E `status = 'passed'`,
  SECURITY/ACCESSIBILITY/DEPENDENCY_SCAN within their severity gates, and coverage `threshold_met = 1`
  for LINE/STATEMENT/FUNCTION. Any gate miss fails Ring 3 and blocks merge/deploy, with the failing
  suite surfaced in Sentinel's existing diagnostic report. A `skipped` row never satisfies a gate (T1).

## Merge Gate Integration (exact hook point in `phase3-executor.ts`)
F7 plugs into the existing per-prompt loop at two already-identified lines: `appendChangeset()` is
called at line 1776 (decomposed path) and line 1833 (plain path), both already positioned after
that prompt's commit and before its Sentinel run. F7 adds exactly one new consultation point:
`mergeAndTag(ctx, index)` (line 2441, called after Sentinel passes) must read the
`changesetWritten` result from the `appendChangeset()` call for the same prompt index before it
calls `ctx.git.mergeToMain()`. On `changesetWritten === false`, `mergeAndTag` short-circuits — it
does not call `mergeToMain()` or `tagCheckpoint()` — and the prompt's result is marked for
Autonomous Recovery (Contract 14) with reason `changeset_write_failed`, the same halt-and-recover
path a Sentinel failure already takes. No other line in the per-prompt loop changes.

## Deploy & Verify Integration (exact hook points in `src/cli/index.ts`'s `deploy` command)
F8 and F9 both extend the existing `.command('deploy')` action (`src/cli/index.ts`), which today
does: read `BUILD_READY.md` for display → optionally write a monitoring snippet → print "Deploy
step complete." F8 inserts **before** all of that: call `runPreDeployGate(resolved)`; on
`passed === false`, print the recorded blockers, skip straight to `process.exitCode = 1`, and never
reach the `BUILD_READY.md` read. F9 inserts **after** the existing monitoring-snippet block (i.e.,
only once the deploy itself is considered to have gone out): call `runDeployVerification({
projectPath: resolved, baseUrl: opts.baseUrl ?? process.env['FORGE_VERIFY_BASE_URL'] })` when a
`--base-url` (or the env var) is present; when neither is supplied, F9 is skipped for that
invocation with a printed reminder to run `forge verify` manually once a URL exists (a deploy
without a knowable preview/production URL — e.g. a purely local build — cannot be verified over
HTTP, so this is a real skip, not a faked pass). `forge verify` also exists as its own standalone
command for exactly that manual case.

## TOOLCHAIN.md additions
Append to the `## Locked Tool Versions` table (same `| Tool | Required | Status | Version / Path |`
format as the real file). Per-project coverage-threshold overrides also live in TOOLCHAIN.md
(SCHEMA_ADDITIONS §6 references TOOLCHAIN as the override home).

| Tool | Required | Status | Version / Path |
|------|----------|--------|----------------|
| vitest | yes | to-detect | resolved from project `node_modules/.bin/vitest` (devDependency) |
| @vitest/coverage-v8 | yes | to-detect | devDependency — coverage provider (sole coverage source) |
| @vitest/ui | no | to-detect | devDependency — local report explorer only, no gate uses it |
| @playwright/test | yes | to-detect | devDependency — Playwright test runner for E2E/visual/cross-* |
| k6 | no | to-detect | external binary — `winget install k6.k6` / choco / MSI; LOAD/STRESS/SOAK/PERF |
| autocannon | no | to-detect | devDependency — pure-Node k6 fallback for LOAD/PERFORMANCE |
| semgrep | no | present-in-Ring2 | external — SAST (already used by Sentinel Ring 2) |
| trivy | no | present-in-Ring3 | external — SCA/CVE (already used by Sentinel Ring 3) |
| owasp-zap | no | to-detect | external (optional) — DAST for SECURITY(full)/DYNAMIC_ANALYSIS; `zap.bat` on Windows |
| supabase | yes | present | 2.102.0 — backup/restore + DR round-trip (already in TOOLCHAIN) |
| axe-core | yes | present | 4.10.2 — ACCESSIBILITY (already a dependency) |

**Required vs optional rationale:** `vitest`, `@vitest/coverage-v8`, `@playwright/test`, `axe-core`,
and `supabase` are **required** — the core-correctness, coverage, cross-surface, accessibility, and
continuity gates cannot run without them and a missing one is a real defect, not a graceful skip.
`k6`, `autocannon`, `owasp-zap`, `semgrep`, `trivy`, and `@vitest/ui` are **optional** external/aux
tools — their suites SKIP-with-reason (T1) when absent, exactly like Sentinel's existing optional
Ring 3 binaries, so a machine without them still builds and deploys the non-destructive gates.

## Expanded `TESTING.template.md` structure
Phase 2 (Governance Generator) writes this into every generated project's `TESTING.md`. The current
4-section template (`Test Plan Overview`, `Playwright Specifications`, `API Tests`, `Six Laws
Verification Plan`) expands to cover all 19 suite types, grouped by the PRD's five features, with the
cadence policy and coverage floors made explicit. Concrete new section headers:

```
# {{PROJECT_NAME}} — TESTING
> Generated by FORGE 2.0 Phase 2 (Governance Generator) on {{GENERATED_AT}}.
> GOVERNANCE DOCUMENT — read-only during Phase 3 execution (BEHAVIORAL_CONTRACTS Contract 3).

## Test Plan Overview
## Runner & Toolchain            (Vitest primary; Playwright, k6, axe-core, Supabase CLI; per-suite tool table)
## Cadence Policy                (POST_PROMPT fast subset / SCHEDULED nightly / weekly / PRE_DEPLOY / MANUAL)
## Coverage Floors & Thresholds  (LINE/STATEMENT/FUNCTION 80%, BRANCH 70%; per-suite numeric gates)

## F1 — Core Correctness
### Unit Tests                   (Vitest; vitest.config.ts)
### Integration Tests           (Vitest; vitest.integration.config.ts)
### API Tests                   (Vitest + fetch; vitest.api.config.ts)

## F2 — End-to-End & Cross-Surface
### End-to-End (E2E)             (Playwright; playwright.config.ts)
### Visual Regression            (Playwright screenshots)
### Cross-Browser                (chromium / firefox / webkit)
### Cross-Device                 (iPhone 13 / Pixel 7 / iPad Pro 11 / desktop-1440)

## F3 — Performance & Resilience
### Performance                  (k6 + Lighthouse; budgets)
### Load                         (k6 sustained)
### Stress                       (k6 ramp-to-breakpoint)
### Soak                         (k6 endurance)
### Chaos                        (fault-injection harness; graceful degradation)

## F4 — Security & Compliance
### Security                     (security-scanner + Semgrep + optional ZAP)
### Accessibility                (axe-core; WCAG 2.1 AA)
### Dependency Scan              (pnpm audit + Trivy)
### Static Analysis              (tsc + ESLint + Semgrep)
### Dynamic Analysis             (running-app error/leak capture + optional ZAP active)

## F5 — Continuity
### Disaster Recovery            (runbook; RTO/RPO assertions; isolated env only)
### Backup & Restore             (Supabase CLI dump→restore round-trip; isolated env only)

## Isolated-Environment Policy   (which suites are destructive and the isolation guard they require)
## Six Laws Verification Plan    (retained — Contract 19 cross-reference; complementary, not replaced)
```

## Data Flow / Integration Points (Phase 1A/1B/2/3 + scheduled sweep)
- **Phase 1B (Architecture Engine):** already emits API routes, page routes, and interaction maps
  (consumed today by the Six Laws verifier). System 3 reuses these as the **source of truth** for
  which routes E2E/API/ACCESSIBILITY/cross-* iterate — no new architecture artifact is required.
- **Phase 2 (Governance Generator):** now ALSO (a) writes the expanded `TESTING.md` above from the
  template, (b) scaffolds the suite config files into the generated project (`vitest.config.ts`,
  `vitest.integration.config.ts`, `vitest.api.config.ts`, `playwright.config.ts` + the visual/
  cross-browser/cross-device variants, `k6/*.js`, `tests/{e2e,visual,chaos,continuity,dynamic}/`
  skeletons), and (c) adds the new devDependencies (`vitest`, `@vitest/coverage-v8`,
  `@playwright/test`, `autocannon`, optional `@vitest/ui`) to the generated project's `package.json`.
  These scaffolds are governance-generated, not hand-authored (Iron Law 8 — real config, not placeholders).
- **Phase 3 (Build Executor) → Phase 4 (Sentinel):** each prompt execution, after Sentinel Ring 1
  passes, triggers the `POST_PROMPT` fast subset (hook above), writing rows with `trigger =
  'POST_PROMPT'`, `build_run_id`, and `prompt_index` — this is the "runs after every Phase 3 prompt"
  half of the requirement.
- **Scheduled sweep (`node-cron` / `scheduled_tasks`) — the "and on schedule" half:** on FORGE
  startup, TestOrchestrator registers (idempotently, keyed by `scheduled_tasks.name`) two cron
  entries. `scheduled_tasks.task_type` has a fixed CHECK enum that does **not** include a test type,
  so — honoring SCHEMA_ADDITIONS' "no schema change beyond the six tables" rule — both entries use
  the existing `task_type = 'health_check'` with `metadata = {"kind":"enterprise_test_sweep",
  "cadence":"nightly"|"weekly","projects":[...]}`: a **nightly** entry (`cron_expression` e.g.
  `"0 2 * * *"`) that calls `runTestSuite({ trigger:'SCHEDULED' })` for the full non-destructive set,
  and a **weekly** entry (`"0 3 * * 0"`) that adds SOAK and BACKUP_RESTORE. Each executed suite writes
  a `test_run_results` row with `trigger = 'SCHEDULED'` and `build_run_id = NULL`; the cron run's own
  outcome is recorded on the `scheduled_tasks` row (`last_run_at`/`last_result`/`last_duration_ms`).
- **Deploy gate:** `forge test <path> --suite all --trigger pre-deploy` (and Sentinel Ring 3) run the
  full `PRE_DEPLOY` set and block on the Success-Metric gates. This is the only trigger that runs the
  destructive suites, and only when the isolation guard passes.

## Technology Decisions
- **Vitest over keeping `node:test`:** Vitest gives coverage (`@vitest/coverage-v8` → the only
  supported source of `test_coverage_snapshots`), a machine-readable JSON reporter, related-file
  (`--changed`) scoping for the fast subset, and one runner shared by FORGE and generated projects.
  Migration is import-swap, not rewrite (TESTING_PRD §F6). Vitest already appears in Sentinel Ring 2,
  so the toolchain is partly present already.
- **Playwright's own runner (`@playwright/test`) over a Vitest+Playwright-driver hybrid:** Playwright's
  runner natively owns browser lifecycle, the projects/devices matrix, retries, trace, and the HTML
  report; a Vitest hybrid would reimplement all of that for the cross-* matrices with no benefit.
- **k6 (Go binary) + autocannon (Node) fallback over a Linux-only tool:** both run on Windows/
  PowerShell with no WSL; k6's executors cover LOAD/STRESS/SOAK/PERFORMANCE in one tool; autocannon
  guarantees a Node-native floor when the k6 binary is absent.
- **Reuse existing FORGE tools (security-scanner, accessibility-auditor, visual-regression) and
  Sentinel's Semgrep/Trivy/Gitleaks/Lighthouse runners** rather than adding duplicates — DRY and
  consistent with the "no duplicate tool" grounding constraint.
- **Optional external binaries SKIP-with-reason, never fake** (T1), matching Sentinel's existing
  Ring 3 optional-binary behavior — so the required Node/Playwright/Supabase gates always run and the
  optional load/DAST gates degrade honestly.
- **F7 extends existing code rather than adding a new module:** `appendChangeset()` and
  `mergeAndTag()` already exist in `phase3-executor.ts`; the merge gate is a control-flow addition
  to those two functions, not a new file — minimizes surface area for a rule that must fire on
  every single prompt.
- **F8 shells to the Next.js CLI directly rather than re-implementing build/lint checks:** `next
  build`/`next lint` are the actual commands the target ships with; TestOrchestrator/Sentinel
  never re-derive a parallel notion of "does it build" for Next.js targets.
- **F9 reuses Node's built-in `fetch` rather than adding an HTTP client dependency:** identical
  reasoning to F1's API suite — no new dependency for a capability Node already provides natively.

## Environment Variables
| Variable | Required | Purpose |
|----------|----------|---------|
| `FORGE_TEST_BASE_URL` | for E2E/API/LOAD/DYNAMIC | Base URL of the booted target app under test |
| `FORGE_TEST_SUPABASE_REF` | for INTEGRATION/BACKUP_RESTORE/DR | Isolated (non-prod) Supabase project ref |
| `FORGE_TEST_ISOLATED` | for destructive suites | Set `1` only on a proven-isolated target (isolation-guard input) |
| `K6_SOAK_DURATION` | no | Overrides SOAK duration (default `30m`) |
| `FORGE_COVERAGE_THRESHOLD` | no | Overrides coverage floor (default `0.80`; per-project value lives in TOOLCHAIN.md) |
| `SUPABASE_SERVICE_ROLE_KEY` | for continuity suites | Service key for the isolated target only (never production) |
| `FORGE_VERIFY_BASE_URL` | for forge verify | Base URL (Vercel preview or production) that `forge verify`/the post-deploy step checks routes against |
| `FORGE_VERIFY_LATENCY_BUDGET_MS` | no | Overrides the per-route latency blocker threshold (default `2000`) |

## Canonical Rules
1. All 19 `test_run_results.test_suite` enum values have exactly one assigned runner (the 19
   subsections above). No 20th type; no renamed type.
2. Coverage rows come only from `@vitest/coverage-v8`, exactly four per UNIT/INTEGRATION run (T8).
3. A runner that cannot run records `skipped`/`error` with a reason; `passed` is written only on a
   real, completed, zero-failure run (T1). No `skipped` row satisfies any gate.
4. Destructive suites (CHAOS/DR/BACKUP_RESTORE/STRESS/SOAK) run only when `isolation-guard` confirms a
   non-production target (T3).
5. TestOrchestrator writes only to `<target>/.forge/test-reports/` and FORGE Build Memory; never to the
   target's source or governance (T7 / Iron Law 1).
6. Every row carries `machine_id` and is persisted before a run is "complete" (T4 / Contract 4/20).
7. The POST_PROMPT subset is time-boxed (120 s) and reports `partial` on cap, never silently extending
   the build loop (T6).
8. Schema: two tables (`test_run_results`, `test_coverage_snapshots`) appended in
   `initializeForgeMemory()`, added to `ALL_FORGE_TABLES`, version bumped `2.2.1 → 2.3.0`
   (SCHEMA_ADDITIONS §8) — no other schema change; the scheduled sweep reuses `task_type='health_check'`
   with a distinguishing `metadata.kind`, adding no new `scheduled_tasks` enum value.
9. System 3 is complementary to — never a replacement for — Sentinel Ring 1/2/3 and the Six Laws
   verifier (Contract 19). It reuses their runners where suites overlap and adds only the enterprise
   surface they lack.
10. F7's merge gate, F8's pre-deploy build gate, and F9's post-deploy verification are
    governance-artifact capabilities — they write to `CHANGESET.md`, `STATE_OF_THE_BUILD.md`, and
    `SESSION_STATE.md` respectively, never to `test_run_results`/`test_coverage_snapshots`, and
    require no `SCHEMA_ADDITIONS.md` change (T9/T10/T11).
11. `mergeAndTag()` never calls `ctx.git.mergeToMain()` for a prompt whose `changesetWritten` is
    `false` (T9).
12. `forge deploy` never reaches its BUILD_READY/monitoring-snippet logic while a Next.js target's
    `next build`/`next lint` has a recorded non-zero exit for that invocation (T10); a non-Next.js
    target's `skipped` result is never treated as a pass.
