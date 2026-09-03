/**
 * FORGE 2.0 — Agent Contracts (subsystem write-scope registry).
 *
 * Phase 3 (`src/phases/phase3-executor.ts`) is a composition of a dozen-odd distinct subsystems —
 * the Build Agent (claude subprocess), Sentinel, Recovery Agent, the Native Orchestrator, the
 * Design Pipeline, and so on — each of which is INJECTABLE and NON-FATAL (Contract 4) but, until
 * this module, had no DECLARED statement of what it is actually permitted to touch on disk, in
 * git, in a subprocess, or over the network. `src/sentinel-prime/execution-monitor.ts` already
 * observes ONE such boundary at runtime (a claude subprocess's writes must stay under
 * `projectPath`) but, per its own doc comment, "does not enforce anything on its own (it cannot
 * kill the subprocess)". This module is the STATIC counterpart: a declared contract per subsystem,
 * checked by `permission-enforcer.ts`'s `checkPermission` against an actual write target BEFORE
 * that write is allowed to stand (see `phase3-executor.ts`'s `forceFailOnPermissionViolation`).
 *
 * Every contract below is derived from OBSERVED behavior in the current codebase — never invented
 * — cited in `observedIn`. Where a subsystem's own doc comment already states its write scope
 * (ExecutionMonitor's BOUNDARY note, GitManager's Contract 10/11/12 header, GovernanceEnforcer's
 * contract-contradiction scan), that statement is the contract restated in structured form.
 *
 * Path patterns are relative to the TARGET project root (`projectPath`) and matched with
 * `src/engine/path-classifier.ts`'s existing glob matcher (`**`/`*` only) — the same matcher
 * `phase3-executor.ts`'s own scratch-write enforcement already uses, rather than a second glob
 * implementation. `writablePathPatterns: []` means "this subsystem performs no direct filesystem
 * write inside the target project" (it may still write to Build Memory, an external API, or a
 * path outside the project root — see `writesOutsideProjectRoot`).
 */

import { DEFAULT_SHARED_CANONICAL_GLOBS } from '../engine/path-classifier.js';
import { COMMIT_MESSAGE_FILE } from '../engine/git-manager.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type AgentId =
  | 'build-agent'
  | 'recovery-agent'
  | 'sentinel'
  | 'sentinel-prime'
  | 'git-manager'
  | 'native-orchestrator'
  | 'design-pipeline'
  | 'testing-orchestrator'
  | 'architecture-guardian'
  | 'supabase-migrator'
  | 'gap-auditor'
  | 'integration-bus';

/**
 * What one FORGE subsystem is permitted to do. Every boolean/pattern dimension here is checked
 * ONLY by `checkPermission` (a static, declarative comparison) — none of it is OS-level process
 * sandboxing; a subsystem that ignores its own contract (e.g. the claude subprocess itself, which
 * runs with `--dangerously-skip-permissions`, Contract 5) is not physically prevented from doing
 * so, it is DETECTED after the fact from its actual git diff / declared behavior and denied at the
 * Sentinel gate (see `phase3-executor.ts`'s wiring).
 */
export interface AgentContract {
  id: AgentId;
  /** Human-readable name, matching the name `phase3-executor.ts`'s own progress lines use
   *  (e.g. `renderProgress('INFO', 'Executing Build Agent...')`) where one exists. */
  name: string;
  description: string;
  /**
   * Glob patterns (relative to `projectPath`, matched via `path-classifier.ts`'s `matchesGlob`)
   * this subsystem may write to INSIDE the target project. `['**\/*']` means "anywhere in the
   * project" (still subject to `deniedPathPatterns` below and to the project-boundary containment
   * check `checkPermission` always applies first). `[]` means this subsystem performs no direct
   * in-project filesystem write.
   */
  writablePathPatterns: string[];
  /**
   * Glob patterns this subsystem is NEVER permitted to write, even where `writablePathPatterns`
   * would otherwise allow it — checked BEFORE `writablePathPatterns` by `checkPermission`. Exists
   * because a subsystem's legitimate scope (e.g. Build Agent: "anywhere in the project") can still
   * exclude specific governance-protected paths that a DIFFERENT subsystem owns.
   */
  deniedPathPatterns: string[];
  /**
   * True when this subsystem is OBSERVED to write outside the target project root entirely (its
   * own manifest store, an operator-configured design-storage drive, FORGE's own repository).
   * Documentation only — `checkPermission` evaluates writes reported against `projectPath` and
   * this flag does not relax that check; it exists so the registry is not silently wrong about a
   * real out-of-project write path.
   */
  writesOutsideProjectRoot: boolean;
  /** May this subsystem run `git` commands (branch/commit/merge/tag/rollback)? */
  canInvokeGit: boolean;
  /** May this subsystem spawn a subprocess (a build tool, a dev server, a test runner, `claude`)? */
  canSpawnSubprocesses: boolean;
  /** May this subsystem make an outbound network call to a service other than `claude`/git remotes? */
  canCallExternalNetwork: boolean;
  /** Source file(s) (and, where useful, line context) this contract's permissions were derived from. */
  observedIn: string[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * End-of-prompt housekeeping files that land in the Build Agent's feature branch but are NOT
 * actually written by the Build Agent subprocess — `forceFailOnPermissionViolation`
 * (`phase3-executor.ts`) checks `filesChanged(ctx)` (the branch's cumulative committed diff
 * against main, `GitManager.getBranchDiff`) against the `'build-agent'` contract with no way to
 * attribute an individual touched path to the subsystem that actually wrote it. Two distinct
 * things land here as a result, both of which must be carved back out of the governance-doc
 * denial below rather than left blocked:
 *
 *   1. `STATE_OF_THE_BUILD.md` / `SESSION_STATE.md` — every Phase 3 prompt type is INSTRUCTED to
 *      update these itself (the mandatory footer every assembled prompt ends with, verbatim
 *      `STATE_AUDIT_FOOTER` in `src/engine/prompt-assembler.ts`; also `STATE_FOOTER` in
 *      `src/engine/queue-generator.ts`; BLUEPRINT.md Canonical Rule 9). A real Build Agent write.
 *   2. `CHANGESET.md` — NEVER written by the Build Agent at all. FORGE's own orchestrator appends
 *      to it directly (`appendChangeset` in `phase3-executor.ts`, `join(ctx.projectPath,
 *      'CHANGESET.md')`) right after each prompt's commit, purely as a durable human-readable
 *      record of what that commit touched (the VS Code integration layer). It has no
 *      `governance/`-nested form — `appendChangeset` always targets the project root.
 *
 * `STATE_OF_THE_BUILD.md`/`SESSION_STATE.md` DO also get a second, FORGE-orchestrator-authored
 * append after the fact (`defaultUpdateStateProgress`, `appendMigrationBlocker`,
 * `definition-of-done.ts`, `src/integration/bus.ts`'s `onSentinelPrimeHalt`, `syncIdeStatus` in
 * `src/tools/live-status.ts`) — same root cause as CHANGESET.md, just layered on top of a write
 * the Build Agent was ALSO separately instructed to make itself. Either source alone would already
 * require the exemption.
 *
 * Project convention nests governance docs under `governance/` for some projects and the root for
 * others (both project-root and `governance/`-prefixed paths are listed here for the two files
 * that use that convention); `CHANGESET.md` has no `governance/`-nested form so none is listed.
 */
const BUILD_AGENT_HOUSEKEEPING_GLOBS = [
  'STATE_OF_THE_BUILD.md',
  'SESSION_STATE.md',
  'CHANGESET.md',
  'governance/STATE_OF_THE_BUILD.md',
  'governance/SESSION_STATE.md',
];

/**
 * The Build Agent: the `claude` CLI subprocess `phase3-executor.ts` invokes via
 * `ctx.runClaudeImpl` (`src/engine/claude-runner.ts`, Contract 5 — `claude -p
 * --dangerously-skip-permissions`) once per prompt (`renderProgress('INFO', 'Executing Build
 * Agent...')`). Its only permitted write scope is `projectPath`
 * (`sentinel-prime/execution-monitor.ts`'s BOUNDARY note) MINUS the `shared_canonical` governance
 * docs `src/engine/path-classifier.ts` redirects to scratch before the prompt ever reaches it —
 * those are owned by `gap-auditor`/`integration-bus`, never written directly by the Build Agent —
 * MINUS {@link BUILD_AGENT_HOUSEKEEPING_GLOBS}, which every prompt is expected to touch and so are
 * carved back out of that governance-doc denial rather than left blocked.
 */
/**
 * FINDING I-1c (2026-09-02 audit): two prior commits (6934cac, 68f814a) added
 * `vitest.config.*`/`package.json`/`pnpm-lock.yaml`/`TOOLCHAIN.md` to `writablePathPatterns` below,
 * intending to fix reported permission denials for these files. Verified functional no-ops and
 * removed: `'**\/*'` already matched all four before those commits (`.some()` in
 * `permission-enforcer.ts` — any matching glob allows), and none of the four ever appeared in
 * `DEFAULT_SHARED_CANONICAL_GLOBS` (so `deniedPathPatterns` below never blocked them either).
 * Whatever caused the originally-reported denials was never actually located in this file — if a
 * real denial recurs for one of these paths, check `engine/governance-gate.ts`'s
 * `GOVERNANCE_DOC_NAMES` set and `engine/hook-manager.ts`'s `pre_file_write` wiring (currently
 * dead, Finding I-1) before assuming it's a `writablePathPatterns` gap; this contract was never
 * the actual blocker.
 */
const BUILD_AGENT: AgentContract = {
  id: 'build-agent',
  name: 'Build Agent',
  description:
    'The claude subprocess that produces a prompt\'s actual code/content changes, run once per ' +
    'Phase 3 prompt in the target project root and committed to a feature branch by GitManager.',
  writablePathPatterns: ['**/*', ...BUILD_AGENT_HOUSEKEEPING_GLOBS],
  deniedPathPatterns: DEFAULT_SHARED_CANONICAL_GLOBS.filter((glob) => !BUILD_AGENT_HOUSEKEEPING_GLOBS.includes(glob)),
  writesOutsideProjectRoot: false,
  canInvokeGit: false,
  canSpawnSubprocesses: true,
  canCallExternalNetwork: false,
  observedIn: [
    'src/phases/phase3-executor.ts (ctx.runClaudeImpl call sites, "Executing Build Agent..." progress lines)',
    'src/engine/claude-runner.ts',
    'src/sentinel-prime/execution-monitor.ts (BOUNDARY doc comment)',
    'src/engine/path-classifier.ts (shared_canonical scratch-write redirection)',
  ],
};

/**
 * The Recovery Agent: Contract-14 Autonomous Recovery (`runAutonomousRecovery`,
 * `phase4-sentinel.ts`) and the Build Brain diagnosis that feeds it (`analyzeSentinelFailure`,
 * `src/engine/build-brain.ts`), invoked at `renderProgress('WARN', 'Invoking Recovery
 * Agent...')`. It does not write files itself — it re-invokes the SAME Build Agent path
 * (`ctx.runClaudeImpl`) with a diagnosis-augmented prompt, so its effective write scope is
 * identical to the Build Agent's.
 */
const RECOVERY_AGENT: AgentContract = {
  id: 'recovery-agent',
  name: 'Recovery Agent',
  description:
    'Contract-14 autonomous self-heal: diagnoses a Sentinel failure (build-brain.ts) and re-runs ' +
    'the Build Agent with an augmented prompt, up to 2 attempts, before the build halts.',
  writablePathPatterns: ['**/*'],
  deniedPathPatterns: [...DEFAULT_SHARED_CANONICAL_GLOBS],
  writesOutsideProjectRoot: false,
  canInvokeGit: false,
  canSpawnSubprocesses: true,
  canCallExternalNetwork: false,
  observedIn: [
    'src/phases/phase3-executor.ts ("Invoking Recovery Agent..." progress lines, runRecoveryImpl)',
    'src/phases/phase4-sentinel.ts (runAutonomousRecovery)',
    'src/engine/build-brain.ts (analyzeSentinelFailure)',
  ],
};

/**
 * Sentinel: the Phase 4 Contract-13 health check suite (`runSentinel`, `phase4-sentinel.ts`) —
 * build/lint/test/lighthouse/ZAP/schematheses checks, each run as a read-only subprocess (some
 * spin up a throwaway local dev server, e.g. the Lighthouse/ZAP/Schemathesis checks' `spawn('pnpm',
 * ['dev', ...])`). It never writes application/tooling files; its verdict is returned in-memory.
 */
const SENTINEL: AgentContract = {
  id: 'sentinel',
  name: 'Sentinel',
  description:
    'The Phase 4 Contract-13 health check suite — build/lint/test/security/perf gates run after ' +
    'every Phase 3 prompt. Read-only over the project; reports pass/fail, writes nothing.',
  writablePathPatterns: [],
  deniedPathPatterns: [],
  writesOutsideProjectRoot: false,
  canInvokeGit: false,
  canSpawnSubprocesses: true,
  canCallExternalNetwork: false,
  observedIn: ['src/phases/phase4-sentinel.ts (runSentinel, the spawn(\'pnpm\', [\'dev\', ...]) dev-server checks)'],
};

/**
 * Sentinel Prime (System 5): the second, independent per-prompt observation layer
 * (`src/sentinel-prime/index.ts`) — ExecutionMonitor + DecisionValidator + GovernanceEnforcer.
 * Persists its result to Build Memory's `sentinel_prime_runs` table only; it performs no direct
 * filesystem write itself (the SESSION_STATE.md/STATE_OF_THE_BUILD.md blocker entries a HALT
 * produces are written by `integration-bus`'s `onSentinelPrimeHalt`, a separate subsystem one
 * layer up, not by Sentinel Prime directly).
 */
const SENTINEL_PRIME: AgentContract = {
  id: 'sentinel-prime',
  name: 'Sentinel Prime',
  description:
    'System 5: a second, independent observation pass (ExecutionMonitor + DecisionValidator + ' +
    'GovernanceEnforcer) over each completed prompt. Reads the diff/stdout; writes only to Build Memory.',
  writablePathPatterns: [],
  deniedPathPatterns: [],
  writesOutsideProjectRoot: false,
  canInvokeGit: false,
  canSpawnSubprocesses: false,
  canCallExternalNetwork: false,
  observedIn: [
    'src/sentinel-prime/index.ts',
    'src/sentinel-prime/execution-monitor.ts',
    'src/sentinel-prime/governance-enforcer.ts',
  ],
};

/**
 * GitManager: "The ONE place in FORGE that performs git operations against a target project
 * repo" (its own header). Its only direct filesystem write is the temporary commit-message file
 * (`COMMIT_MESSAGE_FILE = '.forge-commit-msg'`) it writes then removes around every commit —
 * everything else is a `git` subprocess call, not a file write of its own.
 */
const GIT_MANAGER: AgentContract = {
  id: 'git-manager',
  name: 'Git Manager',
  description:
    'The sole subsystem that performs git operations (branch, commit, merge, checkpoint tag, ' +
    'rollback) against the target project repo (Contracts 10/11/12).',
  writablePathPatterns: [COMMIT_MESSAGE_FILE],
  deniedPathPatterns: [],
  writesOutsideProjectRoot: false,
  canInvokeGit: true,
  canSpawnSubprocesses: false,
  canCallExternalNetwork: false,
  observedIn: ['src/engine/git-manager.ts (COMMIT_MESSAGE_FILE, commitAll temp -F message file)'],
};

/**
 * The Native Orchestrator: `OrchestratorEngine` (`src/orchestrator/engine.ts`) — the master loop
 * that replaces `forge-orchestrator.ps1`, resolving a project's `library-manifest.yaml` dependency
 * frontier and, per queue, spawning `forge build --use-existing-queue` as a REAL subprocess
 * (`QueueRunner.spawnForgeBuild`, `src/orchestrator/queue-runner.ts`) — never in-process. Its own
 * direct write is the manifest file `ManifestResolver.save` persists; it never touches git or the
 * target project's application files itself (the spawned `forge build` process — a fresh instance
 * of the whole executor — does that, under its own Build Agent/GitManager contracts).
 */
const NATIVE_ORCHESTRATOR: AgentContract = {
  id: 'native-orchestrator',
  name: 'Native Orchestrator',
  description:
    'OrchestratorEngine: resolves a project library-manifest.yaml dependency frontier and spawns ' +
    '`forge build --use-existing-queue` as a real subprocess for each runnable queue in turn.',
  writablePathPatterns: ['library-manifest.yaml'],
  deniedPathPatterns: [],
  writesOutsideProjectRoot: true,
  canInvokeGit: false,
  canSpawnSubprocesses: true,
  canCallExternalNetwork: false,
  observedIn: [
    'src/orchestrator/engine.ts',
    'src/orchestrator/queue-runner.ts (spawnForgeBuild, spawn(process.execPath, ...))',
    'src/orchestrator/manifest-resolver.ts (ManifestResolver.save)',
  ],
};

/**
 * The Design Pipeline: `DesignPipeline.run()` (`src/design-pipeline/index.ts`) — starts the
 * target project's dev server, captures screenshots via Playwright, optionally uploads them to a
 * configured Penpot instance (external network), and persists a `design_reviews` row. Screenshot
 * artifacts are written under an operator-configurable storage root
 * (`storage-config.ts`'s `FORGE_DESIGN_STORAGE`/external-drive resolution) that is OFTEN outside
 * the target project entirely — never assumed to be a fixed in-project path.
 */
const DESIGN_PIPELINE: AgentContract = {
  id: 'design-pipeline',
  name: 'Design Pipeline',
  description:
    'Component/page prompts: starts the dev server, screenshots every discovered route via ' +
    'Playwright, optionally uploads to Penpot, runs the visual approval gate.',
  writablePathPatterns: [],
  deniedPathPatterns: [],
  writesOutsideProjectRoot: true,
  canInvokeGit: false,
  canSpawnSubprocesses: true,
  canCallExternalNetwork: true,
  observedIn: [
    'src/design-pipeline/index.ts',
    'src/design-pipeline/screenshotter.ts',
    'src/design-pipeline/penpot-integration.ts',
    'src/design-pipeline/storage-config.ts (FORGE_DESIGN_STORAGE / external-drive resolution)',
  ],
};

/**
 * The Testing Orchestrator (System 3): `runTests` (`src/testing/orchestrator.ts`) dispatches to
 * per-runner modules (`src/testing/runners/*`) — vitest/playwright/ZAP/trivy/gitleaks/sbom/etc —
 * each a real subprocess, several of which query external advisory data sources (dependency/
 * trivy/sbom/license runners). Its own direct writes are the coverage artifacts vitest's
 * `coverage: true` option produces (`unit-runner.ts`); it persists `test_run_results` +
 * `test_coverage_snapshots` to Build Memory, never to arbitrary application files.
 */
const TESTING_ORCHESTRATOR: AgentContract = {
  id: 'testing-orchestrator',
  name: 'Testing Orchestrator',
  description:
    'System 3 (Enterprise Test Suite): dispatches UNIT/INTEGRATION/API/E2E/SECURITY/PERFORMANCE/' +
    'etc. runners as subprocesses and persists results to Build Memory.',
  writablePathPatterns: ['coverage/**'],
  deniedPathPatterns: [],
  writesOutsideProjectRoot: false,
  canInvokeGit: false,
  canSpawnSubprocesses: true,
  canCallExternalNetwork: true,
  observedIn: [
    'src/testing/orchestrator.ts',
    'src/testing/runners/unit-runner.ts (coverage: true)',
    'src/testing/runners/dependency-runner.ts, trivy-runner.ts, sbom-runner.ts (external advisory lookups)',
  ],
};

/**
 * Architecture Guardian: `ArchitectureGuardian` (`src/architecture-guardian/index.ts`) —
 * `prePrompt` enhances the assembled prompt text in-memory before it reaches the Build Agent;
 * `postPrompt` scores the diff the Build Agent already produced. Purely a text
 * classify/enhance/validate pipeline — no filesystem write, no subprocess, no network call.
 */
const ARCHITECTURE_GUARDIAN: AgentContract = {
  id: 'architecture-guardian',
  name: 'Architecture Guardian',
  description:
    'Classifies each prompt\'s build target, enhances the prompt with enterprise-standard ' +
    'instruction text pre-run, and scores the actual diff post-run. Never writes; never rejects.',
  writablePathPatterns: [],
  deniedPathPatterns: [],
  writesOutsideProjectRoot: false,
  canInvokeGit: false,
  canSpawnSubprocesses: false,
  canCallExternalNetwork: false,
  observedIn: ['src/architecture-guardian/index.ts', 'src/architecture-guardian/enforcer.ts', 'src/architecture-guardian/post-validator.ts'],
};

/**
 * SupabaseMigrator (`src/autonomy/supabase-migrator.ts`): reads `supabase/migrations/*.sql` from
 * the target project (read-only) and applies them by calling the Supabase Management API directly
 * — "no `supabase` CLI subprocess" (its own header). Every migration attempt is persisted to
 * Build Memory's `autonomy_actions` table; it writes no local file.
 */
const SUPABASE_MIGRATOR: AgentContract = {
  id: 'supabase-migrator',
  name: 'Supabase Migrator',
  description:
    'Applies supabase/migrations/*.sql to the project\'s live Supabase instance via the ' +
    'Management API. Read-only locally; the only writes are remote (Supabase) and to Build Memory.',
  writablePathPatterns: [],
  deniedPathPatterns: [],
  writesOutsideProjectRoot: false,
  canInvokeGit: false,
  canSpawnSubprocesses: false,
  canCallExternalNetwork: true,
  observedIn: ['src/autonomy/supabase-migrator.ts'],
};

/**
 * Gap Auditor (System 1, `src/resurrection/gap-auditor.ts`): the ONE subsystem contractually
 * permitted to write the governance docs the Build Agent is explicitly denied
 * (`DEFAULT_SHARED_CANONICAL_GLOBS`) — but only for a MINOR/auto-resolvable gap, or a
 * CRITICAL/MAJOR one a human has approved through `human-gate.ts`'s structural gate. Also writes
 * a standalone audit-report artifact (`writeFileSync(path, ...)` in `gap-auditor.ts`).
 */
const GAP_AUDITOR: AgentContract = {
  id: 'gap-auditor',
  name: 'Gap Auditor',
  description:
    'System 1: scores every governance artifact and regenerates MINOR/auto-resolvable gaps ' +
    'directly, gating CRITICAL/MAJOR architectural gaps behind human-gate.ts before writing.',
  writablePathPatterns: [...DEFAULT_SHARED_CANONICAL_GLOBS, 'gap-audit-report*.md', 'governance/**'],
  deniedPathPatterns: [],
  writesOutsideProjectRoot: false,
  canInvokeGit: false,
  canSpawnSubprocesses: false,
  canCallExternalNetwork: false,
  observedIn: [
    'src/resurrection/gap-auditor.ts (writeFileSync audit report, regenerateAll)',
    'src/resurrection/human-gate.ts (the CRITICAL/MAJOR structural gate)',
    'src/resurrection/regeneration-engine.ts',
  ],
};

/**
 * Integration Bus (System 4, `src/integration/bus.ts`): the wiring between Systems 1-3 and 5.
 * Its own direct filesystem writes are the BLOCKER/diagnostic entries it appends to
 * `governance/STATE_OF_THE_BUILD.md` and `governance/SESSION_STATE.md` inside the target project
 * (`appendSentinelPrimeBlocker`, `onSentinelPrimeHalt`) — plus, uniquely among every contract in
 * this registry, an append to FORGE's OWN `BEHAVIORAL_CONTRACTS.md` at its repo root
 * (`onContractConfirmed`), which is outside any target project entirely.
 */
const INTEGRATION_BUS: AgentContract = {
  id: 'integration-bus',
  name: 'Integration Bus',
  description:
    'System 4: fans a Sentinel failure/evolution promotion/confirmed pattern out to the other ' +
    'systems, and appends BLOCKER diagnostics to the target project\'s state docs.',
  writablePathPatterns: ['governance/STATE_OF_THE_BUILD.md', 'governance/SESSION_STATE.md', 'STATE_OF_THE_BUILD.md', 'SESSION_STATE.md'],
  deniedPathPatterns: [],
  writesOutsideProjectRoot: true,
  canInvokeGit: false,
  canSpawnSubprocesses: false,
  canCallExternalNetwork: false,
  observedIn: [
    'src/integration/bus.ts (appendSentinelPrimeBlocker, onSentinelPrimeHalt, onContractConfirmed)',
  ],
};

/** Every registered {@link AgentContract}, keyed by {@link AgentId}. */
export const AGENT_CONTRACTS: Readonly<Record<AgentId, AgentContract>> = {
  'build-agent': BUILD_AGENT,
  'recovery-agent': RECOVERY_AGENT,
  sentinel: SENTINEL,
  'sentinel-prime': SENTINEL_PRIME,
  'git-manager': GIT_MANAGER,
  'native-orchestrator': NATIVE_ORCHESTRATOR,
  'design-pipeline': DESIGN_PIPELINE,
  'testing-orchestrator': TESTING_ORCHESTRATOR,
  'architecture-guardian': ARCHITECTURE_GUARDIAN,
  'supabase-migrator': SUPABASE_MIGRATOR,
  'gap-auditor': GAP_AUDITOR,
  'integration-bus': INTEGRATION_BUS,
};

/** Look up one registered contract. Returns `undefined` for an unregistered id — callers (e.g.
 *  `checkPermission`) treat that as a deny, never as an implicit allow. */
export function getAgentContract(id: AgentId): AgentContract | undefined {
  return AGENT_CONTRACTS[id];
}

/** Every registered {@link AgentId}, for iteration/tests. */
export const ALL_AGENT_IDS: readonly AgentId[] = Object.keys(AGENT_CONTRACTS) as AgentId[];



