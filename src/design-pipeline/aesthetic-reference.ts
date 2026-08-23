/**
 * FORGE 2.0 — Design Pipeline: AestheticReference (`src/design-pipeline/aesthetic-reference.ts`).
 *
 * A self-contained catalog of named aesthetic styles/families — {@link AESTHETIC_FAMILIES} —
 * structured with enough detail (color tendencies, typography tendencies, spacing/density,
 * defining traits, brand-tag affinities, and clashes) to be directly useful to
 * `design-router.ts`'s routing decisions as a CANDIDATE STYLE SELECTION step: given a project's
 * brand tone (`app-profiler.ts`'s `AppDesignProfile.brand.tone`, optionally unioned with
 * `brand-intelligence.ts`'s richer `BrandProfile.tone`), {@link rankAestheticFamilies} scores
 * every family and returns the best-fitting ones for a given interface type.
 *
 * NO EXTERNAL TOOL DEPENDENCY, DELIBERATELY: every field below is pure, static, local TypeScript
 * data — no API call, no design-tool integration (no `taste_skill`/`impeccable`/`awesome_design`
 * dependency), no network. `design-router.ts` already owns the actual tool-routing decision (which
 * EXTERNAL design tool/skill to hand a prompt to); this module answers the logically prior, tool-
 * agnostic question — "what aesthetic direction fits this brand?" — the same way a human designer
 * would name a reference style before picking software. This repo's `ui-ux-pro-max` Claude Code
 * skill (`.claude/skills/ui-ux-pro-max` when installed) has its own much larger style/palette
 * catalog for interactive generation; this module does not read or depend on it (no filesystem
 * reach into `.claude/skills`, no coupling to whether that skill is installed) — it is a small,
 * FORGE-owned reference vocabulary sized for router-time scoring, not a replacement for that
 * skill's generation-time catalog.
 *
 * Every family's `brandTagAffinities`/`avoidWhen` reuse the exact same tag vocabulary as
 * `app-profiler.ts`'s `BRAND_DEFAULTS_BY_APPLICATION_TYPE`, `brand-intelligence.ts`'s `tone`, and
 * `design-memory.ts`'s `CANONICAL_TAG_PHRASES` — so a single brand-tone tag list scores coherently
 * against all three subsystems.
 *
 * House style, matching every sibling `src/design-pipeline/` module: every export here is pure
 * and total — no I/O, never throws, an unmatched/empty input degrades to an empty/zero result,
 * never a fabricated recommendation.
 */

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type SpacingDensity = 'compact' | 'balanced' | 'spacious';
export type MotionTendency = 'subtle' | 'moderate' | 'expressive';

export interface AestheticFamily {
  /** Stable slug id, e.g. `'minimalist'`. */
  id: string;
  name: string;
  description: string;
  /** e.g. `['monochrome', 'high-contrast']`. */
  colorTendencies: readonly string[];
  /** e.g. `['grotesque-sans', 'tight-tracking']`. */
  typographyTendencies: readonly string[];
  spacingDensity: SpacingDensity;
  motionTendency: MotionTendency;
  /** Hallmark traits a human would recognize this family by. */
  definingTraits: readonly string[];
  /** Brand-tone tags (see file header) this family fits well — used for scoring. */
  brandTagAffinities: readonly string[];
  /** Brand-tone tags this family actively clashes with — scored as a penalty. */
  avoidWhen: readonly string[];
  /** `app-profiler.ts`'s `interfaceTypes` vocabulary this family suits best. */
  bestForInterfaceTypes: readonly string[];
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export const AESTHETIC_FAMILIES: readonly AestheticFamily[] = [
  {
    id: 'minimalist',
    name: 'Minimalist',
    description:
      'Reduction-first: only the elements that carry meaning survive. Generous negative space does ' +
      'the organizing work that borders and boxes would otherwise do.',
    colorTendencies: ['monochrome', 'muted', 'single-accent'],
    typographyTendencies: ['grotesque-sans', 'generous-tracking'],
    spacingDensity: 'spacious',
    motionTendency: 'subtle',
    definingTraits: ['generous whitespace', 'single accent color', 'typography-led hierarchy', 'no decorative chrome'],
    brandTagAffinities: ['minimal', 'restrained', 'clean', 'precise'],
    avoidWhen: ['playful', 'expressive', 'cluttered'],
    bestForInterfaceTypes: ['marketing_site', 'portfolio', 'settings'],
  },
  {
    id: 'brutalist',
    name: 'Brutalist',
    description:
      'Raw, unpolished, deliberately anti-corporate: system fonts, visible grid seams, high-contrast ' +
      'blocks of color, and an unapologetic disregard for "friendly" UI conventions.',
    colorTendencies: ['high-contrast', 'saturated', 'stark'],
    typographyTendencies: ['mono-heavy', 'oversized-headings'],
    spacingDensity: 'compact',
    motionTendency: 'subtle',
    definingTraits: ['visible grid/borders', 'unrefined system-font feel', 'stark color blocking', 'anti-polish'],
    brandTagAffinities: ['bold', 'expressive', 'technical'],
    avoidWhen: ['premium', 'luxurious', 'trustworthy', 'clinical'],
    bestForInterfaceTypes: ['portfolio', 'marketing_site'],
  },
  {
    id: 'glassmorphism',
    name: 'Glassmorphism',
    description:
      'Frosted, translucent panels layered over soft gradients — depth communicated through blur ' +
      'and layering rather than hard shadows or borders.',
    colorTendencies: ['saturated', 'gradient', 'pastel-accent'],
    typographyTendencies: ['geometric-sans'],
    spacingDensity: 'balanced',
    motionTendency: 'moderate',
    definingTraits: ['frosted-glass panels', 'background blur', 'soft layered gradients', 'thin light borders'],
    brandTagAffinities: ['modern', 'expressive'],
    avoidWhen: ['restrained', 'clinical', 'industrial', 'minimal'],
    bestForInterfaceTypes: ['marketing_site', 'customer_dashboard'],
  },
  {
    id: 'corporate-clean',
    name: 'Corporate Clean',
    description:
      'The safe, broadly-legible default: a disciplined neutral palette, one workhorse sans, and ' +
      'conventional component patterns a first-time user never has to learn.',
    colorTendencies: ['cool', 'muted', 'single-accent'],
    typographyTendencies: ['grotesque-sans'],
    spacingDensity: 'balanced',
    motionTendency: 'subtle',
    definingTraits: ['neutral gray-blue palette', 'conventional layout patterns', 'single workhorse typeface', 'predictable component states'],
    brandTagAffinities: ['professional', 'trustworthy', 'restrained', 'modern'],
    avoidWhen: ['playful', 'expressive', 'industrial'],
    bestForInterfaceTypes: ['admin_dashboard', 'customer_dashboard', 'settings', 'auth_flow'],
  },
  {
    id: 'neumorphism',
    name: 'Neumorphism',
    description:
      'Soft-extruded surfaces that appear molded from the same material as the background — subtle ' +
      'dual light/shadow instead of flat fills or hard borders.',
    colorTendencies: ['monochrome', 'low-contrast'],
    typographyTendencies: ['rounded-sans'],
    spacingDensity: 'balanced',
    motionTendency: 'subtle',
    definingTraits: ['soft dual-shadow extrusion', 'monochrome base palette', 'low-contrast surfaces', 'tactile/physical feel'],
    brandTagAffinities: ['modern', 'warm'],
    avoidWhen: ['bold', 'technical', 'precise'],
    bestForInterfaceTypes: ['customer_dashboard', 'settings'],
  },
  {
    id: 'maximalist-editorial',
    name: 'Maximalist Editorial',
    description:
      'Magazine-inspired density and confidence: layered type scales, asymmetric grids, and color ' +
      'used expressively rather than functionally.',
    colorTendencies: ['saturated', 'high-contrast', 'warm'],
    typographyTendencies: ['serif-display', 'mixed-weight'],
    spacingDensity: 'spacious',
    motionTendency: 'expressive',
    definingTraits: ['asymmetric editorial grid', 'large display serif headlines', 'confident color use', 'layered type scales'],
    brandTagAffinities: ['editorial', 'expressive', 'bold', 'luxurious'],
    avoidWhen: ['minimal', 'restrained', 'clinical'],
    bestForInterfaceTypes: ['marketing_site', 'portfolio'],
  },
  {
    id: 'cyberpunk-neon',
    name: 'Cyberpunk Neon',
    description:
      'Dark-first surfaces punctuated by saturated neon accents — a technical, near-future register ' +
      'built for products that want to feel powerful rather than approachable.',
    colorTendencies: ['dark', 'saturated', 'high-contrast'],
    typographyTendencies: ['mono-accent', 'condensed-sans'],
    spacingDensity: 'compact',
    motionTendency: 'expressive',
    definingTraits: ['dark base surfaces', 'saturated neon accent colors', 'monospace/technical accents', 'glow/scanline motifs'],
    brandTagAffinities: ['technical', 'bold', 'expressive'],
    avoidWhen: ['warm', 'trustworthy', 'professional', 'clinical'],
    bestForInterfaceTypes: ['3d_visualizer', 'api_console'],
  },
  {
    id: 'organic-soft',
    name: 'Organic Soft',
    description:
      'Rounded, human, hand-crafted-feeling: blob shapes, warm off-whites, and friendly rounded ' +
      'type that reads as approachable rather than institutional.',
    colorTendencies: ['warm', 'pastel-accent', 'muted'],
    typographyTendencies: ['rounded-sans'],
    spacingDensity: 'spacious',
    motionTendency: 'moderate',
    definingTraits: ['organic/blob shapes', 'warm off-white backgrounds', 'rounded friendly type', 'hand-crafted illustration accents'],
    brandTagAffinities: ['warm', 'playful', 'expressive'],
    avoidWhen: ['clinical', 'technical', 'industrial', 'precise'],
    bestForInterfaceTypes: ['marketing_site', 'customer_dashboard'],
  },
  {
    id: 'retro-futurism',
    name: 'Retro-Futurism',
    description:
      'A past era\'s idea of "the future": chrome gradients, geometric display type, and a warm-tech ' +
      'palette that reads as nostalgic and confident at once.',
    colorTendencies: ['warm', 'gradient', 'saturated'],
    typographyTendencies: ['display-variable', 'condensed-sans'],
    spacingDensity: 'balanced',
    motionTendency: 'expressive',
    definingTraits: ['chrome/gradient accents', 'geometric display type', 'warm-tech palette', 'nostalgic sci-fi motifs'],
    brandTagAffinities: ['bold', 'expressive', 'modern'],
    avoidWhen: ['clinical', 'restrained', 'minimal'],
    bestForInterfaceTypes: ['marketing_site', 'portfolio'],
  },
  {
    id: 'luxury-editorial',
    name: 'Luxury Editorial',
    description:
      'Restraint AS the signal of quality: near-monochrome palettes, a serif of real pedigree, and ' +
      'spacing so generous it reads as expensive.',
    colorTendencies: ['dark', 'monochrome', 'muted-accent'],
    typographyTendencies: ['editorial-serif', 'tight-tracking'],
    spacingDensity: 'spacious',
    motionTendency: 'subtle',
    definingTraits: ['near-monochrome palette', 'pedigreed serif typography', 'extreme whitespace', 'restrained single accent'],
    brandTagAffinities: ['premium', 'luxurious', 'restrained', 'editorial'],
    avoidWhen: ['playful', 'cartoonish', 'saturated'],
    bestForInterfaceTypes: ['marketing_site', 'portfolio'],
  },
  {
    id: 'playful-rounded',
    name: 'Playful Rounded',
    description:
      'Bright, bouncy, and consumer-friendly: saturated primaries, fully-rounded corners everywhere, ' +
      'and motion that celebrates every completed action.',
    colorTendencies: ['saturated', 'warm', 'high-contrast'],
    typographyTendencies: ['rounded-sans'],
    spacingDensity: 'balanced',
    motionTendency: 'expressive',
    definingTraits: ['fully-rounded corners', 'saturated primary palette', 'celebratory micro-interactions', 'friendly iconography'],
    brandTagAffinities: ['playful', 'warm', 'expressive'],
    avoidWhen: ['clinical', 'trustworthy', 'premium', 'restrained'],
    bestForInterfaceTypes: ['marketing_site', 'customer_dashboard', 'mobile_dashboard'],
  },
  {
    id: 'dark-technical',
    name: 'Dark Technical',
    description:
      'The developer-console register: near-black surfaces, monospace accents, and a restrained ' +
      'single-hue accent reserved strictly for interactive/status states.',
    colorTendencies: ['dark', 'monochrome', 'single-accent'],
    typographyTendencies: ['mono-heavy', 'geometric-sans'],
    spacingDensity: 'compact',
    motionTendency: 'subtle',
    definingTraits: ['near-black base surfaces', 'monospace-forward typography', 'status-only accent color', 'dense information layout'],
    brandTagAffinities: ['technical', 'precise', 'restrained'],
    avoidWhen: ['playful', 'warm', 'luxurious'],
    bestForInterfaceTypes: ['api_console', 'admin_dashboard', 'analytics_console', 'production_dashboard'],
  },
  {
    id: 'swiss-grid',
    name: 'Swiss Grid',
    description:
      'International Typographic Style: a rigorous underlying grid, a single grotesque typeface at ' +
      'disciplined weights, and color used only functionally.',
    colorTendencies: ['high-contrast', 'single-accent', 'muted'],
    typographyTendencies: ['grotesque-sans', 'tight-tracking'],
    spacingDensity: 'balanced',
    motionTendency: 'subtle',
    definingTraits: ['rigorous grid system', 'single grotesque typeface', 'functional-only color', 'strong alignment discipline'],
    brandTagAffinities: ['precise', 'restrained', 'professional', 'modern'],
    avoidWhen: ['playful', 'cartoonish', 'expressive'],
    bestForInterfaceTypes: ['admin_dashboard', 'analytics_console', 'architect_workspace'],
  },
  {
    id: 'industrial-utilitarian',
    name: 'Industrial Utilitarian',
    description:
      'Built for operators, not marketers: dense data-forward layouts, hazard-stripe accent color, ' +
      'and zero decorative elements that don\'t carry information.',
    colorTendencies: ['monochrome', 'high-contrast', 'warm-accent'],
    typographyTendencies: ['condensed-sans', 'mono-accent'],
    spacingDensity: 'compact',
    motionTendency: 'subtle',
    definingTraits: ['hazard-accent color reserved for alerts', 'dense data-forward layout', 'condensed utilitarian type', 'no decorative elements'],
    brandTagAffinities: ['industrial', 'precise', 'technical'],
    avoidWhen: ['luxurious', 'playful', 'expressive'],
    bestForInterfaceTypes: ['production_dashboard', 'admin_dashboard', 'product_configurator'],
  },
] as const;

// ---------------------------------------------------------------------------
// Public API — lookup + scoring
// ---------------------------------------------------------------------------

/** `AESTHETIC_FAMILIES` id -> family, for O(1) lookup. */
const FAMILY_BY_ID: ReadonlyMap<string, AestheticFamily> = new Map(AESTHETIC_FAMILIES.map((f) => [f.id, f]));

/** Every valid {@link AestheticFamily.id}. */
export const AESTHETIC_FAMILY_IDS: readonly string[] = AESTHETIC_FAMILIES.map((f) => f.id);

/** Look up one family by id. `undefined` for an unknown id — never throws. */
export function getAestheticFamily(id: string): AestheticFamily | undefined {
  return FAMILY_BY_ID.get(id);
}

/**
 * Score `family` against `brandTone` (0-1): the fraction of `family.brandTagAffinities` present in
 * `brandTone`, minus a penalty of the same weight for every `family.avoidWhen` tag present in
 * `brandTone`. A family with no affinities defined scores a neutral 0.5 (never a fabricated lean).
 * `interfaceType`, when supplied and present in `family.bestForInterfaceTypes`, adds a fixed 0.15
 * bonus (interface fit is a real, documented signal, not folded into the brand-tag math above).
 */
export function scoreAestheticFamilyMatch(
  family: AestheticFamily,
  brandTone: readonly string[],
  interfaceType?: string
): number {
  if (family.brandTagAffinities.length === 0) return 0.5;
  const toneSet = new Set(brandTone.map((t) => t.toLowerCase()));
  const affinityHits = family.brandTagAffinities.filter((t) => toneSet.has(t.toLowerCase())).length;
  const avoidHits = family.avoidWhen.filter((t) => toneSet.has(t.toLowerCase())).length;

  const base = affinityHits / family.brandTagAffinities.length;
  const penalty = family.avoidWhen.length > 0 ? avoidHits / family.avoidWhen.length : 0;
  const interfaceBonus = interfaceType && family.bestForInterfaceTypes.includes(interfaceType) ? 0.15 : 0;

  return Math.max(0, Math.min(1, base - penalty * 0.5 + interfaceBonus));
}

/** One scored candidate from {@link rankAestheticFamilies}. */
export interface AestheticFamilyMatch {
  family: AestheticFamily;
  score: number;
}

/**
 * Rank every {@link AESTHETIC_FAMILIES} entry against `brandTone` (+ optional `interfaceType`),
 * highest score first, returning the top `limit` (default 3). `brandTone` empty returns every
 * family at its neutral 0.5 (or 0.65 with the interface bonus), in catalog order — never an empty
 * result for an empty brand tone (that would silently claim "no aesthetic fits," which is false).
 */
export function rankAestheticFamilies(
  brandTone: readonly string[],
  interfaceType?: string,
  limit = 3
): AestheticFamilyMatch[] {
  const scored = AESTHETIC_FAMILIES.map((family) => ({
    family,
    score: scoreAestheticFamilyMatch(family, brandTone, interfaceType),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, limit));
}

export default AESTHETIC_FAMILIES;
