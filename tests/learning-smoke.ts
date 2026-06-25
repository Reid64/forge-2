import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, rmSync } from 'node:fs';
import { initializeForgeMemory, getConnection, closeConnection } from '../src/learning/database.js';
import { onRunStart, onPromptComplete, onRunEnd } from '../src/learning/integration.js';

describe('Learning Engine Smoke Test', () => {
  const testDb = join(tmpdir(), 'forge-smoke-' + Date.now() + '.db');
  const fakePath = tmpdir();
  const fakeBuildId = 'smoke-' + Date.now();

  after(() => { try { closeConnection(testDb); } catch { /* ignore */ } if (existsSync(testDb)) rmSync(testDb, { force: true }); });

  it('initializes database with 14+ tables', () => {
    initializeForgeMemory(testDb);
    const db = getConnection(testDb);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    assert.ok(tables.length >= 14, 'Expected 14+ tables, got ' + tables.length);
    assert.ok(tables.map(t => t.name).includes('prompt_scores'), 'Missing prompt_scores');
  });

  it('onRunStart does not throw', async () => {
    initializeForgeMemory(testDb);
    let threw = false;
    try { await onRunStart(fakePath, fakeBuildId, ['typescript'], 'smoke-test', testDb); } catch { threw = true; }
    assert.ok(!threw, 'onRunStart should not throw');
  });

  it('onPromptComplete records 2 scores', () => {
    initializeForgeMemory(testDb);
    onPromptComplete({ promptId: 'p001', success: true, retryCount: 0, tokensConsumed: 15000, gatePassRate: 1.0, buildId: fakeBuildId, projectName: 'smoke', taskType: 'SCAFFOLD', techStackTags: ['typescript'], templateHash: 'p001' }, testDb);
    onPromptComplete({ promptId: 'p002', success: false, retryCount: 2, tokensConsumed: 30000, gatePassRate: 0.0, errorOutput: 'src/t.ts(1,1): error TS2322: Type string is not assignable to type number', buildId: fakeBuildId, projectName: 'smoke', taskType: 'CRUD', techStackTags: ['typescript'], templateHash: 'p002' }, testDb);
    const db = getConnection(testDb);
    const scores = db.prepare('SELECT * FROM prompt_scores WHERE build_id = ?').all(fakeBuildId) as unknown[];
    assert.equal(scores.length, 2, 'Expected 2 scores, got ' + scores.length);
  });

  it('onRunEnd does not throw', async () => {
    let threw = false;
    try { await onRunEnd(fakeBuildId, fakePath, { promptsExecuted: 2, promptsPassed: 1, promptsFailed: 1, totalTokens: 45000, startTime: new Date().toISOString() }, testDb); } catch { threw = true; }
    assert.ok(!threw, 'onRunEnd should not throw');
  });
});
