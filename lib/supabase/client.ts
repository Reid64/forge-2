'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { Database } from './database.types';

/**
 * Browser-side Supabase client for use in Client Components. Manages the
 * session cookie automatically (sign-in, sign-out, silent token refresh) via
 * @supabase/ssr's cookie adapter, matching the server-side cookie format
 * middleware.ts and lib/supabase/server.ts read.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
