/**
 * FORGE 2.0 — Prompt Decomposer (Phase 3 Build Executor engine).
 *
 * A LARGE build prompt is a failure magnet: when a single queue entry asks claude to create five
 * tables AND three routes AND a dashboard in one shot, a defect anywhere taints the whole unit and
 * the executor must re-run (and re-pay for) the entire thing. The Decomposer breaks that blast
 * radius. BEFORE the claude-runner call (s5-p05 step f), the executor asks: is this prompt's
 * `description` longer than {@link DECOMPOSITION_THRESHOLD} characters? If so, the Decomposer splits
 * it into smaller ATOMIC sub-prompts — each handling ONE discrete thing (one table, one component,
 * one route) — and executes them SEQUENTIALLY, running the Phase 4 Sentinel BETWEEN each
 * (BEHAVIORAL_CONTRACTS Contract 1 — "Phase 4 runs after EVERY Phase 3 prompt", here at finer
 * grain). When a sub-prompt fails, ONLY that sub-prompt retries (up to
 * {@link DEFAULT_MAX_SUBPROMPT_RETRIES}); the sub-prompts that already passed are never re-run, so a
 * defect in step 4 of 6 costs one step, not six.
 *
 * DETERMINISTIC SPLIT (no model call): {@link decompose} is a pure transformation of the prompt
 * `description` into atomic units. It prefers the author's OWN structure — an explicit list (`-`,
 * `*`, `1.`), else blank-line paragraphs, else sentence packing — and tags each unit with the kind
 * of artifact it builds (table / component / route / page / …) by keyword. Every sub-prompt carries
 * the FULL assembled context (governance excerpts, Build Memory warnings, previous Sentinel — the
 * Contract-7 injection the assembler already produced); only the ACTION is narrowed, via an explicit
 * "build ONLY this sub-step" focus footer. A description that will not split (one atomic unit) is run
 * exactly as before — the Decomposer is a no-op, not a degradation.
 *
 * NON-FATAL / INJECTABLE house style (matching claude-runner, git-manager, the Sentinel): every
 * collaborator — the claude runner, the Sentinel runner, the per-sub-prompt commit, and the Build
 * Memory decomposition record — is INJECTED, so this module unit-tests with no `claude`, no git, and
 * no database. Nothing throws: a sub-prompt whose claude call fails or whose Sentinel goes red stops
 * the sequence and surfaces in the {@link DecompositionResult} (Iron Law 3 — report the real
 * outcome, never fabricate a pass). The result includes a synthetic, aggregate {@link ClaudeRunResult}
 * so the executor's downstream logic (commit / final Sentinel / merge / record) is unchanged — it
 * treats a decomposed run exactly like a single claude run, plus the per-sub-prompt detail.
 *
 * BUILD MEMORY (pattern learning): when a prompt is actually decomposed, the Decomposer hands the
 * executor a {@link DecompositionRecord} (how many sub-prompts, of what kinds, how many retried,
 * how many failed) via the injected `recordDecomposition` sink. The executor persists it to Build
 * Memory so Phase 5 can learn which prompt shapes need splitting and how reliably the splits land.
 *
 * BOUNDARY: this module never reads or writes any file directly — all execution flows through the
 * injected collaborators, which operate on the TARGET project (Iron Law 1). It owns only the
 * splitting logic and the sequencing.
 */

import { createHash } from 'node:crypto';

import type { ClaudeRunResult } from './claude-runner.js';
import type { SentinelResult } from '../phases/phase4-sentinel.js';
import type { PromptType } from './queue-generator.js';

// ---------------------------------------------------------------------------
// Public contract — tunables
// ---------------------------------------------------------------------------

/**
 * Prompt-`description` length (characters) at/over which a prompt is decomposed. The task spec:
 * "any prompt with description length over 1500 characters". Strictly greater-than.
 */
export const DECOMPOSITION_THRESHOLD = 1500;

/** Max RETRIES of a single failing sub-prompt before the decomposition stops (Contract 14 echo). */
export const DEFAULT_MAX_SUBPROMPT_RETRIES = 2;

/** Target character budget when packing an unstructured description into atomic chunks. */
const TARGET_CHUNK_CHARS = 700;

/** A unit shorter than this (trimmed) is folded into its neighbour rather than standing alone. */
const MIN_UNIT_CHARS = 24;

/** Cap for a derived sub-prompt title (the rest of the unit text still rides in the body). */
const MAX_TITLE_CHARS = 80;

// ---------------------------------------------------------------------------
// Public contract — types
// ---------------------------------------------------------------------------

/** The kind of artifact an atomic sub-prompt builds (keyword-inferred; drives the focus label). */
export type AtomicKind =
  | 'table'
  | 'route'
  | 'component'
  | 'page'
  | 'function'
  | 'policy'
  | 'test'
  | 'config'
  | 'task';

/** One atomic unit of work carved out of a large prompt. */
export interface SubPrompt {
  /** 1-based position within this decomposition. */
  index: number;
  /** The inferred artifact kind. */
  kind: AtomicKind;
  /** Short human-readable label (the unit's first line/sentence, capped). */
  title: string;
  /** The atomic task text (the carved-out slice of the original description). */
  task: string;
  /** The full claude input: the shared assembled context + this sub-step's focus footer. */
  promptText: string;
  /** SHA-256 of `promptText` (for the prompt_execution-style record / dedup). */
  hash: string;
}

/** The outcome of executing a single sub-prompt (including any retries). */
export interface SubPromptOutcome {
  index: number;
  kind: AtomicKind;
  title: string;
  /** Final disposition of this sub-prompt. */
  status: 'completed' | 'failed';
  /** Number of claude attempts spent on this sub-prompt (1 = no retry). */
  attempts: number;
  /** Sum of the coarse per-attempt token estimates for this sub-prompt. */
  tokensEstimated: number;
  /** Whether the Sentinel passed after the final attempt (null when no Sentinel ran). */
  sentinelPassed: boolean | null;
  /** The first failed Sentinel check on the final attempt, when failed. */
  failedCheck: string | null;
  /** Short note on what happened. */
  note: string;
}

/** The minimal parent-prompt facts the Decomposer needs (a slice of the queue entry). */
export interface DecompositionParent {
  id: string;
  name: string;
  promptType: PromptType;
  /** 1-based position of the parent prompt in the executed order (for labelling/commits). */
  index: number;
  /** The parent prompt's buildable task text — the thing that gets split. */
  description: string;
}

/**
 * The pattern-learning payload handed to the injected `recordDecomposition` sink (Build Memory).
 * Captures the SHAPE of the decomposition, not the content, so Phase 5 can learn which prompt kinds
 * need splitting and how reliably the splits land.
 */
export interface DecompositionRecord {
  promptId: string;
  promptName: string;
  promptType: PromptType;
  /** Length of the parent description that triggered the split. */
  descriptionLength: number;
  /** How many atomic sub-prompts the description split into. */
  subPromptCount: number;
  /** The kind of each sub-prompt, in order. */
  subPromptKinds: AtomicKind[];
  /** How many sub-prompts completed (Sentinel passed). */
  succeeded: number;
  /** How many sub-prompts failed (Sentinel red after retries). */
  failed: number;
  /** Total RETRY attempts spent across all sub-prompts (attempts beyond the first). */
  totalRetries: number;
}

/** The collaborators the Decomposer drives — all injected so it tests with no claude/git/DB. */
export interface DecompositionDeps {
  /** Run one claude prompt against the target project. Default in the executor: the claude-runner. */
  runClaude: (prompt: string) => Promise<ClaudeRunResult>;
  /** Run the Phase 4 Sentinel against the target project (the inter-sub-prompt health check). */
  runSentinel: () => Promise<SentinelResult>;
  /** Commit the sub-prompt's work so the next Sentinel/diff sees it. Optional (tests may omit). */
  commit?: (message: string) => void;
  /** Persist the {@link DecompositionRecord} to Build Memory (pattern learning). Optional. */
  recordDecomposition?: (record: DecompositionRecord) => void | Promise<void>;
  /** Max retries of a single failing sub-prompt. Default {@link DEFAULT_MAX_SUBPROMPT_RETRIES}. */
  maxRetriesPerSubPrompt?: number;
  /** Progress reporter. Default: a no-op (the executor passes its own logger). */
  log?: (message: string) => void;
}

/** The complete result of {@link runDecomposedPrompt}. */
export interface DecompositionResult {
  /** True when the description actually split into ≥2 atomic sub-prompts. */
  decomposed: boolean;
  /** Per-sub-prompt outcomes, in executed order (a single entry when not decomposed). */
  subPrompts: SubPromptOutcome[];
  /**
   * A synthetic, aggregate {@link ClaudeRunResult} the executor consumes exactly like a single
   * claude run: `success` is true iff every sub-prompt completed; tokens/duration are summed.
   */
  aggregateRun: ClaudeRunResult;
  /**
   * The Sentinel result from the LAST executed sub-prompt (the gate the executor reuses instead of
   * re-running Sentinel). Null only when nothing executed.
   */
  finalSentinel: SentinelResult | null;
  /** The pattern-learning record (present iff `decomposed`). */
  record: DecompositionRecord | null;
  /** Short human-readable summary of the decomposition. */
  note: string;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Should this prompt be decomposed? True when the parent `description` exceeds `threshold`
 * characters (default {@link DECOMPOSITION_THRESHOLD}).
 */
export function shouldDecompose(description: string, threshold: number = DECOMPOSITION_THRESHOLD): boolean {
  return typeof description === 'string' && description.length > threshold;
}

// ---------------------------------------------------------------------------
// Deterministic split
// ---------------------------------------------------------------------------

/** Keyword → artifact-kind table, checked in order (first match wins). */
const KIND_PATTERNS: ReadonlyArray<{ kind: AtomicKind; re: RegExp }> = [
  { kind: 'table', re: /\b(table|schema|migration|rls\b|column|index|database|enum)\b/i },
  { kind: 'route', re: /\b(route|endpoint|api\b|handler|GET|POST|PUT|PATCH|DELETE|webhook)\b/i },
  { kind: 'policy', re: /\b(policy|permission|role|guard|rbac|authoriz)\b/i },
  { kind: 'page', re: /\b(page|screen|view|dashboard|layout|settings screen)\b/i },
  { kind: 'component', re: /\b(component|button|modal|navbar|sidebar|card|form|widget|table view|chart)\b/i },
  { kind: 'test', re: /\b(test|spec|playwright|e2e|assertion)\b/i },
  { kind: 'config', re: /\b(config|env var|environment|setting|toolchain|package\.json)\b/i },
  { kind: 'function', re: /\b(function|util|helper|method|service|hook)\b/i },
];

/** Infer the artifact kind of a unit of task text by keyword (defaults to `'task'`). */
function inferKind(text: string): AtomicKind {
  for (const { kind, re } of KIND_PATTERNS) {
    if (re.test(text)) return kind;
  }
  return 'task';
}

/** Strip a leading list marker (`-`, `*`, `+`, `1.`, `2)`) from a line. */
function stripMarker(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
}

/** Derive a short title from a unit of task text (first line/sentence, marker-stripped, capped). */
function deriveTitle(text: string): string {
  const firstLine = (text.split(/\r?\n/, 1)[0] ?? '').trim();
  const base = stripMarker(firstLine) || text.trim();
  const sentence = (base.split(/(?<=[.!?])\s+/, 1)[0] ?? base).trim();
  const title = sentence.length > 0 ? sentence : base;
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : title;
}

/** Pull explicit list items out of a description (each item incl. its continuation lines). */
function extractListItems(description: string): string[] {
  const lines = description.split(/\r?\n/);
  const markerRe = /^\s*(?:[-*+]|\d+[.)])\s+/;
  const items: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (markerRe.test(line)) {
      if (current) items.push(current.join('\n').trim());
      current = [stripMarker(line)];
    } else if (current) {
      // A continuation line of the current item (blank line ends the item).
      if (line.trim() === '') {
        items.push(current.join('\n').trim());
        current = null;
      } else {
        current.push(line.trim());
      }
    }
  }
  if (current) items.push(current.join('\n').trim());
  return items.filter((s) => s.length > 0);
}

/** Split a description into blank-line-delimited paragraphs. */
function splitParagraphs(description: string): string[] {
  return description
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Greedily pack a description's sentences into chunks of ≈{@link TARGET_CHUNK_CHARS}. */
function packSentences(description: string): string[] {
  const sentences = description
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const chunks: string[] = [];
  let buffer = '';
  for (const sentence of sentences) {
    if (buffer === '') {
      buffer = sentence;
    } else if (buffer.length + 1 + sentence.length <= TARGET_CHUNK_CHARS) {
      buffer = `${buffer} ${sentence}`;
    } else {
      chunks.push(buffer);
      buffer = sentence;
    }
  }
  if (buffer !== '') chunks.push(buffer);
  return chunks;
}

/** Fold any unit shorter than {@link MIN_UNIT_CHARS} into its neighbour (keeps units substantial). */
function mergeTinyUnits(units: string[]): string[] {
  const merged: string[] = [];
  for (const unit of units) {
    if (unit.trim().length < MIN_UNIT_CHARS && merged.length > 0) {
      const last = merged.length - 1;
      merged[last] = `${merged[last] ?? ''}\n${unit}`.trim();
    } else {
      merged.push(unit.trim());
    }
  }
  // If the very first unit was tiny and there was no previous to fold into, fold it forward.
  if (merged.length >= 2 && (merged[0] ?? '').length < MIN_UNIT_CHARS) {
    const head = merged.shift() ?? '';
    merged[0] = `${head}\n${merged[0] ?? ''}`.trim();
  }
  return merged.filter((u) => u.length > 0);
}

/** Build the full claude input for one sub-prompt: shared context + a "build ONLY this" footer. */
function buildSubPromptText(
  assembledPrompt: string,
  parent: DecompositionParent,
  unit: { kind: AtomicKind; title: string; task: string },
  i: number,
  n: number
): string {
  const footer = [
    '',
    '────────────────────────────────────────────────────────────────────',
    `DECOMPOSED SUB-STEP ${i} OF ${n} — build ONLY this atomic unit now.`,
    '',
    `This prompt ("${parent.name}", type ${parent.promptType}) was automatically split into ${n}`,
    'atomic sub-steps so each is built and health-checked independently. ALL of the context above',
    'still applies. Do NOT build the other sub-steps in this step — each has its own step and its own',
    'Sentinel check. Implement exactly this one discrete unit, completely and correctly:',
    '',
    `THIS SUB-STEP (${unit.kind}): ${unit.title}`,
    '',
    unit.task,
    '────────────────────────────────────────────────────────────────────',
  ].join('\n');
  return `${assembledPrompt}\n${footer}\n`;
}

/**
 * Split a large prompt into atomic {@link SubPrompt}s, deterministically. Prefers the author's own
 * structure (explicit list → paragraphs → sentence packing). Returns ONE sub-prompt when the
 * description does not split (the caller then runs it as a normal single prompt). Pure — no I/O.
 */
export function decompose(parent: DecompositionParent, assembledPrompt: string): SubPrompt[] {
  const description = parent.description ?? '';

  // 1. Choose the finest natural granularity that yields ≥2 units.
  let rawUnits = extractListItems(description);
  if (rawUnits.length < 2) rawUnits = splitParagraphs(description);
  if (rawUnits.length < 2) rawUnits = packSentences(description);
  if (rawUnits.length < 2) rawUnits = description.trim() === '' ? [] : [description.trim()];

  const units = mergeTinyUnits(rawUnits);
  const n = units.length;

  return units.map((task, idx) => {
    const i = idx + 1;
    const kind = inferKind(task);
    const title = deriveTitle(task);
    const promptText =
      n >= 2 ? buildSubPromptText(assembledPrompt, parent, { kind, title, task }, i, n) : assembledPrompt;
    return {
      index: i,
      kind,
      title,
      task,
      promptText,
      hash: createHash('sha256').update(promptText, 'utf8').digest('hex'),
    };
  });
}

// ---------------------------------------------------------------------------
// Sequential execution
// ---------------------------------------------------------------------------

/** Accumulator for synthesising the aggregate {@link ClaudeRunResult} across sub-prompts. */
interface RunAccumulator {
  stdout: string[];
  stderr: string[];
  durationMs: number;
  tokensEstimated: number;
  timedOut: boolean;
}

/** Fold one claude run into the aggregate accumulator. */
function accumulate(acc: RunAccumulator, run: ClaudeRunResult, label: string): void {
  if (run.stdout) acc.stdout.push(`# ${label}\n${run.stdout}`);
  if (run.stderr) acc.stderr.push(`# ${label}\n${run.stderr}`);
  acc.durationMs += run.durationMs;
  acc.tokensEstimated += run.tokensEstimated;
  if (run.timedOut) acc.timedOut = true;
}

/** Build the synthetic aggregate run the executor consumes like a single claude run. */
function aggregateRunOf(acc: RunAccumulator, success: boolean): ClaudeRunResult {
  return {
    stdout: acc.stdout.join('\n\n'),
    stderr: acc.stderr.join('\n\n'),
    exitCode: success ? 0 : 1,
    durationMs: acc.durationMs,
    tokensEstimated: acc.tokensEstimated,
    timedOut: acc.timedOut,
    signal: null,
    success,
  };
}

/**
 * Decompose `parent` (already known to exceed the threshold) and execute its atomic sub-prompts
 * SEQUENTIALLY, running the Sentinel between each. A failing sub-prompt retries IN ISOLATION up to
 * `maxRetriesPerSubPrompt`; on exhaustion the sequence stops and the result reports the failure. The
 * sub-prompts that already passed are never re-run. Records the decomposition shape to Build Memory
 * (when it actually split). Never throws — every collaborator is guarded.
 *
 * @param parent           The parent prompt facts (the `description` is what gets split).
 * @param assembledPrompt  The fully assembled prompt text (Contract-7 context) each sub-prompt rides.
 * @param deps             Injected collaborators (claude runner, Sentinel runner, commit, record).
 */
export async function runDecomposedPrompt(
  parent: DecompositionParent,
  assembledPrompt: string,
  deps: DecompositionDeps
): Promise<DecompositionResult> {
  const log = deps.log ?? (() => {});
  const maxRetries = Math.max(0, deps.maxRetriesPerSubPrompt ?? DEFAULT_MAX_SUBPROMPT_RETRIES);
  const subPrompts = decompose(parent, assembledPrompt);
  const n = subPrompts.length;
  const acc: RunAccumulator = { stdout: [], stderr: [], durationMs: 0, tokensEstimated: 0, timedOut: false };

  // Degenerate: the description did not split — run it once, exactly like a normal prompt. The
  // executor's own Sentinel/merge then handle it, so we do NOT run an inter-step Sentinel here.
  if (n < 2) {
    const only = subPrompts[0];
    const run = await deps.runClaude(only ? only.promptText : assembledPrompt);
    accumulate(acc, run, 'whole prompt (not decomposed)');
    if (deps.commit) {
      deps.commit(`[FORGE] ${parent.promptType}: ${parent.name}\n\nPrompt ${parent.index} (${parent.id}).`);
    }
    log(`prompt ${parent.index} '${parent.id}': description did not split (${parent.description.length} chars) — ran as one.`);
    return {
      decomposed: false,
      subPrompts: [
        {
          index: 1,
          kind: only?.kind ?? 'task',
          title: only?.title ?? parent.name,
          status: run.success ? 'completed' : 'failed',
          attempts: 1,
          tokensEstimated: run.tokensEstimated,
          sentinelPassed: null,
          failedCheck: null,
          note: run.success ? 'Ran as a single prompt (no atomic split found).' : 'Single-prompt run failed.',
        },
      ],
      aggregateRun: aggregateRunOf(acc, run.success),
      finalSentinel: null,
      record: null,
      note: `Not decomposed — description (${parent.description.length} chars) yielded a single atomic unit.`,
    };
  }

  log(
    `prompt ${parent.index} '${parent.id}': decomposed (${parent.description.length} chars) into ${n} atomic sub-prompt(s) ` +
      `[${subPrompts.map((s) => s.kind).join(', ')}]. Executing sequentially with Sentinel between each.`
  );

  const outcomes: SubPromptOutcome[] = [];
  let finalSentinel: SentinelResult | null = null;
  let allCompleted = true;
  let totalRetries = 0;

  for (const sub of subPrompts) {
    let attempts = 0;
    let subTokens = 0;
    let completed = false;
    let sentinel: SentinelResult | null = null;

    // Run + Sentinel; retry THIS sub-prompt in isolation until green or retries exhausted.
    while (attempts <= maxRetries) {
      attempts += 1;
      if (attempts > 1) totalRetries += 1;
      const isRetry = attempts > 1;

      const run = await deps.runClaude(sub.promptText);
      subTokens += run.tokensEstimated;
      accumulate(acc, run, `sub-step ${sub.index}/${n} (${sub.kind}: ${sub.title})${isRetry ? ` retry ${attempts - 1}` : ''}`);

      if (deps.commit) {
        deps.commit(
          `[FORGE] ${parent.promptType}: ${parent.name} — sub-step ${sub.index}/${n} (${sub.title})` +
            `${isRetry ? ` (retry ${attempts - 1})` : ''}\n\nPrompt ${parent.index} (${parent.id}), atomic ${sub.kind}.`
        );
      }

      sentinel = await deps.runSentinel();

      if (run.success && sentinel.passed) {
        completed = true;
        break;
      }
      const why = !run.success ? `claude exit ${run.exitCode ?? 'null'}${run.timedOut ? '/timeout' : ''}` : `Sentinel ${sentinel.failedCheck ?? 'fail'}`;
      log(
        `prompt ${parent.index} '${parent.id}': sub-step ${sub.index}/${n} attempt ${attempts} failed (${why})` +
          (attempts <= maxRetries ? ' — retrying this sub-step only.' : ' — retries exhausted.')
      );
    }

    finalSentinel = sentinel;
    outcomes.push({
      index: sub.index,
      kind: sub.kind,
      title: sub.title,
      status: completed ? 'completed' : 'failed',
      attempts,
      tokensEstimated: subTokens,
      sentinelPassed: sentinel ? sentinel.passed : null,
      failedCheck: sentinel ? sentinel.failedCheck : null,
      note: completed
        ? `Completed in ${attempts} attempt(s); Sentinel passed.`
        : `Failed after ${attempts} attempt(s); ${sentinel ? `Sentinel ${sentinel.failedCheck ?? 'failed'}` : 'no Sentinel'}.`,
    });

    if (!completed) {
      // Only this sub-prompt failed — stop the sequence (the prior sub-prompts stay done).
      allCompleted = false;
      log(`prompt ${parent.index} '${parent.id}': halting decomposition at sub-step ${sub.index}/${n} (failed).`);
      break;
    }
  }

  const succeeded = outcomes.filter((o) => o.status === 'completed').length;
  const failed = outcomes.filter((o) => o.status === 'failed').length;
  const record: DecompositionRecord = {
    promptId: parent.id,
    promptName: parent.name,
    promptType: parent.promptType,
    descriptionLength: parent.description.length,
    subPromptCount: n,
    subPromptKinds: subPrompts.map((s) => s.kind),
    succeeded,
    failed,
    totalRetries,
  };

  // Build Memory: record the decomposition shape for Phase 5 pattern learning (guarded/non-fatal).
  if (deps.recordDecomposition) {
    try {
      await deps.recordDecomposition(record);
    } catch (error) {
      log(`prompt ${parent.index} '${parent.id}': recordDecomposition degraded (${describe(error)}).`);
    }
  }

  const note = allCompleted
    ? `Decomposed into ${n} atomic sub-prompt(s); all completed (${totalRetries} retr${totalRetries === 1 ? 'y' : 'ies'}).`
    : `Decomposed into ${n}; ${succeeded} completed, then sub-step ${outcomes.length}/${n} failed — sequence halted.`;
  log(`prompt ${parent.index} '${parent.id}': ${note}`);

  return {
    decomposed: true,
    subPrompts: outcomes,
    aggregateRun: aggregateRunOf(acc, allCompleted),
    finalSentinel,
    record,
    note,
  };
}

/** Render an unknown thrown value as a short string for logging. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default runDecomposedPrompt;
