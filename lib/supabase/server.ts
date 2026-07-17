import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { Database } from './database.types';

/**
 * Server-side Supabase client backed by the @supabase/ssr cookie adapter
 * (BEHAVIORAL_CONTRACTS.md "Middleware": `@supabase/ssr createServerClient`
 * with `cookies()` from `next/headers`).
 *
 * Safe to call from both Server Components (cookie writes are silently
 * dropped -- Next.js forbids mutating cookies during render; the session
 * refresh that would have written them already happened in middleware.ts on
 * this same request) and Route Handlers (cookie writes succeed, e.g.
 * clearing the session cookie in app/api/auth/signout/route.ts).
 */
export function createSupabaseServerClient() {
  const cookieStore = cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Called from a Server Component render -- no-op.
          }
        },
      },
    },
  );
}
