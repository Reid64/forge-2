---
id: stripe
name: Stripe Integration Patterns
domain: billing
tags: [stripe, billing, payments]
applicablePromptTypes: [api, feature, agent]
---

CLIENT INIT: Singleton getStripeClient() from src/lib/stripe/client.ts. Server-side only. Never expose secret key to client. Client-side uses NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY with @stripe/stripe-js.

WEBHOOK HANDLING: Always verify webhook signature using stripe.webhooks.constructEvent(body, signature, STRIPE_WEBHOOK_SECRET). Use raw body not parsed JSON. Return 400 if verification fails.

IDEMPOTENCY: All Stripe API calls pass idempotencyKey option. Key = [operation]-[entityId]-[timestamp]. Prevents duplicate charges on retry.

CUSTOMER SYNC: Stripe customer ID stored in users table as stripe_customer_id. Create customer on first billing action, never on signup. Sync email changes to Stripe.

SUBSCRIPTION LIFECYCLE: Handle all subscription webhook events: created, updated, deleted, payment_failed, trial_ending. Update local subscription_status on every event.

METADATA: Every Stripe object created includes metadata: { userId, companyId, environment: process.env.NODE_ENV }.

TEST MODE: Stripe test mode in development. Never use live keys in development or staging.
