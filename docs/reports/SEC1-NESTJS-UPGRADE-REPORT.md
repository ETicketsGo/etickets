# SEC-1 — NestJS Runtime Dependency Family Upgrade Report

**Batch A1** · branch `chore/sec1-nestjs-runtime-remediation` · 2026-07-28 · **not merged**.

## 1. Scope

Upgrade the **NestJS package family only** (10 → 11 + its required Express 5 cascade). No Next.js,
Sentry, Firebase, Vitest, or other family is touched. No booking features; no public-API change
beyond the Express-5 route-syntax fix.

## 2. Baseline (main `b015abe`, recorded BEFORE any change)

| Env             | Value                                                                                   |
| --------------- | --------------------------------------------------------------------------------------- |
| Node / npm      | v24.14.1 / 11.11.0                                                                      |
| lockfileVersion | 3                                                                                       |
| Workspaces      | `packages/*`, `apps/*` (apps: admin-web, api, customer-web, e2e, organizer-web, worker) |

**Baseline gates — all GREEN:** full API suite **162 suites / 1180 tests**; api tsc 0; api build ok;
worker tsc 0; **app boots**; prisma validate ok; migrate status up-to-date; migration drift 0;
prettier clean; secret scan clean. **`npm audit` = 91 (2 critical, 44 high, 42 moderate, 3 low).**
Main was healthy before changes — no pre-existing failure is attributable to this upgrade.

## 3. Dependency graph / advisory ownership (honest)

The NestJS family **owns 0 critical, 5 high** advisories, all removed by the 11 upgrade:

| Advisory                                     | Severity | Exposure                        | Fixed by                       |
| -------------------------------------------- | -------- | ------------------------------- | ------------------------------ |
| `multer` (DoS via incomplete cleanup)        | high     | **runtime** (upload middleware) | platform-express@11 (multer 2) |
| `@nestjs/platform-express`                   | high     | runtime                         | platform-express@11            |
| `@nestjs/cli`                                | high     | dev/build                       | cli@11                         |
| `fork-ts-checker-webpack-plugin` (minimatch) | high     | dev/build                       | cli@11                         |
| `tmp` (symlink write)                        | high     | dev/build                       | cli@11                         |
| `brace-expansion` (DoS)                      | high     | dev/build                       | cli@11                         |

**The 2 critical advisories (`next` SSR, `vitest`) are NOT NestJS** and are out of scope for A1 —
this batch removes **zero** criticals (do not claim otherwise). Remaining highs are Next.js/eslint/
jest/google-gax families (later batches).

## 4. Target versions (coherent set; no `--force`, no `--legacy-peer-deps`)

| Package                                              | Before            | After               | Reason                                                |
| ---------------------------------------------------- | ----------------- | ------------------- | ----------------------------------------------------- |
| `@nestjs/common`,`core`,`platform-express`,`testing` | ^10.4.4           | **^11.1.28**        | core family, must move together                       |
| `@nestjs/cli`                                        | ^10.4.5           | ^11.0.24            | fixes cli/tmp/fork-ts-checker highs                   |
| `@nestjs/schematics`                                 | ^10.1.4           | ^11.1.0             | cli peer                                              |
| `@nestjs/config`                                     | ^3.2.3            | **^4.0.4**          | NestJS-11 compatible (peer `^11`)                     |
| `@nestjs/jwt`                                        | ^10.2.0           | ^11.0.2             | family                                                |
| `@nestjs/passport`                                   | ^10.0.3           | ^11.0.5             | family                                                |
| `@nestjs/swagger`                                    | ^7.4.2            | **^11.4.6**         | NestJS-11 compatible                                  |
| `@nestjs/throttler`                                  | ^6.2.1            | ^6.5.0              | v6 peer already supports NestJS 11 (no major)         |
| `@types/express`                                     | ^4.17.21          | **^5.0.0**          | platform-express@11 → Express 5.2                     |
| `rxjs` (root `overrides`)                            | 7.8.1/7.8.2 split | **7.8.2** singleton | NestJS-11 `Observable<unknown>` typing needs one rxjs |

Peers satisfied: `rxjs ^7.1.0` (have 7.8.2), `reflect-metadata ^0.2` (have 0.2.2). No peer-dep
warnings suppressed.

## 5. Breaking-change assessment (reviewed; ETicketsGo impact)

| Area                                                     | NestJS 11 change                                  | ETicketsGo impact                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Node                                                     | requires ≥ 20                                     | ✅ on v24                                                                                                  |
| Express adapter                                          | Express 4 → **5** (path-to-regexp v8)             | ⚠️ **1 fix** (middleware wildcard, §6)                                                                     |
| Route wildcards                                          | bare `*` removed                                  | audited: only 1 site (middleware `forRoutes`); no controller `*`/`@All`/versioning/static/SPA routes exist |
| Middleware / guards / filters / pipes / serialization    | API stable                                        | ✅ no change (verified by 1180 tests + boot)                                                               |
| DI metadata                                              | unchanged (still emitDecoratorMetadata)           | ✅ import-type audit clean (§7)                                                                            |
| `@nestjs/jwt` (jsonwebtoken@9)                           | `expiresIn` retyped `number                       | ms.StringValue`                                                                                            | ⚠️ **1 fix** (cast, §6) |
| RxJS                                                     | stricter `Observable<unknown>` interceptor typing | ⚠️ dual-rxjs pinned to singleton (§6)                                                                      |
| Swagger 7→11 · Throttler · Config 3→4 · Logger · Testing | compatible                                        | ✅ no code change                                                                                          |

Terminus/BullMQ-Nest/Schedule/mapped-types/Fastify: **not used** by ETicketsGo (BullMQ is used
directly, not via `@nestjs/bullmq`).

## 6. Code changes required (3 files)

1. **`app.module.ts`** — `forRoutes('*')` → `forRoutes('{*path}')` (Express-5 named catch-all; removes
   the NestJS-11 LegacyRouteConverter warning). Correlation-id middleware still runs on every route.
2. **`auth.service.ts`** — `expiresIn` cast to `JwtSignOptions['expiresIn']` (jsonwebtoken@9 typing).
3. **root `package.json`** — `overrides.rxjs = 7.8.2` (single rxjs; NestJS-11 typing).

## 7. DI audit (the prior boot-defect class)

Searched every `import type` of a `*Service/*Guard/*Repository/*Publisher/*Executor/...`. All 9 hits
are **non-Nest-DI**: `useFactory`-provided helpers with explicit `inject:` (`selectAiProvider`,
`selectWebPushDispatcher`) or interface tokens (`InventoryStrategy`) — `import type` is correct there.
No erased type-only import on a Nest-DI constructor param. The InventoryLockService bug is already
fixed on main. **Confirmed by a real compiled-JS boot** (not just tests).

## 8. Route / middleware findings

Global prefix `api` intact. Correlation-id middleware runs on all routes (`x-correlation-id` verified
on a live request). Public payment/inventory webhooks + guest booking + health/metrics routes unchanged
— the Stripe webhook route returns 501-unsigned (reachable), **not** 404 (removed) or 401 (accidentally
protected). Guards (Maintenance→Throttler→JwtAuth→Roles) and `trust proxy` unchanged.

## 9. Verification matrix

| Gate                                                                                       | Result                                                                  |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| npm ci / install                                                                           | ✅ (no `--force`/`--legacy-peer-deps`)                                  |
| Full API suite                                                                             | ✅ **162 / 1180** (== baseline)                                         |
| API tsc / build                                                                            | ✅ 0 / ok                                                               |
| Worker tsc / build / **boot**                                                              | ✅ 0 / ok / **boots** (BullMQ + sweeps)                                 |
| **API boot** (compiled JS)                                                                 | ✅ "Nest application successfully started"; no legacy/driver warnings   |
| HTTP smoke                                                                                 | ✅ health/ready/metrics/compensation-health = 200; webhook route intact |
| Prisma validate / migrate status / **drift**                                               | ✅ valid / up-to-date / **0 drift**                                     |
| **Fresh-DB deploy** (all migrations from zero)                                             | ✅ applied clean                                                        |
| Real PostgreSQL + Redis concurrency, outbox, compensation, booking, refund, security tests | ✅ (in the 1180)                                                        |
| Prettier (whole repo)                                                                      | ✅ clean                                                                |
| Secret scan                                                                                | ✅ clean                                                                |

## 10. Security before → after

|          | Baseline | After  | Δ                                                         |
| -------- | -------- | ------ | --------------------------------------------------------- |
| Total    | 91       | **69** | −22                                                       |
| Critical | 2        | **2**  | 0 (next/vitest — not NestJS)                              |
| High     | 44       | 39     | −5 (multer runtime + cli/tmp/fork-ts/brace-expansion dev) |
| Moderate | 42       | 28     | −14                                                       |
| Low      | 3        | 0      | −3                                                        |

**Runtime advisory removed:** `multer` (the only genuine runtime high the NestJS family owned).
The rest are dev/build tooling. No new advisory introduced.

## 11. Performance smoke (local, non-production)

API boot ≈ 5 s to "successfully started"; full API suite ≈ 60 s (unchanged vs baseline); build
unchanged. No material regression. (Local numbers — not a production claim.)

## 12. Lockfile note

A full lockfile regeneration is **required** for a NestJS major in npm workspaces: incremental
installs / dedupe / targeted `overrides` all leave `@nestjs/*@10` leftovers or split the family
root↔apps/api → dual-package DI boot failures. The regen's non-NestJS drift is verified harmless —
customer-web/admin/organizer **browser bundles unchanged** (`next` 14.2.35, postcss 8.4.31); only
the NestJS cascade (`@angular-devkit` via schematics, `multer` 2, `dotenv` 17 via config,
swagger-ui-dist) + semver-safe transitive re-resolution. This is a legitimate major-upgrade regen,
not an `audit fix --force` sweep.

## 13. Rollback

`git revert` the upgrade commits (or reset the branch); `npm ci` restores NestJS 10. No migration or
schema change is involved (dependency-only). Feature flags untouched; money automation still OFF.

## 14. Recommendation: **GO** (for review + merge)

Every required correctness/security/boot/migration/public-contract gate passes; the NestJS family is
on one coherent v11 set; peers satisfied without force flags; API + worker boot; the runtime `multer`
high is removed. The 2 criticals are out of scope (next/vitest — later batches). **Next batch: Next.js.**
