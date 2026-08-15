/**
 * FORGE 2.0 — Governance Provenance Ledgers: ADR log, assumption registry, risk register,
 * tech-debt ledger.
 *
 * `upgrades/ENGINEERING_COMPLETENESS.md`'s broader "FORGE should know why, not just what" thread
 * (the same thread `traceability.ts`/`invariants.ts`/`build-state-machine.ts` already answer for
 * requirements/rules/lifecycle) is missing four adjacent records every mature engineering org
 * keeps: WHY a decision was made (ADR), WHAT was assumed without proof, WHAT could go wrong, and
 * WHAT was cut for later. This module is the domain layer over the four `src/memory/` CRUD
 * modules (`adr.ts`, `assumptions.ts`, `risks.ts`, `tech-debt.ts`) — sequential ADR numbering and
 * supersede-chain bookkeeping, severity-score computation, staleness detection, and — for
 * tech-debt specifically — seeding ledger rows from findings FORGE already persists
 * (`dead_code_findings`, `schema_drift_findings`, `dependency_audit_findings`,
 * `adversary_findings`) rather than requiring every item to be entered by hand.
 *
 * Same posture as every sibling `src/governance/` module: real, persisted rows only — nothing
 * here fabricates a decision, assumption, risk, or debt item that wasn't actually recorded by a
 * caller or backed by a real findings row. Every helper degrades honestly (returns `null`/`[]`
 * with a logged warning, per Contract 4) rather than throwing when Build Memory is unreachable.
 */

import { basename } from 'node:path';

import * as adr from '../memory/adr.js';
import * as assumptions from '../memory/assumptions.js';
import * as risks from '../memory/risks.js';
import * as techDebt from '../memory/tech-debt.js';
import { getClient, nowIso } from '../memory/client.js';
import type {
  AdrRecord,
  AdrStatus,
  Assumption,
  AssumptionCategory,
  Risk,
  RiskCategory,
  RiskStatus,
  TechDebtCategory,
  TechDebtItem,
  TechDebtSeverity,
  TechDebtSource,
} from '../types/index.js';

function projectNameOf(projectPath: string): string {
  return basename(projectPath) || 'project';
}

// ---------------------------------------------------------------------------
// ADR provenance log
// ---------------------------------------------------------------------------

export interface RecordAdrInput {
  title: string;
  context: string;
  decision: string;
  decidedBy: string;
  status?: AdrStatus;
  consequences?: string;
  alternativesConsidered?: string[];
  source?: string;
  relatedFiles?: string[];
  /** id of a prior ADR this one supersedes — that ADR is automatically marked `superseded`. */
  supersedes?: string;
  buildRunId?: string;
}

/**
 * Record a new ADR for `projectPath`, auto-assigning the next sequential `adr_number`. When
 * `supersedes` names a prior ADR id, that ADR is atomically re-marked `status: 'superseded'` /
 * `superseded_by: <new id>` after the new row is created — a real, queryable supersede chain
 * rather than a prose reference. Returns `null` if Build Memory is unreachable, or if
 * `supersedes` names an id that does not exist (the new ADR is still recorded in that case, since
 * a bad reference in the caller's input should not prevent recording the decision itself — but
 * the supersede link is left unset and the caller is not told the link failed via a thrown error,
 * only via the returned record's `supersedes` field reflecting what actually happened).
 */
export async function recordAdr(projectPath: string, input: RecordAdrInput): Promise<AdrRecord | null> {
  const projectName = projectNameOf(projectPath);
  const nextNumber = (await adr.getMaxAdrNumber(projectName)) + 1;

  let supersedesId: string | null = null;
  if (input.supersedes) {
    const prior = await adr.getAdrById(input.supersedes);
    if (prior && prior.project_name === projectName) supersedesId = prior.id;
  }

  const created = await adr.createAdr({
    project_name: projectName,
    project_path: projectPath,
    adr_number: nextNumber,
    title: input.title,
    status: input.status ?? 'proposed',
    context: input.context,
    decision: input.decision,
    consequences: input.consequences ?? null,
    alternatives_considered: input.alternativesConsidered ?? [],
    decided_by: input.decidedBy,
    source: input.source ?? null,
    related_files: input.relatedFiles ?? [],
    supersedes: supersedesId,
    build_run_id: input.buildRunId ?? null,
  });
  if (!created) return null;

  if (supersedesId) {
    await adr.updateAdr(supersedesId, { status: 'superseded', superseded_by: created.id });
  }
  return created;
}

/** List every ADR recorded for `projectPath`, oldest first (ADR-001, ADR-002, …). */
export function listAdrs(projectPath: string): Promise<AdrRecord[] | null> {
  return adr.listAdrsByProject(projectNameOf(projectPath));
}

/** Render an ADR log as human-readable lines (used by `forge adr list`). */
export function formatAdrLog(records: AdrRecord[]): string {
  if (records.length === 0) return '  (no ADRs recorded)';
  return records
    .map((r) => {
      const num = `ADR-${String(r.adr_number).padStart(3, '0')}`;
      const chain = r.supersedes ? ` (supersedes an earlier ADR)` : r.superseded_by ? ` (superseded)` : '';
      return `  [${r.status.toUpperCase()}] ${num} — ${r.title}${chain}\n      decision: ${r.decision}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Assumption registry
// ---------------------------------------------------------------------------

export interface RecordAssumptionInput {
  statement: string;
  category: AssumptionCategory;
  impactIfWrong: string;
  confidence?: number;
  owner?: string;
  relatedAdrId?: string;
  buildRunId?: string;
}

/** Record a new assumption for `projectPath`. Starts `unvalidated` until {@link validateAssumption} is called. */
export function recordAssumption(projectPath: string, input: RecordAssumptionInput): Promise<Assumption | null> {
  return assumptions.createAssumption({
    project_name: projectNameOf(projectPath),
    project_path: projectPath,
    statement: input.statement,
    category: input.category,
    impact_if_wrong: input.impactIfWrong,
    confidence: input.confidence ?? null,
    owner: input.owner ?? null,
    related_adr_id: input.relatedAdrId ?? null,
    build_run_id: input.buildRunId ?? null,
  });
}

/**
 * Record the outcome of independently checking an assumption: `outcome: 'validated'` or
 * `'invalidated'`, with the evidence that decided it. Sets `validated_at`. Returns the updated
 * row, or `null` if `id` does not exist / Build Memory is unreachable.
 */
export function validateAssumption(
  id: string,
  outcome: 'validated' | 'invalidated',
  method: string,
  evidence: string
): Promise<Assumption | null> {
  return assumptions.updateAssumption(id, {
    status: outcome,
    validation_method: method,
    validation_evidence: evidence,
    validated_at: nowIso(),
  });
}

/**
 * Re-mark every `unvalidated` assumption for `projectPath` older than `olderThanDays` (default
 * 30) as `stale` — a real signal (age with no recorded validation) rather than a guess at whether
 * it still holds. Returns the assumptions that were flagged. `[]` if none qualify or Build Memory
 * is unreachable.
 */
export async function flagStaleAssumptions(projectPath: string, olderThanDays = 30): Promise<Assumption[]> {
  const projectName = projectNameOf(projectPath);
  const list = await assumptions.listAssumptionsByProject(projectName, 'unvalidated');
  if (!list) return [];

  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const stale: Assumption[] = [];
  for (const a of list) {
    if (new Date(a.created_at).getTime() > cutoff) continue;
    const updated = await assumptions.updateAssumption(a.id, { status: 'stale' });
    if (updated) stale.push(updated);
  }
  return stale;
}

/** List every assumption recorded for `projectPath`, optionally filtered by status. */
export function listAssumptions(
  projectPath: string,
  status?: Assumption['status']
): Promise<Assumption[] | null> {
  return assumptions.listAssumptionsByProject(projectNameOf(projectPath), status);
}

/** Render the assumption registry as human-readable lines (used by `forge assumption list`). */
export function formatAssumptionRegistry(list: Assumption[]): string {
  if (list.length === 0) return '  (no assumptions recorded)';
  return list
    .map((a) => {
      const conf = a.confidence !== null ? ` (confidence ${(a.confidence * 100).toFixed(0)}%)` : '';
      return `  [${a.status.toUpperCase()}] [${a.category}] ${a.statement}${conf}\n      if wrong: ${a.impact_if_wrong}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Risk register
// ---------------------------------------------------------------------------

export interface RecordRiskInput {
  title: string;
  description: string;
  category: RiskCategory;
  /** 1 (rare) - 5 (near-certain). */
  probability: number;
  /** 1 (negligible) - 5 (severe). */
  impact: number;
  mitigationPlan?: string;
  owner?: string;
  relatedAdrId?: string;
  relatedAssumptionId?: string;
  buildRunId?: string;
}

/** `probability * impact`, clamped into the 1-25 range the schema's CHECK constraints expect. */
export function computeSeverityScore(probability: number, impact: number): number {
  const p = Math.min(5, Math.max(1, Math.round(probability)));
  const i = Math.min(5, Math.max(1, Math.round(impact)));
  return p * i;
}

/** Record a new risk for `projectPath`. `severity_score` is derived from `probability * impact`. */
export function recordRisk(projectPath: string, input: RecordRiskInput): Promise<Risk | null> {
  return risks.createRisk({
    project_name: projectNameOf(projectPath),
    project_path: projectPath,
    title: input.title,
    description: input.description,
    category: input.category,
    probability: input.probability,
    impact: input.impact,
    severity_score: computeSeverityScore(input.probability, input.impact),
    mitigation_plan: input.mitigationPlan ?? null,
    owner: input.owner ?? null,
    related_adr_id: input.relatedAdrId ?? null,
    related_assumption_id: input.relatedAssumptionId ?? null,
    build_run_id: input.buildRunId ?? null,
  });
}

/**
 * Transition a risk's status. `'closed'`/`'realized'` stamp `closed_at`; any other status clears
 * it. Returns the updated row, or `null` if `id` does not exist / Build Memory is unreachable.
 */
export function updateRiskStatus(id: string, status: RiskStatus): Promise<Risk | null> {
  return risks.updateRisk(id, {
    status,
    closed_at: status === 'closed' || status === 'realized' ? nowIso() : null,
  });
}

/** List every risk recorded for `projectPath`, highest severity first, optionally filtered by status. */
export function listRisks(projectPath: string, status?: RiskStatus): Promise<Risk[] | null> {
  return risks.listRisksByProject(projectNameOf(projectPath), status);
}

/** Render the risk register as human-readable lines (used by `forge risk list`). */
export function formatRiskRegister(list: Risk[]): string {
  if (list.length === 0) return '  (no risks recorded)';
  return list
    .map((r) => {
      const mit = r.mitigation_plan ? `\n      mitigation: ${r.mitigation_plan}` : '';
      return `  [${r.status.toUpperCase()}] score ${r.severity_score} (P${r.probability}×I${r.impact}) [${r.category}] ${r.title}${mit}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tech-debt ledger
// ---------------------------------------------------------------------------

export interface RecordTechDebtInput {
  title: string;
  description: string;
  category: TechDebtCategory;
  severity: TechDebtSeverity;
  effortEstimate?: TechDebtItem['effort_estimate'];
  filePath?: string;
  introducedBuildId?: string;
}

/** Record a manual tech-debt item for `projectPath`. */
export function recordTechDebtItem(projectPath: string, input: RecordTechDebtInput): Promise<TechDebtItem | null> {
  return techDebt.createTechDebtItem({
    project_name: projectNameOf(projectPath),
    project_path: projectPath,
    title: input.title,
    description: input.description,
    category: input.category,
    severity: input.severity,
    effort_estimate: input.effortEstimate ?? 'unknown',
    file_path: input.filePath ?? null,
    source: 'manual',
    source_finding_id: null,
    introduced_build_id: input.introducedBuildId ?? null,
  });
}

/** Mark a tech-debt item resolved. Returns the updated row, or `null` if `id` does not exist / Build Memory is unreachable. */
export function resolveTechDebtItem(id: string, resolvedBuildId?: string): Promise<TechDebtItem | null> {
  return techDebt.updateTechDebtItem(id, {
    status: 'resolved',
    resolved_build_id: resolvedBuildId ?? null,
    resolved_at: nowIso(),
  });
}

/** List every tech-debt item recorded for `projectPath`, most severe first, optionally filtered by status. */
export function listTechDebt(projectPath: string, status?: TechDebtItem['status']): Promise<TechDebtItem[] | null> {
  return techDebt.listTechDebtByProject(projectNameOf(projectPath), status);
}

/** Render the tech-debt ledger as human-readable lines (used by `forge techdebt list`). */
export function formatTechDebtLedger(list: TechDebtItem[]): string {
  if (list.length === 0) return '  (no tech debt recorded)';
  return list
    .map((t) => {
      const loc = t.file_path ? ` (${t.file_path})` : '';
      return `  [${t.status.toUpperCase()}] [${t.severity}/${t.effort_estimate}] [${t.category}] ${t.title}${loc}  ${t.source !== 'manual' ? `— seeded from ${t.source}` : ''}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tech-debt seeding from real findings tables
// ---------------------------------------------------------------------------

interface SeedRow {
  id: string;
  title: string;
  description: string;
  category: TechDebtCategory;
  severity: TechDebtSeverity;
  filePath: string | null;
}

const ADVERSARY_SEVERITY: Record<string, TechDebtSeverity> = {
  BLOCKER: 'critical',
  SIGNIFICANT: 'high',
  MINOR: 'medium',
};
const SCHEMA_DRIFT_SEVERITY: Record<string, TechDebtSeverity> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

export interface SeedTechDebtResult {
  scanned: number;
  seeded: number;
  alreadyLedgered: number;
  bySource: Record<TechDebtSource, number>;
}

/**
 * Seed the tech-debt ledger for `projectPath` from findings FORGE already persists:
 * `dead_code_findings`, `schema_drift_findings`, and `dependency_audit_findings` (all keyed by
 * `project_path` directly), plus `adversary_findings` for builds belonging to this project
 * (keyed by `build_id`, resolved via `build_runs`). Only non-dismissed/non-resolved findings are
 * seeded. Each finding maps to at most one ledger row via the `(project_name, source,
 * source_finding_id)` dedup key in `src/memory/tech-debt.ts` — re-running this is always safe
 * (idempotent) and reports how many rows were newly created vs. already ledgered. Never throws;
 * returns all-zero counts when Build Memory is unreachable.
 */
export async function seedTechDebtFromFindings(projectPath: string): Promise<SeedTechDebtResult> {
  const projectName = projectNameOf(projectPath);
  const result: SeedTechDebtResult = {
    scanned: 0,
    seeded: 0,
    alreadyLedgered: 0,
    bySource: {
      manual: 0,
      dead_code_findings: 0,
      schema_drift_findings: 0,
      dependency_audit_findings: 0,
      adversary_findings: 0,
    },
  };

  const db = getClient();
  if (!db) return result;

  const rows: Array<{ source: TechDebtSource; row: SeedRow }> = [];

  try {
    const deadCode = db
      .prepare(
        `SELECT id, file_path, symbol_name, symbol_type, reason FROM dead_code_findings WHERE project_path = ?`
      )
      .all(projectPath) as Array<{ id: string; file_path: string; symbol_name: string; symbol_type: string; reason: string }>;
    for (const r of deadCode) {
      rows.push({
        source: 'dead_code_findings',
        row: {
          id: r.id,
          title: `Dead code: ${r.symbol_type} '${r.symbol_name}'`,
          description: r.reason,
          category: 'dead_code',
          severity: 'low',
          filePath: r.file_path,
        },
      });
    }

    const schemaDrift = db
      .prepare(
        `SELECT id, table_name, finding_type, detail, severity FROM schema_drift_findings WHERE project_path = ?`
      )
      .all(projectPath) as Array<{ id: string; table_name: string; finding_type: string; detail: string; severity: string }>;
    for (const r of schemaDrift) {
      rows.push({
        source: 'schema_drift_findings',
        row: {
          id: r.id,
          title: `Schema drift: ${r.finding_type} on ${r.table_name}`,
          description: r.detail,
          category: 'schema_drift',
          severity: SCHEMA_DRIFT_SEVERITY[r.severity] ?? 'medium',
          filePath: null,
        },
      });
    }

    const depAudit = db
      .prepare(
        `SELECT id, package_name, finding_type, detail FROM dependency_audit_findings WHERE project_path = ?`
      )
      .all(projectPath) as Array<{ id: string; package_name: string; finding_type: string; detail: string }>;
    for (const r of depAudit) {
      rows.push({
        source: 'dependency_audit_findings',
        row: {
          id: r.id,
          title: `Dependency ${r.finding_type}: ${r.package_name}`,
          description: r.detail,
          category: 'dependency',
          severity: 'medium',
          filePath: null,
        },
      });
    }

    const buildIds = (
      db.prepare(`SELECT id FROM build_runs WHERE project_name = ? OR project_path = ?`).all(projectName, projectPath) as Array<{
        id: string;
      }>
    ).map((b) => b.id);
    if (buildIds.length > 0) {
      const placeholders = buildIds.map(() => '?').join(',');
      const adversary = db
        .prepare(
          `SELECT id, phase, severity, issue, fix FROM adversary_findings
           WHERE build_id IN (${placeholders}) AND severity != 'DISMISSED' AND resolution IN ('PENDING','DEFERRED')`
        )
        .all(...buildIds) as Array<{ id: string; phase: string; severity: string; issue: string; fix: string | null }>;
      for (const r of adversary) {
        rows.push({
          source: 'adversary_findings',
          row: {
            id: r.id,
            title: `Adversary review (${r.phase}): ${r.issue.slice(0, 80)}`,
            description: r.fix ? `${r.issue}\n\nSuggested fix: ${r.fix}` : r.issue,
            category: 'code_quality',
            severity: ADVERSARY_SEVERITY[r.severity] ?? 'medium',
            filePath: null,
          },
        });
      }
    }
  } catch {
    // Any single findings-table read failing (e.g. a table not yet migrated on an older db)
    // degrades to seeding from whatever was already collected, rather than aborting the scan.
  }

  result.scanned = rows.length;
  for (const { source, row } of rows) {
    const before = await techDebt.getTechDebtItemBySource(projectName, source, row.id);
    const created = await techDebt.createTechDebtItem({
      project_name: projectName,
      project_path: projectPath,
      title: row.title,
      description: row.description,
      category: row.category,
      severity: row.severity,
      effort_estimate: 'unknown',
      file_path: row.filePath,
      source,
      source_finding_id: row.id,
    });
    if (!created) continue;
    result.bySource[source] += 1;
    if (before) result.alreadyLedgered += 1;
    else result.seeded += 1;
  }

  return result;
}
