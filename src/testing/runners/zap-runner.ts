// FORGE 2.0 — Enterprise Test Suite: OWASP ZAP runner (DAST — dynamic application security testing).
//
// Reuses phase4-sentinel.ts's already-working Ring 3d check (`runRing3ZapCheck`) rather than
// re-implementing the dev-server boot + `zap-baseline.py` invocation + report parsing — DRY, per
// the blueprint's "reuse, never re-implement" rule. Additive only: Sentinel's own Ring 3 gate
// behavior is untouched: this runner just calls the same exported check function from a second
// call site (TestOrchestrator).

import { runRing3ZapCheck } from '../../phases/phase4-sentinel.js';
import { defaultShellRunner } from './exec.js';
import { outcomeFromCheckResult } from './sentinel-check.js';
import { errorOutcome, type RunnerInput, type RunnerOutcome } from './types.js';

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  try {
    const check = await runRing3ZapCheck(input.projectPath, defaultShellRunner, input.log);
    return outcomeFromCheckResult('owasp_zap', check);
  } catch (error) {
    return errorOutcome(
      'owasp_zap',
      `OWASP ZAP DAST scan threw: ${error instanceof Error ? error.message : String(error)}`,
      Date.now() - started
    );
  }
}
