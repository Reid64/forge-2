# FORGE 2.0 MCP Integration Status

## Current (2026-09-02, Finding I-4)

FORGE 2.0's autonomous pipeline does not integrate MCP servers. A case-insensitive repo-wide
search for `mcp`/`modelcontextprotocol` returns exactly two hits, neither a real integration:
`src/types/index.ts` (`'mcp_risk'` is one label in a `SecurityFindingCategory` union) and
`src/tools/agent-shield.ts`'s `scanMcpServers()` (a static security auditor that reads a
**target project's own** `.claude/settings.json`/`.mcp.json`, if present, to flag risky MCP
server configs — it never itself establishes an MCP connection). `package.json` has no MCP
dependency of any kind.

## By Design

Autonomous build prompts (Phase 1A/1B/2/3) use standalone tools (web search, file fetch, the
`claude -p --dangerously-skip-permissions` subprocess) rather than MCP servers, to keep the
autonomous pipeline deterministic and independent of interactive-session-only MCP connections
(several MCP servers available in an interactive Claude Code session — e.g. claude.ai-authenticated
ones — are simply absent in a headless/autonomous run).

## Future

If MCP integration is ever added to the autonomous pipeline, candidate insertion points:
- Phase 1B (architecture): a research MCP for prior-art lookup.
- Phase 2 (governance/design): a web-scraping MCP for competitor/reference analysis.
- Design review: a browser-automation MCP for live rendering checks.
- Phase 1A (PRD): a general research MCP for idea expansion.

None of these are implemented; this file exists so a future auditor finds a documented decision
rather than re-discovering the same "zero MCP integration" finding from scratch.
