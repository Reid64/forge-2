// FORGE 2.0 - Composer Engine: Main Orchestrator
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  loadGovernanceSuite,
  extractTasksWithClaude,
  governanceToDAGNodes,
} from './task-extractor.js';
import {
  assemblePrompt,
  shouldSplitTask,
  splitTask,
  loadLearningContext,
} from './prompt-assembler.js';
import { writeQueueYaml, generateRunSummary } from './queue-writer.js';
import { detectGapsWithClaude, detectSchemaGaps, formatGapReport } from './gap-detector.js';
import { ForgeDAG, runAdversarialQueueReview } from '../engine/queue-generator.js';
import type { DAGNode } from '../engine/queue-generator.js';

export interface ComposeOptions {
  projectPath: string;
  projectName?: string;
  mode?: 'GREENFIELD' | 'RETROFIT';
  apiKey?: string;
  nonInteractive?: boolean;
  promptsPerRun?: number;
  outputPath?: string;
}

export interface ComposeResult {
  success: boolean;
  totalPrompts: number;
  totalRuns: number;
  runFiles: string[];
  gapReport: string;
  blockers: string[];
  warnings: string[];
  estimatedCostUSD: number;
  summaryPath: string;
}

export async function runComposer(opts: ComposeOptions): Promise<ComposeResult> {
  const {
    projectPath,
    projectName = projectPath.split(/[/\\]/).pop() ?? 'project',
    mode = 'GREENFIELD',
    apiKey,
    nonInteractive = false,
    promptsPerRun = 45,
    outputPath,
  } = opts;

  const resolvedOutput = outputPath ?? join('C:\\Users\\manag\\Documents\\FORGE', 'projects', projectName);
  const forgeDir = join(projectPath, '.forge');
  mkdirSync(forgeDir, { recursive: true });

  console.log('[COMPOSER] Starting for ' + projectName + ' (' + mode + ')');

  const suite = loadGovernanceSuite(projectPath);
  let blockers: string[] = [];
  let gapReport = '';
  const warnings: string[] = [];

  if (apiKey) {
    const gr = await detectGapsWithClaude(suite, apiKey);
    blockers = gr.blockers;
    gapReport = gr.report;
    warnings.push(...gr.gaps.filter((g) => g.startsWith('WARNING')));
  } else {
    const sr = detectSchemaGaps(suite);
    gapReport = formatGapReport(sr);
    blockers = [
      ...sr.rlsMissingOn.map((t) => 'RLS missing: ' + t),
      ...sr.missingContracts.map((a) => 'No contract: ' + a),
    ];
  }
  writeFileSync(join(forgeDir, 'gap-report.md'), gapReport, 'utf8');

  if (blockers.length > 0 && !nonInteractive) {
    console.error('[COMPOSER] BLOCKERS:');
    for (const b of blockers) console.error('  ' + b);
    return {
      success: false,
      totalPrompts: 0,
      totalRuns: 0,
      runFiles: [],
      gapReport,
      blockers,
      warnings,
      estimatedCostUSD: 0,
      summaryPath: join(forgeDir, 'gap-report.md'),
    };
  }

  const extractionResult = apiKey
    ? await extractTasksWithClaude(suite, apiKey)
    : governanceToDAGNodes(suite);

  console.log('[COMPOSER] Extracted ' + extractionResult.nodes.length + ' tasks');

  const dag = new ForgeDAG();
  for (const node of extractionResult.nodes) dag.addNode(node);
  dag.inferDependencies();

  const cycles = dag.detectCycles();
  if (cycles.length > 0 && !nonInteractive) {
    return {
      success: false,
      totalPrompts: 0,
      totalRuns: 0,
      runFiles: [],
      gapReport,
      blockers: [...blockers, 'Circular deps: ' + cycles.map((c) => c.join('->')).join(', ')],
      warnings,
      estimatedCostUSD: 0,
      summaryPath: join(forgeDir, 'gap-report.md'),
    };
  }

  const sortedNodes = dag.topologicalSort();
  const finalNodes: DAGNode[] = [];
  for (const node of sortedNodes) {
    if (shouldSplitTask(node)) finalNodes.push(...splitTask(node));
    else finalNodes.push(node);
  }

  if (apiKey && finalNodes.length > 0) {
    const ar = await runAdversarialQueueReview(finalNodes, apiKey);
    if (!ar.canProceed) {
      console.warn('[COMPOSER] Adversarial review: ' + ar.blockers.length + ' blockers');
    }
  }

  const learningCtx = loadLearningContext();
  const buildId = 'compose-' + Date.now();
  const assembledPrompts = finalNodes.map((node, idx) =>
    assemblePrompt(
      node,
      {
        projectPath,
        buildId,
        promptNumber: idx + 1,
        governanceRules: learningCtx.governanceRules,
        fixPatterns: learningCtx.fixPatterns,
      },
      {
        schemaRegistry: suite.schemaRegistry,
        contracts: suite.behavioralContracts,
        blueprint: suite.blueprint,
      }
    )
  );

  const written = writeQueueYaml(assembledPrompts, {
    projectPath,
    outputPath: resolvedOutput,
    projectName,
    mode,
    promptsPerRun,
  });

  const summary = generateRunSummary(written, {
    projectPath,
    outputPath: resolvedOutput,
    projectName,
    mode,
    promptsPerRun,
  });

  const summaryPath = join(forgeDir, 'composition-summary.md');
  writeFileSync(summaryPath, summary, 'utf8');

  const estimatedCostUSD = (written.estimatedTokens / 1_000_000) * 3;
  console.log(
    '[COMPOSER] Complete: ' +
      written.totalPrompts +
      ' prompts, ' +
      written.totalRuns +
      ' runs, ~$' +
      estimatedCostUSD.toFixed(2)
  );

  return {
    success: true,
    totalPrompts: written.totalPrompts,
    totalRuns: written.totalRuns,
    runFiles: written.runFiles,
    gapReport,
    blockers,
    warnings,
    estimatedCostUSD,
    summaryPath,
  };
}
