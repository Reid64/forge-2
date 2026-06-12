-- FORGE 2.0 — Migration 002: error_patterns
-- Generalized error patterns extracted across all builds.
-- Source: SCHEMA_REGISTRY.md › Table: error_patterns
--
-- NOTE: error_patterns.resolution_id references resolutions(id), but resolutions
-- references error_patterns(id) — a circular FK. The resolution_id foreign-key
-- constraint is added in migration 003 (after resolutions exists). The column is
-- declared here.

create table if not exists public.error_patterns (
    id                      uuid            primary key default gen_random_uuid(),
    error_signature         text            not null unique,
    error_category          text            not null,
    error_message_sample    text            not null,
    occurrence_count        int             not null default 1,
    first_seen_at           timestamptz     not null default now(),
    last_seen_at            timestamptz     not null default now(),
    first_seen_project      text            not null,
    stack_fingerprints      jsonb           not null default '[]'::jsonb,
    trigger_phase           text,
    trigger_prompt_pattern  text,
    resolution_id           uuid,
    prevention_rule         text,
    success_rate            numeric(5,4)    not null default 0,
    auto_resolve_eligible   boolean         not null default false,
    created_at              timestamptz     not null default now(),
    updated_at              timestamptz     not null default now(),
    constraint error_patterns_category_check
        check (error_category in (
            'type_error', 'build_failure', 'runtime', 'schema',
            'auth', 'dependency', 'config'
        ))
);

create index if not exists idx_error_sig on public.error_patterns (error_signature);
create index if not exists idx_error_cat on public.error_patterns (error_category);
create index if not exists idx_error_auto on public.error_patterns (auto_resolve_eligible)
    where auto_resolve_eligible = true;
