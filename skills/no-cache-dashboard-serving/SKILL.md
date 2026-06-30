# Skill: No-Cache Dashboard Serving (DialStars-pattern)

## When to apply
Any project serving standalone HTML dashboards alongside a Next.js app (currently: DialStars agent/supervisor/master-admin dashboards; applicable to any future similar pattern).

## Procedure

1. The three dashboard HTML files (agent, supervisor, master admin — or equivalent) are served ONLY via API routes with no-cache headers. Never served directly from `/public/`.

2. API route pattern:
```

// app/api/dashboard/[role]/route.ts
// Must set: Cache-Control: no-store, no-cache, must-revalidate

```

3. The iframe `src` in the consuming `page.tsx` must point to the API route, never to a direct `/public/` path:
```

<iframe src="/api/dashboard/agent" />

```

4. Any fix to dialer/dashboard logic applies to BOTH `agent_dashboard.html` and `supervisor_dashboard.html` simultaneously — there is no single-file fix for dialer behavior.

## Failure conditions (block deploy if true)
- Iframe src reverted to a direct `/public/` path
- A dialer fix was applied to only one of the two dashboards
- No-cache headers missing from the serving route
