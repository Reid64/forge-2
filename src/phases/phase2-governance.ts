/**
 * FORGE 2.0 â€” Phase 2: Governance Generator.
 *
 * Phase 2 (queue.yaml s4-p01) is the LAST design phase. It takes the APPROVED
 * {@link ArchitectureDesign} produced by Phase 1B (and approved at Gate 2) and renders
 * the complete GOVERNANCE PACKAGE the rest of FORGE executes against. It then HALTS for
 * Gate 3 human approval (BEHAVIORAL_CONTRACTS Contract 2 â€” no bypass).
 *
 * EIGHT documents are produced, each from its template under `templates/governance/`:
 *   1. BLUEPRINT.md            â€” system overview + tech stack + project structure
 *   2. SCHEMA_REGISTRY.md      â€” every table, column, constraint, index, RLS policy, seed
 *   3. AGENTS.md               â€” every agent definition (trigger, I/O contract, prompt, budget)
 *   4. BEHAVIORAL_CONTRACTS.md â€” API + Auth + interaction-summary contracts
 *   5. INTERACTION_MAPS.md     â€” per-feature, per-element interaction specs (Contract 18)
 *   6. TESTING.md              â€” the test plan + generated Playwright scaffolds + Six Laws plan
 *   7. STATE_OF_THE_BUILD.md   â€” Phase 0-2 status, design summary, governance package, audit
 *   8. SESSION_STATE.md        â€” the live-session tracker, initialized empty
 *
 * DETERMINISTIC: unlike Phases 1A/1B, this phase makes NO model calls. It is a pure,
 * repeatable transformation from the structured design into Markdown â€” the same design
 * always yields the same governance package (modulo timestamps and the live audit).
 *
 * TEMPLATES: each document is rendered by substituting `{{PLACEHOLDER}}` markers in the
 * corresponding `templates/governance/<DOC>.template.md` file. Templates are read from
 * disk (overridable via `options.templatesDir`); if a template file is unreadable, an
 * embedded fallback identical to the on-disk template is used and a warning is collected.
 *
 * AUDIT (BLUEPRINT Canonical Rule 9): STATE_OF_THE_BUILD.md and SESSION_STATE.md are
 * populated from an ACTUAL codebase audit of the target project ({@link readCodebase}),
 * not assumptions â€” so the state documents reflect the real file tree, schema, and routes
 * present after the package is written.
 *
 * NON-FATAL house style (matching the sibling phase orchestrators): every Build Memory
 * write is guarded (Contract 4 â€” degrade to stateless) and every file read/write is
 * wrapped so a failure is collected as a warning rather than thrown. Build Memory version
 * recording (Contract 6 â€” every template version-controlled with a content hash) is
 * best-effort. `runPhase2Governance` never rejects.
 *
 * BOUNDARY: documents are written ONLY to the TARGET project's governance directory
 * (`<projectPath>/governance` by default). This phase never touches FORGE's own
 * governance files (Iron Law 1) â€” `projectPath` is always the build target, never FORGE.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import type {
  AgentArchitecture,
  ApiRoute,
  ArchTable,
  ArchitectureDesign,
  AuthArchitecture,
  DatabaseArchitecture,
  InteractionMap,
  TestingStrategy,
} from './phase1b-architect.js';
import type { StackFingerprint } from '../tools/stack-detector.js';
import { readCodebase } from '../tools/codebase-reader.js';
import type { CodebaseSnapshot } from '../tools/codebase-reader.js';
import { BuildMemory, nowIso } from '../memory/index.js';
import { transferKnowledge } from '../learning/cross-project-transfer.js';
import { logLine } from '../tools/forge-logger.js';
import { toAsciiGovernanceText } from '../tools/governance-text.js';
import { detectVsCodePath } from '../tools/live-status.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The eight governance documents Phase 2 produces, by output filename. */
export type GovernanceDocName =
  | 'BLUEPRINT.md'
  | 'SCHEMA_REGISTRY.md'
  | 'AGENTS.md'
  | 'BEHAVIORAL_CONTRACTS.md'
  | 'INTERACTION_MAPS.md'
  | 'TESTING.md'
  | 'STATE_OF_THE_BUILD.md'
  | 'SESSION_STATE.md';

/** The status of a single FORGE phase as reported in STATE_OF_THE_BUILD.md. */
export type PhaseStatus = 'complete' | 'in_progress' | 'pending' | 'skipped' | 'not_applicable';

/** Per-document outcome (written path, content hash, Build Memory version record). */
export interface GovernanceDocResult {
  /** Output filename (e.g. `BLUEPRINT.md`). */
  name: GovernanceDocName;
  /** Absolute path the document was written to, or `null` if the write failed/was skipped. */
  path: string | null;
  /** SHA-256 of the rendered content (Contract 6). */
  contentHash: string;
  /** Byte length of the rendered content. */
  bytes: number;
  /** Template file actually used, or `'(embedded fallback)'`. */
  templateSource: string;
  /** True when a governance_versions row was recorded in Build Memory for this document. */
  versionRecorded: boolean;
  /** Placeholder keys the template referenced but that had no value (left marked in output). */
  missingPlaceholders: string[];
}

/** Gate 3 marker â€” Phase 2 always halts here for human approval (Contract 2). */
export interface Gate3Status {
  name: 'Gate 3 -- Governance Approval';
  /** Always `awaiting_human_approval`: there is no bypass (Contract 2). */
  status: 'awaiting_human_approval';
  detail: string;
}

/** The complete result of {@link runPhase2Governance}. */
export interface GovernancePackage {
  projectName: string;
  /** Absolute path of the target governance directory the documents were written to. */
  governanceDir: string;
  /** Per-document outcomes, in generation order. */
  documents: GovernanceDocResult[];
  /** Headline counts from the live codebase audit that seeded the state documents. */
  audit: {
    totalFiles: number;
    totalLines: number;
    totalDirectories: number;
    sourceFiles: number;
    tablesFound: number;
    routesFound: number;
    governanceDocsFound: number;
  };
  /** True when a ConstraintManifest (partial build) shaped the design. */
  constrained: boolean;
  /** Non-fatal observations (template unreadable, write failure, memory unreachable, â€¦). */
  warnings: string[];
  /** Gate 3 â€” the build halts here until a human approves the governance package. */
  gate: Gate3Status;
  generatedAt: string;
}

/** Options for {@link runPhase2Governance}. */
export interface Phase2Options {
  /** Project name for titles/labels. Default: `design.projectName` or the basename of `projectPath`. */
  projectName?: string;
  /** Target stack fingerprint (from Phase 0). Used to render BLUEPRINT's tech stack. */
  stackFingerprint?: StackFingerprint;
  /** Governance directory name under the target project. Default `'governance'`. */
  governanceDirName?: string;
  /**
   * Directory holding the `*.template.md` files. Default: the repo's `templates/governance`
   * resolved relative to this module. A missing/unreadable template degrades to an embedded
   * fallback (with a warning).
   */
  templatesDir?: string;
  /** Write the documents to disk. Default true (set false for a dry render). */
  writeFiles?: boolean;
  /** Record a governance_versions row per document in Build Memory. Default true (guarded). */
  recordVersions?: boolean;
  /**
   * Overrides for the Phase 0-2 status table in STATE_OF_THE_BUILD.md. By default Phases
   * 0/1A/1B/2 are `complete` and 1C is derived from `design.constrained`.
   */
  phaseStatus?: Partial<Record<'phase0' | 'phase1a' | 'phase1b' | 'phase1c' | 'phase2', PhaseStatus>>;
  /** Progress reporter. Default logs to the console with a [FORGE:phase2] prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The six DESIGN documents (rendered before the live audit). */
const DESIGN_DOCS: readonly GovernanceDocName[] = [
  'BLUEPRINT.md',
  'SCHEMA_REGISTRY.md',
  'AGENTS.md',
  'BEHAVIORAL_CONTRACTS.md',
  'INTERACTION_MAPS.md',
  'TESTING.md',
];

/** The two STATE documents (rendered AFTER the live audit and the design docs). */
const STATE_DOCS: readonly GovernanceDocName[] = ['STATE_OF_THE_BUILD.md', 'SESSION_STATE.md'];

/** Map an output filename to its template filename. */
function templateFileFor(doc: GovernanceDocName): string {
  return doc.replace(/\.md$/, '.template.md');
}

/** The default templates directory: `<repo>/templates/governance` relative to this module. */
function defaultTemplatesDir(): string {
  // This module lives at <repo>/(src|dist)/phases/phase2-governance.(ts|js); both `src`
  // and `dist` are direct children of the repo root, so `../../templates/governance`
  // resolves correctly whether running from source (tsx) or compiled.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'templates', 'governance');
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

/** Escape a value for use inside a Markdown table cell (pipes + newlines). */
function cell(value: string): string {
  const s = value.trim();
  if (s === '') return 'â€”';
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Wrap text in an inline code span, or em-dash for empty. */
function code(value: string): string {
  const s = value.trim();
  return s === '' ? 'â€”' : `\`${s}\``;
}

/** Render a bullet list, or a single "_(none)_" line when empty. */
function bullets(items: readonly string[]): string {
  if (items.length === 0) return '- _(none)_';
  return items.map((i) => `- ${i}`).join('\n');
}

/** Join a string array as an inline, comma-separated list (em-dash when empty). */
function inlineList(items: readonly string[]): string {
  return items.length === 0 ? 'â€”' : items.join(', ');
}

// ---------------------------------------------------------------------------
// Template substitution
// ---------------------------------------------------------------------------

/**
 * Replace every `{{KEY}}` marker in `template` with `vars[KEY]`. Missing keys are left
 * as a clearly-marked placeholder and reported so the operator can spot a gap at Gate 3.
 */
function applyTemplate(
  template: string,
  vars: Record<string, string>
): { content: string; missing: string[] } {
  const missing: string[] = [];
  const content = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key] ?? '';
    if (!missing.includes(key)) missing.push(key);
    return `_(unfilled: ${key})_`;
  });
  return { content, missing };
}

// ---------------------------------------------------------------------------
// Section renderers â€” BLUEPRINT.md
// ---------------------------------------------------------------------------

function renderSystemOverview(design: ArchitectureDesign): string {
  const d = design;
  const roles = d.auth.roles.map((r) => r.name).filter((n) => n !== '');
  const parts = [
    `\`${d.projectName}\` is an application designed by FORGE 2.0 from an approved architecture.`,
    `It comprises ${d.database.tables.length} data table(s), ${d.api.routes.length} API route(s), ` +
      `${d.frontend.pages.length} page(s)${d.agents.agents.length > 0 ? `, and ${d.agents.agents.length} autonomous agent(s)` : ''}.`,
  ];
  if (roles.length > 0) parts.push(`Access is governed by ${roles.length} role(s): ${roles.join(', ')}.`);
  if ((d.auth.multiTenancy ?? "").trim() !== '') parts.push(`Multi-tenancy: ${(d.auth.multiTenancy ?? "").trim()}`);
  return parts.join(' ');
}

function renderTechStack(fingerprint: StackFingerprint | undefined): string {
  if (fingerprint) {
    const lines = [
      `- **Framework:** ${fingerprint.framework || 'Next.js 14'}`,
      `- **Language:** ${fingerprint.language || 'TypeScript (strict)'}`,
      `- **Database:** ${fingerprint.database || 'Supabase (PostgreSQL + Auth + RLS)'}`,
      `- **Deployment:** ${fingerprint.deployment || 'Vercel'}`,
      `- **Package Manager:** ${fingerprint.packageManager || 'pnpm'}`,
    ];
    if (fingerprint.services && fingerprint.services.length > 0) {
      lines.push(`- **Services:** ${fingerprint.services.join(', ')}`);
    }
    if (fingerprint.cliTools && fingerprint.cliTools.length > 0) {
      lines.push(`- **CLI tools:** ${fingerprint.cliTools.join(', ')}`);
    }
    return lines.join('\n');
  }
  // FORGE default stack (TECH STACK â€” LOCKED, per CLAUDE.md).
  return [
    '- **Framework:** Next.js 14 (App Router), TypeScript strict mode',
    '- **Database:** Supabase (PostgreSQL + Auth + RLS + Realtime)',
    '- **Hosting:** Vercel',
    '- **Package Manager:** pnpm',
    '- **Testing:** Playwright',
    '- **Version Control:** Git â†’ GitHub',
  ].join('\n');
}

function renderArchitectureOverview(design: ArchitectureDesign): string {
  const d = design;
  const tenant = d.database.tables.filter((t) => t.tenantScoped).map((t) => t.name);
  const lines = [
    `- **Tables:** ${d.database.tables.length} (tenant-scoped: ${tenant.length === 0 ? 'none' : tenant.join(', ')})`,
    `- **API routes:** ${d.api.routes.length}`,
    `- **Pages:** ${d.frontend.pages.length}; **components:** ${d.frontend.components.length}; **layouts:** ${d.frontend.layouts.length}`,
    `- **Interaction maps:** ${d.interactionMaps.maps.length} (Contract 18 granularity)`,
    `- **Roles:** ${inlineList(d.auth.roles.map((r) => r.name))}`,
    `- **Agents:** ${inlineList(d.agents.agents.map((a) => a.name))}`,
  ];
  if (d.frontend.responsiveStrategy.trim() !== '') {
    lines.push(`- **Responsive strategy:** ${d.frontend.responsiveStrategy.trim()}`);
  }
  return lines.join('\n');
}

/** Synthesize a representative project tree from the design (Next.js App Router shape). */
function renderProjectStructure(design: ArchitectureDesign): string {
  const d = design;
  const lines: string[] = [`${d.projectName}/`];

  // app/ â€” pages + api routes.
  lines.push('â”œâ”€â”€ app/');
  lines.push('â”‚   â”œâ”€â”€ layout.tsx');
  lines.push('â”‚   â”œâ”€â”€ page.tsx');
  for (const p of d.frontend.pages) {
    if (p.path.trim() === '' || p.path === '/') continue;
    const seg = p.path.replace(/^\/+/, '');
    lines.push(`â”‚   â”œâ”€â”€ ${seg}/page.tsx`);
  }
  const apiRoutes = d.api.routes.filter((r) => r.path.trim() !== '');
  if (apiRoutes.length > 0) {
    lines.push('â”‚   â””â”€â”€ api/');
    for (const r of apiRoutes) {
      const seg = r.path.replace(/^\/+/, '').replace(/^api\//, '');
      lines.push(`â”‚       â””â”€â”€ ${seg}/route.ts`);
    }
  }

  // components/
  lines.push('â”œâ”€â”€ components/');
  for (const c of d.frontend.components) {
    if (c.name.trim() !== '') lines.push(`â”‚   â”œâ”€â”€ ${c.name}.tsx`);
  }

  // lib/ (Supabase client convention).
  lines.push('â”œâ”€â”€ lib/');
  lines.push('â”‚   â””â”€â”€ supabase/');
  lines.push('â”‚       â”œâ”€â”€ client.ts');
  lines.push('â”‚       â””â”€â”€ server.ts');

  // supabase/migrations/
  lines.push('â”œâ”€â”€ supabase/');
  lines.push('â”‚   â””â”€â”€ migrations/');
  for (const m of d.database.migrations) {
    if (m.filename.trim() !== '') lines.push(`â”‚       â”œâ”€â”€ ${m.filename}`);
  }

  // tests/
  lines.push('â”œâ”€â”€ tests/');
  for (const s of d.testing.playwrightSpecs) {
    if (s.file.trim() !== '') lines.push(`â”‚   â”œâ”€â”€ ${s.file}`);
  }

  // root files.
  lines.push('â”œâ”€â”€ middleware.ts');
  lines.push('â”œâ”€â”€ package.json');
  lines.push('â””â”€â”€ tsconfig.json');

  return '```\n' + lines.join('\n') + '\n```';
}

function renderEnvironmentVariables(design: ArchitectureDesign): string {
  const names = new Set<string>();
  for (const env of design.infra.environments) {
    for (const v of env.variables) if (v.trim() !== '') names.add(v.trim());
  }
  if (names.size === 0) {
    return [
      'No project-specific environment variables were specified by the architecture.',
      'The FORGE default stack requires at least:',
      '```',
      'NEXT_PUBLIC_SUPABASE_URL=',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY=',
      'SUPABASE_SERVICE_ROLE_KEY=',
      '```',
    ].join('\n');
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  return '```\n' + sorted.map((n) => `${n}=`).join('\n') + '\n```';
}

const BLUEPRINT_CANONICAL_RULES = [
  '1. Every multi-tenant table carries a company/tenant scope column with RLS enabled (Six Laws Law 1).',
  '2. API routes derive `company_id` from the session â€” NEVER from the request body (Six Laws Law 2).',
  '3. On ANY role-fetch failure, middleware redirects to `/login` ONLY â€” never a default/wrong-role page (Iron Law 4).',
  '4. No mocks or placeholder data in production code â€” all data comes from real tables (Iron Law 8).',
  '5. Dashboard HTML is served via no-cache API routes, never directly from `public/` (Iron Law 5).',
  '6. `pnpm tsc --noEmit` must return zero errors before any commit (Iron Law 6).',
  '7. Governance documents are read-only during Phase 3 execution (Contract 3).',
];

function renderBlueprint(
  design: ArchitectureDesign,
  fingerprint: StackFingerprint | undefined,
  crossProjectContext = ''
): Record<string, string> {
  const overview =
    crossProjectContext.trim() === ''
      ? renderSystemOverview(design)
      : `${renderSystemOverview(design)}\n\n${crossProjectContext.trim()}`;
  return {
    SYSTEM_OVERVIEW: overview,
    TECH_STACK: renderTechStack(fingerprint),
    ARCHITECTURE_OVERVIEW: renderArchitectureOverview(design),
    PROJECT_STRUCTURE: renderProjectStructure(design),
    ENVIRONMENT_VARIABLES: renderEnvironmentVariables(design),
    CANONICAL_RULES: bullets(BLUEPRINT_CANONICAL_RULES),
  };
}

// ---------------------------------------------------------------------------
// Section renderers â€” SCHEMA_REGISTRY.md
// ---------------------------------------------------------------------------

function renderTable(table: ArchTable): string {
  const lines: string[] = [];
  const schema = table.schema || 'public';
  lines.push(`### Table: \`${table.name || '(unnamed)'}\`${table.immutable ? ' _(immutable â€” pre-existing)_' : ''}`);
  if (table.purpose.trim() !== '') lines.push(table.purpose.trim());
  lines.push('');
  lines.push('| Column | Type | Nullable | Default | Constraints |');
  lines.push('|--------|------|----------|---------|-------------|');
  if (table.columns.length === 0) {
    lines.push('| _(no columns defined)_ | | | | |');
  } else {
    for (const c of table.columns) {
      lines.push(
        `| ${cell(c.name)} | ${cell(c.type)} | ${c.nullable ? 'yes' : 'no'} | ` +
          `${c.default === null ? 'â€”' : cell(c.default)} | ${cell(inlineList(c.constraints))} |`
      );
    }
  }
  lines.push('');
  lines.push(`- **Schema:** \`${schema}\``);
  lines.push(`- **Primary key:** ${table.primaryKey.length === 0 ? 'â€”' : table.primaryKey.map(code).join(', ')}`);
  if (table.foreignKeys.length > 0) {
    lines.push('- **Foreign keys:**');
    for (const fk of table.foreignKeys) {
      lines.push(
        `  - (${fk.columns.join(', ')}) â†’ \`${fk.referencesTable}\`(${fk.referencesColumns.join(', ')})` +
          `${fk.onDelete ? ` ON DELETE ${fk.onDelete}` : ''}`
      );
    }
  }
  lines.push(`- **RLS:** ${table.rlsEnabled ? 'enabled' : 'disabled'}`);
  lines.push(`- **Tenant-scoped:** ${table.tenantScoped ? 'yes (company/tenant isolation enforced)' : 'no'}`);
  return lines.join('\n');
}

function renderSchemaRegistry(db: DatabaseArchitecture): Record<string, string> {
  const tenant = db.tables.filter((t) => t.tenantScoped).map((t) => t.name);
  const overview = [
    `- **Tables:** ${db.tables.length}`,
    `- **Indexes:** ${db.indexes.length}`,
    `- **RLS policies:** ${db.rlsPolicies.length}`,
    `- **Seed loads:** ${db.seeds.length}`,
    `- **Migrations:** ${db.migrations.length}`,
    `- **Tenant-scoped tables:** ${tenant.length === 0 ? 'none' : tenant.join(', ')}`,
  ].join('\n');

  const tables = db.tables.length === 0 ? '_(no tables designed)_' : db.tables.map(renderTable).join('\n\n');

  const indexes =
    db.indexes.length === 0
      ? '_(no indexes designed)_'
      : [
          '| Name | Table | Columns | Unique | Method | Predicate |',
          '|------|-------|---------|--------|--------|-----------|',
          ...db.indexes.map(
            (i) =>
              `| ${cell(i.name)} | ${cell(i.table)} | ${cell(inlineList(i.columns))} | ${i.unique ? 'yes' : 'no'} | ` +
              `${i.method === null ? 'â€”' : cell(i.method)} | ${i.where === null ? 'â€”' : cell(i.where)} |`
          ),
        ].join('\n');

  const rls =
    db.rlsPolicies.length === 0
      ? '_(no RLS policies designed)_'
      : [
          '| Name | Table | Command | Roles | USING | WITH CHECK |',
          '|------|-------|---------|-------|-------|------------|',
          ...db.rlsPolicies.map(
            (p) =>
              `| ${cell(p.name)} | ${cell(p.table)} | ${cell(p.command)} | ${cell(inlineList(p.roles))} | ` +
              `${p.using === null ? 'â€”' : cell(p.using)} | ${p.check === null ? 'â€”' : cell(p.check)} |`
          ),
        ].join('\n');

  const seeds =
    db.seeds.length === 0
      ? '_(no seed data designed)_'
      : bullets(db.seeds.map((s) => `\`${s.table}\` â€” ${s.description}${s.rowCount === null ? '' : ` (~${s.rowCount} rows)`}`));

  const migrations =
    db.migrations.length === 0
      ? '_(no migrations planned)_'
      : bullets(db.migrations.map((m) => `\`${m.filename}\` â€” ${m.description}`));

  return {
    DATABASE_OVERVIEW: overview,
    TABLES: tables,
    INDEXES: indexes,
    RLS_POLICIES: rls,
    SEED_DATA: seeds,
    MIGRATIONS: migrations,
  };
}

// ---------------------------------------------------------------------------
// Section renderers â€” AGENTS.md
// ---------------------------------------------------------------------------

function renderAgents(agents: AgentArchitecture): Record<string, string> {
  const orchestration = agents.orchestration.trim() === '' ? '_(no orchestration specified)_' : agents.orchestration.trim();

  if (agents.agents.length === 0) {
    return {
      ORCHESTRATION: orchestration,
      AGENTS: 'This project defines no autonomous agents.',
    };
  }

  const sections = agents.agents.map((a) => {
    const lines = [
      `### Agent: ${a.name || '(unnamed)'}`,
      `- **Purpose:** ${a.purpose || 'â€”'}`,
      `- **Trigger:** ${a.trigger || 'â€”'}`,
      `- **Input contract:** ${a.inputContract || 'â€”'}`,
      `- **Output contract:** ${a.outputContract || 'â€”'}`,
      `- **Model:** \`${a.model || 'â€”'}\``,
      `- **Token budget:** ${a.tokenBudget === null ? 'unbounded/unspecified' : String(a.tokenBudget)}`,
      '',
      '**System prompt:**',
      '```',
      a.systemPrompt.trim() === '' ? '(none specified)' : a.systemPrompt.trim(),
      '```',
    ];
    return lines.join('\n');
  });

  return { ORCHESTRATION: orchestration, AGENTS: sections.join('\n\n') };
}

// ---------------------------------------------------------------------------
// Section renderers â€” BEHAVIORAL_CONTRACTS.md
// ---------------------------------------------------------------------------

function renderApiRoute(route: ApiRoute): string {
  const lines = [
    `### \`${route.method} ${route.path}\`${route.immutable ? ' _(immutable â€” pre-existing)_' : ''}`,
    `- **Purpose:** ${route.purpose || 'â€”'}`,
    `- **Auth required:** ${route.authRequired ? 'yes' : 'no'}`,
    `- **Roles:** ${inlineList(route.roles)}`,
    `- **Request:** ${route.requestSchema || 'â€”'}`,
    `- **Response:** ${route.responseSchema || 'â€”'}`,
    `- **Reads tables:** ${inlineList(route.dbReads.map((t) => `\`${t}\``))}`,
    `- **Writes tables:** ${inlineList(route.dbWrites.map((t) => `\`${t}\``))}`,
  ];
  if (route.errors.length > 0) {
    lines.push('- **Errors:**');
    for (const e of route.errors) lines.push(`  - \`${e.status}\` ${e.code} â€” ${e.description}`);
  }
  return lines.join('\n');
}

function renderApiContracts(api: APILike): string {
  const conventions =
    api.conventions.length === 0 ? '' : ['#### Conventions', bullets(api.conventions), ''].join('\n');
  const routes =
    api.routes.length === 0 ? '_(no API routes designed)_' : api.routes.map(renderApiRoute).join('\n\n');
  return `${conventions}${routes}`;
}

/** Minimal structural alias so the renderer doesn't import the full APIArchitecture name twice. */
interface APILike {
  routes: ApiRoute[];
  conventions: string[];
}

function renderAuthContracts(auth: AuthArchitecture): string {
  const lines: string[] = [];

  lines.push('#### Roles');
  if (auth.roles.length === 0) lines.push('_(no roles defined)_');
  else {
    for (const r of auth.roles) {
      lines.push(`- **${r.name}** â€” ${r.description || 'â€”'}`);
      if (r.permissions.length > 0) lines.push(`  - Permissions: ${inlineList(r.permissions)}`);
    }
  }
  lines.push('');

  lines.push('#### Flows');
  if (auth.flows.length === 0) lines.push('_(no flows defined)_');
  else {
    for (const f of auth.flows) {
      lines.push(`- **${f.name}**`);
      for (const step of f.steps) lines.push(`  1. ${step}`);
    }
  }
  lines.push('');

  lines.push('#### Middleware');
  lines.push(
    auth.middleware.trim() === ''
      ? 'On ANY role-fetch failure, redirect to `/login` ONLY â€” never render a default/wrong-role page (Iron Law 4).'
      : auth.middleware.trim()
  );
  lines.push('');
  lines.push('#### Multi-tenancy');
  lines.push(auth.multiTenancy.trim() === '' ? '_(not specified)_' : auth.multiTenancy.trim());
  lines.push('');
  lines.push('#### Permissions model');
  lines.push(auth.permissionsModel.trim() === '' ? '_(not specified)_' : auth.permissionsModel.trim());

  return lines.join('\n');
}

function renderInteractionSummary(maps: InteractionMap[]): string {
  if (maps.length === 0) return '_(no interaction maps â€” see INTERACTION_MAPS.md)_';
  const byFeature = new Map<string, number>();
  for (const m of maps) {
    const f = m.feature.trim() || '(unspecified)';
    byFeature.set(f, (byFeature.get(f) ?? 0) + 1);
  }
  const rows = [...byFeature.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return [
    `${maps.length} interaction map(s) across ${rows.length} feature(s). Full specs are in INTERACTION_MAPS.md.`,
    '',
    ...rows.map(([feature, count]) => `- **${feature}** â€” ${count} interactive element(s)`),
  ].join('\n');
}

const STANDARD_FORGE_CONTRACTS = [
  '**Company scoping:** every API route derives `company_id` from the authenticated session, never from the request body (Six Laws Law 2).',
  '**Role-fetch fallback:** any role-fetch failure redirects to `/login` only (Iron Law 4).',
  '**No mocks:** production code reads only real tables â€” no mock or placeholder data (Iron Law 8).',
  '**No-cache dashboards:** dashboard HTML is served via no-cache API routes, never from `public/` (Iron Law 5).',
  '**Quality gates:** `tsc --noEmit` â†’ build â†’ lint â†’ test must pass before any commit (Iron Laws 6-7).',
  '**Six Laws:** a feature is complete only when Schema, API, UI, Data, Wiring, and Verification all pass.',
];

function renderBehavioralContracts(design: ArchitectureDesign): Record<string, string> {
  return {
    API_CONTRACTS: renderApiContracts({ routes: design.api.routes, conventions: design.api.conventions }),
    AUTH_CONTRACTS: renderAuthContracts(design.auth),
    INTERACTION_SUMMARY: renderInteractionSummary(design.interactionMaps.maps),
    STANDARD_CONTRACTS: bullets(STANDARD_FORGE_CONTRACTS),
  };
}

// ---------------------------------------------------------------------------
// Section renderers â€” INTERACTION_MAPS.md
// ---------------------------------------------------------------------------

function renderInteractionMap(map: InteractionMap, index: number): string {
  return [
    `### ${index}. ${map.element || '(element)'}`,
    `- **User action:** ${map.userAction || 'â€”'}`,
    `- **Frontend reaction:** ${map.frontendReaction || 'â€”'}`,
    `- **API call:** ${code(map.apiCall)}`,
    `- **Backend processing:** ${map.backendProcessing || 'â€”'}`,
    `- **Database write:** ${code(map.dbWrite)}`,
    `- **Side effects:** ${inlineList(map.sideEffects)}`,
    `- **Success response:** ${map.successResponse || 'â€”'}`,
    `- **Error response:** ${map.errorResponse || 'â€”'}`,
    `- **Tracking event:** ${code(map.trackingEvent)}`,
  ].join('\n');
}

function renderInteractionMaps(maps: InteractionMap[]): Record<string, string> {
  if (maps.length === 0) {
    return { INTERACTION_MAPS: '_(no interaction maps were produced â€” Contract 18 expects one per interactive element)_' };
  }

  // Group by feature, preserving first-seen order.
  const groups = new Map<string, InteractionMap[]>();
  for (const m of maps) {
    const feature = m.feature.trim() || '(unspecified feature)';
    const list = groups.get(feature);
    if (list) list.push(m);
    else groups.set(feature, [m]);
  }

  const sections: string[] = [];
  for (const [feature, list] of groups) {
    sections.push(`## Feature: ${feature}`);
    sections.push(list.map((m, i) => renderInteractionMap(m, i + 1)).join('\n\n'));
  }
  return { INTERACTION_MAPS: sections.join('\n\n') };
}

// ---------------------------------------------------------------------------
// Section renderers â€” TESTING.md
// ---------------------------------------------------------------------------

/** Generate a runnable Playwright test scaffold for one spec. */
function playwrightCode(name: string, scenario: string): string {
  const safeName = (name || 'scenario').replace(/'/g, "\\'");
  const safeScenario = (scenario || 'TODO: specify scenario').replace(/\r?\n/g, ' ');
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    `test('${safeName}', async ({ page }) => {`,
    `  // Scenario: ${safeScenario}`,
    "  await page.goto('/');",
    `  // TODO: implement the steps for "${safeName}".`,
    '  await expect(page).toHaveURL(/.*/);',
    '});',
  ].join('\n');
}

function renderTesting(testing: TestingStrategy): Record<string, string> {
  const overview = [
    `- **Playwright specs:** ${testing.playwrightSpecs.length}`,
    `- **API test suites:** ${testing.apiTests.length}`,
    `- **Six Laws checks:** ${testing.sixLawsPlan.length}`,
    '',
    testing.markdown.trim() === '' ? '' : testing.markdown.trim(),
  ]
    .filter((s) => s !== '')
    .join('\n');

  const specs =
    testing.playwrightSpecs.length === 0
      ? '_(no Playwright specs designed)_'
      : testing.playwrightSpecs
          .map((s) => {
            const file = s.file.trim() === '' ? 'tests/e2e/spec.spec.ts' : s.file.trim();
            return [
              `### ${s.name || '(unnamed spec)'}`,
              `- **File:** \`${file}\``,
              `- **Scenario:** ${s.scenario || 'â€”'}`,
              '',
              '```ts',
              `// ${file}`,
              playwrightCode(s.name, s.scenario),
              '```',
            ].join('\n');
          })
          .join('\n\n');

  const apiTests =
    testing.apiTests.length === 0
      ? '_(no API test suites designed)_'
      : testing.apiTests
          .map((t) => [`### \`${t.route || '(route)'}\``, bullets(t.cases)].join('\n'))
          .join('\n\n');

  const sixLaws =
    testing.sixLawsPlan.length === 0
      ? '_(no Six Laws plan designed)_'
      : [
          '| Law | Verification |',
          '|-----|--------------|',
          ...testing.sixLawsPlan.map((c) => `| ${cell(c.law)} | ${cell(c.verification)} |`),
        ].join('\n');

  return {
    TEST_OVERVIEW: overview,
    PLAYWRIGHT_SPECS: specs,
    API_TESTS: apiTests,
    SIX_LAWS_PLAN: sixLaws,
  };
}

// ---------------------------------------------------------------------------
// Section renderers â€” STATE_OF_THE_BUILD.md & SESSION_STATE.md (post-audit)
// ---------------------------------------------------------------------------

function renderPhaseStatus(design: ArchitectureDesign, overrides: Phase2Options['phaseStatus']): string {
  const o = overrides ?? {};
  const phase1c: PhaseStatus = o.phase1c ?? (design.constrained ? 'complete' : 'not_applicable');
  const rows: Array<[string, string, PhaseStatus]> = [
    ['Phase 0', 'Toolchain Scout', o.phase0 ?? 'complete'],
    ['Phase 1A', 'PRD Generator', o.phase1a ?? 'complete'],
    ['Phase 1B', 'Architecture Engine', o.phase1b ?? 'complete'],
    ['Phase 1C', 'Current State Ingestion', phase1c],
    ['Phase 2', 'Governance Generator', o.phase2 ?? 'complete'],
    ['Phase 3', 'Build Executor', 'pending'],
    ['Phase 4', 'Sentinel', 'pending'],
    ['Phase 5', 'Recursive Learner', 'pending'],
  ];
  return [
    '| Phase | Name | Status |',
    '|-------|------|--------|',
    ...rows.map(([id, name, status]) => `| ${id} | ${name} | ${status} |`),
  ].join('\n');
}

function renderDesignSummary(design: ArchitectureDesign): string {
  const d = design;
  const critical = d.crossValidation.filter((v) => v.severity === 'critical').length;
  const lines = [
    `- **Tables:** ${d.database.tables.length}`,
    `- **API routes:** ${d.api.routes.length}`,
    `- **Pages / components:** ${d.frontend.pages.length} / ${d.frontend.components.length}`,
    `- **Interaction maps:** ${d.interactionMaps.maps.length}`,
    `- **Roles:** ${d.auth.roles.length}`,
    `- **Agents:** ${d.agents.agents.length}`,
    `- **Cross-validation issues:** ${d.crossValidation.length} (${critical} critical)`,
    `- **Design used fallback artifacts:** ${d.usedFallback ? `yes â€” ${d.fallbackArtifacts.join(', ')}` : 'no'}`,
  ];
  return lines.join('\n');
}

function renderGovernancePackageSection(results: readonly GovernanceDocResult[]): string {
  const rows = results.map(
    (r) =>
      `| ${r.name} | ${r.path === null ? '_(not written)_' : 'âœ“'} | \`${r.contentHash.slice(0, 12)}\` | ${r.bytes} |`
  );
  return [
    '| Document | Written | Content hash (sha256, first 12) | Bytes |',
    '|----------|---------|----------------------------------|-------|',
    ...rows,
  ].join('\n');
}

function renderCodebaseAudit(snapshot: CodebaseSnapshot): string {
  const s = snapshot.stats;
  const govDocs = snapshot.governanceDocs.map((d) => d.name);
  return [
    `- **Total files:** ${s.totalFiles}`,
    `- **Total lines:** ${s.totalLines}`,
    `- **Directories:** ${s.totalDirectories}`,
    `- **Source files (ts/tsx/js/jsx):** ${s.sourceFiles}`,
    `- **Tables found in migrations:** ${snapshot.schema.length}`,
    `- **Routes found:** ${snapshot.routes.length}`,
    `- **Dependencies declared:** ${snapshot.dependencies.length}`,
    `- **Governance documents present:** ${govDocs.length === 0 ? 'none' : govDocs.join(', ')}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Hashing & writing
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of a string (Contract 6 â€” content hashing for governance versions). */
function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Embedded fallback templates (identical to templates/governance/*.template.md)
// ---------------------------------------------------------------------------

/**
 * Used only when a template file under `templatesDir` cannot be read. Keeping these in
 * sync with the on-disk templates guarantees the phase still renders a complete package
 * even when the templates directory is missing or misresolved.
 */
const EMBEDDED_TEMPLATES: Record<GovernanceDocName, string> = {
  'BLUEPRINT.md': [
    '# {{PROJECT_NAME}} â€” BLUEPRINT',
    '',
    '> Generated by FORGE 2.0 Phase 2 (Governance Generator) on {{GENERATED_AT}}.',
    '',
    '## System Identity',
    '- **Name:** {{PROJECT_NAME}}',
    '- **Generated:** {{GENERATED_AT}}',
    '- **Build mode:** {{BUILD_MODE}}',
    '',
    '## System Overview',
    '{{SYSTEM_OVERVIEW}}',
    '',
    '## Technology Stack',
    '{{TECH_STACK}}',
    '',
    '## Architecture Overview',
    '{{ARCHITECTURE_OVERVIEW}}',
    '',
    '## Project Structure',
    '{{PROJECT_STRUCTURE}}',
    '',
    '## Environment Variables',
    '{{ENVIRONMENT_VARIABLES}}',
    '',
    '## Canonical Rules',
    '{{CANONICAL_RULES}}',
    '',
  ].join('\n'),
  'SCHEMA_REGISTRY.md': [
    '# {{PROJECT_NAME}} â€” SCHEMA REGISTRY',
    '',
    '> Generated by FORGE 2.0 Phase 2 on {{GENERATED_AT}}.',
    '',
    '## Database',
    '{{DATABASE_OVERVIEW}}',
    '',
    '## Tables',
    '{{TABLES}}',
    '',
    '## Indexes',
    '{{INDEXES}}',
    '',
    '## Row-Level Security Policies',
    '{{RLS_POLICIES}}',
    '',
    '## Seed Data',
    '{{SEED_DATA}}',
    '',
    '## Migrations',
    '{{MIGRATIONS}}',
    '',
  ].join('\n'),
  'AGENTS.md': [
    '# {{PROJECT_NAME}} â€” AGENTS',
    '',
    '> Generated by FORGE 2.0 Phase 2 on {{GENERATED_AT}}.',
    '',
    '## Orchestration',
    '{{ORCHESTRATION}}',
    '',
    '## Agent Definitions',
    '{{AGENTS}}',
    '',
  ].join('\n'),
  'BEHAVIORAL_CONTRACTS.md': [
    '# {{PROJECT_NAME}} â€” BEHAVIORAL CONTRACTS',
    '',
    '> Generated by FORGE 2.0 Phase 2 on {{GENERATED_AT}}.',
    '',
    '## API Contracts',
    '{{API_CONTRACTS}}',
    '',
    '## Authentication & Authorization',
    '{{AUTH_CONTRACTS}}',
    '',
    '## Interaction Contracts (summary)',
    '{{INTERACTION_SUMMARY}}',
    '',
    '## Standard FORGE Contracts',
    '{{STANDARD_CONTRACTS}}',
    '',
  ].join('\n'),
  'INTERACTION_MAPS.md': [
    '# {{PROJECT_NAME}} â€” INTERACTION MAPS',
    '',
    '> Generated by FORGE 2.0 Phase 2 on {{GENERATED_AT}}.',
    '',
    '{{INTERACTION_MAPS}}',
    '',
  ].join('\n'),
  'TESTING.md': [
    '# {{PROJECT_NAME}} â€” TESTING',
    '',
    '> Generated by FORGE 2.0 Phase 2 on {{GENERATED_AT}}.',
    '',
    '## Test Plan Overview',
    '{{TEST_OVERVIEW}}',
    '',
    '## Playwright Specifications',
    '{{PLAYWRIGHT_SPECS}}',
    '',
    '## API Tests',
    '{{API_TESTS}}',
    '',
    '## Six Laws Verification Plan',
    '{{SIX_LAWS_PLAN}}',
    '',
  ].join('\n'),
  'STATE_OF_THE_BUILD.md': [
    '# {{PROJECT_NAME}} â€” STATE OF THE BUILD',
    '',
    '> Generated by FORGE 2.0 Phase 2 on {{GENERATED_AT}}. Updated from a live codebase audit.',
    '',
    '## Phase Status',
    '{{PHASE_STATUS}}',
    '',
    '## Design Summary',
    '{{DESIGN_SUMMARY}}',
    '',
    '## Governance Package',
    '{{GOVERNANCE_PACKAGE}}',
    '',
    '## Codebase Audit',
    '{{CODEBASE_AUDIT}}',
    '',
    '## Next Step',
    '{{NEXT_STEP}}',
    '',
  ].join('\n'),
  'SESSION_STATE.md': [
    '# {{PROJECT_NAME}} â€” SESSION STATE',
    '',
    '> Generated by FORGE 2.0 Phase 2 on {{GENERATED_AT}}. Initialized empty.',
    '',
    '- **Current phase:** {{CURRENT_PHASE}}',
    '- **Current prompt:** {{CURRENT_PROMPT}}',
    '- **Completed prompts:** {{COMPLETED_PROMPTS}}',
    '- **Failed prompts:** {{FAILED_PROMPTS}}',
    '- **Last updated:** {{GENERATED_AT}}',
    '',
    '## Active Build',
    '{{ACTIVE_BUILD}}',
    '',
    '## IDE STATUS',
    '',
    '- **VS Code path:** {{IDE_VSCODE_PATH}}',
    '- **CHANGESET.md reviewed:** {{IDE_CHANGESET_REVIEWED}}',
    '- **Last changeset date:** {{IDE_LAST_CHANGESET_DATE}}',
    '',
    '## Notes',
    '{{SESSION_NOTES}}',
    '',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// Template loading (disk first, embedded fallback)
// ---------------------------------------------------------------------------

interface LoadedTemplate {
  template: string;
  source: string;
}

/** Read a template from disk, degrading to the embedded fallback (with a warning) on failure. */
async function loadTemplate(
  doc: GovernanceDocName,
  templatesDir: string,
  warnings: string[]
): Promise<LoadedTemplate> {
  const file = join(templatesDir, templateFileFor(doc));
  try {
    const template = await readFile(file, 'utf8');
    return { template, source: file };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(`Template ${templateFileFor(doc)} unreadable (${reason}); used the embedded fallback.`);
    return { template: EMBEDDED_TEMPLATES[doc], source: '(embedded fallback)' };
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 2 against `projectPath`, rendering the approved {@link ArchitectureDesign}
 * into the complete governance package and writing it to the target project's governance
 * directory. Then HALTS for Gate 3 (Contract 2).
 *
 * Always resolves (never rejects). Each document is rendered from its template (disk â†’
 * embedded fallback), hashed, written (guarded), and recorded in Build Memory (guarded,
 * Contract 6). The two state documents are populated from a LIVE codebase audit run after
 * the design documents are written (Canonical Rule 9).
 */
export async function runPhase2Governance(
  projectPath: string,
  design: ArchitectureDesign,
  options: Phase2Options = {}
): Promise<GovernancePackage> {
  const log = options.log ?? logLine('phase2');
  const projectName = options.projectName ?? design.projectName ?? basename(projectPath) ?? 'project';
  const governanceDirName = options.governanceDirName ?? 'governance';
  const templatesDir = options.templatesDir ?? defaultTemplatesDir();
  const writeFiles = options.writeFiles ?? true;
  const recordVersions = options.recordVersions ?? true;
  const governanceDir = join(projectPath, governanceDirName);
  const generatedAt = nowIso();
  const buildMode = design.constrained ? 'partial build (extending an existing codebase)' : 'greenfield';
  const warnings: string[] = [...design.warnings];

  log(`rendering governance package for "${projectName}" â†’ ${governanceDir}`);

  // 0. CrossProjectKnowledgeTransfer (LEARNING_BLUEPRINT.md § Agent: CrossProjectKnowledgeTransfer)
  // — pre-step PUSH of stack-compatible, non-retired insights from prior builds, injected into
  // BLUEPRINT.md's system overview. Guarded: no stack fingerprint or an unreachable Build Memory
  // degrades to no injection (Contract 4); this call never throws here (it only throws for the
  // explicit single-source `--build-id` CLI path, not used on this automatic pre-step).
  let crossProjectTransferBlock = '';
  if (options.stackFingerprint) {
    try {
      const memoryDb = BuildMemory.getClient();
      if (memoryDb) {
        const transfer = transferKnowledge(projectPath, options.stackFingerprint, memoryDb);
        crossProjectTransferBlock = transfer.contextBlock;
        log(
          `CrossProjectKnowledgeTransfer: ${transfer.transferred} insight(s) transferred ` +
            `(${transfer.skippedIncompatible} incompatible, ${transfer.skippedRetired} retired)`
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`CrossProjectKnowledgeTransfer skipped (${reason}).`);
      log(`WARNING: CrossProjectKnowledgeTransfer skipped (${reason})`);
    }
  }

  // Shared placeholders present in every document.
  const common: Record<string, string> = {
    PROJECT_NAME: projectName,
    GENERATED_AT: generatedAt,
    BUILD_MODE: buildMode,
  };

  // Per-document variable sets for the six DESIGN documents.
  const designVars: Record<GovernanceDocName, Record<string, string>> = {
    'BLUEPRINT.md': { ...common, ...renderBlueprint(design, options.stackFingerprint, crossProjectTransferBlock) },
    'SCHEMA_REGISTRY.md': { ...common, ...renderSchemaRegistry(design.database) },
    'AGENTS.md': { ...common, ...renderAgents(design.agents) },
    'BEHAVIORAL_CONTRACTS.md': { ...common, ...renderBehavioralContracts(design) },
    'INTERACTION_MAPS.md': { ...common, ...renderInteractionMaps(design.interactionMaps.maps) },
    'TESTING.md': { ...common, ...renderTesting(design.testing) },
    // State docs are rendered after the audit, below.
    'STATE_OF_THE_BUILD.md': common,
    'SESSION_STATE.md': common,
  };

  // 1. Ensure the target governance directory exists (guarded).
  if (writeFiles) {
    try {
      await mkdir(governanceDir, { recursive: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Could not create governance directory ${governanceDir} (${reason}); writes will fail.`);
      log(`WARNING: could not create ${governanceDir} (${reason})`);
    }
  }

  // 2. Render + write the six DESIGN documents.
  const results: InternalDocResult[] = [];
  for (const doc of DESIGN_DOCS) {
    const result = await renderAndWrite(doc, designVars[doc], { templatesDir, governanceDir, writeFiles, warnings, log });
    results.push(result);
  }

  // 3. Live codebase audit (Canonical Rule 9) â€” runs AFTER the design docs are on disk.
  log('running live codebase audit for the state documents');
  const snapshot = await readCodebase(projectPath);

  // 4. Render the two STATE documents from the audit + the design-doc results.
  designVars['STATE_OF_THE_BUILD.md'] = {
    ...common,
    PHASE_STATUS: renderPhaseStatus(design, options.phaseStatus),
    DESIGN_SUMMARY: renderDesignSummary(design),
    GOVERNANCE_PACKAGE: renderGovernancePackageSection(results),
    CODEBASE_AUDIT: renderCodebaseAudit(snapshot),
    NEXT_STEP:
      'Phase 2 complete. The build HALTS here for **Gate 3** (human governance approval, Contract 2). ' +
      'Once approved, Phase 2 s4-p02 (Queue Generator) produces queue.yaml, then Phase 3 (Build Executor) begins.',
  };
  designVars['SESSION_STATE.md'] = {
    ...common,
    CURRENT_PHASE: 'Phase 2 complete â€” awaiting Gate 3 approval',
    CURRENT_PROMPT: 'none (Phase 3 has not started)',
    COMPLETED_PROMPTS: '0',
    FAILED_PROMPTS: '0',
    ACTIVE_BUILD: 'none â€” no build is executing yet',
    IDE_VSCODE_PATH: detectVsCodePath() ?? 'not detected',
    IDE_CHANGESET_REVIEWED: 'NO',
    IDE_LAST_CHANGESET_DATE: 'none yet',
    SESSION_NOTES: 'Initialized empty by Phase 2 (Governance Generator). Phase 3 updates this after every prompt.',
  };

  for (const doc of STATE_DOCS) {
    const result = await renderAndWrite(doc, designVars[doc], { templatesDir, governanceDir, writeFiles, warnings, log });
    results.push(result);
  }

  // 5. Record a governance_versions row per document in Build Memory (Contract 6; guarded).
  if (recordVersions) {
    for (const result of results) {
      const content = result.renderedContent;
      const row = await BuildMemory.governance.createVersion({
        template_name: result.name,
        content_hash: result.contentHash,
        content_snapshot: content,
        change_source: 'manual',
      });
      result.versionRecorded = row !== null;
    }
    const recorded = results.filter((r) => r.versionRecorded).length;
    if (recorded < results.length) {
      warnings.push(`Build Memory recorded ${recorded}/${results.length} governance versions (stateless degrade â€” Contract 4).`);
    }
    log(`Build Memory: recorded ${recorded}/${results.length} governance version(s)`);
  }

  // 6. Assemble the result. Strip the internal `renderedContent` from the public shape.
  const documents: GovernanceDocResult[] = results.map((r) => ({
    name: r.name,
    path: r.path,
    contentHash: r.contentHash,
    bytes: r.bytes,
    templateSource: r.templateSource,
    versionRecorded: r.versionRecorded,
    missingPlaceholders: r.missingPlaceholders,
  }));

  const pkg: GovernancePackage = {
    projectName,
    governanceDir,
    documents,
    audit: {
      totalFiles: snapshot.stats.totalFiles,
      totalLines: snapshot.stats.totalLines,
      totalDirectories: snapshot.stats.totalDirectories,
      sourceFiles: snapshot.stats.sourceFiles,
      tablesFound: snapshot.schema.length,
      routesFound: snapshot.routes.length,
      governanceDocsFound: snapshot.governanceDocs.length,
    },
    constrained: design.constrained,
    warnings,
    gate: {
      name: 'Gate 3 -- Governance Approval',
      status: 'awaiting_human_approval',
      detail:
        'Phase 2 complete. The build HALTS here until a human approves the governance package ' +
        '(BEHAVIORAL_CONTRACTS Contract 2). The Queue Generator (s4-p02) and Phase 3 must not start before approval.',
    },
    generatedAt,
  };

  const written = documents.filter((d) => d.path !== null).length;
  const missing = documents.reduce((n, d) => n + d.missingPlaceholders.length, 0);
  log(
    `Phase 2 complete â€” ${written}/${documents.length} document(s) written to ${governanceDir}` +
      `${missing > 0 ? `; ${missing} unfilled placeholder(s)` : ''}. HALT for Gate 3 (human governance approval required).`
  );

  return pkg;
}

// ---------------------------------------------------------------------------
// Per-document render + write (internal)
// ---------------------------------------------------------------------------

/** A {@link GovernanceDocResult} plus the rendered content (kept internal for versioning). */
interface InternalDocResult extends GovernanceDocResult {
  renderedContent: string;
}

interface RenderWriteContext {
  templatesDir: string;
  governanceDir: string;
  writeFiles: boolean;
  warnings: string[];
  log: (message: string) => void;
}

/** Load the template, substitute placeholders, write the document, and hash it. */
async function renderAndWrite(
  doc: GovernanceDocName,
  vars: Record<string, string>,
  ctx: RenderWriteContext
): Promise<InternalDocResult> {
  const { template, source } = await loadTemplate(doc, ctx.templatesDir, ctx.warnings);
  const applied = applyTemplate(template, vars);
  const missing = applied.missing;
  const content = toAsciiGovernanceText(applied.content);
  const contentHash = sha256(content);
  const bytes = Buffer.byteLength(content, 'utf8');

  if (missing.length > 0) {
    ctx.warnings.push(`${doc}: ${missing.length} unfilled placeholder(s): ${missing.join(', ')}.`);
  }

  let path: string | null = null;
  if (ctx.writeFiles) {
    const target = join(ctx.governanceDir, doc);
    try {
      await writeFile(target, content, 'utf8');
      path = target;
      ctx.log(`wrote ${doc} (${bytes} bytes)`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.warnings.push(`Failed to write ${doc} (${reason}).`);
      ctx.log(`WARNING: could not write ${doc} (${reason})`);
    }
  }

  return {
    name: doc,
    path,
    contentHash,
    bytes,
    templateSource: source,
    versionRecorded: false,
    missingPlaceholders: missing,
    renderedContent: content,
  };
}

export default runPhase2Governance;

