/**
 * FORGE 2.0 — Native Orchestrator — QueueRunner.
 *
 * Owns the single act of running ONE queue entry end-to-end: sync governance (DIRECTIVE-016),
 * stage the queue file as the active `queue.yaml` in the FORGE projects folder (mirroring the
 * FORGE 1.0 PowerShell orchestrator's `library/[project]/*.yaml` → `projects/[project]/queue.yaml`
 * copy step), spawn `forge build --use-existing-queue` as a real subprocess (never in-process —
 * the orchestrator and Phase 3 must be able to crash independently), stream every line of output
 * back to the operator in real time with an `[ORCHESTRATOR]` prefix so a long build is never a
 * silent 15-minute pause, and finally read back the System 5 (Sentinel Prime) checkpoint for the
 * build that just ran so the caller (the manifest loop) can make an honest continue/halt decision.
 *
 * This module makes NO decisions about dependency ordering or manifest persistence — that is
 * {@link ManifestResolver}'s job. QueueRunner is purely "run this one queue, tell me what happened."
 *
 * NEVER THROWS (Iron Law 3 — report the real outcome, never fabricate a pass): every failure mode
 * (missing queue file, copy failure, spawn failure, non-zero exit, an unreachable Build Memory) is
 * captured and returned as `{ success: false, error }` rather than rejecting. The one exception a
 * caller must still respect is that `sentinelResult` may legitimately be `null` — Sentinel Prime
 * persistence is Contract 4 (Build Memory writes are never a halting error), so its ABSENCE is not
 * itself a failure signal; only a REAL halt decision read back from a present checkpoint is.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromJsonText, getClient, logMemoryWarning } from '../memory/client.js';
import { decideHalt, scoreConfidence } from '../sentinel-prime/confidence-scorer.js';
import type {
  ExecutionMonitorResult,
  GovernanceEnforcerResult,
  SentinelPrimeRunResult,
  ValidationResult,
} from '../sentinel-prime/types.js';
import { syncBeforeQueueRun } from './governance-sync.js';
import type { OrchestratorOptions, QueueEntry } from './types.js';

/** The QueueRunner's own resolved outcome for one queue run. */
export interface QueueRunResult {
  success: boolean;
  error: string | null;
  sentinelResult: SentinelPrimeRunResult | null;
}

/**
 * Neutral fallback signals used ONLY when a persisted Sentinel Prime checkpoint cannot be
 * deserialized (corrupt/partial JSON in a `sentinel_prime_runs` row — extremely rare). Defaulting
 * to "passed clean" means a storage-format hiccup degrades to "no opinion" rather than fabricating
 * a halt FORGE never actually decided (Contract 4 — Build Memory trouble must never itself become
 * a build-blocking failure).
 */
const FALLBACK_EXECUTION_RESULT: ExecutionMonitorResult = {
  promptId: '',
  outOfScopeWrites: [],
  unexpectedDeletions: [],
  commandsExecuted: [],
  stdoutChunks: 0,
  exitCode: null,
  durationMs: 0,
  passed: true,
  violations: [],
};

const FALLBACK_VALIDATION_RESULT: ValidationResult = {
  promptId: '',
  intentFulfillmentScore: 1,
  gatePassed: true,
  intentActuallyFulfilled: true,
  promptSummary: '',
  outputSummary: '',
  gaps: [],
  confidence: 1,
};

const FALLBACK_GOVERNANCE_RESULT: GovernanceEnforcerResult = {
  promptId: '',
  artifactsScanned: [],
  driftReports: [],
  contractViolations: [],
  passed: true,
};

/** Row shape read back from `sentinel_prime_runs` (see `src/learning/database.ts`). */
interface SentinelPrimeRunRow {
  id: string;
  build_run_id: string;
  prompt_id: string;
  prompt_index: number;
  execution_monitor_result: string;
  decision_validator_result: string;
  governance_enforcer_result: string;
  created_at: string;
}

function twoDigit(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `[yyyy-MM-dd HH:mm:ss] [LEVEL] message`, matching Phase 3's `renderProgress` format exactly
 * (same shape as {@link import('./governance-sync.js')}'s local renderer) — the whole point of the
 * TS-native orchestrator is that its console output is indistinguishable from FORGE 1.0's, so an
 * operator watching the log cannot tell the PowerShell layer was replaced.
 */
function renderProgress(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  const now = new Date();
  const ts = `${now.getFullYear()}-${twoDigit(now.getMonth() + 1)}-${twoDigit(now.getDate())} ${twoDigit(now.getHours())}:${twoDigit(now.getMinutes())}:${twoDigit(now.getSeconds())}`;
  process.stdout.write(`[${ts}] [${level}] ${message}\n`);
}

/** Extract a human-readable message from any thrown value. */
function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class QueueRunner {
  /**
   * Run one queue entry to completion. See the module doc for the full step sequence. Returns a
   * fully-resolved {@link QueueRunResult} — this method never rejects.
   */
  async run(queueEntry: QueueEntry, options: OrchestratorOptions): Promise<QueueRunResult> {
    const prefix = `[ORCHESTRATOR] [${queueEntry.id}]`;

    try {
      // 1) DIRECTIVE-016 — governance docs must be current in the FORGE projects folder before
      //    ANY queue executes, or claude builds without context.
      const syncResult = syncBeforeQueueRun(options);
      if (syncResult.errors.length > 0) {
        renderProgress(
          'WARN',
          `${prefix} governance sync reported ${syncResult.errors.length} error(s): ${syncResult.errors.join('; ')}`
        );
      }

      // 2) Resolve the queue file's real location in the library.
      const sourcePath = this.resolveQueueFilePath(queueEntry, options);
      if (!existsSync(sourcePath)) {
        const error = `queue file not found: "${sourcePath}" (library="${options.libraryPath}", project="${options.project}", file="${queueEntry.file}")`;
        renderProgress('ERROR', `${prefix} ${error}`);
        return { success: false, error, sentinelResult: null };
      }

      // 3) Stage it as the active queue.yaml the FORGE projects folder — the exact FORGE 1.0
      //    pattern (library/[project]/queue-*.yaml → projects/[project]/queue.yaml).
      const staged = this.copyQueueFileToProject(sourcePath, options);
      if (!staged.ok) {
        renderProgress('ERROR', `${prefix} ${staged.error}`);
        return { success: false, error: staged.error ?? 'failed to stage queue.yaml', sentinelResult: null };
      }
      renderProgress('INFO', `${prefix} staged "${sourcePath}" -> "${staged.destPath}"`);

      // 4) + 5) Spawn `forge build --use-existing-queue`, streaming output as it happens, then
      //    classify the exit.
      const runResult = await this.spawnForgeBuild(options, prefix);
      if (runResult.spawnError) {
        const error = `failed to spawn forge build: ${runResult.spawnError}`;
        renderProgress('ERROR', `${prefix} ${error}`);
        return { success: false, error, sentinelResult: null };
      }

      let success = runResult.exitCode === 0;
      let error: string | null = success
        ? null
        : `forge build exited with code ${runResult.exitCode ?? 'null'}` +
          `${runResult.signal ? ` (signal ${runResult.signal})` : ''}` +
          `${runResult.stderrTail ? ` — ${runResult.stderrTail}` : ''}`;

      // 6) Read back the Sentinel Prime checkpoint for whatever build_run this subprocess just
      //    created (QueueRunner has no in-process handle on that id — it was assigned inside the
      //    subprocess — so it is looked up by project_path, most-recent-first).
      const sentinelResult = this.loadLatestSentinelResult(options);

      // 7) A real, non-auto-recoverable Sentinel Prime halt overrides everything — even a clean
      //    process exit is not "success" if Sentinel Prime decided the build should not continue.
      if (sentinelResult && sentinelResult.haltDecision.shouldHalt && !sentinelResult.haltDecision.autoRecoverable) {
        success = false;
        error = `Sentinel Prime halt: ${sentinelResult.haltDecision.reason ?? 'unspecified halt reason'}`;
        renderProgress('ERROR', `${prefix} Sentinel Prime halted the build (not auto-recoverable) — ${error}`);
      }

      renderProgress(success ? 'INFO' : 'ERROR', `${prefix} ${success ? 'COMPLETE' : 'FAILED'}`);
      return { success, error, sentinelResult };
    } catch (error) {
      const message = errMsg(error);
      renderProgress('ERROR', `${prefix} unexpected QueueRunner failure — ${message}`);
      return { success: false, error: message, sentinelResult: null };
    }
  }

  /**
   * `options.libraryPath/options.project/queueEntry.file` — the FORGE 1.0 library layout
   * (`library/[project]/queue-*.yaml`). A `queueEntry.file` that is already an absolute path is
   * used as-is (defensive — a hand-edited manifest may legitimately point outside the library).
   */
  private resolveQueueFilePath(queueEntry: QueueEntry, options: OrchestratorOptions): string {
    if (isAbsolute(queueEntry.file)) return queueEntry.file;
    return join(options.libraryPath, options.project, queueEntry.file);
  }

  /**
   * Copy the resolved library queue file to `<projectPath>/queue.yaml` — the exact filename Phase
   * 3's `--use-existing-queue` reads (`src/cli/index.ts`). Creates the FORGE projects folder if it
   * does not exist yet (a brand-new project's first queue run).
   */
  private copyQueueFileToProject(
    sourcePath: string,
    options: OrchestratorOptions
  ): { ok: boolean; destPath: string; error?: string } {
    const destPath = join(options.projectPath, 'queue.yaml');
    try {
      if (!existsSync(options.projectPath)) {
        mkdirSync(options.projectPath, { recursive: true });
      }
      copyFileSync(sourcePath, destPath);
      return { ok: true, destPath };
    } catch (error) {
      return {
        ok: false,
        destPath,
        error: `failed to copy "${sourcePath}" -> "${destPath}" — ${errMsg(error)}`,
      };
    }
  }

  /**
   * Resolve `dist/cli/index.js` relative to THIS compiled module (`dist/orchestrator/queue-runner.js`),
   * not `process.cwd()` — the orchestrator must be able to spawn `forge build` correctly regardless
   * of the directory it was itself launched from.
   */
  private resolveCliEntryPoint(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', 'cli', 'index.js');
  }

  /**
   * Spawn `node <dist/cli/index.js> build <projectPath> --use-existing-queue` (Contract 5 governs
   * `claude` itself; this is FORGE's OWN CLI, so no shell shim resolution is needed — Node invokes
   * a `.js` file directly on every platform) and stream stdout/stderr back to the operator in real
   * time, each line prefixed `[ORCHESTRATOR] [<queue-id>]` (point 8 of this module's contract) so
   * orchestrator output is visually distinguishable from Phase 3's own `renderProgress` lines while
   * both share the same timestamp/level format. Never throws — a synchronous or asynchronous spawn
   * failure resolves with `spawnError` set rather than rejecting.
   */
  private spawnForgeBuild(
    options: OrchestratorOptions,
    prefix: string
  ): Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderrTail: string;
    spawnError: string | null;
  }> {
    const cliPath = this.resolveCliEntryPoint();
    const forgeRoot = join(dirname(cliPath), '..', '..');
    const args = [cliPath, 'build', options.projectPath, '--use-existing-queue'];
    if (options.dryRun) args.push('--dry-run');
    // Forward the manifest's optional budget cap (OrchestratorEngine merges it onto `options`
    // from `LibraryManifest.maxBudgetUsd` before delegating here) — absent when the manifest
    // declares none, so this queue run is spawned with no cap, exactly as before.
    if (typeof options.maxBudgetUsd === 'number' && Number.isFinite(options.maxBudgetUsd)) {
      args.push('--max-budget-usd', String(options.maxBudgetUsd));
    }
    // Forward the manifest's optional ephemeral-preview opt-in (OrchestratorEngine merges it onto
    // `options` from `LibraryManifest.previewEnvironments` before delegating here) — absent/false
    // means this queue run is spawned with no preview step, exactly as before.
    if (options.previewEnvironments === true) {
      args.push('--preview-environments');
    }

    renderProgress(
      'INFO',
      `${prefix} spawning: forge build "${options.projectPath}" --use-existing-queue${options.dryRun ? ' --dry-run' : ''}`
    );

    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.execPath, args, {
          cwd: forgeRoot,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({ exitCode: null, signal: null, stderrTail: '', spawnError: errMsg(error) });
        return;
      }

      let stdoutBuffer = '';
      let stderrBuffer = '';
      const stderrTailLines: string[] = [];
      const MAX_TAIL_LINES = 20;

      /** Split a growing buffer into complete lines, stream each, and return the remainder. */
      const flushLines = (buffer: string, isStderr: boolean): string => {
        const parts = buffer.split(/\r?\n/);
        const remainder = parts.pop() ?? '';
        for (const line of parts) {
          if (line === '') continue;
          renderProgress(isStderr ? 'WARN' : 'INFO', `${prefix} ${line}`);
          if (isStderr) {
            stderrTailLines.push(line);
            if (stderrTailLines.length > MAX_TAIL_LINES) stderrTailLines.shift();
          }
        }
        return remainder;
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuffer = flushLines(stdoutBuffer + chunk.toString('utf8'), false);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuffer = flushLines(stderrBuffer + chunk.toString('utf8'), true);
      });

      child.on('error', (error: Error) => {
        resolve({
          exitCode: null,
          signal: null,
          stderrTail: stderrTailLines.join('\n'),
          spawnError: error.message,
        });
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        // Flush whatever partial line never terminated in a trailing newline.
        if (stdoutBuffer !== '') renderProgress('INFO', `${prefix} ${stdoutBuffer}`);
        if (stderrBuffer !== '') {
          renderProgress('WARN', `${prefix} ${stderrBuffer}`);
          stderrTailLines.push(stderrBuffer);
        }
        resolve({ exitCode: code, signal, stderrTail: stderrTailLines.join('\n'), spawnError: null });
      });
    });
  }

  /**
   * Read back the most recent `sentinel_prime_runs` row for the build the subprocess just ran
   * (found via the most recent `build_runs` row whose `project_path` matches — QueueRunner has no
   * other handle on the subprocess's build id, since Phase 3 assigns it internally) and reconstruct
   * a full {@link SentinelPrimeRunResult}. `confidenceScore`/`haltDecision` are RECOMPUTED via the
   * same pure `scoreConfidence`/`decideHalt` functions Sentinel Prime itself used to persist the
   * row in the first place (`src/sentinel-prime/confidence-scorer.ts`) rather than re-parsed from
   * derived columns, so the reconstruction is exact given the same underlying signals and never
   * drifts from the scoring module's own logic. Never throws (Contract 4) — any read/parse failure,
   * or Build Memory being unreachable, returns `null` and logs a non-fatal warning.
   */
  private loadLatestSentinelResult(options: OrchestratorOptions): SentinelPrimeRunResult | null {
    const db = getClient();
    if (!db) return null;

    try {
      const buildRow = db
        .prepare('SELECT id FROM build_runs WHERE project_path = ? ORDER BY created_at DESC LIMIT 1')
        .get(options.projectPath) as { id: string } | undefined;
      if (!buildRow) return null;

      const runRow = db
        .prepare(
          `SELECT id, build_run_id, prompt_id, prompt_index, execution_monitor_result,
                  decision_validator_result, governance_enforcer_result, created_at
           FROM sentinel_prime_runs
           WHERE build_run_id = ?
           ORDER BY created_at DESC
           LIMIT 1`
        )
        .get(buildRow.id) as SentinelPrimeRunRow | undefined;
      if (!runRow) return null;

      const executionResult = fromJsonText<ExecutionMonitorResult>(
        runRow.execution_monitor_result,
        FALLBACK_EXECUTION_RESULT
      );
      const validationResult = fromJsonText<ValidationResult>(
        runRow.decision_validator_result,
        FALLBACK_VALIDATION_RESULT
      );
      const governanceResult = fromJsonText<GovernanceEnforcerResult>(
        runRow.governance_enforcer_result,
        FALLBACK_GOVERNANCE_RESULT
      );

      const confidenceScore = scoreConfidence(executionResult, validationResult, governanceResult);
      const haltDecision = decideHalt(confidenceScore, executionResult, governanceResult);

      return {
        id: runRow.id,
        buildRunId: runRow.build_run_id,
        promptId: runRow.prompt_id,
        promptIndex: runRow.prompt_index,
        executionResult,
        validationResult,
        governanceResult,
        confidenceScore,
        haltDecision,
        createdAt: runRow.created_at,
      };
    } catch (error) {
      logMemoryWarning('QueueRunner.loadLatestSentinelResult', error);
      return null;
    }
  }
}

export function createQueueRunner(): QueueRunner {
  return new QueueRunner();
}
