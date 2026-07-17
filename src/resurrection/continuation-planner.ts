/**
 * FORGE 2.0 — System 1: continuation-planner (sub-module of GapAuditor).
 *
 * Turns the halt point + gate/regeneration outcomes into the ordered `continuation_plan`
 * persisted on `gap_audit_runs`. Pure — no I/O.
 */

import type { ArtifactScore, ContinuationStep, GateOutcome, HaltPoint, RegenResult } from './types.js';

export interface BuildContinuationPlanInput {
  haltPoint: HaltPoint | null;
  regenResults: RegenResult[];
  gateOutcome: GateOutcome | null;
  scores: ArtifactScore[];
  resumeEligible: boolean;
  resumeBlockedReason: string | null;
}

export function buildContinuationPlan(input: BuildContinuationPlanInput): ContinuationStep[] {
  const steps: ContinuationStep[] = [];

  for (const r of input.regenResults) {
    if (r.wrote) {
      steps.push({ kind: 'REGENERATE', description: `Regenerated ${r.artifact} (health ${r.healthScoreBefore.toFixed(2)} → ${(r.healthScoreAfter ?? 0).toFixed(2)})`, artifact: r.artifact });
    } else if (r.attempted) {
      steps.push({ kind: 'INFO', description: `${r.artifact} regeneration skipped: ${r.reason ?? 'unknown reason'}`, artifact: r.artifact });
    }
  }

  if (input.gateOutcome) {
    for (const decision of input.gateOutcome.decisions) {
      if (decision.deferred) {
        steps.push({
          kind: 'REQUIRES_HUMAN',
          description: `${decision.gap.artifact}: ${decision.gap.message}`,
          artifact: decision.gap.artifact,
        });
      }
    }
  }

  if (input.haltPoint?.promptIndex !== null && input.haltPoint?.promptIndex !== undefined) {
    if (input.resumeEligible) {
      steps.push({
        kind: 'RESUME_PROMPT',
        description: `Resume build ${input.haltPoint.buildRunId ?? '(unknown)'} at prompt ${input.haltPoint.promptIndex} (${input.haltPoint.promptName ?? 'unnamed'})` +
          (input.haltPoint.failingCheck ? `, which failed check "${input.haltPoint.failingCheck}"` : ''),
        promptIndex: input.haltPoint.promptIndex,
      });
    } else {
      steps.push({
        kind: 'INFO',
        description: `Resume blocked: ${input.resumeBlockedReason ?? 'resume floor not met (composite < 0.70 or critical gaps remain)'}`,
      });
    }
  }

  if (steps.length === 0) {
    steps.push({ kind: 'INFO', description: 'No gaps required action — governance is healthy.' });
  }

  return steps;
}
