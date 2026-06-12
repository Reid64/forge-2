/**
 * FORGE 2.0 — Build Memory: production_telemetry CRUD.
 *
 * Runtime data from deployed applications. See SCHEMA_REGISTRY.md ›
 * production_telemetry.
 */

import type { ProductionTelemetry } from '../types/index.js';
import { nowIso, runQuery } from './client.js';

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

/** Insert a new production_telemetry event. Returns the created row, or null. */
export function createEvent(
  input: NewProductionTelemetry
): Promise<ProductionTelemetry | null> {
  const payload = { captured_at: nowIso(), ...input };
  return runQuery<ProductionTelemetry>('createEvent', async (c) =>
    c.from(TABLE).insert(payload).select().single()
  );
}

/**
 * List telemetry events for a project, most recently captured first. Returns
 * null on failure.
 */
export function getEventsByProject(
  projectName: string
): Promise<ProductionTelemetry[] | null> {
  return runQuery<ProductionTelemetry[]>('getEventsByProject', async (c) =>
    c
      .from(TABLE)
      .select('*')
      .eq('project_name', projectName)
      .order('captured_at', { ascending: false })
  );
}

/**
 * List critical-severity telemetry events across all projects, most recently
 * captured first. Returns null on failure.
 */
export function getCriticalEvents(): Promise<ProductionTelemetry[] | null> {
  return runQuery<ProductionTelemetry[]>('getCriticalEvents', async (c) =>
    c
      .from(TABLE)
      .select('*')
      .eq('severity', 'critical')
      .order('captured_at', { ascending: false })
  );
}
