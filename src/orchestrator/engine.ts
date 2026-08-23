/**
 * FORGE 2.0 — Native Orchestrator — OrchestratorEngine.
 *
 * The master loop that replaces `forge-orchestrator.ps1` (Layer 2 of the three-layer
 * architecture described in the "UPGRADES TO FORGE FROM 2.0 TO 3.0" instructional doc):
 * given a project name it loads that project's `library-manifest.yaml`
 * (`<libraryPath>/<project>/library-manifest.yaml`), resolves the dependency-ordered
 * frontier of runnable queues via {@link ManifestResolver}, runs each one to completion
 * via {@link QueueRunner}, and keeps looping until nothing more can run — either because
 * every queue reached a terminal state or because a failure severed the remaining chain.
 *
 * This module makes ALL of the sequencing decisions (what runs next, what gets skipped,
 * when the run is over); it delegates every other concern:
 *   - manifest load/validate/persist/dependency-resolution → {@link ManifestResolver}
 *   - governance sync + staging + spawning `forge build` + Sentinel Prime readback →
 *     {@link QueueRunner}
 *
 * NEVER FABRICATES A RESULT (Iron Law 3): a queue's `success` is exactly what
 * {@link QueueRunner.run} reported, and the engine's own {@link OrchestratorResult}
 * counters are derived from the SAME transitions the manifest file records — there is no
 * second, independent "did it work" computation anywhere in this file.
 *
 * Per BEHAVIORAL_CONTRACTS.md Contract 4, the `orchestrator_manifests` Build Memory row
 * this engine opens/closes is a best-effort mirror — a Build Memory failure never halts
 * or fails a run. The on-disk manifest (via `ManifestResolver.save`) is the only source
 * of truth the next run reads from.
 */

import { join } from 'node:path';

import { getClient, logMemoryWarning, newId, nowIso } from '../memory/client.js';
import { createManifestResolver, ManifestResolver } from './manifest-resolver.js';
import { createQueueRunner, QueueRunner, type QueueRunResult } from './queue-runner.js';
import {
  ManifestStatus,
  QueueStatus,
  type LibraryManifest,
  type OrchestratorOptions,
  type OrchestratorResult,
  type QueueEntry,
  type QueueTransitionEvent,
} from './types.js';

function twoDigit(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `[yyyy-MM-dd HH:mm:ss] [LEVEL] message`, matching {@link QueueRunner}'s and Phase 3's
 * `renderProgress` format exactly — orchestrator-loop output must be visually
 * indistinguishable in shape from the queue-level output it wraps.
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

export class OrchestratorEngine {
  constructor(
    private readonly manifestResolver: ManifestResolver = createManifestResolver(),
    private readonly queueRunner: QueueRunner = createQueueRunner()
  ) {}

  /**
   * Run a project's full manifest to completion (or as far as it can go). See the module
   * doc for the delegation model. This is the only public entry point on the class.
   */
  async run(options: OrchestratorOptions): Promise<OrchestratorResult> {
    const startedAt = nowIso();
    const runStart = Date.now();
    const manifestPath = this.resolveManifestPath(options);

    renderProgress('INFO', `[ORCHESTRATOR] ==== FORGE NATIVE ORCHESTRATOR — project: ${options.project} ====`);

    // Step 1 — load + validate the manifest, then open the Build Memory tracking row.
    const manifest = this.manifestResolver.load(manifestPath);
    this.manifestResolver.validateNoCycles(manifest);
    renderProgress(
      'INFO',
      `[ORCHESTRATOR] loaded manifest "${manifestPath}" — ${manifest.queues.length} queue(s), version ${manifest.version}`
    );
    const manifestRowId = this.insertManifestRunningRow(manifest, manifestPath);

    // Carry the manifest's optional budget cap into every queue run this orchestrator invocation
    // spawns (QueueRunner -> `forge build --max-budget-usd`) — absent/null when the manifest
    // declares none, which keeps every existing manifest.yaml running with no cap, unchanged.
    if (manifest.maxBudgetUsd !== undefined && manifest.maxBudgetUsd !== null) {
      options = { ...options, maxBudgetUsd: manifest.maxBudgetUsd };
      renderProgress('INFO', `[ORCHESTRATOR] manifest maxBudgetUsd cap: $${manifest.maxBudgetUsd.toFixed(2)} per queue run`);
    }

    // Same carry-through for the opt-in ephemeral-preview step (QueueRunner -> `forge build
    // --preview-environments`) — absent/false keeps every existing manifest.yaml running with no
    // preview step, unchanged.
    if (manifest.previewEnvironments === true) {
      options = { ...options, previewEnvironments: true };
      renderProgress('INFO', '[ORCHESTRATOR] manifest previewEnvironments: true — ephemeral preview step enabled per queue run');
    }

    let queuesRun = 0;
    let queuesComplete = 0;
    let queuesFailed = 0;
    let lastQueueId: string | null = null;

    try {
      // Step 2 — dry run: print the full plan and return without touching any queue status.
      if (options.dryRun) {
        this.printExecutionPlan(manifest);
        this.finalizeManifestRow(manifestRowId, ManifestStatus.IDLE, 0, 0);
        return {
          manifestId: manifestRowId ?? manifest.project,
          project: manifest.project,
          queuesRun: 0,
          queuesComplete: 0,
          queuesFailed: 0,
          totalDurationMs: Date.now() - runStart,
          startedAt,
          completedAt: nowIso(),
        };
      }

      // Step 3 — `--only` is validated up front so a typo fails loudly before anything runs,
      // rather than the loop silently finding zero runnable queues and exiting immediately.
      if (options.only && !manifest.queues.some((q) => q.id === options.only)) {
        throw new Error(
          `OrchestratorEngine.run: --only target "${options.only}" not found in manifest "${manifest.project}"`
        );
      }

      // Step 4 — `--skipTo`: mark every queue before the target as SKIPPED.
      if (options.skipTo) {
        this.applySkipTo(manifest, options.skipTo, manifestPath);
      }

      // Step 5 — the main loop.
      for (;;) {
        const runnable = this.getNextRunnable(manifest, options);
        if (runnable.length === 0) break;

        const next = runnable[0]!;

        if (options.resetStatus && next.status !== QueueStatus.PENDING) {
          next.status = QueueStatus.PENDING;
          next.error = null;
          next.startedAt = null;
          next.completedAt = null;
          this.manifestResolver.save(manifestPath, manifest);
          renderProgress('INFO', `[ORCHESTRATOR] --resetStatus: "${next.id}" reset to PENDING before running`);
        }

        renderProgress('INFO', `[ORCHESTRATOR] QUEUE START: ${next.id} (priority ${next.priority})`);
        this.manifestResolver.markRunning(manifest, next.id, manifestPath);

        const queueStart = Date.now();
        // eslint-disable-next-line no-await-in-loop -- queues execute strictly sequentially by design.
        const runResult = await this.queueRunner.run(next, options);
        const durationMs = Date.now() - queueStart;
        queuesRun++;

        if (runResult.success) {
          this.manifestResolver.markComplete(manifest, next.id, manifestPath);
          queuesComplete++;
          renderProgress('INFO', `[ORCHESTRATOR] QUEUE COMPLETE: ${next.id} (${durationMs}ms)`);
          this.emitTransition(lastQueueId, next, `queue "${next.id}" completed successfully`, runResult);
        } else {
          const errorMessage = runResult.error ?? 'unknown error';
          this.manifestResolver.markFailed(manifest, next.id, errorMessage, manifestPath);
          queuesFailed++;
          renderProgress('ERROR', `[ORCHESTRATOR] QUEUE FAILED: ${next.id} — ${errorMessage}`);
          this.emitTransition(lastQueueId, next, `queue "${next.id}" failed — ${errorMessage}`, runResult);
          this.skipDependentsOf(manifest, next.id, manifestPath);
        }

        lastQueueId = next.id;

        // `--only` runs exactly the one requested queue, dependency graph or not — it must
        // not fall through into running whatever else happens to be runnable afterward.
        if (options.only) break;
      }

      // Step 6 — anything still PENDING is blocked; report why so the operator (or the next
      // `--skipTo`/`--resetStatus` run) knows exactly what to do next.
      this.logBlockedQueues(manifest);

      // Step 7 — close out the Build Memory row and return the final result.
      const finalStatus = queuesFailed > 0 ? ManifestStatus.FAILED : ManifestStatus.COMPLETE;
      this.finalizeManifestRow(manifestRowId, finalStatus, queuesComplete, queuesFailed);

      const totalDurationMs = Date.now() - runStart;
      renderProgress(
        finalStatus === ManifestStatus.FAILED ? 'ERROR' : 'INFO',
        `[ORCHESTRATOR] ==== RUN ${finalStatus}: ${manifest.project} — ${queuesComplete}/${manifest.queues.length} complete, ${queuesFailed} failed, ${totalDurationMs}ms ====`
      );

      return {
        manifestId: manifestRowId ?? manifest.project,
        project: manifest.project,
        queuesRun,
        queuesComplete,
        queuesFailed,
        totalDurationMs,
        startedAt,
        completedAt: nowIso(),
      };
    } catch (error) {
      if (this.isOutOfMemoryError(error)) {
        return this.handleOutOfMemory(
          error,
          manifest,
          manifestPath,
          manifestRowId,
          lastQueueId,
          startedAt,
          runStart,
          queuesRun,
          queuesComplete,
          queuesFailed
        );
      }
      // A genuine (non-OOM) failure must propagate — never swallow a real bug behind a
      // fabricated "it worked" result (Iron Law 3). Still close the Build Memory row honestly.
      this.finalizeManifestRow(manifestRowId, ManifestStatus.FAILED, queuesComplete, queuesFailed);
      throw error;
    }
  }

  /** `<libraryPath>/<project>/library-manifest.yaml` — the FORGE 1.0 library layout. */
  private resolveManifestPath(options: OrchestratorOptions): string {
    return join(options.libraryPath, options.project, 'library-manifest.yaml');
  }

  /**
   * The next batch of runnable queues, in priority order. `--only` bypasses dependency
   * resolution entirely and returns just the one requested queue (if it is still PENDING) —
   * per the task contract, "skip dependency check" for that queue.
   */
  private getNextRunnable(manifest: LibraryManifest, options: OrchestratorOptions): QueueEntry[] {
    if (options.only) {
      return manifest.queues.filter((q) => q.id === options.only && q.status === QueueStatus.PENDING);
    }
    return this.manifestResolver.getRunnable(manifest);
  }

  /**
   * Mark every PENDING queue whose (transitive) dependency chain includes `failedQueueId` as
   * SKIPPED, so a downstream queue never silently "runs" against a broken upstream build.
   */
  private skipDependentsOf(manifest: LibraryManifest, failedQueueId: string, manifestPath: string): void {
    const dependents = this.findAllDependents(manifest, failedQueueId).filter(
      (entry) => entry.status === QueueStatus.PENDING
    );
    if (dependents.length === 0) return;

    for (const dependent of dependents) {
      dependent.status = QueueStatus.SKIPPED;
      dependent.error = `skipped — upstream dependency "${failedQueueId}" failed`;
      renderProgress(
        'WARN',
        `[ORCHESTRATOR] QUEUE SKIPPED: ${dependent.id} — upstream dependency "${failedQueueId}" failed`
      );
    }
    this.manifestResolver.save(manifestPath, manifest);
  }

  /** Every queue (direct or transitive) that depends on `queueId`, via BFS over `dependsOn`. */
  private findAllDependents(manifest: LibraryManifest, queueId: string): QueueEntry[] {
    const dependents: QueueEntry[] = [];
    const visited = new Set<string>();
    const frontier: string[] = [queueId];

    while (frontier.length > 0) {
      const current = frontier.shift()!;
      for (const entry of manifest.queues) {
        if (visited.has(entry.id)) continue;
        if (entry.dependsOn.includes(current)) {
          visited.add(entry.id);
          dependents.push(entry);
          frontier.push(entry.id);
        }
      }
    }

    return dependents;
  }

  /**
   * Mark every queue BEFORE `skipToId` (in manifest array order) that is still PENDING as
   * SKIPPED, so a resumed run picks up exactly at the requested queue instead of re-running
   * everything that already happened in a prior session.
   */
  private applySkipTo(manifest: LibraryManifest, skipToId: string, manifestPath: string): void {
    const targetIndex = manifest.queues.findIndex((q) => q.id === skipToId);
    if (targetIndex === -1) {
      throw new Error(
        `OrchestratorEngine.run: --skipTo target "${skipToId}" not found in manifest "${manifest.project}"`
      );
    }

    let skippedCount = 0;
    for (let i = 0; i < targetIndex; i++) {
      const entry = manifest.queues[i]!;
      if (entry.status === QueueStatus.PENDING) {
        entry.status = QueueStatus.SKIPPED;
        entry.error = `skipped — before --skipTo target "${skipToId}"`;
        skippedCount++;
        renderProgress('INFO', `[ORCHESTRATOR] SKIPPED (via --skipTo ${skipToId}): ${entry.id}`);
      }
    }

    if (skippedCount > 0) {
      this.manifestResolver.save(manifestPath, manifest);
    }
    renderProgress('INFO', `[ORCHESTRATOR] --skipTo ${skipToId}: ${skippedCount} queue(s) marked SKIPPED`);
  }

  /**
   * After the loop exits with nothing runnable, any queue still PENDING is blocked — report
   * which unmet (or non-COMPLETE) dependency is holding it back rather than leaving the
   * operator to guess why the run "just stopped."
   */
  private logBlockedQueues(manifest: LibraryManifest): void {
    const byId = new Map(manifest.queues.map((q) => [q.id, q]));
    const blocked = manifest.queues.filter((q) => q.status === QueueStatus.PENDING);

    for (const entry of blocked) {
      const unmet = entry.dependsOn.filter((depId) => byId.get(depId)?.status !== QueueStatus.COMPLETE);
      const reason =
        unmet.length > 0
          ? `waiting on: ${unmet.map((depId) => `${depId} (${byId.get(depId)?.status ?? 'missing'})`).join(', ')}`
          : 'no unmet dependency found — check --only/--skipTo filters';
      renderProgress('WARN', `[ORCHESTRATOR] QUEUE BLOCKED: ${entry.id} — ${reason}`);
    }
  }

  /**
   * Print the full execution plan for a `--dryRun` invocation: simulated run order (dependency-
   * resolved, priority-sorted, exactly as the real loop would pick them), each queue's current
   * status/dependencies/estimate, and manifest-wide totals. Never mutates the manifest.
   */
  private printExecutionPlan(manifest: LibraryManifest): void {
    renderProgress('INFO', `[ORCHESTRATOR] ==== DRY RUN — EXECUTION PLAN: ${manifest.project} ====`);

    const order = this.computeSimulatedOrder(manifest);
    let totalHours = 0;
    order.forEach((entry, index) => {
      totalHours += entry.estimatedHours;
      const deps = entry.dependsOn.length > 0 ? entry.dependsOn.join(', ') : '(none)';
      renderProgress(
        'INFO',
        `[ORCHESTRATOR]   ${index + 1}. [${entry.status}] ${entry.id} — priority ${entry.priority}, depends on: ${deps}, est ${entry.estimatedHours}h — ${entry.description}`
      );
    });

    const countByStatus = (status: QueueStatus): number => manifest.queues.filter((q) => q.status === status).length;
    renderProgress(
      'INFO',
      `[ORCHESTRATOR] Total queues: ${manifest.queues.length} | pending: ${countByStatus(QueueStatus.PENDING)} | ` +
        `complete: ${countByStatus(QueueStatus.COMPLETE)} | failed: ${countByStatus(QueueStatus.FAILED)} | ` +
        `skipped: ${countByStatus(QueueStatus.SKIPPED)} | planned: ${countByStatus(QueueStatus.PLANNED)}`
    );
    renderProgress('INFO', `[ORCHESTRATOR] Total estimated hours (pending queues): ${totalHours}`);
    renderProgress('INFO', `[ORCHESTRATOR] ==== END EXECUTION PLAN — no queues were executed (--dryRun) ====`);
  }

  /**
   * Simulate the dependency-resolved run order without mutating the manifest: repeatedly take
   * every still-PENDING queue whose dependencies are already satisfied (starting from queues
   * already COMPLETE), sorted by priority — exactly {@link ManifestResolver.getRunnable}'s own
   * rule, applied iteratively. Queues that can never become runnable (e.g. depend on a FAILED
   * or PLANNED queue) are appended at the end, still visible in the plan rather than silently
   * dropped. Every other status (COMPLETE/FAILED/SKIPPED/PLANNED) is appended after the
   * simulated PENDING order so the plan reflects the full manifest, not just what's left to do.
   */
  private computeSimulatedOrder(manifest: LibraryManifest): QueueEntry[] {
    const byId = new Map(manifest.queues.map((q) => [q.id, q]));
    const satisfied = new Set(manifest.queues.filter((q) => q.status === QueueStatus.COMPLETE).map((q) => q.id));
    const remaining = new Set(manifest.queues.filter((q) => q.status === QueueStatus.PENDING).map((q) => q.id));
    const order: QueueEntry[] = [];

    while (remaining.size > 0) {
      const runnableNow = [...remaining]
        .map((id) => byId.get(id)!)
        .filter((entry) => entry.dependsOn.every((depId) => satisfied.has(depId)))
        .sort((a, b) => a.priority - b.priority);

      if (runnableNow.length === 0) break; // remaining entries are permanently blocked

      for (const entry of runnableNow) {
        order.push(entry);
        satisfied.add(entry.id);
        remaining.delete(entry.id);
      }
    }

    // Whatever is left in `remaining` never became runnable — surface it anyway, unordered.
    for (const id of remaining) {
      order.push(byId.get(id)!);
    }

    const orderedIds = new Set(order.map((entry) => entry.id));
    for (const entry of manifest.queues) {
      if (!orderedIds.has(entry.id)) order.push(entry);
    }

    return order;
  }

  /**
   * Build and log a {@link QueueTransitionEvent} for one queue's outcome. `sentinelPassed`/
   * `confidenceScore` come straight from the Sentinel Prime checkpoint {@link QueueRunner}
   * read back, when one is present; otherwise they degrade to the plain process-exit signal
   * (Contract 4 — a missing checkpoint is not itself a failure).
   */
  private emitTransition(
    fromQueueId: string | null,
    entry: QueueEntry,
    reason: string,
    runResult: QueueRunResult
  ): void {
    const event: QueueTransitionEvent = {
      fromQueueId,
      toQueueId: entry.id,
      reason,
      sentinelPassed: runResult.sentinelResult ? !runResult.sentinelResult.haltDecision.shouldHalt : runResult.success,
      confidenceScore: runResult.sentinelResult?.confidenceScore.composite ?? (runResult.success ? 1 : 0),
    };
    renderProgress(
      'INFO',
      `[ORCHESTRATOR] TRANSITION: ${event.fromQueueId ?? '(start)'} -> ${event.toQueueId} — ` +
        `sentinelPassed=${event.sentinelPassed} confidence=${event.confidenceScore.toFixed(2)} — ${event.reason}`
    );
  }

  /**
   * A best-effort, over-inclusive detector for memory-exhaustion-flavored failures. True V8
   * heap OOM crashes are not reliably catchable JS exceptions, but the JS-level symptoms that
   * precede or accompany one on a huge manifest (a `RangeError` from an oversized allocation,
   * or an explicit "heap"/"out of memory"/"allocation failed" message) are — this exists so the
   * `catch` in {@link run} can distinguish "the manifest got too big" from "a real bug."
   */
  private isOutOfMemoryError(error: unknown): boolean {
    if (error instanceof RangeError) return true;
    const message = errMsg(error);
    return /heap|out of memory|allocation failed|enomem/i.test(message);
  }

  /**
   * Graceful OOM degradation: best-effort persist whatever manifest state is still in memory
   * (queue statuses already mutated by completed transitions this run are not lost), close the
   * Build Memory row as PAUSED (not FAILED — this is a resource limit, not a build defect), log
   * the exact `--skipTo` command to resume from the last completed queue, and set a non-zero
   * exit code so the process signals failure without a hard `process.exit()` that would cut off
   * in-flight log flushing or the SQLite writer.
   */
  private handleOutOfMemory(
    error: unknown,
    manifest: LibraryManifest,
    manifestPath: string,
    manifestRowId: string | null,
    lastQueueId: string | null,
    startedAt: string,
    runStart: number,
    queuesRun: number,
    queuesComplete: number,
    queuesFailed: number
  ): OrchestratorResult {
    renderProgress('ERROR', `[ORCHESTRATOR] OUT OF MEMORY — ${errMsg(error)}`);

    try {
      this.manifestResolver.save(manifestPath, manifest);
      renderProgress('INFO', `[ORCHESTRATOR] manifest state saved to "${manifestPath}" before exit`);
    } catch (saveError) {
      renderProgress('ERROR', `[ORCHESTRATOR] failed to save manifest state after OOM — ${errMsg(saveError)}`);
    }

    this.finalizeManifestRow(manifestRowId, ManifestStatus.PAUSED, queuesComplete, queuesFailed);

    const resumeHint = lastQueueId
      ? `forge orchestrator run --project ${manifest.project} --skipTo ${lastQueueId}`
      : `forge orchestrator run --project ${manifest.project}`;
    renderProgress('ERROR', `[ORCHESTRATOR] halting run — out of memory. Resume with: ${resumeHint}`);
    process.exitCode = 1;

    return {
      manifestId: manifestRowId ?? manifest.project,
      project: manifest.project,
      queuesRun,
      queuesComplete,
      queuesFailed,
      totalDurationMs: Date.now() - runStart,
      startedAt,
      completedAt: nowIso(),
    };
  }

  /**
   * Find-or-create the `orchestrator_manifests` row for this (project, manifestPath) pair and
   * set it to RUNNING at the start of a real (non-dry-run or dry-run alike) invocation. Returns
   * the row id, or `null` if Build Memory is unavailable — never throws (Contract 4).
   */
  private insertManifestRunningRow(manifest: LibraryManifest, manifestPath: string): string | null {
    const db = getClient();
    if (!db) return null;

    try {
      const existing = db
        .prepare('SELECT id FROM orchestrator_manifests WHERE project = ? AND manifest_path = ?')
        .get(manifest.project, manifestPath) as { id: string } | undefined;

      if (existing) {
        db.prepare(
          `UPDATE orchestrator_manifests SET
             status = @status, version = @version, description = @description,
             queues_total = @queues_total, started_at = @started_at, completed_at = NULL
           WHERE id = @id`
        ).run({
          id: existing.id,
          status: ManifestStatus.RUNNING,
          version: manifest.version,
          description: manifest.description,
          queues_total: manifest.queues.length,
          started_at: nowIso(),
        });
        return existing.id;
      }

      const id = newId();
      db.prepare(
        `INSERT INTO orchestrator_manifests (
           id, project, manifest_path, version, description, status,
           queues_total, queues_complete, queues_failed, started_at, created_at
         ) VALUES (
           @id, @project, @manifest_path, @version, @description, @status,
           @queues_total, 0, 0, @started_at, @created_at
         )`
      ).run({
        id,
        project: manifest.project,
        manifest_path: manifestPath,
        version: manifest.version,
        description: manifest.description,
        status: ManifestStatus.RUNNING,
        queues_total: manifest.queues.length,
        started_at: nowIso(),
        created_at: nowIso(),
      });
      return id;
    } catch (error) {
      logMemoryWarning('OrchestratorEngine.insertManifestRunningRow', error);
      return null;
    }
  }

  /**
   * Close out the `orchestrator_manifests` row this run opened with its final status and
   * rollup counters. Best-effort/non-fatal (Contract 4) — a no-op when the row was never
   * created (Build Memory was unavailable at the start of the run) or a write fails now.
   */
  private finalizeManifestRow(
    manifestRowId: string | null,
    status: ManifestStatus,
    queuesComplete: number,
    queuesFailed: number
  ): void {
    if (!manifestRowId) return;
    const db = getClient();
    if (!db) return;

    try {
      db.prepare(
        `UPDATE orchestrator_manifests SET
           status = @status, queues_complete = @queues_complete, queues_failed = @queues_failed,
           completed_at = @completed_at
         WHERE id = @id`
      ).run({
        id: manifestRowId,
        status,
        queues_complete: queuesComplete,
        queues_failed: queuesFailed,
        completed_at: nowIso(),
      });
    } catch (error) {
      logMemoryWarning('OrchestratorEngine.finalizeManifestRow', error);
    }
  }
}

export function createOrchestratorEngine(): OrchestratorEngine {
  return new OrchestratorEngine();
}
