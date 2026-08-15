---
id: circuit-breaker
name: Circuit Breaker Patterns
domain: reliability
tags: [reliability, patterns]
applicablePromptTypes: [api, agent, feature]
---

THREE STATES: CLOSED (calls flow normally, failures counted), OPEN (calls fail fast without reaching the downstream service), HALF_OPEN (after cooldown, exactly one test request decides whether to close again or reopen). Never collapse this to two states — HALF_OPEN's single-trial-then-decide step is what prevents flapping between OPEN and CLOSED.

TRIP THRESHOLD — 5 FAILURES IN 60 SECONDS: Open the circuit after 5 failures within a rolling 60-second window, not on a single failure — a lone blip should not take a healthy dependency offline for every caller.

HALF_OPEN ALLOWS EXACTLY ONE TEST REQUEST: While HALF_OPEN, let through exactly one trial call. If it succeeds, close the circuit; if it fails, reopen immediately and restart the cooldown. Never let multiple concurrent requests through during HALF_OPEN — they would all hit the still-struggling dependency at once.

FAIL FAST WHEN OPEN: While OPEN, return a cached response or a graceful error immediately — never attempt the call and wait for it to time out. The entire point is to stop hammering a struggling downstream service and stop making callers wait on a call that will fail anyway.

STATE LIVES IN REDIS, NOT IN-PROCESS MEMORY: Circuit state (open/closed/half-open, failure count, cooldown expiry) is stored in Redis, shared across every instance of the service — an in-memory breaker means each instance trips independently and callers hitting a different instance never see the open state.

PER-DEPENDENCY BREAKERS: Each downstream service/API gets its own breaker key in Redis — one dependency's failures must never open the breaker for an unrelated dependency.

ALERT ON OPEN: An OPEN transition must page/alert on-call, not just log it — a circuit breaker that opens silently hides an active outage from the people who need to respond to it.
