/**
 * FORGE 2.0 — Integration Bus (System 4).
 *
 * System 1 (Resurrection/GapAuditor, `src/resurrection/`), System 2 (Learning Engine /
 * BuildBrainEvolver, `src/learning/`), and System 3 (Enterprise Test Suite / TestOrchestrator,
 * `src/testing/`) were each built to operate standalone. This module is the wiring between them:
 * a Sentinel failure, an evolution promotion, or a behavioral pattern confirmed across builds each
 * fan out into the other systems' work automatically instead of staying siloed in the phase that
 * observed them.
 *
 * House style (matches `src/phases/phase3-executor.ts` and `src/learning/build-brain-evolver.ts`):
 * every export here is NON-FATAL (Contract 4) — a downstream collaborator failing (Build Memory
 * unreachable, a runner throwing, a governance-file write failing) is logged and swallowed, never
 * thrown, so a bus call can never abort the Phase 3 loop that triggers it.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runGapAudit } from '../resurrection/gap-auditor.js';
import { observeRewriteOutcome } from '../learning/build-brain-evolver.js';
import { BuildMemory } from '../memory/index.js';
import { fromJsonText, logMemoryWarning, nowIso } from '../memory/client.js';
import SentinelPrime from '../sentinel-prime/index.js';
import { decideHalt, scoreConfidence } from '../sentinel-prime/confidence-scorer.js';
import type {
  ExecutionMonitorResult,
  GovernanceEnforcerResult,
  SentinelPrimeRunResult,
  ValidationResult,
} from '../sentinel-prime/types.js';
import { runTests } from '../testing/orchestrator.js';
import { RunnerType, TriggerType, type TestRunResult } from '../testing/types.js';
import { logLine } from '../tools/forge-logger.js';
import { toAsciiGovernanceText } from '../tools/governance-text.js';

const log = logLine('integration-bus');

/**
 * Minimal EvolutionPromoter surface {@link onEvolutionPromoted} depends on. LEARNING_BLUEPRINT.md
 * § Agent: EvolutionPromoter is specified but not yet implemented (Learning Iron Law L5 —
 * BuildBrainEvolver only ever proposes; EvolutionPromoter is the sole component allowed to act on
 * a proposal). Declaring the dependency shape here, rather than importing a module that doesn't
 * exist yet, lets this wiring compile today and be satisfied by the real EvolutionPromoter once
 * it lands — anything that promotes an evolution and can reverse it satisfies this.
 */
export interface RollbackCapablePromoter {
  rollback(evolutionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Sentinel Prime (System 5) readback
// ---------------------------------------------------------------------------

/** Row shape read back from `sentinel_prime_runs` (see `src/learning/database.ts`). */
interface SentinelPrimeRunRow {
  id: string;
  build_run_id: string;
  prompt_id: string;
  prompt_index: number;
  execution_monitor_result: string;
  decision_validator_result: string;
  governance_enforcer_result: string;
  created_at: string;
}

/** Documented degrade-to-clean fallbacks, mirroring `orchestrator/queue-runner.ts`'s own
 *  readback of this same table — a storage-format hiccup degrades to "no opinion" rather than
 *  fabricating a halt Sentinel Prime never actually decided (Contract 4). */
const FALLBACK_EXECUTION_RESULT: ExecutionMonitorResult = {
  promptId: '',
  outOfScopeWrites: [],
  unexpectedDeletions: [],
  commandsExecuted: [],
  stdoutChunks: 0,
  exitCode: null,
  durationMs: 0,
  passed: true,
  violations: [],
};

const FALLBACK_VALIDATION_RESULT: ValidationResult = {
  promptId: '',
  intentFulfillmentScore: 1,
  gatePassed: true,
  intentActuallyFulfilled: true,
  promptSummary: '',
  outputSummary: '',
  gaps: [],
  confidence: 1,
};

const FALLBACK_GOVERNANCE_RESULT: GovernanceEnforcerResult = {
  promptId: '',
  artifactsScanned: [],
  driftReports: [],
  contractViolations: [],
  passed: true,
};

/**
 * Reconstruct a full {@link SentinelPrimeRunResult} from a persisted row. `confidenceScore`/
 * `haltDecision` are RECOMPUTED via the same pure `scoreConfidence`/`decideHalt` functions
 * {@link SentinelPrime} itself used to persist the row, rather than re-parsed from derived
 * columns, so the reconstruction never drifts from the scoring module's own logic.
 */
function reconstructSentinelPrimeRun(row: SentinelPrimeRunRow): SentinelPrimeRunResult {
  const executionResult = fromJsonText<ExecutionMonitorResult>(row.execution_monitor_result, FALLBACK_EXECUTION_RESULT);
  const validationResult = fromJsonText<ValidationResult>(row.decision_validator_result, FALLBACK_VALIDATION_RESULT);
  const governanceResult = fromJsonText<GovernanceEnforcerResult>(row.governance_enforcer_result, FALLBACK_GOVERNANCE_RESULT);

  const confidenceScore = scoreConfidence(executionResult, validationResult, governanceResult);
  const haltDecision = decideHalt(confidenceScore, executionResult, governanceResult);

  return {
    id: row.id,
    buildRunId: row.build_run_id,
    promptId: row.prompt_id,
    promptIndex: row.prompt_index,
    executionResult,
    validationResult,
    governanceResult,
    confidenceScore,
    haltDecision,
    createdAt: row.created_at,
  };
}

/**
 * Read back one `sentinel_prime_runs` row matching `whereClause` (a fixed, non-interpolated SQL
 * fragment — `param` is always bound, never concatenated) and reconstruct it. Never throws
 * (Contract 4) — an unreachable database or a missing row both resolve to `null`.
 */
function loadSentinelPrimeRun(whereClause: string, param: string): SentinelPrimeRunResult | null {
  const db = BuildMemory.getClient();
  if (!db) return null;

  try {
    const row = db
      .prepare(
        `SELECT id, build_run_id, prompt_id, prompt_index, execution_monitor_result,
                decision_validator_result, governance_enforcer_result, created_at
         FROM sentinel_prime_runs
         WHERE ${whereClause}
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(param) as SentinelPrimeRunRow | undefined;
    if (!row) return null;
    return reconstructSentinelPrimeRun(row);
  } catch (error) {
    logMemoryWarning('integration-bus.loadSentinelPrimeRun', error);
    return null;
  }
}

/**
 * Non-auto-recoverable Sentinel Prime halt: append a BLOCKER entry to STATE_OF_THE_BUILD.md
 * (Canonical Rule 9 — the state document is deliberately outside Sentinel's protected doc set)
 * so the halt is visible in the build's live progress record, not just Build Memory.
 */
async function appendSentinelPrimeBlocker(projectPath: string, run: SentinelPrimeRunResult): Promise<void> {
  const block = [
    '',
    `## [FORGE Phase 3] BLOCKER — ${SentinelPrime.name}`,
    `- Sentinel run: ${run.id}`,
    `- Prompt: '${run.promptId}' (index ${run.promptIndex})`,
    `- Composite confidence: ${run.confidenceScore.composite.toFixed(2)}`,
    `- Halt reason: ${run.haltDecision.reason ?? 'unspecified'}`,
    `- Timestamp: ${nowIso()}`,
    '',
  ].join('\n');

  const dir = join(projectPath, 'governance');
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, 'STATE_OF_THE_BUILD.md'), toAsciiGovernanceText(block), 'utf8');
}

/**
 * Auto-recoverable Sentinel Prime halt: queue a fresh `pending` `prompt_executions` row for this
 * same build/prompt index so the next Phase 3 pass picks the prompt back up. `prompt_executions`
 * has no dedicated `retry_count` column (see SCHEMA_REGISTRY.md) — rather than fabricate one, the
 * attempt number is recorded in `resolution_applied`, derived from the real count of prior rows
 * for this (build_run_id, prompt_index) pair.
 */
async function queueSentinelPrimeRetry(buildRunId: string, run: SentinelPrimeRunResult): Promise<void> {
  const db = BuildMemory.getClient();
  if (!db) return;

  const baseRow = db
    .prepare(
      `SELECT prompt_name, prompt_hash, prompt_content, branch_name
       FROM prompt_executions
       WHERE build_run_id = ? AND prompt_index = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(buildRunId, run.promptIndex) as
    | { prompt_name: string; prompt_hash: string; prompt_content: string; branch_name: string | null }
    | undefined;

  const priorAttempts = (
    db
      .prepare('SELECT COUNT(*) AS n FROM prompt_executions WHERE build_run_id = ? AND prompt_index = ?')
      .get(buildRunId, run.promptIndex) as { n: number }
  ).n;

  await BuildMemory.prompts.createPromptExecution({
    build_run_id: buildRunId,
    prompt_index: run.promptIndex,
    prompt_name: baseRow?.prompt_name ?? run.promptId,
    prompt_hash: baseRow?.prompt_hash ?? run.promptId,
    prompt_content: baseRow?.prompt_content ?? '',
    status: 'pending',
    branch_name: baseRow?.branch_name ?? null,
    resolution_applied: `${SentinelPrime.name} auto-recoverable halt -- retry #${priorAttempts} (sentinel run ${run.id})`,
  });
}

/**
 * Fires on every Sentinel FAIL after Contract-14 auto-recovery is exhausted — the point
 * `phase3-executor.ts` was already about to HALT the build. Fans the failure out to:
 *  - System 1: a TARGETED gap audit, since the governance docs implicated by this failing check
 *    may themselves be stale or wrong (`GapAuditOptions.scope: 'TARGETED'`). `AuditTrigger` has no
 *    'sentinel_failure' value (the `gap_audit_runs.audit_trigger` column is CHECK-constrained to
 *    the five values in `src/resurrection/types.ts`), so this uses `'halt_recovery'` — the
 *    semantically closest existing trigger for "a build just halted and is being audited for it".
 *  - System 2: records the unrecovered outcome so BuildBrainEvolver's rewrite-effectiveness window
 *    reflects it. `wasRewritten` is unknown at this call site (the bus only receives scalar
 *    identifiers, not the full `PromptOutcome`) — the per-prompt call phase3-executor.ts already
 *    makes right after Sentinel (`observeRewriteOutcome(entry.id, outcome.wasRewritten, ...)`)
 *    remains the source of truth for that flag; this call passes `false` rather than fabricate it.
 *  - System 3: a POST_PROMPT baseline UNIT+INTEGRATION run, so the failing state is captured for
 *    comparison once the build resumes past this halt.
 */
export async function onSentinelFailure(
  failedCheck: string,
  promptId: string,
  buildRunId: string,
  projectPath: string
): Promise<void> {
  try {
    await runGapAudit({
      projectPath,
      scope: 'TARGETED',
      trigger: 'halt_recovery',
      haltRecovery: true,
      buildRunId,
    });
  } catch (error) {
    log(`targeted gap audit failed for '${failedCheck}' at prompt ${promptId}: ${errorMessage(error)}`);
  }

  try {
    const memoryClient = BuildMemory.getClient();
    if (memoryClient) {
      observeRewriteOutcome(promptId, false, false, memoryClient);
    }
  } catch (error) {
    log(`observeRewriteOutcome failed for prompt ${promptId}: ${errorMessage(error)}`);
  }

  try {
    await runTests({
      projectPath,
      buildRunId,
      promptId,
      triggers: [TriggerType.POST_PROMPT],
      runners: [RunnerType.UNIT, RunnerType.INTEGRATION],
    });
  } catch (error) {
    log(`baseline test run failed for prompt ${promptId}: ${errorMessage(error)}`);
  }

  // Sentinel Prime (System 5) readback: the SentinelPrime observation pass already ran for this
  // same prompt during executePrompt (phase3-executor.ts), independently of the Contract-13 gate
  // that triggered this call — cross-reference its verdict and act on it. A non-auto-recoverable
  // halt is recorded as a BLOCKER in STATE_OF_THE_BUILD.md; an auto-recoverable one queues a fresh
  // pending prompt_execution row so the build can pick the prompt back up.
  try {
    const run = loadSentinelPrimeRun('prompt_id = ?', promptId);
    if (run && run.haltDecision.shouldHalt) {
      if (!run.haltDecision.autoRecoverable) {
        await appendSentinelPrimeBlocker(projectPath, run);
      } else {
        await queueSentinelPrimeRetry(buildRunId, run);
      }
    }
  } catch (error) {
    log(`Sentinel Prime readback failed for prompt ${promptId}: ${errorMessage(error)}`);
  }
}

/**
 * Fires after an EvolutionPromoter applies a promoted evolution's effect. Runs UNIT+INTEGRATION
 * to verify the fix held; if any regress, rolls the evolution back via `promoter` (when supplied —
 * see {@link RollbackCapablePromoter}). With no promoter available (EvolutionPromoter is not yet
 * built), a regression is logged rather than silently dropped, so it surfaces once something reads
 * the log instead of vanishing.
 */
export async function onEvolutionPromoted(
  evolutionId: string,
  projectPath: string,
  promoter?: RollbackCapablePromoter
): Promise<void> {
  let results: TestRunResult[];
  try {
    results = await runTests({
      projectPath,
      buildRunId: null,
      promptId: null,
      triggers: [TriggerType.MANUAL],
      runners: [RunnerType.UNIT, RunnerType.INTEGRATION],
    });
  } catch (error) {
    log(`post-promotion verification run failed for evolution ${evolutionId}: ${errorMessage(error)}`);
    return;
  }

  const regressed = results.some((r) => r.status === 'failed' || r.status === 'error');
  if (!regressed) return;

  log(`evolution ${evolutionId} regressed UNIT/INTEGRATION tests after promotion`);
  if (!promoter) {
    log(`no EvolutionPromoter available to roll back evolution ${evolutionId} — rollback must be performed manually`);
    return;
  }
  try {
    await promoter.rollback(evolutionId);
  } catch (error) {
    log(`promoter rollback failed for evolution ${evolutionId}: ${errorMessage(error)}`);
  }
}

/**
 * Fires at a Sentinel Prime HALT (the point `phase3-executor.ts` is about to throw and unwind the
 * build — see the `SentinelPrime HALT:` throw site right after `runFullObservation`). Reads the
 * persisted run back by id, formats a diagnostic block, and appends it to SESSION_STATE.md so the
 * halt is visible in the session record even though the throw itself unwinds before Phase 3's own
 * `rollbackAndReport`/`updateStateProgress` machinery (which handles the Contract-13 gate, not
 * this second observation layer) ever runs. Non-fatal (Contract 4) — a read or write failure is
 * logged and swallowed, never thrown, so this call can never block the halt it is documenting.
 */
export async function onSentinelPrimeHalt(sentinelRunId: string, projectPath: string): Promise<void> {
  try {
    const run = loadSentinelPrimeRun('id = ?', sentinelRunId);
    if (!run) {
      log(`onSentinelPrimeHalt: no sentinel_prime_runs row found for id ${sentinelRunId}`);
      return;
    }

    const block = [
      '',
      `## ${SentinelPrime.name} HALT diagnostic — run ${run.id}`,
      `- Prompt: '${run.promptId}' (index ${run.promptIndex})`,
      `- Composite confidence: ${run.confidenceScore.composite.toFixed(2)} ` +
        `(execution ${run.confidenceScore.executionScore.toFixed(2)}, ` +
        `validation ${run.confidenceScore.validationScore.toFixed(2)}, ` +
        `governance ${run.confidenceScore.governanceScore.toFixed(2)})`,
      `- Halt reason: ${run.haltDecision.reason ?? 'unspecified'}`,
      `- Auto-recoverable: ${run.haltDecision.autoRecoverable ? 'yes' : 'no'}`,
      `- Timestamp: ${nowIso()}`,
      '',
    ].join('\n');

    const dir = join(projectPath, 'governance');
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'SESSION_STATE.md'), toAsciiGovernanceText(block), 'utf8');
  } catch (error) {
    log(`onSentinelPrimeHalt failed for run ${sentinelRunId}: ${errorMessage(error)}`);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Root-level canonical contracts doc (matches the `Contract N` numbering FORGE's own source
 *  comments reference, e.g. `phase3-executor.ts`'s "Contract 13", "Contract 14" — as opposed to
 *  `governance/BEHAVIORAL_CONTRACTS.md`, a generated artifact with an unrelated structure). */
const BEHAVIORAL_CONTRACTS_PATH = join(__dirname, '..', '..', 'BEHAVIORAL_CONTRACTS.md');
/** SCHEMA_REGISTRY.md `governance_rules` auto-elevation threshold (BLUEPRINT.md § Learning Data
 *  Flow: "3+ occurrences → auto-elevate to governance_rules"). */
const CONFIRMED_PATTERN_THRESHOLD = 3;

/**
 * Fires when a behavioral pattern (identified by `signature`) has been confirmed across
 * `count` builds. At the auto-elevation threshold, appends a new `### Contract N:` entry to the
 * root BEHAVIORAL_CONTRACTS.md, following the existing file's exact section format. Idempotent —
 * a signature already present in the file is not appended twice.
 */
export async function onContractConfirmed(signature: string, count: number): Promise<void> {
  if (count < CONFIRMED_PATTERN_THRESHOLD) return;

  try {
    const current = await readFile(BEHAVIORAL_CONTRACTS_PATH, 'utf8');
    if (current.includes(signature)) return;

    const nextNumber = nextContractNumber(current);
    const entry =
      `\n### Contract ${nextNumber}: Auto-Elevated Pattern\n` +
      `Confirmed across ${count} builds (Learning Loop 2 — Fix Pattern auto-elevation, ` +
      `BLUEPRINT.md § Learning Data Flow). Signature: \`${signature}\`\n`;
    await writeFile(BEHAVIORAL_CONTRACTS_PATH, `${current.trimEnd()}\n${entry}`, 'utf8');
    log(`appended Contract ${nextNumber} for confirmed pattern '${signature}' (${count} builds)`);
  } catch (error) {
    log(`failed to append confirmed-pattern contract for '${signature}': ${errorMessage(error)}`);
  }
}

function nextContractNumber(markdown: string): number {
  const matches = markdown.matchAll(/^### Contract (\d+):/gm);
  let highest = 0;
  for (const m of matches) highest = Math.max(highest, Number(m[1]));
  return highest + 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
