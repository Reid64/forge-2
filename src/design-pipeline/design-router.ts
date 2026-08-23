/**
 * FORGE 2.0 — Design Pipeline: DesignRouter (`src/design-pipeline/design-router.ts`).
 *
 * `upgrades/DESIGN_INTELLIGENCE.md`'s component #06 ("Design Tool Router," the document's own
 * "key" component) plus #05 ("Design Capability Registry," folded in here as
 * {@link DESIGN_CAPABILITY_REGISTRY} rather than a separate module — the registry has no
 * independent behavior of its own, it's the router's configuration). `upgrades/
 * SYSTEMS-5-9-GAP-MATRIX.md` row 06 confirmed zero prior implementation: "No router, no
 * taste-skill/Impeccable/Awesome-Design/img2threejs references anywhere."
 *
 * WHAT IT DOES: scores every registered design tool against an {@link AppDesignProfile}
 * (`app-profiler.ts`) for a target interface type, using the spec's own weighted formula
 * verbatim:
 *
 *   ToolScore = capability_match×0.30 + interface_match×0.20 + brand_match×0.15
 *             + historical_success×0.10 + user_preference×0.10 + project_stack_match×0.05
 *             + accessibility_quality×0.05 + performance_quality×0.05
 *
 * Every dimension is grounded in a REAL, documented signal — never a fabricated number:
 *   - capability_match / interface_match: {@link DESIGN_CAPABILITY_REGISTRY}, a machine-readable
 *     transcription of the spec's own capability table, looked up via
 *     {@link INTERFACE_TYPE_TO_CAPABILITY_KEYS} (the profile's interface-type vocabulary ->
 *     the registry's capability-key vocabulary).
 *   - brand_match: overlap between the tool's curated `brandTags` and the profile's `brand.tone`.
 *   - historical_success: real `design_router_decisions.outcome` win-rate for this tool, read from
 *     Build Memory — defaults to a neutral 0.5 when no decision has an outcome recorded yet
 *     (never assumes success OR failure for an unobserved tool).
 *   - user_preference: `design-memory.ts`'s {@link getPreferenceScore} against the tool's curated
 *     `preferenceTags` — real cross-project human-approval signal, neutral 0.5 when unobserved.
 *   - project_stack_match: real `package.json` dependency presence check.
 *   - accessibility_quality / performance_quality: the spec's own per-tool "Audit" column value
 *     (`DESIGN_CAPABILITY_REGISTRY[tool].auditScore`), reused for both dimensions since the spec
 *     table provides only one audit number per tool, not two separate ones — documented here so
 *     that reuse is never mistaken for two independently-measured signals.
 *
 * `playwright` is always the `validationTool` (every spec routing example lists it last,
 * unconditionally) and is never a candidate for `primaryTool`/`secondaryTool`.
 *
 * INSTALL DETECTION: each {@link ToolScoreBreakdown.installed} flag is a real, live filesystem
 * check against this machine's Claude Code user directory (`~/.claude`), computed fresh by
 * {@link detectInstalledDesignTools} on every `routeDesign()` call — never a cached or hardcoded
 * assumption. `img2threejs` is installed when `~/.claude/skills/img2threejs/SKILL.md` exists;
 * `impeccable` is installed when `~/.claude/plugins/known_marketplaces.json` registers an
 * `impeccable` marketplace (key `impeccable` or a `pbakaus/impeccable` source repo). `taste_skill`
 * and `awesome_design` have no known skill/marketplace name to check against yet, so they report
 * `installed: false` until one is identified — never guessed. `installed` is informational only:
 * it is not one of the eight weighted scoring dimensions above and never changes `total`, since
 * routing scores a tool's fitness for the interface, not this machine's local setup. Even when a
 * tool is installed, `routeDesign()` still only produces a persisted DECISION — which tool a
 * prompt SHOULD use and why — `ui-engine/component-generator.ts` remains the only generator this
 * codebase actually invokes. A caller wiring a real taste-skill/Impeccable/img2threejs/
 * Awesome-Design integration reads its own tool name off {@link DesignRoutingDecision.primaryTool}
 * (and its install state off `scores[tool].installed`) instead of hardcoding a choice.
 *
 * House style, matching every sibling `src/design-pipeline/` module: `routeDesign()` never
 * throws — a Build Memory failure degrades `historical_success`/`user_preference` to their
 * neutral defaults rather than blocking a decision, and an install-detection failure (unreadable
 * `~/.claude` directory) degrades every tool's `installed` to `false` rather than throwing.
 *
 * DESIGN INTELLIGENCE WIRING (this file's own extension point for `brand-intelligence.ts`/
 * `persona-profiler.ts`/`aesthetic-reference.ts`/`variance-controller.ts`, added alongside those
 * four modules): `RouteDesignOptions.brandProfile`/`.personas` are OPTIONAL — every existing
 * caller that only ever had an `AppDesignProfile` keeps compiling and scoring identically. When
 * supplied, `brand_match` scores against the UNION of `profile.brand.tone`,
 * `brandProfile.tone`/`.values`, and tags derived from `personas`' technical-proficiency mix
 * (see {@link personaDerivedToneTags}) — never a REPLACEMENT of the profile's own signal, an
 * ADDITION to it. {@link DesignRoutingDecision.recommendedAesthetics} is a genuinely new output:
 * `aesthetic-reference.ts`'s {@link rankAestheticFamilies} scored against that same combined tone
 * list for `interfaceType` — a tool-agnostic "what style direction fits" answer alongside the
 * tool-specific routing decision. `recommendedAesthetics`/`varianceGuidance` are informational
 * only (not part of the eight weighted scoring dimensions, and not persisted by
 * {@link persistDecision} — see that function's own note) — matching `installed`'s existing
 * informational-only posture in this same interface.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { newId, nowIso, runQuery, toJsonText } from '../memory/client.js';
import { logLine } from '../tools/forge-logger.js';
import type { AppDesignProfile } from './app-profiler.js';
import { getPreferenceScore } from './design-memory.js';
import type { BrandProfile } from './brand-intelligence.js';
import type { TargetPersona } from './persona-profiler.js';
import { rankAestheticFamilies, type AestheticFamilyMatch } from './aesthetic-reference.js';
import { MINIMUM_VARIANCE } from './variance-controller.js';

const log = logLine('design-router');

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export const DESIGN_TOOLS = ['taste_skill', 'impeccable', 'awesome_design', 'img2threejs'] as const;
export type DesignTool = (typeof DESIGN_TOOLS)[number];
export const VALIDATION_TOOL = 'playwright' as const;

/** Per-dimension breakdown for one tool, for explainability. */
export interface ToolScoreBreakdown {
  capabilityMatch: number;
  interfaceMatch: number;
  brandMatch: number;
  historicalSuccess: number;
  userPreference: number;
  projectStackMatch: number;
  accessibilityQuality: number;
  performanceQuality: number;
  total: number;
  /** Real, live-detected install state on this machine (see {@link detectInstalledDesignTools}). Not part of `total`. */
  installed: boolean;
}

export interface DesignRoutingDecision {
  id: string;
  projectName: string;
  interfaceType: string;
  scores: Record<DesignTool, ToolScoreBreakdown>;
  primaryTool: DesignTool;
  secondaryTool: DesignTool | null;
  validationTool: typeof VALIDATION_TOOL;
  notSelected: Array<{ tool: DesignTool; reason: string }>;
  reasons: string[];
  confidencePercent: number;
  /** `aesthetic-reference.ts` candidates scored against this decision's combined brand tone. Informational only — see file header. */
  recommendedAesthetics: AestheticFamilyMatch[];
  /** `variance-controller.ts`'s thresholds, restated as guidance for whatever Design Tournament run follows this decision. Informational only. */
  varianceGuidance: string;
}

export interface RouteDesignOptions {
  buildRunId?: string;
  promptId?: string;
  packageJson?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null;
  /** Optional richer brand signal (`brand-intelligence.ts`) — unioned onto `profile.brand.tone` for `brand_match`. See file header. */
  brandProfile?: BrandProfile | null;
  /** Optional persona signal (`persona-profiler.ts`) — folded into the combined brand tone via {@link personaDerivedToneTags}. See file header. */
  personas?: readonly TargetPersona[] | null;
}

// ---------------------------------------------------------------------------
// Design Capability Registry (component #05) — machine-readable transcription of the spec table
// ---------------------------------------------------------------------------

interface ToolRegistryEntry {
  /** Capability -> strength (0-1), verbatim from `upgrades/DESIGN_INTELLIGENCE.md`'s YAML block. */
  capabilities: Readonly<Record<string, number>>;
  /** Curated aesthetic-affinity tags, used for `brand_match`. */
  brandTags: readonly string[];
  /** Curated Design Memory tags this tool's output tends to satisfy, used for `user_preference`. */
  preferenceTags: readonly string[];
  /** `package.json` dependency names whose presence is a positive stack-match signal. */
  stackHints: readonly string[];
  /** The spec's single "Audit" column value (0-10), normalized to 0-1; reused for both
   *  accessibility_quality and performance_quality — see this file's header note. */
  auditScore: number;
}

export const DESIGN_CAPABILITY_REGISTRY: Readonly<Record<DesignTool, ToolRegistryEntry>> = {
  taste_skill: {
    capabilities: {
      landing_page: 1.0,
      marketing_site: 1.0,
      portfolio: 0.95,
      brand_expression: 0.95,
      motion: 0.9,
      dashboard: 0.25,
      dense_application_ui: 0.2,
      application_ui: 0.3,
    },
    brandTags: ['premium', 'expressive', 'bold', 'editorial'],
    preferenceTags: ['realistic_photography', 'premium_industrial'],
    stackHints: ['tailwindcss'],
    auditScore: 0.5,
  },
  impeccable: {
    capabilities: {
      dashboard: 1.0,
      application_ui: 1.0,
      dense_application_ui: 0.9,
      visual_audit: 1.0,
      accessibility: 0.95,
      typography: 1.0,
      spacing: 1.0,
      interaction_design: 0.95,
      polish: 1.0,
      product_geometry: 0.1,
      '3d_reconstruction': 0.1,
    },
    brandTags: ['precise', 'restrained', 'technical', 'enterprise', 'clean'],
    preferenceTags: ['strong_information_hierarchy', 'clear_navigation', 'non_generic_dashboard_layouts'],
    stackHints: ['tailwindcss', '@radix-ui/react-slot'],
    auditScore: 1.0,
  },
  awesome_design: {
    capabilities: {
      aesthetic_direction: 1.0,
      style_reference: 1.0,
      design_system_inspiration: 0.9,
      remixing: 0.95,
      marketing_site: 0.6,
      dashboard: 0.4,
      application_ui: 0.4,
    },
    brandTags: ['directional', 'aesthetic', 'premium'],
    preferenceTags: ['premium_industrial'],
    stackHints: [],
    auditScore: 0.4,
  },
  img2threejs: {
    capabilities: {
      '3d_reconstruction': 1.0,
      product_geometry: 1.0,
      procedural_geometry: 1.0,
      shaders: 0.95,
      dashboard: 0.1,
      marketing_site: 0.1,
      application_ui: 0.1,
    },
    brandTags: ['industrial', 'technical', 'precise'],
    preferenceTags: [],
    stackHints: ['three', '@react-three/fiber', '@react-three/drei'],
    auditScore: 0.1,
  },
};

/** `playwright`'s own registry-shaped entry — real capabilities, but never a routing candidate. */
const PLAYWRIGHT_ENTRY: ToolRegistryEntry = {
  capabilities: {
    screenshot_capture: 1.0,
    responsive_validation: 1.0,
    interaction_validation: 1.0,
    browser_validation: 1.0,
  },
  brandTags: [],
  preferenceTags: [],
  stackHints: ['playwright'],
  auditScore: 1.0,
};

/**
 * Maps `app-profiler.ts`'s `interfaceTypes` vocabulary onto {@link DESIGN_CAPABILITY_REGISTRY}'s
 * capability-key vocabulary — the two are deliberately different (profile types describe WHAT is
 * being built; registry keys describe WHAT KIND OF WORK a tool is good at), so this table is the
 * explicit, documented bridge between them. An interface type absent from this map scores 0 on
 * every tool (never guessed).
 */
const INTERFACE_TYPE_TO_CAPABILITY_KEYS: Readonly<Record<string, readonly string[]>> = {
  marketing_site: ['marketing_site', 'landing_page', 'brand_expression'],
  customer_dashboard: ['dashboard', 'application_ui'],
  admin_dashboard: ['dashboard', 'application_ui', 'dense_application_ui'],
  production_dashboard: ['dashboard', 'dense_application_ui'],
  architect_workspace: ['application_ui', 'dense_application_ui'],
  product_configurator: ['product_geometry', 'application_ui'],
  '3d_visualizer': ['3d_reconstruction', 'procedural_geometry', 'shaders'],
  auth_flow: ['application_ui'],
  settings: ['application_ui'],
  analytics_console: ['dashboard', 'dense_application_ui'],
  api_console: ['application_ui'],
  mobile_dashboard: ['dashboard'],
};

// ---------------------------------------------------------------------------
// Real install detection — live filesystem checks against ~/.claude, never hardcoded/cached
// ---------------------------------------------------------------------------

const CLAUDE_USER_HOME = join(homedir(), '.claude');

/** `true` when `~/.claude/skills/img2threejs/SKILL.md` exists on this machine. */
function isImg2ThreejsSkillInstalled(): boolean {
  try {
    return existsSync(join(CLAUDE_USER_HOME, 'skills', 'img2threejs', 'SKILL.md'));
  } catch {
    return false;
  }
}

/**
 * `true` when `~/.claude/plugins/known_marketplaces.json` registers an `impeccable` marketplace
 * (matched by key or by its `pbakaus/impeccable` GitHub source repo — the marketplace's own
 * identity, not any particular plugin published from it).
 */
function isImpeccableMarketplaceRegistered(): boolean {
  try {
    const path = join(CLAUDE_USER_HOME, 'plugins', 'known_marketplaces.json');
    if (!existsSync(path)) return false;
    const marketplaces = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      { source?: { source?: string; repo?: string } } | undefined
    >;
    return Object.entries(marketplaces).some(([key, value]) => {
      if (key.toLowerCase() === 'impeccable') return true;
      const repo = value?.source?.repo;
      return typeof repo === 'string' && repo.toLowerCase() === 'pbakaus/impeccable';
    });
  } catch {
    return false;
  }
}

/**
 * Live install/registration state for every {@link DESIGN_TOOLS} candidate on this machine.
 * `taste_skill`/`awesome_design` have no known Claude Code skill or marketplace name to check
 * against yet, so they report `false` until one is identified (never guessed). Never throws — an
 * unreadable `~/.claude` directory degrades every flag to `false`.
 */
export function detectInstalledDesignTools(): Readonly<Record<DesignTool, boolean>> {
  return {
    taste_skill: false,
    impeccable: isImpeccableMarketplaceRegistered(),
    awesome_design: false,
    img2threejs: isImg2ThreejsSkillInstalled(),
  };
}

// ---------------------------------------------------------------------------
// Scoring weights (spec formula, verbatim — sums to 1.00)
// ---------------------------------------------------------------------------

const WEIGHTS = {
  capabilityMatch: 0.3,
  interfaceMatch: 0.2,
  brandMatch: 0.15,
  historicalSuccess: 0.1,
  userPreference: 0.1,
  projectStackMatch: 0.05,
  accessibilityQuality: 0.05,
  performanceQuality: 0.05,
} as const;

/** Below this total score, a candidate tool is never offered as `secondaryTool`. */
const SECONDARY_MIN_SCORE = 0.35;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function capabilityMatchFor(entry: ToolRegistryEntry, interfaceType: string): number {
  const keys = INTERFACE_TYPE_TO_CAPABILITY_KEYS[interfaceType];
  if (!keys || keys.length === 0) return 0;
  const values = keys.map((k) => entry.capabilities[k] ?? 0);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function interfaceMatchFor(entry: ToolRegistryEntry, profile: AppDesignProfile): number {
  if (profile.interfaceTypes.length === 0) return 0;
  const values = profile.interfaceTypes.map((t) => capabilityMatchFor(entry, t));
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function brandMatchFor(entry: ToolRegistryEntry, combinedTone: readonly string[]): number {
  if (entry.brandTags.length === 0) return 0.5; // brand-neutral tool (e.g. a validation-only role)
  if (combinedTone.length === 0) return 0.5;
  const overlap = entry.brandTags.filter((tag) => combinedTone.includes(tag)).length;
  return overlap / entry.brandTags.length;
}

/**
 * `personas`' technical-proficiency mix, folded into a small set of brand-tone-vocabulary tags
 * (the same vocabulary `app-profiler.ts`/`brand-intelligence.ts` use) — a majority-`high`
 * proficiency persona mix nudges `['technical', 'precise']`, a majority-`low` mix nudges
 * `['warm']` (the `app-profiler.ts`/`brand-intelligence.ts` tag closest to "approachable" already
 * in use elsewhere in this codebase). An even/absent mix contributes nothing (never a fabricated
 * lean when the signal doesn't clearly point one way).
 */
function personaDerivedToneTags(personas: readonly TargetPersona[] | null | undefined): string[] {
  if (!personas || personas.length === 0) return [];
  let high = 0;
  let low = 0;
  for (const p of personas) {
    if (p.technicalProficiency === 'high') high++;
    else if (p.technicalProficiency === 'low') low++;
  }
  if (high > low) return ['technical', 'precise'];
  if (low > high) return ['warm'];
  return [];
}

/** Union `profile.brand.tone` with `options.brandProfile`'s tone/values and persona-derived tags — never a replacement. */
function combinedBrandTone(profile: AppDesignProfile, options: RouteDesignOptions): string[] {
  const brand = options.brandProfile;
  return [
    ...new Set([
      ...profile.brand.tone,
      ...(brand?.tone ?? []),
      ...(brand?.values ?? []),
      ...personaDerivedToneTags(options.personas),
    ]),
  ];
}

function projectStackMatchFor(
  entry: ToolRegistryEntry,
  packageJson: RouteDesignOptions['packageJson']
): number {
  if (entry.stackHints.length === 0) return 0.5; // no stack opinion either way
  const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
  const hit = entry.stackHints.some((name) => Object.prototype.hasOwnProperty.call(deps, name));
  return hit ? 1.0 : 0.0;
}

async function historicalSuccessFor(tool: DesignTool): Promise<number> {
  const result = await runQuery<{ approved: number; total: number }>('design-router.history', (db) => {
    const rows = db
      .prepare(`SELECT outcome FROM design_router_decisions WHERE primary_tool = ? AND outcome IS NOT NULL`)
      .all(tool) as Array<{ outcome: string }>;
    return { approved: rows.filter((r) => r.outcome === 'approved').length, total: rows.length };
  });
  if (!result || result.total === 0) return 0.5;
  return result.approved / result.total;
}

function scoreTool(
  entry: ToolRegistryEntry,
  interfaceType: string,
  profile: AppDesignProfile,
  tone: readonly string[],
  historicalSuccess: number,
  userPreference: number,
  packageJson: RouteDesignOptions['packageJson'],
  installed: boolean
): ToolScoreBreakdown {
  const capabilityMatch = capabilityMatchFor(entry, interfaceType);
  const interfaceMatch = interfaceMatchFor(entry, profile);
  const brandMatch = brandMatchFor(entry, tone);
  const projectStackMatch = projectStackMatchFor(entry, packageJson);
  const accessibilityQuality = entry.auditScore;
  const performanceQuality = entry.auditScore;

  const total =
    capabilityMatch * WEIGHTS.capabilityMatch +
    interfaceMatch * WEIGHTS.interfaceMatch +
    brandMatch * WEIGHTS.brandMatch +
    historicalSuccess * WEIGHTS.historicalSuccess +
    userPreference * WEIGHTS.userPreference +
    projectStackMatch * WEIGHTS.projectStackMatch +
    accessibilityQuality * WEIGHTS.accessibilityQuality +
    performanceQuality * WEIGHTS.performanceQuality;

  return {
    capabilityMatch,
    interfaceMatch,
    brandMatch,
    historicalSuccess,
    userPreference,
    projectStackMatch,
    accessibilityQuality,
    performanceQuality,
    total,
    installed,
  };
}

/** The single lowest-scoring weighted dimension, rendered as a `NOT SELECTED` reason. */
function weakestDimensionReason(tool: DesignTool, breakdown: ToolScoreBreakdown, interfaceType: string): string {
  const contributions: Array<[string, number]> = [
    [`capability_match for '${interfaceType}'`, breakdown.capabilityMatch],
    ['interface_match across the full profile', breakdown.interfaceMatch],
    ['brand_match', breakdown.brandMatch],
  ];
  contributions.sort((a, b) => a[1] - b[1]);
  const [label, value] = contributions[0]!;
  return `${tool}: ${label} is only ${value.toFixed(2)} — not the primary specialization for this interface.`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score every {@link DESIGN_TOOLS} candidate against `profile` for `interfaceType`, select
 * primary/secondary, and persist the decision (`design_router_decisions`) for future
 * `historical_success` scoring. Never throws — a Build Memory read failure degrades
 * `historical_success`/`user_preference` to their neutral 0.5 default; a write failure still
 * returns the computed decision (Contract 4).
 */
export async function routeDesign(
  profile: AppDesignProfile,
  interfaceType: string,
  options: RouteDesignOptions = {}
): Promise<DesignRoutingDecision> {
  const installedTools = detectInstalledDesignTools();
  const tone = combinedBrandTone(profile, options);
  const scores = {} as Record<DesignTool, ToolScoreBreakdown>;
  for (const tool of DESIGN_TOOLS) {
    const entry = DESIGN_CAPABILITY_REGISTRY[tool];
    const [historicalSuccess, userPreference] = await Promise.all([
      historicalSuccessFor(tool),
      getPreferenceScore(entry.preferenceTags),
    ]);
    scores[tool] = scoreTool(
      entry,
      interfaceType,
      profile,
      tone,
      historicalSuccess,
      userPreference,
      options.packageJson,
      installedTools[tool]
    );
  }

  const ranked = DESIGN_TOOLS.slice().sort((a, b) => scores[b]!.total - scores[a]!.total);
  const primaryTool = ranked[0]!;
  const secondaryCandidate = ranked[1];
  const secondaryTool =
    secondaryCandidate && scores[secondaryCandidate]!.total >= SECONDARY_MIN_SCORE ? secondaryCandidate : null;

  const notSelected = ranked
    .filter((t) => t !== primaryTool && t !== secondaryTool)
    .map((tool) => ({ tool, reason: weakestDimensionReason(tool, scores[tool]!, interfaceType) }));

  const primaryBreakdown = scores[primaryTool]!;
  const topDimensions: Array<[string, number]> = (
    [
      ['capability_match', primaryBreakdown.capabilityMatch],
      ['interface_match', primaryBreakdown.interfaceMatch],
      ['brand_match', primaryBreakdown.brandMatch],
      ['historical_success', primaryBreakdown.historicalSuccess],
      ['user_preference', primaryBreakdown.userPreference],
    ] as Array<[string, number]>
  ).sort((a, b) => b[1] - a[1]);
  const reasons = topDimensions.slice(0, 3).map(([label, value]) => `+ ${label} = ${value.toFixed(2)} for '${interfaceType}'`);

  const recommendedAesthetics = rankAestheticFamilies(tone, interfaceType, 3);
  const varianceGuidance =
    `any Design Tournament run following this decision must keep pairwise structural similarity ` +
    `below ${MINIMUM_VARIANCE.maxStructuralSimilarity} (variance-controller.ts) — a higher similarity ` +
    `means the variants differ only in color/font/spacing, which is PROHIBITED.`;

  const decision: DesignRoutingDecision = {
    id: newId(),
    projectName: profile.projectName,
    interfaceType,
    scores,
    primaryTool,
    secondaryTool,
    validationTool: VALIDATION_TOOL,
    notSelected,
    reasons,
    confidencePercent: Math.round(primaryBreakdown.total * 100),
    recommendedAesthetics,
    varianceGuidance,
  };

  await persistDecision(decision, options);
  log(
    `[DESIGN ROUTER] ${profile.projectName}/${interfaceType}: primary=${primaryTool} ` +
      `(${decision.confidencePercent}%), secondary=${secondaryTool ?? 'none'}`
  );
  return decision;
}

/**
 * Persists the core routing decision. `recommendedAesthetics`/`varianceGuidance` are deliberately
 * NOT persisted here — they are cheap to recompute from `tool_scores`/`interface_type` plus
 * whatever `brandProfile`/`personas` a future caller supplies, and `design_router_decisions`'s
 * schema predates those two fields; adding columns for informational-only output is deferred to
 * whichever caller (this pipeline's Task 12 follow-on) actually needs them persisted.
 */
async function persistDecision(decision: DesignRoutingDecision, options: RouteDesignOptions): Promise<void> {
  await runQuery('design-router.persist', (db) => {
    db.prepare(
      `INSERT INTO design_router_decisions (
         id, project_name, build_run_id, prompt_id, interface_type, tool_scores,
         primary_tool, secondary_tool, validation_tool, not_selected, reasons, confidence, created_at
       ) VALUES (
         @id, @project_name, @build_run_id, @prompt_id, @interface_type, @tool_scores,
         @primary_tool, @secondary_tool, @validation_tool, @not_selected, @reasons, @confidence, @created_at
       )`
    ).run({
      id: decision.id,
      project_name: decision.projectName,
      build_run_id: options.buildRunId ?? null,
      prompt_id: options.promptId ?? null,
      interface_type: decision.interfaceType,
      tool_scores: toJsonText(decision.scores),
      primary_tool: decision.primaryTool,
      secondary_tool: decision.secondaryTool,
      validation_tool: decision.validationTool,
      not_selected: toJsonText(decision.notSelected),
      reasons: toJsonText(decision.reasons),
      confidence: decision.confidencePercent / 100,
      created_at: nowIso(),
    });
    return true;
  });
}

/**
 * Record whether `decisionId`'s routed output was ultimately approved/rejected (a caller wires
 * this from `design-pipeline/index.ts`'s review-gate result) — the real signal
 * {@link historicalSuccessFor} reads on every subsequent `routeDesign` call. Best-effort;
 * never throws.
 */
export async function recordRoutingOutcome(decisionId: string, outcome: 'approved' | 'rejected'): Promise<void> {
  await runQuery('design-router.outcome', (db) => {
    db.prepare('UPDATE design_router_decisions SET outcome = ? WHERE id = ?').run(outcome, decisionId);
    return true;
  });
}

/** Render a {@link DesignRoutingDecision} in the spec's own `DESIGN ROUTING:` explainability format. */
export function formatRoutingDecision(decision: DesignRoutingDecision): string {
  const lines: string[] = [];
  const installedTag = (tool: DesignTool): string => (decision.scores[tool].installed ? ' [installed]' : ' [not installed]');
  lines.push(`DESIGN ROUTER DECISION — ${decision.projectName} / ${decision.interfaceType}`);
  lines.push(`PRIMARY TOOL: ${decision.primaryTool.toUpperCase()}${installedTag(decision.primaryTool)}`);
  lines.push(`CONFIDENCE: ${decision.confidencePercent}%`);
  lines.push('REASONS:');
  for (const r of decision.reasons) lines.push(`  ${r}`);
  if (decision.secondaryTool) lines.push(`SECONDARY: ${decision.secondaryTool.toUpperCase()}${installedTag(decision.secondaryTool)}`);
  lines.push(`VALIDATION: ${decision.validationTool.toUpperCase()}`);
  if (decision.notSelected.length > 0) {
    lines.push('NOT SELECTED:');
    for (const n of decision.notSelected) lines.push(`  ${n.tool.toUpperCase()}${installedTag(n.tool)} — ${n.reason}`);
  }
  if (decision.recommendedAesthetics.length > 0) {
    lines.push('RECOMMENDED AESTHETICS:');
    for (const a of decision.recommendedAesthetics) {
      lines.push(`  ${a.family.name} (${a.family.id}) — ${a.score.toFixed(2)}`);
    }
  }
  lines.push(`VARIANCE GUIDANCE: ${decision.varianceGuidance}`);
  return lines.join('\n');
}

/** Registry entry accessor including `playwright`, for callers that want the full tool set. */
export function getRegistryEntry(tool: DesignTool | typeof VALIDATION_TOOL): ToolRegistryEntry {
  return tool === VALIDATION_TOOL ? PLAYWRIGHT_ENTRY : DESIGN_CAPABILITY_REGISTRY[tool];
}

export default routeDesign;
