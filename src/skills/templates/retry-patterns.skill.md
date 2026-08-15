---
id: retry-patterns
name: Retry Patterns
domain: reliability
tags: [reliability]
applicablePromptTypes: [api, agent]
---

EXPONENTIAL BACKOFF — BASE 1S, MULTIPLIER 2, MAX 30S: delay = 1s * 2^attempt (1s, 2s, 4s, 8s, 16s, ...), capped at a 30s maximum — never let the delay grow unbounded past that ceiling.

JITTER PREVENTS THUNDERING HERD: Add random jitter to every computed delay so that many callers who failed at the same moment don't all retry in lockstep and re-stampede the downstream service the instant it recovers.

MAX 3 RETRIES USER-FACING, 5 BACKGROUND: Cap retries at 3 attempts for a user-facing request (a human is waiting) and up to 5 for a background/async job (no one is blocked on it). Never retry silently forever past the cap.

IDEMPOTENCY KEY BEFORE RETRY ON WRITES: A write operation must be guarded by an idempotency key before it is retried — an operation with a side effect (charge a card, send an email, create a record) must never be retried blindly without one, or a retry after a timeout can double-apply the effect.

NEVER RETRY 4XX EXCEPT 429: A 400/401/403/404 will fail identically on every attempt — retrying it wastes time and quota. 429 is the one 4xx worth retrying (with backoff, honoring `Retry-After` if present), because it means "you're being rate-limited," not "you're being rejected."

DEAD LETTER AFTER MAX RETRIES: An operation that exhausts its retry budget goes to a dead-letter queue/table for manual inspection rather than being silently dropped — every permanently-failed operation must remain visible and re-processable.
