# ETicketsGo — Release Candidate 1 (RC1) Release Notes

**Status:** Release Candidate · **Scope:** Phase 1 platform · **Posture:** production-ready, fail-closed by default.

RC1 is the first production-deployment candidate for ETicketsGo — an event operating
system spanning customer, organizer, and admin experiences on a NestJS API with a
Postgres/Prisma core, a Redis/BullMQ worker, and three Next.js apps. This document
summarizes what RC1 contains, what changed during RC hardening, and where to look for
operational detail.

---

## What's in RC1

**Core commerce & ticketing**
- Event/session/ticket-type catalog, inventory with atomic DB-backed seat holds and lazy
  expiry, coupons, fees, refunds, payouts.
- Booking → payment → ticket issuance with idempotent, replay-safe state transitions.
- QR tickets (rotating nonce + version, single-use atomic check-in claim) and online
  gate check-in.

**Payments platform (multi-country, multi-provider)**
- Runtime-configurable provider routing (mock/Stripe/Razorpay/PayPal/Square) with circuit
  breaker, bounded retry, and provider failover.
- Secret-reference resolution via env/Azure/AWS/GCP secret managers; live payments gated
  behind `PAYMENT_LIVE_ENABLED` + per-merchant sandbox certification + live-readiness.
- Webhook routing, reconciliation, settlement, outage runbook, launch gate.

**Offline gate check-in (ADR-035)** — shipped behind `OFFLINE_CHECKIN_ENABLED` (OFF by
default; endpoints 404 when disabled): signed device manifests, durable client queue with
retry/backoff/dead-letter, controlled activation, reconciliation console, live command
center, device lifecycle, preflight, and a first-pilot runbook + simulation.

**Wallet passes (Apple/Google)** — behind per-provider flags (unavailable/fail-closed by
default); a wallet pass is a projection of an existing valid ticket (same signed QR),
credentials referenced only, never sent to the browser.

**Observability & ops** — Prometheus metrics (API + worker), liveness/readiness probes,
correlation IDs, normalized error envelope, optional Sentry + OpenTelemetry, immutable
audit trail, admin ops console (queue depth, failed-job retry, maintenance toggle).

---

## RC1 hardening changes (this release)

RC1 was produced by a full production-readiness, observability, and security audit. Only
genuine, minimal, backward-compatible fixes were applied — no system was redesigned.

**Security**
- **Production fail-closed config guard** — boots in `NODE_ENV=production` / `APP_ENV`
  STAGING|PRODUCTION now reject shipped-placeholder or weak (`< 24` char) core signing
  secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `QR_SIGNING_SECRET`,
  `PAYMENT_WEBHOOK_SECRET`, and `MANIFEST_SIGNING_SECRET` when set) and require an explicit
  non-localhost `CORS_ORIGINS`. Lower environments are unaffected.
- **Offline read-endpoint authorization** — `GET /checkin/offline-readiness` and
  `GET /checkin/activation` now enforce `assertMember` (org staff), closing a cross-tenant
  operational-status read.
- **Security headers on all web apps** — HSTS, `X-Frame-Options` (DENY on admin),
  `X-Content-Type-Options`, `Referrer-Policy`, and CSP `frame-ancestors` (anti-clickjacking).
- **Swagger disabled in production** unless `ENABLE_SWAGGER=true`.

**Resilience & observability**
- **Redis fail-open hardened** — the API's Redis client now uses a command timeout and no
  offline queue, so a Redis outage degrades gracefully (cache/maintenance fail open)
  instead of hanging requests.
- **Payment errors correctly classified** — `PaymentProviderError` maps to proper HTTP
  status (402 declines, 400 invalid, 409 duplicate, 503 provider-unavailable) instead of an
  opaque 500; card declines no longer page Sentry.
- **Audit coverage extended** — auth login success/failure, refresh-token reuse detection,
  and the ops maintenance toggle now write audit entries.
- **Web-tier health routes** — `/api/health` added to customer/organizer/admin apps for LB
  liveness checks.
- **Log hygiene** — the exception filter no longer logs query strings (token/PII safety).

**Build/config hygiene** — added `.nvmrc` (Node 20), a proprietary `LICENSE`, and the
previously-undocumented operational/launch env vars to `.env.example`.

See the full audit outcome in [RC-READINESS-REPORT.md](RC-READINESS-REPORT.md).

---

## Default production posture (verified)

- `OFFLINE_CHECKIN_ENABLED` **off** → offline endpoints 404, activation NO_GO.
- Wallet providers **unavailable** unless explicitly configured.
- `PAYMENT_LIVE_ENABLED` **false**; mock payments **force-disabled** in production.
- Feature flags: shipped features on, enterprise capabilities off.
- The API **refuses to boot** in production with placeholder/weak core secrets or
  unconfigured CORS.

## Companion documents

| Document | Purpose |
| --- | --- |
| [DEPLOYMENT-CHECKLIST.md](DEPLOYMENT-CHECKLIST.md) | Step-by-step go-live checklist |
| [ROLLBACK-CHECKLIST.md](ROLLBACK-CHECKLIST.md) | Safe rollback procedure |
| [OPERATIONS-CHECKLIST.md](OPERATIONS-CHECKLIST.md) | Day-2 operations |
| [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md) | Accepted RC1 limitations + follow-ups |
| [EXTERNAL-DEPENDENCIES.md](EXTERNAL-DEPENDENCIES.md) | Third-party services required to go live |
| [RC-READINESS-REPORT.md](RC-READINESS-REPORT.md) | Final readiness assessment & score |

Deep-dive guides: [DEPLOYMENT.md](../guides/DEPLOYMENT.md), [MONITORING.md](../guides/MONITORING.md),
[PILOT-RUNBOOK.md](../guides/PILOT-RUNBOOK.md), [PAYMENT-PLATFORM.md](../guides/PAYMENT-PLATFORM.md),
[DISASTER-RECOVERY.md](../reports/DISASTER-RECOVERY.md).
