/**
 * FORGE 2.0 — Native Orchestrator — type definitions.
 */

import type { SentinelPrimeRunResult } from '../sentinel-prime/types.js';

export enum QueueStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETE = 'COMPLETE',
  FAILED = 'FAILED',
  PLANNED = 'PLANNED',
  SKIPPED = 'SKIPPED',
}

export enum ManifestStatus {
  IDLE = 'IDLE',
  RUNNING = 'RUNNING',
  COMPLETE = 'COMPLETE',
  FAILED = 'FAILED',
  PAUSED = 'PAUSED',
}

export interface QueueEntry {
  id: string;
  file: string;
  description: string;
  status: QueueStatus;
  dependsOn: string[];
  promptCount: number;
  estimatedHours: number;
  priority: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  sentinelCheckpoint: SentinelPrimeRunResult | null;
}

export interface LibraryManifest {
  project: string;
  version: string;
  description: string;
  created: string;
  queues: QueueEntry[];
  /**
   * Optional run-wide dollar cap (opt-in — Phase 3's `Phase3Options.maxBudgetUsd`,
   * `src/phases/phase3-executor.ts`): when set, each queue run started via the orchestrator
   * carries this cap into Phase 3, which halts cleanly BETWEEN prompts once its accumulated
   * per-prompt cost estimate reaches it. Absent/`null` on manifests written before this field
   * existed — those keep running with no cap, exactly as before.
   */
  maxBudgetUsd?: number | null;
  /**
   * Optional run-wide opt-in (default `false` — a complete no-op, not even a `VERCEL_TOKEN`
   * check, when absent/`false`): when `true`, each queue run started via the orchestrator carries
   * this into Phase 3 (`Phase3Options.previewEnvironments`, `src/phases/phase3-executor.ts`),
   * which — per prompt, after Sentinel passes and the branch merges — deploys an ephemeral Vercel
   * preview (`src/deploy/ephemeral-preview.ts`), runs the POST_PROMPT test suite against it, then
   * tears it down. Absent/`null` on manifests written before this field existed — those keep
   * running with no preview step, exactly as before. Mirrors {@link maxBudgetUsd}'s pattern.
   */
  previewEnvironments?: boolean | null;
}

export interface OrchestratorOptions {
  project: string;
  libraryPath: string;
  projectPath: string;
  dryRun: boolean;
  skipTo: string | null;
  only: string | null;
  resetStatus: boolean;
  governanceSyncPath: string;
  /**
   * Mirrors the loaded manifest's {@link LibraryManifest.maxBudgetUsd} (OrchestratorEngine sets
   * this once the manifest is read, before delegating to {@link QueueRunner}) — optional/`null`
   * when the manifest declares no cap. QueueRunner forwards it to each spawned `forge build`
   * subprocess as `--max-budget-usd` so Phase 3 can enforce it per queue run.
   */
  maxBudgetUsd?: number | null;
  /**
   * Mirrors the loaded manifest's {@link LibraryManifest.previewEnvironments} — optional/`false`
   * when the manifest declares none. QueueRunner forwards it to each spawned `forge build`
   * subprocess as `--preview-environments` so Phase 3 can run the ephemeral-preview step per prompt.
   */
  previewEnvironments?: boolean;
}

export interface OrchestratorResult {
  manifestId: string;
  project: string;
  queuesRun: number;
  queuesComplete: number;
  queuesFailed: number;
  totalDurationMs: number;
  startedAt: string;
  completedAt: string;
}

export interface QueueTransitionEvent {
  fromQueueId: string | null;
  toQueueId: string;
  reason: string;
  sentinelPassed: boolean;
  confidenceScore: number;
}
