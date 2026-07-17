// FORGE 2.0 — Enterprise Test Suite: API validator (route-scan + live HTTP checks,
// TESTING_BLUEPRINT.md §3 baseUrl variant).
//
// Distinct from runners/api-runner.ts (which drives the target project's own Vitest
// `vitest.api.config.ts` suite). This is FORGE's own black-box validator: it discovers every
// Next.js Route Handler under src/app/api — reusing RETROFIT's `buildRouteInventory` directory
// walk (scan-ops-5-8.ts) rather than a second tree-walk implementation — fires a real HTTP
// request per declared method against `baseUrl`, and checks status code (never 5xx), response
// shape (parseable JSON body), and response time (<2000ms budget).

import { getMachineId } from '../../learning/database.js';
import { buildRouteInventory } from '../../retrofit/scan-ops-5-8.js';
import { RunnerType, type TestRunResult } from '../types.js';
import { logLine, persistRunnerOutcome } from './persist.js';
import { skippedOutcome, type RunnerFailure, type RunnerOutcome } from './types.js';

const DEFAULT_BASE_URL = 'http://localhost:3000';
const RESPONSE_TIME_BUDGET_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** Next.js dynamic segments ([id], [...slug]) resolved to a synthetic value — there is no real
 *  record to address, so this is a liveness/shape/latency smoke check, not a data-correctness test. */
function resolveDynamicSegments(routePath: string): string {
  return routePath.replace(/\[\.\.\.[^\]]+\]/g, 'test').replace(/\[[^\]]+\]/g, 'test');
}

interface RouteCheck {
  ok: boolean;
  failure: RunnerFailure | null;
}

async function checkRoute(
  baseUrl: string,
  routePath: string,
  file: string,
  method: HttpMethod
): Promise<RouteCheck> {
  const name = `${method} ${routePath}`;
  const url = `${baseUrl.replace(/\/+$/, '')}${resolveDynamicSegments(routePath)}`;
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: hasBody ? { 'content-type': 'application/json' } : undefined,
      body: hasBody ? '{}' : undefined,
    });
    const elapsedMs = Date.now() - started;
    const bodyText = await response.text();

    let shapeOk = true;
    if (bodyText.trim() !== '') {
      try {
        JSON.parse(bodyText);
      } catch {
        shapeOk = false;
      }
    }

    const statusOk = response.status < 500;
    const timeOk = elapsedMs < RESPONSE_TIME_BUDGET_MS;
    if (statusOk && shapeOk && timeOk) return { ok: true, failure: null };

    const reasons: string[] = [];
    if (!statusOk) reasons.push(`status ${response.status}`);
    if (!shapeOk) reasons.push('response body was not valid JSON');
    if (!timeOk) reasons.push(`response time ${elapsedMs}ms exceeded ${RESPONSE_TIME_BUDGET_MS}ms budget`);
    return { ok: false, failure: { name, message: reasons.join('; '), file } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, failure: { name, message, file } };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Run the API suite: discover every route.ts under `<projectPath>/src/app/api`, fire a real HTTP
 * request per declared method against `baseUrl`, insert the resulting `test_run_results` row, and
 * return the `TestRunResult`. Zero discovered routes is a `skipped` outcome, never a fabricated
 * pass (T1); a route that connects but returns 5xx, a non-JSON body, or exceeds the 2000ms budget
 * counts as a failed check.
 */
export async function runApiTests(
  projectPath: string,
  buildRunId: string | null,
  promptId: string | null,
  baseUrl: string = process.env['FORGE_TEST_BASE_URL'] ?? DEFAULT_BASE_URL
): Promise<TestRunResult> {
  const log = logLine('testing');
  const started = Date.now();

  const routes = buildRouteInventory(projectPath).filter(
    (r) => r.type === 'API' && r.route.startsWith('/api')
  );

  let outcome: RunnerOutcome;
  if (routes.length === 0) {
    outcome = skippedOutcome('api-validator', 'no API route definitions found under src/app/api — SKIP');
  } else {
    log(`api: checking ${routes.length} route(s) against ${baseUrl}`);
    const failures: RunnerFailure[] = [];
    let total = 0;
    let passed = 0;

    for (const route of routes) {
      const methods = (route.methods?.length ? route.methods : ['GET']) as HttpMethod[];
      for (const method of methods) {
        total += 1;
        const check = await checkRoute(baseUrl, route.route, route.file, method);
        if (check.ok) passed += 1;
        else if (check.failure) failures.push(check.failure);
      }
    }

    const durationMs = Date.now() - started;
    const failed = total - passed;
    const status: RunnerOutcome['status'] = failed > 0 ? 'failed' : 'passed';
    outcome = {
      runner: 'api-validator',
      status,
      testsTotal: total,
      testsPassed: passed,
      testsFailed: failed,
      testsSkipped: 0,
      durationMs,
      failures,
      reportPath: null,
      exitCode: null,
      detail: status === 'passed' ? `${passed}/${total} routes passed` : `${failed}/${total} routes failed`,
      coverage: null,
    };
  }

  return persistRunnerOutcome({
    runnerType: RunnerType.API,
    outcome,
    projectPath,
    buildRunId,
    promptId,
    trigger: 'MANUAL',
    machineId: getMachineId(),
  });
}

export default runApiTests;
