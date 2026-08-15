const Database = require("better-sqlite3");
const os = require("os");
const path = require("path");
const dbPath = path.join(os.homedir(), ".forge", "forge_memory.db");
const db = new Database(dbPath);
const rows = db.prepare("SELECT * FROM pending_evolutions ORDER BY created_at DESC LIMIT 10").all();
console.log(JSON.stringify(rows, null, 2));
