/**
 * FORGE 2.0 — Design Pipeline: DeploymentGate (`src/design-pipeline/deployment-gate.ts`).
 *
 * `upgrades/DESIGN_INTELLIGENCE.md`'s "never ship an unapproved design" requirement, made real:
 * {@link checkDesignApproval} is the actual, wired-in check that stops `forge deploy` from
 * proceeding unless the target project has a real, recorded `design_reviews` approval — not merely
 * an exported-but-unused function, see `src/deploy/pre-deploy-gate.ts`'s `runPreDeployGate`, which
 * calls this on every deploy alongside its existing `pnpm run build`/`pnpm run lint` checks.
 *
 * READ PATH: reuses the EXACT storage this codebase already established for design approvals — the
 * `design_reviews` table (schema 3.1.0, `src/learning/database.ts`'s `DESIGN_REVIEWS_SCHEMA_SQL`),
 * written by `review-gate.ts`'s `DesignReviewGate.review()` (interactive Approve, or a
 * non-interactive accessibility-score auto-approve) via its `human_approved` column. This module
 * invents no new storage — it joins `design_reviews` to `build_runs` on `project_path`, the SAME
 * join `src/cli/index.ts`'s `cmdDesignHistory` (`forge design history`) already uses to scope
 * reviews to one project.
 *
 * FAIL-CLOSED, DELIBERATELY: every other Build-Memory-backed module in `src/design-pipeline/`
 * degrades to a neutral default when Build Memory is unreachable (Contract 4 — memory unavailability
 * must never halt a BUILD). A DEPLOY gate is different: its entire job is to prove a real approval
 * exists before shipping, so "we couldn't check" can never be silently treated as "it's fine, ship
 * it" — that would be exactly the fabricated-success failure mode Iron Law 3 forbids. When Build
 * Memory is unreachable, or the read itself throws, {@link checkDesignApproval} returns
 * `approved: false` with a reason explaining why, the same as finding zero approved rows.
 */

import { fromSqliteBool, runQuery } from '../memory/client.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface DesignApprovalCheckResult {
  /** `true` iff at least one `design_reviews` row for this project has `human_approved = 1`. */
  approved: boolean;
  /** Human-readable explanation, always populated (approved or not) — never a bare boolean with no context. */
  reason: string;
  approvedReviewCount: number;
  totalReviewCount: number;
  /** ISO timestamp of the most recent approved review, or `null` when none is approved. */
  latestApprovedAt: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface DesignReviewApprovalRow {
  human_approved: number;
  created_at: string;
}

function unreachableResult(reason: string): DesignApprovalCheckResult {
  return { approved: false, reason, approvedReviewCount: 0, totalReviewCount: 0, latestApprovedAt: null };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The real pre-deploy design gate: `true` iff `projectPath` has at least one `design_reviews` row
 * (joined to `build_runs.project_path`, matching `cmdDesignHistory`'s own scoping) with
 * `human_approved = 1`. Fails CLOSED — a missing/unreachable Build Memory, a query error, or zero
 * matching rows all resolve to `approved: false` (see file header for why this module never
 * degrades to a permissive default the way other `src/design-pipeline/` modules do). Never throws.
 */
export async function checkDesignApproval(projectPath: string): Promise<DesignApprovalCheckResult> {
  const rows = await runQuery<DesignReviewApprovalRow[]>('deployment-gate.checkDesignApproval', (db) => {
    return db
      .prepare(
        `SELECT dr.human_approved, dr.created_at
         FROM design_reviews dr
         JOIN build_runs br ON br.id = dr.build_run_id
         WHERE br.project_path = ?`
      )
      .all(projectPath) as DesignReviewApprovalRow[];
  });

  if (rows === null) {
    return unreachableResult(
      `DEPLOY BLOCKED — Build Memory is unreachable, so no approved design_reviews record for ` +
        `'${projectPath}' could be verified (failing closed).`
    );
  }

  const approvedRows = rows.filter((r) => fromSqliteBool(r.human_approved));
  const approvedReviewCount = approvedRows.length;
  const totalReviewCount = rows.length;
  const latestApprovedAt = approvedRows.reduce<string | null>(
    (latest, r) => (latest === null || r.created_at > latest ? r.created_at : latest),
    null
  );

  if (approvedReviewCount === 0) {
    const detail =
      totalReviewCount === 0
        ? `no design_reviews records exist for '${projectPath}' — no design review has run for this project yet.`
        : `${totalReviewCount} design_reviews record(s) exist for '${projectPath}', but none is approved (human_approved = 1).`;
    return { approved: false, reason: `DEPLOY BLOCKED — ${detail}`, approvedReviewCount, totalReviewCount, latestApprovedAt };
  }

  return {
    approved: true,
    reason: `${approvedReviewCount}/${totalReviewCount} design_reviews record(s) approved for '${projectPath}' (most recent: ${latestApprovedAt}).`,
    approvedReviewCount,
    totalReviewCount,
    latestApprovedAt,
  };
}

export default checkDesignApproval;
