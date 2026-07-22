/**
 * FORGE 2.0 — Skills Library (stack-detected engineering standards injection).
 *
 * Distinct from the queue.yaml-declared `skills: [name]` mechanism already wired into
 * `phase3-executor.ts` (which reads `<skillsDir>/<name>/SKILL.md` only for the skills a queue
 * entry explicitly opts into, via `loadSkillContent`). This library instead auto-DETECTS the
 * target project's tech stack from its `package.json` and injects every matching skill's
 * template into EVERY prompt automatically — a project-wide standards layer that needs no
 * per-entry opt-in, complementary to (not a replacement for) the existing mechanism.
 *
 * Skill files: flat `*.skill.md` files directly under a skills directory (non-recursive), each
 * with a YAML frontmatter header (`id`, `name`, `domain`, `tags`, `applicablePromptTypes`)
 * followed by the template body. House style: every export here is guarded — a missing
 * directory, an unreadable file, or a malformed frontmatter degrades to "skip it" rather than
 * throwing (skill injection is a quality-of-life layer, never a build blocker).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { readProjectPrdContent } from './ux-intelligence.js';
import { detectComplianceRegimes } from './compliance-detector.js';

/** One reusable engineering-standards skill, parsed from a `*.skill.md` file. */
export interface Skill {
  id: string;
  name: string;
  domain: string;
  template: string;
  tags: string[];
  applicablePromptTypes: string[];
}

/** A queryable collection of loaded {@link Skill}s. */
export interface SkillsLibrary {
  skills: Skill[];
  getByDomain(domain: string): Skill[];
  getByTags(tags: string[]): Skill[];
  /**
   * Skills relevant to `promptType`, per each skill's `applicablePromptTypes` frontmatter.
   * When `projectStack` is also given, the result is the union of two independent selections:
   * (1) stack-specific skills — skills whose tags intersect the detected stack (e.g. `supabase`
   * only appears when that tech is actually detected), and (2) curated "always relevant" elite
   * skills for `promptType` (see {@link ALWAYS_RELEVANT_BY_PROMPT_TYPE}) that apply to any
   * project of that prompt type regardless of stack, plus `ux-intelligence` for every prompt
   * type and `compliance` whenever any regulatory regime was detected in the stack. Deliberately
   * minimal: this must never return "all skills" for a broad prompt type like `api`.
   */
  getForPrompt(promptType: string, projectStack?: string[]): Skill[];
  /** Prepend the skills matching `projectStack` (by tag) to `promptText`, formatted as one block. Returns `promptText` unchanged when nothing matches. */
  injectIntoContext(promptText: string, projectStack: string[]): string;
}

/** Heading every injected skills block is prefixed with. */
export const SKILLS_CONTEXT_HEADER = 'ENGINEERING STANDARDS AND PATTERNS FOR THIS BUILD';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v !== '');
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter((v) => v !== '');
  return [];
}

/**
 * Parse one `*.skill.md` file's frontmatter + body (already-read `raw` text) into a {@link Skill}.
 * Returns `null` on a malformed frontmatter (no leading `---` block, or a non-object YAML
 * document). Shared by {@link parseSkillFile} (reads from disk) and {@link validateSkillFile}
 * (validates in-memory content — e.g. before `forge skills add` copies a candidate file in).
 */
function parseSkillContent(raw: string, fallbackId: string): Skill | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  const frontmatterText = match[1] ?? '';
  const body = match[2] ?? '';
  const parsed = parseYaml(frontmatterText) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') return null;
  const id = typeof parsed.id === 'string' && parsed.id.trim() !== '' ? parsed.id.trim() : fallbackId;
  const name = typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name.trim() : id;
  const domain = typeof parsed.domain === 'string' && parsed.domain.trim() !== '' ? parsed.domain.trim() : 'general';
  return {
    id,
    name,
    domain,
    template: body.trim(),
    tags: asStringArray(parsed.tags),
    applicablePromptTypes: asStringArray(parsed.applicablePromptTypes),
  };
}

/** Parse one `*.skill.md` file's frontmatter + body into a {@link Skill}. Returns `null` on a malformed/unreadable file (skipped, never thrown). */
function parseSkillFile(filePath: string, fallbackId: string): Skill | null {
  try {
    return parseSkillContent(readFileSync(filePath, 'utf8'), fallbackId);
  } catch {
    return null;
  }
}

/**
 * Validate a raw `*.skill.md` file's content without touching disk — every problem found is
 * reported (not just pass/fail), so `forge skills add` can tell the operator exactly why a
 * candidate file was rejected instead of a bare "invalid skill file". `fallbackId` is used only
 * when the frontmatter omits `id` (mirrors {@link loadSkillsLibrary}'s filename-derived fallback).
 */
export function validateSkillFile(
  raw: string,
  fallbackId: string
): { valid: boolean; errors: string[]; skill: Skill | null } {
  const errors: string[] = [];
  if (!FRONTMATTER_RE.test(raw)) {
    errors.push('missing YAML frontmatter (expected a leading "---" ... "---" block before the template body)');
    return { valid: false, errors, skill: null };
  }
  let skill: Skill | null;
  try {
    skill = parseSkillContent(raw, fallbackId);
  } catch (error) {
    errors.push(`frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
    return { valid: false, errors, skill: null };
  }
  if (!skill) {
    errors.push('frontmatter did not parse to an object');
    return { valid: false, errors, skill: null };
  }
  if (skill.template.trim() === '') errors.push('the skill body (after the frontmatter) is empty');
  if (errors.length > 0) return { valid: false, errors, skill: null };
  return { valid: true, errors: [], skill };
}

/**
 * Curated "elite" engineering-standard skill ids that are always relevant for a given prompt
 * type, regardless of stack-tag detection — security, reliability, and performance patterns that
 * apply to any project of that prompt type, not just a project whose `package.json` happens to
 * declare a matching dependency. Layered on top of (not a replacement for) the stack-tag-
 * intersection match in {@link SkillsLibrary.getForPrompt}, which still governs stack-specific
 * skills like `supabase`/`stripe`/`twilio`. `component`/`page` are not real FORGE `PromptType`
 * values (the union has `ui`/`feature` instead — see `phase4-sentinel.ts`'s `RET-3` precedent),
 * but `getForPrompt` accepts any string, so both are supported here for parity with the
 * `applicablePromptTypes` frontmatter several templates already declare.
 */
const ALWAYS_RELEVANT_BY_PROMPT_TYPE: Readonly<Record<string, readonly string[]>> = {
  database: ['database-indexing', 'multi-tenancy', 'audit-logging', 'soft-delete'],
  api: ['security-owasp', 'jwt-patterns', 'rbac', 'retry-patterns', 'webhook-reliability', 'circuit-breaker'],
  feature: ['feature-flags', 'zero-downtime-deploy'],
  component: ['core-web-vitals', 'mobile-first', 'ux-copywriting'],
  page: ['core-web-vitals', 'mobile-first', 'ux-copywriting'],
};

/** Skill ids injected into every prompt type, unconditionally. */
const ALWAYS_RELEVANT_SKILL_IDS: readonly string[] = ['ux-intelligence'];

/** Skill ids injected into `agent` prompts only when `ai` is present in the detected stack. */
const AGENT_AI_SKILL_IDS: readonly string[] = ['prompt-engineering', 'tool-calling', 'agent-memory', 'rag-patterns'];

/** Detected-stack tags that indicate at least one regulatory compliance regime was found in the PRD. */
const COMPLIANCE_STACK_TAGS: readonly string[] = ['compliance-hipaa', 'compliance-gdpr', 'compliance-pci'];

/** Skill ids injected into every prompt type once any {@link COMPLIANCE_STACK_TAGS} regime is detected. */
const COMPLIANCE_SKILL_IDS: readonly string[] = ['compliance'];

/** Render matching skills as one Markdown block, prefixed with {@link SKILLS_CONTEXT_HEADER}. */
function renderSkillsBlock(skills: readonly Skill[]): string {
  const sections = skills.map((s) => `### ${s.name} (${s.domain})\n\n${s.template}`);
  return `## ${SKILLS_CONTEXT_HEADER}\n\n${sections.join('\n\n')}`;
}

/**
 * Load every `*.skill.md` file directly under `skillsDir` into a queryable {@link SkillsLibrary}.
 * A missing directory or a read error degrades to an empty library (`skills: []`) rather than
 * throwing.
 */
export function loadSkillsLibrary(skillsDir: string): SkillsLibrary {
  const skills: Skill[] = [];
  try {
    if (existsSync(skillsDir)) {
      const files = readdirSync(skillsDir)
        .filter((f) => f.toLowerCase().endsWith('.skill.md'))
        .sort();
      for (const file of files) {
        const fallbackId = file.replace(/\.skill\.md$/i, '');
        const skill = parseSkillFile(join(skillsDir, file), fallbackId);
        if (skill) skills.push(skill);
      }
    }
  } catch {
    /* best-effort — keep whatever was parsed before the failure */
  }

  return {
    skills,
    getByDomain(domain: string): Skill[] {
      return skills.filter((s) => s.domain.toLowerCase() === domain.toLowerCase());
    },
    getByTags(tags: string[]): Skill[] {
      const wanted = new Set(tags.map((t) => t.toLowerCase()));
      return skills.filter((s) => s.tags.some((t) => wanted.has(t.toLowerCase())));
    },
    getForPrompt(promptType: string, projectStack?: string[]): Skill[] {
      const type = promptType.toLowerCase();
      const stackTags = new Set((projectStack ?? []).map((t) => t.toLowerCase()));

      const byType = skills.filter(
        (s) =>
          s.applicablePromptTypes.length === 0 ||
          s.applicablePromptTypes.some((t) => t.toLowerCase() === type)
      );
      const stackMatched = stackTags.size === 0 ? byType : byType.filter((s) => s.tags.some((t) => stackTags.has(t.toLowerCase())));

      const alwaysIds = new Set<string>(ALWAYS_RELEVANT_SKILL_IDS);
      for (const id of ALWAYS_RELEVANT_BY_PROMPT_TYPE[type] ?? []) alwaysIds.add(id);
      if (type === 'agent' && stackTags.has('ai')) {
        for (const id of AGENT_AI_SKILL_IDS) alwaysIds.add(id);
      }
      if (COMPLIANCE_STACK_TAGS.some((tag) => stackTags.has(tag))) {
        for (const id of COMPLIANCE_SKILL_IDS) alwaysIds.add(id);
      }

      const merged = new Map<string, Skill>();
      for (const s of stackMatched) merged.set(s.id, s);
      for (const s of skills) if (alwaysIds.has(s.id)) merged.set(s.id, s);
      return [...merged.values()];
    },
    injectIntoContext(promptText: string, projectStack: string[]): string {
      const stackTags = new Set(projectStack.map((t) => t.toLowerCase()));
      const matching = skills.filter((s) => s.tags.some((t) => stackTags.has(t.toLowerCase())));
      if (matching.length === 0) return promptText;
      return `${renderSkillsBlock(matching)}\n\n---\n\n${promptText}`;
    },
  };
}

/**
 * Technology → how to detect its presence: an exact `package.json` dependency name
 * (`packages`), a dependency-name prefix (`packagePrefixes` — e.g. any `@radix-ui/*`
 * package, since shadcn/ui projects pull in one Radix package per primitive rather than
 * a single umbrella package), and/or a marker file at the project root (`files`).
 */
const STACK_DETECTORS: ReadonlyArray<{
  tech: string;
  packages?: readonly string[];
  packagePrefixes?: readonly string[];
  files?: readonly string[];
}> = [
  { tech: 'nextjs', packages: ['next'] },
  { tech: 'react', packages: ['react'] },
  { tech: 'typescript', packages: ['typescript'] },
  { tech: 'supabase', packages: ['@supabase/supabase-js', '@supabase/ssr', '@supabase/auth-helpers-nextjs'] },
  { tech: 'tailwind', packages: ['tailwindcss'] },
  { tech: 'twilio', packages: ['twilio'] },
  { tech: 'stripe', packages: ['stripe', '@stripe/stripe-js'] },
  { tech: 'prisma', packages: ['prisma', '@prisma/client'] },
  { tech: 'drizzle', packages: ['drizzle-orm'] },
  { tech: 'vitest', packages: ['vitest'] },
  { tech: 'playwright', packages: ['playwright', '@playwright/test'] },
  { tech: 'shadcn', packagePrefixes: ['@radix-ui/'], files: ['components.json'] },
  { tech: 'redis', packages: ['ioredis', 'redis'] },
  { tech: 'i18n', packages: ['next-intl', 'react-i18next'] },
  { tech: 'background-jobs', packages: ['bullmq', 'pg-boss', 'inngest'] },
  { tech: 'ai', packages: ['openai'], packagePrefixes: ['@anthropic-ai/'] },
];

/**
 * Detect the target project's tech stack. Two independent sources feed the result: (1)
 * `package.json` `dependencies`/`devDependencies` (exact-name and prefix matches) plus, for
 * detectors that declare one, a marker file's presence at the project root, matched against
 * {@link STACK_DETECTORS} — degrades to contributing nothing on a missing/unparseable
 * `package.json`; and (2) a PRD/blueprint keyword scan for regulatory compliance regimes (via
 * {@link readProjectPrdContent}/{@link detectComplianceRegimes}, the same detector
 * `src/skills/compliance-detector.ts` uses for Phase 0's `COMPLIANCE_REQUIREMENTS.md`), which
 * contributes `compliance-hipaa`/`compliance-gdpr`/`compliance-pci` tags independently of
 * `package.json` — a project has PRD text well before it has a `package.json`. Both sources are
 * best-effort; a failure in either degrades to that source contributing nothing, never throws.
 */
export function detectProjectStack(projectPath: string): string[] {
  const detected: string[] = [];

  try {
    const pkgPath = join(projectPath, 'package.json');
    if (existsSync(pkgPath)) {
      const raw = readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const allDeps = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ];
      const allDepsSet = new Set<string>(allDeps);
      for (const { tech, packages, packagePrefixes, files } of STACK_DETECTORS) {
        const matchesPackage = (packages ?? []).some((p) => allDepsSet.has(p));
        const matchesPrefix = (packagePrefixes ?? []).some((prefix) => allDeps.some((d) => d.startsWith(prefix)));
        const matchesFile = (files ?? []).some((f) => existsSync(join(projectPath, f)));
        if (matchesPackage || matchesPrefix || matchesFile) detected.push(tech);
      }
    }
  } catch {
    /* unreadable/unparseable package.json — package-based detection contributes nothing, never throws */
  }

  try {
    const prdContent = readProjectPrdContent(projectPath);
    if (prdContent.trim() !== '') {
      const regimes = detectComplianceRegimes(prdContent, '');
      if (regimes.hipaa) detected.push('compliance-hipaa');
      if (regimes.gdpr) detected.push('compliance-gdpr');
      if (regimes.pciDss) detected.push('compliance-pci');
    }
  } catch {
    /* unreadable PRD or detection failure — compliance tags contribute nothing, never throws */
  }

  return detected;
}

/**
 * Default skills directory: `<forge-root>/src/skills/templates/` — the on-disk home of every
 * `*.skill.md` file, resolved relative to this compiled module (`dist/skills/index.js` → up two
 * levels to the repo root → back down into `src/skills/templates`) — the same repo-root-relative
 * pattern `phase2-governance.ts`'s `defaultTemplatesDir()` uses for `templates/governance/`.
 * Exported so `forge skills list/show/inject/add` resolve the IDENTICAL directory
 * {@link buildSkillsContext} reads from at build time, rather than a second, driftable guess.
 */
export function defaultSkillsLibraryDir(): string {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'skills', 'templates');
  } catch {
    return join(process.cwd(), 'src', 'skills', 'templates');
  }
}

/**
 * Detect `projectPath`'s stack, load every matching skill from the default skills-library
 * directory, and return `promptText` with a `## ENGINEERING STANDARDS AND PATTERNS FOR THIS
 * BUILD` block prepended. Returns `promptText` unchanged when no stack is detected, the library
 * is empty, or nothing matches — never throws.
 */
export function buildSkillsContext(projectPath: string, promptText: string): string {
  try {
    const stack = detectProjectStack(projectPath);
    if (stack.length === 0) return promptText;
    const library = loadSkillsLibrary(defaultSkillsLibraryDir());
    if (library.skills.length === 0) return promptText;
    return library.injectIntoContext(promptText, stack);
  } catch {
    return promptText;
  }
}
