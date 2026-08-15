/**
 * FORGE 2.0 — Dead-Loop Detection.
 *
 * `upgrades/ENGINEERING_COMPLETENESS.md` § "38. Dead-loop detection": "An autonomous factory can
 * get trapped repeatedly attempting variations of the same unsuccessful approach... FORGE needs
 * loop detection. Example: Same error family detected 4 times. Same remediation class attempted 3
 * times. STOP RETRYING. Invoke: Multi-LLM consensus / Architecture review / Alternative strategy
 * generation." `upgrades/SYSTEMS-5-9-GAP-MATRIX.md` row 29 ("Dead-loop / stagnation detection")
 * confirmed no match existed anywhere in the codebase before this module.
 *
 * Grounded entirely in Build Memory rows FORGE already writes on every Sentinel failure/recovery
 * attempt (`src/engine/learning-writeback.ts`'s `recordFailureObserved`/`recordRecoveryOutcome`,
 * already wired into `phase3-executor.ts`'s h1 failure-handling block) — no new table, no
 * fabricated signal, matching every sibling `src/governance/` module's posture:
 *   - "same error family detected N times" -> `error_patterns.occurrence_count` for the failure's
 *     normalized signature (`normalizeErrorSignature`, the exact hash `recordFailureObserved`
 *     keys on — reusing it here means this module always agrees with what Build Brain already
 *     recorded, never a second, drifting notion of "the same error").
 *   - "same remediation class attempted N times" -> `resolutions.times_applied` for that error
 *     pattern's resolution row. `recordRecoveryOutcome` upserts exactly ONE `resolutions` row per
 *     `error_pattern_id` (`getResolutionForPattern` before `createResolution`), so
 *     `times_applied` already IS the count of times a remediation of that
 *     `resolution_type`/`resolution_description` has been attempted against this error family —
 *     no extra bookkeeping needed.
 *
 * The two spec thresholds (4 and 3) are used verbatim as {@link DEAD_LOOP_ERROR_FAMILY_THRESHOLD}
 * / {@link DEAD_LOOP_REMEDIATION_CLASS_THRESHOLD} — either one tripping is enough to call it a
 * dead loop, since the spec presents them as two independent example triggers, not a conjunction.
 *
 * Wired into `phase3-executor.ts`'s h1 block: once tripped for a prompt's current failure
 * signature, BOTH the Build Brain targeted-fix attempt and the Contract 14 autonomous-recovery
 * re-run are skipped for that prompt (the spec's literal "STOP RETRYING") and the prompt escalates
 * immediately, carrying {@link DeadLoopVerdict.recommendedActions} in its disposition note and a
 * BLOCKER entry in STATE_OF_THE_BUILD.md — the three actions themselves (multi-LLM consensus,
 * architecture review, alternative strategy generation) are surfaced as a recommendation for the
 * human/orchestrator, not auto-invoked by this module, matching the "observes, never itself takes
 * the escalation action" posture `src/autonomy/health-monitor.ts` already established for a
 * different signal (Contract AUT-6).
 */

import { normalizeErrorSignature } from '../phases/phase4-sentinel.js';
import { BuildMemory } from '../memory/index.js';
import type { ErrorPattern, Resolution } from '../types/index.js';

/** "Same error family detected 4 times" — verbatim from the spec example. */
export const DEAD_LOOP_ERROR_FAMILY_THRESHOLD = 4;

/** "Same remediation class attempted 3 times" — verbatim from the spec example. */
export const DEAD_LOOP_REMEDIATION_CLASS_THRESHOLD = 3;

/** The three spec-named escalation paths, in the order `ENGINEERING_COMPLETENESS.md` § 38 lists them. */
export type DeadLoopAction = 'multi_llm_consensus' | 'architecture_review' | 'alternative_strategy_generation';

export const DEAD_LOOP_RECOMMENDED_ACTIONS: readonly DeadLoopAction[] = [
  'multi_llm_consensus',
  'architecture_review',
  'alternative_strategy_generation',
];

export interface DeadLoopVerdict {
  errorSignature: string;
  isDeadLoop: boolean;
  errorFamilyOccurrences: number;
  errorFamilyTripped: boolean;
  remediationClassAttempts: number;
  remediationClassType: Resolution['resolution_type'] | null;
  remediationClassTripped: boolean;
  /** Human-readable justification — always populated, even when `isDeadLoop` is false. */
  reason: string;
  /** Non-empty only when `isDeadLoop` is true. */
  recommendedActions: DeadLoopAction[];
}

function makeVerdict(
  errorSignature: string,
  errorFamilyOccurrences: number,
  remediationClassAttempts: number,
  remediationClassType: Resolution['resolution_type'] | null
): DeadLoopVerdict {
  const errorFamilyTripped = errorFamilyOccurrences >= DEAD_LOOP_ERROR_FAMILY_THRESHOLD;
  const remediationClassTripped = remediationClassAttempts >= DEAD_LOOP_REMEDIATION_CLASS_THRESHOLD;
  const isDeadLoop = errorFamilyTripped || remediationClassTripped;

  const reasons: string[] = [];
  if (errorFamilyTripped) {
    reasons.push(`error family seen ${errorFamilyOccurrences}x (>= ${DEAD_LOOP_ERROR_FAMILY_THRESHOLD})`);
  }
  if (remediationClassTripped) {
    reasons.push(
      `remediation class '${remediationClassType ?? 'unknown'}' attempted ${remediationClassAttempts}x ` +
        `(>= ${DEAD_LOOP_REMEDIATION_CLASS_THRESHOLD})`
    );
  }

  return {
    errorSignature,
    isDeadLoop,
    errorFamilyOccurrences,
    errorFamilyTripped,
    remediationClassAttempts,
    remediationClassType,
    remediationClassTripped,
    reason: isDeadLoop ? reasons.join('; ') : 'below both dead-loop thresholds',
    recommendedActions: isDeadLoop ? [...DEAD_LOOP_RECOMMENDED_ACTIONS] : [],
  };
}

/**
 * Look up the dead-loop verdict for raw failure text, normalizing it into the same signature
 * `recordFailureObserved` keys `error_patterns` on. Never throws — a Build Memory read failure
 * degrades to "no signal available" (`errorFamilyOccurrences: 0`), never a fabricated trip.
 */
export async function detectDeadLoop(errorText: string): Promise<DeadLoopVerdict> {
  return detectDeadLoopBySignature(normalizeErrorSignature(errorText));
}

/** Same as {@link detectDeadLoop}, for callers that already hold the normalized signature. */
export async function detectDeadLoopBySignature(errorSignature: string): Promise<DeadLoopVerdict> {
  let pattern: ErrorPattern | null = null;
  try {
    pattern = await BuildMemory.errors.findMatchingPattern(errorSignature);
  } catch {
    pattern = null;
  }
  if (!pattern) return makeVerdict(errorSignature, 0, 0, null);

  let resolution: Resolution | null = null;
  try {
    resolution = await BuildMemory.resolutions.getResolutionForPattern(pattern.id);
  } catch {
    resolution = null;
  }

  return makeVerdict(
    errorSignature,
    pattern.occurrence_count,
    resolution?.times_applied ?? 0,
    resolution?.resolution_type ?? null
  );
}

/**
 * Scan every `error_patterns` row (project-agnostic, same scope `findMatchingPattern` already
 * looks up in — a dead loop is a property of the ERROR, not of one project) and return the
 * verdicts that are currently tripped, highest error-family occurrence first. Used by `forge
 * deadloop list` for a standalone diagnostic report outside of a running build. Never throws —
 * degrades to `[]` when Build Memory is unreachable.
 */
export async function listDeadLoopCandidates(): Promise<DeadLoopVerdict[]> {
  let patterns: ErrorPattern[] | null = null;
  try {
    patterns = await BuildMemory.errors.listAllPatterns();
  } catch {
    patterns = null;
  }
  if (!patterns) return [];

  const verdicts: DeadLoopVerdict[] = [];
  for (const pattern of patterns) {
    let resolution: Resolution | null = null;
    try {
      resolution = await BuildMemory.resolutions.getResolutionForPattern(pattern.id);
    } catch {
      resolution = null;
    }
    const verdict = makeVerdict(
      pattern.error_signature,
      pattern.occurrence_count,
      resolution?.times_applied ?? 0,
      resolution?.resolution_type ?? null
    );
    if (verdict.isDeadLoop) verdicts.push(verdict);
  }
  return verdicts.sort((a, b) => b.errorFamilyOccurrences - a.errorFamilyOccurrences);
}

/** Render a `DeadLoopVerdict` as a human-readable line (used by `forge deadloop`). */
export function formatDeadLoopVerdict(v: DeadLoopVerdict): string {
  const sig = v.errorSignature.length > 70 ? `${v.errorSignature.slice(0, 70)}…` : v.errorSignature;
  if (!v.isDeadLoop) return `${sig} — ${v.reason}`;
  return (
    `${sig}\n` +
    `  DEAD LOOP: ${v.reason}\n` +
    `  recommended: ${v.recommendedActions.join(', ')}`
  );
}
