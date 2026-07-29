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
| **CI Playwright e2e**                                                                      | ❌ **1 test fails** — `offline.spec.ts:22` (see §12a BLOCKER)           |

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

## 12a. BLOCKER — customer-web offline e2e regression (honest finding)

**One CI e2e test regresses because of this upgrade.** `apps/e2e/tests/offline.spec.ts:22` ("offline
wallet … without connectivity") fails at line 50 `expect(getByText(/Offline/)).toBeVisible()` — the
cached page shows "2 tickets" but the `navigator.onLine` "Offline" banner never appears.

**Definitive baseline comparison (this is NOT flaky):**

- On **main** (fresh CI build, PR #23) the test **PASSES** in 3.8 s.
- On this branch it **FAILS** (15 s timeout) across 4 CI runs.

**Root-cause mechanism:** the NestJS major **requires** a full lockfile regeneration (incremental /
dedupe / overrides all break NestJS hoisting → dual-package DI boot failures). That regen **relocates
the web apps' `next` from nested → hoisted**: main splits `next` (root 14.2.15 + nested 14.2.35 per web
app), the regen unifies it to a single hoisted 14.2.35 (same version, different layout). Building
`customer-web` fresh from the hoisted layout changes its service-worker/offline runtime enough to
regress the banner. (main's later CI _re-run_ passed only because it used a turbo-cached bundle built
from the nested layout — a fresh main build passes; a fresh branch build fails.)

**Why it can't be fixed within NestJS-family scope:** npm workspace hoisting for `next` is not
controllable via `overrides` (which pin versions, not location), and a surgical NestJS-only lockfile
is impossible (proven). The perturbation lands in an **unrelated app family** (Next.js web apps),
which an isolated NestJS batch must not disturb.

**Correction:** an earlier analysis (on the predecessor branch `sec-1/batch-a1-nestjs`, PR #24) claimed
this test was "flaky / decoupled." **That was wrong** and is retracted — the main-vs-branch fresh-build
comparison proves the upgrade causes it.

**Resolution options (for the reviewer):**

1. Coordinate the **Next.js batch (A2)** with A1 — both share the lockfile/hoisting, so upgrading Next
   and NestJS together lets the regen settle the web apps on a hoist-compatible Next version + test them.
2. Preserve the web-app lockfile subtree at main's nested layout via targeted lockfile handling (keeps
   the batch truly isolated), then re-run e2e.
3. Investigate customer-web's SW/`useOnline` sensitivity to Next hoisting and make it hoist-robust
   (separate customer-web change, not a NestJS dependency change).

## 12b. Lockfile note

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

## 14. Recommendation: **NO-GO (blocked)** — do not merge as-is

The **NestJS code upgrade is correct and complete**: coherent v11 family, peers satisfied without force
flags, API + worker boot, all 1180 unit tests + all API/DB/Redis/security gates pass, runtime `multer`
high removed, no public-contract change. **However**, the upgrade's _required_ full lockfile regen
relocates the web apps' `next` (nested → hoisted), which **regresses one customer-web offline e2e**
(§12a) — proven against a fresh main build, not flaky. Because the failure lands in an unrelated
(Next.js) app family and npm hoisting can't be controlled within NestJS scope, this **cannot be fixed
safely inside Batch A1**.

**Per SEC-1 policy ("do not open a misleading green PR; document the blocker"): main is left untouched;
the PR stays open, honestly marked BLOCKED, pending one of the §12a resolution options.** The strongest
path is to **fold this into a combined NestJS + Next.js step (A1+A2)** so the shared lockfile settles
the web apps on a hoist-compatible Next version and the e2e is verified green before merge.
