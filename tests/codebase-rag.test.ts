/**
 * FORGE 2.0 — Codebase RAG unit test.
 *
 * The RAG indexer reads a real directory tree (it reuses the codebase-reader's scan and then
 * re-reads source files for imports), so this suite materializes a small project in an
 * `os.tmpdir()` mkdtemp dir, builds the in-memory index, and asserts:
 *   - tokenization splits camelCase / snake_case / path identifiers into shared tokens
 *   - import extraction captures `from`, side-effect, re-export, and require/dynamic specifiers
 *   - a task query retrieves the structurally-relevant file ahead of an unrelated one (cosine)
 *   - cosine similarity is bounded and self-similarity is ~1
 *   - rebuild() picks up a file written after the initial index (the post-prompt rebuild path)
 *   - an empty / sourceless directory yields an empty index that retrieves nothing (non-fatal)
 *
 * No database, no `claude`, no git — pure filesystem + in-memory math.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/codebase-rag.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  buildCodebaseIndex,
  CodebaseRag,
  cosineSimilarity,
  extractImports,
  renderRelevantFiles,
  tokenize,
} from '../src/tools/codebase-rag.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Write `content` to `<root>/<rel>`, creating parent directories. */
function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** Materialize a small project with two clearly-distinct source files. */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-rag-'));

  writeFile(
    root,
    'src/memory/users.ts',
    [
      "import { createClient } from '@supabase/supabase-js';",
      "import { nowIso } from './client.js';",
      '',
      'export interface UserRecord { id: string; email: string; }',
      '',
      'export async function getUserById(id: string): Promise<UserRecord | null> {',
      '  const client = createClient(process.env.URL ?? "", process.env.KEY ?? "");',
      '  void nowIso;',
      '  return client ? { id, email: "x" } : null;',
      '}',
      '',
      'export function listUsers(): UserRecord[] { return []; }',
    ].join('\n')
  );

  writeFile(
    root,
    'src/ui/InvoiceChart.tsx',
    [
      "import * as React from 'react';",
      '',
      'export function InvoiceChart(props: { total: number }) {',
      '  return null as unknown as JSX.Element;',
      '}',
    ].join('\n')
  );

  return root;
}

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

test('tokenize splits camelCase, snake_case, and path identifiers into shared tokens', () => {
  const camel = tokenize('getUserById');
  assert.ok(camel.includes('get') && camel.includes('user') && camel.includes('id'));

  const snake = tokenize('get_user_by_id');
  assert.ok(snake.includes('user') && snake.includes('id'));

  const path = tokenize('src/memory/users.ts');
  assert.ok(path.includes('memory') && path.includes('users'));

  // Stopwords / 1-char tokens are dropped.
  assert.ok(!tokenize('the and for').includes('the'));
});

test('extractImports captures from / side-effect / re-export / require / dynamic specifiers', () => {
  const text = [
    "import { a } from './a.js';",
    "import 'side-effect';",
    "export { b } from './b.js';",
    "const c = require('node:fs');",
    "const d = await import('./dynamic.js');",
  ].join('\n');
  const imports = extractImports(text);
  assert.deepEqual(imports, ['./a.js', './b.js', './dynamic.js', 'node:fs', 'side-effect']);
});

test('cosineSimilarity is bounded and self-similarity is ~1', () => {
  const v = new Map<number, number>([
    [1, 0.6],
    [2, 0.8],
  ]); // already unit-norm (0.6² + 0.8² = 1)
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9);
  assert.equal(cosineSimilarity(v, new Map()), 0);
});

// ---------------------------------------------------------------------------
// Index + retrieval tests
// ---------------------------------------------------------------------------

test('buildCodebaseIndex indexes source files with their structural fields', async () => {
  const root = makeProject();
  const index = await buildCodebaseIndex(root, { log: () => {} });

  assert.equal(index.size, 2);
  const users = index.documents.find((d) => d.path === 'src/memory/users.ts');
  assert.ok(users, 'users.ts should be indexed');
  assert.ok(users.exports.includes('getUserById'));
  assert.ok(users.exports.includes('UserRecord'));
  assert.ok(users.imports.includes('@supabase/supabase-js'));
  assert.ok(users.functions.some((f) => f.includes('getUserById')));

  const chart = index.documents.find((d) => d.path === 'src/ui/InvoiceChart.tsx');
  assert.ok(chart, 'InvoiceChart.tsx should be indexed');
  assert.ok(chart.components.includes('InvoiceChart'));
});

test('query retrieves the structurally-relevant file ahead of an unrelated one', async () => {
  const root = makeProject();
  const index = await buildCodebaseIndex(root, { log: () => {} });

  const matches = index.query('Add an API route to fetch a user by id from the users table', 10);
  assert.ok(matches.length >= 1, 'expected at least one relevant file');
  assert.equal(matches[0]?.document.path, 'src/memory/users.ts');
  assert.ok((matches[0]?.score ?? 0) > 0);

  // The chart file, if returned at all, must rank below the users file for a user-by-id task.
  const chartRank = matches.findIndex((m) => m.document.path === 'src/ui/InvoiceChart.tsx');
  if (chartRank >= 0) assert.ok(chartRank > 0);
});

test('renderRelevantFiles produces an injectable block naming the existing files', async () => {
  const root = makeProject();
  const index = await buildCodebaseIndex(root, { log: () => {} });
  const matches = index.query('fetch a user by id', 10);

  const block = renderRelevantFiles(matches);
  assert.ok(block.includes('Existing project files relevant to this task'));
  assert.ok(block.includes('src/memory/users.ts'));

  // Nothing relevant → empty block (so the assembler injects nothing).
  assert.equal(renderRelevantFiles([]), '');
});

test('CodebaseRag.rebuild picks up a file written after the initial index', async () => {
  const root = makeProject();
  const rag = await CodebaseRag.create(root, { log: () => {} });
  assert.equal(rag.fileCount, 2);

  // Simulate a successful prompt creating a new module, then rebuild (the post-prompt path).
  writeFile(
    root,
    'src/api/invoices.ts',
    'export function createInvoice(amount: number): { amount: number } { return { amount }; }'
  );
  await rag.rebuild();
  assert.equal(rag.fileCount, 3);

  const { block, matches } = rag.contextBlock('create an invoice for a given amount', { topK: 3 });
  assert.ok(matches.some((m) => m.document.path === 'src/api/invoices.ts'));
  assert.ok(block.includes('src/api/invoices.ts'));
});

test('an empty / sourceless directory yields an empty index that retrieves nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-rag-empty-'));
  writeFile(root, 'README.md', '# nothing to index here');

  const index = await buildCodebaseIndex(root, { log: () => {} });
  assert.equal(index.size, 0);
  assert.deepEqual(index.query('anything at all'), []);
});
