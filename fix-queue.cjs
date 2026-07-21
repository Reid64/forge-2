const fs = require('fs');
const content = fs.readFileSync('C:/Users/manag/Documents/FORGE/library/forge-2/queue-system5-and-orchestrator.yaml', 'utf8');
const lines = content.split('\n');
const out = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i];
  const m = line.match(/^(\s*)prompt: "(.*)$/);
  if (m) {
    const indent = m[1];
    let quoted = m[2];
    while (!quoted.endsWith('"') && i + 1 < lines.length) {
      i++;
      quoted += '\n' + lines[i];
    }
    quoted = quoted.slice(0, -1);
    const unescaped = quoted.replace(/\\\\/g, '\\');
    out.push(indent + 'prompt: |');
    out.push(indent + '  ' + unescaped.trim());
  } else {
    out.push(line);
  }
  i++;
}
fs.writeFileSync('C:/Users/manag/Documents/FORGE/library/forge-2/queue-system5-and-orchestrator.yaml', out.join('\n'));
console.log('Done. First 20 lines:');
console.log(out.slice(0,20).join('\n'));
