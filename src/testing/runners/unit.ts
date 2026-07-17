// FORGE 2.0 — Enterprise Test Suite: single-suite UNIT entry point (TESTING_BLUEPRINT.md §1 —
// Vitest + coverage-v8).
//
// `orchestrator.ts` batches suites across triggers for the full TestOrchestrator dispatch; this is
// the direct `runUnitTests(projectPath, buildRunId, promptId)` call for a caller that only needs one
// suite's result. It reuses the exact same Vitest spawn/JSON-parse path as the batch dispatcher
// (`unit-runner.ts` -> `vitest-shared.ts`) and the exact same persistence path (`persist.ts`) — no
// second implementation of either.

import { getMachineId } from '../../learning/database.js';
import { RunnerType, type TestRunResult } from '../types.js';
import { logLine, persistRunnerOutcome } from './persist.js';
import { run } from './unit-runner.js';

/**
 * Run the UNIT suite (`pnpm exec vitest run --coverage --reporter=json`) against `projectPath`,
 * insert the resulting `test_run_results` row (+ coverage snapshots when produced), and return the
 * `TestRunResult`. A non-zero Vitest exit whose JSON report still parsed is a test failure
 * (`status: 'failed'`), never a runner `error` — only a crash or unparsable report is `error`.
 */
export async function runUnitTests(
  projectPath: string,
  buildRunId: string | null,
  promptId: string | null
): Promise<TestRunResult> {
  const outcome = await run({ projectPath, log: logLine('testing') });
  return persistRunnerOutcome({
    runnerType: RunnerType.UNIT,
    outcome,
    projectPath,
    buildRunId,
    promptId,
    trigger: 'MANUAL',
    machineId: getMachineId(),
  });
}

export default runUnitTests;
