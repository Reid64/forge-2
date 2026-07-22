---
id: prompt-engineering
name: Prompt Engineering Standards
domain: ai
tags: [ai, claude]
applicablePromptTypes: [agent, feature]
---

SYSTEM PROMPTS: Define the role, constraints, and output format explicitly. Never leave behavior ambiguous - state what the model must do, what it must never do, and exactly how the response should be structured.

TEMPERATURE: Use temperature 0 for deterministic, factual, or structured-output tasks (classification, extraction, code generation). Use temperature 0.7 for creative or exploratory tasks (brainstorming, copywriting, varied phrasing).

OUTPUT FORMAT: Always specify the exact output format (JSON schema, markdown structure, plain text) in the prompt. Never assume the model will infer the desired shape.

NEGATIVE EXAMPLES: Include examples of what NOT to do alongside positive examples, especially for tasks with a common failure mode (over-verbose output, wrong format, hallucinated fields).

FEW-SHOT: Use few-shot examples for complex or non-obvious output shapes. 2-3 diverse examples covering edge cases beat one example covering only the happy path.

CHAIN OF THOUGHT: For reasoning-heavy tasks, instruct the model to think step by step before producing the final answer. Separate the reasoning from the final output when the caller only needs the result.
