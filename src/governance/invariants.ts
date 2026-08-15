/**
 * FORGE 2.0 — Invariant Engine.
 *
 * `upgrades/ENGINEERING_COMPLETENESS.md` § "3. An invariant engine": FORGE needs rules that must
 * remain true regardless of what agents change, "machine-enforced invariants, not prose
 * suggestions." Per the stage4-traceability-invariants task brief, every invariant below is a
 * machine-checked restatement of an ALREADY-EXISTING rule from `BEHAVIORAL_CONTRACTS.md` — none
 * invented — checked against data FORGE already records (`prompt_executions`, `gap_audit_runs`,
 * the project's own git history), the same posture `src/governance/definition-of-done.ts` already
 * established: every check degrades to `'skipped'` (never a false pass) when the data it needs is
 * unavailable, and never throws.
 *
 * Starter set (four invariants — more can be added to {@link INVARIANTS} following the same
 * `InvariantDefinition` shape without changing any call site):
 *   - `no-write-during-build`            — Contract 3  (Governance Immutability During Execution)
 *   - `sentinel-mandatory-checks-passed` — Contract 13 (Health Check Suite)
 *   - `critical-gaps-deferred-to-human`  — Contract AUT-5 (CRITICAL Gaps Are Never Auto-Resolved)
 *   - `no-direct-commits-to-main-during-build` — Contract 10 (Branch Isolation)
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { getBuildsByProject } from '../memory/builds.js';
import { getPromptsByBuild } from '../memory/prompts.js';
import { getLatestGapAuditRunForProject } from '../memory/gap-audits.js';
import { SENTINEL_CHECK_ORDER } from '../phases/phase4-sentinel.js';
import type { ArtifactName } from '../resurrection/types.js';
import type { BuildRun } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type InvariantId =
  | 'no-write-during-build'
  | 'sentinel-mandatory-checks-passed'
  | 'critical-gaps-deferred-to-human'
  | 'no-direct-commits-to-main-during-build';

export type InvariantStatus = 'pass' | 'fail' | 'skipped';

export interface InvariantContext {
  projectPath: string;
  /** Scope build-scoped checks to a specific `build_runs.id`. Default: the project's latest build. */
  buildId?: string;
}

export interface InvariantResult {
  id: InvariantId;
  /** The BEHAVIORAL_CONTRACTS.md contract this invariant restates, verbatim heading text. */
  contract: string;
  description: string;
  status: InvariantStatus;
  detail: string;
}

interface InvariantDefinition {
  id: InvariantId;
  contract: string;
  description: string;
  check: (ctx: InvariantContext) => Promise<InvariantResult>;
}

/** All registered invariants, in the order they run. */
export const INVARIANTS: InvariantDefinition[] = [
  {
    id: 'no-write-during-build',
    contract: 'Contract 3 — Governance Immutability During Execution',
    description: 'Once Phase 3 begins, no governance document may be modified by any prompt or agent.',
    check: checkNoWriteDuringBuild,
  },
  {
    id: 'sentinel-mandatory-checks-passed',
    contract: 'Contract 13 — Health Check Suite',
    description: "After every prompt, Sentinel's full mandatory check suite must have run; a prompt marked PASSED with a missing check is a vacuous pass.",
    check: checkSentinelMandatoryChecksPassed,
  },
  {
    id: 'critical-gaps-deferred-to-human',
    contract: 'Contract AUT-5 — CRITICAL Gaps Are Never Auto-Resolved, Regardless of Any Flag',
    description: 'A CRITICAL gap must always be deferred to HumanGateEvaluator — no flag or mode may route it around that deferral.',
    check: checkCriticalGapsDeferredToHuman,
  },
  {
    id: 'no-direct-commits-to-main-during-build',
    contract: 'Contract 10 — Branch Isolation',
    description: 'Main branch never receives direct commits during Phase 3; merges to main only occur after Sentinel passes.',
    check: checkNoDirectCommitsToMainDuringBuild,
  },
];

/** Run a single invariant by id. Returns `null` when `id` is not a registered invariant. */
export async function checkInvariant(id: InvariantId, ctx: InvariantContext): Promise<InvariantResult | null> {
  const def = INVARIANTS.find((i) => i.id === id);
  return def ? def.check(ctx) : null;
}

/**
 * Run every registered invariant against `projectPath`. Intended call sites (per the task brief):
 * Phase 3 pre-write (before a prompt's changes are committed) and Phase 5 end (after the whole
 * build finishes) — both pass the same `projectPath`; a caller mid-build may additionally supply
 * `buildId` to pin the check to the in-flight build rather than whatever is currently latest.
 */
export async function checkAllInvariants(projectPath: string, buildId?: string): Promise<InvariantResult[]> {
  const ctx: InvariantContext = { projectPath, buildId };
  return Promise.all(INVARIANTS.map((def) => def.check(ctx)));
}

/** Render invariant results as human-readable lines (used by the CLI and Phase 5/pre-write logging). */
export function formatInvariantResults(results: InvariantResult[]): string {
  return results
    .map((r) => `  [${r.status.toUpperCase()}] ${r.id} (${r.contract}): ${r.detail}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Governance artifact filenames (Contract 3 scope)
// ---------------------------------------------------------------------------

/**
 * `ArtifactName` → the real filename it maps to on disk (`src/resurrection/types.ts` ›
 * `ARTIFACT_NAMES`, the same 9-value set System 1's GapAuditor already scores).
 *
 * `STATE_OF_THE_BUILD` and `SESSION_STATE` are deliberately EXCLUDED from the set Contract 3
 * actually protects here: `src/engine/queue-generator.ts`'s `STATE_FOOTER` ("Update
 * STATE_OF_THE_BUILD.md and SESSION_STATE.md from actual codebase audit.") is appended to EVERY
 * Phase 3 prompt's task text — every real build's prompts are instructed to update those two
 * living build-log documents as part of normal, expected execution. Including them here would
 * make this invariant fail on every real build FORGE has ever run, which is not what Contract 3's
 * "no governance document may be modified" is protecting against — the core DEFINITIONAL
 * documents (what to build, how it's architected, what must remain true) are the ones a prompt
 * must never silently rewrite.
 */
const PROTECTED_ARTIFACT_FILENAMES: Partial<Record<ArtifactName, string>> = {
  PRD: 'PRD.md',
  BLUEPRINT: 'BLUEPRINT.md',
  SCHEMA_REGISTRY: 'SCHEMA_REGISTRY.md',
  BEHAVIORAL_CONTRACTS: 'BEHAVIORAL_CONTRACTS.md',
  AGENTS: 'AGENTS.md',
  TOOLCHAIN: 'TOOLCHAIN.md',
  TESTING: 'TESTING.md',
};
const PROTECTED_BASENAMES = new Set(Object.values(PROTECTED_ARTIFACT_FILENAMES));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeResult(
  id: InvariantId,
  contract: string,
  description: string,
  status: InvariantStatus,
  detail: string
): InvariantResult {
  return { id, contract, description, status, detail };
}

async function resolveBuild(projectPath: string, buildId?: string): Promise<BuildRun | null> {
  const projectName = basename(projectPath) || 'project';
  const builds = await getBuildsByProject(projectName);
  if (builds === null) return null;
  if (buildId) return builds.find((b) => b.id === buildId) ?? null;
  return builds[0] ?? null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Invariant 1 — Contract 3
// ---------------------------------------------------------------------------

async function checkNoWriteDuringBuild(ctx: InvariantContext): Promise<InvariantResult> {
  const id: InvariantId = 'no-write-during-build';
  const def = INVARIANTS.find((i) => i.id === id)!;
  const build = await resolveBuild(ctx.projectPath, ctx.buildId);
  if (!build) {
    return makeResult(id, def.contract, def.description, 'skipped', 'No build_runs row found for this project — nothing to check yet.');
  }
  const executions = await getPromptsByBuild(build.id);
  if (executions === null) {
    return makeResult(id, def.contract, def.description, 'skipped', 'Build Memory unreachable — cannot verify per-prompt file changes.');
  }

  const violations: string[] = [];
  for (const exec of executions) {
    const changed = [...exec.files_created, ...exec.files_modified, ...exec.files_deleted];
    for (const file of changed) {
      if (PROTECTED_BASENAMES.has(basename(file))) {
        violations.push(`${exec.prompt_name} touched ${file}`);
      }
    }
  }

  if (violations.length > 0) {
    return makeResult(
      id,
      def.contract,
      def.description,
      'fail',
      `${violations.length} governance-doc write(s) recorded during build ${build.id}: ${violations.slice(0, 5).join('; ')}${violations.length > 5 ? ', …' : ''}.`
    );
  }
  return makeResult(id, def.contract, def.description, 'pass', `No governance-doc writes recorded across ${executions.length} prompt(s) in build ${build.id}.`);
}

// ---------------------------------------------------------------------------
// Invariant 2 — Contract 13
// ---------------------------------------------------------------------------

interface StoredSentinelCheck {
  name?: string;
  passed?: boolean;
  skipped?: boolean;
}

async function checkSentinelMandatoryChecksPassed(ctx: InvariantContext): Promise<InvariantResult> {
  const id: InvariantId = 'sentinel-mandatory-checks-passed';
  const def = INVARIANTS.find((i) => i.id === id)!;
  const build = await resolveBuild(ctx.projectPath, ctx.buildId);
  if (!build) {
    return makeResult(id, def.contract, def.description, 'skipped', 'No build_runs row found for this project — nothing to check yet.');
  }
  const executions = await getPromptsByBuild(build.id);
  if (executions === null) {
    return makeResult(id, def.contract, def.description, 'skipped', 'Build Memory unreachable — cannot verify sentinel_details.');
  }
  const withSentinel = executions.filter((e) => e.sentinel_details !== null);
  if (withSentinel.length === 0) {
    return makeResult(id, def.contract, def.description, 'skipped', `No prompt in build ${build.id} has recorded sentinel_details yet.`);
  }

  const violations: string[] = [];
  for (const exec of withSentinel) {
    const details = exec.sentinel_details as { checks?: StoredSentinelCheck[] } | null;
    const checks = Array.isArray(details?.checks) ? details!.checks : [];
    const ranNames = new Set(checks.map((c) => c.name));
    const missing = SENTINEL_CHECK_ORDER.filter((name) => !ranNames.has(name));
    if (exec.sentinel_passed === true && missing.length > 0) {
      violations.push(`${exec.prompt_name}: marked passed but missing check(s) [${missing.join(', ')}]`);
    }
  }

  if (violations.length > 0) {
    return makeResult(
      id,
      def.contract,
      def.description,
      'fail',
      `${violations.length} prompt(s) in build ${build.id} recorded a PASS with mandatory checks missing: ${violations.slice(0, 5).join('; ')}${violations.length > 5 ? ', …' : ''}.`
    );
  }
  return makeResult(id, def.contract, def.description, 'pass', `All ${withSentinel.length} sentinel-checked prompt(s) in build ${build.id} that passed ran every mandatory check.`);
}

// ---------------------------------------------------------------------------
// Invariant 3 — Contract AUT-5
// ---------------------------------------------------------------------------

async function checkCriticalGapsDeferredToHuman(ctx: InvariantContext): Promise<InvariantResult> {
  const id: InvariantId = 'critical-gaps-deferred-to-human';
  const def = INVARIANTS.find((i) => i.id === id)!;
  const projectName = basename(ctx.projectPath) || 'project';
  const run = await getLatestGapAuditRunForProject(projectName);
  if (run === null) {
    return makeResult(id, def.contract, def.description, 'skipped', 'Build Memory unreachable, or no gap_audit_runs row exists yet — run `forge audit` first.');
  }
  if (run.gaps_critical === 0) {
    return makeResult(id, def.contract, def.description, 'pass', `Latest gap audit ${run.id} (${run.created_at}) found zero CRITICAL gaps.`);
  }
  if (run.gaps_human_gated >= run.gaps_critical) {
    return makeResult(
      id,
      def.contract,
      def.description,
      'pass',
      `Latest gap audit ${run.id}: ${run.gaps_critical} CRITICAL gap(s), ${run.gaps_human_gated} deferred to the human gate (>= critical count).`
    );
  }
  return makeResult(
    id,
    def.contract,
    def.description,
    'fail',
    `Latest gap audit ${run.id}: ${run.gaps_critical} CRITICAL gap(s) but only ${run.gaps_human_gated} human-gated — one or more CRITICAL gaps may have bypassed the human gate.`
  );
}

// ---------------------------------------------------------------------------
// Invariant 4 — Contract 10
// ---------------------------------------------------------------------------

async function checkNoDirectCommitsToMainDuringBuild(ctx: InvariantContext): Promise<InvariantResult> {
  const id: InvariantId = 'no-direct-commits-to-main-during-build';
  const def = INVARIANTS.find((i) => i.id === id)!;
  const build = await resolveBuild(ctx.projectPath, ctx.buildId);
  if (!build || !build.started_at) {
    return makeResult(id, def.contract, def.description, 'skipped', 'No build_runs row (with a started_at) found for this project — cannot scope a git history check.');
  }
  if (!existsSync(join(ctx.projectPath, '.git'))) {
    return makeResult(id, def.contract, def.description, 'skipped', `${ctx.projectPath} is not a git repository.`);
  }

  let stdout: string;
  try {
    stdout = execFileSync('git', ['log', 'main', `--since=${build.started_at}`, '--no-merges', '--format=%H %s'], {
      cwd: ctx.projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (error) {
    return makeResult(id, def.contract, def.description, 'skipped', `git log failed (${describe(error)}) — main branch may not exist yet.`);
  }

  const directCommits = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (directCommits.length > 0) {
    const mechanism = await diagnoseDirectCommitMechanism(ctx.projectPath, build.id);
    return makeResult(
      id,
      def.contract,
      def.description,
      'fail',
      `${directCommits.length} non-merge commit(s) landed directly on main since build ${build.id} started (${build.started_at}): ${directCommits.slice(0, 3).join(' | ')}${directCommits.length > 3 ? ', …' : ''}.${mechanism}`
    );
  }
  return makeResult(id, def.contract, def.description, 'pass', `No direct (non-merge) commit on main since build ${build.id} started (${build.started_at}).`);
}

/**
 * Distinguish two different root causes behind the same symptom (a non-merge commit on main):
 * GitManager's own `mergeToMain` (`git checkout -b` + `git merge --no-ff`) is genuinely buggy for
 * THIS build, vs. these commit(s) never went through Contract 10's branch/merge machinery at all
 * (an external or alternate commit path put them on main directly). Contract 10's own branch is
 * NEVER deleted by any code path — Contract 12 explicitly preserves it on failure, and
 * `GitManager.mergeToMain`/`mergeBranchToMain` check back out to it after a successful merge — so
 * if `git checkout -b`/`git merge --no-ff` genuinely ran for this build, at least one
 * `forge/{buildId}/prompt-N-...` branch this build's own `prompt_executions.branch_name` recorded
 * should still exist as a real ref. Its absence means the commit(s) bypassed GitManager entirely;
 * git-manager.ts is not the place to look for the bug. Best-effort/never throws (Contract 4) — an
 * inconclusive check appends nothing rather than asserting either mechanism without evidence.
 */
async function diagnoseDirectCommitMechanism(projectPath: string, buildId: string): Promise<string> {
  const executions = await getPromptsByBuild(buildId);
  if (executions === null) return '';
  const claimedBranches = executions
    .map((e) => e.branch_name)
    .filter((b): b is string => typeof b === 'string' && b.length > 0);
  if (claimedBranches.length === 0) return '';

  let branchList: string;
  try {
    branchList = execFileSync('git', ['branch', '--list', '--all'], {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch {
    return '';
  }

  const corroborated = claimedBranches.some((branch) => branchList.includes(branch));
  if (corroborated) return '';
  return (
    ` This build's own prompt_executions recorded ${claimedBranches.length} Contract-10 branch name(s) ` +
    `(e.g. '${claimedBranches[0]}') but NONE exist in this repository's branch list — the direct commit(s) ` +
    'above bypassed GitManager.createBranch/mergeToMain entirely rather than exposing a defect in that ' +
    'merge flow; look at whatever process actually produced these commits, not src/engine/git-manager.ts.'
  );
}
