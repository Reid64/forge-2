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
 * BLUEPRINT.md); `traceRequirement` follows one id both DOWNSTREAM and UPSTREAM through the
 * pipeline. Downstream (unchanged since the original engine): does any `queue.yaml` entry mention
 * it (PLANNED), does any git commit message mention it (IMPLEMENTED), does any recorded test run
 * reference it (TESTED), and did the project's latest build both complete and reach a `'ready'`
 * `deployment_history` row (DEPLOYED) — each stage requires real, independently-checkable
 * evidence, never inferred from a later stage alone. Upstream (added alongside `ontology.ts`):
 * does any `adr_records` row (a decision) or `risks` row (a risk) mention the id — the same
 * best-effort text-mention posture `findInTestResults` already uses, surfaced as `adrEvidence`/
 * `riskEvidence` on the result rather than folded into `stage`, since "what led to this
 * requirement" has no natural position in a forward PLANNED→DEPLOYED progression.
 *
 * `traceReverse` inverts the same downstream evidence lookups: given a downstream identifier (a
 * queue entry id/name, a commit hash, a test suite/runner name), it finds every `REQ-NNN` id whose
 * forward trace evidence contains that identifier. `findUntestedRequirements` reports every
 * requirement/feature with zero recorded test evidence — both are exposed via `forge trace
 * --reverse` / `forge trace --untested`.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';

import { loadQueueEntriesFromFile } from '../tools/queue-versioning.js';
import { getBuildsByProject } from '../memory/builds.js';
import { listLatestTestRunResults } from '../memory/test-results.js';
import { listAdrsByProject } from '../memory/adr.js';
import { listRisksByProject } from '../memory/risks.js';
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

/** One `adr_records` row (a decision) whose title/context/decision text mentions the requirement id. */
export interface AdrEvidence {
  adrId: string;
  adrNumber: number;
  title: string;
}

/** One `risks` row whose title/description mentions the requirement id. */
export interface RiskEvidence {
  riskId: string;
  title: string;
}

export interface TraceResult {
  reqId: string;
  projectPath: string;
  projectName: string;
  stage: TraceStage;
  queueEvidence: QueueEvidence[];
  commitEvidence: CommitEvidence[];
  testEvidence: TestEvidence[];
  /** UPSTREAM evidence: `adr_records` rows that appear to have motivated this requirement. */
  adrEvidence: AdrEvidence[];
  /** UPSTREAM evidence: `risks` rows that appear to have motivated this requirement. */
  riskEvidence: RiskEvidence[];
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
      adrEvidence: [],
      riskEvidence: [],
      deployed: false,
      generatedAt,
    };
  }

  const [queueEvidence, testEvidence, adrEvidence, riskEvidence] = await Promise.all([
    findInQueue(normalized, projectPath),
    findInTestResults(normalized, projectName),
    findInAdrRecords(normalized, projectName),
    findInRisks(normalized, projectName),
  ]);
  const commitEvidence = findInGitLog(normalized, projectPath);
  const deployed = commitEvidence.length > 0 && testEvidence.length > 0 ? await isLatestBuildDeployed(projectName) : false;

  let stage: TraceStage = 'unreferenced';
  if (queueEvidence.length > 0) stage = 'planned';
  if (commitEvidence.length > 0) stage = 'implemented';
  if (stage === 'implemented' && testEvidence.length > 0) stage = 'tested';
  if (stage === 'tested' && deployed) stage = 'deployed';

  return {
    reqId: normalized,
    projectPath,
    projectName,
    stage,
    queueEvidence,
    commitEvidence,
    testEvidence,
    adrEvidence,
    riskEvidence,
    deployed,
    generatedAt,
  };
}

/** Render a `TraceResult` as human-readable Markdown-ish lines (used by `forge trace`). */
export function formatTraceResult(result: TraceResult): string {
  const lines: string[] = [];
  lines.push(`${result.reqId} — stage: ${result.stage.toUpperCase()}`);
  lines.push(`  queue.yaml references: ${result.queueEvidence.length === 0 ? 'none' : result.queueEvidence.map((e) => e.entryName).join(', ')}`);
  lines.push(`  commit references: ${result.commitEvidence.length === 0 ? 'none' : result.commitEvidence.map((c) => `${c.hash.slice(0, 8)} ${c.subject}`).join('; ')}`);
  lines.push(`  test evidence: ${result.testEvidence.length === 0 ? 'none' : result.testEvidence.map((t) => `${t.testSuite}:${t.status}`).join(', ')}`);
  lines.push(`  deployed: ${result.deployed ? 'yes' : 'no'}`);
  lines.push(
    `  upstream decisions (ADR): ${result.adrEvidence.length === 0 ? 'none' : result.adrEvidence.map((a) => `ADR-${String(a.adrNumber).padStart(3, '0')} ${a.title}`).join('; ')}`
  );
  lines.push(`  upstream risks: ${result.riskEvidence.length === 0 ? 'none' : result.riskEvidence.map((r) => r.title).join(', ')}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Evidence lookups
// ---------------------------------------------------------------------------

/** True when `text` contains `reqId` as a whole word, case-insensitive. */
function mentions(text: string, reqId: string): boolean {
  return new RegExp(`\\b${reqId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
}

/** Load `queue.yaml` entries for `projectPath`, or `[]` when missing/unreadable. Shared by every
 *  evidence lookup below that needs the compiled queue (queue evidence, reverse trace, untested). */
async function loadQueueEntriesSafe(projectPath: string) {
  const queuePath = join(projectPath, 'queue.yaml');
  if (!existsSync(queuePath)) return [];
  try {
    return await loadQueueEntriesFromFile(queuePath);
  } catch {
    return [];
  }
}

async function findInQueue(reqId: string, projectPath: string): Promise<QueueEvidence[]> {
  const entries = await loadQueueEntriesSafe(projectPath);
  return entries
    .filter((entry) => mentions(entry.name, reqId) || mentions(entry.description, reqId))
    .map((entry) => ({ entryId: entry.id, entryName: entry.name }));
}

/** Search each `adr_records` row's title/context/decision text for `reqId` (upstream evidence). */
async function findInAdrRecords(reqId: string, projectName: string): Promise<AdrEvidence[]> {
  const rows = await listAdrsByProject(projectName);
  if (!rows) return [];
  return rows
    .filter((r) => mentions(r.title, reqId) || mentions(r.context, reqId) || mentions(r.decision, reqId))
    .map((r) => ({ adrId: r.id, adrNumber: r.adr_number, title: r.title }));
}

/** Search each `risks` row's title/description text for `reqId` (upstream evidence). */
async function findInRisks(reqId: string, projectName: string): Promise<RiskEvidence[]> {
  const rows = await listRisksByProject(projectName);
  if (!rows) return [];
  return rows
    .filter((r) => mentions(r.title, reqId) || mentions(r.description, reqId))
    .map((r) => ({ riskId: r.id, title: r.title }));
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

// ---------------------------------------------------------------------------
// Reverse trace — `forge trace --reverse`
// ---------------------------------------------------------------------------

/**
 * Result of {@link traceReverse}: every `REQ-NNN` requirement id whose forward evidence
 * (queue/commit/test — the same evidence {@link traceRequirement} gathers) contains `identifier`.
 */
export interface ReverseTraceResult {
  identifier: string;
  projectPath: string;
  projectName: string;
  matchedRequirementIds: string[];
  /** The full forward {@link TraceResult} for each matched id, for detail printing. */
  matches: TraceResult[];
  generatedAt: string;
}

/**
 * Every `REQ-NNN` id declared in `projectPath`'s governance docs OR mentioned anywhere in
 * `queue.yaml` — the candidate set {@link traceReverse} inverts over. Broader than
 * {@link extractRequirementIdsFromGovernance} alone: an id a queue entry references but PRD.md/
 * BLUEPRINT.md do not is still a real, checkable id.
 */
async function candidateRequirementIds(projectPath: string): Promise<string[]> {
  const gov = await extractRequirementIdsFromGovernance(projectPath);
  const entries = await loadQueueEntriesSafe(projectPath);
  const seen = new Set<string>(gov.all);
  const ordered = [...gov.all];
  for (const entry of entries) {
    for (const id of parseRequirementIds(`${entry.name} ${entry.description}`)) {
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
  }
  return ordered;
}

/** True when any of `result`'s downstream evidence (queue/commit/test) contains `needle`. */
function evidenceMatchesIdentifier(result: TraceResult, needle: string): boolean {
  const lower = needle.trim().toLowerCase();
  if (lower.length === 0) return false;
  const inQueue = result.queueEvidence.some(
    (e) => e.entryId.toLowerCase() === lower || e.entryId.toLowerCase().includes(lower) || e.entryName.toLowerCase().includes(lower)
  );
  const inCommit = result.commitEvidence.some(
    (c) => c.hash.toLowerCase() === lower || c.hash.toLowerCase().startsWith(lower) || c.subject.toLowerCase().includes(lower)
  );
  const inTest = result.testEvidence.some((t) => t.testSuite.toLowerCase() === lower || t.testSuite.toLowerCase().includes(lower));
  return inQueue || inCommit || inTest;
}

/**
 * Reverse-trace a downstream identifier (a `queue.yaml` entry id/name, a git commit hash/subject
 * fragment, or a `test_run_results` suite name) back to the `REQ-NNN` requirement id(s) whose
 * forward evidence ({@link traceRequirement}) contains it. Never throws — every degrade path
 * {@link traceRequirement} already has (unreadable queue.yaml, non-git directory, unreachable
 * Build Memory) applies here too, since this function is built entirely out of that same lookup.
 */
export async function traceReverse(identifier: string, projectPath: string): Promise<ReverseTraceResult> {
  const projectName = basename(projectPath) || 'project';
  const generatedAt = nowIso();
  const needle = identifier.trim();

  if (needle.length === 0) {
    return { identifier, projectPath, projectName, matchedRequirementIds: [], matches: [], generatedAt };
  }

  const candidates = await candidateRequirementIds(projectPath);
  const matches: TraceResult[] = [];
  for (const reqId of candidates) {
    const result = await traceRequirement(reqId, projectPath);
    if (evidenceMatchesIdentifier(result, needle)) matches.push(result);
  }

  return {
    identifier,
    projectPath,
    projectName,
    matchedRequirementIds: matches.map((m) => m.reqId),
    matches,
    generatedAt,
  };
}

/** Render a {@link ReverseTraceResult} as human-readable lines (used by `forge trace --reverse`). */
export function formatReverseTraceResult(result: ReverseTraceResult): string {
  const lines: string[] = [`Reverse trace for "${result.identifier}" in ${result.projectName}`];
  if (result.matches.length === 0) {
    lines.push('  no requirement id traces back to this identifier');
  } else {
    for (const m of result.matches) {
      lines.push(`  ${m.reqId} — stage: ${m.stage.toUpperCase()}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Untested requirements/features — `forge trace --untested`
// ---------------------------------------------------------------------------

/** Result of {@link findUntestedRequirements}. */
export interface UntestedResult {
  projectPath: string;
  projectName: string;
  /** `REQ-NNN` ids declared in governance docs with zero recorded test evidence. */
  untestedRequirements: string[];
  /** `queue.yaml` `prompt_type: 'feature'` entries with zero recorded test evidence. */
  untestedFeatures: Array<{ entryId: string; entryName: string }>;
  generatedAt: string;
}

/**
 * List every declared requirement and every `feature`-type queue entry that has NO recorded
 * `test_run_results` evidence (the same best-effort text-mention lookup {@link traceRequirement}
 * uses for its TESTED stage, applied to feature entry ids/names too). Never throws — degrades to
 * empty lists on an unreadable queue.yaml or unreachable Build Memory, same as every other lookup
 * in this module.
 */
export async function findUntestedRequirements(projectPath: string): Promise<UntestedResult> {
  const projectName = basename(projectPath) || 'project';
  const generatedAt = nowIso();

  const gov = await extractRequirementIdsFromGovernance(projectPath);
  const untestedRequirements: string[] = [];
  for (const reqId of gov.all) {
    const testEvidence = await findInTestResults(reqId, projectName);
    if (testEvidence.length === 0) untestedRequirements.push(reqId);
  }

  const entries = await loadQueueEntriesSafe(projectPath);
  const testRows = (await listLatestTestRunResults(projectName)) ?? [];
  const untestedFeatures: Array<{ entryId: string; entryName: string }> = [];
  for (const entry of entries.filter((e) => e.prompt_type === 'feature')) {
    const hasEvidence = testRows.some(
      (row) =>
        (row.report_path && (mentions(row.report_path, entry.id) || mentions(row.report_path, entry.name))) ||
        (row.runner && (mentions(row.runner, entry.id) || mentions(row.runner, entry.name))) ||
        (row.failure_summary && mentions(JSON.stringify(row.failure_summary), entry.id))
    );
    if (!hasEvidence) untestedFeatures.push({ entryId: entry.id, entryName: entry.name });
  }

  return { projectPath, projectName, untestedRequirements, untestedFeatures, generatedAt };
}

/** Render an {@link UntestedResult} as human-readable lines (used by `forge trace --untested`). */
export function formatUntestedResult(result: UntestedResult): string {
  const lines: string[] = [];
  lines.push(
    `Untested requirements (${result.untestedRequirements.length}): ${
      result.untestedRequirements.length === 0 ? 'none' : result.untestedRequirements.join(', ')
    }`
  );
  lines.push(
    `Untested features (${result.untestedFeatures.length}): ${
      result.untestedFeatures.length === 0 ? 'none' : result.untestedFeatures.map((f) => `${f.entryId} (${f.entryName})`).join(', ')
    }`
  );
  return lines.join('\n');
}
