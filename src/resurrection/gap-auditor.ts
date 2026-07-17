/**
 * FORGE 2.0 — System 1: GapAuditor (src/resurrection/gap-auditor.ts).
 *
 * Orchestrates a full gap audit: ForgeRetrofit scan+DIAGNOSE → nine governance gap detectors →
 * ArtifactHealthScorer → RegenerationEngine (AUTO) / HumanGateEvaluator (HUMAN_GATE) →
 * halt-reconstructor → continuation-planner → one `gap_audit_runs` row. Strictly read-only
 * itself (Contract R-1) — only `RegenerationEngine` ever writes a governance file.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { getMachineId } from '../learning/database.js';
import { createGapAuditRun, getArtifactScoresForRun, updateGapAuditRun } from '../memory/gap-audits.js';
import { buildEnterprisePatternsGapReport, buildGovernanceReconciliationReport, generateArchitectureHealthReport } from '../retrofit/diagnose.js';
import { runScan } from '../retrofit/scan.js';
import type { ScanReport, ScanScope } from '../retrofit/types.js';
import { meanComposite, scoreAll } from './artifact-scorer.js';
import { findGovernanceDoc } from './governance-gaps.js';
import { buildContinuationPlan } from './continuation-planner.js';
import { reconstructHaltPoint } from './halt-reconstructor.js';
import { evaluateGates, isArchitecturalGap } from './human-gate.js';
import { regenerateAll } from './regeneration-engine.js';
import type {
  ArtifactName,
  ArtifactScore,
  AuditScope,
  Gap,
  GapAuditOptions,
  GapAuditResult,
  HaltPoint,
} from './types.js';
import { ARTIFACT_NAMES, REGEN_THRESHOLDS } from './types.js';

/** Map System 1's audit scope to ForgeRetrofit's scan scope (CLI scope semantics table). */
function toScanScope(scope: AuditScope): ScanScope {
  return scope === 'FULL' ? 'C' : 'A';
}

/** Best-effort mapping from a failing Sentinel check name to the artifacts it implicates. */
function artifactsForFailingCheck(failingCheck: string | null): ArtifactName[] {
  if (!failingCheck) return [...ARTIFACT_NAMES];
  const map: Record<string, ArtifactName[]> = {
    'schema-drift': ['SCHEMA_REGISTRY'],
    'dependency-manifest': ['TOOLCHAIN'],
    file_delta: ['STATE_OF_THE_BUILD', 'SESSION_STATE'],
    tsc: ['BLUEPRINT'],
    build: ['BLUEPRINT'],
  };
  return map[failingCheck] ?? [...ARTIFACT_NAMES];
}

function computeArtifactsInScope(options: GapAuditOptions, haltPoint: HaltPoint | null): ArtifactName[] {
  const scope = options.scope ?? 'FULL';
  if (scope === 'CODE_ONLY') return [];
  if (scope === 'TARGETED') {
    if (options.targetedArtifacts && options.targetedArtifacts.length > 0) return options.targetedArtifacts;
    return artifactsForFailingCheck(haltPoint?.failingCheck ?? null);
  }
  return [...ARTIFACT_NAMES];
}

function writeReport(projectPath: string, result: GapAuditResult, projectName: string): string {
  const dir = join(projectPath, '.forge');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'gap_audit_report.md');
  const lines: string[] = [
    `# ${projectName} — Gap Audit Report`,
    '',
    `Generated: ${new Date().toISOString()}`,
    `Status: ${result.status}`,
    `Health score: ${result.healthScoreBefore?.toFixed(3) ?? 'n/a'} → ${result.healthScoreAfter?.toFixed(3) ?? 'n/a'}`,
    `Resume eligible: ${result.resumeEligible ? 'yes' : 'no'}`,
    '',
    '## Artifact Scores',
    '',
  ];
  for (const s of result.scores) {
    lines.push(`- **${s.artifact_name}** — composite ${s.composite_score.toFixed(2)} (exists: ${s.exists_on_disk ? 'yes' : 'no'}, tier: ${s.regeneration_tier ?? 'none'})`);
  }
  lines.push('', '## Gaps', '');
  for (const g of result.gaps) {
    lines.push(`- [${g.severity}] **${g.artifact}** (${g.kind}): ${g.message}`);
  }
  lines.push('', '## Continuation Plan', '');
  for (const step of result.continuationPlan) {
    lines.push(`- [${step.kind}] ${step.description}`);
  }
  writeFileSync(path, lines.join('\n'), 'utf8');
  return path;
}

/** `forge audit <project-path>` entry point. */
export async function runGapAudit(options: GapAuditOptions): Promise<GapAuditResult> {
  const start = Date.now();
  const projectName = basename(options.projectPath) || 'unknown';
  const scope = options.scope ?? 'FULL';
  const trigger = options.trigger ?? 'manual';
  const machineId = getMachineId();

  const run = await createGapAuditRun({
    project_name: projectName,
    project_path: options.projectPath,
    build_run_id: options.buildRunId ?? null,
    audit_trigger: trigger,
    scope,
    machine_id: machineId,
  });
  const auditRunId = run?.id ?? `unpersisted-${Date.now()}`;

  let scanReport: ScanReport | null = null;
  try {
    const scanResult = await runScan({ projectPath: options.projectPath, scope: toScanScope(scope) });
    scanReport = scanResult.report;
  } catch {
    scanReport = null;
  }

  // DIAGNOSE builders — code-structural findings, informing freshness/drift only indirectly
  // (System 1 adds no second scanner — R5); their output is not persisted here, only consumed.
  if (scanReport) {
    try {
      await generateArchitectureHealthReport(scanReport, options.apiKey);
      buildGovernanceReconciliationReport(scanReport, options.projectPath);
      buildEnterprisePatternsGapReport(scanReport, options.projectPath);
    } catch {
      /* DIAGNOSE is best-effort context; a failure here never halts the audit */
    }
  }

  let haltPoint: HaltPoint | null = null;
  if (options.haltRecovery || scope === 'TARGETED') {
    haltPoint = await reconstructHaltPoint({
      projectPath: options.projectPath,
      projectName,
      buildRunId: options.buildRunId,
    });
  }

  const inScope = computeArtifactsInScope(options, haltPoint);
  let scores: ArtifactScore[] = [];
  let gaps: Gap[] = [];
  if (inScope.length > 0) {
    const scored = await scoreAll(options.projectPath, auditRunId, scanReport, inScope);
    scores = scored.scores;
    gaps = scored.gaps;
  }

  const healthScoreBefore = meanComposite(scores);

  const allDocs: Partial<Record<ArtifactName, string>> = {};
  for (const artifact of inScope) {
    const doc = findGovernanceDoc(options.projectPath, artifact);
    if (doc) allDocs[artifact] = doc.content;
  }

  // Partition: AUTO tier -> RegenerationEngine; HUMAN_GATE tier -> HumanGateEvaluator.
  const scoreByArtifact = new Map(scores.map((s) => [s.artifact_name, s]));
  const gatedGaps = gaps.filter((g) => isArchitecturalGap(g, scoreByArtifact.get(g.artifact)));

  const gateOutcome = gatedGaps.length > 0 ? await evaluateGates(gatedGaps, { nonInteractive: options.nonInteractive }) : null;
  const humanApprovedArtifacts = (gateOutcome?.decisions ?? []).filter((d) => d.approved).map((d) => d.gap.artifact);

  const regenResults = await regenerateAll({
    projectPath: options.projectPath,
    projectName,
    scores,
    scanReport,
    gapAuditRunId: auditRunId,
    allDocs,
    humanApprovedArtifacts,
  });

  // Re-score regenerated artifacts for health_score_after.
  const regeneratedNames = new Set(regenResults.filter((r) => r.wrote).map((r) => r.artifact));
  let finalScores = scores;
  if (regeneratedNames.size > 0) {
    const rescored = await scoreAll(options.projectPath, auditRunId, scanReport, [...regeneratedNames]);
    const byName = new Map(rescored.scores.map((s) => [s.artifact_name, s]));
    finalScores = scores.map((s) => byName.get(s.artifact_name) ?? s);
  }
  const healthScoreAfter = regeneratedNames.size > 0 ? meanComposite(finalScores) : healthScoreBefore;

  const gapsCritical = gaps.filter((g) => g.severity === 'CRITICAL').length;
  const resumeEligible =
    (healthScoreAfter ?? 0) >= REGEN_THRESHOLDS.RESUME_FLOOR && gapsCritical === 0 && !(gateOutcome?.haltedForHuman ?? false);
  const resumeBlockedReason = resumeEligible
    ? null
    : gateOutcome?.haltedForHuman
      ? 'halted for human — architectural gaps await approval'
      : gapsCritical > 0
        ? `${gapsCritical} unresolved CRITICAL gap(s)`
        : `mean composite_score ${(healthScoreAfter ?? 0).toFixed(2)} below the 0.70 resume floor`;

  const continuationPlan = buildContinuationPlan({
    haltPoint,
    regenResults,
    gateOutcome,
    scores: finalScores,
    resumeEligible,
    resumeBlockedReason,
  });

  const status = gateOutcome?.haltedForHuman ? 'halted_for_human' : 'completed';

  const result: GapAuditResult = {
    auditRunId,
    status,
    scanReport,
    scores: finalScores,
    gaps,
    healthScoreBefore,
    healthScoreAfter,
    haltPoint,
    continuationPlan,
    resumeEligible,
    reportPath: null,
  };

  const reportPath = writeReport(options.projectPath, result, projectName);
  result.reportPath = reportPath;

  await updateGapAuditRun(auditRunId, {
    status,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - start,
    artifacts_audited: inScope,
    gaps_found_total: gaps.length,
    gaps_minor: gaps.filter((g) => g.severity === 'MINOR').length,
    gaps_major: gaps.filter((g) => g.severity === 'MAJOR').length,
    gaps_critical: gapsCritical,
    gaps_auto_regenerated: regenResults.filter((r) => r.wrote).length,
    gaps_human_gated: gateOutcome?.gatedCount ?? 0,
    halt_point_reference: haltPoint,
    continuation_plan: continuationPlan,
    health_score_before: healthScoreBefore,
    health_score_after: healthScoreAfter,
    report_path: reportPath,
  });

  // Re-fetch the persisted scores (in case Build Memory assigned real ids) for callers that
  // want the authoritative row set.
  const persisted = await getArtifactScoresForRun(auditRunId);
  if (persisted && persisted.length > 0) result.scores = persisted;

  return result;
}
