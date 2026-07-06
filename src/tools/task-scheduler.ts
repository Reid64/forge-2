/**
 * FORGE 2.0 — Task Scheduler (`task-scheduler`).
 *
 * Cron-driven recurring task execution for FORGE itself AND the applications FORGE builds.
 * Wraps `node-cron` for the actual timers and adds the four things a bare cron call lacks:
 *
 *   1. PERSISTENCE — every task's schedule, last/next run, and last result are written to
 *      Build Memory (`scheduled_tasks`) and reloaded on {@link TaskScheduler.load}, so the
 *      schedule SURVIVES FORGE RESTARTS (BLUEPRINT canonical rule 9). With Build Memory down
 *      the scheduler degrades to an in-memory schedule (Contract 4 — never a halt).
 *
 *   2. NEXT-RUN VISIBILITY — a pure {@link nextCronRun} computes the next fire time from a
 *      standard 5-field cron expression, so the {@link TaskScheduler.dashboard} (and the
 *      `forge schedule` CLI) can report next-run / last-run / last-result for every task.
 *
 *   3. BUILT-IN TASK TYPES — research-agent runs, Build Memory cleanup, log rotation,
 *      production health checks, deadline scanning, and free-tier quota-reset tracking each
 *      ship a default handler ({@link DEFAULT_HANDLERS}); all are overridable per construction.
 *
 *   4. ALERTING — a failed scheduled task is routed through the notification system
 *      (`notifier.ts`) as a CRITICAL alert, so failures surface rather than dying silently.
 *
 * HOUSE RULES (mirrored from the rest of FORGE): never throws out of a run (a handler error is
 * caught, recorded as a failure, and alerted); the cron engine, notifier, clock, and Build-Memory
 * store are all INJECTABLE for tests; no governance or target-project governance file is touched;
 * secret VALUES are never read or logged.
 */

import { existsSync } from 'node:fs';
import { readdir, stat, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

import * as cron from 'node-cron';

import type {
  JsonObject,
  ScheduledTask,
  ScheduledTaskResult,
  ScheduledTaskType,
} from '../types/index.js';
import BuildMemory, { runQuery } from '../memory/index.js';
import type {
  NewScheduledTask,
  ScheduledTaskUpdate,
} from '../memory/scheduled-tasks.js';
import { createNotifier, type Notifier } from './notifier.js';
import { logLine } from './forge-logger.js';

const gzipAsync = promisify(gzip);

// ===========================================================================
// Cron expression evaluation (pure — used for next-run reporting)
// ===========================================================================

/** A parsed 5-field cron expression as explicit value sets per field. */
interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when day-of-month is constrained (not `*`). */
  domRestricted: boolean;
  /** True when day-of-week is constrained (not `*`). */
  dowRestricted: boolean;
}

/**
 * Expand a single cron field (`*`, `a`, `a-b`, lists with `,`, and `/step`) into the set of
 * matching numbers within `[min, max]`. Returns null on any malformed token. Field NAMES
 * (JAN, MON, …) are intentionally NOT expanded here — `node-cron` validates and fires those;
 * this evaluator only powers next-run REPORTING and returns null (→ "unknown") for them.
 */
function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    if (part === '') return null;

    let range = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash !== -1) {
      range = part.slice(0, slash);
      const parsedStep = Number(part.slice(slash + 1));
      if (!Number.isInteger(parsedStep) || parsedStep <= 0) return null;
      step = parsedStep;
    }

    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else {
      const dash = range.indexOf('-');
      if (dash !== -1) {
        lo = Number(range.slice(0, dash));
        hi = Number(range.slice(dash + 1));
      } else {
        lo = Number(range);
        hi = lo;
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values.size > 0 ? values : null;
}

/**
 * Parse a standard 5-field cron expression (`minute hour day-of-month month day-of-week`).
 * Returns null when the shape is wrong or any field fails to expand (e.g. uses named values).
 */
export function parseCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minP, hourP, domP, monP, dowP] = parts;
  if (minP === undefined || hourP === undefined || domP === undefined || monP === undefined || dowP === undefined) {
    return null;
  }

  const minute = parseCronField(minP, 0, 59);
  const hour = parseCronField(hourP, 0, 23);
  const dayOfMonth = parseCronField(domP, 1, 31);
  const month = parseCronField(monP, 1, 12);
  const dowRaw = parseCronField(dowP, 0, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dowRaw) return null;

  // Normalize day-of-week: cron allows 0 and 7 for Sunday.
  const dayOfWeek = new Set<number>();
  for (const d of dowRaw) dayOfWeek.add(d === 7 ? 0 : d);

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domRestricted: domP !== '*',
    dowRestricted: dowP !== '*',
  };
}

/** Does `date` (local time, second 0) satisfy the parsed cron fields? */
function cronDateMatches(date: Date, f: CronFields): boolean {
  if (!f.minute.has(date.getMinutes())) return false;
  if (!f.hour.has(date.getHours())) return false;
  if (!f.month.has(date.getMonth() + 1)) return false;

  const domMatch = f.dayOfMonth.has(date.getDate());
  const dowMatch = f.dayOfWeek.has(date.getDay());
  // Standard cron semantics: if BOTH day fields are restricted, match EITHER; otherwise match
  // whichever (if any) is restricted.
  if (f.domRestricted && f.dowRestricted) return domMatch || dowMatch;
  if (f.domRestricted) return domMatch;
  if (f.dowRestricted) return dowMatch;
  return true;
}

/**
 * Compute the next time a 5-field cron expression fires strictly AFTER `from` (local time, the
 * same basis `node-cron` uses). Returns null when the expression cannot be evaluated or nothing
 * matches within a year.
 */
export function nextCronRun(expression: string, from: Date): Date | null {
  const fields = parseCron(expression);
  if (!fields) return null;

  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limitMs = from.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= limitMs) {
    if (cronDateMatches(cursor, fields)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

// ===========================================================================
// Cron engine (node-cron adapter — injectable for tests)
// ===========================================================================

/** A live timer handle the scheduler can cancel. */
export interface CronHandle {
  stop(): void;
}

/** The cron primitive the scheduler depends on. Defaults to {@link nodeCronEngine}. */
export interface CronEngine {
  /** Validate a cron expression (delegates to node-cron, which also accepts named fields). */
  validate(expression: string): boolean;
  /** Start a timer firing `onTick` on the cron schedule; returns a cancel handle. */
  schedule(expression: string, onTick: () => void): CronHandle;
}

/** The default cron engine backed by `node-cron`. */
export function nodeCronEngine(): CronEngine {
  return {
    validate: (expression) => cron.validate(expression),
    schedule: (expression, onTick) => {
      const task = cron.schedule(expression, onTick);
      return {
        stop: () => {
          task.stop();
        },
      };
    },
  };
}

// ===========================================================================
// Persistence (Build Memory adapter — injectable for tests)
// ===========================================================================

/** The persistence surface the scheduler uses; abstracts Build Memory for testing. */
export interface SchedulerMemory {
  list(): Promise<ScheduledTask[] | null>;
  upsert(input: NewScheduledTask): Promise<ScheduledTask | null>;
  update(name: string, patch: ScheduledTaskUpdate): Promise<ScheduledTask | null>;
  remove(name: string): Promise<boolean>;
}

/** Default {@link SchedulerMemory} backed by Build Memory's `scheduled_tasks` CRUD. */
export function buildMemoryStore(): SchedulerMemory {
  return {
    list: () => BuildMemory.scheduledTasks.listTasks(),
    upsert: (input) => BuildMemory.scheduledTasks.upsertTask(input),
    update: (name, patch) => BuildMemory.scheduledTasks.updateTaskByName(name, patch),
    remove: async (name) => {
      const deleted = await BuildMemory.scheduledTasks.deleteTaskByName(name);
      return Array.isArray(deleted) && deleted.length > 0;
    },
  };
}

// ===========================================================================
// Task handlers
// ===========================================================================

/** Context passed to a task handler on each run. */
export interface TaskHandlerContext {
  task: ScheduledTask;
  log: (message: string) => void;
  now: () => Date;
}

/** The result a handler reports. `detail` is surfaced in logs, the dashboard, and alerts. */
export interface TaskRunOutcome {
  result: ScheduledTaskResult;
  detail?: string;
}

/** A unit of scheduled work. Must resolve (errors are caught and recorded as failures). */
export type TaskHandler = (ctx: TaskHandlerContext) => Promise<TaskRunOutcome>;

// --- metadata coercion helpers (metadata is free-form jsonb) ----------------

function metaNumber(meta: JsonObject, key: string, fallback: number): number {
  const v = meta[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function metaString(meta: JsonObject, key: string): string | null {
  const v = meta[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * research_agent (default) — FORGE ships no headless research pipeline wired in by default, so the
 * built-in handler only ACKNOWLEDGES the request and records intent. Inject a custom `research_agent`
 * handler to actually run a research agent. Honest by design (Iron Law 3): it reports `skipped`,
 * never a fabricated success.
 */
async function handleResearchAgent(ctx: TaskHandlerContext): Promise<TaskRunOutcome> {
  const target = metaString(ctx.task.metadata, 'target') ?? metaString(ctx.task.metadata, 'query');
  if (target) ctx.log(`research-agent run requested for target: ${target}`);
  return {
    result: 'skipped',
    detail: target
      ? `target '${target}' acknowledged — register a custom research_agent handler to execute the run`
      : 'no research target configured (metadata.target/query) and no custom handler registered',
  };
}

/** memory_cleanup (default) — prune `production_telemetry` rows older than the retention window. */
async function handleMemoryCleanup(ctx: TaskHandlerContext): Promise<TaskRunOutcome> {
  const retentionDays = metaNumber(ctx.task.metadata, 'retentionDays', 90);
  if (!BuildMemory.getClient()) {
    return { result: 'skipped', detail: 'Build Memory unavailable (stateless mode) — nothing to clean' };
  }
  const cutoffIso = new Date(ctx.now().getTime() - retentionDays * DAY_MS).toISOString();
  const deleted = await runQuery<Array<{ id: string }>>('scheduler:memory_cleanup', (db) => {
    const rows = db
      .prepare('SELECT id FROM production_telemetry WHERE captured_at < ?')
      .all(cutoffIso) as Array<{ id: string }>;
    db.prepare('DELETE FROM production_telemetry WHERE captured_at < ?').run(cutoffIso);
    return rows;
  });
  if (deleted === null) {
    return { result: 'failure', detail: 'telemetry cleanup query failed (see memory warnings)' };
  }
  return { result: 'success', detail: `pruned ${deleted.length} telemetry row(s) older than ${retentionDays}d` };
}

/** log_rotation (default) — gzip idle JSON-lines logs into `<logDir>/archive/`. */
async function handleLogRotation(ctx: TaskHandlerContext): Promise<TaskRunOutcome> {
  const idleDays = metaNumber(ctx.task.metadata, 'idleDays', 30);
  const logDir =
    metaString(ctx.task.metadata, 'logDir') ?? process.env['FORGE_LOG_DIR'] ?? join(process.cwd(), 'logs');
  if (!existsSync(logDir)) {
    return { result: 'skipped', detail: `log directory ${logDir} does not exist` };
  }

  const archiveDir = join(logDir, 'archive');
  const cutoffMs = ctx.now().getTime() - idleDays * DAY_MS;
  const entries = await readdir(logDir);

  let rotated = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const full = join(logDir, entry);
    const info = await stat(full);
    if (!info.isFile() || info.mtimeMs > cutoffMs) continue;

    await mkdir(archiveDir, { recursive: true });
    const gz = await gzipAsync(await readFile(full));
    await writeFile(join(archiveDir, `${entry}.gz`), gz);
    await unlink(full);
    rotated += 1;
  }
  return { result: 'success', detail: `rotated ${rotated} idle log file(s) (> ${idleDays}d) into ${archiveDir}` };
}

/** health_check (default) — fail if any CRITICAL production telemetry landed in the recent window. */
async function handleHealthCheck(ctx: TaskHandlerContext): Promise<TaskRunOutcome> {
  if (!BuildMemory.getClient()) {
    return { result: 'skipped', detail: 'Build Memory unavailable — cannot probe production telemetry' };
  }
  const windowHours = metaNumber(ctx.task.metadata, 'windowHours', 24);
  const sinceIso = new Date(ctx.now().getTime() - windowHours * HOUR_MS).toISOString();
  const critical = await runQuery<Array<{ id: string }>>('scheduler:health_check', (db) =>
    db
      .prepare("SELECT id FROM production_telemetry WHERE severity = 'critical' AND captured_at >= ?")
      .all(sinceIso) as Array<{ id: string }>
  );
  if (critical === null) {
    return { result: 'failure', detail: 'health-probe query failed (see memory warnings)' };
  }
  if (critical.length > 0) {
    return { result: 'failure', detail: `${critical.length} critical telemetry event(s) in the last ${windowHours}h` };
  }
  return { result: 'success', detail: `no critical events in the last ${windowHours}h` };
}

/** deadline_scan (default) — fail when builds are halted or have been running past the limit. */
async function handleDeadlineScan(ctx: TaskHandlerContext): Promise<TaskRunOutcome> {
  const builds = await BuildMemory.builds.listBuilds(200);
  if (builds === null) {
    return { result: 'skipped', detail: 'Build Memory unavailable — cannot scan builds' };
  }
  const maxRunningHours = metaNumber(ctx.task.metadata, 'maxRunningHours', 24);
  const nowMs = ctx.now().getTime();

  const halted = builds.filter((b) => b.status === 'halted');
  const overdue = builds.filter((b) => {
    if (b.status !== 'running' || !b.started_at) return false;
    const started = Date.parse(b.started_at);
    return !Number.isNaN(started) && nowMs - started > maxRunningHours * HOUR_MS;
  });

  if (halted.length + overdue.length > 0) {
    return {
      result: 'failure',
      detail: `${halted.length} halted + ${overdue.length} overdue build(s) (running > ${maxRunningHours}h)`,
    };
  }
  return { result: 'success', detail: 'no halted or overdue builds' };
}

/** quota_reset (default) — record the next free-tier reset boundary (next UTC midnight). */
async function handleQuotaReset(ctx: TaskHandlerContext): Promise<TaskRunOutcome> {
  const now = ctx.now();
  // Free-tier quotas key off the UTC day (see free-tier-manager.ts); they reset at UTC midnight.
  const nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  const nextResetIso = nextReset.toISOString();
  await BuildMemory.telemetry.createEvent({
    project_name: 'FORGE',
    event_type: 'usage',
    event_data: { kind: 'quota_reset_tracking', next_reset_utc: nextResetIso },
  });
  ctx.log(`free-tier quota resets at ${nextResetIso} (UTC midnight)`);
  return { result: 'success', detail: `next free-tier quota reset: ${nextResetIso}` };
}

/** Built-in handler for every task type. Each is overridable via {@link SchedulerOptions.handlers}. */
export const DEFAULT_HANDLERS: Record<ScheduledTaskType, TaskHandler> = {
  research_agent: handleResearchAgent,
  memory_cleanup: handleMemoryCleanup,
  log_rotation: handleLogRotation,
  health_check: handleHealthCheck,
  deadline_scan: handleDeadlineScan,
  quota_reset: handleQuotaReset,
};

// ===========================================================================
// Dashboard data
// ===========================================================================

/** One row of the scheduler dashboard data endpoint. */
export interface SchedulerDashboardRow {
  name: string;
  taskType: ScheduledTaskType;
  description: string | null;
  cronExpression: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: ScheduledTaskResult | null;
  lastError: string | null;
  lastDurationMs: number | null;
  runCount: number;
  failureCount: number;
}

/** The scheduler dashboard payload — all scheduled tasks plus summary counts. */
export interface SchedulerDashboard {
  generatedAt: string;
  machineId: string | null;
  total: number;
  enabled: number;
  failing: number;
  tasks: SchedulerDashboardRow[];
}

function toDashboardRow(t: ScheduledTask): SchedulerDashboardRow {
  return {
    name: t.name,
    taskType: t.task_type,
    description: t.description,
    cronExpression: t.cron_expression,
    enabled: t.enabled,
    nextRunAt: t.next_run_at,
    lastRunAt: t.last_run_at,
    lastResult: t.last_result,
    lastError: t.last_error,
    lastDurationMs: t.last_duration_ms,
    runCount: t.run_count,
    failureCount: t.failure_count,
  };
}

function dashboardFrom(
  tasks: readonly ScheduledTask[],
  machineId: string | null,
  now: () => Date
): SchedulerDashboard {
  const rows = [...tasks].sort((a, b) => a.name.localeCompare(b.name)).map(toDashboardRow);
  return {
    generatedAt: now().toISOString(),
    machineId,
    total: rows.length,
    enabled: rows.filter((r) => r.enabled).length,
    failing: rows.filter((r) => r.lastResult === 'failure').length,
    tasks: rows,
  };
}

/**
 * Scheduler dashboard DATA ENDPOINT — reads all scheduled tasks straight from Build Memory and
 * returns the JSON-serializable dashboard (next/last run + last result per task). Works without a
 * running scheduler process, so any HTTP/telemetry layer can serve it. Returns an empty dashboard
 * in stateless mode rather than throwing (Contract 4).
 */
export async function getSchedulerDashboard(
  memory: SchedulerMemory = buildMemoryStore(),
  now: () => Date = () => new Date()
): Promise<SchedulerDashboard> {
  const tasks = (await memory.list()) ?? [];
  const machineId = process.env['FORGE_MACHINE_ID'] ?? null;
  return dashboardFrom(tasks, machineId, now);
}

// ===========================================================================
// Scheduler
// ===========================================================================

/** Construction options for {@link TaskScheduler}. All injectable; all optional. */
export interface SchedulerOptions {
  machineId?: string;
  cronEngine?: CronEngine;
  notifier?: Notifier;
  memory?: SchedulerMemory;
  handlers?: Partial<Record<ScheduledTaskType, TaskHandler>>;
  now?: () => Date;
  log?: (message: string) => void;
}

/** Input to {@link TaskScheduler.addTask}. */
export interface AddTaskInput {
  name: string;
  taskType: ScheduledTaskType;
  cronExpression: string;
  description?: string;
  enabled?: boolean;
  metadata?: JsonObject;
}

function isoOrNull(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/**
 * The Task Scheduler. Construct it (or use {@link createTaskScheduler} to construct + load),
 * call {@link TaskScheduler.start} to arm the timers, and add/remove/trigger tasks at runtime.
 */
export class TaskScheduler {
  private readonly machineId: string | null;
  private readonly cronEngine: CronEngine;
  private readonly notifier: Notifier;
  private readonly memory: SchedulerMemory;
  private readonly handlers: Record<ScheduledTaskType, TaskHandler>;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly handles = new Map<string, CronHandle>();
  private running = false;

  constructor(options: SchedulerOptions = {}) {
    this.machineId = options.machineId ?? process.env['FORGE_MACHINE_ID'] ?? null;
    this.cronEngine = options.cronEngine ?? nodeCronEngine();
    this.notifier = options.notifier ?? createNotifier();
    this.memory = options.memory ?? buildMemoryStore();
    this.handlers = { ...DEFAULT_HANDLERS, ...(options.handlers ?? {}) };
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? logLine('task-scheduler');
  }

  /** Load persisted schedules from Build Memory into memory. Returns the count loaded. */
  async load(): Promise<number> {
    const persisted = await this.memory.list();
    this.tasks.clear();
    if (persisted) {
      for (const t of persisted) this.tasks.set(t.name, t);
      this.log(`loaded ${persisted.length} scheduled task(s) from Build Memory`);
    } else {
      this.log('Build Memory unavailable — starting with no persisted tasks (stateless mode)');
    }
    return this.tasks.size;
  }

  /** Arm timers for every enabled task. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const task of this.tasks.values()) {
      if (task.enabled) this.scheduleTask(task);
    }
    this.log(`scheduler started — ${this.handles.size} active timer(s)`);
  }

  /** Cancel every timer. The persisted schedule is untouched. */
  stop(): void {
    for (const handle of this.handles.values()) {
      try {
        handle.stop();
      } catch {
        // A misbehaving timer must not block shutdown.
      }
    }
    this.handles.clear();
    this.running = false;
    this.log('scheduler stopped — all timers cleared');
  }

  /** Snapshot of all registered tasks, sorted by name. */
  listTasks(): ScheduledTask[] {
    return [...this.tasks.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** One registered task by name, or undefined. */
  getTask(name: string): ScheduledTask | undefined {
    return this.tasks.get(name);
  }

  /** The dashboard payload for the currently-loaded tasks. */
  dashboard(): SchedulerDashboard {
    return dashboardFrom(this.listTasks(), this.machineId, this.now);
  }

  /**
   * Register (or re-register) a task: validate its cron expression, persist it to Build Memory,
   * and — if the scheduler is running and the task is enabled — arm its timer. Returns the stored
   * task, or null when the cron expression is invalid.
   */
  async addTask(input: AddTaskInput): Promise<ScheduledTask | null> {
    if (!this.cronEngine.validate(input.cronExpression)) {
      this.log(`refusing to add '${input.name}' — invalid cron expression '${input.cronExpression}'`);
      return null;
    }
    const enabled = input.enabled ?? true;
    const nextRunAt = enabled ? isoOrNull(nextCronRun(input.cronExpression, this.now())) : null;

    const persisted = await this.memory.upsert({
      name: input.name,
      task_type: input.taskType,
      cron_expression: input.cronExpression,
      description: input.description ?? null,
      enabled,
      machine_id: this.machineId,
      metadata: input.metadata ?? {},
      next_run_at: nextRunAt,
    });

    // Build Memory up → use the canonical row; stateless → synthesize an in-memory row.
    const task = persisted ?? this.synthesize(input, enabled, nextRunAt);
    this.tasks.set(task.name, task);
    if (this.running && task.enabled) this.scheduleTask(task);
    this.log(`added scheduled task '${task.name}' (${task.task_type}, '${task.cron_expression}')`);
    return task;
  }

  /** Remove a task: cancel its timer and delete it from memory + Build Memory. */
  async removeTask(name: string): Promise<boolean> {
    const handle = this.handles.get(name);
    if (handle) {
      handle.stop();
      this.handles.delete(name);
    }
    const existedLocally = this.tasks.delete(name);
    const removedFromMemory = await this.memory.remove(name);
    if (existedLocally || removedFromMemory) {
      this.log(`removed scheduled task '${name}'`);
      return true;
    }
    this.log(`no scheduled task named '${name}' to remove`);
    return false;
  }

  /** Run a task NOW (out of band), recording the run exactly as a scheduled fire would. */
  async triggerTask(name: string): Promise<TaskRunOutcome | null> {
    if (!this.tasks.has(name)) {
      this.log(`cannot trigger '${name}' — no such scheduled task`);
      return null;
    }
    return this.runTask(name, 'manual');
  }

  // --- internals -----------------------------------------------------------

  private scheduleTask(task: ScheduledTask): void {
    const existing = this.handles.get(task.name);
    if (existing) {
      existing.stop();
      this.handles.delete(task.name);
    }
    if (!this.cronEngine.validate(task.cron_expression)) {
      this.log(`task '${task.name}' has an invalid cron expression — not armed`);
      return;
    }
    const handle = this.cronEngine.schedule(task.cron_expression, () => {
      void this.runTask(task.name, 'scheduled');
    });
    this.handles.set(task.name, handle);
  }

  private synthesize(input: AddTaskInput, enabled: boolean, nextRunAt: string | null): ScheduledTask {
    const ts = this.now().toISOString();
    return {
      id: input.name,
      name: input.name,
      description: input.description ?? null,
      task_type: input.taskType,
      cron_expression: input.cronExpression,
      enabled,
      machine_id: this.machineId,
      metadata: input.metadata ?? {},
      last_run_at: null,
      next_run_at: nextRunAt,
      last_result: null,
      last_error: null,
      last_duration_ms: null,
      run_count: 0,
      failure_count: 0,
      created_at: ts,
      updated_at: ts,
    };
  }

  private async runTask(name: string, trigger: 'scheduled' | 'manual'): Promise<TaskRunOutcome> {
    const task = this.tasks.get(name);
    if (!task) return { result: 'skipped', detail: `task '${name}' is not registered` };

    const handler = this.handlers[task.task_type];
    const startedAt = this.now();

    let outcome: TaskRunOutcome;
    try {
      outcome = await handler({ task, log: this.log, now: this.now });
    } catch (error) {
      outcome = { result: 'failure', detail: error instanceof Error ? error.message : String(error) };
    }

    const finishedAt = this.now();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const nextRunAt = task.enabled ? isoOrNull(nextCronRun(task.cron_expression, finishedAt)) : null;

    const patch: ScheduledTaskUpdate = {
      last_run_at: startedAt.toISOString(),
      next_run_at: nextRunAt,
      last_result: outcome.result,
      last_error: outcome.result === 'failure' ? outcome.detail ?? 'unknown error' : null,
      last_duration_ms: durationMs,
      run_count: task.run_count + 1,
      failure_count: task.failure_count + (outcome.result === 'failure' ? 1 : 0),
    };

    this.tasks.set(name, { ...task, ...patch, updated_at: finishedAt.toISOString() });
    await this.memory.update(name, patch); // best-effort; degrades silently in stateless mode

    this.log(
      `task '${name}' ${trigger} run → ${outcome.result}` +
        `${outcome.detail ? ` (${outcome.detail})` : ''} in ${durationMs}ms`
    );

    if (outcome.result === 'failure') {
      await this.notifier.notify({
        source: `scheduler:${task.task_type}`,
        title: `Scheduled task '${name}' failed`,
        detail: outcome.detail ?? 'unknown error',
        severity: 'critical',
        context: { task_name: name, task_type: task.task_type, trigger, duration_ms: durationMs },
      });
    }
    return outcome;
  }
}

/** Construct a {@link TaskScheduler} and load its persisted schedule from Build Memory. */
export async function createTaskScheduler(options: SchedulerOptions = {}): Promise<TaskScheduler> {
  const scheduler = new TaskScheduler(options);
  await scheduler.load();
  return scheduler;
}

export default TaskScheduler;
