// FORGE 2.0 — Enterprise Test Suite: guarded shell runner shared by every runner module.
//
// Same Windows PowerShell hardening as phase4-sentinel.ts's `defaultRunCommand` (Session 5.2
// root cause: `exec(command, { shell: 'powershell.exe' })` lets the user's `$PROFILE` hijack cwd
// silently). Not exported from phase4-sentinel.ts, so it is intentionally re-implemented here
// rather than reaching across module boundaries into Sentinel's internals.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface ShellResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ShellRunner = (command: string, cwd: string, timeoutMs: number) => Promise<ShellResult>;

interface ExecError {
  code?: number;
  killed?: boolean;
  signal?: string;
  stdout?: string;
  stderr?: string;
  message?: string;
}

/** Quote a command string as a single PowerShell `-Command` argument. */
function quoteForPowerShellCommandArg(command: string): string {
  return `"${command.replace(/"/g, '\\"')}"`;
}

/** Run `command` in `cwd` with a timeout, capturing output and NEVER throwing (Iron Law 3). */
export async function defaultShellRunner(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<ShellResult> {
  const effectiveCommand =
    process.platform === 'win32'
      ? `powershell.exe -NoProfile -NonInteractive -Command ${quoteForPowerShellCommandArg(command)}`
      : command;
  try {
    const { stdout, stderr } = await execAsync(effectiveCommand, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut: false };
  } catch (error) {
    const e = (error ?? {}) as ExecError;
    const exitCode = typeof e.code === 'number' ? e.code : null;
    const timedOut = e.killed === true && e.signal === 'SIGTERM';
    const stderr = String(e.stderr ?? '') || String(e.message ?? '');
    return { ok: false, exitCode, stdout: String(e.stdout ?? ''), stderr, timedOut };
  }
}

/** First non-empty trimmed line of a block of output (for terse `detail` strings). */
export function firstLine(text: string): string {
  return (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '') ?? '';
}
