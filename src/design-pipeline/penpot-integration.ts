/**
 * FORGE 2.0 — Design Pipeline: PenpotIntegration (`src/design-pipeline/penpot-integration.ts`).
 *
 * Optional bridge from FORGE's own captured evidence (`screenshotter.ts`'s
 * {@link import('./screenshotter.js').ScreenshotResult}) into Penpot — an open-source, self-hostable
 * design tool — so a generated component/page can be pushed into a real design file for human review
 * alongside its screenshot, instead of the screenshot being the only visual artifact a build produces.
 *
 * Penpot is entirely optional infrastructure: most FORGE machines will not have a Penpot instance
 * running at all (the default `http://localhost:9001` assumes a local Docker Penpot, matching
 * BLUEPRINT.md's "self-hosted, Docker" posture for FORGE's own Supabase instance), and most projects
 * will never configure `PENPOT_EMAIL`/`PENPOT_PASSWORD`. Every public method on
 * {@link PenpotIntegration} therefore degrades gracefully (Contract 4 posture, matching
 * `src/design-pipeline/screenshotter.ts`/`src/autonomy/vercel-deployer.ts`/
 * `src/autonomy/supabase-migrator.ts`): an unreachable instance, a missing credential, or a failed
 * API call never throws — it logs `[DESIGN PIPELINE] Penpot not available - screenshot-only mode`
 * and returns a safe `null`/`false`/`[]`, and the caller (the screenshot capture pipeline) simply
 * continues without a Penpot artifact for that capture. FORGE's screenshot-only mode is never
 * degraded by Penpot being absent.
 *
 * WHAT IT DOES:
 *   1. `isAvailable()`         — confirms a Penpot instance answers HTTP 200 on its own
 *                                 `get-profile` RPC command before anything else tries to use it
 *                                 (mirrors `PlaywrightScreenshotter.isAvailable`'s lazy-check style).
 *   2. `isConfigured()`        — confirms this project actually has Penpot credentials available,
 *                                 via `PENPOT_EMAIL`/`PENPOT_PASSWORD` env vars first, then
 *                                 {@link CredentialVault} (the same resolution order
 *                                 `resolveToken`/`resolveAccessToken` use in
 *                                 `vercel-deployer.ts`/`supabase-migrator.ts`).
 *   3. `authenticate()`        — logs in via Penpot's `login-with-password` RPC command, returning
 *                                 a session token (Penpot's auth cookie value) the other methods use.
 *   4. `createFile()`          — creates a new Penpot file inside a project via the `create-file`
 *                                 RPC command.
 *   5. `uploadScreenshot()`    — uploads a captured PNG (Playwright's own screenshot output) into a
 *                                 Penpot file as a media asset via the `upload-file-media-object` RPC
 *                                 command, returning the resulting asset's URL.
 *   6. `getDesignFileUrl()`    — builds the human-facing Penpot workspace URL for a file id, purely
 *                                 by string construction — never a network call, never throws.
 *
 * Penpot's public API is an RPC-over-HTTP transport (`POST /api/rpc/command/<command-name>`), not a
 * REST resource tree — every mutating call in this module follows that same one-shape convention.
 *
 * NOT IN SCOPE (deliberately, matching every other integration module's stated limitations): this
 * module does not manage Penpot teams/projects lifecycle beyond what `createFile` needs, does not
 * sync a Penpot file back into FORGE's own component source, and does not attempt any Penpot feature
 * beyond the six methods above — it is a one-way, best-effort push of evidence into Penpot, not a
 * two-way design-to-code pipeline.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { getLogger, logLine } from '../tools/forge-logger.js';
import { CredentialVault, createCredentialVault } from '../autonomy/credential-vault.js';

const log = getLogger('design-pipeline:penpot-integration');

/** Logged whenever Penpot is unreachable/unconfigured and a caller falls back to screenshot-only mode. */
export const PENPOT_UNAVAILABLE_MESSAGE = '[DESIGN PIPELINE] Penpot not available - screenshot-only mode';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Connection + credentials for a Penpot instance. */
export interface PenpotConfig {
  /** Penpot instance base URL. Default: `http://localhost:9001` (a local, self-hosted Docker instance). */
  baseUrl?: string;
  /** Penpot account email used to authenticate. */
  email: string;
  /** Penpot account password used to authenticate. */
  password: string;
  /** Optional team id a created file's project should belong to. */
  teamId?: string;
}

/** The outcome of {@link PenpotIntegration.createFile} — always returned, never thrown. */
export interface PenpotFileResult {
  fileId: string | null;
  name: string;
  projectId: string;
  designFileUrl: string | null;
  error: string | null;
}

/** The outcome of {@link PenpotIntegration.uploadScreenshot} — always returned, never thrown. */
export interface PenpotUploadResult {
  imageUrl: string | null;
  mediaId: string | null;
  fileId: string;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'http://localhost:9001';
const AVAILABILITY_TIMEOUT_MS = 4_000;
const REQUEST_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 30_000;

const RPC_GET_PROFILE = 'get-profile';
const RPC_LOGIN_WITH_PASSWORD = 'login-with-password';
const RPC_CREATE_FILE = 'create-file';
const RPC_UPLOAD_FILE_MEDIA_OBJECT = 'upload-file-media-object';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Render an unknown thrown value as a short string. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Join a base URL and a Penpot RPC command path, tolerating a trailing slash on `baseUrl`. */
function rpcUrl(baseUrl: string, command: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  return `${b}/api/rpc/command/${command}`;
}

/** Best-effort guess at a PNG's MIME type — this module only ever uploads screenshots. */
function mimeTypeFor(filePath: string): string {
  return filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// PenpotIntegration
// ---------------------------------------------------------------------------

/**
 * Best-effort bridge into a Penpot instance. One instance holds no persistent connection state
 * beyond an in-memory session token cache set by {@link authenticate} — construct once per
 * design-pipeline run and reuse it across multiple `createFile`/`uploadScreenshot` calls so
 * authentication only happens once.
 */
export class PenpotIntegration {
  private readonly log: (message: string) => void;
  private readonly vault: CredentialVault;
  private sessionToken: string | null = null;

  constructor(options: { log?: (message: string) => void; vault?: CredentialVault } = {}) {
    this.log = options.log ?? logLine('penpot-integration');
    this.vault = options.vault ?? createCredentialVault();
  }

  /**
   * True iff `baseUrl` answers HTTP 200 on its own `get-profile` RPC command (Penpot's cheapest
   * "are you alive" probe — it returns 401 when unauthenticated, which is still a live server, so
   * only a genuine network failure/non-response counts as unavailable). Never throws.
   */
  async isAvailable(baseUrl: string = DEFAULT_BASE_URL): Promise<boolean> {
    try {
      const res = await fetch(rpcUrl(baseUrl, RPC_GET_PROFILE), {
        method: 'GET',
        signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS),
      });
      return res.status === 200;
    } catch (error) {
      this.log(`WARNING: Penpot availability check failed (${describeError(error)})`);
      return false;
    }
  }

  /**
   * True iff this project has Penpot credentials available: `PENPOT_EMAIL`/`PENPOT_PASSWORD`
   * environment variables first (a machine-wide Penpot login, matching `resolveToken`'s env-first
   * order in `vercel-deployer.ts`), else a `PENPOT_EMAIL`/`PENPOT_PASSWORD` pair stored in
   * {@link CredentialVault} for `projectPath`. Never throws.
   */
  async isConfigured(projectPath: string): Promise<boolean> {
    try {
      const envEmail = process.env['PENPOT_EMAIL'];
      const envPassword = process.env['PENPOT_PASSWORD'];
      if (envEmail && envEmail.length > 0 && envPassword && envPassword.length > 0) {
        return true;
      }
      const vaultEmail = await this.vault.get(projectPath, 'PENPOT_EMAIL');
      const vaultPassword = await this.vault.get(projectPath, 'PENPOT_PASSWORD');
      return Boolean(vaultEmail) && Boolean(vaultPassword);
    } catch (error) {
      this.log(`WARNING: Penpot configuration check failed (${describeError(error)})`);
      return false;
    }
  }

  /**
   * Resolve email/password for `projectPath`: explicit `config` fields win, else the environment
   * variables, else the vault. Returns `null` fields (never throws) when nothing resolves either
   * value — callers treat a `null` as "not configured," not as an error.
   */
  private async resolveCredentials(
    projectPath: string,
    config?: Partial<PenpotConfig>
  ): Promise<{ email: string | null; password: string | null }> {
    let email = config?.email && config.email.length > 0 ? config.email : null;
    let password = config?.password && config.password.length > 0 ? config.password : null;

    if (!email) email = process.env['PENPOT_EMAIL'] ?? null;
    if (!password) password = process.env['PENPOT_PASSWORD'] ?? null;

    if (!email) email = await this.vault.get(projectPath, 'PENPOT_EMAIL');
    if (!password) password = await this.vault.get(projectPath, 'PENPOT_PASSWORD');

    return { email, password };
  }

  /**
   * Log in via Penpot's `login-with-password` RPC command and cache the resulting session token
   * (Penpot returns an auth cookie on success; this module tracks the response body's session id
   * field instead of managing a cookie jar). Returns the session token on success, `null` on any
   * failure (unreachable instance, bad credentials, malformed response) — never throws.
   */
  async authenticate(config: PenpotConfig): Promise<string | null> {
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

    if (!config.email || !config.password) {
      this.log(`${PENPOT_UNAVAILABLE_MESSAGE} (no email/password supplied)`);
      return null;
    }

    try {
      const res = await fetch(rpcUrl(baseUrl, RPC_LOGIN_WITH_PASSWORD), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: config.email, password: config.password }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        this.log(`${PENPOT_UNAVAILABLE_MESSAGE} (login failed: HTTP ${res.status})`);
        return null;
      }

      const body = (await res.json().catch(() => null)) as
        | { id?: string; 'session-token'?: string; token?: string }
        | null;
      const token =
        (body && (body['session-token'] || body.token || body.id)) ??
        res.headers.get('set-cookie') ??
        null;

      if (!token) {
        this.log(`${PENPOT_UNAVAILABLE_MESSAGE} (login succeeded but no session token in response)`);
        return null;
      }

      this.sessionToken = token;
      this.log('authenticated with Penpot');
      return token;
    } catch (error) {
      this.log(`${PENPOT_UNAVAILABLE_MESSAGE} (${describeError(error)})`);
      return null;
    }
  }

  /**
   * Ensure a session token is available, authenticating via `config` (or previously-resolved
   * project credentials) if one is not already cached. Returns `null` (never throws) when no
   * credentials are available or authentication fails.
   */
  private async ensureSession(
    projectPath: string,
    baseUrl: string,
    config?: Partial<PenpotConfig>
  ): Promise<string | null> {
    if (this.sessionToken) return this.sessionToken;

    const { email, password } = await this.resolveCredentials(projectPath, config);
    if (!email || !password) {
      this.log(`${PENPOT_UNAVAILABLE_MESSAGE} (no credentials configured for this project)`);
      return null;
    }

    return this.authenticate({ baseUrl, email, password, teamId: config?.teamId });
  }

  /**
   * Create a new Penpot file named `name` inside `projectId` via the `create-file` RPC command.
   * Requires an authenticated session (see {@link authenticate}) — a caller that has not yet
   * authenticated on this instance gets a `PenpotFileResult` with `fileId: null` and `error` set,
   * never a thrown exception.
   */
  async createFile(
    name: string,
    projectId: string,
    options: { baseUrl?: string; projectPath?: string; config?: Partial<PenpotConfig> } = {}
  ): Promise<PenpotFileResult> {
    const baseUrl = options.baseUrl ?? options.config?.baseUrl ?? DEFAULT_BASE_URL;
    const result: PenpotFileResult = { fileId: null, name, projectId, designFileUrl: null, error: null };

    const token = options.projectPath
      ? await this.ensureSession(options.projectPath, baseUrl, options.config)
      : this.sessionToken;

    if (!token) {
      result.error = 'not authenticated';
      this.log(`${PENPOT_UNAVAILABLE_MESSAGE} (createFile: no session token)`);
      return result;
    }

    try {
      const res = await fetch(rpcUrl(baseUrl, RPC_CREATE_FILE), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `auth-token=${token}` },
        body: JSON.stringify({ name, 'project-id': projectId }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        result.error = `HTTP ${res.status}`;
        this.log(`${PENPOT_UNAVAILABLE_MESSAGE} (createFile failed: HTTP ${res.status})`);
        return result;
      }

      const body = (await res.json().catch(() => null)) as { id?: string } | null;
      if (!body || !body.id) {
        result.error = 'malformed response (no file id)';
        this.log(`${PENPOT_UNAVAILABLE_MESSAGE} (createFile: malformed response)`);
        return result;
      }

      result.fileId = body.id;
      result.designFileUrl = this.getDesignFileUrl(body.id, baseUrl);
      this.log(`created Penpot file '${name}' (${body.id})`);
      return result;
    } catch (error) {
      result.error = describeError(error);
      this.log(`${PENPOT_UNAVAILABLE_MESSAGE} (createFile: ${result.error})`);
      return result;
    }
  }

  /**
   * Upload a captured PNG at `filePath` into `fileId` as a media asset via the
   * `upload-file-media-object` RPC command, returning the resulting asset's URL. Requires an
   * authenticated session. Degrades to a `PenpotUploadResult` with `imageUrl: null` and `error` set
   * on a missing file, an unauthenticated session, or any request failure — never throws.
   */
  async uploadScreenshot(
    filePath: string,
    fileId: string,
    options: { baseUrl?: string; projectPath?: string; config?: Partial<PenpotConfig> } = {}
  ): Promise<PenpotUploadResult> {
    const baseUrl = options.baseUrl ?? options.config?.baseUrl ?? DEFAULT_BASE_URL;
    const result: PenpotUploadResult = { imageUrl: null, mediaId: null, fileId, error: null };

    if (!existsSync(filePath)) {
      result.error = `file not found: ${filePath}`;
      this.log(`${PENPOT_UNAVAILABLE_MESSAGE} (uploadScreenshot: ${result.error})`);
      return result;
    }

    const token = options.projectPath
      ? await this.ensureSession(options.projectPath, baseUrl, options.config)
      : this.sessionToken;

    if (!token) {
      result.error = 'not authenticated';
      this.log(`${PENPOT_UNAVAILABLE_MESSAGE} (uploadScreenshot: no session token)`);
      return result;
    }

    try {
      const bytes = readFileSync(filePath);
      const name = basename(filePath);
      const formData = new FormData();
      formData.append('file-id', fileId);
      formData.append('is-local', 'true');
      formData.append('name', name);
      formData.append(
        'content',
        new Blob([bytes], { type: mimeTypeFor(filePath) }),
        name
      );

      const res = await fetch(rpcUrl(baseUrl, RPC_UPLOAD_FILE_MEDIA_OBJECT), {
        method: 'POST',
        headers: { cookie: `auth-token=${token}` },
        body: formData,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });

      if (!res.ok) {
        result.error = `HTTP ${res.status}`;
        this.log(`${PENPOT_UNAVAILABLE_MESSAGE} (uploadScreenshot failed: HTTP ${res.status})`);
        return result;
      }

      const body = (await res.json().catch(() => null)) as { id?: string; url?: string } | null;
      if (!body || !body.id) {
        result.error = 'malformed response (no media id)';
        this.log(`${PENPOT_UNAVAILABLE_MESSAGE} (uploadScreenshot: malformed response)`);
        return result;
      }

      result.mediaId = body.id;
      result.imageUrl = body.url ?? `${baseUrl.replace(/\/+$/, '')}/assets/${body.id}`;
      this.log(`uploaded '${name}' to Penpot file ${fileId} (media ${body.id})`);
      return result;
    } catch (error) {
      result.error = describeError(error);
      this.log(`${PENPOT_UNAVAILABLE_MESSAGE} (uploadScreenshot: ${result.error})`);
      return result;
    }
  }

  /**
   * Build the human-facing Penpot workspace URL for `fileId`. Pure string construction — never a
   * network call, never throws, and returns a usable URL even for a `fileId` this instance never
   * created itself (e.g. one read back from a prior build's Build Memory record).
   */
  getDesignFileUrl(fileId: string, baseUrl: string = DEFAULT_BASE_URL): string {
    const b = baseUrl.replace(/\/+$/, '');
    return `${b}/#/workspace?file-id=${encodeURIComponent(fileId)}`;
  }
}

/** Factory matching the house style of `createPlaywrightScreenshotter`/`createCredentialVault`. */
export function createPenpotIntegration(options: {
  log?: (message: string) => void;
  vault?: CredentialVault;
} = {}): PenpotIntegration {
  return new PenpotIntegration(options);
}

// Re-export so callers that only need the logger's `[DESIGN PIPELINE]` tag convention can reuse the
// same child logger instead of constructing their own `getLogger('design-pipeline:penpot-integration')` call.
export const penpotIntegrationLogger = log;

export default PenpotIntegration;
