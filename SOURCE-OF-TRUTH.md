# FORGE 2.0 — Source of Truth

**This is the root-level authority map required by `upgrades/GOVERNANCE_FRAMEWORK.md` §1.1.** It
promotes and updates `governance/FORGE_CANONICAL_INSTRUCTIONS.md` §7 ("Governance Documents —
Source of Truth"), which remains in place under `governance/` as the FORGE-1.0-facing operational
copy. This file is the canonical, root-level version; if the two ever diverge, this file wins per
the precedence rule in §2 below.

Evidence for every mapping in §1 is cross-checked against
`upgrades/SYSTEMS-5-9-GAP-MATRIX.md` §1.1.

---

## 1. Governance file → subject map

The `GOVERNANCE_FRAMEWORK.md` spec expects eight named root files (`FORGE.md`, `RULES.md`,
`TOOLS.md`, `MODEL-ROUTING.md`, `CONTEXT.md`, `NOW.md`, `SOURCE-OF-TRUTH.md`, `manifest.yaml`).
FORGE 2.0's actual root does not use those eight names. This section is the authoritative mapping
from each expected role to the real file(s) that fill it today.

| Expected role | Filled by | Notes |
|---|---|---|
| **FORGE.md** — identity, mission, autonomy boundaries, completion criteria | `BLUEPRINT.md` (identity/rules) + `PRD.md` (requirements/success criteria) | Split by design, not by omission. `BLUEPRINT.md:1-11` carries identity/purpose/stack and `BLUEPRINT.md:143-153` carries the 10 non-negotiable rules; `PRD.md:3-78` carries the requirements and success criteria. Both together are FORGE.md's equivalent — read both, not one. |
| **RULES.md** — hard engineering rules agents cannot override | `BEHAVIORAL_CONTRACTS.md` | Direct equivalence. 20 numbered contracts plus 12 lettered series, each a MUST/MUST NOT with no override path. |
| **TOOLS.md** — approved tools/MCP servers/APIs/CLIs, standing policy | `TOOLCHAIN.md` | **Known limitation — not a true equivalent.** `TOOLCHAIN.md` is regenerated on every Phase 0 run (`TOOLCHAIN.md:3`) — a per-build detected snapshot of what the last scout run found, not a curated, hand-maintained standing approval policy. Do not treat entries in `TOOLCHAIN.md` as "approved" in the governance sense; treat them as "last observed." If a durable, human-curated tool allowlist is needed, it does not yet exist anywhere in this repo. |
| **MODEL-ROUTING.md** — which LLM handles which task type | `MODEL-ROUTING.md` (root, new) | Previously MISSING per the gap matrix. Now filled — see the new root `MODEL-ROUTING.md`, built from `src/engine/provider-router.ts`'s actual routing tables. |
| **CONTEXT.md** — stable project context every agent should know | `BLUEPRINT.md` §§12-141 | The architecture overview, components, structure tree, tech decisions, and env vars living in the same file as FORGE.md's identity section above — there is no dedicated split-out file. Agents should read `BLUEPRINT.md` in full, not assume CONTEXT.md content lives elsewhere. |
| **NOW.md** — current active state, milestone, blockers, next work | `FORGE_HANDOFF.md` + `SESSION_STATE.md` | `FORGE_HANDOFF.md:1-11` is designed to be pasted as the session-opening message; `:439-472` is the current halt state; `:474-495` is the numbered next-actions list. `SESSION_STATE.md` reinforces it with the Last Completed Prompt and Active Blockers fields. Read both — `FORGE_HANDOFF.md` for narrative state, `SESSION_STATE.md` for the structured fields. |
| **SOURCE-OF-TRUTH.md** — which doc is authoritative for which subject | This file (root) | Supersedes `governance/FORGE_CANONICAL_INSTRUCTIONS.md` §7 as the canonical copy; that section remains as the FORGE-1.0-facing operational reference and should be kept in sync with this file, not treated as a second independent source. |
| **manifest.yaml** — machine-readable project identity/autonomy/approval-gate config | `manifest.yaml` (root, new) | Previously MISSING per the gap matrix. Now filled — see the new root `manifest.yaml`, built from `src/cli/index.ts`'s actual `build` command flags. |

## 2. Authority-precedence hierarchy

When two governance sources conflict, resolve in this order — **each level overrides every level
below it**:

1. **Human approval** — an explicit human decision (an approval gate, a direct instruction in the
   current session, a rejected/approved design review) always wins over any written document.
2. **FORGE governance docs** — `BLUEPRINT.md`, `PRD.md`, `SESSION_STATE.md`, `STATE_OF_THE_BUILD.md`,
   `SCHEMA_REGISTRY.md`, `AGENTS.md`, `LESSONS_LEARNED.md`, `FORGE_HANDOFF.md`, this file, and
   `governance/FORGE_CANONICAL_INSTRUCTIONS.md`.
3. **Security policy** — security-relevant findings and gates (Sentinel Ring 3 security scan,
   Gitleaks, dependency audit, `src/tools/security-scanner.ts`, AgentShield) override architecture
   preferences below them.
4. **Architecture / ADRs** — `ARCHITECTURE.md` and any architecture decisions recorded during
   Phase 1B.
5. **BEHAVIORAL_CONTRACTS.md** — the 20 numbered contracts and lettered series. Ranked below
   architecture because an ADR represents a deliberate human/agent design choice for a specific
   project, while a contract is a general-purpose default that a documented ADR may legitimately
   need to specialize — but a contract still outranks everything below it, including the manifest.
6. **manifest.yaml** — machine-readable identity/autonomy/approval-gate configuration for the
   current run.
7. **Queue YAML** (`queue.yaml` and equivalents) — the specific ordered prompt list for the current
   build.
8. **Skill instructions** (`.claude/skills/`, `src/skills/templates/*.skill.md`) — reusable
   patterns injected into a prompt.
9. **Model-specific files** — provider- or model-specific configuration (e.g. routing overrides,
   per-model prompt tuning).
10. **Current prompt** — the literal text of the prompt an agent is currently executing.
11. **Agent-generated suggestions** — anything an agent proposes on its own (e.g. a `pending_evolution`,
    an unreviewed recommendation) carries the least authority until promoted by a higher level.

A lower level may never override a higher level. If a queue YAML instructs something a contract in
`BEHAVIORAL_CONTRACTS.md` forbids, the contract wins and the queue step must halt for human review
rather than proceed silently.

## 3. Root artifact directories

Per `GOVERNANCE_FRAMEWORK.md`, the following root artifact directories are expected:
`design/`, `testing/`, `memory/`, `skills/`, `workflows/`, `queues/`, `runs/`, `scripts/`. As of
this writing, only `scripts/` and `skills/` exist at root; `design/`, `testing/`, `memory/`,
`workflows/`, `queues/`, and `runs/` exist only as **source-code modules** nested under `src/`
(`src/testing/`, `src/memory/`, `src/design-pipeline/`), not as root-level output/artifact
directories. This gap is tracked in `upgrades/SYSTEMS-5-9-GAP-MATRIX.md` §1.3 and is out of scope
for this change — recorded here only so the mapping in §1 is not mistaken for a claim that the
directory structure is also resolved.
