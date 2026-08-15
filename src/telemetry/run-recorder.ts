/**
 * FORGE 2.0 — Control Plane run telemetry (`.forge/runs/<run-id>/*.jsonl`).
 *
 * `upgrades/CAPABILITIES_MEMO.md`'s observability section ("Live Build Observability" / "FORGE
 * Observability and Run Telemetry") asks for a structured, file-backed record of a build
 * alongside the live terminal output the operator already watches — "a live command center, not
 * log files." `RunRecorder` is that record: one directory per build run
 * (`.forge/runs/<build-run-id-or-timestamp>/`), five artifacts:
 *
 *   - events.jsonl    — every `renderProgress()` line `phase3-executor.ts` already prints to the
 *                        terminal, mirrored verbatim in call order (never a second, drifting
 *                        notion of "what happened" — see `recordEvent`/the `renderProgress` call
 *                        site in `phase3-executor.ts`).
 *   - prompts.jsonl    — per-prompt start/end + each Sentinel gate check, built from the SAME data
 *                        already computed for that prompt's `prompt_executions` Build Memory row
 *                        at that call site (a stream, never a re-query/duplicate of Build Memory).
 *   - tests.jsonl      — one line per `test_run_results` row, forwarded from
 *                        `src/testing/runners/persist.ts`'s `persistRunnerOutcome` — the single
 *                        Build Memory write point for test results — as it writes.
 *   - failures.jsonl   — one line per non-`completed` prompt disposition (Sentinel FAIL, claude
 *                        non-zero exit/timeout, Sentinel Prime forced halt).
 *   - metrics.json     — one JSON object (overwritten, not appended) with the run's summary
 *                        counts, written once at build end.
 *   - final-report.md  — Phase 5's own human-readable summary report (`buildSummaryReport`),
 *                        reused verbatim, written at Phase 5 end.
 *
 * Best-effort throughout (Iron Law 3 / Contract 4 posture every sibling collaborator in this
 * codebase already follows): a telemetry write failure is swallowed and never affects the build.
 * Never instantiated for a dry run — nothing executes, so there is nothing to record.
 *
 * ACTIVE-RECORDER AMBIENT: `phase3-executor.ts`'s `renderProgress` (a bare function, no `ctx`
 * parameter) and `persist.ts`'s `persistRunnerOutcome` (called from deep inside Sentinel /
 * TestOrchestrator, several layers removed from the executor's loop) both need to reach the
 * current build's recorder without threading a new parameter through every intervening
 * signature — the same ambient-singleton shape `forge-logger.ts`'s `setLogContext` and
 * `phase3-executor.ts`'s own `executionMonitorSingleton` already use for the identical problem.
 * `setActiveRunRecorder` is set at Phase 3 build start and cleared in the same `finally` that
 * restores stdout, so it never leaks into a later, unrelated build in the same process.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type RunEventLevel = 'INFO' | 'GATE' | 'PASS' | 'FAIL' | 'WARN' | 'ERROR';

export interface RunPromptStartInput {
  index: number;
  id: string;
  name: string;
  promptType: string;
}

export interface RunGateCheckInput {
  index: number;
  id: string;
  checkName: string;
  passed: boolean;
  skipped: boolean;
  detail: string | null;
}

export interface RunPromptEndInput {
  index: number;
  id: string;
  name: string;
  disposition: string;
  durationMs: number;
  commitHash: string | null;
  failedCheck: string | null;
}

export interface RunTestResultInput {
  id: string;
  runnerType: string;
  testSuite: string;
  status: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  promptId: string | null;
}

export interface RunMetrics {
  totalPrompts: number;
  completedPrompts: number;
  failedPrompts: number;
  skippedPrompts: number;
  totalTokens: number;
  status: string;
  halted: boolean;
  durationMs: number;
  generatedAt: string;
}

/**
 * Writes structured JSONL/JSON telemetry for one build run to `.forge/runs/<runId>/`, mirroring
 * (never replacing) the console output `renderProgress` already prints.
 */
export class RunRecorder {
  readonly runId: string;
  readonly dir: string;

  constructor(runId: string, projectPath: string) {
    this.runId = runId;
    this.dir = join(projectPath, '.forge', 'runs', runId);
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      /* best-effort — a telemetry directory failure must never block the build */
    }
  }

  private appendJsonl(fileName: string, obj: unknown): void {
    try {
      appendFileSync(join(this.dir, fileName), `${JSON.stringify(obj)}\n`, 'utf8');
    } catch {
      /* best-effort */
    }
  }

  /** Mirror one `renderProgress` console line to `events.jsonl` — every phase transition this
   *  build prints (pipeline start, prompt start, claude exec start/end, gate summary, Sentinel
   *  Prime confidence/halt, prompt end, pipeline end) lands here, verbatim, in call order. */
  recordEvent(level: RunEventLevel, message: string): void {
    this.appendJsonl('events.jsonl', { ts: new Date().toISOString(), level, message });
  }

  recordPromptStart(input: RunPromptStartInput): void {
    this.appendJsonl('prompts.jsonl', { ts: new Date().toISOString(), event: 'start', ...input });
  }

  recordGateCheck(input: RunGateCheckInput): void {
    this.appendJsonl('prompts.jsonl', { ts: new Date().toISOString(), event: 'gate', ...input });
  }

  recordPromptEnd(input: RunPromptEndInput): void {
    this.appendJsonl('prompts.jsonl', { ts: new Date().toISOString(), event: 'end', ...input });
    if (input.disposition !== 'completed') {
      this.appendJsonl('failures.jsonl', { ts: new Date().toISOString(), ...input });
    }
  }

  /** One line per `test_run_results` row, forwarded from `persistRunnerOutcome` as it writes —
   *  reuses the already-built row rather than re-querying Build Memory. */
  recordTestResult(result: RunTestResultInput): void {
    this.appendJsonl('tests.jsonl', { ts: new Date().toISOString(), ...result });
  }

  /** Overwrites (not appends) `metrics.json` with the run's final summary counts — called once
   *  at build end, so a reader always sees the finished state, not a half-written stream. */
  writeMetrics(metrics: RunMetrics): void {
    try {
      writeFileSync(join(this.dir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');
    } catch {
      /* best-effort */
    }
  }

  /** Writes `final-report.md` — Phase 5's own human-readable summary report, reused verbatim
   *  (never a second, drifting summary format). */
  writeFinalReport(markdown: string): void {
    try {
      writeFileSync(join(this.dir, 'final-report.md'), markdown, 'utf8');
    } catch {
      /* best-effort */
    }
  }
}

let activeRunRecorder: RunRecorder | null = null;

/** Set (or clear, with `null`) the recorder for the build currently in Phase 3's loop. */
export function setActiveRunRecorder(recorder: RunRecorder | null): void {
  activeRunRecorder = recorder;
}

/** The current build's recorder, or `null` outside of a live Phase 3 run (dry run, no active
 *  build, or a caller outside the executor's lifetime — e.g. a standalone test run). */
export function getActiveRunRecorder(): RunRecorder | null {
  return activeRunRecorder;
}
