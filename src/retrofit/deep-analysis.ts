// FORGE 2.0 — RETROFIT: Deep Analysis Orchestrator
//
// Runs the five deep-analysis detectors — DeadCodeDetector, OrphanedRouteDetector,
// SchemaDriftDetector, DependencyAuditor, CoverageBaseline — against a target project IN
// SEQUENCE, aggregates their findings into one report, computes a weighted health score, and
// renders/writes a markdown report. Read-only against the target project except for the
// report file itself (`<projectPath>/.forge/deep-analysis-*.md`) and each detector's own
// best-effort Build Memory persistence (Contract 4).

import { mkdir, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { DeadCodeDetector, type DeadCodeFinding } from './dead-code-detector.js';
import { OrphanedRouteDetector, type OrphanedRouteFinding } from './orphaned-route-detector.js';
import { SchemaDriftDetector, type SchemaDriftFinding } from './schema-drift-detector.js';
import { DependencyAuditor, type DependencyFinding } from './dependency-auditor.js';
import { CoverageBaseline, type CoverageBaselineFinding } from './coverage-baseline.js';

export interface DeepAnalysisReport {
  projectPath: string;
  generatedAt: string;
  deadCode: DeadCodeFinding[];
  orphanedRoutes: OrphanedRouteFinding[];
  schemaDrift: SchemaDriftFinding[];
  dependencies: DependencyFinding[];
  coverage: CoverageBaselineFinding[];
  healthScore: number;
}

// ---------------------------------------------------------------------------
// Health score — 100 minus a weighted sum of every finding's severity
// ---------------------------------------------------------------------------

const DEAD_CODE_WEIGHT = 0.5;
const ORPHANED_ROUTE_WEIGHT = 1;
const SCHEMA_DRIFT_WEIGHT: Record<SchemaDriftFinding['severity'], number> = { critical: 5, major: 2, minor: 1 };
const DEPENDENCY_WEIGHT: Record<DependencyFinding['findingType'], number> = {
  missing: 3,
  duplicate: 1,
  unused: 1,
  outdated_major: 0.5,
};
const COVERAGE_WEIGHT: Record<CoverageBaselineFinding['priority'], number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

const SOURCE_FILE_RE = /\.(ts|tsx|js|jsx)$/;
const WALK_EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.forge', 'coverage']);

/**
 * Counts source files under `<projectPath>/src` (or the project root, if there's no `src` dir)
 * so {@link computeHealthScore} can normalize raw finding counts by codebase size — a codebase
 * with 10x the files should not be penalized 10x as hard for the same finding *density*.
 */
function countSourceFiles(projectPath: string): number {
  const root = join(projectPath, 'src');
  let count = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!WALK_EXCLUDE_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (SOURCE_FILE_RE.test(entry.name)) {
        count++;
      }
    }
  };
  walk(root);
  return count;
}

/**
 * 100 minus every finding's weighted severity, NORMALIZED by codebase size (findings-per-100-
 * source-files, not a raw count) so the score reflects finding *density* rather than sheer
 * codebase size — without normalization, any codebase past a few hundred files guarantees a
 * floor-of-0 score regardless of whether it's actually healthy (Finding B-5). The floor is
 * extended to -50 (rather than clamping at 0) so a codebase whose normalized deduction still
 * exceeds 100 can be told apart from one that barely does — "0" stopped being a single
 * indistinguishable bucket for "bad" and "catastrophic."
 */
function computeHealthScore(
  projectPath: string,
  input: {
    deadCode: DeadCodeFinding[];
    orphanedRoutes: OrphanedRouteFinding[];
    schemaDrift: SchemaDriftFinding[];
    dependencies: DependencyFinding[];
    coverage: CoverageBaselineFinding[];
  },
): number {
  let deductions = 0;
  deductions += input.deadCode.length * DEAD_CODE_WEIGHT;
  deductions += input.orphanedRoutes.length * ORPHANED_ROUTE_WEIGHT;
  for (const f of input.schemaDrift) deductions += SCHEMA_DRIFT_WEIGHT[f.severity];
  for (const f of input.dependencies) deductions += DEPENDENCY_WEIGHT[f.findingType];
  for (const f of input.coverage) deductions += COVERAGE_WEIGHT[f.priority];

  const fileCount = Math.max(1, countSourceFiles(projectPath));
  const normalizedDeductions = (deductions / fileCount) * 100;
  return Math.max(-50, Math.min(100, Math.round((100 - normalizedDeductions) * 100) / 100));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Runs all five deep-analysis detectors against `projectPath` IN SEQUENCE — each is a
 * synchronous, fs-heavy scan, and sequencing keeps console output (and every detector's own
 * best-effort Build Memory writes) ordered and easy to follow — and aggregates their findings
 * into one {@link DeepAnalysisReport}.
 */
export async function runDeepAnalysis(projectPath: string): Promise<DeepAnalysisReport> {
  const deadCode = await new DeadCodeDetector().detect(projectPath);
  const orphanedRoutes = await new OrphanedRouteDetector().detect(projectPath);
  const schemaDrift = await new SchemaDriftDetector().detect(projectPath);
  const dependencies = await new DependencyAuditor().audit(projectPath);
  const coverage = await new CoverageBaseline().analyze(projectPath);

  const healthScore = computeHealthScore(projectPath, { deadCode, orphanedRoutes, schemaDrift, dependencies, coverage });

  return {
    projectPath,
    generatedAt: new Date().toISOString(),
    deadCode,
    orphanedRoutes,
    schemaDrift,
    dependencies,
    coverage,
    healthScore,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function topN<T>(items: readonly T[], n = 10): T[] {
  return items.slice(0, n);
}

/**
 * Full markdown report: per-category totals, the top 10 most critical findings in each
 * category (each detector already returns its findings pre-sorted by severity/priority), and
 * the overall health score.
 */
export function renderDeepAnalysisMarkdown(report: DeepAnalysisReport): string {
  const coverageGaps = report.coverage.filter((f) => f.priority !== 'low').length;
  const lines: string[] = [];

  lines.push('# FORGE 2.0 — Deep Analysis Report');
  lines.push('');
  lines.push(`**Project:** ${report.projectPath}`);
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**Overall health score:** ${report.healthScore}/100`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Category | Findings |');
  lines.push('|----------|----------|');
  lines.push(`| Dead code | ${report.deadCode.length} |`);
  lines.push(`| Orphaned routes | ${report.orphanedRoutes.length} |`);
  lines.push(`| Schema drift | ${report.schemaDrift.length} |`);
  lines.push(`| Dependency issues | ${report.dependencies.length} |`);
  lines.push(`| Coverage gaps (non-low priority) | ${coverageGaps} |`);
  lines.push('');

  lines.push('## Dead Code — top 10');
  lines.push('');
  if (report.deadCode.length === 0) lines.push('None found.');
  for (const f of topN(report.deadCode)) lines.push(`- \`${f.filePath}:${f.lineNumber}\` — ${f.reason}`);
  lines.push('');

  lines.push('## Orphaned Routes — top 10');
  lines.push('');
  if (report.orphanedRoutes.length === 0) lines.push('None found.');
  for (const f of topN(report.orphanedRoutes)) lines.push(`- \`${f.routePath}\` (${f.filePath}) — ${f.reason}`);
  lines.push('');

  lines.push('## Schema Drift — top 10');
  lines.push('');
  if (report.schemaDrift.length === 0) lines.push('None found.');
  for (const f of topN(report.schemaDrift)) lines.push(`- [${f.severity}] \`${f.tableName}\` — ${f.detail}`);
  lines.push('');

  lines.push('## Dependency Issues — top 10');
  lines.push('');
  if (report.dependencies.length === 0) lines.push('None found.');
  for (const f of topN(report.dependencies)) lines.push(`- [${f.findingType}] \`${f.packageName}\` — ${f.detail}`);
  lines.push('');

  lines.push('## Coverage Baseline — top 10 (highest priority first)');
  lines.push('');
  if (report.coverage.length === 0) lines.push('None found.');
  for (const f of topN(report.coverage)) {
    const testNote = f.hasTestFile ? '' : ' — NO TEST FILE';
    lines.push(`- [${f.priority}] \`${f.filePath}\` — ${f.coveragePercent}% (${f.coveredSymbols}/${f.exportedSymbols} symbols)${testNote}`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * A short, prompt-context-sized digest (category totals + health score + the single most
 * critical schema-drift/dependency finding) — deliberately NOT the full report, so injecting
 * this into every generated queue.yaml prompt (see `reconcile.ts`'s `generateRetrofitQueue`)
 * never bloats prompt size. `reportPath`, when supplied, points the agent at the full findings.
 */
export function renderDeepAnalysisContextBlock(report: DeepAnalysisReport, reportPath?: string): string {
  const coverageGaps = report.coverage.filter((f) => f.priority !== 'low').length;
  const lines: string[] = [];
  lines.push('--- FORGE deep analysis findings (context — not a task list) ---');
  lines.push(`Health score: ${report.healthScore}/100`);
  lines.push(`Dead code: ${report.deadCode.length} finding(s)`);
  lines.push(`Orphaned routes: ${report.orphanedRoutes.length} finding(s)`);
  lines.push(`Schema drift: ${report.schemaDrift.length} finding(s)`);
  lines.push(`Dependency issues: ${report.dependencies.length} finding(s)`);
  lines.push(`Coverage gaps: ${coverageGaps} file(s) needing tests`);
  const topSchemaDrift = report.schemaDrift[0];
  if (topSchemaDrift) lines.push(`  most critical schema drift: ${topSchemaDrift.detail}`);
  const topDependencyIssue = report.dependencies[0];
  if (topDependencyIssue) lines.push(`  most critical dependency issue: ${topDependencyIssue.detail}`);
  if (reportPath) lines.push(`Full findings: ${reportPath}`);
  lines.push('--- end deep analysis findings ---');
  return lines.join('\n');
}

/** Writes the full markdown report to `<projectPath>/.forge/deep-analysis-{timestamp}.md`. */
export async function writeDeepAnalysisReport(report: DeepAnalysisReport): Promise<string> {
  const dir = join(report.projectPath, '.forge');
  await mkdir(dir, { recursive: true });
  const safeStamp = report.generatedAt.replace(/[:.]/g, '-');
  const filePath = join(dir, `deep-analysis-${safeStamp}.md`);
  await writeFile(filePath, renderDeepAnalysisMarkdown(report), 'utf8');
  return filePath;
}
