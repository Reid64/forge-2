// Security Scanner moduleroute.ts` / `pages/api// Security Scanner module

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, isAbsolute, relative } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { nowIso } from '../memory/index.js';
import { logLine } from './forge-logger.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Public contract — severities, categories, findings
// ---------------------------------------------------------------------------

// Security Scanner module
export type Severity = 'critical' | 'high' | 'medium' | 'low';

// Security Scanner module
export type SecurityCategory =
  | 'hardcoded_secret'
  | 'sql_injection'
  | 'xss'
  | 'exposed_env_var'
  | 'missing_auth'
  | 'missing_rate_limit'
  | 'insecure_cors'
  | 'vulnerable_dependency';

// Security Scanner module
export interface SecurityFinding {
  category: SecurityCategory;
  severity: Severity;
  // Security Scanner module
  rule: string;
  // Security Scanner module
  file: string;
  // Security Scanner module
  line: number;
  // Security Scanner module
  column?: number;
  // Security Scanner module
  message: string;
  // Security Scanner module
  snippet: string;
  // Security Scanner module
  recommendation: string;
}

// Security Scanner module
export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

// Security Scanner module
export interface DependencyAuditResult {
  // Security Scanner module
  available: boolean;
  // Security Scanner module
  findings: SecurityFinding[];
  // Security Scanner module
  detail: string;
}

// Security Scanner module
export interface SecurityScanResult {
  // Security Scanner module
  passed: boolean;
  // Security Scanner module
  blocked: boolean;
  // Security Scanner module
  findings: SecurityFinding[];
  // Security Scanner module
  counts: SeverityCounts;
  // Security Scanner module
  scannedFiles: number;
  // Security Scanner module
  dependencyAuditAvailable: boolean;
  // Security Scanner module
  report: string;
  // Security Scanner module
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Public contract — input + injectable collaborators
// ---------------------------------------------------------------------------

// Security Scanner module
export interface SecurityScanInput {
  // Security Scanner module
  projectPath: string;
  // Security Scanner module
  files?: string[];
  // Security Scanner module
  runDependencyAudit?: boolean;
}

// Security Scanner module
export interface ScanCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// Security Scanner module
export type ScanCommandRunner = (
  command: string,
  cwd: string,
  timeoutMs: number
) => Promise<ScanCommandResult>;

// Security Scanner module
export interface ScannerFs {
  // Security Scanner module
  listFiles(root: string): Promise<string[]>;
  // Security Scanner module
  readFile(absPath: string): Promise<string | null>;
}

// Security Scanner module
export interface SecurityScannerOptions {
  // Security Scanner module
  fs?: ScannerFs;
  // Security Scanner module
  runAudit?: (projectPath: string) => Promise<DependencyAuditResult>;
  // Security Scanner module
  runCommand?: ScanCommandRunner;
  // Security Scanner module
  auditCommand?: string;
  // Security Scanner module
  auditTimeoutMs?: number;
  // Security Scanner module
  maxFileBytes?: number;
  // Security Scanner module
  ignoreDirs?: readonly string[];
  // Security Scanner module
  now?: () => string;
  // Security Scanner module
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Security Scanner module
export const DEFAULT_IGNORE_DIRS: readonly string[] = [
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.forge', '.turbo', '.vercel',
];

// Security Scanner module
const SOURCE_EXTS: ReadonlySet<string> = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);

const DEFAULT_MAX_FILE_BYTES = 2_000_000;
const DEFAULT_AUDIT_TIMEOUT_MS = 2 * 60 * 1000;
// Security Scanner module
const MAX_SNIPPET_CHARS = 200;

// Security Scanner module
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Security Scanner module
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

// Security Scanner module
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

// Security Scanner module
function relPath(projectPath: string, absPath: string): string {
  const rel = relative(projectPath, absPath);
  return toPosix(rel === '' ? absPath : rel);
}

// Security Scanner module
function clipSnippet(text: string): string {
  const t = (text ?? '').trim();
  return t.length <= MAX_SNIPPET_CHARS ? t : `${t.slice(0, MAX_SNIPPET_CHARS)}…`;
}

// Security Scanner module
export function redactSecret(value: string): string {
  const v = value ?? '';
  if (v.length <= 8) return '*'.repeat(v.length);
  return `${v.slice(0, 4)}${'*'.repeat(Math.min(12, v.length - 6))}${v.slice(-2)}`;
}

// Security Scanner module
function redactLine(line: string): string {
  return clipSnippet(line.replace(/[A-Za-z0-9_\-./+=]{20,}/g, (m) => redactSecret(m)));
}

// Security Scanner module
function finding(
  category: SecurityCategory,
  severity: Severity,
  rule: string,
  file: string,
  line: number,
  message: string,
  rawSnippet: string,
  recommendation: string,
  column?: number
): SecurityFinding {
  return {
    category,
    severity,
    rule,
    file,
    line,
    ...(typeof column === 'number' ? { column } : {}),
    message,
    snippet: redactLine(rawSnippet),
    recommendation,
  };
}

// ---------------------------------------------------------------------------
// Detector 1: hardcoded secrets / API keys
// ---------------------------------------------------------------------------

// Security Scanner module
interface SecretSignature {
  rule: string;
  label: string;
  pattern: RegExp;
  severity: Severity;
}

// Security Scanner module
export const SECRET_SIGNATURES: readonly SecretSignature[] = [
  { rule: 'secret.anthropic_api_key', label: 'Anthropic API key', severity: 'critical', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { rule: 'secret.openai_api_key', label: 'OpenAI API key', severity: 'critical', pattern: /sk-(?:proj-)?[A-Za-z0-9]{20,}/g },
  { rule: 'secret.aws_access_key_id', label: 'AWS access key id', severity: 'critical', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: 'secret.google_api_key', label: 'Google API key', severity: 'critical', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: 'secret.github_token', label: 'GitHub token', severity: 'critical', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b/g },
  { rule: 'secret.github_pat', label: 'GitHub fine-grained PAT', severity: 'critical', pattern: /\bgithub_pat_[0-9A-Za-z_]{40,}\b/g },
  { rule: 'secret.stripe_secret_key', label: 'Stripe secret key', severity: 'critical', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g },
  { rule: 'secret.slack_token', label: 'Slack token', severity: 'critical', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { rule: 'secret.twilio_api_key', label: 'Twilio API key SID', severity: 'high', pattern: /\bSK[0-9a-fA-F]{32}\b/g },
  { rule: 'secret.private_key_block', label: 'PEM private key', severity: 'critical', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { rule: 'secret.jwt', label: 'JSON Web Token', severity: 'high', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

// Security Scanner module
const GENERIC_SECRET_ASSIGN =
  /\b(api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*(['"`])([^'"`\n]{8,})\2/i;

// Security Scanner module
const SECRET_VALUE_ALLOWLIST =
  /(process\.env|import\.meta\.env|\$\{|<[^>]+>|example|placeholder|changeme|your[_-]?|dummy|sample|xxxx|todo|redacted|\*\*\*\*|\.\.\.)/i;

// Security Scanner module
export function scanSecrets(file: string, lineNo: number, line: string): SecurityFinding[] {
  const out: SecurityFinding[] = [];

  for (const sig of SECRET_SIGNATURES) {
    sig.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = sig.pattern.exec(line)) !== null) {
      const token = m[0] ?? '';
      out.push(
        finding(
          'hardcoded_secret', sig.severity, sig.rule, file, lineNo,
          `Hardcoded ${sig.label} (${redactSecret(token)}) committed in source`,
          line,
          'Remove the literal credential; load it from an environment variable / secret manager and rotate the exposed key immediately.',
          m.index + 1
        )
      );
    }
  }

  // Generic assignment — only when the literal value is not an env read / placeholder.
  const g = GENERIC_SECRET_ASSIGN.exec(line);
  if (g) {
    const value = g[3] ?? '';
    if (!SECRET_VALUE_ALLOWLIST.test(value) && !/^[a-z]+$/i.test(value)) {
      out.push(
        finding(
          'hardcoded_secret', 'high', 'secret.generic_assignment', file, lineNo,
          `Hardcoded credential assigned to \`${g[1]}\``,
          line,
          'Move the value to an environment variable; never commit literal credentials.',
          (g.index ?? 0) + 1
        )
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Detector 2: SQL injection (string concatenation / interpolation)
// ---------------------------------------------------------------------------

const SQL_KEYWORDS = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+TABLE|FROM|WHERE|VALUES)\b/i;
// Security Scanner module
const SQL_SINK = /\.(query|execute|raw|unsafe|exec)\s*\(|\bsql\s*`/i;

// Security Scanner module
export function scanSqlInjection(file: string, lineNo: number, line: string): SecurityFinding[] {
  if (!SQL_KEYWORDS.test(line)) return [];

  const out: SecurityFinding[] = [];
  const hasSink = SQL_SINK.test(line);

  // String concatenation of a variable into a SQL string literal: `"… WHERE id = " + userId`.
  const concat = /(['"])[^'"]*\b(SELECT|UPDATE|DELETE|INSERT|FROM|WHERE|VALUES)\b[^'"]*\1\s*\+\s*[A-Za-z_$]/i.test(line)
    || /[A-Za-z_$][\w$]*\s*\+\s*(['"])[^'"]*\b(WHERE|VALUES|SET|FROM)\b/i.test(line);

  // Template-literal interpolation of a variable inside a SQL string: `` `SELECT … ${userId}` ``.
  const interp = /`[^`]*\b(SELECT|UPDATE|DELETE|INSERT|FROM|WHERE|VALUES)\b[^`]*\$\{[^}]+\}/i.test(line);

  if (concat || interp) {
    const viaSink = hasSink || interp; // a sql`` tag or .query( is a direct DB call
    out.push(
      finding(
        'sql_injection', viaSink ? 'critical' : 'high', 'sql.string_build', file, lineNo,
        `SQL statement built by ${interp ? 'template interpolation' : 'string concatenation'} of a variable${hasSink ? ' passed to a query sink' : ''}`,
        line,
        'Use parameterized queries / prepared statements (bind parameters, e.g. `$1`) — never interpolate or concatenate user input into SQL.'
      )
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Detector 3: XSS (dangerouslySetInnerHTML, innerHTML, document.write)
// ---------------------------------------------------------------------------

// Security Scanner module
const SANITIZER = /\b(DOMPurify|sanitize|sanitizeHtml|xss\(|escapeHtml|purify)\b/i;

// Security Scanner module
export function scanXss(
  file: string,
  lineNo: number,
  line: string,
  fileHasSanitizer: boolean
): SecurityFinding[] {
  const out: SecurityFinding[] = [];

  if (/dangerouslySetInnerHTML/.test(line)) {
    const sanitizedInline = SANITIZER.test(line);
    if (!sanitizedInline && !fileHasSanitizer) {
      out.push(
        finding(
          'xss', 'high', 'xss.dangerously_set_inner_html', file, lineNo,
          'dangerouslySetInnerHTML used without an apparent sanitizer',
          line,
          'Sanitize the HTML with DOMPurify (or render as text) before injecting it; never pass unescaped user input.'
        )
      );
    }
  }

  // `el.innerHTML = <non-literal>` / outerHTML — assigning a variable/expression is a sink.
  const ih = /\.(inner|outer)HTML\s*=\s*([^;]+)/.exec(line);
  if (ih) {
    const rhs = (ih[2] ?? '').trim();
    const isStringLiteral = /^(['"`]).*\1\s*$/.test(rhs) && !/\$\{/.test(rhs);
    if (!isStringLiteral && !SANITIZER.test(line)) {
      out.push(
        finding(
          'xss', 'high', 'xss.inner_html_assignment', file, lineNo,
          `\`${ih[1]}HTML\` assigned a dynamic value (possible DOM XSS sink)`,
          line,
          'Set textContent instead, or sanitize the value with DOMPurify before assigning to innerHTML.'
        )
      );
    }
  }

  // document.write of dynamic input.
  if (/document\.write(?:ln)?\s*\(/.test(line) && /\$\{|\+|\(/.test(line.replace(/document\.write(?:ln)?\s*\(/, ''))) {
    out.push(
      finding(
        'xss', 'medium', 'xss.document_write', file, lineNo,
        'document.write() with dynamic content',
        line,
        'Avoid document.write; build DOM nodes and set textContent, or sanitize the input.'
      )
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Detector 4: exposed env vars in client-side code
// ---------------------------------------------------------------------------

// Security Scanner module
const SECRET_ENV_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|SERVICE_ROLE|DSN|WEBHOOK)/i;

// Security Scanner module
export function scanExposedEnv(file: string, lineNo: number, line: string): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  const re = /(?:process\.env|import\.meta\.env)\.([A-Z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const name = m[1] ?? '';
    if (name === '' || name.startsWith('NEXT_PUBLIC_') || name.startsWith('VITE_') || name.startsWith('PUBLIC_')) {
      continue; // public-by-convention vars are intentionally client-exposed
    }
    if (name === 'NODE_ENV') continue;
    const secretish = SECRET_ENV_NAME.test(name);
    out.push(
      finding(
        'exposed_env_var', secretish ? 'critical' : 'medium', 'env.client_exposed', file, lineNo,
        `Server environment variable \`${name}\` read in client-side code${secretish ? ' (secret-named — leaks to the browser bundle)' : ''}`,
        line,
        secretish
          ? 'Never read a secret env var in client code — it is inlined into the browser bundle. Move the access to a server route/action; only `NEXT_PUBLIC_`-prefixed values may be client-side.'
          : 'Prefix intentionally-public values with `NEXT_PUBLIC_`, or move the read to the server.',
        m.index + 1
      )
    );
  }
  return out;
}

// Security Scanner module
export function isClientSideFile(relPosixPath: string, content: string): boolean {
  // Explicit Next.js client boundary.
  if (/^\s*['"]use client['"]/m.test(content)) return true;
  // Server boundaries are definitively NOT client.
  if (/^\s*['"]use server['"]/m.test(content)) return false;
  const p = relPosixPath.toLowerCase();
  if (/\/(api|server)\//.test(p) || /\/route\.(t|j)sx?$/.test(p) || /\/middleware\.(t|j)sx?$/.test(p)) return false;
  if (/\.server\.(t|j)sx?$/.test(p)) return false;
  // A JSX component outside the server/api tree renders in the browser.
  return /\.(tsx|jsx)$/.test(p);
}

// ---------------------------------------------------------------------------
// Detector 5–7: API-route file-level checks (auth, rate limit, CORS)
// ---------------------------------------------------------------------------

// Security Scanner module
export function isApiRouteFile(relPosixPath: string): boolean {
  const p = relPosixPath.toLowerCase();
  if (/(^|\/)app\/.*\/route\.(t|j)sx?$/.test(p)) return true;
  if (/(^|\/)pages\/api\//.test(p)) return true;
  if (/(^|\/)app\/api\//.test(p) && /\.(t|j)sx?$/.test(p)) return true;
  return false;
}

// Security Scanner module
function exportsHttpHandler(content: string): boolean {
  return /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/.test(content)
    || /export\s+const\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*=/.test(content)
    || /export\s+default\s+(?:async\s+)?function/.test(content) // pages/api default handler
    || /export\s+default\s+async/.test(content);
}

const AUTH_REFERENCE =
  /\b(auth\s*\(|getUser\b|getSession\b|getServerSession\b|requireAuth\b|requireUser\b|currentUser\b|supabase\.auth|createServerClient|authenticate\b|verifyJwt\b|verifyToken\b|getToken\b|company_id)\b/i;

const RATE_LIMIT_REFERENCE =
  /\b(rateLimit|rate_limit|Ratelimit|ratelimit|limiter|throttle|slowDown|@upstash\/ratelimit|express-rate-limit|p-limit)\b/i;

// Security Scanner module
export function scanApiRouteFile(file: string, content: string): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  if (!exportsHttpHandler(content)) return out;

  // The handler's export line gives a representative location.
  const handlerLine = lineOfMatch(content, /export\s+(?:default\s+|const\s+|async\s+function\s+|(?:async\s+)?function\s+)/);

  if (!AUTH_REFERENCE.test(content)) {
    out.push(
      finding(
        'missing_auth', 'high', 'api.missing_auth', file, handlerLine,
        'API route handler does not authenticate the request (no session/user lookup found)',
        firstLineContaining(content, /export\s+/) ?? 'export … handler',
        'Derive the user/session at the top of the handler (e.g. `supabase.auth.getUser()`); reject unauthenticated requests and scope queries by the session company_id (never the request body).'
      )
    );
  }

  if (!RATE_LIMIT_REFERENCE.test(content)) {
    out.push(
      finding(
        'missing_rate_limit', 'medium', 'api.missing_rate_limit', file, handlerLine,
        'API route has no rate limiting — open to brute-force / abuse',
        firstLineContaining(content, /export\s+/) ?? 'export … handler',
        'Add a rate limiter (e.g. @upstash/ratelimit) keyed by IP / user before processing the request.'
      )
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Detector 7: insecure CORS (line-level — applies anywhere)
// ---------------------------------------------------------------------------

// Security Scanner module
export function scanCors(file: string, lineNo: number, line: string, fileAllowsCredentials: boolean): SecurityFinding[] {
  const out: SecurityFinding[] = [];

  const wildcardHeader = /['"]Access-Control-Allow-Origin['"]\s*[:,]\s*['"]\*['"]/.test(line)
    || /Access-Control-Allow-Origin['"]?\s*:\s*['"]\*['"]/.test(line);
  const wildcardCors = /\bcors\s*\(\s*\{[^}]*origin\s*:\s*(['"]\*['"]|true)/.test(line)
    || /\borigin\s*:\s*(['"]\*['"]|true)\b/.test(line);

  if (wildcardHeader || wildcardCors) {
    const withCreds = fileAllowsCredentials || /credentials\s*:\s*true/i.test(line);
    out.push(
      finding(
        'insecure_cors', withCreds ? 'high' : 'medium', 'cors.wildcard_origin', file, lineNo,
        `CORS allows any origin (\`*\`/\`true\`)${withCreds ? ' WITH credentials — any site can make authenticated requests' : ''}`,
        line,
        'Restrict the allowed origin to an explicit allow-list; never combine a wildcard origin with `credentials: true`.'
      )
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Line / match helpers
// ---------------------------------------------------------------------------

// Security Scanner module
function lineOfMatch(text: string, re: RegExp): number {
  const m = re.exec(text);
  if (!m) return 1;
  let line = 1;
  for (let i = 0; i < m.index; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

// Security Scanner module
function firstLineContaining(text: string, re: RegExp): string | null {
  for (const l of text.split(/\r?\n/)) {
    if (re.test(l)) return l.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-file scan
// ---------------------------------------------------------------------------

// Security Scanner module
export function scanFileContent(relPosixPath: string, content: string): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  const lines = content.split(/\r?\n/);

  const fileHasSanitizer = SANITIZER.test(content);
  const clientSide = isClientSideFile(relPosixPath, content);
  const allowsCredentials = /credentials\s*:\s*true/i.test(content)
    || /Access-Control-Allow-Credentials['"]?\s*[:,]\s*['"]?true/i.test(content);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    if (line.trim() === '') continue;

    out.push(...scanSecrets(relPosixPath, lineNo, line));
    out.push(...scanSqlInjection(relPosixPath, lineNo, line));
    out.push(...scanXss(relPosixPath, lineNo, line, fileHasSanitizer));
    out.push(...scanCors(relPosixPath, lineNo, line, allowsCredentials));
    if (clientSide) out.push(...scanExposedEnv(relPosixPath, lineNo, line));
  }

  // File-level API-route checks (auth, rate limit).
  if (isApiRouteFile(relPosixPath)) {
    out.push(...scanApiRouteFile(relPosixPath, content));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Dependency audit (npm audit --json)
// ---------------------------------------------------------------------------

// Security Scanner module
export function mapNpmSeverity(npmSeverity: string): Severity {
  switch ((npmSeverity ?? '').toLowerCase()) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'moderate': return 'medium';
    case 'low': return 'low';
    case 'info': return 'low';
    default: return 'low';
  }
}

// Security Scanner module
export function parseNpmAudit(json: string, packageJson?: string | null): SecurityFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const root = parsed as Record<string, unknown>;
  const findings: SecurityFinding[] = [];
  const seen = new Set<string>();

  const locate = (pkg: string): number =>
    packageJson ? lineOfMatch(packageJson, new RegExp(`["']${escapeRegExp(pkg)}["']\\s*:`)) : 0;

  const push = (pkg: string, severity: Severity, title: string, url: string, range: string): void => {
    const key = `${pkg}|${severity}|${title}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      category: 'vulnerable_dependency',
      severity,
      rule: 'dep.cve',
      file: 'package.json',
      line: locate(pkg),
      message: `Vulnerable dependency \`${pkg}\`${range ? ` (${range})` : ''}: ${title}`.trim(),
      snippet: url || `${pkg}${range ? `@${range}` : ''}`,
      recommendation: 'Run `npm audit fix` (or upgrade the package to a patched version); review breaking changes before applying.',
    });
  };

  // npm v7+ shape: { vulnerabilities: { <pkg>: { severity, via: [string|{title,url,…}], range } } }
  const vulns = root['vulnerabilities'];
  if (vulns && typeof vulns === 'object' && !Array.isArray(vulns)) {
    for (const [pkg, raw] of Object.entries(vulns as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const v = raw as Record<string, unknown>;
      const severity = mapNpmSeverity(typeof v['severity'] === 'string' ? (v['severity'] as string) : 'low');
      const range = typeof v['range'] === 'string' ? (v['range'] as string) : '';
      const via = Array.isArray(v['via']) ? (v['via'] as unknown[]) : [];
      const advisories = via.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
      if (advisories.length === 0) {
        push(pkg, severity, 'known vulnerability (transitive)', '', range);
      } else {
        for (const a of advisories) {
          const title = typeof a['title'] === 'string' ? (a['title'] as string) : 'known vulnerability';
          const url = typeof a['url'] === 'string' ? (a['url'] as string) : '';
          const aSev = typeof a['severity'] === 'string' ? mapNpmSeverity(a['severity'] as string) : severity;
          push(pkg, aSev, title, url, range);
        }
      }
    }
  }

  // Legacy / pnpm shape: { advisories: { <id>: { module_name, severity, title, url, vulnerable_versions } } }
  const advisories = root['advisories'];
  if (advisories && typeof advisories === 'object' && !Array.isArray(advisories)) {
    for (const raw of Object.values(advisories as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const a = raw as Record<string, unknown>;
      const pkg = typeof a['module_name'] === 'string' ? (a['module_name'] as string) : 'unknown';
      const severity = mapNpmSeverity(typeof a['severity'] === 'string' ? (a['severity'] as string) : 'low');
      const title = typeof a['title'] === 'string' ? (a['title'] as string) : 'known vulnerability';
      const url = typeof a['url'] === 'string' ? (a['url'] as string) : '';
      const range = typeof a['vulnerable_versions'] === 'string' ? (a['vulnerable_versions'] as string) : '';
      push(pkg, severity, title, url, range);
    }
  }

  return findings;
}

// Security Scanner module
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Security Scanner module
interface ExecLikeError {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  message?: string;
}

// Security Scanner module
async function defaultRunCommand(command: string, cwd: string, timeoutMs: number): Promise<ScanCommandResult> {
  const shell = process.platform === 'win32' ? 'powershell.exe' : undefined;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      ...(shell ? { shell } : {}),
    });
    return { ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  } catch (error) {
    const e = (error ?? {}) as ExecLikeError;
    // npm audit returns a non-zero code WITH the JSON report on stdout — keep it.
    return { ok: false, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') || String(e.message ?? '') };
  }
}

// Security Scanner module
async function defaultRunAudit(
  projectPath: string,
  run: ScanCommandRunner,
  command: string,
  timeoutMs: number,
  readFileSafe: (p: string) => Promise<string | null>,
  log: (m: string) => void
): Promise<DependencyAuditResult> {
  log(`dependency audit: ${command}`);
  const res = await run(command, projectPath, timeoutMs);
  const raw = res.stdout.trim();
  if (raw === '' || raw[0] !== '{') {
    return {
      available: false,
      findings: [],
      detail: `npm audit produced no JSON (offline / no lockfile / not installed): ${clipSnippet(res.stderr) || 'no output'}`,
    };
  }
  const packageJson = await readFileSafe(join(projectPath, 'package.json'));
  const findings = parseNpmAudit(raw, packageJson);
  const counts = countSeverities(findings);
  return {
    available: true,
    findings,
    detail: `npm audit: ${findings.length} vulnerable package(s) — ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low`,
  };
}

// ---------------------------------------------------------------------------
// Default filesystem walker
// ---------------------------------------------------------------------------

// Security Scanner module
function defaultFs(ignoreDirs: ReadonlySet<string>, maxFileBytes: number): ScannerFs {
  async function walk(dir: string, acc: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        await walk(abs, acc);
      } else if (entry.isFile()) {
        if (!SOURCE_EXTS.has(extensionOf(entry.name))) continue;
        try {
          if ((await stat(abs)).size > maxFileBytes) continue;
        } catch {
          continue;
        }
        acc.push(abs);
      }
    }
  }
  return {
    async listFiles(root: string): Promise<string[]> {
      const acc: string[] = [];
      await walk(root, acc);
      return acc;
    },
    async readFile(absPath: string): Promise<string | null> {
      try {
        return await readFile(absPath, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Counts, sorting, report
// ---------------------------------------------------------------------------

// Security Scanner module
export function countSeverities(findings: readonly SecurityFinding[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

// Security Scanner module
function sortFindings(findings: SecurityFinding[]): SecurityFinding[] {
  return [...findings].sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
}

// Security Scanner module
export function renderSecurityReport(
  findings: SecurityFinding[],
  counts: SeverityCounts,
  scannedFiles: number,
  depAuditDetail: string,
  blocked: boolean
): string {
  const icon: Record<Severity, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' };
  const lines: string[] = [];

  lines.push('# FORGE Security Scanner — Report');
  lines.push('');
  lines.push(`- **Verdict:** ${blocked ? '❌ BLOCKED (critical finding)' : counts.high + counts.medium + counts.low > 0 ? '⚠️ PASS WITH WARNINGS' : '✅ CLEAN'}`);
  lines.push(`- **Findings:** ${findings.length} (🔴 ${counts.critical} critical, 🟠 ${counts.high} high, 🟡 ${counts.medium} medium, ⚪ ${counts.low} low)`);
  lines.push(`- **Files scanned:** ${scannedFiles}`);
  lines.push(`- **Dependencies:** ${depAuditDetail}`);
  lines.push('');

  if (findings.length === 0) {
    lines.push('No security findings. ✅');
    return lines.join('\n');
  }

  lines.push('| Severity | Category | Location | Finding |');
  lines.push('|----------|----------|----------|---------|');
  for (const f of findings) {
    const loc = f.line > 0 ? `${f.file}:${f.line}${f.column ? `:${f.column}` : ''}` : f.file;
    lines.push(
      `| ${icon[f.severity]} ${f.severity} | ${f.category} | \`${loc}\` | ${f.message.replace(/\|/g, '\\|')} |`
    );
  }
  lines.push('');

  const criticals = findings.filter((f) => f.severity === 'critical');
  if (criticals.length > 0) {
    lines.push('## 🔴 Critical findings (build blocked)');
    lines.push('');
    for (const f of criticals) {
      const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
      lines.push(`### ${f.rule} — \`${loc}\``);
      lines.push(`- ${f.message}`);
      lines.push(`- \`${f.snippet.replace(/`/g, "'")}\``);
      lines.push(`- **Fix:** ${f.recommendation}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point — runSecurityScan
// ---------------------------------------------------------------------------

// Security Scanner module
export async function runSecurityScan(
  input: SecurityScanInput,
  options: SecurityScannerOptions = {}
): Promise<SecurityScanResult> {
  const projectPath = input.projectPath;
  const log = options.log ?? logLine('security');
  const now = options.now ?? nowIso;
  const ignoreDirs = new Set(options.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const fs = options.fs ?? defaultFs(ignoreDirs, maxFileBytes);

  log(`scanning ${projectPath}${input.files ? ` (${input.files.length} explicit file(s))` : ''}`);

  // Resolve the file list (explicit subset, or a full walk).
  let absFiles: string[];
  if (input.files && input.files.length > 0) {
    absFiles = input.files
      .map((f) => (isAbsolute(f) ? f : join(projectPath, f)))
      .filter((f) => SOURCE_EXTS.has(extensionOf(f)));
  } else {
    absFiles = await fs.listFiles(projectPath);
  }

  // Code-level scan.
  const codeFindings: SecurityFinding[] = [];
  let scannedFiles = 0;
  for (const abs of absFiles) {
    const content = await fs.readFile(abs);
    if (content === null) continue;
    scannedFiles++;
    try {
      codeFindings.push(...scanFileContent(relPath(projectPath, abs), content));
    } catch (error) {
      log(`WARNING: scan failed for ${abs} (${describe(error)}) — skipped`);
    }
  }

  // Dependency sub-scan.
  let dep: DependencyAuditResult = { available: false, findings: [], detail: 'dependency audit not run' };
  if (input.runDependencyAudit !== false) {
    const runAudit = options.runAudit
      ?? ((pp: string) =>
        defaultRunAudit(
          pp,
          options.runCommand ?? defaultRunCommand,
          options.auditCommand ?? 'npm audit --json',
          options.auditTimeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS,
          fs.readFile,
          log
        ));
    try {
      dep = await runAudit(projectPath);
    } catch (error) {
      log(`WARNING: dependency audit failed (${describe(error)}) — not evaluated`);
      dep = { available: false, findings: [], detail: `dependency audit errored: ${describe(error)}` };
    }
  }

  const findings = sortFindings([...codeFindings, ...dep.findings]);
  const counts = countSeverities(findings);
  const blocked = counts.critical > 0;
  const report = renderSecurityReport(findings, counts, scannedFiles, dep.detail, blocked);

  log(
    blocked
      ? `BLOCKED ❌ — ${counts.critical} critical finding(s)`
      : `PASS ${counts.high + counts.medium + counts.low > 0 ? '⚠️' : '✅'} — ${findings.length} finding(s)`
  );

  return {
    passed: !blocked,
    blocked,
    findings,
    counts,
    scannedFiles,
    dependencyAuditAvailable: dep.available,
    report,
    generatedAt: now(),
  };
}

// Security Scanner module
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default runSecurityScan;

