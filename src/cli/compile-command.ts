/**
 * FORGE 2.0 — `forge compile`: merge a prompt library into one master queue.yaml.
 *
 * Session 3 (Autonomy) introduces a PROMPT-LIBRARY workflow as an alternative to Phase 2's
 * single-shot Queue Generator: individual queue entries live as one-entry-per-file YAML under
 * a `prompts/` directory (hand-written, or authored by `forge generate-prompts` —
 * `src/cli/generate-prompts-command.ts`), sequenced by filename/directory prefix, and merged
 * here into ONE master `queue.yaml` — with a MANDATORY context re-anchor entry injected every
 * 15 real entries, so a 100+ prompt build never drifts across Claude Code session resets.
 *
 * Reuses the Queue Generator's own serialization (`serializeQueue`/`computeStats`) so the
 * compiled queue.yaml is byte-for-byte the same shape Phase 2 emits, and Phase 3's own
 * `parseSingleQueueEntryYaml` (extracted from `parseQueueYaml`) for the tolerant per-file
 * coercion — neither is duplicated here.
 *
 * NON-FATAL / VALIDATED house style: `runCompile` never throws — a validation problem (a
 * duplicate id, a dangling dependency, an empty prompts dir) is returned as `problems`
 * WITHOUT writing anything; the CLI wrapper prints every problem and exits non-zero.
 */

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

import chalk from 'chalk';

import type { QueueEntry, QueueStats } from '../engine/queue-generator.js';
import { serializeQueue, computeStats } from '../engine/queue-generator.js';
import { parseSingleQueueEntryYaml } from '../phases/phase3-executor.js';
import { snapshotQueue } from '../tools/queue-versioning.js';
import { nowIso } from '../memory/index.js';

// ---------------------------------------------------------------------------
// Re-anchor injection
// ---------------------------------------------------------------------------

/** Inject a mandatory context re-anchor after every this-many REAL (non-re-anchor) entries. */
export const REANCHOR_INTERVAL = 15;

/** Coarse token budget for a re-anchor entry (it reads + reports; it does not build). */
const REANCHOR_TOKENS = 2000;

/** Build the Nth generated re-anchor entry, depending ONLY on the entry that precedes it. */
export function buildReanchorEntry(n: number, precedingId: string): QueueEntry {
  return {
    id: `reanchor-${n}`,
    name: `Context re-anchor #${n}`,
    prompt_type: 'test',
    dependencies: [precedingId],
    governance_refs: [],
    estimated_tokens: REANCHOR_TOKENS,
    context_injection: { schemaSections: [], behavioralSections: [], interactionMaps: [] },
    description: [
      'FORGE CONTEXT RE-ANCHOR — mandatory checkpoint, injected automatically by `forge compile`',
      'every 15 prompts. This is NOT a build step.',
      '',
      'Do the following, IN ORDER, before anything else in this prompt:',
      '1. Re-read CLAUDE.md (if it exists at the project root) cold from disk.',
      '2. Re-read STATE_OF_THE_BUILD.md and SESSION_STATE.md cold from disk — do not rely on your',
      '   context window for their contents, since they may have changed since you last saw them.',
      "3. Verify the last 3 COMPLETED prompts' outputs actually exist on disk (the files, routes, or",
      '   tables they claim to have created or modified) — spot-check directly, do not assume.',
      '4. State, in ONE paragraph: what this build is, where it currently stands, and what comes',
      '   next.',
      '',
      'Fix nothing. Build nothing. This is a verification checkpoint only — the next prompt',
      'resumes normal build work.',
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Scanning + natural sequencing
// ---------------------------------------------------------------------------

/** Recursively collect every `*.yaml` file under `dir` (depth-first, order not yet significant). */
async function walkYamlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkYamlFiles(full)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.yaml')) {
      out.push(full);
    }
  }
  return out;
}

/** Normalize a relative path to forward slashes for stable, platform-independent sorting. */
function naturalKey(relPath: string): string {
  return relPath.split(sep).join('/');
}

/**
 * Sort prompt files by natural (numeric-aware) order of their path RELATIVE to `promptsDir`:
 * directory prefixes sort before file prefixes within each directory, and numeric prefixes
 * compare numerically (`01-`, `02-`, …, `010-`) rather than lexicographically. `01-users.yaml`
 * < `02-routes.yaml` < `010-extra.yaml`; `1-schema/01-users.yaml` < `2-api/01-routes.yaml`.
 */
export function sortPromptFiles(promptsDir: string, files: string[]): string[] {
  return [...files].sort((a, b) =>
    naturalKey(relative(promptsDir, a)).localeCompare(naturalKey(relative(promptsDir, b)), undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate the FINAL merged entry list: unique ids, dependencies resolve, at least one entry. */
export function validateEntries(entries: QueueEntry[]): string[] {
  const problems: string[] = [];
  if (entries.length === 0) {
    problems.push('No entries found — the compiled queue would be empty.');
    return problems;
  }

  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) problems.push(`Duplicate id '${id}' appears ${count} times.`);
  }

  const ids = new Set(entries.map((e) => e.id));
  for (const e of entries) {
    for (const dep of e.dependencies) {
      if (!ids.has(dep)) problems.push(`Entry '${e.id}' depends on unknown id '${dep}'.`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

export interface CompileOptions {
  /** Project root — used to derive default `promptsDir`/`outPath` and for the header/snapshot. */
  projectPath: string;
  /** Directory to scan for `*.yaml` prompt files. Default `<projectPath>/prompts`. */
  promptsDir?: string;
  /** Where to write the merged master queue.yaml. Default `<projectPath>/queue.yaml`. */
  outPath?: string;
  /** Project name for the queue.yaml header. Default: basename of `projectPath`. */
  projectName?: string;
  /** Progress reporter. Default no-op. */
  log?: (message: string) => void;
}

export interface CompileResult {
  success: boolean;
  outPath: string | null;
  /** The merged entries (including injected re-anchors), in final sequence. Populated even on failure for inspection. */
  entries: QueueEntry[];
  reanchorsInjected: number;
  /** Validation/parse problems. Empty on success. */
  problems: string[];
  stats: QueueStats | null;
}

/**
 * Compile a `prompts/` directory into one master queue.yaml. Pure/testable — does not print or
 * touch Build Memory; the CLI wrapper ({@link cmdCompile}) prints the result and snapshots it.
 * Never throws.
 */
export async function runCompile(options: CompileOptions): Promise<CompileResult> {
  const log = options.log ?? (() => {});
  const projectPath = options.projectPath;
  const promptsDir = options.promptsDir ?? join(projectPath, 'prompts');
  const outPath = options.outPath ?? join(projectPath, 'queue.yaml');
  const projectName = options.projectName ?? basename(projectPath) ?? 'project';

  if (!existsSync(promptsDir)) {
    return {
      success: false,
      outPath: null,
      entries: [],
      reanchorsInjected: 0,
      problems: [`Prompts directory not found: ${promptsDir}`],
      stats: null,
    };
  }

  const files = sortPromptFiles(promptsDir, await walkYamlFiles(promptsDir));
  log(`found ${files.length} prompt file(s) under ${promptsDir}`);

  const problems: string[] = [];
  const parsedEntries: QueueEntry[] = [];
  for (const file of files) {
    const label = relative(promptsDir, file);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      problems.push(`Could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const { entry, warnings } = parseSingleQueueEntryYaml(text, label);
    for (const w of warnings) problems.push(`${label}: ${w}`);
    if (entry) parsedEntries.push(entry);
  }

  // Re-anchor injection — automatic, never manually managed. Counts REAL entries only.
  const merged: QueueEntry[] = [];
  let realCount = 0;
  let reanchorsInjected = 0;
  for (const entry of parsedEntries) {
    merged.push(entry);
    realCount += 1;
    if (realCount % REANCHOR_INTERVAL === 0) {
      reanchorsInjected += 1;
      merged.push(buildReanchorEntry(reanchorsInjected, entry.id));
    }
  }
  if (reanchorsInjected > 0) log(`injected ${reanchorsInjected} re-anchor entry(ies) (every ${REANCHOR_INTERVAL} prompts)`);

  problems.push(...validateEntries(merged));

  if (problems.length > 0) {
    return { success: false, outPath: null, entries: merged, reanchorsInjected, problems, stats: null };
  }

  const stats = computeStats(merged);
  const generatedAt = nowIso();
  const yaml = serializeQueue(merged, { projectName, projectPath, generatedAt, stats });

  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, yaml, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      outPath: null,
      entries: merged,
      reanchorsInjected,
      problems: [`Failed to write ${outPath}: ${detail}`],
      stats,
    };
  }

  log(`wrote ${outPath} (${merged.length} entries)`);
  return { success: true, outPath, entries: merged, reanchorsInjected, problems: [], stats };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/** `forge compile [--prompts-dir <dir>] [--out <file>] [--project <path>]`. */
export async function cmdCompile(opts: { promptsDir?: string; out?: string; project?: string }): Promise<void> {
  const projectPath = opts.project ? join(opts.project) : process.cwd();
  const promptsDir = opts.promptsDir ? join(opts.promptsDir) : join(projectPath, 'prompts');
  const outPath = opts.out ? join(opts.out) : join(projectPath, 'queue.yaml');
  const projectName = basename(projectPath) || 'project';

  console.log(chalk.bold(`\nCompiling prompt library: ${promptsDir}`));
  const result = await runCompile({
    projectPath,
    promptsDir,
    outPath,
    projectName,
    log: (m) => console.log(chalk.dim(`  ${m}`)),
  });

  if (!result.success) {
    console.error(chalk.red.bold(`\n✖ Compile failed — ${result.problems.length} problem(s):`));
    for (const p of result.problems) console.error(chalk.red(`  • ${p}`));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.green(`\n✔ Compiled ${result.entries.length} entries → ${result.outPath}`));
  console.log(chalk.bold('\nSummary:'));
  console.log(`  total entries:  ${result.stats?.totalPrompts ?? result.entries.length}`);
  console.log(`  re-anchors:     ${result.reanchorsInjected}`);
  console.log(`  longest chain:  ${result.stats?.longestChain ?? '—'}`);
  if (result.stats) {
    console.log(chalk.bold('  per-type counts:'));
    for (const [type, count] of Object.entries(result.stats.byType)) {
      if (count > 0) console.log(`    ${type.padEnd(10, ' ')} ${count}`);
    }
  }

  try {
    const queueYaml = await readFile(result.outPath as string, 'utf8');
    const snap = await snapshotQueue({
      projectPath,
      projectName,
      queueYaml,
      entryCount: result.entries.length,
    });
    console.log(chalk.dim(`\nSnapshot: ${snap.snapshotPath} (hash ${snap.hash})`));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(chalk.yellow(`\nCould not snapshot queue version (non-fatal): ${detail}`));
  }
}
