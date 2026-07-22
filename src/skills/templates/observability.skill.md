---
id: observability
name: Error Monitoring and Observability Patterns
domain: observability
tags: [sentry, logging, monitoring]
applicablePromptTypes: [feature, api, agent]
---

ERROR BOUNDARIES: Every page has an error.tsx boundary. Every async server component wraps in try/catch. Errors logged to console.error with context object: { userId, route, input }.

STRUCTURED LOGGING: Use a shared logger from src/lib/logger.ts. Logger outputs JSON in production, pretty in development. Every log entry includes: timestamp, level, message, context object. Levels: debug, info, warn, error.

PERFORMANCE MONITORING: API routes log response time. Threshold warnings: > 500ms warn, > 2000ms error. Use performance.now() not Date.now().

HEALTH CHECKS: Every project has /api/health route returning { status: ok, version, timestamp, services: { database: ok/error, cache: ok/error } }.

SENTRY INTEGRATION: If NEXT_PUBLIC_SENTRY_DSN is set: initialize Sentry in src/instrumentation.ts, wrap all API routes with Sentry.withSentry, capture exceptions with Sentry.captureException(error, { extra: context }).

ALERT THRESHOLDS: Error rate > 1% of requests triggers alert. P99 latency > 3s triggers alert. Database connection failures always trigger alert.
