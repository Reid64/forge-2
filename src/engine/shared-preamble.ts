/**
 * FORGE 2.0 — Shared Prompt Preamble (token-efficiency).
 *
 * Every Phase 3 prompt restated the same handful of universal instructions inline — "run
 * `pnpm run build` and confirm 0 errors", "`git add -A` / `git commit`", "never guess at file
 * contents", "stay inside the target project path" — once per queue.yaml entry. These rules are
 * constant across every prompt in every build, not task-specific content, so at 50+ prompts per
 * build the repetition cost thousands of tokens for zero informational gain.
 *
 * This module gives the four rules ONE canonical home ({@link SHARED_PREAMBLE}) and a single
 * injection point ({@link injectSharedPreamble}) that prepends it exactly once to an assembled
 * prompt and strips any equivalent restatement already present in the body, so the same guidance
 * is never paid for twice in one prompt. {@link stripSharedPreambleDuplicates} exposes the same
 * stripping pass without the prepend, for cleaning a queue.yaml prompt's raw description text
 * before it ever reaches the assembler.
 */

/** The four universal rules every Phase 3 prompt needs, stated exactly once. */
export const SHARED_PREAMBLE =
  '## Universal build rules (apply to every task, every file)\n\n' +
  '- BUILD: after every change, run `pnpm run build` and confirm 0 errors before considering the change complete.\n' +
  '- COMMIT: stage and commit your work with `git add -A` and `git commit -m "<descriptive message>"`.\n' +
  '- NEVER GUESS: read the actual file contents before making changes — never assume what a file contains.\n' +
  '- STAY IN SCOPE: only create, modify, or delete files inside the target project path.';

/**
 * One regex per {@link SHARED_PREAMBLE} rule — matches a queue.yaml/governance restatement of the
 * same instruction (as a whole line) so it can be stripped before the canonical block is
 * prepended, rather than paid for twice in the same prompt.
 */
const DUPLICATE_RULE_PATTERNS: RegExp[] = [
  // BUILD: any line naming both "pnpm run build" and a 0/zero-errors confirmation.
  /^.*\bpnpm run build\b.*\b(?:0|zero)\s*errors?\b.*$/gim,
  // COMMIT: any line naming both "git add -A" and "git commit".
  /^.*\bgit add -A\b.*\bgit commit\b.*$/gim,
  // NEVER GUESS: any line telling the model not to guess/assume file contents.
  /^.*\bnever\s+(?:guess|assume)\b.*\bfile\b.*$/gim,
  // STAY IN SCOPE: any line restricting writes to the target project path/root/directory.
  /^.*\b(?:only\s+(?:modify|create|write|touch|change)|stay\s+(?:confined|within|inside))\b.*\b(?:project\s+path|project\s+root|project\s+directory|target\s+project)\b.*$/gim,
];

/** Remove every line matching {@link DUPLICATE_RULE_PATTERNS} from `text`, collapsing the resulting blank runs. */
function stripDuplicateRuleLines(text: string): string {
  let out = text;
  for (const pattern of DUPLICATE_RULE_PATTERNS) {
    out = out.replace(pattern, '');
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Strip duplicate universal-rule restatements from a queue.yaml prompt body WITHOUT prepending
 * {@link SHARED_PREAMBLE}. Used by the Phase 3 queue runner to clean `entry.description` before it
 * ever reaches the assembler, so boilerplate baked into a queue.yaml entry doesn't ride along as
 * dead weight ahead of the assembler's own single injection.
 */
export function stripSharedPreambleDuplicates(text: string): string {
  return stripDuplicateRuleLines(text);
}

/**
 * Prepend {@link SHARED_PREAMBLE} to `promptText` exactly once, after stripping any line in the
 * body that already restates one of its four universal rules. Idempotent: re-running on an
 * already-injected prompt strips the previous preamble (its lines match the same patterns) and
 * prepends an identical fresh one — it never doubles up.
 */
export function injectSharedPreamble(promptText: string): string {
  const deduped = stripDuplicateRuleLines(promptText);
  return `${SHARED_PREAMBLE}\n\n${deduped}`;
}

export default injectSharedPreamble;
