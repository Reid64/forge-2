/**
 * FORGE 2.0 — Telemetry Receiver.
 *
 * NOT orphaned despite zero in-repo callers (Finding G-1, 2026-09-02 audit, re-confirmed here):
 * `governance/queue.yaml` documents this as an intentionally standalone-deployable route handler
 * — it ships as an endpoint inside a FORGE-built target project (wired to that project's own
 * server), not as something FORGE's own CLI process calls. No wiring gap to fix.
 *
 * Receives telemetry POSTs from deployed applications (emitted by the in-browser
 * snippet from deploy-agent.ts), validates them, and writes them to the
 * `production_telemetry` table in Build Memory. Critical-severity errors are also
 * logged to the console, tagged with the project name, for at-a-glance operator
 * visibility.
 *
 * Three transports are supported, all sharing one validate-and-store core
 * ({@link ingestTelemetry}):
 *
 *   - Express / Vercel serverless: {@link handleTelemetry} — an `(req, res)` route
 *     handler. `req.body` must already be parsed JSON (express.json() / Vercel does
 *     this automatically). Suitable as a Vercel function default export.
 *   - Standalone Node server:       {@link createTelemetryServer} — a `node:http`
 *     server that parses the request body itself, so it needs no framework.
 *
 * Per BEHAVIORAL_CONTRACTS.md Contract 4, a Build Memory write failure is NOT
 * fatal: the event is logged and the request still returns a non-error status so a
 * deployed app is never punished for FORGE's storage being offline.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { getLogger } from '../tools/forge-logger.js';
import { BuildMemory } from '../memory/index.js';
import { validateMemoryWrite } from '../tools/schema-validator.js';
import type { NewProductionTelemetry } from '../memory/telemetry.js';
import type {
  Json,
  JsonObject,
  TelemetryEventType,
  TelemetrySeverity,
} from '../types/index.js';
import type { TelemetryPayload } from './deploy-agent.js';

// ---------------------------------------------------------------------------
// Express / Vercel-compatible request & response shapes
// ---------------------------------------------------------------------------

/**
 * The subset of an Express / Vercel request this handler reads. Declaring it
 * locally avoids a dependency on `express` (FORGE ships no web framework) while
 * remaining structurally compatible with both.
 */
export interface TelemetryRequest {
  method?: string | undefined;
  /** Pre-parsed JSON body (express.json() / Vercel). May be a string if unparsed. */
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

/** The subset of an Express / Vercel response this handler writes. */
export interface TelemetryResponse {
  status(code: number): TelemetryResponse;
  json(body: unknown): unknown;
  setHeader?(name: string, value: string): unknown;
  end?(chunk?: string): unknown;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Outcome of validating an incoming request body. */
type ValidationResult =
  | { ok: true; value: TelemetryPayload }
  | { ok: false; error: string };

const EVENT_TYPES: ReadonlySet<TelemetryEventType> = new Set([
  'error',
  'performance',
  'usage',
  'feedback',
]);

const SEVERITIES: ReadonlySet<TelemetrySeverity> = new Set(['critical', 'warning', 'info']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Validate an arbitrary request body against the {@link TelemetryPayload} contract.
 * Returns the normalized payload (with `captured_at` defaulted to now when absent)
 * or a human-readable error describing the first problem found.
 */
export function validatePayload(body: unknown): ValidationResult {
  // Accept either a pre-parsed object or a raw JSON string.
  let parsed: unknown = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, error: 'Body is not valid JSON.' };
    }
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'Body must be a JSON object.' };
  }

  if (!isNonEmptyString(parsed.project_name)) {
    return { ok: false, error: 'project_name is required and must be a non-empty string.' };
  }

  if (!isNonEmptyString(parsed.event_type) || !EVENT_TYPES.has(parsed.event_type as TelemetryEventType)) {
    return {
      ok: false,
      error: 'event_type is required and must be one of: error, performance, usage, feedback.',
    };
  }

  if (!isPlainObject(parsed.event_data)) {
    return { ok: false, error: 'event_data is required and must be a JSON object.' };
  }

  if (parsed.severity !== undefined && parsed.severity !== null) {
    if (typeof parsed.severity !== 'string' || !SEVERITIES.has(parsed.severity as TelemetrySeverity)) {
      return { ok: false, error: 'severity, when present, must be one of: critical, warning, info.' };
    }
  }

  if (
    parsed.build_run_id !== undefined &&
    parsed.build_run_id !== null &&
    typeof parsed.build_run_id !== 'string'
  ) {
    return { ok: false, error: 'build_run_id, when present, must be a string.' };
  }

  const capturedAt = isNonEmptyString(parsed.captured_at)
    ? parsed.captured_at
    : new Date().toISOString();

  const value: TelemetryPayload = {
    project_name: parsed.project_name.trim(),
    event_type: parsed.event_type as TelemetryEventType,
    event_data: parsed.event_data as Record<string, unknown>,
    captured_at: capturedAt,
    build_run_id: typeof parsed.build_run_id === 'string' ? parsed.build_run_id : null,
  };
  if (typeof parsed.severity === 'string') {
    value.severity = parsed.severity as TelemetrySeverity;
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Core ingest (transport-agnostic)
// ---------------------------------------------------------------------------

/** Result of ingesting one telemetry request, mapped to an HTTP status by callers. */
export interface IngestResult {
  /** HTTP status to return: 204 stored, 400 invalid, 202 accepted-but-not-stored. */
  status: number;
  /** Whether the event reached Build Memory. */
  stored: boolean;
  /** Error description for 400 responses; null otherwise. */
  error: string | null;
}

/**
 * Validate a raw body and, if valid, persist it to `production_telemetry`. Never
 * throws. A Build Memory write failure yields status 202 (accepted) rather than an
 * error — see the file header.
 */
export async function ingestTelemetry(body: unknown): Promise<IngestResult> {
  const validation = validatePayload(body);
  if (!validation.ok) {
    return { status: 400, stored: false, error: validation.error };
  }

  const payload = validation.value;

  // Surface critical errors to the operator immediately, with project context.
  if (payload.severity === 'critical') {
    const data = payload.event_data as Record<string, unknown>;
    const message = typeof data.message === 'string' ? data.message : '(no message)';
    const where = typeof data.url === 'string' ? data.url : 'unknown URL';
    getLogger('telemetry').error(
      `CRITICAL from "${payload.project_name}" @ ${where} — ${message}`
    );
  }

  const record: NewProductionTelemetry = {
    project_name: payload.project_name,
    event_type: payload.event_type,
    event_data: payload.event_data as JsonObject,
    captured_at: payload.captured_at,
    build_run_id: payload.build_run_id ?? null,
  };
  if (payload.severity !== undefined) {
    record.severity = payload.severity;
  }

  // Validate the write payload against the table's insert schema BEFORE insertion
  // (integration point 3, Iron Law 8). Non-blocking — a mismatch is logged to the
  // `forge-validation` channel; the write still proceeds (Contract 4 — Build Memory
  // writes never halt the pipeline). The hand-rolled validatePayload above guards the
  // inbound HTTP shape; this guards the row actually handed to Build Memory.
  validateMemoryWrite('production_telemetry', record, {
    context: 'telemetry-receiver:ingest',
  });

  const created = await BuildMemory.telemetry.createEvent(record);
  if (created === null) {
    // Build Memory unreachable (stateless mode) — accept without storing.
    getLogger('telemetry').warn(
      `accepted event from "${payload.project_name}" but Build Memory write failed (stateless mode).`
    );
    return { status: 202, stored: false, error: null };
  }

  return { status: 204, stored: true, error: null };
}

// ---------------------------------------------------------------------------
// Transport 1 — Express / Vercel serverless handler
// ---------------------------------------------------------------------------

/**
 * Express / Vercel-compatible route handler. Mount at e.g. `POST /api/telemetry`.
 * Expects `req.body` to be parsed JSON (or a JSON string). Responds:
 *   - 204 stored, 202 accepted (Build Memory offline), 400 invalid, 405 wrong method.
 */
export async function handleTelemetry(
  req: TelemetryRequest,
  res: TelemetryResponse
): Promise<void> {
  if (req.method && req.method.toUpperCase() !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  const result = await ingestTelemetry(req.body);
  if (result.status === 400) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(result.status).json({ stored: result.stored });
}

/** Vercel serverless functions use a default export. */
export default handleTelemetry;

// ---------------------------------------------------------------------------
// Transport 2 — standalone node:http server
// ---------------------------------------------------------------------------

/** Maximum accepted request body size (256 KB) — telemetry payloads are tiny. */
const MAX_BODY_BYTES = 256 * 1024;

/** Read a request body as a UTF-8 string, rejecting bodies over {@link MAX_BODY_BYTES}. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Write a JSON response (or a bodiless response for 204). */
function sendJson(res: ServerResponse, status: number, body: Json | null): void {
  if (status === 204 || body === null) {
    res.writeHead(status, corsHeaders());
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() });
  res.end(text);
}

/** Permissive CORS headers so browser-side beacons/fetches are accepted cross-origin. */
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/**
 * Create a standalone telemetry server using `node:http`. It accepts `POST` (any
 * path) and `OPTIONS` (CORS preflight); other methods get 405. Call `.listen(port)`
 * on the returned server, or pass a port to {@link startTelemetryServer}.
 */
export function createTelemetryServer(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = (req.method ?? 'GET').toUpperCase();
        if (method === 'OPTIONS') {
          sendJson(res, 204, null);
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
          return;
        }

        const raw = await readBody(req);
        const result = await ingestTelemetry(raw);
        if (result.status === 400) {
          sendJson(res, 400, { error: result.error });
          return;
        }
        if (result.status === 204) {
          sendJson(res, 204, null);
          return;
        }
        sendJson(res, result.status, { stored: result.stored });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: message });
      }
    })();
  });
}

/**
 * Convenience: create and start a telemetry server on `port` (default 8787).
 * Resolves with the listening server.
 */
export function startTelemetryServer(port = 8787): Promise<Server> {
  const server = createTelemetryServer();
  return new Promise((resolve) => {
    server.listen(port, () => {
      getLogger('telemetry').info(`receiver listening on http://localhost:${port}`);
      resolve(server);
    });
  });
}
