// FORGE 2.0 - Composer: Document Sequencer for enterprise 40+ doc builds
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

export interface SpecDocument {
  filename: string;
  path: string;
  content: string;
  order: number;
  dependsOn: string[];
  category: 'FOUNDATION' | 'SCHEMA' | 'AUTH' | 'API' | 'UI' | 'INTEGRATION' | 'TESTING' | 'DEPLOY' | 'OTHER';
  estimatedPrompts: number;
}

export interface SequencePlan {
  documents: SpecDocument[];
  totalEstimatedPrompts: number;
  totalEstimatedRuns: number;
  executionOrder: string[];
  warnings: string[];
}

const CATEGORY_ORDER: Record<string, number> = {
  FOUNDATION: 0,
  SCHEMA: 1,
  AUTH: 2,
  API: 3,
  UI: 4,
  INTEGRATION: 5,
  TESTING: 6,
  DEPLOY: 7,
  OTHER: 8,
};

const CATEGORY_BASE_PROMPTS: Record<SpecDocument['category'], number> = {
  FOUNDATION: 5,
  SCHEMA: 8,
  AUTH: 10,
  API: 12,
  UI: 15,
  INTEGRATION: 10,
  TESTING: 8,
  DEPLOY: 6,
  OTHER: 5,
};

const CATEGORY_PATTERNS: Array<[RegExp, SpecDocument['category']]> = [
  [/foundation|overview|architecture|blueprint|prd/i, 'FOUNDATION'],
  [/schema|database|migration|table/i, 'SCHEMA'],
  [/auth|authentication|session|jwt/i, 'AUTH'],
  [/api|endpoint|route|rest/i, 'API'],
  [/ui|component|page|layout/i, 'UI'],
  [/integration|webhook|stripe|twilio/i, 'INTEGRATION'],
  [/test|spec|e2e|playwright/i, 'TESTING'],
  [/deploy|devops|vercel|infrastructure/i, 'DEPLOY'],
];

function categorize(filename: string, content: string): SpecDocument['category'] {
  for (const [p, c] of CATEGORY_PATTERNS) {
    if (p.test(filename) || p.test(content.substring(0, 500))) return c;
  }
  return 'OTHER';
}

export function loadSpecDocuments(specsDir: string): SpecDocument[] {
  if (!existsSync(specsDir)) throw new Error('Specs directory not found: ' + specsDir);
  const files = readdirSync(specsDir)
    .filter((f) => ['.md', '.txt', '.yaml'].includes(extname(f).toLowerCase()))
    .sort();
  return files.map((file, i) => {
    const path = join(specsDir, file);
    const content = readFileSync(path, 'utf8');
    const category = categorize(file, content);
    const basePrompts = CATEGORY_BASE_PROMPTS[category];
    return {
      filename: file,
      path,
      content,
      order: i,
      dependsOn: [],
      category,
      estimatedPrompts: Math.round(Math.min(3, Math.max(1, content.split('\n').length / 100)) * basePrompts),
    };
  });
}

export function createSequencePlan(docs: SpecDocument[]): SequencePlan {
  const sorted = [...docs].sort(
    (a, b) =>
      (CATEGORY_ORDER[a.category] ?? 8) - (CATEGORY_ORDER[b.category] ?? 8) ||
      a.filename.localeCompare(b.filename)
  );
  const total = sorted.reduce((s, d) => s + d.estimatedPrompts, 0);
  const warnings: string[] = [];
  if (sorted.length === 0) warnings.push('No spec documents found');
  if (total > 500) warnings.push('Large build: ' + total + ' estimated prompts. Will take multiple days.');
  return {
    documents: sorted,
    totalEstimatedPrompts: total,
    totalEstimatedRuns: Math.ceil(total / 45),
    executionOrder: sorted.map((d) => d.filename),
    warnings,
  };
}

export function writeSequencePlanSummary(plan: SequencePlan, outputPath: string): string {
  mkdirSync(outputPath, { recursive: true });
  const sp = join(outputPath, 'sequence-plan.md');
  const lines = [
    '# FORGE Document Sequence Plan',
    '',
    'Total Documents: ' + plan.documents.length,
    'Total Estimated Prompts: ' + plan.totalEstimatedPrompts,
    'Total Runs: ' + plan.totalEstimatedRuns,
    'Estimated Cost: $' + ((plan.totalEstimatedPrompts * 25000) / 1_000_000 * 3).toFixed(2),
    '',
    '## Execution Order',
    '',
  ];
  for (let i = 0; i < plan.documents.length; i++) {
    const d = plan.documents[i]!;
    lines.push(i + 1 + '. **' + d.filename + '** [' + d.category + '] (~' + d.estimatedPrompts + ' prompts)');
  }
  if (plan.warnings.length > 0) {
    lines.push('', '## Warnings');
    for (const w of plan.warnings) lines.push('- ' + w);
  }
  writeFileSync(sp, lines.join('\n') + '\n', 'utf8');
  return sp;
}
