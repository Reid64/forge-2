const fs = require('fs');
const p = 'C:/Users/manag/Documents/forge-2/src/engine/git-manager.ts';
const s = fs.readFileSync(p, 'utf8');
const idx = s.indexOf('checkout -b forge/');
console.log('Branch creation found at index:', idx);
if (idx === -1) { console.log('NOT FOUND - checking alternate'); }
// Find where gitDiffChanges computes main...HEAD
const idx2 = s.indexOf('main...HEAD');
console.log('main...HEAD found at index:', idx2);
// Show context
if (idx2 > -1) console.log('Context:', s.substring(idx2-100, idx2+100));
