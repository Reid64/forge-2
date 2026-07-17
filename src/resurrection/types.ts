/**
 * FORGE 2.0 — System 1: Resurrection and Gap Intelligence Engine — type definitions.
 *
 * Column shapes mirror `upgrades/SCHEMA_ADDITIONS.md` §1-§2 (`gap_audit_runs`,
 * `artifact_health_scores`) exactly. See `src/memory/gap-audits.ts` for the CRUD layer.
 */

import type { ScanReport } from '../retrofit/types.js';

/** The nine governance artifacts System 1 scores (SCHEMA_ADDITIONS §2 CHECK constraint). */
export const ARTIFACT_NAMES = [
  'PRD',
  'SCHEMA_REGISTRY',
  'AGENTS',
  'BEHAVIORAL_CONTRACTS',
  'BLUEPRINT',
  'TOOLCHAIN',
  'SESSION_STATE',
  'STATE_OF_THE_BUILD',
  'TESTING',
] as const;

export type ArtifactName = (typeof ARTIFACT_NAMES)[number];

export type AuditTrigger = 'manual' | 'scheduled' | 'retrofit_entry' | 'halt_recovery' | 'post_build';
export type AuditScope = 'FULL' | 'GOVERNANCE_ONLY' | 'CODE_ONLY' | 'TARGETED';
export type GapAuditStatus = 'running' | 'completed' | 'failed' | 'halted_for_human';
export type GapSeverity = 'MINOR' | 'MAJOR' | 'CRITICAL';
export type RegenerationTier = 'AUTO' | 'HUMAN_GATE';

/** A single content gap detected by `governance-gaps.ts` against one artifact. */
export interface Gap {
  artifact: ArtifactName;
  severity: GapSeverity;
  kind: 'MISSING_SECTION' | 'DRIFT' | 'PLACEHOLDER' | 'CROSS_DOC_CONTRADICTION' | 'MISSING_DOC';
  message: string;
  section?: string;
  docSays?: string;
  codeShows?: string;
}

export interface DriftDetail {
  section: string;
  docSays: string;
  codeShows: string;
}

/** One `artifact_health_scores` row (SCHEMA_ADDITIONS §2). */
export interface ArtifactScore {
  id: string;
  gap_audit_run_id: string;
  artifact_name: ArtifactName;
  exists_on_disk: boolean;
  completeness_score: number;
  freshness_score: number;
  consistency_score: number;
  composite_score: number;
  drift_detected: boolean;
  drift_detail: DriftDetail[] | null;
  missing_sections: string[];
  placeholder_count: number;
  regeneration_recommended: boolean;
  regeneration_tier: RegenerationTier | null;
  scored_at: string;
  machine_id: string;
}

/** The exact halt point a prior build stopped at (F24). Every field is read, never guessed. */
export interface HaltPoint {
  buildRunId: string | null;
  promptIndex: number | null;
  promptName: string | null;
  failingCheck: string | null;
  subStepIndex: number | null;
  subStepName: string | null;
}

export type ContinuationStepKind = 'RESUME_PROMPT' | 'REQUIRES_HUMAN' | 'REGENERATE' | 'INFO';

export interface ContinuationStep {
  kind: ContinuationStepKind;
  description: string;
  artifact?: ArtifactName;
  promptIndex?: number;
}

/** One `gap_audit_runs` row (SCHEMA_ADDITIONS §1). */
export interface GapAuditRun {
  id: string;
  project_name: string;
  project_path: string;
  build_run_id: string | null;
  audit_trigger: AuditTrigger;
  scope: AuditScope;
  status: GapAuditStatus;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  artifacts_audited: ArtifactName[];
  gaps_found_total: number;
  gaps_minor: number;
  gaps_major: number;
  gaps_critical: number;
  gaps_auto_regenerated: number;
  gaps_human_gated: number;
  halt_point_reference: HaltPoint | null;
  continuation_plan: ContinuationStep[] | null;
  health_score_before: number | null;
  health_score_after: number | null;
  report_path: string | null;
  machine_id: string;
  created_at: string;
}

export interface GapAuditOptions {
  projectPath: string;
  scope?: AuditScope;
  trigger?: AuditTrigger;
  haltRecovery?: boolean;
  nonInteractive?: boolean;
  apiKey?: string;
  buildRunId?: string;
  /** TARGETED scope only: restrict scoring to these artifacts (derived from the halt point). */
  targetedArtifacts?: ArtifactName[];
}

export interface GapAuditResult {
  auditRunId: string;
  status: GapAuditStatus;
  scanReport: ScanReport | null;
  scores: ArtifactScore[];
  gaps: Gap[];
  healthScoreBefore: number | null;
  healthScoreAfter: number | null;
  haltPoint: HaltPoint | null;
  continuationPlan: ContinuationStep[];
  resumeEligible: boolean;
  reportPath: string | null;
}

/** `RESUME_FLOOR` and the AUTO/GATE thresholds — RESURRECTION_BLUEPRINT §ArtifactHealthScorer. */
export const COMPOSITE_WEIGHTS = { completeness: 0.45, freshness: 0.35, consistency: 0.2 } as const;
export const REGEN_THRESHOLDS = { AUTO_BELOW: 0.5, GATE_BELOW: 0.3, RESUME_FLOOR: 0.7 } as const;

export const WHOLESALE_ARTIFACTS: readonly ArtifactName[] = ['SESSION_STATE', 'STATE_OF_THE_BUILD', 'TOOLCHAIN'];
export const SECTION_SCOPED_ARTIFACTS: readonly ArtifactName[] = [
  'PRD',
  'BLUEPRINT',
  'BEHAVIORAL_CONTRACTS',
  'SCHEMA_REGISTRY',
  'AGENTS',
  'TESTING',
];

/** Filename on disk for each artifact (governance docs live at the project root). */
export const ARTIFACT_FILENAMES: Record<ArtifactName, string> = {
  PRD: 'PRD.md',
  SCHEMA_REGISTRY: 'SCHEMA_REGISTRY.md',
  AGENTS: 'AGENTS.md',
  BEHAVIORAL_CONTRACTS: 'BEHAVIORAL_CONTRACTS.md',
  BLUEPRINT: 'BLUEPRINT.md',
  TOOLCHAIN: 'TOOLCHAIN.md',
  SESSION_STATE: 'SESSION_STATE.md',
  STATE_OF_THE_BUILD: 'STATE_OF_THE_BUILD.md',
  TESTING: 'TESTING.md',
};

export interface RegenResult {
  artifact: ArtifactName;
  attempted: boolean;
  wrote: boolean;
  reason?: string;
  healthScoreBefore: number;
  healthScoreAfter: number | null;
}

export interface GateDecision {
  gap: Gap;
  approved: boolean;
  deferred: boolean;
}

export interface GateOutcome {
  decisions: GateDecision[];
  gatedCount: number;
  approvedCount: number;
  deferredCount: number;
  haltedForHuman: boolean;
}
