# ETicketsGo — Deployment Documentation

Railway deployment across three isolated environments: **QA**, **UAT**, **Production**.

**Deploying QA for the first time? Start with
[QA_FIRST_DEPLOYMENT.md](./QA_FIRST_DEPLOYMENT.md)** — it is the step-by-step for the one
project you should create first. Do not touch UAT or Production until QA has passed.

| Document                                                             | Use it when                                                                                                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [**QA_FIRST_DEPLOYMENT.md**](./QA_FIRST_DEPLOYMENT.md)               | Executing the first QA deployment: GitHub, Railway portal, variables, domains, Cloudflare.                                                     |
| [**QA_PREFLIGHT_VALIDATION.md**](./QA_PREFLIGHT_VALIDATION.md)       | Reviewing what was proven locally before deploying, and what is still unproven.                                                                |
| [**QA_FAILURE_DRILLS.md**](./QA_FAILURE_DRILLS.md)                   | Running the twelve failure drills against QA.                                                                                                  |
| [**QA_LOAD_TEST_PROFILE.md**](./QA_LOAD_TEST_PROFILE.md)             | Load-testing QA for a soft launch.                                                                                                             |
| [**RAILWAY_DEPLOYMENT_RUNBOOK.md**](./RAILWAY_DEPLOYMENT_RUNBOOK.md) | Setting Railway up, deploying, promoting, rolling back, handling a failed migration, rotating secrets, restoring the database. **Start here.** |
| [**RAILWAY_GO_LIVE_CHECKLIST.md**](./RAILWAY_GO_LIVE_CHECKLIST.md)   | Verifying an environment after its first deploy, and before every production release.                                                          |
| [**CLOUDFLARE_DNS.md**](./CLOUDFLARE_DNS.md)                         | Wiring domains, SSL, caching rules, QA/UAT access protection, production DNS cutover.                                                          |
| [**RAILWAY_BACKUP_RECOVERY.md**](./RAILWAY_BACKUP_RECOVERY.md)       | Backups, RPO/RTO, restore procedure, restore testing.                                                                                          |
| [**RAILWAY_COST_SIZING.md**](./RAILWAY_COST_SIZING.md)               | Sizing each environment, deciding what may scale to zero, scaling triggers.                                                                    |

## Repository artifacts

| Path                                                 | What it is                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `deploy/railway/*.railway.json`                      | Per-service Railway config-as-code (builder, Dockerfile, start command, health check, migration command)       |
| `deploy/railway/env/{qa,uat,production}.env.example` | Every service variable per environment, grouped and classified. **Templates — never filled in and committed.** |
| `railway.json`                                       | Fallback config for a service with no config-as-code path set; describes the API                               |
| `.github/workflows/deploy-railway.yml`               | The CD pipeline: `develop`→QA, `release/**`→UAT, `main`→Production (approval-gated)                            |
| `.github/workflows/ci.yml`                           | The verification gate every deployment runs first                                                              |
| `scripts/deploy/validate-railway-config.mjs`         | Offline deployment-config validator (`npm run verify:deploy`)                                                  |
| `scripts/deploy/validate-redis-bullmq.mjs`           | Redis/BullMQ contract test against a password-protected Redis (`npm run verify:redis`)                         |
| `scripts/deploy/qa-smoke-test.sh`                    | Post-deployment QA smoke test (read-only; safe to re-run)                                                      |
| `deploy/railway/validation/`                         | Railway-shaped local stack (password Redis, clean Postgres) used for pre-deployment proof                      |

## Other deployment targets (unchanged, still supported)

| Target                          | Document                                                               |
| ------------------------------- | ---------------------------------------------------------------------- |
| AWS (ECS Fargate)               | [P6.1 Cloud Deployment](../p6/P6.1-CLOUD-DEPLOYMENT.md)                |
| Docker Compose / self-hosted    | [Deployment Guide](../guides/DEPLOYMENT.md), `docker-compose.prod.yml` |
| GHCR image builds for the above | `.github/workflows/deploy.yml` (manual trigger)                        |
| Local development               | [README](../../README.md), `docker-compose.yml`                        |

## Before you deploy anything

```bash
npm run verify:deploy   # deployment-config gate; needs no cloud access
npm run verify          # the full gate: format, lint, typecheck, deps, deploy-config, tests, build
```
