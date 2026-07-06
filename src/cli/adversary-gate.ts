/**
 * FORGE 2.0 — Adversary-review blocker gate (Session 5 finding #2/#3).
 *
 * Extracted from `src/cli/index.ts` so it can be exercised in isolation (importing
 * `src/cli/index.ts` itself runs the whole CLI — `main()` is called unconditionally at module
 * load) — verification scripts import this module directly instead.
 *
 * Any adversarial-review BLOCKER finding halts the pipeline — even in autonomous mode — writing
 * the blocker list to `<project>/state/halt-reason.md`. `--accept-blockers` /
 * `--auto-approve-gates` are the explicit human overrides (separate from `--autonomous-recovery`,
 * which is Contract 14 self-heal ONLY and never bypasses a gate).
 */

import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { AdversaryResult } from '../analysis/adversarial-review.js';
import { recordAdversaryBlockerObserved } from '../engine/learning-writeback.js';
import { writeGovernanceFile } from '../tools/governance-text.js';

/** Injectable collaborators (tests / the caller's own console + Build Memory wiring). */
export interface AdversaryGateOptions {
  /** Print a line for each blocker when overridden. Default: no-op. */
  onOverride?: (message: string) => void;
  /** Print the halt message + each blocker when NOT overridden. Default: no-op. */
  onHalt?: (message: string) => void;
  /** Override the halt-report write (tests). Default: writes `<project>/state/halt-reason.md`. */
  writeHaltReport?: (path: string, content: string) => Promise<void>;
  /** Override the learning writeback (tests). Default: {@link recordAdversaryBlockerObserved}. */
  recordBlocker?: typeof recordAdversaryBlockerObserved;
}

const defaultWriteHaltReport = (path: string, content: string): Promise<void> => writeGovernanceFile(path, content);

/**
 * Check one adversary-review result for BLOCKER findings. Returns `true` when the caller may
 * proceed (no blockers, or `acceptBlockers` overrode them) and `false` when it must halt. Never
 * throws — a Build Memory / filesystem failure degrades to a warning, never blocks the decision.
 */
export async function checkAdversaryBlockers(
  projectPath: string,
  phaseLabel: string,
  review: AdversaryResult | null,
  acceptBlockers: boolean,
  options: AdversaryGateOptions = {}
): Promise<boolean> {
  if (!review || review.blockers.length === 0) return true;

  const recordBlocker = options.recordBlocker ?? recordAdversaryBlockerObserved;
  const writeHaltReport = options.writeHaltReport ?? defaultWriteHaltReport;
  const projectName = basename(projectPath) || 'project';

  for (const b of review.blockers) {
    recordBlocker({
      vector: b.vector,
      phase: phaseLabel,
      specificIssue: b.specificIssue,
      evidence: b.evidence,
      recommendedFix: b.recommendedFix,
      projectName,
    }).catch(() => {});
  }

  const lines = [
    '# FORGE halt — adversarial review BLOCKER(s)',
    '',
    `- Phase: ${phaseLabel}`,
    `- Reviewed at: ${review.reviewedAt}`,
    `- Blocker count: ${review.blockers.length}`,
    '',
    '## Blockers',
    '',
    ...review.blockers.map(
      (b, i) =>
        `${i + 1}. [${b.vector}] ${b.specificIssue}\n   - Evidence: ${b.evidence}\n   - Recommended fix: ${b.recommendedFix}`
    ),
    '',
    acceptBlockers
      ? '--accept-blockers was passed — the build proceeded despite the above.'
      : 'Re-run with --accept-blockers to proceed anyway once reviewed, or address the findings and re-run.',
  ];
  try {
    const dir = join(projectPath, 'state');
    await mkdir(dir, { recursive: true });
    await writeHaltReport(join(dir, 'halt-reason.md'), lines.join('\n') + '\n');
  } catch {
    /* best-effort — the console output below still carries the findings */
  }

  if (acceptBlockers) {
    options.onOverride?.(
      `${review.blockers.length} adversarial BLOCKER(s) at ${phaseLabel} — proceeding (--accept-blockers).`
    );
    for (const b of review.blockers) options.onOverride?.(`  [${b.vector}] ${b.specificIssue}`);
    return true;
  }

  options.onHalt?.(
    `${review.blockers.length} adversarial-review BLOCKER(s) at ${phaseLabel} — halted ` +
      '(see state/halt-reason.md). Re-run with --accept-blockers to override.'
  );
  for (const b of review.blockers) options.onHalt?.(`  [${b.vector}] ${b.specificIssue}`);
  return false;
}
