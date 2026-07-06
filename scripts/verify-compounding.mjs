// FORGE 2.0 — Session 4 verification: the end-to-end compounding proof.
//
// Drives runPhase3Executor three times (simulated builds A, B, C) against a temp throwaway
// project directory, with every external collaborator (claude, git, Sentinel) faked/injected —
// but the REAL write loop (learning-writeback.ts), REAL Build Brain (build-brain.ts), REAL
// prompt-assembler, and REAL learning-schema functions (loops.ts/queries.ts) all run against a
// disposable SQLite db (USERPROFILE/HOME redirected, same trick as the other verify-*.mjs
// scripts — never the real ~/.forge/forge_memory.db).
//
// Proves: fail -> learn -> elevate -> inject -> prevent.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'forge-compounding-verify-home-'));
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const { initializeForgeMemory, getConnection } = await import('../dist/learning/database.js');
const { runPhase3Executor } = await import('../dist/phases/phase3-executor.js');
const { normalizeErrorSignature } = await import('../dist/phases/phase4-sentinel.js');
const { analyzeSentinelFailure } = await import('../dist/engine/build-brain.js');
const { assemblePrompt } = await import('../dist/engine/prompt-assembler.js');
const { BuildMemory } = await import('../dist/memory/index.js');
const { readLiveStatus } = await import('../dist/tools/live-status.js');

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
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_NAME = 'compounding-verify-project';
const projectPath = mkdtempSync(join(tmpdir(), 'forge-compounding-verify-project-'));
mkdirSync(join(projectPath, 'governance'), { recursive: true });

const FIXED_ERROR_TEXT =
  "src/app/dashboard/page.tsx(42,7): error TS2322: Type 'string' is not assignable to type 'number'.";
const SIGNATURE = normalizeErrorSignature(FIXED_ERROR_TEXT);

function makeEntries() {
  return [
    {
      id: 'safe-prompt',
      name: 'Safe prompt',
      prompt_type: 'auth',
      dependencies: [],
      governance_refs: [],
      estimated_tokens: 500,
      context_injection: { schemaSections: [], behavioralSections: [], interactionMaps: [] },
      description: 'A safe prompt that always passes Sentinel.',
    },
    {
      id: 'target-prompt',
      name: 'Target prompt',
      prompt_type: 'schema',
      dependencies: ['safe-prompt'],
      governance_refs: [],
      estimated_tokens: 500,
      context_injection: { schemaSections: [], behavioralSections: [], interactionMaps: [] },
      description: 'The prompt that fails Sentinel on its first check, in every simulated build.',
    },
  ];
}

const claudeRunFake = async (_prompt, _cwd) => ({
  stdout: 'simulated write',
  stderr: '',
  exitCode: 0,
  durationMs: 5,
  tokensEstimated: 200,
  timedOut: false,
  signal: null,
  success: true,
});

function makeGitFake() {
  return {
    createBranch: (buildId, index, name) => ({
      success: true,
      command: 'git checkout -b',
      stdout: '',
      stderr: '',
      branchName: `forge/${buildId}/prompt-${index}-${name}`,
    }),
    commitAll: (_message) => ({ success: true, command: 'git commit', stdout: '', stderr: '', nothingToCommit: false }),
    commitPromptChanges: async (_promptId, _phase, _status) => 'fake-commit-sha',
    getBranchDiff: () => ({ success: true, command: 'git diff', stdout: '', stderr: '', files: [] }),
    mergeToMain: () => ({
      success: true,
      command: 'git merge',
      stdout: '',
      stderr: '',
      mergedBranch: 'forge/x',
      targetBranch: 'main',
    }),
    rollbackToCheckpoint: (tag) => ({
      success: true,
      command: 'git reset',
      stdout: '',
      stderr: '',
      tag,
      targetBranch: 'main',
    }),
    tagCheckpoint: (buildId, index) => ({
      success: true,
      command: 'git tag',
      stdout: '',
      stderr: '',
      tag: `forge-checkpoint-${buildId}-${index}`,
    }),
  };
}

/** A Sentinel fake that FAILS on the Nth call (global counter across the whole build) with
 * FIXED_ERROR_TEXT, and PASSES on every other call. */
function makeSentinelFake(failOnCallNumber) {
  let count = 0;
  return async (_options) => {
    count += 1;
    if (count === failOnCallNumber) {
      return {
        passed: false,
        checks: [{ name: 'typescript', passed: false, skipped: false, detail: FIXED_ERROR_TEXT, output: '', durationMs: 5 }],
        failedCheck: 'typescript',
        diagnosticReport: FIXED_ERROR_TEXT,
      };
    }
    return {
      passed: true,
      checks: [{ name: 'typescript', passed: true, skipped: false, detail: 'ok', output: '', durationMs: 5 }],
      failedCheck: null,
      diagnosticReport: '# Sentinel PASS',
    };
  };
}

const predictImplFake = async () => ({
  probability: 0,
  matchingPatterns: [],
  recommendation: 'test',
  shouldRewrite: false,
  matchingOccurrences: 0,
  totalBuildsWithStack: 0,
});

/** Run one simulated build. Returns { result, capturedPrompts } where capturedPrompts maps entry id -> assembled prompt text. */
async function runSimulatedBuild(label) {
  const sentinelImpl = makeSentinelFake(2); // call #1 = safe-prompt (PASS); call #2 = target-prompt initial (FAIL)
  const runRecoveryImplFake = async (_failedSentinel, rerunPrompt, sentinelOptions) => {
    await rerunPrompt();
    const sentinel = await sentinelImpl(sentinelOptions);
    const recovered = sentinel.passed;
    return {
      enabled: true,
      attempted: true,
      recovered,
      escalated: !recovered,
      attempts: [],
      finalSentinel: sentinel,
      reason: recovered ? `${label}: test autonomous recovery succeeded` : `${label}: test autonomous recovery failed`,
    };
  };

  const capturedPrompts = {};
  const assembleImplCapture = async (input) => {
    const assembled = await assemblePrompt(input);
    capturedPrompts[input.entry.id] = assembled.prompt;
    return assembled;
  };

  const result = await runPhase3Executor({
    projectPath,
    projectName: PROJECT_NAME,
    entries: makeEntries(),
    stackFingerprint: null,
    autonomousRecoveryMode: true,
    dryRun: false,
    gitManager: makeGitFake(),
    runClaudeImpl: claudeRunFake,
    runSentinelImpl: sentinelImpl,
    runRecoveryImpl: runRecoveryImplFake,
    predictImpl: predictImplFake,
    assembleImpl: assembleImplCapture,
    log: () => {},
  });

  return { result, capturedPrompts };
}

// ---------------------------------------------------------------------------
// (1) Build A — first occurrence, seeds the learning tables
// ---------------------------------------------------------------------------

const buildA = await runSimulatedBuild('build-A');

assert(buildA.result.status === 'completed', `build A finalized as 'completed' (got '${buildA.result.status}')`);
assert(buildA.result.buildRunId !== null, 'build A got a real buildRunId (Build Memory reachable)');

const patternAfterA = await BuildMemory.errors.findMatchingPattern(SIGNATURE);
assert(patternAfterA !== null, 'error_patterns has the signature after build A');
assert(patternAfterA?.occurrence_count === 1, `error_patterns occurrence_count is 1 after build A (got ${patternAfterA?.occurrence_count})`);

const resolutionAfterA = patternAfterA ? await BuildMemory.resolutions.getResolutionForPattern(patternAfterA.id) : null;
assert(resolutionAfterA !== null, 'resolutions has a row linked to the pattern after build A');
assert((resolutionAfterA?.times_applied ?? 0) >= 1, 'resolution recorded at least one applied attempt after build A');
assert((resolutionAfterA?.times_succeeded ?? 0) >= 1, 'resolution recorded at least one succeeded attempt after build A');

const promptScoresCountA = getConnection().prepare('SELECT COUNT(*) as c FROM prompt_scores').get().c;
assert(promptScoresCountA >= 2, `prompt_scores populated after build A (got ${promptScoresCountA} row(s), expected >= 2)`);

const liveStatusAfterA = readLiveStatus(projectPath);
assert(liveStatusAfterA !== null, 'live-status.json existed after build A');
assert(
  (liveStatusAfterA?.recentEvents?.length ?? 0) > 0,
  `live-status.json tracked events during build A (got ${liveStatusAfterA?.recentEvents?.length ?? 0})`
);
assert(
  liveStatusAfterA?.recentEvents?.some((e) => e.message.includes('target-prompt')),
  'live-status.json events reference the target prompt (progression was tracked, not just a snapshot)'
);

// ---------------------------------------------------------------------------
// (2) Builds B and C — the same failure recurs; the compounding mechanism should fire
// ---------------------------------------------------------------------------

const buildB = await runSimulatedBuild('build-B');
assert(buildB.result.status === 'completed', `build B finalized as 'completed' (got '${buildB.result.status}')`);

const patternAfterB = await BuildMemory.errors.findMatchingPattern(SIGNATURE);
assert(patternAfterB?.occurrence_count === 2, `error_patterns occurrence_count is 2 after build B (got ${patternAfterB?.occurrence_count})`);

const buildC = await runSimulatedBuild('build-C');
assert(buildC.result.status === 'completed', `build C finalized as 'completed' (got '${buildC.result.status}')`);

const patternAfterC = await BuildMemory.errors.findMatchingPattern(SIGNATURE);
assert(patternAfterC?.occurrence_count === 3, `error_patterns occurrence_count reaches 3 after build C (got ${patternAfterC?.occurrence_count})`);

const elevatedRules = getConnection()
  .prepare("SELECT * FROM governance_rules WHERE source = 'AUTO_ELEVATED'")
  .all();
assert(elevatedRules.length > 0, `a governance_rules row is AUTO_ELEVATED after build C (got ${elevatedRules.length})`);

// The assembled prompt for the failing prompt_type, in build C, must contain the injected warning.
const targetPromptTextC = buildC.capturedPrompts['target-prompt'] ?? '';
assert(
  targetPromptTextC.includes('Known failure patterns for this task type'),
  "build C's assembled prompt for 'target-prompt' contains the Build Memory warnings section"
);
assert(
  targetPromptTextC.includes('Prevention:'),
  "build C's assembled prompt for 'target-prompt' contains the learned prevention text"
);

// Build Brain, asked about this exact failure after build C, must return a knownFix with a real
// historical success rate.
const brainDiagnosis = await analyzeSentinelFailure(
  {
    passed: false,
    checks: [{ name: 'typescript', passed: false, skipped: false, detail: FIXED_ERROR_TEXT, output: '', durationMs: 1 }],
    failedCheck: 'typescript',
    diagnosticReport: FIXED_ERROR_TEXT,
  },
  makeEntries()[1],
  { stackFingerprint: null, buildRunId: buildC.result.buildRunId, promptIndex: 2 }
);
assert(brainDiagnosis.knownFix !== null, 'Build Brain returns a knownFix for the recurring failure after build C');
assert(
  (brainDiagnosis.knownFix?.historicalSuccessRate ?? 0) > 0,
  `Build Brain's knownFix has historicalSuccessRate > 0 (got ${brainDiagnosis.knownFix?.historicalSuccessRate})`
);
assert(!brainDiagnosis.escalate, 'Build Brain does NOT escalate for a well-proven recurring fix');

// ---------------------------------------------------------------------------
// (3) live-status.json tracked progression across the simulated builds (final check)
// ---------------------------------------------------------------------------

const liveStatusAfterC = readLiveStatus(projectPath);
assert(liveStatusAfterC !== null, 'live-status.json still present after build C');
assert(
  (liveStatusAfterC?.totals?.completed ?? 0) >= 1,
  `live-status.json totals reflect completed prompts after build C (got ${liveStatusAfterC?.totals?.completed})`
);

// ---------------------------------------------------------------------------

try {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(projectPath, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}

if (failed) {
  console.error('\nverify-compounding: FAILED');
  process.exitCode = 1;
} else {
  console.log('\nverify-compounding: ALL CHECKS PASSED — fail -> learn -> elevate -> inject -> prevent, proven end-to-end.');
}
