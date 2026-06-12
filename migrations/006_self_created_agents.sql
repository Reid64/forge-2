-- FORGE 2.0 — Migration 006: self_created_agents
-- Agents FORGE creates for itself through recursive learning.
-- Source: SCHEMA_REGISTRY.md › Table: self_created_agents

create table if not exists public.self_created_agents (
    id                          uuid        primary key default gen_random_uuid(),
    name                        text        not null unique,
    purpose                     text        not null,
    trigger_conditions          jsonb       not null,
    input_contract              jsonb       not null,
    output_contract             jsonb       not null,
    implementation_code         text        not null,
    source_pattern_description  text        not null,
    test_results                jsonb       not null default '{}'::jsonb,
    status                      text        not null default 'proposed',
    approved_at                 timestamptz,
    builds_used_in              int         not null default 0,
    effectiveness_score         numeric(5,4),
    created_at                  timestamptz not null default now(),
    updated_at                  timestamptz not null default now(),
    constraint self_created_agents_status_check
        check (status in ('proposed', 'approved', 'active', 'deprecated'))
);

create index if not exists idx_self_agents_status on public.self_created_agents (status);
