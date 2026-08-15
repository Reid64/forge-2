const fs = require('fs');
const p = 'C:/Users/manag/Documents/forge-2/src/phases/phase3-executor.ts';
const lines = fs.readFileSync(p, 'utf8').split('\n');
const idx = lines.findIndex(l => l.includes("import { buildSkillsContext }"));
if (idx === -1) { console.log('NOT FOUND'); process.exit(1); }
console.log('Removing line', idx+1, ':', lines[idx].trim());
lines.splice(idx, 1);
fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('DONE');
