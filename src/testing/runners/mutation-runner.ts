// FORGE 2.0 — Enterprise Test Suite: MUTATION runner (JS/TS mutation testing via Stryker Mutator,
// `npx stryker run --reporters json`).
//
// Gated to MILESTONE (ENTERPRISE_READY) and ENTERPRISE_RELEASE (MISSION_CRITICAL/HYPERSCALE)
// readiness tiers ONLY (`src/governance/readiness-levels.ts`) — mutation testing re-runs the whole
// suite once per surviving mutant candidate, so it is by far the most expensive runner in this
// directory and must never fire on every prompt, nor even at every milestone below the top tier(s).
//
// Applicability / "tool absent" detection follows vitest-shared.ts's pre-check style
// (`node_modules/.bin` existence, no network-triggering `npx` auto-install) rather than
// iac-runner's/python-property-runner's "attempt the run, regex the error" style: Stryker's own
// testRunner is 'vitest' (see below), and the target project's Vitest install is ALREADY
// pre-checked the same way by every other runner in this directory, so re-using that exact
// technique for Stryker itself and its vitest-runner plugin keeps one consistent "is this even
// installed" story across the whole runner set. A regex-based "not installed" fallback on the
// process output is kept too (iac-runner/python-property-runner's backstop pattern) in case the
// pre-check misses an edge case (e.g. a corrupted node_modules).
//
// Config-file generation: if the target project has no Stryker config under any of the 8
// filenames StrykerJS actually resolves (stryker.conf.{json,js,cjs,mjs} — legacy — and
// stryker.config.{json,js,cjs,mjs}, added in StrykerJS 7.1), this runner writes a minimal
// `stryker.config.mjs` before invoking Stryker. Two assumptions this generated config makes,
// documented here because they are guesses, not certainties, about an arbitrary target project:
//   1. `testRunner: 'vitest'` — every other runner in this directory (UNIT/INTEGRATION/API via
//      vitest-shared.ts, FASTCHECK) already assumes the target project's test framework is
//      Vitest, since that's what FORGE scaffolds. `@stryker-mutator/vitest-runner` is Stryker's
//      own first-party plugin for it — simpler and more reliable than Stryker's generic
//      command-runner plugin (which would have to shell out to the project's own `test` script
//      per mutant with no structured per-test coverage feedback). If the target project does not
//      actually use Vitest, this assumption surfaces as a SKIP (missing vitest / vitest-runner
//      plugin), never a fabricated pass.
//   2. `mutate: ['src/**/*.{js,jsx,ts,tsx}', ...]` — "the project's own src files" per the task
//      brief, excluding test files and `.d.ts`. A project that keeps source outside `src/` simply
//      mutates nothing (Stryker reports zero mutants), which this runner treats as a SKIP (see
//      "zero valid mutants" below) rather than a failure.
//   3. `thresholds.break: null` — Stryker's own break-the-build behavior is disabled so its exit
//      code never dictates this runner's `status`; like every other runner here (vitest-shared,
//      checkov, pytest), status is derived purely from parsing the JSON report, not the process
//      exit code.
//
// Pass/fail threshold: MUTATION_SCORE_THRESHOLD below. This codebase's one other "raw score"
// runner — Lighthouse (`phase4-sentinel.ts`'s `LIGHTHOUSE_THRESHOLD = 90`) — hard-gates on a fixed
// in-code threshold rather than treating the score as informational-only, so mutation testing
// follows that same precedent instead of introducing a second style. 60% is a commonly-cited
// "reasonable mutation score" baseline (well below Lighthouse's 90 — a much stricter bar makes
// sense for an automated performance/accessibility audit than for a suite-quality signal that is
// brand new to a codebase); it is intentionally lower than Stryker's own community-cited
// high/low pair in the generated config (`thresholds: { high: 80, low: 60 }`) so this runner's
// gate and the generated config's own advisory bands agree at the "low" end.
//
// Mutation-score formula (Stryker docs, mutation-testing-elements' "Mutant states and metrics"):
// detected = Killed + Timeout; undetected = Survived + NoCoverage; score = detected / (detected +
// undetected) * 100. Ignored/CompileError/RuntimeError/Pending mutants are excluded from both the
// numerator and denominator — they were never validly tested either way (T1: never let an
// inconclusive mutant count as evidence of a killed OR a surviving one).

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { defaultShellRunner } from './exec.js';
import { vitestInstalled } from './vitest-shared.js';
import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

const DEFAULT_STRYKER_TIMEOUT_MS = 15 * 60 * 1000; // mutation testing is far slower than a normal suite run
const REPORT_FILE = 'reports/mutation/mutation.json'; // Stryker's own JSON-reporter default path
const GENERATED_CONFIG_FILE = 'stryker.config.mjs';
const MAX_FAILURES = 20;

/** Mutation score threshold below which this runner reports `status: 'failed'` — see the module
 *  doc comment above for why a hard in-code threshold (Lighthouse's style) was chosen over an
 *  informational-only score. */
const MUTATION_SCORE_THRESHOLD = 60;

/** Every config filename StrykerJS actually resolves: the legacy `stryker.conf.*` family plus the
 *  `stryker.config.*` family added in StrykerJS 7.1 (stryker-mutator.io/docs/stryker-js/config-file). */
const CONFIG_FILENAMES = [
  'stryker.conf.json',
  'stryker.conf.js',
  'stryker.conf.cjs',
  'stryker.conf.mjs',
  'stryker.config.json',
  'stryker.config.js',
  'stryker.config.cjs',
  'stryker.config.mjs',
];

const MINIMAL_STRYKER_CONFIG = `/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
// Minimal config generated by FORGE 2.0's mutation-runner.ts (no stryker.conf.*/stryker.config.*
// was found in this project). See src/testing/runners/mutation-runner.ts for the assumptions this
// makes (Vitest as the test runner, 'src/**' as the mutation target).
export default {
  mutate: ['src/**/*.{js,jsx,ts,tsx}', '!src/**/*.{test,spec}.*', '!src/**/*.d.ts'],
  testRunner: 'vitest',
  reporters: ['json', 'clear-text', 'progress'],
  jsonReporter: { fileName: '${REPORT_FILE}' },
  coverageAnalysis: 'perTest',
  thresholds: { high: 80, low: 60, break: null },
  tempDirName: '.stryker-tmp',
};
`;

async function hasStrykerConfig(projectPath: string): Promise<boolean> {
  return CONFIG_FILENAMES.some((name) => existsSync(join(projectPath, name)));
}

/** `node_modules/.bin/stryker[.cmd]` (mirrors `vitestInstalled`'s exact detection style) — used so
 *  this runner never triggers a network-fetching `npx` auto-install of an absent tool (T1: an
 *  absent tool is a SKIP, never a side-effecting attempt to fabricate one). */
function strykerInstalled(projectPath: string): boolean {
  const bin = join(projectPath, 'node_modules', '.bin', process.platform === 'win32' ? 'stryker.cmd' : 'stryker');
  return existsSync(bin) || existsSync(join(projectPath, 'node_modules', '@stryker-mutator', 'core'));
}

/** `@stryker-mutator/vitest-runner` — the plugin the generated config's `testRunner: 'vitest'`
 *  requires. Checked separately from `strykerInstalled` because a project can have Stryker's core
 *  installed without this plugin. */
function vitestRunnerPluginInstalled(projectPath: string): boolean {
  return existsSync(join(projectPath, 'node_modules', '@stryker-mutator', 'vitest-runner'));
}

interface StrykerMutant {
  status?: string;
  mutatorName?: string;
  location?: { start?: { line?: number; column?: number } };
}

interface StrykerFileEntry {
  mutants?: StrykerMutant[];
}

interface StrykerReport {
  files?: Record<string, StrykerFileEntry>;
}

interface MutationTotals {
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  ignored: number;
  compileError: number;
  runtimeError: number;
  pending: number;
}

function emptyTotals(): MutationTotals {
  return { killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0, compileError: 0, runtimeError: 0, pending: 0 };
}

/** Pure: Stryker's `--reporters json` output (mutation-testing-report-schema) -> normalized
 *  per-status totals + the surviving/uncovered mutants as `RunnerFailure`s. Never throws. */
export function parseStrykerJson(raw: string): { totals: MutationTotals; failures: RunnerFailure[] } | null {
  try {
    const data = JSON.parse(raw) as StrykerReport;
    if (!data.files || typeof data.files !== 'object') return null;

    const totals = emptyTotals();
    const failures: RunnerFailure[] = [];

    for (const [file, entry] of Object.entries(data.files)) {
      for (const mutant of entry.mutants ?? []) {
        const status = (mutant.status ?? '').toLowerCase();
        switch (status) {
          case 'killed':
            totals.killed++;
            break;
          case 'timeout':
            totals.timeout++;
            break;
          case 'survived':
            totals.survived++;
            if (failures.length < MAX_FAILURES) {
              const line = mutant.location?.start?.line;
              failures.push({
                name: mutant.mutatorName ?? 'unknown mutator',
                message: `Survived: ${mutant.mutatorName ?? 'mutation'}${line ? ` at line ${line}` : ''}`,
                file,
              });
            }
            break;
          case 'nocoverage':
            totals.noCoverage++;
            if (failures.length < MAX_FAILURES) {
              const line = mutant.location?.start?.line;
              failures.push({
                name: mutant.mutatorName ?? 'unknown mutator',
                message: `No test coverage: ${mutant.mutatorName ?? 'mutation'}${line ? ` at line ${line}` : ''}`,
                file,
              });
            }
            break;
          case 'ignored':
            totals.ignored++;
            break;
          case 'compileerror':
            totals.compileError++;
            break;
          case 'runtimeerror':
            totals.runtimeError++;
            break;
          case 'pending':
          default:
            totals.pending++;
            break;
        }
      }
    }

    return { totals, failures };
  } catch {
    return null;
  }
}

/** detected / (detected + undetected) * 100, per mutation-testing-elements' "Mutant states and
 *  metrics" doc — Ignored/CompileError/RuntimeError/Pending excluded from both terms. Returns
 *  `null` when there are zero validly-evaluated mutants (nothing to score). */
export function computeMutationScore(totals: MutationTotals): number | null {
  const detected = totals.killed + totals.timeout;
  const undetected = totals.survived + totals.noCoverage;
  const valid = detected + undetected;
  if (valid === 0) return null;
  return (detected / valid) * 100;
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();

  if (!strykerInstalled(input.projectPath)) {
    return skippedOutcome('stryker', '@stryker-mutator/core not installed in target project — SKIP (T1, never faked)');
  }
  if (!vitestInstalled(input.projectPath)) {
    return skippedOutcome('stryker', 'vitest not installed in target project — SKIP (mutation-runner assumes Vitest, see module doc comment)');
  }
  if (!vitestRunnerPluginInstalled(input.projectPath)) {
    return skippedOutcome('stryker', '@stryker-mutator/vitest-runner not installed in target project — SKIP');
  }

  if (!(await hasStrykerConfig(input.projectPath))) {
    input.log(`stryker: no config found — generating minimal ${GENERATED_CONFIG_FILE}`);
    try {
      await writeFile(join(input.projectPath, GENERATED_CONFIG_FILE), MINIMAL_STRYKER_CONFIG, 'utf8');
    } catch (error) {
      return errorOutcome(
        'stryker',
        `failed to generate ${GENERATED_CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`,
        Date.now() - started
      );
    }
  }

  const command = 'npx stryker run --reporters json';
  input.log(`stryker: ${command}`);
  const result = await defaultShellRunner(command, input.projectPath, input.timeoutMs ?? DEFAULT_STRYKER_TIMEOUT_MS);
  const durationMs = Date.now() - started;

  const combined = [result.stdout, result.stderr].filter((s) => s.trim() !== '').join('\n');
  const notInstalled = /command not found|is not recognized|no such file|ENOENT|cannot find module/i.test(combined);
  if (notInstalled) {
    return skippedOutcome('stryker', 'stryker or a required plugin could not be resolved — SKIP (T1, never faked)');
  }

  let raw: string | null = null;
  try {
    raw = await readFile(join(input.projectPath, REPORT_FILE), 'utf8');
  } catch {
    raw = null;
  }
  if (raw === null) {
    return errorOutcome(
      'stryker',
      result.timedOut ? 'stryker run timed out' : `stryker produced no JSON report (${combined.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? 'no output'})`,
      durationMs,
      result.exitCode
    );
  }

  const parsed = parseStrykerJson(raw);
  if (parsed === null) {
    return errorOutcome('stryker', 'stryker JSON report was unparsable', durationMs, result.exitCode);
  }

  const { totals, failures } = parsed;
  const score = computeMutationScore(totals);
  const detected = totals.killed + totals.timeout;
  const undetected = totals.survived + totals.noCoverage;
  const skippedMutants = totals.ignored + totals.compileError + totals.runtimeError + totals.pending;

  if (score === null) {
    return skippedOutcome(
      'stryker',
      'stryker produced zero validly-evaluated mutants (no Killed/Timeout/Survived/NoCoverage) — SKIP'
    );
  }

  const status: RunnerOutcome['status'] = score >= MUTATION_SCORE_THRESHOLD ? 'passed' : 'failed';
  const detail =
    `${score.toFixed(1)}% mutation score (${totals.killed} killed, ${totals.timeout} timeout, ` +
    `${totals.survived} survived, ${totals.noCoverage} no coverage) — threshold ${MUTATION_SCORE_THRESHOLD}%`;

  return {
    runner: 'stryker',
    status,
    testsTotal: detected + undetected,
    testsPassed: detected,
    testsFailed: undetected,
    testsSkipped: skippedMutants,
    durationMs,
    failures,
    reportPath: REPORT_FILE,
    exitCode: result.exitCode,
    detail,
    coverage: null,
  };
}
