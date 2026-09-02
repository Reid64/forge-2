/**
 * FORGE 2.0 — Architecture Guard tests (pure `node:test`; no disk, no DB).
 *
 * Covers the parsers (`parseImports`/`parseExports`), specifier resolution + the module dependency
 * graph + cycle detection (`buildDependencyGraph`/`findCycles`), the pure helpers (`caseStyleOf`,
 * `normalizeForDup`, `isApiRouteFile`, `countBySeverity`), every detector via the `runArchitectureGuard`
 * orchestrator over an in-memory `GuardFs` with a capturing store (circular deps block; god component;
 * duplicate logic; N+1 in an API route; missing error boundary; hardcoded URL; dead code; `as any`),
 * the non-fatal/empty-project SKIP, severity overrides, and the Phase 4 Sentinel integration (the
 * optional eleventh check: opt-in, a high-severity violation fails the gate, non-high passes, the
 * default nine-check path is untouched).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runArchitectureGuard,
  parseImports,
  parseExports,
  parseNamedList,
  resolveSpecifier,
  buildDependencyGraph,
  findCycles,
  caseStyleOf,
  normalizeForDup,
  isApiRouteFile,
  countBySeverity,
  DEFAULT_SEVERITY,
  type GuardFs,
  type ParsedFile,
  type ArchStoredRecord,
  type ArchitectureReport,
  type ArchitectureGuardInput,
} from '../src/tools/architecture-guard.js';
import { runSentinel, type CommandResult } from '../src/phases/phase4-sentinel.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An in-memory GuardFs over a { relPath → content } map (paths joined onto projectPath). */
function memFs(root: string, files: Record<string, string>): GuardFs {
  const abs = (rel: string): string => `${root}/${rel}`.replace(/\/+/g, '/');
  const byAbs = new Map(Object.entries(files).map(([rel, content]) => [abs(rel), content]));
  return {
    async listFiles(): Promise<string[]> {
      return [...byAbs.keys()];
    },
    async readFile(p: string): Promise<string | null> {
      return byAbs.get(p.replace(/\\/g, '/')) ?? null;
    },
  };
}

/** A capturing store so tests can assert the Build-Memory write without a DB. */
function capturingStore(): { records: ArchStoredRecord[]; store: (r: ArchStoredRecord) => Promise<void> } {
  const records: ArchStoredRecord[] = [];
  return {
    records,
    store: async (r: ArchStoredRecord): Promise<void> => {
      records.push(r);
    },
  };
}

/** Run the guard over an in-memory project. */
async function guard(
  files: Record<string, string>,
  input: Partial<ArchitectureGuardInput> = {},
  extra: { severityOverrides?: Parameters<typeof runArchitectureGuard>[1]['severityOverrides']; godMax?: number } = {}
): Promise<{ report: ArchitectureReport; records: ArchStoredRecord[] }> {
  const cap = capturingStore();
  const report = await runArchitectureGuard(
    { projectPath: '/proj', projectName: 'proj', ...input },
    {
      fs: memFs('/proj', files),
      storeResult: async (r) => cap.store(r),
      now: () => 'T',
      log: () => {},
      ...(extra.severityOverrides ? { severityOverrides: extra.severityOverrides } : {}),
      ...(extra.godMax ? { godComponentMaxLines: extra.godMax } : {}),
    }
  );
  return { report, records: cap.records };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

test('parseImports: default / named / namespace / side-effect / re-export / dynamic', () => {
  const src = [
    `import Foo from './foo.js';`,
    `import { a, b as c } from './bar.js';`,
    `import * as ns from './ns.js';`,
    `import './side.js';`,
    `export { x } from './re.js';`,
    `export * from './star.js';`,
    `const m = await import('./dyn.js');`,
  ].join('\n');
  const refs = parseImports(src);
  const bySpec = new Map(refs.map((r) => [r.specifier, r]));
  assert.deepEqual(bySpec.get('./foo.js')?.names, ['Foo']);
  assert.deepEqual(bySpec.get('./bar.js')?.names, ['a', 'b']);
  assert.equal(bySpec.get('./ns.js')?.namespace, true);
  assert.ok(bySpec.has('./side.js'));
  assert.deepEqual(bySpec.get('./re.js')?.names, ['x']);
  assert.equal(bySpec.get('./star.js')?.namespace, true);
  assert.ok(bySpec.has('./dyn.js'));
});

test('parseNamedList: strips aliases and `type` modifiers', () => {
  assert.deepEqual(parseNamedList('a, b as c, type T, d'), ['a', 'b', 'd']);
});

test('parseExports: function / class / arrow-const / default / type', () => {
  const lines = [
    `export function alpha() {}`,
    `export const beta = (x: number) => x;`,
    `export class Gamma {}`,
    `export const delta = 3;`,
    `export default function main() {}`,
    `export type Eps = string;`,
  ];
  const ex = parseExports(lines);
  const byName = new Map(ex.map((e) => [e.name, e]));
  assert.equal(byName.get('alpha')?.kind, 'function');
  assert.equal(byName.get('beta')?.kind, 'function');
  assert.equal(byName.get('Gamma')?.kind, 'class');
  assert.equal(byName.get('delta')?.kind, 'const');
  assert.equal(byName.get('main')?.isDefault, true);
  assert.equal(byName.get('Eps')?.kind, 'other');
});

// ---------------------------------------------------------------------------
// Resolution + dependency graph + cycles
// ---------------------------------------------------------------------------

test('resolveSpecifier: maps a NodeNext `.js` specifier to the `.ts` file', () => {
  const relSet = new Set(['src/a.ts', 'src/b.tsx', 'src/dir/index.ts']);
  assert.equal(resolveSpecifier('src/x.ts', './a.js', relSet), 'src/a.ts');
  assert.equal(resolveSpecifier('src/x.ts', './b.js', relSet), 'src/b.tsx');
  assert.equal(resolveSpecifier('src/x.ts', './dir/index.js', relSet), 'src/dir/index.ts');
  assert.equal(resolveSpecifier('src/x.ts', './dir', relSet), 'src/dir/index.ts');
  assert.equal(resolveSpecifier('src/x.ts', 'react', relSet), null); // external
});

test('findCycles: detects a 2-module import cycle, ignores acyclic graphs', () => {
  const files: ParsedFile[] = [
    { rel: 'a.ts', content: '', lines: [], lineCount: 0, ext: 'ts', imports: [{ specifier: './b.js', line: 1, names: [], namespace: false }], exports: [] },
    { rel: 'b.ts', content: '', lines: [], lineCount: 0, ext: 'ts', imports: [{ specifier: './a.js', line: 1, names: [], namespace: false }], exports: [] },
    { rel: 'c.ts', content: '', lines: [], lineCount: 0, ext: 'ts', imports: [{ specifier: './a.js', line: 1, names: [], namespace: false }], exports: [] },
  ];
  const relSet = new Set(files.map((f) => f.rel));
  const graph = buildDependencyGraph(files, relSet);
  const cycles = findCycles(graph);
  assert.equal(cycles.length, 1);
  assert.deepEqual([...(cycles[0] ?? [])].sort(), ['a.ts', 'b.ts']);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('caseStyleOf classifies basenames', () => {
  assert.equal(caseStyleOf('my-file'), 'kebab');
  assert.equal(caseStyleOf('myFile'), 'camel');
  assert.equal(caseStyleOf('MyFile'), 'pascal');
  assert.equal(caseStyleOf('my_file'), 'snake');
  assert.equal(caseStyleOf('file'), 'lower');
});

test('normalizeForDup strips comments, imports, and trivial lines', () => {
  const norm = normalizeForDup(
    [`import x from 'y';`, `// comment`, `const a = 1; // trailing`, `}`, `   `, `doWork(a);`].join('\n')
  );
  assert.deepEqual(norm.map((n) => n.text), ['const a = 1;', 'doWork(a);']);
});

test('isApiRouteFile recognizes app/route + pages/api', () => {
  assert.equal(isApiRouteFile('app/api/users/route.ts'), true);
  assert.equal(isApiRouteFile('src/pages/api/login.ts'), true);
  assert.equal(isApiRouteFile('src/lib/util.ts'), false);
});

test('countBySeverity tallies', () => {
  const c = countBySeverity([
    { type: 'circular_dependency', severity: 'high', rule: 'r', file: 'f', line: 0, message: '', detail: '', autoFix: '' },
    { type: 'god_component', severity: 'medium', rule: 'r', file: 'f', line: 1, message: '', detail: '', autoFix: '' },
    { type: 'dead_code', severity: 'low', rule: 'r', file: 'f', line: 2, message: '', detail: '', autoFix: '' },
  ]);
  assert.deepEqual(c, { high: 1, medium: 1, low: 0 + 1 });
});

test('DEFAULT_SEVERITY: only circular deps + N+1 are high', () => {
  assert.equal(DEFAULT_SEVERITY.circular_dependency, 'high');
  assert.equal(DEFAULT_SEVERITY.n_plus_one_query, 'high');
  assert.equal(DEFAULT_SEVERITY.god_component, 'medium');
  assert.equal(DEFAULT_SEVERITY.dead_code, 'low');
});

// ---------------------------------------------------------------------------
// Detectors via runArchitectureGuard
// ---------------------------------------------------------------------------

test('circular dependency → HIGH, blocks the build, and is stored', async () => {
  const { report, records } = await guard({
    'src/a.ts': `import { b } from './b.js';\nexport const a = () => b;`,
    'src/b.ts': `import { a } from './a.js';\nexport const b = () => a;`,
  });
  assert.equal(report.blocked, true);
  assert.equal(report.passed, false);
  assert.equal(report.cycles.length, 1);
  assert.ok(report.violations.some((v) => v.type === 'circular_dependency' && v.severity === 'high'));
  assert.equal(records.length, 1);
  assert.equal(records[0]?.blocked, true);
  assert.equal(records[0]?.cycleCount, 1);
});

test('god component → flagged at the configured threshold (non-blocking by default)', async () => {
  const big = Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`).join('\n');
  const { report } = await guard({ 'src/Huge.tsx': big, 'src/use.ts': `import { v0 } from './Huge.js';` }, {}, { godMax: 5 });
  const god = report.violations.find((v) => v.type === 'god_component');
  assert.ok(god);
  assert.equal(god?.severity, 'medium');
  assert.equal(report.blocked, false); // medium does not block
});

test('N+1 query in an API route → HIGH and blocks', async () => {
  const route = [
    `export async function GET() {`,
    `  const ids = [1, 2, 3];`,
    `  for (const id of ids) {`,
    `    const row = await db.from('t').select('*').eq('id', id).single();`,
    `    use(row);`,
    `  }`,
    `}`,
  ].join('\n');
  const { report } = await guard({ 'app/api/items/route.ts': route });
  const nplus = report.violations.find((v) => v.type === 'n_plus_one_query');
  assert.ok(nplus);
  assert.equal(nplus?.severity, 'high');
  assert.equal(report.blocked, true);
});

test('N+1 detector ignores the same loop outside an API route', async () => {
  const lib = [
    `export async function work() {`,
    `  for (const id of [1]) {`,
    `    await db.from('t').select('*').single();`,
    `  }`,
    `}`,
  ].join('\n');
  const { report } = await guard({ 'src/lib/work.ts': lib, 'src/use.ts': `import { work } from './lib/work.js';` });
  assert.ok(!report.violations.some((v) => v.type === 'n_plus_one_query'));
});

test('hardcoded URL → flagged, but localhost / env reads are allow-listed', async () => {
  const { report } = await guard({
    'src/api.ts': [
      `export const base = "https://api.example-prod-service.io/v1";`,
      `export const dev = "http://localhost:3000";`,
      `export const env = process.env.OTHER_URL;`,
    ].join('\n'),
    'src/use.ts': `import { base } from './api.js';`,
  });
  const hits = report.violations.filter((v) => v.type === 'hardcoded_value');
  assert.equal(hits.length, 1);
  assert.match(hits[0]?.message ?? '', /api\.example-prod-service\.io/);
});

test('strict-mode violations: `as any` and `@ts-ignore`', async () => {
  const { report } = await guard({
    'src/loose.ts': [`export const f = (x: unknown) => x as any;`, `// @ts-ignore`, `const y = bad();`].join('\n'),
    'src/use.ts': `import { f } from './loose.js';`,
  });
  const rules = report.violations.filter((v) => v.type === 'strict_mode_violation').map((v) => v.rule);
  assert.ok(rules.includes('arch.as_any'));
  assert.ok(rules.includes('arch.ts_ignore'));
});

test('dead code: an exported function nobody imports', async () => {
  const { report } = await guard({
    'src/util.ts': `export function used() {}\nexport function orphan() {}`,
    'src/main.ts': `import { used } from './util.js';\nexport function go() { used(); }`,
    'src/cli/index.ts': `import { go } from '../main.js';\ngo();`,
  });
  const dead = report.violations.filter((v) => v.type === 'dead_code');
  assert.equal(dead.length, 1);
  assert.match(dead[0]?.message ?? '', /orphan/);
});

test('duplicate logic: an identical block across two files', async () => {
  const block = [
    `const total = items.reduce((s, it) => s + it.price, 0);`,
    `const taxed = total * 1.2;`,
    `const rounded = Math.round(taxed * 100) / 100;`,
    `const label = formatCurrency(rounded);`,
    `logger.info('computed', label);`,
    `return { rounded, label };`,
  ].join('\n');
  const { report } = await guard({
    'src/checkout.ts': `export function a(items) {\n${block}\n}`,
    'src/cart.ts': `export function b(items) {\n${block}\n}`,
    'src/use.ts': `import { a } from './checkout.js';\nimport { b } from './cart.js';`,
  });
  assert.ok(report.violations.some((v) => v.type === 'duplicate_logic'));
});

test('missing error boundary: a tsx tree with no boundary anywhere', async () => {
  const { report } = await guard({
    'app/layout.tsx': `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
    'app/page.tsx': `export default function Page() { return <main>hi</main>; }`,
  });
  assert.ok(report.violations.some((v) => v.type === 'missing_error_boundary'));
});

test('missing error boundary: satisfied by an app-router error.tsx', async () => {
  const { report } = await guard({
    'app/layout.tsx': `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
    'app/error.tsx': `'use client';\nexport default function Error() { return <div>boom</div>; }`,
  });
  assert.ok(!report.violations.some((v) => v.type === 'missing_error_boundary'));
});

test('empty / unanalyzable project → zero violations, not blocked, still stores a summary', async () => {
  const { report, records } = await guard({});
  assert.equal(report.scannedFiles, 0);
  assert.equal(report.violations.length, 0);
  assert.equal(report.blocked, false);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.totalViolations, 0);
});

test('severityOverrides can escalate god components to HIGH (blocking)', async () => {
  const big = Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`).join('\n');
  const { report } = await guard(
    { 'src/Huge.tsx': big, 'src/use.ts': `import { v0 } from './Huge.js';` },
    {},
    { godMax: 5, severityOverrides: { god_component: 'high' } }
  );
  assert.equal(report.blocked, true);
  assert.ok(report.violations.some((v) => v.type === 'god_component' && v.severity === 'high'));
});

// ---------------------------------------------------------------------------
// Phase 4 Sentinel integration (the optional eleventh check)
// ---------------------------------------------------------------------------

/** A command runner whose tsc/build always pass (so the optional check is reached). */
const greenRun = async (): Promise<CommandResult> => ({ ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false });

/** A canned report builder for the injected `runArchitectureCheck`. */
function archReport(over: Partial<ArchitectureReport>): ArchitectureReport {
  return {
    passed: true,
    blocked: false,
    violations: [],
    counts: { high: 0, medium: 0, low: 0 },
    scannedFiles: 3,
    dependencyGraph: {},
    cycles: [],
    report: '# arch',
    generatedAt: 'T',
    ...over,
  };
}

test('Sentinel: no architecture config → exactly the nine Contract-13 checks', async () => {
  const res = await runSentinel({
    projectPath: '/proj',
    runCommand: greenRun,
    getFileChanges: async () => [],
    log: () => {},
  });
  assert.equal(res.checks.length, 9);
  assert.ok(!res.checks.some((c) => c.name === 'architecture'));
});

test('Sentinel: a HIGH-severity architectural violation FAILS the gate', async () => {
  const res = await runSentinel({
    projectPath: '/proj',
    runCommand: greenRun,
    packageJsonContent: '{}',
    getFileChanges: async () => [{ status: 'A', path: 'src/a.ts' }],
    architectureGuard: {},
    runArchitectureCheck: async () =>
      archReport({
        passed: false,
        blocked: true,
        counts: { high: 1, medium: 0, low: 0 },
        cycles: [['src/a.ts', 'src/b.ts']],
        violations: [
          { type: 'circular_dependency', severity: 'high', rule: 'arch.circular_dependency', file: 'src/a.ts', line: 0, message: 'cycle', detail: '', autoFix: '' },
        ],
      }),
    log: () => {},
  });
  assert.equal(res.passed, false);
  assert.equal(res.failedCheck, 'architecture');
  assert.equal(res.checks.find((c) => c.name === 'architecture')?.passed, false);
});

test('Sentinel: a clean architecture check passes (eleventh check present)', async () => {
  const res = await runSentinel({
    projectPath: '/proj',
    runCommand: greenRun,
    packageJsonContent: '{}',
    getFileChanges: async () => [{ status: 'A', path: 'src/a.ts' }],
    architectureGuard: {},
    runArchitectureCheck: async () => archReport({ counts: { high: 0, medium: 2, low: 1 } }),
    log: () => {},
  });
  assert.equal(res.passed, true);
  const arch = res.checks.find((c) => c.name === 'architecture');
  assert.equal(arch?.passed, true);
  assert.match(arch?.detail ?? '', /no high-severity/);
});
