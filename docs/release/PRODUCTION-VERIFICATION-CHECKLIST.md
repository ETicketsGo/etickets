# ETicketsGo — Production Verification Checklist

Run **after** a deploy, before announcing the environment live. Every item is a pass/fail gate.
Companion to the [Production Deployment Runbook](PRODUCTION-DEPLOYMENT-RUNBOOK.md).

## Infrastructure & config

- [ ] `GET /api/health` → `200 {status:"ok"}`.
- [ ] `GET /api/ready` → `200` with `database:up, redis:up` (and returns `503` if a dep is stopped — spot-check in staging).
- [ ] API booted **without** the hardening gate throwing (no placeholder/short secrets; `CORS_ORIGINS` set to real hosts).
- [ ] Postgres reachable only on the private network (no public 5432); Redis private.
- [ ] Prisma migrations applied (`_prisma_migrations` current); the v2.1 indexes exist.
- [ ] Swagger is **off** in production (`ENABLE_SWAGGER` unset) — `GET /api/docs` not exposed.

## TLS / DNS / CDN

- [ ] All four hosts serve valid TLS (customer/organizer/admin/api); HTTP → HTTPS redirect.
- [ ] HSTS + security headers present (`curl -I` the web apps); admin app sends `X-Frame-Options: DENY`.
- [ ] CDN caches `/_next/static/*` immutably; object-storage assets load via CDN.

## Security posture

- [ ] Unauthenticated request to an org/admin endpoint → `401`; wrong-role → `403`.
- [ ] Cross-tenant probe (org A user requesting org B data) → `403 TENANT_FORBIDDEN`.
- [ ] Rate limits active: auth (10/min), AI generation (20/min), global (120/min).
- [ ] No secrets in client bundles (`grep` built JS for key names → none).

## Payments

- [ ] Payment provider posture matches intent (mock until certified; live only after per-provider certification + `PAYMENT_LIVE_ENABLED=true`).
- [ ] Webhook endpoint reachable and signature-verified; a test event reconciles.

## Capability posture (per [Capability Inventory](../ops/CAPABILITY-INVENTORY.md))

- [ ] AI: `GET /api/admin/ai/status` shows the intended provider (disabled unless configured).
- [ ] Web push / native push / offline check-in / wallet passes: each in the intended on/off state.
- [ ] Feature flags resolve as intended (`GET /api/capabilities`).

## Observability

- [ ] `/metrics` scraped on api + worker; dashboards populated.
- [ ] Logs flowing to the store with correlation IDs; Sentry/OTel receiving (if enabled).
- [ ] Alerts armed: readiness flap, payment-failure spike, queue-failed, DB/Redis down, resource saturation.

## Reliability & data

- [ ] Worker running; repeatable jobs firing (hold-expiry, notification sweep, reconcile, token prune).
- [ ] A backup exists in object storage from the last cycle; retention policy set.
- [ ] **DR restore rehearsed** in staging with recorded RPO/RTO (see runbook §9).

## Smoke (golden path)

- [ ] Register → browse → select tickets (+ an add-on) → book → mock/real pay → receive QR ticket.
- [ ] Organizer: create event + ticket type + add-on/bundle; view dashboard + reports.
- [ ] Admin: dashboard, users, events, AI console load; audit log records the above actions.

**Sign-off:** environment ____________ date ________ operator ____________ result: GO / NO-GO.
