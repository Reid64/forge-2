/**
 * FORGE 2.0 — System 1: Resurrection and Gap Intelligence Engine — public API.
 */

export { runGapAudit } from './gap-auditor.js';
export type {
  ArtifactName,
  ArtifactScore,
  AuditScope,
  AuditTrigger,
  ContinuationStep,
  Gap,
  GapAuditOptions,
  GapAuditResult,
  GapSeverity,
  HaltPoint,
  RegenerationTier,
} from './types.js';
export { ARTIFACT_NAMES, COMPOSITE_WEIGHTS, REGEN_THRESHOLDS } from './types.js';
export { scoreAll, scoreArtifact, meanComposite } from './artifact-scorer.js';
export { regenerate, regenerateAll } from './regeneration-engine.js';
export { evaluateGates, isArchitecturalGap } from './human-gate.js';
export { reconstructHaltPoint } from './halt-reconstructor.js';
export { buildContinuationPlan } from './continuation-planner.js';
