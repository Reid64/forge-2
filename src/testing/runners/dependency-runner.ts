// FORGE 2.0 — Enterprise Test Suite: DEPENDENCY runner (TESTING_BLUEPRINT.md §13 — pnpm audit).

import { defaultShellRunner } from './exec.js';
import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

const DEFAULT_AUDIT_TIMEOUT_MS = 2 * 60 * 1000;

interface NpmStyleAdvisory {
  module_name?: string;
  title?: string;
  severity?: string;
}

interface PnpmAuditJson {
  advisories?: Record<string, NpmStyleAdvisory>;
  vulnerabilities?: Record<string, { severity?: string; name?: string }>;
}

interface Advisory {
  module: string;
  title: string;
  severity: string;
}

/** `pnpm audit --json` ships two historical shapes (npm-compatible `advisories`, or a per-package
 *  `vulnerabilities` map) depending on registry/version — normalize both, leniently. */
function extractAdvisories(data: PnpmAuditJson): Advisory[] {
  const out: Advisory[] = [];
  for (const advisory of Object.values(data.advisories ?? {})) {
    out.push({
      module: advisory.module_name ?? 'unknown',
      title: advisory.title ?? 'advisory',
      severity: advisory.severity ?? 'low',
    });
  }
  for (const [name, vuln] of Object.entries(data.vulnerabilities ?? {})) {
    out.push({ module: vuln.name ?? name, title: `${name} vulnerability`, severity: vuln.severity ?? 'low' });
  }
  return out;
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  const command = 'pnpm audit --json';
  input.log(`pnpm audit: ${command}`);
  const result = await defaultShellRunner(command, input.projectPath, input.timeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS);
  const durationMs = Date.now() - started;

  const raw = (result.stdout || result.stderr).trim();
  if (raw === '') {
    return skippedOutcome('pnpm-audit', 'pnpm audit produced no output — SKIP');
  }

  try {
    const data = JSON.parse(raw) as PnpmAuditJson;
    const advisories = extractAdvisories(data);
    const critical = advisories.filter((a) => a.severity === 'critical');
    const failing = advisories.filter((a) => a.severity === 'critical' || a.severity === 'high');
    const failures: RunnerFailure[] = failing
      .slice(0, 20)
      .map((a) => ({ name: a.module, message: a.title, file: 'package.json' }));
    const status: RunnerOutcome['status'] = critical.length > 0 ? 'failed' : 'passed';
    return {
      runner: 'pnpm-audit',
      status,
      testsTotal: advisories.length,
      testsPassed: advisories.length - failing.length,
      testsFailed: failing.length,
      testsSkipped: 0,
      durationMs,
      failures,
      reportPath: null,
      exitCode: result.exitCode,
      detail: status === 'failed' ? `${critical.length} CRITICAL advisory(ies)` : `${advisories.length} advisory(ies), 0 CRITICAL`,
      coverage: null,
    };
  } catch {
    return errorOutcome('pnpm-audit', 'pnpm audit output was unparsable', durationMs, result.exitCode);
  }
}
