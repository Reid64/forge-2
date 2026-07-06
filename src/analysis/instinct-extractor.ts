/**
 * FORGE 2.0 — Instinct Extractor: automated learning from build sessions.
 *
 * Three exports:
 *   extractInstincts — read a build's errors+resolutions via a SupabaseClient,
 *     derive reusable instinct rules, and persist them in a cross_project_insights
 *     row (evidence.instincts array; insight_type: 'prevention').
 *   extractSkills    — identify debugging techniques from the build via BuildMemory;
 *     write one SKILL.md per technique to {projectPath}/.forge/skills/.
 *   applyInstincts   — given a prompt and a list of instincts, append the relevant
 *     rules as a "FORGE Instinct Rules" block and return the enhanced prompt.
 *
 * Non-fatal house style (Contract 4): all Build Memory I/O is guarded; none of
 * these functions ever throw.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Instinct, JsonObject } from '../types/index.js';
import type { NewCrossProjectInsight } from '../memory/insights.js';
import type { MemoryDb } from '../memory/client.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import { logLine } from '../tools/forge-logger.js';
import { normalizeErrorSignature, categorizeError } from '../phases/phase4-sentinel.js';

const log = logLine('instincts');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Deep-clone an arbitrary serializable value to a plain JsonObject. */
function toJson(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/**
 * Extract meaningful keywords from text for relevance matching.
 * Filters out tokens shorter than 4 chars and common stop words.
 */
function keywords(text: string): string[] {
  const STOP = new Set([
    'with', 'from', 'that', 'this', 'have', 'been', 'will', 'your',
    'they', 'when', 'more', 'also', 'into', 'than', 'then', 'some',
    'what', 'there', 'their', 'about', 'which', 'error', 'cannot',
  ]);
  return text
    .toLowerCase()
    .split(/[\s_\-.:,()[\]{}'"`/\\]+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
}

// ---------------------------------------------------------------------------
// extractInstincts
// ---------------------------------------------------------------------------

/**
 * Analyze a completed build run and extract reusable "when error X, fix Y" rules.
 *
 * Reads `build_runs` and `prompt_executions` via the supplied `memoryClient`.
 * Pairs each non-empty `error_output` with its `resolution_applied`, groups by
 * (normalized-signature, fix), and computes a confidence score per pair:
 *   - base 0.5
 *   - +0.3 if the prompt ultimately completed (fix confirmed)
 *   - +0.1 per additional occurrence beyond the first (capped at 0.95)
 *
 * The resulting instincts are persisted as a single cross_project_insights row
 * (insight_type 'prevention', evidence.instincts). Returns the extracted instincts,
 * or [] when the build has no data or Build Memory is unreachable.
 */
export async function extractInstincts(
  buildRunId: string,
  memoryClient: MemoryDb,
): Promise<Instinct[]> {
  // 1. Load the build run (project name + stack fingerprint).
  let projectName = 'unknown';
  let stackFingerprint: JsonObject = {};
  try {
    const row = memoryClient
      .prepare('SELECT project_name, stack_fingerprint FROM build_runs WHERE id = ?')
      .get(buildRunId) as { project_name: string; stack_fingerprint: string } | undefined;
    if (!row) {
      log(`WARNING: build ${buildRunId} not found — skipping instinct extraction`);
      return [];
    }
    projectName = row.project_name ?? 'unknown';
    stackFingerprint = row.stack_fingerprint ? (JSON.parse(row.stack_fingerprint) as JsonObject) : {};
  } catch {
    log(`WARNING: could not load build ${buildRunId} — skipping instinct extraction`);
    return [];
  }

  // 2. Load prompt executions (only the columns we need).
  let executions: Array<{
    error_output: string | null;
    resolution_applied: string | null;
    status: string;
  }> = [];
  try {
    executions = memoryClient
      .prepare('SELECT error_output, resolution_applied, status FROM prompt_executions WHERE build_run_id = ?')
      .all(buildRunId) as typeof executions;
  } catch {
    log(`WARNING: could not load prompt_executions for ${buildRunId}`);
    return [];
  }

  // 3. Group into (normalized-signature, fix) pairs.
  interface Pair {
    sample: string;
    fix: string;
    succeeded: boolean;
    count: number;
  }
  const pairs = new Map<string, Pair>();

  for (const ex of executions) {
    const raw = ex.error_output?.trim();
    const fix = ex.resolution_applied?.trim();
    if (!raw || !fix) continue;
    const sig = normalizeErrorSignature(raw);
    if (!sig) continue;
    const mapKey = `${sig}\x00${fix}`;
    const existing = pairs.get(mapKey);
    if (existing) {
      existing.count += 1;
      if (ex.status === 'completed') existing.succeeded = true;
    } else {
      pairs.set(mapKey, {
        sample: raw.slice(0, 300),
        fix,
        succeeded: ex.status === 'completed',
        count: 1,
      });
    }
  }

  if (pairs.size === 0) {
    log(`no error→fix pairs found in build ${buildRunId}`);
    return [];
  }

  // 4. Build Instinct objects.
  const ts = nowIso();
  const instincts: Instinct[] = [];
  for (const [mapKey, pair] of pairs) {
    const sig = mapKey.split('\x00')[0] ?? '';
    const raw = 0.5 + (pair.succeeded ? 0.3 : 0) + Math.max(0, pair.count - 1) * 0.1;
    const confidence = Math.round(Math.min(0.95, raw) * 100) / 100;
    instincts.push({
      id: randomUUID(),
      pattern: sig,
      fix: pair.fix,
      confidence,
      source_project: projectName,
      times_applied: 0,
      times_succeeded: 0,
      created_at: ts,
    });
  }

  log(`extracted ${instincts.length} instinct(s) from build ${buildRunId}`);

  // 5. Persist as a cross_project_insights row (evidence.instincts).
  const insight: NewCrossProjectInsight = {
    insight_type: 'prevention',
    source_project: projectName,
    source_build_id: buildRunId,
    applicable_fingerprints: [stackFingerprint],
    description: `Instincts from build ${buildRunId}: ${instincts.length} error→fix rule(s) for ${projectName}.`,
    evidence: toJson({ instincts }),
  };
  try {
    const created = await BuildMemory.insights.createInsight(insight);
    if (!created) throw new Error('createInsight returned null');
    log(`persisted instinct insight for build ${buildRunId}`);
  } catch {
    log(`WARNING: could not persist instincts for ${buildRunId} (stateless mode)`);
  }

  return instincts;
}

// ---------------------------------------------------------------------------
// extractSkills
// ---------------------------------------------------------------------------

/** A debugging technique or workaround discovered during a build. */
interface SkillEntry {
  title: string;
  triggerCondition: string;
  technique: string;
  examples: Array<{ error: string; fix: string }>;
  occurrences: number;
}

/**
 * Identify debugging techniques and workarounds applied during the build and
 * write one SKILL.md file per discovered technique to {projectPath}/.forge/skills/.
 *
 * A technique is identified when a prompt execution has both an `error_output`
 * and a `resolution_applied` (or `rewrite_reason`). Techniques are grouped by
 * (error category, fix prefix) so similar fixes merge into a single skill file.
 *
 * Uses BuildMemory directly (no SupabaseClient param). Degrades gracefully if
 * Build Memory is unreachable. Returns the file paths created.
 */
export async function extractSkills(
  buildRunId: string,
  projectPath: string,
): Promise<string[]> {
  const build = await BuildMemory.builds.getBuild(buildRunId);
  if (!build) {
    log(`WARNING: build ${buildRunId} not found — skipping skill extraction`);
    return [];
  }

  const executions = (await BuildMemory.prompts.getPromptsByBuild(buildRunId)) ?? [];
  if (executions.length === 0) {
    log(`no prompt_executions for ${buildRunId} — no skills to extract`);
    return [];
  }

  // Group executions into skill entries by (error category, fix prefix).
  const skillMap = new Map<string, SkillEntry>();

  for (const ex of executions) {
    const raw = ex.error_output?.trim();
    const fix = (ex.resolution_applied?.trim()) ?? (ex.rewrite_reason?.trim());
    if (!raw || !fix) continue;

    const category = categorizeError(null, raw);
    const mapKey = `${category}::${fix.slice(0, 80)}`;

    const existing = skillMap.get(mapKey);
    if (existing) {
      existing.occurrences += 1;
      if (existing.examples.length < 3) {
        existing.examples.push({ error: raw.slice(0, 200), fix });
      }
    } else {
      skillMap.set(mapKey, {
        title: `${category.replace(/_/g, ' ')} — ${fix.slice(0, 60)}`,
        triggerCondition: `When a ${category.replace(/_/g, ' ')} occurs: ${raw.slice(0, 150)}`,
        technique: fix,
        examples: [{ error: raw.slice(0, 200), fix }],
        occurrences: 1,
      });
    }
  }

  if (skillMap.size === 0) {
    log(`no debugging techniques found in build ${buildRunId}`);
    return [];
  }

  // Ensure skills directory exists.
  const skillsDir = join(projectPath, '.forge', 'skills');
  try {
    await mkdir(skillsDir, { recursive: true });
  } catch {
    log(`WARNING: could not create skills directory ${skillsDir}`);
    return [];
  }

  // Write one SKILL.md per technique.
  const created: string[] = [];
  let idx = 0;
  for (const skill of skillMap.values()) {
    idx += 1;
    const slug = skill.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    const filename = `skill-${String(idx).padStart(2, '0')}-${slug}.md`;
    const filePath = join(skillsDir, filename);

    const examplesSection = skill.examples
      .map(
        (e, i) =>
          `### Example ${i + 1}\n**Error:**\n\`\`\`\n${e.error}\n\`\`\`\n**Fix:**\n${e.fix}`,
      )
      .join('\n\n');

    const content = [
      `# Skill: ${skill.title}`,
      '',
      `**Source build:** ${buildRunId}`,
      `**Project:** ${build.project_name}`,
      `**Observed:** ${skill.occurrences} time(s)`,
      '',
      '## When to Use',
      '',
      skill.triggerCondition,
      '',
      '## Technique',
      '',
      skill.technique,
      '',
      '## Examples',
      '',
      examplesSection,
    ].join('\n');

    try {
      await writeFile(filePath, content, 'utf8');
      created.push(filePath);
      log(`wrote skill: ${filename}`);
    } catch {
      log(`WARNING: could not write skill file ${filePath}`);
    }
  }

  log(`extracted ${created.length} skill(s) for build ${buildRunId}`);
  return created;
}

// ---------------------------------------------------------------------------
// applyInstincts
// ---------------------------------------------------------------------------

/**
 * Augment an outgoing prompt with any instinct rules relevant to it.
 *
 * Relevance is determined by keyword overlap: an instinct is included when at
 * least two meaningful tokens from its `pattern` appear in the prompt (case-
 * insensitive). Only instincts with confidence ≥ 0.5 are considered. Matched
 * instincts are sorted by descending confidence.
 *
 * When at least one instinct matches, a "FORGE Instinct Rules" block is appended
 * to the prompt. Returns the original prompt unchanged when nothing matches.
 */
export function applyInstincts(prompt: string, instincts: Instinct[]): string {
  if (instincts.length === 0) return prompt;

  const promptTokens = new Set(keywords(prompt));

  const relevant = instincts
    .filter((inst) => inst.confidence >= 0.5)
    .filter((inst) => {
      const instTokens = keywords(inst.pattern);
      const overlap = instTokens.filter((w) => promptTokens.has(w)).length;
      return overlap >= 2;
    })
    .sort((a, b) => b.confidence - a.confidence);

  if (relevant.length === 0) return prompt;

  const rules = relevant
    .map(
      (inst, i) =>
        `${i + 1}. Pattern: ${inst.pattern}\n   Fix: ${inst.fix}` +
        ` (confidence: ${inst.confidence}, source: ${inst.source_project})`,
    )
    .join('\n');

  return (
    `${prompt}\n\n---\n## FORGE Instinct Rules\n` +
    `The following learned rules apply to this prompt:\n\n${rules}\n---`
  );
}
