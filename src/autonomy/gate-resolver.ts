/**
 * FORGE 2.0 — Autonomy layer: AutonomousGateResolver (src/autonomy/gate-resolver.ts).
 *
 * Sits between ArtifactHealthScorer's scoring step and HumanGateEvaluator
 * (src/resurrection/human-gate.ts) in the GapAuditor pipeline. Where `isArchitecturalGap`
 * (human-gate.ts) only DECIDES which gaps are architectural, AutonomousGateResolver goes one
 * step further: for every gap that is NOT architectural, it actually invokes RegenerationEngine
 * (src/resurrection/regeneration-engine.ts) to resolve it, then re-scores the artifact and
 * escalates to human if the re-score did not actually improve — never fabricating a resolution
 * the code did not verify (Iron Law 3, "never claim something passes that has not been
 * verified").
 *
 * Rules (strictly enforced, mirroring Contract R-3's "architectural gaps are gated" posture and
 * `REGEN_THRESHOLDS.GATE_BELOW` from src/resurrection/types.ts):
 *
 *   - CRITICAL   → ALWAYS requires human, NEVER auto-resolved. A CRITICAL severity is how the
 *                  nine governance-gap detectors (src/resurrection/governance-gaps.ts) already
 *                  flag a missing table with no migration, a BEHAVIORAL_CONTRACTS-vs-code
 *                  contradiction, or a governance doc missing from disk entirely — this resolver
 *                  trusts that severity assignment and never re-evaluates it, the same posture
 *                  RegenerationEngine's own doc comment states for regeneration tier (R4).
 *   - MAJOR      → requires human when the artifact's composite_score is below
 *                  REGEN_THRESHOLDS.GATE_BELOW (0.3, "too degraded to auto-trust" — the same
 *                  threshold `isArchitecturalGap` uses); auto-resolves via RegenerationEngine at
 *                  or above that floor.
 *   - MINOR      → always attempts auto-resolution via RegenerationEngine.
 *
 * After any auto-resolution attempt, the artifact is re-scored (RegenerationEngine.regenerate
 * already does this internally and returns healthScoreBefore/healthScoreAfter). If the score did
 * not improve, the gap is escalated to human rather than reported as resolved — a regeneration
 * that "wrote a file but the health score didn't improve" is exactly the case
 * regeneration-engine.ts itself already treats as failed for the same Iron Law 3 reason.
 *
 * This mirrors the shape of Sentinel Prime's HaltDecision (src/sentinel-prime/types.ts) —
 * shouldHalt/reason/autoRecoverable/recoveryAction — with GateResolutionResult's
 * requiresHuman/reason/resolutionAction/wasAutoResolved playing the same role for a governance
 * gap as HaltDecision plays for a Phase 3 prompt's post-execution observation.
 */

import { createHash } from 'node:crypto';

import { getMachineId } from '../learning/database.js';
import { regenerate } from '../resurrection/regeneration-engine.js';
import type { ArtifactName, ArtifactScore, DriftDetail, Gap, GapSeverity } from '../resurrection/types.js';
import { REGEN_THRESHOLDS } from '../resurrection/types.js';
import type { ScanReport } from '../retrofit/types.js';

/**
 * The outcome of running one gap through AutonomousGateResolver. One of these is returned per
 * input gap, in the same order the gaps were passed to `resolveGaps`.
 */
export interface GateResolutionResult {
  /** Stable, deterministic identifier for this gap (see `computeGapId`) — Gap itself has no id. */
  gapId: string;
  /** The artifact this gap belongs to, carried through for convenient downstream partitioning. */
  artifact: ArtifactName;
  severity: GapSeverity;
  /** True only when RegenerationEngine actually wrote a change AND the re-score improved. */
  wasAutoResolved: boolean;
  /**
   * Short machine-readable label for what happened, e.g. `'regeneration_engine'`,
   * `'deferred_to_human_critical'`, `'deferred_to_human_low_composite_score'`,
   * `'deferred_to_human_no_improvement'`, `'deferred_to_human_insufficient_context'`,
   * `'deferred_to_human_regeneration_failed'`.
   */
  resolutionAction: string;
  /** True whenever this gap must go to HumanGateEvaluator instead of being auto-resolved. */
  requiresHuman: boolean;
  /** Human-readable explanation of the decision, always populated. */
  reason: string;
  /** Composite score before the regeneration attempt, when one was made. */
  healthScoreBefore?: number;
  /** Composite score after the regeneration attempt (or re-score), when one was made. */
  healthScoreAfter?: number | null;
}

/**
 * Options for `AutonomousGateResolver.resolveGaps`. `nonInteractive` and `compositeScore` are
 * the two fields every call must supply; the rest are optional live-pipeline context that, when
 * present, let this resolver actually invoke RegenerationEngine instead of merely deferring.
 */
export interface ResolveGapsOptions {
  /**
   * Whether the surrounding audit is running non-interactively. AutonomousGateResolver never
   * prompts a human itself (that is HumanGateEvaluator's job) — this flag is threaded through
   * so callers and logs can record the mode a resolution decision was made under.
   */
  nonInteractive: boolean;
  /**
   * The composite score used for the MAJOR-severity gate-floor comparison
   * (`REGEN_THRESHOLDS.GATE_BELOW`). Typically the artifact's own `composite_score` from
   * ArtifactHealthScorer, or a build-wide mean composite when scoring a batch of gaps that span
   * multiple artifacts.
   */
  compositeScore: number;
  /** Required to actually call RegenerationEngine. Without it, auto-resolvable gaps defer to human. */
  projectPath?: string;
  /** Required to actually call RegenerationEngine (Contract R-2's in-flight-build check). */
  projectName?: string;
  /** Passed straight through to RegenerationEngine's wholesale-artifact renderers. */
  scanReport?: ScanReport | null;
  /** The parent gap_audit_runs id, for RegenerationEngine's re-score bookkeeping. */
  gapAuditRunId?: string;
  /** Current governance doc contents, keyed by artifact — same shape GapAuditor already builds. */
  allDocs?: Partial<Record<ArtifactName, string>>;
  /** Already-computed ArtifactScore rows (from ArtifactHealthScorer), when available. */
  scores?: ArtifactScore[];
}

/**
 * A stable, deterministic id for a Gap. `Gap` itself carries no id (it is a pure detector
 * output), so callers that need to correlate a `GateResolutionResult` back to its originating
 * `Gap` — or de-duplicate the same gap seen across two audit passes — need something to key on.
 * Built from the gap's artifact, kind, section, and a short hash of its message so two
 * structurally identical gaps produce the same id.
 */
export function computeGapId(gap: Gap): string {
  const hash = createHash('sha256')
    .update(`${gap.artifact}|${gap.kind}|${gap.section ?? ''}|${gap.message}`)
    .digest('hex')
    .slice(0, 12);
  return `${gap.artifact}:${gap.kind}:${hash}`;
}

/**
 * A minimal, honest ArtifactScore stand-in for when the caller did not supply a matching
 * `ArtifactScore` row for this gap's artifact. Every numeric field is set to the supplied
 * composite score (the best signal this resolver actually has) rather than a fabricated value —
 * RegenerationEngine only reads `regeneration_tier`, `missing_sections`, and `drift_detail` off
 * this object to decide what to write, so the completeness/freshness/consistency breakdown is
 * informational only in this fallback path.
 */
function buildFallbackArtifactScore(gap: Gap, compositeScore: number, gapAuditRunId: string, machineId: string): ArtifactScore {
  return {
    id: `gate-resolver-fallback-${gap.artifact}-${computeGapId(gap)}`,
    gap_audit_run_id: gapAuditRunId,
    artifact_name: gap.artifact,
    exists_on_disk: true,
    completeness_score: compositeScore,
    freshness_score: compositeScore,
    consistency_score: compositeScore,
    composite_score: compositeScore,
    drift_detected: false,
    drift_detail: null,
    missing_sections: [],
    placeholder_count: 0,
    regeneration_recommended: true,
    regeneration_tier: 'AUTO',
    scored_at: new Date().toISOString(),
    machine_id: machineId,
  };
}

/**
 * Narrow a base ArtifactScore (found or fallback) down to exactly the gap at hand: ensures the
 * gap's own missing section / drift detail is represented so RegenerationEngine's section-scoped
 * write path actually addresses THIS gap, and forces `regeneration_tier: 'AUTO'` — this function
 * is only ever called once the CRITICAL/MAJOR-floor checks above have already decided the gap is
 * eligible for auto-resolution, so acting on that decision here (rather than re-deriving it) is
 * the correct, non-duplicated place for it.
 */
function scopeArtifactScoreToGap(base: ArtifactScore, gap: Gap): ArtifactScore {
  const missingSections = new Set(base.missing_sections);
  let driftDetail: DriftDetail[] | null = base.drift_detail ? [...base.drift_detail] : null;

  if (gap.kind === 'MISSING_SECTION' && gap.section) {
    missingSections.add(gap.section);
  }

  if (gap.kind === 'DRIFT' && gap.section) {
    const detail: DriftDetail = { section: gap.section, docSays: gap.docSays ?? '', codeShows: gap.codeShows ?? '' };
    driftDetail = driftDetail ? [...driftDetail, detail] : [detail];
  }

  return {
    ...base,
    regeneration_tier: 'AUTO',
    missing_sections: [...missingSections],
    drift_detail: driftDetail,
    drift_detected: driftDetail !== null && driftDetail.length > 0,
  };
}

/** Find (or fabricate) the ArtifactScore RegenerationEngine needs to act on this gap's artifact. */
function resolveArtifactScoreForGap(gap: Gap, options: ResolveGapsOptions, machineId: string): ArtifactScore {
  const found = options.scores?.find((s) => s.artifact_name === gap.artifact);
  const base = found ?? buildFallbackArtifactScore(gap, options.compositeScore, options.gapAuditRunId ?? 'gate-resolver-adhoc', machineId);
  return scopeArtifactScoreToGap(base, gap);
}

/**
 * Autonomous, non-interactive resolver for governance gaps. Wired into
 * `src/resurrection/gap-auditor.ts` immediately after `scoreAll` (the ArtifactHealthScorer step)
 * and before `evaluateGates` (HumanGateEvaluator) — see `gap-auditor.ts`'s `runGapAudit` for the
 * live wiring. Every method is safe to call repeatedly and never mutates its inputs.
 */
export class AutonomousGateResolver {
  /**
   * Resolve every gap in `gaps`, returning one `GateResolutionResult` per gap in the same order.
   * CRITICAL gaps are decided immediately with no side effects. MAJOR/MINOR gaps eligible for
   * auto-resolution are processed sequentially (never in parallel) so two gaps on the same
   * artifact don't race a concurrent write to the same governance file.
   */
  async resolveGaps(gaps: readonly Gap[], options: ResolveGapsOptions): Promise<GateResolutionResult[]> {
    const machineId = getMachineId();
    const results: GateResolutionResult[] = [];

    for (const gap of gaps) {
      if (gap.severity === 'CRITICAL') {
        results.push(this.deferCritical(gap));
        continue;
      }

      if (gap.severity === 'MAJOR') {
        if (options.compositeScore < REGEN_THRESHOLDS.GATE_BELOW) {
          results.push(this.deferLowComposite(gap, options.compositeScore));
          continue;
        }
        // eslint-disable-next-line no-console
        console.log(`[GATE RESOLVER] Auto-resolving MAJOR gap: ${gap.artifact} — ${gap.message}`);
        results.push(await this.attemptAutoResolve(gap, options, machineId));
        continue;
      }

      // MINOR always auto-resolves.
      // eslint-disable-next-line no-console
      console.log(`[GATE RESOLVER] Auto-resolving MINOR gap: ${gap.artifact} — ${gap.message}`);
      results.push(await this.attemptAutoResolve(gap, options, machineId));
    }

    return results;
  }

  /** CRITICAL is never auto-resolved — Contract R-3, the fifth structural human gate. */
  private deferCritical(gap: Gap): GateResolutionResult {
    return {
      gapId: computeGapId(gap),
      artifact: gap.artifact,
      severity: gap.severity,
      wasAutoResolved: false,
      resolutionAction: 'deferred_to_human_critical',
      requiresHuman: true,
      reason:
        'CRITICAL gaps are never auto-resolved — architectural changes (a missing table with no ' +
        'migration, a BEHAVIORAL_CONTRACTS violation, or a governance doc missing entirely from ' +
        'disk) always require human approval (Contract R-3).',
    };
  }

  /** MAJOR on a too-degraded artifact (composite_score below the gate floor) requires human. */
  private deferLowComposite(gap: Gap, compositeScore: number): GateResolutionResult {
    return {
      gapId: computeGapId(gap),
      artifact: gap.artifact,
      severity: gap.severity,
      wasAutoResolved: false,
      resolutionAction: 'deferred_to_human_low_composite_score',
      requiresHuman: true,
      reason:
        `MAJOR gap on an artifact whose composite_score (${compositeScore.toFixed(3)}) is below the ` +
        `${REGEN_THRESHOLDS.GATE_BELOW} gate floor — too degraded to auto-trust.`,
      healthScoreBefore: compositeScore,
    };
  }

  /**
   * Actually invoke RegenerationEngine for a gap already decided to be eligible for
   * auto-resolution (MINOR, or MAJOR at/above the gate floor). Degrades honestly to a human
   * deferral — never a fabricated success — whenever the required project context is missing,
   * the write itself fails, or the write happened but the re-score did not improve.
   */
  private async attemptAutoResolve(gap: Gap, options: ResolveGapsOptions, machineId: string): Promise<GateResolutionResult> {
    const gapId = computeGapId(gap);

    if (!options.projectPath || !options.projectName) {
      return {
        gapId,
        artifact: gap.artifact,
        severity: gap.severity,
        wasAutoResolved: false,
        resolutionAction: 'deferred_to_human_insufficient_context',
        requiresHuman: true,
        reason:
          'RegenerationEngine requires projectPath and projectName to run — neither was supplied, ' +
          'so this gap is deferred to human rather than fabricating a resolution (Iron Law 3).',
      };
    }

    const score = resolveArtifactScoreForGap(gap, options, machineId);

    const regenResult = await regenerate({
      projectPath: options.projectPath,
      projectName: options.projectName,
      artifact: gap.artifact,
      score,
      scanReport: options.scanReport ?? null,
      gapAuditRunId: options.gapAuditRunId ?? 'gate-resolver-adhoc',
      allDocs: options.allDocs ?? {},
      humanApproved: false,
    });

    if (!regenResult.wrote) {
      return {
        gapId,
        artifact: gap.artifact,
        severity: gap.severity,
        wasAutoResolved: false,
        resolutionAction: 'deferred_to_human_regeneration_failed',
        requiresHuman: true,
        reason: regenResult.reason ?? 'RegenerationEngine did not write a change for this gap.',
        healthScoreBefore: regenResult.healthScoreBefore,
        healthScoreAfter: regenResult.healthScoreAfter,
      };
    }

    const improved = regenResult.healthScoreAfter !== null && regenResult.healthScoreAfter > regenResult.healthScoreBefore;

    if (!improved) {
      return {
        gapId,
        artifact: gap.artifact,
        severity: gap.severity,
        wasAutoResolved: false,
        resolutionAction: 'deferred_to_human_no_improvement',
        requiresHuman: true,
        reason:
          `RegenerationEngine wrote ${gap.artifact}.md but the re-scored composite ` +
          `(${regenResult.healthScoreAfter ?? 'n/a'}) did not improve on the prior score ` +
          `(${regenResult.healthScoreBefore.toFixed(3)}) — escalated to human per the re-score rule.`,
        healthScoreBefore: regenResult.healthScoreBefore,
        healthScoreAfter: regenResult.healthScoreAfter,
      };
    }

    return {
      gapId,
      artifact: gap.artifact,
      severity: gap.severity,
      wasAutoResolved: true,
      resolutionAction: 'regeneration_engine',
      requiresHuman: false,
      reason:
        `RegenerationEngine regenerated ${gap.artifact}.md and the composite score improved from ` +
        `${regenResult.healthScoreBefore.toFixed(3)} to ${(regenResult.healthScoreAfter as number).toFixed(3)}.`,
      healthScoreBefore: regenResult.healthScoreBefore,
      healthScoreAfter: regenResult.healthScoreAfter,
    };
  }
}

/** Factory, matching the `create*` convention used throughout `src/sentinel-prime`/`src/orchestrator`. */
export function createAutonomousGateResolver(): AutonomousGateResolver {
  return new AutonomousGateResolver();
}

/** Split a result set into what was auto-resolved vs. what still needs a human — convenience for callers that only care about the partition, not the per-gap detail. */
export function partitionResolutions(results: readonly GateResolutionResult[]): {
  autoResolved: GateResolutionResult[];
  requiringHuman: GateResolutionResult[];
} {
  return {
    autoResolved: results.filter((r) => r.wasAutoResolved),
    requiringHuman: results.filter((r) => r.requiresHuman),
  };
}

/** One-line human-readable summary of a resolution batch, suitable for a build log line. */
export function summarizeResolutions(results: readonly GateResolutionResult[]): string {
  const { autoResolved, requiringHuman } = partitionResolutions(results);
  return `[GATE RESOLVER] ${results.length} gap(s) evaluated — ${autoResolved.length} auto-resolved, ${requiringHuman.length} deferred to human.`;
}
