const fs = require('fs');
const path = 'C:/Users/manag/Documents/forge-2/src/skills/index.ts';
let s = fs.readFileSync(path, 'utf8');
const old = `      s.applicablePromptTypes.length === 0 ||
          s.applicablePromptTypes.some((t) => t.toLowerCase() === type)`;
const rep = `      s.applicablePromptTypes.some((t) => t.toLowerCase() === type)`;
if (!s.includes(old)) { console.log('NO MATCH — trying alternate'); process.exit(1); }
s = s.replace(old, rep);
fs.writeFileSync(path, s, 'utf8');
console.log('DONE');
