/**
 * FORGE 2.0 — Design Intelligence tests: App Profiler, Design Router, Design Tournament,
 * Design Memory (`src/design-pipeline/{app-profiler,design-router,design-tournament,
 * design-memory}.ts`).
 *
 * Two tiers, matching this repo's own convention (`tests/design-system-generator.test.ts` for
 * pure/injected, `tests/memory.test.ts` for real-DB):
 *   1. Pure/deterministic functions (classification, scoring math, spec construction, tag
 *      extraction) — no DB, no network, no injected fakes needed.
 *   2. Persistence round-trips against the LIVE local Build Memory SQLite db
 *      (`~/.forge/forge_memory.db`, opened via `src/memory/client.ts`'s `getClient()` — no Docker/
 *      Supabase required, see that module's own header). Rows are namespaced with a per-run id and
 *      deleted in `after`, matching `tests/memory.test.ts`'s cleanup convention.
 *
 * `DesignTournamentEngine.run` is exercised with an injected `ComponentGeneratorLike` fake (no
 * real Claude Code CLI call) and no screenshotter (capture is optional per Contract 4 — the
 * engine must still produce a valid, persisted, unscored result).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { profileApp, saveAppDesignProfile, getAppDesignProfile, type AppProfilerQueueEntry } from '../src/design-pipeline/app-profiler.js';
import { routeDesign, DESIGN_TOOLS, formatRoutingDecision } from '../src/design-pipeline/design-router.js';
import {
  extractTagsFromFeedback,
  recordPreference,
  getPreferenceScore,
  formatPreferences,
  CANONICAL_TAG_PHRASES,
} from '../src/design-pipeline/design-memory.js';
import {
  resolveVariantCount,
  buildVariantDirections,
  buildVariantSpec,
  computeTokenJaccardSimilarity,
  TOURNAMENT_DIRECTIONS,
  DesignTournamentEngine,
  formatTournamentResult,
  type ComponentGeneratorLike,
} from '../src/design-pipeline/design-tournament.js';
import { getClient, resetClient } from '../src/memory/client.js';
import type { ComponentSpec, GeneratedComponent } from '../src/ui-engine/component-generator.js';

const RUN_ID = `${Date.now()}`;

// ---------------------------------------------------------------------------
// App Profiler — pure classification
// ---------------------------------------------------------------------------

describe('app-profiler: profileApp', () => {
  test('empty corpus degrades to documented fallbacks, never throws', () => {
    const profile = profileApp({ projectName: 'Empty', entries: [] });
    assert.equal(profile.applicationType.primary, 'general');
    assert.deepEqual(profile.interfaceTypes, []);
    assert.equal(profile.visualComplexity, 'low');
    assert.equal(profile.motionRequirement, 'none');
    assert.equal(profile.threeDRequirement, 'none');
    assert.match(profile.sourceSummary, /no queue entries available/);
  });

  test('b2b industrial corpus classifies as b2b_commerce with matching brand defaults', () => {
    const entries: AppProfilerQueueEntry[] = [
      { id: '1', name: 'Quoting flow', description: 'B2B wholesale procurement quoting and purchase order tool for suppliers' },
      { id: '2', name: 'Admin dashboard', description: 'Internal ops console admin panel for order review', prompt_type: 'feature' },
    ];
    const profile = profileApp({ projectName: 'Acme', entries });
    assert.equal(profile.applicationType.primary, 'b2b_commerce');
    assert.ok(profile.brand.tone.includes('industrial'));
    assert.ok(profile.brand.avoid.includes('playful'));
  });

  test('3D package.json dependency forces threeDRequirement to high regardless of prompt text', () => {
    const profile = profileApp({
      projectName: 'ThreeDApp',
      entries: [{ id: '1', name: 'Viewer', description: 'Product viewer page' }],
      packageJson: { dependencies: { '@react-three/fiber': '^8.0.0' } },
    });
    assert.equal(profile.threeDRequirement, 'high');
  });

  test('motion keyword density maps to the documented tiers', () => {
    const zero = profileApp({ projectName: 'X', entries: [{ id: '1', description: 'a plain page' }] });
    assert.equal(zero.motionRequirement, 'none');

    const high = profileApp({
      projectName: 'X',
      entries: [
        { id: '1', description: 'animate the hero with parallax, transition, animation, micro-interaction' },
      ],
    });
    assert.equal(high.motionRequirement, 'high');
  });

  test('interface types drive per-type data density classification', () => {
    const profile = profileApp({
      projectName: 'X',
      entries: [
        { id: '1', name: 'Landing page', description: 'marketing site landing page hero section' },
        { id: '2', name: 'Admin dashboard', description: 'admin dashboard data table data grid analytics' },
      ],
    });
    assert.ok(profile.interfaceTypes.includes('marketing_site'));
    assert.ok(profile.interfaceTypes.includes('admin_dashboard'));
    assert.equal(profile.dataDensity['marketing_site'], 'low');
    assert.equal(profile.dataDensity['admin_dashboard'], 'high');
  });

  test('target users are extracted as whole-word hits only', () => {
    const profile = profileApp({
      projectName: 'X',
      entries: [{ id: '1', description: 'a dashboard for the architect and the contractor to review quotes' }],
    });
    assert.ok(profile.targetUsers.includes('architect'));
    assert.ok(profile.targetUsers.includes('contractor'));
    assert.ok(!profile.targetUsers.includes('customer'));
  });
});

// ---------------------------------------------------------------------------
// Design Router — pure scoring math (via routeDesign against an in-memory profile; Build Memory
// dimensions degrade to their documented 0.5 neutral default when unobserved, which is exercised
// for real by simply using a brand-new, never-before-seen interfaceType tag combination)
// ---------------------------------------------------------------------------

describe('design-router: routeDesign', () => {
  test('routes a 3D-heavy profile to img2threejs and never offers playwright as a candidate', async () => {
    const profile = profileApp({
      projectName: `router-test-${RUN_ID}`,
      entries: [{ id: '1', name: '3D configurator', description: '3d visualizer product configurator three.js webgl model viewer' }],
    });
    assert.ok(profile.interfaceTypes.length > 0);
    const decision = await routeDesign(profile, '3d_visualizer');

    assert.equal(decision.primaryTool, 'img2threejs');
    assert.equal(decision.validationTool, 'playwright');
    for (const tool of DESIGN_TOOLS) assert.ok(decision.scores[tool], `missing score breakdown for ${tool}`);
    assert.ok(decision.confidencePercent >= 0 && decision.confidencePercent <= 100);
    assert.ok(decision.reasons.length > 0 && decision.reasons.length <= 3);

    const rendered = formatRoutingDecision(decision);
    assert.match(rendered, /PRIMARY TOOL: IMG2THREEJS/);
    assert.match(rendered, /VALIDATION: PLAYWRIGHT/);
  });

  test('an interface type absent from the capability bridge scores every tool at 0 capability/interface match', async () => {
    const profile = profileApp({ projectName: `router-test-${RUN_ID}`, entries: [] });
    const decision = await routeDesign({ ...profile, interfaceTypes: ['totally_unknown_type'] }, 'totally_unknown_type');
    for (const tool of DESIGN_TOOLS) {
      assert.equal(decision.scores[tool]!.capabilityMatch, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Design Memory — pure tag extraction + preference math
// ---------------------------------------------------------------------------

describe('design-memory', () => {
  test('extractTagsFromFeedback matches canonical phrases, case-insensitively', () => {
    const tags = extractTagsFromFeedback('Way too much motion here, and the cards feel cramped.');
    assert.ok(tags.includes('restrained_motion'));
    assert.ok(tags.includes('cramped_cards'));
  });

  test('extractTagsFromFeedback returns [] for empty/unrecognized text', () => {
    assert.deepEqual(extractTagsFromFeedback(''), []);
    assert.deepEqual(extractTagsFromFeedback('   '), []);
    assert.deepEqual(extractTagsFromFeedback('looks fine to me'), []);
  });

  test('every CANONICAL_TAG_PHRASES entry has at least one non-empty phrase', () => {
    for (const [tag, phrases] of Object.entries(CANONICAL_TAG_PHRASES)) {
      assert.ok(phrases.length > 0, `${tag} has no phrases`);
    }
  });

  test('formatPreferences renders the documented "(none recorded yet)" placeholder for empty ledgers', () => {
    const text = formatPreferences({ prefers: [], rejects: [] });
    assert.match(text, /prefers:\n {2}\(none recorded yet\)/);
    assert.match(text, /rejects:\n {2}\(none recorded yet\)/);
  });

  test('getPreferenceScore is neutral (0.5) for tags with zero recorded weight', async () => {
    const score = await getPreferenceScore([`never_recorded_tag_${RUN_ID}`]);
    assert.equal(score, 0.5);
  });

  test('getPreferenceScore is neutral for an empty tag list without touching Build Memory', async () => {
    assert.equal(await getPreferenceScore([]), 0.5);
  });
});

// ---------------------------------------------------------------------------
// Design Tournament — pure direction/spec/similarity math
// ---------------------------------------------------------------------------

describe('design-tournament: pure helpers', () => {
  test('resolveVariantCount clamps to [2, 4] and defaults non-finite input to the max', () => {
    assert.equal(resolveVariantCount(1), 2);
    assert.equal(resolveVariantCount(3), 3);
    assert.equal(resolveVariantCount(10), 4);
    assert.equal(resolveVariantCount(NaN), 4);
  });

  test('buildVariantDirections returns the fixed directions in variance order, never a color-only variant', () => {
    const two = buildVariantDirections(2);
    assert.equal(two.length, 2);
    assert.deepEqual(two.map((d) => d.id), ['a', 'b']);
    assert.equal(buildVariantDirections(4).length, TOURNAMENT_DIRECTIONS.length);
  });

  test('buildVariantSpec suffixes the name and folds structural tags into interactions, not just color', () => {
    const base: ComponentSpec = {
      name: 'InvoiceCard',
      description: 'Shows an invoice summary.',
      props: ['invoiceId'],
      dataSource: null,
      interactions: ['click to expand'],
      accessibility: [],
    };
    const direction = TOURNAMENT_DIRECTIONS[0]!;
    const variant = buildVariantSpec(base, direction);
    assert.equal(variant.name, 'InvoiceCardVariantA');
    assert.match(variant.description, /DESIGN DIRECTION — "Command Center"/);
    assert.ok(variant.interactions.some((i) => i.includes('sidebar_nav')));
    assert.deepEqual(base.interactions, ['click to expand'], 'must not mutate the base spec');
  });

  test('computeTokenJaccardSimilarity is 1.0 for identical code and lower for divergent code', () => {
    const code = 'export function Foo() { return <div>hi</div>; }';
    assert.equal(computeTokenJaccardSimilarity(code, code), 1.0);
    const other = 'export function Bar() { return <span>bye there friend</span>; }';
    const similarity = computeTokenJaccardSimilarity(code, other);
    assert.ok(similarity < 1.0 && similarity >= 0);
  });

  test('computeTokenJaccardSimilarity treats two empty strings as identical (1.0), never divides by zero', () => {
    assert.equal(computeTokenJaccardSimilarity('', ''), 1.0);
  });
});

describe('design-tournament: DesignTournamentEngine.run (injected generator, no screenshotter)', () => {
  test('generates every requested variant, records a generation failure per-variant without aborting the run', async () => {
    const generator: ComponentGeneratorLike = {
      generate: async (spec) => {
        if (spec.name.endsWith('VariantB')) throw new Error('synthetic generation failure');
        const generated: GeneratedComponent = {
          spec,
          code: `export function ${spec.name}() { return null; }`,
          storyCode: '',
          testCode: '',
          filePath: `/tmp/${spec.name}.tsx`,
        };
        return generated;
      },
    };
    const logs: string[] = [];
    const engine = new DesignTournamentEngine({ componentGenerator: generator, variantCount: 2, log: (m) => logs.push(m) });

    const baseSpec: ComponentSpec = {
      name: `TournamentTest${RUN_ID}`,
      description: 'A test component.',
      props: [],
      dataSource: null,
      interactions: [],
      accessibility: [],
    };
    const result = await engine.run(baseSpec, process.cwd(), `build-${RUN_ID}`, `prompt-${RUN_ID}`);

    assert.equal(result.variants.length, 2);
    assert.equal(result.status, 'awaiting_approval');
    const [a, b] = result.variants;
    assert.equal(a!.generationError, null);
    assert.equal(a!.filePath, `/tmp/${baseSpec.name}VariantA.tsx`);
    assert.ok(b!.generationError?.includes('synthetic generation failure'));
    assert.equal(b!.filePath, null);
    // No screenshotter configured -> nothing to score, dimensionsScored stays 0 for every variant.
    assert.equal(a!.dimensionsScored, 0);
    assert.match(result.recommendation, /No variant of .* produced an automated score/);

    const rendered = formatTournamentResult(result);
    assert.match(rendered, /AWAITING HUMAN DESIGN APPROVAL/);
    assert.match(rendered, /GENERATION FAILED: synthetic generation failure/);
  });
});

// ---------------------------------------------------------------------------
// Persistence round-trips against the live local Build Memory SQLite db
// ---------------------------------------------------------------------------

describe('Design Intelligence persistence (live Build Memory)', () => {
  const projectName = `design-intel-selftest-${RUN_ID}`;
  const preferTag = `selftest_prefer_${RUN_ID}`;

  before(() => {
    resetClient();
    const client = getClient();
    assert.ok(client, 'Build Memory client is null — ~/.forge must be writable for this test.');
  });

  after(() => {
    const db = getClient();
    if (!db) return;
    db.prepare('DELETE FROM app_design_profiles WHERE project_name = ?').run(projectName);
    db.prepare('DELETE FROM design_router_decisions WHERE project_name = ?').run(projectName);
    db.prepare('DELETE FROM design_preferences WHERE tag = ?').run(preferTag);
  });

  test('saveAppDesignProfile upserts by project_name; getAppDesignProfile round-trips every field', async () => {
    const profile = profileApp({
      projectName,
      entries: [{ id: '1', name: 'Landing', description: 'marketing site landing page hero section' }],
    });
    const saved = await saveAppDesignProfile(profile);
    assert.ok(saved, 'save returned null — Build Memory write failed');
    assert.equal(saved!.applicationType.primary, profile.applicationType.primary);

    const fetched = await getAppDesignProfile(projectName);
    assert.ok(fetched);
    assert.deepEqual(fetched!.interfaceTypes, profile.interfaceTypes);
    assert.deepEqual(fetched!.brand, profile.brand);

    // Re-save (refresh, not duplicate) — still exactly one row for this project.
    await saveAppDesignProfile({ ...profile, visualComplexity: 'high' });
    const db = getClient()!;
    const count = db.prepare('SELECT COUNT(*) as c FROM app_design_profiles WHERE project_name = ?').get(projectName) as { c: number };
    assert.equal(count.c, 1);
    const refreshed = await getAppDesignProfile(projectName);
    assert.equal(refreshed!.visualComplexity, 'high');
  });

  test('recordPreference + getPreferenceScore reflect a real recorded prefer signal', async () => {
    const before = await getPreferenceScore([preferTag]);
    assert.equal(before, 0.5, 'tag should be neutral before any signal is recorded');

    await recordPreference([preferTag], 'prefer', projectName, `selftest:${RUN_ID}`);
    const after = await getPreferenceScore([preferTag]);
    assert.ok(after > 0.5, `expected a positive lean after recording a prefer signal, got ${after}`);

    // Repeated recording accumulates weight on the same (tag, polarity) row rather than duplicating.
    await recordPreference([preferTag], 'prefer', projectName, `selftest:${RUN_ID}`);
    const db = getClient()!;
    const row = db.prepare('SELECT weight, occurrences FROM design_preferences WHERE tag = ? AND polarity = ?').get(preferTag, 'prefer') as
      | { weight: number; occurrences: number }
      | undefined;
    assert.ok(row);
    assert.equal(row!.weight, 2);
    assert.equal(row!.occurrences, 2);
  });

  test('routeDesign persists a decision row with real per-tool scores', async () => {
    const profile = await getAppDesignProfile(projectName);
    assert.ok(profile);
    const decision = await routeDesign(profile!, profile!.interfaceTypes[0] ?? 'marketing_site', {
      buildRunId: `build-${RUN_ID}`,
      promptId: `prompt-${RUN_ID}`,
    });
    const db = getClient()!;
    const row = db.prepare('SELECT * FROM design_router_decisions WHERE id = ?').get(decision.id) as { primary_tool: string } | undefined;
    assert.ok(row, 'routing decision was not persisted');
    assert.equal(row!.primary_tool, decision.primaryTool);
  });
});
