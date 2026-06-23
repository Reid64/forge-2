/**
 * FORGE 2.0 — Environment Auditor (Phase 0 Toolchain Scout helper).
 *
 * Given a `StackFingerprint` (produced by stack-detector, s2-p01), determine the
 * CLI tools and environment variables the stack requires, then probe the live
 * machine to see which are PRESENT and which are MISSING. The result feeds the
 * Phase 0 Scout orchestrator (s2-p03), which turns it into a pass/fail gate and a
 * TOOLCHAIN.md manifest.
 *
 * What it checks:
 *   - CLI tools: node, pnpm, git, vercel, claude, playwright, supabase, docker.
 *     Presence is resolved via `where.exe` on Windows (`which` elsewhere); a
 *     version string is captured best-effort. A tool the fingerprint marks as
 *     required and that is absent → `missing`; an absent OPTIONAL tool → warning.
 *   - Env vars: for every detected service (supabase, anthropic, stripe, …) the
 *     auditor checks `process.env` and the project's `.env*` files for at least
 *     one of the accepted key names. Values are MASKED in the output — only a
 *     couple of edge characters and the length are ever revealed (no secret is
 *     logged or returned in full).
 *   - Docker: whether the Docker CLI is installed, whether the daemon is running,
 *     and whether the FORGE self-hosted Supabase (Build Memory) containers are up.
 *
 * Like the stack-detector, this function is best-effort and NON-FATAL: every
 * external command and file read is guarded, and it never throws. A machine with
 * nothing installed yields a fully-populated `missing` list, not an exception.
 *
 * SECURITY: environment values are read only to confirm a value is set and to
 * mask it for display. Full secret values are never returned or logged.
 */

import { exec, execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { StackFingerprint } from './stack-detector.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** Whether an audited item is a CLI tool or an environment variable. */
export type AuditItemKind = 'cli' | 'env';

/**
 * A single audited requirement. For `present` items, `detail` carries the tool
 * version/path or the masked env value; for `missing` items, `detail` carries a
 * short remediation hint.
 */
export interface AuditItem {
  kind: AuditItemKind;
  /** Tool name (e.g. 'pnpm') or the env var key that satisfied / would satisfy this. */
  name: string;
  /** Whether the stack requires this item (vs. an optional nice-to-have). */
  required: boolean;
  /** Version / masked value (present) or remediation hint (missing). */
  detail: string;
}

/** Docker / Build Memory runtime status. */
export interface DockerStatus {
  /** Docker CLI found on PATH. */
  installed: boolean;
  /** Docker daemon responding to `docker info` (Docker Desktop running). */
  running: boolean;
  /** The FORGE self-hosted Supabase stack (forge-supabase-* containers) is up. */
  forgeSupabaseUp: boolean;
  /** Names of running forge-supabase-* containers (empty if none / daemon down). */
  runningContainers: string[];
}

/** Full environment audit result consumed by the Phase 0 Scout orchestrator. */
export interface EnvironmentAudit {
  /** Required-or-optional items found on this machine. */
  present: AuditItem[];
  /** Required items that are absent (the basis for Scout's blocker list). */
  missing: AuditItem[];
  /** Non-fatal observations (optional tool absent, placeholder value, daemon down, …). */
  warnings: string[];
  /** Docker + FORGE Build Memory status. */
  dockerStatus: DockerStatus;
}

// ---------------------------------------------------------------------------
// Known requirements
// ---------------------------------------------------------------------------

/** The CLI tools FORGE knows how to probe, with human-readable labels. */
const KNOWN_CLI_TOOLS: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'node', label: 'Node.js runtime' },
  { name: 'pnpm', label: 'pnpm package manager' },
  { name: 'git', label: 'Git version control' },
  { name: 'vercel', label: 'Vercel CLI' },
  { name: 'claude', label: 'Claude Code CLI' },
  { name: 'playwright', label: 'Playwright browser automation' },
  { name: 'supabase', label: 'Supabase CLI' },
  { name: 'docker', label: 'Docker CLI' },
];

/** A single env requirement: any one of `keys` (with a non-empty value) satisfies it. */
interface EnvRequirement {
  label: string;
  keys: string[];
}

/**
 * Service slug → environment variables that service needs. Slugs match the
 * `services` array emitted by stack-detector. Each requirement is satisfied by
 * ANY of its candidate keys (FORGE_-prefixed aliases come first so a FORGE
 * self-build resolves to its own Build Memory credentials).
 */
const SERVICE_ENV_REQUIREMENTS: Readonly<Record<string, ReadonlyArray<EnvRequirement>>> = {
  supabase: [
    {
      label: 'Supabase URL',
      keys: ['FORGE_SUPABASE_URL', 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'],
    },
    {
      label: 'Supabase service/anon key',
      keys: [
        'FORGE_SUPABASE_SERVICE_KEY',
        'SUPABASE_SERVICE_ROLE_KEY',
        'SUPABASE_ANON_KEY',
        'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      ],
    },
  ],
  anthropic: [{ label: 'Anthropic API key', keys: ['ANTHROPIC_API_KEY'] }],
  openai: [{ label: 'OpenAI API key', keys: ['OPENAI_API_KEY'] }],
  stripe: [{ label: 'Stripe secret key', keys: ['STRIPE_SECRET_KEY'] }],
  twilio: [
    { label: 'Twilio account SID', keys: ['TWILIO_ACCOUNT_SID'] },
    { label: 'Twilio auth token', keys: ['TWILIO_AUTH_TOKEN'] },
  ],
  resend: [{ label: 'Resend API key', keys: ['RESEND_API_KEY'] }],
  sendgrid: [{ label: 'SendGrid API key', keys: ['SENDGRID_API_KEY'] }],
  mapbox: [
    {
      label: 'Mapbox access token',
      keys: ['MAPBOX_ACCESS_TOKEN', 'NEXT_PUBLIC_MAPBOX_TOKEN', 'NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN'],
    },
  ],
  sentry: [{ label: 'Sentry DSN', keys: ['SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN'] }],
  github: [{ label: 'GitHub token', keys: ['GITHUB_TOKEN', 'GH_TOKEN'] }],
  aws: [
    { label: 'AWS access key id', keys: ['AWS_ACCESS_KEY_ID'] },
    { label: 'AWS secret access key', keys: ['AWS_SECRET_ACCESS_KEY'] },
  ],
  redis: [{ label: 'Redis URL', keys: ['REDIS_URL'] }],
};

// ---------------------------------------------------------------------------
// Low-level command / file helpers (all guarded — never throw)
// ---------------------------------------------------------------------------

/** PATH-lookup command: `where.exe` on Windows, `which` elsewhere. */
const LOCATOR = process.platform === 'win32' ? 'where.exe' : 'which';

/**
 * Resolve a tool's executable path via the platform locator, or `null` if it is
 * not on PATH. Tool names are a fixed allowlist (never user input).
 */
async function locate(tool: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(LOCATOR, [tool], {
      timeout: 8000,
      windowsHide: true,
    });
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '');
    return first ?? null;
  } catch {
    return null;
  }
}

/** Result of a guarded shell command. */
interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run a shell command with a timeout, capturing output and never throwing. Used
 * only with trusted, constant command strings (tool paths + fixed flags).
 */
async function run(command: string, timeoutMs: number): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  } catch (error) {
    const e = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    return { ok: false, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

/** Best-effort version string for a located tool (`--version`), or `null`. */
async function toolVersion(toolPath: string): Promise<string | null> {
  const res = await run(`"${toolPath}" --version`, 6000);
  if (!res.ok && res.stdout === '' && res.stderr === '') return null;
  const line = `${res.stdout}\n${res.stderr}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  return line ?? null;
}

/** Read a UTF-8 text file, returning `null` if it cannot be read. */
async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** List `.env*` filenames in `dir` (returns `[]` if the directory can't be read). */
async function listEnvFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.startsWith('.env')).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Parse `.env` file text into an upper-cased KEY → value map. Surrounding single
 * or double quotes are stripped from values; comments and blank lines are ignored.
 */
function parseEnvFile(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || !match[1]) continue;
    let value = (match[2] ?? '').trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    map.set(match[1].toUpperCase(), value);
  }
  return map;
}

/**
 * Find the first of `keys` that resolves to a non-empty value, checking
 * `process.env` first and then the parsed `.env` files. Returns the matched key
 * and its raw value, or `null` if none is set.
 */
function findEnvValue(
  keys: readonly string[],
  fileEnv: Map<string, string>
): { key: string; value: string } | null {
  for (const key of keys) {
    const fromProcess = process.env[key];
    if (fromProcess && fromProcess.trim() !== '') return { key, value: fromProcess };
    const fromFile = fileEnv.get(key.toUpperCase());
    if (fromFile && fromFile.trim() !== '') return { key, value: fromFile };
  }
  return null;
}

/** Mask a secret value: reveal only two edge chars and the length. */
function maskSecret(raw: string): string {
  const value = raw.trim();
  if (value === '') return '(empty)';
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 2)}••••${value.slice(-2)} (${value.length} chars)`;
}

/** Heuristic: does a value look like an un-replaced template placeholder? */
function looksLikePlaceholder(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return (
    v.startsWith('your-') ||
    v.startsWith('your_') ||
    v.includes('changeme') ||
    v.includes('replace-me') ||
    v.includes('placeholder')
  );
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

/**
 * Inspect Docker: is the CLI installed, is the daemon running, and is the FORGE
 * self-hosted Supabase (Build Memory) stack up? The gateway container
 * `forge-supabase-kong` (which backs FORGE_SUPABASE_URL) is the up/down witness.
 */
async function auditDocker(): Promise<DockerStatus> {
  const dockerPath = await locate('docker');
  if (dockerPath === null) {
    return { installed: false, running: false, forgeSupabaseUp: false, runningContainers: [] };
  }

  const info = await run(`"${dockerPath}" info`, 12000);
  if (!info.ok) {
    return { installed: true, running: false, forgeSupabaseUp: false, runningContainers: [] };
  }

  const ps = await run(
    `"${dockerPath}" ps --filter "name=forge-supabase" --format "{{.Names}}"`,
    10000
  );
  const runningContainers = ps.ok
    ? ps.stdout
        .split(/\r?\n/)
        .map((n) => n.trim())
        .filter((n) => n !== '')
        .sort()
    : [];
  const forgeSupabaseUp = runningContainers.some((n) => n.includes('forge-supabase-kong'));

  return { installed: true, running: true, forgeSupabaseUp, runningContainers };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Audit the local environment against a detected stack.
 *
 * Always resolves (never rejects). `projectPath` defaults to the current working
 * directory and is where `.env*` files are looked up.
 */
export async function auditEnvironment(
  fingerprint: StackFingerprint,
  projectPath: string = process.cwd()
): Promise<EnvironmentAudit> {
  const present: AuditItem[] = [];
  const missing: AuditItem[] = [];
  const warnings: string[] = [];

  // --- CLI tools -----------------------------------------------------------
  // Required = whatever the fingerprint inferred; node is always required.
  const requiredCli = new Set<string>(fingerprint.cliTools);
  requiredCli.add('node');

  for (const tool of KNOWN_CLI_TOOLS) {
    const required = requiredCli.has(tool.name);
    const path = await locate(tool.name);
    if (path !== null) {
      const version = await toolVersion(path);
      present.push({ kind: 'cli', name: tool.name, required, detail: version ?? path });
    } else if (required) {
      missing.push({
        kind: 'cli',
        name: tool.name,
        required: true,
        detail: `${tool.label} not found on PATH — install it and ensure it is on PATH`,
      });
    } else {
      warnings.push(`Optional CLI '${tool.name}' (${tool.label}) not found on PATH.`);
    }
  }

  // --- Environment variables ----------------------------------------------
  const envFiles = await listEnvFiles(projectPath);
  const fileEnv = new Map<string, string>();
  for (const file of envFiles) {
    const text = await readText(join(projectPath, file));
    if (text === null) continue;
    for (const [key, value] of parseEnvFile(text)) {
      if (!fileEnv.has(key)) fileEnv.set(key, value); // first file wins
    }
  }

  const handledRequirements = new Set<string>();
  let anyEnvRequired = false;
  for (const service of fingerprint.services) {
    const requirements = SERVICE_ENV_REQUIREMENTS[service];
    if (!requirements) continue;
    for (const requirement of requirements) {
      const id = requirement.keys.join('|');
      if (handledRequirements.has(id)) continue; // de-dup shared keys across services
      handledRequirements.add(id);
      anyEnvRequired = true;

      const found = findEnvValue(requirement.keys, fileEnv);
      if (found) {
        present.push({
          kind: 'env',
          name: found.key,
          required: true,
          detail: maskSecret(found.value),
        });
        if (looksLikePlaceholder(found.value)) {
          warnings.push(
            `Env '${found.key}' (${requirement.label}) looks like a template placeholder — replace before building.`
          );
        }
      } else {
        missing.push({
          kind: 'env',
          name: requirement.keys[0] ?? requirement.label,
          required: true,
          detail: `${requirement.label} for ${service}: set one of ${requirement.keys.join(', ')}`,
        });
      }
    }
  }

  if (anyEnvRequired && envFiles.length === 0) {
    warnings.push(
      'No .env* file found in the project — required environment variables can only come from the process environment.'
    );
  }

  // --- Docker / Build Memory ----------------------------------------------
  const dockerStatus = await auditDocker();
  if (dockerStatus.installed && !dockerStatus.running) {
    warnings.push(
      'Docker CLI is installed but the daemon is not responding (Docker Desktop not running).'
    );
  }
  if (dockerStatus.running && !dockerStatus.forgeSupabaseUp) {
    warnings.push(
      'FORGE Supabase Build Memory is not running — start it with docker/start-forge-db.ps1 (FORGE will degrade to stateless mode without it).'
    );
  }

  return { present, missing, warnings, dockerStatus };
}
