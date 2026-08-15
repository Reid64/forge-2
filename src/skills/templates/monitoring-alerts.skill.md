---
id: monitoring-alerts
name: Monitoring and Alerting Patterns
domain: observability
tags: [monitoring, sentry]
applicablePromptTypes: [api, feature]
---

SLO — 99.9% MONTHLY: The default availability target for a production service is 99.9% uptime measured monthly (~43 minutes of downtime budget) — alerting thresholds and incident severity are calibrated against this budget, not chosen arbitrarily per alert.

ERROR RATE ALERT ABOVE 1%: Alert when the request error rate exceeds 1% over a sustained window — a brief spike below that is noise; sustained error rate above it means real user impact is happening right now.

P99 LATENCY ALERT ABOVE 3S: Alert when P99 response latency exceeds 3 seconds — P99, not average, because average hides the tail where the worst-affected users actually live.

PAGERDUTY AFTER 5 MINUTES UNACKNOWLEDGED: An alert that goes unacknowledged for 5 minutes escalates to PagerDuty (or equivalent) paging — a firing alert no one has looked at is functionally the same as no alert at all.

RUNBOOK IN EVERY ALERT: Every alert links directly to a runbook describing what the alert means, how to investigate, and the first mitigation steps to try — an on-call engineer at 3am should never have to reconstruct context an alert could have carried.

POSTMORTEM FOR EVERY P0 AND P1: Every P0 (full outage) and P1 (major degradation) incident gets a written postmortem — timeline, root cause, and follow-up action items — regardless of how quickly it was resolved. Resolution speed does not exempt an incident from being learned from.
