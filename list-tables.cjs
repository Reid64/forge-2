const Database = require("better-sqlite3");
const os = require("os");
const path = require("path");
const dbPath = path.join(os.homedir(), ".forge", "forge_memory.db");
console.log("DB PATH:", dbPath);
const db = new Database(dbPath);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log(tables.map(t => t.name).join("\n"));
