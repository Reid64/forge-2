// FORGE 2.0 — Enterprise Test Suite: CHAOS runner (chaos engineering — latency injection +
// malformed-request injection against a live preview URL).
//
// Gated to the ENTERPRISE_RELEASE readiness tier ONLY (`src/governance/readiness-levels.ts` —
// `MISSION_CRITICAL` id, reused verbatim by `HYPERSCALE` via `ALL_TEST_SUITES`) — same top-of-the-
// ladder placement as MUTATION's ENTERPRISE_RELEASE half (mutation-runner.ts), deliberately never
// at MILESTONE or PRE-DEPLOYMENT: chaos probes hit a real running instance of the target app and
// have no business firing before a build is otherwise release-candidate quality.
//
// "Live preview URL" mechanism: there is no existing preview-URL-injection convention anywhere in
// this codebase (RunnerInput carries only `projectPath`/`log`/`timeoutMs` — no URL field) or in
// zap-runner.ts specifically (it delegates to phase4-sentinel.ts's `runRing3ZapCheck`, which does
// not receive one either). What every live-target Ring 3 check in phase4-sentinel.ts (Lighthouse/
// ZAP/Schemathesis) actually does is spawn its OWN throwaway dev server on a dedicated localhost
// port and treat that as the live target, skipping cleanly when the server never becomes ready.
// This runner reuses that exact convention (own dedicated port, `pnpm dev --port <port>`, poll
// until ready, always kill afterward) rather than a preview-URL field that does not exist anywhere
// to reuse. Per exec.ts's own precedent ("not exported from phase4-sentinel.ts, so it is
// intentionally re-implemented here rather than reaching across module boundaries into Sentinel's
// internals"), the small spawn/wait/kill boilerplate is re-implemented locally rather than reaching
// into phase4-sentinel.ts's non-exported helpers.
//
// No dev server reachable within the boot window = SKIPPED (not FAIL) — "no live preview URL
// available" (T1: absence of a probeable target is never fabricated into a pass OR a fail).
//
// Chaos scenarios (safe, non-destructive — localhost-only, single low-volume connections, never a
// flood):
//   1. Latency injection: a request whose body is dripped a few bytes at a time (artificial
//      injected network latency) with a bounded hard cap. PASS if the server either completes the
//      request, or closes/errors the connection cleanly, within the cap (both are legitimate
//      "handled the slow client" outcomes) — FAIL only if the connection hangs past the hard cap
//      (a real DoS-susceptibility signal).
//   2. Malformed-request injection: a handful of intentionally invalid raw HTTP requests (garbage
//      method, mismatched Content-Length, invalid Content-Type + garbage body, oversized header,
//      truncated chunked encoding) sent over raw sockets (native `fetch`/`http` cannot express an
//      invalid request). Each is followed by a normal liveness probe — FAIL if the server stopped
//      responding (crashed) or the malformed response itself leaked a raw stack trace; PASS
//      otherwise (a clean 4xx/5xx or connection-reset is a fine, non-crashing response to garbage
//      input).

import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

/** Dedicated localhost port for this runner's own throwaway dev server (distinct from
 *  phase4-sentinel.ts's LIGHTHOUSE_DEV_PORT=3099 / ZAP_DEV_PORT=3098 / SCHEMATHESIS_DEV_PORT=3097). */
const CHAOS_DEV_PORT = 3096;
const DEV_SERVER_READY_TIMEOUT_MS = 30_000;
const LATENCY_PROBE_HARD_CAP_MS = 8_000;
const MALFORMED_PROBE_TIMEOUT_MS = 5_000;
const LIVENESS_PROBE_TIMEOUT_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `url` until it responds with HTTP < 500 or `timeoutMs` elapses. Never throws. Mirrors
 *  phase4-sentinel.ts's `waitForDevServer` (not exported — reimplemented per exec.ts's precedent). */
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
    log(`chaos: waiting for dev server at ${url}…`);
  }
  return false;
}

function killChildProcess(proc: ChildProcess | null, log: (m: string) => void): void {
  if (!proc) return;
  try {
    if (!proc.killed) proc.kill('SIGTERM');
  } catch (err) {
    log(`WARNING: chaos-runner — could not kill dev server (${err instanceof Error ? err.message : String(err)})`);
  }
}

interface ScenarioResult {
  name: string;
  passed: boolean;
  detail: string;
}

/** Scenario 1 — latency injection: drip a short request body over `LATENCY_PROBE_HARD_CAP_MS` and
 *  confirm the server doesn't hang past the hard cap. */
async function runLatencyInjectionProbe(port: number): Promise<ScenarioResult> {
  const bodyChunks = ['c', 'h', 'a', 'o', 's'];
  const body = bodyChunks.join('');
  const requestHead =
    `POST / HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${port}\r\n` +
    `Content-Type: text/plain\r\n` +
    `Content-Length: ${body.length}\r\n` +
    `Connection: close\r\n\r\n`;

  return new Promise<ScenarioResult>((resolve) => {
    const socket = new net.Socket();
    let data = '';
    let finished = false;
    const finish = (result: ScenarioResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(capTimer);
      try {
        socket.destroy();
      } catch {
        // already gone
      }
      resolve(result);
    };
    const capTimer = setTimeout(
      () =>
        finish({
          name: 'latency-injection',
          passed: false,
          detail: `request dripped over ~${bodyChunks.length * 300}ms never completed within the ${LATENCY_PROBE_HARD_CAP_MS}ms hard cap — possible hang under slow-client load`,
        }),
      LATENCY_PROBE_HARD_CAP_MS
    );

    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('error', (err) => {
      finish({ name: 'latency-injection', passed: true, detail: `connection handled cleanly under injected latency (${err.message})` });
    });
    socket.on('close', () => {
      finish({
        name: 'latency-injection',
        passed: true,
        detail: data ? `server responded (${data.split('\r\n')[0]}) despite injected latency` : 'connection closed cleanly under injected latency',
      });
    });
    socket.connect(port, '127.0.0.1', () => {
      void (async () => {
        try {
          socket.write(requestHead);
          for (const chunk of bodyChunks) {
            await sleep(300);
            if (socket.destroyed) return;
            socket.write(chunk);
          }
        } catch {
          // surfaced via the 'error' listener above
        }
      })();
    });
  });
}

interface MalformedScenario {
  name: string;
  raw: string;
}

const MALFORMED_SCENARIOS: MalformedScenario[] = [
  { name: 'invalid-method', raw: 'CHAOS / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' },
  {
    name: 'content-length-mismatch',
    raw: 'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\nContent-Length: 500\r\nConnection: close\r\n\r\nshort',
  },
  {
    name: 'invalid-content-type',
    raw: 'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: ###not-a-mime-type###\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{not valid json',
  },
  {
    name: 'oversized-header',
    raw: `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Chaos-Oversized: ${'A'.repeat(65536)}\r\nConnection: close\r\n\r\n`,
  },
  {
    name: 'truncated-chunked-encoding',
    raw: 'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nzzz\r\n',
  },
];

/** Send one raw (possibly invalid) HTTP request over a raw socket and capture whatever comes back.
 *  Never throws — connection errors/timeouts are captured as data, not exceptions. */
function sendRawRequest(port: number, raw: string, timeoutMs: number): Promise<{ data: string; errored: boolean }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let data = '';
    let finished = false;
    const finish = (errored: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // already gone
      }
      resolve({ data, errored });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('error', () => finish(true));
    socket.on('close', () => finish(false));
    socket.connect(port, '127.0.0.1', () => {
      try {
        socket.write(raw);
      } catch {
        finish(true);
      }
    });
  });
}

/** A crude stack-trace-leak heuristic: file:line:col frames or `node_modules` paths surfacing in an
 *  HTTP response body (the "don't leak stack traces" half of the graceful-degradation bar). */
const STACK_TRACE_PATTERN = /at\s+\S+\s+\([^)]*:\d+:\d+\)|node_modules[\\/]|\.(?:js|ts):\d+:\d+/;

/** Scenario 2 — one malformed request, followed by a liveness re-check against the dev server. */
async function runMalformedScenario(port: number, devUrl: string, scenario: MalformedScenario): Promise<ScenarioResult> {
  const probe = await sendRawRequest(port, scenario.raw, MALFORMED_PROBE_TIMEOUT_MS);

  // Liveness: the server must still answer a normal request afterward.
  let alive = true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIVENESS_PROBE_TIMEOUT_MS);
    await fetch(devUrl, { signal: ctrl.signal });
    clearTimeout(timer);
  } catch {
    alive = false;
  }

  if (!alive) {
    return { name: scenario.name, passed: false, detail: 'server stopped responding after this malformed request (possible crash)' };
  }
  if (STACK_TRACE_PATTERN.test(probe.data)) {
    return { name: scenario.name, passed: false, detail: 'malformed-request response leaked a raw stack trace' };
  }
  return {
    name: scenario.name,
    passed: true,
    detail: probe.data
      ? `server degraded gracefully (${probe.data.split('\r\n')[0] || 'response received'}), no stack trace leaked, still alive afterward`
      : 'connection reset/closed without a response, server still alive afterward',
  };
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  const runner = 'chaos-engineering';
  const devUrl = `http://localhost:${CHAOS_DEV_PORT}`;

  let devServer: ChildProcess | null = null;
  try {
    devServer = spawn('pnpm', ['dev', '--port', String(CHAOS_DEV_PORT)], {
      cwd: input.projectPath,
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  } catch (err) {
    return skippedOutcome(
      runner,
      `no live preview URL available — dev server could not be spawned (${err instanceof Error ? err.message : String(err)}) — chaos runner SKIPPED`
    );
  }

  try {
    input.log(`chaos: starting dev server on port ${CHAOS_DEV_PORT} for chaos engineering probes`);
    const ready = await waitForDevServer(devUrl, DEV_SERVER_READY_TIMEOUT_MS, input.log);
    if (!ready) {
      return skippedOutcome(
        runner,
        `no live preview URL available — dev server on port ${CHAOS_DEV_PORT} did not become ready within ${DEV_SERVER_READY_TIMEOUT_MS}ms — chaos runner SKIPPED`
      );
    }

    input.log(`chaos: running latency-injection probe against ${devUrl}`);
    const results: ScenarioResult[] = [await runLatencyInjectionProbe(CHAOS_DEV_PORT)];

    for (const scenario of MALFORMED_SCENARIOS) {
      input.log(`chaos: running malformed-request probe "${scenario.name}" against ${devUrl}`);
      results.push(await runMalformedScenario(CHAOS_DEV_PORT, devUrl, scenario));
    }

    const durationMs = Date.now() - started;
    const passed = results.filter((r) => r.passed);
    const failed = results.filter((r) => !r.passed);
    const failures: RunnerFailure[] = failed.map((r) => ({ name: r.name, message: r.detail, file: '' }));

    const status: RunnerOutcome['status'] = failed.length > 0 ? 'failed' : 'passed';
    return {
      runner,
      status,
      testsTotal: results.length,
      testsPassed: passed.length,
      testsFailed: failed.length,
      testsSkipped: 0,
      durationMs,
      failures,
      reportPath: null,
      exitCode: null,
      detail:
        status === 'passed'
          ? `${passed.length}/${results.length} chaos probe(s) handled gracefully (1 latency-injection, ${MALFORMED_SCENARIOS.length} malformed-request scenarios)`
          : `${failed.length}/${results.length} chaos probe(s) FAILED: ${failed.map((r) => r.name).join(', ')}`,
      coverage: null,
    };
  } catch (error) {
    return errorOutcome(runner, `chaos-engineering probes threw: ${error instanceof Error ? error.message : String(error)}`, Date.now() - started);
  } finally {
    killChildProcess(devServer, input.log);
  }
}
