// FORGE 2.0 — RETROFIT Pipeline Entry Point
export { runPreFlightChecks } from './preflight.js';
export * from './types.js';
export { scanDirectoryTree, buildDependencyGraph, detectBrokenImports, detectDeadFiles } from './scan-ops-1-4.js';
export { buildRouteInventory, auditEnvVars, extractDatabaseSchema, analyzeGitHistory } from './scan-ops-5-8.js';
export { auditPackages, inventoryGovernanceDocs, checkTypeScriptCompilation, runExistingTests, testDynamicRoutes, analyzeVercelDeployment } from './scan-ops-9-14.js';
export { runScan } from './scan.js';
export type { ScanOptions } from './scan.js';
export { generateArchitectureHealthReport, deriveFindingsFromScanReport, detectMaturityStage, buildGovernanceReconciliationReport, buildEnterprisePatternsGapReport } from './diagnose.js';
export type { ArchitectureHealthReport, GovernanceReconciliationReport, EnterprisePatternsGapReport, MaturityStage } from './diagnose.js';
export { runReconcile, generateRetrofitQueue, runRetrofitPipeline } from './reconcile.js';
export type { ReconcileInput, ReconcileOutput, QueuePrompt, GeneratedQueue, RetrofitPipelineOptions } from './reconcile.js';
export { DeadCodeDetector, createDeadCodeDetector } from './dead-code-detector.js';
export type { DeadCodeFinding } from './dead-code-detector.js';
export { OrphanedRouteDetector, createOrphanedRouteDetector } from './orphaned-route-detector.js';
export type { OrphanedRouteFinding } from './orphaned-route-detector.js';
export { SchemaDriftDetector, createSchemaDriftDetector, buildResolvedSchema, buildTsTypeMap } from './schema-drift-detector.js';
export type { SchemaDriftFinding, ResolvedSchema, TsTypeMap } from './schema-drift-detector.js';
export { DependencyAuditor, createDependencyAuditor } from './dependency-auditor.js';
export type { DependencyFinding } from './dependency-auditor.js';
export { CoverageBaseline, createCoverageBaseline } from './coverage-baseline.js';
export type { CoverageBaselineFinding } from './coverage-baseline.js';
export {
  ensureGitHubActions,
  detectWorkflowConfig,
  generateCIWorkflow,
  generateVercelDeployWorkflow,
  generateForgeVerifyWorkflow,
} from './github-actions-generator.js';
export type { WorkflowConfig } from './github-actions-generator.js';
export {
  runDeepAnalysis,
  renderDeepAnalysisMarkdown,
  renderDeepAnalysisContextBlock,
  writeDeepAnalysisReport,
} from './deep-analysis.js';
export type { DeepAnalysisReport } from './deep-analysis.js';
export const RETROFIT_VERSION = '2.0.0';
