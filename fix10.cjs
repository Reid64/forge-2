const fs = require('fs');
const path = 'C:/Users/manag/Documents/hail-intel-forge-test/queue.yaml';
let s = fs.readFileSync(path, 'utf8');
const start = s.indexOf('- id: hi-schema-registry');
const end = s.indexOf('- id: hi-agent-base-architecture');
if (start === -1 || end === -1) { console.log('NOT FOUND'); process.exit(1); }
s = s.substring(0, start) + s.substring(end);
fs.writeFileSync(path, s, 'utf8');
console.log('DONE — hi-schema-registry removed');
