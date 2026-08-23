import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync, existsSync } from 'node:fs';

import { initializeForgeMemory, getConnection, getMachineId, closeConnection } from '../src/learning/database.js';
import { promoteEligible, PROMOTION_THRESHOLD } from '../src/learning/evolution-promoter.js';
import type { ShadowComparisonResult, ShadowModeCandidate, ShadowModeOptions } from '../src/learning/shadow-mode.js';

/**
 * Tests for the shadow-mode precondition wired into `promoteEligible`
 * (`src/learning/evolution-promoter.ts`). `runShadowComparison` (`src/learning/shadow-mode.ts`)
 * spawns real benchmark subprocesses in production, so — following the same `xImpl` DI convention
 * `tests/executor.test.ts`'s `baseOptions()` and `benchmarks/benchmark-runner.ts` itself already
 * use for expensive collaborators — every test here injects a cheap fake via
 * `promoteEligible`'s `runShadowComparisonImpl` option rather than letting a real benchmark run.
 */

/** Build a fake `runShadowComparison` implementation that always returns `verdict` (`typeof runShadowComparison`-shaped). */
function fakeShadow(
  verdict: Pick<ShadowComparisonResult, 'outperforms' | 'reason'>
): (candidate: ShadowModeCandidate, options?: ShadowModeOptions) => Promise<ShadowComparisonResult> {
  return async (candidate) => ({
    pendingEvolutionId: candidate.pendingEvolutionId,
    evolutionType: candidate.evolutionType,
    existing: null,
    candidate: null,
    scenarioComparisons: [],
    outperforms: verdict.outperforms,
    reason: verdict.reason,
  });
}

describe('EvolutionPromoter — shadow-mode gate', () => {
  const testDb = join(tmpdir(), `forge_evolution_promoter_test_${Date.now()}.db`);

  before(() => { initializeForgeMemory(testDb); });
  after(() => {
    closeConnection(testDb);
    if (existsSync(testDb)) unlinkSync(testDb);
  });

  /** Insert a PENDING, auto-promotable pending_evolutions row (CONFIG type — has a real applyEffect handler). */
  function insertEligibleRow(idSuffix: string): string {
    const db = getConnection(testDb);
    const machineId = getMachineId(testDb);
    const id = `pe-${idSuffix}`;
    db.prepare(
      `INSERT INTO pending_evolutions (
        id, evolution_type, proposed_change, change_detail, evidence, estimated_impact,
        confidence, status, machine_id, created_at
      ) VALUES (?, 'CONFIG', ?, ?, ?, 'minor', ?, 'PENDING', ?, datetime('now'))`
    ).run(
      id,
      `Raise some threshold (${idSuffix})`,
      JSON.stringify({ key: `shadow_test_key_${idSuffix}`, value: 42 }),
      JSON.stringify({ evidence_build_count: 20 }),
      PROMOTION_THRESHOLD + 0.01,
      machineId
    );
    return id;
  }

  it('blocks promotion when shadow-mode reports the candidate as NOT the strict winner, even though confidence clears the bar', async () => {
    const db = getConnection(testDb);
    const id = insertEligibleRow('blocked');

    const results = await promoteEligible(db, {
      runShadowComparisonImpl: fakeShadow({ outperforms: false, reason: 'tie on the benchmark suite — no improvement proven' }),
    });

    // Nothing promoted.
    assert.equal(results.find((r) => r.pendingEvolutionId === id), undefined, 'blocked row must not appear in promotion results');

    // Row is left PENDING — untouched.
    const row = db.prepare('SELECT status, reviewed_at FROM pending_evolutions WHERE id = ?').get(id) as
      | { status: string; reviewed_at: string | null }
      | undefined;
    assert.equal(row?.status, 'PENDING', 'a shadow-mode-blocked row must remain PENDING (eligible for a future attempt or human approval)');
    assert.equal(row?.reviewed_at, null, 'a blocked row must not be marked reviewed');

    // No audit row written for the blocked candidate.
    const promoCount = db.prepare('SELECT COUNT(*) as c FROM evolution_promotions WHERE pending_evolution_id = ?').get(id) as { c: number };
    assert.equal(promoCount.c, 0, 'a blocked row must not get an evolution_promotions audit row');
  });

  it('promotes a candidate that shadow-mode reports as the strict winner, once every other precondition already passes', async () => {
    const db = getConnection(testDb);
    const id = insertEligibleRow('passed');

    const results = await promoteEligible(db, {
      runShadowComparisonImpl: fakeShadow({ outperforms: true, reason: 'strictly outperforms existing strategy: totalCostUsd improved' }),
    });

    const result = results.find((r) => r.pendingEvolutionId === id);
    assert.ok(result, 'a shadow-mode-passed row must be promoted');
    assert.equal(result?.evolutionType, 'CONFIG');

    const row = db.prepare('SELECT status FROM pending_evolutions WHERE id = ?').get(id) as { status: string } | undefined;
    assert.equal(row?.status, 'APPROVED', 'a shadow-mode-passed row must flip to APPROVED');

    const promotion = db.prepare('SELECT id, promotion_method FROM evolution_promotions WHERE pending_evolution_id = ?').get(id) as
      | { id: string; promotion_method: string }
      | undefined;
    assert.ok(promotion, 'a promoted row must get an evolution_promotions audit row');
    assert.equal(promotion?.promotion_method, 'AUTO');
  });

  it('never lets a broken shadow-mode check silently promote (a throwing runShadowComparisonImpl blocks, not passes)', async () => {
    const db = getConnection(testDb);
    const id = insertEligibleRow('errored');

    const results = await promoteEligible(db, {
      runShadowComparisonImpl: async () => {
        throw new Error('simulated benchmark spawn failure');
      },
    });

    assert.equal(results.find((r) => r.pendingEvolutionId === id), undefined, 'a row whose shadow-mode check threw must not be promoted');
    const row = db.prepare('SELECT status FROM pending_evolutions WHERE id = ?').get(id) as { status: string } | undefined;
    assert.equal(row?.status, 'PENDING', 'a row whose shadow-mode check threw must remain PENDING');
  });
});
