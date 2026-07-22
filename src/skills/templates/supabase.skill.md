---
id: supabase
name: Supabase Patterns
domain: database
tags: [supabase, postgres, rls]
applicablePromptTypes: [api, database, migration, feature]
---

CLIENT USAGE: Server components use createServerComponentClient. Route handlers use createRouteHandlerClient. Never use createClient from supabase-js directly in server code. Admin operations use createClient with service role key from server only, never exposed to client.

RLS POLICIES: Every table has RLS enabled. Every policy is named descriptively: users_select_own, companies_insert_authenticated. Never disable RLS. Auth check: auth.uid() = user_id or auth.jwt() ->> role = required_role.

MIGRATIONS: Every migration file named: YYYYMMDDHHmmss_description.sql. Never alter existing migrations. Always add IF NOT EXISTS. Always add indexes on foreign keys and frequently queried columns. Every table has id uuid DEFAULT gen_random_uuid() PRIMARY KEY, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now().

ERROR HANDLING: Always destructure { data, error } from supabase calls. Never assume success. Log error.message with context. Return standardized error shape to client.

REALTIME: Use supabase.channel() not deprecated .from().on(). Always unsubscribe on component unmount.
