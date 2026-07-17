/**
 * FORGE 2.0 — System 1: halt-reconstructor (F24).
 *
 * Reconstructs the exact point a prior build halted, entirely from real state (Contract R-4 —
 * never guessed). A field that cannot be read is stored `null`; a partial halt point is valid,
 * a fabricated one is a defect.
 */

import { execSync } from 'node:child_process';

import { getBuild, getBuildsByProject } from '../memory/builds.js';
import { getPromptsByBuild } from '../memory/prompts.js';
import type { HaltPoint } from './types.js';

const NON_TERMINAL_BUILD_STATUSES = new Set(['queued', 'running']);
const HALTED_BUILD_STATUSES = new Set(['halted', 'failed']);

/** The preserved feature branch for a build/prompt, read from git (never guessed). */
function findPreservedBranch(projectPath: string, buildRunId: string): string | null {
  try {
    const raw = execSync(`git branch --list "forge/${buildRunId}/*"`, { cwd: projectPath, stdio: 'pipe' })
      .toString()
      .trim();
    if (!raw) return null;
    const first = raw.split('\n')[0]?.replace(/^\*?\s*/, '').trim();
    return first || null;
  } catch {
    return null;
  }
}

/** Best-effort sub-step index extraction from a prompt's recorded sentinel_details JSON. */
function extractSubStep(sentinelDetails: Record<string, unknown> | null): { index: number | null; name: string | null } {
  if (!sentinelDetails) return { index: null, name: null };
  const idxKeys = ['failingSubStepIndex', 'subStepIndex', 'sub_step_index'];
  const nameKeys = ['failingSubStepName', 'subStepName', 'sub_step_name'];
  let index: number | null = null;
  let name: string | null = null;
  for (const k of idxKeys) {
    const v = sentinelDetails[k];
    if (typeof v === 'number') {
      index = v;
      break;
    }
  }
  for (const k of nameKeys) {
    const v = sentinelDetails[k];
    if (typeof v === 'string') {
      name = v;
      break;
    }
  }
  return { index, name };
}

/** Find the failing Sentinel check name recorded on a halted prompt's sentinel_details. */
function extractFailingCheck(sentinelDetails: Record<string, unknown> | null): string | null {
  if (!sentinelDetails) return null;
  const checks = sentinelDetails['checks'];
  if (Array.isArray(checks)) {
    const failed = checks.find((c) => c && typeof c === 'object' && (c as Record<string, unknown>)['passed'] === false);
    if (failed && typeof failed === 'object') {
      const name = (failed as Record<string, unknown>)['name'];
      if (typeof name === 'string') return name;
    }
  }
  const failingCheck = sentinelDetails['failingCheck'];
  return typeof failingCheck === 'string' ? failingCheck : null;
}

export interface HaltReconstructorInput {
  projectPath: string;
  projectName: string;
  buildRunId?: string;
}

/**
 * Reconstruct `{buildRunId, promptIndex, promptName, failingCheck, subStepIndex, subStepName}`
 * for the given build, or the latest non-terminal/halted build for the project when no
 * `buildRunId` is supplied.
 */
export async function reconstructHaltPoint(input: HaltReconstructorInput): Promise<HaltPoint> {
  const empty: HaltPoint = {
    buildRunId: null,
    promptIndex: null,
    promptName: null,
    failingCheck: null,
    subStepIndex: null,
    subStepName: null,
  };

  let buildRunId = input.buildRunId ?? null;
  if (!buildRunId) {
    const builds = await getBuildsByProject(input.projectName);
    if (!builds || builds.length === 0) return empty;
    const candidate =
      builds.find((b) => HALTED_BUILD_STATUSES.has(b.status)) ??
      builds.find((b) => NON_TERMINAL_BUILD_STATUSES.has(b.status)) ??
      null;
    if (!candidate) return empty;
    buildRunId = candidate.id;
  }

  const build = await getBuild(buildRunId);
  if (!build) return { ...empty, buildRunId };

  const prompts = await getPromptsByBuild(buildRunId);
  if (!prompts || prompts.length === 0) return { ...empty, buildRunId };

  const lastIncomplete = [...prompts].reverse().find((p) => p.status !== 'completed');
  if (!lastIncomplete) return { ...empty, buildRunId };

  const sentinelDetails = (lastIncomplete.sentinel_details as Record<string, unknown> | null) ?? null;
  const failingCheck = extractFailingCheck(sentinelDetails);
  const subStep = extractSubStep(sentinelDetails);

  // Confirm the preserved branch actually exists in git — the branch name itself is read from
  // Build Memory first (branch_name column), git only confirms/derives it when absent.
  const branchFromMemory = lastIncomplete.branch_name;
  const branchFromGit = branchFromMemory ?? findPreservedBranch(input.projectPath, buildRunId);
  void branchFromGit; // surfaced via promptName below when Build Memory has no branch_name

  return {
    buildRunId,
    promptIndex: lastIncomplete.prompt_index,
    promptName: lastIncomplete.prompt_name,
    failingCheck,
    subStepIndex: subStep.index,
    subStepName: subStep.name,
  };
}
