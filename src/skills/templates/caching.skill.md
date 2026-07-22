---
id: caching
name: Caching Standards
domain: performance
tags: [redis, cache]
applicablePromptTypes: [api, feature]
---

CACHE-ASIDE PATTERN: Reads check the cache first; on a miss, load from the source of truth (the database), populate the cache, then return the value. Writes go to the database first, then invalidate (never update-in-place) the corresponding cache key. Never write application data directly into the cache as the primary write path — the cache is a derived, disposable copy, not a system of record.

TTL ALWAYS SET: Every cache key is written with an explicit TTL. Never write a key with no expiration ("infinite" caching) — an un-expiring key that is never explicitly invalidated on every code path that can change its underlying data will eventually serve stale data forever. Choose a TTL proportional to how tolerant the data is of staleness (seconds for hot, fast-changing data; minutes-to-hours for slow-changing reference data).

CACHE KEY VERSIONING: Every cache key includes a version prefix (e.g. `v3:user:123:profile`). Bumping the prefix on a schema or serialization change instantly invalidates every previously-cached value of the old shape without needing to enumerate and delete old keys individually — stale-shaped values simply become unreachable under the new prefix.

INVALIDATION ON WRITE: Any write (create/update/delete) that changes data behind a cache key MUST invalidate (delete, not silently leave) every cache key derived from that data as part of the same write path — never on a timer alone, and never left to the next TTL expiry. A write that forgets to invalidate its own cache is a defect, not an acceptable trade-off.

USER-SCOPED CACHE KEYS: Never cache a value derived from or containing user-specific data (profile, permissions, personalized results, account balance) under a key that does not include that user's ID. A shared/unscoped key for per-user data is a cross-user data leak waiting to happen — the moment two users' requests can resolve to the same cache key, one user can be served another user's cached response.
