# API high availability: two replicas

Status: verified locally on 2026-11-06. **Production still runs ONE API replica.** Raising it
needs the owner's approval and the checks in "Before raising replicas" below.

See [RAILWAY_COST_SIZING.md](./RAILWAY_COST_SIZING.md) section 5 for why two is the minimum
(a single replica makes every deploy and restart an outage) and section 6 for the worker.

## Current state (read from Railway, read-only, 2026-11-06)

| Environment | api | worker | customer-web | organizer-web | admin-web  | Region   |
| ----------- | --- | ------ | ------------ | ------------- | ---------- | -------- |
| PROD        | 1   | 1      | 1            | 1             | 1          | us-west2 |
| UAT         | 1   | 1      | 1 (sleeps)   | 1 (sleeps)    | 1 (sleeps) | us-west2 |
| QA          | 1   | 1      | 1 (sleeps)   | 1 (sleeps)    | 1 (sleeps) | us-west2 |

Every `deploy/railway/*.railway.json` sets `"numReplicas": 1`. **These files are config as code
and apply to every environment that uses them**, so changing the number in the file changes
production on its next deploy. Raise replicas per environment in the Railway dashboard (or
split the config), never by editing the shared file in a normal PR.

## What was verified

### Statelessness (code review)

| Concern                  | Finding                                                                                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions                 | JWT access + refresh tokens; no server-side session. Replicas must share the JWT secrets (they do: one variable set per service).                                                                                                                          |
| Rate limits              | `RedisThrottlerStorage` in every deployed environment (`throttlerStorageMode`; `APP_ENV=LOCAL` uses memory). Falls back to memory per process only while Redis is unreachable. Login backoff and the bot-check risk counter are Redis-backed the same way. |
| Uploads                  | Postgres or R2 object store, not local disk.                                                                                                                                                                                                               |
| Timers / cron in the API | None (`@nestjs/schedule`, `setInterval`, node-cron: none). All scheduled work is BullMQ in the worker.                                                                                                                                                     |
| In-process caches        | Secret cache, provider factory, Razorpay methods, provider health, sync circuit breakers, campaign dispatch. None is authoritative; each can be stale for its TTL after a config change.                                                                   |
| Domain event bus         | In-process; durable cross-process delivery is the transactional outbox, dispatched by the worker.                                                                                                                                                          |
| WebSockets / SSE         | None.                                                                                                                                                                                                                                                      |
| Migrations               | Once per deploy in the api `preDeployCommand`, before any new replica takes traffic.                                                                                                                                                                       |

### Process-level drill (`scripts/ha/two-replica-drill.mjs`)

Two API containers built from the Node 24 image, sharing one Postgres 16 and one Redis 7, with
production hardening on and `THROTTLE_STORAGE=redis` (as every deployed environment runs).
16 clients for 40 s through a health-checking load balancer, each request from a different
client address; replica A stopped with `docker stop` (SIGTERM, graceful) at 15 s.

| Check                                                                       | Result                                                                                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Both replicas ready (Postgres + Redis)                                      | pass                                                                                                                  |
| Shared login limit: 30 failed logins from one address, alternating replicas | **pass**: 10 allowed, 20 refused (per-process limits would allow 20)                                                  |
| Load + failover                                                             | **pass**: about 18,000 requests, **0 failed**, 0 retried by the balancer. A stopped within 1.5 s. Survivor p95 49 ms. |
| 16 concurrent copies of one signed Razorpay webhook, half to each replica   | **fail on `main`**: 6 of 16 answered 500. Fixed on this branch (below).                                               |

The first drill run used `APP_ENV=LOCAL` defaults and one client address; it measured the
in-memory per-process limiter and the per-address rate limit instead of the replicas. That
run is not evidence either way and is not counted above.

### Duplicate financial operations with 2+ replicas

The API itself runs no scheduled job. Its only background-like work is expiring a hold on the
booking path (a conditional update; a booking that reached the payment gateway is skipped)
and processing a webhook inline right after accepting it (a conditional claim
RECEIVED/FAILED -> PROCESSING). Two worker replicas are covered in RAILWAY_COST_SIZING.md
section 6 and below.

| Job                                      | Guard                                                                                                           | Safe with 2 replicas                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| expire-holds + captured-payment recovery | Conditional booking update; stock released only by the winner; recovery uses the normal confirm path            | yes                                                                           |
| payout-runs                              | Per-organization advisory lock; an open payout blocks a new one                                                 | yes                                                                           |
| settlement transfer release (admin)      | Conditional status claim; idempotency key `settlement_<id>_<transferred>`; attempt row before the provider call | yes                                                                           |
| cancellation-refunds                     | Per-booking advisory lock; conditional REQUESTED -> PROCESSING; provider idempotency keys                       | yes                                                                           |
| process-webhooks                         | Unique (provider, providerEventId); conditional claim                                                           | yes (and see the fix below)                                                   |
| outbox-dispatch                          | `FOR UPDATE SKIP LOCKED` + lease                                                                                | yes, unless a handler outlives its lease                                      |
| dispatch-notifications                   | `pg_try_advisory_xact_lock` (one sweeper at a time)                                                             | yes                                                                           |
| campaign-send                            | Job id per recipient                                                                                            | yes                                                                           |
| reconcile-finance                        | Check-then-create, no unique key                                                                                | **open**: concurrent runs could file duplicate discrepancies (no money moves) |
| settlement promote (expire-holds tick)   | Upsert on (eventId, currency), status from an unlocked earlier read                                             | **open**: a concurrent status change could be overwritten                     |

The two open rows matter only if the WORKER is scaled past one replica. Keep the worker at 1.

## Fixed on this branch

**Concurrent duplicate webhook deliveries answered 500.** Both Razorpay and Stripe ingestion
read "no row" and insert; when two copies of one event arrive at once (a provider retry while
the first copy is still in flight, which two replicas make much more likely), the second
insert hits the unique key and the API answered 500. The data stayed correct (one row, one
processing), but the provider retried and the 500 counted as an incident. The losing insert is
now answered `200 {duplicate: true}`; any other database error still fails.

Tests: unit tests for both providers, and
`razorpay-webhook-concurrency.integration-postgres.spec.ts` (eight copies at once against the
real unique index: one row, one processing, no failure). Falsified: with the old service the
real-Postgres test fails with the unique-constraint error. The drill shows the same: 6 of 16
copies answered 500 on `main`; with this branch's image, **16 of 16 were answered 2xx**, and the
same run again had 0 failed requests out of 21,787 through the SIGTERM of replica A (shutdown
0.9 s, survivor p95 43 ms) and the shared login limit held (10 allowed, 20 refused).

## Before raising replicas (owner approval required)

1. **Postgres connection budget.** No service sets `connection_limit`. Prisma's default pool is
   `cpus * 2 + 1` per process, and a container can report the host's CPU count. Before adding a
   replica: read `max_connections` and `SELECT count(*) FROM pg_stat_activity` on the
   environment's Postgres (read-only), then set `?connection_limit=<n>&pool_timeout=10` on each
   service's `DATABASE_URL` so `(api replicas + worker + db-seed) * n` stays well under
   `max_connections`. Changing `DATABASE_URL` is a variable change, which redeploys the
   service (see the variable-change note in the deploy kit): do it with `skipDeploys` and a
   pinned redeploy.
2. **Raise QA to 2 first**, in the dashboard, and run `scripts/ha/two-replica-drill.mjs`
   against the two QA replica URLs, plus a deploy during load (Railway's own rollout and
   draining behaviour is not verified by the local drill).
3. Then UAT, then production in the normal release window.
4. Rollback: set replicas back to 1 in the dashboard. Nothing else depends on the count.

Cost: one more api container of the same size (RAILWAY_COST_SIZING.md section 4).

## Health checks and shutdown

- Railway's deploy health check is `/api/health` (liveness). `/api/ready` checks Postgres and
  Redis and answers 503 if either is down; Railway does not route by it after the deploy.
- `enableShutdownHooks()` is on; the drill showed in-flight requests completing and the process
  exiting within 1.5 s of SIGTERM. Keep-alive is 65 s (longer than common proxy idle timeouts).
