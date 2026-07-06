const Database = require('better-sqlite3');
const db = new Database(process.env.USERPROFILE + '/.forge/forge_memory.db', {readonly: true});
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.table(tables);
db.close();
