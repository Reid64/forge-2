import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { acquireSyncLock, releaseSyncLock, loadSyncConfig, syncForgeMemory, getLastSyncTimestamp, setLastSyncTimestamp } from '../src/learning/sync.js';
import { initializeForgeMemory, closeConnection } from '../src/learning/database.js';

describe('Learning Engine — Sync', () => {
  const testDir = join(tmpdir(), `forge_sync_test_${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  // The 'timestamps' suite below opens a REAL better-sqlite3 connection via
  // initializeForgeMemory(localDb) — src/learning/database.ts caches it (WAL mode) in a
  // module-level Map and never closes it on its own. On Windows, NTFS keeps that file (and its
  // -wal/-shm siblings) locked for as long as the handle is open, so rmSync'ing testDir here
  // used to fail with EBUSY (POSIX allows unlinking open files; Windows does not). Fix: close
  // the connection explicitly before removing the directory that contains it.
  after(() => {
    closeConnection(join(testDir, 'ts_test.db'));
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('acquireSyncLock', () => {
    it('should create a lock file', () => {
      const lockPath = join(testDir, 'test1.lock');
      const acquired = acquireSyncLock(lockPath, 'test-machine', 5000, 1000);
      assert.ok(acquired, 'Should acquire lock');
      assert.ok(existsSync(lockPath), 'Lock file should exist');
      releaseSyncLock(lockPath);
    });

    it('should write valid JSON with machine_id and pid', () => {
      const lockPath = join(testDir, 'test2.lock');
      acquireSyncLock(lockPath, 'my-machine', 5000, 1000);
      const data = JSON.parse(readFileSync(lockPath, 'utf8'));
      assert.equal(data.machine_id, 'my-machine');
      assert.ok(data.pid, 'Should have pid');
      assert.ok(data.acquired_at, 'Should have timestamp');
      releaseSyncLock(lockPath);
    });
  });

  describe('releaseSyncLock', () => {
    it('should remove the lock file', () => {
      const lockPath = join(testDir, 'test3.lock');
      acquireSyncLock(lockPath, 'test', 5000, 1000);
      releaseSyncLock(lockPath);
      assert.ok(!existsSync(lockPath), 'Lock should be removed');
    });

    it('should not throw on nonexistent file', () => {
      assert.doesNotThrow(() => {
        releaseSyncLock(join(testDir, 'does-not-exist.lock'));
      });
    });
  });

  describe('loadSyncConfig', () => {
    it('should return defaults when config file does not exist', () => {
      const config = loadSyncConfig(join(testDir, 'nonexistent.json'));
      assert.equal(config.max_wait_seconds, 30);
      assert.equal(config.retry_interval_seconds, 5);
      assert.equal(config.lock_file, 'forge_sync.lock');
    });
  });

  describe('syncForgeMemory', () => {
    it('should return synced: 0 when master path does not exist', () => {
      const result = syncForgeMemory('pull', join(testDir, 'local.db'), '/nonexistent/master.db', 'test');
      assert.equal(result.synced, 0);
      assert.deepEqual(result.tables, []);
    });
  });

  describe('timestamps', () => {
    it('should read default epoch when no timestamp set', () => {
      const localDb = join(testDir, 'ts_test.db');
      initializeForgeMemory(localDb);
      const ts = getLastSyncTimestamp(localDb);
      assert.ok(ts.includes('1970'), 'Default should be epoch');
    });

    it('should set and read custom timestamp', () => {
      const localDb = join(testDir, 'ts_test.db');
      setLastSyncTimestamp(localDb, '2026-06-23T12:00:00.000Z');
      const ts = getLastSyncTimestamp(localDb);
      assert.ok(ts.includes('2026'), 'Should return set timestamp');
    });
  });
});
