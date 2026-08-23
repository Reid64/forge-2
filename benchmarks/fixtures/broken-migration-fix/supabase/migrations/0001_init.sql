-- FORGE benchmark fixture (broken-migration-fix): this migration is INTENTIONALLY broken.
-- DISPOSABLE fixture; never a real project. Do not "fix" this file in forge-2 itself.
--
-- Bugs, both real and reproducible against Postgres/Supabase:
--   1. `orders.user_id` references a table/column that is never created (`users_v2(user_id)`
--      instead of `users(id)`) — the FOREIGN KEY fails at apply time.
--   2. A trailing comma before the closing paren on `orders` — a plain syntax error.

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users_v2(user_id), -- BUG: no such table/column
  total_cents integer not null,
  created_at timestamptz not null default now(),
); -- BUG: trailing comma above is a syntax error
