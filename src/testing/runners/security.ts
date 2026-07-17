// FORGE 2.0 — Enterprise Test Suite: single-suite SECURITY (full) entry point (TESTING_BLUEPRINT.md
// §18 — Semgrep SAST + Gitleaks secret scan).
//
// security-runner.ts (the batch orchestrator's RunnerType.SECURITY) wraps the fast in-process
// src/tools/security-scanner.ts heuristic for the POST_PROMPT touched-file subset. This module is
// the separate "full" sweep the blueprint describes for SCHEDULED/PRE_DEPLOY: it shells to Gitleaks
// (secrets) and Semgrep (SAST) directly — the same commands/parsing shape already proven in
// phase4-sentinel.ts's Ring 2 Semgrep / Ring 3 Gitleaks checks — and aggregates both into one
// TestRunResult row rather than re-running the fast heuristic scanner a second time.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getMachineId } from '../../learning/database.js';
import { RunnerType, type TestRunResult } from '../types.js';
import { defaultShellRunner } from './exec.js';
import { logLine, persistRunnerOutcome } from './persist.js';
import type { RunnerFailure, RunnerOutcome } from './types.js';

const GITLEAKS_TIMEOUT_MS = 3 * 60 * 1000;
const SEMGREP_TIMEOUT_MS = 5 * 60 * 1000;
const GITLEAKS_REPORT_PATH = '.forge/test-reports/gitleaks.json';

/** A single Gitleaks finding (`gitleaks detect --report-format=json`). */
interface GitleaksFinding {
  RuleID?: string;
  Description?: string;
  Match?: string;
  File?: string;
  StartLine?: number;
}

/** A single Semgrep finding (`npx semgrep --config=auto --json`). */
interface SemgrepFinding {
  check_id?: string;
  path?: string;
  start?: { line?: number };
  extra?: { severity?: string; message?: string };
}
interface SemgrepJsonOutput {
  results?: SemgrepFinding[];
}

function toolMissing(output: string): boolean {
  return /command not found|is not recognized|Cannot find module|no such file|ENOENT|not installed/i.test(output);
}

interface ToolResult {
  status: 'passed' | 'failed' | 'skipped' | 'error';
  total: number;
  failed: number;
  failures: RunnerFailure[];
  detail: string;
}

/** Runs `npx gitleaks detect --source=. --report-format=json`, writing findings to a report file
 *  (`--exit-code=0` so a non-empty finding set never surfaces as a shell failure) and reading them
 *  back — mirrors phase4-sentinel.ts's Ring 3 Gitleaks check. Missing binary SKIPs (T1). */
async function runGitleaks(projectPath: string, log: (m: string) => void): Promise<ToolResult> {
  const command = `npx gitleaks detect --source=. --report-format=json --report-path=${GITLEAKS_REPORT_PATH} --exit-code=0`;
  log(`gitleaks: ${command}`);
  const result = await defaultShellRunner(command, projectPath, GITLEAKS_TIMEOUT_MS);
  const combined = [result.stdout, result.stderr].filter((s) => s.trim() !== '').join('\n');

  if (result.timedOut) {
    return { status: 'error', total: 0, failed: 0, failures: [], detail: 'gitleaks TIMED OUT after 180s' };
  }
  if (toolMissing(combined)) {
    return { status: 'skipped', total: 0, failed: 0, failures: [], detail: 'gitleaks not installed or not in PATH — SKIP' };
  }

  let findings: GitleaksFinding[] = [];
  try {
    const raw = await readFile(join(projectPath, GITLEAKS_REPORT_PATH), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) findings = parsed as GitleaksFinding[];
  } catch {
    // Gitleaks only writes the report file when findings exist — no file means a clean scan.
  }

  const failures: RunnerFailure[] = findings.map((f) => ({
    name: f.RuleID ?? 'secret',
    message: f.Description ?? f.Match ?? 'secret detected',
    file: f.File ?? '',
  }));

  return {
    status: findings.length > 0 ? 'failed' : 'passed',
    total: findings.length,
    failed: findings.length,
    failures,
    detail: findings.length > 0 ? `gitleaks: ${findings.length} secret(s) detected` : 'gitleaks: 0 secrets detected',
  };
}

/** Runs `npx semgrep --config=auto --json`; only ERROR-severity findings are blocking (WARNING
 *  findings are surfaced but non-blocking) — mirrors phase4-sentinel.ts's Ring 2 Semgrep check.
 *  Missing binary SKIPs (T1). */
async function runSemgrep(projectPath: string, log: (m: string) => void): Promise<ToolResult> {
  const command = 'npx semgrep --config=auto --json';
  log(`semgrep: ${command}`);
  const result = await defaultShellRunner(command, projectPath, SEMGREP_TIMEOUT_MS);
  const combined = [result.stdout, result.stderr].filter((s) => s.trim() !== '').join('\n');

  if (result.timedOut) {
    return { status: 'error', total: 0, failed: 0, failures: [], detail: 'semgrep TIMED OUT after 300s' };
  }
  if (toolMissing(combined)) {
    return { status: 'skipped', total: 0, failed: 0, failures: [], detail: 'semgrep not installed — SKIP' };
  }

  let parsed: SemgrepJsonOutput | null = null;
  try {
    const jsonStr = result.stdout.trim();
    const firstBrace = jsonStr.indexOf('{');
    if (firstBrace >= 0) parsed = JSON.parse(jsonStr.slice(firstBrace)) as SemgrepJsonOutput;
  } catch {
    parsed = null;
  }

  if (parsed === null && !result.ok) {
    return {
      status: 'error',
      total: 0,
      failed: 0,
      failures: [],
      detail: `semgrep exited ${result.exitCode ?? 'null'} without JSON`,
    };
  }

  const findings = parsed?.results ?? [];
  const errorFindings = findings.filter((f) => (f.extra?.severity ?? '').toUpperCase() === 'ERROR');
  const failures: RunnerFailure[] = errorFindings.map((f) => ({
    name: f.check_id ?? 'semgrep-rule',
    message: f.extra?.message ?? 'Semgrep ERROR finding',
    file: f.path ?? '',
  }));

  return {
    status: errorFindings.length > 0 ? 'failed' : 'passed',
    total: findings.length,
    failed: errorFindings.length,
    failures,
    detail:
      errorFindings.length > 0
        ? `semgrep: ${errorFindings.length} ERROR finding(s) of ${findings.length}`
        : `semgrep: 0 ERROR finding(s) of ${findings.length}`,
  };
}

/** Combine gitleaks + semgrep into one RunnerOutcome: `failed` if either found blocking issues,
 *  `error` if either malfunctioned (and nothing failed), `skipped` only when BOTH tools are absent —
 *  a single missing tool never masks the other tool's real result (T1). */
function combine(gitleaks: ToolResult, semgrep: ToolResult, durationMs: number): RunnerOutcome {
  const failures = [...gitleaks.failures, ...semgrep.failures];
  const testsTotal = gitleaks.total + semgrep.total;
  const testsFailed = gitleaks.failed + semgrep.failed;

  let status: RunnerOutcome['status'];
  if (testsFailed > 0) status = 'failed';
  else if (gitleaks.status === 'error' || semgrep.status === 'error') status = 'error';
  else if (gitleaks.status === 'skipped' && semgrep.status === 'skipped') status = 'skipped';
  else status = 'passed';

  return {
    runner: 'gitleaks+semgrep',
    status,
    testsTotal,
    testsPassed: testsTotal - testsFailed,
    testsFailed,
    testsSkipped: 0,
    durationMs,
    failures,
    reportPath: GITLEAKS_REPORT_PATH,
    exitCode: null,
    detail: `${gitleaks.detail}; ${semgrep.detail}`,
    coverage: null,
  };
}

/**
 * Run the full SECURITY sweep (Gitleaks secret scan + Semgrep SAST) against `projectPath`, insert
 * the resulting `test_run_results` row, and return the `TestRunResult`. Either tool missing from
 * PATH degrades that tool's sub-result to `skipped` rather than a fabricated pass (T1); the combined
 * outcome is only `skipped` when BOTH tools are absent.
 */
export async function runSecurityTests(
  projectPath: string,
  buildRunId: string | null,
  promptId: string | null
): Promise<TestRunResult> {
  const started = Date.now();
  const log = logLine('testing');
  const [gitleaks, semgrep] = await Promise.all([runGitleaks(projectPath, log), runSemgrep(projectPath, log)]);
  const outcome = combine(gitleaks, semgrep, Date.now() - started);

  return persistRunnerOutcome({
    runnerType: RunnerType.SECURITY,
    outcome,
    projectPath,
    buildRunId,
    promptId,
    trigger: 'MANUAL',
    machineId: getMachineId(),
  });
}

export default runSecurityTests;
