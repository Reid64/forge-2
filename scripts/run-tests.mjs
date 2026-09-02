// FORGE 2.0 — full test-suite runner (Finding A-1).
//
// package.json's "test" script used to hardcode 8 of 43 test files, so 35 files' worth of
// coverage silently never ran in CI or locally. Node's `--test` glob support is inconsistent
// across shells (PowerShell does not expand globs for external commands the way bash does), so
// this script enumerates every real test file itself (via the already-installed `glob` package)
// and passes them as explicit args to `node --import tsx --test`.
import { spawn } from 'node:child_process';
import { glob } from 'glob';

const patterns = ['tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'];
const files = (await glob(patterns, { ignore: 'node_modules/**' })).sort();

if (files.length === 0) {
  console.error('run-tests.mjs: no test files matched — refusing to report a false green run.');
  process.exit(1);
}

console.log(`run-tests.mjs: running ${files.length} test file(s)`);

const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
  shell: false,
});

child.on('exit', (code) => process.exit(code ?? 1));
