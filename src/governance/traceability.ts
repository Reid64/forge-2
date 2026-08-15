/**
 * FORGE 2.0 — Requirements Traceability Engine.
 *
 * `upgrades/ENGINEERING_COMPLETENESS.md` § "2. A requirements traceability engine" asks FORGE to
 * answer "where in the code is requirement REQ-042 implemented?" with real bidirectional evidence
 * (idea → requirement → queue item → code → test → deployment), not a fabricated status. This
 * module is that lookup, built entirely on data FORGE already produces — a lightweight `REQ-NNN`
 * id scheme, `queue.yaml` prompt text, git commit history, and `test_run_results` — no new table,
 * no invented signal, matching `src/governance/definition-of-done.ts`'s posture of degrading
 * honestly (`stage: 'unreferenced'`) rather than ever fabricating progress.
 *
 * `parseRequirementIds` extracts every `REQ-NNN` occurrence from arbitrary governance text (PRD.md,
 * BLUEPRINT.md); `traceRequirement` follows one id forward through the pipeline: does any
 * `queue.yaml` entry mention it (PLANNED), does any git commit message mention it (IMPLEMENTED),
 * does any recorded test run reference it (TESTED), and did the project's latest build both
 * complete and reach a `'ready'` `deployment_history` row (DEPLOYED). Each stage requires real,
 * independently-checkable evidence — the engine never infers a later stage from an earlier one
 * alone.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';

import { loadQueueEntriesFromFile } from '../tools/queue-versioning.js';
import { getBuildsByProject } from '../memory/builds.js';
import { listLatestTestRunResults } from '../memory/test-results.js';
import { nowIso, runQuery } from '../memory/client.js';

// ---------------------------------------------------------------------------
// Requirement id parsing
// ---------------------------------------------------------------------------

/** Matches `REQ-042`-shaped ids (`REQ-` + 3 or more digits), case-insensitive. */
const REQ_ID_PATTERN = /\bREQ-\d{3,}\b/gi;

/** A requirement id must be exactly `REQ-` + 3 or more digits (uppercased). */
const VALID_REQ_ID = /^REQ-\d{3,}$/;

/**
 * Extract every distinct `REQ-NNN` id referenced in `text`, in first-seen order, uppercased.
 * Never throws — an empty or id-free string returns `[]`.
 */
export function parseRequirementIds(text: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const match of text.matchAll(REQ_ID_PATTERN)) {
    const id = match[0].toUpperCase();
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

/** The requirement ids declared across a project's core governance documents. */
export interface GovernanceRequirementIds {
  /** Ids found in `PRD.md`. */
  prd: string[];
  /** Ids found in `BLUEPRINT.md`. */
  blueprint: string[];
  /** The union of `prd` and `blueprint`, deduplicated, first-seen order. */
  all: string[];
}

/**
 * Read `PRD.md` and `BLUEPRINT.md` from `projectPath` (when present) and extract every `REQ-NNN`
 * id declared in each. A missing or unreadable file contributes zero ids rather than throwing —
 * matching Build Memory's degrade-don't-crash posture elsewhere in `src/governance/`.
 */
export async function extractRequirementIdsFromGovernance(
  projectPath: string
): Promise<GovernanceRequirementIds> {
  const prd = await extractFromFile(join(projectPath, 'PRD.md'));
  const blueprint = await extractFromFile(join(projectPath, 'BLUEPRINT.md'));
  const seen = new Set<string>();
  const all: string[] = [];
  for (const id of [...prd, ...blueprint]) {
    if (!seen.has(id)) {
      seen.add(id);
      all.push(id);
    }
  }
  return { prd, blueprint, all };
}

async function extractFromFile(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  try {
    return parseRequirementIds(await readFile(path, 'utf8'));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Trace result
// ---------------------------------------------------------------------------

/**
 * How far a requirement has been observed to progress. Each later stage strictly requires the
 * evidence of the stage before it — a requirement is never reported `tested` without real
 * `implemented`-stage evidence (a commit), and never `deployed` without real `tested`-stage
 * evidence, even if a later signal (e.g. a completed build) happens to be present on its own.
 */
export type TraceStage = 'unreferenced' | 'planned' | 'implemented' | 'tested' | 'deployed';

/** One `queue.yaml` entry whose name or task text mentions the requirement id. */
export interface QueueEvidence {
  entryId: string;
  entryName: string;
}

/** One git commit whose message mentions the requirement id. */
export interface CommitEvidence {
  hash: string;
  subject: string;
}

/** One `test_run_results` row whose recorded evidence mentions the requirement id. */
export interface TestEvidence {
  testSuite: string;
  status: string;
  /** Which column the id was actually found in. */
  matchedIn: 'report_path' | 'runner' | 'failure_summary';
}

export interface TraceResult {
  reqId: string;
  projectPath: string;
  projectName: string;
  stage: TraceStage;
  queueEvidence: QueueEvidence[];
  commitEvidence: CommitEvidence[];
  testEvidence: TestEvidence[];
  /** True when the project's latest build completed AND has a `'ready'` `deployment_history` row. */
  deployed: boolean;
  generatedAt: string;
}

/**
 * Trace `reqId` through `projectPath`'s pipeline: `queue.yaml` (PLANNED), git commit history
 * (IMPLEMENTED), `test_run_results` (TESTED), and the project's latest build/deployment record
 * (DEPLOYED). Never throws — an invalid id, an unreadable queue.yaml, a non-git directory, or an
 * unreachable Build Memory each degrade the relevant evidence list to `[]` rather than aborting
 * the whole trace.
 */
export async function traceRequirement(reqId: string, projectPath: string): Promise<TraceResult> {
  const normalized = reqId.trim().toUpperCase();
  const projectName = basename(projectPath) || 'project';
  const generatedAt = nowIso();

  if (!VALID_REQ_ID.test(normalized)) {
    return {
      reqId: normalized,
      projectPath,
      projectName,
      stage: 'unreferenced',
      queueEvidence: [],
      commitEvidence: [],
      testEvidence: [],
      deployed: false,
      generatedAt,
    };
  }

  const [queueEvidence, testEvidence] = await Promise.all([
    findInQueue(normalized, projectPath),
    findInTestResults(normalized, projectName),
  ]);
  const commitEvidence = findInGitLog(normalized, projectPath);
  const deployed = commitEvidence.length > 0 && testEvidence.length > 0 ? await isLatestBuildDeployed(projectName) : false;

  let stage: TraceStage = 'unreferenced';
  if (queueEvidence.length > 0) stage = 'planned';
  if (commitEvidence.length > 0) stage = 'implemented';
  if (stage === 'implemented' && testEvidence.length > 0) stage = 'tested';
  if (stage === 'tested' && deployed) stage = 'deployed';

  return { reqId: normalized, projectPath, projectName, stage, queueEvidence, commitEvidence, testEvidence, deployed, generatedAt };
}

/** Render a `TraceResult` as human-readable Markdown-ish lines (used by `forge trace`). */
export function formatTraceResult(result: TraceResult): string {
  const lines: string[] = [];
  lines.push(`${result.reqId} — stage: ${result.stage.toUpperCase()}`);
  lines.push(`  queue.yaml references: ${result.queueEvidence.length === 0 ? 'none' : result.queueEvidence.map((e) => e.entryName).join(', ')}`);
  lines.push(`  commit references: ${result.commitEvidence.length === 0 ? 'none' : result.commitEvidence.map((c) => `${c.hash.slice(0, 8)} ${c.subject}`).join('; ')}`);
  lines.push(`  test evidence: ${result.testEvidence.length === 0 ? 'none' : result.testEvidence.map((t) => `${t.testSuite}:${t.status}`).join(', ')}`);
  lines.push(`  deployed: ${result.deployed ? 'yes' : 'no'}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Evidence lookups
// ---------------------------------------------------------------------------

/** True when `text` contains `reqId` as a whole word, case-insensitive. */
function mentions(text: string, reqId: string): boolean {
  return new RegExp(`\\b${reqId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
}

async function findInQueue(reqId: string, projectPath: string): Promise<QueueEvidence[]> {
  const queuePath = join(projectPath, 'queue.yaml');
  if (!existsSync(queuePath)) return [];
  try {
    const entries = await loadQueueEntriesFromFile(queuePath);
    return entries
      .filter((entry) => mentions(entry.name, reqId) || mentions(entry.description, reqId))
      .map((entry) => ({ entryId: entry.id, entryName: entry.name }));
  } catch {
    return [];
  }
}

/**
 * Search git commit messages (`--all`, subject line only, `-i` case-insensitive) for `reqId`.
 * `reqId` is validated against {@link VALID_REQ_ID} by every caller before reaching here, and
 * `execFileSync` is invoked with an argument vector (no shell), so this never carries shell-meta
 * surface even without that validation.
 */
function findInGitLog(reqId: string, projectPath: string): CommitEvidence[] {
  if (!existsSync(join(projectPath, '.git'))) return [];
  try {
    const stdout = execFileSync('git', ['log', '--all', '--format=%H %s', `--grep=${reqId}`, '-i'], {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const spaceIdx = line.indexOf(' ');
        return spaceIdx === -1 ? { hash: line, subject: '' } : { hash: line.slice(0, spaceIdx), subject: line.slice(spaceIdx + 1) };
      });
  } catch {
    return [];
  }
}

/**
 * Search each recorded suite's latest `test_run_results` row (`report_path`, `runner`,
 * `failure_summary`) for `reqId`. This is necessarily best-effort — `test_run_results` has no
 * dedicated requirement-id column — but it is real evidence (an actual persisted row, not a
 * fabricated match) when a runner's own report path or failure detail happens to carry the id.
 */
async function findInTestResults(reqId: string, projectName: string): Promise<TestEvidence[]> {
  const rows = await listLatestTestRunResults(projectName);
  if (!rows) return [];
  const evidence: TestEvidence[] = [];
  for (const row of rows) {
    if (row.report_path && mentions(row.report_path, reqId)) {
      evidence.push({ testSuite: row.test_suite, status: row.status, matchedIn: 'report_path' });
      continue;
    }
    if (row.runner && mentions(row.runner, reqId)) {
      evidence.push({ testSuite: row.test_suite, status: row.status, matchedIn: 'runner' });
      continue;
    }
    if (row.failure_summary && mentions(JSON.stringify(row.failure_summary), reqId)) {
      evidence.push({ testSuite: row.test_suite, status: row.status, matchedIn: 'failure_summary' });
    }
  }
  return evidence;
}

/** True when the project's latest build completed AND has a `'ready'` `deployment_history` row. */
async function isLatestBuildDeployed(projectName: string): Promise<boolean> {
  const builds = await getBuildsByProject(projectName);
  const latest = builds?.[0];
  if (!latest || latest.status !== 'completed') return false;

  const readyCount = await runQuery<number>('traceability.isLatestBuildDeployed', (db) => {
    const row = db
      .prepare(`SELECT COUNT(*) as c FROM deployment_history WHERE build_run_id = ? AND status = 'ready'`)
      .get(latest.id) as { c: number };
    return row.c;
  });
  return (readyCount ?? 0) > 0;
}
