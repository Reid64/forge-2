# Sentinel Self-Audit Gaps

## ESLint / Lint Gate / Format Gate (Finding D-1, 2026-09-02 audit)

Running `forge sentinel ring .` against FORGE 2.0's own repository can never exercise the
ESLint, Lint Gate, or Format Gate checks, because this repository has neither an ESLint
config/dependency nor a Prettier config/dependency:

- `ls .eslintrc* eslint.config.* .prettierrc* prettier.config.*` — no matches.
- `grep -i "eslint\|prettier" package.json` — no matches.

This is a real, permanent gap for self-audits specifically (Sentinel's design correctly treats a
missing config as "skip, never false-fail" — see `src/phases/phase4-sentinel.ts`'s `skip()` calls
around the ESLint/Lint Gate/Format Gate checks), not a bug in the gate logic itself.

**Decision:** documented as intentional, not scaffolded. Adding real ESLint/Prettier configs to
FORGE 2.0's own ~278-file `src/` tree is a deliberate tooling decision (rule selection, initial
cleanup pass) that belongs in its own scoped task, not as a side effect of an audit-fix pass. Until
that happens, three of Sentinel's seven checks are permanently dark when self-auditing this repo —
they still run correctly against any target project FORGE builds that has its own lint/format
config.
