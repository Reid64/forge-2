// FORGE 2.0 — Enterprise Test Suite: API runner (TESTING_BLUEPRINT.md §3 — Vitest + native fetch).

import { runVitestSuite } from './vitest-shared.js';
import type { RunnerInput, RunnerOutcome } from './types.js';

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  return runVitestSuite(input, {
    configFile: 'vitest.api.config.ts',
    reportFile: '.forge/test-reports/api.json',
    coverage: false,
  });
}
