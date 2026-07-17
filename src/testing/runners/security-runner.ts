// FORGE 2.0 — Enterprise Test Suite: SECURITY runner (TESTING_BLUEPRINT.md §18).
//
// Reuses FORGE's existing src/tools/security-scanner.ts rather than re-implementing scanning —
// DRY, per the blueprint's "reuse, never re-implement" rule.

import { runSecurityScan } from '../../tools/security-scanner.js';
import type { RunnerFailure, RunnerInput, RunnerOutcome } from './types.js';

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  try {
    const result = await runSecurityScan({ projectPath: input.projectPath });
    const durationMs = Date.now() - started;
    const blocking = result.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
    const failures: RunnerFailure[] = blocking
      .slice(0, 20)
      .map((f) => ({ name: f.rule, message: f.message, file: f.file }));
    const status: RunnerOutcome['status'] = result.blocked ? 'failed' : 'passed';
    return {
      runner: 'security-scanner',
      status,
      testsTotal: result.findings.length,
      testsPassed: result.findings.length - blocking.length,
      testsFailed: blocking.length,
      testsSkipped: 0,
      durationMs,
      failures,
      reportPath: null,
      exitCode: null,
      detail: result.blocked
        ? `${blocking.length} critical/high finding(s) across ${result.scannedFiles} file(s)`
        : `${result.findings.length} finding(s) across ${result.scannedFiles} file(s), none blocking`,
      coverage: null,
    };
  } catch (error) {
    return {
      runner: 'security-scanner',
      status: 'error',
      testsTotal: 0,
      testsPassed: 0,
      testsFailed: 0,
      testsSkipped: 0,
      durationMs: Date.now() - started,
      failures: [],
      reportPath: null,
      exitCode: null,
      detail: `security scan threw: ${error instanceof Error ? error.message : String(error)}`,
      coverage: null,
    };
  }
}
