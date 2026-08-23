import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync, existsSync } from 'node:fs';
import { initializeForgeMemory, getConnection, getMachineId, closeConnection, CURRENT_SCHEMA_VERSION } from '../src/learning/database.js';

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

    it('should set schema_version in forge_meta to the current migrated version', () => {
      const db = getConnection(testDb);
      const row = db.prepare("SELECT value FROM forge_meta WHERE key = 'schema_version'").get() as any;
      // Asserted against the exported constant (not a hardcoded literal) so this test stays
      // correct as the schema evolves — it was hardcoded to the pre-migration '1.0.0' default
      // and broke the moment initializeForgeMemory started migrating fresh dbs forward.
      assert.equal(row.value, CURRENT_SCHEMA_VERSION);
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

  describe('test_run_results CHECK-constraint migration (IAC/SBOM/LICENSE, schema 3.4.0)', () => {
    const migTestDb = join(tmpdir(), `forge_db_migration_test_${Date.now()}.db`);

    after(() => {
      closeConnection(migTestDb);
      if (existsSync(migTestDb)) unlinkSync(migTestDb);
    });

    it('rebuilds an old-shape test_run_results table in place, preserves existing rows, and accepts IAC/SBOM/LICENSE afterward', () => {
      // 1. Build a fresh db at the current (already-migrated) schema.
      initializeForgeMemory(migTestDb);
      const db = getConnection(migTestDb);

      // 2. Degrade test_run_results back to its pre-3.4.0 shape (the old 19-value CHECK, no
      //    IAC/SBOM/LICENSE) to simulate an existing user's on-disk db from before this change,
      //    then seed it with a real row — the exact scenario CURRENT_SCHEMA_VERSION's migration
      //    guard must handle without losing data.
      db.exec(`
        CREATE TABLE test_run_results_old_shape (
          id                    TEXT PRIMARY KEY,
          build_run_id          TEXT,
          project_name          TEXT NOT NULL,
          trigger               TEXT NOT NULL CHECK(trigger IN ('POST_PROMPT','SCHEDULED','MANUAL','PRE_DEPLOY','CI')),
          test_suite            TEXT NOT NULL CHECK(test_suite IN ('UNIT','INTEGRATION','API','E2E','VISUAL_REGRESSION','PERFORMANCE','LOAD','STRESS','SOAK','SECURITY','ACCESSIBILITY','CHAOS','DISASTER_RECOVERY','BACKUP_RESTORE','DEPENDENCY_SCAN','STATIC_ANALYSIS','DYNAMIC_ANALYSIS','CROSS_BROWSER','CROSS_DEVICE')),
          runner                TEXT NOT NULL DEFAULT 'vitest',
          status                TEXT NOT NULL CHECK(status IN ('running','passed','failed','partial','skipped','error')),
          prompt_index          INTEGER,
          tests_total           INTEGER NOT NULL DEFAULT 0,
          tests_passed          INTEGER NOT NULL DEFAULT 0,
          tests_failed          INTEGER NOT NULL DEFAULT 0,
          tests_skipped         INTEGER NOT NULL DEFAULT 0,
          duration_ms           INTEGER NOT NULL DEFAULT 0,
          failure_summary       TEXT,
          report_path           TEXT,
          exit_code             INTEGER,
          started_at            TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at          TEXT,
          machine_id            TEXT NOT NULL,
          created_at            TEXT NOT NULL DEFAULT (datetime('now'))
        );
        DROP TABLE test_run_results;
        ALTER TABLE test_run_results_old_shape RENAME TO test_run_results;
      `);
      db.prepare(
        `INSERT INTO test_run_results (id, project_name, trigger, test_suite, status, machine_id)
         VALUES ('preexisting-row', 'demo-project', 'MANUAL', 'UNIT', 'passed', 'test-machine-id')`
      ).run();
      db.prepare("UPDATE forge_meta SET value = '3.3.0' WHERE key = 'schema_version'").run();

      // 3. Re-run initializeForgeMemory — it must detect the old-shape CHECK, rebuild the table,
      //    and carry the pre-existing row across unchanged.
      initializeForgeMemory(migTestDb);

      const preserved = db.prepare("SELECT * FROM test_run_results WHERE id = 'preexisting-row'").get() as
        | { test_suite: string; status: string }
        | undefined;
      assert.ok(preserved, 'pre-existing row should survive the CHECK-constraint rebuild');
      assert.equal(preserved!.test_suite, 'UNIT');
      assert.equal(preserved!.status, 'passed');

      // 4. The new values must now be insertable where they previously would have violated the CHECK.
      assert.doesNotThrow(() => {
        db.prepare(
          `INSERT INTO test_run_results (id, project_name, trigger, test_suite, status, machine_id)
           VALUES ('iac-row', 'demo-project', 'MANUAL', 'IAC', 'passed', 'test-machine-id')`
        ).run();
        db.prepare(
          `INSERT INTO test_run_results (id, project_name, trigger, test_suite, status, machine_id)
           VALUES ('sbom-row', 'demo-project', 'MANUAL', 'SBOM', 'passed', 'test-machine-id')`
        ).run();
        db.prepare(
          `INSERT INTO test_run_results (id, project_name, trigger, test_suite, status, machine_id)
           VALUES ('license-row', 'demo-project', 'MANUAL', 'LICENSE', 'passed', 'test-machine-id')`
        ).run();
      }, 'IAC/SBOM/LICENSE should be accepted by the rebuilt CHECK constraint');

      const schemaVersion = db.prepare("SELECT value FROM forge_meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      assert.equal(schemaVersion.value, CURRENT_SCHEMA_VERSION);
    });

    it('is a no-op on a db that already has the new-shape table (idempotent across repeated init calls)', () => {
      assert.doesNotThrow(() => initializeForgeMemory(migTestDb));
      const db = getConnection(migTestDb);
      const count = db.prepare('SELECT COUNT(*) as c FROM test_run_results').get() as { c: number };
      assert.ok(count.c >= 4, 'rows inserted in the previous test should still be present');
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
