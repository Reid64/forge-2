/**
 * FORGE 2.0 — Self-benchmark suite (`upgrades/ENGINEERING_COMPLETENESS.md` #32 "Benchmark suite
 * for FORGE itself" / #33 "Self-improvement evaluation harness").
 *
 * A FIXED set of 5 scenarios (`benchmarks/manifest.json`) every FORGE version can run against
 * small, DISPOSABLE fixture projects (`benchmarks/fixtures/<scenario-id>/`) — never forge-2
 * itself, never a real client project. Each run is scored on completion rate, defect rate, cost,
 * and latency, so a claim like "I improved myself" requires a comparable before/after number
 * rather than being taken on faith (per #33).
 *
 * WHY THIS RUNS WITHOUT LIVE API KEYS (no `claude` subprocess, no network)
 * ---------------------------------------------------------------------------------------------
 * `runPhase3Executor` (`src/phases/phase3-executor.ts`) is the SAME real Phase 3 build loop a
 * live `forge build` uses — nothing about it is reimplemented here. What's injected, mirroring
 * `tests/executor.test.ts`'s `baseOptions()` pattern exactly:
 *
 *   - `gitManager`: a real `GitManager` bound to a recording fake `execImpl` (`fakeGit()` below,
 *     copied from the test suite's helper of the same name) — every branch/merge/tag call the
 *     executor makes is exercised for real, nothing about git itself is faked away, but no actual
 *     repository is ever touched.
 *   - `predictImpl` / `assembleImpl` / `rewriteImpl`: deterministic stand-ins so the run needs no
 *     Build Memory pattern history to produce a stable prediction, and no governance-doc corpus
 *     to assemble a prompt from (`assembleImpl` still derives its prompt text from each queue
 *     entry's REAL `description`, so per-prompt cost estimation below reflects each fixture's
 *     actual scope, not a placeholder string).
 *   - `runClaudeImpl`: the ONE seam this benchmark genuinely cannot exercise without a live
 *     `claude` CLI + API key — the real Build Agent step. Stubbed to a deterministic success.
 *     LIMITATION: this means the benchmark measures FORGE's orchestration/scoring mechanics
 *     (scheduling, Sentinel gating, cost tracking, halt/recovery semantics) end-to-end for real,
 *     but NOT whether a live Claude Code invocation would actually produce a correct fix for a
 *     given fixture's defect. A future harness with live API access can swap `runClaudeImpl` back
 *     to the real `runClaude` (just omit the override) to get a true accuracy benchmark; this
 *     suite is the CI-friendly, zero-cost, deterministic half of that story.
 *   - `runSentinelImpl`: deterministic PASS for every prompt, EXCEPT the specific prompt ids each
 *     scenario's `manifest.json` lists under `simulatedFailures` (currently `broken-migration-fix`
 *     and `security-remediation`), which FAIL once with a realistic check name/detail. This gives
 *     the defect-rate metric a genuine non-zero case without requiring a real Sentinel run (real
 *     `tsc`/test-suite execution) against fixtures that were never meant to `npm install`.
 *   - `createBuild` / `updateBuild` / `createPromptExecution` / `updatePromptExecution`: in-memory
 *     fakes (`memFakes()` below) — no Build Memory / SQLite write.
 *
 * Cost is read from the SAME accumulator Contract-13's `maxBudgetUsd` cap reads
 * (`ModelCostTracker.totalCostUsd()`, `src/engine/model-router.ts`) — the tracker itself is
 * internal to `runPhase3Executor` and not returned on `Phase3Result`, so this module recovers the
 * final total the executor already computes by parsing its own
 * `"Model cost estimate: $X across N prompt(s)"` summary log line (emitted once per run, from
 * `costTracker.summary()`) via the injected `log` callback — the exact same figure, not a
 * reimplementation.
 *
 * FIXTURE ISOLATION: every scenario's fixture is copied to a fresh `os.tmpdir()` directory before
 * the executor ever touches it (`fs.cpSync`), mirroring
 * `tests/integration/scratch-promote-collision.test.ts`'s discipline — the checked-in fixture
 * under `benchmarks/fixtures/` is never mutated by a benchmark run.
 *
 * CLI USAGE
 *     node --import tsx benchmarks/benchmark-runner.ts [--out <path>] [--scenario <id>]
 *
 * `forge benchmark` (`src/cli/index.ts`) spawns exactly this command as a child process (rather
 * than statically importing it) because `tsconfig.json`'s `rootDir` is `src/` — a file physically
 * outside `src/` can never be part of the `tsc` build graph without breaking `pnpm run build`
 * (verified: TS6059). Spawning is also what actually keeps this suite "reuses the SAME
 * low-cost invocation style as `tests/executor.test.ts`" honest: the CLI process never needs a
 * `tsx`/`ts-node` loader at runtime, only this one child invocation does.
 */

import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPhase3Executor, type Phase3Options, type Phase3Result } from '../src/phases/phase3-executor.js';
import { GitManager, type ExecSyncFn } from '../src/engine/git-manager.js';
import type { ClaudeRunResult } from '../src/engine/claude-runner.js';
import type { SentinelResult } from '../src/phases/phase4-sentinel.js';

// ---------------------------------------------------------------------------
// Manifest shape (benchmarks/manifest.json)
// ---------------------------------------------------------------------------

export interface SimulatedFailure {
  /** The queue entry id (`QueueEntry.id`) this failure fires on, first time it executes. */
  promptId: string;
  /** Sentinel check name reported on the synthetic failure. */
  checkName: string;
  /** Human-readable detail attached to the synthetic failure. */
  detail: string;
}

export interface BenchmarkScenarioManifest {
  id: string;
  name: string;
  description: string;
  /** Fixture directory, relative to `benchmarks/`. */
  fixtureDir: string;
  /** queue.yaml filename within the fixture directory. */
  queueFile: string;
  simulatedFailures: SimulatedFailure[];
}

export interface BenchmarkManifest {
  version: number;
  description: string;
  scenarios: BenchmarkScenarioManifest[];
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface BenchmarkScenarioResult {
  scenarioId: string;
  name: string;
  status: Phase3Result['status'] | 'error';
  totalPrompts: number;
  completedPrompts: number;
  failedPrompts: number;
  skippedPrompts: number;
  /** completedPrompts / totalPrompts (0 when totalPrompts is 0). */
  completionRate: number;
  /** Count of prompts that hit a (real or scripted) Sentinel failure. */
  defectCount: number;
  /** defectCount / totalPrompts (0 when totalPrompts is 0). */
  defectRate: number;
  /** Read from the executor's own `ModelCostTracker` summary log line — see module doc. */
  costUsd: number;
  /** Wall-clock duration of this scenario's `runPhase3Executor` call. */
  latencyMs: number;
  warnings: string[];
  /** Set when the scenario could not even start (bad fixture / bad manifest entry). */
  error: string | null;
}

export interface BenchmarkSuiteResult {
  generatedAt: string;
  scenarios: BenchmarkScenarioResult[];
  totals: {
    scenarioCount: number;
    meanCompletionRate: number;
    meanDefectRate: number;
    totalCostUsd: number;
    totalLatencyMs: number;
  };
}

export interface BenchmarkOptions {
  /** Absolute path to manifest.json. Default: `benchmarks/manifest.json` beside this file. */
  manifestPath?: string;
  /** Restrict the run to these scenario ids (default: every scenario in the manifest). */
  scenarioIds?: string[];
  /** Progress reporter. Default: a no-op (the CLI wrapper supplies console output). */
  log?: (message: string) => void;
}

const BENCHMARKS_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Test-suite-style collaborator fakes (mirrors tests/executor.test.ts exactly — see module doc)
// ---------------------------------------------------------------------------

/** A real GitManager backed by a recording fake exec (no repo touched). Copied from executor.test.ts's fakeGit. */
function fakeGit(cwd: string): GitManager {
  let currentBranch = 'main';
  const execImpl: ExecSyncFn = (command: string) => {
    const checkoutB = /checkout -b (\S+)/.exec(command);
    if (checkoutB && checkoutB[1]) {
      currentBranch = checkoutB[1];
      return '';
    }
    if (command.includes('rev-parse')) return `${currentBranch}\n`;
    const checkout = /checkout (\S+)/.exec(command);
    if (checkout && checkout[1]) {
      currentBranch = checkout[1];
      return '';
    }
    return '';
  };
  return new GitManager({ cwd, execImpl });
}

/** In-memory Build Memory fakes (no SQLite write). Copied from executor.test.ts's memFakes. */
function memFakes() {
  let pid = 0;
  return {
    createBuild: async () => ({ id: 'bench-build' }),
    updateBuild: async (id: string) => ({ id }),
    createPromptExecution: async () => ({ id: `bench-pe-${++pid}` }),
    updatePromptExecution: async (id: string) => ({ id }),
  };
}

function claudeOk(): ClaudeRunResult {
  return {
    stdout: 'benchmark: Build Agent stubbed (no live API — see benchmark-runner.ts module doc)',
    stderr: '',
    exitCode: 0,
    durationMs: 1,
    tokensEstimated: 50,
    timedOut: false,
    signal: null,
    success: true,
  };
}

function passSentinel(): SentinelResult {
  return { passed: true, checks: [], failedCheck: null, diagnosticReport: 'PASS (benchmark stub)' };
}

function failSentinel(checkName: string, detail: string): SentinelResult {
  return {
    passed: false,
    checks: [{ name: checkName, passed: false, skipped: false, detail, output: detail, durationMs: 1 }],
    failedCheck: checkName,
    diagnosticReport: `FAIL: ${checkName} — ${detail}`,
  };
}

// ---------------------------------------------------------------------------
// One scenario
// ---------------------------------------------------------------------------

async function runScenario(
  scenario: BenchmarkScenarioManifest,
  log: (message: string) => void
): Promise<BenchmarkScenarioResult> {
  const fixtureSrc = join(BENCHMARKS_DIR, scenario.fixtureDir);
  let tmpRoot: string | null = null;

  const base: Omit<BenchmarkScenarioResult, 'status' | 'error'> = {
    scenarioId: scenario.id,
    name: scenario.name,
    totalPrompts: 0,
    completedPrompts: 0,
    failedPrompts: 0,
    skippedPrompts: 0,
    completionRate: 0,
    defectCount: 0,
    defectRate: 0,
    costUsd: 0,
    latencyMs: 0,
    warnings: [],
  };

  const startedAt = Date.now();
  try {
    // Fresh copy per run — the checked-in fixture under benchmarks/fixtures/ is never mutated
    // (same discipline as tests/integration/scratch-promote-collision.test.ts).
    tmpRoot = mkdtempSync(join(tmpdir(), `forge-benchmark-${scenario.id}-`));
    const projectPath = join(tmpRoot, 'project');
    cpSync(fixtureSrc, projectPath, { recursive: true });

    const simulated = new Map(scenario.simulatedFailures.map((f) => [f.promptId, f]));
    const firedOnce = new Set<string>();
    let currentEntryId: string | null = null;
    let capturedCostUsd = 0;
    let defectCount = 0;

    const scenarioLog = (message: string): void => {
      log(`[${scenario.id}] ${message}`);
      const costMatch = /Model cost estimate: \$([0-9.]+) across/.exec(message);
      if (costMatch && costMatch[1]) capturedCostUsd = Number.parseFloat(costMatch[1]);
    };

    const mem = memFakes();
    const options: Phase3Options = {
      projectPath,
      queuePath: join(projectPath, scenario.queueFile),
      governanceDirName: '.',
      projectName: scenario.id,
      allowHeadless: true,
      gitManager: fakeGit(projectPath),
      log: scenarioLog,
      // Non-empty stub content for the pre_build hook's built-in governance_check (Finding I-1 —
      // now actually fires, reading ctx.governanceDocs instead of the real filesystem): an empty
      // map would make every benchmark scenario halt immediately at pre_build.
      loadGovernanceDocs: async () => ({
        'BLUEPRINT.md': '# Blueprint\n',
        'SCHEMA_REGISTRY.md': '# Schema Registry\n',
        'BEHAVIORAL_CONTRACTS.md': '# Behavioral Contracts\n',
        'CLAUDE.md': '# Claude\n',
      }),
      updateStateProgress: async () => {},
      writeHaltReport: async () => {},
      createBuild: mem.createBuild,
      updateBuild: mem.updateBuild,
      createPromptExecution: mem.createPromptExecution,
      updatePromptExecution: mem.updatePromptExecution,
      predictImpl: async () => ({
        probability: 0,
        matchingPatterns: [],
        recommendation: '',
        shouldRewrite: false,
        matchingOccurrences: 0,
        totalBuildsWithStack: 0,
      }),
      assembleImpl: async ({ entry }) => {
        currentEntryId = entry.id;
        return {
          prompt: entry.description,
          hash: `bench-${entry.id}`,
          governanceDocsUsed: [],
          governanceDocsMissing: [],
          warningsInjected: 0,
          model: 'claude-sonnet-4-6' as const,
          modelSelection: {
            model: 'claude-sonnet-4-6' as const,
            tier: 'standard' as const,
            promptType: entry.prompt_type,
            isRecovery: false,
            reason: 'benchmark stub (see benchmark-runner.ts module doc)',
            pricing: { inputPerMTok: 3, outputPerMTok: 15 },
          },
          estimatedCostUsd: 0,
        };
      },
      rewriteImpl: async ({ prompt }) => ({
        rewrittenPrompt: prompt,
        reason: 'n/a (benchmark stub never triggers a rewrite)',
        originalHash: 'orig',
        rewrittenHash: 'rewritten',
      }),
      // The one seam this benchmark cannot exercise without live API keys — see module doc.
      runClaudeImpl: async () => claudeOk(),
      runSentinelImpl: async () => {
        const sim = currentEntryId ? simulated.get(currentEntryId) : undefined;
        if (sim && !firedOnce.has(sim.promptId)) {
          firedOnce.add(sim.promptId);
          defectCount += 1;
          return failSentinel(sim.checkName, sim.detail);
        }
        return passSentinel();
      },
    };

    const result = await runPhase3Executor(options);
    const latencyMs = Date.now() - startedAt;
    // Prefer the schedule's full order for the denominator (some halted prompts never get an
    // outcome pushed at all — see phase3-executor.ts's halt convention), falling back to
    // outcomes.length when the schedule is unavailable for any reason.
    const denominator = result.schedule?.order?.length || result.outcomes.length || 1;

    return {
      ...base,
      status: result.status,
      totalPrompts: denominator,
      completedPrompts: result.completedPrompts,
      failedPrompts: result.failedPrompts,
      skippedPrompts: result.skippedPrompts,
      completionRate: denominator > 0 ? result.completedPrompts / denominator : 0,
      defectCount,
      defectRate: denominator > 0 ? defectCount / denominator : 0,
      costUsd: capturedCostUsd,
      latencyMs,
      warnings: result.warnings,
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      status: 'error',
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (tmpRoot) {
      // Preserve each scenario's real internal log before wiping the disposable fixture copy
      // (Finding H-2): phase3-executor.ts writes a genuine, timestamped, tee'd log to
      // `<projectPath>/.forge/logs/build_<ts>.log` (fed by installQuietConsole + every log()
      // call), but it lives entirely inside `tmpRoot` and was previously deleted unconditionally
      // here regardless of pass/fail/error — the one command whose internals DO real file
      // logging still ended up with zero recoverable diagnostic trail at the CLI level.
      try {
        const scenarioLogsDir = join(tmpRoot, 'project', '.forge', 'logs');
        if (existsSync(scenarioLogsDir)) {
          const preservedDir = join(BENCHMARKS_DIR, '..', '.forge', 'benchmark-logs', `${scenario.id}-${startedAt}`);
          cpSync(scenarioLogsDir, preservedDir, { recursive: true });
        }
      } catch {
        /* best-effort — never let log preservation itself fail the benchmark */
      }
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run every scenario in `manifest.json` (or a filtered subset via `options.scenarioIds`)
 * sequentially, each against a fresh throwaway copy of its fixture. Never throws — a scenario
 * that fails to even start is reported with `status: 'error'` rather than aborting the suite.
 */
export async function runBenchmarkSuite(options: BenchmarkOptions = {}): Promise<BenchmarkSuiteResult> {
  const log = options.log ?? (() => {});
  const manifestPath = options.manifestPath ?? join(BENCHMARKS_DIR, 'manifest.json');
  const manifest: BenchmarkManifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  const wanted = options.scenarioIds && options.scenarioIds.length > 0 ? new Set(options.scenarioIds) : null;
  const scenarios = wanted ? manifest.scenarios.filter((s) => wanted.has(s.id)) : manifest.scenarios;

  const results: BenchmarkScenarioResult[] = [];
  for (const scenario of scenarios) {
    log(`--- scenario '${scenario.id}' (${scenario.name}) ---`);
    const result = await runScenario(scenario, log);
    results.push(result);
    log(
      `--- scenario '${scenario.id}': ${result.status} — ` +
        `${result.completedPrompts}/${result.totalPrompts} completed, ` +
        `${result.defectCount} defect(s), $${result.costUsd.toFixed(4)}, ${result.latencyMs}ms ---`
    );
  }

  const n = results.length || 1;
  const totals = {
    scenarioCount: results.length,
    meanCompletionRate: results.reduce((s, r) => s + r.completionRate, 0) / n,
    meanDefectRate: results.reduce((s, r) => s + r.defectRate, 0) / n,
    totalCostUsd: Math.round(results.reduce((s, r) => s + r.costUsd, 0) * 1_000_000) / 1_000_000,
    totalLatencyMs: results.reduce((s, r) => s + r.latencyMs, 0),
  };

  return { generatedAt: new Date().toISOString(), scenarios: results, totals };
}

// ---------------------------------------------------------------------------
// CLI entry point — `node --import tsx benchmarks/benchmark-runner.ts [--out <path>] [--scenario <id>]`
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): { out: string | null; scenarioIds: string[] } {
  let out: string | null = null;
  const scenarioIds: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out = argv[i + 1]!;
      i += 1;
    } else if (argv[i] === '--scenario' && argv[i + 1]) {
      scenarioIds.push(argv[i + 1]!);
      i += 1;
    }
  }
  return { out, scenarioIds };
}

async function mainCli(): Promise<void> {
  const { out, scenarioIds } = parseArgs(process.argv.slice(2));
  const suite = await runBenchmarkSuite({
    ...(scenarioIds.length > 0 ? { scenarioIds } : {}),
    log: (m) => console.log(m),
  });

  console.log('\n=== FORGE Benchmark Suite ===');
  for (const s of suite.scenarios) {
    console.log(
      `  ${s.scenarioId.padEnd(24)} ${s.status.padEnd(10)} ` +
        `completion=${(s.completionRate * 100).toFixed(0).padStart(3)}%  ` +
        `defects=${s.defectCount}  cost=$${s.costUsd.toFixed(4)}  latency=${s.latencyMs}ms`
    );
  }
  console.log(
    `\n  ${suite.totals.scenarioCount} scenario(s) — mean completion ` +
      `${(suite.totals.meanCompletionRate * 100).toFixed(0)}%, mean defect rate ` +
      `${(suite.totals.meanDefectRate * 100).toFixed(0)}%, total cost $${suite.totals.totalCostUsd.toFixed(4)}, ` +
      `total latency ${suite.totals.totalLatencyMs}ms\n`
  );

  if (out) {
    writeFileSync(out, JSON.stringify(suite, null, 2), 'utf8');
    console.log(`Wrote ${out}`);
  }
}

// Only run the CLI entry point when this file is executed directly (not when imported).
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  mainCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
