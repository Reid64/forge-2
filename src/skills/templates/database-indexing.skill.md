---
id: database-indexing
name: Database Indexing Standards
domain: database
tags: [postgres, performance]
applicablePromptTypes: [database, migration]
---

FOREIGN KEYS: Index every foreign key column. Postgres does not create one automatically, and an unindexed FK forces a sequential scan on every join and on every parent-row delete/update cascade check.

COMPOSITE INDEXES: For a multi-column WHERE clause, create a composite index with columns ordered by selectivity (most selective/highest-cardinality column first), not by query-clause order. A composite index on (a, b) serves queries filtering on a alone or on (a, b) together, but not on b alone.

PARTIAL INDEXES: For a filtered query pattern (e.g. WHERE status = 'active', WHERE deleted_at IS NULL), create a partial index with a matching WHERE clause instead of indexing the full table. Smaller index, faster writes, same query performance for that filter.

LOW-CARDINALITY COLUMNS: Never index a boolean column, or any column with only a handful of distinct values, on its own. The planner will usually ignore it in favor of a sequential scan; if a filter on it matters, fold it into a partial index's WHERE clause or a composite index instead.

NAMING: idx_tablename_column1_column2 (e.g. idx_orders_company_id_created_at). Never an unnamed/auto-generated index name in a migration file.
