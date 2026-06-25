// FORGE 2.0 - Phase Chain: End-to-End Build Pipeline
// Chains: Scout -> PRD -> Architect -> Compose -> Execute -> Deploy
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type BuildMode = 'GREENFIELD' | 'RETROFIT' | 'PRD_IMPORT';

export interface BuildOptions {
  projectPath: string;
  mode: BuildMode;
  idea?: string;
  ideaFile?: string;
  prdPath?: string;
  specsDir?: string;
  apiKey?: string;
  nonInteractive?: boolean;
  skipDeploy?: boolean;
  skipSentinel?: boolean;
}

export interface PhaseResult {
  phase: string;
  success: boolean;
  outputPath?: string;
  error?: string;
  durationMs: number;
}

export interface BuildResult {
  buildId: string;
  mode: BuildMode;
  phases: PhaseResult[];
  success: boolean;
  productionUrl?: string;
  totalDurationMs: number;
}

async function runPhase<T>(phaseName: string, fn: () => Promise<T>): Promise<{ result: T | null; phaseResult: PhaseResult }> {
  const start = Date.now();
  try {
    const result = await fn();
    return { result, phaseResult: { phase: phaseName, success: true, durationMs: Date.now() - start } };
  } catch (e: unknown) {
    return { result: null, phaseResult: { phase: phaseName, success: false, error: String(e), durationMs: Date.now() - start } };
  }
}

export async function runForgeBuild(opts: BuildOptions): Promise<BuildResult> {
  const buildId = randomUUID();
  const startTime = Date.now();
  const phases: PhaseResult[] = [];
  const { projectPath, mode, apiKey, nonInteractive = false } = opts;

  console.log('[FORGE BUILD] Starting ' + mode + ' build: ' + buildId.substring(0, 8));
  console.log('[FORGE BUILD] Project: ' + projectPath);

  mkdirSync(join(projectPath, '.forge'), { recursive: true });

  // Phase 0: SCOUT (Greenfield only)
  if (mode === 'GREENFIELD' && opts.idea) {
    console.log('[FORGE BUILD] Phase 0: SCOUT');
    const { result: _scoutResult, phaseResult } = await runPhase('SCOUT', async () => {
      const { runPhase0Scout } = await import('./phase0-scout.js');
      return runPhase0Scout(projectPath);
    });
    phases.push(phaseResult);
    if (!phaseResult.success) { console.error('[FORGE BUILD] SCOUT failed: ' + phaseResult.error); return { buildId, mode, phases, success: false, totalDurationMs: Date.now() - startTime }; }
    console.log('[FORGE BUILD] SCOUT complete');
  }

  // Track PRD text for Phase 1B
  let prdText = '';

  // Phase 1A: PRD (Greenfield only, skip if PRD_IMPORT)
  if (mode === 'GREENFIELD') {
    console.log('[FORGE BUILD] Phase 1A: PRD Generation');
    const { result: prdResult, phaseResult } = await runPhase('PRD', async () => {
      const { runPhase1aPrd } = await import('./phase1a-prd.js');
      return runPhase1aPrd(projectPath, opts.idea ?? '', { apiKey: apiKey ?? '' });
    });
    phases.push(phaseResult);
    if (!phaseResult.success) { console.error('[FORGE BUILD] PRD failed: ' + phaseResult.error); return { buildId, mode, phases, success: false, totalDurationMs: Date.now() - startTime }; }
    prdText = prdResult?.prd ?? '';
    console.log('[FORGE BUILD] PRD complete');
  }

  // Phase 1B: ARCHITECT - generate governance suite
  console.log('[FORGE BUILD] Phase 1B: ARCHITECT');
  const { result: _archResult, phaseResult: archPhase } = await runPhase('ARCHITECT', async () => {
    const { runPhase1bArchitect } = await import('./phase1b-architect.js');
    return runPhase1bArchitect(projectPath, prdText, { apiKey: apiKey ?? '' });
  });
  phases.push(archPhase);
  if (!archPhase.success) { console.error('[FORGE BUILD] ARCHITECT failed: ' + archPhase.error); return { buildId, mode, phases, success: false, totalDurationMs: Date.now() - startTime }; }
  console.log('[FORGE BUILD] ARCHITECT complete -- governance suite generated');

  // Composer: generate execution queue
  console.log('[FORGE BUILD] COMPOSER: Generating execution queue');
  const { result: composeResult, phaseResult: composePhase } = await runPhase('COMPOSE', async () => {
    const { runComposer } = await import('../composer/index.js');
    return runComposer({ projectPath, mode: mode === 'RETROFIT' ? 'RETROFIT' : 'GREENFIELD', apiKey, nonInteractive });
  });
  phases.push(composePhase);
  if (!composePhase.success || composeResult === null || !composeResult.success) { console.error('[FORGE BUILD] COMPOSE failed'); return { buildId, mode, phases, success: false, totalDurationMs: Date.now() - startTime }; }
  console.log('[FORGE BUILD] COMPOSER complete -- ' + composeResult.totalPrompts + ' prompts across ' + composeResult.totalRuns + ' runs');
  console.log('[FORGE BUILD] Estimated cost: $' + composeResult.estimatedCostUSD.toFixed(2));

  // Write launch instructions
  const launchInstructions = [
    '# FORGE Build Ready',
    '',
    'Build ID: ' + buildId,
    'Mode: ' + mode,
    'Prompts: ' + composeResult.totalPrompts,
    'Runs: ' + composeResult.totalRuns,
    'Estimated cost: $' + composeResult.estimatedCostUSD.toFixed(2),
    '',
    '## Launch Command',
    '',
    '```powershell',
    'cd C:\\Users\\manag\\Documents\\FORGE; $env:NODE_OPTIONS="--max-old-space-size=8192"; $env:ANTHROPIC_API_KEY=$null; $env:DANGEROUSLY_SKIP_PERMISSIONS=1; powershell -ExecutionPolicy Bypass -File .\\forge.ps1 -project ' + projectPath.split(/[/\\]/).pop() + ' -startFrom 0',
    '```',
  ].join('\n');
  writeFileSync(join(projectPath, '.forge', 'BUILD_READY.md'), launchInstructions, 'utf8');
  console.log('[FORGE BUILD] Launch instructions: ' + join(projectPath, '.forge', 'BUILD_READY.md'));

  return { buildId, mode, phases, success: true, totalDurationMs: Date.now() - startTime };
}
