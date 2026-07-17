/**
 * Shared by middleware.ts, lib/supabase/route-auth.ts, and the auth pages --
 * BEHAVIORAL_CONTRACTS.md "Permissions model": a flat single-role model,
 * `operator` is the only role that exists.
 */
export const OPERATOR_ROLE = 'operator' as const;

/** Header middleware attaches for downstream Server Components (never trusted alone by route handlers). */
export const ROLE_HEADER = 'x-user-role';

export const LOGIN_PATH = '/login';
