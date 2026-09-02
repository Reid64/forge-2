/**
 * FORGE 2.0 — Incremental Test Runner (`src/tools/incremental-tester.ts`).
 *
 * Three public entry points:
 *
 *   - {@link runIncrementalTests} — given the files that changed after a prompt, discovers which
 *     test files cover them (by naming convention: `foo.ts → foo.test.ts` / `foo.spec.ts`) and runs
 *     ONLY those tests. Skips the full suite so the gate stays fast between prompts.
 *   - {@link shouldRunTests} — frequency guard used by the executor to decide whether to call
 *     either runner; always triggers on integration/deploy phase prompts.
 *   - {@link runSmokeTests} — three-step minimal validation: compile check (`pnpm tsc --noEmit`),
 *     build check (`pnpm run build`), and three core page-load probes against the running dev
 *     server. Run every {@link SMOKE_FREQUENCY} prompts per Blueprint 2B spec.
 *
 * HOUSE RULES: never throws, never fabricates a pass, no console.log. All diagnostics flow through
 * {@link logLine}. Uses Node.js built-in `node:child_process` so no extra runtime deps are needed.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import { logLine } from './forge-logger.js';
import { nowIso } from '../memory/index.js';
import type { TestResult, TestFileResult } from '../types/index.js';
import { defaultStartDevServer, type DevServerStarter, type PreviewServerHandle } from './live-preview-gate.js';

export type { TestResult, TestFileResult };

const execFileAsync = promisify(execFile);
const log = logLine('incremental-tester');

// Phase names that always trigger tests regardless of promptIndex.
const ALWAYS_RUN_PHASES: readonly string[] = ['integration', 'deploy', 'deployment', 'phase4', 'phase-4'];

// Core routes probed by runSmokeTests (relative paths joined onto the smoke base URL).
const SMOKE_ROUTES: readonly string[] = ['/', '/login', '/dashboard'];
// Dedicated port (next free one after the testing-runner throwaway-dev-server convention's
// 3095-3103 — idempotency/chaos/recovery/cross-browser/cross-device runners), so a per-prompt
// smoke probe never collides with an operator's own `pnpm dev` that happens to be on 3000.
const SMOKE_DEV_PORT = 3104;
const SMOKE_BASE_URL = `http://localhost:${SMOKE_DEV_PORT}`;
const SMOKE_STARTUP_TIMEOUT_MS = 90_000;
const SMOKE_POLL_INTERVAL_MS = 1_000;
const SMOKE_FETCH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Try to resolve the test file that covers `sourceFile` by naming convention:
 *   src/tools/foo.ts  →  <testDir>/foo.test.ts  or  <testDir>/foo.spec.ts
 * Returns the first match found, or null when none exist on disk.
 */
function testFileForSource(sourceFile: string, testDir: string): string | null {
  const name = basename(sourceFile);
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const candidates = [
    join(testDir, `${stem}.test.ts`),
    join(testDir, `${stem}.test.js`),
    join(testDir, `${stem}.spec.ts`),
    join(testDir, `${stem}.spec.js`),
    // Preserve original extension when it isn't .ts (e.g. .tsx → .test.tsx)
    ...(ext && ext !== '.ts' && ext !== '.js'
      ? [join(testDir, `${stem}.test${ext}`), join(testDir, `${stem}.spec${ext}`)]
      : []),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Collect the subset of test files that correspond to the changed source files. */
function findRelevantTestFiles(changedFiles: string[], testDir: string): string[] {
  if (!existsSync(testDir)) return [];
  const seen = new Set<string>();
  const relevant: string[] = [];
  for (const file of changedFiles) {
    const found = testFileForSource(file, testDir);
    if (found && !seen.has(found)) {
      seen.add(found);
      relevant.push(found);
    }
  }
  return relevant;
}

/** Execute one test file with `node --import tsx --test` and return a structured result. */
async function runOneTestFile(file: string, projectPath: string): Promise<TestFileResult> {
  const start = performance.now();
  const useShell = process.platform === 'win32';
  try {
    const { stdout, stderr } = await execFileAsync('node', ['--import', 'tsx', '--test', file], {
      cwd: projectPath,
      timeout: 60_000,
      shell: useShell,
    });
    const output = [stdout, stderr].filter(Boolean).join('\n');
    return { file, passed: true, duration: Math.round(performance.now() - start), output, error: null };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = [execErr.stdout ?? '', execErr.stderr ?? ''].filter(Boolean).join('\n');
    return {
      file,
      passed: false,
      duration: Math.round(performance.now() - start),
      output,
      error: execErr.message ?? describeError(err),
    };
  }
}

/** Run `pnpm tsc --noEmit` and return a named check result. Never throws. */
async function compileCheck(projectPath: string): Promise<TestFileResult> {
  const start = performance.now();
  const useShell = process.platform === 'win32';
  try {
    const { stdout, stderr } = await execFileAsync('pnpm', ['tsc', '--noEmit'], {
      cwd: projectPath,
      timeout: 120_000,
      shell: useShell,
    });
    const output = [stdout, stderr].filter(Boolean).join('\n');
    return { file: 'compile:tsc --noEmit', passed: true, duration: Math.round(performance.now() - start), output, error: null };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = [execErr.stdout ?? '', execErr.stderr ?? ''].filter(Boolean).join('\n');
    return {
      file: 'compile:tsc --noEmit',
      passed: false,
      duration: Math.round(performance.now() - start),
      output,
      error: execErr.message ?? describeError(err),
    };
  }
}

/** Run `pnpm run build` and return a named check result. Never throws. */
async function buildCheck(projectPath: string): Promise<TestFileResult> {
  const start = performance.now();
  const useShell = process.platform === 'win32';
  try {
    const { stdout, stderr } = await execFileAsync('pnpm', ['run', 'build'], {
      cwd: projectPath,
      timeout: 300_000,
      shell: useShell,
    });
    const output = [stdout, stderr].filter(Boolean).join('\n');
    return { file: 'build:pnpm run build', passed: true, duration: Math.round(performance.now() - start), output, error: null };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = [execErr.stdout ?? '', execErr.stderr ?? ''].filter(Boolean).join('\n');
    return {
      file: 'build:pnpm run build',
      passed: false,
      duration: Math.round(performance.now() - start),
      output,
      error: execErr.message ?? describeError(err),
    };
  }
}

/** Probe one URL via fetch and return a named check result. Never throws. */
async function pageLoadCheck(route: string, baseUrl: string): Promise<TestFileResult> {
  const url = `${baseUrl}${route}`;
  const start = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(SMOKE_FETCH_TIMEOUT_MS) });
    const passed = res.status < 500;
    return {
      file: `page:${route}`,
      passed,
      duration: Math.round(performance.now() - start),
      output: `HTTP ${res.status}`,
      error: passed ? null : `HTTP ${res.status} (server error)`,
    };
  } catch (err: unknown) {
    return {
      file: `page:${route}`,
      passed: false,
      duration: Math.round(performance.now() - start),
      output: '',
      error: describeError(err),
    };
  }
}

/** Assemble a {@link TestResult} from an array of file results. */
function buildResult(results: TestFileResult[], startMs: number, generatedAt: string): TestResult {
  const passedFiles = results.filter((r) => r.passed).length;
  const failedFiles = results.filter((r) => !r.passed).length;
  return {
    passed: failedFiles === 0,
    totalFiles: results.length,
    passedFiles,
    failedFiles,
    skippedFiles: 0,
    results,
    duration: Math.round(performance.now() - startMs),
    generatedAt,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover which test files cover `changedFiles` (by naming convention) and run ONLY those files.
 * Returns a {@link TestResult} with per-file pass/fail details. When no relevant test files exist,
 * returns a passing result with `skippedFiles = changedFiles.length` and an empty `results` array.
 */
export async function runIncrementalTests(
  changedFiles: string[],
  projectPath: string,
  testDir: string
): Promise<TestResult> {
  const startMs = performance.now();
  const generatedAt = nowIso();

  log(`scanning ${changedFiles.length} changed file(s) for relevant tests in ${testDir}`);
  const relevantFiles = findRelevantTestFiles(changedFiles, testDir);

  if (relevantFiles.length === 0) {
    log('no matching test files found — incremental run skipped');
    return {
      passed: true,
      totalFiles: 0,
      passedFiles: 0,
      failedFiles: 0,
      skippedFiles: changedFiles.length,
      results: [],
      duration: Math.round(performance.now() - startMs),
      generatedAt,
    };
  }

  log(`running ${relevantFiles.length} relevant test file(s)`);
  const results: TestFileResult[] = [];
  for (const file of relevantFiles) {
    const r = await runOneTestFile(file, projectPath);
    log(r.passed ? `  PASS  ${file}` : `  FAIL  ${file} — ${r.error ?? 'unknown error'}`);
    results.push(r);
  }

  const result = buildResult(results, startMs, generatedAt);
  log(
    result.passed
      ? `incremental tests: PASS (${result.passedFiles}/${result.totalFiles})`
      : `incremental tests: FAIL — ${result.failedFiles} file(s) failed`
  );
  return result;
}

/**
 * Returns `true` when the executor should run tests for the given `promptIndex`.
 *
 * Triggers when:
 *   - `promptIndex` is a positive multiple of `frequency` (default 10), OR
 *   - `phase` is an integration or deploy phase name (case-insensitive).
 */
export function shouldRunTests(promptIndex: number, frequency: number = 10, phase?: string): boolean {
  if (phase && ALWAYS_RUN_PHASES.includes(phase.toLowerCase())) return true;
  return promptIndex > 0 && promptIndex % frequency === 0;
}

/** Options for {@link runSmokeTests} — everything overridable/injectable (tests). */
export interface SmokeTestOptions {
  /** Running app base URL. Default `http://localhost:${SMOKE_DEV_PORT}`. */
  baseUrl?: string;
  /**
   * Whether to boot a dev server before probing pages. Default true. Set false when the app is
   * already running at `baseUrl` (mirrors accessibility-auditor.ts's/live-preview-gate.ts's
   * `startServer` option).
   */
  startServer?: boolean;
  /** Dev-server command. Default `pnpm`. */
  devCommand?: string;
  /** Dev-server args. Default `['dev', '--port', String(SMOKE_DEV_PORT)]`. */
  devArgs?: string[];
  /** How long to wait for the dev server to answer HTTP before giving up (ms). Default 90000. */
  startupTimeoutMs?: number;
  /** Readiness poll interval while waiting for the dev server (ms). Default 1000. */
  pollIntervalMs?: number;
  /** Override the dev-server starter (tests). Default `defaultStartDevServer` (live-preview-gate.ts). */
  startDevServer?: DevServerStarter;
}

/**
 * Minimal smoke suite: compile check + build check + three core page-load probes.
 *
 * Designed to be fast — pages are probed via a single `fetch` (not Playwright). Run every
 * {@link shouldRunTests} trigger between prompts per Blueprint 2B spec. Always resolves — never
 * throws, never fabricates a pass.
 *
 * Boots its own throwaway dev server (Finding E-3): previously the three page-load probes hit
 * `http://localhost:3000` with no server-start plumbing at all and no relationship to any dev-
 * server lifecycle — called every 10th prompt during Phase 3 (a phase with no dev server running
 * at that point; the sibling gates that DO manage a dev server, live-preview-gate.ts/
 * accessibility-auditor.ts, only run later in Phase 4), so all three probes failed with a
 * connection error on almost every real build, feeding false "smoke test failed" signals into the
 * learning database via `recordSmokeTestFailureObserved`. Now mirrors the same own-dev-server
 * pattern those Phase 4 gates already use, on a dedicated port so it never collides with an
 * operator's own `pnpm dev`.
 */
export async function runSmokeTests(projectPath: string, options: SmokeTestOptions = {}): Promise<TestResult> {
  const startMs = performance.now();
  const generatedAt = nowIso();
  const baseUrl = options.baseUrl ?? SMOKE_BASE_URL;
  const startServer = options.startServer ?? true;
  const devCommand = options.devCommand ?? 'pnpm';
  const devArgs = options.devArgs ?? ['dev', '--port', String(SMOKE_DEV_PORT)];
  const startupTimeoutMs = options.startupTimeoutMs ?? SMOKE_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? SMOKE_POLL_INTERVAL_MS;
  const startDevServerFn = options.startDevServer ?? defaultStartDevServer;

  log('starting smoke suite: compile + build + 3 core page loads');

  const results: TestFileResult[] = [];

  log('smoke: compile check');
  results.push(await compileCheck(projectPath));

  log('smoke: build check');
  results.push(await buildCheck(projectPath));

  let serverHandle: PreviewServerHandle | null = null;
  if (!startServer) {
    log(`smoke: assuming app already running at ${baseUrl} (startServer:false)`);
    for (const route of SMOKE_ROUTES) {
      log(`smoke: page load ${baseUrl}${route}`);
      results.push(await pageLoadCheck(route, baseUrl));
    }
  } else {
    log(`smoke: starting dev server on port ${SMOKE_DEV_PORT} for page-load probes`);
    const start = await startDevServerFn({ projectPath, command: devCommand, args: devArgs, baseUrl, startupTimeoutMs, pollIntervalMs, log });
    serverHandle = start.handle;
    if (!start.ready) {
      // House rule (never fabricate a pass): a probe that never got to run is reported as
      // failed, not silently marked green — but with a clearly distinguishing error message
      // ("dev server" vs. a real page-content problem) so it's diagnosable in the learning DB.
      log(`smoke: dev server never became ready (${start.detail}) — page-load probes reported failed`);
      for (const route of SMOKE_ROUTES) {
        results.push({ file: `page:${route}`, passed: false, duration: 0, output: '', error: `dev server never became ready: ${start.detail}` });
      }
    } else {
      for (const route of SMOKE_ROUTES) {
        log(`smoke: page load ${baseUrl}${route}`);
        results.push(await pageLoadCheck(route, baseUrl));
      }
    }
    if (serverHandle) await serverHandle.stop().catch(() => {});
  }

  const result = buildResult(results, startMs, generatedAt);
  log(
    result.passed
      ? `smoke tests: PASS (${result.passedFiles}/${result.totalFiles})`
      : `smoke tests: FAIL — ${result.failedFiles} check(s) failed`
  );
  return result;
}
