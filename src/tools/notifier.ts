/**
 * FORGE 2.0 — Notification system (`notifier`).
 *
 * The single sink FORGE routes operator-facing ALERTS through — most importantly the
 * alerts a failed scheduled task raises (see `task-scheduler.ts`), but usable by any
 * module that needs to surface a critical/warning/info event.
 *
 * An {@link Alert} is delivered two ways by the default notifier:
 *   1. STRUCTURED LOG — at a level derived from severity (critical/warning → error/warn,
 *      info → info) through `forge-logger`, so alerts flow into the same JSON-lines
 *      pipeline `log-search` reads.
 *   2. BUILD MEMORY — a `production_telemetry` `error` event (project `FORGE`) carrying
 *      the alert payload + severity, so alerts are queryable across restarts and show up
 *      alongside the critical-events feed the rest of FORGE already surfaces.
 *
 * Additional sinks (a webhook, an email relay, a desktop toast) are injected as extra
 * {@link AlertSink} functions — the notifier fans an alert out to all of them and never
 * lets one failing sink break another (or the caller). HOUSE RULES: never throws on a
 * notify call (Contract 4 — a downed Build Memory or sink degrades to a logged warning,
 * never a halt); secret VALUES are never read or logged (callers own their payloads).
 */

import type { JsonObject } from '../types/index.js';
import BuildMemory from '../memory/index.js';
import { getLogger, type ForgeLogger } from './forge-logger.js';

/** Alert urgency. Mirrors `production_telemetry.severity`. */
export type AlertSeverity = 'critical' | 'warning' | 'info';

/** A single operator-facing alert. */
export interface Alert {
  /** Short origin label, e.g. `scheduler:health_check`. */
  source: string;
  /** One-line headline. */
  title: string;
  /** Human-readable detail (an error message, a count, a next step). */
  detail: string;
  /** Urgency. Default `warning` when omitted at the call site. */
  severity?: AlertSeverity;
  /** Optional structured context merged into the telemetry payload. */
  context?: JsonObject;
}

/** A delivery channel for alerts. Should not throw; the notifier guards it anyway. */
export type AlertSink = (alert: Required<Pick<Alert, 'source' | 'title' | 'detail'>> & {
  severity: AlertSeverity;
  context: JsonObject;
}) => void | Promise<void>;

/** The notification surface the rest of FORGE depends on. */
export interface Notifier {
  /** Deliver an alert to every configured sink. Never throws. */
  notify(alert: Alert): Promise<void>;
}

/** Tuning + extra sinks for {@link createNotifier}. All optional. */
export interface NotifierOptions {
  /** Project name stamped on the telemetry event. Default `FORGE`. */
  project?: string;
  /** Extra delivery channels (webhook, email, …) fanned out alongside the defaults. */
  sinks?: readonly AlertSink[];
  /** Override the structured logger (tests). */
  logger?: ForgeLogger;
  /** Disable the Build Memory telemetry sink (tests / pure-log mode). */
  disableTelemetry?: boolean;
}

const DEFAULT_PROJECT = 'FORGE';

/** Map an alert severity to a Pino log level. */
function levelForSeverity(severity: AlertSeverity): 'error' | 'warn' | 'info' {
  if (severity === 'critical') return 'error';
  if (severity === 'warning') return 'warn';
  return 'info';
}

/**
 * Build the default FORGE notifier: a structured-log sink + a Build Memory
 * `production_telemetry` sink, plus any extra sinks supplied. Each `notify` call
 * fans out to all sinks; a failing sink is logged and swallowed so it never breaks
 * delivery to the others or the caller.
 */
export function createNotifier(options: NotifierOptions = {}): Notifier {
  const project = options.project ?? DEFAULT_PROJECT;
  const logger = options.logger ?? getLogger('notifier');
  const extraSinks = options.sinks ?? [];

  const logSink: AlertSink = (alert) => {
    const level = levelForSeverity(alert.severity);
    logger[level]({ source: alert.source, severity: alert.severity, ...alert.context }, `${alert.title} — ${alert.detail}`);
  };

  const telemetrySink: AlertSink = async (alert) => {
    await BuildMemory.telemetry.createEvent({
      project_name: project,
      event_type: 'error',
      severity: alert.severity,
      event_data: {
        kind: 'alert',
        source: alert.source,
        title: alert.title,
        detail: alert.detail,
        ...alert.context,
      },
    });
  };

  const sinks: AlertSink[] = [logSink];
  if (!options.disableTelemetry) sinks.push(telemetrySink);
  sinks.push(...extraSinks);

  return {
    async notify(alert: Alert): Promise<void> {
      const normalized = {
        source: alert.source,
        title: alert.title,
        detail: alert.detail,
        severity: alert.severity ?? 'warning',
        context: alert.context ?? {},
      };
      // Fan out to every sink; isolate failures so one bad channel can't break the rest.
      await Promise.all(
        sinks.map(async (sink) => {
          try {
            await sink(normalized);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            logger.warn(`alert sink failed — ${detail}`);
          }
        })
      );
    },
  };
}

export default createNotifier;
