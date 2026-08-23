// FORGE 2.0 Enterprise Test Suite — Type Definitions

export enum TriggerType {
  POST_PROMPT = 'POST_PROMPT',
  PRE_DEPLOY = 'PRE_DEPLOY',
  POST_DEPLOY = 'POST_DEPLOY',
  SCHEDULED = 'SCHEDULED',
  MANUAL = 'MANUAL',
}

export enum RunnerType {
  UNIT = 'UNIT',
  INTEGRATION = 'INTEGRATION',
  API = 'API',
  E2E = 'E2E',
  SECURITY = 'SECURITY',
  PERFORMANCE = 'PERFORMANCE',
  DEPENDENCY = 'DEPENDENCY',
  TRIVY = 'TRIVY',
  SECRET_SCAN = 'SECRET_SCAN',
  LIGHTHOUSE = 'LIGHTHOUSE',
  ACCESSIBILITY = 'ACCESSIBILITY',
  VISUAL_REGRESSION = 'VISUAL_REGRESSION',
  SEO = 'SEO',
  MIGRATION_SAFETY = 'MIGRATION_SAFETY',
  SEMGREP = 'SEMGREP',
  OWASP_ZAP = 'OWASP_ZAP',
  SCHEMATHESIS = 'SCHEMATHESIS',
  /** Infrastructure-as-Code security scan (checkov) — gated to MILESTONE/PRE-DEPLOYMENT tiers
   *  only (`src/governance/readiness-levels.ts`), never run on every prompt. */
  IAC = 'IAC',
  /** Software Bill of Materials (trivy fs --format cyclonedx) — same MILESTONE/PRE-DEPLOYMENT gate. */
  SBOM = 'SBOM',
  /** Dependency license compliance (trivy fs --scanners license) — same MILESTONE/PRE-DEPLOYMENT gate. */
  LICENSE = 'LICENSE',
  /** Python property-based testing (pytest + Hypothesis) — gated the same as UNIT (every tier that
   *  requires UNIT also requires this), since property-based tests are run alongside regular unit
   *  tests rather than at a later milestone. */
  PYTHON_PROPERTY = 'PYTHON_PROPERTY',
  /** JS/TS property-based testing — runs ONLY existing tests that import 'fast-check' via the
   *  project's own Vitest install; never generates new tests. Same UNIT-mirrored gate as
   *  PYTHON_PROPERTY above. */
  FASTCHECK = 'FASTCHECK',
  /** JS/TS mutation testing (Stryker Mutator, `npx stryker run --reporters json`) — gated to
   *  MILESTONE (ENTERPRISE_READY) and ENTERPRISE_RELEASE (MISSION_CRITICAL, and by extension
   *  HYPERSCALE, which reuses MISSION_CRITICAL's suite list verbatim) tiers ONLY
   *  (`src/governance/readiness-levels.ts`) — deliberately skips the intermediate ENTERPRISE_GRADE
   *  (PRE-DEPLOYMENT) tier too, unlike IAC/SBOM/LICENSE's cumulative introduction, because mutation
   *  testing is far slower/more expensive than any other suite and must run as rarely as possible. */
  MUTATION = 'MUTATION',
  /** Chaos engineering — latency injection + malformed-request injection against a live preview
   *  URL (chaos-runner.ts's own throwaway dev server, reusing phase4-sentinel.ts's dev-server-spawn
   *  convention). Gated to ENTERPRISE_RELEASE (MISSION_CRITICAL/HYPERSCALE) ONLY
   *  (`src/governance/readiness-levels.ts`), same top-of-the-ladder placement as MUTATION's
   *  ENTERPRISE_RELEASE half — never at MILESTONE or PRE-DEPLOYMENT. */
  CHAOS = 'CHAOS',
  /** Disaster-recovery readiness — health-check endpoint presence + correctness
   *  (recovery-runner.ts). A presence/correctness check, never an actual DR drill. Same
   *  ENTERPRISE_RELEASE-ONLY gate as CHAOS above. */
  DISASTER_RECOVERY = 'DISASTER_RECOVERY',
  /** Backup/restore governance-doc policy-presence gate (backup-restore-runner.ts) — verifies the
   *  project has documented a backup/restore policy; never performs an actual backup or restore.
   *  Same ENTERPRISE_RELEASE-ONLY gate as CHAOS/DISASTER_RECOVERY above. */
  BACKUP_RESTORE = 'BACKUP_RESTORE',
  /** Idempotency probing — sends a duplicate request pair against a live throwaway dev server
   *  (idempotency-runner.ts's own dev server, reusing the chaos/recovery-runner dev-server-spawn
   *  convention) and checks the second identical request is handled cleanly rather than crashing.
   *  Same ENTERPRISE_RELEASE (MISSION_CRITICAL/HYPERSCALE) ONLY gate as CHAOS/DISASTER_RECOVERY/
   *  BACKUP_RESTORE above — it hits a real running instance with real request load. */
  IDEMPOTENCY = 'IDEMPOTENCY',
  /** Concurrency probing — fires N simultaneous requests against a live throwaway dev server
   *  (concurrency-runner.ts's own dev server, same convention) and checks for race-condition
   *  symptoms (5xx under concurrent load, duplicate identifiers in the responses). Same
   *  ENTERPRISE_RELEASE ONLY gate as IDEMPOTENCY above. */
  CONCURRENCY = 'CONCURRENCY',
}

export interface TestRunResult {
  id: string;
  buildRunId: string | null;
  promptId: string | null;
  runnerType: RunnerType;
  testSuite: string;
  /** Count of passed/failed/skipped tests — NOT a boolean (see `status` for pass/fail verdict). */
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  coveragePercent: number | null;
  errors: string[];
  createdAt: string;
  /** The verdict Build Memory persisted. 'skipped'/'error' never satisfy a gate (T1). */
  status: 'passed' | 'failed' | 'skipped' | 'error';
  /** The concrete tool that produced this result (e.g. 'vitest', 'playwright', 'pnpm-audit'). */
  runner: string;
  /** Project-relative path to the full report artifact, or null. */
  reportPath: string | null;
  /** The underlying process exit code, or null for in-process/skipped runs. */
  exitCode: number | null;
}

export interface TestCoverageSnapshot {
  id: string;
  buildRunId: string | null;
  promptId: string | null;
  filesCovered: number;
  filesTotal: number;
  linesCovered: number;
  linesTotal: number;
  branchesCovered: number;
  branchesTotal: number;
  createdAt: string;
}

export interface TestOrchestratorOptions {
  projectPath: string;
  buildRunId: string | null;
  promptId: string | null;
  triggers: TriggerType[];
  runners: RunnerType[];
}
