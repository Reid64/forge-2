// FORGE 2.0 — Session 2 verification: prove the design-system pipeline is wired
// end-to-end. Redirects USERPROFILE/HOME to a temp dir (same trick as
// verify-memory.mjs) so this never touches the real ~/.forge/forge_memory.db.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'forge-design-wiring-verify-'));
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const { initializeForgeMemory } = await import('../dist/learning/database.js');
const { createBrand, getBrandByProject } = await import('../dist/memory/brands.js');
const { deriveBrandFromBaseline } = await import('../dist/tools/brand-inheritance.js');
const { buildQueueEntries } = await import('../dist/engine/queue-generator.js');
const { GOVERNANCE_DOC_NAMES } = await import('../dist/phases/phase3-executor.js');

let failed = false;
function assert(cond, message) {
  if (!cond) {
    failed = true;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`PASS: ${message}`);
  }
}

function minimalArchitectureDesign() {
  return {
    projectName: 'design-wiring-verify',
    database: { tables: [], indexes: [], rlsPolicies: [], seeds: [], migrations: [], markdown: '' },
    api: { routes: [], conventions: [], markdown: '' },
    frontend: {
      pages: [
        {
          path: '/home',
          name: 'Home',
          purpose: 'Landing page',
          components: [],
          apiCalls: [],
          authRequired: false,
          roles: [],
          immutable: false,
        },
      ],
      components: [],
      layouts: [],
      designTokens: { colors: {}, typography: {}, spacing: {}, radii: {}, shadows: {} },
      responsiveStrategy: '',
      markdown: '',
    },
    interactionMaps: { maps: [], markdown: '' },
    auth: { flows: [], roles: [], middleware: '', multiTenancy: '', permissionsModel: '', markdown: '' },
    agents: { agents: [], orchestration: '', markdown: '' },
    infra: { environments: [], deployConfig: '', monitoring: '', performanceBudgets: [], markdown: '' },
    testing: { playwrightSpecs: [], apiTests: [], sixLawsPlan: [], markdown: '' },
    crossValidation: [],
    constrained: false,
    designSystemGenerated: true,
    designSystemPath: null,
    architecturePath: null,
    model: 'test',
    tokensInput: 0,
    tokensOutput: 0,
    usedFallback: false,
    fallbackArtifacts: [],
    warnings: [],
    gate: { name: 'Gate 2', status: 'awaiting_human_approval', detail: 'test' },
    adversaryReview: null,
    governanceDocs: {},
    generatedAt: new Date(0).toISOString(),
  };
}

try {
  initializeForgeMemory();

  // (a) brand roundtrip: createBrand → getBrandByProject.
  const created = await createBrand({
    project_name: 'baseline-project',
    brand_name: 'baseline-project',
    design_tokens: {
      markdown: '# Baseline design system',
      productType: 'fintech dashboard',
      generatedAt: new Date(0).toISOString(),
      tokens: {
        colors: { primary: '#123456', accent: '#abcdef' },
        typography: { display: 'Fraunces', body: 'Inter' },
        spacing: { sm: '4px', md: '8px' },
        radii: {},
        shadows: {},
      },
    },
  });
  assert(created !== null, 'createBrand returned a row (not null)');

  const fetched = await getBrandByProject('baseline-project');
  assert(fetched !== null, 'getBrandByProject roundtrip returned a row');
  assert(fetched?.project_name === 'baseline-project', 'getBrandByProject returned the same project_name');
  assert(
    fetched?.design_tokens?.tokens?.colors?.primary === '#123456',
    'getBrandByProject roundtrip preserved nested structured tokens'
  );

  // (b) deriveBrandFromBaseline with overrides — assert the merge.
  const derived = await deriveBrandFromBaseline('baseline-project', 'new-project', {
    colors: { primary: '#ff0000' }, // override an existing key
  });
  assert(derived.baselineFound === true, 'deriveBrandFromBaseline found the baseline brand');
  assert(derived.tokens.colors.primary === '#ff0000', 'deriveBrandFromBaseline override wins for an overridden key');
  assert(derived.tokens.colors.accent === '#abcdef', 'deriveBrandFromBaseline preserves a non-overridden baseline key');
  assert(derived.tokens.typography.display === 'Fraunces', 'deriveBrandFromBaseline preserves an untouched bucket');
  assert(derived.baselineProductType === 'fintech dashboard', 'deriveBrandFromBaseline surfaces the baseline product-type query');

  const derivedMissing = await deriveBrandFromBaseline('no-such-project', 'new-project-2', { colors: { primary: '#000000' } });
  assert(derivedMissing.baselineFound === false, 'deriveBrandFromBaseline reports baselineFound:false for a missing baseline');
  assert(derivedMissing.tokens.colors.primary === '#000000', 'deriveBrandFromBaseline still applies overrides with no baseline');

  // (c) queue-generator: UI entries carry both the design skills and DESIGN_SYSTEM.md.
  const entries = buildQueueEntries(minimalArchitectureDesign());
  const uiEntries = entries.filter((e) => e.prompt_type === 'ui' || e.prompt_type === 'feature');
  assert(uiEntries.length > 0, `synthetic design produced at least one UI-producing entry (got ${uiEntries.length})`);
  for (const e of uiEntries) {
    assert(
      Array.isArray(e.skills) && e.skills.includes('frontend-design') && e.skills.includes('ui-ux-pro-max'),
      `entry "${e.id}" (${e.prompt_type}) declares skills: frontend-design + ui-ux-pro-max (got ${JSON.stringify(e.skills)})`
    );
    assert(
      e.governance_refs.includes('DESIGN_SYSTEM.md'),
      `entry "${e.id}" (${e.prompt_type}) references DESIGN_SYSTEM.md in governance_refs (got ${JSON.stringify(e.governance_refs)})`
    );
  }
  const nonUiEntries = entries.filter((e) => e.prompt_type !== 'ui' && e.prompt_type !== 'feature');
  const nonUiLeaked = nonUiEntries.filter((e) => e.skills && e.skills.includes('frontend-design'));
  assert(nonUiLeaked.length === 0, `non-UI entries do not carry the UI design skills (${nonUiLeaked.length} leaked)`);

  // (d) GOVERNANCE_DOC_NAMES includes DESIGN_SYSTEM.md.
  assert(
    Array.isArray(GOVERNANCE_DOC_NAMES) && GOVERNANCE_DOC_NAMES.includes('DESIGN_SYSTEM.md'),
    `GOVERNANCE_DOC_NAMES includes DESIGN_SYSTEM.md (got ${JSON.stringify(GOVERNANCE_DOC_NAMES)})`
  );
} finally {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

if (failed) {
  console.error('\nverify-design-wiring: FAILED');
  process.exitCode = 1;
} else {
  console.log('\nverify-design-wiring: ALL CHECKS PASSED');
}
