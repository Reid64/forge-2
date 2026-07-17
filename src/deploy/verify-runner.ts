/**
 * FORGE 2.0 — Post-Deploy Verification (F9, upgrades/TESTING_BLUEPRINT.md "Agent Contract:
 * DeployVerifier").
 *
 * Discovers every Next.js App Router API route under `<projectPath>/src/app/api` and fires a live
 * HTTP request at `<baseUrl><routePath>` for each, checking a 2xx status, a sub-3000ms response
 * time, and a JSON-parseable body. Results are appended to the target project's SESSION_STATE.md
 * under a `## VERIFICATION` section — never written to source or any other governance document
 * (Iron Law 1).
 */

import { readdir, appendFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { toAsciiGovernanceText } from '../tools/governance-text.js';

/** A route file is a Next.js App Router HTTP handler if it is named exactly `route.<ext>`. */
const ROUTE_FILE_RE = /^route\.(ts|tsx|js|jsx)$/;

/** Route-group segments (`(admin)`) do not appear in the URL — drop them when deriving the path. */
const ROUTE_GROUP_RE = /^\(.*\)$/;

export const DEFAULT_LATENCY_BUDGET_MS = 3000;

export interface VerifyRouteResult {
  route: string;
  statusCode: number | null;
  latencyMs: number;
  shapeOk: boolean;
  verdict: 'PASSED' | 'BLOCKED';
}

export interface VerifyResult {
  passed: boolean;
  baseUrl: string;
  routes: VerifyRouteResult[];
}

/** Recursively collect every `route.{ts,tsx,js,jsx}` file under `apiDir`. Missing dir → []. */
async function findApiRouteFiles(apiDir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing/unreadable directory — no routes to verify.
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (ROUTE_FILE_RE.test(entry.name)) results.push(full);
    }
  }
  await walk(apiDir);
  return results.sort();
}

/** `<apiDir>/users/[id]/route.ts` → `/api/users/[id]` (route groups stripped, POSIX separators). */
function toRoutePath(apiDir: string, routeFile: string): string {
  const rel = relative(apiDir, routeFile).split(sep).join('/');
  const withoutFile = rel.replace(ROUTE_FILE_RE, '').replace(/\/$/, '');
  const segments = withoutFile.split('/').filter((seg) => seg !== '' && !ROUTE_GROUP_RE.test(seg));
  return `/api/${segments.join('/')}`;
}

/** GET `<baseUrl><route>`, checking 2xx status, sub-budget latency, and a JSON body. */
async function checkRoute(baseUrl: string, route: string, latencyBudgetMs: number): Promise<VerifyRouteResult> {
  const url = `${baseUrl.replace(/\/$/, '')}${route}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), latencyBudgetMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: controller.signal });
    const latencyMs = Date.now() - start;
    let shapeOk: boolean;
    try {
      await res.clone().json();
      shapeOk = true;
    } catch {
      shapeOk = false;
    }
    const statusOk = res.status >= 200 && res.status < 300;
    const verdict: 'PASSED' | 'BLOCKED' = statusOk && latencyMs < latencyBudgetMs && shapeOk ? 'PASSED' : 'BLOCKED';
    return { route, statusCode: res.status, latencyMs, shapeOk, verdict };
  } catch {
    // Network failure, non-2xx-triggering abort, or timeout (the abort fires at latencyBudgetMs).
    return { route, statusCode: null, latencyMs: Date.now() - start, shapeOk: false, verdict: 'BLOCKED' };
  } finally {
    clearTimeout(timer);
  }
}

/** Append a timestamped `## VERIFICATION` section (per-route PASS/FAIL) to SESSION_STATE.md. */
export async function appendVerificationSection(
  governanceDir: string,
  baseUrl: string,
  result: VerifyResult
): Promise<void> {
  const target = join(governanceDir, 'SESSION_STATE.md');
  const timestamp = new Date().toISOString();
  const lines: string[] = ['', `## VERIFICATION — ${timestamp}`, '', `URL tested: ${baseUrl}`, ''];
  for (const r of result.routes) {
    const tag = r.verdict === 'PASSED' ? 'PASS' : 'FAIL';
    lines.push(`- [${tag}] ${r.route} — status ${r.statusCode ?? 'ERR'}, ${r.latencyMs}ms`);
  }
  lines.push('', `Build status: ${result.passed ? 'verification-passed' : 'verification-failed'}`, '');
  try {
    await appendFile(target, toAsciiGovernanceText(lines.join('\n') + '\n'), 'utf8');
  } catch {
    /* non-fatal — the state document update must never block verification reporting */
  }
}

export interface RunDeployVerificationInput {
  projectPath: string;
  baseUrl: string;
  latencyBudgetMs?: number;
  governanceDirName?: string;
}

/**
 * F9 entry point: discover every API route under `<projectPath>/src/app/api`, verify each against
 * `baseUrl`, append the results to `<projectPath>/<governanceDirName>/SESSION_STATE.md`, and return
 * the aggregate result. `passed` is false — and the SESSION_STATE.md entry records
 * `verification-failed` — if any route fails its status/latency/JSON-shape check.
 */
export async function runDeployVerification(input: RunDeployVerificationInput): Promise<VerifyResult> {
  const { projectPath, baseUrl, latencyBudgetMs = DEFAULT_LATENCY_BUDGET_MS, governanceDirName = 'governance' } = input;
  const apiDir = join(projectPath, 'src', 'app', 'api');
  const routeFiles = await findApiRouteFiles(apiDir);
  const routePaths = routeFiles.map((f) => toRoutePath(apiDir, f));

  const routes: VerifyRouteResult[] = [];
  for (const route of routePaths) {
    routes.push(await checkRoute(baseUrl, route, latencyBudgetMs));
  }

  const passed = routes.every((r) => r.verdict === 'PASSED');
  const result: VerifyResult = { passed, baseUrl, routes };

  await appendVerificationSection(join(projectPath, governanceDirName), baseUrl, result);

  return result;
}
