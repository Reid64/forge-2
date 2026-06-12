-- FORGE 2.0 — Migration 012: seed error_patterns
-- Inserts the 10 pre-loaded error patterns from SCHEMA_REGISTRY.md › Seed Data.
-- Idempotent: re-running does nothing for patterns that already exist
-- (error_signature is UNIQUE).
--
-- auto_resolve_eligible is set true only where success_rate > 0.90
-- (matches Contract 15 / idx_error_auto: ">90% success = eligible").
-- All seeds use first_seen_project = 'forge-bootstrap' (the patterns originate
-- from prior Visual AI Method builds curated into FORGE's bootstrap memory).

insert into public.error_patterns (
    error_signature,
    error_category,
    error_message_sample,
    occurrence_count,
    first_seen_project,
    stack_fingerprints,
    trigger_phase,
    trigger_prompt_pattern,
    prevention_rule,
    success_rate,
    auto_resolve_eligible
) values
-- 1. powershell_execution_policy — 100%
(
    'powershell: running scripts is disabled on this system (UnauthorizedAccess)',
    'config',
    'File C:\path\script.ps1 cannot be loaded because running scripts is disabled on this system. For more information see about_Execution_Policies. + CategoryInfo : SecurityError: (:) [], PSSecurityException + FullyQualifiedErrorId : UnauthorizedAccess',
    1,
    'forge-bootstrap',
    '[]'::jsonb,
    'phase0',
    'environment',
    'Phase 0 runs Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned before any script execution.',
    1.0000,
    true
),
-- 2. typescript_baseurl_deprecated — 100%
(
    'tsc TS5102: option baseUrl is deprecated and will stop functioning',
    'config',
    'error TS5102: Option ''baseUrl'' is deprecated and will stop functioning in TypeScript 7.0. Specify compilerOption ''ignoreDeprecations: "6.0"'' to silence this error.',
    1,
    'forge-bootstrap',
    '["nextjs-supabase"]'::jsonb,
    'phase3',
    'config',
    'Generate tsconfig.json without baseUrl; use paths with explicit ./ prefixes instead.',
    1.0000,
    true
),
-- 3. jsyaml_temp_directory — 95%
(
    'jsyaml: ENOENT no such file or directory opening temp script outside working dir',
    'config',
    'Error: ENOENT: no such file or directory, open ''C:\Users\manag\AppData\Local\Temp\forge-prompt-xxxx.yaml'' at Object.openSync (node:fs)',
    1,
    'forge-bootstrap',
    '[]'::jsonb,
    'phase3',
    'config',
    'Enforce all file writes (including temp scripts parsed by js-yaml) to the project working directory in prompt text — never $env:TEMP.',
    0.9500,
    true
),
-- 4. node_path_missing — 100%
(
    'shell: node is not recognized as an internal or external command',
    'dependency',
    '''node'' is not recognized as an internal or external command, operable program or batch file.',
    1,
    'forge-bootstrap',
    '[]'::jsonb,
    'phase0',
    'environment',
    'Phase 0 validates Node.js and prepends C:\Program Files\nodejs to $env:PATH before any execution.',
    1.0000,
    true
),
-- 5. middleware_role_default — 100%
(
    'middleware: role fetch failure routes to wrong role page instead of /login',
    'auth',
    'Role fetch returned null (Supabase query failed); user was routed to /dashboard instead of /login fallback.',
    1,
    'forge-bootstrap',
    '["nextjs-supabase"]'::jsonb,
    'phase3',
    'auth',
    'BEHAVIORAL_CONTRACTS mandates /login-only fallback on ANY role fetch failure. middleware.ts is always full-file replacement, never patched.',
    1.0000,
    true
),
-- 6. html_assumed_rendered — 90% (NOT auto-eligible: not strictly > 0.90)
(
    'render: edited public/ html not reflected; output renders from .tsx component',
    'config',
    'Edits to public/dashboard.html had no visible effect; the route actually renders from app/dashboard/page.tsx.',
    1,
    'forge-bootstrap',
    '["nextjs-supabase"]'::jsonb,
    'phase3',
    'ui',
    'Every UI prompt includes Select-String verification across *.tsx,*.ts,*.html to confirm which file actually renders before editing.',
    0.9000,
    false
),
-- 7. vercel_cdn_stale — 100%
(
    'vercel: stale cached dashboard html served from CDN',
    'config',
    'Deployed dashboard still shows old markup after deploy; Vercel CDN served cached public/ HTML.',
    1,
    'forge-bootstrap',
    '["nextjs-supabase"]'::jsonb,
    'phase3',
    'ui',
    'All dashboard HTML is served via no-cache API routes, never directly from public/.',
    1.0000,
    true
),
-- 8. supabase_rls_blocks — 85% (NOT auto-eligible)
(
    'supabase: row-level security blocks legitimate query / empty result without company_id context',
    'schema',
    'new row violates row-level security policy for table "leads"; or query returned 0 rows because the RLS policy required company_id context that the test session lacked.',
    1,
    'forge-bootstrap',
    '["nextjs-supabase"]'::jsonb,
    'phase3',
    'schema',
    'Test all RLS policies with company-scoped seed data before building any UI that depends on them.',
    0.8500,
    false
),
-- 9. missing_env_vars — 100%
(
    'runtime: required environment variable is undefined at startup',
    'config',
    'TypeError: Cannot read properties of undefined (reading ''from''); process.env.FORGE_SUPABASE_URL is undefined.',
    1,
    'forge-bootstrap',
    '[]'::jsonb,
    'phase0',
    'environment',
    'Phase 0 verifies every required environment variable is present before the build starts.',
    1.0000,
    true
),
-- 10. pnpm_lockfile_conflict — 95%
(
    'pnpm: ERR_PNPM_OUTDATED_LOCKFILE lockfile not up to date across machines',
    'dependency',
    'ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json.',
    1,
    'forge-bootstrap',
    '[]'::jsonb,
    'phase0',
    'environment',
    'On each machine, Phase 0 deletes the lockfile and runs a fresh pnpm install to avoid cross-machine lockfile conflicts.',
    0.9500,
    true
)
on conflict (error_signature) do nothing;
