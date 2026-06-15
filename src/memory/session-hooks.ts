/**
 * FORGE 2.0 — Session lifecycle memory persistence.
 *
 * Saves and restores context across FORGE sessions to prevent context rot
 * during long builds. Wired to session_start, session_end, and pre_compact
 * lifecycle events (HookEvent in src/types/index.ts).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BuildRun,
  ErrorPattern,
  CrossProjectInsight,
  SessionContext,
  SessionMetrics,
} from '../types/index.js';
import { updateBuild } from './builds.js';
import {
  getAutoResolvable,
  createErrorPattern,
  findMatchingPattern,
  updateOccurrenceCount,
} from './errors.js';
import { findApplicableInsights, createInsight } from './insights.js';
import { logMemoryWarning, nowIso } from './client.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ContextSnapshot {
  currentPromptIndex: number | null;
  accumulatedErrors: string[];
  governanceState: string;
  fileModificationLog: string[];
}

function buildPromptInjection(
  lastBuild: BuildRun | null,
  errorPatterns: ErrorPattern[],
  insights: CrossProjectInsight[]
): string {
  const lines: string[] = [];

  if (lastBuild) {
    const ts = lastBuild.completed_at ?? lastBuild.started_at ?? lastBuild.created_at;
    lines.push(
      `Last session (${lastBuild.status} at ${ts}): ` +
        `${lastBuild.completed_prompts}/${lastBuild.total_prompts} prompts, ` +
        `${lastBuild.total_errors} errors.`
    );
  }

  if (errorPatterns.length > 0) {
    const sigs = errorPatterns
      .slice(0, 5)
      .map((p) => p.error_signature)
      .join(', ');
    lines.push(`Active error patterns: ${sigs}`);
  }

  if (insights.length > 0) {
    const descs = insights
      .slice(0, 3)
      .map((i) => i.description)
      .join('; ');
    lines.push(`Cross-project insights: ${descs}`);
  }

  return lines.join('\n');
}

function extractContextSnapshot(context: string): ContextSnapshot {
  const promptMatch =
    context.match(/prompt[:\s]+(\d+)\s*(?:of|\/)\s*\d+/i) ??
    context.match(/prompt[_\s]?index[:\s]+(\d+)/i);
  const promptCapture = promptMatch?.[1];
  const currentPromptIndex =
    promptCapture != null ? parseInt(promptCapture, 10) : null;

  const errorIter = context.matchAll(
    /(?:error|FAIL|gate.*fail)[:\s]+([^\n]{10,100})/gi
  );
  const accumulatedErrors = [
    ...new Set(
      [...errorIter]
        .map((m) => m[1]?.trim())
        .filter((s): s is string => s != null && s.length > 0)
    ),
  ].slice(0, 20);

  const governanceState = context.includes('HALTED')
    ? 'HALTED'
    : context.includes('FAILED')
    ? 'FAILED'
    : context.includes('RUNNING')
    ? 'RUNNING'
    : 'UNKNOWN';

  const fileIter = context.matchAll(
    /(?:created|modified|updated|wrote)[:\s]+([^\s\n]+\.(?:ts|tsx|js|json|md))/gi
  );
  const fileModificationLog = [
    ...new Set(
      [...fileIter]
        .map((m) => m[1])
        .filter((s): s is string => s != null && s.length > 0)
    ),
  ].slice(0, 50);

  return { currentPromptIndex, accumulatedErrors, governanceState, fileModificationLog };
}

// ---------------------------------------------------------------------------
// Exported lifecycle hooks
// ---------------------------------------------------------------------------

/**
 * Load context from the most recent completed/failed build for this project.
 * Retrieves last session summary, active auto-resolvable error patterns, and
 * applicable cross-project insights. Returns a SessionContext ready to inject
 * into prompts. Never throws — degrades to empty arrays on memory unavailability.
 */
export async function onSessionStart(
  projectPath: string,
  memoryClient: SupabaseClient
): Promise<SessionContext> {
  const { data: buildsData, error: buildsError } = await memoryClient
    .from('build_runs')
    .select('*')
    .eq('project_path', projectPath)
    .in('status', ['completed', 'failed'])
    .order('created_at', { ascending: false })
    .limit(1);

  if (buildsError) {
    logMemoryWarning('onSessionStart.lastBuild', buildsError);
  }

  const lastBuildRun = (buildsData as BuildRun[] | null)?.[0] ?? null;
  const activeErrorPatterns = (await getAutoResolvable()) ?? [];
  const applicableInsights = (await findApplicableInsights()) ?? [];
  const promptInjection = buildPromptInjection(
    lastBuildRun,
    activeErrorPatterns,
    applicableInsights
  );

  return { lastBuildRun, activeErrorPatterns, applicableInsights, promptInjection };
}

/**
 * Persist session metrics at session end. Updates the build_run record with
 * final counts and cost, upserts any new error patterns discovered, and saves
 * extracted insights to cross_project_insights. Never throws.
 */
export async function onSessionEnd(
  projectPath: string,
  _memoryClient: SupabaseClient,
  session: SessionMetrics
): Promise<void> {
  const endedAt = nowIso();

  await updateBuild(session.buildRunId, {
    status: session.failCount > 0 ? 'failed' : 'completed',
    completed_at: endedAt,
    completed_prompts: session.passCount,
    failed_prompts: session.failCount,
    total_errors: session.errorsEncountered.length,
    total_tokens: session.totalTokens,
    total_cost_usd: session.totalCostUsd,
  });

  for (const err of session.errorsEncountered) {
    const existing = await findMatchingPattern(err.signature);
    if (existing) {
      await updateOccurrenceCount(existing.id);
    } else {
      await createErrorPattern({
        error_signature: err.signature,
        error_category: err.category,
        error_message_sample: err.message,
        first_seen_project: projectPath,
      });
    }
  }

  for (const description of session.patternsDiscovered) {
    if (!description.trim()) continue;
    await createInsight({
      insight_type: 'pattern',
      source_project: projectPath,
      description,
      evidence: {
        build_run_id: session.buildRunId,
        prompts_executed: session.promptsExecuted,
        session_ended_at: endedAt,
      },
    });
  }
}

/**
 * Extract critical state from the current context before compaction and save
 * a snapshot to the running build_run record. Returns a condensed summary
 * string for prepending to the next context window. Never throws.
 */
export async function onPreCompact(
  currentContext: string,
  memoryClient: SupabaseClient
): Promise<string> {
  const snapshot = extractContextSnapshot(currentContext);
  const snapshotAt = nowIso();

  const { data: runningData, error: findError } = await memoryClient
    .from('build_runs')
    .select('id')
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1);

  if (findError) {
    logMemoryWarning('onPreCompact.findRunning', findError);
  }

  const buildId = (runningData as Array<{ id: string }> | null)?.[0]?.id;

  if (buildId) {
    const { error: saveError } = await memoryClient
      .from('build_runs')
      .update({ session_snapshots: { ...snapshot, saved_at: snapshotAt } })
      .eq('id', buildId);

    if (saveError) {
      logMemoryWarning('onPreCompact.saveSnapshot', saveError);
    }
  }

  return [
    `[FORGE COMPACT SUMMARY — ${snapshotAt}]`,
    `Prompt index: ${snapshot.currentPromptIndex ?? 'unknown'}`,
    `Governance state: ${snapshot.governanceState}`,
    `Accumulated errors (${snapshot.accumulatedErrors.length}): ${
      snapshot.accumulatedErrors.join(', ') || 'none'
    }`,
    `Modified files (${snapshot.fileModificationLog.length}): ${
      snapshot.fileModificationLog.slice(0, 10).join(', ') || 'none'
    }`,
  ].join('\n');
}
