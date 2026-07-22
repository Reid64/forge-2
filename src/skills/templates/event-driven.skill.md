---
id: event-driven
name: Event-Driven Architecture Standards
domain: architecture
tags: [events, queues]
applicablePromptTypes: [api, agent]
---

EVENT NAMING: Name every event in the past tense, describing a fact that already happened: `UserCreated`, `OrderShipped`, `PaymentFailed`, `InvoiceGenerated`. Never name an event as a command or intent (`CreateUser`, `ShipOrder`) — that is a request, not an event, and belongs on a command channel, not the event bus.

EVENT SCHEMA VERSIONING: Every event payload carries an explicit schema version field (e.g. `schemaVersion: 2`). A breaking change to an event's shape ships as a new version, published alongside the old version until every consumer has migrated — never a silent in-place change to an existing version's shape. Consumers validate the version field before deserializing and reject/quarantine an unrecognized version rather than guessing its shape.

IDEMPOTENT CONSUMERS: Every event consumer is idempotent — processing the same event twice (same event ID) produces the same end state as processing it once, with no duplicate side effects (no double-charging, no duplicate email, no duplicate row). Consumers track processed event IDs (a dedupe table or an idempotency key on the write) because at-least-once delivery guarantees a redelivery will happen eventually, not just in theory.

DEAD LETTER QUEUE: Every consumer/subscription has a dead letter queue. An event that fails processing after its retry budget is exhausted is moved to the DLQ with the failure reason and stack trace attached, never silently dropped and never retried forever. DLQ contents are monitored and alertable, not a black hole.

EVENT STORE / AUDIT TRAIL: Published events are persisted to an append-only event store (or equivalent durable log) that is authoritative for what happened and when, independent of whether every consumer's read model is currently in sync. The event store is the audit trail — it is queried, not mutated, and every event ever published for a domain aggregate can be replayed from it.

NEVER DELETE EVENTS: Events already written to the store or the audit trail are never deleted or overwritten, including for GDPR-style "right to be forgotten" requests — those are handled by redacting/tombstoning the payload's PII fields in place (or via a compensating event) while preserving the event's existence, ordering, and metadata. Deleting history breaks replay, audit, and every downstream projection that depends on a complete event sequence.
