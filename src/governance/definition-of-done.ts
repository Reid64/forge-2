/**
 * FORGE 2.0 — Machine-verifiable Definition of Done.
 *
 * `upgrades/ENGINEERING_COMPLETENESS.md` § "60. A formal definition of 'done'": completion must
 * never be inferred from "no more queue files" — it must mean all approved requirements
 * implemented, all critical tests passed, zero critical security findings, and the target
 * readiness level satisfied. `evaluateDoD` is that check, made real against Build Memory rather
 * than left as a checklist a human has to remember to run.
 *
 * Four checks, each independently machine-verifiable against data FORGE already records (no new
 * table, no invented signal):
 *   1. every queue.yaml prompt reached a PASSED outcome for the project's latest build,
 *   2. the latest `gap_audit_runs` row for the project has zero CRITICAL findings,
 *   3. the latest `test_run_results` row for every readiness-tier-required suite is not FAILED,
 *   4. STATE_OF_THE_BUILD.md carries no open `BLOCKER` section.
 *
 * Every check degrades honestly, never optimistically: an unreachable Build Memory, a missing
 * queue.yaml, or a project that has never been audited/tested all resolve to `passed: false` with
 * a clear reason — the same "never fabricate a pass" posture as `src/design-pipeline/review-gate.ts`.
 */

import { existsSync } from 'node:fs';
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { getReadinessTier, type ReadinessTier, type ReadinessTierId } from './readiness-levels.js';
import { getBuildsByProject } from '../memory/builds.js';
import { getPromptsByBuild } from '../memory/prompts.js';
import { getLatestGapAuditRunForProject } from '../memory/gap-audits.js';
import { listLatestTestRunResults } from '../memory/test-results.js';
import { loadQueueEntriesFromFile } from '../tools/queue-versioning.js';
import { toAsciiGovernanceText } from '../tools/governance-text.js';
import { nowIso } from '../memory/client.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface DoDCheckResult {
  name: 'queue-prompts-passed' | 'gap-audit-zero-critical' | 'tier-test-suites-passed' | 'no-open-blocker';
  passed: boolean;
  detail: string;
}

export interface DoDResult {
  projectPath: string;
  projectName: string;
  targetTier: ReadinessTierId;
  passed: boolean;
  checks: DoDCheckResult[];
  generatedAt: string;
}

/**
 * Evaluate whether `projectPath`'s latest build satisfies the Definition of Done for
 * `targetTier`. Never throws — an internal failure surfaces as a failed check with an explanatory
 * detail string rather than propagating.
 */
export async function evaluateDoD(projectPath: string, targetTier: ReadinessTierId): Promise<DoDResult> {
  const projectName = basename(projectPath) || 'project';
  const generatedAt = nowIso();
  const tier = getReadinessTier(targetTier);

  if (!tier) {
    return {
      projectPath,
      projectName,
      targetTier,
      passed: false,
      checks: [
        {
          name: 'queue-prompts-passed',
          passed: false,
          detail: `Unknown readiness tier "${targetTier}" — see readiness-levels.ts READINESS_TIERS for valid ids.`,
        },
      ],
      generatedAt,
    };
  }

  const checks: DoDCheckResult[] = await Promise.all([
    checkQueuePromptsPassed(projectPath, projectName),
    checkGapAuditZeroCritical(projectName),
    checkTierTestSuitesPassed(projectName, tier),
    checkNoOpenBlocker(projectPath),
  ]);

  return {
    projectPath,
    projectName,
    targetTier,
    passed: checks.every((c) => c.passed),
    checks,
    generatedAt,
  };
}

/** Render a `DoDResult` as human-readable Markdown lines (used by `forge readiness` and the Phase 5 BLOCKER note). */
export function formatDoDResult(result: DoDResult): string {
  const lines: string[] = [];
  lines.push(`Definition of Done — target tier ${result.targetTier}: ${result.passed ? 'PASSED' : 'FAILED'}`);
  for (const check of result.checks) {
    lines.push(`  [${check.passed ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
  }
  return lines.join('\n');
}

/**
 * Append a BLOCKER section to `<projectPath>/<governanceDirName>/STATE_OF_THE_BUILD.md` recording
 * a failed DoD evaluation. No-op when `result.passed`. Mirrors the append convention already used
 * by `src/integration/bus.ts` (`appendSentinelPrimeBlocker`) and `src/deploy/pre-deploy-gate.ts`
 * (`appendBlockerSection`) — same target file, same non-fatal-on-write-failure posture.
 */
export async function appendDoDFailureBlocker(
  result: DoDResult,
  governanceDirName = 'governance'
): Promise<void> {
  if (result.passed) return;
  const lines = [
    '',
    `## BLOCKER — Definition of Done Not Met (target tier: ${result.targetTier})`,
    `- Timestamp: ${result.generatedAt}`,
    '- Failed checks:',
    ...result.checks.filter((c) => !c.passed).map((c) => `  - ${c.name}: ${c.detail}`),
    '',
  ].join('\n');

  try {
    const dir = join(result.projectPath, governanceDirName);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'STATE_OF_THE_BUILD.md'), toAsciiGovernanceText(lines + '\n'), 'utf8');
  } catch {
    /* non-fatal — the state document update must never block DoD reporting (Contract 4) */
  }
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * Check 1: every prompt in `<projectPath>/queue.yaml` reached a PASSED outcome in Build Memory
 * for the project's most recent build. `prompt_executions.status` has no literal 'passed' value
 * (`src/types/index.ts` › `PromptExecutionStatus` is pending/running/completed/failed/skipped) —
 * 'completed' is that enum's PASSED, and a completion whose Sentinel gate did not pass
 * (`sentinel_passed === false`) does not count as PASSED either.
 */
async function checkQueuePromptsPassed(projectPath: string, projectName: string): Promise<DoDCheckResult> {
  const name = 'queue-prompts-passed' as const;
  const queuePath = join(projectPath, 'queue.yaml');
  if (!existsSync(queuePath)) {
    return { name, passed: false, detail: `No queue.yaml found at ${queuePath}.` };
  }

  let entries: Awaited<ReturnType<typeof loadQueueEntriesFromFile>>;
  try {
    entries = await loadQueueEntriesFromFile(queuePath);
  } catch (error) {
    return { name, passed: false, detail: `Could not parse queue.yaml (${describe(error)}).` };
  }
  if (entries.length === 0) {
    return { name, passed: false, detail: 'queue.yaml has no prompt entries.' };
  }

  const builds = await getBuildsByProject(projectName);
  if (builds === null) {
    return { name, passed: false, detail: 'Build Memory unreachable — cannot verify prompt outcomes.' };
  }
  const latestBuild = builds[0] ?? null;
  if (!latestBuild) {
    return { name, passed: false, detail: `No build_runs row found for project "${projectName}" — the queue has never been run.` };
  }

  const executions = await getPromptsByBuild(latestBuild.id);
  if (executions === null) {
    return { name, passed: false, detail: 'Build Memory unreachable — cannot verify prompt outcomes.' };
  }

  const byName = new Map(executions.map((e) => [e.prompt_name, e]));
  const notPassed = entries.filter((entry) => {
    const exec = byName.get(entry.name);
    return !exec || exec.status !== 'completed' || exec.sentinel_passed === false;
  });

  if (notPassed.length > 0) {
    const sample = notPassed.slice(0, 10).map((e) => e.name).join(', ');
    return {
      name,
      passed: false,
      detail:
        `${notPassed.length}/${entries.length} queue prompt(s) not PASSED (build ${latestBuild.id}): ` +
        `${sample}${notPassed.length > 10 ? ', …' : ''}.`,
    };
  }
  return { name, passed: true, detail: `All ${entries.length} queue prompt(s) PASSED (build ${latestBuild.id}).` };
}

/** Check 2: the latest `gap_audit_runs` row for the project has zero CRITICAL findings. */
async function checkGapAuditZeroCritical(projectName: string): Promise<DoDCheckResult> {
  const name = 'gap-audit-zero-critical' as const;
  const run = await getLatestGapAuditRunForProject(projectName);
  if (run === null) {
    return {
      name,
      passed: false,
      detail: 'Build Memory unreachable, or no gap_audit_runs row exists for this project yet — run `forge audit` first.',
    };
  }
  if (run.gaps_critical > 0) {
    return {
      name,
      passed: false,
      detail: `Latest gap audit ${run.id} (${run.created_at}) found ${run.gaps_critical} CRITICAL gap(s).`,
    };
  }
  return { name, passed: true, detail: `Latest gap audit ${run.id} (${run.created_at}) found zero CRITICAL gaps.` };
}

/** Check 3: the latest `test_run_results` row for every tier-required suite is not FAILED. */
async function checkTierTestSuitesPassed(projectName: string, tier: ReadinessTier): Promise<DoDCheckResult> {
  const name = 'tier-test-suites-passed' as const;
  if (tier.requiredTestSuites.length === 0) {
    return { name, passed: true, detail: `Tier ${tier.id} requires no test suites.` };
  }

  const rows = await listLatestTestRunResults(projectName);
  if (rows === null) {
    return { name, passed: false, detail: 'Build Memory unreachable — cannot verify test_run_results.' };
  }

  const bySuite = new Map(rows.map((r) => [r.test_suite, r]));
  const problems: string[] = [];
  for (const suite of tier.requiredTestSuites) {
    const row = bySuite.get(suite);
    if (!row) {
      problems.push(`${suite}: no run recorded`);
    } else if (row.status === 'failed') {
      problems.push(`${suite}: FAILED (${row.tests_failed}/${row.tests_total} test(s) failed)`);
    }
  }

  if (problems.length > 0) {
    return {
      name,
      passed: false,
      detail: `${problems.length}/${tier.requiredTestSuites.length} tier-required suite(s) not passing: ${problems.join('; ')}.`,
    };
  }
  return {
    name,
    passed: true,
    detail: `All ${tier.requiredTestSuites.length} tier-required suite(s) have a non-FAILED latest run.`,
  };
}

/**
 * Check 4: STATE_OF_THE_BUILD.md has no open BLOCKER section. Checked at both observed write
 * locations — `<projectPath>/STATE_OF_THE_BUILD.md` (what every generated project actually ships,
 * e.g. `projects/tarritrix/STATE_OF_THE_BUILD.md`) and `<projectPath>/governance/STATE_OF_THE_BUILD.md`
 * (the path `src/integration/bus.ts` and `src/deploy/pre-deploy-gate.ts` actually append BLOCKERs
 * to) — so neither existing write path is silently missed. There is no "resolve"/"close" convention
 * for a BLOCKER anywhere in the codebase, so any heading line containing "BLOCKER" counts as open.
 */
async function checkNoOpenBlocker(projectPath: string): Promise<DoDCheckResult> {
  const name = 'no-open-blocker' as const;
  const candidates = [join(projectPath, 'STATE_OF_THE_BUILD.md'), join(projectPath, 'governance', 'STATE_OF_THE_BUILD.md')];

  let anyFileRead = false;
  const openBlockers: string[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    anyFileRead = true;
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      return { name, passed: false, detail: `Could not read ${path} (${describe(error)}).` };
    }
    const blockerHeadings = text.split('\n').filter((line) => /^#{1,6}.*BLOCKER/.test(line));
    if (blockerHeadings.length > 0) {
      openBlockers.push(`${path} (${blockerHeadings.length})`);
    }
  }

  if (!anyFileRead) {
    return { name, passed: false, detail: 'No STATE_OF_THE_BUILD.md found at project root or governance/.' };
  }
  if (openBlockers.length > 0) {
    return { name, passed: false, detail: `Open BLOCKER section(s) found in: ${openBlockers.join(', ')}.` };
  }
  return { name, passed: true, detail: 'No open BLOCKER section in STATE_OF_THE_BUILD.md.' };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
