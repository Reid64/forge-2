/**
 * FORGE 2.0 — Learning Engine: retired-pattern anti-join filter.
 *
 * Excludes `error_patterns` rows a `PatternRetirer` has retired
 * (`upgrades/SCHEMA_ADDITIONS.md` §4, `pattern_retirement_log`) from a pattern list before
 * it reaches a prompt-rewriter / prompt-assembler / failure-predictor consumer.
 * `error_patterns` carries no `active`-style column of its own — per SCHEMA_ADDITIONS.md
 * §4, retirement there is soft, tracked only via this log — so `pattern_retirement_log`
 * is the sole source of truth for whether a row is still live: any row logged there for
 * `pattern_table = 'error_patterns'` is retired. There is no `retirement_confirmed`
 * column on `pattern_retirement_log` (append-only — a logged row IS the confirmation)
 * and no `error_signature` column (the natural key is stored as `pattern_fingerprint`);
 * the anti-join below uses the real columns rather than those names.
 */

import type { ErrorPattern } from '../types/index.js';
import { logMemoryWarning, type MemoryDb } from '../memory/client.js';

/**
 * Anti-join `patterns` against `pattern_retirement_log` for `pattern_table = 'error_patterns'`,
 * dropping any pattern whose `error_signature` has been retired. Never throws — degrades to
 * returning `patterns` unfiltered on query failure (Contract 4).
 *
 * Queries the retirement log directly rather than joining through the real `error_patterns`
 * table: `patterns` is caller-supplied and is not required to already be a persisted row there
 * (an injectable/synthetic candidate set, e.g. from a test fixture or a not-yet-written failure
 * prediction, is exactly as valid an input as a set of real rows). The previous `WHERE NOT
 * EXISTS` join computed "surviving" as signatures both present in `error_patterns` AND not
 * retired — so ANY candidate that wasn't already a literal `error_patterns` row got silently
 * dropped as if it had been retired, even though it was never retired at all.
 */
export function filterRetiredPatterns(patterns: ErrorPattern[], db: MemoryDb): ErrorPattern[] {
  if (patterns.length === 0) return patterns;
  try {
    const rows = db
      .prepare(`SELECT pattern_fingerprint FROM pattern_retirement_log WHERE pattern_table = 'error_patterns'`)
      .all() as Array<{ pattern_fingerprint: string }>;
    const retired = new Set(rows.map((r) => r.pattern_fingerprint));
    return patterns.filter((p) => !retired.has(p.error_signature));
  } catch (err) {
    logMemoryWarning('filterRetiredPatterns', err);
    return patterns;
  }
}
