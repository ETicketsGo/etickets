# ETicketsGo — Deployment Guide

> How to build, ship, and run ETicketsGo in **staging** and **production**.
> Companions: [Operations Runbook](../reports/OPERATIONS.md),
> [Disaster Recovery](../reports/DISASTER-RECOVERY.md),
> [Scaling Guide](../reports/SCALING-GUIDE.md),
> [Runbooks](../handbooks/RUNBOOKS.md),
> [Go-Live Checklist](../reports/GO-LIVE-CHECKLIST.md).
>
> This guide describes the deployment **infrastructure-as-code** added to the
> repo (Dockerfiles, `docker-compose.prod.yml`, the `deploy.yml` pipeline, and the
> backup/restore scripts). It changes **no application behaviour** — the only app
> change is `output: 'standalone'` in each web app's `next.config.mjs`.

---

## 1. Architecture of the deployment

Five stateless application services over two stateful backing services:

| Service           | Image (Dockerfile)              | Port | Scale       | Notes                                                             |
| ----------------- | ------------------------------- | ---- | ----------- | ----------------------------------------------------------------- |
| **api**           | `apps/api/Dockerfile`           | 4000 | horizontal  | NestJS modular monolith. Serves `/api/*`, health, ready, metrics. |
| **worker**        | `apps/worker/Dockerfile`        | 4100 | ≥ 1         | BullMQ hold-expiry + notification dispatch. Health on `:4100`.    |
| **customer-web**  | `apps/customer-web/Dockerfile`  | 3000 | horizontal  | Next.js standalone.                                               |
| **organizer-web** | `apps/organizer-web/Dockerfile` | 3001 | horizontal  | Next.js standalone.                                               |
| **admin-web**     | `apps/admin-web/Dockerfile`     | 3002 | horizontal  | Next.js standalone.                                               |
| **db**            | `postgres:16-alpine`            | 5432 | vertical/HA | System of record. Named volume `db-data`.                         |
| **redis**         | `redis:7-alpine`                | 6379 | managed/HA  | Cache + BullMQ queues (AOF enabled). Not a source of truth.       |

```
                       ┌────────────── reverse proxy / LB (TLS) ──────────────┐
   users ─── https ──► │  tickets.* → customer-web:3000                        │
                       │  organizer.* → organizer-web:3001                     │
                       │  admin.*    → admin-web:3002                          │
                       │  api.*      → api:4000 (/api/*)                       │
                       └───────────────┬──────────────────────┬───────────────┘
                                       │                       │
                              ┌────────▼────────┐     ┌────────▼────────┐
   browser  ── /api ─────────►│      api        │◄────┤     worker      │
   (NEXT_PUBLIC_API_URL)      │  (stateless)    │     │  (BullMQ sweeps)│
                              └───┬─────────┬───┘     └───┬─────────┬───┘
                                  │         │             │         │
                             ┌────▼───┐ ┌───▼────┐   ┌────▼───┐ ┌───▼────┐
                             │Postgres│ │ Redis  │   │Postgres│ │ Redis  │
                             └────────┘ └────────┘   └────────┘ └────────┘
```

- The web apps call the API **from the browser** using the build-time
  `NEXT_PUBLIC_API_URL` (inlined into the bundle), so it must be the **public**
  API URL reachable by end users, including the `/api` prefix.
- **Blob storage (future):** the storage abstraction defaults to a `local` driver
  (ephemeral container path). For durable uploads/exports, point it at an
  S3-compatible bucket (`STORAGE_DRIVER`, `S3_*`). No object storage is wired in
  yet — see the Runbooks "Planned" section.

### Image design (monorepo-aware, multi-stage)

Each Dockerfile builds **from the repository root** (the monorepo is the build
context) in three stages:

1. **deps** — `npm ci` against copied manifests only (cached until a manifest
   changes).
2. **build** — build shared packages, then the target app. The API stage also runs
   `prisma generate` (Prisma engines compiled for `linux-musl` on alpine).
3. **runtime** — `node:20-alpine`, **non-root** (`USER node`), only the artifacts
   needed to run, with a container `HEALTHCHECK`.

- Web images use Next.js **standalone** output (`.next/standalone` + `.next/static`)
  for a minimal runtime — no dev toolchain, only traced production deps.
- The **API image intentionally keeps the Prisma CLI** (a devDependency) so it can
  run `prisma migrate deploy` at deploy time. The worker image is prod-only
  (`npm prune --omit=dev`); it keeps the generated `@prisma/client`.
- Build any single image, e.g.:
  ```bash
  docker build -f apps/api/Dockerfile -t eticketsgo-api .
  ```

---

## 2. The three environments

| Environment     | How it runs                                                | Compose file / pipeline                  |
| --------------- | ---------------------------------------------------------- | ---------------------------------------- |
| **development** | Postgres + Redis in Docker; apps via `npm run dev` on host | `docker-compose.yml` (db + redis only)   |
| **staging**     | Full containerised stack (or the CD pipeline)              | `docker-compose.prod.yml` / `deploy.yml` |
| **production**  | Full containerised stack via the CD pipeline               | `deploy.yml` → registry images + host    |

- **Development** is unchanged: `docker compose up -d` for the databases, then
  `npm run dev` (see Runbooks). Nothing here affects it.
- **Staging/production** use `docker-compose.prod.yml` — the same file, driven by
  a different `.env.production`. Staging should mirror production as closely as
  possible (same images, smaller instances).

### Run the full stack from compose

```bash
cp .env.production.example .env.production      # fill in real secrets
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
docker compose -f docker-compose.prod.yml --env-file .env.production ps
```

Boot order is enforced by health conditions: **db + redis healthy → `migrate`
one-shot (applies migrations, exits) → api → web apps**. The database is **never
seeded** in production.

---

## 3. Environment & secrets management

- Every required variable per service is documented in **`.env.production.example`**.
  Copy it to `.env.production`; never commit the filled-in file (it is git-ignored
  via `.env.*`).
- Prefer a real **secret store** over a plaintext file where possible: GitHub
  Actions **secrets/variables** for CI/CD, and your platform's manager
  (AWS SSM/Secrets Manager, Vault, Fly/Render secrets) at runtime.
- Generate strong secrets: `openssl rand -base64 48` for each of
  `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `QR_SIGNING_SECRET` (use **distinct**
  values), and a strong `POSTGRES_PASSWORD`.
- **Production hardening** (enforced or expected):
  - `NODE_ENV=production` and `PAYMENTS_MOCK_ENABLED=false` — the mock
    "simulate payment" path is disabled.
  - `PAYMENT_PROVIDER_NAME` set to a **real** provider (`stripe`/`razorpay`) with
    its keys + `PAYMENT_WEBHOOK_SECRET`.
  - `CORS_ORIGINS` = your real web hostnames (https, no trailing slash).
  - Notification providers set to real transports as needed (the selected provider
    fails fast on boot if its keys are missing).
- **`NEXT_PUBLIC_API_URL` is build-time** for the web images — set it before
  building (compose `build.args` / the `deploy.yml` build-arg). Changing it
  requires **rebuilding** the web images.

---

## 4. SSL/TLS & reverse proxy

Terminate TLS at a **reverse proxy or load balancer in front** of the containers —
the app services speak plain HTTP on the private network. By default
`docker-compose.prod.yml` publishes app ports on **loopback only**
(`127.0.0.1:*`), expecting a proxy on the same host; override the `*_PUBLISH` vars
if your topology differs.

Route by hostname to the right upstream:

| Public host             | Upstream             |
| ----------------------- | -------------------- |
| `api.example.com`       | `api:4000`           |
| `tickets.example.com`   | `customer-web:3000`  |
| `organizer.example.com` | `organizer-web:3001` |
| `admin.example.com`     | `admin-web:3002`     |

Example **Caddy** (automatic Let's Encrypt certificates):

```caddyfile
api.example.com       { reverse_proxy 127.0.0.1:4000 }
tickets.example.com   { reverse_proxy 127.0.0.1:3000 }
organizer.example.com { reverse_proxy 127.0.0.1:3001 }
admin.example.com     { reverse_proxy 127.0.0.1:3002 }
```

Equivalent **nginx**: a `server {}` per host with `proxy_pass`, `listen 443 ssl`,
your certs (or certbot), and `proxy_set_header X-Forwarded-Proto https`. On a
managed platform, use its built-in LB/ingress for TLS instead.

- Keep `/api/metrics` **off the public internet** — restrict it to the Prometheus
  scraper at the proxy/network layer (it is unauthenticated by design; see
  OPERATIONS §1).
- The API sets CORS from `CORS_ORIGINS`; make sure it lists the exact https web
  origins.

---

## 5. Health checks & readiness

| Probe              | Use                                                                  |
| ------------------ | -------------------------------------------------------------------- |
| `GET /api/health`  | **Liveness** — restart probe. Cheap, never touches DB/Redis.         |
| `GET /api/ready`   | **Readiness** — gate LB/rollout traffic; 503 if Postgres/Redis down. |
| `GET /api/metrics` | Prometheus exposition (`etg_*`). Ops-only, network-restricted.       |
| `GET :4100/health` | Worker liveness.                                                     |
| `GET :4100/ready`  | Worker readiness (Postgres + Redis).                                 |

- Container `HEALTHCHECK`s (liveness) are baked into every image.
- Gate rollouts / LB rotation on **`/api/ready`** so an instance that lost its DB
  or Redis is pulled out instead of serving errors.

---

## 6. Autoscaling guidance

See the [Scaling Guide](../reports/SCALING-GUIDE.md) for the full picture. Summary:

- **api** and the three **web apps** are **stateless** (JWT auth, no sticky
  sessions) → scale **horizontally** behind the LB. Set `trust proxy` at the LB.
- **worker**: run **≥ 1** replica. Jobs are idempotent and retried; BullMQ scales
  with concurrency. Do not scale it to zero (hold expiry also runs lazily in the
  booking path, but the sweep + notification dispatch need the worker).
- **Postgres**: the write-contention hot path is atomic conditional inventory
  `UPDATE`s. Add **PgBouncer** connection pooling; use **read replicas** for
  analytics/discovery. Size vertically for write throughput.
- **Redis**: managed Redis; split cache vs queue instances at scale.

---

## 7. Backup & restore

Scripts (POSIX `sh`, parameterised by `DATABASE_URL`):

```bash
# Backup → timestamped pg_dump custom-format file (default ./backups)
DATABASE_URL="postgresql://…" ./scripts/backup-db.sh [OUT_DIR]

# Restore (DESTRUCTIVE: --clean --if-exists; stop api + worker first)
DATABASE_URL="postgresql://…" ./scripts/restore-db.sh backups/eticketsgo-YYYYMMDD-HHMMSS.dump
```

- After a restore, run `npm run db:deploy` (no-op if the schema matches) and smoke
  `GET /api/ready`.
- For **production**, use **managed Postgres with PITR** (continuous WAL), not just
  nightly dumps; keep an independent weekly `pg_dump` off-provider; test restores
  quarterly. Full policy, RPO/RTO targets, and procedures:
  [Disaster Recovery](../reports/DISASTER-RECOVERY.md) and
  [Operations §5](../reports/OPERATIONS.md#5-backups--restore).
- Redis needs no backup (cache/queues re-derive).

---

## 8. First production deploy (step by step)

1. **Provision** the target host(s)/cluster, a managed Postgres 16, and Redis 7.
   Enable Postgres automated backups + PITR.
2. **DNS + TLS**: point the four hostnames at your reverse proxy/LB and issue
   certificates (§4).
3. **Secrets**: create `.env.production` from `.env.production.example` (or load the
   equivalent into your secret store). Set real DB/Redis URLs, JWT/QR secrets,
   payment provider keys + webhook secret, notification providers, `CORS_ORIGINS`,
   and the public `NEXT_PUBLIC_API_URL`.
4. **Register payment + notification webhooks** with your providers
   (`POST {API_URL}/api/payments/webhook`) — see
   [Payment Integration](./PAYMENT-INTEGRATION.md).
5. **Build & push images** — either let CI do it (push to `main` or run the
   **Deploy** workflow with an environment) or build locally and push to your
   registry. Configure the CD secrets/variables in §9.
6. **Migrate**: the pipeline / compose `migrate` one-shot runs
   `prisma migrate deploy` (additive-only). Verify it completed.
7. **Start services**: `docker compose -f docker-compose.prod.yml --env-file
.env.production up -d` (or your platform's apply/rollout).
8. **Smoke test** (the go-live gate, OPERATIONS §6):
   - `GET /api/health` → `{status:"ok"}`
   - `GET /api/ready` → 200 (Postgres + Redis up)
   - `GET /api/metrics` → 200 with `etg_` series
   - a synthetic booking → payment webhook → confirmation (canary org/event).
9. **Register the Prometheus scraper** against `/api/metrics` (network-restricted)
   and wire the alert rules (OPERATIONS §2).

Walk the [Go-Live Checklist](../reports/GO-LIVE-CHECKLIST.md) before announcing.

---

## 9. CI/CD pipeline (`.github/workflows/deploy.yml`)

Triggered on push to `main` and via **manual `workflow_dispatch`** with an
`environment` input (`dev` | `staging` | `production`). Jobs:

1. **gate** — reuses the full CI gate (`ci.yml` via `workflow_call`): format,
   lint, typecheck, circular-dep check, migrate+seed, unit tests, build, e2e.
2. **build-images** — builds + pushes all five images to **GHCR** under
   `ghcr.io/${{ github.repository }}/<service>`, tagged with the **git SHA** and
   the **environment**, using the built-in `GITHUB_TOKEN`.
3. **deploy** — runs `prisma migrate deploy` against the target DB, then the
   **PLACEHOLDER deploy step** (replace with your k8s/SSH-compose/Render/Fly
   command — the concrete host is not decided yet).
4. **smoke** — curls `/api/health`, `/api/ready`, `/api/metrics` on the deployed
   base URL.

**Configure before it can go live** (repo → Settings → Secrets and variables):

| Kind     | Name                    | Purpose                                              |
| -------- | ----------------------- | ---------------------------------------------------- |
| secret   | `DEPLOY_DATABASE_URL`   | target DB for `prisma migrate deploy`                |
| secret   | `PRODUCTION_BASE_URL`   | public API base for the smoke test                   |
| variable | `DEPLOY_BASE_URL`       | per-environment base URL (overrides above)           |
| variable | `NEXT_PUBLIC_API_URL`   | public API URL inlined into web images               |
| secret   | _(your target's creds)_ | e.g. `KUBE_CONFIG` / `SSH_KEY` / `RENDER_DEPLOY_KEY` |

`GITHUB_TOKEN` is built-in (needs `packages: write`, already set on the job).

---

## 10. Rollback

Because migrations are **additive and backward-compatible**, the previous image
keeps working against the new schema — so rollback is just redeploying the prior
image tag (no destructive down-migration).

1. Identify the last-good git SHA (its images are in GHCR, tagged by SHA).
2. Re-point services to that tag and restart:
   ```bash
   REGISTRY=ghcr.io/<owner>/<repo> IMAGE_TAG=<last-good-sha> \
     docker compose -f docker-compose.prod.yml --env-file .env.production up -d
   ```
   (or `kubectl rollout undo` / your platform's rollback).
3. Re-run the **smoke test** (§8) against the rolled-back revision.
4. If a bad **data** state is involved (not just a bad image), use PITR restore per
   [Disaster Recovery](../reports/DISASTER-RECOVERY.md).

> Automate this in the pipeline's deploy job: if the smoke step fails, redeploy the
> previous tag (see the commented example in `deploy.yml`).

---

## What still needs a real registry/host to go live

These files are **correct-by-construction** but cannot be fully validated without a
Docker build + a real target:

- A container **registry** (GHCR is wired; any OCI registry works) — set `REGISTRY`.
- A concrete **deploy target** — replace the placeholder step in `deploy.yml`
  (and/or run `docker-compose.prod.yml` on a host).
- **Managed Postgres + Redis** with backups/PITR, and the **reverse proxy/LB** with
  TLS certs.
- The CD **secrets/variables** in §9.
- `docker build` of the five images in CI to validate the Dockerfiles end-to-end
  (they were authored here without a local Docker daemon).
