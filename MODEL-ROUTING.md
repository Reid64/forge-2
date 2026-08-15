# FORGE 2.0 — Model Routing

**This is the root-level `MODEL-ROUTING.md` required by `upgrades/GOVERNANCE_FRAMEWORK.md` §1.1**
(see `SOURCE-OF-TRUTH.md` §1). It is generated entirely from the routing tables actually wired in
`src/engine/provider-router.ts` — nothing here is aspirational. If this file and the code diverge,
the code wins; regenerate this file rather than editing the code to match it.

## 1. What "routing" covers, and what it doesn't

FORGE makes two kinds of model call. This file only covers the **first** kind.

1. **The autonomous BUILD itself** — every prompt in `queue.yaml` executed during Phase 3. This
   goes through the Claude Code CLI subprocess and is the Claude Runner's sole job (Contract 5).
   `provider-router.ts` does **not** touch this path at all.
2. **FORGE's own reasoning calls** — the PRD generator (Phase 1A), the Architecture Engine
   (Phase 1B), and the self-evolving Agent Creator (Phase 5) each POST to a chat model directly via
   `ProviderRouter`. This is what the table below routes.

## 2. Providers

Each provider is keyed off its own env var. A missing key just drops that provider from the
routing chain for a call — it never crashes the call.

| Provider | Default model | Key env var(s) | Role (per module docstring) |
|---|---|---|---|
| `anthropic` | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` | PRIMARY complex reasoning. For `complex_reasoning` specifically, the `anthropic` leg is **not** the Messages API — it shells out to the Claude Code CLI (Max-plan usage; see §4). Every other task type's `anthropic` leg POSTs to the Messages API and needs `ANTHROPIC_API_KEY`. |
| `openai` | `gpt-4o-mini` | `OPENAI_API_KEY` | Validation + simple analysis. |
| `gemini` | `gemini-2.5-flash-lite` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Documentation + research verification. Called via its OpenAI-compatible endpoint. |
| `deepseek` | `deepseek-chat` | `DEEPSEEK_API_KEY` | Code review + pattern matching. |

## 3. Task type → provider chain

Each `ForgeTaskType` maps to an ordered provider preference — first entry is preferred, the rest is
the failover chain. The router walks the chain, skipping any provider with no key, in rate-limit
cooldown, or with an exhausted free tier for the day, and calls the first eligible one.

| Task type | Chain (preferred → failover) | Used by |
|---|---|---|
| `complex_reasoning` | `anthropic` only — **pinned, no failover** | Phase 1A (PRD), every Phase 1B artifact, adversarial review |
| `validation` | `openai` → `gemini` → `anthropic` → `deepseek` | — |
| `simple_analysis` | `openai` → `gemini` → `deepseek` → `anthropic` | — |
| `documentation` | `gemini` → `openai` → `anthropic` → `deepseek` | — |
| `research_verification` | `gemini` → `openai` → `anthropic` → `deepseek` | — |
| `code_review` | `deepseek` → `anthropic` → `openai` → `gemini` | — |
| `pattern_matching` | `deepseek` → `openai` → `gemini` → `anthropic` | — |

`complex_reasoning` is deliberately pinned to `anthropic` alone (Session 5 finding #1, recorded in
the module docstring): this task type drives every design artifact a human later reviews, and
letting it silently fail over to a cheaper/weaker model would produce governance a human never
actually reviewed against Claude's judgment. Cost-optimized failover across providers is
acceptable for the mechanical tiers only.

## 4. `complex_reasoning`'s `anthropic` leg — Claude Code CLI, not the Messages API

Unlike every other (task type, provider) pair, `complex_reasoning` routed to `anthropic` does not
call `https://api.anthropic.com/v1/messages`. It shells out to the Claude Code CLI subprocess (the
same one Phase 3 build execution uses, via `runClaude`), so this reasoning spends the operator's
Max-plan usage rather than metered API credits. `system` + `user` are concatenated into one prompt
piped over stdin. Because CLI usage is flat-rate, no per-token dollar cost is estimated for these
calls (`costUsd` is recorded as `0`).

## 5. Failover and outage behavior

- **429 / 5xx / network error / timeout** → that provider is put into a cooldown window (default
  10s, `DEFAULT_COOLDOWN_MS`) and the router advances to the next provider in the chain.
- **401 / 403 / 400** → that provider is dropped for this attempt (bad key / bad request) and the
  router advances to the next provider in the chain.
- **Whole chain exhausted** → the router throws one aggregated `AllProvidersExhaustedError`. Every
  caller (Phase 1A / 1B / Agent Creator) already wraps its model call in a guarded try/catch with a
  deterministic fallback (e.g. Phase 1A's template PRD), so a total provider outage degrades
  gracefully rather than halting the pipeline.

## 6. LiteLLM proxy (optional)

When `FORGE_LITELLM_PROXY_URL` (or `LITELLM_PROXY_URL`) is set, every provider call is sent
OpenAI-style to that proxy with a LiteLLM model string (`anthropic/claude-sonnet-4-6`,
`openai/gpt-4o-mini`, `gemini/gemini-2.5-flash-lite`, `deepseek/deepseek-chat`), and LiteLLM
performs the actual vendor dispatch, key management, and its own failover/cost accounting — this
router's task→provider preference still decides which model string to request. With no proxy URL
set, the router calls each provider's native HTTPS endpoint directly (Anthropic Messages shape for
Claude, OpenAI Chat Completions shape for the other three — Gemini via its OpenAI-compatible
endpoint). `complex_reasoning`'s Claude Code CLI leg is unaffected by the proxy setting either way.

## 7. Cost + free-tier tracking

`ProviderUsageTracker` is an in-memory ledger keyed by provider and day (`YYYY-MM-DD`). Every
successful call records input/output tokens and an **estimated** dollar cost at the provider's list
rate (budgeting only, not an invoice — Iron Law 3):

| Provider | Input $/1M tok | Output $/1M tok | Free tier |
|---|---|---|---|
| `anthropic` | 3 | 15 | none |
| `openai` | 0.15 | 0.6 | none |
| `gemini` | 0.075 | 0.3 | 1,500 calls/day |
| `deepseek` | 0.14 | 0.28 | none |

Once a provider crosses its free-tier daily ceiling, the router treats it as `free_tier_exhausted`
for the rest of that day and fails over to the next provider in the chain — it never blocks the
call outright.
