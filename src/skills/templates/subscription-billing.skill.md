---
id: subscription-billing
name: Subscription Billing Lifecycle
domain: business
tags: [stripe, billing]
applicablePromptTypes: [feature, api]
---

STATE MACHINE: Every subscription is exactly one of trial, active, past_due, canceled at all times. Transitions are driven by Stripe webhook events, never guessed client-side or set optimistically before the webhook confirms it.

PRORATION: Plan upgrades/downgrades and mid-cycle changes use Stripe's own proration calculation (create_prorations / always_invoice). Never hand-compute a prorated amount locally — Stripe is the source of truth for billing math.

DUNNING SCHEDULE: On a failed payment, retry per a fixed dunning schedule — day 1, day 3, day 7 — then cancel the subscription if it still hasn't recovered. Each retry attempt and its outcome is logged against the subscription.

GRACE PERIOD: A past_due subscription retains access for a 3 day grace period from the first failed payment before any feature-gating kicks in, giving the dunning retries room to succeed first.

REACTIVATION: Reactivating a canceled subscription restores the customer's previous plan (not a default/free plan) unless the customer explicitly selects a different one during reactivation.

WEBHOOK-DRIVEN STATE ONLY: Local subscription_status is updated only from verified Stripe webhook events (customer.subscription.updated/deleted, invoice.payment_failed/succeeded), never from a client-initiated request claiming a new status.
