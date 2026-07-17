// FORGE 2.0 — Enterprise Test Suite: single-suite E2E entry point (TESTING_BLUEPRINT.md §4 —
// @playwright/test).
//
// Same shape as unit.ts/integration.ts: a direct `runE2eTests(projectPath, buildRunId, promptId)`
// call for a caller that only needs the E2E suite's result. Reuses `e2e-runner.ts` (spawns
// `playwright test --reporter=json` and parses the JSON reporter into a `RunnerOutcome`) and the
// shared `persist.ts` write path — no second implementation of either.

import { getMachineId } from '../../learning/database.js';
import { RunnerType, type TestRunResult } from '../types.js';
import { logLine, persistRunnerOutcome } from './persist.js';
import { run } from './e2e-runner.js';

/**
 * Run the E2E suite (`playwright test --reporter=json`) against `projectPath`, insert the
 * resulting `test_run_results` row, and return the `TestRunResult`. A non-zero Playwright exit
 * whose JSON report still parsed is a test failure (`status: 'failed'`), never a runner `error` —
 * only a crash or unparsable report is `error`.
 */
export async function runE2eTests(
  projectPath: string,
  buildRunId: string | null,
  promptId: string | null
): Promise<TestRunResult> {
  const outcome = await run({ projectPath, log: logLine('testing') });
  return persistRunnerOutcome({
    runnerType: RunnerType.E2E,
    outcome,
    projectPath,
    buildRunId,
    promptId,
    trigger: 'MANUAL',
    machineId: getMachineId(),
  });
}

export default runE2eTests;
