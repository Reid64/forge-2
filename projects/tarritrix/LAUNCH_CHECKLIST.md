# TARRITRIX 1.0 — LAUNCH CHECKLIST

**Status:** Pre-launch preparation
**Purpose:** Final verification gates before first paying customer onboarded

---

## PRE-LAUNCH CREDENTIAL ROTATION (Phase B Section 10)

Per Contract 33, all credentials rotate before site goes live to public traffic.
Credentials exposed during development sessions must be rotated to prevent unauthorized access.

**Credentials to rotate:**

- [ ] SENTRY_AUTH_TOKEN — exposed via PowerShell echo pipe during Sentry wiring attempt
- [ ] SENTRY_DSN — exposed in same history (DSN is public-safe by design but logged for completeness)
- [ ] Supabase anon publishable key (precautionary rotation)
- [ ] Supabase service_role secret key (precautionary rotation)
- [ ] Supabase PAT (precautionary rotation)
- [ ] Stripe keys: test to live key swap at launch (STRIPE_PUBLISHABLE_KEY, STRIPE_SECRET_KEY)
- [ ] Resend API key (precautionary rotation)
- [ ] Google OAuth Client Secret (precautionary rotation)

**Rotation process:**
1. Operator revokes current values in service provider settings
2. Operator generates new values
3. Operator updates .env.local locally
4. Operator runs `vercel env rm <KEY_NAME> production` then `vercel env add <KEY_NAME> production --value "<new-value>" --yes`
5. Operator clears PowerShell history: `Clear-History`
6. Operator closes and reopens terminal to clear scrollback
7. Operator verifies new keys work by hitting test endpoints

**When to rotate:**
Before first paying customer is onboarded through 8-step wizard. Not before Phase 1 completion, but before production launch.

---

## SENTRY REWIRE (Phase B Section 15)

**Status:** Deferred to Phase 1.5 launch checklist.

**Why deferred:**
Sentry was attempted and removed on 2026-05-07 after 2+ hours of failed wiring (commit e5efb17).
@sentry/wizard claimed completion but instrumentation.ts was missing and next.config.ts was unwrapped.
Pre-launch site has zero customer traffic, so error monitoring provides zero value at current stage.

**Lessons learned for rewire:**
1. Do not trust @sentry/wizard's "complete" message. Verify by hitting test URL and confirming event appears in dashboard.
2. Verify all 6 outputs after running wizard: sentry.client.config.ts, sentry.server.config.ts, sentry.edge.config.ts, instrumentation.ts (Next.js 15+ requires this), withSentryConfig wrapping in next.config.ts, sentry.properties at repo root.
3. Test in production (Vercel) not local dev. Local Windows file locks make dev-time verification unreliable.
4. Use only ONE terminal context (either Cursor integrated OR standalone PowerShell, not both) for full setup-to-verify cycle.

**Phase 1.5 wire-in steps (when first paying customer is signed):**
1. Run `pnpm dlx @sentry/wizard@latest -i nextjs --saas --org hail-intel --project tarritrix-web`
2. After wizard completes, verify all 6 outputs above exist
3. Deploy to Vercel
4. Hit https://tarritrix.com/api/sentry-test (write a fresh test route)
5. Confirm event appears at https://hail-intel.sentry.io/projects/tarritrix-web/ within 30 seconds
6. Only then mark Sentry verified
7. Delete test route, commit
8. Configure Sentry alerts for production-only error notification

**Existing Vercel env vars (reusable on rewire OR rotate per Section 10):**
- NEXT_PUBLIC_SENTRY_DSN
- SENTRY_DSN
- SENTRY_ORG (hail-intel)
- SENTRY_PROJECT (tarritrix-web)
- SENTRY_AUTH_TOKEN

Recommend creating new Sentry project named tarritrix-prod for clean slate.

---

## PHASE 1 EXIT CRITERIA CHECKLIST

See MASTER_BUILD_SPEC.md Section 20 for full checklist. Key pre-launch items:

**Infrastructure:**
- [ ] Credentials rotated per Section 10 above
- [ ] Sentry wired and verified per Section 15 above
- [ ] PostHog tracking verified on published pages
- [ ] Stripe products verified at correct pricing ($497/$997/$1997 monthly)
- [ ] Google Calendar API integration tested end-to-end
- [ ] GBP API application submitted (Phase 1.5 requirement, submit during Phase 1)

**Data Protection:**
- [ ] Zero pages with cosine similarity >0.72 in production
- [ ] TCPA consent immutability trigger verified (cannot UPDATE after INSERT)
- [ ] Tenant isolation tests passing 100% (RLS enforced, no cross-tenant leaks)
- [ ] DSAR handling workflow tested (45-day window enforcement)

**Operational Readiness:**
- [ ] At least 1 active paying client onboarded through all 8 wizard steps
- [ ] All 14 Phase 1 agents tested with real data
- [ ] CRON-01 + CRON-02 verified over 3+ days
- [ ] Recommendations engine producing real Next Best Actions
- [ ] LLM cost cap enforced (no client exceeds $5/day)

**Deployment:**
- [x] All Playwright tests passing (19 E2E tests green as of Phase D greenlight 2026-05-07)
- [x] All vitest tests passing (3 unit tests green as of Phase D greenlight 2026-05-07)
- [ ] Lighthouse score >90 for marketing site
- [ ] GitHub milestone tag: v1.0-phase1-complete

---

## PHASE D GREENLIGHT COMPLETION (2026-05-07)

**Status:** ✅ Complete - All verification gates passing, no open blockers

**Debt resolved:**
1. verify-schema gate: Already passing - NO DRIFT, 54 tables synchronized
2. tenant-isolation E2E tests: Fixed missing env vars in tests/e2e/.env.test, corrected test data to match actual schema

**Verification results (pnpm verify:full):**
- ✅ tsc --noEmit (no type errors)
- ✅ vitest run (3 unit tests passed)
- ✅ verify-env (31 variables validated)
- ✅ governance-lint (no violations)
- ✅ verify-schema (NO DRIFT, 8 critical tables verified in live DB)
- ✅ playwright test (19 E2E tests passed: 13 auth/routing, 6 RLS tenant isolation)

**Production smoke test:**
- ✅ https://tarritrix.com/ - 200
- ✅ https://tarritrix.com/login - 200
- ⚠️ https://tarritrix.com/dashboard - 404 (expected - dashboard routes not yet built per Prompt 7-10)

**Next:** Resume build work (Prompt 7: Operator Command Center Zone 1)


## GBP API APPLICATION
- **Submitted:** 2026-05-09 15:25 CT
- **Case ID:** #9-2027000040781
- **Expected response:** 7-10 business days per Google
- **Submitted with email:** tarritrix@gmail.com
- **Listing status:** Verified (60-day age requirement may trigger rejection-and-resubmit)
- **Project:** tarritrix-gbp (1002147189041)

