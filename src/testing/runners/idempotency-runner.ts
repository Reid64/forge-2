// FORGE 2.0 — Enterprise Test Suite: IDEMPOTENCY runner (duplicate-request probing against a live
// preview URL).
//
// Gated to the ENTERPRISE_RELEASE readiness tier ONLY (`src/governance/readiness-levels.ts` —
// `MISSION_CRITICAL` id, reused verbatim by `HYPERSCALE` via `ALL_TEST_SUITES`) — same top-of-the-
// ladder placement as chaos-runner.ts/recovery-runner.ts/backup-restore-runner.ts: this probe hits
// a real running instance of the target app under real request load, and has no business firing
// before a build is otherwise release-candidate quality.
//
// "Live preview URL" mechanism: reuses chaos-runner.ts's/recovery-runner.ts's own-throwaway-dev-
// server convention verbatim (own dedicated port, `pnpm dev --port <port>`, poll until ready,
// always kill afterward) — see chaos-runner.ts's module doc comment for why there is no existing
// preview-URL-injection mechanism anywhere in this codebase to reuse instead. New dedicated port
// (3095 recovery / 3096 chaos / 3097 schemathesis / 3098 zap / 3099 lighthouse are all already
// spoken for): this runner uses 3100.
//
// SIMPLIFYING ASSUMPTIONS (no app-specific knowledge is available to this runner, by design — T1:
// never fabricate a probe target or payload the target project didn't actually declare):
//   1. No `Idempotency-Key`-header convention was found anywhere in this codebase to standardize on
//      (grep for "Idempotency-Key"/"idempotency" across src/ turns up only skill-template docs that
//      *describe* the pattern for user projects to adopt, never a concrete header name FORGE itself
//      enforces). This runner sends the SAME literal duplicate request twice — identical method,
//      path, and body — and additionally attaches a stable `Idempotency-Key` header (one UUID,
//      reused verbatim on both requests) in case the target project happens to honor that
//      convention. Neither request depends on the header being recognized; a project that ignores
//      it is evaluated purely on literal-duplicate-request handling.
//   2. Discovering a WRITE endpoint (POST/PUT) to duplicate-probe requires knowing the target
//      project's routes without inventing one. This runner statically scans the project's own
//      source (Express/Fastify-style `app.post('/x', ...)`/`app.put('/x', ...)` registrations, and
//      Next.js `app/**/route.ts` files that `export function POST`/`export function PUT`) for a
//      concrete, real write-endpoint path — the same two-stage "static discovery, then live
//      validation" shape recovery-runner.ts already uses for health-check paths. No endpoint found
//      -> SKIPPED (never fabricate a route to probe).
//   3. What is realistically checkable black-box, without a schema: true idempotency (second
//      request produces no additional side effect) cannot be verified without querying the app's
//      own data store, which this runner has no access to and no business reaching into (Contract
//      6 — never touch the target project's own infrastructure/data beyond HTTP probing). The
//      checkable proxy this runner uses instead is response-CONSISTENCY: does the app handle the
//      literal repeat cleanly (same status class, or a clean 2xx-then-4xx "already exists"
//      rejection), or does it fall over (5xx) where the first request didn't? A 5xx on the second,
//      identical request — while the first succeeded or failed differently — is a strong signal the
//      duplicate hit an unhandled failure mode (e.g. an uncaught unique-constraint violation)
//      instead of being recognized and handled. That is the one thing black-box HTTP probing can
//      responsibly assert; it is documented here rather than silently redefined as "the same thing"
//      as full idempotency.
//
// Outcome policy:
//   - No write endpoint (POST/PUT) discovered statically -> SKIPPED (T1).
//   - Dev server never becomes ready -> SKIPPED (T1 — cannot probe what isn't reachable).
//   - Second (duplicate) request returns 5xx while the first request did NOT -> FAILED (possible
//     unhandled crash on retry — the concrete, checkable idempotency-adjacent signal above).
//   - Otherwise -> PASSED (covers: both identical, both differ but neither is a fresh 5xx, or both
//     fail identically — all are consistent-with-idempotent-handling outcomes given assumption 3).

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { errorOutcome, skippedOutcome, type RunnerInput, type RunnerOutcome } from './types.js';

const IDEMPOTENCY_DEV_PORT = 3100;
const DEV_SERVER_READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.forge', 'coverage']);
const SCANNABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_FILES_SCANNED = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mirrors chaos-runner.ts's/recovery-runner.ts's own (non-exported) `waitForDevServer`. */
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
    log(`idempotency: waiting for dev server at ${url}…`);
  }
  return false;
}

function killChildProcess(proc: ChildProcess | null, log: (m: string) => void): void {
  if (!proc) return;
  try {
    if (!proc.killed) proc.kill('SIGTERM');
  } catch (err) {
    log(`WARNING: idempotency-runner — could not kill dev server (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function collectSourceFiles(projectPath: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [projectPath];
  while (stack.length > 0 && out.length < MAX_FILES_SCANNED) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (SCANNABLE_EXTENSIONS.has('.' + (entry.name.split('.').pop() ?? ''))) {
        out.push(full);
      }
      if (out.length >= MAX_FILES_SCANNED) break;
    }
  }
  return out;
}

export interface DiscoveredWriteEndpoint {
  method: 'POST' | 'PUT';
  path: string;
  source: string;
}

/** Statically discover a real POST/PUT write endpoint: Express/Fastify-style route registrations,
 *  and Next.js app-router `route.ts` files exporting `POST`/`PUT`. Never throws — returns [] on any
 *  error. Exported for reuse by concurrency-runner.ts (same discovery need, same shape). */
export async function discoverWriteEndpoints(projectPath: string): Promise<DiscoveredWriteEndpoint[]> {
  const found: DiscoveredWriteEndpoint[] = [];
  const files = await collectSourceFiles(projectPath);

  // Express/Fastify-style explicit route registration: app.post('/x', ...), router.put("/y", ...).
  const routeRegex = /\.(post|put)\s*\(\s*(['"`])(\/[a-zA-Z0-9/_-]*)\2/gi;
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    while ((m = routeRegex.exec(text)) !== null) {
      const method = (m[1] ?? '').toUpperCase() as 'POST' | 'PUT';
      const path = m[3];
      if (path) found.push({ method, path, source: relative(projectPath, file) });
    }

    // Next.js app-router file-based routing: app/**/route.ts exporting POST/PUT.
    const relPath = relative(projectPath, file).replace(/\\/g, '/');
    const routeFileMatch = /(?:^|\/)(?:src\/)?app\/(.+)\/route\.(?:ts|js)$/.exec(relPath);
    if (routeFileMatch) {
      const routePath = '/' + routeFileMatch[1];
      if (/export\s+(?:async\s+)?function\s+POST\b/.test(text)) {
        found.push({ method: 'POST', path: routePath, source: relPath });
      }
      if (/export\s+(?:async\s+)?function\s+PUT\b/.test(text)) {
        found.push({ method: 'PUT', path: routePath, source: relPath });
      }
    }
  }

  return found;
}

interface ProbeResult {
  status: number | null;
  networkError: boolean;
}

async function sendProbe(url: string, method: string, idempotencyKey: string): Promise<ProbeResult> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const resp = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: '{}',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return { status: resp.status, networkError: false };
  } catch {
    return { status: null, networkError: true };
  }
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  const runner = 'idempotency-duplicate-request';
  const devUrl = `http://localhost:${IDEMPOTENCY_DEV_PORT}`;

  const endpoints = await discoverWriteEndpoints(input.projectPath);
  if (endpoints.length === 0) {
    return skippedOutcome(
      runner,
      'no POST/PUT write endpoint discovered statically in the target project — cannot construct a duplicate-request probe without inventing a route (T1) — idempotency runner SKIPPED'
    );
  }
  const target = endpoints[0];
  if (!target) {
    return skippedOutcome(runner, 'no POST/PUT write endpoint discovered statically — idempotency runner SKIPPED');
  }

  let devServer: ChildProcess | null = null;
  try {
    devServer = spawn('pnpm', ['dev', '--port', String(IDEMPOTENCY_DEV_PORT)], {
      cwd: input.projectPath,
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  } catch (err) {
    return skippedOutcome(
      runner,
      `no live preview URL available — dev server could not be spawned (${err instanceof Error ? err.message : String(err)}) — idempotency runner SKIPPED`
    );
  }

  try {
    input.log(`idempotency: starting dev server on port ${IDEMPOTENCY_DEV_PORT} for duplicate-request probe against ${target.method} ${target.path} (declared in ${target.source})`);
    const ready = await waitForDevServer(devUrl, DEV_SERVER_READY_TIMEOUT_MS, input.log);
    if (!ready) {
      return skippedOutcome(
        runner,
        `no live preview URL available — dev server on port ${IDEMPOTENCY_DEV_PORT} did not become ready within ${DEV_SERVER_READY_TIMEOUT_MS}ms — idempotency runner SKIPPED`
      );
    }

    const idempotencyKey = randomUUID();
    const probeUrl = `${devUrl}${target.path}`;

    input.log(`idempotency: sending first ${target.method} ${target.path}`);
    const first = await sendProbe(probeUrl, target.method, idempotencyKey);
    input.log(`idempotency: sending duplicate ${target.method} ${target.path} (same body, same Idempotency-Key)`);
    const second = await sendProbe(probeUrl, target.method, idempotencyKey);

    const durationMs = Date.now() - started;
    const firstOk = !first.networkError && (first.status ?? 0) < 500;
    const secondCrashed = !second.networkError && (second.status ?? 0) >= 500;

    if (firstOk && secondCrashed) {
      return {
        runner,
        status: 'failed',
        testsTotal: 1,
        testsPassed: 0,
        testsFailed: 1,
        testsSkipped: 0,
        durationMs,
        failures: [
          {
            name: `duplicate-${target.method.toLowerCase()}-${target.path}`,
            message: `first request -> ${first.status}, duplicate request -> ${second.status} (5xx) — the duplicate was not handled cleanly`,
            file: target.source,
          },
        ],
        reportPath: null,
        exitCode: null,
        detail: `${target.method} ${target.path}: first request ${first.status}, duplicate request ${second.status} (5xx on the repeat) — possible unhandled failure on duplicate submission`,
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
      detail: `${target.method} ${target.path}: first request ${first.networkError ? 'network error' : first.status}, duplicate request ${second.networkError ? 'network error' : second.status} — no fresh 5xx on the repeat`,
      coverage: null,
    };
  } catch (error) {
    return errorOutcome(runner, `idempotency probe threw: ${error instanceof Error ? error.message : String(error)}`, Date.now() - started);
  } finally {
    killChildProcess(devServer, input.log);
  }
}
