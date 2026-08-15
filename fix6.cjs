const fs = require('fs');
const path = 'C:/Users/manag/Documents/forge-2/src/phases/phase3-executor.ts';
const lines = fs.readFileSync(path, 'utf8').split('\n');
const idx = lines.findIndex(l => l.includes('buildSkillsContext(ctx.projectPath, promptText, entry.prompt_type)'));
if (idx === -1) { console.log('NOT FOUND'); process.exit(1); }
console.log('Found at line:', idx + 1, ':', lines[idx].trim());
lines[idx] = lines[idx].replace('buildSkillsContext(ctx.projectPath, promptText, entry.prompt_type)', 'promptText');
fs.writeFileSync(path, lines.join('\n'), 'utf8');
console.log('DONE');
