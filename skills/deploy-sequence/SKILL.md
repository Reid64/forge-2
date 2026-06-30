# Skill: Deploy Sequence

## When to apply
Every production deploy, every project, no exceptions.

## Precondition
If `deploy.ps1` does not exist in project root, create it first using the steps below before running anything.

## Procedure
Run from project root in a standalone black PowerShell window (Windows Start menu), NOT inside Cursor's terminal:

```

.\deploy.ps1

```

`deploy.ps1` must execute these five steps in this exact order, halting on any failure:

1. Type check:
```

pnpm tsc --noEmit

```

2. Build:
```

pnpm run build

```

3. Deploy to production via CLI only — never the Vercel browser UI:
```

vercel --prod

```

4. Run end-to-end tests:
```

npx playwright test

```

5. Commit and push only after steps 1-4 pass:
```

git add .
git commit -m "describe what changed"
git push

```

## Failure handling
- Any step fails → stop. Do not proceed to the next step. Do not push.
- Playwright result must be 10/10 passing (see playwright-gate skill). Anything less than 10/10 = immediate rollback, not a partial accept.

## Live app addendum
If this deploy adds a major feature to an already-live app: branch (not main) → Vercel preview URL → run DB migrations against production Supabase first → then merge to main → then run this sequence.
