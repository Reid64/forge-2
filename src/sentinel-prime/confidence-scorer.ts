/**
 * FORGE 2.0 — System 5: Sentinel Prime — ConfidenceScorer.
 *
 * Combines the three independent Sentinel Prime signals — ExecutionMonitor (HOW the prompt ran),
 * DecisionValidator (WHAT the diff actually fulfilled), GovernanceEnforcer (does the diff
 * contradict a numbered BEHAVIORAL_CONTRACTS.md contract) — into one weighted composite confidence
 * score, then turns that score into a halt/continue decision. Never throws (Iron Law 3): every
 * input is already a fully-formed result object from its own module, so scoring is pure arithmetic.
 *
 * Persistence (`persistSentinelRun`) writes the full run to `sentinel_prime_runs` and every
 * recorded `ObservationEvent` violation to `validation_events`, mirroring Contract 4 (Build Memory
 * writes are never a halting error) — a database failure is logged and swallowed, never thrown.
 */

import { getClient, logMemoryWarning, toJsonText, toSqliteBool } from '../memory/client.js';
import {
  EventSeverity,
  type ConfidenceScore,
  type ExecutionMonitorResult,
  type GovernanceEnforcerResult,
  type HaltDecision,
  type SentinelPrimeRunResult,
  type ValidationResult,
} from './types.js';

/** Relative weight of each signal in the composite confidence score. Sums to 1.0. */
export const SENTINEL_WEIGHTS = {
  execution: 0.35,
  validation: 0.40,
  governance: 0.25,
} as const;

/** Composite score below which a halt is recommended regardless of the individual signals. */
const HALT_COMPOSITE_THRESHOLD = 0.4;

/** Composite score floor for a halted run to still be considered auto-recoverable. */
const AUTO_RECOVER_COMPOSITE_FLOOR = 0.3;

/** Clamp a number into `[0, 1]`. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Combine the three Sentinel Prime signals into one weighted composite confidence score.
 *
 * - `executionScore`: 1.0 when ExecutionMonitor passed clean; otherwise 1.0 minus 0.25 per
 *   recorded violation (out-of-scope write, destructive command, ...), floored at 0.
 * - `validationScore`: DecisionValidator's own `intentFulfillmentScore`, clamped defensively.
 * - `governanceScore`: 1.0 when GovernanceEnforcer found no contradiction; otherwise 1.0 minus
 *   0.30 per contract violation, floored at 0.
 * - `haltRecommended`: true when the composite falls below 0.4, OR any execution violation is
 *   HALT-severity, OR any governance contract violation was recorded — any one of these alone is
 *   sufficient, regardless of how high the composite otherwise scores.
 */
export function scoreConfidence(
  executionResult: ExecutionMonitorResult,
  validationResult: ValidationResult,
  governanceResult: GovernanceEnforcerResult
): ConfidenceScore {
  const executionScore = clamp01(
    executionResult.passed ? 1.0 : Math.max(0, 1.0 - executionResult.violations.length * 0.25)
  );
  const validationScore = clamp01(validationResult.intentFulfillmentScore);
  const governanceScore = clamp01(
    governanceResult.passed ? 1.0 : Math.max(0, 1.0 - governanceResult.contractViolations.length * 0.30)
  );

  const composite = clamp01(
    executionScore * SENTINEL_WEIGHTS.execution +
      validationScore * SENTINEL_WEIGHTS.validation +
      governanceScore * SENTINEL_WEIGHTS.governance
  );

  const hasHaltSeverityViolation = executionResult.violations.some(
    (violation) => violation.severity === EventSeverity.HALT
  );
  const haltRecommended =
    composite < HALT_COMPOSITE_THRESHOLD ||
    hasHaltSeverityViolation ||
    governanceResult.contractViolations.length > 0;

  return { composite, executionScore, validationScore, governanceScore, haltRecommended };
}

/**
 * Turn a {@link ConfidenceScore} into a concrete halt/continue decision.
 *
 * `autoRecoverable` is true only when the composite is at least 0.3 AND no HALT-severity
 * execution violation was recorded AND no governance contract violation was recorded — a halt
 * driven by either of those two hard signals is never treated as auto-recoverable, regardless of
 * how the composite otherwise scores.
 */
export function decideHalt(
  score: ConfidenceScore,
  executionResult: ExecutionMonitorResult,
  governanceResult: GovernanceEnforcerResult
): HaltDecision {
  const hasHaltSeverityViolation = executionResult.violations.some(
    (violation) => violation.severity === EventSeverity.HALT
  );
  const hasContractViolations = governanceResult.contractViolations.length > 0;

  const shouldHalt = score.haltRecommended;
  const autoRecoverable =
    score.composite >= AUTO_RECOVER_COMPOSITE_FLOOR && !hasHaltSeverityViolation && !hasContractViolations;

  let reason: string | null = null;
  if (shouldHalt) {
    const reasons: string[] = [];
    if (score.composite < HALT_COMPOSITE_THRESHOLD) {
      reasons.push(`composite confidence ${score.composite.toFixed(2)} is below the ${HALT_COMPOSITE_THRESHOLD} threshold`);
    }
    if (hasHaltSeverityViolation) {
      reasons.push('a HALT-severity execution violation was recorded');
    }
    if (hasContractViolations) {
      reasons.push(`${governanceResult.contractViolations.length} governance contract violation(s) were recorded`);
    }
    reason = reasons.join('; ');
  }

  return {
    shouldHalt,
    reason,
    autoRecoverable,
    recoveryAction:
      shouldHalt && autoRecoverable
        ? 'retry prompt via Build Brain recovery prompt (composite confidence low, no hard-gate violation)'
        : null,
  };
}

/**
 * Persist a completed Sentinel Prime run: one row in `sentinel_prime_runs`, plus one
 * `validation_events` row for every `ObservationEvent` recorded as a violation by
 * ExecutionMonitor. Per Contract 4 (Build Memory writes are never a halting error), a failure to
 * reach the database is logged and swallowed — this function never throws.
 */
export function persistSentinelRun(result: SentinelPrimeRunResult): void {
  const db = getClient();
  if (!db) return;

  try {
    db.prepare(
      `INSERT INTO sentinel_prime_runs (
        id, build_run_id, prompt_id, prompt_index, execution_monitor_result,
        decision_validator_result, governance_enforcer_result, composite_confidence,
        halt_triggered, halt_reason, out_of_scope_writes, contract_violations,
        intent_fulfillment_score, gate_pass_score, created_at
      ) VALUES (
        @id, @build_run_id, @prompt_id, @prompt_index, @execution_monitor_result,
        @decision_validator_result, @governance_enforcer_result, @composite_confidence,
        @halt_triggered, @halt_reason, @out_of_scope_writes, @contract_violations,
        @intent_fulfillment_score, @gate_pass_score, @created_at
      )`
    ).run({
      id: result.id,
      build_run_id: result.buildRunId,
      prompt_id: result.promptId,
      prompt_index: result.promptIndex,
      execution_monitor_result: toJsonText(result.executionResult),
      decision_validator_result: toJsonText(result.validationResult),
      governance_enforcer_result: toJsonText(result.governanceResult),
      composite_confidence: result.confidenceScore.composite,
      halt_triggered: toSqliteBool(result.haltDecision.shouldHalt),
      halt_reason: result.haltDecision.reason,
      out_of_scope_writes: toJsonText(result.executionResult.outOfScopeWrites),
      contract_violations: toJsonText(result.governanceResult.contractViolations),
      intent_fulfillment_score: result.validationResult.intentFulfillmentScore,
      gate_pass_score: result.validationResult.gatePassed ? 1.0 : 0.0,
      created_at: result.createdAt,
    });

    const insertEvent = db.prepare(
      `INSERT INTO validation_events (
        id, sentinel_run_id, event_type, severity, artifact, description,
        auto_resolved, resolution, created_at
      ) VALUES (
        @id, @sentinel_run_id, @event_type, @severity, @artifact, @description,
        @auto_resolved, @resolution, @created_at
      )`
    );

    for (const event of result.executionResult.violations) {
      insertEvent.run({
        id: event.id,
        sentinel_run_id: result.id,
        event_type: event.eventType,
        severity: event.severity,
        artifact: event.artifact,
        description: event.description,
        auto_resolved: 0,
        resolution: null,
        created_at: event.timestamp,
      });
    }
  } catch (error) {
    logMemoryWarning('sentinel-prime.persistSentinelRun', error);
  }
}
