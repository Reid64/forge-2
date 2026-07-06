/**
 * FORGE 2.0 — `forge generate-prompts`: LLM-authored prompt library from a governance package.
 *
 * Reads a governance package (BLUEPRINT.md, SCHEMA_REGISTRY.md, …) and asks a model — via the
 * multi-provider router (`providerCallModel('complex_reasoning')`, same transport Phase 1B
 * uses) — to plan the build into ordered phases, then generates each phase's queue entries as
 * one-file-per-entry YAML under `<out>/<phase-index>-<phase-name>/`. `withUiDesignContext`
 * (the Session 2 helper) is applied to every UI-producing entry at generation time, so a
 * design-blind prompt can never even be written to disk.
 *
 * HUMAN GATE PRESERVED (Contract 2): this command NEVER writes queue.yaml — the operator
 * reviews the generated `prompts/` directory, edits anything that needs it, and runs
 * `forge compile` as a separate, deliberate step.
 *
 * NON-FATAL per phase: an API failure on one phase writes every phase completed so far,
 * reports exactly which phase failed, and exits non-zero — it never discards prior phases'
 * work.
 */

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import chalk from 'chalk';
import { dump as dumpYaml } from 'js-yaml';

import type { CallModel } from '../phases/phase1a-prd.js';
import { providerCallModel } from '../engine/provider-router.js';
import type { PromptType, QueueEntry } from '../engine/queue-generator.js';
import { withUiDesignContext } from '../engine/queue-generator.js';
import {
  extractJsonArray,
  extractJsonObject,
  JSON_ARRAY_ONLY_DIRECTIVE,
  JSON_ONLY_DIRECTIVE,
} from '../tools/json-extraction.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Model id + budget for both the planning call and each per-phase generation call. */
const MODEL_MAX_TOKENS = 8192;

/** The standard FORGE build order, offered to the planner as the default shape. */
const STANDARD_PHASE_ORDER = ['schema', 'auth', 'api', 'ui', 'features', 'agents', 'tests', 'deploy'];

/** Cap on the total governance corpus handed to the model (keeps the planning call bounded). */
const MAX_CORPUS_CHARS = 60_000;
/** Cap per individual doc within the corpus (a single huge doc must not crowd out the rest). */
const MAX_DOC_CHARS = 20_000;

const PROMPT_TYPES: ReadonlySet<string> = new Set<PromptType>([
  'schema',
  'auth',
  'api',
  'ui',
  'feature',
  'agent',
  'test',
  'deploy',
]);

// ---------------------------------------------------------------------------
// Governance corpus
// ---------------------------------------------------------------------------

interface GovernanceDoc {
  name: string;
  content: string;
}

/** Read every `.md` file directly under `docsDir` (not recursive — a governance package is flat). */
async function readGovernanceDocs(docsDir: string): Promise<GovernanceDoc[]> {
  const entries = await readdir(docsDir, { withFileTypes: true });
  const mdFiles = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md')).map((e) => e.name).sort();
  const docs: GovernanceDoc[] = [];
  for (const name of mdFiles) {
    try {
      const content = await readFile(join(docsDir, name), 'utf8');
      docs.push({ name, content });
    } catch {
      // unreadable file — skip it, not fatal to the whole corpus
    }
  }
  return docs;
}

/** Render the governance docs as one capped corpus string for the model. */
function renderCorpus(docs: GovernanceDoc[]): string {
  const sections = docs.map((d) => {
    const body = d.content.length > MAX_DOC_CHARS ? `${d.content.slice(0, MAX_DOC_CHARS)}\n…[truncated]` : d.content;
    return `## ${d.name}\n\n${body}`;
  });
  const joined = sections.join('\n\n---\n\n');
  return joined.length > MAX_CORPUS_CHARS ? `${joined.slice(0, MAX_CORPUS_CHARS)}\n…[corpus truncated]` : joined;
}

// ---------------------------------------------------------------------------
// Planning call
// ---------------------------------------------------------------------------

export interface PlannedPhase {
  name: string;
  promptCount: number;
  focus: string;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asPositiveInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

/** Ask the model to plan the build into ordered phases. Throws on an unrecoverable API/JSON failure. */
async function planPhases(
  callModel: CallModel,
  corpus: string,
  maxPrompts: number | undefined
): Promise<PlannedPhase[]> {
  const system = [
    "You are FORGE's build-plan architect. Given a governance package for a software project",
    '(BLUEPRINT, SCHEMA_REGISTRY, BEHAVIORAL_CONTRACTS, INTERACTION_MAPS, …), plan the autonomous',
    `build into ORDERED phases following FORGE's standard build order: ${STANDARD_PHASE_ORDER.join(' -> ')}.`,
    'Merge or drop phases that do not apply to this project; do not invent phases outside that order.',
    '',
    'Respond with a SINGLE JSON object of this exact shape:',
    '{ "phases": [ { "name": string, "promptCount": number, "focus": string }, ... ] }',
    '- name: a short kebab-case phase name (e.g. "schema", "api", "ui").',
    '- promptCount: how many queue entries this phase should contain (be realistic — most',
    '  phases need 2-8; a single-page app needs far fewer prompts than an enterprise system).',
    '- focus: one sentence describing what this phase covers for THIS project specifically.',
    '',
    maxPrompts !== undefined
      ? `The TOTAL promptCount across all phases must not exceed ${maxPrompts}.`
      : '',
    JSON_ONLY_DIRECTIVE,
  ]
    .filter((l) => l !== '')
    .join('\n');

  const user = `# Governance package\n\n${corpus}\n\nPlan this build now.`;

  const response = await callModel({ model: '', maxTokens: MODEL_MAX_TOKENS, system, user, apiKey: process.env['ANTHROPIC_API_KEY'] ?? '' });
  const raw = extractJsonObject(response.text);
  if (raw === null) {
    throw new Error('planning call did not return a JSON object');
  }
  const phasesRaw = Array.isArray(raw['phases']) ? (raw['phases'] as unknown[]) : [];
  const phases: PlannedPhase[] = phasesRaw
    .map((p) => (p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null))
    .filter((p): p is Record<string, unknown> => p !== null)
    .map((p) => ({
      name: asString(p['name']).trim() || 'phase',
      promptCount: asPositiveInt(p['promptCount'], 3),
      focus: asString(p['focus']).trim(),
    }))
    .filter((p) => p.name !== '');

  if (phases.length === 0) {
    throw new Error('planning call returned no usable phases');
  }
  return phases;
}

// ---------------------------------------------------------------------------
// Per-phase generation call
// ---------------------------------------------------------------------------

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

/** Coerce one model-generated raw object into a {@link QueueEntry}, or `null` if unusable. */
function coerceGeneratedEntry(raw: unknown, phaseName: string, seq: number): QueueEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = asString(o['id']).trim() || `${phaseName}-${String(seq).padStart(2, '0')}`;
  const rawType = asString(o['prompt_type']).trim();
  const promptType = (PROMPT_TYPES.has(rawType) ? rawType : 'feature') as PromptType;
  const ci = o['context_injection'] && typeof o['context_injection'] === 'object' ? (o['context_injection'] as Record<string, unknown>) : {};
  return {
    id,
    name: asString(o['name']).trim() || id,
    prompt_type: promptType,
    dependencies: asStringArray(o['dependencies']),
    governance_refs: asStringArray(o['governance_refs']),
    estimated_tokens: typeof o['estimated_tokens'] === 'number' ? (o['estimated_tokens'] as number) : 4000,
    context_injection: {
      schemaSections: asStringArray(ci['schema_sections'] ?? ci['schemaSections']),
      behavioralSections: asStringArray(ci['behavioral_sections'] ?? ci['behavioralSections']),
      interactionMaps: asStringArray(ci['interaction_maps'] ?? ci['interactionMaps']),
    },
    description: asString(o['description']).trim(),
  };
}

/** Generate one phase's queue entries. Throws on an unrecoverable API/JSON failure. */
async function generatePhaseEntries(
  callModel: CallModel,
  corpus: string,
  phase: PlannedPhase,
  priorEntryIds: string[]
): Promise<QueueEntry[]> {
  const system = [
    `You are FORGE's prompt author for the "${phase.name}" phase of an autonomous software build.`,
    `Phase focus: ${phase.focus || '(see governance package)'}.`,
    `Generate approximately ${phase.promptCount} queue entries as a JSON ARRAY of objects, each shaped:`,
    '{ "id": string, "name": string, "prompt_type": "schema"|"auth"|"api"|"ui"|"feature"|"agent"|"test"|"deploy",',
    '  "dependencies": string[], "governance_refs": string[], "estimated_tokens": number,',
    '  "context_injection": { "schema_sections": string[], "behavioral_sections": string[], "interaction_maps": string[] },',
    '  "description": string }',
    '- ids must be unique, kebab-case, and prefixed with the phase name (e.g. "schema-users").',
    '- dependencies may reference ids from THIS phase or from the "Prior entry ids" list below —',
    '  never invent an id that is not in either set.',
    '- description must be specific and buildable (no "TBD"/placeholder text) and end with a',
    '  reminder to update STATE_OF_THE_BUILD.md and SESSION_STATE.md.',
    '',
    JSON_ARRAY_ONLY_DIRECTIVE,
  ].join('\n');

  const user = [
    `# Governance package\n\n${corpus}`,
    `## Prior entry ids (from earlier phases — safe to depend on)\n\n${priorEntryIds.join(', ') || '(none — this is the first phase)'}`,
    `Generate this phase's ("${phase.name}") prompts now.`,
  ].join('\n\n');

  const response = await callModel({ model: '', maxTokens: MODEL_MAX_TOKENS, system, user, apiKey: process.env['ANTHROPIC_API_KEY'] ?? '' });
  const raw = extractJsonArray(response.text);
  if (raw === null) {
    throw new Error(`"${phase.name}" generation call did not return a JSON array`);
  }

  const entries = raw
    .map((item, i) => coerceGeneratedEntry(item, phase.name, i + 1))
    .filter((e): e is QueueEntry => e !== null);

  return entries.map((e) => (e.prompt_type === 'ui' || e.prompt_type === 'feature' ? withUiDesignContext(e) : e));
}

// ---------------------------------------------------------------------------
// Writing prompt files
// ---------------------------------------------------------------------------

/** Convert a `QueueEntry` back to the snake_case mapping shape `parseSingleQueueEntryYaml` expects. */
function toYamlEntryShape(entry: QueueEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: entry.id,
    name: entry.name,
    prompt_type: entry.prompt_type,
    dependencies: entry.dependencies,
    governance_refs: entry.governance_refs,
    estimated_tokens: entry.estimated_tokens,
    context_injection: {
      schema_sections: entry.context_injection.schemaSections,
      behavioral_sections: entry.context_injection.behavioralSections,
      interaction_maps: entry.context_injection.interactionMaps,
    },
    description: entry.description,
  };
  if (entry.parallel_group) out['parallel_group'] = entry.parallel_group;
  if (entry.skills && entry.skills.length > 0) out['skills'] = entry.skills;
  return out;
}

/** Slugify for a filesystem-safe phase directory / file name segment. */
function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface GeneratePromptsOptions {
  docsDir: string;
  outDir: string;
  maxPrompts?: number;
  callModel?: CallModel;
  log?: (message: string) => void;
}

export interface GeneratePromptsResult {
  success: boolean;
  phases: Array<{ name: string; dir: string; entryCount: number }>;
  totalEntries: number;
  /** Set when a phase's generation call failed — the phases completed before it are still written. */
  failedPhase: string | null;
  error: string | null;
}

/**
 * Generate a prompt library from a governance package. Writes each phase's entries as
 * `<outDir>/<phase-index>-<phase-name>/<NN>-<entry-id>.yaml`. Never compiles — the operator
 * reviews the output and runs `forge compile` (Contract 2's human gate).
 */
export async function runGeneratePrompts(options: GeneratePromptsOptions): Promise<GeneratePromptsResult> {
  const log = options.log ?? (() => {});
  const callModel = options.callModel ?? providerCallModel('complex_reasoning');

  const docs = await readGovernanceDocs(options.docsDir);
  if (docs.length === 0) {
    return {
      success: false,
      phases: [],
      totalEntries: 0,
      failedPhase: null,
      error: `No .md files found in ${options.docsDir} — nothing to plan from.`,
    };
  }
  log(`read ${docs.length} governance doc(s) from ${options.docsDir}`);
  const corpus = renderCorpus(docs);

  let planned: PlannedPhase[];
  try {
    planned = await planPhases(callModel, corpus, options.maxPrompts);
  } catch (error) {
    return {
      success: false,
      phases: [],
      totalEntries: 0,
      failedPhase: 'planning',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  log(`planned ${planned.length} phase(s): ${planned.map((p) => p.name).join(', ')}`);

  await mkdir(options.outDir, { recursive: true });

  const phaseResults: Array<{ name: string; dir: string; entryCount: number }> = [];
  const priorEntryIds: string[] = [];
  let totalEntries = 0;

  for (let i = 0; i < planned.length; i += 1) {
    const phase = planned[i];
    if (!phase) continue;
    const phaseDirName = `${i + 1}-${slug(phase.name)}`;
    const phaseDir = join(options.outDir, phaseDirName);

    let entries: QueueEntry[];
    try {
      entries = await generatePhaseEntries(callModel, corpus, phase, priorEntryIds);
    } catch (error) {
      log(`WARNING: phase "${phase.name}" failed — writing the ${phaseResults.length} phase(s) completed so far`);
      return {
        success: false,
        phases: phaseResults,
        totalEntries,
        failedPhase: phase.name,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    await mkdir(phaseDir, { recursive: true });
    for (let j = 0; j < entries.length; j += 1) {
      const entry = entries[j];
      if (!entry) continue;
      const fileName = `${String(j + 1).padStart(2, '0')}-${slug(entry.id)}.yaml`;
      await writeFile(join(phaseDir, fileName), dumpYaml(toYamlEntryShape(entry), { lineWidth: 120 }), 'utf8');
      priorEntryIds.push(entry.id);
    }

    log(`phase "${phase.name}": ${entries.length} entry(ies) → ${phaseDir}`);
    phaseResults.push({ name: phase.name, dir: phaseDir, entryCount: entries.length });
    totalEntries += entries.length;
  }

  return { success: true, phases: phaseResults, totalEntries, failedPhase: null, error: null };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/** `forge generate-prompts --docs <dir> [--out <dir>] [--project <path>] [--max-prompts <n>]`. */
export async function cmdGeneratePrompts(opts: {
  docs?: string;
  out?: string;
  project?: string;
  maxPrompts?: string;
}): Promise<void> {
  if (!opts.docs) {
    console.error(chalk.red.bold('\n✖ generate-prompts requires --docs <dir> (the governance package).'));
    process.exitCode = 1;
    return;
  }
  const docsDir = join(opts.docs);
  if (!existsSync(docsDir)) {
    console.error(chalk.red.bold(`\n✖ --docs directory not found: ${docsDir}`));
    process.exitCode = 1;
    return;
  }

  const projectPath = opts.project ? join(opts.project) : process.cwd();
  const outDir = opts.out ? join(opts.out) : join(projectPath, 'prompts');
  const maxPrompts = opts.maxPrompts ? Number.parseInt(opts.maxPrompts, 10) : undefined;

  console.log(chalk.bold(`\nGenerating prompt library from ${docsDir}`));
  const result = await runGeneratePrompts({
    docsDir,
    outDir,
    maxPrompts,
    log: (m) => console.log(chalk.dim(`  ${m}`)),
  });

  if (!result.success) {
    console.error(
      chalk.red.bold(
        `\n✖ generate-prompts failed${result.failedPhase ? ` at phase "${result.failedPhase}"` : ''}: ${result.error}`
      )
    );
    if (result.phases.length > 0) {
      console.log(chalk.yellow(`  ${result.phases.length} phase(s) were written before the failure:`));
      for (const p of result.phases) console.log(chalk.dim(`    ${p.name}: ${p.entryCount} entries → ${p.dir}`));
    }
    process.exitCode = 1;
    return;
  }

  console.log(chalk.green(`\n✔ Generated ${result.totalEntries} entries across ${result.phases.length} phase(s) → ${outDir}`));
  for (const p of result.phases) console.log(`  ${p.name.padEnd(16, ' ')} ${p.entryCount} entries  ${chalk.dim(p.dir)}`);
  console.log(chalk.yellow('\nReview the generated prompts, then run `forge compile` to produce queue.yaml.'));
}
