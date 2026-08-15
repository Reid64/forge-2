/**
 * FORGE 2.0 — Design Pipeline: DesignPipeline (`src/design-pipeline/index.ts`).
 *
 * The composition root wiring `PlaywrightScreenshotter` + `PenpotIntegration` + `DesignReviewGate`
 * together into the single entry point Phase 3 calls for a component/page prompt — mirroring
 * `ArchitectureGuardian`'s own composition-root house style (`src/architecture-guardian/index.ts`)
 * one layer up the pipeline: where Guardian judges the CODE a prompt produced, DesignPipeline
 * judges what that code actually RENDERS AS.
 *
 * WHAT IT DOES (`run()`, the single entry point):
 *   1. If none of `modifiedFiles` is a `.tsx` file, there is nothing to visually review — logs
 *      {@link DESIGN_PIPELINE_SKIPPED_MESSAGE} and returns an approved, non-blocking result
 *      immediately. No dev server is ever started for a prompt that touched no UI files.
 *   2. Otherwise: starts the target project's dev server (`screenshotter.ts`), captures every
 *      discovered App Router route at every default viewport, uploads the resulting screenshots
 *      into Penpot when one is reachable and configured for this project
 *      (`penpot-integration.ts` — a screenshot-only build is never degraded by Penpot being
 *      absent), stops the dev server, then runs the visual approval gate over the captured
 *      evidence (`review-gate.ts`).
 *   3. A REJECTED review (interactive Reject, or a non-interactive below-threshold/unscored
 *      defer) has its `feedback` re-formatted as `DESIGN FEEDBACK: <feedback>` before being
 *      returned — a caller (Phase 3) can inject that string directly into a recovery re-run
 *      prompt without any further formatting of its own.
 *
 * House style, matching every other module in this pipeline (`screenshotter.ts`/
 * `penpot-integration.ts`/`review-gate.ts`): every step is guarded — a missing Playwright
 * dependency, an unreachable dev server, an absent/misconfigured Penpot instance, or an
 * unreachable Build Memory connection degrades to a smaller/emptier result and a logged warning,
 * NEVER an uncaught exception. `run()` never throws (Contract 4 posture) — a caller can always
 * await it directly.
 *
 * NOT IN SCOPE (deliberately, matching every other module's stated limitations): this module
 * does not decide WHAT counts as an approval beyond composing the three collaborators' own
 * decisions (that judgment belongs to `review-gate.ts`), does not itself drive a Claude Code
 * recovery re-run (the `DESIGN FEEDBACK:`-formatted result is handed back to the caller, which
 * owns the actual re-run/merge decision — `src/phases/phase3-executor.ts`), and does not persist
 * anything beyond what `review-gate.ts`'s own `design_reviews` write already covers.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { logLine } from '../tools/forge-logger.js';
import {
  PlaywrightScreenshotter,
  createPlaywrightScreenshotter,
  type ScreenshotResult,
} from './screenshotter.js';
import { PenpotIntegration, createPenpotIntegration } from './penpot-integration.js';
import { DesignReviewGate, createDesignReviewGate, type DesignReviewResult } from './review-gate.js';
import { getDesignStoragePath, ensureStorageDirectories, getScreenshotPath } from './storage-config.js';
import { profileAndSaveApp, type AppProfilerQueueEntry } from './app-profiler.js';
import { routeDesign, recordRoutingOutcome, formatRoutingDecision, type DesignRoutingDecision } from './design-router.js';
import { recordFromRejectionFeedback } from './design-memory.js';

export type { ScreenshotResult } from './screenshotter.js';
export type { PenpotConfig, PenpotFileResult, PenpotUploadResult } from './penpot-integration.js';
export type { DesignReviewResult, DesignReviewOptions } from './review-gate.js';
export type { AppDesignProfile } from './app-profiler.js';
export type { DesignRoutingDecision } from './design-router.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * Minimal queue-entry shape {@link DesignPipeline.run} needs — deliberately decoupled from
 * `src/engine/queue-generator.ts`'s `QueueEntry` so this module has no dependency on the
 * queue/engine layer (matching every other module under `src/design-pipeline/`, none of which
 * import from `src/engine/`). A caller holding a real `QueueEntry` (e.g. `phase3-executor.ts`)
 * satisfies this shape with no conversion needed — every field it reads is already on `QueueEntry`.
 */
export interface DesignPipelinePromptEntry {
  /** The prompt's id — used as `promptId` provenance for screenshots/Penpot uploads/reviews. */
  id: string;
  /** The prompt's display name — preferred as the reviewed component's name when non-empty. */
  name?: string;
  /** The prompt's type — carried through for caller-side logging only; not read by this module. */
  prompt_type?: string;
}

/** Logged whenever `run()` finds no modified `.tsx` file and skips the pipeline entirely. */
export const DESIGN_PIPELINE_SKIPPED_MESSAGE = '[DESIGN PIPELINE] Skipped - no UI files modified';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The Penpot "project" (Penpot's own container concept, distinct from a FORGE `projectPath`) a
 * created design file belongs to, when `PENPOT_PROJECT_ID` is not set. Penpot requires SOME
 * project id to create a file in; a fixed default keeps every FORGE-created file grouped
 * together on a Penpot instance that hasn't been given a project-per-FORGE-project mapping.
 */
const DEFAULT_PENPOT_PROJECT_ID = 'default';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Render an unknown thrown value as a short string. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The component/page name to review — the prompt's name when non-empty, else its id. */
function resolveComponentName(promptEntry: DesignPipelinePromptEntry): string {
  const name = promptEntry.name?.trim();
  if (name && name !== '') return name;
  const id = promptEntry.id.trim();
  return id !== '' ? id : 'component';
}

/** A safe, always-returnable result for the "nothing to review" (no `.tsx` changes) path. */
function skippedResult(): DesignReviewResult {
  return { approved: true, feedback: null, autoApproved: false, screenshotPaths: [], penpotUrl: null };
}

/** Best-effort parse of `<projectPath>/package.json`'s `dependencies`/`devDependencies`. `null` on any failure. */
function readPackageJson(
  projectPath: string
): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null {
  try {
    const path = join(projectPath, 'package.json');
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DesignPipeline
// ---------------------------------------------------------------------------

/** Options accepted by {@link DesignPipeline}'s constructor / {@link createDesignPipeline}. */
export interface DesignPipelineOptions {
  log?: (message: string) => void;
  /** Injectable collaborator override (tests). Default: a fresh {@link PlaywrightScreenshotter}. */
  screenshotter?: PlaywrightScreenshotter;
  /** Injectable collaborator override (tests). Default: a fresh {@link PenpotIntegration}. */
  penpot?: PenpotIntegration;
  /** Injectable collaborator override (tests). Default: a fresh {@link DesignReviewGate}. */
  reviewGate?: DesignReviewGate;
}

/**
 * Runs the full visual-evidence pipeline for one prompt's UI output: capture → (optionally) push
 * to Penpot → review. One instance holds no state between calls — safe to construct once per
 * build (the house style `phase3-executor.ts` uses for every other injectable collaborator) or
 * once per call.
 */
export class DesignPipeline {
  private readonly log: (message: string) => void;
  private readonly screenshotter: PlaywrightScreenshotter;
  private readonly penpot: PenpotIntegration;
  private readonly reviewGate: DesignReviewGate;

  constructor(options: DesignPipelineOptions = {}) {
    this.log = options.log ?? logLine('design-pipeline');
    this.screenshotter = options.screenshotter ?? createPlaywrightScreenshotter({ log: this.log });
    this.penpot = options.penpot ?? createPenpotIntegration({ log: this.log });
    this.reviewGate = options.reviewGate ?? createDesignReviewGate({ log: this.log });
  }

  /**
   * Review `promptEntry`'s UI output. Returns `{ approved: true, ... }` immediately (no dev
   * server, no Playwright, no Penpot, no review-gate call) when `modifiedFiles` contains no
   * `.tsx` file. Never throws — every collaborator failure degrades to a smaller/emptier result,
   * matching this pipeline's Contract 4 posture throughout.
   */
  async run(
    promptEntry: DesignPipelinePromptEntry,
    projectPath: string,
    buildRunId: string,
    modifiedFiles: readonly string[],
    nonInteractive: boolean,
    /**
     * The full queue's entries (`schedule.order` in `phase3-executor.ts`), when the caller has
     * them available — feeds `app-profiler.ts`'s corpus so the derived {@link AppDesignProfile}
     * reflects the WHOLE project, not just this one prompt. Falls back to a single-entry corpus
     * built from `promptEntry` alone when omitted (still real, just narrower) — this parameter is
     * additive/optional so every existing caller keeps compiling unchanged.
     */
    queueEntries?: readonly AppProfilerQueueEntry[]
  ): Promise<DesignReviewResult> {
    const tsxFiles = (modifiedFiles ?? []).filter((f) => f.toLowerCase().endsWith('.tsx'));
    if (tsxFiles.length === 0) {
      this.log(DESIGN_PIPELINE_SKIPPED_MESSAGE);
      return skippedResult();
    }

    const componentName = resolveComponentName(promptEntry);
    const projectName = basename(projectPath);

    // 0a. App Profiler + Design Router (Design Intelligence): derive/refresh the project's
    //     AppDesignProfile from the real queue-entry corpus + package.json, then route this
    //     prompt's interface type against the Design Capability Registry for an explainable
    //     tool recommendation. Advisory/logged, per `design-router.ts`'s own scope note — no
    //     alternate design-generation tool is actually invoked by this codebase yet. Never
    //     blocks capture/review on failure (Contract 4).
    const routingDecision = await this.runDesignIntelligence(
      promptEntry,
      projectPath,
      projectName,
      buildRunId,
      queueEntries
    );

    // 0. Resolve (env override → external drive with >100GB free → local fallback) and prepare the
    //    design-artifact storage base before anything is captured, so screenshots for this prompt
    //    land under the same base every other design-pipeline artifact (Penpot exports, reviews,
    //    component specs) uses.
    const storageBasePath = getDesignStoragePath();
    ensureStorageDirectories(storageBasePath);
    const screenshotStorageDir = getScreenshotPath(storageBasePath, buildRunId, promptEntry.id);

    // 1. Start the dev server, capture every discovered route at every default viewport.
    let screenshotResults: ScreenshotResult[] = [];
    let devServerReady = false;
    try {
      const port = await this.screenshotter.startDevServer(projectPath);
      if (port === null) {
        this.log(
          `[DESIGN PIPELINE] WARNING: dev server did not become ready — skipping screenshot capture for '${componentName}'`
        );
      } else {
        devServerReady = true;
        screenshotResults = await this.screenshotter.captureAllRoutes(projectPath, {
          projectPath,
          buildRunId,
          promptId: promptEntry.id,
          componentName,
          storageDir: screenshotStorageDir,
        });
      }
    } catch (error) {
      this.log(`[DESIGN PIPELINE] WARNING: screenshot capture failed for '${componentName}' (${describeError(error)})`);
    }

    // 2. Upload the captured evidence into Penpot, when one is reachable and configured — before
    //    stopping the dev server, matching this pipeline's stated step order (the upload itself
    //    does not depend on the dev server, but sequencing it here keeps the whole capture session
    //    — render, shoot, push — bounded by one dev-server lifetime).
    let penpotUrl: string | null = null;
    if (screenshotResults.length > 0) {
      penpotUrl = await this.uploadToPenpot(componentName, promptEntry.id, projectPath, screenshotResults);
    }

    // 3. Stop the dev server (idempotent/safe even if it never started).
    if (devServerReady) await this.screenshotter.stopDevServer();

    // 4. Run the visual approval gate over whatever evidence was actually captured.
    const reviewResult = await this.reviewGate.review(componentName, screenshotResults, penpotUrl, {
      nonInteractive,
      buildRunId,
      promptId: promptEntry.id,
    });

    // 5. Feed the outcome back into Design Router (historical_success on the next decision) and,
    //    for a genuine INTERACTIVE human rejection only, into Design Memory — never for a
    //    non-interactive auto-defer's synthetic diagnostic string, which is not human critique
    //    (Iron Law 3: never record a preference nobody actually expressed).
    if (routingDecision) {
      await recordRoutingOutcome(routingDecision.id, reviewResult.approved ? 'approved' : 'rejected').catch(() => {});
    }
    if (!nonInteractive && !reviewResult.approved && reviewResult.feedback) {
      await recordFromRejectionFeedback(reviewResult.feedback, projectName, `design-pipeline:${promptEntry.id}`).catch(
        () => []
      );
    }

    if (!reviewResult.approved) {
      const designFeedback = `DESIGN FEEDBACK: ${reviewResult.feedback ?? 'Visual review did not approve this component.'}`;
      return { ...reviewResult, feedback: designFeedback };
    }

    return reviewResult;
  }

  /**
   * Best-effort App Profiler + Design Router pass: refreshes `projectName`'s
   * {@link AppDesignProfile} and, when it has at least one classified interface type, requests a
   * routing decision for the top-scoring one — logging the spec's `DESIGN ROUTING:` explainability
   * block either way. Returns `null` (never throws) on any failure or when the profile classified
   * no interface type at all (nothing meaningful to route on).
   */
  private async runDesignIntelligence(
    promptEntry: DesignPipelinePromptEntry,
    projectPath: string,
    projectName: string,
    buildRunId: string,
    queueEntries?: readonly AppProfilerQueueEntry[]
  ): Promise<DesignRoutingDecision | null> {
    try {
      const entries = queueEntries && queueEntries.length > 0
        ? queueEntries
        : [{ id: promptEntry.id, name: promptEntry.name, prompt_type: promptEntry.prompt_type }];
      const profile = await profileAndSaveApp({
        projectName,
        entries,
        packageJson: readPackageJson(projectPath),
      });

      if (profile.interfaceTypes.length === 0) {
        this.log(`[APP PROFILER] ${projectName}: no interface type classified — skipping Design Router`);
        return null;
      }

      const decision = await routeDesign(profile, profile.interfaceTypes[0]!, {
        buildRunId,
        promptId: promptEntry.id,
        packageJson: readPackageJson(projectPath),
      });
      this.log(formatRoutingDecision(decision));
      return decision;
    } catch (error) {
      this.log(`WARNING: [DESIGN PIPELINE] Design Intelligence pass non-fatal (${describeError(error)})`);
      return null;
    }
  }

  /**
   * Best-effort push of `screenshotResults` into a Penpot file, when Penpot is both reachable
   * (`isAvailable`) and configured (`isConfigured`) for `projectPath`. Returns the resulting
   * design-file URL, or `null` on any failure/absence — never throws, matching
   * `penpot-integration.ts`'s own Contract 4 posture.
   */
  private async uploadToPenpot(
    componentName: string,
    promptId: string,
    projectPath: string,
    screenshotResults: readonly ScreenshotResult[]
  ): Promise<string | null> {
    try {
      const available = await this.penpot.isAvailable();
      if (!available) return null;
      const configured = await this.penpot.isConfigured(projectPath);
      if (!configured) return null;

      const projectId = process.env['PENPOT_PROJECT_ID']?.trim() || DEFAULT_PENPOT_PROJECT_ID;
      const fileResult = await this.penpot.createFile(`${componentName} (${promptId})`, projectId, { projectPath });
      const fileId = fileResult.fileId;
      if (!fileId) return null;

      for (const shot of screenshotResults) {
        await this.penpot.uploadScreenshot(shot.filePath, fileId, { projectPath });
      }
      return fileResult.designFileUrl;
    } catch (error) {
      this.log(`[DESIGN PIPELINE] WARNING: Penpot upload non-fatal (${describeError(error)})`);
      return null;
    }
  }
}

/** Factory matching the house style of `createPlaywrightScreenshotter`/`createPenpotIntegration`/`createDesignReviewGate`. */
export function createDesignPipeline(options: DesignPipelineOptions = {}): DesignPipeline {
  return new DesignPipeline(options);
}

export default DesignPipeline;
