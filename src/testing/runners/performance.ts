// FORGE 2.0 — Enterprise Test Suite: single-suite PERFORMANCE entry point (TESTING_BLUEPRINT.md
// §6 — k6).
//
// Same shape as unit.ts: a direct `runPerformanceTests(projectPath, buildRunId, promptId)` call for
// a caller that only needs the PERFORMANCE suite's result. Reuses performance-runner.ts's k6 spawn +
// `--summary-export` JSON parse (project `k6/performance.js`, SKIP-with-reason when the script or
// the k6 binary is absent — T1) and the shared persist.ts write path — no second implementation of
// either.

import { getMachineId } from '../../learning/database.js';
import { RunnerType, type TestRunResult } from '../types.js';
import { logLine, persistRunnerOutcome } from './persist.js';
import { run } from './performance-runner.js';

/**
 * Run the PERFORMANCE suite (`k6 run --summary-export=... k6/performance.js`) against `projectPath`
 * when a k6 script and binary are present, insert the resulting `test_run_results` row, and return
 * the `TestRunResult`. A crossed threshold is `status: 'failed'`; a missing script/binary is
 * `status: 'skipped'` — never a fabricated pass (T1).
 */
export async function runPerformanceTests(
  projectPath: string,
  buildRunId: string | null,
  promptId: string | null
): Promise<TestRunResult> {
  const outcome = await run({ projectPath, log: logLine('testing') });
  return persistRunnerOutcome({
    runnerType: RunnerType.PERFORMANCE,
    outcome,
    projectPath,
    buildRunId,
    promptId,
    trigger: 'MANUAL',
    machineId: getMachineId(),
  });
}

export default runPerformanceTests;
