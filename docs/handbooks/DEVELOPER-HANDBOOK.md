# ETicketsGo — Developer Handbook

> How to work in this repo: set up, run, test, and extend it safely. Every command
> and path here matches the repo as it stands. Companions:
> [Architecture Handbook](./ARCHITECTURE-HANDBOOK.md), [Runbooks](./RUNBOOKS.md).

---

## 1. Prerequisites

- **Node ≥ 20** (`package.json` `engines`), **npm 11** (`packageManager` pins
  `npm@11.11.0`; npm ≥ 10 works).
- **Docker** (for Postgres + Redis via Docker Compose).
- Git. On **Windows** use PowerShell or Git Bash — see the [Windows gotchas](#6-windows-gotchas-read-this).

---

## 2. First-time setup

```bash
cp .env.example .env          # local dev secrets (safe defaults)
docker compose up -d          # start Postgres (:5432) + Redis (:6379)
npm install                   # install all workspaces
npm run packages:build        # build shared-types, design-tokens, validation
npm run db:migrate            # apply Prisma migrations (creates the schema)
npm run db:seed               # seed users, orgs, events, bookings, tickets
npm run dev                   # start all apps + API in watch mode (Turbo)
```

`npm run packages:build` builds the shared packages the apps import
(`@eticketsgo/shared-types`, `@eticketsgo/design-tokens`, `@eticketsgo/validation`).
Run it before the first `dev`/`typecheck`, and again after changing a shared
package (see the Windows note).

### Docker Compose services

`docker-compose.yml` defines two services with healthchecks and named volumes:

| Service | Image                | Port   | Credentials (local only)                                |
| ------- | -------------------- | ------ | ------------------------------------------------------- |
| `db`    | `postgres:16-alpine` | `5432` | user `eticketsgo` / pass `eticketsgo` / db `eticketsgo` |
| `redis` | `redis:7-alpine`     | `6379` | —                                                       |

---

## 3. Environment variables

`.env.example` is the template — copy it to `.env`. The API validates a **subset**
of these at boot with a Zod schema (`apps/api/src/config/configuration.ts`) and
fails fast if a required one is missing.

### Validated by the API config schema

| Var                                    | Default / example                                                            | Notes                               |
| -------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------- |
| `NODE_ENV`                             | `development`                                                                | `development \| test \| production` |
| `API_PORT`                             | `4000`                                                                       |                                     |
| `API_GLOBAL_PREFIX`                    | `api`                                                                        | All routes are under `/api`.        |
| `CORS_ORIGINS`                         | `http://localhost:3000,http://localhost:3001,http://localhost:3002`          | comma list                          |
| `DATABASE_URL` (required)              | `postgresql://eticketsgo:eticketsgo@localhost:5432/eticketsgo?schema=public` | matches compose                     |
| `REDIS_URL`                            | `redis://localhost:6379`                                                     |                                     |
| `JWT_ACCESS_SECRET` (required)         | `dev-access-secret-change-me`                                                |                                     |
| `JWT_REFRESH_SECRET` (required)        | `dev-refresh-secret-change-me`                                               |                                     |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL`   | `900s` / `30d`                                                               |                                     |
| `QR_SIGNING_SECRET` (required)         | `dev-qr-signing-secret-change-me`                                            | signs QR tokens                     |
| `PAYMENT_PROVIDER`                     | `mock`                                                                       |                                     |
| `PAYMENT_WEBHOOK_SECRET` (required)    | `dev-webhook-secret-change-me`                                               | verifies signed webhooks            |
| `STORAGE_DRIVER` / `STORAGE_LOCAL_DIR` | `local` / `.storage`                                                         | S3 abstraction defaults local       |
| `NEXT_PUBLIC_API_URL`                  | `http://localhost:4000/api`                                                  | consumed by the web apps            |

### Read directly from `process.env` (NOT in the Zod schema)

These are read via `process.env` at the point of use, with the defaults shown. If
absent they fall back silently — they are not validated at boot.

| Var                                           | Read in                                     | Default   | Effect                                                                   |
| --------------------------------------------- | ------------------------------------------- | --------- | ------------------------------------------------------------------------ |
| `PAYMENTS_MOCK_ENABLED`                       | `apps/api/src/payments/payments.service.ts` | (enabled) | Mock-pay is allowed unless this is `false` **or** `NODE_ENV=production`. |
| `HOLD_EXPIRY_INTERVAL_MS`                     | `apps/worker/src/main.ts`                   | `60000`   | Interval of the `expire-holds` repeatable job.                           |
| `NOTIFICATION_SWEEP_INTERVAL_MS`              | `apps/worker/src/main.ts`                   | `30000`   | Interval of the `dispatch-notifications` sweep (non-numeric ⇒ 30000).    |
| `WORKER_PORT`                                 | `apps/worker/src/main.ts`                   | `4100`    | Worker health/readiness HTTP port.                                       |
| `FEATURE_<KEY>` / `NEXT_PUBLIC_FEATURE_<KEY>` | `packages/shared-types/src/features.ts`     | per flag  | Override a feature flag (`1`/`true`). See below.                         |

**Feature-flag env keys.** `<KEY>` is the upper-snake name from the `ENV_KEY` map,
not the camelCase flag: `SAVED_EVENTS`, `REVIEWS`, `ORGANIZER_PROFILES`,
`EVENT_FAQ`, `EXPERIENCE_DISCOVERY`, `COMMUNITY`, `MEMBERSHIPS`, `SUBSCRIPTIONS`,
`ORGANIZER_CRM`, `MARKETING_AUTOMATION`, `DYNAMIC_PRICING`, `WHITE_LABEL`,
`SPONSORS`, `EVENT_TEMPLATES`, `AI_RECOMMENDATIONS`. Example:
`FEATURE_AI_RECOMMENDATIONS=1`.

> The `turbo.json` `globalEnv` list (`NODE_ENV`, `DATABASE_URL`, `REDIS_URL`,
> `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `QR_SIGNING_SECRET`,
> `PAYMENT_WEBHOOK_SECRET`) is what invalidates Turbo's cache when changed.

---

## 4. Script catalog (root `package.json`)

| Command                  | Runs                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| `npm run build`          | `turbo run build` — build every workspace.                                   |
| `npm run dev`            | `turbo run dev` — all apps + API in watch mode (persistent).                 |
| `npm run lint`           | `turbo run lint` — ESLint (the web apps).                                    |
| `npm run typecheck`      | `turbo run typecheck` (`tsc --noEmit`), depends on `^build`.                 |
| `npm run test`           | `turbo run test --filter=!@eticketsgo/e2e` — Jest (API) + Vitest (packages). |
| `npm run e2e`            | `npm run test -w @eticketsgo/e2e` — Playwright (apps must be running).       |
| `npm run format`         | Prettier `--write` over `**/*.{ts,tsx,js,jsx,json,md}`.                      |
| `npm run format:check`   | Prettier `--check`.                                                          |
| `npm run deps:check`     | `madge --circular --extensions ts apps/api/src apps/worker/src` (CI gate).   |
| `npm run packages:build` | Build `shared-types`, `design-tokens`, `validation`.                         |
| `npm run db:generate`    | `prisma generate` (regenerate the client) in the API.                        |
| `npm run db:migrate`     | `prisma migrate dev` in the API (create + apply a migration).                |
| `npm run db:deploy`      | `prisma migrate deploy` (apply committed migrations, no prompts).            |
| `npm run db:seed`        | `ts-node prisma/seed.ts` in the API.                                         |
| `npm run db:reset`       | `prisma migrate reset --force` (drop → re-migrate → re-seed).                |

The `db:*` scripts delegate to `@eticketsgo/api` (`apps/api/package.json`).

---

## 5. Running apps and the worker

```bash
npm run dev -w @eticketsgo/api            # API           :4000  (Swagger /api/docs)
npm run dev -w @eticketsgo/customer-web   # Customer web  :3000
npm run dev -w @eticketsgo/organizer-web  # Organizer web :3001
npm run dev -w @eticketsgo/admin-web      # Admin web     :3002
npm run dev -w @eticketsgo/worker         # Worker (health :4100)
```

| Surface       | URL                              | Sign in as                          |
| ------------- | -------------------------------- | ----------------------------------- |
| API + Swagger | `http://localhost:4000/api/docs` | —                                   |
| Customer web  | `http://localhost:3000`          | `customer1@eticketsgo.test`         |
| Organizer web | `http://localhost:3001`          | `owner@eticketsgo.test` (prefilled) |
| Admin web     | `http://localhost:3002`          | `admin@eticketsgo.test` (prefilled) |

Probes: `GET /api/health` (liveness), `GET /api/ready` (Postgres + Redis). The
worker exposes the same at `:4100/health` and `:4100/ready`.

---

## 6. Windows gotchas (read this)

Two friction points bite on Windows specifically:

1. **Stale frontend chunks after a rebuild.** When a shared package or an app is
   rebuilt, a _running_ `next start` frontend keeps serving old JS chunks and
   pages go blank. **After any shared-package/app rebuild, restart the running
   Next.js frontends.** In `npm run dev` (watch mode) this is usually handled, but
   if you rebuilt `packages/*` or hit blank pages, stop and restart the affected
   `*-web` process. See the [Runbooks recovery recipe](./RUNBOOKS.md#recover-from-the-stale-frontend-blank-page-issue).
2. **Prisma engine file lock.** A running Node process (API or worker) holds the
   Prisma query-engine DLL open, so `prisma migrate` / `prisma generate` fail with
   an `EPERM`/rename error. **Stop the API and worker before running
   `db:migrate` / `db:generate` / `db:reset`,** then restart them.

---

## 7. Testing

- **Unit (Jest, API):** `npm run test -w @eticketsgo/api`. Covers fee calculation
  (tier boundaries, absorption modes, discounts, rounding), inventory strategies
  (GA + seat: reserve/confirm/release, oversell & double-book throws), pricing
  strategies/rules, coupon math, signed-webhook verify/tamper, QR sign/verify,
  refund eligibility, hold-expiry, notification channels/templates/preferences,
  discovery + recommendation strategies, ranking, and the registry mappings.
- **Unit (Vitest, packages):** shared validation schemas.
- **All units:** `npm run test` (excludes the e2e workspace).
- **E2E (Playwright):** `npm run e2e` — the apps must be running first
  (`npm run dev`). Covers the customer book→pay→QR, organizer create→submit, and
  admin review→refund→audit critical paths, plus a movie seat booking.

**Seed credentials** (local only): every seed account uses password
**`Password123!`** with emails on `@eticketsgo.test`:

| Role                | Email                       |
| ------------------- | --------------------------- |
| Admin / Super Admin | `admin@eticketsgo.test`     |
| Organizer Owner     | `owner@eticketsgo.test`     |
| Organizer Manager   | `manager@eticketsgo.test`   |
| Check-in Staff      | `checkin@eticketsgo.test`   |
| Customer            | `customer1@eticketsgo.test` |
| Customer            | `customer2@eticketsgo.test` |

---

## 8. Coding conventions

- **Strict TypeScript.** No implicit `any`; prefer explicit types on public
  service methods. `npm run typecheck` must stay green.
- **Zod validation.** Request shapes are validated with schemas from
  `@eticketsgo/validation`, shared by API and web. Add new input schemas there.
- **Error envelope.** Throw `AppException(ErrorCodes.X, message, httpStatus,
details?)` (`apps/api/src/common/errors.ts`). The global `AllExceptionsFilter`
  renders every error as `{ code, message, details, correlationId }`. Never leak
  raw errors.
- **Money is integer minor units.** Never use floats for money.
- **RBAC.** Global `JwtAuthGuard` + `RolesGuard`; opt a route out with `@Public()`,
  restrict with `@Roles(...)`. Tenant-scoped checks go through
  `OrgAccessService` (`assertMember`, `isPlatformAdmin`) — do not hand-roll org
  membership checks in a controller.
- **Transactions & seams.** Domain writes that must be atomic run in
  `prisma.$transaction`, and strategies receive that `tx`. Depend on the seam
  interface, never a concrete strategy.
- **No dead code.** New capabilities that aren't wired to a consumer go behind a
  feature flag (see ADR-015/017), not as empty classes.
- Run `npm run format` before committing.

---

## 9. Step-by-step recipes

Each recipe extends a seam; the pattern is always _implement the interface →
register it → (usually) map a discriminator_. No caller changes.

### 9.1 Add a new Experience type

Goal: make a new `ExperienceType` bookable end-to-end.

1. Add the enum value in `packages/shared-types/src/enums.ts` `ExperienceType`
   (e.g. `MUSEUM`) — it already exists as a value; the work is wiring its
   inventory + pricing.
2. Decide its inventory model and add/choose an `InventoryStrategyKind`
   (`GENERAL_ADMISSION | SEAT_BASED | CAPACITY | TIME_SLOT`).
3. Map the type → kind in `ExperienceTypeRegistry.inventoryKindByType`
   (`apps/api/src/experience/experience-type.registry.ts`). One line.
4. If the kind is new, implement its `InventoryStrategy` (§9.2) and register it in
   `InventoryService.byKind` + `InventoryModule` providers.
5. Pricing resolves via `PricingStrategiesService.forExperience` (`MOVIE → SEAT`,
   else `TIER`). If the new type needs a different base strategy, extend that
   `switch`.
6. Add any satellite tables/columns via an **additive** Prisma migration (nullable
   FKs, no drops), following ADR-011/012.

The booking and payment engines do not change — an unmapped type already fails
loudly with "Booking is not yet available for …".

### 9.2 Add an Inventory strategy

Files: `apps/api/src/inventory/`.

1. Create `my-model.strategy.ts` implementing `InventoryStrategy`
   (`inventory-strategy.interface.ts`): `reserve`, `confirm` (returns
   `TicketIssueSpec[]`), `release`, `refund`, `availability`, and a `kind`.
   `reserve/confirm/release/refund` receive the caller's `tx` — do all stock
   mutation inside it and make `reserve` atomic + oversell-proof (a single
   conditional `UPDATE`, then check the affected row count).
2. Add its `InventoryStrategyKind` in `packages/shared-types/src/enums.ts` if new.
3. Register it: add to `InventoryModule` providers and to `InventoryService.byKind`
   (`inventory.service.ts`).
4. Map an experience type to its kind in `ExperienceTypeRegistry`.
5. Unit-test the atomic hold (success + conflict throw), confirm/specs, release,
   refund, availability — mirror `general-admission.strategy.spec.ts` /
   `seat-based.strategy.spec.ts`.

### 9.3 Add a Pricing rule

Files: `apps/api/src/pricing/`.

1. Add the rule kind in `PricingRuleKind` (`enums.ts`).
2. Implement `PricingRule` (`pricing-strategy.interface.ts`) in `pricing-rules.ts`:
   `applies(ctx, line)` and `adjust(unitPriceMinor, ctx, line)` — pure, never
   negative (use `clampMinor`).
3. Activate it by returning it from `PricingStrategiesService.rulesFor(ctx)`
   (`pricing-strategies.service.ts`). **Note:** `rulesFor()` returns `[]` today so
   no live price changes; wiring a rule here (or the future per-experience pricing
   config) is what makes it active. Gate demand-based rules behind the
   `dynamicPricing` flag.
4. Unit-test `applies`/`adjust` per `pricing-strategies.spec.ts`. To add a whole
   new **base** strategy instead, implement `PricingStrategy`, add its
   `PricingStrategyKind`, and register in `PricingStrategiesService.byKind`.

### 9.4 Add a Notification channel

Files: `apps/api/src/notifications/channels/`.

1. Add the key to `ChannelKey` in `notification-channel.interface.ts`
   (`'email' | 'sms' | 'whatsapp' | 'push' | 'in_app' | …`).
2. Create `my.channel.ts` implementing `NotificationChannel` (`readonly key`,
   `deliver(msg: RenderedNotification)`). Start log-only; document where the real
   provider binds.
3. Register it in `NotificationChannelRegistry` constructor + `notifications.module.ts`
   providers.
4. Add templates for it as needed in `NotificationTemplateService`; preferences and
   the scheduled `dispatchDue` sweep already handle new keys generically. Callers
   opt a channel in via `send({ …, channels: ['my_channel'] })`; the default stays
   `['email']`.
5. Unit-test per `notification-channel.registry.spec.ts`.

### 9.5 Add a Discovery or Recommendation strategy

**Discovery** — `apps/api/src/discovery/strategies/`:

1. Create `my.strategy.ts` implementing `DiscoveryStrategy` (`readonly key`,
   `discover(ctx): Promise<DiscoverySection>`). Reuse existing public services /
   Prisma reads and the shared `ranking.ts` util; stay read-only.
2. Register it in `DiscoveryModule`: add to `providers` and to the
   `DISCOVERY_STRATEGIES` `useFactory` array (order = render order). Empty sections
   are dropped automatically by `DiscoverySectionsService`.

**Recommendation** — `apps/api/src/recommendations/strategies/`:

1. Create `my.recommendation-strategy.ts` implementing `RecommendationStrategy`
   (`readonly key`, `recommend(ctx): Promise<PublicEventCardLike[]>`). Return the
   existing card shape; exclude the seed; cap to `ctx.limit`.
2. Register it in `RecommendationsModule` (`providers` + the
   `RECOMMENDATION_STRATEGIES` factory). It becomes selectable via
   `GET /api/public/recommendations?strategy=<key>`; the default blend routes
   through the AI `RecommendationEngine` port.
3. Unit-test per `discovery-strategies.spec.ts` / `recommendation-strategies.spec.ts`.

---

## 10. After you change something

- Changed a **shared package** (`packages/*`)? Run `npm run packages:build`, and on
  Windows restart the running frontends (§6).
- Changed the **Prisma schema**? Stop API + worker, then `npm run db:migrate`
  (dev) — commit the generated migration.
- Before pushing: `npm run format`, `npm run lint`, `npm run typecheck`,
  `npm run test`, `npm run deps:check`. CI (`.github/workflows/ci.yml`) runs the
  same gates plus build + Playwright.
