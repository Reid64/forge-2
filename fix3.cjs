const fs = require('fs');
const path = 'C:/Users/manag/Documents/forge-2/src/phases/phase3-executor.ts';
let s = fs.readFileSync(path, 'utf8');
const old = "options.governanceDirName ?? 'governance'";
if (!s.includes(old)) { console.log('NO MATCH'); process.exit(1); }
s = s.replaceAll(old, "options.governanceDirName ?? '.'");
fs.writeFileSync(path, s, 'utf8');
console.log('DONE');
