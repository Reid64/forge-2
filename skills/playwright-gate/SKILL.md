# Skill: Playwright Gate

## When to apply
After every production deploy (Step 4 of deploy-sequence skill), and at incremental checkpoints mid-build per governance rule.

## Procedure

1. Run:
```

npx playwright test

```

2. Required result: 10/10 tests passing. There is no partial-pass tier.

3. If result is less than 10/10:
- Immediate rollback of the deploy that triggered the test run
- Do not patch forward on a failing deploy
- Identify failing test(s), fix locally, re-run full deploy-sequence skill from Step 1

4. Test coverage must include, at minimum, for any project with auth/roles:
- Login flow for each of the six roles
- Role-correct landing page after hard refresh
- Core CRUD path for the feature just shipped

## Failure conditions (block "session complete" status if true)
- Tests were skipped "to save time"
- Result was below 10/10 and deploy was not rolled back
- New feature shipped with zero new test coverage added
