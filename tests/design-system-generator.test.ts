/**
 * FORGE 2.0 — Design System Generator tests (UI/UX Pro Max integration).
 *
 * Pure `node:test`: no real Python, no real skill, no network. The script runner and the
 * script-path resolver are INJECTED; the fake runner writes a MASTER.md to the exact path
 * the generator computes from `--output-dir` + the project slug, which also pins the
 * generator's contract with the skill's `--persist` layout. A real OS temp dir is used so
 * the on-disk read/write path is exercised end-to-end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  generateDesignSystem,
  deriveProductTypeQuery,
  renderDesignSystemPromptBlock,
  renderDesignSystemDoc,
  type ScriptRunner,
  type ScriptRunResult,
} from '../src/tools/design-system-generator.js';

const MASTER_BODY = '# Design System Master File\n\n## Global Rules\n\nPrimary: #2563EB';

/** A fake runner that writes MASTER.md to the persist path the generator expects. */
function writingRunner(extra?: Partial<ScriptRunResult>): ScriptRunner {
  return async (_python, args, _ctx) => {
    const outIdx = args.indexOf('--output-dir');
    const nameIdx = args.indexOf('-p');
    const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined;
    const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
    if (outDir && name) {
      const slug = name.toLowerCase().replace(/ /g, '-');
      const dir = join(outDir, 'design-system', slug);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'MASTER.md'), MASTER_BODY, 'utf8');
    }
    return { stdout: 'ok', stderr: '', exitCode: 0, spawned: true, errorMessage: null, ...extra };
  };
}

test('deriveProductTypeQuery prefers the PRD Product Overview paragraph, capped', () => {
  const prd = '# X\n\n## Product Overview\n\nA fintech crypto trading dashboard for retail investors.\n\n## More\n\nIgnored.';
  const q = deriveProductTypeQuery(prd, 'Tarritrix');
  assert.match(q, /^Tarritrix /);
  assert.match(q, /fintech crypto trading dashboard/);
  assert.ok(q.split(/\s+/).length <= 25);
});

test('deriveProductTypeQuery falls back to the project name for an empty PRD', () => {
  assert.equal(deriveProductTypeQuery('', 'Acme'), 'Acme');
  assert.equal(deriveProductTypeQuery('   ', ''), 'web application');
});

test('renderDesignSystemPromptBlock is empty for empty input, wrapped otherwise', () => {
  assert.equal(renderDesignSystemPromptBlock(''), '');
  const block = renderDesignSystemPromptBlock('## Colors\n#fff');
  assert.match(block, /AUTHORITATIVE/);
  assert.match(block, /#fff/);
});

test('renderDesignSystemDoc prepends a FORGE provenance header above the master body', () => {
  const doc = renderDesignSystemDoc(MASTER_BODY, {
    projectName: 'Acme',
    productType: 'saas dashboard',
    generatedAt: '2026-06-11T00:00:00.000Z',
  });
  assert.match(doc, /# Acme — DESIGN SYSTEM/);
  assert.match(doc, /Product-type query:\*\* saas dashboard/);
  assert.ok(doc.includes(MASTER_BODY));
});

test('generateDesignSystem writes DESIGN_SYSTEM.md from the persisted MASTER.md', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'forge-ds-'));
  const result = await generateDesignSystem(projectPath, {
    projectName: 'Acme App',
    productType: 'saas dashboard',
    resolveScriptPath: async () => '/fake/search.py',
    runScript: writingRunner(),
    log: () => {},
  });

  assert.equal(result.generated, true);
  assert.equal(result.pythonCommand, 'python');
  assert.equal(result.scriptPath, '/fake/search.py');
  assert.ok(result.designSystemPath);
  assert.equal(result.outputDir, 'governance');

  // The file actually exists with the header + master body.
  const onDisk = await readFile(join(projectPath, 'governance', 'DESIGN_SYSTEM.md'), 'utf8');
  assert.match(onDisk, /# Acme App — DESIGN SYSTEM/);
  assert.ok(onDisk.includes('Design System Master File'));
  assert.equal(onDisk, result.markdown);
});

test('generateDesignSystem honors write:false (content only, nothing on disk)', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'forge-ds-'));
  const result = await generateDesignSystem(projectPath, {
    projectName: 'Acme',
    write: false,
    resolveScriptPath: async () => '/fake/search.py',
    runScript: writingRunner(),
    log: () => {},
  });
  assert.equal(result.generated, true);
  assert.equal(result.designSystemPath, null);
  assert.ok(result.markdown.includes('Design System Master File'));
  await assert.rejects(() => readFile(join(projectPath, 'governance', 'DESIGN_SYSTEM.md'), 'utf8'));
});

test('generateDesignSystem tries the next Python when the first interpreter is missing', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'forge-ds-'));
  const writer = writingRunner();
  const runScript: ScriptRunner = async (python, args, ctx) => {
    if (python === 'python') {
      return { stdout: '', stderr: '', exitCode: null, spawned: false, errorMessage: 'spawn python ENOENT' };
    }
    return writer(python, args, ctx);
  };
  const result = await generateDesignSystem(projectPath, {
    projectName: 'Acme',
    resolveScriptPath: async () => '/fake/search.py',
    runScript,
    log: () => {},
  });
  assert.equal(result.generated, true);
  assert.equal(result.pythonCommand, 'python3');
});

test('generateDesignSystem degrades (non-fatal) when no Python is available', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'forge-ds-'));
  const result = await generateDesignSystem(projectPath, {
    projectName: 'Acme',
    resolveScriptPath: async () => '/fake/search.py',
    runScript: async () => ({ stdout: '', stderr: '', exitCode: null, spawned: false, errorMessage: 'ENOENT' }),
    log: () => {},
  });
  assert.equal(result.generated, false);
  assert.equal(result.markdown, '');
  assert.ok(result.warnings.some((w) => /No Python interpreter/.test(w)));
});

test('generateDesignSystem degrades (non-fatal) when the skill is not found', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'forge-ds-'));
  const result = await generateDesignSystem(projectPath, {
    projectName: 'Acme',
    resolveScriptPath: async () => null,
    runScript: writingRunner(),
    log: () => {},
  });
  assert.equal(result.generated, false);
  assert.equal(result.scriptPath, null);
  assert.ok(result.warnings.some((w) => /UI\/UX Pro Max skill not found/.test(w)));
});

test('generateDesignSystem reports a non-zero script exit as a non-fatal warning', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'forge-ds-'));
  const result = await generateDesignSystem(projectPath, {
    projectName: 'Acme',
    resolveScriptPath: async () => '/fake/search.py',
    runScript: async () => ({ stdout: '', stderr: 'boom', exitCode: 2, spawned: true, errorMessage: null }),
    log: () => {},
  });
  assert.equal(result.generated, false);
  assert.ok(result.warnings.some((w) => /exited with code 2/.test(w)));
});
