const fs = require('fs');
const path = 'C:/Users/manag/Documents/forge-2/src/phases/phase4-sentinel.ts';
const lines = fs.readFileSync(path, 'utf8').split('\n');
const idx = lines.findIndex(l => l.includes("if (promptType === 'ui')"));
if (idx === -1) { console.log('NOT FOUND'); process.exit(1); }
console.log('Inserting after line:', idx + 1);
const insert = [
  "  if (promptType === 'feature') {",
  "    // For feature prompts, check if any .md file exists at project root with content",
  "    try {",
  "      const rootFiles = fs.readdirSync(projectPath);",
  "      return rootFiles.some(f => f.endsWith('.md') && (() => { try { return fs.statSync(require('path').join(projectPath, f)).size > 100; } catch { return false; } })());",
  "    } catch { return false; }",
  "  }",
];
lines.splice(idx, 0, ...insert);
fs.writeFileSync(path, lines.join('\n'), 'utf8');
console.log('DONE');
