/**
 * FORGE 2.0 — Readiness-Level Engine.
 *
 * Formalizes the nine readiness levels from `upgrades/CAPABILITIES_MEMO.md` § "7. Readiness-Level
 * Engine" (PROTOTYPE through HYPERSCALE) as real FORGE policy: each tier carries the governance
 * artifacts, test suites, and security/observability items a build must satisfy to legitimately
 * claim that tier, rather than the label being decorative. "A Prototype should not receive the
 * exact same validation regime as Mission-Critical infrastructure" (CAPABILITIES_MEMO.md).
 *
 * Grounding (Iron Law 3 — never invent a requirement not backed by an existing doc/type):
 *  - `requiredGovernanceArtifacts` values are drawn exclusively from `ArtifactName`
 *    (`src/resurrection/types.ts` › `ARTIFACT_NAMES`), the real 9-value set System 1 (GapAuditor)
 *    already scores — not a fabricated artifact list.
 *  - `requiredTestSuites` values are drawn exclusively from `TestSuiteDb`
 *    (`src/memory/test-results.ts`), the real 23-value CHECK-constrained enum `test_run_results`
 *    is persisted against, and are ordered to match the progressive-gate escalation described in
 *    `upgrades/QA_TESTING_FRAMEWORK.md` § "progressive gates" (PROMPT COMPLETION → FEATURE
 *    COMPLETION → QUEUE YAML COMPLETION → MILESTONE → PRE-DEPLOYMENT → ENTERPRISE RELEASE).
 *    IAC/SBOM/LICENSE (checkov/trivy-cyclonedx/trivy-license — schema 3.4.0) are deliberately
 *    introduced starting at ENTERPRISE_READY (the MILESTONE gate) rather than at whatever tier
 *    STATIC_ANALYSIS/DEPENDENCY_SCAN first appear: they are their own TestSuiteDb values
 *    specifically so they can be withheld until MILESTONE/PRE-DEPLOYMENT instead of being pulled
 *    forward to a lower tier by an existing, already-required category.
 *    PROPERTY_BASED (python-property-runner.ts / fastcheck-runner.ts — schema 3.5.0) takes the
 *    opposite approach: it is required at every tier UNIT is required at (property-based tests run
 *    alongside regular unit tests, not as a later-milestone gate), so it is listed next to 'UNIT' in
 *    every `requiredTestSuites` array below rather than being introduced partway up the ladder.
 *  - `requiredSecurityObservabilityItems` are free-text labels drawn verbatim from
 *    CAPABILITIES_MEMO.md's own enumerated Enterprise-Grade requirement list (lines ~933-997) —
 *    no item below was invented outside that list.
 *
 * MISSION_CRITICAL and HYPERSCALE reuse ENTERPRISE_GRADE's full governance/test/checklist sets:
 * CAPABILITIES_MEMO.md says only that "Mission-Critical introduces even more stringent
 * requirements" and "Hyperscale changes architecture substantially" — qualitative statements about
 * rigor/architecture, not additional discrete checklist items. Fabricating extra items for those
 * two tiers would violate the "do not invent requirements not grounded in project docs" instruction
 * this module was built under, so they intentionally re-use ENTERPRISE_GRADE's set verbatim.
 */

import type { ArtifactName } from '../resurrection/types.js';
import type { TestSuiteDb } from '../memory/test-results.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The nine readiness levels, in ascending order (CAPABILITIES_MEMO.md § 7). */
export type ReadinessTierId =
  | 'PROTOTYPE'
  | 'MVP'
  | 'PRODUCTION_READY_MVP'
  | 'COMMERCIAL_SAAS'
  | 'MULTI_TENANT_SAAS'
  | 'ENTERPRISE_READY'
  | 'ENTERPRISE_GRADE'
  | 'MISSION_CRITICAL'
  | 'HYPERSCALE';

/** One readiness tier's Definition of Done inputs. */
export interface ReadinessTier {
  id: ReadinessTierId;
  /** 1 (PROTOTYPE) through 9 (HYPERSCALE) — CAPABILITIES_MEMO.md's own numbering. */
  level: number;
  /** Human-facing label, verbatim from CAPABILITIES_MEMO.md. */
  label: string;
  description: string;
  /** Governance documents (`ArtifactName`) that must exist and be gap-free at this tier. */
  requiredGovernanceArtifacts: ArtifactName[];
  /** Test suites (`TestSuiteDb`) that must have a non-failed latest run at this tier. */
  requiredTestSuites: TestSuiteDb[];
  /** Process/security/observability checklist items required at this tier (free-text labels). */
  requiredSecurityObservabilityItems: string[];
  /** Where this tier's requirements are grounded, for audit trail. */
  source: string;
}

// ---------------------------------------------------------------------------
// Grounding constants
// ---------------------------------------------------------------------------

/** The full 9-value `ArtifactName` set (`src/resurrection/types.ts` › `ARTIFACT_NAMES`). */
const ALL_ARTIFACTS: ArtifactName[] = [
  'PRD',
  'BLUEPRINT',
  'SCHEMA_REGISTRY',
  'BEHAVIORAL_CONTRACTS',
  'AGENTS',
  'TOOLCHAIN',
  'SESSION_STATE',
  'STATE_OF_THE_BUILD',
  'TESTING',
];

/** All 23 `TestSuiteDb` values (`src/memory/test-results.ts`) — the maximal regime. */
const ALL_TEST_SUITES: TestSuiteDb[] = [
  'UNIT',
  'PROPERTY_BASED',
  'INTEGRATION',
  'API',
  'E2E',
  'STATIC_ANALYSIS',
  'SECURITY',
  'DEPENDENCY_SCAN',
  'ACCESSIBILITY',
  'VISUAL_REGRESSION',
  'DYNAMIC_ANALYSIS',
  'PERFORMANCE',
  'CROSS_BROWSER',
  'CROSS_DEVICE',
  'LOAD',
  'BACKUP_RESTORE',
  'STRESS',
  'SOAK',
  'DISASTER_RECOVERY',
  'CHAOS',
  'IAC',
  'SBOM',
  'LICENSE',
];

/**
 * CAPABILITIES_MEMO.md's own Enterprise-Grade requirement list, verbatim (lines ~933-997) — the
 * full checklist an Enterprise-Grade (and, per the module doc comment, Mission-Critical/Hyperscale)
 * build must satisfy.
 */
const ENTERPRISE_GRADE_CHECKLIST: string[] = [
  'formal PRD',
  'system architecture',
  'ADRs',
  'threat model',
  'RBAC',
  'RLS',
  'tenant isolation',
  'secrets management',
  'observability',
  'structured logging',
  'audit logging',
  'error tracking',
  'backup strategy',
  'disaster recovery',
  'CI/CD',
  'dependency governance',
  'security review',
  'code review',
  'integration testing',
  'E2E testing',
  'load testing',
  'operational runbooks',
  'incident response documentation',
  'data retention policy',
  'schema governance',
  'API contracts',
  'rollback strategy',
  'deployment strategy',
  'SLOs',
  'monitoring',
  'change management',
  'release governance',
];

const CAPABILITIES_MEMO_SOURCE = 'upgrades/CAPABILITIES_MEMO.md § 7. Readiness-Level Engine';
const QA_FRAMEWORK_SOURCE = 'upgrades/QA_TESTING_FRAMEWORK.md § progressive gates';

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

export const READINESS_TIERS: ReadinessTier[] = [
  {
    id: 'PROTOTYPE',
    level: 1,
    label: 'Prototype',
    description:
      'A throwaway or exploratory build. No governance or test regime is required beyond the ' +
      'live build-status record FORGE always writes.',
    requiredGovernanceArtifacts: ['STATE_OF_THE_BUILD'],
    requiredTestSuites: ['UNIT', 'PROPERTY_BASED'],
    requiredSecurityObservabilityItems: [],
    source: `${CAPABILITIES_MEMO_SOURCE}, tier 1 — "1. PROTOTYPE"`,
  },
  {
    id: 'MVP',
    level: 2,
    label: 'MVP',
    description: 'A minimal viable product — the architecture must be recorded, and unit + integration coverage exists.',
    requiredGovernanceArtifacts: ['BLUEPRINT', 'STATE_OF_THE_BUILD'],
    requiredTestSuites: ['UNIT', 'PROPERTY_BASED', 'INTEGRATION'],
    requiredSecurityObservabilityItems: ['code review'],
    source: `${CAPABILITIES_MEMO_SOURCE}, tier 2 — "2. MVP"`,
  },
  {
    id: 'PRODUCTION_READY_MVP',
    level: 3,
    label: 'Production-Ready MVP',
    description:
      'An MVP hardened enough to run in production: a real PRD and TESTING plan exist, and the ' +
      'QUEUE YAML COMPLETION gate (full unit + integration + E2E + static analysis) is green.',
    requiredGovernanceArtifacts: ['PRD', 'BLUEPRINT', 'TESTING', 'STATE_OF_THE_BUILD'],
    requiredTestSuites: ['UNIT', 'PROPERTY_BASED', 'INTEGRATION', 'E2E', 'STATIC_ANALYSIS'],
    requiredSecurityObservabilityItems: ['code review', 'CI/CD', 'integration testing', 'E2E testing'],
    source: `${CAPABILITIES_MEMO_SOURCE}, tier 3 — "3. PRODUCTION-READY MVP"; ${QA_FRAMEWORK_SOURCE} "QUEUE YAML COMPLETION"`,
  },
  {
    id: 'COMMERCIAL_SAAS',
    level: 4,
    label: 'Commercial SaaS',
    description:
      'A billable product: schema and toolchain are formally recorded, and the API/dependency/' +
      'accessibility/security surface has a passing baseline.',
    requiredGovernanceArtifacts: ['PRD', 'BLUEPRINT', 'TESTING', 'SCHEMA_REGISTRY', 'TOOLCHAIN', 'STATE_OF_THE_BUILD'],
    requiredTestSuites: [
      'UNIT',
      'PROPERTY_BASED',
      'INTEGRATION',
      'E2E',
      'STATIC_ANALYSIS',
      'API',
      'SECURITY',
      'DEPENDENCY_SCAN',
      'ACCESSIBILITY',
    ],
    requiredSecurityObservabilityItems: [
      'code review',
      'CI/CD',
      'integration testing',
      'E2E testing',
      'secrets management',
      'security review',
      'dependency governance',
      'API contracts',
    ],
    source: `${CAPABILITIES_MEMO_SOURCE}, tier 4 — "4. COMMERCIAL SAAS"`,
  },
  {
    id: 'MULTI_TENANT_SAAS',
    level: 5,
    label: 'Multi-Tenant SaaS',
    description:
      'Multiple tenants share infrastructure: behavioral contracts (incl. tenant-isolation rules) ' +
      'are recorded, and visual/dynamic-analysis coverage is added to the Commercial SaaS baseline.',
    requiredGovernanceArtifacts: [
      'PRD',
      'BLUEPRINT',
      'TESTING',
      'SCHEMA_REGISTRY',
      'TOOLCHAIN',
      'BEHAVIORAL_CONTRACTS',
      'STATE_OF_THE_BUILD',
    ],
    requiredTestSuites: [
      'UNIT',
      'PROPERTY_BASED',
      'INTEGRATION',
      'E2E',
      'STATIC_ANALYSIS',
      'API',
      'SECURITY',
      'DEPENDENCY_SCAN',
      'ACCESSIBILITY',
      'VISUAL_REGRESSION',
      'DYNAMIC_ANALYSIS',
    ],
    requiredSecurityObservabilityItems: [
      'code review',
      'CI/CD',
      'integration testing',
      'E2E testing',
      'secrets management',
      'security review',
      'dependency governance',
      'API contracts',
      'RBAC',
      'RLS',
      'tenant isolation',
      'schema governance',
    ],
    source: `${CAPABILITIES_MEMO_SOURCE}, tier 5 — "5. MULTI-TENANT SAAS"`,
  },
  {
    id: 'ENTERPRISE_READY',
    level: 6,
    label: 'Enterprise-Ready',
    description:
      'The full governance artifact set (agent registry, session-state history) exists, and ' +
      'performance/cross-browser/cross-device coverage is added — the MILESTONE gate.',
    requiredGovernanceArtifacts: ALL_ARTIFACTS,
    requiredTestSuites: [
      'UNIT',
      'PROPERTY_BASED',
      'INTEGRATION',
      'E2E',
      'STATIC_ANALYSIS',
      'API',
      'SECURITY',
      'DEPENDENCY_SCAN',
      'ACCESSIBILITY',
      'VISUAL_REGRESSION',
      'DYNAMIC_ANALYSIS',
      'PERFORMANCE',
      'CROSS_BROWSER',
      'CROSS_DEVICE',
      'IAC',
      'SBOM',
      'LICENSE',
    ],
    requiredSecurityObservabilityItems: [
      'code review',
      'CI/CD',
      'integration testing',
      'E2E testing',
      'secrets management',
      'security review',
      'dependency governance',
      'API contracts',
      'RBAC',
      'RLS',
      'tenant isolation',
      'schema governance',
      'structured logging',
      'audit logging',
      'error tracking',
      'monitoring',
      'observability',
    ],
    source: `${CAPABILITIES_MEMO_SOURCE}, tier 6 — "6. ENTERPRISE-READY"; ${QA_FRAMEWORK_SOURCE} "MILESTONE" (also introduces IAC/SBOM/LICENSE, gated to start here)`,
  },
  {
    id: 'ENTERPRISE_GRADE',
    level: 7,
    label: 'Enterprise-Grade',
    description:
      'CAPABILITIES_MEMO.md\'s explicit Enterprise-Grade requirement list is fully required, plus ' +
      'the PRE-DEPLOYMENT test gate (adds load + backup/restore to Enterprise-Ready\'s suite set).',
    requiredGovernanceArtifacts: ALL_ARTIFACTS,
    requiredTestSuites: [
      'UNIT',
      'PROPERTY_BASED',
      'INTEGRATION',
      'E2E',
      'STATIC_ANALYSIS',
      'API',
      'SECURITY',
      'DEPENDENCY_SCAN',
      'ACCESSIBILITY',
      'VISUAL_REGRESSION',
      'DYNAMIC_ANALYSIS',
      'PERFORMANCE',
      'CROSS_BROWSER',
      'CROSS_DEVICE',
      'LOAD',
      'BACKUP_RESTORE',
      'IAC',
      'SBOM',
      'LICENSE',
    ],
    requiredSecurityObservabilityItems: ENTERPRISE_GRADE_CHECKLIST,
    source: `${CAPABILITIES_MEMO_SOURCE}, tier 7 — "7. ENTERPRISE-GRADE" (full checklist, lines ~933-997); ${QA_FRAMEWORK_SOURCE} "PRE-DEPLOYMENT"`,
  },
  {
    id: 'MISSION_CRITICAL',
    level: 8,
    label: 'Mission-Critical',
    description:
      'CAPABILITIES_MEMO.md: "Mission-Critical introduces even more stringent requirements" — no ' +
      'additional discrete checklist item is named, so the Enterprise-Grade checklist is enforced ' +
      'in full, plus the ENTERPRISE RELEASE test gate (stress/soak/disaster-recovery/chaos).',
    requiredGovernanceArtifacts: ALL_ARTIFACTS,
    requiredTestSuites: ALL_TEST_SUITES,
    requiredSecurityObservabilityItems: ENTERPRISE_GRADE_CHECKLIST,
    source: `${CAPABILITIES_MEMO_SOURCE}, tier 8 — "8. MISSION-CRITICAL"; ${QA_FRAMEWORK_SOURCE} "ENTERPRISE RELEASE"`,
  },
  {
    id: 'HYPERSCALE',
    level: 9,
    label: 'Hyperscale',
    description:
      'CAPABILITIES_MEMO.md: "Hyperscale changes architecture substantially because scalability ' +
      'becomes an architectural constraint from the outset" — an architectural property, not an ' +
      'additional checklist item, so the maximal governance/test/checklist regime from ' +
      'Mission-Critical is reused verbatim.',
    requiredGovernanceArtifacts: ALL_ARTIFACTS,
    requiredTestSuites: ALL_TEST_SUITES,
    requiredSecurityObservabilityItems: ENTERPRISE_GRADE_CHECKLIST,
    source: `${CAPABILITIES_MEMO_SOURCE}, tier 9 — "9. HYPERSCALE"`,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Look up one tier by id. */
export function getReadinessTier(id: ReadinessTierId): ReadinessTier | undefined {
  return READINESS_TIERS.find((t) => t.id === id);
}

/** True when `candidate`'s level is >= `threshold`'s level (e.g. an ENTERPRISE_GRADE build also satisfies MVP). */
export function tierSatisfies(candidate: ReadinessTierId, threshold: ReadinessTierId): boolean {
  const c = getReadinessTier(candidate);
  const t = getReadinessTier(threshold);
  if (!c || !t) return false;
  return c.level >= t.level;
}

/** Parse a free-form string (CLI arg, manifest value) into a `ReadinessTierId`, else null. */
export function parseReadinessTierId(raw: string): ReadinessTierId | null {
  const normalized = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const match = READINESS_TIERS.find((t) => t.id === normalized);
  return match ? match.id : null;
}
