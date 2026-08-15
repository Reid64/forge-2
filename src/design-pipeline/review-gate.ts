/**
 * FORGE 2.0 — Design Pipeline: DesignReviewGate (`src/design-pipeline/review-gate.ts`).
 *
 * The visual counterpart to `src/resurrection/human-gate.ts`'s "fifth, structural human gate" —
 * where that gate presents an architectural GOVERNANCE gap for approve/decline, this gate presents
 * a generated component/page's CAPTURED EVIDENCE (`screenshotter.ts`'s {@link ScreenshotResult}
 * array, plus an optional `penpot-integration.ts` design-file URL) for the same approve/decline
 * treatment, so a UI prompt's output is never merged purely because `tsc`/`build`/Sentinel passed.
 * This is the human layer sitting on top of `src/ui-engine/accessibility-checker.ts`'s static
 * source scan and `src/architecture-guardian/post-validator.ts`'s output-quality scan — both of
 * those judge the CODE; this gate judges what the code actually RENDERS AS.
 *
 * House style, matching `src/resurrection/human-gate.ts`/`src/design-pipeline/screenshotter.ts`/
 * `src/design-pipeline/penpot-integration.ts`: interactive mode reuses the boxed-header + readline
 * idiom `human-gate.ts` established; every persistence write is best-effort (Contract 4 posture) —
 * a Build Memory failure never blocks the review outcome from being returned to the caller.
 *
 * WHAT IT DOES:
 *   1. `review()` — the single entry point. Prints a boxed `[DESIGN REVIEW]` header naming the
 *      component, lists every screenshot path captured for it, and (when available) a Penpot
 *      workspace URL to open the same evidence in a real design file.
 *      - INTERACTIVE mode presents three choices via readline: **A**pprove, **R**eject (with a
 *        required feedback string), **S**kip (defer without recording a verdict either way).
 *        Approve/Reject are persisted to the `design_reviews` table (schema 3.1.0,
 *        `src/learning/database.ts`); Skip persists nothing, matching a deferred
 *        `HumanGateEvaluator` decision — no verdict recorded is not the same as a rejection.
 *      - NON-INTERACTIVE mode (autonomous builds, per `runPhase0Scout`/`runPhase3Executor`'s
 *        existing `nonInteractive` posture elsewhere in FORGE) never blocks on stdin. It
 *        auto-approves when the component's accessibility score (read straight off the
 *        {@link ScreenshotResult} array `screenshotter.ts` already computed, never re-derived here)
 *        is at or above `autoApproveThreshold` (default 70); otherwise it defers — never a silent
 *        approval of unscored or low-scoring work, and never a fabricated rejection either. A
 *        rejection returned by `review()` (`approved: false` with `feedback` set, whether from an
 *        interactive Reject or a below-threshold non-interactive defer) is the same signal Phase 3's
 *        Sentinel-failure/Autonomous-Recovery disposition switch already treats a Sentinel/Sentinel
 *        Prime/Architecture Guardian failure as — the caller is expected to route it into that same
 *        recovery path, not a new, parallel halt mechanism.
 *   2. `createDesignReviewGate()` — factory matching the house style of `createPlaywrightScreenshotter`/
 *      `createPenpotIntegration`/`createCredentialVault`.
 *
 * NOT IN SCOPE (deliberately, matching every other module in this pipeline's stated limitations):
 * this module does not capture screenshots itself (`screenshotter.ts`'s job), does not push evidence
 * into Penpot itself (`penpot-integration.ts`'s job), and does not decide WHAT accessibility score
 * counts as passing beyond the single configurable threshold it is handed — that judgment belongs to
 * `src/ui-engine/accessibility-checker.ts`'s own scoring rules, never re-implemented here.
 */

import { createInterface } from 'node:readline';

import { getClient, newId, nowIso, runQuery, toSqliteBool } from '../memory/client.js';
import { getLogger, logLine } from '../tools/forge-logger.js';
import type { ScreenshotResult } from './screenshotter.js';

const log = getLogger('design-pipeline:review-gate');

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The outcome of {@link DesignReviewGate.review} — always returned, never thrown. */
export interface DesignReviewResult {
  /** Whether the reviewed component was approved (human Approve, or a passing auto-approve). */
  approved: boolean;
  /**
   * Human-entered rejection feedback (interactive Reject), or an auto-generated explanation for a
   * non-interactive defer/reject. `null` on approval and on an interactive Skip — no verdict was
   * ever rendered in either of those cases, so there is nothing to explain.
   */
  feedback: string | null;
  /** True iff this result came from the non-interactive accessibility-score auto-approve path. */
  autoApproved: boolean;
  /** Every screenshot file path this review was shown, verbatim from the input `screenshotResults`. */
  screenshotPaths: string[];
  /** The Penpot workspace URL this review was shown, when one was supplied. `null` otherwise. */
  penpotUrl: string | null;
}

/** Options accepted by {@link DesignReviewGate.review}. */
export interface DesignReviewOptions {
  /** Skip readline entirely and decide via the accessibility-score auto-approve rule. */
  nonInteractive?: boolean;
  /** Minimum accessibility score (0-100) required for a non-interactive auto-approve. Default 70. */
  autoApproveThreshold?: number;
  /** `build_runs.id` this review belongs to, for `design_reviews` provenance. Default `'unknown'`. */
  buildRunId?: string;
  /** Prompt id this review was triggered by, for `design_reviews` provenance. Default `'unknown'`. */
  promptId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Task contract: a non-interactive build auto-approves at or above this accessibility score. */
const DEFAULT_AUTO_APPROVE_THRESHOLD = 70;
const DEFAULT_PROVENANCE_ID = 'unknown';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Render an unknown thrown value as a short string. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The accessibility score this review should be judged against: the first non-null
 * {@link ScreenshotResult.accessibilityScore} found across every capture for this component (every
 * viewport of the same component shares the same score — see `screenshotter.ts`'s
 * `computeAccessibilityScore`, computed once per component name, not per viewport). `null` when no
 * capture carried a score — never fabricated, per Iron Law 3.
 */
function resolveAccessibilityScore(screenshotResults: readonly ScreenshotResult[]): number | null {
  for (const shot of screenshotResults) {
    if (typeof shot.accessibilityScore === 'number') return shot.accessibilityScore;
  }
  return null;
}

/** `readline` ask, matching `src/resurrection/human-gate.ts`'s `ask()` helper verbatim. */
function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

/** Print the `[DESIGN REVIEW]` boxed header, matching `human-gate.ts`'s boxed-header idiom. */
function printHeader(componentName: string): void {
  const title = `  [DESIGN REVIEW] ${componentName} - Visual Approval Gate`;
  const width = Math.max(title.length + 2, 44);
  console.log(`\n╔${'═'.repeat(width)}╗`);
  console.log(title);
  console.log(`╚${'═'.repeat(width)}╝\n`);
}

/** Print every screenshot path (and the Penpot URL, if any) this review is presenting as evidence. */
function printEvidence(screenshotResults: readonly ScreenshotResult[], penpotUrl: string | null): void {
  if (screenshotResults.length === 0) {
    console.log('  (no screenshots captured for this component)');
  } else {
    console.log('  Screenshots:');
    for (const shot of screenshotResults) {
      console.log(`    - [${shot.viewport}] ${shot.filePath}`);
    }
  }
  if (penpotUrl) {
    console.log(`  Open in Penpot: ${penpotUrl}`);
  }
  console.log('');
}

/**
 * Persist a review decision to the `design_reviews` table (schema 3.1.0,
 * `src/learning/database.ts`). Best-effort per Contract 4 — a Build Memory failure is logged and
 * swallowed, never blocks `review()` from returning its result.
 */
async function persistDesignReview(
  buildRunId: string,
  promptId: string,
  componentName: string,
  screenshotPath: string | null,
  penpotFileId: string | null,
  approved: boolean,
  feedback: string | null,
  autoApproved: boolean
): Promise<void> {
  await runQuery('persistDesignReview', (db) => {
    db.prepare(
      `INSERT INTO design_reviews
         (id, build_run_id, prompt_id, component_name, screenshot_path, penpot_file_id, human_approved, human_feedback, auto_approved, created_at)
       VALUES
         (@id, @build_run_id, @prompt_id, @component_name, @screenshot_path, @penpot_file_id, @human_approved, @human_feedback, @auto_approved, @created_at)`
    ).run({
      id: newId(),
      build_run_id: buildRunId,
      prompt_id: promptId,
      component_name: componentName,
      screenshot_path: screenshotPath,
      penpot_file_id: penpotFileId,
      human_approved: toSqliteBool(approved),
      human_feedback: feedback,
      auto_approved: toSqliteBool(autoApproved),
      created_at: nowIso(),
    });
    return true;
  });
}

/** Best-effort extraction of a Penpot file id from its workspace URL (`?file-id=<id>`), for provenance. */
function extractPenpotFileId(penpotUrl: string | null): string | null {
  if (!penpotUrl) return null;
  try {
    const match = /[?&]file-id=([^&]+)/.exec(penpotUrl);
    return match && match[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DesignReviewGate
// ---------------------------------------------------------------------------

/**
 * Presents a generated component's captured screenshot/Penpot evidence for human (or, in
 * non-interactive builds, accessibility-score-gated automatic) approval. One instance holds no
 * state between calls — construct once per design-pipeline run or per call, either is safe.
 */
export class DesignReviewGate {
  private readonly log: (message: string) => void;

  constructor(options: { log?: (message: string) => void } = {}) {
    this.log = options.log ?? logLine('review-gate');
  }

  /**
   * Review `componentName`'s captured evidence. Interactive mode blocks on readline for an
   * Approve/Reject/Skip decision; non-interactive mode never blocks, deciding purely from the
   * component's accessibility score against `options.autoApproveThreshold` (default
   * {@link DEFAULT_AUTO_APPROVE_THRESHOLD}). Never throws — every failure mode (no Build Memory,
   * no accessibility score, an unreachable stdin) degrades to a returned, non-approved result with
   * an explanatory `feedback` string rather than an uncaught exception.
   */
  async review(
    componentName: string,
    screenshotResults: readonly ScreenshotResult[],
    penpotUrl: string | null,
    options: DesignReviewOptions = {}
  ): Promise<DesignReviewResult> {
    const buildRunId = options.buildRunId ?? DEFAULT_PROVENANCE_ID;
    const promptId = options.promptId ?? DEFAULT_PROVENANCE_ID;
    const threshold = options.autoApproveThreshold ?? DEFAULT_AUTO_APPROVE_THRESHOLD;
    const screenshotPaths = screenshotResults.map((shot) => shot.filePath);
    const firstScreenshotPath = screenshotResults.length > 0 ? (screenshotResults[0]?.filePath ?? null) : null;
    const penpotFileId = extractPenpotFileId(penpotUrl);

    printHeader(componentName);
    printEvidence(screenshotResults, penpotUrl);

    if (options.nonInteractive) {
      return this.reviewNonInteractive(
        componentName,
        screenshotResults,
        screenshotPaths,
        penpotUrl,
        buildRunId,
        promptId,
        firstScreenshotPath,
        penpotFileId,
        threshold
      );
    }

    return this.reviewInteractive(
      componentName,
      screenshotPaths,
      penpotUrl,
      buildRunId,
      promptId,
      firstScreenshotPath,
      penpotFileId
    );
  }

  /**
   * Non-interactive decision path: auto-approve when the component's accessibility score is at or
   * above `threshold`; otherwise defer (never a fabricated approval of unscored/failing work).
   */
  private async reviewNonInteractive(
    componentName: string,
    screenshotResults: readonly ScreenshotResult[],
    screenshotPaths: string[],
    penpotUrl: string | null,
    buildRunId: string,
    promptId: string,
    firstScreenshotPath: string | null,
    penpotFileId: string | null,
    threshold: number
  ): Promise<DesignReviewResult> {
    const score = resolveAccessibilityScore(screenshotResults);

    if (score !== null && score >= threshold) {
      this.log(`[DESIGN REVIEW] Auto-approved ${componentName} score ${score}/100`);
      await persistDesignReview(
        buildRunId,
        promptId,
        componentName,
        firstScreenshotPath,
        penpotFileId,
        true,
        null,
        true
      );
      return {
        approved: true,
        feedback: null,
        autoApproved: true,
        screenshotPaths,
        penpotUrl,
      };
    }

    const feedback =
      score === null
        ? `[DESIGN REVIEW] no accessibility score available for ${componentName} — deferring, not auto-approving`
        : `[DESIGN REVIEW] ${componentName} score ${score}/100 is below the auto-approve threshold (${threshold}) — deferring`;
    this.log(feedback);

    return {
      approved: false,
      feedback,
      autoApproved: false,
      screenshotPaths,
      penpotUrl,
    };
  }

  /**
   * Interactive decision path: readline Approve/Reject/Skip, matching `human-gate.ts`'s
   * boxed-header + readline idiom. Approve/Reject persist to `design_reviews`; Skip persists
   * nothing and returns a non-approved, feedback-less deferral.
   */
  private async reviewInteractive(
    componentName: string,
    screenshotPaths: string[],
    penpotUrl: string | null,
    buildRunId: string,
    promptId: string,
    firstScreenshotPath: string | null,
    penpotFileId: string | null
  ): Promise<DesignReviewResult> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (
        await ask(rl, '  [A]pprove, [R]eject (with feedback), or [S]kip? > ')
      )
        .trim()
        .toLowerCase();

      if (answer === 'a' || answer === 'approve') {
        this.log(`[DESIGN REVIEW] ${componentName} approved by human reviewer`);
        await persistDesignReview(
          buildRunId,
          promptId,
          componentName,
          firstScreenshotPath,
          penpotFileId,
          true,
          null,
          false
        );
        return { approved: true, feedback: null, autoApproved: false, screenshotPaths, penpotUrl };
      }

      if (answer === 'r' || answer === 'reject') {
        const feedback = (await ask(rl, '  Feedback (required): > ')).trim();
        this.log(`[DESIGN REVIEW] ${componentName} rejected by human reviewer: ${feedback}`);
        await persistDesignReview(
          buildRunId,
          promptId,
          componentName,
          firstScreenshotPath,
          penpotFileId,
          false,
          feedback,
          false
        );
        return { approved: false, feedback, autoApproved: false, screenshotPaths, penpotUrl };
      }

      // 's'/'skip', or any unrecognized answer — defer, persist nothing (matching
      // HumanGateEvaluator's non-interactive "defer" outcome, applied here to an explicit
      // interactive Skip rather than to the absence of a human at all).
      this.log(`[DESIGN REVIEW] ${componentName} review skipped — no verdict recorded`);
      return { approved: false, feedback: null, autoApproved: false, screenshotPaths, penpotUrl };
    } catch (error) {
      this.log(`WARNING: [DESIGN REVIEW] interactive review failed for '${componentName}' (${describeError(error)})`);
      return { approved: false, feedback: null, autoApproved: false, screenshotPaths, penpotUrl };
    } finally {
      rl.close();
    }
  }
}

/** True iff Build Memory (the `design_reviews` table's home) is currently reachable. Never throws. */
export function isDesignReviewMemoryAvailable(): boolean {
  try {
    return getClient() !== null;
  } catch {
    return false;
  }
}

/** Factory matching the house style of `createPlaywrightScreenshotter`/`createPenpotIntegration`. */
export function createDesignReviewGate(options: { log?: (message: string) => void } = {}): DesignReviewGate {
  return new DesignReviewGate(options);
}

// Re-export so callers that only need the logger's `[DESIGN REVIEW]` tag convention can reuse the
// same child logger instead of constructing their own `getLogger('design-pipeline:review-gate')` call.
export const designReviewGateLogger = log;

export default DesignReviewGate;
