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

const root = pino({
  level: process.env['FORGE_LOG_LEVEL'] ?? 'info',
  // Merge the active build/prompt context into every line. Returns a fresh object each call so Pino
  // never holds a reference to mutable state.
  mixin() {
    return { ...currentContext() };
  },
  ...(isTty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

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
