// forge-2 — provisions the single operator account for Supabase Auth.
//
// Per BEHAVIORAL_CONTRACTS.md "Permissions model": role is stored in a
// `profiles` table (id references auth.users(id), role text default
// 'operator'), not in auth.users directly. A database trigger
// (on_auth_user_created, see supabase/migrations/004_create_profiles.sql)
// auto-inserts the profiles row whenever a new auth.users row is created —
// this script only ever creates/updates the auth.users row itself. This is
// the out-of-band step — the login flow (app/login) has nothing to
// authenticate against until it runs at least once.
//
// Usage:
//   pnpm run provision:operator -- --email you@example.com --password 'xxx'
// or:
//   FORGE_OPERATOR_EMAIL=you@example.com FORGE_OPERATOR_PASSWORD=xxx pnpm run provision:operator
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-only,
// never exposed to the browser) to be set — see .env.example.
import { createClient } from '@supabase/supabase-js';

function readArg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = readArg('--email') ?? process.env.FORGE_OPERATOR_EMAIL;
const password = readArg('--password') ?? process.env.FORGE_OPERATOR_PASSWORD;

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    'FAIL: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.example).',
  );
  process.exit(1);
}

if (!email || !password) {
  console.error(
    'FAIL: an operator email and password are required. Pass --email/--password or set FORGE_OPERATOR_EMAIL/FORGE_OPERATOR_PASSWORD.',
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function findUserByEmail(targetEmail) {
  let page = 1;
  const perPage = 200;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const match = data.users.find((u) => u.email?.toLowerCase() === targetEmail.toLowerCase());
    if (match) return match;
    if (data.users.length < perPage) return null;
    page += 1;
  }
}

const existing = await findUserByEmail(email);

if (existing) {
  const { error } = await supabase.auth.admin.updateUserById(existing.id, { password });
  if (error) {
    console.error(`FAIL: could not update existing operator user — ${error.message}`);
    process.exit(1);
  }
  console.log(`PASS: updated password for existing user ${email} (${existing.id}).`);
} else {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) {
    console.error(`FAIL: could not create operator user — ${error.message}`);
    process.exit(1);
  }
  console.log(`PASS: created operator user ${email} (${data.user.id}). The on_auth_user_created trigger provisioned its profiles row with role = 'operator'.`);
}
