# FORGE 2.0 — System 3: Enterprise Test Suite — PRODUCT REQUIREMENTS DOCUMENT

> Third of three governance packages (`RESURRECTION_PRD.md`, `LEARNING_PRD.md`, this file).
> **Read `upgrades/SCHEMA_ADDITIONS.md` first** — it is the authoritative schema contract. This
> PRD may not invent a table or column not defined there. The two tables this system writes —
> `test_run_results` and `test_coverage_snapshots` — are SQLite tables in FORGE's single
> Build-Memory file `~/.forge/forge_memory.db` (better-sqlite3), NOT Supabase. Never read this PRD
> as authorizing Postgres/Supabase DDL for FORGE's own memory. `test_run_results.test_suite`
> carries a fixed CHECK enum of exactly 19 suite types; this document covers every one of them and
> names no 20th.

## Product Overview
System 3 is the **Enterprise Test Suite** — a general-purpose, multi-tool test surface that
FORGE runs against **the applications it builds** (not against FORGE's own source; that is
covered by FORGE's existing `tests/` and Sentinel). It is orchestrated by one new agent,
**`TestOrchestrator`** (`src/testing/test-orchestrator.ts`, Status: NOT_STARTED), which drives
every one of the 19 suite types defined by `test_run_results.test_suite`, normalizes each tool's
raw output into `test_run_results` / `test_coverage_snapshots` rows, and exposes a cadence policy
so a fast subset runs after every Phase 3 prompt while the full, heavy surface runs on a schedule
and before deploy.

The primary runner is **Vitest**. Vitest natively executes UNIT, INTEGRATION, and API suites and,
via `@vitest/coverage-v8`, produces the coverage data that becomes `test_coverage_snapshots`
rows. The 12 suite types Vitest cannot natively cover (E2E, cross-surface, load/resilience,
security, accessibility, continuity, dynamic analysis) are delegated to purpose-built tools —
each named concretely below — and every one is invokable from **PowerShell on Windows without
WSL** (BEHAVIORAL_CONTRACTS Contract 6).

## Problem Statement
FORGE ships **working** apps today. After every Phase 3 prompt, Phase 4 Sentinel runs a fast,
~18-tool, three-ring quality pipeline — Ring 1 (tsc, ESLint, build, file-integrity,
`file_delta`, schema-drift, dependency-manifest) on **every** prompt; Ring 2 (Vitest, Semgrep,
knip) on every 10th and the final prompt; Ring 3 (Trivy, Gitleaks, Lighthouse) at end-of-run —
and the F13 Six Laws verifier confirms five governance-completeness laws (SCHEMA/API/UI/DATA/
WIRING) about the built app before deploy.

Those gates prove the app **compiles, builds, is governance-complete, and is not obviously
broken**. They do **not** prove it survives production. FORGE has, today, **zero systematic
coverage** of: how the app behaves under sustained or spiking load; whether it degrades
gracefully when a dependency (Supabase, an upstream API) fails; whether it is accessible to users
with disabilities across its whole route surface; whether it renders and functions correctly on
browsers and devices other than the one it was screenshotted on; and whether its backup/restore
and disaster-recovery procedures actually round-trip data. These are precisely the gaps that turn
a green MVP into a production incident — a checkout page that collapses under Black-Friday load, a
form unusable with a screen reader, a Safari-only layout break, a "backup" that never restored.
System 3 closes those gaps by making all 19 enterprise test dimensions first-class, measured, and
gate-enforced, without slowing the per-prompt build loop.

## Target User
- **Reid Whitesides** — non-technical single operator, building software via the Visual AI Method
  across multiple businesses. He cannot hand-write k6 scripts, Playwright cross-browser matrices,
  or chaos-injection harnesses, and he cannot personally read a load-test summary and decide
  whether 240 ms p95 at 500 VUs is acceptable. He needs FORGE to generate, run, threshold, and
  **report pass/fail in plain terms** for all 19 dimensions, and to **block a deploy** when a
  dimension fails — the same "governed autonomy" contract as the rest of FORGE.
- **The end-users of the apps FORGE builds** — the customers of Reid's businesses, who are the
  ones actually harmed by the untested gaps above: the shopper whose cart 500s under load, the
  screen-reader user who cannot submit a form, the mobile user on a broken layout, the account
  whose data is lost because "restore" was never exercised. System 3 exists to protect them, not
  merely to satisfy a checklist.

## Success Metrics
All numeric, all observable in Build Memory or a report artifact:

1. **Suite coverage of the 19 dimensions.** Today: **0 of 19** suite types have any automated
   runner wired for built apps. Target: **19 of 19** have an assigned runner and at least one
   real (non-skipped) recorded `test_run_results` row before a project's first deploy.
2. **Coverage floor, gate-enforced pre-deploy.** `test_coverage_snapshots.threshold_required`
   defaults to **0.80**. LINE ≥ 80%, STATEMENT ≥ 80%, FUNCTION ≥ 80%, BRANCH ≥ 70% (branch floor
   is lower by deliberate policy — see F1). A `PRE_DEPLOY` UNIT run whose LINE/STATEMENT/FUNCTION
   snapshot has `threshold_met = 0` blocks deploy.
3. **Per-prompt fast-subset duration.** The `POST_PROMPT` fast subset (F-cadence below) must
   complete in **≤ 90 s at P95** and is hard-capped at **120 s**; on cap, the offending suite is
   recorded `status = 'partial'` (never silently dropped) and the cap event is surfaced. This
   keeps the Phase 3 loop fast — full heavy suites never run per-prompt.
4. **Pass-rate gates before Sentinel Ring 3 clears** (end-of-run) and before `PRE_DEPLOY`:
   UNIT / INTEGRATION / API / E2E must be **100% passed** (`tests_failed = 0`, `status = 'passed'`);
   SECURITY must have **0 critical and 0 high** findings; ACCESSIBILITY must have **0 critical**
   (axe `impact = critical`) violations; DEPENDENCY_SCAN must have **0 critical** advisories.
5. **Zero fabricated passes.** 100% of suites whose runner/binary is unavailable are recorded
   `status = 'skipped'` or `'error'` with a note — **never** `'passed'` (Testing Iron Law T1). A
   `'skipped'` row never counts toward a pass gate.
6. **Regression visibility.** Every `PRE_DEPLOY` UNIT run records `delta_vs_previous` per coverage
   type; a deploy that would drop LINE coverage by **> 2.0 percentage points** vs. the prior
   snapshot is flagged for human confirmation (non-blocking warning, blocking only if it crosses
   below `threshold_required`).
7. **CHANGESET.md merge-gate coverage.** 100% of prompts whose feature branch merges to main have
   a preceding `changesetWritten = true` recorded for that prompt; a merge with
   `changesetWritten = false` is 0% acceptable (T9). Today this is unenforced (write failures are
   logged and swallowed), so today's actual rate is unmeasured — F7 exists to make it measurable
   and enforced.
8. **Pre-deploy build-gate honesty.** 100% of `forge deploy` invocations against a project with a
   failing `next build`/`next lint` are blocked before monitoring-snippet/BUILD_READY logic runs
   (from 0% today — the current stub runs neither command).
9. **Post-deploy route verification.** 100% of Phase-1B-declared API routes receive a real HTTP
   check within `forge verify` after every deploy; 0 routes are ever reported `PASSED` without an
   actual recorded response (T11).

## Scope Boundaries (explicit non-goals)
- **Does not replace Phase 4 Sentinel Ring 1/2/3.** Sentinel remains the fast per-prompt/per-10th/
  end-of-run health gate on FORGE's own build loop. System 3 is invoked *by* Sentinel for the
  per-prompt fast subset and gated *at* Ring 3, but it does not remove or duplicate any existing
  ring check (tsc, ESLint, build, file-integrity, `file_delta`, schema-drift, Semgrep, knip,
  Trivy, Gitleaks, Lighthouse all stay where they are; TestOrchestrator reuses them where a suite
  type maps onto one, rather than re-implementing them).
- **Does not replace the F13 Six Laws verifier (Contract 19).** Six Laws verifies FORGE's **own
  governance-completeness contract** about the built app — that every declared table/route/page
  exists, is wired, and serves real data. System 3 verifies the built app's **actual runtime
  correctness, performance, security, accessibility, and continuity**. A Six Laws pass says "the
  app is complete as specified"; a System 3 pass says "the completed app survives production." The
  two are complementary and both required before deploy. Where they touch (Law 2 API existence vs.
  System 3's API suite functional assertions; Law 3 UI render vs. System 3 ACCESSIBILITY/E2E),
  System 3 is the stricter, functional superset and does not weaken any Six Laws gate.
- **Does not run destructive CHAOS / DISASTER_RECOVERY / BACKUP_RESTORE / STRESS / SOAK suites
  against a live production database or environment.** These suites refuse to run unless an
  **isolated-environment guard** passes (F5 / T3): the target Supabase project ref, connection
  string, and app base URL must all resolve to a non-production environment (a dedicated test
  project ref, a `localhost`/preview URL, or an explicitly `--allow-destructive`-flagged isolated
  target). Absent that guard the suite is recorded `status = 'skipped'` with reason
  `isolated_environment_required`, never run.
- **Does not author product test *intent*.** TestOrchestrator generates and runs the harnesses and
  scaffolds; the human-meaningful acceptance criteria for a given feature still originate in the
  PRD/architecture the app was built from. System 3 asserts the *mechanics* are covered, not that
  the product decisions were correct.
- **Does not add a hosted/multi-tenant database.** All results persist to the existing
  single-operator SQLite Build Memory. No RLS, no Postgres (SCHEMA_ADDITIONS §7).

## Feature Requirements

### F1: Core Correctness Suite (UNIT, INTEGRATION, API)
The Vitest-native core. **UNIT** — isolated function/module tests run under `vitest run` with
`@vitest/coverage-v8`; produces the four `test_coverage_snapshots` rows (LINE/BRANCH/FUNCTION/
STATEMENT) per run. **INTEGRATION** — Vitest tests that exercise real module wiring against a
throwaway SQLite/Supabase test instance (setup/teardown per Vitest `globalSetup`). **API** —
Vitest tests that issue real HTTP requests against a booted instance of the built app using Node's
built-in `fetch`/`undici` (supertest-style, no extra dependency), asserting status codes and JSON
shape for every contract route. Coverage floors: LINE/STATEMENT/FUNCTION ≥ 80%, BRANCH ≥ 70%
(branch is lower because generated apps carry defensive error branches that are correct but
costly to fully exercise; 70% is the enforced floor, 80% the aspirational target reported in the
coverage delta).

### F2: End-to-End & Cross-Surface Suite (E2E, VISUAL_REGRESSION, CROSS_BROWSER, CROSS_DEVICE)
Playwright-driven (Playwright is already a FORGE dependency). **E2E** — `@playwright/test`
executes full user-journey specs against a booted app. **VISUAL_REGRESSION** — Playwright
`toHaveScreenshot()` diffing, reusing FORGE's existing `src/tools/visual-regression.ts` baseline
mechanics. **CROSS_BROWSER** — the same E2E specs re-run across Playwright's `chromium`,
`firefox`, and `webkit` projects. **CROSS_DEVICE** — the same specs re-run under Playwright device
descriptors (`iPhone 13`, `Pixel 7`, `iPad Pro 11`, plus a desktop 1440×900 baseline). All four
use the **Playwright test runner** (`@playwright/test`), not a Vitest+driver hybrid — decided
explicitly (F2 Technology Decision in the Blueprint): Playwright's runner owns browser lifecycle,
projects/devices matrix, retries, trace, and HTML report natively, and forcing it under Vitest
would reimplement that for no gain.

### F3: Performance & Resilience Suite (PERFORMANCE, LOAD, STRESS, SOAK, CHAOS)
**PERFORMANCE** — single-user latency/throughput budgets via **k6** (`http_req_duration` p95
threshold) plus the existing Ring-3 Lighthouse score for the UI. **LOAD** — k6 sustained
concurrent load (`constant-vus` / `ramping-vus` to a target VU count) asserting p95 latency and
error-rate thresholds. **STRESS** — k6 `ramping-arrival-rate` pushed past capacity to find the
breakpoint, asserting the app fails gracefully (bounded error rate, no crash) rather than a fixed
latency budget. **SOAK** — k6 constant moderate load held for a long duration (default 30 min,
configurable) to surface memory leaks / resource exhaustion. **CHAOS** — a TestOrchestrator-owned
fault-injection harness (see F3 Blueprint): inject a Supabase/API failure (Playwright route
interception returning 500/timeout, or an env-toggled bad connection string) and assert the app
**degrades gracefully** — shows an error state, retries, or falls back — rather than white-screening
(this is the runtime counterpart to Six Laws Contract 19 Law 3/4 patterns). k6 is the chosen
load tool; rationale and Windows story in the Cadence/Toolchain sections.

### F4: Security & Compliance Suite (SECURITY, ACCESSIBILITY, DEPENDENCY_SCAN, STATIC_ANALYSIS, DYNAMIC_ANALYSIS)
**SECURITY** — reuses FORGE's existing `src/tools/security-scanner.ts` (hardcoded-secret /
SQL-injection / XSS / exposed-env / missing-auth / CORS heuristics) as the fast per-prompt layer,
plus **Semgrep** (`--config=auto`, already wired in Sentinel Ring 2) as SAST, plus an optional
**OWASP ZAP baseline** passive scan as the DAST layer for the running app. **ACCESSIBILITY** —
reuses FORGE's existing `src/tools/accessibility-auditor.ts` (Playwright + **axe-core**, already a
dependency) for WCAG 2.1 AA auditing across every route. **DEPENDENCY_SCAN** — `pnpm audit --json`
(FORGE/generated projects use pnpm) plus **Trivy** `fs` (already wired in Sentinel Ring 3) for
CVE/SCA coverage. **STATIC_ANALYSIS** — `tsc --noEmit` + ESLint + Semgrep (all already exist in
Sentinel Ring 1/2); this is the primary **per-prompt** suite. **DYNAMIC_ANALYSIS** — distinct from
static: exercises the *running* app and captures runtime signals — unhandled exceptions and
console errors during a Playwright-driven walkthrough, Node process memory/CPU sampling over that
walk, and an optional OWASP ZAP **active** scan — asserting zero unhandled runtime errors and no
unbounded memory growth.

### F5: Continuity Suite (DISASTER_RECOVERY, BACKUP_RESTORE)
**BACKUP_RESTORE** — exercises the generated project's actual backup/restore procedure end-to-end
against an **isolated** Supabase test project: `supabase db dump` (or the project's documented
backup command) → wipe/recreate isolated target → restore → assert a known seed row round-trips
byte-identically. **DISASTER_RECOVERY** — exercises the project's documented failover/recovery
runbook (e.g. point-in-time restore, region/replica failover as declared in the app's
governance): trigger the loss scenario against the isolated target, run the runbook, and assert
the app is serving correct data within its declared RTO/RPO. Both are hard-gated behind the
isolated-environment guard (Scope Boundaries / T3) and never touch production.

**Every one of the 19 enum values is named above:** UNIT, INTEGRATION, API (F1); E2E,
VISUAL_REGRESSION, CROSS_BROWSER, CROSS_DEVICE (F2); PERFORMANCE, LOAD, STRESS, SOAK, CHAOS (F3);
SECURITY, ACCESSIBILITY, DEPENDENCY_SCAN, STATIC_ANALYSIS, DYNAMIC_ANALYSIS (F4);
DISASTER_RECOVERY, BACKUP_RESTORE (F5).

### F6: Vitest Primary-Runner Migration
Vitest becomes the primary test runner. **New devDependencies** (added to FORGE's `package.json`,
and scaffolded into every generated project's `package.json` by Phase 2):
- `vitest` — the runner itself (executes UNIT/INTEGRATION/API; provides the `describe`/`it`/`test`/
  `expect` API).
- `@vitest/coverage-v8` — V8-based coverage provider; the **sole** source of
  `test_coverage_snapshots` rows.
- `@vitest/ui` — **optional** (dev convenience only; a local browser coverage/report explorer). Not
  required for any gate and not installed in CI/headless contexts.
- `@playwright/test` — Playwright's own test runner for F2 (Playwright core is already present;
  this adds its runner/config surface).

**Migration of the existing ~31 `node:test`/tsx test files** (`node --import tsx --test
tests/*.test.ts`): migrate by **import-swap, not rewrite.** Vitest exposes a compatible
`describe`/`it`/`test` API, so each file changes from relying on `node:test`'s implicit globals /
`import { test, describe } from 'node:test'` and `node:assert` to `import { describe, it, expect }
from 'vitest'` (with `vitest`'s `globals: true` an even smaller diff is possible). Assertions
move from `node:assert`'s `assert.equal(a, b)` to Vitest's `expect(a).toBe(b)` — a mechanical
per-assertion substitution, not a logic change. This is justified because: (a) the test *logic*
(arrange/act/assert, the injectable-collaborator house style) is runner-agnostic and unchanged;
(b) Vitest then gives coverage (`@vitest/coverage-v8`), watch mode, and a JSON reporter the
`node:test` runner lacks; (c) it unifies FORGE's own tests and generated-project tests under one
runner. The `package.json` `test`/`test:memory` scripts are repointed to `vitest run`. This
migration is **additive and reversible per file** — files migrate incrementally; a not-yet-migrated
`node:test` file still runs, so the suite is never red mid-migration.

### F7: CHANGESET.md Generation & Merge Gate
**Current state (partially shipped, `d5313ea`):** `appendChangeset()` (`src/phases/phase3-executor.ts`)
already runs after every Claude Code run + commit — both the plain-prompt and decomposed-prompt
execution paths call it (lines 1776 and 1833) — and before that prompt's Sentinel evaluation. It
writes one Markdown entry per prompt to `<project>/CHANGESET.md`:
```
## {ISO timestamp} — {prompt name} (prompt {index}/{totalPrompts})

### Files Created
- ...
### Files Modified
- ...
### Files Deleted
- ...
---
```
The file is created on first write and is never overwritten (append-only, `appendFile`).
`SESSION_STATE.md`'s `## IDE STATUS` block tracks a `Last changeset date` (refreshed by
`syncIdeStatus()` after every successful write) and a manually-set `CHANGESET.md reviewed` flag —
a human-only field, never auto-set. **What F7 adds — the merge gate this document requires:**
today a write failure is only logged and swallowed (`ctx.log(...); return;`) — the prompt still
proceeds to Sentinel and, if Sentinel passes, to `mergeAndTag()`, which calls
`ctx.git.mergeToMain()` regardless of whether the changeset was actually recorded. F7 makes the
write's outcome a first-class gate value (`changesetWritten: boolean`) threaded onto the
per-prompt result, and `mergeAndTag()` refuses to call `ctx.git.mergeToMain()` when
`changesetWritten` is `false` for that prompt — the prompt instead halts for Autonomous Recovery
(Contract 14) with reason `changeset_write_failed`, exactly as a Sentinel failure already halts
the loop. This closes the gap between "the file gets written" (already true) and "nothing merges
without it" (not yet enforced) — Iron Law T9 below.

### F8: Pre-Deploy Build Gate
Not started. `forge deploy <project-path>` (`src/cli/index.ts`) today only reads
`.forge/BUILD_READY.md` for display and optionally writes a monitoring snippet
(`generateMonitoringSnippet`) — it runs **zero** build or lint verification before calling that
"deploy" complete. F8 inserts a mandatory pre-flight step, executed before any of the existing
deploy-command logic: `pnpm exec next build` then `pnpm exec next lint` (both spawned with the
project as cwd, `-NoProfile` PowerShell hardening — Contract 6, the same profile-hijack defense
already documented for every other spawn in TESTING_BLUEPRINT), matching FORGE's own house
convention of a `tsc → build → lint → test` gate order (Iron Laws 6-7). A non-Next.js target (no
`next` in `package.json` dependencies, no `next.config.*` present) records this pair `skipped`
with reason `not_a_nextjs_project` rather than a fabricated pass — the gate never claims to have
checked something it didn't run. On either command's non-zero exit, `forge deploy` does **not**
proceed to the `BUILD_READY.md`/monitoring-snippet logic; instead it appends a
`## Pre-Deploy Blockers` section to `STATE_OF_THE_BUILD.md` (same convention as the existing
`## What Remains (Known Gaps)` section: one numbered entry per blocker) recording the failing
command, its exit code, and a truncated (last ~40 lines) stderr/stdout excerpt, then exits
non-zero. A subsequent `forge deploy` re-run re-evaluates the gate from scratch — the blockers
section is **replaced**, not appended-to, so `STATE_OF_THE_BUILD.md` never accumulates stale
blockers from a since-fixed build.

### F9: forge verify Phase
Not started. A new CLI command, `forge verify <project-path> --base-url <url>`, also auto-invoked
as the final step of a successful `forge deploy` once F8's gate has cleared and the app has
actually gone live — the operator supplies `--base-url` (typically the Vercel preview URL Vercel
prints after deploy) or it is read from `FORGE_VERIFY_BASE_URL`. It reuses the same API-route
source of truth System 3 already established for the F1 API suite and the F13 Six Laws verifier
(Phase 1B's Architecture Engine route list — no new architecture artifact required, per the
existing Data Flow §Phase 1B note below) and, for every declared route, issues one real HTTP
request via Node's built-in `fetch` (no new dependency, same tool choice as F1's API suite)
against `{baseUrl}{route}`, recording: HTTP status code, response time in milliseconds, and a
payload-shape check (response parses as JSON where the route's declared contract says JSON, and
every required top-level key from that contract is present). A route is a **blocker** when: it
returns a 5xx status, returns a status not in its declared contract's expected set, exceeds the
configurable latency budget (`FORGE_VERIFY_LATENCY_BUDGET_MS`, default 2000 ms — deliberately
looser than F1's PERFORMANCE suite's 300 ms single-user budget, because this is a cold-start
preview/production check, not a warmed load test), or fails its shape check. Results are written
to `SESSION_STATE.md` under a new `## Post-Deploy Verification` section: timestamp, base URL, a
route-by-route table (`route | status | latency_ms | shape_ok | verdict`), and an overall
`PASSED`/`BLOCKED` line. **Any blocker fails the phase and blocks build completion** —
`STATE_OF_THE_BUILD.md` is not updated to reflect a successful deploy, and the build's terminal
state stays short of complete until a re-run of `forge verify` passes clean, mirroring the same
"no fabricated pass" posture as every other System 3 gate (T1).

**These three capabilities are governance-artifact features, not `test_run_results` rows** — they
write to `CHANGESET.md`, `STATE_OF_THE_BUILD.md`, and `SESSION_STATE.md` (existing governance
files, per BLUEPRINT Canonical Rule 9's "Phase 3 updates governance after every prompt"
convention), never to Build Memory. This is deliberate: `test_run_results.test_suite`'s CHECK enum
is fixed at exactly 19 values and this document names no 20th (per this PRD's own header warning);
F7–F9 sit alongside that 19-suite surface rather than inside it, and require no
`SCHEMA_ADDITIONS.md` change.

## Cadence Policy (explicit, non-contradictory)
The task requirement "runs after every Phase 3 prompt **and** on schedule" resolves into **four
triggers**, matching `test_run_results.trigger` (`POST_PROMPT` / `SCHEDULED` / `MANUAL` /
`PRE_DEPLOY` / `CI`). Not all 19 suites run per-prompt — that would make builds impossibly slow.

- **`POST_PROMPT` — fast subset, after EVERY Phase 3 prompt (≤ 90 s P95):** `STATIC_ANALYSIS`
  (tsc + ESLint, already Ring 1), `UNIT` (only tests related to files the prompt touched, via
  Vitest `--changed`/related-files), a **lightweight** `SECURITY` pass (the existing
  `security-scanner.ts` on touched files only), and a **lightweight** `ACCESSIBILITY` pass
  (axe-core on the single route whose UI file changed, only when a UI file changed —
  `hasUiFileChanges`). These four are the only per-prompt suites; each is scoped to *touched
  files/routes*, never the whole app.
- **`SCHEDULED` — nightly full sweep (via `node-cron` / `scheduled_tasks`):** full `UNIT` +
  coverage, `INTEGRATION`, `API`, `E2E`, `VISUAL_REGRESSION`, `CROSS_BROWSER`, `CROSS_DEVICE`,
  full `SECURITY` (incl. Semgrep + ZAP baseline), full `ACCESSIBILITY`, `DEPENDENCY_SCAN`,
  `DYNAMIC_ANALYSIS`, `PERFORMANCE`, `LOAD`, and `BACKUP_RESTORE`. **Weekly** (a second cron
  entry): `SOAK`. These run against a non-production target; heavy but non-destructive.
- **`PRE_DEPLOY` — deploy gate (blocking):** the entire nightly set **plus** `STRESS`, a short
  `SOAK`, `CHAOS`, and `DISASTER_RECOVERY` (all four behind the isolated-environment guard). A
  deploy proceeds only when every `PRE_DEPLOY` suite meets its Success-Metric gate.
- **`MANUAL` / on-demand only by default:** `CHAOS`, `DISASTER_RECOVERY`, `SOAK`, and `STRESS` are
  the destructive/slow suites; outside the pre-deploy gate they run **only** on explicit
  `forge test <path> --suite <type>` invocation, never automatically, and never against
  production.

Per-suite cadence rationale (why not uniform): the four per-prompt suites are fast and
touched-file-scoped; E2E/cross-surface need a booted app + real browsers (seconds-to-minutes each)
so they run nightly/pre-deploy, not per-prompt; load/soak/stress take minutes-to-tens-of-minutes
and stress shared infrastructure, so scheduled/pre-deploy/on-demand only; chaos and DR are
destructive and require an isolated environment, so pre-deploy + on-demand only. Sentinel's
existing Ring 2 (every-10th) already runs a full Vitest + Semgrep pass, so the every-10th cadence
is honored by the existing pipeline and TestOrchestrator does not double-run it.

**F7–F9 run outside the four `test_run_results.trigger` values** — they are governance-file gates,
not suite runs, so they carry no `trigger` column value of their own. F7's merge gate fires on
**every prompt** (immediately after that prompt's `appendChangeset()` call, before `mergeAndTag()`
is reached); F8 fires on **every `forge deploy` invocation**, before any deploy logic executes; F9
fires **once per successful deploy**, immediately after F8 clears and the app is live (or on
explicit `forge verify` invocation). None of the three is scheduled, on-demand-only, or
destructive-suite-gated — they always run when their trigger point is reached, with no cadence
ambiguity to resolve.

## User Stories

**US1 — Fast per-prompt safety (F-cadence, F1/F4).**
As the operator, I want a fast test subset to run after every prompt so that a prompt that breaks
a unit test, introduces a type error, leaks a secret, or breaks accessibility on the page it
touched is caught immediately, without slowing the build to a crawl.
Acceptance:
- [ ] After each Phase 3 prompt, a `POST_PROMPT` run records rows for `STATIC_ANALYSIS` and `UNIT`
      (and `SECURITY`/`ACCESSIBILITY` when applicable) with `prompt_index` set.
- [ ] The subset completes ≤ 120 s hard cap; on cap the suite is `status = 'partial'`, not dropped.
- [ ] A failing unit test yields `status = 'failed'` and a non-empty `failure_summary`, and
      Sentinel surfaces it exactly as a Ring-1 failure would.
- [ ] The `ACCESSIBILITY` sub-run fires only when the prompt changed a UI file; otherwise no
      accessibility row is written for that prompt (no false skip is recorded either).

**US2 — Full nightly sweep (F-cadence, F1–F4).**
As the operator, I want the full 19-dimension suite (minus destructive ones) to run nightly so
that heavy checks I can't afford per-prompt still run automatically and I see a fresh full-surface
report each morning.
Acceptance:
- [ ] A `scheduled_tasks` cron entry triggers a `SCHEDULED` sweep; each executed suite writes one
      `test_run_results` row with `trigger = 'SCHEDULED'` and `build_run_id = NULL`.
- [ ] `UNIT`/`INTEGRATION` runs each write four `test_coverage_snapshots` rows (LINE/BRANCH/
      FUNCTION/STATEMENT) with `delta_vs_previous` populated.
- [ ] SOAK runs on the weekly cron, not the nightly one.
- [ ] A suite whose tool is not installed records `status = 'skipped'` with a reason note and does
      not fail the sweep.

**US3 — Coverage floor enforced before deploy (F1, metric 2).**
As the operator, I want deploy blocked when coverage is below floor so that an app never ships
with thin test coverage.
Acceptance:
- [ ] A `PRE_DEPLOY` UNIT run below the LINE/STATEMENT/FUNCTION 80% (BRANCH 70%) floor sets
      `threshold_met = 0` on the relevant snapshot and blocks deploy.
- [ ] `files_below_threshold` lists every offending file with its pct.
- [ ] A coverage drop > 2.0 pts vs. previous snapshot is surfaced even when still above floor.

**US4 — Load & resilience before launch (F3).**
As the operator, I want load, stress, soak, and chaos results before deploy so that I know the app
survives concurrency, spikes, sustained traffic, and dependency failure.
Acceptance:
- [ ] `PRE_DEPLOY` records `LOAD`, `STRESS`, `SOAK`, `PERFORMANCE`, and `CHAOS` rows with
      `runner = 'k6'` (or the harness name for CHAOS) and a `report_path`.
- [ ] LOAD/PERFORMANCE fail when the k6 p95 latency or error-rate threshold is exceeded.
- [ ] CHAOS asserts graceful degradation on injected Supabase/API failure and fails if the app
      white-screens or throws unhandled.
- [ ] STRESS/SOAK/CHAOS refuse to run without the isolated-environment guard (recorded `skipped`).

**US5 — Accessibility & cross-surface correctness (F2/F4).**
As an end-user with a disability or a non-Chrome/mobile device, I want the app audited for WCAG
compliance and verified across browsers/devices so that I can actually use it.
Acceptance:
- [ ] `ACCESSIBILITY` records axe-core results; a critical-impact violation fails the suite.
- [ ] `CROSS_BROWSER` runs the E2E specs on chromium/firefox/webkit; a failure on any one browser
      fails the suite with the browser named in `failure_summary`.
- [ ] `CROSS_DEVICE` runs on at least three device descriptors plus a desktop baseline.

**US6 — Continuity is proven, not assumed (F5).**
As the operator, I want backup/restore and disaster recovery actually exercised so that I know my
users' data can be recovered.
Acceptance:
- [ ] `BACKUP_RESTORE` performs a real dump→restore round-trip on an isolated target and asserts a
      seed row survives; a mismatch fails the suite.
- [ ] `DISASTER_RECOVERY` runs the documented runbook and asserts data is served within declared
      RTO/RPO.
- [ ] Neither suite runs against production; both record the isolated target ref they used.

**US7 — Honest reporting, never a fabricated pass (T1/T3, metric 5).**
As the operator, I want an un-runnable suite reported as failed/error/skipped-with-reason, never
as a silent pass, so that a green board always means green.
Acceptance:
- [ ] A missing runner binary (k6/ZAP/trivy/semgrep absent) yields `status = 'skipped'` + reason,
      never `'passed'`.
- [ ] A crashed runner (non-zero exit, no parsable report) yields `status = 'error'` with the
      exit code, never `'passed'`.
- [ ] No pass gate (Ring 3, pre-deploy) ever treats a `'skipped'` row as satisfying the gate.

**US8 — One command, any suite, any target (Blueprint CLI).**
As the operator, I want a single `forge test` command to run any suite or all of them on demand so
that I can reproduce a failure or re-check one dimension without a full build.
Acceptance:
- [ ] `forge test <project-path> --suite <TYPE> --trigger manual` runs exactly that suite and
      writes one row.
- [ ] `forge test <project-path> --suite all --trigger pre-deploy` runs the full pre-deploy gate
      and exits non-zero if any gate fails.
- [ ] `forge test status <project-path>` prints the latest row per suite type from Build Memory.

**US9 — A durable, gate-enforced changeset record (F7).**
As the operator, I want every merged prompt to carry a CHANGESET.md entry so that I (or a
reviewer) can always answer "what did this prompt actually touch" without re-deriving it from git
diffs, and so a broken write can never silently disappear a prompt's paper trail.
Acceptance:
- [ ] Every successful prompt (plain or decomposed path) appends exactly one
      `## {timestamp} — {name} (prompt i/N)` entry to `<project>/CHANGESET.md` before that
      prompt's Sentinel run.
- [ ] `CHANGESET.md` is created on first write and is never overwritten — re-running a build only
      appends.
- [ ] A write failure sets `changesetWritten = false` and `mergeAndTag()` does not call
      `ctx.git.mergeToMain()` for that prompt; the prompt halts for Autonomous Recovery with reason
      `changeset_write_failed`.
- [ ] SESSION_STATE.md's `## IDE STATUS` `Last changeset date` updates on every successful write;
      `CHANGESET.md reviewed` is never auto-set to `YES` (human-only field, unchanged from current
      behavior).

**US10 — Deploy never ships an app that doesn't build or lint clean (F8).**
As the operator, I want `forge deploy` to refuse to proceed past a failing `next build`/`next lint`
so that I never ship a broken production bundle.
Acceptance:
- [ ] `forge deploy <path>` runs `next build` then `next lint` before any existing deploy logic
      (BUILD_READY read, monitoring-snippet write).
- [ ] Either command's non-zero exit halts `forge deploy` before it prints "Deploy step complete,"
      writes a `## Pre-Deploy Blockers` section to `STATE_OF_THE_BUILD.md` (command, exit code,
      truncated output), and exits non-zero.
- [ ] A non-Next.js target records both checks `skipped` (reason `not_a_nextjs_project`), never
      `passed`.
- [ ] A second `forge deploy` run after the underlying issue is fixed replaces (not appends to) the
      blockers section and proceeds normally.

**US11 — Post-deploy verification is real, not assumed (F9).**
As the operator, I want every declared API route checked against the actual deployed URL after
every deploy so that "the deploy succeeded" means the app is actually serving correctly, not just
that the build compiled.
Acceptance:
- [ ] `forge verify <path> --base-url <url>` (or the auto-invoked post-deploy step) issues a real
      HTTP request to every route Phase 1B declared and records status code, latency, and
      shape-check result for each.
- [ ] A 5xx, an undeclared status, a latency above `FORGE_VERIFY_LATENCY_BUDGET_MS`, or a failed
      shape check marks that route (and the overall phase) `BLOCKED`.
- [ ] Results are written to `SESSION_STATE.md`'s `## Post-Deploy Verification` section with a
      route-by-route table and an overall verdict.
- [ ] A `BLOCKED` verdict prevents `STATE_OF_THE_BUILD.md` from being updated to reflect a
      successful deploy; the build is not considered complete until a clean re-run.

## Testing Iron Laws
FORGE uses an ambient, informally-numbered "Iron Law N" convention (Iron Law 1 = governance docs
are read-only during execution; Iron Law 3 = never fabricate an outcome, report real results;
Iron Law 8 = no mocks/placeholder data in production code). There is no canonical numbered list
file, so to avoid collision these System-3 rules are numbered **independently as T1..T8** and
each cross-references the ambient Iron Law it descends from.

- **T1 — A suite that cannot run is FAILED/ERROR/SKIPPED-with-reason, never a silent pass.**
  Consistent with Iron Law 3 (never fabricate an outcome). `test_run_results.status` has a
  distinct `'skipped'` value; it means "did not execute, here is why," and **must never be used to
  hide a real failure** or counted toward any pass gate. A runner whose binary is absent →
  `'skipped'` + note; a runner that crashed → `'error'` + `exit_code`; a runner that ran and had
  failing cases → `'failed'`. `'passed'` is written only when the runner ran to completion with
  zero failures.
- **T2 — Real runs against a real, running target; no mocked test outcomes.** Descends from Iron
  Law 8. API/E2E/LOAD/DYNAMIC suites exercise a genuinely booted instance of the built app; a
  suite may never assert against a stubbed server standing in for the app under test. (Deliberate,
  declared fault-injection in CHAOS is not a mock — it is the system under test.)
- **T3 — Destructive suites require a proven isolated environment.** CHAOS, DISASTER_RECOVERY,
  BACKUP_RESTORE, STRESS, SOAK refuse to run unless the isolated-environment guard confirms the
  target is non-production. Descends from Iron Law 1's spirit (never damage protected state) and
  Contract 6 (target-project-scoped execution). No `--force` bypasses production detection; only an
  explicit isolated `--allow-destructive` target is honored.
- **T4 — Every result is attributed and persisted.** Every run writes exactly one
  `test_run_results` row (plus coverage rows for UNIT/INTEGRATION) carrying `machine_id`
  (Contract 4/20) before the run is considered complete. A run whose Build-Memory write fails
  degrades to stateless mode (Contract 4) but still reports its outcome to the caller — it does not
  fabricate success.
- **T5 — Thresholds are data, not prose.** Every pass/fail decision (coverage floors, k6 latency/
  error thresholds, axe impact, audit severity) is a concrete numeric threshold stored in config
  (TOOLCHAIN.md / suite config files) and echoed into the row (`threshold_required`,
  `failure_summary`), so "why did this fail" is always answerable from data.
- **T6 — The per-prompt subset stays fast or reports `partial`.** The `POST_PROMPT` subset is
  time-boxed (metric 3). It may never silently extend the build loop; on cap it records `partial`
  and yields. Descends from Contract 1/13's "Sentinel runs after every prompt" — the gate must
  stay runnable every prompt.
- **T7 — TestOrchestrator writes nothing to the target's source or governance.** It reads the
  target, boots it, drives it, and writes only report artifacts under the target's `.forge/`
  test-report directory and rows to FORGE's own Build Memory. It never edits the built app's code
  or its governance docs (Iron Law 1).
- **T8 — Coverage is measured by one tool, one way.** `test_coverage_snapshots` rows come **only**
  from `@vitest/coverage-v8`'s report (four dimensions per UNIT/INTEGRATION run). No suite
  estimates or back-fills coverage from any other source; an unmeasured run writes no coverage row
  rather than a guessed one (Iron Law 3 + T1).
- **T9 — Nothing merges without a recorded CHANGESET.md entry.** Descends from Iron Law 3 (never
  fabricate an outcome — a merge with no record of what it merged is an unrecorded outcome) and
  Contract 10/11's feature-branch-then-merge-and-tag workflow. `mergeAndTag()` must observe
  `changesetWritten = true` for the prompt it is about to merge; a `false` value blocks the call to
  `ctx.git.mergeToMain()` and routes the prompt to Autonomous Recovery instead of silently
  proceeding, closing the "logged and swallowed" gap in the current implementation.
- **T10 — Deploy honors the same `tsc → build → lint → test` gate order FORGE enforces on itself.**
  Descends from Iron Laws 6-7 (quality gates must pass before any commit/ship). `forge deploy` may
  never reach `BUILD_READY.md`/monitoring-snippet logic while `next build` or `next lint` has a
  non-zero exit recorded for this run; a `skipped` (non-Next.js) result never counts as a passing
  gate, matching T1's vocabulary even though this gate writes to `STATE_OF_THE_BUILD.md`, not
  `test_run_results`.
- **T11 — A deploy is "verified" only when real HTTP requests against the real deployed URL
  returned real responses.** Descends from Iron Law 3 and is the runtime completion of what other
  FORGE governance calls the Verification dimension (distinct from, and never a substitute for, the
  F13 Six Laws SCHEMA/API/UI/DATA/WIRING pass — Six Laws proves the app is declared-complete;
  `forge verify` proves the declared routes actually answer, post-deploy, over the network). No
  route may be recorded `PASSED` without an actual response; a route the verifier could not reach
  (DNS failure, connection refused) is `BLOCKED`, never silently omitted from the report.

## Success Criteria (roll-up)
- 19 of 19 suite types wired with a real runner and at least one non-skipped recorded run before
  first deploy (from 0 today).
- Per-prompt fast subset ≤ 90 s P95 / 120 s cap; full sweep runs nightly, SOAK weekly, destructive
  suites pre-deploy/on-demand only.
- Coverage floor (LINE/STATEMENT/FUNCTION 80%, BRANCH 70%) enforced at pre-deploy.
- 100% pass required for UNIT/INTEGRATION/API/E2E; 0 critical/high for SECURITY; 0 critical for
  ACCESSIBILITY/DEPENDENCY_SCAN before Ring 3 clears and before deploy.
- Zero fabricated passes: 100% of un-runnable suites recorded skipped/error with reason.
- CHANGESET.md written before Sentinel evaluates every prompt, and no merge proceeds without it
  (F7/T9).
- `forge deploy` blocked on any `next build`/`next lint` failure, blockers recorded in
  `STATE_OF_THE_BUILD.md` (F8/T10).
- Every declared API route HTTP-checked against the live/preview URL after every deploy, results
  written to `SESSION_STATE.md`, failures block build completion (F9/T11).
