/**
 * FORGE 2.0 — Architecture Guardian — type definitions.
 *
 * ArchitectureGuardian classifies an about-to-be-assembled Phase 3 prompt (what kind of build
 * target it is, what enterprise-grade patterns it must satisfy), validates the assembled prompt
 * against `ENTERPRISE_STANDARDS` before it reaches claude, and — on rejection — enhances the
 * prompt with the missing enforcement text rather than merely failing it (mirrors the house style
 * of `src/sentinel-prime/types.ts`: plain data shapes, no behavior).
 */

/** A prompt classified ahead of assembly — what it is, and what it must satisfy. */
export interface PromptClassification {
  promptType: string;
  buildTarget: string;
  requiredPatterns: string[];
  estimatedLines: number;
  enterpriseRequirements: string[];
}

/** The result of validating (and, when needed, enhancing) a prompt against enterprise standards. */
export interface GuardianValidation {
  approved: boolean;
  originalPrompt: string;
  enhancedPrompt: string;
  enforcementsApplied: string[];
  rejectionReason: string | null;
  estimatedOutputLines: number;
}

/** One enterprise-grade engineering standard the Guardian enforces on matching prompt types. */
export interface EnterpriseStandard {
  id: string;
  name: string;
  promptTypes: string[];
  requirement: string;
  enforcementPattern: string;
  minimumLines: number;
}

/**
 * The baseline enterprise standards ArchitectureGuardian enforces. Every standard names the
 * `promptTypes` (FORGE's `PromptType` union — `schema`/`auth`/`api`/`ui`/`feature`/`agent`/`test`/
 * `deploy`) it applies to; a standard with no naturally-scoped prompt type (line-count / stub /
 * mock-data hygiene) applies across every build-producing type.
 */
export const ENTERPRISE_STANDARDS: EnterpriseStandard[] = [
  {
    id: 'API_ROUTE_AUTH',
    name: 'API route authentication',
    promptTypes: ['api'],
    requirement: 'Every API route has authentication middleware.',
    enforcementPattern: 'Every route handler MUST derive the caller from session/auth middleware before any database read or write — never trust an unauthenticated request.',
    minimumLines: 0,
  },
  {
    id: 'API_ROUTE_VALIDATION',
    name: 'API route input validation',
    promptTypes: ['api'],
    requirement: 'Zod schema validation on all inputs.',
    enforcementPattern: 'Every route handler MUST validate its request body/query/params against a zod schema before use, rejecting on parse failure with a structured 4xx response.',
    minimumLines: 0,
  },
  {
    id: 'API_ROUTE_ERROR_STRUCTURE',
    name: 'API route structured errors',
    promptTypes: ['api'],
    requirement: 'Structured error response shape.',
    enforcementPattern: 'Every route handler MUST return errors in a consistent structured shape (e.g. `{ error: { code, message } }`), never a bare string or an unhandled thrown exception.',
    minimumLines: 0,
  },
  {
    id: 'COMPONENT_LOADING_STATE',
    name: 'Component loading state',
    promptTypes: ['ui', 'feature'],
    requirement: 'Every component has a loading state.',
    enforcementPattern: 'Every component that fetches or awaits data MUST render an explicit loading state — never a blank screen or an unguarded render against undefined data.',
    minimumLines: 0,
  },
  {
    id: 'COMPONENT_ERROR_STATE',
    name: 'Component error state',
    promptTypes: ['ui', 'feature'],
    requirement: 'Every component has an error state.',
    enforcementPattern: 'Every component that fetches or awaits data MUST render an explicit error state when the fetch/action fails — never a silent failure or an unhandled rejection.',
    minimumLines: 0,
  },
  {
    id: 'COMPONENT_EMPTY_STATE',
    name: 'Component empty state',
    promptTypes: ['ui', 'feature'],
    requirement: 'Every list or data component has an empty state.',
    enforcementPattern: 'Every component that renders a list or collection MUST render an explicit empty state when the collection has zero items — never a bare empty container.',
    minimumLines: 0,
  },
  {
    id: 'AGENT_ERROR_HANDLING',
    name: 'Agent error handling',
    promptTypes: ['agent'],
    requirement: 'Agents never throw; always return AgentRunResult.',
    enforcementPattern: 'An agent function MUST catch every internal error and return a structured `AgentRunResult` (success/failure + diagnostic detail) — it MUST NOT throw out to its caller.',
    minimumLines: 0,
  },
  {
    id: 'AGENT_DB_PERSISTENCE',
    name: 'Agent run persistence',
    promptTypes: ['agent'],
    requirement: 'Every agent run persists to the agent_runs table.',
    enforcementPattern: 'Every agent invocation MUST write one row to `agent_runs` (start, outcome, timing) regardless of whether the run succeeded or failed.',
    minimumLines: 0,
  },
  {
    id: 'DATABASE_INDEXES',
    name: 'Database foreign-key indexes',
    promptTypes: ['schema'],
    requirement: 'Every migration includes indexes on foreign keys.',
    enforcementPattern: 'Every migration that adds a foreign-key column MUST also create an index on that column — an unindexed foreign key is a defect, not an optimization deferred for later.',
    minimumLines: 0,
  },
  {
    id: 'MINIMUM_IMPLEMENTATION_LINES',
    name: 'Minimum implementation size',
    promptTypes: ['schema', 'auth', 'api', 'ui', 'feature', 'agent', 'test', 'deploy'],
    requirement: 'No file under 100 lines of real implementation.',
    enforcementPattern: 'Every file this prompt produces MUST contain at least 100 lines of real implementation — a thin wrapper or a single-purpose stub file is a defect, not a valid minimal implementation.',
    minimumLines: 100,
  },
  {
    id: 'NO_STUBS',
    name: 'No stubs or placeholders',
    promptTypes: ['schema', 'auth', 'api', 'ui', 'feature', 'agent', 'test', 'deploy'],
    requirement: 'Zero TODO, placeholder, or stub functions in output.',
    enforcementPattern: 'The output MUST contain zero `TODO`/`FIXME`/placeholder comments and zero stub functions that return a hardcoded value in place of real logic — every function must be a complete, working implementation.',
    minimumLines: 0,
  },
  {
    id: 'NO_MOCK_DATA',
    name: 'No mock data in production code',
    promptTypes: ['schema', 'auth', 'api', 'ui', 'feature', 'agent', 'test', 'deploy'],
    requirement: 'Zero hardcoded mock data arrays in production code.',
    enforcementPattern: 'Production code MUST NOT contain hardcoded mock/sample data arrays standing in for a real API call or database query — every data source must be real (test fixtures under a `tests/`/`__mocks__` path are exempt).',
    minimumLines: 0,
  },
];
