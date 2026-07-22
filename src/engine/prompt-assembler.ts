/**
 * FORGE 2.0 — Prompt Assembler (Phase 3 Build Executor engine, queue.yaml s5-p01).
 *
 * Builds the COMPLETE prompt that the {@link runClaude} runner pipes to Claude Code for a
 * single queue entry. Per BEHAVIORAL_CONTRACTS.md Contract 7 (Context Injection), prompts
 * are NEVER hardcoded — they are ALWAYS assembled at execution time from four sources, in
 * this order:
 *
 *   1. The queue entry's task description (from queue.yaml — see the Queue Generator s4-p02).
 *   2. RELEVANT governance excerpts — only the slices the entry actually needs, selected by
 *      its `governance_refs` (which documents) + `context_injection` (which sections within
 *      them: schema tables, behavioral-contract headings, interaction-map features). When an
 *      entry has no fine-grained marker for a document, the Governance Router
 *      (`governance-router.ts`) selects the sections relevant to the entry's `prompt_type`
 *      instead of an arbitrary head-of-document overview — a `schema` prompt does not need
 *      UI-contract text, a `ui` prompt does not need schema-migration rules.
 *   3. Build Memory WARNINGS — known `error_patterns` whose `trigger_prompt_pattern` matches
 *      this entry's `prompt_type` and whose recorded stacks match the build's stack, rendered
 *      as "watch out for / prevention" guidance (Contract 8 leans on the same data).
 *   4. The Sentinel status from the PREVIOUS prompt, if any (Contract 13 health-check result),
 *      so the model knows whether the last step is healthy and what failed if not.
 *
 * A queue.yaml extension to Contract 7 adds an OPTIONAL fourth context source: the Codebase RAG
 * `relevantFilesBlock` (the existing project files most relevant to this task), injected before the
 * footer when supplied so the model does not duplicate or conflict with code that already exists.
 *
 * Finally it appends the mandatory state-audit footer (BLUEPRINT Canonical Rule 9 / Iron Law)
 * and returns the assembled text together with its SHA-256 hash (the hash is what
 * `prompt_executions.prompt_hash` stores and what the rewriter compares against).
 *
 * MODEL SELECTION IS AUTOMATIC: every assembly also routes the prompt to a Claude model via the
 * Model Router (`selectModel`, keyed on `entry.prompt_type` and the `isRecovery` flag) and
 * returns the {@link ModelSelection} on the result, so the executor never has to choose a model
 * by hand. When an optional {@link ModelCostTracker} is supplied, the assembler logs an
 * ESTIMATED token cost for this prompt on the selected model (input tokens from the assembled
 * prompt length, output tokens from the entry's `estimated_tokens` budget) — an estimate for
 * telemetry/budgeting, not an invoice (Iron Law 3).
 *
 * DETERMINISTIC + NON-FATAL: given the same inputs the output is identical (the hash is
 * stable). Build Memory access degrades gracefully (Contract 4 — a warning fetch that fails
 * yields zero warnings, never an error). `assemblePrompt` never throws.
 *
 * The warning fetch is injectable (`options.fetchWarnings`) so the assembler can be unit
 * tested without a database, and so the executor can pass a pre-filtered set.
 */

import { createHash } from 'node:crypto';

import type { ContextInjection, PromptType, QueueEntry } from './queue-generator.js';
import type { StackFingerprint } from '../tools/stack-detector.js';
import type { ErrorPattern, JsonObject } from '../types/index.js';
import { BuildMemory } from '../memory/index.js';
import { filterRetiredPatterns } from '../learning/retirement-filter.js';
import { parseGovernanceSections, routeGovernanceSections } from './governance-router.js';
import {
  selectModel,
  estimateModelCostFromBudget,
  ModelCostTracker,
} from './model-router.js';
import type { ClaudeModel, ModelSelection, ModelRouterOptions } from './model-router.js';
import { logLine } from '../tools/forge-logger.js';
import { handlePreToolUse } from '../learning/hooks-enhanced.js';
import { injectSharedPreamble } from './shared-preamble.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * The mandatory footer appended to every assembled prompt (queue.yaml s5-p01 step 5).
 * Verbatim — the executor and any audit tooling match on this exact string.
 */
export const STATE_AUDIT_FOOTER =
  'Update STATE_OF_THE_BUILD.md and SESSION_STATE.md from actual codebase audit before session ends.';

/**
 * Mandatory rule prepended to EVERY assembled prompt, ahead of all other content — FORGE alone
 * owns branch switching (see the executor's checkout-before/after-run guard) and a Claude run
 * that checks out a different branch mid-task silently desyncs the executor's tracked branch
 * from the branch actually on disk. Verbatim — the executor and any audit tooling match on this
 * exact string.
 */
export const GIT_BRANCH_RULE =
  'CRITICAL GIT RULE: Never run git checkout, git switch, or any command that changes the ' +
  'current git branch. Never run git checkout main or git checkout master. FORGE manages ' +
  'branch switching — you must stay on whatever branch you are currently on. Only run git add ' +
  'and git commit to stage and commit your work.';

/** Max characters of any single governance document injected (keeps prompts bounded). */
const MAX_GOVERNANCE_CHARS_PER_DOC = 6000;
/** Max characters of the head-overview fallback when no specific section matched. */
const MAX_OVERVIEW_CHARS = 1800;
/**
 * Per-document overrides of the head-overview cap. DESIGN_SYSTEM.md has no fine-grained
 * `context_injection` sections (it always falls through to `headOverview`), but its palette
 * / typography / spacing token tables ARE the payload — capping it at the generic
 * {@link MAX_OVERVIEW_CHARS} would truncate the tokens a UI prompt needs. Documents not
 * listed here use {@link MAX_OVERVIEW_CHARS}.
 */
const OVERVIEW_CHARS_BY_DOC: Readonly<Record<string, number>> = {
  'DESIGN_SYSTEM.md': MAX_GOVERNANCE_CHARS_PER_DOC,
};

/** Resolve the head-overview character cap for a governance document by its exact filename. */
function overviewCapForDoc(docName: string): number {
  return OVERVIEW_CHARS_BY_DOC[docName] ?? MAX_OVERVIEW_CHARS;
}
/** Max number of Build Memory warnings injected (highest occurrence first). */
const MAX_WARNINGS = 8;
/** Heuristic characters-per-token used to size the prompt's input-token estimate (matches the Claude Runner). */
const CHARS_PER_TOKEN = 4;

/**
 * The Sentinel result of the PREVIOUS prompt, as carried forward into this prompt
 * (Contract 13). A minimal shape — Phase 4 Sentinel (a later s5 prompt) produces the
 * full record; only what the assembler renders is required here.
 */
export interface PreviousSentinelStatus {
  /** Name of the previous prompt (for the heading). */
  promptName?: string;
  /** 1-based index of the previous prompt. */
  promptIndex?: number;
  /** Whether ALL Sentinel health checks passed (Contract 13). */
  passed: boolean;
  /** Human-readable failed-check descriptions to surface to the model (if any). */
  failures?: string[];
  /** Optional structured breakdown (rendered compactly when no `failures` given). */
  details?: JsonObject | null;
}

/** Inputs to {@link assemblePrompt}. */
export interface AssembleInput {
  /** The queue entry being executed (carries description, governance_refs, context_injection). */
  entry: QueueEntry;
  /**
   * Governance document contents by filename (e.g. `{ 'SCHEMA_REGISTRY.md': '…' }`). Only
   * documents listed in `entry.governance_refs` are consulted; missing ones are skipped
   * (a note is added so the gap is visible, not silent).
   */
  governanceDocs: Record<string, string>;
  /** The build's stack fingerprint, used to scope Build Memory warnings. Optional. */
  stackFingerprint?: StackFingerprint | null;
  /** Sentinel status from the previous prompt, if this is not the first. Optional. */
  previousSentinel?: PreviousSentinelStatus | null;
  /**
   * Pre-rendered "existing project files relevant to this task" block from the Codebase RAG
   * (`renderRelevantFiles` / `CodebaseRag.contextBlock`) — a queue.yaml extension to Contract 7
   * adding a FOURTH, codebase-grounded context source so Claude knows what already exists and does
   * not duplicate or conflict with it. Injected verbatim (before the state-audit footer) and so
   * IS part of the hashed prompt. Empty/absent → nothing injected (the common case for an empty
   * codebase). Optional — the assembler degrades to the four original sources without it.
   */
  relevantFilesBlock?: string;
  /**
   * Absolute path of the target project root (Session 5.2 Task 3 — project-boundary guard). When
   * supplied, a preamble states it explicitly and instructs claude that every file operation for
   * this task must stay confined to it. Optional so existing callers/tests are unaffected.
   */
  projectPath?: string;
  /**
   * Pre-rendered CrossProjectKnowledgeTransfer block (`src/learning/cross-project-transfer.ts`
   * `TransferResult.contextBlock`) — stack-compatible, non-retired lessons pushed from prior
   * FORGE builds. Injected verbatim (before the state-audit footer), same mechanism as
   * {@link relevantFilesBlock}. Empty/absent → nothing injected (no compatible insights on record).
   */
  crossProjectInsightsBlock?: string;
}

/** Options for {@link assemblePrompt}. */
export interface AssemblerOptions {
  /**
   * Override the Build Memory warning fetch (tests / pre-filtered sets). Given the prompt
   * type and stack, returns the matching error patterns. Default: query `error_patterns`
   * by `trigger_prompt_pattern` and filter by stack. Must never throw (degrade to []).
   */
  fetchWarnings?: (
    promptType: PromptType,
    stackFingerprint: StackFingerprint | null
  ) => Promise<ErrorPattern[]>;
  /**
   * True when this assembly is for a Contract-14 Autonomous-Recovery re-run — forces the
   * Model Router's simple (Haiku) tier regardless of prompt type. Default false.
   */
  isRecovery?: boolean;
  /** Overrides for the Model Router's routing/pricing tables (tests / tuning). */
  modelRouter?: ModelRouterOptions;
  /**
   * When supplied, the assembler records this prompt's ESTIMATED token cost on the selected
   * model into the tracker (per model per prompt). Optional — selection happens either way.
   */
  costTracker?: ModelCostTracker;
  /** Progress reporter. Default logs to the console with a `[FORGE:assembler]` prefix. */
  log?: (message: string) => void;
}

/** The result of {@link assemblePrompt}. */
export interface AssembledPrompt {
  /** The complete assembled prompt text. */
  prompt: string;
  /** Lowercase hex SHA-256 of `prompt` (for `prompt_executions.prompt_hash`). */
  hash: string;
  /** Governance documents actually injected (some content found). */
  governanceDocsUsed: string[];
  /** Governance documents referenced but absent from `governanceDocs`. */
  governanceDocsMissing: string[];
  /** Number of Build Memory warnings injected. */
  warningsInjected: number;
  /** The Claude model this prompt was routed to (Model Router). */
  model: ClaudeModel;
  /** The full routing decision (tier, reason, pricing) for telemetry. */
  modelSelection: ModelSelection;
  /** Estimated USD cost of running this prompt on the selected model (input + output). */
  estimatedCostUsd: number;
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

/** Lowercase hex SHA-256 of a string. */
export function hashPrompt(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Governance excerpt extraction (markdown section slicing)
// ---------------------------------------------------------------------------

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

/** True when a heading text matches any matcher (case-insensitive substring, both ways). */
function headingMatches(headingText: string, matchers: string[]): boolean {
  const h = headingText.toLowerCase();
  for (const raw of matchers) {
    const m = raw.trim().toLowerCase();
    if (m === '') continue;
    if (h.includes(m) || m.includes(h)) return true;
  }
  return false;
}

/**
 * Extract the markdown sections whose heading matches any `matcher`, including each
 * matched section's nested subsections (until the next heading of an equal-or-higher
 * level). Overlapping ranges are merged. Returns the joined slice (capped), or `null`
 * when nothing matched.
 */
function extractMatchingSections(md: string, matchers: string[], maxChars: number): string | null {
  const cleaned = matchers.map((s) => s.trim()).filter((s) => s !== '');
  if (cleaned.length === 0) return null;

  const lines = md.split(/\r?\n/);
  const headings = parseHeadings(lines);
  if (headings.length === 0) return null;

  // Collect [start, end) line ranges for every matched heading + its subsections.
  const ranges: Array<[number, number]> = [];
  for (let h = 0; h < headings.length; h++) {
    const heading = headings[h];
    if (heading === undefined || !headingMatches(heading.text, cleaned)) continue;
    let end = lines.length;
    for (let k = h + 1; k < headings.length; k++) {
      const next = headings[k];
      if (next !== undefined && next.level <= heading.level) {
        end = next.line;
        break;
      }
    }
    ranges.push([heading.line, end]);
  }
  if (ranges.length === 0) return null;

  // Merge overlapping / adjacent ranges (matched ranges can nest or abut).
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const blocks = merged.map(([start, end]) => lines.slice(start, end).join('\n').trim()).filter((b) => b !== '');
  if (blocks.length === 0) return null;
  return capText(blocks.join('\n\n'), maxChars);
}

/** The document's leading overview: everything up to the second heading, capped. */
function headOverview(md: string, maxChars: number): string {
  const lines = md.split(/\r?\n/);
  const headings = parseHeadings(lines);
  // End at the 2nd heading (keep the title + intro), or take the whole doc if fewer.
  const secondHeading = headings[1];
  const end = secondHeading !== undefined ? secondHeading.line : lines.length;
  return capText(lines.slice(0, end).join('\n').trim(), maxChars);
}

/** Truncate `text` to `maxChars`, appending a clear marker when cut. */
function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n\n…[excerpt truncated]`;
}

/**
 * Resolve the section matchers for a given governance document from the entry's
 * `context_injection`. SCHEMA_REGISTRY → table names; BEHAVIORAL_CONTRACTS → section
 * headings; INTERACTION_MAPS → feature + element labels. Other docs have no fine-grained
 * markers and fall back to a head overview.
 */
function matchersForDoc(docName: string, ci: ContextInjection): string[] {
  const upper = docName.toUpperCase();
  if (upper.includes('SCHEMA_REGISTRY')) return ci.schemaSections;
  if (upper.includes('BEHAVIORAL_CONTRACTS')) return ci.behavioralSections;
  if (upper.includes('INTERACTION_MAPS')) {
    // Each entry is "feature: element" — match on either half (and the whole label).
    const out = new Set<string>();
    for (const label of ci.interactionMaps) {
      out.add(label);
      const colon = label.indexOf(':');
      if (colon >= 0) {
        const feature = label.slice(0, colon).trim();
        const element = label.slice(colon + 1).trim();
        if (feature !== '') out.add(feature);
        if (element !== '') out.add(element);
      }
    }
    return [...out];
  }
  return [];
}

/**
 * Governance docs considered for every prompt regardless of the entry's own `governance_refs` —
 * Iron Laws (CLAUDE.md) and the current build-state summary (STATE_OF_THE_BUILD.md) are relevant
 * to every prompt type (see governance-router.ts). Best-effort: a project without one of these
 * docs yet (or a CLAUDE.md-less target project) is not treated as "missing" governance the way an
 * explicitly referenced-but-absent doc is.
 */
const ALWAYS_GOVERNANCE_DOCS: readonly string[] = ['STATE_OF_THE_BUILD.md', 'CLAUDE.md'];

/** Build the governance section of the prompt; returns the text plus used/missing doc lists. */
function buildGovernanceSection(input: AssembleInput): {
  text: string;
  used: string[];
  missing: string[];
} {
  const used: string[] = [];
  const missing: string[] = [];
  const parts: string[] = [];

  const referenced = input.entry.governance_refs;
  const docNames = [...referenced];
  for (const alwaysDoc of ALWAYS_GOVERNANCE_DOCS) {
    if (!docNames.includes(alwaysDoc)) docNames.push(alwaysDoc);
  }

  for (const docName of docNames) {
    const content = input.governanceDocs[docName];
    const isAlwaysOnly = !referenced.includes(docName);
    if (content === undefined || content.trim() === '') {
      if (!isAlwaysOnly) missing.push(docName);
      continue;
    }

    const matchers = matchersForDoc(docName, input.entry.context_injection);
    let excerpt: string;
    if (matchers.length > 0) {
      // The entry names exact table / contract / interaction-map sections it needs — honor
      // that precisely.
      excerpt =
        extractMatchingSections(content, matchers, MAX_GOVERNANCE_CHARS_PER_DOC) ??
        headOverview(content, overviewCapForDoc(docName));
    } else {
      // No fine-grained ask from this entry. Governance Router (token efficiency): split the
      // doc into logical sections and keep only the ones relevant to THIS prompt type instead
      // of an arbitrary head-of-document overview — the actual source of the 60-70% wasted
      // governance-injection tokens this router fixes.
      const sections = parseGovernanceSections(docName, content);
      const routed = routeGovernanceSections(input.entry.prompt_type, sections);
      if (routed.length === 0) continue; // nothing in this doc applies to this prompt type
      excerpt = capText(routed.map((s) => s.content).join('\n\n'), overviewCapForDoc(docName));
    }

    used.push(docName);
    parts.push(`### ${docName}\n\n${excerpt}`);
  }

  const lines: string[] = ['## Governance (authoritative — follow exactly)'];
  if (parts.length > 0) lines.push(parts.join('\n\n'));
  if (missing.length > 0) {
    lines.push(
      `> NOTE: referenced governance not provided to the assembler: ${missing.join(', ')}. ` +
        `Read ${missing.length === 1 ? 'it' : 'them'} from the project's governance/ directory before proceeding.`
    );
  }
  return { text: lines.join('\n\n'), used, missing };
}

// ---------------------------------------------------------------------------
// Build Memory warnings
// ---------------------------------------------------------------------------

/** True when an error pattern's recorded stacks are relevant to the build's stack. */
function patternMatchesStack(pattern: ErrorPattern, stack: StackFingerprint | null): boolean {
  // A pattern with no recorded stacks is considered stack-agnostic (applies broadly).
  if (!Array.isArray(pattern.stack_fingerprints) || pattern.stack_fingerprints.length === 0) {
    return true;
  }
  if (!stack) return true; // no stack to scope by → don't drop the warning
  const scalars = [stack.framework, stack.language, stack.database, stack.deployment, stack.packageManager]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .map((v) => v.toLowerCase());
  if (scalars.length === 0) return true;
  for (const raw of pattern.stack_fingerprints) {
    const fp: unknown = raw; // DB jsonb — guard at runtime before reading values
    if (fp === null || typeof fp !== 'object' || Array.isArray(fp)) continue;
    for (const value of Object.values(fp)) {
      if (typeof value === 'string' && scalars.includes(value.toLowerCase())) return true;
    }
  }
  return false;
}

/** Default warning fetch: query error_patterns by prompt type, filter by stack. Never throws. */
async function defaultFetchWarnings(
  promptType: PromptType,
  stackFingerprint: StackFingerprint | null
): Promise<ErrorPattern[]> {
  const patterns = await BuildMemory.errors.findPatternsByPromptType(promptType);
  if (!patterns) return []; // stateless mode / query failure (Contract 4)
  const memoryDb = BuildMemory.getClient();
  const surviving = memoryDb ? filterRetiredPatterns(patterns, memoryDb) : patterns;
  return surviving.filter((p) => patternMatchesStack(p, stackFingerprint));
}

/** Render the Build Memory warnings section, or `null` when there are none. */
function buildWarningsSection(patterns: ErrorPattern[]): string | null {
  if (patterns.length === 0) return null;
  const shown = patterns.slice(0, MAX_WARNINGS);
  const bullets = shown.map((p) => {
    const pct = Math.round((p.success_rate ?? 0) * 100);
    const prevention =
      p.prevention_rule && p.prevention_rule.trim() !== ''
        ? ` Prevention: ${p.prevention_rule.trim()}`
        : '';
    return (
      `- [${p.error_category}] ${p.error_signature} ` +
      `(seen ${p.occurrence_count}×; resolution success ${pct}%).${prevention}`
    );
  });
  const omitted = patterns.length - shown.length;
  const footer = omitted > 0 ? `\n\n(+${omitted} more lower-frequency pattern(s) omitted.)` : '';
  return (
    '## Known failure patterns for this task type (from FORGE Build Memory)\n\n' +
    'Apply the prevention guidance proactively — these have bitten prior builds:\n\n' +
    bullets.join('\n') +
    footer
  );
}

// ---------------------------------------------------------------------------
// Previous Sentinel status
// ---------------------------------------------------------------------------

/** Render the previous prompt's Sentinel status, or `null` when none was supplied. */
function buildSentinelSection(status: PreviousSentinelStatus | null | undefined): string | null {
  if (!status) return null;
  const who =
    status.promptName || status.promptIndex !== undefined
      ? ` (prompt ${status.promptIndex ?? '?'}${status.promptName ? ` — ${status.promptName}` : ''})`
      : '';
  if (status.passed) {
    return (
      `## Previous Sentinel status${who}\n\n` +
      'The previous prompt PASSED all health checks (tsc, build, file integrity, schema drift, ' +
      'dependencies). The build is healthy — continue from this state.'
    );
  }
  const failures = (status.failures ?? []).map((f) => f.trim()).filter((f) => f !== '');
  const body =
    failures.length > 0
      ? `Failed checks:\n${failures.map((f) => `- ${f}`).join('\n')}`
      : status.details
        ? `Details: ${JSON.stringify(status.details)}`
        : 'No further detail was recorded.';
  return (
    `## Previous Sentinel status${who} — FAILED\n\n` +
    'The previous prompt did NOT pass Sentinel. Account for this and avoid repeating the ' +
    `failure:\n\n${body}`
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Assemble the complete Phase 3 prompt for a queue entry and return it with its SHA-256
 * hash (queue.yaml s5-p01). Composes, in order: the task description, the relevant
 * governance excerpts, Build Memory warnings for this prompt type + stack, the previous
 * prompt's Sentinel status (if any), and the mandatory state-audit footer.
 *
 * Never rejects: the only async work is the Build Memory warning fetch, which degrades to
 * an empty list on failure (Contract 4).
 */
export async function assemblePrompt(
  input: AssembleInput,
  options: AssemblerOptions = {}
): Promise<AssembledPrompt> {
  const log = options.log ?? logLine('assembler');
  const fetchWarnings = options.fetchWarnings ?? defaultFetchWarnings;
  const { entry } = input;

  // 0. Project-boundary preamble (Session 5.2 Task 3) — states the absolute root explicitly, first,
  //    before any other instruction, so claude never has to infer where it's allowed to write.
  const sections: string[] = [];
  if (input.projectPath) {
    sections.push(
      `## Project root (absolute)\n\n\`${input.projectPath}\`\n\n` +
        'Every file read, write, edit, and delete for this task MUST occur inside this directory. ' +
        'Never create, modify, or remove files anywhere else on the filesystem.'
    );
  }

  // 1. Task description (from the queue entry). Schema-type prompts get a mandatory
  //    file-write-first preamble at the very top, ahead of any apply/verify step in the
  //    description itself — a build must not skip writing migration files just because a
  //    later apply/verify command fails or is skipped.
  const schemaFileWritePreamble =
    entry.prompt_type === 'schema'
      ? 'IMPORTANT: Write all migration files to disk under supabase/migrations/ FIRST, ' +
        'before attempting any database apply or verification commands. File creation is ' +
        'mandatory and must complete regardless of whether the apply step succeeds.\n\n'
      : '';
  sections.push(
    `# FORGE build task: ${entry.name}\n\n` +
      `Prompt type: ${entry.prompt_type}. Execute the task below completely and to ` +
      `production quality — no placeholders, no mock data, real API calls to real tables.`,
    `## Task\n\n${schemaFileWritePreamble}${entry.description.trim()}`
  );

  // 2. Relevant governance excerpts.
  const governance = buildGovernanceSection(input);
  sections.push(governance.text);

  // 3. Build Memory warnings (guarded — never throws).
  let patterns: ErrorPattern[] = [];
  try {
    patterns = await fetchWarnings(entry.prompt_type, input.stackFingerprint ?? null);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`WARNING: warning fetch failed (${reason}) — proceeding with none`);
    patterns = [];
  }
  const warningsSection = buildWarningsSection(patterns);
  if (warningsSection) sections.push(warningsSection);

  // 4. Previous Sentinel status, if any.
  const sentinelSection = buildSentinelSection(input.previousSentinel);
  if (sentinelSection) sections.push(sentinelSection);

  // 4b. Codebase RAG — the relevant existing files (Contract 7 extension). Injected before the
  //     footer so it is part of the hashed prompt; empty when nothing is relevant.
  if (input.relevantFilesBlock && input.relevantFilesBlock.trim() !== '') {
    sections.push(input.relevantFilesBlock.trim());
  }

  // 4c. CrossProjectKnowledgeTransfer — stack-compatible, non-retired lessons pushed from prior
  //     builds (LEARNING_BLUEPRINT.md § CrossProjectKnowledgeTransfer). Same mechanism as 4b.
  if (input.crossProjectInsightsBlock && input.crossProjectInsightsBlock.trim() !== '') {
    sections.push(input.crossProjectInsightsBlock.trim());
  }

  // 5. Mandatory state-audit footer (verbatim).
  sections.push(STATE_AUDIT_FOOTER);

  // Query fix_patterns + governance_rules from forge_memory.db and prepend to the prompt.
  // Non-fatal: DB unavailable or query error → skip injection and continue.
  let learningContextPrefix = '';
  try {
    const techStackTags: string[] = input.stackFingerprint
      ? [
          input.stackFingerprint.framework,
          input.stackFingerprint.language,
          input.stackFingerprint.database,
          input.stackFingerprint.deployment,
          input.stackFingerprint.packageManager,
        ].filter((v): v is string => typeof v === 'string' && v !== '')
      : [];
    const preToolResult = await handlePreToolUse(entry.prompt_type, techStackTags, 0);
    if (preToolResult.contextInjection) {
      learningContextPrefix = preToolResult.contextInjection + '\n';
      log(
        `PreToolUse: injected ${preToolResult.rulesFound} governance rule(s) and ` +
          `${preToolResult.patternsFound} fix pattern(s) from forge_memory.db`
      );
    }
  } catch {
    // non-fatal — skip injection
  }

  // 5b. Shared preamble (token efficiency) — the universal build/commit/never-guess/scope rules
  //     are injected exactly once here rather than restated per queue.yaml entry; any equivalent
  //     restatement already present in the task description or governance excerpts is stripped
  //     first so the same instruction is never paid for twice in one prompt.
  const prompt = injectSharedPreamble(
    `${GIT_BRANCH_RULE}\n\n${learningContextPrefix}${sections.join('\n\n')}`
  );
  const hash = hashPrompt(prompt);

  // 6. Automatic model selection (Model Router) — keyed on prompt type + recovery flag.
  const modelSelection = selectModel(
    { promptType: entry.prompt_type, isRecovery: options.isRecovery ?? false },
    options.modelRouter ?? {}
  );

  // Estimate this prompt's cost on the selected model: input tokens from the assembled prompt
  // length (chars/4, matching the runner), output tokens from the entry's token budget.
  const inputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
  const outputTokens = Math.max(0, entry.estimated_tokens);
  const { costUsd: estimatedCostUsd } = estimateModelCostFromBudget(
    modelSelection.model,
    inputTokens + outputTokens,
    inputTokens / Math.max(1, inputTokens + outputTokens),
    modelSelection.pricing
  );

  // Log the cost estimate into the tracker (per model per prompt) when one was supplied.
  if (options.costTracker) {
    options.costTracker.record({
      selection: modelSelection,
      inputTokens,
      outputTokens,
      promptName: entry.name,
    });
  }

  log(
    `assembled "${entry.name}" — ${prompt.length} chars, ${governance.used.length} governance doc(s), ` +
      `${Math.min(patterns.length, MAX_WARNINGS)} warning(s), hash ${hash.slice(0, 12)}…; ` +
      `model ${modelSelection.model} [${modelSelection.tier}] ≈ $${estimatedCostUsd.toFixed(4)}`
  );

  return {
    prompt,
    hash,
    governanceDocsUsed: governance.used,
    governanceDocsMissing: governance.missing,
    warningsInjected: Math.min(patterns.length, MAX_WARNINGS),
    model: modelSelection.model,
    modelSelection,
    estimatedCostUsd,
  };
}

export default assemblePrompt;
