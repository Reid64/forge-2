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
