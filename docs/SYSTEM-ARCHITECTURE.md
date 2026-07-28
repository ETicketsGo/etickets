# SYSTEM-ARCHITECTURE (P6.12)

High-level map of ETicketsGo for operators. Deep design is in the ADRs (`docs/adr/`).

## Components

```
Clients (customer/organizer/admin web, mobile)
        │  HTTPS
        ▼
     API (NestJS modular monolith, ≥2 replicas, stateless)
        ├── PostgreSQL  ── authoritative: bookings, payments, refunds, workflow, compensation,
        │                  outbox, allocation accounting, provider checkpoints, audit
        ├── Redis       ── inventory locks (Lua+fencing), BullMQ queues, read cache  (env-namespaced)
        └── Payment providers (Stripe US, Razorpay IN) — server-selected by currency
     Worker (NestJS, ≥2 replicas)
        ├── BullMQ: hold expiry, inventory-sync, finance reconcile, token prune
        └── Outbox dispatcher (FOR UPDATE SKIP LOCKED, exactly-once, per-handler idempotency)
```

## Key invariants (enforced in code)

- **No oversell / double-booking** — Postgres guarded writes + optimistic versions + Redis fencing.
- **No double financial action** — intent-before-call, stable idempotency, guarded exactly-once finalize.
- **PostgreSQL is authoritative**; Redis is reconstructable; the outbox is durable in PG.
- **Money automation OFF by default**; production-forbidden by startup validation.

## Subsystems (ADR index)

Payments (Stripe Connect + Razorpay Route), inventory sourcing (ADR-037), domain event bus
(ADR-038), Redis locking (ADR-039), external sync (ADR-040), transactional outbox (ADR-041),
booking orchestration (ADR-042), compensation/void/refund (ADR-043).

## Environments

`APP_ENV ∈ LOCAL/DEV/QA/UAT/STAGING/PRODUCTION` — drives startup validation, payment-env
resolution, and Redis key namespacing (`etg:{env}:...`). Each environment has its own PG + Redis.

## Trust & data-flow notes

Provider + amount + currency are **server-derived** (client never selects). Webhooks are
signature-verified + idempotent. Admin is RBAC + tenant-scoped + audited. Telemetry is PII-free.
