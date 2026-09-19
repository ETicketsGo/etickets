# Start here — ETicketsGo for new developers and QA

> Your first read. What the product is, what it's built with, how to run it, and how we
> test it. Everything here matches the repo as it stands on **16 September 2026**.
> Deeper material: [Developer Handbook](handbooks/DEVELOPER-HANDBOOK.md) ·
> [Architecture Handbook](handbooks/ARCHITECTURE-HANDBOOK.md) · [docs index](README.md).

---

## 1. What we are building

ETicketsGo sells tickets — for events (concerts, comedy, conferences) and for **cinema
screenings**, which is where the India pilot is aimed.

One sentence per person who uses it:

- **A customer** finds something on, picks a seat or a quantity, pays, and gets a QR ticket
  on their phone.
- **An organizer** (a promoter, or a cinema chain) creates the event, schedules shows,
  prices them, scans people in at the door, and gets paid.
- **An admin** (us) approves organizers and events, handles refunds and payouts, and can
  audit anything that happened.

The whole lifecycle in one line:

```
discover → choose seats/tickets → hold → pay → QR ticket → check in → refunds & payouts
```

Two properties drive most of the design decisions:

1. **We take real money.** Money is never a float, a payment is never charged twice, and a
   seat is never sold twice. Much of the code that looks defensive is defending one of those.
2. **We sell in more than one country.** Currency follows the venue, not the visitor. India
   uses Razorpay and INR with GST; the US uses Stripe and USD. The storefront speaks English
   and Canadian French.

---

## 2. The repo at a glance

A **Turborepo + npm workspaces** monorepo. The API is a **modular monolith**: every domain
is a NestJS module inside one deployable, not a separate service.

| Workspace                | What it is                                                 | Port   |
| ------------------------ | ---------------------------------------------------------- | ------ |
| `apps/api`               | NestJS API — all domain modules, Prisma, REST + Swagger    | `4000` |
| `apps/worker`            | Background jobs (BullMQ): hold expiry, notifications, sync | `4100` |
| `apps/customer-web`      | Storefront: browse → seats → pay → ticket wallet           | `3000` |
| `apps/organizer-web`     | Organizer console: events, shows, pricing, check-in, money | `3001` |
| `apps/admin-web`         | Admin console: approvals, refunds, payouts, audit          | `3002` |
| `apps/customer-mobile`   | Expo app for customers                                     | —      |
| `apps/e2e`               | Playwright suite that drives the real apps                 | —      |
| `packages/shared-types`  | Enums and transport types, no runtime dependencies         | —      |
| `packages/validation`    | Zod schemas shared by API and web                          | —      |
| `packages/web-kit`       | API client, hooks, UI kit, app shell — used by all 3 webs  | —      |
| `packages/design-tokens` | Semantic colour/spacing tokens + Tailwind preset           | —      |
| `packages/i18n`          | Message catalogue (`en`, `fr-CA`) for web, email, receipts | —      |
| `packages/config`        | Shared TypeScript configs                                  | —      |

API docs while it runs: `http://localhost:4000/api/docs`. Liveness `GET /api/health`,
readiness (checks Postgres and Redis) `GET /api/ready`.

---

## 3. Tech stack

Versions below are the ones in the lockfile today, not aspirations.

| Layer          | What we use                                                             |
| -------------- | ----------------------------------------------------------------------- |
| Language       | TypeScript 5.6, strict. Node ≥ 20, npm 11                               |
| Monorepo       | Turborepo 2, npm workspaces                                             |
| API            | NestJS 11 on Express 5, REST, OpenAPI/Swagger                           |
| Database       | PostgreSQL 16 via Prisma 5 (migrations in `apps/api/prisma/migrations`) |
| Cache / queues | Redis 7, BullMQ 5, ioredis 5                                            |
| Web            | Next.js 15 (App Router), React 18, Tailwind CSS 3, TanStack Query 5     |
| i18n           | next-intl 4 + `@eticketsgo/i18n` — `en` and `fr-CA`                     |
| Mobile         | Expo 56, React 19                                                       |
| Validation     | Zod 3, shared between API and web                                       |
| Auth           | JWT access + rotating refresh tokens, bcrypt, RBAC; phone OTP sign-in   |
| Payments       | Razorpay 2.9 (India/INR), Stripe 22 (US/USD), mock provider locally     |
| Messaging      | Twilio (SMS), AWS SES + SNS (email), Firebase Admin (push)              |
| Monitoring     | Sentry 10, correlation ids, structured logs, `/health` + `/ready`       |
| Tests          | Jest 29 (API), Vitest 4 (packages and web), Playwright 1.48 (e2e)       |
| CI/CD          | GitHub Actions → Railway (QA, UAT, Production)                          |
| Local infra    | Docker Compose: `postgres:16-alpine`, `redis:7-alpine`                  |

**How a booking request flows**

```
customer-web ──► API (NestJS)
                  ├─ PostgreSQL   authoritative: bookings, payments, refunds, audit
                  ├─ Redis        seat locks, queues, short-lived read cache
                  └─ Razorpay / Stripe   chosen by the SERVER from the venue's currency
worker ──────────► BullMQ jobs: expire holds, dispatch notifications, reconcile
```

The client never picks the payment provider, the amount, or the currency. The server
derives all three.

---

## 4. The words we use

Getting these wrong causes real bugs, so learn them early.

| Term               | Means                                                                             |
| ------------------ | --------------------------------------------------------------------------------- |
| **Event**          | The thing being sold — a film, a concert, a comedy night                          |
| **Event session**  | One dated occurrence of it. For cinema, one **show** (`/shows/:sessionId`)        |
| **Ticket type**    | A priced category for non-seated sales ("Early bird", "VIP")                      |
| **Section**        | A physical block of a room — "Balcony", "Lower stand"                             |
| **Seat category**  | A **price tier** — "Premium", "Recliner". Not the same thing as a section         |
| **Hold**           | A short reservation taken while someone pays, released by the worker if abandoned |
| **Booking**        | The order. **Ticket** — one admission with its own QR, issued once paid           |
| **Organization**   | The organizer's tenant. Everything they own carries its `organizationId`          |
| **Venue / cinema** | Where it happens. A cinema has **screens**; a venue has rooms and sections        |

> **Section vs category** caused a customer-visible bug in September 2026: seats chosen
> under "BALCONY" were listed as "Premium" in the basket. When you show a seat to a human,
> name the block; add the price tier only when it differs.

---

## 5. Your first hour

Prerequisites: Node ≥ 20, npm, Docker, Git. On Windows use PowerShell or Git Bash.

```bash
cp .env.example .env          # safe local defaults
docker compose up -d          # Postgres :5432 + Redis :6379
npm install
npm run packages:build        # build shared packages FIRST
npm run db:migrate            # create the schema
APP_ENV=LOCAL npm run db:seed # users, orgs, events, bookings
npm run db:seed:india-cinema  # cinema pricing policy rows (not part of the demo seed)
npm run dev                   # everything in watch mode
```

Then sign in to any console — the login pages are prefilled with a seed account. All seed
accounts share one local-only password, listed in the
[root README](../README.md#seed-login-credentials-local-only). **They exist only in local
seed data; never reuse them anywhere shared.**

Three things that will bite you on day one:

- **`APP_ENV` is not `NODE_ENV`.** QA and UAT both run with `NODE_ENV=production`, so any
  environment-specific guard keys on `APP_ENV` (`LOCAL/DEV/QA/UAT/STAGING/PRODUCTION`). The
  destructive seed refuses to run unless `APP_ENV` says where it is.
- **Rebuilt a shared package? Restart the web app.** Next.js keeps the old copy otherwise,
  and you get a blank page.
- **Stop the API and worker before `db:migrate` or `db:generate`.** A running process holds
  the Prisma engine file open and the command fails with a permissions error.

---

## 6. How we test

| Level                     | Tool       | Command                              | Size today                          |
| ------------------------- | ---------- | ------------------------------------ | ----------------------------------- |
| API units and integration | Jest       | `npm run test -w @eticketsgo/api`    | 339 suites, 3,685 tests             |
| Shared packages and web   | Vitest     | `npm run test`                       | web-kit 416, validation 50, i18n 23 |
| End to end                | Playwright | `npm run e2e` (apps must be running) | 371 tests                           |
| Everything CI runs        | —          | `npm run verify`                     | the local gate                      |

`npm run verify` = format check → lint → type-check → circular-dependency check → deploy
config check → unit tests → build. If that is green, CI usually is too.

**For QA specifically**

- E2E drives the **real apps against a real database**. Start them first (`npm run dev`, or
  build and `npm run start` in each app), then run the suite from `apps/e2e`.
- A full run reports roughly **325 passed and 46 skipped**. The skips are deliberate:
  `qa-*.spec.ts` only run against a deployed environment with `QA_VALIDATE=1`, the offline
  check-in specs sit behind feature flags, and a few specs skip when the seed lacks the data
  they need (for example, a film showing in more than one format).
- The suite is one IP standing in for many users, so test runs raise
  `AUTH_THROTTLE_LIMIT` and `ORG_REGISTRATION_THROTTLE_LIMIT`. Unexplained 429s usually mean
  those weren't set.
- **`npm run test` wipes the local seed.** Re-seed before running e2e again.
- Playwright's HTML report lands in `apps/e2e/playwright-report`; failures also save a
  screenshot, which is usually enough to see what broke.
- Write specs as promises to a user ("the basket names the block the seats are in"), not as
  descriptions of the code. Before trusting a new test, break the code on purpose and watch
  it fail — a test that passes against broken code is worse than no test.

---

## 7. Environments and how code ships

| Environment | Branch       | Deploys                                          |
| ----------- | ------------ | ------------------------------------------------ |
| Local       | anything     | you                                              |
| QA          | `develop`    | automatic on push                                |
| UAT         | `release/**` | automatic on push                                |
| Production  | `main`       | **manual dispatch only**, plus a repository flag |

Every deployment runs the full CI gate first, so what reaches an environment is exactly what
passed. Each environment has its own Postgres and Redis; Redis keys are namespaced per
environment. A green deploy proves nothing on its own — we verify the deployed commit and
then probe real behaviour.

---

## 8. House rules that bite

- **Money is integer minor units** (paise, cents). Never a float.
- **Currency follows the venue**, never the visitor. A cart mixing currencies is refused.
- **Every error is an envelope**: `{ code, message, details, correlationId }`. Throw
  `AppException(ErrorCodes.X, …)`; never leak a raw error.
- **RBAC through the guards.** Global `JwtAuthGuard` + `RolesGuard`; `@Public()` to opt out,
  `@Roles(...)` to restrict, and `OrgAccessService` for tenant checks — don't hand-roll
  membership checks in a controller.
- **Both languages or neither.** The i18n catalogue test fails if `en` and `fr-CA` don't
  carry the same keys and placeholders. `packages/i18n` is consumed built — rebuild it after
  editing messages.
- **Never commit secrets**, never print credential values in logs, and never point a
  destructive script at a shared database.

---

## 9. Where to read next

- [Developer Handbook](handbooks/DEVELOPER-HANDBOOK.md) — env vars, every script, recipes
  for adding a strategy, rule or experience type.
- [Architecture Handbook](handbooks/ARCHITECTURE-HANDBOOK.md) — bounded contexts, seams,
  atomicity guarantees.
- [System architecture](SYSTEM-ARCHITECTURE.md) — the operator's one-page map.
- [Sequence diagrams](diagrams/SEQUENCE-DIAGRAMS.md) — the core flows drawn out.
- [Architecture decision records](adr) — why things are the way they are.
- [docs index](README.md) — everything else, by area.
