/**
 * FORGE 2.0 — scratch-lock + promote_scratch concurrent-collision integration test.
 *
 * Reproduces two concurrent Build Agent invocations ("session A" / "session B") writing to the
 * SAME `shared_canonical` path — the exact race `src/engine/scratch-lock.ts` (993aac5 / fadc2c2)
 * and `src/engine/scratch-promote.ts` exist to prevent. Every operation below is REAL:
 *   - a real temp directory, `git init`-ed with a real bare "origin" remote (so `promoteScratchFiles`'s
 *     unconditional `git pull` pre-flight has something real to pull against, and its `git push`
 *     after a successful promotion has somewhere real to land);
 *   - real `fs` reads/writes for every scratch file, lock file, and canonical file;
 *   - the real `acquireScratchLock` / `releaseScratchLock` (`src/engine/scratch-lock.ts`) and the
 *     real `promoteScratchFiles` gate (`src/engine/scratch-promote.ts`), driven through a real
 *     `GitManager` bound to the fixture's working directory — nothing here is mocked.
 *
 * Uses `STATE_OF_THE_BUILD.md` as the shared_canonical test path: it is both in
 * `path-classifier.ts`'s `DEFAULT_SHARED_CANONICAL_GLOBS` (so `classifyPath` needs no extra
 * governance/config wiring) AND in `scratch-promote.ts`'s `UNAMBIGUOUS_TOP_LEVEL_CANONICAL_FILES`
 * (so `promoteScratchFiles` can infer its canonical destination from the scratch basename alone,
 * with no `canonicalMapping` needed).
 *
 * HOW TO RUN
 *     node --import tsx --test tests/integration/scratch-promote-collision.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { acquireScratchLock, releaseScratchLock, scratchLockPath } from '../../src/engine/scratch-lock.js';
import { promoteScratchFiles } from '../../src/engine/scratch-promote.js';
import { classifyPath, scratchPathFor } from '../../src/engine/path-classifier.js';
import { GitManager } from '../../src/engine/git-manager.js';

// ---------------------------------------------------------------------------
// Fixture: a real temp git project + a real bare "origin" remote.
// ---------------------------------------------------------------------------

/** The shared_canonical path every scenario below races on. */
const CANONICAL_PATH = 'STATE_OF_THE_BUILD.md';

interface Fixture {
  /** The scratch dir root (`origin.git` + `project` live under here) — removed wholesale on cleanup. */
  root: string;
  /** The working directory every git/scratch/lock/promote operation targets. */
  projectDir: string;
}

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * Build a real fixture project: a bare `origin.git` remote plus a working clone-equivalent with
 * tracking already established (`git push -u origin main`), so `promoteScratchFiles`'s `git pull`
 * pre-flight succeeds trivially (nothing new upstream) rather than failing with "no tracking
 * information" on a repo that never talked to a remote.
 *
 * `initialCanonicalContent` — pass a string to seed `STATE_OF_THE_BUILD.md` with known content
 * before the first commit, or `null` to leave the canonical path absent (the two `promote_scratch`
 * scenarios below use `null`: the real-world trigger for this feature is most sharply reproduced by
 * two sessions racing to CREATE a governance doc neither has seen yet, per `scratch-lock.ts`'s own
 * module doc — "Two FORGE sessions... may both pick up a prompt that declares a shared_canonical
 * output... at roughly the same time").
 */
function createFixture(initialCanonicalContent: string | null): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'forge-scratch-promote-'));
  const bareDir = join(root, 'origin.git');
  const projectDir = join(root, 'project');

  mkdirSync(bareDir, { recursive: true });
  runGit(bareDir, ['init', '--bare', '-b', 'main']);

  mkdirSync(projectDir, { recursive: true });
  runGit(projectDir, ['init', '-b', 'main']);
  runGit(projectDir, ['config', 'user.email', 'forge-test@example.com']);
  runGit(projectDir, ['config', 'user.name', 'Forge Scratch Test']);
  runGit(projectDir, ['remote', 'add', 'origin', bareDir]);

  writeFileSync(join(projectDir, 'README.md'), '# fixture project\n');
  if (initialCanonicalContent !== null) {
    writeFileSync(join(projectDir, CANONICAL_PATH), initialCanonicalContent);
  }
  runGit(projectDir, ['add', '-A']);
  runGit(projectDir, ['commit', '-m', 'chore: initial fixture commit']);
  runGit(projectDir, ['push', '-u', 'origin', 'main']);

  return { root, projectDir };
}

function cleanup(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

async function withFixture<T>(initialCanonicalContent: string | null, fn: (fixture: Fixture) => Promise<T>): Promise<T> {
  const fixture = createFixture(initialCanonicalContent);
  try {
    return await fn(fixture);
  } finally {
    cleanup(fixture);
  }
}

// ===========================================================================
// Sanity: STATE_OF_THE_BUILD.md really is shared_canonical per path-classifier.ts.
// ===========================================================================

test('sanity: STATE_OF_THE_BUILD.md classifies as shared_canonical (DEFAULT_SHARED_CANONICAL_GLOBS)', () => {
  assert.equal(classifyPath(CANONICAL_PATH), 'shared_canonical');
});

// ===========================================================================
// (a) Lock respect: the second concurrent Build Agent invocation cannot acquire the scratch
//     lock while the first holds it, and only proceeds once it is released.
// ===========================================================================

test('acquireScratchLock: two concurrent Build Agent sessions racing the same canonical path — second is blocked, never double-holds', async () => {
  await withFixture('# STATE OF THE BUILD\n\nBaseline v0.\n', async (fixture) => {
    const sessionA = { queueId: 'queue-session-a', promptId: 'build-agent-a' };
    const sessionB = { queueId: 'queue-session-b', promptId: 'build-agent-b' };

    // Session A acquires first — real atomic wx-create lock file on real disk.
    const lockA = await acquireScratchLock({
      projectPath: fixture.projectDir,
      canonicalPath: CANONICAL_PATH,
      queueId: sessionA.queueId,
      promptId: sessionA.promptId,
    });
    assert.equal(lockA.acquired, true);
    assert.equal(lockA.reclaimedStale, false);

    const lockFilePath = scratchLockPath(fixture.projectDir, CANONICAL_PATH);
    assert.ok(existsSync(lockFilePath), 'lock file must really exist on disk');
    const heldBy = JSON.parse(readFileSync(lockFilePath, 'utf8')) as { queue_id: string; prompt_id: string };
    assert.equal(heldBy.queue_id, sessionA.queueId);
    assert.equal(heldBy.prompt_id, sessionA.promptId);

    // Session B races in while A still holds it — short wait/poll so the test doesn't hang;
    // the lock is fresh (just acquired), so B must give up rather than reclaim it as stale.
    const lockB = await acquireScratchLock({
      projectPath: fixture.projectDir,
      canonicalPath: CANONICAL_PATH,
      queueId: sessionB.queueId,
      promptId: sessionB.promptId,
      maxWaitMs: 120,
      pollIntervalMs: 20,
    });
    assert.equal(lockB.acquired, false);
    assert.ok(lockB.reason?.includes(sessionA.promptId), `reason should name the holder — got: ${lockB.reason}`);

    // The lock file on disk still reflects session A — B never clobbered it (no lost-update).
    const stillHeldBy = JSON.parse(readFileSync(lockFilePath, 'utf8')) as { queue_id: string; prompt_id: string };
    assert.equal(stillHeldBy.queue_id, sessionA.queueId);

    // Once A releases, B can now acquire.
    releaseScratchLock(fixture.projectDir, CANONICAL_PATH);
    assert.equal(existsSync(lockFilePath), false);

    const lockB2 = await acquireScratchLock({
      projectPath: fixture.projectDir,
      canonicalPath: CANONICAL_PATH,
      queueId: sessionB.queueId,
      promptId: sessionB.promptId,
    });
    assert.equal(lockB2.acquired, true);
    releaseScratchLock(fixture.projectDir, CANONICAL_PATH);
  });
});

test('acquireScratchLock: genuinely simultaneous acquisition attempts never both succeed (atomic wx-create)', async () => {
  await withFixture(null, async (fixture) => {
    const paramsFor = (promptId: string) => ({
      projectPath: fixture.projectDir,
      canonicalPath: CANONICAL_PATH,
      queueId: 'queue-race',
      promptId,
      maxWaitMs: 100,
      pollIntervalMs: 15,
    });

    // Both invocations are issued in the same tick (Promise.all) — the underlying primitive
    // (fs.writeFileSync with flag: 'wx') is what actually enforces mutual exclusion; this proves
    // the real filesystem call, not test sequencing, is what prevents a double-acquire.
    const [resultA, resultB] = await Promise.all([
      acquireScratchLock(paramsFor('agent-x')),
      acquireScratchLock(paramsFor('agent-y')),
    ]);

    const acquiredCount = [resultA.acquired, resultB.acquired].filter(Boolean).length;
    assert.equal(acquiredCount, 1, 'exactly one of the two simultaneous attempts must win the lock');

    releaseScratchLock(fixture.projectDir, CANONICAL_PATH);
  });
});

// ===========================================================================
// (b) Distinct scratch writes: each session's scratch copy lands at its own location and
//     neither clobbers the other's — and the canonical file itself is never touched directly.
// ===========================================================================

test('scratch writes: two sessions redirected to distinct scratch paths, neither clobbers the other or the canonical file', () => {
  const runTimestamp = '20260822120000';
  const sessionA = { queueId: 'queue-session-a', promptId: 'build-agent-a', content: '# STATE OF THE BUILD\n\nAgent A wrote this.\n' };
  const sessionB = { queueId: 'queue-session-b', promptId: 'build-agent-b', content: '# STATE OF THE BUILD\n\nAgent B wrote this — different!\n' };

  const scratchPathA = scratchPathFor(sessionA.queueId, sessionA.promptId, runTimestamp, CANONICAL_PATH);
  const scratchPathB = scratchPathFor(sessionB.queueId, sessionB.promptId, runTimestamp, CANONICAL_PATH);
  assert.notEqual(scratchPathA, scratchPathB, 'each session must redirect to its own scratch path');

  const fixture = createFixture('# STATE OF THE BUILD\n\nBaseline v0.\n');
  try {
    const absA = join(fixture.projectDir, scratchPathA);
    const absB = join(fixture.projectDir, scratchPathB);

    // Real Build Agent scratch writes — real mkdir + real fs.writeFileSync, one per session.
    mkdirSync(dirname(absA), { recursive: true });
    writeFileSync(absA, sessionA.content);
    mkdirSync(dirname(absB), { recursive: true });
    writeFileSync(absB, sessionB.content);

    // Each scratch copy still holds exactly what its own session wrote — no clobbering.
    assert.equal(readFileSync(absA, 'utf8'), sessionA.content);
    assert.equal(readFileSync(absB, 'utf8'), sessionB.content);

    // Neither scratch write touched the real canonical path directly (that's the whole point of
    // the redirect) — it still holds its original baseline content, untouched.
    const canonicalAbs = join(fixture.projectDir, CANONICAL_PATH);
    assert.equal(readFileSync(canonicalAbs, 'utf8'), '# STATE OF THE BUILD\n\nBaseline v0.\n');
  } finally {
    cleanup(fixture);
  }
});

// ===========================================================================
// (c) Escalation on differing content: two sessions' independently-produced final content for the
//     shared_canonical file genuinely differs → promotion escalates to _pending-review rather than
//     silently picking one.
// ===========================================================================

test('promote_scratch: two sessions with genuinely different final content escalate to _pending-review', async () => {
  // Canonical absent at the start — the sharpest real reproduction of the race this feature exists
  // to prevent: two sessions concurrently creating the SAME governance doc for the first time.
  await withFixture(null, async (fixture) => {
    const runTimestamp = '20260822120000';
    const queueId = 'queue-race';
    const sessionA = { promptId: 'agent-a', content: '# STATE OF THE BUILD\n\nAgent A: shipped the auth module.\n' };
    const sessionB = { promptId: 'agent-b', content: '# STATE OF THE BUILD\n\nAgent B: shipped the billing module.\n' };
    assert.notEqual(sessionA.content, sessionB.content, 'the two sessions must genuinely diverge for this scenario');

    const scratchPathA = scratchPathFor(queueId, sessionA.promptId, runTimestamp, CANONICAL_PATH);
    const scratchPathB = scratchPathFor(queueId, sessionB.promptId, runTimestamp, CANONICAL_PATH);
    mkdirSync(dirname(join(fixture.projectDir, scratchPathA)), { recursive: true });
    writeFileSync(join(fixture.projectDir, scratchPathA), sessionA.content);
    mkdirSync(dirname(join(fixture.projectDir, scratchPathB)), { recursive: true });
    writeFileSync(join(fixture.projectDir, scratchPathB), sessionB.content);

    const git = new GitManager({ cwd: fixture.projectDir, log: () => {} });

    // Session A promotes first — canonical doesn't exist yet → direct copy + commit + push.
    const resultA = await promoteScratchFiles({
      projectPath: fixture.projectDir,
      git,
      scratchGlob: `docs/_forge-scratch/${queueId}/${sessionA.promptId}/**`,
      queueId,
      promptId: sessionA.promptId,
    });
    assert.equal(resultA.success, true);
    assert.equal(resultA.pulled, true);
    assert.equal(resultA.conflicts.length, 0);
    assert.equal(resultA.promoted.length, 1);
    assert.equal(resultA.promoted[0]?.canonicalPath, CANONICAL_PATH);
    assert.equal(resultA.promoted[0]?.wasNewFile, true);

    const canonicalAbs = join(fixture.projectDir, CANONICAL_PATH);
    assert.equal(readFileSync(canonicalAbs, 'utf8'), sessionA.content);
    assert.equal(existsSync(join(fixture.projectDir, scratchPathA)), false, 'promoted scratch file is removed');

    // A real commit landed (never `git add -A` — a single targeted path commit per scratch-promote.ts's contract).
    const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: fixture.projectDir, encoding: 'utf8' });
    assert.match(log, /promote STATE_OF_THE_BUILD\.md/);

    // Session B promotes second — its scratch content DIFFERS from what A already promoted onto
    // the canonical path. No auto-merge: this must escalate, not silently overwrite A's version.
    const resultB = await promoteScratchFiles({
      projectPath: fixture.projectDir,
      git,
      scratchGlob: `docs/_forge-scratch/${queueId}/${sessionB.promptId}/**`,
      queueId,
      promptId: sessionB.promptId,
    });
    assert.equal(resultB.success, false);
    assert.equal(resultB.conflicts.length, 1);
    assert.equal(resultB.promoted.length, 0);
    assert.ok(resultB.haltMessage?.includes(CANONICAL_PATH));

    const conflict = resultB.conflicts[0];
    assert.ok(conflict);
    assert.equal(conflict.canonicalPath, CANONICAL_PATH);

    // Both versions were written, unmodified, for manual review — real files, real content.
    assert.equal(readFileSync(join(fixture.projectDir, conflict.pendingScratchCopy), 'utf8'), sessionB.content);
    assert.equal(readFileSync(join(fixture.projectDir, conflict.pendingCanonicalCopy), 'utf8'), sessionA.content);

    // Neither the canonical path NOR session B's original scratch file was clobbered — both left
    // exactly as they were, per scratch-promote.ts's "no auto-merge, nothing lost" contract.
    assert.equal(readFileSync(canonicalAbs, 'utf8'), sessionA.content, 'canonical must still be A\'s version — never silently picked/overwritten');
    assert.equal(readFileSync(join(fixture.projectDir, scratchPathB), 'utf8'), sessionB.content, 'B\'s original scratch file must survive a conflict');
  });
});

// ===========================================================================
// (d) Clean promotion when identical: both sessions independently produce byte-identical final
//     content → promotion succeeds cleanly (direct copy + commit), no escalation.
// ===========================================================================

test('promote_scratch: two sessions that converge on identical final content promote cleanly, no escalation', async () => {
  await withFixture(null, async (fixture) => {
    const runTimestamp = '20260822130000';
    const queueId = 'queue-converge';
    const identicalContent = '# STATE OF THE BUILD\n\nBoth agents independently wrote this exact text.\n';
    const sessionA = { promptId: 'agent-a', content: identicalContent };
    const sessionB = { promptId: 'agent-b', content: identicalContent };

    const scratchPathA = scratchPathFor(queueId, sessionA.promptId, runTimestamp, CANONICAL_PATH);
    const scratchPathB = scratchPathFor(queueId, sessionB.promptId, runTimestamp, CANONICAL_PATH);
    mkdirSync(dirname(join(fixture.projectDir, scratchPathA)), { recursive: true });
    writeFileSync(join(fixture.projectDir, scratchPathA), sessionA.content);
    mkdirSync(dirname(join(fixture.projectDir, scratchPathB)), { recursive: true });
    writeFileSync(join(fixture.projectDir, scratchPathB), sessionB.content);

    const git = new GitManager({ cwd: fixture.projectDir, log: () => {} });

    const resultA = await promoteScratchFiles({
      projectPath: fixture.projectDir,
      git,
      scratchGlob: `docs/_forge-scratch/${queueId}/${sessionA.promptId}/**`,
      queueId,
      promptId: sessionA.promptId,
    });
    assert.equal(resultA.success, true);
    assert.equal(resultA.conflicts.length, 0);
    assert.equal(resultA.promoted[0]?.wasNewFile, true);

    const resultB = await promoteScratchFiles({
      projectPath: fixture.projectDir,
      git,
      scratchGlob: `docs/_forge-scratch/${queueId}/${sessionB.promptId}/**`,
      queueId,
      promptId: sessionB.promptId,
    });
    assert.equal(resultB.success, true, 'byte-identical content must promote cleanly, not escalate');
    assert.equal(resultB.conflicts.length, 0);
    assert.equal(resultB.promoted.length, 1);
    assert.equal(resultB.promoted[0]?.canonicalPath, CANONICAL_PATH);
    assert.equal(resultB.promoted[0]?.wasNewFile, false, 'canonical already existed (from A) — this is the byte-identical path, not a fresh create');

    const canonicalAbs = join(fixture.projectDir, CANONICAL_PATH);
    assert.equal(readFileSync(canonicalAbs, 'utf8'), identicalContent);

    // No conflict artifacts were ever written.
    const pendingReviewDir = join(fixture.projectDir, 'docs', '_forge-scratch', '_pending-review');
    assert.equal(existsSync(pendingReviewDir), false, 'no _pending-review directory should exist when nothing conflicted');

    // Both scratch copies were cleaned up as part of successful promotion.
    assert.equal(existsSync(join(fixture.projectDir, scratchPathA)), false);
    assert.equal(existsSync(join(fixture.projectDir, scratchPathB)), false);

    // The commit for B's promotion attempt was a legitimate no-op (git recognizes nothing changed) —
    // never a fatal error and never a second real commit for identical content.
    const revCount = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: fixture.projectDir, encoding: 'utf8' }).trim();
    // fixture init commit + A's promotion commit = 2. B's promotion found nothing new to stage/commit.
    assert.equal(revCount, '2');
  });
});
