/**
 * FORGE 2.0 — Build Memory: gap_audit_runs + artifact_health_scores CRUD.
 *
 * See src/learning/database.ts › SYSTEMS_1_3_SCHEMA_SQL › gap_audit_runs /
 * artifact_health_scores, and upgrades/SCHEMA_ADDITIONS.md §1-§2 (authoritative contract).
 */

import type {
  ArtifactName,
  ArtifactScore,
  ContinuationStep,
  GapAuditRun,
  HaltPoint,
} from '../resurrection/types.js';
import { fromJsonText, fromSqliteBool, newId, runQuery, toJsonText, toSqliteBool } from './client.js';

const RUNS_TABLE = 'gap_audit_runs';
const SCORES_TABLE = 'artifact_health_scores';

export type NewGapAuditRun = Pick<
  GapAuditRun,
  'project_name' | 'project_path' | 'audit_trigger' | 'scope' | 'machine_id'
> &
  Partial<Omit<GapAuditRun, 'id' | 'created_at' | 'project_name' | 'project_path' | 'audit_trigger' | 'scope' | 'machine_id'>>;

export type GapAuditRunUpdate = Partial<Omit<GapAuditRun, 'id' | 'created_at'>>;

interface GapAuditRunRow {
  id: string;
  project_name: string;
  project_path: string;
  build_run_id: string | null;
  audit_trigger: string;
  scope: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  artifacts_audited: string;
  gaps_found_total: number;
  gaps_minor: number;
  gaps_major: number;
  gaps_critical: number;
  gaps_auto_regenerated: number;
  gaps_human_gated: number;
  halt_point_reference: string | null;
  continuation_plan: string | null;
  health_score_before: number | null;
  health_score_after: number | null;
  report_path: string | null;
  machine_id: string;
  created_at: string;
}

function rowToGapAuditRun(row: GapAuditRunRow): GapAuditRun {
  return {
    id: row.id,
    project_name: row.project_name,
    project_path: row.project_path,
    build_run_id: row.build_run_id,
    audit_trigger: row.audit_trigger as GapAuditRun['audit_trigger'],
    scope: row.scope as GapAuditRun['scope'],
    status: row.status as GapAuditRun['status'],
    started_at: row.started_at,
    completed_at: row.completed_at,
    duration_ms: row.duration_ms,
    artifacts_audited: fromJsonText<ArtifactName[]>(row.artifacts_audited, []),
    gaps_found_total: row.gaps_found_total,
    gaps_minor: row.gaps_minor,
    gaps_major: row.gaps_major,
    gaps_critical: row.gaps_critical,
    gaps_auto_regenerated: row.gaps_auto_regenerated,
    gaps_human_gated: row.gaps_human_gated,
    halt_point_reference: fromJsonText<HaltPoint | null>(row.halt_point_reference, null),
    continuation_plan: fromJsonText<ContinuationStep[] | null>(row.continuation_plan, null),
    health_score_before: row.health_score_before,
    health_score_after: row.health_score_after,
    report_path: row.report_path,
    machine_id: row.machine_id,
    created_at: row.created_at,
  };
}

export function createGapAuditRun(input: NewGapAuditRun): Promise<GapAuditRun | null> {
  return runQuery<GapAuditRun>(RUNS_TABLE + '.create', (db) => {
    const id = newId();
    db.prepare(
      `INSERT INTO gap_audit_runs (
        id, project_name, project_path, build_run_id, audit_trigger, scope, status,
        artifacts_audited, gaps_found_total, gaps_minor, gaps_major, gaps_critical,
        gaps_auto_regenerated, gaps_human_gated, halt_point_reference, continuation_plan,
        health_score_before, health_score_after, report_path, machine_id
      ) VALUES (
        @id, @project_name, @project_path, @build_run_id, @audit_trigger, @scope, @status,
        @artifacts_audited, @gaps_found_total, @gaps_minor, @gaps_major, @gaps_critical,
        @gaps_auto_regenerated, @gaps_human_gated, @halt_point_reference, @continuation_plan,
        @health_score_before, @health_score_after, @report_path, @machine_id
      )`
    ).run({
      id,
      project_name: input.project_name,
      project_path: input.project_path,
      build_run_id: input.build_run_id ?? null,
      audit_trigger: input.audit_trigger,
      scope: input.scope,
      status: input.status ?? 'running',
      artifacts_audited: toJsonText(input.artifacts_audited ?? []),
      gaps_found_total: input.gaps_found_total ?? 0,
      gaps_minor: input.gaps_minor ?? 0,
      gaps_major: input.gaps_major ?? 0,
      gaps_critical: input.gaps_critical ?? 0,
      gaps_auto_regenerated: input.gaps_auto_regenerated ?? 0,
      gaps_human_gated: input.gaps_human_gated ?? 0,
      halt_point_reference: input.halt_point_reference ? toJsonText(input.halt_point_reference) : null,
      continuation_plan: input.continuation_plan ? toJsonText(input.continuation_plan) : null,
      health_score_before: input.health_score_before ?? null,
      health_score_after: input.health_score_after ?? null,
      report_path: input.report_path ?? null,
      machine_id: input.machine_id,
    });
    const row = db.prepare('SELECT * FROM gap_audit_runs WHERE id = ?').get(id) as GapAuditRunRow;
    return rowToGapAuditRun(row);
  });
}

const RUN_UPDATE_TRANSFORMS: Partial<Record<keyof GapAuditRunUpdate, (v: unknown) => unknown>> = {
  artifacts_audited: (v) => toJsonText(v),
  halt_point_reference: (v) => (v === null ? null : toJsonText(v)),
  continuation_plan: (v) => (v === null ? null : toJsonText(v)),
};

export function updateGapAuditRun(id: string, patch: GapAuditRunUpdate): Promise<GapAuditRun | null> {
  return runQuery<GapAuditRun>(RUNS_TABLE + '.update', (db) => {
    const keys = Object.keys(patch) as Array<keyof GapAuditRunUpdate>;
    if (keys.length === 0) {
      const row = db.prepare('SELECT * FROM gap_audit_runs WHERE id = ?').get(id) as GapAuditRunRow | undefined;
      return row ? rowToGapAuditRun(row) : null;
    }
    const setClause = keys.map((k) => `${String(k)} = @${String(k)}`).join(', ');
    const params: Record<string, unknown> = { id };
    for (const k of keys) {
      const transform = RUN_UPDATE_TRANSFORMS[k];
      const value = (patch as Record<string, unknown>)[k as string];
      params[k as string] = transform ? transform(value) : value;
    }
    const result = db.prepare(`UPDATE gap_audit_runs SET ${setClause} WHERE id = @id`).run(params);
    if (result.changes === 0) return null;
    const row = db.prepare('SELECT * FROM gap_audit_runs WHERE id = ?').get(id) as GapAuditRunRow;
    return rowToGapAuditRun(row);
  });
}

export function getGapAuditRun(id: string): Promise<GapAuditRun | null> {
  return runQuery<GapAuditRun>(RUNS_TABLE + '.get', (db) => {
    const row = db.prepare('SELECT * FROM gap_audit_runs WHERE id = ?').get(id) as GapAuditRunRow | undefined;
    return row ? rowToGapAuditRun(row) : null;
  });
}

export function getLatestGapAuditRunForProject(projectName: string): Promise<GapAuditRun | null> {
  return runQuery<GapAuditRun>(RUNS_TABLE + '.getLatestForProject', (db) => {
    const row = db
      .prepare('SELECT * FROM gap_audit_runs WHERE project_name = ? ORDER BY created_at DESC LIMIT 1')
      .get(projectName) as GapAuditRunRow | undefined;
    return row ? rowToGapAuditRun(row) : null;
  });
}

export type NewArtifactScore = Omit<ArtifactScore, 'id' | 'scored_at'> & Partial<Pick<ArtifactScore, 'scored_at'>>;

interface ArtifactScoreRow {
  id: string;
  gap_audit_run_id: string;
  artifact_name: string;
  exists_on_disk: number;
  completeness_score: number;
  freshness_score: number;
  consistency_score: number;
  composite_score: number;
  drift_detected: number;
  drift_detail: string | null;
  missing_sections: string;
  placeholder_count: number;
  regeneration_recommended: number;
  regeneration_tier: string | null;
  scored_at: string;
  machine_id: string;
}

function rowToArtifactScore(row: ArtifactScoreRow): ArtifactScore {
  return {
    id: row.id,
    gap_audit_run_id: row.gap_audit_run_id,
    artifact_name: row.artifact_name as ArtifactScore['artifact_name'],
    exists_on_disk: fromSqliteBool(row.exists_on_disk),
    completeness_score: row.completeness_score,
    freshness_score: row.freshness_score,
    consistency_score: row.consistency_score,
    composite_score: row.composite_score,
    drift_detected: fromSqliteBool(row.drift_detected),
    drift_detail: fromJsonText(row.drift_detail, null),
    missing_sections: fromJsonText(row.missing_sections, []),
    placeholder_count: row.placeholder_count,
    regeneration_recommended: fromSqliteBool(row.regeneration_recommended),
    regeneration_tier: row.regeneration_tier as ArtifactScore['regeneration_tier'],
    scored_at: row.scored_at,
    machine_id: row.machine_id,
  };
}

export function createArtifactScore(input: NewArtifactScore): Promise<ArtifactScore | null> {
  return runQuery<ArtifactScore>(SCORES_TABLE + '.create', (db) => {
    const id = newId();
    db.prepare(
      `INSERT INTO artifact_health_scores (
        id, gap_audit_run_id, artifact_name, exists_on_disk, completeness_score,
        freshness_score, consistency_score, composite_score, drift_detected, drift_detail,
        missing_sections, placeholder_count, regeneration_recommended, regeneration_tier, machine_id
      ) VALUES (
        @id, @gap_audit_run_id, @artifact_name, @exists_on_disk, @completeness_score,
        @freshness_score, @consistency_score, @composite_score, @drift_detected, @drift_detail,
        @missing_sections, @placeholder_count, @regeneration_recommended, @regeneration_tier, @machine_id
      )`
    ).run({
      id,
      gap_audit_run_id: input.gap_audit_run_id,
      artifact_name: input.artifact_name,
      exists_on_disk: toSqliteBool(input.exists_on_disk),
      completeness_score: input.completeness_score,
      freshness_score: input.freshness_score,
      consistency_score: input.consistency_score,
      composite_score: input.composite_score,
      drift_detected: toSqliteBool(input.drift_detected),
      drift_detail: input.drift_detail ? toJsonText(input.drift_detail) : null,
      missing_sections: toJsonText(input.missing_sections ?? []),
      placeholder_count: input.placeholder_count,
      regeneration_recommended: toSqliteBool(input.regeneration_recommended),
      regeneration_tier: input.regeneration_tier ?? null,
      machine_id: input.machine_id,
    });
    const row = db.prepare('SELECT * FROM artifact_health_scores WHERE id = ?').get(id) as ArtifactScoreRow;
    return rowToArtifactScore(row);
  });
}

export function getArtifactScoresForRun(gapAuditRunId: string): Promise<ArtifactScore[] | null> {
  return runQuery<ArtifactScore[]>(SCORES_TABLE + '.getForRun', (db) => {
    const rows = db
      .prepare('SELECT * FROM artifact_health_scores WHERE gap_audit_run_id = ? ORDER BY artifact_name ASC')
      .all(gapAuditRunId) as ArtifactScoreRow[];
    return rows.map(rowToArtifactScore);
  });
}
