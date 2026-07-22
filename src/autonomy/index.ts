/**
 * FORGE 2.0 — Autonomy layer barrel export (src/autonomy/index.ts).
 *
 * Re-exports every module under src/autonomy/ so callers (the CLI, Phase 0/3 wiring) import from
 * one place instead of reaching into each file individually — the same barrel-export convention
 * `src/orchestrator/index.ts` and `src/sentinel-prime/index.ts` already use for their layers.
 */

export * from './credential-vault.js';
export * from './vercel-deployer.js';
export * from './supabase-migrator.js';
export * from './env-validator.js';
export * from './gate-resolver.js';
export * from './health-monitor.js';
