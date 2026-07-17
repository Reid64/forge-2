/**
 * FORGE 2.0 — System 1: HumanGateEvaluator (src/resurrection/human-gate.ts).
 *
 * The fifth, structural human gate (RESURRECTION_BLUEPRINT.md §HumanGateEvaluator). Presents
 * every CRITICAL/HUMAN_GATE-tier gap for approve/decline; in non-interactive mode it DEFERS
 * every gated gap and halts for human — it never auto-approves an architectural change. This
 * gate cannot be disabled by any flag or environment variable (Contract R-3).
 */

import { createInterface } from 'node:readline';

import type { ArtifactScore, Gap, GateDecision, GateOutcome } from './types.js';

function ask(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve));
}

/**
 * A gap is architectural (must be gated, never auto-regenerated) iff it matches one of the
 * three CRITICAL conditions from RESURRECTION_BLUEPRINT.md, or is a MAJOR gap on an artifact
 * whose composite_score has fallen below 0.3 (too degraded to auto-trust). MINOR is never gated.
 */
export function isArchitecturalGap(gap: Gap, artifactScore?: ArtifactScore): boolean {
  if (gap.severity === 'MINOR') return false;
  if (gap.severity === 'CRITICAL') return true;
  if (gap.severity === 'MAJOR' && artifactScore && artifactScore.composite_score < 0.3) return true;
  return false;
}

export interface EvaluateGatesOptions {
  nonInteractive?: boolean;
}

/**
 * Present every gated gap for approve/decline. Interactive mode reuses the boxed-header +
 * readline idiom from `src/retrofit/reconcile.ts`; non-interactive mode defers every gap and
 * marks the outcome `haltedForHuman = true`.
 */
export async function evaluateGates(gates: readonly Gap[], opts: EvaluateGatesOptions = {}): Promise<GateOutcome> {
  const decisions: GateDecision[] = [];

  if (gates.length === 0) {
    return { decisions, gatedCount: 0, approvedCount: 0, deferredCount: 0, haltedForHuman: false };
  }

  if (opts.nonInteractive) {
    for (const gap of gates) {
      decisions.push({ gap, approved: false, deferred: true });
    }
    return {
      decisions,
      gatedCount: gates.length,
      approvedCount: 0,
      deferredCount: gates.length,
      haltedForHuman: true,
    };
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('  FORGE 2.0 — RESURRECTION HUMAN GATE (5th gate)');
  console.log('╚══════════════════════════════════════════════╝\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let approvedCount = 0;
  let deferredCount = 0;
  try {
    for (let i = 0; i < gates.length; i++) {
      const gap = gates[i];
      if (!gap) continue;
      console.log(`  [ARCHITECTURAL GAP ${i + 1}/${gates.length}]  Artifact: ${gap.artifact}`);
      console.log(`  Gap: ${gap.message}`);
      console.log(`  If approved, FORGE will regenerate the affected section of ${gap.artifact}.md`);
      console.log(`  reconstructed from the code's actual usage. It will NOT create/alter any table or route.`);
      const ans = (await ask(rl, '  Approve regeneration of this section? (y/N) > ')).trim().toLowerCase();
      const approved = ans === 'y' || ans === 'yes';
      decisions.push({ gap, approved, deferred: !approved });
      if (approved) approvedCount++;
      else deferredCount++;
      console.log('');
    }
  } finally {
    rl.close();
  }

  return { decisions, gatedCount: gates.length, approvedCount, deferredCount, haltedForHuman: false };
}
