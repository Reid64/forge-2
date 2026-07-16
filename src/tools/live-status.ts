/**
 * FORGE 2.0 — Live build-status writer (Session 4 — Intelligence & Observability, Task 3).
 *
 * Maintains `<project>/.forge/live-status.json`, updated at every prompt lifecycle point
 * (start, assembled, executing, sentinel, merged/failed/recovering), so `forge status
 * [--watch]` — or any other process — can render what a build is doing in real time from a
 * SEPARATE terminal, with no coupling to the build process itself (just a JSON file on disk).
 *
 * Atomic writes: every update writes to a temp file in the same directory, then renames it over
 * the real path — a reader never observes a partially-written file (rename is atomic on both
 * POSIX and Windows NTFS within the same volume).
 *
 * NON-FATAL house style: every write is guarded. A disk failure degrades to a no-op — observing
 * a build's status is a convenience, never a build-blocking concern.
 */

import { mkdir, rename, writeFile, readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** One lifecycle phase a prompt can be observed in. */
export type LiveStatusPhase =
  | 'start'
  | 'assembled'
  | 'executing'
  | 'sentinel'
  | 'merged'
  | 'failed'
  | 'recovering'
  | 'skipped';

export interface LiveStatusCurrentPrompt {
  index: number;
  id: string;
  name: string;
  type: string;
  phase: LiveStatusPhase;
}

export interface LiveStatusTotals {
  completed: number;
  failed: number;
  remaining: number;
  tokensEstimated: number;
  costEstimatedUsd: number;
  /** Running sum of every completed prompt's wall-clock duration, in ms (Session 5 finding #12/#7). */
  totalElapsedMs: number;
}

export interface LiveStatusSentinel {
  passed: boolean;
  failedCheck: string | null;
}

export interface LiveStatusEvent {
  timestamp: string;
  message: string;
}

/** The full shape of `live-status.json`. */
export interface LiveStatus {
  buildRunId: string | null;
  project: string;
  startedAt: string;
  updatedAt: string;
  currentPrompt: LiveStatusCurrentPrompt | null;
  totals: LiveStatusTotals;
  lastSentinel: LiveStatusSentinel | null;
  /** Most recent events first is NOT assumed — this is append order, oldest first, capped at 20. */
  recentEvents: LiveStatusEvent[];
  brainInterventions: number;
}

const MAX_RECENT_EVENTS = 20;

/** Resolve the live-status.json path for a project. */
export function liveStatusPath(projectPath: string): string {
  return join(projectPath, '.forge', 'live-status.json');
}

/** Read and parse `live-status.json` synchronously, or `null` if absent/unparseable. Never throws. */
export function readLiveStatus(projectPath: string): LiveStatus | null {
  try {
    const text = readFileSync(liveStatusPath(projectPath), 'utf8');
    return JSON.parse(text) as LiveStatus;
  } catch {
    return null;
  }
}

/**
 * Maintains one build's `live-status.json`. Construct once at build start (Phase 3 wires this
 * in `runPhase3Executor`), then call the lifecycle methods at each point in the prompt loop.
 * Every method is guarded — a write failure is swallowed, never thrown.
 */
export class LiveStatusWriter {
  private readonly projectPath: string;
  private status: LiveStatus;
  private writing: Promise<void> = Promise.resolve();

  constructor(projectPath: string, project: string, buildRunId: string | null, totalPrompts: number) {
    this.projectPath = projectPath;
    const now = new Date().toISOString();
    this.status = {
      buildRunId,
      project,
      startedAt: now,
      updatedAt: now,
      currentPrompt: null,
      totals: { completed: 0, failed: 0, remaining: totalPrompts, tokensEstimated: 0, costEstimatedUsd: 0, totalElapsedMs: 0 },
      lastSentinel: null,
      recentEvents: [],
      brainInterventions: 0,
    };
  }

  /** Current in-memory snapshot (for tests / synchronous inspection). */
  snapshot(): LiveStatus {
    return JSON.parse(JSON.stringify(this.status)) as LiveStatus;
  }

  /** Record a prompt entering a lifecycle phase. Writes the file. Never throws. */
  async promptPhase(prompt: LiveStatusCurrentPrompt, message?: string): Promise<void> {
    this.status.currentPrompt = prompt;
    await this.append(message ?? `prompt ${prompt.index} '${prompt.id}' (${prompt.type}): ${prompt.phase}`);
  }

  /** Record the latest Sentinel result. Writes the file. Never throws. */
  async sentinelResult(result: LiveStatusSentinel): Promise<void> {
    this.status.lastSentinel = result;
    await this.append(
      result.passed ? 'Sentinel PASS' : `Sentinel FAIL (${result.failedCheck ?? 'unknown'})`
    );
  }

  /** Record a Build Brain intervention. Writes the file. Never throws. */
  async brainIntervention(message: string): Promise<void> {
    this.status.brainInterventions += 1;
    await this.append(message);
  }

  /** Update the running totals (completed/failed/remaining/tokens/cost). Writes the file. */
  async totals(patch: Partial<LiveStatusTotals>): Promise<void> {
    this.status.totals = { ...this.status.totals, ...patch };
    await this.write();
  }

  /** Append a bare event line without changing any other field. Writes the file. */
  async event(message: string): Promise<void> {
    await this.append(message);
  }

  /** Push an event (capped at the last 20) and persist. Internal — all public methods route here. */
  private async append(message: string): Promise<void> {
    this.status.recentEvents.push({ timestamp: new Date().toISOString(), message });
    if (this.status.recentEvents.length > MAX_RECENT_EVENTS) {
      this.status.recentEvents = this.status.recentEvents.slice(-MAX_RECENT_EVENTS);
    }
    await this.write();
  }

  /** Atomic write: temp file in the same directory, then rename over the real path. Never throws. */
  private async write(): Promise<void> {
    this.status.updatedAt = new Date().toISOString();
    // Serialize concurrent writes (lifecycle calls can overlap) so renames never race each other.
    this.writing = this.writing.then(() => this.writeNow()).catch(() => {});
    await this.writing;
  }

  private async writeNow(): Promise<void> {
    try {
      const dir = join(this.projectPath, '.forge');
      await mkdir(dir, { recursive: true });
      const finalPath = liveStatusPath(this.projectPath);
      const tmpPath = join(dir, `.live-status.${randomUUID()}.tmp`);
      await writeFile(tmpPath, JSON.stringify(this.status, null, 2), 'utf8');
      await rename(tmpPath, finalPath);
    } catch {
      // non-fatal — observability must never block or fail a build
    }
  }
}

// ---------------------------------------------------------------------------
// IDE STATUS (VS Code integration layer) — SESSION_STATE.md's "## IDE STATUS" block.
// ---------------------------------------------------------------------------

/** Parsed shape of SESSION_STATE.md's "## IDE STATUS" section. */
export interface IdeStatus {
  vsCodePath: string | null;
  /** Manually set by a human (or their editor) to YES after reviewing CHANGESET.md; never auto-set. */
  changesetReviewed: boolean;
  lastChangesetDate: string | null;
}

const IDE_STATUS_HEADING = '## IDE STATUS';
const IDE_STATUS_DEFAULTS: IdeStatus = { vsCodePath: null, changesetReviewed: false, lastChangesetDate: null };

/** Common Windows install locations for VS Code, checked in order; first hit wins. */
function candidateVsCodePaths(): string[] {
  const candidates: string[] = [];
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  if (localAppData) candidates.push(join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'));
  if (programFiles) candidates.push(join(programFiles, 'Microsoft VS Code', 'Code.exe'));
  if (programFilesX86) candidates.push(join(programFilesX86, 'Microsoft VS Code', 'Code.exe'));
  return candidates;
}

/** Auto-detect an installed VS Code executable from common Windows install paths. Never throws. */
export function detectVsCodePath(): string | null {
  try {
    for (const candidate of candidateVsCodePaths()) {
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* best-effort — a detection failure just reads as "not detected" */
  }
  return null;
}

/** Render the "## IDE STATUS" section body (no trailing newline). */
function renderIdeStatusBlock(status: IdeStatus): string {
  return [
    IDE_STATUS_HEADING,
    '',
    `- **VS Code path:** ${status.vsCodePath ?? 'not detected'}`,
    `- **CHANGESET.md reviewed:** ${status.changesetReviewed ? 'YES' : 'NO'}`,
    `- **Last changeset date:** ${status.lastChangesetDate ?? 'none yet'}`,
  ].join('\n');
}

/** Parse the "## IDE STATUS" section out of SESSION_STATE.md text, or defaults if absent. */
export function parseIdeStatus(sessionStateText: string): IdeStatus {
  const headingIndex = sessionStateText.indexOf(IDE_STATUS_HEADING);
  if (headingIndex === -1) return { ...IDE_STATUS_DEFAULTS };
  const rest = sessionStateText.slice(headingIndex);
  const nextHeadingIndex = rest.indexOf('\n## ', 1);
  const section = nextHeadingIndex === -1 ? rest : rest.slice(0, nextHeadingIndex);
  const vsCodeMatch = section.match(/\*\*VS Code path:\*\*\s*(.+)/);
  const reviewedMatch = section.match(/\*\*CHANGESET\.md reviewed:\*\*\s*(\S+)/);
  const dateMatch = section.match(/\*\*Last changeset date:\*\*\s*(.+)/);
  const vsCodePathRaw = vsCodeMatch?.[1]?.trim() ?? null;
  const lastChangesetDateRaw = dateMatch?.[1]?.trim() ?? null;
  return {
    vsCodePath: vsCodePathRaw && vsCodePathRaw !== 'not detected' ? vsCodePathRaw : null,
    changesetReviewed: reviewedMatch?.[1]?.trim().toUpperCase() === 'YES',
    lastChangesetDate: lastChangesetDateRaw && lastChangesetDateRaw !== 'none yet' ? lastChangesetDateRaw : null,
  };
}

/** Read + parse the "## IDE STATUS" block from `<governanceDir>/SESSION_STATE.md`. Never throws. */
export function readIdeStatus(governanceDir: string): IdeStatus {
  try {
    return parseIdeStatus(readFileSync(join(governanceDir, 'SESSION_STATE.md'), 'utf8'));
  } catch {
    return { ...IDE_STATUS_DEFAULTS };
  }
}

/**
 * Refresh the "## IDE STATUS" block in `<governanceDir>/SESSION_STATE.md`: re-detects the VS Code
 * path and (when supplied) sets `lastChangesetDate`, but PRESERVES whatever `changesetReviewed`
 * value is already on disk — that field defaults to NO only when the block doesn't exist yet;
 * flipping it to YES is a manual human action this function must never perform on its own.
 * Inserts the section if missing, else replaces it in place. Guarded — a read/write failure is
 * logged and swallowed, never thrown (observability must never block or fail a build).
 */
export async function syncIdeStatus(
  governanceDir: string,
  opts: { lastChangesetDate?: string; log?: (message: string) => void } = {}
): Promise<void> {
  const path = join(governanceDir, 'SESSION_STATE.md');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    opts.log?.(
      `IDE STATUS: SESSION_STATE.md not readable at ${path} (${error instanceof Error ? error.message : String(error)}) — skipped`
    );
    return;
  }
  const current = parseIdeStatus(text);
  const next: IdeStatus = {
    vsCodePath: detectVsCodePath(),
    changesetReviewed: current.changesetReviewed,
    lastChangesetDate: opts.lastChangesetDate ?? current.lastChangesetDate,
  };
  const block = renderIdeStatusBlock(next);
  const headingIndex = text.indexOf(IDE_STATUS_HEADING);
  let updated: string;
  if (headingIndex === -1) {
    updated = `${text.replace(/\s*$/, '')}\n\n${block}\n`;
  } else {
    const before = text.slice(0, headingIndex);
    const rest = text.slice(headingIndex);
    const nextHeadingIndex = rest.indexOf('\n## ', 1);
    const after = nextHeadingIndex === -1 ? '\n' : rest.slice(nextHeadingIndex);
    updated = `${before}${block}\n${after}`;
  }
  try {
    await writeFile(path, updated, 'utf8');
  } catch (error) {
    opts.log?.(`IDE STATUS: SESSION_STATE.md write failed (${error instanceof Error ? error.message : String(error)})`);
  }
}
