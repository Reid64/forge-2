---
id: soft-delete
name: Soft Delete Standards
domain: database
tags: [postgres, patterns]
applicablePromptTypes: [database, api]
---

COLUMN: Use deleted_at TIMESTAMPTZ (nullable, default NULL), never an is_deleted BOOLEAN. deleted_at also records when the delete happened, which a boolean cannot, and it composes directly into WHERE/ORDER BY without an extra column.

QUERIES: Every SELECT against a soft-deletable table filters WHERE deleted_at IS NULL, unless the query is explicitly for an admin/audit view that intentionally includes deleted rows. Add this filter at the query layer (a repository/query-builder default), not by remembering it in every hand-written query.

DELETING: A soft delete is UPDATE ... SET deleted_at = now(), never a real DELETE. Hard deletes are never issued from application code - they run only through a dedicated admin tool/script, gated separately from normal request handling.

UNIQUE CONSTRAINTS: A unique constraint on a soft-deletable table must account for deleted_at (e.g. a partial unique index WHERE deleted_at IS NULL), or a soft-deleted row will block reuse of the same unique value.
