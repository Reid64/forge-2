/**
 * FORGE 2.0 — Build Memory: design_patterns CRUD.
 *
 * Reusable UI/UX and architectural patterns from successful builds. See
 * SCHEMA_REGISTRY.md › design_patterns.
 */

import type { DesignPattern, DesignPatternType } from '../types/index.js';
import { runQuery } from './client.js';

const TABLE = 'design_patterns';

/** Fields required to record a design pattern (NOT NULL, no DB default). */
export type NewDesignPattern = Pick<
  DesignPattern,
  'pattern_type' | 'name' | 'description' | 'source_project' | 'specification'
> &
  Partial<
    Omit<
      DesignPattern,
      | 'id'
      | 'created_at'
      | 'pattern_type'
      | 'name'
      | 'description'
      | 'source_project'
      | 'specification'
    >
  >;

/** Insert a new design_pattern row. Returns the created row, or null. */
export function createPattern(
  input: NewDesignPattern
): Promise<DesignPattern | null> {
  return runQuery<DesignPattern>('createPattern', async (c) =>
    c.from(TABLE).insert(input).select().single()
  );
}

/**
 * List design patterns, optionally filtered by type, most-used first. Returns
 * null on failure.
 */
export function findPatterns(
  patternType?: DesignPatternType
): Promise<DesignPattern[] | null> {
  return runQuery<DesignPattern[]>('findPatterns', async (c) => {
    const base = c.from(TABLE).select('*');
    const filtered =
      patternType !== undefined ? base.eq('pattern_type', patternType) : base;
    return filtered.order('usage_count', { ascending: false });
  });
}

/**
 * Increment usage_count for a pattern (read-then-write, single-operator/local).
 * Returns the updated row, or null on failure.
 */
export async function incrementUsage(id: string): Promise<DesignPattern | null> {
  const current = await runQuery<DesignPattern>('incrementUsage.read', async (c) =>
    c.from(TABLE).select('*').eq('id', id).maybeSingle()
  );
  if (!current) return null;

  return runQuery<DesignPattern>('incrementUsage.write', async (c) =>
    c
      .from(TABLE)
      .update({ usage_count: current.usage_count + 1 })
      .eq('id', id)
      .select()
      .single()
  );
}
