// FORGE 2.0 — Enterprise Test Suite: ACCESSIBILITY runner (axe-core WCAG 2.1 AA).
//
// Reuses FORGE's existing src/tools/accessibility-auditor.ts rather than re-implementing the
// dev-server boot + route discovery + axe-core audit — DRY, per the blueprint's "reuse, never
// re-implement" rule (same pattern security-runner.ts uses for security-scanner.ts).

import { runAccessibilityAudit } from '../../tools/accessibility-auditor.js';
import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  try {
    const report = await runAccessibilityAudit({ projectPath: input.projectPath });
    const durationMs = Date.now() - started;

    if (!report.ran || report.auditedPages === 0) {
      const reason =
        report.pages.length === 0
          ? 'no page routes discovered — accessibility audit not triggered'
          : !report.devServerStarted
            ? `dev server did not become ready — ${report.pages[0]?.detail ?? 'app not reachable'}`
            : !report.driverAvailable
              ? 'browser/axe unavailable (Playwright or axe-core not installed / failed to launch)'
              : 'accessibility audit evaluated no route';
      return skippedOutcome('axe-core', `${reason} — not evaluated`);
    }

    const failures: RunnerFailure[] = report.failures.slice(0, 20).map((p) => {
      const worst = p.violations[0];
      return {
        name: p.path,
        message: worst ? `${worst.rule}: ${worst.description}` : p.detail,
        file: p.path,
      };
    });

    const status: RunnerOutcome['status'] = report.blocked ? 'failed' : 'passed';
    return {
      runner: 'axe-core',
      status,
      testsTotal: report.auditedPages,
      testsPassed: report.auditedPages - report.failures.length,
      testsFailed: report.failures.length,
      testsSkipped: report.skippedPages,
      durationMs,
      failures,
      reportPath: null,
      exitCode: null,
      detail: report.blocked
        ? `${report.counts.critical} CRITICAL WCAG 2.1 AA violation(s) — build blocked (${report.auditedPages} route(s) audited)`
        : `${report.totalViolations} violation(s) surfaced across ${report.auditedPages} route(s), none critical`,
      coverage: null,
    };
  } catch (error) {
    return errorOutcome(
      'axe-core',
      `accessibility audit threw: ${error instanceof Error ? error.message : String(error)}`,
      Date.now() - started
    );
  }
}
