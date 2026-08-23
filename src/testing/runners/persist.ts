// FORGE 2.0 — Enterprise Test Suite: shared runner-outcome persistence (test_run_results +
// test_coverage_snapshots + FORGE-1.0 log line).
//
// Extracted from orchestrator.ts so single-suite entry points (unit.ts, integration.ts) and the
// batch TestOrchestrator dispatcher (orchestrator.ts) share one insert/log path — never a second
// copy of the DB write, the coverage-snapshot fan-out, or the FORGE-1.0 progress line format.

import { basename } from 'node:path';

import {
  insertCoverageSnapshot,
  insertTestRunResult,
  getLatestCoverageSnapshot,
  type CoverageType,
  type TestRunTrigger,
  type TestSuiteDb,
} from '../../memory/test-results.js';
import { RunnerType, type TestRunResult } from '../types.js';
import type { RunnerOutcome } from './types.js';
import { getActiveRunRecorder } from '../../telemetry/run-recorder.js';

const COVERAGE_THRESHOLD_DEFAULT = 0.8;
const COVERAGE_THRESHOLD_BRANCH = 0.7;
const MAX_FAILURE_SUMMARY = 20;

/** RunnerType (src/testing/types.ts) -> test_run_results.test_suite (the DB's CHECK-constrained
 *  19-value enum). Several RunnerTypes share one TestSuiteDb value on purpose — e.g. both
 *  DEPENDENCY (pnpm audit) and TRIVY write DEPENDENCY_SCAN — the enum is a coarser category than
 *  the concrete tool, distinguished by `runner` (SCHEMA_ADDITIONS §5), not `test_suite`. Entries
 *  with no exact TestSuiteDb match (SECRET_SCAN, LIGHTHOUSE, SEO, MIGRATION_SAFETY, SEMGREP,
 *  OWASP_ZAP, SCHEMATHESIS) map to the closest existing category — SEMGREP (SAST) and
 *  MIGRATION_SAFETY share STATIC_ANALYSIS, OWASP_ZAP (DAST) shares DYNAMIC_ANALYSIS with SEO, and
 *  SCHEMATHESIS (API contract testing) shares API with the hand-written API runner — no new enum
 *  values were added, only the existing 19-value CHECK constraint is used.
 *
 *  IAC/SBOM/LICENSE (added in schema 3.4.0 for iac-runner.ts/sbom-runner.ts/license-runner.ts) ARE
 *  new, dedicated TestSuiteDb values — unlike the reuses above, checkov/SBOM/license findings are
 *  deliberately NOT folded into STATIC_ANALYSIS or DEPENDENCY_SCAN, because those two categories
 *  are already required starting at a lower readiness tier (PRODUCTION_READY_MVP / COMMERCIAL_SAAS
 *  respectively); a dedicated value is what lets `readiness-levels.ts` withhold them until the
 *  MILESTONE/PRE-DEPLOYMENT tiers instead.
 *
 *  PYTHON_PROPERTY (pytest+Hypothesis) and FASTCHECK (fast-check) BOTH map to the new PROPERTY_BASED
 *  value (schema 3.5.0) — back to the DEPENDENCY_SCAN-style reuse pattern, since these two runners
 *  are meant to be gated identically (alongside UNIT, at every tier) rather than kept apart the way
 *  IAC/SBOM/LICENSE needed to be.
 *
 *  MUTATION (Stryker Mutator — schema 3.6.0) is its own dedicated TestSuiteDb value, back to the
 *  IAC/SBOM/LICENSE-style reasoning: mutation findings are not folded into STATIC_ANALYSIS or UNIT
 *  because both are required starting at much lower readiness tiers, and a dedicated value is what
 *  lets `readiness-levels.ts` withhold it until MILESTONE/ENTERPRISE_RELEASE specifically.
 *
 *  CHAOS/DISASTER_RECOVERY/BACKUP_RESTORE (chaos-runner.ts/recovery-runner.ts/
 *  backup-restore-runner.ts) map 1:1 to their own, already-existing TestSuiteDb values (present in
 *  the CHECK constraint since before schema 3.4.0 — no new migration needed) — one-to-one rather
 *  than a shared category, matching MUTATION's reasoning: each is gated to ENTERPRISE_RELEASE ONLY
 *  in the RunnerType doc comments above, and a dedicated value is what keeps that withholding
 *  expressible. */
export const TEST_SUITE_DB: Record<RunnerType, TestSuiteDb> = {
  [RunnerType.UNIT]: 'UNIT',
  [RunnerType.INTEGRATION]: 'INTEGRATION',
  [RunnerType.API]: 'API',
  [RunnerType.E2E]: 'E2E',
  [RunnerType.SECURITY]: 'SECURITY',
  [RunnerType.PERFORMANCE]: 'PERFORMANCE',
  [RunnerType.DEPENDENCY]: 'DEPENDENCY_SCAN',
  [RunnerType.TRIVY]: 'DEPENDENCY_SCAN',
  [RunnerType.SECRET_SCAN]: 'SECURITY',
  [RunnerType.LIGHTHOUSE]: 'PERFORMANCE',
  [RunnerType.ACCESSIBILITY]: 'ACCESSIBILITY',
  [RunnerType.VISUAL_REGRESSION]: 'VISUAL_REGRESSION',
  [RunnerType.SEO]: 'DYNAMIC_ANALYSIS',
  [RunnerType.MIGRATION_SAFETY]: 'STATIC_ANALYSIS',
  [RunnerType.SEMGREP]: 'STATIC_ANALYSIS',
  [RunnerType.OWASP_ZAP]: 'DYNAMIC_ANALYSIS',
  [RunnerType.SCHEMATHESIS]: 'API',
  [RunnerType.IAC]: 'IAC',
  [RunnerType.SBOM]: 'SBOM',
  [RunnerType.LICENSE]: 'LICENSE',
  [RunnerType.PYTHON_PROPERTY]: 'PROPERTY_BASED',
  [RunnerType.FASTCHECK]: 'PROPERTY_BASED',
  [RunnerType.MUTATION]: 'MUTATION',
  [RunnerType.CHAOS]: 'CHAOS',
  [RunnerType.DISASTER_RECOVERY]: 'DISASTER_RECOVERY',
  [RunnerType.BACKUP_RESTORE]: 'BACKUP_RESTORE',
};

const ANSI_RESET = '\x1b[0m';
/** forge.ps1 `Log -level` parity — green PASS, red FAIL/ERROR, yellow WARN (skip), cyan INFO. */
const ANSI_COLOR: Record<string, string> = {
  passed: '\x1b[32m',
  failed: '\x1b[31m',
  error: '\x1b[31m',
  skipped: '\x1b[33m',
};

function twoDigit(n: number): string {
  return String(n).padStart(2, '0');
}

/** `[HH:mm:ss] [LEVEL] message`, colorized — the FORGE 1.0 human-readable progress format
 *  (phase3-executor.ts's renderer, e708495). */
export function printResultLine(result: TestRunResult): void {
  const now = new Date();
  const ts = `${twoDigit(now.getHours())}:${twoDigit(now.getMinutes())}:${twoDigit(now.getSeconds())}`;
  const color = ANSI_COLOR[result.status] ?? '\x1b[37m';
  const level = result.status.toUpperCase();
  const total = result.passed + result.failed + result.skipped;
  const message = `TestOrchestrator: ${result.testSuite} (${result.runner}) — ${result.passed}/${total} passed, ${result.durationMs}ms`;
  process.stdout.write(`${color}[${ts}] [${level}] ${message}${ANSI_RESET}\n`);
}

export function logLine(module: string): (message: string) => void {
  return (message: string) => process.stdout.write(`  [${module}] ${message}\n`);
}

/** Cap failure_summary at 20 entries + a truncation marker (SCHEMA_ADDITIONS §5). */
function capFailureSummary(
  failures: RunnerOutcome['failures']
): Array<{ name: string; message: string; file: string }> | null {
  if (failures.length === 0) return null;
  if (failures.length <= MAX_FAILURE_SUMMARY) return failures;
  return [
    ...failures.slice(0, MAX_FAILURE_SUMMARY),
    { name: '…', message: `${failures.length - MAX_FAILURE_SUMMARY} additional failures truncated`, file: '' },
  ];
}

/** Write the four LINE/BRANCH/FUNCTION/STATEMENT rows a UNIT/INTEGRATION coverage-v8 run produces
 *  (T8 — exactly four, coverage-v8 only). Best-effort: a Build Memory outage never fails the run. */
async function writeCoverageSnapshots(
  testRunResultId: string,
  projectName: string,
  buildRunId: string | null,
  machineId: string,
  coverage: NonNullable<RunnerOutcome['coverage']>
): Promise<void> {
  const rows: Array<{ type: CoverageType; pct: number; threshold: number }> = [
    { type: 'LINE', pct: coverage.line, threshold: COVERAGE_THRESHOLD_DEFAULT },
    { type: 'BRANCH', pct: coverage.branch, threshold: COVERAGE_THRESHOLD_BRANCH },
    { type: 'FUNCTION', pct: coverage.function, threshold: COVERAGE_THRESHOLD_DEFAULT },
    { type: 'STATEMENT', pct: coverage.statement, threshold: COVERAGE_THRESHOLD_DEFAULT },
  ];
  for (const row of rows) {
    const previous = await getLatestCoverageSnapshot(projectName, row.type);
    const deltaVsPrevious = previous ? row.pct - previous.coverage_pct : null;
    await insertCoverageSnapshot({
      build_run_id: buildRunId,
      project_name: projectName,
      test_run_result_id: testRunResultId,
      coverage_type: row.type,
      coverage_pct: row.pct,
      lines_total: coverage.linesTotal,
      lines_covered: coverage.linesCovered,
      files_below_threshold: coverage.filesBelowThreshold,
      threshold_required: row.threshold,
      threshold_met: row.pct / 100 >= row.threshold,
      delta_vs_previous: deltaVsPrevious,
      machine_id: machineId,
    });
  }
}

export interface PersistRunnerOutcomeInput {
  runnerType: RunnerType;
  outcome: RunnerOutcome;
  projectPath: string;
  buildRunId: string | null;
  promptId: string | null;
  trigger: TestRunTrigger;
  machineId: string;
  promptIndex?: number | null;
}

/** Insert one test_run_results row (+ coverage snapshots for UNIT/INTEGRATION), print the FORGE-1.0
 *  log line, and return the TestRunResult. A `RunnerOutcome` produced from a non-zero Vitest exit
 *  whose JSON report still parsed (failed tests, not a runner crash) is written as `status: 'failed'`
 *  here exactly as it arrives — this module never reinterprets exit codes (T1: no fabricated pass). */
export async function persistRunnerOutcome(input: PersistRunnerOutcomeInput): Promise<TestRunResult> {
  const projectName = basename(input.projectPath);
  const startedAt = new Date(Date.now() - input.outcome.durationMs).toISOString();
  const testSuite = TEST_SUITE_DB[input.runnerType];

  const row = await insertTestRunResult(
    {
      build_run_id: input.buildRunId,
      project_name: projectName,
      trigger: input.trigger,
      test_suite: testSuite,
      runner: input.outcome.runner,
      status: input.outcome.status,
      prompt_index: input.promptIndex ?? null,
      tests_total: input.outcome.testsTotal,
      tests_passed: input.outcome.testsPassed,
      tests_failed: input.outcome.testsFailed,
      tests_skipped: input.outcome.testsSkipped,
      duration_ms: input.outcome.durationMs,
      failure_summary: capFailureSummary(input.outcome.failures),
      report_path: input.outcome.reportPath,
      exit_code: input.outcome.exitCode,
      machine_id: input.machineId,
    },
    startedAt
  );

  if (
    row &&
    input.outcome.coverage &&
    (input.runnerType === RunnerType.UNIT || input.runnerType === RunnerType.INTEGRATION)
  ) {
    await writeCoverageSnapshots(row.id, projectName, input.buildRunId, input.machineId, input.outcome.coverage);
  }

  const result: TestRunResult = {
    id: row?.id ?? '',
    buildRunId: input.buildRunId,
    promptId: input.promptId,
    runnerType: input.runnerType,
    testSuite,
    passed: input.outcome.testsPassed,
    failed: input.outcome.testsFailed,
    skipped: input.outcome.testsSkipped,
    durationMs: input.outcome.durationMs,
    coveragePercent: input.outcome.coverage?.line ?? null,
    errors: input.outcome.failures.map((f) => `${f.file ? `${f.file}: ` : ''}${f.message || f.name}`),
    createdAt: row?.created_at ?? startedAt,
    status: input.outcome.status,
    runner: input.outcome.runner,
    reportPath: input.outcome.reportPath,
    exitCode: input.outcome.exitCode,
  };
  printResultLine(result);
  // Control Plane run telemetry: forward this same, already-built row to the active build's
  // .forge/runs/<run-id>/tests.jsonl — a no-op outside a live Phase 3 build (see run-recorder.ts).
  getActiveRunRecorder()?.recordTestResult({
    id: result.id,
    runnerType: result.runnerType,
    testSuite: result.testSuite,
    status: result.status,
    passed: result.passed,
    failed: result.failed,
    skipped: result.skipped,
    durationMs: result.durationMs,
    promptId: result.promptId,
  });
  return result;
}
