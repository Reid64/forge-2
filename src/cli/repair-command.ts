/**
 * FORGE 2.0 — Repair Mode (forge repair <path>).
 *
 * Standalone operating mode for repairing broken TypeScript repositories.
 * Steps:
 *   SCAN       — catalog the codebase via codebase-reader
 *   DIAGNOSE   — run pnpm tsc --noEmit, capture all errors
 *   CLASSIFY   — group errors by type (missing_module, missing_import, type_mismatch, …)
 *   PRIORITIZE — sort clusters: types/interfaces first, then implementations, then UI
 *   GENERATE   — write repair-queue.yaml with one prompt per error cluster
 *   EXECUTE    — run the queue through Phase 3 (same loop as a normal build)
 *   VERIFY     — re-run compile + build gates; log remaining errors to error_patterns
 *
 * Non-throwing: every collaborator is guarded; `runRepairMode` always resolves.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

import { dump as dumpYaml } from 'js-yaml';

import { readCodebase, type CodebaseSnapshot } from '../tools/codebase-reader.js';
import { runPhase3Executor } from '../phases/phase3-executor.js';
import { getClient } from '../memory/index.js';
import { recordError } from '../memory/errors.js';
import { getLogger } from '../tools/forge-logger.js';
import type {
  ErrorCategory,
  RepairCluster,
  RepairConfig,
  RepairErrorCategory,
  RepairExecutionSummary,
  RepairGateResult,
  RepairResult,
  TscError,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FORGE_REPAIR_PREAMBLE = `FORGE REPAIR MODE — TypeScript Strict Rules (enforced — follow exactly):
1. TypeScript strict mode: ALL variables that could be undefined MUST use optional chaining (?.) or nullish coalescing (?? defaultValue). NEVER pass a possibly-undefined value where a concrete type is expected.
2. Unused variables: prefix with underscore (_req, _input) or remove entirely. ESLint will fail on unused variables.
3. Empty interfaces: use 'object' or 'unknown' instead of empty interface declarations.
4. If you create a new agent type, add it to the AgentType union in src/types/database.ts BEFORE using it in any agent file.
5. Always add alt="" to img elements.
6. After writing code, mentally check: does every .property access handle the case where the parent could be null/undefined?
7. Do NOT leave any console.log statements in production code.
8. When using Badge component, check BadgeProps interface for valid props — do not pass unsupported variant or size props.`;

const DEFAULT_MAX_CLUSTERS = 20;
const GATE_TIMEOUT_MS = 120_000;

// TS error code sets → repair categories
const MISSING_MODULE_CODES = new Set(['TS2307', 'TS7016', 'TS2792']);
const MISSING_IMPORT_CODES = new Set(['TS2304', 'TS2305', 'TS2306', 'TS2664', 'TS2724']);
const TYPE_MISMATCH_CODES = new Set([
  'TS2322', 'TS2345', 'TS2339', 'TS2344', 'TS2349', 'TS2352',
  'TS2353', 'TS2365', 'TS2367', 'TS2376', 'TS2741',
]);
const UNDEFINED_VAR_CODES = new Set(['TS2532', 'TS2533', 'TS18047', 'TS18048', 'TS2454', 'TS2722']);
const ENUM_MISMATCH_CODES = new Set(['TS2551', 'TS2361', 'TS2364', 'TS2542']);

const CATEGORY_PRIORITY: Record<RepairErrorCategory, number> = {
  missing_module: 0,
  missing_import: 1,
  type_mismatch: 2,
  undefined_var: 3,
  enum_mismatch: 4,
  other: 5,
};

const CATEGORY_TO_ERROR_CATEGORY: Record<RepairErrorCategory, ErrorCategory> = {
  missing_module: 'dependency',
  missing_import: 'dependency',
  type_mismatch: 'type_error',
  undefined_var: 'type_error',
  enum_mismatch: 'type_error',
  other: 'type_error',
};

// ---------------------------------------------------------------------------
// TSC output parsing
// ---------------------------------------------------------------------------

const TSC_ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;

function classifyTscCode(code: string): RepairErrorCategory {
  if (MISSING_MODULE_CODES.has(code)) return 'missing_module';
  if (MISSING_IMPORT_CODES.has(code)) return 'missing_import';
  if (TYPE_MISMATCH_CODES.has(code)) return 'type_mismatch';
  if (UNDEFINED_VAR_CODES.has(code)) return 'undefined_var';
  if (ENUM_MISMATCH_CODES.has(code)) return 'enum_mismatch';
  return 'other';
}

function parseTscOutput(output: string, projectPath: string): TscError[] {
  const errors: TscError[] = [];
  for (const line of output.split('\n')) {
    const m = TSC_ERROR_LINE.exec(line.trim());
    if (!m) continue;
    const [, rawPath, lineStr, colStr, code, message] = m;
    if (!rawPath || !lineStr || !colStr || !code || !message) continue;

    // Normalize to project-relative forward-slash path
    const absPath = rawPath.trim();
    const rel = relative(projectPath, absPath).replace(/\\/g, '/');
    const filePath = rel.startsWith('..') ? absPath.replace(/\\/g, '/') : rel;

    errors.push({
      filePath,
      line: parseInt(lineStr, 10),
      col: parseInt(colStr, 10),
      code,
      message: message.trim(),
      category: classifyTscCode(code),
    });
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Clustering + prioritization
// ---------------------------------------------------------------------------

function moduleGroupOf(filePath: string): string {
  return dirname(filePath) || '.';
}

function isTypesFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.includes('/types/') || lower.endsWith('.types.ts') || lower.endsWith('.d.ts');
}

function isUiFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes('/components/') ||
    lower.includes('/app/') ||
    lower.endsWith('.tsx') ||
    lower.endsWith('.jsx')
  );
}

function clusterErrors(
  errors: TscError[],
  maxClusters: number
): { clusters: RepairCluster[]; warnings: string[] } {
  const warnings: string[] = [];
  // Bucket key: `${category}::${moduleGroup}`
  const buckets = new Map<string, TscError[]>();

  for (const err of errors) {
    const group = moduleGroupOf(err.filePath);
    const key = `${err.category}::${group}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.push(err);
    } else {
      buckets.set(key, [err]);
    }
  }

  const clusters: RepairCluster[] = [];
  let idx = 0;

  for (const [key, clusterErrors] of buckets) {
    const sepIdx = key.indexOf('::');
    if (sepIdx === -1) continue;
    const category = key.slice(0, sepIdx) as RepairErrorCategory;
    const group = key.slice(sepIdx + 2);

    const files = [...new Set(clusterErrors.map((e) => e.filePath))];
    const hasTypes = files.some(isTypesFile);
    const hasUi = files.some(isUiFile);
    const subPriority = hasTypes ? -0.5 : hasUi ? 0.5 : 0;

    clusters.push({
      id: `repair-${String(idx++).padStart(3, '0')}`,
      name: `Fix ${category.replace(/_/g, ' ')} in ${group}`,
      category,
      files,
      errors: clusterErrors,
      priority: CATEGORY_PRIORITY[category] + subPriority,
    });
  }

  // Sort by priority (lower = fix first)
  clusters.sort((a, b) => a.priority - b.priority);

  // Re-assign stable ids after sort
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    if (cluster) cluster.id = `repair-${String(i).padStart(3, '0')}`;
  }

  if (clusters.length > maxClusters) {
    warnings.push(
      `${clusters.length} repair clusters generated; capping at ${maxClusters} ` +
        `(${clusters.length - maxClusters} dropped — run with --max-clusters to increase).`
    );
    clusters.splice(maxClusters);
  }

  return { clusters, warnings };
}

// ---------------------------------------------------------------------------
// Repair prompt generation
// ---------------------------------------------------------------------------

function buildRepairPromptDescription(cluster: RepairCluster, _snapshot: CodebaseSnapshot): string {
  const MAX_ERRORS_IN_PROMPT = 30;
  const errorLines = cluster.errors
    .slice(0, MAX_ERRORS_IN_PROMPT)
    .map((e) => `  ${e.filePath}(${e.line},${e.col}): ${e.code} — ${e.message}`)
    .join('\n');
  const overflow =
    cluster.errors.length > MAX_ERRORS_IN_PROMPT
      ? `\n  … and ${cluster.errors.length - MAX_ERRORS_IN_PROMPT} more error(s) in the same cluster.`
      : '';

  return [
    FORGE_REPAIR_PREAMBLE,
    '',
    `REPAIR TASK: Fix all TypeScript "${cluster.category.replace(/_/g, ' ')}" errors`,
    `in file(s): ${cluster.files.join(', ')}`,
    '',
    'ERRORS TO FIX:',
    errorLines + overflow,
    '',
    'INSTRUCTIONS:',
    '1. Fix ALL errors listed above. Do not skip any.',
    '2. Do not introduce new TypeScript errors while fixing these.',
    '3. Do not change business logic — fix type errors only.',
    '4. If a fix requires a new import, add it at the top of the file.',
    '5. If a type is genuinely unknown, use `unknown` not `any`.',
    '6. Verify your fix by mentally running `pnpm tsc --noEmit` before writing.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Queue YAML generation
// ---------------------------------------------------------------------------

function buildQueueEntry(
  cluster: RepairCluster,
  snapshot: CodebaseSnapshot,
  dependencies: string[]
): object {
  return {
    id: cluster.id,
    name: cluster.name,
    prompt_type: 'feature',
    dependencies,
    governance_refs: [],
    estimated_tokens: Math.max(2000, cluster.errors.length * 150 + 1500),
    context_injection: {
      schemaSections: [],
      behavioralSections: [],
      interactionMaps: [],
    },
    description: buildRepairPromptDescription(cluster, snapshot),
  };
}

async function writeRepairQueue(
  clusters: RepairCluster[],
  snapshot: CodebaseSnapshot,
  queuePath: string
): Promise<void> {
  // Each cluster depends on the preceding one — enforces types → impls → UI order.
  const entries = clusters.map((cluster, i) => {
    const prevId = i > 0 ? (clusters[i - 1]?.id ?? '') : '';
    const dependencies = prevId ? [prevId] : [];
    return buildQueueEntry(cluster, snapshot, dependencies);
  });

  const yaml = dumpYaml(entries, { lineWidth: 120 });
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(queuePath, yaml, 'utf8');
}

// ---------------------------------------------------------------------------
// Gate verification
// ---------------------------------------------------------------------------

function runGate(gate: 'compile' | 'build', projectPath: string): RepairGateResult {
  const args = gate === 'compile' ? ['tsc', '--noEmit'] : ['run', 'build'];

  const result = spawnSync('pnpm', args, {
    cwd: projectPath,
    encoding: 'utf8',
    shell: true,
    timeout: GATE_TIMEOUT_MS,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const output = [stdout, stderr].filter(Boolean).join('\n');
  const passed = (result.status ?? 1) === 0;
  const errorCount =
    gate === 'compile' ? parseTscOutput(output, projectPath).length : passed ? 0 : 1;

  return { gate, passed, output, errorCount };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runRepairMode(
  projectPath: string,
  config: RepairConfig
): Promise<RepairResult> {
  const log = config.log ?? ((msg: string) => getLogger('repair').info(msg));
  const maxClusters = config.maxClusters ?? DEFAULT_MAX_CLUSTERS;
  const executeRepairs = config.executeRepairs ?? true;
  const queuePath = config.repairQueuePath ?? join(projectPath, 'repair-queue.yaml');
  const warnings: string[] = [];
  const now = new Date().toISOString();

  // ---------------------------------------------------------------------------
  // SCAN: catalog the codebase so repair prompts can reference existing symbols
  // ---------------------------------------------------------------------------
  log('SCAN: cataloging codebase…');
  const snapshot = await readCodebase(projectPath);
  log(`  found ${snapshot.stats.totalFiles} file(s), ${snapshot.components.length} top-level symbol(s).`);

  // ---------------------------------------------------------------------------
  // DIAGNOSE: run pnpm tsc --noEmit, capture all errors
  // ---------------------------------------------------------------------------
  log('DIAGNOSE: running pnpm tsc --noEmit…');
  const diagResult = spawnSync('pnpm', ['tsc', '--noEmit'], {
    cwd: projectPath,
    encoding: 'utf8',
    shell: true,
    timeout: GATE_TIMEOUT_MS,
  });
  const diagOutput = [diagResult.stdout ?? '', diagResult.stderr ?? ''].filter(Boolean).join('\n');
  const errors = parseTscOutput(diagOutput, projectPath);
  log(`  found ${errors.length} TypeScript error(s).`);

  if (errors.length === 0) {
    log('No TypeScript errors — nothing to repair.');
    return {
      projectPath,
      status: 'no_errors',
      errorsFound: 0,
      errorsAfterRepair: 0,
      clusters: [],
      repairQueuePath: null,
      executionResult: null,
      gateResults: [],
      warnings,
      generatedAt: now,
    };
  }

  // ---------------------------------------------------------------------------
  // CLASSIFY + PRIORITIZE
  // ---------------------------------------------------------------------------
  log('CLASSIFY: grouping errors by type and module…');
  const { clusters, warnings: clusterWarnings } = clusterErrors(errors, maxClusters);
  warnings.push(...clusterWarnings);

  const categoryCounts = errors.reduce<Record<string, number>>((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + 1;
    return acc;
  }, {});
  for (const [cat, count] of Object.entries(categoryCounts)) {
    log(`  ${cat}: ${count} error(s)`);
  }
  log(`PRIORITIZE: ${clusters.length} repair cluster(s) sorted by dependency order.`);

  // ---------------------------------------------------------------------------
  // GENERATE QUEUE
  // ---------------------------------------------------------------------------
  log(`GENERATE QUEUE: writing ${clusters.length} cluster(s) to ${queuePath}…`);
  try {
    await writeRepairQueue(clusters, snapshot, queuePath);
    log(`  queue written.`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warnings.push(`Failed to write repair queue: ${detail}`);
    return {
      projectPath,
      status: 'failed',
      errorsFound: errors.length,
      errorsAfterRepair: errors.length,
      clusters,
      repairQueuePath: null,
      executionResult: null,
      gateResults: [],
      warnings,
      generatedAt: now,
    };
  }

  // ---------------------------------------------------------------------------
  // EXECUTE: run through Phase 3
  // ---------------------------------------------------------------------------
  let executionResult: RepairExecutionSummary | null = null;

  if (executeRepairs) {
    log('EXECUTE: running repair queue through Phase 3…');
    const exec = await runPhase3Executor({
      projectPath,
      queuePath,
      autonomousRecoveryMode: config.autonomousRecovery ?? false,
      log,
    });
    executionResult = {
      buildRunId: exec.buildRunId,
      status: exec.status,
      completedPrompts: exec.completedPrompts,
      failedPrompts: exec.failedPrompts,
      skippedPrompts: exec.skippedPrompts,
      haltReason: exec.haltReason,
      warnings: exec.warnings,
    };
    for (const w of exec.warnings) warnings.push(`[executor] ${w}`);
    log(`  execution ${exec.status}: ${exec.completedPrompts} done, ${exec.failedPrompts} failed.`);
  } else {
    log('EXECUTE: skipped (executeRepairs=false).');
  }

  // ---------------------------------------------------------------------------
  // VERIFY: re-run compile + build gates
  // ---------------------------------------------------------------------------
  log('VERIFY: running compile + build gates…');
  const gateResults: RepairGateResult[] = [];

  const compileGate = runGate('compile', projectPath);
  gateResults.push(compileGate);
  log(`  compile gate: ${compileGate.passed ? 'PASS' : 'FAIL'} (${compileGate.errorCount} error(s))`);

  if (compileGate.passed) {
    const buildGate = runGate('build', projectPath);
    gateResults.push(buildGate);
    log(`  build gate: ${buildGate.passed ? 'PASS' : 'FAIL'}`);
  } else {
    warnings.push('Build gate skipped — compile gate did not pass.');
  }

  // ---------------------------------------------------------------------------
  // LEARN: log remaining errors to error_patterns for future repair runs
  // ---------------------------------------------------------------------------
  if (!compileGate.passed) {
    log('LEARN: logging remaining errors to error_patterns (best-effort)…');
    const remainingErrors = parseTscOutput(compileGate.output, projectPath);
    const client = getClient();
    if (client) {
      for (const err of remainingErrors.slice(0, 10)) {
        await recordError(
          {
            error_signature: `repair:${err.code}:${moduleGroupOf(err.filePath)}`,
            error_category: CATEGORY_TO_ERROR_CATEGORY[err.category],
            error_message_sample: err.message.slice(0, 200),
            first_seen_project: projectPath,
            trigger_phase: 'repair',
            trigger_prompt_pattern: err.category,
          },
          client
        ).catch(() => {
          // best-effort — never block on memory writes
        });
      }
    }
  }

  const errorsAfterRepair = compileGate.errorCount;
  const allGatesPassed = gateResults.every((g) => g.passed);
  const status: RepairResult['status'] = allGatesPassed
    ? 'success'
    : errorsAfterRepair < errors.length
      ? 'partial'
      : 'failed';

  log(`REPAIR ${status.toUpperCase()}: ${errorsAfterRepair} error(s) remain (was ${errors.length}).`);

  return {
    projectPath,
    status,
    errorsFound: errors.length,
    errorsAfterRepair,
    clusters,
    repairQueuePath: queuePath,
    executionResult,
    gateResults,
    warnings,
    generatedAt: now,
  };
}
