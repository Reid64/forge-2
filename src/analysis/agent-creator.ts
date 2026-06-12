/**
 * FORGE 2.0 — Agent Creator (Phase 5 Recursive Learner, queue.yaml s6-p03).
 *
 * The THIRD analysis module. Where the Pattern Extractor (s6-p01) distils ONE build and the
 * Template Evolver (s6-p02) reads ACROSS builds to improve governance text, the Agent Creator
 * reads ACROSS builds to find recurring MULTI-STEP TASK SEQUENCES that FORGE keeps re-doing by
 * hand — and proposes a dedicated agent to automate each one. It is the self-evolving half of
 * Phase 5 (BLUEPRINT F9 "self-evolving agent creation", PRD success criterion "≥1 self-created
 * agent within 10 builds").
 *
 * THE SPEC (s6-p03, verbatim):
 *   1. Analyze `prompt_executions` across builds for repeated multi-step sequences.
 *   2. If a 2+ step sequence appears in 3+ builds with NO dedicated handler:
 *      a. Design an agent spec: name, purpose, triggers, I/O contracts.
 *      b. Generate a TypeScript implementation using the Claude API.
 *      c. Test against historical data (replay the pattern with the new agent).
 *      d. Store as a `self_created_agent` with status 'proposed'.
 *   3. Generate a human-readable proposal document: agent name + purpose, implementation code,
 *      test results, projected impact on future builds.
 *
 * GOVERNANCE (BEHAVIORAL_CONTRACTS Contract 17 — Self-Created Agents): FORGE may create an agent
 * ONLY when (a) a task pattern has appeared in 3+ builds, (b) NO existing agent or tool handles
 * the pattern, and (c) the proposed agent PASSES test validation against historical data. A
 * self-created agent starts at status 'proposed' and becomes 'active' ONLY after a human approves
 * it (BLUEPRINT Canonical Rule 3 — never auto-deploy a self-created agent). Accordingly this
 * module ONLY proposes: it writes a `self_created_agents` row with the DB-default 'proposed'
 * status and NEVER approves, activates, or wires an agent into a build.
 *
 * HOW A "SEQUENCE" IS RECOVERED: `prompt_executions` carries no `prompt_type` column (only
 * `prompt_name`), so — exactly like the Pattern Extractor — the step type is recovered from the
 * name: from the approved queue `entries` (`name → prompt_type`) when supplied, else by
 * `classifyPromptType` (REUSED from pattern-extractor so the two modules agree byte-for-byte).
 * A build's "sequence" is its executed prompts ordered by `prompt_index`, mapped to their types.
 * Contiguous n-grams (length {@link MIN_SEQUENCE_LENGTH}…{@link MAX_SEQUENCE_LENGTH}) are counted
 * by the number of DISTINCT builds that contain them; an n-gram in ≥ {@link DEFAULT_MIN_BUILDS}
 * builds is a candidate. Only MAXIMAL candidates survive (a candidate that is a contiguous
 * sub-sequence of a longer qualifying candidate is dropped — we propose the longest repeated
 * unit, not every fragment of it), and candidates already covered by an existing agent's
 * recorded sequence are excluded ("no dedicated handler", Contract 17b).
 *
 * THE "TEST" (step 2c) is a DETERMINISTIC historical replay, not a live execution: this module
 * never spawns code. For each build containing the sequence it measures how reliably those steps
 * completed historically (the executed-prompt success rate over the matched occurrences) and runs
 * static checks on the generated code (non-empty, exports something, references the contract).
 * `passed` requires the static checks AND a historical occurrence count ≥ the build threshold —
 * Contract 17c's "passes test validation against historical data". Only PASSING proposals are
 * stored; failing ones are reported (with the reason) but never written.
 *
 * MODEL (step 2b): the Anthropic Messages API, via the SAME injectable transport Phase 1A/1B use
 * (`defaultCallModel` / `CallModel` from phase1a-prd) — no new package dependency, one shared
 * HTTP client, fully injectable for tests. The call is GUARDED per artifact: if the model is
 * unreachable or returns non-JSON, that proposal degrades to a clearly-marked DETERMINISTIC
 * SKELETON implementation (`usedFallback: true` + a warning) rather than throwing — so a build's
 * learning pass is never blocked by the network (matching phase1b's per-artifact fallback).
 *
 * NON-FATAL house style (Contract 4): the analysis is PURE and deterministic; every Build Memory
 * read/write is injectable and guarded — a DB outage degrades to stateless (the report is still
 * returned; nothing is stored) and never throws. `createAgents` never rejects.
 *
 * BOUNDARY: reads `prompt_executions` / `build_runs` / `self_created_agents`; writes
 * `self_created_agents` (proposals only). Touches no governance file (Iron Law 1) and no target
 * project — the agents it proposes are FORGE's own, subject to the human approval gate.
 */

import type { PromptType, QueueEntry } from '../engine/queue-generator.js';
import { classifyPromptType } from './pattern-extractor.js';
import type { CallModel } from '../phases/phase1a-prd.js';
import { providerCallModel } from '../engine/provider-router.js';
import { logLine } from '../tools/forge-logger.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import type { NewSelfCreatedAgent } from '../memory/agents.js';
import type {
  BuildRun,
  PromptExecution,
  SelfCreatedAgent,
  JsonObject,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** A recurring contiguous prompt-type sequence mined across builds. */
export interface SequenceCandidate {
  /** The contiguous prompt-type sequence (length ≥ {@link MIN_SEQUENCE_LENGTH}). */
  sequence: PromptType[];
  /** Distinct build ids whose execution order contains this contiguous sequence. */
  buildIds: string[];
  /** Number of distinct builds containing it (≥ minBuilds to qualify). */
  buildCount: number;
  /** Total contiguous occurrences across all builds (a build may contain it more than once). */
  totalOccurrences: number;
}

/** A deterministic agent specification designed from a qualifying sequence. */
export interface ProposedAgentSpec {
  /** Unique, kebab-case agent name (the `self_created_agents.name` unique key). */
  name: string;
  /** What the agent does (the `purpose` column). */
  purpose: string;
  /** When the agent activates — the recurring sequence + thresholds (`trigger_conditions`). */
  triggerConditions: JsonObject;
  /** Expected inputs (`input_contract`). */
  inputContract: JsonObject;
  /** Expected outputs (`output_contract`). */
  outputContract: JsonObject;
}

/** Static checks run over the generated implementation code. */
export interface AgentCodeChecks {
  /** The code is non-empty after trimming. */
  nonEmpty: boolean;
  /** The code exports something (a function/const/default — a usable entry point). */
  exportsEntryPoint: boolean;
  /** The code references the agent's contract (its name or one of the sequence step types). */
  referencesContract: boolean;
}

/** The historical-replay validation result for a proposed agent (step 2c). */
export interface AgentTestResult {
  /** Distinct builds the sequence was replayed against. */
  replayedBuilds: number;
  /** Total contiguous occurrences of the sequence across those builds. */
  sequenceOccurrences: number;
  /** Executed prompts matched by the replay (the success-rate denominator). */
  matchedPrompts: number;
  /** Succeeded / executed across the matched prompts in [0, 1], or null when none executed. */
  historicalSuccessRate: number | null;
  /** Static checks over the generated code. */
  codeChecks: AgentCodeChecks;
  /** True when the static checks pass AND the build threshold was met (Contract 17c). */
  passed: boolean;
  /** Human-readable notes (why it passed / failed). */
  notes: string[];
}

/** Projected impact of adopting a proposed agent on future builds. */
export interface AgentImpactProjection {
  /** Distinct historical builds that exhibited the sequence. */
  buildsAffected: number;
  /** Total occurrences automated across history. */
  occurrences: number;
  /** buildsAffected / total builds analyzed in [0, 1] — the future-build coverage proxy. */
  buildCoverage: number;
  /**
   * Estimated prompts saved: each occurrence collapses `sequence.length` hand-run prompts into a
   * single agent invocation, saving `length − 1` per occurrence.
   */
  promptsSavedEstimate: number;
}

/** A single, evidence-backed agent proposal (the s6-p03 step-3 output). */
export interface AgentProposal {
  spec: ProposedAgentSpec;
  candidate: SequenceCandidate;
  /** The generated TypeScript implementation (model output, or the deterministic skeleton). */
  implementationCode: string;
  /** True when the model call failed and a deterministic skeleton was used. */
  usedFallback: boolean;
  /** Why this sequence motivated an agent (the `source_pattern_description` column). */
  sourcePatternDescription: string;
  test: AgentTestResult;
  impact: AgentImpactProjection;
  /** The human-readable proposal document (Markdown). */
  proposalDocument: string;
  /** True when the proposal passed validation and is eligible to be stored. */
  eligible: boolean;
}

/** The pure analysis report (before any storage). */
export interface AgentCreatorReport {
  /** Distinct builds whose executions were analyzed. */
  buildsAnalyzed: number;
  /** Total prompt_executions scanned. */
  promptsAnalyzed: number;
  /** Existing self_created_agents considered for the "no dedicated handler" test. */
  existingAgents: number;
  /** Every maximal recurring sequence that met the build threshold. */
  candidates: SequenceCandidate[];
  /** The proposals generated (one per maximal, un-handled, qualifying candidate). */
  proposals: AgentProposal[];
  /** Non-fatal observations (no executions, model fallback, stateless degrade, …). */
  warnings: string[];
  generatedAt: string;
}

/** What got persisted to Build Memory. */
export interface AgentStorageResult {
  /** self_created_agents proposal rows created (status 'proposed'). */
  agentsStored: number;
  /** True when Build Memory was unreachable and nothing could be stored. */
  stateless: boolean;
  warnings: string[];
}

/** The full result of {@link createAgents}. */
export interface AgentCreationResult {
  report: AgentCreatorReport;
  storage: AgentStorageResult;
}

/** Inputs to {@link createAgents} (all optional — fetched from Build Memory when omitted). */
export interface CreateAgentsInput {
  /** Recent `build_runs` to mine (else `BuildMemory.builds.listBuilds`). */
  builds?: BuildRun[];
  /** All `prompt_executions` across those builds (else fetched per build). */
  executions?: PromptExecution[];
  /** Approved queue entries, used to map `prompt_name → prompt_type` EXACTLY (else classified). */
  entries?: QueueEntry[];
  /** Existing self_created_agents (else `BuildMemory.agents.listAgents`). */
  existingAgents?: SelfCreatedAgent[];
}

/** Options for {@link createAgents} — store toggle, thresholds, model + injectable I/O (tests). */
export interface AgentCreatorOptions {
  /** Persist passing proposals to Build Memory. Default true (set false for a pure analysis). */
  store?: boolean;
  /** Min distinct builds a sequence must appear in to qualify (Contract 17a). Default 3. */
  minBuilds?: number;
  /** Shortest sequence considered ("multi-step" = ≥ 2). Default 2. */
  minSequenceLength?: number;
  /** Longest sequence considered (caps the n-gram search). Default 5. */
  maxSequenceLength?: number;
  /** How many recent builds to scan. Default 500. */
  buildScanLimit?: number;
  /** Model id for code generation. Default `FORGE_AGENT_MODEL` env, else {@link DEFAULT_MODEL}. */
  model?: string;
  /** Anthropic API key. Default: `ANTHROPIC_API_KEY` env. */
  apiKey?: string;
  /** max_tokens for code generation. Default {@link DEFAULT_MAX_TOKENS}. */
  maxTokens?: number;
  /** Injected model caller (tests / SDK swap). Default {@link defaultCallModel}. */
  callModel?: CallModel;
  /** Fetch recent builds. Default `BuildMemory.builds.listBuilds` (→ []). */
  fetchBuilds?: () => Promise<BuildRun[]>;
  /** Fetch executions across builds. Default per-build `BuildMemory.prompts.getPromptsByBuild`. */
  fetchExecutions?: (builds: BuildRun[]) => Promise<PromptExecution[]>;
  /** Fetch existing agents. Default `BuildMemory.agents.listAgents` (→ []). */
  fetchAgents?: () => Promise<SelfCreatedAgent[]>;
  /** Create a self_created_agents proposal row. Default `BuildMemory.agents.createAgent`. */
  createAgent?: (input: NewSelfCreatedAgent) => Promise<SelfCreatedAgent | null>;
  /** Progress reporter. Default logs to the console with a `[FORGE:agent-creator]` prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Canonical code-generation model id. Mirrors the design phases (`claude-sonnet-4-6`).
 * Overridable via `options.model` / `FORGE_AGENT_MODEL`.
 */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Default generation budget — a single self-contained agent module is moderate. */
export const DEFAULT_MAX_TOKENS = 4096;

/** Min distinct builds a sequence must appear in (Contract 17a). */
export const DEFAULT_MIN_BUILDS = 3;

/** Shortest sequence considered ("multi-step" = 2+ steps, s6-p03 step 2). */
export const MIN_SEQUENCE_LENGTH = 2;

/** Longest sequence considered (bounds the n-gram search). */
export const MAX_SEQUENCE_LENGTH = 5;

/** Statuses that count an execution as having actually run (success-rate denominator). */
const EXECUTED_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed']);

/** Statuses whose presence in a build means the prompt was attempted (counted in the order). */
const ORDERED_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'running',
  'skipped',
]);

// ---------------------------------------------------------------------------
// Numeric helpers (pure) — mirror the sibling analysis modules
// ---------------------------------------------------------------------------

/** Round to a fixed number of decimals. */
function round(n: number, decimals = 4): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** Render an unknown thrown value as a short string for logging. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Cast an arbitrary serializable value to a Build-Memory `jsonb` object (deep-cloned). */
function jsonClone(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

// ---------------------------------------------------------------------------
// Sequence mining (pure, deterministic)
// ---------------------------------------------------------------------------

/** Group executions by build id, each list ordered ascending by prompt_index. */
function groupByBuild(executions: PromptExecution[]): Map<string, PromptExecution[]> {
  const groups = new Map<string, PromptExecution[]>();
  for (const ex of executions) {
    const list = groups.get(ex.build_run_id);
    if (list) list.push(ex);
    else groups.set(ex.build_run_id, [ex]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.prompt_index - b.prompt_index);
  }
  return groups;
}

/** Stable string key for a prompt-type sequence (used to count/dedup n-grams). */
function sequenceKey(sequence: readonly PromptType[]): string {
  return sequence.join('>');
}

/** True when `sub` is a contiguous sub-sequence of `seq` (used to drop subsumed candidates). */
function isContiguousSubsequence(
  sub: readonly PromptType[],
  seq: readonly PromptType[]
): boolean {
  if (sub.length >= seq.length) return false;
  outer: for (let i = 0; i + sub.length <= seq.length; i++) {
    for (let j = 0; j < sub.length; j++) {
      if (seq[i + j] !== sub[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Mine contiguous prompt-type n-grams across the per-build sequences. Each n-gram is counted by
 * the number of DISTINCT builds it appears in (and the total contiguous occurrences). Returns a
 * candidate per n-gram (length within [minLen, maxLen]) that appears in ≥ minBuilds builds.
 */
function mineSequences(
  buildSequences: Map<string, PromptType[]>,
  minLen: number,
  maxLen: number,
  minBuilds: number
): SequenceCandidate[] {
  interface Acc {
    sequence: PromptType[];
    buildIds: Set<string>;
    totalOccurrences: number;
  }
  const byKey = new Map<string, Acc>();

  for (const [buildId, types] of buildSequences) {
    if (types.length < minLen) continue;
    const upper = Math.min(maxLen, types.length);
    for (let len = minLen; len <= upper; len++) {
      for (let start = 0; start + len <= types.length; start++) {
        const sequence = types.slice(start, start + len);
        const key = sequenceKey(sequence);
        const existing = byKey.get(key);
        if (existing) {
          existing.buildIds.add(buildId);
          existing.totalOccurrences += 1;
        } else {
          byKey.set(key, {
            sequence,
            buildIds: new Set<string>([buildId]),
            totalOccurrences: 1,
          });
        }
      }
    }
  }

  const candidates: SequenceCandidate[] = [];
  for (const acc of byKey.values()) {
    if (acc.buildIds.size < minBuilds) continue;
    candidates.push({
      sequence: acc.sequence,
      buildIds: [...acc.buildIds].sort(),
      buildCount: acc.buildIds.size,
      totalOccurrences: acc.totalOccurrences,
    });
  }
  return candidates;
}

/**
 * Keep only MAXIMAL candidates: drop any candidate that is a contiguous sub-sequence of a longer
 * qualifying candidate which appears in at least as many builds (the longer unit already covers
 * it). Ordered longest-first, then by build count, then lexicographically for a stable result.
 */
function selectMaximal(candidates: SequenceCandidate[]): SequenceCandidate[] {
  const sorted = [...candidates].sort(
    (a, b) =>
      b.sequence.length - a.sequence.length ||
      b.buildCount - a.buildCount ||
      sequenceKey(a.sequence).localeCompare(sequenceKey(b.sequence))
  );
  const kept: SequenceCandidate[] = [];
  for (const candidate of sorted) {
    const subsumed = kept.some(
      (k) =>
        k.sequence.length > candidate.sequence.length &&
        k.buildCount >= candidate.buildCount &&
        isContiguousSubsequence(candidate.sequence, k.sequence)
    );
    if (!subsumed) kept.push(candidate);
  }
  return kept;
}

/** Read a recorded agent's trigger sequence (`trigger_conditions.sequence`) as a type list. */
function agentSequence(agent: SelfCreatedAgent): PromptType[] {
  const raw = (agent.trigger_conditions as JsonObject)['sequence'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is PromptType => typeof t === 'string') as PromptType[];
}

/**
 * "No dedicated handler" (Contract 17b): a candidate is handled when an existing agent's recorded
 * sequence equals it OR contains it as a contiguous sub-sequence (the existing agent already
 * automates this run of steps).
 */
function isHandledByExisting(
  candidate: SequenceCandidate,
  existingAgents: SelfCreatedAgent[]
): boolean {
  const candKey = sequenceKey(candidate.sequence);
  for (const agent of existingAgents) {
    const seq = agentSequence(agent);
    if (seq.length === 0) continue;
    if (sequenceKey(seq) === candKey) return true;
    if (isContiguousSubsequence(candidate.sequence, seq)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Agent spec design (pure, deterministic)
// ---------------------------------------------------------------------------

/** Kebab-case agent name derived from the sequence, made unique within this run. */
function agentNameFor(sequence: readonly PromptType[], taken: Set<string>): string {
  const base = `forge-${sequence.join('-')}-agent`;
  let name = base;
  let suffix = 2;
  while (taken.has(name)) {
    name = `${base}-${suffix}`;
    suffix += 1;
  }
  taken.add(name);
  return name;
}

/** Design the deterministic agent spec (name, purpose, triggers, I/O contracts). */
function designAgentSpec(
  candidate: SequenceCandidate,
  name: string
): ProposedAgentSpec {
  const human = candidate.sequence.join(' → ');
  const purpose =
    `Automate the recurring "${human}" build sequence that FORGE has executed step-by-step in ` +
    `${candidate.buildCount} build(s) (${candidate.totalOccurrences} occurrence(s)). The agent ` +
    `runs the ${candidate.sequence.length} steps as a single governed unit so the executor ` +
    `dispatches one prompt instead of ${candidate.sequence.length}.`;

  const triggerConditions: JsonObject = {
    type: 'prompt_sequence',
    sequence: [...candidate.sequence],
    min_builds: candidate.buildCount,
    observed_occurrences: candidate.totalOccurrences,
    description: `Activate when the upcoming queue prompts match the ordered types: ${human}.`,
  };

  const inputContract: JsonObject = {
    description:
      'The contiguous queue entries whose prompt_type matches the trigger sequence, plus the ' +
      'governance excerpts and stack fingerprint the assembler would inject for each.',
    fields: {
      entries: `QueueEntry[] of length ${candidate.sequence.length} (types: ${human})`,
      stackFingerprint: 'JsonObject — the build stack fingerprint',
      governanceDocs: 'Record<string,string> — referenced governance documents',
      previousSentinel: 'PreviousSentinelStatus | null — health of the prior prompt',
    },
  };

  const outputContract: JsonObject = {
    description:
      'The artifacts produced for the whole sequence, returned in one result so the executor ' +
      'can branch/commit/Sentinel-check it like a single prompt.',
    fields: {
      filesCreated: 'string[] — files written across the sequence',
      filesModified: 'string[] — files changed across the sequence',
      success: 'boolean — whether every step completed',
      stepResults: `Array<{ promptType: string; success: boolean }> (length ${candidate.sequence.length})`,
    },
  };

  return { name, purpose, triggerConditions, inputContract, outputContract };
}

// ---------------------------------------------------------------------------
// Code generation (Claude API — injectable; guarded → deterministic skeleton)
// ---------------------------------------------------------------------------

/** The system prompt that drives the agent implementation generation (step 2b). */
function buildCodeSystemPrompt(): string {
  return [
    'You are FORGE Phase 5, the Agent Creator inside an autonomous software factory.',
    'You generate a SINGLE self-contained TypeScript module that implements one autonomous agent.',
    'The agent automates a recurring multi-step build sequence so the FORGE executor can run it as',
    'one governed unit instead of dispatching each prompt by hand.',
    '',
    'Requirements for the code you generate:',
    '- TypeScript, strict-mode clean, ESM (NodeNext) — import any in-repo modules with `.js`',
    '  specifiers. Prefer zero new dependencies (node builtins + the supplied contracts only).',
    '- Export a single async entry point that takes the input contract and returns the output',
    '  contract. Keep it pure where possible and NEVER throw — report failures in the result',
    '  (Iron Law 3, the FORGE house style).',
    '- Honor the agent\'s trigger/input/output contracts exactly. Do NOT modify governance files',
    '  and do NOT auto-deploy — this agent is a PROPOSAL pending human approval (Contract 17).',
    '- No placeholder/mock data; reference the real step types in the sequence.',
    '',
    'OUTPUT FORMAT — respond with a SINGLE JSON object and nothing else (no prose, no code',
    'fences). The schema is:',
    '{',
    '  "code": "<the full TypeScript module source as a string>",',
    '  "summary": "<one-sentence description of what the module does>"',
    '}',
  ].join('\n');
}

/** The user message: the designed spec + the evidence behind it. */
function buildCodeUserPrompt(spec: ProposedAgentSpec, candidate: SequenceCandidate): string {
  return [
    `# Agent to implement: ${spec.name}`,
    '',
    `## Purpose`,
    spec.purpose,
    '',
    `## Recurring sequence (the trigger)`,
    `- ordered prompt types: ${candidate.sequence.join(' → ')}`,
    `- observed in ${candidate.buildCount} build(s), ${candidate.totalOccurrences} occurrence(s)`,
    '',
    `## Input contract`,
    JSON.stringify(spec.inputContract, null, 2),
    '',
    `## Output contract`,
    JSON.stringify(spec.outputContract, null, 2),
    '',
    'Now produce the JSON object described in your instructions.',
  ].join('\n');
}

/** Extract the outermost `{ … }` JSON object from a model response, if any. */
function extractJsonObject(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const haystack = fenced && fenced[1] !== undefined ? fenced[1] : text;
  const start = haystack.indexOf('{');
  const end = haystack.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return haystack.slice(start, end + 1);
}

/** Parse the model response into the generated code, or null when it isn't the JSON contract. */
function parseGeneratedCode(text: string): string | null {
  const json = extractJsonObject(text);
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const code = typeof parsed['code'] === 'string' ? (parsed['code'] as string) : '';
    return code.trim() !== '' ? code : null;
  } catch {
    return null;
  }
}

/**
 * Deterministic skeleton implementation, used when the model is unreachable or returns non-JSON.
 * It is a clearly-marked, compilable STUB for a human to complete — never a substitute for the
 * model-generated module (mirrors the phase1a/1b fallback discipline).
 */
function buildSkeletonCode(spec: ProposedAgentSpec, candidate: SequenceCandidate): string {
  const steps = candidate.sequence
    .map((t, i) => `  // Step ${i + 1}: ${t}`)
    .join('\n');
  return [
    `/**`,
    ` * FORGE self-created agent: ${spec.name} (PROPOSED — awaiting human approval, Contract 17).`,
    ` *`,
    ` * ${spec.purpose}`,
    ` *`,
    ` * NOTE: this is a DETERMINISTIC SKELETON generated by the Agent Creator because the model`,
    ` * call was unavailable. A human must complete it before approval.`,
    ` */`,
    ``,
    `export interface ${pascal(spec.name)}Input {`,
    `  entries: unknown[]; // QueueEntry[] of types: ${candidate.sequence.join(' → ')}`,
    `  stackFingerprint: Record<string, unknown>;`,
    `  governanceDocs: Record<string, string>;`,
    `  previousSentinel: unknown | null;`,
    `}`,
    ``,
    `export interface ${pascal(spec.name)}Result {`,
    `  filesCreated: string[];`,
    `  filesModified: string[];`,
    `  success: boolean;`,
    `  stepResults: Array<{ promptType: string; success: boolean }>;`,
    `}`,
    ``,
    `/** Run the "${candidate.sequence.join(' → ')}" sequence as one governed unit. Never throws. */`,
    `export async function run(input: ${pascal(spec.name)}Input): Promise<${pascal(spec.name)}Result> {`,
    `  const stepResults: Array<{ promptType: string; success: boolean }> = [];`,
    steps,
    `  // TODO(human): implement each step against the real collaborators before approval.`,
    `  void input;`,
    `  return { filesCreated: [], filesModified: [], success: false, stepResults };`,
    `}`,
    ``,
    `export default run;`,
  ].join('\n');
}

/** PascalCase a kebab-case agent name for generated identifiers. */
function pascal(name: string): string {
  return name
    .split(/[^a-z0-9]+/i)
    .filter((p) => p !== '')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/** Generate the implementation: try the model (guarded), else the deterministic skeleton. */
async function generateImplementation(
  spec: ProposedAgentSpec,
  candidate: SequenceCandidate,
  callModel: CallModel,
  model: string,
  apiKey: string,
  maxTokens: number,
  log: (message: string) => void,
  warnings: string[]
): Promise<{ code: string; usedFallback: boolean }> {
  try {
    const response = await callModel({
      model,
      maxTokens,
      system: buildCodeSystemPrompt(),
      user: buildCodeUserPrompt(spec, candidate),
      apiKey,
    });
    const code = parseGeneratedCode(response.text);
    if (code !== null) return { code, usedFallback: false };
    warnings.push(`Model output for "${spec.name}" was not the JSON contract; used a skeleton.`);
    log(`WARNING: model output for ${spec.name} not parseable — using skeleton`);
  } catch (error) {
    const reason = describe(error);
    warnings.push(`Model call for "${spec.name}" failed (${reason}); used a skeleton.`);
    log(`WARNING: model call for ${spec.name} failed (${reason}) — using skeleton`);
  }
  return { code: buildSkeletonCode(spec, candidate), usedFallback: true };
}

// ---------------------------------------------------------------------------
// Historical replay test (pure, deterministic) — step 2c
// ---------------------------------------------------------------------------

/** Static checks over the generated implementation code. */
function checkCode(code: string, spec: ProposedAgentSpec, candidate: SequenceCandidate): AgentCodeChecks {
  const nonEmpty = code.trim() !== '';
  const exportsEntryPoint = /\bexport\b/.test(code);
  const referencesContract =
    code.includes(spec.name) || candidate.sequence.some((t) => code.includes(t));
  return { nonEmpty, exportsEntryPoint, referencesContract };
}

/**
 * Replay the sequence against the historical executions: for every build containing the
 * sequence, find the matched contiguous occurrences and measure how reliably those steps
 * completed (executed-prompt success rate). DETERMINISTIC — no code is run.
 */
function replayTest(
  candidate: SequenceCandidate,
  buildSequences: Map<string, PromptType[]>,
  executionsByBuild: Map<string, PromptExecution[]>,
  code: string,
  spec: ProposedAgentSpec,
  minBuilds: number
): AgentTestResult {
  let matchedPrompts = 0;
  let executed = 0;
  let succeeded = 0;
  const len = candidate.sequence.length;

  for (const buildId of candidate.buildIds) {
    const types = buildSequences.get(buildId);
    const execs = executionsByBuild.get(buildId);
    if (!types || !execs) continue;
    for (let start = 0; start + len <= types.length; start++) {
      let matches = true;
      for (let j = 0; j < len; j++) {
        if (types[start + j] !== candidate.sequence[j]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      for (let j = 0; j < len; j++) {
        const ex = execs[start + j];
        if (!ex) continue;
        matchedPrompts += 1;
        if (EXECUTED_STATUSES.has(ex.status)) {
          executed += 1;
          if (ex.status === 'completed') succeeded += 1;
        }
      }
    }
  }

  const codeChecks = checkCode(code, spec, candidate);
  const historicalSuccessRate = executed > 0 ? round(succeeded / executed) : null;
  const codeOk = codeChecks.nonEmpty && codeChecks.exportsEntryPoint && codeChecks.referencesContract;
  const thresholdMet = candidate.buildCount >= minBuilds;
  const passed = codeOk && thresholdMet;

  const notes: string[] = [];
  notes.push(
    `Replayed across ${candidate.buildIds.length} build(s); ${candidate.totalOccurrences} ` +
      `occurrence(s), ${matchedPrompts} matched prompt(s).`
  );
  notes.push(
    historicalSuccessRate === null
      ? 'No matched prompts had a terminal (executed) status — success rate unknown.'
      : `Historical step success rate: ${historicalSuccessRate}.`
  );
  if (!codeChecks.nonEmpty) notes.push('FAIL: generated code is empty.');
  if (!codeChecks.exportsEntryPoint) notes.push('FAIL: generated code exports no entry point.');
  if (!codeChecks.referencesContract) notes.push('FAIL: generated code does not reference the contract.');
  if (!thresholdMet) notes.push(`FAIL: appears in ${candidate.buildCount} build(s) (< ${minBuilds}).`);
  if (passed) notes.push('PASS: static checks + build-threshold met (Contract 17c).');

  return {
    replayedBuilds: candidate.buildIds.length,
    sequenceOccurrences: candidate.totalOccurrences,
    matchedPrompts,
    historicalSuccessRate,
    codeChecks,
    passed,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Impact projection + proposal document (pure)
// ---------------------------------------------------------------------------

/** Project the impact of adopting the agent on future builds. */
function projectImpact(candidate: SequenceCandidate, buildsAnalyzed: number): AgentImpactProjection {
  const promptsSavedEstimate = candidate.totalOccurrences * (candidate.sequence.length - 1);
  return {
    buildsAffected: candidate.buildCount,
    occurrences: candidate.totalOccurrences,
    buildCoverage: buildsAnalyzed > 0 ? round(candidate.buildCount / buildsAnalyzed) : 0,
    promptsSavedEstimate,
  };
}

/** Render the human-readable proposal document (s6-p03 step 3). */
function buildProposalDocument(
  spec: ProposedAgentSpec,
  candidate: SequenceCandidate,
  code: string,
  usedFallback: boolean,
  test: AgentTestResult,
  impact: AgentImpactProjection
): string {
  const lines: string[] = [];
  lines.push(`# Proposed Agent: ${spec.name}`);
  lines.push('');
  lines.push('> Status: **proposed** — requires human approval before activation (Contract 17 / Canonical Rule 3).');
  if (usedFallback) {
    lines.push('>');
    lines.push('> ⚠️ Implementation is a DETERMINISTIC SKELETON (model was unavailable) — complete it before approval.');
  }
  lines.push('');
  lines.push('## Purpose');
  lines.push(spec.purpose);
  lines.push('');
  lines.push('## Trigger');
  lines.push(`- Recurring sequence: \`${candidate.sequence.join(' → ')}\``);
  lines.push(`- Observed in **${candidate.buildCount}** build(s), **${candidate.totalOccurrences}** occurrence(s).`);
  lines.push('');
  lines.push('## Test Results (historical replay)');
  lines.push(`- Eligible to store: **${test.passed ? 'yes' : 'no'}**`);
  lines.push(`- Replayed builds: ${test.replayedBuilds}; matched prompts: ${test.matchedPrompts}`);
  lines.push(
    `- Historical step success rate: ${test.historicalSuccessRate === null ? 'n/a' : test.historicalSuccessRate}`
  );
  lines.push(
    `- Code checks: nonEmpty=${test.codeChecks.nonEmpty}, exportsEntryPoint=${test.codeChecks.exportsEntryPoint}, ` +
      `referencesContract=${test.codeChecks.referencesContract}`
  );
  for (const note of test.notes) lines.push(`  - ${note}`);
  lines.push('');
  lines.push('## Projected Impact on Future Builds');
  lines.push(`- Builds affected: ${impact.buildsAffected} (coverage ${impact.buildCoverage})`);
  lines.push(`- Estimated prompts saved across history: ~${impact.promptsSavedEstimate}`);
  lines.push('');
  lines.push('## Implementation Code');
  lines.push('```typescript');
  lines.push(code);
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Pure analysis entry point (no I/O except the injected model caller)
// ---------------------------------------------------------------------------

/** Resolved options for {@link analyzeAgentOpportunities} (thresholds + model + logger). */
export interface AnalyzeAgentOptions {
  /** Approved queue entries for exact `prompt_name → prompt_type` mapping (else classified). */
  entries?: QueueEntry[];
  minBuilds: number;
  minSequenceLength: number;
  maxSequenceLength: number;
  callModel: CallModel;
  model: string;
  apiKey: string;
  maxTokens: number;
  log: (message: string) => void;
}

/**
 * Mine recurring sequences, design + (model-)generate + replay-test an agent for each maximal,
 * un-handled, qualifying candidate, and assemble the {@link AgentCreatorReport}. The only I/O is
 * the injected `callModel` (guarded → deterministic skeleton); everything else is pure.
 */
export async function analyzeAgentOpportunities(
  builds: BuildRun[],
  executions: PromptExecution[],
  existingAgents: SelfCreatedAgent[],
  options: AnalyzeAgentOptions,
  warnings: string[] = []
): Promise<AgentCreatorReport> {
  // Recover prompt_type per execution (exact from the queue, else classified — Iron Law 3).
  const nameToType = new Map<string, PromptType>();
  if (options.entries) for (const e of options.entries) nameToType.set(e.name, e.prompt_type);
  const typeOf = (ex: PromptExecution): PromptType =>
    nameToType.get(ex.prompt_name) ?? classifyPromptType(ex.prompt_name);

  const executionsByBuild = groupByBuild(executions);
  const buildSequences = new Map<string, PromptType[]>();
  for (const [buildId, list] of executionsByBuild) {
    const types = list.filter((ex) => ORDERED_STATUSES.has(ex.status)).map(typeOf);
    buildSequences.set(buildId, types);
  }

  if (executions.length === 0) {
    warnings.push('No prompt_executions to analyze — no agent opportunities can be mined (Contract 4).');
  }

  const mined = mineSequences(
    buildSequences,
    options.minSequenceLength,
    options.maxSequenceLength,
    options.minBuilds
  );
  const maximal = selectMaximal(mined);
  // Sort the surfaced candidates most-impactful first (build count, then length, then occurrences).
  maximal.sort(
    (a, b) =>
      b.buildCount - a.buildCount ||
      b.sequence.length - a.sequence.length ||
      b.totalOccurrences - a.totalOccurrences ||
      sequenceKey(a.sequence).localeCompare(sequenceKey(b.sequence))
  );

  const proposals: AgentProposal[] = [];
  const takenNames = new Set<string>(existingAgents.map((a) => a.name));

  for (const candidate of maximal) {
    if (isHandledByExisting(candidate, existingAgents)) {
      options.log(`skip ${sequenceKey(candidate.sequence)} — already handled by an existing agent`);
      continue;
    }
    const name = agentNameFor(candidate.sequence, takenNames);
    const spec = designAgentSpec(candidate, name);
    const { code, usedFallback } = await generateImplementation(
      spec,
      candidate,
      options.callModel,
      options.model,
      options.apiKey,
      options.maxTokens,
      options.log,
      warnings
    );
    const test = replayTest(
      candidate,
      buildSequences,
      executionsByBuild,
      code,
      spec,
      options.minBuilds
    );
    const impact = projectImpact(candidate, builds.length);
    const sourcePatternDescription =
      `Recurring "${candidate.sequence.join(' → ')}" sequence in ${candidate.buildCount} build(s) ` +
      `(${candidate.totalOccurrences} occurrence(s)) with no dedicated handler.`;
    const proposalDocument = buildProposalDocument(spec, candidate, code, usedFallback, test, impact);

    proposals.push({
      spec,
      candidate,
      implementationCode: code,
      usedFallback,
      sourcePatternDescription,
      test,
      impact,
      proposalDocument,
      eligible: test.passed,
    });
  }

  return {
    buildsAnalyzed: builds.length,
    promptsAnalyzed: executions.length,
    existingAgents: existingAgents.length,
    candidates: maximal,
    proposals,
    warnings,
    generatedAt: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Build Memory persistence
// ---------------------------------------------------------------------------

/**
 * Persist each ELIGIBLE proposal as a `self_created_agents` row (status defaults to 'proposed' —
 * Contract 17, never approved/activated here). Failing proposals are reported but not stored.
 * Guarded → stateless degrade (Contract 4); never throws.
 */
async function storeProposals(
  report: AgentCreatorReport,
  createAgent: (input: NewSelfCreatedAgent) => Promise<SelfCreatedAgent | null>,
  log: (message: string) => void
): Promise<AgentStorageResult> {
  const result: AgentStorageResult = { agentsStored: 0, stateless: false, warnings: [] };
  const eligible = report.proposals.filter((p) => p.eligible);
  let reachedMemory = false;

  for (const proposal of eligible) {
    try {
      const created = await createAgent({
        name: proposal.spec.name,
        purpose: proposal.spec.purpose,
        trigger_conditions: proposal.spec.triggerConditions,
        input_contract: proposal.spec.inputContract,
        output_contract: proposal.spec.outputContract,
        implementation_code: proposal.implementationCode,
        source_pattern_description: proposal.sourcePatternDescription,
        test_results: jsonClone({
          replayedBuilds: proposal.test.replayedBuilds,
          sequenceOccurrences: proposal.test.sequenceOccurrences,
          matchedPrompts: proposal.test.matchedPrompts,
          historicalSuccessRate: proposal.test.historicalSuccessRate,
          codeChecks: proposal.test.codeChecks,
          passed: proposal.test.passed,
          notes: proposal.test.notes,
          usedFallback: proposal.usedFallback,
          impact: proposal.impact,
        }),
      });
      if (created) {
        reachedMemory = true;
        result.agentsStored += 1;
      }
    } catch (error) {
      result.warnings.push(`agent "${proposal.spec.name}" not stored (${describe(error)}).`);
    }
  }

  if (eligible.length > 0 && !reachedMemory) {
    result.stateless = true;
    result.warnings.push(
      'Build Memory unreachable — agent proposals generated but not persisted (stateless mode, Contract 4).'
    );
    log('WARNING: Build Memory unreachable — agent proposals not persisted (stateless mode).');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Defaults (Build Memory reads — degrade to [] per Contract 4)
// ---------------------------------------------------------------------------

function defaultFetchBuilds(limit: number): () => Promise<BuildRun[]> {
  return async () => (await BuildMemory.builds.listBuilds(limit)) ?? [];
}

async function defaultFetchExecutions(builds: BuildRun[]): Promise<PromptExecution[]> {
  const all: PromptExecution[] = [];
  for (const b of builds) {
    const rows = await BuildMemory.prompts.getPromptsByBuild(b.id);
    if (rows) all.push(...rows);
  }
  return all;
}

async function defaultFetchAgents(): Promise<SelfCreatedAgent[]> {
  return (await BuildMemory.agents.listAgents()) ?? [];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Mine recurring multi-step sequences across builds and propose a self-created agent for each
 * qualifying, un-handled pattern (queue.yaml s6-p03). Loads builds + executions + existing agents
 * (unless supplied), designs + (model-)generates + replay-tests an agent per maximal candidate,
 * and stores the PASSING proposals as `self_created_agents` rows with status 'proposed' (unless
 * `store:false`).
 *
 * Always resolves (never rejects): the model call is guarded (degrades to a deterministic
 * skeleton) and every Build Memory read/write is guarded and degrades to stateless (Contract 4).
 * NEVER approves or activates an agent (Contract 17 / Canonical Rule 3).
 */
export async function createAgents(
  input: CreateAgentsInput = {},
  options: AgentCreatorOptions = {}
): Promise<AgentCreationResult> {
  const log = options.log ?? logLine('agent-creator');
  const store = options.store ?? true;
  const minBuilds = options.minBuilds ?? DEFAULT_MIN_BUILDS;
  const minSequenceLength = options.minSequenceLength ?? MIN_SEQUENCE_LENGTH;
  const maxSequenceLength = options.maxSequenceLength ?? MAX_SEQUENCE_LENGTH;
  const buildScanLimit = options.buildScanLimit ?? 500;
  const model = options.model ?? process.env.FORGE_AGENT_MODEL ?? DEFAULT_MODEL;
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  // Generating a new governed agent's source is high-stakes complex-reasoning work → route
  // through the Provider Router (Claude primary, with failover/cost/free-tier handling). An
  // explicit `options.callModel` still overrides routing.
  const callModel = options.callModel ?? providerCallModel('complex_reasoning');
  const fetchBuilds = options.fetchBuilds ?? defaultFetchBuilds(buildScanLimit);
  const fetchExecutions = options.fetchExecutions ?? defaultFetchExecutions;
  const fetchAgents = options.fetchAgents ?? defaultFetchAgents;
  const createAgent =
    options.createAgent ?? ((i: NewSelfCreatedAgent) => BuildMemory.agents.createAgent(i));

  const warnings: string[] = [];

  // 1. Resolve builds (guarded).
  let builds: BuildRun[] = input.builds ?? [];
  if (input.builds === undefined) {
    try {
      builds = await fetchBuilds();
    } catch (error) {
      warnings.push(`Could not load build_runs (${describe(error)}).`);
      log(`WARNING: fetchBuilds degraded (${describe(error)})`);
      builds = [];
    }
  }

  // 2. Resolve executions (guarded).
  let executions: PromptExecution[] = input.executions ?? [];
  if (input.executions === undefined) {
    try {
      executions = await fetchExecutions(builds);
    } catch (error) {
      warnings.push(`Could not load prompt_executions (${describe(error)}).`);
      log(`WARNING: fetchExecutions degraded (${describe(error)})`);
      executions = [];
    }
  }

  // 3. Resolve existing agents (guarded).
  let existingAgents: SelfCreatedAgent[] = input.existingAgents ?? [];
  if (input.existingAgents === undefined) {
    try {
      existingAgents = await fetchAgents();
    } catch (error) {
      warnings.push(`Could not load self_created_agents (${describe(error)}).`);
      log(`WARNING: fetchAgents degraded (${describe(error)})`);
      existingAgents = [];
    }
  }

  log(
    `mining ${executions.length} execution(s) across ${builds.length} build(s) ` +
      `(min ${minBuilds} build(s), sequence length ${minSequenceLength}–${maxSequenceLength}); ` +
      `${existingAgents.length} existing agent(s)`
  );

  // 4. Pure analysis (+ guarded model calls).
  const analysisOptions: AnalyzeAgentOptions = {
    minBuilds,
    minSequenceLength,
    maxSequenceLength,
    callModel,
    model,
    apiKey,
    maxTokens,
    log,
  };
  if (input.entries !== undefined) analysisOptions.entries = input.entries;
  const report = await analyzeAgentOpportunities(
    builds,
    executions,
    existingAgents,
    analysisOptions,
    warnings
  );
  log(
    `found ${report.candidates.length} recurring sequence(s) → ${report.proposals.length} proposal(s) ` +
      `(${report.proposals.filter((p) => p.eligible).length} eligible to store).`
  );

  // 5. Persist eligible proposals (unless disabled).
  let storage: AgentStorageResult;
  if (store) {
    storage = await storeProposals(report, createAgent, log);
    log(
      `stored ${storage.agentsStored} agent proposal(s)` +
        `${storage.stateless ? ' (STATELESS — nothing persisted)' : ''}.`
    );
  } else {
    storage = { agentsStored: 0, stateless: false, warnings: [] };
  }

  return { report, storage };
}

export default createAgents;
