// FORGE 2.0 — Enterprise Test Suite: single-suite INTEGRATION entry point (TESTING_BLUEPRINT.md §2 —
// Vitest, real wiring).
//
// Same shape as unit.ts: a direct `runIntegrationTests(projectPath, buildRunId, promptId)` call for
// a caller that only needs the INTEGRATION suite's result. Reuses `integration-runner.ts` (which
// spawns Vitest against `vitest.integration.config.ts` per the blueprint's chosen separate-config
// strategy — INTEGRATION tests spin/tear down real wiring via `test.globalSetup` and run
// non-concurrently) and the shared `persist.ts` write path — no second implementation of either.

import { getMachineId } from '../../learning/database.js';
import { RunnerType, type TestRunResult } from '../types.js';
import { logLine, persistRunnerOutcome } from './persist.js';
import { run } from './integration-runner.js';

/**
 * Run the INTEGRATION suite (`pnpm exec vitest run --config vitest.integration.config.ts --coverage
 * --reporter=json`) against `projectPath`, insert the resulting `test_run_results` row (+ coverage
 * snapshots when produced), and return the `TestRunResult`. A non-zero Vitest exit whose JSON report
 * still parsed is a test failure (`status: 'failed'`), never a runner `error`.
 */
export async function runIntegrationTests(
  projectPath: string,
  buildRunId: string | null,
  promptId: string | null
): Promise<TestRunResult> {
  const outcome = await run({ projectPath, log: logLine('testing') });
  return persistRunnerOutcome({
    runnerType: RunnerType.INTEGRATION,
    outcome,
    projectPath,
    buildRunId,
    promptId,
    trigger: 'MANUAL',
    machineId: getMachineId(),
  });
}

export default runIntegrationTests;
