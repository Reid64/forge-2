---
id: tool-calling
name: Tool Calling Standards
domain: ai
tags: [ai, tools, agents]
applicablePromptTypes: [agent, feature]
---

SINGLE PURPOSE: Every tool has one clear purpose. Never build a multi-purpose tool with a mode/action parameter that switches behavior - split it into separate tools instead.

NAMING: Tool names are snake_case verbs describing the action: get_user, create_invoice, search_documents. Never noun-only names like user or invoice.

PARAMETER VALIDATION: Required parameters are validated before execution, not inside the tool body after partial work has started. Reject invalid input immediately with a clear error.

ERROR HANDLING: Tool errors are returned as structured data in the tool result (e.g. { error: "reason" }), never thrown as an exception that crashes the calling loop. The caller must always receive a well-formed response it can reason about.

PARALLEL CALLING: When multiple tool calls are independent (no data dependency between them), issue them in parallel rather than sequentially, to minimize round-trip latency.

DEPTH LIMIT: Cap tool-call chains at a maximum depth of 5 to prevent runaway recursive tool use. Escalate to the caller or halt when the limit is reached rather than looping indefinitely.
