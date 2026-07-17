/**
 * FORGE 2.0 — System 1: ArtifactHealthScorer (src/resurrection/artifact-scorer.ts).
 *
 * Scores each governance artifact on completeness/freshness/consistency, rolls them into
 * `composite_score`, and decides the regeneration tier. Read-only (Contract R-1) — writes
 * happen only via `src/memory/gap-audits.ts` (the Build Memory row), never to a project file.
 * See RESURRECTION_BLUEPRINT.md §ArtifactHealthScorer for the exact formula this implements.
 */

import { getMachineId } from '../learning/database.js';
import { createArtifactScore } from '../memory/gap-audits.js';
import type { ScanReport } from '../retrofit/types.js';
import { detectGapsForArtifact, findGovernanceDoc, REQUIRED_SECTIONS } from './governance-gaps.js';
import type { ArtifactName, ArtifactScore, Gap, RegenerationTier } from './types.js';
import { ARTIFACT_NAMES, COMPOSITE_WEIGHTS, REGEN_THRESHOLDS } from './types.js';

export { COMPOSITE_WEIGHTS, REGEN_THRESHOLDS };

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export interface ScoreArtifactInput {
  projectPath: string;
  artifact: ArtifactName;
  gapAuditRunId: string;
  scanReport: ScanReport | null;
  allDocs: Partial<Record<ArtifactName, string>>;
}

export interface ScoredArtifact {
  score: ArtifactScore;
  gaps: Gap[];
}

/** Score a single artifact and persist the `artifact_health_scores` row. */
export async function scoreArtifact(input: ScoreArtifactInput): Promise<ScoredArtifact> {
  const { projectPath, artifact, gapAuditRunId, scanReport, allDocs } = input;
  const machineId = getMachineId();
  const doc = findGovernanceDoc(projectPath, artifact);

  if (!doc) {
    const gap: Gap = {
      artifact,
      severity: 'CRITICAL',
      kind: 'MISSING_DOC',
      message: `${artifact} governance document does not exist on disk`,
    };
    const score = await persistScore({
      gap_audit_run_id: gapAuditRunId,
      artifact_name: artifact,
      exists_on_disk: false,
      completeness_score: 0,
      freshness_score: 0,
      consistency_score: 0,
      composite_score: 0,
      drift_detected: false,
      drift_detail: null,
      missing_sections: [...REQUIRED_SECTIONS[artifact]],
      placeholder_count: 0,
      regeneration_recommended: true,
      regeneration_tier: 'HUMAN_GATE',
      machine_id: machineId,
    });
    return { score, gaps: [gap] };
  }

  const detected = detectGapsForArtifact(projectPath, artifact, doc.content, scanReport, allDocs);
  const required = REQUIRED_SECTIONS[artifact];

  const rawCompleteness =
    (required.length - detected.missingSections.length) / Math.max(1, required.length) -
    detected.placeholderCount * 0.05;
  const completeness_score = clamp01(rawCompleteness);

  const driftChecksTotal = Math.max(1, detected.driftDetail.length + 1);
  const freshness_score = clamp01(1 - detected.driftDetail.length / driftChecksTotal);

  const contradictions = detected.gaps.filter((g) => g.kind === 'CROSS_DOC_CONTRADICTION').length;
  const consistencyChecksTotal = Math.max(1, contradictions + 1);
  const consistency_score = clamp01(1 - contradictions / consistencyChecksTotal);

  const composite_score = clamp01(
    COMPOSITE_WEIGHTS.completeness * completeness_score +
      COMPOSITE_WEIGHTS.freshness * freshness_score +
      COMPOSITE_WEIGHTS.consistency * consistency_score
  );

  const hasCritical = detected.gaps.some((g) => g.severity === 'CRITICAL');
  const hasMajorOnDegraded = detected.gaps.some((g) => g.severity === 'MAJOR') && composite_score < REGEN_THRESHOLDS.GATE_BELOW;
  const onlyMinor = detected.gaps.length > 0 && detected.gaps.every((g) => g.severity === 'MINOR');

  let regeneration_tier: RegenerationTier | null = null;
  let regeneration_recommended = false;
  if (composite_score < REGEN_THRESHOLDS.GATE_BELOW || hasCritical || hasMajorOnDegraded) {
    regeneration_tier = 'HUMAN_GATE';
    regeneration_recommended = true;
  } else if (composite_score < REGEN_THRESHOLDS.AUTO_BELOW || onlyMinor) {
    regeneration_tier = 'AUTO';
    regeneration_recommended = detected.gaps.length > 0;
    if (!regeneration_recommended) regeneration_tier = null;
  }

  const score = await persistScore({
    gap_audit_run_id: gapAuditRunId,
    artifact_name: artifact,
    exists_on_disk: true,
    completeness_score,
    freshness_score,
    consistency_score,
    composite_score,
    drift_detected: detected.driftDetail.length > 0,
    drift_detail: detected.driftDetail.length > 0 ? detected.driftDetail : null,
    missing_sections: detected.missingSections,
    placeholder_count: detected.placeholderCount,
    regeneration_recommended,
    regeneration_tier,
    machine_id: machineId,
  });

  return { score, gaps: detected.gaps };
}

async function persistScore(input: Omit<ArtifactScore, 'id' | 'scored_at'>): Promise<ArtifactScore> {
  const persisted = await createArtifactScore(input);
  if (persisted) return persisted;
  // Build Memory unavailable — degrade gracefully with an in-memory-only row (Contract 4).
  return { ...input, id: 'unpersisted', scored_at: new Date().toISOString() };
}

/** Score every in-scope artifact and return the flat list of scores + gaps. */
export async function scoreAll(
  projectPath: string,
  gapAuditRunId: string,
  scanReport: ScanReport | null,
  inScope: readonly ArtifactName[] = ARTIFACT_NAMES
): Promise<{ scores: ArtifactScore[]; gaps: Gap[] }> {
  const allDocs: Partial<Record<ArtifactName, string>> = {};
  for (const artifact of inScope) {
    const doc = findGovernanceDoc(projectPath, artifact);
    if (doc) allDocs[artifact] = doc.content;
  }

  const scores: ArtifactScore[] = [];
  const gaps: Gap[] = [];
  for (const artifact of inScope) {
    const result = await scoreArtifact({ projectPath, artifact, gapAuditRunId, scanReport, allDocs });
    scores.push(result.score);
    gaps.push(...result.gaps);
  }
  return { scores, gaps };
}

export function meanComposite(scores: readonly ArtifactScore[]): number | null {
  if (scores.length === 0) return null;
  const sum = scores.reduce((acc, s) => acc + s.composite_score, 0);
  return sum / scores.length;
}
