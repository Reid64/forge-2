# TARRITRIX 1.0 — BEHAVIORAL CONTRACTS
**Version:** 2.0 | **Enforced by:** Every Claude Code session, every build

---

## PURPOSE

These contracts define the non-negotiable behavioral boundaries for every agent, every build session, and every deployment. Violation of any contract is a build failure — not a warning.

---


## HEADING CONVENTION (LOCKED 2026-05-23)

**All contracts in this document MUST follow this exact heading format:**

```
## Contract N: NAME
```

**Format rules:**
- Heading level: exactly `##` (h2). Do NOT use `###` (h3) for contract headings.
- Word "Contract": title case ("Contract"), NOT uppercase ("CONTRACT") or lowercase ("contract").
- Contract number: integer, no leading zeros, followed immediately by a colon.
- Separator after the colon: single space character.
- Name: the contract's title in title case.

**Examples of CORRECT headings:**
- `## Contract 1: The Six Laws`
- `## Contract 73: Pre-Generation Knowledge Ingestion Requirement`
- `## Contract 65: RESERVED`

**Examples of INCORRECT headings (do not use):**
- `## CONTRACT 1: THE SIX LAWS` (uppercase)
- `### CONTRACT 38 — REAL-DATA BINDING` (h3 with em-dash)
- `## Contract 35 - Vendor Dependency Management` (hyphen separator)
- `## Contract 31 — Personalized Demo Engine Protection` (em-dash separator)

**Sub-section headings within a contract body** (h3 level and deeper) are unaffected by this convention — they can use any format that fits the content.

**RESERVED contract slots** use the format `## Contract N: RESERVED` followed by a brief explanatory note. RESERVED slots prevent future Claude/CC sessions from incorrectly assuming the number is available for reuse.

**Numbering gaps** are documented as RESERVED slots when discovered. Genuine deletions of contracts (rare, requires governance synchronization) also leave RESERVED placeholders to preserve historical numbering.

**Enforcement:** A verification grep pattern `^## Contract \d+:` should match every contract heading in this document, returning a count equal to the total contracts (including RESERVED slots). The pattern `^### CONTRACT` should return zero matches.

**Normalization commit:** This convention was locked and applied platform-wide via the BEHAVIORAL_CONTRACTS.md heading normalization commit dated 2026-05-23. Prior governance sessions used four different heading formats; the normalization standardizes them.

---
## Contract 1: THE SIX LAWS

A feature is complete ONLY when all six laws pass. Any feature missing even one law is incomplete and must not be marked done.

1. **SCHEMA** — Tables exist in the real Supabase database. RLS is enabled. client_id is applied on all multi-tenant tables.
2. **API** — Routes exist and return real data. All routes are authenticated. client_id is sourced from the server-side session, never the request body.
3. **UI** — Real UI is rendered with real data. Zero placeholders. Zero hardcoded mock values.
4. **DATA** — All data comes from real API calls to real tables. Zero mocks, zero fixtures, zero hardcoded arrays in production code.
5. **WIRING** — Navigation is linked. Role-based access is correct. Every button and form persists data to the database.
6. **VERIFICATION** — A human has confirmed the feature works correctly in a real browser against the live deployed application.

---

## Contract 2: TESTING

Every agent build includes tests before the agent is marked complete.

- Unit tests cover all agent logic branches
- Integration test confirms correct DB writes for happy path and failure paths
- Test results documented in STATE_OF_THE_BUILD.md
- No agent is marked complete without passing test suite
- Test files live in /tests/ directory, named to match agent: a01-intake.test.ts

---

## Contract 3: ANTI-FABRICATION

- Never assume a database column exists — check SCHEMA_REGISTRY.md first
- Never assume a route exists — verify with Select-String across codebase first
- Never invent API responses — use real observed data from real API calls
- Never guess at table relationships — read SCHEMA_REGISTRY.md
- Never fabricate statistics, claims, or data in LLM prompts or content
- Never assume a feature flag is enabled — query platform_config table

---

## Contract 4: SCHEMA IMMUTABILITY

- Never run ALTER TABLE on a production database without a versioned migration file
- Migration files are named: YYYYMMDDHHMMSS_description.sql
- Every new column requires a migration file — no exceptions
- Migration files are run via: supabase db push
- After every migration: verify in Supabase dashboard that table shape matches SCHEMA_REGISTRY.md
- If SCHEMA_REGISTRY.md and real DB diverge — fix SCHEMA_REGISTRY.md to match reality, then file a correction migration

---

## Contract 5: CLIENT ISOLATION

- client_id is always sourced from auth.uid() via RLS — never from request body
- RLS is enabled on every table — verified after every migration
- Cross-tenant queries are impossible by design — RLS enforces this
- CRON-02 runs cross-tenant leak detection on every execution
- Any P0 cross-tenant alarm stops all work until resolved

---

## Contract 6: TCPA IMMUTABILITY

- Consent fields in the conversions table cannot be updated after INSERT
- DB-level trigger enforces this — no application-layer workaround permitted
- Phone numbers stored as last 4 digits only after consent capture
- Consent IP, user agent, and timestamp are required fields — null not permitted
- TCPA gate (V10) in A-05 is permanently non-overridable

---

## Contract 7: LLM COST CONTROL

- Advisory lock checks clients.llm_cost_today before every LLM API call
- If projected cost exceeds daily cap: pause generation, alert operator, log to agent_events
- Token count and cost logged to agent_events after every LLM call
- Daily cost reset to 0 by CRON-01 at midnight UTC
- No LLM call is made without this check — no exceptions

---

## Contract 8: MIDDLEWARE

- middleware.ts is auth passthrough only — no role logic ever
- Any change to middleware.ts requires full replacement — never patched
- Role fail on middleware = redirect to /login only — never default to any role page
- Hard refresh must land on correct role page

---

## Contract 9: VALIDATOR SUPREMACY

- Only A-05 may set pages.status = 'queued'
- No other agent, route, or script may set pages.status = 'queued'
- CRON-01 only publishes pages with status = 'queued' — WHERE clause permanent
- V9 (schema validation), V10 (TCPA), V13 (similarity) are permanently non-overridable
- All 15 gates run on every page — no short-circuit on early failure

---

## Contract 10: DEPLOY SEQUENCE

Every deployment follows this exact sequence. No step skipped. Ever.

```
1. pnpm tsc --noEmit          (type check — fix all errors before proceeding)
2. pnpm run build             (build — fix all errors before proceeding)
3. vercel --prod              (deploy to production)
4. Run test suite             (all tests must pass)
5. Run schema drift detector  (must pass)
6. Run tenant isolation suite (must pass)
7. Run deploy verification    (must pass)
8. git add .
9. git commit -m "descriptive message"
10. git push
```

Deployment is not complete until git push is confirmed and deploy verification passes.

---

## Contract 11: SESSION END REQUIREMENTS

Before ending any Claude Code session, the agent MUST:

1. Update STATE_OF_THE_BUILD.md with:
   - Phase currently active
   - Tasks completed this session
   - Current test status
   - Any open blockers
   - Exact next action for next session
2. Run the deploy sequence if any code changed
3. Confirm all changed files are committed and pushed

No session ends without STATE_OF_THE_BUILD.md updated. No exceptions. Ever.

---

## Contract 12: FEATURE FLAGS

- Feature activation is controlled exclusively by platform_config.enabled
- No agent checks phase numbers directly in code
- No agent builds code for a feature with enabled = false
- Activating a feature means: set enabled = true in platform_config, then build the agent
- Never write conditional code that checks "if phase >= 2" — check the flag

---

## Contract 13: GITHUB MILESTONES

At every major milestone:
- Push all changes to GitHub
- Confirm push succeeded
- Tag the release: git tag -a v1.0-phase1-complete -m "Phase 1 complete"
- Document tag in STATE_OF_THE_BUILD.md
- Do not proceed to next phase until tag is confirmed

---

## Contract 14: ONE-SHOT DIAGNOSIS

- Never deliver incremental patches
- Never say "try this and see what happens"
- Diagnose fully using real observed data — exact errors, exact API responses, exact DB state
- Deliver complete fix in first response
- If diagnosis requires information not yet available — ask for it before proposing any fix

---

## Contract 15: VELOCITY PROTECTION

- CRON-01 daily publish allowance = tier_base_rate Ã— random(0.8, 1.2)
- ±20% variance is mandatory — never publish exactly N pages
- Random time offset 0-3600 seconds applied to each publish within the 3am UTC window
- Cross-tenant isolation enforced — each client's allowance computed independently
- Paused or cancelled subscriptions skipped — no pages published for inactive clients

---

## Contract 16: COMPACTING SAFETY

Compacting is a context window event that destroys governance awareness if not handled correctly. This contract is non-negotiable.

Before any compact occurs, the following must be complete:

- STATE_OF_THE_BUILD.md updated with current in-progress state, including any partially completed tasks
- All changed files committed and pushed to GitHub — no uncommitted code when context compacts
- A "Last Compact Summary" paragraph written at the top of STATE_OF_THE_BUILD.md describing exactly where the session was interrupted

After any compact occurs:

- Re-read all governance documents completely before writing any code
- Report to the human that a compact occurred
- Confirm which governance documents were re-read
- Resume from the exact task documented in STATE_OF_THE_BUILD.md — never from conversation memory

Failure to follow this protocol means the build loses state and the next session starts blind. This is the single most common cause of session-to-session drift and fabricated outputs.

---

## Contract 17: API KEY INTEGRITY

- Never use a placeholder API key in production code
- Never assume an existing key from a prior project is valid — always verify
- All API keys stored in .env.local locally and added to Vercel via CLI only
- Never commit .env.local to GitHub — confirm .gitignore contains .env.local before first push
- If an API call fails with 401 or 403 — the first diagnosis is always key validity, not code
- Keys for Phase 2 and Phase 3 services are present in .env.local as empty strings — never filled until that phase begins

---

## Contract 18: LANDING PAGE AND MARKETING SITE

- The public marketing site is a separate concern from the operator dashboard
- It lives at the root domain: tarritrix.com
- The operator dashboard lives at: tarritrix.com/dashboard
- The landing page must be built and deployed before any agent development begins
- The landing page is complete when: hero section, features section, pricing section, demo request form with Google Calendar API integration, and footer are all live and functional
- The demo request form routes to the operator's Google Calendar via Google Calendar API
- No self-serve signup exists — the only CTA is "Schedule a Demo"
- The landing page is built mobile-first, loads in under 2 seconds, scores above 90 on Lighthouse

---

## Contract 19: LOGO AND BRAND IDENTITY

- A logo must be created before the landing page is built
- Logo is produced as SVG format — scalable, no raster artifacts
- Brand direction: precise, modern, authoritative — targeting roofing and home service business owners
- Color palette locked in MASTER_BUILD_SPEC.md Section 2 — no deviations
- Logo, color palette, and typography locked before any UI work begins
- No UI component is built before brand identity is established

---

## Contract 20: MID-BUILD CHANGE PROTOCOL

This contract enforces the four-step mid-build change protocol defined in AGENTS.md. It applies to every change request after initial build has started — no exceptions.

The four steps are mandatory and sequential:
1. Stop — no code touched until assessment is complete
2. Impact assessment — all four questions answered explicitly
3. Recommendation — one of three outcomes: BUILD NOW, DEFER, or REDESIGN REQUIRED
4. Execute — only after explicit human confirmation received

Schema changes always precede code changes. Documentation always precedes schema changes. This order is permanent and non-negotiable.

If the human explicitly says to skip this protocol: acknowledge the request, explain that the protocol cannot be skipped, complete the assessment anyway, then proceed after confirmation. The protocol protects the human's build from the human's own in-session impulses. That is its purpose.

---

## Contract 21: MCP SERVER INTEGRITY

All five MCP servers must be installed and verified connected before any application code is written. Installation order is sequential — verify each before installing the next:

1. Sequential Thinking
2. Playwright
3. Supabase
4. GitHub
5. Vercel

Verification command after each install: `claude mcp list`

If any MCP server shows as failed or not connected — diagnose and fix before installing the next one. Never proceed with a broken MCP server in the list.

The .mcp.json file must be added to .gitignore immediately after creation. MCP tokens are secrets and must never be committed to GitHub.

---

## Contract 22: AUTOMATED VERIFICATION GATE

Pre-commit hook MUST run `pnpm verify` on every commit. `pnpm verify` runs:
- tsc --noEmit
- vitest (full suite)
- playwright (critical path tests)
- schema drift detector
- tenant isolation suite

No commit succeeds without all five passing. `git commit --no-verify` is FORBIDDEN — bootstrap exception removed permanently. Any commit that fails verification must be fixed before retry, never bypassed.

---

## Contract 23: NO TIME ESTIMATES

Claude Code and the architect (Claude.ai) MUST NOT provide time estimates of any kind. This includes:
- "This will take approximately X minutes/hours/days"
- "Estimated build time"
- "Should be done in X"
- Any temporal prediction

Replace with: "Running now" or "Next step is Y." Measure in completed deliverables, not time.

---

## Contract 24: DEEP RESEARCH PROTOCOL

When any fix attempt fails or unexpected error occurs:
1. Stop. Do not retry the same approach.
2. Conduct multi-source research: official docs, GitHub issues, Stack Overflow, community forums
3. Identify the root cause, not the symptom
4. Deliver one complete definitive fix in the next response
5. Never use phrases like "try this and see" or "let's see if this works"

---

## Contract 25: ANTI-HALLUCINATION HEADER

Every Claude Code prompt MUST begin with this header:

> Before executing: verify all table references against SCHEMA_REGISTRY.md, all route references via grep src/app/, all column references against migration files. Do not invent. Do not assume. Do not claim completion without verification. If uncertain, stop and ask.

---

## Contract 26: ORIGINAL BLUEPRINT IS CANONICAL

The operator's original blueprint (preserved in BLUEPRINT.md and MASTER_BUILD_SPEC.md) is the canonical source of scope. No agent (Claude Code or Claude.ai) may omit, defer, simplify, or autonomously modify any item from this scope without explicit written operator permission and documented justification.

---

## Contract 27: TENANT ISOLATION VERIFICATION

Every commit must pass the tenant isolation Playwright suite. This suite verifies:
- Operator A cannot see Client B's data through any route
- Client X cannot see Client Y's data through any route
- Service role key is never used in client-facing code
- RLS policies are enforced on every multi-tenant table query

Failure of any tenant isolation test = build fails, commit blocked.

---

## Contract 28: NO REPETITIVE FAILURE LOOPS

If any specific error occurs more than twice in a session:
- Stop all work
- Document the exact error and what was attempted
- Conduct deep research per Contract 24
- Present alternative solutions to operator
- Never attempt the same fix a third time

---

## Contract 29: SCHEMA DRIFT DETECTION

A schema drift detector script runs on every commit. It compares:
- Live Supabase schema (queried via API)
- SCHEMA_REGISTRY.md declarations
- Migration files in supabase/migrations/

Any mismatch = commit blocked. Schema must be fixed via versioned migration before commit succeeds.

---

## Contract 30: PRODUCTION DEPLOY VERIFICATION

After every Vercel deploy, automated verification:
1. Hits production URL for each of 6 surfaces
2. Verifies expected content renders (specific text or element checks)
3. Verifies authentication flows succeed
4. Verifies tenant isolation in production
5. Reports pass/fail to operator

If any verification fails, the deploy is rolled back automatically and operator is alerted.

---

## Contract 31: Personalized Demo Engine Protection

The Personalized Demo Engine (4 tiers) is a named tracked feature documented in BLUEPRINT.md as a strategic sales conversion lever. It is NOT optional. Tier 1 ships in Phase 1 (Prompts 7-10). Tiers 2-4 are explicitly named in the roadmap with dependencies and entry conditions documented.

Any session that proposes deferring, descoping, removing, or eliminating any of the four tiers without explicit written operator approval is in violation of this contract. Build sessions encountering scope pressure must surface this contract before considering scope cuts to demo personalization features.

Specifically protected:
- Demo request form ZIP and primary_city fields MUST be required
- SignalGeography component MUST remain reusable for both marketing hero and operator demo prep tool
- Tier 4 (Social Lead Intelligence with Identity Reconciliation) is a future-build with significant infrastructure costs; it is NOT to be silently scoped down to "less ambitious" alternatives

Violation surface: any session that recommends "let's just skip the demo prep tool" or "let's not require ZIP/city fields" or "let's remove the Reveal Identity button from the marketing dashboard" without explicit operator acknowledgment of this contract.

---

## Contract 32: Prompt Completion Discipline

When mid-prompt, no new work begins until the current prompt is fully executed and the commit hash is reported. No pivots to other phases. No "alternative path" offers. No "which direction?" questions when the direction was already given. The prompt in flight is the only work in scope until its terminal step completes. If blocked at any step, stop and report the blocker — do not freelance to other tasks. Any deviation is a Contract 32 violation and is logged to STATE_OF_THE_BUILD.md.

---

## Contract 33: Credential Handling Discipline

Credentials (API keys, tokens, secrets, passwords) must never be passed to CLI commands via stdin echo, command-line flags, or any method that writes the value to terminal history or logs. Use interactive prompts only. If a tool requires non-interactive credential input, use environment variables loaded from .env.local at process start, never inline. Any credential that touches terminal history or session logs is considered exposed and must be rotated.

Public identifiers (org slugs, project names, region names, public DSNs that are explicitly designed to be embedded in client bundles) are not credentials and may use --value flags or echo pipes for convenience.

---

## Contract 34: Performance Feedback Loop Discipline

A-10 (Content Profile Builder) must never bias more than 70% toward historical winners when generating new content profiles. Minimum 30% must remain exploratory (new profile shapes, new evidence combinations, new geographic angles). Pure optimization toward proven winners would collapse content variety, which is itself a Google penalty risk. Variety is a moat ingredient, not a quality compromise.


---

## Contract 35: Vendor Dependency Management

Tarritrix tiers Growth, Authority, and Dominance include Xactimate insurance estimate
rewrites as a bundled benefit. These rewrites are delivered through a white-label vendor
partnership with Contractor Supplement Solutions. As of 2026-05-09, no fallback vendor exists.

This single-vendor dependency is a Tarritrix-side delivery risk that must be actively managed.

1. Single-vendor exposure must be documented at all times in BLUEPRINT.md Part 9 Section 9.4.
2. Fallback vendor onboarding required before Phase 2 commencement.
3. No client agreement may promise SLA stricter than current vendor commits to.
4. Vendor failure triggers tier-level service degradation protocol: pause new sales,
   notify clients within 24 hours, pro-rated refund for affected period.
5. Annual vendor health review required (financial stability, E&O insurance, licensing).
6. Vendor data handling in scope for Tarritrix DSAR responsibilities.

Violation surface: any session that recommends scaling Growth/Authority/Dominance sales
without verifying current vendor capacity, or proposes Dominance tier active checkout
before Phase 3 vendor SLA confirmation, is in violation of Contract 35.

---

## Contract 36: Demo Seed Hygiene

**Effective:** 2026-05-14
**Status:** Active

### Purpose
Demo seed data exists to populate dashboards for demos and development. It must NOT contaminate production systems.

### Identification
Any row marked `is_demo_seed = true` (on `clients` table) or descended from a tenant flagged as demo seed is considered DEMO DATA.

The canonical demo tenant UUID is `e4ee4ee4-0000-0000-0000-000000000001` (E4 Construction & Roofing). Additional demo tenants get UUIDs in the `e4ee4ee4-*` range for grep-ability.

### Exclusion zones — DEMO DATA MUST NEVER FLOW TO:
- Stripe customer creation or billing operations
- Production reporting / executive dashboards reported to operators or investors
- Real outbound email / SMS / call queues (no real domain sends, no real phone outreach)
- Google Business Profile API calls (would attempt to modify GBP entries that don't belong to us)
- Google Search Console submissions
- Real GSC indexation API calls
- Internal link graph publishing to production sitemap
- Real CRM sync (Salesforce, HubSpot, JobNimbus, etc.)
- Any third-party webhook publishing

### Enforcement
- All API endpoints serving production output (sitemaps, GBP sync, billing reports, email queues) MUST filter `WHERE is_demo_seed = FALSE` or join through a `client_id` whose tenant is non-demo
- Add `governance-lint` rule to fail builds where outbound-action code paths reference `clients` without the demo filter
- Demo seed records are visible in dev/staging dashboards but operators must understand they're demo and not act on them as real

### Lifecycle
- Demo seed records get ARCHIVED (not deleted) when the represented entity onboards as a real client
- Archive procedure: set `is_demo_seed = FALSE` AND `tenant_uuid` reassigned to the real onboarded UUID is FORBIDDEN. Instead: insert fresh real records via A-01 wizard, then `DELETE FROM ... WHERE is_demo_seed = TRUE AND business_name = '[name]'` after verification real records work
- This prevents "demo data accidentally becomes production data" failure mode

### Onboarding link
When real onboarding (A-01) ships, the wizard MUST refuse to register a tenant whose `business_name` already exists with `is_demo_seed = TRUE`. Operator must explicitly archive the demo first.

---

## Contract 37: No Commit Without State Update

**Effective:** 2026-05-14
**Status:** Active

### Purpose
Enforce session-to-session continuity and prevent governance drift across compaction events.

### The Rule
Every prompt sent to Claude Code that results in commits MUST include an explicit step to update STATE_OF_THE_BUILD.md before the final commit. No exceptions.

### What Must Be Logged
- Session date (YYYY-MM-DD format)
- Commits shipped (abbreviated hash + one-line description)
- Work completed this session (features shipped, fixes landed, decisions made)
- Open blockers or issues discovered
- Next session starting point (exact next action)
- Timeline updates (if investor demo date changes, external dependencies shift, etc.)

### Enforcement
- This contract is a STANDING RULE visible at session start (/clear message)
- Any prompt that omits the STATE_OF_THE_BUILD update step is incomplete
- Any commit that lands without corresponding STATE_OF_THE_BUILD entry violates this contract
- Violation = session ends, STATE_OF_THE_BUILD.md corrected before next commit allowed

### Why This Exists
Compaction events destroy conversational context. Without written state, the next session starts blind. This contract ensures STATE_OF_THE_BUILD.md is the canonical record of build progression — not conversation memory.

### Link to Contract 16 (Compacting Safety)
Contract 16 governs behavior DURING compaction. Contract 37 governs behavior BEFORE commits. Together they form the continuity enforcement layer.

---

## Contract 38: REAL-DATA BINDING

**Effective:** 2026-05-17
**Status:** Active

Programmatically generated pages (city pages, service pages, storm pages) must contain only factually verifiable data extracted from authoritative sources. No fabricated data, no hypothetical scenarios, no "example" or "sample" content visible to end users.

Authoritative sources:
- Client-provided business data (name, address, phone, services, service area)
- Client-uploaded evidence (photos, case studies, certifications, testimonials)
- NOAA/Mesonet/NWS storm data (via Storm Intelligence Engine)
- U.S. Census Bureau data (city populations, demographics)
- Google Business Profile data (hours, photos, reviews — when GBP API approved)

Prohibited on production pages:
- Fabricated customer names, project addresses, or testimonials
- Invented storm events, hail sizes, or damage estimates
- Hypothetical service scenarios not tied to verified completed jobs
- "Example project" copy not backed by job_evidence records
- Placeholder city names, ZIP codes, or geographic references

Failure mode this closes: SEO penalties for thin/fabricated content, FTC violations for deceptive advertising, client liability for false claims.

Violation: any page generation prompt or A-02 output containing fabricated data visible to end users is a Contract 38 violation.

---

## Contract 39: STORM AUTHENTICITY

**Effective:** 2026-05-17
**Status:** Active

Storm Intelligence Engine references must be factually accurate and traceable to NOAA, NWS, or Mesonet data sources. No fabricated storm events, exaggerated severity, or fake hail reports.

Requirements:
1. Every storm event referenced on a page must exist in `storm_events` table with authoritative source attribution
2. Hail size, wind speed, tornado track data must match NOAA Storm Events Database
3. Storm dates must be accurate (not rounded, not estimated, not "approximately")
4. Geographic references (affected cities, counties, ZIP codes) must match NOAA event polygons
5. No severity inflation (e.g., calling a 1" hail event "catastrophic")

Prohibited:
- References to storms that did not occur
- Severity descriptors stronger than NOAA classification (e.g., "devastating" for a Severe Thunderstorm Warning)
- Storm imagery not sourced from NOAA radar archives or verified contractor photos
- Fake before/after damage photos for storm events

Storm Intelligence Engine operations that violate this contract:
- A-01 Storm Capture ingesting non-NOAA sources without verification
- A-02 Page Generator inventing storm references not in `storm_events` table
- A-15 GBP Post Generator exaggerating storm severity for engagement

Failure mode this closes: FTC penalties for false advertising, client liability for fabricated storm claims, loss of platform credibility.

Violation: any storm reference not traceable to `storm_events` table with NOAA source attribution is a Contract 39 violation.

---

## Contract 40: RESERVED

**Status:** Placeholder for future governance addition

---

## Contract 41: LLM COST GOVERNANCE

**Effective:** 2026-05-17
**Status:** Active (supersedes Contract 7)

B2 LLM Router is mandatory for all LLM calls. Direct provider SDK usage (Anthropic, OpenAI, Google) without routing through `src/lib/llm/router.ts` is forbidden.

Cost enforcement via B2 LLM Router:
1. **Pre-call cost check:** `check_llm_cost_with_lock()` stored procedure with `pg_advisory_xact_lock` ensures race-free cap enforcement
2. **Per-client cap:** Default $5.00/day per client (configurable via `clients.llm_daily_cost_cap`)
3. **Platform-wide cap:** Default $500.00/day across all clients (configurable via `platform_config.llm_daily_cost_cap_total`)
4. **Per-provider cap:** Anthropic $400/day, OpenAI $200/day, Google $100/day (configurable via `platform_config.llm_provider_daily_caps`)
5. **Automatic fallback:** If primary provider exceeds cap or circuit breaker opens, router fails over to fallback provider per `llm_routing_config` rules

All LLM calls must:
- Route through `callLLM()` in `src/lib/llm/router.ts`
- Include `client_id`, `task_type`, `agent_event_id` for cost attribution
- Log to `llm_calls` table with provider, model, cost, tokens, latency
- Respect circuit breaker state (5 failures → 60s cooldown)

**Attribution Enforcement (Contract 47 - 2026-05-21):**
- Schema-level enforcement: `llm_calls.agent_event_id` has NOT NULL constraint (migration 20260521150000)
- All library-level LLM call sites (`cost-guard.ts`, `embeddings.ts`) require `agent_event_id` as non-nullable parameter
- Historical data preserved: 439 pre-attribution rows (2026-05-15 through 2026-05-16) backfilled with sentinel agent_event `00000000-0000-0000-0000-000000000002`
- Sentinel represents "pre-attribution era unknown context" before enforcement was complete
- From 2026-05-21 forward: all `llm_calls` inserts must provide valid `agent_event_id` or database rejects

Cost cap behavior:
- If projected cost exceeds cap: call rejected before execution, error code `COST_CAP_EXCEEDED`
- Agent must halt work, log to `agent_events` with status `failed`, surface to operator via `tenant_signals`
- Operator may increase cap or defer work — no automatic cap increase

Health monitoring:
- Active health checks every 5 minutes via `/api/cron/llm-health-check` (vercel.json CRON)
- Passive health tracking on every call (failure rate, latency)
- Circuit breaker per provider (closed → open → half_open state machine)

Failure mode this closes: Runaway LLM costs, single-provider outages blocking all work, unattributed costs in multi-client environment.

Violation: any LLM call bypassing B2 LLM Router is a Contract 41 violation. Operator may revert without challenge.

---

## Contract 42: RESERVED

**Status:** Placeholder for future governance addition

---

## Contract 43: RESERVED

**Status:** Placeholder for future governance addition

---

## Contract 44: RESERVED

**Status:** Placeholder for future governance addition

---

## Contract 45: Review Authenticity (HARD)

A-14 Review Request Workflow must comply with Google Review Policies, Facebook Review Guidelines, BBB submission rules, FTC Endorsement Guides (16 CFR Part 255), and Yelp's review solicitation prohibition. The following are absolute prohibitions:

1. No pre-written review text presented to customers for one-click approval. Reviews must be authored by the customer in the customer's own words. Tarritrix may provide guiding questions and structural prompts only.

2. No incentives offered in exchange for reviews. No discounts, gift cards, service upgrades, or preferential treatment tied to leaving a review.

3. No Yelp solicitation. A-14 may not direct customers to Yelp via any channel. Yelp reviews must originate from customer-initiated activity outside the Tarritrix platform.

4. No fabricated jobs or customer identities. Every review request must trace to a verified completed job (extracted_evidence) and a verified customer identity (job_evidence_contacts).

5. No review filtering by sentiment before invitation. All customers from approved completed jobs receive identical review request flows. Cherry-picking only happy customers for review requests violates FTC guidelines on review platform integrity.

Override forbidden. Violations expose Tarritrix and clients to platform bans, FTC enforcement, and civil liability.
---

## Contract 46: VERIFICATION MANDATE (HIGHEST PRIORITY, NON-NEGOTIABLE)

**Effective:** 2026-05-15
**Severity:** ABSOLUTE — supersedes all other contracts when in conflict
**Origin:** Operator directive 2026-05-15 following architectural audit

This is the singularly most important rule in the Tarritrix governance system. No session, no agent, no operator action, no automation, no urgency, and no scope pressure overrides this contract.

#### The Rule

NEVER infer, guess, improvise, fabricate, or assume any fact, specification, file content, table existence, route existence, function signature, agent capability, schema column, contract clause, or architectural decision without direct verification against canonical files.

#### Definition of Canonical Files

The canonical files are the single source of truth for Tarritrix architecture:
- BLUEPRINT.md
- MASTER_BUILD_SPEC.md
- SCHEMA_REGISTRY.md
- BEHAVIORAL_CONTRACTS.md
- AGENTS.md
- STATE_OF_THE_BUILD.md
- PROMPT_EXECUTION_SEQUENCE.md
- Live Supabase schema (via Supabase MCP query)
- Live git repository state (via git log, git show, file system access)

Chat memory, conversation history, operator memory, derived assumptions, prior session decisions not present in canonical files, and external documentation summaries are NOT canonical. They are reference material only.

#### Required Verification Actions

Before any claim about Tarritrix state or any action affecting Tarritrix code, schema, or governance:

1. Read the relevant canonical file directly via the file system or project knowledge tool
2. Quote the exact text supporting the claim with file name and line number when available
3. If the canonical file does not contain the claim or contradicts the claim, state that explicitly
4. If the canonical file is silent, state "canonical file is silent on this question" — do not infer

#### Prohibited Behaviors

- Claiming a feature is built without git verification
- Claiming a table exists without SCHEMA_REGISTRY.md or live Supabase verification
- Claiming a route exists without file system grep verification
- Claiming a contract exists without BEHAVIORAL_CONTRACTS.md verification
- Claiming a prior decision is documented without canonical file quote
- Producing audits, reports, or recovery plans based on chat memory without canonical file verification
- Inferring missing architecture from approved chat decisions without verifying current canonical state
- Generating prompts or code that references entities not verified to exist
- Filling gaps with plausible-sounding specifications when canonical files are silent

#### Required Response When Uncertain

When verification is incomplete or impossible:

1. STOP immediately
2. State exactly what cannot be verified
3. State what verification action is needed
4. Ask operator to provide access or direction
5. Do not proceed until verified

#### Violation Consequences

Any violation of Contract 46 invalidates all work product in that session. Affected commits must be reviewed for fabricated content. Operator may revoke session work and demand re-execution after verification.

This contract is permanent. It cannot be relaxed for time pressure, scope urgency, or operator request for speed. The operator has standing direction: speed is never an excuse for unverified claims.

---

## Contract 47: CANONICAL FILE PRECEDENCE

**Effective:** 2026-05-15
**Status:** Active

When canonical files contradict each other (drip rates, agent phase placement, tier capacities, schema details), the following precedence rules resolve:

1. Most recent section within a single file takes precedence over older sections
2. Files with explicit version numbers (e.g., SCHEMA_REGISTRY.md v3.0) take precedence over unversioned references
3. Operator-confirmed decisions logged in STATE_OF_THE_BUILD.md SESSION LOG entries take precedence over older canonical text
4. When precedence is ambiguous, session must stop and surface the contradiction to operator before proceeding

Contradictions must be resolved by removing the older or rejected version entirely from canonical files, not by leaving both in place. Leaving contradictions creates future drift.

---

## Contract 48: NO PARTIAL COMPLETION CLAIMS

**Effective:** 2026-05-15
**Status:** Active

Sessions must not claim partial completion as completion. The acceptable states are:

- COMPLETE: all acceptance criteria pass, all tests pass, no skipped steps, governance updated
- INCOMPLETE WITH EXPLICIT BLOCKER: specific blocker named, what is incomplete enumerated
- NOT STARTED

Phrases prohibited from session reports:
- "mostly complete"
- "complete except for X"
- "tests passing, X mock issues to address in follow-up"
- "shipped with minor cleanup remaining"
- "feature complete, awaiting polish"

If a feature is not 100% complete by its acceptance criteria, the session report must state INCOMPLETE and name the blocker. Burying failures inside completion language is a Contract 48 violation.

---

## Contract 49: STATE OF THE BUILD AS SINGLE SOURCE OF TRUTH

**Effective:** 2026-05-15
**Status:** Active

STATE_OF_THE_BUILD.md is the authoritative current build state document. Every session must:

1. Read STATE_OF_THE_BUILD.md at session start
2. Update STATE_OF_THE_BUILD.md before any commit (per Contract 37)
3. Verify STATE_OF_THE_BUILD.md aligns with git log and live Supabase before any work begins
4. Stop and reconcile if STATE_OF_THE_BUILD.md contradicts git or Supabase reality

Any claim about current build state must reference STATE_OF_THE_BUILD.md. Claims that contradict STATE_OF_THE_BUILD.md without explicit reconciliation are Contract 49 violations.

---

## Contract 50: ARCHITECTURAL DECISION DURABILITY

**Effective:** 2026-05-15
**Status:** Active

Every architectural decision approved in operator-Claude chat must be committed to the appropriate canonical file (BLUEPRINT.md, SCHEMA_REGISTRY.md, BEHAVIORAL_CONTRACTS.md, AGENTS.md) within the same session in which it was approved.

No decision is considered ratified until it appears in a committed canonical file. Chat memory and operator memory are not substitutes for canonical file commits.

Sessions that approve architectural decisions and proceed to other work without the commit are in violation of this contract. The expectation:

1. Decision made in chat
2. Canonical file updated and committed BEFORE moving to next topic
3. Operator verifies commit hash
4. Session continues

Bridge documents (PENDING_*.md transient files) are not acceptable substitutes. They get deleted, lost, or forgotten. Canonical files persist.

This contract directly prevents the failure pattern that killed prior Tarritrix build attempts: architectural decisions evaporating between sessions because they were never durably documented.

---

## Contract 51: VERBATIM REPORTING STANDARD

**Effective:** 2026-05-16
**Status:** Active

When Claude Code executes verification, inventory, diff, query, or grep tasks, output is reported VERBATIM. Not summarized. Not interpreted. Not paraphrased.

This applies to:
- Database query results (full row inventory, not row counts or "N rows returned")
- File grep/search results (each match with file path and line number, not "N matches found")
- git status / git diff / git log output (raw stdout, not narrated summaries)
- Migration application results (the actual psql or Supabase MCP response, not "migration succeeded")
- File listing results (verbatim ls output, not "N files found")

Claude Code may add a single one-line summary AFTER the verbatim output, never instead of it.

Rationale: Summarization hides drift. The Migration 003 typo (tier_entitlements → tenant_entitlements) and the Serper.dev line 272 drift both went undetected for multiple sessions because CC reported "complete" or "no action needed" without reporting actual inspection results. Verbatim output makes drift detectable in one pass instead of requiring re-verification rounds.

Trade-off: Operator accepts verbose verification output in exchange for elimination of re-verification cycles. One verbatim pass = trustable. Operator stops demanding re-runs when this contract is followed.

Violations: Any CC response that says "X complete" or "no action needed" or "N items processed" without the underlying verbatim output is a Contract 51 violation. Operator may halt and demand re-run with verbatim output.

---

## Contract 52: GOVERNANCE-UPDATE ATOMICITY

**Effective:** 2026-05-16
**Status:** Active

Every work commit that changes schema, agents, surfaces, vendor decisions, or any other canonical truth MUST include the matching governance file update in the same commit. No deferred governance updates. No "I'll update STATE_OF_THE_BUILD.md in the next commit."

If a commit changes:
- **Database schema** (migration files, RLS policies, new tables, new columns) → SCHEMA_REGISTRY.md updated in same commit
- **An agent's behavior, scope, or spec** → AGENTS.md updated in same commit
- **A surface, route, or UI component** that changes the documented architecture → BLUEPRINT.md and/or MASTER_BUILD_SPEC.md updated in same commit
- **A vendor decision, third-party API, or external dependency** → BLUEPRINT.md updated in same commit
- **Current build state, completed work, or open blockers** → STATE_OF_THE_BUILD.md updated in same commit
- **A behavioral or governance rule** → BEHAVIORAL_CONTRACTS.md updated in same commit

Rationale: The Migration 003 typo and the Serper.dev line 272 drift both occurred because work commits shipped without paired governance updates. The governance files then contradicted the live state, and the contradictions propagated as canonical truth in subsequent sessions.

Implementation: When CC produces a commit message, the commit must list both the work files AND the governance files in the change set. If only work files appear, the commit is incomplete and must not be pushed.

Exceptions: Pure refactors (no behavioral or architectural change), test-only commits, and bug fixes that do not alter documented behavior are exempt. When in doubt, update the governance file.

Violations: Any commit that ships work without paired governance updates may be reverted by the operator without challenge.

---

## Contract 53: MANDATORY PLAYWRIGHT VERIFICATION FOR UI COMMITS

**Effective:** 2026-05-17
**Status:** Active

Any commit that modifies a Next.js page, route, or React component visible to end users MUST include a Playwright test that runs against the deployed production URL and verifies:

1. Zero uncaught page errors (page.on('pageerror'))
2. Zero critical console errors (page.on('console') type === 'error', filtered for known-allowed noise like preload warnings and deprecation notices)
3. Required DOM elements are present and visible (e.g., for a map route, gm-style or aria-label="Map" must render; for a KPI strip, all card elements must render)

A screenshot alone is NOT sufficient verification. A screenshot of an error page satisfies "screenshot captured" but fails the actual rendering gate.

Rationale: The Google Maps Hybrid deployment on 2026-05-17 shipped a "production smoke test passed" claim against a page crashing with "Uncaught ReferenceError: google is not defined" because no Playwright gate verified the actual render. The screenshot showed the error state, not a working map. Contract 53 closes this gap.

Implementation pattern (mandatory for UI commits):

```typescript
import { test, expect } from '@playwright/test';
test('route renders cleanly', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  // login + navigation
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(N); // for async-loaded SDKs
  expect(pageErrors).toHaveLength(0);
  expect(consoleErrors.filter(isCritical)).toHaveLength(0);
  await expect(criticalDomElement).toBeVisible();
});
```

Allowed-noise filter maintained per project (deprecation warnings, third-party noise, preload hints, known third-party 404s).

Violations: Any UI commit shipped without a passing Playwright test for the changed route is a Contract 53 violation. Operator may revert without challenge.

---

## Contract 54: SCHEMA-VERIFIED CODE GENERATION

**Effective:** 2026-05-17
**Status:** Active

Before any API route, migration, agent, or component is written that references a database table, the verbatim `information_schema.columns` output for that table must be in Claude's working context. No column name may be inferred, remembered, or assumed.

Claude must paste the schema dump into the working context before writing the first line of code that references the table. CC must report the schema dump verbatim when verifying. The chat instance writing the code (Claude in the chat session) must have the verbatim schema in its visible context.

Failure mode this closes: API code shipped with column names like `indexed_status`, `zip`, `lead_value_estimate`, `city`, `neighborhood` that did not exist in the live schema, causing silent zero-result queries and broken UI.

Violation: any prompt that writes SQL or API code referencing a table without the verbatim schema in context is a Contract 54 violation. Operator may revert the resulting commit without challenge.

---

## Contract 55: DATA DEPENDENCY ENUMERATION

**Effective:** 2026-05-17
**Status:** Active

Before any DELETE, UPDATE, or schema change that touches seeded demo data, the prompt must explicitly enumerate every downstream table affected by FK cascades, triggers, or RLS chains, and explicitly state the post-operation re-seed plan.

Format required:

```
Downstream cascade chain:
- table_A (FK: column_name) → expected N rows deleted
- table_B (FK: column_name) → expected M rows deleted
- table_C (FK: column_name) → expected P rows deleted

Expected state post-operation:
- table_A: X rows remaining
- table_B: Y rows remaining

Re-seed plan: [migration file path or "no re-seed required"]
```

Example violation: `DELETE FROM pages WHERE client_id = '...'` without stating "this will cascade to page_performance_daily (~4,500 rows), conversions (~90 rows), indexation_records (~150 rows); re-seed via migration-007-demo-seed.sql."

Failure mode this closes: 2026-05-16 E4 territory reseed cascade-deleted pages, page_performance_daily, conversions, indexation_records without paired re-seed. Detected three prompts later when step 4 build hit empty tables.

Violation: any prompt issuing destructive SQL without the enumeration block is a Contract 55 violation. CC must refuse to execute and halt.

---

## Contract 56: CANONICAL DEMO SEED ARTIFACT

**Effective:** 2026-05-17
**Status:** Active

Demo data state is a first-class artifact. Each demo tenant has exactly one seed file:
- E4 Construction: `supabase/seed/e4_demo.sql`
- Tarritrix: `supabase/seed/tarritrix_demo.sql` (when seeded)

Each file is idempotent (re-runnable without duplicating data), self-contained (no dependencies on other seed files), and versioned in git.

After any Contract 55 destructive operation against demo data, the corresponding seed file must be re-run. No inline INSERT statements in prompts for demo reseeding.

If the seed file produces data that doesn't match live database expectations, the seed file is authoritative — re-run it against live to reconcile.

Failure mode this closes: 2026-05-16 reseeds were inline SQL in prompts, different in each occurrence, with no single source of truth. Cross-session inconsistency became guaranteed.

Violation: any prompt that performs inline demo reseed instead of invoking the canonical seed file is a Contract 56 violation.

---

## Contract 57: ONE WORK PRODUCT PER PROMPT

**Effective:** 2026-05-17
**Status:** Active

A prompt produces exactly one work product. Examples:
- One API route + its test + its governance update (one work product)
- One canonical doc commit (one work product)
- One migration + verification + governance update (one work product)
- One forensic audit report (one work product)

Examples that violate:
- "Build the API + the component + run the test + update three governance files + commit + deploy + verify in production" — 7 work products
- "Fix the bug AND add the contract AND update the schema" — 3 work products

Failure mode this closes: 2026-05-16/17 bundled prompts of 200+ lines covering 10+ tasks. When CC hit mid-flight API errors or partial failures, rollback state was unclear. Hours of recovery per interrupted bundle.

Violation: any prompt with more than one operator-level acceptance criterion is a Contract 57 violation. CC refuses to execute and asks operator to split.

---

## Contract 58: DEPLOYMENT TRUTH VERIFICATION

**Effective:** 2026-05-17
**Status:** Active

A commit is not "shipped" or "deployed" until all three of the following are verified verbatim:

1. `git push` returned success (origin master updated)
2. `vercel ls --prod` shows deployment for that exact commit SHA in Ready state
3. For UI commits, Contract 53 Playwright gate passes against the deployed production URL (not local, not preview)

CC summary statements like "shipped," "deployed," "complete," "live" without all three verifications visibly reported in the response are a Contract 58 violation. The three verifications must be reported verbatim, not summarized.

Failure mode this closes: 2026-05-16 Google Maps migration was reported as "shipped, committed, deployed, live" but the commit was unpushed and production was serving stale Leaflet code. Multiple subsequent prompts built on the false assumption that production was on the new code.

Violation: any CC summary claiming deployment without the three-point verbatim verification is a Contract 58 violation. Operator may demand re-verification before any further work proceeds.

---

## Contract 61: AEO/Voice/Conversion Discipline

**Declared:** 2026-05-17
**Scope:** All page-generating agents (A-02, A-25, A-26, A-27, A-46) and refresh-related agents (A-11, A-34).

**Purpose:** Ensure every generated page is structured for citability by LLMs, readable by voice assistants, and converts traffic to leads.

**Rules:**

1. Every page must contain atomic citable facts with explicit data attribution (date, source, specific measurement). LLMs cite atomic facts, not narrative prose.
2. Q&A formatted content on every page using real query patterns from People-Also-Ask data. Minimum 3 Q&A pairs per page beyond A-03 schema requirement.
3. Speakable schema mandatory on all Q&A content for voice-assistant readability.
4. Voice-search direct-answer paragraphs (40-50 words) for every primary keyword target per page.
5. Entity-explicit references mandatory (e.g., not "the storm" but "the May 12, 2024 EF-2 tornado near Round Rock, Texas"). Entities normalized via A-26 consistency rules.
6. Conversion form mandatory on every page within first viewport on mobile.
7. Per-page deterministic seeded variant selection for conversion form (position, fields, copy, CTA) prevents form-template footprint.
8. TCPA-compliant consent text on every conversion form, immutable per ADR-12.
9. Form must contain at minimum: email field (required), submit button (required). Optional fields per variant: phone, zip, service-need, business name.
10. Email-only submission path must always be available — no variant requires multiple fields before allowing submission.

**Enforcement:** A-25/A-26/A-27/A-46 implement rules. A-36 (Refresh Validator) gates publish on Contract 61 compliance. Violations block publish until resolved.

**Override:** Critical rules (1, 3, 6, 8, 10) cannot be overridden. Other rules can be operator-overridden with logged justification.

## Contract 59: Refresh Cadence Discipline

**Declared:** 2026-05-17
**Scope:** A-11 Content Refresh Engine, A-33 Schema Markup Scrambler, A-37 Publish Cadence Jitter Engine, A-38 HTTP Fingerprint Diffusion Engine, A-42 Penalty Pattern Detection Engine, and all future refresh-triggering agents.

**Purpose:** Prevent footprint detection by Google's "site quality at scale" classifier through signal-driven, jittered refresh cadence rather than fixed cron schedules.

**Rules:**

1. No fixed-interval cron may drive page refreshes across multiple pages of the same client domain. CRON-driven scans (A-33 daily relevance scan, A-11 monthly performance refresh) are scheduling triggers only, not refresh executors.
2. All page refreshes are signal-driven. Signals: A-32 storm event ingestion, A-33 ranking decay detection, A-33 keyword gap detection, A-33 stale content detection, A-18 new job evidence upload.
3. Within signal-driven windows, jitter actual refresh fire time at minute granularity using per-page deterministic seed offset and per-tenant deterministic seed offset.
4. Concurrent refresh cap per tenant prevents thundering-herd patterns. Tier caps: Starter 1 concurrent, Growth 2 concurrent, Authority 3 concurrent, Dominance 5 concurrent.
5. Refresh frequency caps per tier prevent abuse. Daily caps: Starter ≤5 refreshes, Growth ≤15 refreshes, Authority ≤30 refreshes, Dominance ≤60 refreshes.
6. Storm-event-triggered refreshes: window 30-90 minutes from event detection. Ranking-decay-triggered refreshes: window 24-48 hours. Stale-content refreshes: window 7-14 days. Window selection per signal severity.
7. Refresh distribution across the window must follow Poisson distribution driven by signal-pressure, NOT uniform random distribution driven by clock ticks.
8. Per-tenant seed prevents two different clients in same metro from firing identical refresh times.
9. A-42 (Penalty Pattern Detection) freeze action OVERRIDES all refresh signals. When freeze active, no refresh fires for affected tenant regardless of signal pressure.

**Enforcement:** A-37 (Publish Cadence Jitter Engine) implements signal-driven scheduling. A-33 (Page Relevance Scanner / Schema Markup Scrambler) feeds priority queue. Both must respect cap tables. A-42 freeze takes precedence.

**Override:** No override permitted. Cap exceeded → refresh queued for next-day window.

## Contract 60: Backlink Operations Strict Whitelist

**Declared:** 2026-05-17
**Scope:** A-45 Backlink Intelligence Engine, A-40 External Signal Coordination Engine, and any future backlink-touching agents.

**Purpose:** Permanently prohibit black-hat backlink behaviors that risk client domain de-indexing. Google's algorithm has gotten extremely effective at detecting manufactured backlinks. The penalty when caught is total: domain de-indexed, no recovery path.

**Permitted operations:**

1. Read public backlink data via legitimate APIs (Ahrefs, SEMrush, Majestic)
2. Read public Google Search Console data with client OAuth permission
3. Surface findings to operator and client dashboards
4. Generate draft outreach templates for client review and client-initiated outreach
5. Recommend disavow-file updates that the client manually submits to Google
6. Identify legitimate industry directories the client should manually register with

**Strictly prohibited (zero tolerance):**

1. Creating accounts on third-party sites on behalf of client
2. Submitting client to directories without explicit per-directory client authorization
3. Sending outreach emails on the client's behalf
4. Generating content for placement on other domains
5. Participating in any link exchange, reciprocal linking, or PBN
6. Paying for links in any form
7. Manufacturing any web property whose purpose is to link back to the client
8. Comment spam, article spinning with embedded links, forum signature manipulation

**Enforcement:** A-45 (Backlink Intelligence Engine) is read-only and advisory by default. A-40 (External Signal Coordination) restricted to opportunity-surfacing. Any operation outside the permitted list constitutes a Contract 60 violation. Hard-coded in agent boundaries; cannot be overridden by operator or client.

**Override:** No override permitted. Ever.

## Contract 62: Production Build Verification Gate

**Established:** 2026-05-20

**Rule:** Every commit modifying src/ must pass `pnpm build` locally before push. `pnpm build` runs Next.js production compile which catches errors that `pnpm tsc --noEmit` and `pnpm vitest run` do not (ESLint rule violations, Next.js page export shape, dynamic route issues, server/client boundary violations, image-optimization warnings escalated to errors).

**Enforcement:** `pnpm build` added to `pnpm verify:ci` script. Operator runs `pnpm verify:ci` before every commit per existing workflow.

**Incident driving this contract:** Commit 1123e0d (A-05 ship 2026-05-20) passed all prior verification gates (tsc, vitest, contracts, schema, governance-lint) but failed Vercel production build with ESLint `no-console` violation in src/app/api/agents/a-05/trigger/route.ts:95. Four subsequent commits (5218d82, a68185d, 50bab21, 1df71b1) inherited the broken build undetected. Production deployment of A-05, A-05 fixes, dma_code migration, page_sitemaps migration, and A-07 entire ship all blocked for ~3 hours despite appearing committed and pushed.

**Scope:** All commits touching src/. Migrations-only and docs-only commits exempt.

---

## Contract 63: Verification Gate Layering

**Established:** 2026-05-20

**Rule:** Three-layer verification enforcement prevents untested code from reaching production. Each layer has distinct scope and timing:

**Layer 1: Pre-commit Hook (Fast Gates)**
- **Trigger:** Every `git commit` attempt
- **Scope:** `pnpm verify:fast` = tsc + vitest + verify-env + governance-lint + verify-contracts
- **Duration:** <60 seconds
- **Purpose:** Catch type errors, test failures, and governance violations before they enter git history
- **Enforcement:** `.husky/pre-commit` hook

**Layer 2: Pre-push Verification (Full Local Gates)**
- **Trigger:** Manual operator execution before `git push`
- **Scope:** `pnpm verify:ci` = Layer 1 + verify-schema + pnpm build + playwright test
- **Duration:** 2-5 minutes (includes E2E tests)
- **Purpose:** Catch production build failures, schema drift, and E2E regressions before push
- **Enforcement:** Operator discipline (not automated in git hook due to duration)

**Layer 3: CI Verification (Remote Gates)**
- **Trigger:** Every push to master, every pull request
- **Scope:** `pnpm verify:ci` in clean Ubuntu environment with Playwright browsers installed
- **Duration:** 3-8 minutes (cold start, dependency install, full suite)
- **Purpose:** Verify build passes in production-like environment, catch platform-specific issues
- **Enforcement:** `.github/workflows/ci.yml` (GitHub Actions)

**Why Not Run Layer 2 in Pre-commit Hook:**
- Pre-commit hooks that take >60s train developers to bypass them with `--no-verify`
- Playwright requires browsers installed (240MB+ Chromium download)
- E2E tests against local dev server add setup complexity to hook
- Layer 1 catches 95% of issues in <60s, Layer 2 is the final gate before push

**Test Database Isolation (Phase 1 Approach):**
- Playwright tests run against same Supabase instance as dev
- Test fixtures use prefixed identifiers (`test_Client_<timestamp>`)
- Cleanup in `afterAll()` blocks (best-effort, not guaranteed)
- Dedicated test database deferred to Phase 1.5 per Contract 62 incident analysis

**Canonical Test Fixture Factory:**
- All Playwright tests MUST use helpers from `tests/fixtures/test-helpers.ts`
- Inline `supabase.from('pages').insert()` is PROHIBITED
- Factory ensures all required NOT NULL fields are present
- Prevents schema evolution from breaking tests

**Incident driving this contract:** Contract 62 added `pnpm build` to verification gates after 4 commits shipped with broken production builds. Contract 63 extends this to include Playwright E2E verification and formalizes the three-layer enforcement model to prevent Playwright drift (tests passing locally but failing in CI, or tests not running at all before push).

**Scope:** All commits. No exceptions.

---

## Contract 64: Service Role Grant Enforcement

**Established:** 2026-05-20

**Rule:** Every CREATE TABLE migration MUST be accompanied by an explicit GRANT SELECT, INSERT, UPDATE ON the new table TO service_role unless the table is read-only reference data with explicit justification.

**Rule:** Every DROP TABLE / CREATE TABLE pattern (table recreation) MUST re-establish grants. Migration 005 violated this when it dropped llm_calls and recreated without re-granting, causing 7+ tables to lose service_role access and surfacing as silent failures over the following 6 days.

**Enforcement:** Schema verification script (scripts/verify-schema.ts or equivalent) extended to check that every table in public schema with code-path writes has appropriate service_role grants. Audit query becomes part of routine schema verification:

```sql
SELECT t.table_name, 
       COALESCE(string_agg(DISTINCT g.privilege_type, ', '), 'NONE') AS grants
FROM information_schema.tables t
LEFT JOIN information_schema.role_table_grants g
  ON g.table_name = t.table_name AND g.grantee = 'service_role'
WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
GROUP BY t.table_name
HAVING COALESCE(string_agg(DISTINCT g.privilege_type, ', '), 'NONE') = 'NONE';
```

**Incident driving this contract:** 2026-05-20 discovered /api/cron/llm-health-check failing 100% of invocations (145 failures in 12 hours) due to missing service_role grant on llm_provider_health table. This was the third manifestation of the Migration 005 grant gap pattern, following A-02 llm_calls.agent silent failures and 2026-05-19 7-table grant migration. Comprehensive audit revealed 27 additional tables with same gap. Migration 20260520161504_grant_service_role_comprehensive.sql applied grants to all 27 tables, permanently closing the class of bug.

**Scope:** All schema migrations creating or recreating tables. Exceptions permitted only for PostGIS system tables (spatial_ref_sys) or other extension-managed tables.

**Override:** No override permitted. Missing grants = immediate migration to add grants before any dependent code ships.

---

## Contract 65: RESERVED

**Status:** Reserved slot. No active rule.

**Note:** This contract number is reserved for future use. The numbering gap between Contract 64 (Service Role Grant Enforcement) and Contract 66 (Integration Smoke Test as Blocking Gate) was created during prior governance sessions. The RESERVED designation prevents future Claude/CC sessions from incorrectly assuming the number is available for reuse.

---
## Contract 66: Integration Smoke Test as Blocking Gate

**Established:** 2026-05-20

**Rule:** `tests/integration/pipeline-smoke.spec.ts` MUST pass before any commit lands on master. Validates critical agent pipeline end-to-end against a seeded client. Catches integration bugs that unit-style agent tests miss (FK violations, ordering issues, schema mismatches, output contract drift).

**Enforcement:** Included in `pnpm verify:ci` script via `playwright test` command. Pre-commit hook runs `verify:fast` (which excludes smoke test for speed); operator manually runs `verify:ci` before pushing significant changes.

**Bugs Caught During Initial Development (2026-05-20):**
1. **A-02 Group 2 FK violation:** agent_events row not created before llm_calls INSERT, violating Contract 62. Fixed by adding agent_events INSERT immediately after input validation.
2. **Invalid model name:** Primary model set to `claude-sonnet-4-7` (non-existent) instead of `claude-sonnet-4-6`. Fixed in src/lib/llm/router.ts and cost-estimator.ts.
3. **Missing agent_events UPDATE:** A-02 created agent_events row but never updated it to 'completed' status on success path. Fixed by adding UPDATE before success return.

**Test Coverage:**
- A-01 (intake processor): Client creation with geocoding
- A-06 (internal linker): Hub-and-spoke link enforcement
- Group 2 pattern validation: agent_events created BEFORE llm_calls
- Service creation and metadata persistence
- Agent completion status tracking

**Incident driving this contract:** 2026-05-20 — pattern of ship-fast agents accumulated integration bugs (cron failure from missing grants, A-02 LLM ordering FK violation, missing system user breaking agent_events writes) that unit tests missed. Smoke test catches the compound failures that emerge when agents interact with real database state.

**Scope:** All commits to master. Smoke test runs in CI via `pnpm verify:ci`.

**Override:** No override permitted. Smoke test failure = fix the integration bug before pushing.

---

## Contract 67: Resource Ownership Verification

**Established:** 2026-05-21

**Rule:** All operator API routes that accept resource identifiers (client_id, page_id, etc.) in URL parameters MUST verify the authenticated operator owns the resource before allowing access or modification.

**Enforcement Pattern:**

For routes accepting client_id:
```typescript
// Contract 67: Verify resource ownership - operator must own this client
const { data: ownershipCheck } = await supabase
  .from('clients')
  .select('id')
  .eq('id', clientId)
  .eq('operator_id', user.id)
  .maybeSingle()

if (!ownershipCheck) {
  logger.warn('Forbidden - operator does not own client', {
    operator_id: user.id,
    client_id: clientId
  })
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}
```

For routes with nested resources (pages belonging to clients):
- First verify operator owns the client
- Then verify the nested resource (page_id) belongs to that client
- Both checks are mandatory

**OAuth State Parameter Validation:**

OAuth flows (e.g., Google Calendar authorization) MUST implement CSRF protection via state parameter:

1. **Initiation route:** Generate cryptographically random state token (crypto.randomBytes(32)), store in oauth_state_tokens table with user_id and 10-minute expiry
2. **Callback route:** Validate state parameter exists, not expired, not previously used; mark as used; associate tokens with user_id from state lookup (not from callback session)
3. **One-time-use enforcement:** State tokens marked used_at on first use, rejected on subsequent attempts

**Routes Protected (as of 2026-05-21):**
- /api/operator/clients/[id] (GET, PUT)
- /api/operator/clients/[id]/pages/[pageId] (GET)
- /api/operator/clients/[id]/flagged (GET)
- /api/operator/clients/[id]/flagged/[pageId]/approve (POST)
- /api/operator/clients/[id]/flagged/[pageId]/reject (POST)
- /api/admin/google-calendar-auth (GET) - operator auth + state generation
- /api/admin/google-calendar-auth/callback (GET) - state validation

**Database Schema:**

Table `oauth_state_tokens`:
- state_token TEXT UNIQUE (cryptographically random)
- user_id UUID (operator initiating OAuth)
- expires_at TIMESTAMPTZ (10-minute TTL)
- used_at TIMESTAMPTZ (one-time-use marker)
- RLS enabled with operator-only SELECT policy

**Incident driving this contract:** 2026-05-21 security audit revealed operator routes verified role (operator vs client) but not resource ownership. Operator A could access Operator B's clients/pages by manipulating URL parameters. OAuth routes lacked CSRF protection entirely.

**Scope:** All operator routes accepting resource identifiers. All OAuth flows.

**Override:** No override permitted. Missing ownership check = immediate security vulnerability.


---

## Contract 68: RESERVED

**Status:** Reserved slot. No active rule.

**Note:** This contract number is reserved for future use. The numbering gap between Contract 67 (Resource Ownership Verification, amended 2026-05-23) and Contract 69 (INSERT Error Capture Required) was created during prior governance sessions. The RESERVED designation prevents future Claude/CC sessions from incorrectly assuming the number is available for reuse.

---
## Contract 69: INSERT Error Capture Required

**Established:** 2026-05-22 (DRAFT - awaiting operator approval)

**Rule:** All Supabase INSERT operations in agent code MUST destructure and check the `error` field. Error handling pattern depends on INSERT category: work-critical INSERTs throw on failure, lifecycle telemetry INSERTs log loudly but do not throw.

**Category A - Work-Critical INSERTs:**

INSERTs that persist the agent's output or critical state. If these fail, the agent's work is incomplete.

**Examples:** page_claim_provenance, link_audit_log, tenant_signals, gsc_rate_limits, page_indexation

**Pattern:**
```typescript
const { error: provenanceInsertError } = await supabase.from('page_claim_provenance').insert({...});
if (provenanceInsertError) {
  throw new Error('G1_PROVENANCE_INSERT_FAILURE: ' + provenanceInsertError.message);
}
```

**Category B - Lifecycle Telemetry INSERTs:**

INSERTs to `agent_events` table that record execution lifecycle but are not the agent's output. Failing to log lifecycle = lost telemetry, not lost work. Throwing here would falsely mark successful work as failed.

**Examples:** agent_events with status='running', 'completed', or 'failed'

**Pattern:**
```typescript
const { error: lifecycleInsertError } = await supabase.from('agent_events').insert({...});
if (lifecycleInsertError) {
  logger.error('agent_events INSERT failed - lifecycle telemetry lost but work succeeded', {
    agent_id: 'A-XX',
    agent_event_id: agentEventId,
    client_id: input.client_id,
    insert_error: lifecycleInsertError.message
  });
}
```

**INCORRECT (forbidden pattern):**
```typescript
// ✗ Bare await with no error destructuring - INSERT failures silently swallowed
await supabase.from('page_embeddings').insert({
  page_id: page.id,
  client_id: client.id,
  embedding: embedding
});
```

**Category Decision Criteria:**

1. Is the INSERT the agent's work output? → Category A (throw on error)
2. Is the INSERT before-work lifecycle (status='running')? → Category B (log on error, do not throw)
3. Is the INSERT after-work lifecycle (status='completed'/'failed')? → Category B (log on error, do not throw)
4. Ambiguous case not fitting A or B? → Escalate to operator, do not improvise Category C

**Error Code Naming Convention:**
- Format: `{GATE_ID}_{OPERATION}_{FAILURE_TYPE}`
- Examples:
  - `G2_EMBEDDING_INSERT_FAILURE`
  - `G2_RPC_FUNCTION_FAILURE`
  - `G1_SCHEMA_INSERT_FAILURE`
  - `VALIDATION_RESULTS_INSERT_FAILURE`

**Integration Test Requirement:**

Every agent with INSERT operations MUST have persistence integration tests verifying:
1. Successful INSERT results in 1 row in target table
2. Row contains expected data structure
3. INSERT errors propagate to agent_events.status='failed'

Example test structure:
```typescript
test('Agent persists data to table X', async () => {
  // Run agent
  await agentFunction({ page_id: testPageId });
  
  // Verify row exists
  const { data, error } = await supabase
    .from('target_table')
    .select('*')
    .eq('page_id', testPageId)
    .single();
  
  expect(error).toBeNull();
  expect(data).toBeDefined();
  expect(data.required_field).toBeDefined();
});
```

**Enforcement Mechanisms:**

**Layer 1 (Pre-commit Hook):**
- Script: `.husky/pre-commit` calls `scripts/verify-insert-patterns.ts`
- Detection: Grep for `await supabase.from(...).insert(` patterns in `src/agents/` without preceding `const { error` destructuring
- Action: BLOCK commit on violation, report file:line locations
- Pattern: Matches Contract 64 (Service Role Grant) and Contract 65 (System User Seed) dual-layer enforcement

**Layer 2 (CI Verification):**
- Script: `scripts/verify-insert-patterns.ts` runs in CI pipeline via `pnpm verify:ci`
- Detection: Same grep pattern as Layer 1
- Action: BLOCK CI on violation, fail build
- Purpose: Catch violations that bypass pre-commit hook (force-push, --no-verify)

**Layer 3 (Integration Tests):**
- All agents with INSERT operations MUST have persistence integration tests
- Tests verify: (1) row inserted, (2) correct structure, (3) errors propagate to agent_events.status='failed'

**Layer 4 (Code Review):**
- Manual review flags bare INSERT calls during PR review

**Exceptions:**

1. **Seed scripts (scripts/):** May use bare INSERT if documented fallback logic exists
2. **Background sync jobs:** May use bare INSERT if retry/dead-letter queue handles failures
3. **UPDATE/DELETE operations:** This contract applies to INSERT only (UPDATE/DELETE have different failure modes)

**Incident driving this contract:**

2026-05-22: A-05 Page Validator silently failed to persist embeddings and validation results across 299 runs (2026-05-14 to 2026-05-22). Root cause: type mismatch on embedding INSERT + missing error handling. Result: 0 rows in page_embeddings, 0 rows in page_validation_results. See docs/audits/2026-05-22-a05-persistence-audit.md.

**Scope:** All agent code in src/agents/ that performs Supabase INSERT operations.

**Override:** No override permitted. Missing INSERT error check = silent data loss risk.

**Status:** ACTIVE (2026-05-22) — Dual-layer enforcement operational, baseline remediated.

**Baseline audit (2026-05-22):** 20 violations found at activation. Remediated with category-appropriate patterns:
- Category A (6 sites): page_claim_provenance, link_audit_log (2), tenant_signals, gsc_rate_limits, page_indexation — throw on error
- Category B (14 sites): agent_events lifecycle telemetry — log on error, do not throw

**Activation timeline:**
1. ✓ Phase 1 (2026-05-22): Contract 69 declared ACTIVE — new code must comply
2. ✓ Phase 2 (2026-05-22): Baseline violations remediated with two-category pattern distinction
3. ✓ Phase 3 (2026-05-22): Enforcement script enabled in `verify:fast`, `verify:ci`, `verify:full` — blocks commits with bare INSERT patterns

---

## Contract 70: Operator Endpoint Auth Helper Requirement

**Established:** 2026-05-22
**Status:** ACTIVE

**Rule:** All API routes under `/api/operator/` MUST use the shared operator authentication helper `getOperatorContext()` from `src/lib/auth/operator-context.ts`. Direct usage of `createClient()` from `@/lib/supabase/server` in operator endpoints is forbidden.

**Purpose:** Prevent RLS vulnerability where operator endpoints using anon role client fail all database queries silently. Middleware validates Bearer tokens and sets `x-user-id` header before routes execute — service role client is safe to use after this validation.

**Required Pattern:**

```typescript
import { getOperatorContext, verifyOperatorOwnsClient, OperatorAuthError } from '@/lib/auth/operator-context'

export async function GET(request: NextRequest, ...) {
  try {
    // Contract 70: Use shared operator auth helper
    const { userId, supabase } = await getOperatorContext(request);
    
    // Verify operator role (check that user is NOT a client)
    const { data: clientRecord } = await supabase
      .from('clients')
      .select('id')
      .eq('client_user_id', userId)
      .maybeSingle()
    
    if (clientRecord) {
      return NextResponse.json({ error: 'Forbidden - operator access only' }, { status: 403 })
    }
    
    // Contract 67: Verify operator owns this client
    const ownsClient = await verifyOperatorOwnsClient(supabase, userId, clientId);
    if (!ownsClient) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    
    // ... route logic
  } catch (error) {
    if (error instanceof OperatorAuthError && error.code === 'OPERATOR_AUTH_MISSING') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    // ... generic error handling
  }
}
```

**Enforcement Mechanisms:**

**Layer 1 (Pre-commit Hook):**
- Script: `scripts/verify-operator-auth-pattern.ts` called from `.husky/pre-commit`
- Detection: Grep for `createClient()` in `src/app/api/operator/` directory
- Action: BLOCK commit on violation, report file:line locations

**Layer 2 (CI Verification):**
- Script: `scripts/verify-operator-auth-pattern.ts` runs in `pnpm verify:ci`
- Detection: Same grep pattern as Layer 1
- Action: BLOCK build on violation

**Protected Routes (as of 2026-05-22):**
- /api/operator/initiate-checkout/route.ts
- /api/operator/clients/[id]/route.ts (GET, PUT)
- /api/operator/clients/[id]/flagged/route.ts (GET)
- /api/operator/clients/[id]/flagged/[pageId]/approve/route.ts (POST)
- /api/operator/clients/[id]/flagged/[pageId]/reject/route.ts (POST)
- /api/operator/clients/[id]/pages/[pageId]/route.ts (GET)

**Incident driving this contract:** 2026-05-22 — Operator endpoints using `createClient()` from `@/lib/supabase/server` created anon role clients that lacked grants on clients table, causing all ownership verification queries to fail silently. Middleware validates tokens but doesn't establish session, so authenticated role was also unusable. Service role client with middleware validation is the correct pattern.

**Scope:** All routes under `/api/operator/` directory.

**Override:** No override permitted. Using anon client in operator routes = silent query failures.

---

## Contract 71: Role-Based Access Control (RBAC) Enforcement

**Established:** 2026-05-23
**Status:** ACTIVE upon governance commit

**Scope:** All operator-side API routes, dashboard server actions, operator-facing UI components.

**Rule:** Every protected action MUST perform an explicit role-and-permission check via `hasPermission(role, action)` from `src/lib/auth/role-context.ts` BEFORE executing. Direct role checks (e.g., `if (user.role === 'master_admin')`) are prohibited. The canonical permission matrix in `src/lib/auth/permission-matrix.ts` is the only source of truth.

**Canonical Permission Matrix:** Documented in `ROLE_HIERARCHY_ARCHITECTURE_SPEC.md` Section 3 (authoritative) and encoded in `src/lib/auth/permission-matrix.ts` (runtime). Verification script `scripts/verify-permission-matrix-sync.ts` ensures synchronization.

**Three Roles:** master_admin (platform owner), senior_admin (operational manager), va (virtual assistant), plus existing client role.

**Constitutional Constraints (No Role Override):** Contract 6 (TCPA), Contract 9 hard gates (V9/V10/V13), Contract 18 (Evidence Authenticity), Contract 45 (Review Authenticity) remain enforceable at database/application layer regardless of role.

**Enforcement:** Pre-commit hook + CI verification via `scripts/verify-rbac-pattern.ts`. Runtime audit via `user_actions` denied_permission logs. Permission matrix sync verified in CI.

**Amendment (2026-05-25, established with P11.5a):**

The `@rbac-exempt` marker is an explicit, audit-trail-preserving exception mechanism for legitimate direct queries on `user_roles` that are NOT auth/permission lookups. The marker is appropriate for:

- Bulk listing queries (e.g. GET /api/operator/users for /dashboard/users UI must SELECT all grants with JOINs)
- Aggregate/count queries (e.g. constitutional protection: count active master_admins to prevent last-one demotion)
- Audit/reporting queries (e.g. role_grant_audit cross-joins)

The marker is NOT appropriate for:

- Single-user role lookups (must use `getUserActiveRole()`)
- Permission checks (must use `hasPermission()` or `requirePermission()`)
- Any ad-hoc role string comparison

Usage requires explicit justification comment on the same or preceding 2 lines:

```typescript
// @rbac-exempt: bulk listing query for all grants, not a role lookup
const { data } = await supabase.from('user_roles').select(...);
```

The marker is recognized by `scripts/verify-rbac-pattern.ts`. Marker usage is grepable for audit purposes:
```powershell
Select-String -Path src -Recurse -Pattern '@rbac-exempt'
```

All marker usages must be reviewed during quarterly audit per Contract 75 (Quarterly Drills) to confirm continued legitimacy.

**Server Component RLS Race Prevention:**

Server components (page.tsx, layout.tsx files under src/app/) that need role lookup MUST use `createServiceRoleClient()`, not the anon SSR client. This pattern was established in P11.4 login regression fix (commit b997464). P11.5a /dashboard/users page (commit 7bfafc8) regressed this pattern; fixed in commit <TBD>.

Root cause of the regression class: RLS policy `users_can_read_own_role` checks `auth.uid()`. Server-side rendering may execute the role query before the session JWT has fully propagated; `auth.uid()` returns null; `.single()` returns no rows; `getUserActiveRole` returns null; component redirects to /login.

Service-role client bypasses RLS entirely (it IS the auth layer), eliminating the race.

Correct pattern for server components:
```typescript
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { getUserActiveRole } from '@/lib/auth/role-context';

export default async function MyPage() {
  // Step 1: Get authenticated user via SSR client
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Step 2: Look up role via SERVICE ROLE client (bypasses RLS)
  const serviceClient = createServiceRoleClient();
  const role = await getUserActiveRole(serviceClient, user.id);
  // ... rest of component
}
```

Enforced by `scripts/verify-rbac-pattern.ts` pattern check: any server component calling `getUserActiveRole` without importing `createServiceRoleClient` is a violation.

---

## Contract 72: Multi-User Audit Attribution

**Established:** 2026-05-23
**Status:** ACTIVE upon governance commit

**Scope:** All audit-logged actions. Includes `user_actions` table (canonical), `operator_actions` (legacy), `role_grant_audit`, `page_decisions`, and future audit tables.

**Rule:** Every audit log row MUST capture three attribution attributes:
1. **Acting user ID** (UUID, NOT NULL, FK to auth.users)
2. **Role at time of action** (TEXT, NOT NULL, captured fresh at action time, never mutated)
3. **Client context** (UUID FK to clients, nullable only for platform-level actions)

**Why "role at time of action":** User roles change over time. Audit trail must record the role held WHEN the action was performed, not current role at query time. Captured at write time, never mutated.

**Result Enum:** success, denied_permission, denied_constraint, failed.

**Immutability:** user_actions table has NO UPDATE or DELETE policy. Audit rows are append-only.

**Justification Requirement:** Override actions require TEXT justification field (force-publish, P0 dismissal, cost cap increase, role grant/revoke, A-44 manual provision, ingestion block toggle).

**Enforcement:** Pre-commit hook + CI via `scripts/verify-audit-attribution.ts`. Database NOT NULL constraints on acting_user_id, acting_user_role, action_type. Append-only enforced by absence of UPDATE/DELETE policies.

---

## Contract 73: Pre-Generation Knowledge Ingestion Requirement

**Established:** 2026-05-23
**Status:** ACTIVE upon governance commit (enforcement live when A-44 ships)

**Scope:** A-02 Page Generator and any agent generating client-facing content (A-25, A-26, A-27, A-46 directory listings).

**Rule:** A-02 MUST NOT execute for a client unless that client has a `client_ingestion_versions` row where:
- is_current = TRUE
- status IN ('success', 'manually_provided')
- approval_status IN ('auto_approved', 'approved', 'manually_provided')

Check happens at agent entry BEFORE any LLM call. Throws ContractViolationError if prerequisite not met.

**Why this exists:** Pages without ingested context produce generic AI content (violates Contract 61), hallucinated trust signals (violates Contract 18), inconsistent NAP data, and missed keyword opportunities. Contract 73 gates generation on successful prerequisite.

**Three Refresh Triggers:** Onboarding (mandatory Step 9), Quarterly CRON (CRON-03 ±7 day jitter), Manual (master/senior Force Re-scrape).

**Override Path:** Master_admin only. Manual asset provision via /dashboard/clients/[id] Tab 7 when site is unscrapable. Creates client_ingestion_versions row with approval_status='manually_provided'. Logged to user_actions per Contract 72.

---

## Contract 74: CIF Compliance Mandate

**Status:** Active. Established 2026-05-24.

**Rule:** Every commit must pass `pnpm verify:fast`. Every push must pass `pnpm verify:ci`. Every release must pass `pnpm audit:comprehensive`. CIF failures block the action. No exceptions, no overrides, no defers.

**Enforcement:** Pre-commit hook (verify:fast), pre-push hook (verify:ci), release workflow gate (audit:comprehensive). All three hooks must be active.

**Reference:** docs/architecture/COMPREHENSIVE_INTEGRITY_FRAMEWORK.md

**Rationale:** Comprehensive verification at every tier prevents the drift accumulation pattern observed in the 2026-05-24 audit. Catching issues at commit time costs minutes. Catching them in production costs hours or days plus customer trust.

---

## Contract 75: Quarterly Drills

**Status:** Active. Established 2026-05-24.

**Rule:** The following drills are rehearsed quarterly with results logged in docs/drills/<YYYY-Q#>/:
- Backup restore
- Deployment rollback
- API key rotation
- Onboarding doc test on fresh machine
- Schema parity staging vs production

**Schedule:** End of Q1, Q2, Q3, Q4 in operator local time.

**Enforcement:** Layer 6 and Layer 7 of CIF report time-since-last-drill. If any drill is overdue, the layer reports RED and blocks audit:comprehensive pass.

**Rationale:** Backup, rollback, and rotation procedures decay silently. Quarterly drills verify they still work.

---

## Contract 76: CIF Coverage Reporting

**Status:** Active. Established 2026-05-24.

**Rule:** `pnpm audit:comprehensive` produces a coverage report at `docs/audits/<YYYY-MM-DD>-cif-coverage.md` showing percentage of layers passing, per-layer GREEN/YELLOW/RED status, findings classified by severity, and time-since-last-drill for quarterly items.

**Goal:** 100% GREEN. Any RED is blocking.

**Retention:** Reports retained indefinitely as historical CIF trend record.

**Enforcement:** Release workflow refuses to proceed if latest CIF coverage report has any RED layer.

**Rationale:** Coverage trend tracking surfaces gradual drift before it becomes acute. Per-layer status enables targeted remediation.

---

## Contract 77: STATE_OF_THE_BUILD.md Append-Only Semantics

**Status:** Active. Established 2026-05-24.

**Rule:** STATE_OF_THE_BUILD.md is append-only for session log entries. CC prompts that document new work in this file MUST use explicit append semantics. The file's historical content is immutable per Contract 50 (Architectural Decision Durability).

**Forbidden operations:**
- Rewriting STATE_OF_THE_BUILD.md from scratch
- Replacing the entire file with a summary
- Truncating historical session log entries
- Removing entries for completed work
- Replacing the file's content via file-write operations that don't preserve prior content

**Required operations:**
- New session log entries appended chronologically at end of session log section
- ACTIVE BUILD DAG and CIF BUILD STAGES sections may be UPDATED in place (these reflect current state, not history)
- Last-Updated timestamp at top of file may be updated
- Heading structure preserved
- All prior session log entries preserved verbatim

**Enforcement:**

1. Every CC prompt that touches STATE_OF_THE_BUILD.md MUST include the phrase "append session log entry" or "update ACTIVE BUILD DAG section" — not "update STATE_OF_THE_BUILD.md" alone.

2. Pre-commit hook check: scripts/verify-state-build-append-only.ts compares staged STATE_OF_THE_BUILD.md against HEAD version. If staged version has fewer lines than HEAD AND no explicit rewrite-approval marker, commit is blocked.

3. Post-commit verification: CIF Layer 8.7 (Internal Document Consistency) extended with "destructive rewrite detection" — any commit reducing STATE_OF_THE_BUILD.md by more than 10% requires explicit operator approval recorded in the commit message.

**Override mechanism:** Genuinely-needed rewrites (rare) must include the line "STATE_OF_THE_BUILD-REWRITE-APPROVED-BY-OPERATOR" in the commit message body. Without this marker, pre-commit hook blocks. With the marker, hook permits and logs.

**Rationale:**

The 2026-05-24 destructive rewrite (commit 28b693a) silently lost 3,104 lines of session log history covering project inception through 2026-05-23. Recovered via commit e550277 by extracting commit 26d7058's version of the file. The class of failure: ambiguous prompt language ("update STATE_OF_THE_BUILD") interpreted as "replace contents" rather than "append entry." This contract makes the append semantic explicit and enforced.

**References:**
- Lost data event: commit 28b693a (governance catch-up)
- Recovery event: commit e550277 (STATE_OF_THE_BUILD restoration)
- Contract 50 (Architectural Decision Durability) — STATE_OF_THE_BUILD session log is the canonical record of architectural decisions; therefore append-only per Contract 50 implicitly, now made explicit via this contract

---

## Contract 78: Governance Script Staleness Prevention

**Status:** Active. Established 2026-05-25.

**Rule:** Verification scripts in scripts/ must not contain hardcoded lists of files, tables, contracts, or other system artifacts that change as the system evolves. All such lists must be dynamically discovered at runtime.

**Forbidden patterns:**

- Hardcoded migration file lists (e.g. const migrationFiles = ['file1.sql', 'file2.sql'])
- Hardcoded table name lists for schema scans
- Hardcoded contract number ranges (must scan BEHAVIORAL_CONTRACTS.md dynamically)
- Hardcoded route paths for RBAC enforcement (must walk src/app/api/ recursively)
- Any other static enumeration of artifacts that grow with development

**Required patterns:**

- Dynamic directory enumeration: readdirSync, glob patterns, recursive walks
- Database introspection where applicable: SELECT FROM information_schema, pg_class, etc.
- File content scanning: parse heading patterns, AST analysis, regex over source

**Rationale:**

The 2026-05-24 P11.5a verification reported "42 tables documented but not in migrations." Investigation revealed scripts/check-schema-drift.ts was hardcoded in May to check only 2 specific migration files. As the project added 54 migrations through May 24, the script's coverage silently dropped to 3.6% while continuing to report "PASS." The hardcoded list was a time bomb that masked real verification capability.

Future verification scripts must not embed such time bombs. Dynamic discovery means the script's coverage grows with the system automatically.

**Enforcement:**

A meta-check script (scripts/verify-no-hardcoded-artifact-lists.ts) scans scripts/ directory for suspicious patterns:
- Array literals containing >2 SQL filenames
- Array literals containing >5 table names
- Hardcoded file path lists for tracked artifacts

Detected patterns are flagged for review.

**Cross-references:**

- Discovered via diagnostic of Issue 2 in P11.5a remediation (commit TBD)
- Related to Contract 50 (Architectural Decision Durability) — verification scripts encode architectural assumptions that must stay current
- Related to Contract 74 (CIF Compliance Mandate) — verification gaps undermine CIF coverage claims