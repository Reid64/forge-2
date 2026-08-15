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
 *   5. Run instinct extraction on the completed build — derive reusable error→fix rules and
 *      persist them as a 'prevention' cross_project_insights row.
 *   6. Run session-end hook — persist final build metrics (token counts, cost, error counts) to
 *      Supabase via the session lifecycle module.
 *   7. Analyze recurring errors and generate governance rules for any with 3+ occurrences —
 *      each rule is persisted as a 'best_practice' cross_project_insights row.
 *   8. Extract skills from successful workarounds and save as SKILL.md files in the project's
 *      `.forge/skills/` directory.
 *   9. Update cross-project insights with new patterns discovered across steps 5-8.
 *  10. Produce a human-readable Phase 5 SUMMARY REPORT consolidating all of the above.
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

import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { MemoryDb } from '../memory/client.js';
import { createCredentialVault } from '../autonomy/credential-vault.js';
import { createVercelDeployer } from '../autonomy/vercel-deployer.js';
import {
  extractInstincts,
  extractSkills,
} from '../analysis/instinct-extractor.js';
import { emitProposals } from '../learning/build-brain-evolver.js';
import { registerPromoterPhase5Hook, type PromotionResult } from '../learning/evolution-promoter.js';
import type { PendingEvolution } from '../learning/types.js';
import { onSessionEnd } from '../memory/session-hooks.js';
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
import { evaluateDoD, appendDoDFailureBlocker, type DoDResult } from '../governance/definition-of-done.js';
import type { ReadinessTierId } from '../governance/readiness-levels.js';
import type { NewCrossProjectInsight } from '../memory/insights.js';
import type {
  BuildRun,
  CrossProjectInsight,
  JsonObject,
  Instinct,
  SessionMetrics,
  SessionError,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** A governance rule derived from a recurring error pattern (3+ occurrences). */
export interface GovernanceRule {
  errorSignature: string;
  errorCategory: string;
  occurrenceCount: number;
  rule: string;
  stored: boolean;
}

/**
 * Step 12 — Autonomous deployment (Autonomy: VercelDeployer, `src/autonomy/vercel-deployer.ts`).
 * `null` when the deploy step was never attempted (no VERCEL_TOKEN / no vercel.json).
 */
export interface Phase5DeploymentResult {
  attempted: boolean;
  deploymentUrl: string | null;
  deploySucceeded: boolean;
  verifyRan: boolean;
  verifyPassed: boolean;
  verifyRouteCount: number;
}

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
  /** Step 5 — instincts extracted from build errors and resolutions. */
  instincts: Instinct[];
  /** Step 6 — whether the session-end hook ran and persisted metrics. */
  sessionEndRan: boolean;
  /** Step 7 — governance rules generated from errors with 3+ occurrences. */
  governanceRules: GovernanceRule[];
  /** Step 8 — SKILL.md file paths written for successful workarounds. */
  skillFiles: string[];
  /** Step 9 — count of additional cross-project insights created for new patterns. */
  additionalInsights: number;
  /** Step 9.5 — BuildBrainEvolver TEMPLATE proposals emitted from this build's rewrite-effectiveness observations. */
  evolutionProposals: PendingEvolution[];
  /** Step 11 — EvolutionPromoter: pending_evolutions auto-promoted this pass (LEARNING_BLUEPRINT.md § EvolutionPromoter). */
  evolutionPromotions: PromotionResult[];
  /** Step 12 — autonomous Vercel deployment + forge verify, when the project is configured for it. */
  deployment: Phase5DeploymentResult;
  /**
   * Step 13 — machine-verifiable Definition of Done (`src/governance/definition-of-done.ts`)
   * evaluated against `options.targetTier`. `null` when no `targetTier` was supplied (the DoD
   * check is opt-in per build until a `--readiness-target` flag threads a tier in from the CLI).
   */
  dodResult: DoDResult | null;
  /** Step 10 — the human-readable Phase 5 summary report (Markdown). */
  summaryReport: string;
  /** Absolute path the report was written to, or null when `writeReport` was off / it failed. */
  reportPath: string | null;
  /** Non-fatal observations aggregated across all ten steps. */
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
  /** Project path for skill extraction and session-end hook. Default: build.project_path ?? '.' */
  projectPath?: string;
  /** Override SessionMetrics for the session-end hook (default: derived from build + patterns). */
  sessionMetrics?: SessionMetrics;
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
  /** Run instinct extraction. Default {@link extractInstincts}. */
  runInstinctExtractor?: (buildRunId: string, client: MemoryDb) => Promise<Instinct[]>;
  /** Run session-end hook to persist metrics. Default {@link onSessionEnd}. */
  runSessionEndHook?: (
    path: string,
    client: MemoryDb,
    metrics: SessionMetrics
  ) => Promise<void>;
  /** Extract skills from workarounds and write SKILL.md files. Default {@link extractSkills}. */
  runSkillExtractor?: (buildRunId: string, projectPath: string) => Promise<string[]>;
  /**
   * Readiness tier (`src/governance/readiness-levels.ts` › `ReadinessTierId`) to evaluate the
   * Definition of Done against at Phase 5 end (ENGINEERING_COMPLETENESS.md § 60). When omitted,
   * step 13 is skipped entirely — Phase 5 never fabricates a target tier the caller didn't ask for.
   */
  targetTier?: ReadinessTierId;
  /** Run the Definition of Done evaluation. Default {@link evaluateDoD}. */
  runEvaluateDoD?: typeof evaluateDoD;
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

/** Derive a SessionMetrics object from available build and pattern data. */
function deriveSessionMetrics(
  buildRunId: string,
  build: BuildRun | null,
  patterns: PatternExtractionResult,
): SessionMetrics {
  const errorsEncountered: SessionError[] = patterns.patterns.error_patterns.map((ep) => ({
    signature: ep.errorSignature,
    category: ep.errorCategory,
    message: ep.errorMessageSample,
  }));
  const patternsDiscovered = patterns.patterns.error_patterns
    .slice(0, 10)
    .map((ep) => `${ep.errorCategory}: ${ep.errorSignature} (×${ep.occurrenceCount})`);

  const startedAt = build?.started_at ?? null;
  const completedAt = build?.completed_at ?? null;
  let durationMs = 0;
  if (startedAt && completedAt) {
    durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  }

  return {
    buildRunId,
    promptsExecuted: patterns.patterns.analyzedPrompts,
    passCount: build?.completed_prompts ?? patterns.patterns.analyzedPrompts,
    failCount: build?.failed_prompts ?? 0,
    errorsEncountered,
    patternsDiscovered,
    totalTokens: patterns.patterns.build_cost.totalTokens,
    totalCostUsd: patterns.patterns.build_cost.totalCostUsd,
    durationMs,
  };
}

/** Assemble the human-readable Phase 5 summary report (step 10). */
function buildSummaryReport(
  buildRunId: string,
  projectName: string,
  patterns: PatternExtractionResult,
  templates: TemplateEvolutionResult,
  agents: AgentCreationResult,
  synthesis: SynthesisInsight,
  instincts: Instinct[],
  sessionEndRan: boolean,
  governanceRules: GovernanceRule[],
  skillFiles: string[],
  additionalInsights: number,
  evolutionProposals: PendingEvolution[],
  evolutionPromotions: PromotionResult[],
  deployment: Phase5DeploymentResult,
  dodResult: DoDResult | null,
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

  lines.push('## 5. Instinct Extraction');
  lines.push(`- Instincts extracted: ${instincts.length}`);
  if (instincts.length > 0) {
    lines.push('- Top instincts (by confidence):');
    for (const inst of instincts.slice(0, 5)) {
      lines.push(
        `  - [${inst.confidence.toFixed(2)}] ${inst.pattern} → ${inst.fix.slice(0, 80)}`
      );
    }
  }
  lines.push('');

  lines.push('## 6. Session-End Hook');
  lines.push(`- Metrics persisted: ${sessionEndRan ? 'YES' : 'no (stateless or error)'}`);
  lines.push('');

  lines.push('## 7. Governance Rules from Recurring Errors');
  lines.push(`- Rules generated: ${governanceRules.length}`);
  if (governanceRules.length > 0) {
    for (const rule of governanceRules.slice(0, 8)) {
      lines.push(
        `  - [${rule.errorCategory}] ×${rule.occurrenceCount} — ${rule.rule.slice(0, 100)}` +
          `${rule.stored ? ' (stored)' : ' (NOT stored)'}`
      );
    }
  }
  lines.push('');

  lines.push('## 8. Skill Extraction');
  lines.push(`- SKILL.md files written: ${skillFiles.length}`);
  for (const f of skillFiles.slice(0, 10)) {
    lines.push(`  - ${f}`);
  }
  lines.push('');

  lines.push('## 9. Additional Cross-Project Insights');
  lines.push(`- Insights created: ${additionalInsights}`);
  lines.push('');

  lines.push('## 9.5 BuildBrainEvolver — Rewrite Effectiveness');
  lines.push(`- Evolution proposals: ${evolutionProposals.length}`);
  for (const e of evolutionProposals) lines.push(`  - [${e.evolution_type}] ${e.proposed_change}`);
  lines.push('');

  lines.push('## 11. EvolutionPromoter — Auto-Promotions');
  lines.push(`- Evolutions promoted: ${evolutionPromotions.length}`);
  for (const p of evolutionPromotions) {
    lines.push(`  - [${p.evolutionType}] ${p.effectApplied} (confidence ${(p.confidenceAtPromotion * 100).toFixed(0)}%)`);
  }
  lines.push('');

  lines.push('## 12. Autonomous Deployment (VercelDeployer)');
  if (!deployment.attempted) {
    lines.push('- Skipped — no VERCEL_TOKEN (env or credential vault) and/or no vercel.json present.');
  } else {
    lines.push(`- Deploy: ${deployment.deploySucceeded ? 'READY' : 'FAILED'}${deployment.deploymentUrl ? ` — ${deployment.deploymentUrl}` : ''}`);
    lines.push(
      `- forge verify: ${deployment.verifyRan ? (deployment.verifyPassed ? `PASSED (${deployment.verifyRouteCount} route(s))` : `FAILED (${deployment.verifyRouteCount} route(s))`) : 'did not run'}`
    );
  }
  lines.push('');

  lines.push('## 13. Definition of Done');
  if (!dodResult) {
    lines.push('- Skipped — no target readiness tier was supplied for this build.');
  } else {
    lines.push(`- Target tier: **${dodResult.targetTier}** — ${dodResult.passed ? 'PASSED' : 'FAILED'}`);
    for (const check of dodResult.checks) {
      lines.push(`  - [${check.passed ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
    }
  }
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
 * pattern extraction → template evolution → agent creation → synthesis insight →
 * instinct extraction → session-end hook → governance rules → skill extraction →
 * additional insights → summary report.
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
  const runInstinctExtractor = options.runInstinctExtractor ?? extractInstincts;
  const runSessionEndHook = options.runSessionEndHook ?? onSessionEnd;
  const runSkillExtractor = options.runSkillExtractor ?? extractSkills;
  const runEvaluateDoDImpl = options.runEvaluateDoD ?? evaluateDoD;
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
  const projectPath = options.projectPath ?? build?.project_path ?? '.';

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

  // 5. Instinct extraction on the completed build (guarded).
  let instincts: Instinct[] = [];
  try {
    const memoryClient = BuildMemory.getClient();
    if (memoryClient) {
      instincts = await runInstinctExtractor(buildRunId, memoryClient);
    } else {
      warnings.push('Instinct extraction skipped — Build Memory unreachable (stateless, Contract 4).');
    }
  } catch (error) {
    warnings.push(`Instinct extraction failed (${describe(error)}).`);
    log(`WARNING: instinct extractor degraded (${describe(error)})`);
  }
  log(`step 5 (instincts): ${instincts.length} instinct(s)`);

  // 6. Session-end hook — persist final build metrics to Supabase (guarded).
  let sessionEndRan = false;
  if (store) {
    try {
      const memoryClient = BuildMemory.getClient();
      if (memoryClient) {
        const sessionMetrics =
          options.sessionMetrics ?? deriveSessionMetrics(buildRunId, build, patterns);
        await runSessionEndHook(projectPath, memoryClient, sessionMetrics);
        sessionEndRan = true;
      } else {
        warnings.push('Session-end hook skipped — Build Memory unreachable (stateless, Contract 4).');
      }
    } catch (error) {
      warnings.push(`Session-end hook failed (${describe(error)}).`);
      log(`WARNING: session-end hook degraded (${describe(error)})`);
    }
  }
  log(`step 6 (session-end hook): ${sessionEndRan ? 'ran' : 'skipped'}`);

  // 7. Generate governance rules for recurring errors (3+ occurrences) (guarded).
  const governanceRules: GovernanceRule[] = [];
  try {
    const recurringErrors = patterns.patterns.error_patterns.filter(
      (ep) => ep.occurrenceCount >= 3
    );
    for (const ep of recurringErrors) {
      const rule =
        `When '${ep.errorSignature}' occurs in a ${ep.errorCategory} context ` +
        `(seen ${ep.occurrenceCount}× in ${projectName}), apply a targeted fix immediately ` +
        `and add a guard to prevent recurrence in future prompts.`;
      const entry: GovernanceRule = {
        errorSignature: ep.errorSignature,
        errorCategory: ep.errorCategory,
        occurrenceCount: ep.occurrenceCount,
        rule,
        stored: false,
      };
      if (store) {
        try {
          const created = await createInsight({
            insight_type: 'prevention',
            source_project: projectName,
            source_build_id: buildRunId,
            applicable_fingerprints: [stackFingerprint],
            description: `Governance rule for recurring error: ${ep.errorSignature}`,
            evidence: jsonClone({ errorCategory: ep.errorCategory, occurrenceCount: ep.occurrenceCount, rule }),
          });
          entry.stored = created !== null;
        } catch (error) {
          warnings.push(`Governance rule not stored for '${ep.errorSignature}' (${describe(error)}).`);
        }
      }
      governanceRules.push(entry);
    }
  } catch (error) {
    warnings.push(`Governance rule generation failed (${describe(error)}).`);
    log(`WARNING: governance rule generation degraded (${describe(error)})`);
  }
  log(`step 7 (governance rules): ${governanceRules.length} rule(s) from recurring errors`);

  // 8. Extract skills from successful workarounds and write SKILL.md files (guarded).
  let skillFiles: string[] = [];
  try {
    skillFiles = await runSkillExtractor(buildRunId, projectPath);
  } catch (error) {
    warnings.push(`Skill extraction failed (${describe(error)}).`);
    log(`WARNING: skill extractor degraded (${describe(error)})`);
  }
  log(`step 8 (skills): ${skillFiles.length} SKILL.md file(s) written`);

  // 9. Update cross-project insights with new patterns from steps 5-8 (guarded).
  let additionalInsights = 0;
  if (store && (instincts.length > 0 || skillFiles.length > 0 || governanceRules.length > 0)) {
    try {
      const newPatternsDesc =
        `Phase 5 new-learning summary for ${projectName} (build ${buildRunId}): ` +
        `${instincts.length} instinct(s), ${skillFiles.length} skill file(s), ` +
        `${governanceRules.length} governance rule(s) from recurring errors. ` +
        `Session metrics ${sessionEndRan ? 'persisted' : 'not persisted'}.`;
      const created = await createInsight({
        insight_type: 'pattern',
        source_project: projectName,
        source_build_id: buildRunId,
        applicable_fingerprints: [stackFingerprint],
        description: newPatternsDesc,
        evidence: jsonClone({
          instinctCount: instincts.length,
          topInstincts: instincts.slice(0, 5).map((i) => ({
            pattern: i.pattern,
            fix: i.fix,
            confidence: i.confidence,
          })),
          skillFiles,
          governanceRuleCount: governanceRules.length,
          recurringErrorSignatures: governanceRules.map((r) => r.errorSignature),
          sessionEndRan,
        }),
      });
      if (created !== null) {
        additionalInsights += 1;
      } else {
        warnings.push('Additional cross-project insight not persisted — Build Memory unreachable (stateless, Contract 4).');
      }
    } catch (error) {
      warnings.push(`Additional cross-project insight not stored (${describe(error)}).`);
      log(`WARNING: additional insight creation degraded (${describe(error)})`);
    }
  }
  log(`step 9 (additional insights): ${additionalInsights} insight(s) stored`);

  // 9.5. BuildBrainEvolver (LEARNING_BLUEPRINT.md § Agent: BuildBrainEvolver) — analyze this
  // build's Contract-9 rewrite-effectiveness observations and emit any TEMPLATE evolution
  // proposals. Runs before any future promotion step reads pending_evolutions (Learning Iron Law
  // L5: this agent only ever proposes — it never edits src/engine/prompt-rewriter.ts itself).
  let evolutionProposals: PendingEvolution[] = [];
  if (store) {
    try {
      const memoryClient = BuildMemory.getClient();
      if (memoryClient) {
        evolutionProposals = emitProposals(buildRunId, memoryClient);
      } else {
        warnings.push('BuildBrainEvolver skipped — Build Memory unreachable (stateless, Contract 4).');
      }
    } catch (error) {
      warnings.push(`BuildBrainEvolver failed (${describe(error)}).`);
      log(`WARNING: BuildBrainEvolver degraded (${describe(error)})`);
    }
  }
  log(`step 9.5 (BuildBrainEvolver): ${evolutionProposals.length} evolution proposal(s)`);

  // 11. EvolutionPromoter (LEARNING_BLUEPRINT.md § Agent: EvolutionPromoter) — appended after the
  // existing 10-step sequence so it sees the freshest pending_evolutions rows (including any
  // BuildBrainEvolver just wrote in step 9.5). Guarded like every other step (Contract 4): a
  // promotion failure degrades to an empty result and never halts the build.
  let evolutionPromotions: PromotionResult[] = [];
  if (store) {
    try {
      const memoryClient = BuildMemory.getClient();
      if (memoryClient) {
        evolutionPromotions = registerPromoterPhase5Hook(memoryClient);
      } else {
        warnings.push('EvolutionPromoter skipped — Build Memory unreachable (stateless, Contract 4).');
      }
    } catch (error) {
      warnings.push(`EvolutionPromoter failed (${describe(error)}).`);
      log(`WARNING: EvolutionPromoter degraded (${describe(error)})`);
    }
  }
  log(`step 11 (EvolutionPromoter): ${evolutionPromotions.length} evolution(s) promoted`);

  // 12. Autonomous deployment (Autonomy: VercelDeployer — src/autonomy/vercel-deployer.ts): after
  // every learning step above has run, if this project has opted into autonomous deploy (a
  // VERCEL_TOKEN resolvable from the environment or this project's credential vault, AND a
  // vercel.json already present on disk — the project's own signal that it's linked/configured
  // for Vercel), deploy straight to production and run forge verify against the result. Guarded
  // (Contract 4): a deploy/verify failure here is logged and never blocks Phase 5's own
  // completion or reopens the build. Skipped entirely (not merely no-op) when store is false —
  // a pure-analysis pass has no business pushing a live deployment.
  let deployment: Phase5DeploymentResult = {
    attempted: false,
    deploymentUrl: null,
    deploySucceeded: false,
    verifyRan: false,
    verifyPassed: false,
    verifyRouteCount: 0,
  };
  if (store) {
    try {
      const vault = createCredentialVault();
      const hasVercelToken =
        Boolean(process.env['VERCEL_TOKEN']) || (await vault.get(projectPath, 'VERCEL_TOKEN')) !== null;
      const hasVercelJson = existsSync(join(projectPath, 'vercel.json'));

      if (hasVercelToken && hasVercelJson) {
        log('step 12 (deploy): VERCEL_TOKEN + vercel.json present — deploying to production');
        deployment = { ...deployment, attempted: true };

        const deployer = createVercelDeployer(vault);
        const deployResult = await deployer.deploy(projectPath, buildRunId, 'production');
        deployment = { ...deployment, deploymentUrl: deployResult.deploymentUrl, deploySucceeded: deployResult.status === 'ready' };

        if (deployResult.status === 'ready' && deployResult.deploymentUrl) {
          log(`step 12 (deploy): Vercel deploy ready — ${deployResult.deploymentUrl}`);
          try {
            const { runDeployVerification } = await import('../deploy/verify-runner.js');
            const verifyResult = await runDeployVerification({
              projectPath,
              baseUrl: deployResult.deploymentUrl,
              latencyBudgetMs: 3000,
            });
            deployment = {
              ...deployment,
              verifyRan: true,
              verifyPassed: verifyResult.passed,
              verifyRouteCount: verifyResult.routes.length,
            };
            log(`step 12 (forge verify): ${verifyResult.passed ? 'PASSED' : 'FAILED'} (${verifyResult.routes.length} route(s))`);
            if (!verifyResult.passed) {
              warnings.push('Post-deploy forge verify found failing routes — see the deployment for detail.');
            }
          } catch (error) {
            warnings.push(`forge verify failed to run after deploy (${describe(error)}).`);
            log(`WARNING: step 12 forge verify degraded (${describe(error)})`);
          }
        } else {
          warnings.push(
            `Autonomous Vercel deploy did not reach a ready state (status: ${deployResult.status}` +
              `${deployResult.error ? `: ${deployResult.error}` : ''}).`
          );
          log(`WARNING: step 12 deploy did not reach ready (status ${deployResult.status})`);
        }
      } else {
        const reasons = [
          ...(hasVercelToken ? [] : ['no VERCEL_TOKEN']),
          ...(hasVercelJson ? [] : ['no vercel.json']),
        ];
        log(`step 12 (deploy): skipped — ${reasons.join(', ')}`);
      }
    } catch (error) {
      warnings.push(`Autonomous deployment step failed (${describe(error)}).`);
      log(`WARNING: step 12 deploy degraded (${describe(error)})`);
    }
  }

  // 13. Definition of Done (ENGINEERING_COMPLETENESS.md § 60 — machine-verifiable completion,
  //     never "no more queue files"). Opt-in per build via `options.targetTier`: Phase 5 never
  //     fabricates a target tier the caller didn't request. A failing evaluation does NOT reopen
  //     or fail the already-finalized build_run (Contract 4 — mirrors the SupabaseMigrator
  //     precedent in phase3-executor.ts) — it appends a BLOCKER to STATE_OF_THE_BUILD.md instead,
  //     so "do not mark build complete" is honored as "the build's own state document records the
  //     build as NOT Definition-of-Done-complete for the requested tier," the only mutation Phase 5
  //     is allowed to make (it never touches build_runs.status or a protected governance file).
  let dodResult: DoDResult | null = null;
  if (options.targetTier) {
    try {
      dodResult = await runEvaluateDoDImpl(projectPath, options.targetTier);
      log(
        `step 13 (Definition of Done): target tier ${dodResult.targetTier} — ` +
          `${dodResult.passed ? 'PASSED' : 'FAILED'} (${dodResult.checks.filter((c) => !c.passed).length}/${dodResult.checks.length} check(s) failing)`
      );
      if (!dodResult.passed) {
        warnings.push(
          `Definition of Done FAILED for target tier ${dodResult.targetTier} — build is not being reopened ` +
            '(Contract 4), see the BLOCKER appended to STATE_OF_THE_BUILD.md for detail.'
        );
        await appendDoDFailureBlocker(dodResult);
      }
    } catch (error) {
      warnings.push(`Definition of Done evaluation failed (${describe(error)}).`);
      log(`WARNING: step 13 DoD evaluation degraded (${describe(error)})`);
    }
  } else {
    log('step 13 (Definition of Done): skipped — no targetTier supplied.');
  }

  // 10. Produce the Phase 5 summary report.
  const generatedAt = nowIso();
  const summaryReport = buildSummaryReport(
    buildRunId,
    projectName,
    patterns,
    templates,
    agents,
    synthesis,
    instincts,
    sessionEndRan,
    governanceRules,
    skillFiles,
    additionalInsights,
    evolutionProposals,
    evolutionPromotions,
    deployment,
    dodResult,
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
      `${agents.storage.agentsStored} agent(s) stored, ` +
      `${instincts.length} instinct(s), ${skillFiles.length} skill(s), ` +
      `${governanceRules.length} governance rule(s).`
  );

  return {
    buildRunId,
    projectName,
    stackFingerprint,
    patterns,
    templates,
    agents,
    synthesis,
    instincts,
    sessionEndRan,
    governanceRules,
    skillFiles,
    additionalInsights,
    evolutionProposals,
    evolutionPromotions,
    deployment,
    dodResult,
    summaryReport,
    reportPath,
    warnings,
    generatedAt,
  };
}

export default runPhase5Learner;
