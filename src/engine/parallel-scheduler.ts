/**
 * FORGE 2.0 — Parallel Scheduler (Phase 3 Build Executor engine, queue.yaml s5-p05).
 *
 * Pure, deterministic dependency analysis over a generated build queue ({@link QueueEntry}[]).
 * The Phase 3 Build Executor (phase3-executor s5-p05) calls {@link analyzeSchedule} to learn
 * (a) the dependency-respecting EXECUTION ORDER it must walk, and (b) which prompts have NO
 * mutual dependency and could therefore run SIMULTANEOUSLY. Per the s5-p05 spec:
 *
 *   "Analyzes queue.yaml dependencies to identify parallel groups. Prompts with no mutual
 *    dependencies can run simultaneously. For parallel execution: spawn multiple claude-runner
 *    instances, each on its own branch. Merge all to main after all pass Sentinel. Note:
 *    parallel execution is Phase 2 of FORGE 2.0 usage, not Sprint 1. For now, implement the
 *    dependency analysis and parallel group identification. Sequential execution is the default."
 *
 * So this module does the ANALYSIS only — it never spawns a process and never touches git. It
 * decomposes the queue into dependency WAVES (level by level): wave 0 is every entry with no
 * dependencies; wave N is every entry whose dependencies are all satisfied by waves < N. Within
 * a single wave no entry depends on another, so a wave is exactly the set the executor MAY fan
 * out onto separate branches once the prior waves have merged (Contract 10). The flattened
 * wave order is also a valid topological execution order for the default SEQUENTIAL path.
 *
 * It also surfaces the queue-declared `parallel_group` tags (assigned by the Queue Generator
 * s4-p02) so a parallel executor can cross-check its computed waves against the design intent.
 *
 * NON-FATAL house style (matching the sibling engine modules): a malformed queue is never a
 * throw. Dependencies that reference an unknown id are collected into `unknownDependencies`
 * (and ignored for scheduling, so the rest of the queue still schedules); a dependency CYCLE
 * (which the Queue Generator never produces, but a hand-edited queue.yaml might) is detected,
 * its members collected into `cycles`, and those members are appended AFTER the acyclic waves
 * so the executor still sees every entry. `analyzeSchedule` never throws.
 */

import type { QueueEntry } from './queue-generator.js';
import { logLine } from '../tools/forge-logger.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** A queue entry placed at its computed dependency depth. */
export interface ScheduleNode {
  /** The queue entry. */
  entry: QueueEntry;
  /** 0-based dependency depth = the wave index this entry runs in. */
  depth: number;
  /** The entry's dependencies that exist in the queue (unknown ids dropped). */
  resolvedDependencies: string[];
}

/**
 * A dependency WAVE — every entry runnable once all earlier waves have completed. No entry in
 * a wave depends on another entry in the same wave, so the whole wave is parallelizable
 * (Contract 10: each on its own branch, merged to main after all pass Sentinel).
 */
export interface ParallelWave {
  /** 0-based wave index (the dependency depth shared by its entries). */
  index: number;
  /** The entries in this wave, in original queue order. */
  entries: QueueEntry[];
}

/** The complete result of {@link analyzeSchedule}. */
export interface ScheduleAnalysis {
  /**
   * A dependency-respecting topological execution order (the flattened waves, then any cyclic
   * leftovers). The Phase 3 executor walks this for the default SEQUENTIAL path.
   */
  order: QueueEntry[];
  /** Per-entry depth + resolved dependencies, in `order`. */
  nodes: ScheduleNode[];
  /** The dependency waves; each wave is internally parallelizable. */
  waves: ParallelWave[];
  /**
   * Queue-declared parallel groups (the Queue Generator's `parallel_group` tags) → their
   * entries. A cross-check on the computed waves; empty when the queue declares none.
   */
  parallelGroups: Map<string, QueueEntry[]>;
  /** The widest wave — the maximum number of prompts that could run at once. */
  maxParallelism: number;
  /** The number of waves = the longest dependency chain (sequential depth). */
  longestChain: number;
  /** Entries that declare a dependency on an id not present in the queue. */
  unknownDependencies: Array<{ id: string; missing: string[] }>;
  /** Dependency cycles detected (each a list of the entry ids forming the cycle). */
  cycles: string[][];
  /** Non-fatal observations (duplicate ids, unknown deps, cycles, …). */
  warnings: string[];
}

/** Options for {@link analyzeSchedule}. */
export interface SchedulerOptions {
  /** Progress reporter. Default logs to the console with a `[FORGE:scheduler]` prefix. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Analyze a build queue's dependencies into a topological order, dependency waves, and the
 * queue-declared parallel groups (queue.yaml s5-p05). Pure and deterministic — the same queue
 * always yields the same analysis. Never throws: unknown dependencies are dropped (and
 * reported), cycles are detected (and their members appended after the acyclic waves).
 */
export function analyzeSchedule(
  entries: readonly QueueEntry[],
  options: SchedulerOptions = {}
): ScheduleAnalysis {
  const log = options.log ?? logLine('scheduler');
  const warnings: string[] = [];

  // Index entries by id (first occurrence wins; duplicates are flagged, not silently merged).
  const byId = new Map<string, QueueEntry>();
  const originalIndex = new Map<string, number>();
  entries.forEach((entry, i) => {
    if (byId.has(entry.id)) {
      warnings.push(`Duplicate queue id '${entry.id}' — keeping the first occurrence.`);
      return;
    }
    byId.set(entry.id, entry);
    originalIndex.set(entry.id, i);
  });

  // Resolve dependencies, recording any that reference an id not in the queue.
  const unknownDependencies: Array<{ id: string; missing: string[] }> = [];
  const resolvedDeps = new Map<string, string[]>();
  for (const entry of byId.values()) {
    const missing: string[] = [];
    const resolved: string[] = [];
    for (const dep of entry.dependencies) {
      if (byId.has(dep)) resolved.push(dep);
      else missing.push(dep);
    }
    resolvedDeps.set(entry.id, resolved);
    if (missing.length > 0) {
      unknownDependencies.push({ id: entry.id, missing });
      warnings.push(`Entry '${entry.id}' depends on unknown id(s): ${missing.join(', ')} — ignored for scheduling.`);
    }
  }

  // Kahn's algorithm with stable ordering by original queue index, computing each node's depth
  // (= 1 + max dependency depth) as it is settled — which groups the nodes into waves.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep id → ids that depend on it
  for (const id of byId.keys()) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const [id, deps] of resolvedDeps) {
    indegree.set(id, deps.length);
    for (const dep of deps) {
      const list = dependents.get(dep);
      if (list) list.push(id);
    }
  }

  const depth = new Map<string, number>();
  const settled = new Set<string>();
  let frontier = [...byId.keys()].filter((id) => (indegree.get(id) ?? 0) === 0);
  const waves: ParallelWave[] = [];
  let waveIndex = 0;

  while (frontier.length > 0) {
    // Stable order within the wave (original queue order).
    frontier.sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0));
    const waveEntries: QueueEntry[] = [];
    for (const id of frontier) {
      depth.set(id, waveIndex);
      settled.add(id);
      const entry = byId.get(id);
      if (entry) waveEntries.push(entry);
    }
    waves.push({ index: waveIndex, entries: waveEntries });

    // Decrement dependents; collect the next frontier.
    const next: string[] = [];
    for (const id of frontier) {
      for (const dependent of dependents.get(id) ?? []) {
        const remaining = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0 && !settled.has(dependent)) next.push(dependent);
      }
    }
    frontier = next;
    waveIndex += 1;
  }

  // Any entry never settled is part of a dependency cycle (or depends on one). The Queue
  // Generator never emits cycles, but a hand-edited queue.yaml might — detect, report, and
  // still surface every entry so the executor can decide what to do.
  const cycles: string[][] = [];
  const unsettled = [...byId.keys()].filter((id) => !settled.has(id));
  if (unsettled.length > 0) {
    for (const group of findCycleGroups(unsettled, resolvedDeps)) cycles.push(group);
    warnings.push(
      `Dependency cycle(s) detected among ${unsettled.length} entr(y/ies): ${unsettled.join(', ')}. ` +
        'Appended after the acyclic waves — a valid queue from the Queue Generator never cycles.'
    );
    // Append the cyclic leftovers as a final pseudo-wave (stable order) so nothing is lost.
    unsettled.sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0));
    const leftoverEntries: QueueEntry[] = [];
    for (const id of unsettled) {
      depth.set(id, waveIndex);
      const entry = byId.get(id);
      if (entry) leftoverEntries.push(entry);
    }
    waves.push({ index: waveIndex, entries: leftoverEntries });
  }

  // Flatten waves into the topological order; build the per-node detail in that order.
  const order: QueueEntry[] = [];
  const nodes: ScheduleNode[] = [];
  for (const wave of waves) {
    for (const entry of wave.entries) {
      order.push(entry);
      nodes.push({
        entry,
        depth: depth.get(entry.id) ?? wave.index,
        resolvedDependencies: resolvedDeps.get(entry.id) ?? [],
      });
    }
  }

  // Queue-declared parallel groups (cross-check on the computed waves).
  const parallelGroups = new Map<string, QueueEntry[]>();
  for (const entry of order) {
    const group = entry.parallel_group;
    if (group === undefined || group === '') continue;
    const list = parallelGroups.get(group);
    if (list) list.push(entry);
    else parallelGroups.set(group, [entry]);
  }

  const maxParallelism = waves.reduce((max, w) => Math.max(max, w.entries.length), 0);
  const longestChain = waves.length;

  log(
    `analyzed ${order.length} prompt(s): ${longestChain} wave(s), max parallelism ${maxParallelism}, ` +
      `${parallelGroups.size} declared parallel group(s)` +
      `${cycles.length > 0 ? `, ${cycles.length} cycle(s)` : ''}` +
      `${unknownDependencies.length > 0 ? `, ${unknownDependencies.length} unknown-dep entr(y/ies)` : ''}.`
  );

  return {
    order,
    nodes,
    waves,
    parallelGroups,
    maxParallelism,
    longestChain,
    unknownDependencies,
    cycles,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Cycle grouping (Tarjan's strongly-connected components over the unsettled set)
// ---------------------------------------------------------------------------

/**
 * Partition the unsettled (cyclic) ids into strongly-connected components of size > 1 (true
 * cycles). A self-dependency (id depending on itself) is also reported. Restricted to the
 * `unsettled` set so the acyclic prefix is never revisited.
 */
function findCycleGroups(unsettled: string[], resolvedDeps: Map<string, string[]>): string[][] {
  const inScope = new Set(unsettled);
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  let counter = 0;

  // Iterative Tarjan (avoids deep recursion on a pathological queue).
  for (const root of unsettled) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; depIdx: number }> = [{ node: root, depIdx: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;
      const { node } = frame;

      if (!index.has(node)) {
        index.set(node, counter);
        lowlink.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);
      }

      // Only follow dependencies that are themselves in the cyclic scope.
      const deps = (resolvedDeps.get(node) ?? []).filter((d) => inScope.has(d));
      if (frame.depIdx < deps.length) {
        const dep = deps[frame.depIdx];
        frame.depIdx += 1;
        if (dep === undefined) continue;
        if (!index.has(dep)) {
          work.push({ node: dep, depIdx: 0 });
        } else if (onStack.has(dep)) {
          lowlink.set(node, Math.min(lowlink.get(node) ?? 0, index.get(dep) ?? 0));
        }
        continue;
      }

      // Done with node's edges — settle its lowlink into its parent, then pop the frame.
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        lowlink.set(parent.node, Math.min(lowlink.get(parent.node) ?? 0, lowlink.get(node) ?? 0));
      }

      // Root of an SCC — pop the component off the stack.
      if ((lowlink.get(node) ?? 0) === (index.get(node) ?? 0)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
          if (popped === node) break;
        }
        const nodeDeps = resolvedDeps.get(node) ?? [];
        const selfLoop = component.length === 1 && nodeDeps.includes(node);
        if (component.length > 1 || selfLoop) groups.push(component.reverse());
      }
    }
  }

  return groups;
}

export default analyzeSchedule;
