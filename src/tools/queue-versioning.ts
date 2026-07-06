/**
 * FORGE 2.0 — Prompt-library versioning (Session 3 — Autonomy).
 *
 * Every successful `forge compile` (`src/cli/compile-command.ts`) snapshots the written
 * queue.yaml to `<project>/.forge/queue-history/queue-<ISO-timestamp>-<shorthash>.yaml` and
 * records one row in the `queue_versions` table (see `src/learning/database.ts` ›
 * QUEUE_VERSIONING_SCHEMA_SQL, schema 2.1.0). `forge queue-diff` reads two snapshots back and
 * compares them at the ENTRY level (added / removed / modified) rather than as raw text.
 *
 * Guarded per house style: a snapshot failure (disk full, db unreachable) is reported to the
 * caller as a thrown error — `forge compile`'s CLI wrapper catches it and treats it as
 * non-fatal (the compiled queue.yaml itself was already written successfully).
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { QueueEntry } from '../engine/queue-generator.js';
import { parseQueueYaml } from '../phases/phase3-executor.js';
import { getConnection } from '../learning/database.js';
import { nowIso } from '../memory/index.js';

/** First 8 hex chars of the SHA-256 of the queue.yaml content. */
export function queueShortHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
}

export interface SnapshotInput {
  projectPath: string;
  projectName: string;
  queueYaml: string;
  entryCount: number;
}

export interface SnapshotResult {
  hash: string;
  snapshotPath: string;
  createdAt: string;
}

/**
 * Copy `input.queueYaml` into `<projectPath>/.forge/queue-history/` and record a
 * `queue_versions` row. Throws on a genuine failure (disk / db) — callers decide how to
 * degrade (the `forge compile` CLI wrapper treats it as non-fatal).
 */
export async function snapshotQueue(input: SnapshotInput): Promise<SnapshotResult> {
  const hash = queueShortHash(input.queueYaml);
  const createdAt = nowIso();
  const stamp = createdAt.replace(/[:.]/g, '-');
  const historyDir = join(input.projectPath, '.forge', 'queue-history');
  await mkdir(historyDir, { recursive: true });
  const snapshotPath = join(historyDir, `queue-${stamp}-${hash}.yaml`);
  await writeFile(snapshotPath, input.queueYaml, 'utf8');

  const db = getConnection();
  db.prepare(
    `INSERT INTO queue_versions (id, project_name, queue_hash, entry_count, snapshot_path, created_at)
     VALUES (@id, @project_name, @queue_hash, @entry_count, @snapshot_path, @created_at)`
  ).run({
    id: randomUUID(),
    project_name: input.projectName,
    queue_hash: hash,
    entry_count: input.entryCount,
    snapshot_path: snapshotPath,
    created_at: createdAt,
  });

  return { hash, snapshotPath, createdAt };
}

/** One `queue_versions` row. */
export interface QueueVersionRow {
  id: string;
  project_name: string;
  queue_hash: string;
  entry_count: number;
  snapshot_path: string;
  created_at: string;
}

/** List every snapshot for a project, newest first. */
export function listQueueVersions(projectName: string): QueueVersionRow[] {
  const db = getConnection();
  return db
    .prepare('SELECT * FROM queue_versions WHERE project_name = ? ORDER BY created_at DESC')
    .all(projectName) as QueueVersionRow[];
}

/**
 * Resolve the snapshot `forge queue-diff --against <hash-or-'previous'>` should compare
 * against. `'previous'` (or an empty/omitted value) resolves to the most recent snapshot for
 * the project; otherwise `hashOrPrevious` is matched as a (possibly partial) prefix of
 * `queue_hash`. Returns `null` when no snapshot matches.
 */
export function getQueueVersion(projectName: string, hashOrPrevious: string): QueueVersionRow | null {
  const db = getConnection();
  if (hashOrPrevious.trim() === '' || hashOrPrevious === 'previous') {
    const row = db
      .prepare('SELECT * FROM queue_versions WHERE project_name = ? ORDER BY created_at DESC LIMIT 1')
      .get(projectName) as QueueVersionRow | undefined;
    return row ?? null;
  }
  const row = db
    .prepare(
      'SELECT * FROM queue_versions WHERE project_name = ? AND queue_hash LIKE ? ORDER BY created_at DESC LIMIT 1'
    )
    .get(projectName, `${hashOrPrevious}%`) as QueueVersionRow | undefined;
  return row ?? null;
}

/** Read a queue.yaml file (a master queue OR a snapshot) into its {@link QueueEntry}[]. */
export async function loadQueueEntriesFromFile(path: string): Promise<QueueEntry[]> {
  const text = await readFile(path, 'utf8');
  return parseQueueYaml(text).entries;
}

/** Fields compared when deciding whether two same-id entries counts as "modified". */
const DIFF_FIELDS: ReadonlyArray<keyof QueueEntry> = [
  'name',
  'prompt_type',
  'description',
  'dependencies',
  'governance_refs',
  'estimated_tokens',
  'skills',
];

/** One entry-level difference between two queues (id present in both, at least one field changed). */
export interface ModifiedEntryDiff {
  id: string;
  changedFields: string[];
}

/** The result of {@link diffQueueEntries}. */
export interface QueueEntryDiff {
  /** ids present in `after` but not `before`. */
  added: string[];
  /** ids present in `before` but not `after`. */
  removed: string[];
  /** ids present in both, with at least one tracked field changed. */
  modified: ModifiedEntryDiff[];
}

/** Order-insensitive deep-ish equality for the field values compared ({@link DIFF_FIELDS}). */
function fieldsDiffer(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify([...a].sort()) !== JSON.stringify([...b].sort());
  }
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * Diff two queues at the ENTRY level (not raw text lines): which ids were added, removed, and
 * which same-id entries changed — and which of {@link DIFF_FIELDS} changed for each.
 */
export function diffQueueEntries(before: QueueEntry[], after: QueueEntry[]): QueueEntryDiff {
  const beforeMap = new Map(before.map((e) => [e.id, e]));
  const afterMap = new Map(after.map((e) => [e.id, e]));

  const added = [...afterMap.keys()].filter((id) => !beforeMap.has(id));
  const removed = [...beforeMap.keys()].filter((id) => !afterMap.has(id));

  const modified: ModifiedEntryDiff[] = [];
  for (const [id, beforeEntry] of beforeMap) {
    const afterEntry = afterMap.get(id);
    if (!afterEntry) continue;
    const changedFields: string[] = [];
    for (const field of DIFF_FIELDS) {
      if (fieldsDiffer(beforeEntry[field], afterEntry[field])) changedFields.push(field);
    }
    if (changedFields.length > 0) modified.push({ id, changedFields });
  }

  return { added, removed, modified };
}
