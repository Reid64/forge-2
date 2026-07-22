---
id: api-patterns
name: API Route Engineering Standards
domain: api
tags: [nextjs, api, rest]
applicablePromptTypes: [api, feature]
---

RESPONSE SHAPE: All API routes return { success: boolean, data?: T, error?: { message: string, code: string, status: number }, meta?: { page, limit, total } }. Never deviate.

AUTH MIDDLEWARE: Every protected route calls a shared validateAuth(request) helper first. Returns 401 with { success: false, error: { message: Unauthorized, code: AUTH_REQUIRED, status: 401 } } if invalid.

INPUT VALIDATION: Use zod for all request body and query param validation. Define schema before handler. Return 422 with validation errors if invalid.

HTTP STATUS CODES: 200 success, 201 created, 400 bad request, 401 unauthorized, 403 forbidden, 404 not found, 409 conflict, 422 validation error, 429 rate limited, 500 internal error. Never use 200 for errors.

RATE LIMITING: Every public endpoint has rate limiting via a shared rateLimiter helper. Default 100 req/min per IP.

IDEMPOTENCY: POST endpoints that create resources accept optional Idempotency-Key header. Store in idempotency_keys table, return cached response on duplicate.

PAGINATION: All list endpoints accept page and limit query params. Default limit 20, max 100. Always return meta.total.
