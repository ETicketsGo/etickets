# ETicketsGo — Architecture Guide

A high-level map of the system. Detailed decisions live in [docs/adr/](../adr/).

## Shape

A **modular monolith** API plus focused frontends and a background worker, in a Turborepo /
npm-workspaces monorepo.

```
apps/
  api/            NestJS modular monolith (REST, /api prefix)
  worker/         BullMQ worker (holds expiry, notifications, finance recon, token prune)
  customer-web/   Next.js 14 App Router — attendees
  organizer-web/  Next.js 14 App Router — organizers
  admin-web/      Next.js 14 App Router — platform admins
  e2e/            Playwright end-to-end tests
packages/
  shared-types/   pure domain types + rules (framework-free, unit-tested)
  web-kit/         API client + shared React UI
  validation/      zod schemas
  design-tokens/   design system tokens
  config/          shared config
```

## Data & runtime

- **PostgreSQL** via **Prisma** — system of record. Money is **integer minor units**;
  migrations are **additive-only** (`prisma migrate deploy`).
- **Redis** — cache (fail-open), BullMQ queue, maintenance flag. Booking **seat holds are
  DB-backed** with lazy + swept expiry, so booking survives a Redis outage.
- **Worker** — idempotent repeatable jobs (bounded batches) with retry/backoff + failed-job
  retention.

## Key domains (API modules)

Auth (JWT access + rotating refresh, reuse detection) · Events/Sessions/Ticket-types ·
Inventory (atomic holds per experience strategy) · Bookings · **Payments** (runtime-configurable
multi-provider routing + circuit breaker + failover + secret-manager refs) · Refunds · Payouts/
Finance · Tickets/QR (rotating nonce, single-use atomic check-in) · **Offline gate check-in**
(signed device manifests, durable queue, controlled activation — flag-gated) · Wallet passes
(projection of a signed ticket, fail-closed) · **Experience Commerce** (add-ons + bundles,
add-on inventory with atomic holds, mixed orders — reuses the booking/fee engine) ·
Notifications (pluggable transports) · **Web Push** (browser subscriptions + provider-neutral
dispatcher, VAPID-gated placeholder) · **AI & Growth** (provider-neutral gateway disabled by
default: PII redaction, timeout/retry, usage telemetry, deterministic fallbacks; organizer
assistant + admin AI console) · Analytics/Reports · Admin/Ops/Audit · Observability (metrics,
health, Sentry/OTel).

## Cross-cutting

- **AuthZ** — global JWT + roles guard; live org-membership checks (`OrgAccessService`).
- **Validation** — zod DTOs (strip unknown keys); pagination capped at 100.
- **Errors** — normalized envelope (`AppException`/`ErrorCodes`/`AllExceptionsFilter`),
  correlation IDs, payment errors classified to HTTP.
- **Observability** — Prometheus metrics (API + worker), readiness gating DB+Redis, immutable
  audit, optional Sentry/OTel.
- **Security** — fail-closed production config guard, security headers, no secrets to the
  browser, SAQ-A payment posture (no card data stored).

## Design principles (enforced across the codebase)

Integer minor units · immutable fee snapshots · idempotent money transitions · server-authoritative
entry · additive-only migrations · production-safe defaults / fail closed · pure, unit-tested
domain rules in `shared-types` · reuse existing abstractions.

## Selected ADRs

See [docs/adr/](../adr/) — e.g. offline gate check-in (ADR-035), asymmetric QR signing
(ADR-036), payments/routing, inventory strategy, and more.
