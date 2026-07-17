import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';

/**
 * Server-side sign-out — clears the Supabase session cookie. Excluded from
 * middleware's matcher (/api/auth/**) so it's reachable without a session.
 */
export async function POST() {
  const supabase = createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.json({ data: { signedOut: true } });
}
