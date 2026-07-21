/**
 * FORGE 2.0 — System 5: Sentinel Prime — ExecutionMonitor.
 *
 * Real-time observer for a single Phase 3 prompt's subprocess execution. Phase 3 spawns
 * `claude` through `runClaude` (`src/engine/claude-runner.ts`) with the prompt piped via
 * stdin and stdout/stderr captured until the process closes (see the `child.stdout.on('data', ...)`
 * accumulation there). `findOutOfBoundsPaths` in `src/phases/phase3-executor.ts` (Session 5.2
 * Task 3) already does a single best-effort scan of the FULLY CAPTURED stdout after a run
 * completes. ExecutionMonitor is the streaming, per-chunk counterpart: a caller feeds it stdout
 * chunks and shell commands AS they happen (one instance per prompt, held live for the duration
 * of the subprocess) so an out-of-scope write can be observed and reasoned about immediately,
 * not only reconstructed after the fact from the final buffer.
 *
 * BOUNDARY: a prompt's only permitted write scope is the `projectPath` recorded at `start()` —
 * this mirrors the project-boundary guard `prompt-assembler.ts` states in the prompt itself
 * (Session 5.2 Task 4). ExecutionMonitor does not enforce anything on its own (it cannot kill
 * the subprocess); it OBSERVES and RECORDS violations for the caller (Sentinel Prime's
 * orchestrator) to act on via `finish()`'s `passed` flag.
 *
 * Never throws: every observer method is a pure recording operation over in-memory state.
 */

import { randomUUID } from 'node:crypto';

import {
  EventSeverity,
  ObservationEventType,
  type ExecutionMonitorResult,
  type ObservationEvent,
} from './types.js';

// ---------------------------------------------------------------------------
// Path-scope helpers
// ---------------------------------------------------------------------------

/** Normalize a path for scope comparison: forward slashes, lowercase, no trailing slash. */
function normalizeForCompare(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

/** True when `path` looks like an absolute filesystem path (Windows drive or POSIX root). */
function isAbsoluteLike(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/');
}

/** Extracts path-shaped tokens (has a file extension) from a block of free text. */
const PATH_TOKEN_PATTERN = /[A-Za-z]:[\\/][^\s"'`)]+|(?<![:/\w])\/[^\s"'`)]{2,}/g;

/**
 * Patterns claude's print-mode stdout tends to narrate a write/create with — this is a
 * heuristic net over free-form prose, not a structured tool-call log (same caveat as
 * `findOutOfBoundsPaths`).
 */
const FILE_WRITE_STDOUT_PATTERNS: readonly RegExp[] = [
  /\bWriting to\s+([^\s"'`)]+)/gi,
  /\bCreating\s+(?:file\s+)?([^\s"'`)]+)/gi,
  /\bWrote\s+(?:file\s+)?([^\s"'`)]+)/gi,
  /\bcreated\s+(?:file\s+)?([^\s"'`)]+)/gi,
];

/** Delete-narrating patterns, including a plain `rm`/`git rm` command echoed into stdout. */
const FILE_DELETE_STDOUT_PATTERNS: readonly RegExp[] = [
  /\bDeleting\s+([^\s"'`)]+)/gi,
  /\bDeleted\s+([^\s"'`)]+)/gi,
  /\bgit\s+rm\s+(?:--?\S+\s+)*([^\s"'`)]+)/gi,
  /\brm\s+(?:-\S+\s+)*([^\s"'`)]+)/gi,
];

/** `rm -rf` (any flag order/bundling) or PowerShell's `Remove-Item -Recurse -Force`. */
function isDestructiveCommand(command: string): boolean {
  if (/\brm\s+(-[a-z]*r[a-z]*f[a-z]*\b|-[a-z]*f[a-z]*r[a-z]*\b|--recursive\b.*--force\b|--force\b.*--recursive\b)/i.test(command)) {
    return true;
  }
  if (/\brmdir\s+\/s\b/i.test(command)) return true;
  if (/Remove-Item/i.test(command) && /-Recurse\b/i.test(command) && /-Force\b/i.test(command)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// ExecutionMonitor
// ---------------------------------------------------------------------------

/**
 * Streaming observer for one prompt's subprocess execution. Instantiate once per prompt
 * (`start()`), feed it stdout chunks / shell commands / file writes as they are observed, then
 * `finish()` to compile the compiled {@link ExecutionMonitorResult}. Not thread-safe across
 * concurrent prompts — use one instance per prompt (see {@link executionMonitorSingleton}).
 */
export class ExecutionMonitor {
  private buildRunId = '';
  private promptId = '';
  private promptIndex = 0;
  private projectPath = '';
  private normalizedProjectPath = '';
  private startedAt = 0;
  private started = false;

  private events: ObservationEvent[] = [];
  private commandsExecuted: string[] = [];
  private outOfScopeWrites: string[] = [];
  private unexpectedDeletions: string[] = [];
  private stdoutChunkCount = 0;

  /**
   * Initialize a monitoring session for one prompt. Resets all accumulated state (safe to
   * reuse an instance across prompts by calling `start()` again). `projectPath` is recorded as
   * the ONLY allowed write scope for the remainder of this session.
   */
  start(buildRunId: string, promptId: string, promptIndex: number, projectPath: string): void {
    this.buildRunId = buildRunId;
    this.promptId = promptId;
    this.promptIndex = promptIndex;
    this.projectPath = projectPath;
    this.normalizedProjectPath = normalizeForCompare(projectPath);
    this.startedAt = Date.now();
    this.started = true;

    this.events = [];
    this.commandsExecuted = [];
    this.outOfScopeWrites = [];
    this.unexpectedDeletions = [];
    this.stdoutChunkCount = 0;

    this.recordEvent(
      ObservationEventType.GATE_RESULT,
      EventSeverity.INFO,
      projectPath,
      `ExecutionMonitor session started for prompt ${promptIndex} '${promptId}' — write scope pinned to ${projectPath}`
    );
  }

  /**
   * Feed one stdout chunk from the subprocess. Scans it for file-write / file-delete narration
   * (`Writing to X`, `Creating X`, `Deleting X`, `git rm X`, ...) and extracts the referenced
   * paths. Any extracted path that resolves outside `projectPath` emits a CRITICAL
   * {@link ObservationEvent} — CRITICAL rather than HALT because this is a heuristic prose scan,
   * not a confirmed tool call (contrast with {@link observeFileWrite}, which validates a path the
   * caller already knows is real).
   */
  observeStdoutChunk(chunk: string): void {
    if (!this.started || !chunk) return;
    this.stdoutChunkCount += 1;

    const preview = chunk.length > 200 ? `${chunk.slice(0, 200)}...` : chunk;
    this.recordEvent(ObservationEventType.STDOUT_CHUNK, EventSeverity.INFO, null, 'stdout chunk observed', {
      length: chunk.length,
      preview,
    });

    for (const pattern of FILE_WRITE_STDOUT_PATTERNS) {
      this.scanForPaths(chunk, pattern, 'write');
    }
    for (const pattern of FILE_DELETE_STDOUT_PATTERNS) {
      this.scanForPaths(chunk, pattern, 'delete');
    }
  }

  /**
   * Record every shell command the prompt's execution runs. `rm -rf` (any flag ordering) and
   * PowerShell's `Remove-Item -Recurse -Force` are flagged HALT outright (destructive,
   * irreversible). Any absolute-looking path token inside the command that resolves outside
   * `projectPath` is also flagged HALT — a command touching a path outside scope is a confirmed
   * violation, not a heuristic guess.
   */
  observeCommand(command: string): void {
    if (!this.started || !command) return;
    this.commandsExecuted.push(command);

    if (isDestructiveCommand(command)) {
      this.recordEvent(
        ObservationEventType.COMMAND_EXEC,
        EventSeverity.HALT,
        null,
        `Destructive command executed: ${command}`,
        { command }
      );
    } else {
      this.recordEvent(ObservationEventType.COMMAND_EXEC, EventSeverity.INFO, null, 'command executed', {
        command,
      });
    }

    const tokens = command.match(PATH_TOKEN_PATTERN) ?? [];
    for (const token of tokens) {
      if (!isAbsoluteLike(token)) continue;
      if (this.isWithinScope(token)) continue;
      this.outOfScopeWrites.push(token);
      this.recordEvent(
        ObservationEventType.COMMAND_EXEC,
        EventSeverity.HALT,
        token,
        `Command referenced a path outside the allowed project scope (${this.projectPath}): ${token}`,
        { command, path: token }
      );
    }
  }

  /**
   * Validate a single file write the caller already knows occurred (e.g. reported directly by
   * a tool-call log, as opposed to parsed from prose). Relative paths are assumed to resolve
   * under `projectPath` (the subprocess's cwd is always the target project root — Contract 6)
   * and are recorded INFO. An absolute path outside `projectPath` emits HALT.
   */
  observeFileWrite(filePath: string): void {
    if (!this.started || !filePath) return;

    if (isAbsoluteLike(filePath) && !this.isWithinScope(filePath)) {
      this.outOfScopeWrites.push(filePath);
      this.recordEvent(
        ObservationEventType.FILE_WRITE,
        EventSeverity.HALT,
        filePath,
        `File write outside the allowed project scope (${this.projectPath}): ${filePath}`,
        { path: filePath }
      );
      return;
    }

    this.recordEvent(ObservationEventType.FILE_WRITE, EventSeverity.INFO, filePath, 'file write observed', {
      path: filePath,
    });
  }

  /**
   * Close the session and compile every recorded {@link ObservationEvent} into a final
   * {@link ExecutionMonitorResult}. `passed` is false when any CRITICAL or HALT event was
   * recorded during the session — a clean exit code alone does not make a run passed if it
   * wrote or deleted files outside its allowed scope.
   */
  finish(exitCode: number): ExecutionMonitorResult {
    const durationMs = this.started ? Date.now() - this.startedAt : 0;

    this.recordEvent(
      ObservationEventType.PROCESS_EXIT,
      EventSeverity.INFO,
      null,
      `process exited with code ${exitCode}`,
      { exitCode }
    );

    const violations = this.events.filter(
      (e) => e.severity === EventSeverity.CRITICAL || e.severity === EventSeverity.HALT
    );

    const result: ExecutionMonitorResult = {
      promptId: this.promptId,
      outOfScopeWrites: [...new Set(this.outOfScopeWrites)],
      unexpectedDeletions: [...new Set(this.unexpectedDeletions)],
      commandsExecuted: [...this.commandsExecuted],
      stdoutChunks: this.stdoutChunkCount,
      exitCode,
      durationMs,
      passed: violations.length === 0,
      violations,
    };

    this.started = false;
    return result;
  }

  /** All events recorded so far this session (for a caller that wants the live stream, not just the final result). */
  getEvents(): readonly ObservationEvent[] {
    return this.events;
  }

  // -- internals -------------------------------------------------------------

  private isWithinScope(candidatePath: string): boolean {
    const normalized = normalizeForCompare(candidatePath);
    return normalized === this.normalizedProjectPath || normalized.startsWith(`${this.normalizedProjectPath}/`);
  }

  private scanForPaths(chunk: string, pattern: RegExp, kind: 'write' | 'delete'): void {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(chunk)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      if (!isAbsoluteLike(raw)) continue; // relative paths resolve under projectPath (the cwd)
      if (this.isWithinScope(raw)) continue;

      if (kind === 'write') {
        this.outOfScopeWrites.push(raw);
        this.recordEvent(
          ObservationEventType.FILE_WRITE,
          EventSeverity.CRITICAL,
          raw,
          `stdout narrated a write outside the allowed project scope (${this.projectPath}): ${raw}`,
          { path: raw }
        );
      } else {
        this.unexpectedDeletions.push(raw);
        this.recordEvent(
          ObservationEventType.FILE_DELETE,
          EventSeverity.CRITICAL,
          raw,
          `stdout narrated a delete outside the allowed project scope (${this.projectPath}): ${raw}`,
          { path: raw }
        );
      }
    }
  }

  private recordEvent(
    eventType: ObservationEventType,
    severity: EventSeverity,
    artifact: string | null,
    description: string,
    rawData: Record<string, unknown> = {}
  ): ObservationEvent {
    const event: ObservationEvent = {
      id: randomUUID(),
      buildRunId: this.buildRunId,
      promptId: this.promptId,
      promptIndex: this.promptIndex,
      eventType,
      severity,
      artifact,
      description,
      rawData,
      timestamp: new Date().toISOString(),
    };
    this.events.push(event);
    return event;
  }
}

/** Factory for a fresh {@link ExecutionMonitor} (mirrors the injectable-collaborator house style). */
export function createExecutionMonitor(): ExecutionMonitor {
  return new ExecutionMonitor();
}

/**
 * Cross-module registry of live monitors keyed by `buildRunId`, so any Sentinel Prime component
 * (the future GovernanceEnforcer, the confidence scorer, a CLI status command, ...) can reach
 * the monitor for an in-flight build without threading it through every call site. Callers that
 * create a monitor here are responsible for deleting the entry once `finish()` has been called
 * for the build's final prompt.
 */
export const executionMonitorSingleton: Map<string, ExecutionMonitor> = new Map();

export default ExecutionMonitor;
