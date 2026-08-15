# FORGE 2.0 — BEHAVIORAL CONTRACTS

## Phase Execution Contracts

### Contract 1: Phase Ordering
Phases execute in strict order: 0 → 1A → 1B → 1C (if partial build) → 2 → 3 → 4 (per prompt) → 5.
No phase may begin until the preceding phase has completed successfully.
Phase 4 (Sentinel) runs after EVERY Phase 3 prompt execution, not just at the end.

### Contract 2: Human Gates
Four mandatory human approval gates exist:
- Gate 1: After Phase 1A (PRD). Build halts until approved.
- Gate 2: After Phase 1B (Architecture). Build halts until approved.
- Gate 3: After Phase 2 (Governance + queue.yaml). Build halts until approved.
- Gate 4: Sentinel escalation during Phase 3 (novel errors only; known errors auto-resolve in Autonomous Recovery Mode if enabled).

No mechanism exists to bypass these gates. They are structural, not configurable.

### Contract 3: Governance Immutability During Execution
Once Phase 3 begins, NO governance document may be modified by any prompt or agent.
Governance documents are read-only during execution.
If a prompt attempts to modify a governance document, Sentinel MUST halt the build immediately.

### Contract 4: Build Memory Writes
Every phase writes to Build Memory. Writes include machine_id on every record.
- Phase 0: Writes toolchain_manifest to build_runs
- Phase 3: Writes prompt_executions per prompt
- Phase 4: Writes sentinel_details per check
- Phase 5: Writes error_patterns, resolutions, cross_project_insights, governance_versions

Failure to write to Build Memory is NOT a halting error — FORGE degrades to stateless mode and logs a warning. Build Memory is valuable but not blocking.

## CLI Contracts

### Contract 5: Claude Code Execution
All Claude Code CLI calls use the exact command:
```
claude -p --dangerously-skip-permissions
```
Prompt content is piped via stdin, not file argument.
Every call captures stdout, stderr, and exit code.
Timeout: 15 minutes per prompt. If exceeded, kill process and mark prompt as failed.

### Contract 6: PowerShell Environment
All commands run in PowerShell on Windows.
$env:PATH must include Node.js before any execution.
Working directory is always the target project root, NOT FORGE's own directory.

## Prompt Assembly Contracts

### Contract 7: Context Injection
Every Phase 3 prompt is dynamically assembled from four sources:
1. The queue.yaml entry (task description)
2. Relevant governance document excerpts (SCHEMA_REGISTRY for schema tasks, BEHAVIORAL_CONTRACTS for auth tasks, etc.)
3. Build Memory warnings (known error patterns matching this prompt type/stack)
4. Sentinel status from the previous prompt (if applicable)

Prompts are NEVER hardcoded. They are ALWAYS assembled at execution time.

### Contract 8: Failure Prediction
Before each prompt fires, FORGE queries Build Memory for error patterns matching:
- This stack fingerprint
- This prompt type (schema, auth, ui, etc.)
- This prompt index range

If predicted failure probability > 0.4, FORGE rewrites the prompt using the highest-success-rate template for this task type. Both original and rewritten prompts are logged.

### Contract 9: Dynamic Prompt Rewriting
When rewriting a prompt:
- The task objective MUST remain identical
- The governance references MUST remain identical
- Only the instruction phrasing and approach may change
- The rewrite reason is logged in prompt_executions.rewrite_reason
- Original prompt hash stored in original_prompt_hash

## Git Contracts

### Contract 10: Branch Isolation
Every prompt executes on a dedicated feature branch:
```
forge/{build-id}/prompt-{index}-{name}
```
Main branch never receives direct commits during Phase 3.
Merges to main only occur after Sentinel passes.

### Contract 11: Checkpoint Tags
After each successful prompt + Sentinel pass + merge:
```
forge-checkpoint-{build-id}-{prompt-index}
```
Tags are lightweight (not annotated).
These enable Build Replay from any checkpoint.

### Contract 12: Rollback
On Sentinel failure:
- Feature branch is preserved (not deleted)
- Main is reverted to the last successful checkpoint tag
- Build halts with diagnostic report

## Sentinel Contracts

### Contract 13: Health Check Suite
After every prompt, Sentinel runs IN THIS ORDER:
1. `pnpm tsc --noEmit` — TypeScript compilation
2. `pnpm run build` — Build verification
3. File integrity check — diff against expected file tree
4. Schema drift check — compare DB state to SCHEMA_REGISTRY.md (if schema prompts have run)
5. Dependency check — compare package.json to TOOLCHAIN.md manifest

ALL FIVE must pass. Any single failure halts the build.

### Contract 14: Autonomous Recovery Mode
When enabled (opt-in per build):
- Error patterns with success_rate > 0.90 are auto-resolved without human approval
- Resolution is applied, prompt is re-executed, Sentinel re-runs
- Maximum 2 auto-recovery attempts per prompt. Third failure escalates to human.
- Novel errors (no pattern match) ALWAYS escalate to human.

## Learning Contracts

### Contract 15: Error Pattern Generalization
When a new error is encountered and resolved:
1. Normalize the error message (strip file paths, line numbers, timestamps)
2. Categorize (type_error, build_failure, runtime, schema, auth, dependency, config)
3. Check for existing pattern match (error_signature similarity > 0.85)
4. If new: create error_pattern + resolution
5. If existing: increment occurrence_count, update last_seen_at
6. After 3+ successful resolutions: mark auto_resolve_eligible if success_rate > 0.90

### Contract 16: Template Evolution
Recursive Learner may propose governance template changes ONLY with:
- Evidence: which builds, what data, what metric improved
- Diff: exact text changes proposed
- Impact projection: expected improvement to future builds

Proposed changes are stored in governance_versions with status 'proposed'.
They become active ONLY after human approval.

### Contract 17: Self-Created Agents
FORGE may create new agents ONLY when:
- A task pattern has appeared in 3+ builds
- No existing agent or tool handles the pattern
- The proposed agent passes test validation against historical data

Self-created agents start with status 'proposed'.
They become 'active' ONLY after human approval.
They are subject to all governance contracts.

## Interaction Map Contracts

### Contract 18: Design Granularity
Phase 1B Architecture Engine MUST specify for every user-facing feature:
- Every interactive element (button, dropdown, form field, toggle, tab, link)
- For each element: user action, frontend reaction, API call, backend processing, database write, side effects, success response, error response, tracking event
- No "TBD", "TODO", or placeholder specifications
- No deferred decisions

If the Architecture Engine cannot determine a specification, it applies the most common pattern from Build Memory for that element type and flags the assumption.

### Contract 19: Six Laws Automation
Automated Six Laws verification runs after Phase 3 completes:
1. SCHEMA: Query Supabase, verify every table from SCHEMA_REGISTRY.md exists with correct columns
2. API: HTTP request to every endpoint defined in BEHAVIORAL_CONTRACTS, verify response status and shape
3. UI: Playwright visits every page route, checks no "coming soon" or placeholder text
4. DATA: Playwright intercepts network requests, verifies real API calls (no hardcoded/mock data)
5. WIRING: Playwright tests navigation links, form submissions, role-based access
6. VERIFICATION: Human confirms in browser (not automated)

Laws 1-5 must ALL pass before deployment. Law 6 is the final human gate.

## Multi-Machine Contracts

### Contract 20: Machine Coordination
When multiple machines are building:
- Each machine registers in Build Memory with machine_id
- Supabase migration locks: only one machine may run migrations at a time (advisory lock)
- Git branch names include machine_id: forge/{build-id}/{machine-id}/prompt-{index}
- Build Memory is the single source of truth for build state
- If Build Memory is unreachable, machine operates in standalone mode and syncs when reconnected

## System 1 — Resurrection Contracts

Source: `upgrades/RESURRECTION_BLUEPRINT.md` § Behavioral Contract (resurrection-specific, prose style of BEHAVIORAL_CONTRACTS.md). Reproduced verbatim.

### Contract R-1: Read-Only Audit
`GapAuditor` and `ArtifactHealthScorer` are read-only. The audit may read any file in the target
project and any Build Memory row, but the only System 1 component that writes to a governance file
is `RegenerationEngine`, and only under Contract R-2. An audit that modifies a file is a defect.

### Contract R-2: Regeneration Only Between Phases
`RegenerationEngine` may write a governance doc only when the target project is not in an in-flight
Phase 3 build. During Phase 3, governance docs are immutable (Contract 3). Regeneration checks the
build state before every write and refuses if a build is in flight, recording the refusal — never
silently skipping and never silently writing.

### Contract R-3: Architectural Gaps Are Gated
Any gap matching a CRITICAL condition (schema table missing with no migration; absent governance
doc; `BEHAVIORAL_CONTRACTS`-vs-code contradiction on Contract 1–20) is routed to
`HumanGateEvaluator` and never auto-regenerated. In non-interactive mode the gate defers and halts
for human; it never auto-approves. This gate is structural and non-configurable, following
Contract 2's four-gate philosophy.

### Contract R-4: Honest Halt Reconstruction
Every field of `halt_point_reference` is read from Build Memory or the preserved git branch. A
field that cannot be read is stored `null`, never fabricated (Iron Law 3). A partial halt point is
a valid result; a fabricated one is a defect.

### Contract R-5: Resume Floor Enforced in Code
`forge resurrect --resume` and `phase-chain.ts` RETROFIT entry enforce the resume floor (mean
`composite_score >= 0.70` and `gaps_critical = 0`) in code before handing any resume point to the
Phase 3 executor. The floor is a gate, not operator advice.

## System 5 — Sentinel Prime Contracts

Source: `src/sentinel-prime/` module docs (System 5-specific, prose style of BEHAVIORAL_CONTRACTS.md,
matching the R-series precedent above). Sentinel Prime is a SECOND, independent observation layer
that runs IN ADDITION to the mandatory Contract 13 Sentinel gate — never in place of it.

### Contract SP-1: Sentinel Prime Runs After Every Prompt
`SentinelPrime.runFullObservation` MUST run immediately after the Contract 13 gate completes for
every Phase 3 prompt, not a sample of prompts and not only on a Contract 13 failure. `phase3-executor.ts`
invokes it unconditionally on every prompt's completion path. A build that skips this call for any
prompt is a defect, not an optimization.

### Contract SP-2: Low Composite Confidence Halts
A composite confidence score below 0.4 (`HALT_COMPOSITE_THRESHOLD` in `confidence-scorer.ts`) MUST
trigger a halt recommendation, independent of whether the individual execution/validation/governance
signals look acceptable in isolation. The composite threshold is a hard gate evaluated in code
(`decideHalt`), never operator advice, and applies even when the mandatory Contract 13 gate already
passed — gates passing does not mean the diff actually did the work.

### Contract SP-3: Out-of-Scope Writes Are HALT Severity
Any file write, file deletion, or shell command that resolves outside a prompt's pinned
`projectPath` write scope MUST be recorded at HALT severity by `ExecutionMonitor`, and a HALT-severity
execution violation MUST force `decideHalt`'s `shouldHalt = true` regardless of the composite score —
it is never averaged away by an otherwise-high validation or governance score. A destructive command
(`rm -rf`, `Remove-Item -Recurse -Force`) is HALT severity outright, independent of path scope.

### Contract SP-4: DecisionValidator Uses the Claude Code CLI, Never the Metered API
`DecisionValidator`'s independent critic pass MUST invoke `runClaude` (the Claude Code CLI subprocess,
Contract 5's Max-subscription path) and MUST NOT call the metered `api.anthropic.com` Messages API
directly. Incremental cost for every Sentinel Prime critic call MUST be $0, exactly as every other
`runClaude` invocation in FORGE. `GovernanceEnforcer`'s `ZERO_COST_RULE` scans for and flags any
introduced reference to `api.anthropic.com` as a CRITICAL contract violation of this contract.

### Contract SP-5: GovernanceEnforcer Findings Are Never Auto-Approved
A CRITICAL `DriftReport` from `GovernanceEnforcer` (a confirmed contradiction against a numbered
`BEHAVIORAL_CONTRACTS.md` contract) MUST NOT be auto-approved, auto-dismissed, or silently overridden
by any flag. `decideHalt` treats any governance contract violation as a hard, non-auto-recoverable
halt signal (`hasContractViolations` forces `autoRecoverable = false`) — the same non-bypassable
posture Contract 2's four human gates and Contract R-3's fifth gate already establish for FORGE as a
whole.

## Native Orchestrator Contracts

Source: `src/orchestrator/` module docs (Native-Orchestrator-specific, prose style of
BEHAVIORAL_CONTRACTS.md). The Native Orchestrator replaces `forge-orchestrator.ps1` — Layer 2 of the
three-layer architecture (`forge.ps1`/`forge build` = Layer 1, one queue at a time; the orchestrator =
Layer 2, an entire project's `library-manifest.yaml` run to completion in dependency order;
`library/<project>/*.yaml` = Layer 3, the fuel depot) — with a first-class, in-process TypeScript
module.

### Contract ORC-1: GovernanceSync Runs Before Every Queue Execution
`syncBeforeQueueRun` (DIRECTIVE-016) MUST run before `QueueRunner` spawns `forge build` for any queue
entry, with no exception path. A queue must never execute against stale or absent governance docs in
the FORGE projects folder. A sync error is logged (WARN) and the run proceeds with whatever governance
state is already present rather than silently skipping the sync step entirely.

### Contract ORC-2: Dependency Cycles Are Rejected at Manifest Load Time
`ManifestResolver.validateNoCycles` MUST run against every loaded `library-manifest.yaml` before
`OrchestratorEngine.run` enters its main loop, and MUST throw on either a true circular `dependsOn`
chain or a dangling reference to a queue id that does not exist in the manifest. A cyclic or
malformed manifest must fail loudly at load time, never partially execute and stall silently.

### Contract ORC-3: Orchestrator Manifest State Is Persisted to Build Memory, Not Only YAML
Every manifest run MUST mirror its state into the `orchestrator_manifests` (and per-queue
`orchestrator_queue_runs`) Build Memory tables, not rely on the on-disk `library-manifest.yaml` alone.
Per Contract 4, this mirror is best-effort and non-blocking — a Build Memory write failure is logged
and swallowed, never a halting error — but `OrchestratorEngine`/`ManifestResolver` MUST attempt the
write on every status transition rather than treating the YAML file as the only record of what ran.

## Enhanced Retrofit Contracts

Source: `src/retrofit/` deep-analysis modules (Enhanced-Retrofit-specific, prose style of
BEHAVIORAL_CONTRACTS.md, matching the R-series/SP-series/ORC-series precedent above). Enhanced
Retrofit extends the pre-existing RETROFIT pipeline (SCAN → DIAGNOSE → RECONCILE → QUEUE, Contract-
governed since Run 2) with a second, deeper analysis layer purpose-built for existing/legacy
codebases: five read-only detectors, a GitHub Actions generator, and two new Sentinel gates.

### Contract RET-1: `forge analyze` Runs Before Every Retrofit Build
`runRetrofitPipeline` (the implementation behind `forge retrofit`) MUST run the full deep-analysis
sweep (`runDeepAnalysis` — dead code, orphaned routes, schema drift, dependency audit, coverage
baseline) before `runReconcile`/`generateRetrofitQueue`, establishing a health-score baseline for
every retrofit build, not a sample of builds. This is unconditional — there is no flag that skips
the sweep on a retrofit build, mirroring Contract 1's "no phase may begin until the preceding phase
has completed successfully" posture for RETROFIT's own internal ordering.

### Contract RET-2: Lint and Format Gates Run When the Project Is Configured For Them
Sentinel's `lint` and `format` checks (`runLintGate`/`runFormatGate` in `phase4-sentinel.ts`) MUST
run on every prompt whenever the target project has an ESLint config file (`.eslintrc.*` /
`eslint.config.*`) or a Prettier config file (`.prettierrc.*` / `prettier.config.*` / a `prettier`
devDependency) present on disk, respectively. A project with neither is not penalized — the gate
SKIPS, never fails, when its corresponding config is absent — but a project that HAS the config MUST
NOT have its style debt silently ignored just because the check is newer than Contract 13's original
five. This mirrors Contract 13's "ALL must pass, any single failure halts" posture for whichever
subset of gates actually applies to the project's real configuration.

### Contract RET-3: Bundle Size Gate Runs on Every Feature/Component/Page Prompt
Sentinel's `bundle_size` check (`runBundleSizeGate`) MUST run on every prompt whose type builds
user-facing UI, for a Next.js project. FORGE's `PromptType` union has no dedicated `component`/
`page` member (queue entries are typed `schema`/`auth`/`api`/`ui`/`feature`/`agent`/`test`/`deploy`
— Session 2's design-intelligence work already established `ui`/`feature` as the UI-producing
types), so `BUNDLE_SIZE_GATE_PROMPT_TYPES = {'feature', 'ui'}` is the real, code-level
implementation of this contract's "feature, component, page" run-list; every other prompt type
(`schema`/`auth`/`api`/`agent`/`test`/`deploy`) SKIPS, the real analog of the task's "agent,
database, migration, documentation" skip-list. The gate itself auto-skips entirely on a non-Next.js
project (no `next.config.*` found) — it is never a false failure on a project it cannot evaluate.

### Contract RET-4: GitHub Actions MUST Be Generated at Project Init If `.git` Exists
Phase 0 (`ensureGitRepo` already runs as step 0 per Session 5's Finding #3) MUST be followed, later
in the same Phase 0 pass, by `ensureGitHubActions` (step 13) whenever the target project has a
`.git` directory and does not yet have a `.github/workflows` directory. This is unconditional for
every project init that reaches step 13 with a git repo present — never opt-in, never deferred to a
later phase — and MUST NOT overwrite an operator's pre-existing `.github/workflows` directory if one
is already there.

### Contract RET-5: Schema Drift Findings MUST Be Included in Retrofit Queue Prompt Context
Every prompt `generateRetrofitQueue` writes into a retrofit build's `queue.yaml` MUST carry the
deep-analysis context digest (`renderDeepAnalysisContextBlock`) established under Contract RET-1 —
which includes the `SchemaDriftDetector`'s findings alongside dead code, orphaned routes,
dependency issues, and coverage gaps — appended to the prompt text, not merely available in a
separate report file the agent may never read. A CRITICAL/WARN/ENTERPRISE-tier fix prompt that
never sees the schema-drift context it should have been informed by is a defect under this
contract, mirroring Contract 7's "every Phase 3 prompt is dynamically assembled ... never
hardcoded" posture for RETROFIT's own prompt generation path.

## Skills Library Contracts

Source: `src/skills/` module (Skills-Library-specific, prose style of BEHAVIORAL_CONTRACTS.md,
matching the R-series/SP-series/ORC-series/RET-series precedent above). The Skills Library is a
project-wide, stack-detected engineering-standards injection layer, distinct from the
queue.yaml-declared `skills: [name]` opt-in mechanism (Contract 7's context injection already
covers that one) — it applies automatically to every Phase 3 prompt with no per-entry opt-in.

### Contract SKL-1: Skills Library MUST Be Injected Before Every Phase 3 Prompt Execution
`buildSkillsContext` MUST run on every Phase 3 prompt, not a sample of prompts and not only for
prompt types a queue entry explicitly opts into. `phase3-executor.ts` invokes it unconditionally
(step b2.5, after instinct application and before model routing) on every prompt's assembly path,
guarded in a try/catch per Contract 4's "never blocks execution" posture — a failure inside skill
loading/matching degrades to the prompt text unchanged, it never skips the call itself. A build
that omits this call for any prompt is a defect, not an optimization, mirroring Contract SP-1's
"runs after every prompt, not a sample" posture for Sentinel Prime.

### Contract SKL-2: Skills Are Matched By Project Stack Detection, Not Hardcoded
Which skills are injected into a given prompt MUST be determined by `detectProjectStack`'s reading
of the target project's actual `package.json` dependencies against `STACK_DETECTORS`, intersected
with each skill's frontmatter `tags` (`injectIntoContext`) — never by a hardcoded project name,
prompt type, or skill-id allowlist. A skill template with tags that cannot be produced by any
`STACK_DETECTORS` entry (e.g. `typescript`, `agents` — see the known gap flagged in
`STATE_OF_THE_BUILD.md` § Skills Library) is a detection-coverage gap to be fixed in
`STACK_DETECTORS`, not grounds for special-casing that skill's injection by name elsewhere in the
codebase.

### Contract SKL-3: New Skill Templates MUST Follow the `*.skill.md` Format With Valid Frontmatter
Every file loaded by `loadSkillsLibrary` MUST be a flat (non-recursive) `*.skill.md` file
containing a leading YAML frontmatter block (`---` … `---`) with at minimum an `id` (falls back to
the filename when omitted) followed by the Markdown template body, matching
`parseSkillContent`'s `FRONTMATTER_RE`. `forge skills add <skill-file>` MUST validate a candidate
file against this shape via `validateSkillFile` before copying it into the library, reporting every
problem found (missing frontmatter, unparseable YAML, non-object frontmatter, empty body) rather
than a bare pass/fail — a malformed file is rejected at `add` time, never silently loaded (or
silently skipped with no explanation) at Phase 3 execution time.

## Autonomy Upgrades Contracts

Source: `src/autonomy/` modules (Autonomy-Upgrades-specific, prose style of
BEHAVIORAL_CONTRACTS.md, matching the R-series/SP-series/ORC-series/RET-series/SKL-series
precedent above). Autonomy Upgrades reduce the human touchpoints required to run FORGE end-to-end
— environment validation, credential storage/injection, autonomous Supabase migration, autonomous
Vercel deployment, autonomous resolution of non-architectural governance gaps, and a build-wide
health monitor — without weakening any existing gate. See `STATE_OF_THE_BUILD.md` § Autonomy
Upgrades for the note distinguishing this work from REBUILD Session 3's differently-scoped
"Autonomy" (`forge compile`/`--auto-resume`) milestone.

### Contract AUT-1: EnvValidator Runs Before Any Other Phase 0 Action
`validateEnv`/`printEnvReport` (`src/autonomy/env-validator.ts`) MUST run as the literal first
statement of `runPhase0Scout`, before `ensureGitRepo` (greenfield git init, Session 5 finding #3)
and before every other Phase 0 gate (AgentShield, the toolchain audit, …). A build MUST NOT reach
git initialization, dependency scanning, or any file-touching Phase 0 step while a required
environment variable — from either FORGE's own catalog or the target project's `.env.example` —
remains unresolved. Missing required variables are folded into Phase 0's existing `blockers`
array exactly like every other Phase 0 gate; this is a structural ordering requirement, not a
separate silent-halt path.

### Contract AUT-2: CredentialVault Injection Runs Before Phase 3 Execution On Every Build
`CredentialVault.injectIntoEnv(projectPath)` MUST run during Phase 0 (step 14, after GitHub
Actions generation) on every `forge build` invocation that reaches that point, so that every
stored credential for a project is available in `.env.local` before Phase 3 ever spawns its first
`claude -p` subprocess. Injection MUST only append genuinely-new `KEY=value` lines — an existing
declared key (even an empty one) MUST NOT be overwritten, matching CredentialVault's own
`injectIntoEnv` contract. A vault read/write failure degrades to zero keys injected (logged), it
MUST NOT halt Phase 0.

### Contract AUT-3: Supabase Migrations Apply Automatically After Phase 3 When SUPABASE_ACCESS_TOKEN Is Present
`SupabaseMigrator.applyPendingMigrations` MUST run automatically immediately after a build's
`build_runs.status` finalizes to `'completed'`, whenever `process.env['SUPABASE_ACCESS_TOKEN']` is
set AND `SupabaseMigrator.isConfigured(projectPath)` resolves both a token and a project ref. It
MUST NOT run on a `'failed'`/`'halted'` build — a build that never went green has no business
pushing schema changes to a live database. A migration failure discovered at this stage MUST NOT
reopen or fail the already-finalized `build_runs` row (Contract 4); it is recorded as a BLOCKER
appended to STATE_OF_THE_BUILD.md for human follow-up instead, and the migration batch halts at
the first failure so later, possibly-dependent migrations are never applied onto a known-broken
schema state.

### Contract AUT-4: Vercel Deployment Triggers After Phase 5 When the Project Is Deploy-Configured
`VercelDeployer.deploy(..., 'production')` MUST run automatically as Phase 5 step 12, after every
other Phase 5 learning step, whenever the project is deploy-configured: a resolvable `VERCEL_TOKEN`
(environment variable or CredentialVault entry) AND an existing `vercel.json` on disk — the
project's own signal that it has already been linked to Vercel. Both conditions are required; a
resolvable token alone (with no `vercel.json`) MUST NOT trigger a deploy, since FORGE has no way to
know which Vercel project to deploy to without that link. Following a `ready` deployment, `forge
verify` (`runDeployVerification`) MUST run against the resulting URL and its outcome MUST be
folded into the Phase 5 summary report. A deploy or verify failure at this stage MUST NOT block or
reopen Phase 5's own completion (Contract 4) — it is recorded as a warning in the summary report.

### Contract AUT-5: CRITICAL Gaps Are Never Auto-Resolved, Regardless of Any Flag
`AutonomousGateResolver.resolveGaps` MUST check `gap.severity === 'CRITICAL'` first, unconditionally,
before consulting `nonInteractive`, `compositeScore`, or any other field of `ResolveGapsOptions`. A
CRITICAL gap (a missing schema table with no migration, a `BEHAVIORAL_CONTRACTS`-vs-code
contradiction, or a governance doc missing from disk entirely) MUST always be deferred to
`HumanGateEvaluator` via `deferCritical` — no present or future option, flag, or non-interactive
mode MAY route a CRITICAL gap around this deferral. This is the same non-bypassable posture
Contract 2's four human gates and Contract R-3's fifth gate already establish for FORGE as a whole,
now enforced a second, independent time at the `AutonomousGateResolver` layer specifically.

### Contract AUT-6: BuildHealthMonitor Pauses on Sustained Failure, Low Confidence, or Excess Memory
`BuildHealthMonitor.getHealth()` MUST report `status: 'critical'` whenever ANY of the following
holds: 3 or more consecutive Sentinel-failed prompts, a rolling 10-prompt average confidence below
0.3, or process RSS memory above 6000MB (6GB) — these three conditions are independently
sufficient, not jointly required. On a CRITICAL read, `shouldPause()` MUST write a
`.forge/health-{timestamp}.json` report and wait out a 2-minute in-process cooldown before letting
the build's prompt loop continue. BuildHealthMonitor observes and pauses; it MUST NOT itself halt a
build — Contract 13's five checks and Sentinel Prime's `HaltDecision` (Contract SP-2) remain the
only mechanisms that can actually halt one.

### Contract AUT-7: Every Autonomy Action Is Persisted to Its Schema-2.9.0 Build Memory Table
Every autonomy action MUST be persisted to Build Memory in the table appropriate to its module,
not silently to nowhere: `CredentialVault.set`/`delete` write to `project_credentials`,
`SupabaseMigrator`'s per-migration-file attempts (`applied`/`skipped`/`failed`) write to
`autonomy_actions`, and `VercelDeployer`'s per-deployment attempts write to `deployment_history` —
three distinct schema-2.9.0 tables, not one shared table despite the similar naming. Per Contract
4, every one of these writes is best-effort: a Build Memory failure is logged and swallowed, never
a halting error, and never prevents the underlying migration/deployment/credential operation from
completing on its own terms.

## Token Optimization Contracts

Source: `src/engine/governance-router.ts`, `src/engine/shared-preamble.ts`, and the token-cost
gates threaded through `src/sentinel-prime/`, `src/phases/phase4-sentinel.ts`, and `src/skills/`
(Token-Optimization-specific, prose style of BEHAVIORAL_CONTRACTS.md, matching the R-series/
SP-series/ORC-series/RET-series/SKL-series/AUT-series precedent above). Every FORGE build re-pays
the full token cost of its governance/skill/gate-output payload on every single `claude -p`
subprocess call (Contract 5 — no caching is possible across those calls, per the Prompt Caching
Investigation elsewhere in this file's history). Token Optimization narrows what actually rides
along in that payload without weakening any existing gate: governance docs are sliced to the
sections a prompt's type actually needs, universal instructions are stated once instead of
per-prompt, gate output is capped, an expensive critic pass is gated behind real doubt, and skill
templates are filtered to the stack (and now also the prompt type) they actually apply to.

### Contract TOK-1: Governance Docs Are Injected By Section Relevance, Never In Full
`parseGovernanceSections`/`routeGovernanceSections` (`src/engine/governance-router.ts`), wired into
`src/engine/prompt-assembler.ts`, MUST split a routed governance document (`SCHEMA_REGISTRY.md`,
`BEHAVIORAL_CONTRACTS.md`, `CLAUDE.md`, `STATE_OF_THE_BUILD.md`) into its `##`/`###` sections and
keep only the sections tagged relevant to the current prompt's `prompt_type` (or tagged `'*'`,
universal) before injection — never the whole document, and never an arbitrary head-of-document
truncation in place of real relevance filtering. A document this module has no routing rule for
(`classifyDoc`'s `'other'` branch) degrades to every section tagged `'*'` — unchanged prior
behavior, not a narrowing regression, for any governance doc outside the four named above.

### Contract TOK-2: DecisionValidator Only Fires Below the Confidence Threshold
`SentinelPrime.runFullObservation`'s DecisionValidator critic pass (Contract SP-1's mandatory
per-prompt Sentinel Prime run is unaffected — this contract governs only step 3 of that sequence)
MUST be skipped whenever `ExecutionMonitor` and `GovernanceEnforcer` both already passed for this
prompt AND the build's rolling average confidence over roughly the last 5 prompts is at or above
`getValidatorThreshold()` (`src/sentinel-prime/confidence-scorer.ts`; `forge_meta` override,
default 0.80). A skipped pass MUST receive the documented default-pass `intentFulfillmentScore`
(0.85, comfortably above `INTENT_FULFILLMENT_THRESHOLD`'s 0.75) — never a fabricated fail, and
never a silent skip with no recorded score. Either signal failing, or no rolling-confidence data
yet available, MUST fall through to running the full critic pass, matching pre-gate behavior.

### Contract TOK-3: Sentinel Gate Output Is Truncated Before Context Injection
Every `SentinelCheckResult.output` field (`src/phases/phase4-sentinel.ts`) MUST be capped via
`truncateGateOutput` (`DEFAULT_MAX_GATE_OUTPUT_LINES = 50`) at the point the pass/fail result is
constructed (`passCheck`/`failCheck`), before that result ever becomes `PreviousSentinelStatus`
context injected into the next prompt via `buildSentinelSection`. The full, untruncated output MUST
still be written to `.forge/build.log` when truncation actually elided something — this contract
governs only what rides into the NEXT prompt's assembled context, never what is available for human
or Build-Brain forensic review of a failure.

### Contract TOK-4: Skill Templates Are Injected Only For the Detected Project Stack
`buildSkillsContext`/`injectIntoContext` (`src/skills/index.ts`) MUST inject only the skill
templates whose frontmatter `tags` intersect `detectProjectStack(projectPath)`'s output — never
every template in the library regardless of stack (Contract SKL-2's existing stack-matching
requirement). Within a stack-matched skill, a non-empty `applicablePromptTypes` frontmatter field
MUST further narrow injection to prompts of a listed type (an empty `applicablePromptTypes` list
means "every prompt type this skill's stack tags already apply to," not "every prompt
unconditionally"). `STACK_DETECTORS` MUST include a `typescript` entry (closing the gap flagged in
`STATE_OF_THE_BUILD.md` § Skills Library, where `typescript-strict.skill.md` could never
auto-inject) so a skill tagged `typescript` can be matched by real stack detection rather than
requiring a name-based special case.

### Contract TOK-5: The Shared Preamble Is Injected Once Per Prompt, Never Duplicated
`injectSharedPreamble` (`src/engine/shared-preamble.ts`) MUST prepend `SHARED_PREAMBLE`'s four
universal rules (build-and-confirm-zero-errors, add-and-commit, never-guess-file-contents,
stay-in-project-scope) to an assembled prompt exactly once. Any queue.yaml-authored restatement of
one of those same four rules MUST be stripped — via `stripSharedPreambleDuplicates`, applied to
`entry.description` in `coerceQueueEntry` before the entry ever reaches the assembler, and again
(idempotently) by `injectSharedPreamble` itself at assembly time — so the same guidance is never
paid for twice in one prompt's token cost, regardless of whether the duplication originated in the
queue.yaml source or a re-run of the injection itself.

## UI Engine Contracts

Source: `src/ui-engine/` module docs (UI-Engine-specific, prose style of BEHAVIORAL_CONTRACTS.md,
matching the R-series/SP-series/ORC-series/RET-series/SKL-series/AUT-series/TOK-series precedent
above). UI Engine gives FORGE a deterministic production layer for UI work — a shadcn/ui installer,
a design-token baseline manager, a skill-informed component generator, a Storybook scaffolder, and a
static WCAG 2.1 AA accessibility checker — so component quality and accessibility are not left
entirely to whatever a given prompt happens to produce.

### Contract UI-1: Design Tokens MUST Be Configured Before the First Prompt of Every Build
`ensureDesignTokens` (`src/ui-engine/design-token-manager.ts`) MUST run once, before the first Phase
3 prompt of every non-dry-run build (`phase3-executor.ts:1355-1362`) — never per-prompt, and never
skipped for a real (non-simulation) run. It MUST NOT overwrite a project's own
`tailwind.config.*`/`globals.css` if either already exists; this is a one-time baseline write, not a
per-build reset. A failure here degrades to a logged warning (Contract 4 posture) and never blocks
the build.

### Contract UI-2: shadcn/ui Components MUST Be Used For All Primitive UI Elements
For every prompt whose type is `ui`/`feature` (FORGE's `PromptType` union has no dedicated
`component`/`page` member; these are the real UI-producing analogs, matching the RET-3/SKL-2
precedent), `detectRequiredComponents`/`ensureComponentsInstalled`
(`src/ui-engine/shadcn-installer.ts`) MUST run before claude executes the prompt, installing any
shadcn/ui component the assembled prompt text references that is not yet present in the target
project — so claude is never left to invoke the shadcn/ui CLI itself mid-prompt, and a generated
component's primitive elements draw from the installed catalog rather than a hand-rolled
reimplementation of the same primitive.

### Contract UI-3: Accessibility Check Runs After Every Component/Page Prompt
Every `ui`/`feature` prompt MUST be checked for WCAG 2.1 AA issues via
`checkComponentAccessibility`/`checkProjectAccessibility` (`src/ui-engine/accessibility-checker.ts`)
at two independent layers: a warn-only Phase 3 scan of every `.tsx` file the prompt touched, logged
and written to the governance dir but never flipping `disposition` (`phase3-executor.ts:2432-2455`);
and a real, failing Sentinel `component_accessibility` gate (`phase4-sentinel.ts`'s
`runComponentAccessibilityGate`) that SKIPs for any other prompt type or an absent
`src/components/` directory, but genuinely FAILs the build when any component's report does not
pass. The Phase 3 scan being warn-only does not weaken this contract — the Sentinel gate is the
actual enforcement mechanism, matching Contract 13's "ALL must pass, any single failure halts"
posture for the gate that actually gates.

### Contract UI-4: All Components Support Dark Mode Via Tailwind `dark:` Prefix
`generateTailwindConfig`/`generateGlobalsCss` (`src/ui-engine/design-token-manager.ts`) MUST build
dark-mode support into the design-token baseline from the first write, not as an opt-in
configuration step. Every component `UIComponentGenerator.generate()` produces MUST be instructed to
use Tailwind `dark:` prefix classes on every color/background/border utility (the accessibility
checker's own rule catalog states this explicitly), so a generated component is dark-mode-aware by
construction rather than requiring a follow-up retrofit prompt.

### Contract UI-5: Storybook Stories Generated For Every New Component
`UIComponentGenerator.generate()` MUST call `generateStory` (`src/ui-engine/storybook-generator.ts`)
at component-generation time, writing a matching `.stories.tsx` alongside every generated component
— never as a separate, optional step an operator must remember to run. `generateStoriesForProject`
additionally exists for a whole-project retroactive sweep (`forge design storybook`) over components
that predate UI Engine or were generated by a path other than `UIComponentGenerator`, skipping any
component that already has a story rather than overwriting it.

## Architecture Guardian Contracts

Source: `src/architecture-guardian/` module docs (Architecture-Guardian-specific, prose style of
BEHAVIORAL_CONTRACTS.md, matching the R-series/SP-series/ORC-series/RET-series/SKL-series/AUT-
series/TOK-series/UI-series precedent above). Architecture Guardian is a two-call, pre-prompt +
post-prompt enhancement/validation layer over every Phase 3 prompt — where Contract 13's five
Sentinel checks and Sentinel Prime's composite confidence score judge whether a prompt's output
compiles, builds, and plausibly fulfills intent, Architecture Guardian judges whether the output is
genuinely enterprise-grade: not a thin wrapper, not a stub, not a hardcoded mock array standing in
for a real data source.

### Contract AG-1: ArchitectureGuardian MUST Run Before Every Phase 3 Prompt
`ArchitectureGuardian.prePrompt` MUST run for every Phase 3 prompt, not a sample, at step b2.7 of
`executePrompt` — after every other prompt-text-shaping step (skills library injection, the shadcn
installer) so its classification reflects the final assembled text, and before model routing (b3)
so complexity/cost are estimated from what claude will actually receive. A build that skips this
call for any prompt is a defect, not an optimization, mirroring Contract SP-1's "runs after every
prompt, not a sample" posture for Sentinel Prime.

### Contract AG-2: Every Prompt MUST Be Enhanced to Enterprise Standards Before Claude Code Sees It
The prompt text passed to `runClaude` MUST be `GuardianValidation.enhancedPrompt` — the ORIGINAL
prompt text with an additive block of explicit enterprise-standard instructions appended for every
`ENTERPRISE_STANDARDS`/pattern requirement `EnterpriseEnforcer.enforce` determined was not already
signaled in the text — never the raw, pre-enhancement prompt. `prePrompt` never rejects a prompt
outright (`approved` is unconditionally `true`); Architecture Guardian enhances, it does not gate,
matching Contract SP-5/Contract R-1's "read-only/never-blocks-execution-in-the-blocking-direction"
posture applied here to prompt assembly instead of governance-file writes.

### Contract AG-3: PostOutputValidator MUST Run After Every Prompt, Before Sentinel Gates
`PostOutputValidator.validate`, via `runGuardianPostCheck`, MUST run on every completed Phase 3
prompt's modified files immediately after claude's diff is committed and BEFORE the Contract 13
Sentinel gate evaluates that same prompt — on both the decomposed-prompt path (ahead of/replacing
`decomposition.finalSentinel`) and the ordinary path (ahead of `ctx.runSentinelImpl`). Unlike
`prePrompt`, this pass computes a REAL `passed` verdict, because by this point in the pipeline the
code already exists on disk and there is no more "rewrite and retry before it runs" option.

### Contract AG-4: Quality Score Below 60 or Any Critical Violation Triggers Immediate Autonomous Recovery
Whenever `PostOutputValidator`'s `qualityScore` falls at or below 60, OR any violation it found is
`severity: 'critical'` and the overall verdict is not `passed`, `runGuardianPostCheck` MUST
short-circuit the (potentially slow) Contract 13 Sentinel run for that prompt with a synthetic
failed `SentinelResult` (`failedCheck: 'architecture'`), so the existing Sentinel-failure/Autonomous-
Recovery disposition path fires immediately rather than waiting for `tsc`/`build` to independently
rediscover the same problem. A quality score above 60 with zero critical violations MUST return
`null` from this check and let the Contract 13 Sentinel gate run normally.

### Contract AG-5: Zero Stubs, TODOs, Placeholders, or Mock Data Arrays Ever Permitted in Production Output
Both halves of Architecture Guardian MUST independently enforce this — `EnterpriseEnforcer.enforce`'s
`detectStubMarkers`/`detectMockDataLanguage` flag a CRITICAL, additively-instructed violation
pre-prompt when the ASSEMBLED PROMPT TEXT already contains such language, and
`PostOutputValidator`'s `checkStubMarkers`/`checkMockData` independently re-scan the ACTUAL GENERATED
CODE post-prompt for the same failure modes (`TODO`/`FIXME`/`HACK`/placeholder/stub markers,
`: any`/`as any` escape hatches, and a `const`/`let` named `mock`/`fake`/`dummy`/`sample` assigned an
array literal outside an exempt `tests/`/`__mocks__`/`__fixtures__` path). A prompt whose text slips
a stub/mock-data instruction past the pre-prompt enforcement MUST still be caught by the post-output
scan — the two checks are independent, redundant layers, not a single check run twice.

## Elite Skills Library Contracts

Source: `src/skills/index.ts`, `src/skills/ux-intelligence.ts`, `src/skills/compliance-detector.ts`
module docs (Elite-Skills-Library-specific, prose style of BEHAVIORAL_CONTRACTS.md, matching the
R-series/SP-series/ORC-series/RET-series/SKL-series/AUT-series/TOK-series/UI-series/AG-series
precedent above). Elite Skills Library extends the original Skills Library (Contracts SKL-1–SKL-3)
with 29 additional `*.skill.md` templates, an agentic UX Intelligence design-system selector, a
Compliance Detector, and a curated "always relevant" injection layer that guarantees certain
security/reliability/performance skills fire for a given prompt type regardless of which specific
`package.json` dependencies a project happens to declare.

### Contract ESKU-1: UX Intelligence Runs in Phase 0, Writes DESIGN_SYSTEM.md Before Any UI Prompt
`detectIndustryVertical` → `selectDesignSystem` → `writeDesignSystemDoc` (`src/skills/ux-
intelligence.ts`) MUST run unconditionally as Phase 0 step 15 of every `forge build`, before Phase 3
ever assembles a prompt, so `<project>/governance/DESIGN_SYSTEM.md` carries SOME
industry-appropriate design intent (palette, typography, density, motion) even for a build that
never reaches Phase 1B's fuller UI/UX Pro Max generation (a `--use-existing-queue` re-run, a
Phase-0-only dry run). This baseline is expected to be superseded by Phase 1B's generation when that
phase runs — writing it in Phase 0 is a floor, not a ceiling, on design intent.

### Contract ESKU-2: Compliance Detection Runs in Phase 0, Every Project
`detectComplianceRegimes` → `writeComplianceDoc` (`src/skills/compliance-detector.ts`) MUST run
unconditionally as Phase 0 step 16 of every `forge build`, immediately after step 15, regardless of
whether any regulatory regime is ultimately detected — `<project>/governance/
COMPLIANCE_REQUIREMENTS.md` MUST be written even when `regimes: []` (zero regimes detected is a
valid, honest result, never a skipped write). Detection MUST err toward false positives over false
negatives per the module's own stated design (a PRD merely mentioning "patient" in passing is
sufficient to flag HIPAA-adjacent) — the cost asymmetry (a missed regime risks a build that ships
without legally-required encryption/audit-logging; a false positive costs a few extra lines of
governance text) is why this contract does not require detection precision, only detection coverage.

### Contract ESKU-3: Elite Skills Inject Only Relevant Templates, Never All
`ALWAYS_RELEVANT_BY_PROMPT_TYPE` (`src/skills/index.ts`) MUST be keyed by `promptType` and MUST NOT
cause `getForPrompt` to return its full template union for any single prompt type — every entry
names a specific, curated subset of skill ids relevant to that type (e.g. `database`:
`database-indexing`/`multi-tenancy`/`audit-logging`/`soft-delete`, never every security or
performance skill in the library). This "always relevant" set is merged via skill `id` (deduplicating,
never concatenating duplicates) with the pre-existing stack-tag-matched set from Contract SKL-2 —
it is an ADDITIVE layer on top of stack detection, not a replacement for it, and `getForPrompt`
retains Contract SKL-2's original invariant that it must never return "all skills" for a broad
prompt type like `api`.

## Design Pipeline Contracts

Source: `src/design-pipeline/` modules (Design-Pipeline-specific, prose style of
BEHAVIORAL_CONTRACTS.md, matching the R-series/SP-series/ORC-series/RET-series/SKL-series/AUT-
series/TOK-series/UI-series/AG-series/ESKU-series precedent above). The Design Pipeline is a
visual-evidence layer sitting above every other Phase 3 gate: Contract 13's five Sentinel checks,
Sentinel Prime's composite confidence score, Architecture Guardian's pre/post-prompt code scan, and
UI Engine's static WCAG 2.1 AA source scan all judge the CODE a `ui`/`feature` prompt produced —
none of them judge what that code actually RENDERS AS. `PlaywrightScreenshotter` +
`PenpotIntegration` + `DesignReviewGate`, composed by `DesignPipeline`, close that gap with a real
headless-browser capture, an optional design-tool push, and a human/accessibility-score-gated
approval verdict.

### Contract DP-1: DesignPipeline Runs After Every Component and Page Prompt
`DesignPipeline.run` (via `runDesignPipelineCheck`) MUST run for every Phase 3 prompt whose
`prompt_type` is a UI-producing type — `SHADCN_INSTALL_PROMPT_TYPES` (`{'ui', 'feature'}`, the same
real `PromptType` analogs for "component, page" already established by Contract UI-2/RET-3/SKL-2 —
FORGE's `PromptType` union has no dedicated `component`/`page` member) — not a sample of such
prompts. It runs only once the Contract 13 Sentinel gate has already passed for that prompt (no
point screenshotting code that doesn't build) and strictly BEFORE the merge decision, so a
design-rejected prompt is never merged to main on the strength of a green Sentinel alone. A prompt
whose `modifiedFiles` contains no `.tsx` file is a legitimate, logged skip (`DESIGN_PIPELINE_SKIPPED_
MESSAGE`) — not a violation of this contract, since there is genuinely nothing to visually review.

### Contract DP-2: Human Rejection Injects Feedback Into Recovery
A design review verdict of `approved: false` (an interactive human Reject, or a non-interactive
below-threshold/unscored defer) MUST have its `feedback` field re-formatted as `DESIGN FEEDBACK:
<feedback>` and injected directly into a single, targeted recovery re-run of the ORIGINAL prompt
text (`${promptText}\n\n${feedback}`), gated on Autonomous Recovery being enabled — NEVER routed
through Contract 14's pattern-matched Sentinel recovery path, which would immediately escalate a
never-before-seen "design review rejected" error signature under its own "novel error → always
escalate" rule. A successful feedback re-run (the re-run claude call succeeds AND Sentinel re-passes)
merges normally; an unsuccessful one marks the prompt `failed` with the rejection feedback recorded
verbatim in the disposition note, never silently dropped.

### Contract DP-3: Design Artifacts Are Stored on an External Drive When Available
`getDesignStoragePath` (`src/design-pipeline/storage-config.ts`) MUST resolve the base directory for
every design artifact (screenshots, Penpot exports, design reviews, component specs) in this exact
priority order: an explicit `FORGE_DESIGN_STORAGE` environment override always wins; absent that,
the first drive letter `D:` through `Z:` that both exists and reports more than 100GB free (the
documented, deliberate proxy this module uses for "external drive," since Node's `fs` has no
portable removable-vs-fixed signal on Windows); absent any qualifying drive, the sanctioned local
fallback `C:\Users\manag\Documents\forge-design-artifacts\`. An unreadable drive letter MUST be
skipped, never treated as a hard failure — the scan simply continues to the next candidate.

### Contract DP-4: Penpot Degrades Gracefully, Never Blocks the Build
Every public method on `PenpotIntegration` MUST return a safe `null`/`false`/error-carrying result
object on any failure — an unreachable Penpot instance, missing/invalid `PENPOT_EMAIL`/
`PENPOT_PASSWORD` credentials, a malformed API response — and MUST NEVER throw an uncaught
exception. `DesignPipeline.run`'s Penpot-upload step MUST be wrapped such that a Penpot failure logs
`PENPOT_UNAVAILABLE_MESSAGE` and the pipeline continues in screenshot-only mode; Penpot being
entirely absent (no instance running, no credentials configured — the expected state on most FORGE
machines) MUST NOT prevent screenshot capture or the review gate from running to completion. This
is the same Contract-4 "degrade to a smaller/emptier result, never a halting error" posture applied
here specifically to Penpot as optional infrastructure.

### Contract DP-5: Screenshots Are Captured at a Minimum of Four Viewports
Every `PlaywrightScreenshotter.captureComponent`/`captureAllRoutes` call that does not receive an
explicit `options.viewports` override MUST default to `DEFAULT_VIEWPORTS`
(`['1920x1080', '1280x720', '768x1024', '375x812']` — desktop, laptop, tablet, mobile), exactly four
viewport captures per component. A caller MAY request additional viewports via `options.viewports`,
but the default sweep every `ui`/`feature` prompt receives through `DesignPipeline.run` MUST NEVER
be fewer than these four, so a component's responsive behavior is never judged from a single
screen size alone.
