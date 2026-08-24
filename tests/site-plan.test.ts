/**
 * FORGE 2.0 — Site Page Plan tests (`src/design-pipeline/site-plan.ts`).
 *
 * Pure `node:test`. `derivePagePlan`'s Claude Code CLI call is injected (`runClaudeImpl` —
 * mirrors `DecisionValidator`'s own injectable-collaborator house pattern) so these tests never
 * shell out to a real `claude` process.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/site-plan.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { derivePagePlan, slugify, slugToPascalCase } from '../src/design-pipeline/site-plan.js';

function fakeRun(stdout: string, overrides: Partial<{ success: boolean; timedOut: boolean; exitCode: number | null; stderr: string }> = {}) {
  return async () => ({ success: true, stdout, timedOut: false, exitCode: 0, stderr: '', ...overrides });
}

// ---------------------------------------------------------------------------
// slugify / slugToPascalCase
// ---------------------------------------------------------------------------

test('slugify: lowercases, hyphenates, strips non-alphanumerics', () => {
  assert.equal(slugify('Funding Intelligence'), 'funding-intelligence');
  assert.equal(slugify('  Platform Overview!! '), 'platform-overview');
  assert.equal(slugify('AI-Grant-Writer'), 'ai-grant-writer');
});

test('slugify: empty/unusable input degrades to "page", never throws or returns empty', () => {
  assert.equal(slugify(''), 'page');
  assert.equal(slugify('!!!'), 'page');
});

test('slugToPascalCase: converts hyphenated slugs to PascalCase', () => {
  assert.equal(slugToPascalCase('funding-intelligence'), 'FundingIntelligence');
  assert.equal(slugToPascalCase('home'), 'Home');
});

test('slugToPascalCase: empty input degrades to "Page", never throws or returns empty', () => {
  assert.equal(slugToPascalCase(''), 'Page');
});

// ---------------------------------------------------------------------------
// derivePagePlan — real extraction path (injected fake CLI call)
// ---------------------------------------------------------------------------

test('derivePagePlan: a well-formed extraction response produces the exact page list', async () => {
  const json = JSON.stringify({
    pages: [
      { slug: 'home', title: 'Home', kind: 'hub', parentSlug: null, sections: [], note: '' },
      {
        slug: 'platform',
        title: 'Platform overview',
        kind: 'hub',
        parentSlug: null,
        sections: [],
        note: '',
      },
      {
        slug: 'funding-intelligence',
        title: 'Funding Intelligence',
        kind: 'sub',
        parentSlug: 'platform',
        sections: ['hero', 'demo', 'comparison', 'capabilities', 'how it works', 'sample output', 'related', 'faq', 'cta'],
        note: '',
      },
    ],
  });
  const plan = await derivePagePlan('a brief', '/tmp/project', { runClaudeImpl: fakeRun(json), log: () => {} });

  assert.equal(plan.source, 'llm-extracted');
  assert.equal(plan.pages.length, 3);
  assert.deepEqual(plan.pages.map((p) => p.slug).sort(), ['funding-intelligence', 'home', 'platform']);
  const fi = plan.pages.find((p) => p.slug === 'funding-intelligence')!;
  assert.equal(fi.kind, 'sub');
  assert.equal(fi.parentSlug, 'platform');
  assert.equal(fi.sections.length, 9);
  assert.equal(fi.name, 'FundingIntelligence');
});

test('derivePagePlan: dedupes a repeated slug, keeping the first occurrence and warning', async () => {
  const json = JSON.stringify({
    pages: [
      { slug: 'home', title: 'Home v1', kind: 'hub', sections: [], note: '' },
      { slug: 'home', title: 'Home v2 (duplicate)', kind: 'hub', sections: [], note: '' },
    ],
  });
  const plan = await derivePagePlan('a brief', '/tmp/project', { runClaudeImpl: fakeRun(json), log: () => {} });

  assert.equal(plan.pages.length, 1);
  assert.equal(plan.pages[0]!.title, 'Home v1');
  assert.ok(plan.warnings.some((w) => w.includes('duplicate slug')));
});

test('derivePagePlan: a page entry missing both slug and title is skipped with a warning, not a crash', async () => {
  const json = JSON.stringify({
    pages: [
      { title: 'Home', kind: 'hub', sections: [], note: '' },
      { kind: 'hub', sections: [], note: '' }, // unusable — no slug, no title
    ],
  });
  const plan = await derivePagePlan('a brief', '/tmp/project', { runClaudeImpl: fakeRun(json), log: () => {} });

  assert.equal(plan.pages.length, 1);
  assert.equal(plan.pages[0]!.slug, 'home');
  assert.ok(plan.warnings.some((w) => w.includes('no slug or title')));
});

// ---------------------------------------------------------------------------
// Fallback degrade path (Contract 4 — never throws, never fabricates a page list)
// ---------------------------------------------------------------------------

test('derivePagePlan: a failed CLI call degrades to a single synthetic Home page carrying the whole brief', async () => {
  const plan = await derivePagePlan('THE FULL BRIEF TEXT', '/tmp/project', {
    runClaudeImpl: fakeRun('', { success: false, exitCode: 1 }),
    log: () => {},
  });

  assert.equal(plan.source, 'fallback-single-page');
  assert.equal(plan.pages.length, 1);
  assert.equal(plan.pages[0]!.slug, 'home');
  assert.equal(plan.pages[0]!.note, 'THE FULL BRIEF TEXT');
});

test('derivePagePlan: a response with no parseable JSON degrades to fallback, never throws', async () => {
  const plan = await derivePagePlan('a brief', '/tmp/project', {
    runClaudeImpl: fakeRun('I cannot help with that.'),
    log: () => {},
  });
  assert.equal(plan.source, 'fallback-single-page');
  assert.equal(plan.pages.length, 1);
});

test('derivePagePlan: a response with an empty "pages" array degrades to fallback', async () => {
  const plan = await derivePagePlan('a brief', '/tmp/project', {
    runClaudeImpl: fakeRun(JSON.stringify({ pages: [] })),
    log: () => {},
  });
  assert.equal(plan.source, 'fallback-single-page');
});

test('derivePagePlan: a thrown runClaudeImpl degrades to fallback rather than propagating', async () => {
  const plan = await derivePagePlan('a brief', '/tmp/project', {
    runClaudeImpl: async () => {
      throw new Error('spawn failure');
    },
    log: () => {},
  });
  assert.equal(plan.source, 'fallback-single-page');
});

test('derivePagePlan: an empty brief degrades to fallback without even attempting a CLI call', async () => {
  let called = false;
  const plan = await derivePagePlan('   ', '/tmp/project', {
    runClaudeImpl: async () => {
      called = true;
      return { success: true, stdout: '{}', timedOut: false, exitCode: 0, stderr: '' };
    },
    log: () => {},
  });
  assert.equal(plan.source, 'fallback-single-page');
  assert.equal(called, false);
});
