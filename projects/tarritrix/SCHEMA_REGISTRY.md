# TARRITRIX 1.0 "” SCHEMA REGISTRY
**Version:** 3.0 | **Format:** Supabase Migration SQL + Annotations
**Migration Files:**
- `supabase/migrations/20260505000001_tarritrix_phase1_part1.sql` (Migration 001 "” 37 tables)
- `supabase/migrations/20260505000002_tarritrix_phase1_part2.sql` (Migration 002 "” 15 tables)
- `supabase/migrations/20260506000001_add_missing_subscription_statuses.sql` (Correction "” subscription_status enum values)
- `supabase/migrations/20260506000002_demo_requests_add_personalized_demo_fields.sql` (Contract 31 "” demo_requests columns)
- `supabase/migrations/20260507000001_grant_base_permissions.sql` (Emergency fix "” GRANT statements for all 52 tables)
- `supabase/migrations/20260507000002_grant_anon_select.sql` (Emergency fix "” anon SELECT for return=representation)
- `supabase/migrations/20260507000003_allow_anon_insert_demo_requests.sql` (Emergency fix "” RLS policies for anon access)
- `supabase/migrations/20260507154020_update_pricing_tiers_phase_b_section_1.sql` (Phase B Section 1 "” pricing_tiers updates)
- `supabase/migrations/20260507154331_evidence_justified_unlock_phase_b_section_2.sql` (Phase B Section 2 "” evidence-justified unlock)
- `supabase/migrations/20260507154803_page_metrics_analytics_phase_b_section_3.sql` (Phase B Section 3 "” per-page analytics)
- `supabase/migrations/20260507155536_exif_pipeline_phase_b_section_6.sql` (Phase B Section 6 "” EXIF metadata extraction)
- `supabase/migrations/20260509000001_tier_entitlements_phase_b_section_11.sql` (Migration 003 - Phase B Section 11 - tenant_entitlements + xactimate_rewrite_requests + Dominance pricing_tiers row) **STATUS: APPLIED - verified via operator-confirmed live table list 2026-05-17, tenant_entitlements + xactimate_rewrite_requests both present**
- `supabase/migrations/20260514120000_phase1_architecture_schema.sql` (Migration 005 - Phase 1 Architecture Schema: Differentiation Engine, A-21, A-05, Storm Intelligence, Multi-Provider LLM Routing, A-20, A-29 Phase 1 Data Prep - 22 tables, 8 ALTERs, postgis + vector extensions) **STATUS: APPLIED 2026-05-14** **NOTE: Migration 005 DROP/CREATE pattern lost service_role grants on 27 tables; fixed by Migration 20260520161504**
- `supabase/migrations/20260514230000_llm_cost_check_function.sql` (B2 LLM Router - check_llm_cost_with_lock() stored procedure with pg_advisory_xact_lock) **STATUS: APPLIED 2026-05-14**
- `supabase/seed/006_llm_routing_seed.sql` (B2 LLM Router - 20 routing configs + platform_config LLM pricing) **STATUS: APPLIED 2026-05-14**
- `supabase/migrations/20260517010000_p0_remove_anon_select_pii_tables.sql` (P0 security fix - removed anon SELECT exposure on conversions + demo_requests, preserves INSERT for public forms) **STATUS: APPLIED 2026-05-17**
- `supabase/migrations/20260518120000_layer_1_triage_schema.sql` (Migration 008 - Layer 1 Triage Schema: operator_action_queue, system_health_snapshots, operator_preferences, page_metrics funnel columns, client_penalty_risk_composite VIEW) **STATUS: APPLIED 2026-05-18**
- `supabase/migrations/20260518130000_add_clients_operator_business_name_unique.sql` (Migration 009 - Add unique constraint on clients(operator_id, business_name) for A-01 idempotency) **STATUS: APPLIED 2026-05-18**
- `supabase/migrations/20260518130100_add_services_client_service_name_unique.sql` (Migration 010 - Add unique constraint on services(client_id, service_name) for A-01 idempotency) **STATUS: APPLIED 2026-05-18**
- `supabase/migrations/20260519194552_align_page_sitemaps_for_a07.sql` (Migration 011 - Align page_sitemaps schema with A-07 Sitemap Generator spec - added version, sitemap_hash, robots_txt, generated_at columns + indexes) **STATUS: APPLIED 2026-05-19**
- `supabase/migrations/20260520161504_grant_service_role_comprehensive.sql` (Migration 012 - Grant service_role SELECT, INSERT, UPDATE on 27 tables missing grants due to Migration 005 DROP/CREATE pattern - closes Migration 005 grant gap, fixes /api/cron/llm-health-check 100% failure rate) **STATUS: APPLIED 2026-05-20**
- `supabase/migrations/20260520230000_service_hub_architecture.sql` (Migration 013 - Service Hub Pages Tier 2 architecture - added pages.parent_hub_id, pages.is_hub, pages.hub_review_status, pages.hub_review_completed_at, pages.hub_review_operator_id + service_hub_versions + hub_review_queue tables + page_status enum values 'pending_hub_review', 'approved_for_publish' + pages.intent CHECK constraint for 'service-hub') **STATUS: APPLIED 2026-05-20**
- `supabase/migrations/20260520240000_a06_internal_linker_schema.sql` (Migration 014 - A-06 Internal Linker Schema - link_audit_log table for hub-and-spoke pattern audit trail) **STATUS: APPLIED 2026-05-20**
- `supabase/migrations/20260527180013_service_area_mode.sql` (Migration 015 - Service area mode enum - added service_area_mode_type enum ('radius', 'nationwide') + clients.service_area_mode column NOT NULL DEFAULT 'radius' with backfill of 76 existing clients) **STATUS: APPLIED 2026-05-27**

**Total Tables: 86**

---

## AGENT READING INSTRUCTIONS

- This is the single source of truth for all database structure
- Every table listed here exists in the live Supabase database
- Phase 2/3 tables are present but empty until feature flag enabled
- Never ALTER a table outside a new versioned migration file
- RLS is enabled on every table "” no exceptions
- client_id always from authenticated session "” never from request body
- Service role key bypasses RLS "” never use in client-facing code

## EXTENSION-PROVIDED TABLES (PostGIS)

The postgis extension provides 3 system tables (geography_columns, geometry_columns, spatial_ref_sys) that appear in information_schema.tables but are NOT part of Tarritrix application schema. They are not documented in the table inventory below.

---

## COMPLETE TABLE INVENTORY (93 TABLES)

### Group 1: Core Client & Billing (Tables 1-6)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 1 | pricing_tiers | Tier limits, seeded at migration | 1 | 001 |
| 2 | clients | One record per client business | 1 | 001 |
| 3 | services | Service types per client | 1 | 001 |
| 4 | cities | Target cities per client + Census data | 1 | 001 |
| 5 | subscriptions | Stripe subscription lifecycle | 1 | 001 |
| 6 | invoices | Stripe invoice records | 1 | 001 |

### Group 2: Page Generation (Tables 7-16)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 7 | page_generation_queue | Work queue for A-02 | 1 | 001 |
| 8 | pages | Generated SEO pages | 1 | 001, 013 |
| 9 | page_content_profile | 4-layer differentiation per page | 1 | 001 |
| 10 | page_quality_scores | 15-gate validation results | 1 | 001 |
| 11 | page_schemas | JSON-LD structured data | 1.5 | 001 |
| 12 | page_internal_links | Internal link graph | 1.5 | 001 |
| 13 | page_sitemaps | Versioned XML sitemaps + robots.txt | 1.5 | 001, 011 |
| 14 | service_hub_versions | Version history for Tier 2 hub pages | 1 | 013 |
| 15 | hub_review_queue | Operator review workflow for hubs | 1 | 013 |
| 16 | link_audit_log | A-06 internal link creation audit trail | 1 | 014 |

### Group 3: Content Intelligence (Tables 17-19)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 17 | claimed_facts | Verified facts A-02 may reference | 1 | 001 |
| 18 | service_area_heatmaps | 5kmÃ—5km grid cells per client | 1 | 001 |
| 19 | evidence_items | Photos, certifications per client | 1 | 001 |

### Group 4: Compliance & Legal (Tables 20-24)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 20 | conversions | Form/call submissions, TCPA immutable | 1 | 001 |
| 21 | dsars | Data Subject Access Requests | 1 | 001 |
| 22 | dsars_audit_log | Immutable DSAR action trail | 1 | 001 |
| 23 | sub_processors | CPRA/GDPR sub-processor docs | 1 | 001 |
| 24 | domains | Custom domains for white-label | 3 | 001 |

### Group 5: Agent Operations (Tables 25-27)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 25 | agent_events | Immutable agent action log | 1 | 001 |
| 26 | platform_config | Feature flags + config | 1 | 001 |
| 27 | stack_jobs | Background job state for pgmq | 1 | 001 |

### Group 6: GBP & Activity Moat (Tables 28-33)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 28 | gbp_profiles | GBP profile state per client | 1.5 | 001 |
| 29 | gbp_posts | GBP posts generated by A-15 | 2 | 001 |
| 30 | review_requests | Review request tracking by A-14 | 1 | 001 |
| 31 | qa_seeds | GBP Q&A entries by A-16 | 2 | 001 |
| 32 | entity_audit_log | NAP consistency monitoring | 2 | 001 |
| 33 | job_evidence | Completed job records | 1 | 001 |

### Group 7: Integrations (Table 34)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 34 | client_integrations | Field service connection config | 1 | 001 |

### Group 8: Performance Tracking (Tables 35-36)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 35 | indexation_records | GSC API data per page | 1 | 001 |
| 36 | ai_visibility_scores | AI platform rank tracking | 2 | 001 |

### Group 9: Storm Intelligence Engine (Tables 37-40)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 37 | storm_events | NOAA/SPC storm events | 3 | 001 |
| 38 | page_activations | Dynamic content injections per storm | 3 | 001 |
| 39 | signal_leads | Enriched leads from storm detection | 3 | 001 |
| 40 | retargeting_events | Meta Pixel + Google Tag fire log | 3 | 001 |

### Group 10: Phase 1 Completion "” Migration 002 (Tables 41-55)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 41 | page_decisions | A-05 validator audit trail with reasoning | 1 | 002 |
| 42 | operator_actions | Manual override log per operator | 1 | 002 |
| 43 | cron_run_log | CRON execution history | 1 | 002 |
| 44 | review_response_drafts | LLM review responses + moderation risk | 2 | 002 |
| 45 | job_content_linkage | Job â†’ GBP post â†’ page refresh chain | 1 | 002 |
| 46 | integration_field_mappings | Custom field maps per integration | 1 | 002 |
| 47 | client_risk_profiles | Drip rate multipliers per client | 1 | 002 |
| 48 | governance_violations | Strike system per client | 1 | 002 |
| 49 | security_events | Auth failures, cross-tenant attempts | 1 | 002 |
| 50 | llm_calls | Granular per-call cost tracking | 1 | 002 |
| 51 | email_deliverability | Bounce/complaint tracking | 1 | 002 |
| 52 | session_logs | Operator + client activity | 1 | 002 |
| 53 | audit_log | Comprehensive entity change log | 1 | 002 |
| 54 | tenant_signals | Recommendations Engine + advisory signals | 1 | 002 |
| 55 | demo_requests | Marketing landing page form submissions | 1 | 002 |
### Group 11: Tier Entitlements & Vendor Routing - Migration 003 (Tables 56-57)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 56 | tenant_entitlements | Per-client computed entitlements snapshot per billing period | 1 | 003 |
| 57 | xactimate_rewrite_requests | Vendor-routed Xactimate rewrite job tracking with SLA enforcement | 1 | 003 |

### Group 12: Phase B Analytics & Evidence (Tables 58-59)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 58 | client_evidence_progress | Evidence depth tracking for 3-stage unlock | 1 | Phase B-2 |
| 59 | page_metrics | Per-page analytics rollup from PostHog | 1 | Phase B-3 |

### Group 13: Phase 1 Architecture Schema - Migration 005 (Tables 60-82)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 60 | archetype_library | Aesthetic archetypes (Bloomberg, NYT, Apple, Patagonia, etc.) | 1 | 005 |
| 61 | client_brand_signatures | Per-client permanent brand signature, DMA-unique | 1 | 005 |
| 62 | client_storm_subscriptions | Service area polygons for storm signal triggering | 1 | 005 |
| 63 | composition_recipes | Module sequences, hero treatments, CTA placement patterns | 1 | 005 |
| 64 | diversity_constraints | DMA uniqueness, similarity thresholds | 1 | 005 |
| 65 | dns_verification_log | DNS check history with check_type and result enums | 1 | 005 |
| 66 | extracted_evidence | Testimonials, photos, certifications, bios from client sites | 1 | 005 |
| 67 | llm_provider_health | Health check results per provider | 1 | 005 |
| 68 | llm_routing_config | Per-task-type routing rules with fallback chains | 1 | 005 |
| 69 | module_library | Versioned React components organized into 8 pools | 1 | 005 |
| 70 | module_usage_tracking | DMA diversity enforcement data | 1 | 005 |
| 71 | page_claim_provenance | Every factual claim's data source for Gate 1 | 1 | 005 |
| 72 | page_embeddings | A-05 Gate 2 anti-monotony similarity (VECTOR 1536) | 1 | 005 |
| 73 | page_performance_daily | Daily per-page metrics from GA4, GSC, conversion tracking | 1 | 005 |
| 74 | page_structural_variants | Snapshot of every structural decision A-02 made | 1 | 005 |
| 75 | page_type_templates | 12 page archetypes with required pools and selection triggers | 1 | 005 |
| 76 | page_validation_results | 15-gate validation results, retry tracking | 1 | 005 |
| 77 | palette_library | Vetted color palettes tagged by archetype and mood | 1 | 005 |
| 78 | site_crawls | Playwright crawl jobs with status tracking | 1 | 005 |
| 79 | storm_event_assets | Radar imagery, hail swath polygons, tornado tracks | 1 | 005 |
| 80 | storm_ingestion_log | CRON job execution log | 1 | 005 |
| 81 | typography_library | Vetted font pairings tagged by archetype compatibility | 1 | 005 |
| 82 | validation_rules | Gate 15 custom rules by scope (platform/tier/DMA/client) | 1 | 005 |

### Group 14: Geo-Grid Visualization (Table 83)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 83 | geo_grid_scan_points | Multi-provider geo-coordinate scanning state with rate-limit tracking | 1 | 20260516000002 |

### Group 15: Operator Dashboard (Tables 84-86)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 84 | operator_action_queue | Priority triage queue for operator actions (P0-P3 severity) | 1 | 008 |
| 85 | system_health_snapshots | Platform health metrics snapshots for operator dashboard | 1 | 008 |
| 86 | operator_preferences | Per-operator UI preferences and state persistence | 1 | 008 |

### Group 16: RBAC and Knowledge Ingestion (Tables 87-90)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 87 | user_roles | Global role assignment per user (master_admin / senior_admin / va / client) with grant history and revocation tracking | 1 | N+1 (slot reserved at implementation) |
| 88 | user_actions | Multi-user audit log with three-attribute attribution: acting_user_id, acting_user_role, client_id | 1 | N+3 |
| 89 | role_grant_audit | Dedicated audit trail for role grant and revocation events, separately indexed for compliance queries | 1 | N+1 |
| 90 | client_ingestion_versions | Per-scrape version metadata for A-44 with diff classification and approval workflow | 1 | N+4 |

### Group 17: GSC Integration & OAuth Security (Tables 91-94)

| # | Table | Purpose | Phase | Migration |
|---|---|---|---|---|
| 91 | page_indexation | GSC URL Inspection API results per page with indexation status, coverage state, and crawl metadata | 1 | 20260520220000 |
| 92 | gsc_rate_limits | GSC API daily rate limit tracking (200 req/day per property) with atomic increment via RPC | 1 | 20260520220000 |
| 93 | oauth_state_tokens | One-time-use state tokens for OAuth flows with 10-minute TTL and CSRF protection per Contract 67 | 1 | 20260521120000 |
| 94 | client_gsc_credentials | Per-client encrypted GSC OAuth refresh tokens for A-08 API access with pgcrypto encryption | 1 | 20260522180100 |

---

## MIGRATION 001 SQL (37 TABLES)

See `supabase/migrations/20250101000001_tarritrix_complete_schema.sql` for the complete original migration. All 37 tables, all RLS policies, all triggers, all enums, all CRON schedules. This file was applied successfully on initial Supabase project setup.

Key elements from Migration 001:
- Extensions: uuid-ossp, pg_trgm, pgmq, pg_cron, vector
- All 21 enums (client_status, tier_name, page_status, lifecycle_state, etc.)
- TCPA immutability trigger on conversions table
- 24 feature flags seeded into platform_config
- 10 sub-processors seeded into sub_processors
- 3 pricing tiers seeded into pricing_tiers
- 2 CRON schedules: drip-publisher (3am UTC), indexation-runner (6am UTC)

---

## MIGRATION 002 SQL (14 NEW TABLES)


Key elements from Migration 002:
- 14 new tables (38-51)
- RLS policies on each
- Indexes optimized for query patterns
- 3 new feature flags: recommendations_engine, real_time_polling, marketing_site
- 1 new CRON schedule: tarritrix-recommendations-engine (every 5 minutes)

---

## NOTES ON SPECIFIC TABLES

### tenant_signals (Table 54)
This is the heart of the Recommendations Engine. Every alert, advisory, and Next Best Action surfaces through this table. The Command Center polls this table every 30 seconds. RLS ensures operators only see signals for their own clients.

### llm_calls (Table 50)
Replaces the aggregate `clients.llm_cost_today` field with granular per-call tracking. The aggregate field still exists in clients table for fast cost-cap checks, but every actual LLM call is logged here for cost attribution, debugging, and audit.

### page_decisions (Table 41)
Every decision A-05 makes (approved, rejected, flagged, requires_review) is logged here with full reasoning. This is the audit trail when an operator asks "why was this page flagged?"

### operator_actions (Table 42) — DEPRECATED FOR NEW WRITES

Originally the canonical audit table for manual operator overrides. **Deprecated for new writes as of 2026-05-23** per RBAC architecture lock. Replaced by `user_actions` (Table 88) which captures the same audit data with three-attribute attribution (acting_user_id, acting_user_role, client_id) per Contract 72.

**Historical preservation:**
- All existing rows preserved unchanged
- All rows backfilled with `role_at_time_of_action = 'operator_legacy'` (added column per Migration N+6)
- The `'operator_legacy'` value is reserved for pre-RBAC era data
- The table is queryable for compliance reporting but receives no new INSERTs after the RBAC migration applies

**Reason for replacement rather than in-place modification:**
The schema delta would be substantial (adding acting_user_role NOT NULL on a populated table with no backfillable role data would require either nullable column with eventual constraint tightening, or platform-wide assumption of a single role for the pre-RBAC data). Creating user_actions as a clean replacement table is architecturally simpler and preserves historical data without forced constraints.

**Migration N+6 (`alter_operator_actions_add_role.sql`):**
- Adds `role_at_time_of_action TEXT NOT NULL CHECK (role_at_time_of_action IN ('master_admin', 'senior_admin', 'va', 'operator_legacy'))`
- Backfills all existing rows with `'operator_legacy'`
- Application code is updated to write all new audit data to user_actions, not operator_actions

### client_risk_profiles (Table 47)
Adjusts drip publishing velocity based on per-client risk factors. New domain = lower multiplier (slower publishing). Established domain with no penalties = higher multiplier (faster publishing). Multiplier ranges 0.10 to 2.00.

### demo_requests (Table 55)
Marketing landing page form submissions. Stores lead data + Google Calendar event ID created via API. Status tracks lead through funnel with comprehensive workflow states. Lead enrichment (T1 scope) populates storm zone tier + regional data for personalized demo prep.

**Current Columns (as of 20260522173349):**
- id, email, phone, business_name, industry, name, message, calendar_event_id, status, requested_at, scheduled_at, completed_at
- **first_name** (TEXT, NOT NULL) "” added 2026-05-06
- **last_name** (TEXT, NOT NULL) "” added 2026-05-06
- **primary_trade** (TEXT, NOT NULL) "” added 2026-05-06, dropdown value from demo form
- **zip** (TEXT, NOT NULL) "” added 2026-05-06, **REQUIRED per Contract 31**
- **primary_city** (TEXT, NOT NULL) "” added 2026-05-06, **REQUIRED per Contract 31**
- **notes** (TEXT, nullable) "” added 2026-05-06, optional prospect notes
- **tcpa_consent_given_at** (TIMESTAMPTZ, nullable) "” added 2026-05-22, **Contract 6 TCPA consent timestamp**
- **region** (TEXT, nullable) "” added 2026-05-22, enrichment T1: primary_city value
- **state** (TEXT, nullable) "” added 2026-05-22, enrichment T1: state code from ZIP lookup
- **storm_zone_tier** (TEXT CHECK IN (‘low’, ‘medium’, ‘high’, ‘unknown’), nullable) "” added 2026-05-22, enrichment T1: Texas storm activity classification
- **metro_area** (TEXT, nullable) "” added 2026-05-22, enrichment T1: metro area for high-tier storm zones (Austin-Round Rock, San Antonio, Killeen-Temple)

**Status Enum (updated 2026-05-22):**
- ‘new’ (default) "” fresh lead, not yet contacted
- ‘contacted’ "” operator reached out
- ‘demo_scheduled’ "” demo time confirmed
- ‘demo_completed’ "” demo conducted
- ‘won’ "” converted to paying client
- ‘lost’ "” not a fit / declined
- ‘no_response’ "” unable to reach

**RLS Policies (updated 2026-05-22):**
- anon role: INSERT only (form submission). SELECT explicitly revoked to close security vulnerability.
- authenticated role: SELECT via operators_see_demo_requests policy (all operators can see all leads)

**Future Schema Additions (Personalized Demo Engine "” see BLUEPRINT.md, Contract 31):**

Phase 1.5 additions (gated on A-18 operational):
- prepared_dashboard_url (TEXT, nullable) "” link to operator’s prepped demo dashboard
- signals_captured_at_request_time (JSONB, nullable) "” snapshot of Storm Intelligence Engine signals at request time
- hail_events_in_region (JSONB, nullable) "” array of recent storm events relevant to prospect

Phase 2+ additions (gated on Tier 4 build, post-investor):
- Identity reconciliation linkages "” final schema TBD pending data licensing decisions

### user_roles (Table 84)
Global role assignment for every authenticated user in the platform. One active row per user (enforced via partial unique index `user_roles_one_active_per_user` where `revoked_at IS NULL`). Role values: 'master_admin', 'senior_admin', 'va', 'client'.

**Soft-delete pattern:** Role changes preserve historical context "” the old row is marked `revoked_at = NOW()` and `revoked_by = <granter_user_id>`, then a new row is inserted with the new role. This permits reconstruction of “who held what role on what date” for any past timestamp. Required for DSAR responses and compliance audits.

**Grant authority:**
- master_admin role can only be granted by another master_admin
- senior_admin role can only be granted by master_admin
- va role can be granted by master_admin OR senior_admin
- All grant authority validated at application layer; database RLS restricts INSERT/UPDATE to master_admin only, with the senior_admin VA-grant path handled via a server action that runs with elevated privileges after validating the granter's authority

**Initial seed:** Migration N+2 (`seed_user_roles_from_auth_users.sql`) reads existing `auth.users.raw_user_meta_data->>'role'` and creates user_roles rows for every existing user. The existing operator account `operator@tarritrix.test` (auth UUID `aaaaaaaa-0000-0000-0000-000000000001`) is auto-promoted to master_admin per operator decision 2026-05-23 (Issue 1).

### user_actions (Table 85)
Multi-user audit log replacing operator_actions for all new writes. Every audit-logged action across the platform writes one row here with three-attribute attribution (Contract 72):
1. `acting_user_id` (UUID NOT NULL) "” the authenticated user who initiated the action
2. `acting_user_role` (TEXT NOT NULL) "” the active role of that user at the moment the action was executed, captured by fresh query of user_roles at action time (not cached)
3. `client_id` (UUID, nullable only for platform-level actions like role grants) "” the tenant the action was for

**Immutability:** No UPDATE or DELETE policies. Audit rows are append-only. Contract 72 enforces.

**Result enum:** `'success'`, `'denied_permission'` (action attempted but role lacks permission per matrix), `'denied_constraint'` (action attempted but blocked by Contract 6, 9 hard gates, 18, or 45 constitutional constraint), `'failed'` (action attempted but encountered application error). Denied attempts produce audit rows so privilege escalation attempts leave a trace.

**Justification requirement:** Required for override actions (force-publish, P0 dismissal, cap increase, role grant, A-44 override) per Contract 72. Enforced at API layer via `requireJustification: true` on the action handler.

### role_grant_audit (Table 86)
Dedicated audit trail for role grant and revocation events. Subset of user_actions data but separately indexed for compliance queries (“who granted master_admin to whom, when, with what justification”). Every INSERT or UPDATE to user_roles produces a corresponding role_grant_audit row.

**Why a separate table from user_actions:** Compliance queries on role changes are common during DSAR responses and security audits. A dedicated table with indexes on `target_user_id` and `granted_by_user_id` provides fast query paths without scanning the high-volume user_actions table.

### client_ingestion_versions (Table 87)
Per-scrape version metadata for A-44 Client Knowledge Ingestion Engine. Each successful or failed scrape creates a new row.

**is_current pattern:** Only one row per client may have `is_current = TRUE`. Enforced via partial unique index. A-02 Page Generator reads from `clients.current_ingestion_version_id` which points to the row with `is_current = TRUE`.

**Approval workflow:**
- `auto_approved` "” first-ever scrape at onboarding, or subsequent scrape with `diff_severity = 'none'` or `'minor'`. Immediately becomes current.
- `pending_approval` "” subsequent scrape with `diff_severity = 'material'` or `'breaking'`. Requires master_admin or senior_admin to approve before becoming current. Previous version remains current until approval.
- `approved` "” operator reviewed and accepted. Becomes current; previous version marked `is_current = FALSE`.
- `rejected` "” operator reviewed and rejected. Historical record; never becomes current.
- `manually_provided` "” master_admin Contract 73 override path for unscrapable sites. Manual asset upload via dashboard form.

**Diff severity computation:** Deterministic hash comparison (no LLM cost) per BLUEPRINT.md Part 10.5 Section 10.5.5 algorithm.

### subscriptions (Table 5)
**Schema extended in Migration 015 (2026-05-22)** to support Stripe Checkout flow across all 4 tiers and 4 billing cadences.

**Core columns (Migration 001):**
- id, client_id, stripe_subscription_id, stripe_price_id, status
- current_period_start, current_period_end, cancel_at, cancelled_at
- created_at, updated_at

**New columns (Migration 015 - 2026-05-22):**
- **billing_cadence** (TEXT, NOT NULL, DEFAULT 'monthly') — CHECK constraint: 'monthly', 'quarterly', 'annual', '2year'
- **tier** (TEXT, NOT NULL, DEFAULT 'starter') — CHECK constraint: 'starter', 'growth', 'authority', 'dominance'
- **setup_fee_paid_at** (TIMESTAMPTZ, NULL) — Timestamp when one-time setup fee was charged
- **setup_fee_stripe_invoice_id** (TEXT, NULL) — Stripe invoice ID for setup fee payment

**Purpose:**
Enables platform to track monthly vs. prepay subscriptions without JOIN to clients table. Setup fee tracking provides audit trail for one-time charges separate from recurring subscription.

**Indexes:**
- idx_subscriptions_client (client_id)
- idx_subscriptions_status (status)
- **idx_subscriptions_tier_cadence (tier, billing_cadence)** — added Migration 015

**Integration:**
- Populated by webhook handler on customer.subscription.{created,updated,deleted} events
- Populated by webhook handler on checkout.session.completed event (setup fee)
- tier and billing_cadence parsed from Stripe price ID via parsePriceId() in price-resolver.ts

### clients (Table 2)
**Migration 015 constraint addition (2026-05-22):**
- **stripe_customer_id UNIQUE constraint** — prevents duplicate Stripe customers per client

Column `stripe_customer_id` existed since Migration 001, but UNIQUE constraint added in Migration 015 for data integrity.

### page_sitemaps (Table 13)
Versioned XML sitemaps + robots.txt per client. Generated by A-07 Sitemap Generator.

**Schema aligned with A-07 spec (Migration 011 - 2026-05-19):**
- **version** (INTEGER, NOT NULL, DEFAULT 1) — Monotonic version per client_id. Incremented when sitemap content actually changes (hash differs).
- **sitemap_hash** (TEXT) — SHA-256 of full sitemap_xml. Used by A-07 idempotency check to avoid inserting duplicate versions.
- **robots_txt** (TEXT) — robots.txt content with AI crawler directives (GPTBot, ClaudeBot, PerplexityBot, etc.). Generated alongside sitemap.
- **generated_at** (TIMESTAMPTZ, NOT NULL, DEFAULT NOW()) — When A-07 generated this row.

**Legacy column:** `is_current` (BOOLEAN) retained for backward compatibility. A-07 uses `version DESC` ordering instead of `is_current=true` filtering.

**Idempotency:** A-07 queries latest version by `ORDER BY version DESC LIMIT 1`, compares SHA-256 hash. If hash matches, returns `was_duplicate=true` without inserting new row. If hash differs, inserts new row with `version=prev_version+1`.

**AI crawler allowlist in robots.txt:** GPTBot, ChatGPT-User, Google-Extended, PerplexityBot, ClaudeBot, anthropic-ai, Bytespider, cohere-ai (per BLUEPRINT.md A-07 spec).

### client_evidence_progress (Table 53)
Added in Phase B Section 2 migration (20260507154331). Tracks evidence depth per client to enable 3-stage progressive unlock model.

**Three stages:**
- Stage 1 (Starter Library): Tier minimum evidence â†' unlocks 30% of tier max pages
- Stage 2 (Core Library): 50% of full threshold â†' unlocks 70% of tier max pages
- Stage 3 (Full Library): Full threshold â†' unlocks 100% of tier max pages

**Key columns:**
- photos_count, case_studies_count, claimed_facts_count, certifications_count (current evidence)
- stage_1/2/3_threshold_* (per-tier thresholds computed at onboarding)
- current_stage (1-3), pages_unlocked, pages_allowed_at_stage
- stage_2_progress_pct, stage_3_progress_pct (for UI progress bars)

**Integration with pages table:**
- New column: pages.evidence_lock_status (enum: 'unlocked', 'locked_stage_2', 'locked_stage_3')
- New page_status value: 'evidence_locked' (set by A-05 Gate 8 when evidence threshold not met)
- CRON-01 ignores pages with status = 'evidence_locked'
- A-02 still drafts pages even when locked (no wasted work)
- When client uploads more evidence, A-10 re-evaluates and locks lift in bulk

### page_metrics (Table 54)
Added in Phase B Section 3 migration (20260507154803). Per-page analytics rollup from PostHog events.

**Purpose:**
PostHog wiring on every published page. Edge Function rolls PostHog events into page_metrics every 5 minutes.
Operator dashboard Client Detail Pages tab shows analytics. Client portal My Pages shows per-page performance (RLS-filtered).

**Key columns:**
- views_total, views_30d, views_7d, views_24h (time-windowed page views)
- conversions_total, conversions_30d, conversions_7d, conversions_24h (form/call conversions)
- conversion_rate, conversion_rate_30d (computed rates for performance ranking)
- performance_tier (enum: 'high', 'median', 'low' — computed by rollup function)
- last_view_at, last_conversion_at (timestamps for recency tracking)

**Integration points:**
- Real-time polling at 30 seconds (consistent with existing Command Center architecture)
- A-11 (Content Refresh Engine) uses page_metrics.conversion_rate as primary input to refresh prioritization
- Replaces simple "last_refreshed_at > 90 days" logic with performance-aware refresh queue

### service_area_heatmaps extensions (Phase B Section 5)
Existing table (table 15 in Group 3) extended for geo-grid visualization Layers 1a/1b.

**Phase B Section 5 additive columns — Migration 006 applied 2026-05-16:**
- photo_count INTEGER NOT NULL DEFAULT 0 — Count of EXIF-verified job photos with GPS coordinates falling within this grid cell. Populated by A-18 Job Evidence Ingestion (Phase B Section 6). Layer 1a visual encoding: green = many, yellow = few, red = none.
- page_id UUID NULL REFERENCES pages(id) ON DELETE SET NULL — FK to pages.id. Identifies which Tarritrix-generated page covers this grid cell, if any. NULL = no page covers this cell. Set by A-10 Content Profile Builder. Layer 1b visual encoding.
- performance_tier performance_tier NULL — Performance classification of the page covering this cell, mirrored from page_metrics.performance_tier. NULL when page_id is NULL or page has no metrics yet. Layer 1b visual encoding: high = green, median = yellow, low = red.
- INDEX idx_service_area_heatmaps_page_id ON page_id WHERE page_id IS NOT NULL

**Layer 1a (Evidence Density Geo-Grid):**
Color-coded grid showing EXIF-verified job photos per cell. Green = many photos, yellow = few, red = none.

**Layer 1b (Page Performance Geo-Grid):**
Color-coded grid showing page performance per cell. Green = high-converting, yellow = low engagement, red = locked/no page.

**Layer 2 (Google Rank Tracking) — DEFERRED to Phase 1.5:**
Behind feature flag platform_config.geo_grid_layer_2_rankings = false. Vendor LOCKED 2026-05-16: Decodo (formerly Smartproxy) SERP API. Entry $30/month at $0.32/1k requests, scales to $0.08/1k floor at $3,999/month. DIY scraper option permanently rejected. See BLUEPRINT.md Phase 1.5 vendor decision and MASTER_BUILD_SPEC.md Section 23 for full rationale.

### job_evidence EXIF columns (Phase B Section 6)
Existing table (table 16 in Group 3) extended for EXIF metadata extraction and validation.

**Phase B Section 6 additive columns:**
- exif_lat, exif_lng (NUMERIC) — GPS coordinates extracted from photo EXIF data, NULL if absent
- exif_timestamp (TIMESTAMPTZ) — photo capture timestamp from EXIF, validated for sanity
- exif_camera (TEXT) — camera model/fingerprint for fraud detection
- exif_validated_at (TIMESTAMPTZ) — timestamp when A-18 validated EXIF data, NULL if validation failed
- exif_anomaly_flag (TEXT) — human-readable anomaly description if validation flags issues

**A-18 validation pipeline:**
- Mandatory EXIF extraction on every photo upload via mobile picker (preserves EXIF)
- Cross-reference EXIF GPS against client service area — flag if >500m outside declared service area
- Timestamp sanity check: not in future, not implausibly old
- Camera fingerprint logging for fraud detection
- EXIF-verified photos count toward client_evidence_progress thresholds (Section 2)
- Photos without GPS accepted but do NOT count toward evidence threshold

**EXIF accuracy bucketing:**
- Use 200-500m grid cells for geo-grid plotting (accounts for GPS sensor variance)
- Photos with GPS > 500m outside service area flagged but not auto-rejected (operator review)

---

## MIGRATION 005 ADDITIONS (2026-05-14) — 22 Tables + 8 ALTERs

### Brand Identity Libraries (4 tables)

**typography_library** (public reference) — 15+ vetted font pairings tagged by archetype compatibility  
**palette_library** (public reference) — 25+ vetted color palettes tagged by archetype and mood  
**archetype_library** (public reference) — 8+ aesthetic archetypes (Bloomberg, NYT, Apple, Patagonia, Stripe, Linear, editorial, functional)  
**client_brand_signatures** (tenant-scoped) — per-client permanent brand signature, DMA-unique

### Module System (6 tables)

**module_library** (public reference) — versioned React components organized into 8 pools (A_storm, B_carrier, C_evidence, D_authority, E_decision, F_process, G_action, H_narrative)  
**page_type_templates** (public reference) — 12 page archetypes with required pools and selection triggers  
**composition_recipes** (public reference) — module sequences, hero treatments, CTA placement patterns  
**module_usage_tracking** (tenant-scoped) — DMA diversity enforcement data  
**diversity_constraints** (platform config) — DMA uniqueness, similarity thresholds  
**page_embeddings** (tenant-scoped, VECTOR(1536)) — A-05 Gate 2 anti-monotony similarity

### A-44 Client Knowledge Ingestion — Migration 005 Historical Entry (Originally Labeled "A-21 Client Site Ingestion")

**A-21/A-44 conflict resolution note (2026-05-23):**

Migration 005 (applied 2026-05-14) shipped these tables under the working label "A-21 Client Site Ingestion" before the canonical slot for client knowledge ingestion was determined to be A-44. Per operator decision 2026-05-23 (Option 1 conflict resolution), all client knowledge ingestion functionality is canonically slotted as A-44 going forward. A-21 is reserved for "Hyperlocal Geographic Engine" exclusively (county property data, ZIP-level page generation — see Phase 1.5 A-21 Hyperlocal Geographic Engine Tables section below).

The tables created by Migration 005 remain in production with their existing names and serve A-44 functionality:

**site_crawls** (tenant-scoped, Table — Migration 005) — Playwright crawl jobs with status tracking. Used by A-44 to track crawl execution.
**extracted_evidence** (tenant-scoped, Table — Migration 005) — testimonials, photos, certifications, bios from client sites with permission flags. Used by A-44 to store extracted assets.
**ALTER page_content_profile** (Migration 005) — adds existing_seo_patterns, existing_coverage_map, link_patterns, source_crawl_id. Used by A-44 outputs feeding A-02 and A-10.

**Relationship to the Phase 1 RBAC + A-44 migration (Migrations N+1 through N+8):**

The Migration 005 tables (site_crawls, extracted_evidence) are A-44's per-crawl work tables. The new client_ingestion_versions table (Migration N+4) is A-44's version-management layer. The full A-44 storage model spans:
- site_crawls — crawl job state (Migration 005, existing)
- extracted_evidence — raw captured assets (Migration 005, existing)
- client_ingested_assets — refined asset library (declared in Phase 1.5 Authenticity/Trust/Ingestion section, migration pending Phase 1 generation)
- client_brand_voice_model — per-client voice model (declared, migration pending)
- client_keyword_gap_analysis — keyword gap analysis (declared, migration pending)
- client_ingestion_versions — version management (Migration N+4, this synchronization)

A-44 implementation reads/writes across all six. See BLUEPRINT.md Part 10.5 and ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 7 for canonical specification.

### A-05 Page Validator (3 tables)

**page_validation_results** (tenant-scoped) — 15-gate validation results, retry tracking  
**page_claim_provenance** (tenant-scoped) — every factual claim's data source for Gate 1  
**validation_rules** (operator-managed) — Gate 15 custom rules by scope (platform/tier/DMA/client)

### Storm Intelligence Engine (4 tables + extensions)

**storm_events** (public reference, PostGIS) — NOAA + Mesonet + NWS + SPC storm data with geographic indexing  
**client_storm_subscriptions** (tenant-scoped, PostGIS) — service area polygons for signal triggering  
**storm_ingestion_log** (operator-only) — CRON job execution log  
**storm_event_assets** (public reference) — radar imagery, hail swath polygons, tornado tracks

**Required extensions:** postgis, vector

### Multi-Provider LLM Routing (3 tables + ALTERs)

**llm_calls** (tenant-scoped) — every LLM call with provider, model, cost, latency, generated columns (total_tokens, call_date). **agent_event_id NOT NULL** (enforced 2026-05-21 per Contract 47, migration 20260521150000)  
**llm_provider_health** (operator-only) — health check results per provider  
**llm_routing_config** (operator-only) — per-task-type routing rules with fallback chains  
**ALTER clients** — adds llm_provider_override, llm_model_override, llm_daily_cost_cap (default 5.00)  
**ALTER platform_config** — adds llm_daily_cost_cap_total (default 500.00), llm_provider_daily_caps, llm_model_pricing

### A-20 Multi-Tenant Hosting (1 table + ALTERs)

**ALTER clients** — adds custom_domain (UNIQUE), dns_method (4 enum values), dns_verified_at, dns_last_check_at, ssl_provisioned_at, hosting_platform  
**dns_verification_log** (tenant-scoped) — DNS check history with check_type and result enums  
**ALTER pages** — adds deployed_url, deployed_at, cache_status, last_cache_purge_at

### Dead-Letter Queue Extensions

**ALTER page_generation_queue** — adds retry_count, retry_after, last_error

### A-29 Performance Learning Engine — Phase 1 Data Preparation (2 tables + 1 ALTER)

**page_performance_daily** (tenant-scoped, partitioned by month at scale) — daily per-page metrics from GA4, GSC, conversion tracking, and indexation tracker. UNIQUE constraint on (page_id, metric_date, source). Stores impressions, clicks, CTR, avg_position, pageviews, unique_visitors, sessions, bounce_rate, engagement_rate, engagement_time_seconds, scroll_depth distributions, conversions, mobile/desktop split, and raw_metadata JSONB for source-specific extras (top queries, source/medium).

**page_structural_variants** (tenant-scoped) — snapshot of every structural decision A-02 made when generating a page. UNIQUE on page_id. Records brand signature components (typography, palette, archetype, density, voice, photo treatment), page generation decisions (template, recipe, modules used, hero, CTA, link pattern, image-to-text ratio), LLM decisions (provider, model, perspective rotation, length bucket), realized measurements (word count, image count, validation attempts), and reference fields (DMA, service vertical) for correlation queries. This is the experimental record without which A-29 cannot correlate performance to structure.

**ALTER conversions** — adds page_id, structural_variant_id, first_touch_page_id, last_touch_page_id, attribution_path JSONB. Enables A-29 to attribute conversions to specific structural variants. Note: A-29 itself (the agent that runs correlation analysis, surfaces findings, and writes weight tables) is a Phase 2 first-class agent specified in BLUEPRINT.md.

---

## MIGRATIONS N+1 THROUGH N+8 (2026-05-23 RBAC + A-44 PHASE 1)

This section documents the schema additions and modifications applied via Migrations N+1 through N+8. Migration timestamp slots are reserved at implementation time per Contract 4. The migrations apply in strict order — earlier migrations are prerequisites for later migrations.

### Migration N+1: Create user_roles and role_grant_audit Tables

**Filename pattern:** `<YYYYMMDDHHMMSS>_create_user_roles_and_role_grant_audit.sql`

```sql
-- Migration N+1: RBAC foundation tables

CREATE TABLE user_roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('master_admin', 'senior_admin', 'va', 'client')),
  granted_by UUID REFERENCES auth.users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES auth.users(id),
  revocation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX idx_user_roles_role ON user_roles(role) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX user_roles_one_active_per_user ON user_roles(user_id) WHERE revoked_at IS NULL;

-- Service role grants per Contract 64
GRANT ALL ON user_roles TO service_role;
GRANT SELECT ON user_roles TO authenticated;

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

-- RLS Policies (see Section "RBAC HELPER FUNCTIONS AND TRIGGERS" below for user_has_operator_role function)

CREATE POLICY "users_can_read_own_role" ON user_roles
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "operator_side_users_can_read_user_roles" ON user_roles
  FOR SELECT
  USING (user_has_operator_role(auth.uid()));

CREATE POLICY "only_master_admin_can_modify_roles" ON user_roles
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'master_admin'
        AND ur.revoked_at IS NULL
    )
  );

-- role_grant_audit table

CREATE TABLE role_grant_audit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type TEXT NOT NULL CHECK (event_type IN ('granted', 'revoked')),
  target_user_id UUID NOT NULL REFERENCES auth.users(id),
  role TEXT NOT NULL,
  granted_by_user_id UUID NOT NULL REFERENCES auth.users(id),
  granted_by_role TEXT NOT NULL,
  justification TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_role_grant_audit_target ON role_grant_audit(target_user_id);
CREATE INDEX idx_role_grant_audit_granter ON role_grant_audit(granted_by_user_id);
CREATE INDEX idx_role_grant_audit_created_at ON role_grant_audit(created_at DESC);

GRANT ALL ON role_grant_audit TO service_role;
GRANT SELECT ON role_grant_audit TO authenticated;

ALTER TABLE role_grant_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator_side_users_can_read_role_grant_audit" ON role_grant_audit
  FOR SELECT
  USING (user_has_operator_role(auth.uid()));
```

### Migration N+2: Seed user_roles from Existing auth.users

**Filename pattern:** `<YYYYMMDDHHMMSS>_seed_user_roles_from_auth_users.sql`

```sql
-- Migration N+2: Seed user_roles for existing users
-- Auto-promote existing operator account to master_admin per operator decision 2026-05-23 (Issue 1)

INSERT INTO user_roles (user_id, role, granted_by, granted_at, revoked_at)
SELECT
  id AS user_id,
  CASE
    WHEN raw_user_meta_data->>'role' = 'operator' THEN 'master_admin'
    WHEN raw_user_meta_data->>'role' = 'client' THEN 'client'
    ELSE 'va'
  END AS role,
  -- Use the platform sentinel UUID to represent the system as the granter for migration-applied grants
  '00000000-0000-0000-0000-000000000001'::uuid AS granted_by,
  NOW() AS granted_at,
  NULL AS revoked_at
FROM auth.users
WHERE id NOT IN (
  SELECT user_id FROM user_roles WHERE revoked_at IS NULL
);

-- Audit log entry for the auto-promotion
INSERT INTO role_grant_audit (event_type, target_user_id, role, granted_by_user_id, granted_by_role, justification, created_at)
SELECT
  'granted' AS event_type,
  ur.user_id AS target_user_id,
  ur.role AS role,
  '00000000-0000-0000-0000-000000000001'::uuid AS granted_by_user_id,
  'system' AS granted_by_role,
  'Migration N+2 auto-promotion from pre-RBAC user_metadata.role per 2026-05-23 governance synchronization' AS justification,
  NOW() AS created_at
FROM user_roles ur
WHERE ur.granted_by = '00000000-0000-0000-0000-000000000001'::uuid;
```

### Migration N+3: Create user_actions Table

**Filename pattern:** `<YYYYMMDDHHMMSS>_create_user_actions.sql`

```sql
-- Migration N+3: Multi-user audit log

CREATE TABLE user_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  acting_user_id UUID NOT NULL REFERENCES auth.users(id),
  acting_user_role TEXT NOT NULL CHECK (acting_user_role IN ('master_admin', 'senior_admin', 'va')),
  client_id UUID REFERENCES clients(id),
  action_type TEXT NOT NULL,
  action_target_type TEXT,
  action_target_id UUID,
  justification TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  result TEXT NOT NULL CHECK (result IN ('success', 'denied_permission', 'denied_constraint', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_actions_acting_user ON user_actions(acting_user_id);
CREATE INDEX idx_user_actions_client_id ON user_actions(client_id);
CREATE INDEX idx_user_actions_action_type ON user_actions(action_type);
CREATE INDEX idx_user_actions_created_at ON user_actions(created_at DESC);
CREATE INDEX idx_user_actions_role_at_time ON user_actions(acting_user_role);
CREATE INDEX idx_user_actions_result ON user_actions(result) WHERE result != 'success';

GRANT ALL ON user_actions TO service_role;
GRANT SELECT ON user_actions TO authenticated;

ALTER TABLE user_actions ENABLE ROW LEVEL SECURITY;

-- master_admin and senior_admin can read all audit rows
CREATE POLICY "master_and_senior_can_read_audit_log" ON user_actions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('master_admin', 'senior_admin')
        AND ur.revoked_at IS NULL
    )
  );

-- Any authenticated user can read their own actions (for /dashboard/profile session log)
CREATE POLICY "users_can_read_own_actions" ON user_actions
  FOR SELECT
  USING (acting_user_id = auth.uid());

-- No UPDATE or DELETE policies — audit rows are immutable and append-only
-- INSERTs are performed via service_role from route handlers, never directly from authenticated users
```

### Migration N+4: Create client_ingestion_versions Table

**Filename pattern:** `<YYYYMMDDHHMMSS>_create_client_ingestion_versions.sql`

```sql
-- Migration N+4: A-44 version management

CREATE TABLE client_ingestion_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  scrape_started_at TIMESTAMPTZ NOT NULL,
  scrape_completed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'success', 'failed', 'partial')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('onboarding', 'manual', 'quarterly_cron', 'signal_detected')),
  triggered_by_user_id UUID REFERENCES auth.users(id),
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  approval_status TEXT CHECK (approval_status IN ('auto_approved', 'pending_approval', 'approved', 'rejected', 'manually_provided')),
  approved_by_user_id UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,
  approval_role TEXT,
  diff_summary JSONB,
  diff_severity TEXT CHECK (diff_severity IN ('none', 'minor', 'material', 'breaking')),
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, version_number)
);

CREATE INDEX idx_client_ingestion_versions_client ON client_ingestion_versions(client_id);
CREATE UNIQUE INDEX idx_client_ingestion_versions_current ON client_ingestion_versions(client_id) WHERE is_current = TRUE;
CREATE INDEX idx_client_ingestion_versions_pending ON client_ingestion_versions(client_id) WHERE approval_status = 'pending_approval';
CREATE INDEX idx_client_ingestion_versions_status ON client_ingestion_versions(status);

GRANT ALL ON client_ingestion_versions TO service_role;
GRANT SELECT ON client_ingestion_versions TO authenticated;

ALTER TABLE client_ingestion_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator_side_users_can_read_ingestion_versions" ON client_ingestion_versions
  FOR SELECT
  USING (user_has_operator_role(auth.uid()));
```

### Migration N+5: Add A-44 Tracking Columns to clients

**Filename pattern:** `<YYYYMMDDHHMMSS>_alter_clients_add_ingestion_columns.sql`

```sql
-- Migration N+5: A-44 tracking on clients table

ALTER TABLE clients
  ADD COLUMN current_ingestion_version_id UUID REFERENCES client_ingestion_versions(id),
  ADD COLUMN last_ingestion_at TIMESTAMPTZ,
  ADD COLUMN next_ingestion_scheduled_at TIMESTAMPTZ,
  ADD COLUMN ingestion_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN ingestion_block_reason TEXT,
  ADD COLUMN ingestion_synthetic_baseline BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX idx_clients_next_ingestion ON clients(next_ingestion_scheduled_at)
  WHERE ingestion_blocked = FALSE AND next_ingestion_scheduled_at IS NOT NULL;
```

### Migration N+6: Add role_at_time_of_action to operator_actions

**Filename pattern:** `<YYYYMMDDHHMMSS>_alter_operator_actions_add_role.sql`

```sql
-- Migration N+6: Backfill role attribution for legacy operator_actions

ALTER TABLE operator_actions
  ADD COLUMN role_at_time_of_action TEXT CHECK (role_at_time_of_action IN ('master_admin', 'senior_admin', 'va', 'operator_legacy'));

UPDATE operator_actions
SET role_at_time_of_action = 'operator_legacy'
WHERE role_at_time_of_action IS NULL;

ALTER TABLE operator_actions
  ALTER COLUMN role_at_time_of_action SET NOT NULL;
```

### Migration N+7: Add Reviewer Assignment Columns to pages

**Filename pattern:** `<YYYYMMDDHHMMSS>_alter_pages_add_reviewer_assignment.sql`

```sql
-- Migration N+7: Flagged page review lease

ALTER TABLE pages
  ADD COLUMN assigned_reviewer_id UUID REFERENCES auth.users(id),
  ADD COLUMN assigned_reviewer_at TIMESTAMPTZ,
  ADD COLUMN assigned_reviewer_role TEXT;

CREATE INDEX idx_pages_assigned_reviewer ON pages(assigned_reviewer_id)
  WHERE assigned_reviewer_id IS NOT NULL;
```

### Migration N+8: Synthetic A-44 Baseline for Existing Clients

**Filename pattern:** `<YYYYMMDDHHMMSS>_seed_a44_baseline_for_existing_clients.sql`

```sql
-- Migration N+8: Backward compatibility for existing seeded clients
-- Creates a synthetic baseline ingestion version for each existing client so Contract 73
-- is satisfied at the database constraint level. Marks clients for real A-44 scrape via
-- ingestion_synthetic_baseline flag.

INSERT INTO client_ingestion_versions (
  client_id,
  version_number,
  scrape_started_at,
  scrape_completed_at,
  status,
  trigger_type,
  triggered_by_user_id,
  is_current,
  approval_status,
  approved_by_user_id,
  approved_at,
  approval_role,
  diff_summary,
  diff_severity,
  created_at
)
SELECT
  c.id AS client_id,
  1 AS version_number,
  NOW() AS scrape_started_at,
  NOW() AS scrape_completed_at,
  'success' AS status,
  'onboarding' AS trigger_type,
  '00000000-0000-0000-0000-000000000001'::uuid AS triggered_by_user_id,
  TRUE AS is_current,
  'auto_approved' AS approval_status,
  '00000000-0000-0000-0000-000000000001'::uuid AS approved_by_user_id,
  NOW() AS approved_at,
  'system' AS approval_role,
  jsonb_build_object('synthetic_baseline', TRUE, 'note', 'Pre-A-44 era client. Real scrape pending operator interaction.') AS diff_summary,
  'none' AS diff_severity,
  NOW() AS created_at
FROM clients c
WHERE c.id NOT IN (SELECT client_id FROM client_ingestion_versions);

-- Update clients to point at their synthetic baseline and mark them for real scrape
UPDATE clients c
SET
  current_ingestion_version_id = civ.id,
  last_ingestion_at = NOW(),
  next_ingestion_scheduled_at = NOW() + INTERVAL '1 day', -- Schedule real scrape for tomorrow
  ingestion_synthetic_baseline = TRUE
FROM client_ingestion_versions civ
WHERE civ.client_id = c.id
  AND civ.is_current = TRUE
  AND c.current_ingestion_version_id IS NULL;
```

### Verification Queries (Post-Migration)

After all 8 migrations apply, the following queries verify the schema is in the expected state:

```sql
-- Verify Group 16 tables exist
SELECT COUNT(*) AS rbac_table_count
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('user_roles', 'user_actions', 'role_grant_audit', 'client_ingestion_versions');
-- Expected: 4

-- Verify existing operator account auto-promoted to master_admin
SELECT role FROM user_roles
WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid
  AND revoked_at IS NULL;
-- Expected: 'master_admin'

-- Verify operator_actions backfilled with operator_legacy
SELECT COUNT(*) FROM operator_actions WHERE role_at_time_of_action IS NULL;
-- Expected: 0

SELECT COUNT(*) FROM operator_actions WHERE role_at_time_of_action = 'operator_legacy';
-- Expected: (number of pre-RBAC operator_actions rows)

-- Verify clients have ingestion tracking columns
SELECT COUNT(*) FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'clients'
  AND column_name IN ('current_ingestion_version_id', 'last_ingestion_at', 'next_ingestion_scheduled_at', 'ingestion_blocked', 'ingestion_block_reason', 'ingestion_synthetic_baseline');
-- Expected: 6

-- Verify existing clients have synthetic baseline
SELECT COUNT(*) FROM clients WHERE ingestion_synthetic_baseline = TRUE;
-- Expected: (number of pre-A-44 era clients)

SELECT COUNT(*) FROM clients WHERE current_ingestion_version_id IS NOT NULL;
-- Expected: (same as above)

-- Verify pages have reviewer assignment columns
SELECT COUNT(*) FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'pages'
  AND column_name IN ('assigned_reviewer_id', 'assigned_reviewer_at', 'assigned_reviewer_role');
-- Expected: 3
```

---

## RLS VERIFICATION

Every table has Row-Level Security enabled. Cross-tenant access is impossible by design.

**Two distinct RLS patterns are now in use** as of 2026-05-23 RBAC architecture lock:

### Pattern A: Operator-Side Multi-User Access (NEW — 2026-05-23)

For tables that operator-side roles (master_admin, senior_admin, va) all need to read:

```sql
CREATE POLICY "operator_side_users_can_read_<table>" ON <table>
  FOR SELECT
  USING (user_has_operator_role(auth.uid()));
```

Where `user_has_operator_role(uid)` is the helper function defined in the "RBAC HELPER FUNCTIONS AND TRIGGERS" section below. The function returns TRUE if the user has any active role in `('master_admin', 'senior_admin', 'va')`.

**Tables using Pattern A:**
- user_roles (with additional self-read policy and master_admin-only modify policy)
- user_actions (with additional own-actions read policy)
- role_grant_audit
- client_ingestion_versions
- clients (operator-side read; client_user_id self-read also applies for client portal)
- pages (operator-side read; client-derived read also applies for client portal)
- Most other operator-facing tables previously using the single-operator pattern

### Pattern B: Client Portal Self-Access (UNCHANGED — Existing Pattern)

For client portal users to read their own client's data via `clients.client_user_id`:

```sql
CREATE POLICY "<table>_client_portal_read" ON <table>
  FOR SELECT
  USING (
    client_id IN (
      SELECT id FROM clients WHERE client_user_id = auth.uid()
    )
  );
```

This pattern remains unchanged. Client portal users see only their own client's data.

### Pattern C: Legacy Single-Operator Ownership (DEPRECATED — Being Phased Out)

The original pattern `client_id IN (SELECT id FROM clients WHERE operator_id = auth.uid())` is still present on some tables. **It is deprecated as of 2026-05-23.** During the Phase 1 RBAC build, every RLS policy using this pattern is migrated to Pattern A. The legacy pattern remains correct (it grants access to the single master_admin via the operator_id pointer) but is too narrow — it does not grant senior_admin or va access. Migration tracking:

- Total tables with Pattern C as of 2026-05-23: ~40 (legacy from original migrations)
- Migration target: All operator-facing tables migrated to Pattern A by Phase 1 RBAC build exit

### Tenant Isolation Enforcement

All three patterns enforce tenant isolation:
- Pattern A: Operator-side roles see all clients (cross-tenant is by design for operator role); client_id is not the isolation boundary at this layer — role assignment is
- Pattern B: Client portal users see only their own client_id; tenant isolation enforced by `client_user_id = auth.uid()` check
- Pattern C (legacy): Operator-id linkage enforces tenant isolation for single-operator-per-client semantics

CRON-02 runs cross-tenant leak detection daily across all three patterns. Any leak = P0 alarm.

### RLS Public Exceptions (intentionally RLS DISABLED)

| Table | Reason for RLS Exception |
|---|---|
| pricing_tiers | Public pricing reference data (existing exception) |
| typography_library | Public design library, operator-facing reference |
| palette_library | Public design library, operator-facing reference |
| archetype_library | Public design library, operator-facing reference |
| module_library | Operator-facing component library, no client data |
| page_type_templates | Public reference for page archetypes |
| composition_recipes | Public reference for composition patterns |
| diversity_constraints | Platform-wide configuration |
| storm_events | Public NOAA reference data |
| storm_event_assets | Public NOAA reference data |
| storm_ingestion_log | Operator-only operational log |
| llm_provider_health | Operator-only operational health data |
| llm_routing_config | Operator-only platform configuration |
| validation_rules | A-05 Page Validator rule definitions, platform-wide |
| operator_action_queue | Operator-only workflow queue, cross-tenant visibility |
| system_health_snapshots | Operator-only platform health monitoring |
| spatial_ref_sys | PostGIS extension system table (not application data) |

The 17 RLS-disabled tables above are NOT subject to Pattern A migration — they have no tenant data and were intentionally exempt from RLS at original creation. Comments added to each table (except spatial_ref_sys, extension-owned) explaining RLS exception per FIB Part 2 Finding 3.1 remediation (commit TBD).

### Write Policy Strategy (CRITICAL)

Pattern A grants read access to operator-side users broadly. **Write access is NOT broad — write enforcement happens at the application layer via the canonical permission matrix per Contract 71, not via RLS.**

The reasoning:
- Application-layer permission checks produce auditable rejection events (logged to user_actions with result='denied_permission'). RLS rejection is silent and does not capture justification context.
- Compliance audits require traceability of attempted privilege escalations. RLS denial does not produce a trace.
- The database remains the second line of defense. RLS policies on WRITE operations still check for operator-side role (any of three), but fine-grained per-action enforcement happens in the route handler.

**Write RLS pattern (defense-in-depth):**

```sql
CREATE POLICY "operator_side_users_can_modify_<table>" ON <table>
  FOR ALL
  USING (user_has_operator_role(auth.uid()))
  WITH CHECK (user_has_operator_role(auth.uid()));
```

This pattern allows any operator-side role to pass the RLS layer, but the route handler enforces the specific action's permission requirement via `hasPermission(role, action)` per Contract 71.

---

## CLIENT PORTAL AUTHENTICATION ADDITIONS (2026-05-15)

### ALTER clients — client_user_id column

**Migration context:** RLS policy pattern for client self-service portal access

**New column:**
- `client_user_id` UUID REFERENCES auth.users(id) — FK to Supabase Auth user for client portal login
- Index: `idx_clients_client_user_id` for fast lookup
- Enables authenticated clients to access their own data via RLS policies

### clients table — Planned Addition: page_count_override

**Planned addition (post-CRON-01 build):** `clients.page_count_override INTEGER NULL`

**Purpose:** Operator-only override that bypasses tier-based page caps. Required for E4 Construction & Roofing (Reid's roofing business operating across multiple metros) and Tarritrix Roofing (Tarritrix's own self-hosted page network operating nationally).

**Behavior when set:** CRON-01 Drip Publisher consults this field BEFORE applying tier-based cap calculation. If page_count_override is non-null, override wins.

**Behavior when null:** Standard tier-based caps apply (Starter / Growth / Authority / Dominance).

**Migration timestamp slot reserved:** 2026MMDDHHMMSS_add_page_count_override.sql (to be allocated when CRON-01 ships).

**Relation to existing clients.custom_city_count:** The custom_city_count field overrides the number of cities allowed per tier (5/15/30/60). The page_count_override field is semantically different — it overrides the TOTAL page count across all city × service combinations. custom_city_count increases pages indirectly by allowing more cities; page_count_override sets the final page cap directly, bypassing all calculations. Both fields serve operator override purposes but at different levels of the cap calculation.

### cities table — Planned Seed: US Cities ≥ 25K Population

**Planned seed (one-time):** All US incorporated places with population ≥ 25,000 per US Census 2020 data, estimated ~3,500 rows.

**Columns to populate per row:**
- city_name
- state_code (2-letter)
- county (nullable)
- population
- lat, lng
- time_zone
- fips_code (where available)
- is_metro_anchor BOOLEAN (true for top-50 US metros by population)
- dma_code TEXT (nullable) — Nielsen DMA code. Added 2026-05-20 for A-05 G5 DMA Diversity gate.

**Source:** US Census Bureau API or Census-derived static dataset (e.g., SimpleMaps US Cities Database free tier covers required fields).

**Migration timestamp slot reserved:** 2026MMDDHHMMSS_seed_us_cities_25k.sql (to be allocated when operator onboarding form expansion or A-05 Page Validator ships, whichever requires city lookups first).

**Rationale:** Operator onboarding city-selection UX (see Gap #3) requires a populated cities master table to function. Currently the cities table only contains test/demo data.

**Usage pattern:**
```sql
-- Client SELECT policy pattern:
USING (client_id IN (SELECT id FROM clients WHERE client_user_id = auth.uid()))

-- For tables with direct client_id:
USING (client_id IN (SELECT id FROM clients WHERE client_user_id = auth.uid()))
```

### RLS Policy Additions — Client Portal Read Access

Nine new SELECT policies added for authenticated client role to enable client portal subroutes:

| Table | Policy Name | Purpose |
|---|---|---|
| pages | clients_select_own_pages | /portal/pages — client page inventory |
| agent_events | clients_select_own_agent_events | /portal/activity — formatted activity feed |
| signal_leads | clients_select_own_signal_leads | /portal/leads — storm lead delivery |
| indexation_records | clients_select_own_indexation_records | /portal/pages — GSC indexation status |
| llm_calls | clients_select_own_llm_calls | (future) client usage dashboard |
| services | clients_select_own_services | /portal — service inventory |
| cities | clients_select_own_cities | /portal — city inventory |
| page_metrics | clients_select_own_page_metrics | /portal/pages — per-page analytics |
| conversions | clients_select_own_conversions | /portal/leads — contact form submissions |

**Standard pattern (8 tables):**
```sql
CREATE POLICY "clients_select_own_[table]" ON [table]
  FOR SELECT
  USING (client_id IN (SELECT id FROM clients WHERE client_user_id = auth.uid()));
```

**Exception (page_metrics):**
```sql
CREATE POLICY "clients_select_own_page_metrics" ON page_metrics
  FOR SELECT
  USING (page_id IN (
    SELECT id FROM pages 
    WHERE client_id IN (SELECT id FROM clients WHERE client_user_id = auth.uid())
  ));
```
Reason: page_metrics does not have direct client_id FK, must traverse through pages table.

**Security model:**
- Clients authenticate via Supabase Auth with client_user_id as FK
- All client portal API routes verify auth.uid() before query
- RLS policies enforce tenant isolation at database layer (defense in depth)
- No client can read another client's data, even with malicious SQL injection

---

## DISTRIBUTED RELEVANCE MAINTENANCE TABLES (PHASE 1.5)

**Locked:** 2026-05-16 | **Contract 50:** Architectural durability

Per Contract 50 architectural decision durability. Migration applied at Phase 1.5 build start. Full agent specs in AGENTS.md A-32 through A-37.

### Tables to be added (Phase 1.5 migration):

- **content_variations** — A-32 Content Seed Variation Engine output (seed_id, block_id, variation_index, text_hash)
- **client_component_variations** — A-35 Component Variation Engine per-client CSS variant assignments (client_id, component_name, variant_id)
- **publish_schedule** — A-37 Publish Cadence Jitter Engine schedule (page_id, scheduled_publish_at, jitter_offset_minutes)
- **image_metadata_variations** — A-34 Image Metadata Randomizer variations (image_id, city_id, alt_variation, title_variation)
- **internal_links** — A-36 Internal Link Pattern Shuffler graph (from_page_id, to_page_id, anchor_text, placement_zone)
- **schema_markup_variants** — A-33 Schema Markup Scrambler property order/format variants per page

### Additive columns on existing tables (Phase 1.5 migration):

**pages table extensions:**
- `variation_set_id` UUID — FK to content_variations batch used for this page
- `component_variant_set` JSONB — CSS variant selections for this page (keyed by component name)
- `schema_variant_config` JSONB — Property order + format choices for this page's schema markup
- `last_anti_footprint_refresh_at` TIMESTAMPTZ — Last time A-32 through A-37 refreshed variation parameters

**clients table extensions:**
- `disable_publish_jitter` BOOLEAN DEFAULT FALSE — Operator override to disable A-37 jitter for urgent launches (Contract 37 lock)

**Purpose:** Distributed Relevance Maintenance System defeats Google's duplicate content detection and algorithm-generated footprint recognition at scale (100+ clients, 10,000+ pages).

**Anti-footprint mechanisms:**
1. Content variation (A-32) — no two pages share identical block sequences
2. Schema scrambling (A-33) — property order, date formats, phone formats randomized per page
3. Image metadata variation (A-34) — alt text, EXIF randomization per city
4. Component variation (A-35) — CSS class variants per client site (no identical DOM+CSS fingerprints)
5. Internal link shuffling (A-36) — graph hash uniqueness enforced across city pages
6. Publish jitter (A-37) — no batch-publish spikes, appears human-edited

---

## PHASE 1.5 A-21 HYPERLOCAL GEOGRAPHIC ENGINE TABLES (County Property Data)

**Locked:** 2026-05-21 | **Contract 50:** Architectural durability

A-21 Hyperlocal Geographic Engine schema additions for county property data sourcing. Migrations not yet generated — schema lock first, build later. Full sourcing architecture in docs/architecture/county-data-sourcing.md.

### Tables to be added (Phase 1.5 migration):

**parcels** — Per-parcel property records from county appraisal data with PostGIS geometry

Columns:
- `id` UUID PRIMARY KEY
- `county_fips` TEXT — FIPS county code (e.g., "48491" for Williamson TX)
- `parcel_id` TEXT — County-assigned parcel identifier
- `geometry` GEOMETRY(Polygon, 4326) — PostGIS polygon for parcel boundary
- `address` TEXT
- `city` TEXT
- `zip_code` TEXT
- `improvement_value` NUMERIC — Assessed value of structures
- `land_value` NUMERIC — Assessed value of land
- `total_value` NUMERIC — Assessed total
- `square_footage` INTEGER
- `lot_size_acres` NUMERIC
- `year_built` INTEGER
- `subdivision` TEXT
- `property_type` TEXT — residential, commercial, agricultural, etc.
- `roof_material` TEXT — if available from county data
- `ingestion_source` TEXT — Foreign key to county_data_sources
- `ingestion_date` TIMESTAMPTZ
- `raw_metadata` JSONB — Source-specific extras

Service role grants required per Contract 64. RLS policies: operator-only (Phase 1.5; Phase 2 may extend client-scoped read access when lead enrichment products ship).

**county_data_sources** — Registry of which counties have which data access tier

Columns:
- `id` UUID PRIMARY KEY
- `county_fips` TEXT UNIQUE
- `county_name` TEXT
- `state` TEXT
- `tier` TEXT CHECK IN ('tier_1_api', 'tier_2_bulk', 'tier_3_none')
- `access_method` TEXT — e.g., 'socrata', 'arcgis_rest', 'csv_download', 'shapefile_download'
- `api_url` TEXT — Nullable for Tier 2/3
- `download_url` TEXT — Nullable for Tier 1/3
- `dataset_inventory` JSONB — List of available datasets per source
- `last_ingestion_date` TIMESTAMPTZ
- `next_refresh_due` TIMESTAMPTZ
- `is_active` BOOLEAN DEFAULT TRUE
- `notes` TEXT

Service role grants required per Contract 64. RLS policies: operator-only.

**Status:** SCHEMA LOCKED, MIGRATIONS NOT YET GENERATED.

**Verified Phase 1.5 Scope (2026-05-21):**
- Tier 1 (free programmatic API): Williamson, Bexar, Hays counties (Texas)
- Tier 2 (free annual bulk file): Travis, Bell counties (Texas)
- Tier 3 (no public data path): All other counties default to Tier 3 until verified

---

## PHASE 1.5 AEO/VOICE/CONVERSION TABLES (Contract 61)

Tables declared by A-25, A-26, A-27, A-46, A-47 specifications. Migrations not yet generated — schema lock first, build later.

**page_atomic_facts** (A-25) — Atomic factual statements per page with explicit data attribution.
**entity_references** (A-25) — Entity mentions per page.
**entity_normalization_map** (A-25) — Per-client canonical entity naming.
**page_entities** (A-26) — Entities present on each page with Schema.org typing.
**entity_verification_status** (A-26) — sameAs URL verification status per entity.
**voice_keyword_targets** (A-27) — Voice-query keyword targets per page.
**page_voice_optimization_score** (A-27) — Voice optimization completeness scores.
**voice_query_patterns** (A-27) — Per-client voice query patterns from Decodo + PAA data.
**conversion_form_variants** (A-46) — Form variant pool with performance metrics.
**conversion_form_renders** (A-46) — Which variant rendered on which page render.
**ab_test_results** (A-46) — Per-variant conversion rate tracking.
**llm_citation_events** (A-47) — Individual citation events (timestamp, engine, query, cited_url).
**llm_citation_summary** (A-47) — Rollups per page per period.
**target_query_lists** (A-47) — Per-client target queries for citation tracking.
**citation_displacement_alerts** (A-47) — Competitor displacement detection.

**Status:** SCHEMA LOCKED, MIGRATIONS NOT YET GENERATED.

---

## PHASE 1.5 DEFENSIVE INFRASTRUCTURE TABLES (Contract 59)

Tables declared by A-35 expansion + A-38, A-39, A-42 specifications. Migrations not yet generated — schema lock first, build later.

**page_fingerprint_log** (A-35 expanded) — Per-page variant tuple selection log for fingerprint auditing.
**http_diffusion_config** (A-38) — Per-tenant HTTP diffusion ranges and active diffusion configuration.
**link_graph_topology** (A-39) — Per-client computed hub/leaf classification for power-law link distribution.
**penalty_pattern_alerts** (A-42) — Timestamped penalty signal detections.
**tenant_generation_freeze** (A-42) — Active freeze list for tenants with detected penalty signals.
**diagnostic_reports** (A-42) — Per-incident diagnostic packages for penalty investigations.

(Extends client_component_variations from A-35 original spec — no schema change to that table, just new axis values.)
(Extends internal_links from A-06 original spec — adds anchor_text_variant column for A-39.)

**Status:** SCHEMA LOCKED, MIGRATIONS NOT YET GENERATED.

---

## PHASE 1.5 + PHASE 2 AUTHENTICITY/TRUST/INGESTION TABLES (Contract 60)

Tables declared by A-40, A-41, A-43, A-44, A-45 specifications. Migrations not yet generated — schema lock first, build later.

**A-40 External Signal Coordination:**
- external_signal_opportunities — Quality-ranked opportunity list
- client_directory_registrations — Tracking client-completed registrations
- unlinked_mentions_log — Mentions detected awaiting client outreach

**A-41 Engagement Quality:**
- page_engagement_score — Per-page engagement metrics rollup
- pre_publish_quality_flags — Issues caught before publish
- post_publish_engagement_alerts — Issues caught after live traffic

**A-43 Trust Signal Composer:**
- page_trust_signals — Composed trust signals per page
- trust_signal_validation_log — Per-signal validation history

**A-44 Client Knowledge Ingestion (PHASE 1 — RELOCATED 2026-05-23):**

A-44 was originally declared at Phase 1.5 in this section. Per operator decision 2026-05-23, A-44 is relocated to Phase 1 as a mandatory prerequisite for A-02 Page Generator. Contract 73 (Pre-Generation Knowledge Ingestion Requirement) enforces the prerequisite.

The following tables are A-44's Phase 1 storage layer and ship with Phase 1 RBAC + A-44 migrations:

- client_ingested_assets — Raw captures from client site crawl, per-asset metadata (source URL, capture date, asset type, classification confidence, asset_version, is_current)
- client_brand_voice_model — Per-client voice and terminology model used by A-02 and A-25
- client_keyword_gap_analysis — Keywords client should rank for but doesn't
- (extends evidence_items for ingested photo imports)

These tables join the new client_ingestion_versions table (Migration N+4, Table 87) which provides version-management metadata across multiple scrapes per client.

**Status:** Migrations pending Phase 1 generation. Full canonical specification in BLUEPRINT.md Part 10.5 and ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 7.

**A-45 Backlink Intelligence:**
- backlink_inventory — Per-client existing backlinks with quality scores
- toxic_backlink_alerts — Detected toxic links
- disavow_recommendations — Disavow file update suggestions
- unlinked_mention_opportunities — Mentions without link, ranked
- directory_registration_opportunities — Legitimate directory targets
- competitor_backlink_gaps — Competitor backlinks client lacks

**Status:** SCHEMA LOCKED, MIGRATIONS NOT YET GENERATED.

Total tables across Prompt 3: 16 new tables.

---

## PHASE 2+ DEFERRED TABLES (A-31 Lead Download Engine)

Tables declared but NOT scheduled for migration generation until A-31 build prerequisites met.

**A-31 Lead Download Engine (DEFERRED):**
- lead_downloads — Per-download record with operator_id, polygon_geometry, lead_count, total_charge
- property_data_cache — Cached ATTOM API responses with 90-day TTL
- hail_swath_polygons — Saved polygon geometries for repeat queries

**Status:** SCHEMA SLOT CLAIMED, MIGRATIONS NOT GENERATED, BUILD DEFERRED.

---

## 2026-05-20 TIER 2 SERVICE HUB ARCHITECTURE SCHEMA

Schema additions supporting three-tier hub-and-spoke page hierarchy (Tier 1 homepage → Tier 2 service hubs → Tier 3 location pages). Service hubs require Opus-based generation, G16 Hub Completeness gate validation, and operator review before publication. See docs/architecture/service-hub-pages-spec.md.

### service_hub_versions (new table)

**Purpose:** Version history tracking for service hub pages. Service hubs are higher-authority pages requiring version control for content updates and quality regression monitoring.

**Key columns:**
- `id` UUID PRIMARY KEY
- `page_id` UUID REFERENCES pages(id) — FK to service hub page
- `client_id` UUID REFERENCES clients(id) — FK for RLS filtering
- `version_number` INTEGER — Monotonic version per page
- `content` TEXT — Full page content at this version
- `llm_call_id` UUID REFERENCES llm_calls(id) — Which LLM call generated this version
- `created_at` TIMESTAMPTZ — When this version was created
- `created_by_operator_id` UUID REFERENCES users(id) — Which operator triggered regeneration

**Unique constraint:** (page_id, version_number)

### hub_review_queue (new table)

**Purpose:** Operator review queue for service hub pages that passed G16 but require human approval before publication. Service hubs have elevated quality standards and cannot auto-publish without operator sign-off.

**Key columns:**
- `id` UUID PRIMARY KEY
- `page_id` UUID REFERENCES pages(id) — FK to hub page pending review
- `client_id` UUID REFERENCES clients(id) — FK for RLS filtering
- `queued_at` TIMESTAMPTZ — When page entered review queue
- `priority` TEXT — Priority level (standard/high/urgent)
- `review_status` TEXT — Status (pending/approved/rejected/changes_requested)
- `reviewed_at` TIMESTAMPTZ — When operator completed review
- `reviewed_by_operator_id` UUID REFERENCES users(id) — Which operator reviewed
- `review_notes` TEXT — Operator feedback for rejected pages

**Integration:** A-05 sets pages.status='pending_hub_review' and inserts hub_review_queue row when G16 passes. Operator dashboard surfaces queue entries for manual review.

### link_audit_log (new table)

**Purpose:** Audit trail for A-06 Internal Linker operations. Tracks all internal link additions, removals, and modifications for debugging link graph issues and enforcing parent_hub_id FK consistency.

**Key columns:**
- `id` UUID PRIMARY KEY
- `client_id` UUID REFERENCES clients(id) — FK for RLS filtering
- `agent_event_id` UUID REFERENCES agent_events(id) — FK to A-06 execution that made this change
- `action` TEXT — Action type (link_added/link_removed/link_modified)
- `from_page_id` UUID REFERENCES pages(id) — Source page
- `to_page_id` UUID REFERENCES pages(id) — Target page
- `anchor_text` TEXT — Link anchor text
- `created_at` TIMESTAMPTZ — When action occurred
- `metadata` JSONB — Additional context (reason, previous anchor text for modifications)

**Usage:** Debugging "why doesn't page X link to page Y" questions. Operator can query audit log to see A-06's link decisions over time.

### page_indexation (Table — A-08)

**Purpose:** GSC URL Inspection API integration data per page. Stores Google's indexation status, coverage state, and inspection metadata for A-08 Indexation Tracker to monitor and report on indexation health.

**Key columns:**
- `id` UUID PRIMARY KEY DEFAULT gen_random_uuid()
- `page_id` UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE
- `client_id` UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE
- `indexation_status` TEXT NOT NULL CHECK (indexation_status IN ('not_submitted', 'discovered', 'crawled', 'indexed', 'excluded', 'error'))
- `coverage_state` TEXT CHECK (coverage_state IN ('valid', 'valid_with_warnings', 'error', 'excluded'))
- `last_crawled_at` TIMESTAMPTZ — When Google last crawled this page (from GSC API)
- `errors_json` JSONB — GSC-reported errors
- `checked_at` TIMESTAMPTZ NOT NULL DEFAULT NOW() — When A-08 checked this page
- `created_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()
- `updated_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()

**Indexes:**
- `idx_page_indexation_page_id` ON (page_id)
- `idx_page_indexation_client_id` ON (client_id)
- `idx_page_indexation_status` ON (indexation_status)
- `idx_page_indexation_checked_at` ON (checked_at DESC)
- `idx_page_indexation_latest_per_page` UNIQUE ON (page_id, checked_at DESC) — Most recent check per page

**RLS:** Enabled. Policy `page_indexation_client_read` allows clients to SELECT their own pages only.

**Integration:** A-08 calls GSC URL Inspection API, stores result in page_indexation. Dashboard reads this table to show indexation status per page.

**Migration:** `20260520220000_a08_indexation_schema.sql`

### gsc_rate_limits (Table — A-08)

**Purpose:** GSC API daily rate limit tracking. URL Inspection API quota is 200 requests/day per property (binding constraint). Atomic increment via RPC function.

**Key columns:**
- `client_id` UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE
- `requests_today` INTEGER NOT NULL DEFAULT 0 — Request count for current day
- `daily_limit` INTEGER NOT NULL DEFAULT 200 — GSC daily quota (200 req/day)
- `reset_at` TIMESTAMPTZ NOT NULL — When counter resets (midnight UTC)
- `updated_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()

**RLS:** Enabled, no policies (service-role only, matches security model)

**Usage:** A-08 calls `increment_gsc_request_count(client_id)` RPC after each GSC API call. RPC atomically increments counter, eliminating race condition from manual UPDATE.

**Migration:** `20260520220000_a08_indexation_schema.sql`

### oauth_state_tokens (Table — OAuth Security)

**Purpose:** Stores one-time-use state tokens for OAuth flows with 10-minute TTL. Implements CSRF protection per Contract 67 (Resource Ownership Verification). Tokens expire after 10 minutes and are marked as used after consumption to prevent replay attacks.

**Key columns:**
- `id` UUID PRIMARY KEY DEFAULT gen_random_uuid()
- `user_id` UUID NOT NULL — Operator user who initiated the OAuth flow
- `state_token` TEXT NOT NULL UNIQUE — One-time CSRF token (validated during OAuth callback)
- `expires_at` TIMESTAMPTZ NOT NULL — Token expiration (10 minutes from creation)
- `used_at` TIMESTAMPTZ — Timestamp when token was consumed (NULL = unused)
- `created_at` TIMESTAMPTZ NOT NULL DEFAULT now()

**Indexes:**
- `idx_oauth_state_tokens_state_token` ON (state_token) — Fast state token lookups during OAuth callback
- `idx_oauth_state_tokens_expires_at` ON (expires_at) — Cleanup of expired tokens

**RLS:** Enabled. Policy "Operators can view own state tokens" restricts SELECT to authenticated operators (non-client users) viewing their own tokens only.

**Security:**
- Tokens are single-use: `used_at` timestamp marks consumption
- Expired tokens (> 10 minutes old) are invalid even if unused
- Background cleanup job deletes expired tokens to prevent table bloat

**Service role grants:** SELECT, INSERT, UPDATE, DELETE (Contract 64)

**Migration:** `20260521120000_oauth_state_tokens.sql`

### client_gsc_credentials (Table — A-08 OAuth)

**Purpose:** Per-client Google Search Console OAuth credentials. Each client connects their own GSC property via operator-initiated OAuth flow.

**Key columns:**
- `id` UUID PRIMARY KEY DEFAULT gen_random_uuid()
- `client_id` UUID NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE
- `gsc_property_url` TEXT NOT NULL — GSC property URL (e.g., 'sc-domain:example.com')
- `refresh_token_encrypted` TEXT NOT NULL — Encrypted via pgp_sym_encrypt with GSC_TOKEN_ENCRYPTION_KEY
- `gsc_user_email` TEXT NOT NULL — Google account that authorized
- `scopes` TEXT[] NOT NULL DEFAULT ARRAY['https://www.googleapis.com/auth/webmasters.readonly']
- `last_refreshed_at` TIMESTAMPTZ — When access token last refreshed
- `access_token_expires_at` TIMESTAMPTZ — When current access token expires
- `created_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()
- `updated_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()

**RLS:** Enabled, no policies (service-role only, matches gsc_rate_limits security model)

**Security:**
- Refresh tokens encrypted at rest using pgcrypto pgp_sym_encrypt
- Decryption requires GSC_TOKEN_ENCRYPTION_KEY environment variable
- OAuth flow validates state tokens (Contract 67 CSRF protection)

**Usage:** A-08 agent calls `getGSCAccessTokenForClient(client_id)` which queries this table, decrypts refresh_token, exchanges for fresh access_token via Google OAuth API. Falls back to mock mode if no credentials exist for client.

**Migration:** `20260522180100_add_client_gsc_credentials.sql`

### increment_gsc_request_count (RPC Function — A-08)

**Purpose:** Atomically increment GSC API request counter for client. Eliminates race condition from manual UPDATE.

**Signature:** `increment_gsc_request_count(p_client_id uuid) RETURNS integer`

**Behavior:**
- Upserts `gsc_rate_limits` row: INSERT with count=1 if not exists, UPDATE increments existing count
- Returns new count after increment
- SECURITY DEFINER (runs with definer privileges)
- Transaction-safe atomic increment

**Usage:** Called by A-08 agent after successful GSC API call via `supabase.rpc('increment_gsc_request_count', { p_client_id: clientId })`

**Grant:** EXECUTE permission to service_role (Contract 64)

**Migration:** `20260522180000_add_gsc_request_count_rpc.sql`

### pages table extensions (hub-and-spoke columns)

**New columns added for service hub support:**

- `parent_hub_id` UUID REFERENCES pages(id) NULLABLE — FK to parent service hub page. Location pages (Tier 3) link to service hub (Tier 2); service hubs link to homepage (Tier 1) or NULL. Enforces hub-and-spoke hierarchy.

- `is_hub` BOOLEAN DEFAULT FALSE — TRUE for service hub pages (Tier 2). Used by A-06 to identify hub pages for spoke-linking logic.

- `hub_review_status` TEXT NULLABLE — Review status for service hub pages (pending/approved/rejected/changes_requested). NULL for non-hub pages.

- `hub_review_completed_at` TIMESTAMPTZ NULLABLE — When operator completed review for this hub page. NULL until review complete.

- `hub_review_operator_id` UUID REFERENCES users(id) NULLABLE — Which operator reviewed this hub page. NULL until review complete.

**intent enum extension:**

Added 'service-hub' to pages.intent enum values. Full enum now: ('service-area', 'service-city', 'storm-reactive', 'service-hub').

**page_status enum extension:**

Added 'pending_hub_review' and 'approved_for_publish' to page_status enum values. Service hub pages flow: draft → pending_hub_review → approved_for_publish → published.

### tenant_signals table extension

**New column:**

- `source_agent` TEXT NULLABLE — Which agent created this tenant signal (A-01, A-02, A-05, A-06, etc.). Previously stored in metadata JSONB; promoted to top-level column for easier filtering and querying.

**Migration:** 20260521000000_tenant_signals_source_agent.sql (applied 2026-05-20)

**Usage:** Operator dashboard can filter signals by source agent. Example: "Show me all A-05 validation failure signals for client X."

**Cross-reference:** See docs/architecture/service-hub-pages-spec.md for complete service hub workflow specification.

---

## RBAC HELPER FUNCTIONS AND TRIGGERS

### Function: user_has_operator_role(uid UUID) — Pattern A RLS Helper

Used by RLS policies that grant operator-side multi-role read access. Returns TRUE if the user holds any active role in ('master_admin', 'senior_admin', 'va'). Migration: applied as part of Migration N+1.

```sql
CREATE OR REPLACE FUNCTION user_has_operator_role(uid UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_id = uid
      AND role IN ('master_admin', 'senior_admin', 'va')
      AND revoked_at IS NULL
  )
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Allow execution from any authenticated context
GRANT EXECUTE ON FUNCTION user_has_operator_role(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION user_has_operator_role(UUID) TO service_role;
```

### Function: user_active_role(uid UUID) — Application-Layer Helper

Returns the active role for a given user. Used by application code via Supabase RPC when role context is needed but the application cannot maintain a fresh cache. Migration: applied as part of Migration N+1.

```sql
CREATE OR REPLACE FUNCTION user_active_role(uid UUID)
RETURNS TEXT AS $$
  SELECT role FROM user_roles
  WHERE user_id = uid
    AND revoked_at IS NULL
  LIMIT 1
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION user_active_role(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION user_active_role(UUID) TO service_role;
```

### Trigger: role_grant_audit_on_user_roles_change

Automatically writes a role_grant_audit row whenever user_roles INSERT or UPDATE happens. Provides automatic audit trail enforcement at the database layer in addition to application-layer logging. Defense-in-depth.

```sql
CREATE OR REPLACE FUNCTION write_role_grant_audit()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Grant event
    INSERT INTO role_grant_audit (
      event_type,
      target_user_id,
      role,
      granted_by_user_id,
      granted_by_role,
      justification,
      created_at
    ) VALUES (
      'granted',
      NEW.user_id,
      NEW.role,
      COALESCE(NEW.granted_by, '00000000-0000-0000-0000-000000000001'::uuid),
      COALESCE((SELECT role FROM user_roles WHERE user_id = NEW.granted_by AND revoked_at IS NULL LIMIT 1), 'system'),
      'Grant via user_roles INSERT (auto-audit trigger)',
      NEW.granted_at
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Detect revocation
    IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
      INSERT INTO role_grant_audit (
        event_type,
        target_user_id,
        role,
        granted_by_user_id,
        granted_by_role,
        justification,
        created_at
      ) VALUES (
        'revoked',
        NEW.user_id,
        NEW.role,
        COALESCE(NEW.revoked_by, '00000000-0000-0000-0000-000000000001'::uuid),
        COALESCE((SELECT role FROM user_roles WHERE user_id = NEW.revoked_by AND revoked_at IS NULL LIMIT 1), 'system'),
        COALESCE(NEW.revocation_reason, 'Revocation via user_roles UPDATE (auto-audit trigger)'),
        NEW.revoked_at
      );
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_role_grant_audit
  AFTER INSERT OR UPDATE ON user_roles
  FOR EACH ROW
  EXECUTE FUNCTION write_role_grant_audit();
```

### Trigger: clients_ingestion_version_uniqueness_guard

Defense-in-depth trigger that ensures only one client_ingestion_versions row per client has is_current=TRUE. The partial unique index in Migration N+4 enforces this at the database level; this trigger adds an explicit error message for the application layer.

```sql
CREATE OR REPLACE FUNCTION enforce_ingestion_version_uniqueness()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_current = TRUE THEN
    -- Verify no other row for this client has is_current=TRUE
    IF EXISTS (
      SELECT 1 FROM client_ingestion_versions
      WHERE client_id = NEW.client_id
        AND is_current = TRUE
        AND id != NEW.id
    ) THEN
      RAISE EXCEPTION 'Contract 73 violation: only one client_ingestion_versions row per client may have is_current=TRUE. Mark prior current=FALSE before promoting a new version.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ingestion_version_uniqueness
  BEFORE INSERT OR UPDATE OF is_current ON client_ingestion_versions
  FOR EACH ROW
  EXECUTE FUNCTION enforce_ingestion_version_uniqueness();
```

### Performance Notes

- `user_has_operator_role()` is called by every Pattern A RLS policy. Index on `user_roles(user_id, role) WHERE revoked_at IS NULL` ensures lookup is O(1) per call.
- `user_active_role()` is called less frequently (only when application explicitly requests role context). Same index serves both functions.
- The role_grant_audit trigger fires synchronously on user_roles writes. Volume is low (role grants are rare events).
- The ingestion_version_uniqueness trigger fires on every client_ingestion_versions INSERT/UPDATE. Frequency is moderate but the trigger executes a single indexed lookup. No expected performance impact.

---

## SCHEMA DRIFT DETECTOR

A script at `scripts/verify-schema.ts` compares:
- Live Supabase schema (queried via REST API)
- This SCHEMA_REGISTRY.md document
- Migration files in `supabase/migrations/`

Any mismatch blocks commits via the pre-commit hook. Schema must be fixed via versioned migration file before commit succeeds. See Contract 29 in BEHAVIORAL_CONTRACTS.md.

---

## Migration 20260527180013: service_area_mode enum and column

**Date:** 2026-05-27
**Purpose:** Support nationwide service area model (master_admin override)

**Changes:**
1. New enum type `service_area_mode_type` with values: 'radius', 'nationwide'
   - Future-reserved: 'multi_region' (polygon or city-list based)
2. New column `clients.service_area_mode` of type `service_area_mode_type`, NOT NULL, DEFAULT 'radius'
3. All existing 76 client rows backfilled to 'radius' (preserves current behavior)

**Semantics:**
- **radius mode (default):** Traditional service_radius_miles + business_address center point model
- **nationwide mode (master_admin only):** All US cities ≥25K population per cities master table
- Future multi_region mode: Polygon or explicit city-list (not yet implemented)

**Operational Impact:**
- A-01 intake processor branches on service_area_mode
- A-21 hyperlocal geographic engine treats nationwide as no geographic constraint
- Tier-level page count caps STILL APPLY (nationwide doesn't bypass tier limits)
- Master_admin role cap: SERVICE_RADIUS_MILES raised 500 → 5000 miles (large regional clients)
- Master_admin-only: SERVICE_AREA_NATIONWIDE_ENABLED RoleCap gates nationwide toggle in UI

**Column Comment:**
> Service area model. radius = traditional service_radius_miles + business address center. nationwide = all US cities ≥25K population per cities master table (master_admin override only). Future: multi_region (polygon or city-list).

