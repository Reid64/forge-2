/**
 * FORGE 2.0 — Documentation Generator unit test (Sprint 8, s8-p03).
 *
 * The generator reads a real directory tree (governance docs, package.json,
 * .env.example, route files, migration SQL) so this suite materializes a small
 * project in an `os.tmpdir()` mkdtemp dir, runs `generateDocs` against it (no
 * database, no `claude`, no git — the schema is read from the migration file, no
 * live `sql`/`supabase` is supplied), and asserts the four generated documents.
 * A second case covers the bare/greenfield directory (never throws, thin docs).
 *
 * HOW TO RUN
 *     node --import tsx --test tests/doc-generator.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { generateDocs, type DocGenerationResult, type GeneratedDoc } from '../src/tools/doc-generator.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Write `content` to `<root>/<rel>`, creating parent directories. */
function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** Find a generated doc by name (throws a clear assertion if absent). */
function doc(result: DocGenerationResult, name: GeneratedDoc['name']): GeneratedDoc {
  const found = result.documents.find((d) => d.name === name);
  assert.ok(found, `expected ${name} to be generated`);
  return found;
}

/** Materialize a small, well-formed project and return its root path. */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-docgen-'));

  writeFile(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'acme-tasks',
        description: 'Fallback description from package.json.',
        scripts: { dev: 'next dev', build: 'next build', typecheck: 'tsc --noEmit', test: 'playwright test' },
        dependencies: { next: '14.0.0', '@supabase/supabase-js': '2.0.0' },
      },
      null,
      2
    )
  );

  writeFile(root, 'vercel.json', '{}'); // → deployment target vercel

  writeFile(
    root,
    'governance/BLUEPRINT.md',
    [
      '# Acme Tasks — BLUEPRINT',
      '',
      '## System Identity',
      '- **Name:** Acme Tasks',
      '- **Purpose:** A task management app with authentication and a dashboard.',
    ].join('\n')
  );

  writeFile(
    root,
    'governance/PRD.md',
    [
      '# Acme Tasks PRD',
      '',
      '## Product Overview',
      'Acme Tasks lets teams create, assign, and track tasks with role-based access.',
    ].join('\n')
  );

  writeFile(
    root,
    'governance/BEHAVIORAL_CONTRACTS.md',
    [
      '# Contracts',
      '',
      'The API exposes `GET /api/tasks` (list) and `POST /api/tasks` (create).',
      'There is also a `DELETE /api/tasks/[id]` route.',
    ].join('\n')
  );

  writeFile(
    root,
    '.env.example',
    [
      '# Supabase project URL',
      'NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co',
      'SUPABASE_SERVICE_KEY=replace-me  # server-only service role key',
    ].join('\n')
  );

  // A real App-Router API route that exports GET + POST and reads the session.
  writeFile(
    root,
    'app/api/tasks/route.ts',
    [
      "import { createServerClient } from '@supabase/ssr';",
      'export async function GET() {',
      '  const supabase = createServerClient();',
      '  return Response.json({ data: [] });',
      '}',
      'export async function POST(req: Request) {',
      '  const body = await req.json();',
      '  return Response.json(body);',
      '}',
    ].join('\n')
  );

  // Migration → schema (tasks table with RLS company scoping).
  writeFile(
    root,
    'migrations/001_tasks.sql',
    [
      'create table tasks (',
      '  id uuid primary key default gen_random_uuid(),',
      '  company_id uuid not null references companies(id) on delete cascade,',
      '  title text not null,',
      '  done boolean not null default false,',
      '  created_at timestamptz not null default now()',
      ');',
      'alter table tasks enable row level security;',
      'create policy "tasks_company_scope" on tasks for select to authenticated using (company_id = auth.uid());',
    ].join('\n')
  );

  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('generateDocs produces and writes the four standard documents', async () => {
  const root = makeProject();
  const result = await generateDocs(root, { log: () => {} });

  // Four docs, in canonical order, all written to docs/.
  assert.deepEqual(
    result.documents.map((d) => d.name),
    ['README.md', 'API.md', 'SCHEMA.md', 'DEPLOY.md']
  );
  assert.equal(result.outputDir, 'docs');
  for (const d of result.documents) {
    assert.equal(d.written, true, `${d.name} should be written`);
    assert.ok(d.bytes > 0);
    assert.ok(existsSync(join(root, 'docs', d.name)), `${d.name} should exist on disk`);
  }

  // Project name + description resolved from governance (BLUEPRINT/PRD), not package.json.
  assert.equal(result.projectName, 'Acme Tasks');
  assert.equal(result.stack.deployment, 'vercel');

  const readme = doc(result, 'README.md').content;
  assert.match(readme, /# Acme Tasks/);
  assert.match(readme, /track tasks/i); // description resolved from PRD Product Overview
  assert.match(readme, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(readme, /Supabase project URL/); // env comment carried through
  assert.match(readme, /pnpm install/); // package manager-aware setup
  assert.match(readme, /\| `pnpm build` \| `next build` \|/); // build commands table

  const api = doc(result, 'API.md').content;
  assert.match(api, /GET \/api\/tasks/);
  assert.match(api, /POST \/api\/tasks/);
  assert.match(api, /Required/); // auth detected from createServerClient/session
  assert.match(api, /`401`/); // auth → 401 listed
  // POST request body example derived from the tasks table, excluding server-derived columns.
  const postSection = (api.split('## `POST /api/tasks`')[1] ?? '').split('## `')[0] ?? '';
  const postBody = (postSection.split('Request body')[1] ?? '').split('Response example')[0] ?? '';
  assert.match(postBody, /"title"/);
  assert.doesNotMatch(postBody, /"company_id"/);

  const schema = doc(result, 'SCHEMA.md').content;
  assert.match(schema, /## `tasks`/);
  assert.match(schema, /company_id/);
  assert.match(schema, /companies\(id\)/); // relationship rendered
  assert.match(schema, /Row-Level Security/);
  assert.match(schema, /company/i); // plain-language RLS mentions company scoping

  const deploy = doc(result, 'DEPLOY.md').content;
  assert.match(deploy, /vercel --prod/);
  assert.match(deploy, /deploy\.ps1/);
  assert.match(deploy, /tsc --noEmit/);
});

test('generateDocs with write:false returns content without touching disk', async () => {
  const root = makeProject();
  const result = await generateDocs(root, { write: false, log: () => {} });
  assert.equal(result.documents.length, 4);
  for (const d of result.documents) assert.equal(d.written, false);
  assert.ok(!existsSync(join(root, 'docs')), 'docs/ should not be created when write:false');
});

test('generateDocs on a bare directory never throws and yields thin docs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-docgen-bare-'));
  const result = await generateDocs(root, { log: () => {} });

  assert.equal(result.documents.length, 4);
  // Falls back to the directory basename for the project name.
  assert.ok(result.projectName.length > 0);

  const api = readFileSync(join(root, 'docs', 'API.md'), 'utf8');
  assert.match(api, /No API endpoints were detected/);
  const schema = readFileSync(join(root, 'docs', 'SCHEMA.md'), 'utf8');
  assert.match(schema, /No database tables were found/);
});
