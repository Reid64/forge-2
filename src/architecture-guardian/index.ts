/**
 * FORGE 2.0 — Architecture Guardian — composition root.
 *
 * Wires the three pieces already built in this directory into the two-call contract Phase 3 uses
 * once per prompt:
 *   - `prePrompt` runs BEFORE the assembled prompt reaches `runClaude` (`classifier.ts` →
 *     `enforcer.ts`): classify the build target, then enhance the prompt with any missing
 *     enterprise-standard instruction text. Never rejects (see `enforcer.ts`'s rationale).
 *   - `postPrompt` runs AFTER claude has produced a diff, on the files the prompt actually touched
 *     (`post-validator.ts`): a real, scored pass/fail verdict on what was actually built, used as a
 *     diagnostic signal for the caller — this module does not itself halt a build.
 *
 * `ArchitectureGuardian` itself holds no build state beyond the most recent classification (needed
 * because `postPrompt`'s `classification` parameter is the SAME classification `prePrompt` computed
 * for this prompt, and `GuardianValidation` — `types.ts` — deliberately carries no classification
 * field of its own). A caller that already has the classification on hand (e.g. from its own local
 * variable) may pass it directly; `getLastClassification()` is there for callers that don't.
 */

import type { GuardianValidation, PromptClassification } from './types.js';
import { classifyPrompt } from './classifier.js';
import { EnterpriseEnforcer, createEnterpriseEnforcer } from './enforcer.js';
import { PostOutputValidator, createPostOutputValidator } from './post-validator.js';
import type { OutputValidation } from './post-validator.js';

export type { PromptClassification, GuardianValidation, EnterpriseStandard } from './types.js';
export { ENTERPRISE_STANDARDS } from './types.js';
export { classifyPrompt, listClassificationRules } from './classifier.js';
export type { BuildTarget } from './classifier.js';
export { EnterpriseEnforcer, createEnterpriseEnforcer } from './enforcer.js';
export { PostOutputValidator, createPostOutputValidator } from './post-validator.js';
export type { OutputValidation, OutputViolation } from './post-validator.js';

/**
 * The prompt actually about to be sent to claude — everything `classifyPrompt` needs. `promptText`
 * is the FULLY assembled/rewritten/instinct-and-skill-augmented text at the point Guardian runs,
 * not the raw queue.yaml description; classification is only as accurate as the text it's given.
 */
export interface GuardianPromptEntry {
  id: string;
  promptType: string;
  promptText: string;
}

/**
 * Composition root for Architecture Guardian: classify → enforce (pre-prompt), then validate
 * (post-prompt) against the same classification. One instance is safe to reuse across an entire
 * build's prompt loop — `prePrompt`/`postPrompt` are the only state-bearing calls, and each
 * `prePrompt` call simply overwrites `lastClassification` for the NEXT `postPrompt` call on that
 * same prompt (Phase 3 runs prompts sequentially, never concurrently, so this is never raced).
 */
export class ArchitectureGuardian {
  private readonly enforcer: EnterpriseEnforcer;
  private readonly validator: PostOutputValidator;
  private lastClassification: PromptClassification | null = null;

  constructor(
    enforcer: EnterpriseEnforcer = createEnterpriseEnforcer(),
    validator: PostOutputValidator = createPostOutputValidator()
  ) {
    this.enforcer = enforcer;
    this.validator = validator;
  }

  /**
   * Classify `promptEntry.promptText`, then enforce enterprise standards against it, returning the
   * (always-approved — see `enforcer.ts`) {@link GuardianValidation} with `enhancedPrompt` ready to
   * replace the caller's prompt text. `projectPath` is accepted for parity with `postPrompt` and
   * future project-scoped overrides; classification/enforcement here is text-only and does not
   * touch disk.
   */
  prePrompt(promptEntry: GuardianPromptEntry, projectPath: string): GuardianValidation {
    void projectPath;
    const classification = classifyPrompt(promptEntry.promptText, promptEntry.promptType);
    this.lastClassification = classification;
    return this.enforcer.enforce(promptEntry.promptText, classification);
  }

  /**
   * Validate every modified file from a completed prompt against the five post-output checks
   * (`post-validator.ts`), scoped by `classification` — typically the same {@link PromptClassification}
   * `prePrompt` produced for this prompt (see {@link ArchitectureGuardian.getLastClassification}).
   */
  async postPrompt(
    projectPath: string,
    modifiedFiles: string[],
    classification: PromptClassification
  ): Promise<OutputValidation> {
    return this.validator.validate(projectPath, modifiedFiles, classification);
  }

  /**
   * The {@link PromptClassification} the most recent `prePrompt` call computed, for a caller that
   * wants to pass the SAME classification into `postPrompt` without re-deriving or re-threading it
   * through its own local state. Returns `null` before the first `prePrompt` call.
   */
  getLastClassification(): PromptClassification | null {
    return this.lastClassification;
  }
}

/** Factory matching the house style of `createSentinelPrime`/`createEnterpriseEnforcer`/etc. */
export function createArchitectureGuardian(
  enforcer?: EnterpriseEnforcer,
  validator?: PostOutputValidator
): ArchitectureGuardian {
  return new ArchitectureGuardian(enforcer, validator);
}

export default ArchitectureGuardian;
