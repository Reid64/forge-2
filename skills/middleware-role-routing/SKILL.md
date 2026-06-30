# Skill: Middleware Role Routing

## When to apply
Any change touching `middleware.ts` in any project with role-based access (Hail Intel, DialStars, Benavora).

## Procedure

1. `middleware.ts` is NEVER patched with a partial diff. Always full file replacement.

2. Modifying `middleware.ts` requires Reid's explicit approval before the change is written. State this requirement back before proceeding.

3. Role-fetch logic: if the role lookup fails for any reason (network error, missing profile row, expired session), the ONLY allowed redirect is `/login`. Never default to any role-specific page (no fallback to `/dashboard`, no fallback to lowest-privilege role page).

4. After any middleware change, manually verify:
- Hard refresh on each of the six role types lands on that role's correct page
- A forced role-fetch failure (e.g. temporarily invalid session) lands on `/login`, not a blank page or wrong role page

## Failure conditions (block deploy if true)
- Middleware was patched instead of fully replaced
- Any code path defaults to a role page when role fetch fails
- Change was made without stating the approval requirement first
