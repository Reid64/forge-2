---
id: circuit-breaker
name: Circuit Breaker Patterns
domain: infrastructure
tags: [resilience, circuit-breaker]
applicablePromptTypes: [api, feature]
---

THREE STATES: CLOSED (calls flow normally, failures counted), OPEN (calls fail fast without hitting the downstream service at all, for a cooldown window), HALF_OPEN (after cooldown, a limited number of trial calls decide whether to close again or reopen). Never implement only two states — HALF_OPEN's trial-then-decide step is what prevents flapping.

TRIP THRESHOLD: Open the circuit after a failure-rate threshold is crossed within a rolling window (e.g. >= 50% of the last 20 calls failed), not after a single failure — a lone blip should not take a healthy dependency offline for every caller.

FAIL FAST WHEN OPEN: While OPEN, return immediately with a clear "service unavailable" error (or a cached/degraded fallback) instead of attempting the call and waiting for it to time out — the entire point is to stop hammering a struggling downstream service and stop making callers wait on a call that will fail anyway.

COOLDOWN BEFORE HALF_OPEN: The circuit stays OPEN for a fixed cooldown period (e.g. 30-60s) before allowing a single trial call through to HALF_OPEN. Do not immediately retry on every request while OPEN.

PER-DEPENDENCY BREAKERS: Each external dependency (each downstream service/API) gets its own breaker instance — one dependency's failures must never open the breaker for an unrelated dependency.

COMBINE WITH RETRY, DON'T DUPLICATE IT: Retry-with-backoff (see the retry-patterns skill) happens inside a single call's attempt budget; the circuit breaker wraps the call as a whole across many requests over time. Use both together, not one in place of the other.
