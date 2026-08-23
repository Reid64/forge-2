/**
 * FORGE 2.0 — Design Pipeline: BrandIntelligence (`src/design-pipeline/brand-intelligence.ts`).
 *
 * `upgrades/DESIGN_INTELLIGENCE.md` component #03 ("Brand Intelligence Engine"), flagged MISSING
 * by `upgrades/SYSTEMS-5-9-GAP-MATRIX.md` row 03 and explicitly named as out-of-scope future work
 * in `app-profiler.ts`'s own header ("that refinement is ... component #03, still MISSING"). This
 * module is that refinement: where `app-profiler.ts`'s `brand.tone`/`brand.avoid` are looked up
 * from a curated `application_type` -> defaults table (a provisional heuristic, not observed
 * project data), {@link inferBrandProfile} derives a fuller {@link BrandProfile} — tone, avoid,
 * values, positioning, visual signals — from REAL governance/PRD text already on disk, via
 * deterministic keyword scoring (never an LLM call, never a fabricated per-project claim, Iron
 * Law 3).
 *
 * DOC READING: reuses `src/skills/ux-intelligence.ts`'s `readProjectPrdContent` — the same
 * `PRD.md`/`governance/PRD.md`/`BLUEPRINT.md`/`governance/BLUEPRINT.md` candidate-path
 * concatenation `detectIndustryVertical` already classifies verticals from — rather than
 * inventing a second file-scanning convention. `positioning` also reuses
 * `detectIndustryVertical`/`INDUSTRY_VERTICALS` directly so "what vertical is this" is answered
 * identically everywhere in the codebase.
 *
 * COMPOSES WITH `app-profiler.ts`: {@link BrandProfile.tone}/{@link BrandProfile.avoid} use the
 * exact same tag vocabulary as `app-profiler.ts`'s `BRAND_DEFAULTS_BY_APPLICATION_TYPE` and
 * `design-memory.ts`'s `CANONICAL_TAG_PHRASES` (`generic_saas`, `playful`, `ai_slop_icons`, ...) —
 * a caller can union `AppDesignProfile.brand.tone`/`.avoid` with this module's output and every
 * downstream consumer (Design Router's `brand_match`, Design Memory's preference ledger) keeps
 * working unchanged. `design-router.ts` wires this in directly — see its own header.
 *
 * House style, matching every sibling `src/design-pipeline/` module: {@link inferBrandProfile}
 * never throws — an empty/unreadable document corpus degrades to the vocabulary's documented
 * `low`-confidence fallback (neutral tone, general positioning) rather than an exception.
 */

import { detectIndustryVertical, readProjectPrdContent } from '../skills/ux-intelligence.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type BrandConfidence = 'low' | 'medium' | 'high';
export type DensityTendency = 'compact' | 'balanced' | 'spacious';
export type MotionTendency = 'subtle' | 'moderate' | 'expressive';

/** Visual-identity signals derived from the same tone words as {@link BrandProfile.tone}. */
export interface BrandVisualSignals {
  /** e.g. `['saturated', 'warm']` or `['monochrome', 'high-contrast']`. */
  colorTendencies: string[];
  /** e.g. `['geometric-sans']` or `['editorial-serif', 'condensed-sans']`. */
  typographyTendencies: string[];
  densityTendency: DensityTendency;
  motionTendency: MotionTendency;
}

/** The inferred brand profile — composes directly onto `AppDesignProfile.brand` (`app-profiler.ts`). */
export interface BrandProfile {
  projectName: string;
  /** Same tag vocabulary as `app-profiler.ts`'s `brand.tone` — safe to union with it. */
  tone: string[];
  /** Same tag vocabulary as `design-memory.ts`'s `CANONICAL_TAG_PHRASES` — safe to union with `brand.avoid`. */
  avoid: string[];
  /** Product/organizational values, e.g. `['trust', 'craftsmanship']`. */
  values: string[];
  /** One-line inferred positioning statement, e.g. "precise trustworthy fintech product". */
  positioning: string;
  visualSignals: BrandVisualSignals;
  /** How much real signal this profile is grounded in — `low` when the source text was thin/absent. */
  confidence: BrandConfidence;
  sourceSummary: string;
}

// ---------------------------------------------------------------------------
// Vocabulary (deterministic keyword scoring tables)
// ---------------------------------------------------------------------------

/** Tone word -> phrases that count as a hit for it in governance/PRD prose. */
const TONE_VOCAB: Readonly<Record<string, readonly string[]>> = {
  premium: ['premium', 'high-end', 'upscale'],
  luxurious: ['luxury', 'luxurious', 'exclusive', 'elite'],
  playful: ['playful', 'fun', 'delightful', 'whimsical'],
  trustworthy: ['trustworthy', 'trusted', 'reliable', 'secure'],
  technical: ['technical', 'developer-focused', 'engineering-led', 'api-first'],
  bold: ['bold', 'confident', 'striking'],
  minimal: ['minimal', 'minimalist', 'clean', 'uncluttered'],
  editorial: ['editorial', 'narrative', 'storytelling'],
  industrial: ['industrial', 'manufacturing', 'fabrication', 'factory'],
  warm: ['warm', 'friendly', 'approachable', 'welcoming'],
  precise: ['precise', 'exact', 'accurate', 'rigorous'],
  expressive: ['expressive', 'vibrant', 'dynamic'],
  restrained: ['restrained', 'understated', 'subtle'],
  modern: ['modern', 'contemporary', 'cutting-edge', 'cutting edge'],
  professional: ['professional', 'polished', 'buttoned-up'],
  clinical: ['clinical', 'sterile'],
} as const;

/** Value word -> phrases. Kept separate from tone (a "value" is what the org stands for, not how it looks). */
const VALUES_VOCAB: Readonly<Record<string, readonly string[]>> = {
  trust: ['trust', 'trustworthy', 'trusted', 'transparency', 'transparent'],
  innovation: ['innovation', 'innovative', 'pioneering', 'cutting-edge'],
  craftsmanship: ['craftsmanship', 'craft', 'quality', 'attention to detail'],
  reliability: ['reliability', 'reliable', 'dependable', 'uptime'],
  simplicity: ['simplicity', 'simple', 'easy to use', 'frictionless'],
  excellence: ['excellence', 'best-in-class', 'industry-leading'],
  security: ['security', 'secure', 'compliance', 'privacy'],
  inclusivity: ['inclusive', 'inclusivity', 'accessible', 'accessibility'],
  sustainability: ['sustainability', 'sustainable', 'eco-friendly'],
  speed: ['speed', 'fast', 'real-time', 'instant'],
  empowerment: ['empower', 'empowerment', 'self-serve', 'self-service'],
  collaboration: ['collaboration', 'collaborative', 'teamwork'],
} as const;

/**
 * Tone -> the `app-profiler.ts`/`design-memory.ts` avoid-vocabulary it implies. Every value here
 * is drawn from `app-profiler.ts`'s `BRAND_DEFAULTS_BY_APPLICATION_TYPE` and `design-memory.ts`'s
 * `CANONICAL_TAG_PHRASES` tag names, never a new tag invented ad hoc, so the union stays coherent
 * across all three modules.
 */
const TONE_TO_AVOID: Readonly<Record<string, readonly string[]>> = {
  premium: ['generic_saas', 'ai_slop_icons'],
  luxurious: ['generic_saas', 'cluttered'],
  playful: ['clinical', 'cluttered'],
  trustworthy: ['playful', 'cartoonish'],
  technical: ['decorative_charts', 'playful'],
  bold: ['generic_saas', 'excessive_rounded_boxes'],
  minimal: ['cluttered', 'excessive_gradients'],
  editorial: ['cramped_cards', 'decorative_charts'],
  industrial: ['playful', 'cartoonish'],
  warm: ['clinical', 'cramped_cards'],
  precise: ['excessive_gradients', 'decorative_charts'],
  expressive: ['generic_saas'],
  restrained: ['excessive_gradients', 'unnecessary_glassmorphism'],
  modern: ['generic_saas'],
  professional: ['playful', 'cartoonish'],
  clinical: ['playful', 'excessive_rounded_boxes'],
};
const DEFAULT_AVOID: readonly string[] = ['generic_saas', 'ai_slop_icons'];

/** Tone -> color-tendency tags for {@link BrandVisualSignals.colorTendencies}. */
const TONE_TO_COLOR: Readonly<Record<string, readonly string[]>> = {
  premium: ['high-contrast', 'dark'],
  luxurious: ['dark', 'muted-accent'],
  playful: ['saturated', 'warm'],
  trustworthy: ['cool', 'muted'],
  technical: ['cool', 'monochrome'],
  bold: ['saturated', 'high-contrast'],
  minimal: ['monochrome'],
  editorial: ['muted'],
  industrial: ['monochrome', 'cool'],
  warm: ['warm'],
  precise: ['cool', 'monochrome'],
  expressive: ['saturated'],
  restrained: ['muted'],
  modern: ['high-contrast'],
  professional: ['cool', 'muted'],
  clinical: ['monochrome', 'cool'],
};

/** Tone -> typography-tendency tags for {@link BrandVisualSignals.typographyTendencies}. */
const TONE_TO_TYPE: Readonly<Record<string, readonly string[]>> = {
  premium: ['editorial-serif'],
  luxurious: ['editorial-serif', 'tight-tracking'],
  playful: ['rounded-sans'],
  trustworthy: ['grotesque-sans'],
  technical: ['geometric-sans', 'mono-accent'],
  bold: ['condensed-sans'],
  minimal: ['grotesque-sans'],
  editorial: ['serif-display'],
  industrial: ['condensed-sans'],
  warm: ['rounded-sans'],
  precise: ['geometric-sans'],
  expressive: ['display-variable'],
  restrained: ['grotesque-sans'],
  modern: ['geometric-sans'],
  professional: ['grotesque-sans'],
  clinical: ['geometric-sans'],
};

const DENSITY_KEYWORDS: readonly string[] = ['data table', 'data grid', 'dense', 'analytics', 'spreadsheet-like'];
const SPACIOUS_KEYWORDS: readonly string[] = ['landing', 'marketing', 'hero', 'minimal', 'single column', 'whitespace'];
const MOTION_KEYWORDS_LOCAL: readonly string[] = [
  'animation',
  'animate',
  'transition',
  'parallax',
  'motion design',
  'micro-interaction',
  'scroll-triggered',
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function countHits(corpus: string, keyword: string): number {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');
  const matches = corpus.match(pattern);
  return matches ? matches.length : 0;
}

function totalHits(corpus: string, keywords: readonly string[]): number {
  return keywords.reduce((sum, kw) => sum + countHits(corpus, kw), 0);
}

/** Score a keyword-vocab table against `corpus`, returning tags with a non-zero score, desc. */
function scoreVocab(corpus: string, vocab: Readonly<Record<string, readonly string[]>>): Array<[string, number]> {
  const scored: Array<[string, number]> = [];
  for (const [key, keywords] of Object.entries(vocab)) {
    const score = keywords.reduce((sum, kw) => sum + countHits(corpus, kw), 0);
    if (score > 0) scored.push([key, score]);
  }
  return scored.sort((a, b) => b[1] - a[1]);
}

function classifyDensity(corpus: string): DensityTendency {
  const dense = totalHits(corpus, DENSITY_KEYWORDS);
  const spacious = totalHits(corpus, SPACIOUS_KEYWORDS);
  if (dense > spacious && dense > 0) return 'compact';
  if (spacious > dense && spacious > 0) return 'spacious';
  return 'balanced';
}

function classifyMotion(corpus: string): MotionTendency {
  const hits = totalHits(corpus, MOTION_KEYWORDS_LOCAL);
  if (hits >= 3) return 'expressive';
  if (hits >= 1) return 'moderate';
  return 'subtle';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive a {@link BrandProfile} for `projectName`. `documentText` defaults to
 * {@link readProjectPrdContent}(`projectPath`) when omitted — pass it explicitly to test this
 * function purely (no disk I/O) or to feed it text a caller already loaded. Never throws; an
 * empty/whitespace-only corpus degrades to a `low`-confidence, tone-neutral profile rather than a
 * fabricated guess (Iron Law 3), matching `app-profiler.ts`'s `profileApp` posture exactly.
 */
export function inferBrandProfile(projectName: string, projectPath: string, documentText?: string): BrandProfile {
  const text = documentText ?? safeReadPrdContent(projectPath);
  const corpus = text.toLowerCase();

  const toneScores = scoreVocab(corpus, TONE_VOCAB);
  const tone = toneScores.slice(0, 6).map(([key]) => key);

  const avoid = [...new Set(tone.flatMap((t) => TONE_TO_AVOID[t] ?? []))];
  const finalAvoid = avoid.length > 0 ? avoid : [...DEFAULT_AVOID];

  const valueScores = scoreVocab(corpus, VALUES_VOCAB);
  const values = valueScores.slice(0, 5).map(([key]) => key);

  const vertical = detectIndustryVertical(text);
  const positioning =
    tone.length > 0
      ? `${tone.slice(0, 2).join(' ')} ${vertical} product`
      : `general-purpose ${vertical} product (no distinctive brand tone signal found yet)`;

  const visualSignals: BrandVisualSignals = {
    colorTendencies: [...new Set(tone.flatMap((t) => TONE_TO_COLOR[t] ?? []))],
    typographyTendencies: [...new Set(tone.flatMap((t) => TONE_TO_TYPE[t] ?? []))],
    densityTendency: classifyDensity(corpus),
    motionTendency: classifyMotion(corpus),
  };

  const totalSignal = toneScores.reduce((s, [, n]) => s + n, 0) + valueScores.reduce((s, [, n]) => s + n, 0);
  const confidence: BrandConfidence = totalSignal === 0 ? 'low' : totalSignal < 5 ? 'medium' : 'high';

  const sourceSummary =
    text.trim() === ''
      ? 'no PRD/governance text available on disk — profile derived from vocabulary fallbacks only'
      : `derived from ${text.length} chars of PRD/governance text (${toneScores.length} tone signal(s), ${valueScores.length} value signal(s))`;

  return {
    projectName,
    tone,
    avoid: finalAvoid,
    values,
    positioning,
    visualSignals,
    confidence,
    sourceSummary,
  };
}

function safeReadPrdContent(projectPath: string): string {
  try {
    return readProjectPrdContent(projectPath);
  } catch {
    return '';
  }
}

export default inferBrandProfile;
