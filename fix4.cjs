const fs = require('fs');
const path = 'C:/Users/manag/Documents/hail-intel-forge-test/queue.yaml';
let s = fs.readFileSync(path, 'utf8');
const start = s.indexOf('- id: hi-governance-sync');
const end = s.indexOf('- id: hi-agents-md');
if (start === -1 || end === -1) { console.log('NO MATCH'); process.exit(1); }
s = s.substring(0, start) + s.substring(end);
fs.writeFileSync(path, s, 'utf8');
console.log('DONE — prompt 1 removed');
