/**
 * FORGE 2.0 — `promote_scratch` gate: reconciles a `shared_canonical` scratch write
 * (`src/engine/path-classifier.ts`) back onto its real canonical path.
 *
 * The scratch-write enforcement feature redirects a `shared_canonical` declared output (a
 * governance/decision doc another prompt, or another concurrently-running FORGE session, might
 * also touch) to a per-prompt scratch location under `docs/_forge-scratch/{queueId}/{promptId}/
 * {runTimestamp}/{filename}` instead of writing it directly. That scratch copy is inert until
 * something promotes it onto the real path — this module is that something.
 *
 * Promotion never auto-merges a genuine content conflict. It only ever does one of two things per
 * file:
 *   - the canonical path doesn't exist yet, OR it exists and is byte-identical to the scratch
 *     content → copy the scratch content onto the canonical path, commit ONLY that canonical path
 *     (never `git add -A` — this project's standing rule against sweeping in unrelated dirty
 *     files), push immediately, and delete the promoted scratch file.
 *   - the canonical path exists and DIFFERS → write both versions, unmodified, into a timestamped
 *     `docs/_forge-scratch/_pending-review/{promotionTimestamp}/` directory for a human to
 *     reconcile by hand, and report the conflict (the caller halts the queue on it) — the
 *     original scratch file and canonical file are both left untouched so nothing is lost.
 *
 * `git pull` runs once, immediately, before ANY comparison/write — the whole point of this gate is
 * to reconcile against the LATEST canonical state, not a possibly-stale local `main` a concurrent
 * session may have already moved past.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { matchesGlob, normalizePath } from './path-classifier.js';
import type { GitManager } from './git-manager.js';

/** The scratch tree root every scratch write / promotion operates under (relative to the project root). */
export const SCRATCH_ROOT = 'docs/_forge-scratch';

/** Canonical filenames whose scratch basename alone (no directory component) is unambiguous — see {@link inferCanonicalPath}. */
const UNAMBIGUOUS_TOP_LEVEL_CANONICAL_FILES: ReadonlySet<string> = new Set([
  'STATE_OF_THE_BUILD.md',
  'SCHEMA_REGISTRY.md',
  'BEHAVIORAL_CONTRACTS.md',
  'AGENTS.md',
  'BLUEPRINT.md',
]);

/** Inputs to {@link promoteScratchFiles} — one `promote_scratch` gate invocation. */
export interface PromoteScratchOptions {
  projectPath: string;
  git: GitManager;
  /** Glob (relative to the project root, `**`/`*` dialect — see `path-classifier.ts`) restricting which scratch files this gate may touch. */
  scratchGlob: string;
  /** Explicit scratch-path → canonical-path mapping. Required for any file whose canonical path has directory structure the scratch filename alone cannot reconstruct (scratch paths only ever carry the basename — see `scratchPathFor` in `path-classifier.ts`). */
  canonicalMapping?: Record<string, string>;
  /** The declaring queue's id — used as the fallback commit-message source when a scratch path doesn't parse to `docs/_forge-scratch/{queueId}/{promptId}/{runTimestamp}/...`. */
  queueId: string;
  /** The declaring prompt's id — same fallback role as `queueId`. */
  promptId: string;
  log?: (message: string) => void;
}

/** One scratch file successfully reconciled onto its canonical path. */
export interface PromotedFile {
  scratchPath: string;
  canonicalPath: string;
  /** True when the canonical path did not exist yet (as opposed to existing and being byte-identical). */
  wasNewFile: boolean;
}

/** One scratch file whose canonical path exists and diverged — left for manual review. */
export interface ConflictedFile {
  scratchPath: string;
  canonicalPath: string;
  pendingScratchCopy: string;
  pendingCanonicalCopy: string;
}

/** The full outcome of one {@link promoteScratchFiles} call. */
export interface PromoteScratchResult {
  /** False when `git pull` failed, or at least one conflict was found (the caller halts the queue). */
  success: boolean;
  pulled: boolean;
  promoted: PromotedFile[];
  conflicts: ConflictedFile[];
  /** Scratch paths that matched `scratchGlob` but had no resolvable canonical destination — logged, never fatal (a queue.yaml authoring gap, not a build defect). */
  unresolved: string[];
  /** Operator-facing halt message when `success` is false, else `null`. */
  haltMessage: string | null;
}

/** A scratch file paired with its (possibly unresolved) canonical destination. */
interface Candidate {
  scratchPath: string;
  canonicalPath: string | null;
}

/** Recursively list every file under `root`, as paths relative to `root` (forward-slash separated). */
function walkFiles(root: string, relDir = ''): string[] {
  const abs = join(root, relDir);
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Reconstruct a canonical path from a scratch path's basename alone, ONLY for the handful of
 * top-level canonical files (no directory component to lose — `scratchPathFor` in
 * `path-classifier.ts` keeps only the basename). Anything with real directory structure
 * (`docs/decisions/**`, `docs/audits/**`, …) is ambiguous from the filename alone and requires an
 * explicit `canonical_mapping` entry.
 */
function inferCanonicalPath(scratchRelPath: string): string | null {
  const filename = basename(scratchRelPath);
  return UNAMBIGUOUS_TOP_LEVEL_CANONICAL_FILES.has(filename) ? filename : null;
}

/**
 * Resolve the full candidate list: every explicit `canonicalMapping` entry (authoritative,
 * processed regardless of whether it also matches `scratchGlob`), plus any OTHER scratch file
 * under `docs/_forge-scratch/` (excluding `.locks/` and `_pending-review/`, neither of which is
 * promotable content) that matches `scratchGlob` and has an unambiguous inferred canonical path.
 */
function discoverCandidates(
  projectPath: string,
  scratchGlob: string,
  canonicalMapping: Record<string, string> | undefined
): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();

  for (const [scratchPath, canonicalPath] of Object.entries(canonicalMapping ?? {})) {
    const normalized = normalizePath(scratchPath);
    seen.add(normalized);
    out.push({ scratchPath: normalized, canonicalPath: normalizePath(canonicalPath) });
  }

  const root = join(projectPath, SCRATCH_ROOT);
  if (existsSync(root)) {
    for (const relPath of walkFiles(root)) {
      const scratchRelPath = normalizePath(`${SCRATCH_ROOT}/${relPath}`);
      if (seen.has(scratchRelPath)) continue;
      if (scratchRelPath.startsWith(`${SCRATCH_ROOT}/.locks/`)) continue;
      if (scratchRelPath.startsWith(`${SCRATCH_ROOT}/_pending-review/`)) continue;
      if (!matchesGlob(scratchRelPath, scratchGlob)) continue;
      out.push({ scratchPath: scratchRelPath, canonicalPath: inferCanonicalPath(scratchRelPath) });
    }
  }
  return out;
}

/** Parse `docs/_forge-scratch/{queueId}/{promptId}/{runTimestamp}/...` out of a scratch path, falling back to the gate's own declared queue/prompt for a path that doesn't follow that shape (e.g. a hand-authored `canonical_mapping` entry pointing elsewhere under the scratch tree). */
function parseScratchSource(
  scratchPath: string,
  fallbackQueueId: string,
  fallbackPromptId: string
): { queueId: string; promptId: string; runTimestamp: string } {
  const segments = normalizePath(scratchPath).split('/');
  const [, , qid, pid, ts] = segments;
  if (segments.length >= 6 && qid && pid && ts) {
    return { queueId: qid, promptId: pid, runTimestamp: ts };
  }
  return { queueId: fallbackQueueId, promptId: fallbackPromptId, runTimestamp: 'unknown' };
}

type PromoteOneOutcome = { kind: 'promoted'; file: PromotedFile } | { kind: 'conflict'; file: ConflictedFile } | { kind: 'noop' };

/** Promote (or detect a conflict for) exactly one scratch/canonical pair. */
function promoteOne(
  projectPath: string,
  git: GitManager,
  scratchPath: string,
  canonicalPath: string,
  fallbackQueueId: string,
  fallbackPromptId: string,
  promotionTimestamp: string,
  log: (message: string) => void
): PromoteOneOutcome {
  const scratchAbs = join(projectPath, scratchPath);
  if (!existsSync(scratchAbs)) return { kind: 'noop' };

  const scratchContent = readFileSync(scratchAbs);
  const canonicalAbs = join(projectPath, canonicalPath);
  const canonicalExists = existsSync(canonicalAbs);
  const identical = canonicalExists && Buffer.compare(scratchContent, readFileSync(canonicalAbs)) === 0;

  if (!canonicalExists || identical) {
    mkdirSync(dirname(canonicalAbs), { recursive: true });
    writeFileSync(canonicalAbs, scratchContent);

    const source = parseScratchSource(scratchPath, fallbackQueueId, fallbackPromptId);
    const commitMessage =
      `chore(scratch-promote): promote ${canonicalPath}\n\n` +
      `Source: queue '${source.queueId}', prompt '${source.promptId}', scratch timestamp '${source.runTimestamp}'.\n` +
      `Scratch path: ${scratchPath}`;
    const commit = git.commitPath(canonicalPath, commitMessage);
    if (!commit.success) {
      log(
        `promote_scratch: commit of '${canonicalPath}' failed (${commit.error ?? 'unknown'}) — leaving the scratch ` +
          'file in place so a later run can retry the promotion.'
      );
      return { kind: 'noop' };
    }
    if (!commit.nothingToCommit) {
      const push = git.push();
      if (!push.success) {
        log(
          `promote_scratch: push after promoting '${canonicalPath}' failed (${push.error ?? 'unknown'}) — the commit ` +
            'is local only; a later `git pull`/push (this gate, or an operator) will carry it forward.'
        );
      }
    }
    rmSync(scratchAbs, { force: true });
    log(
      `promote_scratch: promoted '${scratchPath}' -> '${canonicalPath}'` +
        `${identical ? ' (byte-identical, direct copy)' : canonicalExists ? '' : ' (canonical did not exist yet)'}.`
    );
    return { kind: 'promoted', file: { scratchPath, canonicalPath, wasNewFile: !canonicalExists } };
  }

  // Conflict: canonical exists and differs — no auto-merge. Write both versions for manual review;
  // the originals (scratch AND canonical) are left completely untouched.
  const pendingDir = join(projectPath, SCRATCH_ROOT, '_pending-review', promotionTimestamp);
  mkdirSync(pendingDir, { recursive: true });
  const safeName = canonicalPath.replace(/[\\/]/g, '__');
  const pendingScratchCopy = normalizePath(`${SCRATCH_ROOT}/_pending-review/${promotionTimestamp}/${safeName}.scratch-version`);
  const pendingCanonicalCopy = normalizePath(`${SCRATCH_ROOT}/_pending-review/${promotionTimestamp}/${safeName}.canonical-version`);
  writeFileSync(join(projectPath, pendingScratchCopy), scratchContent);
  writeFileSync(join(projectPath, pendingCanonicalCopy), readFileSync(canonicalAbs));
  log(
    `promote_scratch: CONFLICT — '${canonicalPath}' exists and differs from '${scratchPath}'. Both versions written ` +
      `to '${pendingScratchCopy}' and '${pendingCanonicalCopy}' for manual review.`
  );
  return { kind: 'conflict', file: { scratchPath, canonicalPath, pendingScratchCopy, pendingCanonicalCopy } };
}

/** Run one `promote_scratch` gate: pull, reconcile every matching scratch file, halt-worthy on any conflict. Never throws. */
export async function promoteScratchFiles(options: PromoteScratchOptions): Promise<PromoteScratchResult> {
  const { projectPath, git, scratchGlob, canonicalMapping, queueId, promptId, log = () => {} } = options;

  const pull = git.pull();
  if (!pull.success) {
    const haltMessage =
      `promote_scratch: 'git pull' failed (${pull.error ?? 'unknown error'}) — halting rather than comparing/writing ` +
      'canonical paths against possibly-stale local state.';
    log(haltMessage);
    return { success: false, pulled: false, promoted: [], conflicts: [], unresolved: [], haltMessage };
  }

  const candidates = discoverCandidates(projectPath, scratchGlob, canonicalMapping);
  const promoted: PromotedFile[] = [];
  const conflicts: ConflictedFile[] = [];
  const unresolved: string[] = [];
  const promotionTimestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

  for (const candidate of candidates) {
    if (candidate.canonicalPath === null) {
      unresolved.push(candidate.scratchPath);
      log(
        `promote_scratch: '${candidate.scratchPath}' matched scratch_glob but has no resolvable canonical destination ` +
          '— add an explicit canonical_mapping entry for it.'
      );
      continue;
    }
    const outcome = promoteOne(projectPath, git, candidate.scratchPath, candidate.canonicalPath, queueId, promptId, promotionTimestamp, log);
    if (outcome.kind === 'promoted') promoted.push(outcome.file);
    else if (outcome.kind === 'conflict') conflicts.push(outcome.file);
  }

  if (conflicts.length > 0) {
    const haltMessage =
      `promote_scratch halted the queue: ${conflicts.length} canonical path(s) diverged from their scratch version ` +
      'and could not be auto-merged — ' +
      conflicts
        .map((c) => `'${c.canonicalPath}' (scratch copy: ${c.pendingScratchCopy}, canonical copy: ${c.pendingCanonicalCopy})`)
        .join('; ') +
      '. Resolve manually, then re-run.';
    return { success: false, pulled: true, promoted, conflicts, unresolved, haltMessage };
  }

  return { success: true, pulled: true, promoted, conflicts, unresolved, haltMessage: null };
}
