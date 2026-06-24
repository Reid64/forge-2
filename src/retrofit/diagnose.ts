// FORGE 2.0 — RETROFIT DIAGNOSE: All Three Reports
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { ScanReport, DiagnoseFinding, FindingSeverity } from './types.js';

export type MaturityStage = 'FOUNDATION' | 'GROWTH' | 'ENTERPRISE';
export interface ArchitectureHealthReport { critical: DiagnoseFinding[]; warn: DiagnoseFinding[]; info: DiagnoseFinding[]; adversaryFindings: DiagnoseFinding[]; generatedAt: string; }
export interface GovernanceReconciliationReport { unbuilt: Array<{ feature: string; source: string; recommendation: 'BUILD'|'DEFER'|'ABANDON' }>; undocumented: Array<{ feature: string; file: string }>; generatedAt: string; }
export interface EnterprisePatternsGapReport { maturityStage: MaturityStage; gaps: Array<{ pattern: string; required: boolean; present: boolean; severity: 'CRITICAL'|'WARN'|'INFO' }>; generatedAt: string; }

function add(findings: DiagnoseFinding[], severity: FindingSeverity, category: string, message: string, file?: string): void {
  findings.push({ severity, category, message, ...(file ? { file } : {}) });
}

export function deriveFindingsFromScanReport(report: ScanReport): DiagnoseFinding[] {
  const f: DiagnoseFinding[] = [];
  for (const b of report.brokenImports) add(f, 'CRITICAL', 'BROKEN_IMPORT', b.missingExport ? `Missing export '${b.missingExport}' in ${b.resolvedPath}` : `Cannot resolve '${b.importPath}'`, b.sourceFile);
  for (const e of report.compilationErrors) add(f, 'CRITICAL', 'TYPESCRIPT', `${e.code}: ${e.message}`, `${e.file}:${e.line}`);
  for (const e of report.envAudit) if (e.classification === 'MISSING_LOCAL' || e.classification === 'MISSING_PRODUCTION') add(f, 'CRITICAL', 'ENV_VAR', `${e.classification}: ${e.name}`);
  for (const s of report.schemaAudit) {
    if (['TABLE_MISSING_IN_DB','COLUMN_DRIFT','MISSING_RLS','STALE_MIGRATION'].includes(s.issue)) add(f, 'CRITICAL', 'SCHEMA', `${s.issue}: ${s.tableName}`);
    else if (s.issue === 'TABLE_MISSING_IN_TYPES') add(f, 'WARN', 'SCHEMA', `${s.issue}: ${s.tableName}`);
  }
  for (const d of report.dynamicAudit) { if (d.classification === 'CRITICAL') add(f, 'CRITICAL', 'DYNAMIC_ROUTE', `HTTP ${d.statusCode} on ${d.route}`); else if (d.classification === 'WARN') add(f, 'WARN', 'DYNAMIC_ROUTE', `HTTP ${d.statusCode ?? 'ERR'} on ${d.route}`); }
  for (const p of report.packageAudit) { if (p.issue === 'SECURITY_ADVISORY') add(f, p.severity as FindingSeverity, 'SECURITY', `${p.name}@${p.currentVersion ?? '?'} security advisory`); }
  for (const g of report.governanceInventory) { if (g.staleness === 'MISSING') add(f, 'WARN', 'GOVERNANCE', `${g.filename} MISSING`); else if (g.staleness === 'STALE') add(f, 'INFO', 'GOVERNANCE', `${g.filename} STALE (${g.lastModifiedDays}d)`); }
  if (report.vercelAudit.status === 'WARN') add(f, 'WARN', 'DEPLOY', `Last deploy ${report.vercelAudit.daysSinceDeploy}d ago`);
  if (report.deadFiles.length > 0) add(f, 'INFO', 'DEAD_CODE', `${report.deadFiles.length} dead files`);
  return f;
}

export async function generateArchitectureHealthReport(report: ScanReport, apiKey?: string): Promise<ArchitectureHealthReport> {
  const primary = deriveFindingsFromScanReport(report);
  let adversaryFindings: DiagnoseFinding[] = [];
  const key = apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (key) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2048, messages: [{ role: 'user', content: `You are a hostile code reviewer. Primary findings:\n${JSON.stringify(primary,null,2)}\n\nScan: ${report.fileTree.totalFiles} files, ${report.brokenImports.length} broken imports, ${report.compilationErrors.length} TS errors.\n\nFind what was MISSED or MISCLASSIFIED. What CRITICAL issue hides as INFO?\n\nRespond ONLY with a JSON array: [{severity,category,message}]. No preamble.` }] }),
      });
      if (res.ok) { const data = await res.json() as { content: Array<{type:string;text?:string}> }; const text = data.content.filter(c => c.type==='text').map(c=>c.text??'').join(''); const parsed = JSON.parse(text.replace(/```json|```/g,'').trim()) as DiagnoseFinding[]; if (Array.isArray(parsed)) adversaryFindings = parsed; }
    } catch {}
  }
  const all = [...primary, ...adversaryFindings];
  return { critical: all.filter(f=>f.severity==='CRITICAL'), warn: all.filter(f=>f.severity==='WARN'), info: all.filter(f=>f.severity==='INFO'), adversaryFindings, generatedAt: new Date().toISOString() };
}

export function detectMaturityStage(report: ScanReport): MaturityStage {
  if (report.fileTree.totalFiles > 200 && report.routeInventory.length > 20 && report.testAudit.testFilesFound > 0) return 'ENTERPRISE';
  if (report.fileTree.totalFiles > 50 || report.routeInventory.length > 5) return 'GROWTH';
  return 'FOUNDATION';
}

export function buildGovernanceReconciliationReport(report: ScanReport, projectPath: string): GovernanceReconciliationReport {
  const unbuilt: GovernanceReconciliationReport['unbuilt'] = [];
  const undocumented: GovernanceReconciliationReport['undocumented'] = [];
  const sf = join(projectPath, 'STATE_OF_THE_BUILD.md');
  if (existsSync(sf)) {
    let c = ''; try { c = readFileSync(sf, 'utf8'); } catch {}
    for (const m of c.matchAll(/\|\s*([^|]+)\s*\|\s*NOT_STARTED\s*\|/g)) unbuilt.push({ feature: m[1].trim(), source: 'STATE_OF_THE_BUILD.md', recommendation: 'BUILD' });
    for (const m of c.matchAll(/\|\s*([^|]+)\s*\|\s*DEFERRED\s*\|/g)) unbuilt.push({ feature: m[1].trim(), source: 'STATE_OF_THE_BUILD.md', recommendation: 'DEFER' });
  }
  let ag = ''; if (existsSync(join(projectPath,'AGENTS.md'))) try { ag = readFileSync(join(projectPath,'AGENTS.md'),'utf8'); } catch {}
  for (const r of report.routeInventory) { if (r.type === 'API' && !ag.includes(r.route.replace(/^\//,'')) && !ag.includes(r.file)) undocumented.push({ feature: `API route: ${r.route}`, file: r.file }); }
  return { unbuilt, undocumented, generatedAt: new Date().toISOString() };
}

const PATTERNS: Record<string, Record<'foundation'|'growth'|'enterprise', string>> = {
  'Error boundaries':         { foundation: 'skip', growth: 'check', enterprise: 'require' },
  'RLS policies':             { foundation: 'check', growth: 'require', enterprise: 'require' },
  'company_id scoping':       { foundation: 'check', growth: 'require', enterprise: 'require' },
  'Rate limiting':            { foundation: 'skip', growth: 'skip', enterprise: 'check' },
  'Error tracking (Sentry)':  { foundation: 'skip', growth: 'check', enterprise: 'require' },
  'Env var validation (zod)': { foundation: 'skip', growth: 'check', enterprise: 'require' },
};

export function buildEnterprisePatternsGapReport(report: ScanReport, projectPath: string): EnterprisePatternsGapReport {
  const maturityStage = detectMaturityStage(report);
  const key = maturityStage.toLowerCase() as 'foundation'|'growth'|'enterprise';
  const gaps: EnterprisePatternsGapReport['gaps'] = [];
  const terms: Record<string,string> = { 'Error boundaries': 'ErrorBoundary', 'RLS policies': 'MISSING_RLS', 'company_id scoping': 'company_id', 'Rate limiting': 'rateLimit', 'Error tracking (Sentry)': '@sentry', 'Env var validation (zod)': 'z.env' };
  for (const [pattern, levels] of Object.entries(PATTERNS)) {
    const level = levels[key]; if (level === 'skip') continue;
    let present = false;
    if (pattern === 'RLS policies') { present = !report.schemaAudit.some(s => s.issue === 'MISSING_RLS'); }
    else { try { execSync(`grep -r "${terms[pattern]}" "${projectPath}/src" --include="*.ts" --include="*.tsx" -l 2>/dev/null | head -1`, { stdio: 'pipe' }); present = true; } catch {} }
    gaps.push({ pattern, required: level === 'require', present, severity: level === 'require' && !present ? 'WARN' : 'INFO' });
  }
  return { maturityStage, gaps, generatedAt: new Date().toISOString() };
}
