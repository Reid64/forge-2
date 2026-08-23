// FORGE 2.0 — Enterprise Test Suite: SBOM runner (Software Bill of Materials via
// `trivy fs --format cyclonedx`).
//
// Follows dependency-runner.ts's exact pattern: a direct external-CLI invocation + this module's
// own JSON parsing. Distinct from trivy-runner.ts (which reuses phase4-sentinel.ts's Ring 3a
// vulnerability-severity gate via `trivy fs --format json`) — this runner asks Trivy for a
// standards-format CycloneDX bill of materials instead, written to a report artifact under
// `.forge/test-reports/` (same convention as vitest-shared.ts's Vitest JSON reports), and
// surfaces whatever vulnerabilities Trivy embeds in that BOM (CycloneDX's own `vulnerabilities`
// array) as this runner's findings — a second, independently-invoked call site, not a second
// source of truth for the Ring 3a gate.

import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { defaultShellRunner } from './exec.js';
import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

const DEFAULT_TRIVY_SBOM_TIMEOUT_MS = 5 * 60 * 1000;
const REPORT_FILE = '.forge/test-reports/sbom-cyclonedx.json';

interface CycloneDxComponent {
  name?: string;
  version?: string;
  type?: string;
}

interface CycloneDxVulnerability {
  id?: string;
  description?: string;
  ratings?: Array<{ severity?: string }>;
  affects?: Array<{ ref?: string }>;
}

interface CycloneDxBom {
  components?: CycloneDxComponent[];
  vulnerabilities?: CycloneDxVulnerability[];
}

function worstSeverity(vuln: CycloneDxVulnerability): string {
  const severities = (vuln.ratings ?? []).map((r) => (r.severity ?? '').toUpperCase());
  for (const s of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
    if (severities.includes(s)) return s;
  }
  return severities[0] ?? 'UNKNOWN';
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  const reportPath = REPORT_FILE;
  const absoluteReportPath = join(input.projectPath, reportPath);
  mkdirSync(dirname(absoluteReportPath), { recursive: true });

  const command = `trivy fs --format cyclonedx --output ${reportPath} --quiet .`;
  input.log(`trivy (SBOM): ${command}`);
  const result = await defaultShellRunner(command, input.projectPath, input.timeoutMs ?? DEFAULT_TRIVY_SBOM_TIMEOUT_MS);
  const durationMs = Date.now() - started;

  const combined = [result.stdout, result.stderr].filter((s) => s.trim() !== '').join('\n');
  const notInstalled = /command not found|is not recognized|no such file|ENOENT|not installed/i.test(combined);
  if (notInstalled) {
    return skippedOutcome('trivy-sbom', 'trivy not installed or not in PATH — SBOM generation skipped');
  }

  let raw: string | null = null;
  try {
    raw = await readFile(absoluteReportPath, 'utf8');
  } catch {
    raw = null;
  }

  if (raw === null || raw.trim() === '') {
    if (!result.ok) {
      return errorOutcome(
        'trivy-sbom',
        `trivy exited ${result.exitCode ?? 'null'} without producing an SBOM: ${(result.stderr || result.stdout).split(/\r?\n/)[0] ?? ''}`,
        durationMs,
        result.exitCode
      );
    }
    return skippedOutcome('trivy-sbom', 'trivy produced no SBOM output — SKIP');
  }

  try {
    const data = JSON.parse(raw) as CycloneDxBom;
    const components = data.components ?? [];
    const vulnerabilities = data.vulnerabilities ?? [];

    const critical = vulnerabilities.filter((v) => worstSeverity(v) === 'CRITICAL');
    const high = vulnerabilities.filter((v) => worstSeverity(v) === 'HIGH');
    const failing = [...critical, ...high];

    const failures: RunnerFailure[] = failing.slice(0, 20).map((v) => ({
      name: v.id ?? 'unknown',
      message: `[${worstSeverity(v)}] ${v.description ?? 'vulnerability found in SBOM component'}`,
      file: v.affects?.[0]?.ref ?? '',
    }));

    const status: RunnerOutcome['status'] = critical.length > 0 ? 'failed' : 'passed';
    return {
      runner: 'trivy-sbom',
      status,
      testsTotal: vulnerabilities.length,
      testsPassed: vulnerabilities.length - failing.length,
      testsFailed: failing.length,
      testsSkipped: 0,
      durationMs,
      failures,
      reportPath,
      exitCode: result.exitCode,
      detail:
        status === 'failed'
          ? `SBOM: ${components.length} component(s), ${critical.length} CRITICAL vulnerability(ies)`
          : `SBOM: ${components.length} component(s), ${vulnerabilities.length} vulnerability(ies) (0 CRITICAL)`,
      coverage: null,
    };
  } catch {
    return errorOutcome('trivy-sbom', 'trivy SBOM (CycloneDX) output was unparsable', durationMs, result.exitCode);
  }
}
