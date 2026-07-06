/**
 * FORGE 2.0 — Phase 1B: Architecture Engine.
 *
 * Phase 1B is the second design phase (queue.yaml s3-p05). It takes an APPROVED PRD
 * (the output of Phase 1A, s3-p04) plus an OPTIONAL {@link ConstraintManifest} (the
 * output of Phase 1C, s3-p03, for partial builds) and produces the complete set of
 * design artifacts the Governance Generator (Phase 2, s4-p01) turns into the
 * governance package. It then HALTS for Gate 2 human approval (BEHAVIORAL_CONTRACTS
 * Contract 2 — no bypass).
 *
 * EIGHT ARTIFACTS are produced, each as a structured object PLUS a Markdown section:
 *   1. DatabaseArchitecture  — tables, columns, types, constraints, RLS, indexes, seeds, migrations
 *   2. APIArchitecture       — routes, methods, request/response schemas, auth, errors
 *   3. FrontendArchitecture  — pages, components, layouts, design tokens, responsive strategy
 *   4. InteractionMaps       — per-feature: user action → frontend reaction → API call →
 *                              backend processing → DB write → side effects → success/error
 *                              responses → tracking event (Contract 18 granularity)
 *   5. AuthArchitecture      — flows, roles, permissions, middleware, multi-tenancy
 *   6. AgentArchitecture     — agents, triggers, I/O contracts, orchestration, prompts, budgets
 *   7. InfraArchitecture     — environments, deploy config, monitoring, performance budgets
 *   8. TestingStrategy       — Playwright specs, API tests, Six Laws verification plan
 *
 * CHUNKING (context-window safety): each artifact is generated in its OWN Claude call.
 * Rather than feed every prior artifact back in full, a compact "design state so far"
 * SUMMARY (table names, route paths, page paths, role names, …) is threaded into each
 * subsequent call so later artifacts stay consistent with earlier decisions without
 * blowing the context window. The artifacts are generated in dependency order
 * (database → api → frontend → interactionMaps → auth → agents → infra → testing).
 *
 * CROSS-VALIDATION: after all eight are generated, the artifacts are checked against
 * one another — schema↔API (every table an API route reads/writes exists), API↔frontend
 * (every endpoint a page calls exists), frontend↔interaction-maps (every interaction
 * map's API call and DB write resolve to a real route/table). Inconsistencies are
 * surfaced as {@link ValidationIssue}s for the operator at Gate 2 (never auto-fixed).
 *
 * CONSTRAINT MANIFEST: when one is supplied for a partial build, every IMMUTABLE item
 * (existing tables/routes/components/design tokens) is injected into the prompts as
 * FIXED, and the model is instructed to design ONLY the extensions and to mark any
 * entity it merely restates with `immutable: true`. Immutable tables/routes also count
 * as "existing" during cross-validation so extending them is not flagged.
 *
 * MODEL: the Anthropic Messages API, via the injectable model client EXPORTED by Phase
 * 1A ({@link defaultCallModel} / {@link CallModel}) — reused so both design phases share
 * one transport (no SDK dependency; fully injectable for tests). Default model id is
 * {@link DEFAULT_MODEL}, overridable via `options.model` / the `FORGE_ARCHITECT_MODEL`
 * env var.
 *
 * NON-FATAL house style (matching the sibling phase orchestrators): every Build Memory
 * read is guarded (Contract 4 — degrade to stateless) and EACH artifact's model call is
 * wrapped so a failure never throws. If a call fails (or returns non-JSON), that ONE
 * artifact degrades to a clearly-marked deterministic skeleton, `usedFallback` is set,
 * the artifact kind is recorded in `fallbackArtifacts`, and a warning is collected — the
 * other seven artifacts still generate. `runPhase1bArchitect` never rejects.
 *
 * SECURITY: the Anthropic API key is read from `options.apiKey` / `ANTHROPIC_API_KEY`
 * and sent only in the request header (by the reused Phase 1A client); it is never
 * logged or returned. No secrets from the target project are read here.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

import { runAdversarialReview } from '../analysis/adversarial-review.js';
import type { AdversaryResult } from '../analysis/adversarial-review.js';

import type { StackFingerprint } from '../tools/stack-detector.js';
import type { ConstraintManifest } from './phase1c-ingest.js';
import type { CallModel } from './phase1a-prd.js';
import { providerCallModel } from '../engine/provider-router.js';
import {
  generateDesignSystem,
  renderDesignSystemPromptBlock,
  deriveProductTypeQuery,
} from '../tools/design-system-generator.js';
import type { DesignSystemOptions } from '../tools/design-system-generator.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import { logLine } from '../tools/forge-logger.js';
import { extractJsonObject as extractJson, JSON_ONLY_DIRECTIVE } from '../tools/json-extraction.js';
import type { BrandIdentity, CrossProjectInsight, DesignPattern, JsonObject } from '../types/index.js';

// ---------------------------------------------------------------------------
// Artifact contract types (each artifact: a structured object + a `markdown` field)
// ---------------------------------------------------------------------------

/** The eight design-artifact kinds Phase 1B produces, in dependency order. */
export type ArtifactKind =
  | 'database'
  | 'api'
  | 'frontend'
  | 'interactionMaps'
  | 'auth'
  | 'agents'
  | 'infra'
  | 'testing';

/** The eight governance documents Phase 1B generates from the design artifacts. */
export type GovernanceDocName =
  | 'BLUEPRINT.md'
  | 'SCHEMA_REGISTRY.md'
  | 'AGENTS.md'
  | 'BEHAVIORAL_CONTRACTS.md'
  | 'INTERACTION_MAPS.md'
  | 'TESTING.md'
  | 'STATE_OF_THE_BUILD.md'
  | 'SESSION_STATE.md';

// --- 1. DatabaseArchitecture ----------------------------------------------

/** A single column in a designed table. */
export interface ArchColumn {
  name: string;
  type: string;
  nullable: boolean;
  /** Default expression, or `null` for none. */
  default: string | null;
  /** Inline constraints (e.g. `unique`, `check (...)`). */
  constraints: string[];
}

/** A foreign-key relationship out of a designed table. */
export interface ArchForeignKey {
  columns: string[];
  referencesTable: string;
  referencesColumns: string[];
  /** ON DELETE action (`cascade`, `set null`, …), or `null`. */
  onDelete: string | null;
}

/** A designed index. */
export interface ArchIndex {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
  /** Index method (`btree`, `gin`, …), or `null` for the default. */
  method: string | null;
  /** Partial-index predicate, or `null`. */
  where: string | null;
}

/** A designed row-level-security policy. */
export interface ArchRlsPolicy {
  name: string;
  table: string;
  /** `select` | `insert` | `update` | `delete` | `all`. */
  command: string;
  roles: string[];
  /** USING expression, or `null`. */
  using: string | null;
  /** WITH CHECK expression, or `null`. */
  check: string | null;
}

/** A designed database table. */
export interface ArchTable {
  name: string;
  schema: string;
  purpose: string;
  columns: ArchColumn[];
  primaryKey: string[];
  foreignKeys: ArchForeignKey[];
  rlsEnabled: boolean;
  /** Whether the table carries a company/tenant scope column (Six Laws Law 1). */
  tenantScoped: boolean;
  /** True when this table is restated from a ConstraintManifest (already exists). */
  immutable: boolean;
}

/** A designed seed-data load. */
export interface ArchSeed {
  table: string;
  description: string;
  /** Approximate row count, or `null` if open-ended. */
  rowCount: number | null;
}

/** A planned migration file. */
export interface ArchMigration {
  filename: string;
  description: string;
}

/** Artifact 1 — the full database design. */
export interface DatabaseArchitecture {
  tables: ArchTable[];
  indexes: ArchIndex[];
  rlsPolicies: ArchRlsPolicy[];
  seeds: ArchSeed[];
  migrations: ArchMigration[];
  markdown: string;
}

// --- 2. APIArchitecture ----------------------------------------------------

/** A documented error response for an API route. */
export interface ApiError {
  status: number;
  code: string;
  description: string;
}

/** A designed API route. */
export interface ApiRoute {
  path: string;
  /** HTTP method (kept as a string to tolerate model output). */
  method: string;
  purpose: string;
  authRequired: boolean;
  /** Roles permitted to call the route (empty = any authenticated user). */
  roles: string[];
  /** Human/JSON description of the request body/query shape. */
  requestSchema: string;
  /** Human/JSON description of the success response shape. */
  responseSchema: string;
  /** Tables this route READS (names) — cross-validated against the schema. */
  dbReads: string[];
  /** Tables this route WRITES (names) — cross-validated against the schema. */
  dbWrites: string[];
  errors: ApiError[];
  /** True when restated from a ConstraintManifest (route already exists). */
  immutable: boolean;
}

/** Artifact 2 — the full API design. */
export interface APIArchitecture {
  routes: ApiRoute[];
  /** Cross-cutting conventions (versioning, pagination, error envelope, …). */
  conventions: string[];
  markdown: string;
}

// --- 3. FrontendArchitecture ----------------------------------------------

/** A reusable UI component. */
export interface ArchComponent {
  name: string;
  /** `component` | `layout` | `widget` | … (free-form). */
  type: string;
  description: string;
}

/** A frontend page/route. */
export interface ArchPage {
  path: string;
  name: string;
  purpose: string;
  /** Component names this page composes. */
  components: string[];
  /** API endpoints this page calls — cross-validated against the API design. */
  apiCalls: string[];
  authRequired: boolean;
  roles: string[];
  /** True when restated from a ConstraintManifest (page already exists). */
  immutable: boolean;
}

/** A layout shell. */
export interface ArchLayout {
  name: string;
  description: string;
  /** Page paths/segments this layout wraps. */
  appliesTo: string[];
}

/** Design-token buckets (mirrors brand_identities.design_tokens). */
export interface DesignTokenSet {
  colors: Record<string, string>;
  typography: Record<string, string>;
  spacing: Record<string, string>;
  radii: Record<string, string>;
  shadows: Record<string, string>;
}

/** Artifact 3 — the full frontend design. */
export interface FrontendArchitecture {
  pages: ArchPage[];
  components: ArchComponent[];
  layouts: ArchLayout[];
  designTokens: DesignTokenSet;
  responsiveStrategy: string;
  markdown: string;
}

// --- 4. InteractionMaps ----------------------------------------------------

/** One interaction-level map for a single interactive element (Contract 18). */
export interface InteractionMap {
  feature: string;
  /** The interactive element (button, form field, toggle, link, …). */
  element: string;
  userAction: string;
  frontendReaction: string;
  /** The API endpoint invoked — cross-validated against the API design. */
  apiCall: string;
  backendProcessing: string;
  /** Table written — cross-validated against the schema. */
  dbWrite: string;
  sideEffects: string[];
  successResponse: string;
  errorResponse: string;
  trackingEvent: string;
}

/** Artifact 4 — the per-feature interaction maps. */
export interface InteractionMapsArtifact {
  maps: InteractionMap[];
  markdown: string;
}

// --- 5. AuthArchitecture ---------------------------------------------------

/** An authentication/authorization flow. */
export interface AuthFlow {
  name: string;
  steps: string[];
}

/** A role and its permissions. */
export interface AuthRole {
  name: string;
  description: string;
  permissions: string[];
}

/** Artifact 5 — the full auth design. */
export interface AuthArchitecture {
  flows: AuthFlow[];
  roles: AuthRole[];
  /**
   * Middleware behavior. FORGE rule (Iron Law 4): on ANY role-fetch failure the
   * middleware redirects to /login ONLY — it never renders a default/wrong-role page.
   */
  middleware: string;
  multiTenancy: string;
  permissionsModel: string;
  markdown: string;
}

// --- 6. AgentArchitecture --------------------------------------------------

/** A designed autonomous agent. */
export interface AgentSpec {
  name: string;
  purpose: string;
  trigger: string;
  inputContract: string;
  outputContract: string;
  systemPrompt: string;
  model: string;
  /** Token budget per invocation, or `null` if unbounded/unknown. */
  tokenBudget: number | null;
}

/** Artifact 6 — the agent design. */
export interface AgentArchitecture {
  agents: AgentSpec[];
  orchestration: string;
  markdown: string;
}

// --- 7. InfraArchitecture --------------------------------------------------

/** A deployment environment. */
export interface EnvironmentSpec {
  name: string;
  description: string;
  /** Environment-variable names required (NAMES only — never values). */
  variables: string[];
}

/** A measurable performance budget. */
export interface PerformanceBudget {
  metric: string;
  target: string;
}

/** Artifact 7 — the infrastructure design. */
export interface InfraArchitecture {
  environments: EnvironmentSpec[];
  deployConfig: string;
  monitoring: string;
  performanceBudgets: PerformanceBudget[];
  markdown: string;
}

// --- 8. TestingStrategy ----------------------------------------------------

/** A planned Playwright spec. */
export interface PlaywrightSpec {
  name: string;
  file: string;
  scenario: string;
}

/** A planned API test suite for one route. */
export interface ApiTestSpec {
  route: string;
  cases: string[];
}

/** A Six Laws verification step (Laws 1–5 automated; Law 6 human). */
export interface SixLawsCheck {
  law: string;
  verification: string;
}

/** Artifact 8 — the testing strategy. */
export interface TestingStrategy {
  playwrightSpecs: PlaywrightSpec[];
  apiTests: ApiTestSpec[];
  sixLawsPlan: SixLawsCheck[];
  markdown: string;
}

// ---------------------------------------------------------------------------
// Cross-validation
// ---------------------------------------------------------------------------

export type ValidationSeverity = 'warning' | 'critical';

/** Which artifact pair an inconsistency was found between. */
export type ValidationKind =
  | 'schema_api'
  | 'api_frontend'
  | 'frontend_interaction'
  | 'interaction_schema'
  | 'completeness';

/** A single cross-artifact inconsistency surfaced for the operator at Gate 2. */
export interface ValidationIssue {
  id: string;
  severity: ValidationSeverity;
  kind: ValidationKind;
  subject: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

/** Gate 2 marker — Phase 1B always halts here for human approval (Contract 2). */
export interface Gate2Status {
  name: 'Gate 2 — Architecture Approval';
  /** Always `awaiting_human_approval`: there is no bypass (Contract 2). */
  status: 'awaiting_human_approval';
  detail: string;
}

/** The complete result of {@link runPhase1bArchitect}. */
export interface ArchitectureDesign {
  projectName: string;
  database: DatabaseArchitecture;
  api: APIArchitecture;
  frontend: FrontendArchitecture;
  interactionMaps: InteractionMapsArtifact;
  auth: AuthArchitecture;
  agents: AgentArchitecture;
  infra: InfraArchitecture;
  testing: TestingStrategy;
  /** Cross-artifact inconsistencies found (empty = fully consistent). */
  crossValidation: ValidationIssue[];
  /** True when a ConstraintManifest (partial build) shaped the design. */
  constrained: boolean;
  /** True when a project design system was generated and injected into the UI prompts. */
  designSystemGenerated: boolean;
  /** Absolute path DESIGN_SYSTEM.md was written to, or `null` if skipped/failed. */
  designSystemPath: string | null;
  /** Absolute path ARCHITECTURE.md was written to, or `null` if skipped/failed. */
  architecturePath: string | null;
  /** Model id actually used. */
  model: string;
  /** Total input/output token usage summed across the eight artifact calls. */
  tokensInput: number;
  tokensOutput: number;
  /** True when ANY artifact degraded to a deterministic fallback skeleton. */
  usedFallback: boolean;
  /** Which artifacts used a fallback skeleton. */
  fallbackArtifacts: ArtifactKind[];
  /** Non-fatal observations (memory unreachable, a call failed, write failure, …). */
  warnings: string[];
  /** Gate 2 — the build halts here until a human approves the architecture. */
  gate: Gate2Status;
  /**
   * Adversarial review of the generated governance suite (phase ARCHITECT_GOVERNANCE).
   * Null when the API key is absent or the review was skipped.
   */
  adversaryReview: AdversaryResult | null;
  /** Absolute paths of the eight governance documents written (name → path | null if write failed). */
  governanceDocs: Partial<Record<GovernanceDocName, string | null>>;
  generatedAt: string;
}

/** Options for {@link runPhase1bArchitect}. */
export interface Phase1bOptions {
  /**
   * The Phase 1C constraint manifest for a PARTIAL build. When present (and it
   * describes prior work), immutable items are treated as fixed and only extensions
   * are designed.
   */
  constraintManifest?: ConstraintManifest;
  /** The target project's stack fingerprint (from Phase 0) — used for Build Memory grounding. */
  stackFingerprint?: StackFingerprint;
  /** Project name for context/labels. Default: the basename of `projectPath`. */
  projectName?: string;
  /** Model id. Default: `FORGE_ARCHITECT_MODEL` env, else {@link DEFAULT_MODEL}. */
  model?: string;
  /** Anthropic API key. Default: `ANTHROPIC_API_KEY` env. */
  apiKey?: string;
  /** max_tokens per artifact generation. Default {@link DEFAULT_MAX_TOKENS}. */
  maxTokens?: number;
  /** Injected model caller (for tests / SDK swap). Default {@link defaultCallModel}. */
  callModel?: CallModel;
  /** Write ARCHITECTURE.md to the target project. Default true. */
  writeArchitectureFile?: boolean;
  /** Architecture file name. Default 'ARCHITECTURE.md'. */
  architectureFileName?: string;
  /**
   * Generate a project design system (UI/UX Pro Max) and inject it into every UI prompt
   * (FrontendArchitecture + InteractionMaps). Default true; non-fatal if the skill/Python
   * is unavailable.
   */
  generateDesignSystem?: boolean;
  /** Extra options forwarded to the design-system generator (e.g. `productType`, `outputDir`). */
  designSystemOptions?: DesignSystemOptions;
  /** Injected design-system generator (tests). Default {@link generateDesignSystem}. */
  generateDesignSystemImpl?: typeof generateDesignSystem;
  /**
   * Cross-project design token inheritance (Session 2 — Design Intelligence). When set to
   * another project's name, its `brand_identities` row (if any) is resolved BEFORE design-system
   * generation: its product-type is folded into the generated design system's query (so the new
   * system continues the same visual lineage), and a compact "Brand baseline (inherit, then
   * diverge deliberately)" block is injected alongside the design system into the frontend +
   * interactionMaps artifact prompts. Non-fatal when no baseline brand is found.
   */
  inheritBrandFrom?: string;
  /** Progress reporter. Default logs to the console with a [FORGE:phase1b] prefix. */
  log?: (message: string) => void;
  /** Write the eight governance documents to `governanceDir` after ARCHITECTURE.md. Default true. */
  writeGovernanceDocs?: boolean;
  /** Directory for governance documents. Default: `join(projectPath, 'governance')`. */
  governanceDir?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default model id for the Architecture Engine. The queue does not pin a model for
 * s3-p05; FORGE uses the same canonical generation model as Phase 1A
 * (`claude-sonnet-4-6`). Overridable via `options.model` / `FORGE_ARCHITECT_MODEL`.
 */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Per-artifact generation budget — each artifact is a long structured document. */
export const DEFAULT_MAX_TOKENS = 16384;

/**
 * Generation order (for reference): the eight artifacts are produced in dependency
 * order — database → api → frontend → interactionMaps → auth → agents → infra → testing —
 * each chunked into its own call seeded with a summary of the prior ones.
 */

/** Column-name signals that mark a table as tenant/company scoped (Six Laws Law 1). */
const TENANT_SCOPE_COLUMNS: ReadonlySet<string> = new Set([
  'company_id',
  'tenant_id',
  'organization_id',
  'org_id',
  'account_id',
  'workspace_id',
]);

// ---------------------------------------------------------------------------
// Defensive JSON coercion (model output is untrusted — never throw on a bad shape)
// ---------------------------------------------------------------------------

/** Coerce to a string, defaulting when the value is not a string. */
function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Coerce to a string or `null` (for nullable fields like `default`). */
function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Coerce to a boolean (accepts the common "true"/"yes"/"1" string forms). */
function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return /^(true|yes|y|1)$/i.test(value.trim());
  return fallback;
}

/** Coerce to a finite number, or `null`. */
function asNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Coerce to a finite integer, or a fallback. */
function asInt(value: unknown, fallback: number): number {
  const n = asNumberOrNull(value);
  return n === null ? fallback : Math.round(n);
}

/** Coerce to an array of non-empty strings. */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const x of value) if (typeof x === 'string' && x.trim() !== '') out.push(x);
  return out;
}

/** Coerce to a raw array (never throws). */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Coerce to a plain object (never throws). */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Coerce to a `Record<string, string>` (string-valued entries only). */
function asStringRecord(value: unknown): Record<string, string> {
  const obj = asRecord(value);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Per-artifact parsers (raw JSON → typed structured object)
// ---------------------------------------------------------------------------

function parseDatabase(raw: Record<string, unknown>): DatabaseArchitecture {
  const tables: ArchTable[] = asArray(raw['tables']).map((t) => {
    const o = asRecord(t);
    const columns: ArchColumn[] = asArray(o['columns']).map((c) => {
      const co = asRecord(c);
      return {
        name: asString(co['name']),
        type: asString(co['type']),
        nullable: asBool(co['nullable'], true),
        default: asStringOrNull(co['default']),
        constraints: asStringArray(co['constraints']),
      } satisfies ArchColumn;
    });
    const foreignKeys: ArchForeignKey[] = asArray(o['foreignKeys']).map((f) => {
      const fo = asRecord(f);
      return {
        columns: asStringArray(fo['columns']),
        referencesTable: asString(fo['referencesTable']),
        referencesColumns: asStringArray(fo['referencesColumns']),
        onDelete: asStringOrNull(fo['onDelete']),
      } satisfies ArchForeignKey;
    });
    const explicitTenant = asBool(o['tenantScoped']);
    const inferredTenant = columns.some((c) => TENANT_SCOPE_COLUMNS.has(c.name.toLowerCase()));
    return {
      name: asString(o['name']),
      schema: asString(o['schema'], 'public'),
      purpose: asString(o['purpose']),
      columns,
      primaryKey: asStringArray(o['primaryKey']),
      foreignKeys,
      rlsEnabled: asBool(o['rlsEnabled']),
      tenantScoped: explicitTenant || inferredTenant,
      immutable: asBool(o['immutable']),
    } satisfies ArchTable;
  });

  const indexes: ArchIndex[] = asArray(raw['indexes']).map((i) => {
    const o = asRecord(i);
    return {
      name: asString(o['name']),
      table: asString(o['table']),
      columns: asStringArray(o['columns']),
      unique: asBool(o['unique']),
      method: asStringOrNull(o['method']),
      where: asStringOrNull(o['where']),
    } satisfies ArchIndex;
  });

  const rlsPolicies: ArchRlsPolicy[] = asArray(raw['rlsPolicies']).map((p) => {
    const o = asRecord(p);
    return {
      name: asString(o['name']),
      table: asString(o['table']),
      command: asString(o['command'], 'all'),
      roles: asStringArray(o['roles']),
      using: asStringOrNull(o['using']),
      check: asStringOrNull(o['check']),
    } satisfies ArchRlsPolicy;
  });

  const seeds: ArchSeed[] = asArray(raw['seeds']).map((s) => {
    const o = asRecord(s);
    return {
      table: asString(o['table']),
      description: asString(o['description']),
      rowCount: asNumberOrNull(o['rowCount']),
    } satisfies ArchSeed;
  });

  const migrations: ArchMigration[] = asArray(raw['migrations']).map((m) => {
    const o = asRecord(m);
    return {
      filename: asString(o['filename']),
      description: asString(o['description']),
    } satisfies ArchMigration;
  });

  return { tables, indexes, rlsPolicies, seeds, migrations, markdown: asString(raw['markdown']) };
}

function parseApi(raw: Record<string, unknown>): APIArchitecture {
  const routes: ApiRoute[] = asArray(raw['routes']).map((r) => {
    const o = asRecord(r);
    const errors: ApiError[] = asArray(o['errors']).map((e) => {
      const eo = asRecord(e);
      return {
        status: asInt(eo['status'], 500),
        code: asString(eo['code']),
        description: asString(eo['description']),
      } satisfies ApiError;
    });
    return {
      path: asString(o['path']),
      method: asString(o['method'], 'GET').toUpperCase(),
      purpose: asString(o['purpose']),
      authRequired: asBool(o['authRequired'], true),
      roles: asStringArray(o['roles']),
      requestSchema: asString(o['requestSchema']),
      responseSchema: asString(o['responseSchema']),
      dbReads: asStringArray(o['dbReads']),
      dbWrites: asStringArray(o['dbWrites']),
      errors,
      immutable: asBool(o['immutable']),
    } satisfies ApiRoute;
  });
  return { routes, conventions: asStringArray(raw['conventions']), markdown: asString(raw['markdown']) };
}

function parseFrontend(raw: Record<string, unknown>): FrontendArchitecture {
  const pages: ArchPage[] = asArray(raw['pages']).map((p) => {
    const o = asRecord(p);
    return {
      path: asString(o['path']),
      name: asString(o['name']),
      purpose: asString(o['purpose']),
      components: asStringArray(o['components']),
      apiCalls: asStringArray(o['apiCalls']),
      authRequired: asBool(o['authRequired']),
      roles: asStringArray(o['roles']),
      immutable: asBool(o['immutable']),
    } satisfies ArchPage;
  });
  const components: ArchComponent[] = asArray(raw['components']).map((c) => {
    const o = asRecord(c);
    return {
      name: asString(o['name']),
      type: asString(o['type'], 'component'),
      description: asString(o['description']),
    } satisfies ArchComponent;
  });
  const layouts: ArchLayout[] = asArray(raw['layouts']).map((l) => {
    const o = asRecord(l);
    return {
      name: asString(o['name']),
      description: asString(o['description']),
      appliesTo: asStringArray(o['appliesTo']),
    } satisfies ArchLayout;
  });
  const dt = asRecord(raw['designTokens']);
  const designTokens: DesignTokenSet = {
    colors: asStringRecord(dt['colors']),
    typography: asStringRecord(dt['typography']),
    spacing: asStringRecord(dt['spacing']),
    radii: asStringRecord(dt['radii']),
    shadows: asStringRecord(dt['shadows']),
  };
  return {
    pages,
    components,
    layouts,
    designTokens,
    responsiveStrategy: asString(raw['responsiveStrategy']),
    markdown: asString(raw['markdown']),
  };
}

function parseInteractionMaps(raw: Record<string, unknown>): InteractionMapsArtifact {
  const maps: InteractionMap[] = asArray(raw['maps']).map((m) => {
    const o = asRecord(m);
    return {
      feature: asString(o['feature']),
      element: asString(o['element']),
      userAction: asString(o['userAction']),
      frontendReaction: asString(o['frontendReaction']),
      apiCall: asString(o['apiCall']),
      backendProcessing: asString(o['backendProcessing']),
      dbWrite: asString(o['dbWrite']),
      sideEffects: asStringArray(o['sideEffects']),
      successResponse: asString(o['successResponse']),
      errorResponse: asString(o['errorResponse']),
      trackingEvent: asString(o['trackingEvent']),
    } satisfies InteractionMap;
  });
  return { maps, markdown: asString(raw['markdown']) };
}

function parseAuth(raw: Record<string, unknown>): AuthArchitecture {
  const flows: AuthFlow[] = asArray(raw['flows']).map((f) => {
    const o = asRecord(f);
    return { name: asString(o['name']), steps: asStringArray(o['steps']) } satisfies AuthFlow;
  });
  const roles: AuthRole[] = asArray(raw['roles']).map((r) => {
    const o = asRecord(r);
    return {
      name: asString(o['name']),
      description: asString(o['description']),
      permissions: asStringArray(o['permissions']),
    } satisfies AuthRole;
  });
  return {
    flows,
    roles,
    middleware: asString(raw['middleware']),
    multiTenancy: asString(raw['multiTenancy']),
    permissionsModel: asString(raw['permissionsModel']),
    markdown: asString(raw['markdown']),
  };
}

function parseAgents(raw: Record<string, unknown>): AgentArchitecture {
  const agents: AgentSpec[] = asArray(raw['agents']).map((a) => {
    const o = asRecord(a);
    return {
      name: asString(o['name']),
      purpose: asString(o['purpose']),
      trigger: asString(o['trigger']),
      inputContract: asString(o['inputContract']),
      outputContract: asString(o['outputContract']),
      systemPrompt: asString(o['systemPrompt']),
      model: asString(o['model'], DEFAULT_MODEL),
      tokenBudget: asNumberOrNull(o['tokenBudget']),
    } satisfies AgentSpec;
  });
  return { agents, orchestration: asString(raw['orchestration']), markdown: asString(raw['markdown']) };
}

function parseInfra(raw: Record<string, unknown>): InfraArchitecture {
  const environments: EnvironmentSpec[] = asArray(raw['environments']).map((e) => {
    const o = asRecord(e);
    return {
      name: asString(o['name']),
      description: asString(o['description']),
      variables: asStringArray(o['variables']),
    } satisfies EnvironmentSpec;
  });
  const performanceBudgets: PerformanceBudget[] = asArray(raw['performanceBudgets']).map((b) => {
    const o = asRecord(b);
    return { metric: asString(o['metric']), target: asString(o['target']) } satisfies PerformanceBudget;
  });
  return {
    environments,
    deployConfig: asString(raw['deployConfig']),
    monitoring: asString(raw['monitoring']),
    performanceBudgets,
    markdown: asString(raw['markdown']),
  };
}

function parseTesting(raw: Record<string, unknown>): TestingStrategy {
  const playwrightSpecs: PlaywrightSpec[] = asArray(raw['playwrightSpecs']).map((s) => {
    const o = asRecord(s);
    return {
      name: asString(o['name']),
      file: asString(o['file']),
      scenario: asString(o['scenario']),
    } satisfies PlaywrightSpec;
  });
  const apiTests: ApiTestSpec[] = asArray(raw['apiTests']).map((t) => {
    const o = asRecord(t);
    return { route: asString(o['route']), cases: asStringArray(o['cases']) } satisfies ApiTestSpec;
  });
  const sixLawsPlan: SixLawsCheck[] = asArray(raw['sixLawsPlan']).map((c) => {
    const o = asRecord(c);
    return { law: asString(o['law']), verification: asString(o['verification']) } satisfies SixLawsCheck;
  });
  return { playwrightSpecs, apiTests, sixLawsPlan, markdown: asString(raw['markdown']) };
}

// ---------------------------------------------------------------------------
// Per-artifact fallback skeletons (deterministic — used when a call fails)
// ---------------------------------------------------------------------------

/** A clearly-marked Markdown note explaining why an artifact is a fallback skeleton. */
function fallbackMarkdown(title: string, reason: string): string {
  return [
    `# ${title} (FALLBACK SKELETON)`,
    '',
    `> ⚠️ FORGE Phase 1B could not generate this artifact (${reason}). This is an empty`,
    '> skeleton — a human must complete it, or re-run Phase 1B once the Anthropic API is',
    '> reachable. The build is HALTED at Gate 2 regardless.',
    '',
  ].join('\n');
}

function fallbackDatabase(reason: string): DatabaseArchitecture {
  return { tables: [], indexes: [], rlsPolicies: [], seeds: [], migrations: [], markdown: fallbackMarkdown('Database Architecture', reason) };
}
function fallbackApi(reason: string): APIArchitecture {
  return { routes: [], conventions: [], markdown: fallbackMarkdown('API Architecture', reason) };
}
function fallbackFrontend(reason: string): FrontendArchitecture {
  return {
    pages: [],
    components: [],
    layouts: [],
    designTokens: { colors: {}, typography: {}, spacing: {}, radii: {}, shadows: {} },
    responsiveStrategy: '',
    markdown: fallbackMarkdown('Frontend Architecture', reason),
  };
}
function fallbackInteractionMaps(reason: string): InteractionMapsArtifact {
  return { maps: [], markdown: fallbackMarkdown('Interaction Maps', reason) };
}
function fallbackAuth(reason: string): AuthArchitecture {
  return { flows: [], roles: [], middleware: '', multiTenancy: '', permissionsModel: '', markdown: fallbackMarkdown('Auth Architecture', reason) };
}
function fallbackAgents(reason: string): AgentArchitecture {
  return { agents: [], orchestration: '', markdown: fallbackMarkdown('Agent Architecture', reason) };
}
function fallbackInfra(reason: string): InfraArchitecture {
  return { environments: [], deployConfig: '', monitoring: '', performanceBudgets: [], markdown: fallbackMarkdown('Infrastructure Architecture', reason) };
}
function fallbackTesting(reason: string): TestingStrategy {
  return { playwrightSpecs: [], apiTests: [], sixLawsPlan: [], markdown: fallbackMarkdown('Testing Strategy', reason) };
}

// ---------------------------------------------------------------------------
// Build Memory grounding (proven patterns + applicable insights)
// ---------------------------------------------------------------------------

/** Grounding context assembled from Build Memory and injected into the prompts. */
interface Grounding {
  insights: CrossProjectInsight[];
  patterns: DesignPattern[];
}

/** Gather proven design patterns + applicable insights (guarded; degrades to empty). */
async function gatherGrounding(fingerprint: StackFingerprint | undefined): Promise<Grounding> {
  try {
    const patternsPromise = BuildMemory.patterns.findPatterns();
    let insights: CrossProjectInsight[] | null = [];
    if (fingerprint) {
      const fp: JsonObject = {
        framework: fingerprint.framework,
        language: fingerprint.language,
        database: fingerprint.database,
        deployment: fingerprint.deployment,
        packageManager: fingerprint.packageManager,
        services: fingerprint.services,
        cliTools: fingerprint.cliTools,
      };
      insights = await BuildMemory.insights.findApplicableInsights(fp);
    }
    const patterns = await patternsPromise;
    return { insights: (insights ?? []).slice(0, 10), patterns: (patterns ?? []).slice(0, 10) };
  } catch {
    return { insights: [], patterns: [] };
  }
}

/** Render the grounding context as a compact Markdown block for the prompts. */
function renderGrounding(g: Grounding): string {
  const lines: string[] = ['## Build Memory Context (proven precedents — prefer these)'];
  lines.push('');
  lines.push('### Applicable cross-project insights');
  if (g.insights.length === 0) lines.push('- _(none on record)_');
  else for (const i of g.insights) lines.push(`- [${i.insight_type}] ${i.description}`);
  lines.push('');
  lines.push('### Proven design patterns');
  if (g.patterns.length === 0) lines.push('- _(none on record)_');
  else for (const p of g.patterns) lines.push(`- [${p.pattern_type}] ${p.name} — ${p.description}`);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Cross-project brand inheritance (Session 2 — Design Intelligence)
// ---------------------------------------------------------------------------

/**
 * Resolve the baseline brand for `Phase1bOptions.inheritBrandFrom`, if set. Guarded — a
 * missing brand or a Build Memory failure degrades to `null` plus a warning, never a throw.
 */
async function resolveBrandBaseline(
  inheritBrandFrom: string | undefined,
  warnings: string[],
  log: (message: string) => void
): Promise<BrandIdentity | null> {
  if (!inheritBrandFrom || inheritBrandFrom.trim() === '') return null;
  try {
    const baseline = await BuildMemory.brands.getBrandByProject(inheritBrandFrom);
    if (!baseline) {
      warnings.push(`inheritBrandFrom: no brand found for project "${inheritBrandFrom}" — designing without a baseline.`);
      return null;
    }
    log(`inheriting brand baseline from "${inheritBrandFrom}"`);
    return baseline;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warnings.push(`inheritBrandFrom: could not resolve baseline brand for "${inheritBrandFrom}" (${detail}).`);
    return null;
  }
}

/** The baseline's stored UI/UX Pro Max product-type query, or `''` if not recorded. */
function baselineProductType(baseline: BrandIdentity): string {
  return asString(asRecord(baseline.design_tokens)['productType']);
}

/**
 * Render a compact "brand baseline" block from a prior project's persisted brand, injected
 * alongside the design system into the frontend + interactionMaps artifact prompts. Summarizes
 * whichever structured tokens the baseline carries (colors/typography/spacing/radii/shadows);
 * degrades to a product-type-only note when no structured tokens were ever merged in. Never
 * throws — every field access goes through the file's existing `asRecord`/`asString` coercions.
 */
function renderBrandBaselineBlock(baseline: BrandIdentity, baselineProjectName: string): string {
  const stored = asRecord(baseline.design_tokens);
  const structured = asRecord(stored['tokens']);
  const buckets: Array<[string, Record<string, unknown>]> = [
    ['colors', asRecord(structured['colors'])],
    ['typography', asRecord(structured['typography'])],
    ['spacing', asRecord(structured['spacing'])],
    ['radii', asRecord(structured['radii'])],
    ['shadows', asRecord(structured['shadows'])],
  ];

  const lines: string[] = [
    '## Brand baseline (inherit, then diverge deliberately)',
    '',
    `This project inherits its visual lineage from "${baselineProjectName}". Start from the tokens`,
    "below, then adapt deliberately for THIS product's subject matter and audience — do not copy",
    'verbatim where the baseline product differs materially from this one.',
    '',
  ];

  let anyBucket = false;
  for (const [name, values] of buckets) {
    const entries = Object.entries(values).slice(0, 12);
    if (entries.length === 0) continue;
    anyBucket = true;
    lines.push(`- **${name}:** ${entries.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`);
  }
  if (!anyBucket) lines.push('- _(no structured tokens recorded yet for the baseline — see its product-type query below)_');

  const productType = baselineProductType(baseline);
  if (productType !== '') lines.push('', `Baseline product-type query: ${productType}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Constraint-manifest rendering (immutable items injected as FIXED)
// ---------------------------------------------------------------------------

/** Render a ConstraintManifest's immutable items as a "FIXED — do not redesign" block. */
function renderConstraints(manifest: ConstraintManifest): string {
  const m = manifest.immutable;
  const lines: string[] = ['## Existing codebase — IMMUTABLE constraints (FIXED — design only extensions)'];
  lines.push('');
  lines.push('> These items already exist. NEVER redesign or rename them. Design only the NEW');
  lines.push('> tables/routes/pages/components needed to satisfy the PRD. When you must restate an');
  lines.push('> existing item for context, set "immutable": true on it.');
  lines.push('');

  lines.push(`### Existing tables (${m.schemaTables.length})`);
  if (m.schemaTables.length === 0) lines.push('- _(none)_');
  else for (const t of m.schemaTables) {
    lines.push(`- \`${t.name}\` — cols: ${t.columns.map((c) => c.name).join(', ') || '—'}; PK [${t.primaryKey.join(', ') || '—'}]; RLS ${t.rlsEnabled ? 'on' : 'off'}`);
  }
  lines.push('');

  lines.push(`### Existing routes (${m.routes.length})`);
  if (m.routes.length === 0) lines.push('- _(none)_');
  else for (const r of m.routes) lines.push(`- \`${r.route}\` (${r.router}/${r.kind})`);
  lines.push('');

  lines.push(`### Existing components (${m.components.length} exported)`);
  if (m.components.length === 0) lines.push('- _(none)_');
  else lines.push(`- ${m.components.slice(0, 40).map((c) => c.name).join(', ')}${m.components.length > 40 ? ', …' : ''}`);
  lines.push('');

  const dt = m.designTokens;
  const tokenCount =
    Object.keys(dt.colors).length +
    Object.keys(dt.fonts).length +
    Object.keys(dt.spacing).length +
    Object.keys(dt.radii).length +
    Object.keys(dt.shadows).length;
  lines.push(`### Existing design tokens (${tokenCount})`);
  lines.push(`- colors ${Object.keys(dt.colors).length} · fonts ${Object.keys(dt.fonts).length} · spacing ${Object.keys(dt.spacing).length} · radii ${Object.keys(dt.radii).length} · shadows ${Object.keys(dt.shadows).length} — reuse these tokens; do not introduce a conflicting palette.`);
  lines.push('');

  if (manifest.extensionPoints.length > 0) {
    lines.push('### Extension points (where new code may be added)');
    for (const p of manifest.extensionPoints) lines.push(`- \`${p.path}\` — ${p.description}`);
    lines.push('');
  }

  return lines.join('\n');
}

/** Seed the running "design state" with the manifest's immutable names (artifact #1 awareness). */
function seedStateFromManifest(manifest: ConstraintManifest): string {
  const m = manifest.immutable;
  const parts: string[] = [];
  if (m.schemaTables.length > 0) parts.push(`EXISTING TABLES (immutable): [${m.schemaTables.map((t) => t.name).join(', ')}]`);
  if (m.routes.length > 0) parts.push(`EXISTING ROUTES (immutable): [${m.routes.map((r) => r.route).join(', ')}]`);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// State summaries (the compact chunk-to-chunk context)
// ---------------------------------------------------------------------------

function summarizeDatabase(db: DatabaseArchitecture): string {
  const names = db.tables.map((t) => t.name).filter((n) => n !== '');
  const tenant = db.tables.filter((t) => t.tenantScoped).map((t) => t.name);
  return `DATABASE — tables: [${names.join(', ') || 'none'}]; tenant-scoped: [${tenant.join(', ') || 'none'}].`;
}
function summarizeApi(api: APIArchitecture): string {
  const routes = api.routes.map((r) => `${r.method} ${r.path}`.trim()).filter((s) => s !== '');
  return `API — routes: [${routes.join(' | ') || 'none'}].`;
}
function summarizeFrontend(fe: FrontendArchitecture): string {
  const pages = fe.pages.map((p) => p.path).filter((p) => p !== '');
  return `FRONTEND — pages: [${pages.join(', ') || 'none'}]; components: ${fe.components.length}.`;
}
function summarizeInteractionMaps(im: InteractionMapsArtifact): string {
  const features = [...new Set(im.maps.map((m) => m.feature).filter((f) => f !== ''))];
  return `INTERACTION MAPS — ${im.maps.length} map(s) across features: [${features.join(', ') || 'none'}].`;
}
function summarizeAuth(a: AuthArchitecture): string {
  return `AUTH — roles: [${a.roles.map((r) => r.name).join(', ') || 'none'}].`;
}
function summarizeAgents(ag: AgentArchitecture): string {
  return `AGENTS — [${ag.agents.map((a) => a.name).join(', ') || 'none'}].`;
}
function summarizeInfra(inf: InfraArchitecture): string {
  return `INFRA — environments: [${inf.environments.map((e) => e.name).join(', ') || 'none'}].`;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------


/** The shared system-prompt preamble + the per-artifact schema + rules. */
function buildSystemPrompt(projectName: string, constrained: boolean, artifactSchema: string): string {
  const lines: string[] = [
    'You are FORGE Phase 1B, the Architecture Engine inside an autonomous software factory.',
    `You transform an APPROVED PRD into precise, buildable design artifacts for the project "${projectName}".`,
    '',
    'You design ONE artifact at a time. Honor every decision already recorded in the running',
    '"Design state so far" — names you introduce here MUST be consistent with prior artifacts',
    '(reference the exact table names, route paths, and role names already chosen).',
  ];
  if (constrained) {
    lines.push('');
    lines.push('A ConstraintManifest describes an EXISTING codebase. Items marked IMMUTABLE are FIXED —');
    lines.push('never redesign, rename, or drop them. Design ONLY the extensions the PRD requires. When you');
    lines.push('restate an existing item for context, set its "immutable" field to true.');
  }
  lines.push('');
  lines.push('Rules:');
  lines.push('- Be specific and buildable. NO "TBD"/"TODO"/placeholder values (Contract 18). If a detail is');
  lines.push('  unspecified, apply the most common proven pattern and proceed.');
  lines.push('- Enforce company/tenant-scoped data isolation on every multi-tenant table (Six Laws Law 1):');
  lines.push('  such tables carry a company_id (or tenant_id) column, RLS enabled, and a company-scoped policy.');
  lines.push('- Prefer the FORGE default stack: Next.js 14 (App Router) + Supabase (Postgres + Auth + RLS) +');
  lines.push('  Vercel, pnpm, TypeScript strict.');
  lines.push('');
  lines.push('OUTPUT FORMAT — respond with a SINGLE JSON object and nothing else (no prose, no code fences).');
  lines.push('The schema is:');
  lines.push(artifactSchema);
  lines.push('The "markdown" field MUST be a complete, well-structured Markdown section documenting this');
  lines.push('artifact in full (it becomes part of ARCHITECTURE.md). All other fields must agree with it.');
  lines.push('');
  lines.push(JSON_ONLY_DIRECTIVE);
  return lines.join('\n');
}

/**
 * Assemble the user message for one artifact: base context + design state +
 * (optional) extra context (e.g. the design system, injected into UI artifacts) +
 * instruction.
 */
function buildUserPrompt(
  baseContext: string,
  stateSummary: string,
  instruction: string,
  extraContext = ''
): string {
  const parts: string[] = [
    baseContext,
    '## Design state so far (decisions already made — stay consistent)',
    stateSummary.trim() === '' ? '_(this is the first artifact — no prior design state)_' : stateSummary.trim(),
    '',
  ];
  if (extraContext.trim() !== '') {
    parts.push(extraContext.trim(), '');
  }
  parts.push(instruction);
  parts.push('');
  parts.push(JSON_ONLY_DIRECTIVE);
  return parts.join('\n');
}

/** Per-artifact JSON-schema descriptions and the user-message instruction line. */
const ARTIFACT_SCHEMAS: Record<ArtifactKind, { schema: string; instruction: string }> = {
  database: {
    schema: [
      '{',
      '  "tables": [{ "name": string, "schema": string, "purpose": string,',
      '    "columns": [{ "name": string, "type": string, "nullable": boolean, "default": string|null, "constraints": string[] }],',
      '    "primaryKey": string[], "foreignKeys": [{ "columns": string[], "referencesTable": string, "referencesColumns": string[], "onDelete": string|null }],',
      '    "rlsEnabled": boolean, "tenantScoped": boolean, "immutable": boolean }],',
      '  "indexes": [{ "name": string, "table": string, "columns": string[], "unique": boolean, "method": string|null, "where": string|null }],',
      '  "rlsPolicies": [{ "name": string, "table": string, "command": string, "roles": string[], "using": string|null, "check": string|null }],',
      '  "seeds": [{ "table": string, "description": string, "rowCount": number|null }],',
      '  "migrations": [{ "filename": string, "description": string }],',
      '  "markdown": string',
      '}',
    ].join('\n'),
    instruction: 'Now produce the DatabaseArchitecture JSON object. Derive every table the PRD features require.',
  },
  api: {
    schema: [
      '{',
      '  "routes": [{ "path": string, "method": string, "purpose": string, "authRequired": boolean, "roles": string[],',
      '    "requestSchema": string, "responseSchema": string, "dbReads": string[], "dbWrites": string[],',
      '    "errors": [{ "status": number, "code": string, "description": string }], "immutable": boolean }],',
      '  "conventions": string[],',
      '  "markdown": string',
      '}',
    ].join('\n'),
    instruction:
      'Now produce the APIArchitecture JSON object. Every route MUST derive company_id from the session — NEVER from the request body (Six Laws Law 2). "dbReads"/"dbWrites" MUST reference the exact table names from the DATABASE state above.',
  },
  frontend: {
    schema: [
      '{',
      '  "pages": [{ "path": string, "name": string, "purpose": string, "components": string[], "apiCalls": string[], "authRequired": boolean, "roles": string[], "immutable": boolean }],',
      '  "components": [{ "name": string, "type": string, "description": string }],',
      '  "layouts": [{ "name": string, "description": string, "appliesTo": string[] }],',
      '  "designTokens": { "colors": object, "typography": object, "spacing": object, "radii": object, "shadows": object },',
      '  "responsiveStrategy": string,',
      '  "markdown": string',
      '}',
    ].join('\n'),
    instruction:
      'Now produce the FrontendArchitecture JSON object. Each page\'s "apiCalls" MUST reference the exact API routes from the API state above. Handle empty states for every data-driven page.',
  },
  interactionMaps: {
    schema: [
      '{',
      '  "maps": [{ "feature": string, "element": string, "userAction": string, "frontendReaction": string,',
      '    "apiCall": string, "backendProcessing": string, "dbWrite": string, "sideEffects": string[],',
      '    "successResponse": string, "errorResponse": string, "trackingEvent": string }],',
      '  "markdown": string',
      '}',
    ].join('\n'),
    instruction:
      'Now produce the InteractionMaps JSON object. Provide ONE map per interactive element of EVERY feature (Contract 18 — no element left unspecified). "apiCall" MUST be a route from the API state; "dbWrite" MUST be a table from the DATABASE state (use "none" for read-only interactions).',
  },
  auth: {
    schema: [
      '{',
      '  "flows": [{ "name": string, "steps": string[] }],',
      '  "roles": [{ "name": string, "description": string, "permissions": string[] }],',
      '  "middleware": string, "multiTenancy": string, "permissionsModel": string,',
      '  "markdown": string',
      '}',
    ].join('\n'),
    instruction:
      'Now produce the AuthArchitecture JSON object. The middleware MUST follow the FORGE rule: on ANY role-fetch failure, redirect to /login ONLY — never render a default or wrong-role page (Iron Law 4). Roles must match those referenced by the API routes above.',
  },
  agents: {
    schema: [
      '{',
      '  "agents": [{ "name": string, "purpose": string, "trigger": string, "inputContract": string, "outputContract": string, "systemPrompt": string, "model": string, "tokenBudget": number|null }],',
      '  "orchestration": string,',
      '  "markdown": string',
      '}',
    ].join('\n'),
    instruction:
      'Now produce the AgentArchitecture JSON object. Include only agents the PRD actually needs (an empty "agents" array is valid if none are required). Give each a concrete trigger, I/O contract, system prompt, model, and token budget.',
  },
  infra: {
    schema: [
      '{',
      '  "environments": [{ "name": string, "description": string, "variables": string[] }],',
      '  "deployConfig": string, "monitoring": string,',
      '  "performanceBudgets": [{ "metric": string, "target": string }],',
      '  "markdown": string',
      '}',
    ].join('\n'),
    instruction:
      'Now produce the InfraArchitecture JSON object. List environment-variable NAMES only (never values). Cover dev + production environments, deploy config, monitoring/telemetry, and measurable performance budgets.',
  },
  testing: {
    schema: [
      '{',
      '  "playwrightSpecs": [{ "name": string, "file": string, "scenario": string }],',
      '  "apiTests": [{ "route": string, "cases": string[] }],',
      '  "sixLawsPlan": [{ "law": string, "verification": string }],',
      '  "markdown": string',
      '}',
    ].join('\n'),
    instruction:
      'Now produce the TestingStrategy JSON object. Cover the key user flows with Playwright specs, the API routes above with API tests, and ALL six laws (Schema, API, UI, Data, Wiring, Verification) with a concrete verification plan (Laws 1-5 automated, Law 6 human).',
  },
};

// ---------------------------------------------------------------------------
// Generic guarded artifact generation
// ---------------------------------------------------------------------------

interface GenContext {
  model: string;
  maxTokens: number;
  apiKey: string;
  callModel: CallModel;
  log: (m: string) => void;
  warnings: string[];
  fallbackArtifacts: ArtifactKind[];
}

interface GenResult<T> {
  artifact: T;
  tokensInput: number;
  tokensOutput: number;
}

/**
 * When `FORGE_DEBUG` is set, persist the FULL raw model response for one artifact to
 * `<cwd>/logs/phase1b-<kind>-raw.txt` (option 1 from the truncation/JSON-drift analysis —
 * full raw-response capture for post-mortem, since `ctx.log` only records the first 200
 * chars). Guarded: a write failure never affects generation — it degrades to a warning.
 */
async function captureRawResponse(
  kind: ArtifactKind,
  label: string,
  text: string,
  ctx: GenContext
): Promise<void> {
  if (!process.env['FORGE_DEBUG']) return;
  try {
    const dir = join(process.cwd(), 'logs');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `phase1b-${kind}-raw.txt`);
    await writeFile(file, text, 'utf8');
    ctx.log(`FORGE_DEBUG: wrote ${label} raw response (${text.length} chars) to ${file}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.warnings.push(`${label}: FORGE_DEBUG raw-response capture failed (${reason}).`);
    ctx.log(`WARNING: ${label} — FORGE_DEBUG raw-response capture failed (${reason})`);
  }
}

/**
 * Generate one artifact via the model, guarded so a failure (or non-JSON output)
 * degrades to a fallback skeleton instead of throwing.
 */
async function generateArtifact<T>(
  kind: ArtifactKind,
  label: string,
  system: string,
  user: string,
  parse: (raw: Record<string, unknown>) => T,
  fallback: (reason: string) => T,
  ctx: GenContext
): Promise<GenResult<T>> {
  try {
    ctx.log(`generating ${label}`);
    const response = await ctx.callModel({
      model: ctx.model,
      maxTokens: ctx.maxTokens,
      system,
      user,
      apiKey: ctx.apiKey,
    });
    ctx.log(`${label} raw response (first 200 chars): ${JSON.stringify((response.text ?? '').slice(0, 200))}`);
    await captureRawResponse(kind, label, response.text ?? '', ctx);
    const raw = extractJson(response.text, (m) => {
      ctx.warnings.push(`${label}: ${m}`);
      ctx.log(`WARNING: ${label} — ${m}`);
    });
    if (raw === null) {
      ctx.warnings.push(`${label}: model output was not a JSON object; used a fallback skeleton.`);
      ctx.fallbackArtifacts.push(kind);
      ctx.log(`WARNING: ${label} output was not valid JSON; using fallback skeleton`);
      return { artifact: fallback('non-JSON model output'), tokensInput: response.tokensInput, tokensOutput: response.tokensOutput };
    }
    return { artifact: parse(raw), tokensInput: response.tokensInput, tokensOutput: response.tokensOutput };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.warnings.push(`${label}: model call failed — used a fallback skeleton (${reason}).`);
    ctx.fallbackArtifacts.push(kind);
    ctx.log(`WARNING: ${label} generation failed (${reason}); using fallback skeleton`);
    return { artifact: fallback(reason), tokensInput: 0, tokensOutput: 0 };
  }
}

// ---------------------------------------------------------------------------
// Cross-validation
// ---------------------------------------------------------------------------

/** Normalize a table name (strip schema prefix + quotes, lower-case). */
function normTable(name: string): string {
  return name.trim().toLowerCase().replace(/[`"']/g, '').replace(/^public\./, '');
}

/** Normalize an API route path: drop a leading method token, query string, and params. */
function normRoute(path: string): string {
  let s = path.trim();
  s = s.replace(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+/i, '');
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  s = s.toLowerCase();
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  s = s
    .replace(/\[\.\.\.[^\]]+\]/g, '*')
    .replace(/\[[^\]]+\]/g, ':param')
    .replace(/\{[^}]+\}/g, ':param')
    .replace(/:[a-z0-9_]+/gi, ':param');
  return s;
}

/** Is a referenced value effectively "no reference" (empty / none / n-a)? */
function isNoRef(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === '' || v === 'none' || v === 'n/a' || v === 'na' || v === '-' || v === 'null';
}

/**
 * Cross-validate the eight artifacts against one another. Immutable items from a
 * ConstraintManifest are treated as existing (valid references). Returns the list of
 * inconsistencies (empty when fully consistent).
 */
function crossValidate(
  database: DatabaseArchitecture,
  api: APIArchitecture,
  frontend: FrontendArchitecture,
  interaction: InteractionMapsArtifact,
  manifest: ConstraintManifest | undefined
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Known tables = designed + immutable (from manifest).
  const knownTables = new Set<string>();
  for (const t of database.tables) if (t.name !== '') knownTables.add(normTable(t.name));
  if (manifest) for (const t of manifest.immutable.schemaTables) knownTables.add(normTable(t.name));

  // Known routes = designed + immutable (from manifest).
  const knownRoutes = new Set<string>();
  for (const r of api.routes) if (r.path !== '') knownRoutes.add(normRoute(r.path));
  if (manifest) for (const r of manifest.immutable.routes) knownRoutes.add(normRoute(r.route));

  // --- schema ↔ API: every table an API route reads/writes must exist ---
  for (const r of api.routes) {
    for (const table of [...r.dbReads, ...r.dbWrites]) {
      if (isNoRef(table)) continue;
      if (!knownTables.has(normTable(table))) {
        issues.push({
          id: 'api_unknown_table',
          severity: 'critical',
          kind: 'schema_api',
          subject: `${r.method} ${r.path}`,
          detail: `API route references table '${table}', which is not defined in DatabaseArchitecture.`,
        });
      }
    }
  }

  // --- API ↔ frontend: every endpoint a page calls must exist ---
  for (const p of frontend.pages) {
    for (const call of p.apiCalls) {
      if (isNoRef(call)) continue;
      if (!knownRoutes.has(normRoute(call))) {
        issues.push({
          id: 'page_unknown_route',
          severity: 'warning',
          kind: 'api_frontend',
          subject: p.path || p.name,
          detail: `Page calls API '${call}', which is not defined in APIArchitecture.`,
        });
      }
    }
  }

  // --- frontend/interaction ↔ API + schema: each map's apiCall + dbWrite must resolve ---
  for (const m of interaction.maps) {
    if (!isNoRef(m.apiCall) && !knownRoutes.has(normRoute(m.apiCall))) {
      issues.push({
        id: 'interaction_unknown_route',
        severity: 'warning',
        kind: 'frontend_interaction',
        subject: `${m.feature} / ${m.element}`,
        detail: `Interaction map calls API '${m.apiCall}', which is not defined in APIArchitecture.`,
      });
    }
    if (!isNoRef(m.dbWrite) && !knownTables.has(normTable(m.dbWrite))) {
      issues.push({
        id: 'interaction_unknown_table',
        severity: 'critical',
        kind: 'interaction_schema',
        subject: `${m.feature} / ${m.element}`,
        detail: `Interaction map writes table '${m.dbWrite}', which is not defined in DatabaseArchitecture.`,
      });
    }
  }

  // --- completeness: empty headline artifacts usually mean a generation gap/fallback ---
  if (database.tables.length === 0) {
    issues.push({ id: 'empty_database', severity: 'critical', kind: 'completeness', subject: 'DatabaseArchitecture', detail: 'No tables were designed.' });
  }
  if (api.routes.length === 0) {
    issues.push({ id: 'empty_api', severity: 'critical', kind: 'completeness', subject: 'APIArchitecture', detail: 'No API routes were designed.' });
  }
  if (frontend.pages.length === 0) {
    issues.push({ id: 'empty_frontend', severity: 'warning', kind: 'completeness', subject: 'FrontendArchitecture', detail: 'No pages were designed.' });
  }
  if (interaction.maps.length === 0) {
    issues.push({ id: 'empty_interaction_maps', severity: 'warning', kind: 'completeness', subject: 'InteractionMaps', detail: 'No interaction maps were produced (Contract 18 expects one per interactive element).' });
  }

  return issues.sort((a, b) => (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Governance document renderers (one per GovernanceDocName)
// ---------------------------------------------------------------------------

export function renderBlueprintMd(design: ArchitectureDesign): string {
  const lines: string[] = [
    `# BLUEPRINT — ${design.projectName}`,
    '',
    `**Generated by FORGE Phase 1B — Architecture Engine**`,
    `**Date:** ${design.generatedAt}`,
    `**Mode:** ${design.constrained ? 'Partial build (extending existing codebase)' : 'Greenfield'}`,
    '',
    '## Tech Stack',
    '',
    '| Layer | Technology |',
    '|-------|-----------|',
    '| Framework | Next.js 14 (App Router) |',
    '| Database | Supabase (PostgreSQL + Auth + RLS) |',
    '| Hosting | Vercel |',
    '| Package Manager | pnpm |',
    '| Language | TypeScript (strict mode) |',
    '',
    '## Architecture Summary',
    '',
    `- **Tables:** ${design.database.tables.length} (${design.database.tables.filter((t) => t.tenantScoped).length} tenant-scoped)`,
    `- **API Routes:** ${design.api.routes.length}`,
    `- **Pages:** ${design.frontend.pages.length}`,
    `- **Components:** ${design.frontend.components.length}`,
    `- **Auth Roles:** ${design.auth.roles.map((r) => r.name).join(', ') || 'none'}`,
    `- **Agents:** ${design.agents.agents.length}`,
    `- **Environments:** ${design.infra.environments.map((e) => e.name).join(', ') || 'none'}`,
    '',
    '## Pages',
    '',
    ...design.frontend.pages.map((p) => `- \`${p.path}\` — ${p.name}: ${p.purpose}`),
    '',
    '## Layouts',
    '',
    ...design.frontend.layouts.map(
      (l) => `- **${l.name}:** ${l.description} (applies to: ${l.appliesTo.join(', ')})`
    ),
    '',
    '## Responsive Strategy',
    '',
    design.frontend.responsiveStrategy || '_Not specified._',
    '',
    '## Infrastructure',
    '',
    design.infra.deployConfig || '_Not specified._',
  ];
  return lines.join('\n');
}

export function renderSchemaRegistryMd(design: ArchitectureDesign): string {
  const lines: string[] = [
    `# SCHEMA REGISTRY — ${design.projectName}`,
    '',
    `**Generated by FORGE Phase 1B**`,
    `**Date:** ${design.generatedAt}`,
    '',
  ];
  for (const table of design.database.tables) {
    lines.push(`## Table: \`${table.schema}.${table.name}\``);
    lines.push('');
    lines.push(`**Purpose:** ${table.purpose}`);
    const flags = [
      `RLS: ${table.rlsEnabled ? 'ON' : 'OFF'}`,
      `Tenant-scoped: ${table.tenantScoped ? 'YES' : 'NO'}`,
      ...(table.immutable ? ['IMMUTABLE'] : []),
    ].join(' | ');
    lines.push(`_${flags}_`);
    lines.push('');
    lines.push('| Column | Type | Nullable | Default | Constraints |');
    lines.push('|--------|------|----------|---------|-------------|');
    for (const col of table.columns) {
      lines.push(
        `| \`${col.name}\` | \`${col.type}\` | ${col.nullable ? 'Yes' : 'No'} | ${col.default ?? '—'} | ${col.constraints.join(', ') || '—'} |`
      );
    }
    lines.push('');
    if (table.primaryKey.length > 0) {
      lines.push(`**Primary Key:** \`[${table.primaryKey.join(', ')}]\``);
      lines.push('');
    }
    for (const fk of table.foreignKeys) {
      lines.push(
        `**FK:** \`[${fk.columns.join(', ')}]\` → \`${fk.referencesTable}.[${fk.referencesColumns.join(', ')}]\`` +
          (fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '')
      );
    }
    if (table.foreignKeys.length > 0) lines.push('');
  }

  if (design.database.rlsPolicies.length > 0) {
    lines.push('## RLS Policies');
    lines.push('');
    for (const p of design.database.rlsPolicies) {
      lines.push(`### ${p.name} (${p.table} — ${p.command})`);
      lines.push(`- **Roles:** ${p.roles.join(', ') || 'all'}`);
      if (p.using) lines.push(`- **USING:** \`${p.using}\``);
      if (p.check) lines.push(`- **WITH CHECK:** \`${p.check}\``);
      lines.push('');
    }
  }

  if (design.database.indexes.length > 0) {
    lines.push('## Indexes');
    lines.push('');
    lines.push('| Name | Table | Columns | Unique | Method |');
    lines.push('|------|-------|---------|--------|--------|');
    for (const idx of design.database.indexes) {
      lines.push(
        `| \`${idx.name}\` | \`${idx.table}\` | \`[${idx.columns.join(', ')}]\` | ${idx.unique ? 'Yes' : 'No'} | ${idx.method ?? 'btree'} |`
      );
    }
    lines.push('');
  }

  if (design.database.migrations.length > 0) {
    lines.push('## Planned Migrations');
    lines.push('');
    for (const m of design.database.migrations) lines.push(`- \`${m.filename}\` — ${m.description}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function renderAgentsMd(design: ArchitectureDesign): string {
  const lines: string[] = [
    `# AGENTS — ${design.projectName}`,
    '',
    `**Generated by FORGE Phase 1B**`,
    `**Date:** ${design.generatedAt}`,
    '',
  ];
  if (design.agents.agents.length === 0) {
    lines.push('_No autonomous agents are required for this project._');
    lines.push('');
  } else {
    for (const agent of design.agents.agents) {
      lines.push(`## Agent: ${agent.name}`);
      lines.push('');
      lines.push(`**Purpose:** ${agent.purpose}`);
      lines.push(`**Trigger:** ${agent.trigger}`);
      lines.push(
        `**Model:** ${agent.model}` +
          (agent.tokenBudget !== null ? ` | **Token Budget:** ${agent.tokenBudget}` : '')
      );
      lines.push('');
      lines.push('**Input Contract:**');
      lines.push(agent.inputContract);
      lines.push('');
      lines.push('**Output Contract:**');
      lines.push(agent.outputContract);
      lines.push('');
      lines.push('**System Prompt:**');
      lines.push('```');
      lines.push(agent.systemPrompt);
      lines.push('```');
      lines.push('');
    }
    if (design.agents.orchestration) {
      lines.push('## Orchestration');
      lines.push('');
      lines.push(design.agents.orchestration);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function renderBehavioralContractsMd(design: ArchitectureDesign): string {
  const lines: string[] = [
    `# BEHAVIORAL CONTRACTS — ${design.projectName}`,
    '',
    `**Generated by FORGE Phase 1B**`,
    `**Date:** ${design.generatedAt}`,
    '',
    '## Auth Contracts',
    '',
  ];
  for (const flow of design.auth.flows) {
    lines.push(`### Flow: ${flow.name}`);
    lines.push('');
    for (const step of flow.steps) lines.push(step);
    lines.push('');
  }
  lines.push('### Roles');
  lines.push('');
  for (const role of design.auth.roles) {
    lines.push(`**${role.name}:** ${role.description}`);
    lines.push(`Permissions: ${role.permissions.join(', ')}`);
    lines.push('');
  }
  if (design.auth.middleware) {
    lines.push('### Middleware Contract');
    lines.push('');
    lines.push(design.auth.middleware);
    lines.push('');
  }
  if (design.auth.multiTenancy) {
    lines.push('### Multi-Tenancy');
    lines.push('');
    lines.push(design.auth.multiTenancy);
    lines.push('');
  }
  if (design.auth.permissionsModel) {
    lines.push('### Permissions Model');
    lines.push('');
    lines.push(design.auth.permissionsModel);
    lines.push('');
  }
  lines.push('## API Conventions');
  lines.push('');
  for (const conv of design.api.conventions) lines.push(`- ${conv}`);
  lines.push('');
  lines.push('## Route Contracts');
  lines.push('');
  lines.push('| Route | Method | Auth | Roles | DB Reads | DB Writes |');
  lines.push('|-------|--------|------|-------|----------|-----------|');
  for (const r of design.api.routes) {
    lines.push(
      `| \`${r.path}\` | ${r.method} | ${r.authRequired ? 'Yes' : 'No'} | ${r.roles.join(', ') || 'any'} | ${r.dbReads.join(', ') || '—'} | ${r.dbWrites.join(', ') || '—'} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function renderInteractionMapsMd(design: ArchitectureDesign): string {
  const lines: string[] = [
    `# INTERACTION MAPS — ${design.projectName}`,
    '',
    `**Generated by FORGE Phase 1B**`,
    `**Date:** ${design.generatedAt}`,
    '',
    `> Contract 18: one map per interactive element. Total: ${design.interactionMaps.maps.length} map(s).`,
    '',
  ];
  const byFeature = new Map<string, InteractionMap[]>();
  for (const m of design.interactionMaps.maps) {
    const bucket = byFeature.get(m.feature) ?? [];
    bucket.push(m);
    byFeature.set(m.feature, bucket);
  }
  for (const [feature, maps] of byFeature) {
    lines.push(`## Feature: ${feature}`);
    lines.push('');
    for (const m of maps) {
      lines.push(`### ${m.element} — ${m.userAction}`);
      lines.push('');
      lines.push('| Step | Detail |');
      lines.push('|------|--------|');
      lines.push(`| Frontend reaction | ${m.frontendReaction} |`);
      lines.push(`| API call | \`${m.apiCall}\` |`);
      lines.push(`| Backend processing | ${m.backendProcessing} |`);
      lines.push(`| DB write | \`${m.dbWrite}\` |`);
      lines.push(`| Side effects | ${m.sideEffects.join('; ') || 'none'} |`);
      lines.push(`| Success | ${m.successResponse} |`);
      lines.push(`| Error | ${m.errorResponse} |`);
      lines.push(`| Tracking event | ${m.trackingEvent} |`);
      lines.push('');
    }
  }
  if (design.interactionMaps.maps.length === 0) {
    lines.push('_No interaction maps were produced._');
    lines.push('');
  }
  return lines.join('\n');
}

export function renderTestingMd(design: ArchitectureDesign): string {
  const lines: string[] = [
    `# TESTING — ${design.projectName}`,
    '',
    `**Generated by FORGE Phase 1B**`,
    `**Date:** ${design.generatedAt}`,
    '',
    '## Playwright Specs',
    '',
  ];
  if (design.testing.playwrightSpecs.length === 0) {
    lines.push('_No Playwright specs defined._');
    lines.push('');
  } else {
    lines.push('| Name | File | Scenario |');
    lines.push('|------|------|----------|');
    for (const s of design.testing.playwrightSpecs) {
      lines.push(`| ${s.name} | \`${s.file}\` | ${s.scenario} |`);
    }
    lines.push('');
  }
  lines.push('## API Tests');
  lines.push('');
  for (const t of design.testing.apiTests) {
    lines.push(`### \`${t.route}\``);
    for (const c of t.cases) lines.push(`- ${c}`);
    lines.push('');
  }
  if (design.testing.apiTests.length === 0) {
    lines.push('_No API tests defined._');
    lines.push('');
  }
  lines.push('## Six Laws Verification Plan');
  lines.push('');
  for (const c of design.testing.sixLawsPlan) {
    lines.push(`### ${c.law}`);
    lines.push(c.verification);
    lines.push('');
  }
  if (design.testing.sixLawsPlan.length === 0) {
    lines.push('_No Six Laws verification plan defined._');
    lines.push('');
  }
  return lines.join('\n');
}

export function renderStateOfTheBuildMd(design: ArchitectureDesign, projectPath: string): string {
  const criticalIssues = design.crossValidation.filter((v) => v.severity === 'critical');
  const blockerLines =
    criticalIssues.length > 0
      ? criticalIssues.map((v) => `- ❌ **${v.id}** — ${v.detail}`).join('\n')
      : '- None.';
  const lines: string[] = [
    `# STATE OF THE BUILD — ${design.projectName}`,
    '',
    `**Last Updated:** ${design.generatedAt}`,
    `**Build Status:** IN_PROGRESS`,
    `**Current Phase:** Phase 1B Complete → Awaiting Gate 2 Approval`,
    '',
    '## Phase Status',
    '',
    '| Phase | Status | Notes |',
    '|-------|--------|-------|',
    '| Phase 0 — Scout | pending | |',
    '| Phase 1A — PRD | pending | |',
    '| Phase 1B — Architecture | **complete** | Gate 2 awaiting human approval |',
    '| Phase 1C — Ingest | pending | |',
    '| Phase 2 — Governance | pending | |',
    '| Phase 3 — Executor | pending | |',
    '| Phase 4 — Sentinel | pending | |',
    '| Phase 5 — Learner | pending | |',
    '',
    '## Design Summary',
    '',
    `- **Project:** ${design.projectName}`,
    `- **Mode:** ${design.constrained ? 'Partial build' : 'Greenfield'}`,
    `- **Tables:** ${design.database.tables.length} (${design.database.tables.filter((t) => t.tenantScoped).length} tenant-scoped)`,
    `- **API Routes:** ${design.api.routes.length}`,
    `- **Pages:** ${design.frontend.pages.length}`,
    `- **Components:** ${design.frontend.components.length}`,
    `- **Agents:** ${design.agents.agents.length}`,
    `- **Interaction Maps:** ${design.interactionMaps.maps.length}`,
    `- **Playwright Specs:** ${design.testing.playwrightSpecs.length}`,
    `- **Cross-Validation Issues:** ${design.crossValidation.length} (${criticalIssues.length} critical)`,
    `- **Fallback Artifacts:** ${design.fallbackArtifacts.length > 0 ? design.fallbackArtifacts.join(', ') : 'none'}`,
    '',
    '## Gate Status',
    '',
    `- **Gate 2 (Architecture Approval):** ${design.gate.status}`,
    `- ${design.gate.detail}`,
    '',
    '## Critical Issues',
    '',
    blockerLines,
    '',
    `_Generated from project at: ${projectPath}_`,
  ];
  return lines.join('\n');
}

export function renderSessionStateMd(design: ArchitectureDesign): string {
  const warningLines =
    design.warnings.length > 0 ? design.warnings.map((w) => `- ${w}`).join('\n') : '- None.';
  const lines: string[] = [
    `# SESSION STATE — ${design.projectName}`,
    '',
    `**Last Updated:** ${design.generatedAt}`,
    `**Current Session:** Post-Phase 1B`,
    '',
    '## Current Status',
    '',
    '| Field | Value |',
    '|-------|-------|',
    '| Phase | Phase 1B Complete |',
    '| Gate | Gate 2 — Awaiting Human Approval |',
    `| Model | ${design.model} |`,
    `| Tokens In | ${design.tokensInput} |`,
    `| Tokens Out | ${design.tokensOutput} |`,
    `| Fallback Artifacts | ${design.fallbackArtifacts.length > 0 ? design.fallbackArtifacts.join(', ') : 'none'} |`,
    '',
    '## Next Action',
    '',
    '- Human reviews ARCHITECTURE.md and approves at Gate 2.',
    '- On approval: run Phase 2 (Governance Generator) to produce the full governance package.',
    '',
    '## Warnings',
    '',
    warningLines,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// ARCHITECTURE.md rendering
// ---------------------------------------------------------------------------

/** Render the full {@link ArchitectureDesign} as the ARCHITECTURE.md document. */
export function renderArchitectureMarkdown(design: ArchitectureDesign): string {
  const lines: string[] = [];
  lines.push(`# ${design.projectName} — ARCHITECTURE (FORGE Phase 1B)`);
  lines.push('');
  lines.push(`- **Generated:** ${design.generatedAt}`);
  lines.push(`- **Mode:** ${design.constrained ? 'partial build (extending an existing codebase)' : 'greenfield'}`);
  lines.push(`- **Model:** ${design.model}`);
  lines.push(
    `- **Design system:** ${design.designSystemGenerated ? `generated → ${design.designSystemPath ?? 'DESIGN_SYSTEM.md'} (injected into UI prompts)` : 'not generated (UI prompts used no design system)'}`
  );
  if (design.usedFallback) {
    lines.push(`- **⚠️ Fallback artifacts:** ${design.fallbackArtifacts.join(', ')} (could not be generated — complete or re-run before approval)`);
  }
  lines.push('');
  lines.push('> Gate 2: the build HALTS here until a human approves this architecture (Contract 2).');
  lines.push('');

  // The artifact markdown sections, in generation order.
  const sections: Array<{ kind: ArtifactKind; markdown: string }> = [
    { kind: 'database', markdown: design.database.markdown },
    { kind: 'api', markdown: design.api.markdown },
    { kind: 'frontend', markdown: design.frontend.markdown },
    { kind: 'interactionMaps', markdown: design.interactionMaps.markdown },
    { kind: 'auth', markdown: design.auth.markdown },
    { kind: 'agents', markdown: design.agents.markdown },
    { kind: 'infra', markdown: design.infra.markdown },
    { kind: 'testing', markdown: design.testing.markdown },
  ];
  for (const s of sections) {
    lines.push('---');
    lines.push('');
    lines.push(s.markdown.trim() === '' ? `_(${s.kind}: no content)_` : s.markdown.trim());
    lines.push('');
  }

  // Cross-validation report.
  lines.push('---');
  lines.push('');
  lines.push(`## Cross-Validation (${design.crossValidation.length} issue(s))`);
  if (design.crossValidation.length === 0) {
    lines.push('- ✅ Artifacts are mutually consistent (schema ↔ API ↔ frontend ↔ interaction maps).');
  } else {
    for (const v of design.crossValidation) {
      lines.push(`- ${v.severity === 'critical' ? '❌' : '⚠️'} **${v.id}** [${v.kind}] (${v.subject}) — ${v.detail}`);
    }
  }
  lines.push('');

  if (design.warnings.length > 0) {
    lines.push('## Warnings');
    for (const w of design.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 1B against `projectPath`, transforming the approved `prd` (plus an optional
 * {@link ConstraintManifest} in `options.constraintManifest`) into a complete
 * {@link ArchitectureDesign}.
 *
 * Always resolves (never rejects). Generates the eight artifacts in dependency order,
 * each in its own (chunked) model call seeded with a compact summary of the prior ones;
 * cross-validates them; writes ARCHITECTURE.md (unless disabled); and HALTS for Gate 2.
 * A failed artifact call degrades to a deterministic skeleton (`usedFallback: true`)
 * rather than throwing — the build still reaches the operator at Gate 2.
 */
export async function runPhase1bArchitect(
  projectPath: string,
  prd: string,
  options: Phase1bOptions = {}
): Promise<ArchitectureDesign> {
  const log = options.log ?? logLine('phase1b');
  const projectName = options.projectName ?? (basename(projectPath) || 'project');
  const model = options.model ?? process.env.FORGE_ARCHITECT_MODEL ?? DEFAULT_MODEL;
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  // Architecture design is complex-reasoning work → route through the Provider Router (Claude
  // primary, with failover/cost/free-tier handling). An explicit `options.callModel` still wins.
  const callModel = options.callModel ?? providerCallModel('complex_reasoning');
  const writeArchitectureFile = options.writeArchitectureFile ?? true;
  const architectureFileName = options.architectureFileName ?? 'ARCHITECTURE.md';
  const manifest = options.constraintManifest;
  const constrained = manifest !== undefined && manifest.partialBuild;
  const warnings: string[] = [];
  const fallbackArtifacts: ArtifactKind[] = [];

  if (prd.trim() === '') warnings.push('The supplied PRD is empty — artifacts will be sparse.');

  // 1. Build Memory grounding (proven patterns + applicable insights). Guarded.
  log('querying Build Memory for proven patterns and applicable insights');
  const grounding = await gatherGrounding(options.stackFingerprint);
  log(`grounding: ${grounding.insights.length} insight(s), ${grounding.patterns.length} pattern(s)`);

  // 2. Assemble the shared base context (PRD + grounding + immutable constraints).
  const constraintsBlock = constrained && manifest ? renderConstraints(manifest) : '';
  if (constrained) log('ConstraintManifest supplied — designing only extensions over the immutable surface');
  const baseContext = [
    '# Approved PRD',
    '',
    prd.trim() === '' ? '_(empty PRD)_' : prd.trim(),
    '',
    renderGrounding(grounding),
    constraintsBlock,
  ].join('\n');

  // 2.4. Resolve a cross-project brand baseline (Session 2 — Design Intelligence), BEFORE
  // design-system generation, so its product-type lineage can enrich the generator's query.
  const brandBaseline = await resolveBrandBaseline(options.inheritBrandFrom, warnings, log);
  const brandBaselineBlock = brandBaseline
    ? renderBrandBaselineBlock(brandBaseline, options.inheritBrandFrom as string)
    : '';

  // 2.5. Generate the project design system (UI/UX Pro Max) and write DESIGN_SYSTEM.md to
  // the target governance. Its content is injected into every UI prompt below. Non-fatal:
  // a missing skill / Python degrades to no injection (the build still designs UI).
  let designSystemBlock = '';
  let designSystemGenerated = false;
  let designSystemPath: string | null = null;
  if (options.generateDesignSystem !== false) {
    log('generating project design system via UI/UX Pro Max');
    const generateDs = options.generateDesignSystemImpl ?? generateDesignSystem;
    const explicitProductType = options.designSystemOptions?.productType;
    const derivedProductType = explicitProductType ?? deriveProductTypeQuery(prd, projectName);
    const productType = brandBaseline
      ? `${derivedProductType} — continuing the visual lineage of "${options.inheritBrandFrom}"` +
        (baselineProductType(brandBaseline) !== '' ? ` (${baselineProductType(brandBaseline)})` : '')
      : derivedProductType;
    const dsOptions: DesignSystemOptions = {
      projectName,
      prd,
      log: (m) => log(`design-system: ${m}`),
      ...(options.designSystemOptions ?? {}),
      productType,
    };
    const ds = await generateDs(projectPath, dsOptions);
    designSystemGenerated = ds.generated;
    designSystemPath = ds.designSystemPath;
    for (const w of ds.warnings) warnings.push(`design-system: ${w}`);
    if (ds.generated) {
      designSystemBlock = renderDesignSystemPromptBlock(ds.markdown);
      log(`design system ready ("${ds.productType}") → ${ds.designSystemPath ?? 'not written'}; injecting into UI prompts`);

      // Persist the generated design system to Build Memory (brands.ts) — guarded/non-fatal
      // (Contract 4): a failed write logs a warning and never blocks Phase 1B.
      try {
        const designTokensPayload: JsonObject = {
          markdown: ds.markdown,
          productType: ds.productType,
          generatedAt: ds.generatedAt,
        };
        const existingBrand = await BuildMemory.brands.getBrandByProject(projectName);
        if (existingBrand) {
          await BuildMemory.brands.updateBrand(projectName, { design_tokens: designTokensPayload });
        } else {
          await BuildMemory.brands.createBrand({
            project_name: projectName,
            brand_name: projectName,
            design_tokens: designTokensPayload,
          });
        }
        log(`persisted brand identity for "${projectName}" to Build Memory`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warnings.push(`design-system: could not persist brand to Build Memory (${detail})`);
        log(`WARNING: could not persist brand (${detail})`);
      }
    } else {
      log('design system not generated (non-fatal) — UI prompts proceed without it');
    }
  }

  // 3. Generate the eight artifacts in dependency order, threading a state summary.
  const ctx: GenContext = { model, maxTokens, apiKey, callModel, log, warnings, fallbackArtifacts };
  let stateSummary = constrained && manifest ? seedStateFromManifest(manifest) : '';
  let tokensInput = 0;
  let tokensOutput = 0;

  /** The UI-generating artifacts that receive the injected design system + brand baseline. */
  const isUiArtifact = (kind: ArtifactKind): boolean =>
    kind === 'frontend' || kind === 'interactionMaps';

  const uiExtraContext = [designSystemBlock, brandBaselineBlock].filter((s) => s.trim() !== '').join('\n\n');

  const sys = (kind: ArtifactKind): string =>
    buildSystemPrompt(projectName, constrained, ARTIFACT_SCHEMAS[kind].schema);
  const usr = (kind: ArtifactKind): string =>
    buildUserPrompt(
      baseContext,
      stateSummary,
      ARTIFACT_SCHEMAS[kind].instruction,
      isUiArtifact(kind) ? uiExtraContext : ''
    );

  // 1/8 database
  const dbGen = await generateArtifact('database', '1/8 DatabaseArchitecture', sys('database'), usr('database'), parseDatabase, fallbackDatabase, ctx);
  tokensInput += dbGen.tokensInput;
  tokensOutput += dbGen.tokensOutput;
  const database = dbGen.artifact;
  stateSummary = `${stateSummary}\n${summarizeDatabase(database)}`.trim();

  // 2/8 api
  const apiGen = await generateArtifact('api', '2/8 APIArchitecture', sys('api'), usr('api'), parseApi, fallbackApi, ctx);
  tokensInput += apiGen.tokensInput;
  tokensOutput += apiGen.tokensOutput;
  const api = apiGen.artifact;
  stateSummary = `${stateSummary}\n${summarizeApi(api)}`.trim();

  // 3/8 frontend
  const feGen = await generateArtifact('frontend', '3/8 FrontendArchitecture', sys('frontend'), usr('frontend'), parseFrontend, fallbackFrontend, ctx);
  tokensInput += feGen.tokensInput;
  tokensOutput += feGen.tokensOutput;
  const frontend = feGen.artifact;
  stateSummary = `${stateSummary}\n${summarizeFrontend(frontend)}`.trim();

  // Merge the structured design tokens (colors/typography/spacing/radii/shadows) from the
  // FrontendArchitecture artifact into the SAME brand row the design system persisted above,
  // so it carries both the UI/UX Pro Max markdown AND the structured token set. Guarded/non-fatal.
  if (designSystemGenerated) {
    try {
      const existingBrand = await BuildMemory.brands.getBrandByProject(projectName);
      if (existingBrand) {
        await BuildMemory.brands.updateBrand(projectName, {
          design_tokens: { ...existingBrand.design_tokens, tokens: frontend.designTokens as unknown as JsonObject },
        });
        log(`merged structured design tokens into brand "${projectName}"`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`design-system: could not merge structured tokens into brand (${detail})`);
    }
  }

  // 4/8 interaction maps
  const imGen = await generateArtifact('interactionMaps', '4/8 InteractionMaps', sys('interactionMaps'), usr('interactionMaps'), parseInteractionMaps, fallbackInteractionMaps, ctx);
  tokensInput += imGen.tokensInput;
  tokensOutput += imGen.tokensOutput;
  const interactionMaps = imGen.artifact;
  stateSummary = `${stateSummary}\n${summarizeInteractionMaps(interactionMaps)}`.trim();

  // 5/8 auth
  const authGen = await generateArtifact('auth', '5/8 AuthArchitecture', sys('auth'), usr('auth'), parseAuth, fallbackAuth, ctx);
  tokensInput += authGen.tokensInput;
  tokensOutput += authGen.tokensOutput;
  const auth = authGen.artifact;
  stateSummary = `${stateSummary}\n${summarizeAuth(auth)}`.trim();

  // 6/8 agents
  const agentsGen = await generateArtifact('agents', '6/8 AgentArchitecture', sys('agents'), usr('agents'), parseAgents, fallbackAgents, ctx);
  tokensInput += agentsGen.tokensInput;
  tokensOutput += agentsGen.tokensOutput;
  const agents = agentsGen.artifact;
  stateSummary = `${stateSummary}\n${summarizeAgents(agents)}`.trim();

  // 7/8 infra
  const infraGen = await generateArtifact('infra', '7/8 InfraArchitecture', sys('infra'), usr('infra'), parseInfra, fallbackInfra, ctx);
  tokensInput += infraGen.tokensInput;
  tokensOutput += infraGen.tokensOutput;
  const infra = infraGen.artifact;
  stateSummary = `${stateSummary}\n${summarizeInfra(infra)}`.trim();

  // 8/8 testing
  const testGen = await generateArtifact('testing', '8/8 TestingStrategy', sys('testing'), usr('testing'), parseTesting, fallbackTesting, ctx);
  tokensInput += testGen.tokensInput;
  tokensOutput += testGen.tokensOutput;
  const testing = testGen.artifact;

  // Hard gate: a completely empty architecture (no tables, no routes, no pages) means
  // every core artifact degraded to a fallback skeleton — almost always a missing/invalid
  // API key or an unavailable model. Fail loudly here so an empty design never silently
  // passes to the queue generator.
  if (database.tables.length === 0 && api.routes.length === 0 && frontend.pages.length === 0) {
    throw new Error(
      'Architecture produced no tables, routes, or pages. Check API keys and model availability.'
    );
  }

  // 4. Cross-validate the artifacts against one another.
  log('cross-validating artifacts (schema ↔ API ↔ frontend ↔ interaction maps)');
  const crossValidation = crossValidate(database, api, frontend, interactionMaps, manifest);
  const criticalCount = crossValidation.filter((v) => v.severity === 'critical').length;
  log(`cross-validation: ${crossValidation.length} issue(s) (${criticalCount} critical)`);

  // 5. Assemble the design object.
  const design: ArchitectureDesign = {
    projectName,
    database,
    api,
    frontend,
    interactionMaps,
    auth,
    agents,
    infra,
    testing,
    crossValidation,
    constrained,
    designSystemGenerated,
    designSystemPath,
    architecturePath: null,
    model,
    tokensInput,
    tokensOutput,
    usedFallback: fallbackArtifacts.length > 0,
    fallbackArtifacts,
    warnings,
    gate: {
      name: 'Gate 2 — Architecture Approval',
      status: 'awaiting_human_approval',
      detail:
        'Phase 1B complete. The build HALTS here until a human approves the architecture ' +
        '(BEHAVIORAL_CONTRACTS Contract 2). Phase 2 (Governance) must not start before approval.',
    },
    adversaryReview: null,
    governanceDocs: {},
    generatedAt: nowIso(),
  };

  // 6. Write ARCHITECTURE.md to the target project (guarded).
  if (writeArchitectureFile) {
    const target = join(projectPath, architectureFileName);
    try {
      await writeFile(target, renderArchitectureMarkdown(design), 'utf8');
      design.architecturePath = target;
      log(`wrote ${target}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to write ${architectureFileName}: ${detail}`);
      log(`WARNING: could not write ${architectureFileName} (${detail})`);
    }
  }

  // 7. Write the eight governance documents (guarded — each failure is a warning, never a throw).
  const writeGovernanceDocs = options.writeGovernanceDocs ?? true;
  const governanceDocs: Partial<Record<GovernanceDocName, string | null>> = {};
  if (writeGovernanceDocs) {
    const govDir = options.governanceDir ?? join(projectPath, 'governance');
    let govDirReady = false;
    try {
      await mkdir(govDir, { recursive: true });
      govDirReady = true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to create governance directory ${govDir}: ${detail}`);
      log(`WARNING: could not create governance dir (${detail}); skipping governance docs`);
    }
    if (govDirReady) {
      const docRenderers: Array<{ name: GovernanceDocName; render: () => string }> = [
        { name: 'BLUEPRINT.md', render: () => renderBlueprintMd(design) },
        { name: 'SCHEMA_REGISTRY.md', render: () => renderSchemaRegistryMd(design) },
        { name: 'AGENTS.md', render: () => renderAgentsMd(design) },
        { name: 'BEHAVIORAL_CONTRACTS.md', render: () => renderBehavioralContractsMd(design) },
        { name: 'INTERACTION_MAPS.md', render: () => renderInteractionMapsMd(design) },
        { name: 'TESTING.md', render: () => renderTestingMd(design) },
        { name: 'STATE_OF_THE_BUILD.md', render: () => renderStateOfTheBuildMd(design, projectPath) },
        { name: 'SESSION_STATE.md', render: () => renderSessionStateMd(design) },
      ];
      for (const { name, render } of docRenderers) {
        try {
          const content = render();
          const docPath = join(govDir, name);
          await writeFile(docPath, content, 'utf8');
          governanceDocs[name] = docPath;
          log(`wrote governance/${name}`);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          governanceDocs[name] = null;
          warnings.push(`Failed to write governance/${name}: ${detail}`);
          log(`WARNING: could not write governance/${name} (${detail})`);
        }
      }
      const written = Object.values(governanceDocs).filter(Boolean).length;
      log(`governance documents: ${written}/${docRenderers.length} written to ${govDir}`);
    }
  }
  design.governanceDocs = governanceDocs;

  // 8. Adversarial review on the governance suite (ARCHITECT_GOVERNANCE phase). Guarded.
  log('running adversarial review (ARCHITECT_GOVERNANCE)');
  const reviewKey = apiKey || undefined;
  if (reviewKey) {
    try {
      // Build a compact summary of the governance suite for the adversary (capped at 8000 chars).
      const govSummary = renderArchitectureMarkdown(design);
      const adversaryReview = await runAdversarialReview('ARCHITECT_GOVERNANCE', govSummary, reviewKey);
      design.adversaryReview = adversaryReview;
      log(
        `adversarial review: ${adversaryReview.findings.length} finding(s) ` +
          `(${adversaryReview.blockers.length} blocker(s)); canProceed=${adversaryReview.canProceed}`
      );
      for (const b of adversaryReview.blockers) {
        warnings.push(`ADVERSARY BLOCKER [${b.vector}]: ${b.specificIssue}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Adversarial review failed (${reason}); skipped.`);
      log(`WARNING: adversarial review failed (${reason}); skipped`);
    }
  } else {
    log('adversarial review skipped — no API key');
  }

  log(
    `Phase 1B complete — ${database.tables.length} table(s), ${api.routes.length} route(s), ` +
      `${frontend.pages.length} page(s), ${interactionMaps.maps.length} interaction map(s); ` +
      `governance docs: ${Object.values(governanceDocs).filter(Boolean).length}/8; ` +
      `adversary: ${design.adversaryReview ? `${design.adversaryReview.findings.length} finding(s)` : 'skipped'}; ` +
      `tokens in=${tokensInput} out=${tokensOutput}. HALT for Gate 2 (human architecture approval required).`
  );

  return design;
}

export default runPhase1bArchitect;
