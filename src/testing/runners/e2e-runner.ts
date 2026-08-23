// FORGE 2.0 — Enterprise Test Suite: E2E runner (TESTING_BLUEPRINT.md §4 — @playwright/test).

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { defaultShellRunner } from './exec.js';
import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

const DEFAULT_E2E_TIMEOUT_MS = 10 * 60 * 1000;
const REPORT_FILE = '.forge/test-reports/e2e.json';

interface PlaywrightSuite {
  title?: string;
  file?: string;
  suites?: PlaywrightSuite[];
  specs?: Array<{
    title?: string;
    tests?: Array<{
      results?: Array<{ status?: string; error?: { message?: string } }>;
    }>;
  }>;
}

interface PlaywrightJsonReport {
  stats?: { expected?: number; unexpected?: number; skipped?: number };
  suites?: PlaywrightSuite[];
}

/** Walk Playwright's nested suite tree collecting every failed spec's error message. */
function collectFailures(suites: PlaywrightSuite[] | undefined, failures: RunnerFailure[]): void {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          if (result.status === 'failed' || result.status === 'timedOut') {
            failures.push({
              name: spec.title ?? 'unnamed test',
              message: (result.error?.message ?? result.status ?? '').slice(0, 500),
              file: suite.file ?? suite.title ?? '',
            });
          }
        }
      }
    }
    collectFailures(suite.suites, failures);
  }
}

function playwrightInstalled(projectPath: string): boolean {
  const bin = join(projectPath, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
  return existsSync(bin) || existsSync(join(projectPath, 'node_modules', '@playwright', 'test'));
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();

  if (!playwrightInstalled(input.projectPath)) {
    return skippedOutcome('playwright', '@playwright/test not installed in target project — SKIP (T1)');
  }

  const command = `pnpm exec playwright test --reporter=json`;
  input.log(`playwright: ${command}${input.baseUrl ? ` (BASE_URL=${input.baseUrl})` : ''}`);
  // Optional target base URL (an ephemeral preview URL, `src/deploy/ephemeral-preview.ts`) —
  // exported under both names since Playwright configs commonly read either `BASE_URL` (a
  // project's own convention) or `PLAYWRIGHT_TEST_BASE_URL` (Playwright's own env var, honored by
  // `use.baseURL` when a config reads `process.env.PLAYWRIGHT_TEST_BASE_URL` — see Playwright's
  // docs). Absent by default (no behavior change for every caller that never sets `input.baseUrl`).
  const env = input.baseUrl ? { BASE_URL: input.baseUrl, PLAYWRIGHT_TEST_BASE_URL: input.baseUrl } : undefined;
  const result = await defaultShellRunner(command, input.projectPath, input.timeoutMs ?? DEFAULT_E2E_TIMEOUT_MS, env);
  const durationMs = Date.now() - started;

  let raw = result.stdout.trim();
  if (raw === '') {
    try {
      raw = (await readFile(join(input.projectPath, REPORT_FILE), 'utf8')).trim();
    } catch {
      raw = '';
    }
  }

  if (raw === '') {
    return errorOutcome(
      'playwright',
      result.timedOut ? 'playwright run timed out' : 'playwright produced no JSON report',
      durationMs,
      result.exitCode
    );
  }

  try {
    const data = JSON.parse(raw) as PlaywrightJsonReport;
    const passed = data.stats?.expected ?? 0;
    const failed = data.stats?.unexpected ?? 0;
    const skipped = data.stats?.skipped ?? 0;
    const total = passed + failed + skipped;
    const failures: RunnerFailure[] = [];
    collectFailures(data.suites, failures);
    const status: RunnerOutcome['status'] = failed > 0 ? 'failed' : total > 0 ? 'passed' : 'skipped';
    return {
      runner: 'playwright',
      status,
      testsTotal: total,
      testsPassed: passed,
      testsFailed: failed,
      testsSkipped: skipped,
      durationMs,
      failures,
      reportPath: REPORT_FILE,
      exitCode: result.exitCode,
      detail: status === 'passed' ? `${passed}/${total} specs passed` : `${failed}/${total} specs failed`,
      coverage: null,
    };
  } catch {
    return errorOutcome('playwright', 'playwright JSON report was unparsable', durationMs, result.exitCode);
  }
}
