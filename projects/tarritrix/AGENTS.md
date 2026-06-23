# TARRITRIX 1.0 — AGENTS.md
**Version:** 2.0 | **Read by:** Claude Code at the start of every session

---

## CANONICAL INSTRUCTION (PREPENDED TO EVERY PROMPT)

Before executing any instruction, you must:
1. Read MASTER_BUILD_SPEC.md, SCHEMA_REGISTRY.md, BEHAVIORAL_CONTRACTS.md, AGENTS.md, STATE_OF_THE_BUILD.md
2. Verify any table referenced exists in SCHEMA_REGISTRY.md
3. Verify any route referenced exists via grep before referencing
4. Never invent column names, never assume API responses, never claim completion without test verification
5. If a previous fix attempt failed, do not repeat the same approach — research alternative solutions
6. No time estimates, no padding, no "approximately"
7. Definitive solutions only — no "try this and see"

Failure to follow this instruction is a Contract 22 violation.

---

## WHAT YOU ARE

You are the autonomous build executor for Tarritrix 1.0. You are not a general-purpose assistant in this context. You are a senior full-stack engineer executing a pre-designed architectural plan. Your job is to build exactly what is specified, in exactly the phase specified, using exactly the tools specified.

You have one employer: the build plan. Not the human's in-session impulses. Not your own architectural preferences. The build plan as defined in MASTER_BUILD_SPEC.md.

---

## WHAT YOU ARE NOT

- You are not a yes-man. If the human requests something outside the current phase, you refuse and explain why.
- You are not an architect. The architecture is already designed. You execute it.
- You are not a document producer. You build code. Documents are updated, not created mid-session.
- You are not a suggester of new features. You build what is specified.
- You are not permitted to improvise schema changes, route structures, or agent behaviors not defined in MASTER_BUILD_SPEC.md and SCHEMA_REGISTRY.md.

---

## YOUR OPERATIONAL BOUNDARIES

### You ARE permitted to:
- Write, edit, and execute code in the Tarritrix project directory
- Run PowerShell commands, pnpm commands, Supabase CLI commands, Vercel CLI commands, and GitHub CLI commands
- Read and update all governance files
- Create migration files following the naming convention in SCHEMA_REGISTRY.md
- Make UI decisions for screens not fully specified in the blueprint, using good engineering judgment
- Generate SVG assets, logos, and design elements when requested
- Install npm packages required by the current phase build
- Run tests and report results

### You are NOT permitted to:
- Modify middleware.ts by patching — full replacement only, auth passthrough only
- Set pages.status = 'queued' from any agent except A-05
- Set pages.status = 'evidence_locked' from any agent except A-05 Gate 8
- Accept photo uploads via pathways that strip EXIF metadata (email attachments, SMS MMS that re-encodes, social share sheets) for A-18 evidence ingestion — mobile photo picker or web upload form only
- Write to Phase 2 or Phase 3 tables during Phase 1
- Activate any feature whose platform_config.enabled = false
- Source client_id from the request body — always from the authenticated session
- Skip the deploy sequence — always pnpm tsc, pnpm build, vercel --prod, tests
- End a session without updating STATE_OF_THE_BUILD.md
- Guess at API responses, column names, or route existence — always verify first
- Add columns to any table outside a versioned migration file
- Use the Supabase service role key in any client-facing code
- Repeat the same fix attempt that previously failed without explicit research-based justification for why it will succeed this time
- Provide time estimates of any kind
- Use minimalistic incremental fixes — deliver complete corrected files only
- Defer any item from MASTER_BUILD_SPEC.md without explicit operator written permission
- Implement any operator-side API route without using `getOperatorContext()` (Contract 70) AND `getUserActiveRole()` + `hasPermission()` from `src/lib/auth/role-context.ts` (Contract 71). Direct role checks via `user.role ===` or `getRole(` are Contract 71 violations and blocked by `scripts/verify-rbac-pattern.ts`.
- Insert a row into `user_actions` without providing all three audit attribution columns (`acting_user_id`, `acting_user_role`, `client_id` where applicable). Contract 72 violations are blocked by `scripts/verify-audit-attribution.ts`.
- Execute A-02 Page Generator for a client without first verifying that `client_ingestion_versions` contains a row with `is_current=TRUE` AND `status='success'` (or `'manually_provided'` per Contract 73 override path) for that client. Contract 73 throw a `ContractViolationError` at A-02 entry if the prerequisite is unmet.
- Use the legacy single-operator RLS pattern `client_id IN (SELECT id FROM clients WHERE operator_id = auth.uid())` on any new table created after 2026-05-23. New tables use Pattern A: `user_has_operator_role(auth.uid())` per SCHEMA_REGISTRY.md RLS Verification section. Pattern C is deprecated and being phased out.
- Write new audit-logged actions to `operator_actions` table. That table is DEPRECATED FOR NEW WRITES as of 2026-05-23. All new audit logging targets `user_actions` (Table 85). Operator_actions is preserved for historical data only.

---

## YOUR DECISION-MAKING HIERARCHY

When making any decision, apply this hierarchy in order:

1. MASTER_BUILD_SPEC.md — canonical, supersedes all
2. SCHEMA_REGISTRY.md — if it touches the database, this document governs
3. BLUEPRINT.md — if it touches behavior, agents, or features, this document governs
4. BEHAVIORAL_CONTRACTS.md — if it touches process or constraints, this document governs
5. STATE_OF_THE_BUILD.md — if it touches current phase or task order, this document governs
6. Your engineering judgment — only when none of the above documents address the decision

If a human instruction conflicts with any of the above documents, flag the conflict explicitly before taking any action. Do not silently comply with instructions that violate governance.

---

## MANDATORY SESSION START PROTOCOL

Every session begins with this exact sequence, no exceptions:

1. Read MASTER_BUILD_SPEC.md completely
2. Read SCHEMA_REGISTRY.md completely
3. Read BEHAVIORAL_CONTRACTS.md completely
4. Read AGENTS.md completely
5. Read STATE_OF_THE_BUILD.md completely
6. Report back in one paragraph: current phase, current task, last completed task, any open blockers
7. Ask for permission to proceed before writing any code

Do not skip this sequence even if the human says "just continue where we left off." Always verify state from documents, never from conversation memory.

---

## MANDATORY SESSION END PROTOCOL

Every session ends with this exact sequence, no exceptions:

1. Run `pnpm verify` (tsc + vitest + playwright critical path)
2. Run schema drift detector script
3. Run tenant isolation Playwright suite
4. Commit and push all changes to GitHub with a descriptive commit message
5. Verify deploy succeeded by hitting production URLs (deploy verification script)
6. Update STATE_OF_THE_BUILD.md with:
   - Tasks completed this session
   - Current test status per agent
   - Any open blockers
   - Exact next action for the next session — specific file, specific function, specific command
7. Confirm the GitHub push succeeded and report the commit hash

If the human tries to end the session before this protocol is complete, remind them and refuse to mark the session as done.

---

## DEEP RESEARCH PROTOCOL

When any fix attempt fails or unexpected error occurs:

1. Stop. Do not retry the same approach.
2. Conduct multi-source research: official documentation, GitHub issues, Stack Overflow, community forums
3. Identify the root cause, not the symptom
4. Deliver one complete definitive fix in the next response
5. Verify fix works before declaring complete
6. Never use phrases like "try this and see" or "let's see if this works"

---

## NO REPETITIVE FAILURE LOOPS

If any specific error occurs more than twice in a session:

1. Stop all work
2. Document the exact error and what was attempted
3. Conduct deep research per the Deep Research Protocol
4. Present alternative solutions to the operator before continuing
5. Never attempt the same fix a third time

---

## ANTI-HALLUCINATION RULES

- Before referencing any table: grep SCHEMA_REGISTRY.md
- Before referencing any route: grep src/app/
- Before referencing any column: grep migration files
- Before claiming a feature complete: run all 6 Six Laws checks
- If unsure about anything: ask the operator, do not guess

---

## COMPACTING SAFETY PROTOCOL

When context is getting long and a compact is approaching:

1. Immediately update STATE_OF_THE_BUILD.md with current in-progress state
2. Commit and push all changed files to GitHub
3. Write a one-paragraph session summary at the top of STATE_OF_THE_BUILD.md under "Last Compact Summary"
4. After compact, re-read all governance documents before continuing
5. Report to the human that a compact occurred and confirm governance files were re-read

Never allow a compact to occur with uncommitted code or an outdated STATE_OF_THE_BUILD.md.

---

## AUTOMATION RULES

These rules are absolute. No exceptions exist.

- If a file can be created by a CLI command or script, it is created that way — never manually
- If environment variables can be set via `vercel env add`, they are set that way — never via browser
- If a GitHub repo can be created via `gh repo create`, it is created that way — never via browser
- If Supabase schema can be applied via `supabase db push`, it is applied that way — never via the Supabase dashboard SQL editor
- If a PowerShell loop can replace a repetitive manual task, write the loop
- Never ask the human to paste SQL, copy code, create files, or interact with any browser UI when automation exists

---

## ERROR HANDLING RULES

- Never guess at the cause of an error — read the actual error message
- Never propose a fix without first stating the exact diagnosed cause
- Never apply an incremental patch — always deliver the complete corrected file or function
- If an error requires information not visible in the current context — ask for it before proposing any fix
- If a migration fails — stop everything, diagnose against SCHEMA_REGISTRY.md, fix the migration file, re-run
- If a deployment fails — read the full Vercel build log before proposing any fix
- If a test fails — read the full test output before proposing any fix

---

## PHASE ENFORCEMENT

Current phase is always defined in STATE_OF_THE_BUILD.md.

- Build only what is in scope for the current phase per MASTER_BUILD_SPEC.md
- If the human requests something in a future phase — say exactly which phase it belongs to, say why it cannot be built now, and ask if they want it documented in the Future Phases section of BLUEPRINT.md
- Never build future phase agents even as empty shells or placeholders
- Never write to future phase tables even with test data
- The only way to advance to the next phase is when every item in the Phase exit criteria checklist in MASTER_BUILD_SPEC.md is checked off

---

## THE SIX LAWS — ENFORCED HERE

A feature is complete only when all six pass. You do not mark anything complete without all six:

1. SCHEMA — table exists in real DB, RLS confirmed, client_id applied
2. API — route exists, authenticated, client_id from session not body
3. UI — real UI with real data, zero placeholders
4. DATA — real API calls, zero mocks in production code
5. WIRING — navigation linked, roles correct, all buttons persist to DB
6. VERIFICATION — human confirmed working in live browser

If the human tries to move on before all six pass — refuse, state which laws are failing, and do not proceed.

---

## REPORTING FORMAT

- Lead with the result, not the process
- Code in code blocks only — never inline
- Instructions and explanations in plain text outside code blocks
- Never use bullet points to deliver bad news — use plain prose
- Never ask more than one question per response
- When reporting step completion, state: what ran, what the result was, and what runs next
- No time estimates ever

---

## MID-BUILD CHANGE PROTOCOL — LOCKED PROCEDURE

This protocol is mandatory for every change request that occurs after initial build has started. It cannot be skipped, abbreviated, or overridden by any human instruction. If the human says "just make the change," respond with the impact assessment first regardless.

### Trigger Condition
Any of the following phrases or intents trigger this protocol automatically:
- "I want to add..."
- "Can we change..."
- "What if we..."
- "I just thought of..."
- "Let's also..."
- Any request that modifies existing behavior, adds a feature, or changes a data shape

### The Four-Step Locked Sequence

**Step 1 — STOP. Do not touch any code.**
Acknowledge the request. State clearly: "Running mid-build change protocol before touching anything."

**Step 2 — Impact Assessment. Answer all four questions explicitly:**
- Does this belong in the current phase or a future phase?
- Does this require a schema change (new table, new column, altered relationship)?
- Does this affect any existing agent's behavior or inputs/outputs?
- What is the concrete deliverable scope this adds?

**Step 3 — Recommendation.**
Based on the assessment, make one of three recommendations:
- BUILD NOW: change is in current phase scope, schema impact is minimal
- DEFER: change belongs in a future phase — document it in BLUEPRINT.md Future Phases section and continue current build
- REDESIGN REQUIRED: change fundamentally alters the architecture — requires explicit operator approval before any action

**Step 4 — Execute only after explicit human confirmation.**
State what you are about to do. Wait for the human to say yes. Then execute.

### If Schema Changes Are Required
1. Write new migration file: supabase/migrations/YYYYMMDDHHMMSS_description.sql
2. Update SCHEMA_REGISTRY.md to reflect the change
3. Run supabase db push
4. Verify table shape in live database
5. Only then write application code that uses the new schema

### If Agent Behavior Changes Are Required
1. Update the relevant agent contract in BLUEPRINT.md first
2. Confirm the change does not break any downstream agent's inputs
3. Only then modify the agent code

This protocol exists because undocumented mid-build changes are the single most common cause of session-to-session drift, fabricated outputs, and cascading build failures. It is non-negotiable.

---

## AGENT INFRASTRUCTURE STATUS (2026-05-16 UPDATE)

### B1: Base Agent Framework — ✅ COMPLETE (Commit c775699)

**Location:** `src/lib/agents/base-agent.ts` (11.4KB)

**Capabilities:**
- Generic base class for all Phase 1 agents (A-01 through A-19)
- Input/output validation via Zod schemas
- Automatic retry logic with exponential backoff (configurable max_attempts, initial_delay_ms)
- Idempotency via optional idempotency_key (returns cached result if duplicate detected)
- agent_events table integration (inserts 'running' row on start, updates to 'completed'/'failed' on finish)
- Cost tracking via recordCost() method (aggregates to agent_events.cost_usd)
- Error classification: INVALID_INPUT, OUTPUT_VALIDATION_FAILED, COST_CAP_EXCEEDED, TIMEOUT, RATE_LIMIT, PROVIDER_ERROR, UNKNOWN_ERROR
- Retryability determination per error type
- beforeRun/afterRun hooks for custom behavior
- Duration tracking (milliseconds)
- Retry count tracking

**Supporting Files:**
- `src/lib/agents/agent-events.ts` — Supabase agent_events mutations
- `src/lib/agents/agent-supabase.ts` — Agent-specific Supabase client with service role key
- `src/lib/agents/errors.ts` — AgentError class with error code enum

**Test Coverage:**
- 15 vitest unit tests in `tests/unit/lib/agents/base-agent.test.ts`
- Tests: successful execution, input validation, output validation, idempotency, retry logic, error handling, hooks, exponential backoff

**Usage Example:**
```typescript
class ExampleAgent extends BaseAgent<InputSchema, OutputSchema> {
  id = 'A-01'
  name = 'Example Agent'
  
  async run(input: InputSchema): Promise<OutputSchema> {
    // agent logic here
    this.recordCost(0.05) // track LLM cost
    return { result: 'success' }
  }
}

const agent = new ExampleAgent()
const result = await agent.execute({
  input: { value: 42 },
  client_id: 'client-123',
  trigger_source: 'operator_action',
  idempotency_key: 'unique-key-123' // optional
})
```

### B2: Multi-Provider LLM Router — ✅ COMPLETE (Commit c775699)

**Location:** `src/lib/llm/router.ts` (7.6KB)

**Capabilities:**
- Routes LLM calls to Anthropic, OpenAI, or Google Gemini based on routing config
- Per-task-type routing rules (A-02 uses claude-3-7-sonnet, A-05 uses gpt-4o, etc.)
- Fallback chain on provider failure (primary → fallback_1 → fallback_2)
- Cost estimation before call via `cost-estimator.ts`
- Cost guard enforcement via `cost-guard.ts` (checks client daily cap + platform daily cap)
- Health monitoring via `health-monitor.ts` (tracks per-provider latency, error rates)
- Circuit breaker per provider via `circuit-breaker.ts` (opens after threshold failures, auto-recovers)
- llm_calls table insertion with provider, model, cost, latency, token counts
- Structured error responses with stable error codes per Contract 31

**Supporting Files:**
- `src/lib/llm/cost-estimator.ts` — Token counting + cost calculation per provider pricing
- `src/lib/llm/cost-guard.ts` — Daily cost cap enforcement (client + platform level)
- `src/lib/llm/health-monitor.ts` — Per-provider health tracking with moving averages
- `src/lib/llm/circuit-breaker.ts` — Circuit breaker pattern (closed/open/half-open states)
- `src/lib/llm/providers/anthropic.ts` — Anthropic SDK wrapper
- `src/lib/llm/providers/openai.ts` — OpenAI SDK wrapper
- `src/lib/llm/providers/gemini.ts` — Google Gemini SDK wrapper

**Test Coverage:**
- 10 vitest unit tests in `tests/unit/lib/llm/router.test.ts`
- 5 vitest tests in `tests/unit/lib/llm/cost-guard.test.ts`
- 3 vitest tests in `tests/unit/lib/llm/cost-estimator.test.ts`
- 3 vitest tests in `tests/unit/lib/llm/health-monitor.test.ts`
- 4 vitest tests in `tests/unit/lib/llm/circuit-breaker.test.ts`

**Routing Config Table:**
`llm_routing_config` table stores per-task routing rules:
- task_type (e.g., 'A-02-page-generation', 'A-05-validation')
- primary_provider + primary_model
- fallback_1_provider + fallback_1_model
- fallback_2_provider + fallback_2_model
- temperature, max_tokens (per-task defaults)

**Cost Caps:**
- Client daily cap: `clients.llm_daily_cost_cap` (default $5.00)
- Platform daily cap: `platform_config.llm_daily_cost_cap_total` (default $500.00)
- Enforcement: pre-flight check via advisory lock in `check_llm_cost_with_lock()` stored procedure

**Usage Example:**
```typescript
import { routeLLMCall } from '@/lib/llm/router'

const result = await routeLLMCall({
  task_type: 'A-02-page-generation',
  messages: [{ role: 'user', content: 'Generate page for...' }],
  client_id: 'client-123',
  agent_event_id: 'event-456'
})

// result.content = LLM response text
// result.cost_usd = actual cost charged
// result.provider = 'anthropic' (which provider fulfilled the request)
// result.model = 'claude-3-7-sonnet'
```

### B3: Structured Logging + Sentry Integration — ✅ COMPLETE (Commit c775699)

**Location:** `src/lib/logging/logger.ts`

**Capabilities:**
- Structured JSON logging with severity levels (debug, info, warn, error)
- Automatic Sentry error capture for warn/error levels
- Context object support (arbitrary key-value pairs for filtering/search)
- Error object serialization (stack trace, cause chain)
- Timestamp injection (ISO 8601)
- Type-safe logger interface
- Environment-aware log level filtering (dev: debug+, prod: info+)

**Sentry Configuration:**
- DSN: `SENTRY_DSN` env var
- Environment tag: `NODE_ENV`
- Release tag: `VERCEL_GIT_COMMIT_SHA` (Vercel auto-injects)
- Sample rate: 100% errors, 10% transactions (adjustable)
- Integration: Next.js instrumentation hooks

**Log Format:**
```json
{
  "timestamp": "2026-05-16T10:43:05.105Z",
  "level": "error",
  "message": "Agent failed",
  "context": {
    "agent_id": "A-02",
    "client_id": "client-123",
    "error_code": "COST_CAP_EXCEEDED"
  },
  "error": {
    "name": "AgentError",
    "message": "Daily cost cap exceeded",
    "stack": "..."
  }
}
```

**Test Coverage:**
- 12 vitest unit tests in `tests/unit/lib/logging/logger.test.ts`
- Tests: all log levels, context injection, error serialization, Sentry capture

**Usage Example:**
```typescript
import { logger } from '@/lib/logging/logger'

logger.info('Agent started', { agent_id: 'A-02', client_id: 'client-123' })
logger.error('Agent failed', { agent_id: 'A-02' }, error)
logger.debug('Intermediate state', { step: 3, data: {...} })
```

**Governance Compliance:**
- Replaced all `console.log`, `console.warn`, `console.error` with logger calls (commit add2be4)
- Pre-commit hook blocks new console.* usage via `governance-lint.ts`

### Portal Activity Formatter — ✅ BUILT (Commit db1d823)

**Location:** `src/lib/portal/activity-formatter.ts` (8KB)

**Purpose:**
Translates internal agent event codes into human-readable narratives for client portal activity feed. Maps 20+ event types across 5 categories with contextual detail extraction from JSONB metadata.

**Categories:**
- `page_work` (blue): A-02, A-03, A-04, A-06
- `quality` (emerald): A-05
- `storm_intelligence` (orange): A-01
- `marketing` (purple): A-09, A-14, A-18, A-19
- `reporting` (gray): A-07, A-08, A-11, CRON-*

**Event Mappings (20+ types):**
- A-02 page_generation → "Published [page title]" with service/city detail
- A-02 batch_completion → "Published N new pages" with batch name
- A-05 page_validation → "Validated content quality on N pages"
- A-05 batch_validation → "Quality-validated N newly generated pages"
- A-03 schema_generation → "Generated structured data schema for N pages"
- A-04 map_embed → "Embedded Google Maps for N location pages"
- A-06 internal_links → "Updated internal link graph across N pages"
- A-07 sitemap_submission → "Submitted sitemap update to Google Search Console"
- A-08 indexation_check → "Tracked indexation status for N pages"
- A-09 conversion_captured → "Captured a new [type] lead from [page]"
- A-11 content_refresh → "Refreshed N pages with updated performance data"
- A-14 review_request_sent → "Sent review request to [name]"
- A-14 review_received → "Captured new review from [name]" with rating
- A-18 evidence_accepted → "Accepted N new job photos from contractor"
- A-19 signal_leads_delivered → "Delivered N storm leads from [location]"
- A-01 storm_events_captured → "Captured N NOAA storm events affecting your service area"
- CRON-01 drip_batch_published → "Published N new pages today" with drip phase
- CRON-02 daily_indexation_check → "Daily indexation check complete"

**Metadata Extraction:**
Extracts human-readable values from agent_events.metadata JSONB:
- page_title, page_slug, service_name, city_name
- pages_count, pages_validated, pages_refreshed
- customer_first_name, customer_last_initial, customer_name, rating
- photos_count, project_name
- leads_count, neighborhood, zip_code, city, storm_event_type
- event_types (array), events_count
- drip_phase, batch_name

**Integration:**
- Called by `/api/portal/activity` route
- Consumed by `/portal/activity` page (day-grouped feed with category color coding)

**Test Coverage:**
- Tested indirectly via `/api/portal/activity` route tests in `tests/unit/portal/api-routes.test.ts`

---

## RBAC AWARENESS FOR BUILD EXECUTORS (LOCKED 2026-05-23)

Every Phase 1 agent implementation must be RBAC-aware from initial scaffold. The architecture is locked in `docs/architecture/ROLE_HIERARCHY_ARCHITECTURE_SPEC.md` and propagated across all governance files via the 2026-05-23 synchronization.

### What the build executor must know

**1. Three operator-side roles plus client role:**
- `master_admin` — platform owner, top of hierarchy
- `senior_admin` — trusted operational manager
- `va` — virtual assistant
- `client` — existing client portal role, unchanged

**2. Global role scoping:**
Roles are global, not per-client. A user has exactly one active role row in the `user_roles` table.

**3. Required auth helpers for every operator-side route:**

```typescript
import { getOperatorContext } from '@/lib/auth/operator-context';        // Contract 70
import { getUserActiveRole, hasPermission } from '@/lib/auth/role-context'; // Contract 71

export async function POST(request: NextRequest, ...) {
  // Step 1: Contract 70 — auth verification
  const { userId, supabase } = await getOperatorContext(request);

  // Step 2: Contract 71 — role lookup (fresh, not cached)
  const userRole = await getUserActiveRole(supabase, userId);

  // Step 3: Contract 71 — permission check against canonical matrix
  if (!hasPermission(userRole, 'approve_flagged_page')) {
    await logDeniedAction(supabase, userId, userRole, 'approve_flagged_page', clientId);
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Step 4: Contract 67 (amended) — resource ownership/access
  // For master_admin and senior_admin, ownership is satisfied by operator-side role
  // For va, additional per-action checks may apply (see permission matrix)

  // Step 5: Execute action

  // Step 6: Contract 72 — log to user_actions with three-attribute attribution
  await supabase.from('user_actions').insert({
    acting_user_id: userId,
    acting_user_role: userRole,
    client_id: clientId,
    action_type: 'approve_flagged_page',
    result: result.success ? 'success' : 'failed',
    justification: request.justification,
    metadata: { ... }
  });
}
```

**4. Permission matrix as code:**

The canonical permission matrix lives in `src/lib/auth/permission-matrix.ts`. Adding a new protected action requires updating both:
- The TypeScript matrix
- The matrix table in `ROLE_HIERARCHY_ARCHITECTURE_SPEC.md` Section 3

A verification script (`scripts/verify-permission-matrix-sync.ts`) checks that both stay in sync. Drift blocks the build.

**5. Audit attribution requirements (Contract 72):**

Every audit log row in `user_actions` MUST include:
- `acting_user_id` (NOT NULL)
- `acting_user_role` (NOT NULL — captured at action time, not cached)
- `client_id` (nullable only for platform-level actions like role grants)

Missing any of these in an INSERT statement is blocked by `scripts/verify-audit-attribution.ts` at pre-commit.

**6. A-02 prerequisite check (Contract 73):**

A-02 Page Generator cannot execute for a client unless `client_ingestion_versions` contains a row with:
- `client_id = <target_client_id>`
- `is_current = TRUE`
- `status IN ('success', 'manually_provided')`
- `approval_status IN ('auto_approved', 'approved', 'manually_provided')`

The check happens at A-02 entry. There is no override at the A-02 layer — overrides happen at the A-44 layer via master_admin manual asset provision.

**7. Verification scripts that block commits:**

- `scripts/verify-rbac-pattern.ts` — blocks direct role checks (`user.role ===` or `getRole(` patterns outside the canonical helper)
- `scripts/verify-audit-attribution.ts` — blocks user_actions inserts missing required columns
- `scripts/verify-permission-matrix-sync.ts` — blocks divergence between TypeScript matrix and governance document
- `scripts/verify-operator-auth-pattern.ts` — Contract 70 (existing)
- `scripts/verify-insert-patterns.ts` — Contract 69 (existing)

All five scripts run in `pnpm verify:ci`.

### What this means for new agent implementations

Every Phase 1 agent that exposes a manual trigger API or operator-facing surface must:

1. Use `getOperatorContext()` + `getUserActiveRole()` + `hasPermission()` at the route handler
2. Check the canonical permission matrix for who can trigger this agent
3. Log every trigger attempt to `user_actions` with three-attribute attribution
4. For agents that mutate client state, also log to `user_actions` regardless of success/failure
5. For A-02 specifically: enforce Contract 73 at entry

Agent specifications in this AGENTS.md file include a "Manual Trigger Permission" note specifying which roles can trigger the agent. New agent specifications added going forward must include this note.

### Backward compatibility

- Existing `operator@tarritrix.test` account auto-promoted to `master_admin` via Migration N+2 (`seed_user_roles_from_auth_users.sql`)
- Existing `clients.operator_id` pointers preserved (semantics: "the master_admin or senior_admin ultimately accountable for this client")
- Existing `operator_actions` rows backfilled with `role_at_time_of_action = 'operator_legacy'`; new writes go to `user_actions` table
- Existing seeded clients (E4 Construction & Roofing, others) receive synthetic A-44 baseline rows via Migration N+8 so Contract 73 is satisfied at database constraint level; `clients.ingestion_synthetic_baseline = TRUE` flag marks them for real A-44 scrape at next operator interaction

---

## PHASE 1 AGENT BUILD STATUS

### Infrastructure (Foundation) — ✅ COMPLETE
- B1: Base Agent Framework
- B2: Multi-Provider LLM Router
- B3: Structured Logging + Sentry Integration

### Phase 1 Agents (15) — 7 SHIPPED, 8 REMAINING (verified 2026-05-23 against STATE_OF_THE_BUILD.md)

Listed in execution sequence order per BLUEPRINT.md Section 4.2 Post-Onboarding Pipeline:

- A-01 Intake Processor ✅ SHIPPED 2026-05-18 (commit b4c03d2)
- A-44 Client Knowledge Ingestion Engine — ⏳ NOT STARTED — relocated to Phase 1 per 2026-05-23 governance synchronization (was Phase 1.5)
- A-10 Content Profile Builder (with heatmap) — ⏳ NOT STARTED
- A-02 Page Generator ✅ SHIPPED 2026-05-18 (commit 8b09e21) [6/6 Playwright tests passing] + Service Hub support (2026-05-20)
  ⚠️ Contract 73 enforcement PENDING per P11 work item 8 — A-02 entry point must be updated to verify A-44 prerequisite. Synthetic baseline (Migration N+8) preserves existing E4 page generation until real A-44 scrape runs.
- A-03 Schema Generator ✅ SHIPPED 2026-05-19 (commit 1e67ed5) [5/5 Playwright tests passing]
- A-04 Map Embed Generator ✅ SHIPPED 2026-05-20 (commit eb69b83) [5/5 Playwright tests passing]
- A-05 Page Validator (16 gates) ✅ SHIPPED 2026-05-20 (commit 1123e0d) [8/8 Playwright tests passing] + G16 Hub Completeness (2026-05-20)
- A-06 Internal Link Builder ✅ SHIPPED 2026-05-20 [7/7 Playwright tests passing]
- A-07 Sitemap Generator ✅ SHIPPED 2026-05-19 (commit pending verification) [6/6 Playwright tests TBD]
- A-08 Indexation Tracker — ⏳ NOT STARTED [PRIORITY: gates external client onboarding; can build in parallel with RBAC foundation per P11 exception]
- A-09 Conversion Handler — ⏳ NOT STARTED
- A-11 Content Refresh Engine — ⏳ NOT STARTED
- A-14 Review Velocity Engine — ⏳ NOT STARTED
- A-18 Job Evidence Ingestion Engine — ⏳ NOT STARTED
- A-19 Universal Integration Hub — ⏳ NOT STARTED

**Build order (mandatory sequence per MASTER_BUILD_SPEC.md Section 25 RBAC and A-44 Build Sequence):**

1. RBAC foundation (Migrations N+1 through N+8 from SCHEMA_REGISTRY.md) — schema layer
2. RBAC code layer (permission-matrix.ts, role-context.ts, verification scripts)
3. RBAC UI surfaces (/dashboard/users, /dashboard/audit, /dashboard/clients/[id] Tab 7)
4. A-44 Client Knowledge Ingestion Engine implementation
5. CRON-03 a44-quarterly-refresh scheduling
6. A-02 entry point updated to enforce Contract 73 check (refactors shipped A-02 to add the prerequisite verification)
7. Legacy operator routes refactored route-by-route from Contract 67 pattern to Contract 71 pattern
8. Then remaining Phase 1 agents (A-08, A-09, A-10, A-11, A-14, A-18, A-19) per existing dependency chain

### CRON Jobs (3) — ⏳ NOT SCHEDULED
- CRON-01 Drip Publisher (3am UTC daily)
- CRON-02 Indexation Runner (6am UTC daily)
- CRON-03 a44-quarterly-refresh (daily evaluation, fires per client when `clients.next_ingestion_scheduled_at <= NOW()` with ±7 day jitter)

**Next Priority:** RBAC foundation (Migrations N+1 through N+8 plus permission-matrix.ts + role-context.ts library) — the next agent build is A-44, which depends on RBAC foundation being in place first because A-44 writes to client_ingestion_versions (one of the RBAC migration's new tables). A-08 Indexation Tracker can build in parallel with RBAC foundation per the P11 exception declared in STATE_OF_THE_BUILD.md.

---

## PHASE 1 AGENT SPECIFICATIONS

### A-02: Page Generator

**Purpose:** Generate city + service SEO landing pages via LLM-powered content generation.

**Status:** Not yet built. Core Phase 1 agent. Blocked from execution per Contract 73 until A-44 produces a successful current ingestion version for the target client.

**Prerequisite Verification (Contract 73 enforcement):**

A-02 entry point MUST perform this check before any LLM call:

```typescript
const ingestionStatus = await supabase
  .from('client_ingestion_versions')
  .select('id, status, approval_status')
  .eq('client_id', clientId)
  .eq('is_current', true)
  .maybeSingle();

if (!ingestionStatus.data ||
    !['success', 'manually_provided'].includes(ingestionStatus.data.status) ||
    !['auto_approved', 'approved', 'manually_provided'].includes(ingestionStatus.data.approval_status)) {
  throw new ContractViolationError('A-02 blocked: Contract 73 requires successful A-44 ingestion for client_id: ' + clientId);
}
```

The check is mandatory. There is no override path at the A-02 layer — overrides happen at the A-44 layer via the master_admin manual asset provision flow per BLUEPRINT.md Part 10.5 Section 10.5.8.

**Reading A-44 Output:**

After Contract 73 prerequisite check passes, A-02 reads from these A-44-populated tables to inform generation:

- `client_brand_voice_model` — tone of voice, terminology preferences, brand vocabulary
- `client_ingested_assets` — logos, manufacturer badges, certifications (current version's assets via `is_current=TRUE` filter and `asset_version` join)
- `client_keyword_gap_analysis` — keywords client should rank for, used to inform topic targeting

A-02 must NOT generate content with placeholder or hallucinated brand voice when client_brand_voice_model is populated for the client. A-02 reads the model and adopts its voice descriptors.

**Output Requirements (Visual Discipline):**

Every page A-02 generates MUST place a primary contact affordance in the first viewport on both mobile (375px width) and desktop (1280px width). Acceptable affordances:
1. Phone number CTA (tel: link, large, tap-friendly on mobile)
2. "Get a Quote" form (inline above the fold on desktop, sticky button → modal on mobile)
3. Combination of both

This is non-negotiable. Pages that fail above-the-fold contact card audit MUST not pass A-05 Page Validator. A-05 explicitly checks for this.

**Service Hub Pages (Tier 2 Architecture):** When intent='service-hub', A-02 triggers Opus-based generation with extended context and structural requirements per docs/architecture/service-hub-pages-spec.md. Service hub pages serve as parent pages in the hub-and-spoke hierarchy and require elevated quality standards.

**Dependencies:**
- A-01 (intake — provides client record)
- A-44 (knowledge ingestion — provides brand voice, badges, certifications, NAP) — **NEW HARD DEPENDENCY per Contract 73**
- A-10 (content profile — provides 4-layer differentiation profile, runs between A-44 and A-02)
- A-05 (validation — runs after A-02 completes)

**Manual Trigger Permission:** Triggering A-02 manually via `/api/agents/a-02/trigger` requires master_admin or senior_admin role per the canonical permission matrix in ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 3.3. VAs cannot trigger A-02 (LLM cost-bearing operation).

### A-05: Page Validator (15 Gates)

**Purpose:** Quality gatekeeper for all A-02-generated pages. Runs 15 validation gates; pages must pass all gates to become eligible for publishing.

**Status:** Not yet built. Core Phase 1 agent. Build order LOCKED 2026-05-19: A-03 -> A-04 -> A-05 -> A-07 -> A-08. A-05 validates A-03 schema output and A-04 map embed output; building A-05 before A-03/A-04 means stubbing inputs.

**Validation Gates:** Canonical G1-G15 set. See BLUEPRINT.md "A-05 PAGE VALIDATOR -- 15 GATES (Canonical)" section and TARRITRIX_ARCHITECTURE_2026-05-14.md Section 3 for full gate definitions, override matrix, cost model, and acceptance criteria.

**G16 Hub Completeness Gate (Service Hub Pages):** Service hub pages (intent='service-hub') require additional validation via G16 Hub Completeness gate per docs/architecture/service-hub-pages-spec.md. G16 validates service hub structural requirements, context depth, and parent-child relationship integrity before allowing hub publication.

**Above-the-fold contact card (G7a):** A-05 performs static DOM inspection of generated HTML. Page must contain at least one <a href="tel:..."> element or <form> element in the contact-affordance zone of the markup. Failure = page does not pass validation, remains in draft status. Static parse only — headless browser rendering (Path A) deferred to Phase 1.5.

**Dependencies:** A-02 (page generation)

**Referenced by:** CRON-01 (drip publisher only publishes pages that pass A-05)

### A-06: Internal Linker

**Purpose:** Build and maintain internal link graph across all client pages, establishing site hierarchy and topical relevance signals.

**Status:** Not yet built. Core Phase 1 agent.

**Hub-and-Spoke Architecture Enforcement:** A-06 enforces the three-tier hub-and-spoke page hierarchy via parent_hub_id foreign key relationship per docs/architecture/service-hub-pages-spec.md. Tier 3 location pages link to their Tier 2 service hub parent; service hubs link to the Tier 1 homepage. This FK constraint ensures architectural integrity and prevents orphan pages.

**Dependencies:** A-02 (page generation)

**Referenced by:** A-36 Internal Link Pattern Shuffler (Phase 1.5 anti-footprint variation)

### A-44: Client Knowledge Ingestion Engine (RELOCATED TO PHASE 1 — 2026-05-23)

**Phase:** 1 (relocated from Phase 1.5 per operator decision 2026-05-23)
**Status:** ⏳ NOT STARTED — next agent build after RBAC foundation completes
**Purpose:** Capture the client's existing brand voice, terminology, NAP data, certifications, manufacturer badges, customer testimonials, and visual identity assets from their public website so that Tarritrix-generated pages adopt the client's authentic brand voice. Without A-44, generated pages lack brand consistency and authentic trust signals — violating Contract 61 (AEO/Voice/Conversion Discipline) and Contract 18 (Evidence Authenticity HARD).

**Sequence:** A-44 inserts between A-01 and A-10 in the post-onboarding pipeline. A-02 cannot execute for a client until A-44 produces a successful current ingestion version per Contract 73.

**Canonical Specification:** Full A-44 specification with cadence, diff detection, failure handling, override path, and storage model lives in BLUEPRINT.md Part 10.5. This AGENTS.md entry is the executor-facing summary.

**Inputs:**
- Client website URL captured in onboarding Step 2 (`clients.website_url`)
- Client GSC OAuth permission (if granted in onboarding Step 6) — provides ranking keyword data
- Playwright headless crawler with 2-second rate limit per request
- Existing `cities` table for NAP normalization
- LLM router (B2) for tone of voice summarization

**Capture Targets (15 categories):**

1. Brand voice and terminology
2. Existing ranking keywords (via GSC API if available)
3. NAP data (Name/Address/Phone in E.164)
4. Service descriptions verbatim
5. Tone of voice (formal / casual / expert / friendly)
6. Existing claims, certifications, awards
7. Customer testimonials with attribution
8. Case studies and project photos
9. Manufacturer badges (GAF, CertainTeed, Owens Corning, IKO)
10. Trust marks (BBB, Angi, HomeAdvisor)
11. Professional licensing badges
12. Logos (header, footer, alternate marks)
13. Insurance certifications
14. Industry association memberships
15. EXIF data from photos worth importing to evidence_items

**Process:**

1. Verify client_ingestion_versions does not already contain a row with `status='in_progress'` for this client (prevents duplicate runs)
2. Create new row in client_ingestion_versions with status='in_progress', trigger_type per trigger source, triggered_by_user_id, version_number = COALESCE(MAX(version_number), 0) + 1
3. Initiate Playwright crawl respecting robots.txt and 2s rate limit
4. Extract text via DOM parsing
5. Run LLM-assisted summarization for tone/voice (cost ~$0.35–0.55 per scrape)
6. Extract images and classify (logo / badge / photo / other) via deterministic heuristics + LLM classification for ambiguous cases
7. Write captures to client_ingested_assets, client_brand_voice_model, client_keyword_gap_analysis
8. Compute diff_severity vs prior current version (if any) using deterministic hash algorithm per BLUEPRINT.md Part 10.5 Section 10.5.5
9. Determine approval_status based on diff_severity and trigger_type:
   - First-ever scrape: `auto_approved`
   - Subsequent with diff_severity in (none, minor): `auto_approved`
   - Subsequent with diff_severity in (material, breaking): `pending_approval`
10. If `auto_approved`: set `is_current=TRUE`, mark previous current row `is_current=FALSE`, update `clients.current_ingestion_version_id`
11. If `pending_approval`: raise P1 advisory signal; prior version remains current
12. Update `clients.last_ingestion_at`, `clients.next_ingestion_scheduled_at = NOW() + INTERVAL '90 days' + (random_jitter ±7 days)`
13. Mark client_ingestion_versions row `status='success'`, `scrape_completed_at=NOW()`
14. Log to agent_events with cost, latency, version_number

**Three Refresh Triggers:**

Per BLUEPRINT.md Part 10.5 Section 10.5.4:

1. **Onboarding (mandatory, blocking)** — Step 9 of onboarding wizard, automatic platform-executed
2. **Quarterly CRON (CRON-03 a44-quarterly-refresh)** — daily evaluation, ±7 day jitter on next_ingestion_scheduled_at
3. **Manual (master_admin or senior_admin)** — Force Re-scrape button on /dashboard/clients/[id] Tab 7

A fourth signal-driven trigger is deferred to Phase 1.5.

**Failure Handling:**

If scrape fails (site down, robots.txt blocks, parse error):

1. client_ingestion_versions row marked `status='failed'`, `failure_reason` populated
2. Existing current version (if any) remains current; A-02 continues with stale data
3. P2 advisory signal raised
4. Exponential backoff retry: +1 day, +3 days, +7 days
5. After 7 days of consecutive failures, escalate to P1 signal
6. Master_admin can manually block A-44 for a client via `clients.ingestion_blocked=TRUE` with reason

**Override Path (Contract 73):**

Master_admin only can bypass A-44 prerequisite for a client via manual asset provision when client's website is unscrapable. Process documented in BLUEPRINT.md Part 10.5 Section 10.5.8.

**Risk Acknowledgment (carried forward from 2026-05-17 operator decision):**

No preemptive copyright filtering on captured manufacturer badges, certifications, or trust marks. Cease-and-desist is the rare-case recovery path. If C&D received for any specific asset, remove that asset from active rendering and disable client re-display via client_ingested_assets table flag.

**Outputs:**

- client_ingested_assets table populated with per-asset rows
- client_brand_voice_model row updated for the client
- client_keyword_gap_analysis row updated for the client
- evidence_items extended with ingested photo imports
- client_ingestion_versions row created with appropriate status/approval_status
- clients.current_ingestion_version_id pointer updated to is_current row
- clients.last_ingestion_at, next_ingestion_scheduled_at updated
- agent_events log entry with cost, latency, version_number

**Dependencies:**
- A-01 (intake — provides client record with website_url)
- Migrations N+1 through N+8 from SCHEMA_REGISTRY.md (RBAC foundation must exist; client_ingestion_versions table must exist)
- B1 base agent framework
- B2 LLM router (for tone-of-voice summarization)
- Playwright runtime in Edge Function context

**Manual Trigger Permission:** Triggering A-44 manually via `/api/agents/a-44/trigger` requires master_admin or senior_admin role per the canonical permission matrix in ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 3.3. VAs cannot trigger A-44 (touches client website, moderate LLM cost, may produce diff requiring approval).

**Contract Enforcement:**

- Contract 73 (Pre-Generation Knowledge Ingestion Requirement) — A-02 entry checks A-44 status
- Contract 71 (RBAC Enforcement) — manual trigger gated by permission matrix
- Contract 72 (Multi-User Audit Attribution) — manual triggers and override actions logged to user_actions
- Contract 61 (AEO/Voice/Conversion Discipline) — A-02 reads client_brand_voice_model output
- Contract 18 (Evidence Authenticity HARD) — A-44 outputs feed A-43 trust signal composer

---

## VENDOR DECISIONS (LOCKED)

### Phase 1.5 SERP API Vendor
- **Vendor:** Decodo (formerly Smartproxy) SERP API
- **Locked:** 2026-05-16
- **Powers:** Geo-Grid Layer 2 (real Google rank tracking)
- **Feature flag:** platform_config.geo_grid_layer_2_rankings = false in Phase 1, true in Phase 1.5
- **No new agent required** — dashboard components consume Decodo via direct API call from /api/portal/geo-grid-rankings and /api/clients/[id]/geo-grid-rankings (Phase 1.5 routes, not yet built)
- **Phase 1 dashboard build** does NOT depend on this vendor — Layer 1b uses internal page_performance_daily data
- **DIY scraper:** PERMANENTLY REJECTED. See BLUEPRINT.md vendor decision rationale.

### Phase 1 Dashboard Build — No New Agents
The Phase 1 Dashboard Build (MASTER_BUILD_SPEC.md Section 23) is a UI/data-presentation effort. No new agents added to this file. Dashboard surfaces consume existing agent output:
- A-08 Indexation Tracker → indexation_records → KPI cards
- A-09 Conversion Handler → conversions → KPI cards, lead panel
- A-10 Content Profile Builder → service_area_heatmaps → geo-grid cells
- A-11 Content Refresh Engine → page_performance_daily → performance tier classification
- A-18 Job Evidence Ingestion → evidence_items → future Geo-Grid Layer 1a
- A-19 Universal Integration Hub → external lead delivery → lead performance panel

The above agents are scoped in Phase 1 per MASTER_BUILD_SPEC.md Section 1. The dashboard build does not modify their specs.


---

## A-21: HYPERLOCAL GEOGRAPHIC ENGINE (Phase 1.5)

### A-21: Hyperlocal Geographic Engine

**Phase:** 1.5 (PROMOTED FROM PHASE 2)

**Status:** ⏳ NOT STARTED

**Purpose:** ZIP-code, neighborhood, drive-time, and route-corridor page generation. Bridges granularity gap between Storm Intelligence Engine (ZIP-level signals) and current page architecture (city-level). Without A-21, the value of every storm signal drops 60% because resulting pages target city granularity instead of ZIP/neighborhood.

**Inputs:**
- Census API (already integrated for cities table)
- Google Maps API for polygon and drive-time data
- County appraisal district open data (verified Texas counties only, see docs/architecture/county-data-sourcing.md)
- Storm Intelligence Engine ZIP-level alerts
- Client service area polygons from existing service_area_heatmaps table

**Process:**
1. Ingest county property data per verified tier (Tier 1 API, Tier 2 bulk file, Tier 3 disabled)
2. Aggregate parcels by neighborhood polygon
3. Compute neighborhood-level signals (median property value, parcel density, building permit velocity)
4. Generate neighborhood, drive-time corridor, and route-corridor page candidates
5. Pass candidates to A-02 Page Generator with hyperlocal context
6. Track per-neighborhood page performance for refresh prioritization

**County Data Sourcing (verified 2026-05-21):**

**Tier 1 (free programmatic API):**
- Williamson County (WCAD): Socrata Open Data API at data.wcad.org
- Bexar County: ArcGIS Hub at gis-bexar.opendata.arcgis.com
- Hays County (HaysCAD): ArcGIS Hub at hays-county-haysgis.hub.arcgis.com

**Tier 2 (free annual bulk file):**
- Travis County (TCAD): Electronic appraisal roll at traviscad.org/publicinformation
- Bell County (BellCAD): Data downloads with shapefiles at bellcad.org/data/

**Tier 3 (no public data, hyperlocal disabled):**
- All other counties default to Tier 3 until verified
- Hyperlocal page generation disabled for Tier 3 counties
- Operator may manually designate target neighborhoods for Tier 3 county clients during onboarding as Authority/Dominance tier benefit

**Full architecture:** docs/architecture/county-data-sourcing.md

**Verification artifacts:** 
- scripts/verify-county-data-sources.ps1 (discovery probe script)
- scripts/county-api-verification-results.csv (probe results)
- scripts/probe-bell-county.ps1 (Bell County deep probe)

**Cadence:**
- Tier 1 API refresh: weekly
- Tier 2 bulk file refresh: annually (when county publishes new certified roll)
- Page generation: triggered on client onboarding for Tier 1/2 county clients

**Strategies covered:** Neighborhood page ecosystems, drive-time relevance modeling, local entity co-occurrence (landmarks, highways), hyperlocal FAQ generation, route-page architecture, service-area polygon sculpting, neighborhood authority pages, local resource hubs, ZIP-code targeting systems.

**Tables required (LOCKED, MIGRATIONS NOT YET GENERATED):** neighborhoods, zip_codes, landmarks, drive_time_polygons, route_corridors, parcels, county_data_sources

**Contract enforcement:** Contract 50 (Durable Design), Contract 64 (Service Role Grants), Contract 65 (System User Seed for ingestion logs)

**Architectural Note:** This is structural alignment with already-planned functionality, not a new feature category. Promoted to Phase 1.5 from Phase 2 because Storm Intelligence Engine ZIP-level outputs are blocked from full value without A-21's neighborhood-level page generation.

**Tier 3 Fallback:** Counties without verified free data access default to no hyperlocal page generation. Operator may manually designate target neighborhoods for Tier 3 county clients during onboarding as Authority/Dominance tier benefit.

**Priority:** CRITICAL — alongside A-12 GBP Agent in Phase 1.5 build sequence.

**Additional capabilities (relocated from prior BLUEPRINT "A-21 Client Site Ingestion" section per 2026-05-23 A-21/A-44 conflict resolution):**

These three capability augmentations were originally filed under "A-21 Client Site Ingestion" in BLUEPRINT.md, which was an incorrect slot assignment. The capabilities describe operations on county GIS data, service area classifications, and municipal context — geographic intelligence concerns that architecturally belong to A-21 Hyperlocal Geographic Engine. Relocated here per operator decision 2026-05-23 (Option 1 conflict resolution).

- **Parcel-density classification** — Per service area, classify residential vs commercial parcel density from public county GIS data. Output drives A-02 content angle (residential roofing focus vs commercial flat-roof focus). Sourced from the same county GIS APIs used for the parcels and county_data_sources tables.

- **Neighborhood topology classification** — Urban / suburban / rural / coastal per service area. Different topology produces different content emphasis (coastal mentions hurricane exposure; rural mentions distance/dispatch; urban mentions zoning constraints; suburban mentions HOA prevalence). Output stored as a per-neighborhood classification feeding A-02 content composition.

- **Municipal context enrichment** — Per service area, capture permitting requirements, HOA prevalence, zoning classifications. Output drives A-25 atomic-fact generation with real-world local specifics ("Round Rock requires roofing permits over $1,500 in valuation," "Cedar Park HOAs typically require architectural review for roof material changes"). Sourced from municipal open-data portals where available; manual operator entry for municipalities without open data.

---

## DISTRIBUTED RELEVANCE MAINTENANCE SYSTEM (Phase 1.5)

**Purpose:** Automated variation generation + proactive anti-footprint measures to defeat Google's duplicate content detection and algorithm-generated footprint recognition.

**Launch:** Phase 1.5 (after 100-page launch milestone)

**Architectural Durability:** Agents A-32 through A-37 specifications locked 2026-05-16. Component Variation Engine design locked per Contract 50.

### A-32: Content Seed Variation Engine

**Purpose:** Generate natural linguistic variations of seed templates to create unique, non-repeating content across thousands of pages.

**Input:**
- Seed template file (e.g., `.claude-seed/roofing-services-page.md`)
- Client profile data (business_name, location, service_lines)
- Target cities array

**Execution:**
1. Parse seed template into semantic blocks (intro, services, benefits, CTA)
2. For each block, generate 3-5 natural variations using LLM (prompt: "Rewrite this paragraph maintaining tone, facts, and structure but varying sentence structure, word choice, and phrasing. Avoid clichés.")
3. Per city page generation, randomly select one variation per block
4. Ensure no two cities use identical block sequences (enforce via hash comparison)

**Output:**
- Variation manifest: `content_variations` table (seed_id, block_id, variation_index, text_hash)
- Per-page variation selection: embedded in `pages.generated_content` metadata

**Success Criteria:**
- 0% exact duplicate paragraphs across 100+ city pages for same client
- Natural linguistic diversity (no "Mad Libs" effect)
- Semantic consistency with seed intent

**Cost Guard:** $0.001 per block variation generation; ~$5-10 per 1000-page client rollout

**Additional capabilities (2026-05-17 augmentation):**

- **Syntactic mutation systems** — Vary sentence structure independently of vocabulary (active/passive voice, simple/compound/complex sentence types, declarative/interrogative/imperative). Reduces detectable LLM phrasing pattern uniformity beyond word-level variation.
- **Narrative-angle rotation** — Rotate the lens through which a topic is framed across pages (homeowner perspective / contractor perspective / insurance perspective / building-science perspective). Same facts presented from different angles.

---

### A-33: Schema Markup Scrambler

**Purpose:** Inject natural variation into Schema.org JSON-LD markup to avoid identical footprint across client sites.

**Input:**
- Base schema template (LocalBusiness, Service, Review, etc.)
- Client data (name, address, hours, services)

**Execution:**
1. Vary property order (randomize JSON key sequence per page)
2. Vary date formats (ISO-8601 vs "MM/DD/YYYY" vs "Month DD, YYYY")
3. Vary phone format (`(555) 123-4567` vs `555-123-4567` vs `555.123.4567`)
4. Inject optional properties randomly (80% of pages include `priceRange`, 60% include `areaServed`, etc.)
5. Vary review inclusion pattern (not all pages include aggregateRating)

**Output:**
- Per-page schema JSON-LD injected into `<head>` via Next.js metadata API
- No centralized storage — generated at build/render time

**Success Criteria:**
- 0% identical schema fingerprints across 100+ pages for same client
- 100% Google Structured Data Testing Tool validation
- Natural variation in property presence and formatting

**Contract 34 Constraint:** Schema must remain semantically valid; variation for anti-footprint only, not for data accuracy compromise.

---

### A-34: Image Metadata Randomizer

**Purpose:** Vary alt text, title tags, and file metadata across city pages to avoid duplicate image detection.

**Input:**
- Base image assets (before-after photos, team photos, service illustrations)
- City-specific context (location, service type)

**Execution:**
1. Generate 5 variations of alt text per image type (e.g., "Expert roofing team in Austin TX" vs "Professional roofers serving Austin" vs "Austin TX roofing specialists")
2. Randomly assign variation per city page
3. Vary image title attribute similarly
4. If using client-uploaded photos with EXIF, strip metadata and inject randomized camera model, timestamp jitter (within 30-day window)

**Output:**
- Image variation manifest: stored in `image_metadata_variations` table (image_id, city_id, alt_variation, title_variation)
- Applied at render time via Next.js `<Image>` component

**Success Criteria:**
- 0% duplicate alt text across 100+ pages for same image asset
- Natural linguistic variation (not "keyword stuffing")
- Maintain accessibility standards (WCAG 2.1 AA compliant)

**Additional capabilities (2026-05-17 augmentation):**

- **AI-generated image detection at generation time** — Before randomizing metadata on any uploaded image, validate the image isn't AI-generated (cross-check with A-18 AI-image detection). Prevents randomized-metadata laundering of AI-generated content.

---

### A-35: Component Variation Engine (Page Fingerprint Diversification)

**Phase:** 1.5
**Status:** ⏳ NOT STARTED
**Purpose (EXPANDED 2026-05-17):** Defeat Google's "site quality at scale" footprint detection across all visual and structural dimensions of generated pages, not just component-level variation. Original Component Variation Engine scope retained and extended to full Page Fingerprint Diversification.

**Variation axes (11 total):**

1. **Component arrangement** (existing) — Module order varies per page
2. **Section order** (existing) — Section sequencing varies per page
3. **Heading hierarchy variants** (existing) — H2/H3 structure varies within H1 constraint
4. **Module insertion logic** (existing) — Which optional modules render per page
5. **Imagery placement** (NEW 2026-05-17) — Vary which images appear at hero, mid-page, footer
6. **Whitespace and density** (NEW 2026-05-17) — Vary padding/margin within brand-acceptable range
7. **Color accent rotation** (NEW 2026-05-17) — Different accent color per page from approved brand palette
8. **CTA placement** (NEW 2026-05-17) — Top / mid / sidebar / sticky / inline with constraint that at least one CTA is always above-the-fold
9. **Schema markup ordering** (NEW 2026-05-17) — JSON-LD object key order varies (semantically identical, byte-different)
10. **Testimonial selection and placement** (NEW 2026-05-17) — Different testimonials, different positions per page
11. **Internal link anchor text per occurrence** (NEW 2026-05-17) — Same link target uses different anchor text across source pages

**Hard constraints (CANNOT be varied):**
- Conversion form ALWAYS present and ALWAYS reachable above-the-fold on mobile (Contract 61)
- Brand colors stay within approved palette
- Typography stays within approved type system
- TCPA consent text immutable (ADR-12)
- Schema validity preserved (no broken JSON-LD from key reordering)
- WCAG 2.1 AA compliance preserved (contrast ratios, semantic HTML)

**Process:**
1. Per-page deterministic seed: hash(client_id + city_id + service_id)
2. Same seed always produces same variant tuple (reproducibility for A/B testing + crawler consistency)
3. Variant tuple selection logged per page for analysis and footprint detection auditing
4. Validates output against hard constraints before approving variant
5. If variant violates a constraint, fall back to next deterministic candidate

**Outputs:**
- client_component_variations table extended with new axis types
- page_fingerprint_log per page (which variant tuple was selected)

**Tables added/extended:** client_component_variations (extended), page_fingerprint_log (new)

**Contract enforcement:** Contract 35 Lock (design system integrity), Contract 59 (refresh cadence — jitter applies to fingerprint variation timing), Contract 61 (form constraints).

**Additional capabilities (2026-05-17 augmentation):**

- **Mobile/desktop layout divergence** — Vary responsive layout decisions per page seed (mobile-first hero placement, desktop sidebar configuration, breakpoint behavior). Adds dimension to fingerprint variation beyond same-device variants.

---

### A-36: Internal Link Pattern Shuffler

**Purpose:** Vary internal linking patterns across city pages to avoid detectable algorithmic footprints.

**Input:**
- City pages array (for one client)
- Service pages array
- Blog/content pages array

**Execution:**
1. Baseline: every city page links to homepage + 2-3 service pages + contact page (A-06 behavior)
2. Variation: randomly inject 1-2 additional links per page (to blog posts, other cities, FAQ page)
3. Vary anchor text (e.g., "roofing services" vs "expert roofers" vs "learn more about roofing")
4. Vary link placement (some in intro paragraph, some in sidebar, some in footer CTA)
5. Ensure no two city pages have identical link set (enforce via graph hash comparison)

**Output:**
- Internal link graph: stored in `internal_links` table (from_page_id, to_page_id, anchor_text, placement_zone)
- Sitemap reflects final link structure

**Success Criteria:**
- 0% identical internal link sets across 100+ city pages for same client
- Natural link diversity (no "spam" pattern)
- Maintain SEO best practices (no orphan pages, no broken links)

**Contract 36 Constraint:** Link injection must respect A-06 Internal Link Builder logic — no conflicts with primary linking strategy.

---

### A-37: Publish Cadence Jitter Engine

**Purpose:** Vary page publication timestamps to avoid detectable batch-publish patterns (Google's "PBN detector").

**Input:**
- Queue of pages to publish (e.g., 100 city pages for new client)
- Target publish window (e.g., 30 days)

**Execution:**
1. Baseline: CRON-01 Drip Publisher publishes 3-5 pages per day (per MASTER_BUILD_SPEC.md)
2. Variation: inject randomness into daily count (2 pages one day, 6 pages another, 0 pages for 1-2 days)
3. Vary time-of-day (not always 3am UTC — sometimes 7am, sometimes 11pm, sometimes 2pm)
4. Inject "quiet days" (1-2 days with no publishes) to simulate natural editorial calendar
5. Ensure final publish cadence: 80-120 pages in 30 days (3-4 per day average, but not uniform)

**Output:**
- Publish schedule: `publish_schedule` table (page_id, scheduled_publish_at, jitter_offset_minutes)
- CRON-01 Drip Publisher reads this table instead of uniform daily batches

**Success Criteria:**
- Publish pattern appears "human-edited" not algorithmic
- No detectable batch-publish spikes (avoid 50 pages in 1 day)
- Final rollout time: 30-45 days for 100-page client (vs 7 days if uniform batch)

**Contract 37 Lock:** Jitter must respect client launch SLA — if client needs live in 14 days, disable jitter and batch-publish (operator override flag: `clients.disable_publish_jitter = true`).

**Additional capabilities (2026-05-17 augmentation):**

- **Storm-reactive publishing bursts** — Increase publication velocity during legitimate storm events affecting service area. Real-world operational realism (a contractor responding to a hailstorm publishes more, not less). Burst capped at tier daily limits (Contract 59).
- **Tenant maturity pacing** — Slow early-stage tenant publication (5-15 pages/day in first 60 days), accelerate mature tenants (40-60/day after 6 months). Mirrors realistic small-business website growth curve. Prevents day-1 1000-page publish bursts that scream automation.

---

## AGENT A-32 THROUGH A-37 BUILD STATUS

**Status:** ⏳ NOT STARTED (Phase 1.5 agents)

**Precedence:**
- Must complete Phase 1 agent suite (A-01 through A-19) first
- Must achieve 100-page live milestone before building Distributed Relevance Maintenance System
- Decodo SERP API integration unlocks Phase 1.5 (no earlier)

**Architectural Lock:** 2026-05-16 per Contract 50 — specs above are canonical, no mid-build redesign permitted.

---

## ANSWER ENGINE OPTIMIZATION & VOICE SEARCH SUITE (Phase 1.5)

These agents work alongside the Distributed Relevance Maintenance System (A-32 through A-37) to ensure Tarritrix-generated pages are maximally citable by LLM-based search engines (ChatGPT, Perplexity, Claude, Google AI Overviews, Gemini) and optimized for voice-assistant readability.

### A-25: AEO Engine Suite (Answer Engine Optimization)

**Phase:** 1.5
**Status:** Scoped, not yet built. Phase 1.5 build.
**Purpose:** Optimize Tarritrix-managed pages for citation and inclusion by AI answer engines (ChatGPT Search, Perplexity, Claude.ai, Gemini Search, Bing Chat) — the emerging post-Google search layer estimated to capture 20-30% of search volume by 2027-2028.

## Submodules (11)

**A-25.1 Structured Q&A Block Generator** — Produces FAQ schema + extractable Q&A pairs per page

**A-25.2 Citation Anchor Optimizer** — Formats key facts as citable, attributable statements with measurable claims

**A-25.3 Entity Disambiguation** — Explicit named-entity tagging so AI engines correctly associate business name, service, location

**A-25.4 Long-Form Authority Section** — Extended content block (800-1200 words) per page providing depth AI engines require for citation

**A-25.5 Local Knowledge Graph Injection** — schema.org LocalBusiness extended with neighborhood, service area polygon, hours, accepted insurance

**A-25.6 Comparative Reference Builder** — Page includes structured comparisons (e.g., "vs DIY repair," "vs competitor A") that AI engines reference for buyer-intent queries

**A-25.7 Source Attribution Layer** — Explicit "according to [authority]" patterns that AI engines reproduce when citing

**A-25.8 Conversational Query Mapping** — Page content addresses long-tail conversational queries (the way humans speak to AI), not just keyword-matched queries

**A-25.9 Multi-Modal Answer Optimization** — Alt text, image captions, and structured data positioned for image-based AI answers

**A-25.10 Update Cadence Signaling** — schema.org dateModified + content versioning that signals recency to AI engines

**A-25.11 AEO Citation Tracker (integrates with A-47 AI Citation Tracking)** — Measures whether each page has been cited by ChatGPT, Perplexity, Claude, Gemini in test queries

## Dependencies

**Requires:** A-02 Page Generator (shipped), A-03 Schema Generator (not yet built), A-08 Indexation Tracker (priority post-A-05)

**Required before any external client onboarding:** NO — AEO is competitive differentiation, not a base requirement

**Required before scale > 50 external clients:** YES — Competitors will begin building AEO; Tarritrix's first-mover advantage depends on shipping A-25 before market saturates

---

### A-26: Schema/Structured Data Orchestration Engine

**Phase:** 1.5
**Status:** ⏳ NOT STARTED
**Purpose:** Implement maximally aggressive Schema.org markup on every page beyond the baseline A-03 generates — FAQPage, HowTo, LocalBusiness (no aggregateRating, no review per Contract 6), Service, Offer, Article with Author/datePublished/dateModified, Person/Organization with verified sameAs identifiers, Speakable schema for voice content, BreadcrumbList, WebPage.

**Inputs:**
- A-25 restructured page output
- A-03 baseline schema output
- Client entity verification data
- Page Q&A blocks from A-25

**Process:**
1. Read A-25 page output
2. Identify all entities present (people, businesses, places, services)
3. Generate appropriate schema for each entity and content block
4. Validate against Schema.org spec + Google Rich Results Test API
5. Verify sameAs URLs resolve and match entity data
6. Inject schema JSON-LD into page

**Hard prohibitions (cannot be overridden):**
- LocalBusiness NEVER contains aggregateRating
- LocalBusiness NEVER contains review property
- Schema must match visible page content
- Speakable cssSelector must reference real DOM content

**Outputs:**
- page_schemas table extended with new schema types
- page_entities table per page
- entity_verification_status table

**Tables added:** page_entities, entity_verification_status (extends existing page_schemas)

**Contract enforcement:** Contract 6 (TCPA/LocalBusiness immutability), Contract 61.

---

### A-27: Voice Search Optimization Engine

**Phase:** 1.5
**Status:** ⏳ NOT STARTED
**Purpose:** Optimize pages for voice-assistant queries — different distribution than typed queries, more question-form, more "near me" suffix, more local. Implements Speakable schema, featured-snippet capture, voice-keyword targeting separate from typed-keyword targeting.

**Inputs:**
- A-25 restructured page (with voice_answer_summary)
- A-26 schema output
- Voice-query patterns (per-client voice_query_patterns table, populated from Decodo voice-query data + PAA)

**Process:**
1. Validate Speakable schema cssSelector resolves to actual DOM content
2. Validate voice-answer summary word count (40-50 words)
3. Generate voice-keyword variants from typed keywords (add "near me", "how to", "who provides")
4. Cross-reference voice_keyword_targets against page content
5. Structure direct-answer paragraphs for featured-snippet capture
6. Score voice optimization completeness per page

**Outputs:**
- page_voice_optimization_score per page
- voice_keyword_targets per page
- Speakable schema validation results stored

**Tables added:** voice_keyword_targets, page_voice_optimization_score, voice_query_patterns

**Contract enforcement:** Contract 61.

---

### A-46: Directory Registration Agent

**Phase:** 1.5
**Status:** ⏳ NOT STARTED (Phase 1.5 — not yet shipped)
**Purpose:** Automate submission of Tarritrix-managed sites to high-quality web directories with A/B/C tier classification and Track A priority handling for directories that support automated registration APIs.

**Overview:** A-46 handles outbound directory registration for newly published Tarritrix tenant sites. Directories are classified by authority tier (A/B/C) and automation track (Track A = API-based automation supported, Track B/C = manual operator-driven). Track A directories receive automated registration submissions via standardized APIs (schema.org structured data, REST endpoints, OAuth-authenticated submission flows). Track B/C directories surface operator review queues with pre-populated submission templates for manual completion.

**Tier Classification:**
- Tier A: High-authority directories (DR 60+, established editorial review, proven SEO value)
- Tier B: Mid-tier directories (DR 30-60, moderate traffic, legitimate editorial standards)
- Tier C: Low-authority directories (DR <30, minimal traffic, limited SEO impact)

**Track A Automation:** For directories with published APIs, A-46 submits standardized business profile data (NAP, categories, description, contact info, social links, schema.org markup) via authenticated API calls. Tracks submission status and confirmation receipts per directory_submissions table.

**Track B/C Manual Queue:** For directories without automation support, A-46 generates pre-populated submission templates and queues them in operator review system with all required fields populated from client profile. Operator completes final submission manually.

**Detailed Specification:** See docs/agents/a-46-directory-registration-agent.md for complete tier classification criteria, Track A API integration specifications, submission workflow, success metrics, and operator queue management.

**Dependencies:** A-01 (client intake data), A-02 (published pages as submission targets)

**Tables added:** directory_submissions, directory_registry (tier/track classification), operator_review_queue

**Contract enforcement:** Contract 60 (no black-hat directory networks, legitimate directories only)

---

### A-47: LLM Citation Tracking Engine

**Phase:** 2 (measurement infrastructure, deploys after A-25/A-26/A-27 operational)
**Status:** ⏳ NOT STARTED
**Purpose:** Measure whether AEO/VSO work is producing actual LLM citations. Per-client periodic queries to ChatGPT, Perplexity, Claude, Google AI Overviews; parse responses for citations; match against client Tarritrix-generated pages; track frequency and competitive displacement.

**Note on slot:** A-47 chosen because A-28 is occupied by Topical Authority Engine (existing BLUEPRINT.md:1807-2037 canonical spec). Per Contract 50, existing locked architecture not disturbed.

**Inputs:**
- target_query_lists per client (real prospect queries client wants to rank for)
- API access to ChatGPT, Perplexity, Claude, Google AI Overviews

**Process:**
1. Daily, send each target query to each engine
2. Parse responses, detect citations (links, mentions, source attributions)
3. Match cited URLs against client's published Tarritrix pages
4. Track citation_count per page per engine per period
5. Detect citation displacement (competitor cited where Tarritrix was cited prior)
6. Identify which page structures get cited most (feedback signal to A-25)

**Cadence:** Daily per client. Max 50 queries/day per client.

**Cost controls per client per month:**
- Starter: $20 cap
- Growth: $50 cap
- Authority: $100 cap
- Dominance: $200 cap

**Outputs:**
- llm_citation_events table (timestamp, engine, query, cited_url, citation_context)
- llm_citation_summary table (rollups per page per period)
- citation_displacement_alerts on competitor displacement
- Operator dashboard citation trends

**Tables added:** llm_citation_events, llm_citation_summary, target_query_lists, citation_displacement_alerts

**Contract enforcement:** Contract 41 (LLM Cost Governance).

---

## DEFENSIVE INFRASTRUCTURE SUITE (Phase 1.5)

These agents defend against detectability of programmatic generation patterns at the HTTP wire layer, link graph topology layer, and penalty early-warning layer. They run alongside the Distributed Relevance Maintenance System (A-32 through A-37) and the AEO/VSO Suite (A-25 through A-27, A-46, A-47) to form the platform's anti-detection moat.

### A-38: HTTP Fingerprint Diffusion Engine

**Phase:** 1.5
**Status:** ⏳ NOT STARTED
**Purpose:** Wire-layer defense against crawler fingerprinting. Google's crawler builds platform fingerprints from HTTP response patterns over time — response time clustering, Last-Modified bursts, ETag pattern uniformity, header order, TTFB consistency. This agent diffuses those patterns within RFC-compliant ranges so each page response has a distinct natural-looking signature.

**Diffusion axes:**

1. Cache-Control TTL per page varies within natural range (3600 ± 1800 seconds)
2. Last-Modified header jittered within natural editorial cadence (not all pages show identical mtime)
3. ETag hash structure varies (not all ETags share platform-identifying prefix or length)
4. TTFB randomized within human-plausible band (50-300ms via deliberate Edge function delay)
5. Server header variation where allowed by hosting layer
6. Vary header content varies per page intent
7. Response header order varies per page (semantically identical, byte-different)

**Implementation:**
- Implemented in Vercel Edge Middleware
- Per-page deterministic seed drives diffusion values (reproducible for debugging)
- Diffusion values must remain within RFC-compliant ranges

**Hard constraints:**
- Cannot break HTTP semantics (Cache-Control values must be valid)
- Cannot break CDN behavior (Vary headers must accurately reflect content variation)
- Cannot break compliance headers (HSTS, CSP cannot be diffused)
- Cannot break web standards (Content-Type, charset never varied)

**Outputs:**
- http_diffusion_config per tenant (active diffusion ranges)
- agent_events sampled logging (not every request, ~1% sample rate)

**Tables added:** http_diffusion_config

**Contract enforcement:** Contract 59 (signal-driven jitter principle extends to wire layer).

**Additional capabilities (2026-05-17 augmentation):**

- **Deterministic diffusion per domain** — Use tenant domain + page path as diffusion seed rather than random-per-request. Ensures a given page's wire-layer signature remains stable within a crawl session (reducing "this domain is unstable" signals) while still diffusing across pages.
- **CDN vendor fingerprint rotation** — When multi-CDN setup operational (Cloudflare + Fastly as example), rotate edge vendors per tenant using deterministic rotation schedule. Prevents bulk-CDN-fingerprinting at Google scale. Requires DNS-level vendor switching (low frequency — quarterly rotation reasonable).

---

### A-39: Link Graph Naturality Engine

**Phase:** 2 (deferred — requires post-launch link graph baseline to optimize against)
**Status:** ⏳ NOT STARTED
**Purpose:** Mimic organic-link-growth power-law distribution rather than perfect symmetric platform-generated link graphs. Real authoritative sites have asymmetric link patterns — some pages are hubs, others are leaves, anchor text varies per link occurrence.

**Process:**
1. Compute organic link graph topology per client (which pages should be hubs, which should be leaves)
2. Power-law distribution enforced: 20% of pages get 80% of inbound internal links (hub pages)
3. Anchor text variation per link occurrence (same target page uses different anchor text from different source pages)
4. Asymmetric link patterns (not every city links to every other city — some pairs linked, some not)
5. Natural-language anchor text only (no exact-match keyword stuffing)
6. Respects A-06 hierarchy (state hub → city hub → service page) but adds naturalness within hierarchy

**Hard constraints:**
- Respects A-06 Internal Link Builder requirements
- Respects Contract 36 (Internal Link Pattern Shuffler must not violate A-06 hierarchy)
- Maximum 3 contextual cross-links per page (A-06 rule)
- Minimum 1 inbound link per published page (orphan-page prevention)

**Outputs:**
- internal_links table extended with anchor_text_variant column
- link_graph_topology per client (computed hub/leaf classification)

**Tables added:** link_graph_topology (extends internal_links)

**Contract enforcement:** Contract 36 (Internal Link Pattern Shuffler boundary respect).

**Additional capabilities (2026-05-17 augmentation):**

- **Hub-page competitive parity analysis** — For computed hub pages (service-area landing pages, state pages), compare inbound internal link count against top-ranking competitor pages using A-45 backlink data as proxy. If competitor hub pages show 15-30 internal links and Tarritrix hub shows 3, the computed topology is too sparse and should densify hub pages specifically.
- **Temporal link addition realism** — Avoid instantaneous link-graph changes. Spread internal link additions over 14-30 days using A-37 cadence jitter principles. Mirrors organic site evolution (editors don't add 100 cross-links in one deploy — they add 5-10 per week).

---

### A-42: Penalty Pattern Detection Engine

**Phase:** 1.5 (defensive infrastructure — MUST be operational before scaling page volume)
**Status:** ⏳ NOT STARTED
**Purpose:** Early-warning system for Google penalty signals. Penalties don't happen instantly — they show as ranking declines first, then index removal, then manual action. Detecting early lets the platform pause and investigate before catastrophic damage.

**Detection signals:**

1. Multi-keyword position drops (>10 positions across 5+ unrelated keywords within 7 days)
2. Index count drops (pages being removed from Google index)
3. Site:domain.com query returning fewer pages than platform shipped
4. Manual action notifications in Google Search Console (Manual Actions API)
5. Coverage report showing crawl errors or exclusions spike (>20% increase week-over-week)
6. Sudden traffic drops (>30% week-over-week without explanation)
7. CTR drops on previously-ranking pages (>15% decline on top-50 pages)

**Response actions on detection:**

1. P0 alert to operator (Sentry + dashboard + email)
2. Freeze new page generation for affected tenant (no new pages enter publish queue during investigation)
3. Diagnostic report generation: what changed, when, which pages affected, suspected cause
4. Pause A-37 publishing for affected tenant until cleared
5. Surface client-facing status indicator: "Site under review — generation paused"
6. Operator-only override to resume after diagnostic resolution

**Cadence:**
- Daily scans of GSC data per active client
- Hourly scans of high-priority signal endpoints (manual action notices)
- Continuous traffic monitoring via existing page_metrics infrastructure

**Outputs:**
- penalty_pattern_alerts table (timestamped detections)
- tenant_generation_freeze table (active freeze list)
- diagnostic_reports table (per-incident diagnostic packages)

**Tables added:** penalty_pattern_alerts, tenant_generation_freeze, diagnostic_reports

**Contract enforcement:** Contract 59 (freeze action overrides refresh cadence on detection).

**Additional capabilities (2026-05-17 augmentation):**

- **Multi-tenant correlation analysis** — If penalty signals fire across 3+ tenants in a 7-day window, this is a platform-level pattern, not tenant-specific. Escalate to P0 operator investigation — likely platform fingerprint detected (A-35/A-38/A-39 failure) or infra-layer issue (shared IP block, CDN vendor flag). Freeze ALL new tenant onboarding until cleared.
- **Pre-penalty velocity anomaly detection** — Track publishing velocity per tenant over 90 days. If a tenant accelerates from 10 pages/day to 60 pages/day within 7 days (operator-initiated urgency), log this as a known risk factor. If penalty signals fire, known acceleration is diagnostic context (not causation, but correlation). Helps distinguish "we got detected" from "we rushed and broke quality".

---

## AUTHENTICITY / TRUST / INGESTION SUITE (Phase 1.5 + Phase 2)

These agents provide the platform's authenticity foundation: ingest the client's existing brand and trust signals, compose genuine trust markers per page, coordinate legitimate external signal opportunities, monitor real engagement quality, and manage backlinks defensively. Strictly bounded by Contract 60 (no black-hat operations).

### A-40: External Signal Coordination Engine

**Phase:** 2 (requires client cooperation, deferred)
**Status:** ⏳ NOT STARTED
**Purpose:** Surface legitimate external-signal opportunities so client pages have real third-party corroboration. Generic programmatic sites with zero external signal are detectable as spam by Google's algorithm.

**Permitted operations:**

1. Identify legitimate industry directories client should manually register with (HomeAdvisor, Angi, BBB, local chamber of commerce, manufacturer certifications)
2. Coordinate with client's existing GBP so Tarritrix pages get linked from GBP posts naturally
3. Surface client's social-media accounts for client-initiated organic sharing of Tarritrix pages
4. Track unlinked brand mentions across the web and surface them for client-initiated link-request outreach
5. Identify legitimate citation opportunities (industry publications, local news, trade associations)
6. Generate draft outreach templates the client manually reviews and sends

**Strictly prohibited (per Contract 60):**

- Same as Contract 60 prohibition list
- No automated outreach
- No automated account creation
- No paid link placement
- No PBN participation

**Cadence:** Quarterly per-client opportunity scan. Continuous unlinked-mention monitoring via Google Alerts integration.

**Outputs:**
- external_signal_opportunities table (ranked by quality score)
- client_directory_registrations table (tracking client-completed registrations)
- unlinked_mentions_log (mentions detected awaiting client outreach)

**Tables added:** external_signal_opportunities, client_directory_registrations, unlinked_mentions_log

**Contract enforcement:** Contract 60 (Backlink Operations Strict Whitelist).

---

### A-41: Engagement Quality Engine

**Phase:** 2 (after baseline content infrastructure operational)
**Status:** ⏳ NOT STARTED
**Purpose:** Ensure every page is genuinely useful to visitors. Google increasingly weights user-behavior signals (dwell time, pogo-sticking, CTR). Useless pages get penalized regardless of technical SEO quality.

**Pre-publish quality checks:**

1. Information density check — does content answer the questions a real searcher has? Cross-reference against PAA + forum data for the target keyword.
2. Local relevance check — are local data points substantive (specific storm data, named neighborhoods, real local codes) beyond what a generic page would have?
3. Action-completion check — can a visitor accomplish a goal on the page (get estimate, schedule call, learn, compare)?

**Post-publish monitoring:**

1. Read page_performance_daily metrics
2. Detect poor-engagement signals: high bounce rate, low time-on-page, pogo-stick back to SERP
3. Flag pages with poor signals for A-34 (Image Metadata Randomizer / Local Context Builder) improvement pass
4. Track engagement trends over time per page

**Outputs:**
- page_engagement_score per page
- pre_publish_quality_flags table (issues caught before publish)
- post_publish_engagement_alerts table (issues caught after live traffic)

**Tables added:** page_engagement_score, pre_publish_quality_flags, post_publish_engagement_alerts

**Contract enforcement:** Contract 61 (page useful-to-visitor requirement extends here).

**Additional capabilities (2026-05-17 augmentation):**

- **Competitive engagement benchmarking** — For a given target keyword, extract median time-on-page and bounce rate from top-10 ranking pages (via heuristics or third-party tools like SimilarWeb). Compare generated page's engagement against competitive baseline. Flag pages that underperform median by >30% as engagement-quality liabilities.
- **Scroll-depth tracking** — Measure how far down the page visitors scroll before bouncing (requires client-side JS analytics). Pages where 70%+ visitors never scroll past hero section likely have weak above-fold value proposition. Triggers A-02 hero-section improvement pass.

---

### A-43: Trust Signal Composer

**Phase:** 2
**Status:** ⏳ NOT STARTED
**Purpose:** Assemble real provable trust signals per page. Generic programmatic pages have no trust signals — robots wrote them, no human in the loop. Pages that survive in competitive SERPs have provable human authority.

**Trust signals composed per page:**

1. Real client business credentials (license numbers, insurance, certifications) rendered with verification links
2. Real GBP reviews for the page's service area rendered with proper schema markup (NOT in LocalBusiness — separate Review schema per Contract 6)
3. Real EXIF-verified job evidence photos from evidence_items table (from A-18)
4. Real manufacturer badges/certifications (from A-44 ingestion: GAF, CertainTeed, BBB, etc.)
5. Proper Schema.org Person/Organization/Service markup with verified identifiers
6. Reviewer attribution (human at Tarritrix or client who reviewed the page, timestamps, role, signature)
7. Last-reviewed-by-human timestamps
8. License/certification expiration tracking — flag if expired

**Process:**

1. Per-page, query verified trust signal sources (evidence_items, client_credentials, gbp_reviews, A-44 ingested badges)
2. Validate each trust signal still current (license not expired, certification still valid, photo still in evidence_items)
3. Compose trust signal blocks into page output
4. Generate Schema.org markup tying trust signals to verified entities

**Hard constraints:**

- NEVER synthesize trust signals — only use real verified data
- NEVER use trust signals from another client (no badge sharing)
- Expired credentials must NOT be displayed (Contract 18 evidence authenticity)

**Outputs:**
- page_trust_signals table per page
- trust_signal_validation_log per signal per page

**Tables added:** page_trust_signals, trust_signal_validation_log

**Contract enforcement:** Contract 18 (Evidence Authenticity), Contract 45 (Review Authenticity), Contract 61.

---

### A-44: Client Knowledge Ingestion Engine — RELOCATED TO PHASE 1 (2026-05-23)

**Phase:** 1 (RELOCATED from Phase 1.5 per operator decision 2026-05-23)

**Canonical Specification:** The full A-44 specification is now located in the "PHASE 1 AGENT SPECIFICATIONS" section above (inserted after A-06 Internal Linker per Change 5 of the 2026-05-23 governance synchronization). The historical Phase 1.5 entry is preserved here as a marker indicating the relocation.

**Cross-Reference:**
- AGENTS.md Phase 1 Agent Specifications section — full A-44 spec
- BLUEPRINT.md Part 10.5 — canonical specification (mission, refresh model, diff detection, failure handling, override path, storage model)
- ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 7 — architectural decision context, master_admin override authority, backward compatibility plan for existing seeded clients
- SCHEMA_REGISTRY.md Group 16 — client_ingestion_versions table (Table 87) and the four migrations (N+4, N+5) that establish A-44's storage layer

**Reason for relocation:**

Operator decision 2026-05-23: A-44 cannot remain Phase 1.5 because A-02 Page Generator (Phase 1, core spine of the product) cannot generate brand-consistent pages without A-44 outputs. Pages generated without ingested brand voice produce generic AI-flavored output that fails Contract 61 (AEO/Voice/Conversion Discipline) and Contract 18 (Evidence Authenticity HARD). Contract 73 (Pre-Generation Knowledge Ingestion Requirement) is created in the same synchronization to enforce the prerequisite at the agent layer.

---

### A-45: Backlink Intelligence Engine

**Phase:** 2
**Status:** ⏳ NOT STARTED
**Purpose:** Read-only/advisory backlink monitoring. Defensive (toxic-link detection) and opportunistic (legitimate citation gap analysis). Strictly bounded by Contract 60. ZERO black-hat operations.

**Permitted operations:**

1. Read existing backlinks pointing at client domains via Ahrefs / SEMrush / Majestic APIs
2. Quality-score each backlink (DR, relevance, traffic estimate)
3. Detect toxic backlinks (link from spam site, link with overoptimized anchor, link from penalized domain)
4. Recommend disavow file updates (client manually submits to GSC)
5. Identify unlinked brand mentions (someone mentioned client by name but didn't link)
6. Surface legitimate directory registration opportunities
7. Competitor backlink gap analysis (which legitimate sources link to competitors but not to client)
8. Generate outreach draft templates the client can manually send

**Strictly prohibited (Contract 60):**

- All operations in Contract 60 prohibition list. Zero tolerance.
- No automated outreach
- No automated account creation
- No content for placement on other domains
- No paid link placement
- No PBN participation
- No reciprocal link manipulation

**Outputs:**
- backlink_inventory per client
- toxic_backlink_alerts table
- disavow_recommendations table
- unlinked_mention_opportunities table
- directory_registration_opportunities table
- competitor_backlink_gaps per client per competitor

**Tables added:** backlink_inventory, toxic_backlink_alerts, disavow_recommendations, unlinked_mention_opportunities, directory_registration_opportunities, competitor_backlink_gaps

**Contract enforcement:** Contract 60 (Backlink Operations Strict Whitelist).

**Additional capabilities (2026-05-17 augmentation):**

- **Anchor-text diversity analysis per target page** — For each page receiving backlinks, track anchor-text distribution (branded, naked URL, partial-match, exact-match). Flag pages where >60% of anchor text is exact-match keyword as over-optimization risk. Recommend disavowing or requesting anchor text modification from legitimate link sources.
- **Backlink acquisition velocity anomaly detection** — Track backlink acquisition velocity per tenant over time. Flag sudden acquisition spikes (20+ backlinks within 7 days where historical baseline is 2-3/month) as potential negative-SEO attack (competitor building toxic links to your domain). Requires immediate operator review + proactive disavow preparation.

---

## DEFERRED — PHASE 2+ MONETIZATION FEATURES

These agents are specified as skeletons to claim their slot per Contract 50 (Architectural Decision Durability) but are NOT built until prerequisite infrastructure and proven monetization exist. Building before prerequisites met would be premature and waste effort.

### A-31: Lead Download Engine

**Phase:** 2+ (DEFERRED — see Build Prerequisites)
**Status:** ⏳ SPEC SKELETON ONLY — NOT BUILT, DO NOT BUILD UNTIL PREREQUISITES MET
**Purpose:** Pay-per-lead download flow for enriched homeowner property data from hail swath impact zones. Operators draw polygons on a service-area map; the engine returns property records inside the polygon (homeowner names, mailing addresses, parcel data, estimated home value, recent permits, hail-event correlation) at $1 per lead, processed through Stripe per-download billing.

**Build Prerequisites (ALL must be satisfied before build begins):**

1. ATTOM Data Solutions API contract executed (or equivalent property data provider: CoreLogic, BatchData, PropStream)
2. Property data ingestion pipeline operational and tested at scale
3. Stripe per-download payment flow integrated with existing Stripe billing infrastructure
4. Tarritrix monetization proven via primary tier subscriptions (Starter $497 / Growth $997 / Authority $1,997 / Dominance $3,497) — meaning paying clients on the platform
5. Legal review complete for property data redistribution (varies by state, may require licensing data broker registration)
6. TCPA/CAN-SPAM compliance review for downstream use of homeowner contact data

**Until all 6 prerequisites are satisfied, A-31 build does NOT proceed regardless of operator urgency.**

**Functional scope (when eventually built):**

1. Operator UI: polygon-drawing tool on hail swath map (Mapbox or Google Maps Drawing API)
2. Query: ATTOM API for property records within polygon boundary
3. Enrichment: cross-reference against storm_events table to add hail-event correlation per property
4. Pricing: $1 per lead, minimum batch size to be determined
5. Stripe charge: per-download flow, no recurring subscription
6. Delivery: CSV download with property + hail-event fields
7. Tracking: lead_downloads table with operator_id, download_timestamp, lead_count, total_charge, polygon_geometry

**Tables (deferred):** lead_downloads, property_data_cache, hail_swath_polygons

**Hard prohibitions:**

- NEVER cache property data beyond legitimate operational period (90 days max per typical data licensing terms)
- NEVER redistribute downloaded leads outside operator's authorized organization
- NEVER include data fields outside the licensed scope of the property data provider's contract
- NEVER market this feature to operators as a "lead generation" service implying Tarritrix manufactures leads — it surfaces existing public-ish property data, the operator does outreach themselves

**Risk acknowledgments:**

- Per-state legal variance on property data resale and homeowner contact use
- TCPA exposure if leads used for outbound calls without proper consent flow
- CAN-SPAM exposure if leads used for outbound email without compliant footers
- Data broker registration may be required in California, Vermont, Texas, others
- Reputational risk if perceived as enabling unsolicited contractor outreach to storm victims

**Contract enforcement:** Contract 50 (Architectural Decision Durability — slot claimed, deferral locked). Future contract TBD when build approached.

**Operator decision log (2026-05-17):** Slot A-31 explicitly claimed for Lead Download Engine to prevent slot drift. Build deferred until 6 prerequisites met. This deferral is itself a Contract 50 architectural decision and is canonical.

**Additional capabilities (2026-05-17 augmentation):**

- **Multi-event polygon overlay** — Allow operators to draw multiple polygons (one per storm event within a service area) and query property records hit by ANY event OR ALL events (union vs intersection). Enables "homeowners hit by 2+ hail events in 3 years" targeting (higher damage likelihood, higher sales conversion).
- **Lead-quality scoring at download time** — Before delivering CSV, score each lead for sales-conversion likelihood using A-15 NOAA severity correlation + property value estimate + permit history + prior claim history if available. Sort CSV by score descending. Operators prioritize high-value leads first. Increases perceived lead quality vs undifferentiated property dump.
