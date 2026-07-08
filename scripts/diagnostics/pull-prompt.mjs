import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const buildRunId = process.argv[2];
if (!buildRunId) {
  console.error('Usage: node pull-prompt.mjs <build_run_id>');
  process.exit(1);
}

const db = new Database(path.join(os.homedir(), '.forge', 'forge_memory.db'));
const row = db.prepare(`SELECT prompt_content, original_prompt_hash, prompt_hash, was_rewritten FROM prompt_executions WHERE build_run_id = ? AND prompt_index = 1`).get(buildRunId);
console.log(JSON.stringify(row, null, 2));
db.close();
