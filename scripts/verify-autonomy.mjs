// FORGE 2.0 — Session 3 verification: prove the prompt-library compile pipeline,
// queue versioning/diffing, and auto-resume's state parser all work correctly.
// Redirects USERPROFILE/HOME to a temp dir (same trick as verify-memory.mjs) so
// this never touches the real ~/.forge/forge_memory.db.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump as dumpYaml } from 'js-yaml';

const tmpHome = mkdtempSync(join(tmpdir(), 'forge-autonomy-verify-'));
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const { initializeForgeMemory } = await import('../dist/learning/database.js');
const { runCompile } = await import('../dist/cli/compile-command.js');
const { serializeQueue, computeStats } = await import('../dist/engine/queue-generator.js');
const { snapshotQueue, getQueueVersion, diffQueueEntries, loadQueueEntriesFromFile } = await import(
  '../dist/tools/queue-versioning.js'
);
const { parseLastCompletedFromStateContent } = await import('../dist/engine/auto-resume.js');

let failed = false;
function assert(cond, message) {
  if (!cond) {
    failed = true;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`PASS: ${message}`);
  }
}
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

initializeForgeMemory();

// ---------------------------------------------------------------------------
// (a) forge compile — ordering, re-anchor injection, validation
// ---------------------------------------------------------------------------

function minimalEntryYaml(id, deps = []) {
  return {
    id,
    name: id,
    prompt_type: 'feature',
    dependencies: deps,
    governance_refs: [],
    estimated_tokens: 3000,
    context_injection: { schema_sections: [], behavioral_sections: [], interaction_maps: [] },
    description: `Build ${id}.`,
  };
}

const successProject = join(tmpHome, 'compile-success');
const successPromptsDir = join(successProject, 'prompts');
mkdirSync(join(successPromptsDir, '1-schema'), { recursive: true });
mkdirSync(join(successPromptsDir, '2-api'), { recursive: true });
mkdirSync(join(successPromptsDir, '3-ui'), { recursive: true });

const expectedIds = [];
for (let i = 1; i <= 12; i++) {
  const id = `schema-${String(i).padStart(2, '0')}`;
  expectedIds.push(id);
  writeFileSync(
    join(successPromptsDir, '1-schema', `${String(i).padStart(2, '0')}-x.yaml`),
    dumpYaml(minimalEntryYaml(id)),
    'utf8'
  );
}
for (let i = 1; i <= 12; i++) {
  const id = `api-${String(i).padStart(2, '0')}`;
  expectedIds.push(id);
  writeFileSync(
    join(successPromptsDir, '2-api', `${String(i).padStart(2, '0')}-x.yaml`),
    dumpYaml(minimalEntryYaml(id)),
    'utf8'
  );
}
for (let i = 1; i <= 10; i++) {
  const id = `ui-${String(i).padStart(2, '0')}`;
  expectedIds.push(id);
  writeFileSync(
    join(successPromptsDir, '3-ui', `${String(i).padStart(2, '0')}-x.yaml`),
    dumpYaml(minimalEntryYaml(id)),
    'utf8'
  );
}
assert(expectedIds.length === 34, `synthetic fixture has 34 real entries (got ${expectedIds.length})`);

const compileResult = await runCompile({
  projectPath: successProject,
  promptsDir: successPromptsDir,
  outPath: join(successProject, 'queue.yaml'),
  projectName: 'compile-success',
});

assert(compileResult.success, `compile succeeded (problems: ${JSON.stringify(compileResult.problems)})`);
assert(compileResult.entries.length === 36, `compiled queue has 36 entries: 34 real + 2 re-anchors (got ${compileResult.entries.length})`);
assert(compileResult.reanchorsInjected === 2, `exactly 2 re-anchors injected (got ${compileResult.reanchorsInjected})`);

const realIdsInOrder = compileResult.entries.filter((e) => !e.id.startsWith('reanchor-')).map((e) => e.id);
assert(deepEqual(realIdsInOrder, expectedIds), 'real entries preserved natural directory/file-prefix order');

assert(compileResult.entries[15]?.id === 'reanchor-1', `re-anchor #1 at position 16 (index 15) (got '${compileResult.entries[15]?.id}')`);
assert(compileResult.entries[31]?.id === 'reanchor-2', `re-anchor #2 at position 32 (index 31) (got '${compileResult.entries[31]?.id}')`);
assert(
  deepEqual(compileResult.entries[15]?.dependencies, ['api-03']),
  `re-anchor #1 depends ONLY on the preceding entry (got ${JSON.stringify(compileResult.entries[15]?.dependencies)})`
);
assert(
  deepEqual(compileResult.entries[31]?.dependencies, ['ui-06']),
  `re-anchor #2 depends ONLY on the preceding entry (got ${JSON.stringify(compileResult.entries[31]?.dependencies)})`
);

// Validation: duplicate id + dangling dependency.
const badProject = join(tmpHome, 'compile-bad');
const badPromptsDir = join(badProject, 'prompts');
mkdirSync(badPromptsDir, { recursive: true });
writeFileSync(join(badPromptsDir, '01-a.yaml'), dumpYaml(minimalEntryYaml('dup')), 'utf8');
writeFileSync(join(badPromptsDir, '02-b.yaml'), dumpYaml(minimalEntryYaml('dup')), 'utf8');
writeFileSync(join(badPromptsDir, '03-c.yaml'), dumpYaml(minimalEntryYaml('c', ['nonexistent-id'])), 'utf8');

const badResult = await runCompile({
  projectPath: badProject,
  promptsDir: badPromptsDir,
  outPath: join(badProject, 'queue.yaml'),
  projectName: 'compile-bad',
});
assert(!badResult.success, 'compile with a duplicate id + dangling dependency FAILS (does not write)');
assert(
  badResult.problems.some((p) => p.includes("Duplicate id 'dup'")),
  `validation reports the duplicate id (problems: ${JSON.stringify(badResult.problems)})`
);
assert(
  badResult.problems.some((p) => p.includes("unknown id 'nonexistent-id'")),
  `validation reports the dangling dependency (problems: ${JSON.stringify(badResult.problems)})`
);

// ---------------------------------------------------------------------------
// (b) queue versioning + diff
// ---------------------------------------------------------------------------

const diffProject = join(tmpHome, 'diff-test');
mkdirSync(diffProject, { recursive: true });

function entry(id, description) {
  return {
    id,
    name: id,
    prompt_type: 'feature',
    dependencies: [],
    governance_refs: [],
    estimated_tokens: 3000,
    context_injection: { schemaSections: [], behavioralSections: [], interactionMaps: [] },
    description,
  };
}

const entriesA = [entry('one', 'First version of one.'), entry('two', 'Two.')];
const statsA = computeStats(entriesA);
const yamlA = serializeQueue(entriesA, {
  projectName: 'diff-test',
  projectPath: diffProject,
  generatedAt: new Date(0).toISOString(),
  stats: statsA,
});
const snap1 = await snapshotQueue({ projectPath: diffProject, projectName: 'diff-test', queueYaml: yamlA, entryCount: entriesA.length });

const entriesB = [entry('one', 'MODIFIED version of one.'), entry('two', 'Two.'), entry('three', 'Newly added.')];
const statsB = computeStats(entriesB);
const yamlB = serializeQueue(entriesB, {
  projectName: 'diff-test',
  projectPath: diffProject,
  generatedAt: new Date(1000).toISOString(),
  stats: statsB,
});
const snap2 = await snapshotQueue({ projectPath: diffProject, projectName: 'diff-test', queueYaml: yamlB, entryCount: entriesB.length });

assert(snap1.hash !== snap2.hash, 'the two snapshots have different content hashes');

const previous = getQueueVersion('diff-test', 'previous');
assert(previous?.queue_hash === snap2.hash, "getQueueVersion('previous') resolves to the most recent snapshot");

const byHash = getQueueVersion('diff-test', snap1.hash);
assert(byHash?.snapshot_path === snap1.snapshotPath, 'getQueueVersion(hash) resolves the exact earlier snapshot by hash prefix');

const before = await loadQueueEntriesFromFile(snap1.snapshotPath);
const after = await loadQueueEntriesFromFile(snap2.snapshotPath);
const diff = diffQueueEntries(before, after);

assert(deepEqual(diff.added, ['three']), `diff detects the added entry (got ${JSON.stringify(diff.added)})`);
assert(deepEqual(diff.removed, []), 'diff detects no removed entries');
assert(
  diff.modified.length === 1 && diff.modified[0]?.id === 'one' && diff.modified[0]?.changedFields.includes('description'),
  `diff detects the modified entry with 'description' in changedFields (got ${JSON.stringify(diff.modified)})`
);

// ---------------------------------------------------------------------------
// (c) auto-resume state parser
// ---------------------------------------------------------------------------

const stateOfBuild = [
  "> 2026-01-01T00:00:00.000Z [FORGE Phase 3] prompt 5 'schema-users' (schema): COMPLETED — Sentinel PASS.",
  "> 2026-01-01T00:05:00.000Z [FORGE Phase 3] prompt 6 'schema-orgs' (schema): FAILED — Sentinel FAIL(tsc).",
].join('\n');
const sessionState = "> 2026-01-01T00:10:00.000Z [FORGE Phase 3] prompt 8 'api-routes' (api): COMPLETED — Sentinel PASS.";

const parsed = parseLastCompletedFromStateContent([stateOfBuild, sessionState]);
assert(parsed === 8, `parser finds the highest COMPLETED index across both documents (got ${parsed})`);

const onlyFailed = parseLastCompletedFromStateContent(["> t [FORGE Phase 3] prompt 3 'x' (schema): FAILED — nope."]);
assert(onlyFailed === null, 'parser ignores FAILED lines and returns null when nothing COMPLETED');

const empty = parseLastCompletedFromStateContent(['', '']);
assert(empty === null, 'parser returns null for empty content');

const garbage = parseLastCompletedFromStateContent(['not a real state file, just some prose about the weather.']);
assert(garbage === null, 'parser returns null for unparseable/garbage content');

const noContentAtAll = parseLastCompletedFromStateContent([]);
assert(noContentAtAll === null, 'parser returns null when given no content at all');

// ---------------------------------------------------------------------------

try {
  rmSync(tmpHome, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}

if (failed) {
  console.error('\nverify-autonomy: FAILED');
  process.exitCode = 1;
} else {
  console.log('\nverify-autonomy: ALL CHECKS PASSED');
}
