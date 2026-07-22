---
id: audit-logging
name: Audit Logging Standards
domain: security
tags: [security, compliance]
applicablePromptTypes: [api, database, feature]
---

SCHEMA: audit_logs table with columns id (uuid PK), user_id (uuid, who performed the action), action (text, e.g. 'create'/'update'/'delete'), resource_type (text, e.g. 'invoice'/'user'), resource_id (uuid, the affected row), old_value (jsonb, nullable), new_value (jsonb, nullable), ip_address (inet), created_at (timestamptz DEFAULT now()).

WRITE ORDER: Write the audit_logs row before applying the change (or in the same transaction as the change), never as a fire-and-forget afterthought that can silently fail to run after the mutation already succeeded. If the audit write fails, the mutation should fail with it.

RETENTION: Never delete audit_logs rows from application code. Archive to cold storage on a schedule if volume requires it, but the application layer only ever inserts, it never deletes or updates an existing row.

COVERAGE: Audit every create, update, and delete operation on a sensitive resource (anything touching auth, billing, PII, permissions, or tenant-scoped business data). A mutation endpoint with no corresponding audit_logs write is a gap, not an exception.
