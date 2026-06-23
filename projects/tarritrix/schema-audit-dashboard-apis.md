# Schema Audit: Dashboard API Column References

**Date:** 2026-05-13
**Scope:** All API routes in `src/app/api/dashboard/*`
**Purpose:** Verify all column references against SCHEMA_REGISTRY.md

## Tables Queried

### 1. clients
**Queried in:** stats, activity-feed, signals, charts

**Columns referenced:**
- `id` - ✅ Verified exists
- `tier` - ✅ Verified exists  
- `status` - ✅ Verified exists
- `business_name` - ✅ Verified exists (via JOIN)
- `llm_daily_cost_cap` - ✅ Verified exists
- `client_id` (FK reference) - ✅ Verified exists

**Notes:** All references verified against schema.

---

### 2. pricing_tiers
**Queried in:** stats

**Columns referenced:**
- `name` - ✅ Verified exists
- `publish_phase1` - ✅ Verified exists
- `publish_phase2` - ✅ Verified exists
- `publish_phase3` - ✅ Verified exists

**Notes:** All references verified.

---

### 3. pages
**Queried in:** stats, charts

**Columns referenced:**
- `id` - ✅ Verified exists
- `published_at` - ✅ Verified exists
- `client_id` - ✅ Verified exists (FK)

**Notes:** All references verified.

---

### 4. agent_events
**Queried in:** stats, activity-feed, charts

**Columns referenced:**
- `id` - ✅ Verified exists
- `created_at` - ✅ Verified exists
- `cost_usd` - ✅ Verified exists
- `agent` - ✅ Verified exists (FIXED from agent_name)
- `client_id` - ✅ Verified exists (FK)
- `event_type` - ✅ Verified exists
- `payload` - ✅ Verified exists
- `error_message` - ✅ Verified exists

**Notes:** 
- Originally referenced `agent_name` (does not exist)
- **FIXED** to use `agent` column (enum type)
- Originally referenced `severity` (does not exist)  
- **REMOVED** severity filter (no such column)

---

### 5. subscriptions
**Queried in:** stats

**Columns referenced:**
- `stripe_price_id` - ✅ Verified exists
- `status` - ✅ Verified exists

**Notes:** All references verified.

---

### 6. tenant_signals
**Queried in:** stats, signals, signals/[id]/dismiss

**Columns referenced:**
- `id` - ✅ Verified exists
- `client_id` - ✅ Verified exists (FK)
- `priority` - ✅ Verified exists (FIXED from severity)
- `signal_type` - ✅ Verified exists
- `title` - ✅ Verified exists
- `message` - ✅ Verified exists
- `recommended_action` - ✅ Verified exists
- `target_url` - ✅ Verified exists
- `dismissed_at` - ✅ Verified exists
- `created_at` - ✅ Verified exists

**Notes:**
- Originally referenced `severity` (does not exist)
- **FIXED** to use `priority` column (P0/P1/P2/P3)

---

## Issues Found & Fixed

1. **agent_events.agent_name** → **FIXED** to `agent`
2. **agent_events.severity** → **REMOVED** (column doesn't exist)
3. **tenant_signals.severity** → **FIXED** to `priority`

## Current Status

✅ All column references now match SCHEMA_REGISTRY.md
✅ All queries tested and working
✅ No fabricated column names remain

## Next Steps

- Monitor dev server logs for any PostgreSQL "column does not exist" errors
- When new tables/columns are added, update this audit
- Consider creating a linter rule to validate column names against schema
