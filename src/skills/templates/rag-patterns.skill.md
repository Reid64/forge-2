---
id: rag-patterns
name: RAG Patterns
domain: ai
tags: [ai, rag, embeddings]
applicablePromptTypes: [agent, feature]
---

CHUNKING: Chunk size 512 tokens with 50 token overlap. Never chunk mid-sentence when a sentence boundary is available within the window.

SIMILARITY THRESHOLD: Minimum similarity threshold of 0.75 for a retrieved chunk to be included in context. Discard results below threshold rather than padding context with weak matches.

SOURCE METADATA: Every chunk carries source metadata (document id, title, url, section) alongside its text so retrieved content is always attributable and citable in the final answer.

RERANKING: Rerank retrieved chunks after initial vector retrieval using a cross-encoder or LLM-based reranker before selecting the final context set. Initial vector similarity alone is not sufficient for final ordering.

CONTEXT LIMIT: Include a maximum of 5 chunks in the final context. More chunks dilute relevance and increase token cost without improving answer quality.

FRESHNESS: Refresh embeddings and the index whenever the source document updates. Never serve retrieval results against a stale index when a newer version of the source exists.
