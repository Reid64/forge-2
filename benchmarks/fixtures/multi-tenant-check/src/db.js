// FORGE benchmark fixture (multi-tenant-check): intentionally missing tenant isolation.
// `getDocuments` never filters by `tenant_id` — any authenticated tenant can read every
// other tenant's rows. The benchmark queue asks FORGE to find and close this leak.
// DISPOSABLE fixture; never a real project.

/** @param {{ query: (sql: string, params: unknown[]) => Promise<unknown[]> }} db */
export function getDocuments(db, _tenantId) {
  // BUG: tenant_id is accepted but never used in the WHERE clause — cross-tenant leak.
  return db.query('SELECT * FROM documents', []);
}
