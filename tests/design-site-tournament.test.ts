/**
 * FORGE 2.0 — Design Site Tournament tests (`src/design-pipeline/design-site-tournament.ts`).
 *
 * `DesignSiteTournamentEngine.run` is exercised with an injected `ComponentGeneratorLike` fake
 * (no real Claude Code CLI call) and no screenshotter (capture is optional, matching
 * `design-tournament.ts`'s own test convention in `tests/design-intelligence.test.ts`) — but
 * `computeSiteDesignIntelligence` runs for REAL (app-profiler/brand-intelligence/persona-profiler/
 * design-router are pure/deterministic against the supplied brief text; only Build Memory reads
 * inside `routeDesign` touch a real DB, already covered by that module's own tests).
 *
 * HOW TO RUN
 *     node --import tsx --test tests/design-site-tournament.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DesignSiteTournamentEngine,
  buildSitePageSpec,
  summarizeEstablishedDesignSystem,
  computeSiteDesignIntelligence,
  type ComponentGeneratorLike,
} from '../src/design-pipeline/design-site-tournament.js';
import { TOURNAMENT_DIRECTIONS } from '../src/design-pipeline/design-tournament.js';
import { slugToPascalCase } from '../src/design-pipeline/site-plan.js';
import type { SitePagePlan, PageSpec } from '../src/design-pipeline/site-plan.js';
import type { ComponentSpec, GeneratedComponent } from '../src/ui-engine/component-generator.js';

const RUN_ID = `${Date.now()}`;

/** `name` defaults via `slugToPascalCase`, matching what real `derivePagePlan` always produces — never a raw slug. */
function page(over: Partial<PageSpec> & { slug: string }): PageSpec {
  return {
    slug: over.slug,
    name: over.name ?? slugToPascalCase(over.slug),
    title: over.title ?? over.slug,
    kind: over.kind ?? 'bespoke',
    parentSlug: over.parentSlug ?? null,
    sections: over.sections ?? [],
    note: over.note ?? '',
  };
}

const BRIEF_TEXT =
  'Build a marketing site with a hero section and a pricing page for a nonprofit-grant-management ' +
  'SaaS platform, targeting nonprofit development directors and grant managers. Premium, trustworthy, ' +
  'editorial tone.';

function makePagePlan(): SitePagePlan {
  return {
    pages: [
      page({ slug: 'pricing', title: 'Pricing', kind: 'bespoke' }),
      page({ slug: 'home', title: 'Home', kind: 'hub' }),
      page({ slug: 'funding-intelligence', title: 'Funding Intelligence', kind: 'sub', parentSlug: 'platform', sections: ['hero', 'demo', 'faq'] }),
    ],
    source: 'llm-extracted',
    warnings: [],
  };
}

/** A fake generator that always succeeds, recording every spec it was asked to build (for ordering/consistency assertions). */
function countingGenerator(over: { failSlugContains?: string } = {}): { generator: ComponentGeneratorLike; calls: ComponentSpec[] } {
  const calls: ComponentSpec[] = [];
  const generator: ComponentGeneratorLike = {
    generate: async (spec) => {
      calls.push(spec);
      if (over.failSlugContains && spec.name.includes(over.failSlugContains)) {
        throw new Error('synthetic generation failure');
      }
      const generated: GeneratedComponent = {
        spec,
        code: `export function ${spec.name}() { return <div>UNIQUE_${spec.name}</div>; }`,
        storyCode: '',
        testCode: '',
        filePath: `/tmp/${spec.name}.tsx`,
      };
      return generated;
    },
  };
  return { generator, calls };
}

describe('design-site-tournament: computeSiteDesignIntelligence (real modules, no CLI call)', () => {
  test('runs app-profiler + brand-intelligence + persona-profiler + design-router for real and returns non-empty findings', async () => {
    const logs: string[] = [];
    const pagePlan = makePagePlan();
    const intelligence = await computeSiteDesignIntelligence(
      `SiteTest${RUN_ID}`,
      process.cwd(),
      BRIEF_TEXT,
      pagePlan,
      (m) => logs.push(m)
    );

    assert.ok(intelligence.profile.interfaceTypes.length > 0, 'app-profiler should classify at least one interface type');
    assert.ok(intelligence.brandProfile.tone.length > 0, 'brand-intelligence should infer at least one tone word');
    assert.ok(intelligence.routingDecision.reasons.length > 0, 'design-router should produce real reasons');
    assert.ok(
      ['taste_skill', 'impeccable', 'awesome_design', 'img2threejs'].includes(intelligence.routingDecision.primaryTool),
      'primaryTool should be a real DesignTool'
    );

    // Every step logged real, non-empty findings — proving none of this silently produced empty output.
    assert.ok(logs.some((l) => l.includes('app-profiler:')));
    assert.ok(logs.some((l) => l.includes('brand-intelligence:')));
    assert.ok(logs.some((l) => l.includes('persona-profiler:')));
    assert.ok(logs.some((l) => l.includes('design-router:')));
  });
});

describe('design-site-tournament: buildSitePageSpec', () => {
  test('folds direction, brand tone, and established design system into the page description', async () => {
    const pagePlan = makePagePlan();
    const intelligence = await computeSiteDesignIntelligence(`SiteTest${RUN_ID}b`, process.cwd(), BRIEF_TEXT, pagePlan, () => {});
    const direction = TOURNAMENT_DIRECTIONS[0]!;
    const homePage = pagePlan.pages.find((p) => p.slug === 'home')!;

    const specWithoutSystem = buildSitePageSpec('SiteTest', BRIEF_TEXT, homePage, direction, intelligence, null);
    assert.ok(specWithoutSystem.description.includes(direction.layoutDirective));
    assert.ok(!specWithoutSystem.description.includes('ESTABLISHED SITE DESIGN SYSTEM'));

    const system = summarizeEstablishedDesignSystem('HomeVariantA', 'export function HomeVariantA() { return null; }');
    const specWithSystem = buildSitePageSpec('SiteTest', BRIEF_TEXT, homePage, direction, intelligence, system);
    assert.ok(specWithSystem.description.includes('ESTABLISHED SITE DESIGN SYSTEM'));
    assert.ok(specWithSystem.description.includes('HomeVariantA'));
  });

  test('renders a sub-page\'s required sections as an explicit numbered list', async () => {
    const pagePlan = makePagePlan();
    const intelligence = await computeSiteDesignIntelligence(`SiteTest${RUN_ID}c`, process.cwd(), BRIEF_TEXT, pagePlan, () => {});
    const direction = TOURNAMENT_DIRECTIONS[0]!;
    const subPage = pagePlan.pages.find((p) => p.slug === 'funding-intelligence')!;

    const spec = buildSitePageSpec('SiteTest', BRIEF_TEXT, subPage, direction, intelligence, null);
    assert.ok(spec.description.includes('REQUIRED SECTIONS'));
    assert.ok(spec.description.includes('1. hero'));
    assert.ok(spec.description.includes('2. demo'));
    assert.ok(spec.description.includes('3. faq'));
  });
});

describe('design-site-tournament: DesignSiteTournamentEngine.run (injected generator, no screenshotter)', () => {
  test('generates Home first regardless of plan order, and every subsequent page carries the established design system', async () => {
    const { generator, calls } = countingGenerator();
    const engine = new DesignSiteTournamentEngine({ componentGenerator: generator, variantCount: 2, variantIds: ['a'], log: () => {} });
    const pagePlan = makePagePlan(); // plan order: pricing, home, funding-intelligence

    const result = await engine.run(`Site${RUN_ID}`, BRIEF_TEXT, pagePlan, process.cwd(), `build-${RUN_ID}`, `prompt-${RUN_ID}`);

    assert.equal(result.variants.length, 1);
    const variantA = result.variants[0]!;
    assert.equal(variantA.pagesGenerated, 3);
    assert.equal(variantA.pagesFailed, 0);

    // Home was generated FIRST despite being second in the plan.
    assert.equal(calls[0]!.name, `HomeVariant${variantA.direction.id.toUpperCase()}`);

    // The page generated after Home carries the established-design-system block; Home's own spec does not.
    const homeCallIndex = calls.findIndex((c) => c.name.startsWith('HomeVariant'));
    assert.ok(!calls[homeCallIndex]!.description.includes('ESTABLISHED SITE DESIGN SYSTEM'));
    for (let i = homeCallIndex + 1; i < calls.length; i++) {
      assert.ok(calls[i]!.description.includes('ESTABLISHED SITE DESIGN SYSTEM'), `expected page ${calls[i]!.name} to carry the established design system`);
    }
  });

  test('a single page failure is recorded on that page and does not abort the rest of the variant (Contract 4)', async () => {
    const { generator } = countingGenerator({ failSlugContains: 'FundingIntelligence' });
    const engine = new DesignSiteTournamentEngine({ componentGenerator: generator, variantIds: ['a'], log: () => {} });
    const pagePlan = makePagePlan();

    const result = await engine.run(`Site${RUN_ID}d`, BRIEF_TEXT, pagePlan, process.cwd(), `build-${RUN_ID}`, `prompt-${RUN_ID}`);

    const variantA = result.variants[0]!;
    assert.equal(variantA.pagesGenerated, 2);
    assert.equal(variantA.pagesFailed, 1);
    const failed = variantA.pages.find((p) => p.page.slug === 'funding-intelligence')!;
    assert.equal(failed.filePath, null);
    assert.ok(failed.generationError?.includes('synthetic generation failure'));
    // The other two pages still completed successfully.
    assert.ok(variantA.pages.filter((p) => p.filePath !== null).length === 2);
  });

  test('--only restricts generation to the requested direction id(s) — no calls for the others', async () => {
    const { generator, calls } = countingGenerator();
    const engine = new DesignSiteTournamentEngine({ componentGenerator: generator, variantIds: ['a'], log: () => {} });
    const pagePlan: SitePagePlan = { pages: [page({ slug: 'home', kind: 'hub' })], source: 'llm-extracted', warnings: [] };

    const result = await engine.run(`Site${RUN_ID}e`, BRIEF_TEXT, pagePlan, process.cwd(), `build-${RUN_ID}`, `prompt-${RUN_ID}`);

    assert.equal(result.variants.length, 1);
    assert.equal(result.variants[0]!.direction.id, 'a');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, 'HomeVariantA');
  });

  test('site-level variance result compares CONCATENATED page code per variant, not a single page', async () => {
    const { generator } = countingGenerator();
    const engine = new DesignSiteTournamentEngine({ componentGenerator: generator, variantIds: ['a', 'b'], log: () => {} });
    const pagePlan = makePagePlan();

    const result = await engine.run(`Site${RUN_ID}f`, BRIEF_TEXT, pagePlan, process.cwd(), `build-${RUN_ID}`, `prompt-${RUN_ID}`);

    assert.equal(result.variants.length, 2);
    for (const v of result.variants) {
      // concatenatedCode should contain markers from ALL 3 pages, not just one.
      assert.ok(v.concatenatedCode.includes(`HomeVariant${v.direction.id.toUpperCase()}`));
      assert.ok(v.concatenatedCode.includes(`PricingVariant${v.direction.id.toUpperCase()}`));
      assert.ok(v.concatenatedCode.includes(`FundingIntelligenceVariant${v.direction.id.toUpperCase()}`));
    }
    assert.equal(result.varianceResult.comparisons.length, 1);
    assert.deepEqual(result.varianceResult.comparisons[0]!.aId, 'a');
    assert.deepEqual(result.varianceResult.comparisons[0]!.bId, 'b');
  });

  test('with no componentGenerator configured, every page is recorded as failed rather than throwing', async () => {
    const engine = new DesignSiteTournamentEngine({ variantIds: ['a'], log: () => {} });
    const pagePlan: SitePagePlan = { pages: [page({ slug: 'home', kind: 'hub' })], source: 'llm-extracted', warnings: [] };

    const result = await engine.run(`Site${RUN_ID}g`, BRIEF_TEXT, pagePlan, process.cwd(), `build-${RUN_ID}`, `prompt-${RUN_ID}`);

    assert.equal(result.variants[0]!.pagesFailed, 1);
    assert.equal(result.variants[0]!.pages[0]!.generationError, 'no ComponentGenerator configured');
  });
});
