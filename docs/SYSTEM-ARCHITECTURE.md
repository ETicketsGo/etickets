# SYSTEM-ARCHITECTURE (P6.12)

High-level map of ETicketsGo for operators. Deep design is in the ADRs (`docs/adr/`).

> **2026-11-01:** the full as-built reference is [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md)
> (C4 diagrams, module map, queues, cross-cutting mechanisms), with
> [DATA-MODEL](architecture/DATA-MODEL.md), [FLOWS](architecture/FLOWS.md) and
> [DEPLOYMENT-GUIDE](DEPLOYMENT-GUIDE.md). This page is the one-screen summary.

## Components

```
Clients (customer/organizer/admin web on Next.js 15, Android app on Expo)
        │  HTTPS
        ▼
     API (NestJS 11 modular monolith, stateless; config-as-code sets 1 replica)
        ├── PostgreSQL  ── authoritative: bookings, payments, refunds, workflow, compensation,
        │                  outbox, allocation accounting, provider checkpoints, audit
        ├── Redis       ── inventory locks (Lua+fencing), BullMQ queues, read cache  (env-namespaced)
        ├── Payment providers (Stripe USD/CAD, Razorpay INR) — server-selected by currency
        └── Messaging (SES + SNS email, MSG91 India SMS, Twilio US/CA SMS)
     Worker (BullMQ, one process per environment)
        ├── queue holds: hold expiry, notifications, webhooks, refunds, finance, payout ledger,
        │   billing sweep, token prune, outbox dispatch (flag-gated)
        ├── queue campaigns: organizer email campaigns (own rate limit)
        └── queue inventory-sync-events: external inventory events (flag-gated)
```

## Key invariants (enforced in code)

- **No oversell / double-booking** — Postgres guarded writes + optimistic versions + Redis fencing.
- **No double financial action** — intent-before-call, stable idempotency, guarded exactly-once finalize.
- **PostgreSQL is authoritative**; Redis is reconstructable; the outbox is durable in PG.
- **Money automation OFF by default**; production-forbidden by startup validation.

## Subsystems (ADR index)

Payments (Stripe Connect + Razorpay Route), inventory sourcing (ADR-037), domain event bus
(ADR-038), Redis locking (ADR-039), external sync (ADR-040), transactional outbox (ADR-041),
booking orchestration (ADR-042), compensation/void/refund (ADR-043). Outbox, Redis locks,
orchestration and external sync are built but off or in shadow mode by default.

## Environments

`APP_ENV ∈ LOCAL/DEV/QA/UAT/STAGING/PRODUCTION` — drives startup validation, payment-env
resolution, and Redis key namespacing (`etg:{env}:...`). Each environment has its own PG + Redis.

## Trust & data-flow notes

Provider + amount + currency are **server-derived** (client never selects). Webhooks are
signature-verified + idempotent. Admin is RBAC + tenant-scoped + audited. Telemetry is PII-free.
