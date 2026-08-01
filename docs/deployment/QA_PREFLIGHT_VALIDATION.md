# ETicketsGo — QA Pre-Deployment Validation Record

> Evidence gathered **before** the first QA deployment, on branch
> `chore/railway-multi-env-deployment`. Everything here was executed locally against a
> Railway-shaped stack. **No Railway resource exists and nothing has been deployed** — this
> record exists so the eventual deployment starts from proven ground, not from assumptions.
>
> Reproduce with `deploy/railway/validation/docker-compose.qa-validate.yml`.

Date: 2026-08-01 · Docker Engine 29.3.1 · Node 20 · PostgreSQL 16-alpine · Redis 7-alpine

---

## 1. Why the validation stack is shaped the way it is

The stack in `deploy/railway/validation/` differs from the dev `docker-compose.yml` in ways
that are the whole point:

| Choice                                          | Reason                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Redis requires a password** (`--requirepass`) | The defect this branch fixes — BullMQ discarding credentials from `REDIS_URL` — is **invisible against a passwordless Redis**. Every test passes locally and every queue dies with `NOAUTH` on Railway. A passwordless Redis cannot detect it. |
| `PORT` injected, `API_PORT`/`WORKER_PORT` unset | Reproduces how a platform assigns the port.                                                                                                                                                                                                    |
| `APP_ENV=QA`                                    | Exercises the real `etg:qa:*` namespacing.                                                                                                                                                                                                     |
| Two concurrent `migrate deploy` runs            | Proves no migration race.                                                                                                                                                                                                                      |
| A UAT-namespaced consumer on the **same** Redis | Proves the namespace isolates even when the instance does not.                                                                                                                                                                                 |

Verification that the environment can actually detect the bug:

```
$ docker exec etg-val-redis redis-cli PING
NOAUTH Authentication required.                    ← unauthenticated commands genuinely fail
$ docker exec etg-val-redis redis-cli -a *** PING
PONG
```

---

## 2. Defects found and fixed during this pass

Two, both found by running the containers rather than by reading them.

### 2.1 The API never shut down gracefully — SIGKILL on every deploy

`apps/api/src/main.ts` never called `enableShutdownHooks()`, so Nest did not listen for
SIGTERM and the `onModuleDestroy` hooks on `PrismaService` and `RedisService` — which exist
solely to clean up — never ran.

Adding the hook was **not sufficient**. A second, deeper cause: the `inventory-sync-events`
BullMQ `Queue` is built by a `useFactory` provider, and Nest does not tear down
factory-produced objects, so nothing ever closed it. An open Queue holds an ioredis socket;
an open socket holds the Node event loop. The process acknowledged SIGTERM, ran teardown,
and then simply hung until the grace period expired.

Measured, on the real image:

|                                     | Stop duration            | Exit code               |
| ----------------------------------- | ------------------------ | ----------------------- |
| Before (as committed on the branch) | 21 s (full grace period) | **137** (SIGKILL)       |
| After `enableShutdownHooks()` alone | 21 s                     | **137** — still hanging |
| After also closing the sync queue   | **1 s**                  | **0**                   |

This fires on every Railway deploy, restart, and scale-down — in-flight requests, including
a checkout mid-payment, were being severed. Fixed in `main.ts` and
`sync-ops.service.ts`; regression-guarded by `sync-ops.shutdown.spec.ts`.

### 2.2 The CD pipeline had no readiness gates between stages

`railway up --detach=false` returns when Railway's health check passes — but that check is
`/api/health`, **liveness**, which deliberately never touches PostgreSQL or Redis. An API
that booted with an unreachable database passes it and fails every request. The worker and
web tiers would then deploy on top of a broken API.

`deploy-railway.yml` now polls `/api/ready` (PostgreSQL **and** Redis, 503 when either is
down) after the API step and fails the release rather than cascading, plus a worker gate
after the worker step.

---

## 3. Branch integrity

```
$ git merge-base --is-ancestor main HEAD   → main IS an ancestor of HEAD
$ git log --oneline HEAD..main             → (empty; no rebase needed)
$ git log --oneline main..HEAD
cda8fe7 docs(deploy): Railway runbook, go-live checklist, and supporting references
49c8211 ci(deploy): branch-mapped Railway pipeline with a production approval gate
9584763 feat(deploy): per-service Railway configs, env templates, and an offline validator
5c26105 fix(runtime): make the API and worker deployable on a managed platform
```

Fast-forwardable onto `main` (`9632869`).

---

## 4. Static verification

```
$ npm run verify                                                    EXIT 0
  prettier            All matched files use Prettier code style!
  lint                3/3 tasks
  typecheck           13/13 tasks
  deps:check          No circular dependency found!
  verify:deploy       181 checks passed, 5 services + 3 env templates
  test                164 suites / 1217 tests passed
  build               8/8 tasks

$ npx prisma validate                     The schema is valid
$ node -e "yaml.load(...)" ×4 workflows   all parse; jobs enumerated
```

---

## 5. Docker images — all five built and run

Built from the repository root, then started with production-like variables and an injected
`PORT` that differs from every image default, to prove `PORT` is genuinely honoured.

| Service         | Build | Injected PORT | Bound          | Health                              | Non-root          | Shutdown   |
| --------------- | ----- | ------------- | -------------- | ----------------------------------- | ----------------- | ---------- |
| `api`           | OK    | 8080          | `0.0.0.0:8080` | `/api/health` 200, `/api/ready` 200 | uid 1000 (`node`) | 1s, exit 0 |
| `worker`        | OK    | 8090          | `0.0.0.0:8090` | `/health` 200, `/ready` 200         | uid 1000 (`node`) | 1s, exit 0 |
| `customer-web`  | OK    | 9000          | `0.0.0.0:9000` | `/api/health` 200, `/` 200          | uid 1000 (`node`) | 0s, exit 0 |
| `organizer-web` | OK    | 9000          | `0.0.0.0:9000` | `/api/health` 200, `/` 200          | uid 1000 (`node`) | 1s, exit 0 |
| `admin-web`     | OK    | 9000          | `0.0.0.0:9000` | `/api/health` 200, `/` 200          | uid 1000 (`node`) | 1s, exit 0 |

Observed API boot line: `ETicketsGo API listening on 0.0.0.0:8080/api` — the injected
`PORT`, not `API_PORT`'s 4000.

Readiness against the **password-protected** Redis:

```
{"status":"ok","checks":{"database":"up","redis":"up"}}   HTTP 200   (api)
{"status":"ok","checks":{"database":true,"redis":true}}   HTTP 200   (worker)
```

Worker logs contained **zero** `NOAUTH`/`WRONGPASS` errors — the credential fix works
end-to-end through the real image.

Other container facts confirmed:

- `/api/docs` returns **404** with `NODE_ENV=production` and `ENABLE_SWAGGER` unset.
- `/api/metrics` served 71 `etg_` metric lines; worker `/metrics` served 8.
- `NEXT_PUBLIC_API_URL=https://api-qa.eticketsgo.com/api` was found inlined in **both**
  `.next/server/chunks/*.js` and `.next/static/chunks/*.js` — empirical confirmation that
  the web images are environment-specific by construction and need a rebuild, not a
  restart, when the API URL changes.

---

## 6. Database and migrations

Against a clean PostgreSQL 16.

| Check             | Command                                                                                             | Result                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Schema valid      | `prisma validate`                                                                                   | valid                                                    |
| Apply all         | `prisma migrate deploy`                                                                             | **39 applied**, 69 tables, 0 unfinished, 0 rolled back   |
| Idempotent re-run | `prisma migrate deploy` again                                                                       | "No pending migrations to apply"; ledger unchanged at 39 |
| Status            | `prisma migrate status`                                                                             | "Database schema is up to date!"                         |
| **Drift**         | `prisma migrate diff --from-migrations --to-schema-datamodel --shadow-database-url ... --exit-code` | **"No difference detected."** exit 0                     |

### Migration race — two concurrent executors, one empty database

```
replica A exit=0   replica B exit=0
A: "No pending migrations to apply."
B: "All migrations have been successfully applied."

ledger:  total=39  distinct_names=39  unfinished=0  rolled_back=0  max_steps=1
duplicate migration_name rows: none
tables: 69
```

Prisma's advisory lock serialises them: one applied everything, the other found nothing to
do. No duplicate, no partial application.

Note this is the **belt**; the **braces** is architectural — `preDeployCommand` runs once
per deployment as a single one-off container, so on Railway the race cannot arise at all.
Exactly one service (`api`) declares a migration command; the validator enforces it.

---

## 7. Redis, BullMQ, and environment isolation

`node scripts/deploy/validate-redis-bullmq.mjs` — **18/18 assertions passed**.

| Assertion                                                                       | Result                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------- |
| Host+port-only parsing (the old code) is **rejected** by an authenticated Redis | PASS — `NOAUTH`                             |
| `bullConnectionFromUrl` preserves the password                                  | PASS                                        |
| A client built from those options authenticates                                 | PASS — PONG                                 |
| `rediss://` enables TLS; `/4` selects database 4                                | PASS                                        |
| QA BullMQ prefix is env-scoped                                                  | PASS — `etg:qa:bull`                        |
| BullMQ Queue authenticates and is ready                                         | PASS                                        |
| Enqueued job is consumed                                                        | PASS                                        |
| Delayed job held, then fires after its delay                                    | PASS — fired at 1763 ms for a 1500 ms delay |
| Repeatable job registers and fires on interval                                  | PASS — 2 executions                         |
| UAT prefix differs from QA                                                      | PASS                                        |
| **A UAT-namespaced worker cannot consume a QA job**                             | PASS — consumed nothing                     |
| Job survives worker shutdown                                                    | PASS — still `waiting=1`                    |
| Restarted worker drains the backlog                                             | PASS — no loss                              |
| All keys under `etg:qa:*`; none stray                                           | PASS — 16 keys                              |

The first assertion is deliberately inverted: without it, a future revert of the credential
fix would still pass against a passwordless Redis.

The real worker image independently registered its full repeatable schedule under
`etg:qa:bull:holds:repeat:*` — the scheduler works and is namespaced.

---

## 8. End-to-end

```
$ npm run e2e
  10 passed, 0 failed, 13 skipped   (38.0s)
```

Consistent with the established baseline. The 13 skips are the offline-gate and
wallet-pass specs, which are feature-flagged off.

Incidental finding: starting the API with `NODE_ENV=production` and CI-length secrets was
correctly **refused at boot** —

```
Error: Insecure production configuration:
  - JWT_ACCESS_SECRET: too short (< 24 chars) for production.
  - CORS_ORIGINS: must be set to the real frontend origin(s) in production.
```

— unplanned but useful proof that `assertProductionHardening` fires.

---

## 9. Failure drills executed locally

Full detail and pass criteria: [QA_FAILURE_DRILLS.md](./QA_FAILURE_DRILLS.md).

| Drill                            | Result                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Redis outage                     | PASS — ready 503 `"redis":"down"`, liveness stays 200, recovers without restart                         |
| PostgreSQL outage                | PASS — ready 503 `"database":"down"`, **0 credential/host/port tokens leaked**                          |
| Maintenance mode isolation       | PASS — only `etg:qa:ops:maintenance` written; UAT and production unset; legacy `etg:maintenance` absent |
| Concurrent seat booking          | PASS — 25 racers × 2 rounds → **1 winner, 24×409, 0 5xx, 0 oversell**                                   |
| Failed migration                 | PASS — exit 1 (fails the deploy), ledger marks it unfinished                                            |
| Migration recovery               | PASS — `migrate resolve --rolled-back` then deploy flows again                                          |
| Backup + restore                 | PASS — 219 KB dump → 69 tables, 40 ledger rows, status "up to date"                                     |
| Worker restart with pending jobs | PASS — no loss                                                                                          |
| API graceful shutdown            | PASS **after the fix** (was exit 137)                                                                   |

GA-quantity oversell was **skipped, not passed** — the seeded ticket type had zero remaining
stock. Re-run on QA with stock available.

---

## 10. What remains unproven

Honest limits of this record:

- **Nothing has been deployed.** No Railway project, service, plugin, domain, token, or DNS
  record exists. Every portal step in
  [QA_FIRST_DEPLOYMENT.md](./QA_FIRST_DEPLOYMENT.md) is outstanding.
- **Railway-specific behaviour is unverified by direct observation**: that
  `preDeployCommand` runs exactly once per deployment, health-check gating, rollback,
  variable references, build-arg injection, private networking. These follow Railway's
  documented behaviour, and the repository side is proven — but they have not been watched
  happening.
- **The readiness gates in `deploy-railway.yml` have never executed.** Their logic is
  reviewed, not run.
- **TLS to Redis (`rediss://`)** is asserted as a pure-function property, not against a
  TLS-enabled server.
- **No Cloudflare change has been made**; no DNS record exists.
- **No load test has been run on Railway.** Local numbers are a lower bound at best.
- **Drills 3, 4 (partial), 10** are not locally executable — duplicate webhook (needs a
  provider-signed payload; covered by unit tests), full seat-hold expiry, and deployment
  rollback.
