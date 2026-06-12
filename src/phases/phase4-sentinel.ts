/**
 * FORGE 2.0 — Phase 4: Sentinel (post-prompt health checker, queue.yaml s5-p04).
 *
 * Sentinel runs after EVERY Phase 3 prompt execution (BEHAVIORAL_CONTRACTS.md Contract 1 —
 * "Phase 4 runs after EVERY Phase 3 prompt") and is the gate that decides whether the
 * prompt's work is healthy enough to merge to main. It performs five health checks IN ORDER
 * (Contract 13), and ALL non-skipped checks must pass:
 *
 *   1. TypeScript  — `pnpm tsc --noEmit`            (Gate 1; zero errors required)
 *   2. Build       — `pnpm run build`               (Gate 2; must complete; warnings ok)
 *   3. File Integrity — `git diff --name-status`    (immutable governance docs unchanged,
 *                       no unexpected deletions — Contract 3 / Iron Law 1)
 *   4. Schema Drift — extractSchema() vs SCHEMA_REGISTRY.md, ONLY when schema prompts have
 *                       run. Additions are OK; modifications / deletions FAIL.
 *   5. Dependency Check — current package.json deps vs the locked TOOLCHAIN.md manifest /
 *                       baseline. Any NEW dependency not in the manifest FAILS.
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
import { basename, join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { GitManager, type GitFileChange } from '../engine/git-manager.js';
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
import type { PreviousSentinelStatus } from '../engine/prompt-assembler.js';
import type { ErrorPattern, ErrorCategory, Resolution, Json, JsonObject } from '../types/index.js';
import { BuildMemory } from '../memory/index.js';
import { logLine } from '../tools/forge-logger.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Public contract — Sentinel
// ---------------------------------------------------------------------------

/**
 * The Sentinel health checks. The first five are the fixed Contract-13 suite (always evaluated, in
 * order). `visual_regression` and `live_preview` are OPTIONAL checks, appended only when configured
 * AND the prompt that just ran touched UI — they are NOT part of the mandatory five, so a build that
 * does not opt in keeps exactly the five Contract-13 checks.
 */
export type SentinelCheckName =
  | 'migration_safety'
  | 'typescript'
  | 'build'
  | 'file_integrity'
  | 'schema_drift'
  | 'dependencies'
  | 'security_scan'
  | 'visual_regression'
  | 'live_preview'
  | 'accessibility'
  | 'seo'
  | 'architecture'
  | 'consensus_validation';

/** The fixed, ordered list of MANDATORY Sentinel checks (Contract 13). Visual regression is opt-in. */
export const SENTINEL_CHECK_ORDER: readonly SentinelCheckName[] = [
  'typescript',
  'build',
  'file_integrity',
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
   * Visual-regression configuration (the OPTIONAL sixth check). When supplied, Sentinel screenshots
   * every route and pixel-diffs each capture against its `.forge/baselines/` baseline AFTER a UI
   * prompt (see `uiPromptJustRan`). `projectPath`/`baseUrl` default from this run's options when
   * absent. When omitted, the visual-regression check is not added (the five Contract-13 checks stand
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
   * options when absent. When omitted, the check is not added (the five Contract-13 checks stand
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
   * check is not added (the five Contract-13 checks stand alone). A CRITICAL finding (a live key, an
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
   * options when absent. When omitted, the check is not added (the five Contract-13 checks stand
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
   * SEO-audit configuration (the OPTIONAL tenth check). When supplied, Sentinel boots the target app,
   * loads every page route, and validates each rendered page for search-engine readiness AFTER a UI
   * prompt — that is, when the prompt that just ran changed a `.tsx`/`.css` file (detected from this
   * run's git diff via {@link hasUiFileChanges}) OR `uiPromptJustRan !== false`. It checks unique title
   * tags (no duplicates across routes), meta descriptions under 160 chars, canonical URLs, Open Graph
   * tags, valid JSON-LD structured data, page-appropriate robots meta, `sitemap.xml` validity, the
   * internal-link graph (no orphan pages / broken links), heading hierarchy (single H1, logical H2–H6),
   * and image optimization (WebP / lazy / width+height), producing per-page SEO scores. `projectPath`
   * defaults from this run's options when absent. When omitted, the check is not added (the five
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
   * omitted, the check is not added (the five Contract-13 checks stand alone). A HIGH-severity violation
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
   * from this run's options when absent. When omitted, the check is not added (the five Contract-13
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
   * `projectPath`. When omitted, the check is not added (the five Contract-13 checks stand alone). A
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
 * Default {@link CommandRunner}: run `command` in `cwd` with a timeout, capturing output and
 * NEVER throwing. On Windows the shell is PowerShell (Contract 6); the gate commands
 * (`pnpm tsc --noEmit`, `pnpm run build`) are constant strings — no injection surface.
 */
async function defaultRunCommand(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<CommandResult> {
  const shell = process.platform === 'win32' ? 'powershell.exe' : undefined;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      ...(shell ? { shell } : {}),
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

/** First non-empty trimmed line of a block of output (for terse `detail` strings). */
function firstLine(text: string): string {
  return (
    (text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  );
}

/** A passed check result with timing. */
function pass(name: SentinelCheckName, detail: string, output: string, durationMs: number): CheckResult {
  return { name, passed: true, skipped: false, detail, output, durationMs };
}

/** A failed check result with timing. */
function fail(name: SentinelCheckName, detail: string, output: string, durationMs: number): CheckResult {
  return { name, passed: false, skipped: false, detail, output, durationMs };
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
  run: CommandRunner
): Promise<CheckResult> {
  const startedAt = nowMs();
  const res = await run(command, cwd, timeoutMs);
  const durationMs = nowMs() - startedAt;
  const output = [res.stdout, res.stderr].filter((s) => s.trim() !== '').join('\n');

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
      log('WARNING: no `main` branch exists — skipping File Integrity check (git diff main...HEAD not runnable)');
      return null;
    }
  } catch (error) {
    // git unavailable / not a repo — also un-evaluable; skip rather than fail.
    log(`WARNING: could not check for a \`main\` branch (${describe(error)}) — skipping File Integrity check`);
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
// Check 0 (optional): Migration Safety (PRE-MIGRATION gate — runs before the five)
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
 * Executes the five Contract-13 checks in order. With `stopOnFirstFailure` (the default), once a
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

  /** Record a check; once one fails, short-circuit the rest into SKIPs (if configured). */
  const record = (result: CheckResult): void => {
    checks.push(result);
    if (!result.passed && !result.skipped) failed = true;
  };
  const shouldSkipRest = (): boolean => failed && stopOnFirstFailure;
  const skipRest = (name: SentinelCheckName): CheckResult =>
    skip(name, 'skipped — a prior Sentinel check already failed (stopOnFirstFailure)');

  log(`running Sentinel on ${projectPath} (stopOnFirstFailure=${stopOnFirstFailure})`);

  // --- 0. Migration Safety (OPTIONAL PRE-MIGRATION gate — runs BEFORE the five) ----------------
  // Not part of the mandatory Contract-13 five: prepended only when `migrationSafety` is supplied
  // (the executor passes it solely on a prompt about to APPLY a migration). It analyzes the migration
  // SQL for destructive operations / RLS+FK breakage, auto-generates a rollback + data-backup script,
  // and BLOCKS the gate when the migration is unsafe — so it runs first and short-circuits the costly
  // tsc/build checks on a blocked migration. A build that does not opt in keeps exactly the five.
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

  // --- 1. TypeScript -------------------------------------------------------
  if (shouldSkipRest()) {
    record(skipRest('typescript'));
  } else {
    log('check 1/5: TypeScript (pnpm tsc --noEmit)');
    record(await runCommandCheck('typescript', 'pnpm tsc --noEmit', projectPath, tscTimeoutMs, run));
  }

  // --- 2. Build ------------------------------------------------------------
  if (shouldSkipRest()) {
    record(skipRest('build'));
  } else {
    log('check 2/5: Build (pnpm run build)');
    record(await runCommandCheck('build', 'pnpm run build', projectPath, buildTimeoutMs, run));
  }

  // --- 3. File Integrity ---------------------------------------------------
  if (shouldSkipRest()) {
    record(skipRest('file_integrity'));
  } else {
    log('check 3/5: File Integrity (git diff --name-status)');
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
    record(evaluateFileIntegrity(changes, protectedFiles, allowedDeletions, nowMs() - startedAt));
  }

  // --- 4. Schema Drift -----------------------------------------------------
  if (shouldSkipRest()) {
    record(skipRest('schema_drift'));
  } else if (!options.schemaPromptsHaveRun) {
    record(skip('schema_drift', 'no schema prompts have run yet — drift check not applicable'));
  } else {
    log('check 4/5: Schema Drift (extractSchema vs SCHEMA_REGISTRY.md)');
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
    log('check 5/5: Dependencies (package.json vs TOOLCHAIN.md)');
    const startedAt = nowMs();
    const pkgJson = options.packageJsonContent ?? (await readTextSafe(join(projectPath, 'package.json')));
    if (pkgJson === null) {
      record(skip('dependencies', `package.json not found under ${projectPath} — not evaluated`));
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

  // --- 6. Security Scan (OPTIONAL — only when configured; runs after EVERY prompt) -------------
  // Not part of the mandatory Contract-13 five: appended only when `securityScan` is supplied. Unlike
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
  // Not part of the mandatory Contract-13 five: the check is appended only when `visualRegression`
  // is supplied. A build that does not opt in keeps exactly five checks (backward-compatible).
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
  // Not part of the mandatory Contract-13 five: appended only when `livePreview` is supplied AND the
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
  // Not part of the mandatory Contract-13 five: appended only when `accessibility` is supplied AND the
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
  // Not part of the mandatory Contract-13 five: appended only when `seo` is supplied AND the prompt
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
  // Not part of the mandatory Contract-13 five: appended only when `architectureGuard` is supplied. Like
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
  // Not part of the mandatory Contract-13 five: appended only when `consensusValidation` is supplied
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

  const failedCheck = checks.find((c) => !c.passed && !c.skipped)?.name ?? null;
  const passed = failedCheck === null;
  const diagnosticReport = renderDiagnosticReport(checks, failedCheck, projectPath);

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

export default runSentinel;
