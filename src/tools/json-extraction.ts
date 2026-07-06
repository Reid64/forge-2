/**
 * FORGE 2.0 — Shared JSON-recovery utilities for model responses.
 *
 * Every FORGE phase/command that asks a model for structured JSON (Phase 1B's eight
 * artifacts, `forge generate-prompts`'s phase plan + per-phase entries, …) hits the same
 * failure mode: the model is instructed to respond with ONLY a JSON value, but occasionally
 * wraps it in prose or a ```json fence. This module centralizes the tolerant recovery
 * strategy (originally authored in `src/phases/phase1b-architect.ts`) so it is implemented
 * ONCE and reused, not copy-pasted per caller.
 */

/** Final, unmissable output-contract line appended to the end of every prompt asking for JSON. */
export const JSON_ONLY_DIRECTIVE =
  'RESPOND WITH ONLY A VALID JSON OBJECT. NO PROSE. NO EXPLANATION. NO MARKDOWN FENCES. ' +
  'JUST THE RAW JSON OBJECT STARTING WITH { AND ENDING WITH }.';

/** Same directive, worded for a top-level JSON ARRAY response (`forge generate-prompts` phases). */
export const JSON_ARRAY_ONLY_DIRECTIVE =
  'RESPOND WITH ONLY A VALID JSON ARRAY. NO PROSE. NO EXPLANATION. NO MARKDOWN FENCES. ' +
  'JUST THE RAW JSON ARRAY STARTING WITH [ AND ENDING WITH ].';

/** Validates+casts a freshly-parsed JSON value; returns `null` when it does not match. */
type JsonValidator<T> = (value: unknown) => T | null;

const asJsonObject: JsonValidator<Record<string, unknown>> = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const asJsonArray: JsonValidator<unknown[]> = (v) => (Array.isArray(v) ? v : null);

/**
 * Robustly extract and parse a single JSON value (object or array) from a model response.
 * The model is asked for bare JSON, but Claude sometimes wraps it in prose or a ```json
 * fence. Three strategies are tried, in order of fidelity:
 *
 *   1. `JSON.parse` on the RAW response — the contracted happy path (no recovery needed).
 *   2. The first `openChar` … last `closeChar` substring — recovers a value surrounded by prose.
 *   3. The JSON inside a ```json … ``` (or bare ```) markdown code fence — recovers a fenced
 *      value when prose on both sides also contained stray brackets.
 *
 * Strategy 1 is tried FIRST (before any fence handling) on purpose: a valid response's string
 * fields routinely contain ``` fences, so fence-matching a well-formed value first would
 * corrupt it. `warn` is invoked when a recovery strategy (2 or 3) is used so the operator sees
 * that the model drifted from the bare-JSON contract. Returns `null` only when no strategy
 * yields a value matching `validate`.
 */
function extractJsonWith<T>(
  text: string,
  openChar: '{' | '[',
  closeChar: '}' | ']',
  validate: JsonValidator<T>,
  warn?: (message: string) => void
): T | null {
  // Strategy 1 — the response IS the JSON value (no fallback extraction needed).
  try {
    const v = validate(JSON.parse(text.trim()) as unknown);
    if (v !== null) return v;
  } catch {
    // Not bare JSON — fall through to the tolerant recovery strategies.
  }

  // Strategy 2 — first `openChar` … last `closeChar` substring (value wrapped in prose).
  const start = text.indexOf(openChar);
  const end = text.lastIndexOf(closeChar);
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const v = validate(JSON.parse(text.slice(start, end + 1)) as unknown);
      if (v !== null) {
        warn?.('model returned prose around the JSON; recovered the bracket-delimited substring (fallback extraction)');
        return v;
      }
    } catch {
      // Substring did not parse — fall through to fenced-code extraction.
    }
  }

  // Strategy 3 — JSON inside a ```json … ``` (or bare ```) markdown code fence.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced && fenced[1] !== undefined) {
    const inner = fenced[1];
    const fStart = inner.indexOf(openChar);
    const fEnd = inner.lastIndexOf(closeChar);
    const candidate =
      fStart !== -1 && fEnd !== -1 && fEnd > fStart ? inner.slice(fStart, fEnd + 1) : inner.trim();
    try {
      const v = validate(JSON.parse(candidate) as unknown);
      if (v !== null) {
        warn?.('model wrapped the JSON in a markdown code fence; extracted it via regex (fallback extraction)');
        return v;
      }
    } catch {
      // Fenced content did not parse either — give up below.
    }
  }

  return null;
}

/** Extract a top-level JSON OBJECT from a model response. See {@link extractJsonWith}. */
export function extractJsonObject(
  text: string,
  warn?: (message: string) => void
): Record<string, unknown> | null {
  return extractJsonWith(text, '{', '}', asJsonObject, warn);
}

/** Extract a top-level JSON ARRAY from a model response. See {@link extractJsonWith}. */
export function extractJsonArray(text: string, warn?: (message: string) => void): unknown[] | null {
  return extractJsonWith(text, '[', ']', asJsonArray, warn);
}
