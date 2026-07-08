import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';

const buildRunId = process.argv[2];
if (!buildRunId) {
  console.error('Usage: node pull-stdio.mjs <build_run_id>');
  process.exit(1);
}

const db = new Database(path.join(os.homedir(), '.forge', 'forge_memory.db'));
const row = db.prepare(`SELECT stdout, stderr, error_output FROM prompt_executions WHERE build_run_id = ? AND prompt_index = 1`).get(buildRunId);
console.log('=== STDOUT ===');
console.log(row.stdout ?? '(null)');
console.log('=== STDERR ===');
console.log(row.stderr ?? '(null)');
console.log('=== ERROR_OUTPUT ===');
console.log(row.error_output ?? '(null)');
db.close();
