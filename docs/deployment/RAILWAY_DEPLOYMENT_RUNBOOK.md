# ETicketsGo — Railway Deployment Runbook

> **The authoritative document for deploying ETicketsGo to Railway across three isolated
> environments.** Every step below is grounded in this repository's real service names,
> Dockerfiles, commands, and health endpoints.
>
> Companions:
> [Go-Live Checklist](./RAILWAY_GO_LIVE_CHECKLIST.md) ·
> [Cloudflare & DNS](./CLOUDFLARE_DNS.md) ·
> [Cost & Sizing](./RAILWAY_COST_SIZING.md) ·
> [Backup & Recovery](./RAILWAY_BACKUP_RECOVERY.md) ·
> [AWS topology](../p6/P6.1-CLOUD-DEPLOYMENT.md) ·
> [Docker Compose](../guides/DEPLOYMENT.md)

**Nothing in this repository has been deployed.** No Railway project, service, plugin,
domain, or token exists yet. Every portal step below is written for the repository owner to
execute with their own authenticated access. Placeholders are marked `<LIKE_THIS>`.

---

## 0. What you are building

Three **separate Railway projects** — not three environments inside one project. Railway
project tokens are scoped per project, so separate projects give you credential isolation
in CI as well as resource isolation, and make it impossible to accidentally pick the wrong
environment from a dropdown while holding production credentials.

```
ETicketsGo-QA              ETicketsGo-UAT             ETicketsGo-Production
├── api                    ├── api                    ├── api          (≥2 replicas)
├── worker                 ├── worker                 ├── worker
├── customer-web           ├── customer-web           ├── customer-web (≥2 replicas)
├── organizer-web          ├── organizer-web          ├── organizer-web
├── admin-web              ├── admin-web              ├── admin-web
├── Postgres  (plugin)     ├── Postgres  (plugin)     ├── Postgres  (plugin)
└── Redis     (plugin)     └── Redis     (plugin)     └── Redis     (plugin)
```

Five application services per project. There is **no separate scheduler service** — the
schedule lives in BullMQ repeatable jobs registered by the `worker` process at boot
(`expire-holds`, `dispatch-notifications`, `process-webhooks`, `inventory-sync-sweep`,
`outbox-dispatch`, `outbox-maintenance`, `reconcile-finance`, `prune-tokens`). Do not
invent one.

### Branch → environment flow

```
feature/*  ──PR──▶  develop  ──▶  QA          (automatic on push)
                       │
                    release/*  ──▶  UAT       (automatic on push)
                       │
                      main    ──▶  Production (NOT automatic — dispatch only, §13)
```

Every environment additionally requires its `DEPLOY_ENABLED_<ENV>` repository variable to
be `true`, so a branch can exist and build long before it can deploy anywhere.

---

## 1. Creating the three Railway projects

For each of `ETicketsGo-QA`, `ETicketsGo-UAT`, `ETicketsGo-Production`:

1. Railway dashboard → **New Project** → **Empty Project**.
2. Rename it (**Settings → General → Project Name**) to the exact name above.
3. **Settings → General → Environments**: keep the single default environment
   (`production`). Railway's per-project "environments" are a second isolation axis you do
   not need here — one Railway environment per Railway project keeps the model flat and the
   token scoping unambiguous.

> **Why three projects and not one project with three environments?** A Railway _project
> token_ grants access to a project. With one project, the same token reaches QA, UAT and
> Production, and your CI would hold a credential that can deploy to production on every
> QA run. Three projects means the QA token is structurally incapable of touching
> production.

---

## 2. Connecting the GitHub repository

Do this **once per project**, on the first service you create (step 3).

1. In the project → **New** → **GitHub Repo** → authorise the Railway GitHub App if
   prompted → select this repository.
2. Grant the app access to **only this repository**, not the whole org.

Railway will offer to auto-deploy on push. **Turn that off** for every service — see
step 11. The GitHub Actions workflow is the only thing that should trigger a deployment,
because it is what runs the verification gate first.

---

## 3. Creating each application service

Repeat for all five services in each project. Service **names matter** — the deploy
workflow looks them up by name from GitHub Environment variables.

| Service name    | Dockerfile                      | Config-as-code path                         | Public? |
| --------------- | ------------------------------- | ------------------------------------------- | ------- |
| `api`           | `apps/api/Dockerfile`           | `deploy/railway/api.railway.json`           | yes     |
| `worker`        | `apps/worker/Dockerfile`        | `deploy/railway/worker.railway.json`        | **no**  |
| `customer-web`  | `apps/customer-web/Dockerfile`  | `deploy/railway/customer-web.railway.json`  | yes     |
| `organizer-web` | `apps/organizer-web/Dockerfile` | `deploy/railway/organizer-web.railway.json` | yes     |
| `admin-web`     | `apps/admin-web/Dockerfile`     | `deploy/railway/admin-web.railway.json`     | yes     |

For each:

1. Project → **New** → **GitHub Repo** → pick this repo.
2. **Settings → General → Service Name** → set to the name in the table.
3. **Settings → Config-as-code → Railway Config File** → set the path from the table.

   That file supplies the builder, Dockerfile path, start command, health-check path,
   pre-deploy (migration) command, and restart policy. Setting it means those values live
   in git and are reviewed like code, instead of drifting in a dashboard nobody diffs.

---

## 4. Setting the correct root directory

**Leave Root Directory EMPTY (`/`) for all five services.**

This is the one setting people reflexively get wrong on a monorepo. It is tempting to set
`apps/api` as the root of the `api` service — that will fail. Every Dockerfile here builds
from the **repository root** as its context: they `COPY package.json package-lock.json`,
then each workspace's manifest (`packages/*/package.json`, `apps/*/package.json`), run a
single `npm ci` for the whole workspace, and build with turbo. With Root Directory set to
`apps/api`, Docker's build context is that subdirectory and every one of those `COPY`
lines fails with "file not found".

The per-service Dockerfile is selected by `build.dockerfilePath` in the config file, not
by the root directory.

**Optional but recommended — watch paths.** To stop an unrelated change from rebuilding all
five services, set **Settings → Build → Watch Paths** per service:

| Service         | Watch paths                                                            |
| --------------- | ---------------------------------------------------------------------- |
| `api`           | `apps/api/**`, `packages/**`, `package-lock.json`, `deploy/railway/**` |
| `worker`        | `apps/worker/**`, `apps/api/**`, `packages/**`, `package-lock.json`    |
| `customer-web`  | `apps/customer-web/**`, `packages/**`, `package-lock.json`             |
| `organizer-web` | `apps/organizer-web/**`, `packages/**`, `package-lock.json`            |
| `admin-web`     | `apps/admin-web/**`, `packages/**`, `package-lock.json`                |

The `worker` watches `apps/api/**` because it imports `@eticketsgo/api` at runtime.

---

## 5. Adding PostgreSQL

Per project: **New** → **Database** → **Add PostgreSQL**.

1. Rename the service to `Postgres` (**Settings → Service Name**) so the variable
   references in step 7 resolve.
2. **Settings → Backups**: verify the retention Railway gives you on your plan, and record
   it in [Backup & Recovery](./RAILWAY_BACKUP_RECOVERY.md). Do not assume a default.
3. Production only — **Settings → Networking**: leave the public proxy **disabled** unless
   you specifically need external access. Services reach it over the private network.

The schema is applied by `prisma migrate deploy` (step 14); there is nothing to import by
hand. Forty migrations exist in `apps/api/prisma/migrations/`.

---

## 6. Adding Redis

Per project: **New** → **Database** → **Add Redis**. Rename it to `Redis`.

Redis here holds seat locks, BullMQ queues, the read-through cache, and the maintenance
flag. It is **never a source of truth** — PostgreSQL is authoritative for all of it, so a
Redis loss degrades throughput, not correctness.

Each project gets its own instance, which is the primary isolation boundary. The
application _additionally_ namespaces every key by `APP_ENV`
(`apps/api/src/common/redis-namespace.ts`), so even a mis-pasted `REDIS_URL` cannot make
QA consume production jobs:

| Concern                                          | Key shape                   | Source                    |
| ------------------------------------------------ | --------------------------- | ------------------------- |
| BullMQ queues                                    | `etg:<env>:bull:*`          | `bullPrefix(APP_ENV)`     |
| Read-through cache                               | `etg:<env>:cache:*`         | `cacheKeyPrefix(APP_ENV)` |
| Seat / quantity locks, fencing, lock idempotency | `etg:<env>:invlock:*`       | `InventoryLockKeys`       |
| Maintenance flag                                 | `etg:<env>:ops:maintenance` | `opsKeyPrefix(APP_ENV)`   |

OTP codes, refresh tokens, booking idempotency keys and rate limits are **not** in Redis —
they are in PostgreSQL or in-process, and are therefore isolated by the separate database.

---

## 7. Connecting service variables

Use Railway **variable references** rather than pasting connection strings. A reference
resolves at deploy time and follows credential rotation automatically; a pasted URL is
how a service ends up silently pointed at another environment's database.

On both `api` and `worker`, add:

```
DATABASE_URL = ${{Postgres.DATABASE_URL}}
REDIS_URL    = ${{Redis.REDIS_URL}}
```

If the plugin exposes `*_PRIVATE_URL` variants, prefer them: private-network traffic
avoids egress charges and keeps the datastore off the public internet.

Do **not** set `DATABASE_URL` or `REDIS_URL` on the three web services. They are pure
Next.js frontends and talk only to the API over HTTPS.

---

## 8. Adding environment variables

Work from the template for the environment you are configuring:

- `deploy/railway/env/qa.env.example`
- `deploy/railway/env/uat.env.example`
- `deploy/railway/env/production.env.example`

Each variable is grouped by category and marked `[REQUIRED]`, `[OPTIONAL]`, `[GENERATED]`,
`[REFERENCE]`, `[TEST-ONLY]` or `[PROD-ONLY]`, with a note saying which services need it.

**Bulk entry:** Railway's variable editor has a **Raw Editor** that accepts `KEY=value`
lines pasted in one go. Strip the comments first.

### Generate secrets — never reuse across environments

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET   (must differ from the access secret)
openssl rand -base64 48   # QR_SIGNING_SECRET
openssl rand -base64 48   # PAYMENT_WEBHOOK_SECRET
```

Run this **twelve times** — four secrets × three environments. A QA-signed JWT or ticket QR
must not validate in Production, and that property only holds if the values differ.

### The variables that must be right

`APP_ENV` is the single most consequential variable on this platform. It selects the
payment environment, drives fail-closed credential validation, and namespaces every Redis
key. Set it to exactly `QA`, `UAT`, or `PRODUCTION`.

`NEXT_PUBLIC_API_URL` is **build-time**. The Dockerfiles declare it as `ARG` and Next.js
inlines it into the JavaScript bundle. Railway passes service variables as Docker build
args, so it must be set **before the first build** of each web service, and changing it
requires a **rebuild**, not a restart.

### What the API refuses to boot with

These are enforced in `apps/api/src/config/configuration.ts` and are deliberate. If a
deploy fails at startup with one of these, fix the configuration — do not work around it.

| Condition                                                                             | Where                                                             |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Placeholder secret (`CHANGE_ME`, `replace_me`, `your_`, …) or a secret under 24 chars | prod-like                                                         |
| `CORS_ORIGINS` unset, or containing `localhost`                                       | prod-like                                                         |
| `STRIPE_SECRET_KEY` is `sk_test_…`                                                    | `APP_ENV=PRODUCTION` (no override)                                |
| `RAZORPAY_KEY_ID` is `rzp_test_…`                                                     | `APP_ENV=PRODUCTION` (no override)                                |
| `STRIPE_SECRET_KEY` is `sk_live_…`                                                    | QA/UAT/DEV/LOCAL, unless `PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV=true` |
| `RAZORPAY_KEY_ID` is `rzp_live_…`                                                     | QA/UAT/DEV/LOCAL, unless the same override                        |
| `PAYMENT_PROVIDER_NAME=mock`                                                          | `APP_ENV=PRODUCTION`                                              |
| `RAZORPAY_MODE` disagreeing with the key prefix                                       | every environment                                                 |
| `RAZORPAY_WEBHOOK_SECRET == RAZORPAY_KEY_SECRET`                                      | every environment                                                 |
| `STRIPE_WEBHOOK_SECRET == PAYMENT_WEBHOOK_SECRET`                                     | every environment                                                 |
| Automatic refund/void enabled                                                         | `APP_ENV=PRODUCTION`                                              |
| `INVENTORY_SYNC_MOCK_PROVIDER_ENABLED=true`                                           | prod-like                                                         |
| `BOOKING_PROVIDER_CONFIRMATION_ENABLED=true`                                          | prod-like (no real adapter exists yet)                            |

---

## 9. Configuring health checks

The health-check path comes from the config-as-code file — you do not set it in the UI.
Confirm under **Settings → Deploy** that it shows:

| Service  | Health check  | What it proves                               |
| -------- | ------------- | -------------------------------------------- |
| `api`    | `/api/health` | process is up (never touches DB/Redis)       |
| `worker` | `/health`     | process is up                                |
| `*-web`  | `/api/health` | static Next route handler; no upstream calls |

Railway's health check gates the rollout: a new deployment does not receive traffic until
it passes, and the previous deployment keeps serving until then.

**Readiness is separate and deeper.** `GET /api/ready` (API) and `GET :PORT/ready`
(worker) check PostgreSQL _and_ Redis and return **503** when either is down. Railway's
health check does not use it — the smoke-test step in the deploy workflow does, and so
should any manual verification. Use `/api/health` for the platform probe and `/api/ready`
to answer "can this environment safely serve traffic?".

Neither endpoint exposes a secret, a stack trace, a hostname, or a connection string. The
readiness body is `{"status":"degraded","checks":{"database":"down","redis":"up"}}` — the
fact of a dependency being down, and nothing about how to reach it.

---

## 10. Configuring custom domains

Per public service: **Settings → Networking → Custom Domain** → enter the hostname →
Railway shows a `CNAME` target like `<something>.up.railway.app`. Record it; you will
create the DNS record in Cloudflare.

| Environment | Service         | Hostname                               |
| ----------- | --------------- | -------------------------------------- |
| QA          | `customer-web`  | `qa.eticketsgo.com`                    |
|             | `api`           | `api-qa.eticketsgo.com`                |
|             | `organizer-web` | `organizer-qa.eticketsgo.com`          |
|             | `admin-web`     | `admin-qa.eticketsgo.com`              |
| UAT         | `customer-web`  | `uat.eticketsgo.com`                   |
|             | `api`           | `api-uat.eticketsgo.com`               |
|             | `organizer-web` | `organizer-uat.eticketsgo.com`         |
|             | `admin-web`     | `admin-uat.eticketsgo.com`             |
| Production  | `customer-web`  | `eticketsgo.com`, `www.eticketsgo.com` |
|             | `api`           | `api.eticketsgo.com`                   |
|             | `organizer-web` | `organizer.eticketsgo.com`             |
|             | `admin-web`     | `admin.eticketsgo.com`                 |

This extends the brief's three-hostname pattern with a fourth: this repository has **three**
web applications (customer, organizer, admin), not two, so `organizer-*` is a real service
that needs its own hostname.

**The `worker` service gets no domain.** It is internal-only. Attaching one would expose
`/metrics` publicly.

No hostname is hard-coded in source. They are supplied through `CORS_ORIGINS`,
`NEXT_PUBLIC_API_URL`, `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL`,
`STRIPE_CONNECT_RETURN_URL` / `STRIPE_CONNECT_REFRESH_URL`, and `RAZORPAY_CALLBACK_URL`.

DNS records, SSL mode, proxy settings and cache rules: [Cloudflare & DNS](./CLOUDFLARE_DNS.md).

---

## 11. Configuring deployment branches

For **every service in every project**: **Settings → Source → Automatic Deploys → OFF**.

This is deliberate and important. If Railway auto-deploys on push, code reaches an
environment **without passing CI** — no lint, no type-check, no tests, no migration
validation, no e2e. The GitHub Actions workflow runs that gate and only then calls
`railway up`. Leaving Railway's own trigger on means both fire, and the un-gated one
usually wins the race.

Set **Settings → Source → Branch** to the branch that feeds that project, so a manual
"Deploy" click in the dashboard does the right thing:

| Project                 | Branch      |
| ----------------------- | ----------- |
| `ETicketsGo-QA`         | `develop`   |
| `ETicketsGo-UAT`        | `release/*` |
| `ETicketsGo-Production` | `main`      |

---

## 12. Adding Railway tokens to GitHub

Create one **project token per project** — not an account token. A project token is scoped
to a single project and cannot reach the other two.

1. Railway → project → **Settings → Tokens** → **New Token**.
2. Name it `github-actions-<env>`, copy the value (shown once).
3. Repeat for all three projects.

Add each to the **matching GitHub Environment**, not to repository-wide secrets:

GitHub → repo → **Settings → Environments** → `<environment>` → **Environment secrets**:

| GitHub Environment | Secret name                | Value                               |
| ------------------ | -------------------------- | ----------------------------------- |
| `qa`               | `RAILWAY_TOKEN_QA`         | ETicketsGo-QA project token         |
| `uat`              | `RAILWAY_TOKEN_UAT`        | ETicketsGo-UAT project token        |
| `production`       | `RAILWAY_TOKEN_PRODUCTION` | ETicketsGo-Production project token |

Environment-scoped is the point: a workflow run that has not been approved cannot read the
production token at all.

**Never commit a token.** The `secret-scan` job (TruffleHog) runs on every PR, and
`npm run verify:deploy` fails if a credential pattern appears in an environment template.

---

## 13. Configuring GitHub Environments

GitHub → repo → **Settings → Environments** → **New environment**, three times: `qa`,
`uat`, `production`.

> **Environment protection rules are NOT available on this repository's plan.** This was
> verified against the live repository, not assumed:
>
> ```
> PUT /repos/ETicketsGo/etickets/environments/production  {"wait_timer": 1}
> → 422 "Please ensure the billing plan supports the wait timer protection rule."
> ```
>
> Required reviewers, wait timers and deployment-branch policies are all part of that same
> paid feature set for private repositories. The `production` environment already existed
> (auto-created by an earlier workflow run) with `protection_rules: []` and no branch
> policy — so `environment: production` paused for nobody, and the only thing preventing a
> merge to `main` from deploying was an unset `RAILWAY_TOKEN_PRODUCTION`. A missing secret
> is not an approval gate.
>
> **The gate therefore lives in the workflow instead** (`deploy-railway.yml`), as two
> independent fail-closed locks that work on any plan:
>
> 1. `main` is **not** a push trigger. Reaching production requires a human to dispatch the
>    workflow with `environment=production` — that deliberate act is the approval.
> 2. The repository variable `DEPLOY_ENABLED_PRODUCTION` must be `true`. Otherwise the run
>    stops before the CI gate with an explanatory summary.
>
> If the plan is upgraded later, add required reviewers as a third lock — but do not remove
> the two above in favour of it.

Environment **secrets and variables** work on every plan, so the environments are still
worth creating: they scope `RAILWAY_TOKEN_<ENV>` so a QA run cannot read the production
token.

For `qa` and `uat`: no reviewers are needed by design — they deploy automatically from
`develop` and `release/**`.

### Environment variables (Settings → Environments → `<env>` → Variables)

| Variable                        | qa                              | uat                              | production                   |
| ------------------------------- | ------------------------------- | -------------------------------- | ---------------------------- |
| `RAILWAY_SERVICE_API`           | `api`                           | `api`                            | `api`                        |
| `RAILWAY_SERVICE_WORKER`        | `worker`                        | `worker`                         | `worker`                     |
| `RAILWAY_SERVICE_CUSTOMER_WEB`  | `customer-web`                  | `customer-web`                   | `customer-web`               |
| `RAILWAY_SERVICE_ORGANIZER_WEB` | `organizer-web`                 | `organizer-web`                  | `organizer-web`              |
| `RAILWAY_SERVICE_ADMIN_WEB`     | `admin-web`                     | `admin-web`                      | `admin-web`                  |
| `DEPLOY_BASE_URL`               | `https://api-qa.eticketsgo.com` | `https://api-uat.eticketsgo.com` | `https://api.eticketsgo.com` |

### Branch protection — unavailable on this plan

Classic branch protection and rulesets are both paid features for private repositories, and
this repository is refused both:

```
GET /repos/ETicketsGo/etickets/branches/main/protection
GET /repos/ETicketsGo/etickets/rulesets
→ 403 "Upgrade to GitHub Pro or make this repository public to enable this feature."
```

So `main` and `develop` currently accept direct pushes, CI cannot be _required_ before
merge, and force-push and deletion cannot be blocked. Deployment safety does not rest on
this — the workflow-level locks in §13 work on any plan — but **code review and green CI
before merge are unenforced conventions here, not guarantees**. Treat that as a known gap:
either upgrade the plan, or write the convention down and hold to it.

Intended configuration once available: protect `main` and `develop`, require the
`CI / verify` status check and a PR, block force pushes and deletions.

---

## 14. Deploying QA

```bash
git checkout -b develop origin/main   # first time only
git push -u origin develop
```

The push triggers **Deploy (Railway)**, which:

1. resolves `develop` → `qa`;
2. runs the full CI gate (lint, type-check, deploy-config check, migration drift, unit
   tests, build, Playwright e2e);
3. deploys `api` first — its `preDeployCommand` runs `npx prisma migrate deploy` **once**,
   before any replica takes traffic, and a non-zero exit **fails the deployment** with the
   previous version still serving;
4. deploys `worker`, then the three web services;
5. smoke-tests `/api/health`, `/api/ready` and `/api/metrics` against `DEPLOY_BASE_URL`.

**First deploy only** — seed reference data. There is no automatic seeding; `prisma
migrate deploy` applies schema, not rows:

```bash
railway link                                    # select ETicketsGo-QA
railway run --service api npm run db:seed       # QA/UAT only
```

Never run `db:seed` against production. Verify with the
[Go-Live Checklist](./RAILWAY_GO_LIVE_CHECKLIST.md).

---

## 15. Promoting to UAT

Cut a release branch from the **exact commit** that passed QA validation:

```bash
git checkout develop
git pull
git checkout -b release/v1.0.0
git push -u origin release/v1.0.0
```

That push deploys to UAT. Tag the release candidate so the artifact is identifiable:

```bash
git tag -a v1.0.0-rc.1 -m "UAT candidate"
git push origin v1.0.0-rc.1
```

**What is promoted, precisely.** The `api` and `worker` images are environment-neutral:
identical bytes are valid in QA, UAT and Production, and all behavioural difference comes
from `APP_ENV` and the service variables. The three **web** images are not — Next.js inlines
`NEXT_PUBLIC_API_URL` into the bundle at build time, so each environment builds its own web
image. That is a rebuild of the _same source commit_ with a different public API URL, not
different code. Nothing else varies between environments at build time.

Fixes during UAT go **onto the release branch** and are cherry-picked back to `develop`.
Never merge `develop` into a release branch mid-validation — that promotes code UAT has not
seen.

---

## 16. Approving and deploying Production

```bash
git checkout main
git pull
git merge --no-ff release/v1.0.0
git push origin main
git tag -a v1.0.0 -m "Production release"
git push origin v1.0.0
```

Pushing `main` runs CI but **deploys nothing** — production is not a push trigger (§13).
Shipping is a separate, deliberate human action:

1. Confirm `DEPLOY_ENABLED_PRODUCTION` is `true` (one-time, after the Railway project,
   variables and project token all exist):
   ```bash
   gh variable set DEPLOY_ENABLED_PRODUCTION --body true
   ```
2. Actions → **Deploy (Railway)** → **Run workflow** → branch `main`, environment
   `production` → **Run**. Dispatching it is the approval.
3. Watch the run: CI gate → api + migration → API readiness gate → worker → worker gate →
   web tier → smoke.

**Before dispatching, confirm:**

- [ ] The same code passed UAT (`git log --oneline main ^release/v1.0.0` is empty)
- [ ] The go-live checklist is complete for this release
- [ ] Any new migration is additive and reversible-by-deploy (§18)
- [ ] A recent PostgreSQL backup exists ([Backup & Recovery](./RAILWAY_BACKUP_RECOVERY.md))
- [ ] You are not deploying into a peak sales window
- [ ] Someone is available to roll back

After approval the same ordered deploy runs, followed by the smoke test.

---

## 17. Rolling back an application deployment

Railway keeps previous deployments and can restore one in seconds.

1. Railway → project → the service → **Deployments**.
2. Find the last known-good deployment → **⋯** → **Redeploy**.
3. Roll back in **reverse dependency order**: web tier first, then `worker`, then `api`.
   The web tier is what customers see, and it has no schema coupling.
4. Verify: `curl -fsS https://api.eticketsgo.com/api/ready`.

Or from the CLI:

```bash
railway link                      # select the project
railway redeploy --service api
```

**What a rollback does not do:** it does not revert the database. Migrations already
applied stay applied. This is safe _because_ migrations here are additive — the previous
image tolerates additional columns and tables it does not know about. If a release ever
ships a destructive migration, that property is lost and rollback becomes a restore
instead. See §18.

**Rollback limits.**

| Change                                          | Rollback                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Application code                                | ✅ redeploy the previous deployment                                                          |
| Environment variable                            | ✅ edit and redeploy                                                                         |
| Additive migration (new table/column/index)     | ✅ leave applied; old code ignores it                                                        |
| Destructive migration (drop/rename/narrow type) | ❌ **not reversible by redeploy** — needs a restore, with data loss back to the backup point |
| Data written by the new version                 | ❌ not reverted                                                                              |

---

## 18. Handling a failed database migration

**A failed migration fails the deployment.** `prisma migrate deploy` runs as the
`preDeployCommand`; a non-zero exit aborts the deploy and the **previous version keeps
serving traffic**. That is the designed behaviour — the environment is not down, it is
un-upgraded.

Prisma applies each migration in a transaction where the database supports it, so a failed
migration is usually rolled back cleanly. It can still be recorded as `failed` in
`_prisma_migrations`, which blocks all subsequent migrations until resolved.

**Do not** run `prisma migrate reset` or `prisma db push`. `reset` **drops the database**;
`db push` bypasses migration history and causes permanent drift. Neither appears in any
deploy path here, and `npm run verify:deploy` fails the build if one is introduced.

### Procedure

1. **Read the failure.** Railway → `api` service → **Deployments** → the failed deployment
   → **Deploy Logs**. The pre-deploy output names the migration and the SQL error.

2. **Confirm the environment is still healthy.** The old version should still be serving:

   ```bash
   curl -fsS https://api.eticketsgo.com/api/ready
   ```

3. **Inspect migration state.**

   ```bash
   railway run --service api npx prisma migrate status
   ```

4. **If the migration failed but rolled back cleanly** (state: failed, schema unchanged) —
   fix the migration SQL in a new commit, mark the failed one rolled back, and redeploy:

   ```bash
   railway run --service api npx prisma migrate resolve --rolled-back <migration_name>
   ```

5. **If the migration partially applied** (state: failed, schema partly changed) — this is
   the serious case. Decide between:
   - **Finish it forward:** apply the remaining statements by hand in a psql session, then
     `prisma migrate resolve --applied <migration_name>`. Preferred when the remainder is
     small and well understood.
   - **Restore:** if the partial state is not safely completable, restore from the most
     recent backup ([Backup & Recovery](./RAILWAY_BACKUP_RECOVERY.md)) and accept the data
     loss back to that point. Communicate before you start.

6. **Record it.** A partially-applied migration is an incident, not a hiccup. File it and
   add the failure mode to the migration review checklist.

**Prevention.** The `migration-drift` job in `security.yml` fails any PR whose
`schema.prisma` is not fully captured by `prisma/migrations`, so a schema change can never
reach an environment without a migration. Every migration is applied in CI against a real
PostgreSQL 16 before it can merge, and it is applied in QA and UAT before production ever
sees it.

---

## 19. Rotating secrets

Rotate on a schedule, on staff departure, and immediately on any suspected exposure.
Existing guidance: [Credential Rotation Runbook](../guides/CREDENTIAL-ROTATION-RUNBOOK.md).

**General procedure** — Railway → service → **Variables** → edit → the service redeploys
automatically. Set the value on **both `api` and `worker`** where both consume it.

| Secret                       | Blast radius                                    | Notes                                                                                     |
| ---------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`          | Access tokens invalid; clients silently refresh | Low impact. Rotate freely.                                                                |
| `JWT_REFRESH_SECRET`         | **All users logged out**                        | Announce. Prefer a low-traffic window.                                                    |
| `QR_SIGNING_SECRET`          | **Every issued ticket QR stops validating**     | Highest impact on this platform. Only with a plan to re-issue, and never during an event. |
| `PAYMENT_WEBHOOK_SECRET`     | Generic webhook verification                    | Update the provider dashboard in the same window.                                         |
| `STRIPE_WEBHOOK_SECRET`      | Stripe webhooks rejected until aligned          | Roll the endpoint secret in Stripe, then Railway. Brief rejection window; Stripe retries. |
| `STRIPE_SECRET_KEY`          | Charges fail until updated                      | Create the new key in Stripe **before** revoking the old one.                             |
| `RAZORPAY_KEY_SECRET`        | Same as Stripe                                  | Must stay distinct from `RAZORPAY_WEBHOOK_SECRET` — boot fails otherwise.                 |
| `DATABASE_URL` / `REDIS_URL` | Handled by Railway                              | Because you used variable references (§7), rotation propagates automatically.             |
| Railway project token        | CI cannot deploy                                | Revoke in Railway, mint a new one, update the GitHub Environment secret.                  |

**Rotate each environment independently.** Sharing a value across environments defeats the
isolation the rest of this document builds.

---

## 20. Restoring the production database

Full procedure, RPO/RTO, and the restore-test schedule:
[Backup & Recovery](./RAILWAY_BACKUP_RECOVERY.md). Summary:

1. **Declare an incident** and enable maintenance mode so writes stop:
   `POST /api/admin/ops/maintenance {"enabled":true,"message":"..."}` as an admin. The flag
   is per-environment (`etg:production:ops:maintenance`) and cannot affect QA or UAT.
2. **Take a snapshot of the current broken state first.** You may need it to reconstruct
   data written after the backup point.
3. **Restore** — Railway → `Postgres` → **Backups** → select → **Restore**, or restore a
   `pg_dump` artifact with `scripts/restore-db.sh`.
4. **Verify** — row counts on `Booking`, `Ticket`, `Payment`; `prisma migrate status` shows
   all migrations applied; `/api/ready` returns 200.
5. **Reconcile payments.** Payments captured after the backup point exist at the provider
   but not in the restored database. Use the finance reconciliation report
   (`/admin/payments/reconciliation`) to identify and repair them **before** reopening.
6. **Disable maintenance mode**, then monitor error rates and booking success closely.

**Never restore a production backup into QA or UAT without anonymising it first.** It
contains real customer PII, and QA/UAT have weaker access controls by design.

---

## Appendix A — Deployment blockers found and fixed in this repository

The audit behind this runbook found five issues that would have broken or endangered a
Railway deployment. All are fixed on this branch; they are listed so the reasoning is
reviewable.

| #   | Problem                                                                                                        | Consequence                                                                                                                                                                                                                               | Fix                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | BullMQ parsed only `host`/`port` out of `REDIS_URL`, discarding username, password, database index and TLS     | **Every queue fails with `NOAUTH`** against any managed Redis, including Railway's. Hold expiry, notifications, webhook processing and outbox dispatch all stop; the API's own Redis client connects fine, so it looks like a worker bug. | `bullConnectionFromUrl()` in `apps/api/src/common/redis-namespace.ts`, used by all three call sites |
| 2   | Neither app read Railway's injected `PORT`                                                                     | Health checks never pass; the deployment never goes live                                                                                                                                                                                  | `PORT` honoured ahead of `API_PORT`/`WORKER_PORT`; API binds `0.0.0.0` explicitly                   |
| 3   | Root `railway.json` start command was `node apps/api/dist/main.js`, but the image `WORKDIR` is `/app/apps/api` | Resolves to `/app/apps/api/apps/api/dist/main.js` — **the API cannot start**                                                                                                                                                              | Corrected to `node dist/main.js`                                                                    |
| 4   | Migrations ran inside `startCommand` with `numReplicas: 2`                                                     | Every replica races to migrate on every restart                                                                                                                                                                                           | Moved to `preDeployCommand` (runs once, pre-traffic, fails the deploy on error)                     |
| 5   | Maintenance flag stored at a global `etg:maintenance` key                                                      | Two environments on one Redis share it — **QA could take production offline**                                                                                                                                                             | Namespaced to `etg:<env>:ops:maintenance`                                                           |

## Appendix B — Known constraints

- **Object storage is not implemented.** `STORAGE_DRIVER` is declared in the config schema
  but no upload or object-storage code path exists in this codebase. Railway's filesystem
  is ephemeral (wiped every deploy), so any future feature that writes files must ship an
  object-storage driver first. Nothing durable is being written today.
- **Web images are environment-specific by construction** (`NEXT_PUBLIC_API_URL` is inlined
  at build time). Same source commit, different public API URL. See §15.
- **No IPL-scale claim.** This setup has not been load-tested on Railway. Sizing in
  [Cost & Sizing](./RAILWAY_COST_SIZING.md) is a starting point derived from the
  application's structure, not from measured Railway throughput. Load-test on the real
  infrastructure before any high-demand on-sale.
