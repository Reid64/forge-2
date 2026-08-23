// FORGE 2.0 — Enterprise Test Suite: IAC runner (Infrastructure-as-Code security scan via checkov).
//
// Follows dependency-runner.ts's exact pattern: a direct external-CLI invocation + this module's
// own JSON parsing (NOT the sentinel-check.ts reuse pattern the Trivy/Semgrep/Gitleaks runners
// use — there is no equivalent Ring-3 checkov check in phase4-sentinel.ts to reuse from).
//
// SKIPPED heuristic: rather than pre-scanning the project for `*.tf`/`Dockerfile`/k8s manifests
// ourselves (a heuristic that would need to be kept in sync with every framework checkov supports),
// this runner leans on checkov's own detection: checkov always reports a `resource_count` in its
// JSON `summary`, and reports 0 when it finds no IaC resources to scan under the project root.
// Zero resources is treated as SKIPPED — simpler and more robust than reimplementing checkov's own
// file-discovery rules, and it can never silently under-scan a framework we forgot to special-case.

import { defaultShellRunner } from './exec.js';
import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

const DEFAULT_CHECKOV_TIMEOUT_MS = 5 * 60 * 1000;

interface CheckovFailedCheck {
  check_id?: string;
  check_name?: string;
  file_path?: string;
}

interface CheckovResult {
  summary?: { resource_count?: number; passed?: number; failed?: number };
  results?: { failed_checks?: CheckovFailedCheck[] };
}

/** checkov emits one result object per detected framework when more than one is present in the
 *  project (e.g. both Terraform and Kubernetes), else a single object — normalize both shapes. */
function asResultArray(data: unknown): CheckovResult[] {
  if (Array.isArray(data)) return data as CheckovResult[];
  if (data && typeof data === 'object') return [data as CheckovResult];
  return [];
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  const command = 'npx checkov -d . --output json --quiet';
  input.log(`checkov: ${command}`);
  const result = await defaultShellRunner(command, input.projectPath, input.timeoutMs ?? DEFAULT_CHECKOV_TIMEOUT_MS);
  const durationMs = Date.now() - started;

  const combined = [result.stdout, result.stderr].filter((s) => s.trim() !== '').join('\n');
  const trimmedStdout = result.stdout.trim();
  const notInstalled =
    /command not found|is not recognized|no such file|ENOENT|not installed/i.test(combined) &&
    !trimmedStdout.startsWith('{') &&
    !trimmedStdout.startsWith('[');
  if (notInstalled) {
    return skippedOutcome('checkov', 'checkov not installed or not in PATH — IAC scan skipped');
  }

  const raw = (result.stdout || result.stderr).trim();
  if (raw === '') {
    return skippedOutcome('checkov', 'checkov produced no output — SKIP');
  }

  try {
    const firstJsonChar = raw.search(/[[{]/);
    const jsonText = firstJsonChar >= 0 ? raw.slice(firstJsonChar) : raw;
    const data = JSON.parse(jsonText) as unknown;
    const results = asResultArray(data);

    const resourceCount = results.reduce((sum, r) => sum + (r.summary?.resource_count ?? 0), 0);
    if (resourceCount === 0) {
      return skippedOutcome(
        'checkov',
        'checkov found no IaC resources to scan (no Terraform/CloudFormation/Kubernetes/Dockerfile/etc.) — SKIP'
      );
    }

    const failedChecks = results.flatMap((r) => r.results?.failed_checks ?? []);
    const passedCount = results.reduce((sum, r) => sum + (r.summary?.passed ?? 0), 0);
    const failures: RunnerFailure[] = failedChecks.slice(0, 20).map((c) => ({
      name: c.check_id ?? 'unknown',
      message: c.check_name ?? 'checkov finding',
      file: c.file_path ?? '',
    }));

    const status: RunnerOutcome['status'] = failedChecks.length > 0 ? 'failed' : 'passed';
    return {
      runner: 'checkov',
      status,
      testsTotal: passedCount + failedChecks.length,
      testsPassed: passedCount,
      testsFailed: failedChecks.length,
      testsSkipped: 0,
      durationMs,
      failures,
      reportPath: null,
      exitCode: result.exitCode,
      detail:
        status === 'failed'
          ? `${failedChecks.length} IaC misconfiguration(s) across ${resourceCount} resource(s)`
          : `0 IaC misconfigurations across ${resourceCount} resource(s)`,
      coverage: null,
    };
  } catch {
    return errorOutcome('checkov', 'checkov output was unparsable', durationMs, result.exitCode);
  }
}
