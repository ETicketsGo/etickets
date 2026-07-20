# ETicketsGo — Production Deployment Runbook

The single authoritative, end-to-end procedure for deploying ETicketsGo to a secure production
environment. It ties together the concrete artifacts already in the repo — do not invent new ones:

- `docker-compose.prod.yml` — full stack (Postgres, Redis, migrate, api, worker, 3 web apps).
- `docker-compose.observability.yml` — Prometheus/Grafana/OTel side-car (optional).
- `apps/api/Dockerfile` — multi-stage API/worker image.
- `.env.production.example` — production env template.
- `.github/workflows/deploy.yml` — CI → build/push (GHCR) → migrate → deploy → smoke test.
- Checklists: [DEPLOYMENT-CHECKLIST](DEPLOYMENT-CHECKLIST.md), [OPERATIONS-CHECKLIST](OPERATIONS-CHECKLIST.md),
  [ROLLBACK-CHECKLIST](ROLLBACK-CHECKLIST.md), [INCIDENT-RESPONSE](../launch/INCIDENT-RESPONSE.md).
- Posture: [Capability Inventory](../ops/CAPABILITY-INVENTORY.md), [Production Certification](PRODUCTION-CERTIFICATION-v2.1.md).

> No business features change during deployment. This runbook is infrastructure + operations only.

## 0. Prerequisites

- A container host / orchestrator (k8s, ECS, Fly, Render, or a hardened VM with Docker Compose).
- Managed **PostgreSQL 16** and **Redis 7** (or the compose services for a single-node start).
- A domain, a TLS terminator (LB/ingress/Caddy/Cloudflare), and object storage + CDN for assets.
- A secret store (cloud secret manager, or repo/environment secrets for CI).

## 1. Infrastructure

| Component      | Recommendation                                                                            | Repo reference            |
| -------------- | ----------------------------------------------------------------------------------------- | ------------------------- |
| Compute        | Orchestrated `api` + `worker` + 3 web apps as separate services; scale `api` horizontally | `docker-compose.prod.yml` |
| Database       | **Managed Postgres 16**, private network, automated backups + PITR                        | `DATABASE_URL`            |
| Redis          | **Managed Redis 7**, AOF persistence; app is fail-open if Redis is down                   | `REDIS_URL`               |
| Object storage | S3/GCS bucket for images (organizer logos/covers, add-on images, posters)                 | app uses image URLs       |
| CDN            | Front the web apps + object storage; cache `/_next/static/*` immutably                    | —                         |
| DNS            | `app.` (customer), `organizer.`, `admin.`, `api.` records → LB/ingress                    | —                         |
| SSL            | TLS at the terminator; HSTS is already set by the apps' `next.config` headers             | `apps/*/next.config.mjs`  |

## 2. Database

1. Provision Postgres 16; create the database + a least-privilege app role.
2. Apply schema: the one-shot `migrate` service runs `npx prisma migrate deploy` **before** `api`
   starts (`docker-compose.prod.yml`). Migrations are **additive-only**, so the previous API image
   stays compatible → safe rollback.
3. Verify the v2.1 performance indexes exist (added for the risk-signal scans):
   `Booking(createdAt)`, `PaymentAttempt(createdAt)`, `TicketInvite(kind,createdAt)`,
   `Refund(status,createdAt)`, `Notification(userId,channel,createdAt)`.
4. **Never seed production** — seeding is dev-only (`db:seed`). For a pilot, see the
   [Pilot Execution Guide](../launch/PILOT-EXECUTION-GUIDE.md).

## 3. Secret management

- Populate `.env.production` from `.env.production.example`. Required, ≥24 chars, non-placeholder:
  `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `QR_SIGNING_SECRET`, `PAYMENT_WEBHOOK_SECRET`,
  `MANIFEST_SIGNING_SECRET`; plus `CORS_ORIGINS` (real hosts, not localhost).
- The boot gate `assertProductionHardening` **refuses to start** in prod with placeholder/short
  secrets or unset/localhost CORS — this is the last line of defense.
- Optional provider credentials stay unset (disabled) until verified — see the Capability Inventory.
- In cloud, prefer the platform secret manager (`SECRET_MANAGER_PROVIDER=aws|gcp|azure`); the payment
  layer already resolves credentials via secret refs, never raw values in env.

## 4. Backup strategy (concrete)

**Automated (preferred):** enable managed-Postgres automated backups + **Point-In-Time Recovery**
(retain ≥7 days; ≥30 for finance). Enable Redis AOF (already on in compose) — Redis is a cache/queue,
not the system of record, so its loss is recoverable.

**Self-managed fallback (nightly cron):**

```sh
# Logical backup, gzipped, timestamped, shipped to object storage.
pg_dump "$DATABASE_URL" --format=custom --no-owner \
  | gzip > "etg-$(date -u +%Y%m%dT%H%M%SZ).dump.gz"
aws s3 cp etg-*.dump.gz s3://etg-backups/postgres/   # or gcloud/az equivalent
# Retain 30 days; verify object exists; alert on failure.
```

Back up the object-storage bucket (versioning + lifecycle) and export secrets/config to the secret
manager. Document the retention + owner in the runbook you keep with your platform.

## 5. Monitoring, logging, alerting

- **Metrics:** Prometheus scrapes `/metrics` on api + worker (`docker-compose.observability.yml`).
  Grafana dashboards for GMV, booking/confirm funnel, payment success rate, queue depth/failed,
  API latency, AI usage/fallback (admin AI console also surfaces this).
- **Logging:** ship container stdout to your log store; correlation IDs are on every request/error.
- **Tracing (optional):** set `OTEL_EXPORTER_OTLP_ENDPOINT` for OpenTelemetry; `SENTRY_DSN` for errors.
- **Alerts (minimum):** readiness flapping, payment-failure rate spike, queue-failed > 0 sustained,
  DB/Redis down, error-rate spike, disk/CPU/memory saturation. See [OPERATIONS-CHECKLIST](OPERATIONS-CHECKLIST.md).

## 6. Health checks

- **Liveness:** `GET /api/health` — lightweight uptime; wire to the orchestrator liveness probe.
- **Readiness:** `GET /api/ready` — checks DB + Redis and returns **HTTP 503 when degraded** (v2.1),
  so the LB/orchestrator deroutes the pod. Wire to the readiness probe.
- Web apps expose `/api/health` route handlers for their own probes.

## 7. Auto deployment

`deploy.yml` runs on push to `main` (or manual dispatch with an environment): CI gate → build + push
five images to GHCR (tagged by SHA + env) → `prisma migrate deploy` → **deploy step (PLACEHOLDER —
wire your k8s/ECS/Fly/Render/SSH mechanism)** → post-deploy smoke test against `*_BASE_URL`. Configure
`DEPLOY_DATABASE_URL`, `PRODUCTION_BASE_URL`/`STAGING_BASE_URL`, and your platform's deploy secrets.

## 8. Rollback

Additive-only migrations make image rollback safe: redeploy the previous image tag; the old code runs
against the newer schema unchanged. Follow [ROLLBACK-CHECKLIST](ROLLBACK-CHECKLIST.md). Only forward-fix
a migration (never hand-drop columns in prod).

## 9. Disaster recovery — verification (rehearse before launch)

DR is not "configured" until a **restore has been proven**. Rehearse in staging:

1. Take/identify a recent backup (or a PITR target time).
2. Provision a fresh Postgres; `pg_restore` the dump (or restore to the PITR timestamp).
3. Point a staging API at the restored DB; run the smoke test (`/api/ready`, a login, an event read).
4. Record **RPO** (data-loss window = backup interval / PITR granularity) and **RTO** (restore wall
   time). Targets: RPO ≤ 24h (≤ minutes with PITR), RTO ≤ 1h.
5. File the result; re-run quarterly. Redis needs no DR (rebuilds from Postgres); object storage relies
   on bucket versioning + cross-region replication.

## 10. Post-deploy verification

Run the [Production Verification Checklist](PRODUCTION-VERIFICATION-CHECKLIST.md) — every item must pass
before announcing the environment live.
