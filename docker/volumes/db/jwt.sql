-- FORGE 2.0 — JWT settings for self-hosted Supabase.
-- Publishes the JWT secret to the database so PostgREST/Realtime can verify
-- tokens. Values are interpolated from environment variables by the postgres
-- entrypoint (POSTGRES_DB / JWT_SECRET / JWT_EXP).
\set jwt_secret `echo "$JWT_SECRET"`
\set jwt_exp `echo "$JWT_EXP"`

ALTER DATABASE postgres SET "app.settings.jwt_secret" TO :'jwt_secret';
ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
