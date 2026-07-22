/**
 * FORGE 2.0 — Autonomy: BuildHealthMonitor.
 *
 * A running build has no single signal that says "something is quietly going wrong" — Sentinel
 * (Contract 13) and Sentinel Prime (System 5) both judge ONE prompt at a time. Neither one notices
 * a build that is repeatedly limping through recovery, whose Sentinel Prime confidence is
 * trending down prompt over prompt, or whose Node process is slowly leaking memory across a long
 * multi-hour run. BuildHealthMonitor is a THIRD, build-wide layer sitting above both: it tracks
 * consecutive failures, a rolling confidence average, and process memory across the whole run, and
 * can pause the build (not halt it — Contract 13/Sentinel Prime already own the halt decision) to
 * let a human or a cooldown window intervene before a struggling build burns through its remaining
 * prompts on a foundation that is already failing.
 *
 * NON-FATAL house style, matching every other `src/autonomy/` module (see
 * `src/autonomy/supabase-migrator.ts`): every write here (the health-report JSON, the interval
 * timer) is best-effort — a health-report write failure or a memory-read failure never throws out
 * to the caller, and never blocks or fails the build. BuildHealthMonitor OBSERVES; it does not gate
 * (Contract 13's five checks and Sentinel Prime's `HaltDecision` remain the only things that can
 * actually halt a build). `shouldPause()` is the one method with a side effect beyond bookkeeping:
 * on a CRITICAL read it writes a health report, logs the pause, and waits out a cooldown window
 * in-process before returning — the caller does not need to implement the wait itself.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Coarse health tier, cheapest-to-read-first summary of {@link BuildHealth}. */
export type BuildHealthStatus = 'healthy' | 'degraded' | 'critical';

/** A point-in-time snapshot of a running build's health. */
export interface BuildHealth {
  /** `critical` > `degraded` > `healthy` — see {@link BuildHealthMonitor.getHealth} for thresholds. */
  status: BuildHealthStatus;
  /** Consecutive Sentinel-failed prompts (reset to 0 by the next passing prompt). */
  consecutiveFailures: number;
  /** Rolling average of the last (up to) 10 recorded confidence scores, 0–1. */
  averageConfidence: number;
  /** Current Node process memory usage (RSS), in megabytes. */
  memoryUsageMb: number;
  /** Wall-clock minutes since {@link BuildHealthMonitor.start} was called. */
  runtimeMinutes: number;
  /** Prompts recorded via {@link BuildHealthMonitor.recordPromptResult} so far. */
  promptsCompleted: number;
  /** `totalPrompts` (from `start`) minus `promptsCompleted`, floored at 0. */
  promptsRemaining: number;
  /**
   * Projected additional minutes to finish the remaining prompts, extrapolated from this build's
   * own observed average minutes-per-prompt so far. `0` before the first prompt is recorded (no
   * rate to extrapolate from yet).
   */
  estimatedCompletionMinutes: number;
  /** Human-readable reasons behind the current `status` — empty when `status === 'healthy'`. */
  alerts: string[];
}

/** Thresholds a CRITICAL read must clear ANY of. */
const CRITICAL_CONSECUTIVE_FAILURES = 3;
const CRITICAL_MIN_AVERAGE_CONFIDENCE = 0.3;
const CRITICAL_MAX_MEMORY_MB = 6000;

/** Thresholds a DEGRADED read must clear ANY of (checked only once CRITICAL has been ruled out). */
const DEGRADED_CONSECUTIVE_FAILURES = 1;
const DEGRADED_MIN_AVERAGE_CONFIDENCE = 0.5;
const DEGRADED_MAX_MEMORY_MB = 4000;

/** How many of the most recent confidence scores feed the rolling average. */
const CONFIDENCE_WINDOW = 10;

/** How often the background timer re-samples process memory, in ms. */
const MEMORY_CHECK_INTERVAL_MS = 60_000;

/** How long `shouldPause()` waits, once it decides to pause, before returning control. */
const PAUSE_COOLDOWN_MS = 2 * 60_000;

/**
 * Tracks a single build's health across its whole run and can pause execution on a CRITICAL read.
 * One instance per `runPhase3Executor` call — never shared across builds (its counters are
 * meaningless outside the run they were created for).
 */
export class BuildHealthMonitor {
  private readonly projectPath: string;
  private readonly log: (message: string) => void;

  private totalPrompts = 0;
  private promptsCompleted = 0;
  private consecutiveFailures = 0;
  private confidenceWindow: number[] = [];
  private memoryUsageMb = 0;
  private startedAtMs: number | null = null;
  private memoryIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(projectPath: string, log?: (message: string) => void) {
    this.projectPath = projectPath;
    this.log = log ?? ((message: string) => console.log(`[HEALTH MONITOR] ${message}`));
  }

  /**
   * Begin monitoring a build of `totalPrompts` prompts: resets all counters, records the start
   * time, and starts a 60-second interval that re-samples process memory (so `getHealth()`
   * between prompts — a long-running single prompt — still reflects a fresh reading, not a stale
   * one from the last recorded prompt). Calling `start()` again (e.g. a test re-using one
   * instance) restarts cleanly — the previous interval, if any, is cleared first.
   */
  start(totalPrompts: number): void {
    this.stopMemoryInterval();
    this.totalPrompts = Math.max(0, totalPrompts);
    this.promptsCompleted = 0;
    this.consecutiveFailures = 0;
    this.confidenceWindow = [];
    this.startedAtMs = Date.now();
    this.started = true;
    this.sampleMemory();
    this.memoryIntervalHandle = setInterval(() => this.sampleMemory(), MEMORY_CHECK_INTERVAL_MS);
    // A timer with no other work pending must never keep the Node process alive on its own.
    this.memoryIntervalHandle?.unref?.();
    this.log(`monitoring started — ${this.totalPrompts} prompt(s), sampling memory every 60s.`);
  }

  /** Read current process memory (RSS, MB). Never throws — a failed read leaves the last value. */
  private sampleMemory(): void {
    try {
      this.memoryUsageMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
    } catch {
      /* best-effort — a failed memory read just means the last known value is kept */
    }
  }

  private stopMemoryInterval(): void {
    if (this.memoryIntervalHandle !== null) {
      clearInterval(this.memoryIntervalHandle);
      this.memoryIntervalHandle = null;
    }
  }

  /**
   * Record the outcome of one completed prompt: `passed` resets the consecutive-failure counter
   * to 0, a failure increments it; `confidenceScore` (0–1 — Sentinel Prime's composite confidence
   * is the natural source, but a plain 0/1 pass/fail proxy is a legitimate fallback when Sentinel
   * Prime did not run for this prompt) feeds the rolling 10-prompt average. Also re-samples memory,
   * so a burst of many fast prompts between 60-second ticks still gets a fresh reading recorded
   * against each one.
   */
  recordPromptResult(passed: boolean, confidenceScore: number): void {
    if (!this.started) {
      // A monitor that was never start()-ed still tracks state sensibly rather than throwing —
      // this class observes, it never gates, so a missed start() must not break the build.
      this.startedAtMs = Date.now();
      this.started = true;
    }
    this.promptsCompleted += 1;
    this.consecutiveFailures = passed ? 0 : this.consecutiveFailures + 1;
    const clamped = Number.isFinite(confidenceScore) ? Math.min(1, Math.max(0, confidenceScore)) : 0;
    this.confidenceWindow.push(clamped);
    if (this.confidenceWindow.length > CONFIDENCE_WINDOW) {
      this.confidenceWindow = this.confidenceWindow.slice(-CONFIDENCE_WINDOW);
    }
    this.sampleMemory();
  }

  private averageConfidence(): number {
    if (this.confidenceWindow.length === 0) return 1; // no data yet — assume healthy, not alarming
    const sum = this.confidenceWindow.reduce((a, b) => a + b, 0);
    return Math.round((sum / this.confidenceWindow.length) * 1000) / 1000;
  }

  /**
   * Average of the last `n` recorded confidence scores (default 5) — a shorter, independent window
   * from the 10-prompt one {@link getHealth} uses for its own status tiers. Used by Sentinel Prime's
   * DecisionValidator confidence gate to decide whether a build has been consistently confident
   * enough recently to skip the expensive critic pass. Returns `1` (assume healthy) when no
   * confidence scores have been recorded yet, matching {@link averageConfidence}'s no-data default.
   */
  getRecentAverageConfidence(n = 5): number {
    if (this.confidenceWindow.length === 0) return 1;
    const recent = this.confidenceWindow.slice(-n);
    const sum = recent.reduce((a, b) => a + b, 0);
    return Math.round((sum / recent.length) * 1000) / 1000;
  }

  private runtimeMinutes(): number {
    if (this.startedAtMs === null) return 0;
    return Math.round(((Date.now() - this.startedAtMs) / 60_000) * 100) / 100;
  }

  private estimatedCompletionMinutes(): number {
    const remaining = Math.max(0, this.totalPrompts - this.promptsCompleted);
    if (remaining === 0 || this.promptsCompleted === 0) return 0;
    const minutesPerPrompt = this.runtimeMinutes() / this.promptsCompleted;
    return Math.round(minutesPerPrompt * remaining * 100) / 100;
  }

  /**
   * Compute the current {@link BuildHealth} snapshot. Pure read — no side effects, safe to call as
   * often as desired (e.g. after every `recordPromptResult`, or on a dashboard poll).
   *
   * `critical` wins over `degraded` wins over `healthy`; within a tier, ANY one of that tier's
   * three conditions is sufficient (they are not required jointly):
   *   - CRITICAL: consecutiveFailures >= 3, OR averageConfidence < 0.3, OR memoryUsageMb > 6000.
   *   - DEGRADED: consecutiveFailures >= 1, OR averageConfidence < 0.5, OR memoryUsageMb > 4000.
   */
  getHealth(): BuildHealth {
    const averageConfidence = this.averageConfidence();
    const alerts: string[] = [];

    const criticalReasons: string[] = [];
    if (this.consecutiveFailures >= CRITICAL_CONSECUTIVE_FAILURES) {
      criticalReasons.push(`${this.consecutiveFailures} consecutive prompt failures (>= ${CRITICAL_CONSECUTIVE_FAILURES})`);
    }
    if (averageConfidence < CRITICAL_MIN_AVERAGE_CONFIDENCE) {
      criticalReasons.push(`average confidence ${averageConfidence.toFixed(2)} below ${CRITICAL_MIN_AVERAGE_CONFIDENCE}`);
    }
    if (this.memoryUsageMb > CRITICAL_MAX_MEMORY_MB) {
      criticalReasons.push(`memory usage ${this.memoryUsageMb}MB above ${CRITICAL_MAX_MEMORY_MB}MB`);
    }

    const degradedReasons: string[] = [];
    if (this.consecutiveFailures >= DEGRADED_CONSECUTIVE_FAILURES) {
      degradedReasons.push(`${this.consecutiveFailures} consecutive prompt failure(s) (>= ${DEGRADED_CONSECUTIVE_FAILURES})`);
    }
    if (averageConfidence < DEGRADED_MIN_AVERAGE_CONFIDENCE) {
      degradedReasons.push(`average confidence ${averageConfidence.toFixed(2)} below ${DEGRADED_MIN_AVERAGE_CONFIDENCE}`);
    }
    if (this.memoryUsageMb > DEGRADED_MAX_MEMORY_MB) {
      degradedReasons.push(`memory usage ${this.memoryUsageMb}MB above ${DEGRADED_MAX_MEMORY_MB}MB`);
    }

    let status: BuildHealthStatus;
    if (criticalReasons.length > 0) {
      status = 'critical';
      alerts.push(...criticalReasons);
    } else if (degradedReasons.length > 0) {
      status = 'degraded';
      alerts.push(...degradedReasons);
    } else {
      status = 'healthy';
    }

    return {
      status,
      consecutiveFailures: this.consecutiveFailures,
      averageConfidence,
      memoryUsageMb: this.memoryUsageMb,
      runtimeMinutes: this.runtimeMinutes(),
      promptsCompleted: this.promptsCompleted,
      promptsRemaining: Math.max(0, this.totalPrompts - this.promptsCompleted),
      estimatedCompletionMinutes: this.estimatedCompletionMinutes(),
      alerts,
    };
  }

  /**
   * On a CRITICAL read: write a health report to `.forge/health-{timestamp}.json`, log
   * `[HEALTH MONITOR] BUILD PAUSED`, wait out a 2-minute cooldown in-process, log the resume, then
   * return `true`. On anything else, returns `false` immediately with no side effects. The caller
   * (`runPhase3Executor`'s main loop) needs no extra branching — the pause, if any, already
   * happened by the time this resolves; the loop simply continues to the next prompt either way.
   */
  async shouldPause(): Promise<boolean> {
    const health = this.getHealth();
    if (health.status !== 'critical') return false;

    this.writeHealthReport(health);
    this.log(
      `[HEALTH MONITOR] BUILD PAUSED — ${health.alerts.join('; ')} — cooling down ` +
        `${Math.round(PAUSE_COOLDOWN_MS / 60_000)} minute(s) before resuming.`
    );
    await sleep(PAUSE_COOLDOWN_MS);
    this.log('[HEALTH MONITOR] cooldown elapsed — resuming build.');
    return true;
  }

  /** Best-effort write of `<projectPath>/.forge/health-{timestamp}.json`. Never throws. */
  private writeHealthReport(health: BuildHealth): void {
    try {
      const dir = join(this.projectPath, '.forge');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const path = join(dir, `health-${Date.now()}.json`);
      writeFileSync(path, JSON.stringify(health, null, 2), 'utf8');
      this.log(`health report written to ${path}`);
    } catch (error) {
      this.log(`health report write failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Stop monitoring (clears the memory-sampling interval) and return the final
   * {@link BuildHealth} snapshot for this run. Safe to call even if `start()` was never called.
   */
  stop(): BuildHealth {
    this.stopMemoryInterval();
    const finalHealth = this.getHealth();
    this.log(
      `monitoring stopped — ${finalHealth.promptsCompleted}/${this.totalPrompts} prompt(s), ` +
        `final status ${finalHealth.status}, ${finalHealth.runtimeMinutes}m runtime.`
    );
    this.started = false;
    return finalHealth;
  }
}

/** Promise-based sleep, isolated so tests can stub it independently of real wall-clock time. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Convenience factory, matching the `create*` naming convention used across `src/autonomy/`. */
export function createBuildHealthMonitor(projectPath: string, log?: (message: string) => void): BuildHealthMonitor {
  return new BuildHealthMonitor(projectPath, log);
}
