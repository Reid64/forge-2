---
id: jwt-patterns
name: JWT Authentication Patterns
domain: security
tags: [security, jwt]
applicablePromptTypes: [api, feature]
---

ALGORITHM: Sign tokens with RS256 (asymmetric), never HS256. RS256 lets the verifying service hold only the public key, so a leaked service never exposes the signing key.

ACCESS TOKEN EXPIRY: Access tokens expire in 15 minutes. Short-lived by design — a leaked access token has a small blast-radius window.

REFRESH TOKEN ROTATION: Issue a new refresh token on every use and invalidate the old one immediately (rotation). A reused/replayed old refresh token is treated as a compromise signal and revokes the entire token family.

STORAGE: Store tokens in httpOnly, Secure cookies. Never store a JWT (access or refresh) in localStorage or sessionStorage — either is readable by any injected script (XSS).

VALIDATION: On every request, validate the token's issuer (iss), audience (aud), and expiry (exp) — not just its signature. A token valid for a different service or already expired must be rejected even if the signature checks out.

REVOCATION: Maintain a refresh token blocklist/allowlist server-side so a compromised or logged-out session's refresh token can be revoked immediately, independent of its stated expiry.
