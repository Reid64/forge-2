/**
 * FORGE 2.0 — `forge dashboard` unit test.
 *
 * Pure `node:test` suite covering the jsonl-parsing / state-computation / rendering logic in
 * `src/cli/dashboard-command.ts` as pure functions — NOT the live terminal poll loop itself
 * (`runDashboard`), which is a thin, effectively untestable `setInterval` + `process.on('SIGINT')`
 * wrapper around these. Uses real temp directories on disk (the module's contract is "read these
 * files"), never a live build.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/dashboard-command.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findLatestRunDir, computeDashboardState, renderDashboard, type DashboardState } from '../src/cli/dashboard-command.js';

function makeTmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'forge-dashboard-test-'));
}

test('findLatestRunDir returns null when .forge/runs does not exist', () => {
  const project = makeTmpProject();
  try {
    assert.equal(findLatestRunDir(project), null);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('findLatestRunDir returns null when .forge/runs exists but is empty', () => {
  const project = makeTmpProject();
  try {
    mkdirSync(join(project, '.forge', 'runs'), { recursive: true });
    assert.equal(findLatestRunDir(project), null);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('findLatestRunDir picks the run dir with the most recently modified telemetry file', () => {
  const project = makeTmpProject();
  try {
    const older = join(project, '.forge', 'runs', 'run-older');
    const newer = join(project, '.forge', 'runs', 'run-newer');
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(older, 'events.jsonl'), '{"ts":"x"}\n');
    writeFileSync(join(newer, 'events.jsonl'), '{"ts":"x"}\n');

    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    utimesSync(join(older, 'events.jsonl'), past, past);
    utimesSync(join(newer, 'events.jsonl'), now, now);

    assert.equal(findLatestRunDir(project), newer);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('computeDashboardState: current prompt is the last started prompt with no matching end', () => {
  const project = makeTmpProject();
  const runDir = join(project, '.forge', 'runs', 'run-1');
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'prompts.jsonl'),
      [
        JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', event: 'start', index: 1, id: 'p1', name: 'First', promptType: 'feature' }),
        JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', event: 'gate', index: 1, id: 'p1', checkName: 'typescript-guard', passed: true, skipped: false, detail: null }),
        JSON.stringify({ ts: '2026-01-01T00:00:02.000Z', event: 'gate', index: 1, id: 'p1', checkName: 'lint', passed: false, skipped: false, detail: '2 errors' }),
        JSON.stringify({ ts: '2026-01-01T00:00:03.000Z', event: 'end', index: 1, id: 'p1', name: 'First', disposition: 'completed', durationMs: 5000, commitHash: 'abc', failedCheck: null }),
        JSON.stringify({ ts: '2026-01-01T00:00:04.000Z', event: 'start', index: 2, id: 'p2', name: 'Second', promptType: 'feature' }),
      ].join('\n') + '\n'
    );
    writeFileSync(join(runDir, 'events.jsonl'), '');
    writeFileSync(join(runDir, 'tests.jsonl'), '');

    const state = computeDashboardState(runDir, project);
    assert.equal(state.currentPrompt?.id, 'p2');
    assert.equal(state.recentResults.length, 1);
    assert.equal(state.recentResults[0]?.id, 'p1');
    assert.equal(state.recentResults[0]?.disposition, 'completed');
    // Gate checks are scoped to the CURRENT prompt (p2, which has none), not the completed p1.
    assert.equal(state.gateChecks.length, 0);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('computeDashboardState: gate checks are attributed to the completed prompt once every prompt has ended', () => {
  const project = makeTmpProject();
  const runDir = join(project, '.forge', 'runs', 'run-2');
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'prompts.jsonl'),
      [
        JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', event: 'start', index: 1, id: 'p1', name: 'Only prompt', promptType: 'feature' }),
        JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', event: 'gate', index: 1, id: 'p1', checkName: 'typescript-guard', passed: true, skipped: false, detail: null }),
        JSON.stringify({ ts: '2026-01-01T00:00:02.000Z', event: 'end', index: 1, id: 'p1', name: 'Only prompt', disposition: 'failed', durationMs: 3000, commitHash: null, failedCheck: 'lint' }),
      ].join('\n') + '\n'
    );
    writeFileSync(join(runDir, 'events.jsonl'), '');
    writeFileSync(join(runDir, 'tests.jsonl'), '');

    const state = computeDashboardState(runDir, project);
    assert.equal(state.currentPrompt?.id, 'p1');
    assert.equal(state.gateChecks.length, 1);
    assert.equal(state.gateChecks[0]?.checkName, 'typescript-guard');
    assert.equal(state.gateChecks[0]?.passed, true);
    assert.equal(state.recentResults[0]?.disposition, 'failed');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('computeDashboardState: aggregates tests.jsonl pass/fail/skip counts across rows', () => {
  const project = makeTmpProject();
  const runDir = join(project, '.forge', 'runs', 'run-3');
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'prompts.jsonl'), '');
    writeFileSync(join(runDir, 'events.jsonl'), '');
    writeFileSync(
      join(runDir, 'tests.jsonl'),
      [
        JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', id: 't1', runnerType: 'vitest', testSuite: 'a', status: 'passed', passed: 3, failed: 0, skipped: 1, durationMs: 100, promptId: 'p1' }),
        JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', id: 't2', runnerType: 'vitest', testSuite: 'b', status: 'failed', passed: 1, failed: 2, skipped: 0, durationMs: 200, promptId: 'p1' }),
      ].join('\n') + '\n'
    );

    const state = computeDashboardState(runDir, project);
    assert.deepEqual(state.totalTests, { passed: 4, failed: 2, skipped: 1 });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('computeDashboardState: a partially-written trailing jsonl line is skipped, not thrown', () => {
  const project = makeTmpProject();
  const runDir = join(project, '.forge', 'runs', 'run-4');
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'events.jsonl'),
      '{"ts":"2026-01-01T00:00:00.000Z","level":"INFO","message":"ok"}\n{"ts":"2026-01-01T00:00:01.000Z","level":"INFO","mess'
    );
    writeFileSync(join(runDir, 'prompts.jsonl'), '');
    writeFileSync(join(runDir, 'tests.jsonl'), '');

    assert.doesNotThrow(() => computeDashboardState(runDir, project));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('renderDashboard: shows current prompt, PASS/FAIL chips, cost and tests', () => {
  const state: DashboardState = {
    runId: 'run-xyz',
    runDir: '/tmp/run-xyz',
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    lastActivityAt: new Date().toISOString(),
    currentPrompt: { index: 2, id: 'p2', name: 'Second prompt', promptType: 'feature' },
    gateChecks: [
      { checkName: 'typescript-guard', passed: true, skipped: false, detail: null },
      { checkName: 'lint', passed: false, skipped: false, detail: '2 errors' },
    ],
    recentResults: [{ index: 1, id: 'p1', name: 'First', disposition: 'completed', durationMs: 5000 }],
    totalTests: { passed: 4, failed: 1, skipped: 0 },
    costUsd: 1.2345,
    tokensEstimated: 42000,
  };

  const rendered = renderDashboard(state);
  assert.match(rendered, /run-xyz/);
  assert.match(rendered, /#2 'p2'/);
  assert.match(rendered, /PASS/); // typescript-guard gate + p1 recent result
  assert.match(rendered, /FAIL/); // lint gate
  assert.match(rendered, /\$1\.2345/);
  assert.match(rendered, /~42000/);
  assert.match(rendered, /4 passed, 1 failed, 0 skipped/);
});

test('renderDashboard: handles the empty/no-prompts-yet state without throwing', () => {
  const state: DashboardState = {
    runId: 'run-empty',
    runDir: '/tmp/run-empty',
    startedAt: null,
    lastActivityAt: null,
    currentPrompt: null,
    gateChecks: [],
    recentResults: [],
    totalTests: { passed: 0, failed: 0, skipped: 0 },
    costUsd: null,
    tokensEstimated: null,
  };

  const rendered = renderDashboard(state);
  assert.match(rendered, /no prompts recorded yet/);
  assert.match(rendered, /\$0\.0000/);
});
