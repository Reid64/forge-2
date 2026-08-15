/**
 * FORGE 2.0 — Formal Build State Machine.
 *
 * `upgrades/ENGINEERING_COMPLETENESS.md` § "4. A formal state machine for the build": "FORGE
 * should know exactly what state a project is in" (project-level: CONCEPT → … → OPTIMIZATION) and
 * "every task should also have state" (PLANNED → … → SUPERSEDED), "That makes autonomous execution
 * deterministic instead of conversational." `upgrades/SYSTEMS-5-9-GAP-MATRIX.md` row 4 confirmed
 * this vocabulary did not exist anywhere in the codebase before this module.
 *
 * Two independent pieces, matching the sibling `src/governance/` modules' posture (no new table,
 * no fabricated signal, degrade honestly rather than guess):
 *
 *   1. {@link PROJECT_STATE_TRANSITIONS} / {@link TASK_STATE_TRANSITIONS} — the full vocabulary
 *      (13 project states, 10 task states) plus a real directed transition graph between them (a
 *      genuine state MACHINE, not just labels) checkable with {@link isValidTransition}.
 *   2. {@link deriveProjectState} / {@link deriveTaskState} / {@link deriveTaskStates} — pure
 *      functions that INFER the current state from data FORGE already records (governance files on
 *      disk, `build_runs`, `gap_audit_runs`, `deployment_history`, and — when a target tier is
 *      supplied — `evaluateDoD`). Every derivation is grounded in a real, checkable signal; where
 *      no such signal exists in the schema today, the function documents the gap and never emits
 *      that state rather than guessing (see "Known gaps" below).
 *
 * Known gaps, flagged not silently accepted (same posture as `traceability.ts`/`invariants.ts`):
 *   - Project-level CONSENSUS is never inferred — no table persists a multi-LLM consensus outcome
 *     tied to a specific BLUEPRINT.md revision (`consensus-validator.ts` runs synchronously and
 *     does not write one). It exists in the vocabulary/transition graph for forward compatibility.
 *   - Project-level OPTIMIZATION is never inferred — `pending_evolutions` (the nearest real table)
 *     tracks FORGE's OWN cross-project learning, not this specific project's post-deployment
 *     optimization work; treating one as evidence for the other would conflate two genuinely
 *     different concepts (the same distinction STATE_OF_THE_BUILD.md's "Note on naming" section
 *     already draws between "Autonomy Upgrades" and REBUILD Session 3's "Autonomy").
 *   - Task-level READY is never inferred — `prompt_executions` rows are created already `RUNNING`
 *     (`logPromptExecution` inserts with `status: 'running'`); there is no persisted intermediate
 *     "dependencies cleared, waiting its turn" row for a single-row derivation to read.
 *   - Task-level SUPERSEDED requires build-wide context (which `prompt_executions` row is not the
 *     latest attempt for its `prompt_name`) that a single-row function cannot see — use
 *     {@link deriveTaskStates} (build-wide) rather than {@link deriveTaskState} (single-row) when
 *     SUPERSEDED matters.
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { getBuildsByProject } from '../memory/builds.js';
import { getLatestGapAuditRunForProject } from '../memory/gap-audits.js';
import { evaluateDoD } from './definition-of-done.js';
import type { ReadinessTierId } from './readiness-levels.js';
import { nowIso, runQuery } from '../memory/client.js';
import type { BuildRun, BuildStatus, PromptExecution } from '../types/index.js';

// ---------------------------------------------------------------------------
// Vocabulary + transition graph
// ---------------------------------------------------------------------------

/** The 13 project-level states, in the order `ENGINEERING_COMPLETENESS.md` § 4 lists them. */
export type ProjectState =
  | 'CONCEPT'
  | 'DISCOVERY'
  | 'ARCHITECTURE'
  | 'CONSENSUS'
  | 'PLANNING'
  | 'IMPLEMENTATION'
  | 'VALIDATION'
  | 'HARDENING'
  | 'RELEASE_CANDIDATE'
  | 'APPROVAL'
  | 'DEPLOYMENT'
  | 'OBSERVATION'
  | 'OPTIMIZATION';

export const PROJECT_STATES: readonly ProjectState[] = [
  'CONCEPT',
  'DISCOVERY',
  'ARCHITECTURE',
  'CONSENSUS',
  'PLANNING',
  'IMPLEMENTATION',
  'VALIDATION',
  'HARDENING',
  'RELEASE_CANDIDATE',
  'APPROVAL',
  'DEPLOYMENT',
  'OBSERVATION',
  'OPTIMIZATION',
];

/**
 * Legal forward transitions per project state. Mostly the spec's linear chain, plus the loop-backs
 * a real build lifecycle needs: a rejected CONSENSUS returns to ARCHITECTURE, a failed VALIDATION
 * returns to IMPLEMENTATION, HARDENING re-enters VALIDATION once fixes land, a rejected APPROVAL
 * returns to HARDENING, and OBSERVATION can re-enter HARDENING — the incident-response sequence
 * `ENGINEERING_COMPLETENESS.md` § 55 names directly ("stabilize… reduce blast radius… rollback…
 * diagnose… repair… validate") — before either resuming OBSERVATION or advancing to OPTIMIZATION.
 */
export const PROJECT_STATE_TRANSITIONS: Record<ProjectState, ProjectState[]> = {
  CONCEPT: ['DISCOVERY'],
  DISCOVERY: ['ARCHITECTURE'],
  ARCHITECTURE: ['CONSENSUS'],
  CONSENSUS: ['PLANNING', 'ARCHITECTURE'],
  PLANNING: ['IMPLEMENTATION'],
  IMPLEMENTATION: ['VALIDATION'],
  VALIDATION: ['HARDENING', 'IMPLEMENTATION'],
  HARDENING: ['RELEASE_CANDIDATE', 'VALIDATION'],
  RELEASE_CANDIDATE: ['APPROVAL'],
  APPROVAL: ['DEPLOYMENT', 'HARDENING'],
  DEPLOYMENT: ['OBSERVATION'],
  OBSERVATION: ['OPTIMIZATION', 'HARDENING'],
  OPTIMIZATION: ['IMPLEMENTATION', 'OBSERVATION'],
};

/** The 10 task-level states, in the order `ENGINEERING_COMPLETENESS.md` § 4 lists them. */
export type TaskState =
  | 'PLANNED'
  | 'READY'
  | 'RUNNING'
  | 'BLOCKED'
  | 'FAILED'
  | 'RETRYING'
  | 'VALIDATING'
  | 'PASSED'
  | 'ACCEPTED'
  | 'SUPERSEDED';

export const TASK_STATES: readonly TaskState[] = [
  'PLANNED',
  'READY',
  'RUNNING',
  'BLOCKED',
  'FAILED',
  'RETRYING',
  'VALIDATING',
  'PASSED',
  'ACCEPTED',
  'SUPERSEDED',
];

/** Legal forward transitions per task state. SUPERSEDED is terminal. */
export const TASK_STATE_TRANSITIONS: Record<TaskState, TaskState[]> = {
  PLANNED: ['READY', 'RUNNING'],
  READY: ['RUNNING', 'BLOCKED'],
  RUNNING: ['VALIDATING', 'FAILED', 'BLOCKED'],
  BLOCKED: ['READY', 'RUNNING'],
  FAILED: ['RETRYING', 'SUPERSEDED'],
  RETRYING: ['RUNNING', 'VALIDATING'],
  VALIDATING: ['PASSED', 'FAILED'],
  PASSED: ['ACCEPTED'],
  ACCEPTED: ['SUPERSEDED'],
  SUPERSEDED: [],
};

/** True when `to` is a legal transition from `from` in the given machine. `from === to` is never valid (no self-loops). */
export function isValidTransition(machine: 'project', from: ProjectState, to: ProjectState): boolean;
export function isValidTransition(machine: 'task', from: TaskState, to: TaskState): boolean;
export function isValidTransition(machine: 'project' | 'task', from: string, to: string): boolean {
  const table = machine === 'project' ? PROJECT_STATE_TRANSITIONS : TASK_STATE_TRANSITIONS;
  return (table as Record<string, string[]>)[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Task-level derivation
// ---------------------------------------------------------------------------

/**
 * Derive the formal {@link TaskState} of one `prompt_executions` row from its real, already-stored
 * columns. Pure and deterministic — same inputs always produce the same state. Never emits READY
 * or SUPERSEDED (see the module-level "Known gaps" note); pass `buildStatus` (the containing
 * build's `build_runs.status`) to additionally distinguish PASSED from ACCEPTED.
 */
export function deriveTaskState(
  execution: Pick<PromptExecution, 'status' | 'sentinel_passed' | 'resolution_applied'>,
  buildStatus?: BuildStatus
): TaskState {
  switch (execution.status) {
    case 'pending':
      return 'PLANNED';
    case 'running':
      return 'RUNNING';
    case 'skipped':
      // PromptExecutionStatus's own doc comment: "a dependency did not complete, or dry-run" — the
      // dependency-not-completed case is a real BLOCKED signal; a dry-run skip is imprecisely
      // folded into the same status value by the schema, so this mapping is a documented
      // approximation, not a fabricated distinction.
      return 'BLOCKED';
    case 'failed':
      // resolution_applied is only ever set alongside a 'failed' status when autonomous recovery
      // was attempted but the prompt still finalized as failed (finalizePromptExecution sets
      // status: 'completed' on a successful recovery) — the closest real signal to "this went
      // through a retry path" the schema exposes.
      return execution.resolution_applied !== null ? 'RETRYING' : 'FAILED';
    case 'completed':
      if (execution.sentinel_passed === false) return 'FAILED';
      if (execution.sentinel_passed !== true) return 'VALIDATING';
      return buildStatus === 'completed' ? 'ACCEPTED' : 'PASSED';
  }
}

/**
 * Build-wide derivation: like {@link deriveTaskState} for every row, but additionally marks
 * SUPERSEDED — any row that is not the most-recently-created `prompt_executions` row for its
 * `prompt_name` within `executions` (real signal: a later row for the same prompt name exists,
 * e.g. from an auto-resume re-running a prompt) is SUPERSEDED regardless of its own outcome.
 */
export function deriveTaskStates(
  executions: readonly Pick<PromptExecution, 'id' | 'prompt_name' | 'status' | 'sentinel_passed' | 'resolution_applied' | 'created_at'>[],
  buildStatus?: BuildStatus
): Map<string, TaskState> {
  const latestByName = new Map<string, string>();
  for (const exec of executions) {
    const currentLatestId = latestByName.get(exec.prompt_name);
    if (!currentLatestId) {
      latestByName.set(exec.prompt_name, exec.id);
      continue;
    }
    const current = executions.find((e) => e.id === currentLatestId);
    if (current && exec.created_at > current.created_at) {
      latestByName.set(exec.prompt_name, exec.id);
    }
  }

  const result = new Map<string, TaskState>();
  for (const exec of executions) {
    const isLatest = latestByName.get(exec.prompt_name) === exec.id;
    result.set(exec.id, isLatest ? deriveTaskState(exec, buildStatus) : 'SUPERSEDED');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Project-level derivation
// ---------------------------------------------------------------------------

export interface ProjectStateResult {
  projectPath: string;
  projectName: string;
  state: ProjectState;
  /** The real, checkable signal that justified reporting `state` (never a guess). */
  evidence: string;
  generatedAt: string;
}

/**
 * Infer the project's current {@link ProjectState} from real, on-disk/Build-Memory signals only.
 * Never throws — an unreadable project directory or unreachable Build Memory both degrade to the
 * earliest state whose evidence is still checkable rather than guessing forward.
 *
 * Evaluated most-conservative-first (CONCEPT before DISCOVERY before …), each gated on the
 * previous stage's evidence, mirroring `traceRequirement`'s "never infer a later stage from an
 * earlier one alone" posture.
 */
export async function deriveProjectState(
  projectPath: string,
  options: { buildId?: string; targetTier?: ReadinessTierId } = {}
): Promise<ProjectStateResult> {
  const projectName = basename(projectPath) || 'project';
  const generatedAt = nowIso();
  const make = (state: ProjectState, evidence: string): ProjectStateResult => ({
    projectPath,
    projectName,
    state,
    evidence,
    generatedAt,
  });

  const hasPrd = existsSync(join(projectPath, 'PRD.md'));
  const hasBlueprint = existsSync(join(projectPath, 'BLUEPRINT.md'));
  if (!hasPrd && !hasBlueprint) {
    return make('CONCEPT', 'No PRD.md or BLUEPRINT.md present yet.');
  }
  if (!hasBlueprint) {
    return make('DISCOVERY', 'PRD.md present, BLUEPRINT.md not yet written.');
  }

  const hasQueue = existsSync(join(projectPath, 'queue.yaml'));
  if (!hasQueue) {
    return make('ARCHITECTURE', 'BLUEPRINT.md present, queue.yaml not yet generated.');
  }

  const builds = await getBuildsByProject(projectName);
  const build: BuildRun | null = builds === null ? null : (options.buildId ? builds.find((b) => b.id === options.buildId) ?? null : builds[0] ?? null);

  if (!build || build.status === 'queued') {
    return make(
      'PLANNING',
      build ? `Build ${build.id} is queued but has not started.` : 'queue.yaml present, no build_runs row recorded yet.'
    );
  }
  if (build.status === 'running' || build.status === 'failed' || build.status === 'halted') {
    return make(
      'IMPLEMENTATION',
      `Build ${build.id} status '${build.status}' (${build.completed_prompts}/${build.total_prompts} prompt(s) completed).`
    );
  }

  // build.status === 'completed' from here on — every remaining state requires post-completion evidence.
  const gapRun = await getLatestGapAuditRunForProject(projectName);
  if (gapRun && gapRun.status === 'halted_for_human') {
    return make('APPROVAL', `Latest gap audit ${gapRun.id} is halted for human review.`);
  }

  const deploymentStatus = await getLatestDeploymentStatus(build.id);
  if (deploymentStatus === 'ready') {
    return make('OBSERVATION', `Build ${build.id} has a 'ready' deployment_history row.`);
  }
  if (deploymentStatus === 'queued' || deploymentStatus === 'building') {
    return make('DEPLOYMENT', `Build ${build.id} deployment in progress (deployment_history status '${deploymentStatus}').`);
  }

  if (gapRun && gapRun.gaps_critical > 0) {
    return make('HARDENING', `Latest gap audit ${gapRun.id} has ${gapRun.gaps_critical} CRITICAL gap(s) outstanding.`);
  }

  if (options.targetTier) {
    const dod = await evaluateDoD(projectPath, options.targetTier);
    if (dod.passed) {
      return make('RELEASE_CANDIDATE', `Definition of Done PASSED for target tier ${options.targetTier}.`);
    }
    return make(
      'VALIDATION',
      `Build ${build.id} completed; Definition of Done not yet met for target tier ${options.targetTier} ` +
        `(${dod.checks.filter((c) => !c.passed).length}/${dod.checks.length} check(s) failing).`
    );
  }
  return make('VALIDATION', `Build ${build.id} completed; no target readiness tier supplied to evaluate Definition of Done.`);
}

/** Render a `ProjectStateResult` as a human-readable line (used by `forge state`). */
export function formatProjectStateResult(result: ProjectStateResult): string {
  return `${result.projectName} — state: ${result.state}\n  evidence: ${result.evidence}\n  legal next state(s): ${PROJECT_STATE_TRANSITIONS[result.state].join(', ') || 'none (terminal)'}`;
}

/** The most recent `deployment_history.status` for `buildId`, or `null` when none is recorded / Build Memory is unreachable. */
async function getLatestDeploymentStatus(buildId: string): Promise<string | null> {
  return runQuery<string | null>('build-state-machine.getLatestDeploymentStatus', (db) => {
    const row = db
      .prepare(`SELECT status FROM deployment_history WHERE build_run_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(buildId) as { status: string } | undefined;
    return row?.status ?? null;
  });
}
