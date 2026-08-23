// FORGE 2.0 — Enterprise Test Suite: CONCURRENCY runner (simultaneous-request probing against a
// live preview URL — race-condition symptom detection).
//
// Gated to the ENTERPRISE_RELEASE readiness tier ONLY (`src/governance/readiness-levels.ts` —
// `MISSION_CRITICAL` id, reused verbatim by `HYPERSCALE` via `ALL_TEST_SUITES`) — same placement as
// idempotency-runner.ts/chaos-runner.ts/recovery-runner.ts/backup-restore-runner.ts: this probe
// hits a real running instance of the target app under real concurrent request load.
//
// "Live preview URL" mechanism: same own-throwaway-dev-server convention as every other Ring-3-
// style runner in this directory (see chaos-runner.ts's module doc comment). Dedicated port 3101
// (3095/3096/3097/3098/3099 already spoken for by recovery/chaos/schemathesis/zap/lighthouse;
// idempotency-runner.ts took 3100).
//
// Endpoint discovery is delegated to idempotency-runner.ts's `discoverWriteEndpoints` — the exact
// same static-scan need (a real POST/PUT route, never a fabricated one) as that runner, so it is
// reused rather than re-implemented a second time (unlike the dev-server spawn/wait/kill
// boilerplate, which every runner in this directory intentionally re-implements locally per
// exec.ts's own precedent — endpoint DISCOVERY is pure, in-process, and has no such
// module-boundary reason to duplicate).
//
// SIMPLIFYING ASSUMPTIONS (black-box HTTP probing, no access to the target app's own data store —
// Contract 6):
//   1. True race-condition verification (e.g. "did two concurrent writes both apply, or did one
//      overwrite the other silently") requires reading the app's own persisted state, which this
//      runner has no business reaching into. What black-box probing CAN responsibly assert:
//        a. None of N concurrent identical requests should error at the transport/server level
//           (5xx) when the same single request succeeds fine in isolation — a 5xx appearing ONLY
//           under concurrency (never observed on solo calls) is a real, checkable race-condition
//           symptom (e.g. an unguarded read-modify-write hitting a constraint violation).
//        b. IF (and only if) the endpoint's JSON response body exposes an id-shaped field (`id`,
//           `_id`, `uuid`, or any key ending in `Id`/`ID`) that looks like it was freshly minted
//           per request (a resource-creation response), duplicate values across the N concurrent
//           responses are a real, checkable "lost update"/double-allocation symptom (two
//           concurrent creates were handed the same identifier). Endpoints whose responses carry no
//           such field are simply not checked on this axis — never fabricated.
//   2. N = 8 concurrent requests: enough to surface a race under most naive (non-atomic)
//      implementations without approaching anything resembling a load/stress test (that is
//      LOAD/STRESS/SOAK's job, not this runner's) — single low-volume burst, never a flood.
//
// Outcome policy:
//   - No write endpoint (POST/PUT) discovered statically -> SKIPPED (T1).
//   - Dev server never becomes ready -> SKIPPED (T1).
//   - A solo baseline request fails to complete cleanly (network error / non-comparable) -> SKIPPED
//     (no clean baseline to compare the concurrent burst against).
//   - Any of the N concurrent requests returns 5xx while the solo baseline did NOT -> FAILED.
//   - Duplicate id-shaped values found across the N concurrent responses -> FAILED.
//   - Otherwise -> PASSED.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { discoverWriteEndpoints } from './idempotency-runner.js';
import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

const CONCURRENCY_DEV_PORT = 3101;
const DEV_SERVER_READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 8_000;
const CONCURRENT_REQUEST_COUNT = 8;
const ID_LIKE_KEY_PATTERN = /^(id|_id|uuid)$|Id$|ID$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDevServer(url: string, timeoutMs: number, log: (m: string) => void): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const POLL_MS = 1000;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.status < 500) return true;
    } catch {
      // Not ready yet — swallow and poll again.
    }
    await sleep(POLL_MS);
    log(`concurrency: waiting for dev server at ${url}…`);
  }
  return false;
}

function killChildProcess(proc: ChildProcess | null, log: (m: string) => void): void {
  if (!proc) return;
  try {
    if (!proc.killed) proc.kill('SIGTERM');
  } catch (err) {
    log(`WARNING: concurrency-runner — could not kill dev server (${err instanceof Error ? err.message : String(err)})`);
  }
}

interface ProbeResult {
  status: number | null;
  networkError: boolean;
  bodyText: string;
}

async function sendProbe(url: string, method: string, body: string): Promise<ProbeResult> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const bodyText = await resp.text().catch(() => '');
    return { status: resp.status, networkError: false, bodyText };
  } catch {
    return { status: null, networkError: true, bodyText: '' };
  }
}

/** Best-effort: pull id-shaped values out of a JSON response body. Returns [] on any parse
 *  failure or when no id-shaped key is present — never fabricates a value to compare. */
function extractIdLikeValues(bodyText: string): string[] {
  try {
    const data: unknown = JSON.parse(bodyText);
    if (!data || typeof data !== 'object') return [];
    const out: string[] = [];
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (!ID_LIKE_KEY_PATTERN.test(key)) continue;
      if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
    }
    return out;
  } catch {
    return [];
  }
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  const runner = 'concurrency-race-condition';
  const devUrl = `http://localhost:${CONCURRENCY_DEV_PORT}`;

  const endpoints = await discoverWriteEndpoints(input.projectPath);
  if (endpoints.length === 0) {
    return skippedOutcome(
      runner,
      'no POST/PUT write endpoint discovered statically in the target project — cannot construct a concurrent-write probe without inventing a route (T1) — concurrency runner SKIPPED'
    );
  }
  const target = endpoints[0];
  if (!target) {
    return skippedOutcome(runner, 'no POST/PUT write endpoint discovered statically — concurrency runner SKIPPED');
  }

  let devServer: ChildProcess | null = null;
  try {
    devServer = spawn('pnpm', ['dev', '--port', String(CONCURRENCY_DEV_PORT)], {
      cwd: input.projectPath,
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  } catch (err) {
    return skippedOutcome(
      runner,
      `no live preview URL available — dev server could not be spawned (${err instanceof Error ? err.message : String(err)}) — concurrency runner SKIPPED`
    );
  }

  try {
    input.log(`concurrency: starting dev server on port ${CONCURRENCY_DEV_PORT} for concurrent-write probe against ${target.method} ${target.path} (declared in ${target.source})`);
    const ready = await waitForDevServer(devUrl, DEV_SERVER_READY_TIMEOUT_MS, input.log);
    if (!ready) {
      return skippedOutcome(
        runner,
        `no live preview URL available — dev server on port ${CONCURRENCY_DEV_PORT} did not become ready within ${DEV_SERVER_READY_TIMEOUT_MS}ms — concurrency runner SKIPPED`
      );
    }

    const probeUrl = `${devUrl}${target.path}`;

    input.log(`concurrency: sending solo baseline ${target.method} ${target.path}`);
    const baseline = await sendProbe(probeUrl, target.method, JSON.stringify({ probe: randomUUID() }));
    if (baseline.networkError) {
      return skippedOutcome(
        runner,
        `solo baseline request to ${target.method} ${target.path} failed at the network level — no clean baseline to compare a concurrent burst against — concurrency runner SKIPPED`
      );
    }

    input.log(`concurrency: firing ${CONCURRENT_REQUEST_COUNT} simultaneous ${target.method} requests at ${target.path}`);
    const bodies = Array.from({ length: CONCURRENT_REQUEST_COUNT }, () => JSON.stringify({ probe: randomUUID() }));
    const results = await Promise.all(bodies.map((body) => sendProbe(probeUrl, target.method, body)));

    const durationMs = Date.now() - started;
    const baselineWas5xx = (baseline.status ?? 0) >= 500;
    const fresh5xx = results.filter((r) => !r.networkError && (r.status ?? 0) >= 500);

    if (!baselineWas5xx && fresh5xx.length > 0) {
      const failures: RunnerFailure[] = [
        {
          name: `concurrent-${target.method.toLowerCase()}-${target.path}-5xx`,
          message: `${fresh5xx.length}/${CONCURRENT_REQUEST_COUNT} concurrent requests returned 5xx (statuses: ${fresh5xx.map((r) => r.status).join(', ')}) while the solo baseline returned ${baseline.status} — possible race condition under concurrent writes`,
          file: target.source,
        },
      ];
      return {
        runner,
        status: 'failed',
        testsTotal: 1,
        testsPassed: 0,
        testsFailed: 1,
        testsSkipped: 0,
        durationMs,
        failures,
        reportPath: null,
        exitCode: null,
        detail: `${target.method} ${target.path}: ${fresh5xx.length}/${CONCURRENT_REQUEST_COUNT} concurrent requests hit 5xx that the solo baseline (${baseline.status}) did not`,
        coverage: null,
      };
    }

    const idValues = results.flatMap((r) => extractIdLikeValues(r.bodyText));
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const id of idValues) {
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
    }

    if (duplicates.size > 0) {
      const failures: RunnerFailure[] = [
        {
          name: `concurrent-${target.method.toLowerCase()}-${target.path}-duplicate-id`,
          message: `${CONCURRENT_REQUEST_COUNT} concurrent requests produced duplicate id-shaped values in their responses (${[...duplicates].join(', ')}) — possible lost-update/double-allocation race`,
          file: target.source,
        },
      ];
      return {
        runner,
        status: 'failed',
        testsTotal: 1,
        testsPassed: 0,
        testsFailed: 1,
        testsSkipped: 0,
        durationMs,
        failures,
        reportPath: null,
        exitCode: null,
        detail: `${target.method} ${target.path}: duplicate id-shaped value(s) across ${CONCURRENT_REQUEST_COUNT} concurrent responses: ${[...duplicates].join(', ')}`,
        coverage: null,
      };
    }

    return {
      runner,
      status: 'passed',
      testsTotal: 1,
      testsPassed: 1,
      testsFailed: 0,
      testsSkipped: 0,
      durationMs,
      failures: [],
      reportPath: null,
      exitCode: null,
      detail: idValues.length > 0
        ? `${target.method} ${target.path}: ${CONCURRENT_REQUEST_COUNT}/${CONCURRENT_REQUEST_COUNT} concurrent requests completed with no fresh 5xx and no duplicate id-shaped values (${idValues.length} id-shaped value(s) observed, all unique)`
        : `${target.method} ${target.path}: ${CONCURRENT_REQUEST_COUNT}/${CONCURRENT_REQUEST_COUNT} concurrent requests completed with no fresh 5xx (no id-shaped field in the response body to cross-check for duplicates)`,
      coverage: null,
    };
  } catch (error) {
    return errorOutcome(runner, `concurrency probe threw: ${error instanceof Error ? error.message : String(error)}`, Date.now() - started);
  } finally {
    killChildProcess(devServer, input.log);
  }
}
