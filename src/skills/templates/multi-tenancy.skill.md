---
id: multi-tenancy
name: Multi-Tenancy Standards
domain: database
tags: [supabase, rls, saas]
applicablePromptTypes: [database, api, feature]
---

TENANT COLUMN: Every table that holds tenant-scoped data has a company_id or organization_id column (uuid, NOT NULL, references companies/organizations). Pick one name per project and use it consistently across every table - never mix company_id and organization_id in the same schema.

RLS: Every table has RLS enabled, no exceptions. Every policy filters on the tenant column against the caller's session (e.g. company_id = (auth.jwt() ->> 'company_id')::uuid), scoped separately for select/insert/update/delete. A table with RLS disabled "for now" is a defect, not a shortcut.

SERVICE ROLE: The service-role key (which bypasses RLS) is used only for legitimate admin/background operations, server-side only, never exposed to a client bundle or used as a default connection for user-facing requests. Every service-role query manually re-applies the tenant filter in application code, since RLS is not there to catch a mistake.

CROSS-TENANT DATA: Never expose data from a different tenant, in payloads, error messages, counts, or aggregate stats. A 404 (not a 403) is the correct response when a resource exists but belongs to another tenant, so existence itself is never leaked.

TENANT ID SOURCE: The tenant ID is always derived server-side from the authenticated session/JWT, never accepted from the request body, query string, or a client-supplied header. A request body containing a company_id/organization_id field is ignored for authorization purposes, even if present.
