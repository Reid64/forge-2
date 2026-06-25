// FORGE 2.0 - Composer: 7-Section Prompt Assembler
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import type { DAGNode } from '../engine/queue-generator.js';

export interface AssemblyContext {
  projectPath: string;
  buildId: string;
  promptNumber: number;
  governanceRules?: string[];
  fixPatterns?: string[];
  priorFailures?: string;
}

export interface AssembledPrompt {
  id: string;
  content: string;
  estimatedTokens: number;
}

function sliceSchema(schemaRegistry: string, tables: string[]): string {
  if (tables.length === 0) return '';
  const lines = schemaRegistry.split('\n');
  const result: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) inSection = tables.some((t) => line.toLowerCase().includes(t.toLowerCase()));
    if (inSection) result.push(line);
  }
  return result.join('\n').substring(0, 2000);
}

export function assemblePrompt(
  node: DAGNode,
  ctx: AssemblyContext,
  governance: { schemaRegistry: string; contracts: string; blueprint: string }
): AssembledPrompt {
  const sections: string[] = [];
  const learning: string[] = [];

  if (ctx.governanceRules && ctx.governanceRules.length > 0) {
    learning.push('=== ACTIVE GOVERNANCE RULES ===');
    for (const r of ctx.governanceRules.slice(0, 10)) learning.push('- ' + r);
    learning.push('=== END GOVERNANCE RULES ===');
  }
  if (ctx.fixPatterns && ctx.fixPatterns.length > 0) {
    learning.push('=== KNOWN FIX PATTERNS ===');
    for (const p of ctx.fixPatterns.slice(0, 5)) learning.push('- ' + p);
    learning.push('=== END FIX PATTERNS ===');
  }
  if (learning.length > 0) sections.push(learning.join('\n'));

  const schemaSlice = sliceSchema(governance.schemaRegistry, node.dbTables);
  if (schemaSlice) sections.push('=== RELEVANT SCHEMA ===\n' + schemaSlice + '\n=== END SCHEMA ===');

  sections.push(
    '=== TASK ===\nID: ' +
      node.id +
      '\nName: ' +
      node.name +
      '\nType: ' +
      node.taskType +
      '\nComplexity: ' +
      node.complexity +
      '\nThis is a single atomic task. Complete it fully before stopping.\n=== END TASK ==='
  );

  sections.push(
    '=== ACCEPTANCE CRITERIA ===\n' +
      node.acceptanceCriteria.map((c, i) => i + 1 + '. ' + c).join('\n') +
      '\n=== END CRITERIA ==='
  );

  const manifest: string[] = ['=== FILE MANIFEST ==='];
  if (node.filesCreate.length > 0) manifest.push('CREATE: ' + node.filesCreate.join(', '));
  if (node.filesModify.length > 0) manifest.push('MODIFY: ' + node.filesModify.join(', '));
  manifest.push('DO NOT TOUCH: any file not listed above', '=== END MANIFEST ===');
  sections.push(manifest.join('\n'));

  sections.push(
    '=== VERIFICATION ===\n' +
      node.verificationCommands.map((c) => 'Run: ' + c).join('\n') +
      '\n=== END VERIFICATION ==='
  );

  sections.push(
    '=== GOVERNANCE UPDATE MANDATE ===\nUpdate STATE_OF_THE_BUILD.md: mark ' +
      node.name +
      ' COMPLETE with actual file sizes.\nUpdate SESSION_STATE.md: current prompt ' +
      node.id +
      '.\nAll updates from actual codebase audit -- not from memory.\n=== END GOVERNANCE ==='
  );

  sections.push(
    '=== ROLLBACK ===\nIf this prompt fails FORGE will automatically revert via git reset --hard HEAD~1.\n=== END ROLLBACK ==='
  );

  const content =
    'You are operating autonomously on FORGE 2.0 at ' +
    ctx.projectPath +
    '.\nRead all context cold from the filesystem. Write all files directly to their correct paths. Do NOT install npm packages unless this is an install prompt. Do NOT ask for human input. Do NOT produce stubs.\n\n' +
    sections.join('\n\n');

  return { id: node.id, content, estimatedTokens: Math.round(content.length / 4) };
}

export function shouldSplitTask(node: DAGNode): boolean {
  return node.filesCreate.length + node.filesModify.length > 5 || node.dbTables.length > 3 || node.estimatedTokens > 80000;
}

export function splitTask(node: DAGNode): DAGNode[] {
  if (!shouldSplitTask(node)) return [node];
  const allFiles = [...node.filesCreate, ...node.filesModify];
  const mid = Math.ceil(allFiles.length / 2);
  return [
    {
      ...node,
      id: node.id + '-part1',
      name: node.name + ' (Part 1)',
      filesCreate: allFiles.slice(0, mid).filter((f) => node.filesCreate.includes(f)),
      filesModify: allFiles.slice(0, mid).filter((f) => node.filesModify.includes(f)),
      estimatedTokens: Math.round(node.estimatedTokens / 2),
    },
    {
      ...node,
      id: node.id + '-part2',
      name: node.name + ' (Part 2)',
      dependsOn: [...node.dependsOn, node.id + '-part1'],
      filesCreate: allFiles.slice(mid).filter((f) => node.filesCreate.includes(f)),
      filesModify: allFiles.slice(mid).filter((f) => node.filesModify.includes(f)),
      estimatedTokens: Math.round(node.estimatedTokens / 2),
    },
  ];
}

export function loadLearningContext(dbPath?: string): { governanceRules: string[]; fixPatterns: string[] } {
  const empty = { governanceRules: [], fixPatterns: [] };
  try {
    const resolved = dbPath ?? join(homedir(), '.forge', 'forge_memory.db');
    if (!existsSync(resolved)) return empty;
    const rules = execSync(
      'sqlite3 "' +
        resolved +
        '" "SELECT rule_text FROM governance_rules WHERE active = 1 ORDER BY enforcement_count DESC LIMIT 10"',
      { stdio: 'pipe' }
    )
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    const patterns = execSync(
      'sqlite3 "' +
        resolved +
        '" "SELECT fix_description FROM fix_patterns WHERE success_rate > 0.7 AND occurrence_count >= 2 ORDER BY (success_rate * occurrence_count) DESC LIMIT 5"',
      { stdio: 'pipe' }
    )
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    return { governanceRules: rules, fixPatterns: patterns };
  } catch {
    return empty;
  }
}
