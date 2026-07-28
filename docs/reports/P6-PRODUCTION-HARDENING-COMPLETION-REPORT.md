# P6 — Production Hardening Completion Report

**Branch:** `feat/p6-production-hardening` · **Date:** 2026-07-28 · No booking features added; public
APIs unchanged except the `trust proxy` correctness fix; money automation OFF by default.

## Executive verdict: **CONDITIONAL GO (controlled pilot, money-OFF) / NO-GO (unrestricted production)**

All hardening code + artifacts are complete and verified at the code/CI level. Production is gated on
operational proofs that require infrastructure not available here (managed staging, payment sandbox
keys, load/chaos rigs, DR rehearsal) and one dependency-remediation batch. These are gates, not
defects.

## 1. Files changed (code)

- `apps/api/src/common/redis-namespace.ts` (+spec) — env-scoped Redis namespacing helpers.
- `apps/api/src/cache/cache.service.ts` (+spec) — env-namespaced cache keys.
- `apps/api/src/ops/holds-queue.provider.ts`, `apps/api/src/inventory/sync/sync-queue.provider.ts`,
  `apps/worker/src/main.ts` — env-scoped BullMQ prefix on all Queue/Worker sites.
- `apps/api/src/index.ts` — export namespace helpers.
- `apps/api/src/main.ts` — `trust proxy` for correct client-IP rate limiting.
- `apps/api/prisma/schema.prisma` — pinned `BookingCompensation` unique-index name (drift fix).
- Deploy/infra: `docker-compose.production.yml`, `docker-compose.staging.yml`, `railway.json`,
  `Procfile`; CI `.github/workflows/security.yml`; `observability/*` (rules, alertmanager, dashboard);
  `scripts/load/booking-load.artillery.yml`, `scripts/chaos/inject.sh`; ~18 docs.

## 2. Infrastructure improvements

Production compose overlay (2×api/2×worker, resource limits, `APP_ENV=PRODUCTION`, log rotation);
Railway config + Procfile; Railway + AWS (ECS/RDS/ElastiCache/S3/ECR/Secrets) deployment plans;
health/ready/metrics probes wired.

## 3. Security improvements

`trust proxy` (correct rate-limit/log client IP); env-namespaced Redis (queues + cache) so
environments cannot collide; `security.yml` CI (npm audit + dependency-review fail-on-high +
TruffleHog + migration-drift); infra review confirming helmet/CORS-allowlist/tiered-rate-limit/
15-min-JWT/Swagger-off/signature-verified-webhooks/parameterized-SQL/tenant-isolation.

## 4. CI/CD improvements

`security.yml` adds dependency + secret + **migration-drift** gates (which caught a real latent
index-name drift, now fixed). `deploy.yml` already provided GHCR build+push, GitHub-environment
manual approval, migrate-deploy, and health/ready/metrics smoke.

## 5. Monitoring improvements

12 booking-platform Prometheus alerts on real `etg_*` metrics (money/compensation/booking/infra);
Alertmanager routing (page/warn + infra→money inhibit); a booking-platform Grafana dashboard; all
wired into the observability compose. MONITORING-GUIDE.md documents scrape/dashboards/alerts/thresholds.

## 6. Deployment improvements

Staging + production overlays validated via `docker compose config`; per-env isolation documented
and now code-enforced; DEPLOYMENT-GUIDE.md covers pipeline, run, migrations, rollback, secrets.

## 7. Dependency findings

**91 advisories: 2 critical / 44 high / 42 moderate / 3 low.** `npm audit fix` and `npm update` pull
breaking majors (`next@16`, `@nestjs/core@11`, `vitest@4`); `npm update` fixed only 1 for ~8,500
lines of churn (**reverted**). No large safe-patch set exists. Plan in DEPENDENCY-REMEDIATION.md:
Batch A runtime majors (SEC-1 gate) + Batch B tooling, each isolated + test-gated.

## 8. Runtime vulnerabilities

Runtime-relevant highs/criticals: `next` (web SSR, critical), `@nestjs/platform-express`,
`fast-xml-parser`, `google-gax`, `@nestjs/swagger`, `@sentry/node`, `uuid`, `firebase-admin`
(transitive, parent-pinned). None sit in the API money path, but they must be upgraded (Batch A)
before production. Tooling advisories (`vitest`, `jest`, `eslint`, `glob`, etc.) are dev-only.

## 9. Operational risks

1. Auto-refund dormant by design (settlement fail-closed) → refund automation unproven e2e.
2. No production-capable idempotent-full-refund provider yet (mock only) — sandbox proof needed.
3. DR RTO/RTO are targets until the restore rehearsal runs.
4. Redis/Postgres `up` alerts need exporters deployed.
5. Load capacity is unmeasured (no staging) — do not assume flash-sale scale.

## 10. Remaining production blockers

- **SEC-1** dependency Batch A (runtime majors) remediated/verified.
- Managed **staging** stand-up → run P6.2 payment sandbox, P6.5 load, P6.6/6.8 chaos + attack matrix.
- **Settlement lookup** wired + **refund policy** owner sign-off (stays `MANUAL_ONLY` until then).
- **DR restore rehearsal** executed; backups + PITR verified.
- Body/upload limits, Prisma pool sizing, edge TLS/HSTS, web CSP applied.
- Monitoring exporters + Alertmanager receivers wired.

## 11. Recommended cloud topology

≥2 stateless API replicas + ≥2 lease-based workers behind a TLS-terminating LB; managed PostgreSQL
(Multi-AZ, PITR) authoritative; managed Redis **per environment**; object storage (versioned) + CDN;
image registry + secret manager; Prometheus/Grafana/Alertmanager. Correctness comes from PG guarded
writes + Redis fencing, not instance affinity.

## 12. Railway deployment plan

One project, two environments (staging/production), each with its own PostgreSQL + Redis plugins
(Redis never shared cross-env). Dockerfile-based services: api (railway.json), worker, 3 web apps.
Promote the same image tag staging→production behind a manual approval. Secrets as Railway variables.
(P6.1-CLOUD-DEPLOYMENT.md)

## 13. AWS deployment plan

ECS Fargate (api/worker/web services) behind ALB+ACM; RDS PostgreSQL Multi-AZ + PITR; ElastiCache
Redis per env; S3+CloudFront; ECR images (CI-pushed); Secrets Manager/SSM; CloudWatch + Prometheus.
Migrations as a one-shot ECS task gated before service update; rollback = previous task-definition
revision. VPC/subnet isolation per environment. (P6.1-CLOUD-DEPLOYMENT.md)

## 14. Cost estimate (rough, monthly — pilot scale; verify with the provider calculator)

|                             | Railway (pilot) | AWS (pilot)                     |
| --------------------------- | --------------- | ------------------------------- |
| Compute (2 api + 2 worker)  | ~$40–80         | ECS Fargate ~$70–140            |
| PostgreSQL (managed)        | ~$20–50         | RDS t4g.small Multi-AZ ~$60–120 |
| Redis (managed)             | ~$10–30         | ElastiCache t4g.small ~$25–50   |
| Object storage + egress/CDN | ~$5–20          | S3+CloudFront ~$10–40           |
| Web apps (3)                | ~$15–45         | in ECS above                    |
| **Total (pilot)**           | **~$90–225/mo** | **~$165–390/mo**                |

Assumptions: pilot traffic, single region, no reserved/committed-use discounts. Production/flash-sale
scale is materially higher and must be sized from the P6.5 load baseline (not yet measured).

## 15. Launch recommendation

**Proceed to a controlled pilot with money automation OFF once the P6.10 blockers are closed on real
staging.** Do **not** open unrestricted production until SEC-1 Batch A, settlement wiring + refund
policy sign-off, load/chaos on staging, and the DR rehearsal are complete. The platform is
code-complete, correctness-proven at the data layer (P6.4 soak: 0 double-finalize/oversell across
230 rounds), and safe-by-default.

## Final verification (executed 2026-07-28)

| Gate                                                              | Result                                          |
| ----------------------------------------------------------------- | ----------------------------------------------- |
| Full API suite                                                    | ✅ **162 suites / 1180 tests**                  |
| API tsc + build · worker tsc                                      | ✅ clean                                        |
| Prettier (CI glob)                                                | ✅ clean                                        |
| Prisma validate · migrate status · **drift gate**                 | ✅ valid · up-to-date · **no drift**            |
| Unsafe SQL · secret literals · correctness-TODOs · tracked `.env` | ✅ none                                         |
| console.log in request path                                       | ✅ none (only a CLI command)                    |
| Docker compose (staging + production)                             | ✅ `config` valid                               |
| P6.4 concurrency soak (real PG)                                   | ✅ 0 double-finalize / oversell / over-capacity |

**Infrastructure-gated (honest — not run here):** managed staging, payment sandbox, load/chaos live
runs, DR restore rehearsal, cloud provisioning. Each has a runnable harness + exact instructions.
