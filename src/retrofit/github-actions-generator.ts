// FORGE 2.0 — RETROFIT: GitHub Actions Generator
//
// Detects a target project's build/test/deploy shape (package manager, Node version, whether a
// real test script exists, whether E2E tooling is present, whether the project deploys to Vercel)
// from files already on disk — package.json, .nvmrc, lockfiles, vercel.json/.vercel — and, from
// that, generates a minimal, correct GitHub Actions CI/CD pipeline: a `ci.yml` that always runs
// (typecheck, lint-if-configured, test-if-configured, build) plus, only when a Vercel deploy target
// is detected, a `deploy.yml` (push-to-main Vercel deploy + `forge verify`) and a
// `forge-verify.yml` (deployment_status-triggered HTTP health check). Read-only detection against
// the target project; the only writes this module performs are the workflow YAML files themselves,
// under `<projectPath>/.github/workflows/`, and only when `ensureGitHubActions` is called.
//
// Wired into Phase 0 of the FORGE build pipeline (`src/phases/phase0-scout.ts`): after the
// toolchain scout runs, `ensureGitHubActions` is invoked when the project already has a `.git`
// directory (branch/checkpoint/rollback — Contracts 10/11/12 — need one) and does not yet have a
// `.github/workflows` directory (never overwrites an operator's existing CI setup).

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { getLogger } from '../tools/forge-logger.js';

export interface WorkflowConfig {
  projectName: string;
  nodeVersion: string;
  packageManager: string;
  hasTests: boolean;
  hasE2e: boolean;
  deployTarget: 'vercel' | 'none';
}

interface PackageJsonShape {
  name?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
}

const DEFAULT_NODE_VERSION = '20';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function readPackageJson(projectPath: string): PackageJsonShape | null {
  const pkgPath = join(projectPath, 'package.json');
  let raw: string;
  try {
    raw = readFileSync(pkgPath, 'utf8');
  } catch {
    return null; // no package.json — nothing to detect from
  }

  try {
    return JSON.parse(raw) as PackageJsonShape;
  } catch {
    return null; // malformed package.json — skip, never throw
  }
}

/** `.nvmrc` (if present) wins over `package.json` `engines.node`, which wins over the default. */
function detectNodeVersion(projectPath: string, pkg: PackageJsonShape | null): string {
  const nvmrcPath = join(projectPath, '.nvmrc');
  if (existsSync(nvmrcPath)) {
    try {
      const raw = readFileSync(nvmrcPath, 'utf8').trim();
      if (raw) return raw.replace(/^v/i, '');
    } catch {
      // unreadable .nvmrc — fall through to engines/default
    }
  }

  const engineNode = pkg?.engines?.node;
  if (engineNode) {
    const match = /(\d+)/.exec(engineNode);
    if (match) {
      const digits = match[1];
      if (digits) return digits;
    }
  }

  return DEFAULT_NODE_VERSION;
}

/** Lockfile presence determines the package manager. Defaults to npm when none is found. */
function detectPackageManager(projectPath: string): string {
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(projectPath, 'bun.lockb'))) return 'bun';
  if (existsSync(join(projectPath, 'package-lock.json'))) return 'npm';
  return 'npm';
}

const NO_TEST_SPECIFIED_RE = /no test specified/i;

/** A `test` script exists and isn't npm init's placeholder ("Error: no test specified"). */
function detectHasTests(scripts: Record<string, string>): boolean {
  const testScript = scripts.test;
  if (!testScript) return false;
  if (NO_TEST_SPECIFIED_RE.test(testScript)) return false;
  return true;
}

const E2E_SCRIPT_NAME_RE = /^(test:)?e2e$/i;
const E2E_TOOL_RE = /playwright|cypress/i;

/** E2E config files, or an `e2e`/`test:e2e` script, or a script invoking Playwright/Cypress. */
function detectHasE2e(projectPath: string, scripts: Record<string, string>): boolean {
  const e2eConfigFiles = [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'cypress.config.ts',
    'cypress.config.js',
  ];
  if (e2eConfigFiles.some((name) => existsSync(join(projectPath, name)))) return true;

  for (const [name, command] of Object.entries(scripts)) {
    if (E2E_SCRIPT_NAME_RE.test(name)) return true;
    if (E2E_TOOL_RE.test(command)) return true;
  }
  return false;
}

/** A `vercel.json` file or a `.vercel` directory (created by `vercel link`/`vercel deploy`). */
function detectDeployTarget(projectPath: string): 'vercel' | 'none' {
  if (existsSync(join(projectPath, 'vercel.json'))) return 'vercel';
  if (existsSync(join(projectPath, '.vercel'))) return 'vercel';
  return 'none';
}

/**
 * Reads `<projectPath>/package.json` (name, scripts, engines), `.nvmrc`, the project's lockfile,
 * and Vercel markers to produce a {@link WorkflowConfig}. Read-only, never throws — a missing or
 * malformed `package.json` degrades to sensible defaults (project directory's basename, npm,
 * Node 20, no tests, no E2E, no deploy target) rather than failing.
 */
export function detectWorkflowConfig(projectPath: string): WorkflowConfig {
  const pkg = readPackageJson(projectPath);
  const scripts: Record<string, string> = pkg?.scripts ?? {};
  const trimmedName = pkg?.name?.trim();
  const projectName = trimmedName && trimmedName.length > 0 ? trimmedName : basename(projectPath) || 'project';

  return {
    projectName,
    nodeVersion: detectNodeVersion(projectPath, pkg),
    packageManager: detectPackageManager(projectPath),
    hasTests: detectHasTests(scripts),
    hasE2e: detectHasE2e(projectPath, scripts),
    deployTarget: detectDeployTarget(projectPath),
  };
}

// ---------------------------------------------------------------------------
// Package-manager command helpers
// ---------------------------------------------------------------------------

function installCommand(packageManager: string): string {
  switch (packageManager) {
    case 'pnpm':
      return 'pnpm install --frozen-lockfile';
    case 'yarn':
      return 'yarn install --frozen-lockfile';
    case 'bun':
      return 'bun install --frozen-lockfile';
    default:
      return 'npm ci';
  }
}

function runCommand(packageManager: string, script: string): string {
  switch (packageManager) {
    case 'pnpm':
      return `pnpm run ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      return `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

/** `actions/setup-node`'s built-in `cache:` only understands npm/yarn/pnpm — never bun. */
function setupNodeCacheKey(packageManager: string): string | null {
  return packageManager === 'npm' || packageManager === 'yarn' || packageManager === 'pnpm'
    ? packageManager
    : null;
}

// ---------------------------------------------------------------------------
// ci.yml
// ---------------------------------------------------------------------------

/**
 * Generates `.github/workflows/ci.yml`: triggers on push to `main` and on every pull request,
 * runs on `ubuntu-latest`. Steps: checkout, `actions/setup-node` (with dependency caching, plus a
 * `pnpm/action-setup` step first when the project uses pnpm — required for setup-node's pnpm cache
 * mode to resolve), install dependencies, `tsc --noEmit`, lint (only actually invoked when a
 * `lint` script is present in `package.json` — checked at CI runtime via a small `node -e` guard,
 * since "configured" is a property of the project, not of this generator), tests (only included
 * as a step at all when `config.hasTests` is true), E2E tests (only included when `config.hasE2e`
 * is true), then build.
 */
export function generateCIWorkflow(config: WorkflowConfig): string {
  const { packageManager, nodeVersion } = config;
  const cacheKey = setupNodeCacheKey(packageManager);

  const lines: string[] = [];
  lines.push('# Generated by FORGE 2.0 — GitHubActionsGenerator. Safe to hand-edit.');
  lines.push(`name: CI`);
  lines.push('');
  lines.push('on:');
  lines.push('  push:');
  lines.push('    branches: [main]');
  lines.push('  pull_request:');
  lines.push('    branches: [main]');
  lines.push('');
  lines.push('jobs:');
  lines.push('  build:');
  lines.push(`    name: Build & Test (${config.projectName})`);
  lines.push('    runs-on: ubuntu-latest');
  lines.push('    steps:');
  lines.push('      - name: Checkout');
  lines.push('        uses: actions/checkout@v4');
  lines.push('');

  if (packageManager === 'pnpm') {
    lines.push('      - name: Install pnpm');
    lines.push('        uses: pnpm/action-setup@v4');
    lines.push('        with:');
    lines.push('          version: 9');
    lines.push('');
  }

  lines.push('      - name: Setup Node.js');
  lines.push('        uses: actions/setup-node@v4');
  lines.push('        with:');
  lines.push(`          node-version: '${nodeVersion}'`);
  if (cacheKey) lines.push(`          cache: '${cacheKey}'`);
  lines.push('');

  lines.push('      - name: Install dependencies');
  lines.push(`        run: ${installCommand(packageManager)}`);
  lines.push('');

  lines.push('      - name: Type check');
  lines.push('        run: npx tsc --noEmit');
  lines.push('');

  lines.push('      - name: Lint');
  lines.push('        run: |');
  lines.push('          if node -e "process.exit((require(\'./package.json\').scripts || {}).lint ? 0 : 1)"; then');
  lines.push(`            ${runCommand(packageManager, 'lint')}`);
  lines.push('          else');
  lines.push('            echo "No lint script configured in package.json — skipping"');
  lines.push('          fi');
  lines.push('');

  if (config.hasTests) {
    lines.push('      - name: Run tests');
    lines.push(`        run: ${runCommand(packageManager, 'test')}`);
    lines.push('');
  }

  if (config.hasE2e) {
    lines.push('      - name: Run E2E tests');
    lines.push('        run: |');
    lines.push(
      '          if node -e "process.exit((require(\'./package.json\').scripts || {})[\'test:e2e\'] ? 0 : 1)"; then'
    );
    lines.push(`            ${runCommand(packageManager, 'test:e2e')}`);
    lines.push('          else');
    lines.push(`            ${runCommand(packageManager, 'e2e')}`);
    lines.push('          fi');
    lines.push('');
  }

  lines.push('      - name: Build');
  lines.push(`        run: ${runCommand(packageManager, 'build')}`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// deploy.yml
// ---------------------------------------------------------------------------

/**
 * Generates `.github/workflows/deploy.yml`: triggers on push to `main` only, deploys the project
 * to Vercel using the `VERCEL_TOKEN` secret (pull → build → deploy, the standard Vercel CLI CI
 * sequence), then runs `forge verify` against the freshly-deployed URL so a real Vercel-side
 * verification always happens after every production deploy, not only when a deployment_status
 * webhook happens to fire (see {@link generateForgeVerifyWorkflow} for that path).
 */
export function generateVercelDeployWorkflow(config: WorkflowConfig): string {
  const lines: string[] = [];
  lines.push('# Generated by FORGE 2.0 — GitHubActionsGenerator. Safe to hand-edit.');
  lines.push('name: Deploy to Vercel');
  lines.push('');
  lines.push('on:');
  lines.push('  push:');
  lines.push('    branches: [main]');
  lines.push('');
  lines.push('jobs:');
  lines.push('  deploy:');
  lines.push(`    name: Deploy (${config.projectName})`);
  lines.push('    runs-on: ubuntu-latest');
  lines.push('    environment: production');
  lines.push('    steps:');
  lines.push('      - name: Checkout');
  lines.push('        uses: actions/checkout@v4');
  lines.push('');
  lines.push('      - name: Install Vercel CLI');
  lines.push('        run: npm install --global vercel@latest');
  lines.push('');
  lines.push('      - name: Pull Vercel environment information');
  lines.push('        run: vercel pull --yes --environment=production --token=${{ secrets.VERCEL_TOKEN }}');
  lines.push('');
  lines.push('      - name: Build project artifacts');
  lines.push('        run: vercel build --prod --token=${{ secrets.VERCEL_TOKEN }}');
  lines.push('');
  lines.push('      - name: Deploy to Vercel');
  lines.push('        id: deploy');
  lines.push('        run: |');
  lines.push('          url=$(vercel deploy --prebuilt --prod --token=${{ secrets.VERCEL_TOKEN }})');
  lines.push('          echo "url=$url" >> "$GITHUB_OUTPUT"');
  lines.push('');
  lines.push('      - name: Run forge verify');
  lines.push('        env:');
  lines.push('          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}');
  lines.push('        run: >');
  lines.push(`          npx forge verify --url "\${{ steps.deploy.outputs.url }}" --project "${config.projectName}"`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// forge-verify.yml
// ---------------------------------------------------------------------------

/**
 * Generates `.github/workflows/forge-verify.yml`: triggers on GitHub's `deployment_status` event
 * (fired by Vercel's GitHub integration, and by {@link generateVercelDeployWorkflow}'s own deploy
 * step, once a deployment reaches a terminal state) and, only when that state is `success`, runs
 * an HTTP health check against `deployment_status.target_url` plus `forge verify` — independent of
 * whichever workflow actually produced the deployment.
 */
export function generateForgeVerifyWorkflow(config: WorkflowConfig): string {
  const lines: string[] = [];
  lines.push('# Generated by FORGE 2.0 — GitHubActionsGenerator. Safe to hand-edit.');
  lines.push('name: FORGE Verify');
  lines.push('');
  lines.push('on:');
  lines.push('  deployment_status');
  lines.push('');
  lines.push('jobs:');
  lines.push('  verify:');
  lines.push(`    name: Post-deploy health check (${config.projectName})`);
  lines.push("    if: github.event.deployment_status.state == 'success'");
  lines.push('    runs-on: ubuntu-latest');
  lines.push('    steps:');
  lines.push('      - name: Checkout');
  lines.push('        uses: actions/checkout@v4');
  lines.push('');
  lines.push('      - name: HTTP health check');
  lines.push('        run: |');
  lines.push('          url="${{ github.event.deployment_status.target_url }}"');
  lines.push('          echo "Checking $url"');
  lines.push('          status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 "$url")');
  lines.push('          echo "HTTP status: $status"');
  lines.push('          if [ "$status" -lt 200 ] || [ "$status" -ge 400 ]; then');
  lines.push('            echo "::error::Health check failed for $url (HTTP $status)"');
  lines.push('            exit 1');
  lines.push('          fi');
  lines.push('          echo "Health check passed for $url (HTTP $status)"');
  lines.push('');
  lines.push('      - name: Run forge verify');
  lines.push('        run: >');
  lines.push(
    `          npx forge verify --url "\${{ github.event.deployment_status.target_url }}" --project "${config.projectName}"`
  );
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Filesystem: workflow directory + file writes
// ---------------------------------------------------------------------------

/**
 * Detects `projectPath`'s workflow config, creates `<projectPath>/.github/workflows/` if absent,
 * and writes `ci.yml` unconditionally plus (only when `deployTarget === 'vercel'`) `deploy.yml`
 * and `forge-verify.yml`. Each file write is independently guarded — a failure on one file is
 * logged and skipped rather than aborting the remaining writes (Contract 4's degrade-not-halt
 * posture). Returns the absolute paths of every file actually written, in write order.
 */
export async function ensureGitHubActions(projectPath: string): Promise<string[]> {
  const config = detectWorkflowConfig(projectPath);
  const workflowsDir = join(projectPath, '.github', 'workflows');
  const created: string[] = [];
  const logger = getLogger('github-actions-generator');

  try {
    await mkdir(workflowsDir, { recursive: true });
  } catch (error) {
    logger.warn(`could not create ${workflowsDir} — ${error instanceof Error ? error.message : String(error)}`);
    return created;
  }

  const writeWorkflow = async (fileName: string, content: string): Promise<void> => {
    const filePath = join(workflowsDir, fileName);
    try {
      await writeFile(filePath, content, 'utf8');
      created.push(filePath);
    } catch (error) {
      logger.warn(`could not write ${filePath} — ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await writeWorkflow('ci.yml', generateCIWorkflow(config));

  if (config.deployTarget === 'vercel') {
    await writeWorkflow('deploy.yml', generateVercelDeployWorkflow(config));
    await writeWorkflow('forge-verify.yml', generateForgeVerifyWorkflow(config));
  }

  return created;
}
