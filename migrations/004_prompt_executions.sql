-- FORGE 2.0 — Migration 004: prompt_executions
-- Tracks individual prompt execution within a build.
-- Source: SCHEMA_REGISTRY.md › Table: prompt_executions

create table if not exists public.prompt_executions (
    id                          uuid            primary key default gen_random_uuid(),
    build_run_id                uuid            not null
                                    references public.build_runs(id) on delete cascade,
    prompt_index                int             not null,
    prompt_name                 text            not null,
    prompt_hash                 text            not null,
    prompt_content              text            not null,
    status                      text            not null default 'pending',
    started_at                  timestamptz,
    completed_at                timestamptz,
    tokens_input                int             not null default 0,
    tokens_output               int             not null default 0,
    cost_usd                    numeric(10,4)   not null default 0,
    error_output                text,
    resolution_applied          text,
    was_rewritten               boolean         not null default false,
    original_prompt_hash        text,
    rewrite_reason              text,
    failure_prediction_score    numeric(5,4),
    branch_name                 text,
    sentinel_passed             boolean,
    sentinel_details            jsonb,
    files_created               jsonb           default '[]'::jsonb,
    files_modified              jsonb           default '[]'::jsonb,
    files_deleted               jsonb           default '[]'::jsonb,
    created_at                  timestamptz     not null default now(),
    constraint prompt_executions_status_check
        check (status in ('pending', 'running', 'completed', 'failed', 'skipped'))
);

create index if not exists idx_prompt_exec_build  on public.prompt_executions (build_run_id);
create index if not exists idx_prompt_exec_status on public.prompt_executions (status);
create index if not exists idx_prompt_exec_hash   on public.prompt_executions (prompt_hash);
