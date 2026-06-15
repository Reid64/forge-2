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

export type { TestResult, TestFileResult };

const execFileAsync = promisify(execFile);
const log = logLine('incremental-tester');

// Phase names that always trigger tests regardless of promptIndex.
const ALWAYS_RUN_PHASES: readonly string[] = ['integration', 'deploy', 'deployment', 'phase4', 'phase-4'];

// Core routes probed by runSmokeTests (relative paths joined onto SMOKE_BASE_URL).
const SMOKE_ROUTES: readonly string[] = ['/', '/login', '/dashboard'];
const SMOKE_BASE_URL = 'http://localhost:3000';
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
async function pageLoadCheck(route: string): Promise<TestFileResult> {
  const url = `${SMOKE_BASE_URL}${route}`;
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

/**
 * Minimal smoke suite: compile check + build check + three core page-load probes.
 * Designed to be fast — pages are probed via a single `fetch` (not Playwright). Run every
 * {@link shouldRunTests} trigger between prompts per Blueprint 2B spec. Always resolves — never
 * throws, never fabricates a pass.
 */
export async function runSmokeTests(projectPath: string): Promise<TestResult> {
  const startMs = performance.now();
  const generatedAt = nowIso();

  log('starting smoke suite: compile + build + 3 core page loads');

  const results: TestFileResult[] = [];

  log('smoke: compile check');
  results.push(await compileCheck(projectPath));

  log('smoke: build check');
  results.push(await buildCheck(projectPath));

  for (const route of SMOKE_ROUTES) {
    log(`smoke: page load ${SMOKE_BASE_URL}${route}`);
    results.push(await pageLoadCheck(route));
  }

  const result = buildResult(results, startMs, generatedAt);
  log(
    result.passed
      ? `smoke tests: PASS (${result.passedFiles}/${result.totalFiles})`
      : `smoke tests: FAIL — ${result.failedFiles} check(s) failed`
  );
  return result;
}
