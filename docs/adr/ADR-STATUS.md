# ADR Status & Index

Architecture Decision Records for ETicketsGo. This index also tracks a **numbering gap**:
several ADR numbers are cited in code comments and docs but were never written up as
standalone files. They are listed here honestly so the references aren't dangling — the
decisions were made and implemented; only the formal ADR document is outstanding.

## Written (files present)
| ADR | Title |
| --- | --- |
| 009 | Experience platform |
| 010 | Inventory strategy |
| 011 | Movie domain |
| 012 | Venue platform |
| 013 | Seat reservation |
| 014 | Experience discovery |
| 015 | Organizer CRM |
| 016 | Community |
| 017 | Sponsor management |
| 018 | AI foundations |
| 019 | Pricing strategy |
| 020 | Notification strategy |
| 021 | Discovery strategy |
| 022 | Recommendation strategy |
| 023 | Analytics platform |
| 036 | Asymmetric QR signing |
| 037 | Inventory sourcing providers |
| 038 | Domain event bus and transaction-aware publication |
| 039 | Distributed inventory locking with Redis and PostgreSQL |
| 040 | External inventory synchronization platform |
| 041 | Transactional outbox and durable domain-event delivery |
| 042 | Provider-neutral booking orchestration (foundation) |

## Referenced in code/docs but not yet written up (024–035)
These numbers appear in source comments (e.g. `configuration.ts` cites ADR-024/028/035;
payments cite ADR-025–032). The corresponding decisions are **implemented and documented in
the guides** below — backfilling the formal ADR files is a tracked docs task, not a design gap.

| ADR | Decision (as implemented) | Where it's documented today |
| --- | --- | --- |
| 024 | Secret-manager abstraction (env/AWS/Azure/GCP) | [SECRET-MANAGER-INTEGRATION](../guides/SECRET-MANAGER-INTEGRATION.md) |
| 025–027 | Provider factory / binding / onboarding | [PAYMENT-PLATFORM](../guides/PAYMENT-PLATFORM.md), [MERCHANT-ONBOARDING](../guides/MERCHANT-ONBOARDING.md) |
| 028 | Live-payment master switch (`PAYMENT_LIVE_ENABLED`) | [PRODUCTION-ACTIVATION](../guides/PRODUCTION-ACTIVATION.md) |
| 029 | Finance reconciliation / discrepancies | [RECONCILIATION-OPERATIONS](../guides/RECONCILIATION-OPERATIONS.md) |
| 030–032 | Provider outage / failover / launch gate | [PROVIDER-OUTAGE-RUNBOOK](../guides/PROVIDER-OUTAGE-RUNBOOK.md), [PAYMENT-PLATFORM](../guides/PAYMENT-PLATFORM.md) |
| 033–034 | (reserved / minor) | — |
| 035 | Offline gate check-in | [OFFLINE-CHECKIN](../guides/OFFLINE-CHECKIN.md), [OFFLINE-PLATFORM](../guides/OFFLINE-PLATFORM.md) |

> When backfilling, create `ADR-0NN-title.md` and move the row up to "Written". Do not
> renumber — the numbers are already referenced throughout the code.
