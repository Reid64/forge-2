# TARRITRIX 1.0 â€” MASTER BUILD SPEC
**Version:** 1.0 LOCKED | **Status:** Canonical Source of Truth
**Authority:** This document supersedes BLUEPRINT.md where they conflict.
**Last Updated:** 2026-05-05

---

## 0. READING ORDER FOR CLAUDE CODE

Every session reads these files in this order before any action:
1. MASTER_BUILD_SPEC.md (this file)
2. SCHEMA_REGISTRY.md
3. BEHAVIORAL_CONTRACTS.md
4. AGENTS.md
5. STATE_OF_THE_BUILD.md
6. BLUEPRINT.md (deep reference)

If any file conflicts with MASTER_BUILD_SPEC.md, this file wins.

---

## 1. SCOPE â€” PHASE 1 (NO DEFERRALS WITHOUT EXPLICIT WRITTEN PERMISSION)

### Agents (15)
A-01 Intake Processor
A-44 Client Knowledge Ingestion Engine (relocated from Phase 1.5 per operator decision 2026-05-23 — see ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 7 and BLUEPRINT.md Part 10.5 for canonical specification)
A-02 Page Generator (blocked from execution per Contract 73 until A-44 produces successful current ingestion version for the client)
A-03 Schema Generator
A-04 Map Embed Generator
A-05 Page Validator (15 gates)
A-06 Internal Link Builder
A-07 Sitemap Generator
A-08 Indexation Tracker
A-09 Conversion Handler
A-10 Content Profile Builder (with heatmap)
A-11 Content Refresh Engine
A-14 Review Velocity Engine
A-18 Job Evidence Ingestion Engine
A-19 Universal Integration Hub

### CRON Jobs (2)
CRON-01 Drip Publisher (3am UTC daily)
CRON-02 Indexation Runner (6am UTC daily)

### Surfaces (6)
1. Marketing landing page (tarritrix.com root)
2. Operator login (tarritrix.com/login)
3. Operator Command Center (tarritrix.com/dashboard)
4. Client Management (tarritrix.com/dashboard/clients/*)
5. Client Portal Login (tarritrix.com/portal/login)
6. Client Portal (tarritrix.com/portal)

### Systems
- 9-step onboarding wizard (8 manual operator steps plus automatic Step 9 A-44 knowledge ingestion — see BLUEPRINT.md Section 4.1 Step 9 for full specification)
- Stripe billing (4 tiers — Starter/Growth/Authority/Dominance — at locked amounts per Part 9.2 of BLUEPRINT.md)
- Recommendations Engine (Next Best Actions)
- Real-time polling (30-second intervals on command center)
- Advisory signals system (per-tenant warnings)
- Tenant health scoring (composite per client)
- GBP API application (write copy, user submits)
- Marketing demo form → Google Calendar API integration
- Role-Based Access Control (RBAC) system per ROLE_HIERARCHY_ARCHITECTURE_SPEC.md (three operator-side roles: master_admin, senior_admin, va; canonical permission matrix encoded in src/lib/auth/permission-matrix.ts; Contracts 71, 72, 73 enforce)
- Multi-user audit attribution captured via user_actions table with three-attribute logging (acting_user_id, acting_user_role, client_id)
- A-44 Client Knowledge Ingestion Engine with quarterly refresh CRON (CRON-03 a44-quarterly-refresh, ±7 day jitter)

### Phase 1.5 (waits for GBP API approval)
A-12 GBP Agent (full implementation)

### Future Phases (Phase 2/3 â€” DO NOT BUILD)
A-13, A-15, A-16, A-17, Storm Intelligence Engine, AI Visibility Premium, White-Label API

---

## 2. COLOR PALETTE â€” LOCKED

```
Marketing site:
  Base background:   #0A0F1C (deep midnight)
  Section panels:    #131B2E (slate-midnight)
  Cards on dark:     #1F2937 (graphite)
  Text primary:      #E5E7EB (cream-white)
  Text muted:        #9CA3AF (slate-mist)
  Accent CTA:        #FF6B35 (signal orange)
  Accent data:       #06B6D4 (electric cyan)
  Accent success:    #10B981 (emerald)

Operator + Client dashboards:
  Main background:   #1A2238 (deep slate-blue)
  Sidebar:           #0F1729 (darker slate-midnight)
  Cards/panels:      #243049 (mid-slate)
  Card border:       #334155
  Primary text:      #F5F1E8 (warm cream â€” brightest UI color)
  Secondary text:    #94A3B8
  Sidebar text:      #F5F1E8
  Sidebar muted:     #64748B
  Accent CTA:        #FF6B35
  Success:           #10B981
  Warning:           #F59E0B
  Danger:            #EF4444
  Info:              #06B6D4
```

NO PURE WHITE ANYWHERE. Brightest color is `#F5F1E8` (warm cream) for text only. All surfaces dark slate-blue.

---

## 3. TYPOGRAPHY â€” LOCKED

- Display headings: Inter, weight 700
- Section headings: Inter, weight 600
- Body: Inter, weight 400-500
- Data/code: JetBrains Mono, weight 400
- Sizes: 14px body, 16px primary, 24px section, 32px page title, 48px hero

---

## 4. LOGO â€” LOCKED

- Both light and dark SVG logo files exist in `public/`
- Light logo on dark backgrounds (sidebars, marketing, dashboards)
- Dark logo on light backgrounds (only used in client-facing PDFs/exports)
- Minimum width: 200px in headers, 160px in sidebars
- Never use raster (PNG/JPG) versions

---

## 5. SURFACE 1: MARKETING LANDING PAGE

### URL
tarritrix.com (root)

### Authentication
None â€” fully public

### Sections (top to bottom)

**5.1 Animated Hero**
- Background: #0A0F1C with subtle animated grid pattern, orange node pulses
- Logo top-left (light, 200px)
- Login link top-right
- Headline (animated typewriter): "Local SEO that Google can't penalize."
- Subheadline: "The first programmatic SEO platform with built-in penalty prevention, real-time job intelligence, and AI visibility tracking â€” for HVAC, plumbing, roofing, and electrical contractors."
- CTA button: "Schedule a Demo" -> scrolls to demo form

**5.2 The Problem (3 cards)**
- Card 1: "Agencies that disappear after the contract is signed"
- Card 2: "SEO that Google penalizes 6 months later"
- Card 3: "Pages that never get indexed"
- Each card: icon, headline, body copy, real stat

**5.3 The Five Moats (interactive scroll-snap)**
- Moat 1: 4-Layer Content Differentiation (animated layer stack)
- Moat 2: 15-Gate Quality Validation (animated gate sequence)
- Moat 3: Velocity Throttling (timeline animation)
- Moat 4: GBP Suspension Prevention (shield + gauge)
- Moat 5: Storm Intelligence Engine â€” radar map sweep

**5.4 How It's Different (comparison table)**

| Feature | Tarritrix | Traditional Agency | DIY |
|---|---|---|---|
| Cost transparency | Yes | No | N/A |
| Penalty prevention | Yes | No | No |
| Indexation tracking | Yes | partial | No |
| Real-time response | Yes | No | No |
| AI visibility tracking | Yes | No | No |
| Storm intelligence | Yes | No | No |

Tarritrix column highlighted orange.

**5.5 Storm Intelligence Engine Deep-Dive Section**
- Headline: "When a hailstorm hits, your competitors are still checking weather apps."
- Body: "We've already activated 47 pages, fired GBP posts, and queued enriched leads in your CRM."
- Interactive: hover US map, storm overlay reveals affected ZIPs + page activation count

**5.6 Pricing (3 tier cards)**
- Starter: $997 setup + $497/mo, 10 cities × 3 services, 30 pages max, 3->5->7 pages/day
- Growth: $2,497 setup + $997/mo, 20 cities × 5 services, 100 pages max, 5->8->12 pages/day (visually highlighted "Most Popular")
- Authority: $4,997 setup + $1,997/mo, 35 cities × 6 services, 210 pages max, 6->11->16 pages/day
- Each card: "Schedule a Demo" CTA

**5.7 Demo Request Form**
- Inline scheduling widget powered by Google Calendar API
- Fields: name, business name, phone, email, industry dropdown, current monthly marketing spend, preferred meeting time
- On submit: Google Calendar event created in operator's calendar, confirmation email via Resend, lead stored in `demo_requests` table
- Success state with appointment confirmation + ICS download

**5.8 Footer**
- Logo (light, 160px)
- Tagline: "Penalty-proof local SEO for the trades."
- Privacy policy, Terms of Service, Contact email, Login link
- Copyright

### Technical Requirements
- Next.js App Router, single page
- Mobile-first responsive
- Lighthouse score >90 all metrics
- Loads <2 seconds
- No render-blocking external fonts (Inter self-hosted)
- Meta title: "Tarritrix â€” Penalty-Proof Local SEO for Contractors"
- Meta description: "The first programmatic SEO platform with built-in Google penalty prevention, real-time job intelligence, and AI visibility tracking. For HVAC, plumbing, roofing, electrical."

---

## 6. SURFACE 2: UNIFIED LOGIN

### URL
tarritrix.com/login

### Purpose
Single login route for both operators and clients. Role-based routing via `clients.client_user_id` lookup eliminates dual-login UX confusion.

### Layout
- Centered card on #0A0F1C background
- Logo (light, 200px) above card
- Card background: #243049
- Email field, password field, Sign In button (#FF6B35)
- "Forgot password?" link

### Authentication Flow
1. User submits email + password to Supabase Auth
2. On success, query `user_roles` table:
   - SELECT role FROM user_roles WHERE user_id = auth.uid() AND revoked_at IS NULL LIMIT 1
3. Branch on role result:
   - role = 'client' → redirect to `/portal`
   - role IN ('master_admin', 'senior_admin', 'va') → redirect to `/dashboard`
   - No active role row → error: "Account inactive. Contact platform owner."
4. RLS policies enforce tenant isolation at database layer per ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 6

### Authentication Flow Migration Note
Prior flow (pre-2026-05-23) queried `clients` table directly to determine role via `client_user_id` vs `operator_id` lookup. The new flow queries the dedicated `user_roles` table created in Migration N+1. The legacy `clients.client_user_id` column remains in use for RLS policies on client portal data (a client portal user's auth.uid() lookup to find their client_id row) but is no longer the source of truth for role determination at login. Migration N+2 (`seed_user_roles_from_auth_users.sql`) ensures every existing auth.users row has a corresponding user_roles row before this new flow activates.

Contract 8 (Middleware Auth Passthrough Only) remains in force. Middleware does not perform the role lookup — the role lookup happens in the login route handler and any subsequent role-gated route handler. Middleware continues to only validate the Bearer token and set the x-user-id header.
3. RLS policies enforce tenant isolation at database layer

### Migration Note
- **REMOVED**: `/portal/login` route (unified login replaces dual-login pattern)
- **Applied**: 2026-05-15 commit 498460c

---

## 7. SURFACE 3: OPERATOR COMMAND CENTER

### URL
tarritrix.com/dashboard

### Layout â€” 4 Zones

**Zone 1: Top Stat Strip (full width, 6 cards)**
1. Active Clients â€” count + tier breakdown sparkline
2. Pages Published Today â€” vs daily allowance, color-coded
3. LLM Cost Today â€” across all clients vs caps, traffic light
4. Monthly Recurring Revenue â€” Stripe + delta vs last month
5. Pending Operator Actions â€” flagged pages, DSAR deadlines, GBP alerts
6. Active Alerts â€” P0/P1 count, expandable

**Zone 2: Left Column 60% â€” Real-time Activity Feed**
- Polls `agent_events` every 30 seconds
- Each row: timestamp, agent name, client name, event type, cost (if LLM)
- Filter chips: agent, client, event type, severity
- Color-coded by severity
- Infinite scroll

**Zone 3: Right Column 40% â€” 3 Stacked Panels**

*Next Best Actions Panel:*
- Powered by Recommendations Engine
- Each item: priority badge, description, action button
- Examples:
  - "Acme HVAC has 12 pages flagged 3+ days. Review now."
  - "Bob Roofing LLM cost spiked 340% this week. Investigate."
  - "Joe Plumbing drip phase advances tomorrow (15->25 pages/day)."
  - "GBP API approval received. Enable A-12 for 3 eligible clients."

*Tenant Health Panel:*
- Top 5 clients by composite health score
- Score = weighted avg of: LLM cost adherence, page quality avg, indexation rate, GBP completeness
- Trend arrow per client
- Drill-down button -> client detail

*Advisory Signals Panel:*
- Severity-tagged warnings from `tenant_signals` table
- Auto-dismissible by operator
- Examples:
  - WARNING: Client X drive time exceeded 90min for 2 cities
  - WARNING: Client Y has 7 photos uploaded (10+ required for Growth)
  - INFO: Stripe payment failed for Client Z, retry scheduled

**Zone 4: Bottom Row â€” 2 Charts**
1. Publishing velocity chart (last 30 days, all clients stacked)
2. LLM cost vs cap chart (last 30 days, all clients)

### Sidebar Nav (visibility is role-conditional per ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 9.3)
- Command Center (active) — visible to: master_admin, senior_admin, va
- Clients — visible to: master_admin, senior_admin, va
- Pages (cross-tenant browser) — visible to: master_admin, senior_admin, va
- Agents (status of all 15 + 3 crons + manual trigger; trigger buttons gated per permission matrix) — visible to: master_admin, senior_admin, va
- Compliance (DSARs, TCPA records, sub-processors) — visible to: master_admin, senior_admin (hidden from va)
- Billing (Stripe revenue, invoices) — visible to: master_admin, senior_admin (hidden from va)
- Audit Log (user_actions across platform, filterable) — visible to: master_admin, senior_admin (hidden from va; va sees only own session log via /dashboard/profile)
- Users (role grants, revocations, user list) — visible to: master_admin only (hidden entirely from senior_admin and va)
- Storm Intelligence (Phase 3 placeholder, locked icon) — visible to: master_admin, senior_admin, va
- Settings — visible to: master_admin, senior_admin, va (settings scope per role)
- Logout — visible to all roles

### Header
- Page title (e.g., "Command Center")
- User avatar + email
- Role badge with role-specific styling:
  - master_admin: red background (#DC2626) with white text "Master Admin"
  - senior_admin: blue background (#2563EB) with white text "Senior Admin"
  - va: gray background (#475569) with white text "VA"
- Role badge tooltip on hover: brief summary of the role's action scope per ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 3
- Notifications bell (count of unread alerts) — VAs see only alerts within VA action scope (P3 signals, evidence-related events); master_admin and senior_admin see all alerts

### Role-Aware Rendering Rules

The 4-zone layout (Zones 1–4 above) renders for all three operator-side roles. Conditional rendering applies to specific affordances within each zone per the canonical permission matrix (ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 3). Contract 71 enforces that every protected action call invokes `hasPermission(role, action)` from `src/lib/auth/role-context.ts` before executing.

**Zone 1 (Top Stat Strip, 6 cards):**
All three roles see all six cards as read-only displays. No conditional rendering applies — KPI visibility is universal.

**Zone 2 (Real-time Activity Feed):**
All three roles see the feed. Filter chips are universal. No conditional rendering applies.

**Zone 3 Panels:**
- **Next Best Actions Panel:** VAs see only items where the recommended action is within VA permission scope. Items requiring master_admin or senior_admin authority are filtered out for VAs so the panel does not create expectations the role cannot fulfill. Master_admin and senior_admin see the full panel.
- **Tenant Health Panel:** All roles see the full panel. Drill-down navigation respects the permission matrix.
- **Advisory Signals Panel:** All roles see the panel. Dismiss button availability is role-gated:
  - VAs can dismiss only P3 (informational) signals
  - Senior_admin can dismiss P0, P1, P2, P3 signals (P0 dismissals require justification referencing resolution commit hash or migration ID and are flagged for master_admin review within 24 hours)
  - Master_admin can dismiss all signal severities

**Zone 4 (Bottom Row Charts):**
All three roles see the charts. No conditional rendering applies.

**Action Button Rendering Convention:**
- *Hide entirely* — actions the role concept does not include (e.g., role management UI invisible to non-master_admin)
- *Disable with tooltip* — actions the role might expect but lacks permission for (e.g., VA sees a disabled "Approve flagged page" button with tooltip "Requires senior_admin role")

Rationale: disable-with-tooltip for affordances the role might expect to use (preserving discoverability and escalation awareness), hide-entirely for surfaces the role should not need to know exist (preserving cognitive simplicity for that role's typical workflow).

---

## 8. SURFACE 4: CLIENT MANAGEMENT

### Route Inventory (5 routes built, 0 dedicated API routes)
| Route | Purpose | API Pattern | Status |
|-------|---------|-------------|--------|
| /dashboard/clients | Sortable client list, tier/status filters | Supabase direct query | ✅ Built |
| /dashboard/clients/new | 8-step onboarding wizard | Supabase mutations per step | 🟡 Stub only |
| /dashboard/clients/[id] | Tabbed detail: Overview, Pages, Profile Data, Activity, Billing, Integrations | Supabase direct + reusable dashboard APIs | ✅ Built |
| /dashboard/clients/[id]/flagged | Flagged pages queue with override controls | Query: page_quality_scores WHERE flagged = true | ✅ Built |
| /dashboard/clients/[id]/pages/[pageId] | Single page detail with 15-gate quality scores | Query: pages + page_quality_scores + page_content_profile | ✅ Built |

**Note**: Client management routes use Supabase client directly (server components). No `/api/dashboard/clients/*` routes exist. Shared dashboard APIs at `/api/dashboard/{stats,charts,activity-feed,signals}` serve Command Center and client detail views.

### Client List (/dashboard/clients) — Built
**Table Columns:**
- Business name (clickable to detail)
- Tier badge (Starter/Growth/Authority)
- Status (active, onboarding, suspended, churned)
- Pages live / tier max
- LLM cost today (traffic light: green <$3, yellow $3-4.50, red >$4.50)
- Last activity timestamp
- Actions: View Detail, Suspend, Flag

**Filters:**
- Tier dropdown (All, Starter, Growth, Authority)
- Status dropdown (All, Active, Onboarding, Suspended)
- Search by business name

### Client Detail Tabs (/dashboard/clients/[id]) — Built

**Tab 1: Overview**
- Business info card (name, tier, status, operator assigned)
- 6-stat grid: pages live, conversions 30d, LLM cost today, next invoice, tier limits remaining
- Tenant health score (0-100 composite: cost adherence, quality avg, indexation rate, GBP completeness)
- Recent activity feed (last 15 agent_events)
- Next Best Actions panel (tenant_signals filtered to this client)

**Tab 2: Pages**
- Paginated table: slug, status, quality score, indexation status, last updated
- Bulk actions: Approve flagged, Force publish, Regenerate batch
- Filter by status, service, city
- Export to CSV

**Tab 3: Profile Data**
- Business address, phone, email
- Cities × Services matrix (editable)
- Service area map (deferred to Phase 1.5 geo-grid)
- Evidence inventory: photos count, case studies, claimed facts, certifications

**Tab 4: Activity**
- Full agent_events log for this client (filterable by agent, event type, date range)
- Cost attribution per event (LLM calls only)
- Export to CSV for billing reconciliation

**Tab 5: Billing**
- Subscription tier, status, next billing date
- Invoice history (Stripe webhook sync)
- Payment method on file
- Manual invoice generation link (Stripe dashboard)
- Tier upgrade/downgrade action (triggers Stripe subscription update)

**Tab 6: Integrations**
- ServiceTitan, Jobber, HousecallPro, FieldRoutes, Zapier webhook status
- Last sync timestamp, error log
- Reconnect OAuth flow links
- Manual lead CSV upload (fallback integration)

**Tab 7: Knowledge Base (NEW — Phase 1)**
A-44 Client Knowledge Ingestion Engine management surface for this client. Visible to all three operator-side roles; action availability gated per permission matrix.

*Current Version Section:*
- Version number and date of current `client_ingestion_versions` row
- Source URL crawled, scrape duration, asset count by type (logos, badges, certifications, testimonials, photos)
- Brand voice summary (tone of voice, voice descriptors)
- NAP data captured (verified vs. intake form)
- Keyword gap summary

*Version History Section:*
- Reverse-chronological table of all prior `client_ingestion_versions` rows
- Per row: version number, trigger type (onboarding / manual / quarterly_cron / signal_detected), status, diff severity, approved_by, approval timestamp
- Click row to expand and view diff_summary JSONB rendered as readable field-by-field deltas

*Pending Diff Approval Panel (only renders when diff_severity = 'material' or 'breaking' awaiting approval):*
- Side-by-side comparison of current version vs. proposed new version per critical field (logo, NAP, license, certifications, manufacturer badges)
- "Approve" button — visible to master_admin and senior_admin; promotes proposed version to is_current=TRUE
- "Reject" button — visible to master_admin and senior_admin; marks proposed version as rejected, preserves as historical row
- Required justification field on either action

*Force Re-scrape Section:*
- "Force Re-scrape" button visible to master_admin and senior_admin (VAs see disabled with tooltip "Requires senior_admin role")
- Required justification field (examples: "Client relaunched site," "New certifications announced," "NAP data correction")
- Triggers A-44 immediately, bypasses quarterly schedule, resets next_ingestion_scheduled_at after completion

*Manual Asset Provision Section (master_admin only):*
- "Manual Asset Provision" button visible to master_admin only (Contract 73 override path)
- Form for uploading brand voice descriptors, logo files, certification badges, NAP data manually when client website is unscrapable
- Required justification field
- Creates client_ingestion_versions row with approval_status='manually_provided', is_current=TRUE
- Logs action_type='override_a44_prerequisite' to user_actions per Contract 72

*Block A-44 Section (master_admin only):*
- Toggle visible to master_admin only
- Sets clients.ingestion_blocked = TRUE with required reason (e.g., "Client requested no automated crawls")
- When blocked, quarterly CRON skips this client
- Unblock requires master_admin action with justification

**Data sources:**
- client_ingestion_versions (all queries)
- client_ingested_assets (current version's assets)
- client_brand_voice_model (current version's voice model)
- client_keyword_gap_analysis (current version's keyword gaps)
- clients.ingestion_blocked, clients.current_ingestion_version_id, clients.last_ingestion_at, clients.next_ingestion_scheduled_at

### Flagged Pages Queue (/dashboard/clients/[id]/flagged) — Built (RBAC updates pending)
**Purpose:** Review queue for pages flagged by A-05 Gate 15 custom rules or low quality scores. Visible to all three operator-side roles; review actions gated per permission matrix.

**Table Columns:**
- Page slug
- Flagged reason (quality gate failure description)
- Quality score (0-100)
- Flagged timestamp
- Assigned reviewer (name and role badge if `pages.assigned_reviewer_id` is set and lease has not expired)
- Lease expiration (timestamp when 30-minute assignment lease ends; empty if unassigned)
- Actions per row (rendered conditionally per current user's role):
  - Claim (visible if unassigned or current user already holds the lease) — sets assigned_reviewer fields with 30-minute lease
  - Release (visible if current user holds the lease) — clears assigned_reviewer fields
  - Approve (visible to master_admin and senior_admin; disabled for va with tooltip “Requires senior_admin”)
  - Reject and regenerate (visible to master_admin and senior_admin; disabled for va)
  - Add comment / note (visible to all roles including va — note-taking is not a decision)
  - Force reassign (visible to master_admin only, dropdown to reassign existing claim)
  - Delete page (visible to master_admin and senior_admin; soft-delete only — hard delete is master_admin-only per permission matrix)

**Action Logging (Contract 72 — three-attribute audit attribution):**
- Approve button → sets page.status = 'queued' (bypasses flag); logs to user_actions with acting_user_id, acting_user_role, client_id, action_type='approve_flagged_page', justification, result
- Reject button → logs to user_actions with action_type='reject_flagged_page' and adds row to page_generation_queue with retry_count++
- Comment action → logs to user_actions with action_type='add_flagged_page_comment'
- Force reassign → logs to user_actions with action_type='force_reassign_flagged_page_reviewer'
- All actions require justification field per the action's classification (override actions strictly required, comment actions optional)

**Lease semantics:**
- 30-minute soft-lock from `pages.assigned_reviewer_at`
- Lease auto-expires after 30 minutes; expired leases revert page to unassigned
- Same reviewer can re-claim by clicking Claim again (resets the 30-minute lease)
- VAs can claim flagged pages for visibility and note preparation but cannot perform approve/reject (still gated by permission matrix at the action level — claim does not grant approval authority)

**Migration note:** This section updates the spec for the existing /dashboard/clients/[id]/flagged route. The route is already built (commit 803b3a9) but does not yet implement reviewer assignment columns or role-gated action availability. The Phase 1 RBAC build (per Section 23 below as updated by Change 11) implements these additions.

### Single Page Detail (/dashboard/clients/[id]/pages/[pageId]) — Built
**15-Gate Quality Scores Display:**
<!-- Canonical gate labels locked 2026-05-20. Source of truth: TARRITRIX_ARCHITECTURE_2026-05-14.md Section 3 + BLUEPRINT.md A-05 PAGE VALIDATOR — 15 GATES (Canonical) section. -->
- Gate 1: Real-Data Binding (HARD — pass/fail + provenance count)
- Gate 2: Anti-Monotony Similarity (HARD — pass/fail + cosine similarity vs threshold 0.72)
- Gate 3: Brand Signature Conformance (score 0-100)
- Gate 4: Module Diversity (score 0-100 + module count)
- Gate 5: DMA Diversity (score 0-100 + DMA overlap %)
- Gate 6: Word Count Variance (score 0-100 + word count)
- Gate 7: Heading + Contact Card (G7a) (score 0-100 + h1 check + tel/form check)
- Gate 8: Internal Links (score 0-100 + link count)
- Gate 9: Image Provenance (score 0-100 + image source check)
- Gate 10: Storm Authenticity (HARD — pass/fail + storm event verification)
- Gate 11: Service Accuracy (score 0-100 + exact match check)
- Gate 12: Geographic Accuracy (score 0-100 + city/state presence)
- Gate 13: Compliance (HARD — pass/fail + TCPA links + schema prohibition check)
- Gate 14: Performance Baseline (score 0-100 + page weight calculation)
- Gate 15: Operator Custom Rules (score 0-100 + rules checked/failed)

**Overall Quality Score:** 0-100 weighted average of 15 gates (HARD gates 2x weight).

**Page Actions (rendered conditionally per current user's role per permission matrix):**
- Force publish (bypasses pending soft gates only — HARD gates G1, G2, G10, G13 remain non-overridable per Contract 9 regardless of role)
  - Visible to: master_admin, senior_admin
  - Disabled with tooltip "Requires senior_admin" for: va
- Request regeneration (adds to page_generation_queue with retry_count++)
  - Visible to: master_admin, senior_admin
  - Disabled for: va
- Soft-delete page (status = 'deleted', row preserved)
  - Visible to: master_admin, senior_admin
- Hard-delete page (DB row removal)
  - Visible to: master_admin only
- Add comment / note (no decision; informational)
  - Visible to: all roles including va
- View public URL (opens published page in new tab)
  - Visible to: all roles
- Force-publish override against HARD gate (constitutional)
  - Visible to: no role (HARD gates per Contract 9 are non-overridable)
  - Attempts to do so via API return 403 with error code 'HARD_GATE_OVERRIDE_FORBIDDEN'

**Action Logging (Contract 72):** All override actions (force-publish, soft-delete, hard-delete) require justification field and log to user_actions with three-attribute attribution.

### 9-Step Onboarding Wizard (/dashboard/clients/new) — STUB ONLY (Phase 1 build pending)
**Current State:** Basic scaffold with step navigation, no actual form fields or mutations. Stub does not yet include Step 9.

**Phase 1 Specification (not yet built):**

Operator-driven steps (8 manual steps requiring master_admin or senior_admin):
1. Business Information (name, address, phone, email, industry)
2. Service Area (state, counties, zip codes, business website URL — captured here for use by Step 9)
3. Cities × Services Selection (matrix UI, tier limit enforcement)
4. Evidence Upload (photos, case studies, certifications via R2 presigned upload)
5. Consent Collection (TCPA checkbox, ToS acceptance, DPA signature, GBP auth, call tracking consent)
6. Google Authorization (OAuth flow for GBP + GCS, per-client GCP project setup)
7. Payment & Signature (Stripe checkout session + DocuSign envelope for service agreement)
8. Integration Setup (ServiceTitan/Jobber/etc OAuth or webhook config)

Platform-executed step (1 automatic step, no operator input required):
9. Knowledge Ingestion (Automatic): Platform triggers A-44 Client Knowledge Ingestion Engine using the website URL captured in Step 2. A-44 crawls the client's website, extracts brand voice, manufacturer badges, certifications, NAP data, and asset library. Creates client_ingestion_versions row with trigger_type='onboarding', approval_status='auto_approved', is_current=TRUE. See BLUEPRINT.md Section 4.1 Step 9 and Part 10.5 for full A-44 specification.

**Permission gating:**
- All 8 operator-driven steps require master_admin or senior_admin role (per ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 3.1 "create_client" and "complete_onboarding" actions)
- VAs cannot initiate or complete the wizard
- Step 9 is platform-executed and does not require human action

**Exit Criteria:**
- Steps 1–8 complete: clients.status transitions from null/draft to 'onboarding'
- Step 7 (Payment) success: clients.status transitions to 'active'
- Step 9 (A-44) success: client_ingestion_versions row with is_current=TRUE exists; clients.current_ingestion_version_id populated; Contract 73 satisfied; A-02 unblocked
- Step 9 failure: clients.status remains 'active' but A-02 remains blocked; P2 advisory signal raised; master_admin or senior_admin must retry A-44 or apply manual asset provision override per Contract 73

**Step 9 failure recovery paths:**
1. Operator opens Tab 7 Knowledge Base on /dashboard/clients/[id] and clicks Force Re-scrape (master_admin or senior_admin)
2. Operator applies Manual Asset Provision override (master_admin only)
3. Operator blocks A-44 for the client via Tab 7 Block A-44 toggle (master_admin only, requires reason)

In all three recovery paths, the action is logged to user_actions per Contract 72.

### Implementation Status
- ✅ Client list route (commit 803b3a9)
- ✅ Client detail with 6 tabs (commit 803b3a9)
- ✅ Flagged pages queue (commit 803b3a9)
- ✅ Single page detail with quality gates (commit 803b3a9)
- 🟡 8-step wizard scaffold only (full implementation pending)
- ✅ E4 Construction demo client seeded (client_id: test-client-e4)

---

## 9. SURFACE 5: CLIENT PORTAL LOGIN — DEPRECATED

### Status
**REMOVED** in commit 498460c (2026-05-15). Replaced by unified `/login` with role-based routing.

### Reason
Dual-login UX created confusion. Single /login endpoint now routes to /portal or /dashboard based on `clients.client_user_id` lookup.

### Migration Path
- All client authentication now flows through `/login` (Surface 2)
- RLS policies enforce client data isolation via `client_user_id = auth.uid()` pattern
- See Section 6 for unified login implementation details

---

## 10. SURFACE 6: CLIENT PORTAL

### Base URL
tarritrix.com/portal

### Sidebar Nav (PortalSidebar.tsx)
- Overview (active default)
- My Pages (page inventory with indexation status)
- Activity (90-day narrative feed)
- Leads (TCPA-compliant, phone last 4 digits only)
- Billing (invoices, subscription status)
- Account (business profile, integration settings)
- Logout

### Route Inventory (6 routes, 6 API endpoints)
| Route | API Endpoint | Purpose | RLS Tables |
|-------|--------------|---------|------------|
| /portal | /api/portal/overview | Dashboard overview with 8-card stat strip | clients, pages, conversions, signal_leads, llm_calls |
| /portal/pages | /api/portal/pages | Page inventory with status, service, city, indexation | pages, services, cities, indexation_records |
| /portal/activity | /api/portal/activity | 90-day agent event narrative feed | agent_events |
| /portal/leads | /api/portal/leads | Conversion log (TCPA-masked phone) | conversions, pages |
| /portal/billing | /api/portal/billing | Invoices + subscription status | clients, invoices, subscriptions |
| /portal/account | /api/portal/account | Business profile + integration config | clients, services, cities, client_integrations |

### Overview Content (Built - commit 803b3a9)

**8-Card Stat Strip:**
1. Pages Live (count + tier max)
2. Total Conversions (lifetime)
3. Conversion Rate (conversions / pages)
4. Calls This Month (conversion_type = 'call')
5. Forms This Month (conversion_type = 'form')
6. Storm Leads (signal_leads count)
7. LLM Spend (cost transparency, daily aggregated)
8. Avg Response Time (placeholder for Phase 2)

**Conversion Funnel Section:**
- Visual funnel: Traffic → Engagement → Leads
- Placeholder for Phase 1.5 GA4 integration

**30-Day Performance Chart:**
- Recharts area chart
- Daily aggregated: page views, conversions, calls
- Data source: page_metrics table (Phase B Section 3)

**Storm Intelligence Engine Section:**
- 2×2 grid of storm event thumbnails (hail swath overlays)
- Placeholder imagery pending A-01 Storm Capture operational
- Links to future storm detail modal (Phase 3)

**Recent Activity Feed:**
- Last 10 agent events via activity-formatter.ts
- Human-readable narratives: "Published [page]", "Delivered 3 storm leads from [location]"
- Category color coding: blue (page_work), emerald (quality), orange (storm), purple (marketing), gray (reporting)
- Links to /portal/activity for full 90-day feed

### Pages Route (/portal/pages)
**Table Columns:**
- Page slug (clickable to public URL)
- Service name
- City name  
- Status badge (published, pending, evidence_locked)
- Indexation status (indexed, pending, not_found)
- Last updated timestamp

**Data Sources:**
- Query: pages + services + cities + indexation_records (4-way join with explicit FK hints)
- RLS: client_user_id filter via clients table lookup

### Activity Route (/portal/activity)
**Layout:**
- Day-grouped feed (e.g., "Wednesday, May 15, 2026 — 12 events")
- Each event card: icon, headline, detail text, timestamp
- Category-based color coding with transparency backgrounds
- No raw agent codes (A-02 → "Published new page")

**Formatter:**
- src/lib/portal/activity-formatter.ts (8KB)
- 20+ event type mappings (page_generation, batch_completion, quality validation, review request, etc.)
- Metadata extraction: page titles, counts, customer names, ratings

### Leads Route (/portal/leads)
**TCPA Compliance:**
- Phone numbers: last 4 digits only (contact_phone_last_four column)
- Full email visible (client owns the lead)
- Name, conversion type, page slug, timestamp
- No PII beyond what TCPA permits for lead delivery

**Table Columns:**
- Created date
- Name
- Email
- Phone (last 4)
- Type (call, form, chat)
- Source page

### Billing Route (/portal/billing)
- Current subscription tier badge
- Next invoice preview (amount, date)
- Invoice history table (Stripe webhook sync)
- Payment method on file (masked card digits)

### Account Route (/portal/account)
- Business name, phone, email (read-only)
- Service area summary (cities × services)
- Integration status badges (ServiceTitan, Jobber, etc.)
- Change password link

### Implementation Status
- ✅ All 6 routes built (commit 803b3a9)
- ✅ All 6 API endpoints built with RLS (commit 29da4a4)
- ✅ Activity formatter with 20+ event mappings (commit db1d823)
- ✅ E4 Construction demo seed (240 pages, 614 events, 340 conversions)
- ✅ Production verified: all routes render real data

---

## 10A. API ROUTE INVENTORY (2026-05-15 SESSION)

### Portal API Routes (6 endpoints)
| Endpoint | Method | Auth | Purpose | Key Tables | RLS Pattern |
|----------|--------|------|---------|------------|-------------|
| /api/portal/overview | GET | client | 8-card stat strip + charts + activity feed | clients, pages, conversions, signal_leads, llm_calls, agent_events | client_user_id = auth.uid() |
| /api/portal/pages | GET | client | Page inventory with indexation status | pages, services, cities, indexation_records | client_id IN (SELECT id FROM clients WHERE client_user_id = auth.uid()) |
| /api/portal/activity | GET | client | 90-day narrative agent event feed | agent_events | client_id IN (SELECT id FROM clients WHERE client_user_id = auth.uid()) |
| /api/portal/leads | GET | client | TCPA-compliant conversion log | conversions, pages | client_id IN (SELECT id FROM clients WHERE client_user_id = auth.uid()) |
| /api/portal/billing | GET | client | Invoices + subscription status | clients, invoices, subscriptions | client_user_id = auth.uid() |
| /api/portal/account | GET | client | Business profile + integration config | clients, services, cities, client_integrations | client_user_id = auth.uid() |

**Authentication:** All routes verify `auth.uid()` via Supabase Auth before query. RLS policies enforce tenant isolation at database layer (defense in depth).

**Column Dependencies (Portal APIs):**
- pages: `id, slug, status, service_id, city_id, created_at, updated_at`
- services: `id, name`
- cities: `id, name`
- indexation_records: `page_id, indexation_status, last_check_at`
- agent_events: `id, agent, event_type, status, metadata, created_at`
- conversions: `id, conversion_type, contact_name, contact_email, contact_phone_last_four, page_id, created_at`
- signal_leads: `id, created_at` (count only)
- llm_calls: `cost_usd` (aggregated)

**Special Handling:**
- `/api/portal/leads`: Uses explicit FK hint `pages!page_id(slug)` to resolve ambiguous relationship (conversions has 3 FK to pages)
- `/api/portal/activity`: Pipes events through `activity-formatter.ts` for human-readable narrative translation

### Dashboard API Routes (5 endpoints at root level)
| Endpoint | Method | Auth | Purpose | Key Tables | RLS Pattern |
|----------|--------|------|---------|------------|-------------|
| /api/dashboard/stats | GET | operator | 6-card stat strip for Command Center | clients, pages, llm_calls, subscriptions, tenant_signals | operator_id = auth.uid() |
| /api/dashboard/charts | GET | operator | 30-day time series: pages published, conversions, LLM cost | pages, conversions, llm_calls | operator_id = auth.uid() |
| /api/dashboard/activity-feed | GET | operator | Real-time agent event feed (polled 30s) | agent_events | operator_id = auth.uid() |
| /api/dashboard/signals | GET | operator | Next Best Actions from Recommendations Engine | tenant_signals | operator_id = auth.uid() |
| /api/dashboard/signals/[id]/dismiss | POST | operator | Dismiss advisory signal | tenant_signals | operator_id = auth.uid() |

**Authentication:** All routes verify `auth.uid()` maps to valid operator before query. RLS policies enforce operator sees only own clients.

**Note:** No `/api/dashboard/clients/*` routes exist. Client management routes (`/dashboard/clients/[id]`) use Supabase client directly in server components.

---

## 11. RECOMMENDATIONS ENGINE

### Purpose
Distinct module that examines client state every 5 minutes and produces actionable Next Best Actions for the operator.

### Architecture
- Edge Function: `recommendations-engine`
- Triggered: pg_cron every 5 minutes
- Reads: clients, pages, page_quality_scores, llm_calls, conversions, gbp_profiles, agent_events
- Writes: tenant_signals (with priority, type, message, recommended_action, target_url, dismissed)

### Recommendation Categories
1. **Quality issues** â€” flagged pages aging, low quality scores
2. **Cost anomalies** â€” LLM spend spikes, cap proximity
3. **Lifecycle events** â€” drip phase transitions, refresh cycles due
4. **Compliance** â€” DSAR deadlines approaching, TCPA gaps
5. **Integration** â€” webhook failures, sync gaps
6. **Onboarding** â€” incomplete steps, validation failures
7. **Performance** â€” pages with conversion_rate_30d < 0.5% (Phase B Section 4), pages with 0 impressions 30+ days, indexation issues
8. **Billing** â€” failed payments, expiring cards, upgrade opportunities

### Display
- Surfaced in Command Center "Next Best Actions" panel
- Sorted by priority (P0 -> P3)
- Each item: action button (executes recommended action or navigates to relevant page)

---

## 12. REAL-TIME POLLING

### Implementation
- Frontend polls dashboard endpoints every 30 seconds
- React Query with `refetchInterval: 30000`
- Loading state on first load only, silent refetch after
- WebSocket NOT used (per your decision â€” polling is sufficient)

### Endpoints Polled
- `/api/dashboard/stats` (Zone 1 stat strip)
- `/api/dashboard/activity-feed` (Zone 2 feed)
- `/api/dashboard/health` (Zone 3 tenant health)
- `/api/dashboard/signals` (Zone 3 advisory signals)
- `/api/dashboard/recommendations` (Zone 3 next best actions)

---

## 13. ADVISORY SIGNALS SYSTEM

### Purpose
Per-tenant warning system with severity tagging, dismissal state, and recommended actions.

### Storage
`tenant_signals` table (added in Migration 002)

### Generation Sources
- A-01 validation results -> onboarding signals
- A-05 quality gate failures -> quality signals
- A-09 webhook failures -> integration signals
- LLM cost guard -> cost signals
- Stripe webhooks -> billing signals
- Recommendations engine -> derived signals

### Severity Levels
- P0: blocks operations (cross-tenant leak, payment failure)
- P1: requires immediate attention (DSAR deadline, GBP suspension risk)
- P2: should be addressed soon (drive time exceeded, low photo count)
- P3: informational (drip phase advancing, refresh cycle due)

---

## 14. TENANT HEALTH SCORING

### Composite Score (0-100)
- LLM Cost Adherence (25%): cost_today / daily_cap, inverted
- Page Quality Average (25%): avg overall_quality_score across all client pages
- Indexation Rate (25%): pct of published pages with indexation_status = 'indexed'
- GBP Completeness (25%): from gbp_profiles.completeness_score (Phase 1.5+)

### Calculation
- Computed on-demand by `/api/clients/[id]/health` endpoint
- Cached 5 minutes per client
- Displayed in Command Center Tenant Health Panel + Client Detail Overview

---

## 15. STRIPE PRODUCTS â€” TIER METADATA

### Tier Structure
Pricing remains unchanged. Page counts, city/service combinations updated per Phase B Section 1.

| Tier | market activation fee | Monthly | Cities | Services | Max Pages | Drip Rates (Days 1-30 / 31-60 / 61+) |
|------|-----------|---------|--------|----------|-----------|--------------------------------------|
| Starter | $997 | $497 | 10 | 3 | 30 | 3/day â†’ 5/day â†’ 7/day |
| Growth | $2,497 | $997 | 20 | 5 | 100 | 5/day â†’ 8/day â†’ 12/day |
| Authority | $4,997 | $1,997 | 35 | 6 | 210 | 6/day â†’ 11/day â†’ 16/day |

±20% variance per Contract 15 applies to all drip rates.

### Action Required
1. List existing Stripe products via API
2. Update product metadata to reflect new tier limits (cities, services, max_pages)
3. Verify pricing amounts unchanged
4. Update env vars: STRIPE_PRODUCT_ID_STARTER, STRIPE_PRODUCT_ID_GROWTH, STRIPE_PRODUCT_ID_AUTHORITY
5. Update Vercel env vars to match

---

## 16. GOOGLE CALENDAR API INTEGRATION

### Purpose
Marketing demo form creates events in operator's Google Calendar.

### Implementation
- OAuth scopes: `calendar.events`
- Service account or operator OAuth token (decision: operator OAuth, refresh token stored encrypted)
- Endpoint: `/api/marketing/demo-request`
- Flow: form submit -> create calendar event -> store demo_requests row -> send confirmation email via Resend

### Required ENV
- GOOGLE_OAUTH_CLIENT_ID (already set)
- GOOGLE_OAUTH_CLIENT_SECRET (already set)
- GOOGLE_CALENDAR_OPERATOR_REFRESH_TOKEN (NEW â€” obtained via one-time auth flow)
- GOOGLE_CALENDAR_OPERATOR_EMAIL (NEW)

---

## 17. GBP API APPLICATION

### Status
NOT YET SUBMITTED. Application copy provided in separate deliverable.

### Process
1. Operator submits application at https://developers.google.com/my-business/content/prereqs
2. Approval timeline: 4-8 weeks
3. Until approved: A-12 GBP Agent stays disabled (platform_config.enabled = false)
4. Phase 1.5 begins immediately upon approval

---

## 18. ANTI-FAILURE PROTECTIONS â€” INSTALLED BEFORE NEW CODE

1. Pre-commit hook (Husky) running `pnpm verify`
2. Schema drift detector script (`scripts/verify-schema.ts`)
3. Environment variable validator (boots app, fails fast on missing vars)
4. Tenant isolation Playwright suite (mandatory pass before deploy)
5. LLM cost guard middleware (wraps all Anthropic calls)
6. Hallucination prevention header (mandatory in every Claude Code prompt)
7. Drift watchdog Playwright suite (smoke tests all 6 surfaces every commit)
8. PostHog production logging (already in stack, must be wired)
9. Sentry error tracking (NEW install)
10. Real-time deploy verification (post-deploy URL hits)

---

## 19. THE SIX LAWS â€” UNCHANGED

A feature is complete only when all six pass:
1. SCHEMA â€” table exists, RLS confirmed, client_id applied
2. API â€” route exists, authenticated, client_id from session
3. UI â€” real UI with real data, zero placeholders
4. DATA â€” real API calls, zero mocks in production code
5. WIRING â€” navigation linked, roles correct, all buttons persist
6. VERIFICATION â€” human confirmed working in live browser

---

## 20. PHASE 1 EXIT CRITERIA

- [ ] Marketing site live at tarritrix.com, Lighthouse >90
- [ ] Operator login + command center fully functional
- [ ] Client portal login + overview functional
- [ ] All 14 agents built, tested, passing
- [ ] CRON-01 + CRON-02 scheduled and verified over 3+ days
- [ ] 8-step wizard fully functional with real Stripe + DocuSign
- [ ] Recommendations engine producing real Next Best Actions
- [ ] Real-time polling functional on command center
- [ ] Advisory signals generating across all source events
- [ ] Tenant health scoring computed for all clients
- [ ] Stripe products corrected at $497/$997/$1997
- [ ] GBP API application submitted
- [ ] At least 1 active paying client onboarded through all 8 steps
- [ ] Zero pages with cosine similarity >0.72 in production
- [ ] LLM cost cap enforced â€” no client exceeds $5/day
- [ ] Tenant isolation tests passing 100%
- [ ] All Playwright tests passing
- [ ] All vitest tests passing
- [ ] Sentry capturing errors
- [ ] PostHog tracking events
- [ ] Per-page analytics dashboards functional (Phase B Section 3)
- [ ] GitHub milestone tag: v1.0-phase1-complete

**Phase 2/3 Commencement Criteria:**

Phase 2 commences when (a) Phase 1 exit criteria per MASTER_BUILD_SPEC.md Section 20 are satisfied, AND (b) operator explicitly authorizes Phase 2 advancement. No client count, revenue threshold, or time gate. Operator-driven.

Phase 3 commences when (a) Phase 2 exit criteria are satisfied, AND (b) operator explicitly authorizes Phase 3 advancement. No client count, revenue threshold, or time gate. Operator-driven.

---

## 21. PER-PAGE ANALYTICS + DASHBOARDS (PHASE B SECTION 3)

### Purpose
Track per-page performance via PostHog integration. Edge Function rolls PostHog events into page_metrics table every 5 minutes. Enables performance-aware content refresh prioritization (A-11) and client-visible ROI tracking.

### Components

**PostHog Integration:**
- PostHog tracking code on every published page
- Page view events fire on load
- Conversion events fire on form submit / call tracking webhook
- Events include page_id, client_id, session_id

**page_metrics Rollup Table:**
Per-page aggregated metrics (table 54 in SCHEMA_REGISTRY.md):
- Views: total, 30d, 7d, 24h windows
- Conversions: total, 30d, 7d, 24h windows
- Conversion rates: lifetime and 30d trailing
- Performance tier: high / median / low (computed by rollup)
- Last activity timestamps: last_view_at, last_conversion_at

**Edge Function: page-metrics-rollup**
- Triggered: pg_cron every 5 minutes
- Reads: PostHog API for events since last run
- Writes: Upserts page_metrics rows per page_id
- Computes: conversion_rate, performance_tier classification
- Cleanup: Prunes PostHog events older than 90 days

**Operator Dashboard Integration:**
- New tab in Surface 4 (Client Management â†’ Client Detail): "Pages Analytics"
- Table view: page URL, views 30d, conversions 30d, conversion rate, performance tier badge
- Sortable by any metric
- Filter by performance tier
- Export to CSV

**Client Portal Integration:**
- Enhanced Surface 6 (Client Portal â†’ My Pages)
- Existing page list gains new columns: views 30d, conversions 30d, conversion rate
- Color-coded performance badges (green = high, yellow = median, red = low)
- RLS-filtered to client's pages only

**Real-Time Polling:**
- Dashboard polls `/api/clients/[id]/page-metrics` every 30 seconds
- Consistent with existing Command Center polling architecture
- Silent refetch (no loading spinner after initial load)

### A-11 Integration (Performance-Aware Refresh)
See Section 4 (Performance Feedback Loop). A-11 Content Refresh Engine uses page_metrics.conversion_rate_30d as primary input. Pages with conversion_rate_30d < 0.5% get refreshed first. Pages above median performance left alone.

### Phase 1 Exit Criteria Addition
- [ ] PostHog tracking code deployed on all published pages
- [ ] page-metrics-rollup edge function deployed and verified over 3+ runs
- [ ] Operator Pages Analytics tab functional with real data
- [ ] Client portal My Pages shows metrics (RLS-verified)

---

## 22. GEO-GRID VISUALIZATION LAYERS 1A + 1B (PHASE B SECTION 5)

### Purpose
Side-by-side geographic heatmaps showing evidence density (Layer 1a) and page performance (Layer 1b) across service area. Operator and client dashboards gain visual geographic insight. Layer 2 (Google rank tracking) deferred to Phase 1.5.

### Layer 1a â€” Evidence Density Geo-Grid
Color-coded grid showing EXIF-verified job photos per geographic cell (5km × 5km or county-level, TBD at implementation).

**Data Source:**
- service_area_heatmaps table (already exists, extended with photo_count per cell)
- EXIF data from job_evidence table (Phase B Section 6)
- Photos with GPS coordinates mapped to grid cells

**Visual Encoding:**
- Green pins: many photos (high evidence density)
- Yellow pins: few photos (moderate evidence density)
- Red pins: no photos (evidence gap)
- Click pin â†’ modal showing actual photos with timestamps and GPS

**Powered by:**
- React component: src/components/dashboard/GeoGridMap.tsx (reusable)
- API endpoint: /api/clients/[id]/geo-grid-evidence
- Map library: react-simple-maps or Mapbox GL JS

### Layer 1b â€” Page Performance Geo-Grid
Color-coded grid showing Tarritrix-generated pages per cell with performance overlay.

**Data Source:**
- service_area_heatmaps table (extended with page_id per cell)
- page_metrics table (Phase B Section 3)

**Visual Encoding:**
- Green pins: high-converting pages (conversion_rate_30d > median)
- Yellow pins: published pages with low engagement (conversion_rate_30d < median)
- Red pins: locked or no page (evidence_locked status or no page generated yet)
- Click pin â†’ page status (live/queued/locked), views 30d, conversions, conversion_rate_30d

**Powered by:**
- Same React component as Layer 1a (toggle or split-view mode)
- API endpoint: /api/clients/[id]/geo-grid-performance

### Display Modes
**Side-by-side (desktop):**
- Layer 1a left panel, Layer 1b right panel
- Synchronized zoom and pan
- Toggle between layers or view both simultaneously

**Stacked (mobile):**
- Layer 1a above, Layer 1b below
- Independent scroll

### Visible In
1. **Operator Dashboard:** Client Detail new sub-tab "Geographic View"
2. **Client Portal:** My Pages new sub-tab "Geographic View" (RLS-filtered)
3. **Marketing Demo (Tier 2):** Prospects see partial preview during demo call (Personalized Demo Engine per Contract 31)

### Layer 2 â€” Google Rank Tracking (DEFERRED to Phase 1.5)
- Vendor LOCKED 2026-05-16: Decodo (formerly Smartproxy) SERP API
- Entry pricing: $30/month Core plan, $0.32/1k requests
- Mid-scale: $99-$499/month tiers, $0.20-$0.30/1k requests
- Volume floor: $0.08/1k requests at $3,999/month commitment
- Behind feature flag: platform_config.geo_grid_layer_2_rankings = false
- Cost pass-through as COGS or absorbed in margin (operator decides at Phase 1.5 entry)
- DIY scraper option permanently rejected per BLUEPRINT.md Phase 1.5 vendor decision

### Schema Extensions
No new tables. Extends existing service_area_heatmaps table:
- Add photo_count INT per cell (computed from job_evidence EXIF data)
- Add page_id UUID per cell (FK to pages table, nullable)
- Add performance_tier performance_tier per cell (mirrored from page_metrics)

Migration deferred to implementation phase (Prompt 9.5/9.6). Schema changes are additive, non-breaking.

### Phase 1 Exit Criteria Addition
- [ ] Geo-grid Layers 1a and 1b functional in Operator dashboard
- [ ] Geo-grid Layers 1a and 1b functional in Client portal (RLS-verified)
- [ ] Layer 2 feature flag confirmed disabled (geo_grid_layer_2_rankings = false)

---

## 23. PHASE 1 DASHBOARD BUILD SPEC (LOCKED 2026-05-16)

### Purpose
Lock the visual analytics surfaces that ship in Phase 1 versus what defers to later phases. Prevents scope creep and clarifies what canonical files do/do not authorize for the dashboard build.

### Build Order (Mandatory Sequence)
1. **Migration 006** — service_area_heatmaps extension columns (photo_count, page_id, performance_tier per cell). Schema-first per Six Laws.
2. **Client Portal premium KPI strip** (`/portal`) — replaces current 8-card placeholder with premium aesthetic
3. **Client Portal Geo-Grid Layer 1b view** — new sub-tab on `/portal/pages` showing page performance per service area cell
4. **Client Portal monthly growth timeline + lead performance panel** — Recharts line graph + sortable table
5. **Operator Command Center premium KPI strip** (`/dashboard` Zone 1) — replaces current 6-card placeholder
6. **Operator Zone 4 charts** — publishing velocity stacked bar + LLM cost vs cap line chart (already partly spec'd in BLUEPRINT.md 8.6)
7. **Operator Geo-Grid Layer 1b panel** — `/dashboard/clients/[id]` new "Geographic View" sub-tab

Client surfaces ship first per operator priority. Operator surfaces ship second using same components.

### Phase 1 Dashboard Scope — AUTHORIZED

**Client Portal `/portal` (Surface 6) — Premium KPI strip:**
- Pages Live (count + tier max)
- Indexed Pages (count + indexation rate %)
- Leads Generated (lifetime + 30d)
- Conversion Rate (conversions / pages, 30d)
- Calls This Month (conversion_type = 'call')
- Forms This Month (conversion_type = 'form')
- Storm Leads (signal_leads count)
- Active Markets (distinct cities count)

**Data sources (all verified existing tables):**
pages, conversions, signal_leads, indexation_records, cities, page_performance_daily

**Client Portal Geo-Grid Layer 1b:**
- React component: src/components/dashboard/GeoGridMap.tsx
- API endpoint: /api/portal/geo-grid-performance (RLS-filtered to client)
- Data sources: service_area_heatmaps (extended) + pages + page_performance_daily
- Visual encoding: green (high-converting), yellow (low engagement), red (locked/no page)
- Numbered pins showing performance index per cell (LocalFalcon-style visual; numbers represent Tarritrix Page Performance Index in Phase 1, swap to Google rank in Phase 1.5)
- Legend: "Page Performance Index by Service Area Cell" (honest framing pre-Layer-2)

**Client Portal Monthly Growth Timeline:**
- Recharts area chart, 90-day window
- Lines: pages published, indexed pages, conversions
- Data source: page_performance_daily + indexation_records aggregated by day

**Client Portal Lead Performance Panel:**
- Sortable table: created_at, name, email (masked), phone (last 4), source page, conversion type
- TCPA-compliant per Contract 14
- Data source: conversions, signal_leads

**Operator Command Center `/dashboard` (Surface 3) — Premium KPI strip:**
Already spec'd in BLUEPRINT.md 8.6. Phase 1 build delivers premium aesthetic upgrade:
- Active Clients (count + tier breakdown sparkline)
- Pages Published Today (vs daily allowance, traffic light)
- LLM Cost Today (vs aggregate cap, traffic light)
- Monthly Recurring Revenue (Stripe API)
- Pending Operator Actions (flagged + DSAR + GBP alerts count)
- Active Alerts (P0/P1 expandable)

**Operator Zone 4 Charts:**
Already spec'd in BLUEPRINT.md 8.6. Phase 1 build delivers actual rendering:
- Chart 1: Publishing Velocity stacked bar (30 days, per client stacked)
- Chart 2: LLM Cost vs Cap line chart (30 days, per client + aggregate cap line)

**Operator Geo-Grid Layer 1b panel:**
- Same React component as Client Portal (reused)
- API endpoint: /api/clients/[id]/geo-grid-performance
- Cross-tenant operator view, no RLS filter (operator role)

**Phase 1 RBAC and A-44 Dashboard Surfaces (NEW per 2026-05-23 synchronization):**

**Users Management Page (`/dashboard/users`) — master_admin only:**
- Lists all platform users (auth.users joined with user_roles) with current role, granted_at, last login, total action count, denied-attempt count
- Filterable by role, sortable by last login or action count
- "Grant Role" button opens modal for inviting new user or promoting existing user (master_admin can grant any role; senior_admin can grant only va role via a separate senior-accessible form on a different surface)
- "Revoke Role" button on each user row with required justification field
- Per-user drill-down to full user_actions log for that user
- Data sources: auth.users, user_roles, user_actions, role_grant_audit

**Audit Log Page (`/dashboard/audit`) — master_admin and senior_admin only:**
- Reverse-chronological table of user_actions across the entire platform
- Columns: timestamp, acting_user (name + email + role badge for the role they held at action time), client (if applicable), action_type, result (success / denied_permission / denied_constraint / failed), justification, metadata expand
- Filters: acting_user, role at time of action, client, action_type, result, date range
- Export to CSV for compliance reporting
- Per-row expand to view full metadata JSONB
- Data sources: user_actions, auth.users, clients, user_roles

**Knowledge Base Tab (within `/dashboard/clients/[id]`) — visible to all three operator-side roles:**
- Per-client A-44 management surface — full specification in Section 8 Tab 7 above
- Force Re-scrape button visible to master_admin and senior_admin
- Manual Asset Provision visible to master_admin only
- Block A-44 toggle visible to master_admin only
- Diff approval panel visible to master_admin and senior_admin when pending diffs exist
- Data sources: client_ingestion_versions, client_ingested_assets, client_brand_voice_model, client_keyword_gap_analysis

These three surfaces are part of Phase 1 dashboard scope and required for Phase 1 exit.

**Updated Build Order (Mandatory Sequence — append to existing 1–7 list):**
8. **User Management Page** (`/dashboard/users`) — master_admin-only role grant and revocation interface
9. **Audit Log Page** (`/dashboard/audit`) — user_actions log with filtering and export
10. **Knowledge Base Tab** (within `/dashboard/clients/[id]` as Tab 7) — A-44 management per client

Items 8–10 build after Items 5–7 (Operator Command Center KPI strip, Zone 4 charts, Geo-Grid Layer 1b panel) per the existing operator-surfaces-second priority. Items 8 and 9 unblock the RBAC architecture in production; Item 10 unblocks A-44 operational management.

### Phase 1 Dashboard Scope — EXPLICITLY DEFERRED (DO NOT BUILD)

The following were requested in operator scope discussion 2026-05-16 and are explicitly deferred:

| Feature | Defer to | Reason |
|---|---|---|
| Geo-Grid Layer 2 (real Google rank tracking) | Phase 1.5 | Requires Decodo SERP API + feature flag flip post-monetization |
| Competitor Snapshot Panel | Phase 2 | Requires new agent in AGENTS.md, no current data source |
| AI-Generated Executive Summary | Phase 2 | Requires new summarizer agent, no current data source |
| Content Deployment Kanban | Phase 2 | UI nicety, no canonical spec, page_status enum already sufficient for table view |
| Storm Overlay Map (real-time hail visualization) | Phase 3 | Requires D1 Storm Backfill complete + D2 CRON jobs operational |
| Real-time Hail Swath Screenshots | Phase 3 | Currently placeholder SVGs per STATE_OF_THE_BUILD.md, replaced by D1 output |
| Tier 4 Social Lead Intelligence | Phase 4+ | GLBA/FCRA/TCPA legal complexity, deferred per prior operator decision |

### Phase 1 Dashboard Exit Criteria
- [ ] Migration 006 applied (service_area_heatmaps extensions verified via information_schema)
- [ ] Client Portal KPI strip rendering 8 real metrics from existing tables (no placeholders)
- [ ] Client Portal Geo-Grid Layer 1b functional with E4 seeded data
- [ ] Client Portal monthly growth timeline rendering 90 days of real data
- [ ] Client Portal lead performance panel sortable, TCPA-compliant
- [ ] Operator Command Center KPI strip rendering 6 real metrics (no placeholders)
- [ ] Operator Zone 4 charts rendering real 30-day data
- [ ] Operator Geo-Grid Layer 1b functional cross-tenant
- [ ] All Phase 1 dashboard surfaces pass Six Laws verification (SCHEMA, API, UI, DATA, WIRING, VERIFICATION)
- [ ] Vercel production deployment Ready status
- [ ] Visual sweep diff vs 2026-05-16 baseline confirms 0 placeholder strings on dashboard routes
- [ ] **RBAC Migrations N+1 through N+8 applied** (user_roles, user_actions, role_grant_audit, client_ingestion_versions tables created; existing operator account auto-promoted to master_admin; existing operator_actions rows backfilled with role_at_time_of_action='operator_legacy'; synthetic A-44 baseline rows created for existing seeded clients)
- [ ] **Contract 71 enforcement script active** (scripts/verify-rbac-pattern.ts runs in pnpm verify:ci and blocks builds on direct role checks)
- [ ] **Contract 72 enforcement script active** (scripts/verify-audit-attribution.ts runs in pnpm verify:ci and blocks builds on missing audit attribution)
- [ ] **Contract 73 enforcement active** (A-02 entry point checks for client_ingestion_versions current row with status='success' before execution; failure throws ContractViolationError)
- [ ] **Users Management Page functional** (/dashboard/users renders for master_admin only; role grant and revocation work end-to-end; role_grant_audit rows created on every grant/revoke)
- [ ] **Audit Log Page functional** (/dashboard/audit renders for master_admin and senior_admin; user_actions filterable and exportable; VAs receive 403 on direct navigation)
- [ ] **Knowledge Base Tab functional** (/dashboard/clients/[id] Tab 7 renders for all three operator-side roles; action availability gated per permission matrix; Force Re-scrape works end-to-end; Manual Asset Provision works for master_admin)
- [ ] **A-44 Client Knowledge Ingestion Engine functional** (executes at Step 9 of onboarding; creates client_ingestion_versions row; populates client_ingested_assets, client_brand_voice_model, client_keyword_gap_analysis; LLM cost stays under $0.55 per scrape; Contract 73 enforced at A-02 entry)
- [ ] **CRON-03 a44-quarterly-refresh operational** (pg_cron schedule active; processes clients with next_ingestion_scheduled_at <= NOW(); diff classification working; auto-approves none/minor diffs; queues material/breaking diffs for approval)
- [ ] **Role-aware UI rendering verified** across all dashboard surfaces (Playwright E2E tests confirm VA sees disabled action buttons, master_admin sees Users sidebar item, senior_admin sees Audit Log sidebar item)
- [ ] **Multi-user audit attribution verified** (every user_actions row has acting_user_id, acting_user_role, and client_id where applicable populated; integration test asserts NOT NULL constraints)
- [ ] **Three-attribute attribution preserved over time** (test asserts that role_at_time_of_action captured at insert is not modified when user_roles changes for that user)


---

## PHASE 1.5 — ANTI-FOOTPRINT HARDENING + DECODO INTEGRATION

**Unlock Criteria:** 100-page live milestone + first client revenue event

**Strategic Purpose:** Before scaling to 100+ clients, harden platform against Google's duplicate content detection and algorithm-generated footprint recognition. Phase 1 architecture enables programmatic SEO at scale; Phase 1.5 ensures that scale doesn't trigger algorithmic penalties.

### Phase 1.5 Build Sequence

**Step 1:** Distributed Relevance Maintenance System (Agents A-32 through A-37)
- A-32: Content Seed Variation Engine
- A-33: Schema Markup Scrambler
- A-34: Image Metadata Randomizer
- A-35: Component Variation Engine
- A-36: Internal Link Pattern Shuffler
- A-37: Publish Cadence Jitter Engine

**See AGENTS.md for canonical specs (locked 2026-05-16 per Contract 50).**

**Step 2:** Decodo SERP API Integration
- API Route: `/api/portal/geo-grid-rankings` (client view)
- API Route: `/api/clients/[id]/geo-grid-rankings` (operator view)
- Dashboard update: Geo-Grid Layer 2 replaces Layer 1b synthetic data with real Google Map Pack ranks
- Feature flag flip: `platform_config.geo_grid_layer_2_rankings = true`
- Cost guard: Decodo API $0.02/query, max 121 queries per client per keyword = $2.42 per refresh

**Step 3:** Component Variation Library (A-35 dependency)
- Multi-variant component design for Button, Card, Section, Hero, CTA
- CSS variation manifests stored in `client_component_variations` table
- Tailwind config extended to support variant classes (`button-primary-v1`, `button-primary-v2`, etc.)

**Step 4:** Database Extensions
- CREATE TABLE `content_variations` (seed_id, block_id, variation_index, text_hash)
- CREATE TABLE `client_component_variations` (client_id, component_name, variant_id)
- CREATE TABLE `publish_schedule` (page_id, scheduled_publish_at, jitter_offset_minutes)
- CREATE TABLE `image_metadata_variations` (image_id, city_id, alt_variation, title_variation)
- CREATE TABLE `internal_links` (from_page_id, to_page_id, anchor_text, placement_zone)

**Step 5:** CRON-01 Drip Publisher Update
- Read from `publish_schedule` table instead of uniform daily batches
- Respect jitter_offset_minutes for per-page publish timing
- Honor `clients.disable_publish_jitter` override flag

### Phase 1.5 Exit Criteria

- [ ] All 6 agents (A-32 through A-37) built, tested, and deployed
- [ ] Decodo SERP API integration functional with E4 Construction test data
- [ ] Geo-Grid Layer 2 replacing Layer 1b on client and operator dashboards
- [ ] Component Variation Library supports 3+ variants per component type
- [ ] All 5 new tables created via versioned migrations
- [ ] CRON-01 Drip Publisher respecting jitter schedule
- [ ] Success metrics validated on first 3 clients:
  * Zero identical content blocks across 100+ city pages (SHA-256 hash comparison)
  * Zero identical schema fingerprints across 100+ pages (JSON hash)
  * Zero identical CSS fingerprints across 3 client sites (DOM+CSS hash)
  * Publish cadence variance >40% (standard deviation check)
- [ ] Google penalty rate <5% across first 3 clients (Search Console manual review)
- [ ] LLM cost per 100-page client rollout <$15 (A-32 variation generation cost guard)

### Phase 1.5 Risks

1. **Over-engineering risk:** Variation system adds complexity before validating necessity. Mitigation: lock design now (Contract 50), validate on first 10 clients, expedited pivot if penalties occur.
2. **LLM cost escalation:** A-32 generates 3-5 variations per block; 100 pages × 5 blocks × 5 variations = 2500 LLM calls. Mitigation: cost guard $0.001/variation = $12.50 per client max.
3. **Decodo API cost:** 121 queries per client per keyword per refresh = $2.42. Monthly refresh for 100 clients = $242/month. Mitigation: cache results 30 days, refresh only on operator manual trigger or CRON schedule.
4. **Component variation UX regressions:** Subtle CSS tweaks could introduce layout bugs. Mitigation: E2E visual regression tests per variant; Contract 35 lock (no full redesigns).

### Phase 1.5 Success Criteria (Strategic)

**Outcome 1:** First 100 clients (10,000+ pages) deployed without Google algorithmic penalties

**Outcome 2:** Operator can confidently scale to 1000+ clients without footprint detection risk

**Outcome 3:** Client dashboards show real Google Map Pack rank data (not synthetic), establishing platform credibility for sales

**Outcome 4:** Platform becomes defensible moat — competitors cannot replicate anti-footprint system without equivalent architectural investment

**If failure:** Expedited architectural review. Potential pivots: reduce variation aggressiveness, inject human editorial review, delay Phase 2 rollout until Google penalty patterns understood.

---

**PHASE 1.5 SPECIFICATION LOCKED (2026-05-16)**

---

## 24. DETAILED SPECIFICATION CROSS-REFERENCES (2026-05-20)

The following detailed specifications provide expanded context for features and systems introduced in Phase 1 and Phase 1.5. These documents live in `docs/` and provide implementation-level detail beyond the strategic scope covered in MASTER_BUILD_SPEC.md.

### Three-Tier Site Architecture
Service hub pages (Tier 2) sit between the homepage (Tier 1) and location pages (Tier 3) in the hub-and-spoke architecture. Service hubs use Opus-based generation for elevated quality and serve as parent pages enforced via `parent_hub_id` foreign key. See docs/architecture/service-hub-pages-spec.md for G16 Hub Completeness gate, hub review queue workflow, and Tier 2 structural requirements.

### Client Intelligence Intake Structure
A-01 Intake Processor captures comprehensive client intelligence across business profile, service offerings, competitive positioning, and storm-driven workflow triggers. See docs/onboarding/client-intelligence-intake.md for full field inventory, validation rules, and downstream agent dependencies.

### Test Phase Activation Plan
Test phase client onboarding workflow for E1-E4 Construction and 10 roofing pilots, including intake form pre-population, reduced approval friction, operator review queues, and monitoring dashboards. See docs/test-phase/test-account-activation-plan.md for activation sequence and success metrics.

### Asset Hub Feature Overview
Client self-service portal for accessing marketing collateral, job evidence exports, review request templates, and performance reports. Three-tier evidence unlock model (Foundational/Authority/Dominance) gates premium asset access by subscription tier. See docs/features/asset-hub-spec.md for asset catalog, unlock conditions, and download workflows.

### Directory Registration Agent (A-46)
Automated directory submission with A/B/C tier classification and Track A automation for API-enabled directories. See docs/agents/a-46-directory-registration-agent.md for tier classification criteria, Track A API integration specifications, and operator review queue workflows.

---

## 25. RBAC AND A-44 PHASE 1 CROSS-REFERENCE (2026-05-23 GOVERNANCE SYNCHRONIZATION)

### Purpose
This section is the build-direction entry point for the multi-user role hierarchy and A-44 Client Knowledge Ingestion Engine functionality added to Phase 1 scope per the 2026-05-23 governance synchronization. All build sessions touching RBAC or A-44 surfaces must read this section first.

### Canonical Source of Truth
**`docs/architecture/ROLE_HIERARCHY_ARCHITECTURE_SPEC.md`** is the canonical specification. This Section 25 is a build-direction summary, not a replacement.

### Role Taxonomy (Phase 1)
Three operator-side roles plus the existing client role:
- master_admin (platform owner, top of hierarchy)
- senior_admin (trusted operational manager)
- va (virtual assistant)
- client (existing client portal role, unchanged)

### Permission Scoping
Global, not per-client. Encoded in `src/lib/auth/permission-matrix.ts`. Permission check helper: `hasPermission(role, action)` from `src/lib/auth/role-context.ts`. Contract 71 enforces use of the helper.

### Audit Attribution
Three attributes per audit log row: acting_user_id, acting_user_role (preserved historically, not mutated), client_id. Logged to user_actions table. Contract 72 enforces.

### A-44 Client Knowledge Ingestion Engine
Phase 1 mandatory prerequisite for A-02. Three refresh triggers: onboarding (mandatory, blocking), quarterly CRON (CRON-03 a44-quarterly-refresh with ±7 day jitter), manual trigger (master_admin or senior_admin). Contract 73 enforces. Full specification in BLUEPRINT.md Part 10.5 and ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 7.

### Build Sequence (Order of Operations for RBAC and A-44 Phase 1 Build)

The RBAC and A-44 build subdivides into 14 ordered work items. The dependency chain is strict — earlier items must complete before later items can begin.

1. **Migration N+1**: Create user_roles, role_grant_audit tables with RLS policies and indexes
2. **Migration N+2**: Seed user_roles from existing auth.users (operator → master_admin promotion)
3. **Migration N+3**: Create user_actions table with RLS, NOT NULL constraints on attribution columns
4. **Migration N+4**: Create client_ingestion_versions table with RLS, partial unique index for is_current
5. **Migration N+5**: Add ingestion tracking columns to clients (current_ingestion_version_id, last_ingestion_at, next_ingestion_scheduled_at, ingestion_blocked, ingestion_block_reason)
6. **Migration N+6**: Add role_at_time_of_action to operator_actions, backfill 'operator_legacy'
7. **Migration N+7**: Add assigned_reviewer columns to pages
8. **Migration N+8**: Seed synthetic A-44 baseline rows for existing clients
9. **Library: src/lib/auth/permission-matrix.ts**: Encode canonical permission matrix from ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 3
10. **Library: src/lib/auth/role-context.ts**: Implement getUserActiveRole, hasPermission, logUserAction, logDeniedAction helpers
11. **Verification scripts**: scripts/verify-rbac-pattern.ts, scripts/verify-audit-attribution.ts, scripts/verify-permission-matrix-sync.ts; wire into pnpm verify:ci
12. **Authentication flow refactor**: Update /login route handler to query user_roles instead of clients table for role determination
13. **Existing operator API route refactor**: Refactor all routes under /api/operator/ to use role-context helpers; route-by-route audit
14. **New UI surfaces**: /dashboard/users (master_admin), /dashboard/audit (master/senior), /dashboard/clients/[id] Tab 7 Knowledge Base (all roles, role-gated actions)
15. **A-44 agent build**: Implement A-44 with three-trigger model, diff detection, version management
16. **CRON-03 implementation**: Schedule via pg_cron, implement queue and worker
17. **End-to-end Playwright tests**: Role-aware rendering, multi-user audit attribution, A-44 workflow

### Critical Contract Enforcements at Build Time

Build sessions implementing RBAC and A-44 must respect these contracts (read full text in BEHAVIORAL_CONTRACTS.md):

- **Contract 8** (Middleware Auth Passthrough Only) — UNCHANGED. Middleware does not perform role lookups. Role checks happen in route handlers.
- **Contract 67** (Resource Ownership Verification) — AMENDED. Ownership semantics now incorporate role-based access. See ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 8.4.
- **Contract 70** (Operator Endpoint Auth Helper Requirement) — UNCHANGED. getOperatorContext() still required. Layered with new role check via getUserActiveRole().
- **Contract 71** (RBAC Enforcement) — NEW. Every protected route handler must invoke hasPermission() before action execution. Direct role checks forbidden.
- **Contract 72** (Multi-User Audit Attribution) — NEW. Every audit log row captures acting_user_id, acting_user_role, client_id.
- **Contract 73** (Pre-Generation Knowledge Ingestion Requirement) — NEW. A-02 cannot execute without successful A-44 current version.

### Backward Compatibility
- Existing operator@tarritrix.test account auto-promoted to master_admin during Migration N+2.
- Existing clients.operator_id pointers preserved; semantically now means "the master_admin or senior_admin ultimately accountable for this client."
- Existing operator_actions rows backfilled with role_at_time_of_action = 'operator_legacy'.
- Existing seeded clients (E4 Construction & Roofing, and any others) receive synthetic A-44 baseline rows via Migration N+8 so Contract 73 is satisfied at the database constraint level and A-02 continues running without interruption. ingestion_synthetic_baseline = TRUE flag marks them for real A-44 scrape at next operator interaction.

### Six Laws Compliance at Phase 1 Exit
Every RBAC and A-44 surface must pass:
1. SCHEMA — migrations applied, indexes created, RLS policies active
2. API — route handlers using getUserActiveRole and hasPermission, returning consistent error shapes
3. UI — role-aware rendering verified across all three operator-side roles
4. DATA — real data flowing through user_actions, client_ingestion_versions, role_grant_audit
5. WIRING — UI invokes API which invokes helpers which check matrix; no shortcuts
6. VERIFICATION — Playwright E2E for role isolation, vitest for permission matrix, verify:ci scripts blocking direct role checks

---

## 26. COMPREHENSIVE INTEGRITY FRAMEWORK (CIF)

**Established:** 2026-05-24
**Status:** Canonical governance specification
**Authority:** docs/architecture/COMPREHENSIVE_INTEGRITY_FRAMEWORK.md

The full Comprehensive Integrity Framework specification lives at docs/architecture/COMPREHENSIVE_INTEGRITY_FRAMEWORK.md. All verification scripts referenced in this build spec must conform to CIF layer assignments. New verification scripts created after 2026-05-24 must live in scripts/cif/<layer-N>/ subdirectories.

**9 CIF Layers:**
1. Static Analysis
2. Security
3. Database Integrity
4. Runtime/Observability
5. Contract/Behavioral
6. Deployment/Infrastructure
7. Process/Documentation
8. Cross-System Consistency
9. Tarritrix-Specific

**Enforcement:** Contracts 74 (CIF Compliance Mandate), 75 (Quarterly Drills), 76 (CIF Coverage Reporting).

Every commit must pass `pnpm verify:fast`. Every push must pass `pnpm verify:ci`. Every release must pass `pnpm audit:comprehensive`.
