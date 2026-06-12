-- FORGE 2.0 — Role passwords for self-hosted Supabase.
-- The supabase/postgres image bakes the standard Supabase roles
-- (anon, authenticated, service_role, supabase_auth_admin,
-- supabase_storage_admin, authenticator, supabase_admin, ...). Here we set
-- their login passwords to POSTGRES_PASSWORD so the API services can connect.
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_functions_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
