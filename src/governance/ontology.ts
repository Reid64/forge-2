/**
 * FORGE 2.0 — Governance Ontology.
 *
 * NOT WIRED (Finding J-1, 2026-09-02 audit): zero importers anywhere in src/ — even
 * `traceability.ts`, whose header comment claims this module was "added alongside" it, only
 * mentions ontology.ts in prose, never imports it. `traceability.ts`'s real accessors (backing
 * `forge trace`) re-derive their shapes ad hoc instead of going through this module's typed
 * vocabulary. Kept as-is (not deleted) — the entity vocabulary is real and matches
 * `traceability.ts`'s own query shapes, so wiring it in later means updating `traceability.ts`'s
 * accessors to return/consume these types, not writing new logic from scratch.
 *
 * `upgrades/ENGINEERING_COMPLETENESS.md`'s traceability thread (see `traceability.ts`'s header)
 * needs a shared vocabulary of engineering "nouns" — Requirement, Feature, Test, Risk, Decision,
 * Deployment, and so on — so trace/reporting logic can talk about "the entities" instead of
 * re-deriving ad-hoc shapes from raw rows every time. This module is that vocabulary.
 *
 * Hard rule (per the task this module was built for): every entity here CROSS-REFERENCES data
 * FORGE already persists — `queue.yaml`, `adr_records`, `risks`, `self_created_agents`,
 * `test_run_results`, `deployment_history`, `dependency_audit_findings`, `schema_drift_findings`,
 * `adversary_findings`, `build_runs` — never a new table, never a fabricated row. Where a real
 * accessor exists below, it queries one of those sources directly (mirroring the exact query
 * shapes `src/governance/provenance-ledgers.ts` and `src/governance/traceability.ts` already use)
 * and maps the result onto a typed entity. Where FORGE has NO structured backing data for a
 * concept yet (`Capability`, `UserStory`, `AcceptanceCriterion`, `ArchitectureComponent`,
 * `Service`, `Environment`), the TYPE is still defined here for API completeness — every future
 * caller can import a stable shape — but it is explicitly commented "TYPE-ONLY" and ships with NO
 * accessor function. Do not backfill one with a new table; if real structured data for one of
 * these ever exists, add an accessor here following the pattern the backed entities use.
 *
 * Every accessor degrades the same way the rest of `src/governance/` and `src/memory/` do
 * (Contract 4): an unreachable Build Memory, a missing `queue.yaml`, or a non-git directory
 * yields an empty list rather than throwing.
 */

import { basename, join } from 'node:path';

import type { QueueEntry, PromptType } from '../engine/queue-generator.js';
import type { AdrRecord, BuildRun, SelfCreatedAgent, Risk as MemoryRisk } from '../types/index.js';
import type { TestRunResultRow, TestRunStatus, TestSuiteDb } from '../memory/test-results.js';

import { runQuery } from '../memory/client.js';
import { listAdrsByProject } from '../memory/adr.js';
import { listRisksByProject } from '../memory/risks.js';
import { listAgents as listSelfCreatedAgentRows } from '../memory/agents.js';
import { listLatestTestRunResults } from '../memory/test-results.js';
import { getBuildsByProject } from '../memory/builds.js';
import { loadQueueEntriesFromFile } from '../tools/queue-versioning.js';
import { extractRequirementIdsFromGovernance } from './traceability.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function projectNameOf(projectPath: string): string {
  return basename(projectPath) || 'project';
}

/** Load `queue.yaml` entries for `projectPath`, or `[]` on any missing/unreadable file. */
async function loadEntriesSafe(projectPath: string): Promise<QueueEntry[]> {
  const queuePath = join(projectPath, 'queue.yaml');
  try {
    return await loadQueueEntriesFromFile(queuePath);
  } catch {
    return [];
  }
}

/** Declared output files across an entry's `file_exists` gate(s), if any. */
function declaredFiles(entry: QueueEntry): string[] {
  const files: string[] = [];
  for (const gate of entry.gates ?? []) {
    if (gate.type === 'file_exists') files.push(...gate.files);
  }
  return files;
}

// ---------------------------------------------------------------------------
// 1. Requirement — backed by PRD.md/BLUEPRINT.md REQ-NNN ids (traceability.ts)
// ---------------------------------------------------------------------------

/**
 * A `REQ-NNN` requirement id declared in `PRD.md` and/or `BLUEPRINT.md`. Backed by
 * `traceability.ts`'s `extractRequirementIdsFromGovernance` — the same id scheme `forge trace`
 * already resolves. There is no dedicated requirements table: the id string, plus which
 * governance document(s) declare it, IS the entity.
 */
export interface Requirement {
  kind: 'Requirement';
  id: string;
  projectName: string;
  declaredIn: Array<'PRD' | 'BLUEPRINT'>;
}

/** Every `REQ-NNN` id declared in `projectPath`'s governance documents, as `Requirement` entities. */
export async function listRequirements(projectPath: string): Promise<Requirement[]> {
  const projectName = projectNameOf(projectPath);
  const ids = await extractRequirementIdsFromGovernance(projectPath);
  return ids.all.map((id) => ({
    kind: 'Requirement' as const,
    id,
    projectName,
    declaredIn: [
      ...(ids.prd.includes(id) ? (['PRD'] as const) : []),
      ...(ids.blueprint.includes(id) ? (['BLUEPRINT'] as const) : []),
    ],
  }));
}

// ---------------------------------------------------------------------------
// 2. Feature — backed by queue.yaml entries with prompt_type 'feature'
// ---------------------------------------------------------------------------

/**
 * A buildable feature — backed 1:1 by a `queue.yaml` entry whose `prompt_type` is `'feature'`
 * (`src/engine/queue-generator.ts` › `PromptType`). No separate features table: the compiled
 * queue itself is the feature backlog.
 */
export interface Feature {
  kind: 'Feature';
  id: string;
  name: string;
  description: string;
  dependencies: string[];
}

/** Every `queue.yaml` entry whose `prompt_type` is `'feature'`, as `Feature` entities. */
export async function listFeatures(projectPath: string): Promise<Feature[]> {
  const entries = await loadEntriesSafe(projectPath);
  return entries
    .filter((e) => e.prompt_type === 'feature')
    .map((e) => ({ kind: 'Feature' as const, id: e.id, name: e.name, description: e.description, dependencies: e.dependencies }));
}

// ---------------------------------------------------------------------------
// 3. Workflow — backed by the queue.yaml dependency/parallel-group graph
// ---------------------------------------------------------------------------

/** One step of a `Workflow` — a single `queue.yaml` entry positioned in the build graph. */
export interface WorkflowStep {
  entryId: string;
  name: string;
  promptType: PromptType;
  dependsOn: string[];
  parallelGroup?: string;
}

/**
 * The compiled build pipeline for one project — backed by the full `queue.yaml` entry graph
 * (`dependencies` + `parallel_group`, `src/engine/queue-generator.ts`). No separate workflow
 * table: the compiled queue's dependency graph IS the workflow.
 */
export interface Workflow {
  kind: 'Workflow';
  projectName: string;
  steps: WorkflowStep[];
}

/** The full `queue.yaml` dependency graph for `projectPath`, as a `Workflow` entity. */
export async function getWorkflow(projectPath: string): Promise<Workflow> {
  const entries = await loadEntriesSafe(projectPath);
  return {
    kind: 'Workflow',
    projectName: projectNameOf(projectPath),
    steps: entries.map((e) => ({
      entryId: e.id,
      name: e.name,
      promptType: e.prompt_type,
      dependsOn: e.dependencies,
      parallelGroup: e.parallel_group,
    })),
  };
}

// ---------------------------------------------------------------------------
// 4. ApiEndpoint — backed by queue.yaml entries with prompt_type 'api'
// ---------------------------------------------------------------------------

/**
 * An API surface built by one `queue.yaml` entry whose `prompt_type` is `'api'`. `declaredFiles`
 * surfaces that entry's `file_exists` gate output paths (route handlers, controllers, …) as the
 * closest real signal to "which files implement this endpoint" FORGE already records.
 */
export interface ApiEndpoint {
  kind: 'ApiEndpoint';
  id: string;
  name: string;
  description: string;
  declaredFiles: string[];
}

/** Every `queue.yaml` entry whose `prompt_type` is `'api'`, as `ApiEndpoint` entities. */
export async function listApiEndpoints(projectPath: string): Promise<ApiEndpoint[]> {
  const entries = await loadEntriesSafe(projectPath);
  return entries
    .filter((e) => e.prompt_type === 'api')
    .map((e) => ({ kind: 'ApiEndpoint' as const, id: e.id, name: e.name, description: e.description, declaredFiles: declaredFiles(e) }));
}

// ---------------------------------------------------------------------------
// 5. DatabaseEntity — backed by queue.yaml 'schema' entries + schema_drift_findings
// ---------------------------------------------------------------------------

/**
 * A persisted table/entity in the project's data layer. Two independent real sources feed this,
 * not a unified table: the `queue.yaml` entry that created it (`prompt_type: 'schema'`) and any
 * `schema_drift_findings` rows recorded against it (`src/learning/database.ts` ›
 * `schema_drift_findings`, the same table `provenance-ledgers.ts`'s tech-debt seeding reads).
 * `id` is therefore prefixed by its source (`queue:<entry-id>` / `drift:<finding-id>`) so the two
 * are never mistaken for the same row.
 */
export interface DatabaseEntity {
  kind: 'DatabaseEntity';
  id: string;
  name: string;
  source: 'queue_entry' | 'schema_drift_finding';
  detail: string;
}

interface SchemaDriftFindingRow {
  id: string;
  table_name: string;
  finding_type: string;
  detail: string;
  severity: string;
}

async function listSchemaDriftFindings(projectPath: string): Promise<SchemaDriftFindingRow[]> {
  const rows = await runQuery<SchemaDriftFindingRow[]>('ontology.listSchemaDriftFindings', (db) =>
    db
      .prepare(`SELECT id, table_name, finding_type, detail, severity FROM schema_drift_findings WHERE project_path = ?`)
      .all(projectPath) as SchemaDriftFindingRow[]
  );
  return rows ?? [];
}

/** `schema` queue entries plus recorded `schema_drift_findings` rows for `projectPath`, as `DatabaseEntity` entities. */
export async function listDatabaseEntities(projectPath: string): Promise<DatabaseEntity[]> {
  const entries = await loadEntriesSafe(projectPath);
  const fromQueue: DatabaseEntity[] = entries
    .filter((e) => e.prompt_type === 'schema')
    .map((e) => ({ kind: 'DatabaseEntity' as const, id: `queue:${e.id}`, name: e.name, source: 'queue_entry' as const, detail: e.description }));

  const drift = await listSchemaDriftFindings(projectPath);
  const fromDrift: DatabaseEntity[] = drift.map((r) => ({
    kind: 'DatabaseEntity' as const,
    id: `drift:${r.id}`,
    name: r.table_name,
    source: 'schema_drift_finding' as const,
    detail: `${r.finding_type} (${r.severity}): ${r.detail}`,
  }));

  return [...fromQueue, ...fromDrift];
}

// ---------------------------------------------------------------------------
// 6. Agent — backed by self_created_agents (the `forge agent approve/reject/list` data model)
// ---------------------------------------------------------------------------

/**
 * An agent FORGE proposed for itself through recursive learning — backed 1:1 by a
 * `self_created_agents` row (`src/memory/agents.ts`), the exact data model
 * `forge agent approve/reject/list` (added in commit `22d2b35`) already reads and writes.
 */
export interface Agent {
  kind: 'Agent';
  id: string;
  name: string;
  purpose: string;
  status: SelfCreatedAgent['status'];
  approvedAt: string | null;
  buildsUsedIn: number;
  effectivenessScore: number | null;
}

/** Every `self_created_agents` row, as `Agent` entities. */
export async function listAgentEntities(): Promise<Agent[]> {
  const rows = await listSelfCreatedAgentRows();
  return (rows ?? []).map((r) => ({
    kind: 'Agent' as const,
    id: r.id,
    name: r.name,
    purpose: r.purpose,
    status: r.status,
    approvedAt: r.approved_at,
    buildsUsedIn: r.builds_used_in,
    effectivenessScore: r.effectiveness_score,
  }));
}

// ---------------------------------------------------------------------------
// 7. Dependency — backed by dependency_audit_findings + DEPENDENCY_SCAN test_run_results
// ---------------------------------------------------------------------------

/**
 * A third-party package finding — backed by `dependency_audit_findings`
 * (`src/learning/database.ts`, the same table `provenance-ledgers.ts` reads to seed tech debt)
 * and, secondarily, any `test_run_results` row recorded under the `DEPENDENCY_SCAN` suite
 * (`pnpm-audit`/`trivy` runners — `src/memory/test-results.ts` › `TestSuiteDb`).
 */
export interface Dependency {
  kind: 'Dependency';
  id: string;
  packageName: string;
  findingType: string;
  detail: string;
  source: 'dependency_audit_finding' | 'dependency_scan_test';
}

interface DependencyAuditFindingRow {
  id: string;
  package_name: string;
  finding_type: string;
  detail: string;
}

async function listDependencyAuditFindings(projectPath: string): Promise<DependencyAuditFindingRow[]> {
  const rows = await runQuery<DependencyAuditFindingRow[]>('ontology.listDependencyAuditFindings', (db) =>
    db
      .prepare(`SELECT id, package_name, finding_type, detail FROM dependency_audit_findings WHERE project_path = ?`)
      .all(projectPath) as DependencyAuditFindingRow[]
  );
  return rows ?? [];
}

/** `dependency_audit_findings` rows plus `DEPENDENCY_SCAN` test evidence for the project, as `Dependency` entities. */
export async function listDependencyEntities(projectPath: string, projectName: string): Promise<Dependency[]> {
  const findings = await listDependencyAuditFindings(projectPath);
  const fromFindings: Dependency[] = findings.map((f) => ({
    kind: 'Dependency' as const,
    id: `audit:${f.id}`,
    packageName: f.package_name,
    findingType: f.finding_type,
    detail: f.detail,
    source: 'dependency_audit_finding' as const,
  }));

  const testRows = (await listLatestTestRunResults(projectName)) ?? [];
  const fromScan: Dependency[] = testRows
    .filter((r) => r.test_suite === 'DEPENDENCY_SCAN')
    .map((r) => ({
      kind: 'Dependency' as const,
      id: `test:${r.id}`,
      packageName: r.runner,
      findingType: r.status,
      detail: r.report_path ?? '',
      source: 'dependency_scan_test' as const,
    }));

  return [...fromFindings, ...fromScan];
}

// ---------------------------------------------------------------------------
// 8. Test — backed by test_run_results (TestOrchestrator persistence)
// ---------------------------------------------------------------------------

/**
 * One recorded test run — backed 1:1 by a `test_run_results` row
 * (`src/memory/test-results.ts` › `TestRunResultRow`), TestOrchestrator's persistence layer and
 * the same table `traceability.ts`'s downstream "TESTED" evidence reads.
 */
export interface Test {
  kind: 'Test';
  id: string;
  projectName: string;
  suite: TestSuiteDb;
  runner: string;
  status: TestRunStatus;
  testsTotal: number;
  testsPassed: number;
  testsFailed: number;
  completedAt: string | null;
}

/** The latest `test_run_results` row per suite for `projectName`, as `Test` entities. */
export async function listTests(projectName: string): Promise<Test[]> {
  const rows = (await listLatestTestRunResults(projectName)) ?? [];
  return rows.map((r) => toTestEntity(r, projectName));
}

function toTestEntity(r: TestRunResultRow, projectName: string): Test {
  return {
    kind: 'Test',
    id: r.id,
    projectName,
    suite: r.test_suite,
    runner: r.runner,
    status: r.status,
    testsTotal: r.tests_total,
    testsPassed: r.tests_passed,
    testsFailed: r.tests_failed,
    completedAt: r.completed_at,
  };
}

// ---------------------------------------------------------------------------
// 9. Risk — backed by the risk register (risks table)
// ---------------------------------------------------------------------------

/** A registered project risk — backed 1:1 by a `risks` row (`src/memory/risks.ts`, the risk register). */
export interface Risk {
  kind: 'Risk';
  id: string;
  title: string;
  description: string;
  category: MemoryRisk['category'];
  severityScore: number;
  status: MemoryRisk['status'];
  relatedAdrId: string | null;
}

/** Every `risks` row for `projectName`, as `Risk` entities. */
export async function listRiskEntities(projectName: string): Promise<Risk[]> {
  const rows = (await listRisksByProject(projectName)) ?? [];
  return rows.map((r) => ({
    kind: 'Risk' as const,
    id: r.id,
    title: r.title,
    description: r.description,
    category: r.category,
    severityScore: r.severity_score,
    status: r.status,
    relatedAdrId: r.related_adr_id,
  }));
}

// ---------------------------------------------------------------------------
// 10. Decision — backed by the ADR provenance log (adr_records table)
// ---------------------------------------------------------------------------

/** An Architecture Decision Record — backed 1:1 by an `adr_records` row (`src/memory/adr.ts`). */
export interface Decision {
  kind: 'Decision';
  id: string;
  adrNumber: number;
  title: string;
  status: AdrRecord['status'];
  context: string;
  decision: string;
}

/** Every `adr_records` row for `projectName`, oldest first, as `Decision` entities. */
export async function listDecisions(projectName: string): Promise<Decision[]> {
  const rows = (await listAdrsByProject(projectName)) ?? [];
  return rows.map((r) => ({
    kind: 'Decision' as const,
    id: r.id,
    adrNumber: r.adr_number,
    title: r.title,
    status: r.status,
    context: r.context,
    decision: r.decision,
  }));
}

// ---------------------------------------------------------------------------
// 11. Defect — backed by adversary_findings + failed test_run_results rows
// ---------------------------------------------------------------------------

/**
 * A found defect — backed by two real sources FORGE has no dedicated "defects" table for:
 * `adversary_findings` rows (`src/learning/database.ts`, the adversarial-review findings log the
 * same table `provenance-ledgers.ts` seeds tech debt from) and `test_run_results` rows whose
 * `status` is `'failed'`/`'error'` (a failing recorded test IS a defect signal, even with no
 * dedicated defect id of its own).
 */
export interface Defect {
  kind: 'Defect';
  id: string;
  title: string;
  description: string;
  severity: string;
  resolution: string;
  source: 'adversary_finding' | 'failed_test';
}

interface AdversaryFindingRow {
  id: string;
  phase: string;
  severity: string;
  issue: string;
  fix: string | null;
  resolution: string;
}

async function listAdversaryFindings(projectPath: string, projectName: string): Promise<AdversaryFindingRow[]> {
  const rows = await runQuery<AdversaryFindingRow[]>('ontology.listAdversaryFindings', (db) => {
    const buildIds = (
      db.prepare(`SELECT id FROM build_runs WHERE project_name = ? OR project_path = ?`).all(projectName, projectPath) as Array<{ id: string }>
    ).map((b) => b.id);
    if (buildIds.length === 0) return [];
    const placeholders = buildIds.map(() => '?').join(',');
    return db
      .prepare(`SELECT id, phase, severity, issue, fix, resolution FROM adversary_findings WHERE build_id IN (${placeholders})`)
      .all(...buildIds) as AdversaryFindingRow[];
  });
  return rows ?? [];
}

/** `adversary_findings` rows for the project's builds, plus any failed/errored `test_run_results` rows, as `Defect` entities. */
export async function listDefects(projectPath: string, projectName: string): Promise<Defect[]> {
  const adversary = await listAdversaryFindings(projectPath, projectName);
  const fromAdversary: Defect[] = adversary.map((a) => ({
    kind: 'Defect' as const,
    id: `adv:${a.id}`,
    title: `${a.phase}: ${a.issue.slice(0, 80)}`,
    description: a.fix ? `${a.issue}\n\nSuggested fix: ${a.fix}` : a.issue,
    severity: a.severity,
    resolution: a.resolution,
    source: 'adversary_finding' as const,
  }));

  const testRows = (await listLatestTestRunResults(projectName)) ?? [];
  const fromFailedTests: Defect[] = testRows
    .filter((r) => r.status === 'failed' || r.status === 'error')
    .map((r) => ({
      kind: 'Defect' as const,
      id: `test:${r.id}`,
      title: `${r.test_suite} ${r.status} (${r.runner})`,
      description: r.failure_summary ? JSON.stringify(r.failure_summary) : 'no failure detail recorded',
      severity: 'SIGNIFICANT',
      resolution: 'PENDING',
      source: 'failed_test' as const,
    }));

  return [...fromAdversary, ...fromFailedTests];
}

// ---------------------------------------------------------------------------
// 12. Deployment — backed by deployment_history
// ---------------------------------------------------------------------------

/** One deployment attempt — backed 1:1 by a `deployment_history` row (`src/learning/database.ts`). */
export interface Deployment {
  kind: 'Deployment';
  id: string;
  buildRunId: string;
  platform: string;
  status: string;
  deploymentUrl: string | null;
  deployedAt: string | null;
}

interface DeploymentHistoryRow {
  id: string;
  build_run_id: string;
  platform: string;
  status: string;
  deployment_url: string | null;
  deployed_at: string | null;
}

/** Every `deployment_history` row for `projectPath`, newest first, as `Deployment` entities. */
export async function listDeployments(projectPath: string): Promise<Deployment[]> {
  const rows = await runQuery<DeploymentHistoryRow[]>('ontology.listDeployments', (db) =>
    db
      .prepare(`SELECT id, build_run_id, platform, status, deployment_url, deployed_at FROM deployment_history WHERE project_path = ? ORDER BY created_at DESC`)
      .all(projectPath) as DeploymentHistoryRow[]
  );
  return (rows ?? []).map((r) => ({
    kind: 'Deployment' as const,
    id: r.id,
    buildRunId: r.build_run_id,
    platform: r.platform,
    status: r.status,
    deploymentUrl: r.deployment_url,
    deployedAt: r.deployed_at,
  }));
}

// ---------------------------------------------------------------------------
// 13. Release — backed by build_runs (completed) joined against deployment_history ('ready')
// ---------------------------------------------------------------------------

/**
 * A shipped build — backed by a `build_runs` row whose `status` is `'completed'`, cross-checked
 * against `deployment_history` for a `'ready'` row on that build (the same join
 * `traceability.ts`'s `isLatestBuildDeployed` already performs for its DEPLOYED stage). No
 * separate releases table: "completed build + ready deployment" IS a release.
 */
export interface Release {
  kind: 'Release';
  id: string;
  projectName: string;
  status: BuildRun['status'];
  completedAt: string | null;
  deployed: boolean;
}

/** Every completed `build_runs` row for `projectName`, cross-checked for a `'ready'` deployment, as `Release` entities. */
export async function listReleases(projectName: string): Promise<Release[]> {
  const builds = (await getBuildsByProject(projectName)) ?? [];
  const completed = builds.filter((b) => b.status === 'completed');

  const releases: Release[] = [];
  for (const b of completed) {
    const readyCount = await runQuery<number>('ontology.listReleases', (db) => {
      const row = db.prepare(`SELECT COUNT(*) as c FROM deployment_history WHERE build_run_id = ? AND status = 'ready'`).get(b.id) as { c: number };
      return row.c;
    });
    releases.push({
      kind: 'Release',
      id: b.id,
      projectName,
      status: b.status,
      completedAt: b.completed_at,
      deployed: (readyCount ?? 0) > 0,
    });
  }
  return releases;
}

// ---------------------------------------------------------------------------
// Type-only placeholders — no Build Memory backing exists yet
// ---------------------------------------------------------------------------
//
// FORGE has no structured, queryable source for any of the six concepts below. PRD.md and
// BLUEPRINT.md model them (when they appear at all) as prose, and `ArchitectureDesign`
// (`src/phases/phase1b-architect.ts`) — the closest FORGE gets to a structured architecture
// model — exists only transiently during Phase 1B and is rendered straight to BLUEPRINT.md prose,
// never persisted in a re-queryable form. Per the task these types were built for: define the
// shape now for API completeness, but do NOT introduce a new table to back them, and do NOT ship
// an accessor function that fabricates rows. If FORGE ever gains real structured data for one of
// these (e.g. a `capability` field on queue entries, a parsed BLUEPRINT.md component registry),
// add a `list<Entity>` accessor here that queries it, following the exact pattern the thirteen
// backed entities above use — never invent the data itself.

/** A grouping of related Features/Requirements into a higher-level product capability. TYPE-ONLY. */
export interface Capability {
  kind: 'Capability';
  id: string;
  name: string;
  featureIds: string[];
}

/** A "as a … I want … so that …" user story. TYPE-ONLY. */
export interface UserStory {
  kind: 'UserStory';
  id: string;
  asA: string;
  iWant: string;
  soThat: string;
  requirementIds: string[];
}

/** One Given/When/Then (or equivalent) acceptance criterion for a `UserStory`/`Requirement`. TYPE-ONLY. */
export interface AcceptanceCriterion {
  kind: 'AcceptanceCriterion';
  id: string;
  parentId: string;
  description: string;
  satisfied: boolean;
}

/** A named piece of the system's architecture (module, layer, package). TYPE-ONLY. */
export interface ArchitectureComponent {
  kind: 'ArchitectureComponent';
  id: string;
  name: string;
  description: string;
  dependsOnComponentIds: string[];
}

/** A deployable service/process boundary. TYPE-ONLY. */
export interface Service {
  kind: 'Service';
  id: string;
  name: string;
  componentIds: string[];
}

/** A deployment target (dev/staging/production, …). TYPE-ONLY — `deployment_history.platform` is
 *  the nearest real signal FORGE records today, but it names a deploy PLATFORM (e.g. `vercel`),
 *  not an environment lifecycle stage, so it is not treated as a backing source here. */
export interface Environment {
  kind: 'Environment';
  id: string;
  name: string;
  platform: string;
}

// ---------------------------------------------------------------------------
// Reference lists — which entities are real vs. type-only (used by tests/tooling)
// ---------------------------------------------------------------------------

/** Every ontology entity `kind` with a real Build Memory-backed accessor above. */
export const BACKED_ONTOLOGY_KINDS = [
  'Requirement',
  'Feature',
  'Workflow',
  'ApiEndpoint',
  'DatabaseEntity',
  'Agent',
  'Dependency',
  'Test',
  'Risk',
  'Decision',
  'Defect',
  'Deployment',
  'Release',
] as const;

/** Every ontology entity `kind` defined for API completeness only — no accessor, no backing data. */
export const PLACEHOLDER_ONTOLOGY_KINDS = [
  'Capability',
  'UserStory',
  'AcceptanceCriterion',
  'ArchitectureComponent',
  'Service',
  'Environment',
] as const;
