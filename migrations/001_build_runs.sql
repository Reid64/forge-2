-- FORGE 2.0 — Migration 001: build_runs
-- Tracks every autonomous build FORGE executes.
-- Source: SCHEMA_REGISTRY.md › Table: build_runs
-- RLS: none (FORGE is single-operator, local database).

create table if not exists public.build_runs (
    id                      uuid            primary key default gen_random_uuid(),
    project_name            text            not null,
    project_path            text            not null,
    stack_fingerprint       jsonb           not null default '{}'::jsonb,
    status                  text            not null default 'queued',
    started_at              timestamptz,
    completed_at            timestamptz,
    total_prompts           int             not null default 0,
    completed_prompts       int             not null default 0,
    failed_prompts          int             not null default 0,
    total_errors            int             not null default 0,
    total_tokens            int             not null default 0,
    total_cost_usd          numeric(10,4)   not null default 0,
    machine_id              text            not null,
    toolchain_manifest      jsonb           not null default '{}'::jsonb,
    governance_hash         text,
    sentinel_interventions  int             not null default 0,
    autonomous_recovery_mode boolean        not null default false,
    parallel_prompts_used   boolean         not null default false,
    dry_run                 boolean         not null default false,
    created_at              timestamptz     not null default now(),
    constraint build_runs_status_check
        check (status in ('queued', 'running', 'completed', 'failed', 'halted'))
);

create index if not exists idx_build_runs_project on public.build_runs (project_name);
create index if not exists idx_build_runs_status  on public.build_runs (status);
create index if not exists idx_build_runs_stack   on public.build_runs using gin (stack_fingerprint);
create index if not exists idx_build_runs_machine on public.build_runs (machine_id);
