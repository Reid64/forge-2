/**
 * FORGE 2.0 — Autonomy: CredentialVault.
 *
 * Per-project local credential storage. Every value is encrypted at rest with
 * AES-256-GCM before it ever reaches SQLite (`project_credentials`, schema 2.9.0 —
 * see `src/learning/database.ts` › AUTONOMY_SCHEMA_SQL) and decrypted only in
 * memory, on read. The vault key itself is never persisted:
 *
 *   - `FORGE_VAULT_KEY` env var, if set, is SHA-256 hashed to a 32-byte AES key, or
 *   - a machine-derived key: SHA-256(`${os.hostname()}|${os.userInfo().username}`).
 *
 * The machine-derived fallback means a vault populated on one machine cannot be
 * decrypted on another (or by a different OS user) unless `FORGE_VAULT_KEY` is set
 * explicitly and shared out of band — this is intentional: it keeps credentials
 * pinned to the machine that captured them by default, the same "local-first"
 * posture the rest of Build Memory takes (Contract 4 — degrade, never leak).
 *
 * Every public method degrades gracefully (Contract 4): a database or filesystem
 * failure logs a warning and returns a safe empty/falsy value. Nothing here ever
 * throws out to the caller.
 */

import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';

import { getClient, logMemoryWarning } from '../memory/client.js';
import { getLogger } from '../tools/forge-logger.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // bytes — the recommended GCM nonce size
const KEY_LENGTH = 32; // bytes — AES-256

const log = getLogger('autonomy:credential-vault');

/** One decrypted credential row, without its ciphertext. */
export interface CredentialKeyInfo {
  key: string;
  createdAt: string;
}

interface ProjectCredentialRow {
  id: string;
  project_path: string;
  credential_key: string;
  credential_value: string;
  created_at: string;
}

/**
 * Derive the 32-byte AES-256-GCM key this process will encrypt/decrypt with.
 *
 * `FORGE_VAULT_KEY` (any length, any shape) is hashed through SHA-256 so it always
 * yields exactly 32 bytes regardless of what the operator set it to. With no env
 * var set, the key is derived from this machine's hostname + OS username — stable
 * across runs on the same machine, different on every other machine/user.
 */
export function deriveVaultKey(): Buffer {
  const envKey = process.env['FORGE_VAULT_KEY'];
  if (envKey && envKey.length > 0) {
    return createHash('sha256').update(envKey, 'utf8').digest();
  }
  let username = 'unknown-user';
  try {
    username = userInfo().username;
  } catch {
    // userInfo() can throw in some sandboxed/uid-less environments — fall back rather than crash.
  }
  const material = `${hostname()}|${username}`;
  return createHash('sha256').update(material, 'utf8').digest();
}

/**
 * Encrypt `plaintext` with AES-256-GCM under `key`. Returns a single
 * `iv:authTag:ciphertext` hex-encoded string — everything needed to decrypt, in one
 * TEXT column, with a fresh random IV every call (GCM must never reuse an IV under
 * the same key).
 */
function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypt a value produced by {@link encrypt}. Returns `null` (never throws) on a
 * malformed stored value, a key mismatch, or a failed GCM auth-tag check — any of
 * which mean "this row is not readable with the current vault key," not a crash.
 */
function decrypt(stored: string, key: Buffer): string | null {
  const parts = stored.split(':');
  if (parts.length !== 3) return null;
  const [ivHex, authTagHex, ciphertextHex] = parts;
  if (ivHex === undefined || authTagHex === undefined || ciphertextHex === undefined) return null;
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');
    if (iv.length !== IV_LENGTH || authTag.length !== 16) return null;
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch (error) {
    logMemoryWarning('credential-vault.decrypt', error);
    return null;
  }
}

/**
 * Parse a `.env.local`-style file's already-declared keys (left-hand side of every
 * non-comment, non-blank `KEY=value` line). Used only to decide what NOT to
 * overwrite — {@link CredentialVault.injectIntoEnv} never touches an existing line.
 */
function parseExistingEnvKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    keys.add(line.slice(0, eq).trim());
  }
  return keys;
}

/**
 * Per-project encrypted credential store, backed by the shared Build Memory SQLite
 * database (`project_credentials`). One vault instance holds one AES key in memory
 * for its lifetime — construct a new one only if you need to encrypt/decrypt under
 * a different key (e.g. a test using an explicit key rather than the derived one).
 */
export class CredentialVault {
  private readonly key: Buffer;

  constructor(key?: Buffer) {
    this.key = key && key.length === KEY_LENGTH ? key : deriveVaultKey();
  }

  /**
   * Store `value` for `key` under `projectPath`, AES-256-GCM encrypted. Upserts —
   * calling `set` again for the same (projectPath, key) overwrites the prior value.
   * Returns `false` (never throws) if Build Memory is unavailable or the write fails.
   */
  async set(projectPath: string, key: string, value: string): Promise<boolean> {
    const db = getClient();
    if (!db) return false;
    try {
      const encrypted = encrypt(value, this.key);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO project_credentials (id, project_path, credential_key, credential_value, created_at)
         VALUES (@id, @project_path, @credential_key, @credential_value, @created_at)
         ON CONFLICT(project_path, credential_key) DO UPDATE SET
           credential_value = excluded.credential_value,
           created_at = excluded.created_at`
      ).run({
        id: randomUUID(),
        project_path: projectPath,
        credential_key: key,
        credential_value: encrypted,
        created_at: now,
      });
      return true;
    } catch (error) {
      logMemoryWarning('credential-vault.set', error);
      return false;
    }
  }

  /**
   * Retrieve and decrypt one credential. Returns `null` if the row does not exist,
   * Build Memory is unavailable, or decryption fails (e.g. the vault key changed
   * since the value was written).
   */
  async get(projectPath: string, key: string): Promise<string | null> {
    const db = getClient();
    if (!db) return null;
    try {
      const row = db
        .prepare(
          'SELECT credential_value FROM project_credentials WHERE project_path = ? AND credential_key = ?'
        )
        .get(projectPath, key) as Pick<ProjectCredentialRow, 'credential_value'> | undefined;
      if (!row) return null;
      return decrypt(row.credential_value, this.key);
    } catch (error) {
      logMemoryWarning('credential-vault.get', error);
      return null;
    }
  }

  /**
   * Retrieve and decrypt every credential stored for `projectPath`. A row that
   * fails to decrypt (key mismatch/corruption) is silently omitted rather than
   * failing the whole call — every other credential still decrypts normally.
   * Returns `{}` (never throws) if Build Memory is unavailable.
   */
  async getAll(projectPath: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const db = getClient();
    if (!db) return result;
    try {
      const rows = db
        .prepare(
          'SELECT credential_key, credential_value FROM project_credentials WHERE project_path = ?'
        )
        .all(projectPath) as Array<Pick<ProjectCredentialRow, 'credential_key' | 'credential_value'>>;
      for (const row of rows) {
        const plaintext = decrypt(row.credential_value, this.key);
        if (plaintext !== null) {
          result[row.credential_key] = plaintext;
        }
      }
      return result;
    } catch (error) {
      logMemoryWarning('credential-vault.getAll', error);
      return result;
    }
  }

  /**
   * Remove one credential. Returns `true` only if a row was actually deleted,
   * `false` if it did not exist, Build Memory is unavailable, or the delete failed.
   */
  async delete(projectPath: string, key: string): Promise<boolean> {
    const db = getClient();
    if (!db) return false;
    try {
      const result = db
        .prepare('DELETE FROM project_credentials WHERE project_path = ? AND credential_key = ?')
        .run(projectPath, key);
      return result.changes > 0;
    } catch (error) {
      logMemoryWarning('credential-vault.delete', error);
      return false;
    }
  }

  /**
   * List every credential key name stored for `projectPath` — values are never
   * decrypted or returned by this call, only the key names, sorted alphabetically.
   */
  async listKeys(projectPath: string): Promise<string[]> {
    const db = getClient();
    if (!db) return [];
    try {
      const rows = db
        .prepare(
          'SELECT credential_key FROM project_credentials WHERE project_path = ? ORDER BY credential_key ASC'
        )
        .all(projectPath) as Array<Pick<ProjectCredentialRow, 'credential_key'>>;
      return rows.map((r) => r.credential_key);
    } catch (error) {
      logMemoryWarning('credential-vault.listKeys', error);
      return [];
    }
  }

  /**
   * Append every stored credential for `projectPath` to `<projectPath>/.env.local`
   * that is NOT already declared there — a key already present (even with an empty
   * or different value) is left completely untouched; this method only ever
   * appends new `KEY=value` lines, it never rewrites or overwrites an existing one.
   *
   * Returns the number of keys actually appended (0 if nothing new, if there are no
   * stored credentials, or on any read/write failure — never throws).
   */
  async injectIntoEnv(projectPath: string): Promise<number> {
    const all = await this.getAll(projectPath);
    const keys = Object.keys(all);
    if (keys.length === 0) return 0;

    const envPath = join(projectPath, '.env.local');
    let existingContent = '';
    if (existsSync(envPath)) {
      try {
        existingContent = await readFile(envPath, 'utf8');
      } catch (error) {
        logMemoryWarning('credential-vault.injectIntoEnv:read', error);
        return 0;
      }
    }

    const existingKeys = parseExistingEnvKeys(existingContent);
    const toAppend = keys.filter((k) => !existingKeys.has(k));
    if (toAppend.length === 0) return 0;

    const needsLeadingNewline = existingContent.length > 0 && !existingContent.endsWith('\n');
    const appendedLines = toAppend.map((k) => `${k}=${all[k]}`).join('\n');
    const block = `${needsLeadingNewline ? '\n' : ''}${appendedLines}\n`;

    try {
      await appendFile(envPath, block, 'utf8');
    } catch (error) {
      logMemoryWarning('credential-vault.injectIntoEnv:write', error);
      return 0;
    }

    return toAppend.length;
  }
}

/** Construct a {@link CredentialVault}, optionally under an explicit 32-byte key (tests). */
export function createCredentialVault(key?: Buffer): CredentialVault {
  return new CredentialVault(key);
}

// Re-export so callers that only need the logger's `[AUTONOMY]` tag convention (Phase 0's
// wiring, `forge credentials` CLI surface if one is added later) can reuse the same child
// logger instead of constructing their own `getLogger('autonomy:credential-vault')` call.
export const credentialVaultLogger = log;
