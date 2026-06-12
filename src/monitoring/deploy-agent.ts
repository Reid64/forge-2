/**
 * FORGE 2.0 — Post-Deploy Monitoring Agent (snippet generator).
 *
 * Generates a small, self-contained JavaScript snippet that is injected into a
 * built application's HTML. Once running in the visitor's browser the snippet
 * reports four kinds of telemetry back to a FORGE telemetry receiver (see
 * telemetry-receiver.ts):
 *
 *   1. Unhandled errors      — `window.onerror` + `unhandledrejection`: message,
 *                              stack, URL, timestamp.                (severity: critical)
 *   2. Slow page loads       — Navigation Timing load duration; reported only when
 *                              it exceeds a configurable threshold.  (severity: warning)
 *   3. API call failures     — a wrapper around `fetch` that reports any non-2xx
 *                              response (status, method, request URL).(severity: warning)
 *   4. (transport)           — every event is POSTed to the configured endpoint
 *                              via `navigator.sendBeacon`, falling back to `fetch`.
 *
 * The emitted snippet is a STRING of browser JavaScript — it is never compiled by
 * FORGE's own TypeScript build (FORGE targets Node with no DOM lib). It is written
 * defensively: every browser API is feature-detected, nothing throws, and requests
 * to the telemetry endpoint itself are never instrumented (no report-on-report
 * recursion). Each payload conforms to {@link TelemetryPayload}, which the receiver
 * validates before writing to the `production_telemetry` table.
 */

import type { TelemetryEventType, TelemetrySeverity } from '../types/index.js';

// ---------------------------------------------------------------------------
// Wire contract — shared with telemetry-receiver.ts
// ---------------------------------------------------------------------------

/**
 * The JSON body the in-browser snippet POSTs to the telemetry receiver, and the
 * shape the receiver validates. Maps directly onto `production_telemetry`
 * (see SCHEMA_REGISTRY.md): `event_data` is an open bag of event-specific fields.
 */
export interface TelemetryPayload {
  /** Deployed app name — matches `production_telemetry.project_name`. */
  project_name: string;
  /** Build that produced this app, if known (FK to build_runs). */
  build_run_id?: string | null;
  /** error | performance | usage | feedback. */
  event_type: TelemetryEventType;
  /** critical | warning | info. */
  severity?: TelemetrySeverity;
  /** ISO 8601 timestamp captured client-side at the moment of the event. */
  captured_at: string;
  /** Event-specific payload (error details, timing metric, failed request, …). */
  event_data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Snippet configuration
// ---------------------------------------------------------------------------

/** Options that parameterize a generated monitoring snippet. */
export interface MonitoringSnippetOptions {
  /** Absolute URL of the FORGE telemetry receiver (POST target). Required. */
  endpoint: string;
  /** Deployed app name reported with every event. Required. */
  projectName: string;
  /** Build that produced this app (FK to build_runs), if known. */
  buildRunId?: string | null;
  /** Page-load duration over which a `performance` event is reported. Default 3000ms. */
  slowPageLoadMs?: number;
  /** Instrument unhandled errors / promise rejections. Default true. */
  captureErrors?: boolean;
  /** Instrument page-load timing. Default true. */
  capturePageLoad?: boolean;
  /** Instrument `fetch` for non-2xx responses. Default true. */
  captureApiFailures?: boolean;
}

/** Resolved configuration embedded (as JSON) into the snippet. */
interface ResolvedConfig {
  endpoint: string;
  projectName: string;
  buildRunId: string | null;
  slowPageLoadMs: number;
  captureErrors: boolean;
  capturePageLoad: boolean;
  captureApiFailures: boolean;
}

const DEFAULT_SLOW_PAGE_LOAD_MS = 3000;

/** Apply defaults and validate the required options. Throws on missing required fields. */
function resolveOptions(options: MonitoringSnippetOptions): ResolvedConfig {
  if (!options || typeof options.endpoint !== 'string' || options.endpoint.trim() === '') {
    throw new Error('generateMonitoringSnippet: `endpoint` is required.');
  }
  if (typeof options.projectName !== 'string' || options.projectName.trim() === '') {
    throw new Error('generateMonitoringSnippet: `projectName` is required.');
  }
  const slow = options.slowPageLoadMs ?? DEFAULT_SLOW_PAGE_LOAD_MS;
  return {
    endpoint: options.endpoint.trim(),
    projectName: options.projectName.trim(),
    buildRunId: options.buildRunId ?? null,
    slowPageLoadMs: Number.isFinite(slow) && slow > 0 ? slow : DEFAULT_SLOW_PAGE_LOAD_MS,
    captureErrors: options.captureErrors ?? true,
    capturePageLoad: options.capturePageLoad ?? true,
    captureApiFailures: options.captureApiFailures ?? true,
  };
}

// ---------------------------------------------------------------------------
// Snippet body
// ---------------------------------------------------------------------------

/**
 * Browser-side monitoring agent, as a string. Written in ES5-compatible,
 * concatenation-only JavaScript (NO template literals, so it can be safely nested
 * inside this module's own template literal) and wrapped in an IIFE that guards
 * against double-installation. The single interpolation point is `__FORGE_CFG__`,
 * replaced with the JSON-serialized {@link ResolvedConfig}.
 */
const SNIPPET_BODY = `(function () {
  if (typeof window === 'undefined') { return; }
  if (window.__FORGE_MONITOR_INSTALLED__) { return; }
  window.__FORGE_MONITOR_INSTALLED__ = true;

  var CFG = __FORGE_CFG__;

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return ''; }
  }

  function currentUrl() {
    try { return (window.location && window.location.href) || ''; } catch (e) { return ''; }
  }

  // Never instrument the telemetry endpoint itself (avoids report-on-report loops).
  function isTelemetryUrl(url) {
    try { return typeof url === 'string' && url.indexOf(CFG.endpoint) === 0; }
    catch (e) { return false; }
  }

  function send(eventType, severity, data) {
    var payload = {
      project_name: CFG.projectName,
      build_run_id: CFG.buildRunId,
      event_type: eventType,
      severity: severity,
      captured_at: nowIso(),
      event_data: data || {}
    };
    var body;
    try { body = JSON.stringify(payload); } catch (e) { return; }
    try {
      if (navigator && typeof navigator.sendBeacon === 'function') {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(CFG.endpoint, blob)) { return; }
      }
    } catch (e) { /* fall through to fetch */ }
    try {
      if (typeof window.fetch === 'function') {
        window.__FORGE_RAW_FETCH__
          ? window.__FORGE_RAW_FETCH__(CFG.endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: body,
              keepalive: true
            })['catch'](function () {})
          : window.fetch(CFG.endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: body,
              keepalive: true
            })['catch'](function () {});
      }
    } catch (e) { /* give up silently */ }
  }

  // --- 1. Unhandled errors -------------------------------------------------
  if (CFG.captureErrors) {
    window.addEventListener('error', function (event) {
      var err = event && event.error;
      send('error', 'critical', {
        kind: 'error',
        message: (event && event.message) || (err && err.message) || 'Unknown error',
        stack: (err && err.stack) ? String(err.stack) : null,
        source: (event && event.filename) || null,
        line: (event && event.lineno) || null,
        column: (event && event.colno) || null,
        url: currentUrl()
      });
    });
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event && event.reason;
      var message = reason && reason.message ? reason.message : String(reason);
      send('error', 'critical', {
        kind: 'unhandledrejection',
        message: message,
        stack: (reason && reason.stack) ? String(reason.stack) : null,
        url: currentUrl()
      });
    });
  }

  // --- 2. Slow page load ---------------------------------------------------
  if (CFG.capturePageLoad) {
    window.addEventListener('load', function () {
      // Defer one tick so the load event's own duration is included.
      setTimeout(function () {
        var durationMs = null;
        try {
          if (window.performance && typeof window.performance.getEntriesByType === 'function') {
            var nav = window.performance.getEntriesByType('navigation')[0];
            if (nav && typeof nav.duration === 'number') { durationMs = Math.round(nav.duration); }
          }
          if (durationMs === null && window.performance && window.performance.timing) {
            var t = window.performance.timing;
            if (t.loadEventEnd && t.navigationStart) {
              durationMs = t.loadEventEnd - t.navigationStart;
            }
          }
        } catch (e) { durationMs = null; }
        if (durationMs !== null && durationMs > CFG.slowPageLoadMs) {
          send('performance', 'warning', {
            metric: 'page_load',
            durationMs: durationMs,
            thresholdMs: CFG.slowPageLoadMs,
            url: currentUrl()
          });
        }
      }, 0);
    });
  }

  // --- 3. API call failures (non-2xx) -------------------------------------
  if (CFG.captureApiFailures && typeof window.fetch === 'function') {
    var rawFetch = window.fetch.bind(window);
    window.__FORGE_RAW_FETCH__ = rawFetch;
    window.fetch = function (input, init) {
      var requestUrl = '';
      try { requestUrl = (typeof input === 'string') ? input : (input && input.url) || ''; }
      catch (e) { requestUrl = ''; }
      var method = 'GET';
      try {
        method = (init && init.method) || (input && input.method) || 'GET';
      } catch (e) { method = 'GET'; }

      var promise = rawFetch(input, init);
      if (!isTelemetryUrl(requestUrl)) {
        promise.then(function (response) {
          try {
            if (response && (response.status < 200 || response.status >= 300)) {
              send('error', 'warning', {
                kind: 'api_failure',
                requestUrl: requestUrl,
                method: String(method).toUpperCase(),
                status: response.status,
                statusText: response.statusText || null,
                url: currentUrl()
              });
            }
          } catch (e) { /* ignore */ }
          return response;
        })['catch'](function (error) {
          send('error', 'warning', {
            kind: 'api_failure',
            requestUrl: requestUrl,
            method: String(method).toUpperCase(),
            status: 0,
            statusText: (error && error.message) ? error.message : 'Network error',
            url: currentUrl()
          });
        });
      }
      return promise;
    };
  }
})();`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the FORGE monitoring snippet as raw browser JavaScript.
 *
 * Inject the returned string into a `<script>` tag (or bundle it) in the deployed
 * app's document head. Use {@link generateMonitoringScriptTag} for a ready-made
 * `<script>` element.
 */
export function generateMonitoringSnippet(options: MonitoringSnippetOptions): string {
  const config = resolveOptions(options);
  // Function replacer avoids `$`-pattern substitution in the replacement string
  // (a config value could legitimately contain `$`). "</script>" cannot appear in
  // the serialized config, but the <script> wrapper guards it anyway.
  const configJson = JSON.stringify(config);
  return SNIPPET_BODY.replace('__FORGE_CFG__', () => configJson);
}

/**
 * Generate a complete, ready-to-inject `<script>` tag containing the monitoring
 * snippet. Any `</` sequence is escaped so the inline script cannot terminate the
 * tag early.
 */
export function generateMonitoringScriptTag(options: MonitoringSnippetOptions): string {
  const snippet = generateMonitoringSnippet(options).replace(/<\//g, '<\\/');
  return `<script data-forge-monitor="${escapeAttr(options.projectName)}">${snippet}</script>`;
}

/** Minimal HTML attribute escaping for the project name in the script tag. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
