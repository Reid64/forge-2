/**
 * FORGE 2.0 — Permission Enforcer.
 *
 * `agent-contracts.ts` DECLARES what each Phase 3 subsystem is permitted to do; this module
 * CHECKS one candidate write against that declaration. `checkPermission` is a pure, synchronous,
 * static comparison — declared path patterns vs. an actual write target — never OS-level process
 * sandboxing (nothing here can stop a subprocess from writing a file; see
 * `sentinel-prime/execution-monitor.ts`'s own BOUNDARY note for why that's out of reach for a
 * `claude -p --dangerously-skip-permissions` subprocess). It exists so a violation can be
 * DETECTED and DENIED at the next gate the build passes through, the same posture
 * `sentinel-prime/execution-monitor.ts` already established for its own (narrower) project-
 * boundary check: "OBSERVES and RECORDS violations for the caller to act on."
 *
 * House logging convention, matching `governance-enforcer.ts`/`execution-monitor.ts`: a
 * `logLine(module)` child logger, one line per violation (never per allow — an allowed write is
 * the overwhelmingly common case and logging it would just be noise, the same choice
 * `GovernanceEnforcer.enforce()` makes by only calling `this.log(...)` on a CRITICAL/WARN finding
 * or its own summary line).
 */

import { isAbsolute, relative, resolve } from 'node:path';

import { matchesGlob, normalizePath } from '../engine/path-classifier.js';
import { logLine } from '../tools/forge-logger.js';
import { AGENT_CONTRACTS, type AgentContract, type AgentId } from './agent-contracts.js';

const log = logLine('permission-enforcer');

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface CheckPermissionOptions {
  /** Which registered subsystem is attempting this write. */
  agentId: AgentId;
  /** The path being written (or deleted) — absolute, or relative to `projectPath`. */
  writeTarget: string;
  /** The target project root every `AgentContract`'s `writablePathPatterns` are relative to. */
  projectPath: string;
  /** Injectable registry, defaulting to the real one — tests substitute a smaller fixture registry. */
  contracts?: Readonly<Record<AgentId, AgentContract>>;
}

export interface PermissionCheckResult {
  allowed: boolean;
  agentId: AgentId;
  /** The `writeTarget` exactly as passed in. */
  writeTarget: string;
  /** `writeTarget` normalized and made relative to `projectPath` (forward slashes, no leading `./`). */
  normalizedPath: string;
  /** Human-readable reason — always populated, for both an allow and a deny. */
  reason: string;
}

/**
 * Decide whether `agentId` may write `writeTarget`, per its registered {@link AgentContract}.
 * Evaluation order (first match wins):
 *   1. No registered contract for `agentId` → DENY (never an implicit allow — an unregistered
 *      subsystem has no declared permissions).
 *   2. `writeTarget` resolves OUTSIDE `projectPath` → DENY (mirrors ExecutionMonitor's own
 *      project-boundary scope; every registered contract's `writablePathPatterns` are declared
 *      relative to the project root, so a path escaping it can never be matched honestly).
 *   3. `writeTarget` matches one of the contract's `deniedPathPatterns` → DENY, even if step 4
 *      would otherwise allow it (a governance-protected path a DIFFERENT subsystem owns).
 *   4. `writeTarget` matches none of the contract's `writablePathPatterns` → DENY.
 *   5. Otherwise → ALLOW.
 *
 * Never throws (Contract 4 posture, matching every sibling governance/sentinel-prime module) — a
 * malformed input degrades to the most conservative outcome (DENY), never a crash and never a
 * fabricated allow.
 */
export function checkPermission(options: CheckPermissionOptions): PermissionCheckResult {
  const { agentId, writeTarget, projectPath } = options;
  const contracts = options.contracts ?? AGENT_CONTRACTS;
  const contract = contracts[agentId];

  if (!contract) {
    return deny(agentId, writeTarget, normalizePath(writeTarget), `no registered AgentContract for agent id '${agentId}'`);
  }

  let normalizedPath: string;
  try {
    const absoluteProject = resolve(projectPath);
    const absoluteTarget = isAbsolute(writeTarget) ? resolve(writeTarget) : resolve(absoluteProject, writeTarget);
    const rel = relative(absoluteProject, absoluteTarget);
    const escapesProject = rel === '' ? false : rel.startsWith('..') || isAbsolute(rel);

    if (escapesProject) {
      return deny(
        agentId,
        writeTarget,
        normalizePath(writeTarget),
        `write target resolves outside the target project root (${projectPath}) — out-of-scope write`
      );
    }
    normalizedPath = normalizePath(rel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return deny(agentId, writeTarget, normalizePath(writeTarget), `could not resolve write target against project root: ${message}`);
  }

  for (const deniedGlob of contract.deniedPathPatterns) {
    if (matchesGlob(normalizedPath, deniedGlob)) {
      return deny(
        agentId,
        writeTarget,
        normalizedPath,
        `'${normalizedPath}' matches ${contract.name}'s denied path pattern '${deniedGlob}' (governance-protected — owned by a different subsystem)`
      );
    }
  }

  const allowedByPattern = contract.writablePathPatterns.some((glob) => matchesGlob(normalizedPath, glob));
  if (!allowedByPattern) {
    return deny(
      agentId,
      writeTarget,
      normalizedPath,
      `'${normalizedPath}' matches none of ${contract.name}'s writable path patterns ` +
        `(${contract.writablePathPatterns.length > 0 ? contract.writablePathPatterns.join(', ') : '(none declared — this subsystem performs no direct filesystem write)'})`
    );
  }

  return {
    allowed: true,
    agentId,
    writeTarget,
    normalizedPath,
    reason: `'${normalizedPath}' matches ${contract.name}'s writable path pattern(s)`,
  };
}

/**
 * Convenience batch form of {@link checkPermission} — one contract, many candidate write targets
 * (the shape `phase3-executor.ts`'s per-prompt `filesChanged()` result naturally comes in).
 * Returns only the DENIED results, in input order; an empty array means every target was allowed.
 */
export function checkPermissions(
  agentId: AgentId,
  writeTargets: readonly string[],
  projectPath: string,
  contracts?: Readonly<Record<AgentId, AgentContract>>
): PermissionCheckResult[] {
  return writeTargets
    .map((writeTarget) => checkPermission({ agentId, writeTarget, projectPath, contracts }))
    .filter((result) => !result.allowed);
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function deny(agentId: AgentId, writeTarget: string, normalizedPath: string, reason: string): PermissionCheckResult {
  log(`DENY '${agentId}' -> '${normalizedPath}': ${reason}`);
  return { allowed: false, agentId, writeTarget, normalizedPath, reason };
}
