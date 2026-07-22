/**
 * FORGE 2.0 — Autonomy: EnvValidator (src/autonomy/env-validator.ts).
 *
 * Phase 0's first act, before `ensureGitRepo` or anything else touches the target project:
 * confirm every environment variable a build genuinely cannot proceed without is actually
 * resolvable. Two independent catalogs feed the same check:
 *
 *   - {@link FORGE_ENV_REQUIREMENTS} — FORGE's own operational env vars (mirrors `.env.example`
 *     at the FORGE repo root). Per BEHAVIORAL_CONTRACTS Contract 4 ("degrade, never fail"), every
 *     one of these already has a documented fallback elsewhere in the codebase — SQLite Build
 *     Memory instead of Supabase (REBUILD Session 1), a deterministic PRD/architecture skeleton
 *     instead of a live model call (Session 5 finding #4), a generated `FORGE_MACHINE_ID` instead
 *     of a fixed one — so none of them is marked `required: true` here. The catalog exists so
 *     `validateEnv` has one place that knows FORGE's full env surface, and so format/vault-
 *     eligibility metadata lives somewhere real instead of being re-guessed ad hoc per call site.
 *   - {@link detectProjectEnvRequirements}(projectPath) — the TARGET project's own `.env.example`,
 *     read fresh per call. A key declared with NO default value (`KEY=` with nothing after the
 *     `=`) is the project's own author saying "a real build cannot run without this" —
 *     `required: true`. A key with any default value is optional context, `required: false`.
 *
 * {@link validateEnv} merges both catalogs and resolves every key against, in order:
 * `process.env`, then `<projectPath>/.env.local`, then the CredentialVault
 * (src/autonomy/credential-vault.ts) for the same key under this project — the same three
 * sources `CredentialVault.injectIntoEnv` (Phase 0 step 14) already treats as authoritative, just
 * consulted for validation rather than for writing. A required key resolvable from ANY of the
 * three counts as present. A present value is additionally checked against its `format` (when
 * one is declared) — a value that resolves but does not look right is reported as `invalid`,
 * distinct from `missing`.
 *
 * Like every other Phase 0 collaborator, this module is NON-FATAL by construction — a missing
 * `.env.example`, an unreadable `.env.local`, or an unavailable CredentialVault all degrade to
 * "nothing extra found," never a thrown error. The only thing that actually halts the pipeline is
 * `EnvValidationResult.allRequired === false`, which the caller (Phase 0) folds into its blocker
 * list exactly like every other Phase 0 gate (AgentShield's security scan, the toolchain audit,
 * …) — this module never halts by itself; it only ever reports.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createCredentialVault, type CredentialVault } from './credential-vault.js';
import { getLogger } from '../tools/forge-logger.js';

const log = getLogger('autonomy:env-validator');

/** One environment variable this build (FORGE's own, or the target project's) may need. */
export interface EnvRequirement {
  /** The env var key, e.g. `ANTHROPIC_API_KEY`. */
  key: string;
  /** Whether a build cannot proceed without a resolvable value for this key. */
  required: boolean;
  /** Human-readable purpose, shown in {@link printEnvReport} and the TOOLCHAIN.md warnings. */
  description: string;
  /** Optional shape check — a present value that fails this regex is reported `invalid`, not `missing`. */
  format?: RegExp;
  /** Whether `forge vault set` can supply this value (CredentialVault-eligible secret/config). */
  canBeVaulted: boolean;
}

/** One requirement whose resolved value failed its declared `format` check. */
export interface InvalidEnvEntry {
  key: string;
  description: string;
  reason: string;
}

/** The outcome of {@link validateEnv}. */
export interface EnvValidationResult {
  /** True iff every `required` requirement resolved to a non-empty value. The Phase 0 gate. */
  allRequired: boolean;
  /** Required requirements that resolved to nothing anywhere (process.env / .env.local / vault). */
  missing: EnvRequirement[];
  /** Present requirements whose resolved value failed their declared `format` check. */
  invalid: InvalidEnvEntry[];
  /** Non-fatal notes — an unreadable `.env.local`, an unavailable CredentialVault, etc. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// FORGE's own env var catalog (mirrors .env.example at the FORGE repo root)
// ---------------------------------------------------------------------------

/**
 * Every environment variable FORGE itself reads, cataloged once. `required` is `false` across
 * the board — see the module doc comment above for why: each of these already has a real,
 * exercised degrade path elsewhere in the codebase, so this catalog documents FORGE's env
 * surface for `printEnvReport`/`forge vault set` without re-litigating Contract 4. A target
 * project's own `.env.example` (via {@link detectProjectEnvRequirements}) is where genuinely
 * `required: true` entries come from.
 */
export const FORGE_ENV_REQUIREMENTS: EnvRequirement[] = [
  {
    key: 'FORGE_SUPABASE_URL',
    required: false,
    description:
      "Self-hosted Supabase URL for the forge-2 web console's Auth (Build Memory itself runs on " +
      'local SQLite since REBUILD Session 1 and does not need this).',
    format: /^https?:\/\//,
    canBeVaulted: true,
  },
  {
    key: 'FORGE_SUPABASE_ANON_KEY',
    required: false,
    description: "Anon key for the forge-2 web console's Supabase Auth.",
    canBeVaulted: true,
  },
  {
    key: 'FORGE_SUPABASE_SERVICE_KEY',
    required: false,
    description: "Service-role key for the forge-2 web console's Supabase Auth (server-only).",
    canBeVaulted: true,
  },
  {
    key: 'NEXT_PUBLIC_SUPABASE_URL',
    required: false,
    description: 'Supabase URL exposed to the forge-2 web console browser bundle.',
    format: /^https?:\/\//,
    canBeVaulted: true,
  },
  {
    key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    required: false,
    description: 'Supabase anon key exposed to the forge-2 web console browser bundle.',
    canBeVaulted: true,
  },
  {
    key: 'SUPABASE_SERVICE_ROLE_KEY',
    required: false,
    description: 'Server-only Supabase service-role key used by scripts/create-operator-user.mjs.',
    canBeVaulted: true,
  },
  {
    key: 'ANTHROPIC_API_KEY',
    required: false,
    description:
      'Used by Phase 1A/1B design calls (provider-router complex_reasoning). Absent → deterministic ' +
      'fallback skeleton (Session 5 finding #4), never a crash. Phase 3 execution deliberately strips ' +
      "this so `claude -p` runs on Max-subscription auth instead.",
    format: /^sk-ant-/,
    canBeVaulted: true,
  },
  {
    key: 'OPENAI_API_KEY',
    required: false,
    description: 'Provider Router fallback — GPT-4o-mini for validation + simple analysis.',
    format: /^sk-/,
    canBeVaulted: true,
  },
  {
    key: 'GEMINI_API_KEY',
    required: false,
    description:
      'Provider Router fallback — Gemini 1.5 Flash for documentation + research verification (or GOOGLE_API_KEY).',
    canBeVaulted: true,
  },
  {
    key: 'DEEPSEEK_API_KEY',
    required: false,
    description: 'Provider Router fallback — DeepSeek Chat for code review + pattern matching.',
    canBeVaulted: true,
  },
  {
    key: 'FORGE_LITELLM_PROXY_URL',
    required: false,
    description: 'Optional LiteLLM proxy endpoint — when set, provider calls route OpenAI-style through it.',
    format: /^https?:\/\//,
    canBeVaulted: true,
  },
  {
    key: 'FORGE_LITELLM_PROXY_KEY',
    required: false,
    description: 'Auth key for the optional LiteLLM proxy.',
    canBeVaulted: true,
  },
  {
    key: 'FORGE_MACHINE_ID',
    required: false,
    description:
      'Per-machine identity for multi-machine build coordination — auto-generated UUID when unset.',
    format: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    canBeVaulted: false,
  },
  {
    key: 'FORGE_VAULT_KEY',
    required: false,
    description:
      'Overrides the machine-derived AES key CredentialVault encrypts under. Cannot itself be ' +
      'vaulted — it IS the vault key.',
    canBeVaulted: false,
  },
  {
    key: 'FORGE_DATA_DIR',
    required: false,
    description: 'Filesystem location for project archives (default: D:\\forge-data).',
    canBeVaulted: false,
  },
  {
    key: 'FORGE_BACKUP_DIR',
    required: false,
    description: 'Filesystem location for backups (default: E:\\forge-backups).',
    canBeVaulted: false,
  },
  {
    key: 'FORGE_LOG_DIR',
    required: false,
    description: 'Structured log directory (default: <cwd>/logs).',
    canBeVaulted: false,
  },
  {
    key: 'FORGE_LOG_LEVEL',
    required: false,
    description: 'STDOUT log level: trace|debug|info|warn|error|fatal (default: info).',
    format: /^(trace|debug|info|warn|error|fatal)$/,
    canBeVaulted: false,
  },
  {
    key: 'FORGE_LOG_ERROR_PATTERNS',
    required: false,
    description: "Set to '0' to disable feeding error/fatal logs into Build Memory error_patterns.",
    canBeVaulted: false,
  },
];

// ---------------------------------------------------------------------------
// .env file parsing
// ---------------------------------------------------------------------------

/**
 * Parse `KEY=value` lines from `.env`-style text into an UPPER-CASED key → raw value map.
 * Comments and blank lines are ignored; surrounding single/double quotes are stripped from
 * values. Mirrors `src/tools/env-auditor.ts`'s private `parseEnvFile` (kept separate rather than
 * shared, since that function is not exported and this module must not reach into another
 * module's private internals).
 */
function parseEnvFileContent(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || !match[1]) continue;
    let value = (match[2] ?? '').trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    map.set(match[1].toUpperCase(), value);
  }
  return map;
}

/**
 * Read and parse `<projectPath>/.env.example`, treating every declared key with NO default value
 * (`KEY=` with nothing after the `=`) as `required: true` — the project's own author documenting
 * "this build cannot run without a real value here." A key with any default is `required: false`.
 * The comment line(s) immediately preceding a key (if any) become its `description`; absent a
 * comment, a generic fallback description is used.
 *
 * Returns `[]` (never throws) when `.env.example` does not exist or cannot be read — a project
 * with no `.env.example` simply contributes nothing beyond FORGE's own catalog.
 */
export async function detectProjectEnvRequirements(projectPath: string): Promise<EnvRequirement[]> {
  const examplePath = join(projectPath, '.env.example');
  let content: string;
  try {
    content = await readFile(examplePath, 'utf8');
  } catch {
    return [];
  }

  const requirements: EnvRequirement[] = [];
  let pendingComment = '';

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') {
      pendingComment = '';
      continue;
    }
    if (line.startsWith('#')) {
      const text = line.slice(1).trim();
      pendingComment = pendingComment ? `${pendingComment} ${text}` : text;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      pendingComment = '';
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      pendingComment = '';
      continue;
    }
    const rawValue = line.slice(eq + 1).trim();
    const hasDefault = rawValue.length > 0;
    requirements.push({
      key,
      required: !hasDefault,
      description: pendingComment || "Environment variable declared in this project's .env.example",
      canBeVaulted: true,
    });
    pendingComment = '';
  }

  return requirements;
}

/**
 * Merge FORGE's own catalog with a project's detected requirements, de-duplicated by key. A
 * project-declared requirement wins over a FORGE one sharing the same key — the project's own
 * `.env.example` is the more specific, more current source of truth for that key in that project.
 */
function mergeRequirements(
  forgeRequirements: readonly EnvRequirement[],
  projectRequirements: readonly EnvRequirement[]
): EnvRequirement[] {
  const byKey = new Map<string, EnvRequirement>();
  for (const req of forgeRequirements) byKey.set(req.key, req);
  for (const req of projectRequirements) byKey.set(req.key, req);
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve one requirement's value, checking `process.env` first, then `.env.local`, then (only
 * when `canBeVaulted`) the project's CredentialVault entry for the same key. Returns the raw
 * value or `null` — never throws; a vault lookup failure degrades to "not found via vault."
 */
async function resolveValue(
  requirement: EnvRequirement,
  projectPath: string,
  envLocal: Map<string, string>,
  vault: CredentialVault | null
): Promise<string | null> {
  const fromProcess = process.env[requirement.key];
  if (fromProcess && fromProcess.trim() !== '') return fromProcess;

  const fromFile = envLocal.get(requirement.key.toUpperCase());
  if (fromFile && fromFile.trim() !== '') return fromFile;

  if (requirement.canBeVaulted && vault) {
    try {
      const fromVault = await vault.get(projectPath, requirement.key);
      if (fromVault && fromVault.trim() !== '') return fromVault;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.warn({ key: requirement.key, error: detail }, 'env-validator: credential vault lookup failed');
    }
  }

  return null;
}

/**
 * Validate `projectPath`'s environment against FORGE's own requirements
 * ({@link FORGE_ENV_REQUIREMENTS}) plus that project's own `.env.example`-declared requirements
 * ({@link detectProjectEnvRequirements}). Checks `process.env`, then `<projectPath>/.env.local`,
 * then the CredentialVault, in that order, for every requirement, and validates `format` on
 * whatever value is found.
 *
 * Never throws — a missing `.env.local`, a missing `.env.example`, or an unavailable
 * CredentialVault all degrade to "checked, found nothing extra" rather than an error.
 */
export async function validateEnv(projectPath: string): Promise<EnvValidationResult> {
  const warnings: string[] = [];

  const projectRequirements = await detectProjectEnvRequirements(projectPath);
  const requirements = mergeRequirements(FORGE_ENV_REQUIREMENTS, projectRequirements);

  const envLocalPath = join(projectPath, '.env.local');
  let envLocal = new Map<string, string>();
  if (existsSync(envLocalPath)) {
    try {
      const content = await readFile(envLocalPath, 'utf8');
      envLocal = parseEnvFileContent(content);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`Could not read ${envLocalPath}: ${detail}`);
    }
  }

  let vault: CredentialVault | null = null;
  try {
    vault = createCredentialVault();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warnings.push(`CredentialVault unavailable: ${detail}`);
  }

  const missing: EnvRequirement[] = [];
  const invalid: InvalidEnvEntry[] = [];

  for (const requirement of requirements) {
    const value = await resolveValue(requirement, projectPath, envLocal, vault);

    if (value === null) {
      if (requirement.required) {
        missing.push(requirement);
      }
      continue;
    }

    if (requirement.format && !requirement.format.test(value)) {
      invalid.push({
        key: requirement.key,
        description: requirement.description,
        reason: `value present but does not match the expected format for ${requirement.key}`,
      });
    }
  }

  return {
    allRequired: missing.length === 0,
    missing,
    invalid,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Print `result` to stdout in FORGE's `[ENV]` convention (the same bracketed-tag convention
 * `[AUTONOMY]` already uses for CredentialVault injection logging). A clean result prints a
 * single `[ENV] PASS` line. Any missing REQUIRED var prints one `[ENV] MISSING:` line each, with
 * `forge vault set` instructions for CredentialVault-eligible keys (a plain "set it yourself"
 * instruction otherwise). Invalid-format values and warnings are always printed too, even on an
 * otherwise-passing result, so an operator sees a format mismatch before it becomes a build-time
 * failure three phases later.
 */
export function printEnvReport(result: EnvValidationResult): void {
  if (result.allRequired && result.invalid.length === 0) {
    console.log('[ENV] PASS');
  } else if (result.allRequired) {
    console.log('[ENV] PASS (with format warnings — see [ENV] INVALID lines below)');
  } else {
    console.log(
      `[ENV] FAIL — ${result.missing.length} required environment variable(s) missing`
    );
  }

  for (const requirement of result.missing) {
    console.log(`[ENV] MISSING: ${requirement.key} - ${requirement.description}`);
    if (requirement.canBeVaulted) {
      console.log(
        `  -> forge vault set ${requirement.key} <value>   ` +
          '(encrypts it into the CredentialVault for this project; Phase 0 injects it into ' +
          '.env.local automatically on the next run)'
      );
    } else {
      console.log(`  -> set ${requirement.key} directly in your environment or .env.local`);
    }
  }

  for (const entry of result.invalid) {
    console.log(`[ENV] INVALID: ${entry.key} - ${entry.reason} (${entry.description})`);
  }

  for (const warning of result.warnings) {
    console.log(`[ENV] WARN: ${warning}`);
  }
}
