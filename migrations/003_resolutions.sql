-- FORGE 2.0 — Migration 003: resolutions
-- Proven fixes for error patterns.
-- Source: SCHEMA_REGISTRY.md › Table: resolutions
--
-- This migration also closes the circular FK introduced in 002 by adding the
-- error_patterns.resolution_id -> resolutions(id) constraint now that both
-- tables exist.

create table if not exists public.resolutions (
    id                      uuid            primary key default gen_random_uuid(),
    error_pattern_id        uuid            not null
                                references public.error_patterns(id) on delete cascade,
    resolution_type         text            not null,
    resolution_description  text            not null,
    resolution_steps        jsonb           not null,
    times_applied           int             not null default 0,
    times_succeeded         int             not null default 0,
    times_failed            int             not null default 0,
    created_at              timestamptz     not null default now(),
    constraint resolutions_type_check
        check (resolution_type in (
            'prompt_rewrite', 'config_change', 'dependency_fix',
            'code_patch', 'manual'
        ))
);

create index if not exists idx_resolutions_error_pattern
    on public.resolutions (error_pattern_id);

-- Close the circular foreign key from error_patterns.resolution_id.
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'error_patterns_resolution_id_fkey'
    ) then
        alter table public.error_patterns
            add constraint error_patterns_resolution_id_fkey
            foreign key (resolution_id) references public.resolutions(id)
            on delete set null;
    end if;
end $$;
