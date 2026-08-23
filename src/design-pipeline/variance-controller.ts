/**
 * FORGE 2.0 — Design Pipeline: VarianceController (`src/design-pipeline/variance-controller.ts`).
 *
 * `upgrades/DESIGN_INTELLIGENCE.md` component #09 ("Design Variance Controller"). Real prior art
 * already exists for the SOFT version of this check — `design-tournament.ts`'s own
 * `computeTokenJaccardSimilarity` + `SUSPICIOUS_SIMILARITY_THRESHOLD`, which WARNS (logs only, does
 * not block) when two generated variants' code ends up suspiciously similar despite distinct
 * structural directives; that file's own header documents this as "a variance CHECK on already-
 * generated variants, not a separate generation-time subsystem." This module is the missing HARD
 * gate the spec actually names: {@link MINIMUM_VARIANCE} + {@link validateVariance} flag a pair of
 * variants PROHIBITED (not merely suspicious) when their real structural signal is close enough
 * to identical that any remaining difference between them can only be color/font/spacing — the
 * spec's own explicitly-named prohibited failure mode, `color_only_variants`.
 *
 * REUSES THE EXISTING VARIANT SHAPE: {@link VarianceCandidate}'s `structuralTags`/`density` fields
 * mirror `design-tournament.ts`'s `DesignDirection` exactly (see {@link fromDesignDirection}, a
 * zero-guesswork bridge) rather than inventing a parallel variant concept; `code`, when supplied,
 * is compared with the SAME `computeTokenJaccardSimilarity` `design-tournament.ts` already uses,
 * imported directly (no duplicated similarity math).
 *
 * WHAT COUNTS AS "STRUCTURAL": layout/navigation archetype and information density — exactly the
 * two axes `design-tournament.ts`'s `TOURNAMENT_DIRECTIONS` already vary on purpose
 * (`structuralTags` like `sidebar_nav`/`split_pane`/`single_column`, and `density`). Two variants
 * that share (almost) all of both have, by construction, varied nothing structural — palette,
 * type, and spacing are the only axes left that could differ, which is exactly the prohibited
 * "four color variations" failure mode.
 *
 * House style, matching every sibling `src/design-pipeline/` module: {@link validateVariance}
 * never throws and never blocks by itself — it returns a typed verdict a caller (e.g.
 * `design-tournament.ts`, or `design-router.ts` when advising on an upcoming tournament run) is
 * responsible for acting on. Fewer than two candidates is trivially `'ok'` (nothing to compare).
 */

import { computeTokenJaccardSimilarity } from './design-tournament.js';
import type { DesignDirection } from './design-tournament.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** One design variant's real, comparable signal — reuses `design-tournament.ts`'s own shape. */
export interface VarianceCandidate {
  id: string;
  label?: string;
  /** Structural/layout signal, e.g. `['sidebar_nav', 'high_density']` — same vocabulary as `DesignDirection.structuralTags`. */
  structuralTags: readonly string[];
  /** Same vocabulary as `DesignDirection.density`, when known. */
  density?: 'low' | 'medium' | 'high';
  /** Real generated code, when available, for a token-level cross-check (see file header). */
  code?: string;
}

export type VarianceVerdict = 'distinct' | 'prohibited';

export interface VarianceComparison {
  aId: string;
  bId: string;
  /** Jaccard similarity of the two candidates' structural signal (tags + density-as-tag). 1.0 = identical. */
  structuralSimilarity: number;
  /** Jaccard similarity of the two candidates' code tokens, or `null` when either lacks `code`. */
  tokenSimilarity: number | null;
  verdict: VarianceVerdict;
  reason: string;
}

export interface VarianceValidationResult {
  status: 'ok' | 'prohibited';
  comparisons: VarianceComparison[];
  /** The subset of `comparisons` with `verdict === 'prohibited'`. */
  violations: VarianceComparison[];
  summary: string;
}

/**
 * The spec's `color_only_variants` prohibition, as real, tunable thresholds:
 *   - `maxStructuralSimilarity`: at or above this structural-tag Jaccard similarity, two variants
 *     share essentially the same layout/navigation/density skeleton — PROHIBITED regardless of
 *     whether code was supplied, because a shared skeleton means any remaining difference is
 *     necessarily palette/type/spacing.
 *   - `maxTokenSimilarityWhenAvailable`: reused from `design-tournament.ts`'s own
 *     `SUSPICIOUS_SIMILARITY_THRESHOLD` (0.9) — when actual generated code is available for both
 *     variants and its token similarity meets this, that is independent, stronger confirmation
 *     (not required for a PROHIBITED verdict; `maxStructuralSimilarity` alone is sufficient).
 */
export const MINIMUM_VARIANCE = {
  maxStructuralSimilarity: 0.6,
  maxTokenSimilarityWhenAvailable: 0.9,
} as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Generic Jaccard similarity of two tag sets. `1.0` when both are empty (nothing to distinguish). */
export function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

/** A candidate's structural signal as one tag set — `structuralTags` plus `density` folded in as `density:<x>`. */
function structuralSignal(candidate: VarianceCandidate): string[] {
  const tags = [...candidate.structuralTags];
  if (candidate.density) tags.push(`density:${candidate.density}`);
  return tags;
}

/** Bridge from `design-tournament.ts`'s own variant concept — zero guesswork, see file header. */
export function fromDesignDirection(direction: DesignDirection, code?: string): VarianceCandidate {
  return {
    id: direction.id,
    label: direction.name,
    structuralTags: direction.structuralTags,
    density: direction.density,
    code,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compare every pair of `candidates` and flag any pair whose structural signal is close enough
 * (>= {@link MINIMUM_VARIANCE.maxStructuralSimilarity}) to be the SAME skeleton — meaning any
 * remaining difference between them can only be color/font/spacing, the spec's prohibited
 * `color_only_variants` failure mode. Fewer than two candidates trivially returns `'ok'`. Never
 * throws.
 */
export function validateVariance(candidates: readonly VarianceCandidate[]): VarianceValidationResult {
  const comparisons: VarianceComparison[] = [];

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      const structuralSimilarity = jaccardSimilarity(structuralSignal(a), structuralSignal(b));
      const tokenSimilarity =
        typeof a.code === 'string' && typeof b.code === 'string' ? computeTokenJaccardSimilarity(a.code, b.code) : null;

      const structurallyProhibited = structuralSimilarity >= MINIMUM_VARIANCE.maxStructuralSimilarity;
      const tokenConfirmsProhibited =
        tokenSimilarity !== null && tokenSimilarity >= MINIMUM_VARIANCE.maxTokenSimilarityWhenAvailable;

      const verdict: VarianceVerdict = structurallyProhibited ? 'prohibited' : 'distinct';
      const reason = structurallyProhibited
        ? `structural similarity ${structuralSimilarity.toFixed(2)} >= ${MINIMUM_VARIANCE.maxStructuralSimilarity} ` +
          `(same layout/navigation/density skeleton — any difference is color/font/spacing only)` +
          (tokenConfirmsProhibited ? `; confirmed by ${(tokenSimilarity as number).toFixed(2)} token similarity` : '')
        : `structural similarity ${structuralSimilarity.toFixed(2)} < ${MINIMUM_VARIANCE.maxStructuralSimilarity} — real structural variance present`;

      comparisons.push({ aId: a.id, bId: b.id, structuralSimilarity, tokenSimilarity, verdict, reason });
    }
  }

  const violations = comparisons.filter((c) => c.verdict === 'prohibited');
  const status: VarianceValidationResult['status'] = violations.length > 0 ? 'prohibited' : 'ok';
  const summary =
    candidates.length < 2
      ? 'fewer than 2 candidates — nothing to compare'
      : violations.length === 0
        ? `${comparisons.length} pair(s) compared, all structurally distinct`
        : `${violations.length}/${comparisons.length} pair(s) PROHIBITED — color/font/spacing-only variance detected (${violations
            .map((v) => `${v.aId}~${v.bId}`)
            .join(', ')})`;

  return { status, comparisons, violations, summary };
}

export default validateVariance;
