# Test Project — Task Management App

> FORGE 2.0 integration-test fixture (queue.yaml s8-p04). This is the raw idea the
> pipeline (`forge design` / `forge build`) consumes. It is intentionally small and
> self-contained so a full Phase 0 → 5 dry run is cheap and deterministic.

## Idea

A task management app with user authentication, task CRUD, and a dashboard.

## Scope (what a correct build should produce)

- **Authentication** — email/password sign-up + sign-in, session-based, every page
  behind auth except the auth screens. Role is derived from the session, never the
  request body (BEHAVIORAL_CONTRACTS Contract — company_id/user scoping).
- **Tasks (CRUD)** — a `tasks` table scoped to the owning user; create / read / update
  (incl. status toggle) / delete; an empty state when the list is empty.
- **Dashboard** — a landing view after sign-in summarising the user's tasks
  (counts by status) and linking to the task list.

## Intended stack (canonical FORGE nextjs-supabase profile)

- Next.js 14 (App Router, TypeScript strict)
- Supabase (Postgres + Auth + RLS) — `tasks` and `profiles` tables, RLS by `auth.uid()`
- pnpm
