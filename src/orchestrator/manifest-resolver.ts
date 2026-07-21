/**
 * FORGE 2.0 — Native Orchestrator — ManifestResolver.
 *
 * Owns the on-disk `library-manifest.yaml` lifecycle: load + validate, compute the
 * runnable frontier (dependency-resolved, priority-ordered), mutate queue status
 * transitions, persist back to disk, and best-effort mirror queue-run state into
 * Build Memory (`orchestrator_manifests` / `orchestrator_queue_runs`).
 *
 * Per BEHAVIORAL_CONTRACTS.md Contract 4, Build Memory writes are non-blocking and
 * must never fail a manifest mutation — the Build Memory mirror in this module is
 * fire-and-forget from the caller's point of view (`markRunning`/`markComplete`/
 * `markFailed` are synchronous — the manifest file is the source of truth) and
 * swallows its own errors via `logMemoryWarning`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dump as dumpYaml, load as parseYaml } from 'js-yaml';

import { getClient, logMemoryWarning, newId, nowIso, toJsonText, type MemoryDb } from '../memory/client.js';
import { getLogger } from '../tools/forge-logger.js';
import { ManifestStatus, QueueStatus, type LibraryManifest, type QueueEntry } from './types.js';

const log = getLogger('manifest-resolver');

const REQUIRED_MANIFEST_FIELDS: readonly (keyof LibraryManifest)[] = [
  'project',
  'version',
  'description',
  'created',
  'queues',
];

const REQUIRED_QUEUE_FIELDS: readonly (keyof QueueEntry)[] = [
  'id',
  'file',
  'description',
  'status',
  'dependsOn',
  'promptCount',
  'estimatedHours',
  'priority',
];

/** Extract a human-readable message from any thrown value. */
function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rollup counters derived from a manifest's current queue statuses. */
interface ManifestRollup {
  total: number;
  complete: number;
  failed: number;
  status: ManifestStatus;
}

function computeRollup(manifest: LibraryManifest): ManifestRollup {
  const total = manifest.queues.length;
  const complete = manifest.queues.filter((q) => q.status === QueueStatus.COMPLETE).length;
  const failed = manifest.queues.filter((q) => q.status === QueueStatus.FAILED).length;
  let status: ManifestStatus = ManifestStatus.RUNNING;
  if (failed > 0) {
    status = ManifestStatus.FAILED;
  } else if (total > 0 && complete === total) {
    status = ManifestStatus.COMPLETE;
  }
  return { total, complete, failed, status };
}

export class ManifestResolver {
  /**
   * Read and parse `library-manifest.yaml` from disk. Throws a descriptive error
   * if the file cannot be read, is not valid YAML, or is missing required fields.
   */
  load(manifestPath: string): LibraryManifest {
    let raw: string;
    try {
      raw = readFileSync(manifestPath, 'utf8');
    } catch (error) {
      throw new Error(`ManifestResolver.load: cannot read manifest at "${manifestPath}" — ${errMsg(error)}`);
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (error) {
      throw new Error(`ManifestResolver.load: "${manifestPath}" is not valid YAML — ${errMsg(error)}`);
    }

    return this.validateManifestShape(parsed, manifestPath);
  }

  /** Write an updated manifest back to disk. Re-validates before writing. */
  save(manifestPath: string, manifest: LibraryManifest): void {
    this.validateManifestShape(manifest, manifestPath);
    const yaml = dumpYaml(manifest, { lineWidth: 120, noRefs: true });
    try {
      writeFileSync(manifestPath, yaml, 'utf8');
    } catch (error) {
      throw new Error(`ManifestResolver.save: cannot write manifest to "${manifestPath}" — ${errMsg(error)}`);
    }
  }

  /** Every PENDING queue whose dependencies are all COMPLETE, sorted by priority ascending. */
  getRunnable(manifest: LibraryManifest): QueueEntry[] {
    const byId = new Map(manifest.queues.map((q) => [q.id, q]));
    return manifest.queues
      .filter((q) => q.status === QueueStatus.PENDING)
      .filter((q) => q.dependsOn.every((depId) => byId.get(depId)?.status === QueueStatus.COMPLETE))
      .sort((a, b) => a.priority - b.priority);
  }

  /** Transition a queue to RUNNING, persist the manifest, mirror into Build Memory. */
  markRunning(manifest: LibraryManifest, queueId: string, manifestPath: string): void {
    const entry = this.findQueueOrThrow(manifest, queueId, 'markRunning');
    entry.status = QueueStatus.RUNNING;
    entry.startedAt = nowIso();
    entry.error = null;
    this.save(manifestPath, manifest);
    this.upsertQueueRun(manifest, entry, manifestPath).catch((error) =>
      log.warn(`markRunning: Build Memory mirror failed — ${errMsg(error)}`)
    );
  }

  /** Transition a queue to COMPLETE, persist the manifest, mirror into Build Memory. */
  markComplete(manifest: LibraryManifest, queueId: string, manifestPath: string): void {
    const entry = this.findQueueOrThrow(manifest, queueId, 'markComplete');
    entry.status = QueueStatus.COMPLETE;
    entry.completedAt = nowIso();
    entry.error = null;
    this.save(manifestPath, manifest);
    this.upsertQueueRun(manifest, entry, manifestPath).catch((error) =>
      log.warn(`markComplete: Build Memory mirror failed — ${errMsg(error)}`)
    );
  }

  /** Transition a queue to FAILED, record the error, persist, mirror into Build Memory. */
  markFailed(manifest: LibraryManifest, queueId: string, error: string, manifestPath: string): void {
    const entry = this.findQueueOrThrow(manifest, queueId, 'markFailed');
    entry.status = QueueStatus.FAILED;
    entry.completedAt = nowIso();
    entry.error = error;
    this.save(manifestPath, manifest);
    this.upsertQueueRun(manifest, entry, manifestPath).catch((err) =>
      log.warn(`markFailed: Build Memory mirror failed — ${errMsg(err)}`)
    );
  }

  /** Detect circular `dependsOn` chains (and dangling references) via DFS. Throws on either. */
  validateNoCycles(manifest: LibraryManifest): void {
    const byId = new Map(manifest.queues.map((q) => [q.id, q]));
    const state = new Map<string, 'visiting' | 'done'>();

    const visit = (id: string, path: string[]): void => {
      if (state.get(id) === 'done') return;

      if (state.get(id) === 'visiting') {
        const cycleStart = path.indexOf(id);
        const cycle = [...path.slice(cycleStart), id].join(' -> ');
        throw new Error(`ManifestResolver.validateNoCycles: circular dependency detected: ${cycle}`);
      }

      const entry = byId.get(id);
      if (!entry) {
        const via = path.length > 0 ? ` (via "${path[path.length - 1]}")` : '';
        throw new Error(`ManifestResolver.validateNoCycles: unknown queue "${id}" referenced in dependsOn${via}`);
      }

      state.set(id, 'visiting');
      for (const depId of entry.dependsOn) {
        visit(depId, [...path, id]);
      }
      state.set(id, 'done');
    };

    for (const queue of manifest.queues) {
      if (state.get(queue.id) !== 'done') {
        visit(queue.id, []);
      }
    }
  }

  private findQueueOrThrow(manifest: LibraryManifest, queueId: string, caller: string): QueueEntry {
    const entry = manifest.queues.find((q) => q.id === queueId);
    if (!entry) {
      throw new Error(`ManifestResolver.${caller}: no queue with id "${queueId}" in manifest "${manifest.project}"`);
    }
    return entry;
  }

  private validateManifestShape(value: unknown, manifestPath: string): LibraryManifest {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`ManifestResolver: "${manifestPath}" did not parse to a YAML object`);
    }

    const manifest = value as Record<string, unknown>;

    for (const field of REQUIRED_MANIFEST_FIELDS) {
      if (manifest[field] === undefined || manifest[field] === null) {
        throw new Error(`ManifestResolver: "${manifestPath}" is missing required field "${field}"`);
      }
    }

    if (!Array.isArray(manifest.queues)) {
      throw new Error(`ManifestResolver: "${manifestPath}" field "queues" must be an array`);
    }

    const seenIds = new Set<string>();
    (manifest.queues as unknown[]).forEach((rawQueue, index) => {
      if (typeof rawQueue !== 'object' || rawQueue === null) {
        throw new Error(`ManifestResolver: "${manifestPath}" queues[${index}] must be an object`);
      }
      const queue = rawQueue as Record<string, unknown>;

      for (const field of REQUIRED_QUEUE_FIELDS) {
        if (queue[field] === undefined) {
          throw new Error(`ManifestResolver: "${manifestPath}" queues[${index}] is missing required field "${field}"`);
        }
      }

      const queueId = String(queue.id);

      if (!Array.isArray(queue.dependsOn)) {
        throw new Error(`ManifestResolver: "${manifestPath}" queue "${queueId}" field "dependsOn" must be an array`);
      }

      if (!Object.values(QueueStatus).includes(queue.status as QueueStatus)) {
        throw new Error(
          `ManifestResolver: "${manifestPath}" queue "${queueId}" has invalid status "${String(queue.status)}"`
        );
      }

      if (seenIds.has(queueId)) {
        throw new Error(`ManifestResolver: "${manifestPath}" has duplicate queue id "${queueId}"`);
      }
      seenIds.add(queueId);
    });

    return manifest as unknown as LibraryManifest;
  }

  /**
   * Find-or-create the `orchestrator_manifests` row for this (project, manifestPath)
   * pair and keep its rollup counters/status current. Returns the row id.
   */
  private upsertManifestRow(db: MemoryDb, manifest: LibraryManifest, manifestPath: string): string {
    const rollup = computeRollup(manifest);

    const existing = db
      .prepare('SELECT id FROM orchestrator_manifests WHERE project = ? AND manifest_path = ?')
      .get(manifest.project, manifestPath) as { id: string } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE orchestrator_manifests SET
           version = @version, description = @description, status = @status,
           queues_total = @queues_total, queues_complete = @queues_complete, queues_failed = @queues_failed,
           completed_at = @completed_at
         WHERE id = @id`
      ).run({
        id: existing.id,
        version: manifest.version,
        description: manifest.description,
        status: rollup.status,
        queues_total: rollup.total,
        queues_complete: rollup.complete,
        queues_failed: rollup.failed,
        completed_at: rollup.status === ManifestStatus.COMPLETE ? nowIso() : null,
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
         @queues_total, @queues_complete, @queues_failed, @started_at, @created_at
       )`
    ).run({
      id,
      project: manifest.project,
      manifest_path: manifestPath,
      version: manifest.version,
      description: manifest.description,
      status: rollup.status,
      queues_total: rollup.total,
      queues_complete: rollup.complete,
      queues_failed: rollup.failed,
      started_at: nowIso(),
      created_at: nowIso(),
    });
    return id;
  }

  /**
   * Best-effort upsert of a single `orchestrator_queue_runs` row. Never throws —
   * Build Memory unavailability or a write failure is logged and swallowed
   * (Contract 4: Build Memory is valuable but not blocking).
   */
  private async upsertQueueRun(manifest: LibraryManifest, entry: QueueEntry, manifestPath: string): Promise<void> {
    const db = getClient();
    if (!db) return;

    try {
      const manifestId = this.upsertManifestRow(db, manifest, manifestPath);

      const existing = db
        .prepare('SELECT id FROM orchestrator_queue_runs WHERE manifest_id = ? AND queue_id = ?')
        .get(manifestId, entry.id) as { id: string } | undefined;

      const fields = {
        manifest_id: manifestId,
        queue_id: entry.id,
        queue_file: entry.file,
        status: entry.status,
        depends_on: toJsonText(entry.dependsOn),
        priority: entry.priority,
        prompt_count: entry.promptCount,
        started_at: entry.startedAt,
        completed_at: entry.completedAt,
        sentinel_prime_checkpoint: toJsonText(entry.sentinelCheckpoint),
        error: entry.error,
      };

      if (existing) {
        db.prepare(
          `UPDATE orchestrator_queue_runs SET
             queue_file = @queue_file, status = @status, depends_on = @depends_on,
             priority = @priority, prompt_count = @prompt_count, started_at = @started_at,
             completed_at = @completed_at, sentinel_prime_checkpoint = @sentinel_prime_checkpoint,
             error = @error
           WHERE id = @id`
        ).run({ ...fields, id: existing.id });
      } else {
        db.prepare(
          `INSERT INTO orchestrator_queue_runs (
             id, manifest_id, queue_id, queue_file, status, depends_on, priority, prompt_count,
             started_at, completed_at, sentinel_prime_checkpoint, error, created_at
           ) VALUES (
             @id, @manifest_id, @queue_id, @queue_file, @status, @depends_on, @priority, @prompt_count,
             @started_at, @completed_at, @sentinel_prime_checkpoint, @error, @created_at
           )`
        ).run({ ...fields, id: newId(), created_at: nowIso() });
      }
    } catch (error) {
      logMemoryWarning('orchestrator_queue_runs.upsert', error);
    }
  }
}

export function createManifestResolver(): ManifestResolver {
  return new ManifestResolver();
}
