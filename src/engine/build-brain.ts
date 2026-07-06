/**
 * FORGE 2.0 — Build Brain (Session 4 — Intelligence & Observability, Task 2).
 *
 * Converts a Sentinel failure into a TARGETED recovery prompt using everything Build Memory has
 * accumulated, instead of the pre-Session-4 behavior of either (a) blindly re-running the
 * identical prompt verbatim (autonomous recovery) or (b) a bespoke inline lookup with no
 * fallback reasoning (the old h1 "pattern fix" block in `src/phases/phase3-executor.ts`).
 *
 * Reads, in order of decreasing precision:
 *   1. `error_patterns` (src/memory) — exact normalized-signature match.
 *   2. `resolutions` (src/memory) — the proven fix linked to that pattern, with its real
 *      historical success rate.
 *   3. `fix_patterns` (learning schema) — a categorical fallback when no exact src/memory match
 *      exists yet, but the learning engine has seen this category+stack combination before.
 *   4. `governance_rules` (learning schema) — active rules relevant to this stack, folded into
 *      the recovery prompt as constraints the fix must still honor.
 *
 * Never fails the build: every read is guarded, and `escalate: true` (with `knownFix: null`) is
 * always a safe, valid diagnosis the caller can act on (fall back to existing recovery paths).
 */

import { BuildMemory } from '../memory/index.js';
import {
  categorizeError,
  normalizeErrorSignature,
  signatureSimilarity,
  type SentinelResult,
} from '../phases/phase4-sentinel.js';
import { getFixPattern, getGovernanceRules } from '../learning/queries.js';
import { computeLearningFingerprint, deriveStackTags, mapCheckToLearningCategory } from './learning-writeback.js';
import type { QueueEntry } from './queue-generator.js';
import type { ErrorPattern, Resolution } from '../types/index.js';
import type { StackFingerprint } from '../tools/stack-detector.js';
import { logLine } from '../tools/forge-logger.js';

const log = logLine('build-brain');

/** Below this confidence, the diagnosis is too weak to act on autonomously — escalate. */
const ESCALATE_CONFIDENCE_THRESHOLD = 0.3;
/** A category+stack (not exact-signature) match caps confidence below the escalate floor... */
const CATEGORY_MATCH_CONFIDENCE = 0.35;
/** ...while an exact signature match with no track record yet still clears it, cautiously. */
const EXACT_MATCH_NO_HISTORY_CONFIDENCE = 0.4;
/** A category+stack signature-similarity floor to accept a fix_patterns fallback match. */
const CATEGORY_SIMILARITY_FLOOR = 0.35;

export interface BrainContext {
  stackFingerprint: StackFingerprint | null | undefined;
  buildRunId: string | null;
  promptIndex: number;
  /**
   * Normalized signatures of fixes already attempted and failed EARLIER in this same build
   * (the caller — `runPhase3Executor` — accumulates this across prompts). When the current
   * failure's signature is in this set, Build Brain escalates rather than proposing the same
   * fix again (Iron Law: never steamroll — a repeat failure this build means the "known fix"
   * isn't actually fixing it here).
   */
  priorFailedSignaturesThisBuild?: readonly string[];
}

export interface KnownFix {
  description: string;
  steps: string[];
  historicalSuccessRate: number;
}

export interface BrainDiagnosis {
  rootCauseHypothesis: string;
  /** 0..1 — how much weight to put on `knownFix` actually working this time. */
  confidence: number;
  knownFix: KnownFix | null;
  /** A COMPLETE targeted prompt: failure evidence + known fix (if any) + verification instruction. */
  recoveryPrompt: string;
  /** True when the caller should escalate to a human rather than auto-apply `recoveryPrompt`. */
  escalate: boolean;
  /** The normalized signature this diagnosis was computed for (fed back via recordRecoveryOutcome). */
  signature: string;
}

/** Extract the raw failure evidence text from a Sentinel result (same convention as runAutonomousRecovery). */
function failureEvidence(sentinel: SentinelResult): { errorText: string; failedCheckName: string | null } {
  const failingCheck = sentinel.checks.find((c) => !c.passed && !c.skipped) ?? null;
  const errorText = failingCheck ? `${failingCheck.detail}\n${failingCheck.output}` : sentinel.diagnosticReport;
  return { errorText, failedCheckName: failingCheck?.name ?? sentinel.failedCheck };
}

/** Render the steps of a resolution's `resolution_steps` (jsonb) as a flat string list. */
function stepsOf(resolution: Resolution | null): string[] {
  if (!resolution) return [];
  const raw = resolution.resolution_steps;
  if (Array.isArray(raw)) return raw.map((s) => String(s));
  if (raw && typeof raw === 'object') {
    const commands = (raw as { commands?: unknown }).commands;
    if (Array.isArray(commands)) return commands.map((c) => String(c));
  }
  return [];
}

/** Build the complete targeted recovery prompt (failure evidence + known fix + verification). */
function renderRecoveryPrompt(input: {
  entry: QueueEntry;
  errorText: string;
  failedCheckName: string | null;
  rootCauseHypothesis: string;
  knownFix: KnownFix | null;
  occurrenceCount: number;
  activeRules: string[];
}): string {
  const { entry, errorText, failedCheckName, rootCauseHypothesis, knownFix, occurrenceCount, activeRules } = input;
  const parts: string[] = [
    `# FORGE Build Brain — targeted recovery for '${entry.name}' (${entry.prompt_type})`,
    '',
    '## Failure evidence',
    '',
    '```',
    errorText.slice(0, 3000).trim(),
    '```',
    '',
    '## Diagnosis',
    '',
    rootCauseHypothesis,
  ];

  if (knownFix) {
    const pct = Math.round(knownFix.historicalSuccessRate * 100);
    parts.push(
      '',
      `## Known fix (seen ${occurrenceCount}× before, ${pct}% historical success rate)`,
      '',
      knownFix.description
    );
    if (knownFix.steps.length > 0) {
      parts.push('', 'Steps:', ...knownFix.steps.map((s) => `- ${s}`));
    }
  } else {
    parts.push(
      '',
      '## No known fix on record',
      '',
      'This exact failure has not been resolved before. Diagnose it from the evidence above — read',
      'the actual failing file(s), do not guess. Fix the ROOT CAUSE, not a symptom.'
    );
  }

  if (activeRules.length > 0) {
    parts.push('', '## Active governance rules to respect while fixing this', '', ...activeRules.map((r) => `- ${r}`));
  }

  parts.push(
    '',
    '## Verification',
    '',
    failedCheckName
      ? `After applying the fix, verify the '${failedCheckName}' check would now pass before finishing ` +
        'this prompt (re-run the equivalent command yourself if you can — e.g. `tsc --noEmit` for a ' +
        'typescript failure, the project build command for a build failure).'
      : 'After applying the fix, verify the failure no longer reproduces before finishing this prompt.',
    'Make the MINIMAL change that resolves this specific failure — do not refactor unrelated code.'
  );

  return parts.join('\n');
}

/**
 * Diagnose a Sentinel failure and produce a targeted recovery prompt, grounded in Build Memory's
 * accumulated error_patterns/resolutions/fix_patterns/governance_rules. Never throws — a total
 * Build Memory outage degrades to `escalate: true` with a generic (but still complete) recovery
 * prompt built from the raw failure evidence alone.
 */
export async function analyzeSentinelFailure(
  sentinel: SentinelResult,
  entry: QueueEntry,
  context: BrainContext
): Promise<BrainDiagnosis> {
  const { errorText, failedCheckName } = failureEvidence(sentinel);
  const signature = normalizeErrorSignature(errorText);
  const category = categorizeError(sentinel.failedCheck, errorText);
  const stackTags = deriveStackTags(context.stackFingerprint);
  const priorFailed = new Set(context.priorFailedSignaturesThisBuild ?? []);

  let rootCauseHypothesis = `A '${failedCheckName ?? 'sentinel'}' check failed, categorized as '${category}'.`;
  let knownFix: KnownFix | null = null;
  let confidence = 0.15;
  let occurrenceCount = 1;
  const activeRules: string[] = [];

  try {
    // 1. Exact signature match (src/memory) — the highest-fidelity source.
    const exactPattern: ErrorPattern | null = await BuildMemory.errors.findMatchingPattern(signature);
    if (exactPattern) {
      occurrenceCount = exactPattern.occurrence_count;
      rootCauseHypothesis =
        exactPattern.prevention_rule ??
        `Recurring '${exactPattern.error_category}' failure seen ${occurrenceCount}× before (first in "${exactPattern.first_seen_project}").`;

      const resolution = await BuildMemory.resolutions.getResolutionForPattern(exactPattern.id);
      if (resolution && resolution.resolution_description.trim() !== '') {
        const rate = resolution.times_applied > 0 ? resolution.times_succeeded / resolution.times_applied : 0;
        knownFix = { description: resolution.resolution_description, steps: stepsOf(resolution), historicalSuccessRate: rate };
        // Confidence tracks the fix's real track record, never claiming certainty.
        confidence = Math.min(0.95, Math.max(0.3, rate));
      } else {
        confidence = EXACT_MATCH_NO_HISTORY_CONFIDENCE;
      }
    } else {
      // 2. Category + stack fallback (learning schema fix_patterns) — a coarser signal. Uses the
      // learning schema's OWN fingerprint scheme (getErrorFingerprint), NOT the src/memory
      // `signature` (normalizeErrorSignature) — the two table families key their rows differently.
      const learningFingerprint = computeLearningFingerprint(errorText, category, context.stackFingerprint);
      const learningMatch = getFixPattern(learningFingerprint, undefined);
      if (learningMatch && learningMatch.fix_description) {
        const sim = signatureSimilarity(normalizeErrorSignature(learningMatch.error_message), signature);
        if (sim >= CATEGORY_SIMILARITY_FLOOR || learningMatch.error_category === mapCheckToLearningCategory(sentinel.failedCheck)) {
          occurrenceCount = learningMatch.occurrence_count;
          rootCauseHypothesis = `A similar '${learningMatch.error_category}' failure was seen ${occurrenceCount}× before (category/text match, not an exact signature).`;
          knownFix = {
            description: learningMatch.fix_description,
            steps: [],
            historicalSuccessRate: learningMatch.success_rate,
          };
          confidence = CATEGORY_MATCH_CONFIDENCE;
        }
      }
    }

    // 4. Active governance rules relevant to this stack — folded in as constraints, not a fix source.
    const rules = getGovernanceRules(stackTags, undefined, undefined);
    for (const r of rules.slice(0, 5)) activeRules.push(r.rule_text);
  } catch (error) {
    log(`WARNING: diagnosis degraded (${error instanceof Error ? error.message : String(error)}) — escalating`);
    confidence = 0;
    knownFix = null;
  }

  // A fix that already failed earlier in THIS build must not be proposed again (never steamroll).
  const repeatedFailureThisBuild = priorFailed.has(signature);
  if (repeatedFailureThisBuild) {
    rootCauseHypothesis = `${rootCauseHypothesis} This exact signature already failed to recover earlier in this build — the known fix is not resolving it here.`;
  }

  const escalate = confidence < ESCALATE_CONFIDENCE_THRESHOLD || repeatedFailureThisBuild;
  const effectiveKnownFix = repeatedFailureThisBuild ? null : knownFix;

  const recoveryPrompt = renderRecoveryPrompt({
    entry,
    errorText,
    failedCheckName,
    rootCauseHypothesis,
    knownFix: effectiveKnownFix,
    occurrenceCount,
    activeRules,
  });

  return {
    rootCauseHypothesis,
    confidence,
    knownFix: effectiveKnownFix,
    recoveryPrompt,
    escalate,
    signature,
  };
}
