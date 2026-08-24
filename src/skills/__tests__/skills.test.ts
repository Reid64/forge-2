/**
 * FORGE 2.0 — Skills Library unit tests: stack detection + prompt-type skill routing.
 *
 * Covers three responsibilities of `src/skills/index.ts`:
 *   1. `detectProjectStack` — reading a target project's `package.json` (+ marker files for
 *      file-detected tech like shadcn/ui) and returning the subset of known technologies present.
 *   2. `SkillsLibrary.getForPrompt` — returning the MINIMAL set of skills relevant to a given
 *      prompt type: skills whose tags intersect the detected stack, narrowed further by
 *      `applicablePromptTypes`, unioned with a small curated "always relevant" set per prompt
 *      type (`ALWAYS_RELEVANT_BY_PROMPT_TYPE` — the Elite Skills Library layer, see
 *      BEHAVIORAL_CONTRACTS.md Contract ESKU-3). This must NEVER return the full library for any
 *      single prompt type, and a stack-specific skill (`supabase`, `stripe`, `twilio`, ...) must
 *      never appear unless the corresponding tech is actually present in the stack.
 *   3. `buildSkillsContext` — the function Phase 3 actually calls on every real prompt
 *      (`phase3-executor.ts` step b2.5, passing `entry.prompt_type`). It MUST route through
 *      `getForPrompt` (type-scoped) rather than the older `injectIntoContext` (stack-tag-only,
 *      no prompt-type awareness) whenever a prompt type is supplied — otherwise every stack-
 *      matched skill (e.g. `stripe`, `twilio`) would be injected into every prompt regardless of
 *      whether it is a schema, api, ui, or deploy prompt. `injectIntoContext`'s broader match is
 *      retained only for callers with no prompt type, i.e. `forge skills inject` (a generic
 *      debugging command with no queue entry to read a type from).
 *
 * NOTE on "minimal": the real skills library ships 39 templates (10 original + 29 Elite Skills
 * Library additions, 2026-07-22). `getForPrompt`'s curated "always relevant" layer intentionally
 * adds a handful of security/reliability/performance skills to certain prompt types regardless of
 * stack (e.g. every `api` prompt always gets `security-owasp`/`jwt-patterns`/`rbac`/
 * `retry-patterns`/`webhook-reliability`/`circuit-breaker`) — this is deliberate, contract-
 * governed behavior (ESKU-3), not a bug, so "minimal" here means "scoped and bounded," not
 * "the single smallest possible set." The assertions below match the ACTUAL current routing
 * logic exactly, not a stale pre-Elite-Skills-Library expectation.
 *
 * HOW TO RUN
 *     node --import tsx --test src/skills/__tests__/skills.test.ts
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectProjectStack,
  loadSkillsLibrary,
  defaultSkillsLibraryDir,
  buildSkillsContext,
  validateSkillFile,
  loadClaudeSkills,
  SKILLS_CONTEXT_HEADER,
} from '../index.js';

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
// Fixture helper — a disposable `.claude/skills/<name>/SKILL.md` directory (the
// real Claude Skills layout: one subfolder per skill, plain `name`/`description`
// frontmatter — see `../index.js`'s module header for why this is a second,
// distinct source from `src/skills/templates/*.skill.md`).
// ---------------------------------------------------------------------------

function makeClaudeSkillsDir(skills: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-claude-skills-test-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(skills)) {
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf8');
  }
  return dir;
}

/** A small, real-shaped fixture matching the actual installed `design-taste-frontend/SKILL.md`'s frontmatter shape (plain `name`/`description`, no `id`/`domain`/`tags`/`applicablePromptTypes`). */
const SAMPLE_DESIGN_SKILL_MD = `---
name: sample-design-taste
description: Anti-slop frontend design skill for landing pages and portfolios. Enforces real design systems and strict visual design direction.
---

# Sample Design Taste

UNIQUE_MARKER_798c2 - this exact sentence should appear verbatim in an injected prompt for a UI-related build.
`;

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

test('detectProjectStack: detects playwright from "playwright" in dependencies', () => {
  const dir = makeProject({ dependencies: { playwright: '^1.49.1' } });
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

test('detectProjectStack: detects redis, i18n, background-jobs, and ai (Elite Skills Library detectors)', () => {
  const dir = makeProject({
    dependencies: { ioredis: '^5.4.1', 'next-intl': '^3.0.0', bullmq: '^5.0.0', openai: '^4.0.0' },
  });
  const stack = detectProjectStack(dir);
  assert.ok(stack.includes('redis'));
  assert.ok(stack.includes('i18n'));
  assert.ok(stack.includes('background-jobs'));
  assert.ok(stack.includes('ai'));
});

test('detectProjectStack: detects ai from "@anthropic-ai/*" prefix', () => {
  const dir = makeProject({ dependencies: { '@anthropic-ai/sdk': '^0.30.0' } });
  assert.ok(detectProjectStack(dir).includes('ai'));
});

test('detectProjectStack: detects a full realistic combination (nextjs + typescript + supabase + tailwind)', () => {
  const dir = makeProject({
    dependencies: { next: '^14.2.18', '@supabase/supabase-js': '^2.110.7', tailwindcss: '^3.4.0' },
    devDependencies: { typescript: '^5.7.2' },
  });
  assert.deepStrictEqual(sorted(detectProjectStack(dir)), sorted(['nextjs', 'typescript', 'supabase', 'tailwind']));
});

test('detectProjectStack: detects every requested combination at once (stripe/playwright/vitest/shadcn/twilio + core stack)', () => {
  const dir = makeProject(
    {
      dependencies: {
        next: '^14.2.18',
        react: '^18.3.1',
        '@supabase/supabase-js': '^2.110.7',
        tailwindcss: '^3.4.0',
        stripe: '^14.0.0',
        twilio: '^5.3.0',
        '@radix-ui/react-dialog': '^1.1.0',
      },
      devDependencies: {
        typescript: '^5.7.2',
        vitest: '^2.1.0',
        '@playwright/test': '^1.49.1',
      },
    },
    { 'components.json': '{"style":"default"}' }
  );
  assert.deepStrictEqual(
    sorted(detectProjectStack(dir)),
    sorted([
      'nextjs',
      'react',
      'typescript',
      'supabase',
      'tailwind',
      'stripe',
      'twilio',
      'shadcn',
      'vitest',
      'playwright',
    ])
  );
});

// ---------------------------------------------------------------------------
// getForPrompt — routed against the REAL templates under src/skills/templates/,
// so these tests also validate the frontmatter shipped for each skill.
// ---------------------------------------------------------------------------

const library = loadSkillsLibrary(defaultSkillsLibraryDir());

test('the real skills library loads all 39 shipped templates', () => {
  assert.strictEqual(library.skills.length, 39);
});

test('getForPrompt never returns the entire library for any single prompt type', () => {
  for (const promptType of ['schema', 'auth', 'api', 'ui', 'feature', 'agent', 'test', 'deploy', 'database', 'component']) {
    const result = library.getForPrompt(promptType);
    assert.ok(
      result.length < library.skills.length,
      `getForPrompt("${promptType}") returned ${result.length}/${library.skills.length} skills — expected a bounded subset, not the whole library`
    );
  }
});

test('getForPrompt("database", ["supabase"]) returns the supabase-tagged skill plus the curated database set', () => {
  const ids = sorted(library.getForPrompt('database', ['supabase']).map((s) => s.id));
  assert.deepStrictEqual(
    ids,
    sorted(['supabase', 'multi-tenancy', 'database-indexing', 'audit-logging', 'soft-delete', 'ux-intelligence'])
  );
});

test('getForPrompt("database", ["supabase"]) excludes unrelated stack-specific skills (twilio, stripe)', () => {
  const ids = new Set(library.getForPrompt('database', ['supabase']).map((s) => s.id));
  assert.ok(!ids.has('twilio'));
  assert.ok(!ids.has('stripe'));
  assert.ok(!ids.has('ui-components'));
});

test('getForPrompt("component", []) returns only component-applicable skills plus ux-intelligence', () => {
  const ids = sorted(library.getForPrompt('component', []).map((s) => s.id));
  assert.deepStrictEqual(
    ids,
    sorted([
      'bundle-optimization',
      'mobile-first',
      'core-web-vitals',
      'nextjs-app-router',
      'ui-components',
      'ux-copywriting',
      'typescript-strict',
      'ux-intelligence',
    ])
  );
});

test('getForPrompt("api", ["nextjs", "typescript", "supabase"]) narrows to stack-matched + curated api security skills', () => {
  const ids = sorted(library.getForPrompt('api', ['nextjs', 'typescript', 'supabase']).map((s) => s.id));
  assert.deepStrictEqual(
    ids,
    sorted([
      'api-patterns',
      'multi-tenancy',
      'nextjs-app-router',
      'repository-pattern',
      'typescript-strict',
      'supabase',
      'security-owasp',
      'jwt-patterns',
      'rbac',
      'retry-patterns',
      'webhook-reliability',
      'circuit-breaker',
      'ux-intelligence',
    ])
  );
});

test('getForPrompt("api", stack) drops stripe/subscription-billing when stripe is not in the stack', () => {
  const ids = new Set(library.getForPrompt('api', ['nextjs', 'typescript', 'supabase']).map((s) => s.id));
  assert.ok(!ids.has('stripe'));
  assert.ok(!ids.has('subscription-billing'));
});

test('getForPrompt("api", stack) includes stripe/subscription-billing when stripe IS in the stack', () => {
  const ids = new Set(library.getForPrompt('api', ['nextjs', 'typescript', 'supabase', 'stripe']).map((s) => s.id));
  assert.ok(ids.has('stripe'));
  assert.ok(ids.has('subscription-billing'));
});

test('getForPrompt("agent", ["ai"]) returns only the AI-tagged agent skills plus ux-intelligence', () => {
  const ids = sorted(library.getForPrompt('agent', ['ai']).map((s) => s.id));
  assert.deepStrictEqual(ids, sorted(['agent-memory', 'tool-calling', 'rag-patterns', 'prompt-engineering', 'ux-intelligence']));
});

test('getForPrompt("agent", []) never includes ui-only or database-only skills', () => {
  const ids = new Set(library.getForPrompt('agent', []).map((s) => s.id));
  assert.ok(!ids.has('ui-components'));
  assert.ok(!ids.has('database-indexing'));
  assert.ok(!ids.has('multi-tenancy'));
});

test('getForPrompt("api", ["compliance-hipaa"]) injects the compliance skill via the detected regime tag', () => {
  const ids = sorted(library.getForPrompt('api', ['compliance-hipaa']).map((s) => s.id));
  assert.deepStrictEqual(
    ids,
    sorted(['security-owasp', 'jwt-patterns', 'rbac', 'retry-patterns', 'webhook-reliability', 'circuit-breaker', 'compliance', 'ux-intelligence'])
  );
});

test('getForPrompt("api", stack) never includes the compliance skill when no compliance regime tag is present', () => {
  // A non-empty, compliance-unrelated stack is required here: an EMPTY stack disables tag
  // filtering entirely (getForPrompt's documented "no stack info -> don't filter" fallback), so
  // `compliance` (applicablePromptTypes includes "api") would pass through unfiltered — that is
  // not what this test is checking. This checks the COMPLIANCE_STACK_TAGS gate specifically: with
  // real filtering active and no compliance-* tag detected, compliance must not appear.
  const ids = new Set(library.getForPrompt('api', ['nextjs', 'typescript']).map((s) => s.id));
  assert.ok(!ids.has('compliance'));
});

test('getForPrompt is case-insensitive on prompt type and stack tags', () => {
  const lower = sorted(library.getForPrompt('database', ['supabase']).map((s) => s.id));
  const upper = sorted(library.getForPrompt('DATABASE', ['SUPABASE']).map((s) => s.id));
  assert.deepStrictEqual(lower, upper);
});

// ---------------------------------------------------------------------------
// buildSkillsContext — the function Phase 3 actually calls on every real prompt.
// ---------------------------------------------------------------------------

test('buildSkillsContext: with no promptType, returns promptText unchanged when no stack is detected', () => {
  const dir = makeProject(null);
  const promptText = 'Build the users table.';
  assert.strictEqual(buildSkillsContext(dir, promptText), promptText);
});

test('buildSkillsContext: with a promptType, an unrecognized stack can still get curated always-relevant skills', () => {
  const dir = makeProject(null);
  const promptText = 'Build the users table.';
  const result = buildSkillsContext(dir, promptText, 'database');
  assert.notStrictEqual(result, promptText);
  assert.ok(result.includes(SKILLS_CONTEXT_HEADER));
  assert.ok(result.includes('Database Indexing Standards'));
});

test('buildSkillsContext: promptType scopes injection — a schema/database prompt never receives stripe/twilio content', () => {
  const dir = makeProject({
    dependencies: {
      next: '^14.2.18',
      '@supabase/supabase-js': '^2.110.7',
      stripe: '^14.0.0',
      twilio: '^5.3.0',
    },
  });
  const promptText = 'Create the invoices table.';
  const result = buildSkillsContext(dir, promptText, 'database');
  assert.ok(!result.toLowerCase().includes('stripe integration patterns'));
  assert.ok(!result.toLowerCase().includes('twilio'));
});

test('buildSkillsContext: without promptType (e.g. forge skills inject), stack-matched skills are injected regardless of applicability to any one prompt type', () => {
  const dir = makeProject({
    dependencies: { stripe: '^14.0.0' },
  });
  const promptText = 'Do something.';
  const result = buildSkillsContext(dir, promptText);
  assert.ok(result.toLowerCase().includes('stripe'));
});

test('buildSkillsContext: real project with a supabase+nextjs stack gets a bounded (not full-library) skills block for a ui prompt', () => {
  const dir = makeProject({
    dependencies: { next: '^14.2.18', '@supabase/supabase-js': '^2.110.7', tailwindcss: '^3.4.0' },
    devDependencies: { typescript: '^5.7.2' },
  });
  const promptText = 'Build the dashboard page.';
  const result = buildSkillsContext(dir, promptText, 'feature');
  assert.notStrictEqual(result, promptText);
  // Bounded: the injected block must not contain every single template's own name header —
  // spot-check that an unrelated domain (telephony) never appears.
  assert.ok(!result.toLowerCase().includes('twilio integration patterns'));
});

// ---------------------------------------------------------------------------
// validateSkillFile — used by `forge skills add` to reject malformed candidate files.
// ---------------------------------------------------------------------------

test('validateSkillFile: rejects a file with no frontmatter', () => {
  const result = validateSkillFile('Just some text, no frontmatter.', 'fallback-id');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('validateSkillFile: rejects a file whose body is empty', () => {
  const result = validateSkillFile('---\nid: empty-body\n---\n\n', 'fallback-id');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('empty')));
});

test('validateSkillFile: accepts a well-formed skill file', () => {
  const result = validateSkillFile('---\nid: my-skill\ndomain: test\ntags: [foo]\n---\n\nSome guidance here.', 'fallback-id');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.skill?.id, 'my-skill');
});

test('validateSkillFile: falls back to the provided id when frontmatter omits it', () => {
  const result = validateSkillFile('---\ndomain: test\n---\n\nSome guidance.', 'derived-from-filename');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.skill?.id, 'derived-from-filename');
});

// ---------------------------------------------------------------------------
// .claude/skills/*/SKILL.md — the real Claude Skills second source. Real skills carry only
// plain `name`/`description` frontmatter (confirmed against the actual installed
// `.claude/skills/design-taste-frontend/SKILL.md`), so relevance is inferred by keyword-matching
// name+description against `CLAUDE_SKILL_KEYWORD_HINTS` rather than a hand-authored
// `applicablePromptTypes` field — these tests prove that inference actually gates injection in
// both directions (design prompt -> injected, non-design prompt -> not injected), not just that
// the file gets parsed.
// ---------------------------------------------------------------------------

test('loadClaudeSkills: parses real name/description-only frontmatter and infers domain + applicablePromptTypes', () => {
  const dir = makeClaudeSkillsDir({ 'sample-design-taste': SAMPLE_DESIGN_SKILL_MD });
  const skills = loadClaudeSkills([dir]);

  assert.strictEqual(skills.length, 1);
  const skill = skills[0]!;
  assert.strictEqual(skill.id, 'sample-design-taste');
  assert.strictEqual(skill.name, 'sample-design-taste');
  assert.deepStrictEqual(skill.tags, []); // real Claude Skills declare no tags — not stack-specific
  assert.strictEqual(skill.domain, 'frontend'); // inferred from "frontend"/"landing page"/"design system" etc.
  assert.ok(skill.applicablePromptTypes.includes('ui'));
  assert.ok(skill.applicablePromptTypes.includes('component'));
  assert.ok(skill.template.includes('UNIQUE_MARKER_798c2'));
});

test('loadClaudeSkills: a skill matching no domain keyword gets applicablePromptTypes: [] (never injected, not guessed)', () => {
  const genericSkillMd = `---
name: generic-notes
description: A collection of miscellaneous notes with no clear domain signal whatsoever.
---

Some generic content here.
`;
  const dir = makeClaudeSkillsDir({ 'generic-notes': genericSkillMd });
  const skills = loadClaudeSkills([dir]);

  assert.strictEqual(skills.length, 1);
  assert.deepStrictEqual(skills[0]!.applicablePromptTypes, []);
  assert.strictEqual(skills[0]!.domain, 'general');
});

test('loadClaudeSkills: a skill folder with no SKILL.md inside is skipped, never thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-claude-skills-test-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'not-a-skill'), { recursive: true });
  writeFileSync(join(dir, 'not-a-skill', 'README.md'), 'no SKILL.md here', 'utf8');

  assert.doesNotThrow(() => loadClaudeSkills([dir]));
  assert.deepStrictEqual(loadClaudeSkills([dir]), []);
});

test('loadClaudeSkills: a missing directory degrades to [] rather than throwing', () => {
  assert.doesNotThrow(() => loadClaudeSkills([join(tmpdir(), 'forge-does-not-exist-xyz')]));
  assert.deepStrictEqual(loadClaudeSkills([join(tmpdir(), 'forge-does-not-exist-xyz')]), []);
});

test('loadClaudeSkills: an earlier directory\'s skill wins over a same-id skill in a later directory', () => {
  const firstDir = makeClaudeSkillsDir({
    'dup-skill': '---\nname: dup-skill\ndescription: frontend design skill, first copy.\n---\n\nFIRST_COPY_MARKER\n',
  });
  const secondDir = makeClaudeSkillsDir({
    'dup-skill': '---\nname: dup-skill\ndescription: frontend design skill, second copy.\n---\n\nSECOND_COPY_MARKER\n',
  });
  const skills = loadClaudeSkills([firstDir, secondDir]);
  assert.strictEqual(skills.length, 1);
  assert.ok(skills[0]!.template.includes('FIRST_COPY_MARKER'));
});

test('loadClaudeSkills: an oversized SKILL.md body is truncated with a clear marker (context-overflow guard)', () => {
  const hugeBody = 'frontend design system content. '.repeat(1000); // ~34,000 chars, well over the cap
  const hugeSkillMd = `---\nname: huge-skill\ndescription: frontend design skill.\n---\n\n${hugeBody}`;
  const dir = makeClaudeSkillsDir({ 'huge-skill': hugeSkillMd });
  const skills = loadClaudeSkills([dir]);

  assert.strictEqual(skills.length, 1);
  assert.ok(skills[0]!.template.length < hugeBody.length, 'expected the template to be truncated, not the full ~34,000 chars');
  assert.ok(skills[0]!.template.length < 7_000, `expected a bounded template well under the raw size, got ${skills[0]!.template.length} chars`);
  assert.ok(skills[0]!.template.includes('truncated'), 'expected a truncation marker so the loss is visible, not silent');
});

test('buildSkillsContext: a real .claude/skills/*/SKILL.md is injected into a genuinely design/UI-related prompt', () => {
  const claudeSkillsDir = makeClaudeSkillsDir({ 'sample-design-taste': SAMPLE_DESIGN_SKILL_MD });
  const projectDir = makeProject({ dependencies: { next: '^14.2.18' } });
  const promptText = 'Build the marketing landing page hero section.';

  const result = buildSkillsContext(projectDir, promptText, 'ui', [claudeSkillsDir]);

  assert.notStrictEqual(result, promptText);
  assert.ok(result.includes(SKILLS_CONTEXT_HEADER));
  assert.ok(result.includes('UNIQUE_MARKER_798c2'), "expected the sample skill's actual body content in the injected output");
});

test('buildSkillsContext: the SAME .claude/skills/*/SKILL.md is NOT injected into a non-design (schema) prompt — relevance filter works both directions', () => {
  const claudeSkillsDir = makeClaudeSkillsDir({ 'sample-design-taste': SAMPLE_DESIGN_SKILL_MD });
  const projectDir = makeProject({ dependencies: { next: '^14.2.18' } });
  const promptText = 'Create the invoices table schema.';

  const result = buildSkillsContext(projectDir, promptText, 'schema', [claudeSkillsDir]);

  assert.ok(!result.includes('UNIQUE_MARKER_798c2'), 'the design skill must not leak into a schema prompt');
});

test('buildSkillsContext: an oversized real SKILL.md never blows past the character cap even when injected', () => {
  const hugeBody = 'frontend design system content. '.repeat(1000);
  const hugeSkillMd = `---\nname: huge-design-skill\ndescription: frontend design skill.\n---\n\n${hugeBody}`;
  const claudeSkillsDir = makeClaudeSkillsDir({ 'huge-design-skill': hugeSkillMd });
  const projectDir = makeProject({ dependencies: { next: '^14.2.18' } });
  const promptText = 'Build the marketing landing page hero section.';

  const result = buildSkillsContext(projectDir, promptText, 'ui', [claudeSkillsDir]);

  assert.notStrictEqual(result, promptText);
  // Bounded against the raw ~34,000-char fixture body, not against zero — a 'ui' prompt on this
  // stack also legitimately pulls in a handful of small stack-matched templates alongside the
  // (capped) fixture skill, so some headroom above the per-skill cap alone is expected here.
  const injectedLength = result.length - promptText.length;
  assert.ok(
    injectedLength < 20_000,
    `expected the injected block to stay well under the raw ~34,000-char fixture size, got +${injectedLength} chars`
  );
  assert.ok(!result.includes('frontend design system content. '.repeat(1000)), 'the raw uncapped fixture body must not appear verbatim');
});
