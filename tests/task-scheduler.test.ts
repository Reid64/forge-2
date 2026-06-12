/**
 * FORGE 2.0 — Task Scheduler unit test.
 *
 * Exercises the cron scheduler with NO real timers, NO network and NO Build Memory: the cron
 * engine, persistence store, notifier, clock and task handlers are all injected, so the pure
 * next-run evaluator, persistence + reload, add/remove/trigger, the dashboard payload, and the
 * failed-task → notifier alert path are all verified deterministically in-process.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/task-scheduler.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TaskScheduler,
  parseCron,
  nextCronRun,
  getSchedulerDashboard,
  type CronEngine,
  type CronHandle,
  type SchedulerMemory,
  type TaskHandler,
} from '../src/tools/task-scheduler.js';
import type { Notifier, Alert } from '../src/tools/notifier.js';
import type { ScheduledTask } from '../src/types/index.js';
import type { NewScheduledTask, ScheduledTaskUpdate } from '../src/memory/scheduled-tasks.js';

// ---------------------------------------------------------------------------
// Injectable fakes
// ---------------------------------------------------------------------------

/** A cron engine whose timers never fire on their own — tests fire them explicitly via `tick`. */
function fakeCronEngine(): { engine: CronEngine; tick: (expr: string) => void; armed: () => number } {
  const ticks = new Map<string, Set<() => void>>();
  const engine: CronEngine = {
    validate: (expression) => parseCron(expression) !== null,
    schedule: (expression, onTick): CronHandle => {
      const set = ticks.get(expression) ?? new Set();
      set.add(onTick);
      ticks.set(expression, set);
      return {
        stop: () => {
          set.delete(onTick);
        },
      };
    },
  };
  return {
    engine,
    tick: (expr) => {
      for (const fn of ticks.get(expr) ?? []) fn();
    },
    armed: () => [...ticks.values()].reduce((n, s) => n + s.size, 0),
  };
}

/** An in-memory `scheduled_tasks` store mirroring the Build Memory CRUD contract. */
function memStore(): { store: SchedulerMemory; rows: Map<string, ScheduledTask> } {
  const rows = new Map<string, ScheduledTask>();
  const store: SchedulerMemory = {
    async list() {
      return [...rows.values()];
    },
    async upsert(input: NewScheduledTask) {
      const ts = '2026-06-11T00:00:00.000Z';
      const existing = rows.get(input.name);
      const row: ScheduledTask = {
        id: existing?.id ?? input.name,
        name: input.name,
        description: input.description ?? null,
        task_type: input.task_type,
        cron_expression: input.cron_expression,
        enabled: input.enabled ?? true,
        machine_id: input.machine_id ?? null,
        metadata: input.metadata ?? {},
        last_run_at: input.last_run_at ?? existing?.last_run_at ?? null,
        next_run_at: input.next_run_at ?? existing?.next_run_at ?? null,
        last_result: input.last_result ?? existing?.last_result ?? null,
        last_error: input.last_error ?? existing?.last_error ?? null,
        last_duration_ms: input.last_duration_ms ?? existing?.last_duration_ms ?? null,
        run_count: input.run_count ?? existing?.run_count ?? 0,
        failure_count: input.failure_count ?? existing?.failure_count ?? 0,
        created_at: existing?.created_at ?? ts,
        updated_at: ts,
      };
      rows.set(row.name, row);
      return row;
    },
    async update(name: string, patch: ScheduledTaskUpdate) {
      const existing = rows.get(name);
      if (!existing) return null;
      const row = { ...existing, ...patch, updated_at: '2026-06-11T01:00:00.000Z' };
      rows.set(name, row);
      return row;
    },
    async remove(name: string) {
      return rows.delete(name);
    },
  };
  return { store, rows };
}

/** A notifier that records every alert it receives. */
function recordingNotifier(): { notifier: Notifier; alerts: Alert[] } {
  const alerts: Alert[] = [];
  return {
    notifier: {
      async notify(alert) {
        alerts.push(alert);
      },
    },
    alerts,
  };
}

const FIXED_NOW = new Date('2026-06-11T08:30:00.000Z');

// ---------------------------------------------------------------------------
// Pure cron evaluation
// ---------------------------------------------------------------------------

test('parseCron rejects malformed expressions and named fields', () => {
  assert.equal(parseCron('* * * *'), null, 'too few fields');
  assert.equal(parseCron('* * * * * *'), null, 'too many fields');
  assert.equal(parseCron('60 * * * *'), null, 'minute out of range');
  assert.equal(parseCron('*/0 * * * *'), null, 'zero step');
  assert.equal(parseCron('* * * JAN MON'), null, 'named fields not expanded (reporting only)');
  assert.notEqual(parseCron('0 3 * * *'), null, 'valid daily expression');
});

test('nextCronRun computes the next fire strictly after `from`', () => {
  // Daily at 03:00 — from 08:30 the next fire is the following 03:00.
  const next = nextCronRun('0 3 * * *', new Date('2026-06-11T08:30:00'));
  assert.ok(next);
  assert.equal(next.getHours(), 3);
  assert.equal(next.getMinutes(), 0);
  assert.equal(next.getDate(), 12);
});

test('nextCronRun honours step and list fields', () => {
  const next = nextCronRun('*/15 * * * *', new Date('2026-06-11T08:31:00'));
  assert.ok(next);
  assert.equal(next.getMinutes(), 45);
});

// ---------------------------------------------------------------------------
// Scheduler lifecycle
// ---------------------------------------------------------------------------

test('addTask persists, validates cron, and computes next run', async () => {
  const { store, rows } = memStore();
  const { engine } = fakeCronEngine();
  const scheduler = new TaskScheduler({
    memory: store,
    cronEngine: engine,
    notifier: recordingNotifier().notifier,
    now: () => FIXED_NOW,
    machineId: 'test-machine',
    log: () => {},
  });

  const bad = await scheduler.addTask({
    name: 'broken',
    taskType: 'memory_cleanup',
    cronExpression: 'not-a-cron',
  });
  assert.equal(bad, null, 'invalid cron is refused');
  assert.equal(rows.size, 0, 'nothing persisted for an invalid task');

  const task = await scheduler.addTask({
    name: 'nightly-cleanup',
    taskType: 'memory_cleanup',
    cronExpression: '0 3 * * *',
    description: 'prune telemetry',
  });
  assert.ok(task);
  assert.equal(task.machine_id, 'test-machine');
  assert.ok(task.next_run_at, 'next run computed');
  assert.equal(rows.get('nightly-cleanup')?.cron_expression, '0 3 * * *');
});

test('a scheduled fire runs the handler and records the outcome', async () => {
  const { store, rows } = memStore();
  const { engine, tick, armed } = fakeCronEngine();
  let ran = 0;
  const handlers: Partial<Record<ScheduledTask['task_type'], TaskHandler>> = {
    memory_cleanup: async () => {
      ran += 1;
      return { result: 'success', detail: 'pruned 3 rows' };
    },
  };
  const scheduler = new TaskScheduler({
    memory: store,
    cronEngine: engine,
    notifier: recordingNotifier().notifier,
    handlers,
    now: () => FIXED_NOW,
    log: () => {},
  });

  await scheduler.addTask({ name: 'cleanup', taskType: 'memory_cleanup', cronExpression: '0 3 * * *' });
  scheduler.start();
  assert.equal(armed(), 1, 'one timer armed');

  tick('0 3 * * *');
  await new Promise((r) => setImmediate(r)); // let the async run settle

  assert.equal(ran, 1, 'handler invoked once');
  const row = rows.get('cleanup');
  assert.equal(row?.last_result, 'success');
  assert.equal(row?.run_count, 1);
  assert.equal(row?.failure_count, 0);
  assert.ok(row?.last_run_at);
});

test('a failed task increments failure_count and raises a critical alert', async () => {
  const { store, rows } = memStore();
  const { engine } = fakeCronEngine();
  const { notifier, alerts } = recordingNotifier();
  const handlers: Partial<Record<ScheduledTask['task_type'], TaskHandler>> = {
    health_check: async () => {
      throw new Error('probe exploded');
    },
  };
  const scheduler = new TaskScheduler({
    memory: store,
    cronEngine: engine,
    notifier,
    handlers,
    now: () => FIXED_NOW,
    log: () => {},
  });

  await scheduler.addTask({ name: 'health', taskType: 'health_check', cronExpression: '*/5 * * * *' });
  const outcome = await scheduler.triggerTask('health');

  assert.equal(outcome?.result, 'failure');
  assert.match(outcome?.detail ?? '', /probe exploded/);
  const row = rows.get('health');
  assert.equal(row?.failure_count, 1);
  assert.equal(row?.last_result, 'failure');
  assert.equal(row?.last_error, 'probe exploded');

  assert.equal(alerts.length, 1, 'one alert raised');
  assert.equal(alerts[0]?.severity, 'critical');
  assert.match(alerts[0]?.title ?? '', /health/);
});

test('triggerTask on an unknown task returns null and raises no alert', async () => {
  const { store } = memStore();
  const { engine } = fakeCronEngine();
  const { notifier, alerts } = recordingNotifier();
  const scheduler = new TaskScheduler({ memory: store, cronEngine: engine, notifier, log: () => {} });

  const outcome = await scheduler.triggerTask('ghost');
  assert.equal(outcome, null);
  assert.equal(alerts.length, 0);
});

test('removeTask cancels the timer and deletes the persisted schedule', async () => {
  const { store, rows } = memStore();
  const { engine, armed } = fakeCronEngine();
  const scheduler = new TaskScheduler({ memory: store, cronEngine: engine, notifier: recordingNotifier().notifier, now: () => FIXED_NOW, log: () => {} });

  await scheduler.addTask({ name: 'rot', taskType: 'log_rotation', cronExpression: '0 0 * * *' });
  scheduler.start();
  assert.equal(armed(), 1);

  const removed = await scheduler.removeTask('rot');
  assert.equal(removed, true);
  assert.equal(armed(), 0, 'timer cancelled');
  assert.equal(rows.has('rot'), false, 'deleted from store');

  assert.equal(await scheduler.removeTask('rot'), false, 'removing again is a no-op');
});

test('load() rehydrates persisted tasks so the schedule survives a restart', async () => {
  const { store, rows } = memStore();
  const engineA = fakeCronEngine();

  // First scheduler instance persists a task.
  const s1 = new TaskScheduler({ memory: store, cronEngine: engineA.engine, notifier: recordingNotifier().notifier, now: () => FIXED_NOW, log: () => {} });
  await s1.addTask({ name: 'quota', taskType: 'quota_reset', cronExpression: '0 0 * * *' });
  assert.equal(rows.size, 1);

  // A brand-new instance (simulating a restart) loads only from the store.
  const engineB = fakeCronEngine();
  const s2 = new TaskScheduler({ memory: store, cronEngine: engineB.engine, notifier: recordingNotifier().notifier, now: () => FIXED_NOW, log: () => {} });
  const loaded = await s2.load();
  assert.equal(loaded, 1);
  assert.equal(s2.getTask('quota')?.task_type, 'quota_reset');

  s2.start();
  assert.equal(engineB.armed(), 1, 'rehydrated task is armed on the new instance');
});

// ---------------------------------------------------------------------------
// Dashboard data endpoint
// ---------------------------------------------------------------------------

test('getSchedulerDashboard reports next/last run, last result and summary counts', async () => {
  const { store } = memStore();
  const { engine } = fakeCronEngine();
  const { notifier } = recordingNotifier();
  const scheduler = new TaskScheduler({ memory: store, cronEngine: engine, notifier, now: () => FIXED_NOW, log: () => {} });

  await scheduler.addTask({ name: 'a-enabled', taskType: 'memory_cleanup', cronExpression: '0 3 * * *' });
  await scheduler.addTask({ name: 'b-disabled', taskType: 'log_rotation', cronExpression: '0 0 * * *', enabled: false });

  const dashboard = await getSchedulerDashboard(store, () => FIXED_NOW);
  assert.equal(dashboard.total, 2);
  assert.equal(dashboard.enabled, 1);
  assert.equal(dashboard.failing, 0);
  // Sorted by name.
  assert.deepEqual(dashboard.tasks.map((t) => t.name), ['a-enabled', 'b-disabled']);
  const enabledRow = dashboard.tasks.find((t) => t.name === 'a-enabled');
  assert.ok(enabledRow?.nextRunAt, 'enabled task has a next run');
  assert.equal(enabledRow?.lastResult, null, 'never run yet');
});
