# MANUAL MIGRATION APPLICATION REQUIRED

**Migration:** `20260521233500_add_cosine_similarity_function.sql`  
**Status:** Code committed, migration NOT YET APPLIED to database  
**Blocker:** Tests will fail until this migration is applied

## STEPS TO APPLY

### Option 1: Supabase SQL Editor (Recommended)

1. Open Supabase Dashboard: https://supabase.com/dashboard/project/jhiplicikizdpdsguimg
2. Navigate to SQL Editor
3. Copy the contents of `supabase/migrations/20260521233500_add_cosine_similarity_function.sql`
4. Paste into SQL Editor
5. Click "Run"
6. Verify success message

### Option 2: Supabase CLI

```bash
cd supabase
npx supabase db push
```

### Option 3: psql Direct

```bash
psql "postgresql://postgres.jhiplicikizdpdsguimg:[SERVICE_ROLE_KEY]@aws-0-us-west-1.pooler.supabase.com:6543/postgres" < supabase/migrations/20260521233500_add_cosine_similarity_function.sql
```

## VERIFICATION

After applying, run this query to verify the function exists:

```sql
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name = 'calculate_cosine_similarity';
```

Expected result: 1 row with `routine_type = 'FUNCTION'`

Then run the G2 tests:

```bash
pnpm exec playwright test tests/agents/a-05-g2-similarity.spec.ts
```

All 3 test cases should PASS.

## BACKFILL QUERY

After migration applies, run this to check for historical near-duplicates:

```sql
WITH page_pairs AS (
  SELECT
    a.page_id AS page_a,
    b.page_id AS page_b,
    a.client_id,
    calculate_cosine_similarity(a.embedding::jsonb, b.embedding::jsonb) AS distance
  FROM page_embeddings a
  CROSS JOIN page_embeddings b
  WHERE a.client_id = b.client_id
    AND a.page_id < b.page_id
)
SELECT
  client_id,
  page_a,
  page_b,
  (1 - distance) AS similarity
FROM page_pairs
WHERE (1 - distance) > 0.72
ORDER BY similarity DESC
LIMIT 50;
```

Document row count in STATE_OF_THE_BUILD.md.
