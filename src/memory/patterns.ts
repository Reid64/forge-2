/**
 * FORGE 2.0 — Build Memory: design_patterns CRUD.
 *
 * Reusable UI/UX and architectural patterns from successful builds. See
 * src/learning/database.ts › BUILD_MEMORY_SCHEMA_SQL › design_patterns.
 */

import type { DesignPattern, DesignPatternType } from '../types/index.js';
import { fromJsonText, newId, nowIso, runQuery, toJsonText } from './client.js';

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

interface DesignPatternRow {
  id: string;
  pattern_type: string;
  name: string;
  description: string;
  source_project: string;
  specification: string;
  usage_count: number;
  effectiveness_score: number | null;
  created_at: string;
}

function rowToDesignPattern(row: DesignPatternRow): DesignPattern {
  return {
    id: row.id,
    pattern_type: row.pattern_type as DesignPatternType,
    name: row.name,
    description: row.description,
    source_project: row.source_project,
    specification: fromJsonText(row.specification, {}),
    usage_count: row.usage_count,
    effectiveness_score: row.effectiveness_score,
    created_at: row.created_at,
  };
}

/** Insert a new design_pattern row. Returns the created row, or null. */
export function createPattern(
  input: NewDesignPattern
): Promise<DesignPattern | null> {
  return runQuery<DesignPattern>(TABLE + '.createPattern', (db) => {
    const id = newId();
    db.prepare(
      `INSERT INTO design_patterns (
        id, pattern_type, name, description, source_project, specification,
        usage_count, effectiveness_score, created_at
      ) VALUES (
        @id, @pattern_type, @name, @description, @source_project, @specification,
        @usage_count, @effectiveness_score, @created_at
      )`
    ).run({
      id,
      pattern_type: input.pattern_type,
      name: input.name,
      description: input.description,
      source_project: input.source_project,
      specification: toJsonText(input.specification),
      usage_count: input.usage_count ?? 0,
      effectiveness_score: input.effectiveness_score ?? null,
      created_at: nowIso(),
    });
    const row = db.prepare('SELECT * FROM design_patterns WHERE id = ?').get(id) as DesignPatternRow;
    return rowToDesignPattern(row);
  });
}

/**
 * List design patterns, optionally filtered by type, most-used first. Returns
 * null on failure.
 */
export function findPatterns(
  patternType?: DesignPatternType
): Promise<DesignPattern[] | null> {
  return runQuery<DesignPattern[]>(TABLE + '.findPatterns', (db) => {
    const rows = patternType
      ? (db
          .prepare('SELECT * FROM design_patterns WHERE pattern_type = ? ORDER BY usage_count DESC')
          .all(patternType) as DesignPatternRow[])
      : (db.prepare('SELECT * FROM design_patterns ORDER BY usage_count DESC').all() as DesignPatternRow[]);
    return rows.map(rowToDesignPattern);
  });
}

/**
 * Increment usage_count for a pattern (read-then-write, single-operator/local).
 * Returns the updated row, or null on failure.
 */
export async function incrementUsage(id: string): Promise<DesignPattern | null> {
  return runQuery<DesignPattern>(TABLE + '.incrementUsage', (db) => {
    const current = db.prepare('SELECT * FROM design_patterns WHERE id = ?').get(id) as
      | DesignPatternRow
      | undefined;
    if (!current) return null;
    db.prepare('UPDATE design_patterns SET usage_count = ? WHERE id = ?').run(current.usage_count + 1, id);
    const row = db.prepare('SELECT * FROM design_patterns WHERE id = ?').get(id) as DesignPatternRow;
    return rowToDesignPattern(row);
  });
}
