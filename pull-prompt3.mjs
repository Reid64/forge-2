import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
const db = new Database(path.join(os.homedir(), '.forge', 'forge_memory.db'));
const row = db.prepare(`SELECT prompt_name, status, sentinel_passed, sentinel_details, error_output, resolution_applied FROM prompt_executions WHERE build_run_id = 'bc25881f-d83a-4850-a7df-fe16631afe93' AND prompt_index = 3`).get();
console.log(JSON.stringify(row, null, 2));
db.close();
