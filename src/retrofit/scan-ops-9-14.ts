// FORGE 2.0 — SCAN Operations 9-14
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import type { PackageAuditEntry, GovernanceDocEntry, CompilationError, DynamicRouteResult, VercelDeployInfo } from './types.js';

export function auditPackages(projectPath: string, packageManager: string): PackageAuditEntry[] {
  const entries: PackageAuditEntry[] = [];
  const pkgPath = join(projectPath, 'package.json');
  if (!existsSync(pkgPath)) return entries;
  let pkg: Record<string, unknown>; try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { return entries; }
  const allDeps = { ...((pkg.dependencies as Record<string,string>) ?? {}), ...((pkg.devDependencies as Record<string,string>) ?? {}) };
  try {
    const cmd = packageManager === 'pnpm' ? 'pnpm audit --json' : 'npm audit --json';
    const data = JSON.parse(execSync(cmd, { cwd: projectPath, stdio: 'pipe' }).toString());
    const vulns = data?.vulnerabilities ?? data?.advisories ?? {};
    for (const [name, v] of Object.entries(vulns)) { const vuln = v as Record<string,unknown>; const sev = String(vuln.severity ?? 'moderate'); entries.push({ name, issue: 'SECURITY_ADVISORY', severity: sev === 'critical' || sev === 'high' ? 'CRITICAL' : 'WARN', currentVersion: String(allDeps[name] ?? '?') }); }
  } catch {}
  try {
    const cmd2 = packageManager === 'pnpm' ? 'pnpm outdated --json' : 'npm outdated --json';
    const data2 = JSON.parse(execSync(cmd2, { cwd: projectPath, stdio: 'pipe' }).toString());
    for (const [name, info] of Object.entries(data2)) { const i = info as Record<string,string>; if (!entries.find(e => e.name === name)) entries.push({ name, issue: 'OUTDATED', severity: 'INFO', currentVersion: i.current, latestVersion: i.latest }); }
  } catch {}
  return entries;
}

export function inventoryGovernanceDocs(projectPath: string): GovernanceDocEntry[] {
  const DOCS = ['STATE_OF_THE_BUILD.md','SESSION_STATE.md','BLUEPRINT.md','AGENTS.md','SCHEMA_REGISTRY.md','BEHAVIORAL_CONTRACTS.md','queue.yaml','PRD.md'];
  const now = Date.now();
  return DOCS.map(filename => {
    const fp = join(projectPath, filename);
    if (!existsSync(fp)) return { filename, exists: false, lastModifiedDays: null, staleness: 'MISSING' as const };
    const days = Math.floor((now - statSync(fp).mtimeMs) / 864e5);
    return { filename, exists: true, lastModifiedDays: days, staleness: (days < 7 ? 'CURRENT' : days < 30 ? 'AGING' : 'STALE') as GovernanceDocEntry['staleness'] };
  });
}

export function checkTypeScriptCompilation(projectPath: string): CompilationError[] {
  let output = '';
  try { execSync('npx tsc --noEmit --pretty false 2>&1', { cwd: projectPath, stdio: 'pipe' }); return []; }
  catch (e: unknown) { output = (e as {stdout?: Buffer}).stdout?.toString() ?? (e as {stderr?: Buffer}).stderr?.toString() ?? ''; }
  const errors: CompilationError[] = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    if (m[1] && m[2] && m[3] && m[4] && m[5]) {
      errors.push({ file: m[1], line: +m[2], column: +m[3], code: m[4], message: m[5].trim() });
    }
  }
  return errors;
}

export function runExistingTests(projectPath: string): { testFilesFound: number; passed: number|null; failed: number|null } {
  let testFilesFound = 0;
  try { testFilesFound = parseInt(execSync('find . -name "*.test.ts" -o -name "*.spec.ts" 2>/dev/null | grep -v node_modules | wc -l', { cwd: projectPath, stdio: 'pipe' }).toString().trim(), 10) || 0; } catch {}
  const hasVitest = existsSync(join(projectPath, 'vitest.config.ts')) || existsSync(join(projectPath, 'vitest.config.js'));
  if (!hasVitest) return { testFilesFound, passed: null, failed: null };
  try { const raw = execSync('npx vitest run --reporter=json', { cwd: projectPath, stdio: 'pipe', timeout: 120_000 }).toString(); const data = JSON.parse(raw); return { testFilesFound, passed: data.numPassedTests ?? 0, failed: data.numFailedTests ?? 0 }; }
  catch { return { testFilesFound, passed: null, failed: null }; }
}

export async function testDynamicRoutes(projectPath: string, routes: Array<{type: string; route: string; methods?: string[]}>, skipDynamic: boolean): Promise<DynamicRouteResult[]> {
  if (skipDynamic) return [];
  const PORT = 3099; const BASE = `http://localhost:${PORT}`; const results: DynamicRouteResult[] = [];
  const dev = spawn('npx', ['next', 'dev', '--port', String(PORT)], { cwd: projectPath, stdio: 'pipe', detached: false });
  const ready = await new Promise<boolean>(res => {
    const t = setTimeout(() => res(false), 60_000);
    const i = setInterval(async () => { try { const { default: http } = await import('node:http'); http.get(`${BASE}/`, () => { clearInterval(i); clearTimeout(t); res(true); }).on('error', () => {}); } catch {} }, 2000);
  });
  if (!ready) { dev.kill(); return [{ route: '/', url: BASE, statusCode: null, responseTimeMs: null, classification: 'WARN', error: 'Dev server failed to start' }]; }
  for (const r of routes.filter(r => r.type === 'PAGE' || (r.type === 'API' && r.methods?.includes('GET')))) {
    const url = BASE + r.route; const start = Date.now();
    try {
      const { default: http } = await import('node:http');
      const code = await new Promise<number>((resolve, reject) => { const req = http.get(url, res => resolve(res.statusCode ?? 0)); req.on('error', reject); req.setTimeout(10_000, () => { req.destroy(); reject(new Error('timeout')); }); });
      results.push({ route: r.route, url, statusCode: code, responseTimeMs: Date.now()-start, classification: code >= 500 ? 'CRITICAL' : code === 404 ? 'WARN' : (code === 401||code === 403) ? 'INFO' : 'OK' });
    } catch (e) { results.push({ route: r.route, url, statusCode: null, responseTimeMs: Date.now()-start, classification: 'WARN', error: String(e) }); }
  }
  dev.kill(); return results;
}

export function analyzeVercelDeployment(projectPath: string, vercelAvailable: boolean): VercelDeployInfo {
  if (!vercelAvailable) return { url: null, lastDeployedAt: null, daysSinceDeploy: null, status: 'UNKNOWN' };
  try {
    const raw = execSync('vercel ls --json 2>/dev/null | head -c 4096', { cwd: projectPath, stdio: 'pipe' }).toString();
    const dep = (Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [JSON.parse(raw)])[0];
    if (!dep) return { url: null, lastDeployedAt: null, daysSinceDeploy: null, status: 'UNKNOWN' };
    const createdAt = dep.created ? new Date(dep.created).toISOString() : null;
    const days = createdAt ? Math.floor((Date.now()-new Date(createdAt).getTime())/864e5) : null;
    return { url: dep.url ?? null, lastDeployedAt: createdAt, daysSinceDeploy: days, status: days !== null && days > 14 ? 'WARN' : 'OK' };
  } catch { return { url: null, lastDeployedAt: null, daysSinceDeploy: null, status: 'UNKNOWN' }; }
}
