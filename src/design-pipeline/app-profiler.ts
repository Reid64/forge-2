/**
 * FORGE 2.0 — Design Pipeline: AppProfiler (`src/design-pipeline/app-profiler.ts`).
 *
 * `upgrades/DESIGN_INTELLIGENCE.md`'s component #01 ("App Profiler") and the first stage of the
 * "FORGE MASTER ORCHESTRATOR -> DESIGN INTELLIGENCE ENGINE -> APP PROFILER" pipeline the spec
 * diagrams. `upgrades/SYSTEMS-5-9-GAP-MATRIX.md` row 01 confirmed zero prior implementation.
 *
 * WHAT IT DOES: builds an {@link AppDesignProfile} — the spec's `application_type`/
 * `interface_types`/`brand`/`visual_complexity`/`motion_requirement`/`3d_requirement`/
 * `data_density`/`target_users` YAML block — from real, already-on-disk project signal: a
 * project's queue-entry corpus (every prompt's `name` + `description`, the actual buildable task
 * text FORGE itself generated) and its `package.json` dependency list. Every field is derived by
 * deterministic keyword scoring against a fixed vocabulary (`APPLICATION_TYPE_VOCAB`/
 * `INTERFACE_TYPE_VOCAB`/`TARGET_USER_VOCAB` below) — never an LLM call, never a fabricated
 * per-project claim (Iron Law 3). `brand.tone`/`brand.avoid` are the one field this module cannot
 * observe directly from queue text; they are looked up from a curated, explicitly-documented
 * `application_type` -> tone/avoid default table (`BRAND_DEFAULTS_BY_APPLICATION_TYPE`) — a
 * provisional heuristic, not a claim of ground truth about the actual brand (that refinement is
 * `upgrades/DESIGN_INTELLIGENCE.md` component #03, "Brand Intelligence Engine," still MISSING per
 * the gap matrix and out of this module's scope).
 *
 * House style, matching every sibling `src/design-pipeline/` module: `profileApp()` (the pure
 * classifier) never throws — an empty/malformed corpus degrades to the vocabulary's fallback
 * category, never an exception. Persistence (`saveAppDesignProfile`/`getAppDesignProfile`) is
 * best-effort Contract 4 — a Build Memory failure returns `null`, never blocks a caller that only
 * needed the in-memory profile.
 *
 * NOT IN SCOPE (deliberately): this module does not call an LLM to read a PRD/BLUEPRINT.md for
 * richer signal (a real, valuable future enhancement — the queue corpus is what's reliably
 * available to every caller today), does not implement the Brand Intelligence Engine (#03) or
 * User/Persona Profiler (#04) as their own standalone subsystems (their narrowest useful slice —
 * tone/avoid defaults, target-user extraction — is folded in here since {@link AppDesignProfile}
 * needs those fields to be useful to `design-router.ts`), and does not re-profile on every single
 * prompt — `saveAppDesignProfile` upserts one row per `project_name`, so the profile reflects the
 * FULL queue corpus a caller passes it, and a caller re-profiling mid-build simply refreshes it.
 */

import { newId, nowIso, runQuery, fromJsonText, toJsonText } from '../memory/client.js';
import { logLine } from '../tools/forge-logger.js';

const log = logLine('app-profiler');

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type VisualComplexity = 'low' | 'medium' | 'high';
export type MotionRequirement = 'none' | 'minimal' | 'moderate' | 'high';
export type ThreeDRequirement = 'none' | 'low' | 'medium' | 'high';
export type DataDensity = 'low' | 'medium' | 'high';

/** The spec's `AppDesignProfile` YAML block, as a typed structure. */
export interface AppDesignProfile {
  projectName: string;
  applicationType: {
    primary: string;
    secondary: string[];
  };
  interfaceTypes: string[];
  brand: {
    tone: string[];
    avoid: string[];
  };
  visualComplexity: VisualComplexity;
  motionRequirement: MotionRequirement;
  threeDRequirement: ThreeDRequirement;
  /** Per-interface-type data density, e.g. `{ marketing_site: 'low', admin_dashboard: 'high' }`. */
  dataDensity: Record<string, DataDensity>;
  targetUsers: string[];
  /** Short human-readable note on what corpus/signal this profile was derived from. */
  sourceSummary: string;
}

/** Minimal queue-entry shape {@link profileApp} needs — deliberately decoupled from `QueueEntry`. */
export interface AppProfilerQueueEntry {
  id: string;
  name?: string;
  description?: string;
  prompt_type?: string;
}

export interface AppProfilerInput {
  projectName: string;
  entries: readonly AppProfilerQueueEntry[];
  /** Parsed `package.json` (dependencies + devDependencies keys are what's read), when available. */
  packageJson?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null;
}

// ---------------------------------------------------------------------------
// Vocabulary (the deterministic keyword scoring tables every field is derived from)
// ---------------------------------------------------------------------------

/** `application_type.primary` candidates -> the keywords that count as a hit for that type. */
const APPLICATION_TYPE_VOCAB: Readonly<Record<string, readonly string[]>> = {
  b2b_commerce: ['b2b', 'wholesale', 'supplier', 'distributor', 'quoting', 'quote', 'purchase order', 'procurement'],
  e_commerce: ['storefront', 'checkout', 'cart', 'product catalog', 'shopping', 'sku', 'e-commerce', 'ecommerce'],
  marketplace: ['marketplace', 'listing', 'buyer', 'seller', 'escrow', 'multi-vendor'],
  saas: ['subscription', 'tenant', 'multi-tenant', 'billing', 'workspace', 'plan tier', 'saas'],
  marketing_site: ['landing page', 'marketing site', 'brand site', 'hero section', 'lead capture', 'homepage'],
  portfolio: ['portfolio', 'showcase', 'case study', 'gallery'],
  admin_tool: ['admin panel', 'back office', 'internal tool', 'ops console', 'operator console'],
  agent_platform: ['agent', 'autonomous', 'orchestrator', 'multi-agent', 'workflow automation'],
  fintech_platform: ['payment', 'ledger', 'invoice', 'transaction', 'banking', 'wallet', 'fintech'],
  content_platform: ['blog', 'article', 'cms', 'publishing', 'editorial'],
  social_platform: ['feed', 'follow', 'comment', 'social', 'profile page', 'messaging'],
  api_platform: ['api console', 'developer portal', 'sdk', 'api key', 'webhook'],
} as const;

/** Freeform tags scored the same way but allowed to multi-match (`applicationType.secondary`). */
const SECONDARY_APPLICATION_TAG_VOCAB: Readonly<Record<string, readonly string[]>> = {
  manufacturing: ['manufacturing', 'fabrication', 'production line', 'factory'],
  architect_portal: ['architect', 'architectural', 'blueprint', 'spec sheet'],
  customer_portal: ['customer portal', 'client portal', 'account dashboard'],
  quoting_system: ['quote', 'quoting', 'estimate', 'rfq'],
  analytics: ['analytics', 'reporting', 'metrics dashboard', 'kpi'],
  scheduling: ['calendar', 'scheduling', 'booking', 'appointment'],
  crm: ['crm', 'lead management', 'pipeline', 'contact record'],
  inventory: ['inventory', 'stock level', 'warehouse'],
  auth_platform: ['sign up', 'sign in', 'authentication', 'sso', 'oauth'],
};

/** `interface_types` candidates -> keywords. Every match above zero is included (not just the top). */
const INTERFACE_TYPE_VOCAB: Readonly<Record<string, readonly string[]>> = {
  marketing_site: ['landing page', 'homepage', 'hero section', 'marketing site', 'pricing page'],
  customer_dashboard: ['customer dashboard', 'client dashboard', 'account overview', 'my account'],
  admin_dashboard: ['admin dashboard', 'admin panel', 'back office'],
  production_dashboard: ['production dashboard', 'operator console', 'ops dashboard', 'factory floor'],
  architect_workspace: ['architect workspace', 'design workspace', 'project workspace'],
  product_configurator: ['configurator', 'customize product', 'build your own'],
  '3d_visualizer': ['3d viewer', '3d visualizer', 'three.js', 'model viewer', 'webgl'],
  auth_flow: ['login page', 'signup page', 'sign-in flow', 'onboarding flow'],
  settings: ['settings page', 'preferences page', 'account settings'],
  analytics_console: ['analytics dashboard', 'reporting console', 'metrics view'],
  api_console: ['api console', 'developer console', 'api explorer'],
  mobile_dashboard: ['mobile dashboard', 'responsive dashboard', 'mobile app view'],
};

/** `target_users` candidates — generic persona nouns, matched as whole words against the corpus. */
const TARGET_USER_VOCAB: readonly string[] = [
  'architect',
  'contractor',
  'estimator',
  'fabricator',
  'customer',
  'admin',
  'administrator',
  'operator',
  'manager',
  'agent',
  'vendor',
  'supplier',
  'developer',
  'analyst',
  'guest',
  'member',
  'patient',
  'student',
  'teacher',
  'buyer',
  'seller',
];

/** Motion-intent keywords — any hit nudges `motionRequirement` up a tier. */
const MOTION_KEYWORDS: readonly string[] = [
  'animation',
  'animate',
  'transition',
  'parallax',
  'motion design',
  'micro-interaction',
  'scroll-triggered',
];

/** 3D-intent keywords — any hit nudges `threeDRequirement` up a tier. */
const THREE_D_KEYWORDS: readonly string[] = [
  'three.js',
  'threejs',
  '3d model',
  '3d viewer',
  '3d visualizer',
  'webgl',
  'glb',
  'gltf',
  'procedural geometry',
];

/** `package.json` dependency names that count as a strong 3D signal regardless of prompt text. */
const THREE_D_PACKAGE_HINTS: readonly string[] = ['three', '@react-three/fiber', '@react-three/drei', 'babylonjs'];

/** High-density-hinting keywords, scored per interface type present in the profile. */
const HIGH_DENSITY_KEYWORDS: readonly string[] = ['data table', 'data grid', 'dense', 'analytics', 'spreadsheet-like'];
const LOW_DENSITY_KEYWORDS: readonly string[] = ['landing', 'marketing', 'hero', 'minimal', 'single column'];

/**
 * Curated `application_type.primary` -> brand tone/avoid defaults. Provisional heuristics, not
 * observed project data — see this file's header. `general` is the fallback for any primary type
 * without a dedicated entry.
 */
const BRAND_DEFAULTS_BY_APPLICATION_TYPE: Readonly<Record<string, { tone: readonly string[]; avoid: readonly string[] }>> = {
  b2b_commerce: {
    tone: ['industrial', 'precise', 'premium', 'architectural'],
    avoid: ['playful', 'cartoonish', 'generic_saas', 'excessive_gradients'],
  },
  e_commerce: {
    tone: ['confident', 'clean', 'trustworthy'],
    avoid: ['cluttered', 'ai_slop_icons'],
  },
  marketplace: {
    tone: ['neutral', 'trustworthy', 'transactional'],
    avoid: ['overly_branded', 'decorative_charts'],
  },
  saas: {
    tone: ['clean', 'professional', 'efficient'],
    avoid: ['generic_saas', 'unnecessary_glassmorphism'],
  },
  marketing_site: {
    tone: ['bold', 'expressive', 'premium'],
    avoid: ['cramped_cards', 'generic_saas'],
  },
  portfolio: {
    tone: ['editorial', 'refined', 'expressive'],
    avoid: ['excessive_rounded_boxes', 'ai_slop_icons'],
  },
  admin_tool: {
    tone: ['precise', 'restrained', 'utilitarian'],
    avoid: ['excessive_gradients', 'decorative_charts'],
  },
  agent_platform: {
    tone: ['technical', 'precise', 'modern'],
    avoid: ['playful', 'ai_slop_icons'],
  },
  fintech_platform: {
    tone: ['trustworthy', 'precise', 'restrained'],
    avoid: ['playful', 'excessive_gradients'],
  },
  content_platform: {
    tone: ['editorial', 'clear', 'legible'],
    avoid: ['cramped_cards', 'decorative_charts'],
  },
  social_platform: {
    tone: ['warm', 'approachable', 'modern'],
    avoid: ['clinical', 'cramped_cards'],
  },
  api_platform: {
    tone: ['technical', 'precise', 'minimal'],
    avoid: ['playful', 'excessive_gradients'],
  },
  general: {
    tone: ['clean', 'modern', 'clear_navigation'],
    avoid: ['generic_saas', 'ai_slop_icons'],
  },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Count whole-phrase, case-insensitive occurrences of `keyword` in `corpus`. */
function countHits(corpus: string, keyword: string): number {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');
  const matches = corpus.match(pattern);
  return matches ? matches.length : 0;
}

/** Score every entry of a keyword-vocab table against `corpus`; returns non-zero scores only, desc. */
function scoreVocab(corpus: string, vocab: Readonly<Record<string, readonly string[]>>): Array<[string, number]> {
  const scored: Array<[string, number]> = [];
  for (const [key, keywords] of Object.entries(vocab)) {
    const score = keywords.reduce((sum, kw) => sum + countHits(corpus, kw), 0);
    if (score > 0) scored.push([key, score]);
  }
  return scored.sort((a, b) => b[1] - a[1]);
}

/** Total keyword-hit count for a flat keyword list against `corpus`. */
function totalHits(corpus: string, keywords: readonly string[]): number {
  return keywords.reduce((sum, kw) => sum + countHits(corpus, kw), 0);
}

/** Build the searchable corpus: every entry's name + description, lowercased, space-joined. */
function buildCorpus(entries: readonly AppProfilerQueueEntry[]): string {
  return entries
    .map((e) => `${e.name ?? ''} ${e.description ?? ''}`)
    .join(' \n ')
    .toLowerCase();
}

function classifyVisualComplexity(corpus: string, entries: readonly AppProfilerQueueEntry[]): VisualComplexity {
  const uiFeatureCount = entries.filter((e) => e.prompt_type === 'ui' || e.prompt_type === 'feature').length;
  const denseHits = totalHits(corpus, HIGH_DENSITY_KEYWORDS);
  if (denseHits >= 2 || uiFeatureCount >= 8) return 'high';
  if (uiFeatureCount <= 2 && denseHits === 0) return 'low';
  return 'medium';
}

function classifyMotionRequirement(corpus: string): MotionRequirement {
  const hits = totalHits(corpus, MOTION_KEYWORDS);
  if (hits >= 4) return 'high';
  if (hits >= 2) return 'moderate';
  if (hits >= 1) return 'minimal';
  return 'none';
}

function classifyThreeDRequirement(corpus: string, input: AppProfilerInput): ThreeDRequirement {
  const promptHits = totalHits(corpus, THREE_D_KEYWORDS);
  const deps = { ...input.packageJson?.dependencies, ...input.packageJson?.devDependencies };
  const packageHit = THREE_D_PACKAGE_HINTS.some((name) => Object.prototype.hasOwnProperty.call(deps, name));
  if (packageHit || promptHits >= 4) return 'high';
  if (promptHits >= 2) return 'medium';
  if (promptHits >= 1) return 'low';
  return 'none';
}

function classifyDataDensity(corpus: string, interfaceTypes: readonly string[]): Record<string, DataDensity> {
  const density: Record<string, DataDensity> = {};
  const highHits = totalHits(corpus, HIGH_DENSITY_KEYWORDS);
  const lowHits = totalHits(corpus, LOW_DENSITY_KEYWORDS);
  for (const type of interfaceTypes) {
    if (type === 'marketing_site' || type === 'auth_flow' || type === 'settings') {
      density[type] = lowHits >= highHits ? 'low' : 'medium';
    } else if (type.includes('dashboard') || type === 'analytics_console' || type === '3d_visualizer') {
      density[type] = highHits > 0 ? 'high' : 'medium';
    } else {
      density[type] = 'medium';
    }
  }
  return density;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive an {@link AppDesignProfile} from `input`'s queue-entry corpus + `package.json`. Pure and
 * deterministic — never throws, never calls an LLM. An empty corpus (no entries, or entries with
 * no `name`/`description`) degrades to the vocabulary's documented fallbacks (`general` primary
 * type, empty `interfaceTypes`, `low`/`none` complexity/motion/3D) rather than a fabricated guess.
 */
export function profileApp(input: AppProfilerInput): AppDesignProfile {
  const corpus = buildCorpus(input.entries);

  const appTypeScores = scoreVocab(corpus, APPLICATION_TYPE_VOCAB);
  const primary = appTypeScores.length > 0 ? appTypeScores[0]![0] : 'general';
  const secondaryFromPrimaryVocab = appTypeScores.slice(1, 4).map(([key]) => key);
  const secondaryTags = scoreVocab(corpus, SECONDARY_APPLICATION_TAG_VOCAB)
    .slice(0, 4)
    .map(([key]) => key);
  const secondary = [...new Set([...secondaryFromPrimaryVocab, ...secondaryTags])];

  const interfaceTypes = scoreVocab(corpus, INTERFACE_TYPE_VOCAB)
    .slice(0, 6)
    .map(([key]) => key);

  const targetUsers = [...new Set(TARGET_USER_VOCAB.filter((persona) => countHits(corpus, persona) > 0))];

  const brandDefaults = BRAND_DEFAULTS_BY_APPLICATION_TYPE[primary] ?? BRAND_DEFAULTS_BY_APPLICATION_TYPE['general']!;

  const visualComplexity = classifyVisualComplexity(corpus, input.entries);
  const motionRequirement = classifyMotionRequirement(corpus);
  const threeDRequirement = classifyThreeDRequirement(corpus, input);
  const dataDensity = classifyDataDensity(corpus, interfaceTypes);

  const sourceSummary =
    input.entries.length === 0
      ? 'no queue entries available — profile derived from vocabulary fallbacks only'
      : `derived from ${input.entries.length} queue entr${input.entries.length === 1 ? 'y' : 'ies'}` +
        (input.packageJson ? ' + package.json' : '');

  return {
    projectName: input.projectName,
    applicationType: { primary, secondary },
    interfaceTypes,
    brand: { tone: [...brandDefaults.tone], avoid: [...brandDefaults.avoid] },
    visualComplexity,
    motionRequirement,
    threeDRequirement,
    dataDensity,
    targetUsers,
    sourceSummary,
  };
}

// ---------------------------------------------------------------------------
// Persistence (Build Memory: app_design_profiles, schema 3.3.0)
// ---------------------------------------------------------------------------

interface AppDesignProfileRow {
  id: string;
  project_name: string;
  application_type_primary: string;
  application_type_secondary: string;
  interface_types: string;
  brand_tone: string;
  brand_avoid: string;
  visual_complexity: string;
  motion_requirement: string;
  three_d_requirement: string;
  data_density: string;
  target_users: string;
  source_summary: string;
}

function rowToProfile(row: AppDesignProfileRow): AppDesignProfile {
  return {
    projectName: row.project_name,
    applicationType: {
      primary: row.application_type_primary,
      secondary: fromJsonText(row.application_type_secondary, [] as string[]),
    },
    interfaceTypes: fromJsonText(row.interface_types, [] as string[]),
    brand: {
      tone: fromJsonText(row.brand_tone, [] as string[]),
      avoid: fromJsonText(row.brand_avoid, [] as string[]),
    },
    visualComplexity: row.visual_complexity as VisualComplexity,
    motionRequirement: row.motion_requirement as MotionRequirement,
    threeDRequirement: row.three_d_requirement as ThreeDRequirement,
    dataDensity: fromJsonText(row.data_density, {} as Record<string, DataDensity>),
    targetUsers: fromJsonText(row.target_users, [] as string[]),
    sourceSummary: row.source_summary,
  };
}

/**
 * Upsert `profile` into `app_design_profiles`, keyed by `project_name` (one row per project — a
 * re-profile refreshes it rather than accumulating history). Returns the persisted profile, or
 * `null` on a Build Memory failure (Contract 4 — the in-memory profile from {@link profileApp} is
 * still usable by the caller even when persistence fails).
 */
export async function saveAppDesignProfile(profile: AppDesignProfile): Promise<AppDesignProfile | null> {
  return runQuery<AppDesignProfile>('app-profiler.save', (db) => {
    const existing = db
      .prepare('SELECT id FROM app_design_profiles WHERE project_name = ?')
      .get(profile.projectName) as { id: string } | undefined;
    const id = existing?.id ?? newId();
    const ts = nowIso();

    db.prepare(
      `INSERT INTO app_design_profiles (
         id, project_name, application_type_primary, application_type_secondary, interface_types,
         brand_tone, brand_avoid, visual_complexity, motion_requirement, three_d_requirement,
         data_density, target_users, source_summary, created_at, updated_at
       ) VALUES (
         @id, @project_name, @primary, @secondary, @interface_types,
         @brand_tone, @brand_avoid, @visual_complexity, @motion_requirement, @three_d_requirement,
         @data_density, @target_users, @source_summary, @ts, @ts
       )
       ON CONFLICT(project_name) DO UPDATE SET
         application_type_primary = excluded.application_type_primary,
         application_type_secondary = excluded.application_type_secondary,
         interface_types = excluded.interface_types,
         brand_tone = excluded.brand_tone,
         brand_avoid = excluded.brand_avoid,
         visual_complexity = excluded.visual_complexity,
         motion_requirement = excluded.motion_requirement,
         three_d_requirement = excluded.three_d_requirement,
         data_density = excluded.data_density,
         target_users = excluded.target_users,
         source_summary = excluded.source_summary,
         updated_at = @ts`
    ).run({
      id,
      project_name: profile.projectName,
      primary: profile.applicationType.primary,
      secondary: toJsonText(profile.applicationType.secondary),
      interface_types: toJsonText(profile.interfaceTypes),
      brand_tone: toJsonText(profile.brand.tone),
      brand_avoid: toJsonText(profile.brand.avoid),
      visual_complexity: profile.visualComplexity,
      motion_requirement: profile.motionRequirement,
      three_d_requirement: profile.threeDRequirement,
      data_density: toJsonText(profile.dataDensity),
      target_users: toJsonText(profile.targetUsers),
      source_summary: profile.sourceSummary,
      ts,
    });

    const row = db.prepare('SELECT * FROM app_design_profiles WHERE project_name = ?').get(profile.projectName) as
      | AppDesignProfileRow
      | undefined;
    return row ? rowToProfile(row) : null;
  });
}

/** Fetch the persisted {@link AppDesignProfile} for `projectName`. `null` if none exists / unreachable. */
export async function getAppDesignProfile(projectName: string): Promise<AppDesignProfile | null> {
  return runQuery<AppDesignProfile>('app-profiler.get', (db) => {
    const row = db.prepare('SELECT * FROM app_design_profiles WHERE project_name = ?').get(projectName) as
      | AppDesignProfileRow
      | undefined;
    return row ? rowToProfile(row) : null;
  });
}

/**
 * Convenience: derive a fresh profile via {@link profileApp} and persist it in one call, logging
 * the derived primary type + interface count. Returns the in-memory profile even if persistence
 * fails (Contract 4) — only a `null` from {@link profileApp} itself (never happens; it's pure and
 * total) would prevent a result here.
 */
export async function profileAndSaveApp(input: AppProfilerInput): Promise<AppDesignProfile> {
  const profile = profileApp(input);
  log(
    `[APP PROFILER] ${input.projectName}: primary=${profile.applicationType.primary}, ` +
      `interfaces=[${profile.interfaceTypes.join(', ')}], complexity=${profile.visualComplexity}`
  );
  const saved = await saveAppDesignProfile(profile);
  if (!saved) log(`WARNING: [APP PROFILER] could not persist profile for '${input.projectName}'`);
  return profile;
}

export default profileApp;
