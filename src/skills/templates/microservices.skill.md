---
id: microservices
name: Microservices Architecture Standards
domain: architecture
tags: [microservices, api]
applicablePromptTypes: [api, feature, agent]
---

SERVICE BOUNDARIES: Draw service boundaries by business domain, never by technical layer. A service owns one bounded context (billing, auth, notifications, inventory) and every table/queue/cache it touches lives inside that boundary. Splitting a single domain across two services, or merging two domains into one service for convenience, is a boundary violation.

SYNCHRONOUS VS ASYNCHRONOUS: Use synchronous REST calls for queries where the caller needs an immediate answer to render a response (fetch order status, look up a user). Use asynchronous events for commands that trigger state changes elsewhere (order placed, invoice generated, user deactivated). Never make a synchronous call chain more than one service deep to satisfy a write — publish an event and let the downstream service react.

CIRCUIT BREAKERS: Every inter-service call (REST or RPC) is wrapped in a circuit breaker with a failure-rate threshold, an open-state cooldown, and a fallback (cached value, default response, or a fast-fail error) for when the breaker is open. A service must degrade, not cascade-fail, when a dependency is unhealthy. No inter-service client is called directly without going through the breaker wrapper.

DATA OWNERSHIP: Each service owns its own database/schema exclusively. No service ever connects directly to another service's database, table, or schema — not even read-only. Cross-service data access happens only through that service's API or through events it publishes. Shared database access between services is the single most common way a "microservices" system becomes an accidental distributed monolith.

CORRELATION IDS: Every inbound request generates or propagates a correlation ID (a UUID, read from an `X-Correlation-Id` header if present, generated if absent). The correlation ID is attached to every log line, every outbound call header, and every published event tied to that request, so a single user action can be traced across every service it touched.

HEALTH ENDPOINTS: Every service exposes a `/health` (or `/healthz`) endpoint that returns 200 only when the service and its critical dependencies (database connection, required downstream services) are actually reachable — never a hardcoded 200. Orchestration/load-balancing infrastructure and the circuit breakers above both depend on this endpoint being honest.
