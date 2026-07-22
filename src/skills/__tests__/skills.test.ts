/**
 * FORGE 2.0 — Skills Library unit tests: stack detection + prompt-type skill routing.
 *
 * Covers two responsibilities of `src/skills/index.ts`:
 *   1. `detectProjectStack` — reading a target project's `package.json` (+ marker files for
 *      file-detected tech like shadcn/ui) and returning the subset of known technologies present.
 *   2. `SkillsLibrary.getForPrompt` — returning the MINIMAL set of skills relevant to a given
 *      prompt type, narrowing further by project stack when supplied (a stack-specific skill like
 *      `supabase` must never appear for a project that doesn't actually use it).
 *
 * HOW TO RUN
 *     node --import tsx --test src/skills/__tests__/skills.test.ts
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectProjectStack, loadSkillsLibrary, defaultSkillsLibraryDir } from '../index.js';

// ---------------------------------------------------------------------------
// Fixture helper — a disposable project directory with a given package.json
// (+ optional extra marker files), cleaned up automatically after the run.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeProject(pkg: Record<string, unknown> | null, extraFiles: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-skills-test-'));
  tempDirs.push(dir);
  if (pkg !== null) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
  }
  for (const [name, content] of Object.entries(extraFiles)) {
    mkdirSync(join(dir, ...name.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, name), content, 'utf8');
  }
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

// ---------------------------------------------------------------------------
// detectProjectStack
// ---------------------------------------------------------------------------

test('detectProjectStack: missing package.json degrades to []', () => {
  const dir = makeProject(null);
  assert.deepStrictEqual(detectProjectStack(dir), []);
});

test('detectProjectStack: malformed package.json degrades to [] (never throws)', () => {
  const dir = makeProject(null);
  writeFileSync(join(dir, 'package.json'), '{ not valid json', 'utf8');
  assert.doesNotThrow(() => detectProjectStack(dir));
  assert.deepStrictEqual(detectProjectStack(dir), []);
});

test('detectProjectStack: detects stripe from "stripe" in dependencies', () => {
  const dir = makeProject({ dependencies: { stripe: '^14.0.0' } });
  assert.ok(detectProjectStack(dir).includes('stripe'));
});

test('detectProjectStack: detects stripe from "@stripe/stripe-js" in dependencies', () => {
  const dir = makeProject({ dependencies: { '@stripe/stripe-js': '^3.0.0' } });
  assert.ok(detectProjectStack(dir).includes('stripe'));
});

test('detectProjectStack: detects playwright from "@playwright/test" in devDependencies', () => {
  const dir = makeProject({ devDependencies: { '@playwright/test': '^1.49.1' } });
  assert.ok(detectProjectStack(dir).includes('playwright'));
});

test('detectProjectStack: detects vitest from "vitest" in devDependencies', () => {
  const dir = makeProject({ devDependencies: { vitest: '^2.1.0' } });
  assert.ok(detectProjectStack(dir).includes('vitest'));
});

test('detectProjectStack: detects twilio from "twilio" in dependencies', () => {
  const dir = makeProject({ dependencies: { twilio: '^5.3.0' } });
  assert.ok(detectProjectStack(dir).includes('twilio'));
});

test('detectProjectStack: detects typescript from "typescript" in devDependencies', () => {
  const dir = makeProject({ devDependencies: { typescript: '^5.7.2' } });
  assert.ok(detectProjectStack(dir).includes('typescript'));
});

test('detectProjectStack: detects shadcn from an "@radix-ui/*" dependency', () => {
  const dir = makeProject({ dependencies: { '@radix-ui/react-dialog': '^1.1.0' } });
  assert.ok(detectProjectStack(dir).includes('shadcn'));
});

test('detectProjectStack: detects shadcn from components.json presence (no @radix-ui dependency)', () => {
  const dir = makeProject({ dependencies: {} }, { 'components.json': '{"style":"default"}' });
  assert.ok(detectProjectStack(dir).includes('shadcn'));
});

test('detectProjectStack: a project with neither @radix-ui deps nor components.json does not report shadcn', () => {
  const dir = makeProject({ dependencies: { next: '^14.2.18' } });
  assert.ok(!detectProjectStack(dir).includes('shadcn'));
});

test('detectProjectStack: detects a full realistic combination (nextjs + typescript + supabase + tailwind)', () => {
  const dir = makeProject({
    dependencies: { next: '^14.2.18', '@supabase/supabase-js': '^2.110.7', tailwindcss: '^3.4.0' },
    devDependencies: { typescript: '^5.7.2' },
  });
  assert.deepStrictEqual(sorted(detectProjectStack(dir)), sorted(['nextjs', 'typescript', 'supabase', 'tailwind']));
});

// ---------------------------------------------------------------------------
// getForPrompt — routed against the REAL templates under src/skills/templates/,
// so these tests also validate the frontmatter shipped for each skill.
// ---------------------------------------------------------------------------

const library = loadSkillsLibrary(defaultSkillsLibraryDir());

test('the real skills library loads all 10 shipped templates', () => {
  assert.strictEqual(library.skills.length, 10);
});

test('getForPrompt("database") returns only supabase + typescript-strict', () => {
  const ids = sorted(library.getForPrompt('database').map((s) => s.id));
  assert.deepStrictEqual(ids, sorted(['supabase', 'typescript-strict']));
});

test('getForPrompt("component") returns only ui-components + typescript-strict', () => {
  const ids = sorted(library.getForPrompt('component').map((s) => s.id));
  assert.deepStrictEqual(ids, sorted(['ui-components', 'typescript-strict']));
});

test('getForPrompt("api") with no stack returns api-patterns + typescript-strict + supabase', () => {
  const ids = sorted(library.getForPrompt('api').map((s) => s.id));
  assert.deepStrictEqual(ids, sorted(['api-patterns', 'typescript-strict', 'supabase']));
});

test('getForPrompt("api", stack) drops supabase when supabase is not detected in the stack', () => {
  const ids = sorted(library.getForPrompt('api', ['typescript', 'nextjs']).map((s) => s.id));
  assert.deepStrictEqual(ids, sorted(['api-patterns', 'typescript-strict']));
});

test('getForPrompt("api", stack) includes supabase when supabase IS detected in the stack', () => {
  const ids = sorted(library.getForPrompt('api', ['typescript', 'nextjs', 'supabase']).map((s) => s.id));
  assert.deepStrictEqual(ids, sorted(['api-patterns', 'typescript-strict', 'supabase']));
});

test('getForPrompt never returns the entire library for a narrow prompt type ("api"/"component"/"database")', () => {
  // "feature" is deliberately broad (a feature prompt can legitimately touch db/api/ui/testing)
  // and is not part of this assertion — only the narrow, single-concern prompt types are.
  for (const promptType of ['api', 'component', 'database']) {
    const result = library.getForPrompt(promptType);
    assert.ok(
      result.length < library.skills.length,
      `getForPrompt("${promptType}") returned ${result.length}/${library.skills.length} skills — expected a minimal subset, not the whole library`
    );
  }
});

test('getForPrompt("agent") returns only agent-relevant skills (never the ui/database-only skills)', () => {
  const ids = new Set(library.getForPrompt('agent').map((s) => s.id));
  assert.ok(!ids.has('ui-components'));
  assert.ok(!ids.has('nextjs-app-router'));
});
