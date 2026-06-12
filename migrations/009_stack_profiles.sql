-- FORGE 2.0 — Migration 009: stack_profiles
-- Reusable technology stack definitions.
-- Source: SCHEMA_REGISTRY.md › Table: stack_profiles

create table if not exists public.stack_profiles (
    id                          uuid        primary key default gen_random_uuid(),
    name                        text        not null unique,
    description                 text        not null,
    stack_definition            jsonb       not null,
    toolchain_requirements      jsonb       not null,
    governance_template_set     text        not null,
    sentinel_checks             jsonb       not null,
    build_commands              jsonb       not null,
    builds_completed            int         not null default 0,
    created_at                  timestamptz not null default now()
);

create index if not exists idx_stack_profiles_name on public.stack_profiles (name);
