# ETicketsGo — Troubleshooting Guide

Common issues and how to resolve them. For incidents, use [INCIDENT-RESPONSE](../launch/INCIDENT-RESPONSE.md).

## Startup / deploy

**API won't boot in production — "Insecure production configuration".**
By design: a core signing secret (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`QR_SIGNING_SECRET`, `PAYMENT_WEBHOOK_SECRET`) is a placeholder or `<24` chars, or
`CORS_ORIGINS` is unset/localhost. Set real secrets + the real frontend origin.

**API won't boot — "Invalid environment configuration".**
A required env var is missing/malformed (e.g. `DATABASE_URL`). Check the listed fields.

**`prisma generate`/`migrate` fails with EPERM (Windows).**
The API (`dist/main.js`) is running and holds the query-engine DLL. Stop it first.

**Frontends serve stale chunks / 404 after a build.**
`npm run build` overwrote `.next` while `next start` was live. Restart the frontends.

## Payments

**Payment shows 500 / generic error.**
Since RC1, provider errors are classified: 402 = declined/insufficient funds, 400 = invalid,
503 = provider unavailable. A real 500 is unexpected — check logs by correlation ID + Sentry.

**Customer charged but no ticket.**
Confirmation is webhook-driven. Check `Payment.status` + webhook receipt; re-drive via the
reconciliation console. Idempotent handlers prevent double-issue.

**Live payments not working.**
`PAYMENT_LIVE_ENABLED` must be true AND the provider must have an ACTIVE merchant + PASS
certification + live-readiness GO. In production, mock is force-disabled. Check
`GET /admin/payments/live-readiness`.

## Offline check-in

**Offline endpoints return 404.**
`OFFLINE_CHECKIN_ENABLED` is off (default). Enable it for the pilot scope only.

**Activation is NO_GO.**
Missing/failed/stale drill evidence, unapproved device, expired manifest, or no admin
activation. See [PILOT-RUNBOOK.md](PILOT-RUNBOOK.md) + preflight.

**Panel warns durable queueing is unavailable.**
IndexedDB is disabled (private mode / unsupported browser) — use a supported browser or stay
online; do not rely on offline mode there.

## Infrastructure

**Redis outage.**
Cache + maintenance guard fail open (bounded by a command timeout); booking/hold-expiry is
DB-backed and continues; the worker resumes on reconnect. No action needed for a brief blip.

**Queue backlog growing.**
Check worker health + `etg_queue_jobs{state="failed"}`; retry failed jobs via
`/admin/ops/queues/retry-failed`. Sweeps are batched (500/tick) — a large backlog drains over
several ticks.

**DB connection exhaustion at scale.**
Set an explicit `connection_limit` in `DATABASE_URL` per instance (and/or PgBouncer) —
see [DEPLOYMENT.md](DEPLOYMENT.md) and [KNOWN-LIMITATIONS](../release/KNOWN-LIMITATIONS.md).

## Support / privacy

**Data export/erasure (DSAR) request.**
The self-serve workflow is a documented follow-up; handle manually per
[SUPPORT-WORKFLOWS](../commercial/SUPPORT-WORKFLOWS.md) + the Privacy Policy data map.

## Diagnosis toolkit
Correlation IDs in logs · `/api/metrics` + worker metrics · Sentry · `/admin/ops/health` ·
audit trail · reconciliation console.
