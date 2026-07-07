// FORGE 2.0 — Session 5 verification: Field Hardening.
//
// Proves the fixes for the dialtest findings that scripts/verify-compounding.mjs (Session 4)
// doesn't already cover: stale-lock recovery, the death-report writer, per-prompt-type timeout
// budgets (incl. forge_config.json overrides), git-init-on-greenfield, the `forge status <path>`
// path-vs-build-id heuristic, and infra-mode decision + logging. Every check runs against a
// disposable temp home/project — never the real ~/.forge/forge_memory.db or a real repo.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const tmpHome = mkdtempSync(join(tmpdir(), 'forge-hardening-verify-home-'));
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const { initializeForgeMemory } = await import('../dist/learning/database.js');
const {
  acquireRunLock,
  checkStaleLock,
  releaseRunLock,
  writeDeathReport,
  recordLogLine,
  getRecentLogLines,
  clearRecentLogLines,
} = await import('../dist/tools/death-forensics.js');
const { runPhase3Executor } = await import('../dist/phases/phase3-executor.js');
const { ensureGitRepo } = await import('../dist/phases/phase0-scout.js');
const { looksLikeProjectPath } = await import('../dist/tools/path-heuristics.js');
const { determineInfraMode } = await import('../dist/phases/phase1b-architect.js');
const { resolveAcceptBlockers, checkAdversaryBlockers } = await import('../dist/cli/adversary-gate.js');
const { computeResumeStartAt } = await import('../dist/engine/auto-resume.js');
const { queueShortHash } = await import('../dist/tools/queue-versioning.js');
const { BuildMemory } = await import('../dist/memory/index.js');
const { runClaude } = await import('../dist/engine/claude-runner.js');
const { runSentinel, defaultCountProjectFiles } = await import('../dist/phases/phase4-sentinel.js');
const { findOutOfBoundsPaths } = await import('../dist/phases/phase3-executor.js');

let failed = false;
function assert(cond, message) {
  if (!cond) {
    failed = true;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`PASS: ${message}`);
  }
}

initializeForgeMemory();

// ---------------------------------------------------------------------------
// (1) Stale-lock recovery (finding #13)
// ---------------------------------------------------------------------------

{
  const projectPath = mkdtempSync(join(tmpdir(), 'forge-hardening-lock-'));

  const noLock = checkStaleLock(projectPath, () => {});
  assert(noLock.found === false, 'checkStaleLock: no lock file -> found:false');

  // A lock referencing a pid that is (almost certainly) not running.
  mkdirSync(join(projectPath, '.forge'), { recursive: true });
  writeFileSync(
    join(projectPath, '.forge', 'forge_running.lock'),
    JSON.stringify({ pid: 999999, buildRunId: 'dead-build-id', startedAt: new Date(0).toISOString() }),
    'utf8'
  );
  const staleMessages = [];
  const stale = checkStaleLock(projectPath, (m) => staleMessages.push(m));
  assert(stale.found === true && stale.stale === true, 'checkStaleLock: a lock with a dead pid is reported stale');
  assert(stale.buildRunId === 'dead-build-id', 'checkStaleLock: reports the prior build id from the stale lock');
  assert(staleMessages.some((m) => m.includes('stale forge_running.lock')), 'checkStaleLock: logs a loud WARNING for the stale lock');
  assert(!existsSync(join(projectPath, '.forge', 'forge_running.lock')), 'checkStaleLock: clears the stale lock file');

  // A lock for THIS process's own pid must never be treated as stale.
  acquireRunLock(projectPath, 'live-build-id');
  const live = checkStaleLock(projectPath, () => {});
  assert(live.found === true && live.stale === false, 'checkStaleLock: a lock for a LIVE pid (this process) is not stale');
  releaseRunLock(projectPath);
  assert(!existsSync(join(projectPath, '.forge', 'forge_running.lock')), 'releaseRunLock removes the lock file');

  rmSync(projectPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (2) Death-report writer (finding #13)
// ---------------------------------------------------------------------------

{
  const projectPath = mkdtempSync(join(tmpdir(), 'forge-hardening-death-'));
  clearRecentLogLines();
  recordLogLine("prompt 3 'schema-setup': start");
  recordLogLine("prompt 3 'schema-setup': executing");

  writeDeathReport(projectPath, { buildRunId: 'crash-build-id', currentPromptIndex: 3, currentPromptId: 'schema-setup' }, 'uncaughtException: simulated crash for verification');

  const reportPath = join(projectPath, '.forge', 'death-report.md');
  assert(existsSync(reportPath), 'writeDeathReport creates .forge/death-report.md');
  const content = readFileSync(reportPath, 'utf8');
  assert(content.includes('crash-build-id'), 'death-report.md includes the build run id');
  assert(content.includes('schema-setup'), 'death-report.md includes the current prompt id');
  assert(content.includes('simulated crash for verification'), 'death-report.md includes the exit reason');
  assert(content.includes('schema-setup') && content.includes('start'), 'death-report.md includes recent log lines');

  rmSync(projectPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (3) Per-prompt-type timeout budgets + forge_config.json override (finding #14)
// ---------------------------------------------------------------------------

{
  const projectPath = mkdtempSync(join(tmpdir(), 'forge-hardening-timeout-'));
  mkdirSync(join(projectPath, 'governance'), { recursive: true });

  const entries = [
    {
      id: 'schema-entry',
      name: 'Schema entry',
      prompt_type: 'schema',
      dependencies: [],
      governance_refs: [],
      estimated_tokens: 100,
      context_injection: { schemaSections: [], behavioralSections: [], interactionMaps: [] },
      description: 'A schema-type prompt (default timeout budget).',
    },
    {
      id: 'test-entry',
      name: 'Test entry',
      prompt_type: 'test',
      dependencies: [],
      governance_refs: [],
      estimated_tokens: 100,
      context_injection: { schemaSections: [], behavioralSections: [], interactionMaps: [] },
      description: 'A test-type prompt (long timeout budget).',
    },
  ];

  const capturedTimeouts = {};
  const captureRunClaude = async (prompt, _cwd, timeoutMs) => {
    // Identify the entry by a keyword unique to its description (the assembled prompt embeds it).
    if (prompt.includes('schema-type prompt')) capturedTimeouts['schema-entry'] = timeoutMs;
    if (prompt.includes('test-type prompt')) capturedTimeouts['test-entry'] = timeoutMs;
    return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, tokensEstimated: 10, timedOut: false, signal: null, success: true };
  };
  const sentinelPassFake = async () => ({ passed: true, checks: [], failedCheck: null, diagnosticReport: '# PASS' });
  const gitFake = {
    createBranch: (buildId, index, name) => ({ success: true, command: '', stdout: '', stderr: '', branchName: `forge/${buildId}/prompt-${index}-${name}` }),
    commitAll: () => ({ success: true, command: '', stdout: '', stderr: '', nothingToCommit: false }),
    commitPromptChanges: async () => 'fake-sha',
    getBranchDiff: () => ({ success: true, command: '', stdout: '', stderr: '', files: [] }),
    mergeToMain: () => ({ success: true, command: '', stdout: '', stderr: '', mergedBranch: 'x', targetBranch: 'main' }),
    rollbackToCheckpoint: (tag) => ({ success: true, command: '', stdout: '', stderr: '', tag, targetBranch: 'main' }),
    tagCheckpoint: (buildId, index) => ({ success: true, command: '', stdout: '', stderr: '', tag: `forge-checkpoint-${buildId}-${index}` }),
  };
  const predictImplFake = async () => ({ probability: 0, matchingPatterns: [], recommendation: '', shouldRewrite: false, matchingOccurrences: 0, totalBuildsWithStack: 0 });

  await runPhase3Executor({
    projectPath,
    projectName: 'hardening-timeout-project',
    entries,
    stackFingerprint: null,
    autonomousRecoveryMode: false,
    dryRun: false,
    gitManager: gitFake,
    runClaudeImpl: captureRunClaude,
    runSentinelImpl: sentinelPassFake,
    predictImpl: predictImplFake,
    log: () => {},
  });

  assert(capturedTimeouts['schema-entry'] === 900_000, `default timeout budget for 'schema' prompts is 900s (got ${capturedTimeouts['schema-entry']}ms)`);
  assert(capturedTimeouts['test-entry'] === 1_800_000, `default timeout budget for 'test' prompts is 1800s (got ${capturedTimeouts['test-entry']}ms)`);

  // Now override via forge_config.json and confirm the executor honors it.
  writeFileSync(
    join(projectPath, 'forge_config.json'),
    JSON.stringify({ build: { timeoutMinutes: 3, longTimeoutMinutes: 7 } }, null, 2),
    'utf8'
  );
  const capturedTimeouts2 = {};
  const captureRunClaude2 = async (prompt, _cwd, timeoutMs) => {
    if (prompt.includes('schema-type prompt')) capturedTimeouts2['schema-entry'] = timeoutMs;
    if (prompt.includes('test-type prompt')) capturedTimeouts2['test-entry'] = timeoutMs;
    return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, tokensEstimated: 10, timedOut: false, signal: null, success: true };
  };
  await runPhase3Executor({
    projectPath,
    projectName: 'hardening-timeout-project',
    entries,
    stackFingerprint: null,
    autonomousRecoveryMode: false,
    dryRun: false,
    gitManager: gitFake,
    runClaudeImpl: captureRunClaude2,
    runSentinelImpl: sentinelPassFake,
    predictImpl: predictImplFake,
    log: () => {},
  });
  assert(capturedTimeouts2['schema-entry'] === 3 * 60_000, `forge_config.json build.timeoutMinutes=3 overrides the default (got ${capturedTimeouts2['schema-entry']}ms)`);
  assert(capturedTimeouts2['test-entry'] === 7 * 60_000, `forge_config.json build.longTimeoutMinutes=7 overrides the default (got ${capturedTimeouts2['test-entry']}ms)`);

  rmSync(projectPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (4) Git-init-on-greenfield (finding #3)
// ---------------------------------------------------------------------------

{
  const projectPath = mkdtempSync(join(tmpdir(), 'forge-hardening-gitinit-'));
  writeFileSync(join(projectPath, 'README.md'), '# test project\n', 'utf8');

  assert(!existsSync(join(projectPath, '.git')), 'sanity: the fresh temp project has no .git yet');

  const messages = [];
  const first = await ensureGitRepo(projectPath, (m) => messages.push(m));
  assert(first.initialized === true, 'ensureGitRepo initializes a repo on a greenfield project (initialized:true)');
  assert(existsSync(join(projectPath, '.git')), 'ensureGitRepo creates a .git directory');

  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectPath, encoding: 'utf8' }).trim();
  assert(branch === 'main', `ensureGitRepo lands on a 'main' branch (got '${branch}')`);

  const commitCount = execSync('git rev-list --count HEAD', { cwd: projectPath, encoding: 'utf8' }).trim();
  assert(Number(commitCount) >= 1, `ensureGitRepo creates an initial commit (rev-list --count HEAD = ${commitCount})`);

  // A second call on an already-initialized repo must be a no-op (idempotent).
  const second = await ensureGitRepo(projectPath, () => {});
  assert(second.initialized === false, 'ensureGitRepo is idempotent — a second call on an existing repo reports initialized:false');

  rmSync(projectPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (5) `forge status <path>` path-vs-build-id heuristic (finding #7)
// ---------------------------------------------------------------------------

{
  const someDir = mkdtempSync(join(tmpdir(), 'forge-hardening-statuspath-'));
  assert(looksLikeProjectPath('./my-project') === true, "looksLikeProjectPath('./my-project') -> true (contains a separator)");
  assert(looksLikeProjectPath('C:\\Users\\me\\project') === true, 'looksLikeProjectPath(a Windows path) -> true');
  assert(looksLikeProjectPath(someDir) === true, 'looksLikeProjectPath(an existing directory, no separator needed) -> true');
  assert(
    looksLikeProjectPath('a1b2c3d4-e5f6-7890-abcd-ef1234567890') === false,
    'looksLikeProjectPath(a UUID-shaped build id) -> false'
  );
  rmSync(someDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (6) Infra-provisioning mode decision + logging (finding #16)
// ---------------------------------------------------------------------------

{
  const projectPath = mkdtempSync(join(tmpdir(), 'forge-hardening-infra-'));
  const savedEnv = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const localMessages = [];
  const localDecision = await determineInfraMode(projectPath, (m) => localMessages.push(m));
  assert(localDecision.mode === 'local', `determineInfraMode defaults to 'local' with no cloud creds (got '${localDecision.mode}')`);
  assert(localMessages.some((m) => m.includes('infra mode: local')), 'determineInfraMode logs which mode it chose (local) and why');

  writeFileSync(
    join(projectPath, '.env.local'),
    'NEXT_PUBLIC_SUPABASE_URL=https://real-project.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=sb-real-service-role-key-value\n',
    'utf8'
  );
  const cloudMessages = [];
  const cloudDecision = await determineInfraMode(projectPath, (m) => cloudMessages.push(m));
  assert(cloudDecision.mode === 'cloud', `determineInfraMode chooses 'cloud' when .env.local has real cloud creds (got '${cloudDecision.mode}')`);
  assert(cloudMessages.some((m) => m.includes('infra mode: cloud')), 'determineInfraMode logs which mode it chose (cloud) and why');

  if (savedEnv.NEXT_PUBLIC_SUPABASE_URL !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = savedEnv.NEXT_PUBLIC_SUPABASE_URL;
  if (savedEnv.SUPABASE_SERVICE_ROLE_KEY !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.SUPABASE_SERVICE_ROLE_KEY;
  rmSync(projectPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (7) Session 5.1 hotfix: --auto-approve-gates must NOT bypass adversary BLOCKERs;
//     only --accept-blockers does.
// ---------------------------------------------------------------------------

{
  const projectPath = mkdtempSync(join(tmpdir(), 'forge-hardening-flags-'));

  const blockerReview = {
    phase: 'ARCHITECT_GOVERNANCE',
    findings: [
      {
        severity: 'BLOCKER',
        vector: 'SECURITY',
        specificIssue: 'RLS policy missing on a user-data table',
        evidence: 'table `invoices` has no row-level-security policy',
        recommendedFix: 'add a company-scoped RLS policy',
      },
    ],
    blockers: [
      {
        severity: 'BLOCKER',
        vector: 'SECURITY',
        specificIssue: 'RLS policy missing on a user-data table',
        evidence: 'table `invoices` has no row-level-security policy',
        recommendedFix: 'add a company-scoped RLS policy',
      },
    ],
    significant: [],
    minor: [],
    canProceed: false,
    reviewedAt: new Date(0).toISOString(),
    tokensUsed: 0,
  };

  // (a) --auto-approve-gates alone, WITHOUT --accept-blockers, must NOT override the BLOCKER halt.
  const optsAutoApproveOnly = { autoApproveGates: true, acceptBlockers: false };
  const resolvedA = resolveAcceptBlockers(optsAutoApproveOnly);
  assert(resolvedA === false, 'resolveAcceptBlockers: --auto-approve-gates alone does NOT set acceptBlockers');
  const haltedA = await checkAdversaryBlockers(projectPath, 'PHASE_A', blockerReview, resolvedA);
  assert(haltedA === false, '--auto-approve-gates without --accept-blockers -> BLOCKER halts (checkAdversaryBlockers returns false)');

  // (b) --accept-blockers overrides the halt regardless of --auto-approve-gates.
  const optsAcceptBlockers = { autoApproveGates: false, acceptBlockers: true };
  const resolvedB = resolveAcceptBlockers(optsAcceptBlockers);
  assert(resolvedB === true, 'resolveAcceptBlockers: --accept-blockers sets acceptBlockers true');
  const proceededB = await checkAdversaryBlockers(projectPath, 'PHASE_B', blockerReview, resolvedB);
  assert(proceededB === true, '--accept-blockers -> BLOCKER override proceeds (checkAdversaryBlockers returns true)');

  rmSync(projectPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (8)/(9) Session 5.1 hotfix: auto-resume validates the resume source belongs to the
//         CURRENT queue.yaml, and clamps an out-of-range computed start index to 1
//         instead of letting Phase 3 fail with zero prompts executed.
// ---------------------------------------------------------------------------

function makeQueueYaml(count, prefix) {
  return Array.from(
    { length: count },
    (_, i) => `- id: ${prefix}${i + 1}\n  name: ${prefix}${i + 1}\n  prompt_type: feature\n  dependencies: []\n`
  ).join('');
}

{
  // (8) A stale Build Memory record (queue_hash from an OLD, larger queue) against a
  //     wiped-and-regenerated (shorter) queue.yaml must be treated as a fresh build.
  const projectPath = mkdtempSync(join(tmpdir(), 'forge-hardening-resume-hash-'));
  mkdirSync(join(projectPath, 'governance'), { recursive: true });
  const projectName = 'hardening-resume-hash-project';

  const oldQueueYaml = makeQueueYaml(20, 'p');
  const oldHash = queueShortHash(oldQueueYaml);
  const build = await BuildMemory.builds.createBuild({
    project_name: projectName,
    project_path: projectPath,
    machine_id: 'hardening-verify-machine',
    status: 'halted',
    total_prompts: 20,
    queue_hash: oldHash,
  });
  for (let i = 1; i <= 15; i++) {
    await BuildMemory.prompts.createPromptExecution({
      build_run_id: build.id,
      prompt_index: i,
      prompt_name: `P${i}`,
      prompt_hash: 'x',
      prompt_content: 'x',
      status: 'completed',
    });
  }

  // The project directory was wiped and rebuilt with a fresh, SHORTER 14-prompt queue.
  const freshQueueYaml = makeQueueYaml(14, 'q');
  writeFileSync(join(projectPath, 'queue.yaml'), freshQueueYaml, 'utf8');

  const hashMessages = [];
  const hashStartAt = await computeResumeStartAt(projectPath, projectName, { log: (m) => hashMessages.push(m) });
  assert(hashStartAt === 1, `computeResumeStartAt: mismatched queue hash (stale Build Memory vs regenerated queue.yaml) -> starts at 1 (got ${hashStartAt})`);
  assert(hashMessages.some((m) => m.includes('FRESH build')), 'computeResumeStartAt logs a loud notice when the queue hash does not match');

  rmSync(projectPath, { recursive: true, force: true });
}

{
  // (9) Even with a MATCHING queue hash, a computed start index beyond the current queue's
  //     length must clamp to 1 rather than fail the build with zero prompts executed.
  const projectPath = mkdtempSync(join(tmpdir(), 'forge-hardening-resume-clamp-'));
  mkdirSync(join(projectPath, 'governance'), { recursive: true });
  const projectName = 'hardening-resume-clamp-project';

  const queueYaml = makeQueueYaml(14, 'q');
  const hash = queueShortHash(queueYaml);
  writeFileSync(join(projectPath, 'queue.yaml'), queueYaml, 'utf8');

  const build = await BuildMemory.builds.createBuild({
    project_name: projectName,
    project_path: projectPath,
    machine_id: 'hardening-verify-machine',
    status: 'halted',
    total_prompts: 14,
    queue_hash: hash,
  });
  // Corrupt/stale record: 19 prompts marked completed even though the CURRENT queue only has 14.
  for (let i = 1; i <= 19; i++) {
    await BuildMemory.prompts.createPromptExecution({
      build_run_id: build.id,
      prompt_index: i,
      prompt_name: `Q${i}`,
      prompt_hash: 'x',
      prompt_content: 'x',
      status: 'completed',
    });
  }

  const clampMessages = [];
  const clampStartAt = await computeResumeStartAt(projectPath, projectName, { log: (m) => clampMessages.push(m) });
  assert(clampStartAt === 1, `computeResumeStartAt: computed start index (20) exceeds the 14-prompt queue -> clamps to 1 (got ${clampStartAt})`);
  assert(clampMessages.some((m) => m.includes('Clamping')), 'computeResumeStartAt logs loudly when clamping an out-of-range start index');

  rmSync(projectPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (10) Session 5.2 Task 1: claude-runner pins the spawned process's cwd to the target
//      directory, and combining `detached: true` with a real (non-shim) executable + shell:false
//      is safe — a real file write from the spawned process lands IN that directory, and an
//      exit-0-but-empty-stdout run is treated as FAILED (the vacuous-build root cause: the old
//      shell+detached spawn on Windows exited fast with empty output but wasn't caught as a
//      failure by anything downstream).
// ---------------------------------------------------------------------------

{
  const projectPath = mkdtempSync(join(tmpdir(), 'forge-hardening-spawn-cwd-'));
  const messages = [];
  const result = await runClaude('unused prompt text', {
    cwd: projectPath,
    command: process.execPath,
    args: ['-e', "require('fs').writeFileSync('probe.txt', 'hello from spawn'); console.log('done')"],
    shell: false,
    log: (m) => messages.push(m),
  });
  assert(result.success === true, `runClaude: a spawn with cwd pinned to the temp dir succeeds (exit ${result.exitCode}, stderr: ${result.stderr.slice(0, 200)})`);
  assert(existsSync(join(projectPath, 'probe.txt')), 'runClaude: the spawned process wrote its file INTO the pinned cwd, not somewhere else');
  assert(
    readFileSync(join(projectPath, 'probe.txt'), 'utf8') === 'hello from spawn',
    'runClaude: the file written by the spawned process has the expected content'
  );

  const emptyStdoutResult = await runClaude('unused', {
    cwd: projectPath,
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    shell: false,
    log: () => {},
  });
  assert(
    emptyStdoutResult.exitCode === 0 && emptyStdoutResult.success === false,
    `runClaude: exit 0 with completely empty stdout is treated as FAILED, not completed (got success=${emptyStdoutResult.success})`
  );

  rmSync(projectPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (11) Session 5.2 Task 2a: the file-delta law — a non-exempt prompt (anything but test/deploy)
//      that leaves the project's file count unchanged FAILS Sentinel with 'no work product',
//      exempt prompt types pass regardless, and a real file addition passes with a positive delta.
// ---------------------------------------------------------------------------

{
  const projectPath = mkdtempSync(join(tmpdir(), 'forge-hardening-filedelta-'));
  mkdirSync(join(projectPath, 'governance'), { recursive: true });
  writeFileSync(join(projectPath, 'existing.txt'), 'unchanged', 'utf8');

  const okCmd = async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false });
  const before = await defaultCountProjectFiles(projectPath);

  const zeroDeltaResult = await runSentinel({
    projectPath,
    runCommand: okCmd,
    getFileChanges: async () => [],
    stopOnFirstFailure: false,
    packageJsonContent: JSON.stringify({ name: 'x', dependencies: {} }),
    baselineDependencies: [],
    promptType: 'feature',
    fileCountBefore: before,
  });
  const fileDelta = zeroDeltaResult.checks.find((c) => c.name === 'file_delta');
  assert(fileDelta && !fileDelta.passed && !fileDelta.skipped, "file_delta: a non-exempt ('feature') prompt with zero file delta FAILS");
  assert(fileDelta && /no work product/.test(fileDelta.detail), "file_delta failure reason includes 'no work product'");
  assert(zeroDeltaResult.passed === false, 'runSentinel: overall result FAILS when file_delta fails');

  const exemptResult = await runSentinel({
    projectPath,
    runCommand: okCmd,
    getFileChanges: async () => [],
    stopOnFirstFailure: false,
    packageJsonContent: JSON.stringify({ name: 'x', dependencies: {} }),
    baselineDependencies: [],
    promptType: 'test',
    fileCountBefore: before,
  });
  const fileDeltaExempt = exemptResult.checks.find((c) => c.name === 'file_delta');
  assert(fileDeltaExempt && fileDeltaExempt.passed, "file_delta: a 'test'-type prompt is exempt from the delta requirement");

  writeFileSync(join(projectPath, 'new-file.txt'), 'real work happened', 'utf8');
  const realWorkResult = await runSentinel({
    projectPath,
    runCommand: okCmd,
    getFileChanges: async () => [],
    stopOnFirstFailure: false,
    packageJsonContent: JSON.stringify({ name: 'x', dependencies: {} }),
    baselineDependencies: [],
    promptType: 'feature',
    fileCountBefore: before,
  });
  const fileDeltaReal = realWorkResult.checks.find((c) => c.name === 'file_delta');
  assert(fileDeltaReal && fileDeltaReal.passed, 'file_delta: a real added file produces a positive delta and PASSES');

  const noBeforeResult = await runSentinel({
    projectPath,
    runCommand: okCmd,
    getFileChanges: async () => [],
    stopOnFirstFailure: false,
    packageJsonContent: JSON.stringify({ name: 'x', dependencies: {} }),
    baselineDependencies: [],
    promptType: 'feature',
    // fileCountBefore intentionally omitted
  });
  const fileDeltaSkipped = noBeforeResult.checks.find((c) => c.name === 'file_delta');
  assert(fileDeltaSkipped && fileDeltaSkipped.skipped, 'file_delta: SKIPPED (never a false failure) when no before-count is supplied');

  rmSync(projectPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (12) Session 5.2 Task 2b: absent-target law — a dependency check with NO package.json on
//      disk (and none injected) FAILS loudly; it must never silently skip to a pass. This was
//      the exact observed defect: 15/15 prompts "Sentinel passed" against a directory with no
//      package.json at all.
// ---------------------------------------------------------------------------

{
  const projectPath = mkdtempSync(join(tmpdir(), 'forge-hardening-nopkg-'));
  mkdirSync(join(projectPath, 'governance'), { recursive: true });
  const okCmd = async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false });

  const result = await runSentinel({
    projectPath,
    runCommand: okCmd,
    getFileChanges: async () => [],
    stopOnFirstFailure: false,
    // packageJsonContent intentionally omitted, and no package.json written to disk.
  });
  const dep = result.checks.find((c) => c.name === 'dependencies');
  assert(dep && !dep.passed && !dep.skipped, 'dependencies: an absent package.json FAILS loudly, never skips to a pass');
  assert(result.passed === false, 'runSentinel: overall result FAILS when package.json is absent (absent-target law)');

  rmSync(projectPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (13) Session 5.2 Task 3: project-boundary guard — findOutOfBoundsPaths flags an absolute path
//      outside the project root and ignores paths inside it / URLs.
// ---------------------------------------------------------------------------

{
  const projectPath = 'C:\\Users\\demo\\Documents\\my-project';
  const insideOnly = findOutOfBoundsPaths(
    `Wrote C:\\Users\\demo\\Documents\\my-project\\src\\index.ts and updated https://example.com/docs.png`,
    projectPath
  );
  assert(insideOnly.length === 0, 'findOutOfBoundsPaths: a path inside the project root + a URL are NOT flagged');

  const withViolation = findOutOfBoundsPaths(
    `Wrote C:\\Users\\demo\\Documents\\my-project\\src\\index.ts and also C:\\Windows\\System32\\evil.dll`,
    projectPath
  );
  assert(
    withViolation.some((p) => p.toLowerCase().includes('system32')),
    'findOutOfBoundsPaths: a path OUTSIDE the project root is flagged'
  );
}

// ---------------------------------------------------------------------------

try {
  rmSync(tmpHome, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}

if (failed) {
  console.error('\nverify-hardening: FAILED');
  process.exitCode = 1;
} else {
  console.log('\nverify-hardening: ALL CHECKS PASSED — Session 5 Field Hardening fixes proven end-to-end.');
}
