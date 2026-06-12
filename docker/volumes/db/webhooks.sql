-- FORGE 2.0 — Database webhooks schema for self-hosted Supabase.
-- Creates the supabase_functions schema used by database webhooks / hooks.
-- Mirrors the official supabase/docker webhooks init script.
CREATE SCHEMA IF NOT EXISTS supabase_functions AUTHORIZATION supabase_admin;

GRANT USAGE ON SCHEMA supabase_functions TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA supabase_functions
  GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA supabase_functions
  GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA supabase_functions
  GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
