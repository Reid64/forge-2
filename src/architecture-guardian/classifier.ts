/**
 * FORGE 2.0 — Architecture Guardian — prompt classifier.
 *
 * `classifyPrompt` runs BEFORE a Phase 3 prompt is assembled/dispatched to `runClaude`
 * (`src/engine/claude-runner.ts`). It answers one question: "what kind of build target is this
 * prompt actually producing, and what enterprise-grade patterns/line-count floor should that
 * target be held to?" The classification it returns is consumed by `EnterpriseEnforcer`
 * (`enforcer.ts`) to decide what instruction text — if any — needs to be appended to the prompt
 * before it reaches claude.
 *
 * Classification is keyword-driven over the raw prompt text, with the queue.yaml `prompt_type`
 * (FORGE's `schema`/`auth`/`api`/`ui`/`feature`/`agent`/`test`/`deploy` vocabulary) used as a
 * secondary signal when the text itself doesn't unambiguously name a build target. This mirrors
 * the house style of `src/skills/index.ts`'s `detectProjectStack` — cheap, deterministic, regex/
 * substring based, never a model call — classification must be instant and side-effect-free so it
 * can run on every single prompt without adding latency or cost to the build.
 *
 * This module makes no decisions about WHAT INSTRUCTION TEXT to inject — that is
 * `EnterpriseEnforcer`'s job. It only answers "what is this, and what must it satisfy."
 */

import type { PromptClassification } from './types.js';
import { ENTERPRISE_STANDARDS } from './types.js';

// ---------------------------------------------------------------------------
// Build target vocabulary
// ---------------------------------------------------------------------------

/**
 * The five concrete build targets ArchitectureGuardian recognizes, plus `generic` — the
 * fallback for a prompt whose text and `prompt_type` both fail to name any of the five.
 */
export type BuildTarget = 'api-route' | 'ui-component' | 'agent' | 'database' | 'test' | 'generic';

/** One classification rule: how to detect a build target, and what it demands. */
interface ClassificationRule {
  /** The build target this rule produces when it matches. */
  buildTarget: Exclude<BuildTarget, 'generic'>;
  /** Case-insensitive substrings/patterns whose presence in the prompt text signals a match. */
  textSignals: RegExp[];
  /** `prompt_type` values that independently corroborate this build target (secondary signal). */
  promptTypeHints: string[];
  /** The FORGE-internal pattern names this build target's output MUST satisfy. */
  requiredPatterns: string[];
  /** The minimum real-implementation line count this build target's output MUST reach. */
  minimumLines: number;
}

/**
 * Rules are evaluated IN ORDER — the first rule whose text signal matches wins. Order matters
 * because prompt text is free-form prose and can legitimately mention more than one build
 * target's vocabulary (e.g. an API route prompt that also says "component" in passing); the order
 * below reflects the priority given in the Architecture Guardian's governing task brief:
 * api-route → ui-component → agent → database → test.
 */
const CLASSIFICATION_RULES: ClassificationRule[] = [
  {
    buildTarget: 'api-route',
    textSignals: [/route\.ts/i, /\bapi\b/i, /\bendpoint\b/i],
    promptTypeHints: ['api'],
    requiredPatterns: ['auth-middleware', 'zod-validation', 'structured-error-response', 'rate-limiting'],
    minimumLines: 150,
  },
  {
    buildTarget: 'ui-component',
    textSignals: [/\bcomponent\b/i, /\bpage\b/i, /\btsx\b/i],
    promptTypeHints: ['ui', 'feature'],
    requiredPatterns: ['loading-state', 'error-state', 'empty-state', 'aria-labels', 'dark-mode'],
    minimumLines: 100,
  },
  {
    buildTarget: 'agent',
    textSignals: [/\bagent\b/i, /agent\s+extends/i, /extends\s+baseagent/i],
    promptTypeHints: ['agent'],
    requiredPatterns: ['extends-BaseAgent', 'AgentRunResult', 'error-handling', 'db-persistence', 'logging'],
    minimumLines: 200,
  },
  {
    buildTarget: 'database',
    textSignals: [/\bmigration\b/i, /create\s+table/i],
    promptTypeHints: ['schema'],
    requiredPatterns: ['indexes-on-fk', 'rls-policy', 'updated-at-trigger'],
    minimumLines: 50,
  },
  {
    buildTarget: 'test',
    textSignals: [/\btest\b/i, /\bdescribe\s*\(/i, /\bit\s*\(/i],
    promptTypeHints: ['test'],
    requiredPatterns: ['arrange-act-assert', 'mock-cleanup', 'edge-cases'],
    minimumLines: 80,
  },
];

/**
 * Fallback classification for a prompt that matches none of the five known build targets by text
 * OR by `prompt_type` hint. A generic build still carries the universal, cross-cutting
 * requirements (`ENTERPRISE_STANDARDS` entries scoped to every `PromptType`) — line-count and
 * stub/mock-data hygiene never relax just because the target couldn't be named more specifically.
 */
const GENERIC_RULE: Omit<ClassificationRule, 'buildTarget' | 'textSignals' | 'promptTypeHints'> = {
  requiredPatterns: ['no-stubs', 'no-mock-data'],
  minimumLines: 100,
};

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** True when any of `patterns` matches somewhere in `text`. Case-insensitivity is per-pattern. */
function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Find the first classification rule whose text signal matches `promptText`. Rules are checked
 * strictly in priority order (see {@link CLASSIFICATION_RULES}'s doc comment) — a prompt that
 * happens to satisfy more than one rule's text signal is classified by whichever rule appears
 * first in the list, never by an ambiguous or "most specific" heuristic.
 */
function findRuleByText(promptText: string): ClassificationRule | undefined {
  return CLASSIFICATION_RULES.find((rule) => matchesAny(promptText, rule.textSignals));
}

/**
 * Fallback: find a rule whose `promptTypeHints` include the queue.yaml `prompt_type` this prompt
 * was assembled for. Used only when {@link findRuleByText} finds nothing — the prompt's own text
 * is always the primary signal; `prompt_type` is corroborating evidence for text that doesn't
 * clearly name its own build target (a terse or unusually-worded prompt, for example).
 */
function findRuleByPromptType(promptType: string): ClassificationRule | undefined {
  const normalized = promptType.trim().toLowerCase();
  if (normalized === '') return undefined;
  return CLASSIFICATION_RULES.find((rule) => rule.promptTypeHints.includes(normalized));
}

/**
 * Every `ENTERPRISE_STANDARD` (`types.ts`) whose `promptTypes` list includes this prompt's
 * `promptType`, rendered as human-readable requirement strings. This is what feeds
 * `PromptClassification.enterpriseRequirements` — the full set of enterprise-grade expectations
 * `EnterpriseEnforcer` will check the assembled prompt against, independent of which specific
 * build target was detected (a prompt can be both `promptType: 'api'` classified as `api-route`
 * AND subject to the universal `MINIMUM_IMPLEMENTATION_LINES`/`NO_STUBS`/`NO_MOCK_DATA` standards).
 */
function collectEnterpriseRequirements(promptType: string): string[] {
  const normalized = promptType.trim().toLowerCase();
  return ENTERPRISE_STANDARDS.filter((standard) => standard.promptTypes.includes(normalized)).map(
    (standard) => standard.requirement
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Classify a Phase 3 prompt ahead of assembly: what build target it produces, what
 * FORGE-internal patterns that target's output must satisfy, the minimum real-implementation
 * line count expected, and the full set of enterprise standards (from `types.ts`) applicable to
 * its `promptType`.
 *
 * Detection order:
 *   1. Scan `promptText` against each {@link CLASSIFICATION_RULES} entry's text signals, in
 *      priority order (api-route → ui-component → agent → database → test). First match wins.
 *   2. If no text signal matched, fall back to `promptType` hints (the queue.yaml `prompt_type`
 *      this prompt was assembled for) against the same rule list.
 *   3. If neither matched anything, classify as `generic` — still subject to the universal
 *      line-count and stub/mock-data hygiene requirements, just with no build-target-specific
 *      pattern set.
 *
 * Never throws: an empty or unparseable `promptText`/`promptType` simply falls through to the
 * `generic` classification rather than raising an error (Iron Law — a classification failure must
 * never block a build; ArchitectureGuardian enhances, it never halts).
 */
export function classifyPrompt(promptText: string, promptType: string): PromptClassification {
  const safeText = typeof promptText === 'string' ? promptText : '';
  const safePromptType = typeof promptType === 'string' ? promptType : '';

  const matchedRule = findRuleByText(safeText) ?? findRuleByPromptType(safePromptType);

  const buildTarget: BuildTarget = matchedRule?.buildTarget ?? 'generic';
  const requiredPatterns: string[] = matchedRule?.requiredPatterns ?? GENERIC_RULE.requiredPatterns;
  const minimumLines: number = matchedRule?.minimumLines ?? GENERIC_RULE.minimumLines;

  const enterpriseRequirements = collectEnterpriseRequirements(safePromptType);

  return {
    promptType: safePromptType,
    buildTarget,
    requiredPatterns: [...requiredPatterns],
    estimatedLines: minimumLines,
    enterpriseRequirements,
  };
}

/**
 * Convenience re-export of the rule table for callers (tests, `forge health` diagnostics) that
 * need to introspect what ArchitectureGuardian currently recognizes without duplicating the
 * detection logic. Treated as read-only — mutating this array would silently change
 * classification behavior for every subsequent prompt in the process.
 */
export function listClassificationRules(): ReadonlyArray<Readonly<ClassificationRule>> {
  return CLASSIFICATION_RULES;
}

export default classifyPrompt;
