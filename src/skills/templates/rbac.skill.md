---
id: rbac
name: Role-Based Access Control Patterns
domain: security
tags: [security, auth, permissions]
applicablePromptTypes: [api, feature, database]
---

ROLE STORAGE: Roles and role assignments live in the database, never hardcoded in application code. A role's permission set is data, not a compiled-in switch statement, so it can change without a deploy.

PERMISSION CHECKS: Every permission check runs server-side, on every request that touches a protected resource or action. A client-side check (hiding a menu item, disabling a button) is a UX nicety only — it is never the enforcement point.

LEAST PRIVILEGE: Default to deny. A role or user has no access to a resource/action unless explicitly granted. New roles start with zero permissions, not an inherited broad default.

AUDIT LOGGING: Every permission-check failure (an attempt to access a resource/action the actor is not authorized for) is written to an audit log with actor, resource, action, and timestamp — not just successes.

RESOURCE-LEVEL PERMISSIONS: In a multi-tenant system, permissions are scoped per resource/company_id, not merely per global role. Holding a role in one tenant never grants access to another tenant's resources of the same type.
