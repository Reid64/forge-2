/**
 * FORGE 2.0 — Project Autopsy unit test (Sprint 7, s7-p03).
 *
 * The autopsy reads a real directory tree, so this suite materializes a small
 * FAILED project in an `os.tmpdir()` mkdtemp dir, runs `runProjectAutopsy` against
 * it (no database, no `claude`, no git — the schema extractor reads the migration
 * file from disk and no live `sql`/`supabase` is supplied), and asserts the file
 * verdicts, intent, diagnosis, salvage assessment, reconstruction inputs, and the
 * Phase 1A adapter. A second case covers the empty/greenfield directory.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/autopsy.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  runProjectAutopsy,
  autopsyToPhase1aInput,
  renderAutopsyReportMarkdown,
  type AutopsyReport,
  type FileVerdict,
} from '../src/tools/project-autopsy.js';

// ---------------------------------------------------------------------------
// Fixture project
// ---------------------------------------------------------------------------

/** Write `content` to `<root>/<rel>`, creating parent directories. */
function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** Materialize a small, deliberately-broken project and return its root path. */
function makeDeadProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-autopsy-'));

  writeFile(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'acme-app',
        dependencies: {
          next: '14.0.0',
          '@supabase/supabase-js': '2.0.0',
          stripe: '14.0.0', // declared but never imported → broken integration
        },
      },
      null,
      2
    )
  );

  writeFile(
    root,
    'README.md',
    [
      '# Acme App',
      '',
      'A scheduling app for booking appointments and sending reminders.',
      '',
      '## Features',
      '- Booking calendar',
      '- Reminder notifications',
      '- Telephony integration',
    ].join('\n')
  );

  writeFile(
    root,
    'migrations/001_init.sql',
    ['create table users (', '  id uuid primary key default gen_random_uuid(),', '  email text not null', ');'].join('\n')
  );

  // KEEP — clean code, no issues.
  writeFile(
    root,
    'src/lib/good.ts',
    [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      'export function sub(a: number, b: number): number {',
      '  return a - b;',
      '}',
    ].join('\n')
  );

  // DISCARD — over half the file is commented-out code.
  writeFile(
    root,
    'src/lib/broken.ts',
    [
      '// const x = 1;',
      '// function old() {',
      '//   return x + 2;',
      '// }',
      '// export const dead = old();',
      '// let y = 3;',
      '// y = y + 1;',
      '// const z = y * 2;',
      'export const stillHere = 1;',
    ].join('\n')
  );

  // DISCARD — no declarations, only placeholders/TODOs (a stub).
  writeFile(
    root,
    'src/lib/stub.ts',
    [
      '// Onboarding flow — coming soon.',
      '// TODO: build the multi-step wizard here.',
      '// Nothing implemented yet.',
      '// Placeholder file.',
    ].join('\n')
  );

  // REFACTOR — real structure but a TODO, an unused import, and an empty body.
  writeFile(
    root,
    'src/lib/messy.ts',
    [
      "import { unusedThing } from './good.js';",
      "import { add } from './good.js';",
      '',
      '// TODO: handle errors',
      'export function compute(a: number): number {',
      '  return add(a, 1);',
      '}',
      '',
      'export function notDone(): void {}',
    ].join('\n')
  );

  // DISCARD asset — mock data file in the source tree.
  writeFile(root, 'src/data/mock-users.json', '[{ "id": 1, "name": "Test" }]');

  // KEEP — route pages.
  writeFile(root, 'app/page.tsx', 'export default function Home() {\n  return <main>Home</main>;\n}');
  writeFile(root, 'app/dashboard/page.tsx', 'export default function Dashboard() {\n  return <main>Dashboard</main>;\n}');

  return root;
}

/** Index verdicts by file path for assertions. */
function verdictMap(report: AutopsyReport): Map<string, FileVerdict> {
  const map = new Map<string, FileVerdict>();
  for (const v of report.salvageAssessment.files) map.set(v.file, v);
  return map;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('autopsy classifies files, infers intent, diagnoses failure, and feeds Phase 1A', async () => {
  const root = makeDeadProject();
  try {
    const report = await runProjectAutopsy(root, { log: () => {} });

    assert.equal(report.salvageable, true);

    // --- File classification ---
    const vs = verdictMap(report);
    assert.equal(vs.get('src/lib/good.ts')?.classification, 'keep');
    assert.equal(vs.get('src/lib/broken.ts')?.classification, 'discard');
    assert.equal(vs.get('src/lib/stub.ts')?.classification, 'discard');
    assert.equal(vs.get('src/lib/messy.ts')?.classification, 'refactor');
    assert.equal(vs.get('src/data/mock-users.json')?.classification, 'discard');
    assert.equal(vs.get('app/page.tsx')?.classification, 'keep');
    assert.equal(vs.get('app/dashboard/page.tsx')?.classification, 'keep');

    // messy.ts metrics: one unused import + one empty function + one TODO.
    const messy = vs.get('src/lib/messy.ts');
    assert.ok(messy?.metrics);
    assert.equal(messy.metrics.unusedImports, 1);
    assert.equal(messy.metrics.emptyFunctions, 1);
    assert.equal(messy.metrics.todos, 1);

    // --- Salvage counts (source files only) + ratio ---
    assert.deepEqual(report.salvageAssessment.counts, { keep: 3, refactor: 1, discard: 2 });
    assert.ok(Math.abs(report.salvageAssessment.salvageRatio - 0.667) < 0.01);
    assert.ok(report.salvageAssessment.salvageableSchemaTables.includes('users'));
    assert.ok(report.salvageAssessment.salvageableRoutes.includes('/dashboard'));
    assert.ok(report.salvageAssessment.salvageableComponents.includes('add'));

    // --- Architectural intent ---
    assert.equal(report.intent.stack.framework, 'nextjs');
    assert.equal(report.intent.stack.database, 'supabase');
    assert.ok(report.intent.entities.includes('users'));
    assert.deepEqual(report.intent.detectedFeatures, ['dashboard', 'home']);
    assert.match(report.intent.inferredPurpose ?? '', /scheduling/i);

    // --- Failure diagnosis ---
    assert.ok(report.diagnosis.brokenIntegrations.some((s) => s.startsWith('stripe:')));
    assert.ok(report.diagnosis.missingFeatures.length >= 1);
    assert.ok(report.diagnosis.incompleteImplementations.some((s) => s.startsWith('src/lib/messy.ts')));

    // --- Reconstruction inputs + Phase 1A adapter ---
    assert.match(report.reconstructionInputs.idea, /Resurrection brief/);
    assert.match(report.reconstructionInputs.idea, /users/);
    assert.ok(report.reconstructionInputs.preserve.schemaTables.includes('users'));
    assert.ok(report.reconstructionInputs.redesign.discardedFiles.includes('src/lib/broken.ts'));

    const input = autopsyToPhase1aInput(report);
    assert.equal(input.idea, report.reconstructionInputs.idea);
    assert.equal(input.stackFingerprint.framework, 'nextjs');

    // --- Markdown render ---
    assert.match(renderAutopsyReportMarkdown(report), /PROJECT AUTOPSY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('autopsy on an empty/greenfield directory reports nothing to salvage and never throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-autopsy-empty-'));
  try {
    const report = await runProjectAutopsy(root, { log: () => {} });
    assert.equal(report.salvageable, false);
    assert.deepEqual(report.salvageAssessment.counts, { keep: 0, refactor: 0, discard: 0 });
    assert.equal(report.salvageAssessment.salvageableSchemaTables.length, 0);
    assert.equal(report.salvageAssessment.files.length, 0); // nothing catalogued
    assert.ok(['salvageable', 'partial', 'severe'].includes(report.diagnosis.severity));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
