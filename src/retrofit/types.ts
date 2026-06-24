// FORGE 2.0 — RETROFIT Pipeline Type Definitions
export type ScanScope = 'A' | 'B' | 'C';

export interface PreFlightResult {
  check: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
  autoFixed?: boolean;
}

export interface FileEntry {
  fullPath: string;
  extension: string;
  sizeBytes: number;
  lastModified: Date;
}

export interface FileTreeResult {
  totalFiles: number;
  byExtension: Record<string, { count: number; totalSizeKB: number }>;
  files: FileEntry[];
  projectSizeKB: number;
}

export interface ImportEdge {
  source: string;
  target: string;
  importedNames: string[];
  isRelative: boolean;
  resolvedTarget: string | null;
}

export interface DependencyGraph {
  nodes: Map<string, { exports: string[]; importCount: number; dependencyCount: number }>;
  edges: ImportEdge[];
}

export interface BrokenImport {
  sourceFile: string;
  importPath: string;
  resolvedPath: string | null;
  missingExport?: string;
  severity: 'CRITICAL';
}

export interface RouteEntry {
  type: 'PAGE' | 'API' | 'LAYOUT' | 'MIDDLEWARE';
  route: string;
  file: string;
  methods?: string[];
}

export interface EnvAuditEntry {
  name: string;
  classification: 'MISSING_LOCAL' | 'MISSING_PRODUCTION' | 'UNUSED' | 'VALUE_MISMATCH' | 'OK';
  severity: 'CRITICAL' | 'WARN' | 'INFO';
}

export interface SchemaAuditEntry {
  tableName: string;
  issue: 'TABLE_MISSING_IN_DB' | 'TABLE_MISSING_IN_TYPES' | 'COLUMN_DRIFT' | 'MISSING_RLS' | 'STALE_MIGRATION' | 'OK';
  severity: 'CRITICAL' | 'WARN' | 'INFO';
  detail: string;
}

export interface PackageAuditEntry {
  name: string;
  issue: 'SECURITY_ADVISORY' | 'OUTDATED' | 'UNUSED' | 'OK';
  severity: 'CRITICAL' | 'WARN' | 'INFO';
  currentVersion?: string;
  latestVersion?: string;
}

export interface GovernanceDocEntry {
  filename: string;
  exists: boolean;
  lastModifiedDays: number | null;
  staleness: 'CURRENT' | 'AGING' | 'STALE' | 'MISSING';
}

export interface CompilationError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

export interface DynamicRouteResult {
  route: string;
  url: string;
  statusCode: number | null;
  responseTimeMs: number | null;
  classification: 'OK' | 'CRITICAL' | 'WARN' | 'INFO';
  error?: string;
}

export interface VercelDeployInfo {
  url: string | null;
  lastDeployedAt: string | null;
  daysSinceDeploy: number | null;
  status: 'OK' | 'WARN' | 'UNKNOWN';
}

export interface ScanReport {
  projectName: string;
  projectPath: string;
  scanTimestamp: string;
  scanScope: ScanScope;
  supabaseAvailable: boolean;
  vercelAvailable: boolean;
  fileTree: FileTreeResult;
  brokenImports: BrokenImport[];
  deadFiles: string[];
  routeInventory: RouteEntry[];
  envAudit: EnvAuditEntry[];
  schemaAudit: SchemaAuditEntry[];
  gitAudit: {
    lastCommitHash: string | null;
    lastCommitDate: string | null;
    daysSinceCommit: number | null;
    uncommittedChanges: number;
    branches: string[];
  };
  packageAudit: PackageAuditEntry[];
  governanceInventory: GovernanceDocEntry[];
  compilationErrors: CompilationError[];
  testAudit: { testFilesFound: number; passed: number | null; failed: number | null };
  dynamicAudit: DynamicRouteResult[];
  vercelAudit: VercelDeployInfo;
}

export type FindingSeverity = 'CRITICAL' | 'WARN' | 'INFO';

export interface DiagnoseFinding {
  severity: FindingSeverity;
  category: string;
  message: string;
  file?: string;
}

export interface ReconcileDecision {
  itemId: string;
  itemType: 'CRITICAL_FIX' | 'WARN_FIX' | 'UNBUILT_FEATURE' | 'ENTERPRISE_PATTERN';
  decision: 'BUILD' | 'DEFER' | 'ABANDON' | 'APPROVE' | 'SKIP' | 'IGNORE';
  reason?: string;
  timestamp: string;
}
