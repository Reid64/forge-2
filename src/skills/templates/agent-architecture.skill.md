---
id: agent-architecture
name: Agent Architecture Patterns
domain: agents
tags: [agents, typescript, async]
applicablePromptTypes: [agent, feature]
---

AGENT STRUCTURE: Every agent is a class extending BaseAgent. BaseAgent defines: abstract name: string, abstract description: string, abstract run(trigger: string, input?: AgentInput): Promise<AgentRunResult>. AgentRunResult = { success: boolean, itemsProcessed: number, summary: string, errors: string[], durationMs: number }.

AGENT REGISTRATION: Every agent registers itself in src/agents/registry.ts via registerAgent(agent). Registry exposes getAgent(name), listAgents(), runAgent(name, trigger, input).

TRIGGER TYPES: Agents accept trigger strings: autonomous, manual, chain, schedule, webhook. Behavior may vary by trigger.

ERROR HANDLING: Agents never throw. All errors caught internally, added to AgentRunResult.errors, success=false if any critical error. Always process as many items as possible before returning.

LOGGING: Every agent logs via agentLogger (child of forge logger). Format: [AGENT:{name}] {action} — {detail}. Log start, progress every 100 items, completion summary.

DB PERSISTENCE: Every agent run writes to agent_runs table: id, agent_name, trigger, started_at, completed_at, items_processed, success, errors JSON, summary.

CHAINING: Agents can chain by calling registry.runAgent() on completion. Chain depth tracked to prevent infinite loops (max depth 5).
