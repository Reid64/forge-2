// FORGE 2.0 — Enterprise Test Suite: TRIVY runner (dependency/container/IaC vulnerability scan).
//
// Reuses phase4-sentinel.ts's already-working Ring 3a check (`runRing3TrivyCheck`) rather than
// re-implementing the `trivy fs` invocation + JSON parsing — DRY, per the blueprint's "reuse,
// never re-implement" rule. Additive only: Sentinel's own Ring 3 gate behavior is untouched: this
// runner just calls the same exported check function from a second call site (TestOrchestrator).

import { runRing3TrivyCheck } from '../../phases/phase4-sentinel.js';
import { defaultShellRunner } from './exec.js';
import { outcomeFromCheckResult } from './sentinel-check.js';
import { errorOutcome, type RunnerInput, type RunnerOutcome } from './types.js';

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  try {
    const check = await runRing3TrivyCheck(input.projectPath, defaultShellRunner, input.log);
    return outcomeFromCheckResult('trivy', check);
  } catch (error) {
    return errorOutcome(
      'trivy',
      `trivy scan threw: ${error instanceof Error ? error.message : String(error)}`,
      Date.now() - started
    );
  }
}
