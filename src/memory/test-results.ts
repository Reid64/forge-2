/**
 * FORGE 2.0 — Build Memory: test_run_results + test_coverage_snapshots CRUD.
 *
 * TestOrchestrator's persistence layer (TESTING_BLUEPRINT.md § TestOrchestrator, SCHEMA_ADDITIONS
 * §5-§6). See src/learning/database.ts › BUILD_MEMORY_SCHEMA_SQL for the CHECK-constrained columns
 * (`trigger`, `test_suite`, `status`, `coverage_type`). Prepared statements only — no raw SQL
 * outside this module (BEHAVIORAL_CONTRACTS.md global contract).
 */

import { fromJsonText, newId, nowIso, runQuery, toJsonText } from './client.js';

const TEST_RUN_RESULTS_TABLE = 'test_run_results';
const TEST_COVERAGE_SNAPSHOTS_TABLE = 'test_coverage_snapshots';

export type TestRunTrigger = 'POST_PROMPT' | 'SCHEDULED' | 'MANUAL' | 'PRE_DEPLOY' | 'CI';

/** 23-value CHECK-constrained enum (`src/learning/database.ts` › `test_run_results.test_suite`
 *  CHECK clause — must match this union EXACTLY, both edited together). IAC/SBOM/LICENSE (schema
 *  3.4.0) were added as new values rather than folding into STATIC_ANALYSIS/DEPENDENCY_SCAN
 *  specifically so `src/governance/readiness-levels.ts` can gate them to the MILESTONE
 *  (ENTERPRISE_READY) and PRE-DEPLOYMENT (ENTERPRISE_GRADE) readiness tiers only — reusing an
 *  existing value already required starting at a lower tier (STATIC_ANALYSIS at tier 3,
 *  DEPENDENCY_SCAN at tier 4) would have made that tier-gating impossible to express.
 *
 *  PROPERTY_BASED (schema 3.5.0) is ONE new value shared by BOTH the Python (pytest+Hypothesis) and
 *  JS/TS (fast-check) property-based runners — the same "coarser category, distinguished by
 *  `runner`" reuse pattern `persist.ts`'s TEST_SUITE_DB map already uses for DEPENDENCY_SCAN
 *  (shared by the `pnpm-audit` and `trivy` runners). A single value is correct here (unlike
 *  IAC/SBOM/LICENSE) because both property-based runners are meant to be gated identically —
 *  alongside UNIT, at every tier — so there is no tier-gating reason to keep them apart. */
export type TestSuiteDb =
  | 'UNIT'
  | 'INTEGRATION'
  | 'API'
  | 'E2E'
  | 'VISUAL_REGRESSION'
  | 'PERFORMANCE'
  | 'LOAD'
  | 'STRESS'
  | 'SOAK'
  | 'SECURITY'
  | 'ACCESSIBILITY'
  | 'CHAOS'
  | 'DISASTER_RECOVERY'
  | 'BACKUP_RESTORE'
  | 'DEPENDENCY_SCAN'
  | 'STATIC_ANALYSIS'
  | 'DYNAMIC_ANALYSIS'
  | 'CROSS_BROWSER'
  | 'CROSS_DEVICE'
  | 'IAC'
  | 'SBOM'
  | 'LICENSE'
  | 'PROPERTY_BASED';

export type TestRunStatus = 'running' | 'passed' | 'failed' | 'partial' | 'skipped' | 'error';

export type CoverageType = 'LINE' | 'BRANCH' | 'FUNCTION' | 'STATEMENT';

export interface TestFailureEntry {
  name: string;
  message: string;
  file: string;
}

export interface NewTestRunResult {
  build_run_id: string | null;
  project_name: string;
  trigger: TestRunTrigger;
  test_suite: TestSuiteDb;
  runner: string;
  status: TestRunStatus;
  prompt_index: number | null;
  tests_total: number;
  tests_passed: number;
  tests_failed: number;
  tests_skipped: number;
  duration_ms: number;
  failure_summary: TestFailureEntry[] | null;
  report_path: string | null;
  exit_code: number | null;
  machine_id: string;
}

export interface TestRunResultRow extends NewTestRunResult {
  id: string;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

interface TestRunResultDbRow {
  id: string;
  build_run_id: string | null;
  project_name: string;
  trigger: string;
  test_suite: string;
  runner: string;
  status: string;
  prompt_index: number | null;
  tests_total: number;
  tests_passed: number;
  tests_failed: number;
  tests_skipped: number;
  duration_ms: number;
  failure_summary: string | null;
  report_path: string | null;
  exit_code: number | null;
  started_at: string;
  completed_at: string | null;
  machine_id: string;
  created_at: string;
}

function rowToTestRunResult(row: TestRunResultDbRow): TestRunResultRow {
  return {
    id: row.id,
    build_run_id: row.build_run_id,
    project_name: row.project_name,
    trigger: row.trigger as TestRunTrigger,
    test_suite: row.test_suite as TestSuiteDb,
    runner: row.runner,
    status: row.status as TestRunStatus,
    prompt_index: row.prompt_index,
    tests_total: row.tests_total,
    tests_passed: row.tests_passed,
    tests_failed: row.tests_failed,
    tests_skipped: row.tests_skipped,
    duration_ms: row.duration_ms,
    failure_summary: fromJsonText<TestFailureEntry[] | null>(row.failure_summary, null),
    report_path: row.report_path,
    exit_code: row.exit_code,
    machine_id: row.machine_id,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
  };
}

/** Insert a completed test_run_results row (TestOrchestrator always writes after the run finishes,
 *  so `started_at`/`completed_at` bracket the actual run rather than the DB write). */
export function insertTestRunResult(
  input: NewTestRunResult,
  startedAt?: string
): Promise<TestRunResultRow | null> {
  return runQuery<TestRunResultRow>(TEST_RUN_RESULTS_TABLE + '.insertTestRunResult', (db) => {
    const id = newId();
    const completedAt = nowIso();
    const started = startedAt ?? completedAt;
    db.prepare(
      `INSERT INTO test_run_results (
        id, build_run_id, project_name, trigger, test_suite, runner, status, prompt_index,
        tests_total, tests_passed, tests_failed, tests_skipped, duration_ms, failure_summary,
        report_path, exit_code, started_at, completed_at, machine_id
      ) VALUES (
        @id, @build_run_id, @project_name, @trigger, @test_suite, @runner, @status, @prompt_index,
        @tests_total, @tests_passed, @tests_failed, @tests_skipped, @duration_ms, @failure_summary,
        @report_path, @exit_code, @started_at, @completed_at, @machine_id
      )`
    ).run({
      id,
      build_run_id: input.build_run_id,
      project_name: input.project_name,
      trigger: input.trigger,
      test_suite: input.test_suite,
      runner: input.runner,
      status: input.status,
      prompt_index: input.prompt_index,
      tests_total: input.tests_total,
      tests_passed: input.tests_passed,
      tests_failed: input.tests_failed,
      tests_skipped: input.tests_skipped,
      duration_ms: input.duration_ms,
      failure_summary: input.failure_summary ? toJsonText(input.failure_summary) : null,
      report_path: input.report_path,
      exit_code: input.exit_code,
      started_at: started,
      completed_at: completedAt,
      machine_id: input.machine_id,
    });
    const row = db.prepare('SELECT * FROM test_run_results WHERE id = ?').get(id) as TestRunResultDbRow;
    return rowToTestRunResult(row);
  });
}

/** Latest test_run_results row per project + suite, newest first. Returns null on failure. */
export function listLatestTestRunResults(projectName: string): Promise<TestRunResultRow[] | null> {
  return runQuery<TestRunResultRow[]>(TEST_RUN_RESULTS_TABLE + '.listLatestTestRunResults', (db) => {
    const rows = db
      .prepare(
        `SELECT t.* FROM test_run_results t
         INNER JOIN (
           SELECT test_suite, MAX(created_at) AS max_created_at
           FROM test_run_results WHERE project_name = ?
           GROUP BY test_suite
         ) latest ON t.test_suite = latest.test_suite AND t.created_at = latest.max_created_at
         WHERE t.project_name = ?
         ORDER BY t.test_suite`
      )
      .all(projectName, projectName) as TestRunResultDbRow[];
    return rows.map(rowToTestRunResult);
  });
}

export interface NewCoverageSnapshot {
  build_run_id: string | null;
  project_name: string;
  test_run_result_id: string;
  coverage_type: CoverageType;
  coverage_pct: number;
  lines_total: number;
  lines_covered: number;
  files_below_threshold: Array<{ file: string; pct: number }>;
  threshold_required: number;
  threshold_met: boolean;
  delta_vs_previous: number | null;
  machine_id: string;
}

export interface CoverageSnapshotRow extends NewCoverageSnapshot {
  id: string;
  captured_at: string;
}

interface CoverageSnapshotDbRow {
  id: string;
  build_run_id: string | null;
  project_name: string;
  test_run_result_id: string;
  coverage_type: string;
  coverage_pct: number;
  lines_total: number;
  lines_covered: number;
  files_below_threshold: string;
  threshold_required: number;
  threshold_met: number;
  delta_vs_previous: number | null;
  captured_at: string;
  machine_id: string;
}

function rowToCoverageSnapshot(row: CoverageSnapshotDbRow): CoverageSnapshotRow {
  return {
    id: row.id,
    build_run_id: row.build_run_id,
    project_name: row.project_name,
    test_run_result_id: row.test_run_result_id,
    coverage_type: row.coverage_type as CoverageType,
    coverage_pct: row.coverage_pct,
    lines_total: row.lines_total,
    lines_covered: row.lines_covered,
    files_below_threshold: fromJsonText(row.files_below_threshold, []),
    threshold_required: row.threshold_required,
    threshold_met: row.threshold_met === 1,
    delta_vs_previous: row.delta_vs_previous,
    machine_id: row.machine_id,
    captured_at: row.captured_at,
  };
}

/** Insert one test_coverage_snapshots row (one of the four LINE/BRANCH/FUNCTION/STATEMENT rows T8
 *  requires per UNIT/INTEGRATION run). */
export function insertCoverageSnapshot(input: NewCoverageSnapshot): Promise<CoverageSnapshotRow | null> {
  return runQuery<CoverageSnapshotRow>(TEST_COVERAGE_SNAPSHOTS_TABLE + '.insertCoverageSnapshot', (db) => {
    const id = newId();
    db.prepare(
      `INSERT INTO test_coverage_snapshots (
        id, build_run_id, project_name, test_run_result_id, coverage_type, coverage_pct,
        lines_total, lines_covered, files_below_threshold, threshold_required, threshold_met,
        delta_vs_previous, machine_id
      ) VALUES (
        @id, @build_run_id, @project_name, @test_run_result_id, @coverage_type, @coverage_pct,
        @lines_total, @lines_covered, @files_below_threshold, @threshold_required, @threshold_met,
        @delta_vs_previous, @machine_id
      )`
    ).run({
      id,
      build_run_id: input.build_run_id,
      project_name: input.project_name,
      test_run_result_id: input.test_run_result_id,
      coverage_type: input.coverage_type,
      coverage_pct: input.coverage_pct,
      lines_total: input.lines_total,
      lines_covered: input.lines_covered,
      files_below_threshold: toJsonText(input.files_below_threshold),
      threshold_required: input.threshold_required,
      threshold_met: input.threshold_met ? 1 : 0,
      delta_vs_previous: input.delta_vs_previous,
      machine_id: input.machine_id,
    });
    const row = db.prepare('SELECT * FROM test_coverage_snapshots WHERE id = ?').get(id) as CoverageSnapshotDbRow;
    return rowToCoverageSnapshot(row);
  });
}

/** The immediately preceding coverage snapshot for this project + coverage type (for
 *  `delta_vs_previous`), or null when this is the first snapshot / Build Memory is unavailable. */
export function getLatestCoverageSnapshot(
  projectName: string,
  coverageType: CoverageType
): Promise<CoverageSnapshotRow | null> {
  return runQuery<CoverageSnapshotRow>(TEST_COVERAGE_SNAPSHOTS_TABLE + '.getLatestCoverageSnapshot', (db) => {
    const row = db
      .prepare(
        `SELECT * FROM test_coverage_snapshots
         WHERE project_name = ? AND coverage_type = ?
         ORDER BY captured_at DESC LIMIT 1`
      )
      .get(projectName, coverageType) as CoverageSnapshotDbRow | undefined;
    return row ? rowToCoverageSnapshot(row) : null;
  });
}
