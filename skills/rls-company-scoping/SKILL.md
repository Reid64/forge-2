# Skill: RLS Company Scoping

## When to apply
Any time a new table is created, or an existing table is modified, in any Supabase project (Hail Intel, Benavora, TARRITRIX, AFS).

## Procedure

1. Every multi-tenant table MUST include a `company_id` column, type `uuid`, `NOT NULL`, foreign key to `companies(id)`.

2. RLS must be enabled on the table:
```

ALTER TABLE <table_name> ENABLE ROW LEVEL SECURITY;

```

3. Minimum required policy (read):
```

CREATE POLICY "select_own_company"
ON <table_name>
FOR SELECT
USING (company_id = (SELECT company_id FROM profiles WHERE id = auth.uid()));

```

4. Minimum required policy (write):
```

CREATE POLICY "insert_own_company"
ON <table_name>
FOR INSERT
WITH CHECK (company_id = (SELECT company_id FROM profiles WHERE id = auth.uid()));

```

5. API routes must NEVER accept `company_id` from the client request body. It is always derived server-side from the authenticated session.

6. After creating/editing policies, verify with:
```

supabase db diff
supabase test db

```

## Failure conditions (block deploy if true)
- Table has no `company_id` column
- RLS is disabled
- Any policy is missing a `company_id` check
- Any API route trusts a client-supplied `company_id`

## Cross-reference
This skill is a prerequisite for Six Laws Gate, Law 1 (Schema).
