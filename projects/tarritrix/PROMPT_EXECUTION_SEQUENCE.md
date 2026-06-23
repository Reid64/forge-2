# TARRITRIX 1.0 â€” PROMPT EXECUTION SEQUENCE
**Status:** Locked. Send one prompt at a time to Claude Code. Confirm done before sending next.

---

## ANTI-HALLUCINATION HEADER (Prepend to EVERY prompt)

> Before executing: verify all table references against SCHEMA_REGISTRY.md, all route references via grep src/app/, all column references against migration files. Do not invent. Do not assume. Do not claim completion without verification. If uncertain, stop and ask. No time estimates. No incremental fixes. Definitive solutions only. If a previous fix failed, do not repeat the same approach â€” research alternatives first.

---

## PROMPT 1 â€” FOUNDATION RESET

Apply Migration 002 (file: `supabase/migrations/20260505200000_tarritrix_phase1_completion.sql` â€” provided separately). Verify all 14 new tables exist in live Supabase. Verify RLS is enabled on each. Install Sentry via `pnpm add @sentry/nextjs` and run `npx @sentry/wizard@latest -i nextjs`. Write `scripts/verify-schema.ts` that compares live Supabase schema to SCHEMA_REGISTRY.md and exits 1 on mismatch. Write tenant isolation Playwright suite at `tests/e2e/tenant-isolation.spec.ts` covering Operator A cannot see Client B data, Client X cannot see Client Y data, service role key not used in client-facing code. Update `pnpm verify` script to run tsc + vitest + playwright + schema verifier + tenant isolation. Commit all uncommitted files from prior session. Run `pnpm verify`. Fix any failures. Commit and push. Report commit hash.

---

## PROMPT 2 â€” STRIPE CORRECTION

Use Stripe API to list all existing products in the account. Identify which have incorrect amounts. Delete all incorrect Tarritrix products via API. Create three new products via API:
- Starter: $997 one-time market activation fee + $497/mo recurring subscription
- Growth: $2,497 one-time market activation fee + $997/mo recurring
- Authority: $4,997 one-time market activation fee + $1,997/mo recurring

For each product, create both the one-time price and the recurring price. Update local `.env.local` with new product IDs and price IDs. Run `vercel env add STRIPE_PRODUCT_ID_STARTER production`, `vercel env add STRIPE_PRODUCT_ID_GROWTH production`, `vercel env add STRIPE_PRODUCT_ID_AUTHORITY production` plus matching price ID env vars. Test webhook reception by creating a test customer + subscription. Verify webhook fires and is recorded in subscriptions table. Commit and push.

---

## PROMPT 3 â€” COLOR PALETTE + TYPOGRAPHY APPLICATION

Apply the locked mid-dark color palette from MASTER_BUILD_SPEC.md Section 2 across all existing surfaces. Update `src/app/globals.css` with CSS variables for marketing palette and dashboard palette. Self-host Inter (weights 400, 500, 600, 700) and JetBrains Mono (weight 400) by downloading WOFF2 files to `public/fonts/` and configuring `next/font/local`. Wire light logo (`public/logo-light.svg`) on dark backgrounds (sidebar, marketing, login). Wire dark logo (`public/logo-dark.svg`) only where contrast requires. Verify no `bg-white`, `text-white`, `#FFFFFF`, `#FFF` remain in any component. Run drift watchdog. Commit and push.

---

## PROMPT 4 â€” MARKETING SITE FOUNDATION

Create marketing landing page at `src/app/page.tsx` (root route, not under any layout that requires auth). Build per MASTER_BUILD_SPEC.md Section 5:
- Hero with animated typewriter (use framer-motion)
- Problem section (3 cards)
- Footer

Use locked marketing palette (#0A0F1C base, #FF6B35 CTA, #06B6D4 data accents). Use light logo (200px in hero, 160px in footer). Add login link in top-right header. Single Next.js page, mobile-first. Run Lighthouse, fix any score below 90. Verify production loads under 2 seconds. Commit and push.

---

## PROMPT 5 â€” MARKETING SITE CONTENT SECTIONS

Add to marketing page per MASTER_BUILD_SPEC.md Section 5:
- Five Moats interactive scroll-snap section
- How It's Different comparison table (Tarritrix column highlighted orange)
- Storm Intelligence Engine deep-dive section with interactive US map (use react-simple-maps for the map component)
- Pricing cards (3 tiers at correct amounts: Starter $997+$497/mo, Growth $2,497+$997/mo highlighted "Most Popular", Authority $4,997+$1,997/mo)

All sections animated on scroll. Mobile-responsive. Verify rendering at 375px, 768px, 1440px viewports. Commit and push.

---

## PROMPT 6 â€” MARKETING DEMO FORM + GOOGLE CALENDAR API

Build demo request form at bottom of marketing page per MASTER_BUILD_SPEC.md Section 5.7. Create `src/app/api/marketing/demo-request/route.ts` API endpoint. Implement Google Calendar OAuth flow:
1. One-time operator authorization at `/api/admin/google-calendar-auth` â€” returns refresh token
2. Add `GOOGLE_CALENDAR_OPERATOR_REFRESH_TOKEN` and `GOOGLE_CALENDAR_OPERATOR_EMAIL` to .env.local and Vercel
3. Form submit handler: validate inputs, create Google Calendar event in operator's calendar, send Resend confirmation email to lead, store row in `demo_requests` table

Form must include all fields per spec. Success state shows appointment confirmation with ICS download. Test end-to-end with real submission. Commit and push.

**CRITICAL REQUIREMENTS for Prompt 6 demo request form (see BLUEPRINT.md "Personalized Demo Engine" + Contract 31):**
- ZIP code field (TEXT, REQUIRED) â€” for Personalized Demo Engine Tier 1+
- Primary city / service area field (TEXT, REQUIRED) â€” for personalized dashboard pre-population
- These fields MUST be required, not optional. Without them, Tier 1 cannot function.

---

## PROMPT 7 â€” OPERATOR COMMAND CENTER ZONE 1 (STAT STRIP)

Build top stat strip per MASTER_BUILD_SPEC.md Section 7 Zone 1. Create:
- `src/app/dashboard/page.tsx` â€” Command Center home
- `src/app/api/dashboard/stats/route.ts` â€” returns stat data
- `src/components/dashboard/StatStrip.tsx` â€” 6 cards
- `src/components/dashboard/StatCard.tsx` â€” individual card

Wire 30-second polling via React Query (`refetchInterval: 30000`). Pull real data from clients, pages, llm_calls, subscriptions, tenant_signals tables. Color-code per spec. Verify no placeholder data anywhere. Commit and push.

**Personalized Demo Engine Tier 1 â€” must build during operator command center prompts:**
- "Demos" sidebar item showing scheduled upcoming demos from demo_requests table
- "Demo Prep" surface that renders Storm Intelligence Engine dashboard with prospect-specific city data pulled from demo_requests.zip + primary_city
- REUSE SignalGeography component from src/app/_components/marketing/Hero.tsx (consider extracting to src/components/shared/ during Prompt 7-10 work)

---

## PROMPT 8 â€” OPERATOR COMMAND CENTER ZONE 2 (ACTIVITY FEED)

Build real-time activity feed per MASTER_BUILD_SPEC.md Section 7 Zone 2. Create:
- `src/app/api/dashboard/activity-feed/route.ts` â€” paginated agent_events
- `src/components/dashboard/ActivityFeed.tsx` â€” feed with filter chips, color-coded rows, infinite scroll

Polls every 30 seconds. Filter chips for agent name, client, event type, severity. Color-coded by severity. Real data only from agent_events table. Commit and push.

---

## PROMPT 9 â€” OPERATOR COMMAND CENTER ZONE 3 + ZONE 4

Build per MASTER_BUILD_SPEC.md Section 7 Zones 3 and 4:
- Next Best Actions panel reading from tenant_signals where dismissed=false
- Tenant Health panel showing top 5 clients by composite score (compute via `/api/clients/[id]/health`)
- Advisory Signals panel
- Velocity chart (last 30 days, all clients stacked) using Recharts
- LLM cost vs cap chart

All polling at 30s. All data real, no mocks. Commit and push.

---

## PROMPT 9.5 â€” PER-PAGE ANALYTICS + DASHBOARDS (PHASE B SECTION 3)

Wire PostHog with per-page tracking. Build page_metrics rollup edge function (CRON every 5 min). Add analytics tabs to Surface 4 (Client Detail Pages tab) and Surface 6 (Client Portal My Pages with metrics).

**PostHog Setup:**
- Add PostHog tracking code to published page template
- Fire page view event on load with page_id, client_id, session_id
- Fire conversion event on form submit / call tracking webhook

**Edge Function: supabase/functions/page-metrics-rollup/index.ts**
- Reads PostHog API for events since last run (5-minute window)
- Upserts page_metrics table per page_id
- Computes conversion_rate_30d, performance_tier classification (high/median/low)
- Scheduled via pg_cron every 5 minutes (add to platform_config)

**Operator Dashboard (Surface 4):**
- New "Pages Analytics" tab in Client Detail view
- Table: page URL, views_30d, conversions_30d, conversion_rate_30d, performance_tier badge
- Sortable, filterable by tier, export CSV
- Polls `/api/clients/[id]/page-metrics` every 30 seconds

**Client Portal (Surface 6):**
- Enhance existing My Pages list with new columns: views_30d, conversions_30d, conversion_rate_30d
- Color-coded performance badges (green/yellow/red)
- RLS-filtered to client's pages only

Run pnpm verify. Commit and push.

---

## PROMPT 10 â€” SURFACES 4, 5, 6 POLISH AND BUILD

Build per MASTER_BUILD_SPEC.md Sections 8, 9, 10:

Operator client management:
- Tabs on client detail (Overview, Pages, Profile Data, Activity, Billing, Integrations)
- Flagged pages queue with override controls (override requires reason, logged to operator_actions)
- Page detail with full quality scores

Client portal login: visual polish using locked palette.

Client portal:
- Overview page with 4 stat cards, RLS-filtered activity feed, invoice preview, onboarding progress (if onboarding)
- Sidebar nav with all 6 items
- All RLS verified â€” client sees only own data

Run tenant isolation suite. Verify operator cannot access /portal, client cannot access /dashboard. Commit and push.

---

## PROMPT 11 â€” RECOMMENDATIONS ENGINE

Build edge function `supabase/functions/recommendations-engine/index.ts` per MASTER_BUILD_SPEC.md Section 11. CRON every 5 minutes (added in Migration 002). Implement all 8 recommendation categories:
1. Quality issues (flagged pages aging, low quality scores)
2. Cost anomalies (LLM spend spikes, cap proximity)
3. Lifecycle events (drip phase transitions, refresh cycles due)
4. Compliance (DSAR deadlines approaching)
5. Integration (webhook failures, sync gaps)
6. Onboarding (incomplete steps, validation failures)
7. Performance (pages with 0 impressions 30+ days)
8. Billing (failed payments, expiring cards)

Writes to tenant_signals table. Verify recommendations appear in Command Center within 5 minutes of trigger condition. Commit and push.

---

## PROMPTS 12-22 â€” BUILD ALL 14 PHASE 1 AGENTS (ONE PER PROMPT)

For each agent, the prompt template is:

> Build [AGENT_NAME] per BLUEPRINT.md Section 5.3 and MASTER_BUILD_SPEC.md. Implement complete contract: trigger, runtime, timeout, inputs, outputs, failure handling. Write file at `supabase/functions/[agent-slug]/index.ts`. Write unit tests at `tests/agents/[agent-slug].test.ts` covering all logic branches. Write integration test at `tests/integration/[agent-slug].integration.test.ts` confirming correct DB writes for happy path and failure paths. Verify all tables read/written exist in SCHEMA_REGISTRY.md. Run pnpm verify. Commit and push. Update STATE_OF_THE_BUILD.md test status.

Order:
- Prompt 12: A-01 Intake Processor
- Prompt 13: A-10 Content Profile Builder (with heatmap)
- Prompt 14: A-02 Page Generator
- Prompt 15: A-03 Schema Generator
- Prompt 16: A-04 Map Embed Generator
- Prompt 17: A-05 Page Validator (15 gates)
- Prompt 18: A-06 Internal Link Builder
- Prompt 19: A-07 Sitemap Generator
- Prompt 20: A-08 Indexation Tracker
- Prompt 21: A-09 Conversion Handler
- Prompt 22a: A-11 Content Refresh Engine
- Prompt 22b: A-14 Review Velocity Engine
- Prompt 22c: A-18 Job Evidence Ingestion Engine
- Prompt 22d: A-19 Universal Integration Hub

---

## PROMPT 23 â€” CRON JOBS

Build CRON-01 Drip Publisher (3am UTC daily) and CRON-02 Indexation Runner (6am UTC daily). Both per BLUEPRINT.md and MASTER_BUILD_SPEC.md. Schedule via pg_cron (already added in Migration 001). Verify scheduling in Supabase. Monitor execution over 3 consecutive days, check cron_run_log table for entries. Commit and push.

---

## PROMPT 24 â€” GBP API APPLICATION

Operator submits Google Business Profile API application using copy provided in `GBP_API_APPLICATION.md`. Track application reference number. Update STATE_OF_THE_BUILD.md with submission date. Set reminder to follow up at 4 weeks if no response.

---

## PROMPT 25 â€” PHASE 1 EXIT VERIFICATION

Verify every item in Phase 1 Exit Criteria from MASTER_BUILD_SPEC.md Section 20. For any unchecked item, fix or document blocker. When all items verified:
1. Tag GitHub release: `git tag -a v1.0-phase1-complete -m "Phase 1 complete â€” 14 agents, 2 crons, 6 surfaces, recommendations engine, marketing site live"`
2. Push tag: `git push --tags`
3. Update STATE_OF_THE_BUILD.md to reflect Phase 1 complete
4. Phase 1.5 begins only after GBP API approval received
