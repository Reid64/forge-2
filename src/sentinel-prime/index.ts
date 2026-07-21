/**
 * FORGE 2.0 — System 5: Sentinel Prime — orchestrator.
 *
 * `SentinelPrime` is the composition root over the four independent System 5 signals — it runs
 * them in a fixed sequence for one completed Phase 3 prompt and turns the result into a single
 * halt/continue verdict. It is a SECOND, independent observation layer that runs IN ADDITION to
 * the mandatory Contract 13 Sentinel gate (`phase4-sentinel.ts`) — never in place of it:
 *
 *   1. {@link ExecutionMonitor.finish} (singleton, keyed by `buildRunId`) — compiles whatever the
 *      caller streamed into the monitor during the prompt's subprocess execution (out-of-scope
 *      writes, destructive commands) into an {@link ExecutionMonitorResult}. A build that never
 *      started a monitor for this `buildRunId` (feature not wired at the call site) degrades to a
 *      clean, zero-violation result rather than fabricating a failure.
 *   2. {@link DecisionValidator.validate} — an independent Claude Code CLI critic pass judging
 *      whether the git diff actually fulfilled the prompt's intent.
 *   3. {@link GovernanceEnforcer.enforce} — scans the modified files for contradictions against
 *      BEHAVIORAL_CONTRACTS.md's numbered contracts.
 *   4. {@link scoreConfidence} — combines the three results into one weighted composite score.
 *   5. {@link decideHalt} — turns the composite score (plus the two hard signals — a HALT-severity
 *      execution violation, any governance contract violation) into a concrete halt decision.
 *   6. {@link persistSentinelRun} — writes the full run to Build Memory (Contract 4 — a database
 *      failure is logged and swallowed, never thrown).
 *
 * Never throws (Iron Law 3): every step above already degrades to a documented fallback on its
 * own failure path; `runFullObservation` adds no new way to fail.
 */

import { randomUUID } from 'node:crypto';

import { logLine } from '../tools/forge-logger.js';
import { executionMonitorSingleton } from './execution-monitor.js';
import {
  DecisionValidator,
  createDecisionValidator,
  type DecisionValidatorOptions,
  type DecisionValidatorPromptEntry,
} from './decision-validator.js';
import {
  GovernanceEnforcer,
  createGovernanceEnforcer,
  type GovernanceEnforcerOptions,
} from './governance-enforcer.js';
import { decideHalt, persistSentinelRun, scoreConfidence } from './confidence-scorer.js';
import type { ExecutionMonitorResult, SentinelPrimeRunResult } from './types.js';

/** Minimal shape Sentinel Prime needs from a queue.yaml entry — mirrors {@link DecisionValidatorPromptEntry}. */
export interface SentinelPrimePromptEntry {
  id: string;
  prompt: string;
  prompt_type: string;
}

/** Parameters for {@link SentinelPrime.runFullObservation}. */
export interface SentinelPrimeRunParams {
  buildRunId: string;
  promptEntry: SentinelPrimePromptEntry;
  promptIndex: number;
  projectPath: string;
  /** Whether the mandatory Contract 13 Sentinel gate (phase4-sentinel.ts) already passed. */
  gatesPassed: boolean;
  /** Files this prompt modified (relative or absolute), for the GovernanceEnforcer scan. */
  modifiedFiles: string[];
  /** Full `git diff` text for DecisionValidator's critic pass. */
  gitDiff: string;
}

/** Options for {@link SentinelPrime}. */
export interface SentinelPrimeOptions {
  decisionValidator?: DecisionValidator;
  governanceEnforcer?: GovernanceEnforcer;
  decisionValidatorOptions?: DecisionValidatorOptions;
  governanceEnforcerOptions?: GovernanceEnforcerOptions;
  /** Progress reporter. Default logs to the console with a `[FORGE:sentinel-prime]` prefix. */
  log?: (message: string) => void;
}

/** The documented degrade-to-clean {@link ExecutionMonitorResult} for a build with no live monitor. */
function noMonitorResult(promptId: string): ExecutionMonitorResult {
  return {
    promptId,
    outOfScopeWrites: [],
    unexpectedDeletions: [],
    commandsExecuted: [],
    stdoutChunks: 0,
    exitCode: null,
    durationMs: 0,
    passed: true,
    violations: [],
  };
}

/**
 * Orchestrates one full Sentinel Prime observation pass over a completed prompt. One instance may
 * be reused across every prompt in a build — `runFullObservation` holds no mutable per-call state
 * beyond the injected collaborators (which are themselves stateless across calls).
 */
export class SentinelPrime {
  private readonly decisionValidator: DecisionValidator;
  private readonly governanceEnforcer: GovernanceEnforcer;
  private readonly log: (message: string) => void;

  constructor(options: SentinelPrimeOptions = {}) {
    this.decisionValidator =
      options.decisionValidator ?? createDecisionValidator(options.decisionValidatorOptions ?? {});
    this.governanceEnforcer =
      options.governanceEnforcer ?? createGovernanceEnforcer(options.governanceEnforcerOptions ?? {});
    this.log = options.log ?? logLine('sentinel-prime');
  }

  /**
   * Run the full six-step Sentinel Prime sequence for one completed prompt and return the
   * compiled {@link SentinelPrimeRunResult}. Never throws.
   */
  async runFullObservation(params: SentinelPrimeRunParams): Promise<SentinelPrimeRunResult> {
    const { buildRunId, promptEntry, promptIndex, projectPath, gatesPassed, modifiedFiles, gitDiff } = params;

    // 1. ExecutionMonitor.finish() from the singleton registry (keyed by buildRunId).
    const monitor = executionMonitorSingleton.get(buildRunId);
    const executionResult: ExecutionMonitorResult = monitor
      ? monitor.finish(gatesPassed ? 0 : 1)
      : noMonitorResult(promptEntry.id);

    // 2. DecisionValidator.validate() — independent critic pass over the diff.
    const validationResult = await this.decisionValidator.validate(
      promptEntry as DecisionValidatorPromptEntry,
      projectPath,
      gatesPassed,
      gitDiff
    );

    // 3. GovernanceEnforcer.enforce() — contract-contradiction scan over the modified files.
    const governanceResult = await this.governanceEnforcer.enforce(projectPath, promptEntry.id, modifiedFiles);

    // 4. scoreConfidence() — weighted composite over the three signals above.
    const confidenceScore = scoreConfidence(executionResult, validationResult, governanceResult);

    // 5. decideHalt() — turn the composite + hard signals into a concrete halt decision.
    const haltDecision = decideHalt(confidenceScore, executionResult, governanceResult);

    const result: SentinelPrimeRunResult = {
      id: randomUUID(),
      buildRunId,
      promptId: promptEntry.id,
      promptIndex,
      executionResult,
      validationResult,
      governanceResult,
      confidenceScore,
      haltDecision,
      createdAt: new Date().toISOString(),
    };

    // 6. persistSentinelRun() — Build Memory write, guarded (Contract 4 — never blocking).
    persistSentinelRun(result);

    this.log(
      `prompt '${promptEntry.id}' — composite confidence ${confidenceScore.composite.toFixed(2)} ` +
        `(execution ${confidenceScore.executionScore.toFixed(2)}, validation ${confidenceScore.validationScore.toFixed(2)}, ` +
        `governance ${confidenceScore.governanceScore.toFixed(2)}) — ` +
        `${haltDecision.shouldHalt ? `HALT (${haltDecision.autoRecoverable ? 'auto-recoverable' : 'not recoverable'}): ${haltDecision.reason}` : 'continue'}`
    );

    return result;
  }
}

/** Factory for a fresh {@link SentinelPrime} (mirrors the injectable-collaborator house style). */
export function createSentinelPrime(options: SentinelPrimeOptions = {}): SentinelPrime {
  return new SentinelPrime(options);
}

export default SentinelPrime;
