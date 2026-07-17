-- 004_create_profiles.sql
-- Role storage for Supabase Auth users. BEHAVIORAL_CONTRACTS.md "Permissions
-- model": a flat single-role model where every authenticated user (in
-- practice exactly one: the operator) holds role = 'operator'.
--
-- Target: Supabase Auth's own Postgres instance (auth.users lives there) --
-- NOT the Build Memory SQLite file. This is the one table in this project
-- that legitimately lives in Postgres and carries RLS, since it is read
-- directly by middleware.ts / route handlers via the Supabase SSR client.
-- gap_audit_runs and artifact_health_scores are intentionally NOT mirrored
-- here -- per BEHAVIORAL_CONTRACTS.md API Contracts conventions, those two
-- tables live exclusively in the Build Memory SQLite file
-- (~/.forge/forge_memory.db, see supabase/migrations/001-003 and
-- src/learning/database.ts) and have no Postgres/RLS presence (confirmed by
-- SCHEMA_REGISTRY.md "RLS: disabled" / "Tenant-scoped: no" and TESTING.md
-- Law 1: "SQLite file permissions provide isolation").

CREATE TABLE IF NOT EXISTS profiles (
  id          uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text        NOT NULL DEFAULT 'operator',
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_self
  ON profiles
  FOR ALL
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Auto-create a profile row (role defaults to 'operator') whenever a new
-- Supabase Auth user is created, so scripts/create-operator-user.mjs never
-- has to write to `profiles` directly -- it only ever creates/updates the
-- auth.users row.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO profiles (id, role) VALUES (NEW.id, 'operator');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE handle_new_user();
