/**
 * FORGE 2.0 — Live Dashboard HTTP server (Phase 3 build-run browser dashboard).
 *
 * A lightweight, dependency-free HTTP server (Node's built-in `http` module only — no express)
 * that serves a live, auto-refreshing browser view of the CURRENTLY RUNNING `forge build`. This
 * is a SEPARATE, NEW subsystem from the existing terminal-based `forge dashboard` CLI command
 * (`src/cli/dashboard-command.ts`, which tails `.forge/runs/*.jsonl` in the terminal) — the two
 * must never be confused or merged. This module owns port 7734 (falling back to 7735, then
 * 7736 if already in use); the terminal command owns no port at all.
 *
 * The server holds the CURRENT {@link DashboardState} in memory (no persistence, no database —
 * it exists only for the lifetime of one build run) and exposes it three ways:
 *   - `GET  /`          — the full HTML dashboard (inline template, no external files/CDNs).
 *   - `GET  /api/data`  — a JSON snapshot of the current state (polled by the page every 3s).
 *   - `POST /api/stop`  — closes the server (used by {@link stop} in `index.ts`, and available
 *                          for a manual `curl -X POST` shutdown too).
 *
 * NEVER FATAL: {@link startDashboardServer} never throws. If none of the three candidate ports
 * can be bound (e.g. another FORGE build is already running one), it logs a warning and returns
 * `null` — the caller treats a `null` handle as "no dashboard this run" and the build proceeds
 * exactly as it would with `--no-dashboard` (Contract 4's degrade-never-block house rule, applied
 * to this subsystem).
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** One prompt's row in the dashboard's history table. */
export interface PromptResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'RUNNING' | 'PENDING';
  /** Wall-clock duration in ms once known; null while pending/running. */
  durationMs: number | null;
}

/** Prompt-caching savings, mirrors the accounting in `src/engine/provider-router.ts`. */
export interface DashboardCacheStats {
  /** Estimated USD saved by cache reads so far this run. */
  saved: number;
  /** Total cache-creation (cache-write) input tokens so far this run. */
  creationTokens: number;
  /** Total cache-read (cache-hit) input tokens so far this run. */
  readTokens: number;
}

/** The complete live state of one `forge build` run, as rendered by the dashboard. */
export interface DashboardState {
  project: string;
  totalPrompts: number;
  passed: number;
  failed: number;
  prompts: PromptResult[];
  currentPromptId: string | null;
  currentPromptName: string | null;
  currentPromptStartedAt: number | null;
  isComplete: boolean;
  cacheStats: DashboardCacheStats;
  /**
   * Last log lines for the live log tail (oldest first; the page renders the last 10). Optional —
   * defaults to an empty tail when a caller doesn't feed log lines.
   */
  logLines?: string[];
}

/** Candidate ports tried in order (BEHAVIORAL_CONTRACTS-style fallback, not configurable). */
export const DASHBOARD_PORT_CANDIDATES: readonly number[] = [7734, 7735, 7736];

/** The live handle returned by {@link startDashboardServer}. */
export interface DashboardServerHandle {
  /** The port actually bound (one of {@link DASHBOARD_PORT_CANDIDATES}). */
  port: number;
  /** The underlying Node server (rarely needed directly — prefer {@link stop}). */
  server: Server;
  /** Push a new state snapshot — the next `/api/data` poll (and page load) sees it. */
  updateDashboardState: (state: DashboardState) => void;
  /** Close the server cleanly. Idempotent — resolves even if already stopped. */
  stop: () => Promise<void>;
}

/** Options for {@link startDashboardServer}. */
export interface DashboardServerOptions {
  /** Progress reporter. Default logs to the console with a `[FORGE:dashboard]` prefix. */
  log?: (message: string) => void;
  /** Override the candidate ports (tests). Default {@link DASHBOARD_PORT_CANDIDATES}. */
  ports?: readonly number[];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Start the dashboard HTTP server bound to the first free port in {@link DASHBOARD_PORT_CANDIDATES}
 * (default `[7734, 7735, 7736]`). Never throws: when every candidate port is already in use, logs
 * a warning and resolves `null` instead of failing the build.
 */
export async function startDashboardServer(
  initialState: DashboardState,
  options: DashboardServerOptions = {}
): Promise<DashboardServerHandle | null> {
  const log = options.log ?? ((message: string) => console.log(`[DASHBOARD] ${message}`));
  const ports = options.ports ?? DASHBOARD_PORT_CANDIDATES;

  let state: DashboardState = initialState;
  const updateDashboardState = (next: DashboardState): void => {
    state = next;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      handleRequest(req, res, () => state, server);
    } catch {
      // A malformed request or a handler bug must never crash the build (Contract 4 house rule).
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Internal dashboard error');
    }
  });

  const bound = await bindFirstAvailablePort(server, ports);
  if (bound === null) {
    log(
      `WARNING: could not bind the live dashboard to any of ${ports.join('/')} (all in use) — ` +
        'dashboard disabled for this run.'
    );
    return null;
  }

  log(`Live at http://localhost:${bound}`);

  return {
    port: bound,
    server,
    updateDashboardState,
    stop: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Port binding (try each candidate in order, never throw)
// ---------------------------------------------------------------------------

function bindFirstAvailablePort(server: Server, ports: readonly number[]): Promise<number | null> {
  return ports.reduce<Promise<number | null>>(
    (chain, port) => chain.then((already) => (already !== null ? already : tryListen(server, port))),
    Promise.resolve(null)
  );
}

function tryListen(server: Server, port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const onError = (): void => {
      server.removeListener('error', onError);
      resolve(null);
    };
    server.once('error', onError);
    server.listen(port, () => {
      server.removeListener('error', onError);
      resolve(port);
    });
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  getState: () => DashboardState,
  server: Server
): void {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';
  const path = url.split('?')[0] ?? '/';

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(renderDashboardHtml());
    return;
  }

  if (method === 'GET' && path === '/api/data') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(getState()));
    return;
  }

  if (method === 'POST' && path === '/api/stop') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    // Close AFTER the response flushes, not synchronously inside the handler.
    setImmediate(() => server.close());
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

// ---------------------------------------------------------------------------
// HTML template (inline — no external files, no CDNs)
// ---------------------------------------------------------------------------

function renderDashboardHtml(): string {
  return PAGE_HEAD + PAGE_STYLE + PAGE_BODY + PAGE_SCRIPT + PAGE_TAIL;
}

const PAGE_HEAD =
  '<!doctype html>\n' +
  '<html lang="en">\n' +
  '<head>\n' +
  '<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<title>FORGE Live Build Dashboard</title>\n';

const PAGE_STYLE =
  '<style>\n' +
  ':root{--bg:#0D1117;--card:#161B22;--text:#E6EDF3;--muted:#8B949E;--gold:#B88A2E;' +
  '--green:#3FB950;--red:#F85149;--grey:#484F58;--border:#30363D;}\n' +
  '*{box-sizing:border-box;}\n' +
  'body{margin:0;background:var(--bg);color:var(--text);' +
  'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
  'padding:24px;}\n' +
  'h1{font-size:20px;font-weight:600;margin:0 0 4px 0;}\n' +
  '.subtitle{color:var(--muted);font-size:13px;margin:0 0 20px 0;}\n' +
  '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:16px;}\n' +
  '.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px;}\n' +
  '.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);' +
  'margin:0 0 10px 0;font-weight:600;}\n' +
  '.ring-wrap{display:flex;align-items:center;justify-content:center;flex-direction:column;}\n' +
  '.ring-num{font-size:26px;font-weight:700;margin-top:-108px;}\n' +
  '.ring-label{font-size:11px;color:var(--muted);margin-top:8px;}\n' +
  '.counters{display:flex;gap:12px;justify-content:center;}\n' +
  '.counter{text-align:center;flex:1;}\n' +
  '.counter .n{font-size:28px;font-weight:700;}\n' +
  '.counter .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;}\n' +
  '.c-pass .n{color:var(--green);}\n.c-fail .n{color:var(--red);}\n.c-rem .n{color:var(--grey);}\n' +
  '.cache-amount{font-size:26px;font-weight:700;color:var(--gold);}\n' +
  '.cache-detail{font-size:12px;color:var(--muted);margin-top:6px;}\n' +
  '.current-name{font-size:16px;font-weight:600;margin-bottom:4px;}\n' +
  '.current-timer{font-size:24px;font-weight:700;color:var(--gold);font-variant-numeric:tabular-nums;}\n' +
  '.current-idle{color:var(--muted);font-size:13px;}\n' +
  'table{width:100%;border-collapse:collapse;font-size:13px;}\n' +
  'th{text-align:left;color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;' +
  'letter-spacing:.05em;padding:6px 8px;border-bottom:1px solid var(--border);}\n' +
  'td{padding:7px 8px;border-bottom:1px solid var(--border);}\n' +
  'tr:last-child td{border-bottom:none;}\n' +
  '.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;' +
  'text-transform:uppercase;letter-spacing:.03em;}\n' +
  '.badge-pass{background:rgba(63,185,80,.15);color:var(--green);}\n' +
  '.badge-fail{background:rgba(248,81,73,.15);color:var(--red);}\n' +
  '.badge-pending{background:rgba(72,79,88,.25);color:var(--muted);}\n' +
  '.badge-running{background:rgba(184,138,46,.18);color:var(--gold);animation:pulse 1.4s ease-in-out infinite;}\n' +
  '@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.45;}}\n' +
  '.log{background:#010409;border:1px solid var(--border);border-radius:8px;padding:12px;' +
  'font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.6;' +
  'max-height:220px;overflow-y:auto;}\n' +
  '.log-line{opacity:0;animation:fadein .4s ease-out forwards;white-space:pre-wrap;word-break:break-word;}\n' +
  '@keyframes fadein{from{opacity:0;}to{opacity:1;}}\n' +
  '.banner{grid-column:1/-1;border-radius:10px;padding:20px 24px;font-weight:700;font-size:16px;' +
  'text-align:center;margin-bottom:16px;display:none;}\n' +
  '.banner.show{display:block;}\n' +
  '.banner-pass{background:rgba(63,185,80,.15);color:var(--green);border:1px solid var(--green);}\n' +
  '.banner-fail{background:rgba(248,81,73,.15);color:var(--red);border:1px solid var(--red);}\n' +
  '.full{grid-column:1/-1;}\n' +
  '</style>\n' +
  '</head>\n';

const PAGE_BODY =
  '<body>\n' +
  '<h1 id="project-title">FORGE Live Build Dashboard</h1>\n' +
  '<p class="subtitle">Auto-refreshes every 3 seconds — <span id="conn-status">connecting…</span></p>\n' +
  '<div id="banner" class="banner"></div>\n' +
  '<div class="grid">\n' +
  '  <div class="card ring-wrap">\n' +
  '    <h2>Progress</h2>\n' +
  '    <svg width="200" height="200" viewBox="0 0 200 200">\n' +
  '      <circle cx="100" cy="100" r="80" fill="none" stroke="#30363D" stroke-width="12"></circle>\n' +
  '      <circle id="ring" cx="100" cy="100" r="80" fill="none" stroke="#B88A2E" stroke-width="12" ' +
  '        stroke-linecap="round" stroke-dasharray="502.65" stroke-dashoffset="502.65" ' +
  '        transform="rotate(-90 100 100)" style="transition:stroke-dashoffset .5s ease, stroke .3s ease;">' +
  '</circle>\n' +
  '    </svg>\n' +
  '    <div class="ring-num" id="ring-num">0%</div>\n' +
  '    <div class="ring-label" id="ring-label">0 / 0 prompts</div>\n' +
  '  </div>\n' +
  '  <div class="card">\n' +
  '    <h2>Results</h2>\n' +
  '    <div class="counters">\n' +
  '      <div class="counter c-pass"><div class="n" id="count-pass">0</div><div class="l">Passed</div></div>\n' +
  '      <div class="counter c-fail"><div class="n" id="count-fail">0</div><div class="l">Failed</div></div>\n' +
  '      <div class="counter c-rem"><div class="n" id="count-rem">0</div><div class="l">Remaining</div></div>\n' +
  '    </div>\n' +
  '  </div>\n' +
  '  <div class="card">\n' +
  '    <h2>Cache savings</h2>\n' +
  '    <div class="cache-amount" id="cache-amount">Saved ~$0.00</div>\n' +
  '    <div class="cache-detail" id="cache-detail">0 read tokens vs 0 creation tokens</div>\n' +
  '  </div>\n' +
  '  <div class="card">\n' +
  '    <h2>Current prompt</h2>\n' +
  '    <div class="current-name" id="current-name">—</div>\n' +
  '    <div class="current-timer" id="current-timer">--:--</div>\n' +
  '  </div>\n' +
  '  <div class="card full">\n' +
  '    <h2>Prompt history</h2>\n' +
  '    <table>\n' +
  '      <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Duration</th></tr></thead>\n' +
  '      <tbody id="history-body"></tbody>\n' +
  '    </table>\n' +
  '  </div>\n' +
  '  <div class="card full">\n' +
  '    <h2>Log tail</h2>\n' +
  '    <div class="log" id="log-tail"></div>\n' +
  '  </div>\n' +
  '</div>\n';

const PAGE_SCRIPT =
  '<script>\n' +
  '(function(){\n' +
  '  var RING_CIRCUMFERENCE = 502.65;\n' +
  '  var lastLogCount = 0;\n' +
  '  var currentStartedAt = null;\n' +
  '  var timerInterval = null;\n' +
  '\n' +
  '  function fmtDuration(ms){\n' +
  '    if (ms === null || ms === undefined) return "--:--";\n' +
  '    var totalSec = Math.max(0, Math.round(ms/1000));\n' +
  '    var m = Math.floor(totalSec/60), s = totalSec%60;\n' +
  '    return (m<10?"0":"")+m+":"+(s<10?"0":"")+s;\n' +
  '  }\n' +
  '\n' +
  '  function escapeHtml(s){\n' +
  '    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");\n' +
  '  }\n' +
  '\n' +
  '  function badge(status){\n' +
  '    var cls = "badge-pending", label = "PENDING";\n' +
  '    if (status === "PASS"){ cls = "badge-pass"; label = "PASS"; }\n' +
  '    else if (status === "FAIL"){ cls = "badge-fail"; label = "FAIL"; }\n' +
  '    else if (status === "RUNNING"){ cls = "badge-running"; label = "RUNNING"; }\n' +
  '    return "<span class=\\"badge " + cls + "\\">" + label + "</span>";\n' +
  '  }\n' +
  '\n' +
  '  function render(state){\n' +
  '    document.getElementById("project-title").textContent = "FORGE Live Build — " + (state.project || "");\n' +
  '    document.getElementById("conn-status").textContent = "connected";\n' +
  '\n' +
  '    var total = state.totalPrompts || 0;\n' +
  '    var passed = state.passed || 0;\n' +
  '    var failed = state.failed || 0;\n' +
  '    var done = passed + failed;\n' +
  '    var remaining = Math.max(0, total - done);\n' +
  '    var pct = total > 0 ? Math.min(1, done/total) : 0;\n' +
  '\n' +
  '    var ring = document.getElementById("ring");\n' +
  '    ring.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE * (1 - pct)));\n' +
  '    var ringColor = "#B88A2E";\n' +
  '    if (state.isComplete) ringColor = failed > 0 ? "#F85149" : "#3FB950";\n' +
  '    ring.setAttribute("stroke", ringColor);\n' +
  '    document.getElementById("ring-num").textContent = Math.round(pct*100) + "%";\n' +
  '    document.getElementById("ring-label").textContent = done + " / " + total + " prompts";\n' +
  '\n' +
  '    document.getElementById("count-pass").textContent = String(passed);\n' +
  '    document.getElementById("count-fail").textContent = String(failed);\n' +
  '    document.getElementById("count-rem").textContent = String(remaining);\n' +
  '\n' +
  '    var cache = state.cacheStats || { saved: 0, creationTokens: 0, readTokens: 0 };\n' +
  '    document.getElementById("cache-amount").textContent = "Saved ~$" + Number(cache.saved||0).toFixed(2);\n' +
  '    document.getElementById("cache-detail").textContent =\n' +
  '      Number(cache.readTokens||0).toLocaleString() + " read tokens vs " +\n' +
  '      Number(cache.creationTokens||0).toLocaleString() + " creation tokens";\n' +
  '\n' +
  '    var banner = document.getElementById("banner");\n' +
  '    if (state.isComplete){\n' +
  '      banner.className = "banner show " + (failed > 0 ? "banner-fail" : "banner-pass");\n' +
  '      banner.textContent = (failed > 0 ? "BUILD FAILED — " : "BUILD COMPLETE — ") +\n' +
  '        passed + " passed, " + failed + " failed";\n' +
  '    } else {\n' +
  '      banner.className = "banner";\n' +
  '    }\n' +
  '\n' +
  '    if (state.currentPromptId){\n' +
  '      document.getElementById("current-name").textContent =\n' +
  '        "#" + state.currentPromptId + " — " + (state.currentPromptName || "");\n' +
  '      currentStartedAt = state.currentPromptStartedAt;\n' +
  '    } else {\n' +
  '      document.getElementById("current-name").textContent = state.isComplete ? "Build complete" : "Idle";\n' +
  '      currentStartedAt = null;\n' +
  '      document.getElementById("current-timer").textContent = "--:--";\n' +
  '    }\n' +
  '\n' +
  '    var rows = state.prompts || [];\n' +
  '    var body = document.getElementById("history-body");\n' +
  '    var html = "";\n' +
  '    for (var i=0;i<rows.length;i++){\n' +
  '      var r = rows[i];\n' +
  '      html += "<tr><td>" + escapeHtml(r.id) + "</td><td>" + escapeHtml(r.name) + "</td><td>" +\n' +
  '        badge(r.status) + "</td><td>" + fmtDuration(r.durationMs) + "</td></tr>";\n' +
  '    }\n' +
  '    body.innerHTML = html || "<tr><td colspan=\\"4\\" style=\\"color:#8B949E;\\">No prompts yet</td></tr>";\n' +
  '\n' +
  '    var lines = (state.logLines || []).slice(-10);\n' +
  '    var logEl = document.getElementById("log-tail");\n' +
  '    if (lines.length !== lastLogCount){\n' +
  '      var lhtml = "";\n' +
  '      for (var j=0;j<lines.length;j++){\n' +
  '        lhtml += "<div class=\\"log-line\\">" + escapeHtml(lines[j]) + "</div>";\n' +
  '      }\n' +
  '      logEl.innerHTML = lhtml || "<div style=\\"color:#8B949E;\\">(no log output yet)</div>";\n' +
  '      logEl.scrollTop = logEl.scrollHeight;\n' +
  '      lastLogCount = lines.length;\n' +
  '    }\n' +
  '  }\n' +
  '\n' +
  '  function tick(){\n' +
  '    if (currentStartedAt){\n' +
  '      document.getElementById("current-timer").textContent = fmtDuration(Date.now() - currentStartedAt);\n' +
  '    }\n' +
  '  }\n' +
  '  timerInterval = setInterval(tick, 1000);\n' +
  '\n' +
  '  function poll(){\n' +
  '    fetch("/api/data").then(function(r){ return r.json(); }).then(render).catch(function(){\n' +
  '      document.getElementById("conn-status").textContent = "disconnected — retrying…";\n' +
  '    });\n' +
  '  }\n' +
  '  poll();\n' +
  '  setInterval(poll, 3000);\n' +
  '})();\n' +
  '</script>\n';

const PAGE_TAIL = '</body>\n</html>\n';

export default startDashboardServer;
