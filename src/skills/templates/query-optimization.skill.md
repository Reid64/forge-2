---
id: query-optimization
name: Database Query Optimization Standards
domain: performance
tags: [postgres, database]
applicablePromptTypes: [database, api]
---

COLUMN SELECTION: Select only the columns actually needed by the caller. Never `select('*')` on a table with more than a handful of columns, and never on a table containing large text/jsonb columns the caller doesn't use.

PAGINATION: Always paginate list queries with `.range()`/`limit`+`offset` (or keyset pagination for large tables). Never return an unbounded result set to a client.

N+1 QUERIES: Avoid N+1 by fetching related rows via a single join or a batched `IN (...)` query instead of looping and querying per-row. If Supabase's nested select syntax can express the join, prefer it over application-side loops.

AGGREGATIONS: Push complex aggregations (sums, counts, rollups across many rows) into a Postgres function (RPC) rather than pulling raw rows into the application to aggregate in memory.

READ SCALING: Route analytics/reporting queries to a read replica when one is configured, so they never contend with transactional write traffic on the primary.

MATERIALIZED VIEWS: For expensive queries that run repeatedly with the same shape (dashboards, reports), use a materialized view refreshed on a schedule rather than recomputing the full query on every request.
