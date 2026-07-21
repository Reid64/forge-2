/**
 * FORGE 2.0 — Native Orchestrator — barrel export.
 *
 * Single entry point for the orchestrator layer (see `engine.ts`'s module doc for the
 * three-layer architecture this replaces). Re-exports each module's factory function so
 * callers outside `src/orchestrator/` never need to import the individual files directly.
 */

export { createOrchestratorEngine } from './engine.js';
export { createManifestResolver } from './manifest-resolver.js';
export { createQueueRunner } from './queue-runner.js';
export { createLibraryManager } from './library-manager.js';
export { syncGovernanceDocs } from './governance-sync.js';
