import { readFile as fsReadFile, readdir, stat as fsStat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { logLine } from './forge-logger.js';
import type {
  AgentShieldCategory,
  SecurityFinding,
  SecurityGrade,
  SecurityReport,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsStat(p);
    return true;
  } catch {
    return false;
  }
}

async function readFileSafe(p: string): Promise<string | null> {
  try {
    return await fsReadFile(p, 'utf8');
  } catch {
    return null;
  }
}

const WALK_SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.forge', '.turbo', '.vercel',
]);

async function walkDir(dir: string, exts: ReadonlySet<string>): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      results.push(...(await walkDir(full, exts)));
    } else if (entry.isFile()) {
      if (exts.has(extname(entry.name).toLowerCase())) results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Finding factory
// ---------------------------------------------------------------------------

function finding(
  category: AgentShieldCategory,
  severity: SecurityFinding['severity'],
  file: string,
  message: string,
  recommendation: string,
  line?: number
): SecurityFinding {
  return { category, severity, file, message, recommendation, ...(line !== undefined ? { line } : {}) };
}

function relPath(projectPath: string, absPath: string): string {
  return absPath.startsWith(projectPath)
    ? '.' + absPath.slice(projectPath.length).replace(/\\/g, '/')
    : absPath;
}

// ---------------------------------------------------------------------------
// Category a: Secrets detection
// ---------------------------------------------------------------------------

const TS_EXTS: ReadonlySet<string> = new Set(['.ts', '.tsx']);
const ENV_NAMES = ['.env', '.env.local', '.env.production', '.env.development', '.env.staging'];

interface SecretSig {
  pattern: RegExp;
  label: string;
}

const SECRET_SIGS: readonly SecretSig[] = [
  { pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, label: 'Anthropic API key' },
  { pattern: /sk-(?:proj-)?[A-Za-z0-9]{20,}/g, label: 'OpenAI API key' },
  { pattern: /pk_(?:live|test)_[A-Za-z0-9]{16,}/g, label: 'Stripe publishable key' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AWS access key ID' },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b/g, label: 'GitHub token' },
  { pattern: /\bgithub_pat_[0-9A-Za-z_]{40,}\b/g, label: 'GitHub fine-grained PAT' },
  { pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g, label: 'Stripe secret key' },
  { pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, label: 'Slack token' },
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, label: 'PEM private key' },
];

const ENV_VAR_REF = /process\.env|import\.meta\.env|\$\{[^}]+\}/;

async function scanSecrets(projectPath: string): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];
  const tsFiles = await walkDir(projectPath, TS_EXTS);
  const envFiles: string[] = [];
  for (const name of ENV_NAMES) {
    const p = join(projectPath, name);
    if (await pathExists(p)) envFiles.push(p);
  }

  const allFiles = [...tsFiles, ...envFiles];
  for (const absPath of allFiles) {
    const content = await readFileSafe(absPath);
    if (content === null) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.trim() === '' || ENV_VAR_REF.test(line)) continue;
      for (const sig of SECRET_SIGS) {
        sig.pattern.lastIndex = 0;
        if (sig.pattern.test(line)) {
          findings.push(
            finding(
              'secrets', 'critical',
              relPath(projectPath, absPath),
              `Possible hardcoded ${sig.label} on line ${i + 1}`,
              'Remove the literal credential and load it from an environment variable; rotate the exposed key immediately.',
              i + 1
            )
          );
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Category b: Permission auditing
// ---------------------------------------------------------------------------

const SKIP_PERMS_RE = /DANGEROUSLY_SKIP_PERMISSIONS/i;

async function scanPermissions(projectPath: string): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];
  const candidates = [
    join(projectPath, '.claude', 'settings.json'),
    join(projectPath, 'settings.json'),
    join(projectPath, '.env'),
    join(projectPath, '.env.local'),
  ];
  for (const p of candidates) {
    const content = await readFileSafe(p);
    if (content === null) continue;
    if (!SKIP_PERMS_RE.test(content)) continue;
    const lineIdx = content.split(/\r?\n/).findIndex((l) => SKIP_PERMS_RE.test(l));
    findings.push(
      finding(
        'permissions', 'high',
        relPath(projectPath, p),
        'DANGEROUSLY_SKIP_PERMISSIONS is enabled — all agent permission gates are bypassed',
        'Remove this flag; implement per-action permission checks so FORGE cannot take unreviewed destructive actions.',
        lineIdx >= 0 ? lineIdx + 1 : undefined
      )
    );
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Category c: Hook injection analysis
// ---------------------------------------------------------------------------

const EXTERNAL_URL_RE = /https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/]|0\.0\.0\.0[:/])/gi;
const EXEC_CALL_RE = /\b(?:exec|spawn|execSync|spawnSync|eval|curl|wget)\b/g;

async function scanHooks(projectPath: string): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];
  const hookCandidates = [
    join(projectPath, '.claude', 'settings.json'),
    join(projectPath, 'hooks.json'),
    join(projectPath, '.claude', 'hooks.json'),
  ];

  const hooksDir = join(projectPath, 'hooks');
  if (await pathExists(hooksDir)) {
    const entries = await readdir(hooksDir).catch(() => [] as string[]);
    for (const name of entries) hookCandidates.push(join(hooksDir, name));
  }

  for (const filePath of hookCandidates) {
    const content = await readFileSafe(filePath);
    if (content === null) continue;

    const lines = content.split(/\r?\n/);
    let hasExecCall = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';

      EXTERNAL_URL_RE.lastIndex = 0;
      const urlMatch = EXTERNAL_URL_RE.exec(line);
      if (urlMatch !== null) {
        findings.push(
          finding(
            'hook_injection', 'high',
            relPath(projectPath, filePath),
            `Hook references external URL: ${urlMatch[0]}`,
            'Verify this URL is intentional; external URLs in hooks can exfiltrate context or execute arbitrary code.',
            i + 1
          )
        );
      }

      EXEC_CALL_RE.lastIndex = 0;
      if (EXEC_CALL_RE.test(line)) hasExecCall = true;
    }

    if (hasExecCall) {
      findings.push(
        finding(
          'hook_injection', 'medium',
          relPath(projectPath, filePath),
          'Hook file contains shell-execution calls (exec/spawn/eval/curl) — review for injection risk',
          'Audit all exec/spawn calls; ensure no input reaches these from user-controlled data.'
        )
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Category d: MCP server risk
// ---------------------------------------------------------------------------

const KNOWN_SAFE_CMD = /^(?:npx|node|python(?:3)?|uvx|deno)\s|^\.\//i;
const MCP_EXTERNAL_URL = /https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/i;

async function scanMcpServers(projectPath: string): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];
  const cfgCandidates = [
    join(projectPath, '.claude', 'settings.json'),
    join(projectPath, 'settings.json'),
    join(projectPath, '.mcp.json'),
  ];

  for (const cfgPath of cfgCandidates) {
    const content = await readFileSafe(cfgPath);
    if (content === null) continue;

    let cfg: unknown;
    try {
      cfg = JSON.parse(content);
    } catch {
      continue;
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;

    const root = cfg as Record<string, unknown>;
    const mcpServers = root['mcpServers'] ?? root['mcp_servers'];
    if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) continue;

    for (const [name, serverCfg] of Object.entries(mcpServers as Record<string, unknown>)) {
      if (!serverCfg || typeof serverCfg !== 'object' || Array.isArray(serverCfg)) continue;
      const s = serverCfg as Record<string, unknown>;
      const url = typeof s['url'] === 'string' ? s['url'] : null;
      const command = typeof s['command'] === 'string' ? s['command'] : null;

      if (url !== null && MCP_EXTERNAL_URL.test(url)) {
        findings.push(
          finding(
            'mcp_risk', 'high',
            relPath(projectPath, cfgPath),
            `MCP server "${name}" connects to external URL: ${url}`,
            'Confirm this MCP server is from a trusted publisher; external servers receive all agent tool invocations and can observe sensitive data.'
          )
        );
      }

      if (command !== null && !KNOWN_SAFE_CMD.test(command)) {
        findings.push(
          finding(
            'mcp_risk', 'medium',
            relPath(projectPath, cfgPath),
            `MCP server "${name}" uses an unrecognized command: ${command}`,
            'Prefer npx/node-based local MCP servers; audit unknown executables before enabling them.'
          )
        );
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Category e: Insecure defaults (CORS + missing auth in API routes)
// ---------------------------------------------------------------------------

const ROUTE_FILE_RE = /route\.(t|j)sx?$|pages[/\\]api[/\\]/i;
const HTTP_HANDLER_RE = /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b|export\s+default\s+(?:async\s+)?function/;
const AUTH_REFERENCE_RE = /\b(?:auth\s*\(|getUser\b|getSession\b|requireAuth\b|authenticate\b|verifyToken\b|supabase\.auth|createServerClient\b|company_id\b)/i;
const CORS_WILDCARD_RE = /['"]Access-Control-Allow-Origin['"]\s*[:,]\s*['"]\*['"]/i;

async function scanInsecureDefaults(projectPath: string): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];
  const tsFiles = await walkDir(projectPath, TS_EXTS);
  const routeFiles = tsFiles.filter((f) => ROUTE_FILE_RE.test(f));

  for (const absPath of routeFiles) {
    const content = await readFileSafe(absPath);
    if (content === null) continue;
    if (!HTTP_HANDLER_RE.test(content)) continue;

    const rel = relPath(projectPath, absPath);

    if (!AUTH_REFERENCE_RE.test(content)) {
      findings.push(
        finding(
          'insecure_defaults', 'high', rel,
          'API route exports an HTTP handler with no authentication check detected',
          'Add auth at the top of every handler: call supabase.auth.getUser() and reject unauthenticated requests; always derive company_id from the session, never from the request body.'
        )
      );
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (CORS_WILDCARD_RE.test(line)) {
        findings.push(
          finding(
            'insecure_defaults', 'medium', rel,
            'Wildcard CORS header (Access-Control-Allow-Origin: *) in API route',
            'Restrict CORS to an explicit allow-list; never combine a wildcard origin with credentials: true.',
            i + 1
          )
        );
        break;
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Grade + recommendations
// ---------------------------------------------------------------------------

function computeGrade(findings: readonly SecurityFinding[]): SecurityGrade {
  if (findings.length === 0) return 'A';
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const high = findings.filter((f) => f.severity === 'high').length;
  if (critical > 0 || findings.length >= 10) return 'F';
  if (high > 0) return 'D';
  if (findings.some((f) => f.severity === 'medium')) return 'C';
  return 'B';
}

function buildRecommendations(findings: readonly SecurityFinding[]): string[] {
  const recs: string[] = [];
  if (findings.some((f) => f.category === 'secrets')) {
    recs.push('Rotate all exposed credentials immediately and enable secret scanning in CI (e.g. GitHub secret scanning).');
  }
  if (findings.some((f) => f.category === 'permissions')) {
    recs.push('Remove DANGEROUSLY_SKIP_PERMISSIONS and implement explicit permission gates for every destructive agent action.');
  }
  if (findings.some((f) => f.category === 'hook_injection')) {
    recs.push('Audit all hook scripts for external network calls; restrict hooks to local operations or verified internal endpoints.');
  }
  if (findings.some((f) => f.category === 'mcp_risk')) {
    recs.push('Review MCP server registry; only allow servers from verified publishers and pin their versions.');
  }
  if (findings.some((f) => f.category === 'insecure_defaults')) {
    recs.push('Add authentication checks to every API route handler and tighten CORS to an explicit origin allow-list.');
  }
  const seen = new Set(recs);
  for (const f of findings) {
    if (!seen.has(f.recommendation)) {
      seen.add(f.recommendation);
      recs.push(f.recommendation);
    }
  }
  return recs.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function scanProjectSecurity(projectPath: string): Promise<SecurityReport> {
  const log = logLine('agent-shield');
  log(`starting AgentShield security scan for ${projectPath}`);

  const knownArtifacts = ['.claude', 'CLAUDE.md', 'settings.json', 'hooks', 'hooks.json', '.mcp.json'];
  const scannedPaths: string[] = [];
  for (const name of knownArtifacts) {
    if (await pathExists(join(projectPath, name))) scannedPaths.push(name);
  }
  log(`config artifacts found: ${scannedPaths.join(', ') || 'none'}`);

  const [secretFindings, permFindings, hookFindings, mcpFindings, defaultFindings] = await Promise.all([
    scanSecrets(projectPath),
    scanPermissions(projectPath),
    scanHooks(projectPath),
    scanMcpServers(projectPath),
    scanInsecureDefaults(projectPath),
  ]);

  const findings: SecurityFinding[] = [
    ...secretFindings,
    ...permFindings,
    ...hookFindings,
    ...mcpFindings,
    ...defaultFindings,
  ];

  const grade = computeGrade(findings);
  const recommendations = buildRecommendations(findings);
  const critical = findings.filter((f) => f.severity === 'critical').length;

  log(`scan complete — grade ${grade} | ${findings.length} finding(s) | ${critical} critical`);

  return {
    grade,
    findings,
    recommendations,
    scannedPaths,
    generatedAt: new Date().toISOString(),
  };
}
