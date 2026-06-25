/**
 * FORGE 2.0 — Queue Generator (Phase 2 helper, queue.yaml s4-p02).
 *
 * The Queue Generator is the FINAL step of the design pipeline. It takes the APPROVED
 * {@link ArchitectureDesign} produced by Phase 1B (and rendered into the governance
 * package by Phase 2, s4-p01) and turns it into the dependency-ordered build queue
 * (`queue.yaml`) that the Phase 3 Build Executor (s5-p05) processes one prompt at a time.
 * After it writes the queue, the build HALTS for Gate 3 — human approval of governance +
 * queue together (BEHAVIORAL_CONTRACTS Contract 2 — no bypass).
 *
 * DETERMINISTIC: like Phase 2, this module makes NO model calls. It is a pure, repeatable
 * transformation from the structured design into a queue — the same design always yields
 * the same queue (modulo the timestamp in the header comment).
 *
 * WHAT IT PRODUCES — each queue entry carries:
 *   - id                  — stable, human-readable identifier (referenced by `dependencies`)
 *   - name                — short label
 *   - prompt_type         — schema | auth | api | ui | feature | agent | test | deploy
 *   - dependencies[]      — ids of prompts that MUST complete first (Contract 1 ordering)
 *   - parallel_group?     — set when ≥2 sibling prompts share identical dependencies and may
 *                           execute simultaneously (Contract 10 branch isolation; the
 *                           parallel-scheduler, s5-p05, reads this)
 *   - governance_refs[]   — which governance documents the prompt-assembler (s5-p01) must
 *                           inject as context (Contract 7)
 *   - estimated_tokens    — heuristic budget for cost estimation (Cost Estimator, F17)
 *   - context_injection   — finer-grained markers: which SCHEMA_REGISTRY sections, which
 *                           BEHAVIORAL_CONTRACTS sections, and which INTERACTION_MAPS entries
 *                           the assembled prompt needs (Contract 7)
 *   - description         — the detailed, buildable task text
 *
 * STANDARD BUILD ORDER (from BEHAVIORAL_CONTRACTS / the FORGE feature lifecycle):
 *   schema → auth → api → ui → features → agents → dashboards → settings → tests → deploy → verify
 * Entries are emitted in this order; dependencies wire each stage to the ones it relies on
 * (auth needs schema; api needs schema+auth; pages need their api routes + the ui shell;
 * tests need the features; deploy needs the tests; verify needs the deploy).
 *
 * DEPENDENCY ANALYSIS + PARALLEL MARKING: within a stage, entries with an IDENTICAL set of
 * dependencies (and which therefore do not depend on one another) are grouped — any group
 * of two or more is tagged with a shared `parallel_group` id so the executor may fan them
 * out onto separate branches. API route groups, feature pages, and agents are the usual
 * parallel candidates.
 *
 * NON-FATAL house style (matching the sibling phase orchestrators): the single file write is
 * guarded so a failure is collected as a warning rather than thrown, and a degenerate design
 * (no tables / no routes) still yields a valid — if short — queue. `generateQueue` never
 * rejects.
 *
 * BOUNDARY: `queue.yaml` is written ONLY to the TARGET project directory (`projectPath`).
 * This helper never touches FORGE's own governance files (Iron Law 1).
 */

import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type {
  AgentSpec,
  ApiRoute,
  ArchPage,
  ArchitectureDesign,
  ArchTable,
  InteractionMap,
} from '../phases/phase1b-architect.js';
import type { Gate3Status } from '../phases/phase2-governance.js';
import { nowIso } from '../memory/index.js';
import { logLine } from '../tools/forge-logger.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The kind of build prompt — drives governance-ref selection and token estimation. */
export type PromptType =
  | 'schema'
  | 'auth'
  | 'api'
  | 'ui'
  | 'feature'
  | 'agent'
  | 'test'
  | 'deploy';

/**
 * Fine-grained context-injection markers (Contract 7). The prompt-assembler (s5-p01) uses
 * these to pull only the RELEVANT slices of each governance document into the assembled
 * prompt rather than the whole document.
 */
export interface ContextInjection {
  /** SCHEMA_REGISTRY.md sections to inject — table names this prompt touches. */
  schemaSections: string[];
  /** BEHAVIORAL_CONTRACTS.md section headings to inject (e.g. "API Contracts"). */
  behavioralSections: string[];
  /** INTERACTION_MAPS.md entries to inject — `feature: element` labels this prompt builds. */
  interactionMaps: string[];
}

/** A single dependency-ordered build prompt in the generated queue. */
export interface QueueEntry {
  id: string;
  name: string;
  prompt_type: PromptType;
  /** Ids of prompts that must complete before this one (Contract 1). */
  dependencies: string[];
  /** Shared group id when this prompt may run in parallel with its siblings. */
  parallel_group?: string;
  /** Governance documents the assembler must inject (Contract 7). */
  governance_refs: string[];
  /** Heuristic token budget for cost/time estimation. */
  estimated_tokens: number;
  /** Finer-grained injection markers (Contract 7). */
  context_injection: ContextInjection;
  /** The detailed, buildable task text. */
  description: string;
}

/** Headline counts describing the generated queue. */
export interface QueueStats {
  totalPrompts: number;
  byType: Record<PromptType, number>;
  /** Number of distinct parallel groups identified. */
  parallelGroups: number;
  /** Sum of every entry's `estimated_tokens`. */
  totalEstimatedTokens: number;
  /** Longest dependency chain (1 = no dependencies) — a proxy for sequential depth. */
  longestChain: number;
}

/** The complete result of {@link generateQueue}. */
export interface QueuePlan {
  projectName: string;
  /** Absolute path queue.yaml was written to, or `null` if the write failed / was skipped. */
  queuePath: string | null;
  /** The generated entries, in standard build order. */
  entries: QueueEntry[];
  /** The serialized queue.yaml content (always present, even when not written). */
  yaml: string;
  stats: QueueStats;
  /** Non-fatal observations (write failure, degenerate design, …). */
  warnings: string[];
  /** Gate 3 — the build halts here until a human approves governance + the queue. */
  gate: Gate3Status;
  generatedAt: string;
}

/** Options for {@link generateQueue}. */
export interface QueueGeneratorOptions {
  /** Project name for labels/header. Default: `design.projectName` or the basename of `projectPath`. */
  projectName?: string;
  /** Output file name under the target project. Default `'queue.yaml'`. */
  queueFileName?: string;
  /** Write queue.yaml to disk. Default true (set false for a dry render). */
  writeFile?: boolean;
  /** Progress reporter. Default logs to the console with a [FORGE:queue] prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Token-estimation constants
// ---------------------------------------------------------------------------

/** Base token budget per prompt type (before per-entity increments). */
const BASE_TOKENS: Record<PromptType, number> = {
  schema: 4000,
  auth: 5000,
  api: 4000,
  ui: 5000,
  feature: 6000,
  agent: 7000,
  test: 4000,
  deploy: 3000,
};

/** Floor for any single prompt's estimate. */
const MIN_TOKENS = 2000;

/** Round to the nearest 100 and clamp to the floor (estimates are deliberately coarse). */
function estimate(raw: number): number {
  return Math.max(MIN_TOKENS, Math.round(raw / 100) * 100);
}

// ---------------------------------------------------------------------------
// Governance-reference policy per prompt type
// ---------------------------------------------------------------------------

/** Which governance documents each prompt type needs injected (Contract 7). */
const GOVERNANCE_REFS: Record<PromptType, string[]> = {
  schema: ['SCHEMA_REGISTRY.md', 'BLUEPRINT.md'],
  auth: ['BEHAVIORAL_CONTRACTS.md', 'SCHEMA_REGISTRY.md'],
  api: ['BEHAVIORAL_CONTRACTS.md', 'SCHEMA_REGISTRY.md'],
  ui: ['BLUEPRINT.md', 'BEHAVIORAL_CONTRACTS.md'],
  feature: ['INTERACTION_MAPS.md', 'BEHAVIORAL_CONTRACTS.md', 'SCHEMA_REGISTRY.md'],
  agent: ['AGENTS.md', 'BEHAVIORAL_CONTRACTS.md'],
  test: ['TESTING.md', 'BEHAVIORAL_CONTRACTS.md'],
  deploy: ['BLUEPRINT.md'],
};

/** The mandatory FORGE footer appended to every prompt description (Canonical Rule 9). */
const STATE_FOOTER = 'Update STATE_OF_THE_BUILD.md and SESSION_STATE.md from actual codebase audit.';

// ---------------------------------------------------------------------------
// Normalization & slug helpers
// ---------------------------------------------------------------------------

/** Normalize a table name (strip schema prefix + quotes, lower-case). */
function normTable(name: string): string {
  return name.trim().toLowerCase().replace(/[`"']/g, '').replace(/^public\./, '');
}

/** Normalize an API route path: drop a leading method token, query string, dynamic params. */
function normRoute(path: string): string {
  let s = path.trim();
  s = s.replace(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+/i, '');
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  s = s.replace(/\[(\.{3})?[^\]]+\]/g, ':p'); // [id] / [...slug] → :p (Next.js dynamic)
  s = s.replace(/:[^/]+/g, ':p'); // :id → :p (Express-style)
  s = s.replace(/\/+$/, ''); // drop trailing slash
  return s.toLowerCase();
}

/** The first meaningful path segment of a route (its "resource"), or 'root'. */
function routeResource(path: string): string {
  const norm = normRoute(path).replace(/^\/+/, '').replace(/^api\//, '');
  const seg = norm.split('/')[0] ?? '';
  const cleaned = seg.replace(/:p/g, '').replace(/[^a-z0-9]+/g, '');
  return cleaned === '' ? 'root' : cleaned;
}

/** Lower-kebab slug of an arbitrary label, or `fallback` when empty. */
function slug(label: string, fallback = 'item'): string {
  const s = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s === '' ? fallback : s;
}

/** Significant lower-case word tokens of a label (length ≥ 3, generic words dropped). */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  'page',
  'pages',
  'view',
  'views',
  'list',
  'index',
  'home',
  'main',
  'screen',
  'app',
  'the',
  'and',
  'for',
]);
function tokens(label: string): Set<string> {
  const out = new Set<string>();
  for (const t of label.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !GENERIC_TOKENS.has(t)) out.add(t);
  }
  return out;
}

/** True when two token sets share at least one significant token. */
function tokensOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

/** Reserve a unique id from a desired base, suffixing `-2`, `-3`, … on collision. */
function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

// ---------------------------------------------------------------------------
// Internal entry shape (parallel_group is non-optional during construction)
// ---------------------------------------------------------------------------

interface DraftEntry {
  id: string;
  name: string;
  prompt_type: PromptType;
  dependencies: string[];
  parallel_group: string | null;
  governance_refs: string[];
  estimated_tokens: number;
  context_injection: ContextInjection;
  description: string;
}

/**
 * Tag mutually-independent siblings within a stage so the executor may run them in
 * parallel (Contract 10). The contract definition of parallelizable is "no MUTUAL
 * dependency" — NOT "identical dependencies": two feature pages that depend on different
 * API groups are still independent of each other and may run concurrently (the scheduler
 * launches each as soon as its own dependencies are satisfied). So all entries in a stage
 * that do not depend on a sibling share one `parallel_group`. By construction no
 * same-stage entry depends on another, but the check is kept for safety.
 */
function assignParallelGroups(entries: DraftEntry[], stageKey: string): void {
  if (entries.length < 2) return;
  const ids = new Set(entries.map((e) => e.id));
  const independent = entries.filter((e) => !e.dependencies.some((d) => ids.has(d)));
  if (independent.length < 2) return;
  for (const e of independent) e.parallel_group = stageKey;
}

// ---------------------------------------------------------------------------
// Page classification (feature vs dashboard vs settings)
// ---------------------------------------------------------------------------

type PageBucket = 'feature' | 'dashboard' | 'settings';

function classifyPage(page: ArchPage): PageBucket {
  const hay = `${page.path} ${page.name}`.toLowerCase();
  if (/\b(setting|settings|account|profile|preferences|billing)\b/.test(hay)) return 'settings';
  if (/\b(dashboard|overview|analytics|reports?|metrics|insights)\b/.test(hay)) return 'dashboard';
  return 'feature';
}

// ---------------------------------------------------------------------------
// Description builders (detailed, buildable task text referencing real entities)
// ---------------------------------------------------------------------------

function withFooter(body: string): string {
  return `${body.trim()}\n\n${STATE_FOOTER}`;
}

function describeSchema(db: ArchitectureDesign['database']): string {
  const tableNames = db.tables.map((t) => t.name).filter((n) => n !== '');
  const tenant = db.tables.filter((t) => t.tenantScoped).map((t) => t.name);
  return withFooter(
    [
      `Create the database schema as migration files under supabase/migrations/.`,
      `Define all ${db.tables.length} table(s)${tableNames.length > 0 ? `: ${tableNames.join(', ')}` : ''} ` +
        `exactly as specified in SCHEMA_REGISTRY.md — every column, type, default, constraint, and foreign key.`,
      `Create the ${db.indexes.length} index(es) and apply the ${db.rlsPolicies.length} row-level-security policy/policies.`,
      tenant.length > 0
        ? `Tenant-scoped tables (${tenant.join(', ')}) MUST enable RLS with a company/tenant-scoped policy (Six Laws Law 1).`
        : `Enable RLS on every multi-tenant table (Six Laws Law 1).`,
      db.seeds.length > 0 ? `Load the ${db.seeds.length} seed data set(s) defined in SCHEMA_REGISTRY.md.` : '',
      `Apply the migrations against the database and confirm every table exists with the correct columns.`,
    ]
      .filter((s) => s !== '')
      .join(' ')
  );
}

function describeAuth(auth: ArchitectureDesign['auth']): string {
  const roles = auth.roles.map((r) => r.name).filter((n) => n !== '');
  return withFooter(
    [
      `Implement authentication and authorization per BEHAVIORAL_CONTRACTS.md.`,
      roles.length > 0 ? `Define the role(s): ${roles.join(', ')}.` : 'Define the application roles.',
      `Implement middleware.ts as a FULL FILE (never a patch). On ANY role-fetch failure the middleware MUST` +
        ` redirect to /login ONLY — never render a default or wrong-role page (Iron Law 4).`,
      auth.flows.length > 0 ? `Wire the auth flow(s): ${auth.flows.map((f) => f.name).join(', ')}.` : '',
      auth.multiTenancy.trim() !== '' ? `Multi-tenancy: ${auth.multiTenancy.trim()}` : '',
      `Every protected route derives company_id from the session, never from the request body (Six Laws Law 2).`,
    ]
      .filter((s) => s !== '')
      .join(' ')
  );
}

function describeApiGroup(resource: string, routes: ApiRoute[]): string {
  const lines = routes.map((r) => `${r.method} ${r.path} — ${r.purpose || 'route'}`);
  const tables = uniqueSorted(routes.flatMap((r) => [...r.dbReads, ...r.dbWrites]).map(normTable));
  return withFooter(
    [
      `Implement the "${resource}" API route(s) as Next.js App Router route handlers (app/api/.../route.ts):`,
      ...lines.map((l) => `  - ${l}`),
      `Each handler authenticates the user, derives company_id from the session (NEVER from the request body,`,
      `Six Laws Law 2), validates input, and returns the response shape defined in BEHAVIORAL_CONTRACTS.md.`,
      tables.length > 0 ? `Reads/writes only the real tables: ${tables.join(', ')} (no mocks — Iron Law 8).` : '',
      `Return documented error responses; never leak secrets or stack traces.`,
    ]
      .filter((s) => s !== '')
      .join('\n')
  );
}

function describeUiShell(fe: ArchitectureDesign['frontend']): string {
  const layouts = fe.layouts.map((l) => l.name).filter((n) => n !== '');
  return withFooter(
    [
      `Build the application UI shell: ${fe.layouts.length} layout(s)${layouts.length > 0 ? ` (${layouts.join(', ')})` : ''},` +
        ` the ${fe.components.length} shared component(s), and the design-token system.`,
      `Apply the design tokens (colors, typography, spacing, radii, shadows) from the architecture as the single` +
        ` source of truth — do not introduce a conflicting palette.`,
      fe.responsiveStrategy.trim() !== '' ? `Responsive strategy: ${fe.responsiveStrategy.trim()}` : '',
      `Render real components — no placeholder HTML in public/ (Iron Law 5). Handle empty states.`,
    ]
      .filter((s) => s !== '')
      .join(' ')
  );
}

function describePage(page: ArchPage, maps: InteractionMap[], bucket: PageBucket): string {
  const kind = bucket === 'feature' ? 'feature page' : bucket === 'dashboard' ? 'dashboard' : 'settings page';
  const elements = uniqueSorted(maps.map((m) => m.element).filter((e) => e !== ''));
  return withFooter(
    [
      `Build the ${kind} "${page.name || page.path}" at route ${page.path || '/'}.`,
      page.purpose.trim() !== '' ? `Purpose: ${page.purpose.trim()}.` : '',
      page.apiCalls.length > 0 ? `Wire it to the API endpoint(s): ${page.apiCalls.join(', ')}.` : '',
      page.components.length > 0 ? `Compose the component(s): ${page.components.join(', ')}.` : '',
      elements.length > 0
        ? `Implement every interactive element per INTERACTION_MAPS.md (${elements.join(', ')}) — each with its full` +
          ` action → API call → DB write → success/error response chain (Contract 18).`
        : `Implement each interactive element with its full action → API → DB → response chain (Contract 18).`,
      page.roles.length > 0 ? `Gate access to role(s): ${page.roles.join(', ')}.` : '',
      `Use only real API calls to real tables — no mock data (Iron Law 8). Handle loading and empty states.`,
    ]
      .filter((s) => s !== '')
      .join(' ')
  );
}

function describeAgent(agent: AgentSpec): string {
  return withFooter(
    [
      `Implement the "${agent.name}" agent per AGENTS.md.`,
      agent.purpose.trim() !== '' ? `Purpose: ${agent.purpose.trim()}.` : '',
      agent.trigger.trim() !== '' ? `Trigger: ${agent.trigger.trim()}.` : '',
      agent.inputContract.trim() !== '' ? `Input contract: ${agent.inputContract.trim()}.` : '',
      agent.outputContract.trim() !== '' ? `Output contract: ${agent.outputContract.trim()}.` : '',
      `Model: ${agent.model || 'the project default'}` +
        `${agent.tokenBudget === null ? '' : `, token budget ${agent.tokenBudget}`}.`,
      `Honor the system prompt and I/O contract exactly; never deploy a self-created agent without approval (Canonical Rule 3).`,
    ]
      .filter((s) => s !== '')
      .join(' ')
  );
}

function describeE2eTests(design: ArchitectureDesign): string {
  const specs = design.testing.playwrightSpecs.map((s) => s.name).filter((n) => n !== '');
  return withFooter(
    [
      `Write the Playwright end-to-end test suite per TESTING.md` +
        `${specs.length > 0 ? ` (specs: ${specs.join(', ')})` : ''}.`,
      `Cover the key user flows across every page, exercising navigation, forms, and role-based access.`,
      `Tests must verify real API calls to real tables (no mocks) and pass 10/10 before the build advances.`,
    ].join(' ')
  );
}

function describeApiTests(design: ArchitectureDesign): string {
  const routes = design.api.routes.map((r) => `${r.method} ${r.path}`).slice(0, 20);
  return withFooter(
    [
      `Write the API test suite per TESTING.md for the ${design.api.routes.length} route(s)` +
        `${routes.length > 0 ? `: ${routes.join('; ')}` : ''}.`,
      `Verify each route's auth requirement, response status and shape, company scoping, and documented errors.`,
    ].join(' ')
  );
}

function describeDeploy(design: ArchitectureDesign): string {
  const envNames = uniqueSorted(design.infra.environments.flatMap((e) => e.variables));
  return withFooter(
    [
      `Deploy the application following the FORGE deployment protocol: tsc --noEmit → build → deploy → tests pass 10/10.`,
      envNames.length > 0 ? `Ensure every required environment variable is set: ${envNames.join(', ')}.` : '',
      design.infra.deployConfig.trim() !== '' ? `Deploy config: ${design.infra.deployConfig.trim()}.` : '',
      `Abort the deploy if any gate fails — never force-push broken code.`,
    ]
      .filter((s) => s !== '')
      .join(' ')
  );
}

function describeVerify(design: ArchitectureDesign): string {
  return withFooter(
    [
      `Run automated Six Laws verification (Contract 19) for the ${design.database.tables.length} table(s),` +
        ` ${design.api.routes.length} route(s), and ${design.frontend.pages.length} page(s):`,
      `Law 1 SCHEMA — every table from SCHEMA_REGISTRY.md exists with correct columns and RLS;`,
      `Law 2 API — every endpoint responds with the contracted status and shape;`,
      `Law 3 UI — every page renders with no placeholder/"coming soon" text;`,
      `Law 4 DATA — pages make real API calls to real tables (no mock data);`,
      `Law 5 WIRING — navigation, forms, and role gates work end-to-end.`,
      `Laws 1-5 must ALL pass; Law 6 (human verification in the browser) is the final Gate.`,
    ].join(' ')
  );
}

/** De-duplicate, drop empties, and sort a string list. */
function uniqueSorted(items: string[]): string[] {
  return [...new Set(items.map((s) => s.trim()).filter((s) => s !== ''))].sort((a, b) =>
    a.localeCompare(b)
  );
}

// ---------------------------------------------------------------------------
// Core: build the dependency-ordered queue from the design
// ---------------------------------------------------------------------------

/**
 * Transform an {@link ArchitectureDesign} into the dependency-ordered list of build prompts,
 * in the standard FORGE build order. Pure and deterministic; collects non-fatal observations
 * into `warnings`.
 */
export function buildQueueEntries(design: ArchitectureDesign, warnings: string[] = []): QueueEntry[] {
  const used = new Set<string>();
  const drafts: DraftEntry[] = [];

  // --- Stage: schema ------------------------------------------------------
  const schemaIds: string[] = [];
  if (design.database.tables.length > 0) {
    const id = uniqueId('schema-migrations', used);
    schemaIds.push(id);
    drafts.push({
      id,
      name: 'Database schema & migrations',
      prompt_type: 'schema',
      dependencies: [],
      parallel_group: null,
      governance_refs: GOVERNANCE_REFS.schema,
      estimated_tokens: estimate(
        BASE_TOKENS.schema +
          design.database.tables.length * 800 +
          design.database.indexes.length * 150 +
          design.database.rlsPolicies.length * 200 +
          design.database.seeds.length * 150
      ),
      context_injection: {
        schemaSections: uniqueSorted(design.database.tables.map((t: ArchTable) => t.name)),
        behavioralSections: [],
        interactionMaps: [],
      },
      description: describeSchema(design.database),
    });
  } else {
    warnings.push('Design defines no tables — the queue has no schema stage.');
  }

  // --- Stage: auth --------------------------------------------------------
  const authIds: string[] = [];
  const tenantTables = design.database.tables.filter((t) => t.tenantScoped).map((t) => t.name);
  const needsAuth =
    design.auth.roles.length > 0 ||
    design.auth.flows.length > 0 ||
    tenantTables.length > 0 ||
    design.api.routes.some((r) => r.authRequired);
  if (needsAuth) {
    const id = uniqueId('auth-setup', used);
    authIds.push(id);
    drafts.push({
      id,
      name: 'Authentication & authorization',
      prompt_type: 'auth',
      dependencies: [...schemaIds],
      parallel_group: null,
      governance_refs: GOVERNANCE_REFS.auth,
      estimated_tokens: estimate(
        BASE_TOKENS.auth + design.auth.roles.length * 400 + design.auth.flows.length * 400
      ),
      context_injection: {
        schemaSections: uniqueSorted(tenantTables),
        behavioralSections: ['Authentication & Authorization'],
        interactionMaps: [],
      },
      description: describeAuth(design.auth),
    });
  }

  // --- Stage: api ---------------------------------------------------------
  // Group routes by resource (first path segment). Each group → one prompt; route → group id.
  const apiGroups = new Map<string, ApiRoute[]>();
  for (const route of design.api.routes) {
    if (route.path.trim() === '') continue;
    const resource = routeResource(route.path);
    const list = apiGroups.get(resource);
    if (list) list.push(route);
    else apiGroups.set(resource, [route]);
  }
  const apiIds: string[] = [];
  const routePathToApiId = new Map<string, string>(); // normalized route path → api entry id
  const resourceToApiId = new Map<string, string>();
  const apiDrafts: DraftEntry[] = [];
  for (const [resource, routes] of apiGroups) {
    const id = uniqueId(`api-${slug(resource, 'routes')}`, used);
    apiIds.push(id);
    resourceToApiId.set(resource, id);
    for (const r of routes) routePathToApiId.set(normRoute(r.path), id);
    const tables = uniqueSorted(routes.flatMap((r) => [...r.dbReads, ...r.dbWrites]).map(normTable));
    apiDrafts.push({
      id,
      name: `API: ${resource} (${routes.length} route${routes.length === 1 ? '' : 's'})`,
      prompt_type: 'api',
      dependencies: [...schemaIds, ...authIds],
      parallel_group: null,
      governance_refs: GOVERNANCE_REFS.api,
      estimated_tokens: estimate(BASE_TOKENS.api + routes.length * 1200 + tables.length * 200),
      context_injection: {
        schemaSections: tables,
        behavioralSections: ['API Contracts'],
        interactionMaps: [],
      },
      description: describeApiGroup(resource, routes),
    });
  }
  assignParallelGroups(apiDrafts, 'api-routes');
  drafts.push(...apiDrafts);

  /** Resolve which api entry ids serve a set of apiCall references (by path, then resource). */
  function resolveApiDeps(apiCalls: string[]): string[] {
    const ids = new Set<string>();
    for (const call of apiCalls) {
      const norm = normRoute(call);
      const direct = routePathToApiId.get(norm);
      if (direct) {
        ids.add(direct);
        continue;
      }
      const byResource = resourceToApiId.get(routeResource(call));
      if (byResource) ids.add(byResource);
    }
    return [...ids];
  }

  // --- Stage: ui (shell) --------------------------------------------------
  const uiIds: string[] = [];
  const hasFrontend =
    design.frontend.pages.length > 0 ||
    design.frontend.components.length > 0 ||
    design.frontend.layouts.length > 0;
  if (hasFrontend) {
    const id = uniqueId('ui-shell', used);
    uiIds.push(id);
    drafts.push({
      id,
      name: 'UI shell, layouts & design tokens',
      prompt_type: 'ui',
      dependencies: [...authIds],
      parallel_group: null,
      governance_refs: GOVERNANCE_REFS.ui,
      estimated_tokens: estimate(
        BASE_TOKENS.ui + design.frontend.components.length * 250 + design.frontend.layouts.length * 300
      ),
      context_injection: { schemaSections: [], behavioralSections: [], interactionMaps: [] },
      description: describeUiShell(design.frontend),
    });
  }

  // --- Stages: features / dashboards / settings (page-centric) ------------
  // Match interaction maps to pages by shared apiCall, then by feature-name token overlap.
  const matchedMapIdx = new Set<number>();
  function mapsForPage(page: ArchPage): InteractionMap[] {
    const pageRoutes = new Set(page.apiCalls.map(normRoute));
    const pageTokens = tokens(`${page.name} ${page.path}`);
    const result: InteractionMap[] = [];
    design.interactionMaps.maps.forEach((m, i) => {
      const byApi = m.apiCall.trim() !== '' && pageRoutes.has(normRoute(m.apiCall));
      const byName = tokensOverlap(tokens(m.feature), pageTokens);
      if (byApi || byName) {
        result.push(m);
        matchedMapIdx.add(i);
      }
    });
    return result;
  }

  const pageBuckets: Record<PageBucket, DraftEntry[]> = { feature: [], dashboard: [], settings: [] };
  for (const page of design.frontend.pages) {
    if (page.path === '/' && page.apiCalls.length === 0 && page.components.length === 0) continue; // bare root
    const bucket = classifyPage(page);
    const maps = mapsForPage(page);
    const stagePrefix = bucket === 'feature' ? 'feature' : bucket;
    const id = uniqueId(`${stagePrefix}-${slug(page.name || page.path, 'page')}`, used);
    const apiDeps = resolveApiDeps(page.apiCalls);
    const tablesTouched = uniqueSorted([
      ...maps.map((m) => normTable(m.dbWrite)).filter((t) => t !== '' && t !== 'none'),
      ...design.api.routes
        .filter((r) => apiDeps.includes(routePathToApiId.get(normRoute(r.path)) ?? ''))
        .flatMap((r) => [...r.dbReads, ...r.dbWrites].map(normTable)),
    ]);
    pageBuckets[bucket].push({
      id,
      name: `${bucket === 'feature' ? 'Feature' : bucket === 'dashboard' ? 'Dashboard' : 'Settings'}: ${page.name || page.path}`,
      prompt_type: 'feature',
      dependencies: [...apiDeps, ...uiIds],
      parallel_group: null,
      governance_refs: GOVERNANCE_REFS.feature,
      estimated_tokens: estimate(
        BASE_TOKENS.feature + maps.length * 600 + page.apiCalls.length * 300 + page.components.length * 150
      ),
      context_injection: {
        schemaSections: tablesTouched,
        behavioralSections: page.apiCalls.length > 0 ? ['API Contracts'] : [],
        interactionMaps: uniqueSorted(maps.map((m) => `${m.feature}: ${m.element}`)),
      },
      description: describePage(page, maps, bucket),
    });
  }

  // Interaction-map features with no matching page → standalone feature prompts (Contract 18).
  const leftover = new Map<string, InteractionMap[]>();
  design.interactionMaps.maps.forEach((m, i) => {
    if (matchedMapIdx.has(i)) return;
    const key = m.feature.trim() || '(unspecified)';
    const list = leftover.get(key);
    if (list) list.push(m);
    else leftover.set(key, [m]);
  });
  for (const [feature, maps] of leftover) {
    const id = uniqueId(`feature-${slug(feature, 'feature')}`, used);
    const apiDeps = resolveApiDeps(maps.map((m) => m.apiCall));
    const tablesTouched = uniqueSorted(
      maps.map((m) => normTable(m.dbWrite)).filter((t) => t !== '' && t !== 'none')
    );
    pageBuckets.feature.push({
      id,
      name: `Feature: ${feature}`,
      prompt_type: 'feature',
      dependencies: [...apiDeps, ...uiIds],
      parallel_group: null,
      governance_refs: GOVERNANCE_REFS.feature,
      estimated_tokens: estimate(BASE_TOKENS.feature + maps.length * 600),
      context_injection: {
        schemaSections: tablesTouched,
        behavioralSections: ['API Contracts'],
        interactionMaps: uniqueSorted(maps.map((m) => `${m.feature}: ${m.element}`)),
      },
      description: withFooter(
        [
          `Build the "${feature}" feature, implementing every interactive element per INTERACTION_MAPS.md` +
            ` (${uniqueSorted(maps.map((m) => m.element)).join(', ')}).`,
          `Each element follows the full action → API call → DB write → success/error response chain (Contract 18).`,
          `Use real API calls to real tables — no mock data (Iron Law 8).`,
        ].join(' ')
      ),
    });
  }

  // Emit feature/dashboard/settings stages in standard order, parallel-grouped per stage.
  assignParallelGroups(pageBuckets.feature, 'features');
  assignParallelGroups(pageBuckets.dashboard, 'dashboards');
  assignParallelGroups(pageBuckets.settings, 'settings');
  const featureIds = pageBuckets.feature.map((e) => e.id);
  const dashboardIds = pageBuckets.dashboard.map((e) => e.id);
  const settingsIds = pageBuckets.settings.map((e) => e.id);

  // --- Stage: agents ------------------------------------------------------
  const agentDrafts: DraftEntry[] = [];
  for (const agent of design.agents.agents) {
    if (agent.name.trim() === '') continue;
    const id = uniqueId(`agent-${slug(agent.name, 'agent')}`, used);
    agentDrafts.push({
      id,
      name: `Agent: ${agent.name}`,
      prompt_type: 'agent',
      dependencies: [...schemaIds, ...apiIds],
      parallel_group: null,
      governance_refs: GOVERNANCE_REFS.agent,
      estimated_tokens: estimate(
        BASE_TOKENS.agent + Math.ceil(agent.systemPrompt.length / 4) + (agent.tokenBudget ?? 0) / 10
      ),
      context_injection: { schemaSections: [], behavioralSections: [], interactionMaps: [] },
      description: describeAgent(agent),
    });
  }
  assignParallelGroups(agentDrafts, 'agents');
  const agentIds = agentDrafts.map((e) => e.id);

  // Append page + agent stages in the standard order.
  drafts.push(...pageBuckets.feature, ...agentDrafts, ...pageBuckets.dashboard, ...pageBuckets.settings);

  // --- Stage: tests -------------------------------------------------------
  const testDrafts: DraftEntry[] = [];
  const allPageIds = [...featureIds, ...dashboardIds, ...settingsIds];
  if (allPageIds.length > 0 || design.testing.playwrightSpecs.length > 0) {
    const id = uniqueId('tests-e2e', used);
    testDrafts.push({
      id,
      name: 'End-to-end (Playwright) tests',
      prompt_type: 'test',
      dependencies: [...allPageIds, ...agentIds],
      parallel_group: null,
      governance_refs: GOVERNANCE_REFS.test,
      estimated_tokens: estimate(
        BASE_TOKENS.test +
          design.testing.playwrightSpecs.length * 500 +
          new Set(design.interactionMaps.maps.map((m) => m.feature)).size * 300
      ),
      context_injection: {
        schemaSections: [],
        behavioralSections: ['Interaction Contracts (summary)'],
        interactionMaps: uniqueSorted(design.interactionMaps.maps.map((m) => m.feature)),
      },
      description: describeE2eTests(design),
    });
  }
  if (apiIds.length > 0 || design.testing.apiTests.length > 0) {
    const id = uniqueId('tests-api', used);
    testDrafts.push({
      id,
      name: 'API tests',
      prompt_type: 'test',
      dependencies: [...apiIds],
      parallel_group: null,
      governance_refs: GOVERNANCE_REFS.test,
      estimated_tokens: estimate(
        BASE_TOKENS.test + design.testing.apiTests.length * 400 + design.api.routes.length * 200
      ),
      context_injection: {
        schemaSections: [],
        behavioralSections: ['API Contracts'],
        interactionMaps: [],
      },
      description: describeApiTests(design),
    });
  }
  assignParallelGroups(testDrafts, 'tests');
  const testIds = testDrafts.map((e) => e.id);
  drafts.push(...testDrafts);

  // --- Stage: deploy ------------------------------------------------------
  const deployIds: string[] = [];
  {
    const id = uniqueId('deploy', used);
    deployIds.push(id);
    const envNames = uniqueSorted(design.infra.environments.flatMap((e) => e.variables));
    drafts.push({
      id,
      name: 'Deploy to production',
      prompt_type: 'deploy',
      // Deploy depends on tests when present, else on everything built so far.
      dependencies:
        testIds.length > 0
          ? [...testIds]
          : [...allPageIds, ...agentIds, ...apiIds, ...uiIds, ...authIds, ...schemaIds],
      parallel_group: null,
      governance_refs: GOVERNANCE_REFS.deploy,
      estimated_tokens: estimate(BASE_TOKENS.deploy + envNames.length * 100),
      context_injection: { schemaSections: [], behavioralSections: [], interactionMaps: [] },
      description: describeDeploy(design),
    });
  }

  // --- Stage: verify (Six Laws, automated Laws 1-5) -----------------------
  {
    const id = uniqueId('verify-six-laws', used);
    drafts.push({
      id,
      name: 'Six Laws verification',
      prompt_type: 'test',
      dependencies: [...deployIds],
      parallel_group: null,
      governance_refs: ['TESTING.md', 'BEHAVIORAL_CONTRACTS.md', 'SCHEMA_REGISTRY.md'],
      estimated_tokens: estimate(
        5000 + design.database.tables.length * 200 + design.api.routes.length * 100
      ),
      context_injection: {
        schemaSections: uniqueSorted(design.database.tables.map((t) => t.name)),
        behavioralSections: ['API Contracts', 'Authentication & Authorization'],
        interactionMaps: [],
      },
      description: describeVerify(design),
    });
  }

  // Finalize: drop the internal non-null parallel_group sentinel for the public shape.
  return drafts.map((d) => {
    const entry: QueueEntry = {
      id: d.id,
      name: d.name,
      prompt_type: d.prompt_type,
      dependencies: d.dependencies,
      governance_refs: d.governance_refs,
      estimated_tokens: d.estimated_tokens,
      context_injection: d.context_injection,
      description: d.description,
    };
    if (d.parallel_group !== null) entry.parallel_group = d.parallel_group;
    return entry;
  });
}

// ---------------------------------------------------------------------------
// Statistics (incl. longest dependency chain)
// ---------------------------------------------------------------------------

function computeStats(entries: QueueEntry[]): QueueStats {
  const byType: Record<PromptType, number> = {
    schema: 0,
    auth: 0,
    api: 0,
    ui: 0,
    feature: 0,
    agent: 0,
    test: 0,
    deploy: 0,
  };
  let totalEstimatedTokens = 0;
  const groups = new Set<string>();
  for (const e of entries) {
    byType[e.prompt_type] += 1;
    totalEstimatedTokens += e.estimated_tokens;
    if (e.parallel_group) groups.add(e.parallel_group);
  }

  // Longest dependency chain via memoized DFS (cycle-guarded — stages are acyclic by design).
  const byId = new Map<string, QueueEntry>(entries.map((e) => [e.id, e]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  function chain(id: string): number {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 1; // defensive: break an unexpected cycle
    const entry = byId.get(id);
    if (!entry || entry.dependencies.length === 0) {
      depth.set(id, 1);
      return 1;
    }
    visiting.add(id);
    let best = 0;
    for (const dep of entry.dependencies) best = Math.max(best, chain(dep));
    visiting.delete(id);
    const result = best + 1;
    depth.set(id, result);
    return result;
  }
  let longestChain = 0;
  for (const e of entries) longestChain = Math.max(longestChain, chain(e.id));

  return {
    totalPrompts: entries.length,
    byType,
    parallelGroups: groups.size,
    totalEstimatedTokens,
    longestChain,
  };
}

// ---------------------------------------------------------------------------
// YAML serialization (custom emitter — controls key order, block scalars, comments)
// ---------------------------------------------------------------------------

/** True when a string is safe to emit as a plain (unquoted) YAML scalar. */
function isPlainScalarSafe(s: string): boolean {
  if (s === '') return false;
  if (!/^[A-Za-z][A-Za-z0-9_./-]*$/.test(s)) return false;
  // Avoid YAML reserved words that would parse as a boolean/null.
  return !/^(true|false|null|yes|no|on|off|~)$/i.test(s);
}

/** Encode a string as a YAML scalar — plain when safe, otherwise double-quoted. */
function yamlScalar(s: string): string {
  if (isPlainScalarSafe(s)) return s;
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** Encode a string array as a YAML flow sequence: `[a, b, c]` (or `[]`). */
function yamlFlowList(items: string[]): string {
  if (items.length === 0) return '[]';
  return `[${items.map(yamlScalar).join(', ')}]`;
}

/** Encode a multi-line value as a YAML block literal at the given indent (number of spaces). */
function yamlBlockLiteral(value: string, indent: number): string {
  const pad = ' '.repeat(indent);
  const body = value
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/g, '') // strip trailing blank lines (we use `|`, not `|+`)
    .split('\n')
    .map((line) => (line === '' ? '' : pad + line))
    .join('\n');
  return `|\n${body}`;
}

/** Serialize one queue entry to its YAML block (a single `- …` list item). */
function emitEntry(entry: QueueEntry): string {
  const lines: string[] = [];
  lines.push(`- id: ${yamlScalar(entry.id)}`);
  lines.push(`  name: ${yamlScalar(entry.name)}`);
  lines.push(`  prompt_type: ${yamlScalar(entry.prompt_type)}`);
  lines.push(`  dependencies: ${yamlFlowList(entry.dependencies)}`);
  if (entry.parallel_group !== undefined) {
    lines.push(`  parallel_group: ${yamlScalar(entry.parallel_group)}`);
  }
  lines.push(`  governance_refs: ${yamlFlowList(entry.governance_refs)}`);
  lines.push(`  estimated_tokens: ${entry.estimated_tokens}`);
  lines.push('  context_injection:');
  lines.push(`    schema_sections: ${yamlFlowList(entry.context_injection.schemaSections)}`);
  lines.push(`    behavioral_sections: ${yamlFlowList(entry.context_injection.behavioralSections)}`);
  lines.push(`    interaction_maps: ${yamlFlowList(entry.context_injection.interactionMaps)}`);
  // Description last, as a block literal indented under the key.
  lines.push(`  description: ${yamlBlockLiteral(entry.description, 4)}`);
  return lines.join('\n');
}

/** The header comment block at the top of the generated queue.yaml. */
function emitHeader(projectName: string, projectPath: string, generatedAt: string, stats: QueueStats): string {
  return [
    `# ${projectName} — FORGE 2.0 Build Queue`,
    `# Generated by the FORGE Queue Generator (s4-p02) on ${generatedAt}.`,
    `# Working directory: ${projectPath}`,
    `# Each prompt is executed via: claude -p --dangerously-skip-permissions`,
    `#`,
    `# ${stats.totalPrompts} prompt(s), ${stats.parallelGroups} parallel group(s),` +
      ` longest dependency chain ${stats.longestChain}, ~${stats.totalEstimatedTokens} estimated tokens.`,
    `# Standard build order: schema → auth → api → ui → features → agents → dashboards → settings → tests → deploy → verify.`,
    `# Build HALTS after governance + queue for Gate 3 (human approval, Contract 2).`,
    '',
  ].join('\n');
}

/** Serialize the full queue (header + every entry) to queue.yaml text. */
export function serializeQueue(
  entries: QueueEntry[],
  meta: { projectName: string; projectPath: string; generatedAt: string; stats: QueueStats }
): string {
  const header = emitHeader(meta.projectName, meta.projectPath, meta.generatedAt, meta.stats);
  const body = entries.map(emitEntry).join('\n\n');
  return `${header}\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate `queue.yaml` for `projectPath` from the approved {@link ArchitectureDesign} and
 * write it to the target project directory. Then HALTS for Gate 3 (Contract 2).
 *
 * Always resolves (never rejects). The queue is built deterministically; the single file
 * write is guarded so a failure is collected as a warning rather than thrown.
 */
export async function generateQueue(
  projectPath: string,
  design: ArchitectureDesign,
  options: QueueGeneratorOptions = {}
): Promise<QueuePlan> {
  const log = options.log ?? logLine('queue');
  const projectName = options.projectName ?? design.projectName ?? basename(projectPath) ?? 'project';
  const queueFileName = options.queueFileName ?? 'queue.yaml';
  const writeFlag = options.writeFile ?? true;
  const generatedAt = nowIso();
  const warnings: string[] = [];

  log(`generating build queue for "${projectName}"`);

  const entries = buildQueueEntries(design, warnings);
  const stats = computeStats(entries);
  const yaml = serializeQueue(entries, { projectName, projectPath, generatedAt, stats });

  let queuePath: string | null = null;
  if (writeFlag) {
    const target = join(projectPath, queueFileName);
    try {
      await writeFile(target, yaml, 'utf8');
      queuePath = target;
      log(`wrote ${queueFileName} (${stats.totalPrompts} prompt(s), ${Buffer.byteLength(yaml, 'utf8')} bytes)`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to write ${queueFileName} to ${target} (${reason}).`);
      log(`WARNING: could not write ${queueFileName} (${reason})`);
    }
  }

  const gate: Gate3Status = {
    name: 'Gate 3 -- Governance Approval',
    status: 'awaiting_human_approval',
    detail:
      `queue.yaml generated (${stats.totalPrompts} prompt(s), ${stats.parallelGroups} parallel group(s)). ` +
      'The build HALTS here until a human approves the governance package AND this queue ' +
      '(BEHAVIORAL_CONTRACTS Contract 2). Phase 3 (Build Executor) must not start before approval.',
  };

  log(
    `queue complete — ${stats.totalPrompts} prompt(s), ${stats.parallelGroups} parallel group(s), ` +
      `longest chain ${stats.longestChain}. HALT for Gate 3 (human approval required).`
  );

  return { projectName, queuePath, entries, yaml, stats, warnings, gate, generatedAt };
}

export default generateQueue;

// ---------------------------------------------------------------------------
// Composer Engine types -- DAGNode, ForgeDAG, runAdversarialQueueReview
// ---------------------------------------------------------------------------

/** A single atomic build task in the Composer DAG. */
export interface DAGNode {
  id: string;
  name: string;
  /** SCAFFOLD | CRUD | INTEGRATION | AI_PIPELINE | CONFIG | TEST | FIX */
  taskType: string;
  /** LOW | MEDIUM | HIGH | CRITICAL */
  complexity: string;
  estimatedTokens: number;
  dependsOn: string[];
  filesCreate: string[];
  filesModify: string[];
  dbTables: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  /** CRITICAL | WARN | BUILD | INJECT */
  tier: string;
}

/** Directed-acyclic-graph of DAGNodes with dependency inference and topological sort. */
export class ForgeDAG {
  private nodes: Map<string, DAGNode> = new Map();

  addNode(node: DAGNode): void {
    this.nodes.set(node.id, node);
  }

  /** Infer implicit dependencies: nodes that write a table another node reads. */
  inferDependencies(): void {
    const tableWriters = new Map<string, string[]>();
    for (const node of this.nodes.values()) {
      for (const table of node.dbTables) {
        const writers = tableWriters.get(table) ?? [];
        writers.push(node.id);
        tableWriters.set(table, writers);
      }
    }
    for (const node of this.nodes.values()) {
      const impliedDeps = new Set<string>(node.dependsOn);
      for (const table of node.dbTables) {
        const writers = tableWriters.get(table) ?? [];
        for (const writerId of writers) {
          if (writerId !== node.id) impliedDeps.add(writerId);
        }
      }
      node.dependsOn = [...impliedDeps];
    }
  }

  /** Returns arrays of node ids forming cycles, or empty array if acyclic. */
  detectCycles(): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const stack = new Set<string>();
    const path: string[] = [];

    const dfs = (id: string): void => {
      if (stack.has(id)) {
        const cycleStart = path.indexOf(id);
        if (cycleStart >= 0) cycles.push([...path.slice(cycleStart), id]);
        return;
      }
      if (visited.has(id)) return;
      visited.add(id);
      stack.add(id);
      path.push(id);
      const node = this.nodes.get(id);
      if (node) {
        for (const dep of node.dependsOn) dfs(dep);
      }
      path.pop();
      stack.delete(id);
    };

    for (const id of this.nodes.keys()) dfs(id);
    return cycles;
  }

  /** Returns nodes in dependency-first topological order (Kahn's algorithm). */
  topologicalSort(): DAGNode[] {
    const inDegree = new Map<string, number>();
    const adjReverse = new Map<string, string[]>();
    for (const [id] of this.nodes) {
      inDegree.set(id, 0);
      adjReverse.set(id, []);
    }
    for (const node of this.nodes.values()) {
      for (const dep of node.dependsOn) {
        if (this.nodes.has(dep)) {
          inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
          const rev = adjReverse.get(dep) ?? [];
          rev.push(node.id);
          adjReverse.set(dep, rev);
        }
      }
    }
    const queue: string[] = [];
    for (const [id, deg] of inDegree) { if (deg === 0) queue.push(id); }
    const result: DAGNode[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const node = this.nodes.get(id);
      if (node) result.push(node);
      for (const neighbor of adjReverse.get(id) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }
    // Append any remaining nodes (in case of cycles that weren't caught).
    for (const node of this.nodes.values()) {
      if (!result.find((r) => r.id === node.id)) result.push(node);
    }
    return result;
  }
}

export interface AdversarialQueueReviewResult {
  canProceed: boolean;
  blockers: string[];
  warnings: string[];
}

/**
 * Adversarially review a queue of DAGNodes using the Claude API.
 * Falls back to a permissive result if the API call fails.
 */
export async function runAdversarialQueueReview(
  nodes: DAGNode[],
  apiKey: string
): Promise<AdversarialQueueReviewResult> {
  const fallback: AdversarialQueueReviewResult = { canProceed: true, blockers: [], warnings: [] };
  if (nodes.length === 0) return fallback;
  try {
    const summary = nodes.slice(0, 30).map((n) => `- ${n.id}: ${n.name} [${n.tier}] deps=[${n.dependsOn.join(',')}]`).join('\n');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: 'Review this build queue for ordering problems, missing deps, or risky tasks. Respond ONLY with JSON: { "blockers": string[], "warnings": string[], "canProceed": boolean }',
        messages: [{ role: 'user', content: 'Review this queue:\n' + summary }],
      }),
    });
    if (!res.ok) return fallback;
    const data = await res.json() as { content: Array<{ type: string; text?: string }> };
    const text = data.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim()) as AdversarialQueueReviewResult;
    return { canProceed: parsed.canProceed ?? true, blockers: parsed.blockers ?? [], warnings: parsed.warnings ?? [] };
  } catch {
    return fallback;
  }
}
