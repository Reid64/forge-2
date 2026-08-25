/**
 * FORGE 2.0 — Architecture Guardian — post-output validator.
 *
 * `EnterpriseEnforcer` (`enforcer.ts`) works BEFORE claude runs — it enhances an about-to-be-
 * assembled prompt with explicit instruction text so the model has no ambiguity about what
 * "enterprise-grade" means for a given build target. `PostOutputValidator` is the other half of
 * that story: it runs AFTER claude has produced output, scanning the actual files a prompt
 * modified for the failure modes the pre-prompt enforcement was trying to prevent in the first
 * place — an implementation too thin to be real, stub/placeholder markers left in place, hardcoded
 * mock data standing in for a real data source, a swallowed error, or a `console.log` bypassing a
 * structured logger.
 *
 * Design posture: unlike `EnterpriseEnforcer.enforce` (which never blocks — `approved` is always
 * `true`, per Contract 4/SP-5's "never auto-approved, never silently overridden in the blocking
 * direction, but also never itself the halt mechanism"), `PostOutputValidator.validate` DOES
 * compute a real `passed` verdict. By this point in the pipeline there is no more "rewrite the
 * prompt and try again before it runs" option — the code already exists on disk. `passed` here is
 * a diagnostic signal for the caller (Sentinel, Sentinel Prime, Build Brain, or a human) to act on;
 * this module does not itself halt a build. It mirrors `AccessibilityChecker`'s static-scan
 * posture (`src/ui-engine/accessibility-checker.ts`) and `DeadCodeDetector`'s regex-based,
 * read-only approach (`src/retrofit/dead-code-detector.ts`) — no AST parsing, a source-text scan
 * over the files a prompt actually touched, never a project-wide sweep.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { PromptClassification } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One concrete defect found in one modified file. */
export interface OutputViolation {
  filePath: string;
  violationType: string;
  description: string;
  severity: 'critical' | 'major' | 'minor';
  autoFixable: boolean;
}

/** The full result of validating every file a Phase 3 prompt modified. */
export interface OutputValidation {
  passed: boolean;
  filesChecked: string[];
  violations: OutputViolation[];
  qualityScore: number;
  recommendation: string;
}

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

/** Below this many non-blank, non-comment lines, a file is considered too thin to be real. */
const MINIMUM_REAL_LINES = 80;

const CRITICAL_PENALTY = 20;
const MAJOR_PENALTY = 10;
const MINOR_PENALTY = 3;

/** `passed` requires a quality score strictly above this floor, AND zero critical violations. */
const PASS_SCORE_FLOOR = 60;

const TS_FILE_RE = /\.tsx?$/;
const DECLARATION_FILE_RE = /\.d\.ts$/;

// ---------------------------------------------------------------------------
// Violation type labels
// ---------------------------------------------------------------------------

const VIOLATION_TYPE = {
  THIN_IMPLEMENTATION: 'THIN_IMPLEMENTATION',
  STUB_OR_PLACEHOLDER: 'STUB_OR_PLACEHOLDER',
  MOCK_DATA_IN_PRODUCTION: 'MOCK_DATA_IN_PRODUCTION',
  SWALLOWED_ERROR: 'SWALLOWED_ERROR',
  IMPROPER_LOGGING: 'IMPROPER_LOGGING',
} as const;

// ---------------------------------------------------------------------------
// Line-level helpers
// ---------------------------------------------------------------------------

/**
 * Counts non-blank, non-comment lines in `content` — a cheap proxy for "real implementation
 * size" (the same proxy `CoverageBaseline`/`EnterpriseEnforcer`'s `MINIMUM_IMPLEMENTATION_LINES`
 * standard already use). Tracks a small block-comment state machine so a `/** ... *\/` doc block
 * spanning many lines is not miscounted as real code.
 */
function countRealLines(content: string): number {
  const lines = content.split(/\r?\n/);
  let count = 0;
  let inBlockComment = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (inBlockComment) {
      const closeIndex = line.indexOf('*/');
      if (closeIndex === -1) continue;
      inBlockComment = false;
      const after = line.slice(closeIndex + 2).trim();
      if (after !== '' && !after.startsWith('//')) count += 1;
      continue;
    }

    if (line.startsWith('//')) continue;
    if (line.startsWith('*')) continue; // JSDoc continuation line

    if (line.startsWith('/*')) {
      const closeIndex = line.indexOf('*/');
      if (closeIndex === -1) {
        inBlockComment = true;
      } else {
        const after = line.slice(closeIndex + 2).trim();
        if (after !== '' && !after.startsWith('//')) count += 1;
      }
      continue;
    }

    count += 1;
  }

  return count;
}

/** Resolves the 1-based line number a character offset falls on, for multi-line regex matches. */
function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Check 1 — THIN_IMPLEMENTATION
// ---------------------------------------------------------------------------

function checkThinImplementation(filePath: string, content: string): OutputViolation[] {
  // Test files are intentionally focused and concise; skip this check
  if (filePath.includes('.test.ts') || filePath.includes('.spec.ts')) return [];
  const realLines = countRealLines(content);
  if (realLines >= MINIMUM_REAL_LINES) return [];

  return [
    {
      filePath,
      violationType: VIOLATION_TYPE.THIN_IMPLEMENTATION,
      description: `File has only ${realLines} non-blank, non-comment line(s) — below the ${MINIMUM_REAL_LINES}-line floor for a real implementation. A file this thin is a wrapper or a stub, not a complete build.`,
      severity: 'critical',
      autoFixable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Check 2 — STUB_OR_PLACEHOLDER
// ---------------------------------------------------------------------------

interface StubMarker {
  test: (line: string) => boolean;
  label: string;
}

/** Wraps a plain regex into a `StubMarker.test` — the common case where no context-awareness is needed. */
function regexMarker(regex: RegExp, label: string): StubMarker {
  return { test: (line) => regex.test(line), label };
}

/**
 * The bare word "placeholder" is also legitimate, non-stub web platform syntax: the CSS
 * `::placeholder` pseudo-element (e.g. `input::placeholder { color: #999; }`) and the HTML/JSX
 * `placeholder="..."` / `placeholder={...}` attribute on form inputs. Neither signals unfinished
 * work. This strips both known-legitimate forms out of the line first, then checks whether the
 * word "placeholder" still appears — i.e. it was used as English prose about incomplete work
 * ("// placeholder for actual implementation", "TODO: replace this placeholder"), not as CSS
 * selector syntax or an HTML attribute name.
 */
function hasStubPlaceholderMention(line: string): boolean {
  if (!/\bplaceholder\b/i.test(line)) return false;
  const stripped = line
    .replace(/::placeholder\b/gi, '')
    .replace(/\bplaceholder\s*=\s*("[^"]*"|'[^']*'|\{[^}]*\})?/gi, '');
  return /\bplaceholder\b/i.test(stripped);
}

/**
 * Every marker that signals unfinished or placeholder work left in an otherwise-completed file.
 * `: any` and `as any` are included per the same "no stub/placeholder" spirit as `TODO`/`FIXME` —
 * an `any`-typed escape hatch is a placeholder for real typing, not a finished implementation.
 */
const STUB_MARKERS: StubMarker[] = [
  regexMarker(/\bTODO\b/, 'TODO marker'),
  regexMarker(/\bFIXME\b/, 'FIXME marker'),
  regexMarker(/\bHACK\b/, 'HACK marker'),
  { test: hasStubPlaceholderMention, label: 'placeholder marker' },
  regexMarker(/\bstub\b/i, 'stub marker'),
  regexMarker(/:\s*any\b/, 'any-type annotation'),
  regexMarker(/\bas\s+any\b/, 'as any cast'),
];

function checkStubMarkers(filePath: string, content: string): OutputViolation[] {
  const violations: OutputViolation[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    const lineNumber = i + 1;

    for (const marker of STUB_MARKERS) {
      if (!marker.test(rawLine)) continue;
      violations.push({
        filePath,
        violationType: VIOLATION_TYPE.STUB_OR_PLACEHOLDER,
        description: `Line ${lineNumber}: ${marker.label} found — "${rawLine.trim().slice(0, 120)}". Every function must be a complete, working implementation with zero placeholders.`,
        severity: 'critical',
        autoFixable: false,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Check 3 — MOCK_DATA_IN_PRODUCTION
// ---------------------------------------------------------------------------

/**
 * Matches a `const`/`let` declaration whose name signals fake/sample data assigned directly to an
 * array literal — e.g. `const mockUsers = [{ ... }]`, `let sampleOrders: Order[] = [...]`. Real
 * fixture files under `tests/`/`__mocks__` are exempt (`isExemptFixturePath`), matching the same
 * exemption `ENTERPRISE_STANDARDS`'s `NO_MOCK_DATA` standard already documents.
 */
const MOCK_DATA_RE = /\b(const|let)\s+\w*(mock|fake|dummy|sample)\w*\s*(?::[^=]+)?=\s*\[/i;

function isExemptFixturePath(filePath: string): boolean {
  return /[/\\](tests|__mocks__|__fixtures__)[/\\]/i.test(filePath) || /\.(test|spec)\.tsx?$/i.test(filePath);
}

function checkMockData(filePath: string, content: string): OutputViolation[] {
  if (isExemptFixturePath(filePath)) return [];

  const violations: OutputViolation[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    if (!MOCK_DATA_RE.test(rawLine)) continue;

    violations.push({
      filePath,
      violationType: VIOLATION_TYPE.MOCK_DATA_IN_PRODUCTION,
      description: `Line ${i + 1}: hardcoded mock/fake/sample data array assigned in production code — "${rawLine.trim().slice(0, 120)}". Every data source must be a real API call or database query.`,
      severity: 'critical',
      autoFixable: false,
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Check 4 — SWALLOWED_ERROR
// ---------------------------------------------------------------------------

/** Matches `catch {}` and `catch (e) {}` (any whitespace/newlines inside the braces, no body). */
const EMPTY_CATCH_RE = /catch\s*(\([^)]*\))?\s*\{\s*\}/g;

function checkSwallowedErrors(filePath: string, content: string): OutputViolation[] {
  const violations: OutputViolation[] = [];

  for (const match of content.matchAll(EMPTY_CATCH_RE)) {
    const lineNumber = lineNumberAt(content, match.index ?? 0);
    violations.push({
      filePath,
      violationType: VIOLATION_TYPE.SWALLOWED_ERROR,
      description: `Line ${lineNumber}: empty catch block with no body — the caught error is silently discarded. Every catch block must log, rethrow, or otherwise handle the error.`,
      severity: 'major',
      autoFixable: true,
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Check 5 — IMPROPER_LOGGING
// ---------------------------------------------------------------------------

const CONSOLE_LOG_RE = /console\.log\(/g;

/** A file whose own path names it a logger implementation is exempt — it IS "the logger." */
function isLoggerFile(filePath: string): boolean {
  return /logger/i.test(filePath);
}

function checkImproperLogging(filePath: string, content: string): OutputViolation[] {
  if (isLoggerFile(filePath)) return [];

  const violations: OutputViolation[] = [];

  for (const match of content.matchAll(CONSOLE_LOG_RE)) {
    const lineNumber = lineNumberAt(content, match.index ?? 0);
    violations.push({
      filePath,
      violationType: VIOLATION_TYPE.IMPROPER_LOGGING,
      description: `Line ${lineNumber}: console.log() call in production code, outside a logger module. Use the project's structured logger instead of writing directly to console.`,
      severity: 'minor',
      autoFixable: true,
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Scoring + recommendation
// ---------------------------------------------------------------------------

function countBySeverity(violations: OutputViolation[], severity: OutputViolation['severity']): number {
  return violations.filter((violation) => violation.severity === severity).length;
}

/** Quality score = 100 − (critical × 20) − (major × 10) − (minor × 3), clamped to [0, 100]. */
function computeQualityScore(violations: OutputViolation[]): number {
  const critical = countBySeverity(violations, 'critical');
  const major = countBySeverity(violations, 'major');
  const minor = countBySeverity(violations, 'minor');

  const raw = 100 - critical * CRITICAL_PENALTY - major * MAJOR_PENALTY - minor * MINOR_PENALTY;
  return Math.max(0, Math.min(100, raw));
}

function buildRecommendation(
  filesChecked: string[],
  violations: OutputViolation[],
  qualityScore: number,
  passed: boolean,
  classification: PromptClassification
): string {
  const target = `${classification.buildTarget || 'unknown build target'} (${classification.promptType || 'unknown prompt type'})`;

  if (filesChecked.length === 0) {
    return `No TypeScript files were available to check for this ${target} prompt — nothing was validated.`;
  }

  if (violations.length === 0) {
    return `All ${filesChecked.length} checked file(s) for this ${target} prompt passed with a quality score of ${qualityScore}/100 — no further action needed.`;
  }

  const critical = countBySeverity(violations, 'critical');
  const major = countBySeverity(violations, 'major');
  const minor = countBySeverity(violations, 'minor');
  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} critical`);
  if (major > 0) parts.push(`${major} major`);
  if (minor > 0) parts.push(`${minor} minor`);
  const summary = parts.join(', ');

  if (!passed) {
    const reason =
      critical > 0
        ? `${critical} critical violation(s) must be fixed before this ${target} output is production-ready`
        : `the quality score (${qualityScore}/100) is at or below the ${PASS_SCORE_FLOOR} pass floor`;
    return `FAILED — ${summary} violation(s) found across ${filesChecked.length} file(s). ${reason}.`;
  }

  return `PASSED with warnings — ${summary} violation(s) found across ${filesChecked.length} file(s), quality score ${qualityScore}/100. Address the remaining major/minor items when convenient.`;
}

// ---------------------------------------------------------------------------
// PostOutputValidator
// ---------------------------------------------------------------------------

/**
 * Validates every modified TypeScript file from a completed Phase 3 prompt against the five
 * post-output checks above. Never throws: a missing or unreadable file is skipped (never counted
 * in `filesChecked`, never a fatal error) rather than failing the whole validation run — the same
 * "degrade, never halt" posture `EnterpriseEnforcer` and Contract 4 already establish elsewhere in
 * Architecture Guardian.
 */
export class PostOutputValidator {
  /**
   * `classification` is accepted (not required for the mechanical scans themselves) so the
   * resulting `recommendation` can name the build target/prompt type this output was supposed to
   * satisfy — the same classification `EnterpriseEnforcer.enforce` used before the prompt ran.
   */
  async validate(
    projectPath: string,
    modifiedFiles: string[],
    classification: PromptClassification
  ): Promise<OutputValidation> {
    const filesChecked: string[] = [];
    const violations: OutputViolation[] = [];

    for (const rawPath of modifiedFiles) {
      if (!TS_FILE_RE.test(rawPath) || DECLARATION_FILE_RE.test(rawPath)) continue;

      const resolvedPath = isAbsolute(rawPath) ? rawPath : join(projectPath, rawPath);
      let content: string;
      try {
        content = readFileSync(resolvedPath, 'utf8');
      } catch {
        continue; // missing/unreadable file — skip silently, never throw
      }

      filesChecked.push(rawPath);
      violations.push(
        ...checkThinImplementation(rawPath, content),
        ...checkStubMarkers(rawPath, content),
        ...checkMockData(rawPath, content),
        ...checkSwallowedErrors(rawPath, content),
        ...checkImproperLogging(rawPath, content)
      );
    }

    const qualityScore = computeQualityScore(violations);
    const criticalCount = countBySeverity(violations, 'critical');
    const passed = qualityScore > PASS_SCORE_FLOOR && criticalCount === 0;
    const recommendation = buildRecommendation(filesChecked, violations, qualityScore, passed, classification);

    return {
      passed,
      filesChecked,
      violations,
      qualityScore,
      recommendation,
    };
  }
}

/** Factory matching the house style of `createEnterpriseEnforcer`/`createSentinelPrime`/etc. */
export function createPostOutputValidator(): PostOutputValidator {
  return new PostOutputValidator();
}

export default PostOutputValidator;

