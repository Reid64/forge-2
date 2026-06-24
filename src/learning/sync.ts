// FORGE 2.0 Learning Engine — Cross-Machine Sync Protocol
// Append-only sync between local SQLite and master copy on external drive.
// CRITICAL: Lock MUST be released in finally blocks. Never leave orphaned locks.
import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { getConnection } from './database.js';
import { VALID_TABLES, type SyncConfig } from './types.js';

const DEFAULT_SYNC_CONFIG_PATH = join(homedir(), '.forge', 'sync_config.json');
// Exclude forge_meta from sync — it's machine-specific
const SYNCABLE_TABLES = VALID_TABLES.filter(t => t !== 'forge_meta');

// ──── Lock Management ────────────────────────────────────────────────────────

export function acquireSyncLock(
  lockPath: string,
  machineId: string,
  maxWaitMs: number = 30000,
  retryIntervalMs: number = 5000
): boolean {
  const startTime = Date.now();

  while (true) {
    // Check if lock exists
    if (existsSync(lockPath)) {
      try {
        const lockData = JSON.parse(readFileSync(lockPath, 'utf8'));
        const lockAge = Date.now() - new Date(lockData.acquired_at).getTime();
        const staleMs = 2 * 60 * 1000; // 2 minutes

        if (lockAge > staleMs) {
          // Stale lock — remove and acquire
          console.warn(`[FORGE Sync] Removing stale lock (${Math.round(lockAge / 1000)}s old, machine: ${lockData.machine_id})`);
          try { unlinkSync(lockPath); } catch { /* ignore */ }
        } else {
          // Lock is fresh — wait and retry
          const elapsed = Date.now() - startTime;
          if (elapsed >= maxWaitMs) {
            console.warn(`[FORGE Sync] Timed out waiting for lock after ${Math.round(elapsed / 1000)}s`);
            return false;
          }
          // Synchronous sleep
          const sleepUntil = Date.now() + retryIntervalMs;
          while (Date.now() < sleepUntil) { /* busy wait */ }
          continue;
        }
      } catch {
        // Malformed lock file — remove it
        try { unlinkSync(lockPath); } catch { /* ignore */ }
      }
    }

    // Acquire the lock
    try {
      const lockDir = dirname(lockPath);
      if (!existsSync(lockDir)) {
        mkdirSync(lockDir, { recursive: true });
      }
      const lockData = {
        machine_id: machineId,
        acquired_at: new Date().toISOString(),
        pid: process.pid,
      };
      writeFileSync(lockPath, JSON.stringify(lockData, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.error('[FORGE Sync] Failed to write lock file:', err);
      return false;
    }
  }
}

export function releaseSyncLock(lockPath: string): void {
  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  } catch {
    // MUST never throw. If the file is gone, that's fine.
  }
}

// ──── Configuration ──────────────────────────────────────────────────────────

export function loadSyncConfig(configPath?: string): SyncConfig {
  const resolved = configPath || DEFAULT_SYNC_CONFIG_PATH;
  const defaults: SyncConfig = {
    master_path: '',
    lock_file: 'forge_sync.lock',
    max_wait_seconds: 30,
    retry_interval_seconds: 5,
  };

  try {
    if (existsSync(resolved)) {
      const raw = readFileSync(resolved, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...defaults, ...parsed };
    }
  } catch {
    console.warn('[FORGE Sync] Failed to read sync config, using defaults');
  }

  return defaults;
}

// ──── Timestamp Management ───────────────────────────────────────────────────

export function getLastSyncTimestamp(dbPath: string): string {
  try {
    const db = getConnection(dbPath);
    const row = db.prepare(
      "SELECT value FROM forge_meta WHERE key = 'last_sync_timestamp'"
    ).get() as { value: string } | undefined;
    return row?.value || '1970-01-01T00:00:00.000Z';
  } catch {
    return '1970-01-01T00:00:00.000Z';
  }
}

export function setLastSyncTimestamp(dbPath: string, timestamp: string): void {
  try {
    const db = getConnection(dbPath);
    db.prepare(
      "INSERT OR REPLACE INTO forge_meta (key, value) VALUES ('last_sync_timestamp', ?)"
    ).run(timestamp);
  } catch (err) {
    console.error('[FORGE Sync] Failed to set sync timestamp:', err);
  }
}

// ──── Core Sync Protocol ─────────────────────────────────────────────────────

export function syncForgeMemory(
  direction: 'pull' | 'push',
  localDbPath: string,
  masterDbPath: string,
  machineId: string
): { synced: number; tables: string[] } {
  // Graceful degradation: if master doesn't exist, return silently
  if (!masterDbPath || !existsSync(masterDbPath)) {
    if (masterDbPath && masterDbPath !== '') {
      console.warn(`[FORGE Sync] Master DB not found at ${masterDbPath} — skipping sync`);
    }
    return { synced: 0, tables: [] };
  }

  const lastSync = getLastSyncTimestamp(localDbPath);

  if (direction === 'pull') {
    return syncPull(localDbPath, masterDbPath, machineId, lastSync);
  } else {
    return syncPush(localDbPath, masterDbPath, machineId, lastSync);
  }
}

function syncPull(
  localDbPath: string,
  masterDbPath: string,
  machineId: string,
  lastSync: string
): { synced: number; tables: string[] } {
  let totalSynced = 0;
  const syncedTables: string[] = [];

  try {
    // Open master as read-only
    const masterDb = new Database(masterDbPath, { readonly: true });
    const localDb = getConnection(localDbPath);

    for (const table of SYNCABLE_TABLES) {
      try {
        // Get column names for this table from local DB
        const columns = localDb.prepare(`PRAGMA table_info(${table})`).all() as any[];
        if (columns.length === 0) continue;
        const colNames = columns.map((c: any) => c.name);

        // Select records from master that aren't from this machine and are newer than last sync
        const rows = masterDb.prepare(
          `SELECT * FROM ${table} WHERE machine_id != ? AND created_at > ?`
        ).all(machineId, lastSync) as any[];

        if (rows.length === 0) continue;

        // INSERT OR IGNORE each row into local
        const placeholders = colNames.map(() => '?').join(', ');
        const insertStmt = localDb.prepare(
          `INSERT OR IGNORE INTO ${table} (${colNames.join(', ')}) VALUES (${placeholders})`
        );

        const insertMany = localDb.transaction((records: any[]) => {
          let inserted = 0;
          for (const row of records) {
            const values = colNames.map(col => row[col] ?? null);
            const result = insertStmt.run(...values);
            if (result.changes > 0) inserted++;
          }
          return inserted;
        });

        const inserted = insertMany(rows);
        if (inserted > 0) {
          totalSynced += inserted;
          syncedTables.push(table);
        }
      } catch (err) {
        // Log error for this table but continue with others
        console.error(`[FORGE Sync] Pull error on ${table}:`, err);
      }
    }

    masterDb.close();

    // Update sync timestamp
    setLastSyncTimestamp(localDbPath, new Date().toISOString());
  } catch (err) {
    console.error('[FORGE Sync] Pull failed:', err);
  }

  return { synced: totalSynced, tables: syncedTables };
}

function syncPush(
  localDbPath: string,
  masterDbPath: string,
  machineId: string,
  lastSync: string
): { synced: number; tables: string[] } {
  let totalSynced = 0;
  const syncedTables: string[] = [];

  const lockPath = join(dirname(masterDbPath), 'forge_sync.lock');
  const acquired = acquireSyncLock(lockPath, machineId);

  if (!acquired) {
    console.warn('[FORGE Sync] Could not acquire push lock — skipping sync');
    return { synced: 0, tables: [] };
  }

  try {
    const localDb = getConnection(localDbPath);
    const masterDb = new Database(masterDbPath);
    masterDb.pragma('journal_mode = WAL');
    masterDb.pragma('busy_timeout = 5000');

    for (const table of SYNCABLE_TABLES) {
      try {
        const columns = localDb.prepare(`PRAGMA table_info(${table})`).all() as any[];
        if (columns.length === 0) continue;
        const colNames = columns.map((c: any) => c.name);

        // Select records from local that ARE from this machine and are newer
        const rows = localDb.prepare(
          `SELECT * FROM ${table} WHERE machine_id = ? AND created_at > ?`
        ).all(machineId, lastSync) as any[];

        if (rows.length === 0) continue;

        const placeholders = colNames.map(() => '?').join(', ');
        const insertStmt = masterDb.prepare(
          `INSERT OR IGNORE INTO ${table} (${colNames.join(', ')}) VALUES (${placeholders})`
        );

        const insertMany = masterDb.transaction((records: any[]) => {
          let inserted = 0;
          for (const row of records) {
            const values = colNames.map(col => row[col] ?? null);
            const result = insertStmt.run(...values);
            if (result.changes > 0) inserted++;
          }
          return inserted;
        });

        const inserted = insertMany(rows);
        if (inserted > 0) {
          totalSynced += inserted;
          syncedTables.push(table);
        }
      } catch (err) {
        console.error(`[FORGE Sync] Push error on ${table}:`, err);
      }
    }

    masterDb.close();

    // Update sync timestamp on both local and master
    const now = new Date().toISOString();
    setLastSyncTimestamp(localDbPath, now);
  } finally {
    // ALWAYS release lock — even if everything above failed
    releaseSyncLock(lockPath);
  }

  return { synced: totalSynced, tables: syncedTables };
}
