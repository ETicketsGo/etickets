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

## Payment void cases (ADR-043 P5.3B Phase 5)

| Payment state           | Booking state | Ticket | Provider capability           | Action                         | Auto? | Retry              | Manual review          | Refund handoff        | Customer status |
| ----------------------- | ------------- | ------ | ----------------------------- | ------------------------------ | ----- | ------------------ | ---------------------- | --------------------- | --------------- |
| AUTHORIZED not-captured | not confirmed | none   | supportsVoid + idempotentVoid | provider void → payment VOIDED | Auto¹ | bounded (idempot.) | unknown status         | —                     | Processing      |
| CAPTURED / SUCCEEDED    | not confirmed | none   | any                           | NO void → create refund plan   | never | —                  | superseded             | one PAYMENT_REFUND    | Action pending  |
| AUTHORIZED              | CONFIRMED     | —      | any                           | NO void → manual review        | never | —                  | always                 | —                     | Confirmed       |
| AUTHORIZED              | any           | issued | any                           | NO void → manual review        | never | —                  | always                 | —                     | Processing      |
| AUTHORIZED              | not confirmed | none   | immediate-capture (no void)   | NOT eligible → refund path     | never | —                  | —                      | PAYMENT_REFUND (plan) | Action pending  |
| ambiguous/timeout       | not confirmed | none   | supportsPaymentStatusQuery    | status query → re-decide       | Auto¹ | bounded            | unknown after attempts | if captured           | Processing      |
| already VOIDED          | not confirmed | none   | any                           | idempotent success             | Auto¹ | —                  | —                      | —                     | Processing      |

¹ Only when `BOOKING_COMPENSATION_AUTO_VOID_ENABLED` (off by default; production-forbidden; only
the mock provider is void-capable today). Amount + currency must match the authoritative payment.

## Automatic eligibility (P5.3A)

Only `REDIS_LOCK_RELEASE`, `LOCAL_HOLD_RELEASE` (unambiguously unpaid), `PROVIDER_STATUS_RECOVERY`,
and `LOCAL_CONFIRMATION_RETRY` — and only when `BOOKING_COMPENSATION_EXECUTION_ENABLED`. In this
increment the wired safe executor is `REDIS_LOCK_RELEASE`; the others are surfaced for handling
until their booking-seam executors land.

## Controlled FULL refund cases (ADR-043 P5.3B Phase 6)

Full refunds only — **no partial refunds** (no verified partial policy/data model). Automatic
execution requires `BOOKING_COMPENSATION_AUTO_REFUND_ENABLED` **and** an approved (non-`MANUAL_ONLY`)
`BOOKING_REFUND_POLICY_MODE` **and** a provider with `supportsFullRefund && supportsIdempotentRefund`
(only the mock today). Off by default; production-forbidden. Inventory is never auto-restored.

| Payment / context                           | Policy mode             | Provider capability        | Action                        | Auto?  | Recovery               | Customer status |
| ------------------------------------------- | ----------------------- | -------------------------- | ----------------------------- | ------ | ---------------------- | --------------- |
| SUCCEEDED (captured), customer cancellation | FULL_GROSS              | full + idempotent          | provider refund → REFUNDED    | Auto¹  | —                      | Refunded        |
| SUCCEEDED, event cancelled                  | EVENT_CANCELLATION_FULL | full + idempotent          | provider refund → REFUNDED    | Auto¹  | —                      | Refunded        |
| any captured                                | MANUAL_ONLY (default)   | any                        | NO refund → manual review     | never  | —                      | Action pending  |
| any                                         | TICKET_ONLY             | any                        | NO refund → manual review     | never  | —                      | Action pending  |
| not captured (AUTHORIZED/…)                 | any                     | any                        | NOT eligible (void territory) | never  | —                      | Processing      |
| already REFUNDED                            | any                     | any                        | idempotent success (no call)  | Auto¹  | —                      | Refunded        |
| checked-in ticket                           | any                     | any                        | NO refund → manual review     | never  | —                      | Confirmed       |
| settlement uncertain / completed            | any                     | any                        | NO refund → manual review     | never  | —                      | Action pending  |
| provider-cancellation required, unsupported | any                     | any                        | NO refund → manual review     | never  | —                      | Action pending  |
| captured, FULL approved                     | FULL_GROSS              | full only (not idempotent) | NO refund → manual review     | never  | —                      | Action pending  |
| async ack (COMPLETED but async provider)    | approved                | full + idempotent + async  | PENDING → status query        | Auto¹  | getRefund → REFUNDED   | Processing      |
| provider throws / timeout                   | approved                | + refundStatusQuery        | AMBIGUOUS → status query      | Auto¹  | getRefund; else review | Processing      |
| provider FAILED                             | approved                | any                        | rejected → manual review      | never² | —                      | Action pending  |

¹ Only under the flag+policy+capability gate above; amount `0 < amount <= captured`, currency
unchanged, and finalize is exactly-once (guarded `refundedMinor == captured`).
² The refund attempt was made; a FAILED provider result never retries automatically.

### Refund reconciliation classifications (read-only)

`CONSISTENT_NO_REFUND` / `CONSISTENT_FULL_REFUND` (NONE) · `REFUND_IN_FLIGHT` (NONE) ·
`INTENT_WITHOUT_OUTCOME` (RETRY_STATUS_QUERY) · `LOCAL_REFUNDED_PROVIDER_MISSING` ·
`PROVIDER_REFUNDED_LOCAL_MISSING` · `AMOUNT_MISMATCH` · `CURRENCY_MISMATCH` ·
`PROVIDER_REFUND_FAILED` · `SETTLEMENT_UNKNOWN` · `DUPLICATE_COMPLETED_REFUND` · `OVER_REFUND` ·
`NEGATIVE_REFUND` (all MANUAL_REVIEW). The classifier moves no money.
