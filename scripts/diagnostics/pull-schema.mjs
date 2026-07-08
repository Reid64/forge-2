import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
const db = new Database(path.join(os.homedir(), '.forge', 'forge_memory.db'));
const cols = db.prepare(`PRAGMA table_info(prompt_executions)`).all();
console.log(cols.map(c => c.name).join('\n'));
db.close();
