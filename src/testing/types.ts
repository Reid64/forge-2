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
