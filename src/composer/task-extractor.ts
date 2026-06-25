// FORGE 2.0 - Composer: Task Extractor
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DAGNode } from '../engine/queue-generator.js';

export interface GovernanceSuite {
  blueprint: string;
  schemaRegistry: string;
  agents: string;
  behavioralContracts: string;
  prd?: string;
}

export interface ExtractionResult {
  nodes: DAGNode[];
  gaps: string[];
  inconsistencies: string[];
  warnings: string[];
}

export function loadGovernanceSuite(projectPath: string): GovernanceSuite {
  const read = (f: string): string => {
    const p = join(projectPath, f);
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  };
  return {
    blueprint: read('BLUEPRINT.md'),
    schemaRegistry: read('SCHEMA_REGISTRY.md'),
    agents: read('AGENTS.md'),
    behavioralContracts: read('BEHAVIORAL_CONTRACTS.md'),
    prd: read('PRD.md') || undefined,
  };
}

export function extractTablesFromSchema(schemaRegistry: string): string[] {
  const tables: string[] = [];
  for (const m of schemaRegistry.matchAll(/^##\s+(?:Table:\s*)?`?([a-z_][a-z0-9_]*)`?/gim)) {
    if (m[1]) tables.push(m[1]);
  }
  return [...new Set(tables)];
}

export function extractAgentsFromAgentsMd(
  agentsMd: string
): Array<{ name: string; files: string[]; dbTables: string[]; estimatedPrompts: number }> {
  const agents: Array<{ name: string; files: string[]; dbTables: string[]; estimatedPrompts: number }> = [];
  for (const section of agentsMd.split(/^##\s+/m).filter((s) => s.trim())) {
    const lines = section.split('\n');
    const name = lines[0]?.trim() ?? '';
    const files: string[] = [];
    const dbTables: string[] = [];
    let ep = 3;
    for (const line of lines) {
      const fm = line.match(/`([^`]+\.[a-z]+)`/);
      if (fm && fm[1] && !fm[1].includes(' ')) files.push(fm[1]);
      const tm = line.match(/`([a-z][a-z0-9_]+)`/);
      if (tm && tm[1] && !tm[1].includes('.')) dbTables.push(tm[1]);
      const pm = line.match(/(\d+)\s+prompt/);
      if (pm && pm[1]) ep = parseInt(pm[1], 10);
    }
    if (name && name.length > 2 && name.length < 80) {
      agents.push({ name, files: [...new Set(files)], dbTables: [...new Set(dbTables)], estimatedPrompts: ep });
    }
  }
  return agents;
}

export function governanceToDAGNodes(suite: GovernanceSuite): ExtractionResult {
  const nodes: DAGNode[] = [];
  const gaps: string[] = [];
  const warnings: string[] = [];
  if (!suite.blueprint) gaps.push('BLUEPRINT.md missing');
  if (!suite.schemaRegistry) gaps.push('SCHEMA_REGISTRY.md missing');
  if (!suite.agents) gaps.push('AGENTS.md missing');
  const tables = extractTablesFromSchema(suite.schemaRegistry);
  const agentDefs = extractAgentsFromAgentsMd(suite.agents);
  for (const table of tables) {
    nodes.push({
      id: 'db-' + table,
      name: 'Create ' + table + ' migration and types',
      taskType: 'SCAFFOLD',
      complexity: 'LOW',
      estimatedTokens: 10000,
      dependsOn: [],
      filesCreate: ['supabase/migrations/' + Date.now() + '_create_' + table + '.sql'],
      filesModify: ['src/types/database.ts'],
      dbTables: [table],
      acceptanceCriteria: [
        'Migration creates ' + table + ' with all columns from SCHEMA_REGISTRY',
        'RLS enabled',
        'TypeScript types generated',
        'pnpm tsc --noEmit passes',
      ],
      verificationCommands: ['pnpm tsc --noEmit'],
      tier: 'CRITICAL',
    });
  }
  for (const agent of agentDefs) {
    const agentTables = agent.dbTables.filter((t) => tables.includes(t));
    nodes.push({
      id: 'agent-' + agent.name.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 40),
      name: 'Implement ' + agent.name,
      taskType: 'INTEGRATION',
      complexity: agent.estimatedPrompts > 5 ? 'HIGH' : 'MEDIUM',
      estimatedTokens: agent.estimatedPrompts * 25000,
      dependsOn: agentTables.map((t) => 'db-' + t),
      filesCreate: [],
      filesModify: agent.files,
      dbTables: agentTables,
      acceptanceCriteria: [
        agent.name + ' implements all functions from AGENTS.md',
        'All BEHAVIORAL_CONTRACTS enforced',
        'pnpm tsc --noEmit passes',
      ],
      verificationCommands: ['pnpm tsc --noEmit', 'pnpm build'],
      tier: 'BUILD',
    });
  }
  if (nodes.length === 0) warnings.push('No tasks extracted -- governance docs may be empty');
  return { nodes, gaps, inconsistencies: [], warnings };
}

export async function extractTasksWithClaude(suite: GovernanceSuite, apiKey: string): Promise<ExtractionResult> {
  const staticResult = governanceToDAGNodes(suite);
  try {
    const context =
      '# BLUEPRINT\n' +
      suite.blueprint.substring(0, 3000) +
      '\n\n# SCHEMA_REGISTRY\n' +
      suite.schemaRegistry.substring(0, 3000) +
      '\n\n# AGENTS\n' +
      suite.agents.substring(0, 3000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system:
          'You are a senior engineer decomposing governance documents into atomic build tasks. Respond ONLY with a JSON array. Each object: { id, name, taskType, complexity, dependsOn, filesCreate, filesModify, dbTables, acceptanceCriteria, verificationCommands, tier, estimatedTokens }. taskType: SCAFFOLD|CRUD|INTEGRATION|AI_PIPELINE|CONFIG|TEST|FIX. complexity: LOW|MEDIUM|HIGH|CRITICAL. tier: CRITICAL|WARN|BUILD|INJECT.',
        messages: [
          {
            role: 'user',
            content:
              'Extract ALL atomic build tasks from these governance documents. Apply rules: DB tables before queries, auth before protected routes, shared utilities before consumers. Return comprehensive JSON array covering every feature.\n\n' +
              context,
          },
        ],
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
      const text = data.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim()) as DAGNode[];
      if (Array.isArray(parsed) && parsed.length > staticResult.nodes.length) {
        return { nodes: parsed, gaps: staticResult.gaps, inconsistencies: [], warnings: staticResult.warnings };
      }
    }
  } catch {
    /* fall back to static */
  }
  return staticResult;
}
