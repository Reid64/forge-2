/**
 * FORGE 2.0 — CLI configuration loader.
 *
 * Loads FORGE's environment from a `.env` file (the BLUEPRINT "Environment
 * Variables" set) and exposes a single typed {@link ForgeConfig} the CLI commands
 * read. There is intentionally NO `dotenv` dependency — FORGE's dependency set is
 * locked (BLUEPRINT "Technology Decisions"), so this module ships a tiny, guarded
 * `.env` parser instead.
 *
 * House rules mirrored from the rest of FORGE:
 *   - Never throws. A missing/unreadable `.env` degrades to "use process.env only"
 *     with a collected warning — exactly the Contract-4 "degrade, don't halt" stance
 *     Build Memory takes (the CLI is usable with secrets exported in the shell and
 *     no file at all).
 *   - Pre-existing `process.env` values WIN over `.env` (the shell is authoritative).
 *   - Reading `.env` populates `process.env` so downstream modules that read it
 *     directly (the Supabase client, the phase model callers) see the same values.
 *
 * SECURITY: secret VALUES are never logged. {@link describeConfig} masks them.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { z, validateConfigFile } from '../tools/schema-validator.js';

/** The resolved FORGE configuration the CLI commands consume. */
export interface ForgeConfig {
  /** Self-hosted Supabase URL (Build Memory backend). */
  supabaseUrl: string | null;
  /** Supabase anon key (present for completeness; FORGE uses the service key). */
  supabaseAnonKey: string | null;
  /** Supabase service key — what the Build Memory client authenticates with. */
  supabaseServiceKey: string | null;
  /** Anthropic API key (Phase 1A/1B generation + agent creation). */
  anthropicApiKey: string | null;
  /** Per-machine id for multi-machine build coordination (Contract 4/20). */
  machineId: string;
  /** Project-archive directory (BLUEPRINT default `D:\forge-data`). */
  dataDir: string;
  /** Backup-drive directory (BLUEPRINT default `E:\forge-backups`). */
  backupDir: string;
  /** True once Build Memory is configured (URL + service key present). */
  buildMemoryEnabled: boolean;
  /** Absolute path of the `.env` file that was loaded, or null if none was found. */
  envFilePath: string | null;
  /** Non-fatal observations (no `.env`, parse issue, generated machine id, …). */
  warnings: string[];
}

/** BLUEPRINT defaults for the filesystem locations. */
const DEFAULT_DATA_DIR = 'D:\\forge-data';
const DEFAULT_BACKUP_DIR = 'E:\\forge-backups';

/**
 * Shape contract for the resolved configuration, used to validate it on load
 * (integration point 2 — config files validated with clear, path-pointed messages).
 * Deliberately tolerant of FORGE's degrade-don't-halt stance: the Supabase and
 * Anthropic credentials are `.nullable()` (stateless mode is a valid configuration),
 * but when `supabaseUrl` IS present it must be a well-formed URL, and the always-
 * resolved fields (machineId, dataDir, backupDir) must be non-empty.
 */
const ForgeConfigShapeSchema = z.object({
  supabaseUrl: z.string().url('FORGE_SUPABASE_URL must be a valid URL').nullable(),
  supabaseServiceKey: z.string().min(1).nullable(),
  anthropicApiKey: z.string().min(1).nullable(),
  machineId: z.string().min(1),
  dataDir: z.string().min(1),
  backupDir: z.string().min(1),
});

/**
 * Parse `.env` text into key/value pairs. Tolerant of comments (`#`), blank lines,
 * `export ` prefixes, surrounding quotes, and `KEY=` (empty). Never throws.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (key === '') continue;

    let value = withoutExport.slice(eq + 1).trim();
    // Strip a single pair of matching surrounding quotes.
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * Resolve the `.env` file to load. Preference order:
 *   1. `FORGE_ENV_FILE` (explicit override),
 *   2. `<cwd>/.env`,
 *   3. `<forge-install-root>/.env` (two dirs up from this compiled module:
 *      `dist/cli/config.js` → repo root).
 * Returns the first that exists, else null.
 */
function locateEnvFile(): string | null {
  const explicit = process.env.FORGE_ENV_FILE;
  if (explicit && existsSync(explicit)) return resolve(explicit);

  const cwdEnv = join(process.cwd(), '.env');
  if (existsSync(cwdEnv)) return cwdEnv;

  try {
    const here = dirname(fileURLToPath(import.meta.url)); // dist/cli
    const rootEnv = resolve(here, '..', '..', '.env'); // repo root
    if (existsSync(rootEnv)) return rootEnv;
  } catch {
    // import.meta.url unavailable — ignore, fall through.
  }
  return null;
}

/** A non-empty trimmed env value, or null. */
function envValue(key: string): string | null {
  const v = process.env[key];
  return v !== undefined && v.trim() !== '' ? v : null;
}

/**
 * Load FORGE configuration. Reads `.env` (if found) into `process.env` without
 * overwriting values already set in the shell, then snapshots the resolved config.
 * Always returns a config — never throws.
 */
export function loadConfig(): ForgeConfig {
  const warnings: string[] = [];

  // 1. Load a .env file into process.env (shell values win). ------------------
  const envFilePath = locateEnvFile();
  if (envFilePath) {
    try {
      const parsed = parseEnv(readFileSync(envFilePath, 'utf8'));
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`Could not read .env at ${envFilePath} (${detail}); using process.env only.`);
    }
  } else {
    warnings.push('No .env file found; relying on the current environment. Copy .env.example to .env to configure FORGE.');
  }

  // 2. Resolve a stable machine id (generate + set if absent). ----------------
  let machineId = envValue('FORGE_MACHINE_ID');
  if (!machineId) {
    machineId = randomUUID();
    process.env.FORGE_MACHINE_ID = machineId;
    warnings.push(
      `FORGE_MACHINE_ID not set — generated ${machineId} for this run. ` +
        'Persist it in .env so Build Memory coordinates this machine consistently.'
    );
  }

  // 3. Snapshot the config. ---------------------------------------------------
  const supabaseUrl = envValue('FORGE_SUPABASE_URL');
  const supabaseServiceKey = envValue('FORGE_SUPABASE_SERVICE_KEY');
  const anthropicApiKey = envValue('ANTHROPIC_API_KEY');

  const config: ForgeConfig = {
    supabaseUrl,
    supabaseAnonKey: envValue('FORGE_SUPABASE_ANON_KEY'),
    supabaseServiceKey,
    anthropicApiKey,
    machineId,
    dataDir: envValue('FORGE_DATA_DIR') ?? DEFAULT_DATA_DIR,
    backupDir: envValue('FORGE_BACKUP_DIR') ?? DEFAULT_BACKUP_DIR,
    buildMemoryEnabled: supabaseUrl !== null && supabaseServiceKey !== null,
    envFilePath,
    warnings,
  };

  // 4. Validate the resolved configuration on load (integration point 2). ------
  // `report: false` — Build Memory is not yet known to be reachable at config-load
  // time, so any shape problem is surfaced as a clear config WARNING rather than
  // logged to the (possibly-absent) `forge-validation` channel. `warnings` is the
  // same array referenced by `config.warnings`, so these reach the caller.
  const validated = validateConfigFile(ForgeConfigShapeSchema, config, {
    context: 'cli:config',
    target: '.env',
    report: false,
  });
  if (!validated.ok) {
    for (const issue of validated.issues) {
      warnings.push(`Config validation: ${issue.path} — ${issue.message}`);
    }
  }

  return config;
}

/** Mask a secret for display: show the first 4 chars, hide the rest. */
function mask(value: string | null): string {
  if (!value) return '—';
  if (value.length <= 4) return '****';
  return `${value.slice(0, 4)}…(${value.length} chars)`;
}

/**
 * A human-readable, SECRET-SAFE summary of the resolved config (for `forge status`
 * / diagnostics). Keys are shown; secret values are masked.
 */
export function describeConfig(config: ForgeConfig): string {
  return [
    `env file:        ${config.envFilePath ?? '(none)'}`,
    `machine id:      ${config.machineId}`,
    `Supabase URL:    ${config.supabaseUrl ?? '—'}`,
    `service key:     ${mask(config.supabaseServiceKey)}`,
    `anthropic key:   ${mask(config.anthropicApiKey)}`,
    `Build Memory:    ${config.buildMemoryEnabled ? 'enabled' : 'disabled (stateless mode)'}`,
    `data dir:        ${config.dataDir}`,
    `backup dir:      ${config.backupDir}`,
  ].join('\n');
}

export default loadConfig;
