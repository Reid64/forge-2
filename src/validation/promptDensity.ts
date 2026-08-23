/**
 * FORGE 2.0 — Prompt Density Enforcement (Phase 3 preflight gate).
 *
 * Some prompts are shaped in ways that reliably cause trouble once handed to `claude -p`
 * (BEHAVIORAL_CONTRACTS Contract 5): backgrounding a long-running network fetch so the CLI
 * exits before the work is done (the exact `Start-Job` / detached-spawn failure mode
 * documented in `claude-runner.ts`'s module header), or a prompt so link-dense it is really a
 * bulk-ingest job disguised as one build step. {@link validatePrompt} scores a single prompt
 * text against those known-bad shapes BEFORE the queue ever starts — errors block the run
 * entirely (Iron Law 3: better to refuse than to silently produce a broken/backgrounded run),
 * warnings are logged but never block.
 *
 * PURE + NON-FATAL: `validatePrompt` performs no I/O and never throws.
 */

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The outcome of validating one prompt's text. */
export interface PromptDensityResult {
  /** False when any error rule fired — the caller must not start the queue. */
  valid: boolean;
  /** Non-blocking observations (logged, never stop the run). */
  warnings: string[];
  /** Blocking observations — the queue must not start while any exist. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Heuristic characters-per-token used for the token-count warning (matches claude-runner.ts). */
const CHARS_PER_TOKEN = 4;

/** Warn when the estimated token count exceeds this. */
const MAX_TOKENS_BEFORE_WARNING = 8000;

/** Error when more than this many DISTINCT URLs appear with no `--dry-run` escape hatch. */
const MAX_URLS_BEFORE_ERROR = 15;

/** Phrases that background/detach a process (the Session 5 finding #13 failure shape). */
const BACKGROUNDING_PHRASES = ['background', 'nohup', 'start-job', 'invoke-expression'];

/** Phrases indicating bulk network/ingest work — dangerous when combined with backgrounding. */
const NETWORK_WORK_PHRASES = ['ingest', 'fetch', 'embed', 'download'];

/** Phrases indicating a fetch/download step (for the fetch+embed split-suggestion warning). */
const FETCH_PHRASES = ['fetch', 'download'];

/** Phrases indicating an embedding/vector step (for the fetch+embed split-suggestion warning). */
const EMBED_PHRASES = ['embed', 'vector'];

/** Matches an http(s) URL token (scheme through the next whitespace/quote/bracket). */
const URL_PATTERN = /https?:\/\/[^\s"'`)\]]+/gi;

const DRY_RUN_ESCAPE_HATCH = '--dry-run';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when `text` contains any of `phrases` (case-insensitive substring match). */
function containsAny(lower: string, phrases: readonly string[]): boolean {
  return phrases.some((p) => lower.includes(p));
}

/** Count of DISTINCT (case-insensitive) http(s) URLs in `text`. */
function distinctUrlCount(text: string): number {
  const matches = text.match(URL_PATTERN) ?? [];
  return new Set(matches.map((u) => u.toLowerCase())).size;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Validate one prompt's text against FORGE's density rules. `id` is used only to prefix the
 * `[DENSITY]` log lines the caller emits from `warnings`/`errors` — this function itself never
 * logs (pure, testable, no I/O).
 */
export function validatePrompt(prompt: string, id: string): PromptDensityResult {
  void id; // carried by the caller for logging; not needed to evaluate the rules themselves
  const warnings: string[] = [];
  const errors: string[] = [];
  const lower = prompt.toLowerCase();

  // --- Errors (block the queue from starting) -------------------------------------------------

  if (containsAny(lower, BACKGROUNDING_PHRASES) && containsAny(lower, NETWORK_WORK_PHRASES)) {
    errors.push(
      'Prompt combines a backgrounding/detach phrase (background, nohup, Start-Job, or ' +
        'Invoke-Expression) with network/ingest work (ingest, fetch, embed, or download) — this is ' +
        'the exact shape that silently backgrounds a long-running fetch and lets claude exit before ' +
        'the work finishes. Run the network work synchronously in the foreground instead.'
    );
  }

  const urlCount = distinctUrlCount(prompt);
  if (urlCount > MAX_URLS_BEFORE_ERROR && !prompt.includes(DRY_RUN_ESCAPE_HATCH)) {
    errors.push(
      `Prompt contains ${urlCount} distinct URLs (> ${MAX_URLS_BEFORE_ERROR}) with no ${DRY_RUN_ESCAPE_HATCH} ` +
        'escape hatch — this looks like a bulk-ingest job disguised as one build prompt. Split it into ' +
        `smaller prompts, or add \`${DRY_RUN_ESCAPE_HATCH}\` if a dry run is genuinely intended.`
    );
  }

  // --- Warnings (logged, never block) ----------------------------------------------------------

  const estimatedTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
  if (estimatedTokens > MAX_TOKENS_BEFORE_WARNING) {
    warnings.push(
      `Estimated prompt size is ~${estimatedTokens} tokens (> ${MAX_TOKENS_BEFORE_WARNING}) — consider ` +
        'trimming or splitting this prompt.'
    );
  }

  if (containsAny(lower, FETCH_PHRASES) && containsAny(lower, EMBED_PHRASES)) {
    warnings.push(
      'Prompt contains both fetch/download AND embed/vector operations — consider splitting into a ' +
        'fetch step and a separate embed step so each can be retried/timed independently.'
    );
  }

  return { valid: errors.length === 0, warnings, errors };
}

export default validatePrompt;
