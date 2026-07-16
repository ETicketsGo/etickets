# ETicketsGo RC1 — Deployment Checklist

A pre-flight → deploy → verify checklist for a production go-live. It complements the
full [DEPLOYMENT.md](../guides/DEPLOYMENT.md) guide (architecture, images, TLS, autoscaling)
and assumes managed Postgres + Redis and the CI/CD pipeline in `.github/workflows/deploy.yml`.

Legend: ☐ to do · each block gates the next.

## 1. Pre-deploy — infrastructure
- ☐ Managed Postgres provisioned; PITR/backups enabled (RPO ≤ 5 min — see [DISASTER-RECOVERY.md](../reports/DISASTER-RECOVERY.md)).
- ☐ Managed Redis provisioned and reachable from API + worker.
- ☐ TLS terminates at the reverse proxy; HTTP→HTTPS redirect in place (web apps now send HSTS).
- ☐ DNS for customer/organizer/admin hosts + API host resolved.

## 2. Pre-deploy — configuration & secrets
- ☐ Real, unique, high-entropy secrets set (NOT placeholders): `JWT_ACCESS_SECRET`,
  `JWT_REFRESH_SECRET`, `QR_SIGNING_SECRET`, `PAYMENT_WEBHOOK_SECRET`. *(The API now
  refuses to boot in production with placeholder/short secrets.)*
- ☐ `NODE_ENV=production` and `APP_ENV=PRODUCTION`.
- ☐ `CORS_ORIGINS` set to the real frontend origins (comma-separated; not localhost).
- ☐ `DATABASE_URL`, `REDIS_URL` set.
- ☐ Secrets sourced from the secret manager: `SECRET_MANAGER_PROVIDER=aws|azure|gcp`
  (env backend is rejected in production).
- ☐ `ENABLE_SWAGGER` unset/false (Swagger stays off in production).
- ☐ Feature flags reviewed: `OFFLINE_CHECKIN_ENABLED` off unless a pilot is scheduled;
  wallet flags off unless configured; enterprise flags as intended.
- ☐ Sentry/OTel configured if used (`SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`).
- ☐ Notification transports configured or left as `log` deliberately.

## 3. Pre-deploy — payments (only if going live with real payments)
- ☐ `PAYMENT_LIVE_ENABLED=true` **only after**: provider config validated, ACTIVE merchant
  account, PASS sandbox certification, and live-readiness GO (`GET /admin/payments/live-readiness`).
- ☐ Provider webhooks point at `/api/payments/webhook/:provider`; webhook secrets set.
- ☐ Otherwise leave `PAYMENT_LIVE_ENABLED=false` (mock is force-disabled in prod — no payments).

## 4. Build & release
- ☐ CI green on the release commit (format, lint, typecheck, circular-dep, unit, build, e2e).
- ☐ Images built and tagged by commit SHA (`deploy.yml`).
- ☐ Node runtime is 20.x (`.nvmrc`); images built with `npm ci` against the committed lockfile.

## 5. Database migration
- ☐ Back up the database immediately before migrating.
- ☐ Run `prisma migrate deploy` (NOT `migrate dev`) — additive-only, safe on populated tables.
- ☐ Do **not** run the seed against production.

## 6. Deploy & verify
- ☐ Roll out API, worker, and the three web apps.
- ☐ API readiness green: `GET /api/health/ready` → 200 (DB + Redis up).
- ☐ Worker readiness green (worker `/ready`).
- ☐ Web liveness green: `GET /api/health` on each web app → 200.
- ☐ Metrics scraping: `GET /api/metrics` and worker metrics return data.
- ☐ Smoke test: browse an event, register, book with a real/sandbox payment, receive a
  ticket, check it in online.
- ☐ Confirm posture: `GET /api/checkin/offline-readiness` flag=false (offline endpoints 404);
  wallet providers unavailable (unless configured); `GET /api/docs` 404 (Swagger off).
- ☐ Confirm security headers present on each web host (HSTS, X-Frame-Options, CSP).

## 7. Post-deploy
- ☐ Watch error rate / latency / queue depth for the first hour (Prometheus/Grafana + Sentry).
- ☐ Verify audit entries are being written (login, admin actions).
- ☐ Announce completion; record the deployed commit SHA and migration state.

**Go-live gate:** proceed only when every ☐ above is checked and section 6 verification passes.
