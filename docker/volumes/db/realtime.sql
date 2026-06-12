-- FORGE 2.0 — Realtime schema for self-hosted Supabase.
-- Creates the schema Realtime owns and the default publication it streams from.
-- Realtime runs its own Ecto migrations on boot; this just guarantees the
-- schema/role grants exist beforehand.
CREATE SCHEMA IF NOT EXISTS _realtime;
ALTER SCHEMA _realtime OWNER TO postgres;

-- Default logical-replication publication for Realtime. Tables are added to it
-- per-table by later migrations / FORGE schema prompts.
DROP PUBLICATION IF EXISTS supabase_realtime;
CREATE PUBLICATION supabase_realtime;
