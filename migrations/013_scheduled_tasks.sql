-- FORGE 2.0 — Migration 013: scheduled_tasks
-- Cron-scheduled recurring tasks (research runs, memory cleanup, log rotation,
-- health checks, deadline scanning, free-tier quota reset tracking) whose
-- schedule PERSISTS in Build Memory so it survives FORGE restarts.
-- Source: SCHEMA_REGISTRY.md (addendum › Table: scheduled_tasks)

create table if not exists public.scheduled_tasks (
    id                  uuid            primary key default gen_random_uuid(),
    name                text            not null unique,
    description         text,
    task_type           text            not null,
    cron_expression     text            not null,
    enabled             boolean         not null default true,
    machine_id          text,
    metadata            jsonb           not null default '{}',
    last_run_at         timestamptz,
    next_run_at         timestamptz,
    last_result         text,
    last_error          text,
    last_duration_ms    int,
    run_count           int             not null default 0,
    failure_count       int             not null default 0,
    created_at          timestamptz     not null default now(),
    updated_at          timestamptz     not null default now(),
    constraint scheduled_tasks_task_type_check
        check (task_type in (
            'research_agent', 'memory_cleanup', 'log_rotation',
            'health_check', 'deadline_scan', 'quota_reset'
        )),
    constraint scheduled_tasks_last_result_check
        check (last_result is null or last_result in ('success', 'failure', 'skipped'))
);

create index if not exists idx_scheduled_tasks_enabled  on public.scheduled_tasks (enabled)
    where enabled = true;
create index if not exists idx_scheduled_tasks_type     on public.scheduled_tasks (task_type);
create index if not exists idx_scheduled_tasks_next_run on public.scheduled_tasks (next_run_at);
create index if not exists idx_scheduled_tasks_machine  on public.scheduled_tasks (machine_id);
