---
id: zero-downtime-deploy
name: Zero-Downtime Deployment Patterns
domain: infrastructure
tags: [deployment, migrations]
applicablePromptTypes: [feature]
---

BACKWARD-COMPATIBLE SCHEMA CHANGES FIRST: A migration that adds a column, table, or index is safe to apply before the new code deploys. A migration that renames or drops a column the OLD code still reads/writes is not — split it into expand (add the new, migrate data, dual-write) then contract (stop using the old, then drop it) across two separate deploys, never one.

DUAL-WRITE DURING TRANSITION: When moving data from an old shape to a new one, write to both during the transition window (old code still reads the old shape, new code reads the new shape) until every instance is confirmed running the new code, then backfill and cut over reads, then stop writing the old shape.

ROLLING DEPLOYMENT, NEVER ALL-AT-ONCE: Deploy to a subset of instances first, verify health, then proceed to the rest — an all-at-once deploy means a bad build takes down 100% of capacity simultaneously with no fallback instance still serving traffic.

HEALTH CHECKS GATE TRAFFIC: A new instance only receives production traffic after it passes a readiness health check (not just "process started") — an instance that is up but not yet ready to serve (still warming caches, connecting to the DB) must not receive requests.

OLD AND NEW CODE COEXIST BRIEFLY: During a rolling deploy, both the old and new code versions are serving traffic simultaneously for a window — any API/schema change must remain compatible with both versions during that window, not just the version being deployed.

INSTANT ROLLBACK PATH: Every deploy must have a tested, fast rollback (redeploy the previous build/tag) — never a deploy where rolling back requires a manual data-fix or a code change of its own to undo.
