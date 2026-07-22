---
id: webhook-reliability
name: Webhook Reliability Patterns
domain: infrastructure
tags: [webhooks]
applicablePromptTypes: [api, feature]
---

RESPOND FAST, PROCESS ASYNC: The webhook handler verifies the request and returns HTTP 200 immediately, then hands the payload off to async processing (a queue, a background job). Never block the response on downstream work the sender will time out waiting for.

IDEMPOTENCY: Every inbound webhook carries a unique event/delivery ID. Before processing, check a processed_webhooks table (or equivalent) for that ID — if already present, acknowledge 200 and skip reprocessing. This is required because senders retry, and a retry must never double-apply a side effect (double charge, double email, double state transition).

SIGNATURE VERIFICATION FIRST: Verify the sender's signature (e.g. Stripe-Signature, HMAC header) against the raw request body before any parsing or processing. Return 400/401 on a failed verification and stop — never process an unverified payload "just to see."

RETRY WITH BACKOFF: When webhook processing itself fails after acknowledgment (a downstream step errors), retry up to 3 times with exponential backoff before giving up on that event.

DEAD LETTER ON REPEATED FAILURE: An event that exhausts its retries goes to a dead-letter store/queue for manual inspection rather than being silently dropped — every failed-permanently event must be visible and re-processable.

RAW BODY FOR VERIFICATION: Signature verification always uses the raw, unparsed request body — a body already parsed to JSON and re-serialized will not match the sender's signature due to key ordering/whitespace differences.
