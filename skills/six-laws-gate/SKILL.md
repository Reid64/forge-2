# Skill: Six Laws Gate

## When to apply
Before marking ANY feature complete in ANY project (Benavora, TARRITRIX, Hail Intel, Bright Box Homes, AFS, DialStars).

## Procedure
A feature is NOT complete until all six pass. Check in this order — stop at first failure, fix, restart from Law 1.

1. **Schema** — Tables exist in the real production/dev database (not local-only). RLS policies exist and are scoped by `company_id`. Verify via:
```

supabase db diff
supabase migration list

```

2. **API** — Routes exist, enforce auth, derive `company_id` from session (never from client input). Verify by reading the route file directly, not by assuming.

3. **UI** — Real, wired UI exists. No placeholder text, no "Coming Soon," no disabled buttons standing in for functionality.

4. **Data** — UI calls real API endpoints. Zero mock data, zero hardcoded arrays standing in for DB queries. Every list/table on screen must trace to a real query.

5. **Wiring** — Feature is linked in nav. Role permissions correct for all six roles (owner, manager, sales_rep, telemarketer, field_rep, enterprise_admin) where applicable. All buttons/forms persist to DB on submit — verify by triggering the action and checking the DB row changed.

6. **Verification** — A human (Reid) has confirmed the feature in a live browser session. Claude/Cursor self-report of "should work" does not satisfy this law.

## Failure handling
If any law fails: do not proceed to deploy. Fix the specific law that failed, then re-run all six from Law 1 — do not resume from where it failed, because fixes can break earlier laws.

## Output requirement
When this skill is invoked, report pass/fail for all six laws explicitly, one line each, before declaring the feature done.
