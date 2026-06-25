import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { initializeForgeMemory, getConnection } from '../src/learning/database.js';

describe('Learning Engine Performance', () => {
  const dbPath = join(homedir(), '.forge', 'forge_memory.db');

  it('initializes DB', () => { initializeForgeMemory(dbPath); });

  it('governance_rules query < 1ms average over 1000 runs', () => {
    const db = getConnection(dbPath);
    const stmt = db.prepare('SELECT * FROM governance_rules WHERE active = 1');
    for (let i = 0; i < 10; i++) stmt.all();
    const start = Date.now();
    for (let i = 0; i < 1000; i++) stmt.all();
    const avg = (Date.now() - start) / 1000;
    console.log('governance_rules avg: ' + avg.toFixed(3) + 'ms');
    assert.ok(avg < 1, 'Must be < 1ms, got ' + avg.toFixed(3) + 'ms');
  });

  it('fix_patterns query < 1ms average over 1000 runs', () => {
    const db = getConnection(dbPath);
    const stmt = db.prepare('SELECT * FROM fix_patterns WHERE success_rate > 0.5 ORDER BY occurrence_count DESC LIMIT 10');
    for (let i = 0; i < 10; i++) stmt.all();
    const start = Date.now();
    for (let i = 0; i < 1000; i++) stmt.all();
    const avg = (Date.now() - start) / 1000;
    console.log('fix_patterns avg: ' + avg.toFixed(3) + 'ms');
    assert.ok(avg < 1, 'Must be < 1ms, got ' + avg.toFixed(3) + 'ms');
  });
});
