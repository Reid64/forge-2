/**
 * FORGE 2.0 — Security Scanner tests (pure `node:test`; no disk, no npm).
 *
 * Covers each detector (hardcoded secrets incl. redaction, SQL injection by concat/interpolation,
 * XSS sinks + sanitizer suppression, client-exposed env vars, missing API auth / rate limiting,
 * insecure CORS), the `npm audit --json` parser (npm v7 `vulnerabilities` + legacy `advisories`,
 * severity mapping), the `runSecurityScan` orchestrator with an injected fs + audit runner
 * (critical → blocked, clean → pass, empty → skip-able), and the Phase 4 Sentinel integration (the
 * optional eighth check: opt-in, critical fails the gate, clean passes, the default 5-check path
 * is untouched).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runSecurityScan,
  scanSecrets,
  scanSqlInjection,
  scanXss,
  scanExposedEnv,
  scanApiRouteFile,
  scanCors,
  isClientSideFile,
  isApiRouteFile,
  parseNpmAudit,
  mapNpmSeverity,
  redactSecret,
  countSeverities,
  type ScannerFs,
  type DependencyAuditResult,
  type SecurityScanResult,
  type SecurityScanInput,
} from '../src/tools/security-scanner.js';
import { runSentinel, type CommandResult } from '../src/phases/phase4-sentinel.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An in-memory ScannerFs over a { relPath → content } map (paths joined onto projectPath). */
function memFs(root: string, files: Record<string, string>): ScannerFs {
  const abs = (rel: string): string => `${root}/${rel}`.replace(/\/+/g, '/');
  const byAbs = new Map(Object.entries(files).map(([rel, content]) => [abs(rel), content]));
  return {
    async listFiles(): Promise<string[]> {
      return [...byAbs.keys()];
    },
    async readFile(p: string): Promise<string | null> {
      return byAbs.get(p.replace(/\\/g, '/')) ?? null;
    },
  };
}

/** A no-op dependency audit (so code-only tests don't depend on npm). */
const noAudit = async (): Promise<DependencyAuditResult> => ({
  available: false,
  findings: [],
  detail: 'audit disabled in test',
});

function severities(r: SecurityScanResult): string[] {
  return r.findings.map((f) => `${f.severity}:${f.category}`);
}

// ---------------------------------------------------------------------------
// Detector: hardcoded secrets
// ---------------------------------------------------------------------------

test('scanSecrets flags a recognised live key as critical and redacts it', () => {
  const line = `const key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";`;
  const found = scanSecrets('lib/x.ts', 3, line);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.severity, 'critical');
  assert.equal(found[0]?.category, 'hardcoded_secret');
  // The snippet must NOT contain the raw key.
  assert.ok(!found[0]?.snippet.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'));
});

test('scanSecrets flags a PEM private key block', () => {
  const found = scanSecrets('a.ts', 1, '-----BEGIN RSA PRIVATE KEY-----');
  assert.equal(found[0]?.severity, 'critical');
  assert.equal(found[0]?.rule, 'secret.private_key_block');
});

test('scanSecrets generic assignment fires on a literal but NOT on an env read', () => {
  assert.equal(scanSecrets('a.ts', 1, `const password = "hunter2supersecret"`).length, 1);
  assert.equal(scanSecrets('a.ts', 1, `const apiKey = process.env.API_KEY`).length, 0);
  assert.equal(scanSecrets('a.ts', 1, `const token = "your_token_here"`).length, 0);
});

test('redactSecret keeps only the edges', () => {
  assert.equal(redactSecret('abcdefghijklmnop'), 'abcd**********op');
  assert.equal(redactSecret('short'), '*****');
});

// ---------------------------------------------------------------------------
// Detector: SQL injection
// ---------------------------------------------------------------------------

test('scanSqlInjection flags string concatenation and interpolation, ignores safe SQL', () => {
  const concat = scanSqlInjection('db.ts', 5, `db.query("SELECT * FROM users WHERE id = " + userId)`);
  assert.equal(concat[0]?.category, 'sql_injection');
  assert.equal(concat[0]?.severity, 'critical'); // passed to a sink

  const interp = scanSqlInjection('db.ts', 6, 'const q = `SELECT * FROM t WHERE name = ${name}`');
  assert.equal(interp[0]?.severity, 'critical');

  // Parameterized query — no concat/interp → clean.
  assert.equal(scanSqlInjection('db.ts', 7, `db.query("SELECT * FROM users WHERE id = $1", [userId])`).length, 0);
  // A line with no SQL keyword is ignored entirely.
  assert.equal(scanSqlInjection('db.ts', 8, `const x = a + b`).length, 0);
});

// ---------------------------------------------------------------------------
// Detector: XSS
// ---------------------------------------------------------------------------

test('scanXss flags dangerouslySetInnerHTML only without a sanitizer', () => {
  assert.equal(scanXss('c.tsx', 1, '<div dangerouslySetInnerHTML={{ __html: data }} />', false).length, 1);
  // File-level sanitizer present → suppressed.
  assert.equal(scanXss('c.tsx', 1, '<div dangerouslySetInnerHTML={{ __html: data }} />', true).length, 0);
  // Inline DOMPurify → suppressed.
  assert.equal(
    scanXss('c.tsx', 1, '<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(data) }} />', false).length,
    0
  );
});

test('scanXss flags innerHTML assignment of a dynamic value but not a literal', () => {
  assert.equal(scanXss('c.ts', 1, 'el.innerHTML = userInput', false).length, 1);
  assert.equal(scanXss('c.ts', 1, 'el.innerHTML = "<b>static</b>"', false).length, 0);
});

// ---------------------------------------------------------------------------
// Detector: exposed env vars (client side)
// ---------------------------------------------------------------------------

test('scanExposedEnv: secret-named server var is critical, NEXT_PUBLIC_ is ignored', () => {
  assert.equal(scanExposedEnv('c.tsx', 1, 'const k = process.env.STRIPE_SECRET_KEY')[0]?.severity, 'critical');
  assert.equal(scanExposedEnv('c.tsx', 1, 'const u = process.env.NEXT_PUBLIC_URL').length, 0);
  assert.equal(scanExposedEnv('c.tsx', 1, 'const e = process.env.NODE_ENV').length, 0);
});

test('isClientSideFile: use client + components are client, api/route/server are not', () => {
  assert.equal(isClientSideFile('app/page.tsx', "'use client'\nexport default ..."), true);
  assert.equal(isClientSideFile('components/Button.tsx', 'export const Button = ...'), true);
  assert.equal(isClientSideFile('app/api/users/route.ts', 'export async function GET(){}'), false);
  assert.equal(isClientSideFile('lib/db.server.ts', "'use server'"), false);
  assert.equal(isClientSideFile('lib/util.ts', 'export const x = 1'), false); // non-JSX, not client
});

// ---------------------------------------------------------------------------
// Detector: API route auth / rate limit + CORS
// ---------------------------------------------------------------------------

test('isApiRouteFile recognises app router + pages/api', () => {
  assert.equal(isApiRouteFile('app/api/users/route.ts'), true);
  assert.equal(isApiRouteFile('src/app/posts/[id]/route.tsx'), true);
  assert.equal(isApiRouteFile('pages/api/login.ts'), true);
  assert.equal(isApiRouteFile('components/Button.tsx'), false);
});

test('scanApiRouteFile flags missing auth + rate limit, clean when both present', () => {
  const bad = scanApiRouteFile('app/api/x/route.ts', 'export async function POST(req){ return Response.json({}) }');
  assert.deepEqual(
    bad.map((f) => f.category).sort(),
    ['missing_auth', 'missing_rate_limit']
  );

  const good = scanApiRouteFile(
    'app/api/x/route.ts',
    `import { Ratelimit } from '@upstash/ratelimit'
     export async function POST(req){ const { data } = await supabase.auth.getUser(); await limiter.limit(); }`
  );
  assert.equal(good.length, 0);
});

test('scanCors flags a wildcard origin, escalates with credentials', () => {
  assert.equal(scanCors('h.ts', 1, `'Access-Control-Allow-Origin': '*'`, false)[0]?.severity, 'medium');
  assert.equal(scanCors('h.ts', 1, `cors({ origin: '*' })`, true)[0]?.severity, 'high');
  assert.equal(scanCors('h.ts', 1, `'Access-Control-Allow-Origin': 'https://app.example.com'`, false).length, 0);
});

// ---------------------------------------------------------------------------
// npm audit parser
// ---------------------------------------------------------------------------

test('mapNpmSeverity maps moderate→medium and info→low', () => {
  assert.equal(mapNpmSeverity('moderate'), 'medium');
  assert.equal(mapNpmSeverity('critical'), 'critical');
  assert.equal(mapNpmSeverity('info'), 'low');
});

test('parseNpmAudit reads the npm v7 vulnerabilities shape', () => {
  const json = JSON.stringify({
    vulnerabilities: {
      lodash: {
        severity: 'critical',
        range: '<4.17.21',
        via: [{ title: 'Prototype Pollution', url: 'https://x', severity: 'critical' }],
      },
    },
  });
  const f = parseNpmAudit(json, `{\n  "dependencies": {\n    "lodash": "^4.0.0"\n  }\n}`);
  assert.equal(f.length, 1);
  assert.equal(f[0]?.severity, 'critical');
  assert.equal(f[0]?.category, 'vulnerable_dependency');
  assert.equal(f[0]?.file, 'package.json');
  assert.ok((f[0]?.line ?? 0) > 0); // located in package.json
});

test('parseNpmAudit reads the legacy/pnpm advisories shape and tolerates junk', () => {
  const json = JSON.stringify({
    advisories: { '1': { module_name: 'minimist', severity: 'high', title: 'ReDoS', url: 'https://y', vulnerable_versions: '<1.2.6' } },
  });
  assert.equal(parseNpmAudit(json)[0]?.severity, 'high');
  assert.deepEqual(parseNpmAudit('not json'), []);
});

// ---------------------------------------------------------------------------
// runSecurityScan orchestration
// ---------------------------------------------------------------------------

test('runSecurityScan: a critical finding blocks the build', async () => {
  const fs = memFs('/proj', {
    'lib/keys.ts': `export const k = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"`,
    'lib/safe.ts': `export const ok = 1`,
  });
  const r = await runSecurityScan({ projectPath: '/proj' }, { fs, runAudit: noAudit, now: () => 'T' });
  assert.equal(r.blocked, true);
  assert.equal(r.passed, false);
  assert.equal(r.counts.critical, 1);
  assert.equal(r.scannedFiles, 2);
  assert.ok(severities(r).includes('critical:hardcoded_secret'));
});

test('runSecurityScan: clean code passes', async () => {
  const fs = memFs('/proj', { 'lib/safe.ts': `export const ok = process.env.API_KEY` });
  const r = await runSecurityScan({ projectPath: '/proj' }, { fs, runAudit: noAudit, now: () => 'T' });
  assert.equal(r.blocked, false);
  assert.equal(r.passed, true);
  assert.equal(r.findings.length, 0);
});

test('runSecurityScan: high-severity finding surfaces but does NOT block', async () => {
  const fs = memFs('/proj', { 'app/api/x/route.ts': `export async function GET(){ return Response.json({}) }` });
  const r = await runSecurityScan({ projectPath: '/proj' }, { fs, runAudit: noAudit });
  assert.equal(r.blocked, false);
  assert.ok(r.counts.high >= 1); // missing auth
  assert.ok(r.counts.medium >= 1); // missing rate limit
});

test('runSecurityScan: dependency CVE is merged and a critical CVE blocks', async () => {
  const fs = memFs('/proj', { 'lib/safe.ts': 'export const x = 1' });
  const runAudit = async (): Promise<DependencyAuditResult> => ({
    available: true,
    findings: parseNpmAudit(JSON.stringify({ vulnerabilities: { evil: { severity: 'critical', range: '*', via: [] } } })),
    detail: 'audited',
  });
  const r = await runSecurityScan({ projectPath: '/proj' }, { fs, runAudit });
  assert.equal(r.dependencyAuditAvailable, true);
  assert.equal(r.blocked, true);
  assert.equal(r.counts.critical, 1);
});

test('countSeverities tallies correctly', () => {
  const c = countSeverities([
    { category: 'xss', severity: 'high', rule: 'r', file: 'f', line: 1, message: '', snippet: '', recommendation: '' },
    { category: 'xss', severity: 'high', rule: 'r', file: 'f', line: 2, message: '', snippet: '', recommendation: '' },
    { category: 'sql_injection', severity: 'critical', rule: 'r', file: 'f', line: 3, message: '', snippet: '', recommendation: '' },
  ]);
  assert.deepEqual(c, { critical: 1, high: 2, medium: 0, low: 0 });
});

// ---------------------------------------------------------------------------
// Phase 4 Sentinel integration (the optional eighth check)
// ---------------------------------------------------------------------------

/** A command runner whose tsc/build always pass (so the optional check is reached). */
const greenRun = async (): Promise<CommandResult> => ({
  ok: true,
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
});

test('Sentinel: no security config → exactly the five Contract-13 checks', async () => {
  const res = await runSentinel({
    projectPath: '/proj',
    runCommand: greenRun,
    getFileChanges: async () => [],
    log: () => {},
  });
  assert.equal(res.checks.length, 5);
  assert.ok(!res.checks.some((c) => c.name === 'security_scan'));
});

test('Sentinel: a critical security finding FAILS the gate', async () => {
  const res = await runSentinel({
    projectPath: '/proj',
    runCommand: greenRun,
    getFileChanges: async () => [{ status: 'A', path: 'lib/keys.ts' }],
    securityScan: {},
    runSecurityCheck: async (_input: SecurityScanInput) => ({
      passed: false,
      blocked: true,
      findings: [
        { category: 'hardcoded_secret', severity: 'critical', rule: 'secret.anthropic_api_key', file: 'lib/keys.ts', line: 1, message: 'key', snippet: 'sk-***', recommendation: 'rotate' },
      ],
      counts: { critical: 1, high: 0, medium: 0, low: 0 },
      scannedFiles: 1,
      dependencyAuditAvailable: false,
      report: '# report',
      generatedAt: 'T',
    }),
    log: () => {},
  });
  assert.equal(res.passed, false);
  assert.equal(res.failedCheck, 'security_scan');
  const sec = res.checks.find((c) => c.name === 'security_scan');
  assert.equal(sec?.passed, false);
});

test('Sentinel: a clean security scan passes (six checks present)', async () => {
  const res = await runSentinel({
    projectPath: '/proj',
    runCommand: greenRun,
    getFileChanges: async () => [{ status: 'A', path: 'lib/safe.ts' }],
    securityScan: {},
    runSecurityCheck: async () => ({
      passed: true,
      blocked: false,
      findings: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      scannedFiles: 1,
      dependencyAuditAvailable: true,
      report: '# clean',
      generatedAt: 'T',
    }),
    log: () => {},
  });
  assert.equal(res.passed, true);
  const sec = res.checks.find((c) => c.name === 'security_scan');
  assert.equal(sec?.passed, true);
});
