/**
 * FORGE 2.0 — Governance Router (Phase 3 Build Executor engine, token-efficiency pass).
 *
 * The problem: governance documents were being injected wholesale (or as an arbitrary
 * head-of-document overview) regardless of whether the current prompt actually needs that
 * content — a `schema` prompt does not need UI-contract text, a `ui` prompt does not need
 * schema-migration rules, wasting a large share of every prompt's governance-injection tokens.
 *
 * This module splits a governance document into logical sections (by level-2 `##` and level-3
 * `###` headings) and tags each section with the prompt types it is actually relevant to, so the
 * prompt assembler (`src/engine/prompt-assembler.ts`) can keep only the slices a given prompt
 * type needs instead of the whole document.
 *
 * Routing rules:
 *   - SCHEMA_REGISTRY.md            → every section: schema / database / migration prompts.
 *   - BEHAVIORAL_CONTRACTS.md       → per-section, by keyword: database/schema/migration/supabase
 *     keywords → schema/database/migration prompts; ui/component/accessibility/shadcn keywords →
 *     ui/component/page prompts; api/auth/rate-limit keywords → api/feature/auth prompts; agent
 *     keyword → agent prompts.
 *   - CLAUDE.md                     → only its Iron Laws section, tagged for every prompt type.
 *   - STATE_OF_THE_BUILD.md         → only its leading build-state summary, tagged for every
 *     prompt type (the per-session history below it is not universal payload).
 *   - Any other document            → every section is relevant to every prompt type (unchanged
 *     from prior behavior — this module does not narrow documents it has no routing rule for).
 */

/** One logical slice of a governance document, tagged with the prompt types it applies to. */
export interface GovernanceSection {
  /** The section's heading text (or a synthetic name for untitled leading content). */
  name: string;
  /** The section's full text, heading included. */
  content: string;
  /** Prompt types this section is relevant to. `'*'` matches every prompt type. */
  relevantPromptTypes: string[];
}

/** Tag meaning "relevant to every prompt type" (Iron Laws, build-state summary, unrouted docs). */
const WILDCARD = '*';

interface Heading {
  level: number;
  text: string;
  line: number;
}

/** Parse every ATX heading (`#`..`######`) in a markdown document. */
function parseHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      headings.push({ level: m[1].length, text: m[2].trim(), line: i });
    }
  }
  return headings;
}

/** Basename of a doc path/filename — works for a bare name (`'CLAUDE.md'`) or a full path. */
function baseName(docPath: string): string {
  const idx = Math.max(docPath.lastIndexOf('/'), docPath.lastIndexOf('\\'));
  return (idx >= 0 ? docPath.slice(idx + 1) : docPath).trim();
}

type DocKind = 'schema_registry' | 'behavioral_contracts' | 'claude' | 'state_of_the_build' | 'other';

/** Classify a governance document by its (base) filename. */
function classifyDoc(docPath: string): DocKind {
  const upper = baseName(docPath).toUpperCase();
  if (upper.includes('SCHEMA_REGISTRY')) return 'schema_registry';
  if (upper.includes('BEHAVIORAL_CONTRACTS')) return 'behavioral_contracts';
  if (upper === 'CLAUDE.MD') return 'claude';
  if (upper.includes('STATE_OF_THE_BUILD')) return 'state_of_the_build';
  return 'other';
}

/**
 * True when `keyword` appears in `haystack` (case-insensitive). A single token (no space/hyphen)
 * is matched on a word boundary so it cannot match inside a longer, unrelated word (`ui` inside
 * `build`, `api` inside `rapid`); a multi-word or hyphenated phrase (`rate-limit`, `iron law`) is
 * matched as a plain substring, which is safe enough for phrases of that length.
 */
function keywordMatches(haystack: string, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (k === '') return false;
  const h = haystack.toLowerCase();
  if (/[\s-]/.test(k)) return h.includes(k);
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(h);
}

interface KeywordRule {
  keywords: string[];
  promptTypes: string[];
}

/**
 * BEHAVIORAL_CONTRACTS.md routing rules: a section is relevant to a bucket of prompt types when
 * its heading + body mentions any of that bucket's keywords. A section can match more than one
 * rule (its tags union across every matching rule).
 */
const BEHAVIORAL_CONTRACTS_RULES: readonly KeywordRule[] = [
  { keywords: ['database', 'schema', 'migration', 'supabase'], promptTypes: ['schema', 'database', 'migration'] },
  { keywords: ['ui', 'component', 'accessibility', 'shadcn'], promptTypes: ['ui', 'component', 'page'] },
  { keywords: ['api', 'auth', 'rate-limit', 'rate limit'], promptTypes: ['api', 'feature', 'auth'] },
  { keywords: ['agent'], promptTypes: ['agent'] },
];

/** Resolve the `relevantPromptTypes` tag for one section, given its document's kind. */
function tagsForSection(kind: DocKind, headingText: string, sectionContent: string): string[] {
  switch (kind) {
    case 'schema_registry':
      // Every SCHEMA_REGISTRY.md section applies to schema/database/migration work, unconditionally.
      return ['schema', 'database', 'migration'];
    case 'behavioral_contracts': {
      const haystack = `${headingText}\n${sectionContent}`;
      const tags = new Set<string>();
      for (const rule of BEHAVIORAL_CONTRACTS_RULES) {
        if (rule.keywords.some((kw) => keywordMatches(haystack, kw))) {
          for (const t of rule.promptTypes) tags.add(t);
        }
      }
      return [...tags];
    }
    case 'claude':
      // Only the Iron Laws ride along with every prompt — the rest of CLAUDE.md (identity, tech
      // stack, quality gates, …) is FORGE's own operating doc, not per-prompt payload.
      return keywordMatches(`${headingText}\n${sectionContent}`, 'iron law') ? [WILDCARD] : [];
    case 'state_of_the_build':
      // Only the leading build-state summary (handled as the document's lead section below) is
      // universal; per-session history sections are not injected into every prompt.
      return [];
    case 'other':
    default:
      return [WILDCARD];
  }
}

/**
 * Split a governance document into logical sections by level-2 (`##`) and level-3 (`###`)
 * headings, tagging each with the prompt types it is relevant to. Leading content ahead of the
 * first level-2/3 heading (a title, an intro paragraph, STATE_OF_THE_BUILD.md's status block) is
 * kept as its own section — the current build-state summary for STATE_OF_THE_BUILD.md.
 */
export function parseGovernanceSections(docPath: string, docContent: string): GovernanceSection[] {
  const kind = classifyDoc(docPath);
  const lines = docContent.split(/\r?\n/);
  const boundaries = parseHeadings(lines).filter((h) => h.level === 2 || h.level === 3);

  const sections: GovernanceSection[] = [];

  const firstBoundaryLine = boundaries[0]?.line ?? lines.length;
  const lead = lines.slice(0, firstBoundaryLine).join('\n').trim();
  if (lead !== '') {
    const isStateSummary = kind === 'state_of_the_build';
    sections.push({
      name: isStateSummary ? 'Build state summary' : baseName(docPath) || 'Overview',
      content: lead,
      relevantPromptTypes: isStateSummary ? [WILDCARD] : tagsForSection(kind, '', lead),
    });
  }

  for (let i = 0; i < boundaries.length; i++) {
    const heading = boundaries[i];
    if (heading === undefined) continue;
    const next = boundaries[i + 1];
    const end = next !== undefined ? next.line : lines.length;
    const content = lines.slice(heading.line, end).join('\n').trim();
    if (content === '') continue;
    sections.push({
      name: heading.text,
      content,
      relevantPromptTypes: tagsForSection(kind, heading.text, content),
    });
  }

  return sections;
}

/**
 * Filter `allSections` down to those relevant to `promptType` — a section whose
 * `relevantPromptTypes` includes `promptType` or the `'*'` wildcard survives, everything else is
 * dropped. This is the core token-efficiency mechanism: a `schema` prompt never sees UI-contract
 * sections, a `ui` prompt never sees schema-migration sections.
 */
export function routeGovernanceSections(
  promptType: string,
  allSections: GovernanceSection[]
): GovernanceSection[] {
  return allSections.filter(
    (s) => s.relevantPromptTypes.includes(promptType) || s.relevantPromptTypes.includes(WILDCARD)
  );
}
