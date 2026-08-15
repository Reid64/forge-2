// FORGE 2.0 — Enterprise Test Suite: SCHEMATHESIS runner (API contract testing).
//
// Reuses phase4-sentinel.ts's already-working Ring 3e check (`runRing3SchemathesisCheck`) rather
// than re-implementing the dev-server boot + schema discovery + `schemathesis run` invocation +
// JUnit parsing — DRY, per the blueprint's "reuse, never re-implement" rule. Additive only:
// Sentinel's own Ring 3 gate behavior is untouched: this runner just calls the same exported check
// function from a second call site (TestOrchestrator).

import { runRing3SchemathesisCheck } from '../../phases/phase4-sentinel.js';
import { defaultShellRunner } from './exec.js';
import { outcomeFromCheckResult } from './sentinel-check.js';
import { errorOutcome, type RunnerInput, type RunnerOutcome } from './types.js';

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  try {
    const check = await runRing3SchemathesisCheck(input.projectPath, defaultShellRunner, input.log);
    return outcomeFromCheckResult('schemathesis', check);
  } catch (error) {
    return errorOutcome(
      'schemathesis',
      `Schemathesis API contract test threw: ${error instanceof Error ? error.message : String(error)}`,
      Date.now() - started
    );
  }
}
