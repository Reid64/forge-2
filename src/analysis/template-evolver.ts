/**
 * FORGE 2.0 — Template Evolver (Phase 5 Recursive Learner, queue.yaml s6-p02).
 *
 * The SECOND analysis module. Where the Pattern Extractor (s6-p01) distils ONE build into
 * reusable intelligence, the Template Evolver reads ACROSS every recorded build and asks:
 * are FORGE's own governance templates getting better or worse, and which sections are dead
 * weight? It proposes — never applies — concrete, evidence-backed governance improvements,
 * per BEHAVIORAL_CONTRACTS Contract 16 (Template Evolution): a proposal MUST carry evidence
 * (which builds, what metric), an exact text diff, and an impact projection, and it becomes
 * active ONLY after a human approves it.
 *
 * THE FIVE STEPS (s6-p02 spec, verbatim):
 *   1. Load all `governance_versions` with their `effectiveness_score`s.
 *   2. Identify templates / sections with DECLINING effectiveness — per template, the
 *      effectiveness trend across successive `version_number`s (Pearson r of version↔score,
 *      plus the most-recent delta). A negative trend or a negative last-delta flags decline.
 *   3. Identify templates / sections NEVER referenced by build agents — a governance doc (or
 *      one of its `## ` sections) whose name/heading never appears in any executed prompt's
 *      assembled `prompt_content` (the same signal the Pattern Extractor's governance
 *      correlation reads). Unreferenced = injected context nobody used = a removal candidate.
 *   4. Correlate template versions with build success rates — the overall build success rate
 *      (completed / executed builds and completed / total prompts) as the backdrop, and the
 *      Pearson r between a version's `effectiveness_score` and its `builds_used_in` (do the
 *      more-effective template versions actually get reused more?). NOTE (Iron Law 3): the
 *      schema carries NO foreign key from `build_runs` to a per-template `governance_versions`
 *      row — `build_runs.governance_hash` hashes the WHOLE governance PACKAGE, not one
 *      template — so a precise per-version → per-build join is not derivable. The correlation
 *      is therefore computed from the recorded `effectiveness_score` / `builds_used_in` signal
 *      and the aggregate success rate, and that limitation is stated rather than papered over.
 *   5. Generate proposed changes, each with: an EXACT text diff (old section → new section),
 *      EVIDENCE (the builds counted + the metrics observed), and an EXPECTED IMPROVEMENT.
 *
 * STORAGE (step 6): each proposal is persisted as a NEW `governance_versions` row with
 * `change_source = 'recursive_learner'`. The `governance_versions` table has no `status`
 * column, so the "proposed, awaiting human approval" state of Contract 16 is encoded by the
 * `change_source` itself (a `recursive_learner` row is a PROPOSAL until a human promotes it —
 * `effectiveness_score` stays null until Phase 5 scores it) and the `changes_description`
 * is prefixed `PROPOSED:`. This is documented rather than silently assuming a column the
 * schema does not have (Iron Law 3).
 *
 * DETERMINISTIC + NON-DESTRUCTIVE: this module makes NO model calls (like the Queue Generator
 * and Phase 2) — the same inputs always yield the same proposals. The generated "new" section
 * text is a deterministic REVISION FLAG (the original section plus an HTML-comment annotation
 * recording why it was flagged), not a fabricated rewrite — the substantive rewrite is the
 * human's call at the Contract-16 approval gate. CRUCIALLY it writes ONLY a Build Memory
 * `governance_versions` ROW (the `content_snapshot` column); it NEVER edits BLUEPRINT.md /
 * SCHEMA_REGISTRY.md / any governance FILE on disk (Iron Law 1 / Contract 3).
 *
 * NON-FATAL house style (Contract 4): the analysis is PURE; every Build Memory read/write is
 * injectable and guarded — a DB outage degrades to stateless (the report is still returned;
 * nothing is stored) and never throws. `evolveTemplates` never rejects.
 *
 * BOUNDARY: reads `governance_versions` / `build_runs` / `prompt_executions`; writes
 * `governance_versions` (proposals only). Touches no governance file and no target project.
 */

import { createHash } from 'node:crypto';

import { logLine } from '../tools/forge-logger.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import type { NewGovernanceVersion } from '../memory/governance.js';
import type { BuildRun, GovernanceVersion, PromptExecution } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The kind of governance problem a proposal addresses. */
export type ProposalKind = 'declining_effectiveness' | 'unreferenced_section';

/** Effectiveness trend for a single governance template across its versions. */
export interface TemplateTrend {
  templateName: string;
  /** Versions of this template that carry an `effectiveness_score`, oldest first. */
  scoredVersions: number;
  /** The latest (highest version_number) recorded effectiveness score, or null. */
  latestScore: number | null;
  /** The previous version's score (for the most-recent delta), or null. */
  previousScore: number | null;
  /** latestScore − previousScore (negative = the latest version scored worse), or null. */
  lastDelta: number | null;
  /** The best effectiveness score this template ever recorded (the recovery target), or null. */
  bestScore: number | null;
  /** Pearson r of version_number ↔ effectiveness_score in [-1, 1] (the trend), or null. */
  trend: number | null;
  /** True when the trend is negative OR the most-recent delta is negative. */
  declining: boolean;
}

/** Whether a governance template (or a section of it) was referenced by any build agent. */
export interface ReferenceFinding {
  templateName: string;
  /** Section heading text (without the leading `## `), or null for the whole template. */
  section: string | null;
  /** How many executed prompts injected this template / section into their `prompt_content`. */
  referencedByPrompts: number;
  /** True when no executed prompt ever referenced it. */
  unreferenced: boolean;
}

/** The build-success backdrop the version correlation is read against. */
export interface BuildSuccessCorrelation {
  /** Builds whose status is a terminal one (completed / failed / halted). */
  terminalBuilds: number;
  /** Builds whose status is 'completed'. */
  completedBuilds: number;
  /** completedBuilds / terminalBuilds in [0, 1], or null when none are terminal. */
  buildSuccessRate: number | null;
  /** Σ completed_prompts / Σ total_prompts across all builds in [0, 1], or null. */
  promptSuccessRate: number | null;
  /**
   * Pearson r between a version's `effectiveness_score` and its `builds_used_in` across all
   * scored versions, in [-1, 1] — a proxy for "do more-effective templates get reused more?".
   * Null when fewer than two scored versions or zero variance. See module note on why a
   * precise per-version→per-build join is not derivable from the schema.
   */
  effectivenessAdoptionCorrelation: number | null;
}

/** A single, evidence-backed governance change proposal (Contract 16). */
export interface ProposedChange {
  templateName: string;
  kind: ProposalKind;
  /** Section heading the change targets (without `## `), or null for a whole-template note. */
  section: string | null;
  /** EXACT old text (the current section, verbatim from the latest content_snapshot). */
  oldText: string;
  /** EXACT new text (the deterministic revision flag — old text + an annotation). */
  newText: string;
  /** Human-readable evidence: which builds were counted and what metrics were observed. */
  evidence: string;
  /** Projected effectiveness improvement (e.g. recovery to the template's best score), in [0, 1]. */
  expectedImprovement: number;
  /** The version_number a stored proposal would carry (latest + 1 for this template). */
  proposedVersionNumber: number;
}

/** The pure analysis report (before any storage). */
export interface TemplateEvolutionReport {
  /** Distinct templates seen in `governance_versions`. */
  templatesAnalyzed: number;
  /** Total `governance_versions` rows considered. */
  versionsAnalyzed: number;
  /** Builds considered for the success-rate backdrop. */
  buildsAnalyzed: number;
  /** Executed prompts scanned for governance references. */
  promptsAnalyzed: number;
  trends: TemplateTrend[];
  references: ReferenceFinding[];
  correlation: BuildSuccessCorrelation;
  proposals: ProposedChange[];
  /** Non-fatal observations (no versions, stateless degrade, …). */
  warnings: string[];
  generatedAt: string;
}

/** What got persisted to Build Memory. */
export interface TemplateStorageResult {
  /** `governance_versions` proposal rows created. */
  proposalsStored: number;
  /** True when Build Memory was unreachable and nothing could be stored. */
  stateless: boolean;
  warnings: string[];
}

/** The full result of {@link evolveTemplates}. */
export interface TemplateEvolutionResult {
  report: TemplateEvolutionReport;
  storage: TemplateStorageResult;
}

/** Inputs to {@link evolveTemplates} (all optional — fetched from Build Memory when omitted). */
export interface EvolveTemplatesInput {
  /** All `governance_versions` (else `BuildMemory.governance.listAllVersions`). */
  versions?: GovernanceVersion[];
  /** Recent `build_runs` for the success backdrop (else `BuildMemory.builds.listBuilds`). */
  builds?: BuildRun[];
  /** Executed `prompt_executions` across builds, used for reference analysis (else fetched). */
  executions?: PromptExecution[];
}

/** Options for {@link evolveTemplates} — store toggle + injectable Build Memory I/O (tests). */
export interface TemplateEvolverOptions {
  /** Persist the proposals to Build Memory. Default true (set false for a pure analysis). */
  store?: boolean;
  /** How many recent builds to scan for the backdrop. Default 500. */
  buildScanLimit?: number;
  /** Fetch all governance versions. Default `BuildMemory.governance.listAllVersions` (→ []). */
  fetchVersions?: () => Promise<GovernanceVersion[]>;
  /** Fetch recent builds. Default `BuildMemory.builds.listBuilds` (→ []). */
  fetchBuilds?: () => Promise<BuildRun[]>;
  /**
   * Fetch executed prompts across builds for reference analysis. Default: the recent builds'
   * `prompt_executions` via `BuildMemory.prompts.getPromptsByBuild` (→ []). When the caller
   * supplies `input.executions`, this is not used.
   */
  fetchExecutions?: (builds: BuildRun[]) => Promise<PromptExecution[]>;
  /** Create a governance_versions proposal row. Default `BuildMemory.governance.createVersion`. */
  createVersion?: (input: NewGovernanceVersion) => Promise<GovernanceVersion | null>;
  /** Progress reporter. Default logs to the console with a `[FORGE:evolver]` prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Statuses that count a build as terminal (its outcome is final and countable). */
const TERMINAL_BUILD_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'halted']);

/** Default recent-build scan window. */
const DEFAULT_BUILD_SCAN_LIMIT = 500;

// ---------------------------------------------------------------------------
// Numeric helpers (pure) — mirror the Pattern Extractor's so stats stay consistent
// ---------------------------------------------------------------------------

/** Clamp a number into [lo, hi]; map non-finite to lo. */
function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/** Round to a fixed number of decimals. */
function round(n: number, decimals = 4): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/**
 * Pearson correlation of paired samples in [-1, 1], or null when undefined (< 2 pairs or one
 * variable has zero variance).
 */
function pearson(pairs: Array<[number, number]>): number | null {
  const n = pairs.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pairs) {
    sx += x;
    sy += y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    const dx = x - mx;
    const dy = y - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return clamp(sxy / Math.sqrt(sxx * syy), -1, 1);
}

/** Render an unknown thrown value as a short string for logging. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** SHA-256 hex of content (matches the governance-package hashing idiom). */
function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Markdown section parsing (pure)
// ---------------------------------------------------------------------------

/** A `## ` section sliced out of a governance document's content snapshot. */
export interface DocSection {
  /** Heading text without the leading `## ` (trimmed). */
  heading: string;
  /** The full section text including its heading line, verbatim. */
  text: string;
}

/**
 * Split a markdown content snapshot into its top-level (`## `) sections. Content before the
 * first `## ` heading is ignored for sectioning (it is the document title / preamble). A
 * document with no `## ` headings yields an empty list.
 */
export function parseSections(content: string): DocSection[] {
  const lines = content.split(/\r?\n/);
  const sections: DocSection[] = [];
  let current: { heading: string; body: string[] } | null = null;

  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match && match[1] !== undefined) {
      if (current) {
        sections.push({ heading: current.heading, text: current.body.join('\n') });
      }
      current = { heading: match[1].trim(), body: [line] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) {
    sections.push({ heading: current.heading, text: current.body.join('\n') });
  }
  return sections;
}

/** Significant lower-case word tokens of a heading (length ≥ 4, used for reference matching). */
function headingTokens(heading: string): string[] {
  return heading
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
}

// ---------------------------------------------------------------------------
// Dimension analyzers (pure)
// ---------------------------------------------------------------------------

/** Group versions by template name, each list ordered ascending by version_number. */
function groupByTemplate(versions: GovernanceVersion[]): Map<string, GovernanceVersion[]> {
  const groups = new Map<string, GovernanceVersion[]>();
  for (const v of versions) {
    const list = groups.get(v.template_name);
    if (list) list.push(v);
    else groups.set(v.template_name, [v]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.version_number - b.version_number);
  }
  return groups;
}

/** STEP 2 — per-template effectiveness trend + decline flag. */
function analyzeTrends(groups: Map<string, GovernanceVersion[]>): TemplateTrend[] {
  const trends: TemplateTrend[] = [];
  for (const [templateName, list] of groups) {
    const scored = list.filter(
      (v): v is GovernanceVersion & { effectiveness_score: number } =>
        typeof v.effectiveness_score === 'number' && Number.isFinite(v.effectiveness_score)
    );

    const latest = scored.length > 0 ? scored[scored.length - 1] : undefined;
    const previous = scored.length > 1 ? scored[scored.length - 2] : undefined;
    const latestScore = latest ? latest.effectiveness_score : null;
    const previousScore = previous ? previous.effectiveness_score : null;
    const lastDelta =
      latestScore !== null && previousScore !== null ? round(latestScore - previousScore) : null;
    const bestScore =
      scored.length > 0 ? Math.max(...scored.map((v) => v.effectiveness_score)) : null;

    const pairs: Array<[number, number]> = scored.map((v): [number, number] => [
      v.version_number,
      v.effectiveness_score,
    ]);
    const trend = pearson(pairs);

    const declining =
      (trend !== null && trend < 0) || (lastDelta !== null && lastDelta < 0);

    trends.push({
      templateName,
      scoredVersions: scored.length,
      latestScore: latestScore === null ? null : round(latestScore),
      previousScore: previousScore === null ? null : round(previousScore),
      lastDelta,
      bestScore: bestScore === null ? null : round(bestScore),
      trend: trend === null ? null : round(trend),
      declining,
    });
  }
  // Worst trend first (most declining surfaces at the top), then by template for stability.
  trends.sort(
    (a, b) => (a.trend ?? 1) - (b.trend ?? 1) || a.templateName.localeCompare(b.templateName)
  );
  return trends;
}

/** STEP 3 — template- and section-level reference analysis against executed prompts. */
function analyzeReferences(
  groups: Map<string, GovernanceVersion[]>,
  executions: PromptExecution[]
): ReferenceFinding[] {
  const findings: ReferenceFinding[] = [];
  const contents = executions
    .map((ex) => ex.prompt_content)
    .filter((c): c is string => typeof c === 'string' && c !== '');
  const lowerContents = contents.map((c) => c.toLowerCase());

  for (const [templateName, list] of groups) {
    // Template-level: how many executed prompts mention the doc name.
    const docRefs = contents.filter((c) => c.includes(templateName)).length;
    findings.push({
      templateName,
      section: null,
      referencedByPrompts: docRefs,
      unreferenced: docRefs === 0,
    });

    // Section-level: scan the LATEST version's `## ` sections. A section is "referenced" when
    // its heading (or a significant token of it) appears in any executed prompt_content.
    const latest = list[list.length - 1];
    if (!latest) continue;
    const sections = parseSections(latest.content_snapshot);
    for (const section of sections) {
      const headingLower = section.heading.toLowerCase();
      const tokens = headingTokens(section.heading);
      let refs = 0;
      for (const lc of lowerContents) {
        if (lc.includes(headingLower) || tokens.some((t) => lc.includes(t))) refs += 1;
      }
      findings.push({
        templateName,
        section: section.heading,
        referencedByPrompts: refs,
        unreferenced: refs === 0,
      });
    }
  }
  return findings;
}

/** STEP 4 — build-success backdrop + effectiveness↔adoption correlation. */
function analyzeCorrelation(
  versions: GovernanceVersion[],
  builds: BuildRun[]
): BuildSuccessCorrelation {
  const terminal = builds.filter((b) => TERMINAL_BUILD_STATUSES.has(b.status));
  const completedBuilds = terminal.filter((b) => b.status === 'completed').length;
  const buildSuccessRate =
    terminal.length > 0 ? round(completedBuilds / terminal.length) : null;

  let totalPrompts = 0;
  let completedPrompts = 0;
  for (const b of builds) {
    totalPrompts += b.total_prompts ?? 0;
    completedPrompts += b.completed_prompts ?? 0;
  }
  const promptSuccessRate = totalPrompts > 0 ? round(completedPrompts / totalPrompts) : null;

  const pairs: Array<[number, number]> = versions
    .filter(
      (v): v is GovernanceVersion & { effectiveness_score: number } =>
        typeof v.effectiveness_score === 'number' && Number.isFinite(v.effectiveness_score)
    )
    .map((v): [number, number] => [v.effectiveness_score, v.builds_used_in ?? 0]);
  const effectivenessAdoptionCorrelation = pearson(pairs);

  return {
    terminalBuilds: terminal.length,
    completedBuilds,
    buildSuccessRate,
    promptSuccessRate,
    effectivenessAdoptionCorrelation:
      effectivenessAdoptionCorrelation === null ? null : round(effectivenessAdoptionCorrelation),
  };
}

// ---------------------------------------------------------------------------
// Proposal generation (pure, deterministic, NON-DESTRUCTIVE)
// ---------------------------------------------------------------------------

/** The annotation marker prepended into a flagged section's revised text. */
const PROPOSAL_MARKER = '<!-- FORGE recursive_learner';

/** Build the deterministic "new" section text: the original plus a revision-flag annotation. */
function annotateSection(original: string, note: string): string {
  return `${original.trimEnd()}\n\n${PROPOSAL_MARKER}: ${note} -->`;
}

/**
 * STEP 5 — turn the trend + reference findings into concrete, evidence-backed proposals.
 * DECLINING templates yield a whole-template note flagging the effectiveness drop and the
 * recovery target; UNREFERENCED sections yield a section-level removal/consolidation candidate.
 * The "new" text is a deterministic annotation of the original (NON-DESTRUCTIVE — the
 * substantive rewrite is the human's at the Contract-16 approval gate).
 */
function generateProposals(
  groups: Map<string, GovernanceVersion[]>,
  trends: TemplateTrend[],
  references: ReferenceFinding[],
  correlation: BuildSuccessCorrelation,
  buildsAnalyzed: number
): ProposedChange[] {
  const proposals: ProposedChange[] = [];
  const trendByTemplate = new Map(trends.map((t) => [t.templateName, t]));

  const nextVersionFor = (templateName: string): number => {
    const list = groups.get(templateName);
    const latest = list && list.length > 0 ? list[list.length - 1] : undefined;
    return (latest ? latest.version_number : 0) + 1;
  };

  // (a) Declining-effectiveness proposals — one per declining template.
  for (const trend of trends) {
    if (!trend.declining) continue;
    const list = groups.get(trend.templateName);
    const latest = list && list.length > 0 ? list[list.length - 1] : undefined;
    if (!latest) continue;

    const recover =
      trend.bestScore !== null && trend.latestScore !== null
        ? Math.max(0, trend.bestScore - trend.latestScore)
        : 0;
    const note =
      `effectiveness declined (latest ${trend.latestScore ?? 'n/a'}, previous ` +
      `${trend.previousScore ?? 'n/a'}, best ${trend.bestScore ?? 'n/a'}, trend r=` +
      `${trend.trend ?? 'n/a'}); review this template for clarity/accuracy`;
    const oldText = latest.content_snapshot;
    const newText = annotateSection(oldText, note);
    const evidence =
      `Across ${buildsAnalyzed} build(s): template '${trend.templateName}' effectiveness fell ` +
      `from ${trend.previousScore ?? 'n/a'} to ${trend.latestScore ?? 'n/a'} over ` +
      `${trend.scoredVersions} scored version(s) (trend r=${trend.trend ?? 'n/a'}, last delta ` +
      `${trend.lastDelta ?? 'n/a'}); overall build success rate ` +
      `${correlation.buildSuccessRate ?? 'n/a'}, prompt success rate ` +
      `${correlation.promptSuccessRate ?? 'n/a'}.`;

    proposals.push({
      templateName: trend.templateName,
      kind: 'declining_effectiveness',
      section: null,
      oldText,
      newText,
      evidence,
      expectedImprovement: round(recover),
      proposedVersionNumber: nextVersionFor(trend.templateName),
    });
  }

  // (b) Unreferenced-section proposals — one per section never referenced by any build agent.
  for (const ref of references) {
    if (ref.section === null || !ref.unreferenced) continue;
    const list = groups.get(ref.templateName);
    const latest = list && list.length > 0 ? list[list.length - 1] : undefined;
    if (!latest) continue;
    const sections = parseSections(latest.content_snapshot);
    const target = sections.find((s) => s.heading === ref.section);
    if (!target) continue;

    const note =
      `section never referenced by any build agent across the analyzed prompts; candidate for ` +
      `removal or consolidation to reduce injected-context size`;
    const oldText = target.text;
    const newText = annotateSection(oldText, note);
    const trend = trendByTemplate.get(ref.templateName);
    const evidence =
      `Section '${ref.section}' of '${ref.templateName}' was injected into 0 executed prompts ` +
      `across ${buildsAnalyzed} build(s); the template itself was referenced by ` +
      `${references.find((r) => r.templateName === ref.templateName && r.section === null)
        ?.referencedByPrompts ?? 0} prompt(s)` +
      `${trend ? ` (template trend r=${trend.trend ?? 'n/a'})` : ''}.`;

    proposals.push({
      templateName: ref.templateName,
      kind: 'unreferenced_section',
      section: ref.section,
      oldText,
      newText,
      evidence,
      // Trimming dead context is a modest, conservative projected gain.
      expectedImprovement: round(0.02),
      proposedVersionNumber: nextVersionFor(ref.templateName),
    });
  }

  return proposals;
}

// ---------------------------------------------------------------------------
// Pure analysis entry point (no I/O)
// ---------------------------------------------------------------------------

/**
 * Analyze governance versions, builds, and executed prompts into a {@link TemplateEvolutionReport}.
 * PURE and deterministic — no database, no clock beyond the derived timestamp string.
 */
export function analyzeTemplates(
  versions: GovernanceVersion[],
  builds: BuildRun[],
  executions: PromptExecution[],
  warnings: string[] = []
): TemplateEvolutionReport {
  const groups = groupByTemplate(versions);

  if (versions.length === 0) {
    warnings.push('No governance_versions to analyze — Build Memory empty or unreachable.');
  }
  if (executions.length === 0) {
    warnings.push(
      'No prompt_executions to scan — reference analysis treats every section as unreferenced.'
    );
  }

  const trends = analyzeTrends(groups);
  const references = analyzeReferences(groups, executions);
  const correlation = analyzeCorrelation(versions, builds);
  const proposals = generateProposals(groups, trends, references, correlation, builds.length);

  return {
    templatesAnalyzed: groups.size,
    versionsAnalyzed: versions.length,
    buildsAnalyzed: builds.length,
    promptsAnalyzed: executions.length,
    trends,
    references,
    correlation,
    proposals,
    warnings,
    generatedAt: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Build Memory persistence
// ---------------------------------------------------------------------------

/**
 * Persist each proposal as a `governance_versions` row with `change_source = 'recursive_learner'`
 * (Contract 16 — proposed, human-approved). Guarded → stateless degrade (Contract 4); never throws.
 */
async function storeProposals(
  report: TemplateEvolutionReport,
  createVersion: (input: NewGovernanceVersion) => Promise<GovernanceVersion | null>,
  log: (message: string) => void
): Promise<TemplateStorageResult> {
  const result: TemplateStorageResult = { proposalsStored: 0, stateless: false, warnings: [] };
  let reachedMemory = false;

  for (const proposal of report.proposals) {
    const description =
      `PROPOSED (${proposal.kind}${proposal.section ? `, section "${proposal.section}"` : ''}): ` +
      `${proposal.evidence} Expected effectiveness improvement ≈ ${proposal.expectedImprovement}.`;
    try {
      const created = await createVersion({
        template_name: proposal.templateName,
        version_number: proposal.proposedVersionNumber,
        content_hash: hashContent(proposal.newText),
        content_snapshot: proposal.newText,
        change_source: 'recursive_learner',
        changes_description: description,
      });
      if (created) {
        reachedMemory = true;
        result.proposalsStored += 1;
      }
    } catch (error) {
      result.warnings.push(
        `proposal for '${proposal.templateName}' not stored (${describe(error)}).`
      );
    }
  }

  if (report.proposals.length > 0 && !reachedMemory) {
    result.stateless = true;
    result.warnings.push(
      'Build Memory unreachable — proposals generated but not persisted (stateless mode, Contract 4).'
    );
    log('WARNING: Build Memory unreachable — proposals not persisted (stateless mode).');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Defaults (Build Memory reads — degrade to [] per Contract 4)
// ---------------------------------------------------------------------------

async function defaultFetchVersions(): Promise<GovernanceVersion[]> {
  return (await BuildMemory.governance.listAllVersions()) ?? [];
}

function defaultFetchBuilds(limit: number): () => Promise<BuildRun[]> {
  return async () => (await BuildMemory.builds.listBuilds(limit)) ?? [];
}

async function defaultFetchExecutions(builds: BuildRun[]): Promise<PromptExecution[]> {
  const all: PromptExecution[] = [];
  for (const b of builds) {
    const rows = await BuildMemory.prompts.getPromptsByBuild(b.id);
    if (rows) all.push(...rows);
  }
  return all;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Analyze FORGE's governance templates across every recorded build and propose evidence-backed
 * improvements (queue.yaml s6-p02). Loads governance_versions + builds + executed prompts
 * (unless supplied), runs the pure {@link analyzeTemplates}, and stores each proposal as a
 * `recursive_learner` `governance_versions` row (unless `store:false`).
 *
 * Always resolves (never rejects): every Build Memory read/write is guarded and degrades to
 * stateless (Contract 4). NEVER edits a governance file on disk (Iron Law 1).
 */
export async function evolveTemplates(
  input: EvolveTemplatesInput = {},
  options: TemplateEvolverOptions = {}
): Promise<TemplateEvolutionResult> {
  const log = options.log ?? logLine('evolver');
  const store = options.store ?? true;
  const buildScanLimit = options.buildScanLimit ?? DEFAULT_BUILD_SCAN_LIMIT;
  const fetchVersions = options.fetchVersions ?? defaultFetchVersions;
  const fetchBuilds = options.fetchBuilds ?? defaultFetchBuilds(buildScanLimit);
  const fetchExecutions = options.fetchExecutions ?? defaultFetchExecutions;
  const createVersion =
    options.createVersion ?? ((i: NewGovernanceVersion) => BuildMemory.governance.createVersion(i));

  const warnings: string[] = [];

  // 1. Resolve governance versions (guarded).
  let versions: GovernanceVersion[] = input.versions ?? [];
  if (input.versions === undefined) {
    try {
      versions = await fetchVersions();
    } catch (error) {
      warnings.push(`Could not load governance_versions (${describe(error)}).`);
      log(`WARNING: fetchVersions degraded (${describe(error)})`);
      versions = [];
    }
  }

  // 2. Resolve builds (guarded).
  let builds: BuildRun[] = input.builds ?? [];
  if (input.builds === undefined) {
    try {
      builds = await fetchBuilds();
    } catch (error) {
      warnings.push(`Could not load build_runs (${describe(error)}).`);
      log(`WARNING: fetchBuilds degraded (${describe(error)})`);
      builds = [];
    }
  }

  // 3. Resolve executions for reference analysis (guarded).
  let executions: PromptExecution[] = input.executions ?? [];
  if (input.executions === undefined) {
    try {
      executions = await fetchExecutions(builds);
    } catch (error) {
      warnings.push(`Could not load prompt_executions (${describe(error)}).`);
      log(`WARNING: fetchExecutions degraded (${describe(error)})`);
      executions = [];
    }
  }

  log(
    `analyzing ${versions.length} governance version(s) across ` +
      `${new Set(versions.map((v) => v.template_name)).size} template(s), ` +
      `${builds.length} build(s), ${executions.length} executed prompt(s)`
  );

  // 4. Pure analysis.
  const report = analyzeTemplates(versions, builds, executions, warnings);
  log(
    `found ${report.trends.filter((t) => t.declining).length} declining template(s), ` +
      `${report.references.filter((r) => r.section !== null && r.unreferenced).length} unreferenced ` +
      `section(s) → ${report.proposals.length} proposal(s).`
  );

  // 5. Persist proposals (unless disabled).
  let storage: TemplateStorageResult;
  if (store) {
    storage = await storeProposals(report, createVersion, log);
    log(
      `stored ${storage.proposalsStored} proposal(s)` +
        `${storage.stateless ? ' (STATELESS — nothing persisted)' : ''}.`
    );
  } else {
    storage = { proposalsStored: 0, stateless: false, warnings: [] };
  }

  return { report, storage };
}

export default evolveTemplates;
