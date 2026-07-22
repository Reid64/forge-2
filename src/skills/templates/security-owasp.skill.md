---
id: security-owasp
name: OWASP Top 10 Security Standards
domain: security
tags: [security, owasp]
applicablePromptTypes: [api, feature, database]
---

SQL INJECTION: Always use parameterized queries or an ORM's built-in query builder. Never build SQL via string concatenation or template literals with user input. Every user-supplied value is passed as a bound parameter, never interpolated into the query string.

XSS: Encode all output rendered into HTML. Never use innerHTML/dangerouslySetInnerHTML with user-supplied or unsanitized content. Use the framework's default text-escaping rendering path (e.g. JSX text nodes) for any value that could contain user input.

CSRF: Session/auth cookies set with SameSite=Lax or SameSite=Strict. State-changing requests (POST/PUT/PATCH/DELETE) never rely on cookies alone for auth when SameSite protection is unavailable (cross-site embeds, legacy clients) — use a CSRF token in that case.

IDOR: Every resource fetch/mutation by ID verifies the requesting user owns or is authorized for that specific resource server-side, never trusting a client-supplied company_id/user_id/resource_id alone. Ownership check happens before any read or write, not after.

SENSITIVE DATA: Encrypt sensitive data at rest (PII, tokens, secrets). Never log secrets, passwords, tokens, or full payment/PII details — redact or omit them from logs and error messages entirely.

BROKEN ACCESS CONTROL: Authorization decisions are made server-side on every request. Never trust a client-side role/permission check as the sole gate — the UI hiding a button is not a security control, the API route must independently verify.

LOGGING: Every authentication event (login success, login failure, logout, password change, permission change, token refresh) is written to an audit trail with timestamp, actor, and outcome.
