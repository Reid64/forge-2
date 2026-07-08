import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';

const buildRunId = process.argv[2];
if (!buildRunId) {
  console.error('Usage: node pull-details.mjs <build_run_id>');
  process.exit(1);
}

const db = new Database(path.join(os.homedir(), '.forge', 'forge_memory.db'));
const row = db.prepare(`SELECT sentinel_details, error_output, tokens_input, tokens_output FROM prompt_executions WHERE build_run_id = ? AND prompt_index = 1`).get(buildRunId);
console.log('=== SENTINEL_DETAILS ===');
console.log(row.sentinel_details ?? '(null)');
console.log('=== ERROR_OUTPUT ===');
console.log(row.error_output ?? '(null)');
console.log('=== TOKENS ===');
console.log('input:', row.tokens_input, 'output:', row.tokens_output);
db.close();
