// FORGE 2.0 — Enterprise Test Suite: LIGHTHOUSE runner (performance/accessibility/best-practices/SEO).
//
// Reuses phase4-sentinel.ts's already-working Ring 3c check (`runRing3LighthouseCheck`) rather
// than re-implementing the dev-server boot + `lighthouse` invocation + report parsing — DRY, per
// the blueprint's "reuse, never re-implement" rule. Additive only: Sentinel's own Ring 3 gate
// behavior is untouched: this runner just calls the same exported check function from a second
// call site (TestOrchestrator).

import { runRing3LighthouseCheck } from '../../phases/phase4-sentinel.js';
import { defaultShellRunner } from './exec.js';
import { outcomeFromCheckResult } from './sentinel-check.js';
import { errorOutcome, type RunnerInput, type RunnerOutcome } from './types.js';

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  try {
    const check = await runRing3LighthouseCheck(input.projectPath, defaultShellRunner, input.log);
    return outcomeFromCheckResult('lighthouse', check);
  } catch (error) {
    return errorOutcome(
      'lighthouse',
      `lighthouse audit threw: ${error instanceof Error ? error.message : String(error)}`,
      Date.now() - started
    );
  }
}
