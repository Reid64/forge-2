/**
 * FORGE 2.0 — Phase 5: Recursive Learner (orchestrator, queue.yaml s6-p03).
 *
 * Phase 5 is the LAST phase of a build and the engine of FORGE's self-improvement: after a build
 * completes, it reads everything the build recorded and turns it into reusable intelligence —
 * error/timing/success/cost patterns, governance-template improvement proposals, and brand-new
 * self-created agents — so every future build starts smarter (BLUEPRINT Phase 5; PRD F9).
 *
 * This module is the THIN ORCHESTRATOR that runs the Phase 5 sequence in order; the heavy lifting
 * lives in the three `src/analysis/` modules it composes. Per queue.yaml s6-p03 the sequence is:
 *   1. Pattern Extractor (s6-p01) on the completed build — distil its prompt_executions into the
 *      four pattern dimensions and persist error_patterns + cross_project_insights (Contract 15).
 *   2. Template Evolver (s6-p02) — read ACROSS builds and propose evidence-backed governance
 *      improvements (Contract 16), each stored as a `recursive_learner` governance_versions row.
 *   3. Agent Creator (s6-p03) — mine recurring multi-step sequences and propose self-created
 *      agents for un-handled ones (Contract 17), each stored 'proposed' pending human approval.
 *   4. Generate a Phase-5 SYNTHESIS cross_project_insight tagged with the build's stack
 *      fingerprint(s) — the headline learnings of this build, made transferable to similar stacks
 *      (this is distinct from the per-dimension insights the Pattern Extractor writes in step 1).
 *   5. Produce a human-readable Phase 5 SUMMARY REPORT consolidating all of the above.
 *
 * GOVERNANCE: Phase 5 only ever PROPOSES. It NEVER modifies a governance file (Iron Law 1 /
 * Contract 3), NEVER approves or activates a self-created agent (Contract 17 / Canonical Rule 3),
 * and NEVER promotes a template proposal — those are human gates. It reads Build Memory and writes
 * only the learning tables (error_patterns, cross_project_insights, governance_versions proposals,
 * self_created_agents proposals) through the three analysis modules + one synthesis insight here.
 *
 * NON-FATAL house style (Contract 4): each step is GUARDED so a failure in one (a model outage in
 * the Agent Creator, a DB blip mid-extraction) degrades to an empty result + a warning rather than
 * aborting the whole pass — a build's learning is best-effort, never a halting concern (mirrors
 * BEHAVIORAL_CONTRACTS' "Failure to write to Build Memory is NOT a halting error"). Every
 * collaborator is injectable for tests. `runPhase5Learner` never rejects.
 *
 * BOUNDARY: reads build_runs + the learning tables; writes only the learning tables (via the
 * analysis modules + one synthesis insight). Optionally writes a Phase 5 report FILE when
 * `writeReport` is set; otherwise it only returns the report string. Touches no governance file
 * and no target project source.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  extractPatterns,
  type ExtractPatternsInput,
  type PatternExtractionResult,
} from '../analysis/pattern-extractor.js';
import {
  evolveTemplates,
  type EvolveTemplatesInput,
  type TemplateEvolverOptions,
  type TemplateEvolutionResult,
} from '../analysis/template-evolver.js';
import {
  createAgents,
  type CreateAgentsInput,
  type AgentCreatorOptions,
  type AgentCreationResult,
} from '../analysis/agent-creator.js';
import type { PatternExtractorOptions } from '../analysis/pattern-extractor.js';
import type { QueueEntry } from '../engine/queue-generator.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import { logLine } from '../tools/forge-logger.js';
import type { NewCrossProjectInsight } from '../memory/insights.js';
import type { BuildRun, CrossProjectInsight, JsonObject } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The Phase-5 synthesis insight generated in step 4. */
export interface SynthesisInsight {
  /** True when the insight was persisted to Build Memory. */
  stored: boolean;
  description: string;
  /** Stack fingerprints the insight is tagged applicable to. */
  applicableFingerprints: JsonObject[];
}

/** The complete result of {@link runPhase5Learner}. */
export interface Phase5Result {
  buildRunId: string;
  projectName: string;
  stackFingerprint: JsonObject;
  /** Step 1 — Pattern Extractor result (patterns + what got persisted). */
  patterns: PatternExtractionResult;
  /** Step 2 — Template Evolver result (proposals + what got persisted). */
  templates: TemplateEvolutionResult;
  /** Step 3 — Agent Creator result (proposals + what got persisted). */
  agents: AgentCreationResult;
  /** Step 4 — the synthesis cross_project_insight. */
  synthesis: SynthesisInsight;
  /** Step 5 — the human-readable Phase 5 summary report (Markdown). */
  summaryReport: string;
  /** Absolute path the report was written to, or null when `writeReport` was off / it failed. */
  reportPath: string | null;
  /** Non-fatal observations aggregated across all five steps. */
  warnings: string[];
  generatedAt: string;
}

/** Options for {@link runPhase5Learner} — store toggles, model, report writing + injectable I/O. */
export interface Phase5Options {
  /** The build_runs row (else fetched from Build Memory). */
  build?: BuildRun | null;
  /** Project name override (else the build's `project_name`). */
  projectName?: string;
  /** Stack fingerprint override (else the build's `stack_fingerprint`). */
  stackFingerprint?: JsonObject;
  /** The approved queue entries, threaded to the analyses for exact prompt-type mapping. */
  entries?: QueueEntry[];
  /** Persist all proposals/insights to Build Memory. Default true (false = pure analysis). */
  store?: boolean;
  /** Model id passed to the Agent Creator's code generation. Default: its own default. */
  model?: string;
  /** Anthropic API key passed to the Agent Creator. Default: `ANTHROPIC_API_KEY` env. */
  apiKey?: string;
  /** Write the Phase 5 report to disk. Default false (the report string is always returned). */
  writeReport?: boolean;
  /** Directory for the report file (created if missing). Default 'reports'. */
  reportsDir?: string;
  /** Fetch the build_run. Default `BuildMemory.builds.getBuild`. */
  fetchBuild?: (id: string) => Promise<BuildRun | null>;
  /** Run the Pattern Extractor. Default {@link extractPatterns}. */
  runPatternExtractor?: (
    input: ExtractPatternsInput,
    options?: PatternExtractorOptions
  ) => Promise<PatternExtractionResult>;
  /** Run the Template Evolver. Default {@link evolveTemplates}. */
  runTemplateEvolver?: (
    input?: EvolveTemplatesInput,
    options?: TemplateEvolverOptions
  ) => Promise<TemplateEvolutionResult>;
  /** Run the Agent Creator. Default {@link createAgents}. */
  runAgentCreator?: (
    input?: CreateAgentsInput,
    options?: AgentCreatorOptions
  ) => Promise<AgentCreationResult>;
  /** Create the synthesis cross_project_insight. Default `BuildMemory.insights.createInsight`. */
  createInsight?: (input: NewCrossProjectInsight) => Promise<CrossProjectInsight | null>;
  /** Progress reporter. Default logs to the console with a `[FORGE:phase5]` prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/** Render an unknown thrown value as a short string for logging. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Cast an arbitrary serializable value to a Build-Memory `jsonb` object (deep-cloned). */
function jsonClone(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/** Empty (degraded) Pattern Extractor result for the guarded-failure path. */
function emptyPatterns(input: ExtractPatternsInput): PatternExtractionResult {
  return {
    patterns: {
      buildRunId: input.buildRunId,
      projectName: input.projectName ?? 'unknown',
      stackFingerprint: input.stackFingerprint ?? {},
      analyzedPrompts: 0,
      error_patterns: [],
      timing_patterns: [],
      success_patterns: [],
      cost_patterns: [],
      governance_correlations: [],
      build_cost: {
        totalTokens: 0,
        totalCostUsd: 0,
        complexity: { tableCount: null, featureCount: 0, apiCount: 0, promptCount: 0 },
        costPerTable: null,
        costPerFeature: null,
      },
      warnings: [],
      generatedAt: nowIso(),
    },
    storage: {
      errorPatternsCreated: 0,
      errorPatternsUpdated: 0,
      insightsCreated: 0,
      stateless: false,
      warnings: [],
    },
  };
}

/** Empty (degraded) Template Evolver result for the guarded-failure path. */
function emptyTemplates(): TemplateEvolutionResult {
  return {
    report: {
      templatesAnalyzed: 0,
      versionsAnalyzed: 0,
      buildsAnalyzed: 0,
      promptsAnalyzed: 0,
      trends: [],
      references: [],
      correlation: {
        terminalBuilds: 0,
        completedBuilds: 0,
        buildSuccessRate: null,
        promptSuccessRate: null,
        effectivenessAdoptionCorrelation: null,
      },
      proposals: [],
      warnings: [],
      generatedAt: nowIso(),
    },
    storage: { proposalsStored: 0, stateless: false, warnings: [] },
  };
}

/** Empty (degraded) Agent Creator result for the guarded-failure path. */
function emptyAgents(): AgentCreationResult {
  return {
    report: {
      buildsAnalyzed: 0,
      promptsAnalyzed: 0,
      existingAgents: 0,
      candidates: [],
      proposals: [],
      warnings: [],
      generatedAt: nowIso(),
    },
    storage: { agentsStored: 0, stateless: false, warnings: [] },
  };
}

/** Build the synthesis-insight description + evidence from the three step results. */
function buildSynthesisEvidence(
  patterns: PatternExtractionResult,
  templates: TemplateEvolutionResult,
  agents: AgentCreationResult
): { description: string; evidence: JsonObject } {
  const p = patterns.patterns;
  const topErrors = p.error_patterns.slice(0, 5).map((e) => ({
    signature: e.errorSignature,
    category: e.errorCategory,
    occurrences: e.occurrenceCount,
  }));
  const bestPromptType = p.success_patterns.find((s) => s.successRate !== null) ?? null;
  const description =
    `Phase 5 synthesis for ${p.projectName}: ${p.analyzedPrompts} prompt(s) analyzed → ` +
    `${p.error_patterns.length} error pattern(s), ` +
    `${templates.report.proposals.length} governance proposal(s), ` +
    `${agents.report.proposals.length} agent proposal(s) ` +
    `(${agents.report.proposals.filter((a) => a.eligible).length} eligible). ` +
    `Build cost ≈ $${p.build_cost.totalCostUsd} over ${p.build_cost.totalTokens} token(s).`;
  const evidence: JsonObject = jsonClone({
    analyzedPrompts: p.analyzedPrompts,
    topErrorPatterns: topErrors,
    bestPerformingPromptType: bestPromptType
      ? { promptType: bestPromptType.promptType, successRate: bestPromptType.successRate }
      : null,
    buildCost: p.build_cost,
    governanceProposals: templates.report.proposals.map((g) => ({
      template: g.templateName,
      kind: g.kind,
      expectedImprovement: g.expectedImprovement,
    })),
    agentProposals: agents.report.proposals.map((a) => ({
      name: a.spec.name,
      sequence: a.candidate.sequence,
      eligible: a.eligible,
      buildsAffected: a.impact.buildsAffected,
    })),
  });
  return { description, evidence };
}

/** Assemble the human-readable Phase 5 summary report (step 5). */
function buildSummaryReport(
  buildRunId: string,
  projectName: string,
  patterns: PatternExtractionResult,
  templates: TemplateEvolutionResult,
  agents: AgentCreationResult,
  synthesis: SynthesisInsight,
  warnings: string[],
  generatedAt: string
): string {
  const p = patterns.patterns;
  const lines: string[] = [];
  lines.push(`# FORGE Phase 5 — Recursive Learner Report`);
  lines.push('');
  lines.push(`- Project: **${projectName}**`);
  lines.push(`- Build: \`${buildRunId}\``);
  lines.push(`- Generated: ${generatedAt}`);
  lines.push('');

  lines.push('## 1. Pattern Extraction');
  lines.push(`- Prompts analyzed: ${p.analyzedPrompts}`);
  lines.push(
    `- Error patterns: ${p.error_patterns.length} (stored ${patterns.storage.errorPatternsCreated} new, ` +
      `${patterns.storage.errorPatternsUpdated} updated)`
  );
  lines.push(
    `- Timing/success/cost insights stored: ${patterns.storage.insightsCreated}` +
      `${patterns.storage.stateless ? ' (STATELESS)' : ''}`
  );
  if (p.error_patterns.length > 0) {
    lines.push('- Top error patterns:');
    for (const e of p.error_patterns.slice(0, 5)) {
      lines.push(`  - [${e.errorCategory}] ${e.errorSignature} ×${e.occurrenceCount}`);
    }
  }
  lines.push('');

  lines.push('## 2. Template Evolution');
  lines.push(
    `- Governance proposals: ${templates.report.proposals.length} ` +
      `(stored ${templates.storage.proposalsStored}${templates.storage.stateless ? ', STATELESS' : ''})`
  );
  for (const g of templates.report.proposals.slice(0, 8)) {
    lines.push(
      `  - ${g.templateName} [${g.kind}${g.section ? `: ${g.section}` : ''}] — ` +
        `expected +${g.expectedImprovement}`
    );
  }
  lines.push('');

  lines.push('## 3. Agent Creation');
  lines.push(
    `- Recurring sequences: ${agents.report.candidates.length}; agent proposals: ` +
      `${agents.report.proposals.length} (${agents.report.proposals.filter((a) => a.eligible).length} eligible, ` +
      `stored ${agents.storage.agentsStored}${agents.storage.stateless ? ', STATELESS' : ''})`
  );
  for (const a of agents.report.proposals) {
    lines.push(
      `  - **${a.spec.name}** \`${a.candidate.sequence.join(' → ')}\` — ` +
        `${a.eligible ? 'ELIGIBLE' : 'not eligible'}, ${a.candidate.buildCount} build(s)` +
        `${a.usedFallback ? ' (skeleton)' : ''}`
    );
  }
  lines.push('');

  lines.push('## 4. Cross-Project Synthesis Insight');
  lines.push(`- ${synthesis.stored ? 'Stored' : 'NOT stored'}: ${synthesis.description}`);
  lines.push('');

  if (warnings.length > 0) {
    lines.push('## Warnings');
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  lines.push('## Governance');
  lines.push(
    '- All outputs are PROPOSALS. No governance file was modified (Iron Law 1), no agent was ' +
      'approved/activated (Contract 17), no template was promoted (Contract 16). Human approval ' +
      'gates remain.'
  );
  lines.push('');
  return lines.join('\n');
}

/** Filesystem-safe fragment of an ISO timestamp for the report filename. */
function safeStamp(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the full Phase 5 Recursive Learner sequence over a completed build (queue.yaml s6-p03):
 * pattern extraction → template evolution → agent creation → synthesis insight → summary report.
 *
 * Always resolves (never rejects): each step is guarded and degrades to an empty result + a
 * warning (Contract 4); every collaborator is injectable. Only PROPOSES — never approves an
 * agent, promotes a template, or edits a governance file.
 */
export async function runPhase5Learner(
  buildRunId: string,
  options: Phase5Options = {}
): Promise<Phase5Result> {
  const log = options.log ?? logLine('phase5');
  const store = options.store ?? true;
  const fetchBuild = options.fetchBuild ?? ((id: string) => BuildMemory.builds.getBuild(id));
  const runPatternExtractor = options.runPatternExtractor ?? extractPatterns;
  const runTemplateEvolver = options.runTemplateEvolver ?? evolveTemplates;
  const runAgentCreator = options.runAgentCreator ?? createAgents;
  const createInsight =
    options.createInsight ?? ((i: NewCrossProjectInsight) => BuildMemory.insights.createInsight(i));
  const warnings: string[] = [];

  // 0. Resolve the build (guarded) for project name + stack fingerprint context.
  let build: BuildRun | null = options.build ?? null;
  if (build === null && options.build === undefined) {
    try {
      build = await fetchBuild(buildRunId);
    } catch (error) {
      warnings.push(`Could not load build ${buildRunId} (${describe(error)}).`);
      log(`WARNING: fetchBuild degraded (${describe(error)})`);
    }
  }
  const projectName = options.projectName ?? build?.project_name ?? 'unknown';
  const stackFingerprint: JsonObject =
    options.stackFingerprint ?? build?.stack_fingerprint ?? {};

  log(`Phase 5 starting for build ${buildRunId} (project ${projectName}, store=${store})`);

  // 1. Pattern Extractor on the completed build (guarded).
  const extractInput: ExtractPatternsInput = { buildRunId };
  if (build !== null) extractInput.build = build;
  if (options.entries !== undefined) extractInput.entries = options.entries;
  let patterns: PatternExtractionResult;
  try {
    patterns = await runPatternExtractor(extractInput, { store, log });
  } catch (error) {
    warnings.push(`Pattern Extractor failed (${describe(error)}).`);
    log(`WARNING: pattern extractor degraded (${describe(error)})`);
    patterns = emptyPatterns(extractInput);
  }
  log(`step 1 (patterns): ${patterns.patterns.error_patterns.length} error pattern(s)`);

  // 2. Template Evolver across builds (guarded).
  let templates: TemplateEvolutionResult;
  try {
    templates = await runTemplateEvolver({}, { store, log });
  } catch (error) {
    warnings.push(`Template Evolver failed (${describe(error)}).`);
    log(`WARNING: template evolver degraded (${describe(error)})`);
    templates = emptyTemplates();
  }
  log(`step 2 (templates): ${templates.report.proposals.length} proposal(s)`);

  // 3. Agent Creator across builds (guarded).
  const agentInput: CreateAgentsInput = {};
  if (options.entries !== undefined) agentInput.entries = options.entries;
  const agentOptions: AgentCreatorOptions = { store, log };
  if (options.model !== undefined) agentOptions.model = options.model;
  if (options.apiKey !== undefined) agentOptions.apiKey = options.apiKey;
  let agents: AgentCreationResult;
  try {
    agents = await runAgentCreator(agentInput, agentOptions);
  } catch (error) {
    warnings.push(`Agent Creator failed (${describe(error)}).`);
    log(`WARNING: agent creator degraded (${describe(error)})`);
    agents = emptyAgents();
  }
  log(`step 3 (agents): ${agents.report.proposals.length} proposal(s)`);

  // 4. Generate the Phase-5 synthesis cross_project_insight (guarded).
  const { description, evidence } = buildSynthesisEvidence(patterns, templates, agents);
  const applicableFingerprints: JsonObject[] = [stackFingerprint];
  const synthesis: SynthesisInsight = { stored: false, description, applicableFingerprints };
  if (store) {
    try {
      const created = await createInsight({
        insight_type: 'pattern',
        source_project: projectName,
        source_build_id: buildRunId,
        applicable_fingerprints: applicableFingerprints,
        description,
        evidence,
      });
      synthesis.stored = created !== null;
      if (!created) {
        warnings.push('Synthesis insight not persisted — Build Memory unreachable (stateless, Contract 4).');
      }
    } catch (error) {
      warnings.push(`Synthesis insight not stored (${describe(error)}).`);
      log(`WARNING: createInsight degraded (${describe(error)})`);
    }
  }
  log(`step 4 (synthesis insight): ${synthesis.stored ? 'stored' : 'not stored'}`);

  // 5. Produce the Phase 5 summary report.
  const generatedAt = nowIso();
  const summaryReport = buildSummaryReport(
    buildRunId,
    projectName,
    patterns,
    templates,
    agents,
    synthesis,
    warnings,
    generatedAt
  );

  let reportPath: string | null = null;
  if (options.writeReport) {
    const dir = options.reportsDir ?? 'reports';
    const file = join(dir, `PHASE5_${buildRunId}_${safeStamp(generatedAt)}.md`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(file, summaryReport, 'utf8');
      reportPath = file;
      log(`wrote Phase 5 report → ${file}`);
    } catch (error) {
      warnings.push(`Failed to write Phase 5 report (${describe(error)}).`);
      log(`WARNING: could not write Phase 5 report (${describe(error)})`);
    }
  }

  log(
    `Phase 5 complete: ${patterns.patterns.error_patterns.length} error pattern(s), ` +
      `${templates.report.proposals.length} governance proposal(s), ` +
      `${agents.storage.agentsStored} agent(s) stored.`
  );

  return {
    buildRunId,
    projectName,
    stackFingerprint,
    patterns,
    templates,
    agents,
    synthesis,
    summaryReport,
    reportPath,
    warnings,
    generatedAt,
  };
}

export default runPhase5Learner;
