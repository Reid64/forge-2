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

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runGapAudit } from '../resurrection/gap-auditor.js';
import { observeRewriteOutcome } from '../learning/build-brain-evolver.js';
import { BuildMemory } from '../memory/index.js';
import { runTests } from '../testing/orchestrator.js';
import { RunnerType, TriggerType, type TestRunResult } from '../testing/types.js';
import { logLine } from '../tools/forge-logger.js';

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
