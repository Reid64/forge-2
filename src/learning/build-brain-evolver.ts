/**
 * FORGE 2.0 — Learning Engine: BuildBrainEvolver.
 *
 * See `upgrades/LEARNING_BLUEPRINT.md` § Agent: BuildBrainEvolver. Watches whether Contract-9
 * prompt rewrites (`src/engine/prompt-rewriter.ts`) actually help — a rewritten prompt whose
 * Sentinel outcome tracks no better (or worse) than an un-rewritten one, over enough samples, is
 * a signal the rewrite strategy itself needs to change. Per Learning Iron Law L5, BuildBrainEvolver
 * NEVER edits the rewriter and NEVER writes to any table but `pending_evolutions` — it only
 * proposes; some future EvolutionPromoter is the only component allowed to act on a proposal.
 *
 * Two entry points:
 *  - {@link observeRewriteOutcome} — called once per Phase 3 prompt, right after Sentinel runs
 *    (BEHAVIORAL_CONTRACTS Contract 1: Phase 4 runs after EVERY Phase 3 prompt). Appends the
 *    outcome to an in-process trailing-window buffer and, the moment that window shows a clear
 *    (rewritten vs. not) Sentinel pass-rate split, writes ONE `pending_evolutions` TEMPLATE
 *    proposal for it — deduped so the same split isn't proposed twice in a row. This is the live,
 *    mid-build signal; it costs no database read.
 *  - {@link emitProposals} — called once at Phase 5 end. Re-derives the build's full observation
 *    history from the durable `prompt_executions` table (`was_rewritten` / `sentinel_passed`,
 *    already written by the executor for every prompt — see `src/phases/phase3-executor.ts`),
 *    slides the analysis window across the WHOLE build to find the single strongest split it
 *    produced, and proposes it (deduped against anything this function already proposed for the
 *    same build). Being DB-grounded rather than buffer-grounded, it gives the same answer whether
 *    called in-process at Phase 5 or later from a standalone `forge learn evolve` CLI invocation.
 */

import { newId, nowIso, logMemoryWarning, type MemoryDb } from '../memory/client.js';
import { getMachineId } from './database.js';
import type { PendingEvolution } from './types.js';

/** Trailing-window size {@link observeRewriteOutcome} evaluates after every observation. */
const WINDOW_SIZE = 10;
/** Minimum samples required in BOTH the rewritten and non-rewritten buckets before a split counts. */
const MIN_BUCKET_SAMPLES = 3;
/** A Sentinel pass-rate gap at or above this (0-1) is "a pattern" worth proposing (30 points). */
const PATTERN_THRESHOLD = 0.3;
/** Cap on the in-process buffer so a very long build never grows it unbounded. */
const MAX_HISTORY = 500;

/** One prompt's rewrite/Sentinel outcome, as tracked by {@link observeRewriteOutcome}. */
interface RewriteObservation {
  promptId: string;
  wasRewritten: boolean;
  sentinelPassed: boolean;
}

/** A (wasRewritten vs. not) Sentinel pass-rate split found within a set of observations. */
interface RewriteSplit {
  rewrittenCount: number;
  rewrittenPassRate: number;
  plainCount: number;
  plainPassRate: number;
  /** rewrittenPassRate - plainPassRate, signed — negative means rewriting is HURTING. */
  diff: number;
}

// Module-level, per-process buffer for the LIVE mid-build signal — one FORGE build per process
// (Contract 6), so this never needs to be keyed by build id. {@link emitProposals} clears it.
let liveHistory: RewriteObservation[] = [];
let liveProposedSignatures = new Set<string>();

/** Compute the (wasRewritten vs. not) pass-rate split for a set of observations, or `null` when either bucket is too small to mean anything. */
function computeSplit(observations: RewriteObservation[]): RewriteSplit | null {
  const rewritten = observations.filter((o) => o.wasRewritten);
  const plain = observations.filter((o) => !o.wasRewritten);
  if (rewritten.length < MIN_BUCKET_SAMPLES || plain.length < MIN_BUCKET_SAMPLES) return null;
  const rewrittenPassRate = rewritten.filter((o) => o.sentinelPassed).length / rewritten.length;
  const plainPassRate = plain.filter((o) => o.sentinelPassed).length / plain.length;
  return {
    rewrittenCount: rewritten.length,
    rewrittenPassRate,
    plainCount: plain.length,
    plainPassRate,
    diff: rewrittenPassRate - plainPassRate,
  };
}

/** A short, stable signature for a split — rounds the diff to the nearest 0.1 so noisy ±1-sample swings don't re-propose the same finding on every call. */
function splitSignature(split: RewriteSplit): string {
  return `${split.diff >= 0 ? 'helping' : 'hurting'}:${(Math.round(Math.abs(split.diff) * 10) / 10).toFixed(1)}`;
}

/** Find the strongest split across every {@link WINDOW_SIZE} window slid over `observations`, falling back to the whole-set split for a build shorter than one window. `null` when no window meets {@link MIN_BUCKET_SAMPLES}. */
function findStrongestSplit(observations: RewriteObservation[]): RewriteSplit | null {
  let strongest: RewriteSplit | null = null;
  for (let start = 0; start + WINDOW_SIZE <= observations.length; start++) {
    const split = computeSplit(observations.slice(start, start + WINDOW_SIZE));
    if (split && (!strongest || Math.abs(split.diff) > Math.abs(strongest.diff))) strongest = split;
  }
  if (!strongest) strongest = computeSplit(observations);
  return strongest;
}

/** Has a TEMPLATE proposal with this exact (build, signature) evidence already been written? Guards {@link emitProposals} against duplicate inserts on a re-run for the same build. */
function alreadyProposed(buildRunId: string, signature: string, db: MemoryDb): boolean {
  try {
    const rows = db
      .prepare(
        `SELECT evidence FROM pending_evolutions
         WHERE evolution_type = 'TEMPLATE' AND evidence LIKE '%"buildRunId":"' || ? || '"%'`
      )
      .all(buildRunId) as Array<{ evidence: string }>;
    return rows.some((r) => {
      try {
        return (JSON.parse(r.evidence) as { signature?: string }).signature === signature;
      } catch {
        return false;
      }
    });
  } catch (err) {
    logMemoryWarning('build-brain-evolver.alreadyProposed', err);
    return false; // fail open — a missed dedup just means one extra proposal, never a lost one.
  }
}

/** Insert one TEMPLATE proposal for `split` into `pending_evolutions`. Returns the inserted row's id, or `null` on failure. */
function insertProposal(
  split: RewriteSplit,
  evidence: Record<string, unknown>,
  db: MemoryDb
): string | null {
  const helping = split.diff > 0;
  const id = newId();
  try {
    db.prepare(
      `INSERT INTO pending_evolutions (
        id, evolution_type, proposed_change, change_detail, evidence, estimated_impact,
        confidence, status, reviewed_at, review_note, machine_id, created_at
      ) VALUES (?, 'TEMPLATE', ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, ?, ?)`
    ).run(
      id,
      helping
        ? 'Contract-9 prompt rewrite is measurably HELPING — consider making it the default for this prompt shape.'
        : 'Contract-9 prompt rewrite is measurably NOT helping (or hurting) — its template/selection logic needs review.',
      JSON.stringify({
        rewrittenCount: split.rewrittenCount,
        rewrittenPassRate: split.rewrittenPassRate,
        plainCount: split.plainCount,
        plainPassRate: split.plainPassRate,
        diff: split.diff,
      }),
      JSON.stringify(evidence),
      `Sentinel pass rate differs by ${(Math.abs(split.diff) * 100).toFixed(0)} points between rewritten and un-rewritten prompts.`,
      Math.min(Math.abs(split.diff), 1),
      getMachineId(),
      nowIso()
    );
    return id;
  } catch (err) {
    logMemoryWarning('build-brain-evolver.insertProposal', err);
    return null;
  }
}

/**
 * Record one Phase 3 prompt's rewrite/Sentinel outcome (call right after Sentinel runs). Appends
 * to the in-process trailing window and, once the last {@link WINDOW_SIZE} observations show a
 * pass-rate split of at least {@link PATTERN_THRESHOLD} between rewritten and un-rewritten
 * prompts (with at least {@link MIN_BUCKET_SAMPLES} samples on each side), writes ONE
 * `pending_evolutions` TEMPLATE proposal. Never throws (Contract 4) and never writes to any
 * table but `pending_evolutions`.
 */
export function observeRewriteOutcome(
  promptId: string,
  wasRewritten: boolean,
  sentinelPassed: boolean,
  db: MemoryDb
): void {
  try {
    liveHistory.push({ promptId, wasRewritten, sentinelPassed });
    if (liveHistory.length > MAX_HISTORY) liveHistory = liveHistory.slice(liveHistory.length - MAX_HISTORY);

    const trailing = liveHistory.slice(-WINDOW_SIZE);
    const split = computeSplit(trailing);
    if (!split || Math.abs(split.diff) < PATTERN_THRESHOLD) return;

    const signature = splitSignature(split);
    if (liveProposedSignatures.has(signature)) return;

    const insertedId = insertProposal(
      split,
      { source: 'observeRewriteOutcome', promptId, signature },
      db
    );
    if (insertedId) liveProposedSignatures.add(signature);
  } catch (err) {
    logMemoryWarning('build-brain-evolver.observeRewriteOutcome', err);
  }
}

/**
 * Run at Phase 5 end (or standalone via `forge learn evolve <build-id>`): read `buildRunId`'s full
 * `prompt_executions` history (`was_rewritten` / `sentinel_passed`), slide the analysis window
 * across it to find the single strongest rewritten-vs-plain split the build produced, propose it
 * (a no-op if this function already proposed the same signature for this build), and return every
 * `pending_evolutions` row this call created. Clears the live in-process buffer before returning
 * so the next build's {@link observeRewriteOutcome} calls start from a clean slate. Never throws —
 * returns `[]` on failure.
 */
export function emitProposals(buildRunId: string, db: MemoryDb): PendingEvolution[] {
  let createdId: string | null = null;
  try {
    const rows = db
      .prepare(
        `SELECT id AS prompt_id, was_rewritten, sentinel_passed FROM prompt_executions
         WHERE build_run_id = ? AND sentinel_passed IS NOT NULL
         ORDER BY prompt_index ASC`
      )
      .all(buildRunId) as Array<{ prompt_id: string; was_rewritten: number; sentinel_passed: number }>;

    const observations: RewriteObservation[] = rows.map((r) => ({
      promptId: r.prompt_id,
      wasRewritten: r.was_rewritten === 1,
      sentinelPassed: r.sentinel_passed === 1,
    }));

    const strongest = findStrongestSplit(observations);
    if (strongest && Math.abs(strongest.diff) >= PATTERN_THRESHOLD) {
      const signature = splitSignature(strongest);
      if (!alreadyProposed(buildRunId, signature, db)) {
        createdId = insertProposal(
          strongest,
          { source: 'emitProposals', buildRunId, signature },
          db
        );
      }
    }
  } catch (err) {
    logMemoryWarning('build-brain-evolver.emitProposals', err);
  } finally {
    liveHistory = [];
    liveProposedSignatures = new Set();
  }

  if (!createdId) return [];
  try {
    const row = db.prepare('SELECT * FROM pending_evolutions WHERE id = ?').get(createdId) as
      | PendingEvolution
      | undefined;
    return row ? [row] : [];
  } catch (err) {
    logMemoryWarning('build-brain-evolver.emitProposals:readback', err);
    return [];
  }
}
