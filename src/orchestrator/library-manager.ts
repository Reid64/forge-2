/**
 * FORGE 2.0 — Native Orchestrator — LibraryManager.
 *
 * Owns the on-disk `library/<project>/` directory itself — the layer beneath
 * {@link import('./manifest-resolver.js').ManifestResolver} (which owns the manifest's
 * in-memory shape and transitions) and {@link import('./queue-runner.js').QueueRunner}
 * (which stages a resolved queue file into a project's active `queue.yaml`). LibraryManager
 * answers "where does this project's library live, does it exist yet, what queue files are
 * in it, and is a given queue file well-formed" — directory/file bookkeeping, not execution.
 *
 * NEVER FABRICATES A RESULT (Iron Law 3): `validateQueueYaml` returns every problem it finds
 * as a plain string, never throws for a malformed (as opposed to unreadable) queue file, and
 * an empty array means "no problems found," not "not checked."
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { dump as dumpYaml, load as parseYaml } from 'js-yaml';

import { nowIso } from '../memory/client.js';
import { getLogger } from '../tools/forge-logger.js';
import { createManifestResolver } from './manifest-resolver.js';
import { QueueStatus, type LibraryManifest, type QueueEntry } from './types.js';

const log = getLogger('library-manager');

/**
 * Default library root: `FORGE_LIBRARY_PATH` when set, else the standard FORGE 1.0 location.
 * Callers pass this (or their own override) as `getLibraryPath`'s `baseDir` argument — it is
 * a convenience default, not a hardcoded path baked into the class itself.
 */
export const DEFAULT_LIBRARY_BASE_PATH = process.env.FORGE_LIBRARY_PATH || 'C:\\Users\\manag\\Documents\\FORGE';

const QUEUE_FILE_PATTERN = /^queue-.*\.ya?ml$/i;

/** Extract a human-readable message from any thrown value. */
function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LibraryManager {
  /**
   * `<baseDir>/library/<project>` — the FORGE 1.0 per-project library layout. `project` is meant
   * to be a bare project-name segment, not a filesystem path: a real absolute path here (e.g. a
   * user passing the same `<project-path>` argument every other FORGE command accepts) would
   * `join` into an illegal nested path (an embedded drive-letter colon on Windows) and crash
   * `scaffold`/`add`'s `mkdirSync`, or silently resolve to a garbled, always-empty directory for
   * `list`/`validate` — so an absolute `project` is normalized to its basename instead.
   */
  getLibraryPath(baseDir: string, project: string): string {
    const name = isAbsolute(project) ? basename(project) : project;
    return join(baseDir, 'library', name);
  }

  /** Create `libraryPath` (and any missing parents) if it does not already exist. */
  ensureLibraryExists(libraryPath: string): void {
    if (existsSync(libraryPath)) return;
    mkdirSync(libraryPath, { recursive: true });
    log.info(`ensureLibraryExists: created "${libraryPath}"`);
  }

  /** Every `queue-*.yaml` file directly inside `libraryPath`, sorted by filename. */
  listQueues(libraryPath: string): string[] {
    if (!existsSync(libraryPath)) return [];
    return readdirSync(libraryPath)
      .filter((name) => QUEUE_FILE_PATTERN.test(name))
      .sort();
  }

  /**
   * Write a starter `library-manifest.yaml` into `libraryPath` with one placeholder queue
   * entry, so a brand-new project has a valid manifest {@link ManifestResolver.load} can read
   * immediately. A no-op (never overwrites) when a manifest already exists there.
   */
  scaffoldManifest(libraryPath: string, project: string): void {
    const manifestPath = join(libraryPath, 'library-manifest.yaml');
    if (existsSync(manifestPath)) return;

    this.ensureLibraryExists(libraryPath);

    const placeholderQueue: QueueEntry = {
      id: 'queue-001',
      file: 'queue-001.yaml',
      description: 'Placeholder queue — replace with real work before running.',
      status: QueueStatus.PENDING,
      dependsOn: [],
      promptCount: 0,
      estimatedHours: 0,
      priority: 1,
      startedAt: null,
      completedAt: null,
      error: null,
      sentinelCheckpoint: null,
    };

    const manifest: LibraryManifest = {
      project,
      version: '1.0.0',
      description: `Library manifest for ${project}`,
      created: nowIso(),
      queues: [placeholderQueue],
    };

    const yaml = dumpYaml(manifest, { lineWidth: 120, noRefs: true });
    writeFileSync(manifestPath, yaml, 'utf8');
    log.info(`scaffoldManifest: wrote starter manifest "${manifestPath}"`);
  }

  /**
   * Append a new queue entry to an existing manifest at `manifestPath`. The four
   * runtime-only fields (`startedAt`/`completedAt`/`error`/`sentinelCheckpoint`) are set to
   * their fresh-entry defaults — callers never fabricate a run history for a queue that
   * hasn't run yet. Delegates load/validate/save to {@link ManifestResolver} so this file
   * carries no second copy of the manifest YAML shape rules.
   */
  addQueueToManifest(
    manifestPath: string,
    entry: Omit<QueueEntry, 'startedAt' | 'completedAt' | 'error' | 'sentinelCheckpoint'>
  ): void {
    const resolver = createManifestResolver();
    const manifest = resolver.load(manifestPath);

    if (manifest.queues.some((q) => q.id === entry.id)) {
      throw new Error(
        `LibraryManager.addQueueToManifest: manifest "${manifestPath}" already has a queue with id "${entry.id}"`
      );
    }

    const fullEntry: QueueEntry = {
      ...entry,
      startedAt: null,
      completedAt: null,
      error: null,
      sentinelCheckpoint: null,
    };

    manifest.queues.push(fullEntry);
    resolver.save(manifestPath, manifest);
    log.info(`addQueueToManifest: added queue "${entry.id}" to "${manifestPath}"`);
  }

  /**
   * Resolve `queueFile` against `libraryPath` (used as-is when already absolute — defensive,
   * matching {@link QueueRunner}'s own `resolveQueueFilePath` convention) and confirm the file
   * actually exists. Throws a descriptive error otherwise, rather than handing a caller a path
   * that will fail much later and further from the real cause.
   */
  getQueueFilePath(libraryPath: string, queueFile: string): string {
    const resolved = isAbsolute(queueFile) ? queueFile : join(libraryPath, queueFile);
    if (!existsSync(resolved)) {
      throw new Error(`LibraryManager.getQueueFilePath: queue file not found at "${resolved}"`);
    }
    return resolved;
  }

  /**
   * Parse the queue file at `queueFilePath` and return every validation problem found as a
   * human-readable string — an empty array means the file is well-formed. Checks: the file is
   * readable and is valid YAML; it parses to a mapping with a non-empty `project` key; it has a
   * `prompts` array with at least one entry; every prompt entry is itself a mapping with a
   * non-empty, unique `id` and a non-empty `gates` array. Never throws — an unreadable or
   * unparsable file is reported as a single validation error, not an exception.
   */
  validateQueueYaml(queueFilePath: string): string[] {
    const errors: string[] = [];

    let raw: string;
    try {
      raw = readFileSync(queueFilePath, 'utf8');
    } catch (error) {
      errors.push(`cannot read queue file "${queueFilePath}" — ${errMsg(error)}`);
      return errors;
    }

    let doc: unknown;
    try {
      doc = parseYaml(raw);
    } catch (error) {
      errors.push(`"${queueFilePath}" is not valid YAML — ${errMsg(error)}`);
      return errors;
    }

    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      errors.push(`"${queueFilePath}" did not parse to a YAML mapping`);
      return errors;
    }

    const obj = doc as Record<string, unknown>;

    if (typeof obj.project !== 'string' || obj.project.trim() === '') {
      errors.push(`"${queueFilePath}" is missing required top-level key "project"`);
    }

    if (!Array.isArray(obj.prompts)) {
      errors.push(`"${queueFilePath}" is missing required top-level key "prompts" (must be an array)`);
      return errors;
    }

    const prompts = obj.prompts as unknown[];
    if (prompts.length === 0) {
      errors.push(`"${queueFilePath}" field "prompts" is empty — at least one prompt is required`);
    }

    const seenIds = new Set<string>();
    prompts.forEach((rawPrompt, index) => {
      if (typeof rawPrompt !== 'object' || rawPrompt === null || Array.isArray(rawPrompt)) {
        errors.push(`"${queueFilePath}" prompts[${index}] must be a mapping`);
        return;
      }
      const prompt = rawPrompt as Record<string, unknown>;
      const id = typeof prompt.id === 'string' ? prompt.id.trim() : '';
      const label = id !== '' ? `"${id}"` : `#${index + 1}`;

      if (id === '') {
        errors.push(`"${queueFilePath}" prompts[${index}] is missing required field "id"`);
      } else if (seenIds.has(id)) {
        errors.push(`"${queueFilePath}" has duplicate prompt id "${id}"`);
      } else {
        seenIds.add(id);
      }

      if (!Array.isArray(prompt.gates) || prompt.gates.length === 0) {
        errors.push(`"${queueFilePath}" prompt ${label} is missing required field "gates" (must be a non-empty array)`);
      }
    });

    return errors;
  }
}

export function createLibraryManager(): LibraryManager {
  return new LibraryManager();
}
