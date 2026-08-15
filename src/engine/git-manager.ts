/**
 * FORGE 2.0 — Git Manager (Phase 3 Build Executor engine, queue.yaml s5-p03).
 *
 * The ONE place in FORGE that performs git operations against a target project repo. Every
 * Phase 3 prompt (phase3-executor s5-p05, step e/i/j) flows through here for branch
 * isolation, commits, merges, checkpoints, and rollback. The behaviour is fixed by
 * BEHAVIORAL_CONTRACTS.md:
 *
 *   - Contract 10 (Branch Isolation): every prompt runs on a dedicated feature branch
 *       `forge/{build-id}/prompt-{index}-{name}` — main NEVER receives a direct commit during
 *       Phase 3; merges to main only happen after Sentinel passes.
 *   - Contract 11 (Checkpoint Tags): after a successful prompt + Sentinel pass + merge, a
 *       LIGHTWEIGHT (not annotated) tag `forge-checkpoint-{build-id}-{index}` is created — these
 *       enable Build Replay from any checkpoint.
 *   - Contract 12 (Rollback): on Sentinel failure the feature branch is PRESERVED and main is
 *       reset to the last successful checkpoint tag.
 *   - Contract 6 (PowerShell Environment): on Windows the underlying shell is PowerShell and
 *       the working directory is the TARGET PROJECT ROOT — never FORGE's own directory.
 *
 * Every operation runs `git` through `child_process.execSync` and NEVER throws (Iron Law 3 —
 * report the real outcome): a non-zero exit, a missing repo, or a spawn failure all resolve
 * to a {@link GitResult} with `success: false` and the captured `stderr`/`error`. This lets
 * the executor branch on `result.success` instead of wrapping every call in try/catch, and
 * guarantees a single failed git command can never abort the build loop uncaught.
 *
 * Branch/tag NAMES are sanitised to a git-ref-safe charset before use (see {@link branchNameFor}
 * / {@link checkpointTagFor}), so the assembled command strings carry no shell-meta surface;
 * commit MESSAGES (arbitrary text, possibly multi-line / quoted) are passed via a temp
 * `-F <file>` written to the project working directory — never interpolated into the command
 * line — sidestepping PowerShell quoting entirely (and the `jsyaml_temp_directory` error
 * pattern: the temp file lives in the working dir, not `$env:TEMP`, and is always cleaned up).
 */

import { execSync, type ExecSyncOptions } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

import { logLine } from '../tools/forge-logger.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Default main branch merges target / rollback resets (Contract 10/12). */
export const DEFAULT_MAIN_BRANCH = 'main';
/** Default per-command timeout. Git operations are local and fast; a stuck command is a failure. */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;
/** Temp file (in the project working dir) used to pass commit messages via `git commit -F`. */
export const COMMIT_MESSAGE_FILE = '.forge-commit-msg';
/** Max characters kept from a prompt name when slugged into a branch segment. */
const MAX_SLUG_LENGTH = 40;

/** The signature of `child_process.execSync` (the subset Git Manager relies on). */
export type ExecSyncFn = (command: string, options: ExecSyncOptions) => string | Buffer;

/** The outcome of a single git command. Always returned — git failures are captured, not thrown. */
export interface GitResult {
  /** True when the command exited 0. */
  success: boolean;
  /** The exact command string that was run (for logging / diagnostics). */
  command: string;
  /** Captured stdout (UTF-8, never null). */
  stdout: string;
  /** Captured stderr (UTF-8, never null). */
  stderr: string;
  /** Process exit code, or `null` when the process never produced one (spawn failure / signal). */
  exitCode: number | null;
  /** Present only on failure: the stderr (or, if empty, the thrown error message). */
  error?: string;
}

/** {@link GitResult} for {@link GitManager.createBranch} — also reports the intended branch name. */
export interface CreateBranchResult extends GitResult {
  /** The fully-qualified branch name (returned even on failure so the caller knows the intent). */
  branchName: string;
}

/** {@link GitResult} for {@link GitManager.commitAll}. */
export interface CommitResult extends GitResult {
  /** True when there was nothing staged to commit (treated as a benign success, not a failure). */
  nothingToCommit: boolean;
}

/** {@link GitResult} for {@link GitManager.mergeToMain}. */
export interface MergeResult extends GitResult {
  /** The feature branch that was merged in, or `null` if the current branch could not be read. */
  mergedBranch: string | null;
  /** The branch merged into (the configured main branch). */
  targetBranch: string;
}

/** {@link GitResult} for {@link GitManager.tagCheckpoint}. */
export interface TagResult extends GitResult {
  /** The checkpoint tag name (returned even on failure). */
  tag: string;
}

/**
 * {@link GitResult} for {@link GitManager.createWorktree} — a Contract-10 concurrent-execution
 * fan-out point (parallel-scheduler.ts's `executeSchedule`, deferred to "Phase 2" per the
 * scheduler's original design and now enabled). One linked worktree gives one queued prompt its
 * own working directory + detached checkout, so N prompts with no mutual dependency (a scheduler
 * WAVE) can run claude-runner concurrently without their file writes / branch checkouts colliding.
 */
export interface WorktreeResult extends GitResult {
  /** Absolute path to the new linked worktree (usable as a `cwd` for a sibling `GitManager`). */
  worktreePath: string;
}

/** {@link GitResult} for {@link GitManager.rollbackToCheckpoint}. */
export interface RollbackResult extends GitResult {
  /** The checkpoint tag main was reset to. */
  tag: string;
  /** The branch that was reset (the configured main branch). */
  targetBranch: string;
}

/** {@link GitResult} for {@link GitManager.getCurrentBranch}. */
export interface CurrentBranchResult extends GitResult {
  /** The current branch name (`'HEAD'` when detached), or `null` on failure. */
  branch: string | null;
}

/** A single file change in a branch diff. */
export interface GitFileChange {
  /** The git status letter(s): `A`/`M`/`D`/`R100`/`C75`/etc. */
  status: string;
  /** The (new) file path. */
  path: string;
  /** The previous path for a rename/copy, if any. */
  oldPath?: string;
}

/** {@link GitResult} for {@link GitManager.getBranchDiff}. */
export interface BranchDiffResult extends GitResult {
  /** Parsed file changes on the current branch relative to main (empty on failure). */
  files: GitFileChange[];
}

/** A structured record of a single prompt's FORGE commit, returned by {@link GitManager.getChangeLog}. */
export interface PromptCommit {
  /** Full 40-character commit hash. */
  hash: string;
  /** Prompt identifier extracted from the FORGE commit message. */
  promptId: string;
  /** Build phase extracted from the FORGE commit message. */
  phase: string;
  /** Execution status extracted from the FORGE commit message (e.g. PASS, FAIL). */
  status: string;
  /** Files touched by this commit (from `git diff-tree`). */
  filesChanged: string[];
}

/** Construction options for {@link GitManager}. */
export interface GitManagerOptions {
  /**
   * The repository working directory — ALWAYS the target project root, never FORGE's own
   * directory (Contract 6). Default: `process.cwd()`.
   */
  cwd?: string;
  /** The branch merges target and rollback resets. Default: `'main'`. */
  mainBranch?: string;
  /** Per-command timeout in milliseconds. Default: 2 minutes. */
  timeoutMs?: number;
  /**
   * Shell for `execSync`. Default: `'powershell.exe'` on Windows (Contract 6), `'/bin/sh'`
   * elsewhere. The command/args are static or sanitised, so this introduces no injection surface.
   */
  shell?: string | boolean;
  /** Progress reporter. Default logs to the console with a `[FORGE:git]` prefix. */
  log?: (message: string) => void;
  /** Override `execSync` (tests). Default: `child_process.execSync`. */
  execImpl?: ExecSyncFn;
  /**
   * Concurrent-execution mode (Contract 10 parallel fan-out): when this `GitManager`'s `cwd` is a
   * LINKED WORKTREE (created by {@link GitManager.createWorktree}) rather than the primary
   * checkout, it can never check out `mainBranch` itself — that branch is already checked out in
   * the primary worktree, and git refuses to check out the same branch in two worktrees at once.
   * Set `mergeDelegate` to the primary `GitManager`'s {@link GitManager.mergeBranchToMain} (bound)
   * so {@link GitManager.mergeToMain} routes the actual merge through the worktree that legitimately
   * has `mainBranch` checked out, instead of attempting (and failing) it locally. Unset (default)
   * for the classic single-worktree sequential path — `mergeToMain` then merges locally as before.
   */
  mergeDelegate?: (branchName: string) => MergeResult;
  /**
   * Concurrent-execution mode counterpart to {@link mergeDelegate}: a linked worktree's own HEAD
   * never moves onto the merge commit `mergeDelegate` just created (the checkout+merge happened in
   * the PRIMARY worktree's directory) — `git tag` with no explicit ref always tags the INVOKING
   * worktree's own HEAD, so a plain local {@link GitManager.tagCheckpoint} call from a linked
   * worktree would silently tag the wrong commit (its own feature-branch tip). Set `tagDelegate` to
   * the primary `GitManager`'s {@link GitManager.tagCheckpoint} (bound) so the tag is created from
   * the worktree that actually has the merge commit checked out. Unset (default) for the classic
   * single-worktree sequential path — `tagCheckpoint` then tags locally as before.
   */
  tagDelegate?: (buildId: string, promptIndex: number) => TagResult;
}

// ---------------------------------------------------------------------------
// Pure name builders (exported for reuse + unit testing)
// ---------------------------------------------------------------------------

/** Coerce a numeric prompt index to a safe integer string (NaN/∞ → `'0'`). */
function normalizeIndex(promptIndex: number): string {
  return Number.isFinite(promptIndex) ? String(Math.trunc(promptIndex)) : '0';
}

/** Sanitise a build-id (or any path segment) to a git-ref-safe token: `[A-Za-z0-9._-]`, no edge dots/dashes. */
function sanitizeSegment(value: string): string {
  const cleaned = String(value)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.') // git refs forbid `..`
    .replace(/^[.\-]+|[.\-]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'x';
}

/** Slugify a human prompt name into a lowercase, dash-separated, length-capped branch segment. */
export function slugify(name: string): string {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'prompt';
}

/** Build the Contract-10 feature branch name `forge/{buildId}/prompt-{index}-{name}`. */
export function branchNameFor(buildId: string, promptIndex: number, promptName: string): string {
  return `forge/${sanitizeSegment(buildId)}/prompt-${normalizeIndex(promptIndex)}-${slugify(promptName)}`;
}

/** Build the Contract-11 lightweight checkpoint tag `forge-checkpoint-{buildId}-{index}`. */
export function checkpointTagFor(buildId: string, promptIndex: number): string {
  return `forge-checkpoint-${sanitizeSegment(buildId)}-${normalizeIndex(promptIndex)}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Coerce an `execSync` stdout/stderr value (string | Buffer | null | undefined) to a UTF-8 string. */
function toStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Buffer) return value.toString('utf8');
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Quote a single argument for the shell. Sanitised refs pass through; anything else is double-quoted. */
function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9._/:=,@-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/** The shape of the error `execSync` throws on a non-zero exit. */
interface ExecError {
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  message?: string;
}

// ---------------------------------------------------------------------------
// GitManager
// ---------------------------------------------------------------------------

/**
 * Stateful git operator bound to one project working directory. Construct once per build with
 * the target project root as `cwd`, then call the operation methods per prompt. Every method
 * returns a {@link GitResult} (or a richer subtype) and never throws.
 */
export class GitManager {
  private readonly cwd: string;
  private readonly mainBranch: string;
  private readonly timeoutMs: number;
  private readonly shell: string | boolean;
  private readonly log: (message: string) => void;
  private readonly execImpl: ExecSyncFn;
  private readonly mergeDelegate: ((branchName: string) => MergeResult) | undefined;
  private readonly tagDelegate: ((buildId: string, promptIndex: number) => TagResult) | undefined;

  constructor(options: GitManagerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.mainBranch = options.mainBranch ?? DEFAULT_MAIN_BRANCH;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    this.shell = options.shell ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh');
    this.log = options.log ?? logLine('git');
    this.execImpl = options.execImpl ?? ((command, opts) => execSync(command, opts));
    this.mergeDelegate = options.mergeDelegate;
    this.tagDelegate = options.tagDelegate;
  }

  /** This manager's bound working directory (a linked worktree's path, for a concurrent worker). */
  getCwd(): string {
    return this.cwd;
  }

  // -- core runner ----------------------------------------------------------

  /** Build a `git <args...>` command string with each argument shell-quoted. */
  private buildCommand(args: readonly string[]): string {
    return `git ${args.map(quoteArg).join(' ')}`;
  }

  /** Run one already-assembled command string via `execSync`, capturing the outcome. Never throws. */
  private exec(command: string): GitResult {
    this.log(`exec: ${command} (cwd=${this.cwd})`);
    try {
      const out = this.execImpl(command, {
        cwd: this.cwd,
        shell: typeof this.shell === 'string' ? this.shell : undefined,
        timeout: this.timeoutMs,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      return { success: true, command, stdout: toStr(out), stderr: '', exitCode: 0 };
    } catch (err) {
      const e = (err ?? {}) as ExecError;
      const stdout = toStr(e.stdout);
      const stderr = toStr(e.stderr);
      const exitCode = typeof e.status === 'number' ? e.status : null;
      const message = err instanceof Error ? err.message : String(err);
      const error = stderr.trim().length > 0 ? stderr.trim() : message;
      this.log(`FAILED (exit ${exitCode ?? 'null'}): ${error}`);
      return { success: false, command, stdout, stderr, exitCode, error };
    }
  }

  /** Run a `git` command from its argument vector. Never throws. */
  private run(args: readonly string[]): GitResult {
    return this.exec(this.buildCommand(args));
  }

  // -- operations -----------------------------------------------------------

  /**
   * Create and check out the Contract-10 feature branch for a prompt:
   * `forge/{buildId}/prompt-{index}-{name}`. Returns the (intended) branch name even on failure.
   */
  createBranch(buildId: string, promptIndex: number, promptName: string): CreateBranchResult {
    const branchName = branchNameFor(buildId, promptIndex, promptName);
    const result = this.run(['checkout', '-b', branchName]);
    return { ...result, branchName };
  }

  /** Switch to an existing branch. */
  checkout(branchName: string): GitResult {
    return this.run(['checkout', branchName]);
  }

  /**
   * Stage ALL changes and commit them with `message`. The message is written to a temp
   * `-F` file in the working directory (never interpolated into the command line), avoiding
   * shell-quoting issues with arbitrary/multi-line text. An empty index is reported as
   * `nothingToCommit: true` with `success: true` (a no-op, not a failure).
   */
  commitAll(message: string): CommitResult {
    const add = this.run(['add', '-A']);
    if (!add.success) return { ...add, nothingToCommit: false };
    return this.commitStaged(message);
  }

  /**
   * Stage exactly ONE path (`git add -- <path>`, never `-A`) and commit it with `message` — the
   * `promote_scratch` gate's (`src/engine/scratch-promote.ts`) targeted commit of a single
   * canonical path, per this project's standing rule against sweeping unrelated dirty files into
   * a commit via `add -A`. Same temp `-F` message file / `nothingToCommit` contract as
   * {@link commitAll}.
   */
  commitPath(path: string, message: string): CommitResult {
    const add = this.run(['add', '--', path]);
    if (!add.success) return { ...add, nothingToCommit: false };
    return this.commitStaged(message);
  }

  /** Shared commit step (message-file + `git commit -F`) once the caller has already staged what it wants committed. */
  private commitStaged(message: string): CommitResult {
    // Write the message AFTER staging so the temp file itself is never staged; clean up always.
    const messagePath = join(this.cwd, COMMIT_MESSAGE_FILE);
    try {
      writeFileSync(messagePath, message, 'utf8');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log(`FAILED to write commit message file: ${error}`);
      return {
        success: false,
        command: `write ${COMMIT_MESSAGE_FILE}`,
        stdout: '',
        stderr: error,
        exitCode: null,
        error,
        nothingToCommit: false,
      };
    }

    try {
      const commit = this.run(['commit', '-F', messagePath]);
      if (!commit.success) {
        const combined = `${commit.stdout}\n${commit.stderr}`;
        if (/nothing to commit|no changes added|nothing added to commit/i.test(combined)) {
          this.log('nothing to commit — treating as a benign no-op');
          return { ...commit, success: true, error: undefined, nothingToCommit: true };
        }
      }
      return { ...commit, nothingToCommit: false };
    } finally {
      rmSync(messagePath, { force: true });
    }
  }

  /**
   * `git pull` on the current branch — the `promote_scratch` gate's pre-flight (`src/engine/
   * scratch-promote.ts` runs this immediately before comparing/writing the canonical path, so the
   * comparison sees the latest remote state rather than a possibly-stale local `main`).
   */
  pull(): GitResult {
    return this.run(['pull']);
  }

  /** `git push` on the current branch — the `promote_scratch` gate pushes immediately after each successful canonical-path commit. */
  push(): GitResult {
    return this.run(['push']);
  }

  /**
   * Merge the CURRENT feature branch into main with `--no-ff` (Contract 10). Reads the current
   * branch, checks out main, then merges with `--no-edit` (autonomy — never opens an editor).
   */
  mergeToMain(): MergeResult {
    const current = this.getCurrentBranch();
    if (!current.success || current.branch === null) {
      return { ...current, mergedBranch: null, targetBranch: this.mainBranch };
    }
    const mergedBranch = current.branch;

    // Concurrent-execution mode: this cwd is a linked worktree that can never legitimately check
    // out `mainBranch` itself (see GitManagerOptions.mergeDelegate) — route the merge through the
    // primary worktree instead of attempting it here.
    if (this.mergeDelegate) return this.mergeDelegate(mergedBranch);

    const co = this.checkout(this.mainBranch);
    if (!co.success) return { ...co, mergedBranch, targetBranch: this.mainBranch };

    const merge = this.run(['merge', '--no-ff', '--no-edit', mergedBranch]);
    this.checkout(mergedBranch);
    return { ...merge, mergedBranch, targetBranch: this.mainBranch };
  }

  /**
   * Merge an explicit branch into `mainBranch` from THIS manager's cwd, which must be the
   * PRIMARY worktree (the one with `mainBranch` actually checked out) — the counterpart a linked
   * worktree's {@link mergeDelegate} calls into. Unlike {@link mergeToMain}, the branch to merge
   * is a parameter rather than "whatever is currently checked out here", since the primary
   * worktree never checks out the concurrent feature branches itself. On a conflicted/failed
   * merge, the merge is aborted (`git merge --abort`) so `mainBranch` is left clean for the next
   * concurrent sibling's merge rather than stuck mid-conflict.
   */
  mergeBranchToMain(branchName: string): MergeResult {
    const co = this.checkout(this.mainBranch);
    if (!co.success) return { ...co, mergedBranch: branchName, targetBranch: this.mainBranch };

    const merge = this.run(['merge', '--no-ff', '--no-edit', branchName]);
    if (!merge.success) {
      this.log(`merge of ${branchName} into ${this.mainBranch} failed â€” aborting to leave ${this.mainBranch} clean`);
      this.run(['merge', '--abort']);
    }
    return { ...merge, mergedBranch: branchName, targetBranch: this.mainBranch };
  }

  /**
   * Create a linked git worktree (Contract-10 concurrent fan-out) checked out DETACHED at
   * `mainBranch`'s current tip — detached, not `-b <branch>`, so this never collides with
   * `mainBranch` already being checked out in the primary worktree. The caller (a per-worker
   * `GitManager` bound to `worktreePath`) then creates its OWN feature branch there exactly as
   * the sequential path does (`createBranch`), so branch-per-prompt (Contract 10) still holds.
   * The worktree directory is created under `.forge-worktrees/` beside `cwd` (a sibling, never
   * inside the tracked working tree, so it can never show up as untracked project content).
   */
  createWorktree(buildId: string, promptIndex: number, promptName: string): WorktreeResult {
    const dirName = `${sanitizeSegment(buildId)}-prompt-${normalizeIndex(promptIndex)}-${slugify(promptName)}`;
    const worktreePath = join(this.worktreesRoot(), dirName);
    try {
      mkdirSync(this.worktreesRoot(), { recursive: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log(`FAILED to create worktree root directory: ${error}`);
      return { success: false, command: `mkdir ${this.worktreesRoot()}`, stdout: '', stderr: error, exitCode: null, error, worktreePath };
    }
    const result = this.run(['worktree', 'add', '--detach', worktreePath, this.mainBranch]);
    return { ...result, worktreePath };
  }

  /** Remove a linked worktree created by {@link createWorktree} (force â€” its branch is already merged/preserved). */
  removeWorktree(worktreePath: string): GitResult {
    return this.run(['worktree', 'remove', '--force', worktreePath]);
  }

  /** Prune stale linked-worktree metadata left behind by a prior crashed/interrupted concurrent run. */
  pruneWorktrees(): GitResult {
    return this.run(['worktree', 'prune']);
  }

  /** The directory concurrent-execution linked worktrees live under â€” a sibling of `cwd`. */
  private worktreesRoot(): string {
    return join(dirname(this.cwd), '.forge-worktrees');
  }

  /** Create the Contract-11 LIGHTWEIGHT checkpoint tag at the current HEAD. */
  tagCheckpoint(buildId: string, promptIndex: number): TagResult {
    // Concurrent-execution mode: this cwd is a linked worktree whose own HEAD never moved onto the
    // merge commit `mergeDelegate` created in the primary worktree — route the tag through the
    // primary instead of tagging this worktree's (wrong) HEAD locally (see GitManagerOptions.tagDelegate).
    if (this.tagDelegate) return this.tagDelegate(buildId, promptIndex);
    const tag = checkpointTagFor(buildId, promptIndex);
    const result = this.run(['tag', tag]);
    return { ...result, tag };
  }

  /**
   * Contract-12 rollback: check out main and hard-reset it to a checkpoint tag. The feature
   * branch is left untouched (the executor preserves it for diagnosis).
   */
  rollbackToCheckpoint(tag: string): RollbackResult {
    const co = this.checkout(this.mainBranch);
    if (!co.success) return { ...co, tag, targetBranch: this.mainBranch };

    const reset = this.run(['reset', '--hard', tag]);
    return { ...reset, tag, targetBranch: this.mainBranch };
  }

  /**
   * Return the file changes on the current branch relative to main (the merge-base three-dot
   * diff `main...HEAD` — i.e. what this branch introduced). Parses `--name-status` output;
   * `files` is empty on failure.
   */
  getBranchDiff(): BranchDiffResult {
    const result = this.run(['diff', '--name-status', `${this.mainBranch}...HEAD`]);
    if (!result.success) return { ...result, files: [] };
    return { ...result, files: parseNameStatus(result.stdout) };
  }

  /**
   * Return the file changes introduced by the most recent commit on the current branch
   * (`HEAD~1..HEAD`). Used as a fallback signal when {@link getBranchDiff} shows nothing against
   * main (e.g. the feature branch has already converged with main) but the branch's latest
   * commit still contains real work. `files` is empty on failure (including no parent commit).
   */
  getHeadDiff(): BranchDiffResult {
    const result = this.run(['diff', '--name-status', 'HEAD~1..HEAD']);
    if (!result.success) return { ...result, files: [] };
    return { ...result, files: parseNameStatus(result.stdout) };
  }

  /** Return the current branch name (`'HEAD'` when detached), or `null` on failure. */
  getCurrentBranch(): CurrentBranchResult {
    const result = this.run(['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = result.success ? result.stdout.trim() || null : null;
    return { ...result, branch };
  }

  /**
   * Run `git status --porcelain`. Used by the executor to detect a working tree that is still
   * being written to by a backgrounded claude task after `claude -p` itself has exited (see
   * phase3-executor's post-run quiescence poll).
   */
  statusPorcelain(): GitResult {
    return this.run(['status', '--porcelain']);
  }

  /**
   * Stage all changes and commit with the structured FORGE message
   * `FORGE-{project}-P{phase}-{promptId}-{status}`. The project is derived from the
   * working-directory basename so the caller does not need to repeat it. Returns the
   * resulting commit hash. Throws on failure so the executor can route the error into
   * the pipeline error-recovery protocol rather than silently swallowing it.
   */
  async commitPromptChanges(promptId: string, phase: string, status: string): Promise<string> {
    const project = basename(this.cwd);
    const message = `FORGE-${project}-P${phase}-${promptId}-${status}`;
    const commit = this.commitAll(message);
    if (!commit.success && !commit.nothingToCommit) {
      throw new Error(`commitPromptChanges failed: ${commit.error ?? commit.stderr}`);
    }
    const rev = this.run(['rev-parse', 'HEAD']);
    if (!rev.success) throw new Error(`rev-parse HEAD failed: ${rev.error ?? rev.stderr}`);
    return rev.stdout.trim();
  }

  /**
   * Return the full `git show` output for `commitHash`. Useful for diffing exactly
   * what a prompt introduced when diagnosing a regression. Throws on failure (unknown
   * hash, detached HEAD with no objects, etc.).
   */
  async getPromptDiff(commitHash: string): Promise<string> {
    const result = this.run(['show', commitHash]);
    if (!result.success) {
      throw new Error(`getPromptDiff failed for ${commitHash}: ${result.error ?? result.stderr}`);
    }
    return result.stdout;
  }

  /**
   * Surgically revert a single prompt's commit via `git revert --no-edit`. This creates
   * an inverse commit on the current branch and leaves all other commits intact — it does
   * NOT reset or delete history. Throws on failure (merge conflict, ambiguous ref, etc.)
   * so the executor can escalate to the Tier-2/3 recovery protocol.
   */
  async revertPrompt(commitHash: string): Promise<void> {
    const result = this.run(['revert', '--no-edit', commitHash]);
    if (!result.success) {
      throw new Error(`revertPrompt failed for ${commitHash}: ${result.error ?? result.stderr}`);
    }
  }

  /**
   * List all FORGE-prefixed commits reachable since `since` (a commit hash/tag or an ISO
   * date string like `2024-01-15`). Parses the structured message
   * `FORGE-{project}-P{phase}-{promptId}-{status}` and resolves which files each commit
   * changed via `git diff-tree`. Returns `[]` when git fails or no matching commits exist.
   */
  async getChangeLog(since: string): Promise<PromptCommit[]> {
    const isDate = /^\d{4}[-/]\d{2}[-/]\d{2}/.test(since);
    const rangeArgs: string[] = isDate
      ? [`--after=${since}`, 'HEAD']
      : [`${since}..HEAD`];

    const logResult = this.run(['log', '--format=%H %s', ...rangeArgs, '--grep=^FORGE-']);
    if (!logResult.success) return [];

    const commits: PromptCommit[] = [];
    for (const rawLine of logResult.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx === -1) continue;
      const hash = line.slice(0, spaceIdx);
      const subject = line.slice(spaceIdx + 1);

      // Parse: FORGE-{project}-P{phase}-{promptId}-{status}
      // Locate the first occurrence of "-P" followed by a non-dash char to split project
      // from the phase/promptId/status tail. This handles project names that contain dashes.
      const forgePrefix = 'FORGE-';
      if (!subject.startsWith(forgePrefix)) continue;
      const afterForge = subject.slice(forgePrefix.length);
      const pIdx = afterForge.search(/-P[^-]/);
      if (pIdx === -1) continue;
      const afterP = afterForge.slice(pIdx + 2); // skip '-P'
      const firstDash = afterP.indexOf('-');
      if (firstDash === -1) continue;
      const phase = afterP.slice(0, firstDash);
      const promptIdAndStatus = afterP.slice(firstDash + 1);
      const lastDash = promptIdAndStatus.lastIndexOf('-');
      const promptId = lastDash >= 0 ? promptIdAndStatus.slice(0, lastDash) : promptIdAndStatus;
      const statusParsed = lastDash >= 0 ? promptIdAndStatus.slice(lastDash + 1) : '';

      const filesResult = this.run(['diff-tree', '--no-commit-id', '-r', '--name-only', hash]);
      const filesChanged = filesResult.success
        ? filesResult.stdout.split(/\r?\n/).filter(f => f.trim().length > 0)
        : [];

      commits.push({ hash, promptId, phase, status: statusParsed, filesChanged });
    }
    return commits;
  }
}

/** Parse `git diff --name-status` output into structured {@link GitFileChange} entries. */
function parseNameStatus(stdout: string): GitFileChange[] {
  const changes: GitFileChange[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parts = line.split(/\t/);
    const status = parts[0] ?? '';
    if (status.length === 0) continue;
    // Renames/copies report `R<score>\told\tnew` / `C<score>\told\tnew`.
    if (/^[RC]/.test(status) && parts.length >= 3) {
      const oldPath = parts[1] ?? '';
      const path = parts[2] ?? '';
      if (path.length > 0) changes.push({ status, path, oldPath });
      continue;
    }
    const path = parts[1] ?? '';
    if (path.length > 0) changes.push({ status, path });
  }
  return changes;
}

export default GitManager;
