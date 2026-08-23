// FORGE 2.0 — Enterprise Test Suite: RECOVERY runner (disaster-recovery readiness — health-check
// endpoint presence + correctness). Maps to `TestSuiteDb` value `DISASTER_RECOVERY`.
//
// Gated to the ENTERPRISE_RELEASE readiness tier ONLY (`src/governance/readiness-levels.ts` —
// `MISSION_CRITICAL` id, reused verbatim by `HYPERSCALE` via `ALL_TEST_SUITES`) — same top-of-the-
// ladder placement as chaos-runner.ts / MUTATION's ENTERPRISE_RELEASE half.
//
// This is a PRESENCE/CORRECTNESS check, not a disaster-recovery drill: it never tears anything
// down or actually fails the app over. It answers one narrow question — "does this project expose
// a health-check endpoint, and does it respond sanely?" — which is the minimum machine-verifiable
// signal that a real DR/failover process (external to FORGE) has something to poll.
//
// Two-stage detection, in the same spirit as `definition-of-done.ts`'s `checkNoOpenBlocker`
// (multiple candidate locations, degrade honestly rather than fabricate a signal):
//   1. Static scan: grep the project's own route-registration source (Express/Fastify-style
//      `app.get('/health', ...)`, Next.js `app/**/health/route.ts` and `pages/api/health.ts`
//      conventions) for the common health-check path conventions (`/health`, `/api/health`,
//      `/healthz`, `/api/healthz`, `/status`, `/api/status`, `/ping`).
//   2. Live validation: reuse zap-runner.ts's/phase4-sentinel.ts's own-dev-server convention (see
//      chaos-runner.ts's module doc comment for why — there is no existing preview-URL-injection
//      mechanism anywhere in this codebase to reuse instead) to spin up the project's dev server on
//      a dedicated port and HTTP-probe the statically-discovered path(s) first, falling back to the
//      full common-convention list when static discovery found nothing.
//
// Outcome policy:
//   - A live probe returns 200 with a non-empty, sensible body on any candidate path -> PASSED.
//   - Static scan found a declared health route, but no live probe of it (or any candidate)
//     succeeded -> FAILED (the endpoint is declared but broken/unreachable).
//   - Static scan found nothing AND the dev server never became ready to probe live -> SKIPPED
//     (T1 — cannot determine anything either way, never fabricate a verdict).
//   - Static scan found nothing, dev server IS reachable, but no candidate path responds -> FAILED
//     at ENTERPRISE_RELEASE tier a health-check endpoint is a real requirement, not optional, so an
//     app that is live but exposes none is a genuine gap, not an "N/A".

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

const RECOVERY_DEV_PORT = 3095;
const DEV_SERVER_READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

/** Common health-check path conventions, most specific/likely first. */
const CANDIDATE_PATHS = ['/api/health', '/health', '/healthz', '/api/healthz', '/api/status', '/status', '/ping'];

/** Source-tree scan bounds — mirrors other runners' "don't walk node_modules/dist" convention. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.forge', 'coverage']);
const SCANNABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_FILES_SCANNED = 3000;

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
    log(`recovery: waiting for dev server at ${url}…`);
  }
  return false;
}

function killChildProcess(proc: ChildProcess | null, log: (m: string) => void): void {
  if (!proc) return;
  try {
    if (!proc.killed) proc.kill('SIGTERM');
  } catch (err) {
    log(`WARNING: recovery-runner — could not kill dev server (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** Walk `projectPath` (bounded) collecting scannable source files. Never throws. */
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

/** Statically discover health-route declarations: Express/Fastify-style route registrations
 *  referencing one of `CANDIDATE_PATHS`, and Next.js file-based routes
 *  (`app/**​/health/route.ts`, `pages/api/health*.ts`). Never throws — returns []  on any error. */
async function discoverDeclaredHealthPaths(projectPath: string): Promise<string[]> {
  const found = new Set<string>();

  // Next.js file-based routing: a file path itself declares the route.
  const files = await collectSourceFiles(projectPath);
  for (const file of files) {
    const relPath = relative(projectPath, file).replace(/\\/g, '/');
    for (const candidate of CANDIDATE_PATHS) {
      const slug = candidate.replace(/^\//, ''); // "api/health"
      if (
        relPath === `pages/${slug}.ts` ||
        relPath === `pages/${slug}.js` ||
        relPath === `src/pages/${slug}.ts` ||
        relPath === `src/pages/${slug}.js` ||
        relPath.endsWith(`app/${slug}/route.ts`) ||
        relPath.endsWith(`app/${slug}/route.js`) ||
        relPath.endsWith(`src/app/${slug}/route.ts`) ||
        relPath.endsWith(`src/app/${slug}/route.js`)
      ) {
        found.add(candidate);
      }
    }
  }

  // Express/Fastify-style explicit route registration: app.get('/health', ...), router.get("/api/health", ...).
  const routeRegex = /\.(?:get|all|use)\s*\(\s*(['"`])(\/[a-zA-Z0-9/_-]*)\1/g;
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    while ((m = routeRegex.exec(text)) !== null) {
      const path = m[2];
      if (path && CANDIDATE_PATHS.includes(path)) found.add(path);
    }
  }

  return [...found];
}

interface ProbeOutcome {
  path: string;
  ok: boolean;
  status: number | null;
  detail: string;
}

/** GET `devUrl + path`, evaluate "responds correctly" as: 2xx status + a non-empty body. */
async function probeHealthPath(devUrl: string, path: string): Promise<ProbeOutcome> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const resp = await fetch(`${devUrl}${path}`, { signal: ctrl.signal });
    clearTimeout(timer);
    const body = await resp.text().catch(() => '');
    const ok = resp.status >= 200 && resp.status < 300 && body.trim().length > 0;
    return {
      path,
      ok,
      status: resp.status,
      detail: ok
        ? `${resp.status} with a ${body.trim().length}-byte body`
        : `${resp.status}${body.trim().length === 0 ? ' with an empty body' : ''}`,
    };
  } catch (error) {
    return { path, ok: false, status: null, detail: `not reachable (${error instanceof Error ? error.message : String(error)})` };
  }
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  const runner = 'health-check-presence';
  const devUrl = `http://localhost:${RECOVERY_DEV_PORT}`;

  const declaredPaths = await discoverDeclaredHealthPaths(input.projectPath);
  const pathsToProbe = declaredPaths.length > 0 ? declaredPaths : CANDIDATE_PATHS;

  let devServer: ChildProcess | null = null;
  try {
    devServer = spawn('pnpm', ['dev', '--port', String(RECOVERY_DEV_PORT)], {
      cwd: input.projectPath,
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  } catch (err) {
    return skippedOutcome(
      runner,
      `no live preview URL available — dev server could not be spawned (${err instanceof Error ? err.message : String(err)}) — recovery runner SKIPPED`
    );
  }

  try {
    input.log(`recovery: starting dev server on port ${RECOVERY_DEV_PORT} for health-check validation`);
    const ready = await waitForDevServer(devUrl, DEV_SERVER_READY_TIMEOUT_MS, input.log);
    if (!ready) {
      if (declaredPaths.length === 0) {
        return skippedOutcome(
          runner,
          `no health-check route declaration found statically, and dev server on port ${RECOVERY_DEV_PORT} did not become ready to probe live — recovery runner SKIPPED`
        );
      }
      return {
        runner,
        status: 'failed',
        testsTotal: 1,
        testsPassed: 0,
        testsFailed: 1,
        testsSkipped: 0,
        durationMs: Date.now() - started,
        failures: [
          {
            name: 'health-endpoint-unreachable',
            message: `route(s) declared (${declaredPaths.join(', ')}) but dev server never became ready to validate them live`,
            file: '',
          },
        ],
        reportPath: null,
        exitCode: null,
        detail: `health route(s) statically declared (${declaredPaths.join(', ')}) but could not be live-validated — dev server unreachable`,
        coverage: null,
      };
    }

    input.log(`recovery: probing ${pathsToProbe.length} candidate health-check path(s) against ${devUrl}`);
    const probes: ProbeOutcome[] = [];
    for (const path of pathsToProbe) {
      probes.push(await probeHealthPath(devUrl, path));
    }

    const working = probes.find((p) => p.ok);
    const durationMs = Date.now() - started;

    if (working) {
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
        detail: `health-check endpoint ${working.path} responded correctly — ${working.detail}`,
        coverage: null,
      };
    }

    // No candidate path worked.
    if (declaredPaths.length === 0) {
      return skippedOutcome(
        runner,
        `no health-check endpoint declared in source and none of the common conventions (${CANDIDATE_PATHS.join(', ')}) responded — recovery runner SKIPPED`
      );
    }

    const failures: RunnerFailure[] = probes.map((p) => ({ name: p.path, message: p.detail, file: '' }));
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
      detail: `health route(s) declared (${declaredPaths.join(', ')}) but none responded correctly: ${probes.map((p) => `${p.path} -> ${p.detail}`).join('; ')}`,
      coverage: null,
    };
  } catch (error) {
    return errorOutcome(runner, `health-check validation threw: ${error instanceof Error ? error.message : String(error)}`, Date.now() - started);
  } finally {
    killChildProcess(devServer, input.log);
  }
}
