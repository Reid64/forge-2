/**
 * FORGE 2.0 — `forge dashboard`: a read-only, live-updating terminal view of a build run's
 * Control Plane telemetry.
 *
 * Tails `.forge/runs/<run-id>/{events,prompts,tests}.jsonl` — the exact files
 * `src/telemetry/run-recorder.ts` writes during Phase 3 (see that file's header for the record
 * shapes) — plus `.forge/live-status.json` (`src/tools/live-status.ts`) for the running cost
 * total, reusing `totals.costEstimatedUsd` (itself `ctx.costTracker.totalCostUsd()`, mirrored at
 * every prompt lifecycle point in `phase3-executor.ts`) rather than inventing a second cost
 * computation.
 *
 * PURELY OBSERVATIONAL, same posture as `forge status` (`src/cli/status-command.ts`) and for the
 * same reason: a separate CLI process must never mutate a running build's state. This module never
 * writes a file and never signals a running Phase 3 process — it only reads.
 *
 * Unlike `forge status --watch` (which waits indefinitely for a build to start), `forge dashboard`
 * is for an ALREADY-active or already-finished run: if no `.forge/runs/` directory exists yet, it
 * prints a clear message and returns immediately rather than hanging.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import chalk from 'chalk';

import { readLiveStatus } from '../tools/live-status.js';

const POLL_MS = 1500;
const MAX_RECENT_RESULTS = 8;
/** A run is flagged "stale" in the header if untouched this long — informational only, never
 *  gates whether the dashboard renders it. */
const STALE_WINDOW_MS = 15 * 60_000;

interface PromptRecord {
  ts: string;
  event: 'start' | 'gate' | 'end';
  index: number;
  id: string;
  name?: string;
  promptType?: string;
  checkName?: string;
  passed?: boolean;
  skipped?: boolean;
  detail?: string | null;
  disposition?: string;
  durationMs?: number;
  commitHash?: string | null;
  failedCheck?: string | null;
}

interface EventRecord {
  ts: string;
  level: string;
  message: string;
}

interface TestRecord {
  ts: string;
  id: string;
  runnerType: string;
  testSuite: string;
  status: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  promptId: string | null;
}

export interface DashboardGateCheck {
  checkName: string;
  passed: boolean;
  skipped: boolean;
  detail: string | null;
}

export interface DashboardRecentResult {
  index: number;
  id: string;
  name: string;
  disposition: string;
  durationMs: number;
}

export interface DashboardState {
  runId: string;
  runDir: string;
  startedAt: string | null;
  lastActivityAt: string | null;
  currentPrompt: { index: number; id: string; name: string; promptType: string } | null;
  gateChecks: DashboardGateCheck[];
  recentResults: DashboardRecentResult[];
  totalTests: { passed: number; failed: number; skipped: number };
  costUsd: number | null;
  tokensEstimated: number | null;
}

/** The mtime (ms) of the most-recently-touched telemetry file in a run dir, or of the dir itself
 *  if none of the known files exist yet — used both to pick "the" active run and to flag staleness. */
function latestMtimeMs(runDir: string): number {
  let latest = 0;
  for (const name of ['events.jsonl', 'prompts.jsonl', 'tests.jsonl', 'failures.jsonl', 'metrics.json']) {
    try {
      const mtimeMs = statSync(join(runDir, name)).mtimeMs;
      if (mtimeMs > latest) latest = mtimeMs;
    } catch {
      /* file not written yet — skip */
    }
  }
  try {
    const dirMtimeMs = statSync(runDir).mtimeMs;
    if (dirMtimeMs > latest) latest = dirMtimeMs;
  } catch {
    /* unreadable dir — leave at 0 */
  }
  return latest;
}

/** Find `.forge/runs/<run-id>/` for the most recently active run, or `null` if none exists.
 *  There is no "latest run" pointer file on disk (`getActiveRunRecorder` in
 *  `src/telemetry/run-recorder.ts` is an in-process singleton only, useless from a separate CLI
 *  process) — so this picks the run directory with the most recently modified telemetry file. */
export function findLatestRunDir(projectPath: string): string | null {
  const runsDir = join(projectPath, '.forge', 'runs');
  if (!existsSync(runsDir)) return null;

  let names: string[];
  try {
    names = readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  let best: { name: string; mtimeMs: number } | null = null;
  for (const name of names) {
    const mtimeMs = latestMtimeMs(join(runsDir, name));
    if (!best || mtimeMs > best.mtimeMs) best = { name, mtimeMs };
  }
  return best ? join(runsDir, best.name) : null;
}

/** Parse a `.jsonl` file into records, silently skipping unreadable/absent files and any
 *  partially-written last line (an in-flight `appendFileSync` can leave one). */
function parseJsonl<T>(filePath: string): T[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      /* partially-written trailing line — skip */
    }
  }
  return out;
}

/** Build the current dashboard snapshot from one run dir's jsonl files + live-status.json. Pure
 *  (besides the reads) — safe to call every poll tick. */
export function computeDashboardState(runDir: string, projectPath: string): DashboardState {
  const runId = runDir.split(/[\\/]/).filter(Boolean).pop() ?? runDir;

  const events = parseJsonl<EventRecord>(join(runDir, 'events.jsonl'));
  const prompts = parseJsonl<PromptRecord>(join(runDir, 'prompts.jsonl'));
  const tests = parseJsonl<TestRecord>(join(runDir, 'tests.jsonl'));

  const starts = prompts.filter((p) => p.event === 'start');
  const ends = prompts.filter((p) => p.event === 'end');
  const endedIds = new Set(ends.map((e) => e.id));

  // "current" = the most recent prompt that started but has no matching 'end' yet; if every
  // started prompt has ended, fall back to the last one started (so the dashboard still shows
  // something meaningful once a run finishes).
  let current: PromptRecord | null = null;
  for (let i = starts.length - 1; i >= 0; i--) {
    const candidate = starts[i];
    if (candidate && !endedIds.has(candidate.id)) {
      current = candidate;
      break;
    }
  }
  if (!current && starts.length > 0) current = starts[starts.length - 1] ?? null;

  const gateChecks: DashboardGateCheck[] = current
    ? prompts
        .filter((p): p is PromptRecord & { checkName: string } => p.event === 'gate' && p.id === current!.id && typeof p.checkName === 'string')
        .map((p) => ({ checkName: p.checkName, passed: !!p.passed, skipped: !!p.skipped, detail: p.detail ?? null }))
    : [];

  const recentResults: DashboardRecentResult[] = ends.slice(-MAX_RECENT_RESULTS).map((e) => ({
    index: e.index,
    id: e.id,
    name: e.name ?? e.id,
    disposition: e.disposition ?? 'unknown',
    durationMs: e.durationMs ?? 0,
  }));

  const totalTests = tests.reduce(
    (acc, t) => ({
      passed: acc.passed + (t.passed ?? 0),
      failed: acc.failed + (t.failed ?? 0),
      skipped: acc.skipped + (t.skipped ?? 0),
    }),
    { passed: 0, failed: 0, skipped: 0 }
  );

  const allTimestampsMs = [...events, ...prompts, ...tests]
    .map((r) => Date.parse(r.ts))
    .filter((n) => Number.isFinite(n));
  const startedAtMs = allTimestampsMs.length > 0 ? Math.min(...allTimestampsMs) : null;
  const lastActivityMs = allTimestampsMs.length > 0 ? Math.max(...allTimestampsMs) : null;

  // Reuse the SAME cost/token totals the running build itself writes to live-status.json
  // (src/tools/live-status.ts, sourced from ctx.costTracker.totalCostUsd() in phase3-executor.ts)
  // rather than recomputing cost from prompts.jsonl, which does not carry a cost field.
  const liveStatus = readLiveStatus(projectPath);

  return {
    runId,
    runDir,
    startedAt: startedAtMs !== null ? new Date(startedAtMs).toISOString() : null,
    lastActivityAt: lastActivityMs !== null ? new Date(lastActivityMs).toISOString() : null,
    currentPrompt: current
      ? { index: current.index, id: current.id, name: current.name ?? current.id, promptType: current.promptType ?? '' }
      : null,
    gateChecks,
    recentResults,
    totalTests,
    costUsd: liveStatus ? liveStatus.totals.costEstimatedUsd : null,
    tokensEstimated: liveStatus ? liveStatus.totals.tokensEstimated : null,
  };
}

/** Render a millisecond duration as a compact human string (`"12s"`, `"1m45s"`, `"2h03m"`). */
function humanDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function dispositionChip(disposition: string): string {
  switch (disposition) {
    case 'completed':
      return chalk.green('PASS');
    case 'halted':
      return chalk.red('HALT');
    case 'failed':
      return chalk.red('FAIL');
    case 'skipped':
      return chalk.dim('SKIP');
    default:
      return chalk.yellow(disposition.toUpperCase());
  }
}

/** Render one `DashboardState` snapshot as a console view. Pure — no I/O, easy to unit test. */
export function renderDashboard(state: DashboardState, now: number = Date.now()): string {
  const lines: string[] = [];
  lines.push(chalk.bold(`\nFORGE dashboard — run ${state.runId}`));
  lines.push(chalk.dim(state.runDir));

  const elapsed = state.startedAt ? humanDuration(now - Date.parse(state.startedAt)) : '—';
  lines.push(chalk.dim(`\nstarted ${state.startedAt ?? '—'}  ·  elapsed ${elapsed}`));

  if (state.lastActivityAt && now - Date.parse(state.lastActivityAt) > STALE_WINDOW_MS) {
    lines.push(chalk.yellow(`(no telemetry activity in over ${Math.round(STALE_WINDOW_MS / 60_000)}m — this run is probably finished or stalled)`));
  }

  if (state.currentPrompt) {
    const p = state.currentPrompt;
    lines.push(`\ncurrent:  #${p.index} '${p.id}' (${p.promptType || 'unknown'}) — ${p.name}`);
  } else {
    lines.push(chalk.dim('\ncurrent:  (no prompts recorded yet)'));
  }

  lines.push(chalk.bold('\nGate status:'));
  if (state.gateChecks.length === 0) {
    lines.push(chalk.dim('  (no gate checks recorded yet for the current prompt)'));
  } else {
    for (const g of state.gateChecks) {
      const chip = g.skipped ? chalk.dim('SKIP') : g.passed ? chalk.green('PASS') : chalk.red('FAIL');
      lines.push(`  ${chip}  ${g.checkName}${g.detail ? chalk.dim(`  — ${g.detail}`) : ''}`);
    }
  }

  lines.push(chalk.dim(`\ncost:     $${(state.costUsd ?? 0).toFixed(4)}    tokens: ~${state.tokensEstimated ?? 0}`));
  lines.push(
    chalk.dim(
      `tests:    ${state.totalTests.passed} passed, ${state.totalTests.failed} failed, ${state.totalTests.skipped} skipped`
    )
  );

  lines.push(chalk.bold('\nRecent results:'));
  if (state.recentResults.length === 0) {
    lines.push(chalk.dim('  (none yet)'));
  } else {
    for (const r of state.recentResults) {
      lines.push(`  ${dispositionChip(r.disposition)}  #${r.index} '${r.id}' (${humanDuration(r.durationMs)})`);
    }
  }

  return lines.join('\n');
}

/**
 * `forge dashboard [project-path]` — read-only live view of the current/most-recent build run.
 * Polls (never `fs.watch`, matching the polling approach `forge status --watch` already uses in
 * `src/cli/status-command.ts`) every `POLL_MS` and redraws in place with `console.clear()`.
 *
 * Exits immediately (no hang) when no `.forge/runs/` directory exists. Otherwise runs until
 * interrupted (Ctrl+C / SIGTERM), at which point it stops polling and returns — it never writes a
 * file or signals any other process.
 */
export async function runDashboard(projectPath: string): Promise<void> {
  const runDir = findLatestRunDir(projectPath);
  if (!runDir) {
    console.log(chalk.yellow(`\nNo build run found under ${join(projectPath, '.forge', 'runs')}.`));
    console.log(chalk.dim('Run `forge build <path>` to start one, then re-run `forge dashboard`.'));
    return;
  }

  await new Promise<void>((resolveWait) => {
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      console.log(chalk.dim('\n\nforge dashboard stopped.'));
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolveWait();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    const render = (): void => {
      const state = computeDashboardState(runDir, projectPath);
      console.clear();
      console.log(renderDashboard(state));
      console.log(chalk.dim(`\n(watching ${runDir} — refreshes every ${(POLL_MS / 1000).toFixed(1)}s, Ctrl+C to stop)`));
    };

    render();
    const timer = setInterval(render, POLL_MS);
  });
}
