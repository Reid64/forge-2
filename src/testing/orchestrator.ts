/**
 * FORGE 2.0 — Enterprise Test Suite: TestOrchestrator dispatcher (TESTING_BLUEPRINT.md §
 * TestOrchestrator, Agent Contract: TestOrchestrator).
 *
 * `runTests` is a non-fatal, injectable-collaborator agent in the same house style as
 * `phase4-sentinel.ts`: it NEVER throws and NEVER fabricates a pass. For every (trigger × runner)
 * pair requested, it invokes that runner's module (`src/testing/runners/`), writes one
 * `test_run_results` row via prepared statement (`src/memory/test-results.ts`), and — for UNIT/
 * INTEGRATION — writes the four `test_coverage_snapshots` rows coverage-v8 produced (T8). Build
 * Memory being unreachable degrades to stateless mode (Contract 4): a `null` insert still yields a
 * `TestRunResult` in the returned array, just without a persisted `id`.
 */

import { getMachineId } from '../learning/database.js';
import type { TestRunTrigger } from '../memory/test-results.js';
import { RunnerType, TriggerType, type TestOrchestratorOptions, type TestRunResult } from './types.js';
import type { RunnerInput, RunnerOutcome } from './runners/types.js';
import { logLine, persistRunnerOutcome } from './runners/persist.js';
import { run as runUnit } from './runners/unit-runner.js';
import { run as runIntegration } from './runners/integration-runner.js';
import { run as runApi } from './runners/api-runner.js';
import { run as runE2e } from './runners/e2e-runner.js';
import { run as runSecurity } from './runners/security-runner.js';
import { run as runPerformance } from './runners/performance-runner.js';
import { run as runDependency } from './runners/dependency-runner.js';
import { run as runTrivy } from './runners/trivy-runner.js';
import { run as runIac } from './runners/iac-runner.js';
import { run as runSbom } from './runners/sbom-runner.js';
import { run as runLicense } from './runners/license-runner.js';
import { run as runGitleaks } from './runners/gitleaks-runner.js';
import { run as runLighthouse } from './runners/lighthouse-runner.js';
import { run as runAccessibility } from './runners/accessibility-runner.js';
import { run as runVisualRegression } from './runners/visual-regression-runner.js';
import { run as runSeo } from './runners/seo-runner.js';
import { run as runMigrationSafety } from './runners/migration-safety-runner.js';
import { run as runSemgrep } from './runners/semgrep-runner.js';
import { run as runZap } from './runners/zap-runner.js';
import { run as runSchemathesis } from './runners/schemathesis-runner.js';

type RunnerFn = (input: RunnerInput) => Promise<RunnerOutcome>;

const RUNNERS: Record<RunnerType, RunnerFn> = {
  [RunnerType.UNIT]: runUnit,
  [RunnerType.INTEGRATION]: runIntegration,
  [RunnerType.API]: runApi,
  [RunnerType.E2E]: runE2e,
  [RunnerType.SECURITY]: runSecurity,
  [RunnerType.PERFORMANCE]: runPerformance,
  [RunnerType.DEPENDENCY]: runDependency,
  [RunnerType.TRIVY]: runTrivy,
  [RunnerType.SECRET_SCAN]: runGitleaks,
  [RunnerType.LIGHTHOUSE]: runLighthouse,
  [RunnerType.ACCESSIBILITY]: runAccessibility,
  [RunnerType.VISUAL_REGRESSION]: runVisualRegression,
  [RunnerType.SEO]: runSeo,
  [RunnerType.MIGRATION_SAFETY]: runMigrationSafety,
  [RunnerType.SEMGREP]: runSemgrep,
  [RunnerType.OWASP_ZAP]: runZap,
  [RunnerType.SCHEMATHESIS]: runSchemathesis,
  [RunnerType.IAC]: runIac,
  [RunnerType.SBOM]: runSbom,
  [RunnerType.LICENSE]: runLicense,
};

/** TriggerType -> test_run_results.trigger. The schema has no POST_DEPLOY value (F9/DeployVerifier
 *  writes to governance files, not this table) — POST_DEPLOY falls back to MANUAL rather than
 *  violating the CHECK constraint. */
const TRIGGER_DB: Record<TriggerType, TestRunTrigger> = {
  [TriggerType.POST_PROMPT]: 'POST_PROMPT',
  [TriggerType.PRE_DEPLOY]: 'PRE_DEPLOY',
  [TriggerType.SCHEDULED]: 'SCHEDULED',
  [TriggerType.MANUAL]: 'MANUAL',
  [TriggerType.POST_DEPLOY]: 'MANUAL',
};

/**
 * Dispatch every requested (trigger × runner) pair, persist each result, and return the
 * `TestRunResult[]` (T4 — every row carries machine_id and is persisted before the run is
 * "complete"). Always resolves; a runner that throws becomes an `error` result, not a crash.
 */
export async function runTests(options: TestOrchestratorOptions): Promise<TestRunResult[]> {
  const projectPath = options.projectPath;
  const machineId = getMachineId();
  const log = logLine('testing');
  const results: TestRunResult[] = [];

  for (const trigger of options.triggers) {
    for (const runnerType of options.runners) {
      const runnerFn = RUNNERS[runnerType];
      if (!runnerFn) continue;

      let outcome: RunnerOutcome;
      try {
        outcome = await runnerFn({ projectPath, log });
      } catch (error) {
        outcome = {
          runner: runnerType.toLowerCase(),
          status: 'error',
          testsTotal: 0,
          testsPassed: 0,
          testsFailed: 0,
          testsSkipped: 0,
          durationMs: 0,
          failures: [],
          reportPath: null,
          exitCode: null,
          detail: `runner threw: ${error instanceof Error ? error.message : String(error)}`,
          coverage: null,
        };
      }

      const result = await persistRunnerOutcome({
        runnerType,
        outcome,
        projectPath,
        buildRunId: options.buildRunId,
        promptId: options.promptId,
        trigger: TRIGGER_DB[trigger],
        machineId,
      });
      results.push(result);
    }
  }

  return results;
}

export default runTests;
