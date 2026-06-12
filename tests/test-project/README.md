# test-project — FORGE 2.0 Integration Fixture (s8-p04)

A deliberately small, self-contained target the FORGE 2.0 pipeline builds against for the
Sprint-8 integration test. It is **not** a real application — it is an *input* to FORGE.

## The idea FORGE consumes

See [`IDEA.md`](./IDEA.md):

> A task management app with user authentication, task CRUD, and a dashboard.

## How it is used

```powershell
# 1. Phase 0 — scan + lock the toolchain for this project
forge scout tests/test-project

# 2. Phase 0 + 1 — generate the PRD + Architecture (stops at the Gate 2 review banner)
forge design tests/test-project --idea "task management app"

# 3. Full pipeline as a simulation — no claude/git/Sentinel execution, plan + cost only
forge build tests/test-project --idea "task management app" --dry-run

# (cost/time prediction without designing)
forge estimate tests/test-project --idea "task management app"
```

The `package.json` here declares Next.js 14 + Supabase so FORGE's Phase 0 stack-detector
resolves `framework=nextjs`, `database=supabase`, `packageManager=pnpm` — the canonical
`nextjs-supabase` profile. FORGE writes its own artifacts (`governance/TOOLCHAIN.md`,
`PRD.md`, architecture docs, `queue.yaml`) into this directory when run for real.

> Status (2026-06-11): the pipeline run is **UNVERIFIED** — command execution is denied in
> the authoring session. See the repo-root `governance/STATE_OF_THE_BUILD.md` ★ FINAL STATE
> section for the exact unblock commands.
