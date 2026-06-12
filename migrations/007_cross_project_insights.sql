-- FORGE 2.0 — Migration 007: cross_project_insights
-- Learnings transferable between projects.
-- Source: SCHEMA_REGISTRY.md › Table: cross_project_insights

create table if not exists public.cross_project_insights (
    id                      uuid            primary key default gen_random_uuid(),
    insight_type            text            not null,
    source_project          text            not null,
    source_build_id         uuid            references public.build_runs(id) on delete set null,
    applicable_fingerprints jsonb           not null default '[]'::jsonb,
    description             text            not null,
    evidence                jsonb           not null,
    applied_count           int             not null default 0,
    effectiveness_score     numeric(5,4),
    created_at              timestamptz     not null default now(),
    constraint cross_project_insights_type_check
        check (insight_type in ('pattern', 'prevention', 'optimization', 'template_change'))
);

create index if not exists idx_insights_type    on public.cross_project_insights (insight_type);
create index if not exists idx_insights_project on public.cross_project_insights (source_project);
