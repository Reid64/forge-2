/**
 * FORGE 2.0 — Build Memory: self_created_agents CRUD.
 *
 * Agents FORGE creates for itself through recursive learning. See
 * src/learning/database.ts › BUILD_MEMORY_SCHEMA_SQL › self_created_agents and
 * BEHAVIORAL_CONTRACTS.md Contract 17. New agents start as 'proposed' and
 * require human approval before activation.
 */

import type { SelfCreatedAgent } from '../types/index.js';
import { fromJsonText, newId, nowIso, runQuery, toJsonText } from './client.js';

const TABLE = 'self_created_agents';

/** Fields required to propose a self-created agent (NOT NULL, no DB default). */
export type NewSelfCreatedAgent = Pick<
  SelfCreatedAgent,
  | 'name'
  | 'purpose'
  | 'trigger_conditions'
  | 'input_contract'
  | 'output_contract'
  | 'implementation_code'
  | 'source_pattern_description'
> &
  Partial<
    Omit<
      SelfCreatedAgent,
      | 'id'
      | 'created_at'
      | 'updated_at'
      | 'name'
      | 'purpose'
      | 'trigger_conditions'
      | 'input_contract'
      | 'output_contract'
      | 'implementation_code'
      | 'source_pattern_description'
    >
  >;

interface SelfCreatedAgentRow {
  id: string;
  name: string;
  purpose: string;
  trigger_conditions: string;
  input_contract: string;
  output_contract: string;
  implementation_code: string;
  source_pattern_description: string;
  test_results: string;
  status: string;
  approved_at: string | null;
  builds_used_in: number;
  effectiveness_score: number | null;
  created_at: string;
  updated_at: string;
}

function rowToAgent(row: SelfCreatedAgentRow): SelfCreatedAgent {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    trigger_conditions: fromJsonText(row.trigger_conditions, {}),
    input_contract: fromJsonText(row.input_contract, {}),
    output_contract: fromJsonText(row.output_contract, {}),
    implementation_code: row.implementation_code,
    source_pattern_description: row.source_pattern_description,
    test_results: fromJsonText(row.test_results, {}),
    status: row.status as SelfCreatedAgent['status'],
    approved_at: row.approved_at,
    builds_used_in: row.builds_used_in,
    effectiveness_score: row.effectiveness_score,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Insert a new self_created_agent (status defaults to 'proposed'). Returns row or null. */
export function createAgent(
  input: NewSelfCreatedAgent
): Promise<SelfCreatedAgent | null> {
  return runQuery<SelfCreatedAgent>(TABLE + '.createAgent', (db) => {
    const id = newId();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO self_created_agents (
        id, name, purpose, trigger_conditions, input_contract, output_contract,
        implementation_code, source_pattern_description, test_results, status,
        approved_at, builds_used_in, effectiveness_score, created_at, updated_at
      ) VALUES (
        @id, @name, @purpose, @trigger_conditions, @input_contract, @output_contract,
        @implementation_code, @source_pattern_description, @test_results, @status,
        @approved_at, @builds_used_in, @effectiveness_score, @ts, @ts
      )`
    ).run({
      id,
      name: input.name,
      purpose: input.purpose,
      trigger_conditions: toJsonText(input.trigger_conditions),
      input_contract: toJsonText(input.input_contract),
      output_contract: toJsonText(input.output_contract),
      implementation_code: input.implementation_code,
      source_pattern_description: input.source_pattern_description,
      test_results: toJsonText(input.test_results ?? {}),
      status: input.status ?? 'proposed',
      approved_at: input.approved_at ?? null,
      builds_used_in: input.builds_used_in ?? 0,
      effectiveness_score: input.effectiveness_score ?? null,
      ts,
    });
    const row = db.prepare('SELECT * FROM self_created_agents WHERE id = ?').get(id) as SelfCreatedAgentRow;
    return rowToAgent(row);
  });
}

/**
 * Approve an agent: set status to 'approved' and stamp approved_at. Returns the
 * updated row, or null on failure.
 */
export function approveAgent(id: string): Promise<SelfCreatedAgent | null> {
  return runQuery<SelfCreatedAgent>(TABLE + '.approveAgent', (db) => {
    const ts = nowIso();
    const result = db
      .prepare("UPDATE self_created_agents SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?")
      .run(ts, ts, id);
    if (result.changes === 0) return null;
    const row = db.prepare('SELECT * FROM self_created_agents WHERE id = ?').get(id) as SelfCreatedAgentRow;
    return rowToAgent(row);
  });
}

/**
 * Reject an agent proposal: set status to 'deprecated'. There is no `'rejected'` value in the
 * `self_created_agents.status` CHECK constraint (`'proposed' | 'approved' | 'active' |
 * 'deprecated'`) — `'deprecated'` is the closest existing semantic fit for "will not be used."
 * Returns the updated row, or null on failure.
 */
export function rejectAgent(id: string): Promise<SelfCreatedAgent | null> {
  return runQuery<SelfCreatedAgent>(TABLE + '.rejectAgent', (db) => {
    const ts = nowIso();
    const result = db
      .prepare("UPDATE self_created_agents SET status = 'deprecated', updated_at = ? WHERE id = ?")
      .run(ts, id);
    if (result.changes === 0) return null;
    const row = db.prepare('SELECT * FROM self_created_agents WHERE id = ?').get(id) as SelfCreatedAgentRow;
    return rowToAgent(row);
  });
}

/** List all agents, newest first. Returns null on failure. */
export function listAgents(): Promise<SelfCreatedAgent[] | null> {
  return runQuery<SelfCreatedAgent[]>(TABLE + '.listAgents', (db) => {
    const rows = db
      .prepare('SELECT * FROM self_created_agents ORDER BY created_at DESC')
      .all() as SelfCreatedAgentRow[];
    return rows.map(rowToAgent);
  });
}

/** List agents currently active (status = 'active'). Returns null on failure. */
export function getActiveAgents(): Promise<SelfCreatedAgent[] | null> {
  return runQuery<SelfCreatedAgent[]>(TABLE + '.getActiveAgents', (db) => {
    const rows = db
      .prepare("SELECT * FROM self_created_agents WHERE status = 'active' ORDER BY created_at DESC")
      .all() as SelfCreatedAgentRow[];
    return rows.map(rowToAgent);
  });
}
