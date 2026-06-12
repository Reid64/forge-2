-- FORGE 2.0 — Migration 011: brand_identities
-- Persistent design tokens per brand/project.
-- Source: SCHEMA_REGISTRY.md › Table: brand_identities

create table if not exists public.brand_identities (
    id                  uuid            primary key default gen_random_uuid(),
    project_name        text            not null unique,
    brand_name          text            not null,
    design_tokens       jsonb           not null,
    component_styles    jsonb           not null default '{}'::jsonb,
    created_at          timestamptz     not null default now(),
    updated_at          timestamptz     not null default now()
);

create index if not exists idx_brand_identities_project on public.brand_identities (project_name);
