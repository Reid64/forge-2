/**
 * FORGE 2.0 — System 5: Sentinel Prime — DecisionValidator.
 *
 * An INDEPENDENT critic pass over a completed Phase 3 prompt. Every other Sentinel Prime
 * component (ExecutionMonitor, and the not-yet-built GovernanceEnforcer) reasons about HOW a
 * prompt ran — did it write outside its scope, did it run a destructive command. DecisionValidator
 * reasons about WHAT the prompt actually produced: given the original prompt intent and the real
 * `git diff` of the work committed to the branch, did the diff genuinely fulfill the prompt, or
 * did the build agent produce something that merely LOOKS like progress (a stub, a partial
 * implementation, a diff that touches the wrong files, an empty diff that still exits 0)?
 *
 * This is a SEPARATE Claude Code CLI invocation (`runClaude`, `src/engine/claude-runner.ts`) from
 * the one that did the build — a fresh subprocess with no memory of building the feature, asked
 * only to grade the diff against the prompt. It is deliberately NOT the same model call that
 * produced the code: a builder grading its own work is a well-known blind spot (the same bias
 * Session 5.2's Sentinel-graded-the-wrong-project defect exploited from a different angle — a
 * check that always reports success is worse than no check at all). Contract 5 (Claude Code
 * Execution) governs this call exactly as it governs every other `runClaude` invocation in FORGE:
 * zero incremental API cost — it draws against the same Max-subscription CLI session Phase 3 uses,
 * not a metered Anthropic API key.
 *
 * NEVER THROWS (Iron Law 3 — report the real outcome, never fabricate one). A CLI failure, a
 * timeout, or a response that doesn't parse as the contracted JSON shape all degrade to a
 * documented fallback score (0.5, "uncertain") with the failure reason recorded in `gaps`, never
 * silently treated as either a pass or a halt.
 *
 * GATE SEMANTICS (per this task's brief): DecisionValidator is advisory, not a hard gate on its
 * own. `intentActuallyFulfilled` is `true` only when `intentFulfillmentScore >= 0.75`. When the
 * mandatory Sentinel gates already passed (`gatesPassed`) but the critic's score falls below that
 * threshold, `validate()` logs a WARN — it does NOT flip the prompt to halted. The caller (Sentinel
 * Prime's orchestrator, once wired) decides how much weight the confidence score carries in the
 * overall halt decision; this module's job is to produce an honest, independently-derived opinion,
 * not to enforce one.
 */

import { randomUUID } from 'node:crypto';

import { runClaude, type ClaudeRunResult } from '../engine/claude-runner.js';
import { extractJsonObject } from '../tools/json-extraction.js';
import { logLine } from '../tools/forge-logger.js';
import type { ValidationResult } from './types.js';

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/** Minimal shape DecisionValidator needs from a queue.yaml entry — never the full QueueEntry type. */
export interface DecisionValidatorPromptEntry {
  id: string;
  prompt: string;
  prompt_type: string;
}

/** The critic's fixed system framing — never build, only evaluate. Reused verbatim every call. */
export const CRITIC_SYSTEM_PROMPT =
  'You are a ruthless code review critic. You do not build. You only evaluate. You are given a ' +
  'build prompt and its git diff output. Score 0.0-1.0 whether the diff actually fulfills the ' +
  'prompt intent. Return JSON only with no preamble: ' +
  '{"intentFulfillmentScore":number,"gaps":string[],"confidence":number,"summary":string}';

/** Hard character cap on the diff embedded in the critic prompt — a runaway diff must not blow the CLI's stdin/latency budget. */
const MAX_DIFF_CHARS = 60_000;

/** Hard character cap on the original prompt text embedded in the critic prompt. */
const MAX_PROMPT_CHARS = 8_000;

/** Truncate long text for prompt embedding, noting how much was cut so the critic isn't fooled by a silently shortened diff. */
function truncateForPrompt(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n... [${label} truncated — ${omitted} more characters omitted] ...`;
}

/**
 * Assemble the full critic prompt: the fixed system framing, the prompt under evaluation, and its
 * git diff, concatenated into one piped-via-stdin message (Contract 5 — `runClaude` has no
 * separate system/user channel over the CLI; this mirrors `provider-router.ts`'s
 * `callViaClaudeCode`, the one other caller in FORGE that builds a Claude Code CLI prompt from a
 * system+user pair).
 */
export function buildCriticPrompt(
  promptEntry: DecisionValidatorPromptEntry,
  gitDiff: string
): string {
  const promptText = truncateForPrompt(promptEntry.prompt, MAX_PROMPT_CHARS, 'prompt text');
  const diffText = truncateForPrompt(gitDiff, MAX_DIFF_CHARS, 'git diff');
  const diffBody = diffText.trim() === '' ? '(empty diff — no changes were committed)' : diffText;

  return [
    CRITIC_SYSTEM_PROMPT,
    '',
    `--- PROMPT ID: ${promptEntry.id} (type: ${promptEntry.prompt_type}) ---`,
    '--- PROMPT TEXT ---',
    promptText,
    '',
    '--- GIT DIFF ---',
    diffBody,
    '',
    'Respond with ONLY the JSON object described above. No prose before or after it.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** The raw shape the critic is asked to return. */
interface CriticResponseShape {
  intentFulfillmentScore: number;
  gaps: string[];
  confidence: number;
  summary: string;
}

/** Clamp a number into `[0, 1]`; non-finite input falls back to `fallback`. */
function clampUnit(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** Coerce an unknown value into a `string[]`, dropping non-string entries rather than throwing. */
function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/**
 * Parse the critic's JSON response. Uses the shared tolerant recovery strategy
 * (`extractJsonObject` — bare JSON, then bracket-delimited substring, then a markdown fence) so an
 * occasional stray preamble line doesn't collapse a genuinely well-formed score to the fallback.
 * Returns `null` only when no strategy yields a usable object at all — the caller applies the
 * documented fallback (0.5, parse-failure noted in `gaps`) in that case.
 */
export function parseCriticResponse(
  raw: string,
  warn?: (message: string) => void
): CriticResponseShape | null {
  const parsed = extractJsonObject(raw, warn);
  if (!parsed) return null;

  const hasScore = 'intentFulfillmentScore' in parsed;
  const hasConfidence = 'confidence' in parsed;
  if (!hasScore && !hasConfidence && !('summary' in parsed) && !('gaps' in parsed)) {
    // Recovered SOME JSON object, but it shares none of the contracted fields — likely an
    // unrelated object embedded in prose. Treat as unparseable rather than fabricating a score
    // from fields that were never there.
    return null;
  }

  return {
    intentFulfillmentScore: clampUnit(parsed['intentFulfillmentScore'], 0.5),
    gaps: coerceStringArray(parsed['gaps']),
    confidence: clampUnit(parsed['confidence'], 0.5),
    summary: typeof parsed['summary'] === 'string' ? parsed['summary'] : '',
  };
}

// ---------------------------------------------------------------------------
// DecisionValidator
// ---------------------------------------------------------------------------

/** Score at or above which the critic's opinion counts as "the diff fulfills the prompt". */
export const INTENT_FULFILLMENT_THRESHOLD = 0.75;

/** Injectable Claude Code CLI runner — mirrors the `runClaudeImpl` house pattern (`phase3-executor.ts`) so this class unit-tests with no real subprocess. */
export type DecisionValidatorRunClaude = (
  prompt: string,
  cwd: string
) => Promise<ClaudeRunResult>;

/** Options for {@link DecisionValidator}. */
export interface DecisionValidatorOptions {
  /** Override the Claude Code CLI call (tests / alternate transport). Default: the real `runClaude`. */
  runClaudeImpl?: DecisionValidatorRunClaude;
  /** Progress reporter. Default logs to the console with a `[FORGE:decision-validator]` prefix. */
  log?: (message: string) => void;
  /** Per-call CLI timeout override. Default: `runClaude`'s own default (15 minutes, Contract 5). */
  timeoutMs?: number;
}

/**
 * Runs an independent critic pass over one completed prompt: was the prompt's intent actually
 * fulfilled by the diff it produced? One instance may be reused across every prompt in a build —
 * `validate()` holds no mutable per-call state.
 */
export class DecisionValidator {
  private readonly runClaudeImpl: DecisionValidatorRunClaude;
  private readonly log: (message: string) => void;
  private readonly timeoutMs: number | undefined;

  constructor(options: DecisionValidatorOptions = {}) {
    this.runClaudeImpl =
      options.runClaudeImpl ??
      ((prompt: string, cwd: string) =>
        runClaude(prompt, { cwd, ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}) }));
    this.log = options.log ?? logLine('decision-validator');
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * Evaluate whether `gitDiff` genuinely fulfills `promptEntry`'s intent, via an independent
   * Claude Code CLI critic call (never the same call that built the diff).
   *
   * `gatesPassed` reflects the mandatory Sentinel gates (Contract 13) having already run for this
   * prompt — it does NOT change how the critic scores the diff (the critic never sees it), but it
   * shapes the WARN log: a low critic score on a prompt whose gates already passed is exactly the
   * "looked fine, wasn't" case this module exists to catch, so it is logged more pointedly than a
   * low score on a prompt that already failed its gates (redundant information in that case).
   *
   * Never throws. A CLI failure/timeout or an unparseable response degrades to
   * `{ intentFulfillmentScore: 0.5, confidence: 0, gaps: [<reason>], summary: '' }` — a documented,
   * honest "uncertain" result, never a fabricated pass or fail (Iron Law 3).
   */
  async validate(
    promptEntry: DecisionValidatorPromptEntry,
    projectPath: string,
    gatesPassed: boolean,
    gitDiff: string
  ): Promise<ValidationResult> {
    const promptId = promptEntry.id;
    const criticPrompt = buildCriticPrompt(promptEntry, gitDiff);

    this.log(
      `validating prompt '${promptId}' (type: ${promptEntry.prompt_type}, gates ${
        gatesPassed ? 'PASSED' : 'FAILED'
      }, diff ${gitDiff.length} chars) — independent critic pass`
    );

    let run: ClaudeRunResult;
    try {
      run = await this.runClaudeImpl(criticPrompt, projectPath);
    } catch (error) {
      // runClaude itself never throws (Contract 5 / Iron Law 3), but an injected test double or a
      // future transport swap might — degrade rather than let the whole Sentinel Prime pass die.
      const message = error instanceof Error ? error.message : String(error);
      return this.fallbackResult(promptId, promptEntry, gitDiff, `critic invocation threw: ${message}`);
    }

    if (!run.success) {
      const reason = run.timedOut
        ? 'critic CLI call timed out'
        : `critic CLI call failed (exit ${run.exitCode ?? 'null'}): ${run.stderr.trim().slice(0, 500)}`;
      return this.fallbackResult(promptId, promptEntry, gitDiff, reason);
    }

    const parseWarnings: string[] = [];
    const parsed = parseCriticResponse(run.stdout, (msg) => parseWarnings.push(msg));

    if (!parsed) {
      return this.fallbackResult(
        promptId,
        promptEntry,
        gitDiff,
        'critic response did not parse as the contracted JSON shape — fallback score applied'
      );
    }

    const intentActuallyFulfilled = parsed.intentFulfillmentScore >= INTENT_FULFILLMENT_THRESHOLD;
    const gaps = [...parsed.gaps, ...parseWarnings];

    const result: ValidationResult = {
      promptId,
      intentFulfillmentScore: parsed.intentFulfillmentScore,
      gatePassed: gatesPassed,
      intentActuallyFulfilled,
      promptSummary: truncateForPrompt(promptEntry.prompt, 400, 'prompt text'),
      outputSummary: parsed.summary,
      gaps,
      confidence: parsed.confidence,
    };

    this.logOutcome(result, gatesPassed);
    return result;
  }

  /** Log the critic's verdict — WARN (not halt) when gates passed but the critic disagrees. */
  private logOutcome(result: ValidationResult, gatesPassed: boolean): void {
    const scorePct = Math.round(result.intentFulfillmentScore * 100);
    if (result.intentActuallyFulfilled) {
      this.log(
        `prompt '${result.promptId}' — critic score ${scorePct}% (confidence ${Math.round(
          result.confidence * 100
        )}%) — intent fulfilled`
      );
      return;
    }

    const gapSummary = result.gaps.length > 0 ? ` gaps: ${result.gaps.join('; ')}` : '';
    if (gatesPassed) {
      this.log(
        `WARN: prompt '${result.promptId}' passed all mandatory Sentinel gates but the independent ` +
          `critic scored intent fulfillment at only ${scorePct}% (below the ${Math.round(
            INTENT_FULFILLMENT_THRESHOLD * 100
          )}% threshold) — gates passing does not mean the diff actually did the work.${gapSummary}`
      );
    } else {
      this.log(
        `WARN: prompt '${result.promptId}' critic score ${scorePct}% — below threshold, consistent ` +
          `with the mandatory gates also having failed.${gapSummary}`
      );
    }
  }

  /**
   * Build the documented fallback {@link ValidationResult} for any failure path (CLI failure,
   * timeout, unparseable response, thrown error) — score 0.5, confidence 0, the failure reason
   * recorded in `gaps`. Logged as WARN so a run of degraded critic passes is visible, not silent.
   */
  private fallbackResult(
    promptId: string,
    promptEntry: DecisionValidatorPromptEntry,
    gitDiff: string,
    reason: string
  ): ValidationResult {
    this.log(`WARN: prompt '${promptId}' — decision-validator degraded to fallback score: ${reason}`);
    return {
      promptId,
      intentFulfillmentScore: 0.5,
      gatePassed: false,
      intentActuallyFulfilled: false,
      promptSummary: truncateForPrompt(promptEntry.prompt, 400, 'prompt text'),
      outputSummary: '',
      gaps: [reason, ...(gitDiff.trim() === '' ? ['git diff was empty'] : [])],
      confidence: 0,
    };
  }
}

/**
 * Deterministic id helper for callers that want to tag a validation run before `validate()`
 * returns (e.g. correlating a WARN log line with a Sentinel Prime run record). Not used by
 * {@link ValidationResult} itself (`promptId` already identifies the record) — provided for
 * orchestration code that needs a fresh id ahead of time.
 */
export function newDecisionValidatorRunId(): string {
  return randomUUID();
}

/** Factory for a fresh {@link DecisionValidator} (mirrors the injectable-collaborator house style). */
export function createDecisionValidator(options: DecisionValidatorOptions = {}): DecisionValidator {
  return new DecisionValidator(options);
}

export default DecisionValidator;
