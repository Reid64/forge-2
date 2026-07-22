/**
 * FORGE 2.0 — Architecture Guardian — enterprise standards enforcer.
 *
 * `EnterpriseEnforcer.enforce` runs immediately after `classifyPrompt` (`classifier.ts`), on the
 * SAME about-to-be-assembled Phase 3 prompt, before it is handed to `runClaude`
 * (`src/engine/claude-runner.ts`). Where the classifier answers "what is this and what must it
 * satisfy," the enforcer answers "does the prompt ALREADY tell claude to satisfy those things —
 * and if not, what explicit instruction text closes that gap."
 *
 * Design posture (mirrors Contract 4's "never blocks execution" — Build Memory writes degrade,
 * they never halt — and Contract SP-5's "GovernanceEnforcer findings are never auto-approved,
 * never silently overridden," applied here in the opposite direction: Guardian enhances, it never
 * blocks): `approved` is unconditionally `true`. ArchitectureGuardian is a PRE-PROMPT enhancement
 * layer, not a fifth human gate (Contract 2) or a sixth Sentinel check (Contract 13) — those
 * remain the only mechanisms in FORGE that can actually halt a build. A prompt this enforcer finds
 * badly under-specified is never rejected outright; it is returned with explicit, additive
 * instruction text appended so claude has no ambiguity about what "enterprise-grade" means for
 * this specific build target. Rejecting here instead of enhancing would create exactly the kind of
 * deadlock Contract 14 (Autonomous Recovery) already guards against for Sentinel failures — a
 * prompt that can never proceed because the thing empowered to fix it is the same thing refusing
 * to let it run.
 */

import type { EnterpriseStandard, GuardianValidation, PromptClassification } from './types.js';
import { ENTERPRISE_STANDARDS } from './types.js';

// ---------------------------------------------------------------------------
// Build target → prompt type mapping
// ---------------------------------------------------------------------------

/**
 * Maps a `PromptClassification.buildTarget` (the classifier's `api-route`/`ui-component`/`agent`/
 * `database`/`test`/`generic` vocabulary) onto FORGE's `PromptType` vocabulary (`schema`/`auth`/
 * `api`/`ui`/`feature`/`agent`/`test`/`deploy`), so `ENTERPRISE_STANDARDS` entries — which are
 * scoped by `PromptType`, not by build target — can be filtered for relevance to a classified
 * prompt. A build target absent from this map (or the `generic` fallback) resolves to an empty
 * list here; the universal standards (scoped to every `PromptType`) are still checked separately
 * in {@link EnterpriseEnforcer.enforce} regardless of this mapping.
 */
const BUILD_TARGET_TO_PROMPT_TYPES: Record<string, string[]> = {
  'api-route': ['api'],
  'ui-component': ['ui', 'feature'],
  agent: ['agent'],
  database: ['schema'],
  test: ['test'],
  generic: [],
};

// ---------------------------------------------------------------------------
// Pattern-level requirement checks
// ---------------------------------------------------------------------------

/** One FORGE-internal required-pattern check: how to detect it, and what to say when it's missing. */
interface PatternRequirement {
  /** True when `text` already signals this requirement is addressed — i.e. nothing to enforce. */
  detect: (text: string) => boolean;
  /** The explicit instruction appended to the prompt when {@link detect} returns false. */
  instruction: string;
}

/**
 * One entry per FORGE-internal pattern name the classifier can produce in
 * `PromptClassification.requiredPatterns` (see `classifier.ts`'s `CLASSIFICATION_RULES`). Detection
 * is a cheap keyword/regex scan over the prompt text — this module never inspects generated code
 * (the prompt has not been executed yet); it only checks whether the INSTRUCTION for a requirement
 * is already present in the text claude is about to receive.
 */
const PATTERN_REQUIREMENTS: Record<string, PatternRequirement> = {
  'auth-middleware': {
    detect: (text) => /\bauth(entication|orization)?\b.{0,40}\bmiddleware\b|\brequireAuth\b|\bgetServerSession\b/i.test(text),
    instruction:
      'You MUST implement authentication middleware as the first operation in every route handler, returning 401 if invalid.',
  },
  'zod-validation': {
    detect: (text) => /\bzod\b|\.parse\(|\.safeParse\(/i.test(text),
    instruction:
      'You MUST validate every request body, query string, and route param against a zod schema before use, rejecting invalid input with a structured 4xx response.',
  },
  'structured-error-response': {
    detect: (text) => /\{\s*error\s*:\s*\{/.test(text) || /structured error (response|shape)/i.test(text),
    instruction:
      'You MUST return errors in a consistent structured shape (e.g. `{ error: { code, message } }`) — never a bare string and never an unhandled thrown exception.',
  },
  'rate-limiting': {
    detect: (text) => /rate.?limit/i.test(text),
    instruction: 'You MUST implement rate limiting on this endpoint to prevent abuse from a single caller.',
  },
  'loading-state': {
    detect: (text) => /loading state|skeleton|isLoading|<Spinner/i.test(text),
    instruction: 'You MUST implement a loading skeleton state using the shadcn Skeleton component, shown while data fetches.',
  },
  'error-state': {
    detect: (text) => /error state|isError\b|onError\b/i.test(text),
    instruction:
      'You MUST implement an explicit error state that renders when the fetch or action fails — never a silent failure or an unhandled rejection.',
  },
  'empty-state': {
    detect: (text) => /empty state|no (results|items|data) found/i.test(text),
    instruction: 'You MUST implement an explicit empty state shown when the collection has zero items — never a bare empty container.',
  },
  'aria-labels': {
    detect: (text) => /aria-label|aria-labelledby|role=/i.test(text),
    instruction: 'You MUST add appropriate aria-label/aria-labelledby attributes to every interactive element for screen-reader accessibility.',
  },
  'dark-mode': {
    detect: (text) => /dark:|dark mode/i.test(text),
    instruction: 'You MUST support dark mode via Tailwind `dark:` prefix classes on every color, background, and border utility.',
  },
  'extends-BaseAgent': {
    detect: (text) => /extends\s+BaseAgent/i.test(text),
    instruction: 'You MUST define this agent as a class that extends BaseAgent — never a bare exported function standing in for an agent.',
  },
  AgentRunResult: {
    detect: (text) => /AgentRunResult/i.test(text),
    instruction:
      'You MUST return a structured AgentRunResult (success/failure plus diagnostic detail) from every agent run — the agent function itself MUST NOT throw out to its caller.',
  },
  'error-handling': {
    detect: (text) => /try\s*\{[\s\S]{0,200}catch\s*\(/i.test(text) || /catch\s*\(/i.test(text),
    instruction: 'You MUST catch every internal error inside the agent and convert it into a structured failure result rather than letting it propagate.',
  },
  'db-persistence': {
    detect: (text) => /agent_runs|persist(s|ed)? (to|the)|INSERT INTO/i.test(text),
    instruction: 'You MUST persist one row per agent invocation (start time, outcome, duration) to the agent_runs table, regardless of success or failure.',
  },
  logging: {
    detect: (text) => /\blog(ger|Line)?\s*\(|console\.(log|info|warn|error)/i.test(text),
    instruction: 'You MUST log the start, outcome, and duration of every agent run for observability.',
  },
  'indexes-on-fk': {
    detect: (text) => /create\s+index|CREATE\s+INDEX/i.test(text),
    instruction: 'You MUST create an index on every foreign-key column this migration adds — an unindexed foreign key is a defect, not an optimization for later.',
  },
  'rls-policy': {
    detect: (text) => /row level security|\bRLS\b|CREATE\s+POLICY/i.test(text),
    instruction: 'You MUST define a Row Level Security policy for every table this migration creates, scoped by company/user ownership.',
  },
  'updated-at-trigger': {
    detect: (text) => /updated_at|BEFORE\s+UPDATE|trigger/i.test(text),
    instruction: 'You MUST add an `updated_at` column with a BEFORE UPDATE trigger that keeps it current on every table this migration creates.',
  },
  'arrange-act-assert': {
    detect: (text) => /arrange.{0,20}act.{0,20}assert|expect\(/i.test(text),
    instruction: 'You MUST structure every test with a clear arrange-act-assert shape — set up state, perform the action, then assert the outcome.',
  },
  'mock-cleanup': {
    detect: (text) => /afterEach|beforeEach|restoreAllMocks|resetAllMocks/i.test(text),
    instruction: 'You MUST reset or restore all mocks between tests (afterEach/beforeEach) so state never leaks across test cases.',
  },
  'edge-cases': {
    detect: (text) => /edge case|boundary (value|condition)|null\s*(\/|or)?\s*undefined/i.test(text),
    instruction: 'You MUST cover edge cases — empty input, null/undefined, boundary values — not just the happy path.',
  },
};

// ---------------------------------------------------------------------------
// Universal standards (line count, stubs, mock data) — apply to every build target
// ---------------------------------------------------------------------------

/** Baseline minimum implementation size below which a prompt is considered under-provisioned. */
const GENERIC_LINE_FLOOR = 100;
/** The floor `EnterpriseEnforcer` actually enforces once a prompt is found under-provisioned. */
const ENFORCED_LINE_FLOOR = 150;

/** Detects a `TODO`/`FIXME`/stub/placeholder marker anywhere in the prompt text. */
function detectStubMarkers(text: string): boolean {
  return /\bTODO\b|\bFIXME\b|\bstub\b|placeholder (comment|function|implementation)/i.test(text);
}

/** Detects language explicitly asking for (or already containing) hardcoded mock/sample data. */
function detectMockDataLanguage(text: string): boolean {
  return /mock data|mockData|sample data array|hardcoded (array|dataset)/i.test(text);
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

/** One instruction the enforcer decided to append, plus a short label recorded in `enforcementsApplied`. */
interface EnforcementDecision {
  label: string;
  instruction: string;
  critical: boolean;
}

/**
 * Determine every `ENTERPRISE_STANDARDS` entry relevant to a classified prompt: its build target's
 * mapped `PromptType`s, unioned with the `PromptType` the prompt was actually assembled for (the
 * classifier's `promptType` field) — so a standard is never missed just because the build-target
 * mapping and the queue.yaml `prompt_type` disagree at the margins.
 */
function relevantPromptTypes(classification: PromptClassification): Set<string> {
  const mapped = BUILD_TARGET_TO_PROMPT_TYPES[classification.buildTarget] ?? [];
  const types = new Set<string>(mapped);
  if (classification.promptType.trim() !== '') {
    types.add(classification.promptType.trim().toLowerCase());
  }
  return types;
}

/** Render the block of enforcement instructions appended to the end of the original prompt. */
function renderEnforcementBlock(decisions: EnforcementDecision[]): string {
  const lines = decisions.map((decision) => {
    const prefix = decision.critical ? 'CRITICAL' : 'REQUIRED';
    return `- [${prefix}] ${decision.instruction}`;
  });
  return [
    '',
    '---',
    'ARCHITECTURE GUARDIAN — ENFORCED ENTERPRISE STANDARDS',
    'The following requirements were not clearly addressed in the prompt above and MUST be satisfied',
    'in the implementation you produce:',
    ...lines,
    '---',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// EnterpriseEnforcer
// ---------------------------------------------------------------------------

/**
 * Validates (and, when needed, enhances) an assembled Phase 3 prompt against FORGE's enterprise
 * engineering standards, using the classification `classifyPrompt` produced for it.
 *
 * `enforce` never rejects a prompt outright (`approved` is always `true` — see this module's
 * top-of-file rationale). Instead it:
 *   1. Scans `classification.requiredPatterns` (the FORGE-internal patterns the classifier
 *      determined this build target must satisfy) against {@link PATTERN_REQUIREMENTS}, appending
 *      an explicit instruction for every pattern not already signaled in the prompt text.
 *   2. Scans the `ENTERPRISE_STANDARDS` universal trio — minimum implementation size, zero stubs,
 *      zero mock data — which apply across every build target regardless of which specific
 *      patterns matched above.
 *   3. Appends every resulting instruction as one additive block at the end of the prompt,
 *      records a short label per enforcement in `enforcementsApplied`, and reports the (always
 *      non-blocking) result as a {@link GuardianValidation}.
 */
export class EnterpriseEnforcer {
  private readonly standards: EnterpriseStandard[];

  constructor(standards: EnterpriseStandard[] = ENTERPRISE_STANDARDS) {
    this.standards = standards;
  }

  /**
   * Enforce enterprise standards against `promptText`, given its `classification` from
   * `classifyPrompt`. Never throws: an empty/malformed `promptText` degrades to "everything is
   * missing" (every applicable instruction is appended) rather than raising an error — the safest
   * default when the enforcer cannot tell what the prompt already covers.
   */
  enforce(promptText: string, classification: PromptClassification): GuardianValidation {
    const safeText = typeof promptText === 'string' ? promptText : '';
    const decisions: EnforcementDecision[] = [];

    // Step 1 — FORGE-internal required patterns for this build target.
    for (const pattern of classification.requiredPatterns) {
      const requirement = PATTERN_REQUIREMENTS[pattern];
      if (!requirement) continue; // Unknown pattern name — nothing registered to check/enforce.
      if (!requirement.detect(safeText)) {
        decisions.push({ label: pattern, instruction: requirement.instruction, critical: false });
      }
    }

    // Step 2 — the ENTERPRISE_STANDARDS this classification's promptType/buildTarget is subject
    // to, restricted here to the three universal, cross-cutting standards (line count, stubs,
    // mock data) so we never double-report a requirement already covered by Step 1's pattern scan.
    const applicableTypes = relevantPromptTypes(classification);
    const applicableStandards = this.standards.filter((standard) =>
      standard.promptTypes.some((type) => applicableTypes.has(type))
    );
    const hasStandard = (id: string): boolean => applicableStandards.some((standard) => standard.id === id);

    let criticalStubViolation = false;
    let criticalMockDataViolation = false;

    if (hasStandard('MINIMUM_IMPLEMENTATION_LINES') && classification.estimatedLines < GENERIC_LINE_FLOOR) {
      decisions.push({
        label: 'MINIMUM_IMPLEMENTATION_LINES',
        instruction: `This implementation MUST be minimum ${ENFORCED_LINE_FLOOR} lines of real production code. Zero stubs, zero TODOs, zero placeholder comments. Every method fully implemented.`,
        critical: false,
      });
    }

    if (hasStandard('NO_STUBS') && detectStubMarkers(safeText)) {
      criticalStubViolation = true;
      decisions.push({
        label: 'NO_STUBS',
        instruction:
          'CRITICAL: a TODO/FIXME/stub/placeholder marker was detected. The output MUST contain zero TODO, FIXME, or placeholder comments and zero stub functions returning a hardcoded value in place of real logic — every function must be a complete, working implementation.',
        critical: true,
      });
    }

    if (hasStandard('NO_MOCK_DATA') && detectMockDataLanguage(safeText)) {
      criticalMockDataViolation = true;
      decisions.push({
        label: 'NO_MOCK_DATA',
        instruction:
          'CRITICAL: hardcoded mock/sample data language was detected. Production code MUST NOT contain hardcoded mock data arrays standing in for a real API call or database query — every data source must be real.',
        critical: true,
      });
    }

    const enforcementsApplied = decisions.map((decision) => decision.label);
    const enhancedPrompt = decisions.length === 0 ? safeText : safeText + renderEnforcementBlock(decisions);

    const anyCritical = criticalStubViolation || criticalMockDataViolation;
    // `rejectionReason` is informational only — it records WHY a stricter policy would have
    // rejected this prompt, for logging/telemetry, but never actually blocks it (`approved` is
    // always true, per this module's guiding rationale). A prompt with no critical findings
    // carries `rejectionReason: null` — there was nothing that would have warranted rejection.
    const rejectionReason = anyCritical
      ? `Critical violation(s) detected: ${decisions
          .filter((decision) => decision.critical)
          .map((decision) => decision.label)
          .join(', ')}`
      : null;

    const estimatedOutputLines = Math.max(
      classification.estimatedLines,
      decisions.some((decision) => decision.label === 'MINIMUM_IMPLEMENTATION_LINES') ? ENFORCED_LINE_FLOOR : 0
    );

    return {
      approved: true,
      originalPrompt: safeText,
      enhancedPrompt,
      enforcementsApplied,
      rejectionReason,
      estimatedOutputLines,
    };
  }
}

/** Factory matching the house style of `createSentinelPrime`/`createDeadCodeDetector`/etc. */
export function createEnterpriseEnforcer(standards?: EnterpriseStandard[]): EnterpriseEnforcer {
  return new EnterpriseEnforcer(standards);
}

export default EnterpriseEnforcer;
