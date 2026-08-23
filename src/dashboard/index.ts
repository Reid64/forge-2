/**
 * FORGE 2.0 — Live Dashboard (public entry point).
 *
 * {@link startDashboard} is the one function Phase 3 (or the CLI) needs: it boots the HTTP
 * server (`server.ts`), and returns an `{ update, stop }` handle that works EVEN WHEN the server
 * failed to bind a port (every candidate in {@link DASHBOARD_PORT_CANDIDATES} already in use) —
 * `update`/`stop` are then harmless no-ops, so a caller never needs to null-check the dashboard
 * before calling them (mirrors the rest of FORGE's Contract-4 degrade-never-block house rule).
 */

import { startDashboardServer, type DashboardState, type DashboardServerOptions } from './server.js';

export type {
  DashboardState,
  PromptResult,
  DashboardCacheStats,
  DashboardServerHandle,
  DashboardServerOptions,
} from './server.js';
export { DASHBOARD_PORT_CANDIDATES } from './server.js';

/** The handle Phase 3 holds for the lifetime of one build run. */
export interface DashboardHandle {
  /** Push a new state snapshot — the browser's next 3s poll sees it. No-op if the server never bound. */
  update: (state: DashboardState) => void;
  /** Close the dashboard server. No-op (and safe to call more than once) if it never bound. */
  stop: () => void;
  /** The port actually bound (7734, or the first free fallback), or null if none bound. */
  port: number | null;
}

/**
 * Start the live dashboard for one build run. Never throws and never blocks the build on a
 * bind failure — see the module note. Prints nothing itself beyond what `server.ts` logs
 * (`[DASHBOARD] Live at http://localhost:<port>` on success, a `WARNING:` line on failure).
 */
export async function startDashboard(
  initialState: DashboardState,
  options: DashboardServerOptions = {}
): Promise<DashboardHandle> {
  const handle = await startDashboardServer(initialState, options);

  if (handle === null) {
    return { update: () => {}, stop: () => {}, port: null };
  }

  return {
    update: (state: DashboardState) => handle.updateDashboardState(state),
    stop: () => {
      // Fire-and-forget: the caller's contract is synchronous `() => void`; a close error would
      // only mean the process was already shutting down, which is fine either way.
      void handle.stop();
    },
    port: handle.port,
  };
}

export default startDashboard;
