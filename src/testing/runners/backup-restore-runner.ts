// FORGE 2.0 — Enterprise Test Suite: BACKUP_RESTORE runner (governance-doc policy-presence gate).
//
// Gated to the ENTERPRISE_RELEASE readiness tier ONLY (`src/governance/readiness-levels.ts` —
// `MISSION_CRITICAL` id, reused verbatim by `HYPERSCALE` via `ALL_TEST_SUITES`) — same top-of-the-
// ladder placement as chaos-runner.ts / recovery-runner.ts / MUTATION's ENTERPRISE_RELEASE half.
// (Note: `BACKUP_RESTORE` was already present, pre-existing, in the `ENTERPRISE_GRADE` tier's own
// `requiredTestSuites` list alongside `LOAD` — that entry was not added by this runner and is left
// untouched; it means a build can already be *required* to have a passing BACKUP_RESTORE run one
// tier earlier than this runner's own "ENTERPRISE_RELEASE ONLY" placement in the RunnerType/
// TEST_SUITE_DB wiring implies. Both are compatible: this runner can execute at any tier it's
// invoked at, `readiness-levels.ts` alone decides which tiers actually *require* a passing run.)
//
// This is a DOCUMENTATION/POLICY-PRESENCE gate — it never performs an actual backup or restore. It
// verifies the project has documented a backup/restore policy somewhere in its governance docs,
// following `definition-of-done.ts`'s `checkNoOpenBlocker` precedent: check a bounded list of
// candidate file locations, degrade honestly (never fabricate a pass) when none are found. Unlike
// an absent *optional* tool (checkov/k6/etc. -> SKIP), an undocumented policy at the top readiness
// tier is a real, reportable gap, so absence here is a FAIL, not a SKIP — mirroring
// `checkNoOpenBlocker`'s `passed: false` (not "skipped") when its own target file is missing.
//
// Two kinds of evidence, either is sufficient:
//   1. A dedicated policy file (`docs/governance/backup-restore-policy.md` or a sibling convention)
//      with non-trivial content.
//   2. A heading inside one of the project's existing governance docs (`BEHAVIORAL_CONTRACTS.md`,
//      `STATE_OF_THE_BUILD.md`, `TESTING.md` — the root-level `ARTIFACT_FILENAMES` from
//      `src/resurrection/types.ts`) whose title matches "backup strategy" / "backup ... restore" /
//      "disaster recovery" (verbatim free-text items from `readiness-levels.ts`'s
//      `ENTERPRISE_GRADE_CHECKLIST`), followed by a non-trivial body — a bare heading with no
//      content does not count as "documented".

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type RunnerFailure, type RunnerInput, type RunnerOutcome, errorOutcome } from './types.js';

/** A dedicated policy file at any of these locations, with non-trivial content, is sufficient on its own. */
const DEDICATED_POLICY_FILES = [
  'docs/governance/backup-restore-policy.md',
  'governance/backup-restore-policy.md',
  'docs/BACKUP_RESTORE_POLICY.md',
  'BACKUP_RESTORE_POLICY.md',
];

/** Existing governance docs (root + `governance/` — the two locations
 *  `definition-of-done.ts`'s `checkNoOpenBlocker` already checks for STATE_OF_THE_BUILD.md)
 *  searched for a matching heading + body as a fallback. */
const GOVERNANCE_DOC_CANDIDATES = [
  'BEHAVIORAL_CONTRACTS.md',
  'governance/BEHAVIORAL_CONTRACTS.md',
  'STATE_OF_THE_BUILD.md',
  'governance/STATE_OF_THE_BUILD.md',
  'TESTING.md',
  'governance/TESTING.md',
];

/** Verbatim free-text items from readiness-levels.ts's ENTERPRISE_GRADE_CHECKLIST ("backup
 *  strategy", "disaster recovery"), plus the natural "backup/restore" phrasing. */
const HEADING_KEYWORDS = /backup\s*(?:\/|&|and)?\s*restore|backup\s+strategy|disaster\s+recovery|restore\s+polic/i;

const MIN_FILE_CHARS = 40;
const MIN_SECTION_CHARS = 40;

function headingLevel(line: string): number {
  const m = /^(#{1,6})\s/.exec(line);
  return m?.[1] ? m[1].length : 0;
}

/** Find the first heading matching `HEADING_KEYWORDS` whose body (up to the next heading of equal
 *  or shallower depth) has at least `MIN_SECTION_CHARS` non-whitespace characters. Returns the
 *  matching heading text, or null. */
function findDocumentedSection(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const headingLine = lines[i] ?? '';
    const level = headingLevel(headingLine);
    if (level === 0 || !HEADING_KEYWORDS.test(headingLine)) continue;
    let body = '';
    for (let j = i + 1; j < lines.length; j++) {
      const bodyLine = lines[j] ?? '';
      const nextLevel = headingLevel(bodyLine);
      if (nextLevel > 0 && nextLevel <= level) break;
      body += bodyLine + '\n';
    }
    if (body.trim().length >= MIN_SECTION_CHARS) return headingLine.trim();
  }
  return null;
}

export async function run(input: RunnerInput): Promise<RunnerOutcome> {
  const started = Date.now();
  const runner = 'governance-doc-presence';

  try {
    for (const rel of DEDICATED_POLICY_FILES) {
      const p = join(input.projectPath, rel);
      if (!existsSync(p)) continue;
      let text: string;
      try {
        text = await readFile(p, 'utf8');
      } catch {
        continue;
      }
      if (text.trim().length >= MIN_FILE_CHARS) {
        const durationMs = Date.now() - started;
        return {
          runner,
          status: 'passed',
          testsTotal: 1,
          testsPassed: 1,
          testsFailed: 0,
          testsSkipped: 0,
          durationMs,
          failures: [],
          reportPath: null,
          exitCode: null,
          detail: `dedicated backup/restore policy doc found: ${rel} (${text.trim().length} chars)`,
          coverage: null,
        };
      }
    }

    for (const rel of GOVERNANCE_DOC_CANDIDATES) {
      const p = join(input.projectPath, rel);
      if (!existsSync(p)) continue;
      let text: string;
      try {
        text = await readFile(p, 'utf8');
      } catch {
        continue;
      }
      const heading = findDocumentedSection(text);
      if (heading) {
        const durationMs = Date.now() - started;
        return {
          runner,
          status: 'passed',
          testsTotal: 1,
          testsPassed: 1,
          testsFailed: 0,
          testsSkipped: 0,
          durationMs,
          failures: [],
          reportPath: null,
          exitCode: null,
          detail: `backup/restore policy documented under "${heading}" in ${rel}`,
          coverage: null,
        };
      }
    }

    const checked = [...DEDICATED_POLICY_FILES, ...GOVERNANCE_DOC_CANDIDATES];
    const durationMs = Date.now() - started;
    const failures: RunnerFailure[] = [
      {
        name: 'backup-restore-policy-missing',
        message: `no dedicated policy file and no matching governance-doc section (backup strategy / backup+restore / disaster recovery) found — checked: ${checked.join(', ')}`,
        file: '',
      },
    ];
    return {
      runner,
      status: 'failed',
      testsTotal: 1,
      testsPassed: 0,
      testsFailed: 1,
      testsSkipped: 0,
      durationMs,
      failures,
      reportPath: null,
      exitCode: null,
      detail: `no documented backup/restore policy found — checked ${checked.length} candidate location(s)`,
      coverage: null,
    };
  } catch (error) {
    return errorOutcome(runner, `backup/restore policy check threw: ${error instanceof Error ? error.message : String(error)}`, Date.now() - started);
  }
}
