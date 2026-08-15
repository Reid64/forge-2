/**
 * FORGE 2.0 — Build Memory: unified entry point.
 *
 * Re-exports every CRUD module and exposes a single `BuildMemory` object that
 * groups all operations by table. Phases call into Build Memory through this
 * object, e.g. `BuildMemory.builds.createBuild(...)`,
 * `BuildMemory.errors.findMatchingPattern(...)`.
 *
 * Per BEHAVIORAL_CONTRACTS.md Contract 4, all operations degrade gracefully:
 * when Build Memory is unreachable they log a warning and return null rather
 * than crashing FORGE.
 *
 * Note: several modules expose same-named helpers (e.g. resolutions and insights
 * both have `incrementApplied`). They are therefore exposed as namespaces — both
 * via the `BuildMemory` facade and as named module re-exports below — rather than
 * flattened into a single namespace, which would be ambiguous.
 */

import * as builds from './builds.js';
import * as prompts from './prompts.js';
import * as errors from './errors.js';
import * as resolutions from './resolutions.js';
import * as governance from './governance.js';
import * as agents from './agents.js';
import * as insights from './insights.js';
import * as telemetry from './telemetry.js';
import * as profiles from './profiles.js';
import * as patterns from './patterns.js';
import * as brands from './brands.js';
import * as scheduledTasks from './scheduled-tasks.js';
import * as adr from './adr.js';
import * as assumptions from './assumptions.js';
import * as risks from './risks.js';
import * as techDebt from './tech-debt.js';
import { getClient, resetClient } from './client.js';

// Per-module namespaces (avoids cross-module function-name collisions).
export {
  builds,
  prompts,
  errors,
  resolutions,
  governance,
  agents,
  insights,
  telemetry,
  profiles,
  patterns,
  brands,
  scheduledTasks,
  adr,
  assumptions,
  risks,
  techDebt,
};

// Type-only re-exports — insert/update input types are uniquely named, so these
// never collide.

export { getClient, resetClient, logMemoryWarning, nowIso, runQuery } from './client.js';

/**
 * Unified Build Memory facade — all CRUD modules grouped by table. This is the
 * primary interface the rest of FORGE uses to read and write Build Memory.
 */
export const BuildMemory = {
  builds,
  prompts,
  errors,
  resolutions,
  governance,
  agents,
  insights,
  telemetry,
  profiles,
  patterns,
  brands,
  scheduledTasks,
  adr,
  assumptions,
  risks,
  techDebt,
  /** Direct access to the underlying SQLite database handle (or null in stateless mode). */
  getClient,
  /** Reset the cached database handle (tests / re-initializing). */
  resetClient,
} as const;

export default BuildMemory;

