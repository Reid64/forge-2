# Google Business Profile API - Access Application

## Submit at: https://developers.google.com/my-business/content/prereqs

**Last updated:** 2026-05-09 (four-tier expansion + Storm Intelligence Engine + Roofing/PDR/Solar/Storm Restoration trade scope)

---

## Application Form Responses

### Company Name
TARRITRIX LLC

### Company Website
https://tarritrix.com

### Application Type
Business Profile API (Read + Write Access)

### Business Model Description
Tarritrix is a closed-platform SaaS providing programmatic local SEO services to storm-driven home service contractors - specifically roofing, paintless dent repair (PDR), solar, and storm restoration verticals. We onboard clients through a manual operator-controlled process - no self-service signup. Each client signs an explicit Google Business Profile Management Authorization during onboarding (Step 5 of our 8-step wizard), granting Tarritrix the right to manage their GBP on their behalf via the API.

Each client maintains their own Google Cloud Project (per Google's third-party policy requirements). Tarritrix accesses each client's GBP through OAuth-authorized credentials scoped to that client's project. We do not share API keys across clients.

The platform launches with four subscription tiers (Starter $497/mo, Growth $997/mo, Authority $1,997/mo, Dominance $3,497/mo) targeting single-operator and multi-location storm-vertical contractors. Storm event detection is powered by our Storm Intelligence Engine (NOAA + Iowa Mesonet ingestion), which triggers programmatic page generation in confirmed hail/wind/storm impact zones.

### Use Case Description
We use the Business Profile API to deliver three categories of value to authorized clients:

1. **Suspension Prevention.** Our A-12 GBP Agent monitors edit velocity (rate-limited to prevent triggering Google's suspicious activity detection), monitors for unauthorized public edits from competitors (auto-rejecting where the API permits), and continuously scores profile completeness across business info, services, attributes, photos, posts, Q&A, and description fields.

2. **Profile Optimization.** We auto-populate Q&A entries with industry-specific questions and authoritative answers (Q&A Seed Manager - A-16), generate posts from completed jobs (GBP Post Generator - A-15) with photos and service-location reinforcement, and enforce image category balance across exterior, interior, team, and work photos. Storm-event-driven posts are time-stamped to confirmed weather events.

3. **Review Management.** We assist clients in responding to reviews using LLM-generated drafts that pass through ReviewReplyState moderation pattern detection before being presented to the client for approval. We never auto-post review responses without operator approval.

### Number of Locations Expected
Phase 1: 1-25 locations (single-operator, manual client onboarding)
Phase 1.5 (post-API approval): 25-75 locations
Phase 2 (90-180 days): 100-250 locations
Phase 3 (180+ days): 250-1,000 locations (multi-location Dominance tier accounts)

### API Methods Required
- accounts.locations.get
- accounts.locations.patch
- accounts.locations.list
- accounts.locations.posts.create
- accounts.locations.posts.list
- accounts.locations.posts.delete
- accounts.locations.questions.create
- accounts.locations.questions.list
- accounts.locations.reviews.list
- accounts.locations.reviews.reply.update
- accounts.locations.media.create
- accounts.locations.media.list

### Quota Requirements
Read quota: 10,000 requests/day per project
Write quota: 1,000 requests/day per project
Edit velocity throttling enforced internally - we do not burst.

### Data Storage and Security
- All client OAuth tokens stored encrypted at rest in Supabase Vault
- All API requests logged to immutable agent_events audit table
- Row-Level Security enforced on every multi-tenant table - clients cannot access each other's data
- TCPA-compliant consent capture immutable at database level for all conversion records
- CPRA/GDPR DSAR (Data Subject Access Request) workflow with 45-day response window
- Cross-tenant leak detection runs daily via CRON-02
- Per-client GCP project isolation - no shared credentials

### Authentication Method
OAuth 2.0 with offline access. Refresh tokens stored encrypted per client. Each client authorizes once during onboarding Step 6 (Google Authorization).

### Compliance Acknowledgments
- We agree to comply with Google Business Profile API Terms of Service
- We agree to the User Data Policy
- We will not use API data for any purpose not explicitly authorized by the client
- We will not share API data with third parties without explicit client consent
- We will respond to user data deletion requests within 45 days
- We will display Google attribution where required

### Contact Information
- **Technical Contact:** Reid Whitesides - support@tarritrix.com
- **Business Contact:** Reid Whitesides - support@tarritrix.com
- **Privacy Contact:** privacy@tarritrix.com
- **Legal Contact:** legal@tarritrix.com
- **Compliance Contact:** compliance@tarritrix.com

All contact aliases route to the operator inbox at reid@tarritrix.com (Zoho Mail).

### Operating Entity
- **Legal Entity:** TARRITRIX LLC
- **Mailing Address:** 209 Surecast Drive Suite 107, Burnet, TX 78611, USA
- **Governing Law:** State of Texas, Burnet County
- **Effective Date of Terms:** June 1, 2026

---

## Public Policy URLs

- Privacy Policy: https://tarritrix.com/privacy
- Terms of Service: https://tarritrix.com/terms
- Data Processing Agreement: https://tarritrix.com/dpa
- Sub-Processors List: https://tarritrix.com/sub-processors
- Cookie Policy: https://tarritrix.com/cookies
- TCPA Disclosure: https://tarritrix.com/tcpa-disclosure

---

## After Submission

1. Save the application reference number in LAUNCH_CHECKLIST.md
2. Expect 4-8 week approval timeline
3. Google may request clarifications via email - respond within 7 days
4. Once approved: receive API key + activation email
5. Add to .env.local: GOOGLE_GBP_API_KEY=<approved_key>
6. Add to Vercel: vercel env add GOOGLE_GBP_API_KEY production
7. Set platform_config.enabled = true for 'gbp_agent'
8. Phase 1.5 begins