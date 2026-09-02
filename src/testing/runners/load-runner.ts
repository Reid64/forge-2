// FORGE 2.0 — Enterprise Test Suite: LOAD runner (TESTING_BLUEPRINT.md §6 — k6, load profile).
//
// Load testing: sustained traffic at the target's EXPECTED steady-state request rate, to confirm
// it holds up under normal-to-peak conditions declared in `k6/load.js`'s own VU/duration staging.
// Same shape as performance-runner.ts (a single-request-latency check) but scoped to sustained
// concurrent load rather than one-shot response-time thresholds — a distinct k6 script/profile,
// not a duplicate of `k6/performance.js`.
//
// k6 is an optional external binary (TOOLCHAIN.md — "to-detect"); a target project without a
// k6/load.js scaffold or without the k6 binary on PATH SKIPs with a reason rather than faking a
// pass (T1) — matching Sentinel's existing optional-binary degrade pattern.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { defaultShellRunner } from './exec.js';
import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

const DEFAULT_K6_TIMEOUT_MS = 10 * 60 * 1000;
const REPORT_FILE = '.forge/test-reports/load-summary.json';

interface K6Threshold {
  ok?: boolean;
}

interface K6Metric {
  thresholds?: Record<string, K6Threshold>;
}

interface K6Summary {
  metrics?: Record<string, K6Metric>;
}

async function k6OnPath(cwd: string): Promise<boolean> {
  const result = await defaultShellRunner('k6 version', cwd, 10_000);
  return result.ok;
}

/** Evaluate every declared k6 threshold; a crossed threshold is a failure (T1 — no fake pass). */
function evaluateThresholds(summary: K6Summary): { total: number; met: number; crossed: RunnerFailure[] } {
  const crossed: RunnerFailure[] = [];
  let total = 0;
  let met = 0;
  for (const [metricName, metric] of Object.entries(summary.metrics ?? {})) {
    for (const [thresholdExpr, threshold] of Object.entries(metric.thresholds ?? {})) {
      total++;
      if (threshold.ok) {
        met++;
      } else {
        crossed.push({ name: metricName, message: `threshold crossed: ${thresholdExpr}`, file: 'k6/load.js' });
      }
    }
  }
  return { total, met, crossed };
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  const scriptPath = join(input.projectPath, 'k6', 'load.js');

  if (!existsSync(scriptPath)) {
    return skippedOutcome('k6-load', 'no k6/load.js in target project — SKIP (governance scaffold not generated)');
  }
  if (!(await k6OnPath(input.projectPath))) {
    return skippedOutcome('k6-load', 'k6 binary not on PATH — SKIP (k6_not_installed, T1)');
  }

  const command = `k6 run --summary-export=${REPORT_FILE} k6/load.js`;
  input.log(`k6 (load): ${command}`);
  const result = await defaultShellRunner(command, input.projectPath, input.timeoutMs ?? DEFAULT_K6_TIMEOUT_MS);
  const durationMs = Date.now() - started;

  let raw: string | null = null;
  try {
    raw = await readFile(join(input.projectPath, REPORT_FILE), 'utf8');
  } catch {
    raw = null;
  }
  if (raw === null) {
    return errorOutcome('k6-load', result.timedOut ? 'k6 load run timed out' : 'k6 produced no summary export', durationMs, result.exitCode);
  }

  try {
    const summary = JSON.parse(raw) as K6Summary;
    const { total, met, crossed } = evaluateThresholds(summary);
    const status: RunnerOutcome['status'] = crossed.length > 0 ? 'failed' : 'passed';
    return {
      runner: 'k6-load',
      status,
      testsTotal: total,
      testsPassed: met,
      testsFailed: crossed.length,
      testsSkipped: 0,
      durationMs,
      failures: crossed,
      reportPath: REPORT_FILE,
      exitCode: result.exitCode,
      detail: status === 'passed' ? `${met}/${total} load thresholds met` : `${crossed.length}/${total} load thresholds crossed`,
      coverage: null,
    };
  } catch {
    return errorOutcome('k6-load', 'k6 load summary export was unparsable', durationMs, result.exitCode);
  }
}
