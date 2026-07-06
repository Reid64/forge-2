/**
 * FORGE 2.0 — Cross-project design token inheritance (Session 2 — Design Intelligence).
 *
 * Lets a new project start from a proven brand's structured design tokens instead of
 * generating from scratch. Read-only and non-persisting: {@link deriveBrandFromBaseline} reads
 * the baseline project's `brand_identities` row (written by Phase 1B — see
 * `src/phases/phase1b-architect.ts` step 2.5 + the post-frontend token merge) and returns a
 * derived token object; the caller (the `forge brand-inherit` CLI command, or a future phase)
 * decides whether and how to persist it via `createBrand`/`updateBrand`.
 */

import { getBrandByProject } from '../memory/brands.js';
import type { JsonObject } from '../types/index.js';

/**
 * Design-token buckets. Mirrors `src/phases/phase1b-architect.ts`'s `DesignTokenSet` (which
 * mirrors `brand_identities.design_tokens.tokens`) — kept as a local structural type so
 * `src/tools/` does not depend on `src/phases/`.
 */
export interface DesignTokenSet {
  colors: Record<string, string>;
  typography: Record<string, string>;
  spacing: Record<string, string>;
  radii: Record<string, string>;
  shadows: Record<string, string>;
}

const EMPTY_TOKEN_SET: DesignTokenSet = {
  colors: {},
  typography: {},
  spacing: {},
  radii: {},
  shadows: {},
};

/** Coerce to a plain object record, or `{}` for anything else (never throws). */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Coerce to a `Record<string, string>` (string-valued entries only). */
function asStringRecord(value: unknown): Record<string, string> {
  const obj = asRecord(value);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** A trimmed string field of a stored `design_tokens` object, or `''`. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Extract the structured `DesignTokenSet` a brand row carries — merged in by Phase 1B after
 * FrontendArchitecture generation, under `design_tokens.tokens` (see `phase1b-architect.ts`).
 * Returns an empty token set (never `null`/throws) when none was ever recorded.
 */
export function extractStructuredTokens(designTokens: JsonObject | null | undefined): DesignTokenSet {
  const stored = asRecord(designTokens);
  const structured = asRecord(stored['tokens']);
  return {
    colors: asStringRecord(structured['colors']),
    typography: asStringRecord(structured['typography']),
    spacing: asStringRecord(structured['spacing']),
    radii: asStringRecord(structured['radii']),
    shadows: asStringRecord(structured['shadows']),
  };
}

/** Deep-merge `overrides` over `base`, bucket by bucket — overrides win key-by-key within each bucket. */
function mergeTokenSets(base: DesignTokenSet, overrides: Partial<DesignTokenSet> | undefined): DesignTokenSet {
  if (!overrides) return base;
  return {
    colors: { ...base.colors, ...(overrides.colors ?? {}) },
    typography: { ...base.typography, ...(overrides.typography ?? {}) },
    spacing: { ...base.spacing, ...(overrides.spacing ?? {}) },
    radii: { ...base.radii, ...(overrides.radii ?? {}) },
    shadows: { ...base.shadows, ...(overrides.shadows ?? {}) },
  };
}

/** The result of {@link deriveBrandFromBaseline}. */
export interface DerivedBrand {
  baselineProjectName: string;
  newProjectName: string;
  /** False when the baseline project has no `brand_identities` row (or Build Memory is unreachable). */
  baselineFound: boolean;
  /** The baseline's stored UI/UX Pro Max markdown, carried forward for context (`''` if none). */
  baselineMarkdown: string;
  /** The baseline's stored product-type search query (`''` if none). */
  baselineProductType: string;
  /** The merged structured token set: baseline tokens with `overrides` applied on top. */
  tokens: DesignTokenSet;
}

/**
 * Derive a new project's design tokens from a baseline project's persisted brand.
 *
 * Reads the baseline via `getBrandByProject`, deep-merges `overrides` over its structured
 * tokens, and returns the derived object. Does NOT auto-persist — the caller decides (the
 * `forge brand-inherit` CLI command persists via `createBrand`/`updateBrand`).
 *
 * Guarded: a missing baseline (or an unreachable Build Memory) degrades to an empty token set
 * with `baselineFound: false` rather than throwing — `overrides` are still applied so the
 * caller gets a usable result either way.
 */
export async function deriveBrandFromBaseline(
  baselineProjectName: string,
  newProjectName: string,
  overrides?: Partial<DesignTokenSet>
): Promise<DerivedBrand> {
  const baseline = await getBrandByProject(baselineProjectName);
  const stored = baseline ? asRecord(baseline.design_tokens) : {};
  const baseTokens = baseline ? extractStructuredTokens(baseline.design_tokens) : EMPTY_TOKEN_SET;

  return {
    baselineProjectName,
    newProjectName,
    baselineFound: baseline !== null,
    baselineMarkdown: asString(stored['markdown']),
    baselineProductType: asString(stored['productType']),
    tokens: mergeTokenSets(baseTokens, overrides),
  };
}
