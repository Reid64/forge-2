/**
 * FORGE 2.0 — Learning Engine: CrossProjectKnowledgeTransfer.
 *
 * See `upgrades/LEARNING_BLUEPRINT.md` § Agent: CrossProjectKnowledgeTransfer. Turns
 * `cross_project_insights` from passive storage into an active PUSH — at the start of a new
 * build's Phase 1B/Phase 2, every stack-compatible, non-retired insight is injected into that
 * build's prompt assembly (via the assembler's existing context mechanism, see
 * `src/engine/prompt-assembler.ts` `AssembleInput.crossProjectInsightsBlock`).
 *
 * SAFETY IS STRUCTURAL, NOT SOFT (L7 / Canonical Rule 5): {@link matchFingerprint} is a HARD
 * disqualifier — language and framework must match exactly (database only when both sides
 * specify one). An insight recorded for a different framework or database is excluded, never
 * injected "with lower confidence." When the caller names ONE specific source build
 * (`opts.buildId` — the explicit `forge learn transfer --build-id` path), that build's own
 * stack is checked UP FRONT and, if incompatible, the whole call THROWS
 * "Incompatible stack — transfer refused" — never a soft warning — because a human explicitly
 * asked for that one source and a silent empty result would hide why.
 *
 * RETIREMENT ANTI-JOIN: an insight whose evidence references a pattern PatternRetirer has since
 * retired is never re-transferred — enforced via the shared {@link filterRetiredPatterns} helper
 * (`src/learning/retirement-filter.ts`), the same anti-join every other consuming query site uses.
 *
 * The only write this agent makes is `cross_project_insights.applied_count += 1` for each
 * insight actually transferred (skipped entirely when `opts.dryRun`).
 */

import { basename } from 'node:path';

import type { CrossProjectInsight, JsonObject } from '../types/index.js';
import type { StackFingerprint } from '../tools/stack-detector.js';
import { logMemoryWarning, type MemoryDb } from '../memory/client.js';
import { filterRetiredPatterns } from './retirement-filter.js';

/** Normalized `{ language, framework, database }` triple — the unit {@link matchFingerprint} compares. */
export interface StackTriple {
  language: string | null;
  framework: string | null;
  database: string | null;
}

/** Options for {@link transferKnowledge}. */
export interface TransferOptions {
  /** Report what would transfer; write nothing (`applied_count` is not incremented). */
  dryRun?: boolean;
  /**
   * Restrict transfer to insights sourced from ONE specific build (`cross_project_insights.source_build_id`).
   * That build's own stack is hard-checked against `targetStack` BEFORE any query runs — a
   * mismatch throws rather than returning an empty result (see file header).
   */
  buildId?: string;
}

/** The result of {@link transferKnowledge}. */
export interface TransferResult {
  /** Count of insights actually transferred (matched + non-retired). */
  transferred: number;
  /** `cross_project_insights.id` of every transferred insight. */
  insightIds: string[];
  /** Markdown block for injection via the assembler's context mechanism; `''` when nothing transferred. */
  contextBlock: string;
  /** Candidates excluded by the hard fingerprint disqualifier. */
  skippedIncompatible: number;
  /** Matching candidates excluded because their evidence traces to a retired pattern. */
  skippedRetired: number;
  /** Non-fatal issues encountered (query failure, applied_count update failure, …). */
  warnings: string[];
}

const HARD_ERROR_MESSAGE = 'Incompatible stack — transfer refused';

/** Lowercase/trim a scalar and strip a trailing version suffix ("nextjs14" -> "nextjs"). Never throws. */
function normalizeScalar(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return null;
  const stripped = trimmed.replace(/[@\s]?v?\d+(\.\d+)*$/i, '').trim();
  return stripped !== '' ? stripped : trimmed;
}

function tripleFromFingerprint(fp: StackFingerprint): StackTriple {
  return {
    language: normalizeScalar(fp.language),
    framework: normalizeScalar(fp.framework),
    database: normalizeScalar(fp.database),
  };
}

/** Normalize an `applicable_fingerprints` entry (untrusted DB jsonb) to a {@link StackTriple}, or `null`. */
function tripleFromJson(raw: unknown): StackTriple | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const language = normalizeScalar(o['language']);
  const framework = normalizeScalar(o['framework']);
  if (language === null && framework === null) return null;
  return { language, framework, database: normalizeScalar(o['database']) };
}

/**
 * Hard fingerprint match (LEARNING_BLUEPRINT.md L7): `language` AND `framework` must be exactly
 * equal; `database` is compared only when BOTH sides specify one. No fuzzy/partial credit — a
 * differing language or framework is an absolute disqualifier, never a soft down-weight.
 */
export function matchFingerprint(candidate: StackTriple, target: StackTriple): boolean {
  if (!candidate.language || !target.language || candidate.language !== target.language) return false;
  if (!candidate.framework || !target.framework || candidate.framework !== target.framework) return false;
  if (candidate.database && target.database && candidate.database !== target.database) return false;
  return true;
}

interface InsightRow {
  id: string;
  insight_type: string;
  source_project: string;
  source_build_id: string | null;
  applicable_fingerprints: string;
  description: string;
  evidence: string;
  applied_count: number;
  effectiveness_score: number | null;
  created_at: string;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function rowToInsight(row: InsightRow): CrossProjectInsight {
  return {
    id: row.id,
    insight_type: row.insight_type as CrossProjectInsight['insight_type'],
    source_project: row.source_project,
    source_build_id: row.source_build_id,
    applicable_fingerprints: parseJson<JsonObject[]>(row.applicable_fingerprints, []),
    description: row.description,
    evidence: parseJson<JsonObject>(row.evidence, {}),
    applied_count: row.applied_count,
    effectiveness_score: row.effectiveness_score,
    created_at: row.created_at,
  };
}

/** True when ANY of the insight's recorded fingerprints hard-matches `target`. */
function insightMatchesTarget(insight: CrossProjectInsight, target: StackTriple): boolean {
  for (const raw of insight.applicable_fingerprints) {
    const triple = tripleFromJson(raw);
    if (triple && matchFingerprint(triple, target)) return true;
  }
  return false;
}

/**
 * Retirement anti-join (LEARNING_BLUEPRINT.md § PatternRetirer "Consuming query sites"): drop an
 * insight whose evidence references a pattern PatternRetirer has since retired. Applies the
 * shared {@link filterRetiredPatterns} helper against any `error_signature` the insight's
 * evidence carries; an insight with no such reference is never considered retired by this check.
 */
function insightIsRetired(insight: CrossProjectInsight, db: MemoryDb): boolean {
  const evidence = insight.evidence as Record<string, unknown>;
  const errorSignature = typeof evidence['error_signature'] === 'string' ? (evidence['error_signature'] as string) : null;
  if (errorSignature === null) return false;
  return filterRetiredPatterns([{ error_signature: errorSignature }], db).length === 0;
}

/** Render the transferred insights as a Markdown block for prompt injection. `''` when empty. */
function renderContextBlock(insights: CrossProjectInsight[], targetProjectPath: string): string {
  if (insights.length === 0) return '';
  const projectLabel = basename(targetProjectPath) || targetProjectPath;
  const lines: string[] = [
    `## Cross-Project Knowledge Transfer (pushed into "${projectLabel}" — FORGE Learning Engine)`,
    '',
    'Lessons below come from prior FORGE builds on a stack-compatible project. They are CONTEXT ' +
      '— apply the underlying lesson to this build, do not copy verbatim.',
    '',
  ];
  for (const i of insights) {
    lines.push(`- [${i.insight_type}] (from ${i.source_project}) ${i.description}`);
  }
  return lines.join('\n');
}

/** Resolve a source build's stack (for the explicit `opts.buildId` hard-check), or `null` if unknown. */
function resolveSourceBuildStack(buildId: string, db: MemoryDb): StackTriple | null {
  const row = db.prepare('SELECT stack_fingerprint FROM build_runs WHERE id = ?').get(buildId) as
    | { stack_fingerprint: string }
    | undefined;
  if (!row) return null;
  return tripleFromJson(parseJson<Record<string, unknown>>(row.stack_fingerprint, {}));
}

/**
 * Transfer stack-compatible, non-retired `cross_project_insights` into `targetProjectPath`'s new
 * build (PUSH — see file header). Queries every `cross_project_insights` row (or, with
 * `opts.buildId`, only rows sourced from that one build), keeps the ones whose recorded
 * fingerprint hard-matches `targetStack`, drops any that trace to a retired pattern, increments
 * `applied_count` for each survivor (unless `opts.dryRun`), and returns a Markdown context block
 * ready for prompt injection.
 *
 * Throws `"Incompatible stack — transfer refused"` when `opts.buildId` names a source build whose
 * own stack does not hard-match `targetStack` (L7 — a hard stop, never a soft warning). The
 * automatic multi-insight sweep (no `opts.buildId`) never throws for a mismatch — it silently
 * excludes incompatible candidates one at a time, which is the correct behavior for an
 * unattended, build-start PUSH spanning insights from many different projects/stacks.
 */
export function transferKnowledge(
  targetProjectPath: string,
  targetStack: StackFingerprint,
  db: MemoryDb,
  opts: TransferOptions = {}
): TransferResult {
  const warnings: string[] = [];
  const target = tripleFromFingerprint(targetStack);

  if (opts.buildId) {
    const sourceStack = resolveSourceBuildStack(opts.buildId, db);
    if (!sourceStack || !matchFingerprint(sourceStack, target)) {
      throw new Error(HARD_ERROR_MESSAGE);
    }
  }

  let rows: InsightRow[];
  try {
    rows = opts.buildId
      ? (db
          .prepare('SELECT * FROM cross_project_insights WHERE source_build_id = ? ORDER BY created_at DESC')
          .all(opts.buildId) as InsightRow[])
      : (db.prepare('SELECT * FROM cross_project_insights ORDER BY created_at DESC').all() as InsightRow[]);
  } catch (err) {
    logMemoryWarning('cross-project-transfer.transferKnowledge', err);
    return {
      transferred: 0,
      insightIds: [],
      contextBlock: '',
      skippedIncompatible: 0,
      skippedRetired: 0,
      warnings: [err instanceof Error ? err.message : String(err)],
    };
  }

  let skippedIncompatible = 0;
  let skippedRetired = 0;
  const transferred: CrossProjectInsight[] = [];

  for (const row of rows) {
    const insight = rowToInsight(row);
    if (!insightMatchesTarget(insight, target)) {
      skippedIncompatible++;
      continue;
    }
    if (insightIsRetired(insight, db)) {
      skippedRetired++;
      continue;
    }
    transferred.push(insight);
  }

  if (!opts.dryRun && transferred.length > 0) {
    const bump = db.prepare('UPDATE cross_project_insights SET applied_count = applied_count + 1 WHERE id = ?');
    for (const insight of transferred) {
      try {
        bump.run(insight.id);
      } catch (err) {
        logMemoryWarning('cross-project-transfer.applied_count', err);
        warnings.push(`could not increment applied_count for ${insight.id}`);
      }
    }
  }

  return {
    transferred: transferred.length,
    insightIds: transferred.map((i) => i.id),
    contextBlock: renderContextBlock(transferred, targetProjectPath),
    skippedIncompatible,
    skippedRetired,
    warnings,
  };
}
