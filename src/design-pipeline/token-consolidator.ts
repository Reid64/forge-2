/**
 * FORGE 2.0 — Design Pipeline: TokenConsolidator (`src/design-pipeline/token-consolidator.ts`).
 *
 * The second stage of `design-system-extractor.ts`'s implicit-design-system pipeline:
 * `extractDesignSystem` finds repeated LITERAL values (`'#3B82F6'`, `'#3b82f6'`, `'rgb(59, 130,
 * 246)'`, `'p-4'`, `'16px'`, `'1rem'`, ...); this module DEDUPES those literals into one
 * consolidated token per real underlying value — the same blue counted once instead of three times,
 * the same 16px spacing counted once whether it was written as a Tailwind class or a raw CSS length.
 *
 * NORMALIZATION APPROACH: exact-match-after-normalization, not perceptual clustering (the task's
 * own documented scope — "doesn't need perceptual color-distance clustering unless trivially easy
 * to add," and it is not: real perceptual color distance (CIEDE2000 etc.) needs a color-science
 * dependency this codebase doesn't have, so grouping stays exact-after-normalization, matching every
 * other lightweight heuristic in this codebase's static-analysis modules):
 *   - COLOR: hex (`#rgb`/`#rrggbb`, any case) and `rgb()`/`rgba()` are parsed to an `{r,g,b}` triple
 *     (alpha ignored for grouping) and re-rendered as one canonical lowercase 6-digit hex string.
 *   - SPACING: a raw CSS length (`px`/`rem`/`em`) or a Tailwind spacing utility class (`p-4`,
 *     `gap-x-2`, `space-y-px`) is normalized to its PIXEL value, assuming the standard 16px root
 *     font size and Tailwind's own default 4px-per-unit spacing scale (both real, documented
 *     defaults — never an invented constant). `em` is treated identically to `rem` (true CSS `em`
 *     is relative to the computed parent font size, which this static, no-DOM scan cannot resolve;
 *     treating it as `rem` is a documented approximation, not silently assumed precision).
 *   - TYPOGRAPHY: font-SIZE literals (Tailwind `text-*` classes or CSS lengths) normalize to pixels
 *     the same way as spacing, using Tailwind's own default `text-*` scale. Font-FAMILY literals
 *     (Tailwind `font-sans`/`font-serif`/`font-mono` or a CSS `font-family` declaration) normalize
 *     to the first family in the stack, quote-stripped and lowercased (matching how a browser itself
 *     resolves a font stack). The two are disambiguated by SHAPE (does the literal look like a
 *     number+unit/`text-*` class, or not) rather than by a separate stored subcategory, since
 *     `design-system-extractor.ts` reports both under the single `'typography'` category.
 *
 * Never drops a finding: a value this module cannot recognize/normalize is still consolidated,
 * just grouped under its own raw-value key rather than merged with anything else (Iron Law 3 —
 * every raw finding must appear somewhere in the output, never silently discarded because it didn't
 * fit a known pattern).
 */

import type { DesignTokenCategory, RawTokenFinding } from './design-system-extractor.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface ConsolidatedToken {
  category: DesignTokenCategory;
  /** The normalized, representative form of this token, e.g. `'#3b82f6'`, `'16px'`, `'inter'`. */
  canonicalValue: string;
  /** Every distinct raw literal (from `design-system-extractor.ts`) that normalized to this token, sorted. */
  originalValues: string[];
  /** Sum of `RawTokenFinding.occurrences` across every merged raw value. */
  totalOccurrences: number;
  /** Distinct file count across every merged raw value's `files`. */
  totalFileCount: number;
  files: string[];
}

export interface TokenConsolidationResult {
  /** Consolidated tokens, sorted by `totalOccurrences` desc. */
  tokens: ConsolidatedToken[];
  inputFindingCount: number;
  consolidatedCount: number;
}

// ---------------------------------------------------------------------------
// Normalization tables (real, documented defaults — never invented constants)
// ---------------------------------------------------------------------------

const TAILWIND_SPACING_PREFIXES = [
  'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr',
  'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr',
  'gap', 'gap-x', 'gap-y', 'space-x', 'space-y',
];
const TAILWIND_SPACING_CLASS_RE = new RegExp(`^(?:${TAILWIND_SPACING_PREFIXES.join('|')})-(px|\\d+(?:\\.\\d+)?)$`);
/** Tailwind's default spacing scale: class suffix N -> N * 4px (1 unit = 0.25rem at the default 16px root). `px` suffix -> 1px. */
const TAILWIND_SPACING_UNIT_PX = 4;

const TAILWIND_FONT_SIZE_CLASS_RE = /^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)$/;
/** Tailwind's default `text-*` font-size scale, in px (16px root). */
const TAILWIND_FONT_SIZE_PX: Readonly<Record<string, number>> = {
  xs: 12, sm: 14, base: 16, lg: 18, xl: 20,
  '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48,
  '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128,
};

const TAILWIND_FONT_FAMILY_CLASS_RE = /^font-(sans|serif|mono)$/;
const TAILWIND_FONT_FAMILY_GENERIC: Readonly<Record<string, string>> = {
  sans: 'sans-serif',
  serif: 'serif',
  mono: 'monospace',
};

const CSS_LENGTH_RE = /^(\d+(?:\.\d+)?)(px|rem|em|%)$/;
const ROOT_FONT_SIZE_PX = 16;

// ---------------------------------------------------------------------------
// Public normalization functions (individually testable, individually reusable)
// ---------------------------------------------------------------------------

function parseHexColor(value: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim());
  if (!m || !m[1]) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
}

function parseRgbColor(value: string): { r: number; g: number; b: number } | null {
  const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(value.trim());
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

/**
 * Normalize any recognized color literal (`#3B82F6`, `#3b82f6`, `rgb(59, 130, 246)`, `#39f`, ...) to
 * the same lowercase 6-digit hex string, so exact-duplicate-after-normalization colors group
 * together. Alpha is deliberately ignored for grouping. `null` for a value this function doesn't
 * recognize as a color at all.
 */
export function normalizeColorValue(value: string): string | null {
  const rgb = parseHexColor(value) ?? parseRgbColor(value);
  if (!rgb) return null;
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

/**
 * Normalize a spacing literal — a raw CSS length (`16px`, `1rem`, `1em`) or a Tailwind spacing
 * utility class (`p-4`, `gap-x-2`, `space-y-px`) — to its pixel value (see file header for the
 * documented 16px-root / 4px-per-unit assumptions). `null` for an unrecognized value or a `%` length
 * (no absolute pixel equivalent exists for a percentage).
 */
export function normalizeSpacingValue(value: string): number | null {
  const trimmed = value.trim();

  const twClass = TAILWIND_SPACING_CLASS_RE.exec(trimmed);
  if (twClass && twClass[1]) {
    return twClass[1] === 'px' ? 1 : Number(twClass[1]) * TAILWIND_SPACING_UNIT_PX;
  }

  const cssLength = CSS_LENGTH_RE.exec(trimmed);
  if (cssLength && cssLength[1] && cssLength[2]) {
    const n = Number(cssLength[1]);
    if (cssLength[2] === 'px') return n;
    if (cssLength[2] === 'rem' || cssLength[2] === 'em') return n * ROOT_FONT_SIZE_PX;
    return null; // '%'
  }

  return null;
}

/**
 * Normalize a font-size literal (CSS length or Tailwind `text-*` class) to its pixel value, using
 * the same 16px-root assumption as {@link normalizeSpacingValue} plus Tailwind's documented default
 * `text-*` scale. `null` for an unrecognized value.
 */
export function normalizeFontSizeValue(value: string): number | null {
  const trimmed = value.trim();

  const twSize = TAILWIND_FONT_SIZE_CLASS_RE.exec(trimmed);
  if (twSize && twSize[1]) return TAILWIND_FONT_SIZE_PX[twSize[1]] ?? null;

  const cssLength = CSS_LENGTH_RE.exec(trimmed);
  if (cssLength && cssLength[1] && cssLength[2]) {
    const n = Number(cssLength[1]);
    if (cssLength[2] === 'px') return n;
    if (cssLength[2] === 'rem' || cssLength[2] === 'em') return n * ROOT_FONT_SIZE_PX;
    return null; // '%'
  }

  return null;
}

/**
 * Normalize a font-family literal — a Tailwind `font-sans`/`font-serif`/`font-mono` class or a raw
 * CSS `font-family` declaration value (`"'Inter', sans-serif"`) — to a lowercase, quote-stripped
 * canonical family name: the FIRST family in a comma-separated stack, matching how a browser itself
 * resolves the declaration. `null` for an empty/unparseable value.
 */
export function normalizeFontFamilyValue(value: string): string | null {
  const trimmed = value.trim();

  const twFamily = TAILWIND_FONT_FAMILY_CLASS_RE.exec(trimmed);
  if (twFamily && twFamily[1]) return TAILWIND_FONT_FAMILY_GENERIC[twFamily[1]] ?? null;

  const first = trimmed.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '');
  return first ? first.toLowerCase() : null;
}

/** Whether a `'typography'`-category literal looks like a SIZE (number+unit or Tailwind `text-*`) rather than a family. */
function isFontSizeLiteral(value: string): boolean {
  const trimmed = value.trim();
  return TAILWIND_FONT_SIZE_CLASS_RE.test(trimmed) || CSS_LENGTH_RE.test(trimmed);
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Compute the grouping key + canonical display value for one finding, by category. A `null`
 * normalization result still produces a (raw-value-scoped) key — see file header, "never drops a
 * finding."
 */
function keyAndCanonical(finding: RawTokenFinding): { key: string; canonical: string } {
  if (finding.category === 'color') {
    const norm = normalizeColorValue(finding.value);
    return norm ? { key: `color:${norm}`, canonical: norm } : { key: `color:raw:${finding.value}`, canonical: finding.value };
  }

  if (finding.category === 'spacing') {
    const px = normalizeSpacingValue(finding.value);
    return px !== null
      ? { key: `spacing:${px}`, canonical: `${px}px` }
      : { key: `spacing:raw:${finding.value}`, canonical: finding.value };
  }

  // 'typography' — disambiguate font-size vs font-family by shape (see isFontSizeLiteral).
  if (isFontSizeLiteral(finding.value)) {
    const px = normalizeFontSizeValue(finding.value);
    return px !== null
      ? { key: `font-size:${px}`, canonical: `${px}px` }
      : { key: `font-size:raw:${finding.value}`, canonical: finding.value };
  }
  const family = normalizeFontFamilyValue(finding.value);
  return family
    ? { key: `font-family:${family}`, canonical: family }
    : { key: `font-family:raw:${finding.value}`, canonical: finding.value };
}

interface TokenGroup {
  category: DesignTokenCategory;
  canonicalValue: string;
  originalValues: Set<string>;
  totalOccurrences: number;
  files: Set<string>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Consolidate `design-system-extractor.ts`'s raw repeated-value findings into deduped tokens: every
 * finding whose literal value normalizes to the same canonical form is merged into one
 * {@link ConsolidatedToken}, with occurrence/file counts summed and every distinct raw literal
 * preserved in `originalValues`. Pure, no I/O, never throws. Sorted by `totalOccurrences` desc.
 */
export function consolidateTokens(findings: readonly RawTokenFinding[]): TokenConsolidationResult {
  const groups = new Map<string, TokenGroup>();

  for (const finding of findings) {
    const { key, canonical } = keyAndCanonical(finding);
    let group = groups.get(key);
    if (!group) {
      group = { category: finding.category, canonicalValue: canonical, originalValues: new Set(), totalOccurrences: 0, files: new Set() };
      groups.set(key, group);
    }
    group.originalValues.add(finding.value);
    group.totalOccurrences += finding.occurrences;
    for (const f of finding.files) group.files.add(f);
  }

  const tokens: ConsolidatedToken[] = [...groups.values()].map((g) => ({
    category: g.category,
    canonicalValue: g.canonicalValue,
    originalValues: [...g.originalValues].sort(),
    totalOccurrences: g.totalOccurrences,
    totalFileCount: g.files.size,
    files: [...g.files].sort(),
  }));

  tokens.sort(
    (a, b) => b.totalOccurrences - a.totalOccurrences || b.totalFileCount - a.totalFileCount || a.canonicalValue.localeCompare(b.canonicalValue)
  );

  return { tokens, inputFindingCount: findings.length, consolidatedCount: tokens.length };
}

export default consolidateTokens;
