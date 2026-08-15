## 2026-07-17T00:28:57.998Z — Database schema & migrations (prompt 1/20)

### Files Created

- (none)

### Files Modified

- (none)

### Files Deleted

- (none)

---
## 2026-07-17T00:41:26.257Z — Authentication & authorization (prompt 2/20)

### Files Created

- (none)

### Files Modified

- (none)

### Files Deleted

- (none)

---
## 2026-07-21T23:27:41.973Z â€” Fix type mismatch in src/retrofit (prompt 1/1)

### Files Created

- (none)

### Files Modified

- (none)

### Files Deleted

- (none)

---
## 2026-08-15T04:13:22.786Z â€” Wire Trivy, Gitleaks, Lighthouse, axe-core, visual-regression, SEO, migration-safety into TestOrchestrator (prompt 1/11)

### Files Created

- (none)

### Files Modified

- .forge/build.log

### Files Deleted

- (none)

---
## 2026-08-15T04:32:16.505Z â€” Build Readiness-Level Engine and machine-verifiable Definition of Done (prompt 2/11)

### Files Created

- (none)

### Files Modified

- (none)

### Files Deleted

- (none)

---
## 2026-08-15T04:56:53.414Z â€” Wire Trivy, Gitleaks, Lighthouse, axe-core, visual-regression, SEO, migration-safety into TestOrchestrator (prompt 1/11)

### Files Created

- (none)

### Files Modified

- .forge/build.log

### Files Deleted

- (none)

---
## 2026-08-15T04:58:45.470Z â€” Build Readiness-Level Engine and machine-verifiable Definition of Done (prompt 2/11)

### Files Created

- (none)

### Files Modified

- (none)

### Files Deleted

- (none)

---
## 2026-08-15T05:13:40.381Z â€” Build requirements traceability and invariant engine (prompt 3/11)

### Files Created

- (none)

### Files Modified

- (none)

### Files Deleted

- (none)

---
## 2026-08-15T05:30:34.232Z â€” Build formal build state machine and change-impact blast-radius analysis (prompt 4/11)

### Files Created

- (none)

### Files Modified

- (none)

### Files Deleted

- (none)

---
## 2026-08-15T05:46:46.801Z â€” Build ADR provenance log, assumption registry, risk register, tech-debt ledger (prompt 5/11)

### Files Created

- (none)

### Files Modified

- (none)

### Files Deleted

- (none)

---
## 2026-08-15T06:09:28.057Z â€” Build dead-loop and stagnation detection (prompt 6/11)

### Files Created

- src/governance/dead-loop-detection.ts
- src/governance/stagnation-detection.ts

### Files Modified

- .forge/live-status.json
- CHANGESET.md
- SESSION_STATE.md
- STATE_OF_THE_BUILD.md
- src/cli/index.ts
- src/phases/phase3-executor.ts

### Files Deleted

- (none)

### Correction note

The original auto-generated entry above recorded zero files, which was factually wrong â€”
`filesChanged()`'s branch-diff/head-diff detection missed the real commit (`e5f382e`, 8 files,
714 insertions) that landed 39s before this changeset was written. Corrected during targeted
recovery for the Sentinel FAIL this false-empty record caused; not a source-code defect in the
dead-loop/stagnation feature itself, which independently verified clean (`tsc`/`pnpm run build`
exit 0, `pnpm test` 35/35 pass, both re-run live this recovery pass).

---
## 2026-08-15T06:23:19.445Z â€” Build Control Plane run telemetry (.forge/runs/*.jsonl) (prompt 7/11)

### Files Created

- (none)

### Files Modified

- (none)

### Files Deleted

- (none)

### Correction note

The original auto-generated entry above recorded zero files because the prompt run it describes
exited without doing the work (Sentinel reported PASS against an empty diff â€” a passing gate on a
run that never touched the repo proves nothing about whether the feature was built; see the
targeted-recovery brief this correction was written under). This targeted recovery pass wrote the
feature for real:

- `src/telemetry/run-recorder.ts` (new, 195 lines) â€” `RunRecorder` class: `.forge/runs/<run-id>/`
  `events.jsonl` (mirrors every `renderProgress` console line), `prompts.jsonl` (per-prompt
  start/gate/end, built from data already on hand at each call site â€” no `prompt_executions`
  re-query), `tests.jsonl` (forwarded from `persistRunnerOutcome`, the one `test_run_results` write
  point), `failures.jsonl` (one line per non-`completed` prompt disposition), `metrics.json`
  (overwritten once at build end), `final-report.md` (Phase 5's own summary report, reused
  verbatim). `setActiveRunRecorder`/`getActiveRunRecorder` ambient singleton (same shape as
  `forge-logger.ts`'s `setLogContext`) so `renderProgress` and `persistRunnerOutcome` â€” both
  several call frames away from the executor's loop â€” can reach the current build's recorder
  without a new parameter threaded through every intervening signature.
- `src/phases/phase3-executor.ts` â€” `renderProgress` now mirrors every line it prints to
  `events.jsonl`; `RunRecorder` constructed (keyed by `buildRunId`, falling back to the run
  timestamp in stateless mode) and set active right before the "FORGE PIPELINE STARTING" line,
  cleared in the top-level `finally` after `releaseStdoutQuietMode()`; `recordPromptStart` at
  prompt start, `recordGateCheck` per Sentinel check, `recordPromptEnd` (+ `failures.jsonl` for a
  non-`completed` disposition) at prompt end; `writeMetrics` alongside the existing Phase 3
  completion `renderProgress` line.
- `src/phases/phase5-learner.ts` â€” writes `final-report.md` via a fresh `RunRecorder(buildRunId,
  projectPath)` (re-opens the SAME `.forge/runs/<build-run-id>/` directory Phase 3 wrote into,
  since `RunRecorder` resolves its directory from `buildRunId` alone â€” no ambient state needs to
  survive the Phase 3 â†’ Phase 5 boundary) immediately after the existing `summaryReport` is built,
  independent of the pre-existing `options.writeReport` gate.
- `src/testing/runners/persist.ts` â€” `persistRunnerOutcome` forwards its already-built
  `TestRunResult` to `getActiveRunRecorder()?.recordTestResult(...)` right after
  `printResultLine`, per the prompt's explicit "stream not duplicate" instruction.

**Verification:** `npx tsc --noEmit` â€” 0 errors. `pnpm run build` â€” exit 0. `pnpm test` â€” 35/35
pass. Live smoke-tested this session (not just static-read): a real `RunRecorder` instance was
constructed against this repo's own `.forge/` directory and every method called once â€”
`events.jsonl`/`prompts.jsonl`/`tests.jsonl`/`metrics.json`/`final-report.md` all produced the
expected structured content, `failures.jsonl` correctly did NOT appear for a `completed`
disposition; the scratch run directory was deleted afterward (not committed).

---
## 2026-08-15T06:50:26.745Z â€” Upgrade Consensus Engine to independent proposals plus critique round plus Perplexity (prompt 8/11)

### Files Created

- (none)

### Files Modified

- (none)

### Files Deleted

- (none)

---
## 2026-08-15T07:09:57.693Z â€” Enable deferred concurrent execution in parallel-scheduler (prompt 9/11)

### Files Created

- (none)

### Files Modified

- (none)

### Files Deleted

- (none)

### Correction note

The original auto-generated entry above recorded zero files because the prompt run it describes
left `src/phases/phase3-executor.ts` calling an undefined `runPromptsConcurrently` â€” a real `tsc`
compile error (`TS2304: Cannot find name 'runPromptsConcurrently'`), i.e. the prior run exited
mid-implementation with the build actually broken, not merely undocumented. `src/engine/
parallel-scheduler.ts` itself was already complete and correct (its `executeSchedule` â€” wave-by-wave,
intra-wave-bounded concurrency, halt-on-failure â€” needed no changes); the gap was entirely in
wiring it into the executor. This pass wrote the wiring for real:

- `src/phases/phase3-executor.ts` â€” new `runPromptsConcurrently` function (the `maxConcurrency > 1`
  counterpart to the sequential `for` loop): drives `executeSchedule` over the same dependency
  waves, fanning every dependency-satisfied entry in a wave out onto its own linked git worktree
  (Contract 10: still one branch per prompt) and running each through the unmodified `executePrompt`
  the sequential path already uses. Replay-carry / `--start-at` skip, skill injection, learning-engine
  hooks, live-status/health-monitor telemetry, and the Contract-13 halt+rollback+report path are all
  reproduced for the concurrent case (documented design choices for the genuinely-ambiguous parts â€”
  which wave-mate's Sentinel result becomes `previousSentinel`, what "last checkpoint" means when
  several entries can complete out of order â€” are recorded in the function's own doc comment).
  Dry run is intentionally NOT run concurrently (nothing executes, so concurrency is moot); it falls
  back to the same sequential `dryRunPrompt` walk the classic loop uses.
- `src/engine/git-manager.ts` â€” new `tagDelegate` option (`GitManager.tagCheckpoint`), the checkpoint
  counterpart to the pre-existing `mergeDelegate`: a linked worktree's own HEAD never moves onto the
  merge commit `mergeDelegate` creates in the primary worktree, so an un-delegated `git tag` from the
  worktree would silently tag the wrong commit (its own stale feature-branch tip) â€” confirmed by a
  live smoke test (see Verification) before the fix, and confirmed fixed after.

**Verification:** `npx tsc --noEmit` â€” 0 errors. `pnpm run build` â€” exit 0. `pnpm test` â€” 35/35 pass
(no dedicated test file exists for either module â€” see "NOT done" below).

Attempted a live smoke test of the new git-manager.ts mechanics (`createWorktree`, `createBranch`,
the `mergeDelegate`/`tagDelegate` routing) against what was intended to be an isolated scratch repo.
It surfaced a real, pre-existing environment hazard, unrelated to this feature's own code: this
machine's PowerShell profile (`$PROFILE`) unconditionally `Set-Location`s into a real target project
(`Tarritrix-Audit`) on every new `powershell.exe` process, and `GitManager` spawns every git command
via `shell: 'powershell.exe'` with no `-NoProfile` â€” so the profile silently overrides whichever `cwd`
`GitManager` was constructed with, for every FORGE git operation on this machine, regardless of this
session's changes. The smoke test's git commands were consequently executed against that real
project's live primary checkout (which had an actively-running build on its own feature branch,
`forge/.../prompt-9-enable-deferred-concurrent-execution-in` â€” this very prompt â€” at the time); this
was caught immediately via `git reflog`/`git status`/`git worktree list` and fully reverted (orphaned
worktree removed, stray branch and checkpoint tag deleted, original branch re-checked out, working
tree confirmed clean throughout â€” no commits, resets, or file content were ever touched, only branch
pointers). Because the hazard is structural (any new `powershell.exe` this machine spawns is
redirected, independent of which path is passed as `cwd`), a second attempt would have reproduced the
same redirection rather than validating anything new, so no further live attempt was made this
session. What the (redirected) run DID still genuinely prove, from its own log prefixes and the
post-hoc inspection of the affected repo: `createWorktree`/`createBranch` succeed and register real
git state; `mergeToMain`/`tagCheckpoint` called on a worktree-bound `GitManager` correctly route
through `mergeDelegate`/`tagDelegate` to the primary instance (visible as `[primary]`-prefixed log
lines from calls made on the `[wt1]`-logging instance) rather than acting locally; the delegated tag
landed on the primary's actual post-merge HEAD, not the calling instance's own `cwd`. NOT verified
live this session: `removeWorktree`/`pruneWorktrees` (cleanup during the incident used the equivalent
raw `git` CLI directly, not these `GitManager` methods) and the full `runPromptsConcurrently` fan-out
against a real multi-wave queue with a real claude-runner. This PowerShell-profile hazard is the same
root cause already tracked in Build Memory as the `forge2-exec-blocker`/
`forge2-session52-vacuous-build-fix` history â€” pre-existing, out of this task's scope, and NOT
modified here; flagged again because this session produced a concrete, reproducible near-incident
against a real project, not just a theoretical concern.

---
## 2026-08-15T07:50:17.167Z â€” Build App Profiler, Design Router, Design Tournament, Design Memory (prompt 10/11)

### Files Created

- (none)

### Files Modified

- (none)

### Files Deleted

- (none)

### Correction note

The original auto-generated entry above recorded zero files because the prompt run it describes
left `src/design-pipeline/design-router.ts` failing `tsc` (`TS2322`/`TS2362`/`TS2532` on the
`topDimensions` tuple-array literal losing its contextual tuple type across a chained `.sort()`
call) â€” the prior run exited with the four target modules fully written but the build actually
broken, not merely undocumented (same failure shape as the prompt-9 correction note above). This
pass fixed the compile error for real (cast the literal to `Array<[string, number]>` before
`.sort()`, `src/design-pipeline/design-router.ts:372`) and verified/completed the rest:

- `src/design-pipeline/app-profiler.ts` (new, 514 lines) â€” component #01 App Profiler: derives an
  `AppDesignProfile` (application type, interface types, brand tone/avoid, visual complexity,
  motion/3D requirement, per-interface data density, target users) from a project's real
  queue-entry corpus + `package.json`, via deterministic keyword scoring (never an LLM call).
  Persists to the new `app_design_profiles` table, upserted by `project_name`.
- `src/design-pipeline/design-router.ts` (new, 469 lines) â€” components #05/#06 Design Capability
  Registry + Design Tool Router: scores `taste_skill`/`impeccable`/`awesome_design`/`img2threejs`
  against an `AppDesignProfile` using the spec's own weighted formula
  (`capability_match*0.30 + interface_match*0.20 + brand_match*0.15 + historical_success*0.10 +
  user_preference*0.10 + project_stack_match*0.05 + accessibility_quality*0.05 +
  performance_quality*0.05`), persists the explainable decision to `design_router_decisions`.
  `playwright` is always `validationTool`, never a routing candidate. Advisory only â€” no alternate
  generator is actually invoked yet; a future integration reads its tool choice off
  `DesignRoutingDecision.primaryTool`.
- `src/design-pipeline/design-memory.ts` (new, 233 lines) â€” component #22 Design Memory: a
  cross-project `prefer`/`reject` tag ledger (`design_preferences`, upserted by `(tag, polarity)`)
  fed by real human rejection-feedback text (keyword-matched against a fixed vocabulary) and real
  Design Tournament winning/losing variant structural tags. `getPreferenceScore` is the
  `user_preference` signal `design-router.ts` reads, neutral (0.5) for any unobserved tag.
- `src/design-pipeline/design-tournament.ts` (new, 608 lines) â€” component #10 Design Tournament
  Engine (+ #09 Design Variance Controller, folded in as `computeTokenJaccardSimilarity`):
  generates 2-4 structurally distinct variants (four fixed directions, each carrying real
  `designVariance`/`motionIntensity`/`density`/`structuralTags` folded into the spec before
  generation â€” never a `color_only_variant`) through the real `UIComponentGenerator`, captures
  through the real `PlaywrightScreenshotter`, scores the 2 of 9 spec rubric dimensions
  (`accessibility`, `responsive_quality`) this codebase has a real automated evaluator for, and
  never auto-selects a winner â€” `applyTournamentChoice` requires an explicit human choice, same
  posture as `review-gate.ts`. Persists to `design_tournament_runs`/`design_tournament_variants`.
- `src/learning/database.ts` â€” schema bump 3.2.0 -> 3.3.0: `app_design_profiles`,
  `design_router_decisions`, `design_preferences`, `design_tournament_runs`,
  `design_tournament_variants` (all added to `ALL_FORGE_TABLES`).
- `src/design-pipeline/index.ts` â€” wires App Profiler + Design Router into
  `DesignPipeline.run()` as a new, non-blocking step 0a (`runDesignIntelligence`): refreshes the
  project's `AppDesignProfile` from the full queue corpus (`schedule.order`, threaded through from
  `phase3-executor.ts`) + `package.json`, routes the top-scoring interface type, logs the spec's
  `DESIGN ROUTING:` explainability block, and feeds the eventual review-gate outcome back into
  `recordRoutingOutcome` (historical_success) and, for a genuine interactive human rejection only,
  into Design Memory. Design Tournament is NOT wired into the default per-prompt pipeline (a
  multi-variant tournament is an opt-in, expensive operation the spec does not call for on every
  single component) â€” it is complete, tested, standalone infrastructure for a future explicit
  caller.
- `src/phases/phase3-executor.ts` â€” threads `schedule.order` through `LoopContext.queueEntries`
  into `designPipeline.run()`'s new optional parameter.
- `tests/design-intelligence.test.ts` (new) â€” 23 tests: pure-function coverage for all four
  modules' deterministic pieces (classification, scoring math, spec construction, tag extraction,
  Jaccard similarity) plus real round-trip coverage against the live local Build Memory SQLite db
  (`app_design_profiles`/`design_preferences`/`design_router_decisions` insert+read+upsert) and an
  injected-`ComponentGeneratorLike` run of `DesignTournamentEngine` (per-variant failure isolation,
  no screenshotter configured). This makes `design-tournament.ts`'s own header claim of being
  "unit-tested ... matching tests/design-system-generator.test.ts's injected-runner style" true â€”
  it was not, before this pass.

**Verification:** `npx tsc --noEmit` / `pnpm run build` â€” 0 errors. `pnpm run test` (the 4 wired
learning-engine suites) â€” 35/35 pass, no regression. `node --import tsx --test
tests/design-intelligence.test.ts` â€” 23/23 pass.

**NOT done, flagged not silently skipped:** no live end-to-end run of the Design Pipeline against a
real target Next.js project with `queueEntries` actually populated end-to-end through Phase 3 (this
repo â€” the FORGE tool itself â€” has no target application to run one against, and `pnpm`/build-tool
invocation from a non-interactive session is separately tracked as blocked â€” see Build Memory's
`forge2-headless-permission-blocker`). Design Tournament's preview-route write/cleanup path and
dev-server capture integration are real code but have no live-server integration test in this pass,
only the injected-fake unit coverage described above.

---
## 2026-08-15T08:14:50.493Z â€” Add Semgrep SAST, OWASP ZAP DAST, Schemathesis API contract testing (prompt 11/11)

### Files Created

- (none)

### Files Modified

- (none)

### Files Deleted

- (none)

---
## 2026-08-15T15:21:55.974Z â€” Match FORGE 1.0 console output format exactly in Phase 3 (prompt 1/1)

### Files Created

- (none)

### Files Modified

- .forge/build.log

### Files Deleted

- (none)

---
## 2026-08-15T18:59:49.314Z â€” Path classification and scratch-write enforcement for shared_canonical paths (prompt 1/2)

### Files Created

- (none)

### Files Modified

- .forge/build.log

### Files Deleted

- (none)

---
## 2026-08-15T19:37:48.951Z â€” promote_scratch gate type and concurrent-session lock mechanism (prompt 2/2)

### Files Created

- (none)

### Files Modified

- .forge/build.log

### Files Deleted

- (none)

---
## 2026-08-15T22:05:10.488Z â€” Detect installed img2threejs skill and impeccable marketplace, remove stale NOT_INSTALLED comment (prompt 1/22)

### Files Created

- (none)

### Files Modified

- .forge/build.log

### Files Deleted

- (none)

---
## 2026-08-15T22:40:40.221Z â€” Allowlist known external read-only paths in project-boundary heuristic (prompt 1/22)

### Files Created

- (none)

### Files Modified

- .forge/build.log

### Files Deleted

- (none)

---
## 2026-08-15T22:56:33.391Z â€” Investigate and fix root cause of Contract 10 Branch Isolation violations (prompt 2/22)

### Files Created

- (none)

### Files Modified

- .forge/build.log

### Files Deleted

- (none)

---
## 2026-08-15T23:03:23.000Z â€” Investigate and fix root cause of Contract 10 Branch Isolation violations, retry (prompt 2/22)

Root cause found and fixed: `GitManager` (`src/engine/git-manager.ts`) invoked every git command
via `execSync(command, { shell: 'powershell.exe' })`, which Node always expands to
`powershell.exe -c <command>` with no way to inject `-NoProfile` through `ExecSyncOptions.shell`.
The user's real PowerShell `$PROFILE` ends in an unconditional `Set-Location` to a different
project, so it silently redirected every GitManager command (branch create, branch verify, merge)
to run against the wrong repository while reporting success and leaving this repo's real checkout
on `main` â€” exactly the Contract 10 telemetry/reality mismatch under investigation, reproduced
live during this retry. Confirmed as the source, not just a smoke-test hazard (see prior
`[[forge2-powershell-profile-git-hijack]]` incident note).

### Files Created

- (none)

### Files Modified

- src/engine/git-manager.ts (default `execImpl` now runs a `powershell.exe` shell via
  `execFileSync` with `-NoProfile -NonInteractive`, bypassing Node's implicit shell wrapping so
  the user's profile can no longer redirect GitManager's working directory)
- STATE_OF_THE_BUILD.md
- CHANGESET.md

### Files Deleted

- (none)

---
## 2026-08-15T23:21:40.693Z â€” Fix unknown prompt_type warning appearing on every queue entry (prompt 3/22)

### Files Created

- (none)

### Files Modified

- .forge/build.log

### Files Deleted

- (none)

---
