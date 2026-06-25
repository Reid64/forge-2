// FORGE 2.0 - Composer: Queue Writer
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AssembledPrompt } from './prompt-assembler.js';

export interface QueueWriteOptions {
  projectPath: string;
  outputPath: string;
  projectName: string;
  mode: 'GREENFIELD' | 'RETROFIT';
  governanceDocs?: string[];
  promptsPerRun?: number;
}

export interface WrittenQueue {
  runFiles: string[];
  totalPrompts: number;
  totalRuns: number;
  estimatedTokens: number;
}

function escapeYaml(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');
}

export function writeQueueYaml(assembledPrompts: AssembledPrompt[], opts: QueueWriteOptions): WrittenQueue {
  const {
    outputPath,
    projectName,
    governanceDocs = [
      'BLUEPRINT.md',
      'STATE_OF_THE_BUILD.md',
      'SESSION_STATE.md',
      'SCHEMA_REGISTRY.md',
      'BEHAVIORAL_CONTRACTS.md',
      'AGENTS.md',
    ],
    promptsPerRun = 45,
    projectPath,
  } = opts;

  const runs: AssembledPrompt[][] = [];
  for (let i = 0; i < assembledPrompts.length; i += promptsPerRun) {
    runs.push(assembledPrompts.slice(i, i + promptsPerRun));
  }

  const runFiles: string[] = [];
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 16);
  mkdirSync(outputPath, { recursive: true });

  for (let ri = 0; ri < runs.length; ri++) {
    const runBatch = runs[ri]!;
    const filename = projectName + '-composed-run' + (ri + 1) + '-' + ts + '.yaml';
    const fp = join(outputPath, filename);
    const lines: string[] = ['governance:', ...governanceDocs.map((d) => '- ' + d), 'project: ' + projectName, 'prompts:'];
    for (const p of runBatch) {
      lines.push('- id: ' + p.id);
      lines.push('  name: ' + p.id);
      lines.push('  prompt: "' + escapeYaml(p.content) + '"');
      lines.push('  gates:');
      lines.push('  - type: compile');
      lines.push('  - type: build');
      lines.push('  - type: govern' + 'ance');
    }
    writeFileSync(fp, lines.join('\n') + '\n', 'utf8');
    runFiles.push(fp);
    mkdirSync(join(projectPath, '.forge', 'prompts'), { recursive: true });
    for (const p of runBatch) {
      writeFileSync(join(projectPath, '.forge', 'prompts', p.id + '.md'), p.content, 'utf8');
    }
  }

  const firstRun = runFiles[0];
  if (firstRun) {
    writeFileSync(join(outputPath, 'queue.yaml'), readFileSync(firstRun, 'utf8'));
  }

  return {
    runFiles,
    totalPrompts: assembledPrompts.length,
    totalRuns: runs.length,
    estimatedTokens: assembledPrompts.reduce((s, p) => s + p.estimatedTokens, 0),
  };
}

export function generateRunSummary(written: WrittenQueue, opts: QueueWriteOptions): string {
  const cost = (written.estimatedTokens / 1_000_000) * 3;
  return [
    '# FORGE Composition Summary',
    'Project: ' + opts.projectName,
    '',
    'Total Prompts: ' + written.totalPrompts,
    'Total Runs: ' + written.totalRuns,
    'Estimated Cost: $' + cost.toFixed(2),
    '',
    '## Run Files',
    ...written.runFiles.map((f, i) => i + 1 + '. ' + f),
  ].join('\n');
}
