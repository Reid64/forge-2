// FORGE 2.0 — Enterprise Test Suite: INTEGRATION runner (TESTING_BLUEPRINT.md §2 — Vitest, real wiring).

import { runVitestSuite } from './vitest-shared.js';
import type { RunnerInput, RunnerOutcome } from './types.js';

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  return runVitestSuite(input, {
    configFile: 'vitest.integration.config.ts',
    reportFile: '.forge/test-reports/integration.json',
    coverage: true,
  });
}
