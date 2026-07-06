/**
 * FORGE 2.0 — Build Memory: production_telemetry CRUD.
 *
 * Runtime data from deployed applications. See src/learning/database.ts ›
 * BUILD_MEMORY_SCHEMA_SQL › production_telemetry.
 */

import type { ProductionTelemetry } from '../types/index.js';
import { fromJsonText, newId, nowIso, runQuery, toJsonText } from './client.js';

const TABLE = 'production_telemetry';

/**
 * Fields required to record a telemetry event. `captured_at` is optional and
 * defaults to the current time when omitted.
 */
export type NewProductionTelemetry = Pick<
  ProductionTelemetry,
  'project_name' | 'event_type' | 'event_data'
> &
  Partial<
    Omit<
      ProductionTelemetry,
      'id' | 'created_at' | 'project_name' | 'event_type' | 'event_data'
    >
  >;

interface ProductionTelemetryRow {
  id: string;
  project_name: string;
  build_run_id: string | null;
  event_type: string;
  event_data: string;
  severity: string | null;
  captured_at: string;
  fed_back_to_build: string | null;
  created_at: string;
}

function rowToTelemetry(row: ProductionTelemetryRow): ProductionTelemetry {
  return {
    id: row.id,
    project_name: row.project_name,
    build_run_id: row.build_run_id,
    event_type: row.event_type as ProductionTelemetry['event_type'],
    event_data: fromJsonText(row.event_data, {}),
    severity: row.severity as ProductionTelemetry['severity'],
    captured_at: row.captured_at,
    fed_back_to_build: row.fed_back_to_build,
    created_at: row.created_at,
  };
}

/** Insert a new production_telemetry event. Returns the created row, or null. */
export function createEvent(
  input: NewProductionTelemetry
): Promise<ProductionTelemetry | null> {
  return runQuery<ProductionTelemetry>(TABLE + '.createEvent', (db) => {
    const id = newId();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO production_telemetry (
        id, project_name, build_run_id, event_type, event_data, severity,
        captured_at, fed_back_to_build, created_at
      ) VALUES (
        @id, @project_name, @build_run_id, @event_type, @event_data, @severity,
        @captured_at, @fed_back_to_build, @created_at
      )`
    ).run({
      id,
      project_name: input.project_name,
      build_run_id: input.build_run_id ?? null,
      event_type: input.event_type,
      event_data: toJsonText(input.event_data),
      severity: input.severity ?? null,
      captured_at: input.captured_at ?? ts,
      fed_back_to_build: input.fed_back_to_build ?? null,
      created_at: ts,
    });
    const row = db.prepare('SELECT * FROM production_telemetry WHERE id = ?').get(id) as ProductionTelemetryRow;
    return rowToTelemetry(row);
  });
}

/**
 * List telemetry events for a project, most recently captured first. Returns
 * null on failure.
 */
export function getEventsByProject(
  projectName: string
): Promise<ProductionTelemetry[] | null> {
  return runQuery<ProductionTelemetry[]>(TABLE + '.getEventsByProject', (db) => {
    const rows = db
      .prepare('SELECT * FROM production_telemetry WHERE project_name = ? ORDER BY captured_at DESC')
      .all(projectName) as ProductionTelemetryRow[];
    return rows.map(rowToTelemetry);
  });
}

/**
 * List critical-severity telemetry events across all projects, most recently
 * captured first. Returns null on failure.
 */
export function getCriticalEvents(): Promise<ProductionTelemetry[] | null> {
  return runQuery<ProductionTelemetry[]>(TABLE + '.getCriticalEvents', (db) => {
    const rows = db
      .prepare("SELECT * FROM production_telemetry WHERE severity = 'critical' ORDER BY captured_at DESC")
      .all() as ProductionTelemetryRow[];
    return rows.map(rowToTelemetry);
  });
}
