# Railway: legacy config as code to Infrastructure as Code

**Deadline: 2026-12-01.** Railway stops reading `railway.json` / `railway.toml` on that date
("hard cutoff", docs.railway.com/config-as-code, read 2026-11-06). This document is the audit,
the design, the QA trial and the runbook for UAT and PROD.

Status on 2026-11-07:

| Environment | State                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QA          | **Migrated.** Owned by `.railway/railway.ts`; legacy paths cleared. Settings-first procedure rehearsed on admin-web 2026-11-07 (section 6).                          |
| UAT         | Legacy. Preview: no behavioural difference. Settings-first dry run: 26 settings. **Proposed 2026-11-16**, needs owner approval.                                      |
| PROD        | Legacy. Preview: no behavioural difference (re-run after the 2026-11-06 web hotfixes). Settings-first dry run: 26 settings. **Proposed 2026-11-23**, needs approval. |

**Why it cannot wait:** under the legacy files, the UAT and PROD services' own settings are
empty (no Dockerfile path, start command, health check or pre-deploy migration; db-seed has no
cron). The files supply all of it. After the cutoff, the first deployment of any service would
build with Railway's defaults and no start command, and the nightly backup would stop running.

## 1. Why this is P0

Every app service in every environment gets its build and deploy settings **only** from its
legacy file. Railway's own stored settings say `builder: RAILPACK` with no start command, no
pre-deploy and no health check (read with each environment's project token, 2026-11-06).
After the cutoff, the next deploy of any service would:

- build with Railpack instead of the Dockerfile;
- skip `npx prisma migrate deploy` (the api's single migration step);
- run without a health check, so a broken build would take traffic;
- lose db-seed's nightly backup schedule (`0 2 * * *`) and its `NEVER` restart policy;
- lose QA's second api replica.

## 2. Inventory (read 2026-11-06, all three environments)

Same in QA, UAT and PROD unless the last column says otherwise.

| Service       | Config file (legacy)                        | Build                           | Pre-deploy                  | Start                               | Health        | Restart        | Replicas     | Differs per environment                 |
| ------------- | ------------------------------------------- | ------------------------------- | --------------------------- | ----------------------------------- | ------------- | -------------- | ------------ | --------------------------------------- |
| api           | `deploy/railway/api.railway.json`           | `apps/api/Dockerfile`           | `npx prisma migrate deploy` | `node dist/main.js`                 | `/api/health` | ON_FAILURE x5  | QA 2, else 1 | sleep: UAT on; domains                  |
| worker        | `deploy/railway/worker.railway.json`        | `apps/worker/Dockerfile`        | none                        | `node dist/main.js`                 | `/health`     | ON_FAILURE x10 | 1            | none                                    |
| customer-web  | `deploy/railway/customer-web.railway.json`  | `apps/customer-web/Dockerfile`  | none                        | `node apps/customer-web/server.js`  | `/api/health` | ON_FAILURE x5  | 1            | sleep: QA/UAT on; domains (port 8080)   |
| organizer-web | `deploy/railway/organizer-web.railway.json` | `apps/organizer-web/Dockerfile` | none                        | `node apps/organizer-web/server.js` | `/api/health` | ON_FAILURE x5  | 1            | sleep: QA/UAT on; domains               |
| admin-web     | `deploy/railway/admin-web.railway.json`     | `apps/admin-web/Dockerfile`     | none                        | `node apps/admin-web/server.js`     | `/api/health` | ON_FAILURE x5  | 1            | sleep: QA/UAT on; domains               |
| db-seed       | `deploy/railway/db-seed.railway.json`       | `apps/api/Dockerfile`           | none                        | `... prisma/seed-operation.ts`      | none          | NEVER          | 1            | volume name (UAT `db-seed-volume-CmA4`) |
| Postgres      | none                                        | image `postgres-ssl:16`         |                             |                                     |               |                | 1            | volume 500 MB on QA, 5000 MB UAT/PROD   |
| Redis         | none                                        | image `redis:7-alpine`          |                             |                                     |               |                | 1            | none                                    |

Overlap and draining: **unset on every service in every environment** (see section 7).
Variables: 57 (UAT) to 104 (QA) on the api; the sets differ per environment (UAT has
`PILOT_*`, PROD has its secret-manager and billing variables).

## 3. Design (`.railway/railway.ts`)

- **One file, three environments.** Differences are a table keyed on `ctx.environment`
  (`QA`, `UAT`, `PROD`): api replicas, sleep, custom domains, the seed volume.
- **Named partial `apps`.** The file owns only the six app services and the db-seed volume.
  Postgres, Redis and their volumes are not declared, so no plan can touch them.
- **Variables: names only, all `preserve()`.** `.railway/variables.ts` lists each service's
  variable NAMES per environment (generated by `scripts/deploy/railway-iac-variable-names.mjs`
  from a read-only `railway config pull --json`, which refuses any graph carrying a value).
  Railway keeps every value it holds. No secret is in source.
- **No root `railway.json`.** See trap 3.
- `verify:deploy` (`scripts/deploy/validate-railway-config.mjs`) compiles the file offline for
  all three environments on every CI run and asserts the rules the legacy files carried.

## 4. Traps found (each one would have broken an environment)

1. **Omitting `env` deletes variables.** A service with no `env` in a managed file means
   "this service has no variables". The first QA plan proposed **221 variable deletions**
   (DATABASE_URL and every secret). The docs do not say this; the plan did. Hence the
   generated name list.
2. **The stock database helpers change the database image.** `railway config pull` imports
   `postgres("Postgres")` and `redis("Redis")`, which planned `postgres:18` and `redis:8`
   against databases that run `ghcr.io/railwayapp-templates/postgres-ssl:16` and
   `redis:7-alpine` in all three environments: a major Postgres upgrade on a live data
   directory. Hence the partial that leaves databases undeclared.
3. **An empty Config File path falls back to the root `railway.json`, and it wins.** After
   clearing the QA paths and applying IaC, worker, db-seed, organizer-web and admin-web were
   built from `apps/api/Dockerfile` with the API's start and pre-deploy commands, and the api
   dropped to 1 replica (the root file said 1). Caught from the deployment manifests within
   minutes. db-seed ran as an API server for about 2 minutes; the worker build was replaced
   by a rollback before it took over (the real worker kept running); organizer-web and
   admin-web failed their builds and kept serving the previous deployment. Fixed by deleting
   the root file (no service in any environment used it on purpose: all named their own
   file) and a validator rule that it must not exist.
4. **`railway config migrate` cannot see this layout.** It found only the root file, named
   the service after the folder, and ignored `deploy/railway/*.railway.json`. The file was
   written by hand from the SDK types and checked against the live manifests.
5. **`railway config apply` deploys every changed service at the head of `main`, all at
   once.** It is a code release, and it ignores the api-first order (worker and web started
   building in parallel with the api's migration). Rule for UAT/PROD below: migrate only an
   environment that already runs `main` HEAD, so the apply redeploys the same code and has no
   migration to race.
6. **`railway config plan` refuses while a legacy path is set**, so UAT/PROD cannot be planned
   without first changing them. `scripts/deploy/railway-iac-preview.mjs` compares the compiled
   file with what each environment runs today, read-only.
7. Windows only: the SDK checks the CLI version by running `$_`; Git Bash sets `_` to a path
   it cannot execute. Run the CLI with `env _=<path to railway.exe> railway.exe config ...`.

## 5. QA trial (2026-11-06)

All with the QA project token (scoped to QA; every helper refused any other environment).
Rollback baseline before the trial: api `6e77eaf6`, worker `0870ca02`, customer-web
`69c394e9`, organizer-web `4cc953b8`, admin-web `9528dc40`, db-seed `42aeb414`.

| Time (UTC)  | Step                                                                                 | Result                                                                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20:2x       | `config pull` (import) and `config migrate` (dry run)                                | traps 1, 2 and 4                                                                                                                                                                                                                                                                    |
| 20:2x       | Cleared the six QA Config File paths (`""`; `null` is ignored). No deploy triggered. | ok                                                                                                                                                                                                                                                                                  |
| 20:2x       | Plan with the named partial + preserved variables                                    | **0 to add, 11 to change, 0 to destroy**: exactly the legacy build/deploy fields                                                                                                                                                                                                    |
| 20:25       | `config apply --plan` (saved, reviewed plan)                                         | applied; it started deployments of all six services at `main` `df69436a` (trap 5)                                                                                                                                                                                                   |
| 20:30       | Deployment manifests                                                                 | **trap 3**: five services read the root `railway.json`; admin-web/organizer-web failed                                                                                                                                                                                              |
| 20:31       | Rolled back worker and db-seed to their previous deployments                         | ok. The real worker (`0870ca02`) ran until 20:31:43 and its rollback copy took over then; the worker-as-API deployment was removed (20:31:42) before it took over. db-seed ran as an API server 20:29-20:31 (outside its 02:00 schedule; its pre-deploy found no pending migration) |
| 20:34       | Deleted the root `railway.json` (branch `ccc5a89a`)                                  |                                                                                                                                                                                                                                                                                     |
| 20:36-21:00 | Redeployed api, then worker, db-seed, then the web apps at `ccc5a89a`                | **all SUCCESS**; every manifest: no config file, `DOCKERFILE`, its own Dockerfile and commands                                                                                                                                                                                      |
| 21:10       | `config plan --detailed-exit-code`                                                   | **exit 0: no changes**                                                                                                                                                                                                                                                              |
| 21:10       | `railway-iac-preview.mjs` for QA, UAT, PROD                                          | **no behavioural difference** in all three                                                                                                                                                                                                                                          |

Verified on QA after the migration (manifest of each new deployment):

- api: `apps/api/Dockerfile`, pre-deploy `npx prisma migrate deploy` ran ("157 migrations
  found, No pending migrations to apply"), health `/api/health`, **2 replicas**, overlap 20 s,
  draining 120 s.
- worker: `apps/worker/Dockerfile`, no pre-deploy, health `/health`, 10 restarts.
- web apps: their own Dockerfiles and `server.js`, `/api/health`, sleep on (QA).
- db-seed: `prisma/seed-operation.ts`, restart `NEVER`, cron `0 2 * * *`, `/backups` volume.
- Postgres and Redis: untouched (no new deployment; images unchanged).

Rollback was exercised for real (worker, db-seed) with `deploymentRollback`.

After the migration (all six services from IaC settings, api at 2 replicas with 20/120):

- `qa-smoke-test.sh`: all automated checks pass.
- `scripts/pilot/pilot-cert.mjs` (with the MFA sign-in step, AR-28), all stages, fresh
  organization: **69 PASS, 0 FAIL, 4 BLOCKED**, identical to the morning baseline
  (QA-CERTIFICATION-2026-11-06.md). Real Razorpay TEST Netbanking payments confirmed through the
  live webhook, refunds, check-in, reconciliation (0 discrepancies), authorisation refusals,
  payout generation. BLOCKED, same four, accepted as documented limitations: COM-4 (inbox),
  F-RF-1 (provider refund failure), F-WH-3 (genuine duplicate signed webhook), PAYOUT-7 (bank
  verification needs a second staff member; not bypassed).

**QA at the end of 2026-11-06:** every service on `4e7666e4` = `main` `df69436a` + #597 + #596
(next 15.5.28), CI green on draft #598. Smoke 14/14; 2 api replicas; Postgres 9 of 497
connections (1.8 %); `config plan` exit 0 (no drift). Rollback (previous deployment per
service): api `d103f2f5`, worker `d2cbf53f`, db-seed `c94db3b9`, customer-web `1b6321c0`,
organizer-web `84f7dc05`, admin-web `a0eb1634`. **QA now runs code that is not on `main`
(#596, #597): a deploy from `main` before they merge brings back the root `railway.json`.**

## 6. Runbook for UAT, then PROD: settings first, nothing deployed (each needs explicit owner approval)

**The configuration migration is separate from any code release.** The first runbook (apply
after the environment runs `main` HEAD) tied the migration to a full release, because
`config apply` deploys every service it changes at `main` HEAD (trap 5). UAT runs `2439e254`
(339 commits behind) and PROD runs `be2a2c7f` (api, worker) plus the web hotfixes, so that
order would make the migration a feature release. Instead, the settings IaC owns are written
to each service while the legacy file still wins. Then the paths are cleared, and the plan has
nothing left to change: no `apply`, no deployment, no code change.
`scripts/deploy/railway-iac-settings-first.mjs` does it and never touches variables, domains,
replicas, regions, source, Postgres, Redis or volumes.

**Rehearsed on QA, 2026-11-07, admin-web.** QA admin-web was put back into PROD's state
(legacy path set, settings blank). The script then ran:

- **`--write`:** 4 settings written, no deployment.
- **Dry run:** 0 pending.
- **`--clear-legacy-paths`:** cleared, no deployment.
- **`config plan --detailed-exit-code`:** exit 0.

A pinned redeploy of the same commit then built from the settings alone: manifest `configFile`
absent, builder `DOCKERFILE` with `apps/admin-web/Dockerfile`, start
`node apps/admin-web/server.js`, health `/api/health`. The console answered 200. Without the
confirmation variable, the script refuses.

**Dry run, 2026-11-07, UAT and PROD (identical):**

| Service            | Settings written                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api                | `dockerfilePath`, `startCommand`, `preDeployCommand` (`npx prisma migrate deploy`), `healthcheckPath`, `healthcheckTimeout`, `restartPolicyMaxRetries` 10 -> 5 |
| worker             | `dockerfilePath`, `startCommand`, `healthcheckPath` `/health`, `healthcheckTimeout`                                                                            |
| the three web apps | `dockerfilePath`, `startCommand`, `healthcheckPath`, `healthcheckTimeout`, `restartPolicyMaxRetries` 10 -> 5                                                   |
| db-seed            | `cronSchedule` `0 2 * * *` (the nightly backup)                                                                                                                |

That is 26 settings in all, each equal to what the legacy file supplies today: the preview
shows no behavioural difference.

Prerequisites: you hold that environment's project token (scoped to it alone). Run from a
checkout of `main` with `npm ci` done, because the SDK is a devDependency. On Windows, run the
CLI as `env _=<path to railway.exe> railway.exe` (trap 7).

| Step | Command (`T` = `RAILWAY_TOKEN=<env token>`)                                                                                                                             | Must show                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Confirm the latest verified backup (`docs/deployment/RAILWAY_BACKUP_RECOVERY.md`)                                                                                       | A verified dump from the last 24 h                                                                                                                          |
| 1    | `T node --experimental-strip-types scripts/deploy/railway-iac-preview.mjs`                                                                                              | "No behavioural difference" (otherwise regenerate `.railway/variables.ts`, review, merge, repeat)                                                           |
| 2    | Record the baseline: each service's latest deployment id and `railwayConfigFile`                                                                                        | Six ids and six paths written down                                                                                                                          |
| 3    | `T node --experimental-strip-types scripts/deploy/railway-iac-settings-first.mjs`                                                                                       | The 26 settings above, nothing else                                                                                                                         |
| 4    | `T CONFIRM_IAC_SETTINGS=<ENV> node ... railway-iac-settings-first.mjs --write`                                                                                          | "no service got a new deployment"                                                                                                                           |
| 5    | Step 3 again                                                                                                                                                            | "No settings pending"                                                                                                                                       |
| 6    | **Window ends here** while the environment runs a commit with a repo-root `railway.json` (UAT and PROD on 2026-11-07: every commit). Record step 5's output             | The settings are in place under the legacy file: no behaviour change, nothing deployed. They are what applies once Railway stops reading files (2026-12-01) |
| 7    | LATER, after that environment's release of `main` (no root `railway.json`): `T CONFIRM_IAC_SETTINGS=<ENV> node ... railway-iac-settings-first.mjs --clear-legacy-paths` | The script refuses while any service runs a commit with a root `railway.json` (trap 3 guard). Then: six paths cleared, "no service got a new deployment"    |
| 8    | `T railway config plan --detailed-exit-code`                                                                                                                            | **exit 0**, "already up to date". Anything else: stop, restore the paths (rollback), investigate. Never `apply` here                                        |

**Why the window stops at step 6 (found 2026-11-07, PR #602 review):** with the path cleared,
Railway falls back to a repo-ROOT `railway.json` when the deployed commit has one, and it wins
over the settings (trap 3; on QA it rebuilt every service as the api). #597 removed it from
`main`, but 2439e254 (UAT), be2a2c7f, 646e469f and all three Next.js hotfix commits still carry
it. Clearing the paths there would make the next redeploy, rollback or hotfix of any of them
build the wrong service, and the earlier step 8 (redeploy admin-web at e7285c19) would have
done exactly that. Railway's docs (read 2026-11-07) say files "stop being read on 2026-12-01
(hard cutoff)" but not whether the root default lookup stops too; the guard does not rely on it.

The next normal release then builds every service from these settings. A later
`config apply` is only for an intended change, after the environment runs `main` HEAD, and it
still redeploys what it changes (trap 5).

**Rollback** (any step): set each `railwayConfigFile` back to its baseline path
(`deploy/railway/<svc>.railway.json`, kept in the repo until every environment is migrated). The
file wins again, and the written settings are harmless underneath it. No deployment was made, so
none needs rolling back. If the step 8 verification deploy fails, `deploymentRollback` that one
service to its baseline id.

### PROD-specific checks (2026-11-23)

- Run step 1 again on the day. The variable-name lists in `.railway/variables.ts` must match
  (it lists names only, and each environment has its own list).
- Not in this change: replicas (PROD 1 each), sleep (off), the custom domains, the api
  overlap/draining values (AR-22, still an owner decision), the access gate variables (AR-34),
  Sentry. Each is its own approved change.
- Keep `deploy/railway/*.railway.json` in the repo until PROD is verified (the rollback source).

After all three environments are migrated: delete `deploy/railway/*.railway.json` and the
legacy-consistency rule in the validator.

## 7. Overlap and draining

Railway's default (`overlapSeconds` / `drainingSeconds` unset) was measured on QA with the
api at 2 replicas. A probe kept HTTPS requests open by uploading a small body slowly (one byte
every 2 s), one every 5 s, while the api was redeployed at the same commit. Any HTTP status
means the request completed; a 502 means it was cut.

| Run | Setting                      | Request length | In flight across the switch | Cut (502)    | `/api/health` every 1 s |
| --- | ---------------------------- | -------------- | --------------------------- | ------------ | ----------------------- |
| A   | unset (all environments)     | 40 s           | 72                          | 0            | 352 / 352 ok            |
| A2  | unset                        | 90 s           | 48                          | **15 of 48** | 265 / 265 ok            |
| B   | overlap 20 s, draining 120 s | 90 s           | 48                          | **0 of 48**  | 263 / 263 ok            |

Reading: with the default, Railway stops the old container a few seconds after the new one is
healthy. A request that finishes within that window survives (run A), a longer one is cut,
all at the same instant (run A2: 15 cut at 20:58:33.7, the old containers' stop). New requests
are never refused (health checks all passed). With draining 120 s the old container keeps
serving its open requests after SIGTERM (`app.enableShutdownHooks()` closes the server
gracefully) and nothing is cut.

**Recommendation (owner decision for UAT/PROD, AR-22):**

| Service  | overlapSeconds | drainingSeconds | Why                                                                                           |
| -------- | -------------- | --------------- | --------------------------------------------------------------------------------------------- |
| api      | 20             | 120             | measured above; 120 = the server's request timeout (`HTTP_TIMEOUT_DEFAULTS.requestTimeoutMs`) |
| worker   | 0              | 60              | `worker.close()` waits for running BullMQ jobs; not measured (no long job to drive on QA)     |
| web apps | 10             | 30              | short static/SSR requests; not measured                                                       |

The api values are in `.railway/railway.ts` for QA only (`apiRollout`). For UAT/PROD set the
same field after approval; the plan will show exactly those two changes. Cost: during a deploy
the old and new containers run together for up to overlap + draining (about 2.5 minutes).
