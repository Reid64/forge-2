const fs = require('fs');
const path = 'C:/Users/manag/Documents/forge-2/src/engine/auto-resume.ts';
let s = fs.readFileSync(path, 'utf8');
const old = "options.governanceDirName ?? 'governance'";
const rep = "options.governanceDirName ?? '.'";
if (!s.includes(old)) { console.log('NO MATCH'); process.exit(1); }
s = s.replace(old, rep);
fs.writeFileSync(path, s, 'utf8');
console.log('DONE');
