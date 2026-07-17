import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
const db = new Database(path.join(os.homedir(), '.forge', 'forge_memory.db'));
const row = db.prepare(`SELECT prompt_name, status, sentinel_passed, error_output FROM prompt_executions WHERE build_run_id = '3736ff33-7ca2-4595-b304-b47badf28ac6' AND prompt_index = 5`).get();
console.log(JSON.stringify(row, null, 2));
db.close();
