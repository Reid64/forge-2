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
