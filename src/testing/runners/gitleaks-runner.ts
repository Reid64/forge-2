// FORGE 2.0 — Enterprise Test Suite: GITLEAKS runner (secret scan).
//
// Reuses phase4-sentinel.ts's already-working Ring 3b check (`runRing3GitleaksCheck`) rather than
// re-implementing the `gitleaks detect` invocation + report parsing — DRY, per the blueprint's
// "reuse, never re-implement" rule. Additive only: Sentinel's own Ring 3 gate behavior is
// untouched: this runner just calls the same exported check function from a second call site
// (TestOrchestrator).

import { runRing3GitleaksCheck } from '../../phases/phase4-sentinel.js';
import { defaultShellRunner } from './exec.js';
import { outcomeFromCheckResult } from './sentinel-check.js';
import { errorOutcome, type RunnerInput, type RunnerOutcome } from './types.js';

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  try {
    const check = await runRing3GitleaksCheck(input.projectPath, defaultShellRunner, input.log);
    return outcomeFromCheckResult('gitleaks', check);
  } catch (error) {
    return errorOutcome(
      'gitleaks',
      `gitleaks scan threw: ${error instanceof Error ? error.message : String(error)}`,
      Date.now() - started
    );
  }
}
