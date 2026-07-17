import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { Database } from './lib/supabase/database.types';
import { LOGIN_PATH, OPERATOR_ROLE, ROLE_HEADER } from './lib/auth/constants';

/**
 * forge-2 root middleware -- BEHAVIORAL_CONTRACTS.md "Middleware" section.
 *
 * Iron Law 4: on ANY role-fetch failure, redirect to /login ONLY. Never
 * render a default page, never render a wrong-role page, never fall
 * through. This file is always replaced whole, never patched.
 *
 * Page routes and /api/* routes both run this same session + role check,
 * but diverge on failure: pages redirect to /login, /api/* routes return
 * JSON (never a redirect -- an API client cannot follow one).
 */
export async function middleware(request: NextRequest) {
  const isApiRoute = request.nextUrl.pathname.startsWith('/api');

  // (1) Session-aware Supabase client bound to this request/response pair,
  // using the @supabase/ssr cookie adapter over the Next.js middleware
  // request/response cookie APIs. `response` is reassigned inside setAll so
  // a token refresh triggered by getUser()/from() below is carried on the
  // response that's ultimately returned.
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  // (2) Resolve the authenticated user. getUser() (not getSession()) --
  // it revalidates the token against the Supabase Auth server on every call
  // rather than trusting an unverified local JWT decode, which matters
  // specifically in server-side code paths like this one. Any error, or no
  // user, fails closed -- no fallthrough, no default role.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return isApiRoute ? unauthorizedJson() : redirectToLogin(request);
  }

  // (3)-(4) Role comes from the `profiles` table, never from a
  // client-supplied header or body. Any fetch error or missing role fails
  // closed the same way a missing session does.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profileError || !profile?.role) {
    return isApiRoute ? unauthorizedJson() : redirectToLogin(request);
  }

  // Role resolved successfully but isn't 'operator' (the only role that
  // exists): auth succeeded, permission didn't. Pages still only ever
  // redirect to /login (Iron Law 4 -- no wrong-role page exists to render);
  // APIs distinguish this as 403, not 401.
  if (profile.role !== OPERATOR_ROLE) {
    return isApiRoute ? forbiddenJson() : redirectToLogin(request);
  }

  // (5) Downstream Route Handlers can read this header, but they still
  // independently re-validate the session themselves
  // (lib/supabase/route-auth.ts) -- they never trust the header alone.
  response.headers.set(ROLE_HEADER, profile.role);

  // (6)-(7) supabase.auth.getUser() above already performed the automatic
  // cookie refresh as a side effect for every matched request, via setAll.
  // (8) No Node.js-only APIs used above -- this middleware is edge-compatible.
  return response;
}

function redirectToLogin(req: NextRequest): NextResponse {
  const loginUrl = new URL(LOGIN_PATH, req.url);
  const requestedPath = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  if (requestedPath && requestedPath !== '/') {
    loginUrl.searchParams.set('next', requestedPath);
  }
  return NextResponse.redirect(loginUrl);
}

function unauthorizedJson(): NextResponse {
  return NextResponse.json(
    { error: { status: 401, code: 'UNAUTHORIZED', description: 'Authentication required' } },
    { status: 401 },
  );
}

function forbiddenJson(): NextResponse {
  return NextResponse.json(
    { error: { status: 403, code: 'FORBIDDEN', description: 'Insufficient permission' } },
    { status: 403 },
  );
}

export const config = {
  // Every route except /login itself, /api/auth/** (sign-in/sign-out
  // endpoints, which must be reachable without a session), and Next.js
  // internals/static assets.
  matcher: [
    '/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)',
  ],
};
