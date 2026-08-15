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
 * IMPORTANT SCOPE NOTE: none of `taste-skill`/`impeccable`/`awesome-design`/`img2threejs` are
 * installed or invoked by this codebase (`upgrades/SYSTEMS-5-9-GAP-MATRIX.md` rows 07/12/16
 * confirm all three remain MISSING). `routeDesign()` therefore produces a real, explainable,
 * persisted DECISION — which tool a prompt SHOULD use and why — but does not itself switch which
 * generator actually runs `ui-engine/component-generator.ts` remains the only real generator this
 * codebase invokes. A caller wiring an actual taste-skill/Impeccable/img2threejs integration in
 * the future reads its own tool name off {@link DesignRoutingDecision.primaryTool} instead of
 * hardcoding a choice.
 *
 * House style, matching every sibling `src/design-pipeline/` module: `routeDesign()` never
 * throws — a Build Memory failure degrades `historical_success`/`user_preference` to their
 * neutral defaults rather than blocking a decision.
 */

import { newId, nowIso, runQuery, toJsonText } from '../memory/client.js';
import { logLine } from '../tools/forge-logger.js';
import type { AppDesignProfile } from './app-profiler.js';
import { getPreferenceScore } from './design-memory.js';

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
}

export interface RouteDesignOptions {
  buildRunId?: string;
  promptId?: string;
  packageJson?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null;
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

function brandMatchFor(entry: ToolRegistryEntry, profile: AppDesignProfile): number {
  if (entry.brandTags.length === 0) return 0.5; // brand-neutral tool (e.g. a validation-only role)
  if (profile.brand.tone.length === 0) return 0.5;
  const overlap = entry.brandTags.filter((tag) => profile.brand.tone.includes(tag)).length;
  return overlap / entry.brandTags.length;
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
  historicalSuccess: number,
  userPreference: number,
  packageJson: RouteDesignOptions['packageJson']
): ToolScoreBreakdown {
  const capabilityMatch = capabilityMatchFor(entry, interfaceType);
  const interfaceMatch = interfaceMatchFor(entry, profile);
  const brandMatch = brandMatchFor(entry, profile);
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
  const scores = {} as Record<DesignTool, ToolScoreBreakdown>;
  for (const tool of DESIGN_TOOLS) {
    const entry = DESIGN_CAPABILITY_REGISTRY[tool];
    const [historicalSuccess, userPreference] = await Promise.all([
      historicalSuccessFor(tool),
      getPreferenceScore(entry.preferenceTags),
    ]);
    scores[tool] = scoreTool(entry, interfaceType, profile, historicalSuccess, userPreference, options.packageJson);
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
  };

  await persistDecision(decision, options);
  log(
    `[DESIGN ROUTER] ${profile.projectName}/${interfaceType}: primary=${primaryTool} ` +
      `(${decision.confidencePercent}%), secondary=${secondaryTool ?? 'none'}`
  );
  return decision;
}

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
  lines.push(`DESIGN ROUTER DECISION — ${decision.projectName} / ${decision.interfaceType}`);
  lines.push(`PRIMARY TOOL: ${decision.primaryTool.toUpperCase()}`);
  lines.push(`CONFIDENCE: ${decision.confidencePercent}%`);
  lines.push('REASONS:');
  for (const r of decision.reasons) lines.push(`  ${r}`);
  if (decision.secondaryTool) lines.push(`SECONDARY: ${decision.secondaryTool.toUpperCase()}`);
  lines.push(`VALIDATION: ${decision.validationTool.toUpperCase()}`);
  if (decision.notSelected.length > 0) {
    lines.push('NOT SELECTED:');
    for (const n of decision.notSelected) lines.push(`  ${n.tool.toUpperCase()} — ${n.reason}`);
  }
  return lines.join('\n');
}

/** Registry entry accessor including `playwright`, for callers that want the full tool set. */
export function getRegistryEntry(tool: DesignTool | typeof VALIDATION_TOOL): ToolRegistryEntry {
  return tool === VALIDATION_TOOL ? PLAYWRIGHT_ENTRY : DESIGN_CAPABILITY_REGISTRY[tool];
}

export default routeDesign;
