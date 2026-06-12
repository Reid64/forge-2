/**
 * FORGE 2.0 — Build Memory: self_created_agents CRUD.
 *
 * Agents FORGE creates for itself through recursive learning. See
 * SCHEMA_REGISTRY.md › self_created_agents and BEHAVIORAL_CONTRACTS.md Contract 17.
 * New agents start as 'proposed' and require human approval before activation.
 */

import type { SelfCreatedAgent } from '../types/index.js';
import { nowIso, runQuery } from './client.js';

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

/** Insert a new self_created_agent (status defaults to 'proposed'). Returns row or null. */
export function createAgent(
  input: NewSelfCreatedAgent
): Promise<SelfCreatedAgent | null> {
  return runQuery<SelfCreatedAgent>('createAgent', async (c) =>
    c.from(TABLE).insert(input).select().single()
  );
}

/**
 * Approve an agent: set status to 'approved' and stamp approved_at. Returns the
 * updated row, or null on failure.
 */
export function approveAgent(id: string): Promise<SelfCreatedAgent | null> {
  return runQuery<SelfCreatedAgent>('approveAgent', async (c) =>
    c
      .from(TABLE)
      .update({ status: 'approved', approved_at: nowIso(), updated_at: nowIso() })
      .eq('id', id)
      .select()
      .single()
  );
}

/** List all agents, newest first. Returns null on failure. */
export function listAgents(): Promise<SelfCreatedAgent[] | null> {
  return runQuery<SelfCreatedAgent[]>('listAgents', async (c) =>
    c.from(TABLE).select('*').order('created_at', { ascending: false })
  );
}

/** List agents currently active (status = 'active'). Returns null on failure. */
export function getActiveAgents(): Promise<SelfCreatedAgent[] | null> {
  return runQuery<SelfCreatedAgent[]>('getActiveAgents', async (c) =>
    c.from(TABLE).select('*').eq('status', 'active').order('created_at', {
      ascending: false,
    })
  );
}
