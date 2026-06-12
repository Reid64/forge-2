-- FORGE 2.0 — Migration 005: governance_versions
-- Version history of FORGE governance templates.
-- Source: SCHEMA_REGISTRY.md › Table: governance_versions

create table if not exists public.governance_versions (
    id                      uuid            primary key default gen_random_uuid(),
    template_name           text            not null,
    version_number          int             not null,
    content_hash            text            not null,
    content_snapshot        text            not null,
    changes_description     text,
    change_source           text            not null,
    effectiveness_score     numeric(5,4),
    builds_used_in          int             not null default 0,
    created_at              timestamptz     not null default now(),
    constraint governance_versions_template_version_key
        unique (template_name, version_number),
    constraint governance_versions_change_source_check
        check (change_source in ('manual', 'recursive_learner', 'error_prevention'))
);

create index if not exists idx_gov_template
    on public.governance_versions (template_name, version_number);
