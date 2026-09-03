/**
 * FORGE 2.0 — Pass@K Analysis (statistical prompt quality measurement).
 *
 * ORPHANED (Finding G-1, 2026-09-02 audit): no CLI command or caller wires this in anywhere in
 * `src/`. The measurement logic is real and complete; it has simply never been exposed via a
 * `forge` subcommand. Kept as-is — wiring requires a `forge pass-at-k <prompt>` (or similar)
 * command, which is a scope decision for whoever wants this signal surfaced, not a bug fix.
 *
 * Measures prompt reliability by executing it k times in isolated git branches and
 * recording compile-gate outcomes. Two key statistics per prompt:
 *   - pass@1: fraction of individual attempts that pass (passCount / k)
 *   - pass@k: 1.0 when at least one of the k attempts passes, else 0.0
 *
 * assessPromptQuality maps pass@1 to an actionable quality tier; validateQueue samples
 * a queue.yaml file and flags every prompt that falls below the 60 % threshold.
 *
 * IRON LAW 3 (never fabricate results): every pass/fail record reflects real compile
 * gate output captured from pnpm tsc --noEmit. No outcome is inferred or assumed.
 */

import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { load as parseYaml } from 'js-yaml';

import { runClaude } from '../engine/claude-runner.js';
import GitManager from '../engine/git-manager.js';
import { logLine } from '../tools/forge-logger.js';

// ---------------------------------------------------------------------------
// ClaudeRunner type — re-exported so callers share the same signature
// ---------------------------------------------------------------------------

/** Function type of the Claude Code CLI runner (matches runClaude). */
export type ClaudeRunner = typeof runClaude;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Detail record for one attempt within a pass@k measurement. */
export interface RunDetail {
  /** Zero-based attempt index within the k runs. */
  runIndex: number;
  /** The git branch created for this attempt. */
  branchName: string;
  /** Whether the Claude runner reported success (exit code 0). */
  claudeSuccess: boolean;
  /** Whether `pnpm tsc --noEmit` passed after the prompt ran. */
  compilePass: boolean;
  /** True when both claudeSuccess and compilePass are true. */
  passed: boolean;
  /** Wall-clock duration of the Claude run in milliseconds. */
  durationMs: number;
  /** Captured error text from the runner or compile gate on failure. */
  error?: string;
}

/** Result of running a prompt k times and recording compile-gate outcomes. */
export interface PassAtKResult {
  /** The prompt text that was measured. */
  prompt: string;
  /** Number of attempts made. */
  k: number;
  /** Per-attempt detail records, one per run. */
  runs: RunDetail[];
  /** Number of attempts that passed (claudeSuccess AND compilePass). */
  passCount: number;
  /** Probability a single attempt passes: passCount / k (0.0–1.0). */
  passAtOne: number;
  /** 1.0 if at least one attempt passed, 0.0 otherwise. */
  passAtK: number;
  /** ISO 8601 timestamp when the measurement started. */
  measuredAt: string;
}

/** Actionable quality tier derived from pass@1. */
export type QualityTier =
  | 'production-ready' // pass@1 >= 80 %
  | 'acceptable'       // pass@1 60–79 %
  | 'needs-rewriting'  // pass@1 40–59 %
  | 'blocked';         // pass@1 < 40 %

/** Assessment of a prompt's build-queue readiness. */
export interface QualityAssessment {
  tier: QualityTier;
  /** Human-readable explanation and recommended action. */
  recommendation: string;
  /** Whether this prompt may safely enter the build queue. */
  allowInQueue: boolean;
  /** The pass@1 score the tier was derived from (0.0–1.0). */
  passAtOne: number;
}

/** Validation record for a single prompt sampled from the queue. */
export interface PromptValidation {
  /** Queue entry id, or an auto-generated id when the entry lacks one. */
  promptId: string;
  /** Entry name, or the first 80 characters of its description. */
  promptName: string;
  result: PassAtKResult;
  assessment: QualityAssessment;
  /** True when pass@1 is below the 60 % flag threshold. */
  flagged: boolean;
}

/** Overall quality report from a sampled queue validation run. */
export interface QueueValidationResult {
  /** Path of the queue.yaml file that was validated. */
  queuePath: string;
  /** Total number of prompts in the queue. */
  totalPrompts: number;
  /** Number of prompts that were sampled and measured. */
  sampledCount: number;
  /** Per-prompt validation records (one per sampled prompt). */
  validations: PromptValidation[];
  /** Subset of validations whose pass@1 is below 60 %. */
  flaggedPrompts: PromptValidation[];
  /** Mean pass@1 across all sampled prompts (0.0–1.0). */
  overallQualityScore: number;
  /** ISO 8601 timestamp of the validation run. */
  validatedAt: string;
}

// ---------------------------------------------------------------------------
// Internal constants and helpers
// ---------------------------------------------------------------------------

const log = logLine('pass-at-k');

/** Compile gate command (CLAUDE.md Iron Law 6). */
const COMPILE_COMMAND = 'pnpm tsc --noEmit';
/** Max milliseconds allowed for the compile gate. */
const COMPILE_TIMEOUT_MS = 120_000;
/** pass@1 threshold below which a prompt is flagged in queue validation. */
const FLAG_THRESHOLD = 0.6;
/** Build-id segment injected into measurement branch names. */
const PAK_BUILD_ID = 'pass-at-k';

/** Run `pnpm tsc --noEmit` and return pass/fail plus any captured output. */
function runCompileGate(projectPath: string): { pass: boolean; error?: string } {
  try {
    execSync(COMPILE_COMMAND, {
      cwd: projectPath,
      timeout: COMPILE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
    });
    return { pass: true };
  } catch (err) {
    const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr as Buffer | undefined)?.toString('utf8') ?? '';
    const stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout as Buffer | undefined)?.toString('utf8') ?? '';
    const error = (stderr.trim() || stdout.trim() || e.message || String(err)).slice(0, 2000);
    return { pass: false, error };
  }
}

/** Force-delete a git branch by name. Returns a captured error string on failure. */
function deleteBranch(branchName: string, projectPath: string): string | undefined {
  try {
    execSync(`git branch -D "${branchName}"`, {
      cwd: projectPath,
      timeout: 30_000,
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
    });
    return undefined;
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr as Buffer | undefined)?.toString('utf8') ?? '';
    return (stderr.trim() || e.message || String(err)).slice(0, 500);
  }
}

// ---------------------------------------------------------------------------
// Minimal shape expected from a queue.yaml prompt entry
// ---------------------------------------------------------------------------

interface PromptEntry {
  id?: string;
  name?: string;
  description: string;
}

function isPromptEntry(e: unknown): e is PromptEntry {
  if (typeof e !== 'object' || e === null) return false;
  return typeof (e as Record<string, unknown>).description === 'string';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Measure pass@k for a single prompt: run it k times (recommended default: 3) in
 * isolated git branches, run the compile gate after each attempt, and record outcomes.
 *
 * Per-run sequence:
 *   1. Create branch `forge/pass-at-k/prompt-{i}-{measurementId}` from the current HEAD.
 *   2. Execute the prompt through `runner` in `projectPath`.
 *   3. Commit all changes so the working tree is clean before switching back.
 *   4. Run `pnpm tsc --noEmit` to assess compile health.
 *   5. Check out the original branch and delete the measurement branch.
 *
 * Never rejects — all errors are captured in RunDetail records (Iron Law 3).
 */
export async function measurePassAtK(
  prompt: string,
  k: number,
  projectPath: string,
  runner: ClaudeRunner,
): Promise<PassAtKResult> {
  const measuredAt = new Date().toISOString();
  const measurementId = randomUUID().replace(/-/g, '').slice(0, 12);
  const git = new GitManager({ cwd: projectPath });

  const originResult = git.getCurrentBranch();
  if (!originResult.success || originResult.branch === null) {
    log(`cannot determine current branch: ${originResult.error ?? 'unknown'} — aborting measurement`);
    return { prompt, k, runs: [], passCount: 0, passAtOne: 0, passAtK: 0, measuredAt };
  }
  const originBranch = originResult.branch;

  const runs: RunDetail[] = [];

  for (let i = 0; i < k; i++) {
    log(`run ${i + 1}/${k} (measurement ${measurementId})`);

    // 1. Create the measurement branch from the current HEAD.
    const createResult = git.createBranch(PAK_BUILD_ID, i, measurementId);
    if (!createResult.success) {
      log(`branch creation failed (run ${i}): ${createResult.error ?? 'unknown'}`);
      runs.push({
        runIndex: i,
        branchName: createResult.branchName,
        claudeSuccess: false,
        compilePass: false,
        passed: false,
        durationMs: 0,
        error: `Branch creation failed: ${createResult.error ?? 'unknown'}`,
      });
      // Return to origin so the next run starts from the same base.
      git.checkout(originBranch);
      continue;
    }

    const branchName = createResult.branchName;

    // 2. Execute the prompt.
    const runResult = await runner(prompt, { cwd: projectPath });

    // 3. Commit all changes to keep the branch self-contained and the tree clean.
    git.commitAll(`[FORGE:pass-at-k] measurement ${measurementId} run ${i}`);

    // 4. Run the compile gate.
    const compile = runCompileGate(projectPath);

    const passed = runResult.success && compile.pass;
    const errorParts: string[] = [];
    if (!runResult.success) errorParts.push(`claude: ${runResult.stderr.slice(0, 500)}`);
    if (!compile.pass && compile.error) errorParts.push(`tsc: ${compile.error}`);

    runs.push({
      runIndex: i,
      branchName,
      claudeSuccess: runResult.success,
      compilePass: compile.pass,
      passed,
      durationMs: runResult.durationMs,
      error: errorParts.length > 0 ? errorParts.join(' | ') : undefined,
    });

    log(`run ${i}: claude=${runResult.success} compile=${compile.pass} passed=${passed}`);

    // 5. Return to the origin branch and clean up the measurement branch.
    const checkoutBack = git.checkout(originBranch);
    if (!checkoutBack.success) {
      log(`failed to return to ${originBranch} after run ${i} — stopping measurement loop`);
      break;
    }
    const deleteErr = deleteBranch(branchName, projectPath);
    if (deleteErr !== undefined) {
      log(`warning: could not delete branch ${branchName}: ${deleteErr}`);
    }
  }

  const passCount = runs.filter((r) => r.passed).length;
  const passAtOne = k > 0 ? passCount / k : 0;
  const passAtK = passCount > 0 ? 1.0 : 0.0;

  return { prompt, k, runs, passCount, passAtOne, passAtK, measuredAt };
}

/**
 * Map a PassAtKResult to a QualityAssessment with a tier and actionable recommendation.
 *
 * Tiers (based on pass@1):
 *   >= 80 %  → production-ready  — enters the build queue unchanged
 *   60–79 %  → acceptable        — enters the queue; consider targeted refinement
 *   40–59 %  → needs-rewriting   — must be rewritten before entering the queue
 *   <  40 %  → blocked           — blocked from the queue; requires manual intervention
 */
export function assessPromptQuality(result: PassAtKResult): QualityAssessment {
  const { passAtOne } = result;

  if (passAtOne >= 0.8) {
    return {
      tier: 'production-ready',
      recommendation:
        'Pass@1 ≥ 80 %: prompt is production-ready and may enter the build queue without changes.',
      allowInQueue: true,
      passAtOne,
    };
  }
  if (passAtOne >= 0.6) {
    return {
      tier: 'acceptable',
      recommendation:
        'Pass@1 60–79 %: prompt is acceptable for the queue; consider targeted refinement to raise reliability.',
      allowInQueue: true,
      passAtOne,
    };
  }
  if (passAtOne >= 0.4) {
    return {
      tier: 'needs-rewriting',
      recommendation:
        'Pass@1 40–59 %: prompt needs rewriting before it may enter the build queue.',
      allowInQueue: false,
      passAtOne,
    };
  }
  return {
    tier: 'blocked',
    recommendation:
      'Pass@1 < 40 %: prompt is blocked from the queue and requires manual intervention.',
    allowInQueue: false,
    passAtOne,
  };
}

/**
 * Sample `sampleSize` prompts from a queue.yaml file, measure each with pass@k (k=3),
 * flag any below the 60 % pass@1 threshold, and return an overall quality report.
 *
 * Sampling uses a uniform stride so the sample spans early, middle, and late queue
 * positions evenly rather than clustering at the start.
 *
 * Never rejects — file-read and YAML-parse errors result in an empty report with a
 * quality score of 0 (Iron Law 3).
 */
export async function validateQueue(
  queuePath: string,
  sampleSize: number,
  projectPath: string,
  runner: ClaudeRunner,
): Promise<QueueValidationResult> {
  const validatedAt = new Date().toISOString();

  // Read and parse the queue file.
  let entries: PromptEntry[] = [];
  try {
    const raw = await readFile(queuePath, 'utf8');
    const parsed = parseYaml(raw) as { prompts?: unknown[] } | null;
    const promptList = Array.isArray(parsed?.prompts) ? parsed.prompts : [];
    entries = promptList.filter(isPromptEntry);
  } catch (err) {
    log(`failed to read queue at ${queuePath}: ${err instanceof Error ? err.message : String(err)}`);
    return {
      queuePath,
      totalPrompts: 0,
      sampledCount: 0,
      validations: [],
      flaggedPrompts: [],
      overallQualityScore: 0,
      validatedAt,
    };
  }

  const totalPrompts = entries.length;
  if (totalPrompts === 0 || sampleSize <= 0) {
    return {
      queuePath,
      totalPrompts,
      sampledCount: 0,
      validations: [],
      flaggedPrompts: [],
      overallQualityScore: 0,
      validatedAt,
    };
  }

  // Uniform stride sampling across the full queue.
  const clampedSize = Math.min(sampleSize, totalPrompts);
  const stride = totalPrompts / clampedSize;
  const sampled: PromptEntry[] = [];
  for (let i = 0; i < clampedSize; i++) {
    const entry = entries[Math.floor(i * stride)];
    if (entry !== undefined) sampled.push(entry);
  }

  // Measure each sampled prompt sequentially (each run is already branch-isolated).
  const validations: PromptValidation[] = [];
  for (const entry of sampled) {
    const promptId = entry.id ?? randomUUID().slice(0, 8);
    const promptName = entry.name ?? entry.description.slice(0, 80);
    log(`validating "${promptName}" (${promptId})`);

    const result = await measurePassAtK(entry.description, 3, projectPath, runner);
    const assessment = assessPromptQuality(result);
    const flagged = result.passAtOne < FLAG_THRESHOLD;

    validations.push({ promptId, promptName, result, assessment, flagged });
  }

  const flaggedPrompts = validations.filter((v) => v.flagged);
  const overallQualityScore =
    validations.length > 0
      ? validations.reduce((sum, v) => sum + v.result.passAtOne, 0) / validations.length
      : 0;

  return {
    queuePath,
    totalPrompts,
    sampledCount: validations.length,
    validations,
    flaggedPrompts,
    overallQualityScore,
    validatedAt,
  };
}
