/**
 * FORGE 2.0 — Queue Generator unit test (Sprint 4, s4-p02).
 *
 * The Queue Generator is pure and deterministic (no model calls, no database), so this
 * test exercises it entirely in-process against a hand-built {@link ArchitectureDesign}
 * fixture. It does NOT require the Docker Supabase stack.
 *
 * It asserts the queue.yaml contract from queue.yaml s4-p02:
 *   1. Standard build order (schema → auth → api → ui → features → agents → … → deploy → verify).
 *   2. Every entry has id, name, prompt_type, dependencies[], governance_refs[],
 *      estimated_tokens, context_injection, and a description.
 *   3. Dependencies reference real, earlier ids (no dangling / forward references).
 *   4. Independent siblings (e.g. multiple API resources, multiple feature pages) share a
 *      parallel_group.
 *   5. Context-injection markers are populated from the design.
 *   6. The serialized YAML round-trips through js-yaml back to the same logical entries.
 *   7. A degenerate (empty) design still yields a valid, short queue (never throws).
 *
 * HOW TO RUN
 *     node --import tsx --test tests/queue-generator.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load as parseYaml } from 'js-yaml';

import {
  buildQueueEntries,
  serializeQueue,
  generateQueue,
  type QueueEntry,
} from '../src/engine/queue-generator.js';
import type { ArchitectureDesign } from '../src/phases/phase1b-architect.js';

// ---------------------------------------------------------------------------
// Fixture: a small but representative design (2 API resources, 2 feature pages,
// 1 dashboard, 1 settings page, 1 agent, tenant-scoped tables, auth roles).
// ---------------------------------------------------------------------------

function makeDesign(): ArchitectureDesign {
  return {
    projectName: 'acme',
    database: {
      tables: [
        {
          name: 'companies',
          schema: 'public',
          purpose: 'Tenant root',
          columns: [{ name: 'id', type: 'uuid', nullable: false, default: null, constraints: ['pk'] }],
          primaryKey: ['id'],
          foreignKeys: [],
          rlsEnabled: true,
          tenantScoped: false,
          immutable: false,
        },
        {
          name: 'projects',
          schema: 'public',
          purpose: 'Company projects',
          columns: [
            { name: 'id', type: 'uuid', nullable: false, default: null, constraints: ['pk'] },
            { name: 'company_id', type: 'uuid', nullable: false, default: null, constraints: [] },
          ],
          primaryKey: ['id'],
          foreignKeys: [
            { columns: ['company_id'], referencesTable: 'companies', referencesColumns: ['id'], onDelete: 'cascade' },
          ],
          rlsEnabled: true,
          tenantScoped: true,
          immutable: false,
        },
      ],
      indexes: [{ name: 'idx_projects_company', table: 'projects', columns: ['company_id'], unique: false, method: null, where: null }],
      rlsPolicies: [{ name: 'projects_tenant', table: 'projects', command: 'all', roles: ['authenticated'], using: 'company_id = auth.company_id()', check: null }],
      seeds: [],
      migrations: [{ filename: '001_init.sql', description: 'initial schema' }],
      markdown: '',
    },
    api: {
      routes: [
        { path: '/api/projects', method: 'GET', purpose: 'List projects', authRequired: true, roles: ['member'], requestSchema: '', responseSchema: 'Project[]', dbReads: ['projects'], dbWrites: [], errors: [], immutable: false },
        { path: '/api/projects', method: 'POST', purpose: 'Create project', authRequired: true, roles: ['admin'], requestSchema: '{name}', responseSchema: 'Project', dbReads: [], dbWrites: ['projects'], errors: [], immutable: false },
        { path: '/api/members', method: 'GET', purpose: 'List members', authRequired: true, roles: ['admin'], requestSchema: '', responseSchema: 'Member[]', dbReads: ['companies'], dbWrites: [], errors: [], immutable: false },
      ],
      conventions: [],
      markdown: '',
    },
    frontend: {
      pages: [
        { path: '/projects', name: 'Projects', purpose: 'Project list', components: ['ProjectTable'], apiCalls: ['/api/projects'], authRequired: true, roles: ['member'], immutable: false },
        { path: '/members', name: 'Members', purpose: 'Member list', components: ['MemberTable'], apiCalls: ['/api/members'], authRequired: true, roles: ['admin'], immutable: false },
        { path: '/dashboard', name: 'Dashboard', purpose: 'Overview', components: ['Stats'], apiCalls: ['/api/projects'], authRequired: true, roles: ['member'], immutable: false },
        { path: '/settings', name: 'Settings', purpose: 'Account settings', components: ['SettingsForm'], apiCalls: [], authRequired: true, roles: ['admin'], immutable: false },
      ],
      components: [{ name: 'ProjectTable', type: 'component', description: '' }, { name: 'MemberTable', type: 'component', description: '' }],
      layouts: [{ name: 'AppLayout', description: '', appliesTo: ['/'] }],
      designTokens: { colors: {}, typography: {}, spacing: {}, radii: {}, shadows: {} },
      responsiveStrategy: 'mobile-first',
      markdown: '',
    },
    interactionMaps: {
      maps: [
        { feature: 'Projects', element: 'Create button', userAction: 'click', frontendReaction: 'open modal', apiCall: '/api/projects', backendProcessing: 'insert', dbWrite: 'projects', sideEffects: [], successResponse: 'toast', errorResponse: 'error', trackingEvent: 'project_created' },
      ],
      markdown: '',
    },
    auth: {
      flows: [{ name: 'Email login', steps: ['enter email', 'verify'] }],
      roles: [{ name: 'admin', description: '', permissions: [] }, { name: 'member', description: '', permissions: [] }],
      middleware: '',
      multiTenancy: 'company_id scoping',
      permissionsModel: 'rbac',
      markdown: '',
    },
    agents: {
      agents: [{ name: 'Digest', purpose: 'weekly digest', trigger: 'cron', inputContract: 'company_id', outputContract: 'email', systemPrompt: 'You summarize.', model: 'claude-sonnet-4-6', tokenBudget: 4000 }],
      orchestration: '',
      markdown: '',
    },
    infra: {
      environments: [{ name: 'production', description: '', variables: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] }],
      deployConfig: 'vercel',
      monitoring: '',
      performanceBudgets: [],
      markdown: '',
    },
    testing: {
      playwrightSpecs: [{ name: 'projects flow', file: 'tests/projects.spec.ts', scenario: 'create a project' }],
      apiTests: [{ route: '/api/projects', cases: ['200 on list'] }],
      sixLawsPlan: [],
      markdown: '',
    },
    crossValidation: [],
    constrained: false,
    designSystemGenerated: false,
    designSystemPath: null,
    architecturePath: null,
    model: 'claude-sonnet-4-6',
    tokensInput: 0,
    tokensOutput: 0,
    usedFallback: false,
    fallbackArtifacts: [],
    warnings: [],
    gate: { name: 'Gate 2 — Architecture Approval', status: 'awaiting_human_approval', detail: '' },
    generatedAt: '2026-06-11T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('every entry has the required fields and a valid prompt_type', () => {
  const entries = buildQueueEntries(makeDesign());
  assert.ok(entries.length > 0, 'expected a non-empty queue');
  const valid = new Set(['schema', 'auth', 'api', 'ui', 'feature', 'agent', 'test', 'deploy']);
  for (const e of entries) {
    assert.ok(e.id && typeof e.id === 'string', `entry missing id: ${JSON.stringify(e)}`);
    assert.ok(e.name && typeof e.name === 'string', `entry ${e.id} missing name`);
    assert.ok(valid.has(e.prompt_type), `entry ${e.id} has bad prompt_type ${e.prompt_type}`);
    assert.ok(Array.isArray(e.dependencies), `entry ${e.id} missing dependencies`);
    assert.ok(Array.isArray(e.governance_refs) && e.governance_refs.length > 0, `entry ${e.id} missing governance_refs`);
    assert.ok(e.estimated_tokens >= 2000, `entry ${e.id} estimate too low`);
    assert.ok(e.context_injection, `entry ${e.id} missing context_injection`);
    assert.ok(e.description.includes('Update STATE_OF_THE_BUILD.md'), `entry ${e.id} missing state footer`);
  }
});

test('ids are unique and dependencies reference earlier, real ids', () => {
  const entries = buildQueueEntries(makeDesign());
  const seen = new Set<string>();
  for (const e of entries) {
    assert.ok(!seen.has(e.id), `duplicate id ${e.id}`);
    for (const dep of e.dependencies) {
      assert.ok(seen.has(dep), `entry ${e.id} depends on ${dep} which is not defined earlier (no forward refs)`);
    }
    seen.add(e.id);
  }
});

test('standard build order: schema before auth before api before ui before features; deploy then verify last', () => {
  const entries = buildQueueEntries(makeDesign());
  const firstIndexOfType = (t: string) => entries.findIndex((e) => e.prompt_type === t);
  const schema = firstIndexOfType('schema');
  const auth = firstIndexOfType('auth');
  const api = firstIndexOfType('api');
  const ui = firstIndexOfType('ui');
  const feature = firstIndexOfType('feature');
  assert.ok(schema >= 0 && schema < auth, 'schema must come before auth');
  assert.ok(auth < api, 'auth must come before api');
  assert.ok(api < ui, 'api must come before ui');
  assert.ok(ui < feature, 'ui must come before features');
  // Deploy is second-to-last; the final entry is the Six Laws verification.
  const deployIdx = entries.findIndex((e) => e.prompt_type === 'deploy');
  const last = entries[entries.length - 1];
  assert.ok(last !== undefined && last.id === 'verify-six-laws', 'verify must be the final entry');
  assert.ok(deployIdx === entries.length - 2, 'deploy must be immediately before verify');
});

test('independent siblings share a parallel_group (api resources, feature pages)', () => {
  const entries = buildQueueEntries(makeDesign());
  const apiEntries = entries.filter((e) => e.prompt_type === 'api');
  assert.equal(apiEntries.length, 2, 'expected two API resource groups (projects, members)');
  for (const e of apiEntries) assert.equal(e.parallel_group, 'api-routes', `api entry ${e.id} should be in api-routes group`);

  // The two non-dashboard/settings feature pages depend on [their api, ui-shell].
  const features = entries.filter((e) => e.id.startsWith('feature-'));
  assert.ok(features.length >= 2, 'expected at least two feature pages');
  const grouped = features.filter((e) => e.parallel_group === 'features');
  assert.ok(grouped.length >= 2, 'independent feature pages should share the "features" group');
});

test('context_injection is populated from the design', () => {
  const entries = buildQueueEntries(makeDesign());
  const schema = entries.find((e) => e.prompt_type === 'schema');
  assert.ok(schema, 'schema entry exists');
  assert.deepEqual(schema.context_injection.schemaSections, ['companies', 'projects']);

  const projectsFeature = entries.find((e) => e.id === 'feature-projects');
  assert.ok(projectsFeature, 'projects feature entry exists');
  assert.ok(
    projectsFeature.context_injection.interactionMaps.includes('Projects: Create button'),
    'feature should inject its matching interaction map'
  );
  assert.ok(
    projectsFeature.context_injection.schemaSections.includes('projects'),
    'feature should inject the table it touches'
  );
});

test('serialized YAML round-trips through js-yaml to the same logical entries', () => {
  const design = makeDesign();
  const entries = buildQueueEntries(design);
  const yaml = serializeQueue(entries, {
    projectName: 'acme',
    projectPath: 'C:/tmp/acme',
    generatedAt: '2026-06-11T00:00:00.000Z',
    stats: { totalPrompts: entries.length, byType: {} as never, parallelGroups: 0, totalEstimatedTokens: 0, longestChain: 0 },
  });
  const parsed = parseYaml(yaml) as QueueEntry[];
  assert.ok(Array.isArray(parsed), 'parsed YAML must be an array');
  assert.equal(parsed.length, entries.length, 'entry count must survive the round-trip');
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i]!;
    const b = parsed[i]!;
    assert.equal(b.id, a.id, `id mismatch at ${i}`);
    assert.equal(b.prompt_type, a.prompt_type, `prompt_type mismatch at ${a.id}`);
    assert.deepEqual(b.dependencies, a.dependencies, `dependencies mismatch at ${a.id}`);
    assert.equal(b.estimated_tokens, a.estimated_tokens, `estimated_tokens mismatch at ${a.id}`);
  }
});

test('a degenerate (empty) design still yields a valid, short queue without throwing', () => {
  const empty: ArchitectureDesign = {
    ...makeDesign(),
    database: { tables: [], indexes: [], rlsPolicies: [], seeds: [], migrations: [], markdown: '' },
    api: { routes: [], conventions: [], markdown: '' },
    frontend: { pages: [], components: [], layouts: [], designTokens: { colors: {}, typography: {}, spacing: {}, radii: {}, shadows: {} }, responsiveStrategy: '', markdown: '' },
    interactionMaps: { maps: [], markdown: '' },
    auth: { flows: [], roles: [], middleware: '', multiTenancy: '', permissionsModel: '', markdown: '' },
    agents: { agents: [], orchestration: '', markdown: '' },
    testing: { playwrightSpecs: [], apiTests: [], sixLawsPlan: [], markdown: '' },
  };
  const warnings: string[] = [];
  const entries = buildQueueEntries(empty, warnings);
  // Even an empty design produces at least the deploy + verify tail.
  assert.ok(entries.length >= 2, 'expected at least deploy + verify');
  const ids = entries.map((e) => e.id);
  assert.ok(ids.includes('deploy') && ids.includes('verify-six-laws'), 'deploy + verify always present');
  assert.ok(warnings.some((w) => w.includes('no tables')), 'should warn about the missing schema stage');
});

test('generateQueue (dry, writeFile=false) returns a plan with stats and a Gate 3 halt', async () => {
  const plan = await generateQueue('C:/tmp/acme', makeDesign(), { writeFile: false, log: () => {} });
  assert.equal(plan.queuePath, null, 'dry run should not write a file');
  assert.ok(plan.yaml.includes('FORGE 2.0 Build Queue'), 'yaml header present');
  assert.equal(plan.stats.totalPrompts, plan.entries.length, 'stats count matches entries');
  assert.ok(plan.stats.longestChain >= 4, 'expected a multi-stage dependency chain');
  assert.equal(plan.gate.status, 'awaiting_human_approval', 'must halt for Gate 3');
});
