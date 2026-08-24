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
 * TWO skill sources feed this library, merged transparently behind one {@link SkillsLibrary}:
 *   1. Flat `*.skill.md` files directly under `src/skills/templates/` (non-recursive), each with
 *      this repo's own curated YAML frontmatter (`id`, `name`, `domain`, `tags`,
 *      `applicablePromptTypes`) — see {@link loadTemplateSkills}/{@link parseSkillFile}.
 *   2. Real Claude Skills — `<dir>/<skill-name>/SKILL.md` under `.claude/skills/` (both the FORGE
 *      install's own directory and `~/.claude/skills/`, the same two-location resolution
 *      `design-system-generator.ts`'s `resolveScriptPath` uses for the UI/UX Pro Max skill) —
 *      see {@link loadClaudeSkills}/{@link parseClaudeSkillFile}. These carry only plain
 *      `name`/`description` frontmatter (the real Claude Skill spec — confirmed against the
 *      actual installed `.claude/skills/design-taste-frontend/SKILL.md`, not assumed), so
 *      `tags`/`applicablePromptTypes` are near-always absent; {@link inferPromptTypesAndDomain}
 *      derives them from `name`+`description` keyword matching so the SAME `getForPrompt`
 *      relevance logic used for templates governs these too, rather than blindly injecting into
 *      every prompt type. A per-skill character cap ({@link CLAUDE_SKILL_MAX_TEMPLATE_CHARS})
 *      guards against a large human-authored SKILL.md (unlike the small curated templates)
 *      reintroducing the context-overflow problem that got auto-injection disabled in build
 *      prompts once already (commit cdb6807).
 *
 * House style: every export here is guarded — a missing directory, an unreadable file, or a
 * malformed frontmatter degrades to "skip it" rather than throwing (skill injection is a
 * quality-of-life layer, never a build blocker).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
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

/** Read every `*.skill.md` file directly under `skillsDir` (non-recursive). Never throws — a missing directory or a read error degrades to `[]`. */
function loadTemplateSkills(skillsDir: string): Skill[] {
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
  return skills;
}

/**
 * Build a queryable {@link SkillsLibrary} over an already-loaded, already-merged `skills` array —
 * the shared query engine both {@link loadSkillsLibrary} (templates only) and
 * {@link buildSkillsContext} (templates + `.claude/skills/`) build on top of, so relevance
 * matching is defined exactly once.
 *
 * In {@link SkillsLibrary.getForPrompt} ONLY (never `injectIntoContext` — see that method's own
 * comment), a skill with an empty `tags` array (every real Claude Skill from `.claude/skills/` —
 * see this module's header) is treated as stack-agnostic: it passes the stack-tag filter
 * regardless of `projectStack`, the same way a tag-less skill logically should (it isn't scoped
 * to any particular dependency, unlike `supabase`/`stripe`/etc. — its relevance is governed by
 * the prompt-type gate `getForPrompt` applies first, via `applicablePromptTypes`, which for these
 * skills is inferred by {@link inferPromptTypesAndDomain} rather than hand-authored). No
 * `src/skills/templates/*.skill.md`
 * file currently omits `tags`, so this is additive — it changes nothing for the existing 40
 * templates.
 */
function buildLibraryFromSkills(skills: readonly Skill[]): SkillsLibrary {
  return {
    skills: [...skills],
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
          s.applicablePromptTypes.some((t) => t.toLowerCase() === type)
      );
      const stackMatched =
        stackTags.size === 0
          ? byType
          : byType.filter((s) => s.tags.length === 0 || s.tags.some((t) => stackTags.has(t.toLowerCase())));

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
    // Deliberately NOT the `tags.length === 0` stack-agnostic treatment `getForPrompt` uses below:
    // this path has no prompt-type gate at all (it's the plain stack-tag match for `forge skills
    // inject`'s generic no-prompt-type case), so a tag-less `.claude/skills` entry (this module's
    // header) would otherwise match EVERY call unconditionally — exactly the "blindly prepended
    // regardless of type" outcome relevance-scoping exists to prevent. Those skills are reachable
    // through the prompt-type-gated `getForPrompt` path instead.
    injectIntoContext(promptText: string, projectStack: string[]): string {
      const stackTags = new Set(projectStack.map((t) => t.toLowerCase()));
      const matching = skills.filter((s) => s.tags.some((t) => stackTags.has(t.toLowerCase())));
      if (matching.length === 0) return promptText;
      return `${renderSkillsBlock(matching)}\n\n---\n\n${promptText}`;
    },
  };
}

/**
 * Load every `*.skill.md` file directly under `skillsDir` into a queryable {@link SkillsLibrary}
 * (templates only — the `defaultSkillsLibraryDir()` source). A missing directory or a read error
 * degrades to an empty library (`skills: []`) rather than throwing. Unchanged signature/behavior:
 * `forge skills list/show/add` and {@link component-generator.ts} still call this directly.
 */
export function loadSkillsLibrary(skillsDir: string): SkillsLibrary {
  return buildLibraryFromSkills(loadTemplateSkills(skillsDir));
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

// ---------------------------------------------------------------------------
// Real Claude Skills (.claude/skills/<name>/SKILL.md) — a second skill source
// ---------------------------------------------------------------------------

/**
 * A real Claude Skill's `SKILL.md` is typically far larger than this repo's curated
 * `*.skill.md` templates (the 40 templates sum to ~64KB total; one real skill alone can exceed
 * that — `design-taste-frontend`'s installed `SKILL.md` is ~88KB on its own). Auto-injecting one
 * uncapped is exactly the kind of context-overflow risk that got build-prompt skill injection
 * disabled once already (commit cdb6807, `phase3-executor.ts`) — so each `.claude/skills/` body
 * is capped here, independently of prompt-type/stack relevance scoping (which bounds WHICH
 * skills get in, not how big any one of them is).
 */
const CLAUDE_SKILL_MAX_TEMPLATE_CHARS = 6_000;

/** Truncate an oversized `.claude/skills/` template body, leaving a clear marker + the source path for follow-up. */
function truncateClaudeSkillTemplate(template: string, sourcePath: string): string {
  if (template.length <= CLAUDE_SKILL_MAX_TEMPLATE_CHARS) return template;
  const truncated = template.slice(0, CLAUDE_SKILL_MAX_TEMPLATE_CHARS).trimEnd();
  return `${truncated}\n\n[...truncated at ${CLAUDE_SKILL_MAX_TEMPLATE_CHARS} of ${template.length} chars — full skill at ${sourcePath}...]`;
}

/**
 * Keyword → (domain, applicable prompt types) hints used to classify a real Claude Skill that
 * declares no `tags`/`applicablePromptTypes` (the real Claude Skill spec has neither — only
 * `name`/`description`). Matched against `name + ' ' + description` (falling back to the first
 * 2000 chars of the skill body when a skill omits `description`), case-insensitively, substring.
 * Deliberately keyword-general — NOT keyed to any specific skill name — so a future skill
 * installed via `npx skills add`/`git clone` is classified the same way with no code change, per
 * the same "never fabricate applicability, degrade to unclassified" posture as the rest of this
 * module: a skill matching none of these hints gets `applicablePromptTypes: []` and is simply
 * never injected (safe default), rather than guessed into every prompt.
 */
const CLAUDE_SKILL_KEYWORD_HINTS: ReadonlyArray<{
  domain: string;
  promptTypes: readonly string[];
  keywords: readonly string[];
}> = [
  {
    domain: 'frontend',
    promptTypes: ['ui', 'component', 'page', 'feature'],
    keywords: [
      'frontend', 'front-end', 'landing page', 'design system', 'visual design', 'typography',
      'tailwind', 'component', 'portfolio', 'aesthetic', 'design direction', 'interface design',
      'styling', 'responsive design', 'web design', 'ui design', 'ux design', 'design taste',
    ],
  },
  {
    domain: 'backend',
    promptTypes: ['api', 'schema', 'feature'],
    keywords: ['backend', 'back-end', 'rest api', 'graphql api', 'database schema', 'server-side', 'endpoint design'],
  },
  {
    domain: 'agent',
    promptTypes: ['agent'],
    keywords: ['ai agent', 'llm agent', 'agentic workflow', 'tool calling', 'prompt engineering'],
  },
  {
    domain: 'testing',
    promptTypes: ['test'],
    keywords: ['test coverage', 'unit testing', 'e2e testing', 'test strategy', 'testing skill'],
  },
  {
    domain: 'deploy',
    promptTypes: ['deploy'],
    keywords: ['deployment pipeline', 'ci/cd', 'devops', 'infrastructure as code'],
  },
];

/** Classify free text against {@link CLAUDE_SKILL_KEYWORD_HINTS}. Multiple hints may match; prompt types union, first-matched hint's domain wins. */
function inferPromptTypesAndDomain(text: string): { promptTypes: string[]; domain: string } {
  const lower = text.toLowerCase();
  const promptTypes = new Set<string>();
  let domain = 'general';
  for (const hint of CLAUDE_SKILL_KEYWORD_HINTS) {
    if (hint.keywords.some((k) => lower.includes(k))) {
      for (const t of hint.promptTypes) promptTypes.add(t);
      if (domain === 'general') domain = hint.domain;
    }
  }
  return { promptTypes: [...promptTypes], domain };
}

/**
 * Parse one real `<skillsDir>/<name>/SKILL.md` into a {@link Skill}. Reuses
 * {@link parseSkillContent} for the base id/name/domain/tags/applicablePromptTypes/template
 * extraction (the same leading `---`…`---` YAML-frontmatter shape this repo's own templates use
 * — confirmed against the real installed `design-taste-frontend/SKILL.md`, not assumed), then:
 *   - infers `applicablePromptTypes`/`domain` via {@link inferPromptTypesAndDomain} when the
 *     frontmatter declared none (true for every real Claude Skill seen so far — they carry only
 *     `name`/`description`), using the frontmatter `description` (re-read directly — `Skill` has
 *     no `description` field) when present, else the template body itself;
 *   - caps the template body via {@link truncateClaudeSkillTemplate}.
 * Returns `null` on a missing/unreadable file or malformed frontmatter — skipped, never thrown.
 */
function parseClaudeSkillFile(filePath: string, fallbackId: string): Skill | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const base = parseSkillContent(raw, fallbackId);
  if (!base) return null;

  let description = '';
  try {
    const match = FRONTMATTER_RE.exec(raw);
    const parsed = match ? (parseYaml(match[1] ?? '') as Record<string, unknown> | null) : null;
    if (parsed && typeof parsed.description === 'string') description = parsed.description.trim();
  } catch {
    /* malformed frontmatter already handled by parseSkillContent above — inference just falls back to the body */
  }

  const needsInference = base.applicablePromptTypes.length === 0;
  const inferenceText = `${base.name} ${description}`.trim() || base.template.slice(0, 2000);
  const inferred = needsInference ? inferPromptTypesAndDomain(inferenceText) : null;

  return {
    ...base,
    domain: base.domain === 'general' && inferred ? inferred.domain : base.domain,
    applicablePromptTypes: needsInference && inferred ? inferred.promptTypes : base.applicablePromptTypes,
    template: truncateClaudeSkillTemplate(base.template, filePath),
  };
}

/**
 * The two locations a real Claude Skill can be installed, in resolution order — the identical
 * pattern `design-system-generator.ts`'s `resolveScriptPath` uses for the UI/UX Pro Max skill:
 * (1) `.claude/skills/` bundled with THIS FORGE install (walked up from this compiled module,
 * same as {@link defaultSkillsLibraryDir}, since `.claude/` lives at the repo root alongside
 * `src/`/`dist/`), and (2) `~/.claude/skills/`, the per-machine install location `npx skills add`/
 * `git clone` write to. Deliberately NOT `<projectPath>/.claude/skills/` (the target project being
 * built) — matching `resolveScriptPath`, this is about which skills are installed on THIS
 * machine for FORGE itself to draw on, independent of which project a build targets. Deduplicated
 * (an 8-level ancestor walk can otherwise repeat a path); a directory need not exist yet.
 */
export function defaultClaudeSkillsDirs(): string[] {
  const candidates: string[] = [];
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
      candidates.push(join(dir, '.claude', 'skills'));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    candidates.push(join(process.cwd(), '.claude', 'skills'));
  }
  candidates.push(join(homedir(), '.claude', 'skills'));
  return [...new Set(candidates)];
}

/**
 * Scan every `<dir>/<skill-name>/SKILL.md` across `dirs` (non-recursive one level of skill-name
 * subfolders, each dir itself best-effort — one bad directory never blocks the others) into
 * {@link Skill}s via {@link parseClaudeSkillFile}. A skill id found in an earlier `dirs` entry
 * wins over a same-id later one (mirrors `resolveScriptPath`'s "first candidate that exists"
 * precedence: the FORGE-bundled install's own `.claude/skills/` shadows the same-named skill
 * under `~/.claude/skills/`). Never throws — a missing/unreadable directory contributes nothing.
 */
export function loadClaudeSkills(dirs: readonly string[]): Skill[] {
  const byId = new Map<string, Skill>();
  for (const dir of dirs) {
    try {
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      for (const name of entries) {
        const skillPath = join(dir, name, 'SKILL.md');
        if (!existsSync(skillPath)) continue;
        const skill = parseClaudeSkillFile(skillPath, name);
        if (skill && !byId.has(skill.id)) byId.set(skill.id, skill);
      }
    } catch {
      /* best-effort per-directory — keep whatever was parsed from other directories */
    }
  }
  return [...byId.values()];
}

/**
 * Detect `projectPath`'s stack, load every matching skill from BOTH sources — this repo's own
 * `src/skills/templates/*.skill.md` (via {@link defaultSkillsLibraryDir}) AND real Claude Skills
 * under `.claude/skills/` (via {@link defaultClaudeSkillsDirs}/{@link loadClaudeSkills}) — merged
 * into one {@link SkillsLibrary}, and return `promptText` with a `## ENGINEERING STANDARDS AND
 * PATTERNS FOR THIS BUILD` block prepended. Returns `promptText` unchanged when no stack is
 * detected (and no `promptType` was given), both sources are empty, or nothing matches — never
 * throws.
 *
 * When `promptType` is supplied (Phase 3 passes `entry.prompt_type` on every real build), skill
 * selection routes through {@link SkillsLibrary.getForPrompt} — the minimal, type-scoped set
 * (stack-tag-matched skills applicable to this prompt type, plus the curated "always relevant"
 * layer) — rather than {@link SkillsLibrary.injectIntoContext}'s plain stack-tag match, which
 * has no notion of prompt type and would otherwise inject every stack-matched skill into every
 * prompt regardless of whether it's a schema, api, ui, or deploy prompt. This is exactly why a
 * `.claude/skills/` entry's inferred `applicablePromptTypes` matters: it is what keeps e.g. a
 * design-taste skill out of a `schema`/`api`/`deploy` prompt and in only `ui`/`component`/`page`/
 * `feature` prompts, the same enforcement the curated templates already get. `promptType` is
 * deliberately optional: `forge skills inject` (a generic "paste any prompt text" debugging
 * command with no queue entry, hence no prompt type) still gets the broader stack-only match —
 * and, per {@link SkillsLibrary.injectIntoContext}'s own comment, that broader match deliberately
 * excludes tag-less `.claude/skills/` entries rather than blindly injecting them into every call.
 *
 * `claudeSkillsDirs` defaults to {@link defaultClaudeSkillsDirs}'s real on-machine resolution;
 * it exists as an explicit parameter (mirroring `loadSkillsLibrary(skillsDir)`'s own
 * resolved-value-as-param shape) so tests can point it at a disposable fixture directory instead
 * of this machine's real `.claude/skills/`/`~/.claude/skills/`.
 */
export function buildSkillsContext(
  projectPath: string,
  promptText: string,
  promptType?: string,
  claudeSkillsDirs: readonly string[] = defaultClaudeSkillsDirs()
): string {
  try {
    const stack = detectProjectStack(projectPath);
    if (!promptType && stack.length === 0) return promptText;
    const templateSkills = loadTemplateSkills(defaultSkillsLibraryDir());
    const claudeSkills = loadClaudeSkills(claudeSkillsDirs);
    if (templateSkills.length === 0 && claudeSkills.length === 0) return promptText;
    const library = buildLibraryFromSkills([...templateSkills, ...claudeSkills]);
    if (promptType) {
      const matching = library.getForPrompt(promptType, stack);
      if (matching.length === 0) return promptText;
      return `${renderSkillsBlock(matching)}\n\n---\n\n${promptText}`;
    }
    return library.injectIntoContext(promptText, stack);
  } catch {
    return promptText;
  }
}
