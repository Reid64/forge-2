-- FORGE 2.0 — Migration 008: production_telemetry
-- Runtime data from deployed applications.
-- Source: SCHEMA_REGISTRY.md › Table: production_telemetry

create table if not exists public.production_telemetry (
    id                  uuid            primary key default gen_random_uuid(),
    project_name        text            not null,
    build_run_id        uuid            references public.build_runs(id) on delete set null,
    event_type          text            not null,
    event_data          jsonb           not null,
    severity            text,
    captured_at         timestamptz     not null,
    fed_back_to_build   uuid            references public.build_runs(id) on delete set null,
    created_at          timestamptz     not null default now(),
    constraint production_telemetry_event_type_check
        check (event_type in ('error', 'performance', 'usage', 'feedback')),
    constraint production_telemetry_severity_check
        check (severity is null or severity in ('critical', 'warning', 'info'))
);

create index if not exists idx_telemetry_project on public.production_telemetry (project_name);
create index if not exists idx_telemetry_type    on public.production_telemetry (event_type);
create index if not exists idx_telemetry_severity on public.production_telemetry (severity)
    where severity = 'critical';
