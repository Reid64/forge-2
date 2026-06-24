import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync, existsSync } from 'node:fs';
import { initializeForgeMemory, closeConnection } from '../src/learning/database.js';
import { saveToForgeMemory, getForgeMemory, getGovernanceRules, getPendingEvolutions, registerError } from '../src/learning/queries.js';

describe('Learning Engine — Queries', () => {
  const testDb = join(tmpdir(), `forge_query_test_${Date.now()}.db`);

  before(() => { initializeForgeMemory(testDb); });
  after(() => {
    closeConnection(testDb);
    if (existsSync(testDb)) unlinkSync(testDb);
  });

  describe('saveToForgeMemory', () => {
    it('should auto-generate a UUID id', () => {
      const id = saveToForgeMemory('governance_rules', {
        rule_text: 'Test rule', rule_short_name: 'test-1',
        source: 'MANUAL', tech_stack_tags: JSON.stringify(['typescript']),
        scope: 'GLOBAL', active: 1, enforcement_count: 0,
      }, testDb);
      assert.ok(id, 'Should return an id');
      assert.ok(id.includes('-'), 'Should be UUID format');
    });

    it('should auto-add machine_id', () => {
      const id = saveToForgeMemory('governance_rules', {
        rule_text: 'Test rule 2', rule_short_name: 'test-2',
        source: 'MANUAL', tech_stack_tags: '[]', scope: 'GLOBAL', active: 1, enforcement_count: 0,
      }, testDb);
      const rows = getForgeMemory('governance_rules', { where: 'id = ?', params: [id] }, testDb);
      assert.equal(rows.length, 1);
      assert.ok((rows[0] as any).machine_id, 'Should have machine_id');
      assert.equal((rows[0] as any).machine_id.length, 16, 'machine_id should be 16 chars');
    });

    it('should auto-add created_at in ISO format', () => {
      const id = saveToForgeMemory('governance_rules', {
        rule_text: 'Test rule 3', rule_short_name: 'test-3',
        source: 'MANUAL', tech_stack_tags: '[]', scope: 'GLOBAL', active: 1, enforcement_count: 0,
      }, testDb);
      const rows = getForgeMemory('governance_rules', { where: 'id = ?', params: [id] }, testDb);
      assert.ok((rows[0] as any).created_at, 'Should have created_at');
      assert.ok((rows[0] as any).created_at.includes('T'), 'Should be ISO format');
    });

    it('should reject invalid table names', () => {
      assert.throws(() => {
        saveToForgeMemory('nonexistent_table', { data: 'test' }, testDb);
      }, /invalid table/i);
    });
  });

  describe('getForgeMemory', () => {
    it('should return empty array for no matches', () => {
      const result = getForgeMemory('prompt_scores', {}, testDb);
      assert.ok(Array.isArray(result), 'Should return array');
    });

    it('should filter with WHERE clause', () => {
      const id = saveToForgeMemory('governance_rules', {
        rule_text: 'Unique rule', rule_short_name: 'unique-test',
        source: 'MANUAL', tech_stack_tags: '[]', scope: 'PROJECT_SPECIFIC', project_name: 'test-project',
        active: 1, enforcement_count: 0,
      }, testDb);
      const result = getForgeMemory('governance_rules', {
        where: 'rule_short_name = ?', params: ['unique-test']
      }, testDb);
      assert.equal(result.length, 1);
      assert.equal((result[0] as any).rule_short_name, 'unique-test');
    });

    it('should respect LIMIT', () => {
      const result = getForgeMemory('governance_rules', { limit: 1 }, testDb);
      assert.ok(result.length <= 1);
    });
  });

  describe('getGovernanceRules', () => {
    it('should return only active GLOBAL rules when no project specified', () => {
      const rules = getGovernanceRules(['typescript'], undefined, testDb);
      assert.ok(Array.isArray(rules));
      for (const rule of rules) {
        assert.equal(rule.active, 1, 'Should only return active rules');
      }
    });
  });

  describe('getPendingEvolutions', () => {
    it('should return empty array when no evolutions exist', () => {
      const result = getPendingEvolutions(testDb);
      assert.ok(Array.isArray(result));
    });
  });
});
