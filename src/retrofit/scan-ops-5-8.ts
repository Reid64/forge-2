// FORGE 2.0 — SCAN Operations 5-8
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import type { RouteEntry, EnvAuditEntry, SchemaAuditEntry } from './types.js';

const EXCLUDE = /node_modules|\.next|\.git|dist|build/;

export function buildRouteInventory(projectPath: string): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const appDir = join(projectPath, 'app');
  const srcApp = join(projectPath, 'src', 'app');
  const root = existsSync(appDir) ? appDir : existsSync(srcApp) ? srcApp : null;
  if (!root) return routes;
  function walk(dir: string): void {
    let entries: string[]; try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const fp = join(dir, e); if (EXCLUDE.test(fp)) continue;
      let s; try { s = statSync(fp); } catch { continue; }
      if (s.isDirectory()) { walk(fp); continue; }
      const seg = '/' + relative(root!, dirname(fp)).replace(/\\/g, '/');
      if (e === 'page.tsx' || e === 'page.ts') routes.push({ type: 'PAGE', route: seg, file: relative(projectPath, fp) });
      else if (e === 'layout.tsx' || e === 'layout.ts') routes.push({ type: 'LAYOUT', route: seg, file: relative(projectPath, fp) });
      else if (e === 'route.ts' || e === 'route.js') {
        let c = ''; try { c = readFileSync(fp, 'utf8'); } catch { /* skip unreadable */ }
        const methods = ['GET','POST','PUT','DELETE','PATCH'].filter(m => new RegExp(`export\\s+(async\\s+)?function\\s+${m}`).test(c));
        routes.push({ type: 'API', route: seg, file: relative(projectPath, fp), methods });
      } else if (e === 'middleware.ts' || e === 'middleware.js') routes.push({ type: 'MIDDLEWARE', route: '/', file: relative(projectPath, fp) });
    }
  }
  walk(root);
  return routes;
}

export function auditEnvVars(projectPath: string, localEnvVars: Record<string, string>, vercelAvailable: boolean): EnvAuditEntry[] {
  const codeVars = new Set<string>();
  function walk(dir: string): void {
    let files: string[]; try { files = readdirSync(dir); } catch { return; }
    for (const f of files) {
      const fp = join(dir, f); if (EXCLUDE.test(fp)) continue;
      let s; try { s = statSync(fp); } catch { continue; }
      if (s.isDirectory()) { walk(fp); continue; }
      if (!/\.(ts|tsx|js|jsx)$/.test(f)) continue;
      let c = ''; try { c = readFileSync(fp, 'utf8'); } catch { continue; }
      for (const m of c.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) { const k = m[1]; if (k !== undefined) codeVars.add(k); }
    }
  }
  walk(projectPath);
  const vercelVars = new Set<string>();
  if (vercelAvailable) {
    try {
      const r = JSON.parse(execSync('vercel env ls --json', { stdio: 'pipe' }).toString());
      if (Array.isArray(r)) for (const v of r) if (v.key) vercelVars.add(v.key as string);
    } catch { /* vercel CLI unavailable */ }
  }
  const entries: EnvAuditEntry[] = [];
  for (const v of codeVars) {
    if (!(v in localEnvVars)) entries.push({ name: v, classification: 'MISSING_LOCAL', severity: 'CRITICAL' });
    else if (vercelAvailable && !vercelVars.has(v)) entries.push({ name: v, classification: 'MISSING_PRODUCTION', severity: 'CRITICAL' });
    else entries.push({ name: v, classification: 'OK', severity: 'INFO' });
  }
  for (const v of Object.keys(localEnvVars)) if (!codeVars.has(v)) entries.push({ name: v, classification: 'UNUSED', severity: 'INFO' });
  return entries;
}

export function extractDatabaseSchema(projectPath: string): SchemaAuditEntry[] {
  const entries: SchemaAuditEntry[] = [];
  const migrDir = join(projectPath, 'supabase', 'migrations');
  if (!existsSync(migrDir)) {
    entries.push({ tableName: '(none)', issue: 'OK', severity: 'INFO', detail: 'No migrations dir' });
    return entries;
  }
  let files: string[];
  try { files = readdirSync(migrDir).filter(f => f.endsWith('.sql')).sort(); } catch { return entries; }
  const tables = new Set<string>();
  for (const f of files) {
    let c = ''; try { c = readFileSync(join(migrDir, f), 'utf8'); } catch { continue; }
    for (const m of c.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\s*\.\s*)?"?(\w+)"?/gi)) { const t = m[1]; if (t !== undefined) tables.add(t); }
  }
  const typesFile = [join(projectPath, 'src', 'types', 'database.types.ts'), join(projectPath, 'database.types.ts')].find(existsSync) ?? null;
  const typeTables = new Set<string>();
  if (typesFile) {
    let c = ''; try { c = readFileSync(typesFile, 'utf8'); } catch { /* skip */ }
    for (const m of c.matchAll(/(\w+):\s*\{[\s\S]*?Row:/g)) { const t = m[1]; if (t !== undefined) typeTables.add(t); }
  }
  for (const t of tables) {
    if (!typeTables.has(t) && typesFile) entries.push({ tableName: t, issue: 'TABLE_MISSING_IN_TYPES', severity: 'WARN', detail: 'Run supabase gen types' });
    else entries.push({ tableName: t, issue: 'OK', severity: 'INFO', detail: 'Migration defined' });
  }
  return entries;
}

export function analyzeGitHistory(projectPath: string): {
  lastCommitHash: string | null;
  lastCommitDate: string | null;
  daysSinceCommit: number | null;
  uncommittedChanges: number;
  branches: string[];
} {
  let lastCommitHash: string | null = null;
  let lastCommitDate: string | null = null;
  let daysSinceCommit: number | null = null;
  let uncommittedChanges = 0;
  let branches: string[] = [];
  try {
    const l = execSync('git log -1 --format="%H|%ai"', { cwd: projectPath, stdio: 'pipe' })
      .toString().trim().replace(/"/g, '').split('|');
    lastCommitHash = l[0] ?? null;
    lastCommitDate = l[1] ?? null;
    if (lastCommitDate) daysSinceCommit = Math.floor((Date.now() - new Date(lastCommitDate).getTime()) / 864e5);
  } catch { /* git unavailable */ }
  try {
    const s = execSync('git status --porcelain', { cwd: projectPath, stdio: 'pipe' }).toString().trim();
    uncommittedChanges = s ? s.split('\n').length : 0;
  } catch { /* git unavailable */ }
  try {
    branches = execSync('git branch -a --format="%(refname:short)"', { cwd: projectPath, stdio: 'pipe' })
      .toString().trim().split('\n').filter(Boolean);
  } catch { /* git unavailable */ }
  return { lastCommitHash, lastCommitDate, daysSinceCommit, uncommittedChanges, branches };
}
