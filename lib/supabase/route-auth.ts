import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { createSupabaseServerClient } from './server';
import { OPERATOR_ROLE } from '../auth/constants';

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export interface OperatorSession {
  user: User;
  role: typeof OPERATOR_ROLE;
}

/**
 * Resolves and validates the operator session for a Route Handler.
 *
 * Middleware (middleware.ts) already rejects unauthenticated/wrong-role
 * requests before they reach a route handler. This is the second,
 * independent check every Route Handler performs per
 * BEHAVIORAL_CONTRACTS.md's Permissions model: "API route handlers re-verify
 * role from profiles after middleware sets x-user-role header; they never
 * trust the header alone -- they re-query Supabase for the session and role
 * before executing any write."
 *
 * Throws {@link UnauthorizedError} (no session, or role could not be
 * resolved -- callers respond 401) or {@link ForbiddenError} (session valid,
 * role resolved, but it isn't 'operator' -- callers respond 403). Never
 * falls through to a default role (Iron Law 4).
 */
export async function requireOperatorSession(): Promise<OperatorSession> {
  const supabase = createSupabaseServerClient();

  // getUser() (not getSession()) -- it revalidates the token against the
  // Supabase Auth server on every call instead of trusting an unverified
  // local JWT decode, which is the security-relevant distinction Supabase's
  // own SSR guidance calls out for exactly this server-side context.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new UnauthorizedError('No valid session');
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profileError || !profile?.role) {
    throw new UnauthorizedError('Could not resolve operator role');
  }

  if (profile.role !== OPERATOR_ROLE) {
    throw new ForbiddenError('Session role is not operator');
  }

  return { user, role: OPERATOR_ROLE };
}

/**
 * Standard 401 JSON envelope (BEHAVIORAL_CONTRACTS.md API Contracts
 * conventions: top-level `error` field with `{status, code, description}`).
 */
export function unauthorizedResponse(description = 'Authentication required') {
  return NextResponse.json(
    { error: { status: 401, code: 'UNAUTHORIZED', description } },
    { status: 401 },
  );
}

/** Standard 403 JSON envelope -- insufficient permission (role resolved, not operator). */
export function forbiddenResponse(description = 'Insufficient permission') {
  return NextResponse.json(
    { error: { status: 403, code: 'FORBIDDEN', description } },
    { status: 403 },
  );
}
