# ETicketsGo — QA First Deployment (ETicketsGo-QA)

> **QA only.** Do not create the UAT or Production projects until QA has passed the
> [smoke test](../../scripts/deploy/qa-smoke-test.sh) and the
> [failure drills](./QA_FAILURE_DRILLS.md). Everything below is grounded in this
> repository's real service names, Dockerfiles, commands, endpoints, and variables.
>
> **Nothing here has been executed.** No Railway project, service, plugin, domain, token,
> or DNS record exists. Every step is written for the repository owner to perform with
> their own authenticated access. Placeholders are `<LIKE_THIS>`.
>
> Pre-deployment evidence: [QA_PREFLIGHT_VALIDATION.md](./QA_PREFLIGHT_VALIDATION.md).
> Full reference: [RAILWAY_DEPLOYMENT_RUNBOOK.md](./RAILWAY_DEPLOYMENT_RUNBOOK.md).

---

## Order of operations

Do these in order. Steps 1–4 are GitHub-side and can be done before any Railway resource
exists; the first deployment cannot succeed until step 9.

```
1. push branch → 2. PR + CI green → 3. merge to main → 4. create develop
5. Railway project + plugins → 6. services + config paths → 7. variables
8. GitHub Environment + token → 9. first deploy → 10. domains → 11. smoke test
```

---

## Part A — GitHub

### 1. Push the branch

```bash
git checkout chore/railway-multi-env-deployment
git push -u origin chore/railway-multi-env-deployment
```

### 2. Open the PR and wait for CI

```bash
gh pr create --base main --head chore/railway-multi-env-deployment \
  --title "Railway multi-environment deployment (QA/UAT/Production)" \
  --body "See docs/deployment/. Runtime fixes + Railway configs + CD pipeline + docs."
gh pr checks --watch
```

Required to be green before merging:

| Check                                              | Workflow       | What it proves                                                                                                                                               |
| -------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CI / verify`                                      | `ci.yml`       | prettier, lint, typecheck, no circular deps, **deployment-config gate**, migrations apply + seed, 164 suites / 1217 unit tests, all 8 builds, Playwright e2e |
| `Security & Supply Chain / Dependency audit`       | `security.yml` | production advisories (informational)                                                                                                                        |
| `Security & Supply Chain / Secret scan`            | `security.yml` | TruffleHog, verified secrets only                                                                                                                            |
| `Security & Supply Chain / Prisma migration drift` | `security.yml` | `schema.prisma` fully captured by `prisma/migrations`                                                                                                        |

> `Dependency review` soft-fails without GitHub Advanced Security. That is expected on a
> private repo and is not a blocker — `npm audit` is the functional dependency gate.

### 3. Merge

```bash
gh pr merge --merge   # a merge commit, NOT a squash — preserves the four focused commits
```

### 4. Create `develop` — the branch that deploys to QA

```bash
git checkout main && git pull
git checkout -b develop
git push -u origin develop
```

### 5. Branch protection

GitHub → **Settings → Branches → Add rule**, twice:

| Branch    | Require PR       | Required status check | Force push | Deletions |
| --------- | ---------------- | --------------------- | ---------- | --------- |
| `main`    | yes (1 approval) | `CI / verify`         | blocked    | blocked   |
| `develop` | yes              | `CI / verify`         | blocked    | blocked   |

This is what stops unreviewed code reaching the production approval gate. Note the repo
currently has **no** branch protection — until this is set, `main` accepts direct pushes.

---

## Part B — Railway project

### 6. Create the project

Railway → **New Project** → **Empty Project** → rename to exactly `ETicketsGo-QA`.

Keep the single default environment. One Railway environment per Railway project keeps
project-token scoping unambiguous.

### 7. Add the datastores

**New → Database → Add PostgreSQL** → rename the service to exactly `Postgres`.
**New → Database → Add Redis** → rename the service to exactly `Redis`.

The names matter: the variable references in step 9 resolve by service name.

Do not create a schema by hand. `prisma migrate deploy` applies all 39 migrations as the
API's pre-deploy step.

### 8. Create the five application services

For each: **New → GitHub Repo** → this repository → then set three things.

| #   | Service name    | Config-as-code path                         | Root Directory  | Public domain |
| --- | --------------- | ------------------------------------------- | --------------- | ------------- |
| 1   | `api`           | `deploy/railway/api.railway.json`           | **empty (`/`)** | yes           |
| 2   | `worker`        | `deploy/railway/worker.railway.json`        | **empty (`/`)** | **NO**        |
| 3   | `customer-web`  | `deploy/railway/customer-web.railway.json`  | **empty (`/`)** | yes           |
| 4   | `organizer-web` | `deploy/railway/organizer-web.railway.json` | **empty (`/`)** | yes           |
| 5   | `admin-web`     | `deploy/railway/admin-web.railway.json`     | **empty (`/`)** | yes           |

> **Setting the config-as-code path is a BLOCKER, not a nicety.** A service with no path
> set falls back to the root `railway.json`, which describes the **API** — including
> `preDeployCommand: npx prisma migrate deploy`. Leave it unset on `worker` and you have
> created a _second migration executor_ and pointed the worker at the API's Dockerfile.
> After creating each service, confirm **Settings → Config-as-code** shows the path above.

> **Root Directory must stay empty.** Every Dockerfile builds from the repository root and
> `COPY`s each workspace manifest (`packages/*/package.json`, `apps/*/package.json`) before
> a single `npm ci`. Setting `apps/api` makes Docker's context that subdirectory and every
> one of those `COPY` lines fails with "file not found".

### Per-service specification

Values below come from the committed config files — you do not type them into the UI, but
this is what each service will run, and what to confirm under **Settings → Deploy**.

|                | `api`                                          | `worker`                                          | `customer-web`                      | `organizer-web`                     | `admin-web`                     |
| -------------- | ---------------------------------------------- | ------------------------------------------------- | ----------------------------------- | ----------------------------------- | ------------------------------- |
| Build          | Dockerfile                                     | Dockerfile                                        | Dockerfile                          | Dockerfile                          | Dockerfile                      |
| Dockerfile     | `apps/api/Dockerfile`                          | `apps/worker/Dockerfile`                          | `apps/customer-web/Dockerfile`      | `apps/organizer-web/Dockerfile`     | `apps/admin-web/Dockerfile`     |
| Image WORKDIR  | `/app/apps/api`                                | `/app/apps/worker`                                | `/app`                              | `/app`                              | `/app`                          |
| Pre-deploy     | `npx prisma migrate deploy`                    | **none**                                          | **none**                            | **none**                            | **none**                        |
| Start          | `node dist/main.js`                            | `node dist/main.js`                               | `node apps/customer-web/server.js`  | `node apps/organizer-web/server.js` | `node apps/admin-web/server.js` |
| Health path    | `/api/health`                                  | `/health`                                         | `/api/health`                       | `/api/health`                       | `/api/health`                   |
| Health timeout | 60s                                            | 60s                                               | 60s                                 | 60s                                 | 60s                             |
| Port           | Railway `PORT` (falls back to `API_PORT` 4000) | Railway `PORT` (falls back to `WORKER_PORT` 4100) | Railway `PORT` (image default 3000) | Railway `PORT` (3001)               | Railway `PORT` (3002)           |
| Binds          | `0.0.0.0`                                      | `0.0.0.0`                                         | `0.0.0.0`                           | `0.0.0.0`                           | `0.0.0.0`                       |
| Restart        | ON_FAILURE ×5                                  | ON_FAILURE ×10                                    | ON_FAILURE ×5                       | ON_FAILURE ×5                       | ON_FAILURE ×5                   |
| Replicas       | **1**                                          | **1**                                             | **1**                               | **1**                               | **1**                           |
| Needs Postgres | yes                                            | yes                                               | no                                  | no                                  | no                              |
| Needs Redis    | yes                                            | yes                                               | no                                  | no                                  | no                              |
| Deploy order   | 1st                                            | 2nd                                               | 3rd                                 | 3rd                                 | 3rd                             |

**Do not set `PORT` yourself** — Railway injects it. `API_PORT`/`WORKER_PORT` exist only as
the non-Railway fallback and should stay unset here.

**Internal service URLs.** Services reach the datastores over Railway's private network
(`postgres.railway.internal`, `redis.railway.internal`), resolved through the variable
references in step 9 — never typed. The web tier does **not** talk to the API internally;
browsers call it over the public HTTPS hostname, which is why `NEXT_PUBLIC_API_URL` is a
public URL.

### Watch paths (recommended)

**Settings → Build → Watch Paths**, so one change does not rebuild all five:

| Service         | Watch paths                                                            |
| --------------- | ---------------------------------------------------------------------- |
| `api`           | `apps/api/**`, `packages/**`, `package-lock.json`, `deploy/railway/**` |
| `worker`        | `apps/worker/**`, `apps/api/**`, `packages/**`, `package-lock.json`    |
| `customer-web`  | `apps/customer-web/**`, `packages/**`, `package-lock.json`             |
| `organizer-web` | `apps/organizer-web/**`, `packages/**`, `package-lock.json`            |
| `admin-web`     | `apps/admin-web/**`, `packages/**`, `package-lock.json`                |

`worker` watches `apps/api/**` because it imports `@eticketsgo/api` at runtime.

### 9. Turn OFF Railway auto-deploy — on every service

**Settings → Source → Automatic Deploys → OFF**, then set **Branch** to `develop`.

Only one controller may deploy a service. GitHub Actions is that controller, because it
runs the verification gate first. If Railway's own trigger stays on, both fire on every
push, the un-gated one usually wins the race, and code reaches QA without passing CI.

---

## Part C — QA variables

Source of truth: `deploy/railway/env/qa.env.example`. Railway has no `.env` for deployed
services — each line is entered as a service variable (the **Raw Editor** accepts pasted
`KEY=value` blocks).

### Generated secrets — run these locally, four times, values unique to QA

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET      (must differ from the access secret)
openssl rand -base64 48   # QR_SIGNING_SECRET
openssl rand -base64 48   # PAYMENT_WEBHOOK_SECRET
```

Never reuse a QA value in UAT or Production: a QA-signed JWT or ticket QR must not validate
elsewhere. The API refuses to boot on a placeholder or a secret under 24 characters.

| Variable                 | Services    | Notes                                               |
| ------------------------ | ----------- | --------------------------------------------------- |
| `JWT_ACCESS_SECRET`      | api         | generated                                           |
| `JWT_REFRESH_SECRET`     | api         | generated, distinct from the above                  |
| `QR_SIGNING_SECRET`      | api, worker | generated; same value on both services              |
| `PAYMENT_WEBHOOK_SECRET` | api         | generated; must differ from `STRIPE_WEBHOOK_SECRET` |

### Railway-provided references — use the reference, never a pasted URL

| Variable       | Value                        | Services    |
| -------------- | ---------------------------- | ----------- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | api, worker |
| `REDIS_URL`    | `${{Redis.REDIS_URL}}`       | api, worker |

Prefer the `*_PRIVATE_URL` variant if the plugin exposes one — private traffic is not
billed as egress and keeps the datastore off the public internet. A pasted URL is how a
service ends up silently pointed at another environment.

### Safe QA values

| Variable                   | Value        | Services                                     |
| -------------------------- | ------------ | -------------------------------------------- |
| `APP_ENV`                  | `QA`         | api, worker                                  |
| `NODE_ENV`                 | `production` | api, worker                                  |
| `API_GLOBAL_PREFIX`        | `api`        | api                                          |
| `TRUST_PROXY_HOPS`         | `1`          | api                                          |
| `ENABLE_SWAGGER`           | `true`       | api — QA only; leave UNSET in UAT/Production |
| `REDIS_COMMAND_TIMEOUT_MS` | `1000`       | api                                          |
| `SLOW_QUERY_MS`            | `500`        | api                                          |

`APP_ENV` is the master switch: it selects the payment environment, drives the fail-closed
credential checks, and namespaces every Redis key this environment writes.

### Stripe test credentials

| Variable                     | Value                                                                         | Notes                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `PAYMENT_PROVIDER_NAME`      | `mock`                                                                        | QA default: deterministic tests. Set `stripe` to exercise the real sandbox. |
| `STRIPE_SECRET_KEY`          | `sk_test_<...>`                                                               | **boot FAILS on an `sk_live_` key in QA**                                   |
| `STRIPE_WEBHOOK_SECRET`      | `whsec_<...>`                                                                 | the QA endpoint's own secret                                                |
| `STRIPE_PUBLISHABLE_KEY`     | `pk_test_<...>`                                                               | public, not a secret                                                        |
| `STRIPE_SUCCESS_URL`         | `https://qa.eticketsgo.com/checkout/success?session_id={CHECKOUT_SESSION_ID}` |                                                                             |
| `STRIPE_CANCEL_URL`          | `https://qa.eticketsgo.com/checkout/cancel`                                   |                                                                             |
| `STRIPE_CONNECT_RETURN_URL`  | `https://organizer-qa.eticketsgo.com/organizer/payouts?onboarding=return`     |                                                                             |
| `STRIPE_CONNECT_REFRESH_URL` | `https://organizer-qa.eticketsgo.com/organizer/payouts?onboarding=refresh`    |                                                                             |

### Razorpay test credentials

| Variable                  | Value                                                  | Notes                                                             |
| ------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| `RAZORPAY_KEY_ID`         | `rzp_test_<...>`                                       | **boot FAILS on an `rzp_live_` key in QA**                        |
| `RAZORPAY_KEY_SECRET`     | `<...>`                                                |                                                                   |
| `RAZORPAY_WEBHOOK_SECRET` | `<...>`                                                | **must differ** from `RAZORPAY_KEY_SECRET` — boot fails otherwise |
| `RAZORPAY_MODE`           | `test`                                                 | must agree with the key prefix — boot fails otherwise             |
| `RAZORPAY_CALLBACK_URL`   | `https://qa.eticketsgo.com/checkout/razorpay/callback` |                                                                   |
| `RAZORPAY_ROUTE_ENABLED`  | `false`                                                | no organizer payouts from QA                                      |

### Payment safety switches

| Variable                            | Value   | Why                                                 |
| ----------------------------------- | ------- | --------------------------------------------------- |
| `PAYMENT_LIVE_ENABLED`              | `false` | no real money in QA                                 |
| `PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV` | `false` | the only route by which a live key could boot in QA |

### Webhook endpoints to register in the provider dashboards

| Provider | QA endpoint                                                   |
| -------- | ------------------------------------------------------------- |
| Stripe   | `https://api-qa.eticketsgo.com/api/payments/webhook/stripe`   |
| Razorpay | `https://api-qa.eticketsgo.com/api/payments/webhook/razorpay` |

Separate endpoints with separate signing secrets per environment — a shared secret would
let a QA replay authenticate against production.

### Email

| Variable           | QA value                    | Notes                                                       |
| ------------------ | --------------------------- | ----------------------------------------------------------- |
| `EMAIL_PROVIDER`   | `log`                       | writes to stdout instead of sending — the right QA default  |
| `EMAIL_FROM`       | `qa-noreply@eticketsgo.com` | only if a real provider is selected                         |
| `SENDGRID_API_KEY` | `<QA-scoped key>`           | only if `EMAIL_PROVIDER=sendgrid`; never the production key |

### Object storage

| Variable         | Value   | Notes                                                                                                                                                                                                            |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_DRIVER` | `local` | **The S3 driver is declared but NOT implemented** — no upload or object-storage code path exists in this codebase. Railway's filesystem is ephemeral. Nothing durable is written; there is nothing to configure. |

### Push / Expo

| Variable                                                  | QA value | Notes                                                                                                                                   |
| --------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PUSH_PROVIDER`                                           | `log`    |                                                                                                                                         |
| `WEBPUSH_PROVIDER`                                        | `log`    |                                                                                                                                         |
| `SMS_PROVIDER`                                            | `log`    |                                                                                                                                         |
| `WHATSAPP_PROVIDER`                                       | `log`    |                                                                                                                                         |
| `FCM_PROJECT_ID` / `FCM_CLIENT_EMAIL` / `FCM_PRIVATE_KEY` | —        | only if `PUSH_PROVIDER=fcm`; must be a **separate Firebase project** from Production so a QA push cannot reach a real customer's device |

> The Expo mobile app (`apps/customer-mobile`) is a separate track and is **not** part of
> this Railway deployment. It consumes the QA API over HTTPS; no Railway service is
> required for it.

### Sentry

| Variable                    | QA value       | Notes                                                                        |
| --------------------------- | -------------- | ---------------------------------------------------------------------------- |
| `SENTRY_DSN`                | `<QA DSN>`     | optional; unset ⇒ Sentry never initialises                                   |
| `SENTRY_ENVIRONMENT`        | `qa`           | separates the issue stream                                                   |
| `SENTRY_TRACES_SAMPLE_RATE` | `0`            | error tracking only                                                          |
| `SENTRY_RELEASE`            | _(do not set)_ | falls back to `RAILWAY_GIT_COMMIT_SHA`, which Railway injects per deployment |

### Deployment SHA and release metadata

Railway injects these automatically — do not create them:
`RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_GIT_BRANCH`, `RAILWAY_GIT_AUTHOR`,
`RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_SERVICE_NAME`, `PORT`.

`RAILWAY_GIT_COMMIT_SHA` is what makes every Sentry issue attributable to a deploy.

### Feature flags — the P6 safety posture, do not weaken

| Variable                                   | Value         |
| ------------------------------------------ | ------------- |
| `BOOKING_ORCHESTRATOR_MODE`                | `shadow`      |
| `BOOKING_REFUND_POLICY_MODE`               | `MANUAL_ONLY` |
| `BOOKING_COMPENSATION_AUTO_REFUND_ENABLED` | `false`       |
| `BOOKING_COMPENSATION_AUTO_VOID_ENABLED`   | `false`       |
| `BOOKING_COMPENSATION_EXECUTION_ENABLED`   | `false`       |
| `INVENTORY_LOCKS_ENABLED`                  | `false`       |
| `DOMAIN_EVENTS_ENABLED`                    | `false`       |
| `DOMAIN_EVENT_DELIVERY_MODE`               | `in_process`  |

### URLs and CORS

| Variable              | Value                                                                                           | Services                   |
| --------------------- | ----------------------------------------------------------------------------------------------- | -------------------------- |
| `CORS_ORIGINS`        | `https://qa.eticketsgo.com,https://organizer-qa.eticketsgo.com,https://admin-qa.eticketsgo.com` | api                        |
| `NEXT_PUBLIC_API_URL` | `https://api-qa.eticketsgo.com/api`                                                             | **all three web services** |

> `NEXT_PUBLIC_API_URL` is a **BUILD-TIME** value. The Dockerfiles declare it as `ARG` and
> Next.js inlines it into the JavaScript bundle; Railway passes service variables as Docker
> build args. It must be set **before the first build**, and changing it requires a
> **rebuild**, not a restart. (Verified locally: the string appears in both the server
> chunk and the client `static/chunks` bundle.)

### Queue namespaces

Nothing to set. They are derived in code from `APP_ENV` and are not configurable:

| Concern                                        | QA keyspace              |
| ---------------------------------------------- | ------------------------ |
| BullMQ queues                                  | `etg:qa:bull:*`          |
| Read-through cache                             | `etg:qa:cache:*`         |
| Seat/quantity locks, fencing, lock idempotency | `etg:qa:invlock:*`       |
| Maintenance flag                               | `etg:qa:ops:maintenance` |

Get `APP_ENV` right and the namespacing follows; get it wrong and everything else is wrong
with it.

---

## Part D — GitHub Environment and token

### 10. Create the Railway project token

Railway → `ETicketsGo-QA` → **Settings → Tokens → New Token** → name it
`github-actions-qa` → copy it (shown once).

Use a **project** token, not an account token: a project token cannot reach the UAT or
Production projects, which is what makes the isolation structural rather than procedural.

### 11. Create the `qa` GitHub Environment

GitHub → **Settings → Environments → New environment** → `qa`.

- **Required reviewers:** none. QA deploys automatically; only Production has the gate.
- **Deployment branches → Selected branches** → `develop`.

**Environment secrets:**

| Name               | Value                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| `RAILWAY_TOKEN_QA` | the project token from step 10                                        |
| `OPS_HEALTH_TOKEN` | _(optional)_ an admin bearer token; enables the worker-readiness gate |

**Environment variables:**

| Name                            | Value                           |
| ------------------------------- | ------------------------------- |
| `RAILWAY_SERVICE_API`           | `api`                           |
| `RAILWAY_SERVICE_WORKER`        | `worker`                        |
| `RAILWAY_SERVICE_CUSTOMER_WEB`  | `customer-web`                  |
| `RAILWAY_SERVICE_ORGANIZER_WEB` | `organizer-web`                 |
| `RAILWAY_SERVICE_ADMIN_WEB`     | `admin-web`                     |
| `DEPLOY_BASE_URL`               | `https://api-qa.eticketsgo.com` |

Store the token on the **environment**, not repo-wide, so only a run bound to `qa` can read
it.

> **Chicken-and-egg:** `DEPLOY_BASE_URL` is used by the readiness gate, but the custom
> domain does not exist until Part F. For the _first_ deploy, set it to the
> `*.up.railway.app` hostname Railway assigns the `api` service, then switch it to
> `https://api-qa.eticketsgo.com` once DNS resolves.

---

## Part E — First QA deployment

### 12. Trigger it

Any push to `develop` deploys to QA. For the first run, trigger it explicitly:

```bash
gh workflow run "Deploy (Railway)" --ref develop -f environment=qa
gh run watch
```

### 13. What the pipeline does, in order

```
resolve      develop → qa
gate         the full CI suite (nothing deploys if it fails)
deploy       api      → preDeployCommand: npx prisma migrate deploy
                        ONE one-off container, before any replica takes traffic;
                        a non-zero exit FAILS the deploy, old version keeps serving
             GATE     → poll https://<api>/api/ready until {"status":"ok"}
                        (readiness, not liveness: it checks PostgreSQL AND Redis)
             worker   → deployed only once the API is genuinely serving
             GATE     → Railway health check + optional ops-queue check
             web ×3   → last, so no browser gets a bundle newer than the API
smoke        /api/health, /api/ready, /api/metrics
```

### 14. Seed QA reference data (first deploy only)

`prisma migrate deploy` applies schema, not rows. There is no automatic seeding.

```bash
railway link                                  # select ETicketsGo-QA
railway run --service api npm run db:seed
```

QA and UAT only. **Never seed production** — it creates known demo credentials.

### 15. Verify

```bash
API_BASE=https://api-qa.eticketsgo.com \
WEB_BASE=https://qa.eticketsgo.com \
ORGANIZER_BASE=https://organizer-qa.eticketsgo.com \
ADMIN_BASE=https://admin-qa.eticketsgo.com \
  ./scripts/deploy/qa-smoke-test.sh
```

Then work through the manual list the script prints, and the
[failure drills](./QA_FAILURE_DRILLS.md).

---

## Part F — QA domains and Cloudflare

Four externally accessible applications — this repository has **three** web apps, so the
organizer hostname is a real fourth entry, not an optional extra.

| Service         | Hostname                                                            |
| --------------- | ------------------------------------------------------------------- |
| `customer-web`  | `qa.eticketsgo.com`                                                 |
| `api`           | `api-qa.eticketsgo.com`                                             |
| `organizer-web` | `organizer-qa.eticketsgo.com`                                       |
| `admin-web`     | `admin-qa.eticketsgo.com`                                           |
| `worker`        | **none** — internal only; a public hostname would expose `/metrics` |

### Order matters

1. **Railway first:** service → **Settings → Networking → Custom Domain** → enter the
   hostname → copy the CNAME target Railway shows.
2. **Cloudflare second:** DNS → Add record → CNAME → **DNS only (grey cloud)** at first.
3. Wait for Railway to report the certificate as issued.
4. **Then** switch the record to Proxied (orange cloud).

Reversing this produces a 522 that is really a certificate-issuance problem.

### DNS records

| Type  | Name           | Target                              | Proxy   |
| ----- | -------------- | ----------------------------------- | ------- |
| CNAME | `qa`           | `<customer-web-qa>.up.railway.app`  | Proxied |
| CNAME | `api-qa`       | `<api-qa>.up.railway.app`           | Proxied |
| CNAME | `organizer-qa` | `<organizer-web-qa>.up.railway.app` | Proxied |
| CNAME | `admin-qa`     | `<admin-web-qa>.up.railway.app`     | Proxied |

### Settings

| Setting             | Value                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------- |
| SSL/TLS mode        | **Full (strict)** — never Flexible, which sends plaintext to the origin                      |
| Always Use HTTPS    | On                                                                                           |
| Minimum TLS Version | 1.2                                                                                          |
| HSTS                | leave **off** for QA; enable only on production once every subdomain is HTTPS-ready          |
| WebSockets          | On (default; nothing uses one today, but leave it so a future live seat-map needs no change) |

### Caching

Create a Cache Rule per hostname:

| Rule                      | Expression                                                                                     | Setting                   |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------- |
| Never cache the QA API    | `http.host eq "api-qa.eticketsgo.com"`                                                         | **Bypass cache**          |
| Never cache QA admin      | `http.host eq "admin-qa.eticketsgo.com"`                                                       | **Bypass cache**          |
| Never cache QA organizer  | `http.host eq "organizer-qa.eticketsgo.com"`                                                   | **Bypass cache**          |
| Never cache QA app routes | `http.host eq "qa.eticketsgo.com" and not starts_with(http.request.uri.path, "/_next/static")` | **Bypass cache**          |
| Cache QA static assets    | `starts_with(http.request.uri.path, "/_next/static")`                                          | Eligible, Edge TTL 1 year |

Never cacheable: bookings, availability, seat locks, checkout, payments, auth, admin,
organizer, webhooks, and the health endpoints (a cached "ok" hides a real outage).

### Webhook exclusions

Payment providers cannot authenticate through Cloudflare Access and will not follow a
challenge. **Security → WAF → Custom rules** → a **Skip** rule above the others:

```
(http.request.uri.path contains "/api/payments/webhook/")
```

Skip: Managed Rules, Rate limiting, Bot Fight Mode. Add the same path as a **bypass** policy
in every Access application covering `api-qa`.

This is not a hole: both handlers verify the provider's signature against a QA-specific
secret before acting. That check, not network filtering, is the control.

### Access protection for QA

QA must not be publicly reachable — it holds test data, exposes Swagger, and is an
indexable duplicate of the product.

Zero Trust → Access → Applications, one per QA hostname:

1. Self-hosted → set the domain.
2. Session duration 24 hours.
3. Policy: Allow → _Emails ending in_ `@<yourcompany>.com`.
4. **Bypass policy** for `/api/payments/webhook/*` so sandbox webhooks still arrive.

### Health-check accessibility

Railway health-checks each service **internally**, so Access does not interfere with it.
But the GitHub Actions readiness gate and `qa-smoke-test.sh` call `/api/ready` from
**outside**. Either:

- add a bypass policy for `/api/health` and `/api/ready` (these expose only up/down —
  no secret, no stack trace, no connection string); or
- run the smoke test from behind Access with a service token.

Add `X-Robots-Tag: noindex` on all QA hostnames (Transform Rules → Modify Response Header)
so a leaked link cannot be indexed.

---

## Definition of done for QA

- [ ] PR merged; `develop` created; branch protection on `main` and `develop`
- [ ] `ETicketsGo-QA` exists with Postgres + Redis + five services
- [ ] Every service has its config-as-code path set and Root Directory empty
- [ ] Railway auto-deploy OFF on all five
- [ ] Variables entered; four QA-unique secrets generated
- [ ] `qa` GitHub Environment with project token and service-name variables
- [ ] First deployment green, including both readiness gates
- [ ] QA seeded
- [ ] Four domains resolve over HTTPS with Full (strict)
- [ ] Cloudflare Access protects all four; webhook paths bypassed
- [ ] `qa-smoke-test.sh` passes
- [ ] Manual smoke list completed
- [ ] [Failure drills](./QA_FAILURE_DRILLS.md) executed against QA
- [ ] **Only then** begin UAT
