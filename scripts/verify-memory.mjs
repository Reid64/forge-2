// FORGE 2.0 — Session 1 verification: prove the SQLite Build Memory transport
// reads and writes correctly against a throwaway db path (never the real
// ~/.forge/forge_memory.db).
//
// Trick: getForgeDbPath()/getClient() always resolve `~/.forge/forge_memory.db`
// relative to os.homedir(), which Node derives from USERPROFILE (Windows) / HOME
// (POSIX). Pointing that env var at a temp directory BEFORE importing any FORGE
// module makes the entire memory stack — exactly as `forge` itself would use it —
// operate against a disposable database.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'forge-memory-verify-'));
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const { initializeForgeMemory, getForgeDbPath, getSchemaVersion, getAllTableHealth } = await import(
  '../dist/learning/database.js'
);
const { createBuild, getBuild, updateBuild } = await import('../dist/memory/builds.js');

let failed = false;
function assert(cond, message) {
  if (!cond) {
    failed = true;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`PASS: ${message}`);
  }
}

try {
  const dbPath = getForgeDbPath();
  assert(dbPath.startsWith(tmpHome), `Build Memory resolved under the temp home (${dbPath})`);

  initializeForgeMemory();
  // Schema version advances across sessions (2.0.0 in Session 1, 2.1.0 in Session 3, …) — this
  // script only needs to prove migration ran, not pin an exact historical version.
  const schemaVersion = getSchemaVersion();
  assert(/^\d+\.\d+\.\d+$/.test(schemaVersion), `schema_version is a valid semver-shaped string (got ${schemaVersion})`);
  assert(schemaVersion !== '1.0.0', `schema_version advanced past the pre-migration baseline (got ${schemaVersion})`);

  const created = await createBuild({
    project_name: 'verify-memory',
    project_path: tmpHome,
    machine_id: 'verify-machine',
  });
  assert(created !== null, 'createBuild returned a row (not null)');

  if (created) {
    assert(typeof created.id === 'string' && created.id.length > 0, 'created build has an id');
    assert(created.status === 'queued', `created build defaults to status=queued (got ${created.status})`);

    const fetched = await getBuild(created.id);
    assert(fetched !== null, 'getBuild roundtrip returned a row');
    assert(fetched?.id === created.id, 'getBuild returned the same id');
    assert(fetched?.project_name === 'verify-memory', 'getBuild returned the same project_name');

    const updated = await updateBuild(created.id, { status: 'completed', completed_prompts: 3 });
    assert(updated?.status === 'completed', 'updateBuild persisted the new status');
    assert(updated?.completed_prompts === 3, 'updateBuild persisted completed_prompts');
  }

  const health = getAllTableHealth();
  const buildRunsHealth = health.find((t) => t.table === 'build_runs');
  assert(buildRunsHealth?.exists === true, 'build_runs table exists in table-health report');
  assert((buildRunsHealth?.rowCount ?? 0) >= 1, 'build_runs table-health reports >= 1 row after insert');
  assert(health.length >= 12, `table-health reports all Build Memory tables (got ${health.length})`);
} finally {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

if (failed) {
  console.error('\nverify-memory: FAILED');
  process.exitCode = 1;
} else {
  console.log('\nverify-memory: ALL CHECKS PASSED');
}
