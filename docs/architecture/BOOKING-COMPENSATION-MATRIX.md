# Booking Compensation Matrix (ADR-043)

Deterministic mapping from a booking discrepancy to planned compensation actions. The planner
is pure; it never executes. In P5.3A only SAFE non-financial actions are auto-executable
(behind disabled-by-default flags); money movement + confirmed-booking cancellation are planned
but routed to MANUAL_REVIEW.

Legend — **Auto**: eligible for safe auto-execution in P5.3A. **Review**: requires manual
review before any money/confirmed-cancel action.

| Case | Precondition                                       | Classification                                   | Planned actions                                                                  | Auto?  | Payment cap. dependency       | Provider cap. dependency     | Retry / review                                      | Customer status |
| ---- | -------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- | ------ | ----------------------------- | ---------------------------- | --------------------------------------------------- | --------------- |
| A    | Redis lock ok, local hold failed, pre-payment      | LOCK_OK_HOLD_FAILED                              | REDIS_LOCK_RELEASE                                                               | Auto   | —                             | —                            | bounded retry; else dead-letter                     | Pending/failed  |
| B    | Local hold ok, payment creation permanently failed | HOLD_OK_PAYMENT_CREATE_FAILED                    | LOCAL_HOLD_RELEASE (+ PROVIDER_RESERVATION_CANCEL if reserved)                   | Mixed¹ | —                             | supportsCancel (reservation) | retry safe part; reservation cancel Auto in phase 4 | Failed          |
| C    | Payment succeeded, provider rejected / sold out    | PAYMENT_SUCCEEDED_PROVIDER_REJECTED              | PAYMENT_VOID or PAYMENT_REFUND + LOCAL_HOLD_RELEASE + REDIS_LOCK_RELEASE         | Review | void vs refund by capability  | supportsCancel (reservation) | money → MANUAL_REVIEW (P5.3A)                       | Action pending  |
| D    | Provider confirmed, local confirmation failed      | LOCAL_CONFIRMATION_FAILED_AFTER_PROVIDER_CONFIRM | LOCAL_CONFIRMATION_RETRY; if exhausted → PROVIDER_BOOKING_CANCEL + MANUAL_REVIEW | Mixed² | refund only after policy      | supportsCancel (booking)     | retry Auto; exhausted → review                      | Processing      |
| E    | Local confirmed, Redis finalization failed         | REDIS_FINALIZE_FAILED                            | REDIS_LOCK_RELEASE                                                               | Auto   | — (no payment comp)           | —                            | bounded retry                                       | Confirmed       |
| F    | Provider confirmed, payment capture failed         | PROVIDER_CONFIRMED_CAPTURE_FAILED                | MANUAL_REVIEW                                                                    | Review | capture semantics not assumed | —                            | review                                              | Processing      |
| G    | Ticket issuance failed post-confirmation           | TICKET_ISSUANCE_FAILED                           | none — retry via existing outbox path                                            | n/a    | never refund for doc failure  | —                            | outbox durable retry                                | Confirmed       |
| H    | Duplicate callback / replay                        | DUPLICATE_CALLBACK                               | none — idempotent success                                                        | n/a    | —                             | —                            | none                                                | Unchanged       |

¹ B: the hold release is safe/auto; an unpaid provider reservation cancel becomes auto in
Phase 4 (unpaid, unconfirmed, idempotent only).
² D: the local-confirm retry is safe/auto; confirmed-booking cancel + any refund are review-only
in P5.3A.

## Manual-review conditions

- Any PAYMENT_VOID / PAYMENT_REFUND in P5.3A.
- Any PROVIDER_BOOKING_CANCEL (confirmed booking) in P5.3A.
- Capture-failed (F) — capture semantics are provider-specific and not assumed.
- Unknown payment capture state (planner cannot choose void vs refund).
- Local-confirmation retries exhausted with no certain provider-cancel outcome.

## Automatic eligibility (P5.3A)

Only `REDIS_LOCK_RELEASE`, `LOCAL_HOLD_RELEASE` (unambiguously unpaid), `PROVIDER_STATUS_RECOVERY`,
and `LOCAL_CONFIRMATION_RETRY` — and only when `BOOKING_COMPENSATION_EXECUTION_ENABLED`. In this
increment the wired safe executor is `REDIS_LOCK_RELEASE`; the others are surfaced for handling
until their booking-seam executors land.
