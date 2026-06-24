// FORGE 2.0 — RETROFIT SCAN Orchestrator
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScanReport, ScanScope } from './types.js';
import { runPreFlightChecks } from './preflight.js';
import { scanDirectoryTree, buildDependencyGraph, detectBrokenImports, detectDeadFiles } from './scan-ops-1-4.js';
import { buildRouteInventory, auditEnvVars, extractDatabaseSchema, analyzeGitHistory } from './scan-ops-5-8.js';
import { auditPackages, inventoryGovernanceDocs, checkTypeScriptCompilation, runExistingTests, testDynamicRoutes, analyzeVercelDeployment } from './scan-ops-9-14.js';

export interface ScanOptions {
  projectPath: string;
  scope: ScanScope;
  skipDynamic?: boolean;
  resume?: boolean;
  onProgress?: (step: string, index: number, total: number) => void;
}

const EMPTY_REPORT = (projectPath: string, scope: ScanScope): ScanReport => ({
  projectName: projectPath.split(/[/\\]/).pop() ?? 'unknown', projectPath,
  scanTimestamp: new Date().toISOString(), scanScope: scope,
  supabaseAvailable: false, vercelAvailable: false,
  fileTree: { totalFiles: 0, byExtension: {}, files: [], projectSizeKB: 0 },
  brokenImports: [], deadFiles: [], routeInventory: [], envAudit: [], schemaAudit: [],
  gitAudit: { lastCommitHash: null, lastCommitDate: null, daysSinceCommit: null, uncommittedChanges: 0, branches: [] },
  packageAudit: [], governanceInventory: [], compilationErrors: [],
  testAudit: { testFilesFound: 0, passed: null, failed: null },
  dynamicAudit: [], vercelAudit: { url: null, lastDeployedAt: null, daysSinceDeploy: null, status: 'UNKNOWN' },
});

export async function runScan(options: ScanOptions): Promise<{ report: ScanReport; preFlightHalted: boolean }> {
  const { projectPath, scope, skipDynamic = false, resume: _resume = false, onProgress } = options;
  const log = (msg: string, i: number) => onProgress?.(msg, i, 14);

  const { halted, supabaseAvailable, vercelAvailable, packageManager, envVars } = await runPreFlightChecks(projectPath, scope);
  if (halted) return { report: EMPTY_REPORT(projectPath, scope), preFlightHalted: true };

  log('Directory tree', 1); const fileTree = scanDirectoryTree(projectPath);
  log('Dependency graph', 2); const depGraph = buildDependencyGraph(projectPath);
  log('Broken imports', 3); const brokenImports = detectBrokenImports(depGraph, projectPath);
  log('Dead files', 4); const deadFiles = detectDeadFiles(depGraph, projectPath);
  log('Route inventory', 5); const routeInventory = buildRouteInventory(projectPath);
  log('Env var audit', 6); const envAudit = auditEnvVars(projectPath, envVars, vercelAvailable);
  log('Schema extraction', 7); const schemaAudit = extractDatabaseSchema(projectPath);
  log('Git history', 8); const gitAudit = analyzeGitHistory(projectPath);
  log('Package audit', 9); const packageAudit = auditPackages(projectPath, packageManager);
  log('Governance inventory', 10); const governanceInventory = inventoryGovernanceDocs(projectPath);
  log('TypeScript check', 11); const compilationErrors = checkTypeScriptCompilation(projectPath);
  log('Test execution', 12); const testAudit = runExistingTests(projectPath);
  log('Dynamic route testing', 13); const dynamicAudit = await testDynamicRoutes(projectPath, routeInventory, skipDynamic);
  log('Vercel analysis', 14); const vercelAudit = analyzeVercelDeployment(projectPath, vercelAvailable);

  const report: ScanReport = {
    projectName: projectPath.split(/[/\\]/).pop() ?? 'unknown', projectPath,
    scanTimestamp: new Date().toISOString(), scanScope: scope,
    supabaseAvailable, vercelAvailable, fileTree, brokenImports, deadFiles,
    routeInventory, envAudit, schemaAudit, gitAudit, packageAudit,
    governanceInventory, compilationErrors, testAudit, dynamicAudit, vercelAudit,
  };

  const forgeDir = join(projectPath, '.forge');
  mkdirSync(forgeDir, { recursive: true });
  writeFileSync(join(forgeDir, 'scan_report.json'), JSON.stringify(report, null, 2), 'utf8');
  return { report, preFlightHalted: false };
}
