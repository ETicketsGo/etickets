# SEC-1 Batch A1 Retry v2 — NestJS 11 Runtime Family Upgrade

**Branch:** `chore/sec1-nestjs-runtime-remediation-v2`
**Base:** `main` @ `1570e6e` (after PR #26 merged)
**Scope:** NestJS runtime family only. No Next.js/React/Sentry/Firebase/Google/Vitest/build-tooling
majors. No product/behaviour changes beyond required NestJS 11 / Express 5 compatibility.
**Verdict:** **GO** (local gates green; standard CI must confirm on the PR).

---

## 1. Prerequisite (Stage 1)

PR #26 `fix: harden customer-web offline detection across backend upgrades` — **merged to `main`**
(merge commit `1570e6e`, individual commits preserved). This removes the sole blocker of the first
A1 attempt: the wallet no longer trusts a stale `navigator.onLine`, so an offline reload served by
NestJS 11 / Express 5 still shows the offline indicator. Prior attempts **PR #24 and PR #25 are
superseded** — their "flaky test" / "next hoisting" diagnoses were obsolete; the real cause was the
customer-web offline defect, now fixed on `main`.

## 2. Environment / baseline (Stages 2–3, updated main, NestJS 10 / Express 4.22.1)

- Node v24.14.1 · npm 11.11.0 · lockfileVersion 3 · main `1570e6e`.
- **Baseline GREEN:** API suite **162 suites / 1180 tests**; API+worker typecheck+build; compiled
  boot smoke (health/ready/orchestration/metrics 200, correlation-id present, XFF-proxy 200, payment
  webhook 400/exists, protected 401, public 200, worker boots); all three web builds (via PR #26 CI
  at identical tree) + typechecks; **offline E2E `--repeat-each=10 --retries=0` = 20/20**.

## 3. Dependency versions before → after (Stages 4–5)

| Package                                         | Before   | After                                 |
| ----------------------------------------------- | -------- | ------------------------------------- |
| @nestjs/common, core, platform-express, testing | ^10.4.4  | **^11.1.28**                          |
| @nestjs/config                                  | ^3.2.3   | **^4.0.4**                            |
| @nestjs/jwt                                     | ^10.2.0  | **^11.0.2**                           |
| @nestjs/passport                                | ^10.0.3  | **^11.0.5**                           |
| @nestjs/swagger                                 | ^7.4.2   | **^11.4.6**                           |
| @nestjs/throttler                               | ^6.2.1   | **^6.5.0** (major 6 spans Nest 10+11) |
| @nestjs/cli (dev)                               | ^10.4.5  | **^11.0.24**                          |
| @nestjs/schematics (dev)                        | ^10.1.4  | **^11.1.0**                           |
| @types/express (dev)                            | ^4.17.21 | **^5.0.6**                            |
| rxjs                                            | ^7.8.1   | **^7.8.2** (single runtime copy)      |
| express (transitive, runtime)                   | 4.22.1   | **5.2.1** (via platform-express@11)   |
| apps/worker @nestjs/common, core                | ^10.4.4  | **^11.1.28**                          |

**Deliberately unchanged** (not part of the Nest major; compatible with 10 & 11): `passport@0.7`,
`passport-jwt@4`, `class-validator@0.14`, `class-transformer@0.5`, `bullmq@5`, `ioredis`,
`reflect-metadata@0.2.2`, `@sentry/node@8`, `prisma@5`. No `@nestjs/bullmq|schedule|terminus|
mapped-types` present (project uses raw `bullmq` + a custom health controller).

No `--force`, no `--legacy-peer-deps`. No Next.js/React manifest changes.

## 4. Lockfile regeneration (Stage 6)

Surgical installs split the Nest DI runtime (two `@nestjs/core` copies → `ThrottlerGuard` could not
resolve `Reflector`) — proven in the earlier attempt — so a **clean regeneration is required**:
`rm -rf node_modules package-lock.json && npm install` (4m42s, no `--force`), then a reproducibility
proof `rm -rf node_modules && npm ci` (1m48s). Result:

- Single `@nestjs/core@11.1.28` and `@nestjs/common@11.1.28`; **no NestJS 10 remnants**; no peer errors.
- Runtime `express@5.2.1`; **runtime `rxjs@7.8.2` singleton**. `rxjs@7.8.1` remains only inside
  `@angular-devkit/*` + `@nestjs/schematics` (CLI build tooling, dev-only, exact-pinned by
  `@angular-devkit/core@19.2.27`, no runtime/app-type path) — acceptable, not forced.
- Lockfile 20670 → 20551 lines. **Next.js manifests unchanged**; apps still resolve `next@14.2.35`.

### Non-Nest lockfile drift (audited, not dismissed)

A full regen re-floats every `^` range to the latest in-range version. 424 non-Nest version moves,
categorised:

- **(a) dev-only CLI tooling** re-floated by `@nestjs/cli@11`: `@angular-devkit/*` 17→19,
  `@inquirer/*`, `rollup`, `turbo` 2.10.4→2.10.7, `webpack`, `typescript-eslint` 8.63→8.65,
  `@playwright/test` 1.61→1.62, `prettier` 3.9.5→3.9.6. Not shipped.
- **(b) Express 5 transitive chain** (intended by the upgrade): `accepts` 1→2, `raw-body` 2→3,
  `type-is` 1→2, `mime` 1→3, `negotiator` 0→1, `path-to-regexp`, `fresh`, `media-typer`,
  `merge-descriptors`, `range-parser`, `content-disposition`.
- **(c) `^`-range re-floats** on unrelated runtime deps within existing ranges (no manifest change):
  `@aws-sdk/*`, `@smithy/*`, `@tanstack/react-query` 5.101.2→.4, `axios` 1.18→1.19, `stripe`
  22.3.1→.2, `firebase-admin` 14.1→14.2, `bullmq` 5.80→5.81, `google-*`, `razorpay` 2.9.6→.8.
- **Notable majors:** `dotenv` 16→17 + `dotenv-expand` 10→12 (pulled by `@nestjs/config@4`, expected);
  `resolve`→2.0.0-next.7 (dev-only). Security impact: net advisory reduction (§8). All behaviour is
  covered by the full backend + frontend + E2E gates below.

## 5. Compatibility fixes (Stage 7)

Only two source changes were needed (the clean single-family tree removed the earlier
duplicate-`@nestjs/common` structural type errors entirely):

1. **Express 5 wildcard** — `apps/api/src/app.module.ts`: `CorrelationIdMiddleware.forRoutes('*')`
   → `forRoutes('{*path}')`. `*` is no longer a valid `path-to-regexp` v8 token; the named wildcard
   matches all routes identically. Boot no longer emits the `LegacyRouteConverter` warning.
2. **JWT typing** — `apps/api/src/auth/auth.service.ts`: `expiresIn` cast to
   `JwtSignOptions['expiresIn']` (`@nestjs/jwt@11` types it as `ms`' `StringValue` union). TTL source
   and runtime behaviour unchanged; no weakening of token-expiry validation.
3. **RxJS singleton** — no code change; single runtime `7.8.2` achieved via the manifest bump + regen.

## 6. DI + middleware/route audit (Stages 8–9)

- **Constructor-injection `import type` scan:** 4 candidates, **all safe** — `PaymentProvider` is an
  _interface_ injected via the `PAYMENT_PROVIDER` token (controller) or used only as a return-type
  annotation (settlement/resolver); `TicketShareableResource` is a manually-constructed adapter (not
  `@Injectable`), so `import type { QrService }` is a param annotation only. No unsafe runtime-DI
  type-only import. No `forwardRef` added. **Circular-dependency check: none** (702 files).
- **Middleware/route behaviour, NestJS 11 boot vs NestJS 10 baseline — IDENTICAL:** health/ready/
  booking-orchestration/metrics all 200; correlation-id header present; real-IP-behind-proxy (XFF)
  200; payment webhook route exists (400 on bad body); inventory webhook 404 (flag-gated off by
  default — same before/after); protected `/api/tickets` 401; public `/api/public/events` 200;
  parameterised webhook path resolves. **No route path changed.**

## 7. Boot + backend verification (Stages 10–11, NestJS 11 / Express 5.2.1)

- **API compiled boot:** "Nest application successfully started", no route-converter warning, no DI
  errors.
- **Worker compiled boot:** "worker started" (port 4100), startup sweep released holds; graceful.
- **Full API suite: 162 suites / 1180 tests pass, 0 skipped** (32.4s) — includes real-PostgreSQL
  allocation/provider/compensation concurrency, real-Redis seat & quantity locks, outbox, inventory
  sync, payment webhook, booking orchestration, refund, compensation, security, tenant-isolation,
  admin RBAC.
- `prisma validate` ✓ · `migrate status`: 39 migrations, up to date, **no drift**.

## 8. Security before → after (Stage 14)

| Scope           | Before             | After                  | Δ   |
| --------------- | ------------------ | ---------------------- | --- |
| All (incl. dev) | 91 (C2 H44 M42 L3) | **69 (C2 H39 M28 L0)** | −22 |
| Production only | 56 (C0 H23 M33 L0) | **44 (C0 H19 M25 L0)** | −12 |

- **Criticals unchanged at 2 = `next` (web SSR) + `vitest` (dev)** — neither is NestJS-family; both
  out of A1 scope (Batch A2 / B). **NestJS family owned no critical.**
- **~5 highs removed**, including the runtime **Multer DoS chain** carried by
  `@nestjs/platform-express@10`, resolved by `platform-express@11` / `express@5`. Verified by the
  count delta + a targeted nest/express advisory scan (not assumed).
- Remaining nest-adjacent: `@nestjs/cli` (high, **dev-only**), `@nestjs/swagger` (high, already latest
  v11 — transitive `swagger-ui-dist`), `@opentelemetry/instrumentation-express` (moderate). **No new
  runtime advisory introduced.**

## 9. Performance smoke (Stage 15 — indicative, not a production claim)

- API full test suite: 45.5s (baseline) → 32.4s (upgraded) — faster, within run variance.
- API compiled boot to "listening" < 1s both; worker boot immediate both.
- Web production build times comparable ("Compiled successfully" all three). No material regression.

## 10. Frontend regression (Stage 12)

Next.js **unchanged at 14.2.35** across customer/admin/organizer. web-kit typecheck + connectivity
unit tests **21/21**. All three apps typecheck and **build (production) successfully** on the
regenerated tree.

## 11. Offline / PWA proof (Stage 13, against NestJS 11 / Express 5.2.1)

Fresh customer-web production build; fresh browser contexts; `--retries=0`; no sleeps added; no
assertion weakened. Paced under the API's 120-req/min global throttle so the only variable is offline
determinism (unpaced bursts trip HTTP 429, which the merged fix renders as "Sync failed", never a
false "Offline"). Because each rep books 2 tickets, the finite seeded event inventory is replenished
(`db:seed`) before each batch so a sold-out event cannot masquerade as a failure.

- **Offline `cached pass` E2E: 54/54 reps, 0 failures** _(re-seeded paced 9×6)_ — **0 offline-assert
  failures** across all batches.
- **CI-equivalent `offline.spec.ts --repeat-each=10 --retries=0` (full spec, 20 executions): 20/20**
  — matches the NestJS 10 baseline (§2) exactly.
- **Full Playwright E2E suite (all specs, all 4 servers, NestJS 11): 10 passed, 13 skipped, 0
  failed** (exit 0). The customer wallet `offline.spec.ts` (both tests), `organizer.spec.ts`, and
  `wallet-passes` (unavailable-path) all pass. **Skips are pre-existing and flag-gated, NOT caused by
  this upgrade:** the 13 skipped specs are the staff offline **check-in** gate/device/command-center/
  reconciliation/pilot/preflight/queue suites, each guarded by
  `test.skip(!flagOn, 'Offline check-in feature flag is disabled')` — the feature flag is off by
  default, so they skip identically on the NestJS 10 baseline. (Distinct from the customer wallet
  offline feature, which is fully exercised above.)
- Browser note: the regen floated `@playwright/test` 1.61→1.62 (dev), needing chromium build 1234
  (`npx playwright install chromium`).

> **Honest finding — an early unpaced 54× run failed batches 5–9 at the _booking_ step
> (`select[aria-label="Quantity"]` timeout), NOT the offline assertion (offline-assert-fails = 0).**
> Root cause: 24 prior reps × 2 tickets drained the seeded event's capacity → sold out → no quantity
> selector. Confirmed by re-seed → pass. This is test-data exhaustion, not a NestJS 11 / Express 5 or
> offline-detection regression. The re-seeded run above is the valid proof.

Offline reload shows the offline/degraded user-visible state; online recovery clears it. **The
previously-blocking gate now passes against NestJS 11.**

## 12. Rollback

Revert the branch / PR: `git revert` the merge, or restore `apps/api/package.json`,
`apps/worker/package.json`, `package-lock.json`, `apps/api/src/app.module.ts`,
`apps/api/src/auth/auth.service.ts` to `1570e6e` and run `npm ci`. No DB migration was added, so no
schema rollback is required. The prerequisite offline fix (PR #26) stays on `main` regardless.

## 13. Remaining risks / limitations

- Standard PR CI (GitHub Actions, Linux) must re-confirm all gates — local proof is Windows/Node 24.
- 2 criticals (`next`, `vitest`) remain — separate batches; `next` must precede public web launch.
- Inventory-sync webhook stayed flag-gated off in these runs (unchanged by this upgrade).
- `resolve@2.0.0-next.7` pre-release is present dev-only via tooling; watch on the next regen.

## 14. Recommendation

**GO** to open the replacement PR and let CI verify; **do not auto-merge**. After A1 merges,
re-assess the advisory graph and select the next isolated runtime family by actual remaining
production exposure (candidate: `@sentry/node` →10, or `next` for the web launch), each in its own PR.
