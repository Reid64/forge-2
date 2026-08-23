// FORGE 2.0 — Enterprise Test Suite: LICENSE runner (dependency license compliance via
// `trivy fs --scanners license`).
//
// Follows dependency-runner.ts's exact pattern: a direct external-CLI invocation + this module's
// own JSON parsing. Copyleft licenses (GPL/AGPL/SSPL family) are policy-sensitive but NOT a build
// blocker on their own — legal/compliance review, not FORGE, decides whether a given copyleft
// dependency is acceptable for a given project. `RunnerOutcome['status']` has no dedicated `warn`
// value (only passed/failed/skipped/error, T1's pass/fail/skip/error contract), so this runner
// represents "WARN" as `status: 'passed'` with the copyleft findings still surfaced in `failures`
// and called out in `detail` — visible, never silently dropped, but never a false FAIL either.

import { defaultShellRunner } from './exec.js';
import { errorOutcome, skippedOutcome, type RunnerFailure, type RunnerInput, type RunnerOutcome } from './types.js';

const DEFAULT_TRIVY_LICENSE_TIMEOUT_MS = 5 * 60 * 1000;

interface TrivyLicenseFinding {
  Severity?: string;
  Category?: string;
  PkgName?: string;
  FilePath?: string;
  Name?: string;
  Confidence?: number;
}

interface TrivyLicenseResult {
  Results?: Array<{
    Target?: string;
    Class?: string;
    Licenses?: TrivyLicenseFinding[];
  }>;
}

/** GPL/AGPL/SSPL family only — deliberately excludes LGPL (the "Lesser" GPL's more permissive
 *  linking terms are a materially different compliance posture, and lumping it in with GPL/AGPL/
 *  SSPL would over-warn on a very common, genuinely permissive-for-linking license). */
function isCopyleftLicense(name: string): boolean {
  const n = name.trim().toUpperCase();
  return /^A?GPL(-|$)/.test(n) || n.startsWith('SSPL');
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  const command = 'trivy fs --scanners license --format json --quiet .';
  input.log(`trivy (license): ${command}`);
  const result = await defaultShellRunner(command, input.projectPath, input.timeoutMs ?? DEFAULT_TRIVY_LICENSE_TIMEOUT_MS);
  const durationMs = Date.now() - started;

  const combined = [result.stdout, result.stderr].filter((s) => s.trim() !== '').join('\n');
  const trimmedStdout = result.stdout.trim();
  const notInstalled =
    /command not found|is not recognized|no such file|ENOENT|not installed/i.test(combined) &&
    !trimmedStdout.startsWith('{');
  if (notInstalled) {
    return skippedOutcome('trivy-license', 'trivy not installed or not in PATH — license scan skipped');
  }

  const raw = (result.stdout || result.stderr).trim();
  if (raw === '') {
    return skippedOutcome('trivy-license', 'trivy produced no output — SKIP');
  }

  try {
    const data = JSON.parse(raw) as TrivyLicenseResult;
    const licenses = (data.Results ?? []).flatMap((r) => r.Licenses ?? []);
    const copyleft = licenses.filter((l) => isCopyleftLicense(l.Name ?? ''));

    const failures: RunnerFailure[] = copyleft.slice(0, 20).map((l) => ({
      name: l.Name ?? 'unknown license',
      message: `WARN: ${l.Name ?? 'copyleft license'} found in ${l.PkgName ?? 'unknown package'} (non-blocking — review before shipping)`,
      file: l.FilePath ?? '',
    }));

    // Copyleft findings are surfaced but NEVER fail the run (see module doc comment) — status is
    // always 'passed' here (errors from a malformed/missing scan are the only non-passed outcome).
    return {
      runner: 'trivy-license',
      status: 'passed',
      testsTotal: licenses.length,
      testsPassed: licenses.length,
      testsFailed: 0,
      testsSkipped: 0,
      durationMs,
      failures,
      reportPath: null,
      exitCode: result.exitCode,
      detail:
        copyleft.length > 0
          ? `${copyleft.length} GPL/AGPL/SSPL license(s) found — WARN (non-blocking) out of ${licenses.length} scanned`
          : `0 GPL/AGPL/SSPL licenses out of ${licenses.length} scanned`,
      coverage: null,
    };
  } catch {
    return errorOutcome('trivy-license', 'trivy license scan output was unparsable', durationMs, result.exitCode);
  }
}
