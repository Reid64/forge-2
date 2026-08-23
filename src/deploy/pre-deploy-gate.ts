/**
 * FORGE 2.0 — Pre-Deploy Build Gate (F8, upgrades/TESTING_BLUEPRINT.md "Agent Contract:
 * PreDeployBuildGate").
 *
 * Runs `pnpm run build` and `pnpm run lint` in the target project before `forge deploy` is
 * allowed to proceed to an actual deploy. A non-zero exit from either command blocks the deploy
 * and records a BLOCKER section in the project's STATE_OF_THE_BUILD.md.
 *
 * Session 5.2's root cause (a hijacked PowerShell `$PROFILE` silently `Set-Location`-ing away
 * from `cwd`, so a gate command could "pass" against the wrong project) means every command here
 * uses the same `-NoProfile -NonInteractive` hardening as claude-runner.ts/phase4-sentinel.ts.
 *
 * DESIGN APPROVAL GATE: alongside build/lint, this gate also runs
 * `design-pipeline/deployment-gate.ts`'s `checkDesignApproval` — a real, blocking check (not an
 * exported-but-unused function) that a project has at least one approved `design_reviews` record
 * before deploy is allowed to proceed. Represented as a third synthetic `PreDeployCheckResult`
 * (`command: 'design-approval-gate'`) so it flows through the exact same
 * pass/fail/BLOCKER-reporting path `runGateCommand`'s real subprocess checks already use — no
 * parallel reporting mechanism. Opt out via `requireDesignApproval: false` (wired to `forge deploy
 * --skip-design-gate`) for a project with no UI/design-review workflow at all.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { toAsciiGovernanceText } from '../tools/governance-text.js';
import { checkDesignApproval } from '../design-pipeline/deployment-gate.js';

const execAsync = promisify(exec);

const MAX_OUTPUT_CHARS = 8000;
const GATE_TIMEOUT_MS = 10 * 60 * 1000;

export interface PreDeployCheckResult {
  command: string;
  exitCode: number | null;
  skipped: boolean;
  skipReason?: string;
  outputTail: string;
}

export interface PreDeployGateResult {
  passed: boolean;
  checks: PreDeployCheckResult[];
}

/** Shape `child_process.exec` throws on a non-zero exit / timeout. */
interface ExecError {
  code?: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  message?: string;
}

/**
 * Quote a command string for embedding inside a `powershell.exe -Command "..."` argument that is
 * itself launched via cmd.exe's default shell. The commands run here are constant strings
 * (`pnpm run build`, `pnpm run lint`) — no injection surface.
 */
function quoteForPowerShellCommandArg(command: string): string {
  return `"${command.replace(/"/g, '\\"')}"`;
}

function clip(text: string, max = MAX_OUTPUT_CHARS): string {
  const t = text ?? '';
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n... [${t.length - max} more chars truncated]`;
}

/**
 * Run one gate command in `cwd`, capturing exit code and output. On Windows this is invoked as
 * `powershell.exe -NoProfile -NonInteractive -Command "..."` so a user `$PROFILE` can never
 * override `cwd` (see module docstring).
 */
async function runGateCommand(command: string, cwd: string): Promise<PreDeployCheckResult> {
  const effectiveCommand =
    process.platform === 'win32'
      ? `powershell.exe -NoProfile -NonInteractive -Command ${quoteForPowerShellCommandArg(command)}`
      : command;
  try {
    const { stdout, stderr } = await execAsync(effectiveCommand, {
      cwd,
      timeout: GATE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      command,
      exitCode: 0,
      skipped: false,
      outputTail: clip(String(stderr ?? '') || String(stdout ?? '')),
    };
  } catch (error) {
    const e = (error ?? {}) as ExecError;
    const exitCode = typeof e.code === 'number' ? e.code : 1;
    const output = String(e.stderr ?? '') || String(e.stdout ?? '') || String(e.message ?? '');
    return { command, exitCode, skipped: false, outputTail: clip(output) };
  }
}

/** Append a timestamped BLOCKER section (failed command + full output) to STATE_OF_THE_BUILD.md. */
async function appendBlockerSection(governanceDir: string, failed: PreDeployCheckResult[]): Promise<void> {
  const target = join(governanceDir, 'STATE_OF_THE_BUILD.md');
  const timestamp = new Date().toISOString();
  const lines: string[] = ['', `## BLOCKER — Pre-Deploy Gate Failed (${timestamp})`, ''];
  for (const check of failed) {
    lines.push(`- Command: \`${check.command}\``);
    lines.push(`- Exit code: ${check.exitCode ?? 'unknown'}`);
    lines.push('- Output:');
    lines.push('```');
    lines.push(check.outputTail);
    lines.push('```');
    lines.push('');
  }
  try {
    await appendFile(target, toAsciiGovernanceText(lines.join('\n') + '\n'), 'utf8');
  } catch {
    /* non-fatal — the state document update must never block gate reporting */
  }
}

/** Run `design-pipeline/deployment-gate.ts`'s real approval check, reported as a synthetic gate command. */
async function runDesignApprovalCheck(projectPath: string): Promise<PreDeployCheckResult> {
  const result = await checkDesignApproval(projectPath);
  return {
    command: 'design-approval-gate',
    exitCode: result.approved ? 0 : 1,
    skipped: false,
    outputTail: clip(result.reason),
  };
}

export interface RunPreDeployGateOptions {
  /** Set `false` to skip the design-approval check (e.g. a project with no design-review workflow). Default `true`. */
  requireDesignApproval?: boolean;
}

/**
 * F8 entry point: run `pnpm run build`, `pnpm run lint`, and (by default) the design-approval gate
 * in `projectPath`. If any check fails, a BLOCKER section (timestamp, failed command, full output)
 * is appended to `<projectPath>/<governanceDirName>/STATE_OF_THE_BUILD.md` and the gate reports
 * `passed: false`.
 */
export async function runPreDeployGate(
  projectPath: string,
  governanceDirName = 'governance',
  options: RunPreDeployGateOptions = {}
): Promise<PreDeployGateResult> {
  const buildCheck = await runGateCommand('pnpm run build', projectPath);
  const lintCheck = await runGateCommand('pnpm run lint', projectPath);
  const checks: PreDeployCheckResult[] = [buildCheck, lintCheck];

  if (options.requireDesignApproval ?? true) {
    checks.push(await runDesignApprovalCheck(projectPath));
  } else {
    checks.push({
      command: 'design-approval-gate',
      exitCode: 0,
      skipped: true,
      skipReason: 'requireDesignApproval=false',
      outputTail: 'design approval gate skipped by caller',
    });
  }

  const failed = checks.filter((c) => c.exitCode !== 0);
  const passed = failed.length === 0;
  if (!passed) {
    await appendBlockerSection(join(projectPath, governanceDirName), failed);
  }
  return { passed, checks };
}
