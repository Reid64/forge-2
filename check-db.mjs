import Database from 'better-sqlite3';
import { join } from 'path';
const db = new Database(join(process.env.USERPROFILE, '.forge/forge_memory.db'), {readonly: true});
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.table(tables);
db.close();
