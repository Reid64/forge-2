// FORGE 2.0 — Enterprise Test Suite: single-suite DEPENDENCY entry point (TESTING_BLUEPRINT.md
// §13 — pnpm audit).
//
// Same shape as unit.ts: a direct `runDependencyTests(projectPath, buildRunId, promptId)` call for
// a caller that only needs the DEPENDENCY suite's result. Reuses dependency-runner.ts's `pnpm audit
// --json` spawn/parse (leniently handles both the npm-compatible `advisories` shape and the
// per-package `vulnerabilities` shape) and the shared persist.ts write path — no second
// implementation of either.

import { getMachineId } from '../../learning/database.js';
import { RunnerType, type TestRunResult } from '../types.js';
import { logLine, persistRunnerOutcome } from './persist.js';
import { run } from './dependency-runner.js';

/**
 * Run the DEPENDENCY suite (`pnpm audit --json`) against `projectPath`, insert the resulting
 * `test_run_results` row (mapped to the `DEPENDENCY_SCAN` test_suite value), and return the
 * `TestRunResult`. Any CRITICAL advisory is `status: 'failed'`; a run with no parseable output is
 * `status: 'skipped'` — never a fabricated pass (T1).
 */
export async function runDependencyTests(
  projectPath: string,
  buildRunId: string | null,
  promptId: string | null
): Promise<TestRunResult> {
  const outcome = await run({ projectPath, log: logLine('testing') });
  return persistRunnerOutcome({
    runnerType: RunnerType.DEPENDENCY,
    outcome,
    projectPath,
    buildRunId,
    promptId,
    trigger: 'MANUAL',
    machineId: getMachineId(),
  });
}

export default runDependencyTests;
