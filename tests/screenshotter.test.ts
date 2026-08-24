/**
 * FORGE 2.0 — Screenshotter tests: `PlaywrightScreenshotter.startDevServer`
 * (`src/design-pipeline/screenshotter.ts`).
 *
 * Regression test for a real bug found running `forge design tournament --use-existing` against
 * a live scratch project with no `package.json`: `startDevServer`'s internal poll-loop `delay()`
 * used an `unref()`'d `setTimeout`. Once the spawned dev-server command (`pnpm dev`) exited almost
 * immediately (the common "no package.json" case), its process handle stopped holding the Node
 * event loop open — and with the poll timer unref'd too, the loop had zero ref'd handles mid-poll,
 * so the WHOLE PROCESS exited right there. The `await delay(...)` inside `startDevServer` never
 * settled, so the caller never saw the intended "dev server exited early" warning or a `null`
 * return — the entire `forge design tournament` run silently died mid-pipeline instead of
 * degrading gracefully (Contract 4 posture this module's own header commits to).
 *
 * Both tests here spawn REAL child processes (`node -e ...`, cross-platform, no `pnpm`
 * dependency) through the real `startDevServer` — no mocking of `child_process` — and assert the
 * promise actually settles (with a real Node.js exit-code check would be needed to catch the
 * original bug at the process level; here we assert the two paths `startDevServer` is documented
 * to take — early child exit, and genuine timeout — both resolve promptly with `null` and log the
 * expected warning, which is what silently broke before the `delay()` fix).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPlaywrightScreenshotter } from '../src/design-pipeline/screenshotter.js';

describe('screenshotter: startDevServer degrades gracefully instead of hanging/dying', () => {
  // A plain file path arg (no inline `-e "..."` code) sidesteps Windows cmd.exe shell-quoting of
  // `()`/`{}` mangling the script — this file just spins forever without ever binding a port.
  let scratchDir: string;
  let neverRespondsScript: string;

  before(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'forge-screenshotter-test-'));
    neverRespondsScript = join(scratchDir, 'never-responds.js');
    writeFileSync(neverRespondsScript, 'setInterval(() => {}, 1000);\n', 'utf8');
  });

  after(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  test('a dev command that exits immediately (e.g. no package.json) resolves promptly with null', async () => {
    const logs: string[] = [];
    const s = createPlaywrightScreenshotter({ log: (m) => logs.push(m) });

    const start = Date.now();
    const port = await s.startDevServer(process.cwd(), {
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      port: 34567,
      startupTimeoutMs: 10_000,
    });
    const elapsedMs = Date.now() - start;

    assert.equal(port, null);
    // The whole point of the fix: this returns as soon as the child's exit is observed (well
    // under the 10s ceiling), not after silently dying or waiting out the full timeout.
    assert.ok(elapsedMs < 8_000, `expected an early-exit detection well under the timeout, got ${elapsedMs}ms`);
    assert.ok(
      logs.some((l) => l.includes('WARNING') && l.includes('dev server exited early')),
      `expected a "dev server exited early" warning, got: ${JSON.stringify(logs)}`
    );
  });

  test('a dev command that never answers HTTP resolves with null once startupTimeoutMs elapses', async () => {
    const logs: string[] = [];
    const s = createPlaywrightScreenshotter({ log: (m) => logs.push(m) });

    const start = Date.now();
    const port = await s.startDevServer(process.cwd(), {
      command: process.execPath,
      args: [neverRespondsScript], // stays alive, never listens on the port
      port: 34568,
      startupTimeoutMs: 2_200, // > 2 poll cycles (DEV_SERVER_POLL_INTERVAL_MS = 1000ms), keeps the test fast
    });
    const elapsedMs = Date.now() - start;

    assert.equal(port, null);
    assert.ok(elapsedMs >= 2_000, `expected the loop to actually wait out the timeout, got ${elapsedMs}ms`);
    assert.ok(
      logs.some((l) => l.includes('WARNING') && l.includes('did not respond within')),
      `expected a "did not respond within" warning, got: ${JSON.stringify(logs)}`
    );

    await s.stopDevServer(); // idempotent cleanup — the never-answering child is killed here
  });
});
