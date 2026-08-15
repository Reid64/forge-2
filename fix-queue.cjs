const fs = require('fs');
const filePath = process.argv[2] || 'C:/Users/manag/Documents/FORGE/library/forge-2/queue-forge2-design-pipeline.yaml';
const lines = fs.readFileSync(filePath, 'utf8').split('\n');
const out = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i];
  const m = line.match(/^(\s*)prompt: "(.*)$/);
  if (m) {
    const indent = m[1];
    let quoted = m[2];
    while (!quoted.endsWith('"') && i + 1 < lines.length) { i++; quoted += '\n' + lines[i]; }
    quoted = quoted.slice(0, -1);
    const unescaped = quoted.replace(/\\\\/g, '\\');
    out.push(indent + 'prompt: |');
    out.push(indent + '  ' + unescaped.trim());
  } else { out.push(line); }
  i++;
}
fs.writeFileSync(filePath, out.join('\n'));
console.log('Fixed: ' + filePath + ' (' + out.length + ' lines)');
