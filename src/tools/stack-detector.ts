/**
 * FORGE 2.0 — Stack Detector (Phase 0 Toolchain Scout helper).
 *
 * Given a project path, infer the project's technology stack by reading the
 * conventional configuration files that projects in this ecosystem use:
 *   - package.json        → framework, language, package manager, service SDKs
 *   - tsconfig.json       → TypeScript (language)
 *   - next.config.*       → Next.js (framework)
 *   - vercel.json         → Vercel (deployment)
 *   - .env* files         → service integrations (Supabase, Stripe, Claude, …)
 *   - docker-compose.yml  → Docker services / database
 *   - BLUEPRINT.md / PRD.md → soft keyword signals to fill remaining gaps
 *
 * Detection is best-effort and NON-FATAL: every file read is guarded, missing
 * files are skipped, and a partial fingerprint is a valid result (per the task
 * spec — "Handle missing files gracefully"). The function never throws; the
 * worst case is an all-null / empty fingerprint.
 *
 * SECURITY: `.env` files are parsed for KEY NAMES ONLY. Values are never read,
 * logged, or returned — we only need to know which integrations are configured.
 *
 * The resulting `StackFingerprint` is consumed by the Environment Auditor
 * (s2-p02) and the Phase 0 Scout orchestrator (s2-p03), and is persisted to
 * `build_runs.stack_fingerprint` (a `jsonb` column — see SCHEMA_REGISTRY.md).
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';

/**
 * Normalized technology-stack signature for a project.
 *
 * Scalar fields are the single best inference and are `null` when no signal was
 * found. `services` and `cliTools` are de-duplicated, sorted string arrays.
 */
export interface StackFingerprint {
  /** Primary app framework: 'nextjs', 'react', 'express', 'node', … */
  framework: string | null;
  /** Implementation language: 'typescript' | 'javascript'. */
  language: string | null;
  /** Backing datastore: 'supabase', 'postgres', 'mysql', 'mongodb', … */
  database: string | null;
  /** Deployment target: 'vercel', 'netlify', 'docker', … */
  deployment: string | null;
  /** Package manager: 'pnpm' | 'npm' | 'yarn' | 'bun'. */
  packageManager: string | null;
  /** Third-party service integrations detected (e.g. 'stripe', 'anthropic'). */
  services: string[];
  /** CLI tools the stack implies are required (e.g. 'pnpm', 'vercel', 'git'). */
  cliTools: string[];
}

/** Read and JSON-parse a file, returning `null` if missing or unparseable. */
async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Read a UTF-8 text file, returning `null` if it does not exist / cannot be read. */
async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Return `true` if any of the candidate files exists in `dir`. */
async function anyExists(dir: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    if ((await readText(join(dir, name))) !== null) return true;
  }
  return false;
}

/**
 * Map a merged `{ dependencies, devDependencies }` record into a flat set of
 * lower-cased package names (values — version ranges — are irrelevant here).
 */
function dependencyNames(pkg: Record<string, unknown> | null): Set<string> {
  const names = new Set<string>();
  if (!pkg) return names;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[field];
    if (deps && typeof deps === 'object') {
      for (const name of Object.keys(deps as Record<string, unknown>)) {
        names.add(name.toLowerCase());
      }
    }
  }
  return names;
}

/**
 * Detect the framework from dependency names. Ordered most-specific first so a
 * Next.js app (which also depends on React) reports 'nextjs', not 'react'.
 */
function detectFramework(deps: Set<string>): string | null {
  const rules: ReadonlyArray<[string, string]> = [
    ['next', 'nextjs'],
    ['@remix-run/react', 'remix'],
    ['nuxt', 'nuxt'],
    ['@angular/core', 'angular'],
    ['@nestjs/core', 'nestjs'],
    ['svelte', 'svelte'],
    ['vue', 'vue'],
    ['react', 'react'],
    ['fastify', 'fastify'],
    ['express', 'express'],
    ['commander', 'node-cli'],
  ];
  for (const [dep, framework] of rules) {
    if (deps.has(dep)) return framework;
  }
  // Has a package.json with deps but matched nothing specific → generic Node.
  return deps.size > 0 ? 'node' : null;
}

/**
 * Service-integration signatures. Each entry maps a substring found in an
 * environment-variable KEY name (uppercased) to a canonical service slug.
 */
const ENV_SERVICE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/SUPABASE/, 'supabase'],
  [/STRIPE/, 'stripe'],
  [/ANTHROPIC|CLAUDE/, 'anthropic'],
  [/OPENAI/, 'openai'],
  [/TWILIO/, 'twilio'],
  [/RESEND/, 'resend'],
  [/SENDGRID/, 'sendgrid'],
  [/MAPBOX/, 'mapbox'],
  [/SENTRY/, 'sentry'],
  [/(^|_)(AWS|S3)_/, 'aws'],
  [/REDIS/, 'redis'],
  [/GITHUB/, 'github'],
];

/** Dependency-name → service slug signatures (SDK packages reveal integrations). */
const DEP_SERVICE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/^@supabase\//, 'supabase'],
  [/^stripe$/, 'stripe'],
  [/^@anthropic-ai\//, 'anthropic'],
  [/^openai$/, 'openai'],
  [/^twilio$/, 'twilio'],
  [/^resend$/, 'resend'],
  [/^@sendgrid\//, 'sendgrid'],
  [/^mapbox-gl$|^@mapbox\//, 'mapbox'],
  [/^@sentry\//, 'sentry'],
];

/** Extract environment variable KEY names from raw `.env` file text (values ignored). */
function envKeys(text: string): string[] {
  const keys: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && match[1]) keys.push(match[1].toUpperCase());
  }
  return keys;
}

/**
 * Scan a docker-compose file's service images for a recognizable database, and
 * report whether any services are defined (a signal for Docker-based deploy).
 */
function inspectCompose(text: string): { database: string | null; hasServices: boolean } {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return { database: null, hasServices: false };
  }
  if (!parsed || typeof parsed !== 'object') return { database: null, hasServices: false };

  const services = (parsed as Record<string, unknown>)['services'];
  if (!services || typeof services !== 'object') {
    return { database: null, hasServices: false };
  }

  const dbRules: ReadonlyArray<[RegExp, string]> = [
    [/supabase|gotrue|postgrest/, 'supabase'],
    [/postgres|pgvector|timescale/, 'postgres'],
    [/mysql|mariadb/, 'mysql'],
    [/mongo/, 'mongodb'],
  ];

  let database: string | null = null;
  for (const def of Object.values(services as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') continue;
    const image = (def as Record<string, unknown>)['image'];
    if (typeof image !== 'string') continue;
    const haystack = image.toLowerCase();
    for (const [pattern, db] of dbRules) {
      if (pattern.test(haystack)) {
        // Prefer the most specific (supabase) over generic postgres.
        if (database === null || db === 'supabase') database = db;
      }
    }
  }
  return { database, hasServices: Object.keys(services as Record<string, unknown>).length > 0 };
}

/**
 * Detect the technology stack rooted at `projectPath`.
 *
 * Always resolves (never rejects). Returns a `StackFingerprint` whose scalar
 * fields are `null` and whose arrays are empty where no evidence was found.
 */
export async function detectStack(projectPath: string): Promise<StackFingerprint> {
  const services = new Set<string>();
  const cliTools = new Set<string>();

  let framework: string | null = null;
  let language: string | null = null;
  let database: string | null = null;
  let deployment: string | null = null;
  let packageManager: string | null = null;

  // --- package.json: framework, language, package manager, service SDKs ----
  const pkg = await readJson(join(projectPath, 'package.json'));
  const deps = dependencyNames(pkg);
  if (pkg) {
    framework = detectFramework(deps);
    cliTools.add('node');

    // packageManager field, e.g. "pnpm@9.1.0" → "pnpm".
    const pmField = pkg['packageManager'];
    if (typeof pmField === 'string') {
      const name = pmField.split('@')[0]?.trim();
      if (name) packageManager = name;
    }

    if (deps.has('typescript')) language = 'typescript';
    else if (deps.size > 0) language = 'javascript';

    for (const [pattern, service] of DEP_SERVICE_PATTERNS) {
      for (const dep of deps) {
        if (pattern.test(dep)) services.add(service);
      }
    }
    if (deps.has('playwright') || deps.has('@playwright/test')) cliTools.add('playwright');
  }

  // --- lockfiles: package manager fallback when no packageManager field -----
  if (!packageManager) {
    if (await readText(join(projectPath, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
    else if (await readText(join(projectPath, 'yarn.lock'))) packageManager = 'yarn';
    else if (await readText(join(projectPath, 'bun.lockb'))) packageManager = 'bun';
    else if (await readText(join(projectPath, 'package-lock.json'))) packageManager = 'npm';
  }

  // --- tsconfig.json: confirms TypeScript ----------------------------------
  if (await readText(join(projectPath, 'tsconfig.json'))) language = 'typescript';

  // --- next.config.*: confirms Next.js -------------------------------------
  if (
    await anyExists(projectPath, [
      'next.config.js',
      'next.config.mjs',
      'next.config.cjs',
      'next.config.ts',
    ])
  ) {
    framework = 'nextjs';
  }

  // --- deployment target ----------------------------------------------------
  if (await readText(join(projectPath, 'vercel.json'))) deployment = 'vercel';
  else if (await readText(join(projectPath, 'netlify.toml'))) deployment = 'netlify';

  // --- docker-compose.yml: database + Docker deployment --------------------
  const composeText =
    (await readText(join(projectPath, 'docker-compose.yml'))) ??
    (await readText(join(projectPath, 'docker-compose.yaml')));
  if (composeText !== null) {
    const compose = inspectCompose(composeText);
    if (compose.database) database = compose.database;
    if (compose.hasServices) {
      cliTools.add('docker');
      // Compose is a deploy/runtime signal only when nothing more specific won.
      if (!deployment) deployment = 'docker';
    }
  } else if (await readText(join(projectPath, 'Dockerfile'))) {
    cliTools.add('docker');
    if (!deployment) deployment = 'docker';
  }

  // --- .env* files: service integrations (KEY NAMES ONLY) ------------------
  for (const file of await listEnvFiles(projectPath)) {
    const text = await readText(join(projectPath, file));
    if (text === null) continue;
    for (const key of envKeys(text)) {
      for (const [pattern, service] of ENV_SERVICE_PATTERNS) {
        if (pattern.test(key)) services.add(service);
      }
      if (/SUPABASE/.test(key) && !database) database = 'supabase';
      else if (/(^|_)(DATABASE_URL|POSTGRES|PG)/.test(key) && !database) database = 'postgres';
      if (/VERCEL/.test(key) && !deployment) deployment = 'vercel';
    }
  }

  // --- governance docs: soft keyword signals to fill remaining gaps --------
  await applyDocSignals(projectPath, (signal) => {
    if (!framework && signal.framework) framework = signal.framework;
    if (!database && signal.database) database = signal.database;
    if (!deployment && signal.deployment) deployment = signal.deployment;
    if (!packageManager && signal.packageManager) packageManager = signal.packageManager;
  });

  // --- derive a database from services when no direct DB signal found ------
  if (!database && services.has('supabase')) database = 'supabase';

  // --- infer required CLI tools from what we detected ----------------------
  if (packageManager) cliTools.add(packageManager);
  if (deployment === 'vercel') cliTools.add('vercel');
  if (deployment === 'netlify') cliTools.add('netlify');
  if (services.has('supabase') || database === 'supabase') cliTools.add('supabase');
  if (services.has('anthropic')) cliTools.add('claude');
  // Any recognized project should be under version control.
  if (pkg || framework || language) cliTools.add('git');

  return {
    framework,
    language,
    database,
    deployment,
    packageManager,
    services: [...services].sort(),
    cliTools: [...cliTools].sort(),
  };
}

/** List `.env*` filenames in `dir` (returns `[]` if the directory can't be read). */
async function listEnvFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.startsWith('.env'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** A partial signal extracted from free-text governance docs. */
interface DocSignal {
  framework?: string;
  database?: string;
  deployment?: string;
  packageManager?: string;
}

/**
 * Negation markers that void a keyword match as a positive signal when they appear in the
 * SAME sentence — e.g. "No database service: Explicitly no Supabase/Postgres or any DB" must
 * NOT set `database: 'supabase'` just because the word "Supabase" appears. Without this, a
 * PRD/BLUEPRINT that explicitly RULES OUT a technology reads as evidence FOR it (the bug this
 * closes: a plain no-DB, no-auth Node project got fingerprinted as framework=nextjs,
 * database=supabase purely from its own "explicitly forbids one" disclaimer text).
 */
const NEGATION_PATTERN =
  /\b(no|not|none|never|without|zero|forbid\w*|exclud\w*|deviat\w*|non-|isn't|aren't|wasn't|weren't|won't|don't|doesn't|didn't)\b/;

/** Split free text into rough sentences for negation-scoped keyword matching. */
function toSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim() !== '');
}

/**
 * True when `pattern` matches in at least one sentence of `text` that carries NO negation
 * marker — so a mention inside a "no X" / "explicitly forbids X" disclaimer never counts as a
 * positive signal, while a plain, unnegated statement ("Framework: nextjs") still does.
 */
function affirmedSignal(text: string, pattern: RegExp): boolean {
  return toSentences(text).some((s) => pattern.test(s) && !NEGATION_PATTERN.test(s));
}

/**
 * Read BLUEPRINT.md / PRD.md (if present, in the project root or a `governance/`
 * subdirectory) and emit a keyword-derived `DocSignal` to `apply`. These are the
 * weakest signals and only fill gaps the concrete config files left open.
 */
async function applyDocSignals(
  projectPath: string,
  apply: (signal: DocSignal) => void
): Promise<void> {
  const candidates = [
    'BLUEPRINT.md',
    'PRD.md',
    join('governance', 'BLUEPRINT.md'),
    join('governance', 'PRD.md'),
  ];

  let combined = '';
  for (const rel of candidates) {
    const text = await readText(join(projectPath, rel));
    if (text) combined += '\n' + text;
  }
  if (combined === '') return;

  const haystack = combined.toLowerCase();
  const signal: DocSignal = {};

  if (affirmedSignal(haystack, /next\.?js/)) signal.framework = 'nextjs';
  else if (affirmedSignal(haystack, /\bnode\.?js\b/)) signal.framework = 'node';

  if (affirmedSignal(haystack, /supabase/)) signal.database = 'supabase';
  else if (affirmedSignal(haystack, /postgres/)) signal.database = 'postgres';

  if (affirmedSignal(haystack, /vercel/)) signal.deployment = 'vercel';
  else if (affirmedSignal(haystack, /netlify/)) signal.deployment = 'netlify';

  if (affirmedSignal(haystack, /\bpnpm\b/)) signal.packageManager = 'pnpm';
  else if (affirmedSignal(haystack, /\byarn\b/)) signal.packageManager = 'yarn';

  apply(signal);
}
