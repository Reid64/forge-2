/**
 * FORGE 2.0 — UX Intelligence (agentic design-system auto-selection from PRD industry vertical).
 *
 * A build's design system should not start from a blank slate, and it should not wait until
 * Phase 1B's full UI/UX Pro Max generation (`src/tools/design-system-generator.ts`) to have ANY
 * opinion about color, type, density, or motion — Phase 0 runs first, before PRD/Architecture
 * artifacts exist for a greenfield build, and a partial-build (RETROFIT) target may already have
 * a `PRD.md` on disk that nothing has ever read for design intent.
 *
 * This module gives Phase 0 a lightweight, deterministic first opinion: read whatever PRD/
 * blueprint text is already on disk, classify the product's industry vertical from a fixed
 * keyword table, and select a starter design system (palette, type pair, density, motion) tuned
 * to that vertical's conventions — fintech reads differently from a creative agency site, and a
 * legal SaaS reads differently from a marketplace. The result is written to
 * `<project>/governance/DESIGN_SYSTEM.md` as an early BASELINE, not a final answer: Phase 1B's
 * UI/UX Pro Max generation (when it runs) writes the same file again with a fuller, PRD-informed
 * system and is expected to supersede this baseline. A build that never reaches Phase 1B (a
 * `--use-existing-queue` re-run, or a Phase-0-only dry run) still benefits from having SOME
 * industry-appropriate design intent on disk rather than none.
 *
 * Deliberately simple and dependency-free: no LLM call, no external skill invocation (that is
 * what `generateDesignSystem`/UI/UX Pro Max is for) — just a keyword classifier and a fixed,
 * hand-curated lookup table of eight starter design systems. Every export here follows the
 * house "guarded — never throws" convention: a missing/unreadable PRD degrades to the `saas`
 * default vertical, and a failed write degrades to a logged warning, never a build blocker.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toAsciiGovernanceText } from '../tools/governance-text.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The eight-color functional palette every generated design system carries. */
export interface ColorPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  foreground: string;
  error: string;
  success: string;
  warning: string;
}

/** The three type roles a design system's font stack fills. */
export interface TypographyPair {
  heading: string;
  body: string;
  mono: string;
}

/** How tightly UI elements are packed. Matches `src/ui-engine/design-token-manager.ts`'s spacing vocabulary. */
export type LayoutDensity = 'compact' | 'balanced' | 'spacious';

/** How much motion/animation a UI is expected to use. */
export type MotionProfile = 'subtle' | 'moderate' | 'expressive';

/** The full output of {@link selectDesignSystem}: one vertical's starter design system + why. */
export interface DesignDecision {
  industryVertical: string;
  colorPalette: ColorPalette;
  typographyPair: TypographyPair;
  layoutDensity: LayoutDensity;
  motionProfile: MotionProfile;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Vertical detection
// ---------------------------------------------------------------------------

/**
 * Keyword table used by {@link detectIndustryVertical}. Order matters: it is also the
 * tie-break priority when a PRD's text scores equally for two verticals (earlier wins),
 * chosen to put the more specific/regulated verticals (fintech, healthcare, legal) ahead of
 * the broader, more easily-confused ones (enterprise, commerce).
 */
const VERTICAL_KEYWORDS: ReadonlyArray<readonly [vertical: string, keywords: readonly string[]]> = [
  ['fintech', ['fintech', 'finance', 'financial', 'banking', 'investment', 'investing']],
  ['healthcare', ['health', 'healthcare', 'medical', 'patient', 'clinical', 'clinician']],
  ['legal', ['legal', 'law', 'lawyer', 'compliance', 'regulatory', 'regulation']],
  ['creative', ['creative', 'design', 'agency', 'studio', 'portfolio']],
  ['enterprise', ['enterprise', 'b2b', 'workflow', 'productivity', 'internal tool']],
  ['commerce', ['marketplace', 'ecommerce', 'e-commerce', 'shop', 'shopping', 'storefront', 'checkout']],
  ['education', ['education', 'educational', 'learning', 'course', 'curriculum', 'student']],
];

/** Every vertical {@link selectDesignSystem} has a curated design system for, `saas` (the default) included. */
export const INDUSTRY_VERTICALS: readonly string[] = [
  ...VERTICAL_KEYWORDS.map(([vertical]) => vertical),
  'saas',
];

/** Escape a string for safe embedding inside a `RegExp` (word-boundary keyword matching). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Classify a PRD's (or blueprint's) free text into one of {@link INDUSTRY_VERTICALS} by
 * counting keyword hits per vertical (word-boundary, case-insensitive) and returning the
 * highest-scoring vertical. Ties resolve to whichever vertical appears earlier in
 * {@link VERTICAL_KEYWORDS} (the more specific/regulated verticals first). Empty/blank input,
 * or content with zero keyword hits across every vertical, returns `'saas'` — the safe,
 * general-purpose default every FORGE build already assumes when nothing more specific is
 * known.
 */
export function detectIndustryVertical(prdContent: string): string {
  if (typeof prdContent !== 'string' || prdContent.trim() === '') return 'saas';

  const haystack = prdContent.toLowerCase();
  let bestVertical: string | null = null;
  let bestScore = 0;

  for (const [vertical, keywords] of VERTICAL_KEYWORDS) {
    let score = 0;
    for (const keyword of keywords) {
      const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'g');
      const matches = haystack.match(pattern);
      if (matches) score += matches.length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestVertical = vertical;
    }
  }

  return bestVertical ?? 'saas';
}

// ---------------------------------------------------------------------------
// Design system selection
// ---------------------------------------------------------------------------

/**
 * The general-purpose SaaS default — declared as its own typed constant (rather than only a key
 * inside {@link DESIGN_SYSTEMS}) so {@link selectDesignSystem}'s fallback path resolves to a
 * `DesignDecision`, not a `DesignDecision | undefined`: `noUncheckedIndexedAccess` (tsconfig)
 * treats every access into a `Record<string, X>` — including `DESIGN_SYSTEMS.saas` by dot
 * notation — as going through its index signature, and therefore always possibly-`undefined`.
 */
const SAAS_DESIGN_SYSTEM: DesignDecision = {
  industryVertical: 'saas',
  colorPalette: {
    primary: '#6366f1',
    secondary: '#8b5cf6',
    accent: '#06b6d4',
    background: '#fafafa',
    foreground: '#18181b',
    error: '#dc2626',
    success: '#16a34a',
    warning: '#d97706',
  },
  typographyPair: { heading: 'Inter', body: 'Inter', mono: 'JetBrains Mono' },
  layoutDensity: 'balanced',
  motionProfile: 'subtle',
  reasoning:
    'No industry-specific keyword scored above zero (or no PRD text was available yet), so this ' +
    'is the general-purpose SaaS default: an indigo primary that reads as modern-product without ' +
    'committing to any one vertical\'s convention, Inter throughout for maximum legibility across ' +
    'unknown content types, balanced density and subtle motion as a safe, widely-applicable ' +
    'starting point that Phase 1B\'s fuller PRD-informed generation is expected to refine.',
};

/**
 * Every curated starter design system, keyed by industry vertical. Hand-authored — not derived
 * from a formula — because industry-appropriate color/type conventions are a domain judgment
 * call, not something a palette-generation algorithm reliably gets right on its own. Every
 * palette carries the full functional eight-color set (not just `primary`) so
 * {@link writeDesignSystemDoc} never has to invent secondary/accent/semantic colors on the fly.
 */
const DESIGN_SYSTEMS: Readonly<Record<string, DesignDecision>> = {
  fintech: {
    industryVertical: 'fintech',
    colorPalette: {
      primary: '#1a56db',
      secondary: '#1e429f',
      accent: '#0694a2',
      background: '#f8fafc',
      foreground: '#0f172a',
      error: '#e02424',
      success: '#0e9f6e',
      warning: '#c27803',
    },
    typographyPair: { heading: 'Inter', body: 'Inter', mono: 'JetBrains Mono' },
    layoutDensity: 'compact',
    motionProfile: 'subtle',
    reasoning:
      'Fintech/finance/banking/investment products are trust-first: a compact, information-dense ' +
      'layout (tables, balances, transaction lists) reads as precise rather than sparse, a single ' +
      'disciplined sans (Inter) throughout avoids any impression of decoration, and subtle motion ' +
      'keeps state changes (balance updates, confirmations) legible without feeling playful.',
  },
  healthcare: {
    industryVertical: 'healthcare',
    colorPalette: {
      primary: '#057a55',
      secondary: '#036672',
      accent: '#0694a2',
      background: '#f8faf9',
      foreground: '#0b1f19',
      error: '#d93025',
      success: '#057a55',
      warning: '#b45309',
    },
    typographyPair: { heading: 'Public Sans', body: 'Source Sans 3', mono: 'JetBrains Mono' },
    layoutDensity: 'balanced',
    motionProfile: 'subtle',
    reasoning:
      'Health/medical/patient/clinical products prioritize legibility above all else — Public Sans ' +
      'and Source Sans 3 are both designed for high readability at small sizes and by non-expert ' +
      'readers. A calm green primary reads as clinical-but-human rather than clinical-cold, balanced ' +
      'density avoids both an overwhelming chart and an under-informative one, and subtle motion ' +
      'never distracts from a page that may be read under stress.',
  },
  legal: {
    industryVertical: 'legal',
    colorPalette: {
      primary: '#1e3a5f',
      secondary: '#374151',
      accent: '#9f7928',
      background: '#f9fafb',
      foreground: '#111827',
      error: '#991b1b',
      success: '#065f46',
      warning: '#92400e',
    },
    typographyPair: { heading: 'Georgia', body: 'Inter', mono: 'JetBrains Mono' },
    layoutDensity: 'balanced',
    motionProfile: 'subtle',
    reasoning:
      'Legal/law/compliance/regulatory products favor gravity and precedent over novelty: a serif ' +
      '(Georgia) heading pairs with a plain sans (Inter) body — a document-adjacent, editorial ' +
      'pairing rather than a "product" one — a deep navy primary and a muted gold accent read as ' +
      'formal, and the brief called for near-absent ("minimal") motion, which this module maps to ' +
      'the closest supported profile, `subtle`: motion reserved strictly for essential state-change ' +
      'feedback (a save confirmation, a validation error), never decorative.',
  },
  creative: {
    industryVertical: 'creative',
    colorPalette: {
      primary: '#7e3af2',
      secondary: '#e74694',
      accent: '#ff5a1f',
      background: '#fafafa',
      foreground: '#18181b',
      error: '#e02424',
      success: '#0e9f6e',
      warning: '#ff8a00',
    },
    typographyPair: { heading: 'Clash Display', body: 'General Sans', mono: 'JetBrains Mono' },
    layoutDensity: 'spacious',
    motionProfile: 'expressive',
    reasoning:
      'Creative/design/agency/studio products are the one vertical where the product IS the ' +
      'portfolio piece: expressive variable display type (Clash Display) paired with a warmer ' +
      'geometric body face (General Sans) signals craft, a saturated violet-to-orange palette gives ' +
      'the brand room to be memorable, generous spacious layout lets work breathe, and expressive ' +
      'motion is expected rather than a distraction — restraint here would undersell the work.',
  },
  enterprise: {
    industryVertical: 'enterprise',
    colorPalette: {
      primary: '#374151',
      secondary: '#4b5563',
      accent: '#2563eb',
      background: '#f9fafb',
      foreground: '#111827',
      error: '#b91c1c',
      success: '#15803d',
      warning: '#a16207',
    },
    typographyPair: { heading: 'Inter', body: 'Inter', mono: 'JetBrains Mono' },
    layoutDensity: 'compact',
    motionProfile: 'subtle',
    reasoning:
      'Enterprise/B2B/workflow/productivity tools are used for hours a day by people who did not ' +
      'choose them for delight — a neutral slate-gray primary with a single blue accent keeps focus ' +
      'on the work rather than the chrome, compact density maximizes the information a power user ' +
      'can act on per screen, and the brief called for essentially no ("none") motion, which this ' +
      'module maps to the closest supported profile, `subtle`: motion used only for unavoidable ' +
      'state feedback, never for its own sake.',
  },
  commerce: {
    industryVertical: 'commerce',
    colorPalette: {
      primary: '#e3a008',
      secondary: '#c27803',
      accent: '#0e9f6e',
      background: '#fffbeb',
      foreground: '#1c1917',
      error: '#dc2626',
      success: '#16a34a',
      warning: '#d97706',
    },
    typographyPair: { heading: 'Inter', body: 'Inter', mono: 'JetBrains Mono' },
    layoutDensity: 'balanced',
    motionProfile: 'moderate',
    reasoning:
      'Marketplace/ecommerce/shop products need a warm, appetite-appeal primary (amber/gold reads as ' +
      'energetic and "on sale" without the alarm of red), a green accent reserved for ' +
      'availability/success states (in-stock, order confirmed), balanced density for product grids ' +
      'that neither cramp images nor waste scroll, and moderate motion (hover states, add-to-cart ' +
      'feedback, carousels) that keeps browsing feeling responsive without becoming a distraction ' +
      'from checkout.',
  },
  education: {
    industryVertical: 'education',
    colorPalette: {
      primary: '#0694a2',
      secondary: '#16bdca',
      accent: '#ff8a4c',
      background: '#f0fdfa',
      foreground: '#134e4a',
      error: '#e11d48',
      success: '#059669',
      warning: '#d97706',
    },
    typographyPair: { heading: 'Quicksand', body: 'Nunito Sans', mono: 'JetBrains Mono' },
    layoutDensity: 'spacious',
    motionProfile: 'moderate',
    reasoning:
      'Education/learning/course products serve a broad, often younger or first-time audience: ' +
      'friendly rounded type (Quicksand headings, Nunito Sans body) and a teal-to-orange palette ' +
      'read as approachable rather than institutional, generous spacious layout reduces cognitive ' +
      'load for a learner working through material, and moderate motion (progress feedback, ' +
      'completion celebrations) reinforces a sense of forward progress without becoming noise.',
  },
  saas: SAAS_DESIGN_SYSTEM,
};

/**
 * Select the starter {@link DesignDecision} for `vertical`. An unrecognized vertical (anything
 * not in {@link INDUSTRY_VERTICALS} — e.g. a caller-supplied value that didn't come from
 * {@link detectIndustryVertical}) degrades to the `saas` default rather than throwing.
 */
export function selectDesignSystem(vertical: string): DesignDecision {
  const key = typeof vertical === 'string' ? vertical.toLowerCase().trim() : '';
  return DESIGN_SYSTEMS[key] ?? SAAS_DESIGN_SYSTEM;
}

// ---------------------------------------------------------------------------
// PRD content loading (mirrors src/tools/stack-detector.ts's applyDocSignals candidates)
// ---------------------------------------------------------------------------

/**
 * Candidate PRD/blueprint file locations, in read-and-concatenate order — the same
 * project-root-or-governance-subdirectory convention `src/tools/stack-detector.ts`'s
 * `applyDocSignals` already uses for its own weaker keyword signals. A retrofit target may
 * have a `PRD.md` at the root (Phase 1A's own default) or already reorganized under
 * `governance/`; both are checked so vertical detection works regardless of which stage of a
 * build wrote it.
 */
const PRD_CANDIDATE_PATHS: readonly string[] = [
  'PRD.md',
  join('governance', 'PRD.md'),
  'BLUEPRINT.md',
  join('governance', 'BLUEPRINT.md'),
];

/**
 * Read and concatenate every PRD/blueprint candidate file present under `projectPath`. Returns
 * `''` when none exist or none are readable — never throws. Exported so Phase 0 (and tests) can
 * see exactly what text {@link detectIndustryVertical} will classify without duplicating the
 * candidate-path list.
 */
export function readProjectPrdContent(projectPath: string): string {
  const chunks: string[] = [];
  for (const relPath of PRD_CANDIDATE_PATHS) {
    try {
      const fullPath = join(projectPath, relPath);
      if (existsSync(fullPath)) chunks.push(readFileSync(fullPath, 'utf8'));
    } catch {
      /* unreadable candidate — skip it, never throw */
    }
  }
  return chunks.join('\n\n');
}

// ---------------------------------------------------------------------------
// DESIGN_SYSTEM.md rendering + write
// ---------------------------------------------------------------------------

/** Render one `ColorPalette` as `:root { --color-x: ...; }` CSS custom properties. */
function renderCssCustomProperties(palette: ColorPalette): string {
  return [
    ':root {',
    `  --color-primary: ${palette.primary};`,
    `  --color-secondary: ${palette.secondary};`,
    `  --color-accent: ${palette.accent};`,
    `  --color-background: ${palette.background};`,
    `  --color-foreground: ${palette.foreground};`,
    `  --color-error: ${palette.error};`,
    `  --color-success: ${palette.success};`,
    `  --color-warning: ${palette.warning};`,
    '}',
  ].join('\n');
}

/** Render one `DesignDecision` as a Tailwind `theme.extend` config fragment. */
function renderTailwindConfigFragment(decision: DesignDecision): string {
  const { colorPalette: p, typographyPair: t } = decision;
  return [
    'theme: {',
    '  extend: {',
    '    colors: {',
    `      primary: '${p.primary}',`,
    `      secondary: '${p.secondary}',`,
    `      accent: '${p.accent}',`,
    `      background: '${p.background}',`,
    `      foreground: '${p.foreground}',`,
    `      error: '${p.error}',`,
    `      success: '${p.success}',`,
    `      warning: '${p.warning}',`,
    '    },',
    '    fontFamily: {',
    `      heading: ['${t.heading}', 'sans-serif'],`,
    `      body: ['${t.body}', 'sans-serif'],`,
    `      mono: ['${t.mono}', 'monospace'],`,
    '    },',
    '  },',
    '},',
  ].join('\n');
}

/** Human-readable guidance for a `LayoutDensity` value, used in the rendered doc. */
function densityGuidance(density: LayoutDensity): string {
  switch (density) {
    case 'compact':
      return 'Tight spacing scale (4/8/12/16px steps). Favor tables and dense lists over cards. Minimize whitespace between related items.';
    case 'spacious':
      return 'Generous spacing scale (8/16/24/32/48px steps). Favor cards and open layouts. Let content breathe — whitespace is a design element here.';
    case 'balanced':
    default:
      return 'Standard spacing scale (4/8/16/24/32px steps). Mix tables and cards by content type. Neither cramped nor sparse.';
  }
}

/** Human-readable guidance for a `MotionProfile` value, used in the rendered doc. */
function motionGuidance(motion: MotionProfile): string {
  switch (motion) {
    case 'expressive':
      return 'Motion is a brand signal, not just feedback. Page transitions, hover states, and scroll-triggered reveals are expected. Durations 300-500ms with expressive easing curves.';
    case 'moderate':
      return 'Motion reinforces state changes and guides attention (hover, add-to-cart, progress). Durations 150-300ms with standard ease-in-out.';
    case 'subtle':
    default:
      return 'Motion is reserved for essential state-change feedback only (save confirmations, validation errors, loading states). Durations under 200ms. Never purely decorative.';
  }
}

/** Render a complete `DESIGN_SYSTEM.md` body from a {@link DesignDecision}. */
function renderDesignSystemMarkdown(decision: DesignDecision): string {
  const lines: string[] = [];

  lines.push('# DESIGN_SYSTEM.md — UX Intelligence Baseline');
  lines.push('');
  lines.push(
    '> Generated by FORGE 2.0 Phase 0 (UX Intelligence, `src/skills/ux-intelligence.ts`). This is ' +
      'an early, PRD-vertical-informed BASELINE — if Phase 1B\'s UI/UX Pro Max design-system ' +
      'generation runs for this build (`src/tools/design-system-generator.ts`), it writes this same ' +
      'file again with a fuller, product-specific system that supersedes this baseline. A build that ' +
      'never reaches Phase 1B (a Phase-0-only run, or a `--use-existing-queue` re-run) still has this ' +
      'industry-appropriate starting point on disk.'
  );
  lines.push('');
  lines.push(`- **Detected industry vertical:** \`${decision.industryVertical}\``);
  lines.push(`- **Layout density:** \`${decision.layoutDensity}\``);
  lines.push(`- **Motion profile:** \`${decision.motionProfile}\``);
  lines.push('');

  lines.push('## Rationale');
  lines.push('');
  lines.push(decision.reasoning);
  lines.push('');

  lines.push('## Color Palette');
  lines.push('');
  lines.push('| Role | Hex |');
  lines.push('|------|-----|');
  lines.push(`| Primary | ${decision.colorPalette.primary} |`);
  lines.push(`| Secondary | ${decision.colorPalette.secondary} |`);
  lines.push(`| Accent | ${decision.colorPalette.accent} |`);
  lines.push(`| Background | ${decision.colorPalette.background} |`);
  lines.push(`| Foreground | ${decision.colorPalette.foreground} |`);
  lines.push(`| Error | ${decision.colorPalette.error} |`);
  lines.push(`| Success | ${decision.colorPalette.success} |`);
  lines.push(`| Warning | ${decision.colorPalette.warning} |`);
  lines.push('');

  lines.push('### CSS Custom Properties');
  lines.push('');
  lines.push('```css');
  lines.push(renderCssCustomProperties(decision.colorPalette));
  lines.push('```');
  lines.push('');

  lines.push('### Tailwind Config');
  lines.push('');
  lines.push('```js');
  lines.push(renderTailwindConfigFragment(decision));
  lines.push('```');
  lines.push('');

  lines.push('## Typography');
  lines.push('');
  lines.push('| Role | Font |');
  lines.push('|------|------|');
  lines.push(`| Heading | ${decision.typographyPair.heading} |`);
  lines.push(`| Body | ${decision.typographyPair.body} |`);
  lines.push(`| Mono | ${decision.typographyPair.mono} |`);
  lines.push('');

  lines.push('## Layout Density');
  lines.push('');
  lines.push(`**${decision.layoutDensity}.** ${densityGuidance(decision.layoutDensity)}`);
  lines.push('');

  lines.push('## Motion Profile');
  lines.push('');
  lines.push(`**${decision.motionProfile}.** ${motionGuidance(decision.motionProfile)}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Write a {@link DesignDecision} to `<projectPath>/governance/DESIGN_SYSTEM.md`. Creates the
 * `governance/` directory if it does not yet exist. Guarded — a failed write is caught and
 * silently logged to the console rather than thrown, matching every other Phase 0 step's
 * degraded-not-fatal posture (BEHAVIORAL_CONTRACTS Contract 4); this module has no `log`
 * injection point of its own, so the caller (Phase 0) is responsible for its own success/failure
 * logging around this call.
 */
export function writeDesignSystemDoc(decision: DesignDecision, projectPath: string): void {
  try {
    const governanceDir = join(projectPath, 'governance');
    mkdirSync(governanceDir, { recursive: true });
    const outputPath = join(governanceDir, 'DESIGN_SYSTEM.md');
    const markdown = renderDesignSystemMarkdown(decision);
    writeFileSync(outputPath, toAsciiGovernanceText(markdown), 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`[UX INTELLIGENCE] failed to write DESIGN_SYSTEM.md: ${detail}`);
  }
}
