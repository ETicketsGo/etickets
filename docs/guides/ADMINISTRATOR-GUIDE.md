# ETicketsGo — Administrator Guide

For platform administrators (ADMIN / SUPER_ADMIN) operating the ETicketsGo marketplace.

## Access

Admin capabilities require the ADMIN or SUPER_ADMIN role and are served in the **admin app**.
All admin routes are role-gated; every admin mutation is audited.

## Business reports (`/admin/reports`)

Read-only operations reporting with a date-range filter and CSV export where applicable:

- Daily Revenue, Organizer Revenue, Settlement, Refunds, Platform Fees, Tax (stubbed),
  Top Experiences, **Growth & Retention** (users, bookings, **new organizers**), and
  **Payment Health** (success rate overall + per provider).

## Operations console (`/admin/ops`)

- **Health** — DB/Redis/queue/storage + uptime.
- **Queues** — job counts, failed-job listing, and bounded retry (`retry-failed`, `:id/retry`).
- **Maintenance mode** — global 503 kill-switch for non-admin routes (admins + probes exempt);
  the toggle is **audited**. Use during incidents.
- **Feature flags** — resolved env-based flags (read-only).

## Payments administration

- **Payment config** (`/admin/payment-config`) — providers, routes, merchant accounts
  (fail-closed, pre-validated, audited).
- **Merchant onboarding** (`/admin/merchant-onboarding`) and **promotion**
  (`/admin/payment-promotion`) — workflows to activate real providers.
- **Live-readiness** (`GET /admin/payments/live-readiness`) — gate before `PAYMENT_LIVE_ENABLED`.
- **Finance reconciliation** (`/admin/finance`) — discrepancy triage; see
  [RECONCILIATION-OPERATIONS.md](RECONCILIATION-OPERATIONS.md).
- **Outage controls** — [PROVIDER-OUTAGE-RUNBOOK.md](PROVIDER-OUTAGE-RUNBOOK.md).

## Audit trail

`GET /admin/audit` — immutable record of sensitive actions: auth (login success/failure,
token-reuse), payments/refunds/payouts, offline activation/device/reconciliation, wallet,
maintenance toggle, and payment config changes. Use correlation IDs to join to request logs.

## Content & moderation

Admins can review events (approve/publish workflow), organizations, venues, and support/feedback.

## Security posture

- Production boots fail-closed (rejects placeholder/weak secrets, requires CORS); Swagger is
  off in production.
- Keep `OFFLINE_CHECKIN_ENABLED` and wallet flags off unless in use; live payments gated.
- Rotate secrets per [CREDENTIAL-ROTATION-RUNBOOK.md](CREDENTIAL-ROTATION-RUNBOOK.md).

## Operations references

[DEPLOYMENT.md](DEPLOYMENT.md) · [MONITORING.md](MONITORING.md) ·
[OPERATIONS-CHECKLIST](../release/OPERATIONS-CHECKLIST.md) ·
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) · [DISASTER-RECOVERY.md](../reports/DISASTER-RECOVERY.md).
