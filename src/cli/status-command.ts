/**
 * FORGE 2.0 — Live build-status rendering for `forge status` (Session 4 — Intelligence &
 * Observability, Task 3).
 *
 * Reads `<project>/.forge/live-status.json` (written by `src/tools/live-status.ts` at every
 * prompt lifecycle point during a running build) and renders it as a console dashboard. Works
 * from a completely separate process/terminal than the build itself — the two are coupled only
 * through the JSON file.
 */

import { resolve } from 'node:path';

import chalk from 'chalk';

import { readLiveStatus, type LiveStatus, type LiveStatusPhase } from '../tools/live-status.js';

/** A build is considered "live" (worth showing by default) if updated within this window. */
const FRESH_WINDOW_MS = 15 * 60_000;

function phaseLabel(phase: LiveStatusPhase): string {
  switch (phase) {
    case 'start':
      return chalk.cyan('starting');
    case 'assembled':
      return chalk.cyan('assembled');
    case 'executing':
      return chalk.cyan('executing');
    case 'sentinel':
      return chalk.cyan('sentinel');
    case 'merged':
      return chalk.green('merged');
    case 'failed':
      return chalk.red('failed');
    case 'recovering':
      return chalk.yellow('recovering');
    case 'skipped':
      return chalk.dim('skipped');
    default:
      return String(phase);
  }
}

/** True when the status file was updated recently enough to represent an active/recent build. */
export function isLiveStatusFresh(status: LiveStatus, now: number = Date.now()): boolean {
  const updated = Date.parse(status.updatedAt);
  return Number.isFinite(updated) && now - updated <= FRESH_WINDOW_MS;
}

/** Render a `LiveStatus` snapshot as a clean console dashboard. */
export function renderLiveStatusConsole(status: LiveStatus): string {
  const lines: string[] = [];
  lines.push(chalk.bold(`\nFORGE build status — ${status.project}`) + chalk.dim(`  (${status.buildRunId ?? 'stateless'})`));
  lines.push(chalk.dim(`started ${status.startedAt}  ·  updated ${status.updatedAt}`));

  if (status.currentPrompt) {
    const p = status.currentPrompt;
    lines.push(`\ncurrent:  #${p.index} '${p.id}' (${p.type}) — ${phaseLabel(p.phase)}`);
  } else {
    lines.push(chalk.dim('\ncurrent:  (none yet)'));
  }

  const t = status.totals;
  lines.push(
    `\ntotals:   ${chalk.green(`${t.completed} done`)}, ${chalk.red(`${t.failed} failed`)}, ` +
      `${chalk.dim(`${t.remaining} remaining`)}`
  );
  lines.push(chalk.dim(`tokens:   ~${t.tokensEstimated}    cost ≈ $${t.costEstimatedUsd.toFixed(4)}`));

  if (status.lastSentinel) {
    lines.push(
      `sentinel: ${status.lastSentinel.passed ? chalk.green('PASS') : chalk.red(`FAIL (${status.lastSentinel.failedCheck ?? '?'})`)}`
    );
  }
  lines.push(`brain interventions: ${status.brainInterventions}`);

  lines.push(chalk.bold('\nRecent events:'));
  const recent = status.recentEvents.slice(-10);
  if (recent.length === 0) {
    lines.push(chalk.dim('  (none yet)'));
  } else {
    for (const e of recent) lines.push(chalk.dim(`  ${e.timestamp}  `) + e.message);
  }

  return lines.join('\n');
}

export interface LiveStatusCommandOptions {
  project?: string;
  watch?: boolean;
}

/**
 * `forge status --project <path> [--watch]` live-dashboard path. Returns `true` when a
 * live-status.json was found and rendered (the caller should stop — no DB fallback needed);
 * `false` when none exists (the caller falls back to the historical Build Memory query).
 *
 * `--watch` polls every 2s and re-renders until the process is interrupted (Ctrl+C).
 */
export async function tryRenderLiveStatus(opts: LiveStatusCommandOptions): Promise<boolean> {
  const projectPath = resolve(opts.project ?? process.cwd());
  const status = readLiveStatus(projectPath);

  if (!status) {
    if (opts.watch) {
      console.log(chalk.yellow(`\nNo live-status.json found at ${projectPath}/.forge/live-status.json yet.`));
      console.log(chalk.dim('Waiting for a build to start (Ctrl+C to stop)…'));
      await watchLoop(projectPath);
      return true;
    }
    return false;
  }

  if (!opts.watch) {
    console.log(renderLiveStatusConsole(status));
    return true;
  }

  await watchLoop(projectPath);
  return true;
}

/** Poll live-status.json every 2s and re-render until the process is killed. Never resolves. */
async function watchLoop(projectPath: string): Promise<void> {
  const render = (): void => {
    const current = readLiveStatus(projectPath);
    console.clear();
    if (current) {
      console.log(renderLiveStatusConsole(current));
      console.log(chalk.dim('\n(watching — refreshes every 2s, Ctrl+C to stop)'));
    } else {
      console.log(chalk.yellow(`No live-status.json found at ${projectPath}/.forge/live-status.json.`));
    }
  };
  render();
  await new Promise<void>(() => {
    setInterval(render, 2000);
  });
}
