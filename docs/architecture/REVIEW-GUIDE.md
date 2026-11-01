# ETicketsGo: Architecture Review Guide

Status: written 2026-11-01 for an independent solution-architecture review of `main` at
`d5144d3f`.

## 1. Reading order

1. [ARCHITECTURE](ARCHITECTURE.md): context and container diagrams, API module map,
   cross-cutting mechanisms, configuration gates.
2. [DATA-MODEL](DATA-MODEL.md): 139 models by domain, key state machines.
3. [FLOWS](FLOWS.md): eight sequence diagrams traced from code (purchase, refund and R1,
   fee schedule publish, subscription billing, phone OTP, transactional messages, campaigns,
   payouts).
4. [DEPLOYMENT-GUIDE](../DEPLOYMENT-GUIDE.md): Railway topology, deploy procedure, backups,
   flag table, security controls.
5. Decisions: [ADR-STATUS](../adr/ADR-STATUS.md) and the ADRs in `docs/adr/`. Each ADR has a
   one-line status note dated 2026-11-01.
6. Current product and production state: [PRODUCT-CURRENT-STATE](../PRODUCT-CURRENT-STATE.md)
   and [release/LAUNCH-READINESS-CHECKLIST](../release/LAUNCH-READINESS-CHECKLIST.md).
7. Deeper material, if needed: [BOOKING-STATE-TRANSITION-MATRIX](BOOKING-STATE-TRANSITION-MATRIX.md),
   [BOOKING-COMPENSATION-MATRIX](BOOKING-COMPENSATION-MATRIX.md),
   [EVENT-CATALOGUE](EVENT-CATALOGUE.md), [SECURITY-HANDBOOK](../SECURITY-HANDBOOK.md),
   [handbooks/ARCHITECTURE-HANDBOOK](../handbooks/ARCHITECTURE-HANDBOOK.md) (layering and
   strategy seams).

## 2. Where the source of truth lives

| Question                             | Source of truth                                                                                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data model                           | `apps/api/prisma/schema.prisma` and `apps/api/prisma/migrations/`                                                                                                                                         |
| Configuration, defaults, boot checks | `apps/api/src/config/configuration.ts` (plus `PAYOUT_EXECUTION_ENABLED` in `apps/api/src/payments/settlement/settlement.service.ts`)                                                                      |
| Modules and global guards            | `apps/api/src/app.module.ts`                                                                                                                                                                              |
| Background jobs and queues           | `apps/worker/src/main.ts`                                                                                                                                                                                 |
| Admin permissions                    | `packages/shared-types/src/admin-permissions.ts`                                                                                                                                                          |
| Provider routing for ticket payments | `packages/shared-types/src/marketplace.ts` (`CURRENCY_PROVIDERS`)                                                                                                                                         |
| State transition tables              | `marketplace.ts` (settlement), `settlement-reversal.ts`, `bookings/compensation/compensation-state.ts`, `bookings/orchestration/booking-workflow.transitions.ts`, `billing/subscription-state-machine.ts` |
| Railway services                     | `deploy/railway/*.railway.json`, `railway.json`                                                                                                                                                           |
| CI and deploy pipelines              | `.github/workflows/` (`ci.yml`, `security.yml`, `deploy-railway.yml`, `deploy.yml`, `mobile-ci.yml`, `uptime.yml`)                                                                                        |
| Live production flags and commits    | Railway variables (not in the repository); summarized in PRODUCT-CURRENT-STATE                                                                                                                            |

When a document and the code disagree, the code wins. Please report the document.

## 3. Known risks, limitations and open decisions

| Area                  | Item                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime               | Node 20 (`.nvmrc`, Dockerfiles). Node 20 left upstream support in April 2026. The move to Node 22 must land before January 2027.                                        |
| Hosting               | One Railway region and one PostgreSQL instance per environment. No read replica, no multi-region failover. RTO and RPO are in `deployment/RAILWAY_BACKUP_RECOVERY.md`.  |
| Replicas              | Every config-as-code file sets `numReplicas: 1`. The production replica count is not in the repository.                                                                 |
| Backups               | Nightly dump on the Railway volume. The off-platform copy is off until its bucket is configured (`ops/OFFSITE-BACKUP.md`).                                              |
| Tenancy               | Organization scoping is enforced in service code (`OrgAccessService`), not by row-level security.                                                                       |
| Audit                 | `AuditLog` is append-only by convention only. `record()` swallows write failures by design.                                                                             |
| Referential integrity | Several newer tables hold ids without a foreign key ("logical ref, no FK" in DATA-MODEL).                                                                               |
| Event delivery        | The outbox, Redis seat locks, booking orchestrator and external inventory sync are built but default off or shadow.                                                     |
| Tax and GST           | Tax comes from the `TaxRule` table (`TAX_PROVIDER=manual`). India GST rules ship inactive; activation raises buyer totals. Decision open with the owner.                |
| Billing activation    | Organizer billing is built and gated off in production. Activation needs live Stripe Billing and Razorpay Subscriptions keys, plan tax treatment and an owner decision. |
| Payout transfers      | Stripe Connect and Razorpay Route transfers are built and gated off (`PAYOUT_EXECUTION_ENABLED`, `RAZORPAY_ROUTE_ENABLED`) until the post-transfer checks are proven.   |
| Fee publish           | No maker-checker: one admin with `PLATFORM_CONFIG` and a recent MFA step-up can publish a fee schedule.                                                                 |
| Campaigns             | Off in production. Needs the SES marketing sender and verified postal addresses. `PENDING_APPROVAL` exists but is unused.                                               |
| Messaging             | WhatsApp, mobile push and web push are adapters only. India SMS depends on DLT templates; US SMS on Twilio A2P registration.                                            |
| Webhook auth          | The MSG91 delivery callback has no provider signature; a secret path segment protects it.                                                                               |
| Web observability     | The three Next.js apps have no Sentry. API, worker and mobile do.                                                                                                       |
| Settlement statuses   | `PARTIALLY_REFUNDED` and `REVERSED` are in the transition table, but no writer was found; refunds change amounts and reversal attempts.                                 |

## 4. How to verify claims

Run these from the repository root:

```bash
npm ci
npx prisma validate --schema apps/api/prisma/schema.prisma   # schema is valid
grep -c '^model ' apps/api/prisma/schema.prisma              # 139
ls -d apps/api/prisma/migrations/2* | wc -l                 # 151
npm run verify                                               # format, lint, typecheck, tests
```

- Configuration: read the zod schema and the `assert*` functions in
  `apps/api/src/config/configuration.ts`. The billing gate is covered by
  `configuration.billing.spec.ts` and `apps/api/src/billing/billing-live-gate-safety.spec.ts`.
- Module graph: `apps/api/src/app-module-graph.integration-postgres.spec.ts` compiles the whole
  `AppModule` against PostgreSQL. A green unit suite alone does not prove the app boots.
- Queues and jobs: `grep -n "queue.add(\|new Worker(" apps/worker/src/main.ts`.
- Flows: each diagram in [FLOWS](FLOWS.md) lists the files it was traced from.
- Deployed commits: `node scripts/deploy/verify-deployed.mjs` compares each service with
  `origin/main` (needs a Railway token for that environment).
- Diagrams: every Mermaid block in this folder was checked with `@mermaid-js/mermaid-cli`.
