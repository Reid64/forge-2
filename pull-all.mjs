import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
const db = new Database(path.join(os.homedir(), '.forge', 'forge_memory.db'));
const rows = db.prepare(`SELECT prompt_index, prompt_name, status, sentinel_passed FROM prompt_executions WHERE build_run_id = '10426774-08f9-4a6b-8d08-87625c8ea357' ORDER BY prompt_index`).all();
console.log(JSON.stringify(rows, null, 2));
db.close();
