/**
 * FORGE 2.0 — Design Pipeline: DesignSiteTournamentEngine (`src/design-pipeline/design-site-tournament.ts`).
 *
 * WHAT IT DOES: extends `design-tournament.ts`'s single-component N-way tournament to a full
 * MULTI-PAGE SITE tournament — 2-4 complete competing site variants, each with every page in a
 * {@link SitePagePlan} (`site-plan.ts`) generated under that variant's structural direction
 * (`design-tournament.ts`'s existing {@link TOURNAMENT_DIRECTIONS}). Additive, not a replacement:
 * `design-tournament.ts`'s single-component `DesignTournamentEngine` is untouched and still the
 * right tool for a one-off component; this engine is for "tournament the whole site."
 *
 * DESIGN INTELLIGENCE WIRING: computed ONCE per site run (not per page/variant — the site's
 * brand/persona/interface classification doesn't change per page), then folded into every page's
 * generation prompt:
 *   1. `app-profiler.ts`'s `profileAndSaveApp` — real keyword-scored `AppDesignProfile`
 *      (application type, interface types, visual complexity, motion, target users) from a
 *      synthetic queue built out of the page plan (one entry per page, title+sections as the
 *      description — `profileApp`'s own designed input shape).
 *   2. `brand-intelligence.ts`'s `inferBrandProfile` — tone/avoid/values/positioning from the
 *      brief text directly.
 *   3. `persona-profiler.ts`'s `inferTargetPersonas` — target personas from the brief text.
 *   4. `design-router.ts`'s `routeDesign` — scores `taste_skill`/`impeccable`/`awesome_design`/
 *      `img2threejs` against the profile + combined brand/persona tone, with REAL live install
 *      detection (fixed this session — see that file's own header); also runs
 *      `aesthetic-reference.ts`'s `rankAestheticFamilies` internally (`recommendedAesthetics`).
 * The routing decision does not itself switch which generator runs (still always
 * `UIComponentGenerator`, per `design-router.ts`'s own documented "decision-only" posture) — its
 * real effect here is informational (logged in full via `formatRoutingDecision`) plus feeding
 * `recommendedAesthetics`/`brand.tone`/`targetUsers` into every page's generation prompt.
 *
 * PER-VARIANT CONSISTENCY: within one variant, the HOME page is generated FIRST. Its real
 * generated code is then distilled into a short "established design system" excerpt
 * ({@link summarizeEstablishedDesignSystem}) folded into every subsequent page's prompt for that
 * SAME variant — anchoring the other pages to what Home ACTUALLY produced, not just the same
 * instructions independently re-interpreted. Baseline consistency (exact color tokens, typography,
 * nav spec) is already shared across every page's prompt via the site's own base brief text; this
 * carries the variant's own structural choices (nav pattern, section framing, card treatment)
 * forward too.
 *
 * SITE-LEVEL VARIANCE: `variance-controller.ts`'s existing `validateVariance` is reused UNCHANGED
 * — the site-level signal is built by concatenating every successfully-generated page's code into
 * one `VarianceCandidate.code` per variant (via `fromDesignDirection`), so the token-level
 * comparison spans the whole site's layout/navigation/composition, not one page's structure.
 *
 * NOT DONE (disclosed, not silently skipped): site tournament runs are NOT persisted to Build
 * Memory the way single-component tournament runs are (`design_tournament_runs`/`_variants` — a
 * schema migration for a site-shaped equivalent is real, separate scope); the N-way human approval
 * gate exists at the CLI layer (`forge design site-tournament`) exactly like the single-component
 * command, but records no `applyTournamentChoice`-equivalent persistence yet.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { logLine } from '../tools/forge-logger.js';
import { newId } from '../memory/client.js';
import type { ComponentSpec, GeneratedComponent } from '../ui-engine/component-generator.js';
import type { PlaywrightScreenshotter, ScreenshotResult } from './screenshotter.js';
import type { PageSpec, SitePagePlan } from './site-plan.js';
import {
  TOURNAMENT_DIRECTIONS,
  resolveVariantCount,
  buildVariantDirections,
  type DesignDirection,
} from './design-tournament.js';
import { validateVariance, fromDesignDirection, type VarianceValidationResult } from './variance-controller.js';
import { profileAndSaveApp, type AppProfilerQueueEntry, type AppDesignProfile } from './app-profiler.js';
import { inferBrandProfile, type BrandProfile } from './brand-intelligence.js';
import { inferTargetPersonas, type TargetPersona } from './persona-profiler.js';
import { routeDesign, formatRoutingDecision, type DesignRoutingDecision } from './design-router.js';

const log = logLine('design-site-tournament');

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface SiteDesignIntelligence {
  profile: AppDesignProfile;
  brandProfile: BrandProfile;
  personas: TargetPersona[];
  routingDecision: DesignRoutingDecision;
}

export interface SiteVariantPageResult {
  page: PageSpec;
  componentName: string;
  filePath: string | null;
  screenshotPaths: string[];
  accessibility: number | null; // 0-10, scaled from the real 0-100 accessibility score
  generationError: string | null;
}

export interface SiteVariantResult {
  direction: DesignDirection;
  pages: SiteVariantPageResult[];
  pagesGenerated: number;
  pagesFailed: number;
  /** Average accessibility score (0-10) across pages that produced one, or `null` if none did. */
  averageAccessibility: number | null;
  /** Every successfully-generated page's REAL code, concatenated in generation order — the site-level token-comparison signal `validateVariance` compares pairwise (see {@link fromDesignDirection} usage in `run()`). Not per-page in {@link SiteVariantPageResult} to avoid duplicating potentially large source in every logged/serialized page result. */
  concatenatedCode: string;
}

export interface SiteTournamentResult {
  id: string;
  siteName: string;
  pagePlan: SitePagePlan;
  intelligence: SiteDesignIntelligence;
  variants: SiteVariantResult[];
  varianceResult: VarianceValidationResult;
  recommendation: string;
  status: 'awaiting_approval';
}

export interface ComponentGeneratorLike {
  generate(
    spec: ComponentSpec,
    projectPath: string,
    buildRunId: string,
    promptId: string,
    promptType?: string
  ): Promise<GeneratedComponent>;
}

export interface DesignSiteTournamentOptions {
  log?: (message: string) => void;
  variantCount?: number;
  /** Restrict this run to specific direction ids (e.g. `['a']` for a checkpoint run). Default: every direction up to `variantCount`. */
  variantIds?: readonly string[];
  componentGenerator?: ComponentGeneratorLike;
  screenshotter?: PlaywrightScreenshotter;
}

// ---------------------------------------------------------------------------
// Design intelligence (computed once per site run)
// ---------------------------------------------------------------------------

/** Build one synthetic `AppProfilerQueueEntry` per page — `profileApp`'s own designed input shape. */
function pagesToProfilerEntries(pagePlan: SitePagePlan, briefText: string): AppProfilerQueueEntry[] {
  // The overall brief's own prose (site type, audience, tone framing) carries the strongest
  // classification signal and would otherwise never reach app-profiler's corpus — individual page
  // titles/section labels ("Home", "Pricing", "hero", "faq") are far too thin on their own to hit
  // `INTERFACE_TYPE_VOCAB`/`APPLICATION_TYPE_VOCAB` keywords (a real gap this comment fixes,
  // confirmed by `tests/design-site-tournament.test.ts` failing without it).
  const briefEntry: AppProfilerQueueEntry = { id: 'brief', name: 'Site Brief', description: briefText, prompt_type: 'ui' };
  const pageEntries: AppProfilerQueueEntry[] = pagePlan.pages.map((p) => ({
    id: p.slug,
    name: p.title,
    description: [p.title, p.note, ...p.sections].filter((s) => s.trim() !== '').join('. '),
    prompt_type: 'ui',
  }));
  return [briefEntry, ...pageEntries];
}

/**
 * Compute the full design-intelligence chain (app-profiler -> brand-intelligence +
 * persona-profiler -> design-router) once for the whole site, logging every real finding —
 * classification, brand tone, personas, and the router's full considered/not-considered
 * breakdown (`formatRoutingDecision`) — so a caller can confirm none of this silently produced
 * empty/default output.
 */
export async function computeSiteDesignIntelligence(
  siteName: string,
  projectPath: string,
  briefText: string,
  pagePlan: SitePagePlan,
  logger: (message: string) => void
): Promise<SiteDesignIntelligence> {
  const profile = await profileAndSaveApp({ projectName: siteName, entries: pagesToProfilerEntries(pagePlan, briefText) });
  logger(
    `[DESIGN INTELLIGENCE] app-profiler: type=${profile.applicationType.primary} ` +
      `interfaces=[${profile.interfaceTypes.join(', ')}] complexity=${profile.visualComplexity} ` +
      `motion=${profile.motionRequirement} targetUsers=[${profile.targetUsers.join(', ')}]`
  );

  const brandProfile = inferBrandProfile(siteName, projectPath, briefText);
  logger(
    `[DESIGN INTELLIGENCE] brand-intelligence: tone=[${brandProfile.tone.join(', ')}] ` +
      `avoid=[${brandProfile.avoid.join(', ')}] confidence=${brandProfile.confidence} ` +
      `positioning="${brandProfile.positioning}"`
  );

  const personas = inferTargetPersonas(projectPath, briefText);
  logger(
    personas.length > 0
      ? `[DESIGN INTELLIGENCE] persona-profiler: ${personas.length} persona(s) — ${personas
          .map((p) => `${p.role} (${p.technicalProficiency} proficiency, evidence x${p.evidenceCount})`)
          .join('; ')}`
      : '[DESIGN INTELLIGENCE] persona-profiler: no personas detected in the brief text'
  );

  // app-profiler's INTERFACE_TYPE_VOCAB matches exact multi-word phrases ('marketing site', 'hero
  // section', ...) — a real brief describing a marketing site without using those literal phrases
  // (common: "gateway hero", "22-page ... website") can legitimately classify to interfaceTypes:
  // [] even though it obviously IS one. Never silently substituting without saying so.
  const interfaceType = profile.interfaceTypes[0] ?? 'marketing_site';
  if (profile.interfaceTypes.length === 0) {
    logger(
      `WARNING: [DESIGN INTELLIGENCE] app-profiler detected no interfaceType from the brief's exact vocabulary ` +
        `(applicationType.primary='${profile.applicationType.primary}') — defaulting design-router's interfaceType to '${interfaceType}'.`
    );
  }
  const routingDecision = await routeDesign(profile, interfaceType, { brandProfile, personas });
  logger(`[DESIGN INTELLIGENCE] design-router:\n${formatRoutingDecision(routingDecision)}`);

  return { profile, brandProfile, personas, routingDecision };
}

// ---------------------------------------------------------------------------
// Page spec construction
// ---------------------------------------------------------------------------

/** Render a page's own section list (when the brief declared one) as an explicit, numbered spec. */
function renderPageSections(page: PageSpec): string {
  if (page.sections.length === 0) return '';
  const lines = page.sections.map((s, i) => `${i + 1}. ${s}`);
  return `\n\nREQUIRED SECTIONS (in order):\n${lines.join('\n')}`;
}

/**
 * Build one page's `ComponentSpec` for `direction`, folding in: the shared site brief, the page's
 * own template sections, the tournament direction's structural directive, the design-intelligence
 * findings (brand tone, target users, recommended aesthetic), and — for every page after Home —
 * the established design system excerpt so the variant stays visually consistent with itself.
 */
export function buildSitePageSpec(
  siteName: string,
  briefText: string,
  page: PageSpec,
  direction: DesignDirection,
  intelligence: SiteDesignIntelligence,
  establishedDesignSystem: string | null
): ComponentSpec {
  const topAesthetic = intelligence.routingDecision.recommendedAesthetics[0];
  const descriptionParts = [
    `Full site brief for '${siteName}':\n${briefText}`,
    `\n\nTHIS PAGE: '${page.title}' (route: /${page.slug}, kind: ${page.kind}).${page.note ? ` ${page.note}` : ''}`,
    renderPageSections(page),
    `\n\nDESIGN DIRECTION — "${direction.name}": ${direction.layoutDirective}`,
    `\n\nBRAND TONE: ${intelligence.brandProfile.tone.join(', ') || '(none inferred)'}. AVOID: ${
      intelligence.brandProfile.avoid.join(', ') || '(none inferred)'
    }.`,
    intelligence.personas.length > 0
      ? `\n\nTARGET PERSONAS: ${intelligence.personas.map((p) => p.role).join(', ')}.`
      : '',
    topAesthetic ? `\n\nRECOMMENDED AESTHETIC FAMILY: ${topAesthetic.family.name} — ${topAesthetic.family.id}.` : '',
    establishedDesignSystem
      ? `\n\nESTABLISHED SITE DESIGN SYSTEM (from this variant's already-generated Home page — match it exactly, do not reinterpret): ${establishedDesignSystem}`
      : '',
  ];

  return {
    name: `${page.name}Variant${direction.id.toUpperCase()}`,
    description: descriptionParts.join(''),
    props: [],
    dataSource: null,
    interactions: [`Structural direction tags: ${direction.structuralTags.join(', ')}`],
    accessibility: [],
  };
}

/**
 * Distill a short, promptable summary of a variant's actual generated Home code — real signal
 * (the literal component name + a bounded excerpt of the real source), never invented prose. Kept
 * short (see {@link ESTABLISHED_SYSTEM_EXCERPT_CHARS}) since it's re-embedded into every one of
 * this variant's remaining page prompts.
 */
const ESTABLISHED_SYSTEM_EXCERPT_CHARS = 3_000;

export function summarizeEstablishedDesignSystem(homeComponentName: string, homeCode: string): string {
  const excerpt =
    homeCode.length > ESTABLISHED_SYSTEM_EXCERPT_CHARS
      ? `${homeCode.slice(0, ESTABLISHED_SYSTEM_EXCERPT_CHARS)}\n... [excerpt truncated]`
      : homeCode;
  return `Reference component '${homeComponentName}':\n\`\`\`tsx\n${excerpt}\n\`\`\``;
}

// ---------------------------------------------------------------------------
// DesignSiteTournamentEngine
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** POSIX-style relative import path (no extension) from `fromDir` to `toFileNoExt`. */
function relativeImportPath(fromDir: string, toFileNoExt: string): string {
  const rel = relative(fromDir, toFileNoExt).split('\\').join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * Preview-mount folder name, under `src/app/`, that hosts every generated page's throwaway
 * preview route for screenshot capture. MUST NOT start with `_` (or be wrapped in `(parens)`) —
 * Next.js App Router treats an underscore-prefixed (or parenthesized) segment as a "private
 * folder" and excludes it from routing entirely, so a page.tsx placed there 404s unconditionally
 * regardless of server health or the page's own code. (Previously `_forge-site-tournament` — every
 * site-tournament screenshot capture 404'd from day one because of this; confirmed via literal
 * "This page could not be found" screenshots. `cleanupPreviewDir` removes this folder at the end
 * of every run, so a normal (routable) name is safe — it's never left mounted in a real build.)
 */
const PREVIEW_MOUNT_DIR = 'forge-site-tournament-preview';

function buildPreviewPageSource(pageDir: string, componentFilePathNoExt: string, componentName: string): string {
  const importPath = relativeImportPath(pageDir, componentFilePathNoExt);
  return (
    `import { ${componentName} } from '${importPath}';\n\n` +
    `export default function ForgeSiteTournamentPreviewPage() {\n` +
    `  return <${componentName} />;\n` +
    `}\n`
  );
}

export class DesignSiteTournamentEngine {
  private readonly log: (message: string) => void;
  private readonly directions: DesignDirection[];
  private readonly componentGenerator: ComponentGeneratorLike | null;
  private readonly screenshotter: PlaywrightScreenshotter | null;

  constructor(options: DesignSiteTournamentOptions = {}) {
    this.log = options.log ?? log;
    const allForCount = buildVariantDirections(resolveVariantCount(options.variantCount ?? TOURNAMENT_DIRECTIONS.length));
    this.directions = options.variantIds
      ? allForCount.filter((d) => options.variantIds!.includes(d.id))
      : allForCount;
    this.componentGenerator = options.componentGenerator ?? null;
    this.screenshotter = options.screenshotter ?? null;
  }

  /**
   * Run the full site tournament: compute design intelligence once, then generate every page in
   * `pagePlan` for every requested direction (Home first per variant, for consistency), capture
   * screenshots, run site-level variance validation, and return the (never auto-selected) result.
   * A single page's generation failure is recorded on that page and does not abort the rest of
   * that variant, matching `design-tournament.ts`'s own Contract 4 posture.
   */
  async run(
    siteName: string,
    briefText: string,
    pagePlan: SitePagePlan,
    projectPath: string,
    buildRunId: string,
    promptId: string
  ): Promise<SiteTournamentResult> {
    const runId = newId();
    this.log(`[SITE TOURNAMENT] '${siteName}': ${pagePlan.pages.length} page(s) x ${this.directions.length} direction(s)`);

    const intelligence = await computeSiteDesignIntelligence(siteName, projectPath, briefText, pagePlan, this.log);

    const previewDir = join(projectPath, 'src', 'app', PREVIEW_MOUNT_DIR, runId);
    let devServerPort: number | null = null;
    if (this.screenshotter) {
      devServerPort = await this.screenshotter.startDevServer(projectPath).catch(() => null);
    }

    const variants: SiteVariantResult[] = [];
    for (const direction of this.directions) {
      variants.push(
        await this.runVariant(siteName, briefText, pagePlan, direction, intelligence, projectPath, buildRunId, promptId, previewDir, devServerPort)
      );
    }

    if (this.screenshotter && devServerPort !== null) await this.screenshotter.stopDevServer();
    this.cleanupPreviewDir(previewDir);

    const varianceResult = validateVariance(variants.map((v) => fromDesignDirection(v.direction, v.concatenatedCode)));
    this.log(`[SITE TOURNAMENT] site-level variance: ${varianceResult.summary}`);

    const recommendation = buildSiteRecommendation(siteName, variants);

    return {
      id: runId,
      siteName,
      pagePlan,
      intelligence,
      variants,
      varianceResult,
      recommendation,
      status: 'awaiting_approval',
    };
  }

  private async runVariant(
    siteName: string,
    briefText: string,
    pagePlan: SitePagePlan,
    direction: DesignDirection,
    intelligence: SiteDesignIntelligence,
    projectPath: string,
    buildRunId: string,
    promptId: string,
    previewDir: string,
    devServerPort: number | null
  ): Promise<SiteVariantResult> {
    this.log(`[SITE TOURNAMENT] variant '${direction.name}' [${direction.id}]: starting ${pagePlan.pages.length} page(s)`);

    // Home (or the first hub page) goes first, establishing this variant's real design system for
    // every subsequent page to anchor to.
    const orderedPages = orderPagesHomeFirst(pagePlan.pages);
    const pageResults: SiteVariantPageResult[] = [];
    const codeParts: string[] = [];
    let establishedDesignSystem: string | null = null;

    for (const page of orderedPages) {
      const spec = buildSitePageSpec(siteName, briefText, page, direction, intelligence, establishedDesignSystem);

      if (!this.componentGenerator) {
        pageResults.push(emptyPageResult(page, 'no ComponentGenerator configured'));
        continue;
      }

      let component: GeneratedComponent | null = null;
      let generationError: string | null = null;
      try {
        component = await this.componentGenerator.generate(spec, projectPath, buildRunId, promptId, 'page');
      } catch (error) {
        generationError = describeError(error);
        this.log(`WARNING: [SITE TOURNAMENT] '${direction.name}' / '${page.slug}': generation failed (${generationError})`);
      }

      if (component) {
        codeParts.push(component.code);
        if (establishedDesignSystem === null) {
          establishedDesignSystem = summarizeEstablishedDesignSystem(component.spec.name, component.code);
        }
      }

      let screenshotPaths: string[] = [];
      let accessibility: number | null = null;
      if (component && this.screenshotter && devServerPort !== null) {
        const shots = await this.captureSitePage(component, direction, page, projectPath, previewDir, devServerPort, buildRunId, promptId);
        screenshotPaths = shots.map((s) => s.filePath);
        const rawAccessibility = shots.find((s) => typeof s.accessibilityScore === 'number')?.accessibilityScore ?? null;
        accessibility = rawAccessibility === null ? null : rawAccessibility / 10;
      }

      pageResults.push({
        page,
        componentName: spec.name,
        filePath: component?.filePath ?? null,
        screenshotPaths,
        accessibility,
        generationError,
      });
    }

    const pagesGenerated = pageResults.filter((p) => p.filePath !== null).length;
    const pagesFailed = pageResults.length - pagesGenerated;
    const scored = pageResults.filter((p) => p.accessibility !== null).map((p) => p.accessibility as number);
    const averageAccessibility = scored.length > 0 ? scored.reduce((a, b) => a + b, 0) / scored.length : null;

    this.log(
      `[SITE TOURNAMENT] variant '${direction.name}' [${direction.id}]: ${pagesGenerated}/${pageResults.length} page(s) generated` +
        (pagesFailed > 0 ? ` (${pagesFailed} FAILED)` : '')
    );

    return {
      direction,
      pages: pageResults,
      pagesGenerated,
      pagesFailed,
      averageAccessibility,
      concatenatedCode: codeParts.join('\n\n'),
    };
  }

  private async captureSitePage(
    component: GeneratedComponent,
    direction: DesignDirection,
    page: PageSpec,
    projectPath: string,
    previewDir: string,
    devServerPort: number,
    buildRunId: string,
    promptId: string
  ): Promise<ScreenshotResult[]> {
    if (!this.screenshotter) return [];
    const pageDir = join(previewDir, direction.id, page.slug);
    try {
      mkdirSync(pageDir, { recursive: true });
      const componentFileNoExt = component.filePath.replace(/\.tsx$/, '');
      writeFileSync(join(pageDir, 'page.tsx'), buildPreviewPageSource(pageDir, componentFileNoExt, component.spec.name), 'utf8');
    } catch (error) {
      this.log(`WARNING: [SITE TOURNAMENT] could not write preview page for '${direction.name}'/'${page.slug}' (${describeError(error)})`);
      return [];
    }

    const route = `/${PREVIEW_MOUNT_DIR}/${previewDir.split(/[\\/]/).pop()}/${direction.id}/${page.slug}`;
    const url = `http://localhost:${devServerPort}${route}`;
    try {
      return await this.screenshotter.captureComponent(url, {
        projectPath,
        buildRunId,
        promptId,
        componentName: component.spec.name,
      });
    } catch (error) {
      this.log(`WARNING: [SITE TOURNAMENT] capture failed for '${direction.name}'/'${page.slug}' (${describeError(error)})`);
      return [];
    }
  }

  private cleanupPreviewDir(previewDir: string): void {
    try {
      rmSync(previewDir, { recursive: true, force: true });
    } catch (error) {
      this.log(`WARNING: [SITE TOURNAMENT] could not clean up preview directory '${previewDir}' (${describeError(error)})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Home (or the site's first hub page, when there is no page literally slugged 'home') goes first — every other page keeps its plan order after it. */
function orderPagesHomeFirst(pages: readonly PageSpec[]): PageSpec[] {
  const homeIndex = pages.findIndex((p) => p.slug === 'home');
  const anchorIndex = homeIndex >= 0 ? homeIndex : pages.findIndex((p) => p.kind === 'hub');
  if (anchorIndex <= 0) return [...pages];
  const anchor = pages[anchorIndex]!;
  return [anchor, ...pages.slice(0, anchorIndex), ...pages.slice(anchorIndex + 1)];
}

function emptyPageResult(page: PageSpec, error: string): SiteVariantPageResult {
  return { page, componentName: '', filePath: null, screenshotPaths: [], accessibility: null, generationError: error };
}

/**
 * Build a factual (never invented-prose) site-level recommendation from real per-variant
 * generation/accessibility outcomes.
 */
function buildSiteRecommendation(siteName: string, variants: readonly SiteVariantResult[]): string {
  const complete = variants.filter((v) => v.pagesFailed === 0);
  const scored = variants.filter((v) => v.averageAccessibility !== null);
  const lines: string[] = [];
  for (const v of variants) {
    lines.push(
      `${v.direction.name} [${v.direction.id}]: ${v.pagesGenerated}/${v.pages.length} pages generated` +
        (v.averageAccessibility !== null ? `, avg accessibility ${Math.round(v.averageAccessibility * 10)}/100` : ', unscored') +
        (v.pagesFailed > 0 ? ` — ${v.pagesFailed} page(s) FAILED` : '')
    );
  }
  if (scored.length > 0) {
    const ranked = [...scored].sort((a, b) => (b.averageAccessibility ?? 0) - (a.averageAccessibility ?? 0));
    lines.push(
      `${ranked[0]!.direction.name} scored highest on average accessibility among fully/partially scored variants.`
    );
  }
  lines.push(
    `${complete.length}/${variants.length} variant(s) generated every page with zero failures.`,
    'Automated evaluators cover accessibility only for this site-level run — visual_hierarchy, brand_alignment, ' +
      'usability, consistency, information_architecture, performance, and originality require human judgment.',
    `AWAITING HUMAN DESIGN APPROVAL for '${siteName}'.`
  );
  return lines.join(' ');
}

export function createDesignSiteTournamentEngine(options: DesignSiteTournamentOptions = {}): DesignSiteTournamentEngine {
  return new DesignSiteTournamentEngine(options);
}

export default DesignSiteTournamentEngine;
