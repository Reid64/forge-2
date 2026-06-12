/**
 * FORGE 2.0 — Schema validation seam (`schema-validator`).
 *
 * Iron Law 8: validate external/boundary data before acting on it. Every wrapper here is a THIN
 * adapter over a Zod `safeParse` — it never throws and never blocks. A shape mismatch is reported
 * as structured drift on the `forge-validation` log channel (or, for config, returned to the
 * caller), while the caller's existing tolerant read still runs. This keeps validation a
 * non-blocking guard rail, not a gate.
 *
 * The module re-exports {@link z} so callers declare their schemas from a single Zod instance, and
 * ships the two external wire contracts ({@link AnthropicMessagesResponseSchema},
 * {@link OpenAIChatResponseSchema}) the provider router validates — deliberately lenient (all
 * fields optional) so a sparse-but-valid body is never rejected.
 *
 * BOUNDARY: this module reaches OUT to the logger only; it imports no memory/CRUD module, so it
 * introduces no import cycle.
 */

import { z } from 'zod';
import { getLogger } from './forge-logger.js';

export { z };

/** A single field-level validation problem. */
export interface ValidationIssue {
  path: string;
  message: string;
}

/** Result of a non-throwing validation. `issues` is empty when `ok` is true. */
export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** Reporting context shared by the boundary validators. */
export interface ValidateOptions {
  /** Where the validation happened — e.g. `provider-router:anthropic`. */
  context: string;
  /** What was being validated — e.g. `anthropic-messages`, `.env`. */
  target?: string;
  /**
   * When true (default) drift is logged to the `forge-validation` channel. Set false to suppress
   * logging and rely solely on the returned `issues` (config load does this — Build Memory may not
   * be reachable yet).
   */
  report?: boolean;
}

function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}

/** Run a schema against a value without throwing, returning a flat `{ ok, issues }` result. */
function check<T>(schema: z.ZodType<T>, value: unknown): ValidationResult {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, issues: [] };
  return { ok: false, issues: toIssues(parsed.error) };
}

/** Emit validation drift to the dedicated `forge-validation` channel. Never throws. */
function reportDrift(result: ValidationResult, options: ValidateOptions): void {
  if (result.ok || options.report === false) return;
  const summary = result.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
  getLogger('forge-validation').warn(
    { context: options.context, target: options.target, issues: result.issues },
    `validation drift in ${options.target ?? 'payload'} (${options.context}) — ${summary}`
  );
}

/**
 * Validate a parsed config object. NON-BLOCKING: returns `{ ok, issues }` for the caller to surface
 * as warnings; with `report: false` it does not touch the log channel.
 */
export function validateConfigFile<T>(
  schema: z.ZodType<T>,
  value: unknown,
  options: ValidateOptions
): ValidationResult {
  const result = check(schema, value);
  reportDrift(result, options);
  return result;
}

/**
 * Validate an external API response body before reading it. NON-BLOCKING: logs drift to
 * `forge-validation` and returns the result; the caller's tolerant read runs regardless.
 */
export function validateApiResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  options: ValidateOptions
): ValidationResult {
  const result = check(schema, value);
  reportDrift(result, options);
  return result;
}

/**
 * Validate a row about to be written to Build Memory. NON-BLOCKING: logs drift to `forge-validation`
 * and returns the result; the write proceeds regardless (a learning-store write never halts the
 * pipeline).
 */
export function validateMemoryWrite(
  table: string,
  record: unknown,
  options: Omit<ValidateOptions, 'target'>
): ValidationResult {
  // No per-table schema is registered here (the CRUD layer owns row shapes — wiring them in would
  // close an import cycle). We assert the record is a non-null object and report anything else as
  // drift, which is the seam Build Memory's caller-side `validateMemoryWrite` is meant to provide.
  const result = check(z.object({}).passthrough(), record);
  reportDrift(result, { ...options, target: table });
  return result;
}

// ---------------------------------------------------------------------------
// External wire contracts — deliberately lenient (all fields optional) so a sparse-but-valid body
// is accepted. They assert SHAPE, not completeness; the tolerant reads downstream handle absence.
// ---------------------------------------------------------------------------

/** Anthropic Messages API response shape (partial — only the fields FORGE reads). */
export const AnthropicMessagesResponseSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    role: z.string().optional(),
    model: z.string().optional(),
    stop_reason: z.string().nullable().optional(),
    content: z
      .array(
        z
          .object({
            type: z.string().optional(),
            text: z.string().optional(),
          })
          .passthrough()
      )
      .optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** OpenAI Chat Completions response shape (partial — covers the OpenAI-compatible providers too). */
export const OpenAIChatResponseSchema = z
  .object({
    id: z.string().optional(),
    object: z.string().optional(),
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            index: z.number().optional(),
            finish_reason: z.string().nullable().optional(),
            message: z
              .object({
                role: z.string().optional(),
                content: z.string().nullable().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
      )
      .optional(),
    usage: z
      .object({
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
        total_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
