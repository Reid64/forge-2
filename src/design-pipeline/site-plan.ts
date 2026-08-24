/**
 * FORGE 2.0 — Design Pipeline: Site Page Plan (`src/design-pipeline/site-plan.ts`).
 *
 * WHAT IT DOES: turns a free-text multi-page site brief (e.g. `forge design site-tournament
 * --brief`) into a structured {@link SitePagePlan} — one {@link PageSpec} per real page, each
 * carrying its own template section list — so a multi-page tournament can generate every page as
 * its own `ComponentSpec` instead of stuffing an entire site brief into one component's
 * `description` (`design-tournament.ts`'s original, single-component-only behavior).
 *
 * EXTRACTION: a real Claude Code CLI call (`runClaude`, Contract 5) reads the brief and returns a
 * structured JSON page list — general-purpose, not a regex/keyword parser tailored to any one
 * brief's wording, so a future brief with a different page-list phrasing still extracts correctly.
 * Parsed via `tools/json-extraction.ts`'s `extractJsonObject` (the same tolerant-recovery strategy
 * `DecisionValidator`'s critic response uses). Never throws (Iron Law 3 / Contract 4): a failed
 * call, a timeout, or a response that doesn't parse into at least one page degrades to a single
 * synthetic `home` page carrying the ENTIRE brief text verbatim as its one section — never a
 * fabricated page list. The caller always gets back a usable (if degraded) plan.
 */

import { extractJsonObject } from '../tools/json-extraction.js';
import { runClaude } from '../engine/claude-runner.js';
import { logLine } from '../tools/forge-logger.js';

const log = logLine('site-plan');

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** One real page in the site. */
export interface PageSpec {
  /** URL-safe route segment, e.g. `'funding-intelligence'`. Unique within a {@link SitePagePlan}. */
  slug: string;
  /** PascalCase component-name stem derived from `slug` (e.g. `'FundingIntelligence'`) — combine with `Page`/a variant suffix for the real `ComponentSpec.name`. */
  name: string;
  /** Human-readable page title, e.g. `'Funding Intelligence'`. */
  title: string;
  /** `'hub'` — a top-level or section-overview page (Home, Platform overview, Solutions overview). `'sub'` — a page under a hub, following that hub's template. `'bespoke'` — a one-off page with its own layout. */
  kind: 'hub' | 'sub' | 'bespoke';
  /** For `kind: 'sub'`, the parent hub's `slug`. `null` otherwise. */
  parentSlug: string | null;
  /** Ordered section descriptions this page must include (the brief's own template, when it declares one) — folded into the generation prompt as an explicit section-by-section spec. */
  sections: string[];
  /** Any page-specific brief text beyond the shared template (e.g. a bespoke page's own content note). */
  note: string;
}

export interface SitePagePlan {
  pages: PageSpec[];
  /** `'llm-extracted'` when the real Claude Code CLI call produced a usable plan; `'fallback-single-page'` when it degraded to one synthetic Home page. */
  source: 'llm-extracted' | 'fallback-single-page';
  /** Non-fatal issues found while extracting/validating the plan (e.g. a page the model returned with no sections) — surfaced for human visibility, never silently dropped. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Slug/name helpers
// ---------------------------------------------------------------------------

/** Lowercase, hyphenated, alphanumeric-only route segment. */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s === '' ? 'page' : s;
}

/** `'funding-intelligence'` -> `'FundingIntelligence'`. */
export function slugToPascalCase(slug: string): string {
  const pascal = slug
    .split('-')
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return pascal === '' ? 'Page' : pascal;
}

// ---------------------------------------------------------------------------
// LLM-based extraction
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT =
  'You are a precise information-architecture extractor. You do not write copy or design ' +
  'anything. Given a website brief, extract the REAL page list and, for any page whose template ' +
  'is explicitly described, its ordered section list. Return JSON only, no preamble, no markdown ' +
  'fence, matching exactly this shape:\n' +
  '{"pages":[{"slug":"kebab-case-slug","title":"Human Title","kind":"hub"|"sub"|"bespoke",' +
  '"parentSlug":"kebab-case-slug-or-null","sections":["section 1 description", "..."],' +
  '"note":"any page-specific brief text beyond the shared template, or empty string"}]}\n' +
  'Rules: "hub" = a top-level page or a section-overview page (e.g. a "Platform overview" that ' +
  'several sub-pages sit under). "sub" = a page that follows a hub\'s declared per-page template ' +
  '— give it that EXACT section list, one entry per numbered section, in order. "bespoke" = a ' +
  'one-off page with no shared template — sections may be empty if the brief does not itemize ' +
  'them. Every page the brief names must appear exactly once. Do not invent pages the brief does ' +
  'not name. Do not omit a page the brief names.';

const GENERATION_TIMEOUT_MS = 15 * 60 * 1000;

function buildExtractionPrompt(briefText: string): string {
  return [EXTRACTION_SYSTEM_PROMPT, '', '--- SITE BRIEF ---', briefText, '', 'Respond with ONLY the JSON object described above.'].join(
    '\n'
  );
}

interface RawPage {
  slug?: unknown;
  title?: unknown;
  kind?: unknown;
  parentSlug?: unknown;
  sections?: unknown;
  note?: unknown;
}

/** Validate + coerce one raw extracted page entry into a {@link PageSpec}. Returns `null` (and pushes a warning) when the entry is unusable — e.g. no slug/title at all. */
function coercePage(raw: RawPage, index: number, warnings: string[]): PageSpec | null {
  const titleRaw = typeof raw.title === 'string' ? raw.title.trim() : '';
  const slugRaw = typeof raw.slug === 'string' && raw.slug.trim() !== '' ? raw.slug.trim() : titleRaw;
  if (slugRaw === '' && titleRaw === '') {
    warnings.push(`page ${index}: no slug or title in extracted JSON — skipped`);
    return null;
  }
  const slug = slugify(slugRaw !== '' ? slugRaw : titleRaw);
  const title = titleRaw !== '' ? titleRaw : slug;
  const kind: PageSpec['kind'] = raw.kind === 'hub' || raw.kind === 'sub' || raw.kind === 'bespoke' ? raw.kind : 'bespoke';
  const parentSlug = typeof raw.parentSlug === 'string' && raw.parentSlug.trim() !== '' ? slugify(raw.parentSlug) : null;
  const sections = Array.isArray(raw.sections) ? raw.sections.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
  if (kind === 'sub' && sections.length === 0) {
    warnings.push(`page '${slug}': kind 'sub' but no sections extracted — generation will proceed without a section-by-section spec`);
  }
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  return { slug, name: slugToPascalCase(slug), title, kind, parentSlug, sections, note };
}

/** Dedupe by slug (first occurrence wins), warning about any collision — a page must map to exactly one route. */
function dedupePages(pages: readonly PageSpec[], warnings: string[]): PageSpec[] {
  const bySlug = new Map<string, PageSpec>();
  for (const page of pages) {
    if (bySlug.has(page.slug)) {
      warnings.push(`duplicate slug '${page.slug}' in extracted plan — kept the first occurrence, dropped the rest`);
      continue;
    }
    bySlug.set(page.slug, page);
  }
  return [...bySlug.values()];
}

/** A single synthetic Home page carrying the whole brief verbatim — the safe, honest degrade when extraction fails. */
function fallbackSinglePagePlan(briefText: string): SitePagePlan {
  return {
    pages: [
      {
        slug: 'home',
        name: 'Home',
        title: 'Home',
        kind: 'hub',
        parentSlug: null,
        sections: [],
        note: briefText,
      },
    ],
    source: 'fallback-single-page',
    warnings: ['page-plan extraction failed or returned no usable pages — degraded to a single synthetic Home page carrying the whole brief'],
  };
}

/**
 * Extract a {@link SitePagePlan} from `briefText` via a real Claude Code CLI call. Never throws:
 * a CLI failure/timeout or an unparseable/empty response degrades to
 * {@link fallbackSinglePagePlan}. `runClaudeImpl` is injectable for tests (mirrors
 * `DecisionValidator`'s `runClaudeImpl` house pattern) — defaults to the real `runClaude`.
 */
export async function derivePagePlan(
  briefText: string,
  projectPath: string,
  options: {
    runClaudeImpl?: (prompt: string, cwd: string) => Promise<{ success: boolean; stdout: string; timedOut: boolean; exitCode: number | null; stderr: string }>;
    log?: (message: string) => void;
  } = {}
): Promise<SitePagePlan> {
  const logger = options.log ?? log;
  const runClaudeImpl =
    options.runClaudeImpl ?? ((prompt: string, cwd: string) => runClaude(prompt, { cwd, timeoutMs: GENERATION_TIMEOUT_MS, log: logger }));

  if (briefText.trim() === '') {
    logger('WARNING: [SITE PLAN] empty brief — degrading to fallback single-page plan');
    return fallbackSinglePagePlan(briefText);
  }

  let run: { success: boolean; stdout: string; timedOut: boolean; exitCode: number | null; stderr: string };
  try {
    run = await runClaudeImpl(buildExtractionPrompt(briefText), projectPath);
  } catch (error) {
    logger(`WARNING: [SITE PLAN] extraction call threw (${error instanceof Error ? error.message : String(error)}) — degrading to fallback`);
    return fallbackSinglePagePlan(briefText);
  }

  if (!run.success) {
    const reason = run.timedOut ? 'timed out' : `exited ${run.exitCode ?? 'null'}`;
    logger(`WARNING: [SITE PLAN] extraction call failed (${reason}) — degrading to fallback single-page plan`);
    return fallbackSinglePagePlan(briefText);
  }

  const parseWarnings: string[] = [];
  const parsed = extractJsonObject(run.stdout, (msg) => parseWarnings.push(msg));
  const rawPages = parsed && Array.isArray(parsed['pages']) ? (parsed['pages'] as unknown[]) : null;
  if (!rawPages || rawPages.length === 0) {
    logger('WARNING: [SITE PLAN] extraction response did not contain a usable "pages" array — degrading to fallback single-page plan');
    return fallbackSinglePagePlan(briefText);
  }

  const warnings: string[] = [...parseWarnings];
  const coerced = rawPages
    .map((raw, index) => coercePage((raw ?? {}) as RawPage, index, warnings))
    .filter((p): p is PageSpec => p !== null);
  const pages = dedupePages(coerced, warnings);

  if (pages.length === 0) {
    logger('WARNING: [SITE PLAN] every extracted page entry was unusable — degrading to fallback single-page plan');
    return fallbackSinglePagePlan(briefText);
  }

  logger(`[SITE PLAN] extracted ${pages.length} page(s): ${pages.map((p) => p.slug).join(', ')}`);
  for (const w of warnings) logger(`WARNING: [SITE PLAN] ${w}`);

  return { pages, source: 'llm-extracted', warnings };
}
