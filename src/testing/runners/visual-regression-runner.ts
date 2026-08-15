// FORGE 2.0 — Enterprise Test Suite: VISUAL_REGRESSION runner (Playwright + pixel-diff vs
// `.forge/baselines/`).
//
// Reuses FORGE's existing src/tools/visual-regression.ts rather than re-implementing screenshot
// capture / pixel comparison — DRY, per the blueprint's "reuse, never re-implement" rule (same
// pattern security-runner.ts uses for security-scanner.ts). Route discovery reuses the same
// `readCodebase` page-route extractor accessibility-auditor.ts/seo-validator.ts already use —
// visual-regression.ts itself takes routes as an explicit input, it does not discover them.

import { readCodebase } from '../../tools/codebase-reader.js';
import { runVisualRegression, type VisualRouteSpec } from '../../tools/visual-regression.js';
import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

async function discoverPageRoutes(projectPath: string): Promise<VisualRouteSpec[]> {
  let routes;
  try {
    routes = (await readCodebase(projectPath)).routes;
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const specs: VisualRouteSpec[] = [];
  for (const r of routes) {
    if (r.kind !== 'page' || seen.has(r.route)) continue;
    seen.add(r.route);
    specs.push({ path: r.route, name: r.file });
  }
  return specs;
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  try {
    const pages = await discoverPageRoutes(input.projectPath);
    if (pages.length === 0) {
      return skippedOutcome('visual-regression', 'no page routes discovered — visual regression not evaluated');
    }

    const result = await runVisualRegression({ projectPath: input.projectPath, pages });
    const durationMs = Date.now() - started;

    if (!result.driverAvailable) {
      return skippedOutcome(
        'visual-regression',
        'browser unavailable (Playwright not installed / failed to launch) — not evaluated'
      );
    }
    if (result.comparedPages === 0 && result.capturedBaselines === 0) {
      return skippedOutcome(
        'visual-regression',
        `target app not reachable at ${result.baseUrl} — ${result.unreachablePages} route(s) could not be captured`
      );
    }

    const failures: RunnerFailure[] = result.regressions.slice(0, 20).map((p) => ({
      name: p.path,
      message: `${p.diffPercentage.toFixed(2)}% pixel diff (threshold ${result.thresholdPercent}%)`,
      file: p.currentPath ?? p.path,
    }));

    const status: RunnerOutcome['status'] = result.passed ? 'passed' : 'failed';
    return {
      runner: 'visual-regression',
      status,
      testsTotal: result.comparedPages + result.capturedBaselines,
      testsPassed: result.comparedPages - result.regressions.length + result.capturedBaselines,
      testsFailed: result.regressions.length,
      testsSkipped: result.unreachablePages + result.errorPages,
      durationMs,
      failures,
      reportPath: null,
      exitCode: null,
      detail: result.firstRun
        ? `captured ${result.capturedBaselines} baseline(s) (first run — nothing to compare)`
        : status === 'failed'
          ? `${result.regressions.length} UI regression(s) > ${result.thresholdPercent}%`
          : `${result.comparedPages} route(s) within ${result.thresholdPercent}% of baseline`,
      coverage: null,
    };
  } catch (error) {
    return errorOutcome(
      'visual-regression',
      `visual regression threw: ${error instanceof Error ? error.message : String(error)}`,
      Date.now() - started
    );
  }
}
