# TARRITRIX 1.0  MASTER ARCHITECTURAL BLUEPRINT
**Version:** 2.0 CONSOLIDATED | **Status:** Active Build Reference
**Base Document:** Operator's Original Revised Master Architectural Blueprint (preserved verbatim below)
**Additions:** 2026-05-05 Governance Reset (appended after original)

This document preserves the operator's original blueprint in full. Sections marked PART 0 through PART 7 are the original document, preserved verbatim. New 2026-05-05 additions appear as PART 8 onward and do not replace anything from the original.

Where this blueprint and MASTER_BUILD_SPEC.md conflict on tactical Phase 1 decisions (color palette, exact surfaces, exit criteria), MASTER_BUILD_SPEC.md wins.

---

# ============================================================================
# ORIGINAL BLUEPRINT BEGINS HERE  PRESERVED VERBATIM
# ============================================================================

REVISED MASTER ARCHITECTURAL BLUEPRINT
Enterprise Programmatic Local SEO Platform - COMPLETE
Reading time: 45 minutes
Completeness: 100% - Ready for document production
________________________________________
PART 0: REVISION SUMMARY
What Changed in This Revision:
Added 6 New Agents:
	A-14: Review Velocity Engine (Phase 1)
	A-15: GBP Post Generator (Phase 2)
	A-16: Q&A Seed Manager (Phase 2)
	A-17: Entity Consistency Monitor (Phase 2)
	A-18: Job Evidence Ingestion Engine (Phase 1 - CRITICAL)
	A-19: Universal Integration Hub (Phase 1 - CRITICAL)
Expanded 2 Existing Agents:
	A-10: Content Profile Builder (added service area heatmap data collection)
	A-12: GBP Agent (added completeness scoring + image category balance)
Added 8 New Database Tables:
	job_evidence
	job_content_linkage
	client_integrations
	integration_field_mappings
	review_requests
	gbp_posts
	qa_seeds
	entity_audit_log
Added New Onboarding Step:
	Step 8: Integration Setup (field service software connection)
Added Complete ENV Variable Specification
Total Agent Count: 11   17 agents + 2 CRON jobs
________________________________________
PART 1: EXECUTIVE SUMMARY
What Tarritrix Is
A closed-operator SaaS platform that generates programmatic SEO landing pages for service-area businesses (HVAC, plumbing, roofing, electrical) with AUTOMATED SUSPENSION/PENALTY MITIGATION as the core competitive moat.
Not: A generic page generator, another SEO agency tool
Is: The world's first local SEO platform with built-in Google penalty prevention architecture + real-time job-to-SEO pipeline + AI visibility tracking
Core Value Propositions
1. The Content Moat
	4-layer content differentiation prevents doorway page penalties
	3-phase publishing velocity prevents sandbox penalties
	15-gate pre-publish validation prevents quality penalties
2. The Activity Moat (NEW)
	Every completed job   fresh proof   page refresh   GBP post
	Review velocity engine converts jobs   reviews   responses
	Real-time activity signals Google can't ignore
3. The GBP Moat
	Edit velocity throttling prevents suspension
	Auto-reject monitoring prevents competitor sabotage
	Completeness scoring + Q&A seeding maximizes profile strength
4. The AI Moat (Phase 2)
	ChatGPT/Gemini/Perplexity rank tracking
	Share of voice measurement
	AI sentiment monitoring
5. The Storm Moat (Phase 3 - Storm Intelligence Engine)
	**Pre-positioned geographic coverage before storms hit** (primary capability)
	Real-time storm event detection triggers GBP posts, content refreshes, and indexation priority
	Reactive page creation for coverage gaps (secondary capability)
	NO COMPETITOR CAN REPLICATE without Storm Intelligence Engine data

## COMPETITIVE DIFFERENTIATION: AEO (Answer Engine Optimization)

AI Answer Engine Optimization (AEO) is Tarritrix's strategic moat for the post-Google search era. Where competitors optimize for traditional Google SERP, Tarritrix optimizes for citation by ChatGPT, Perplexity, Claude, and Gemini. A-25 AEO Engine Suite (11 submodules) ships in Phase 1.5. A-47 AI Citation Tracking measures effectiveness. Together these constitute the platform's hardest-to-replicate competitive advantage.

**Why this matters:** By 2027-2028, AI answer engines are estimated to capture 20-30% of search volume. Contractors who rank in ChatGPT Search and Perplexity answers will capture demand before prospects ever reach Google's SERP. Early-mover advantage in AEO is defensible because it requires:
1. LLM-native content structuring (A-25.1 through A-25.10)
2. Citation tracking infrastructure (A-25.11 + A-47)
3. Multi-engine optimization (not just ChatGPT, but Perplexity, Claude, Gemini, Bing Chat)
4. Continuous measurement and feedback loops

Competitors building traditional SEO platforms will struggle to retrofit AEO — it requires ground-up content architecture changes, not surface-level metadata tweaks. Tarritrix ships with AEO baked into the page generation pipeline.

________________________________________
PART 1.5: OPERATIONAL DISCIPLINES
Ground Truth Tenant Validation
Tarritrix operates two internal tenants as live canaries before exposing any agent to external paying clients:
1. Tarritrix Roofing — Tarritrix's own self-hosted page network
2. E4 Construction & Roofing — Reid's existing roofing business

Every agent that ships must be validated against these ground-truth tenants in production. This surfaces ~80% of bugs before customer impact (Stripe-on-Stripe, Shopify-on-Shopify pattern), validates agents against real-world data rather than test fixtures, generates proof-of-results case studies for sales, and validates penalty-prevention claims empirically before charging clients for them.

After any agent ships to master and reaches Vercel READY, the operator manually triggers the agent against E4 (and Tarritrix where applicable). Results are observed for at least one full execution cycle (24h for fast agents, 14-30d for ranking/indexation agents). External client onboarding is blocked until ground truth validation passes.

See docs/ground-truth-tenant.md for complete validation protocol.
________________________________________
PART 2: BUSINESS MODEL & PRICING
Revenue Model
Closed platform - operator-controlled client onboarding, not self-serve
4-tier pricing:

| Tier | Setup | Monthly | Cities | Services | Cities " Services | Page Cap (Phase 3 max) | Rewrites Included | Rewrite SLA |
|---|---|---|---|---|---|---|---|---|
| Starter | $997 | $497 | 5 | 1 | 5 | 3/day | 0 | N/A |
| Growth | $2,497 | $997 | 15 | 3 | 45 | 9/day | 2/month | 72 hours |
| Authority | $4,997 | $1,997 | 30 | 5 | 150 | 18/day | 10/month | 72 hours |
| Dominance | $9,997 | $3,497 | 60 | 8 | 480 | 40/day | 30/month + $50 each beyond cap | 24 hours priority |

(Drip rates canonical per Final Consolidated Tier Table, BLUEPRINT.md Part 9 Section 9.2. Older rates superseded by operator decision 2026-05-15 per audit reconciliation.)

Drip rate progression (Phase 1/2/3):
- Starter: 1/day → 2/day → 3/day
- Growth: 4/day → 6/day → 9/day
- Authority: 8/day → 12/day → 18/day
- Dominance: 15/day → 25/day → 40/day

Tier strategy notes:
- Insurance claim rewrites are an integrated platform feature, NOT a standalone service offering. Bundled inclusion preserves SaaS revenue categorization for valuation purposes.
- Rewrites consumed beyond Dominance's 30/month cap charge at $50 each (50% off implied $100 retail)  preserves margin while removing user friction.
- Dominance tier exists for multi-location operators and regional storm chasers running 30+ claims/month plus high city/service density requirements.
- Tier ladder creates compelling upsell path: zero rewrites in Starter creates obvious step-up to Growth; 2/month in Growth previews value; 10/month in Authority covers typical storm-active contractor; 30/month + priority in Dominance for scaling operations.
Phase transitions:
	Phase 1: Days 1-30 from onboarding
	Phase 2: Days 31-60
	Phase 3: Days 61+
Daily variance: +/-20% randomization to prevent "exactly N pages at 3am" detection pattern
White-Label B2B2C Model (Future)
	Phase 3+ feature
	API access for resellers
	Resellers rebrand as their own product
	Volume pricing tiers for resellers
________________________________________
PART 3: THE 17 AGENTS + 2 CRON JOBS
3.1 Agent Execution Architecture
Runtime: Supabase Edge Functions
Orchestration: Event-driven via Supabase Realtime + pg_cron
Long tasks: Supabase Queue (pgmq extension)
State management: PostgreSQL with RLS

3.2 Complete Agent Dependency Graph

```
'
                    CLIENT ONBOARDING COMPLETE                    

                          
        '
          A-01: Intake Processor                
           Validates all client data           
           Normalizes inputs                   
           Tier enforcement                    
        
                          
        '
          A-10: Content Profile Builder         
           Builds 4-layer differentiation      
           Geographic signal injection         
           Service area heatmap data (NEW)     
        
                          
        '
          A-02: Page Generator                  
           LLM content generation              
           Claims-stripping                    
           AI disclosure                       
        
                          
        '
          A-03: Schema Generator                
           LocalBusiness JSON-LD               
           Service, FAQ, Breadcrumb            
           Validation                          
        
                          
        '
          A-04: Map Embed Generator             
           Google Maps iframe                  
           Per-client API key                  
        
                          
        '
          A-05: Page Validator (15 Gates)      
           Quality scoring                     
           Similarity check                    
           WCAG, CWV, TCPA validation          
        
                         
                '
                                 
             PASS              FAIL
                                 
                                   
    '   '
     status='queued'     status='flagged'     
        Operator Review      
                          
    '
      A-06: Internal Link Builder    
       Hub-and-spoke structure      
       Contextual linking           
    
              
    '
      A-07: Sitemap Generator        
       XML sitemap                  
       robots.txt with AI crawlers  
    
              
    '
      CRON-01: Drip Publisher        
       Daily 3am UTC                
       Velocity enforcement         
       Random variance              
    
              
    '
      pages.status = 'published'     
    
              
    '
      A-08: Indexation Tracker       
       GSC API monitoring           
       Coverage state tracking      
    

'
                    ONGOING BACKGROUND PROCESSES                   


'
  A-09: Conversion Handler (Webhook - Always Listening)          
   Form submissions                                              
   CallRail webhooks                                             
   TCPA consent immutability                                     


'
  A-11: Content Refresh Engine (Monthly Cycle)                   
   Top N page refresh                                            
   Places API data update                                        
   Content hash comparison                                       


'
  CRON-02: Indexation Runner (Daily 6am UTC)                     
   Runs A-08 for all clients                                     
   Cross-tenant leak detection                                   
   Monthly pruning job                                           


'
                    JOB COMPLETION PIPELINE (NEW)                  


                    External Event: Job Completed
                               
        '
          A-19: Universal Integration Hub (NEW)  
           Field service software webhooks      
           Normalize payload                    
           Create job_evidence record           
        
                          
        '
          A-18: Job Evidence Ingestion (NEW)     
           SMS + Email photo upload request     
           Magic link generation                
           Photo receipt + validation           
        
                   
          '
                             
'  '
  A-14: Review        A-15: GBP Post      
  Velocity Engine     Generator (NEW)     
  (NEW)                Auto-draft post   
   Review req         Service+location  
   Response           Schedule publish  
  
                            
       
                   
        '
          A-11: Content Refresh Engine           
           Triggered by new job evidence        
           Refresh relevant city page           
           Inject fresh proof                   
        

'
                    GBP MANAGEMENT (Phase 1.5+)                    


        '
          A-12: GBP Agent (EXPANDED)             
           Edit velocity throttling             
           Auto-reject monitoring               
           Completeness scoring (NEW)           
           Image category balance (NEW)         
           Recurring posts (Phase 2)            
        

        '
          A-16: Q&A Seed Manager (NEW - Phase 2) 
           Industry-specific templates          
           Auto-generate Q&A pairs              
           Approval workflow                    
        

'
                    ENTITY & AI MONITORING (Phase 2)               


        '
          A-17: Entity Consistency Monitor (NEW) 
           Cross-platform NAP audit             
           Discrepancy detection                
           Auto-correction where possible       
        

        '
          A-13: AI Visibility Monitor (Phase 2)  
           ChatGPT/Gemini/Perplexity scraping   
           Rank tracking                        
           Sentiment analysis                   
           Share of voice calculation           
        
```

________________________________________
3.3 Complete Agent Specifications

A-01: INTAKE PROCESSOR
Phase: 1 (required before any generation)
Trigger: Onboarding wizard completion   stack_job created
Runtime: Edge Function
Timeout: 30s
Purpose: Validate and normalize all client data before any page generation begins

Inputs:
```typescript
{
  client_id: UUID,
  business_legal_name: string,
  business_dba: string,
  industry: string,
  address: Address,
  phone: string, // E.164 format required
  website_url: string,
  target_cities: Array<{city: string, state: string}>,
  services: Array<{service_name: string}>,
  consent: ConsentObject
}
```

Validation Steps:
1. Consent validation (all must be true)
2. Phone normalization (E.164 format)
3. Tier enforcement (cities/services within limits)
4. Website validation (HTTPS, reachable)
5. Geocoding (Google Maps API)
6. Industry exclusion check (cannabis, firearms, etc.)

Outputs:
 Updates clients table with normalized data
 Emits intake.completed event
 Sets stack_jobs.status = 'completed'

Failure Handling:
 Geocoding fails   operator alert
 Consent missing   hard fail
 Tier exceeded   upgrade prompt

**Additional capabilities (2026-05-17 augmentation):**

- **Crawlability pre-validation** — Validate client domain robots.txt rules, canonical logic, renderability, and indexability before any page generation begins. Prevents large-scale wasted indexing on misconfigured client domains.
- **Locality confidence scoring** — Score whether the client's claimed service area is geographically plausible (drive time from business address, population density). Flags clients claiming impossible service radii for operator review.
- **Duplicate-client suppression** — Detect overlapping service territories between existing platform clients. Prevents cross-tenant cannibalization where two clients in the same metro compete for identical local SERPs.

________________________________________

A-02: PAGE GENERATOR
Phase: 1 (depends on A-10 completion first)
Trigger: A-10 completes content profile   A-02 generates content
Runtime: Supabase Queue (long-running)
Timeout: None (queue-based)
Purpose: Generate city " service page content using LLM with all 4 differentiation layers

Process:
1. Receives structured context from A-10 (4 layers)
2. Calls Anthropic Claude API with prompt
3. Post-generation: Scans for quantified claims
4. Cross-references against claimed_facts table
5. Strips unverified claims
6. Adds AI content disclosure
7. Stores with content_hash

LLM Prompt Structure:
 System prompt (operator-controlled, quality standards, prohibitions)
 User prompt with XML-delimited client data (prevents injection)
 4 layers as structured parameters
 Explicit: "Do not fabricate statistics, awards, certifications"

Cost Controls:
 $5 per client per day cap
 Advisory lock checks budget before generation
 If exceeded   queue for next day

Outputs:
 pages.body_html populated
 pages.content_hash stored
 pages.status = 'validating' (triggers A-05)
 agent_events log with token counts + cost

**Additional capabilities (2026-05-17 augmentation):**

- **Passage-ranking optimization** — Structure paragraphs explicitly for Google passage extraction and AI Overview retrieval (passage independence, self-contained context, citation-friendly phrasing). Increases visibility beyond traditional page-level rankings.
- **Pre-publish competitor differentiation** — Before publish, compare generated page against live-SERP competitor pages for the target query (not just against other Tarritrix pages). Reject pages with >70% semantic similarity to a top-10 competitor result. Real gap closure beyond A-05 V14 (which only compares against peer Tarritrix pages).
- **Contextual rarity scoring** — Detect and remove overused local-SEO phrasing patterns ('trusted local experts', 'your neighborhood roofer', 'for all your X needs'). Phrases above platform-wide frequency threshold get flagged for variant rewording.

________________________________________

A-03: SCHEMA GENERATOR
Phase: 1 (runs after A-02)
Trigger: A-02 completes   A-03 generates JSON-LD
Runtime: Edge Function
Timeout: 15s
Purpose: Generate structured data markup for every page

What It Generates:
1. LocalBusiness schema (required)
2. Service schema (required)
3. FAQPage schema (required, minimum 3 Q&A)
4. BreadcrumbList schema (required)

HARD PROHIBITIONS (cannot be overridden):
 LocalBusiness NEVER contains aggregateRating
 LocalBusiness NEVER contains review property
 Violation detected   is_valid = false, NOT rendered

Schema Content Rules:
 priceRange only if client.price_range set
 openingHours only if client.hours configured
 All schema must match visible page content

Validation:
 Calls Google Rich Results Test API
 If fails   page.status = 'flagged_for_review'

Outputs:
 page_schemas table populated
 Validation results stored

**Additional capabilities (2026-05-17 augmentation):**

- **Dynamic schema prioritization** — Deploy schema types weighted by page intent. Pages targeting commercial intent emphasize Offer schema; FAQ pages emphasize FAQPage; informational pages emphasize Article. Not every schema rendered on every page — prioritization driven by page_content_profile.intent_angle.

________________________________________

A-04: MAP EMBED GENERATOR

STATUS: SUPERSEDED 2026-05-19.

The canonical A-04 specification is TARRITRIX_ARCHITECTURE_2026-05-14.md Section 8.4: "Map Embed static tiles requirement — Operator-stated P0 requirement (dynamic JS map embeds prohibited)". The iframe + Maps Embed API design previously in this section is SUPERSEDED.

Canonical design (locked 2026-05-19):
- A-04 calls Google Maps Static API (HTTP GET, returns PNG image)
- Output is a static <img> tag with the static-map URL as src
- NO iframe, NO JavaScript, NO Maps Embed API, NO consumer iframe
- Generated per-page, centered on the page's city coordinates
- Image stored as HTML in pages.map_embed_html (or equivalent column verified in Step 1)
- API key sourced from NEXT_PUBLIC_GOOGLE_MAPS_API_KEY for Phase 1 (per-client encrypted keys deferred to Phase 1.5 pending clients.maps_api_key_encrypted column migration)

Rationale: Eliminates JS bundle weight, prevents "google is not defined" runtime crashes (production incident 2026-05-16), trivial pass on A-05 G14 performance gate, no CLS.

Storm-density heatmap overlays (2026-05-17 augmentation): Phase 1.5 only — requires dynamic rendering not compatible with static API. Defer.

Map interaction monitoring (2026-05-17 augmentation): Phase 1.5 only — requires JS event listeners not present on static images. Defer.

**Additional capabilities (2026-05-17 augmentation):**

- **Storm-density heatmap overlays** — Optional overlay on map embeds showing service-area storm density data from storm_events table. Increases visual context and engagement on storm-driven trade pages.
- **Map interaction monitoring** — Track map module engagement events (clicks, zoom, pan, directions request) and forward to page_engagement_score. Real behavioral signal we currently don't capture.

________________________________________

A-05: PAGE VALIDATOR

STATUS: SUPERSEDED 2026-05-19.

The canonical A-05 specification is "A-05 PAGE VALIDATOR -- 15 GATES (Canonical)" section in this file (BLUEPRINT.md) and Section 3 of TARRITRIX_ARCHITECTURE_2026-05-14.md. The V1-V16 gate list previously in this section is superseded by the G1-G15 canonical set.

Migrations:
- Evidence-tier unlock logic (formerly V8 in this section) has been REMOVED from A-05 scope and migrated to CRON-01 Drip Publisher enforcement. CRON-01 reads pages.evidence_lock_status and pages.status = 'evidence_locked' and skips those rows. Schema unchanged (client_evidence_progress table, evidence_lock_status enum, evidence_locked page_status value remain in place per migration 20260507154331).
- Above-the-fold contact card audit (AGENTS.md c346551 lock) folded into G7 as sub-gate G7a.
- V17/V18/V19 augmentations (AI-style repetitiveness, Layout similarity, Passage independence) deferred to Phase 1.5. Augmentation text below preserved for Phase 1.5 reference.

For canonical gate definitions, override matrix, retry logic, cost model, and acceptance criteria see TARRITRIX_ARCHITECTURE_2026-05-14.md Section 3.

**Additional capabilities (2026-05-17 augmentation):**

- **V17 AI-style repetitiveness gate (NEW)** — Detect LLM-style phrasing patterns (overuse of 'moreover/furthermore/additionally', 'as a [profession]' constructions, hedge phrases). Flag pages above platform-wide LLM-tell frequency threshold for variant rewording. Soft gate — warning, not block.
- **V18 Layout similarity gate (NEW)** — Compare DOM structure (not text) against client's other published pages. Reject if structural similarity >85% to another page on same client domain. Complements V14 (text similarity) with structural similarity.
- **V19 Passage independence gate (NEW)** — For each paragraph in generated page, validate it can stand alone as a self-contained answer (subject named explicitly, no orphaned pronoun references). Required for passage-ranking and AI citation.

________________________________________

A-06: INTERNAL LINK BUILDER
Phase: 1 (runs after pages validated)
Trigger: Pages reach 'queued' status   link graph constructed
Runtime: Edge Function
Timeout: 20s
Purpose: Build hierarchical hub   city-hub   service-page link structure

What It Does:
1. Creates hub pages (state-level: /texas/, /california/)
2. Creates city hub pages (metro: /texas/dallas-fort-worth/)
3. Links hub   city hubs
4. Links city hubs   service pages
5. Adds contextual cross-links (max 3 per page)
6. Natural language anchors (not "HVAC repair Dallas")

Link Hierarchy:
```
Homepage
" /texas/ (state hub)
   " /texas/dallas-fort-worth/ (city hub)
      " /texas/dallas-fort-worth/hvac-repair/
       /texas/dallas-fort-worth/plumbing/
    /texas/houston/
 /california/
```

Anchor Text Examples:
 "Learn more about our HVAC repair services"
 "Explore plumbing solutions in Dallas"
 "See how we help Dallas residents"

Outputs:
 Internal links injected into pages.body_html
 Link graph stored for sitemap

**Additional capabilities (2026-05-17 augmentation):**

- **Topic-cluster reinforcement** — Build hierarchical hub-and-spoke topic clusters (not just geographic). Service-type hub pages link to all city-specific service pages within that service. Establishes topical depth signal beyond geographic hierarchy alone.
- **Authority sculpting** — Distribute internal link equity preferentially toward converting pages (highest conversion_rate_30d pages receive more inbound internal links than low-converter peers). Reinforces commercial-intent pages without external link manipulation.

________________________________________

A-07: SITEMAP GENERATOR
Phase: 1 (runs after initial pages published)
Trigger: First batch published   sitemap generated
Runtime: Edge Function
Timeout: 30s
Purpose: Generate XML sitemap for Google Search Console

What It Does:
1. Queries pages WHERE status='published'
2. Generates sitemap.xml with all published URLs
3. If >2,000 pages   segments (sitemap-texas.xml, etc.)
4. Generates robots.txt with AI crawler allowlist
5. Stores in page_sitemaps table (versioned, is_current flag)

robots.txt Generation:
```
User-agent: *
Allow: /

# AI crawler allowlist (8 crawlers)
User-agent: GPTBot
User-agent: ChatGPT-User
User-agent: Google-Extended
User-agent: PerplexityBot
User-agent: ClaudeBot
User-agent: anthropic-ai
User-agent: Bytespider
User-agent: cohere-ai
Allow: /

Sitemap: https://{DOMAIN}/sitemap.xml
```

GSC Limits:
 50,000 page-keyword pairs/day per property
 If >2,000 pages   register multiple GSC properties by directory

Outputs:
 sitemap.xml file
 robots.txt file
 page_sitemaps.is_current = true

**Additional capabilities (2026-05-17 augmentation):**

- **Differential update sitemaps** — Only resubmit materially changed pages to GSC (not full sitemap on every update). Tracks last_submitted_at per URL and only re-includes URLs with material changes since last submission. Prevents crawl noise from cosmetic edits.

________________________________________

A-08: INDEXATION TRACKER

> ⚠️ PRIORITY LOCK: A-08 is the first agent built immediately after A-05 Page Validator. Reason: A-08 is the only agent that provides empirical visibility into whether published pages actually rank. Every penalty-prevention claim and fingerprint diversification claim depends on A-08's measurements. Without A-08, the platform ships blind. No external client onboarding may proceed until A-08 is shipped AND validated against ground truth (E4 / Tarritrix Roofing).

Phase: 1 (ongoing monitoring)
Trigger: Runs via CRON-02 daily for all active clients
Runtime: Edge Function
Timeout: 60s per client
Purpose: Poll Google Search Console API for indexation status

What It Does:
1. Calls GSC URL Inspection API for each published page
2. Retrieves indexation status:
   o not_submitted
   o discovered
   o crawled
   o indexed
   o excluded
3. Stores last_crawl_time, coverage_state in pages
4. Detects issues ("discovered but not indexed", "crawled but not indexed")
5. Exponential backoff on 429 rate limits

Alerting Triggers:
 "Discovered - not indexed" >14 days   operator alert
 "Crawled - not indexed"   operator alert (quality issue)
 Bulk deindexation (>10% pages drop)   P0 alarm

GSC API Limits:
 1,200 queries per minute
 Exponential backoff + retry with jitter

Outputs:
 pages.indexation_status updated
 pages.gsc_last_crawl_at updated
 agent_events log
 Operator dashboard: indexation health metrics

**Additional capabilities (2026-05-17 augmentation):**

- **Soft-404 identification** — Detect pages Google treats as soft-404s (in-index but de-prioritized to zero traffic). Different from 'discovered, not indexed.' Signal: page indexed >30 days, zero impressions in GSC. Flag for A-11 priority refresh.
- **Query suppression analysis** — Detect pages filtered from SERPs (in-index, zero impressions for targeted keywords despite expected ranking). Signal of quality suppression that precedes deindexation.
- **Canonical conflict monitoring** — Detect when Google chose a different canonical URL than the one Tarritrix specified. Critical for catching duplicate-content issues silently affecting indexation.

________________________________________

A-09: CONVERSION HANDLER
Phase: 1 (webhook receiver)
Trigger: Form submission or CallRail webhook received
Runtime: Edge Function
Timeout: 15s
Purpose: Capture lead conversions with TCPA-compliant consent records

What It Does:
1. Receives webhook (form submit or CallRail)
2. Extracts contact data (name, email, phone)
3. CRITICAL: Stores phone as last 4 digits only (ADR-14)
4. Forwards full phone to client CRM via webhook (logged, not stored)
5. Captures TCPA consent with immutability enforcement (ADR-12)
6. Denormalizes client.legal_entity_name   consent_client_entity
7. Denormalizes service.name   consent_service_descriptor
8. Captures consent IP, user agent, timestamp

TCPA Immutability Enforcement:
```sql
CREATE TRIGGER conversions_consent_immutability
  BEFORE UPDATE ON conversions
  FOR EACH ROW
  EXECUTE FUNCTION prevent_consent_mutation();
```
 Any UPDATE attempt on consent fields   exception raised
 Consent becomes immutable litigation evidence

Phone Masking (ADR-14):
```typescript
const phone_last_four = phoneNumber.slice(-4); // Only "1234" stored
const full_phone_forwarded_to = client.crm_webhook_url;
```

Outputs:
 conversions table: new row with immutable consent
 Full contact forwarded to client CRM
 agent_events: 'conversion.recorded' event
 Client dashboard: lead log (shows masked phone only)

**Additional capabilities (2026-05-17 augmentation):**

- **Behavioral fraud detection** — Identify bot submissions and low-quality leads via honeypot fields, time-on-form thresholds (<3 seconds = likely bot), IP velocity checks (same IP submitting >3 forms/hour), and disposable-email-domain detection. Filters polluted conversion data before reaching client CRM.
- **Geo-intent scoring** — Score submitter IP geolocation against client service area. Submissions from outside service area flagged as low-quality but not blocked (allows referrals).
- **Multi-touch attribution implementation** — Populate first_touch_page_id and last_touch_page_id columns (already in conversions table per schema) with actual page-view sequence from visitor session. Enables per-page conversion attribution analysis in A-29.

________________________________________

A-10: CONTENT PROFILE BUILDER (EXPANDED  Phase B Section 2 Update)
Phase: 1 (runs BEFORE A-02)
Trigger: A-01 completes   builds profiles for all city " service
Runtime: Supabase Queue (5-30 minutes for 150 pages)
Timeout: None (queue-based)
Purpose: Build 4-layer differentiation profile + service area heatmap data before LLM generation + evidence sufficiency tracking

**Phase B Section 2 Enhancement:**
When client uploads new evidence (via A-18), A-10 recomputes client_evidence_progress:
- Updates photos_count, case_studies_count, claimed_facts_count, certifications_count
- Recalculates current_stage (1/2/3) and pages_unlocked
- Triggers A-05 Gate 8 re-evaluation on all evidence_locked pages
- Pages that now pass V8 advance to next validation gates
- Locks lift in bulk, pages enter drip queue naturally

THE 4 LAYERS:

Layer 1: Geographic Signal Injection

API Calls:
 Google Places API (per-client key)
 Census API (public, no auth)
 Distance Matrix API (per-client key)

Data Collected Per City:
```typescript
interface GeoContext {
  city_name: string;
  state: string;
  population: number; // Census API
  population_tier: 'large' | 'mid' | 'small'; // >=250K, 50K-250K, <50K
  neighborhoods: Array<{name: string, place_id: string}>;
  landmarks: Array<{name: string, place_id: string, type: string}>;
  zip_codes: string[];
  drive_minutes: number; // From business to city center
  local_entities: Array<{
    place_id: string; // CRITICAL: Must be verified Google place_id
    name: string;
    type: string; // 'landmark' | 'neighborhood' | 'business_corridor'
    lat: number;
    lng: number;
  }>;
}
```

Minimum Requirements:
  degrees2 verified place_id per city (Layer 4 validation)
 Drive time <90 minutes (service area realism)
 Population data from Census (annual refresh)

NEW: Service Area Heatmap Data Collection
```typescript
interface ServiceAreaHeatmap {
  client_id: UUID;
  grid_cells: Array<{
    lat_min: number;
    lat_max: number;
    lng_min: number;
    lng_max: number;
    signal_strength: number; // 0.0-1.0
    signal_types: {
      pages_published: number;
      jobs_completed: number;
      reviews_received: number;
      gbp_posts: number;
    };
    last_activity_at: Date;
  }>;
  generated_at: Date;
}
```

Heatmap Logic:
 Divide service area into 5km " 5km grid cells
 Calculate signal strength per cell:
```
  signal_strength = (
    pages_published * 0.3 +
    jobs_completed * 0.4 +
    reviews_received * 0.2 +
    gbp_posts * 0.1
  ) / theoretical_max
```
 Flag cells with signal_strength < 0.3 as "low density"
 Visualization data for operator dashboard

Layer 2: Semantic Sentence Variance

Deterministic Seed:
```typescript
const seed = hash(city_id + service_id) % VARIANT_COUNT;
// Same input always produces same seed (reproducible)
```

Stored: page_content_profile.content_variant_seed
Purpose: Ensures reproducible regeneration while maintaining variance across pages

Layer 3: Intent Angle Differentiation

Population-Based Intent Mapping:
```typescript
const intent_angle =
  population >= 250_000 ? 'cost' :
  population >= 50_000 ? 'local_expertise' :
  'speed';
```

Intent Angles:
 cost - Large cities (price-conscious, comparison shopping)
 local_expertise - Mid cities (trust, local knowledge)
 speed - Small cities (availability, emergency response)
 emergency - All tiers for emergency services
 quality - Premium services

Stored: page_content_profile.intent_angle

Layer 4: Local Entity Verification

Requirements:
 Minimum 2 verified place_id from Places API
 Cross-referenced against business location
 Validates genuine local relevance

If <2 entities found:
```typescript
page_content_profile.flagged_for_review = true;
// A-02 CANNOT proceed until operator resolves
```

API Compliance:
 Google Places: Per-client key, 30-day cache limit (except place_id = permanent)
 Census: 500 calls/day limit, annual refresh
 Attribution: Google + Census attribution on pages

Failure Handling:
 Places API rate limit   exponential backoff (1min, 5min, 30min)
 Places <2 entities   flag for review, operator adds or removes city
 Census fails   fallback population_tier = 'mid' + warning

Outputs:
 page_content_profile table fully populated
 Heatmap data stored in service_area_heatmaps table
 Triggers A-02 for content generation

**Additional capabilities (2026-05-17 augmentation):**

- **Local vernacular adaptation** — Use region-specific terminology in content: 'y'all' in Texas/Southern markets, 'hurricane' vs 'tropical storm' by coastal zone, 'metal roof' vs 'steel roofing' per regional convention. Stored in regional_vernacular_map per market.
- **Competitor topical gap analysis** — Identify semantic topics ranking competitors cover that the client's planned page does not. Surfaces gaps to A-02 for inclusion in generation.

### A-10 Temporal Context Layer (Phase 1.5)

Pages adapt to current season and recent local events. Phase 1 page generation is timeless. Phase 1.5 adds seasonal and event-driven contextualization.

Seasonal contexts (auto-detected by date and geography):
- Spring (Mar-May): pre-storm preparation, winter damage assessment, roof inspection season
- Summer (Jun-Aug): storm response readiness, active storm response, post-storm urgency
- Fall (Sep-Nov): pre-winter preparation, roof maintenance, weatherization
- Winter (Dec-Feb): ice/snow damage, emergency response, year-end planning

Event-driven contexts (auto-detected by Storm Intelligence Engine):
- Active storm watch/warning in service area
- Storm event in last 7/30/90 days
- Storm anniversary (1-year, 5-year)
- Pre-storm season (regional, e.g., hurricane season approach for Gulf coast)

Implementation: A-10 evaluates current temporal context for each city. Adds to page_content_profile.temporal_context JSONB. A-02 reads this and biases module selection accordingly.

Acceptance criteria: storm-prep template auto-prioritizes in spring for tornado alley clients; emergency response template auto-prioritizes during active warning periods; pages refresh quarterly to maintain temporal relevance.

________________________________________

A-11: CONTENT REFRESH ENGINE (Phase B Section 4 Update  Performance-Aware)
Phase: 1 (monthly cycle)
Trigger: Runs monthly for all active clients
Runtime: Supabase Queue
Timeout: None
Purpose: Re-generate underperforming pages with fresh Places API data

**Phase B Section 4 Enhancement  Performance-Aware Prioritization:**
A-11 now uses page_metrics.conversion_rate_30d as primary input to refresh prioritization.
Replaces simple "last_refreshed_at > 90 days" logic with performance-based queue.

What It Does:
1. Identifies pages needing refresh (performance-aware):
   o conversion_rate_30d < 0.5% (priority 1)
   o Places data >30 days old AND conversion_rate_30d < median (priority 2)
   o last_refreshed_at > 90 days AND conversion_rate_30d < median (priority 3)
   o Pages above median performance: left alone (do not fix what works)
2. Selects top N per tier from prioritized queue:
   o Starter: 5 pages/month
   o Growth: 15 pages/month
   o Authority: 30 pages/month
3. Re-fetches Places API data
4. Re-runs A-02 with updated entities
5. Compares new_content_hash vs old_content_hash
6. ONLY updates if content actually changed (prevents fake freshness)
7. Uses Anthropic Batch API (50% cost savings, 24hr latency OK)

Refresh Frequency:
 Tier 1: Top 5 pages/month
 Tier 2: Top 15 pages/month
 Tier 3: Top 30 pages/month

Content Hash Comparison:
```typescript
const newHash = hashContent(newPageBody);
if (newHash === page.content_hash) {
  console.log('Content unchanged, skip update');
} else {
  await updatePage(page.id, {
    body_html: newPageBody,
    content_hash: newHash,
    last_content_updated_at: new Date()
  });
  await revalidateTag(`client-${client.id}`);
}
```

NEW: Job-Triggered Refresh
```typescript
// When new job evidence uploaded (A-18)
if (job_evidence.city_id && job_evidence.service_id) {
  const relevantPage = await findPageByServiceAndCity(
    job_evidence.service_id,
    job_evidence.city_id
  );

  if (relevantPage) {
    await A11_RefreshPage(relevantPage.id, {
      priority: 'high',
      reason: 'new_job_evidence',
      inject_evidence: job_evidence.id
    });
  }
}
```

Outputs:
 Updated pages with fresh Places data
 last_content_updated_at only on real changes
 ISR cache invalidated via revalidateTag

**Additional capabilities (2026-05-17 augmentation):**

- **Event-reactive refresh triggers** — Refresh pages within affected service area when storm_events ingestion adds new event matching page geography. Direct trigger from A-32 storm queue, not just monthly performance-based refresh.
- **Partial modular refreshes** — Produce module-level diffs (FAQ section, hail-statistics block, recent-storms section) rather than full-page rewrites. Same content_hash logic applied per-module. Reduces unnecessary full-page churn while keeping data fresh.

________________________________________

A-12: GBP AGENT (EXPANDED - Phase 1.5+)
Phase: 1.5 (requires GBP API approval)
Trigger: Various (edit requests, auto-reject checks, completeness scans)
Runtime: Edge Function
Timeout: 30s
Purpose: Manage Google Business Profile with suspension prevention + optimization

Core Functions:

1. Edit Velocity Throttling
```typescript
async function attemptGBPEdit(client_id: UUID, edit: GBPEdit) {
  const profile = await getGBPProfile(client_id);

  if (Date.now() < profile.edit_velocity_cooldown_until) {
    throw new Error(`Edit throttled. Next edit allowed: ${profile.edit_velocity_cooldown_until}`);
  }

  // Execute edit via GBP API
  await gbpAPI.updateLocation(profile.gbp_location_id, edit);

  // Set new cooldown (24hr default, configurable)
  await supabase
    .from('gbp_profiles')
    .update({
      edit_velocity_cooldown_until: Date.now() + (24 * 60 * 60 * 1000),
      last_edit_at: new Date()
    })
    .eq('id', profile.id);
}
```

2. Auto-Reject Public Edit Monitoring
```typescript
// Runs every 6 hours via CRON
async function monitorUnauthorizedEdits(client_id: UUID) {
  const profile = await getGBPProfile(client_id);
  const currentState = await gbpAPI.getLocation(profile.gbp_location_id);
  const lastKnownState = profile.last_known_state;

  const diff = compareStates(currentState, lastKnownState);

  if (diff.hasChanges && !diff.authorizedByUs) {
    // Unauthorized edit detected
    await createOperatorAlert({
      severity: 'high',
      title: 'Unauthorized GBP edit detected',
      client_id,
      changes: diff.changes
    });

    // Auto-reject if possible via API
    if (diff.canReject) {
      await gbpAPI.rejectSuggestedEdit(diff.edit_id);
      profile.unauthorized_edits_detected += 1;
    }
  }

  // Update last known state
  profile.last_known_state = currentState;
  await saveGBPProfile(profile);
}
```

3. Completeness Scoring (NEW)
```typescript
interface GBPCompletenessScore {
  overall_score: number; // 0-100
  missing_elements: string[];
  warnings: string[];
  breakdown: {
    basic_info: number; // Name, address, phone, hours
    services: number; // Service list completeness
    attributes: number; // Business attributes
    photos: number; // Photo diversity + count
    posts: number; // Recent posting activity
    qa: number; // Q&A section populated
    description: number; // Description quality
  };
}

async function calculateCompletenessScore(gbp_location: GBPLocation): Promise<GBPCompletenessScore> {
  const score = {
    overall_score: 0,
    missing_elements: [],
    warnings: [],
    breakdown: {}
  };

  // Basic Info (30 points)
  score.breakdown.basic_info =
    (gbp_location.name ? 10 : 0) +
    (gbp_location.address ? 5 : 0) +
    (gbp_location.phone ? 5 : 0) +
    (gbp_location.hours?.length > 0 ? 10 : 0);

  if (!gbp_location.hours) score.missing_elements.push('Business hours');

  // Services (15 points)
  const serviceCount = gbp_location.services?.length || 0;
  score.breakdown.services = Math.min(15, serviceCount * 3);
  if (serviceCount < 3) score.warnings.push('Add more services');

  // Attributes (10 points)
  const attrCount = gbp_location.attributes?.length || 0;
  score.breakdown.attributes = Math.min(10, attrCount * 2);

  // Photos (20 points) - CATEGORY DIVERSITY
  const photos = gbp_location.photos || [];
  const categories = {
    exterior: photos.filter(p => p.category === 'exterior').length,
    interior: photos.filter(p => p.category === 'interior').length,
    team: photos.filter(p => p.category === 'team').length,
    work: photos.filter(p => p.category === 'work').length
  };

  score.breakdown.photos =
    (categories.exterior > 0 ? 5 : 0) +
    (categories.interior > 0 ? 5 : 0) +
    (categories.team > 0 ? 5 : 0) +
    (categories.work >= 3 ? 5 : 0);

  if (categories.exterior === 0) score.missing_elements.push('Exterior photos');
  if (categories.work < 3) score.warnings.push('Add more work photos');

  // Posts (10 points)
  const recentPosts = gbp_location.posts?.filter(p =>
    isWithinDays(p.created_at, 30)
  ).length || 0;
  score.breakdown.posts = Math.min(10, recentPosts * 2);
  if (recentPosts === 0) score.missing_elements.push('Recent posts');

  // Q&A (10 points)
  const qaCount = gbp_location.questions?.length || 0;
  score.breakdown.qa = Math.min(10, qaCount * 2);
  if (qaCount < 3) score.missing_elements.push('Q&A pairs');

  // Description (5 points)
  score.breakdown.description =
    gbp_location.description?.length >= 200 ? 5 : 0;

  // Calculate overall
  score.overall_score = Object.values(score.breakdown).reduce((a, b) => a + b, 0);

  return score;
}
```

4. Image Category Balance Enforcement (NEW)
```typescript
async function auditImageBalance(client_id: UUID) {
  const profile = await getGBPProfile(client_id);
  const photos = await gbpAPI.getPhotos(profile.gbp_location_id);

  const balance = {
    exterior: photos.filter(p => p.category === 'exterior').length,
    interior: photos.filter(p => p.category === 'interior').length,
    team: photos.filter(p => p.category === 'team').length,
    work: photos.filter(p => p.category === 'work').length
  };

  const recommendations = [];

  if (balance.exterior === 0) {
    recommendations.push({
      priority: 'high',
      message: 'Upload exterior photos showing storefront/building'
    });
  }

  if (balance.work < 5) {
    recommendations.push({
      priority: 'high',
      message: `Upload ${5 - balance.work} more work photos from completed jobs`
    });
  }

  if (balance.team === 0) {
    recommendations.push({
      priority: 'medium',
      message: 'Upload team photos to build trust'
    });
  }

  return {
    balance,
    recommendations,
    is_balanced: recommendations.filter(r => r.priority === 'high').length === 0
  };
}
```

5. Recurring Posts (Phase 2)
```typescript
// Uses GBP Recurrence Info API (April 2026)
async function scheduleRecurringPost(client_id: UUID, template: PostTemplate) {
  const profile = await getGBPProfile(client_id);

  await gbpAPI.createPost({
    location_id: profile.gbp_location_id,
    topic_type: template.topic_type,
    content: template.content,
    media: template.media,
    recurrence: {
      frequency: 'WEEKLY',
      day_of_week: template.day_of_week, // e.g., 'TUESDAY'
      time: template.time, // e.g., '10:00'
      timezone: profile.timezone
    }
  });
}
```

Outputs:
 GBP profile updates via API
 gbp_profiles table updated
 Completeness scores stored
 Operator dashboard: GBP health metrics
 Image balance recommendations

**Additional capabilities (2026-05-17 augmentation):**

- **Geo-photo diversity enforcement** — Maintain varied geographic representation in GBP photo uploads. Prevent all photos coming from one neighborhood. Enforces minimum N distinct ZIP codes represented in photo metadata over rolling 90-day window.
- **Duplicate listing detection** — Detect pre-existing GBP listings for the same business (often agency-created legacy listings). Flag conflicts to operator before activating Tarritrix-managed listing.

________________________________________

A-13: AI VISIBILITY MONITOR (Phase 2)
Phase: 2
Trigger: Weekly CRON
Runtime: Supabase Queue
Timeout: None
Purpose: Track client visibility in ChatGPT, Gemini, Perplexity, Google AI Overview

What It Does:
1. Query Generation
```typescript
   const queries = [
     `best ${service} in ${city}`,
     `top ${service} companies ${city}`,
     `${service} near me`, // Geo-spoofed to city
     `emergency ${service} ${city}`,
     `affordable ${service} ${city}`
   ];
```

2. AI Platform Scraping
```typescript
   // ChatGPT
   const chatgpt_response = await scrapeViaPuppeteer('https://chat.openai.com', query, geo_spoof);

   // Gemini
   const gemini_response = await scrapeViaPuppeteer('https://gemini.google.com', query, geo_spoof);

   // Perplexity
   const perplexity_response = await scrapeViaPuppeteer('https://perplexity.ai', query, geo_spoof);

   // Google AI Overview (via SERPs)
   const aio_response = await scrapeGoogleAIO(query, geo_spoof);
```

3. Mention Detection
```typescript
   function detectMention(response: string, business_name: string): MentionResult {
     const mentioned = response.toLowerCase().includes(business_name.toLowerCase());

     if (!mentioned) return { mentioned: false, rank: null };

     // Extract ranking (e.g., "1. ABC Plumbing", "Top choice: ABC Plumbing")
     const rank = extractRankFromText(response, business_name);

     return { mentioned: true, rank };
   }
```

4. Sentiment Analysis
```typescript
   async function analyzeSentiment(mention_context: string): Promise<Sentiment> {
     const prompt = `
       Analyze the sentiment of this business mention:
       "${mention_context}"

       Return ONLY: positive, neutral, or negative
     `;

     const sentiment = await anthropic.complete(prompt);
     return sentiment.trim().toLowerCase() as Sentiment;
   }
```

5. Share of Voice Calculation
```typescript
   interface ShareOfVoice {
     client_mentions: number;
     total_businesses_mentioned: number;
     share_percent: number;
     competitors: Array<{name: string, mentions: number}>;
   }

   function calculateShareOfVoice(responses: AIResponse[]): ShareOfVoice {
     const allBusinesses = extractAllBusinessNames(responses);
     const clientMentions = allBusinesses.filter(b => b === client.business_name).length;
     const totalMentions = allBusinesses.length;

     return {
       client_mentions: clientMentions,
       total_businesses_mentioned: totalMentions,
       share_percent: (clientMentions / totalMentions) * 100,
       competitors: groupByBusiness(allBusinesses).filter(b => b.name !== client.business_name)
     };
   }
```

Outputs:
 ai_visibility_scores table populated
 Weekly reports to clients
 Operator dashboard: AI visibility trends
 Competitor intelligence data

**Additional capabilities (2026-05-17 augmentation):**

- **Retrieval-source structural analysis** — Feed citation events from A-47 back into A-13 to determine which page structures (Q&A blocks, atomic facts, schema patterns) AI systems cite most. Output feeds A-25 template tuning.
- **Citation volatility scoring** — Detect unstable AI retrieval (cited this week, dropped next week). Distinguishes stable AI authority from one-off citations.

________________________________________

## A-14 REVIEW REQUEST WORKFLOW (Phase 1.5)

### Mission
Automate verified customer review acquisition for storm-driven trade clients. Convert completed jobs into a systematic review velocity stream that improves Local Pack rankings, organic search trust signals (Schema.org Review markup), and on-page conversion.

### Strategic Premise
Most contractors finish jobs and never ask for reviews. Reviews are left on the table at the moment customer satisfaction is highest. A-14 closes that gap by automating the ask at the optimal moment with a value-first delivery mechanism (the customer receives their job photos as the primary value, with the review request as the secondary CTA).

### CRITICAL COMPLIANCE BOUNDARIES (HARD LIMITS)

The following constraints are non-negotiable. Violation exposes Tarritrix and every client to platform bans, FTC enforcement, and legal liability:

1. NO PRE-WRITTEN REVIEW TEXT. Reviews must be authored by the customer in the customer's own words. Tarritrix may not provide template sentences for customers to approve. Tarritrix may provide guiding questions and structural prompts only.

2. NO INCENTIVES FOR REVIEWS. No discounts, no gift cards, no service upgrades, no preferential treatment tied to leaving a review. Asking for a review is permitted. Paying for a review (in any form, including in-kind) is not.

3. NO YELP SOLICITATION. Yelp prohibits all forms of review solicitation. A-14 may not direct customers to Yelp. Yelp reviews must originate organically from customer-initiated activity. This is a per-platform exclusion enforced in code.

4. CUSTOMER MUST AUTHOR. The customer's actual words must reach the review platform. Tarritrix-hosted guided review page captures customer text, then routes to the destination platform with the customer's text pre-populated in the destination URL. Customer always sees their words at the destination before final submission.

5. NO FAKE OR FABRICATED REVIEWS. Job evidence must trace to a real completed job in extracted_evidence. Customer email must trace to a real customer. Reviews cannot be generated from operator-fabricated jobs or operator-fabricated customer identities.

These constraints are enforced via Contract 45 (see BEHAVIORAL_CONTRACTS.md).

### Workflow

Stage 1: Job evidence approved
- A-18 Job Evidence Upload completes
- Operator approves evidence in operator queue
- A-14 trigger fires automatically

Stage 2: Customer notification
- Email sent to customer from client-branded address (configurable)
- Email subject: "[Contractor name] - photos from your completed [service type]"
- Email body: thank-you message, job photo gallery (primary value), brief job summary, secondary CTA "Share your experience"
- Email value proposition: photos are the gift, review request is secondary

Stage 3: Guided review page
- Customer clicks "Share your experience"
- Lands on Tarritrix-hosted page at reviews.{clientdomain.com}/{job_token}
- Page displays: their job photos, job summary, text input for review (customer-authored)
- Guiding questions displayed (not templates): "What did the team do well?" "How was communication?" "Would you recommend to a neighbor?"
- Character count helpers shown
- Platform-specific tips shown (Google ideal length, Facebook ideal length)
- Customer selects destination platform(s) from approved list: Google, Facebook, BBB
- Customer is informed their review will be posted publicly with their account
- Customer can preview their review before submission

Stage 4: Submission routing
- Customer clicks "Post review"
- For Google: redirect to client's Google Business Profile review link with customer text pre-populated in URL parameters
- For Facebook: redirect to client's Facebook page review with text pre-populated
- For BBB: redirect to BBB submission flow (chapter-specific, manual completion required)
- Customer completes posting in their own platform account
- Tarritrix records review_request_submitted event in review_requests table

Stage 5: Review aggregation
- A-14 polls Google Business Profile API (Phase 1.5 dependent on GBP API approval), Facebook Graph API, BBB scraping for new reviews on client's listings
- New reviews matched back to review_requests by customer name + timing window + content fuzzy match
- Match confidence stored; high-confidence matches auto-linked, low-confidence matches surfaced to operator for verification
- Reviews stored in reviews table with platform, rating, text, posted_date, verified_match boolean

Stage 6: Content integration
- Verified reviews flow to Pool C Customer Evidence modules in A-02 page generation
- Reviews tagged by city/neighborhood for city-page placement
- Schema.org Review markup populated by A-03 Schema Generator with review aggregate ratings
- Client Portal Analytics displays review velocity, rating distribution, platform breakdown
- Operator Command Center surfaces review metrics across all clients

### Email Infrastructure
- Email sent from configurable client-branded address (default: reviews@{clientdomain.com})
- Email deliverability handled via Resend or Postmark integration
- DKIM/SPF/DMARC alignment required per client domain
- Unsubscribe link in every email (CAN-SPAM compliance)
- Customer can opt out, removing them from all future Tarritrix-initiated communications

### Frequency Controls
- Maximum 1 review request per customer per job (no re-asking)
- 7-day delay after job completion before initial request (allows customer time to assess work)
- Optional 1 reminder after 14 days if no response (operator-toggleable per client)
- No further follow-up after second touch (anti-harassment)

### Operator Controls (Phase 1.5 — Command Center)
- Review velocity dashboard per client
- Rating distribution and trend
- Platform breakdown (Google vs Facebook vs BBB)
- Manual review request trigger for specific jobs
- Operator-toggleable reminder behavior per client
- Verification queue for low-confidence review matches

### Integration with A-13 GBP Optimization (Phase 1.5)
A-14 complements A-13. A-13 optimizes existing GBP content (posts, Q&A, photos). A-14 drives review velocity to the GBP. Together they form a complete Local Pack ranking strategy.

### SEO Impact Vectors

Vector 1 — Local Pack Rankings
Google factors review count, velocity, and recency into GBP ranking. A-14 systematically generates verified reviews from real completed jobs, building consistent review velocity that ranks contractor in Local Pack results.

Vector 2 — Organic Search Trust Signals
Schema.org Review markup with verified ratings displays star snippets in Google organic results. Pages with star ratings see 20-40% higher CTR than equivalent pages without.

Vector 3 — On-Page Conversion
Real customer reviews on city pages (Pool C modules) increase visitor-to-lead conversion. Industry data: contractors with active review velocity see 30-60% higher inbound lead-to-close rates.

### Phase Boundaries

Phase 1.5: Core A-14 functionality. Email-based review request flow. Google + Facebook destinations. Manual operator triggers. Basic aggregation.

Phase 2: SMS-based review request flow. BBB integration (chapter-specific). Review response automation. Sentiment analysis on incoming reviews. A-29 correlation of review patterns with page performance.

Phase 3: Pre-publish predictive review impact scoring. Cross-client review benchmarking.

### Acceptance Criteria
- End-to-end test: job evidence → operator approval → customer email → guided review page → posted review → aggregated back to platform within 14 days
- Email deliverability above 95%
- Customer authoring rate: customer-typed text on the guided review page is genuinely authored by customer (no template-fill heuristics in the UI)
- Yelp solicitation blocked in code (no UI path to Yelp from review request flow)
- Review match accuracy above 80% on first-attempt automated matching
- Pool C modules render verified reviews correctly
- Schema.org Review markup validates in Google Rich Results Test
- CAN-SPAM compliance verified

**Additional capabilities (2026-05-17 augmentation):**

- **Natural cadence modeling** — Pace review acquisition to match realistic human-business patterns: no >5 reviews/day spikes, no >40 reviews/week, no perfect daily cadence. Variance modeled on industry averages, not perfectly uniform distribution.
- **Sentiment-distribution realism** — Don't pursue 100% 5-star outcomes. Realistic client profiles include occasional 3-4 star reviews. Avoid review-acquisition patterns that produce statistically improbable perfect histories (algorithm tells).
- **Geo-distributed pacing** — Space review requests across customer service locations and timelines. Reject patterns where 10 reviews arrive from same neighborhood within 48 hours.

________________________________________

A-15: GBP POST GENERATOR (NEW - Phase 2)
Phase: 2
Trigger: Job completion (A-19) OR manual operator trigger
Runtime: Edge Function
Timeout: 20s
Purpose: Auto-generate GBP posts from completed jobs, reinforcing service + location signals

What It Does:

1. Post Content Generation from Job
```typescript
async function generateJobCompletionPost(job_evidence_id: UUID): Promise<GBPPostDraft> {
  const job = await getJobEvidence(job_evidence_id);
  const client = await getClient(job.client_id);
  const photos = await getJobPhotos(job_evidence_id); // From A-18

  const prompt = `
    Generate a Google Business Profile post for a completed job.

    Business: ${client.business_name}
    Service: ${job.service}
    Location: ${job.city}, ${job.state}
    Completion Date: ${formatDate(job.job_date)}

    Requirements:
    - 100-150 words
    - Mention the service performed: "${job.service}"
    - Mention the location: "${job.city}"
    - Emphasize quality, professionalism, customer satisfaction
    - Include relevant details (e.g., "emergency repair", "same-day service")
    - Natural, authentic tone (not overly promotional)
    - NO URLs, NO phone numbers, NO "Call us!"
    - End with soft CTA like "We're here to help" or "Serving [city] since [year]"

    Return ONLY the post text.
  `;

  const content = await anthropic.complete(prompt);

  return {
    client_id: job.client_id,
    job_evidence_id,
    content: content.trim(),
    media: photos.slice(0, 10), // Max 10 photos per GBP post
    topic_type: 'UPDATE', // GBP post type
    scheduled_for: calculateOptimalPostTime(client), // Tuesday 10am for B2B, etc.
    status: 'draft'
  };
}
```

2. Post Scheduling Optimization
```typescript
function calculateOptimalPostTime(client: Client): Date {
  const now = new Date();

  // Business type determines optimal day/time
  const schedule = client.business_type === 'B2B'
    ? { day: 2, hour: 10 } // Tuesday 10am
    : { day: 6, hour: 9 };  // Saturday 9am

  // Find next occurrence of that day
  let targetDate = new Date(now);
  while (targetDate.getDay() !== schedule.day) {
    targetDate = addDays(targetDate, 1);
  }

  targetDate.setHours(schedule.hour, 0, 0, 0);

  // If that time already passed this week, go to next week
  if (targetDate < now) {
    targetDate = addDays(targetDate, 7);
  }

  return targetDate;
}
```

3. Post Publishing
```typescript
// Runs via CRON daily, publishes scheduled posts
async function publishScheduledPosts() {
  const pending = await supabase
    .from('gbp_posts')
    .select('*')
    .eq('status', 'approved')
    .lte('scheduled_for', new Date());

  for (const post of pending) {
    const profile = await getGBPProfile(post.client_id);

    // Upload media first
    const mediaIds = [];
    for (const photo of post.media) {
      const mediaId = await gbpAPI.uploadMedia(
        profile.gbp_location_id,
        photo.url
      );
      mediaIds.push(mediaId);
    }

    // Create post via GBP API
    await gbpAPI.createPost({
      location_id: profile.gbp_location_id,
      topic_type: post.topic_type,
      summary: post.content,
      media: mediaIds,
      call_to_action: null // No CTA to avoid promotional flags
    });

    // Update status
    post.status = 'published';
    post.published_at = new Date();
    await saveGBPPost(post);
  }
}
```

Post Types Generated:
1. Job Completion Posts (primary)
   o Triggered by A-19 job completion
   o Service + location reinforcement
   o Real photos from job site
2. Seasonal Posts (secondary)
   o Template-based
   o "Preparing for winter? Our HVAC team in [city] can help..."
3. Storm Event Posts (Phase 3 - Storm Intelligence Engine)
   o Real-time weather event detection
   o "Recent hail in [neighborhood]? We're ready to inspect roofs..."

Outputs:
 gbp_posts table populated
 Post drafts for operator approval
 Automated publishing via GBP API
 Consistent posting cadence maintained

**Additional capabilities (2026-05-17 augmentation):**

- **Event-reactive publishing** — Trigger GBP posts within affected service area when storm_events queue produces matching event. Posts produced match real-world operational urgency cycle, not arbitrary publishing calendar.

________________________________________

A-16: Q&A SEED MANAGER (NEW - Phase 2)
Phase: 2
Trigger: Client onboarding OR manual operator trigger
Runtime: Edge Function
Timeout: 30s
Purpose: Auto-populate GBP Q&A section with industry-specific, intent-driven questions

What It Does:

1. Q&A Template Generation
```typescript
interface QASeed {
  question: string;
  answer: string;
  category: 'service' | 'pricing' | 'availability' | 'location' | 'process';
  priority: 'high' | 'medium' | 'low';
}

async function generateQASeeds(client_id: UUID): Promise<QASeed[]> {
  const client = await getClient(client_id);

  const prompt = `
    Generate 10 realistic Q&A pairs for a Google Business Profile.

    Business: ${client.business_name}
    Industry: ${client.industry}
    Services: ${client.services.map(s => s.name).join(', ')}
    Location: ${client.city}, ${client.state}

    Requirements:
    - Questions should be what real customers ask
    - Mix of: service details, pricing, availability, service area, process
    - Answers should be clear, helpful, 50-100 words
    - Include location context where relevant ("We serve [city] and surrounding areas")
    - Include service keywords naturally
    - Professional but approachable tone

    Return as JSON array:
    [
      {
        "question": "...",
        "answer": "...",
        "category": "service|pricing|availability|location|process"
      }
    ]
  `;

  const seeds = await anthropic.complete(prompt, { format: 'json' });

  // Prioritize based on search volume / common queries
  return seeds.map(seed => ({
    ...seed,
    priority: categorizePriority(seed.category)
  }));
}

function categorizePriority(category: string): 'high' | 'medium' | 'low' {
  const HIGH_PRIORITY = ['pricing', 'availability', 'service'];
  return HIGH_PRIORITY.includes(category) ? 'high' : 'medium';
}
```

2. Q&A Publishing Workflow
```typescript
async function publishQASeeds(client_id: UUID, seeds: QASeed[]) {
  const profile = await getGBPProfile(client_id);

  // Publish in batches (1-2 per week to appear natural)
  const schedule = seeds.map((seed, index) => ({
    seed,
    publish_at: addDays(new Date(), index * 4) // Every 4 days
  }));

  for (const item of schedule) {
    await supabase
      .from('qa_seeds')
      .insert({
        client_id,
        question: item.seed.question,
        answer: item.seed.answer,
        category: item.seed.category,
        priority: item.seed.priority,
        scheduled_for: item.publish_at,
        status: 'scheduled'
      });
  }
}

// CRON job publishes scheduled Q&As
async function publishScheduledQAs() {
  const pending = await supabase
    .from('qa_seeds')
    .select('*')
    .eq('status', 'scheduled')
    .lte('scheduled_for', new Date());

  for (const qa of pending) {
    const profile = await getGBPProfile(qa.client_id);

    // Create Q&A via GBP API
    await gbpAPI.createQuestion({
      location_id: profile.gbp_location_id,
      question_text: qa.question,
      answer_text: qa.answer,
      author: 'MERCHANT' // Appears as business-answered
    });

    qa.status = 'published';
    qa.published_at = new Date();
    await saveQASeed(qa);
  }
}
```

Industry-Specific Templates:
```typescript
const QA_TEMPLATES = {
  hvac: [
    { q: "What brands of HVAC equipment do you install?", cat: 'service' },
    { q: "Do you offer emergency AC repair?", cat: 'availability' },
    { q: "How much does a new furnace cost?", cat: 'pricing' },
    { q: "Do you service [city] and surrounding areas?", cat: 'location' }
  ],
  plumbing: [
    { q: "Do you handle emergency plumbing calls 24/7?", cat: 'availability' },
    { q: "What areas do you cover?", cat: 'location' },
    { q: "How quickly can you respond to a leak?", cat: 'service' }
  ],
  roofing: [
    { q: "Do you offer free roof inspections?", cat: 'pricing' },
    { q: "What roofing materials do you work with?", cat: 'service' },
    { q: "How long does a roof replacement take?", cat: 'process' }
  ]
};
```

Outputs:
 qa_seeds table populated
 Scheduled Q&A publishing
 GBP Q&A section fully populated over 4-6 weeks
 Intent-rich content for AI systems

**Additional capabilities (2026-05-17 augmentation):**

- **PAA ingestion pipeline** — Continuously mine People Also Ask query data from Decodo per active client target keyword. Refresh weekly. Output feeds A-25 Q&A block generation with real query phrasing (not LLM-imagined questions).
- **Conversational query modeling** — Store questions in their natural spoken form ('how much does a new roof cost in Austin' not 'Roof installation cost Austin TX'). Required input for A-27 voice search optimization.
- **Featured-snippet target structuring** — For each Q&A, produce both the natural-form question and the 40-60 word direct-answer paragraph optimized for featured-snippet capture.

________________________________________

A-17: ENTITY CONSISTENCY MONITOR (NEW - Phase 2)
Phase: 2
Trigger: Weekly CRON
Runtime: Supabase Queue
Timeout: None
Purpose: Audit and enforce NAP consistency across all platforms

What It Does:

1. Cross-Platform NAP Audit
```typescript
interface EntityAudit {
  client_id: UUID;
  platforms: Array<{
    platform: string; // 'gbp' | 'yelp' | 'facebook' | 'bbb' | 'apple_maps'
    name: string;
    address: string;
    phone: string;
    website: string;
    last_checked: Date;
  }>;
  inconsistencies: Array<{
    field: 'name' | 'address' | 'phone' | 'website';
    canonical_value: string;
    discrepancies: Array<{
      platform: string;
      value: string;
      severity: 'critical' | 'warning';
    }>;
  }>;
  consistency_score: number; // 0-100
}

async function auditEntityConsistency(client_id: UUID): Promise<EntityAudit> {
  const client = await getClient(client_id);

  // Canonical values (source of truth)
  const canonical = {
    name: client.business_legal_name,
    address: normalizeAddress(client.address),
    phone: client.phone_e164,
    website: client.website_url
  };

  // Fetch from all platforms
  const platforms = await Promise.all([
    fetchGBPProfile(client.gbp_location_id),
    fetchYelpListing(client.yelp_id),
    fetchFacebookPage(client.facebook_id),
    fetchBBBListing(client.bbb_id),
    fetchAppleMaps(client.apple_maps_id)
  ]);

  // Compare each field
  const inconsistencies = [];

  for (const field of ['name', 'address', 'phone', 'website']) {
    const discrepancies = platforms
      .filter(p => normalize(p[field]) !== normalize(canonical[field]))
      .map(p => ({
        platform: p.platform,
        value: p[field],
        severity: field === 'name' || field === 'address' ? 'critical' : 'warning'
      }));

    if (discrepancies.length > 0) {
      inconsistencies.push({
        field,
        canonical_value: canonical[field],
        discrepancies
      });
    }
  }

  // Calculate consistency score
  const totalFields = 4;
  const inconsistentFields = inconsistencies.length;
  const consistencyScore = ((totalFields - inconsistentFields) / totalFields) * 100;

  return {
    client_id,
    platforms,
    inconsistencies,
    consistency_score: consistencyScore
  };
}
```

2. Auto-Correction (Where Possible)
```typescript
async function correctInconsistencies(audit: EntityAudit) {
  for (const inconsistency of audit.inconsistencies) {
    for (const discrepancy of inconsistency.discrepancies) {
      const canAutoCorrect = PLATFORMS_WITH_API_WRITE_ACCESS.includes(discrepancy.platform);

      if (canAutoCorrect) {
        try {
          // Update via API
          await updatePlatformField(
            discrepancy.platform,
            inconsistency.field,
            inconsistency.canonical_value
          );

          await logAuditAction({
            type: 'auto_corrected',
            platform: discrepancy.platform,
            field: inconsistency.field,
            old_value: discrepancy.value,
            new_value: inconsistency.canonical_value
          });
        } catch (error) {
          // Auto-correction failed, flag for operator
          await createOperatorTask({
            type: 'manual_correction_needed',
            platform: discrepancy.platform,
            details: inconsistency
          });
        }
      } else {
        // No API access, create operator task
        await createOperatorTask({
          type: 'manual_correction_needed',
          platform: discrepancy.platform,
          instructions: `Update ${inconsistency.field} to: ${inconsistency.canonical_value}`,
          current_value: discrepancy.value
        });
      }
    }
  }
}
```

3. Citation Discovery
```typescript
async function discoverNewCitations(client_id: UUID): Promise<Citation[]> {
  const client = await getClient(client_id);

  // Search for mentions across web
  const queries = [
    `"${client.business_name}" "${client.city}"`,
    `"${client.phone}"`,
    client.website_url
  ];

  const citations = [];

  for (const query of queries) {
    const results = await googleSearch(query);

    for (const result of results) {
      // Extract NAP from result
      const nap = extractNAP(result.snippet, result.url);

      if (nap.confidence > 0.7) {
        citations.push({
          source_url: result.url,
          source_domain: extractDomain(result.url),
          name: nap.name,
          address: nap.address,
          phone: nap.phone,
          discovered_at: new Date()
        });
      }
    }
  }

  return deduplicateCitations(citations);
}
```

Outputs:
 entity_audit_log table populated weekly
 Auto-corrections executed where possible
 Operator tasks created for manual corrections
 Consistency score tracked over time
 Citation discovery for entity building

**Additional capabilities (2026-05-17 augmentation):**

- **Cross-page NAP synchronization gate** — Daily scan of all client pages for NAP consistency. Flag any page where business name, address, or phone differs from canonical client record. Critical local-SEO trust factor.
- **External citation ecosystem monitoring** — Periodic crawl of major citation sources (Yelp, BBB, Yellow Pages, GBP, Facebook) checking NAP consistency against canonical record. Surface inconsistencies for operator-led correction.
- **Semantic drift prevention** — Detect terminology drift over time within a single client (today's pages say 'metal roofing,' next month's say 'steel roofing'). Lock per-client terminology dictionary at A-44 ingestion; enforce in A-02 generation.

________________________________________

A-28: TOPICAL AUTHORITY ENGINE (NEW - Phase 2)
Phase: 2
Trigger: Monthly CRON (Authority + Dominance tier clients only)
Runtime: Supabase Queue
Timeout: None
Purpose: Build topical authority by identifying unanswered questions in client service categories and generating cluster content that fills the gaps

What It Does:

Builds topical authority for client domains by mining unanswered questions in their service categories, analyzing competitor content gaps, and feeding a prioritized question backlog to A-02 Page Generator with pillar + cluster structure.

**Why this matters:** Storm-driven roofing has predictable post-event question patterns:
- "can I claim hail damage that's 2 years old"
- "what does insurance pay for after a hail storm"
- "how do I know if my roof has hail damage"

Most contractor sites do NOT answer these questions. Tarritrix clients that do will dominate post-storm organic traffic.

Architecture:
```typescript
interface TopicalAuthorityWorkflow {
  input: {
    client_id: UUID;
    primary_services: string[];      // e.g., ['roofing', 'hail damage repair']
    target_cities: string[];          // from cities table
    competitor_domains: string[];     // scraped or manually entered
  };
  
  question_mining: {
    sources: [
      'AlsoAsked API',                // PRIMARY -- clean, paid, reliable
      'Google PAA via SERP API',      // DataForSEO, SerpAPI
      'Google Search Console queries' // client's own GSC property, free
    ];
    excluded_sources: [
      'AnswerThePublic'               // blocks scraping, paid API inferior to AlsoAsked
    ];
  };
  
  gap_analysis: {
    competitor_content: ScrapeResult[];   // what competitors already rank for
    client_existing_pages: Page[];        // what we've already published
    unanswered_questions: Question[];     // gaps to fill
  };
  
  output: {
    question_backlog: PrioritizedQuestion[];  // feeds A-02
    cluster_structure: ClusterMap;            // pillar + cluster pattern
  };
}

interface Question {
  id: UUID;
  question_text: string;
  search_volume: number | null;         // from SERP API if available
  difficulty: number | null;            // keyword difficulty 0-100
  relevance_score: number;              // 0-100, how relevant to client services
  competitor_coverage: {
    domain: string;
    url: string;
    rank: number;
  }[];
  cluster_assignment: 'pillar' | 'cluster';
  pillar_topic_id: UUID | null;        // if cluster, which pillar does it support
  priority: number;                     // 1-100, based on volume + difficulty + coverage gap
  discovered_at: Date;
}

interface ClusterMap {
  pillar_topics: Array<{
    id: UUID;
    topic: string;                      // e.g., "hail damage insurance claims"
    target_keyword: string;
    search_volume: number;
    cluster_questions: UUID[];          // supporting questions
  }>;
}

async function mineQuestions(
  service: string, 
  location: string
): Promise<Question[]> {
  // Step 1: Query AlsoAsked API (preferred)
  const alsoAskedQuestions = await fetchAlsoAsked({
    seed_keyword: `${service} ${location}`,
    depth: 2,  // 2 levels deep in question tree
    language: 'en',
    country: 'US'
  });
  
  // Step 2: Supplement with Google PAA via SERP API
  const paaQuestions = await fetchGooglePAA({
    query: `${service} ${location}`,
    api: 'DataForSEO'  // or SerpAPI
  });
  
  // Step 3: Pull client's own GSC queries (free data)
  const gscQuestions = await fetchGSCQueries({
    client_id,
    service_filter: service,
    min_impressions: 10,
    days: 90
  });
  
  // Deduplicate and normalize
  const allQuestions = deduplicateQuestions([
    ...alsoAskedQuestions,
    ...paaQuestions,
    ...gscQuestions
  ]);
  
  return allQuestions;
}

async function analyzeGaps(
  questions: Question[],
  client_id: UUID,
  competitor_domains: string[]
): Promise<Question[]> {
  // Check what competitors already rank for
  for (const question of questions) {
    question.competitor_coverage = await checkCompetitorRankings(
      question.question_text,
      competitor_domains
    );
  }
  
  // Check what client already published
  const clientPages = await getPublishedPages(client_id);
  const clientCoverage = new Set(
    clientPages.map(p => normalizeQuestion(p.h1_headline))
  );
  
  // Filter to unanswered questions
  const unanswered = questions.filter(q => 
    !clientCoverage.has(normalizeQuestion(q.question_text)) &&
    q.competitor_coverage.length < 3  // less than 3 competitors rank = opportunity
  );
  
  return unanswered;
}

async function buildClusterStructure(
  questions: Question[]
): Promise<ClusterMap> {
  // Group questions into topical clusters
  // Use keyword similarity + semantic clustering (OpenAI embeddings)
  
  const clusters = await semanticCluster(questions, {
    min_cluster_size: 5,
    max_clusters: 10
  });
  
  // Identify pillar topics (broadest, highest volume questions per cluster)
  const pillar_topics = clusters.map(cluster => {
    const pillar = cluster.questions.sort((a, b) => 
      (b.search_volume || 0) - (a.search_volume || 0)
    )[0];
    
    return {
      id: generateUUID(),
      topic: pillar.question_text,
      target_keyword: extractKeyword(pillar.question_text),
      search_volume: pillar.search_volume || 0,
      cluster_questions: cluster.questions.map(q => q.id)
    };
  });
  
  return { pillar_topics };
}

async function feedA02(
  cluster_map: ClusterMap,
  client_id: UUID
): Promise<void> {
  // Create page generation queue entries with cluster metadata
  
  for (const pillar of cluster_map.pillar_topics) {
    // Generate pillar page
    await createPageQueueEntry({
      client_id,
      page_type: 'pillar',
      h1_headline: pillar.topic,
      target_keyword: pillar.target_keyword,
      cluster_id: pillar.id,
      priority: 100  // pillars are highest priority
    });
    
    // Generate cluster pages (supporting questions)
    for (const question_id of pillar.cluster_questions) {
      const question = await getQuestion(question_id);
      
      await createPageQueueEntry({
        client_id,
        page_type: 'cluster',
        h1_headline: question.question_text,
        target_keyword: extractKeyword(question.question_text),
        cluster_id: pillar.id,
        pillar_page_id: pillar.id,  // link back to pillar
        priority: question.priority
      });
    }
  }
}
```

Validation:
- All generated pages pass through A-05 quality gates (same 15 gates as existing pages)
- Questions must have relevance_score >= 70 to enter backlog
- Cluster structure validates that each pillar has 5-15 supporting cluster pages

Data Sources (priority order):
1. **AlsoAsked API** -- clean, paid, reliable ($99/mo for 500 queries)
2. **Google PAA via SERP API** -- DataForSEO or SerpAPI ($30-50/mo)
3. **Google Search Console queries** -- client's own GSC property, free, requires GSC API integration

Excluded sources:
- AnswerThePublic -- blocks scraping, paid API exists but inferior to AlsoAsked

Pricing positioning:
- **Authority tier:** 10 pillar + 50 cluster pages per month (60 total)
- **Dominance tier:** 20 pillar + 100 cluster pages per month (120 total)
- Starter + Growth tiers: NOT available (exclusive Authority/Dominance feature)

Outputs:
* Prioritized question backlog feeding A-02 Page Generator
* Pillar + cluster page structure (internal linking handled by A-06)
* Topical authority metrics tracked in dashboard
* Competitor gap analysis reports for operator review

NOT in scope for Phase 1 or 1.5. Phase 2 only.

**Additional capabilities (2026-05-17 augmentation):**

- **Semantic cluster expansion** — For each core service, build supporting-topic content layers (e.g., 'roof replacement' core → supporting topics: roof inspection, roof insurance claims, roof material comparison, roof age assessment). Establishes topical depth.
- **Knowledge-domain saturation** — Per service vertical, comprehensive coverage of materials, processes, regulations, common problems, regional considerations. Signals expertise depth.
- **Entity graph amplification** — Increase Schema.org relationships between services, locations, materials, manufacturers, and storm events. Each new evidence_items photo adds entity relationships that strengthen the topical graph.

________________________________________

## A-18 JOB EVIDENCE UPLOAD (Phase 1.5)

### Mission
Capture verified job completion evidence from contractors immediately after job completion. Powers downstream A-14 Review Request workflow, Pool C Customer Evidence modules in A-02 page generation, and case study content for client portal and operator dashboard.

### Trigger
Contractor manually uploads via mobile-friendly web interface or future native app. No automated detection of job completion in Phase 1.5.

### Capture Requirements
For each job upload:
- 3-8 completion photos (required minimum 3)
- Customer first name and last initial (full name not required, privacy-protective)
- Customer email address (required for A-14 review request flow)
- Optional: customer phone for SMS-based review request flow
- Job description (1-2 sentences, contractor-authored)
- Job location: city + neighborhood (NOT full street address, privacy-protective)
- Service type from client's existing services list (dropdown selection)
- Job completion date
- Optional: scope and value range (for case study aggregation)
- Permission flag: contractor confirms customer has been informed photos may be used in marketing materials

### Storage and Privacy
- Photos uploaded to Supabase Storage at job_evidence/{client_id}/{job_id}/
- Photo metadata stored in extracted_evidence table with evidence_type='completed_job'
- Customer email stored separately in job_evidence_contacts table (referenced from extracted_evidence via job_id)
- Customer PII access strictly tenant-scoped via RLS
- 7-year retention for completed job records (matches insurance industry standards)
- Customer email deletion on DSAR request without affecting job photo retention

### Mobile-First UI
- Mobile web optimized (contractors uploading from job site on phone)
- Camera integration for direct capture
- Drag-and-drop for desktop upload
- Bulk upload support
- Operator-side approval queue for evidence review before A-14 trigger

### Integration with A-02
Pool C modules consume approved job evidence:
- Photo grid modules
- Before/after slider modules
- Customer story longform modules
- Address-pinned completed jobs map modules
- Neighborhood density map modules

### Acceptance Criteria
- Mobile web upload completes in under 60 seconds for 5-photo job
- Operator approval workflow functional
- A-14 review request fires only on operator-approved job evidence
- Pool C modules render correctly with real job evidence
- Customer email validation enforced
- Photo dimensions and format validated (WebP/JPEG, under 10MB per photo)

**Additional capabilities (2026-05-17 augmentation):**

- **AI-generated image detection** — Run uploaded job photos through AI-generated-image classifier (e.g., Hive Moderation, AI-or-Not, or equivalent). Reject AI-generated images. Critical: clients submitting AI-fabricated job evidence would catastrophically damage platform trust if discovered by Google.
- **Duplicate-image suppression** — Hash all uploaded images (perceptual hash, not just MD5). Reject re-uploads of images already in evidence_items for the same client across different jobs. Prevents cosmetic photo reuse that signals fake work history.
- **Chronological project timeline** — Build per-service-area chronological job timeline from EXIF timestamps. Output drives A-43 Trust Signal Composer 'operational history' display blocks.

________________________________________

A-19: UNIVERSAL INTEGRATION HUB (NEW - Phase 1 CRITICAL)
Phase: 1 (CRITICAL for automation)
Trigger: External webhook from field service software OR manual entry
Runtime: Edge Function
Timeout: 30s
Purpose: Normalize job completion data from ANY source (ServiceTitan, Jobber, Zapier, manual, etc.)

Architecture:
```
External System (Field Service Software)
     
Webhook POST /api/webhooks/field-service/ingest
     
A-19: Universal Integration Hub
    " Authenticate webhook
    " Identify integration type
    " Normalize payload via adapter
    " Validate required fields
    " Create job_evidence record
     Trigger A-18 (photo upload request)
```

1. Webhook Receiver
```typescript
// Single endpoint for ALL integrations
app.post('/api/webhooks/field-service/ingest', async (req, res) => {
  const event: WebhookEvent = req.body;

  // Authenticate
  const isValid = await verifyWebhookSignature(event, req.headers);
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Process via A-19
  await A19_ProcessJobCompletion(event);

  res.status(200).json({ success: true });
});
```

2. Integration Adapters
```typescript
interface JobCompletionNormalized {
  client_id: UUID;
  job_id: string; // From external system
  service: string; // e.g., "HVAC Repair"
  location: {
    address: string;
    city: string;
    state: string;
    zip: string;
    lat?: number;
    lng?: number;
  };
  completed_at: Date;
  customer?: {
    name: string;
    email?: string;
    phone?: string;
  };
}

const INTEGRATION_ADAPTERS = {
  servicetitan: new ServiceTitanAdapter(),
  jobber: new JobberAdapter(),
  housecallpro: new HousecallProAdapter(),
  zapier: new ZapierAdapter(),
  manual: new ManualAdapter()
};

class ServiceTitanAdapter {
  async normalize(payload: any): Promise<JobCompletionNormalized> {
    return {
      client_id: payload.clientId, // Mapped from ServiceTitan tenant
      job_id: payload.jobNumber,
      service: payload.businessUnit.name,
      location: {
        address: payload.location.street,
        city: payload.location.city,
        state: payload.location.state,
        zip: payload.location.zip,
        lat: payload.location.latitude,
        lng: payload.location.longitude
      },
      completed_at: new Date(payload.completedOn),
      customer: {
        name: payload.customer.name,
        email: payload.customer.email,
        phone: payload.customer.phoneNumber
      }
    };
  }
}

class ZapierAdapter {
  async normalize(payload: any): Promise<JobCompletionNormalized> {
    // Flexible schema - expects Zapier to format correctly
    return {
      client_id: payload.client_id,
      job_id: payload.job_id,
      service: payload.service,
      location: payload.location,
      completed_at: new Date(payload.completed_at),
      customer: payload.customer
    };
  }
}

class ManualAdapter {
  async normalize(payload: any): Promise<JobCompletionNormalized> {
    // From operator dashboard manual entry
    return payload; // Already in correct format
  }
}
```

3. Job Processing
```typescript
async function A19_ProcessJobCompletion(event: WebhookEvent) {
  // 1. Identify adapter
  const adapter = INTEGRATION_ADAPTERS[event.integration_type];

  if (!adapter) {
    // Unknown integration - send to operator for manual mapping
    await createOperatorTask({
      type: 'unknown_integration',
      payload: event.payload,
      instructions: 'Create custom field mapping for this integration'
    });
    return;
  }

  // 2. Normalize payload
  const normalized = await adapter.normalize(event.payload);

  // 3. Validate required fields
  const validation = validateJobCompletion(normalized);
  if (!validation.valid) {
    await logError('invalid_job_data', {
      errors: validation.errors,
      payload: event.payload
    });
    return;
  }

  // 4. Resolve service_id and city_id
  const service_id = await resolveServiceId(normalized.service, normalized.client_id);
  const city_id = await resolveCityId(normalized.location.city, normalized.location.state);

  // 5. Create job_evidence record
  const jobEvidence = await supabase
    .from('job_evidence')
    .insert({
      client_id: normalized.client_id,
      job_id: normalized.job_id,
      job_date: normalized.completed_at,
      service_id,
      city_id,
      location_lat: normalized.location.lat,
      location_lng: normalized.location.lng,
      customer_name: normalized.customer?.name,
      customer_email: normalized.customer?.email,
      customer_phone_last_four: normalized.customer?.phone?.slice(-4),
      status: 'pending_upload'
    })
    .select()
    .single();

  // 6. Trigger A-18 (photo upload request)
  await A18_TriggerPhotoRequest(jobEvidence.id);

  // 7. Optionally trigger A-14 (review request)
  if (normalized.customer?.email || normalized.customer?.phone) {
    await A14_TriggerReviewRequest(jobEvidence.id, normalized.customer);
  }

  // 8. Log event
  await logAgentEvent({
    agent_name: 'A-19_Integration_Hub',
    event_type: 'job.completed',
    metadata: {
      integration_type: event.integration_type,
      job_id: normalized.job_id
    }
  });
}
```

4. Service/City Resolution
```typescript
async function resolveServiceId(serviceName: string, client_id: UUID): Promise<UUID> {
  // Fuzzy match against client's configured services
  const clientServices = await getClientServices(client_id);

  const match = fuzzyMatch(serviceName, clientServices.map(s => s.name));

  if (match.score > 0.8) {
    return match.service_id;
  }

  // No match - create operator task
  await createOperatorTask({
    type: 'unmapped_service',
    client_id,
    service_name: serviceName,
    instructions: 'Map this service to an existing service or create new'
  });

  return null;
}

async function resolveCityId(cityName: string, state: string): Promise<UUID> {
  // Exact match
  let city = await supabase
    .from('cities')
    .select('id')
    .eq('name', cityName)
    .eq('state', state)
    .single();

  if (city.data) return city.data.id;

  // City not in system - create it
  city = await supabase
    .from('cities')
    .insert({ name: cityName, state })
    .select()
    .single();

  return city.data.id;
}
```

Outputs:
 job_evidence records created
 client_integrations configured
 Integration adapters normalize all data
 A-18 triggered (photo upload request)
 A-14 triggered (review request)

**Additional capabilities (2026-05-17 augmentation):**

- **Webhook normalization layer** — Standardize inbound event format across providers (CallRail, Salesforce, HubSpot, GBP webhooks all produce different JSON). Normalize to internal canonical event format before downstream processing.
- **Per-integration failure isolation** — Third-party API outage in one integration (e.g., CallRail down) must not cascade to other integrations or core platform. Per-integration circuit breaker with degraded-mode operation.
- **Queue buffering for traffic surges** — Buffer inbound conversion events during storm-event surges (10x normal volume possible in metro after major hailstorm). Backpressure to client CRM via batched delivery rather than dropping events.

________________________________________

A-20: MULTI-TENANT PAGE HOSTING (MODE C / DNS-ROUTED)
Phase: 1 (MANDATORY -- load-bearing architecture)
Trigger: Production deployment, DNS configuration complete
Runtime: Vercel Edge + Middleware
Purpose: Deliver Tarritrix-generated pages at client's own domain via DNS routing

**Why Phase 1 Mandatory:**
Without Mode C, generated pages have no production destination. Selling Tarritrix without pages at the client's own domain is selling vapor. SEO authority must accrue to client's domain--not a Tarritrix subdomain, not a preview URL. This is the spine of the product.

**Architecture Overview:**
Client's DNS (CNAME or delegation) routes `/locations/*` traffic to Tarritrix Vercel infrastructure. Middleware reads `Host` header to resolve `tenant_id`, injects tenant context into request, Next.js renders pages with tenant-specific data. Pages return 200 status at client's domain, canonical tags point to client's domain, internal links use client's domain.

**8 Core Components:**

1. **DNS Configuration Spec**
   - Clients configure CNAME record: `locations.clientdomain.com -> cname.vercel-dns.com`
   - OR subdomain delegation: `locations.clientdomain.com NS -> ns1.vercel-dns.com, ns2.vercel-dns.com`
   - Tarritrix Vercel project configured to accept requests for custom domains
   - DNS verification flow: client adds CNAME/delegation -> Tarritrix pings domain -> records `clients.dns_verified_at` on success

2. **Onboarding Step 5.5: DNS Setup**
   - After Step 5 (sitemap generation), before Step 6 (drip publish)
   - UI displays DNS instructions: "Add this CNAME record to your DNS provider: `locations.yourdomain.com -> cname.vercel-dns.com`"
   - Verification button: pings `https://locations.clientdomain.com/.well-known/tarritrix-verify` expecting 200 + token match
   - On verification success: `clients.dns_verified_at = NOW()`, `clients.dns_config_type = 'CNAME'`
   - Onboarding cannot proceed to Step 6 until DNS verified

3. **Vercel Routing Configuration**
   - Vercel project configured with wildcard domain support (requires Pro/Enterprise plan)
   - `vercel.json` specifies custom domain handling
   - Middleware intercepts all requests, extracts `Host` header, queries `clients` table for `client_id` WHERE `dns_verified_at IS NOT NULL AND custom_domain = Host`
   - If no match: return 404 with branded error page ("Domain not configured with Tarritrix")

4. **Tenant Resolution Middleware**
   - `middleware.ts` runs on all `/locations/*` requests
   - Extracts `Host` header (e.g., `locations.clientdomain.com`)
   - Queries Supabase: `SELECT client_id FROM clients WHERE custom_domain = $1 AND dns_verified_at IS NOT NULL`
   - Injects `X-Tarritrix-Client-ID` header into request for downstream consumption
   - Page components read `headers()` to get `client_id`, query tenant-specific data

5. **Hosting Platform Compatibility Matrix**
   - **Supported:** Vercel (native), Cloudflare Pages (CNAME proxy), Netlify (domain alias), AWS Amplify (custom domain)
   - **Unsupported:** Shared hosting without CNAME support, platforms blocking external DNS routing
   - UI displays compatibility checker: "Enter your hosting provider" -> shows CNAME instructions or "unsupported" warning

6. **Fallback for Unsupported Hosting**
   - If client cannot configure DNS: offer Mode B (Tarritrix subdomain: `clientslug.tarritrix.app`)
   - Mode B pages still render, but canonical tags point to Mode B URL (SEO penalty acknowledged)
   - Mode B is temporary workaround, not production-grade -- nudge client toward Mode C

7. **SSL/TLS Handling**
   - Vercel auto-provisions Let's Encrypt certs for custom domains
   - DNS verification prerequisite for SSL issuance
   - `clients.ssl_provisioned_at` recorded when cert active
   - Middleware redirects HTTP -> HTTPS for all custom domains

8. **Cache Invalidation on Domain Change**
   - If `clients.custom_domain` updated: purge Vercel edge cache for old domain + new domain
   - Ensures no stale pages served after domain migration
   - Cache purge triggers A-25 (cache invalidator agent, Phase 2 deferred)

**Database Changes:**
```sql
-- Add to clients table
ALTER TABLE clients ADD COLUMN dns_verified_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN dns_config_type TEXT CHECK (dns_config_type IN ('CNAME', 'DELEGATION', 'SUBDOMAIN'));
ALTER TABLE clients ADD COLUMN dns_last_check_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN ssl_provisioned_at TIMESTAMPTZ;

-- New table: DNS verification audit log
CREATE TABLE dns_verification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  verification_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('success', 'failed', 'pending')),
  dns_config_type TEXT,
  error_message TEXT,
  verified_domain TEXT,
  INDEX idx_dns_verification_client (client_id)
);
```

**SEO Requirements (Mode C Only):**
- Pages return HTTP 200 at client's domain (not 301/302 redirect)
- `<link rel="canonical" href="https://locations.clientdomain.com/locations/city-state">` points to client domain
- Internal links (`<a href="/locations/...">`) use relative paths (resolve to client domain)
- Sitemap submitted to GSC under client's domain property
- `robots.txt` at `https://locations.clientdomain.com/robots.txt` allows crawling

**Why Not Subdomain (Mode B)?**
Mode B (`clientslug.tarritrix.app`) accrues SEO authority to `tarritrix.app`, not client's domain. Google treats subdomains as separate entities from root domain. Client's root domain (`clientdomain.com`) gets zero SEO benefit. Mode B is acceptable for staging/preview, but production MUST be Mode C.

**Edge Cases:**
- **Client changes domain mid-contract:** Update `clients.custom_domain`, re-verify DNS, purge cache, resubmit sitemap
- **Client has existing `/locations/` path:** Coordinate with client to migrate existing content or use different path (e.g., `/local-seo/`)
- **Client uses subdomain for other purpose:** Use different subdomain (e.g., `localpages.clientdomain.com`)

**Dependencies:**
- Vercel Pro/Enterprise plan (wildcard domain support)
- Supabase client lookup query optimized (index on `clients.custom_domain`)
- Onboarding UI flow updated to include Step 5.5 (DNS setup)
- Middleware performance: <10ms overhead for tenant resolution

**Acceptance Criteria:**
[ok] Client configures CNAME, Tarritrix verifies DNS within 60 seconds
[ok] Pages load at `https://locations.clientdomain.com/locations/city-state` with 200 status
[ok] Canonical tag points to client's domain
[ok] Internal links use client's domain (not tarritrix.app)
[ok] SSL cert auto-provisions within 5 minutes of DNS verification
[ok] Middleware resolves `client_id` in <10ms
[ok] Cache purge triggers on domain change within 30 seconds

________________________________________

CRON-01: DRIP PUBLISHER
Phase: 1 (daily execution)
Trigger: Runs daily at 3am UTC via pg_cron
Runtime: Database function
Timeout: 5 minutes
Purpose: Publish queued pages at conservative research-backed drip rates

What It Does:
1. Calculates days since client.onboarding_started_at
2. Determines drip phase (1: days 1-30, 2: days 31-60, 3: days 61+)
3. Updates client.drip_phase if changed
4. Updates client.drip_rate_daily to match new phase
5. Selects pages WHERE status='queued' AND publish_scheduled_at <= NOW()
6. Orders by priority:
   o Hub pages first (priority_tier=1)
   o City hubs second (priority_tier=2)
   o Service pages third (priority_tier=3)
7. Within same priority, orders by city.population DESC
8. Publishes up to drip_rate_daily pages per client
9. Invalidates ISR cache via revalidateTag(client-${id})
10. Applies +/-20% daily variance

(Drip rates canonical per Final Consolidated Tier Table, BLUEPRINT.md Part 9 Section 9.2. Older rates superseded by operator decision 2026-05-15 per audit reconciliation.)

Drip Rate Enforcement:
```sql
-- New domain (Starter tier)
Phase 1 (days 1-30): 1 page/day
Phase 2 (days 31-60): 2 pages/day
Phase 3 (days 61+): 3 pages/day

-- New domain (Growth tier)
Phase 1: 4 pages/day
Phase 2: 6 pages/day
Phase 3: 9 pages/day

-- New domain (Authority tier)
Phase 1: 8 pages/day
Phase 2: 12 pages/day
Phase 3: 18 pages/day

-- New domain (Dominance tier)
Phase 1: 15 pages/day
Phase 2: 25 pages/day
Phase 3: 40 pages/day
```

Daily Variance:
```typescript
const baseRate = client.drip_rate_daily;
const variance = 0.2; // +/-20%
const actualRate = Math.floor(
  baseRate * (1 + (Math.random() * variance * 2 - variance))
);
// Example: 10/day   8-12/day randomly
```

Priority Ordering:
```sql
SELECT *
FROM pages
WHERE client_id = $1
  AND status = 'queued'
  AND publish_scheduled_at <= NOW()
ORDER BY
  priority_tier ASC, -- Hub pages first
  (SELECT population FROM cities WHERE cities.id = pages.city_id) DESC -- Largest cities first
LIMIT $2; -- actualRate with variance
```

Outputs:
 pages.status: 'queued'   'published'
 pages.published_at timestamp set
 agent_events: 'drip.published' event with count, phase, rate
 ISR cache invalidated (pages become visible)

________________________________________

CRON-02: INDEXATION RUNNER
Phase: 1 (daily execution)
Trigger: Runs daily at 6am UTC via pg_cron
Runtime: Database function   triggers A-08 Edge Functions
Timeout: Variable (depends on client count)
Purpose: Run A-08 indexation tracker for all active clients + security checks

What It Does:
1. Queries clients WHERE status='active'
2. For each client, triggers A-08 to check indexation status
3. Respects GSC API quota (1,200 QPM, 50K page-keyword pairs/day)
4. Runs cross-tenant leak detection test (security critical)
5. Monthly: Runs pruning job (0 impressions for 90 days)
6. Logs results to agent_events

Cross-Tenant Leak Detection:
```sql
-- CRITICAL: Ensure no client sees another's data
SELECT client_id, COUNT(*)
FROM pages
WHERE status='published'
GROUP BY client_id
HAVING COUNT(DISTINCT client_id) > 1;

-- If this returns ANY rows   P0 alarm
```

Monthly Pruning Job:
```sql
-- Identify pages for pruning (0 impressions 90+ days)
SELECT p.id, p.client_id, p.url_path
FROM pages p
LEFT JOIN page_performance pp ON pp.page_id = p.id
WHERE p.status = 'published'
  AND p.published_at < NOW() - INTERVAL '90 days'
  AND (
    SELECT SUM(impressions)
    FROM page_performance
    WHERE page_id = p.id
      AND date >= NOW() - INTERVAL '90 days'
  ) = 0;

-- Create operator approval batch
INSERT INTO pruning_batches (pages, status)
VALUES ($pages, 'pending_approval');
```

Outputs:
 Indexation status updated for all clients
 Security validation confirmed
 Monthly pruning batches created
 Operator dashboard: indexation health metrics refreshed

________________________________________

3.4 Complete Database Schema

NOTE: The original blueprint specified 44 tables across multiple groups. The complete SQL DDL for all tables (Migration 001 = 37 tables, Migration 002 = 15 additional tables = 52 total) is preserved in:

- SCHEMA_REGISTRY.md (full table inventory with column-level documentation)
- supabase/migrations/20260504*.sql (Migration 001  37 base tables)
- supabase/migrations/20260505200000_tarritrix_phase1_completion.sql (Migration 002  15 additional tables)

Total Tables: 52
- 37 from Migration 001 (clients, services, cities, pages, page_content_profile, page_quality_scores, page_schemas, page_sitemaps, page_performance, evidence_items, claimed_facts, agent_events, conversions, gbp_profiles, gbp_review_responses, ai_visibility_scores, stack_jobs, queue_jobs, platform_config, plans, billing_events, dsar_requests, fact_documents, page_legal_terms, audit_packages, ai_index_signals, ai_visibility_metrics, ai_query_universe, ai_traffic_attribution, signals, signals_cache, storm_demand_alerts, demand_signals, social_competitor_pools, social_engagement_log, social_platform_credentials, content_diff_archive)
- 15 from Migration 002 (job_evidence, job_content_linkage, client_integrations, integration_field_mappings, review_requests, gbp_posts, qa_seeds, entity_audit_log, page_decisions, operator_actions, cron_run_log, review_response_drafts, client_risk_profiles, governance_violations, security_events, llm_calls, email_deliverability, session_logs, audit_log, tenant_signals, demo_requests)

For full DDL refer to migration files. SCHEMA_REGISTRY.md contains column descriptions, foreign key relationships, RLS policies, and index definitions.

### 3.4A Data Architecture: Cities Master Table

The cities master table is the canonical reference for all city-level data in the platform. It must be seeded with ~3,500 US cities ≥ 25K population before operator onboarding expansion ships. Per-client city assignments (the existing service-area cities) reference this master table.

**Purpose:** Operator onboarding city-selection UX (Gap #3) requires a populated cities master table to function. Currently the cities table only contains test/demo data.

**Seed timing:** Before operator onboarding form expansion (Phase 1 Step 2) or A-05 Page Validator ships, whichever requires city lookups first.

**Source:** US Census Bureau API or Census-derived static dataset (e.g., SimpleMaps US Cities Database free tier).

**Columns populated:** city_name, state_code, county, population, lat, lng, time_zone, fips_code, is_metro_anchor.

See SCHEMA_REGISTRY.md cities table planned seed for full specification.

________________________________________

PART 4: CLIENT ONBOARDING WORKFLOW

4.1 Onboarding Steps (8 Steps)

Step 1: Business Information
Operator Interface collects:
- Business Legal Name (required)
- DBA (Doing Business As)
- Industry (HVAC, Plumbing, Roofing, Electrical, etc.)
- Business Type (B2B or B2C)

Validation:
- Industry not in excluded list
- Legal name not duplicate

Step 2: Service Area
Collects:
- Business Address (Google Maps Autocomplete)
- Geocoded coordinates confirmed
- Phone Number (E.164 format)
- Website URL (HTTPS verified, reachable)

Validation:
- Address geocodes successfully
- Phone converts to E.164
- Website is HTTPS and reachable

Step 3: Cities " Services Selection
Tier-aware interface:
- Selected tier determines max cities and services
- Real-time city search with drive-time validation (90-min max)
- Population displayed per city from Census API
- Hard block on tier limit
- Live page count calculator (cities " services)

Validation:
- Cities within 90min drive (Distance Matrix API)
- Cities count  degrees tier max
- Services count  degrees tier max

### 4.1A City Selection Model (Hybrid - Model C)

When an operator onboards a new client, the platform must determine which cities the client's pages will target. Three models were evaluated:

**Model A:** Operator manually picks every target city from a populated dropdown. Maximum control, slowest onboarding.

**Model B:** System auto-populates target cities based on service center + service_radius_miles. Fastest, least control.

**Model C (LOCKED):** Hybrid — system auto-populates default cities within service radius from the cities master table, presents them as a pre-checked list, operator can add or remove cities before finalizing.

**Model C is the canonical UX.** Reason: balances onboarding speed with operator control over which cities receive page generation budget.

**Dependencies:** Requires cities master table seed (Gap #2) AND operator onboarding form expansion (Phase 1 Step 2 of next-session plan).

**Implementation timing:** Phase 1 onboarding form expansion, after cities master table seed migration applies.

Step 4: Evidence Upload
Collects:
- Photos (10+ required for Growth and Authority tiers)
- Testimonials (Optional)
- Case Studies (Optional)
- Certifications and Awards

Validation:
- Minimum 10 photos for Growth/Authority tiers
- Image quality  degrees1200"900px

Step 5: Consent Collection
All checkboxes required:
- Terms of Service consent
- TCPA Consent (verbatim FCC one-to-one text displayed)
- Data Processing Agreement
- GBP Management Authorization
- Call Tracking Consent (CallRail)

Critical:
- ALL checkboxes must be checked
- Consent IP + user agent logged (immutable)

Step 6: Google Authorization
Per-client GCP project required (ADR-17):
- Option 1: Connect existing GCP project
- Option 2: Operator creates new GCP project for client

Required APIs:
- Maps JavaScript API
- Geocoding API
- Places API
- Distance Matrix API
- Search Console API
- Maps Embed API

OAuth Scopes Needed:
- GBP Management
- Search Console (read)

Critical:
- Each client = separate GCP project (ADR-17)
- Never share API keys across clients

Step 7: Payment & Signature
Stripe payment setup:
- Market Activation Fee charged immediately on completion
- Monthly billing begins 30 days after activation

DocuSign:
- Master Service Agreement sent and signed
- Account activation blocked until both confirmed

Triggers:
- Stripe payment intent created
- DocuSign envelope sent
- On completion: clients.status = 'active'
- Triggers A-01   pipeline begins

Step 8: Integration Setup (NEW)
Field service software connection:

Pre-Built Integrations:
- ServiceTitan
- Jobber
- HousecallPro
- FieldRoutes

Universal Options:
- Zapier (works with ANY software)
- Manual entry (no software - operator enters jobs)

Custom integrations:
- Webhook URL: https://api.tarritrix.com/webhooks/{client_webhook_token}

Purpose:
- Enable job completion   SEO pipeline automation
- Critical for A-19 Universal Integration Hub

Step 9: Knowledge Ingestion (Automatic, Platform-Executed)

Triggered automatically by the platform upon completion of Step 7 (Payment & Signature) and propagation of clients.status = 'active'. No operator data entry required for Step 9 — the platform reads the website URL captured in Step 2 and initiates A-44 Client Knowledge Ingestion Engine.

What happens:
- A-44 crawls the client's website using a Playwright headless crawler with 2-second rate limit per request
- Extracts brand voice and terminology, existing keywords ranking for the domain, NAP data, service descriptions verbatim, tone of voice analysis, existing claims, certifications and awards, customer testimonials with attribution, case studies and project photos, manufacturer badges (GAF, CertainTeed, Owens Corning, etc.), trust marks (BBB, Angi, HomeAdvisor), professional licensing badges, logos, insurance certifications, industry association memberships, and EXIF data from photos worth importing to evidence_items
- Persists outputs to client_ingested_assets, client_brand_voice_model, client_keyword_gap_analysis tables (per A-44 canonical spec in Part 10.5)
- Creates client_ingestion_versions row with trigger_type='onboarding', approval_status='auto_approved', is_current=TRUE
- LLM cost: approximately $0.35–0.55 per client (one-time at onboarding)
- Typical duration: 3–7 minutes for sites under 100 pages
- Master_admin or senior_admin can preview captured assets via the new Knowledge Base tab on /dashboard/clients/[id] after completion

Hard requirements (Contract 73):
- A-02 Page Generator cannot execute for this client until Step 9 completes successfully
- If A-44 fails at onboarding (site down, robots.txt blocks crawl, parse error), the client remains in clients.status = 'active' but pages.generation is blocked until master_admin or senior_admin either retries A-44 successfully or uses the master_admin override path to manually provide ingestion assets (see Part 10.5 for override specification)

Backward compatibility note:
For existing seeded clients that were activated before A-44 shipped (e.g., E4 Construction & Roofing), a synthetic baseline row is created via the migration sequence specified in ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 4.6. The synthetic baseline satisfies Contract 73 at the database constraint level while flagging the client for a real A-44 scrape at the next operator interaction. Existing E4 page generation continues without interruption.

Validation:
- A-44 status = 'success' OR override applied
- client_ingestion_versions row exists with is_current = TRUE
- clients.current_ingestion_version_id is populated

4.2 Post-Onboarding Pipeline

```
Onboarding Complete (Step 9 triggers A-44 automatically)
     │
     ▼
A-01: Intake Processor (validates all data)
     │
     ▼
clients.status = 'active'
     │
     ▼
A-44: Client Knowledge Ingestion Engine (Phase 1, blocking)
     │   - Crawls client website
     │   - Extracts brand voice, badges, certifications, NAP, testimonials
     │   - Persists to client_ingested_assets, client_brand_voice_model
     │   - Creates client_ingestion_versions row (is_current=TRUE)
     │   - Contract 73: A-02 blocked until A-44 success
     │
     ▼
A-10: Content Profile Builder (reads A-44 output, builds 4 layers per city × service)
     │
     ▼
A-02: Page Generator (uses client_brand_voice_model from A-44)
     │
     ▼
A-03: Schema Generator (generates JSON-LD)
     │
     ▼
A-04: Map Embed Generator (generates iframes)
     │
     ▼
A-05: Page Validator (15 gates)
     │
     ├── PASS → pages.status = 'queued'
     │           │
     │           ▼
     │      A-06: Internal Link Builder
     │           │
     │           ▼
     │      A-07: Sitemap Generator
     │           │
     │           ▼
     │      CRON-01: Drip Publisher (daily, begins publishing)
     │
     └── FAIL → pages.status = 'flagged_for_review' (operator review queue, master_admin or senior_admin approves/rejects)
```

A-44 failure handling:
- If A-44 fails at onboarding, A-01 still completes and clients.status = 'active', but A-10 and A-02 cannot execute for this client. P2 advisory signal is raised to the operator queue. Retry available from /dashboard/clients/[id] Knowledge Base tab.
- If A-44 succeeds but later quarterly refresh produces a material diff requiring approval, A-02 continues to use the prior approved version until master_admin or senior_admin approves the new diff.


________________________________________

PART 5: PHASE BREAKDOWN

Phase 1: MVP (Launch-Ready)

Goal: Generate pages with 4-layer differentiation + drip publishing + job-to-SEO pipeline

Core Features:

14 Agents Functional in Phase 1:
- A-01: Intake Processor
- A-02: Page Generator
- A-03: Schema Generator
- A-04: Map Embed Generator
- A-05: Page Validator
- A-06: Internal Link Builder
- A-07: Sitemap Generator
- A-08: Indexation Tracker
- A-09: Conversion Handler
- A-10: Content Profile Builder (with heatmap data collection)
- A-11: Content Refresh Engine
- A-14: Review Velocity Engine (NEW)
- A-18: Job Evidence Ingestion (NEW)
- A-19: Universal Integration Hub (NEW)

2 CRON Jobs:
- CRON-01: Drip Publisher (daily 3am UTC)
- CRON-02: Indexation Runner (daily 6am UTC)

Core Systems:
- 4-layer content differentiation
- 15-gate page validator
- Publishing velocity control (3-phase ramp)
- TCPA compliance (immutable consent)
- Conversion tracking (forms + CallRail)
- Job completion   photo upload   page refresh pipeline
- Tier enforcement (5/15/30 cities, 1/3/5 services)

Dashboards:
- Operator dashboard (client mgmt, review queue, analytics)
- Client dashboard (read-only pages, lead log, analytics)

What's Manual (Phase 1):
- GBP management (operator uses web UI, no API yet)
- Review responses (drafts generated, operator posts manually)
- Entity building (operator follows playbook)

Infrastructure:
- Supabase (DB + Auth + Edge Functions + Queue + Storage)
- Next.js 14+ (frontend)
- shadcn/ui (UI components)
- Vercel (deployment)

Phase 1.5: GBP API Integration

Requirement: Google GBP API approval (4-8 week wait)

Apply for GBP API NOW even though Phase 1.5 is later

New Features:
- A-12: GBP Agent (FULL)
  - Edit velocity throttling
  - Auto-reject monitoring
  - Completeness scoring
  - Image category balance enforcement
  - Direct GBP API integration (no more manual links)
- A-02 Layout Archetype Taxonomy: 10 primary layout archetypes (Map-First, Stats-First, Narrative-First, Media-First, Timeline-First, Emergency-First, Property-First, Community-First, Comparison-First, Editorial-First) for composition recipe authoring and selection variance
- Storm History Archive page type (Template 13): year-by-year city storm history pages for topical authority on informational queries
- Hyperlocal Climate Corridors page subtypes: hail corridors, wind corridors, microclimate pages for neighborhoods with disproportionate storm activity
- A-10 Temporal Context Layer: seasonal and event-driven content biasing (spring prep, active storm response, storm anniversaries, pre-storm season)
- Storm Event Severity Composite Score: ranked 0-100 severity per event for Pool A modules, storm history pages, and operator analytics
- Geo-Grid Layer 2: Google Rank Tracking (Phase B Section 5)
  - Behind feature flag: platform_config.geo_grid_layer_2_rankings = false in Phase 1
  - Vendor LOCKED 2026-05-16: Decodo (formerly Smartproxy) SERP API
  - Entry pricing: $30/month Core plan, $0.32/1k requests (covers Phase 1.5 5-10 client load)
  - Mid-scale pricing: $99-$499/month tiers, $0.20-$0.30/1k requests (Phase 2 25-100 clients)
  - Volume floor: $0.08/1k requests at $3,999/month commitment (Phase 3 500+ clients)
  - Rationale: 99.68%+ success rate verified by Proxyway 2025 benchmark, 0.54s avg response time, 115M+ residential IP pool, no enterprise features Tarritrix doesn't need
  - DIY scraper option permanently rejected: proxy bandwidth alone (~$2-3.5k/mo at 100 clients via residential proxies) plus ongoing anti-bot maintenance exceeds Decodo cost at every realistic scale
  - Cost pass-through as COGS or margin absorption (operator decision at Phase 1.5 entry)
  - Phase 1 free demo path: 2,500 free Serper.dev queries OR 1,000 free Scrapingdog credits for one-time strategic partnership prospect scan (snapshot data, not production)

Phase 2: AI Optimization & Advanced Analytics

**Entry Criteria:**
Phase 2 commences when (a) Phase 1 exit criteria per MASTER_BUILD_SPEC.md Section 20 are satisfied, AND (b) operator explicitly authorizes Phase 2 advancement. No client count, revenue threshold, or time gate. Operator-driven.

New Features:
- A-13: AI Visibility Monitor (ChatGPT/Gemini/Perplexity rank tracking, share of voice, sentiment monitoring)
- A-15: GBP Post Generator (job completion   auto-generate post, recurring post scheduling)
- A-16: Q&A Seed Manager (industry-specific Q&A templates, auto-populate GBP Q&A)
- A-17: Entity Consistency Monitor (cross-platform NAP auditing, auto-correction, citation discovery)
- A-02 Axis 4b Per-Page Visual Variance Layer: micro-rhythm variance (spacing density, shadow profile, animation cadence, gradient intensity, typography hierarchy weight) within client brand signature, with A-29 Performance Learning correlation
- Storm Intelligence AI Micro-Narratives: operator-approved LLM-generated factual prose for P0/P1 severity events, validated by A-05 Gates 1 and 10, cost $0.05-$0.15 per event
- Automated Review Response (LLM generation + ReviewReplyState compliance, operator approval workflow)
- Recurring GBP Posts (via Recurrence Info API)

Revenue Opportunity:
- AI Visibility Score as premium add-on (+$300-500/mo per client)

**Phase B Section 9  Deferred to Phase 2:**
- Visual/template differentiation engine: Library of 10-20 page templates with randomized component composition. Phase 1 page template must be built modularly so Phase 2 swap is not a rewrite.
- Enriched lead download ($1/lead pay-per-download): Requires ATTOM API + Stripe per-download flow. Per existing memory entry, deferred post-launch.

Phase 3: Storm Intelligence Engine Integration

**Entry Criteria:**
Phase 3 commences when (a) Phase 2 exit criteria are satisfied, AND (b) operator explicitly authorizes Phase 3 advancement. No client count, revenue threshold, or time gate. Operator-driven.

**Phase B Section 9  Deferred to Phase 3+:**
- Proprietary rank scraper (vs SerpAPI rental): Only if Phase 2 unit economics justify. Adds significant scope: residential proxy pools, browser fingerprint randomization, CAPTCHA solving infrastructure, ongoing maintenance burden. Operator decision at Phase 3 entry.

Storm Intelligence Engine Features:

Social Signal Monitoring:
- Reddit, Google Reviews, Yelp, X/Twitter, Facebook (official APIs only)
- Real-time storm event detection
- Demand signal detection ("anyone know a good roofer?")

Storm Event   Hyperlocal Content Pipeline:
- Real-time hail/storm detection
- Auto-generate GBP posts
- Auto-generate landing page content
- NO COMPETITOR CAN REPLICATE without Storm Intelligence Engine data

Sentiment Classification:
- Positive/negative/neutral/demand
- Review response assistance
- Competitor intelligence (operator-only)

Storm Intelligence Engine API Costs (Estimated Monthly):

| Platform | Cost | Notes |
|----------|------|-------|
| Reddit API | $0 | Standard free, 60 req/min |
| Google Reviews (GBP API) | $0 | Included in GCP |
| Yelp Fusion API | $0 | Free tier, 5K calls/day |
| X API v2 Pro | $5,000 | MAJOR COST |
| Meta Graph API | $0 | User-token based |
| LLM Sentiment | ~$50 | 500 signals " $0.10 |
| Total | ~$5,050/mo | Dominated by X API |

Revenue Model:
- Tier 3 base: $1,997/mo
- Storm Intelligence Engine premium: +$500-1,000/mo
- Total: $2,497-2,997/mo
- Margin: 50-60% after API costs

Decision: Only build if Phase 1-2 data proves it's needed.

________________________________________

PART 6: COMPLETE ENV VARIABLE SPECIFICATION

Required API Keys & Credentials (Before Day 1)

Create file: .env.local

```bash
# =============================================================================
# TARRITRIX ENVIRONMENT VARIABLES - COMPLETE LIST
# =============================================================================

# SUPABASE
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9... # NEVER expose to frontend
SUPABASE_DB_PASSWORD=your-db-password

# ANTHROPIC
ANTHROPIC_API_KEY=sk-ant-api03-...

# GOOGLE APIS
GOOGLE_MAPS_API_KEY=AIza...
GOOGLE_OAUTH_CLIENT_ID=123456789-abc.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...
GOOGLE_OAUTH_REDIRECT_URI=https://tarritrix.com/api/auth/google/callback
GOOGLE_GBP_API_KEY=AIza... # Apply now, 4-8 week wait
GOOGLE_SEARCH_CONSOLE_API_KEY=AIza...

# TWILIO
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-auth-token
TWILIO_PHONE_NUMBER=+15125551234
TWILIO_WEBHOOK_SECRET=whsec_...

# RESEND
RESEND_API_KEY=re_...

# STRIPE
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRODUCT_ID_STARTER=prod_...
STRIPE_PRODUCT_ID_GROWTH=prod_...
STRIPE_PRODUCT_ID_AUTHORITY=prod_...

# CALLRAIL
CALLRAIL_API_KEY=your-api-key
CALLRAIL_ACCOUNT_ID=ACC...
CALLRAIL_WEBHOOK_SECRET=your-webhook-secret

# DOCUSIGN
DOCUSIGN_INTEGRATION_KEY=your-integration-key
DOCUSIGN_USER_ID=your-user-id
DOCUSIGN_ACCOUNT_ID=your-account-id
DOCUSIGN_RSA_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"

# CENSUS API (Public, No Key)

# PLATFORM CONFIGURATION
NODE_ENV=development
NEXT_PUBLIC_APP_URL=http://localhost:3000
LLM_DAILY_COST_CAP=5
MAX_PAGES_PER_GENERATION=150

# Feature Flags
FEATURE_FLAG_GBP_API=false
FEATURE_FLAG_AI_VISIBILITY=false
# Storm Intelligence Engine feature flag (legacy variable name preserved)
FEATURE_FLAG_VSIE=false

# FIELD SERVICE INTEGRATIONS (Optional)
SERVICETITAN_CLIENT_ID=your-client-id
SERVICETITAN_CLIENT_SECRET=your-client-secret
JOBBER_API_KEY=your-api-key
HOUSECALLPRO_API_KEY=your-api-key

# PHASE 2/3 APIs (Not needed for Phase 1)

# Storm Intelligence Engine - Social Monitoring (Phase 3)
REDDIT_CLIENT_ID=your-client-id
REDDIT_CLIENT_SECRET=your-client-secret
YELP_API_KEY=your-api-key
TWITTER_API_KEY=your-api-key # $5K/month
FACEBOOK_APP_ID=your-app-id
FACEBOOK_APP_SECRET=your-app-secret
```

ENV Variable Acquisition Checklist

CRITICAL - GET THESE FIRST (Week 1):
- Supabase - supabase.com (5 min)
- Anthropic - console.anthropic.com (5 min, add $100 credits)
- Google Cloud Platform - console.cloud.google.com (30 min)
  - Enable: Maps, Geocoding, Places, Distance Matrix APIs
  - Set up billing
- Stripe - dashboard.stripe.com (20 min)
  - Create 4 products (Starter/Growth/Authority/Dominance)
  - Get webhook secret
- Twilio - twilio.com (15 min)
  - Buy phone number ($1/mo)
  - Enable MMS
- Resend - resend.com (5 min)
  - Verify sending domain

MEDIUM PRIORITY - GET THESE WEEK 2:
- Google Business Profile API - developers.google.com/my-business
  - START APPLICATION NOW (4-8 week approval)
- Google Search Console API - Enable in GCP
- CallRail - callrail.com
- DocuSign - docusign.com

LOW PRIORITY - Get Later (Phase 2+):
- Field Service Software APIs (only if clients need)
- AI Visibility APIs (Phase 2)
- Storm Intelligence Engine APIs (Phase 3) - WARNING: Twitter = $5K/month

________________________________________

PART 7: DOCUMENT PRODUCTION ESTIMATE

Based on this complete blueprint, the comprehensive engineering-level specifications required:

Category A: Product & Business (4 Docs)
1. DOC-01: Business Case & Market Analysis
2. DOC-02: Product Requirements Document (PRD)
3. DOC-03: Pricing & Tier Architecture
4. DOC-04: Sprint Plan & Implementation Roadmap

Category B: Architecture & Design (6 Docs)
5. DOC-05: System Architecture Overview
6. DOC-06: Architecture Decision Records (ADRs)
7. DOC-07: Agent Boundary & Domain Model
8. DOC-08: Data Architecture & Lineage
9. DOC-09: Content Differentiation Strategy (Technical)
10. DOC-10: Security & Threat Model

Category C: Database & Data (3 Docs)
11. DOC-11: Complete Database Schema DDL
12. DOC-12: Database Migration Strategy
13. DOC-13: Data Retention & Archival Policy

Category D: API & Integration (3 Docs)
14. DOC-14: API Specification (OpenAPI 3.0)
15. DOC-15: Event Schema Registry
16. DOC-16: Third-Party API Integration Guide

Category E: Agents & Workflows (6 Docs - EXPANDED)
17. DOC-17: Agent Service Contracts (17 Agents)
18. DOC-18: State Machines & Lifecycle Management
19. DOC-19: Sequence Diagrams (Critical Flows)
20. DOC-20: CRON Job Specifications
21. DOC-21: Queue Management & Background Jobs
22. DOC-22: Job Evidence Pipeline Specification (NEW)

Category F: User Interface (3 Docs)
23. DOC-23: Operator Dashboard Specification
24. DOC-24: Client Dashboard Specification
25. DOC-25: Page Template Specification

Category G: Compliance & Legal (6 Docs)
26. DOC-26: TCPA Compliance Implementation
27. DOC-27: CPRA/GDPR Data Privacy Compliance
28. DOC-28: WCAG 2.1 AA Accessibility Compliance
29. DOC-29: FTC Endorsement & Claims Compliance
30. DOC-30: Google Policy Compliance Matrix
31. DOC-31: Terms of Service & Legal Contracts

Category H: Operations & Runbooks (5 Docs)
32. DOC-32: DSAR Runbook
33. DOC-33: Incident Response Runbook
34. DOC-34: Pre-Launch Checklist
35. DOC-35: Operator Playbooks (Phase 1 Manual Tasks)
36. DOC-36: Monitoring & Alerting Configuration

Category I: Engineering Standards (5 Docs)
37. DOC-37: Code Style & Standards
38. DOC-38: Testing Strategy & Requirements
39. DOC-39: CI/CD Pipeline Specification
40. DOC-40: Observability & Logging Standards
41. DOC-41: Failure Handling & Resilience Patterns

Category J: Phase-Specific (3 Docs)
42. DOC-42: Phase 1.5 - GBP API Integration Spec
43. DOC-43: Phase 2 - AI Optimization Spec
44. DOC-44: Phase 3 - Storm Intelligence Engine Integration Spec

________________________________________

# ============================================================================
# END OF ORIGINAL BLUEPRINT  BELOW ARE 2026-05-05 GOVERNANCE RESET ADDITIONS
# ============================================================================

PART 8: 2026-05-05 GOVERNANCE RESET  ADDITIONS

The following sections were added during the 2026-05-05 governance reset session. They add operational specifications for surfaces and systems not detailed in the original blueprint above. They do not replace anything in the original.

8.1  RECOMMENDATIONS ENGINE (DISTINCT MODULE)

Purpose: Examine each client's state every 5 minutes and produce actionable Next Best Actions for the operator.

Architecture:
- Edge Function: `recommendations-engine`
- Triggered: pg_cron every 5 minutes
- Reads: clients, pages, page_quality_scores, llm_calls, conversions, gbp_profiles, agent_events, dsar_requests, billing_events
- Writes: tenant_signals (with priority, type, message, recommended_action, target_url, dismissed flag)

Recommendation Categories (8):
1. Quality issues  flagged pages aging, low quality scores
2. Cost anomalies  LLM spend spikes, cap proximity (e.g., "Client X at 87% of daily LLM cap with 3 hours remaining")
3. Lifecycle events  drip phase transitions due, refresh cycles due
4. Compliance  DSAR deadlines approaching (45-day window), TCPA gaps, missing consent
5. Integration  webhook failures, sync gaps, ServiceTitan/Jobber/Zapier disconnects
6. Onboarding  incomplete steps, validation failures, GCP project not configured
7. Performance  pages with 0 impressions 30+ days, indexation issues, GBP suspension risk
8. Billing  failed payments, expiring cards, upgrade opportunities (client at 90% of tier capacity)

Display:
- Surfaced in Command Center "Next Best Actions" panel (Zone 3)
- Sorted by priority (P0   P3)
- Each item has action button: executes recommended action OR navigates to relevant page

Schema (tenant_signals):
- id (UUID, primary key)
- client_id (UUID, foreign key to clients)
- priority (enum: P0, P1, P2, P3)
- category (enum: quality, cost, lifecycle, compliance, integration, onboarding, performance, billing)
- title (text)
- message (text)
- recommended_action (text)
- target_url (text, nullable)
- created_at (timestamp)
- dismissed_at (timestamp, nullable)
- dismissed_by (UUID, nullable)

8.2  ADVISORY SIGNALS SYSTEM

Purpose: Per-tenant warning system with severity tagging, dismissal state, and recommended actions.

Storage: tenant_signals table (shared with Recommendations Engine output).

Generation Sources:
- A-01 validation results   onboarding signals
- A-05 quality gate failures   quality signals
- A-09 webhook failures   integration signals
- LLM cost guard middleware   cost signals
- Stripe webhooks   billing signals
- Recommendations engine   derived signals

Severity Levels:
- P0: blocks operations (cross-tenant leak detected, payment hard failure, GBP suspended)
- P1: requires immediate attention (DSAR deadline within 7 days, GBP suspension risk, LLM cost cap reached)
- P2: should be addressed soon (drive time exceeded, low photo count, indexation lagging)
- P3: informational (drip phase advancing tomorrow, refresh cycle due next week)

8.3  TENANT HEALTH SCORING

Composite Score (0-100):
- LLM Cost Adherence (25%): (1 - cost_today / daily_cap) " 100
- Page Quality Average (25%): avg overall_quality_score across all client pages
- Indexation Rate (25%): pct of published pages with indexation_status = 'indexed'
- GBP Completeness (25%): from gbp_profiles.completeness_score (Phase 1.5+  defaults to 100 in Phase 1 since GBP API not active)

Calculation:
- Computed on-demand by `/api/clients/[id]/health` endpoint
- Cached 5 minutes per client (Redis or Supabase Cache)
- Displayed in Command Center Tenant Health Panel + Client Detail Overview

Color thresholds:
- 80-100: green
- 60-79: yellow
- 0-59: red

8.4  REAL-TIME POLLING ARCHITECTURE

Implementation:
- Frontend polls dashboard endpoints every 30 seconds
- React Query with `refetchInterval: 30000`
- Loading state on first load only, silent refetch after
- WebSocket NOT used  polling is sufficient and simpler

Endpoints Polled:
- `/api/dashboard/stats` (Zone 1 stat strip)
- `/api/dashboard/activity-feed` (Zone 2 feed)
- `/api/dashboard/health` (Zone 3 tenant health)
- `/api/dashboard/signals` (Zone 3 advisory signals)
- `/api/dashboard/recommendations` (Zone 3 next best actions)

Each endpoint returns minimal payload to keep polling cheap. Activity feed uses cursor-based pagination  only returns events newer than last fetched cursor.

8.5  MARKETING LANDING PAGE SPECIFICATION

URL: tarritrix.com (root)
Authentication: None  fully public

Sections (top to bottom):

1. Animated Hero
- Background: #0A0F1C with subtle animated grid pattern, orange node pulses
- Logo top-left (light SVG, 200px width)
- Login link top-right (small, muted text)
- Headline (animated typewriter): "Local SEO that Google can't penalize."
- Subheadline: "We build penalty-proof SEO infrastructure for service-area businesses. Closed B2B platform  invitation only."
- CTA button: "Schedule a Demo" (orange #FF6B35, prominent)

2. The Problem (3 cards in horizontal row)
- Card 1: "Agencies that disappear after the contract is signed"
- Card 2: "SEO that Google penalizes 6 months later"
- Card 3: "Pages that never get indexed"
- Each card: dark panel, subtle hover lift, brief 2-sentence description

3. The Five Moats (interactive scroll-snap section)
- Moat 1: 4-Layer Content Differentiation  animated layer stack visualization
- Moat 2: 15-Gate Quality Validation  animated gate sequence
- Moat 3: Velocity Throttling  timeline animation showing 30/60/90-day ramp
- Moat 4: GBP Suspension Prevention  shield + gauge animation
- Moat 5: Storm Intelligence Engine  radar map sweep

4. How It's Different (comparison table)
- Three columns: Tarritrix vs Traditional Agency vs DIY
- Tarritrix column highlighted with orange accent border
- Rows: penalty protection, real-time job pipeline, AI visibility tracking, cost transparency, dedicated GCP, indexation monitoring

5. Storm Intelligence Engine Deep-Dive Section
- Headline + body copy explaining storm intelligence
- Interactive US map (storm overlay reveals affected ZIPs in real-time visualization)
- "Phase 3 Premium Add-On" badge

6. Pricing (4 tier cards)
- Starter: $997 setup + $497/mo (5 cities, 1 service, 0 rewrites)
- Growth: $2,497 setup + $997/mo  visually highlighted "Most Popular" with orange ribbon (15 cities, 3 services, 2 rewrites/month)
- Authority: $4,997 setup + $1,997/mo (30 cities, 5 services, 10 rewrites/month)
- Dominance: $9,997 setup + $3,497/mo (60 cities, 8 services, 30 rewrites/month + $50 overage)
- Each card: feature list including rewrite count, "Schedule a Demo" CTA button

7. Demo Request Form
- Inline scheduling widget powered by Google Calendar API
- Fields: name, business name, phone, email, industry dropdown (HVAC/Plumbing/Roofing/Electrical/Other), current marketing spend dropdown, preferred meeting time picker
- On submit:
  - Google Calendar event created in operator's calendar
  - Confirmation email sent via Resend
  - Lead stored in demo_requests table
  - Operator notified via Slack/email

8. Footer
- Logo (light SVG, 160px width)
- Tagline
- Links: privacy, terms, contact
- Login link
- Copyright notice

Technical Requirements:
- Lighthouse score >90 all metrics (performance, accessibility, best practices, SEO)
- Loads <2 seconds on 3G
- Mobile-first responsive design
- All animations respect prefers-reduced-motion
- WCAG 2.1 AA compliant
- No tracking pixels, no third-party fonts beyond Inter and JetBrains Mono

8.6  OPERATOR COMMAND CENTER SPECIFICATION

URL: tarritrix.com/dashboard
Authentication: operator role required (Supabase Auth)

Layout  4 Zones:

Zone 1: Top Stat Strip (full width, 6 cards in horizontal row)
1. Active Clients  count + tier breakdown sparkline (Starter/Growth/Authority/Dominance)
2. Pages Published Today  vs daily allowance (sum of all client drip rates), color-coded (green if on track, yellow if behind, red if blocked)
3. LLM Cost Today  across all clients vs aggregate cap, traffic light color
4. Monthly Recurring Revenue  pulled from Stripe API + delta vs last month
5. Pending Operator Actions  count of flagged pages + DSAR deadlines + GBP alerts
6. Active Alerts  P0/P1 count, expandable to show list

Zone 2: Left Column 60%  Real-time Activity Feed
- Polls agent_events every 30 seconds (cursor-based)
- Filter chips at top: by agent (A-01...A-19), by client, by event type, by severity
- Color-coded entries by severity (red/yellow/green/blue)
- Infinite scroll with virtualization
- Each entry: timestamp, agent name, client name, event type, brief message, expandable for full details

Zone 3: Right Column 40%  3 Stacked Panels

Panel 1: Next Best Actions (powered by Recommendations Engine)
- Top 5 actions sorted by priority
- Each action: title, brief description, action button (executes or navigates)
- Dismissible per action

Panel 2: Tenant Health
- Top 5 clients sorted by composite health score (lowest first)
- Each row: client name, score (with color), trend arrow vs last week
- Click row   client detail page

Panel 3: Advisory Signals
- All active signals across all tenants, sorted by severity
- Filter: all / unread / dismissed
- Each signal: severity badge, client name, message, dismiss button

Zone 4: Bottom Row  2 Charts (side by side)
Chart 1: Publishing Velocity (last 30 days)
- Stacked bar chart, all clients stacked
- X-axis: date
- Y-axis: pages published
- Colors per client, hover for breakdown

Chart 2: LLM Cost vs Cap (last 30 days)
- Line chart per client + aggregate cap line
- X-axis: date
- Y-axis: USD
- Cap line in red, actual cost lines in client colors

Sidebar Navigation (always visible, left side, dark #0F1729):
- Command Center (current)
- Clients (list view, search, filter by tier/status)
- Pages (list view across all clients, filter by status)
- Agents (status of all 14 active agents, manual trigger buttons)
- Compliance (DSAR queue, consent log, audit packages)
- Billing (Stripe-powered, MRR breakdown, failed payments)
- Storm Intelligence (locked behind Phase 3 flag, shows "Coming Soon")
- Settings (operator profile, API keys, feature flags)
- Logout

8.6.5 ROLE HIERARCHY AND MULTI-USER OPERATIONS

Authentication: any of three operator-side roles required (master_admin, senior_admin, va). All three roles route to /dashboard via the unified login flow specified in MASTER_BUILD_SPEC.md Section 6 (as updated per Document 3 of the 2026-05-23 governance synchronization).

Role-aware rendering applies to every protected action in the dashboard. The canonical permission matrix is documented in ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 3 and encoded as a TypeScript constant in src/lib/auth/permission-matrix.ts. Contract 71 enforces that every protected handler invokes hasPermission(role, action) before executing the action.

Header additions:
- Role badge to the right of the user email and avatar
  - master_admin: red badge labeled "Master Admin"
  - senior_admin: blue badge labeled "Senior Admin"
  - va: gray badge labeled "VA"
- Tooltip on hover shows the action scope summary for the current role

Sidebar additions:
- "Users" link visible to master_admin only (hidden entirely from senior_admin and VA)
- Links Click → /dashboard/users surface for role grant and revocation per ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 9.3

Zone-by-zone rendering rules:

Zone 1 (Top Stat Strip, 6 cards): All three roles see all six cards as read-only displays. No conditional rendering needed.

Zone 2 (Activity Feed): All three roles see the feed. No conditional rendering needed.

Zone 3 (3 Stacked Panels):
- Next Best Actions: VAs see only items where the recommended action is within VA permission scope (e.g., "Upload evidence photos for Client X"). Items requiring master_admin or senior_admin authority are hidden from VAs to avoid creating expectations they cannot fulfill.
- Tenant Health: All roles see the panel.
- Advisory Signals: All roles see signals but VAs can only dismiss P3 (informational) per the permission matrix. P0, P1, P2 dismiss buttons are disabled for VAs with tooltip "Requires senior_admin." P0 dismissal by senior_admin requires justification referencing the resolution commit or migration ID, and flags for master_admin review within 24 hours.

Zone 4 (Charts): All three roles see the charts. No conditional rendering needed.

Action button rendering convention:
- Hide entirely: actions the role concept does not include (e.g., role management UI is invisible to non-master_admin)
- Disable with tooltip: actions the role might expect but lacks permission for (e.g., VA sees a disabled "Approve" button with tooltip "Requires senior_admin")

The hide-vs-disable rationale is documented in ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 9.1. The principle is: disable for action affordances the role might expect to use (so the existence of the action is discoverable and the role understands who to escalate to), hide for entire surfaces the role should not need to know exist.

Flagged pages queue (within /dashboard/clients/[id]/flagged):
- Each flagged page row displays the assigned_reviewer if any, with name and role badge
- "Claim" button claims the page for 30-minute review lease (sets pages.assigned_reviewer_id, pages.assigned_reviewer_at, pages.assigned_reviewer_role)
- VAs can claim flagged pages for triage and note-taking but cannot perform approve or reject actions (still gated by permission matrix at the action level)
- Master_admin can force-reassign an existing claim via dropdown

Audit log access:
- master_admin and senior_admin see /dashboard/audit (new surface, Phase 1) with full user_actions log filterable by acting_user, role, client, action_type, date range
- VAs do not see this surface in the sidebar
- VAs can see their own actions via /dashboard/profile (their own session log)

Knowledge Base tab (new sub-tab on /dashboard/clients/[id]):
- Shows current A-44 ingestion version, last scrape timestamp, asset count
- Displays diff history for prior scrapes
- "Force Re-scrape" button visible to master_admin and senior_admin only (VAs cannot trigger)
- "Approve Diff" / "Reject Diff" buttons surface when client_ingestion_versions has a pending material or breaking diff awaiting review (master_admin and senior_admin only)
- Manual asset upload panel for master_admin override path (Contract 73 escape hatch for unscrapable sites)

The full role permission matrix governing every dashboard action is documented in ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 3. That matrix is the single source of truth. Any dashboard action that exposes a protected operation must appear in the matrix or it is an unspecified action and the verification script (scripts/verify-permission-matrix-sync.ts) will block the build.

8.7  CLIENT PORTAL SPECIFICATION

URL: tarritrix.com/portal
Authentication: client role required (Supabase Auth, RLS enforced)

Sidebar Navigation:
- Overview (default landing)
- My Pages (read-only list of all their published pages)
- Activity (RLS-filtered agent_events for their client_id only)
- Lead Log (conversions table, phone shown as last 4 digits per ADR-14)
- Billing (Stripe-portal embedded, invoices, payment method)
- Account (business info, integrations, GCP project status)
- Logout

Overview Page Content:
- Welcome header with business name + tier badge (Starter/Growth/Authority/Dominance)
- Stat cards row:
  - Pages live (count of status='published')
  - Calls received this month (from CallRail integration)
  - Forms submitted (from conversions table)
  - LLM spend (transparency  they see exact dollars spent on their content generation)
- Recent activity feed (last 10 events, RLS-filtered)
- Next monthly invoice preview (Stripe upcoming invoice)
- Onboarding progress bar (shown only if status = 'onboarding')

Critical Security: All client portal data is RLS-filtered to their own client_id. No client can ever see another client's data. Tenant isolation Playwright tests verify this on every commit.

8.8  COLOR PALETTE (LOCKED)

This palette is locked. No deviation without explicit operator written approval.

Marketing site:
- Base background: #0A0F1C (deep midnight)
- Section panels: #131B2E (slate-midnight)
- Cards on dark: #1F2937 (graphite)
- Text primary: #E5E7EB (cream-white)
- Text muted: #9CA3AF (slate-mist)
- Accent CTA: #FF6B35 (signal orange)
- Accent data: #06B6D4 (electric cyan)
- Accent success: #10B981 (emerald)

Operator + Client dashboards:
- Main background: #1A2238 (deep slate-blue)
- Sidebar: #0F1729 (darker slate-midnight)
- Cards/panels: #243049 (mid-slate)
- Card border: #334155
- Primary text: #F5F1E8 (warm cream  brightest UI color anywhere)
- Secondary text: #94A3B8
- Sidebar text: #F5F1E8
- Sidebar muted: #64748B
- Accent CTA: #FF6B35
- Success: #10B981
- Warning: #F59E0B
- Danger: #EF4444
- Info: #06B6D4

ABSOLUTE RULE: NO PURE WHITE (#FFFFFF) ANYWHERE IN THE PRODUCT.
Brightest color is #F5F1E8 (warm cream) and only used for primary text on dark backgrounds.

8.9  TYPOGRAPHY (LOCKED)

Font Families:
- Display headings: Inter, weight 700
- Section headings: Inter, weight 600
- Body text: Inter, weight 400-500
- Data/code/IDs: JetBrains Mono, weight 400

Font Sizes:
- Body: 14px
- Primary text: 16px
- Section headings: 24px
- Page titles: 32px
- Hero headlines: 48px

All font weights and sizes locked. No deviation without explicit operator written approval.

8.10  ANTI-FAILURE PROTECTIONS (10 INSTALLATIONS)

Installed before any new feature code is written:
1. Pre-commit hook (Husky) running `pnpm verify`  blocks commits with type errors, lint errors, or test failures
2. Schema drift detector script (scripts/verify-schema.ts)  fails CI if database schema diverges from migration files
3. Environment variable validator  boots app, fails fast on any missing required env var
4. Tenant isolation Playwright suite  mandatory pass before any deploy. Tests that client A cannot see client B's data via UI, API, or direct DB query attempts
5. LLM cost guard middleware  wraps all Anthropic API calls, enforces daily cap per client, logs every call to llm_calls table
6. Hallucination prevention header  mandatory in every Claude Code prompt: "Do not invent paths, API names, schema fields, or capabilities. If unsure, ask before generating."
7. Drift watchdog Playwright suite  smoke tests all 6 surfaces (marketing, command center, client portal, login, signup demo form, error pages) every commit
8. PostHog production logging  already in stack, must be wired to capture every operator action and every client conversion
9. Sentry error tracking  NEW install, captures all unhandled errors with stack traces, deduplicates, alerts operator
10. Real-time deploy verification  post-deploy URL hits all 6 surfaces, checks for 200 status, content presence, and basic smoke assertions

8.11  15 ADDITIONAL TABLES (MIGRATION 002)

These tables were missing from the initial Migration 001 build and are added via Migration 002. Full DDL is in supabase/migrations/20260505200000_tarritrix_phase1_completion.sql. Column-level documentation is in SCHEMA_REGISTRY.md.

38. page_decisions  A-05 validator audit trail with reasoning per gate
39. operator_actions  manual override log per operator (who, what, when, justification)
40. cron_run_log  CRON execution history (CRON-01, CRON-02, recommendations-engine)
41. review_response_drafts  LLM-generated review responses with moderation risk score
42. job_content_linkage  explicit job   GBP post   page refresh chain tracking
43. integration_field_mappings  custom field maps per integration (overrides INTEGRATION_ADAPTERS defaults)
44. client_risk_profiles  drip rate multipliers per client (slow ramp for new domains, fast ramp for aged domains)
45. governance_violations  strike system per client (TCPA violations, content policy violations)
46. security_events  auth failures, cross-tenant access attempts, suspicious patterns
47. llm_calls  granular per-call cost tracking (timestamp, client_id, agent, tokens, cost, model)
48. email_deliverability  bounce/complaint tracking from Resend webhooks
49. session_logs  operator + client activity sessions
50. audit_log  comprehensive entity change log (every UPDATE on critical tables)
51. tenant_signals  Recommendations Engine output + advisory signals (shared table)
52. demo_requests  marketing landing page form submissions

System Total: 52 tables (37 from Migration 001 + 15 from Migration 002).

8.12  STRIPE PRICING CORRECTION (REQUIRED ACTION)

Current Stripe products in the operator's account have incorrect amounts. Action required before going live:

1. List existing Stripe products via Stripe API
2. Delete incorrect products (or archive if any test transactions exist)
3. Recreate at correct amounts:
   - Starter: $997 setup (one-time price) + $497/mo (recurring price)
   - Growth: $2,497 setup (one-time price) + $997/mo (recurring price)
   - Authority: $4,997 setup (one-time price) + $1,997/mo (recurring price)
   - Dominance: $9,997 setup (one-time price) + $3,497/mo (recurring price)
4. Update env vars locally (.env.local) and on Vercel:
   - STRIPE_PRODUCT_ID_STARTER
   - STRIPE_PRODUCT_ID_GROWTH
   - STRIPE_PRODUCT_ID_AUTHORITY
   - STRIPE_PRICE_ID_STARTER_SETUP, STRIPE_PRICE_ID_STARTER_MONTHLY (and equivalents for Growth, Authority)
5. Re-run Stripe webhook endpoint test to verify

8.13  GOOGLE CALENDAR API INTEGRATION (MARKETING DEMO FORM)

Marketing demo form creates events directly in operator's Google Calendar via Google Calendar API. Reid already has Google API set up.

Implementation:
- OAuth scopes: calendar.events
- Operator OAuth refresh token stored encrypted in platform_config table
- Endpoint: POST /api/marketing/demo-request
- Flow: form submit   validate   create calendar event   store demo_requests row   send Resend confirmation to lead   notify operator via Slack/email

Required ENV (additions to env spec in Part 6):
- GOOGLE_CALENDAR_OPERATOR_REFRESH_TOKEN (encrypted in DB, not env file)
- GOOGLE_CALENDAR_OPERATOR_EMAIL=tarritrix@gmail.com

Calendly is NOT used.

8.14  GBP API APPLICATION STATUS

Current Status: NOT YET SUBMITTED.

Action: Application copy is provided as separate deliverable: GBP_API_APPLICATION.md.

Process:
1. Operator submits at https://developers.google.com/my-business/content/prereqs
2. Approval timeline: 4-8 weeks (this is the published Google timeline)
3. Until approved: A-12 GBP Agent stays disabled (platform_config.enabled = false for gbp_management feature flag)
4. Phase 1.5 begins immediately upon approval  no waiting for Phase 1 completion

Why apply now: 4-8 week approval is the longest external dependency in the build. Submit before any code work to overlap waiting time with development.

8.15  CHANGE LOG

v2.0  2026-05-05 (Consolidated)
- Preserved entire original blueprint (Sections 0-7 above) verbatim
- Appended 2026-05-05 governance reset additions as Part 8 (this section)
- Restored A-14, A-18, A-19 to Phase 1 per original (an earlier rewrite had demoted these to Phase 2  that was wrong)
- Added Recommendations Engine, Real-Time Polling, Advisory Signals, Tenant Health Scoring specifications
- Added Marketing Landing Page, Operator Command Center, Client Portal surface specifications
- Added 10 anti-failure protections required before any new feature code
- 15 new tables documented in Migration 002 (52 tables total in system)
- 9 new behavioral contracts (22-30) added to BEHAVIORAL_CONTRACTS.md
- Color palette locked: mid-dark backgrounds, no pure white anywhere, warm cream as brightest text color
- Stripe pricing flagged for correction: $497/$997/$1997 monthly (current products have wrong amounts)
- Google Calendar API confirmed for demo form (not Calendly)

v1.0  Earlier (Superseded)
The earlier governance rewrite that compressed the original blueprint and dropped scope (A-14, A-18, A-19 demoted; marketing site removed; command center reduced; recommendations engine missing). That version is fully superseded by v2.0.

________________________________________

### Personalized Demo Engine (Sales Conversion Lever  Tracked Feature)

Four-tier capability that delivers prospect-personalized demos. Strategically critical: converts the standard "imagine your data here" SaaS demo into a real demonstration of Storm Intelligence Engine producing value in the prospect's actual market  before they sign up. Expected impact: 15-30 percentage point improvement in demo-to-close conversion rate.

**Tier 1  Static Prospect-Aware Demo (Phase 1, Prompts 7-10)**
Operator Command Center includes a "Demos" view listing scheduled upcoming demos. Clicking a demo opens a "Demo Prep" surface where the Storm Intelligence Engine dashboard preview is rendered with prospect's metro cities (pulled from demo_requests.zip + demo_requests.primary_city) instead of Austin defaults. Reuses SignalGeography component built in marketing hero. No live signals  demo data is static but prospect-personalized. Demo request form fields ZIP and primary_city are REQUIRED.

**Tier 2  Live Signal Preview (Phase 1.5, gated on A-18 operational)**
Same as Tier 1, plus Demo Prep surface shows real recent weather/storm signals captured for prospect's region. Captures public weather data (Iowa Mesonet + NOAA recommended). Shows actual signals from last 30 days in prospect's geography. Disclosure label: "Sample data captured by Storm Intelligence Engine for your region  last 30 days". Dependencies: A-18 (Job Evidence Ingestion Engine) operational with weather data feed configured.

**Tier 3  Live Hail Swath Visualization (Phase 2)**
Real geographic map of operator's territory with hail swath polygons rendered from NOAA/Iowa Mesonet data. Shows affected property counts within polygons, page generation status, GBP post status, indexation results. AI visibility ranking for prospect's existing domain. Competitor GBP analysis for prospect's metro area. Dependencies: A-18 operational, A-19 (Universal Integration Hub) operational, interactive map library decision (Mapbox vs react-simple-maps), weather API contracts.

**Tier 4  Social Lead Intelligence with Identity Reconciliation (Phase 2+, post-monetization, post-investor-meeting)**
Captures social mentions across platforms (Facebook, Nextdoor, Reddit, Twitter, local platforms), geographically resolves them, cross-references against people-search APIs (BeenVerified/Spokeo/Pipl class), presents identified leads with platform attribution and full context. The "Reveal Identity" button on the marketing site Storm Intelligence Engine dashboard is a non-functional visual placeholder for this Tier 4 capability. Dependencies: legal review (GLBA, FCRA, state privacy laws, TCPA compliance), data licensing agreements, social mention capture infrastructure (likely Brandwatch/Talkwalker class costing $1k-10k/month), identity reconciliation API contracts. NOT to be built until after monetization proof-of-concept and investor meeting because of significant ongoing subscription costs.

**Implementation notes:**
- Demo request form fields ZIP and primary_city are REQUIRED for Tier 1 to function
- Schema additions to demo_requests table needed when Tier 2 lands: prepared_dashboard_url, signals_captured_at_request_time, hail_events_in_region (placeholders documented in SCHEMA_REGISTRY.md)
- SignalGeography component MUST remain reusable from Prompt 4-T2 onward  it's the same component for marketing hero AND demo prep tool
- This is a tracked, named feature with explicit dependencies and entry conditions, not a "nice to have"

________________________________________

## FUTURE PHASES  LOCAL SEO COVERAGE GAP CLOSURE

**Source:** 240-strategy local-SEO reference audit, 2026-05-07
**Status:** Documented for awareness, NOT in current build scope. Phase 1 launches without these.

### Architectural Principle
Phase 1 covers approximately 40 of 240 audited local-SEO strategies  the foundational on-page, technical, and storm-intelligence layers. The following 5 agents close the material off-page authority, hyperlocal depth, GBP optimization, reputation intelligence, and competitive intelligence gaps. They are not required to launch but are required for the platform to compete in mature local-SEO markets at scale.

### A-20: Authority Builder
**Phase:** 2
**Purpose:** Off-page authority signals  citations, NAP consistency, backlink acquisition intel, link velocity management.
**Strategies covered:** High-authority backlink acquisition, link intersection analysis, citation consistency management (NAP), brand mention reclamation, link velocity management, local citation stacking, industry-specific citation dominance, chamber of commerce integration, local sponsorship SEO, local press syndication, geo-relevant backlink acquisition, local link neighborhood analysis.
**Schema additions required:** citations, backlink_targets, link_velocity_log, nap_consistency_audit
**External cost driver:** Ahrefs API ($500-2000/mo) or Moz API ($200-1000/mo) for backlink intelligence
**Priority:** HIGH  without backlink/citation strategy, programmatic on-page SEO ranks slower than competitors with mature off-page profiles

### A-21: Hyperlocal Geographic Engine
**Phase:** 1.5 (PROMOTED FROM PHASE 2  see Architectural Note below)
**Purpose:** ZIP-code, neighborhood, drive-time, and route-corridor page generation. Bridges granularity gap between Storm Intelligence Engine (ZIP-level signals) and current page architecture (city-level).
**Strategies covered:** Neighborhood page ecosystems, drive-time relevance modeling, local entity co-occurrence (landmarks, highways), hyperlocal FAQ generation, route-page architecture, service-area polygon sculpting, neighborhood authority pages, local resource hubs, ZIP-code targeting systems.
**Schema additions required:** neighborhoods, zip_codes, landmarks, drive_time_polygons, route_corridors, parcels, county_data_sources
**External cost driver:** Google Maps API for polygon and drive-time data; Census API already integrated for cities table; County appraisal district open data (free) for parcel-level property data in verified Texas counties.
**Architectural Note:** Storm Intelligence Engine outputs ZIP-level alerts but current page generator only knows about cities. Without A-21, the value of every storm signal drops 60% because resulting pages target city granularity instead of ZIP/neighborhood. This is structural alignment with already-planned functionality, not a new feature category.
**Priority:** CRITICAL  promote to Phase 1.5 alongside A-12 GBP Agent.

#### County Property Data Sourcing (verified 2026-05-21)

A-21 ingests parcel-level property data from county appraisal district open data sources. Phase 1.5 sourcing scope is limited to Texas service corridor counties with verified free programmatic or bulk file access. Sourcing model:

**Tier 1 - Free programmatic API (real-time/weekly refresh):**
  - Williamson (Socrata: data.wcad.org)
  - Bexar (ArcGIS: gis-bexar.opendata.arcgis.com)
  - Hays (ArcGIS: hays-county-haysgis.hub.arcgis.com)

**Tier 2 - Free annual bulk file ingestion (yearly refresh):**
  - Travis (electronic appraisal roll: traviscad.org/publicinformation)
  - Bell (data downloads with shapefiles: bellcad.org/data/)

**Tier 3 - No public data path (hyperlocal pages NOT generated for these counties):**
  - All other counties default to Tier 3 until verified.
  - Hyperlocal page generation disabled for Tier 3 counties.
  - Operator may manually designate target neighborhoods for Tier 3 county clients during onboarding for custom premium support.

**Architecture eliminates dependency on paid third-party property data services** (ATTOM, Estated, PropertyRadar) for hyperlocal targeting within Tarritrix Texas service corridor. ATTOM remains scoped for Phase 2+ for use cases where county data is unavailable.

**Verification artifacts:** scripts/verify-county-data-sources.ps1 contains the discovery probe and results.

### A-22: GBP Optimization Engine
**Phase:** 1.5 (alongside A-12)
**Purpose:** Active GBP optimization beyond profile connection (A-12) and post generation (A-15 Phase 2). Covers category strategy, service saturation, media inventory, behavioral signal amplification, suspension monitoring.
**Strategies covered:** GBP category engineering, GBP services saturation, GBP product utilization, GBP media saturation, GBP behavioral signal amplification, GBP suspension mitigation.
**Schema additions required:** Extend gbp_profiles with category_strategy, service_saturation_score, media_inventory_count, suspension_risk_score
**Priority:** HIGH  Moat 4 (GBP Suspension Prevention) is currently marketed but no agent implements it as continuous monitoring. A-22 closes that gap.

**Additional capabilities (2026-05-17 augmentation):**

- **Geo-grid ranking analysis** — Per client, monitor visibility distribution across grid cells in service area. Heat-map of where the client ranks vs where they don't. Identifies geographic optimization opportunities.

### A-23: Reputation Intelligence
**Phase:** 2
**Purpose:** Multi-platform review aggregation, review keyword engineering, sentiment analysis, response automation, and reputation defense beyond what A-14 (Review Velocity Engine) covers.
**Strategies covered:** Review keyword engineering, review diversity balancing (Google + Facebook + Yelp + BBB + Angi + niche), review response optimization, geo-reputation defense systems.
**Schema additions required:** reviews_aggregated, review_keywords, review_response_templates, reputation_alerts
**External cost driver:** GBP API + Yelp API + Facebook Graph API + BBB scraping + LLM cost for sentiment + response generation
**Priority:** MEDIUM  A-14 sends review requests; A-23 manages the reputation outcome. Important for tier differentiation (Authority tier could include A-23, Starter/Growth could not).

**Additional capabilities (2026-05-17 augmentation):**

- **Sentiment trend monitoring** — Detect directional changes in customer perception over time (not just per-review analysis). Rolling 90-day sentiment trend per client surfaces operational issues before review count declines.

### A-24: Competitive Intelligence
**Phase:** 2
**Purpose:** Content gap analysis, GSC keyword opportunity mining, competitor reverse engineering, content decay detection, geographic competitive gap analysis.
**Strategies covered:** Content gap analysis, search console mining, competitor reverse engineering, content decay monitoring (proactive vs reactive), competitor geo-gap analysis.
**Schema additions required:** competitor_profiles, content_gaps, keyword_opportunities, decay_alerts
**External cost driver:** Google Search Console API (free, requires per-client OAuth), competitor scraping infrastructure, Ahrefs API (shared with A-20 cost)
**Priority:** MEDIUM-HIGH  A-11 currently refreshes content reactively. A-24 enables proactive refresh based on competitor movement and decay signals, materially improving rank stability.

**Additional capabilities (2026-05-17 augmentation):**

- **Link-growth surveillance** — Monitor competitor backlink acceleration rate. Sudden competitor link spikes signal active campaigns Tarritrix client may need to respond to. Read-only intelligence — does not trigger any Contract-60-prohibited activity.

### A-25: AEO Content Structuring Engine

**CANONICAL SOURCE:** AGENTS.md (Phase 1.5 AEO suite)

**Phase:** 1.5 (REPLACES prior Phase 3 LOW priority placement per Contract 50 architectural decision 2026-05-17)

**Summary:** Restructures A-02 page output for LLM citability — atomic factual statements, Q&A formatting, entity-explicit references, voice-search direct-answer paragraphs. Full specification in AGENTS.md.

**Pricing tier note (line 3732 update required):** AI Surface Optimizer / AEO (A-25, P1.5) — Now available all tiers as foundational LLM-citability requirement, not Premium-only deferred. Update pricing table accordingly in same commit if pricing table line 3732 still says "P3 Premium tier only."
**Schema additions required:** ai_optimization_scores, embedding_targets, conversational_query_patterns
**Priority:** LOW for v1  A-13 monitoring alone is sufficient market positioning. A-25 becomes valuable only after AI-driven referral traffic exceeds 15% of total traffic, which is an industry threshold not currently met.

### A-30: Claim Recovery Workflow Engine
**Phase:** 2
**Tier-gated as platform feature, NOT standalone service marketplace**

**Purpose:** Streamline Xactimate insurance claim rewrite submissions for storm-affected contractors. Workflow embedded in operator and client portals, not exposed as separate transaction service.

**Strategic rationale:** Insurance claim recoveries average $5,000-$15,000 per rewrite for storm-affected roofing claims. Carriers' adjuster estimates are systematically under-scoped. Bundling rewrite service into subscription tiers preserves SaaS revenue classification (vs services revenue), creates strong tier upsell incentive, and operationalizes a known revenue leak in the contractor industry.

**Workflow architecture:**
1. Contractor submits claim package via client portal: Xactimate ESX file, carrier estimate PDF, jobsite photos (pulls from A-18 evidence library when available), policy declarations
2. A-30 routes submission to vendor pool based on tier SLA and vendor capacity
3. Vetted insurance rewrite specialist (third-party vendor with E&O coverage and state public adjuster licensing where required) returns rewrite within tier-defined SLA
4. Contractor downloads completed rewrite from portal, submits to carrier directly (Tarritrix never represents claim to carrier)
5. Outcome tracking: contractor confirms recovered amount, A-30 logs vendor performance metrics

**Schema additions required:**

rewrite_requests
- id, client_id, submission_timestamp, claim_type, carrier_name, original_estimate_amount, status (queued/assigned/in_progress/delivered/closed), vendor_id, sla_deadline, delivered_timestamp, recovered_amount, contractor_satisfaction_rating

rewrite_vendors
- id, vendor_name, e_and_o_policy_number, e_and_o_expiration, state_licenses (jsonb), capacity_per_day, sla_performance_avg_hours, quality_score, contract_terms, payment_terms, status (active/paused/terminated)

rewrite_status_log
- id, rewrite_request_id, status_change, timestamp, notes, internal_only_bool

claim_evidence_packages
- id, rewrite_request_id, evidence_item_id (FK to A-18 evidence_items where applicable), uploaded_file_path, file_type, ocr_extracted_text, uploaded_by

rewrite_tier_consumption
- id, client_id, billing_period_start, billing_period_end, rewrites_consumed, rewrites_included_in_tier, overage_count, overage_billed_amount

**External dependencies:**
- Minimum 2 vendor partnerships (capacity redundancy, no single point of failure)
- E&O insurance: vendor-side coverage required, Tarritrix umbrella policy recommended
- State public adjuster licensing review by insurance attorney before national launch (some states regulate claim assistance even when contractor submits directly)
- Volume pricing negotiated with vendor pool: target $50/rewrite at 100+ monthly volume commitment, $75/rewrite at 50/month, retail equivalent $150-200

**Tier-gated inclusion (per BLUEPRINT pricing model):**
- Starter: not included, no portal access to rewrite workflow
- Growth: 2/month included, 72-hour SLA, overage $100/each
- Authority: 10/month included, 72-hour SLA, overage $75/each
- Dominance: 30/month included, 24-hour priority SLA, overage $50/each

**Tier consumption metering:**
- Real-time count displayed in client portal and operator dashboard
- Soft warning at 80% of monthly cap
- Hard cap with overage upsell at 100% of monthly cap
- Reset to zero on subscription billing period anniversary

**Operator pre-launch checklist (Phase 2 readiness):**
- Vendor vetting: minimum 5 sample rewrites per vendor across hail/wind/flood/fire/vandalism claim types
- Vendor E&O verification and Tarritrix umbrella policy procurement
- State-by-state public adjuster licensing memo from insurance attorney (estimated $500-1,500)
- Master Services Agreement with each vendor: SLA cure periods, quality remediation policy, NDA, no-poach clauses, exclusive volume commitment if pricing demands it
- Stripe Connect setup for vendor payout automation
- 1099-NEC tax reporting workflow for vendor payments

**Build effort estimate:**
Substantial. Schema is moderate complexity but external integrations (vendor portal, Stripe Connect for payouts, state licensing checks, file routing infrastructure) make this comparable to A-19 Universal Integration Hub in scope. Cannot be built in less than the full Phase 2 window.

**Priority:** HIGH for Phase 2. Direct revenue lift via tier upgrades + retention via demonstrated ROI per claim recovered. Validates platform's "tied to contractor revenue" positioning.

**Additional capabilities (2026-05-17 augmentation):**

- **Workflow-stage contextualization** — Tailor page content by claim progression stage (filed / under review / approved / paid / denied). Different content emphasis per stage helps homeowners navigating the process.
- **Adjuster communication frameworks** — Provide structured guidance content for homeowners interacting with insurance adjusters. Expands topical authority depth in claims domain.

### Documented Non-Goals (Explicit Phase 1 Exclusions)
The following audited strategies are intentionally NOT in scope for any current phase. Operator may revisit during Phase 3+ planning:
- Multilingual SEO (44, 223)  single-language US contractor market
- Video SEO (43)  video production not in service tier
- Podcast guesting (176)  not programmable
- Parasite SEO (23)  anti-pattern for compliance-focused brand
- Influencer collaboration (175)  not programmable
- Multi-format content repurposing (86)  out of scope for v1

### Total Future Phase Agent Count
- Phase 1 (locked): 14 agents
- Phase 1.5 additions: A-12 (already planned), A-21 (PROMOTED from Phase 2), A-22 (NEW)
- Phase 2 additions: A-13/A-15/A-16/A-17 (already planned), A-20, A-23, A-24 (NEW)
- Phase 3 additions: A-25 (optional, not committed)

Net gap closure: 5 new agents to address ~35 critical missing local-SEO strategies across off-page authority, hyperlocal depth, GBP optimization, reputation, and competitive intelligence.

### Demo & Marketing Implications
Until these agents ship, prospect demos must include accurate framing:
- Backlinks: "Phase 2 roadmap. Launch focus is on-page authority + storm response."
- Yelp/Facebook reviews: "Phase 2. Launch focus is Google reviews via A-14."
- ZIP/neighborhood pages: "Phase 1.5 alongside GBP agent."
- Competitor analysis: "Phase 2."

Sales must not promise what is not built.

________________________________________

END OF BLUEPRINT v2.0 CONSOLIDATED


________________________________________

# ============================================================================
# PART 9 - 2026-05-09 FOUR-TIER EXPANSION
# ============================================================================

This section documents the Four-Tier Expansion governance update applied 2026-05-09.
It supersedes earlier 3-tier and partial 4-tier specifications in Parts 2 and 8 where they conflict.

## 9.1 - TRADE SCOPE EXPANSION

Tarritrix Phase 1 onward targets four storm-driven trade verticals exclusively:

- Roofing (asphalt shingle, metal, tile, flat/commercial)
- Paintless Dent Repair (PDR - automotive hail damage)
- Solar (residential + light commercial installation, repair, panel replacement post-storm)
- Storm Restoration (multi-trade contractors handling roofing + siding + gutters + windows post-event)

Removed from scope: HVAC, plumbing, electrical, and other non-storm-driven service verticals.

## 9.2 - FINAL CONSOLIDATED TIER TABLE

| Feature | Starter | Growth | Authority | Dominance |
|---|---|---|---|---|
| Monthly Subscription | $497 | $997 | $1,997 | $3,497 |
| market activation fee (one-time) | $997 | $2,497 | $4,997 | $9,997 |
| Quarterly Prepay (5% off) | $1,416 | $2,841 | $5,691 | $9,966 |
| Annual Prepay (15% off) | $5,069 | $10,169 | $20,369 | $35,669 |
| 2-Year Prepay (20% off) | $9,542/yr | $19,141/yr | $38,342/yr | $67,142/yr |
| Cities | 5 | 15 | 30 | 60 |
| Services | 1 | 3 | 5 | 8 |
| City x Service Matrix | 5 | 45 | 150 | 480 |
| Base Pages (90-day cycle) | 30 | 100 | 210 | 400 |
| Field Expansion Bonus Pages (90-day max) | 0 | 0 | 30 | 100 |
| Effective Total Pages | 30 | 100 | 240 | 500 |
| Drip Cap (Phase 1) | 1/day | 4/day | 8/day | 15/day |
| Drip Cap (Phase 2) | 2/day | 6/day | 12/day | 25/day |
| Drip Cap (Phase 3) | 3/day | 9/day | 18/day | 40/day |
| Xactimate Rewrites Included | 0 | 2/month | 4/month | 8/month |
| Rewrite Overage Rate (universal) | $125 | $125 | $125 | $125 |
| Rewrite Turnaround SLA | N/A | 72-hour | 72-hour | 48-hour |
| Polygon Lead Tool Access | - | View only | Draw + download | Draw + download + scheduled storm overlay |
| Storm Intelligence Engine | View only | View + 1 region | View + 3 regions | View + unlimited regions |
| 15-Gate Page Validation (A-05) | Yes | Yes | Yes | Yes |
| Schema Generator (A-03) | Yes | Yes | Yes | Yes |
| Conversion Handler (A-09) | Yes | Yes | Yes | Yes |
| Review Velocity Engine (A-14) | Yes | Yes | Yes | Yes |
| Indexation Tracking (A-08) | Yes | Yes | Yes | Yes |
| Job Evidence Pipeline (A-18) | Limited | Yes | Yes + field expansion | Yes + field expansion |
| GBP Optimization (A-22, P1.5) | - | Yes | Yes | Yes |
| Hyperlocal Geographic (A-21, P1.5) | - | - | Yes | Yes |
| Voice Search Optimization (A-27, P1.5) | - | Basic | Standard | Advanced |
| AI Visibility Monitor (A-13, P2) | - | - | Yes | Yes |
| Authority Builder / Backlinks (A-20, P2) | - | - | Yes | Yes |
| Reputation Intelligence (A-23, P2) | - | - | Yes | Yes |
| Competitive Intelligence (A-24, P2) | - | - | - | Yes |
| AI Surface Optimizer / AEO (A-25, P1.5) | Basic | Standard | Advanced | Premium |
| Schema/Structured Data Orchestration (A-26, P1.5) | Basic | Standard | Advanced | Premium |
| Operator Support | Email | Email | Email + Slack | Dedicated specialist + emergency escalation |
| Support SLA Response | 48-hour | 24-hour | 12-hour | 4-hour business / 24-hour after hours |
| Strategy Call Cadence | - | - | Quarterly | Monthly |
| Onboarding | Self-serve | Group session | Dedicated 1:1 | Dedicated + multi-location playbook |
| Beta Feature Access | - | - | Yes | Yes (first-priority) |
| Custom Domain Support | - | - | - | Yes (Phase 3) |
| White-Label Reports | - | - | - | Yes (Phase 3) |
| API Access | - | - | - | Yes (Phase 3) |

## 9.2A - OPERATOR OVERRIDE: PAGE COUNT BYPASS

Tarritrix recognizes that two categories of clients require unlimited page counts that bypass standard tier caps:

1. **Internal canary tenants** (Tarritrix Roofing, E4 Construction & Roofing) used for ground-truth validation
2. **Enterprise-arrangement clients** with national footprints exceeding Dominance tier (handled via private agreement, not public-facing tier)

The `clients.page_count_override` field provides operator-only control. Setting this field bypasses CRON-01 drip caps for that specific client. Not publicly marketed. Not a "tier." A private operator capability.

**Example use cases:**
- E4 Construction & Roofing: Multi-metro operator requiring coverage across 78+ cities, exceeding Dominance baseline of 60
- Tarritrix Roofing: Self-hosted page network requiring 450-500 metro footprint for platform validation and competitive research
- Custom enterprise agreements: National operators with unique pricing arrangements negotiated outside standard tier structure

**Relation to existing custom_city_count override:** The `custom_city_count` field overrides the number of cities allowed per tier (5/15/30/60). The `page_count_override` field is semantically different — it overrides the TOTAL page count across all city × service combinations. Both fields serve operator override purposes but at different levels of the cap calculation.

## 9.3 - DOMINANCE TIER BUILD STATUS

Build deferred to Phase 3. Dominance tier is documented in governance and visible
on the public pricing page as "Available Phase 3 - Join Waitlist" with no active checkout.
Stripe products and prepay prices for Starter/Growth/Authority are created at launch;
Dominance Stripe products are NOT created until Phase 3 build commences.

## 9.4 - VENDOR DEPENDENCY: CONTRACTOR SUPPLEMENT SOLUTIONS

Xactimate insurance estimate rewrites delivered to Growth/Authority/Dominance clients
are fulfilled by Contractor Supplement Solutions under a white-label vendor partnership.

**Vendor profile:**
- Vendor name: Contractor Supplement Solutions
- Service: Xactimate insurance claim rewrite (residential property loss estimates)
- SLA commitment: 72-hour turnaround for Growth/Authority, 48-hour priority for Dominance
- Tarritrix retail markup: $125 per overage rewrite beyond included tier allowance

**Risk profile:**
No fallback vendor identified as of 2026-05-09. Contractor Supplement Solutions is
a single point of failure for tier delivery. Identify and onboard at least one fallback
vendor before Phase 2 commencement. See BEHAVIORAL_CONTRACTS.md Contract 35.

## 9.5 - MIGRATION 003 SCHEMA ADDITIONS

Migration file: supabase/migrations/20260509000001_tier_entitlements_phase_b_section_11.sql
Status: PENDING - written but not yet applied. Apply when Phase 1 entitlements
enforcement code (Prompt 7c+) consumes the new tables.

Tables added: tenant_entitlements, xactimate_rewrite_requests
Tables modified: pricing_tiers (Dominance row inserted, Starter/Growth/Authority updated)

## 9.6 - PREPAY CADENCE STRIPE PRODUCTS

| Tier | Quarterly | Annual | 2-Year |
|---|---|---|---|
| Starter | $1,416 | $5,069 | $9,542/yr |
| Growth | $2,841 | $10,169 | $19,141/yr |
| Authority | $5,691 | $20,369 | $38,342/yr |

Created via apply-governance-patch-2-stripe.ps1. Dominance prepay omitted (Phase 3 deferred).

## 9.7 - CHANGE LOG

v2.1 - 2026-05-09 (Four-Tier Expansion)
- Added Part 9 documenting Final Consolidated Tier Table
- Trade scope narrowed to Roofing/PDR/Solar/Storm Restoration
- Dominance tier added as 4th tier with Phase 3 build deferral
- Xactimate rewrite spec finalized: Starter 0, Growth 5, Authority 8, Dominance 20 ($125 universal overage)
- Contractor Supplement Solutions documented as vendor dependency (no fallback yet)
- Migration 003 SQL written (NOT applied)
- Prepay cadences (quarterly/annual/2-year) for Starter/Growth/Authority
- Lead credit features removed (deferred to future phase)
---

## FUTURE FEATURES - TERRITORY OPPORTUNITY SCORE

**Status:** Scoped, not built. Documented per scope discipline (Contract review 2026-05-12).

**Concept:** Algorithmic scoring of nearby/adjacent markets for territory expansion opportunity.

**Inputs:**
- Storm activity (NOAA + Iowa Mesonet historical density)
- Local search demand (existing platform indexation signals)
- Competitor weakness (GBP gaps, ranking gaps, review velocity gaps - requires Phase 2 Competitive Intelligence agent A-24)
- Service relevance to existing client verticals
- Distance from existing client service areas
- Estimated revenue potential (population x avg storm frequency x service ticket size)

**Output:** Per-market score 0-100, ranked list of expansion candidates with reasoning, surfaced in operator dashboard and client monthly strategy brief.

**Dependencies (do NOT build until all resolved):**
- A-24 Competitive Intelligence agent built and stable (Phase 2)
- Storm history data warehouse populated (minimum 24 months historical)
- Performance Attribution infrastructure live (track which markets convert)
- Customer monthly strategy brief format defined and shipping

**Scope estimate:** 2-3 dedicated phases of work. Not Phase 1.

**Origin:** Surfaced in 2026-05-12 positioning review (ChatGPT assessment). Flagged as 'flagship feature' candidate by external reviewer. Operator (Reid) confirms: defer to Future Features, do not build mid-Phase 1.


---

## FUTURE FEATURES - TERRITORY OPPORTUNITY SCORE

**Status:** Scoped, not built. Documented per scope discipline (Contract review 2026-05-12).

**Concept:** Algorithmic scoring of nearby/adjacent markets for territory expansion opportunity.

**Inputs:**
- Storm activity (NOAA + Iowa Mesonet historical density)
- Local search demand (existing platform indexation signals)
- Competitor weakness (GBP gaps, ranking gaps, review velocity gaps - requires Phase 2 Competitive Intelligence agent A-24)
- Service relevance to existing client verticals
- Distance from existing client service areas
- Estimated revenue potential (population x avg storm frequency x service ticket size)

**Output:** Per-market score 0-100, ranked list of expansion candidates with reasoning, surfaced in operator dashboard and client monthly strategy brief.

**Dependencies (do NOT build until all resolved):**
- A-24 Competitive Intelligence agent built and stable (Phase 2)
- Storm history data warehouse populated (minimum 24 months historical)
- Performance Attribution infrastructure live (track which markets convert)
- Customer monthly strategy brief format defined and shipping

**Scope estimate:** 2-3 dedicated phases of work. Not Phase 1.

**Origin:** Surfaced in 2026-05-12 positioning review (ChatGPT assessment). Flagged as 'flagship feature' candidate by external reviewer. Operator (Reid) confirms: defer to Future Features, do not build mid-Phase 1.

---
---
---

# PHASE 1 ARCHITECTURE -- CANONICAL SPECIFICATIONS (2026-05-14)

**Source:** TARRITRIX_ARCHITECTURE_2026-05-14  
**Status:** These specifications supersede earlier stubs for A-02, A-05, A-20.  
**Migration 005:** Applied 2026-05-14 -- schema in place.

---

## A-02 PREMIUM PAGE GENERATOR + DIFFERENTIATION ENGINE (Canonical)

### Mission
Produce pages that rank, differentiate, authenticate, scale. Six differentiation axes: Brand Identity Signature (per-client locked), Module Selection Variance, Module Library Rotation (8 pools, 60-90 modules Phase 1), Composition Variance, LLM-Generated Variance, Real-Data Singularity (A-05 Gate 1 enforces).

### Generation Pipeline
page_generation_queue -> load context -> select template -> resolve modules -> resolve recipe -> bind real data -> LLM prose -> A-05 validation -> deploy or retry (max 3x).

Target: 30-90s per page. Cost: Flagship $0.40-0.80, Premium $0.15-0.30, Standard $0.03-0.06.

### A-02 Layout Archetype Taxonomy (Phase 1.5 expansion)

Phase 1 composition_recipes table supports arbitrary recipe definitions. Phase 1.5 formalizes a layout archetype taxonomy that drives recipe authoring and provides explicit selection variance.

Ten primary layout archetypes:

1. Map-First: Hero is a full-bleed interactive or static map. Content radiates from geographic context. Best for: post-storm urgency, neighborhood-specific, hail specialist templates.

2. Stats-First: Hero is a data-density visualization (storm counts, claim metrics, response times). Content uses data callouts as section dividers. Best for: multi-decade authority, insurance-claim navigation templates.

3. Narrative-First: Hero is editorial prose with single hero photo. Content reads as longform article. Best for: authority + civic engagement, premium concierge templates.

4. Media-First: Hero is photo gallery or video loop. Content interleaves visual evidence with prose. Best for: hurricane recovery specialist, specialty service templates.

5. Timeline-First: Hero is a temporal visualization (storm history, project timeline, claim process). Content follows chronological structure. Best for: storm-prep, comparison/decision templates.

6. Emergency-First: Hero is high-urgency CTA with minimal visual. Content prioritizes action over information. Best for: emergency response, post-storm urgency templates.

7. Property-First: Hero is property/roof visualization (real client examples). Content focuses on assessment and decision support. Best for: specialty service, comparison/decision templates.

8. Community-First: Hero is local geographic or community imagery. Content emphasizes local connection. Best for: authority + civic engagement, neighborhood-specific templates.

9. Comparison-First: Hero is side-by-side or table comparison. Content drives decision making. Best for: comparison/decision, insurance-claim navigation templates.

10. Editorial-First: Hero is magazine-style typography with single image. Content reads as journalism. Best for: premium concierge, multi-decade authority templates.

Each composition_recipe references one primary layout_archetype. A-02 selects archetype based on page_type_template + brand archetype compatibility + client diversity history. No two adjacent pages on the same client use the same archetype.

### A-02 Axis 4b: Per-Page Visual Variance Layer (Phase 2)

Brand signature (Axis 1) locks per-client design tokens. Composition variance (Axis 4) varies per-page structure. Phase 2 adds an additional micro-variance layer for visual rhythm:

- Spacing density: relaxed / standard / compact (varies per page within client locked density bucket)
- Shadow profile: flat / subtle / pronounced (varies per page)
- Animation cadence: minimal / standard / rich (varies per page)
- Gradient intensity: none / subtle / saturated (varies per page)
- Typography hierarchy weight: light contrast / standard / high contrast (varies per page)

Implementation: each page receives a visual_dna_seed at generation time. Seed deterministically generates above values within ranges allowed by client brand signature. Result: pages within same client feel cohesive (same brand signature) but visually distinct (different micro-rhythms).

A-29 Performance Learning evaluates which visual_dna_seed parameters correlate with conversion outcomes per page-type template and DMA. Findings surface in operator dashboard as weight adjustments.

---

## A-44 CLIENT KNOWLEDGE INGESTION ENGINE — CROSS-REFERENCE

The full canonical specification for A-44 Client Knowledge Ingestion Engine appears in this BLUEPRINT.md at Part 10.5 below. A-44 was previously documented in this file under the wrong slot number "A-21" — that entry has been consolidated into A-44 per operator decision 2026-05-23 (Option 1 conflict resolution).

**A-44 is Phase 1 Mandatory** as a prerequisite for A-02 Page Generator. Contract 73 (Pre-Generation Knowledge Ingestion Requirement) enforces this prerequisite at the agent layer.

For full specification including mission, extracts, refresh model (onboarding-mandatory, quarterly CRON with jitter, manual master/senior trigger), diff detection, failure handling, and backward compatibility for existing seeded clients, see Part 10.5 below and `ROLE_HIERARCHY_ARCHITECTURE_SPEC.md` Section 7.

**The geographic capability augmentations (parcel-density classification, neighborhood topology classification, municipal context enrichment) that were misfiled under "A-21 Client Site Ingestion" in this file have been relocated to A-21 Hyperlocal Geographic Engine in `AGENTS.md`, which is their architecturally correct location.** These capabilities are geographic intelligence about service areas, not client-website ingestion.

---

## A-05 PAGE VALIDATOR -- 15 GATES (Canonical)

### Gates (HARD = un-overridable)
1. Real-Data Binding (HARD) - every claim traces to data_source
2. Anti-Monotony Embedding (HARD) - similarity thresholds 0.78/0.75/0.70
3. Brand Signature Conformance
4. Module Diversity
5. Cross-Client DMA Diversity
6. Word Count Variance
7. Heading Structure + Above-the-Fold Contact Card (G7a, AGENTS.md c346551 lock)
8. Internal Link Quality
9. Image Quality
10. Storm Reference Authenticity (HARD) - traces to noaa_event_id
11. Service Accuracy
12. Geographic Accuracy
13. Compliance (HARD) - TCPA, WCAG 2.1 AA
14. Performance Baseline
15. Custom Gates (operator-configurable)

G7a (Above-the-Fold Contact Card): Static DOM inspection of generated HTML. Page must contain at least one <a href="tel:..."> element OR <form> element within the first contact-affordance zone of the rendered markup. Validation is static parse, not headless browser render (Path B locked 2026-05-19; Path A headless render deferred to Phase 1.5 when V18 layout-similarity gate ships and Playwright infrastructure justifies the cost). Failure = page does not pass validation, status remains 'draft'. Overridable per standard G2-9,11,12,14,15 override matrix.

Sequential execution. 3 retries max, then operator_review_required. Overrides allowed on 2-9,11,12,14,15 only.

Cost ~$0.03/run, latency 2-5s.

---

## STORM INTELLIGENCE ENGINE (Canonical)

Free-tier sources: NOAA Storm Events, SPC, NWS API, Iowa Mesonet. $0/month infrastructure.

CRON-WX-01 (daily 2AM): ingest 24h reports -> storm_events (preliminary)
CRON-WX-02 (monthly): authoritative CSV -> upgrade to authoritative
CRON-WX-04 (30min): match new storms to client_storm_subscriptions -> raise tenant_signal by severity

10-year backfill (2016-2026), 5-10M events. PostGIS required. Sub-100ms queries.

### Storm Intelligence Engine: Severity Composite Score (Phase 1.5)

Add calculated severity_composite_score column to storm_events. Composite ranking factors:

- Maximum hail size (weighted 30%)
- Maximum wind speed (weighted 25%)
- Tornado magnitude EF rating (weighted 25%)
- Affected radius / polygon area (weighted 10%)
- Property damage USD where reported (weighted 5%)
- Population affected estimate (weighted 5%)

Score normalized to 0-100. Stored as numeric column. Computed by ingestion CRONs (WX-01, WX-02) at insert time.

Usage:
- Pool A modules can sort/filter storm events by severity score
- Storm history archive pages (Template 13) display events ranked by severity
- A-29 Performance Learning correlates severity score with conversion outcomes per page
- Operator Command Center displays platform-wide severity heatmaps

NOT for: per-property risk scoring (legal landmine). Severity score applies only to STORM EVENTS, never to specific properties or addresses. Contract 38 (real-data binding) and Contract 39 (storm authenticity) still apply.

### Storm Intelligence Engine: AI Micro-Narratives (Phase 2)

Phase 1 storm events are factual data records. Phase 2 adds optional LLM-generated narrative blocks for significant events.

Trigger: Operator-approved per event. NOT real-time. NOT for every storm. Operator selects major events (P0/P1 severity) and triggers narrative generation.

Generation:
- A-02 LLM call to Sonnet 4.7 with strict prompt: "Generate a 60-100 word factual narrative of this storm event using ONLY the data provided. No fabrication. No interpretation. Customer-protective language. No false precision (e.g., never claim specific addresses were hit)."
- Input data: storm_events row, affected city, affected county, NOAA narrative if present
- Output: brief factual prose suitable for embedding in storm-driven pages

A-05 validation: Gate 1 (real-data binding) verifies every fact in narrative traces to storm_events row. Gate 10 (storm authenticity) verifies event_external_id matches NOAA record.

Storage: storm_event_assets table with asset_type='narrative_text'

Usage: Pool A modules can include narrative micro-blocks. A-02 selection considers narrative availability when selecting modules.

Cost guard: per-event generation cost approximately $0.05-$0.15. Operator triggers manually for events expected to drive significant search volume.

---

## MULTI-PROVIDER LLM ROUTING (Canonical)

Central LLMRouter. Supports Anthropic (default), OpenAI, Google Gemini.

Cost governance (Contract 41): per-client + platform + per-provider caps via advisory lock. Operator Command Center: live status, spend tracking, config controls.

---

## A-20 MULTI-TENANT HOSTING (Canonical - Mode C)

Render at client's domain. Methods: A (path proxy, preferred), B (subdomain CNAME), C (full delegation, Dominance), D (tarritrix subdomain fallback).

Vercel routing, wildcard SSL, 3-layer tenant cache (<10ms P95). Onboarding Step 5.5: DNS wizard with auto-verification.

Edge cache s-maxage=86400, 99%+ requests from edge.

**Additional capabilities (2026-05-17 augmentation):**

- **Tenant fingerprint isolation** — Minimize infrastructure uniformity across tenants visible to crawlers. Per-tenant: distinct Edge regions where possible, distinct cache key prefixes, distinct cookie names. Complements A-38 wire-layer diffusion at the routing layer.
- **Tenant domain reputation tracking** — Monitor each tenant domain against Google Safe Browsing, spam blocklists, and search-quality signals. Surface degradation to operator before it cascades to ranking.

---

## A-29 PERFORMANCE LEARNING ENGINE (Phase 2 Agent, Phase 1 Data Prep DONE)

Compounding moat. Correlates page performance with A-02 structural decisions -> surfaces findings -> operator approves -> feeds weights back.

Phase 1 tables (Migration 005): page_performance_daily, page_structural_variants, conversions attribution columns.

Statistical analysis (chi-squared, t-test, Bonferroni correction). Thresholds: n>=100, p<0.05, d>=0.2. Operator dashboard for approve/defer/reject.

**Additional capabilities (2026-05-17 augmentation):**

- **Layout-performance correlation** — Per A-35 variant tuple (the 11 axes), correlate conversion rate, ranking position, and engagement signals. Output identifies high-performing layout variants for preferential selection on future pages.
- **AI citation probability modeling** — Per A-25 content structure pattern, correlate with A-47 citation events. Output identifies citation-friendly patterns for preferential generation.

---

## PAGE-TYPE TEMPLATE LIBRARY (Phase 1.5 Expansion)

### Page-Type Template 13: Storm History Archive (Phase 1.5)

Trigger: Operator-enabled per-city; default off for Starter, optional for Growth, default on for Authority/Dominance.

Mission: Establish topical authority for informational queries like "hail history Dallas" or "tornado record Oklahoma City." These queries have moderate volume, low competition, and demonstrate locality expertise to Google.

URL pattern: /locations/{city-state}/storm-history and optionally /locations/{city-state}/storm-history/{year}

Structure:
- Hero: Stats summary for city (total storms last 10 years, most severe event, recent significant date)
- Year-by-year breakdown (interactive, expandable)
- Each year shows: hail events, tornado events, wind events with dates, magnitudes, neighborhoods affected
- Storm event detail modules (Pool A) for top 5-10 most severe events per year
- Internal links to relevant service pages
- CTA: free inspection for properties damaged in any historical storm

Required pools: A (Storm Visualization), D (Authority), E (Decision Support), G (Action)

Data sources: storm_events table (10-year NOAA backfill required, already in Phase 1 prerequisites)

Diversity constraint: Storm history page may NOT use the same Pool A modules as any other page on the same client. Forces distinct module pool from city-page Pool A usage.

### Page Subtype: Hyperlocal Climate Corridors (Phase 1.5)

Some neighborhoods experience disproportionate storm activity due to topography, urban heat patterns, or microclimate. These are under-served by traditional city-level pages.

Subtype 1: Hail Corridor pages
- URL: /locations/{metro-area}/hail-corridors/{corridor-name}
- Example: /locations/dfw-tx/hail-corridors/east-dallas-richardson-plano
- Content: NOAA hail event density mapping for the corridor, historical patterns, why this corridor sees more activity than others, services targeted at corridor residents

Subtype 2: Wind Corridor pages
- URL: /locations/{metro-area}/wind-corridors/{corridor-name}
- Example: /locations/okc-ok/wind-corridors/canadian-river-valley
- Content: NOAA wind event density, topographic explanation, building exposure considerations

Subtype 3: Microclimate Risk pages
- URL: /locations/{city-state}/microclimate/{microclimate-name}
- Example: /locations/austin-tx/microclimate/hill-country-edge
- Content: localized weather patterns, seasonal variations, property exposure considerations

Operator defines corridors and microclimates per metro area during client onboarding. NOAA data filtered by polygon overlap with corridor geometry. A-02 generates corridor pages as part of standard generation queue.

Diversity constraint: corridor pages must reference NOAA event data, not generic regional content. Pages without sufficient storm event density in the corridor polygon do not generate (avoids thin content).

---

## NEW CONTRACTS (38-44)

**38:** Real-Data Binding (HARD) - A-05 Gate 1 enforces  
**39:** Storm Reference Authenticity (HARD) - A-05 Gate 10 enforces  
**40:** DMA Diversity Enforcement  
**41:** LLM Cost Governance (supersedes Contract 7)  
**42:** Multi-Tenant Hosting - no onboarding complete without DNS verification  
**43:** Module Library Authority  
**44:** Performance Learning Authority - A-29 needs operator approval

---

**END CANONICAL SPECIFICATIONS (2026-05-14)**


---

## DISTRIBUTED RELEVANCE MAINTENANCE SYSTEM (Phase 1.5)

**Locked:** 2026-05-16 | **Architectural Contract:** 50 (Durable Design)

### Strategic Context

Google's duplicate content detection and algorithm-generated footprint recognition pose existential risk to programmatic SEO platforms. At scale (100+ clients, 10,000+ pages), identical content patterns, schema markup, internal linking structures, and UI components create a detectable "network fingerprint" that can trigger algorithmic penalties or manual review.

Traditional programmatic SEO solutions fail because they rely on:
1. **Template uniformity** — same React components, same Tailwind classes, same DOM structure across all client sites
2. **Batch publishing** — 50-100 pages go live on same day, same hour (obvious algorithmic signal)
3. **Identical schema markup** — every page uses exact same JSON-LD structure with same property order
4. **Predictable internal linking** — every city page links to homepage + 2 service pages in same pattern
5. **Static content** — once generated, pages never change (Google's "thin content" detector)

**The Distributed Relevance Maintenance System defeats these patterns through:**

### 1. Content Seed Variation (A-32)

Instead of one template generating identical paragraphs across 100 city pages, A-32 generates 3-5 linguistic variations of each semantic block. Page generation randomly selects variations, ensuring no two pages share identical block sequences.

**Example:**
- Variation 1: "Our roofing experts serve Austin with 20+ years of experience in residential and commercial projects."
- Variation 2: "Austin homeowners trust our certified roofers for expert residential and commercial roofing solutions backed by two decades of local service."
- Variation 3: "For over 20 years, Austin TX has relied on our professional roofing team for both home and business projects."

All three convey same facts, same tone, but different sentence structure and word choice. Google's duplicate content detector sees unique content; human readers see consistent brand voice.

**Anti-footprint mechanism:** Block-level variation with random selection prevents "Mad Libs" pattern (where only city name changes). Hash comparison ensures no two pages use identical block sequences.

### 2. Schema Markup Scrambling (A-33)

Google's structured data parser sees identical schema markup as algorithmic signal. A-33 injects natural variation:
- Property order randomization (JSON keys shuffled per page)
- Date format variation (ISO-8601 vs MM/DD/YYYY vs Month DD, YYYY)
- Phone format variation (`(555) 123-4567` vs `555-123-4567` vs `555.123.4567`)
- Optional property injection (80% of pages include `priceRange`, 60% include `areaServed`, etc.)

**All variations remain semantically valid** — Google Structured Data Testing Tool validates 100% of pages. Variation is for anti-footprint only, not data accuracy compromise.

### 3. Image Metadata Randomization (A-34)

Duplicate alt text across 100+ pages triggers Google's image duplicate detector. A-34 generates 5 variations per image type, randomly assigns per city page:
- "Expert roofing team in Austin TX" (City A)
- "Professional roofers serving Round Rock" (City B)
- "Georgetown TX roofing specialists" (City C)

EXIF metadata stripped and re-injected with randomized camera model, timestamp jitter (within 30-day window) to avoid identical upload fingerprints.

### 4. Component Variation Engine (A-35)

> ⚠️ VALIDATION GATE: A-35 cannot be considered production-ready until a 100-page test rig has empirically validated that A-35's component variance produces pages Google treats as unique. Required test:
> 1. Generate 100 pages with full A-35 variance enabled, targeting 100 different service-area combinations
> 2. Submit all 100 to Google Search Console via A-08 (Indexation Tracker)
> 3. Monitor indexation rate over 30 days
> 4. Pass criteria: ≥ 80 of 100 pages reach indexed status without "Duplicate without user-selected canonical" or "Crawled — currently not indexed" flags
> 5. If pass criteria not met, A-35 variance settings must be retuned and rerun before any external client uses A-35 in production
>
> This rig runs against Tarritrix Roofing's own page network (zero client risk).

**The most critical anti-footprint layer.** Google's layout fingerprint detection analyzes DOM structure + CSS patterns across sites. Identical React components with identical Tailwind classes create detectable network signal.

A-35 generates 3-4 CSS variations per component (button, card, section, hero) by varying:
- Border-radius (8px vs 12px vs 16px)
- Padding (p-4 vs p-5 vs p-6)
- Shadow depth (shadow-md vs shadow-lg vs shadow-xl)
- Font-weight (font-medium vs font-semibold vs font-bold)
- Letter-spacing (tracking-normal vs tracking-wide vs tracking-tight)

**Per-client assignment:** Client A gets v1 buttons + v3 cards, Client B gets v2 buttons + v1 cards. Visual consistency maintained within one client site (no variant mixing), but **zero identical CSS fingerprints across 10+ client sites.**

**Contract 35 Lock:** Variation preserves design system integrity — subtle CSS tweaks only, not full redesigns. No UX regressions.

### 5. Internal Link Pattern Shuffling (A-36)

A-06 Internal Link Builder establishes baseline: every city page links to homepage + 2-3 service pages + contact page. A-36 injects variation:
- Randomly add 1-2 additional links per page (to blog posts, other cities, FAQ page)
- Vary anchor text ("roofing services" vs "expert roofers" vs "learn more")
- Vary link placement (intro paragraph vs sidebar vs footer CTA)
- Enforce graph hash comparison: no two city pages have identical link sets

**Result:** Natural link diversity without sacrificing A-06 primary linking strategy. Google sees "human-edited" link structure, not algorithmic uniformity.

### 6. Publish Cadence Jitter (A-37)

Batch publishing (50 pages on same day) is most obvious algorithmic signal. A-37 defeats this:
- Baseline: CRON-01 Drip Publisher publishes 3-5 pages/day over 30 days
- Variation: inject randomness (2 pages one day, 6 another, 0 pages for 1-2 days)
- Vary time-of-day (not always 3am UTC — sometimes 7am, 11pm, 2pm)
- Inject "quiet days" (no publishes) to simulate human editorial calendar

**Final cadence:** 80-120 pages in 30 days (3-4/day average), but **no uniform batches.** Publish pattern appears human-edited, not algorithmic.

**Contract 37 Lock:** Jitter respects client launch SLA. If client needs live in 14 days, operator override disables jitter (`clients.disable_publish_jitter = true`).

---

### Architectural Durability (Contract 50)

The Distributed Relevance Maintenance System is **locked as of 2026-05-16.** Agents A-32 through A-37 specifications are canonical and may not be redesigned mid-build.

**Why lock now (before Phase 1 completion)?**
1. **Anti-footprint strategy must be baked into Phase 1 architecture** — retroactive variation is 10x harder than native variation
2. **Database schema impact** — `content_variations`, `client_component_variations`, `publish_schedule` tables must exist before 100-page milestone
3. **Component library impact** — variation engine requires multi-variant component design from start (not bolt-on later)
4. **LLM cost modeling** — A-32 variation generation has cost implications that affect Phase 1 pricing model

**Trade-off:** Locking design before validation means risk of over-engineering. Acceptance criteria: if Google does NOT penalize first 10 clients (1000+ pages), consider this validated. If penalties occur, Phase 1.5 pivot permitted under emergency architectural review (requires Reid written approval).

---

### Success Metrics (Phase 1.5 Launch)

1. **Zero identical content blocks** across 100+ city pages for same client (measured via SHA-256 hash comparison)
2. **Zero identical schema fingerprints** across 100+ pages for same client (measured via JSON stringification + hash)
3. **Zero identical CSS fingerprints** across 10+ client sites (measured via DOM+CSS extraction + hash)
4. **Zero identical internal link sets** across 100+ city pages for same client (measured via graph hash)
5. **Publish cadence variance >40%** (no day-over-day uniformity; measured via standard deviation of daily publish counts)
6. **Google penalty rate <5%** across first 100 client launches (manual review via Search Console)

**If metrics fail:** Emergency architectural review. Potential pivots: reduce variation aggressiveness, inject more human review, delay Phase 2 rollout.

---

**CANONICAL UPDATE (2026-05-16) — DISTRIBUTED RELEVANCE MAINTENANCE SYSTEM LOCKED**

---

# PART 10 - 2026-05-20 DETAILED SPECIFICATION CROSS-REFERENCES

The following sections reference detailed specifications created 2026-05-19 that expand on architectural patterns, agent behaviors, and operational workflows outlined in this blueprint. These detailed specs are living documents maintained separately to keep this top-level blueprint readable.

---

## Three-Tier Site Architecture

Every Tarritrix client site follows a three-tier architecture:

**Tier 1** — Homepage (root domain): Overall business overview, primary CTA, top-level navigation
**Tier 2** — Service Hub Pages (5-10 per client): Comprehensive authority pages for each service category. Examples: `/services/hail-damage-restoration`, `/services/storm-damage-roofing`
**Tier 3** — Location-Specific Pages (hundreds to thousands): Programmatic pages combining service and city. Examples: `/services/hail-damage-restoration/dallas-tx`

Service hub pages are the editorial spine that prevents the site from reading as a programmatic page mill. They receive external backlinks, anchor brand voice, and link down to every relevant location page in a hub-and-spoke pattern.

**See docs/architecture/service-hub-pages-spec.md for full specification** of what service hub pages are, how they differ from location pages, how A-02 generates them with Opus-based composition, how A-05 validates them with the G16 Hub Completeness gate, and how A-06 enforces hub-and-spoke linking via the parent_hub_id foreign key.

---

## Client Intelligence Intake Structure

Every client onboarding requires structured data collection across 18 categories: business identity, service portfolio, geographic coverage, credentials, insurance relationships, manufacturer partnerships, brand assets, digital footprint, case studies, team profiles, and more. Incomplete data degrades platform output.

The intake uses a three-tier evidence unlock model:
- **Tier 1 (Foundational)**: Complete within 7 days — unlocks initial page generation
- **Tier 2 (Authority)**: Complete within 30 days — unlocks expanded campaigns  
- **Tier 3 (Dominance)**: Complete within 90 days — unlocks full platform capabilities

The intake structure feeds every agent in the platform, every directory registration, every page generation, and every reporting workflow.

**See docs/onboarding/client-intelligence-intake.md for full specification** of all 18 sections, required vs optional fields, tier assignments, which agents consume which data, and what happens when sections remain incomplete.

---

## Test Phase Activation Plan

Tarritrix transitions from "shipped infrastructure" to "live production platform" through a controlled test phase using three accounts: Tarritrix itself, E4 Construction & Roofing, and Architectural Flashing Supply.

The test phase validates that isolated components work together in production, generates demo material with verifiable performance data, and matures operator workflows before external client exposure. This is not a soft launch — it is bounded production validation against operator-controlled accounts.

**See docs/test-phase/test-account-activation-plan.md for full specification** of the three test accounts, infrastructure that must be operational before activation, deferred infrastructure, activation sequence and timing, success metrics, exit criteria, and rollback procedures.

---

## Asset Hub Feature Overview

The Asset Hub is the client-facing self-service portal where clients upload documents, fill structured forms, and complete data collection asynchronously. Without it, onboarding becomes a synchronous bottleneck requiring 4-hour operator calls.

The Asset Hub maps 1:1 to the 18 sections of the Client Intelligence Intake. As clients upload evidence, the platform automatically advances them through evidence tiers without operator intervention. This scales client onboarding beyond 3-4 concurrent clients.

Mobile-first requirement: Contractors upload from phones in the field. Every flow must work on 375px viewport.

**See docs/features/asset-hub-spec.md for full specification** of page structure, upload flows, evidence tier unlock automation, mobile design requirements, and integration with the Client Intelligence Intake.

---

# ============================================================================
# PART 10.5 — A-44 CLIENT KNOWLEDGE INGESTION ENGINE (Canonical - Phase 1 Mandatory)
# ============================================================================

This section is the canonical specification for A-44 Client Knowledge Ingestion Engine following the 2026-05-23 phase relocation from Phase 1.5 to Phase 1 and the A-21/A-44 conflict resolution.

## 10.5.1 Phase Designation

**Phase:** 1 (relocated from Phase 1.5 per operator decision 2026-05-23)

**Sequence:** Inserted between A-01 (Intake Processor) and A-10 (Content Profile Builder) in the post-onboarding pipeline. Blocks A-02 Page Generator per Contract 73.

**Status:** ⏳ NOT STARTED (Phase 1 build pending)

## 10.5.2 Mission

Capture the client's existing brand voice, terminology, NAP data, certifications, manufacturer badges, customer testimonials, and visual identity assets from their public website so that Tarritrix-generated pages adopt the client's authentic brand voice rather than generic AI-flavored output. Without A-44, generated pages lack brand consistency and authentic trust signals — Contract 61 (AEO/Voice/Conversion Discipline) and Contract 18 (Evidence Authenticity HARD) compliance becomes impossible.

## 10.5.3 Capture Targets

A-44 extracts the following from the client's public website:

1. Brand voice and terminology (how the client describes their services in their own words)
2. Existing keywords ranking in Google for the client's domain (from Google Search Console if OAuth granted, otherwise inferred from page content)
3. NAP data (Name, Address, Phone) for consistency verification against intake form
4. Service descriptions verbatim
5. Tone of voice analysis (formal / casual / expert / friendly)
6. Existing claims, certifications, and awards
7. Customer testimonials with attribution
8. Case studies and project photos
9. Manufacturer badges (GAF, CertainTeed, Owens Corning, IKO, and similar)
10. Trust marks (BBB accreditation, Angi membership, HomeAdvisor verified, etc.)
11. Professional licensing badges
12. Logos (header logo, footer logo, alternate-mark variants)
13. Insurance certifications
14. Industry association memberships
15. EXIF data from photos worth importing to evidence_items (timestamp, GPS coordinates, camera model)

## 10.5.4 Refresh Model — Three Triggers

A-44 implements three refresh triggers, all of which write a new row to client_ingestion_versions.

### Trigger 1 — Onboarding (Mandatory, Blocking)

- Fires automatically as Step 9 of the onboarding workflow (see Section 4.1)
- Initiated by the platform immediately after Step 7 payment confirmation transitions clients.status to 'active'
- A-02 Page Generator is blocked from executing for this client until A-44 produces a client_ingestion_versions row with status='success' AND approval_status='auto_approved' AND is_current=TRUE
- LLM cost: approximately $0.35–0.55 per client (one-time)
- Duration: 3–7 minutes for typical client sites under 100 pages

### Trigger 2 — Quarterly CRON (Automatic)

- New CRON job: CRON-03 a44-quarterly-refresh
- Schedule: daily evaluation, fires per client when clients.next_ingestion_scheduled_at <= NOW()
- After successful scrape, computes diff against current version using deterministic hash comparison (no LLM cost for diff classification)
- If diff_severity = 'none' or 'minor': auto-approved, becomes current
- If diff_severity = 'material' or 'breaking': queued for operator approval, P1 advisory signal raised, prior version remains current until master_admin or senior_admin approves
- After scrape completion (success or failure), next_ingestion_scheduled_at is reset to NOW() + 90 days + random ±7 day jitter to prevent quarterly-refresh thundering herd

### Trigger 3 — Manual (master_admin or senior_admin)

- Dashboard affordance: "Force Re-scrape" button on /dashboard/clients/[id] Knowledge Base tab
- Requires justification field (e.g., "Client relaunched site," "New certifications announced," "NAP data correction")
- Triggers A-44 immediately, bypassing the quarterly schedule
- After completion, next_ingestion_scheduled_at is reset to NOW() + 90 days + jitter from the manual scrape completion time
- VAs cannot trigger this — gated by permission matrix per ROLE_HIERARCHY_ARCHITECTURE_SPEC.md Section 3.3

### Trigger 4 — Signal-Driven (Deferred to Phase 1.5)

- Future capability: when A-08 Indexation Tracker detects substantial sitemap changes on the client's domain (sitemap last_modified delta >20%, canonical URL shifts), auto-queue an A-44 re-scrape
- This requires sitemap-change detection logic in A-08 that does not currently exist
- Out of scope for Phase 1 A-44 ship — spec'd here for operator awareness
- Build in Phase 1.5

## 10.5.5 Diff Detection Algorithm

A-44 post-scrape diff computation is deterministic (no LLM cost):

1. Hash the new scrape's critical fields:
   - Logo URL hash
   - Brand name string
   - NAP data (name, address, phone normalized to E.164)
   - License numbers (set comparison)
   - Certification list (set comparison)
   - Manufacturer badge list (set comparison)
   - Industry association list (set comparison)
2. Compare to the current version's hashes
3. Classify:
   - All hashes identical → diff_severity = 'none'
   - Only non-critical fields changed (about-page wording, testimonial copy edits) → diff_severity = 'minor'
   - Critical fields changed (logo, NAP, license, certifications, manufacturer badges added/removed) → diff_severity = 'material'
   - Domain itself changed OR all critical fields differ → diff_severity = 'breaking'
4. Write diff_summary JSONB containing field-by-field deltas for operator review UI

## 10.5.6 Storage Model

All A-44 outputs persist in three existing A-44 tables (declared but not yet migrated):

- client_ingested_assets — raw captures with per-asset metadata (source URL, capture date, asset type, classification confidence, asset_version, is_current)
- client_brand_voice_model — per-client voice and terminology model used by A-02 and A-25
- client_keyword_gap_analysis — keywords client should rank for but doesn't

Plus the new versioning table created per Document 4 (SCHEMA_REGISTRY.md delta):

- client_ingestion_versions — per-scrape version metadata with diff_severity, approval_status, is_current

A-02 always reads from the version pointed to by clients.current_ingestion_version_id. Historical pages do not retroactively change when a new version becomes current — they continue rendering with the assets that were current at their publish time (handled via versioning columns on evidence_items and asset reference tables in a follow-on migration documented in SCHEMA_REGISTRY.md).

## 10.5.7 Failure Handling

If A-44 scrape fails (site down, robots.txt blocks all crawlers, parse error):

- client_ingestion_versions row is created with status='failed' and failure_reason populated
- Existing current version (if any) remains current; A-02 continues with stale data
- P2 advisory signal raised: "Quarterly knowledge ingestion failed for [client name]. Retry scheduled."
- Retry with exponential backoff: +1 day, +3 days, +7 days
- After 7 days of consecutive failures, escalate to P1 signal
- Master_admin can manually block A-44 for a client via clients.ingestion_blocked = TRUE with reason (e.g., "Client requested no automated crawls")

## 10.5.8 Master_Admin Override — Unscrapable Sites

Contract 73 has exactly one override path: a master_admin may bypass the A-44 prerequisite for a specific client by manually providing ingestion assets.

When to use this override:
- Client's website is genuinely unscrapable (down at onboarding, robots.txt blocks all crawlers, no public site exists)
- Client requests no automated crawling of their domain
- Client provides their own brand assets directly (operator uploads them manually)

Process:
1. Master_admin opens /dashboard/clients/[id] Knowledge Base tab
2. Clicks "Manual Asset Provision" button (visible to master_admin only)
3. Required justification field populated with reason
4. Uploads brand voice descriptors, logo files, certification badges, NAP data via form
5. Platform creates client_ingestion_versions row with approval_status='manually_provided', is_current=TRUE
6. Action logged to user_actions with action_type='override_a44_prerequisite' per Contract 72

After the override, A-02 is unblocked for the client. The override is visible in audit logs to all master_admin and senior_admin users.

## 10.5.9 Risk Acknowledgment (Carried Forward from AGENTS.md 2026-05-17 Operator Decision)

No preemptive copyright filtering on captured manufacturer badges, certifications, or similar third-party trust marks. Cease-and-desist is the rare-case recovery path. Manufacturers benefit from product promotion and rarely object to certified-installer displays. If C&D received for any specific asset, remove that asset from active rendering and disable client re-display via the client_ingested_assets table flag.

## 10.5.10 Outputs Summary

- client_ingested_assets table populated with per-asset rows
- client_brand_voice_model row updated for the client
- client_keyword_gap_analysis row updated for the client
- evidence_items table extended with ingested photo imports
- client_ingestion_versions row created with appropriate status and approval_status
- clients.current_ingestion_version_id pointer updated to the new is_current=TRUE row
- clients.last_ingestion_at, next_ingestion_scheduled_at updated

## 10.5.11 Tables Used

A-44 reads from and writes to:

- client_ingested_assets (Phase 1 migration N+X — exact slot reserved at implementation)
- client_brand_voice_model (Phase 1 migration N+X)
- client_keyword_gap_analysis (Phase 1 migration N+X)
- client_ingestion_versions (Phase 1 migration N+4 per ROLE_HIERARCHY_ARCHITECTURE_SPEC.md)
- evidence_items (extended with new columns for ingested photo imports)
- clients (extended with current_ingestion_version_id, last_ingestion_at, next_ingestion_scheduled_at, ingestion_blocked, ingestion_block_reason)

Migration details and exact schema appear in SCHEMA_REGISTRY.md following the Document 4 delta of the 2026-05-23 governance synchronization.

## 10.5.12 Contract Enforcement

- Contract 73 (Pre-Generation Knowledge Ingestion Requirement) — A-02 is blocked until A-44 produces a successful current version for the client
- Contract 61 (AEO/Voice/Conversion Discipline) — A-02 reads client_brand_voice_model output for tone, terminology, and entity references
- Contract 18 (Evidence Authenticity HARD) — A-44 outputs feed A-43 Trust Signal Composer which composes verified trust signals onto each page
- Contract 72 (Multi-User Audit Attribution) — All A-44 manual triggers and override actions log to user_actions with three-attribute attribution
- Contract 71 (RBAC Enforcement) — Manual triggers and override actions gated by permission matrix
- Contract 60 (Backlink Operations Strict Whitelist) — does not apply directly to A-44 but A-45 reads A-44 outputs for unlinked-mention detection, which is Contract 60-bounded

---

# ============================================================================
# PART 11 — 2026-05-23 RBAC ARCHITECTURE LOCK
# ============================================================================

## 11.1 Architectural Decision

On 2026-05-23, the operator authorized a multi-user role hierarchy to replace the prior single-operator architecture. The decision is durably locked per Contract 50 (Architectural Decision Durability).

## 11.2 Role Taxonomy

Three operator-side roles plus the existing client role:

- **master_admin** — platform owner, top of hierarchy, full action scope subject only to constitutional constraints (Contracts 6, 9 hard gates, 18, 45). Typically one user, schema permits more.
- **senior_admin** — trusted operational manager, can execute substantive work on any client including page approval and A-44 manual triggers, cannot make decisions affecting billing, role assignments, or permanent destructive actions.
- **va** — virtual assistant, can execute high-volume low-risk operational tasks including evidence upload, directory registration, backlink advisory operations (Contract 60-bounded), and indexation checks. Cannot trigger expensive operations, approve flagged pages, override quality gates, or modify financial state.
- **client** — existing client portal role, unchanged.

## 11.3 Permission Scoping

Roles are **global**, not per-client. A VA is a VA across all clients. A senior_admin is a senior_admin across all clients. This was the operator decision 2026-05-23 (Wave 1 Issue B answer).

## 11.4 Audit Attribution

Every audit-logged action captures three attributes:
1. Acting user ID
2. Role at time of action (preserved historically, not retroactively updated)
3. Client context (NULL only for platform-level actions like role grants)

This was the operator decision 2026-05-23 (Wave 1 Issue C answer). Contract 72 enforces this.

## 11.5 A-44 Phase Relocation

A-44 Client Knowledge Ingestion Engine is relocated from Phase 1.5 to Phase 1, sequenced immediately after A-01 and before A-10 in the post-onboarding pipeline. A-02 Page Generator cannot execute for a client until A-44 produces a successful current ingestion version. Contract 73 enforces this. Full A-44 specification appears in Part 10.5 above.

## 11.6 Schema Additions

The RBAC architecture introduces four new tables and nine column additions to existing tables. Full schema specification appears in SCHEMA_REGISTRY.md following the Document 4 delta of the 2026-05-23 governance synchronization. Tables added:

- user_roles
- user_actions
- role_grant_audit
- client_ingestion_versions

## 11.7 New Behavioral Contracts

Three new contracts are added per the 2026-05-23 synchronization. Full text in BEHAVIORAL_CONTRACTS.md:

- Contract 71 — Role-Based Access Control (RBAC) Enforcement
- Contract 72 — Multi-User Audit Attribution
- Contract 73 — Pre-Generation Knowledge Ingestion Requirement

Contract 67 (Resource Ownership Verification) is amended rather than replaced to incorporate role-based ownership semantics.

## 11.8 Canonical Specification Reference

The full canonical specification for the role hierarchy, including the complete permission matrix across all 45+ protected actions, RLS policies, migration sequence, UI implications, backward compatibility plan, and risk mitigations, is documented in:

**`docs/architecture/ROLE_HIERARCHY_ARCHITECTURE_SPEC.md`**

This file is the single source of truth for role hierarchy implementation. BLUEPRINT.md cross-references it; SCHEMA_REGISTRY.md derives from it; AGENTS.md sequences from it; BEHAVIORAL_CONTRACTS.md enforces from it; MASTER_BUILD_SPEC.md surfaces from it; STATE_OF_THE_BUILD.md logs from it.

Any discrepancy between this Part 11 summary and ROLE_HIERARCHY_ARCHITECTURE_SPEC.md is resolved in favor of ROLE_HIERARCHY_ARCHITECTURE_SPEC.md.

## 11.9 Backward Compatibility

The existing operator account `operator@tarritrix.test` (auth UUID `aaaaaaaa-0000-0000-0000-000000000001`) is automatically promoted to master_admin via migration N+2 (`seed_user_roles_from_auth_users.sql`). E4 Construction & Roofing client ownership (via `clients.operator_id`) is preserved unchanged — the operator_id continues to point to the now-master_admin account.

Existing seeded clients (E4 and any others) receive synthetic baseline A-44 ingestion version rows via migration N+8 (`seed_a44_baseline_for_existing_clients.sql`) so that Contract 73 is satisfied at the database constraint level and A-02 page generation continues without interruption. The synthetic baseline flag (`clients.ingestion_synthetic_baseline = TRUE`) marks these clients for a real A-44 scrape at the next operator-touched interaction.

## 11.10 Change Log Reference

This Part 11 lock is recorded in STATE_OF_THE_BUILD.md as a session log entry under 2026-05-23. The session log entry includes the commit hash that applied the synchronized governance updates across all 6 files plus the ROLE_HIERARCHY_ARCHITECTURE_SPEC.md addition.

## 11.11 Comprehensive Integrity Framework (CIF)

**Established:** 2026-05-24
**Status:** Canonical governance specification
**Reference:** docs/architecture/COMPREHENSIVE_INTEGRITY_FRAMEWORK.md

The Comprehensive Integrity Framework (CIF) defined at docs/architecture/COMPREHENSIVE_INTEGRITY_FRAMEWORK.md governs verification, drift detection, and integrity enforcement across all 9 layers. Contracts 74, 75, 76 enforce CIF compliance.

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

**6-Stage Build Sequence:** Critical Production Safety → Data Integrity → Cross-System Consistency → Runtime/Performance → Storm/TCPA/Tarritrix-Specific → Process/Deployment Hygiene

**Enforcement:** Every commit must pass `pnpm verify:fast`. Every push must pass `pnpm verify:ci`. Every release must pass `pnpm audit:comprehensive`.

---

**End of BLUEPRINT.md.**
