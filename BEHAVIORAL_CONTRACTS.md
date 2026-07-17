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
