/**
 * FORGE 2.0 — System 5: Sentinel Prime — GovernanceEnforcer.
 *
 * A post-prompt contract scanner. Where ExecutionMonitor watches HOW a prompt's subprocess ran
 * (out-of-scope writes, destructive commands) and DecisionValidator judges WHAT the diff produced
 * against the prompt's stated intent, GovernanceEnforcer checks the diff against FORGE's OWN
 * governing rules: does the code a prompt just wrote actually contradict a numbered contract in
 * `BEHAVIORAL_CONTRACTS.md`?
 *
 * Contract 3 (Governance Immutability During Execution) already halts a build the instant a prompt
 * tries to EDIT a governance document. GovernanceEnforcer catches the harder, quieter case: a
 * prompt that never touches BEHAVIORAL_CONTRACTS.md at all, but writes application/tooling code
 * that violates what the document promises — an unguarded write to `build_runs` from code that
 * runs during an in-flight build (contradicting Contract R-2's "Regeneration Only Between Phases"),
 * a hardcoded auto-approval that reintroduces the exact `--auto-approve-gates`/`--accept-blockers`
 * conflation Session 5.1 had to hotfix, code that writes into `src/` at runtime, or a stray call to
 * the metered `api.anthropic.com` endpoint where the contract promises a $0-incremental-cost CLI
 * subprocess path (Contract 5).
 *
 * METHOD (per this task's brief, F-series style — read the doc, parse contracts, match by keyword
 * overlap, scan for a small fixed set of known contradiction shapes, never fabricate a finding):
 *   1. Read BEHAVIORAL_CONTRACTS.md from `projectPath` (reusing System 1's `findGovernanceDoc`, so
 *      a project that keeps its governance docs under `governance/` or `docs/` is still found).
 *   2. Parse every `### Contract N: Title` / `### Contract R-1: Title` heading into an id + title +
 *      body, by stripping Markdown heading hashes and testing the stripped line against a single
 *      pattern that folds this task's two literal patterns (`/^##? Contract \d+/i` and
 *      `/^Contract [A-Z]?-?\d+:/i`) into one heading-depth-agnostic check (FORGE's real doc nests
 *      contracts three levels deep, `###`, one level past the first literal pattern).
 *   3. For each modified `.ts`/`.tsx` file, read its content and, for every contract whose body
 *      shares enough vocabulary with the file (keyword overlap — a cheap, dependency-free proxy for
 *      "this contract is plausibly about this file"), run the small library of named contradiction
 *      scanners below.
 *   4. Every contradiction becomes a CRITICAL, non-auto-resolvable `DriftReport`. A prompt that
 *      touched `src/` but left STATE_OF_THE_BUILD.md/SESSION_STATE.md untouched (CLAUDE.md's
 *      Session End Requirements) becomes a WARN, auto-resolvable `DriftReport` instead — a
 *      documentation lag, not a contract breach.
 *
 * Read-only (Contract R-1's spirit extended to this scanner too) and never throws (Iron Law 3): an
 * unreadable file or a missing governance doc degrades to a logged WARN and a smaller scan, never a
 * fabricated pass or a crash.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';

import { findGovernanceDoc } from '../resurrection/governance-gaps.js';
import { logLine } from '../tools/forge-logger.js';
import { EventSeverity, type DriftReport, type GovernanceEnforcerResult } from './types.js';

// ---------------------------------------------------------------------------
// Contract parsing
// ---------------------------------------------------------------------------

/** One parsed `### Contract N: Title` (or `### Contract R-1: Title`) entry. */
export interface ParsedContract {
  id: string;
  title: string;
  body: string;
}

/**
 * Matches a "Contract N" / "Contract R-1" line ONCE any leading Markdown heading hashes have been
 * stripped — the union of this task's two literal patterns, generalized past a fixed heading depth.
 */
const CONTRACT_ID_PATTERN = /^Contract\s+([A-Za-z]?-?\d+)\s*:?\s*(.*)$/i;

/** Any bare (non-contract) `#`/`##` heading — closes an in-progress contract body when encountered. */
const SECTION_BOUNDARY_PATTERN = /^#{1,2}\s+\S/;

function matchContractHeading(line: string): { id: string; title: string } | null {
  const stripped = line.replace(/^#{1,6}\s*/, '').trim();
  const m = stripped.match(CONTRACT_ID_PATTERN);
  if (!m) return null;
  return { id: (m[1] ?? '').trim(), title: (m[2] ?? '').trim() };
}

/**
 * Parse every contract entry out of BEHAVIORAL_CONTRACTS.md's raw content. A contract's body runs
 * from immediately after its heading until the next contract heading, the next bare `#`/`##`
 * section boundary (e.g. `## CLI Contracts`), or end of file.
 */
export function parseContracts(content: string): ParsedContract[] {
  const lines = content.split(/\r?\n/);
  const contracts: ParsedContract[] = [];
  let current: { id: string; title: string; bodyLines: string[] } | null = null;

  const flush = (): void => {
    if (current) {
      contracts.push({ id: current.id, title: current.title, body: current.bodyLines.join('\n').trim() });
    }
    current = null;
  };

  for (const line of lines) {
    const heading = matchContractHeading(line);
    if (heading) {
      flush();
      current = { id: heading.id, title: heading.title, bodyLines: [] };
      continue;
    }
    if (current && SECTION_BOUNDARY_PATTERN.test(line) && !/^#{1,2}\s*Contract\b/i.test(line)) {
      flush();
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  flush();

  return contracts;
}

// ---------------------------------------------------------------------------
// Keyword-overlap contract-to-file matching
// ---------------------------------------------------------------------------

/** Common English words dropped from keyword sets — vocabulary overlap should mean something. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'about', 'above', 'after', 'again', 'against', 'always', 'among', 'because', 'before', 'being',
  'below', 'between', 'cannot', 'could', 'does', 'doing', 'during', 'either', 'every', 'exactly',
  'from', 'further', 'having', 'however', 'into', 'itself', 'never', 'other', 'over', 'same',
  'shall', 'should', 'since', 'still', 'such', 'than', 'that', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'under', 'unless', 'until', 'upon', 'very', 'when',
  'where', 'which', 'while', 'with', 'would', 'while', 'system',
]);

/** Minimum number of shared keyword tokens before a (contract, file) pair is scanned at all. */
const MIN_KEYWORD_OVERLAP = 2;

/** Extract lowercase, deduplicated, stopword-filtered keyword tokens (length >= 5) from text. */
function extractKeywords(text: string, minLength = 5, maxKeywords = 40): Set<string> {
  const words = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  const keywords = new Set<string>();
  for (const word of words) {
    if (word.length < minLength || STOPWORDS.has(word)) continue;
    keywords.add(word);
    if (keywords.size >= maxKeywords) break;
  }
  return keywords;
}

/** Count how many of `keywords` appear as a substring of `haystack` (case-insensitive). */
function keywordOverlapCount(keywords: ReadonlySet<string>, haystack: string): number {
  const lower = haystack.toLowerCase();
  let count = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Named contradiction scanners
// ---------------------------------------------------------------------------

/**
 * A single named contradiction shape: `contractAsserts` decides whether a contract's body actually
 * makes this promise at all (so the scanner only runs where it is plausibly relevant); `scanFile`
 * looks for code that breaks that promise, returning zero or more human-readable violation messages.
 */
interface ContradictionRule {
  name: string;
  contractAsserts: (contractBody: string) => boolean;
  scanFile: (fileContent: string) => string[];
}

/** "Never write during an active Phase 3 build" (Contract R-2's "Regeneration Only Between Phases"). */
const PHASE3_WRITE_GUARD_RULE: ContradictionRule = {
  name: 'unguarded-build-state-write-during-active-build',
  contractAsserts: (body) =>
    /(never\s+writes?|read-only|must\s+not\s+write|no\s+writes?)[^.]{0,150}(phase\s*3|in-?flight\s+build|active\s+build)/i.test(
      body
    ) ||
    /(phase\s*3|in-?flight\s+build|active\s+build)[^.]{0,150}(never\s+writes?|read-only|must\s+not\s+write)/i.test(body),
  scanFile: (fileContent) => {
    const writePattern = /\b(INSERT\s+INTO|UPDATE)\s+build_runs\b|\bcreateBuild\s*\(|\bupdateBuild\s*\(/gi;
    const matches = fileContent.match(writePattern);
    if (!matches) return [];
    const hasGuard = /isBuildInFlight|buildInFlight|refuseIfInFlight|inFlightCheck|Contract\s*R-2/i.test(fileContent);
    if (hasGuard) return [];
    const distinct = Array.from(new Set(matches));
    return [
      `${matches.length} unguarded build-state write call(s) found (${distinct.join(
        ', '
      )}) with no in-flight-build guard token anywhere in the file`,
    ];
  },
};

/** "It never auto-approves" (Contract R-3's HumanGateEvaluator promise; also Contract 2's four gates). */
const AUTO_APPROVE_RULE: ContradictionRule = {
  name: 'silent-auto-approve',
  contractAsserts: (body) => /never\s+auto-?approves?/i.test(body) || /it\s+never\s+auto-?approves/i.test(body),
  scanFile: (fileContent) => {
    const violations: string[] = [];
    if (/auto[-_]?approve\w*\s*[:=]\s*true\b/i.test(fileContent)) {
      violations.push('a variable/field named auto-approve* is hardcoded to true');
    }
    if (/\|\|\s*\(?\s*(opts?\.)?\w*auto[-_]?approve/i.test(fileContent)) {
      violations.push(
        'an auto-approve flag is OR-conflated into an accept/approve decision — the exact shape of the Session 5.1 --auto-approve-gates/--accept-blockers regression'
      );
    }
    return violations;
  },
};

/** "FORGE never self-modifies its own source." */
const SELF_MODIFY_RULE: ContradictionRule = {
  name: 'self-modifying-source-write',
  contractAsserts: (body) => /never\s+self-?modif|must\s+not\s+modify\s+its\s+own\s+source/i.test(body),
  scanFile: (fileContent) => {
    const pattern = /\bfs\.writeFile(?:Sync)?\s*\([^)]*[\\/]src[\\/]/gi;
    const matches = fileContent.match(pattern);
    if (!matches) return [];
    return [`${matches.length} fs.writeFile(Sync) call(s) target a path under src/`];
  },
};

/** "Cost must be $0" / "zero incremental cost" (Contract 5 — Max-subscription CLI path, never a metered call). */
const ZERO_COST_RULE: ContradictionRule = {
  name: 'metered-api-call-introduced',
  contractAsserts: (body) => /\$0\b|zero[-\s]?(incremental\s+)?cost|max-?subscription/i.test(body),
  scanFile: (fileContent) => {
    if (!/api\.anthropic\.com/i.test(fileContent)) return [];
    return [
      'a direct reference to the metered api.anthropic.com endpoint was introduced — the contract requires the claude CLI subprocess / Max-subscription path, never a paid API call',
    ];
  },
};

const CONTRADICTION_RULES: readonly ContradictionRule[] = [
  PHASE3_WRITE_GUARD_RULE,
  AUTO_APPROVE_RULE,
  SELF_MODIFY_RULE,
  ZERO_COST_RULE,
];

// ---------------------------------------------------------------------------
// Governance-update freshness (WARN / autoResolvable, not a contract contradiction)
// ---------------------------------------------------------------------------

/** CLAUDE.md's "SESSION END REQUIREMENTS" — the docs a real code change is expected to keep fresh. */
const GOVERNANCE_UPDATE_DOCS: readonly string[] = ['STATE_OF_THE_BUILD.md', 'SESSION_STATE.md'];

// ---------------------------------------------------------------------------
// GovernanceEnforcer
// ---------------------------------------------------------------------------

/** Options for {@link GovernanceEnforcer}. */
export interface GovernanceEnforcerOptions {
  /** Progress reporter. Default logs to the console with a `[FORGE:governance-enforcer]` prefix. */
  log?: (message: string) => void;
}

/**
 * Post-prompt contract scanner. One instance may be reused across every prompt in a build —
 * `enforce()` holds no mutable per-call state. Read-only and never throws (Iron Law 3).
 */
export class GovernanceEnforcer {
  private readonly log: (message: string) => void;

  constructor(options: GovernanceEnforcerOptions = {}) {
    this.log = options.log ?? logLine('governance-enforcer');
  }

  /**
   * Scan the files a completed prompt modified for contradictions against
   * `BEHAVIORAL_CONTRACTS.md`'s numbered contracts, plus a lighter check for a governance-doc
   * update left behind after a real source change.
   *
   * `passed` is `false` whenever any CRITICAL {@link DriftReport} was recorded — a WARN-only result
   * (missing STATE_OF_THE_BUILD.md/SESSION_STATE.md update) does not fail the prompt on its own.
   */
  async enforce(projectPath: string, promptId: string, modifiedFiles: string[]): Promise<GovernanceEnforcerResult> {
    const artifactsScanned: string[] = [];
    const driftReports: DriftReport[] = [];

    const contracts = this.loadContracts(projectPath, promptId, artifactsScanned);
    const contractKeywords = new Map<string, Set<string>>();
    for (const contract of contracts) {
      contractKeywords.set(contract.id, extractKeywords(contract.body));
    }

    const tsFiles = Array.from(new Set(modifiedFiles)).filter((f) =>
      ['.ts', '.tsx'].includes(extname(f).toLowerCase())
    );

    for (const file of tsFiles) {
      const fileContent = this.readModifiedFile(projectPath, file);
      if (fileContent === null) continue;

      for (const contract of contracts) {
        const keywords = contractKeywords.get(contract.id) ?? new Set<string>();
        if (keywordOverlapCount(keywords, fileContent) < MIN_KEYWORD_OVERLAP) continue;

        for (const rule of CONTRADICTION_RULES) {
          if (!rule.contractAsserts(contract.body)) continue;
          const violations = rule.scanFile(fileContent);
          if (violations.length === 0) continue;

          driftReports.push({
            artifact: file,
            contractsCited: [contract.id],
            violationsFound: violations,
            severity: EventSeverity.CRITICAL,
            autoResolvable: false,
          });

          this.log(
            `CRITICAL: prompt '${promptId}' — '${file}' contradicts Contract ${contract.id} (${rule.name}): ${violations.join(
              '; '
            )}`
          );
        }
      }
    }

    this.checkGovernanceUpdateFreshness(projectPath, promptId, modifiedFiles, artifactsScanned, driftReports);

    const contractViolations = driftReports
      .filter((d) => d.severity === EventSeverity.CRITICAL)
      .flatMap((d) => d.violationsFound.map((v) => `Contract ${d.contractsCited.join(',') || '?'} (${d.artifact}): ${v}`));

    const passed = !driftReports.some((d) => d.severity === EventSeverity.CRITICAL);

    this.log(
      `enforce() complete for prompt '${promptId}': ${driftReports.length} drift report(s) ` +
        `(${contractViolations.length} CRITICAL), passed=${passed}`
    );

    return { promptId, artifactsScanned, driftReports, contractViolations, passed };
  }

  // -- internals -------------------------------------------------------------

  private loadContracts(projectPath: string, promptId: string, artifactsScanned: string[]): ParsedContract[] {
    const doc = findGovernanceDoc(projectPath, 'BEHAVIORAL_CONTRACTS');
    if (!doc) {
      this.log(
        `WARN: BEHAVIORAL_CONTRACTS.md not found under ${projectPath} — contract-contradiction scan skipped for prompt '${promptId}'`
      );
      return [];
    }
    artifactsScanned.push('BEHAVIORAL_CONTRACTS.md');
    const contracts = parseContracts(doc.content);
    this.log(`parsed ${contracts.length} contract(s) from BEHAVIORAL_CONTRACTS.md for prompt '${promptId}'`);
    return contracts;
  }

  private readModifiedFile(projectPath: string, file: string): string | null {
    const absolutePath = isAbsolute(file) ? file : join(projectPath, file);
    if (!existsSync(absolutePath)) {
      this.log(`WARN: modified file '${file}' does not exist on disk — skipped (deleted since?)`);
      return null;
    }
    try {
      return readFileSync(absolutePath, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`WARN: could not read modified file '${file}': ${message} — skipped`);
      return null;
    }
  }

  /**
   * A prompt that modified anything under `src/` but left both STATE_OF_THE_BUILD.md and
   * SESSION_STATE.md untouched is a documentation-lag WARN, not a contract violation — recorded
   * `autoResolvable: true` since the fix is a routine doc regeneration, not a design decision.
   */
  private checkGovernanceUpdateFreshness(
    projectPath: string,
    promptId: string,
    modifiedFiles: string[],
    artifactsScanned: string[],
    driftReports: DriftReport[]
  ): void {
    const touchedSource = modifiedFiles.some((f) => f.replace(/\\/g, '/').includes('/src/') || f.startsWith('src/'));
    if (!touchedSource) return;

    const modifiedBasenames = new Set(modifiedFiles.map((f) => basename(f)));
    const staleDocs = GOVERNANCE_UPDATE_DOCS.filter((docName) => {
      const existsOnDisk = existsSync(join(projectPath, docName));
      if (existsOnDisk && !artifactsScanned.includes(docName)) artifactsScanned.push(docName);
      return existsOnDisk && !modifiedBasenames.has(docName);
    });

    if (staleDocs.length === 0) return;

    driftReports.push({
      artifact: staleDocs.join(', '),
      contractsCited: [],
      violationsFound: [
        `prompt '${promptId}' modified source file(s) under src/ but did not update ${staleDocs.join(
          ' or '
        )} — CLAUDE.md's Session End Requirements expect a live-codebase-audit update after real work lands`,
      ],
      severity: EventSeverity.WARN,
      autoResolvable: true,
    });

    this.log(`WARN: prompt '${promptId}' touched src/ but left ${staleDocs.join(', ')} unchanged — flagged autoResolvable`);
  }
}

/** Factory for a fresh {@link GovernanceEnforcer} (mirrors the injectable-collaborator house style). */
export function createGovernanceEnforcer(options: GovernanceEnforcerOptions = {}): GovernanceEnforcer {
  return new GovernanceEnforcer(options);
}

export default GovernanceEnforcer;
