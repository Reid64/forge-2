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
 */
export function filterRetiredPatterns(patterns: ErrorPattern[], db: MemoryDb): ErrorPattern[] {
  if (patterns.length === 0) return patterns;
  try {
    const rows = db
      .prepare(
        `SELECT ep.error_signature AS error_signature
         FROM error_patterns ep
         WHERE NOT EXISTS (
           SELECT 1 FROM pattern_retirement_log prl
           WHERE prl.pattern_table = 'error_patterns'
             AND prl.pattern_fingerprint = ep.error_signature
         )`
      )
      .all() as Array<{ error_signature: string }>;
    const surviving = new Set(rows.map((r) => r.error_signature));
    return patterns.filter((p) => surviving.has(p.error_signature));
  } catch (err) {
    logMemoryWarning('filterRetiredPatterns', err);
    return patterns;
  }
}
