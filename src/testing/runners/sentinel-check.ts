// FORGE 2.0 — Enterprise Test Suite: shared translation from phase4-sentinel.ts's `CheckResult`
// (pass/fail/skip of a single Ring 3 check) into a `RunnerOutcome` row. Used by the Trivy/Gitleaks/
// Lighthouse runners, which call Sentinel's already-working Ring 3 checks directly (DRY — the
// scanning/parsing logic lives in phase4-sentinel.ts and is never re-implemented here).

import type { CheckResult } from '../../phases/phase4-sentinel.js';
import type { RunnerFailure, RunnerOutcome } from './types.js';

export function outcomeFromCheckResult(runner: string, check: CheckResult): RunnerOutcome {
  const status: RunnerOutcome['status'] = check.skipped ? 'skipped' : check.passed ? 'passed' : 'failed';
  const failures: RunnerFailure[] =
    status === 'failed' ? [{ name: check.name, message: check.detail, file: '' }] : [];
  return {
    runner,
    status,
    testsTotal: status === 'skipped' ? 0 : 1,
    testsPassed: status === 'passed' ? 1 : 0,
    testsFailed: status === 'failed' ? 1 : 0,
    testsSkipped: status === 'skipped' ? 1 : 0,
    durationMs: check.durationMs,
    failures,
    reportPath: null,
    exitCode: null,
    detail: check.detail,
    coverage: null,
  };
}
