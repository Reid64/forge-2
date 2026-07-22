/**
 * FORGE 2.0 — Autonomy: VercelDeployer.
 *
 * Deploys a FORGE-built project to Vercel directly via the Vercel REST API — no `vercel` CLI
 * subprocess, no interactive `vercel login`. Every credential lookup goes through
 * {@link CredentialVault} first (per-project, encrypted at rest), falling back to the operator's
 * own `VERCEL_TOKEN` environment variable so a machine that already has the Vercel CLI configured
 * (or the token set globally) needs no extra setup.
 *
 * Deployment flow (mirrors what `vercel deploy` itself does under the hood):
 *   1. Walk the project directory, excluding build artifacts / VCS / dependency directories.
 *   2. SHA-1 hash every file and upload its raw bytes to Vercel's file-upload endpoint
 *      (`PUT /v2/files`) — Vercel dedupes by digest, so re-uploading an unchanged file is a no-op
 *      on their end.
 *   3. POST `/v13/deployments` referencing the uploaded files by digest; Vercel builds and deploys
 *      server-side.
 *   4. Poll `GET /v13/deployments/{id}` every 10 seconds until `readyState` is a terminal value
 *      (`READY`, `ERROR`, or `CANCELED`), or a 10-minute ceiling is hit.
 *   5. Persist the outcome to Build Memory's `deployment_history` table (schema 2.9.0 —
 *      `src/learning/database.ts` › AUTONOMY_SCHEMA_SQL), the same table
 *      {@link CredentialVault}'s sibling `project_credentials`/`autonomy_actions` tables live in.
 *
 * Every public method degrades gracefully (Contract 4): a missing token, an unreadable
 * `.vercel/project.json`, or a network failure never throws out to the caller — it returns a
 * `DeploymentResult`/`false`/`null` describing what went wrong. Build Memory writes are
 * best-effort, logged and swallowed on failure, exactly like every other autonomy module.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { getClient, logMemoryWarning, newId, nowIso } from '../memory/client.js';
import { getLogger } from '../tools/forge-logger.js';
import { CredentialVault, createCredentialVault } from './credential-vault.js';

const log = getLogger('autonomy:vercel-deployer');

const VERCEL_API_BASE = 'https://api.vercel.com';

/** Directory names never uploaded as part of a deployment's file set. */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.vercel',
  '.forge',
  'dist',
  'build',
  'coverage',
  '.turbo',
]);

/** Poll cadence and ceiling for {@link VercelDeployer.deploy}'s readiness wait. */
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_DURATION_MS = 10 * 60_000;

export type DeploymentStatus = 'queued' | 'building' | 'ready' | 'error' | 'canceled' | 'failed';

/** The outcome of a deploy/status call — always returned, never thrown. */
export interface DeploymentResult {
  deploymentId: string | null;
  deploymentUrl: string | null;
  status: DeploymentStatus;
  readyAt: string | null;
  error: string | null;
}

/** Shape of `.vercel/project.json`, written by `vercel link`/a prior `vercel deploy`. */
interface VercelProjectLink {
  projectId: string;
  orgId: string;
}

/** One file staged for upload — path relative to the project root, POSIX-separated. */
interface StagedFile {
  relPath: string;
  absPath: string;
  sha: string;
  size: number;
}

/** Minimal shape of the fields this module reads off Vercel's deployment API responses. */
interface VercelDeploymentResponse {
  id?: string;
  uid?: string;
  url?: string;
  readyState?: string;
  status?: string;
  error?: { message?: string } | null;
}

/** Resolve the Vercel API token: `VERCEL_TOKEN` env var first, else the project's vault entry. */
async function resolveToken(projectPath: string, vault: CredentialVault): Promise<string | null> {
  const envToken = process.env['VERCEL_TOKEN'];
  if (envToken && envToken.length > 0) return envToken;
  return vault.get(projectPath, 'VERCEL_TOKEN');
}

/** Read `.vercel/project.json`. Returns `null` if absent, unreadable, or malformed. */
async function readProjectLink(projectPath: string): Promise<VercelProjectLink | null> {
  const linkPath = join(projectPath, '.vercel', 'project.json');
  if (!existsSync(linkPath)) return null;
  try {
    const raw = await readFile(linkPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<VercelProjectLink>;
    if (typeof parsed.projectId !== 'string' || parsed.projectId.length === 0) return null;
    return { projectId: parsed.projectId, orgId: typeof parsed.orgId === 'string' ? parsed.orgId : '' };
  } catch (error) {
    logMemoryWarning('vercel-deployer.readProjectLink', error);
    return null;
  }
}

/** Recursively list every file under `dir`, skipping {@link EXCLUDED_DIRS} at any depth. */
async function walkProjectFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    logMemoryWarning('vercel-deployer.walkProjectFiles', error);
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await walkProjectFiles(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
}

/** Hash + size every file under `projectPath`, ready to stage for Vercel's file-upload API. */
async function stageProjectFiles(projectPath: string): Promise<StagedFile[]> {
  const absPaths: string[] = [];
  await walkProjectFiles(projectPath, absPaths);

  const staged: StagedFile[] = [];
  for (const absPath of absPaths) {
    try {
      const [buf, st] = await Promise.all([readFile(absPath), stat(absPath)]);
      const sha = createHash('sha1').update(buf).digest('hex');
      const relPath = relative(projectPath, absPath).split(sep).join('/');
      staged.push({ relPath, absPath, sha, size: st.size });
    } catch (error) {
      logMemoryWarning('vercel-deployer.stageProjectFiles', error);
    }
  }
  return staged;
}

/** Upload one file's raw bytes to Vercel, keyed by its SHA-1 digest (Vercel dedupes server-side). */
async function uploadFile(file: StagedFile, token: string): Promise<boolean> {
  try {
    const buf = await readFile(file.absPath);
    const res = await fetch(`${VERCEL_API_BASE}/v2/files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Length': String(file.size),
        'x-vercel-digest': file.sha,
      },
      body: buf,
    });
    // 200 = uploaded, 409 = Vercel already has this digest — both mean the file is available.
    return res.ok || res.status === 409;
  } catch (error) {
    logMemoryWarning('vercel-deployer.uploadFile', error);
    return false;
  }
}

/** Map a Vercel `readyState` string onto FORGE's own {@link DeploymentStatus} vocabulary. */
function mapReadyState(readyState: string | undefined): DeploymentStatus {
  switch ((readyState ?? '').toUpperCase()) {
    case 'READY':
      return 'ready';
    case 'ERROR':
      return 'error';
    case 'CANCELED':
      return 'canceled';
    case 'BUILDING':
    case 'INITIALIZING':
      return 'building';
    case 'QUEUED':
      return 'queued';
    default:
      return 'queued';
  }
}

/** Persist one deployment attempt's outcome to `deployment_history`. Best-effort (Contract 4). */
function recordDeploymentHistory(row: {
  buildRunId: string;
  projectPath: string;
  deploymentId: string | null;
  deploymentUrl: string | null;
  status: DeploymentStatus;
  deployedAt: string | null;
}): void {
  const db = getClient();
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO deployment_history
         (id, build_run_id, project_path, platform, deployment_id, deployment_url, status, deployed_at, verified_at, created_at)
       VALUES (@id, @build_run_id, @project_path, 'vercel', @deployment_id, @deployment_url, @status, @deployed_at, NULL, @created_at)`
    ).run({
      id: newId(),
      build_run_id: row.buildRunId,
      project_path: row.projectPath,
      deployment_id: row.deploymentId,
      deployment_url: row.deploymentUrl,
      status: row.status,
      deployed_at: row.deployedAt,
      created_at: nowIso(),
    });
  } catch (error) {
    logMemoryWarning('vercel-deployer.recordDeploymentHistory', error);
  }
}

/**
 * Deploys FORGE-built projects to Vercel via its REST API. One instance is stateless aside from
 * the {@link CredentialVault} it wraps — safe to construct fresh per call or reuse across a build.
 */
export class VercelDeployer {
  private readonly vault: CredentialVault;

  constructor(vault?: CredentialVault) {
    this.vault = vault ?? createCredentialVault();
  }

  /**
   * True only when BOTH a Vercel API token is resolvable (env or vault) AND the project has
   * already been linked to a Vercel project (`vercel.json` present, or a `.vercel` directory from
   * a prior `vercel link`/`vercel deploy`). Never throws.
   */
  async isConfigured(projectPath: string): Promise<boolean> {
    try {
      const token = await resolveToken(projectPath, this.vault);
      if (!token) return false;
      const hasVercelJson = existsSync(join(projectPath, 'vercel.json'));
      const hasVercelDir = existsSync(join(projectPath, '.vercel'));
      return hasVercelJson || hasVercelDir;
    } catch (error) {
      logMemoryWarning('vercel-deployer.isConfigured', error);
      return false;
    }
  }

  /**
   * Deploy `projectPath` to Vercel. Uploads every project file, creates the deployment via
   * `POST /v13/deployments`, then polls `GET /v13/deployments/{id}` every 10 seconds until the
   * deployment reaches a terminal state or 10 minutes elapse. Always returns a
   * {@link DeploymentResult} — a missing token/project link, an upload failure, a Vercel API
   * error, or a poll timeout all resolve to `status: 'failed'`/`'error'` with `error` populated,
   * never a thrown exception.
   */
  async deploy(
    projectPath: string,
    buildRunId: string,
    environment: 'production' | 'preview' = 'preview'
  ): Promise<DeploymentResult> {
    const failure = (message: string): DeploymentResult => {
      log.warn({ projectPath, buildRunId, environment }, message);
      recordDeploymentHistory({
        buildRunId,
        projectPath,
        deploymentId: null,
        deploymentUrl: null,
        status: 'failed',
        deployedAt: null,
      });
      return { deploymentId: null, deploymentUrl: null, status: 'failed', readyAt: null, error: message };
    };

    const token = await resolveToken(projectPath, this.vault);
    if (!token) return failure('No VERCEL_TOKEN found in environment or credential vault.');

    const link = await readProjectLink(projectPath);
    if (!link) return failure('No .vercel/project.json found — run `vercel link` once before autonomous deploys.');

    const staged = await stageProjectFiles(projectPath);
    if (staged.length === 0) return failure('No files found to deploy under ' + projectPath);

    log.info({ projectPath, fileCount: staged.length }, 'Uploading project files to Vercel');
    for (const file of staged) {
      const ok = await uploadFile(file, token);
      if (!ok) return failure(`Failed to upload file: ${file.relPath}`);
    }

    const teamQuery = link.orgId.startsWith('team_') ? `?teamId=${encodeURIComponent(link.orgId)}` : '';
    let createRes: Response;
    try {
      createRes = await fetch(`${VERCEL_API_BASE}/v13/deployments${teamQuery}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: link.projectId,
          project: link.projectId,
          target: environment === 'production' ? 'production' : undefined,
          files: staged.map((f) => ({ file: f.relPath, sha: f.sha, size: f.size })),
        }),
      });
    } catch (error) {
      return failure(`Vercel deployment creation request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!createRes.ok) {
      const body = await createRes.text().catch(() => '');
      return failure(`Vercel API returned ${createRes.status} creating deployment: ${body}`);
    }

    let created: VercelDeploymentResponse;
    try {
      created = (await createRes.json()) as VercelDeploymentResponse;
    } catch (error) {
      return failure(`Failed to parse Vercel deployment creation response: ${error instanceof Error ? error.message : String(error)}`);
    }

    const deploymentId = created.id ?? created.uid ?? null;
    if (!deploymentId) return failure('Vercel deployment creation response had no deployment id.');

    log.info({ deploymentId }, 'Vercel deployment created — polling for readiness');

    const deadline = Date.now() + MAX_POLL_DURATION_MS;
    let last: DeploymentResult = {
      deploymentId,
      deploymentUrl: created.url ? `https://${created.url}` : null,
      status: mapReadyState(created.readyState ?? created.status),
      readyAt: null,
      error: null,
    };

    const isTerminal = (r: DeploymentResult): boolean =>
      r.status === 'ready' || r.status === 'error' || r.status === 'canceled';

    while (!isTerminal(last) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      last = await this.getDeploymentStatus(deploymentId, projectPath);
    }

    const finalStatus: DeploymentStatus = last.status === 'ready' || last.status === 'error' || last.status === 'canceled'
      ? last.status
      : 'failed'; // never reached a terminal state within the 10-minute ceiling.

    const result: DeploymentResult = {
      deploymentId,
      deploymentUrl: last.deploymentUrl,
      status: finalStatus,
      readyAt: finalStatus === 'ready' ? nowIso() : null,
      error: finalStatus === 'ready' ? null : (last.error ?? `Deployment did not reach a ready state (last status: ${finalStatus}).`),
    };

    recordDeploymentHistory({
      buildRunId,
      projectPath,
      deploymentId: result.deploymentId,
      deploymentUrl: result.deploymentUrl,
      status: result.status,
      deployedAt: result.readyAt,
    });

    return result;
  }

  /**
   * Fetch the current status of a deployment via `GET /v13/deployments/{id}`. `projectPath` is
   * optional and used only to resolve a vault-stored token when `VERCEL_TOKEN` is not set in the
   * environment — pass it whenever available. Never throws.
   */
  async getDeploymentStatus(deploymentId: string, projectPath?: string): Promise<DeploymentResult> {
    const token = projectPath ? await resolveToken(projectPath, this.vault) : process.env['VERCEL_TOKEN'];
    if (!token) {
      return { deploymentId, deploymentUrl: null, status: 'failed', readyAt: null, error: 'No VERCEL_TOKEN available to check deployment status.' };
    }
    try {
      const res = await fetch(`${VERCEL_API_BASE}/v13/deployments/${encodeURIComponent(deploymentId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { deploymentId, deploymentUrl: null, status: 'failed', readyAt: null, error: `Vercel API returned ${res.status}: ${body}` };
      }
      const data = (await res.json()) as VercelDeploymentResponse;
      const status = mapReadyState(data.readyState ?? data.status);
      return {
        deploymentId: data.id ?? data.uid ?? deploymentId,
        deploymentUrl: data.url ? `https://${data.url}` : null,
        status,
        readyAt: status === 'ready' ? nowIso() : null,
        error: status === 'error' ? (data.error?.message ?? 'Deployment failed on Vercel.') : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logMemoryWarning('vercel-deployer.getDeploymentStatus', error);
      return { deploymentId, deploymentUrl: null, status: 'failed', readyAt: null, error: message };
    }
  }

  /**
   * Resolve the project's current production domain via `GET /v9/projects/{projectId}/domains`.
   * Returns `null` (never throws) if unconfigured, unreachable, or no domain is assigned yet —
   * the caller should fall back to the deployment's own `.vercel.app` URL in that case.
   */
  async getProductionUrl(projectPath: string): Promise<string | null> {
    const token = await resolveToken(projectPath, this.vault);
    if (!token) return null;
    const link = await readProjectLink(projectPath);
    if (!link) return null;
    const teamQuery = link.orgId.startsWith('team_') ? `?teamId=${encodeURIComponent(link.orgId)}` : '';
    try {
      const res = await fetch(`${VERCEL_API_BASE}/v9/projects/${encodeURIComponent(link.projectId)}/domains${teamQuery}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { domains?: Array<{ name: string }> };
      const first = data.domains?.[0];
      return first ? `https://${first.name}` : null;
    } catch (error) {
      logMemoryWarning('vercel-deployer.getProductionUrl', error);
      return null;
    }
  }

  /**
   * Roll `projectPath`'s live traffic back to a previously-successful `deploymentId` via
   * `POST /v9/projects/{projectId}/rollback`. Returns `true` only on a confirmed 200/201 from
   * Vercel; `false` on a missing token/project link, an API error, or a network failure — never
   * throws.
   */
  async rollback(projectPath: string, deploymentId: string): Promise<boolean> {
    const token = await resolveToken(projectPath, this.vault);
    if (!token) {
      log.warn({ projectPath }, 'rollback: no VERCEL_TOKEN available.');
      return false;
    }
    const link = await readProjectLink(projectPath);
    if (!link) {
      log.warn({ projectPath }, 'rollback: no .vercel/project.json found.');
      return false;
    }
    const teamQuery = link.orgId.startsWith('team_') ? `?teamId=${encodeURIComponent(link.orgId)}` : '';
    try {
      const res = await fetch(`${VERCEL_API_BASE}/v9/projects/${encodeURIComponent(link.projectId)}/rollback${teamQuery}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log.warn({ projectPath, deploymentId, status: res.status, body }, 'rollback: Vercel API returned a non-2xx status.');
        return false;
      }
      return true;
    } catch (error) {
      logMemoryWarning('vercel-deployer.rollback', error);
      return false;
    }
  }
}

/** Construct a {@link VercelDeployer}, optionally over an explicit {@link CredentialVault} (tests). */
export function createVercelDeployer(vault?: CredentialVault): VercelDeployer {
  return new VercelDeployer(vault);
}
