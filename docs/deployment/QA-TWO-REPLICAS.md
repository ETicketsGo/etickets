# QA: two API replicas and an explicit connection pool (AR-04, AR-05, AR-07)

Owner decision 2026-11-06 (item 3): run 2 API replicas on QA only, after checking Postgres
connection limits and setting the pools explicitly, without changing anything that reaches
UAT or production.

## What this change does

| Piece                                                                                                 | Effect                                                                                                                     | UAT / PROD                                                          |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `deploy/railway/api.railway.json` `environments.QA.deploy.multiRegionConfig.us-west2.numReplicas = 2` | The environment named **QA** runs 2 api replicas. Railway applies environment-specific config over the base.               | Unchanged: the base stays `numReplicas: 1`, and they have no entry. |
| `DATABASE_POOL_SIZE` / `DATABASE_POOL_TIMEOUT_SECONDS` (`prisma/pool-url.ts`)                         | Sets Prisma's `connection_limit` / `pool_timeout` for the process. A `connection_limit` already in `DATABASE_URL` wins.    | Unset = exactly today's behaviour (Prisma default `cpus * 2 + 1`).  |
| `GET /admin/ops/database` (OPS_READ)                                                                  | `max_connections`, reserved slots, client connections by address and state, utilisation, and the answering process's pool. | Read-only; available wherever deployed.                             |
| Boot log `DatabasePool`                                                                               | `connection pool N (source)` once per process.                                                                             | Log only.                                                           |

Railway's config-as-code page (fetched 2026-11-06) documents replicas only under
`multiRegionConfig`, documents environment overrides as `environments.<name>` matched by
**name**, and does not say whether the match is case-sensitive. So after the deploy the live
count is read back (`serviceInstance.numReplicas` and distinct clients in
`/admin/ops/database`); the change is not called done on the file alone.

**Config as code is deprecated by Railway** (banner on the same page): legacy files keep
working until **2026-12-01**. Every service here uses it (start command, pre-deploy migration,
health check). Register item AR-24.

## QA budget

QA Postgres `max_connections` and live use are read from `/admin/ops/database` after the
deploy (the Railway SSH agent was unavailable and QA Postgres has no public proxy).

Target on QA: `DATABASE_POOL_SIZE=10` on api and worker, `DATABASE_POOL_TIMEOUT_SECONDS=10`.
Budget: 2 api x 10 + worker x 10 + db-seed (one-off, default pool) = about 30 + seed, against
Railway Postgres's usual 100. Set with `skipDeploys: true` (a variable change otherwise
deploys `main`), then deploy.

## Rollback

Delete the `environments.QA` block (or set it to 1) and redeploy QA; unset the two pool
variables. Nothing else depends on either.
