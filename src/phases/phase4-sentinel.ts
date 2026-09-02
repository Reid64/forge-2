/**
 * FORGE 2.0 — Phase 4: Sentinel (post-prompt health checker, queue.yaml s5-p04).
 *
 * Sentinel runs after EVERY Phase 3 prompt execution (BEHAVIORAL_CONTRACTS.md Contract 1 —
 * "Phase 4 runs after EVERY Phase 3 prompt") and is the gate that decides whether the
 * prompt's work is healthy enough to merge to main. It performs nine mandatory health checks IN
 * ORDER (Contract 13), and ALL non-skipped checks must pass:
 *
 *   1. TypeScript  — `pnpm tsc --noEmit`            (Gate 1; zero errors required)
 *   2. ESLint      — `npx eslint . --format json`   (0 error-level findings required)
 *   3. Build       — `pnpm run build`               (Gate 2; must complete; warnings ok)
 *   4. File Integrity — `git diff --name-status`    (immutable governance docs unchanged,
 *                       no unexpected deletions — Contract 3 / Iron Law 1)
 *   5. File Delta  — `git diff --name-status main...HEAD` vs on-disk expected output (the
 *                       authoritative "produced a real work product" signal)
 *   6. Schema Drift — extractSchema() vs SCHEMA_REGISTRY.md, ONLY when schema prompts have
 *                       run. Additions are OK; modifications / deletions FAIL.
 *   7. Dependency Check — current package.json deps vs the locked TOOLCHAIN.md manifest /
 *                       baseline. Any NEW dependency not in the manifest FAILS.
 *   8. Lint Gate   — auto-detects `.eslintrc.*`/`eslint.config.*`, else SKIPs
 *   9. Format Gate — auto-detects `.prettierrc.*`/`prettier.config.*`, else SKIPs
 *
 * Returns a {@link SentinelResult} `{ passed, checks, failedCheck, diagnosticReport }`. When any
 * check fails, the diagnostic report is a full-context markdown summary the executor (s5-p05)
 * can surface to the operator (Contract 13 → halt) or feed into Autonomous Recovery.
 *
 * AUTONOMOUS RECOVERY (Contract 14): {@link runAutonomousRecovery} implements the opt-in
 * self-heal loop. On a Sentinel failure, IF `autonomousRecoveryMode` is enabled AND the
 * normalized error matches an `error_patterns` row that is `auto_resolve_eligible` with
 * `success_rate > 0.90`, FORGE applies the linked resolution, RE-RUNS the prompt, and RE-RUNS
 * Sentinel — up to TWO attempts per prompt. A third failure, or a NOVEL error (no matching
 * pattern), ALWAYS escalates to a human. Every attempt is logged to Build Memory
 * (resolution application counts, pattern occurrence, prompt_execution resolution fields).
 *
 * Like every other FORGE tool/phase, this module is NON-FATAL and NEVER throws (Iron Law 3 —
 * report the real outcome, never fabricate a pass): every command, file read, git call, schema
 * extraction, and Build Memory write is guarded. A check whose precondition cannot be evaluated
 * (e.g. git unavailable, DB unreachable, no baseline manifest) is reported as SKIPPED with a
 * note — never silently passed and never falsely failed. Build Memory being unreachable degrades
 * to stateless mode (Contract 4), it does not block the gate.
 *
 * Every external collaborator (the shell runner, the git diff, the schema extractor, and all
 * Build Memory reads/writes) is injectable, so Sentinel and the recovery loop unit-test with no
 * `pnpm`, no git repo, and no database — matching the house pattern (claude-runner, git-manager,
 * failure-predictor all do the same).
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import * as path from 'node:path';
import { exec, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

import { GitManager, type GitFileChange } from '../engine/git-manager.js';
import type { PromptType } from '../engine/queue-generator.js';
import { extractSchema, type SchemaSnapshot, type SqlExecutor } from '../tools/schema-extractor.js';
import {
  runVisualRegression,
  type VisualRegressionInput,
  type VisualRegressionOptions,
  type VisualRegressionResult,
} from '../tools/visual-regression.js';
import {
  runLivePreviewGate,
  hasUiFileChanges,
  type LivePreviewInput,
  type LivePreviewOptions,
  type LivePreviewResult,
} from '../tools/live-preview-gate.js';
import {
  runSecurityScan,
  type SecurityScanInput,
  type SecurityScannerOptions,
  type SecurityScanResult,
} from '../tools/security-scanner.js';
import {
  runAccessibilityAudit,
  type AccessibilityAuditInput,
  type AccessibilityAuditorOptions,
  type AccessibilityReport,
} from '../tools/accessibility-auditor.js';
import { checkProjectAccessibility } from '../ui-engine/accessibility-checker.js';
import type { AccessibilityReport as ComponentAccessibilityReport } from '../ui-engine/accessibility-checker.js';
import {
  runSeoAudit,
  type SeoAuditInput,
  type SeoValidatorOptions,
  type SEOAuditResult,
} from '../tools/seo-validator.js';
import {
  runArchitectureGuard,
  type ArchitectureGuardInput,
  type ArchitectureGuardOptions,
  type ArchitectureReport,
} from '../tools/architecture-guard.js';
import {
  analyzeMigration,
  type MigrationSafetyInput,
  type MigrationSafetyOptions,
  type MigrationSafetyReport,
} from '../tools/migration-safety.js';
import {
  runConsensusValidation,
  MIN_VALIDATORS,
  type ConsensusValidationInput,
  type ConsensusValidatorOptions,
  type ConsensusValidationResult,
} from '../tools/consensus-validator.js';
import {
  runConsensusProposal,
  MIN_PROPOSALS,
  type ConsensusProposalInput,
  type ConsensusProposalOptions,
  type ConsensusProposalResult,
} from '../tools/consensus-proposal.js';
import type { PreviousSentinelStatus } from '../engine/prompt-assembler.js';
import type { ErrorPattern, ErrorCategory, Resolution, Json, JsonObject, SecurityReport, SecurityGrade } from '../types/index.js';
import { scanProjectSecurity } from '../tools/agent-shield.js';
import { scanDeadCode, formatDeadCodeReport } from '../tools/dead-code-scanner.js';
import type { DeadCodeReport } from '../tools/dead-code-scanner.js';
import { runSixLawsCheck } from '../engine/governance-gate.js';
import type { SixLawsResult } from '../analysis/six-laws-verifier.js';
import { runTests } from '../testing/orchestrator.js';
import { RunnerType, TriggerType, type TestOrchestratorOptions, type TestRunResult } from '../testing/types.js';
import { BuildMemory } from '../memory/index.js';
import { getLogger, logLine } from '../tools/forge-logger.js';
import { initializeForgeMemory } from '../learning/database.js';
import { registerError } from '../learning/queries.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Public contract — Sentinel
// ---------------------------------------------------------------------------

/**
 * The Sentinel health checks. The first nine are the fixed Contract-13 suite (always evaluated, in
 * order). `visual_regression` and `live_preview` are OPTIONAL checks, appended only when configured
 * AND the prompt that just ran touched UI — they are NOT part of the mandatory nine, so a build that
 * does not opt in keeps exactly the nine Contract-13 checks.
 */
export type SentinelCheckName =
  | 'migration_safety'
  | 'typescript'
  | 'eslint'
  | 'lint'
  | 'format'
  | 'build'
  | 'file_integrity'
  | 'file_delta'
  | 'schema_drift'
  | 'dependencies'
  | 'security_scan'
  | 'visual_regression'
  | 'live_preview'
  | 'accessibility'
  | 'component_accessibility'
  | 'seo'
  | 'architecture'
  | 'consensus_validation'
  | 'consensus_proposal'
  | 'agent_shield'
  | 'live_schema_drift'
  | 'dead_code'
  | 'six_laws'
  | 'bundle_size'
  | 'playwright'
  | 'vitest'
  | 'semgrep'
  | 'knip'
  | 'trivy'
  | 'gitleaks'
  | 'lighthouse'
  | 'owasp_zap'
  | 'schemathesis'
  | 'file_exists'
  | 'promote_scratch'
  | 'agent_permission';

/** The fixed, ordered list of MANDATORY Sentinel checks (Contract 13). Visual regression is opt-in. */
export const SENTINEL_CHECK_ORDER: readonly SentinelCheckName[] = [
  'typescript',
  'eslint',
  'build',
  'file_integrity',
  'file_delta',
  'schema_drift',
  'dependencies',
];

/** The outcome of a single health check. */
export interface CheckResult {
  /** Which check this is. */
  name: SentinelCheckName;
  /** True when the check ran and passed. A skipped check is NOT a pass (see `skipped`). */
  passed: boolean;
  /** True when the check could not be evaluated (precondition absent) — neither pass nor fail. */
  skipped: boolean;
  /** Short human-readable summary (one line). */
  detail: string;
  /** Full captured context (stderr/stdout, diff, drift list) for the diagnostic report. */
  output: string;
  /** Wall-clock duration of the check, in milliseconds. */
  durationMs: number;
}

/** The result of one Sentinel run (the s5-p04 return contract). */
export interface SentinelResult {
  /** True iff every non-skipped check passed. */
  passed: boolean;
  /** Each check's result, in {@link SENTINEL_CHECK_ORDER}. */
  checks: CheckResult[];
  /** Name of the FIRST failed check, or null when none failed. */
  failedCheck: SentinelCheckName | null;
  /** Full markdown diagnostic report (always produced; rich when a check failed). */
  diagnosticReport: string;
}

/** Result of running a guarded shell command. */
export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** A function that runs a shell command in a cwd with a timeout. Injectable for tests. */
export type CommandRunner = (
  command: string,
  cwd: string,
  timeoutMs: number
) => Promise<CommandResult>;

/** Options controlling a Sentinel run. */
export interface SentinelOptions {
  /** Target project root — the repo Sentinel inspects (NEVER FORGE's own dir, Contract 6). */
  projectPath: string;
  /** Governance subdirectory under `projectPath`. Default `'governance'`. */
  governanceDirName?: string;
  /**
   * Whether any SCHEMA prompt has already executed in this build. When false, the Schema
   * Drift check (4) is SKIPPED — there is no schema to drift yet (s5-p04 spec / Contract 13
   * step 4: "if schema prompts have run").
   */
  schemaPromptsHaveRun?: boolean;
  /**
   * Project-relative governance documents that MUST NOT change during a build (Contract 3 /
   * Iron Law 1). Compared by basename against the git diff. NOTE: STATE_OF_THE_BUILD.md and
   * SESSION_STATE.md are deliberately ABSENT — they are updated after every prompt (BLUEPRINT
   * canonical rule 9) and so are allowed to change. Default: the truly immutable set.
   */
  protectedGovernanceFiles?: string[];
  /**
   * File paths (basenames) whose deletion is expected/allowed this prompt. Any OTHER deletion
   * is an "unexpected deletion" and fails File Integrity. Default: none (every deletion flags).
   */
  allowedDeletions?: string[];
  /**
   * Baseline dependency names the build is allowed to use (the locked manifest). Any dependency
   * in package.json NOT in this set is flagged as new. When omitted, Sentinel tries to parse a
   * dependency list out of TOOLCHAIN.md; if neither is available the Dependency check is SKIPPED
   * (a missing baseline must never produce a false failure).
   */
  baselineDependencies?: string[];
  /**
   * This prompt's type (Session 5.2 file-delta law — Task 2a). Drives which prompt types are
   * EXEMPT from the file-delta requirement (`test`/`deploy` legitimately touch zero new files).
   * When omitted, the file-delta check treats the prompt as non-exempt (a real build call site
   * always supplies this; only ad-hoc callers that don't care about the law omit it).
   */
  promptType?: PromptType;
  /** Optional live-DB executor for Schema Drift introspection (else migrations are used). */
  schemaSql?: SqlExecutor;
  /** TypeScript-check timeout (ms). Default 5 minutes. */
  tscTimeoutMs?: number;
  /** Build-check timeout (ms). Default 10 minutes. */
  buildTimeoutMs?: number;
  /**
   * Stop after the first failing check (remaining checks are marked SKIPPED). Default true —
   * Contract 13 ("any single failure halts the build") and it avoids running a 10-minute build
   * after tsc already failed. Set false to run every check for a fuller diagnostic.
   */
  stopOnFirstFailure?: boolean;
  /** Override the shell runner (tests). Default: a guarded `child_process.exec` wrapper. */
  runCommand?: CommandRunner;
  /** Override the git file-change source (tests). Default: `GitManager.getBranchDiff()`. */
  getFileChanges?: () => Promise<GitFileChange[] | null>;
  /** Override the actual-schema extraction (tests). Default: `extractSchema(projectPath, sql?)`. */
  extractActualSchema?: () => Promise<SchemaSnapshot>;
  /** Override the SCHEMA_REGISTRY.md content (tests). Default: read from the governance dir. */
  schemaRegistryContent?: string;
  /** Override the TOOLCHAIN.md content (tests). Default: read from the governance dir. */
  toolchainContent?: string;
  /** Override package.json content (tests). Default: read from `projectPath`. */
  packageJsonContent?: string;
  /**
   * Override whether `package.json` is considered present for the TypeScript/ESLint/Build
   * preconditions (tests). Default: real `fs.existsSync(join(projectPath, 'package.json'))` —
   * which, for a fixture `projectPath` that doesn't exist on disk, always evaluates false. Without
   * this override, those three checks can never be exercised against an injected `runCommand` in a
   * hermetic (no real filesystem) test.
   */
  hasPackageJson?: boolean;
  /** Override whether a local `tsc` binary is considered present (tests). Default: real `fs.existsSync`. */
  hasLocalTsc?: boolean;
  /** Override whether a local `eslint` binary is considered present (tests). Default: real `fs.existsSync`. */
  hasLocalEslint?: boolean;
  /**
   * Visual-regression configuration (the OPTIONAL sixth check). When supplied, Sentinel screenshots
   * every route and pixel-diffs each capture against its `.forge/baselines/` baseline AFTER a UI
   * prompt (see `uiPromptJustRan`). `projectPath`/`baseUrl` default from this run's options when
   * absent. When omitted, the visual-regression check is not added (the nine Contract-13 checks stand
   * alone). A regression (>threshold% pixel diff on any route) FAILS the gate; a first run that only
   * captures baselines PASSES; an un-capturable app/browser SKIPS (never a false failure).
   */
  visualRegression?: Omit<VisualRegressionInput, 'projectPath'> & { projectPath?: string };
  /**
   * Whether the prompt that just executed was a UI prompt. The visual-regression check runs only
   * after UI prompts (the spec: "after every UI prompt execution"). `false` skips it; `undefined`
   * (with `visualRegression` configured) is treated as "run" — config presence implies intent.
   */
  uiPromptJustRan?: boolean;
  /** Options forwarded to {@link runVisualRegression} (e.g. an injected driver/fs for tests). */
  visualRegressionOptions?: VisualRegressionOptions;
  /** Override the visual-regression runner (tests). Default: {@link runVisualRegression}. */
  runVisualCheck?: (
    input: VisualRegressionInput,
    options?: VisualRegressionOptions
  ) => Promise<VisualRegressionResult>;
  /**
   * Live-preview configuration (the OPTIONAL seventh check). When supplied, Sentinel BOOTS the target
   * app's dev server (`pnpm dev`), visits every route in the app directory, and verifies each renders
   * (HTTP 200, no console errors, non-blank body, screenshot) AFTER a UI prompt — that is, when the
   * prompt that just ran changed a `.tsx`/`.css` file (detected from this run's git diff via
   * {@link hasUiFileChanges}) OR `uiPromptJustRan !== false`. `projectPath` defaults from this run's
   * options when absent. When omitted, the check is not added (the nine Contract-13 checks stand
   * alone). A route that loads but is blank / errors / non-200 FAILS the gate; an app that won't boot
   * or a browser that won't launch SKIPS (never a false failure).
   */
  livePreview?: Omit<LivePreviewInput, 'projectPath' | 'changedFiles'> & { projectPath?: string };
  /** Options forwarded to {@link runLivePreviewGate} (e.g. an injected driver/dev-server for tests). */
  livePreviewOptions?: LivePreviewOptions;
  /** Override the live-preview runner (tests). Default: {@link runLivePreviewGate}. */
  runLivePreviewCheck?: (
    input: LivePreviewInput,
    options?: LivePreviewOptions
  ) => Promise<LivePreviewResult>;
  /**
   * Security-scan configuration (the OPTIONAL eighth check). When supplied, Sentinel scans the code
   * the prompt just generated for hardcoded secrets, SQL injection, XSS, client-exposed env vars,
   * missing API auth / rate limiting, insecure CORS, and (via `npm audit`) dependency CVEs AFTER
   * EVERY prompt — it is NOT gated on UI changes. `projectPath` defaults from this run's options; when
   * `files` is omitted Sentinel passes the prompt's changed files (from the File-Integrity diff) so
   * only the new/edited code is scanned (a full walk when the diff is unavailable). When omitted, the
   * check is not added (the nine Contract-13 checks stand alone). A CRITICAL finding (a live key, an
   * injectable query, a client-leaked secret, a critical CVE) FAILS the gate and blocks the build;
   * high/medium/low findings are surfaced but pass; an un-scannable project SKIPS (never a false fail).
   */
  securityScan?: Omit<SecurityScanInput, 'projectPath'> & { projectPath?: string };
  /** Options forwarded to {@link runSecurityScan} (e.g. injected fs / audit runner for tests). */
  securityScanOptions?: SecurityScannerOptions;
  /** Override the security-scan runner (tests). Default: {@link runSecurityScan}. */
  runSecurityCheck?: (
    input: SecurityScanInput,
    options?: SecurityScannerOptions
  ) => Promise<SecurityScanResult>;
  /**
   * Accessibility-audit configuration (the OPTIONAL ninth check). When supplied, Sentinel boots the
   * target app, loads every page route, and runs axe-core in the page to audit it for WCAG 2.1 AA
   * compliance (missing alt text, colour contrast, form labels, ARIA on interactive elements, keyboard
   * traps, skip links, heading hierarchy, `lang` attribute) AFTER a UI prompt — that is, when the
   * prompt that just ran changed a `.tsx`/`.css` file (detected from this run's git diff via
   * {@link hasUiFileChanges}) OR `uiPromptJustRan !== false`. `projectPath` defaults from this run's
   * options when absent. When omitted, the check is not added (the nine Contract-13 checks stand
   * alone). A CRITICAL accessibility violation FAILS the gate and blocks the build; serious/moderate/
   * minor are surfaced but pass; an un-bootable app / unavailable browser / missing axe-core SKIPS
   * (never a false failure). Results are stored in Build Memory by the auditor (guarded).
   */
  accessibility?: Omit<AccessibilityAuditInput, 'projectPath' | 'changedFiles'> & { projectPath?: string };
  /** Options forwarded to {@link runAccessibilityAudit} (e.g. an injected driver/dev-server for tests). */
  accessibilityOptions?: AccessibilityAuditorOptions;
  /** Override the accessibility runner (tests). Default: {@link runAccessibilityAudit}. */
  runAccessibilityCheck?: (
    input: AccessibilityAuditInput,
    options?: AccessibilityAuditorOptions
  ) => Promise<AccessibilityReport>;
  /**
   * Component-accessibility configuration (the OPTIONAL twelfth check, `component_accessibility`).
   * When supplied, Sentinel runs {@link checkProjectAccessibility}'s static WCAG 2.1 AA source scan
   * (`src/ui-engine/accessibility-checker.ts`) over every `src/components/**\/*.tsx` file for
   * `feature`/`ui` ("component") prompts — a lighter, no-browser-required sibling to the axe-core
   * `accessibility` check above, catching structural issues (missing aria-label/alt/htmlFor, onClick
   * without a role/keyboard handler, hardcoded colors, unlabeled dialogs) directly from the generated
   * component source. `projectPath` defaults from this run's options when absent. When omitted, the
   * check is not added (the nine Contract-13 checks stand alone). Any error-severity issue on any
   * scanned component FAILS the gate; a project with no `src/components/` directory, or a non-
   * feature/ui prompt type, SKIPS (never a false failure).
   */
  componentAccessibility?: { projectPath?: string };
  /** Override the component-accessibility runner (tests). Default: {@link checkProjectAccessibility}. */
  runComponentAccessibilityCheck?: (projectPath: string) => Promise<ComponentAccessibilityReport[]>;
  /**
   * SEO-audit configuration (the OPTIONAL tenth check). When supplied, Sentinel boots the target app,
   * loads every page route, and validates each rendered page for search-engine readiness AFTER a UI
   * prompt — that is, when the prompt that just ran changed a `.tsx`/`.css` file (detected from this
   * run's git diff via {@link hasUiFileChanges}) OR `uiPromptJustRan !== false`. It checks unique title
   * tags (no duplicates across routes), meta descriptions under 160 chars, canonical URLs, Open Graph
   * tags, valid JSON-LD structured data, page-appropriate robots meta, `sitemap.xml` validity, the
   * internal-link graph (no orphan pages / broken links), heading hierarchy (single H1, logical H2–H6),
   * and image optimization (WebP / lazy / width+height), producing per-page SEO scores. `projectPath`
   * defaults from this run's options when absent. When omitted, the check is not added (the nine
   * Contract-13 checks stand alone). A CRITICAL SEO issue FAILS the gate and blocks the build; serious/
   * moderate/minor are surfaced but pass; an un-bootable app / unavailable browser / no routes SKIPS
   * (never a false failure). Results are stored in Build Memory by the validator (guarded).
   */
  seo?: Omit<SeoAuditInput, 'projectPath' | 'changedFiles'> & { projectPath?: string };
  /** Options forwarded to {@link runSeoAudit} (e.g. an injected driver/dev-server/fetcher for tests). */
  seoOptions?: SeoValidatorOptions;
  /** Override the SEO runner (tests). Default: {@link runSeoAudit}. */
  runSeoCheck?: (input: SeoAuditInput, options?: SeoValidatorOptions) => Promise<SEOAuditResult>;
  /**
   * Architecture-guard configuration (the OPTIONAL eleventh check). When supplied, Sentinel statically
   * analyzes the WHOLE target codebase AFTER EVERY prompt for architectural anti-patterns — circular
   * dependencies (parsed import graph → cycle detection), god components (>500 lines), duplicate logic,
   * N+1 query patterns in API routes, a React tree missing an error boundary, hardcoded values that
   * belong in env vars, inconsistent file naming, dead exported code, and TypeScript strict-mode
   * violations (`as any`/`@ts-ignore`/…). It is NOT gated on UI changes (the whole graph matters every
   * prompt) and — unlike the security scan — is NOT pinned to the changed files (cycle/dead-code
   * detection needs the full project). `projectPath` defaults from this run's options when absent. When
   * omitted, the check is not added (the nine Contract-13 checks stand alone). A HIGH-severity violation
   * (a dependency cycle / an N+1 query by default; configurable via `severityOverrides`) FAILS the gate
   * and blocks the build; medium/low are surfaced but pass; an empty/unanalyzable project SKIPS (never a
   * false fail). Results are stored in Build Memory (`production_telemetry`, guarded).
   */
  architectureGuard?: Omit<ArchitectureGuardInput, 'projectPath'> & { projectPath?: string };
  /** Options forwarded to {@link runArchitectureGuard} (e.g. an injected fs / store / severity overrides for tests). */
  architectureGuardOptions?: ArchitectureGuardOptions;
  /** Override the architecture-guard runner (tests). Default: {@link runArchitectureGuard}. */
  runArchitectureCheck?: (
    input: ArchitectureGuardInput,
    options?: ArchitectureGuardOptions
  ) => Promise<ArchitectureReport>;
  /**
   * Migration-safety configuration (the OPTIONAL PRE-MIGRATION gate). When supplied — the executor
   * passes it only on a prompt that is about to APPLY a database migration, with the migration SQL in
   * `sql` — Sentinel runs {@link analyzeMigration} BEFORE the other checks: it parses the SQL for
   * destructive operations (DROP TABLE / DROP COLUMN / lossy ALTER COLUMN TYPE / TRUNCATE / unqualified
   * DELETE), requires each to be explicitly confirmed, auto-generates a rollback migration and a
   * data-backup script, diffs the migration against the live production schema (via `schemaSql`/
   * `supabase`), and flags any RLS-policy / foreign-key breakage. `projectPath`/`projectName` default
   * from this run's options when absent. When omitted, the check is not added (the nine Contract-13
   * checks stand alone). An UNCONFIRMED destructive operation or an un-acknowledged breakage FAILS the
   * gate and blocks the build (so the migration is never applied); a fully-confirmed, non-breaking
   * migration PASSES; an empty/parse-free migration with nothing destructive PASSES. Because it is the
   * pre-migration gate it runs FIRST — a blocked migration short-circuits the costly tsc/build checks.
   */
  migrationSafety?: Omit<MigrationSafetyInput, 'projectPath' | 'projectName'> & {
    projectPath?: string;
    projectName?: string;
  };
  /** Options forwarded to {@link analyzeMigration} (e.g. an injected schema executor / store for tests). */
  migrationSafetyOptions?: MigrationSafetyOptions;
  /** Override the migration-safety runner (tests). Default: {@link analyzeMigration}. */
  runMigrationSafetyCheck?: (
    input: MigrationSafetyInput,
    options?: MigrationSafetyOptions
  ) => Promise<MigrationSafetyReport>;
  /**
   * Consensus-validation configuration (the OPTIONAL post-generation check). When supplied — the
   * executor passes it after a prompt that PRODUCED an artifact, with the prompt's `originalPrompt`,
   * the model's `generatedOutput`, the `primaryProvider` that produced it, and the `promptType` —
   * Sentinel fans the output to 2–3 INDEPENDENT validator models (each on a different provider than
   * the primary, via the provider-router) and scores their verdicts into a consensus (VALIDATED /
   * VALIDATED_WITH_CONCERNS / FAILED). The per-`promptType` requirement level decides the gate:
   * `architecture` needs 3-of-3, `crud` 2-of-3, `documentation` 1-of-3 (configurable). Like the
   * security scan it is NOT gated on UI changes — every generation is cross-checked. For research
   * results it independently verifies each supplied claim (opportunity existence; eligibility /
   * deadline / dollar-amount accuracy). `projectName` defaults to the basename of this run's
   * `projectPath`. When omitted, the check is not added (the nine Contract-13 checks stand alone). A
   * generation whose approvals fall below the prompt_type requirement FAILS the gate and blocks the
   * build; an unreachable validator panel (<2 usable judgments) SKIPS (never a false failure).
   * Results — including the per-validator real-issue scoreboard — are stored in Build Memory (guarded).
   */
  consensusValidation?: ConsensusValidationInput;
  /** Options forwarded to {@link runConsensusValidation} (e.g. an injected router / validator caller / store for tests). */
  consensusValidationOptions?: ConsensusValidatorOptions;
  /** Override the consensus-validation runner (tests). Default: {@link runConsensusValidation}. */
  runConsensusCheck?: (
    input: ConsensusValidationInput,
    options?: ConsensusValidatorOptions
  ) => Promise<ConsensusValidationResult>;
  /**
   * Consensus-PROPOSAL configuration (the OPTIONAL independent-proposals + critique-round check).
   * When supplied — the executor passes it BEFORE a prompt that is about to produce an artifact,
   * with the task's `taskPrompt` and `promptType` — Sentinel drafts 2-3+ INDEPENDENT proposals
   * (one per provider, each blind to the others; see {@link runConsensusProposal}), critiques
   * every usable draft through the SAME multi-model consensus panel `consensusValidation` uses
   * (each draft's own author excluded from its own panel — by default the panel is the OTHER
   * proposers), and ranks the results. A generation with NO proposal that passed its own
   * critique's `promptType` requirement FAILS the gate and blocks the build; an unreachable
   * proposer panel (<2 usable drafts) SKIPS (never a false failure). Results — including the
   * ranked scoreboard — are stored in Build Memory (guarded).
   */
  consensusProposal?: ConsensusProposalInput;
  /** Options forwarded to {@link runConsensusProposal} (e.g. an injected router / proposer caller / store for tests). */
  consensusProposalOptions?: ConsensusProposalOptions;
  /** Override the consensus-proposal runner (tests). Default: {@link runConsensusProposal}. */
  runConsensusProposalCheck?: (
    input: ConsensusProposalInput,
    options?: ConsensusProposalOptions
  ) => Promise<ConsensusProposalResult>;
  /**
   * AgentShield security scan (OPTIONAL). When supplied, Sentinel runs the AgentShield scanner
   * against the project after every prompt. A grade below B+ (i.e. C / D / F) FAILS the gate
   * and blocks the build; grades A or B pass; an un-scannable project SKIPS.
   */
  agentShield?: { projectPath?: string };
  /** Override the AgentShield runner (tests). Default: {@link scanProjectSecurity}. */
  runAgentShieldCheck?: (projectPath: string) => Promise<SecurityReport>;
  /**
   * Live schema drift (OPTIONAL). When supplied, Sentinel compares the LIVE database schema
   * (via `schemaSql`) against SCHEMA_REGISTRY.md AFTER EVERY prompt — regardless of whether
   * schema prompts have run. `schemaSql` must be provided on `SentinelOptions`; when absent the
   * check SKIPS (a missing SQL executor must never produce a false failure). Additions are OK;
   * modifications / deletions FAIL (same semantics as the mandatory `schema_drift` check).
   */
  liveSchemaCheck?: { projectPath?: string };
  /** Override the live-schema registry content (tests). Defaults to the governance dir's SCHEMA_REGISTRY.md. */
  liveSchemaRegistryContent?: string;
  /** Override the live-schema extraction function (tests). Default: `extractSchema` with `schemaSql`. */
  runLiveSchemaExtraction?: () => Promise<SchemaSnapshot>;
  /**
   * Dead code scan (OPTIONAL). When supplied, Sentinel scans the project for unused imports,
   * variables, and exports AFTER EVERY prompt. Results are ALWAYS REPORTED but NEVER BLOCK the
   * build — this is a report-only check that surfaces dead code for the developer without
   * stopping the gate. An un-scannable project SKIPS.
   */
  deadCodeScan?: { projectPath?: string };
  /** Override the dead code scanner (tests). Default: {@link scanDeadCode}. */
  runDeadCodeScan?: (projectPath: string) => Promise<DeadCodeReport>;
  /**
   * Six Laws verification (OPTIONAL). When supplied, Sentinel runs the full Six Laws check via
   * {@link runSixLawsCheck} (governance-gate) AFTER EVERY prompt. A failing law (any law with a
   * `fail`-severity finding) FAILS the gate; a law that could not be evaluated SKIPS; an
   * un-reachable app / browser SKIPS (never a false failure).
   */
  sixLaws?: { projectPath?: string };
  /** Override the Six Laws runner (tests). Default: {@link runSixLawsCheck}. */
  runSixLawsVerification?: (projectPath: string) => Promise<SixLawsResult>;
  /**
   * Bundle Size gate (OPTIONAL, Next.js only). When supplied, Sentinel rebuilds the app (`pnpm
   * run build`) whenever `.next/` is absent or older than `staleMs` (default 10 minutes), parses
   * `.next/build-manifest.json` for a per-page bundle size (the sum of every chunk a page
   * declares), and compares it against the previous baseline stored in Build Memory
   * (`build_runs.bundle_sizes`, keyed by `project_path`, updated on every PASS). No baseline yet
   * PASSES and establishes one; a per-page increase over `perPageThresholdPercent` (default 15%)
   * or a total-bundle increase over `totalThresholdPercent` (default 10%) FAILS. Only evaluated
   * for `promptType` `'feature'`/`'ui'` — FORGE's `PromptType` union has no component/page/
   * database/migration/documentation members, so these are the closest real analogs to the task
   * spec's "feature, component, page" run-list / "agent, database, migration, documentation"
   * skip-list (Session 2: the `ui` shell entry and every page-building `feature` entry are the
   * UI-producing prompt types) — every other prompt type SKIPS. Auto-skips when no
   * `next.config.*` is found (not a Next.js project). `projectPath` defaults from this run's
   * options when absent. When omitted, the check is not added (the nine Contract-13 checks stand
   * alone). An un-parseable manifest or a `pnpm run build` failure SKIPS/FAILS respectively —
   * never a false pass.
   */
  bundleSize?: {
    projectPath?: string;
    /** `.next/` staleness threshold (ms) before a rebuild is forced. Default 10 minutes. */
    staleMs?: number;
    /** `pnpm run build` timeout (ms) when a rebuild is needed. Default: `buildTimeoutMs`. */
    buildTimeoutMs?: number;
    /** Per-page regression threshold (percent). Default 15. */
    perPageThresholdPercent?: number;
    /** Total-bundle regression threshold (percent). Default 10. */
    totalThresholdPercent?: number;
  };
  /** Override the bundle-size gate (tests). Default: the built-in Next.js build-manifest reader. */
  runBundleSizeCheck?: (
    projectPath: string,
    promptType: PromptType | undefined,
    run: CommandRunner,
    log: (m: string) => void,
    thresholds: {
      staleMs: number;
      buildTimeoutMs: number;
      perPageThresholdPercent: number;
      totalThresholdPercent: number;
    }
  ) => Promise<CheckResult>;
  /**
   * Full Playwright test suite (OPTIONAL). When supplied, Sentinel runs the COMPLETE Playwright
   * test suite (`pnpm playwright test`) after every prompt — not incremental. Any test failure
   * FAILS the gate and blocks the build. Timeout defaults to 20 minutes. An environment without
   * Playwright installed that exits non-zero FAILS (not skipped); a timeout FAILS.
   */
  playwright?: { projectPath?: string; command?: string; timeoutMs?: number };
  /**
   * Ring 1b ESLint timeout (ms). Default: same as `tscTimeoutMs` (5 minutes).
   * ESLint runs as part of the mandatory Ring 1 gate, after TypeScript and before Build.
   */
  eslintTimeoutMs?: number;
  /**
   * Ring 1c schema drift (OPTIONAL). When supplied, Sentinel reads `database.types.ts` (checked
   * under `src/types/`, `src/`, and the project root) to extract declared Supabase table names
   * and compares them against the live Supabase schema via the REST API (`/rest/v1/`). Credentials
   * are read from `SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` env vars or from
   * `.env.local`. Skips gracefully when the file is absent or credentials are unavailable — never
   * a false failure. A table declared in `database.types.ts` that is MISSING from live Supabase
   * FAILS the gate; extra live tables are OK (additions are acceptable).
   */
  ring1SchemaDrift?: { projectPath?: string };
  /**
   * Ring 2 gate (every-10th-prompt + final-prompt). When supplied, Sentinel runs three additional
   * quality tools after the mandatory Ring 1 checks have passed. Ring 2 fires automatically when
   * `ring2.promptNumber % 10 === 0` OR `ring2.isFinalPrompt === true`.
   *
   * Tools:
   *  - **Vitest** (`npx vitest run --reporter=json`): 0 failures AND ≥60% line coverage. Skips
   *    gracefully when `vitest.config.ts` is absent.
   *  - **Semgrep SAST** (`npx semgrep --config=auto --config=p/owasp-top-ten --json`): the default
   *    `auto` ruleset plus the OWASP Top Ten ruleset. 0 severity ERROR findings. Skips when
   *    semgrep is not installed.
   *  - **knip** (`npx knip --reporter json`): 0 unused exports. Skips when knip is not installed.
   *
   * Each failing tool registers a `fix_patterns` entry in the learning database.
   */
  ring2?: {
    /** 1-based prompt number. Used to compute `promptNumber % 10 === 0`. */
    promptNumber: number;
    /** Set to true on the last prompt of a run so Ring 2 always fires at run end. */
    isFinalPrompt?: boolean;
    /** Override Vitest runner (tests). Receives the resolved coverageThreshold as 4th arg. */
    runVitest?: (projectPath: string, run: CommandRunner, log: (m: string) => void, coverageThreshold: number) => Promise<CheckResult>;
    /** Override Semgrep runner (tests). */
    runSemgrep?: (projectPath: string, run: CommandRunner, log: (m: string) => void) => Promise<CheckResult>;
    /** Override knip runner (tests). */
    runKnip?: (projectPath: string, run: CommandRunner, log: (m: string) => void) => Promise<CheckResult>;
    /** Minimum line-coverage percentage for Vitest to pass. Default 60. */
    coverageThreshold?: number;
  };
  /**
   * Ring 3 gate (final-prompt of a run OR explicit `forge sentinel --ring 3`). When supplied,
   * Sentinel runs five additional tools after Ring 1/2 have passed:
   *
   *  - **Trivy** (`trivy fs --severity CRITICAL,HIGH --format json --quiet .`): 0 CRITICAL + 0
   *    HIGH CVEs. Skips when trivy binary is not in PATH.
   *  - **Gitleaks** (`gitleaks detect --source=. --report-format json --exit-code 0`): 0 secret
   *    findings. Skips when gitleaks binary is not in PATH.
   *  - **Lighthouse** (starts dev server on port 3099, runs lighthouse, stops server): all four
   *    categories (performance / accessibility / best-practices / SEO) must score ≥ 90. Skips
   *    when lighthouse is not installed or the dev server does not start.
   *  - **OWASP ZAP DAST** (starts dev server on port 3098, runs `zap-baseline.py -t <url> -J
   *    .forge/zap-report.json -m 5`, stops server): 0 High-risk alerts (`riskcode=3`). Medium/Low/
   *    Informational alerts are surfaced but pass. Skips when `zap-baseline.py` is not on PATH or
   *    the dev server does not start.
   *  - **Schemathesis API contract testing** (starts dev server on port 3097, probes common
   *    well-known paths for an OpenAPI/Swagger schema, runs `schemathesis run <schema> --checks all
   *    --junit-xml=.forge/schemathesis-report.xml`, stops server): 0 failing/erroring test cases in
   *    the JUnit report. Skips when `schemathesis` is not on PATH, the dev server does not start, or
   *    no OpenAPI/Swagger schema is discoverable (not an API project, or the schema isn't exposed).
   *
   * All five tools degrade gracefully (SKIP, never FAIL) when the binary is unavailable or their
   * precondition (a booted dev server, a discoverable schema) cannot be met.
   */
  ring3?: {
    /** Set to true on the last prompt of a run so Ring 3 fires automatically. */
    isFinalPrompt?: boolean;
    /** Force Ring 3 to run regardless of prompt position (e.g. `forge sentinel --ring 3`). */
    forceRun?: boolean;
    /** Override Trivy runner (tests). */
    runTrivy?: (projectPath: string, run: CommandRunner, log: (m: string) => void) => Promise<CheckResult>;
    /** Override Gitleaks runner (tests). */
    runGitleaks?: (projectPath: string, run: CommandRunner, log: (m: string) => void) => Promise<CheckResult>;
    /** Override Lighthouse runner (tests). */
    runLighthouse?: (projectPath: string, run: CommandRunner, log: (m: string) => void) => Promise<CheckResult>;
    /** Override OWASP ZAP DAST runner (tests). */
    runZap?: (projectPath: string, run: CommandRunner, log: (m: string) => void) => Promise<CheckResult>;
    /** Override Schemathesis API-contract runner (tests). */
    runSchemathesis?: (projectPath: string, run: CommandRunner, log: (m: string) => void) => Promise<CheckResult>;
  };
  /**
   * Post-PASS Enterprise Test Suite hook (TESTING_BLUEPRINT.md § TestOrchestrator, § Sentinel
   * Integration). When supplied AND every check above has passed, Sentinel calls
   * `runTests({ triggers: [POST_PROMPT], runners: [UNIT, INTEGRATION] })` against `projectPath`
   * (default: this run's `projectPath`) and records each `TestRunResult` to Build Memory.
   * TestOrchestrator is a non-fatal collaborator (Contract 4): a test failure is logged and
   * surfaced, but never re-flips a passed Sentinel gate to failed. Omitted by default — opt-in,
   * matching every other optional Sentinel check.
   */
  postPromptTests?: {
    projectPath?: string;
    buildRunId?: string | null;
    promptId?: string | null;
    /**
     * Optional target base URL (an ephemeral preview URL — `src/deploy/ephemeral-preview.ts`)
     * forwarded to `runTests`/`TestOrchestratorOptions.baseUrl`. Absent by default — this hook's
     * UNIT/INTEGRATION runners ignore it either way (only API/E2E read it), so omitting it is a
     * complete no-op, unchanged from before this field existed.
     */
    baseUrl?: string;
  };
  /** Override the TestOrchestrator dispatcher (tests). Default: {@link runTests}. */
  runPostPromptTests?: (options: TestOrchestratorOptions) => Promise<TestRunResult[]>;
  /** Progress reporter. Default logs to the console with a `[FORGE:sentinel]` prefix. */
  log?: (message: string) => void;
}

/** Immutable governance docs that a prompt may never modify (Contract 3 / Iron Law 1). */
export const DEFAULT_PROTECTED_GOVERNANCE_FILES: readonly string[] = [
  'BLUEPRINT.md',
  'SCHEMA_REGISTRY.md',
  'BEHAVIORAL_CONTRACTS.md',
  'CLAUDE.md',
  'PRD.md',
  'queue.yaml',
];

const DEFAULT_TSC_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
/** Cap on a single check's captured output rendered into the diagnostic report. */
const MAX_OUTPUT_CHARS = 4000;
/** Cap on a single check's captured output, in LINES, before it's stored in a {@link CheckResult}. */
const DEFAULT_MAX_GATE_OUTPUT_LINES = 50;

// ---------------------------------------------------------------------------
// Default shell runner (guarded — never throws)
// ---------------------------------------------------------------------------

/** The shape `child_process.exec` throws on a non-zero exit / timeout. */
interface ExecError {
  code?: number | null;
  killed?: boolean;
  signal?: string | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  message?: string;
}

/**
 * Quote a command string for embedding inside a `powershell.exe -Command "..."` argument that is
 * itself launched via cmd.exe's default shell. The commands this runner executes are constant
 * strings (`npx tsc --noEmit`, `pnpm run build`, …) — no injection surface — this only needs to
 * survive the outer double-quote layer.
 */
function quoteForPowerShellCommandArg(command: string): string {
  return `"${command.replace(/"/g, '\\"')}"`;
}

/**
 * Default {@link CommandRunner}: run `command` in `cwd` with a timeout, capturing output and
 * NEVER throwing. On Windows the shell is PowerShell (Contract 6); the gate commands
 * (`pnpm tsc --noEmit`, `pnpm run build`) are constant strings — no injection surface.
 *
 * Session 5.2 root cause: routing through `exec(command, { shell: 'powershell.exe' })` lets
 * Windows PowerShell load the user's `$PROFILE` script, which can (and on the machine this defect
 * was diagnosed on, DOES) unconditionally `Set-Location` to an unrelated directory — silently
 * overriding `cwd` at the shell level. Every mandatory build/typescript check was validating
 * whatever project the profile happened to `cd` into, NOT the target project — a build with zero
 * files could still "pass" because Sentinel was grading a different, real, working codebase.
 * Node's `exec()` `shell` option only selects WHICH shell binary runs, not extra flags, so instead
 * we build the full `powershell.exe -NoProfile -NonInteractive -Command "..."` invocation as the
 * command string itself and let `exec()` launch it via the default shell (cmd.exe on Windows),
 * which never reads a PowerShell profile. Verified: `Get-Location` under the old invocation
 * reported the wrong directory; under `-NoProfile -NonInteractive` it reports the real `cwd`.
 */
async function defaultRunCommand(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<CommandResult> {
  const effectiveCommand =
    process.platform === 'win32'
      ? `powershell.exe -NoProfile -NonInteractive -Command ${quoteForPowerShellCommandArg(command)}`
      : command;
  try {
    const { stdout, stderr } = await execAsync(effectiveCommand, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut: false };
  } catch (error) {
    const e = (error ?? {}) as ExecError;
    const exitCode = typeof e.code === 'number' ? e.code : null;
    const timedOut = e.killed === true && e.signal === 'SIGTERM';
    const stderr = String(e.stderr ?? '') || String(e.message ?? '');
    return { ok: false, exitCode, stdout: String(e.stdout ?? ''), stderr, timedOut };
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Read a UTF-8 text file, returning `null` if it cannot be read (guarded). */
async function readTextSafe(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** Truncate text for the diagnostic report, noting how much was elided. */
function clip(text: string, max = MAX_OUTPUT_CHARS): string {
  const t = text ?? '';
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n… [${t.length - max} more chars truncated]`;
}

/**
 * Truncate a gate's captured stdout/stderr to `maxLines` lines. A project with hundreds of
 * TypeScript/ESLint/etc. errors otherwise sends every line into `CheckResult.output` — which
 * feeds the diagnostic report and, via Build Brain recovery prompts, the NEXT prompt's context —
 * even though only the first few errors are ever actionable. The full untruncated text is still
 * written to `.forge/build.log` by the gate function itself (see `logFullOutputIfTruncated`)
 * before this truncation is applied; only what is returned/stored here is capped.
 */
export function truncateGateOutput(output: string, maxLines = DEFAULT_MAX_GATE_OUTPUT_LINES): string {
  const text = output ?? '';
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  const omitted = lines.length - maxLines;
  return [...lines.slice(0, maxLines), `… and ${omitted} more lines truncated. See full output in .forge/build.log.`].join(
    '\n'
  );
}

/**
 * Log the FULL, untruncated gate output to the log sink — ONLY when it is long enough that
 * {@link truncateGateOutput} would actually elide something (avoids log spam on every passing
 * check with short output). During a real Phase 3 build the default `log` sink is redirected to
 * `.forge/build.log` (see `beginQuietLogging` in `tools/forge-logger.ts`), so this is how the full
 * text stays available for human debugging even though it is never returned in `CheckResult.output`.
 */
function logFullOutputIfTruncated(
  log: (m: string) => void,
  checkLabel: string,
  output: string,
  maxLines = DEFAULT_MAX_GATE_OUTPUT_LINES
): void {
  const text = output ?? '';
  if (text.trim() === '' || text.split(/\r?\n/).length <= maxLines) return;
  log(`[sentinel] full untruncated output for '${checkLabel}' (see .forge/build.log):\n${text}`);
}

/** First non-empty trimmed line of a block of output (for terse `detail` strings). */
function firstLine(text: string): string {
  return (
    (text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  );
}

/** A passed check result with timing. Output is capped to {@link DEFAULT_MAX_GATE_OUTPUT_LINES}. */
function pass(name: SentinelCheckName, detail: string, output: string, durationMs: number): CheckResult {
  return { name, passed: true, skipped: false, detail, output: truncateGateOutput(output), durationMs };
}

/** A failed check result with timing. Output is capped to {@link DEFAULT_MAX_GATE_OUTPUT_LINES}. */
function fail(name: SentinelCheckName, detail: string, output: string, durationMs: number): CheckResult {
  return { name, passed: false, skipped: false, detail, output: truncateGateOutput(output), durationMs };
}

/** A skipped check result (precondition absent — neither pass nor fail). */
function skip(name: SentinelCheckName, detail: string): CheckResult {
  return { name, passed: false, skipped: true, detail, output: '', durationMs: 0 };
}

// ---------------------------------------------------------------------------
// Check 1 + 2: TypeScript compile + Build
// ---------------------------------------------------------------------------

/** Run a constant gate command and map its result to a {@link CheckResult}. */
async function runCommandCheck(
  name: SentinelCheckName,
  command: string,
  cwd: string,
  timeoutMs: number,
  run: CommandRunner,
  log: (m: string) => void = () => {}
): Promise<CheckResult> {
  const startedAt = nowMs();
  const res = await run(command, cwd, timeoutMs);
  const durationMs = nowMs() - startedAt;
  const output = [res.stdout, res.stderr].filter((s) => s.trim() !== '').join('\n');
  logFullOutputIfTruncated(log, name, output);

  if (res.timedOut) {
    return fail(name, `\`${command}\` TIMED OUT after ${Math.round(timeoutMs / 1000)}s`, output, durationMs);
  }
  if (res.ok) {
    return pass(name, `\`${command}\` passed (exit 0)`, output, durationMs);
  }
  const why = firstLine(res.stderr) || firstLine(res.stdout) || `exit ${res.exitCode ?? 'null'}`;
  return fail(name, `\`${command}\` failed (exit ${res.exitCode ?? 'null'}): ${why}`, output, durationMs);
}

// ---------------------------------------------------------------------------
// Check 3: File Integrity (git diff --name-status)
// ---------------------------------------------------------------------------

/** Default git file-change source: the current branch's diff against main (Contract 10). */
async function defaultGetFileChanges(cwd: string, log: (m: string) => void): Promise<GitFileChange[] | null> {
  // The File-Integrity diff is `main...HEAD`. When no `main` branch exists yet (a fresh repo, or one
  // that simply never created one) that diff would error and falsely FAIL the gate. Detect the absence
  // FIRST and SKIP the check (return null → evaluateFileIntegrity skips), warning rather than failing
  // (Iron Law 3 — never fabricate a failure from an absent precondition).
  try {
    const { stdout } = await execAsync('git branch --list main', { cwd, windowsHide: true });
    if (String(stdout ?? '').trim() === '') {
      const msg = 'no `main` branch exists — skipping File Integrity check (git diff main...HEAD not runnable)';
      log(`WARNING: ${msg}`);
      // Session 5 finding #3/#5: git absence must WARN LOUDLY (actual Pino warn level), not sit
      // at the same info level as routine progress lines — Contract 10/11/12 (branch isolation,
      // checkpoints, rollback) are ALL silently no-op-ing for this build without a repo.
      getLogger('sentinel').warn({ contract: ['10', '11', '12'] }, msg);
      return null;
    }
  } catch (error) {
    // git unavailable / not a repo — also un-evaluable; skip rather than fail.
    const msg = `could not check for a \`main\` branch (${describe(error)}) — skipping File Integrity check`;
    log(`WARNING: ${msg}`);
    getLogger('sentinel').warn({ contract: ['10', '11', '12'] }, msg);
    return null;
  }

  const git = new GitManager({ cwd, log: (m) => log(`git: ${m}`) });
  const diff = git.getBranchDiff();
  if (!diff.success) return null;
  return diff.files;
}

/**
 * Evaluate File Integrity from a git `--name-status` diff: a protected governance doc that was
 * modified/deleted/renamed FAILS (Contract 3), and any unexpected deletion FAILS (Iron Law 1 —
 * no silent loss of work). A null diff (git unavailable) is SKIPPED, not failed.
 */
function evaluateFileIntegrity(
  changes: GitFileChange[] | null,
  protectedFiles: ReadonlySet<string>,
  allowedDeletions: ReadonlySet<string>,
  durationMs: number
): CheckResult {
  if (changes === null) {
    return skip(
      'file_integrity',
      'git diff unavailable (no repo / git not initialized) — file integrity not evaluated'
    );
  }

  const violations: string[] = [];
  const basename = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? p;

  for (const change of changes) {
    const status = (change.status ?? '').toUpperCase();
    const name = basename(change.path);

    // Protected governance docs must not change at all (M / D / R<score> / C<score>).
    if (protectedFiles.has(name) && /^[MDRC]/.test(status)) {
      const oldName = change.oldPath ? `${basename(change.oldPath)} → ` : '';
      violations.push(`protected governance file changed (${status}): ${oldName}${change.path}`);
      continue;
    }
    // Renames also report the OLD path being removed — a protected doc renamed away is a change.
    if (change.oldPath && protectedFiles.has(basename(change.oldPath))) {
      violations.push(`protected governance file renamed away (${status}): ${basename(change.oldPath)}`);
      continue;
    }

    // Unexpected deletions of any file (deletions, or a rename's source leaving).
    if (status.startsWith('D') && !allowedDeletions.has(name)) {
      violations.push(`unexpected deletion (${status}): ${change.path}`);
    }
  }

  const summary =
    `${changes.length} changed file(s) on this branch` +
    (changes.length > 0 ? `: ${changes.slice(0, 12).map((c) => `${c.status} ${c.path}`).join(', ')}` : '');

  if (violations.length === 0) {
    return pass('file_integrity', `No integrity violations (${changes.length} file(s) changed)`, summary, durationMs);
  }
  return fail(
    'file_integrity',
    `${violations.length} integrity violation(s)`,
    [`Violations:`, ...violations.map((v) => `- ${v}`), '', summary].join('\n'),
    durationMs
  );
}

// ---------------------------------------------------------------------------
// Check 4: Schema Drift (extractSchema vs SCHEMA_REGISTRY.md)
// ---------------------------------------------------------------------------

/** A table-name → declared columns map parsed out of SCHEMA_REGISTRY.md. */
export interface RegistryTable {
  name: string;
  /** Lowercased column name → declared type string (as written in the registry). */
  columns: Map<string, string>;
}

/**
 * Parse SCHEMA_REGISTRY.md into expected tables + columns. Tables are `## Table: name` headings;
 * columns come from the markdown table whose header row starts `| Column | Type | …`. Best-effort
 * and tolerant — a malformed row is skipped, never throws.
 */
export function parseSchemaRegistry(markdown: string): RegistryTable[] {
  const lines = markdown.split(/\r?\n/);
  const tables: RegistryTable[] = [];
  let current: RegistryTable | null = null;
  let inColumnTable = false;

  const tableCells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  for (const raw of lines) {
    const line = raw ?? '';
    const heading = /^##\s+Table:\s+([A-Za-z0-9_]+)/.exec(line.trim());
    if (heading && heading[1]) {
      current = { name: heading[1].toLowerCase(), columns: new Map() };
      tables.push(current);
      inColumnTable = false;
      continue;
    }
    // A new top-level (#/##) heading that is not a Table ends the current table's column scan.
    if (/^#{1,2}\s+/.test(line.trim()) && !heading) {
      inColumnTable = false;
    }
    if (!current) continue;

    if (line.trim().startsWith('|')) {
      const cells = tableCells(line);
      const firstCell = (cells[0] ?? '').toLowerCase();
      // Header row of the column table.
      if (firstCell === 'column') {
        inColumnTable = true;
        continue;
      }
      // Separator row `|---|---|`.
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
      if (inColumnTable) {
        const colName = (cells[0] ?? '').replace(/[`*]/g, '').trim().toLowerCase();
        const colType = (cells[1] ?? '').replace(/[`*]/g, '').trim().toLowerCase();
        if (colName !== '' && /^[a-z_][a-z0-9_]*$/.test(colName)) {
          current.columns.set(colName, colType);
        }
      }
    }
  }

  return tables;
}

/** Collapse a SQL/registry type to a comparable base family (reduces false "modification" flags). */
function normalizeType(raw: string): string {
  const s = (raw ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (/^(big)?serial|^(small|big)?int|^integer|^int[0-9]?\b/.test(s)) return 'integer';
  if (/^(numeric|decimal)/.test(s)) return 'numeric';
  if (/^(double|real|float)/.test(s)) return 'float';
  if (/^(timestamptz|timestamp with time zone)/.test(s)) return 'timestamptz';
  if (/^timestamp/.test(s)) return 'timestamp';
  if (/^(bool|boolean)/.test(s)) return 'boolean';
  if (/^uuid/.test(s)) return 'uuid';
  if (/^jsonb/.test(s)) return 'jsonb';
  if (/^json/.test(s)) return 'json';
  if (/^(text|varchar|char|character|citext|character varying)/.test(s)) return 'text';
  if (/\[\]$/.test(s) || /array/.test(s)) return 'array';
  // Strip a trailing `(p,s)` precision and any constraint noise.
  return s.replace(/\(.*?\)/g, '').split(/[\s,]/)[0] ?? s;
}

/** A single drift finding between the registry (expected) and the live/migration schema (actual). */
export interface SchemaDriftFinding {
  kind: 'addition' | 'modification' | 'deletion';
  detail: string;
}

/**
 * Compare the actual schema snapshot to the expected registry. Deletions (table/column the
 * registry declares but the DB lacks) and modifications (a column whose base type changed) FAIL;
 * additions (extra tables/columns) are reported but OK (the spec: "Flag additions (ok) and
 * modifications/deletions (fail)").
 */
export function diffSchema(expected: RegistryTable[], actual: SchemaSnapshot): SchemaDriftFinding[] {
  const findings: SchemaDriftFinding[] = [];
  const actualByName = new Map(actual.tables.map((t) => [t.name.toLowerCase(), t]));

  for (const exp of expected) {
    const act = actualByName.get(exp.name);
    if (!act) {
      findings.push({ kind: 'deletion', detail: `table '${exp.name}' is declared in SCHEMA_REGISTRY but missing from the schema` });
      continue;
    }
    const actCols = new Map(act.columns.map((c) => [c.name.toLowerCase(), c]));
    for (const [colName, expType] of exp.columns) {
      const actCol = actCols.get(colName);
      if (!actCol) {
        findings.push({ kind: 'deletion', detail: `column '${exp.name}.${colName}' is declared in SCHEMA_REGISTRY but missing from the schema` });
        continue;
      }
      const want = normalizeType(expType);
      const got = normalizeType(actCol.type);
      // Only flag a modification when BOTH sides resolve to a known, differing base family —
      // conservative, to avoid false positives from notation differences (int vs integer, etc.).
      if (want !== '' && got !== '' && want !== got) {
        findings.push({
          kind: 'modification',
          detail: `column '${exp.name}.${colName}' type changed: registry '${expType}' (${want}) vs schema '${actCol.type}' (${got})`,
        });
      }
    }
  }

  // Additions: tables / columns present in the schema but absent from the registry (OK, noted).
  for (const act of actual.tables) {
    const exp = expected.find((e) => e.name === act.name.toLowerCase());
    if (!exp) {
      findings.push({ kind: 'addition', detail: `table '${act.name}' exists in the schema but is not in SCHEMA_REGISTRY` });
      continue;
    }
    for (const col of act.columns) {
      if (!exp.columns.has(col.name.toLowerCase())) {
        findings.push({ kind: 'addition', detail: `column '${act.name}.${col.name}' exists in the schema but is not in SCHEMA_REGISTRY` });
      }
    }
  }

  // Keep deletions/modifications first (the failing ones) for a readable report.
  return findings.sort((a, b) => rank(a.kind) - rank(b.kind));
}

function rank(kind: SchemaDriftFinding['kind']): number {
  return kind === 'deletion' ? 0 : kind === 'modification' ? 1 : 2;
}

/** Evaluate Schema Drift into a {@link CheckResult}. */
function evaluateSchemaDrift(
  expected: RegistryTable[],
  actual: SchemaSnapshot,
  durationMs: number
): CheckResult {
  // Cannot compare without a registry or without any actual schema → skip (no false failure).
  if (expected.length === 0) {
    return skip('schema_drift', 'no tables parsed from SCHEMA_REGISTRY.md — drift not evaluated');
  }
  if (actual.tables.length === 0) {
    return skip(
      'schema_drift',
      `no schema extracted (source: ${actual.source}) — drift not evaluated` +
        (actual.warnings.length ? ` [${actual.warnings[0]}]` : '')
    );
  }

  const findings = diffSchema(expected, actual);
  const breaking = findings.filter((f) => f.kind !== 'addition');
  const additions = findings.filter((f) => f.kind === 'addition');

  const lines = [
    `Compared ${expected.length} registry table(s) against ${actual.tables.length} schema table(s) (source: ${actual.source}).`,
    ...findings.map((f) => `- [${f.kind}] ${f.detail}`),
  ];

  if (breaking.length === 0) {
    return pass(
      'schema_drift',
      `No breaking drift (${additions.length} addition(s), 0 modification/deletion)`,
      lines.join('\n'),
      durationMs
    );
  }
  return fail(
    'schema_drift',
    `${breaking.length} breaking drift finding(s) (modifications/deletions)`,
    lines.join('\n'),
    durationMs
  );
}

// ---------------------------------------------------------------------------
// Check 5: Dependency Check (package.json vs TOOLCHAIN.md manifest)
// ---------------------------------------------------------------------------

/** Extract dependency names from package.json JSON text (dependencies + devDependencies). */
export function parsePackageDependencies(packageJson: string): string[] {
  try {
    const parsed = JSON.parse(packageJson) as { dependencies?: unknown; devDependencies?: unknown };
    const names = new Set<string>();
    for (const block of [parsed.dependencies, parsed.devDependencies]) {
      if (block && typeof block === 'object' && !Array.isArray(block)) {
        for (const key of Object.keys(block)) names.add(key);
      }
    }
    return [...names].sort();
  } catch {
    return [];
  }
}

/**
 * Best-effort parse of a dependency allow-list out of TOOLCHAIN.md. The Phase 0 manifest does not
 * (currently) enumerate npm packages, so this only finds an explicit `## Dependencies` /
 * `## Locked Dependencies` section (bullet list, backticked names, or a markdown table). Returns
 * an empty list when no such section exists — the caller then SKIPS the check rather than failing.
 */
export function parseToolchainDependencies(toolchain: string): string[] {
  const lines = toolchain.split(/\r?\n/);
  const names = new Set<string>();
  let inDepsSection = false;

  for (const raw of lines) {
    const line = raw ?? '';
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading) {
      inDepsSection = /depend/i.test(heading[1] ?? '');
      continue;
    }
    if (!inDepsSection) continue;
    // Collect every backticked token and bare bullet/table package name on the line.
    for (const m of line.matchAll(/`([@a-z0-9][\w./@-]*)`/gi)) {
      if (m[1]) names.add(m[1]);
    }
    const bullet = /^[-*]\s+([@a-z0-9][\w./@-]*)/i.exec(line.trim());
    if (bullet && bullet[1]) names.add(bullet[1]);
    const cell = /^\|\s*([@a-z0-9][\w./@-]*)\s*\|/i.exec(line.trim());
    if (cell && cell[1] && cell[1].toLowerCase() !== 'tool' && cell[1].toLowerCase() !== 'variable') {
      names.add(cell[1]);
    }
  }
  return [...names].sort();
}

/** Evaluate the Dependency check into a {@link CheckResult}. */
// ---------------------------------------------------------------------------
// Check: File Delta (Session 5.2 Task 2a — a build must produce a work product)
// ---------------------------------------------------------------------------

/** Prompt types legitimately exempt from the file-delta requirement (Task 2a). */
const FILE_DELTA_EXEMPT_PROMPT_TYPES: ReadonlySet<PromptType> = new Set<PromptType>(['test', 'deploy']);

/**
 * Check whether the expected on-disk output for `promptType` already exists with real content.
 * 'schema' has a known expected-output shape: at least one non-empty `.sql` file under
 * `supabase/migrations/`. 'ui' has a known expected-output shape: at least one non-empty file
 * under `src/app/`, `src/components/`, or `src/pages/`. Other prompt types have no well-known
 * output path, so this returns false for them rather than guessing. A zero-byte file (e.g. a
 * stub left by a failed prior attempt) does not count as real content.
 */
function expectedOutputExistsOnDisk(promptType: PromptType | undefined, projectPath: string): boolean {
  if (promptType === 'schema') {
    const migrationsDir = join(projectPath, 'supabase', 'migrations');
    if (!existsSync(migrationsDir)) return false;
    let entries: string[];
    try {
      entries = fs.readdirSync(migrationsDir);
    } catch {
      return false;
    }
    return entries.some((name) => {
      if (!name.toLowerCase().endsWith('.sql')) return false;
      try {
        return fs.statSync(join(migrationsDir, name)).size > 0;
      } catch {
        return false;
      }
    });
  }
  if (promptType === 'feature') {
    // For feature prompts, check if any .md file exists at project root with content
    try {
      const rootFiles = fs.readdirSync(projectPath);
      return rootFiles.some(f => f.endsWith('.md') && (() => { try { return fs.statSync(require('path').join(projectPath, f)).size > 100; } catch { return false; } })());
    } catch { return false; }
  }
  if (promptType === 'ui') {
    const uiDirs = ['src/app', 'src/components', 'src/pages'];
    return uiDirs.some((relDir) => {
      const dir = join(projectPath, relDir);
      if (!existsSync(dir)) return false;
      return dirContainsNonEmptyFile(dir);
    });
  }
  return false;
}

function dirContainsNonEmptyFile(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dirContainsNonEmptyFile(entryPath)) return true;
    } else if (entry.isFile()) {
      try {
        if (fs.statSync(entryPath).size > 0) return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
}

/** Git statuses that count as "this branch produced a work product" for the file-delta law. */
const FILE_DELTA_PRODUCTIVE_STATUS = /^[AMRC]/;

/**
 * Evaluate the file-delta law: a non-exempt prompt (anything but `test`/`deploy`) must have
 * produced a real work product — Sentinel must FAIL, never pass a void (Session 5.2 — the
 * observed dialtest defect: 15/15 prompts "passed" against a directory that never gained a single
 * file). The authoritative signal is the SAME `git diff --name-status main...HEAD` the File
 * Integrity check (which runs immediately before this one) already computed — a raw before/after
 * file COUNT cannot distinguish "no work happened" from "work happened but a file was also
 * deleted", and always fails a prompt that correctly verifies pre-existing work on `main` without
 * touching anything (the exact bug this replaces).
 *
 * Primary signal: any added/modified/renamed/copied (`A`/`M`/`R`/`C`) path on this branch's diff
 * against `main` is a real work product — PASS.
 *
 * Fallback: the git diff only sees work committed to a feature branch ahead of `main`. When the
 * expected output was instead committed directly to `main` (or the diff is otherwise empty),
 * fall back to checking the expected on-disk output path directly (see
 * {@link expectedOutputExistsOnDisk}) — a schema/ui prompt whose expected output already exists
 * with real content also counts as a work product.
 *
 * Skips (never fails) when the diff itself is unavailable (no repo / no `main` branch, same
 * precondition as File Integrity) — an un-evaluable precondition must never produce a false
 * failure.
 */
function evaluateFileDelta(
  promptType: PromptType | undefined,
  gitDiffChanges: GitFileChange[] | null,
  projectPath: string,
  durationMs: number
): CheckResult {
  if (promptType && FILE_DELTA_EXEMPT_PROMPT_TYPES.has(promptType)) {
    return pass(
      'file_delta',
      `prompt type '${promptType}' is exempt from the file-delta requirement`,
      '',
      durationMs
    );
  }
  if (gitDiffChanges === null) {
    return skip(
      'file_delta',
      'git diff main...HEAD unavailable (no repo / no `main` branch) — file delta not evaluated'
    );
  }

  const productive = gitDiffChanges.filter((c) => FILE_DELTA_PRODUCTIVE_STATUS.test((c.status ?? '').toUpperCase()));
  if (productive.length > 0) {
    return pass(
      'file_delta',
      `git diff (main...HEAD) shows ${productive.length} file(s) added/modified on this branch`,
      productive.map((c) => `${c.status} ${c.path}`).join('\n'),
      durationMs
    );
  }

  // main...HEAD showed nothing productive (e.g. the feature branch has already converged with
  // main). Before falling further back to on-disk detection, check the branch's own latest
  // commit — real work can still be present there even when the three-dot diff against main is empty.
  const headDiff = new GitManager({ cwd: projectPath }).getHeadDiff();
  const headProductive = headDiff.files.filter((c) => FILE_DELTA_PRODUCTIVE_STATUS.test((c.status ?? '').toUpperCase()));
  if (headProductive.length > 0) {
    return pass(
      'file_delta',
      `git diff (HEAD~1..HEAD) shows ${headProductive.length} file(s) added/modified in the latest commit`,
      headProductive.map((c) => `${c.status} ${c.path}`).join('\n'),
      durationMs
    );
  }

  if (expectedOutputExistsOnDisk(promptType, projectPath)) {
    return pass(
      'file_delta',
      'Expected output already exists on disk from prior work',
      `git diff (main...HEAD) shows no added/modified files, but prompt type '${promptType}' expected ` +
        'output already exists on disk with content — real work product from a prior attempt',
      durationMs
    );
  }

  return fail(
    'file_delta',
    'no work product — git diff (main...HEAD) shows no added/modified files',
    `changes on branch: ${gitDiffChanges.length === 0 ? '(none)' : gitDiffChanges.map((c) => `${c.status} ${c.path}`).join(', ')}\n` +
      `latest commit (HEAD~1..HEAD): ${headDiff.files.length === 0 ? '(none)' : headDiff.files.map((c) => `${c.status} ${c.path}`).join(', ')}\n` +
      `Prompt type '${promptType ?? 'unknown'}' is expected to create or modify files; no productive ` +
      'diff against main, no productive diff in the latest commit, and no expected output on disk ' +
      'means claude did not (or could not) do the work, regardless of what any other check reports ' +
      '(Session 5.2 file-delta law).',
    durationMs
  );
}

function evaluateDependencies(
  currentDeps: string[],
  baseline: string[] | null,
  durationMs: number
): CheckResult {
  if (baseline === null || baseline.length === 0) {
    return skip(
      'dependencies',
      'no dependency baseline (TOOLCHAIN.md has no dependencies section and none supplied) — not evaluated'
    );
  }
  const allowed = new Set(baseline);
  const added = currentDeps.filter((d) => !allowed.has(d));

  const summary = `package.json declares ${currentDeps.length} dependency(ies); manifest baseline has ${baseline.length}.`;
  if (added.length === 0) {
    return pass('dependencies', 'No new dependencies outside the manifest', summary, durationMs);
  }
  return fail(
    'dependencies',
    `${added.length} new dependency(ies) not in the TOOLCHAIN manifest: ${added.join(', ')}`,
    [summary, `New (unmanifested): ${added.join(', ')}`].join('\n'),
    durationMs
  );
}

// ---------------------------------------------------------------------------
// Check 7 (optional): Visual Regression (screenshots vs .forge/baselines)
// ---------------------------------------------------------------------------

/** Map a {@link VisualRegressionResult} into the Sentinel's {@link CheckResult} contract. */
function evaluateVisualRegression(vr: VisualRegressionResult, durationMs: number): CheckResult {
  // Nothing comparable — no routes, or the app/browser was unavailable. Skip (no false failure).
  if (vr.pages.length === 0) {
    return skip('visual_regression', 'no routes supplied for visual regression — not evaluated');
  }
  if (!vr.driverAvailable) {
    return skip('visual_regression', 'browser unavailable (Playwright not installed / failed to launch) — not evaluated');
  }
  if (vr.comparedPages === 0 && vr.capturedBaselines === 0) {
    return skip(
      'visual_regression',
      `target app not reachable at ${vr.baseUrl} — ${vr.unreachablePages} route(s) could not be captured`
    );
  }

  const summary =
    `${vr.comparedPages} compared, ${vr.capturedBaselines} baseline(s) captured, ` +
    `${vr.regressions.length} regression(s), ${vr.errorPages} error(s) (threshold ${vr.thresholdPercent}%).\n` +
    vr.pages.map((p) => `- [${p.status}] ${p.path}${p.diffPercentage >= 0 ? ` — ${p.diffPercentage.toFixed(2)}%` : ''}${p.detail ? ` (${p.detail})` : ''}`).join('\n');

  // First run that only captured baselines — a pass (nothing to compare yet).
  if (vr.firstRun) {
    return pass('visual_regression', `captured ${vr.capturedBaselines} baseline(s) (first run — nothing to compare)`, summary, durationMs);
  }
  if (vr.regressions.length > 0) {
    const worst = vr.regressions
      .map((p) => `${p.path} (${p.diffPercentage.toFixed(2)}%${p.diffImagePath ? `, diff: ${p.diffImagePath}` : ''})`)
      .join('; ');
    return fail('visual_regression', `${vr.regressions.length} UI regression(s) > ${vr.thresholdPercent}%: ${worst}`, summary, durationMs);
  }
  return pass('visual_regression', `${vr.comparedPages} route(s) within ${vr.thresholdPercent}% of baseline`, summary, durationMs);
}

// ---------------------------------------------------------------------------
// Check 8 (optional): Live Preview (boot pnpm dev, visit every route)
// ---------------------------------------------------------------------------

/** Map a {@link LivePreviewResult} into the Sentinel's {@link CheckResult} contract. */
function evaluateLivePreview(lp: LivePreviewResult, durationMs: number): CheckResult {
  // The gate did not evaluate any route — distinguish the un-evaluable reasons (all SKIP, no false fail).
  if (!lp.ran) {
    if (lp.pages.length === 0) {
      return skip('live_preview', 'no UI change / no page routes discovered — live preview not triggered');
    }
    if (!lp.devServerStarted) {
      return skip('live_preview', `dev server did not become ready — ${lp.pages[0]?.detail ?? 'app not reachable'} (not evaluated)`);
    }
    if (!lp.driverAvailable) {
      return skip('live_preview', 'browser unavailable (Playwright not installed / failed to launch) — not evaluated');
    }
    return skip('live_preview', 'live preview did not run — not evaluated');
  }

  const summary =
    `${lp.passedPages} passed, ${lp.failedPages} failed, ${lp.skippedPages} skipped/error of ${lp.pages.length} route(s) at ${lp.baseUrl}.\n` +
    lp.pages
      .map((p) => `- [${p.status}] ${p.path} — HTTP ${p.httpStatus ?? 'none'}, ${p.bodyTextLength ?? '?'} chars${p.detail ? ` (${p.detail})` : ''}`)
      .join('\n');

  if (lp.failedPages > 0) {
    const worst = lp.failures.map((p) => `${p.path} (${p.detail})`).join('; ');
    return fail('live_preview', `${lp.failedPages} route(s) failed to render: ${worst}`, summary, durationMs);
  }
  return pass('live_preview', `${lp.passedPages} route(s) rendered live (HTTP 200, non-blank, no console errors)`, summary, durationMs);
}

// ---------------------------------------------------------------------------
// Check 9 (optional): Accessibility (axe-core WCAG 2.1 AA over every route)
// ---------------------------------------------------------------------------

/** Map an {@link AccessibilityReport} into the Sentinel's {@link CheckResult} contract. */
function evaluateAccessibility(report: AccessibilityReport, durationMs: number): CheckResult {
  // The audit did not evaluate any route — distinguish the un-evaluable reasons (all SKIP, no false fail).
  if (!report.ran || report.auditedPages === 0) {
    if (report.pages.length === 0) {
      return skip('accessibility', 'no UI change / no page routes discovered — accessibility audit not triggered');
    }
    if (!report.devServerStarted) {
      return skip('accessibility', `dev server did not become ready — ${report.pages[0]?.detail ?? 'app not reachable'} (not evaluated)`);
    }
    if (!report.driverAvailable) {
      return skip('accessibility', 'browser/axe unavailable (Playwright or axe-core not installed / failed to launch) — not evaluated');
    }
    return skip('accessibility', 'accessibility audit evaluated no route — not assessed');
  }

  const c = report.counts;
  const summary =
    `${report.totalViolations} WCAG 2.1 AA violation(s) across ${report.auditedPages} route(s): ` +
    `${c.critical} critical, ${c.serious} serious, ${c.moderate} moderate, ${c.minor} minor ` +
    `(${report.skippedPages} skipped/error).\n` +
    report.report;

  // CRITICAL violations block the build (the task contract / Iron Law 2).
  if (report.blocked) {
    const worst = report.failures
      .filter((p) => p.counts.critical > 0)
      .slice(0, 8)
      .map((p) => {
        const crit = p.violations.find((v) => v.severity === 'critical');
        return `${p.path} (${crit ? `${crit.rule}: ${crit.category}` : `${p.counts.critical} critical`})`;
      })
      .join('; ');
    return fail(
      'accessibility',
      `${c.critical} CRITICAL accessibility violation(s) — build blocked: ${worst}`,
      summary,
      durationMs
    );
  }
  // serious/moderate/minor are surfaced but do not block (only critical blocks).
  const noteCount = c.serious + c.moderate + c.minor;
  return pass(
    'accessibility',
    noteCount > 0
      ? `no critical violations (${c.serious} serious, ${c.moderate} moderate, ${c.minor} minor surfaced — non-blocking)`
      : 'no WCAG 2.1 AA violations',
    summary,
    durationMs
  );
}

// ---------------------------------------------------------------------------
// Check 10 (optional): SEO (per-page validation + site-wide link/sitemap analysis)
// ---------------------------------------------------------------------------

/** Map an {@link SEOAuditResult} into the Sentinel's {@link CheckResult} contract. */
function evaluateSeo(result: SEOAuditResult, durationMs: number): CheckResult {
  // The audit did not evaluate any route — distinguish the un-evaluable reasons (all SKIP, no false fail).
  if (!result.ran || result.auditedPages === 0) {
    if (result.pages.length === 0) {
      return skip('seo', 'no UI change / no page routes discovered — SEO audit not triggered');
    }
    if (!result.devServerStarted) {
      return skip('seo', `dev server did not become ready — ${result.pages[0]?.detail ?? 'app not reachable'} (not evaluated)`);
    }
    if (!result.driverAvailable) {
      return skip('seo', 'browser unavailable (Playwright not installed / failed to launch) — not evaluated');
    }
    return skip('seo', 'SEO audit evaluated no route — not assessed');
  }

  const c = result.counts;
  const summary =
    `${result.totalIssues} SEO issue(s) across ${result.auditedPages} route(s) (site score ${result.siteScore ?? 'n/a'}/100): ` +
    `${c.critical} critical, ${c.serious} serious, ${c.moderate} moderate, ${c.minor} minor ` +
    `(${result.skippedPages} skipped/error).\n` +
    result.report;

  // CRITICAL issues block the build (the task contract / Iron Law 2).
  if (result.blocked) {
    const worst = result.failures
      .filter((p) => p.counts.critical > 0)
      .slice(0, 8)
      .map((p) => {
        const crit = p.issues.find((i) => i.severity === 'critical');
        return `${p.path} (${crit ? `${crit.check}: ${crit.message}` : `${p.counts.critical} critical`})`;
      })
      .join('; ');
    return fail('seo', `${c.critical} CRITICAL SEO issue(s) — build blocked: ${worst}`, summary, durationMs);
  }
  // serious/moderate/minor are surfaced but do not block (only critical blocks).
  const noteCount = c.serious + c.moderate + c.minor;
  return pass(
    'seo',
    noteCount > 0
      ? `no critical issues (site score ${result.siteScore ?? 'n/a'}/100; ${c.serious} serious, ${c.moderate} moderate, ${c.minor} minor surfaced — non-blocking)`
      : `no SEO issues (site score ${result.siteScore ?? 'n/a'}/100)`,
    summary,
    durationMs
  );
}

// ---------------------------------------------------------------------------
// Check 8 (optional): Security Scan (secrets / injection / XSS / CVEs)
// ---------------------------------------------------------------------------

/** Map a {@link SecurityScanResult} into the Sentinel's {@link CheckResult} contract. */
function evaluateSecurityScan(scan: SecurityScanResult, durationMs: number): CheckResult {
  // Nothing was inspectable — no files scanned AND the dependency audit could not run. Skip (no
  // false failure): an empty/unreadable project must not fabricate a vulnerability.
  if (scan.scannedFiles === 0 && !scan.dependencyAuditAvailable) {
    return skip('security_scan', 'no source files scanned and npm audit unavailable — security not evaluated');
  }

  const c = scan.counts;
  const summary =
    `${scan.findings.length} finding(s) across ${scan.scannedFiles} file(s): ` +
    `${c.critical} critical, ${c.high} high, ${c.medium} medium, ${c.low} low ` +
    `(deps: ${scan.dependencyAuditAvailable ? 'audited' : 'not audited'}).\n` +
    scan.report;

  // CRITICAL findings block the build (the task contract / Iron Law 2).
  if (scan.blocked) {
    const crits = scan.findings
      .filter((f) => f.severity === 'critical')
      .slice(0, 8)
      .map((f) => `${f.category} @ ${f.file}${f.line > 0 ? `:${f.line}` : ''} (${f.rule})`)
      .join('; ');
    return fail(
      'security_scan',
      `${c.critical} CRITICAL security finding(s) — build blocked: ${crits}`,
      summary,
      durationMs
    );
  }
  // High/medium/low findings are surfaced but do not block (only critical blocks).
  const noteCount = c.high + c.medium + c.low;
  return pass(
    'security_scan',
    noteCount > 0
      ? `no critical findings (${c.high} high, ${c.medium} medium, ${c.low} low surfaced — non-blocking)`
      : 'no security findings',
    summary,
    durationMs
  );
}

// ---------------------------------------------------------------------------
// Check 11 (optional): Architecture Guard (cycles / god components / N+1 / dead code / …)
// ---------------------------------------------------------------------------

/** Map an {@link ArchitectureReport} into the Sentinel's {@link CheckResult} contract. */
function evaluateArchitectureGuard(report: ArchitectureReport, durationMs: number): CheckResult {
  // Nothing was analyzable — no source files parsed. Skip (no false failure): an empty project must
  // not fabricate an architectural violation.
  if (report.scannedFiles === 0) {
    return skip('architecture', 'no source files analyzed — architecture not evaluated');
  }

  const c = report.counts;
  const summary =
    `${report.violations.length} architectural violation(s) across ${report.scannedFiles} file(s): ` +
    `${c.high} high, ${c.medium} medium, ${c.low} low (${report.cycles.length} dependency cycle(s)).\n` +
    report.report;

  // HIGH-severity violations block the build (the task contract / Iron Law 2).
  if (report.blocked) {
    const worst = report.violations
      .filter((v) => v.severity === 'high')
      .slice(0, 8)
      .map((v) => `${v.type} @ ${v.file}${v.line > 0 ? `:${v.line}` : ''}`)
      .join('; ');
    return fail(
      'architecture',
      `${c.high} HIGH-severity architectural violation(s) — build blocked: ${worst}`,
      summary,
      durationMs
    );
  }
  // medium/low are surfaced but do not block (only high blocks).
  const noteCount = c.medium + c.low;
  return pass(
    'architecture',
    noteCount > 0
      ? `no high-severity violations (${c.medium} medium, ${c.low} low surfaced — non-blocking)`
      : 'no architectural anti-patterns',
    summary,
    durationMs
  );
}

// ---------------------------------------------------------------------------
// Check 12 (optional): Consensus Validation (independent multi-model cross-check)
// ---------------------------------------------------------------------------

/** Map a {@link ConsensusValidationResult} into the Sentinel's {@link CheckResult} contract. */
function evaluateConsensus(result: ConsensusValidationResult, durationMs: number): CheckResult {
  // Too few usable validators (panel unreachable) → SKIP (no false failure).
  if (result.usableValidators < MIN_VALIDATORS) {
    return skip(
      'consensus_validation',
      `only ${result.usableValidators} of ${result.totalValidators} validator(s) usable (need ≥${MIN_VALIDATORS}) — consensus not evaluated`
    );
  }

  const summary =
    `verdict ${result.verdict}; ${result.approvals}/${result.usableValidators} approved ` +
    `(requires ${result.requiredApprovals} for prompt_type '${result.promptType}'); ` +
    `${result.issueClusters.filter((c) => c.corroborated).length} corroborated issue(s); ` +
    `~$${result.costUsd.toFixed(4)}.\n` +
    result.report;

  // A generation that fails its prompt_type consensus requirement blocks the build (Iron Law 2).
  if (result.blocked) {
    return fail(
      'consensus_validation',
      `consensus ${result.verdict} — only ${result.approvals}/${result.usableValidators} validator(s) approved ` +
        `(prompt_type '${result.promptType}' requires ${result.requiredApprovals}); build blocked`,
      summary,
      durationMs
    );
  }
  return pass(
    'consensus_validation',
    result.verdict === 'VALIDATED_WITH_CONCERNS'
      ? `consensus with concerns — ${result.approvals}/${result.usableValidators} approved (requirement of ${result.requiredApprovals} met; concerns surfaced)`
      : `consensus validated — ${result.approvals}/${result.usableValidators} validator(s) approved`,
    summary,
    durationMs
  );
}

// ---------------------------------------------------------------------------
// Check 18 (optional): Consensus Proposal (independent proposals + peer critique round)
// ---------------------------------------------------------------------------

/** Map a {@link ConsensusProposalResult} into the Sentinel's {@link CheckResult} contract. */
function evaluateConsensusProposal(result: ConsensusProposalResult, durationMs: number): CheckResult {
  // Too few usable proposals (proposer panel unreachable) → SKIP (no false failure).
  if (result.usableProposals < MIN_PROPOSALS) {
    return skip(
      'consensus_proposal',
      `only ${result.usableProposals} of ${result.proposalsDrafted} proposal(s) usable (need ≥${MIN_PROPOSALS}) — round not evaluated`
    );
  }

  const summary =
    `${result.usableProposals}/${result.proposalsDrafted} proposal(s) drafted, ${result.critiquedProposals} critiqued; ` +
    `winner: ${result.winner ? `${result.winner.proposal.provider} (${result.winner.critique.verdict})` : 'none'}; ` +
    `~$${result.totalCostUsd.toFixed(4)}.\n` +
    result.report;

  // No proposal met its own critique's prompt_type requirement — nothing safe to carry forward.
  if (result.blocked) {
    return fail(
      'consensus_proposal',
      `no proposal reached consensus for prompt_type '${result.promptType}' ` +
        `(${result.critiquedProposals} critiqued, best did not meet its requirement); build blocked`,
      summary,
      durationMs
    );
  }
  return pass(
    'consensus_proposal',
    result.winner
      ? `winner: ${result.winner.proposal.provider} — verdict ${result.winner.critique.verdict} ` +
        `(${result.winner.critique.approvals}/${result.winner.critique.usableValidators} approved)`
      : 'proposal round not evaluated (skipped upstream)',
    summary,
    durationMs
  );
}

// ---------------------------------------------------------------------------
// Check 0 (optional): Migration Safety (PRE-MIGRATION gate — runs before the nine)
// ---------------------------------------------------------------------------

/** Map a {@link MigrationSafetyReport} into the Sentinel's {@link CheckResult} contract. */
function evaluateMigrationSafety(report: MigrationSafetyReport, durationMs: number): CheckResult {
  const breakages = [...report.rlsBreakages, ...report.fkBreakages];
  const unacknowledged = breakages.filter((b) => !b.acknowledged);
  const summary =
    `${report.statementCount} statement(s); ${report.destructiveOperations.length} destructive ` +
    `(${report.unconfirmed.length} unconfirmed), ${report.rlsBreakages.length} RLS + ${report.fkBreakages.length} FK breakage(s) ` +
    `(${unacknowledged.length} un-acknowledged); production source: ${report.productionSchemaSource}.\n` +
    report.report;

  // A blocked migration FAILS the gate (the migration must NOT be applied — Iron Law 2/3).
  if (report.blocked) {
    const reasons: string[] = [];
    if (report.unconfirmed.length > 0) {
      reasons.push(
        `${report.unconfirmed.length} unconfirmed destructive op(s): ` +
          report.unconfirmed.slice(0, 6).map((o) => `${o.type} ${[o.table, o.column].filter(Boolean).join('.') || '?'}`).join('; ')
      );
    }
    if (unacknowledged.length > 0) {
      reasons.push(
        `${unacknowledged.length} breakage(s): ` + unacknowledged.slice(0, 6).map((b) => b.message).join('; ')
      );
    }
    return fail('migration_safety', `migration BLOCKED — ${reasons.join(' | ')}`, summary, durationMs);
  }
  const note =
    report.destructiveOperations.length > 0
      ? `${report.destructiveOperations.length} destructive op(s) all confirmed; rollback + backup generated`
      : 'no destructive operations';
  return pass('migration_safety', `migration safe to apply (${note})`, summary, durationMs);
}

// ---------------------------------------------------------------------------
// Check 13 (optional): AgentShield Security Scan (grade B+ required)
// ---------------------------------------------------------------------------

/** Grades that satisfy the B+ requirement: A or B. */
const AGENT_SHIELD_PASSING_GRADES = new Set<SecurityGrade>(['A', 'B']);

function evaluateAgentShield(report: SecurityReport, durationMs: number): CheckResult {
  const totalFindings = report.findings.length;
  const summary =
    `AgentShield grade: ${report.grade} (${totalFindings} finding(s) across ${report.scannedPaths.length} path(s)).\n` +
    report.findings
      .slice(0, 20)
      .map(
        (f) =>
          `- [${f.severity}] ${f.category} @ ${f.file}${f.line !== undefined ? `:${f.line}` : ''}: ${f.message}`
      )
      .join('\n');

  if (!AGENT_SHIELD_PASSING_GRADES.has(report.grade)) {
    return fail(
      'agent_shield',
      `AgentShield grade ${report.grade} is below the required B+ — build blocked`,
      summary,
      durationMs
    );
  }
  return pass(
    'agent_shield',
    `AgentShield grade ${report.grade} meets B+ requirement (${totalFindings} finding(s))`,
    summary,
    durationMs
  );
}

// ---------------------------------------------------------------------------
// Check 14 (optional): Live Schema Drift (code vs live database — requires schemaSql)
// ---------------------------------------------------------------------------

// Evaluation is delegated to the existing `evaluateSchemaDrift` — same semantics (additions ok,
// modifications/deletions fail). The difference from the mandatory `schema_drift` check is that
// this check REQUIRES a live SQL executor and always runs when configured, regardless of whether
// schema prompts have executed.

// ---------------------------------------------------------------------------
// Check 15 (optional): Dead Code Scan (report only — never blocks)
// ---------------------------------------------------------------------------

function evaluateDeadCode(report: DeadCodeReport, durationMs: number): CheckResult {
  const total = report.unusedImports.length + report.unusedVariables.length + report.unusedExports.length;
  const summary = formatDeadCodeReport(report);
  return pass(
    'dead_code',
    total > 0
      ? `dead code: ${report.unusedImports.length} unused import(s), ${report.unusedVariables.length} unused variable(s), ${report.unusedExports.length} unused export(s) across ${report.scannedFiles} file(s) (report only — non-blocking)`
      : `no dead code found (${report.scannedFiles} file(s) scanned)`,
    summary,
    durationMs
  );
}

// ---------------------------------------------------------------------------
// Check 16 (optional): Six Laws Verification (governance-gate)
// ---------------------------------------------------------------------------

function evaluateSixLaws(result: SixLawsResult, durationMs: number): CheckResult {
  const evaluatedLaws = result.laws.filter((l) => !l.skipped);
  const failedLaws = evaluatedLaws.filter((l) => !l.passed);

  if (result.passed) {
    return pass(
      'six_laws',
      `all ${evaluatedLaws.length} evaluated Six Law(s) passed`,
      result.report,
      durationMs
    );
  }
  const failDetail = failedLaws.map((l) => `Law ${l.law} (${l.name})`).join(', ');
  return fail(
    'six_laws',
    `${failedLaws.length} of ${evaluatedLaws.length} law(s) failed: ${failDetail}`,
    result.report,
    durationMs
  );
}

// ---------------------------------------------------------------------------
// Ring 2 — Every-10th-prompt gate (Vitest, Semgrep, knip)
// ---------------------------------------------------------------------------

/** Output shape from `npx vitest run --reporter=json` (partial — fields we use). */
interface VitestJsonOutput {
  numPassedTests?: number;
  numFailedTests?: number;
  numTotalTests?: number;
}

/** Shape of Istanbul/v8 `coverage/coverage-summary.json` — only the `total` bucket. */
interface CoverageSummaryJson {
  total?: { lines?: { pct?: number } };
}

/**
 * Ring 2a: Vitest check.
 * Runs `npx vitest run --reporter=json` (exactly as specified). Skips when no vitest config file
 * is present. Threshold: 0 failing tests AND line coverage ≥ coverageThreshold (default 60%).
 * Coverage data is read from `coverage/coverage-summary.json` when present (written by vitest's
 * coverage provider when `coverage.enabled: true` in the config); if absent, coverage is skipped
 * (graceful — no coverage provider is not a failure).
 * Registers failures to the learning DB.
 */
async function runRing2VitestCheck(
  projectPath: string,
  run: CommandRunner,
  log: (m: string) => void,
  coverageThreshold = 60
): Promise<CheckResult> {
  const configPaths = [
    join(projectPath, 'vitest.config.ts'),
    join(projectPath, 'vitest.config.js'),
    join(projectPath, 'vitest.config.mts'),
  ];
  const hasConfig = configPaths.some((p) => existsSync(p));
  if (!hasConfig) {
    return skip('vitest', 'vitest.config.ts not found — Ring 2 Vitest check skipped');
  }

  const startedAt = nowMs();
  const res = await run('npx vitest run --reporter=json', projectPath, 5 * 60 * 1000);
  const durationMs = nowMs() - startedAt;
  const combined = [res.stdout, res.stderr].filter((s) => s.trim() !== '').join('\n');
  logFullOutputIfTruncated(log, 'vitest', combined);

  if (res.timedOut) {
    return fail('vitest', 'Vitest TIMED OUT after 300s', combined, durationMs);
  }

  // Parse the JSON blob from stdout (vitest emits JSON to stdout with --reporter=json).
  let parsed: VitestJsonOutput | null = null;
  try {
    const firstBrace = res.stdout.indexOf('{');
    if (firstBrace >= 0) {
      parsed = JSON.parse(res.stdout.slice(firstBrace)) as VitestJsonOutput;
    }
  } catch {
    parsed = null;
  }

  const failedTests = parsed?.numFailedTests ?? (res.ok ? 0 : 1);
  const totalTests = parsed?.numTotalTests ?? 0;

  if (failedTests > 0) {
    tryRegisterRing1Error(
      { file: projectPath, code: 'VITEST_FAILURES', message: `${failedTests} test(s) failed`, category: 'COMPILE' },
      log
    );
    return fail('vitest', `Vitest: ${failedTests} test(s) failed of ${totalTests} total`, clip(combined), durationMs);
  }

  // Read coverage from `coverage/coverage-summary.json` when present (Istanbul / v8 provider).
  let lineCoverage: number | null = null;
  const coverageSummaryPath = join(projectPath, 'coverage', 'coverage-summary.json');
  const coverageRaw = await readTextSafe(coverageSummaryPath);
  if (coverageRaw) {
    try {
      const covJson = JSON.parse(coverageRaw) as CoverageSummaryJson;
      const pct = covJson.total?.lines?.pct;
      if (typeof pct === 'number') lineCoverage = pct;
    } catch {
      log('WARNING: Ring 2 Vitest — coverage-summary.json could not be parsed; coverage check skipped');
    }
  }

  if (lineCoverage !== null && lineCoverage < coverageThreshold) {
    tryRegisterRing1Error(
      {
        file: projectPath,
        code: 'VITEST_COVERAGE',
        message: `Line coverage ${lineCoverage.toFixed(1)}% is below ${coverageThreshold}% threshold`,
        category: 'COMPILE',
      },
      log
    );
    return fail('vitest', `Vitest: coverage ${lineCoverage.toFixed(1)}% < ${coverageThreshold}% threshold`, clip(combined), durationMs);
  }

  const coverageNote = lineCoverage !== null ? `, coverage ${lineCoverage.toFixed(1)}%` : ' (coverage data unavailable — not checked)';
  return pass('vitest', `Vitest: ${totalTests} test(s) passed${coverageNote}`, clip(combined), durationMs);
}

/** A single Semgrep finding from `npx semgrep --config=auto --json`. */
interface SemgrepFinding {
  check_id?: string;
  path?: string;
  start?: { line?: number };
  extra?: { severity?: string; message?: string };
}
interface SemgrepJsonOutput {
  results?: SemgrepFinding[];
}

/**
 * Ring 2b: Semgrep SAST check.
 * Runs `npx semgrep --config=auto --config=p/owasp-top-ten --json` — the default `auto` ruleset
 * plus the OWASP Top Ten ruleset, so injection, broken auth, XSS, SSRF, and the rest of the OWASP
 * Top Ten class of findings are covered explicitly, not just whatever `auto` happens to select.
 * Skips when semgrep is not installed.
 * Threshold: 0 `severity=ERROR` findings. WARNING findings are surfaced but pass.
 * Registers ERROR findings to the learning DB.
 */
export async function runRing2SemgrepCheck(
  projectPath: string,
  run: CommandRunner,
  log: (m: string) => void
): Promise<CheckResult> {
  const startedAt = nowMs();
  const res = await run('npx semgrep --config=auto --config=p/owasp-top-ten --json', projectPath, 5 * 60 * 1000);
  const durationMs = nowMs() - startedAt;
  const combined = [res.stdout, res.stderr].filter((s) => s.trim() !== '').join('\n');
  logFullOutputIfTruncated(log, 'semgrep', combined);

  if (res.timedOut) {
    return fail('semgrep', 'Semgrep TIMED OUT after 300s', combined, durationMs);
  }

  // Skip when semgrep is not installed (command not found).
  if (/command not found|is not recognized|Cannot find module|no such file|ENOENT|not installed/i.test(combined)) {
    return skip('semgrep', 'semgrep not installed — Ring 2 Semgrep check skipped');
  }

  // Try to parse JSON output.
  const jsonStr = res.stdout.trim();
  let parsed: SemgrepJsonOutput | null = null;
  try {
    const firstBrace = jsonStr.indexOf('{');
    if (firstBrace >= 0) {
      parsed = JSON.parse(jsonStr.slice(firstBrace)) as SemgrepJsonOutput;
    }
  } catch {
    parsed = null;
  }

  if (parsed === null && !res.ok) {
    return fail('semgrep', `Semgrep exited ${res.exitCode ?? 'null'} without JSON: ${firstLine(combined)}`, clip(combined), durationMs);
  }

  const findings = parsed?.results ?? [];
  const errorFindings = findings.filter(
    (f) => (f.extra?.severity ?? '').toUpperCase() === 'ERROR'
  );

  for (const f of errorFindings) {
    tryRegisterRing1Error(
      {
        file: f.path ?? projectPath,
        code: f.check_id ?? 'SEMGREP_ERROR',
        message: f.extra?.message ?? 'Semgrep ERROR finding',
        category: 'COMPILE',
      },
      log
    );
  }

  if (errorFindings.length > 0) {
    const firstError = errorFindings[0]!;
    const detail = `Semgrep: ${errorFindings.length} ERROR finding(s) — ${firstError.check_id ?? 'rule'} at ${firstError.path ?? '?'}:${firstError.start?.line ?? '?'}`;
    const output = errorFindings
      .map((f) => `[ERROR] ${f.check_id ?? 'rule'} at ${f.path ?? '?'}:${f.start?.line ?? '?'}: ${f.extra?.message ?? ''}`)
      .join('\n');
    return fail('semgrep', detail, output, durationMs);
  }

  const warnCount = findings.filter((f) => (f.extra?.severity ?? '').toUpperCase() === 'WARNING').length;
  const note = warnCount > 0 ? ` (${warnCount} warning(s) surfaced — non-blocking)` : '';
  return pass('semgrep', `Semgrep: 0 ERROR finding(s)${note}`, clip(combined), durationMs);
}

/** Shape of `npx knip --reporter json` output. */
interface KnipJsonOutput {
  files?: string[];
  issues?: {
    exports?: Array<{ name?: string; pos?: number; col?: number; filePath?: string }>;
    types?: Array<{ name?: string; filePath?: string }>;
    duplicates?: Array<{ name?: string; filePath?: string }>;
    unlisted?: Array<{ name?: string; filePath?: string }>;
    unresolved?: Array<{ name?: string; filePath?: string }>;
  };
}

/**
 * Ring 2c: knip dead-code check.
 * Runs `npx knip --reporter json`. Skips when knip is not installed.
 * Threshold: 0 unused exports.
 * Registers failures to the learning DB.
 */
async function runRing2KnipCheck(
  projectPath: string,
  run: CommandRunner,
  log: (m: string) => void
): Promise<CheckResult> {
  const startedAt = nowMs();
  const res = await run('npx knip --reporter json', projectPath, 5 * 60 * 1000);
  const durationMs = nowMs() - startedAt;
  const combined = [res.stdout, res.stderr].filter((s) => s.trim() !== '').join('\n');
  logFullOutputIfTruncated(log, 'knip', combined);

  if (res.timedOut) {
    return fail('knip', 'knip TIMED OUT after 300s', combined, durationMs);
  }

  // Skip when knip is not installed.
  if (/command not found|is not recognized|Cannot find module|no such file|ENOENT|not installed/i.test(combined)) {
    return skip('knip', 'knip not installed — Ring 2 knip check skipped');
  }

  // Parse JSON output.
  const jsonStr = res.stdout.trim();
  let parsed: KnipJsonOutput | null = null;
  try {
    const firstBrace = jsonStr.indexOf('{');
    const firstBracket = jsonStr.indexOf('[');
    const startIdx =
      firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket) ? firstBrace : firstBracket;
    if (startIdx >= 0) {
      parsed = JSON.parse(jsonStr.slice(startIdx)) as KnipJsonOutput;
    }
  } catch {
    parsed = null;
  }

  if (parsed === null) {
    // knip exits non-zero when it finds issues; if JSON is missing but exit is ok, treat as clean.
    if (res.ok) {
      return pass('knip', 'knip: 0 unused exports', clip(combined), durationMs);
    }
    return fail('knip', `knip exited ${res.exitCode ?? 'null'} without parseable JSON: ${firstLine(combined)}`, clip(combined), durationMs);
  }

  const unusedExports = parsed.issues?.exports ?? [];
  const unusedCount = unusedExports.length;

  if (unusedCount > 0) {
    const first = unusedExports[0]!;
    tryRegisterRing1Error(
      {
        file: first.filePath ?? projectPath,
        code: 'KNIP_UNUSED_EXPORT',
        message: `${unusedCount} unused export(s) detected by knip`,
        category: 'LINT',
      },
      log
    );
    const detail = `knip: ${unusedCount} unused export(s) — first: ${first.name ?? '?'} in ${first.filePath ?? '?'}`;
    const output = unusedExports
      .slice(0, 50)
      .map((e) => `${e.filePath ?? '?'}: ${e.name ?? '?'}`)
      .join('\n');
    return fail('knip', detail, output, durationMs);
  }

  return pass('knip', 'knip: 0 unused exports', clip(combined), durationMs);
}

/**
 * Determine whether Ring 2 should fire on this prompt.
 * Fires when `promptNumber % 10 === 0` OR when `isFinalPrompt` is true.
 */
export function shouldFireRing2(promptNumber: number, isFinalPrompt = false): boolean {
  return isFinalPrompt || (promptNumber > 0 && promptNumber % 10 === 0);
}

// ---------------------------------------------------------------------------
// Ring 3 — End-of-run gate (Trivy, Gitleaks, Lighthouse)
// ---------------------------------------------------------------------------

/**
 * Determine whether Ring 3 should fire.
 * Fires when `isFinalPrompt` is true OR when `forceRun` is true (explicit `forge sentinel --ring 3`).
 */
export function shouldFireRing3(isFinalPrompt = false, forceRun = false): boolean {
  return isFinalPrompt || forceRun;
}

/** Partial shape of `trivy fs --format json` output. */
interface TrivyResult {
  Results?: Array<{
    Target?: string;
    Vulnerabilities?: Array<{
      VulnerabilityID?: string;
      Severity?: string;
      PkgName?: string;
      Title?: string;
    }>;
  }>;
}

/**
 * Ring 3a: Trivy vulnerability scan.
 * Runs `trivy fs --severity CRITICAL,HIGH --format json --quiet .`.
 * Skips gracefully when trivy binary is not in PATH.
 * Threshold: 0 CRITICAL + 0 HIGH CVEs.
 */
export async function runRing3TrivyCheck(
  projectPath: string,
  run: CommandRunner,
  log: (m: string) => void
): Promise<CheckResult> {
  const startedAt = nowMs();
  const res = await run(
    'trivy fs --severity CRITICAL,HIGH --format json --quiet .',
    projectPath,
    5 * 60 * 1000
  );
  const durationMs = nowMs() - startedAt;
  const combined = [res.stdout, res.stderr].filter((s) => s.trim() !== '').join('\n');
  logFullOutputIfTruncated(log, 'trivy', combined);

  if (res.timedOut) {
    return fail('trivy', 'Trivy TIMED OUT after 300s', combined, durationMs);
  }

  const notInstalled =
    /command not found|is not recognized|no such file|ENOENT|not installed/i.test(combined) &&
    !res.stdout.trim().startsWith('{');
  if (notInstalled) {
    return skip('trivy', 'trivy not installed or not in PATH — Ring 3 Trivy check skipped');
  }

  // Parse JSON output.
  let parsed: TrivyResult | null = null;
  try {
    const firstBrace = res.stdout.indexOf('{');
    if (firstBrace >= 0) {
      parsed = JSON.parse(res.stdout.slice(firstBrace)) as TrivyResult;
    }
  } catch {
    parsed = null;
  }

  if (parsed === null) {
    if (!res.ok) {
      return fail(
        'trivy',
        `Trivy exited ${res.exitCode ?? 'null'} without JSON: ${firstLine(combined)}`,
        clip(combined),
        durationMs
      );
    }
    // exit 0 but no JSON — treat as clean (some versions print nothing when no vulns found).
    return pass('trivy', 'Trivy: 0 CRITICAL/HIGH CVEs (no JSON output; exit 0)', combined, durationMs);
  }

  const vulns = (parsed.Results ?? []).flatMap((r) => r.Vulnerabilities ?? []);
  const critical = vulns.filter((v) => (v.Severity ?? '').toUpperCase() === 'CRITICAL');
  const high = vulns.filter((v) => (v.Severity ?? '').toUpperCase() === 'HIGH');

  const summary =
    `Trivy scanned ${(parsed.Results ?? []).length} target(s): ${critical.length} CRITICAL, ${high.length} HIGH CVE(s).\n` +
    vulns
      .slice(0, 30)
      .map(
        (v) =>
          `[${v.Severity ?? '?'}] ${v.VulnerabilityID ?? '?'} in ${v.PkgName ?? '?'}${v.Title ? `: ${v.Title}` : ''}`
      )
      .join('\n');

  if (critical.length > 0 || high.length > 0) {
    const worst = [...critical, ...high]
      .slice(0, 8)
      .map((v) => `${v.VulnerabilityID ?? '?'} (${v.Severity ?? '?'}) in ${v.PkgName ?? '?'}`)
      .join('; ');
    tryRegisterRing1Error(
      {
        file: projectPath,
        code: 'TRIVY_VULNERABILITY',
        message: `${critical.length} CRITICAL + ${high.length} HIGH CVEs found by Trivy: ${worst}`,
        category: 'COMPILE',
      },
      log
    );
    return fail(
      'trivy',
      `Trivy: ${critical.length} CRITICAL + ${high.length} HIGH CVE(s) — build blocked: ${worst}`,
      summary,
      durationMs
    );
  }

  return pass(
    'trivy',
    `Trivy: 0 CRITICAL/HIGH CVEs (${vulns.length} total finding(s) at lower severity)`,
    summary,
    durationMs
  );
}

/** A single Gitleaks finding from the JSON report. */
interface GitleaksFinding {
  RuleID?: string;
  Match?: string;
  Secret?: string;
  File?: string;
  StartLine?: number;
  Description?: string;
}

/**
 * Ring 3b: Gitleaks secret scan.
 * Runs `gitleaks detect --source=. --report-format json --report-path .forge/gitleaks-report.json --exit-code 0`.
 * The `--exit-code 0` flag makes gitleaks always exit 0; findings are read from the report file.
 * Skips gracefully when gitleaks binary is not in PATH.
 * Threshold: 0 findings.
 */
export async function runRing3GitleaksCheck(
  projectPath: string,
  run: CommandRunner,
  log: (m: string) => void
): Promise<CheckResult> {
  const startedAt = nowMs();
  const reportPath = join(projectPath, '.forge', 'gitleaks-report.json');

  const res = await run(
    'gitleaks detect --source=. --report-format json --report-path .forge/gitleaks-report.json --exit-code 0',
    projectPath,
    3 * 60 * 1000
  );
  const durationMs = nowMs() - startedAt;
  const combined = [res.stdout, res.stderr].filter((s) => s.trim() !== '').join('\n');
  logFullOutputIfTruncated(log, 'gitleaks', combined);

  if (res.timedOut) {
    return fail('gitleaks', 'Gitleaks TIMED OUT after 180s', combined, durationMs);
  }

  if (/command not found|is not recognized|no such file|ENOENT|not installed/i.test(combined)) {
    return skip('gitleaks', 'gitleaks not installed or not in PATH — Ring 3 Gitleaks check skipped');
  }

  // Read the report file (only written by gitleaks when findings are present).
  let findings: GitleaksFinding[] = [];
  const reportContent = await readTextSafe(reportPath);
  if (reportContent) {
    try {
      const parsed = JSON.parse(reportContent) as unknown;
      if (Array.isArray(parsed)) {
        findings = parsed as GitleaksFinding[];
      }
    } catch {
      log('WARNING: Ring 3 Gitleaks — report JSON could not be parsed');
    }
  }

  const summary =
    `Gitleaks detected ${findings.length} secret(s).\n` +
    findings
      .slice(0, 20)
      .map(
        (f) =>
          `[${f.RuleID ?? '?'}] ${f.Description ?? f.Match ?? '?'} in ${f.File ?? '?'}${
            f.StartLine !== undefined ? `:${f.StartLine}` : ''
          }`
      )
      .join('\n');

  if (findings.length > 0) {
    const first = findings[0]!;
    tryRegisterRing1Error(
      {
        file: first.File ?? projectPath,
        code: 'GITLEAKS_SECRET',
        message: `${findings.length} secret(s) detected: ${first.RuleID ?? '?'} at ${first.File ?? '?'}`,
        category: 'COMPILE',
      },
      log
    );
    return fail(
      'gitleaks',
      `Gitleaks: ${findings.length} secret(s) detected — build blocked`,
      summary,
      durationMs
    );
  }

  return pass('gitleaks', 'Gitleaks: 0 secrets detected', summary, durationMs);
}

/** Partial shape of a Lighthouse JSON report. */
interface LighthouseCategory {
  id?: string;
  title?: string;
  score?: number | null;
}
interface LighthouseReport {
  categories?: Record<string, LighthouseCategory | undefined>;
}

/** Port used by the dev server spawned for Ring 3 Lighthouse. */
const LIGHTHOUSE_DEV_PORT = 3099;
/** Minimum Lighthouse category score (0–100) to pass the gate. */
const LIGHTHOUSE_THRESHOLD = 90;
/** Categories evaluated by the gate. */
const LIGHTHOUSE_AUDITED_CATS = new Set(['performance', 'accessibility', 'best-practices', 'seo']);

/** Poll `url` until it responds with HTTP < 500 or `timeoutMs` elapses. Never throws. */
async function waitForDevServer(
  url: string,
  timeoutMs: number,
  log: (m: string) => void
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const POLL_MS = 1000;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.status < 500) return true;
    } catch {
      // Not ready yet — swallow and poll again.
    }
    await new Promise<void>((r) => setTimeout(r, POLL_MS));
    log(`Ring 3c: waiting for dev server at ${url}…`);
  }
  return false;
}

/** Kill a spawned child process (guarded; null-safe). */
function killChildProcess(proc: ChildProcess | null, log: (m: string) => void): void {
  if (!proc) return;
  try {
    if (!proc.killed) proc.kill('SIGTERM');
  } catch (err) {
    log(
      `WARNING: Ring 3 Lighthouse — could not kill dev server (${err instanceof Error ? err.message : String(err)})`
    );
  }
}

/**
 * Ring 3c: Lighthouse performance / accessibility / best-practices / SEO audit.
 * Starts a dev server on port 3099, runs Lighthouse, stops the dev server.
 * Skips gracefully when lighthouse is not installed or the dev server does not start.
 * Threshold: all four categories ≥ 90.
 */
export async function runRing3LighthouseCheck(
  projectPath: string,
  run: CommandRunner,
  log: (m: string) => void
): Promise<CheckResult> {
  const startedAt = nowMs();
  const reportPath = join(projectPath, '.forge', 'lighthouse.json');
  const devUrl = `http://localhost:${LIGHTHOUSE_DEV_PORT}`;

  // Fast-path: check if lighthouse is installed before spinning up a dev server.
  const versionRes = await run('lighthouse --version', projectPath, 10_000);
  const versionOut = [versionRes.stdout, versionRes.stderr]
    .filter((s) => s.trim() !== '')
    .join('\n');
  if (
    /command not found|is not recognized|no such file|ENOENT|not installed/i.test(versionOut) ||
    (!versionRes.ok && !versionRes.stdout.trim())
  ) {
    return skip('lighthouse', 'lighthouse not installed or not in PATH — Ring 3 Lighthouse check skipped');
  }

  // Spawn the dev server.
  log(`Ring 3c: starting dev server on port ${LIGHTHOUSE_DEV_PORT} for Lighthouse audit`);
  let devServer: ChildProcess | null = null;
  try {
    devServer = spawn('pnpm', ['dev', '--port', String(LIGHTHOUSE_DEV_PORT)], {
      cwd: projectPath,
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  } catch (err) {
    log(
      `WARNING: Ring 3 Lighthouse — could not spawn dev server (${err instanceof Error ? err.message : String(err)})`
    );
    return skip('lighthouse', 'dev server could not be spawned — Lighthouse check skipped');
  }

  // Wait for the dev server to accept connections (up to 30 s).
  const ready = await waitForDevServer(devUrl, 30_000, log);
  if (!ready) {
    killChildProcess(devServer, log);
    return skip(
      'lighthouse',
      `dev server on port ${LIGHTHOUSE_DEV_PORT} did not become ready within 30s — Lighthouse check skipped`
    );
  }

  // Run Lighthouse against the live server.
  log(`Ring 3c: running Lighthouse against ${devUrl}`);
  const lhRes = await run(
    `lighthouse ${devUrl} --chrome-flags="--headless --no-sandbox" --output=json --output-path=.forge/lighthouse.json`,
    projectPath,
    3 * 60 * 1000
  );
  const lhCombined = [lhRes.stdout, lhRes.stderr].filter((s) => s.trim() !== '').join('\n');
  logFullOutputIfTruncated(log, 'lighthouse', lhCombined);

  // Always stop the dev server.
  killChildProcess(devServer, log);

  const durationMs = nowMs() - startedAt;

  if (lhRes.timedOut) {
    return fail('lighthouse', 'Lighthouse TIMED OUT after 180s', lhCombined, durationMs);
  }
  if (
    /command not found|is not recognized|ENOENT|not found/i.test(lhCombined) &&
    !lhRes.ok
  ) {
    return skip('lighthouse', 'lighthouse binary not found during run — Lighthouse check skipped');
  }

  // Read and parse the output file.
  const reportContent = await readTextSafe(reportPath);
  if (!reportContent) {
    if (!lhRes.ok) {
      return fail(
        'lighthouse',
        `Lighthouse exited ${lhRes.exitCode ?? 'null'}: ${firstLine(lhCombined)}`,
        clip(lhCombined),
        durationMs
      );
    }
    return skip('lighthouse', 'Lighthouse report not found at .forge/lighthouse.json — not evaluated');
  }

  let report: LighthouseReport | null = null;
  try {
    report = JSON.parse(reportContent) as LighthouseReport;
  } catch {
    return fail(
      'lighthouse',
      'Lighthouse report JSON could not be parsed',
      clip(reportContent),
      durationMs
    );
  }

  const cats = report?.categories ?? {};
  const audited: { key: string; name: string; score: number }[] = [];
  const failing: { key: string; name: string; score: number }[] = [];

  for (const [key, cat] of Object.entries(cats)) {
    if (!cat) continue;
    const rawScore = cat.score;
    if (rawScore === null || rawScore === undefined) continue;
    const scorePct = Math.round(rawScore * 100);
    const name = cat.title ?? key;
    audited.push({ key, name, score: scorePct });
    if (LIGHTHOUSE_AUDITED_CATS.has(key) && scorePct < LIGHTHOUSE_THRESHOLD) {
      failing.push({ key, name, score: scorePct });
    }
  }

  const summary =
    `Lighthouse scores (threshold ${LIGHTHOUSE_THRESHOLD}): ` +
    audited.map((a) => `${a.name} ${a.score}`).join(', ');

  if (failing.length > 0) {
    const worst = failing.map((f) => `${f.name}: ${f.score}`).join(', ');
    tryRegisterRing1Error(
      {
        file: projectPath,
        code: 'LIGHTHOUSE_LOW_SCORE',
        message: `Lighthouse scores below ${LIGHTHOUSE_THRESHOLD}: ${worst}`,
        category: 'COMPILE',
      },
      log
    );
    return fail(
      'lighthouse',
      `Lighthouse: ${failing.length} category(ies) below ${LIGHTHOUSE_THRESHOLD}: ${worst}`,
      summary,
      durationMs
    );
  }

  return pass(
    'lighthouse',
    `Lighthouse: all categories ≥ ${LIGHTHOUSE_THRESHOLD} — ${audited.map((a) => `${a.name} ${a.score}`).join(', ')}`,
    summary,
    durationMs
  );
}

/** Port used by the dev server spawned for Ring 3 OWASP ZAP DAST scan. */
const ZAP_DEV_PORT = 3098;
/** ZAP alert `riskcode`: '3' = High, '2' = Medium, '1' = Low, '0' = Informational. High blocks. */
const ZAP_HIGH_RISK_CODE = '3';
const ZAP_MEDIUM_RISK_CODE = '2';

/** One alert from a `zap-baseline.py -J` report. */
interface ZapAlert {
  pluginid?: string;
  alert?: string;
  name?: string;
  riskcode?: string;
  riskdesc?: string;
  confidence?: string;
  desc?: string;
  instances?: Array<{ uri?: string; method?: string }>;
}
interface ZapSite {
  '@name'?: string;
  alerts?: ZapAlert[];
}
/** Shape of a `zap-baseline.py -J <path>` JSON report. */
interface ZapBaselineReport {
  site?: ZapSite[];
}

/**
 * Ring 3d: OWASP ZAP DAST (dynamic application security testing) baseline scan.
 * Starts a dev server on port {@link ZAP_DEV_PORT}, runs `zap-baseline.py` against it, stops the
 * dev server. Skips gracefully when `zap-baseline.py` is not installed or the dev server does not
 * start. Threshold: 0 High-risk alerts (`riskcode=3`); Medium/Low/Informational are surfaced but
 * pass — matching the OWASP ZAP baseline scan's own severity model.
 */
export async function runRing3ZapCheck(
  projectPath: string,
  run: CommandRunner,
  log: (m: string) => void
): Promise<CheckResult> {
  const startedAt = nowMs();
  const reportPath = join(projectPath, '.forge', 'zap-report.json');
  const devUrl = `http://localhost:${ZAP_DEV_PORT}`;

  // Fast-path: check if zap-baseline.py is installed before spinning up a dev server.
  const versionRes = await run('zap-baseline.py -h', projectPath, 15_000);
  const versionOut = [versionRes.stdout, versionRes.stderr].filter((s) => s.trim() !== '').join('\n');
  if (
    /command not found|is not recognized|no such file|ENOENT|not installed/i.test(versionOut) ||
    (!versionRes.ok && !versionOut.trim())
  ) {
    return skip('owasp_zap', 'zap-baseline.py not installed or not in PATH — Ring 3 OWASP ZAP check skipped');
  }

  // Spawn the dev server.
  log(`Ring 3d: starting dev server on port ${ZAP_DEV_PORT} for OWASP ZAP DAST scan`);
  let devServer: ChildProcess | null = null;
  try {
    devServer = spawn('pnpm', ['dev', '--port', String(ZAP_DEV_PORT)], {
      cwd: projectPath,
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  } catch (err) {
    log(`WARNING: Ring 3 OWASP ZAP — could not spawn dev server (${err instanceof Error ? err.message : String(err)})`);
    return skip('owasp_zap', 'dev server could not be spawned — OWASP ZAP check skipped');
  }

  // Wait for the dev server to accept connections (up to 30 s).
  const ready = await waitForDevServer(devUrl, 30_000, log);
  if (!ready) {
    killChildProcess(devServer, log);
    return skip(
      'owasp_zap',
      `dev server on port ${ZAP_DEV_PORT} did not become ready within 30s — OWASP ZAP check skipped`
    );
  }

  // Run the ZAP baseline scan against the live server. `-m 5` caps the passive-scan spider at 5
  // minutes so a stuck/slow app can't hang the gate; `-J` always writes the report file regardless
  // of the scan's own exit code (0 = no alerts above threshold, 1 = warn, 2 = fail, 3 = error).
  log(`Ring 3d: running OWASP ZAP baseline scan against ${devUrl}`);
  const zapRes = await run(
    `zap-baseline.py -t ${devUrl} -J .forge/zap-report.json -m 5`,
    projectPath,
    8 * 60 * 1000
  );
  const zapCombined = [zapRes.stdout, zapRes.stderr].filter((s) => s.trim() !== '').join('\n');
  logFullOutputIfTruncated(log, 'owasp_zap', zapCombined);

  // Always stop the dev server.
  killChildProcess(devServer, log);

  const durationMs = nowMs() - startedAt;

  if (zapRes.timedOut) {
    return fail('owasp_zap', 'OWASP ZAP baseline scan TIMED OUT after 480s', zapCombined, durationMs);
  }

  // Read and parse the report file — it is written even when the scan's own exit code is non-zero.
  const reportContent = await readTextSafe(reportPath);
  if (!reportContent) {
    if (!zapRes.ok) {
      return fail(
        'owasp_zap',
        `OWASP ZAP exited ${zapRes.exitCode ?? 'null'}: ${firstLine(zapCombined)}`,
        clip(zapCombined),
        durationMs
      );
    }
    return skip('owasp_zap', 'OWASP ZAP report not found at .forge/zap-report.json — not evaluated');
  }

  let report: ZapBaselineReport | null = null;
  try {
    report = JSON.parse(reportContent) as ZapBaselineReport;
  } catch {
    return fail('owasp_zap', 'OWASP ZAP report JSON could not be parsed', clip(reportContent), durationMs);
  }

  const alerts = (report?.site ?? []).flatMap((s) => s.alerts ?? []);
  const highRisk = alerts.filter((a) => a.riskcode === ZAP_HIGH_RISK_CODE);
  const mediumRisk = alerts.filter((a) => a.riskcode === ZAP_MEDIUM_RISK_CODE);

  const summary =
    `OWASP ZAP baseline scan of ${devUrl}: ${alerts.length} alert(s) — ${highRisk.length} High, ${mediumRisk.length} Medium.\n` +
    alerts
      .slice(0, 30)
      .map(
        (a) =>
          `[${a.riskdesc ?? a.riskcode ?? '?'}] ${a.alert ?? a.name ?? '?'} (${(a.instances ?? []).length} instance(s))`
      )
      .join('\n');

  if (highRisk.length > 0) {
    const worst = highRisk.slice(0, 8).map((a) => a.alert ?? a.name ?? '?').join('; ');
    tryRegisterRing1Error(
      {
        file: projectPath,
        code: 'ZAP_HIGH_RISK_ALERT',
        message: `${highRisk.length} High-risk OWASP ZAP alert(s): ${worst}`,
        category: 'COMPILE',
      },
      log
    );
    return fail(
      'owasp_zap',
      `OWASP ZAP: ${highRisk.length} High-risk alert(s) — build blocked: ${worst}`,
      summary,
      durationMs
    );
  }

  const note = mediumRisk.length > 0 ? ` (${mediumRisk.length} Medium-risk alert(s) surfaced — non-blocking)` : '';
  return pass('owasp_zap', `OWASP ZAP: 0 High-risk alerts${note}`, summary, durationMs);
}

/** Port used by the dev server spawned for Ring 3 Schemathesis API contract scan. */
const SCHEMATHESIS_DEV_PORT = 3097;
/** Well-known paths probed to discover a booted app's OpenAPI/Swagger schema. */
const OPENAPI_SCHEMA_CANDIDATE_PATHS = [
  '/api/openapi.json',
  '/api/swagger.json',
  '/openapi.json',
  '/swagger.json',
  '/api-docs/openapi.json',
  '/api/docs/openapi.json',
];

/**
 * Probe a booted dev server for an OpenAPI/Swagger schema at common well-known paths. Returns the
 * first URL that responds HTTP 200 with a JSON body, or `null` when none do (never throws).
 */
async function discoverOpenApiSchemaUrl(baseUrl: string, log: (m: string) => void): Promise<string | null> {
  for (const p of OPENAPI_SCHEMA_CANDIDATE_PATHS) {
    const url = `${baseUrl}${p}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.status === 200) {
        const contentType = resp.headers.get('content-type') ?? '';
        if (/json|yaml/i.test(contentType) || p.endsWith('.json')) return url;
      }
    } catch {
      // Not found / server not ready for this candidate path — try the next one.
    }
  }
  log('Ring 3e: no OpenAPI/Swagger schema found at common well-known paths');
  return null;
}

/** Aggregate test/failure/error counts parsed from a JUnit XML report. */
interface JUnitTotals {
  tests: number;
  failures: number;
  errors: number;
}

/**
 * Extract aggregate `tests`/`failures`/`errors` totals from a JUnit XML report by summing every
 * `<testsuite>` tag's attributes. There is no XML parser dependency in this codebase (every other
 * check here reads its report as JSON or a flat report file — see Gitleaks/Lighthouse) so this is a
 * light, order-independent attribute regex scan rather than a full XML parse. Returns all-zero
 * totals for unparseable/empty input — never throws.
 */
export function parseJUnitTotals(xml: string): JUnitTotals {
  const totals: JUnitTotals = { tests: 0, failures: 0, errors: 0 };
  const tagRe = /<testsuite\b[^>]*>/g;
  let tagMatch: RegExpExecArray | null;
  let matchedAny = false;
  while ((tagMatch = tagRe.exec(xml)) !== null) {
    matchedAny = true;
    const tag = tagMatch[0];
    totals.tests += parseInt(/\btests="(\d+)"/.exec(tag)?.[1] ?? '0', 10);
    totals.failures += parseInt(/\bfailures="(\d+)"/.exec(tag)?.[1] ?? '0', 10);
    totals.errors += parseInt(/\berrors="(\d+)"/.exec(tag)?.[1] ?? '0', 10);
  }
  if (!matchedAny) return totals;
  return totals;
}

/** Extract up to `limit` failing/erroring `<testcase>` names + messages from a JUnit XML report. */
function extractJUnitFailures(xml: string, limit = 20): string[] {
  const out: string[] = [];
  const re = /<testcase\b[^>]*\bname="([^"]*)"[^>]*>[\s\S]*?<(?:failure|error)\b[^>]*?(?:\bmessage="([^"]*)")?[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && out.length < limit) {
    const name = m[1] ?? '?';
    const message = m[2] ?? '';
    out.push(message ? `${name}: ${message}` : name);
  }
  return out;
}

/**
 * Ring 3e: Schemathesis API contract testing.
 * Starts a dev server on port {@link SCHEMATHESIS_DEV_PORT}, discovers the app's OpenAPI/Swagger
 * schema at common well-known paths, runs `schemathesis run <schema> --checks all` against it, stops
 * the dev server. Skips gracefully when `schemathesis` is not installed, the dev server does not
 * start, or no schema is discoverable (not an API project, or the schema isn't exposed). Threshold:
 * 0 failing/erroring test cases in the JUnit report.
 */
export async function runRing3SchemathesisCheck(
  projectPath: string,
  run: CommandRunner,
  log: (m: string) => void
): Promise<CheckResult> {
  const startedAt = nowMs();
  const reportPath = join(projectPath, '.forge', 'schemathesis-report.xml');
  const devUrl = `http://localhost:${SCHEMATHESIS_DEV_PORT}`;

  // Fast-path: check if schemathesis is installed before spinning up a dev server.
  const versionRes = await run('schemathesis --version', projectPath, 10_000);
  const versionOut = [versionRes.stdout, versionRes.stderr].filter((s) => s.trim() !== '').join('\n');
  if (
    /command not found|is not recognized|no such file|ENOENT|not installed/i.test(versionOut) ||
    (!versionRes.ok && !versionOut.trim())
  ) {
    return skip('schemathesis', 'schemathesis not installed or not in PATH — Ring 3 Schemathesis check skipped');
  }

  // Spawn the dev server.
  log(`Ring 3e: starting dev server on port ${SCHEMATHESIS_DEV_PORT} for Schemathesis API contract scan`);
  let devServer: ChildProcess | null = null;
  try {
    devServer = spawn('pnpm', ['dev', '--port', String(SCHEMATHESIS_DEV_PORT)], {
      cwd: projectPath,
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  } catch (err) {
    log(`WARNING: Ring 3 Schemathesis — could not spawn dev server (${err instanceof Error ? err.message : String(err)})`);
    return skip('schemathesis', 'dev server could not be spawned — Schemathesis check skipped');
  }

  // Wait for the dev server to accept connections (up to 30 s).
  const ready = await waitForDevServer(devUrl, 30_000, log);
  if (!ready) {
    killChildProcess(devServer, log);
    return skip(
      'schemathesis',
      `dev server on port ${SCHEMATHESIS_DEV_PORT} did not become ready within 30s — Schemathesis check skipped`
    );
  }

  // Discover the OpenAPI/Swagger schema. No schema exposed → this isn't an API project (or the
  // schema isn't exposed yet) — skip, never a false failure.
  const schemaUrl = await discoverOpenApiSchemaUrl(devUrl, log);
  if (!schemaUrl) {
    killChildProcess(devServer, log);
    return skip(
      'schemathesis',
      'no OpenAPI/Swagger schema found at common well-known paths — Schemathesis check skipped'
    );
  }

  log(`Ring 3e: running Schemathesis contract tests against ${schemaUrl}`);
  const stRes = await run(
    `schemathesis run ${schemaUrl} --checks all --junit-xml=.forge/schemathesis-report.xml`,
    projectPath,
    5 * 60 * 1000
  );
  const stCombined = [stRes.stdout, stRes.stderr].filter((s) => s.trim() !== '').join('\n');
  logFullOutputIfTruncated(log, 'schemathesis', stCombined);

  // Always stop the dev server.
  killChildProcess(devServer, log);

  const durationMs = nowMs() - startedAt;

  if (stRes.timedOut) {
    return fail('schemathesis', 'Schemathesis TIMED OUT after 300s', stCombined, durationMs);
  }

  const reportContent = await readTextSafe(reportPath);
  if (!reportContent) {
    if (!stRes.ok) {
      return fail(
        'schemathesis',
        `Schemathesis exited ${stRes.exitCode ?? 'null'}: ${firstLine(stCombined)}`,
        clip(stCombined),
        durationMs
      );
    }
    return skip('schemathesis', 'Schemathesis report not found at .forge/schemathesis-report.xml — not evaluated');
  }

  const totals = parseJUnitTotals(reportContent);
  const failing = totals.failures + totals.errors;

  const summary =
    `Schemathesis tested ${schemaUrl}: ${totals.tests} test case(s), ${totals.failures} failure(s), ${totals.errors} error(s).\n` +
    extractJUnitFailures(reportContent).join('\n');

  if (failing > 0) {
    const firstFailures = extractJUnitFailures(reportContent, 5).join('; ');
    tryRegisterRing1Error(
      {
        file: schemaUrl,
        code: 'SCHEMATHESIS_CONTRACT_VIOLATION',
        message: `${failing} API contract violation(s) found by Schemathesis: ${firstFailures}`,
        category: 'COMPILE',
      },
      log
    );
    return fail(
      'schemathesis',
      `Schemathesis: ${failing} API contract violation(s) — build blocked: ${firstFailures}`,
      summary,
      durationMs
    );
  }

  return pass('schemathesis', `Schemathesis: ${totals.tests} test case(s), 0 contract violations`, summary, durationMs);
}

// ---------------------------------------------------------------------------
// Ring 1 — Enhanced per-prompt gate (TypeScript error parsing, ESLint, schema drift)
// ---------------------------------------------------------------------------

/** A TypeScript error parsed from `tsc --noEmit --pretty false` output. */
interface TscError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

/** Regex that matches a TypeScript compiler error line from `--pretty false` output. */
const TSC_ERROR_RE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;

/**
 * Parse TypeScript compiler errors out of `tsc --noEmit --pretty false` output.
 * Returns an empty array when the output contains no recognisable error lines.
 */
export function parseTscErrors(output: string): TscError[] {
  const errors: TscError[] = [];
  const re = new RegExp(TSC_ERROR_RE.source, TSC_ERROR_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    errors.push({
      file: (m[1] ?? '').trim(),
      line: parseInt(m[2] ?? '0', 10),
      col: parseInt(m[3] ?? '0', 10),
      code: m[4] ?? '',
      message: (m[5] ?? '').trim(),
    });
  }
  return errors;
}

/** Guarded: initialise the learning DB and register one Ring 1 error fingerprint. Never throws. */
function tryRegisterRing1Error(
  opts: { file: string; code: string; message: string; category: 'COMPILE' | 'LINT' | 'SCHEMA' },
  log: (m: string) => void
): void {
  try {
    initializeForgeMemory();
    registerError({
      errorCode: opts.code,
      filePath: opts.file,
      errorMessage: opts.message,
      errorCategory: opts.category,
      techStack: ['typescript', 'nodejs'],
    });
  } catch (err) {
    log(`WARNING: Ring 1 DB registration failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * Ring 1a: Enhanced TypeScript check.
 * Runs `npx tsc --noEmit --pretty false`, parses errors with {@link TSC_ERROR_RE},
 * registers each error fingerprint to the learning DB, and returns a {@link CheckResult}.
 * Threshold: 0 errors (any error fails the gate).
 */
async function runRing1TypescriptCheck(
  projectPath: string,
  timeoutMs: number,
  run: CommandRunner,
  log: (m: string) => void,
  hasPackageJson: boolean = fs.existsSync(path.join(projectPath, 'package.json')),
  hasLocalTsc: boolean = fs.existsSync(path.join(projectPath, 'node_modules', '.bin', 'tsc'))
): Promise<CheckResult> {
  if (!hasPackageJson) {
    log('sentinel: no package.json in project root — TypeScript check skipped (not a Node project yet)');
    return skip('typescript', 'Skipped — no package.json present; project has no TypeScript to check');
  }
  if (!hasLocalTsc) {
    log('sentinel: no local tsc binary found — TypeScript check skipped (typescript not installed)');
    return skip('typescript', 'Skipped — typescript not installed locally; run `npm install typescript` first');
  }
  const startedAt = nowMs();
  const res = await run('npx tsc --noEmit --pretty false', projectPath, timeoutMs);
  const durationMs = nowMs() - startedAt;
  const combined = [res.stdout, res.stderr].filter((s) => s.trim() !== '').join('\n');
  logFullOutputIfTruncated(log, 'typescript', combined);

  if (res.timedOut) {
    return fail('typescript', `TypeScript TIMED OUT after ${Math.round(timeoutMs / 1000)}s`, combined, durationMs);
  }
  if (res.ok) {
    return pass('typescript', '`npx tsc --noEmit` passed — 0 errors', combined, durationMs);
  }

  const errors = parseTscErrors(combined);
  for (const e of errors) {
    tryRegisterRing1Error({ file: e.file, code: e.code, message: e.message, category: 'COMPILE' }, log);
  }

  const first = errors[0];
  const detail = first
    ? `TypeScript: ${errors.length} error(s) — first: ${first.code} at ${first.file}:${first.line}: ${first.message}`
    : `TypeScript failed (exit ${res.exitCode ?? 'null'}): ${firstLine(res.stderr) || firstLine(res.stdout)}`;
  const output = errors.length > 0
    ? errors.map((e) => `${e.code} at ${e.file}:${e.line},${e.col}: ${e.message}`).join('\n')
    : combined;

  return fail('typescript', detail, output, durationMs);
}

/** A single message from ESLint's JSON formatter output. */
interface EslintMessage {
  ruleId: string | null;
  severity: number; // 1 = warn, 2 = error
  message: string;
  line: number;
  column: number;
}
/** A single file result from ESLint's JSON formatter output. */
interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
}

/**
 * Parse the JSON output produced by `eslint --format json`.
 * Returns an empty array when the string is not parseable JSON or not an array.
 */
export function parseEslintJsonOutput(jsonStr: string): EslintFileResult[] {
  try {
    const arr = JSON.parse(jsonStr) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr as EslintFileResult[];
  } catch {
    return [];
  }
}

/**
 * Ring 1b: ESLint check.
 * Runs `npx eslint . --format json --ext .ts,.tsx`, parses the JSON output, counts severity-2
 * (error-level) findings, registers each to the learning DB, and returns a {@link CheckResult}.
 * Threshold: 0 severity-2 findings. Skips gracefully when ESLint is not installed.
 */
async function runRing1EslintCheck(
  projectPath: string,
  timeoutMs: number,
  run: CommandRunner,
  log: (m: string) => void,
  hasPackageJson: boolean = fs.existsSync(path.join(projectPath, 'package.json')),
  hasLocalEslint: boolean = fs.existsSync(path.join(projectPath, 'node_modules', '.bin', 'eslint'))
): Promise<CheckResult> {
  if (!hasPackageJson) {
    log('sentinel: no package.json in project root — ESLint check skipped (not a Node project yet)');
    return skip('eslint', 'Skipped — no package.json present; project has no ESLint to check');
  }
  if (!hasLocalEslint) {
    log('sentinel: no local eslint binary found — ESLint check skipped (eslint not installed)');
    return skip('eslint', 'Skipped — eslint not installed locally');
  }
  const startedAt = nowMs();
  const res = await run('npx eslint . --format json --ext .ts,.tsx', projectPath, timeoutMs);
  const durationMs = nowMs() - startedAt;

  if (res.timedOut) {
    return fail('eslint', `ESLint TIMED OUT after ${Math.round(timeoutMs / 1000)}s`, res.stderr, durationMs);
  }

  const combined = [res.stdout, res.stderr].filter((s) => s.trim() !== '').join('\n');
  logFullOutputIfTruncated(log, 'eslint', combined);
  const jsonStr = res.stdout.trim();

  if (!jsonStr.startsWith('[')) {
    // Not JSON — ESLint not installed, binary not found, or fatal config error.
    if (/command not found|is not recognized|Cannot find module|no such file|ENOENT/i.test(combined)) {
      return skip('eslint', 'ESLint not installed (`npx eslint` not available) — Ring 1b ESLint check skipped');
    }
    return fail(
      'eslint',
      `ESLint exited ${res.exitCode ?? 'null'} without JSON output: ${firstLine(combined)}`,
      clip(combined),
      durationMs
    );
  }

  const results = parseEslintJsonOutput(jsonStr);
  const errors: { file: string; rule: string; message: string; line: number; col: number }[] = [];

  for (const fr of results) {
    for (const lintMsg of fr.messages) {
      if (lintMsg.severity === 2) {
        const rule = lintMsg.ruleId ?? 'unknown';
        errors.push({ file: fr.filePath, rule, message: lintMsg.message, line: lintMsg.line, col: lintMsg.column });
        tryRegisterRing1Error({ file: fr.filePath, code: rule, message: lintMsg.message, category: 'LINT' }, log);
      }
    }
  }

  if (errors.length === 0) {
    return pass('eslint', '`npx eslint` passed — 0 severity-2 errors', '', durationMs);
  }

  const first = errors[0]!;
  const detail = `ESLint: ${errors.length} error(s) — ${first.rule} at ${first.file}:${first.line}: ${first.message}`;
  const output = errors.map((e) => `${e.rule} at ${e.file}:${e.line},${e.col}: ${e.message}`).join('\n');
  return fail('eslint', detail, output, durationMs);
}

// ---------------------------------------------------------------------------
// Lint Gate + Format Gate — style-debt prevention
// ---------------------------------------------------------------------------

/** Config file basenames indicating an ESLint config is present (`.eslintrc.*` / `eslint.config.*`). */
const ESLINT_CONFIG_FILES: readonly string[] = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.mjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'eslint.config.js',
  'eslint.config.cjs',
  'eslint.config.mjs',
  'eslint.config.ts',
];

/** Config file basenames indicating a Prettier config is present (`.prettierrc.*` / `prettier.config.*`). */
const PRETTIER_CONFIG_FILES: readonly string[] = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.toml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
];

/** Whether any of `names` exists directly under `projectPath` (guarded — never throws). */
function anyConfigFileExists(projectPath: string, names: readonly string[]): boolean {
  return names.some((n) => {
    try {
      return existsSync(join(projectPath, n));
    } catch {
      return false;
    }
  });
}

/** Whether `prettier` is declared in package.json's devDependencies (guarded — never throws). */
function hasPrettierDevDependency(projectPath: string): boolean {
  try {
    const raw = fs.readFileSync(join(projectPath, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { devDependencies?: Record<string, unknown> };
    return !!(parsed.devDependencies && Object.prototype.hasOwnProperty.call(parsed.devDependencies, 'prettier'));
  } catch {
    return false;
  }
}

/** A single violation parsed from `eslint --format compact` output. */
export interface EslintCompactViolation {
  file: string;
  line: number;
  col: number;
  severity: 'Error' | 'Warning';
  message: string;
}

const ESLINT_COMPACT_RE = /^(.+?):\s*line\s+(\d+),\s*col\s+(\d+),\s*(Error|Warning)\s*-\s*(.+)$/gm;

/** Parse `eslint --format compact` output into structured violations. Tolerant — never throws. */
export function parseEslintCompactOutput(output: string): EslintCompactViolation[] {
  const violations: EslintCompactViolation[] = [];
  const re = new RegExp(ESLINT_COMPACT_RE.source, ESLINT_COMPACT_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    violations.push({
      file: (m[1] ?? '').trim(),
      line: parseInt(m[2] ?? '0', 10),
      col: parseInt(m[3] ?? '0', 10),
      severity: m[4] === 'Warning' ? 'Warning' : 'Error',
      message: (m[5] ?? '').trim(),
    });
  }
  return violations;
}

/** Parse `prettier --check` output into the list of files that would be reformatted. Tolerant. */
export function parsePrettierCheckOutput(output: string): string[] {
  const files: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^\[warn\]\s+(\S.*)$/.exec(line);
    if (!m || !m[1]) continue;
    const candidate = m[1].trim();
    if (/^(Code style issues|Checking formatting)/i.test(candidate)) continue;
    files.push(candidate);
  }
  return files;
}

/**
 * Lint Gate — style-debt prevention. Runs `pnpm eslint src/ --max-warnings 0 --format compact`.
 * Only runs when an ESLint config (`.eslintrc.*` / `eslint.config.*`) exists under `projectPath` —
 * a project with no ESLint config has nothing to lint and SKIPS rather than failing (never a false
 * failure). PASS iff exit code 0; FAIL reports the warning/violation count and the first 10
 * violations. Prints in the exact FORGE 1.0 gate format via `log`.
 */
async function runLintGate(
  projectPath: string,
  timeoutMs: number,
  run: CommandRunner,
  log: (m: string) => void
): Promise<CheckResult> {
  if (!anyConfigFileExists(projectPath, ESLINT_CONFIG_FILES)) {
    return skip('lint', 'no .eslintrc.* or eslint.config.* found — lint gate skipped');
  }

  const command = 'pnpm eslint src/ --max-warnings 0 --format compact';
  log('[GATE] Running gate: lint');
  log(`[GATE:lint] ${command} (in ${projectPath})`);

  const startedAt = nowMs();
  const res = await run(command, projectPath, timeoutMs);
  const durationMs = nowMs() - startedAt;
  const combined = [res.stdout, res.stderr].filter((s) => s.trim() !== '').join('\n');
  logFullOutputIfTruncated(log, 'lint', combined);

  if (res.timedOut) {
    log(`[GATE:lint] FAIL — TIMED OUT after ${Math.round(timeoutMs / 1000)}s`);
    log('[FAIL] Gate LINT: FAIL');
    return fail('lint', `lint gate TIMED OUT after ${Math.round(timeoutMs / 1000)}s`, combined, durationMs);
  }
  if (res.ok) {
    log('[GATE:lint] PASS — 0 violations');
    log('[PASS] Gate LINT: PASS');
    return pass('lint', '`pnpm eslint src/ --max-warnings 0` passed (exit 0)', combined, durationMs);
  }

  const violations = parseEslintCompactOutput(combined);
  const warnings = violations.filter((v) => v.severity === 'Warning').length;
  const errors = violations.length - warnings;
  const first10 = violations.slice(0, 10);
  const detail =
    violations.length > 0
      ? `${warnings} warning(s), ${errors} error(s) — ${violations.length} total violation(s)`
      : `exited ${res.exitCode ?? 'null'}: ${firstLine(combined)}`;
  log(`[GATE:lint] FAIL — ${detail}`);
  log('[FAIL] Gate LINT: FAIL');
  const output = [
    `${violations.length} violation(s) (first ${Math.min(10, violations.length)} shown):`,
    ...first10.map((v) => `${v.file}:${v.line}:${v.col} ${v.severity} - ${v.message}`),
    '',
    combined,
  ].join('\n');
  return fail('lint', detail, output, durationMs);
}

/**
 * Format Gate — style-debt prevention. Runs `pnpm prettier --check src/`. Only runs when a
 * Prettier config (`.prettierrc.*` / `prettier.config.*`) exists under `projectPath` AND `prettier`
 * is declared in package.json's devDependencies — either absent means SKIP, never a false failure.
 * PASS iff exit code 0; FAIL lists the files with formatting violations. Prints in the exact FORGE
 * 1.0 gate format via `log`.
 */
async function runFormatGate(
  projectPath: string,
  timeoutMs: number,
  run: CommandRunner,
  log: (m: string) => void
): Promise<CheckResult> {
  if (!anyConfigFileExists(projectPath, PRETTIER_CONFIG_FILES)) {
    return skip('format', 'no .prettierrc.* or prettier.config.* found — format gate skipped');
  }
  if (!hasPrettierDevDependency(projectPath)) {
    return skip('format', 'prettier not declared in package.json devDependencies — format gate skipped');
  }

  const command = 'pnpm prettier --check src/';
  log('[GATE] Running gate: format');
  log(`[GATE:format] ${command} (in ${projectPath})`);

  const startedAt = nowMs();
  const res = await run(command, projectPath, timeoutMs);
  const durationMs = nowMs() - startedAt;
  const combined = [res.stdout, res.stderr].filter((s) => s.trim() !== '').join('\n');
  logFullOutputIfTruncated(log, 'format', combined);

  if (res.timedOut) {
    log(`[GATE:format] FAIL — TIMED OUT after ${Math.round(timeoutMs / 1000)}s`);
    log('[FAIL] Gate FORMAT: FAIL');
    return fail('format', `format gate TIMED OUT after ${Math.round(timeoutMs / 1000)}s`, combined, durationMs);
  }
  if (res.ok) {
    log('[GATE:format] PASS — all files formatted');
    log('[PASS] Gate FORMAT: PASS');
    return pass('format', '`pnpm prettier --check src/` passed (exit 0)', combined, durationMs);
  }

  const files = parsePrettierCheckOutput(combined);
  const detail =
    files.length > 0
      ? `${files.length} file(s) with formatting violations`
      : `exited ${res.exitCode ?? 'null'}: ${firstLine(combined)}`;
  log(`[GATE:format] FAIL — ${detail}`);
  log('[FAIL] Gate FORMAT: FAIL');
  const output = [`${files.length} file(s) need formatting:`, ...files.map((f) => `- ${f}`), '', combined].join('\n');
  return fail('format', detail, output, durationMs);
}

// ---------------------------------------------------------------------------
// Bundle Size Gate — Next.js per-page bundle budget vs Build Memory baseline
// ---------------------------------------------------------------------------

/**
 * Prompt types the bundle-size gate evaluates. Task spec: "feature, component, page." FORGE's
 * `PromptType` union (`src/engine/queue-generator.ts`) has no `component`/`page` member — `'ui'`
 * (the shell entry) and `'feature'` (every page-building entry, per REBUILD Session 2) are the
 * real UI-producing types and the closest analogs. Every other prompt type — including the task
 * spec's explicit skip-list `agent`/`database`/`migration`/`documentation` (only `agent` exists
 * as a real `PromptType`; `schema` is the closest analog to `database`/`migration`) — is
 * auto-skipped by simply not being in this allow-list.
 */
const BUNDLE_SIZE_GATE_PROMPT_TYPES: ReadonlySet<PromptType> = new Set<PromptType>(['feature', 'ui']);

/** Default per-page bundle-size regression threshold (percent). */
const DEFAULT_BUNDLE_SIZE_PER_PAGE_THRESHOLD_PERCENT = 15;
/** Default total-bundle regression threshold (percent). */
const DEFAULT_BUNDLE_SIZE_TOTAL_THRESHOLD_PERCENT = 10;
/** `.next/` is considered stale (needs a fresh `pnpm run build`) after this many ms. */
const DEFAULT_BUNDLE_SIZE_STALE_MS = 10 * 60 * 1000;
/** `next.config.*` filenames used to auto-detect a Next.js project. */
const NEXT_CONFIG_FILENAMES = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs'];

/** Shape of `.next/build-manifest.json` — the fields the bundle-size gate reads. */
interface NextBuildManifest {
  pages?: Record<string, string[]>;
}

/** Per-page bundle size in bytes, keyed by page route (e.g. `/`, `/about`). */
export type BundleSizeMap = Record<string, number>;

/**
 * Sum the on-disk size of every chunk `.next/build-manifest.json` declares for each page. A
 * chunk that cannot be stat'd (already pruned, race with a concurrent build) is skipped rather
 * than failing the whole parse.
 */
function computeBundleSizesFromManifest(manifest: NextBuildManifest, nextDir: string): BundleSizeMap {
  const sizes: BundleSizeMap = {};
  for (const [page, chunks] of Object.entries(manifest.pages ?? {})) {
    let total = 0;
    for (const chunk of chunks) {
      try {
        total += fs.statSync(join(nextDir, chunk)).size;
      } catch {
        // Chunk file missing — skip it, don't fail the whole page.
      }
    }
    sizes[page] = total;
  }
  return sizes;
}

/** Whether `.next/build-manifest.json` is absent or older than `staleMs`. */
function isNextBuildStale(projectPath: string, staleMs: number): boolean {
  try {
    const stat = fs.statSync(join(projectPath, '.next', 'build-manifest.json'));
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return true; // absent — definitely stale.
  }
}

/** A single page's bundle-size regression against the baseline. */
export interface BundleSizeRegression {
  page: string;
  baselineBytes: number;
  currentBytes: number;
  percentIncrease: number;
}

/**
 * Compare `current` bundle sizes against `baseline`, returning every page whose size grew more
 * than `perPageThresholdPercent`. A page absent from the baseline (new since the last recorded
 * build) has nothing to regress against and is skipped — only present-in-both pages are compared.
 */
export function diffBundleSizes(
  baseline: BundleSizeMap,
  current: BundleSizeMap,
  perPageThresholdPercent: number
): BundleSizeRegression[] {
  const regressions: BundleSizeRegression[] = [];
  for (const [page, currentBytes] of Object.entries(current)) {
    const baselineBytes = baseline[page];
    if (baselineBytes === undefined || baselineBytes <= 0) continue;
    const percentIncrease = ((currentBytes - baselineBytes) / baselineBytes) * 100;
    if (percentIncrease > perPageThresholdPercent) {
      regressions.push({ page, baselineBytes, currentBytes, percentIncrease });
    }
  }
  return regressions.sort((a, b) => b.percentIncrease - a.percentIncrease);
}

/**
 * Bundle Size gate. Prints in the FORGE 1.0 gate format (matching {@link runLintGate} /
 * {@link runFormatGate}). Rebuilds when `.next/` is stale, parses the build manifest, and
 * compares against (then updates) the Build Memory baseline. See `SentinelOptions.bundleSize`
 * for the full contract. Never throws (Iron Law 3) — every step degrades to SKIP or FAIL, never
 * a fabricated PASS.
 */
async function runBundleSizeGate(
  projectPath: string,
  promptType: PromptType | undefined,
  run: CommandRunner,
  log: (m: string) => void,
  thresholds: {
    staleMs: number;
    buildTimeoutMs: number;
    perPageThresholdPercent: number;
    totalThresholdPercent: number;
  }
): Promise<CheckResult> {
  if (!promptType || !BUNDLE_SIZE_GATE_PROMPT_TYPES.has(promptType)) {
    return skip(
      'bundle_size',
      `prompt type '${promptType ?? 'unknown'}' is not feature/ui — bundle size gate skipped`
    );
  }
  if (!anyConfigFileExists(projectPath, NEXT_CONFIG_FILENAMES)) {
    return skip('bundle_size', 'no next.config.* found — not a Next.js project, bundle size gate skipped');
  }

  const { staleMs, buildTimeoutMs, perPageThresholdPercent, totalThresholdPercent } = thresholds;
  log('[GATE] Running gate: bundle-size');
  const startedAt = nowMs();

  if (isNextBuildStale(projectPath, staleMs)) {
    log(`[GATE:bundle-size] .next/ absent or older than ${Math.round(staleMs / 60000)}m — running pnpm run build`);
    const buildRes = await run('pnpm run build', projectPath, buildTimeoutMs);
    if (!buildRes.ok) {
      const why = firstLine(buildRes.stderr) || firstLine(buildRes.stdout) || `exit ${buildRes.exitCode ?? 'null'}`;
      log(`[GATE:bundle-size] FAIL — pnpm run build failed: ${why}`);
      log('[FAIL] Gate BUNDLE-SIZE: FAIL');
      const buildCombined = [buildRes.stdout, buildRes.stderr].filter((s) => s.trim() !== '').join('\n');
      logFullOutputIfTruncated(log, 'bundle_size', buildCombined);
      return fail(
        'bundle_size',
        `pnpm run build failed while refreshing .next/ for the bundle size gate: ${why}`,
        buildCombined,
        nowMs() - startedAt
      );
    }
  }

  const manifestPath = join(projectPath, '.next', 'build-manifest.json');
  const manifestRaw = await readTextSafe(manifestPath);
  if (manifestRaw === null) {
    log('[GATE:bundle-size] SKIP — .next/build-manifest.json not found after build');
    return skip('bundle_size', `.next/build-manifest.json not found at ${manifestPath} — bundle size not evaluated`);
  }
  let manifest: NextBuildManifest;
  try {
    manifest = JSON.parse(manifestRaw) as NextBuildManifest;
  } catch (error) {
    log(`[GATE:bundle-size] SKIP — build-manifest.json could not be parsed (${describe(error)})`);
    return skip('bundle_size', 'build-manifest.json could not be parsed — bundle size not evaluated');
  }

  const currentSizes = computeBundleSizesFromManifest(manifest, join(projectPath, '.next'));
  if (Object.keys(currentSizes).length === 0) {
    log('[GATE:bundle-size] SKIP — build-manifest.json declares no pages');
    return skip('bundle_size', 'build-manifest.json declares no pages — bundle size not evaluated');
  }

  const baseline = await BuildMemory.builds.getLatestBundleSizeBaseline(projectPath);
  const durationMs = nowMs() - startedAt;

  if (baseline === null) {
    await BuildMemory.builds.updateBundleSizeBaseline(projectPath, currentSizes);
    log(`[GATE:bundle-size] BUNDLE SIZE BASELINE ESTABLISHED (${Object.keys(currentSizes).length} page(s))`);
    log('[PASS] Gate BUNDLE-SIZE: PASS');
    return pass(
      'bundle_size',
      'BUNDLE SIZE BASELINE ESTABLISHED',
      Object.entries(currentSizes).map(([p, b]) => `${p}: ${b} bytes`).join('\n'),
      durationMs
    );
  }

  const regressions = diffBundleSizes(baseline.bundleSizes, currentSizes, perPageThresholdPercent);
  const baselineTotal = Object.values(baseline.bundleSizes).reduce((a, b) => a + b, 0);
  const currentTotal = Object.values(currentSizes).reduce((a, b) => a + b, 0);
  const totalPercentIncrease = baselineTotal > 0 ? ((currentTotal - baselineTotal) / baselineTotal) * 100 : 0;
  const totalRegressed = baselineTotal > 0 && totalPercentIncrease > totalThresholdPercent;

  const perPageLines = Object.entries(currentSizes).map(([p, b]) => {
    const base = baseline.bundleSizes[p];
    const pct = base !== undefined && base > 0 ? `${(((b - base) / base) * 100).toFixed(2)}%` : 'new';
    return `${p}: ${base ?? 'new'} -> ${b} bytes (${pct})`;
  });

  if (regressions.length === 0 && !totalRegressed) {
    await BuildMemory.builds.updateBundleSizeBaseline(projectPath, currentSizes);
    log(
      `[GATE:bundle-size] PASS — ${Object.keys(currentSizes).length} page(s) within ${perPageThresholdPercent}% per-page / ${totalThresholdPercent}% total`
    );
    log('[PASS] Gate BUNDLE-SIZE: PASS');
    return pass(
      'bundle_size',
      `${Object.keys(currentSizes).length} page(s) within threshold (${perPageThresholdPercent}% per-page, ${totalThresholdPercent}% total)`,
      [`Total: ${baselineTotal} -> ${currentTotal} bytes (${totalPercentIncrease.toFixed(2)}%).`, ...perPageLines].join('\n'),
      durationMs
    );
  }

  const reasons: string[] = [];
  if (regressions.length > 0) {
    reasons.push(
      `${regressions.length} page(s) increased > ${perPageThresholdPercent}%: ` +
        regressions
          .map((r) => `${r.page} (+${r.percentIncrease.toFixed(1)}%, ${r.baselineBytes}->${r.currentBytes}b)`)
          .join(', ')
    );
  }
  if (totalRegressed) {
    reasons.push(
      `total bundle increased ${totalPercentIncrease.toFixed(1)}% > ${totalThresholdPercent}% (${baselineTotal}->${currentTotal}b)`
    );
  }
  const detail = reasons.join('; ');
  log(`[GATE:bundle-size] FAIL — ${detail}`);
  log('[FAIL] Gate BUNDLE-SIZE: FAIL');
  return fail('bundle_size', detail, [`Total: ${baselineTotal} -> ${currentTotal} bytes (${totalPercentIncrease.toFixed(2)}%).`, ...perPageLines].join('\n'), durationMs);
}

/** Prompt types the Component Accessibility gate evaluates — the same feature/ui "component" set {@link BUNDLE_SIZE_GATE_PROMPT_TYPES} uses. */
const COMPONENT_ACCESSIBILITY_GATE_PROMPT_TYPES: ReadonlySet<PromptType> = new Set<PromptType>(['feature', 'ui']);

/**
 * Component Accessibility gate. Runs {@link checkProjectAccessibility}'s static WCAG 2.1 AA scan
 * (`src/ui-engine/accessibility-checker.ts`) over every `src/components/**\/*.tsx` file. Auto-skips
 * for any prompt type other than feature/ui and for a project with no `src/components/` directory.
 * Never throws (Iron Law 3) — every step degrades to SKIP or FAIL, never a fabricated PASS.
 */
async function runComponentAccessibilityGate(
  projectPath: string,
  promptType: PromptType | undefined,
  checker: (projectPath: string) => Promise<ComponentAccessibilityReport[]>,
  log: (m: string) => void
): Promise<CheckResult> {
  if (!promptType || !COMPONENT_ACCESSIBILITY_GATE_PROMPT_TYPES.has(promptType)) {
    return skip(
      'component_accessibility',
      `prompt type '${promptType ?? 'unknown'}' is not feature/ui — component accessibility gate skipped`
    );
  }

  log('[GATE] Running gate: component-accessibility');
  const startedAt = nowMs();

  let reports: ComponentAccessibilityReport[];
  try {
    reports = await checker(projectPath);
  } catch (error) {
    log(`[GATE:component-accessibility] SKIP — checker threw (${describe(error)})`);
    return skip('component_accessibility', `component accessibility checker threw — not evaluated (${describe(error)})`);
  }

  if (reports.length === 0) {
    log('[GATE:component-accessibility] SKIP — no .tsx files found under src/components/');
    return skip('component_accessibility', 'no .tsx files found under src/components/ — not evaluated');
  }

  const durationMs = nowMs() - startedAt;
  const failing = reports.filter((r) => !r.passed);
  const totalErrors = reports.reduce((sum, r) => sum + r.issues.filter((i) => i.severity === 'error').length, 0);
  const totalWarnings = reports.reduce((sum, r) => sum + r.issues.filter((i) => i.severity === 'warning').length, 0);
  const output = reports
    .map(
      (r) =>
        `${r.filePath} — score ${r.score} (${r.passed ? 'PASS' : 'FAIL'})\n` +
        r.issues.map((i) => `  [${i.severity}] ${i.rule}: ${i.description} (fix: ${i.fix})`).join('\n')
    )
    .join('\n\n');

  if (failing.length > 0) {
    log(
      `[GATE:component-accessibility] FAIL — ${failing.length}/${reports.length} component(s) failed ` +
        `(${totalErrors} error(s), ${totalWarnings} warning(s))`
    );
    log('[FAIL] Gate COMPONENT-ACCESSIBILITY: FAIL');
    logFullOutputIfTruncated(log, 'component_accessibility', output);
    return fail(
      'component_accessibility',
      `${failing.length}/${reports.length} component(s) failed the WCAG 2.1 AA static scan (${totalErrors} error(s), ${totalWarnings} warning(s))`,
      output,
      durationMs
    );
  }

  log(`[GATE:component-accessibility] PASS — ${reports.length} component(s) scanned, 0 errors, ${totalWarnings} warning(s)`);
  log('[PASS] Gate COMPONENT-ACCESSIBILITY: PASS');
  return pass(
    'component_accessibility',
    `${reports.length} component(s) scanned — 0 errors, ${totalWarnings} warning(s)`,
    output,
    durationMs
  );
}

/**
 * Parse Supabase-generated `database.types.ts` to extract declared table names.
 * Looks for the `Tables: {` block inside the `Database` type and returns first-level property
 * names (skipping `Row`, `Insert`, `Update`, `Relationships`). Returns [] when not found.
 */
export function parseDatabaseTypesTableNames(content: string): string[] {
  const names: string[] = [];
  // Find the Tables block — stop at the next sibling key (Views / Functions / Enums / end of public)
  const tablesBlockMatch = /Tables:\s*\{([\s\S]*?)(?:\n\s{4,8}(?:Views|Functions|Enums|CompositeTypes):\s*\{|\n\s{2,4}\})/m.exec(content);
  if (!tablesBlockMatch) return names;
  const block = tablesBlockMatch[1] ?? '';
  // Extract top-level property names: 6–12 spaces of indentation followed by `identifier: {`
  const rowRe = /^\s{6,12}(\w+):\s*\{/gm;
  const skipNames = new Set(['Row', 'Insert', 'Update', 'Relationships']);
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(block)) !== null) {
    const name = m[1];
    if (name && !skipNames.has(name)) names.push(name);
  }
  return names;
}

/**
 * Try to list Supabase table names via the PostgREST REST API (`/rest/v1/`).
 * Reads credentials from env vars or `.env.local`. Returns null when credentials are absent or
 * the request fails (graceful degradation — never throws).
 */
async function getSupabaseTableNamesFromEnv(
  projectPath: string,
  log: (m: string) => void
): Promise<string[] | null> {
  let url = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
  let key = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ?? '';

  if (!url || !key) {
    const envLocal = await readTextSafe(join(projectPath, '.env.local'));
    if (envLocal) {
      const urlM = /(?:NEXT_PUBLIC_)?SUPABASE_URL=([^\r\n]+)/m.exec(envLocal);
      const keyM = /SUPABASE_SERVICE_ROLE_KEY=([^\r\n]+)|NEXT_PUBLIC_SUPABASE_ANON_KEY=([^\r\n]+)/m.exec(envLocal);
      if (urlM) url = (urlM[1] ?? '').trim();
      if (keyM) key = ((keyM[1] ?? keyM[2]) ?? '').trim();
    }
  }

  if (!url || !key) return null;

  try {
    const resp = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (!resp.ok) {
      log(`WARNING: Supabase REST API returned HTTP ${resp.status} — Ring 1c schema drift skipped`);
      return null;
    }
    // PostgREST OpenAPI: { paths: { '/tableName': {...} } }
    const data = await resp.json() as { paths?: Record<string, unknown> };
    if (!data.paths) return null;
    return Object.keys(data.paths)
      .filter((p) => p.startsWith('/') && !p.includes('{'))
      .map((p) => p.slice(1).split('?')[0] ?? '')
      .filter(Boolean);
  } catch (err) {
    log(`WARNING: Supabase table-list fetch failed (${err instanceof Error ? err.message : String(err)}) — Ring 1c schema drift skipped`);
    return null;
  }
}

/**
 * Ring 1c: Schema drift — compare `database.types.ts` table names against live Supabase.
 * Searches for the types file under common paths; skips when absent. Reads Supabase credentials
 * from env / `.env.local`; skips when absent. A declared table MISSING from live Supabase FAILS.
 * Extra live tables are OK. Never throws (graceful degradation throughout).
 */
async function runRing1TypesDriftCheck(
  projectPath: string,
  log: (m: string) => void
): Promise<CheckResult> {
  const startedAt = nowMs();

  const candidatePaths = [
    join(projectPath, 'src', 'types', 'database.types.ts'),
    join(projectPath, 'src', 'database.types.ts'),
    join(projectPath, 'database.types.ts'),
    join(projectPath, 'types', 'database.types.ts'),
  ];

  let typesContent: string | null = null;
  for (const p of candidatePaths) {
    typesContent = await readTextSafe(p);
    if (typesContent) break;
  }

  if (!typesContent) {
    return skip('live_schema_drift', 'database.types.ts not found — Ring 1c schema drift not applicable');
  }

  const typesTables = parseDatabaseTypesTableNames(typesContent);
  if (typesTables.length === 0) {
    return skip('live_schema_drift', 'No table names parsed from database.types.ts — Ring 1c schema drift not evaluated');
  }

  const liveTables = await getSupabaseTableNamesFromEnv(projectPath, log);
  const durationMs = nowMs() - startedAt;

  if (liveTables === null) {
    return skip(
      'live_schema_drift',
      `database.types.ts declares ${typesTables.length} table(s) but Supabase credentials not found — skipping live comparison`
    );
  }

  const liveSet = new Set(liveTables);
  const missingFromLive = typesTables.filter((t) => !liveSet.has(t));

  if (missingFromLive.length === 0) {
    return pass(
      'live_schema_drift',
      `Ring 1c schema drift: all ${typesTables.length} declared table(s) present in live Supabase`,
      `Types tables: ${typesTables.join(', ')}\nLive tables: ${liveTables.join(', ')}`,
      durationMs
    );
  }

  for (const t of missingFromLive) {
    tryRegisterRing1Error(
      {
        file: 'database.types.ts',
        code: 'SCHEMA_DRIFT',
        message: `Table '${t}' declared in database.types.ts but missing from live Supabase`,
        category: 'SCHEMA',
      },
      log
    );
  }

  return fail(
    'live_schema_drift',
    `Ring 1c schema drift: ${missingFromLive.length} table(s) in database.types.ts missing from live Supabase: ${missingFromLive.join(', ')}`,
    `Types tables: ${typesTables.join(', ')}\nLive tables: ${liveTables.join(', ')}\nMissing: ${missingFromLive.join(', ')}`,
    durationMs
  );
}

// ---------------------------------------------------------------------------
// Diagnostic report
// ---------------------------------------------------------------------------

/** Render the full markdown diagnostic report for a Sentinel run. */
function renderDiagnosticReport(
  checks: CheckResult[],
  failedCheck: SentinelCheckName | null,
  projectPath: string
): string {
  const tick = (c: CheckResult): string => (c.skipped ? '⊘ SKIP' : c.passed ? '✅ PASS' : '❌ FAIL');
  const lines: string[] = [];

  lines.push('# FORGE Sentinel — Diagnostic Report');
  lines.push('');
  lines.push(`- **Project:** ${projectPath}`);
  lines.push(`- **Overall:** ${failedCheck ? `FAIL ❌ (first failure: ${failedCheck})` : 'PASS ✅'}`);
  lines.push('');
  lines.push('## Check Summary');
  lines.push('');
  lines.push('| # | Check | Result | Detail |');
  lines.push('|---|-------|--------|--------|');
  checks.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${c.name} | ${tick(c)} | ${c.detail.replace(/\|/g, '\\|')} |`);
  });
  lines.push('');

  const failures = checks.filter((c) => !c.passed && !c.skipped);
  if (failures.length > 0) {
    lines.push('## Failure Detail');
    lines.push('');
    for (const c of failures) {
      lines.push(`### ❌ ${c.name} — ${c.detail}`);
      lines.push('');
      lines.push('```');
      lines.push(clip(c.output).trim() || '(no captured output)');
      lines.push('```');
      lines.push('');
    }
  } else {
    lines.push('All evaluated checks passed. No remediation required.');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point — runSentinel
// ---------------------------------------------------------------------------

/** Monotonic-ish millisecond clock (kept in one place so timing is easy to stub if needed). */
function nowMs(): number {
  return Date.now();
}

/**
 * Run the full Phase 4 Sentinel suite against `projectPath` and return a {@link SentinelResult}.
 *
 * Executes the nine Contract-13 checks in order. With `stopOnFirstFailure` (the default), once a
 * check fails the remaining checks are recorded as SKIPPED. `passed` is true only when no check
 * failed (skipped checks do not fail the gate). Always resolves — never throws (Iron Law 3).
 */
export async function runSentinel(options: SentinelOptions): Promise<SentinelResult> {
  const projectPath = options.projectPath;
  const governanceDirName = options.governanceDirName ?? 'governance';
  const governanceDir = join(projectPath, governanceDirName);
  const log = options.log ?? logLine('sentinel');
  const run = options.runCommand ?? defaultRunCommand;
  const stopOnFirstFailure = options.stopOnFirstFailure ?? true;
  const tscTimeoutMs = options.tscTimeoutMs ?? DEFAULT_TSC_TIMEOUT_MS;
  const buildTimeoutMs = options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;

  const protectedFiles = new Set(options.protectedGovernanceFiles ?? DEFAULT_PROTECTED_GOVERNANCE_FILES);
  const allowedDeletions = new Set(options.allowedDeletions ?? []);

  const checks: CheckResult[] = [];
  let failed = false;
  /** Project-relative paths changed on this branch (from the File Integrity diff) — feeds the
   *  Live Preview UI-change trigger. Null until the diff runs; stays null when git is unavailable. */
  let changedFilePaths: string[] | null = null;
  /** The same `git diff --name-status main...HEAD` result (with per-file status), for the File
   *  Delta check — the authoritative "did this branch produce a work product" signal. */
  let gitDiffChanges: GitFileChange[] | null = null;

  /** Record a check; once one fails, short-circuit the rest into SKIPs (if configured). */
  const record = (result: CheckResult): void => {
    checks.push(result);
    if (!result.passed && !result.skipped) failed = true;
  };
  const shouldSkipRest = (): boolean => failed && stopOnFirstFailure;
  const skipRest = (name: SentinelCheckName): CheckResult =>
    skip(name, 'skipped — a prior Sentinel check already failed (stopOnFirstFailure)');

  log(`running Sentinel on ${projectPath} (stopOnFirstFailure=${stopOnFirstFailure})`);

  // --- 0. Migration Safety (OPTIONAL PRE-MIGRATION gate — runs BEFORE the nine) ----------------
  // Not part of the mandatory Contract-13 nine: prepended only when `migrationSafety` is supplied
  // (the executor passes it solely on a prompt about to APPLY a migration). It analyzes the migration
  // SQL for destructive operations / RLS+FK breakage, auto-generates a rollback + data-backup script,
  // and BLOCKS the gate when the migration is unsafe — so it runs first and short-circuits the costly
  // tsc/build checks on a blocked migration. A build that does not opt in keeps exactly the nine.
  if (options.migrationSafety) {
    log('check 0: Migration Safety (destructive-op gate / rollback / backup / production diff)');
    const startedAt = nowMs();
    const msInput: MigrationSafetyInput = {
      ...options.migrationSafety,
      projectPath: options.migrationSafety.projectPath ?? projectPath,
      ...(options.migrationSafety.projectName !== undefined
        ? { projectName: options.migrationSafety.projectName }
        : {}),
    };
    const runMigration = options.runMigrationSafetyCheck ?? analyzeMigration;
    let ms: MigrationSafetyReport | null;
    try {
      ms = await runMigration(msInput, options.migrationSafetyOptions ?? { log: (m) => log(`migration: ${m}`) });
    } catch (error) {
      log(`WARNING: migration safety analysis failed (${describe(error)})`);
      ms = null;
    }
    if (ms === null) {
      record(skip('migration_safety', 'migration safety analyzer failed — not evaluated'));
    } else {
      record(evaluateMigrationSafety(ms, nowMs() - startedAt));
    }
  }

  // --- 1. TypeScript (Ring 1a) — enhanced: parses errors + registers to learning DB ------------
  if (shouldSkipRest()) {
    record(skipRest('typescript'));
  } else {
    log('check 1/7: TypeScript Ring 1a (npx tsc --noEmit --pretty false) — error-parsing + DB');
    record(await runRing1TypescriptCheck(projectPath, tscTimeoutMs, run, log, options.hasPackageJson, options.hasLocalTsc));
  }

  // --- 1b. ESLint (Ring 1b) — new mandatory gate: severity-2 errors → fail -----------------
  const eslintTimeoutMs = options.eslintTimeoutMs ?? tscTimeoutMs;
  if (shouldSkipRest()) {
    record(skipRest('eslint'));
  } else {
    log('check 2/7: ESLint Ring 1b (npx eslint . --format json --ext .ts,.tsx) — 0 errors threshold');
    record(await runRing1EslintCheck(projectPath, eslintTimeoutMs, run, log, options.hasPackageJson, options.hasLocalEslint));
  }

  // --- 2. Build ------------------------------------------------------------
  if (shouldSkipRest()) {
    record(skipRest('build'));
  } else if (!(options.hasPackageJson ?? fs.existsSync(join(projectPath, 'package.json')))) {
    log('sentinel: no package.json in project root — Build check skipped (not a Node project yet)');
    record(skip('build', 'Skipped — no package.json present; project has no build script to run'));
  } else {
    log('check 3/7: Build (pnpm run build)');
    record(await runCommandCheck('build', 'pnpm run build', projectPath, buildTimeoutMs, run, log));
  }

  // --- 3. File Integrity ---------------------------------------------------
  if (shouldSkipRest()) {
    record(skipRest('file_integrity'));
  } else {
    log('check 4/7: File Integrity (git diff --name-status)');
    const startedAt = nowMs();
    let changes: GitFileChange[] | null;
    try {
      changes = options.getFileChanges
        ? await options.getFileChanges()
        : await defaultGetFileChanges(projectPath, log);
    } catch (error) {
      log(`WARNING: file-change lookup failed (${describe(error)})`);
      changes = null;
    }
    if (changes !== null) changedFilePaths = changes.map((c) => c.path);
    gitDiffChanges = changes;
    record(evaluateFileIntegrity(changes, protectedFiles, allowedDeletions, nowMs() - startedAt));
  }

  // --- 3b. File Delta (git diff vs main is the authoritative "produced a work product" signal) ---
  if (shouldSkipRest()) {
    record(skipRest('file_delta'));
  } else {
    log('check 5/7: File Delta (git diff --name-status main...HEAD vs on-disk expected output)');
    const startedAt = nowMs();
    record(evaluateFileDelta(options.promptType, gitDiffChanges, projectPath, nowMs() - startedAt));
  }

  // --- 4. Schema Drift -----------------------------------------------------
  if (shouldSkipRest()) {
    record(skipRest('schema_drift'));
  } else if (!options.schemaPromptsHaveRun) {
    record(skip('schema_drift', 'no schema prompts have run yet — drift check not applicable'));
  } else {
    log('check 6/7: Schema Drift (extractSchema vs SCHEMA_REGISTRY.md)');
    const startedAt = nowMs();
    const registryMd =
      options.schemaRegistryContent ?? (await readTextSafe(join(governanceDir, 'SCHEMA_REGISTRY.md')));
    if (registryMd === null) {
      record(skip('schema_drift', `SCHEMA_REGISTRY.md not found under ${governanceDir} — drift not evaluated`));
    } else {
      const expected = parseSchemaRegistry(registryMd);
      let actual: SchemaSnapshot;
      try {
        actual = options.extractActualSchema
          ? await options.extractActualSchema()
          : await extractSchema(options.schemaSql ? { projectPath, sql: options.schemaSql } : { projectPath });
      } catch (error) {
        log(`WARNING: schema extraction failed (${describe(error)})`);
        actual = { tables: [], relationships: [], indexes: [], rlsPolicies: [], source: 'none', migrationFiles: [], warnings: [describe(error)] };
      }
      record(evaluateSchemaDrift(expected, actual, nowMs() - startedAt));
    }
  }

  // --- 5. Dependency Check -------------------------------------------------
  if (shouldSkipRest()) {
    record(skipRest('dependencies'));
  } else {
    log('check 7/7: Dependencies (package.json vs TOOLCHAIN.md)');
    const startedAt = nowMs();
    const pkgJson = options.packageJsonContent ?? (await readTextSafe(join(projectPath, 'package.json')));
    if (pkgJson === null && options.promptType === 'schema') {
      record(skip('dependencies', 'Skipped — schema prompt type has no package.json dependency requirements'));
    } else if (pkgJson === null) {
      // Session 5.2 absent-target law (Task 2b): a MISSING target must FAIL loudly, never skip
      // to a pass. The observed defect was exactly this — a project with no package.json at all
      // read as "not evaluated" instead of "this project has no dependency manifest, which for a
      // build past its schema/scaffold prompt is itself a defect."
      record(
        fail(
          'dependencies',
          `package.json not found under ${projectPath} — cannot evaluate dependencies`,
          `Expected a dependency manifest at ${join(projectPath, 'package.json')}; none exists. ` +
            'An absent target fails Sentinel, it never silently skips to a pass (Session 5.2 ' +
            'absent-target law).',
          nowMs() - startedAt
        )
      );
    } else {
      const currentDeps = parsePackageDependencies(pkgJson);
      let baseline: string[] | null = options.baselineDependencies ?? null;
      if (baseline === null) {
        const toolchainMd =
          options.toolchainContent ?? (await readTextSafe(join(governanceDir, 'TOOLCHAIN.md')));
        const parsed = toolchainMd ? parseToolchainDependencies(toolchainMd) : [];
        baseline = parsed.length > 0 ? parsed : null;
      }
      record(evaluateDependencies(currentDeps, baseline, nowMs() - startedAt));
    }
  }

  // --- Lint Gate (style-debt prevention) — auto-detects .eslintrc.*/eslint.config.*, else SKIPs ---
  if (shouldSkipRest()) {
    record(skipRest('lint'));
  } else {
    log('check: Lint Gate (pnpm eslint src/ --max-warnings 0 --format compact)');
    record(await runLintGate(projectPath, tscTimeoutMs, run, log));
  }

  // --- Format Gate (style-debt prevention) — auto-detects .prettierrc.*/prettier.config.*, else SKIPs
  if (shouldSkipRest()) {
    record(skipRest('format'));
  } else {
    log('check: Format Gate (pnpm prettier --check src/)');
    record(await runFormatGate(projectPath, tscTimeoutMs, run, log));
  }

  // --- Ring 1c. Schema Drift vs database.types.ts (OPTIONAL when ring1SchemaDrift is configured) -
  // Reads database.types.ts, parses declared table names, compares against live Supabase via the
  // REST API. Skips gracefully when the file is absent or credentials are unavailable (never a
  // false failure). A table declared in the types file but MISSING from live Supabase FAILS.
  if (options.ring1SchemaDrift) {
    if (shouldSkipRest()) {
      record(skipRest('live_schema_drift'));
    } else {
      log('check Ring 1c: Schema Drift (database.types.ts vs live Supabase)');
      const r1SchemaPath = options.ring1SchemaDrift.projectPath ?? projectPath;
      let r1Schema: CheckResult;
      try {
        r1Schema = await runRing1TypesDriftCheck(r1SchemaPath, log);
      } catch (err) {
        log(`WARNING: Ring 1c schema drift failed (${describe(err)})`);
        r1Schema = skip('live_schema_drift', 'Ring 1c schema drift runner threw — not evaluated');
      }
      record(r1Schema);
    }
  }

  // --- 6. Security Scan (OPTIONAL — only when configured; runs after EVERY prompt) -------------
  // Not part of the mandatory Contract-13 nine: appended only when `securityScan` is supplied. Unlike
  // visual regression / live preview it is NOT gated on UI changes — every prompt's generated code is
  // scanned. When `files` is not pinned, the prompt's changed files (from the File-Integrity diff) are
  // scanned so only the new/edited code is inspected; a null diff falls back to a full project walk.
  if (options.securityScan) {
    if (shouldSkipRest()) {
      record(skipRest('security_scan'));
    } else {
      log('check 6: Security Scan (secrets / SQL injection / XSS / exposed env / auth / CORS / npm audit)');
      const startedAt = nowMs();
      const scanInput: SecurityScanInput = {
        ...options.securityScan,
        projectPath: options.securityScan.projectPath ?? projectPath,
        // Pin the scan to this prompt's changed files when the caller did not specify a set and the
        // diff is known; otherwise let it walk the whole project.
        ...(options.securityScan.files === undefined && changedFilePaths !== null
          ? { files: changedFilePaths }
          : {}),
      };
      const runSecurity = options.runSecurityCheck ?? runSecurityScan;
      let scan: SecurityScanResult | null;
      try {
        scan = await runSecurity(scanInput, options.securityScanOptions ?? { log: (m) => log(`security: ${m}`) });
      } catch (error) {
        log(`WARNING: security scan failed (${describe(error)})`);
        scan = null;
      }
      if (scan === null) {
        record(skip('security_scan', 'security scanner failed — not evaluated'));
      } else {
        record(evaluateSecurityScan(scan, nowMs() - startedAt));
      }
    }
  }

  // --- 7. Visual Regression (OPTIONAL — only when configured AND after a UI prompt) ------------
  // Not part of the mandatory Contract-13 nine: the check is appended only when `visualRegression`
  // is supplied. A build that does not opt in keeps exactly nine checks (backward-compatible).
  if (options.visualRegression && options.uiPromptJustRan !== false) {
    if (shouldSkipRest()) {
      record(skipRest('visual_regression'));
    } else {
      log('check 7: Visual Regression (Playwright screenshots vs .forge/baselines)');
      const startedAt = nowMs();
      const vrInput: VisualRegressionInput = {
        ...options.visualRegression,
        projectPath: options.visualRegression.projectPath ?? projectPath,
      };
      const runVisual = options.runVisualCheck ?? runVisualRegression;
      let vr: VisualRegressionResult | null;
      try {
        vr = await runVisual(vrInput, options.visualRegressionOptions ?? { log: (m) => log(`visreg: ${m}`) });
      } catch (error) {
        log(`WARNING: visual regression run failed (${describe(error)})`);
        vr = null;
      }
      if (vr === null) {
        record(skip('visual_regression', 'visual regression runner failed — not evaluated'));
      } else {
        record(evaluateVisualRegression(vr, nowMs() - startedAt));
      }
    }
  }

  // --- 8. Live Preview (OPTIONAL — only when configured AND after a UI change) -----------------
  // Not part of the mandatory Contract-13 nine: appended only when `livePreview` is supplied AND the
  // prompt that just ran touched UI. "Touched UI" = a changed `.tsx`/`.css` file in this run's git
  // diff (when known), OR `uiPromptJustRan !== false` (config presence + UI signal implies intent).
  const uiFilesChanged = changedFilePaths !== null && hasUiFileChanges(changedFilePaths);
  const livePreviewTriggered = uiFilesChanged || (changedFilePaths === null && options.uiPromptJustRan !== false);
  if (options.livePreview && options.uiPromptJustRan !== false && livePreviewTriggered) {
    if (shouldSkipRest()) {
      record(skipRest('live_preview'));
    } else {
      log('check 8: Live Preview (boot pnpm dev, visit every route)');
      const startedAt = nowMs();
      const lpInput: LivePreviewInput = {
        ...options.livePreview,
        projectPath: options.livePreview.projectPath ?? projectPath,
        // Pass the diff so the gate's own `.tsx`/`.css` trigger is exact; null diff ⇒ let it run.
        ...(changedFilePaths !== null ? { changedFiles: changedFilePaths } : {}),
      };
      const runLive = options.runLivePreviewCheck ?? runLivePreviewGate;
      let lp: LivePreviewResult | null;
      try {
        lp = await runLive(lpInput, options.livePreviewOptions ?? { log: (m) => log(`preview: ${m}`) });
      } catch (error) {
        log(`WARNING: live preview run failed (${describe(error)})`);
        lp = null;
      }
      if (lp === null) {
        record(skip('live_preview', 'live preview runner failed — not evaluated'));
      } else {
        record(evaluateLivePreview(lp, nowMs() - startedAt));
      }
    }
  }

  // --- 9. Accessibility (OPTIONAL — only when configured AND after a UI change) ----------------
  // Not part of the mandatory Contract-13 nine: appended only when `accessibility` is supplied AND the
  // prompt that just ran touched UI (same trigger as live preview — a `.tsx`/`.css` change in this
  // run's diff, or `uiPromptJustRan !== false` when the diff is unavailable). Runs axe-core over every
  // route for WCAG 2.1 AA; a critical violation FAILS the gate, lesser ones are surfaced but pass; an
  // un-bootable app / unavailable browser / missing axe-core SKIPS (never a false fail).
  if (options.accessibility && options.uiPromptJustRan !== false && livePreviewTriggered) {
    if (shouldSkipRest()) {
      record(skipRest('accessibility'));
    } else {
      log('check 9: Accessibility (axe-core WCAG 2.1 AA over every route)');
      const startedAt = nowMs();
      const a11yInput: AccessibilityAuditInput = {
        ...options.accessibility,
        projectPath: options.accessibility.projectPath ?? projectPath,
        // Pass the diff so the auditor's own `.tsx`/`.css` trigger is exact; null diff ⇒ let it run.
        ...(changedFilePaths !== null ? { changedFiles: changedFilePaths } : {}),
      };
      const runA11y = options.runAccessibilityCheck ?? runAccessibilityAudit;
      let report: AccessibilityReport | null;
      try {
        report = await runA11y(a11yInput, options.accessibilityOptions ?? { log: (m) => log(`a11y: ${m}`) });
      } catch (error) {
        log(`WARNING: accessibility audit run failed (${describe(error)})`);
        report = null;
      }
      if (report === null) {
        record(skip('accessibility', 'accessibility runner failed — not evaluated'));
      } else {
        record(evaluateAccessibility(report, nowMs() - startedAt));
      }
    }
  }

  // --- 10. SEO (OPTIONAL — only when configured AND after a UI change) -------------------------
  // Not part of the mandatory Contract-13 nine: appended only when `seo` is supplied AND the prompt
  // that just ran touched UI (same trigger as live-preview / accessibility — a `.tsx`/`.css` change in
  // this run's diff, or `uiPromptJustRan !== false` when the diff is unavailable). Validates every route
  // for search-engine readiness with per-page scores; a critical issue FAILS the gate, lesser ones are
  // surfaced but pass; an un-bootable app / unavailable browser / no routes SKIPS (never a false fail).
  if (options.seo && options.uiPromptJustRan !== false && livePreviewTriggered) {
    if (shouldSkipRest()) {
      record(skipRest('seo'));
    } else {
      log('check 10: SEO (titles / meta / canonical / OG / JSON-LD / robots / sitemap / links / headings / images)');
      const startedAt = nowMs();
      const seoInput: SeoAuditInput = {
        ...options.seo,
        projectPath: options.seo.projectPath ?? projectPath,
        // Pass the diff so the validator's own `.tsx`/`.css` trigger is exact; null diff ⇒ let it run.
        ...(changedFilePaths !== null ? { changedFiles: changedFilePaths } : {}),
      };
      const runSeo = options.runSeoCheck ?? runSeoAudit;
      let seoResult: SEOAuditResult | null;
      try {
        seoResult = await runSeo(seoInput, options.seoOptions ?? { log: (m) => log(`seo: ${m}`) });
      } catch (error) {
        log(`WARNING: SEO audit run failed (${describe(error)})`);
        seoResult = null;
      }
      if (seoResult === null) {
        record(skip('seo', 'SEO runner failed — not evaluated'));
      } else {
        record(evaluateSeo(seoResult, nowMs() - startedAt));
      }
    }
  }

  // --- 11. Architecture Guard (OPTIONAL — only when configured; runs after EVERY prompt) ------
  // Not part of the mandatory Contract-13 nine: appended only when `architectureGuard` is supplied. Like
  // the security scan it is NOT gated on UI changes — the WHOLE codebase is analyzed every prompt. Unlike
  // the security scan it is NOT pinned to the changed files: cycle/dead-code detection needs the full
  // module graph, so the guard always walks the project (the prompt's changed files are passed only as
  // context). A HIGH-severity violation (a dependency cycle / N+1 query by default) FAILS the gate; an
  // empty/unanalyzable project SKIPS (never a false fail).
  if (options.architectureGuard) {
    if (shouldSkipRest()) {
      record(skipRest('architecture'));
    } else {
      log('check 11: Architecture Guard (cycles / god components / duplication / N+1 / error boundaries / hardcoded config / naming / dead code / strict-mode)');
      const startedAt = nowMs();
      const archInput: ArchitectureGuardInput = {
        ...options.architectureGuard,
        projectPath: options.architectureGuard.projectPath ?? projectPath,
        // Pass the prompt's changed files as context when the caller did not specify them and the diff is known.
        ...(options.architectureGuard.changedFiles === undefined && changedFilePaths !== null
          ? { changedFiles: changedFilePaths }
          : {}),
      };
      const runArch = options.runArchitectureCheck ?? runArchitectureGuard;
      let arch: ArchitectureReport | null;
      try {
        arch = await runArch(archInput, options.architectureGuardOptions ?? { log: (m) => log(`arch: ${m}`) });
      } catch (error) {
        log(`WARNING: architecture guard failed (${describe(error)})`);
        arch = null;
      }
      if (arch === null) {
        record(skip('architecture', 'architecture guard failed — not evaluated'));
      } else {
        record(evaluateArchitectureGuard(arch, nowMs() - startedAt));
      }
    }
  }

  // --- 12. Consensus Validation (OPTIONAL post-generation check — runs after EVERY prompt) -----
  // Not part of the mandatory Contract-13 nine: appended only when `consensusValidation` is supplied
  // (the executor passes it after a prompt that produced an artifact). Like the security scan it is
  // NOT gated on UI changes — every generation is cross-checked by an independent multi-model panel.
  // The generation BLOCKS the gate when its approvals fall below the prompt_type consensus requirement
  // (architecture 3-of-3, crud 2-of-3, documentation 1-of-3 by default); an unreachable panel SKIPS.
  if (options.consensusValidation) {
    if (shouldSkipRest()) {
      record(skipRest('consensus_validation'));
    } else {
      log('check 12: Consensus Validation (independent multi-model cross-check of the generated output)');
      const startedAt = nowMs();
      const cvInput: ConsensusValidationInput = {
        ...options.consensusValidation,
        projectName: options.consensusValidation.projectName ?? basename(projectPath),
      };
      const runConsensus = options.runConsensusCheck ?? runConsensusValidation;
      let cv: ConsensusValidationResult | null;
      try {
        cv = await runConsensus(
          cvInput,
          options.consensusValidationOptions ?? { log: (m) => log(`consensus: ${m}`) }
        );
      } catch (error) {
        log(`WARNING: consensus validation failed (${describe(error)})`);
        cv = null;
      }
      if (cv === null) {
        record(skip('consensus_validation', 'consensus validator failed — not evaluated'));
      } else {
        record(evaluateConsensus(cv, nowMs() - startedAt));
      }
    }
  }

  // --- 13. AgentShield Security Scan (OPTIONAL — grade B+ required; runs after every prompt) ----
  // Not part of the mandatory Contract-13 nine: appended only when `agentShield` is supplied. Like
  // the security scan it is NOT gated on UI changes — every prompt's output is scanned. A grade
  // below B (i.e. C/D/F) FAILS the gate; A or B passes; an un-scannable project SKIPS.
  if (options.agentShield) {
    if (shouldSkipRest()) {
      record(skipRest('agent_shield'));
    } else {
      log('check 13: AgentShield Security Scan (grade B+ required)');
      const startedAt = nowMs();
      const shieldPath = options.agentShield.projectPath ?? projectPath;
      const runShield = options.runAgentShieldCheck ?? scanProjectSecurity;
      let shield: SecurityReport | null;
      try {
        shield = await runShield(shieldPath);
      } catch (error) {
        log(`WARNING: AgentShield scan failed (${describe(error)})`);
        shield = null;
      }
      if (shield === null) {
        record(skip('agent_shield', 'AgentShield scanner failed — not evaluated'));
      } else {
        record(evaluateAgentShield(shield, nowMs() - startedAt));
      }
    }
  }

  // --- 14. Live Schema Drift (OPTIONAL — requires schemaSql; runs after every prompt) -----------
  // A second schema-drift pass that SPECIFICALLY requires a live SQL executor. Unlike the mandatory
  // schema_drift check (which falls back to migration files when no SQL executor is available), this
  // check is only meaningful against the LIVE database — it SKIPS when `schemaSql` is absent rather
  // than falling back. This gives an always-current "code vs live DB" picture independent of whether
  // schema prompts have executed.
  if (options.liveSchemaCheck) {
    if (shouldSkipRest()) {
      record(skipRest('live_schema_drift'));
    } else if (!options.schemaSql) {
      record(skip('live_schema_drift', 'no schemaSql executor provided — live schema drift not evaluated'));
    } else {
      log('check 14: Live Schema Drift (code vs live database via schemaSql)');
      const startedAt = nowMs();
      const livePath = options.liveSchemaCheck.projectPath ?? projectPath;
      const registryMd =
        options.liveSchemaRegistryContent ??
        options.schemaRegistryContent ??
        (await readTextSafe(join(governanceDir, 'SCHEMA_REGISTRY.md')));
      if (registryMd === null) {
        record(skip('live_schema_drift', `SCHEMA_REGISTRY.md not found under ${governanceDir} — live drift not evaluated`));
      } else {
        const expected = parseSchemaRegistry(registryMd);
        let actual: SchemaSnapshot;
        try {
          actual = options.runLiveSchemaExtraction
            ? await options.runLiveSchemaExtraction()
            : await extractSchema({ projectPath: livePath, sql: options.schemaSql });
        } catch (error) {
          log(`WARNING: live schema extraction failed (${describe(error)})`);
          actual = { tables: [], relationships: [], indexes: [], rlsPolicies: [], source: 'none', migrationFiles: [], warnings: [describe(error)] };
        }
        const liveDriftResult = evaluateSchemaDrift(expected, actual, nowMs() - startedAt);
        record({ ...liveDriftResult, name: 'live_schema_drift' });
      }
    }
  }

  // --- 15. Dead Code Scan (OPTIONAL — report only, never blocks; runs after every prompt) -------
  // Not part of the mandatory Contract-13 nine: appended only when `deadCodeScan` is supplied. It
  // scans for unused imports, variables, and exports across the project. Results are ALWAYS surfaced
  // but NEVER block the build (report-only by design, matching the task spec "report, don't block").
  if (options.deadCodeScan) {
    if (shouldSkipRest()) {
      record(skipRest('dead_code'));
    } else {
      log('check 15: Dead Code Scan (unused imports / variables / exports — report only)');
      const startedAt = nowMs();
      const deadPath = options.deadCodeScan.projectPath ?? projectPath;
      const runDead = options.runDeadCodeScan ?? scanDeadCode;
      let dead: DeadCodeReport | null;
      try {
        dead = await runDead(deadPath);
      } catch (error) {
        log(`WARNING: dead code scan failed (${describe(error)})`);
        dead = null;
      }
      if (dead === null) {
        record(skip('dead_code', 'dead code scanner failed — not evaluated'));
      } else {
        record(evaluateDeadCode(dead, nowMs() - startedAt));
      }
    }
  }

  // --- 16. Six Laws Verification (OPTIONAL — via governance-gate; runs after every prompt) ------
  // Not part of the mandatory Contract-13 nine: appended only when `sixLaws` is supplied. Runs the
  // full Six Laws check via `runSixLawsCheck` (governance-gate). A failing law FAILS the gate; a
  // law that cannot be evaluated SKIPS; an un-reachable app / browser SKIPS (never a false failure).
  if (options.sixLaws) {
    if (shouldSkipRest()) {
      record(skipRest('six_laws'));
    } else {
      log('check 16: Six Laws Verification (governance-gate)');
      const startedAt = nowMs();
      const sixPath = options.sixLaws.projectPath ?? projectPath;
      const runSix = options.runSixLawsVerification ?? runSixLawsCheck;
      let six: SixLawsResult | null;
      try {
        six = await runSix(sixPath);
      } catch (error) {
        log(`WARNING: Six Laws verification failed (${describe(error)})`);
        six = null;
      }
      if (six === null) {
        record(skip('six_laws', 'Six Laws verifier failed — not evaluated'));
      } else {
        record(evaluateSixLaws(six, nowMs() - startedAt));
      }
    }
  }

  // --- 16b. Bundle Size Gate (OPTIONAL, Next.js only — feature/ui prompts; runs after Six Laws) --
  // Not part of the mandatory Contract-13 nine: appended only when `bundleSize` is supplied. Auto-
  // skips for any prompt type other than feature/ui and for a non-Next.js project (no
  // next.config.*). Rebuilds `.next/` when stale, compares per-page + total bundle size against
  // the Build Memory baseline (`build_runs.bundle_sizes`), and ratchets the baseline forward on
  // every PASS. See `SentinelOptions.bundleSize` for the full contract.
  if (options.bundleSize) {
    if (shouldSkipRest()) {
      record(skipRest('bundle_size'));
    } else {
      log('check 16b: Bundle Size Gate (.next/build-manifest.json vs Build Memory baseline)');
      const bundlePath = options.bundleSize.projectPath ?? projectPath;
      const thresholds = {
        staleMs: options.bundleSize.staleMs ?? DEFAULT_BUNDLE_SIZE_STALE_MS,
        buildTimeoutMs: options.bundleSize.buildTimeoutMs ?? buildTimeoutMs,
        perPageThresholdPercent:
          options.bundleSize.perPageThresholdPercent ?? DEFAULT_BUNDLE_SIZE_PER_PAGE_THRESHOLD_PERCENT,
        totalThresholdPercent:
          options.bundleSize.totalThresholdPercent ?? DEFAULT_BUNDLE_SIZE_TOTAL_THRESHOLD_PERCENT,
      };
      const runBundle = options.runBundleSizeCheck ?? runBundleSizeGate;
      let bundleResult: CheckResult;
      try {
        bundleResult = await runBundle(bundlePath, options.promptType, run, log, thresholds);
      } catch (error) {
        log(`WARNING: bundle size gate failed (${describe(error)})`);
        bundleResult = skip('bundle_size', 'bundle size gate threw — not evaluated');
      }
      record(bundleResult);
    }
  }

  // --- 16c. Component Accessibility Gate (OPTIONAL, static WCAG scan — feature/ui prompts) -------
  // Not part of the mandatory Contract-13 nine: appended only when `componentAccessibility` is
  // supplied. Auto-skips for any prompt type other than feature/ui and when no `src/components/`
  // directory exists. Runs `checkProjectAccessibility` (src/ui-engine/accessibility-checker.ts) —
  // a lighter, no-browser-required sibling to the axe-core `accessibility` check above.
  if (options.componentAccessibility) {
    if (shouldSkipRest()) {
      record(skipRest('component_accessibility'));
    } else {
      log('check 16c: Component Accessibility Gate (static WCAG 2.1 AA scan of src/components/**/*.tsx)');
      const caPath = options.componentAccessibility.projectPath ?? projectPath;
      const runCa = options.runComponentAccessibilityCheck ?? checkProjectAccessibility;
      let caResult: CheckResult;
      try {
        caResult = await runComponentAccessibilityGate(caPath, options.promptType, runCa, log);
      } catch (error) {
        log(`WARNING: component accessibility gate failed (${describe(error)})`);
        caResult = skip('component_accessibility', 'component accessibility gate threw — not evaluated');
      }
      record(caResult);
    }
  }

  // --- 17. Full Playwright Test Suite (OPTIONAL — not incremental; runs after every prompt) -----
  // Not part of the mandatory Contract-13 nine: appended only when `playwright` is supplied. Unlike
  // the incremental-tester, this runs the COMPLETE Playwright suite (`pnpm playwright test`) every
  // time — no file-change filtering. Any test failure FAILS the gate; a timeout also FAILS. There
  // is no SKIP path (a missing Playwright install will produce a non-zero exit, which fails).
  if (options.playwright) {
    if (shouldSkipRest()) {
      record(skipRest('playwright'));
    } else {
      const playwrightCmd = options.playwright.command ?? 'pnpm playwright test';
      const playwrightTimeout = options.playwright.timeoutMs ?? 20 * 60 * 1000;
      const playwrightPath = options.playwright.projectPath ?? projectPath;
      log(`check 17: Full Playwright Test Suite (${playwrightCmd})`);
      record(
        await runCommandCheck('playwright', playwrightCmd, playwrightPath, playwrightTimeout, run, log)
      );
    }
  }

  // --- 18. Consensus Proposal (OPTIONAL — independent proposals + peer critique round) ---------
  // Not part of the mandatory Contract-13 nine: appended only when `consensusProposal` is supplied
  // (the executor passes it before a prompt that is about to produce an artifact, in place of — or
  // alongside — the post-hoc `consensusValidation` check). Several providers draft BLIND to each
  // other, every usable draft is critiqued by its peers through the same panel `consensusValidation`
  // uses, and the best-ranked PASSING draft becomes the winner. No proposal reaching consensus FAILS
  // the gate and blocks the build; an unreachable proposer panel (<2 usable drafts) SKIPS.
  if (options.consensusProposal) {
    if (shouldSkipRest()) {
      record(skipRest('consensus_proposal'));
    } else {
      log('check 18: Consensus Proposal (independent multi-model proposals + peer critique round)');
      const startedAt = nowMs();
      const cpInput: ConsensusProposalInput = {
        ...options.consensusProposal,
        projectName: options.consensusProposal.projectName ?? basename(projectPath),
      };
      const runProposal = options.runConsensusProposalCheck ?? runConsensusProposal;
      let cp: ConsensusProposalResult | null;
      try {
        cp = await runProposal(
          cpInput,
          options.consensusProposalOptions ?? { log: (m) => log(`consensus-proposal: ${m}`) }
        );
      } catch (error) {
        log(`WARNING: consensus proposal round failed (${describe(error)})`);
        cp = null;
      }
      if (cp === null) {
        record(skip('consensus_proposal', 'consensus proposal runner failed — not evaluated'));
      } else {
        record(evaluateConsensusProposal(cp, nowMs() - startedAt));
      }
    }
  }

  // --- Ring 2. Every-10th-prompt gate (Vitest, Semgrep, knip) ---------------------------------
  // Fires when ring2.promptNumber % 10 === 0 OR ring2.isFinalPrompt === true.
  // Each tool skips gracefully when not installed / not configured.
  // A failing tool registers a fix_patterns entry in the learning DB.
  if (options.ring2 && shouldFireRing2(options.ring2.promptNumber, options.ring2.isFinalPrompt)) {
    const coverageThreshold = options.ring2.coverageThreshold ?? 60;

    // Ring 2a: Vitest
    if (shouldSkipRest()) {
      record(skipRest('vitest'));
    } else {
      log(`Ring 2a: Vitest (prompt ${options.ring2.promptNumber})`);
      const vitestFn = options.ring2.runVitest ?? runRing2VitestCheck;
      let vitestResult: CheckResult;
      try {
        vitestResult = await vitestFn(projectPath, run, log, coverageThreshold);
      } catch (err) {
        log(`WARNING: Ring 2 Vitest check threw (${describe(err)})`);
        vitestResult = skip('vitest', 'Ring 2 Vitest runner threw — not evaluated');
      }
      record(vitestResult);
    }

    // Ring 2b: Semgrep
    if (shouldSkipRest()) {
      record(skipRest('semgrep'));
    } else {
      log(`Ring 2b: Semgrep (prompt ${options.ring2.promptNumber})`);
      const semgrepFn = options.ring2.runSemgrep ?? runRing2SemgrepCheck;
      let semgrepResult: CheckResult;
      try {
        semgrepResult = await semgrepFn(projectPath, run, log);
      } catch (err) {
        log(`WARNING: Ring 2 Semgrep check threw (${describe(err)})`);
        semgrepResult = skip('semgrep', 'Ring 2 Semgrep runner threw — not evaluated');
      }
      record(semgrepResult);
    }

    // Ring 2c: knip (dead code / unused exports)
    if (shouldSkipRest()) {
      record(skipRest('knip'));
    } else {
      log(`Ring 2c: knip (prompt ${options.ring2.promptNumber})`);
      const knipFn = options.ring2.runKnip ?? runRing2KnipCheck;
      let knipResult: CheckResult;
      try {
        knipResult = await knipFn(projectPath, run, log);
      } catch (err) {
        log(`WARNING: Ring 2 knip check threw (${describe(err)})`);
        knipResult = skip('knip', 'Ring 2 knip runner threw — not evaluated');
      }
      record(knipResult);
    }
  }

  // --- Ring 3. End-of-run gate (Trivy, Gitleaks, Lighthouse) ----------------------------------
  // Fires when ring3.isFinalPrompt === true OR ring3.forceRun === true.
  // All three tools skip gracefully when the binary is not installed — never a false failure.
  // A failing tool registers a fix_patterns entry in the learning DB.
  if (options.ring3 && shouldFireRing3(options.ring3.isFinalPrompt, options.ring3.forceRun)) {
    // Ring 3a: Trivy (CVE scan — 0 CRITICAL + 0 HIGH threshold)
    if (shouldSkipRest()) {
      record(skipRest('trivy'));
    } else {
      log('Ring 3a: Trivy vulnerability scan (0 CRITICAL/HIGH threshold)');
      const trivyFn = options.ring3.runTrivy ?? runRing3TrivyCheck;
      let trivyResult: CheckResult;
      try {
        trivyResult = await trivyFn(projectPath, run, log);
      } catch (err) {
        log(`WARNING: Ring 3 Trivy check threw (${describe(err)})`);
        trivyResult = skip('trivy', 'Ring 3 Trivy runner threw — not evaluated');
      }
      record(trivyResult);
    }

    // Ring 3b: Gitleaks (secret scan — 0 findings threshold)
    if (shouldSkipRest()) {
      record(skipRest('gitleaks'));
    } else {
      log('Ring 3b: Gitleaks secret scan (0 findings threshold)');
      const gitleaksFn = options.ring3.runGitleaks ?? runRing3GitleaksCheck;
      let gitleaksResult: CheckResult;
      try {
        gitleaksResult = await gitleaksFn(projectPath, run, log);
      } catch (err) {
        log(`WARNING: Ring 3 Gitleaks check threw (${describe(err)})`);
        gitleaksResult = skip('gitleaks', 'Ring 3 Gitleaks runner threw — not evaluated');
      }
      record(gitleaksResult);
    }

    // Ring 3c: Lighthouse (≥ 90 for performance / accessibility / best-practices / SEO)
    if (shouldSkipRest()) {
      record(skipRest('lighthouse'));
    } else {
      log('Ring 3c: Lighthouse performance/accessibility/best-practices/SEO audit (≥ 90 threshold)');
      const lighthouseFn = options.ring3.runLighthouse ?? runRing3LighthouseCheck;
      let lighthouseResult: CheckResult;
      try {
        lighthouseResult = await lighthouseFn(projectPath, run, log);
      } catch (err) {
        log(`WARNING: Ring 3 Lighthouse check threw (${describe(err)})`);
        lighthouseResult = skip('lighthouse', 'Ring 3 Lighthouse runner threw — not evaluated');
      }
      record(lighthouseResult);
    }

    // Ring 3d: OWASP ZAP DAST (dynamic scan — 0 High-risk alerts threshold)
    if (shouldSkipRest()) {
      record(skipRest('owasp_zap'));
    } else {
      log('Ring 3d: OWASP ZAP baseline DAST scan (0 High-risk alert threshold)');
      const zapFn = options.ring3.runZap ?? runRing3ZapCheck;
      let zapResult: CheckResult;
      try {
        zapResult = await zapFn(projectPath, run, log);
      } catch (err) {
        log(`WARNING: Ring 3 OWASP ZAP check threw (${describe(err)})`);
        zapResult = skip('owasp_zap', 'Ring 3 OWASP ZAP runner threw — not evaluated');
      }
      record(zapResult);
    }

    // Ring 3e: Schemathesis API contract testing (0 failing/erroring test cases threshold)
    if (shouldSkipRest()) {
      record(skipRest('schemathesis'));
    } else {
      log('Ring 3e: Schemathesis API contract testing (0 contract-violation threshold)');
      const schemathesisFn = options.ring3.runSchemathesis ?? runRing3SchemathesisCheck;
      let schemathesisResult: CheckResult;
      try {
        schemathesisResult = await schemathesisFn(projectPath, run, log);
      } catch (err) {
        log(`WARNING: Ring 3 Schemathesis check threw (${describe(err)})`);
        schemathesisResult = skip('schemathesis', 'Ring 3 Schemathesis runner threw — not evaluated');
      }
      record(schemathesisResult);
    }
  }

  const failedCheck = checks.find((c) => !c.passed && !c.skipped)?.name ?? null;
  const passed = failedCheck === null;
  const diagnosticReport = renderDiagnosticReport(checks, failedCheck, projectPath);

  // --- Post-PASS: Enterprise Test Suite (TestOrchestrator) ------------------------------------
  // Fires only once every check above has passed. TestOrchestrator is a non-fatal collaborator
  // (Contract 4) — its results are recorded to Build Memory and logged, but never re-flip `passed`.
  if (passed && options.postPromptTests) {
    const runPostPromptTests = options.runPostPromptTests ?? runTests;
    try {
      const testResults = await runPostPromptTests({
        projectPath: options.postPromptTests.projectPath ?? projectPath,
        buildRunId: options.postPromptTests.buildRunId ?? null,
        promptId: options.postPromptTests.promptId ?? null,
        triggers: [TriggerType.POST_PROMPT],
        runners: [RunnerType.UNIT, RunnerType.INTEGRATION],
        ...(options.postPromptTests.baseUrl ? { baseUrl: options.postPromptTests.baseUrl } : {}),
      });
      for (const r of testResults) {
        log(
          `TestOrchestrator: ${r.testSuite} — ${r.status} (${r.passed}/${r.passed + r.failed + r.skipped} tests, ${r.durationMs}ms)`
        );
      }
    } catch (error) {
      log(`WARNING: TestOrchestrator post-PASS hook threw (${describe(error)}) — not evaluated`);
    }
  }

  log(passed ? 'Sentinel: PASS ✅' : `Sentinel: FAIL ❌ (first failure: ${failedCheck})`);
  return { passed, checks, failedCheck, diagnosticReport };
}

/**
 * Adapt a {@link SentinelResult} to the {@link PreviousSentinelStatus} the prompt-assembler
 * (s5-p01) carries into the NEXT prompt (Contract 13). Surfaces failed-check descriptions so the
 * model avoids repeating them.
 */
export function toPreviousSentinelStatus(
  result: SentinelResult,
  promptName?: string,
  promptIndex?: number
): PreviousSentinelStatus {
  const failures = result.checks.filter((c) => !c.passed && !c.skipped).map((c) => `${c.name}: ${c.detail}`);
  const details: JsonObject = {
    checks: result.checks.map((c) => ({ name: c.name, passed: c.passed, skipped: c.skipped, detail: c.detail })),
  };
  return {
    ...(promptName !== undefined ? { promptName } : {}),
    ...(promptIndex !== undefined ? { promptIndex } : {}),
    passed: result.passed,
    ...(failures.length > 0 ? { failures } : {}),
    details,
  };
}

// ---------------------------------------------------------------------------
// Autonomous Recovery (Contract 14)
// ---------------------------------------------------------------------------

/** Eligibility threshold: a pattern must exceed this success rate to auto-resolve (Contract 14). */
export const AUTO_RESOLVE_SUCCESS_THRESHOLD = 0.9;
/** Token-set similarity at/above which a normalized error is treated as a known pattern (Contract 15). */
export const SIGNATURE_SIMILARITY_THRESHOLD = 0.85;
/** Max auto-recovery attempts per prompt before escalating to a human (Contract 14). */
export const MAX_RECOVERY_ATTEMPTS = 2;

/** The outcome of re-running the failed prompt during recovery. */
export interface RerunOutcome {
  success: boolean;
  output: string;
}

/** One auto-recovery attempt's full record. */
export interface AutoRecoveryAttempt {
  /** 1-based attempt number. */
  attempt: number;
  /** Normalized signature of the error this attempt tried to resolve. */
  errorSignature: string;
  /** Category assigned to the error. */
  errorCategory: ErrorCategory;
  /** The matched eligible pattern, or null if none matched (→ novel error → escalate). */
  matchedPattern: { id: string; signature: string; successRate: number } | null;
  /** The resolution applied, or null if no resolution was available. */
  resolutionApplied: { id: string; type: string; description: string } | null;
  /** Whether applying the resolution's steps reported success. */
  resolutionSucceeded: boolean;
  /** Whether the prompt re-execution reported success. */
  rerunSucceeded: boolean;
  /** Sentinel result after the re-run (null if the attempt aborted before re-checking). */
  sentinel: SentinelResult | null;
  /** Whether THIS attempt restored a green Sentinel. */
  recovered: boolean;
  /** Human-readable note on what happened. */
  note: string;
}

/** The full result of an autonomous-recovery run. */
export interface AutoRecoveryResult {
  /** Whether autonomous recovery was enabled for this build. */
  enabled: boolean;
  /** Whether at least one recovery attempt was made. */
  attempted: boolean;
  /** Whether Sentinel ended green. */
  recovered: boolean;
  /** Whether the failure was escalated to a human (disabled, novel error, or attempts exhausted). */
  escalated: boolean;
  /** Each attempt, in order. */
  attempts: AutoRecoveryAttempt[];
  /** The final Sentinel result (the last re-run, or the input failure if none ran). */
  finalSentinel: SentinelResult;
  /** Summary reason for the final disposition. */
  reason: string;
}

/** Options for {@link runAutonomousRecovery}. */
export interface AutoRecoveryOptions {
  /** Whether Autonomous Recovery Mode is enabled for this build (opt-in per build, Contract 14). */
  autonomousRecoveryMode: boolean;
  /** Re-execute the failed prompt (the executor supplies this — wraps claude-runner + git). */
  rerunPrompt: () => Promise<RerunOutcome>;
  /** Re-run Sentinel after a resolution + re-run. Default: {@link runSentinel} with `sentinelOptions`. */
  rerunSentinel?: () => Promise<SentinelResult>;
  /** Sentinel options used to build the default `rerunSentinel`. Required if `rerunSentinel` is omitted. */
  sentinelOptions?: SentinelOptions;
  /** Max attempts before escalation. Default {@link MAX_RECOVERY_ATTEMPTS} (2). */
  maxAttempts?: number;
  /** prompt_executions.id to annotate with the applied resolution (optional Build Memory write). */
  promptExecutionId?: string | null;
  /** Fetch auto-resolvable patterns. Default: `BuildMemory.errors.getAutoResolvable()` (→ []). */
  fetchAutoResolvable?: () => Promise<ErrorPattern[]>;
  /** Fetch the resolution for a pattern. Default: `BuildMemory.resolutions.getResolutionForPattern`. */
  fetchResolution?: (patternId: string) => Promise<Resolution | null>;
  /**
   * Apply a resolution's steps to the project. Default: run a `commands: string[]` array from
   * `resolution_steps` (guarded), else treat the resolution as applied-by-re-run (returns true).
   */
  applyResolution?: (resolution: Resolution) => Promise<boolean>;
  /** Override the shell runner used by the default `applyResolution`. */
  runCommand?: CommandRunner;
  /** Progress reporter. Default logs with a `[FORGE:sentinel:recover]` prefix. */
  log?: (message: string) => void;
}

/**
 * Normalize a raw error string into a stable signature (Contract 15): lowercase, strip absolute
 * paths, line:column numbers, hex hashes, and ISO timestamps, collapse whitespace, and keep the
 * most informative leading slice. Deterministic — the same class of error yields the same string.
 */
export function normalizeErrorSignature(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/[a-z]:\\[^\s:]+/g, '<path>') // windows abs paths
    .replace(/\/[^\s:]+/g, '<path>') // posix abs/relative paths
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z?\b/g, '<ts>') // iso timestamps
    .replace(/\b[0-9a-f]{7,40}\b/g, '<hash>') // hex hashes
    .replace(/:\d+:\d+/g, ':<pos>') // line:col
    .replace(/\b\d+\b/g, '<n>') // remaining numbers
    .replace(/['"`].*?['"`]/g, '<str>') // quoted literals
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/** Categorize an error by the failing check + content heuristics (Contract 15 categories). */
export function categorizeError(checkName: SentinelCheckName | null, errorText: string): ErrorCategory {
  switch (checkName) {
    case 'typescript':
      return 'type_error';
    case 'build':
      return 'build_failure';
    case 'schema_drift':
      return 'schema';
    case 'dependencies':
      return 'dependency';
    case 'file_integrity':
      return 'config';
    case 'eslint':
    case 'lint':
    case 'format':
      return 'config';
    default:
      break;
  }
  const t = (errorText ?? '').toLowerCase();
  if (/ts\d{3,}|type '.*' is not assignable|cannot find name/.test(t)) return 'type_error';
  if (/cannot find module|module not found|missing dependency|package/.test(t)) return 'dependency';
  if (/auth|login|session|rls|policy/.test(t)) return 'auth';
  if (/relation|column|table|schema|migration/.test(t)) return 'schema';
  if (/build failed|webpack|compil/.test(t)) return 'build_failure';
  return 'runtime';
}

/** Tokenize a normalized signature for similarity scoring. */
function tokens(sig: string): Set<string> {
  return new Set(sig.split(/[^a-z0-9<>]+/).filter((t) => t.length > 1));
}

/** Jaccard similarity of two normalized error signatures in [0, 1]. */
export function signatureSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Choose the best eligible pattern (success_rate > threshold) matching a normalized error. */
function selectMatchingPattern(
  patterns: ErrorPattern[],
  normalizedError: string,
  category: ErrorCategory
): { pattern: ErrorPattern; similarity: number } | null {
  let best: { pattern: ErrorPattern; similarity: number } | null = null;
  for (const p of patterns) {
    if (!p.auto_resolve_eligible) continue;
    if (!(p.success_rate > AUTO_RESOLVE_SUCCESS_THRESHOLD)) continue;
    const sim = signatureSimilarity(normalizeErrorSignature(p.error_signature), normalizedError);
    // Same category gives a small floor so a categorical match still qualifies even when the
    // textual overlap is modest; otherwise require the textual similarity threshold.
    const qualifies = sim >= SIGNATURE_SIMILARITY_THRESHOLD || (p.error_category === category && sim >= 0.5);
    if (!qualifies) continue;
    if (!best || sim > best.similarity || (sim === best.similarity && p.success_rate > best.pattern.success_rate)) {
      best = { pattern: p, similarity: sim };
    }
  }
  return best;
}

/** Default resolution applier: run a `commands` array from `resolution_steps`, else no-op (true). */
async function defaultApplyResolution(
  resolution: Resolution,
  cwd: string,
  run: CommandRunner,
  log: (m: string) => void
): Promise<boolean> {
  const commands = extractCommands(resolution.resolution_steps);
  if (commands.length === 0) {
    log(`resolution ${resolution.id} has no executable commands — treating as applied-by-re-run`);
    return true;
  }
  let allOk = true;
  for (const cmd of commands) {
    log(`applying resolution command: ${cmd}`);
    const res = await run(cmd, cwd, 120_000);
    if (!res.ok) {
      allOk = false;
      log(`resolution command failed (exit ${res.exitCode ?? 'null'}): ${firstLine(res.stderr)}`);
    }
  }
  return allOk;
}

/** Pull a `commands: string[]` array out of a resolution's `resolution_steps` jsonb (guarded). */
function extractCommands(steps: Json): string[] {
  if (steps && typeof steps === 'object' && !Array.isArray(steps)) {
    const c = (steps as { [k: string]: Json }).commands;
    if (Array.isArray(c)) return c.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

/**
 * Drive the Contract-14 Autonomous Recovery loop for a FAILED Sentinel result.
 *
 * Disabled mode, or a novel error (no eligible pattern), or exhausting `maxAttempts` (2) all
 * ESCALATE to a human. On each attempt: match the failed check's normalized error to an
 * `auto_resolve_eligible` pattern with `success_rate > 0.90`, apply its resolution, re-run the
 * prompt, re-run Sentinel, and log the outcome to Build Memory (Contract 4 — guarded, non-fatal).
 * Stops as soon as Sentinel goes green. Never throws.
 */
export async function runAutonomousRecovery(
  failedSentinel: SentinelResult,
  options: AutoRecoveryOptions
): Promise<AutoRecoveryResult> {
  const log = options.log ?? logLine('sentinel:recover');
  const maxAttempts = options.maxAttempts ?? MAX_RECOVERY_ATTEMPTS;
  const fetchAutoResolvable =
    options.fetchAutoResolvable ?? (async () => (await BuildMemory.errors.getAutoResolvable()) ?? []);
  const fetchResolution =
    options.fetchResolution ?? ((id: string) => BuildMemory.resolutions.getResolutionForPattern(id));
  const run = options.runCommand ?? defaultRunCommand;

  const attempts: AutoRecoveryAttempt[] = [];
  let current = failedSentinel;

  // Already green, or disabled → no recovery here.
  if (failedSentinel.passed) {
    return { enabled: options.autonomousRecoveryMode, attempted: false, recovered: true, escalated: false, attempts, finalSentinel: failedSentinel, reason: 'Sentinel already passing — nothing to recover.' };
  }
  if (!options.autonomousRecoveryMode) {
    return { enabled: false, attempted: false, recovered: false, escalated: true, attempts, finalSentinel: failedSentinel, reason: 'Autonomous Recovery Mode disabled — escalating to human (Contract 14).' };
  }

  const rerunSentinel =
    options.rerunSentinel ??
    (options.sentinelOptions ? () => runSentinel(options.sentinelOptions as SentinelOptions) : null);
  if (!rerunSentinel) {
    return { enabled: true, attempted: false, recovered: false, escalated: true, attempts, finalSentinel: failedSentinel, reason: 'No rerunSentinel/sentinelOptions supplied — cannot re-verify; escalating.' };
  }

  const applyResolution =
    options.applyResolution ??
    ((resolution: Resolution) =>
      defaultApplyResolution(resolution, options.sentinelOptions?.projectPath ?? process.cwd(), run, log));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const failingCheck = current.checks.find((c) => !c.passed && !c.skipped) ?? null;
    const errorText = failingCheck ? `${failingCheck.detail}\n${failingCheck.output}` : current.diagnosticReport;
    const signature = normalizeErrorSignature(errorText);
    const category = categorizeError(failingCheck?.name ?? null, errorText);
    log(`attempt ${attempt}/${maxAttempts}: failing check '${failingCheck?.name ?? 'unknown'}', category '${category}'`);

    const patterns = await fetchAutoResolvable();
    const match = selectMatchingPattern(patterns, signature, category);

    if (!match) {
      // Novel error → ALWAYS escalate (Contract 14).
      attempts.push({ attempt, errorSignature: signature, errorCategory: category, matchedPattern: null, resolutionApplied: null, resolutionSucceeded: false, rerunSucceeded: false, sentinel: current, recovered: false, note: 'No eligible pattern (success_rate > 0.90) matched — novel error, escalating to human.' });
      log('novel error — no eligible auto-resolve pattern matched; escalating');
      return { enabled: true, attempted: true, recovered: false, escalated: true, attempts, finalSentinel: current, reason: 'Novel error (no matching auto-resolvable pattern) — escalated to human (Contract 14).' };
    }

    const pattern = match.pattern;
    log(`matched pattern '${pattern.error_signature}' (success_rate=${pattern.success_rate}, sim=${match.similarity.toFixed(2)})`);
    const resolution = await fetchResolution(pattern.id);

    let resolutionSucceeded = false;
    if (resolution) {
      try {
        resolutionSucceeded = await applyResolution(resolution);
      } catch (error) {
        log(`WARNING: applyResolution threw (${describe(error)}) — treating as failed`);
        resolutionSucceeded = false;
      }
    } else {
      log(`pattern ${pattern.id} has no linked resolution — relying on prompt re-run alone`);
      resolutionSucceeded = true; // the re-run itself is the remediation
    }

    // Re-run the prompt, then re-run Sentinel.
    let rerun: RerunOutcome = { success: false, output: '' };
    try {
      rerun = await options.rerunPrompt();
    } catch (error) {
      log(`WARNING: rerunPrompt threw (${describe(error)}) — treating as failed`);
      rerun = { success: false, output: describe(error) };
    }

    let sentinel: SentinelResult;
    try {
      sentinel = await rerunSentinel();
    } catch (error) {
      log(`WARNING: rerunSentinel threw (${describe(error)}) — keeping prior failure`);
      sentinel = current;
    }
    current = sentinel;
    const recovered = sentinel.passed;

    // Log everything to Build Memory (Contract 4 — guarded; failures degrade, never throw).
    await recordAttemptToMemory(pattern, resolution, recovered, options.promptExecutionId ?? null, sentinel, log);

    attempts.push({
      attempt,
      errorSignature: signature,
      errorCategory: category,
      matchedPattern: { id: pattern.id, signature: pattern.error_signature, successRate: pattern.success_rate },
      resolutionApplied: resolution ? { id: resolution.id, type: resolution.resolution_type, description: resolution.resolution_description } : null,
      resolutionSucceeded,
      rerunSucceeded: rerun.success,
      sentinel,
      recovered,
      note: recovered
        ? 'Resolution applied, prompt re-run, Sentinel green — recovered.'
        : `Resolution applied + prompt re-run, but Sentinel still failing (${sentinel.failedCheck ?? 'unknown'}).`,
    });

    if (recovered) {
      log(`recovered on attempt ${attempt}`);
      return { enabled: true, attempted: true, recovered: true, escalated: false, attempts, finalSentinel: sentinel, reason: `Recovered on attempt ${attempt} via pattern '${pattern.error_signature}'.` };
    }
  }

  // Exhausted attempts → escalate (Contract 14: third failure escalates to human).
  log(`exhausted ${maxAttempts} recovery attempt(s) — escalating`);
  return { enabled: true, attempted: true, recovered: false, escalated: true, attempts, finalSentinel: current, reason: `Exhausted ${maxAttempts} auto-recovery attempt(s) without a green Sentinel — escalated to human (Contract 14).` };
}

/** Persist one recovery attempt's outcome to Build Memory (all writes guarded). */
async function recordAttemptToMemory(
  pattern: ErrorPattern,
  resolution: Resolution | null,
  succeeded: boolean,
  promptExecutionId: string | null,
  sentinel: SentinelResult,
  log: (m: string) => void
): Promise<void> {
  try {
    await BuildMemory.errors.updateOccurrenceCount(pattern.id);
    if (resolution) {
      await BuildMemory.resolutions.incrementApplied(resolution.id, succeeded);
    }
    if (promptExecutionId) {
      await BuildMemory.prompts.updatePromptExecution(promptExecutionId, {
        sentinel_passed: sentinel.passed,
        resolution_applied: resolution
          ? `${resolution.resolution_type}: ${resolution.resolution_description}`
          : `pattern ${pattern.error_signature} (re-run only)`,
        sentinel_details: { failedCheck: sentinel.failedCheck, recovered: succeeded } as JsonObject,
      });
    }
  } catch (error) {
    log(`WARNING: Build Memory logging degraded (${describe(error)})`);
  }
}

/** Render an unknown thrown value as a short string for logging. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Standalone CLI entry point — `forge sentinel <path> --ring N`
// ---------------------------------------------------------------------------

/**
 * Run a specific Sentinel ring (1, 2, or 3) as a standalone operation.
 * Ring 1 = mandatory checks (tsc, eslint, build, file-integrity, schema-drift, deps).
 * Ring 2 = every-10th-prompt checks (Vitest, Semgrep SAST, knip) — fires unconditionally here.
 * Ring 3 = end-of-run checks (Trivy, Gitleaks, Lighthouse, OWASP ZAP DAST, Schemathesis API
 * contract testing) — fires unconditionally here.
 * Returns the aggregate pass/fail and the per-check results.
 */
export async function runSentinelRing(
  ring: number,
  projectPath: string,
  promptNumber: number
): Promise<{ passed: boolean; results: unknown[] }> {
  const options: SentinelOptions = { projectPath, stopOnFirstFailure: false };

  if (ring === 2) {
    options.ring2 = { promptNumber, isFinalPrompt: true };
  } else if (ring === 3) {
    options.ring3 = { forceRun: true, isFinalPrompt: true };
  }

  const result = await runSentinel(options);
  return { passed: result.passed, results: result.checks };
}

export default runSentinel;
