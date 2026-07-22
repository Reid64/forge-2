---
id: retry-patterns
name: Retry Patterns
domain: infrastructure
tags: [resilience, retry]
applicablePromptTypes: [api, feature]
---

EXPONENTIAL BACKOFF WITH JITTER: Retry a failed call with delay = base * 2^attempt, plus a random jitter (e.g. +/- 20%) to avoid every failed caller retrying in lockstep and re-stampeding the downstream service. Cap the delay at a sane maximum (e.g. 30s), never let it grow unbounded.

RETRY ONLY TRANSIENT FAILURES: Retry on network errors, timeouts, and 5xx/429 responses. Never retry a 4xx (except 429) — a 400/401/403/404 will fail identically on every attempt and retrying it just wastes time and quota.

BOUNDED ATTEMPTS: Cap retries at a fixed maximum (typically 3-5). After the cap is exhausted, fail loudly with the original error surfaced to the caller — never retry silently forever.

IDEMPOTENCY BEFORE RETRY: Only retry an operation that is safe to run twice (a GET, or a write guarded by an idempotency key). An operation with a side effect that is not idempotent (charge a card, send an email) must not be retried blindly — dedupe via an idempotency key first.

RESPECT RETRY-AFTER: When a 429/503 response includes a `Retry-After` header, honor it instead of the computed backoff delay — the server is telling you exactly how long to wait.

TIMEOUT PER ATTEMPT: Every individual attempt has its own timeout, distinct from the overall retry budget's timeout — a single hung attempt must not consume the entire retry budget waiting on it.
