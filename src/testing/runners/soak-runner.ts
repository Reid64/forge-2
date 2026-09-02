// FORGE 2.0 — Enterprise Test Suite: SOAK runner (TESTING_BLUEPRINT.md §6 — k6, soak profile).
//
// Soak (endurance) testing: MODERATE, sustained load held for an EXTENDED duration, to surface
// degradation that only appears over time — memory leaks, connection-pool exhaustion, unbounded
// cache growth — rather than load-runner.ts's "expected traffic, normal duration" or
// stress-runner.ts's "beyond capacity, find the breaking point" checks. `k6/soak.js` is expected
// to declare its own long-duration staging; this runner only evaluates whatever thresholds that
// script defines, same as its load/stress/performance siblings.
//
// k6 is an optional external binary (TOOLCHAIN.md — "to-detect"); a target project without a
// k6/soak.js scaffold or without the k6 binary on PATH SKIPs with a reason rather than faking a
// pass (T1) — matching Sentinel's existing optional-binary degrade pattern. NOTE: a real soak run
// can legitimately take much longer than this runner's other siblings — callers that request SOAK
// should pass a correspondingly larger `timeoutMs`; the default here is intentionally generous.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { defaultShellRunner } from './exec.js';
import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

const DEFAULT_K6_TIMEOUT_MS = 30 * 60 * 1000;
const REPORT_FILE = '.forge/test-reports/soak-summary.json';

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
        crossed.push({ name: metricName, message: `threshold crossed: ${thresholdExpr}`, file: 'k6/soak.js' });
      }
    }
  }
  return { total, met, crossed };
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  const scriptPath = join(input.projectPath, 'k6', 'soak.js');

  if (!existsSync(scriptPath)) {
    return skippedOutcome('k6-soak', 'no k6/soak.js in target project — SKIP (governance scaffold not generated)');
  }
  if (!(await k6OnPath(input.projectPath))) {
    return skippedOutcome('k6-soak', 'k6 binary not on PATH — SKIP (k6_not_installed, T1)');
  }

  const command = `k6 run --summary-export=${REPORT_FILE} k6/soak.js`;
  input.log(`k6 (soak): ${command}`);
  const result = await defaultShellRunner(command, input.projectPath, input.timeoutMs ?? DEFAULT_K6_TIMEOUT_MS);
  const durationMs = Date.now() - started;

  let raw: string | null = null;
  try {
    raw = await readFile(join(input.projectPath, REPORT_FILE), 'utf8');
  } catch {
    raw = null;
  }
  if (raw === null) {
    return errorOutcome('k6-soak', result.timedOut ? 'k6 soak run timed out' : 'k6 produced no summary export', durationMs, result.exitCode);
  }

  try {
    const summary = JSON.parse(raw) as K6Summary;
    const { total, met, crossed } = evaluateThresholds(summary);
    const status: RunnerOutcome['status'] = crossed.length > 0 ? 'failed' : 'passed';
    return {
      runner: 'k6-soak',
      status,
      testsTotal: total,
      testsPassed: met,
      testsFailed: crossed.length,
      testsSkipped: 0,
      durationMs,
      failures: crossed,
      reportPath: REPORT_FILE,
      exitCode: result.exitCode,
      detail: status === 'passed' ? `${met}/${total} soak thresholds met` : `${crossed.length}/${total} soak thresholds crossed`,
      coverage: null,
    };
  } catch {
    return errorOutcome('k6-soak', 'k6 soak summary export was unparsable', durationMs, result.exitCode);
  }
}
