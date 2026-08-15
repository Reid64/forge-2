const Database = require("better-sqlite3");
const os = require("os");
const path = require("path");
const dbPath = path.join(os.homedir(), ".forge", "forge_memory.db");
const db = new Database(dbPath);
const agents = db.prepare("SELECT * FROM self_created_agents WHERE created_at > ? ORDER BY created_at DESC").all("2026-08-15T02:00:00.000Z");
console.log(JSON.stringify(agents, null, 2));
