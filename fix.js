const fs = require('fs');
const path = 'C:/Users/manag/Documents/forge-2/src/engine/auto-resume.ts';
let s = fs.readFileSync(path, 'utf8');
const m = s.match(/if \(mostRecentBuild\.queue_hash !== queueState\.hash\)[\s\S]*?return 1;\n    \}/);
if (!m) { console.log('NO MATCH'); process.exit(1); }
const old = m[0];
const repl = old
  .replace("'treating this as a FRESH build, starting at prompt 1.'", "'checking Build Memory before resetting.'")
  .replace('return 1;\n    }', 
    'const dbLast = await getDbLastCompleted(mostRecentBuild.id);\n' +
    '      if (dbLast !== null && dbLast > 0) {\n' +
    '        const resumeAt = dbLast + 1;\n' +
    '        log("auto-resume: queue hash changed but " + dbLast + " prompt(s) completed — resuming at " + resumeAt);\n' +
    '        if (queueState && resumeAt > queueState.entryCount) return 1;\n' +
    '        return resumeAt;\n' +
    '      }\n' +
    '      log("auto-resume: queue hash changed, no DB completions — fresh build");\n' +
    '      return 1;\n' +
    '    }'
  );
s = s.replace(old, repl);
fs.writeFileSync(path, s, 'utf8');
console.log('DONE');
