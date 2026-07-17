import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../lib/supabase/server';
import { OPERATOR_ROLE } from '../lib/auth/constants';
import { SignOutButton } from './SignOutButton';

// Session-dependent — never statically prerenderable.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Defense in depth — middleware.ts already guarantees an operator session
  // reaches this route. If it's somehow missing here, redirect rather than
  // render a default page (Iron Law 4).
  if (!user) {
    redirect('/login');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || profile.role !== OPERATOR_ROLE) {
    redirect('/login');
  }

  return (
    <main>
      <h1>forge-2</h1>
      <p>Signed in as {user.email}</p>
      <nav>
        <a href="/audit">Audit runs</a>
        {' · '}
        <a href="/resurrect">Resurrect</a>
        {' · '}
        <a href="/health">Health</a>
      </nav>
      <SignOutButton />
    </main>
  );
}
