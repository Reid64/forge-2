/**
 * FORGE 2.0 — Structured logging substrate (`forge-logger`).
 *
 * Every diagnostic line FORGE emits flows through here. Two public shapes:
 *
 *   - {@link getLogger}(module) returns a Pino CHILD logger bound to `{ module }`. Use it when you
 *     want Pino's leveled API directly — `.info/.warn/.error/.fatal`, called either `(msg)` or
 *     `(obj, msg)`. The CLI crash paths and the memory/telemetry warn paths use this.
 *   - {@link logLine}(module) ADAPTS that child to FORGE's legacy single-string sink — a
 *     `(message: string) => void` that every phase/engine/tool module accepts as its injectable
 *     default `options.log`. Lines land at `info`.
 *
 * BUILD CONTEXT: a build run id, the project name and the currently-executing prompt id are NOT
 * threaded through every call by hand. They live in an {@link AsyncLocalStorage} populated by
 * {@link runWithBuildContext} (async-safe, auto-unwound) with a synchronous
 * {@link setLogContext}/{@link clearLogContext} fallback for code that spans `await` boundaries it
 * doesn't own (the executor sets `{ buildRunId, project }` once, then wraps each prompt). Pino's
 * `mixin` reads whichever context is active and merges it into EVERY line automatically.
 *
 * HOUSE RULES: never throws on a log call; pretty output in a TTY, plain JSON otherwise; secret
 * VALUES are never logged by this module (callers own their payloads).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import pino from 'pino';

/** Ambient build/prompt context merged into every log line. All fields optional. */
export interface LogContext {
  buildRunId?: string;
  project?: string;
  promptId?: string;
}

// AsyncLocalStorage carries context across `await` boundaries automatically; `fallback` covers the
// executor's set-once/clear-later span that no single async scope encloses. The mixin prefers the
// async store when one is active, else the synchronous fallback.
const storage = new AsyncLocalStorage<LogContext>();
let fallback: LogContext = {};

function currentContext(): LogContext {
  return storage.getStore() ?? fallback;
}

const isTty = Boolean(process.stdout && process.stdout.isTTY);

interface Sink {
  write(chunk: string): unknown;
}

// The logger's normal destination — stdout, pretty-printed in a TTY exactly as before. `gate`
// wraps it so a caller can temporarily divert every line elsewhere (see `beginQuietLogging`)
// without tearing down or reconstructing the pino instance (and losing the pino-pretty worker).
const realDestination: Sink = isTty
  ? (pino.transport({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
    }) as unknown as Sink)
  : process.stdout;

let quietSink: Sink | null = null;

const gate: Sink = {
  write(chunk: string): unknown {
    return (quietSink ?? realDestination).write(chunk);
  },
};

const root = pino(
  {
    level: process.env['FORGE_LOG_LEVEL'] ?? 'info',
    // Merge the active build/prompt context into every line. Returns a fresh object each call so
    // Pino never holds a reference to mutable state.
    mixin() {
      return { ...currentContext() };
    },
  },
  gate
);

/**
 * Divert every line this logger emits (from ANY module — `getLogger`/`logLine` is a shared
 * singleton) to `logFilePath` instead of stdout, until the returned function is called. Used by
 * Phase 3 to keep its collaborators' (hook-manager, the predictor) diagnostic JSON off stdout
 * while it owns the terminal with its own human-readable progress renderer — every OTHER caller
 * of `getLogger`/`logLine` keeps writing to stdout normally outside that window.
 */
export function beginQuietLogging(logFilePath: string): () => void {
  let stream: WriteStream | null = null;
  try {
    mkdirSync(dirname(logFilePath), { recursive: true });
    stream = createWriteStream(logFilePath, { flags: 'a' });
  } catch {
    return () => {}; // best-effort — a build must never fail because its log file couldn't open
  }
  const openedStream = stream;
  const previousQuietSink = quietSink;
  quietSink = { write: (chunk: string) => openedStream.write(chunk) };
  return () => {
    quietSink = previousQuietSink;
    openedStream.end();
  };
}

/**
 * Tee every `console.log`/`console.warn`/`console.error` call to BOTH the terminal (unchanged —
 * unlike {@link beginQuietLogging}'s redirect, this never removes live output) AND `logFilePath`,
 * until the returned function is called. For commands a human runs interactively and watches
 * (`repair`, `retrofit`, `sequence`, the `forge design` family, `benchmark`) that log exclusively
 * via raw `console.*`/`process.stdout.write` rather than `getLogger`/`logLine` — those commands
 * had NO crash-recoverable trail at all (Finding H-2): a crash mid-run left only terminal
 * scrollback. This does not intercept `process.stdout.write` directly (several of these commands
 * use it for single-line progress bars / spinners that redraw in place — teeing that verbatim to
 * a file would produce a garbled, carriage-return-laden log); callers that want a specific
 * progress line durably logged should also route it through `console.log`.
 */
export function beginTeeLogging(logFilePath: string): () => void {
  let stream: WriteStream | null = null;
  try {
    mkdirSync(dirname(logFilePath), { recursive: true });
    stream = createWriteStream(logFilePath, { flags: 'a' });
  } catch {
    return () => {}; // best-effort — the command must never fail because its log file couldn't open
  }
  const openedStream = stream;
  const original = { log: console.log, warn: console.warn, error: console.error };
  const append = (...args: unknown[]): void => {
    try {
      const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      openedStream.write(`[${new Date().toISOString()}] ${line}\n`);
    } catch {
      /* best-effort */
    }
  };
  console.log = (...args: unknown[]) => {
    append(...args);
    original.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    append(...args);
    original.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    append(...args);
    original.error(...args);
  };
  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    openedStream.end();
  };
}

/** A Pino logger bound to `{ module }`. Leveled API: `.info/.warn/.error/.fatal`, `(msg)` or `(obj, msg)`. */
export type ForgeLogger = pino.Logger;

/**
 * Return a Pino child logger tagged with `module`. Children are cheap; call per-module at use site.
 */
export function getLogger(module: string): ForgeLogger {
  return root.child({ module });
}

/**
 * Adapt {@link getLogger} to FORGE's legacy single-string sink. The returned function logs each
 * message at `info` under `module`. This is the default value for every module's `options.log`.
 */
export function logLine(module: string): (message: string) => void {
  const logger = getLogger(module);
  return (message: string) => {
    logger.info(message);
  };
}

/**
 * Set the synchronous ambient context (merged into MERGE with whatever is already present). Use
 * when the lifetime of the context spans async work this caller does not wrap directly — the
 * executor calls this once with `{ buildRunId, project }` after the build row is created.
 */
export function setLogContext(context: LogContext): void {
  fallback = { ...fallback, ...context };
}

/** Drop the synchronous ambient context. Called when a build finishes so the next build starts clean. */
export function clearLogContext(): void {
  fallback = {};
}

/**
 * Run `fn` with `context` merged onto the active context for the duration of the async call,
 * unwound automatically on return. Preferred over {@link setLogContext} for a bounded scope — the
 * executor wraps each prompt's execution in `runWithBuildContext({ promptId }, …)`.
 */
export function runWithBuildContext<T>(context: LogContext, fn: () => T | Promise<T>): Promise<T> {
  const merged = { ...currentContext(), ...context };
  return Promise.resolve(storage.run(merged, fn));
}
