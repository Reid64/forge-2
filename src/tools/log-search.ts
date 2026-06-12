/**
 * FORGE 2.0 — Log search (`log-search`).
 *
 * A small, dependency-light reader over the JSON-lines logs FORGE writes (one record per line under
 * `FORGE_LOG_DIR`, default `./logs`). {@link searchLogs} filters by level, module, prompt/build id,
 * a free-text substring and an ISO/epoch date range, returns the matches newest-first, and can
 * transparently include gzipped files rotated into `archive/`. A guarded `--flag` CLI at the bottom
 * exposes the same surface from the shell (`node dist/tools/log-search.js --level error`).
 *
 * It never throws on a malformed line — unparseable JSON is skipped — and reaches no other FORGE
 * module, so it can run standalone against a log directory copied off a build host.
 */

import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';

/** Pino numeric level → label, used for the `>= warn` style threshold match. */
const LEVELS: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** One parsed log record. Only the fields FORGE filters on are typed; the rest pass through. */
export interface LogRecord {
  time?: string | number;
  level?: string | number;
  module?: string;
  msg?: string;
  build_run_id?: string;
  buildRunId?: string;
  prompt_id?: string;
  promptId?: string;
  project?: string;
  [key: string]: unknown;
}

/** Filters for {@link searchLogs}. All optional — an empty query returns every record (up to `limit`). */
export interface LogSearchQuery {
  /** Exact level label, or — when prefixed with `>=` (e.g. `>=warn`) — that level and everything above it. */
  level?: string;
  module?: string;
  promptId?: string;
  buildRunId?: string;
  /** Case-insensitive substring matched against the rendered message. */
  contains?: string;
  /** Inclusive lower bound, ISO string or epoch ms. */
  from?: string | number;
  /** Inclusive upper bound, ISO string or epoch ms. */
  to?: string | number;
  /** Also read gzipped logs under `archive/`. Default false. */
  includeArchived?: boolean;
  /** Max records to return. Default 200. */
  limit?: number;
  /** Override the log directory (default `FORGE_LOG_DIR` or `./logs`). */
  logDir?: string;
}

function logDirOf(query: LogSearchQuery): string {
  return query.logDir ?? process.env['FORGE_LOG_DIR'] ?? join(process.cwd(), 'logs');
}

function toEpoch(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && value.trim() !== '') return asNumber;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function levelLabel(level: string | number | undefined): string | undefined {
  if (level === undefined) return undefined;
  if (typeof level === 'string') return level.toLowerCase();
  for (const [label, num] of Object.entries(LEVELS)) {
    if (num === level) return label;
  }
  return String(level);
}

function matches(record: LogRecord, query: LogSearchQuery): boolean {
  if (query.level) {
    const recordLabel = levelLabel(record.level);
    if (query.level.startsWith('>=')) {
      const floor = LEVELS[query.level.slice(2).toLowerCase()] ?? 0;
      const recordNum = recordLabel ? (LEVELS[recordLabel] ?? 0) : 0;
      if (recordNum < floor) return false;
    } else if (recordLabel !== query.level.toLowerCase()) {
      return false;
    }
  }

  if (query.module && record.module !== query.module) return false;

  if (query.promptId && record.promptId !== query.promptId && record.prompt_id !== query.promptId) {
    return false;
  }

  if (
    query.buildRunId &&
    record.buildRunId !== query.buildRunId &&
    record.build_run_id !== query.buildRunId
  ) {
    return false;
  }

  if (query.contains) {
    const haystack = (record.msg ?? JSON.stringify(record)).toLowerCase();
    if (!haystack.includes(query.contains.toLowerCase())) return false;
  }

  const fromEpoch = toEpoch(query.from);
  const toEpochBound = toEpoch(query.to);
  if (fromEpoch !== undefined || toEpochBound !== undefined) {
    const recordEpoch = toEpoch(record.time);
    if (recordEpoch === undefined) return false;
    if (fromEpoch !== undefined && recordEpoch < fromEpoch) return false;
    if (toEpochBound !== undefined && recordEpoch > toEpochBound) return false;
  }

  return true;
}

/** List the log files to scan, plain `.jsonl` first then (optionally) archived `.gz`. */
function logFiles(dir: string, includeArchived: boolean): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.jsonl') || name.endsWith('.log')) files.push(join(dir, name));
  }
  if (includeArchived) {
    const archive = join(dir, 'archive');
    if (existsSync(archive)) {
      for (const name of readdirSync(archive)) {
        if (name.endsWith('.gz')) files.push(join(archive, name));
      }
    }
  }
  return files;
}

async function readRecords(file: string): Promise<LogRecord[]> {
  const raw = createReadStream(file);
  const stream = file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const records: LogRecord[] = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed) as LogRecord);
    } catch {
      // Skip malformed lines — a partially-flushed final line should never abort the search.
    }
  }
  return records;
}

/**
 * Search the FORGE JSON-lines logs. Returns matching records sorted newest-first, capped at
 * `query.limit` (default 200). Never throws — unreadable files and malformed lines are skipped.
 */
export async function searchLogs(query: LogSearchQuery = {}): Promise<LogRecord[]> {
  const dir = logDirOf(query);
  const files = logFiles(dir, query.includeArchived ?? false);

  const all: LogRecord[] = [];
  for (const file of files) {
    let records: LogRecord[];
    try {
      records = await readRecords(file);
    } catch {
      continue; // unreadable / truncated gzip — skip the whole file rather than fail the search
    }
    for (const record of records) {
      if (matches(record, query)) all.push(record);
    }
  }

  all.sort((a, b) => (toEpoch(b.time) ?? 0) - (toEpoch(a.time) ?? 0));
  return all.slice(0, query.limit ?? 200);
}

// ---------------------------------------------------------------------------
// CLI — guarded so importing this module never runs it.
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): LogSearchQuery {
  const query: LogSearchQuery = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === undefined || !flag.startsWith('--')) continue;
    const key = flag.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      if (key === 'includeArchived' || key === 'archived') query.includeArchived = true;
      continue;
    }
    i += 1;
    switch (key) {
      case 'level':
        query.level = value;
        break;
      case 'module':
        query.module = value;
        break;
      case 'promptId':
        query.promptId = value;
        break;
      case 'buildRunId':
        query.buildRunId = value;
        break;
      case 'contains':
        query.contains = value;
        break;
      case 'from':
        query.from = value;
        break;
      case 'to':
        query.to = value;
        break;
      case 'limit':
        query.limit = Number(value);
        break;
      case 'logDir':
        query.logDir = value;
        break;
      case 'includeArchived':
      case 'archived':
        query.includeArchived = value !== 'false';
        break;
      default:
        break;
    }
  }
  return query;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;

if (invokedDirectly) {
  searchLogs(parseArgs(process.argv.slice(2)))
    .then((records) => {
      for (const record of records) {
        process.stdout.write(`${JSON.stringify(record)}\n`);
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`log-search failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
