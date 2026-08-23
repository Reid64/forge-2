/**
 * FORGE 2.0 — Design Pipeline Extras tests: CompositeBuilder, DesignSystemExtractor,
 * TokenConsolidator, DeploymentGate (`src/design-pipeline/{composite-builder,
 * design-system-extractor, token-consolidator, deployment-gate}.ts`).
 *
 * Same two-tier convention as `tests/design-intelligence.test.ts`:
 *   1. Pure/deterministic functions and real-filesystem scans against a scratch temp project
 *      directory (no DB, no network).
 *   2. `deployment-gate.ts`'s `checkDesignApproval` against the LIVE local Build Memory SQLite db
 *      (`~/.forge/forge_memory.db`) — proving the gate actually BLOCKS with no approved
 *      `design_reviews` record and actually PASSES once one exists, since that's a real behavioral
 *      change to the deploy path, not just a scoring function.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCompositeCode, buildComposite, type CompositeSectionSelection } from '../src/design-pipeline/composite-builder.js';
import { extractDesignSystem } from '../src/design-pipeline/design-system-extractor.js';
import {
  consolidateTokens,
  normalizeColorValue,
  normalizeSpacingValue,
  normalizeFontSizeValue,
  normalizeFontFamilyValue,
} from '../src/design-pipeline/token-consolidator.js';
import type { RawTokenFinding } from '../src/design-pipeline/design-system-extractor.js';
import { checkDesignApproval } from '../src/design-pipeline/deployment-gate.js';
import { getClient, resetClient, newId } from '../src/memory/client.js';

const RUN_ID = `${Date.now()}`;

// ---------------------------------------------------------------------------
// CompositeBuilder — pure assembly + real file write (no screenshotter injected)
// ---------------------------------------------------------------------------

describe('composite-builder: assembleCompositeCode', () => {
  test('zero selections produces a valid placeholder component, never throws', () => {
    const code = assembleCompositeCode('EmptyComposite', []);
    assert.match(code, /export function EmptyComposite\(\)/);
    assert.match(code, /return null/);
  });

  test('selections are assembled verbatim, in order, each labeled with its section + source variant', () => {
    const selections: CompositeSectionSelection[] = [
      { sourceVariantId: 'a', sourceVariantLabel: 'Command Center', sectionName: 'header', code: '<Header />' },
      { sourceVariantId: 'd', sourceVariantLabel: 'Minimal Engineering', sectionName: 'body', code: '<Body />' },
    ];
    const code = assembleCompositeCode('PickedComposite', selections);
    assert.match(code, /export function PickedComposite\(\)/);
    assert.match(code, /section: header — from Command Center \(a\)/);
    assert.match(code, /<Header \/>/);
    assert.match(code, /section: body — from Minimal Engineering \(d\)/);
    assert.match(code, /<Body \/>/);
    // Order preserved: header's comment appears before body's.
    assert.ok(code.indexOf('section: header') < code.indexOf('section: body'));
  });

  test('an unsafe component name is sanitized to a valid identifier', () => {
    const code = assembleCompositeCode('My Composite!! 2', []);
    assert.match(code, /export function MyComposite2\(\)/);
  });
});

describe('composite-builder: buildComposite (real file write, no screenshotter)', () => {
  let projectDir: string;

  before(() => {
    projectDir = mkdtempSync(join(tmpdir(), `forge-composite-test-${RUN_ID}-`));
  });

  after(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('writes the composite file and reports zero screenshots when no screenshotter is supplied', async () => {
    const selections: CompositeSectionSelection[] = [
      { sourceVariantId: 'a', sectionName: 'header', code: '<Header />' },
      { sourceVariantId: 'b', sectionName: 'footer', code: '<Footer />' },
      { sourceVariantId: 'a', sectionName: 'aside', code: '<Aside />' },
    ];
    const result = await buildComposite({ componentName: 'TestComposite', selections, projectPath: projectDir });

    assert.equal(result.componentName, 'TestComposite');
    assert.equal(result.sectionCount, 3);
    assert.deepEqual(result.sourceVariantIds.sort(), ['a', 'b']); // deduped
    assert.ok(result.filePath, 'expected a written filePath');
    assert.match(result.filePath!, /TestComposite\.tsx$/);
    assert.equal(result.screenshots.length, 0);
    assert.equal(result.renderError, null); // no screenshotter supplied is not itself an error

    const { readFileSync } = await import('node:fs');
    const onDisk = readFileSync(result.filePath!, 'utf8');
    assert.equal(onDisk, result.code);
    assert.match(onDisk, /<Header \/>/);
    assert.match(onDisk, /<Footer \/>/);
  });

  test('a project path with no writable src/components directory reports a renderError, never throws', async () => {
    // Point at a file (not a directory) as the "project" so mkdirSync must fail.
    const blockerFile = join(projectDir, 'blocker-file');
    writeFileSync(blockerFile, 'x', 'utf8');
    const badProjectPath = join(blockerFile, 'nested'); // parent is a file — mkdirSync recursive must fail

    const result = await buildComposite({
      componentName: 'ShouldFail',
      selections: [{ sourceVariantId: 'a', sectionName: 'x', code: '<X />' }],
      projectPath: badProjectPath,
    });
    assert.equal(result.filePath, null);
    assert.ok(result.renderError, 'expected a renderError explaining the write failure');
  });
});

// ---------------------------------------------------------------------------
// DesignSystemExtractor — real regex scan against a scratch project directory
// ---------------------------------------------------------------------------

describe('design-system-extractor: extractDesignSystem', () => {
  let projectDir: string;

  before(() => {
    projectDir = mkdtempSync(join(tmpdir(), `forge-extractor-test-${RUN_ID}-`));
    mkdirSync(join(projectDir, 'src', 'components'), { recursive: true });
    mkdirSync(join(projectDir, 'src', 'styles'), { recursive: true });

    writeFileSync(
      join(projectDir, 'src', 'components', 'CardA.tsx'),
      `export function CardA() {\n  return <div className="p-4 text-lg" style={{ color: '#3B82F6' }}>A</div>;\n}\n`,
      'utf8'
    );
    writeFileSync(
      join(projectDir, 'src', 'components', 'CardB.tsx'),
      `export function CardB() {\n  return <div className="p-4 text-lg" style={{ color: '#3b82f6' }}>B</div>;\n}\n`,
      'utf8'
    );
    writeFileSync(
      join(projectDir, 'src', 'styles', 'only-here.css'),
      `.solo { padding: 9px; color: #abcdef; font-size: 11px; }\n`,
      'utf8'
    );
  });

  after(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('a value repeated across 2+ distinct files is reported as a finding with correct counts', () => {
    const result = extractDesignSystem(projectDir);
    assert.equal(result.filesScanned, 3);

    const spacing = result.findings.find((f) => f.category === 'spacing' && f.value === 'p-4');
    assert.ok(spacing, 'expected a p-4 spacing finding');
    assert.equal(spacing!.fileCount, 2);
    assert.equal(spacing!.occurrences, 2);

    const typography = result.findings.find((f) => f.category === 'typography' && f.value === 'text-lg');
    assert.ok(typography, 'expected a text-lg typography finding');
    assert.equal(typography!.fileCount, 2);

    // A value that only appears in one file (`only-here.css`) is excluded at the default minFileCount=2.
    assert.ok(!result.findings.some((f) => f.value === '9px'));
    assert.ok(!result.findings.some((f) => f.value === '#abcdef'));
  });

  test('minFileCount: 1 includes every raw occurrence, never dropping single-file values', () => {
    const result = extractDesignSystem(projectDir, { minFileCount: 1 });
    assert.ok(result.findings.some((f) => f.value === '9px'));
    assert.ok(result.findings.some((f) => f.value === '#abcdef'));
    assert.ok(result.findings.some((f) => f.value === '11px'));
  });

  test('a project with no scannable files degrades to an empty findings array, never throws', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), `forge-extractor-empty-${RUN_ID}-`));
    try {
      const result = extractDesignSystem(emptyDir);
      assert.deepEqual(result.findings, []);
      assert.equal(result.filesScanned, 0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// TokenConsolidator — pure normalization + grouping
// ---------------------------------------------------------------------------

describe('token-consolidator: normalization functions', () => {
  test('normalizeColorValue treats hex (any case/length) and rgb() as the same canonical hex', () => {
    assert.equal(normalizeColorValue('#3B82F6'), '#3b82f6');
    assert.equal(normalizeColorValue('#3b82f6'), '#3b82f6');
    assert.equal(normalizeColorValue('rgb(59, 130, 246)'), '#3b82f6');
    assert.equal(normalizeColorValue('rgba(59, 130, 246, 0.5)'), '#3b82f6');
    assert.equal(normalizeColorValue('#39f'), '#3399ff');
    assert.equal(normalizeColorValue('not-a-color'), null);
  });

  test('normalizeSpacingValue reconciles Tailwind classes, CSS px, and CSS rem at a 16px base', () => {
    assert.equal(normalizeSpacingValue('p-4'), 16);
    assert.equal(normalizeSpacingValue('16px'), 16);
    assert.equal(normalizeSpacingValue('1rem'), 16);
    assert.equal(normalizeSpacingValue('gap-x-2'), 8);
    assert.equal(normalizeSpacingValue('space-y-px'), 1);
    assert.equal(normalizeSpacingValue('50%'), null);
    assert.equal(normalizeSpacingValue('not-spacing'), null);
  });

  test('normalizeFontSizeValue reconciles Tailwind text-* classes with raw CSS lengths', () => {
    assert.equal(normalizeFontSizeValue('text-lg'), 18);
    assert.equal(normalizeFontSizeValue('18px'), 18);
    assert.equal(normalizeFontSizeValue('text-base'), 16);
    assert.equal(normalizeFontSizeValue('1rem'), 16);
  });

  test('normalizeFontFamilyValue extracts + lowercases the first family in a stack, and maps Tailwind generics', () => {
    assert.equal(normalizeFontFamilyValue(`'Inter', sans-serif`), 'inter');
    assert.equal(normalizeFontFamilyValue('Inter, sans-serif'), 'inter');
    assert.equal(normalizeFontFamilyValue('font-sans'), 'sans-serif');
    assert.equal(normalizeFontFamilyValue('font-mono'), 'monospace');
    assert.equal(normalizeFontFamilyValue(''), null);
  });
});

describe('token-consolidator: consolidateTokens', () => {
  test('near-identical color/spacing values from different findings merge into one token with summed counts', () => {
    const findings: RawTokenFinding[] = [
      { value: '#3B82F6', category: 'color', occurrences: 2, files: ['a.tsx', 'b.tsx'], fileCount: 2 },
      { value: '#3b82f6', category: 'color', occurrences: 1, files: ['c.tsx'], fileCount: 1 },
      { value: 'rgb(59, 130, 246)', category: 'color', occurrences: 1, files: ['d.tsx'], fileCount: 1 },
      { value: 'p-4', category: 'spacing', occurrences: 3, files: ['a.tsx', 'b.tsx'], fileCount: 2 },
      { value: '16px', category: 'spacing', occurrences: 1, files: ['e.tsx'], fileCount: 1 },
    ];
    const result = consolidateTokens(findings);

    const colorToken = result.tokens.find((t) => t.category === 'color' && t.canonicalValue === '#3b82f6');
    assert.ok(colorToken, 'expected a consolidated #3b82f6 color token');
    assert.equal(colorToken!.totalOccurrences, 4);
    assert.equal(colorToken!.totalFileCount, 4);
    assert.deepEqual(colorToken!.originalValues.sort(), ['#3B82F6', '#3b82f6', 'rgb(59, 130, 246)'].sort());

    const spacingToken = result.tokens.find((t) => t.category === 'spacing' && t.canonicalValue === '16px');
    assert.ok(spacingToken, 'expected a consolidated 16px spacing token');
    assert.equal(spacingToken!.totalOccurrences, 4);
    assert.equal(spacingToken!.totalFileCount, 3);

    assert.equal(result.inputFindingCount, 5);
    assert.equal(result.consolidatedCount, 2);
  });

  test('an unrecognized value is never dropped — it is consolidated under its own raw-value group', () => {
    const findings: RawTokenFinding[] = [
      { value: 'not-a-real-color-or-anything', category: 'color', occurrences: 1, files: ['a.tsx'], fileCount: 1 },
    ];
    const result = consolidateTokens(findings);
    assert.equal(result.tokens.length, 1);
    assert.equal(result.tokens[0]!.canonicalValue, 'not-a-real-color-or-anything');
    assert.equal(result.tokens[0]!.totalOccurrences, 1);
  });

  test('tokens are sorted by totalOccurrences descending', () => {
    const findings: RawTokenFinding[] = [
      { value: '#111111', category: 'color', occurrences: 1, files: ['a.tsx'], fileCount: 1 },
      { value: '#222222', category: 'color', occurrences: 5, files: ['a.tsx', 'b.tsx'], fileCount: 2 },
    ];
    const result = consolidateTokens(findings);
    assert.equal(result.tokens[0]!.canonicalValue, '#222222');
    assert.equal(result.tokens[1]!.canonicalValue, '#111111');
  });

  test('an empty findings array degrades to an empty token list, never throws', () => {
    const result = consolidateTokens([]);
    assert.deepEqual(result.tokens, []);
    assert.equal(result.inputFindingCount, 0);
    assert.equal(result.consolidatedCount, 0);
  });
});

// ---------------------------------------------------------------------------
// DeploymentGate — checkDesignApproval against the LIVE local Build Memory SQLite db
// ---------------------------------------------------------------------------

describe('deployment-gate: checkDesignApproval (live Build Memory) — real deploy-blocking behavior', () => {
  const projectPath = `/forge-selftest/deployment-gate-${RUN_ID}`;
  const buildRunId = `build-deploygate-${RUN_ID}`;

  before(() => {
    resetClient();
    const db = getClient();
    assert.ok(db, 'Build Memory client is null — ~/.forge must be writable for this test.');
    db!.prepare(`INSERT INTO build_runs (id, project_name, project_path, machine_id) VALUES (?, ?, ?, ?)`).run(
      buildRunId,
      `deploygate-selftest-${RUN_ID}`,
      projectPath,
      'test-machine'
    );
  });

  after(() => {
    const db = getClient();
    if (!db) return;
    db.prepare('DELETE FROM design_reviews WHERE build_run_id = ?').run(buildRunId);
    db.prepare('DELETE FROM build_runs WHERE id = ?').run(buildRunId);
  });

  test('BLOCKS: a project with zero design_reviews records is not approved', async () => {
    const result = await checkDesignApproval(projectPath);
    assert.equal(result.approved, false);
    assert.match(result.reason, /DEPLOY BLOCKED/);
    assert.match(result.reason, /no design_reviews records exist/);
    assert.equal(result.approvedReviewCount, 0);
    assert.equal(result.totalReviewCount, 0);
    assert.equal(result.latestApprovedAt, null);
  });

  test('still BLOCKS: design_reviews records exist but none is approved', async () => {
    const db = getClient()!;
    db.prepare(
      `INSERT INTO design_reviews (id, build_run_id, prompt_id, component_name, human_approved, auto_approved, created_at)
       VALUES (@id, @build_run_id, @prompt_id, @component_name, @human_approved, @auto_approved, @created_at)`
    ).run({
      id: newId(),
      build_run_id: buildRunId,
      prompt_id: `prompt-${RUN_ID}`,
      component_name: 'RejectedCard',
      human_approved: 0,
      auto_approved: 0,
      created_at: new Date().toISOString(),
    });

    const result = await checkDesignApproval(projectPath);
    assert.equal(result.approved, false);
    assert.match(result.reason, /DEPLOY BLOCKED/);
    assert.match(result.reason, /none is approved/);
    assert.equal(result.approvedReviewCount, 0);
    assert.equal(result.totalReviewCount, 1);
  });

  test('PASSES: once an approved design_reviews record exists for the project', async () => {
    const db = getClient()!;
    const approvedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO design_reviews (id, build_run_id, prompt_id, component_name, human_approved, auto_approved, created_at)
       VALUES (@id, @build_run_id, @prompt_id, @component_name, @human_approved, @auto_approved, @created_at)`
    ).run({
      id: newId(),
      build_run_id: buildRunId,
      prompt_id: `prompt-${RUN_ID}`,
      component_name: 'ApprovedCard',
      human_approved: 1,
      auto_approved: 0,
      created_at: approvedAt,
    });

    const result = await checkDesignApproval(projectPath);
    assert.equal(result.approved, true);
    assert.equal(result.approvedReviewCount, 1);
    assert.equal(result.totalReviewCount, 2); // the earlier rejected row is still on record
    assert.equal(result.latestApprovedAt, approvedAt);
    assert.match(result.reason, /1\/2 design_reviews record\(s\) approved/);
  });

  test('a project path with no build_runs at all has zero matching design_reviews (join yields nothing) — blocked', async () => {
    const result = await checkDesignApproval(`/forge-selftest/never-built-${RUN_ID}`);
    assert.equal(result.approved, false);
    assert.equal(result.totalReviewCount, 0);
  });
});
