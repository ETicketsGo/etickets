# Booking Orchestration — State Transition Matrix (ADR-042)

The authoritative list of legal workflow transitions (mirrors
`booking-workflow.transitions.ts`). The orchestrator is the only writer; every advance is
validated against this table, uses optimistic concurrency (`version`), is idempotent
(re-asserting the current state is a no-op), and is audited. Terminal states have no
outgoing transitions. Customer-visible `BookingStatus` is mapped at milestones and is
unchanged.

| From                                                  | Allowed →                                                                                    | Milestone / side effect (planned)                                    | Durable event                                     | Compensation on failure                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| DRAFT                                                 | INVENTORY_RESOLVED, FAILED, EXPIRED                                                          | resolve provider + ownership mode                                    | BookingInitiated / InventoryResolved              | none (nothing acquired)                           |
| INVENTORY_RESOLVED                                    | LOCK_PENDING, FAILED, EXPIRED                                                                | begin lock acquisition                                               | —                                                 | none                                              |
| LOCK_PENDING                                          | LOCKED, FAILED, EXPIRED, COMPENSATION_PENDING                                                | acquire Redis lock (active)                                          | LockAcquired                                      | release lock                                      |
| LOCKED                                                | PAYMENT_PENDING, EXPIRING, CANCELLATION_PENDING, COMPENSATION_PENDING, FAILED                | PostgreSQL hold + persist lockId/fencingToken; create payment intent | PaymentPending                                    | release lock; release hold                        |
| PAYMENT_PENDING                                       | PAYMENT_AUTHORIZED, CONFIRMING, EXPIRING, CANCELLATION_PENDING, COMPENSATION_PENDING, FAILED | await payment webhook (auth or immediate capture)                    | PaymentAuthorized                                 | keep/release hold per retry policy                |
| PAYMENT_AUTHORIZED                                    | PROVIDER_CONFIRM_PENDING, CONFIRMING, CANCELLATION_PENDING, COMPENSATION_PENDING, FAILED     | branch on ownership mode                                             | ProviderConfirmationRequested                     | refund/void                                       |
| PROVIDER_CONFIRM_PENDING                              | PROVIDER_CONFIRMED, COMPENSATION_PENDING, MANUAL_REVIEW, FAILED                              | confirm with external provider                                       | ProviderConfirmed                                 | retry, else refund/void → manual review           |
| PROVIDER_CONFIRMED                                    | CONFIRMING, COMPENSATION_PENDING, FAILED                                                     | begin authoritative DB confirm                                       | —                                                 | cancel provider booking if DB confirm impossible  |
| CONFIRMING                                            | CONFIRMED, COMPENSATION_PENDING, MANUAL_REVIEW, FAILED                                       | InventoryStrategy confirm + record outbox in-tx + commit             | BookingConfirmed                                  | retry DB; else compensate provider/payment        |
| CONFIRMED                                             | TICKET_PENDING, CANCELLATION_PENDING, REFUND_PENDING                                         | booking booked; release/confirm Redis lock                           | —                                                 | reconciliation cleans Redis (booking stands)      |
| TICKET_PENDING                                        | TICKET_ISSUED, MANUAL_REVIEW                                                                 | issue QR tickets (durable retry via outbox)                          | TicketGenerationRequested                         | retry issuance; never auto-refund for doc failure |
| TICKET_ISSUED                                         | CANCELLATION_PENDING, REFUND_PENDING                                                         | stable success (post-sale flows may re-enter)                        | —                                                 | —                                                 |
| CANCELLATION_PENDING                                  | CANCELLED, REFUND_PENDING, COMPENSATION_PENDING, MANUAL_REVIEW                               | evaluate refund policy + provider cancel capability                  | BookingCancellationRequested                      | —                                                 |
| REFUND_PENDING                                        | REFUNDED, COMPENSATION_PENDING, MANUAL_REVIEW                                                | initiate refund (async provider confirmation)                        | RefundRequested / RefundProcessed                 | —                                                 |
| EXPIRING                                              | EXPIRED, COMPENSATION_PENDING, MANUAL_REVIEW                                                 | release hold + lock                                                  | BookingExpirationRequested / BookingExpired       | release lock                                      |
| COMPENSATION_PENDING                                  | COMPENSATED, MANUAL_REVIEW, FAILED                                                           | run idempotent compensation actions                                  | BookingCompensationRequested / BookingCompensated | bounded → manual review                           |
| MANUAL_REVIEW                                         | COMPENSATION_PENDING, CANCELLATION_PENDING, REFUND_PENDING, CONFIRMING, CANCELLED, FAILED    | operator-driven (RBAC + audit)                                       | BookingManualReviewRequired                       | —                                                 |
| CANCELLED / REFUNDED / EXPIRED / COMPENSATED / FAILED | — (terminal)                                                                                 | —                                                                    | —                                                 | —                                                 |

## Key ordering rules

- A **paid** booking never transitions straight to `CANCELLED`; it routes through
  `REFUND_PENDING → REFUNDED`.
- `TICKET_ISSUED` is a stable success state, not terminal — post-sale cancel/refund
  re-enter the workflow.
- Compensation is reachable from every money/inventory/provider-dirty state
  (`LOCKED..CONFIRMING`).
- Terminal states never transition; `MANUAL_REVIEW` is the only operator-driven escape and
  every exit is audited.
- Duplicate callbacks/requests are idempotent: the same idempotency key returns the same
  workflow; re-asserting the current state is a no-op; optimistic concurrency rejects a
  conflicting concurrent advance.
