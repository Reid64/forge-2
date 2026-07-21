/**
 * FORGE 2.0 — System 5: Sentinel Prime — type definitions.
 */

export enum ObservationEventType {
  FILE_WRITE = 'FILE_WRITE',
  FILE_DELETE = 'FILE_DELETE',
  COMMAND_EXEC = 'COMMAND_EXEC',
  STDOUT_CHUNK = 'STDOUT_CHUNK',
  GATE_RESULT = 'GATE_RESULT',
  PROCESS_EXIT = 'PROCESS_EXIT',
}

export enum EventSeverity {
  INFO = 'INFO',
  WARN = 'WARN',
  CRITICAL = 'CRITICAL',
  HALT = 'HALT',
}

export interface ObservationEvent {
  id: string;
  buildRunId: string;
  promptId: string;
  promptIndex: number;
  eventType: ObservationEventType;
  severity: EventSeverity;
  artifact: string | null;
  description: string;
  rawData: Record<string, unknown>;
  timestamp: string;
}

export interface ExecutionMonitorResult {
  promptId: string;
  outOfScopeWrites: string[];
  unexpectedDeletions: string[];
  commandsExecuted: string[];
  stdoutChunks: number;
  exitCode: number | null;
  durationMs: number;
  passed: boolean;
  violations: ObservationEvent[];
}

export interface ValidationResult {
  promptId: string;
  intentFulfillmentScore: number;
  gatePassed: boolean;
  intentActuallyFulfilled: boolean;
  promptSummary: string;
  outputSummary: string;
  gaps: string[];
  confidence: number;
}

export interface DriftReport {
  artifact: string;
  contractsCited: string[];
  violationsFound: string[];
  severity: EventSeverity;
  autoResolvable: boolean;
}

export interface GovernanceEnforcerResult {
  promptId: string;
  artifactsScanned: string[];
  driftReports: DriftReport[];
  contractViolations: string[];
  passed: boolean;
}

export interface ConfidenceScore {
  composite: number;
  executionScore: number;
  validationScore: number;
  governanceScore: number;
  haltRecommended: boolean;
}

export interface HaltDecision {
  shouldHalt: boolean;
  reason: string | null;
  autoRecoverable: boolean;
  recoveryAction: string | null;
}

export interface SentinelPrimeRunResult {
  id: string;
  buildRunId: string;
  promptId: string;
  promptIndex: number;
  executionResult: ExecutionMonitorResult;
  validationResult: ValidationResult;
  governanceResult: GovernanceEnforcerResult;
  confidenceScore: ConfidenceScore;
  haltDecision: HaltDecision;
  createdAt: string;
}
