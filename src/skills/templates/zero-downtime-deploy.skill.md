---
id: zero-downtime-deploy
name: Zero-Downtime Deployment Patterns
domain: devops
tags: [deployment]
applicablePromptTypes: [feature, api, database]
---

MIGRATIONS BACKWARD-COMPATIBLE, BEFORE CODE: Every schema migration must be safe to apply while the OLD code is still running — apply the migration first, deploy the new code second. A migration that only the new code can tolerate (a rename, a drop, a NOT NULL with no default) breaks the window where old code and new schema coexist.

ADDITIVE ONLY: Add columns, tables, and indexes; never rename or drop in the same deploy that also ships the code depending on the change. A destructive schema change is always split into a later, separate cleanup deploy once every instance is confirmed running the new code.

FEATURE FLAGS WRAP BREAKING CHANGES: Any change that isn't purely additive (a behavior change, a contract change) ships behind a feature flag defaulted OFF, so the deploy itself is a no-op and the actual behavior change is a separate, instantly-reversible flip once the deploy is verified healthy.

HEALTH CHECK BEFORE TRAFFIC SWITCH: A new instance only receives production traffic after it passes a readiness health check, not merely "process started" — an instance still warming caches or connecting to the database must not be handed live requests.

ROLLBACK PLAN BEFORE EVERY DEPLOY: No deploy ships without a tested, fast rollback path (redeploy the previous build/tag) decided in advance — never a deploy where rolling back requires a manual data-fix or a follow-up code change to undo.
