# ETicketsGo

A global **event operating system** for customers, organizers, and administrators — covering the full
lifecycle: _discover → view → select ticket → book → pay → receive QR ticket → check in → analytics & payouts._

Built as a **modular monolith** in a Turborepo monorepo with strict TypeScript.

> **Status:** Feature-complete MVP. The backend (auth/RBAC, events, booking, payments, tickets/QR,
> check-in, refunds, payouts, reporting, audit) and **all three web apps** — customer, organizer, and
> admin — are implemented and verified end-to-end, along with a standalone hold-expiry **worker**,
> **Playwright** e2e for the critical flows, and a **CI** pipeline. See [Roadmap](#roadmap).

---

## Tech stack

| Layer      | Choice                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| Monorepo   | Turborepo + npm workspaces                                                |
| Backend    | NestJS 10, Prisma 5, PostgreSQL 16, REST + OpenAPI/Swagger                |
| Frontend   | Next.js (App Router), React, Tailwind CSS, shadcn/ui, TanStack Query, RHF |
| Validation | Zod (shared between API and web via `@eticketsgo/validation`)             |
| Infra      | Redis (holds/cache/queues), BullMQ, S3-compatible storage abstraction     |
| Auth       | Email/password, JWT access + rotating refresh tokens, RBAC                |
| Testing    | Jest (API units), Vitest (packages), Playwright (critical e2e)            |
| Local dev  | Docker Compose (Postgres + Redis)                                         |

---

## Repository structure

```
eticketsgo/
├─ apps/
│  ├─ api/            # NestJS modular-monolith API (Prisma, all domain modules)  ✅
│  ├─ worker/         # Background worker — scheduled hold/booking expiry (BullMQ) ✅
│  ├─ customer-web/   # Public + customer app (browse→book→pay→QR wallet)          ✅  :3000
│  ├─ organizer-web/  # Organizer console (events, orders, check-in, reports)      ✅  :3001
│  ├─ admin-web/      # Admin console (approvals, refunds, payouts, audit)         ✅  :3002
│  └─ e2e/            # Playwright critical-path tests                             ✅
├─ packages/
│  ├─ config/         # Shared tsconfig presets                        ✅
│  ├─ design-tokens/  # Semantic tokens (CSS vars) + Tailwind preset   ✅
│  ├─ shared-types/   # Enums + transport types (no runtime deps)      ✅
│  ├─ validation/     # Zod schemas shared by API and web              ✅
│  └─ web-kit/        # Shared client: API client, hooks, UI kit, shell ✅
├─ .github/workflows/ci.yml
├─ docker-compose.yml
├─ turbo.json
└─ .env.example
```

The API is a **modular monolith**: each domain (auth, users, pricing, events, bookings, …) is a NestJS
module inside a single deployable, not a separate service.

---

## Quick start

Prerequisites: Node ≥ 20, npm ≥ 10, Docker.

```bash
cp .env.example .env          # local dev secrets (safe defaults)
docker compose up -d          # start Postgres + Redis
npm install                   # install all workspaces
npm run packages:build        # build shared packages (shared-types, design-tokens, validation)
npm run db:migrate            # apply Prisma migrations
npm run db:seed               # seed users, events, bookings, tickets
npm run dev                   # start all apps (API :4000, customer :3000, organizer :3001, admin :3002)
```

### Apps & ports

| App           | URL                              | Sign in as                          |
| ------------- | -------------------------------- | ----------------------------------- |
| API + Swagger | `http://localhost:4000/api/docs` | —                                   |
| Customer web  | `http://localhost:3000`          | `customer1@eticketsgo.test`         |
| Organizer web | `http://localhost:3001`          | `owner@eticketsgo.test` (prefilled) |
| Admin web     | `http://localhost:3002`          | `admin@eticketsgo.test` (prefilled) |

All login pages are prefilled with a seed account (password `Password123!`), so each console is usable
immediately. Health: `GET /api/health` · Readiness (DB + Redis): `GET /api/ready`.

### Run individual apps

```bash
npm run dev -w @eticketsgo/api            # API           :4000
npm run dev -w @eticketsgo/customer-web   # Customer web  :3000
npm run dev -w @eticketsgo/organizer-web  # Organizer web :3001
npm run dev -w @eticketsgo/admin-web      # Admin web     :3002
npm run dev -w @eticketsgo/worker         # Hold-expiry worker (health :4100)
```

### Handy scripts (root)

| Command                | Action                                    |
| ---------------------- | ----------------------------------------- |
| `npm run dev`          | Run all apps in watch mode (Turbo)        |
| `npm run build`        | Build every workspace                     |
| `npm run typecheck`    | Type-check every workspace                |
| `npm run lint`         | ESLint the web apps                       |
| `npm run test`         | Run unit tests (Jest + Vitest)            |
| `npm run e2e`          | Run Playwright e2e (apps must be running) |
| `npm run format:check` | Prettier check                            |
| `npm run db:migrate`   | `prisma migrate dev` in the API           |
| `npm run db:seed`      | Seed the database                         |
| `npm run db:reset`     | Drop, re-migrate, and re-seed             |

---

## Seed login credentials (local only)

All seed accounts use the password **`Password123!`**.

| Role                | Email                       |
| ------------------- | --------------------------- |
| Admin / Super Admin | `admin@eticketsgo.test`     |
| Organizer Owner     | `owner@eticketsgo.test`     |
| Organizer Manager   | `manager@eticketsgo.test`   |
| Check-in Staff      | `checkin@eticketsgo.test`   |
| Customer            | `customer1@eticketsgo.test` |
| Customer            | `customer2@eticketsgo.test` |

> These credentials exist **only** in local seed data. Never reuse them in any shared environment.

---

## Documentation

In-depth docs live under [`docs/`](docs):

- [Architecture Handbook](docs/handbooks/ARCHITECTURE-HANDBOOK.md) — bounded
  contexts, layering, the strategy seams (inventory/pricing/notifications/discovery/
  recommendations/AI), atomicity guarantees, feature flags, and context/dependency
  diagrams.
- [Developer Handbook](docs/handbooks/DEVELOPER-HANDBOOK.md) — setup, env vars, the
  full script catalog, testing, conventions, and step-by-step "add a …" recipes.
- [Runbooks](docs/handbooks/RUNBOOKS.md) — operational task recipes (start/stop,
  migrate/seed/reset, worker jobs, feature-flag toggles, health probes).
- [Sequence Diagrams](docs/diagrams/SEQUENCE-DIAGRAMS.md) and
  [Context Map](docs/diagrams/CONTEXT-MAP.md) — Mermaid diagrams of the core flows
  and inter-context rules.
- [Architecture Decision Records](docs/adr) (ADR-009…023) and
  [engineering reports](docs/reports).

---

## Architecture notes

### Data model

Prisma models cover the full domain (`User`, `Organization`, `OrganizationMember`, `Venue`, `VenueArea`,
`Event`, `EventSession`, `TicketType`, `TicketInventory`, `Booking`, `BookingItem`, `Ticket`, `Payment`,
`PaymentAttempt`, `Refund`, `Coupon`, `CheckIn`, `Payout`, `Notification`, `AuditLog`, `IdempotencyRecord`,
`RefreshToken`, `FeeRule`). Tenant-owned records carry `organizationId`, timestamps, and a `status` enum.

- **Money** is stored as integer **minor units** (paise) to avoid floating-point drift.
- **Fee snapshots** are stored on each `Booking`, so historical bookings never change when fee rules change.
- **`TicketInventory`** is a dedicated row per ticket type (`quantityTotal/Sold/Held` + `version`) — the
  concurrency-safe source of truth for stock, enabling atomic, oversell-proof reservations.

### Authentication & RBAC

- Passwords hashed with bcrypt (cost 12).
- JWT **access** tokens (short-lived) + **refresh** tokens that are hashed at rest and **rotated** on every
  use (the used token is revoked and linked to its replacement).
- Roles: `CUSTOMER`, `ORGANIZER_OWNER`, `ORGANIZER_MANAGER`, `CHECKIN_STAFF`, `ADMIN`, `SUPER_ADMIN`.
  Enforced by a global `JwtAuthGuard` + `RolesGuard`; routes opt out with `@Public()` and restrict with
  `@Roles(...)`. Organization membership drives tenant-scoped authorization.

### Pricing / fees

Configurable, tiered platform fee rules (`FeeRule`), seeded with the India defaults:

| Subtotal  | Booking fee |
| --------- | ----------- |
| ₹0–₹199   | ₹5          |
| ₹200–₹499 | ₹10         |
| ₹500–₹999 | ₹15         |
| ₹1000+    | ₹20 (max)   |

Fee absorption modes: `CUSTOMER_PAYS`, `ORGANIZER_PAYS`, `SHARED`. The pure `calculateFees()` function is
unit-tested and reused for both live quotes and stored booking snapshots.

### Error format

Every error is returned as a consistent envelope with a machine-readable code and correlation id:

```json
{
  "code": "BOOKING_INVENTORY_UNAVAILABLE",
  "message": "The requested ticket quantity is no longer available.",
  "details": {},
  "correlationId": "…"
}
```

### Observability & security

- Correlation id middleware on every request (echoed in the `x-correlation-id` header).
- Structured logging via Nest `Logger`; 5xx logged with stack, 4xx logged with code.
- `helmet` secure headers, CORS allow-list, `@nestjs/throttler` rate limiting.
- Health (`/health`) and readiness (`/ready`, checks Postgres + Redis) probes.
- Secrets are loaded only from environment variables (validated at boot via Zod).

---

## API surface

Full interactive docs at `/api/docs`. Key groups (all implemented):

| Group           | Highlights                                                                            |
| --------------- | ------------------------------------------------------------------------------------- |
| `auth`          | register, login, refresh (rotation), logout, me                                       |
| `users`         | me, update profile, admin user search                                                 |
| `organizations` | register org, list mine, members, invite, `admin/organizers` review                   |
| `venues`        | create, list, get (org-scoped)                                                        |
| `events`        | create/update, sessions, `ticket-types`, submit, pause/resume                         |
| `public`        | `GET /public/events` (search by title/city/category/date), `GET /public/events/:slug` |
| `admin/events`  | list, review (approve/reject), status (pause/cancel)                                  |
| `bookings`      | create (atomic hold + idempotency-key), list, get, `:id/pay`                          |
| `payments`      | `:bookingId/mock-pay`, signed `webhook`                                               |
| `tickets`       | wallet (QR data-URLs), get                                                            |
| `checkins`      | scan (SUCCESS/DUPLICATE/INVALID/CANCELLED/WRONG_SESSION), reverse                     |
| `refunds`       | request, list, process; `admin/refunds` list                                          |
| `payouts`       | list, generate settlement; `admin/payouts` list, mark paid                            |
| `reports`       | `reports/events/:id` (organizer), `admin/dashboard`, `admin/audit`                    |
| `health`        | `/health` (liveness), `/ready` (DB + Redis)                                           |

---

## Testing

```bash
npm run test                                   # all unit tests
npm run test --workspace @eticketsgo/api       # API units (Jest) — fee calc, etc.
```

Milestone 1 ships unit tests for fee calculation (tier boundaries, absorption modes, discounts, rounding).
Inventory, hold expiry, booking confirmation, webhook idempotency, QR validation, duplicate check-in,
refund eligibility, and role permissions are tested as their features are built, plus Playwright e2e for
the critical customer/organizer/admin flows.

---

## Roadmap

- [x] **M1 — Foundation:** monorepo, config, design tokens, DB schema, auth, RBAC, seed
- [x] **M2 — Event management (API):** organizations, venues, events, sessions, ticket types, admin
      approval, public event browse/search API
- [x] **M3 — Booking & payments (API):** ticket selection, atomic inventory holds, fee calc, booking
      creation, idempotency, mock payment + signed webhook confirmation
- [x] **M4 — Tickets & check-in (API):** signed QR generation, ticket wallet, check-in with all result
      states, duplicate prevention, authorized reversal
- [x] **M5 — Refunds, payouts, reporting (API):** refund workflow + eligibility, organizer settlement,
      payout records, organizer report + admin dashboard + audit log
- [x] **Customer web app:** browse/search, event detail, ticket selection, transparent fees, mock
      payment, confirmation, QR ticket wallet — responsive & accessible
- [x] **Organizer console:** dashboard, events list, multi-step event wizard, event tabs (overview,
      edit, sessions, tickets, orders, attendees + CSV, reports), camera/manual **check-in** with all
      result states + reversal, payouts, team, settings
- [x] **Admin console:** dashboard, organizer review, event moderation, bookings, payments, refund
      workflow, payouts, users, audit log, fee settings
- [x] **Shared `web-kit`:** typed API client with refresh-token rotation, auth guards, UI kit (table,
      dialog, toast, pagination, metrics, status badges), responsive app shell
- [x] **Background worker:** BullMQ repeatable job releasing expired holds, health/readiness, graceful
      shutdown, structured logs
- [x] **Playwright e2e:** customer book→pay→QR, organizer create→submit, admin review→refunds→audit
- [x] **CI:** GitHub Actions — install, format check, lint, type-check, migrate + seed, unit tests,
      build, Playwright

### Tests

- **26 unit tests** (`npm run test`): fee calculation (tiers/absorption/discounts/rounding), signed
  webhook verify/tamper, QR sign/verify/tamper, refund eligibility, **hold-expiry** logic (Jest), and
  shared validation schemas (Vitest).
- **3 Playwright e2e** (`npm run e2e`) cover the customer, organizer, and admin critical paths.
- Inventory holds, oversell prevention, webhook idempotency, and all check-in states are also verified
  live against the running API + Postgres.

---

## Known MVP limitations

- Payments use a **mock provider** with a signed webhook; `Stripe`/`Razorpay` are stubbed extension points.
- Notifications are stored in the DB and logged locally; `SendGrid`/`Twilio`/`WhatsApp` are interfaces only.
- Camera QR scanning uses the browser **`BarcodeDetector`** API where available, with manual token entry
  and attendee search as fallbacks.
- **Fee-rule editing** from the admin UI needs a write endpoint (`PATCH /admin/fee-rules/:id`); the UI
  currently displays the seeded rules read-only and documents the missing endpoint.
- Storage abstraction defaults to a local driver.
- RBAC roles are modeled as enums (+ `OrganizationMember.role`) rather than a dynamic permissions table.

## Recommended next production steps

1. Implement a real payment provider (Stripe/Razorpay) behind the existing `PaymentProvider` interface.
2. Add a real email/SMS provider behind `NotificationService`; move storage to S3/MinIO.
3. Add fee-rule write endpoints + admin UI, and per-event payout scheduling.
4. Add DB-level `CHECK`/partial constraints for inventory invariants and per-tenant rate limits.
5. Expand Playwright coverage (refund end-to-end, check-in with a real QR token) and add load tests.
6. Containerize each app and add staged deploys on top of the existing CI.
