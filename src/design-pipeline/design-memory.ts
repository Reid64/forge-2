/**
 * FORGE 2.0 — Design Pipeline: DesignMemory (`src/design-pipeline/design-memory.ts`).
 *
 * `upgrades/DESIGN_INTELLIGENCE.md`'s component #22 ("Design Memory"): "Every time you approve or
 * reject something, FORGE records the decision... your approvals gradually become empirical design
 * preferences." `upgrades/SYSTEMS-5-9-GAP-MATRIX.md` row 22 confirmed zero prior implementation.
 *
 * WHAT IT DOES: maintains a cross-project (never per-project-scoped — the spec's own example,
 * "Reid historically prefers Design B-like layouts for industrial B2B applications," is a
 * standing preference read on EVERY future project) ledger of `prefer`/`reject` tags in the
 * `design_preferences` table, upserted by `(tag, polarity)` so repeated signals accumulate weight
 * rather than duplicating rows. Two real, non-fabricated sources feed it:
 *   1. Rejection feedback text a human actually typed into `review-gate.ts`'s interactive Reject
 *      prompt — {@link extractTagsFromFeedback} matches it against {@link CANONICAL_TAG_PHRASES},
 *      a fixed vocabulary drawn directly from the spec's own `prefers`/`rejects` examples plus
 *      `app-profiler.ts`'s brand-avoid vocabulary (kept in sync so the two subsystems speak the
 *      same tag language). A human's own words are real signal; nothing here infers sentiment
 *      from silence — an Approve with no free-text feedback yields no tags, which is correct, not
 *      a gap (Iron Law 3: never fabricate a preference nobody expressed).
 *   2. A Design Tournament winning/losing variant's OWN structural direction tags
 *      (`design-tournament.ts`) — these are real generation parameters the variant was actually
 *      built with (e.g. `high_density`, `restrained_motion`), not inferred from prose.
 *
 * {@link getPreferenceScore} turns the ledger into the single 0-1 number `design-router.ts`'s
 * `user_preference` scoring dimension reads — net (prefer weight - reject weight) over total
 * matching weight, defaulting to a neutral 0.5 when nothing in the ledger matches the tags asked
 * about (never a fabricated lean in either direction for an unknown tag).
 *
 * House style, matching every sibling `src/design-pipeline/` module: every persistence call is
 * Contract-4 best-effort (a Build Memory failure degrades to `[]`/`0.5`/`null`, never throws).
 */

import { newId, nowIso, runQuery } from '../memory/client.js';
import { logLine } from '../tools/forge-logger.js';

const log = logLine('design-memory');

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type DesignPreferencePolarity = 'prefer' | 'reject';

export interface DesignMemoryTag {
  tag: string;
  polarity: DesignPreferencePolarity;
  weight: number;
  occurrences: number;
}

export interface DesignMemoryPreferences {
  prefers: DesignMemoryTag[];
  rejects: DesignMemoryTag[];
}

// ---------------------------------------------------------------------------
// Vocabulary — canonical tag -> the phrases that count as a match in free text
// ---------------------------------------------------------------------------

/**
 * Every tag Design Memory knows how to extract from free-text feedback, drawn verbatim from
 * `upgrades/DESIGN_INTELLIGENCE.md`'s `design_memory.prefers`/`.rejects` example plus
 * `app-profiler.ts`'s `BRAND_DEFAULTS_BY_APPLICATION_TYPE` avoid-vocabulary (`generic_saas`,
 * `playful`, `cartoonish`, `cluttered`) so both subsystems recognize the same tag names.
 */
export const CANONICAL_TAG_PHRASES: Readonly<Record<string, readonly string[]>> = {
  strong_information_hierarchy: ['information hierarchy', 'visual hierarchy', 'clear hierarchy'],
  premium_industrial: ['premium industrial', 'industrial feel', 'industrial aesthetic'],
  larger_spacing: ['more spacing', 'larger spacing', 'more whitespace', 'too cramped'],
  restrained_motion: ['restrained motion', 'too much motion', 'too much animation', 'excessive motion'],
  realistic_photography: ['realistic photography', 'stock photo', 'real photography'],
  clear_navigation: ['clear navigation', 'confusing navigation', 'navigation is unclear'],
  non_generic_dashboard_layouts: ['generic dashboard', 'non-generic layout', 'cookie-cutter dashboard'],
  excessive_gradients: ['too many gradients', 'excessive gradients', 'gradient overload'],
  ai_slop_icons: ['ai slop', 'generic icons', 'stock icon set', 'ai-generated icons'],
  unnecessary_glassmorphism: ['glassmorphism', 'glass effect', 'frosted glass'],
  cramped_cards: ['cramped cards', 'cards feel cramped', 'crowded cards'],
  excessive_rounded_boxes: ['too rounded', 'excessive rounded', 'overly rounded corners'],
  decorative_charts: ['decorative chart', 'chart is decorative', 'charts add no value'],
  generic_saas: ['generic saas', 'looks like every saas', 'template saas'],
  playful: ['too playful', 'overly playful'],
  cartoonish: ['cartoonish', 'cartoon-like'],
  cluttered: ['cluttered', 'too busy', 'visually noisy'],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function containsPhrase(text: string, phrase: string): boolean {
  return text.toLowerCase().includes(phrase.toLowerCase());
}

// ---------------------------------------------------------------------------
// Public API — extraction
// ---------------------------------------------------------------------------

/**
 * Match `feedback` against {@link CANONICAL_TAG_PHRASES}, returning every canonical tag whose
 * phrase list has at least one substring hit. Polarity-agnostic by design — the caller supplies
 * polarity from the real context the feedback came from (e.g. always `'reject'` for
 * `review-gate.ts` Reject feedback, since that field only exists on a rejection).
 */
export function extractTagsFromFeedback(feedback: string): string[] {
  if (!feedback || feedback.trim() === '') return [];
  const matched: string[] = [];
  for (const [tag, phrases] of Object.entries(CANONICAL_TAG_PHRASES)) {
    if (phrases.some((phrase) => containsPhrase(feedback, phrase))) matched.push(tag);
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Persistence (Build Memory: design_preferences, schema 3.3.0)
// ---------------------------------------------------------------------------

interface DesignPreferenceRow {
  id: string;
  tag: string;
  polarity: DesignPreferencePolarity;
  weight: number;
  occurrences: number;
}

/**
 * Record `tags` as `polarity` signals, upserting `(tag, polarity)` — a repeated tag accumulates
 * weight/occurrences instead of duplicating rows. Best-effort (Contract 4): a Build Memory
 * failure is logged and swallowed, never thrown.
 */
export async function recordPreference(
  tags: readonly string[],
  polarity: DesignPreferencePolarity,
  projectName: string,
  source: string
): Promise<void> {
  if (tags.length === 0) return;
  await runQuery('design-memory.record', (db) => {
    const ts = nowIso();
    const upsert = db.prepare(
      `INSERT INTO design_preferences (id, tag, polarity, weight, occurrences, last_project, last_source, created_at, updated_at)
       VALUES (@id, @tag, @polarity, 1, 1, @project, @source, @ts, @ts)
       ON CONFLICT(tag, polarity) DO UPDATE SET
         weight = weight + 1,
         occurrences = occurrences + 1,
         last_project = @project,
         last_source = @source,
         updated_at = @ts`
    );
    for (const tag of tags) {
      upsert.run({ id: newId(), tag, polarity, project: projectName, source, ts });
    }
    return true;
  });
  log(`[DESIGN MEMORY] recorded ${tags.length} '${polarity}' tag(s) from ${source}: ${tags.join(', ')}`);
}

/**
 * Convenience wrapper: extract tags from rejection `feedback` text and record them all as
 * `'reject'` signals. Returns the matched tags (possibly `[]` — a feedback string with no
 * recognizable vocabulary hit is not an error, just nothing to learn from).
 */
export async function recordFromRejectionFeedback(
  feedback: string,
  projectName: string,
  source: string
): Promise<string[]> {
  const tags = extractTagsFromFeedback(feedback);
  if (tags.length > 0) await recordPreference(tags, 'reject', projectName, source);
  return tags;
}

/** Fetch the top `limit` tags per polarity, highest weight first. `[]`/`[]` on failure. */
export async function getPreferences(limit = 10): Promise<DesignMemoryPreferences> {
  const result = await runQuery<DesignMemoryPreferences>('design-memory.get', (db) => {
    const rows = db
      .prepare(`SELECT * FROM design_preferences WHERE polarity = ? ORDER BY weight DESC, occurrences DESC LIMIT ?`)
      .all('prefer', limit) as DesignPreferenceRow[];
    const rejectRows = db
      .prepare(`SELECT * FROM design_preferences WHERE polarity = ? ORDER BY weight DESC, occurrences DESC LIMIT ?`)
      .all('reject', limit) as DesignPreferenceRow[];
    const toTag = (r: DesignPreferenceRow): DesignMemoryTag => ({
      tag: r.tag,
      polarity: r.polarity,
      weight: r.weight,
      occurrences: r.occurrences,
    });
    return { prefers: rows.map(toTag), rejects: rejectRows.map(toTag) };
  });
  return result ?? { prefers: [], rejects: [] };
}

/**
 * The 0-1 `user_preference` score {@link "design-router.ts"} folds into its weighted formula: net
 * (prefer weight - reject weight) over total matching weight for the given `tags`, rescaled to
 * [0, 1] around a neutral midpoint of 0.5. Returns exactly 0.5 (neutral — no lean either way) when
 * none of `tags` has ANY recorded weight, never a fabricated preference for an unobserved tag.
 */
export async function getPreferenceScore(tags: readonly string[]): Promise<number> {
  if (tags.length === 0) return 0.5;
  const totals = await runQuery<{ preferSum: number; rejectSum: number }>('design-memory.score', (db) => {
    const placeholders = tags.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT polarity, weight FROM design_preferences WHERE tag IN (${placeholders})`)
      .all(...tags) as Array<{ polarity: DesignPreferencePolarity; weight: number }>;
    let preferSum = 0;
    let rejectSum = 0;
    for (const row of rows) {
      if (row.polarity === 'prefer') preferSum += row.weight;
      else rejectSum += row.weight;
    }
    return { preferSum, rejectSum };
  });
  if (!totals) return 0.5;
  const total = totals.preferSum + totals.rejectSum;
  if (total === 0) return 0.5;
  const net = totals.preferSum - totals.rejectSum;
  const score = 0.5 + 0.5 * (net / total);
  return Math.max(0, Math.min(1, score));
}

/** Render {@link DesignMemoryPreferences} as a human-readable block (used by `forge design-memory`). */
export function formatPreferences(preferences: DesignMemoryPreferences): string {
  const lines: string[] = [];
  lines.push('prefers:');
  if (preferences.prefers.length === 0) lines.push('  (none recorded yet)');
  for (const t of preferences.prefers) lines.push(`  - ${t.tag} (weight ${t.weight}, seen ${t.occurrences}x)`);
  lines.push('rejects:');
  if (preferences.rejects.length === 0) lines.push('  (none recorded yet)');
  for (const t of preferences.rejects) lines.push(`  - ${t.tag} (weight ${t.weight}, seen ${t.occurrences}x)`);
  return lines.join('\n');
}

export default getPreferences;
