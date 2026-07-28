# DEPLOYMENT-GUIDE (P6.12)

How to build, ship, and promote ETicketsGo. Cloud specifics in `docs/p6/P6.1-CLOUD-DEPLOYMENT.md`.

## Pipeline (GitHub Actions)

- **ci.yml** (PR→main): format, lint, typecheck, circular-dep, migrate+seed, unit tests, build, e2e.
- **security.yml** (PR→main + weekly): npm audit, dependency-review (fail-on-high), TruffleHog,
  **migration-drift gate**.
- **deploy.yml** (push/dispatch): CI gate → build+push images to GHCR (api/worker/3 web) →
  `prisma migrate deploy` → deploy to a **GitHub environment** (manual approval) → health/ready/
  metrics smoke.

## Image build (local/CI)

```bash
docker compose -f docker-compose.prod.yml build           # or per-app Dockerfile
```

## Run

- **Local dev:** `docker-compose.yml` (db+redis) + `npm run dev`.
- **Staging:** `-f docker-compose.prod.yml -f docker-compose.staging.yml up -d --scale api=2 --scale worker=2` (+ observability overlay).
- **Production:** `-f docker-compose.prod.yml -f docker-compose.production.yml --env-file .env.production up -d --scale api=2 --scale worker=2`.
- **Railway/AWS:** see P6.1 (Railway per-env plugins; AWS ECS Fargate/RDS/ElastiCache/S3/ECR/Secrets).

## Migrations

Run as a one-shot release step **before** app boot (`prisma migrate deploy`). Additive-only →
previous image stays compatible (safe rollback). Take a PG snapshot before every production migration.

## Rollback

Redeploy the previous immutable image tag; flags → safe defaults (see LAUNCH-CHECKLISTS.md). No
down-migrations — forward-fix only.

## Required env / secrets

`APP_ENV`, `DATABASE_URL`, `REDIS_URL`, `JWT_*`, `QR_SIGNING_SECRET`, `PAYMENT_WEBHOOK_SECRET`,
`CORS_ORIGINS`, `NEXT_PUBLIC_API_URL`, `STRIPE_*`/`RAZORPAY_*` (test in staging, live in prod),
`S3_*`, `SMTP_*`, `TRUST_PROXY_HOPS`. Set via the platform secret store — never committed.
