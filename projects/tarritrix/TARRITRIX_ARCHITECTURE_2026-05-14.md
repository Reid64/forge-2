---
title: Tarritrix 1.0 Architecture Document
subtitle: Comprehensive Phase 1 Architecture - Differentiation Engine, Multi-Tenant Hosting, Storm Intelligence, and Build Sequencing
author: Architect (Claude.ai) with Operator (Reid)
date: 2026-05-14
---

# Executive Summary

This document is the canonical architecture specification for Tarritrix 1.0 Phase 1. It supersedes prior conceptual specs in BLUEPRINT.md and the CC-produced `BLUEPRINT_ADDITIONS_FROM_CGA.md`.

The document is organized into nine sections, each addressing a load-bearing architectural element:

1. **Premium Page Generator + Differentiation Engine (A-02)** — the spine of the platform. Six axes of differentiation ensure no two clients produce templated output. Module library, brand signatures, anti-monotony enforcement.
2. **Client Site Ingestion & Competitive Analysis (A-21)** — extracts authentic brand identity from each client's existing site plus 3-5 competitors. Promoted to Phase 1 mandatory.
3. **Page Validator (A-05) — 15 Quality Gates** — gatekeeper between generation and publishing. Three un-overridable hard gates protect against fabrication.
4. **Storm Intelligence Engine** — proprietary NOAA + Mesonet + NWS + SPC weather data pipeline. Free-tier sources only at launch. 10-year historical backfill plus daily ingestion.
5. **Multi-Provider LLM Routing** — operator-selectable routing across Anthropic, OpenAI, and Google with cost governance, circuit breakers, and Command Center visibility.
6. **Multi-Tenant Page Hosting (A-20, Mode C)** — pages render at client's own domain via DNS routing. The product's load-bearing spine.
7. **Phase 1 Build Sequencing & Critical Path** — 36+ build units in dependency order across 7 waves.
8. **Audit Reconciliation & Phase Triage** — explicit routing of every finding from CC's 73-finding gap audit into Phase 1, 1.5, 2+, or rejected.
9. **Performance Learning Engine (A-29)** — the compounding moat. Phase 2 first-class agent with Phase 1 data preparation. Correlation analysis + human-in-the-loop. Turns every customer's performance data into platform-wide learning.

The total Phase 1 scope is approximately 40 distinct build units plus A-29 data preparation (2 tables + 1 ALTER, ~2-3 hours of work). This represents the minimum coherent set that delivers a first paying customer who succeeds, while preparing the data substrate for compounding platform intelligence in Phase 2.

---

# Section 1: Premium Page Generator and Differentiation Engine (A-02)

**Phase:** 1 Mandatory
**Status:** Canonical specification
**Replaces:** Any prior A-02 stub in BLUEPRINT.md

## 1.1 Mission Statement

A-02 produces city × service web pages that:

1. **Rank** — defensibly more useful for the query than the best competing page Google currently shows
2. **Differentiate** — no two clients in the same market produce visibly, structurally, linguistically, or visually similar output
3. **Authenticate** — every factual claim traces to real data
4. **Scale** — produces 500+ pages per client across hundreds of clients without templated pattern recognition by Google or competitors
5. **Adapt** — pages reflect each client's actual brand voice, evidence library, service positioning, and market context

**Bar:** If A-05 Page Validator cannot prove a page meets all five criteria, the page does not publish.

## 1.2 The Six Differentiation Axes

A-02 produces differentiation across six simultaneous axes. All must be active for any page generated.

### Axis 1: Brand Identity Signature (Per-Client, Locked at Onboarding)

Every client receives a Brand Identity Signature stored permanently in the `client_brand_signatures` table. Assigned during onboarding via A-21 Client Site Ingestion where possible; operator-selected from constrained library where A-21 cannot ingest.

Components and Phase 1 launch library sizes:

| Element | Phase 1 Library | Phase 1.5+ Library | Notes |
|---------|-----------------|---------------------|-------|
| Typography pairing | 15 vetted pairings | 50+ | Serif/sans pairings tested for legibility at all sizes |
| Color palette | 25 vetted palettes | 100+ | Tagged by aesthetic archetype compatibility |
| Layout density | 4 levels | Same | Sparse / standard / dense / hyperdense |
| Aesthetic archetype | 8 archetypes | 20+ | Bloomberg-terminal, NYT-longform, Apple-product, Patagonia-documentary, Stripe-technical, Linear-engineering, editorial, functional |
| Voice register | 8 voices | 15+ | Analytical, narrative, technical, conversational, authoritative, neighborly, urgent, methodical |
| Photo treatment | 6 treatments | 10+ | Duotone, desaturated, saturated, high-contrast, cinematic, documentary |

**Constraints enforced at assignment:**

- **DMA diversity** — no two clients in the same DMA (Designated Market Area, approximately 210 in the United States) receive the same brand signature. Tracked via `client_brand_signatures.dma_code` index.
- **Service-vertical diversity** — within a DMA, no two clients in the same service vertical (roofing vs. PDR) share more than 2 signature components.
- **Brand-match override** — if A-21 detects an existing brand from the client's site (typography, palette), the signature inherits those values rather than randomizing.
- **Operator override** — operator can manually override any signature component during onboarding review.

**Lock duration:** Signature is permanent for the client. Changing it post-launch would require regenerating all pages, which would be expensive and would break SEO continuity.

### Axis 2: Module Selection Variance (Per-Page Within Client)

Pages are composed of 4-8 modules selected from the module library (Axis 3). Selection varies by:

- **Page-type template** — different page archetypes pull from different module pools
- **City-specific tagging** — Dallas pages prefer tornado-history modules; Orlando prefers hurricane-track modules; Oklahoma City prefers tornado-alley positioning modules; each module tagged with applicable cities, regions, and climate zones
- **Service-specific tagging** — hail damage pages prefer hailstone-size diagrams; wind damage pages prefer wind-speed maps; tile roofing pages prefer tile-lifecycle charts
- **Data availability gating** — if a client lacks photo permission for testimonials, customer-photo modules do not render; the page composes around what is available with no placeholder data
- **Anti-repetition lookback** — A-02 queries the last 10 pages generated for this client and weights against modules used too frequently
- **Cross-client diversity gate** — A-02 queries module usage across all clients in the same DMA and weights against modules used by competitors

### Axis 3: Module Library Rotation Pool

A deep library of 300-500 modules organized into 8 pools. Modules within a pool are functionally similar but visually and structurally distinct.

**Pool structure (target counts at Phase 1.5 maturity; Phase 1 launches with subset):**

**Pool A — Storm Visualization (target 60 modules):**
Modules that render storm, weather, and climate data. Examples:

- Pulsing storm marker map (the CSS demo style)
- Heatmap density overlay
- Storm event timeline strip
- Animated radar replay (NOAA reflectivity)
- Hail size distribution histogram
- Wind speed gauge with historical comparison
- Tornado track polylines
- Seasonal storm frequency calendar
- Damage probability isobands
- Comparative storm intensity ranking versus neighboring metros
- Bar chart of storms by year (last 10 years)
- Radial chart of storm timing by month
- Stacked area chart of storm type breakdown
- Topographic overlay with storm event pins
- Sankey diagram from storm type to damage type

Each module renders from real NOAA and Mesonet data, is visually and structurally distinct from siblings in the pool, and is tagged for applicable climate zones, service types, page-type templates, and brand archetypes.

**Pool B — Carrier / Insurance Intelligence (target 30 modules):**

- Bloomberg-style carrier table (CSS demo style)
- Sankey diagram of claim flow
- Carrier performance scorecard
- Underpayment heatmap
- Settlement timeline comparison
- Denial reason taxonomy
- Carrier-specific average days-to-settle bar chart
- Claim approval funnel

**Pool C — Customer Evidence (target 40 modules):**

- Photo grid (CSS demo style)
- Documentary photo essay
- Before/after slider
- Customer story longform
- Address-pinned completed jobs map
- Generational customer testimonial
- Customer video testimonial embed
- Star rating distribution from real reviews
- Customer-by-neighborhood density map

**Pool D — Authority / Trust (target 35 modules):**

- License and certification badge bar
- Manufacturer partnership grid
- Press mentions strip
- Industry association display
- Community involvement gallery
- Charitable contributions timeline
- Years-in-business counter
- Crew bios with credentials

**Pool E — Decision Support (target 30 modules):**

- Damage assessment self-checklist
- Insurance claim navigator
- Material selection matrix
- Lifecycle cost calculator
- Financing options comparison
- "Repair vs. replace" decision tree
- ROI calculator for premium materials

**Pool F — Process / Methodology (target 30 modules):**

- Step-by-step claim process
- Inspection methodology
- Project timeline Gantt
- Communication cadence diagram
- Quality assurance checklist

**Pool G — Action / Conversion (target 20 modules):**

- Schedule inspection (calendar integration)
- Emergency response request
- Insurance claim assistance request
- Free estimate form
- Live availability indicator

**Pool H — Narrative / Editorial (target 25 modules):**

- Longform pull quote
- Historical narrative (city plus contractor history)
- Editorial sidebar
- Annotated timeline
- Glossary of terms

**Total Phase 1.5 target:** 270 modules across 8 pools.

**Phase 1 launch target:** 60-90 modules total (8-12 per pool minimum). Enough variety for first 1-10 customers without templated repetition.

**Module authoring:** Each module is a React component with strict TypeScript interface, a `data_requirements` Zod schema, 3-5 visual variations tuned for different brand archetypes, tests against real data and edge cases, and is stored in the `module_library` table with versioning.

### Axis 4: Composition Variance Engine

Same modules in different compositions produce visually different pages. A-02's orchestrator varies:

- **Module sequence** — five modules in five different orders produce five visually distinct pages
- **Section breakers** — long-form prose, pull quote, data callout, divider treatment
- **Hero treatment** — full-bleed image, split layout, video-loop, data-density hero, typography-only hero, map-as-hero
- **CTA placement** — inline, sticky, modal-trigger, sectional, footer-anchored
- **Internal link patterns** — sidebar related, contextual inline, bottom-of-page, breadcrumb
- **Sectioning style** — hard rule dividers, soft whitespace, color-block transitions, accent bars
- **Image-to-text ratio** — image-heavy, balanced, text-forward, data-forward

These are stored as composition recipes in the `composition_recipes` table, not hardcoded. Operator can author new recipes.

### Axis 5: LLM-Generated Variance (Per-Page)

LLM prose is the deepest variance lever. Each page's LLM call includes:

- The client's brand voice signature from Axis 1
- The page intent (urgency, authority, education, decision-support, conversion)
- The selected modules and their bound data
- **A diversity prompt** — "This page must be linguistically distinct from these 10 most recent pages for this client and these 50 most recent pages across the platform. Avoid these phrasings: [auto-extracted high-frequency phrases from recent pages]."
- **A perspective rotation** — homeowner-perspective, contractor-perspective, claims-adjuster-perspective, inspector-perspective, insurance-broker-perspective. Same topic, different lens.
- **Length constraint** — short (600-900 words), medium (1200-1800), long (2500-3500), varied to prevent uniform page length signaling templates

**Embedding similarity check in A-05** post-generation: page text is embedded, compared via cosine similarity to all the client's prior pages and all platform pages in the last 90 days. If similarity exceeds threshold (default 0.78), the page fails validation with reason "excessive similarity". A-02 retries with different module selection and a stronger diversity prompt.

After 3 retry failures, the page queues for operator review.

### Axis 6: Real-Data Singularity (The Unfair Advantage)

The deepest differentiation: **a client's real data is unique to them.** No two contractors have the same:

- Customer stories
- Completed jobs (addresses, dates, scope, photos)
- Storm response history
- Review velocity and content
- Conversion patterns
- Crew bios and credentials
- Project portfolio
- Community involvement
- Press mentions
- Manufacturer certifications

**Pages bound to real data become differentiated by definition, not by template variation.**

Required: Modules that display data are strictly data-bound with:

- `data_source` field on every datapoint (CRM, NOAA, Mesonet, GSC, GBP, client_evidence, operator_manual)
- `data_freshness_at` timestamp on every fetch and calculation
- `freshness_tolerance` per module — module does not render if data is stale beyond tolerance, or renders with a "Data current as of [date]" disclosure
- **No fallback to fabricated data, ever.** Missing data means the module does not render. The page composes around it.

**A-05 Validator Gate 1 (hard):** Every numerical or factual claim in page text must trace to a `data_source` row. Pages with untraced facts fail. Period.

This means A-21 Client Site Ingestion, A-18 Job Evidence Ingestion, and A-19 Universal Integration Hub become load-bearing for differentiation quality. The more real data per client, the more genuinely unique the pages.

## 1.3 Page-Type Template Library

Pages are composed from one of 12 archetypal page-type templates. A-10 Content Profile Builder plus city characteristics plus service type plus client positioning selects which template applies per page.

| # | Template Name | Applicable Triggers | Primary Module Pools |
|---|---------------|--------------------|-----------------------|
| 1 | Post-Storm Urgency | Storm event in city within 90 days | A (storm), G (action), F (process), C (evidence) |
| 2 | Multi-Decade Authority | Contractor in business 15+ years | D (authority), H (narrative), C (evidence), E (decision) |
| 3 | Hurricane Recovery Specialist | FL/GA/LA/TX/SC/NC coastal markets | A (storm), F (process), B (carrier), C (evidence) |
| 4 | Hail Specialist | Tornado Alley + plains markets | A (storm), E (decision), B (carrier), C (evidence) |
| 5 | Premium Concierge | Affluent zip codes (median income >$120K) | D (authority), H (narrative), C (evidence), F (process) |
| 6 | Insurance-Claim Navigation | High claim-density markets | B (carrier), F (process), E (decision), G (action) |
| 7 | Storm-Prep / Pre-Loss | Seasonal pre-storm windows | A (storm), E (decision), F (process), G (action) |
| 8 | Comparison / Decision | Mid-funnel decision queries | E (decision), C (evidence), B (carrier), H (narrative) |
| 9 | Neighborhood-Specific | High-income suburbs, HOA-defined | C (evidence), D (authority), F (process), H (narrative) |
| 10 | Specialty Service | PDR, metal roofing, slate, tile | F (process), E (decision), D (authority), C (evidence) |
| 11 | Emergency Response | 24/7 emergency service positioning | G (action), F (process), C (evidence), A (storm) |
| 12 | Authority + Civic Engagement | Strong community-tie contractors | D (authority), H (narrative), C (evidence), F (process) |

Each template defines which module pools draw from (and minimum modules per pool), module ordering preferences (not rigid, allowing composition variance), required modules (post-storm urgency must have a storm event module if storm data exists), and forbidden module pairings (do not pair "premium concierge" tone with "emergency response" CTA).

Template selection logic in A-10 Content Profile Builder ensures clients in the same city plus service vertical receive different templates across their page library — no two adjacent pages use the same template within a client.

Phase 1 launches with 6 templates minimum: Post-Storm Urgency, Multi-Decade Authority, Hurricane Recovery Specialist, Hail Specialist, Insurance-Claim Navigation, Emergency Response. Templates 7-12 ship in Phase 1.5.

## 1.4 LLM Model Selection Per Page

Not every page deserves Opus-level reasoning. Cost-effective routing:

| Page Tier | Model | Reasoning Mode | Cost per Page (est.) | Use Case |
|-----------|-------|----------------|----------------------|----------|
| Flagship | Claude Sonnet 4.7 | Extended | $0.40-$0.80 | City homepage, high-value service hubs; approximately 10-15 per client |
| Premium | Claude Sonnet 4.7 | Standard | $0.15-$0.30 | Major service pages, specialty service pages; approximately 30-60 per client |
| Standard | Claude Haiku 4.5 | Standard | $0.03-$0.06 | Long-tail neighborhood and service combinations; approximately 100-400 per client |
| Refresh | Claude Haiku 4.5 | Minimal | $0.01-$0.02 | A-11 Content Refresh updates to existing pages |

Operator-selectable in Command Center per Multi-Provider LLM Routing architecture (Section 5). Tier defaults can be overridden per client.

**Cost math at scale (Dominance tier example):**

- 500 pages × Dominance distribution: approximately 15 flagship + 60 premium + 425 standard
- Initial generation cost: 15 × $0.60 + 60 × $0.22 + 425 × $0.05 = $9.00 + $13.20 + $21.25 = **$43.45 per client first generation**
- Annual refresh (4 times per year per A-11): approximately 500 × $0.015 × 4 = **$30 per year per client refresh**
- **Total LLM cost per Dominance client:** approximately $73-$80 first year, $30 per year thereafter
- At $3,497 per month × 12 = $41,964 annual revenue per Dominance client. LLM cost is **0.2% of revenue.** Healthy.

**Critical:** This math assumes correct model routing. If A-02 defaults to Sonnet for all 500 pages: 500 × $0.22 = $110, still healthy. If A-02 defaults to Opus for all 500: 500 × $0.80 = $400 per client × 1000 clients = $400K per year LLM bill. Not healthy without correct routing.

## 1.5 The Generation Pipeline (End-to-End)

For each page A-02 generates, the orchestrator:

1. Receives input from `page_generation_queue` row: `client_id`, `city_id`, `service_id`, `priority`
2. Loads client context — brand signature (Axis 1), tier, evidence library, content profile from A-10
3. Selects page-type template — A-10 plus city characteristics plus diversity history → template ID
4. Resolves module pool requirements — template specifies pools, A-02 selects specific modules with diversity constraints (anti-repetition, anti-DMA-collision, data-availability filter, brand-archetype compatibility)
5. Resolves composition recipe — sequence, hero treatment, CTA placement, internal link patterns
6. Binds real data — every module's data slots filled from real sources, no fabrication, no defaults
7. Generates LLM prose — model selection per tier, diversity prompt included, perspective rotation, length constraint
8. Submits to A-05 Validator — 15 quality gates (Section 3)
9. On validation pass — page status set to `validated`, queued for A-07 Sitemap and A-20 Hosting deployment
10. On validation fail — A-02 retries with different module/composition selection up to 3 times, then queues for operator review

Every step writes to `agent_events` for observability and cost-tracking. Total page generation time target: 30-90 seconds (LLM-bound).

## 1.6 Phase 1 Launch Targets (Minimum Viable Differentiation)

Phase 1 launch targets (minimums to avoid templated output with 1-10 customers):

- **Brand signature engine:** fully built (Axis 1 active)
- **Typography library:** 15 pairings minimum
- **Color palette library:** 25 palettes minimum
- **Aesthetic archetype library:** 8 archetypes minimum
- **Module library:** 60-90 modules total (8-12 per pool)
- **Page-type templates:** 6 of 12 minimum
- **Composition recipes:** 3-5 per page-type template (approximately 20-30 total)
- **Anti-monotony embedding gate:** fully built
- **Cross-client DMA diversity gate:** fully built
- **Real-data binding contract:** fully built (no fabrication possible)

Phase 1.5 expands to the full 270 modules, 12 templates, 100+ recipes. Phase 2 scales to community-contributed modules.

## 1.7 Acceptance Criteria for A-02

A-02 ships when:

1. All six axes are active in every generated page
2. Module library has 60+ modules across 8 pools (minimum 5 per pool)
3. Brand signature engine produces valid signatures with DMA diversity enforcement
4. Anti-monotony embedding gate fails pages above similarity threshold
5. Real-data binding gate fails pages with untraced facts
6. End-to-end test: generate 20 pages across 5 mock clients in the same DMA; verify no two pages from different clients look related (manual operator review plus automated similarity check)
7. Cost per page hits target range (flagship < $0.80, premium < $0.30, standard < $0.06)
8. Average generation time per page < 90 seconds

---

# Section 2: Client Site Ingestion and Competitive Analysis (A-21)

**Phase:** 1 Mandatory
**Status:** Canonical specification

## 2.1 Mission

A-21 ingests each client's existing website (and 3-5 competitors) at onboarding to produce a real, evidence-backed Brand Identity Signature and content profile for A-02. Without A-21, signatures are operator-selected from libraries (generic). With A-21, signatures are derived from the client's actual brand (authentic).

A-21 produces three artifacts per client:

1. **Brand Identity Signature** (typography, palette, voice, archetype) extracted from client's existing site
2. **Evidence Library** (real customer stories, completed jobs, certifications, team info, photos)
3. **Content Profile** (services covered, topical map, gaps vs. competitors)

These feed A-10 Content Profile Builder, which feeds A-02 Page Generator.

## 2.2 Trigger Points

A-21 runs:

1. **At onboarding (Step 5)** — operator pastes client's existing site URL, A-21 ingests, operator reviews/approves output before client moves to Step 6
2. **On operator demand** — operator triggers re-ingestion if client's site has substantially changed
3. **On A-21 update cycle (Phase 1.5)** — automated quarterly re-scan to detect site changes

Phase 1 supports triggers 1 and 2 only.

## 2.3 What A-21 Extracts

### From the Client's Site

Crawl scope (maximum 50 pages per client crawl):

- Homepage
- "About" or "Company" pages
- All "Service" pages (auto-discovered)
- "Reviews" or "Testimonials" pages
- "Gallery" or "Portfolio" pages
- "Contact" page
- "Team" or "Crew" pages
- Blog pages (if present, sample top 10)

Extraction targets:

| Extracted Item | Destination | Used For |
|----------------|-------------|----------|
| Primary typography (font-family from CSS) | `client_brand_signatures.typography_pairing_id` | Axis 1 |
| Primary brand colors (logo + buttons + hero) | `client_brand_signatures.color_palette_id` | Axis 1 |
| Brand voice (LLM analysis of body text) | `client_brand_signatures.voice_register` | Axis 1 |
| Aesthetic archetype | `client_brand_signatures.aesthetic_archetype_id` | Axis 1 |
| Photo treatment | `client_brand_signatures.photo_treatment` | Axis 1 |
| Logo (extracted, validated, stored) | `client_evidence.logo_asset_id` | Brand consistency |
| List of services offered | `services` table seed | Onboarding Step 6 pre-fill |
| Service descriptions (verbatim) | `client_evidence_progress` | A-02 evidence binding |
| Customer testimonials (text + attribution) | `client_evidence_progress` | C pool modules |
| Customer photos / before-after | `client_evidence_progress` | C pool modules |
| Crew bios | `client_evidence_progress` | D pool modules |
| Certifications, licenses, awards | `client_evidence_progress` | D pool modules |
| Manufacturer partnerships | `client_evidence_progress` | D pool modules |
| Community involvement, charity work | `client_evidence_progress` | D pool modules |
| Years in business / founding date | `clients.founded_year` | D pool modules |
| Press mentions | `client_evidence_progress` | D pool modules |
| Existing meta descriptions / SEO patterns | `content_profile.existing_seo_patterns` | A-10 |
| Existing topical coverage | `content_profile.existing_coverage_map` | A-10 gap analysis |
| Internal link structure | `content_profile.link_patterns` | A-10 |

### From Competitors (Phase 1)

Crawl scope:

- 3-5 competitor domains (operator-identified or SERP-derived)
- Same page-type targets as client crawl
- Maximum 30 pages per competitor (controls cost)

Extraction targets:

- Topical coverage map (what they cover, what they do not)
- Page depth (word counts, content density)
- Service breadth (services listed)
- Geographic coverage (cities served)
- Identified gaps in client's coverage that competitors fill
- Identified gaps in competitor coverage that the client could exploit

## 2.4 Technical Architecture

### Crawler

**Tool:** Playwright (already in dependencies for E2E tests) in headless mode. Reuses existing Playwright infrastructure.

**Why Playwright over alternatives:**

- Handles JavaScript-rendered sites (Wix, Squarespace, React/Vue apps)
- Existing skill set in the codebase
- Better resilience than Puppeteer in modern web environments
- Browser context isolation per crawl

**Rate limiting:**

- 2-second delay between requests to client's site (polite crawling)
- Respect robots.txt strictly
- User-Agent: `Tarritrix Site Ingestion Bot 1.0 (+https://tarritrix.com/bot)`
- If site blocks crawler: fall back to operator-pasted page samples (Step 5 has a fallback mode)

**Storage:**

- Raw HTML stored in Supabase Storage bucket `client_site_crawls/{client_id}/{timestamp}/`
- Retained for 90 days for re-analysis without re-crawl
- Processed extractions stored in tables

### Content Extraction Pipeline

Two-stage extraction:

**Stage 1 — Structural extraction (no LLM):**

- HTML parsing (cheerio or similar)
- Font extraction from CSS (computed style)
- Color sampling from logo, buttons, hero backgrounds
- Image extraction (with attribution preservation)
- Schema.org / JSON-LD parsing
- Meta tag extraction
- Internal link extraction

**Stage 2 — Semantic extraction (LLM):**

- Brand voice analysis (Claude Haiku 4.5, sample 5-10 representative pages, approximately $0.02-$0.05 per client)
- Aesthetic archetype classification (Claude Haiku 4.5, visual + textual signals, approximately $0.02)
- Service offering extraction + normalization (Claude Sonnet 4.7, structured output, approximately $0.05)
- Evidence extraction (testimonials, awards, certifications) (Claude Sonnet 4.7, structured output, approximately $0.10-$0.20)
- Topical coverage mapping (Claude Sonnet 4.7, approximately $0.05)

**Total LLM cost per client crawl:** approximately $0.25-$0.40.

### Brand Signature Matching

Stage 2 output for signature components does not generate new values — it matches the client's extracted properties to the existing library:

- Extracted font-family → closest match in `typography_library`
- Extracted brand colors → closest match in `palette_library` (color distance algorithm)
- If no library match exists within tolerance: operator review flag raised. Operator decides whether to add new pairing/palette to library, select closest existing match, or override entirely.

This keeps the library consistent while honoring the client's actual brand.

## 2.5 Operator Review Step

After A-21 runs, operator reviews output in onboarding Step 5.5:

**Review UI shows:**

- Side-by-side: client's actual site screenshot vs. Tarritrix-rendered brand signature preview
- All extracted evidence items with toggles (use / don't use / needs permission)
- Brand signature components with overrides available
- Service list with edit/add capability
- Any A-21 confidence warnings

**Operator actions:**

- Approve signature as-is
- Override specific components (typography only, palette only, etc.)
- Mark evidence items as not-usable (permission not confirmed)
- Add manual evidence items A-21 missed
- Re-run A-21 with operator notes if extraction was poor

Approval locks the signature (Axis 1 constraint).

## 2.6 Sparse-Site Command Center Alert

When A-21 detects insufficient content to extract a signature (small site, JS-rendered blocking crawl, etc.):

- Raises `tenant_signal` of type `manual_screenshot_required`
- Operator sees alert in Command Center with affected client and reason
- Operator manually captures essential pages and uploads via "Manual Site Capture" tool
- A-21 processes uploaded content through the same Stage 2 pipeline
- Marked `crawl_type='operator_paste'` in `site_crawls`

## 2.7 Permission and Legal Handling

### Photos from Client's Site

**Default assumption:** Photos on the client's own website are theirs to use elsewhere. Tarritrix treats them as usable unless operator flags otherwise.

**Risk:** Client may not actually own photos (used stock, manufacturer images, customer-submitted without permission).

**Mitigation:** Onboarding Step 5.5 includes operator checkbox: "Client confirms all images on their site are owned/licensed for marketing use." If unchecked, A-21 extracts but flags all photos as `permission_required = TRUE`. Modules that would use them do not render until operator manually approves per-photo.

### Customer Testimonials

Default: Treat as usable since they are public on client's site.

Mitigation: Same as photos — operator confirmation in Step 5.5.

### Robots.txt and Terms of Service

A-21 strictly respects robots.txt for the client's own site. If client's site has restrictive robots.txt blocking the path A-21 needs, fall back to operator-pasted page samples.

For competitor crawling: more conservative robots.txt handling plus ToS check before crawl. Some competitors may be off-limits.

## 2.8 Cost

Per-client cost (one-time at onboarding):

- Playwright crawl execution (Vercel function time): approximately $0.05-$0.10
- Supabase Storage (raw HTML retention 90 days): approximately $0.01
- LLM extraction (Stage 2): approximately $0.25-$0.40
- **Total A-21 cost per client onboarding:** approximately $0.35-$0.55

At 1000 clients onboarded: approximately $350-$550 total. Negligible relative to revenue.

## 2.9 Acceptance Criteria

A-21 ships when:

1. Successfully crawls 95%+ of standard contractor websites (WordPress, Squarespace, custom, Webflow)
2. Brand signature extraction produces operator-approval rates >70% (operator accepts as-is or with minor tweaks)
3. Evidence extraction produces 10+ usable items per client average
4. Fallback paste mode works for Wix and other blocked sites
5. Sparse-site Command Center alert functional
6. Cost per client crawl <$0.60
7. End-to-end test: ingest 5 real contractor sites, operator reviews output, signature plus evidence quality meets bar

---

# Section 3: Page Validator (A-05) — 15 Quality Gates

**Phase:** 1 Mandatory

## 3.1 Mission

A-05 is the gatekeeper between page generation and publishing. Every page A-02 produces must pass 15 quality gates before it is eligible to enter the publishing queue. Failed pages route back to A-02 for retry (up to 3 attempts) or operator review.

A-05 is what prevents Tarritrix from becoming the next algorithmically-penalized SEO platform. Without it, A-02 ships pages that look fine in isolation but fail at scale.

**Bar:** Pages that do not pass all 15 gates do not publish. No exceptions. No overrides without operator manual review and explicit unlock with audit logging.

## 3.2 The 15 Quality Gates

### Gate 1: Real-Data Binding (HARD GATE, un-overridable)

Every numerical or factual claim in the page must trace to a `data_source` row.

**Pass criteria:** 100% of factual claims trace to data sources.

**Failure handling:** Hard fail, no retry — A-02 must regenerate prose with explicit constraint to only reference provenance-tracked data.

### Gate 2: Anti-Monotony Embedding Similarity (HARD GATE)

Page text plus module composition must be sufficiently distinct from recent pages.

Implementation:

- Generate embedding of page content (text plus module identifiers, NOT raw HTML)
- Query `page_embeddings` for last 10 pages for this client (cosine similarity threshold: 0.78)
- Last 50 pages across all clients in same DMA, last 90 days (threshold: 0.75)
- Last 200 pages platform-wide, last 30 days (threshold: 0.70)
- If similarity exceeds any threshold: fail

Failure handling: A-02 retries with different module selection, different perspective rotation, stronger diversity prompt.

### Gate 3: Brand Signature Conformance

Page renders with the client's locked brand signature. Typography, palette, archetype, layout density, photo treatment all correctly applied.

### Gate 4: Module Diversity Within Page

No single pool may represent more than 50% of modules in a page (exception: storm-driven pages allowed 60% from Pool A). At least 3 distinct pools represented per page.

### Gate 5: Cross-Client DMA Diversity

For each module in the page, query `module_usage_tracking` for same DMA, last 90 days. If any module is used by more than 30% of clients in this DMA: fail.

### Gate 6: Word Count and Length Variance

Page-type templates have target word count ranges (short 600-900, medium 1200-1800, long 2500-3500). Page must fall within target range. Across client's last 20 pages: word count standard deviation must exceed 300 (enforces variance).

### Gate 7: Heading Structure and Semantic HTML

Exactly one H1 per page. No H3 without preceding H2. Required semantic elements present. Required JSON-LD schema present.

### Gate 8: Internal Link Quality

Internal link count: 4-12 per page. No keyword-stuffed anchor text. All links 200 status. All links to client's domain (A-20 Mode C compliance). Distribution not clustered.

### Gate 9: Image Quality and Provenance

Every `<img>` has alt text. Every image traces to an `extracted_evidence` row or operator-uploaded asset with permission flag set. Dimensions appropriate. WebP preferred. File size <500KB per image post-optimization.

### Gate 10: Storm Reference Authenticity (HARD GATE, un-overridable)

Every storm event mentioned on the page is real and traceable. Each storm reference must link to a `noaa_event_id` from `storm_events` table. If page is a post-storm urgency template: at least one real storm event for this city in last 90 days must be referenced.

### Gate 11: Service Description Accuracy

Page mentions services this client offers (from `services` table). No mention of services client does not offer. Service descriptions consistent with client's existing site content.

### Gate 12: Geographic Accuracy

Page mentions cities only within `clients.service_area` polygon. Neighborhood references match Census-designated places or USPS-recognized neighborhoods. Any addresses match `extracted_evidence` records with operator approval.

### Gate 13: Compliance Conformance (HARD GATE, un-overridable)

TCPA, GDPR, accessibility. All forms have TCPA consent language. Privacy policy and terms linked in footer. Cookie consent banner code present. WCAG 2.1 AA color contrast and ARIA labels. No PII in URLs.

### Gate 14: Performance Baseline

Estimated First Contentful Paint <1.5s. LCP <2.5s. CLS <0.1. Total page weight <2MB. JavaScript bundle <300KB. Number of HTTP requests <30.

### Gate 15: Operator-Configurable Custom Gates

`validation_rules` table allows operator to author custom gates per client or platform-wide. Examples: "Pages for [client X] must mention their certification badge"; "Pages in [DMA Y] must reference local building codes"; "Pages for tier [Authority+] must include video embed".

## 3.3 Validation Flow

Gates run in sequence. Failure at any gate halts validation. Failure reasons logged to `page_validation_results` for operator review.

On any gate failure:
- Log failure to `page_validation_results`
- Increment `page.retry_count`
- If retry_count < 3: requeue to A-02 with constraint hints
- If retry_count >= 3: page status → `operator_review_required`
- Raise `tenant_signal` to operator

## 3.4 Operator Override and Manual Unlock

In rare cases operator must publish a page that failed a gate. Override flow:

1. Operator opens page in Command Center
2. Reviews specific gate failures
3. Selects "Override and publish" with required justification text (>50 chars)
4. System logs override to `operator_actions` table with operator_id, page_id, gate_overridden, justification
5. Page status → `validated_with_override`, proceeds to publish queue
6. Override is auditable forever

**Override is NOT allowed for:**

- Gate 1 (Real-Data Binding) — too high risk of hallucinated facts
- Gate 10 (Storm Reference Authenticity) — too high risk of fabricated dates
- Gate 13 (Compliance Conformance) — legal exposure

## 3.5 Cost and Performance

Per-page validation cost:

- Gate 1 LLM check (claim extraction): approximately $0.02-$0.04 (Sonnet for accuracy)
- Gate 2 embedding generation plus similarity: approximately $0.001
- Gates 3-15 mostly deterministic, no LLM cost: approximately $0.001 in compute
- **Total per validation run:** approximately $0.03

Per page that fails plus retries 3x: approximately $0.09 max in validation cost.

Validation latency: approximately 2-5 seconds per page (LLM-bound on Gates 1 and 2).

## 3.6 Acceptance Criteria

A-05 ships when:

1. All 15 gates implemented and tested with positive plus negative test cases
2. Validation latency <5s per page average
3. Failure routing logic verified (A-02 receives constraint hints on retry)
4. Operator override flow tested with audit logging
5. Manual test set of 50 pages: A-05 correctly fails the 25 known-bad pages, passes the 25 known-good pages
6. False positive rate <10% (good pages incorrectly failing)
7. False negative rate <5% (bad pages incorrectly passing)
8. Hard gates (1, 10, 13) cannot be overridden in code

---

# Section 4: Storm Intelligence Engine

**Phase:** 1 Mandatory
**Tier:** Free sources only (NOAA + Mesonet + NWS + SPC); paid tier deferred until revenue justifies

## 4.1 Mission

The Storm Intelligence Engine is the proprietary data layer that powers post-storm urgency pages, hail specialist pages, hurricane recovery pages, and storm-prep pages. It is the answer to "how does Tarritrix know what storms hit which markets and when."

**Critical constraint:** No external weather API may be called during page render. All weather data is batch-ingested into Supabase, indexed geographically, and read from local tables at page generation time.

## 4.2 Data Sources (Phase 1, Free Tier Only)

| Source | Type | Purpose | Update Frequency | Authority |
|--------|------|---------|------------------|-----------|
| NOAA Storm Events Database | Historical | Authoritative record of past storms (1996-present) | Monthly (30-90 day delay) | Highest — legal-grade for insurance |
| NOAA Storm Prediction Center (SPC) | Recent Reports | Last 24-72 hours of severe weather | Daily | High — preliminary but timely |
| NWS API (api.weather.gov) | Active Alerts | Current watches, warnings, advisories | Real-time (15-min cache) | High — official forecasts |
| Iowa Environmental Mesonet | Historical + Reanalysis | Hail swaths, radar archive, station data | Daily | High — academic-grade, used by NWS |

**Total infrastructure cost:** $0 per month. All free, government-operated or academic.

## 4.3 Architecture Overview

The architecture is daily batch ingestion to Supabase storm_events tables, which are then queried by signal triggering, page generation, and module binding logic. No external API calls during page render.

## 4.4 Ingestion Pipelines

### CRON-WX-01: Daily Recent Events (2 AM UTC)

Sources pulled:

1. NOAA SPC Storm Reports (tornado, hail, wind)
2. NWS Active Alerts API (watches, warnings, advisories)
3. Iowa Mesonet Recent Hail Swaths (MRMS maximum estimated hail size product)

Processing: Pull last 48 hours (24-hour overlap for fault tolerance), geocode all reports to nearest city and zip, upsert into `storm_events` table with `data_source`, `event_external_id`, `confidence_level`. Idempotent: same event re-ingested updates if confidence improved.

Estimated runtime: 2-5 minutes per night. Estimated cost: <$0.01 per day.

### CRON-WX-02: Monthly Authoritative Backfill (1st of month, 3 AM UTC)

Source: NOAA Storm Events Database (bulk CSV, lags 30-90 days).

Processing: Download most recent month's authoritative file. Cross-reference with `storm_events`. For preliminary SPC events that match: upgrade `confidence_level` to `authoritative`. For new events not previously captured: insert with `confidence_level=authoritative`.

Estimated runtime: 30-60 minutes monthly. Estimated cost: <$0.10 per month.

### CRON-WX-03: Quarterly Historical Backfill Audit

Purpose: Catch any gaps from infrastructure failures or NOAA late corrections.

Processing: Sample 5% of `storm_events` rows from last 12 months. Re-query NOAA. Flag discrepancies for operator review.

### CRON-WX-04: Storm-to-Client Signal Triggering (Every 30 min)

Purpose: When a new storm event is ingested, alert affected clients via Command Center.

Processing:

1. Query `storm_events` inserted/updated in last 35 minutes
2. For each new event, query `client_storm_subscriptions` for clients with overlapping service area
3. For each matched client:
   - Insert `tenant_signal` with type `storm_event_in_service_area`
   - Priority by storm severity:
     - **P0:** Tornado EF2+, hurricane, hail ≥2", wind ≥80mph
     - **P1:** Tornado EF0-1, hail 1-2", wind 60-79mph
     - **P2:** Hail 0.75-1", severe thunderstorm warning
   - Tier-gated auto-generation:
     - Starter / Growth: manual operator approval required
     - Authority / Dominance: auto-generates post-storm urgency pages for affected cities

## 4.5 Initial Backfill

Before Phase 1 launch, one-time historical backfill required:

- 10 years of NOAA Storm Events Database (2016-2026)
- Coverage: Continental US, prioritized to states where Tarritrix expects clients
- Estimated row count: approximately 5-10 million events
- Storage: approximately 3-5 GB in Supabase (within Pro tier 8GB allowance)
- Runtime: 8-12 hours one-time download plus import

This backfill runs once before launch. After that, monthly CRON-WX-02 keeps it current. Required for: Multi-Decade Authority template, Hail Specialist template, hurricane history modules, and A-05 Gate 10 storm reference authenticity.

## 4.6 Geographic Indexing Strategy

PostGIS required. Spatial indexes on `storm_events.event_location` (point) and `event_polygon` (hail swaths, tornado paths). Service area polygons on `clients.service_area_polygon`. Sub-100ms query performance for "storms within 50km of city, last N years."

## 4.7 Module Data Binding

When A-02 generates a page using a Pool A (storm visualization) module, it queries `storm_events` for that module's data needs. Every module that displays storm data has a defined query template. Modules cache their data per page generation; pages do not re-query on render.

## 4.8 Failure Modes

**Source unavailable:** CRON job retries with exponential backoff. After 3 failures: operator signal raised. Daily ingestion gap of 1-2 days does not break page generation (Pool A modules use last 5 years of data).

**Bad data:** Validation step before insert. Malformed rows logged. Operator review queue.

**Geocoding failures:** Event still ingested with raw coordinates. Modules that work with raw coordinates render; city-level modules exclude these.

## 4.9 Acceptance Criteria

1. CRON-WX-01 successfully ingests 24h of SPC + NWS + Mesonet data daily
2. CRON-WX-02 successfully ingests monthly NOAA authoritative backfill
3. 10-year backfill complete for continental US
4. Geographic queries return <100ms for "storms within 50km of city, last 5 years"
5. Pool A modules render with real NOAA data for 10 test cities across different climate zones
6. A-05 Gate 10 blocks pages with unverifiable storm claims
7. CRON-WX-04 successfully raises tenant_signals when test storm event ingested
8. Total infrastructure cost <$50/month at 1000 clients

---

# Section 5: Multi-Provider LLM Routing Architecture

**Phase:** 1 Mandatory

## 5.1 Mission

Tarritrix must not be locked into a single LLM vendor. Cost optimization across providers cuts spend approximately 30-50%. Failover protects against vendor outages. Operator control via Command Center allows tuning per-client based on quality observation.

## 5.2 Supported Providers (Phase 1)

| Provider | Models | Use Cases |
|----------|--------|-----------|
| Anthropic | Claude Opus 4.7, Sonnet 4.7, Haiku 4.5 | Default for all tiers |
| OpenAI | GPT-4o, GPT-4o-mini | Fallback |
| Google | Gemini 2.5 Pro, Gemini 2.5 Flash | Fallback |

## 5.3 The Routing Layer

A central `LLMRouter` service handles every LLM call. No agent calls a provider directly.

Inputs: task_type, client_id, tier_requested, estimated_tokens.

Routing logic:

1. Check per-client override (`clients.llm_provider_override` if set)
2. Check task-type default mapping (`llm_routing_config` table)
3. Check provider health status
4. Check daily cost cap status (per-client + platform-wide + per-provider)
5. Select provider plus model
6. Execute call with retry and circuit breaker
7. Log to `llm_calls` table with cost, duration, success
8. On failure: cascade to fallback provider

## 5.4 Cost Governance (Contract 7 Enforcement)

### Per-Client Daily Cost Cap

Every LLM call goes through `checkCostBeforeCall(client_id, estimated_cost_usd)`. Uses `pg_advisory_xact_lock` to prevent race conditions.

Cap exceeded behavior:

- Call rejected before LLM API is hit (zero waste)
- `tenant_signal` raised with priority P0
- All pending pages for this client paused
- Operator notified in Command Center with one-click "Increase cap" or "Wait until tomorrow" actions

### Platform-Wide Daily Cost Cap

Default $500 per day. Same rejection behavior at platform scope.

### Per-Provider Daily Spend Limits

Prevent single-vendor concentration risk. Approaching cap shifts traffic to alternates. Cap hit fully shifts to alternates for rest of day.

## 5.5 Provider Health Monitoring

**Active health checks:** Every 5 minutes, simple test prompt to each provider. Records latency plus success/failure.

**Passive failure tracking:** Every LLM call's failure recorded. Rolling failure rate per provider over last 100 calls. Status: healthy / degraded / unhealthy.

## 5.6 Circuit Breaker Pattern

Per-provider circuit breakers prevent cascading failures. 5 consecutive failures opens the circuit with 60s cooldown. On open: cascade to next fallback provider.

## 5.7 Operator Command Center Integration

New section: LLM Provider Control Panel.

**Live status dashboard:**

- Per-provider: health, latency, daily spend, daily call count, failure rate
- Platform totals: today's spend, this month's spend, projected month-end
- Top 10 clients by daily spend
- Cap utilization gauges

**Configuration controls:**

- Default provider per task type
- Fallback chain per task type
- Per-client override
- Per-task-type model selection
- Daily cost caps

**Action controls:**

- "Pause all LLM calls" — emergency halt
- "Pause provider X" — disable specific provider
- "Increase client X's cap to $Y" — one-click cap adjustment
- "Test current routing" — runs sample call, shows path

**Audit log:** Every provider override, every cost cap change, every emergency pause logged with operator_id, justification, timestamp.

## 5.8 Cost Projections at Scale

Using Section 1.4 model routing:

**Per-Dominance-client annual LLM cost (500 pages):**

- Initial generation: approximately $43.45
- Refreshes (4x per year, Haiku): approximately $30
- A-21 onboarding ingestion: approximately $0.40
- A-05 validation per page: approximately $0.03 × 500 = $15
- Multi-provider routing overhead: negligible
- **Total:** approximately $89 per year per Dominance client

At $41,964 annual revenue: **LLM cost is 0.21% of revenue.** Healthy.

**Per-Authority-client annual LLM cost (200 pages):** approximately $48 per year, 0.20% of $23,964 revenue.

**Per-Growth-client annual LLM cost (100 pages):** approximately $24 per year, 0.20% of $11,964 revenue.

**Per-Starter-client annual LLM cost (50 pages):** approximately $12 per year, 0.20% of $5,964 revenue.

**Margin protection:** LLM costs scale linearly with page count, which scales with tier price. Margins protected at every tier.

## 5.9 Acceptance Criteria

LLM Routing ships when:

1. All three providers (Anthropic, OpenAI, Google) integrated with unified interface
2. Cost guard (Contract 7) enforced via advisory lock — verified by load test
3. Per-client + platform-wide + per-provider caps enforceable
4. Circuit breakers tested with simulated provider failures
5. Operator Command Center LLM Control Panel functional
6. Daily cost reports accurate (within $0.01)
7. Per-client override functional
8. Routing config table seeded with sensible defaults
9. Cost projections validated against test page generation

---

# Section 6: A-20 Multi-Tenant Page Hosting (Mode C / DNS-Routed)

**Phase:** 1 Mandatory — load-bearing spine of production deployment

## 6.1 Mission

Every Tarritrix-generated page must render at the client's own domain (e.g., `https://dallasroofingcompany.com/locations/dallas-tx/hail-damage-roof-repair`) with full SEO authority accruing to the client's domain, while Tarritrix infrastructure controls the rendering, content updates, schema, internal linking, and quality enforcement.

## 6.2 The Architecture in Plain Terms

**The user's browser:**

- Types `dallasroofingcompany.com/locations/dallas-tx/hail-damage-roof-repair`
- Browser performs DNS lookup for `dallasroofingcompany.com`
- DNS resolves to Tarritrix's Vercel infrastructure for that specific path
- Vercel routes the request to Tarritrix's Next.js application
- Tarritrix middleware reads the `Host` header
- Middleware looks up `client_id` from `clients.custom_domain` index
- Page renders with the client's brand signature, modules, and content
- Browser sees the URL `dallasroofingcompany.com/locations/...` throughout

**The client's primary website** (homepage, about, contact, etc.) remains untouched on their existing hosting. Tarritrix only serves the `/locations/*` path tree.

**Google's crawler:**

- Discovers pages via the client's sitemap (which Tarritrix generates and submits)
- Crawls pages at `dallasroofingcompany.com/locations/...`
- Sees the URL, sees the content, attributes ranking and authority to `dallasroofingcompany.com`
- Tarritrix infrastructure is invisible to SEO

## 6.3 DNS Configuration Strategies

### Method A: Path-Based Reverse Proxy (Preferred)

Used when client's hosting platform supports custom path routing rules (Cloudflare, AWS Route 53 with CloudFront, Netlify, modern enterprise DNS).

Configuration: Client adds a path-based proxy rule: `/locations/*` → `tarritrix-edge.vercel.app`. DNS otherwise unchanged. Client's primary website continues serving from current host for all other paths.

Pros: Cleanest. No DNS delegation. Client retains full control of their domain.
Cons: Requires modern DNS provider.

### Method B: Subdomain CNAME

Used when Method A unavailable but client can create a subdomain.

Configuration: Client creates subdomain CNAME: `locations.dallasroofingcompany.com` → `cname.tarritrix.com`. Pages live at `locations.dallasroofingcompany.com/dallas-tx/hail-damage-roof-repair`. SEO authority still accrues to parent domain.

### Method C: Full DNS Delegation

Used when client willing to delegate entire domain to Tarritrix's nameservers. Maximum control, full SEO benefit, requires high trust. Rare scenario. Dominance tier with operator-led setup.

### Method D: Tarritrix Subdomain (Fallback)

Used when client's hosting platform blocks all three methods.

Configuration: Pages live at `{client-slug}.tarritrix.com/locations/...`. SEO authority accrues to `tarritrix.com`, not the client (suboptimal). Acknowledged in client agreement.

Recommended client conversation: "If your hosting doesn't support Method A or B, we strongly recommend switching to a modern DNS provider (Cloudflare is free) to unlock the full SEO benefit."

## 6.4 Vercel Routing Configuration

Single Next.js application handles multiple client domains. Multiple custom domains added to project per client. Wildcard SSL certificates auto-provisioned by Vercel. Edge middleware intercepts all `/locations/*` requests.

Performance budget for middleware: <10ms overhead. Achieved via Redis-cached tenant lookups.

## 6.5 Onboarding Wizard Step 5.5: DNS Setup

UI flow:

1. **Hosting platform detection** — operator selects client's primary hosting from a list. Tarritrix shows the recommended DNS method.
2. **Method selection** — system recommends Method A, B, or D. Operator can override.
3. **Configuration instructions** — Tarritrix generates copy-paste-ready instructions specific to client's DNS provider and chosen method.
4. **DNS verification** — Tarritrix polls the client's domain to detect when DNS configuration is live. Auto-retry every 30 seconds for first 10 minutes.
5. **SSL provisioning** — after DNS verification, Vercel auto-provisions wildcard SSL. Typical 1-5 minutes.
6. **End-to-end test** — Tarritrix generates a single test page at the client's domain. Verifies 200 status, correct tenant resolution, SSL active, render time <2s.

## 6.6 Sitemap and Indexation Strategy

A-07 Sitemap Generator outputs `sitemap.xml` at the client's domain.

Location: `https://dallasroofingcompany.com/locations/sitemap.xml`. Standard XML sitemap with all `/locations/*` URLs. Updated when pages publish or change.

Submission to Google Search Console via API. A-08 Indexation Tracker polls GSC for coverage report.

## 6.7 Cache Strategy

Per-page caching at the edge:

- Cache-Control: `public, s-maxage=86400, stale-while-revalidate=604800`
- Pages cached at Vercel edge for 24 hours
- Stale-while-revalidate allows serving slightly-stale content for up to 7 days while regeneration happens in background

Cache purge on page update via Vercel API call. Cache purge typically propagates globally in <30 seconds.

Cost impact: With aggressive caching, 99%+ requests served from edge at near-zero marginal cost. Vercel Pro $20/mo includes 1M function invocations plus unlimited static edge serving.

## 6.8 Tenant Resolution Cache (3-Layer)

- Layer 1: Edge in-memory LRU cache, 5000 entries, 60s TTL, ~0.1ms lookup
- Layer 2: Upstash Redis, 24h TTL, ~3-5ms lookup
- Layer 3: Supabase `clients.custom_domain` index, ~10-20ms warm

## 6.9 SSL/TLS

Automatic provisioning via Vercel Let's Encrypt. Wildcard certs for Method B. Automated renewal. HSTS header added by middleware for all `/locations/*` responses.

## 6.10 Operator Visibility — Command Center DNS Status Panel

Per-client display:

- Custom domain
- DNS method (A/B/C/D)
- DNS verification status
- Last DNS check timestamp
- SSL status
- Number of pages deployed
- Cache status summary
- One-click actions: re-verify DNS, purge caches, deploy test page, view logs

Platform-wide health card:

- Total domains configured
- Pending DNS verifications
- SSL provisioning queue
- Cache hit rate (last 24h)
- Edge function P95 latency

## 6.11 Failure Modes

**DNS misconfiguration:** Verification fails. Operator alerted with specific diagnostic. Pages don't publish until DNS verified.

**SSL provisioning timeout:** After 30 minutes operator P1 alert. Manual override option.

**Domain conflict:** Unique constraint blocks at DB level. Operator alerted with conflict resolution flow.

**Vercel platform outage:** All client pages affected. Status page link in Command Center. Operator notifies affected clients.

**Client's primary site goes down:** Tarritrix pages at `/locations/*` continue working independently. This is actually an advantage Tarritrix can highlight.

## 6.12 Acceptance Criteria

A-20 ships when:

1. Tenant resolution middleware operates within 10ms P95 budget under load
2. DNS verification flow tested with at least 5 real DNS providers
3. SSL auto-provisioning verified end-to-end on Vercel
4. Methods A, B, and D fully functional. Method C deferred to Phase 2 if no early Dominance client requires.
5. End-to-end test: real client domain, real DNS config, page renders at client's URL, Google can crawl
6. Cache purge tested (page update → edge cache cleared globally <30s)
7. Operator Command Center DNS status panel functional
8. Onboarding Step 5.5 wizard guides operator through configuration

---

# Section 7: Phase 1 Build Sequencing and Critical Path

**Purpose:** Translate architecture into a dependency-ordered build sequence.

## 7.1 Sequencing Philosophy

Five rules govern the build order:

1. **Foundation before agents.** Shared infrastructure (base agent framework, LLM router, cost guard, logging, error handling) ships before any agent that depends on it.
2. **Data sources before consumers.** Storm intelligence engine ships before A-02 modules that read storm data.
3. **Hosting before publishing.** A-20 ships before any page can be deployed to production.
4. **Validators before generators ship to production.** A-05 must exist when A-02 starts generating pages.
5. **Operator visibility before automation.** Command Center surfaces for monitoring each subsystem ship alongside the subsystem itself.

## 7.2 The Critical Path Build Units

### Foundation Layer (must complete before any agent ships)

- **B1.** Base Agent Framework — abstract BaseAgent class with execute lifecycle, retry primitives, cost guard integration
- **B2.** LLM Router + Multi-Provider Integration — Anthropic, OpenAI, Google adapters, circuit breakers, cost governance
- **B3.** Structured Logging + Sentry Integration — replace console.log with logger, Sentry installed and configured
- **B4.** Centralized Error Handling — APIError class, handleAPIError wrapper, refactor existing routes
- **B5.** Schema Drift Detector + Governance Lint — verify-schema.ts implementation, governance-lint.ts enforcement
- **B6.** RLS Enforcement Testing — verify tenant-isolation.spec.ts against all current and new tables

### Data Foundation Layer

- **D1.** Storm Intelligence Engine — Schema + Initial 10-Year Backfill
- **D2.** Storm Intelligence Engine — Daily/Monthly CRONs (WX-01, WX-02, WX-03, WX-04)
- **D3.** Brand Signature Libraries — seed typography (15), palette (25), archetype (8)
- **D4.** Module Library — Initial 60-90 modules across 8 pools

### Infrastructure Layer

- **I1.** A-20 Multi-Tenant Hosting — middleware, tenant resolution, multi-layer cache
- **I2.** A-20 Vercel Domain Management API Integration
- **I3.** A-20 DNS Verification Workflow + Onboarding Step 5.5 UI
- **I4.** A-20 Sitemap + Robots Integration

### Agent Layer

- **A1.** A-21 Client Site Ingestion + Competitive Analysis
- **A2.** A-01 Intake Processor
- **A3.** A-10 Content Profile Builder
- **A4.** A-02 Page Generator (full differentiation engine)
- **A5.** A-05 Page Validator (15 gates)
- **A6.** A-03 Schema Generator (minimal viable JSON-LD)
- **A7.** A-04 Map Embed Generator (static tiles only — HARD requirement)
- **A8.** A-07 Sitemap Generator
- **A9.** A-08 Indexation Tracker
- **A10.** A-09 Conversion Handler

### CRON / Automation Layer

- **C1.** CRON-01 Drip Publisher
- **C2.** CRON-02 Indexation Runner
- **C3.** Dead-Letter Queue + Retry Logic

### Payment and Onboarding Layer

- **P1.** Stripe Product Correction
- **P2.** Stripe Live Mode Verification (external clock 3-5 days)
- **P3.** Stripe Checkout Flow
- **P4.** Onboarding Wizard (8 steps including Step 5.5 DNS Setup)

### Portal and Operator UI Layer

- **U1.** Client Portal Analytics Dashboard (per-page performance, indexation status, conversion attribution, publishing velocity, quality scores, geographic coverage)
- **U2.** Operator Command Center Extensions (LLM panel, DNS panel, Storm Intelligence panel, Module library management, Brand signature management, Cost monitoring, Dead-letter queue UI, DSAR processing)

### Compliance and Operations Layer

- **O1.** DSAR Workflow (A-12 minimal)
- **O2.** Operator Runbooks (incident response, deployment rollback, DR drill, secret rotation)
- **O3.** Client Offboarding Workflow

## 7.3 Suggested Build Phases Within Phase 1

### Wave 1 — Unblock everything else

B1, B2, B3, B4, B5, B6, P1, P2

### Wave 2 — Data foundations

D1, D2, D3, I1, I2, O2

### Wave 3 — Page generation infrastructure

D4, A1, A2, I3, I4, P3

### Wave 4 — The generators

A3, A4, A5, A6, A7

### Wave 5 — Distribution and observation

A8, A9, A10, C1, C2, C3, O3

### Wave 6 — User-facing surfaces

P4, U1, U2, O1

### Wave 7 — Production hardening

Final E2E test (full customer journey), load testing, manual QA pass, legal page placeholder replacement, credential rotation, first customer onboarding rehearsal.

## 7.4 Parallelization Opportunities

Items that can genuinely parallelize without conflict:

- D3 Brand Libraries + D4 Module Library (different files, no schema conflict)
- D1 Storm Backfill (long-running, runs autonomously)
- B5 Schema Drift Detector + B6 RLS Tests (independent of feature work)
- O2 Runbooks (pure writing, no engineering conflict)
- P2 Stripe Live Mode (external clock, no internal work)
- U2 Command Center panels (per-panel work parallelizes once B2/I1/D1 done)

Items that should NOT parallelize:

- Anything that modifies the same schema migration sequence
- A3 → A4 → A5 (page generation pipeline — each depends on the prior)
- P4 Onboarding Wizard (single coherent UX flow, single-developer ownership)

## 7.5 Hard External Blockers

| Item | External Clock | When to Start |
|------|----------------|---------------|
| Stripe live mode verification | 3-5 days typical | Immediately (Wave 1) |
| GBP API approval | 4-8 weeks | Apply now even though GBP is Phase 1.5+ |
| Google Search Console API access (per client) | 1-2 days per client | When first customer onboards |
| Vercel custom domain limit (50 default) | Request increase if expecting >40 clients fast | Before high-growth phase |
| DNS propagation per client | 1-48 hours | Per-client during Step 5.5 |

## 7.6 The "Day-1 Ready" Gate

A customer cannot be onboarded until ALL of these are green:

1. Stripe live mode active
2. P4 Onboarding Wizard end-to-end functional
3. A-20 DNS verification working for at least 3 different DNS providers
4. A-21 ingests real sites, operator approves output
5. A-02 generates pages passing A-05 validation
6. CRON-01 drips pages on schedule
7. Client portal shows real-time analytics
8. Operator Command Center surfaces operational status
9. DSAR workflow exists
10. Incident response runbook exists
11. Legal placeholder text replaced
12. RLS verified via tenant-isolation suite
13. Production deploy verification script passing
14. First end-to-end rehearsal: synthetic customer through full journey

This is the launch gate. No customer onboarding before all 14.

---

# Section 8: Audit Reconciliation and Phase Triage

**Purpose:** Take CC's 73-finding gap audit and explicitly route every finding.

## 8.1 Triage Categories

Every finding from `GAP_AUDIT_2026-05-14.md` gets one of four dispositions:

- **PHASE 1 (covered)** — addressed by Sections 1-7 of this document
- **PHASE 1.5** — real gap, deferred to post-launch sprint
- **PHASE 2+** — longer horizon
- **REJECTED** — not a real gap, padding, or duplicate

## 8.2 Triage Summary

| Disposition | Count | % of Audit |
|-------------|-------|------------|
| PHASE 1 (covered in Sections 1-7) | 38 | 52% |
| PHASE 1.5 | 7 | 10% |
| PHASE 2+ | 1 | 1% |
| DONE (verified passing) | 2 | 3% |
| REJECTED | 2 | 3% |
| Duplicates removed | 23 | 31% |

CC's "73 findings" deflates to approximately 50 distinct actionable items once duplicates removed. 38 of those become Phase 1 work.

## 8.3 Items Explicitly Rejected

**Sub-Processor List Not Dynamic (Dimension 7.3)** — Cosmetic. Sub-processor list rarely changes. Editing and committing is faster than building a query-based renderer.

**No Code Repository Backup (Dimension 10.2)** — GitHub itself is the backup. Multi-region replication via GitHub is sufficient for solo founder. Mirroring adds operational burden without proportionate risk reduction.

## 8.4 Items Promoted Above Audit's Severity

**A-21 Client Site Ingestion** — CC's audit didn't include A-21 at all. Promoted to Phase 1 mandatory per operator direction (with competitor analysis included from launch).

**A-04 Map Embed static tiles requirement** — Operator-stated P0 requirement (dynamic JS map embeds prohibited). Not in CC's audit.

**Tier-gated auto-generation of post-storm pages** — Authority and Dominance only. Operator-defined business logic.

**Sparse-site Command Center alert** — Operator-stated requirement for A-21 fallback handling.

## 8.5 What Phase 1.5 Looks Like Post-Launch

Once first customer is live and producing real ranking results:

- Module Library Expansion (60-90 → 200+ modules)
- A-18 Job Evidence mobile upload flow
- A-21 quarterly re-scan automation
- TRX-001 self-promotion layer (Tarritrix.com using own platform)
- Comprehensive test coverage push
- Load testing with real traffic patterns
- Secret rotation automation
- Operator handbook for backup operators
- Infrastructure cost monitoring with margin alerting
- Sentry full integration including release tracking
- Quarterly DR restore drills

## 8.6 What Phase 2+ Looks Like (Long Horizon)

- A-19 Integration Hub (JobNimbus, ServiceTitan, Acculynx OAuth)
- A-25 AEO Engine, A-26 AI Citation, A-27 Voice Search
- A-28 Topical Authority Engine (AlsoAsked integration)
- A-30 Claim Recovery Workflow (CSS partnership Xactimate rewrites)
- A-31 Lead Download Engine (ATTOM API + polygon-drawing)
- SOC 2 readiness
- HIPAA-adjacent capabilities for adjacent verticals
- International market support

## 8.7 Final Phase 1 Build Unit Count

**Total Phase 1 build units:** approximately 40

This is the canonical Phase 1 scope. Anything not on this list is Phase 1.5+, deferred until first customer is live and succeeding.

---

# Section 9: Performance Learning Engine (A-29) — Phase 2 First-Class Agent, Compounding Moat

**Phase:** A-29 itself is Phase 2. Data preparation tables are Phase 1.
**Status:** Canonical specification

## 9.1 Mission

A-29 is the compounding moat. It is what turns Tarritrix from "platform that publishes good pages" into "platform that gets exponentially better at publishing good pages with every customer it serves."

A-29 ingests real-world performance data (rankings, traffic, engagement, conversion) from every page across every client, correlates that performance with the structural decisions A-02 made when generating each page (brand signature components, module selection, composition recipe, page-type template, LLM model, perspective rotation, length bucket, hero treatment), and surfaces statistically meaningful findings to the operator. With operator approval (or auto-apply opt-in for high-confidence findings), A-29 feeds learned weights back into A-02's selection logic.

**Bar:** Every client onboarded after the platform reaches data-significance threshold benefits from every prior client's performance lessons, without anyone having to manually copy what worked.

## 9.2 Architecture: Correlation Analysis + Human-in-the-Loop

A-29 uses Archetype 1 (correlation analysis with human-in-the-loop), not autonomous reinforcement learning.

Rejected alternative: autonomous RL agent that auto-adjusts A-02 selection weights without operator approval. Rejected because:

- Explainability matters to clients. When a client asks "why did my page change?" we need a defensible answer.
- A wrong objective function compounds damage fast.
- Solo founder, no compliance team — autonomous content modification creates audit exposure.
- Autonomy can be earned later via per-finding auto-apply opt-in. The agent earns trust over time.

## 9.3 Phase Placement and Data Preparation

**A-29 itself: Phase 2.**

**A-29 prerequisites in Phase 1 (data preparation, added to Migration 005):**

1. `page_performance_daily` table — daily per-page metrics from GA4, GSC, conversion tracking
2. `page_structural_variants` table — every structural decision A-02 made per page
3. `conversions` ALTER — adds page_id, structural_variant_id, attribution columns
4. GA4 ingestion adapter — Phase 1.5 (after first customer has GA4 connected)
5. GSC ingestion adapter — Phase 1.5 (after first customer's GSC connected)

Phase 1 cost: approximately 2-3 hours of work. Buys approximately 6 months of historical data by the time A-29 lands in Phase 2.

**Data significance threshold for A-29 findings:** approximately 20+ clients × 90+ days of data, or approximately 1,000 pages with 30+ days of performance signal. Below this threshold, A-29 ingests and stores data but does not produce findings (avoids spurious correlations from small samples).

## 9.4 The Five Functions

### Function 1 — Performance Data Ingestion

Daily CRON pulls per-page metrics:

- **GSC:** impressions, clicks, CTR, average position, top 10 ranking queries, mobile/desktop split
- **GA4:** pageviews, unique visitors, sessions, bounce rate, engagement rate, average engagement time, scroll depth (25%, 50%, 75%, 100%), source/medium/campaign attribution
- **Internal conversion tracking:** form submissions, phone clicks, email clicks, CTA clicks, time-to-conversion, multi-touch attribution (first-touch, last-touch, linear)
- **A-08 Indexation Tracker:** indexation status changes, coverage issues, sitemap submission status

All metrics stored in `page_performance_daily` partitioned by month for query performance.

### Function 2 — Structural Variant Tracking

Every page A-02 generates records its complete structural signature in `page_structural_variants` at generation time:

- Brand signature components: typography_id, palette_id, archetype_id, voice_register, layout_density, photo_treatment
- Page generation decisions: page_type_template_id, composition_recipe_id, module_ids (ordered array), hero_treatment, cta_placement, internal_link_pattern, image_to_text_ratio
- LLM decisions: llm_provider, llm_model, perspective_rotation, length_bucket
- Realized output: word_count_actual, image_count_actual, validation_attempts
- Reference fields: dma_code, service_vertical

This is the experimental record. Without it, A-29 has performance data but cannot correlate it to anything actionable. **This is the load-bearing Phase 1 data preparation.**

### Function 3 — Correlation Analysis (The Core Engine)

A-29 runs weekly correlation analyses (and on-demand). Statistical methods, NOT ML model training:

- Chi-squared tests for categorical correlations (template, archetype)
- Welch's t-test for comparing means across two groups (CTR with module X vs. without)
- Pearson and Spearman correlation for continuous variables (word count vs. engagement time)
- Multivariate regression for controlling confounders (client domain authority, DMA, service vertical)
- Bonferroni correction for multiple testing (A-29 runs hundreds of comparisons; p-value adjustment prevents false positives)

**Minimum thresholds for surfacing a finding:**

- Sample size: n ≥ 100 pages per condition being compared
- Statistical significance: p < 0.05 after Bonferroni correction
- Effect size: Cohen's d ≥ 0.2 (small effect minimum), or relative effect ≥ 10%
- Stability: finding must replicate across at least 2 consecutive analysis runs

**Example findings A-29 produces:**

- "Across 47 hail-specialist clients in Tornado Alley DMAs, pages using Bloomberg-terminal archetype convert 31% better than Patagonia-documentary archetype (p<0.01, n=2,847)."
- "Pool A 'pulsing storm marker' modules convert 23% better than 'heatmap density overlay' modules on post-storm urgency pages in active-storm DMAs (p<0.01, n=1,203)."
- "Standard tier pages generated by Haiku 4.5 at 1200-1500 words convert at 94% of the rate of Sonnet 4.7-generated pages at same length, while costing 18% as much. Recommend default to Haiku for 1200-1500 word standard tier pages."
- **Negative finding:** "Pages over 3,000 words show no statistically significant improvement in conversion or rankings vs. 1,500-2,500 words. Long-form not earning generation cost on standard tier."

### Function 4 — Operator-Surfaced Findings Dashboard

Each finding appears in Command Center A-29 Performance Insights panel with: insight, confidence (p-value), sample size, effect size with 95% CI, recommended action, predicted impact (e.g., "~127 additional conversions per quarter platform-wide").

**Operator actions:**

- **Approve & Apply:** writes weight changes to A-02's selection config
- **Approve & Auto-Apply Future Similar:** same as approve, plus this category of finding auto-applies in future. Earns autonomy through demonstrated trust.
- **Defer:** revisit later
- **Reject With Reason:** records rejection to refine future finding generation

Full audit logging via `a29_findings` table.

### Function 5 — Feedback Loop Into A-02

Approved findings write to:

- `module_selection_weights` (module-level findings)
- `composition_recipe_weights` (recipe-level findings)
- `template_selection_weights` (page-type template findings)
- `brand_signature_weights` (advisory only — does NOT override locked client signatures, per Contract 40)

A-02 reads these weights at page generation time as input to its selection logic.

Weights can be:
- Operator-revoked manually
- Auto-expired by TTL (default 180 days)
- Auto-superseded when A-29 produces a contradicting finding with stronger evidence
- Per-client overridden (some clients may want specific weights regardless of platform learning)

## 9.5 Explicit Non-Goals

- A-29 does NOT change client brand signatures (Contract 40 supersedes — signatures locked at onboarding)
- A-29 does NOT autonomously regenerate existing pages. It surfaces "this page might benefit from regeneration." Operator decides whether to trigger A-11.
- A-29 does NOT optimize for engagement metrics that conflict with business outcomes. Configured objective is conversions and qualified leads, not raw clicks or time-on-page.
- A-29 does NOT run findings on individual clients with insufficient data. Single-client patterns are anecdotes, not findings.
- A-29 does NOT bypass A-05. Any pages generated using A-29-influenced weights still pass all 15 A-05 gates.

## 9.6 Technical Architecture and Cost

Correlation analysis runs as weekly Vercel CRON or Supabase Edge Function. Estimated compute: 2-10 minutes per run. GA4 + GSC APIs free at moderate volumes. Per-client OAuth (not platform-wide quotas).

**Total A-29 operational cost:** <$5/month at 100 clients, <$50/month at 1,000 clients.

Scaling: `page_performance_daily` partitioning by month keeps query performance constant. Aggregate stats not row scans — scales sub-linearly with row count. Findings older than 180 days auto-archived.

## 9.7 Future-Phase Extensions

Scoped but not committed:

- **A-29.1 A/B Testing Infrastructure (Phase 2.5):** when A-29 has uncertainty between two findings, auto-generate two variants of similar pages and ship both. Measure difference. Update findings based on direct experiment.
- **A-29.2 Per-Client Performance Insights (Phase 3):** surface client-specific findings in client portal ("your pages with X module convert 15% better than your pages with Y module"). Retention driver.
- **A-29.3 Predictive Scoring (Phase 3):** before publishing, A-29 scores each page's predicted performance. Low-scoring pages flagged for operator review.
- **A-29.4 Anomaly Detection (Phase 3):** A-29 notices when a previously high-performing page suddenly drops. Alerts operator: "Page X conversion dropped 40% week-over-week, possibly algorithm change or competitor activity."
- **A-29.5 Cross-Vertical Learning (Phase 4):** if Tarritrix expands beyond roofing/PDR, A-29 finds which learnings transfer across verticals.

## 9.8 Acceptance Criteria (A-29 Phase 2 Build)

A-29 ships when:

1. Daily CRON ingests GA4 + GSC + conversion data for all connected clients
2. Every page generated by A-02 records full structural variant
3. Weekly correlation analysis runs without manual intervention
4. Findings meet all significance thresholds (p<0.05 post-Bonferroni, d≥0.2, n≥100)
5. Operator Performance Insights panel displays findings with full context
6. Approve/Reject/Defer/Auto-Apply workflow functional with full audit logging
7. Approved findings write to weight tables; A-02 reads at generation time
8. Per-finding auto-apply rules functional
9. Weight expiration and supersession logic functional
10. Manual test: inject synthetic performance data with known correlation, verify A-29 detects it
11. Manual test: inject random noise, verify A-29 does NOT produce false findings
12. Cost per month: <$50 at 100 clients, <$100 at 1,000 clients
13. Per-client overrides functional (clients can opt out of platform learnings)

---

# Appendix: New Contract Additions

Seven new contracts added to BEHAVIORAL_CONTRACTS.md:

### Contract 38: Real-Data Binding (HARD)

Every numerical or factual claim in any A-02 generated page MUST trace to a `data_source` row via `page_claim_provenance`. A-05 Gate 1 enforces. Override forbidden. Pages with untraced facts do not publish under any circumstance.

### Contract 39: Storm Reference Authenticity (HARD)

Every storm event referenced in page text MUST link to a `noaa_event_id` in `storm_events`. A-05 Gate 10 enforces. Override forbidden. Fabricated storm dates or events constitute critical violation.

### Contract 40: DMA Diversity Enforcement

No two clients in the same DMA may share identical brand signatures. No module may be used by more than 30% of clients within a single DMA. A-21 and A-02 enforce. Violation triggers operator review queue.

### Contract 41: LLM Cost Governance

All LLM calls route through LLMRouter. No direct provider SDK calls outside the router. Cost cap check via `pg_advisory_xact_lock` mandatory before every call. Per-client + platform + per-provider caps enforceable. Contract 7 superseded by Contract 41 with concrete enforcement mechanism.

### Contract 42: Multi-Tenant Hosting (A-20)

No client onboarding may complete (Step 8 of wizard) until A-20 DNS verification passes for that client (Method A, B, C, or operator-acknowledged Method D fallback). Pages may not deploy until SSL provisioned and end-to-end test renders successfully.

### Contract 43: Module Library Authority

Module library is the authoritative source of all page components. A-02 may not render content outside the library's modules. New modules added only via versioned `module_library` table entries with full test coverage. Forking or hardcoding modules outside the library is a critical violation.

### Contract 44: Performance Learning Authority (A-29)

A-29 may produce findings and recommend weight changes, but may NOT autonomously modify A-02's selection logic without explicit operator approval — except where the operator has pre-authorized auto-apply via `a29_finding_auto_apply_rules`. Findings below significance thresholds (p ≥ 0.05 after Bonferroni correction, effect size < 0.2, sample size < 100) may not be surfaced as actionable findings. A-29 may not produce findings about individual clients (single-client patterns are anecdotes, not findings) — all findings require platform-level sample sizes. A-29 may not modify locked client brand signatures (Contract 40 supersedes).

### Contract 45: Review Authenticity (HARD)

Added 2026-05-15 commit de3ba5e. Enforces FTC 16 CFR Part 255 compliance on A-14 Review Request Workflow. Prohibits: (1) pre-written review text for one-click approval, (2) incentives tied to reviews, (3) Yelp solicitation, (4) fabricated jobs or customer identities, (5) review filtering by sentiment before invitation. Override forbidden. Violations expose Tarritrix and clients to platform bans, FTC enforcement, and civil liability.

### Contract 46: Verification Mandate (HIGHEST PRIORITY, NON-NEGOTIABLE)

Added 2026-05-15 commit 433b8fb. NEVER infer, guess, improvise, fabricate, or assume without direct verification against canonical files. Canonical files are the single source of truth: BLUEPRINT.md, MASTER_BUILD_SPEC.md, SCHEMA_REGISTRY.md, BEHAVIORAL_CONTRACTS.md, AGENTS.md, STATE_OF_THE_BUILD.md, PROMPT_EXECUTION_SEQUENCE.md, live Supabase schema, live git repository state. Chat memory and conversation history are NOT canonical. This contract supersedes all other contracts when in conflict. Violation invalidates all work product in that session.

### Contract 47: Canonical File Precedence

Added 2026-05-15 commit 433b8fb. Resolution rules when canonical files contradict each other: (1) most recent section within a single file wins, (2) versioned files take precedence over unversioned references, (3) operator-confirmed decisions logged in STATE_OF_THE_BUILD.md SESSION LOG entries take precedence over older canonical text, (4) when precedence is ambiguous, session must stop and surface the contradiction to operator. Contradictions must be resolved by removing the older or rejected version entirely from canonical files, not by leaving both in place.

### Contract 48: No Partial Completion Claims

Added 2026-05-15 commit 433b8fb. Acceptable states: COMPLETE / INCOMPLETE WITH EXPLICIT BLOCKER / NOT STARTED. Prohibited phrases: "mostly complete", "complete except for X", "tests passing, X mock issues to address in follow-up", "shipped with minor cleanup remaining", "feature complete, awaiting polish". If a feature is not 100% complete by its acceptance criteria, the session report must state INCOMPLETE and name the blocker. Burying failures inside completion language is a Contract 48 violation.

### Contract 49: State of the Build as Single Source of Truth

Added 2026-05-15 commit 433b8fb. STATE_OF_THE_BUILD.md is the authoritative current build state document. Every session must: (1) read STATE_OF_THE_BUILD.md at session start, (2) update STATE_OF_THE_BUILD.md before any commit per Contract 37, (3) verify STATE_OF_THE_BUILD.md aligns with git log and live Supabase before work begins, (4) stop and reconcile if STATE_OF_THE_BUILD.md contradicts git or Supabase reality. Any claim about current build state must reference STATE_OF_THE_BUILD.md.

### Contract 50: Architectural Decision Durability

Added 2026-05-15 commit 433b8fb. Every architectural decision approved in operator-Claude chat must be committed to the appropriate canonical file (BLUEPRINT.md, SCHEMA_REGISTRY.md, BEHAVIORAL_CONTRACTS.md, AGENTS.md) within the same session in which it was approved. No decision is considered ratified until it appears in a committed canonical file. Chat memory and operator memory are not substitutes for canonical file commits. Bridge documents (PENDING_*.md transient files) are not acceptable substitutes. This contract directly prevents the failure pattern that killed prior Tarritrix build attempts: architectural decisions evaporating between sessions because they were never durably documented.

---

**Governance Note:** Contracts 46-50 form the anti-drift governance suite installed 2026-05-15 in response to cumulative drift identified in the architectural audit. These supersede looser interpretations of earlier contracts. Contract 46 (Verification Mandate) is the highest-priority contract in the entire system and supersedes all other contracts when in conflict.

---

**End of Architecture Document.**
