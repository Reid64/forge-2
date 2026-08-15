// FORGE 2.0 — Enterprise Test Suite: SEMGREP runner (SAST — static application security testing).
//
// Reuses phase4-sentinel.ts's already-working Ring 2b check (`runRing2SemgrepCheck`) rather than
// re-implementing the `semgrep --config=auto --config=p/owasp-top-ten` invocation + JSON parsing —
// DRY, per the blueprint's "reuse, never re-implement" rule. Additive only: Sentinel's own Ring 2
// gate behavior is untouched: this runner just calls the same exported check function from a second
// call site (TestOrchestrator).

import { runRing2SemgrepCheck } from '../../phases/phase4-sentinel.js';
import { defaultShellRunner } from './exec.js';
import { outcomeFromCheckResult } from './sentinel-check.js';
import { errorOutcome, type RunnerInput, type RunnerOutcome } from './types.js';

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  try {
    const check = await runRing2SemgrepCheck(input.projectPath, defaultShellRunner, input.log);
    return outcomeFromCheckResult('semgrep', check);
  } catch (error) {
    return errorOutcome(
      'semgrep',
      `semgrep SAST scan threw: ${error instanceof Error ? error.message : String(error)}`,
      Date.now() - started
    );
  }
}
