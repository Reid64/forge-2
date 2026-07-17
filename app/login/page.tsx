import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../lib/supabase/server';
import { OPERATOR_ROLE } from '../../lib/auth/constants';
import { LoginForm } from './LoginForm';

// Session-dependent (checks for an already-authenticated operator) — never
// statically prerenderable.
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profile?.role === OPERATOR_ROLE) {
      redirect('/');
    }
  }

  return (
    <main>
      <h1>forge-2 operator sign-in</h1>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
