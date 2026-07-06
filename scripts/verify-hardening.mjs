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
