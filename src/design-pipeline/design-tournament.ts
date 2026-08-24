/**
 * FORGE 2.0 — Design Pipeline: DesignTournamentEngine (`src/design-pipeline/design-tournament.ts`).
 *
 * `upgrades/DESIGN_INTELLIGENCE.md`'s component #10 ("Design Tournament Engine") plus #09
 * ("Design Variance Controller," folded in here as {@link computeTokenJaccardSimilarity} — a
 * variance CHECK on already-generated variants, not a separate generation-time subsystem).
 * `upgrades/SYSTEMS-5-9-GAP-MATRIX.md` row 10 confirmed zero prior implementation: "No
 * multi-variant competing-implementation scoring."
 *
 * WHAT IT DOES: "FORGE should never immediately commit the first AI-generated frontend." Given a
 * base `ComponentSpec` (`src/ui-engine/component-generator.ts`), generates 2-4 STRUCTURALLY
 * distinct variants — {@link TOURNAMENT_DIRECTIONS}, four fixed archetypes each carrying real
 * generation parameters (`designVariance`/`motionIntensity`/`density`/`structuralTags`) folded
 * into the spec's `description`/`interactions` before generation, so variance is enforced BY
 * CONSTRUCTION (never a "four color variations" tournament, per the spec's explicit prohibition
 * on `color_only_variants`) rather than by after-the-fact diffing alone. Each variant is
 * generated through the REAL `UIComponentGenerator` (an actual Claude Code CLI call — no mock),
 * captured through the REAL `PlaywrightScreenshotter`, and scored on the 2 of the spec's 9-
 * dimension rubric (`accessibility`, `responsive_quality`) this codebase has a genuine automated
 * evaluator for — see {@link DesignTournamentVariantResult.dimensionsScored}. The remaining 7
 * dimensions (`visual_hierarchy`/`brand_alignment`/`usability`/`consistency`/
 * `information_architecture`/`performance`/`originality`) have NO automated evaluator in this
 * codebase (an "Impeccable Audit Engine" integration, spec component #16, remains MISSING per
 * the gap matrix) and are never fabricated a number — {@link formatTournamentResult} states the
 * partial coverage explicitly on every render, per Iron Law 3.
 *
 * The automated score NEVER auto-selects a winner — {@link chooseTournamentWinner} is the same
 * approve/reject-with-feedback human gate `review-gate.ts` establishes, reused here for an
 * N-way choice instead of a binary one. An approved variant's OWN real `structuralTags` (not
 * inferred prose) are recorded into `design-memory.ts` as `'prefer'` signal; a rejected run's
 * feedback text is extracted the same way `review-gate.ts` Reject feedback is.
 *
 * NOT DONE THIS SESSION, flagged not silently skipped: no live end-to-end run against a real
 * target Next.js project (this repo — the FORGE tool itself — has no target application to run
 * one against); the preview-route write/cleanup path and dev-server capture integration are real
 * code, unit-tested only for their deterministic pieces (direction generation, variant spec
 * construction, similarity scoring) with injected fakes for `ComponentGenerator`/
 * `PlaywrightScreenshotter`, matching `tests/design-system-generator.test.ts`'s injected-runner
 * style.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { newId, nowIso, runQuery, toJsonText } from '../memory/client.js';
import { logLine } from '../tools/forge-logger.js';
import { recordPreference, recordFromRejectionFeedback } from './design-memory.js';
import type { ComponentSpec, GeneratedComponent } from '../ui-engine/component-generator.js';
import type { PlaywrightScreenshotter, ScreenshotResult } from './screenshotter.js';

const log = logLine('design-tournament');

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface DesignDirection {
  id: string;
  name: string;
  designVariance: number;
  motionIntensity: number;
  density: 'low' | 'medium' | 'high';
  structuralTags: string[];
  layoutDirective: string;
}

/** The 2 of 9 spec rubric dimensions this codebase has a real automated evaluator for. */
export interface AutomatedRubricScore {
  accessibility: number | null; // 0-10, scaled from the real 0-100 accessibility score
  responsiveQuality: number | null; // 0-10, scaled from the real viewport-capture success ratio
}

export interface DesignTournamentVariantResult {
  direction: DesignDirection;
  componentName: string;
  filePath: string | null;
  screenshotPaths: string[];
  scores: AutomatedRubricScore;
  dimensionsScored: number;
  /** Sum of the scored dimensions, out of {@link dimensionsScored} × 10 — never rescaled to a
   *  fake /100 (that would silently claim coverage of the 7 unscored dimensions). `null` when
   *  zero dimensions could be scored (e.g. generation itself failed). */
  automatedSubtotal: number | null;
  generationError: string | null;
}

export interface DesignTournamentResult {
  id: string;
  componentName: string;
  variants: DesignTournamentVariantResult[];
  recommendation: string;
  status: 'awaiting_approval' | 'approved' | 'rejected';
}

export interface DesignTournamentChoice {
  approved: boolean;
  winningDirectionId: string | null;
  feedback: string | null;
}

// ---------------------------------------------------------------------------
// The four fixed structural directions (spec: "layout, navigation, information density,
// typography, card structure, sidebar architecture, ... interaction model, motion, ... spacing")
// ---------------------------------------------------------------------------

export const TOURNAMENT_DIRECTIONS: readonly DesignDirection[] = [
  {
    id: 'a',
    name: 'Command Center',
    designVariance: 0.35,
    motionIntensity: 0.15,
    density: 'high',
    structuralTags: ['sidebar_nav', 'high_density', 'restrained_motion'],
    layoutDirective:
      'Persistent left sidebar navigation. Dense multi-column data grid as the primary content ' +
      'area. Minimal decorative motion — only functional state transitions. Information-first ' +
      'hierarchy: data and controls take precedence over illustration or whitespace.',
  },
  {
    id: 'b',
    name: 'Intelligence Console',
    designVariance: 0.65,
    motionIntensity: 0.35,
    density: 'medium',
    structuralTags: ['top_nav', 'medium_density', 'moderate_motion', 'card_grid'],
    layoutDirective:
      'Top navigation bar with contextual secondary tabs (no persistent sidebar). Card-based ' +
      'content grid at medium density. Moderate transition motion between states (fade/slide, ' +
      'never more than 300ms).',
  },
  {
    id: 'c',
    name: 'Operations Grid',
    designVariance: 0.85,
    motionIntensity: 0.55,
    density: 'medium',
    structuralTags: ['split_pane', 'medium_density', 'expressive_motion'],
    layoutDirective:
      'Split-pane layout: a list/index panel on one side, a detail panel on the other. ' +
      'Expressive motion on selection/state changes. Medium-density content with strong visual ' +
      'grouping (bordered sections, not just spacing).',
  },
  {
    id: 'd',
    name: 'Minimal Engineering',
    designVariance: 0.95,
    motionIntensity: 0.2,
    density: 'low',
    structuralTags: ['single_column', 'low_density', 'restrained_motion', 'larger_spacing'],
    layoutDirective:
      'Single-column layout with generous whitespace. No persistent sidebar or multi-panel split. ' +
      'Restrained motion. Typography-led hierarchy — headings and spacing do the organizing work, ' +
      'not boxes or dividers.',
  },
];

const MIN_VARIANTS = 2;
const MAX_VARIANTS = TOURNAMENT_DIRECTIONS.length;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Clamp the requested variant count to [{@link MIN_VARIANTS}, {@link MAX_VARIANTS}]. */
export function resolveVariantCount(requested: number): number {
  if (!Number.isFinite(requested)) return MAX_VARIANTS;
  return Math.max(MIN_VARIANTS, Math.min(MAX_VARIANTS, Math.round(requested)));
}

/** Select `count` directions from {@link TOURNAMENT_DIRECTIONS}, in their fixed variance order. */
export function buildVariantDirections(count: number): DesignDirection[] {
  const n = resolveVariantCount(count);
  return TOURNAMENT_DIRECTIONS.slice(0, n);
}

/**
 * Build one variant's `ComponentSpec` from `baseSpec` + `direction` — the direction's
 * `layoutDirective` and `structuralTags` are appended to `description`/`interactions`
 * respectively, which is what makes the resulting variants structurally distinct rather than a
 * `color_only_variant` (the spec's explicitly prohibited failure mode). `name` is suffixed with
 * the direction id so each variant writes to its own file
 * (`<projectPath>/src/components/<Name>Variant<ID>.tsx`, per `component-generator.ts`'s own
 * `spec.name`-derived path) instead of overwriting a shared one.
 */
export function buildVariantSpec(baseSpec: ComponentSpec, direction: DesignDirection): ComponentSpec {
  return {
    ...baseSpec,
    name: `${baseSpec.name}Variant${direction.id.toUpperCase()}`,
    description: `${baseSpec.description}\n\nDESIGN DIRECTION — "${direction.name}": ${direction.layoutDirective}`,
    interactions: [...baseSpec.interactions, `Structural direction tags: ${direction.structuralTags.join(', ')}`],
  };
}

/**
 * The path {@link UIComponentGenerator.generate} writes a variant to
 * (`component-generator.ts`'s own `projectPath/src/components/${spec.name}.tsx` convention) —
 * mirrored here so `--use-existing` can check for a variant's file BEFORE paying for generation.
 */
export function variantFilePath(projectPath: string, variantSpecName: string): string {
  return join(projectPath, 'src', 'components', `${variantSpecName}.tsx`);
}

/**
 * Real, deterministic variance verification (spec component #09, "Design Variance Controller"):
 * Jaccard similarity of the two code strings' whitespace-tokenized word sets. `1.0` = identical
 * token sets, `0.0` = no shared tokens. Used to WARN (not block) when two variants ended up
 * suspiciously similar despite distinct structural directives — a real check on the actual
 * generated output, never a fabricated diff.
 */
export function computeTokenJaccardSimilarity(codeA: string, codeB: string): number {
  const tokensA = new Set(codeA.split(/\s+/).filter((t) => t.length > 0));
  const tokensB = new Set(codeB.split(/\s+/).filter((t) => t.length > 0));
  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection++;
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

/** Above this similarity, two variants are flagged as suspiciously non-distinct (logged, not blocking). */
const SUSPICIOUS_SIMILARITY_THRESHOLD = 0.9;

function scoreVariant(screenshots: ScreenshotResult[], viewportsRequested: number): {
  scores: AutomatedRubricScore;
  dimensionsScored: number;
  automatedSubtotal: number | null;
} {
  if (screenshots.length === 0) {
    return { scores: { accessibility: null, responsiveQuality: null }, dimensionsScored: 0, automatedSubtotal: null };
  }
  const rawAccessibility = screenshots.find((s) => typeof s.accessibilityScore === 'number')?.accessibilityScore ?? null;
  const accessibility = rawAccessibility === null ? null : rawAccessibility / 10;
  const responsiveQuality = viewportsRequested > 0 ? (screenshots.length / viewportsRequested) * 10 : null;

  let dimensionsScored = 0;
  let subtotal = 0;
  if (accessibility !== null) {
    dimensionsScored++;
    subtotal += accessibility;
  }
  if (responsiveQuality !== null) {
    dimensionsScored++;
    subtotal += responsiveQuality;
  }

  return {
    scores: { accessibility, responsiveQuality },
    dimensionsScored,
    automatedSubtotal: dimensionsScored > 0 ? subtotal : null,
  };
}

/** POSIX-style relative import path (no extension) from `fromDir` to `toFileNoExt`. */
function relativeImportPath(fromDir: string, toFileNoExt: string): string {
  const rel = relative(fromDir, toFileNoExt).split('\\').join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** Minimal, valid Next.js App Router page that renders `componentName`, for screenshot capture. */
function buildPreviewPageSource(pageDir: string, componentFilePathNoExt: string, componentName: string): string {
  const importPath = relativeImportPath(pageDir, componentFilePathNoExt);
  return (
    `import { ${componentName} } from '${importPath}';\n\n` +
    `export default function DesignTournamentPreviewPage() {\n` +
    `  return <${componentName} />;\n` +
    `}\n`
  );
}

// ---------------------------------------------------------------------------
// Collaborator contracts (injectable for tests — matches `DesignPipeline`'s own house style)
// ---------------------------------------------------------------------------

export interface ComponentGeneratorLike {
  generate(spec: ComponentSpec, projectPath: string, buildRunId: string, promptId: string): Promise<GeneratedComponent>;
}

export interface DesignTournamentOptions {
  log?: (message: string) => void;
  variantCount?: number;
  componentGenerator?: ComponentGeneratorLike;
  screenshotter?: PlaywrightScreenshotter;
  /**
   * When true, a variant whose expected file ({@link variantFilePath}) already exists on disk is
   * read from disk and reused verbatim — its generation step is skipped entirely — instead of
   * being regenerated. Off by default: a stale/unrelated file at that path would otherwise be
   * silently reused, so a caller must opt in explicitly (matches `forge build
   * --use-existing-queue`'s posture, not an automatic resume).
   */
  useExisting?: boolean;
}

// ---------------------------------------------------------------------------
// DesignTournamentEngine
// ---------------------------------------------------------------------------

export class DesignTournamentEngine {
  private readonly log: (message: string) => void;
  private readonly variantCount: number;
  private readonly componentGenerator: ComponentGeneratorLike | null;
  private readonly screenshotter: PlaywrightScreenshotter | null;
  private readonly useExisting: boolean;

  constructor(options: DesignTournamentOptions = {}) {
    this.log = options.log ?? log;
    this.variantCount = resolveVariantCount(options.variantCount ?? MAX_VARIANTS);
    this.componentGenerator = options.componentGenerator ?? null;
    this.screenshotter = options.screenshotter ?? null;
    this.useExisting = options.useExisting ?? false;
  }

  /**
   * Generate + capture + score {@link resolveVariantCount}(options.variantCount) structurally
   * distinct variants of `baseSpec`, persist the run, and return the (never auto-selected)
   * result. A single variant's generation failure is recorded on that variant
   * (`generationError`) and does not abort the other variants — this pipeline's Contract 4
   * posture, matching `design-pipeline/index.ts`.
   */
  async run(
    baseSpec: ComponentSpec,
    projectPath: string,
    buildRunId: string,
    promptId: string
  ): Promise<DesignTournamentResult> {
    const directions = buildVariantDirections(this.variantCount);
    this.log(`[DESIGN TOURNAMENT] '${baseSpec.name}': generating ${directions.length} variant(s)`);

    const runId = newId();
    const previewDir = join(projectPath, 'src', 'app', '_forge-design-tournament', runId);
    const generated: Array<{ direction: DesignDirection; component: GeneratedComponent | null; error: string | null }> = [];

    for (const direction of directions) {
      const variantSpec = buildVariantSpec(baseSpec, direction);

      if (this.useExisting) {
        const reused = this.tryReuseExistingVariant(variantSpec, direction, projectPath);
        if (reused) {
          generated.push({ direction, component: reused, error: null });
          continue;
        }
      }

      if (!this.componentGenerator) {
        generated.push({ direction, component: null, error: 'no ComponentGenerator configured' });
        continue;
      }
      try {
        this.log(`[DESIGN TOURNAMENT] variant '${direction.name}': generating (no reusable file found)`);
        const component = await this.componentGenerator.generate(variantSpec, projectPath, buildRunId, promptId);
        generated.push({ direction, component, error: null });
      } catch (error) {
        this.log(`WARNING: [DESIGN TOURNAMENT] variant '${direction.name}' generation failed (${describeError(error)})`);
        generated.push({ direction, component: null, error: describeError(error) });
      }
    }

    this.warnOnSuspiciousSimilarity(generated);

    const variants = await this.captureAndScoreVariants(generated, projectPath, buildRunId, promptId, previewDir);
    this.cleanupPreviewDir(previewDir);

    const recommendation = buildRecommendation(baseSpec.name, variants);
    const result: DesignTournamentResult = {
      id: runId,
      componentName: baseSpec.name,
      variants,
      recommendation,
      status: 'awaiting_approval',
    };
    await this.persistRun(result, projectPath, buildRunId, promptId);
    return result;
  }

  /**
   * `--use-existing`: if `variantSpec`'s expected file ({@link variantFilePath}) already exists on
   * disk, read it and return a {@link GeneratedComponent} built from the on-disk code — skipping
   * generation entirely. Returns `null` (falls through to normal generation) when the file is
   * missing or unreadable; a read failure is never silently treated as "reuse" of empty code.
   */
  private tryReuseExistingVariant(
    variantSpec: ComponentSpec,
    direction: DesignDirection,
    projectPath: string
  ): GeneratedComponent | null {
    const filePath = variantFilePath(projectPath, variantSpec.name);
    if (!existsSync(filePath)) return null;
    try {
      const code = readFileSync(filePath, 'utf8');
      this.log(`[DESIGN TOURNAMENT] variant '${direction.name}': REUSING existing file (--use-existing) → ${filePath}`);
      return { spec: variantSpec, code, storyCode: '', testCode: '', filePath };
    } catch (error) {
      this.log(
        `WARNING: [DESIGN TOURNAMENT] variant '${direction.name}': found ${filePath} but could not read it ` +
          `(${describeError(error)}) — generating instead.`
      );
      return null;
    }
  }

  /** Logs (never throws/blocks) a WARNING for any pair of successfully-generated variants whose
   *  code is suspiciously similar despite distinct structural directives. */
  private warnOnSuspiciousSimilarity(
    generated: ReadonlyArray<{ direction: DesignDirection; component: GeneratedComponent | null; error: string | null }>
  ): void {
    const ok = generated.filter((g) => g.component !== null);
    for (let i = 0; i < ok.length; i++) {
      for (let j = i + 1; j < ok.length; j++) {
        const a = ok[i]!;
        const b = ok[j]!;
        const similarity = computeTokenJaccardSimilarity(a.component!.code, b.component!.code);
        if (similarity >= SUSPICIOUS_SIMILARITY_THRESHOLD) {
          this.log(
            `WARNING: [DESIGN TOURNAMENT] variants '${a.direction.name}' and '${b.direction.name}' are ` +
              `${Math.round(similarity * 100)}% token-similar despite distinct structural directives — ` +
              `check the generator actually varied layout/navigation/density, not just palette.`
          );
        }
      }
    }
  }

  private async captureAndScoreVariants(
    generated: ReadonlyArray<{ direction: DesignDirection; component: GeneratedComponent | null; error: string | null }>,
    projectPath: string,
    buildRunId: string,
    promptId: string,
    previewDir: string
  ): Promise<DesignTournamentVariantResult[]> {
    const results: DesignTournamentVariantResult[] = [];
    const viewportCount = 4; // matches screenshotter.ts DEFAULT_VIEWPORTS

    let devServerPort: number | null = null;
    if (this.screenshotter && generated.some((g) => g.component !== null)) {
      devServerPort = await this.screenshotter.startDevServer(projectPath).catch(() => null);
    }

    for (const g of generated) {
      if (!g.component) {
        results.push({
          direction: g.direction,
          componentName: `${g.direction.name}`,
          filePath: null,
          screenshotPaths: [],
          scores: { accessibility: null, responsiveQuality: null },
          dimensionsScored: 0,
          automatedSubtotal: null,
          generationError: g.error,
        });
        continue;
      }

      let screenshots: ScreenshotResult[] = [];
      if (this.screenshotter && devServerPort !== null) {
        screenshots = await this.captureVariant(g.component, g.direction, projectPath, previewDir, devServerPort, buildRunId, promptId);
      }
      const scored = scoreVariant(screenshots, viewportCount);
      results.push({
        direction: g.direction,
        componentName: g.component.spec.name,
        filePath: g.component.filePath,
        screenshotPaths: screenshots.map((s) => s.filePath),
        scores: scored.scores,
        dimensionsScored: scored.dimensionsScored,
        automatedSubtotal: scored.automatedSubtotal,
        generationError: null,
      });
    }

    if (this.screenshotter && devServerPort !== null) await this.screenshotter.stopDevServer();
    return results;
  }

  private async captureVariant(
    component: GeneratedComponent,
    direction: DesignDirection,
    projectPath: string,
    previewDir: string,
    devServerPort: number,
    buildRunId: string,
    promptId: string
  ): Promise<ScreenshotResult[]> {
    if (!this.screenshotter) return [];
    const variantPageDir = join(previewDir, direction.id);
    try {
      mkdirSync(variantPageDir, { recursive: true });
      const componentFileNoExt = component.filePath.replace(/\.tsx$/, '');
      const pageSource = buildPreviewPageSource(variantPageDir, componentFileNoExt, component.spec.name);
      writeFileSync(join(variantPageDir, 'page.tsx'), pageSource, 'utf8');
    } catch (error) {
      this.log(`WARNING: [DESIGN TOURNAMENT] could not write preview page for '${direction.name}' (${describeError(error)})`);
      return [];
    }

    const route = `/_forge-design-tournament/${previewDir.split(/[\\/]/).pop()}/${direction.id}`;
    const url = `http://localhost:${devServerPort}${route}`;
    try {
      return await this.screenshotter.captureComponent(url, {
        projectPath,
        buildRunId,
        promptId,
        componentName: component.spec.name,
      });
    } catch (error) {
      this.log(`WARNING: [DESIGN TOURNAMENT] capture failed for '${direction.name}' (${describeError(error)})`);
      return [];
    }
  }

  private cleanupPreviewDir(previewDir: string): void {
    try {
      rmSync(previewDir, { recursive: true, force: true });
    } catch (error) {
      this.log(`WARNING: [DESIGN TOURNAMENT] could not clean up preview directory '${previewDir}' (${describeError(error)})`);
    }
  }

  private async persistRun(
    result: DesignTournamentResult,
    projectPath: string,
    buildRunId: string,
    promptId: string
  ): Promise<void> {
    const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
    await runQuery('design-tournament.persistRun', (db) => {
      db.prepare(
        `INSERT INTO design_tournament_runs (id, project_name, build_run_id, prompt_id, component_name, variant_count, status, recommendation, created_at)
         VALUES (@id, @project_name, @build_run_id, @prompt_id, @component_name, @variant_count, @status, @recommendation, @created_at)`
      ).run({
        id: result.id,
        project_name: projectName,
        build_run_id: buildRunId,
        prompt_id: promptId,
        component_name: result.componentName,
        variant_count: result.variants.length,
        status: result.status,
        recommendation: result.recommendation,
        created_at: nowIso(),
      });
      const insertVariant = db.prepare(
        `INSERT INTO design_tournament_variants (
           id, run_id, direction_id, direction_name, design_variance, motion_intensity, density,
           structural_tags, file_path, screenshot_paths, scores, total_score, dimensions_scored, created_at
         ) VALUES (
           @id, @run_id, @direction_id, @direction_name, @design_variance, @motion_intensity, @density,
           @structural_tags, @file_path, @screenshot_paths, @scores, @total_score, @dimensions_scored, @created_at
         )`
      );
      for (const v of result.variants) {
        insertVariant.run({
          id: newId(),
          run_id: result.id,
          direction_id: v.direction.id,
          direction_name: v.direction.name,
          design_variance: v.direction.designVariance,
          motion_intensity: v.direction.motionIntensity,
          density: v.direction.density,
          structural_tags: toJsonText(v.direction.structuralTags),
          file_path: v.filePath,
          screenshot_paths: toJsonText(v.screenshotPaths),
          scores: toJsonText(v.scores),
          total_score: v.automatedSubtotal,
          dimensions_scored: v.dimensionsScored,
          created_at: nowIso(),
        });
      }
      return true;
    });
  }
}

/**
 * Build a factual (never invented-prose) recommendation from real computed deltas across the
 * automated-evaluator dimensions only, explicitly disclosing the 7 dimensions it did NOT score.
 */
function buildRecommendation(componentName: string, variants: readonly DesignTournamentVariantResult[]): string {
  const scored = variants.filter((v) => v.automatedSubtotal !== null);
  if (scored.length === 0) {
    return (
      `No variant of '${componentName}' produced an automated score (generation and/or capture ` +
      `failed for every variant) — human review required directly against the generated source.`
    );
  }
  const ranked = [...scored].sort((a, b) => (b.automatedSubtotal ?? 0) - (a.automatedSubtotal ?? 0));
  const top = ranked[0]!;
  const accessibilityText = top.scores.accessibility !== null ? `${Math.round(top.scores.accessibility * 10)}/100` : 'n/a';
  const responsiveText =
    top.scores.responsiveQuality !== null ? `${Math.round(top.scores.responsiveQuality * 10)}%` : 'n/a';
  return (
    `Design ${top.direction.name} scored highest on the automated subtotal (${top.automatedSubtotal?.toFixed(1)}/20): ` +
    `accessibility ${accessibilityText}, viewport capture ${responsiveText}. Automated evaluators cover 2 of 9 rubric ` +
    `dimensions (accessibility, responsive_quality) — visual_hierarchy, brand_alignment, usability, consistency, ` +
    `information_architecture, performance, and originality require human judgment (or a future design-audit-tool ` +
    `integration) and are NOT reflected in this score. AWAITING HUMAN DESIGN APPROVAL.`
  );
}

/** Render a {@link DesignTournamentResult} for CLI/log display. */
export function formatTournamentResult(result: DesignTournamentResult): string {
  const lines: string[] = [];
  lines.push(`DESIGN TOURNAMENT — ${result.componentName} (run ${result.id})`);
  for (const v of result.variants) {
    const scoreText =
      v.automatedSubtotal !== null ? `${v.automatedSubtotal.toFixed(1)}/20 (${v.dimensionsScored}/9 dims)` : 'unscored';
    const errorText = v.generationError ? ` — GENERATION FAILED: ${v.generationError}` : '';
    lines.push(`  [${v.direction.id.toUpperCase()}] ${v.direction.name} — ${scoreText}${errorText}`);
  }
  lines.push('');
  lines.push(result.recommendation);
  lines.push(`STATUS: ${result.status === 'awaiting_approval' ? 'AWAITING HUMAN DESIGN APPROVAL' : result.status.toUpperCase()}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Approval (never auto-selects — same posture as `review-gate.ts`)
// ---------------------------------------------------------------------------

/**
 * Apply a human (or explicit non-interactive-defer) choice to `result`: on approval, records the
 * winning variant's real `structuralTags` into Design Memory as `'prefer'` signal and persists
 * `winning_variant_id`; on an explicit reject-all with feedback, extracts reject tags from that
 * feedback the same way `review-gate.ts` does. Never auto-approves — a caller must supply
 * `choice` explicitly (there is no non-interactive auto-approve path for a tournament, unlike the
 * single-component review gate's accessibility-threshold shortcut — a MULTI-way choice has no
 * single defensible automatic winner).
 */
export async function applyTournamentChoice(
  result: DesignTournamentResult,
  choice: DesignTournamentChoice,
  projectName: string
): Promise<DesignTournamentResult> {
  const status: DesignTournamentResult['status'] = choice.approved ? 'approved' : 'rejected';

  if (choice.approved && choice.winningDirectionId) {
    const winner = result.variants.find((v) => v.direction.id === choice.winningDirectionId);
    if (winner) {
      await recordPreference(winner.direction.structuralTags, 'prefer', projectName, `design-tournament:${result.id}`);
    }
  } else if (!choice.approved && choice.feedback) {
    await recordFromRejectionFeedback(choice.feedback, projectName, `design-tournament:${result.id}`);
  }

  await runQuery('design-tournament.applyChoice', (db) => {
    db.prepare('UPDATE design_tournament_runs SET status = ?, winning_variant_id = ?, decided_at = ? WHERE id = ?').run(
      status,
      choice.winningDirectionId,
      nowIso(),
      result.id
    );
    return true;
  });

  return { ...result, status };
}

export function createDesignTournamentEngine(options: DesignTournamentOptions = {}): DesignTournamentEngine {
  return new DesignTournamentEngine(options);
}

export default DesignTournamentEngine;
