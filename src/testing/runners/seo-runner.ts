// FORGE 2.0 — Enterprise Test Suite: SEO runner (technical SEO + broken-link + structured-data
// audit).
//
// Reuses FORGE's existing src/tools/seo-validator.ts rather than re-implementing the dev-server
// boot + route discovery + per-page audit — DRY, per the blueprint's "reuse, never re-implement"
// rule (same pattern security-runner.ts uses for security-scanner.ts).

import { runSeoAudit } from '../../tools/seo-validator.js';
import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  try {
    const result = await runSeoAudit({ projectPath: input.projectPath });
    const durationMs = Date.now() - started;

    if (!result.ran || result.auditedPages === 0) {
      const reason =
        result.pages.length === 0
          ? 'no page routes discovered — SEO audit not triggered'
          : !result.devServerStarted
            ? `dev server did not become ready — ${result.pages[0]?.detail ?? 'app not reachable'}`
            : !result.driverAvailable
              ? 'browser unavailable (Playwright not installed / failed to launch)'
              : 'SEO audit evaluated no route';
      return skippedOutcome('seo-validator', `${reason} — not evaluated`);
    }

    const failures: RunnerFailure[] = result.failures.slice(0, 20).map((p) => {
      const worst = p.issues[0];
      return {
        name: p.path,
        message: worst ? `${worst.check}: ${worst.message}` : p.detail,
        file: p.path,
      };
    });

    const status: RunnerOutcome['status'] = result.blocked ? 'failed' : 'passed';
    return {
      runner: 'seo-validator',
      status,
      testsTotal: result.auditedPages,
      testsPassed: result.auditedPages - result.failures.length,
      testsFailed: result.failures.length,
      testsSkipped: result.skippedPages,
      durationMs,
      failures,
      reportPath: null,
      exitCode: null,
      detail: result.blocked
        ? `${result.counts.critical} CRITICAL SEO issue(s) — build blocked (site score ${result.siteScore ?? 'n/a'}/100)`
        : `${result.totalIssues} SEO issue(s) surfaced across ${result.auditedPages} route(s), none critical (site score ${result.siteScore ?? 'n/a'}/100)`,
      coverage: null,
    };
  } catch (error) {
    return errorOutcome(
      'seo-validator',
      `SEO audit threw: ${error instanceof Error ? error.message : String(error)}`,
      Date.now() - started
    );
  }
}
