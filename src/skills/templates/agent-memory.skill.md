---
id: agent-memory
name: Agent Memory Patterns
domain: ai
tags: [ai, memory]
applicablePromptTypes: [agent]
---

SHORT-TERM MEMORY: Held in the conversation itself, capped at a maximum of 10 turns. Older turns are summarized or dropped rather than allowed to grow the context unbounded.

LONG-TERM MEMORY: Stored in a vector store with a TTL (time-to-live) on each entry. Never persist memory indefinitely by default - expire entries that are no longer relevant.

SENSITIVE DATA: Never persist sensitive data (credentials, secrets, PII beyond what the task requires) into any memory store, short-term or long-term.

RETRIEVAL ROLE: Memory retrieval augments the current context, it never replaces it. Retrieved memory is additive input the agent reasons over alongside the live conversation, not a substitute for it.
