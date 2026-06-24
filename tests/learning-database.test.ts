import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync, existsSync } from 'node:fs';
import { initializeForgeMemory, getConnection, getMachineId, closeConnection } from '../src/learning/database.js';

describe('Learning Engine — Database', () => {
  const testDb = join(tmpdir(), `forge_db_test_${Date.now()}.db`);

  after(() => {
    closeConnection(testDb);
    if (existsSync(testDb)) unlinkSync(testDb);
  });

  describe('initializeForgeMemory', () => {
    it('should create all 14 tables', () => {
      initializeForgeMemory(testDb);
      const db = getConnection(testDb);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as any[];
      const tableNames = tables.map((t: any) => t.name);
      assert.ok(tableNames.length >= 14, `Expected 14+ tables, got ${tableNames.length}`);
      assert.ok(tableNames.includes('prompt_scores'), 'Missing prompt_scores table');
      assert.ok(tableNames.includes('fix_patterns'), 'Missing fix_patterns table');
      assert.ok(tableNames.includes('governance_rules'), 'Missing governance_rules table');
      assert.ok(tableNames.includes('build_outcomes'), 'Missing build_outcomes table');
      assert.ok(tableNames.includes('hook_execution_log'), 'Missing hook_execution_log table');
      assert.ok(tableNames.includes('adversary_findings'), 'Missing adversary_findings table');
    });

    it('should be idempotent — calling twice does not error or change table count', () => {
      const db = getConnection(testDb);
      const before = db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'").get() as any;
      initializeForgeMemory(testDb);
      const after = db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'").get() as any;
      assert.equal(before.c, after.c, 'Table count changed after second init');
    });

    it('should create 20+ indexes', () => {
      const db = getConnection(testDb);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all();
      assert.ok(indexes.length >= 20, `Expected 20+ indexes, got ${indexes.length}`);
    });

    it('should set schema_version in forge_meta', () => {
      const db = getConnection(testDb);
      const row = db.prepare("SELECT value FROM forge_meta WHERE key = 'schema_version'").get() as any;
      assert.equal(row.value, '1.0.0');
    });
  });

  describe('getMachineId', () => {
    it('should return a 16-character hex string', () => {
      const id = getMachineId(testDb);
      assert.equal(id.length, 16, `Expected 16 chars, got ${id.length}`);
      assert.match(id, /^[0-9a-f]{16}$/, 'Should be lowercase hex');
    });

    it('should return the same value on repeated calls', () => {
      const id1 = getMachineId(testDb);
      const id2 = getMachineId(testDb);
      assert.equal(id1, id2, 'Machine ID should be consistent');
    });
  });

  describe('getConnection', () => {
    it('should return a working database object', () => {
      const db = getConnection(testDb);
      assert.ok(db, 'Should return a database object');
      const result = db.prepare('SELECT 1 + 1 as sum').get() as any;
      assert.equal(result.sum, 2);
    });

    it('should use WAL journal mode', () => {
      const db = getConnection(testDb);
      const mode = db.pragma('journal_mode', { simple: true }) as string;
      assert.equal(mode, 'wal', 'Should use WAL mode');
    });
  });
});
