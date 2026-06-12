/**
 * FORGE 2.0 — PDF Generator tests.
 *
 * Pure `node:test`: no network, no DB. Real `pdf-lib` is exercised end-to-end so the layout
 * engine actually produces valid PDF bytes (we assert the `%PDF` magic + a plausible page
 * count), and a real OS temp dir verifies the on-disk write path. The pure helpers
 * (hexToRgb, parseDesignSystemColors, markdownToBlocks, wrapText) are unit-tested directly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hexToRgb,
  parseDesignSystemColors,
  markdownToBlocks,
  wrapText,
  loadBrandTokens,
  renderPdf,
  generateBuildReportPdf,
  generateGovernancePdf,
  generateGrantNarrativePdf,
  generateBoardReportPdf,
  generateAuditReportPdf,
  type BuildReportData,
} from '../src/tools/pdf-generator.js';

const PDF_MAGIC = '%PDF';

/** Decode the first 8 bytes as ASCII to check the PDF magic header. */
function magic(bytes: Uint8Array): string {
  return Buffer.from(bytes.slice(0, 8)).toString('latin1');
}

// --- pure helpers ----------------------------------------------------------

test('hexToRgb parses #rrggbb and #rgb, rejects junk', () => {
  const blue = hexToRgb('#2563EB');
  assert.ok(blue);
  assert.ok(Math.abs(blue!.red - 0x25 / 255) < 1e-6);
  assert.ok(Math.abs(blue!.green - 0x63 / 255) < 1e-6);
  const short = hexToRgb('#fff');
  assert.ok(short);
  assert.equal(short!.red, 1);
  assert.equal(hexToRgb('not-a-color'), null);
  assert.equal(hexToRgb('#12'), null);
});

test('parseDesignSystemColors prefers labelled colors, else first distinct hexes', () => {
  const labelled = parseDesignSystemColors('Primary: #112233\nSecondary color #445566');
  assert.ok(labelled);
  assert.equal(labelled!.primary, '#112233');
  assert.equal(labelled!.secondary, '#445566');

  const unlabelled = parseDesignSystemColors('Some palette: #aabbcc then #ddeeff and #aabbcc again');
  assert.ok(unlabelled);
  assert.equal(unlabelled!.primary, '#aabbcc');
  assert.equal(unlabelled!.secondary, '#ddeeff');

  assert.equal(parseDesignSystemColors('no colors here'), null);
});

test('markdownToBlocks handles headings, bullets, tables, rules, paragraphs', () => {
  const md = [
    '# Title',
    '',
    'A paragraph of **bold** and `code`.',
    '',
    '## Section',
    '- one',
    '- two',
    '',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '---',
    '',
    'End.',
  ].join('\n');
  const blocks = markdownToBlocks(md);
  const kinds = blocks.map((b) => b.kind);
  assert.ok(kinds.includes('heading'));
  assert.ok(kinds.includes('bullets'));
  assert.ok(kinds.includes('table'));
  assert.ok(kinds.includes('divider'));
  const table = blocks.find((b) => b.kind === 'table');
  assert.ok(table && table.kind === 'table');
  assert.deepEqual(table.columns, ['A', 'B']);
  assert.deepEqual(table.rows, [['1', '2']]); // separator row dropped
  const para = blocks.find((b) => b.kind === 'paragraph');
  assert.ok(para && para.kind === 'paragraph');
  assert.match(para.text, /bold and code/); // inline markdown stripped
});

test('wrapText wraps on width and hard-breaks overlong words', () => {
  // measure = 1 unit per char.
  const measure = (s: string): number => s.length;
  const lines = wrapText('the quick brown fox', 9, measure);
  assert.ok(lines.every((l) => l.length <= 9));
  assert.ok(lines.length >= 2);

  const hard = wrapText('superlongunbreakableword', 5, measure);
  assert.ok(hard.length > 1);
  assert.ok(hard.every((l) => l.length <= 5));

  assert.deepEqual(wrapText('a\nb', 100, measure), ['a', 'b']); // explicit newline
});

test('loadBrandTokens precedence: inline overrides design-system', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-pdf-brand-'));
  const gov = join(dir, 'governance');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(gov, { recursive: true });
  await writeFile(join(gov, 'DESIGN_SYSTEM.md'), '# Acme\nPrimary: #102030', 'utf8');

  const fromDs = await loadBrandTokens({ projectPath: dir });
  assert.equal(fromDs.source, 'design-system');
  assert.ok(Math.abs(fromDs.tokens.primary.red - 0x10 / 255) < 1e-6);

  const overridden = await loadBrandTokens({ projectPath: dir, brand: { primary: '#ffffff', brandName: 'Inline' } });
  assert.equal(overridden.source, 'inline');
  assert.equal(overridden.tokens.primary.red, 1);
  assert.equal(overridden.tokens.brandName, 'Inline');

  const missing = await loadBrandTokens({ projectPath: join(dir, 'nope') });
  assert.equal(missing.source, 'default');
  assert.ok(missing.warnings.length >= 1);
});

// --- end-to-end PDF generation --------------------------------------------

const BUILD: BuildReportData = {
  build: {
    id: 'build-123',
    project_name: 'Benavora',
    status: 'completed',
    started_at: '2026-06-11T10:00:00.000Z',
    completed_at: '2026-06-11T10:42:00.000Z',
    total_prompts: 12,
    completed_prompts: 12,
    failed_prompts: 0,
    total_errors: 1,
    total_tokens: 482000,
    total_cost_usd: 7.4213,
    machine_id: 'reid-workstation',
  },
  gates: [
    { name: 'tsc --noEmit', passed: true, detail: '0 errors' },
    { name: 'build', passed: true },
    { name: 'lint', passed: false, detail: '2 warnings treated as fail' },
  ],
  prompts: [
    { index: 1, name: 'schema-creation', status: 'completed' },
    { index: 2, name: 'auth-setup', status: 'completed' },
  ],
  notes: 'Build completed with one auto-recovered dependency error.',
};

test('generateBuildReportPdf produces a valid multi-page PDF and writes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-pdf-out-'));
  const outputPath = join(dir, 'reports', 'build.pdf');
  const result = await generateBuildReportPdf(BUILD, { outputPath, log: () => {} });
  assert.equal(magic(result.bytes), PDF_MAGIC);
  assert.ok(result.pageCount >= 1);
  assert.equal(result.outputPath, outputPath);
  const onDisk = await readFile(outputPath);
  assert.ok(onDisk.length > 0);
  assert.equal(magic(onDisk), PDF_MAGIC);
});

test('table of contents reserves front pages (more pages than without)', async () => {
  const blocks = Array.from({ length: 30 }, (_, i) => ({
    kind: 'heading' as const,
    level: 1 as const,
    text: `Section ${i + 1}`,
  }));
  const withToc = await renderPdf({ title: 'T', blocks }, { tableOfContents: true, log: () => {} });
  const without = await renderPdf({ title: 'T', blocks }, { tableOfContents: false, log: () => {} });
  assert.equal(magic(withToc.bytes), PDF_MAGIC);
  assert.ok(withToc.pageCount > without.pageCount);
});

test('grant narrative renders submission-ready with header/footer (no throw)', async () => {
  const result = await generateGrantNarrativePdf(
    {
      organization: 'Repvg Foundation',
      projectTitle: 'Community Solar Initiative',
      funder: 'State Energy Office',
      amountRequested: '$250,000',
      submissionDate: '2026-07-01',
      contact: { name: 'Reid Whitesides', email: 'reid@repvg.com' },
      sections: [
        { heading: 'Executive Summary', body: 'A '.repeat(400) },
        { heading: 'Statement of Need', body: 'Need '.repeat(400) },
      ],
    },
    { log: () => {} }
  );
  assert.equal(magic(result.bytes), PDF_MAGIC);
  assert.ok(result.pageCount >= 2);
});

test('governance, board, and audit reports all produce valid PDFs', async () => {
  const gov = await generateGovernancePdf('BLUEPRINT.md', '# BLUEPRINT\n\n## Identity\n\nFORGE.\n\n- a\n- b', {
    log: () => {},
  });
  assert.equal(magic(gov.bytes), PDF_MAGIC);

  const board = await generateBoardReportPdf(
    {
      organization: 'Repvg',
      period: 'Q2 2026',
      preparedBy: 'Reid',
      metrics: [
        { label: 'Revenue', value: '$1.2M', status: 'success' },
        { label: 'Churn', value: '4.1%', status: 'warning' },
      ],
      sections: [{ heading: 'Highlights', bullets: ['Shipped FORGE 2.0', 'Onboarded 3 projects'] }],
    },
    { log: () => {} }
  );
  assert.equal(magic(board.bytes), PDF_MAGIC);

  const audit = await generateAuditReportPdf(
    {
      subject: 'FORGE Build Memory',
      auditor: 'Security Scanner',
      date: '2026-06-11',
      scope: 'RLS + secrets',
      summary: 'One critical, one warning.',
      findings: [
        { id: 'F-1', title: 'Exposed key', severity: 'danger', detail: 'In log', recommendation: 'Rotate.' },
        { id: 'F-2', title: 'Missing index', severity: 'warning' },
      ],
    },
    { log: () => {} }
  );
  assert.equal(magic(audit.bytes), PDF_MAGIC);
});

test('renderPdf never throws and reports the brand source in warnings flow', async () => {
  // A spec with every block kind, no output path.
  const result = await renderPdf(
    {
      title: 'Kitchen Sink',
      subtitle: 'every block kind',
      blocks: [
        { kind: 'heading', level: 1, text: 'H1' },
        { kind: 'heading', level: 2, text: 'H2' },
        { kind: 'heading', level: 3, text: 'H3' },
        { kind: 'paragraph', text: 'p '.repeat(50) },
        { kind: 'bullets', items: ['x', 'y'] },
        { kind: 'keyValues', rows: [{ label: 'k', value: 'v', status: 'info' }] },
        { kind: 'status', label: 'OK', status: 'success', detail: 'all good' },
        { kind: 'table', columns: ['c1', 'c2'], rows: [['1', '2']] },
        { kind: 'divider' },
        { kind: 'spacer', size: 20 },
        { kind: 'pageBreak' },
        { kind: 'paragraph', text: 'after break' },
      ],
    },
    { log: () => {} }
  );
  assert.equal(magic(result.bytes), PDF_MAGIC);
  assert.ok(result.pageCount >= 2);
  assert.equal(result.outputPath, null);
});
