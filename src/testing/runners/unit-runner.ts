// FORGE 2.0 — Enterprise Test Suite: UNIT runner (TESTING_BLUEPRINT.md §1 — Vitest + coverage-v8).

import { runVitestSuite } from './vitest-shared.js';
import type { RunnerInput, RunnerOutcome } from './types.js';

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  return runVitestSuite(input, {
    reportFile: '.forge/test-reports/unit.json',
    coverage: true,
  });
}
