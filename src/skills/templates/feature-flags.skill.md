---
id: feature-flags
name: Feature Flag Patterns
domain: infrastructure
tags: [feature-flags, deployment]
applicablePromptTypes: [feature]
---

DECOUPLE DEPLOY FROM RELEASE: Ship code behind a flag that defaults OFF, deploy it, then flip the flag on separately once it's verified — deployment and release become two independent events instead of one risky atomic step.

SERVER-SIDE EVALUATION FOR GATING LOGIC: Evaluate a flag server-side for anything that controls access, billing, or data exposure — a client-side-only flag check can be bypassed by editing the client, so it is a UX toggle, never a security boundary.

NAMESPACE AND EXPIRE FLAGS: Name flags by intent (`feature-x-rollout`, not `flag1`), and remove a flag from the codebase once it has fully rolled out or been fully reverted — a flag left in code indefinitely after its rollout decision is made is dead conditional logic that silently increases branch-testing surface.

DEFAULT TO THE SAFE STATE: A flag's default (when the flag service is unreachable or the flag is unset) must be the safe/old behavior, never the new/risky one — a flag service outage should never accidentally enable a half-tested feature for everyone.

SCOPE FLAGS TO THE SMALLEST UNIT THAT MAKES SENSE: Percentage rollout, per-company, or per-user — pick the narrowest scope that lets you validate the feature on real traffic before a full rollout, and always support an instant kill-switch flip back to OFF.

LOG FLAG EVALUATIONS FOR ROLLOUT DEBUGGING: When a flagged feature misbehaves for a specific user/company, you need to know which flag state they were evaluated under — record the flag value alongside the request, not just the feature's outcome.
