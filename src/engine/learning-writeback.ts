/**
 * FORGE 2.0 — Learning write-loop (Session 4 — Intelligence & Observability, Task 1).
 *
 * Closes the gap between "a prompt failed Sentinel" and "Build Memory actually learned
 * something": every failure/recovery event updates BOTH table families, because they serve
 * different readers —
 *   - `src/memory/errors.ts` + `resolutions.ts` (Session 1 SQLite Build Memory): read by the
 *     prompt-assembler's `defaultFetchWarnings` (injects known-failure warnings into a prompt)
 *     and by `runAutonomousRecovery` (matches `auto_resolve_eligible` patterns to auto-fix).
 *   - `src/learning/*` (`fix_patterns`/`governance_rules`): read by `handlePreToolUse` (injects
 *     governance rules + fix patterns as a context block) and by `checkAutoElevation` (the
 *     compounding mechanism — 3+ occurrences with a proven fix become a governance rule).
 *
 * Before this module, NOTHING ever created the first `error_patterns` row on a novel failure —
 * the h1 "pattern fix" block in `src/phases/phase3-executor.ts` only ever READ
 * `findMatchingPattern`/`getResolutionForPattern`, so those tables stayed at 0 rows forever.
 * `recordFailureObserved` is the missing seed; `recordRecoveryOutcome` is the missing
 * success/failure tracking `runAutonomousRecovery`'s auto-resolve matching depends on
 * (`auto_resolve_eligible` was never set to true by anything).
 *
 * NON-FATAL house style throughout: every write is guarded; a failure here never blocks a build.
 */

import { BuildMemory } from '../memory/index.js';
import { categorizeError, normalizeErrorSignature, type SentinelCheckName } from '../phases/phase4-sentinel.js';
import { captureError, checkAutoElevation } from '../learning/loops.js';
import { registerFix } from '../learning/queries.js';
import { getErrorFingerprint } from '../learning/fingerprint.js';
import type { ErrorCategory, ErrorPattern } from '../types/index.js';
import type { PromptType } from './queue-generator.js';
import type { StackFingerprint } from '../tools/stack-detector.js';
import { logLine } from '../tools/forge-logger.js';

const log = logLine('learning-writeback');

/** Resolutions become auto-resolve-eligible once their success rate crosses this. */
const AUTO_RESOLVE_ELIGIBLE_THRESHOLD = 0.7;

/** Map a Sentinel check name to the learning schema's `fix_patterns.error_category` enum. */
export function mapCheckToLearningCategory(
  checkName: SentinelCheckName | null
): 'COMPILE' | 'RUNTIME' | 'TEST' | 'LINT' | 'SECURITY' | 'SCHEMA' | 'DEPLOY' {
  switch (checkName) {
    case 'typescript':
    case 'build':
      return 'COMPILE';
    case 'eslint':
      return 'LINT';
    case 'schema_drift':
      return 'SCHEMA';
    case 'dependencies':
      return 'DEPLOY';
    case 'file_integrity':
      return 'RUNTIME';
    default:
      return 'RUNTIME';
  }
}

/**
 * Map a queue `PromptType` (`schema|auth|api|ui|feature|agent|test|deploy` — Contract 7's
 * semantic build vocabulary) to the learning schema's OWN, differently-scoped `task_type`
 * vocabulary (`prompt_scores`/`hook_execution_log`'s `CHECK(task_type IN ('SCAFFOLD','CRUD',
 * 'INTEGRATION','AI_PIPELINE','CONFIG','TEST','FIX'))`). Passing a raw `PromptType` anywhere a
 * learning-schema `task_type` column is written trips that CHECK constraint on every single
 * write (silently swallowed by the caller's try/catch) — `prompt_scores` stayed at 0 rows for
 * exactly this reason before this mapping existed.
 */
export function mapPromptTypeToTaskType(
  promptType: PromptType
): 'SCAFFOLD' | 'CRUD' | 'INTEGRATION' | 'AI_PIPELINE' | 'CONFIG' | 'TEST' | 'FIX' {
  switch (promptType) {
    case 'schema':
      return 'SCAFFOLD';
    case 'auth':
      return 'INTEGRATION';
    case 'api':
      return 'CRUD';
    case 'ui':
      return 'SCAFFOLD';
    case 'feature':
      return 'CRUD';
    case 'agent':
      return 'AI_PIPELINE';
    case 'test':
      return 'TEST';
    case 'deploy':
      return 'CONFIG';
    default:
      return 'CRUD';
  }
}

/** Derive a compact tech-stack tag list from a StackFingerprint (for both table families). */
export function deriveStackTags(fp: StackFingerprint | null | undefined): string[] {
  if (!fp) return [];
  return [fp.framework, fp.language, fp.database, fp.deployment, fp.packageManager, ...fp.services].filter(
    (v): v is string => typeof v === 'string' && v.trim() !== ''
  );
}

/**
 * Compute the learning-schema `fix_patterns.error_fingerprint` for a failure — MUST match
 * exactly what `captureError`/`registerError` (`src/learning/loops.ts` + `queries.ts`) hash, or
 * `registerFix`/`checkAutoElevation`'s (and Build Brain's `getFixPattern`) `WHERE
 * error_fingerprint = ?` lookups silently miss the row `recordFailureObserved` just
 * created/incremented. This is a DIFFERENT identifier from the src/memory
 * `error_patterns.error_signature` (`normalizeErrorSignature`) — the two table families each key
 * their own rows their own way; every caller that touches BOTH must compute both correctly.
 */
export function computeLearningFingerprint(
  errorText: string,
  category: ErrorCategory,
  stackFingerprint: StackFingerprint | null | undefined
): string {
  return getErrorFingerprint({
    errorCode: category,
    filePath: '',
    errorMessage: errorText.slice(0, 300),
    techStack: deriveStackTags(stackFingerprint),
  });
}

/** Common identifying context for a failure/recovery event. */
export interface FailureContext {
  /** The raw failure evidence (Sentinel's `diagnosticReport`, or a specific check's detail+output). */
  errorText: string;
  /** The Sentinel check that failed, when known (drives categorization). */
  failedCheck: SentinelCheckName | null;
  promptType: PromptType;
  projectName: string;
  stackFingerprint: StackFingerprint | null | undefined;
}

export interface FailureObservedResult {
  signature: string;
  category: ErrorCategory;
  errorPattern: ErrorPattern | null;
  occurrenceCount: number;
}

/**
 * Record a Sentinel failure BEFORE any recovery is attempted. Create-or-increment an
 * `error_patterns` row (src/memory) and a `fix_patterns` row (learning schema) by normalized
 * signature — the seed every downstream reader (assembler warnings, Build Brain, auto-recovery,
 * auto-elevation) depends on. Guarded — never throws; degrades to a best-effort local signature
 * on total Build Memory failure.
 */
export async function recordFailureObserved(ctx: FailureContext): Promise<FailureObservedResult> {
  const signature = normalizeErrorSignature(ctx.errorText);
  const category = categorizeError(ctx.failedCheck, ctx.errorText);
  const stackTags = deriveStackTags(ctx.stackFingerprint);

  let errorPattern: ErrorPattern | null = null;
  try {
    const existing = await BuildMemory.errors.findMatchingPattern(signature);
    if (existing) {
      errorPattern = await BuildMemory.errors.updateOccurrenceCount(existing.id);
    } else {
      errorPattern = await BuildMemory.errors.createErrorPattern({
        error_signature: signature,
        error_category: category,
        error_message_sample: ctx.errorText.slice(0, 500),
        first_seen_project: ctx.projectName,
        trigger_phase: 'phase3',
        trigger_prompt_pattern: ctx.promptType,
        stack_fingerprints: ctx.stackFingerprint ? [ctx.stackFingerprint as unknown as Record<string, unknown>] : [],
      } as Parameters<typeof BuildMemory.errors.createErrorPattern>[0]);
    }
  } catch (error) {
    log(`WARNING: error_patterns write degraded (${error instanceof Error ? error.message : String(error)})`);
  }

  try {
    captureError(
      {
        errorCode: category,
        filePath: '',
        errorMessage: ctx.errorText.slice(0, 300),
        errorCategory: mapCheckToLearningCategory(ctx.failedCheck),
        techStack: stackTags,
      },
      undefined
    );
  } catch (error) {
    log(`WARNING: fix_patterns write degraded (${error instanceof Error ? error.message : String(error)})`);
  }

  return {
    signature,
    category,
    errorPattern,
    occurrenceCount: errorPattern?.occurrence_count ?? 1,
  };
}

// ---------------------------------------------------------------------------
// Session 5 finding #6 / #15 — learn from smoke-test failures + adversary blockers too, not just
// Sentinel failures. Both feed the SAME `recordFailureObserved` seed path (src/memory
// error_patterns + learning-schema fix_patterns) so the rest of the write-loop (auto-elevation,
// warnings injection) sees them exactly like any other failure signature.
// ---------------------------------------------------------------------------

/** Build a signature-safe token from a smoke-test file id (e.g. `page:/dashboard` -> `page-dashboard`). Slashes read as filesystem paths to `normalizeErrorSignature` and would otherwise collapse every page onto one signature (`<path>`), destroying the "per failing page" distinction. */
function smokeFileSignatureToken(file: string): string {
  const token = file.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return token.length > 0 ? token : 'unknown';
}

export interface SmokeFailureContext {
  /** The failing check's id, e.g. `page:/dashboard`, `compile:tsc --noEmit`, `build:pnpm run build`. */
  file: string;
  /** The captured error/output for this specific check. */
  errorText: string;
  projectName: string;
  stackFingerprint: StackFingerprint | null | undefined;
}

/** Record a single failing smoke-test check (Session 5 finding #6) — one signature PER failing page/check. */
export async function recordSmokeTestFailureObserved(ctx: SmokeFailureContext): Promise<FailureObservedResult> {
  const token = smokeFileSignatureToken(ctx.file);
  return recordFailureObserved({
    errorText: `smoke test failure for check ${token}: ${ctx.errorText}`,
    failedCheck: null,
    promptType: 'test',
    projectName: ctx.projectName,
    stackFingerprint: ctx.stackFingerprint,
  });
}

export interface AdversaryBlockerContext {
  /** The adversary vector (SCHEMA/SECURITY/SCALE/INTEGRATION/UX/ARCH/DATA). */
  vector: string;
  /** The adversary phase this blocker was raised in (ARCHITECT_PRD, ARCHITECT_GOVERNANCE, …). */
  phase: string;
  specificIssue: string;
  evidence: string;
  recommendedFix: string;
  projectName: string;
}

/** Map an adversary vector to the src/memory `error_patterns.error_category` enum. */
function errorCategoryForVector(vector: string): ErrorCategory {
  switch (vector) {
    case 'SECURITY':
      return 'auth';
    case 'SCHEMA':
    case 'DATA':
      return 'schema';
    case 'ARCH':
      return 'build_failure';
    default:
      return 'runtime'; // SCALE, INTEGRATION, UX
  }
}

/** Map an adversary vector to the learning-schema `fix_patterns.error_category` enum. */
function learningCategoryForVector(
  vector: string
): 'COMPILE' | 'RUNTIME' | 'TEST' | 'LINT' | 'SECURITY' | 'SCHEMA' | 'DEPLOY' {
  switch (vector) {
    case 'SECURITY':
      return 'SECURITY';
    case 'SCHEMA':
    case 'DATA':
      return 'SCHEMA';
    case 'ARCH':
      return 'COMPILE';
    default:
      return 'RUNTIME'; // SCALE, INTEGRATION, UX
  }
}

/**
 * Record one adversarial-review BLOCKER finding (Session 5 finding #6/#2) — one signature PER
 * vector+phase so a recurring class of blocker (e.g. every ARCHITECT_GOVERNANCE SECURITY finding)
 * is visible to the same compounding write-loop Sentinel failures already feed. Guarded — never
 * throws; a Build Memory failure here must never block the CLI's halt/accept-blockers decision.
 */
export async function recordAdversaryBlockerObserved(ctx: AdversaryBlockerContext): Promise<FailureObservedResult> {
  const signature = normalizeErrorSignature(
    `adversary blocker vector ${ctx.vector} phase ${ctx.phase}: ${ctx.specificIssue}`
  );
  const category = errorCategoryForVector(ctx.vector);
  const sample = `[${ctx.vector}] ${ctx.specificIssue}\nEvidence: ${ctx.evidence}\nRecommended fix: ${ctx.recommendedFix}`;

  let errorPattern: ErrorPattern | null = null;
  try {
    const existing = await BuildMemory.errors.findMatchingPattern(signature);
    if (existing) {
      errorPattern = await BuildMemory.errors.updateOccurrenceCount(existing.id);
    } else {
      errorPattern = await BuildMemory.errors.createErrorPattern({
        error_signature: signature,
        error_category: category,
        error_message_sample: sample.slice(0, 500),
        first_seen_project: ctx.projectName,
        trigger_phase: ctx.phase,
        trigger_prompt_pattern: ctx.vector,
      } as Parameters<typeof BuildMemory.errors.createErrorPattern>[0]);
    }
  } catch (error) {
    log(`WARNING: adversary-blocker error_patterns write degraded (${error instanceof Error ? error.message : String(error)})`);
  }

  try {
    captureError(
      {
        errorCode: category,
        filePath: '',
        errorMessage: sample.slice(0, 300),
        errorCategory: learningCategoryForVector(ctx.vector),
        techStack: [],
      },
      undefined
    );
  } catch (error) {
    log(`WARNING: adversary-blocker fix_patterns write degraded (${error instanceof Error ? error.message : String(error)})`);
  }

  return {
    signature,
    category,
    errorPattern,
    occurrenceCount: errorPattern?.occurrence_count ?? 1,
  };
}

export interface RecoveryContext extends FailureContext {
  /** Whether the recovery attempt actually turned Sentinel green. */
  recovered: boolean;
  /** What was done (the resolution description — becomes `resolutions.resolution_description` / `fix_patterns.fix_description`). */
  fixDescription: string;
  /** Concrete steps taken (commands run, files touched) — stored as `resolutions.resolution_steps`. */
  fixSteps: string[];
  filesModified: string[];
  /** How the fix was produced — governs `resolutions.resolution_type`. Default 'code_patch'. */
  resolutionType?: 'prompt_rewrite' | 'config_change' | 'dependency_fix' | 'code_patch' | 'manual';
}

export interface RecoveryOutcomeResult {
  signature: string;
  errorPatternId: string | null;
  resolutionId: string | null;
  resolutionSuccessRate: number | null;
  elevatedRuleId: string | null;
}

/**
 * Record the OUTCOME of a recovery attempt (known-pattern fix, Build Brain intervention, or
 * autonomous recovery). Links a `resolutions` row to the `error_patterns` row and updates its
 * applied/succeeded counts; once the resolution's success rate crosses
 * {@link AUTO_RESOLVE_ELIGIBLE_THRESHOLD}, flips the pattern to `auto_resolve_eligible` so
 * `runAutonomousRecovery` can find and apply it on a FUTURE build without a human in the loop.
 * Also updates the learning-schema `fix_patterns` success tracking and checks for governance-rule
 * auto-elevation (Task 1.2: occurrence_count >= 3 AND resolution success_rate >= 0.7). Guarded —
 * never throws.
 */
export async function recordRecoveryOutcome(ctx: RecoveryContext): Promise<RecoveryOutcomeResult> {
  const signature = normalizeErrorSignature(ctx.errorText);
  const category = categorizeError(ctx.failedCheck, ctx.errorText);

  let errorPatternId: string | null = null;
  let resolutionId: string | null = null;
  let resolutionSuccessRate: number | null = null;

  try {
    let pattern = await BuildMemory.errors.findMatchingPattern(signature);
    if (!pattern) {
      // Defensive — recordFailureObserved should already have seeded this, but never assume.
      pattern = await BuildMemory.errors.createErrorPattern({
        error_signature: signature,
        error_category: category,
        error_message_sample: ctx.errorText.slice(0, 500),
        first_seen_project: ctx.projectName,
        trigger_phase: 'phase3',
        trigger_prompt_pattern: ctx.promptType,
      });
    }
    if (pattern) {
      errorPatternId = pattern.id;

      let resolution = await BuildMemory.resolutions.getResolutionForPattern(pattern.id);
      if (!resolution) {
        resolution = await BuildMemory.resolutions.createResolution({
          error_pattern_id: pattern.id,
          resolution_type: ctx.resolutionType ?? 'code_patch',
          resolution_description: ctx.fixDescription,
          resolution_steps: ctx.fixSteps,
        });
      }
      if (resolution) {
        const updated = await BuildMemory.resolutions.incrementApplied(resolution.id, ctx.recovered);
        resolutionId = resolution.id;
        if (updated) {
          resolutionSuccessRate =
            updated.times_applied > 0 ? updated.times_succeeded / updated.times_applied : 0;

          if (
            resolutionSuccessRate >= AUTO_RESOLVE_ELIGIBLE_THRESHOLD &&
            updated.times_applied >= 1 &&
            !pattern.auto_resolve_eligible
          ) {
            await BuildMemory.errors.updateErrorPattern(pattern.id, {
              auto_resolve_eligible: true,
              success_rate: resolutionSuccessRate,
              prevention_rule: ctx.fixDescription,
              resolution_id: resolution.id,
            });
            log(
              `error pattern '${signature.slice(0, 60)}…' is now auto_resolve_eligible ` +
                `(success_rate=${resolutionSuccessRate.toFixed(2)})`
            );
          }
        }
      }
    }
  } catch (error) {
    log(`WARNING: resolutions write degraded (${error instanceof Error ? error.message : String(error)})`);
  }

  let elevatedRuleId: string | null = null;
  try {
    const fingerprint = computeLearningFingerprint(ctx.errorText, category, ctx.stackFingerprint);
    registerFix(
      fingerprint,
      {
        succeeded: ctx.recovered,
        fixDescription: ctx.fixDescription,
        filesModified: ctx.filesModified,
      },
      undefined
    );
    const rule = checkAutoElevation(fingerprint, ctx.projectName, undefined);
    if (rule) {
      elevatedRuleId = rule.id;
      log(`governance rule auto-elevated from '${signature.slice(0, 60)}…': ${rule.rule_short_name}`);
    }
  } catch (error) {
    log(`WARNING: fix_patterns/governance_rules writeback degraded (${error instanceof Error ? error.message : String(error)})`);
  }

  return { signature, errorPatternId, resolutionId, resolutionSuccessRate, elevatedRuleId };
}
