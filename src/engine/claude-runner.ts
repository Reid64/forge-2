/**
 * FORGE 2.0 — Claude Runner (Phase 3 Build Executor engine, queue.yaml s5-p01).
 *
 * Thin, never-throws wrapper around the Claude Code CLI. This is the ONE place in FORGE
 * that actually spawns `claude` to do build work — every Phase 3 prompt is executed
 * through {@link runClaude}. The contract is fixed by BEHAVIORAL_CONTRACTS.md:
 *
 *   - Contract 5 (Claude Code Execution): the command is exactly
 *       `claude -p --dangerously-skip-permissions`
 *     the assembled prompt is piped via STDIN (never passed as a file/argument), and we
 *     capture stdout, stderr, and the exit code. The timeout is 15 minutes — on timeout
 *     the process is killed and the prompt is reported as FAILED (never silently retried
 *     here; recovery is the executor's job).
 *   - Contract 6 (PowerShell Environment): on Windows the CLI is resolved through the
 *     shell (npm-global `claude` is a `.cmd` shim), and the working directory is the
 *     TARGET PROJECT ROOT — never FORGE's own directory. `$PATH` is inherited from the
 *     caller (Phase 0 guarantees Node.js is on it).
 *
 * This module makes NO decisions about WHAT to run or what to do with the result — it
 * only runs the process and reports faithfully (Iron Law 3 — never fabricate an outcome).
 * It never throws: a spawn failure (e.g. `claude` not found) or a timeout resolves to a
 * result with `success: false` and the reason captured in `stderr` / `timedOut`.
 *
 * The returned `tokensEstimated` is a DELIBERATELY COARSE heuristic (≈ chars / 4 over the
 * piped prompt + captured stdout) for cost/telemetry only — it is NOT the API's real token
 * count (the CLI does not surface one over this interface). The executor records it to
 * `prompt_executions` as an estimate; precise accounting comes from elsewhere if needed.
 */

import { spawn } from 'node:child_process';

import { logLine } from '../tools/forge-logger.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The fixed Claude Code CLI command (BEHAVIORAL_CONTRACTS Contract 5). */
export const CLAUDE_COMMAND = 'claude';
/** The fixed Claude Code CLI arguments (BEHAVIORAL_CONTRACTS Contract 5). */
export const CLAUDE_ARGS: readonly string[] = ['-p', '--dangerously-skip-permissions'];
/** Default per-prompt timeout: 15 minutes (BEHAVIORAL_CONTRACTS Contract 5). */
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
/** Grace period between SIGTERM and SIGKILL when killing a timed-out process. */
const KILL_GRACE_MS = 5000;
/** Heuristic characters-per-token used for the coarse `tokensEstimated`. */
const CHARS_PER_TOKEN = 4;

/** The result of a single Claude Code CLI execution. */
export interface ClaudeRunResult {
  /** Captured standard output (UTF-8). */
  stdout: string;
  /** Captured standard error (UTF-8). On a spawn failure, the spawn error message. */
  stderr: string;
  /** Process exit code, or `null` when the process was killed by a signal / timeout. */
  exitCode: number | null;
  /** Wall-clock duration of the run, in milliseconds. */
  durationMs: number;
  /** Coarse token estimate (≈ chars/4 over prompt + stdout) for cost telemetry only. */
  tokensEstimated: number;
  /** True when the run exceeded the timeout and was killed (Contract 5 → FAILED). */
  timedOut: boolean;
  /** The signal that terminated the process, if any (e.g. `'SIGTERM'`). */
  signal: NodeJS.Signals | null;
  /** True when the process spawned and exited cleanly with code 0 (and did not time out). */
  success: boolean;
}

/** Options for {@link runClaude}. */
export interface ClaudeRunnerOptions {
  /**
   * Working directory for the spawned process — ALWAYS the target project root, never
   * FORGE's own directory (Contract 6). Default: `process.cwd()`.
   */
  cwd?: string;
  /** Timeout in milliseconds before the process is killed. Default: 15 minutes. */
  timeoutMs?: number;
  /** Override the executable (tests / alternate install). Default `'claude'`. */
  command?: string;
  /** Override the arguments. Default `['-p', '--dangerously-skip-permissions']`. */
  args?: readonly string[];
  /**
   * Run through a shell. Default: true on Windows (npm-global `claude` is a `.cmd`
   * shim that cannot be spawned directly by name), false elsewhere. The command and
   * args are static and the prompt is piped via stdin, so this introduces no injection
   * surface.
   */
  shell?: boolean;
  /** Environment for the child. Default: inherit `process.env` (PATH includes Node — Phase 0). */
  env?: NodeJS.ProcessEnv;
  /** External cancellation. When aborted, the process is killed and the run fails. */
  signal?: AbortSignal;
  /** Progress reporter. Default logs to the console with a `[FORGE:claude]` prefix. */
  log?: (message: string) => void;
  /**
   * Override the token estimator (tests). Receives the piped prompt and captured stdout;
   * default is `Math.ceil((prompt.length + stdout.length) / 4)`.
   */
  estimateTokens?: (prompt: string, stdout: string) => number;
}

/** Coarse default token estimate: total characters (prompt + output) / 4, rounded up. */
function defaultEstimateTokens(prompt: string, stdout: string): number {
  return Math.ceil((prompt.length + stdout.length) / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Execute one Claude Code prompt and return the captured result.
 *
 * Spawns `claude -p --dangerously-skip-permissions` (overridable), pipes `prompt` via
 * stdin, and collects stdout/stderr until the process closes. If the run exceeds the
 * timeout it is killed (SIGTERM, then SIGKILL after a grace period) and reported with
 * `timedOut: true` / `success: false`.
 *
 * Never rejects: spawn errors, non-zero exits, and timeouts all resolve to a
 * {@link ClaudeRunResult} describing the failure (Iron Law 3 — report the real outcome).
 */
export function runClaude(
  prompt: string,
  options: ClaudeRunnerOptions = {}
): Promise<ClaudeRunResult> {
  const log = options.log ?? logLine('claude');
  const command = options.command ?? CLAUDE_COMMAND;
  const args = [...(options.args ?? CLAUDE_ARGS)];
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const useShell = options.shell ?? process.platform === 'win32';
  // Strip ANTHROPIC_API_KEY so claude -p uses Max subscription, not paid API
  const rawEnv = options.env ?? process.env;
  const env = { ...rawEnv };
  delete env['ANTHROPIC_API_KEY'];
  const estimate = options.estimateTokens ?? defaultEstimateTokens;

  return new Promise<ClaudeRunResult>((resolve) => {
    const startedAt = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    log(`exec: ${command} ${args.join(' ')} (cwd=${cwd}, timeout=${Math.round(timeoutMs / 1000)}s)`);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: useShell,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // Synchronous spawn failure (rare) — report, never throw.
      const message = error instanceof Error ? error.message : String(error);
      resolve({
        stdout: '',
        stderr: `Failed to spawn ${command}: ${message}`,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        tokensEstimated: estimate(prompt, ''),
        timedOut: false,
        signal: null,
        success: false,
      });
      return;
    }

    /** Resolve exactly once, clearing timers and detaching the abort listener. */
    const finish = (partial: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      spawnError?: string;
    }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderrCaptured = Buffer.concat(stderrChunks).toString('utf8');
      const stderr = partial.spawnError
        ? [stderrCaptured, partial.spawnError].filter((s) => s !== '').join('\n')
        : stderrCaptured;
      const success =
        !timedOut && partial.spawnError === undefined && partial.exitCode === 0;

      if (timedOut) {
        log(`TIMEOUT after ${Math.round(timeoutMs / 1000)}s — process killed (prompt FAILED)`);
      } else if (partial.spawnError) {
        log(`spawn error — ${partial.spawnError}`);
      } else {
        log(`exit code ${partial.exitCode ?? 'null'}${partial.signal ? ` (signal ${partial.signal})` : ''}`);
      }

      resolve({
        stdout,
        stderr,
        exitCode: partial.exitCode,
        durationMs: Date.now() - startedAt,
        tokensEstimated: estimate(prompt, stdout),
        timedOut,
        signal: partial.signal,
        success,
      });
    };

    /** Kill the process tree: SIGTERM, then SIGKILL after a grace period. */
    const killProcess = (): void => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    };

    const onAbort = (): void => {
      if (settled) return;
      timedOut = true; // treat external cancellation like a timeout: a failed run
      killProcess();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcess();
    }, timeoutMs);
    // Don't let the timeout timer keep the event loop alive on its own.
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (error: Error) => {
      // Asynchronous spawn failure (e.g. ENOENT — `claude` not on PATH).
      finish({ exitCode: null, signal: null, spawnError: error.message });
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish({ exitCode: code, signal });
    });

    // Pipe the prompt via stdin (Contract 5). Swallow EPIPE if the child closed stdin early.
    const stdin = child.stdin;
    if (stdin) {
      stdin.on('error', () => {
        /* EPIPE / closed pipe — the close/error handlers report the real outcome. */
      });
      stdin.write(prompt, 'utf8');
      stdin.end();
    }
  });
}

export default runClaude;

