// FORGE 2.0 — RETROFIT Pre-Flight Checks
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { PreFlightResult } from './types.js';

export async function runPreFlightChecks(
  projectPath: string,
  scope: 'A' | 'B' | 'C'
): Promise<{ results: PreFlightResult[]; halted: boolean; supabaseAvailable: boolean; vercelAvailable: boolean; packageManager: string; envVars: Record<string, string> }> {
  const results: PreFlightResult[] = [];
  let halted = false;
  let supabaseAvailable = false;
  let vercelAvailable = false;
  let packageManager = 'npm';
  const envVars: Record<string, string> = {};

  if (existsSync(projectPath)) {
    results.push({ check: 'Project path exists', status: 'PASS', message: projectPath });
  } else {
    results.push({ check: 'Project path exists', status: 'FAIL', message: `Not found: ${projectPath}` });
    halted = true;
    return { results, halted, supabaseAvailable, vercelAvailable, packageManager, envVars };
  }

  if (existsSync(join(projectPath, '.git'))) {
    results.push({ check: 'Git repository', status: 'PASS', message: '.git found' });
  } else {
    try {
      execSync('git init && git add -A && git commit -m "FORGE RETROFIT: initial snapshot" --allow-empty', { cwd: projectPath, stdio: 'pipe', shell: true });
      results.push({ check: 'Git repository', status: 'PASS', message: 'Initialized', autoFixed: true });
    } catch {
      results.push({ check: 'Git repository', status: 'FAIL', message: 'Git init failed' });
      halted = true;
      return { results, halted, supabaseAvailable, vercelAvailable, packageManager, envVars };
    }
  }

  try { results.push({ check: 'Node.js', status: 'PASS', message: execSync('node --version', { stdio: 'pipe' }).toString().trim() }); } catch { results.push({ check: 'Node.js', status: 'WARN', message: 'not in PATH' }); }

  const dirFiles = readdirSync(projectPath);
  if (dirFiles.includes('pnpm-lock.yaml')) packageManager = 'pnpm';
  else if (dirFiles.includes('yarn.lock')) packageManager = 'yarn';
  results.push({ check: 'Package manager', status: 'PASS', message: packageManager });

  const envPath = join(projectPath, '.env.local');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) { const m = line.match(/^([^#=\s][^=]*)=(.*)/); if (m) envVars[m[1].trim()] = m[2].trim(); }
    results.push({ check: 'Environment file', status: 'PASS', message: `${Object.keys(envVars).length} vars` });
  } else { results.push({ check: 'Environment file', status: 'WARN', message: '.env.local not found' }); }

  if (scope === 'B' || scope === 'C') {
    const hasUrl = 'NEXT_PUBLIC_SUPABASE_URL' in envVars || 'SUPABASE_URL' in envVars;
    const hasKey = 'SUPABASE_SERVICE_ROLE_KEY' in envVars;
    if (hasUrl && hasKey) { supabaseAvailable = true; results.push({ check: 'Supabase', status: 'PASS', message: 'credentials found' }); }
    else results.push({ check: 'Supabase', status: 'WARN', message: 'Missing credentials' });
  } else results.push({ check: 'Supabase', status: 'WARN', message: 'Scope A - skipped' });

  if (scope === 'C') {
    try { execSync('vercel whoami', { stdio: 'pipe' }); vercelAvailable = true; results.push({ check: 'Vercel CLI', status: 'PASS', message: 'authenticated' }); }
    catch { results.push({ check: 'Vercel CLI', status: 'WARN', message: 'not available' }); }
  } else results.push({ check: 'Vercel CLI', status: 'WARN', message: 'Scope A/B - skipped' });

  const dbPath = join(homedir(), '.forge', 'forge_memory.db');
  results.push({ check: 'Learning DB', status: existsSync(dbPath) ? 'PASS' : 'WARN', message: existsSync(dbPath) ? dbPath : 'not found' });

  return { results, halted, supabaseAvailable, vercelAvailable, packageManager, envVars };
}
