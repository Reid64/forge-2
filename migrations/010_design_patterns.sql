-- FORGE 2.0 — Migration 010: design_patterns
-- Reusable UI/UX and architectural patterns from successful builds.
-- Source: SCHEMA_REGISTRY.md › Table: design_patterns

create table if not exists public.design_patterns (
    id                  uuid            primary key default gen_random_uuid(),
    pattern_type        text            not null,
    name                text            not null,
    description         text            not null,
    source_project      text            not null,
    specification       jsonb           not null,
    usage_count         int             not null default 0,
    effectiveness_score numeric(5,4),
    created_at          timestamptz     not null default now(),
    constraint design_patterns_type_check
        check (pattern_type in ('ui_component', 'auth_flow', 'schema_pattern', 'api_pattern'))
);

create index if not exists idx_design_patterns_type on public.design_patterns (pattern_type);
