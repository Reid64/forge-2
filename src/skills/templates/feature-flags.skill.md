---
id: feature-flags
name: Feature Flag Patterns
domain: infrastructure
tags: [deployment]
applicablePromptTypes: [feature, api]
---

FLAGS LIVE IN THE DATABASE, NOT IN CODE: A feature flag's on/off state (and its rollout percentage) is a database row, never a hardcoded boolean or an env var checked into the repo — flipping a flag must be an operational action, not a code change requiring a deploy.

SERVER-SIDE EVALUATION: Evaluate every flag server-side, never client-side-only — a client-side check can be bypassed by editing the client, so it is a UX toggle at best, never a security or billing boundary.

PERCENTAGE ROLLOUT BY USER ID HASH: A partial rollout hashes the user's stable ID (never a random number re-rolled per request) against the flag's rollout percentage, so the same user consistently lands on the same side of the flag across requests instead of flickering between old and new behavior.

NAMING CONVENTION — ENABLE_FEATURE_NAME: Every flag is named `ENABLE_<FEATURE_NAME>` (e.g. `ENABLE_NEW_CHECKOUT`) — a consistent, greppable prefix that makes every flag reference in code and in the flag store trivially searchable.

REMOVE WITHIN 30 DAYS OF FULL ROLLOUT: Once a flag reaches 100% and has stayed there through a full verification window, delete the flag and its dead conditional branch from the codebase within 30 days — a flag left in code indefinitely after its rollout decision is made is dead branch-testing surface that silently accumulates.

AUDIT LOG ON FLAG CHANGE: Every flag state change (who changed it, old value, new value, timestamp) is recorded to an audit log — a flag flip is a production change and must be traceable exactly like a deploy or a migration.
